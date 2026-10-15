// Integration gateway — centralized push / PR / checks / merge / cleanup.
//
// Every method shells to git or gh via child_process with an enforced timeout
// and a bounded retry policy. Every call resolves to a uniform envelope:
//
//   { ok, phase, action, params, result, durationMs, timestamp }
//
// The envelope is both returned AND emitted on the gateway's event bus so the
// renderer / CLI / remote clients can observe progress without polling.
//
// The factory only requires { cwd, logger }. `execFile` is injectable so the
// unit tests can mock child_process without touching the real git/gh.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { evaluateMergeGate, parseGhJson, rollupCheckState } = require('../tools/ace/src/pr-gate.cjs');
const { computeHighRisk, holdGateOnUnknownChanges } = require('../tools/ace/src/pr-intel.cjs');
const { evaluatePrScope, normalizePathList } = require('../tools/ace/src/pr-scope-policy.cjs');
// Review-bot check extraction (build-agnostic: the compiled .cjs is gitignored
// and may be absent in a fresh worktree — tsx resolves the .cts source).
let reviewBotModule: any;
try { reviewBotModule = require('../tools/ace/src/review-bot.cjs'); }
catch { reviewBotModule = require('../tools/ace/src/review-bot.cts'); }
const { extractReviewBotCheck, parseReviewBotFindings, isFailingCheckState } = reviewBotModule;

// Per-action retry / timeout budgets. The spec pins these; we don't read them
// from options so the surface cannot drift call-to-call.
const RETRY = Object.freeze({
  push: 3,
  merge: 3,
  archive: 3,
  branchDelete: 3,
  cleanup: 3,
  // Default check polling is fast: immediate read, 5s for the first minute,
  // then 15s up to 5 minutes. Longer waits must be explicit.
  pollIntervalMs: 5_000,
  pollMaxAttempts: 28,
  autoMergeVerifyIntervalMs: 5_000,
  autoMergeVerifyMaxAttempts: 60,
});

const DEFAULT_TIMEOUT_MS = 60_000;
const MERGE_LOCKS = new Map();

function nowMs() {
  return Date.now();
}

function cleanText(value: any) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function taskContextMatchesPr({ branch, worktreePath, expectedBaseBranch, prHeadBranch, prBaseBranch }: any = {}) {
  const taskBranch = cleanText(branch);
  const taskWorktree = cleanText(worktreePath);
  const taskBase = cleanText(expectedBaseBranch);
  const head = cleanText(prHeadBranch);
  const base = cleanText(prBaseBranch);
  return Boolean(taskBranch && taskWorktree && taskBase && head === taskBranch && base === taskBase);
}

// Build the evaluateMergeGate input from a caller-supplied `gate` object plus
// live PR intel. Exported and PURE so the loop harness can exercise the REAL
// field-shape handoff between a previously computed gate result and the
// authoritative pre-merge evaluation — the seam where a nested
// `expectedPr.headSha` used to be silently dropped (gate result re-used as
// gate input lost its exact-head pin and automerge fail-closed forever).
function buildGatewayGateInput({
  gate,
  feature,
  prNumber,
  tracked,
  pr = {},
  expectedBaseBranch,
  branch,
  worktreePath,
  releaseTrain,
  prViewError,
}: any = {}) {
  return {
    ...(gate && typeof gate === 'object' ? gate : {}),
    tracked,
    prNumber,
    baseBranch: pr.baseBranch ?? null,
    headRefName: pr.headBranch ?? null,
    baseRefName: pr.baseBranch ?? null,
    headSha: pr.headSha ?? null,
    baseSha: pr.baseSha ?? null,
    isDraft: pr.isDraft === true,
    changedFiles: pr.changedFiles ?? [],
    allowedPaths: gate?.allowedPaths ?? gate?.scope?.allow ?? gate?.scope?.paths ?? feature?.allowPaths,
    expectedPrHeadRef: gate?.expectedPrHeadRef ?? gate?.expectedHeadRef ?? gate?.expectedPr?.headRef ?? feature?.prHeadRef,
    expectedPrBaseRef: gate?.expectedPrBaseRef ?? gate?.expectedBaseRef ?? gate?.expectedPr?.baseRef ?? feature?.prBaseRef,
    expectedPrHeadSha: gate?.expectedPrHeadSha ?? gate?.expectedHeadSha ?? gate?.expectedPr?.headSha ?? feature?.prHeadSha,
    expectedPrBaseSha: gate?.expectedPrBaseSha ?? gate?.expectedPr?.baseSha ?? feature?.prBaseSha,
    prState: pr.prState ?? null,
    checkState: pr.checkState ?? null,
    mergeable: pr.mergeable ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    expectedBaseBranch,
    validationRequired: gate?.validationRequired === true,
    branch,
    worktreePath,
    projectDir: worktreePath || null,
    clawpatchEnforced: gate?.clawpatchEnforced === true,
    branchExistsRemote: gate?.branchExistsRemote ?? gate?.cleanup?.branchExistsRemote,
    // Automerge hardening port (from the deleted inline chain): classify
    // change risk from the LIVE changed-file list, and read computer-use
    // evidence from the linked feature's VERIFIED computer_use_evidence_json
    // (persisted by missionGateFeature's artifact read) — never from a
    // caller-supplied boolean alone.
    ...(gate?.automerge === true
      ? {
          highRisk: gate?.highRisk === true || computeHighRisk(pr.changedFiles),
          computerUseEvidence:
            gate?.computerUseEvidence === true ||
            !!(feature && (feature.computerUseEvidence || feature.computer_use_evidence_json)),
        }
      : {}),
    ...(releaseTrain ? { releaseTrain } : {}),
    prViewError,
  };
}

function splitLines(value: any) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function makeEnvelope({ ok, phase, action, params, result, durationMs, timestamp }: any) {
  return {
    ok: Boolean(ok),
    phase,
    action,
    params: params ?? null,
    result: result ?? null,
    durationMs: Math.max(0, durationMs | 0),
    timestamp: timestamp || nowMs(),
  };
}

function mergeModeFromOptions({ auto, admin }: any = {}) {
  if (admin === true) return 'admin';
  if (auto === true) return 'auto';
  return 'normal';
}

function branchPolicyRequiresAutoOrAdmin(textValue: any) {
  const body = String(textValue || '');
  return /--auto|--admin|auto-merge|required status checks|branch protection|protected branch|merge queue|cannot be merged/i.test(body);
}

function githubAuthOrPermissionFailure(textValue: any) {
  const body = String(textValue || '');
  return /unauthori[sz]ed|authentication required|bad credentials|forbidden|insufficient permission|not authorized|resource not accessible|HTTP\s+(?:401|403)|gh auth login/i.test(body);
}

function branchPolicyError({ taskId, prNumber, rawError, method, deleteBranch }: any) {
  const methodFlag = method && method !== 'squash' ? ` --method ${method}` : '';
  const keep = deleteBranch === false ? ' --keep-branch' : '';
  return {
    error: 'branch_policy_requires_auto_or_admin',
    recommendedModes: ['auto', 'admin'],
    safeNextCommand: `ace integrate pr-merge --task ${taskId || '<taskId>'} --pr ${prNumber}${methodFlag}${keep} --auto`,
    rawError: String(rawError || '').slice(0, 4000),
  };
}

function githubAuthError({ rawError }: any) {
  return {
    error: 'github_auth_or_permission_failure',
    safeNextCommand: 'gh auth status && gh auth refresh -s repo -s workflow',
    rawError: String(rawError || '').slice(0, 4000),
  };
}

function defaultAutoAdminReason(prNumber: any) {
  return `Ace auto-merge PR #${prNumber}: gate passed, checks green, PR mergeable; direct merge blocked by branch policy.`;
}

function wait(ms: any) {
  return new Promise((resolve: any) => setTimeout(resolve, ms));
}

async function withRepoMergeLock(repoKey: any, fn: any) {
  const key = path.resolve(String(repoKey || '.'));
  const previous = MERGE_LOCKS.get(key) || Promise.resolve();
  let release: any;
  const current = new Promise((resolve: any) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  MERGE_LOCKS.set(key, chained);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (MERGE_LOCKS.get(key) === chained) MERGE_LOCKS.delete(key);
  }
}

// Run one git/gh command with a timeout, capturing stdout / stderr / code.
// Never throws — rejects only on runner-level failures (failed to spawn).
function runOnce({ execFileImpl, bin, args, cwd, timeoutMs, env }: any): Promise<any> {
  return new Promise((resolve: any) => {
    const options: any = { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };
    if (env) options.env = env;
    execFileImpl(
      bin,
      args,
      options,
      (err: any, stdout: any, stderr: any) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        const killed = Boolean(err && err.killed);
        resolve({
          ok: !err,
          code,
          killed,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      }
    );
  });
}

// Retry wrapper with exponential-ish backoff. `attempts` includes the first try.
async function runWithRetry({ execFileImpl, bin, args, cwd, timeoutMs, attempts, logger, env, redactDiagnostics = false }: any) {
  let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    last = await runOnce({ execFileImpl, bin, args, cwd, timeoutMs, env });
    if (last.ok) {
      return {
        ...last,
        attempts: i,
        ...(redactDiagnostics ? { stdout: '', stderr: '', diagnosticsRedacted: true } : {}),
      };
    }
    if (logger && typeof logger.warn === 'function') {
      logger.warn(redactDiagnostics
        ? `[integration-gateway] imported push failed (attempt ${i}/${attempts}, code=${last.code})`
        : `[integration-gateway] ${bin} ${args.join(' ')} failed (attempt ${i}/${attempts}, code=${last.code}): ${last.stderr.trim() || last.stdout.trim()}`);
    }
    if (i < attempts) {
      await new Promise((r: any) => setTimeout(r, 200 * i));
    }
  }
  return {
    ...last,
    attempts,
    ...(redactDiagnostics ? { stdout: '', stderr: '', diagnosticsRedacted: true } : {}),
  };
}

function createIntegrationGateway({
  cwd,
  repoCwd,
  logger,
  execFileImpl,
  now,
  archiveTaskImpl,
  newPushNonce,
}: any = {}) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('createIntegrationGateway: cwd is required');
  }
  const cleanupCwd = typeof repoCwd === 'string' && repoCwd ? repoCwd : cwd;
  const log = logger || console;
  const runner = execFileImpl || execFile;
  const clock = typeof now === 'function' ? now : nowMs;
  const makePushNonce = typeof newPushNonce === 'function' ? newPushNonce : () => crypto.randomUUID();
  const bus = new EventEmitter();

  function emit(envelope: any) {
    try {
      bus.emit('integration', envelope);
      bus.emit(envelope.action, envelope);
    } catch (err) {
      if (log && typeof log.warn === 'function') {
        log.warn('[integration-gateway] bus emit failed:', err);
      }
    }
    return envelope;
  }

  function emitSkip({ action, params, reason }: any) {
    return emit(
      makeEnvelope({
        ok: true,
        phase: 'success',
        action,
        params,
        result: { skipped: true, reason },
        durationMs: 0,
        timestamp: clock(),
      })
    );
  }

  async function execAction({ action, params, bin, args, attempts, timeoutMs, env, redactDiagnostics = false }: any) {
    const startedAt = clock();
    const t0 = Date.now();
    const res = await runWithRetry({
      execFileImpl: runner,
      bin,
      args,
      cwd,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      attempts: attempts || 1,
      logger: log,
      env,
      redactDiagnostics,
    });
    const durationMs = Date.now() - t0;
    return emit(
      makeEnvelope({
        ok: res.ok,
        phase: res.ok ? 'success' : 'failure',
        action,
        params,
        result: {
          code: res.code,
          attempts: res.attempts,
          stdout: res.stdout,
          stderr: res.stderr,
          killed: res.killed,
          ...(redactDiagnostics ? { diagnosticsRedacted: true } : {}),
        },
        durationMs,
        timestamp: startedAt,
      })
    );
  }

  async function runHookAction({ action, params, attempts, run }: any) {
    const startedAt = clock();
    const t0 = Date.now();
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        const result = await run();
        return emit(
          makeEnvelope({
            ok: true,
            phase: 'success',
            action,
            params,
            result: {
              attempts: i,
              ...(result && typeof result === 'object' ? result : {}),
            },
            durationMs: Date.now() - t0,
            timestamp: startedAt,
          })
        );
      } catch (err) {
        lastErr = err;
        if (log && typeof log.warn === 'function') {
          log.warn(
            `[integration-gateway] ${action} failed (attempt ${i}/${attempts}): ${err && err.message ? err.message : err}`
          );
        }
        if (i < attempts) {
          await wait(200 * i);
        }
      }
    }
    return emit(
      makeEnvelope({
        ok: false,
        phase: 'failure',
        action,
        params,
        result: {
          attempts,
          error: lastErr && lastErr.message ? lastErr.message : String(lastErr || 'unknown error'),
        },
        durationMs: Date.now() - t0,
        timestamp: startedAt,
      })
    );
  }

  async function runIdempotentCommand({
    action,
    bin,
    args,
    commandCwd,
    attempts,
    timeoutMs,
    isMissing,
  }: any) {
    let last: any = null;
    for (let i = 1; i <= attempts; i++) {
      last = await runOnce({
        execFileImpl: runner,
        bin,
        args,
        cwd: commandCwd || cwd,
        timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      const missing = typeof isMissing === 'function' ? Boolean(isMissing(last)) : false;
      if (last.ok || missing) {
        return { ...last, attempts: i, missing };
      }
      if (log && typeof log.warn === 'function') {
        log.warn(
          `[integration-gateway] ${action} failed (attempt ${i}/${attempts}, code=${last.code}): ${last.stderr.trim() || last.stdout.trim()}`
        );
      }
      if (i < attempts) {
        await wait(200 * i);
      }
    }
    const missing = typeof isMissing === 'function' ? Boolean(isMissing(last)) : false;
    return { ...last, attempts, missing };
  }

  async function inspectWorktreeSafety(worktreePath: any) {
    const clean = cleanText(worktreePath);
    if (!clean) return { skipped: true, reason: 'worktreePath not provided' };
    if (!fs.existsSync(clean)) return { exists: false, clean: true, missing: true, status: '' };
    const res = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['-C', clean, 'status', '--porcelain'],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const status = res.stdout || '';
    return {
      exists: true,
      clean: res.ok && status.trim() === '',
      status,
      code: res.code,
      stderr: res.stderr,
      error: res.ok ? null : cleanText(res.stderr || res.stdout || 'git status failed'),
    };
  }

  async function inspectBranchMerged({ branch, baseBranch, remote = 'origin', prState }: any = {}) {
    const cleanBranch = cleanText(branch);
    if (!cleanBranch) return { skipped: true, reason: 'branch not provided' };
    const cleanBase = cleanText(baseBranch);
    if (!cleanBase) return { merged: false, blocked: true, reason: 'baseBranch not provided' };
    const cleanRemote = cleanText(remote) || 'origin';
    const baseRefs = cleanBase.includes('/') ? [cleanBase] : [`${cleanRemote}/${cleanBase}`, cleanBase];
    const attempts = [];
    for (const ref of baseRefs) {
      const res = await runOnce({
        execFileImpl: runner,
        bin: 'git',
        args: ['branch', '--merged', ref],
        cwd: cleanupCwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      attempts.push({ ref, code: res.code, stderr: res.stderr });
      if (!res.ok) continue;
      const mergedBranches = splitLines(res.stdout).map((line) => line.replace(/^\*\s*/, '').trim());
      if (mergedBranches.includes(cleanBranch)) {
        return {
          merged: true,
          blocked: false,
          baseBranch: cleanBase,
          evidenceRef: ref,
          attempts,
        };
      }
    }
    return {
      merged: false,
      blocked: true,
      baseBranch: cleanBase,
      evidenceRef: null,
      attempts,
      reason: 'branch is not merged into remote-tracking or local base',
    };
  }

  async function inspectMergeCommit({ mergedSha, baseBranch, remote = 'origin' }: any = {}) {
    const cleanSha = cleanText(mergedSha);
    const cleanBase = cleanText(baseBranch);
    if (!cleanSha) return { skipped: true, reason: 'mergedSha not provided' };
    if (!cleanBase) return { merged: false, blocked: true, reason: 'baseBranch not provided' };
    const cleanRemote = cleanText(remote) || 'origin';
    const baseRefs = cleanBase.includes('/') ? [cleanBase] : [`${cleanRemote}/${cleanBase}`, cleanBase];
    const attempts = [];
    for (const ref of baseRefs) {
      const res = await runOnce({
        execFileImpl: runner,
        bin: 'git',
        args: ['merge-base', '--is-ancestor', cleanSha, ref],
        cwd: cleanupCwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      attempts.push({ ref, code: res.code, stderr: res.stderr });
      if (res.ok) {
        return { merged: true, blocked: false, mergedSha: cleanSha, evidenceRef: ref, attempts };
      }
    }
    return {
      merged: false,
      blocked: true,
      mergedSha: cleanSha,
      attempts,
      reason: 'merge commit is not contained in remote-tracking or local base',
    };
  }

  async function verifyMergedPr({ prNumber, remote = 'origin', baseBranch, previousBaseSha, expectedHeadSha }: any = {}) {
    const fields = 'number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName,baseRefOid';
    const prView = await runOnce({
      execFileImpl: runner,
      bin: 'gh',
      args: ['pr', 'view', String(prNumber), '--json', fields],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    let parsed: any = {};
    let prViewError = null;
    if (prView.ok) {
      try {
        parsed = parseGhJson(prView.stdout, {});
      } catch (err) {
        prViewError = err?.message || String(err);
      }
    } else {
      prViewError = prView.stderr || prView.stdout || 'gh pr view failed';
    }
    const cleanRemote = cleanText(remote) || 'origin';
    const cleanBase = cleanText(baseBranch || parsed.baseRefName);
    const mergeCommitSha = cleanText(parsed.mergeCommit?.oid || parsed.mergeCommit?.sha || parsed.mergeCommit);
    const githubMerged = String(parsed.state || '').toUpperCase() === 'MERGED' && !!parsed.mergedAt;
    const fetch = cleanBase
      ? await runOnce({
          execFileImpl: runner,
          bin: 'git',
          args: ['fetch', cleanRemote, cleanBase, '--quiet'],
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
      : { ok: false, stderr: 'base branch missing' };
    const baseRef = cleanBase ? `${cleanRemote}/${cleanBase}` : null;
    const baseAfter = baseRef
      ? await runOnce({
          execFileImpl: runner,
          bin: 'git',
          args: ['rev-parse', '--verify', baseRef],
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
      : { ok: false, stdout: '', stderr: 'base ref missing' };
    const baseShaAfter = baseAfter.ok ? cleanText(baseAfter.stdout) : null;
    const containsMergeCommit = mergeCommitSha && baseRef
      ? await runOnce({
          execFileImpl: runner,
          bin: 'git',
          args: ['merge-base', '--is-ancestor', mergeCommitSha, baseRef],
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
      : null;
    const baseAdvanced = !!(previousBaseSha && baseShaAfter && previousBaseSha !== baseShaAfter);
    const mergeEvidenceVerified = containsMergeCommit ? containsMergeCommit.ok : baseAdvanced;
    return {
      ok: githubMerged && mergeEvidenceVerified,
      githubMerged,
      pr: {
        number: parsed.number != null ? Number(parsed.number) : Number(prNumber),
        url: parsed.url || null,
        state: parsed.state || null,
        mergedAt: parsed.mergedAt || null,
        mergeCommitSha,
        headSha: parsed.headRefOid || expectedHeadSha || null,
        baseBranch: cleanBase,
        baseShaBefore: previousBaseSha || null,
        baseShaAfter,
      },
      mergeEvidenceVerified,
      baseAdvanced,
      fetch: { ok: fetch.ok, code: fetch.code, stderr: fetch.stderr },
      containsMergeCommit: containsMergeCommit ? { ok: containsMergeCommit.ok, code: containsMergeCommit.code, stderr: containsMergeCommit.stderr } : null,
      prViewError,
    };
  }

  async function waitForVerifiedMerge(args: any = {}) {
    let last: any = null;
    const attempts: any[] = [];
    for (let i = 1; i <= RETRY.autoMergeVerifyMaxAttempts; i += 1) {
      last = await verifyMergedPr(args);
      attempts.push({
        ok: last.ok,
        githubMerged: last.githubMerged,
        state: last.pr?.state || null,
        mergedAt: last.pr?.mergedAt || null,
        mergeCommitSha: last.pr?.mergeCommitSha || null,
        baseShaAfter: last.pr?.baseShaAfter || null,
      });
      if (last.ok) return { ...last, attempts: i, waitAttempts: attempts };
      if (String(last.pr?.state || '').toUpperCase() === 'CLOSED' && !last.githubMerged) {
        return { ...last, attempts: i, waitAttempts: attempts };
      }
      if (i < RETRY.autoMergeVerifyMaxAttempts) await wait(RETRY.autoMergeVerifyIntervalMs);
    }
    return { ...(last || {}), attempts: RETRY.autoMergeVerifyMaxAttempts, waitAttempts: attempts };
  }

  async function push({ branch, remote = 'origin', force = false, importedPushUrl }: any = {}) {
    if (!branch || typeof branch !== 'string') {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'push',
          params: { branch, remote, force },
          result: { error: 'branch is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    let args: string[];
    let env: any;
    let params: any = { branch, remote, force };
    if (importedPushUrl !== undefined) {
      if (typeof importedPushUrl !== 'string'
        || importedPushUrl.length === 0
        || /[\u0000-\u001f\u007f]/.test(importedPushUrl)) {
        return emit(
          makeEnvelope({
            ok: false,
            phase: 'failure',
            action: 'push',
            params: { branch, remote, force, importedContext: true },
            result: { error: 'immutable imported push URL evidence is invalid' },
            durationMs: 0,
            timestamp: clock(),
          })
        );
      }
      const nonce = String(makePushNonce());
      if (!/^[A-Za-z0-9-]{8,128}$/.test(nonce)) {
        return emit(
          makeEnvelope({
            ok: false,
            phase: 'failure',
            action: 'push',
            params: { branch, remote, force, importedContext: true },
            result: { error: 'imported push URL binding nonce is invalid' },
            durationMs: 0,
            timestamp: clock(),
          })
        );
      }
      const syntheticUrl = `https://ace.invalid/context-import/${nonce}`;
      args = [
        '-c', `url.${importedPushUrl}.pushInsteadOf=${syntheticUrl}`,
        'push', syntheticUrl, branch,
      ];
      env = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_') && typeof value === 'string') env[key] = value;
      }
      params = { branch, remote, force, importedContext: true };
    } else {
      args = ['push', '--set-upstream', remote, branch];
    }
    if (force) args.push('--force-with-lease');
    return execAction({
      action: 'push',
      params,
      bin: 'git',
      args,
      attempts: RETRY.push,
      env,
      redactDiagnostics: importedPushUrl !== undefined,
    });
  }

  async function inspectPrOpenScope({ base, head, remote = 'origin', allowedPaths, expectedBaseSha }: any = {}) {
    const cleanBase = cleanText(base) || 'main';
    const cleanRemote = cleanText(remote) || 'origin';
    const remoteBaseRef = cleanBase.includes('/') ? cleanBase : `${cleanRemote}/${cleanBase}`;
    await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['fetch', cleanRemote, '--quiet'],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const baseRes = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['rev-parse', '--verify', remoteBaseRef],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (!baseRes.ok) {
      return {
        ok: false,
        error: 'remote_base_unresolved',
        baseBranch: cleanBase,
        remoteBaseRef,
        safeNext: 'fetch the requested base branch or choose an existing remote base',
      };
    }
    const remoteBaseSha = cleanText(baseRes.stdout);
    const headRes = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['rev-parse', '--verify', head],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (!headRes.ok) {
      return {
        ok: false,
        error: 'head_unresolved',
        baseBranch: cleanBase,
        remoteBaseRef,
        remoteBaseSha,
        safeNext: 'push or checkout the task branch before opening a PR',
      };
    }
    const headSha = cleanText(headRes.stdout);
    let baseRefresh: any = null;
    if (expectedBaseSha && remoteBaseSha && expectedBaseSha !== remoteBaseSha) {
      const ancestorRes = await runOnce({
        execFileImpl: runner,
        bin: 'git',
        args: ['merge-base', '--is-ancestor', remoteBaseSha, headSha || head],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!ancestorRes.ok) {
        return {
          ok: false,
          error: 'base_sha_mismatch',
          baseBranch: cleanBase,
          remoteBaseRef,
          remoteBaseSha,
          expectedBaseSha,
          headSha,
          safeNext: 'rebase/recreate the task branch from the live remote base or relink base evidence after repair',
        };
      }
      baseRefresh = {
        refreshed: true,
        previousBaseSha: expectedBaseSha,
        remoteBaseSha,
        baseSha: remoteBaseSha,
        headSha,
        baseBranch: cleanBase,
        remoteBaseRef,
        proof: 'git merge-base --is-ancestor',
      };
    }
    const diffRes = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['diff', '--name-only', `${remoteBaseRef}..${head}`],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const changedFiles = diffRes.ok ? splitLines(diffRes.stdout) : [];
    const scope = evaluatePrScope({ allowedPaths, changedFiles });
    if (!scope.ok) {
      return {
        ok: false,
        error: scope.code,
        baseBranch: cleanBase,
        remoteBaseRef,
        remoteBaseSha,
        allowedPaths: scope.allowedPaths,
        changedFiles: scope.changedFiles,
        unexpectedFiles: scope.unexpectedFiles,
        safeNext: scope.code === 'scope_missing'
          ? 'declare allowed paths before opening a PR'
          : 'create a clean branch from origin/main or split unrelated changes',
      };
    }
    return {
      ok: true,
      baseBranch: cleanBase,
      remoteBaseRef,
      remoteBaseSha,
      expectedBaseSha: expectedBaseSha || null,
      headSha,
      baseRefresh,
      allowedPaths: scope.allowedPaths,
      changedFiles,
      unexpectedFiles: [],
    };
  }

  async function openPr({ base, head, title, body = '', draft = true, remote = 'origin', allowedPaths, expectedBaseSha }: any = {}) {
    if (!base || !head || !title) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'openPr',
          params: { base, head, title, draft, allowedPaths: normalizePathList(allowedPaths) },
          result: { error: 'base, head, and title are required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    const scopePreflight = await inspectPrOpenScope({ base, head, remote, allowedPaths, expectedBaseSha });
    if (!scopePreflight.ok) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'blocked',
          action: 'openPr',
          params: { base, head, title, draft, remote, allowedPaths: normalizePathList(allowedPaths), expectedBaseSha: expectedBaseSha || null },
          result: scopePreflight,
          durationMs: Date.now() - t0,
          timestamp: startedAt,
        })
      );
    }
    const args = [
      'pr',
      'create',
      '--base',
      base,
      '--head',
      head,
      '--title',
      title,
      '--body',
      body,
    ];
    if (draft) args.push('--draft');
    const env = await execAction({
      action: 'openPr',
      params: { base, head, title, draft, remote, allowedPaths: normalizePathList(allowedPaths), expectedBaseSha: expectedBaseSha || null },
      bin: 'gh',
      args,
      attempts: 1,
    });
    if (env && env.result && typeof env.result === 'object') {
      env.result.preflight = {
        baseBranch: scopePreflight.baseBranch,
        remoteBaseRef: scopePreflight.remoteBaseRef,
        remoteBaseSha: scopePreflight.remoteBaseSha,
        expectedBaseSha: scopePreflight.expectedBaseSha || null,
        headSha: scopePreflight.headSha,
        allowedPaths: scopePreflight.allowedPaths,
        changedFiles: scopePreflight.changedFiles,
        unexpectedFiles: scopePreflight.unexpectedFiles,
        baseRefresh: scopePreflight.baseRefresh || null,
      };
    }
    return env;
  }

  // Mark a draft PR ready for review. The org review-bot ('PR Validator')
  // skips drafts and triggers on ready_for_review, so this IS the ready-head
  // ReviewBot request for the current head. Idempotent from the caller's side:
  // only invoked when the gate facts report isDraft.
  async function readyPr({ prNumber }: any = {}) {
    if (prNumber == null) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'readyPr',
          params: { prNumber: null },
          result: { error: 'prNumber is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    return execAction({
      action: 'readyPr',
      params: { prNumber },
      bin: 'gh',
      args: ['pr', 'ready', String(prNumber)],
      attempts: 1,
    });
  }

  // Post the /codex review request comment on the PR. The caller (spine gate
  // effect) records a review.requested ledger event keyed by the exact head, so
  // the comment is posted once per head, re-armed by every push.
  async function requestReview({ prNumber, body = '/codex review' }: any = {}) {
    if (prNumber == null) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'requestReview',
          params: { prNumber: null },
          result: { error: 'prNumber is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    return execAction({
      action: 'requestReview',
      params: { prNumber, body },
      bin: 'gh',
      args: ['pr', 'comment', String(prNumber), '--body', String(body)],
      attempts: 1,
    });
  }

  async function pollChecks({ prNumber, branch, waitChecks = true, timeoutMs }: any = {}) {
    const ref = prNumber != null ? String(prNumber) : branch;
    if (!ref) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'pollChecks',
          params: { prNumber, branch },
          result: { error: 'prNumber or branch is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    let attempts = 0;
    let last: any = null;
    const maxMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : 5 * 60_000;
    while (attempts < RETRY.pollMaxAttempts) {
      attempts += 1;
      last = await runOnce({
        execFileImpl: runner,
        bin: 'gh',
        args: ['pr', 'checks', ref],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const text = (last.stdout || '') + (last.stderr || '');
      // gh pr checks exits 0 when all succeed, 8 when some are still pending,
      // non-zero otherwise. Treat "pending" / "in_progress" as keep-polling.
      const pending = /\bpending\b|\bin_progress\b|\bqueued\b/i.test(text);
      if (last.ok && !pending) break;
      if (!last.ok && !pending) break;
      if (waitChecks === false) break;
      if (attempts >= RETRY.pollMaxAttempts) break;
      const elapsed = Date.now() - t0;
      if (elapsed >= maxMs) break;
      const interval = elapsed < 60_000 ? 5_000 : 15_000;
      await new Promise((r: any) => setTimeout(r, Math.min(interval, Math.max(0, maxMs - elapsed))));
    }
    const durationMs = Date.now() - t0;
    const text = ((last && last.stdout) || '') + ((last && last.stderr) || '');
    const pending = /\bpending\b|\bin_progress\b|\bqueued\b/i.test(text);
    return emit(
      makeEnvelope({
        ok: Boolean(last && last.ok && !pending),
        phase: last && last.ok && !pending ? 'success' : pending ? 'pending' : 'failure',
        action: 'pollChecks',
        params: { prNumber, branch, waitChecks, timeoutMs: maxMs },
        result: {
          code: last ? last.code : null,
          attempts,
          stdout: last ? last.stdout : '',
          stderr: last ? last.stderr : '',
          checkState: pending ? 'pending' : last?.ok ? 'success' : 'failure',
          elapsedMs: durationMs,
          next: pending ? 'checks_pending_retry_or_wait' : null,
        },
        durationMs,
        timestamp: startedAt,
      })
    );
  }

  async function readLocalRefSha(ref: any) {
    const clean = cleanText(ref);
    if (!clean) return { sha: null, error: null, ref: null };
    const res = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['rev-parse', clean],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return {
      ref: clean,
      sha: res.ok ? cleanText(res.stdout) : null,
      error: res.ok ? null : cleanText(res.stderr || res.stdout || 'git rev-parse failed'),
    };
  }

  // Live release-train evidence from GitHub Actions: any queued/in-progress
  // run of a publishing workflow (release trains AND dev→latest promotions —
  // both move the update feed) means automerge must wait, since merging to
  // main can queue ANOTHER train. Fail-open by design — errors (no such
  // workflow, gh offline) degrade to 'unknown' and never block; the hard
  // gates stay validator PASS + green CI.
  async function readReleaseTrainState({ workflow }: any = {}) {
    const workflows = (Array.isArray(workflow) ? workflow : [workflow])
      .map((wf: any) => cleanText(wf))
      .filter(Boolean);
    const probed = workflows.length > 0 ? workflows : ['release.yml', 'promote.yml'];
    const activeRunIds: any[] = [];
    let activeRuns = 0;
    let firstError: any = null;
    for (const wf of probed) {
      const res = await runOnce({
        execFileImpl: runner,
        bin: 'gh',
        args: ['run', 'list', '--workflow', wf, '--json', 'status,databaseId,event', '--limit', '20'],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!res.ok) {
        if (!firstError) firstError = cleanText(res.stderr || res.stdout || 'gh run list failed');
        continue;
      }
      let runs: any[] = [];
      try {
        const parsed = parseGhJson(res.stdout, []);
        runs = Array.isArray(parsed) ? parsed : [];
      } catch (err: any) {
        if (!firstError) firstError = err?.message || String(err);
        continue;
      }
      const active = runs.filter((run: any) =>
        /^(queued|in_progress|requested|waiting|pending)$/i.test(String(run?.status || ''))
      );
      activeRuns += active.length;
      activeRunIds.push(...active.map((run: any) => run?.databaseId ?? null).filter((id: any) => id != null));
    }
    if (activeRuns > 0) {
      return { state: 'publishing', workflows: probed, activeRuns, runIds: activeRunIds, error: firstError };
    }
    if (firstError) {
      return { state: 'unknown', workflows: probed, activeRuns: 0, runIds: [], error: firstError };
    }
    return { state: 'idle', workflows: probed, activeRuns: 0, runIds: [], error: null };
  }

  async function gatePr({
    prNumber,
    taskId,
    branch,
    worktreePath,
    remote = 'origin',
    gate,
    feature,
  }: any = {}) {
    if (prNumber == null) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'gatePr',
          params: { prNumber, taskId },
          result: { error: 'prNumber is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    const fields = 'number,url,state,title,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,statusCheckRollup,isDraft,reviewDecision,files';
    const prView = await runOnce({
      execFileImpl: runner,
      bin: 'gh',
      args: ['pr', 'view', String(prNumber), '--json', fields],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    let parsed: any = {};
    let prViewError = null;
    if (prView.ok) {
      try {
        parsed = parseGhJson(prView.stdout, {});
      } catch (err) {
        prViewError = err?.message || String(err);
      }
    } else {
      prViewError = prView.stderr || prView.stdout || 'gh pr view failed';
    }

    const headBranch = parsed.headRefName || null;
    const baseBranch = parsed.baseRefName || null;
    const headSha = parsed.headRefOid || null;
    const baseShaEvidence = baseBranch
      ? await readLocalRefSha(`${remote || 'origin'}/${baseBranch}`)
      : { sha: null, error: null, ref: null };
    // Release-train guard: live evidence only when the caller opted in
    // (automerge implies it) — default gate reports stay single-read.
    const releaseGuard = gate?.automerge === true || gate?.releaseTrainGuard === true;
    const releaseTrain = releaseGuard
      ? await readReleaseTrainState({ workflow: gate?.releaseWorkflow })
      : null;
    const changedFiles = Array.isArray(parsed.files)
      ? parsed.files.map((file: any) => cleanText(file?.path || file?.filename || file)).filter(Boolean)
      : [];
    const checkState = rollupCheckState(parsed.statusCheckRollup);
    // The org review-bot's verdict rides the same rollup as a check named
    // 'validate' / 'PR Validator'. Surface it BY NAME (plus its Must-fix
    // findings when it is failing) so the spine can author a fixback from the
    // verdict instead of parking blind on checkState='failure'. Findings stay
    // OPTIONAL — a fetch/parse miss leaves the failing check as the evidence.
    let reviewBot = extractReviewBotCheck(parsed.statusCheckRollup);
    if (reviewBot && isFailingCheckState(reviewBot.state)) {
      const commentsView = await runOnce({
        execFileImpl: runner,
        bin: 'gh',
        args: ['pr', 'view', String(prNumber), '--json', 'comments'],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (commentsView.ok) {
        try {
          const parsedComments = parseGhJson(commentsView.stdout, {});
          const bodies = Array.isArray(parsedComments?.comments)
            ? parsedComments.comments.map((c: any) => String(c?.body || ''))
            : [];
          const findings = parseReviewBotFindings(bodies);
          reviewBot = { ...reviewBot, score: findings.score, mustFix: findings.mustFix };
        } catch { /* findings stay optional — the failing check alone drives the fixback */ }
      }
    }
    const taskExpectedBaseBranch = gate?.expectedBaseBranch || gate?.baseBranch || null;
    const taskMatched = taskContextMatchesPr({
      branch: branch || gate?.branch || gate?.cleanup?.branch || null,
      worktreePath: worktreePath || gate?.worktreePath || gate?.cleanup?.worktreePath || null,
      expectedBaseBranch: taskExpectedBaseBranch,
      prHeadBranch: headBranch,
      prBaseBranch: baseBranch,
    });
    const expectedBaseBranch = taskExpectedBaseBranch || baseBranch || null;
    const mergeGate = evaluateMergeGate(buildGatewayGateInput({
      gate,
      feature,
      prNumber,
      tracked: gate?.tracked === true || taskMatched,
      pr: {
        headBranch,
        baseBranch,
        headSha,
        baseSha: parsed.baseRefOid || baseShaEvidence.sha,
        isDraft: parsed.isDraft === true,
        changedFiles,
        prState: parsed.state || null,
        checkState,
        mergeable: parsed.mergeable || null,
        reviewDecision: parsed.reviewDecision || null,
      },
      expectedBaseBranch,
      branch: branch || gate?.branch || gate?.cleanup?.branch || headBranch || null,
      worktreePath: worktreePath || gate?.worktreePath || gate?.cleanup?.worktreePath || null,
      releaseTrain,
      prViewError,
    }));
    const status = mergeGate.ok ? 'PASS' : 'BLOCKED';
    return emit(
      makeEnvelope({
        ok: true,
        phase: mergeGate.ok ? 'pass' : 'blocked',
        action: 'gatePr',
        params: { prNumber, taskId, branch, remote },
        result: {
          status,
          task: {
            taskId: taskId || null,
            branch: branch || gate?.branch || null,
            baseBranch: expectedBaseBranch,
            worktreePath: worktreePath || gate?.worktreePath || null,
          },
          feature: feature || null,
          pr: {
            number: parsed.number != null ? Number(parsed.number) : Number(prNumber),
            url: parsed.url || feature?.prUrl || null,
            title: parsed.title || null,
            state: parsed.state || null,
            isDraft: parsed.isDraft === true,
            headRefName: headBranch,
            baseRefName: baseBranch,
            headSha,
            baseSha: parsed.baseRefOid || baseShaEvidence.sha,
            baseShaSource: parsed.baseRefOid ? 'github-baseRefOid' : baseShaEvidence.ref,
            baseShaError: baseShaEvidence.error,
            checkState,
            mergeable: parsed.mergeable || null,
            reviewDecision: parsed.reviewDecision || null,
            files: changedFiles,
          },
          validation: mergeGate.validation,
          reviewBot,
          cleanup: mergeGate.cleanup,
          recommendedMergeMode: parsed.isDraft === true
            ? 'normal'
            : mergeGate.failures.some((failure: any) => failure.code === 'checks_not_green')
              ? 'auto'
              : 'normal',
          gate: mergeGate,
          reasons: mergeGate.failures,
          releaseTrain,
          noMutation: {
            github: releaseTrain ? ['gh pr view', 'gh run list'] : ['gh pr view'],
            git: baseShaEvidence.ref ? ['git rev-parse'] : [],
            merges: false,
            cleanup: false,
            release: false,
          },
        },
        durationMs: Date.now() - t0,
        timestamp: startedAt,
      })
    );
  }

  async function mergePr({
    missionRef,
    prNumber,
    method = 'squash',
    deleteBranch: del = true,
    auto = true,
    autoAdmin = true,
    admin = false,
    adminReason,
    taskId,
    branch,
    worktreePath,
    remote,
    prUrl,
    mergedAt,
    gate,
    feature,
  }: any = {}) {
    const effectiveAuto = admin === true ? false : auto !== false;
    const effectiveAutoAdmin = effectiveAuto && autoAdmin !== false;
    const mergeMode = mergeModeFromOptions({ auto: effectiveAuto, admin });
    const cleanAdminReason = cleanText(adminReason);
    if (prNumber == null) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'mergePr',
          params: { prNumber, method, deleteBranch: del, mergeMode },
          result: { error: 'prNumber is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    if (admin === true && !cleanAdminReason) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'mergePr',
          params: { prNumber, method, deleteBranch: del, mergeMode, adminReason: null },
          result: { error: 'admin_reason_required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    return withRepoMergeLock(cleanupCwd || cwd, async () => {
    const fields = 'state,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,statusCheckRollup,isDraft,reviewDecision,files';
    const readPrIntel = async () => {
      const prView = await runOnce({
        execFileImpl: runner,
        bin: 'gh',
        args: ['pr', 'view', String(prNumber), '--json', fields],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      let prIntel: any = {};
      let prViewError = null;
      if (prView.ok) {
        try {
          const parsed = parseGhJson(prView.stdout, {});
          prIntel = {
            prState: parsed.state || null,
            headBranch: parsed.headRefName || null,
            baseBranch: parsed.baseRefName || null,
            headSha: parsed.headRefOid || null,
            baseSha: parsed.baseRefOid || null,
            isDraft: parsed.isDraft === true,
            // null (not []) when gh did not return a list — the automerge
            // unknown-changes hold must fire instead of risk holds silently
            // no-op'ing on an empty list.
            changedFiles: Array.isArray(parsed.files)
              ? parsed.files.map((file: any) => cleanText(file?.path || file?.filename || file)).filter(Boolean)
              : null,
            mergeable: parsed.mergeable || null,
            reviewDecision: parsed.reviewDecision || null,
            checkState: rollupCheckState(parsed.statusCheckRollup),
          };
        } catch (err) {
          prViewError = err?.message || String(err);
        }
      } else {
        prViewError = prView.stderr || prView.stdout || 'gh pr view failed';
      }
      return { prIntel, prViewError };
    };
    let { prIntel, prViewError } = await readPrIntel();
    let checkWait: any = null;
    if (effectiveAuto && prIntel.checkState === 'pending') {
      checkWait = await pollChecks({ prNumber, waitChecks: true });
      if (!checkWait.ok) {
        return emit(
          makeEnvelope({
            ok: false,
            phase: checkWait.phase === 'pending' ? 'pending' : 'failure',
            action: 'mergePr',
            params: { prNumber, method, deleteBranch: del, mergeMode, adminReason: cleanAdminReason, autoAdmin: effectiveAutoAdmin },
            result: {
              error: checkWait.phase === 'pending' ? 'checks_still_pending' : 'checks_not_green',
              checkWait,
            },
            durationMs: checkWait.durationMs || 0,
            timestamp: clock(),
          })
        );
      }
      ({ prIntel, prViewError } = await readPrIntel());
    }
    // Release-train guard: when this is an automerge (or the caller opted
    // in), read live workflow-run evidence in the same pre-merge pass as the
    // fresh PR intel so the gate sees the train state at merge time.
    const releaseGuard = gate?.automerge === true || gate?.releaseTrainGuard === true;
    const releaseTrain = releaseGuard
      ? await readReleaseTrainState({ workflow: gate?.releaseWorkflow })
      : null;
    const taskExpectedBaseBranch = gate?.expectedBaseBranch || gate?.baseBranch || null;
    const taskMatched = taskContextMatchesPr({
      branch: branch || gate?.branch || gate?.cleanup?.branch || null,
      worktreePath: worktreePath || gate?.worktreePath || gate?.cleanup?.worktreePath || null,
      expectedBaseBranch: taskExpectedBaseBranch,
      prHeadBranch: prIntel.headBranch,
      prBaseBranch: prIntel.baseBranch,
    });
    const expectedBaseBranch = taskExpectedBaseBranch || prIntel.baseBranch || null;
    const expectedPrBaseSha = gate?.expectedPrBaseSha ?? feature?.prBaseSha;
    const expectedBaseSha = expectedPrBaseSha ?? gate?.expectedBaseSha;
    const baseShaEvidence = expectedBaseSha && prIntel.baseBranch
      ? await readLocalRefSha(`${remote || 'origin'}/${prIntel.baseBranch}`)
      : { sha: null, error: null, ref: null };
    let mergeGate = evaluateMergeGate(buildGatewayGateInput({
      gate: { ...(gate && typeof gate === 'object' ? gate : {}), expectedPrBaseSha },
      feature,
      prNumber,
      tracked: gate?.tracked === true || taskMatched,
      pr: {
        headBranch: prIntel.headBranch || null,
        baseBranch: prIntel.baseBranch || gate?.baseBranch || gate?.actualBaseBranch || null,
        headSha: prIntel.headSha || null,
        baseSha: prIntel.baseSha || baseShaEvidence.sha,
        isDraft: prIntel.isDraft === true,
        changedFiles: prIntel.changedFiles || [],
        prState: prIntel.prState || gate?.prState || null,
        checkState: prIntel.checkState || gate?.checkState || null,
        mergeable: prIntel.mergeable || gate?.mergeable || null,
        reviewDecision: prIntel.reviewDecision || gate?.reviewDecision || null,
      },
      expectedBaseBranch,
      branch: branch || gate?.branch || gate?.cleanup?.branch || null,
      worktreePath: worktreePath || gate?.worktreePath || gate?.cleanup?.worktreePath || null,
      releaseTrain,
      prViewError,
    }));
    // Fail closed when auto-merging with an UNKNOWN changed-file list — the
    // risk holds cannot be evaluated against nothing.
    mergeGate = holdGateOnUnknownChanges(mergeGate, {
      autoMerge: gate?.automerge === true,
      changedFiles: prIntel.changedFiles ?? null,
    });
    if (!mergeGate.ok) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'mergePr',
          params: { prNumber, method, deleteBranch: del, mergeMode, adminReason: cleanAdminReason },
          result: {
            error: 'merge gate blocked',
            failures: mergeGate.failures,
            gate: mergeGate,
          },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const methodFlag =
      method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash';
    const mergeArgs = (useGithubAuto = false, useAdmin = admin) => {
      const args = ['pr', 'merge', String(prNumber), methodFlag];
      // P7: stamp the mission identity into the squash commit body so the
      // release workflow can route RELEASE_PUBLISHED/FAILED back to the card
      // (and skip silently for non-mission pushes to main).
      if (missionRef?.missionId) {
        args.push('--body', `Mission-Id: ${missionRef.missionId}${missionRef.featureId ? `\nFeature-Id: ${missionRef.featureId}` : ''}`);
      }
      if (useGithubAuto) args.push('--auto');
      if (useAdmin) args.push('--admin');
      return args;
    };
    const startedAt = clock();
    const t0 = Date.now();
    let githubAutoRequested = false;
    let adminFallbackRequested = false;
    let mergeRes = await runWithRetry({
      execFileImpl: runner,
      bin: 'gh',
      args: mergeArgs(false),
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      attempts: RETRY.merge,
      logger: log,
    });
    const firstMergeError = `${mergeRes.stderr || ''}\n${mergeRes.stdout || ''}`;
    if (!mergeRes.ok && effectiveAuto && !admin && branchPolicyRequiresAutoOrAdmin(firstMergeError) && !githubAuthOrPermissionFailure(firstMergeError)) {
      const useAdminFallback = effectiveAutoAdmin;
      adminFallbackRequested = useAdminFallback;
      githubAutoRequested = !useAdminFallback;
      mergeRes = await runWithRetry({
        execFileImpl: runner,
        bin: 'gh',
        args: mergeArgs(!useAdminFallback, useAdminFallback),
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        attempts: RETRY.merge,
        logger: log,
      });
    }
    const env = makeEnvelope({
      ok: mergeRes.ok,
      phase: mergeRes.ok ? 'success' : 'failure',
      action: 'mergePr',
      params: { prNumber, method, deleteBranch: del, mergeMode, adminReason: cleanAdminReason },
      result: {
        code: mergeRes.code,
        attempts: mergeRes.attempts,
        stdout: mergeRes.stdout,
        stderr: mergeRes.stderr,
        killed: mergeRes.killed,
        aceAuto: effectiveAuto,
        autoAdmin: effectiveAutoAdmin,
        adminFallbackRequested,
        githubAutoRequested,
        checkWait,
      },
      durationMs: Date.now() - t0,
      timestamp: startedAt,
    });
    if (!env.ok && githubAuthOrPermissionFailure(`${env.result?.stderr || ''}\n${env.result?.stdout || ''}`)) {
      env.result = {
        ...(env.result || {}),
        ...githubAuthError({ rawError: `${env.result?.stderr || ''}\n${env.result?.stdout || ''}` }),
        auth: { unauthorized: true },
      };
    } else if (!env.ok && branchPolicyRequiresAutoOrAdmin(`${env.result?.stderr || ''}\n${env.result?.stdout || ''}`)) {
      env.result = {
        ...(env.result || {}),
        ...branchPolicyError({
          taskId,
          prNumber,
          rawError: `${env.result?.stderr || ''}\n${env.result?.stdout || ''}`,
          method,
          deleteBranch: del,
        }),
        branchPolicy: { requiresAutoOrAdmin: true },
      };
    }
    if (env.result && typeof env.result === 'object') {
      env.result.mergeMode = mergeMode;
      env.result.adminReason = cleanAdminReason || (env.result.adminFallbackRequested ? defaultAutoAdminReason(prNumber) : null);
    }
    if (env.ok && taskId) {
      const verify = effectiveAuto ? waitForVerifiedMerge : verifyMergedPr;
      const mergeVerification = await verify({
        prNumber,
        remote: remote || 'origin',
        baseBranch: expectedBaseBranch,
        previousBaseSha: prIntel.baseSha || baseShaEvidence.sha || null,
        expectedHeadSha: prIntel.headSha || null,
      });
      env.result = { ...env.result, mergeVerification };
      if (!mergeVerification.ok) {
        env.ok = false;
        env.phase = auto ? 'pending' : 'blocked';
        env.result = {
          ...env.result,
          error: 'merge_not_verified',
          safeNext: `wait for GitHub to report PR #${prNumber} merged and rerun ace integrate pr-merge --task ${taskId} --pr ${prNumber}`,
        };
        return emit(env);
      }
      env.result = {
        ...env.result,
        postMergeCleanup: await postMergeCleanup({
          taskId,
          branch,
          worktreePath,
          remote,
          prUrl,
          mergedAt: mergeVerification.pr.mergedAt || mergedAt,
          mergedSha: mergeVerification.pr.mergeCommitSha || mergeVerification.pr.baseShaAfter,
          baseBranch: expectedBaseBranch,
          prState: 'MERGED',
          deleteRemoteBranch: del,
        }),
      };
    }
    return emit(env);
    });
  }

  async function archiveTask({ taskId, prUrl = null, mergedAt }: any = {}) {
    if (!taskId) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'archiveTask',
          params: { taskId, prUrl, mergedAt: mergedAt || null },
          result: { error: 'taskId is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    if (typeof archiveTaskImpl !== 'function') {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'archiveTask',
          params: { taskId, prUrl, mergedAt: mergedAt || null },
          result: { error: 'archiveTaskImpl is not configured' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    return runHookAction({
      action: 'archiveTask',
      params: { taskId, prUrl, mergedAt: mergedAt || null },
      attempts: RETRY.archive,
      run: () => archiveTaskImpl({ taskId, prUrl, mergedAt }),
    });
  }

  async function deleteRemoteBranch({ branch, remote = 'origin' }: any = {}) {
    if (!branch || typeof branch !== 'string') {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'deleteRemoteBranch',
          params: { branch, remote },
          result: { error: 'branch is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    const remoteRes = await runIdempotentCommand({
      action: 'deleteRemoteBranch',
      bin: 'git',
      args: ['push', remote, '--delete', branch],
      attempts: RETRY.branchDelete,
      isMissing: (res: any) => /remote ref does not exist|unable to delete/i.test(res.stderr || ''),
    });
    return emit(
      makeEnvelope({
        ok: remoteRes.ok || remoteRes.missing,
        phase: remoteRes.ok || remoteRes.missing ? 'success' : 'failure',
        action: 'deleteRemoteBranch',
        params: { branch, remote },
        result: {
          code: remoteRes.code,
          attempts: remoteRes.attempts,
          stdout: remoteRes.stdout,
          stderr: remoteRes.stderr,
          killed: remoteRes.killed,
          missing: remoteRes.missing,
        },
        durationMs: Date.now() - t0,
        timestamp: startedAt,
      })
    );
  }

  async function deleteBranch({ branch, remote = 'origin', includeRemote = false }: any = {}) {
    if (!branch || typeof branch !== 'string') {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'deleteBranch',
          params: { branch, remote, includeRemote },
          result: { error: 'branch is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    const local = await runOnce({
      execFileImpl: runner,
      bin: 'git',
      args: ['branch', '-D', branch],
      cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    let remoteRes = null;
    if (includeRemote) {
      remoteRes = await runOnce({
        execFileImpl: runner,
        bin: 'git',
        args: ['push', remote, '--delete', branch],
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }
    const durationMs = Date.now() - t0;
    const ok = local.ok && (!includeRemote || (remoteRes && remoteRes.ok));
    return emit(
      makeEnvelope({
        ok,
        phase: ok ? 'success' : 'failure',
        action: 'deleteBranch',
        params: { branch, remote, includeRemote },
        result: {
          local: {
            code: local.code,
            stdout: local.stdout,
            stderr: local.stderr,
          },
          remote: remoteRes
            ? { code: remoteRes.code, stdout: remoteRes.stdout, stderr: remoteRes.stderr }
            : null,
        },
        durationMs,
        timestamp: startedAt,
      })
    );
  }

  // cleanup — after a PR merges, tear down the local branch and (if requested)
  // the remote branch. Safe to run multiple times: a missing branch is still
  // reported as ok=true so orchestrators can re-drive the flow idempotently.
  async function cleanup({
    branch,
    worktreePath,
    remote = 'origin',
    includeRemote = true,
    deleteLocalBranch = true,
    removeWorktree = true,
    baseBranch,
    prState,
    mergedSha,
    dryRun = false,
  }: any = {}) {
    if (!branch && !worktreePath) {
      return emit(
        makeEnvelope({
          ok: false,
          phase: 'failure',
          action: 'cleanup',
          params: {
            branch,
            worktreePath,
            remote,
            includeRemote,
            deleteLocalBranch,
            removeWorktree,
            baseBranch,
            prState,
            dryRun,
          },
          result: { error: 'branch or worktreePath is required' },
          durationMs: 0,
          timestamp: clock(),
        })
      );
    }
    const startedAt = clock();
    const t0 = Date.now();
    let worktree = null;
    let local = null;
    let remoteRes = null;
    const safety: any = {
      dryRun: dryRun === true,
      prState: prState || null,
      worktree: worktreePath ? await inspectWorktreeSafety(worktreePath) : { skipped: true, reason: 'worktreePath not provided' },
      branch: branch ? await inspectBranchMerged({ branch, baseBranch, remote, prState }) : { skipped: true, reason: 'branch not provided' },
      mergeCommit: await inspectMergeCommit({ mergedSha, baseBranch, remote }),
      blockers: [],
    };

    if (String(prState || '').toUpperCase() === 'OPEN') {
      safety.blockers.push({ code: 'pr_open', detail: 'cleanup refuses an open PR branch' });
    }
    if (safety.worktree.exists === true && safety.worktree.clean === false) {
      safety.blockers.push({ code: 'worktree_dirty', detail: 'worktree has uncommitted changes' });
    }
    if (worktreePath && !branch) {
      safety.blockers.push({ code: 'cleanup_branch_unknown', detail: 'worktree cleanup requires branch merge evidence' });
    }
    if (branch && safety.branch.merged !== true && safety.mergeCommit.merged !== true) {
      safety.blockers.push({
        code: 'branch_unmerged',
        detail: safety.mergeCommit.reason || safety.branch.reason || `branch is not merged into ${baseBranch || 'base branch'}`,
      });
    }
    const blocked = safety.blockers.length > 0;

    if (removeWorktree) {
      if (worktreePath) {
        if (dryRun || blocked) {
          worktree = { skipped: true, reason: dryRun ? 'dry-run' : 'safety blocked' };
        } else {
          const worktreeRes = await runIdempotentCommand({
            action: 'cleanup',
            bin: 'git',
            args: ['worktree', 'remove', worktreePath],
            attempts: RETRY.cleanup,
            isMissing: (res: any) =>
              !fs.existsSync(worktreePath) ||
              /not a working tree|does not exist|no such file or directory/i.test(
                res.stderr || ''
              ),
          });
          worktree = {
            code: worktreeRes.code,
            attempts: worktreeRes.attempts,
            stdout: worktreeRes.stdout,
            stderr: worktreeRes.stderr,
            killed: worktreeRes.killed,
            missing: worktreeRes.missing,
          };
        }
      } else {
        worktree = { skipped: true, reason: 'worktreePath not provided' };
      }
    } else {
      worktree = { skipped: true, reason: 'removeWorktree disabled' };
    }

    if (deleteLocalBranch) {
      if (branch) {
        if (dryRun || blocked) {
          local = { skipped: true, reason: dryRun ? 'dry-run' : 'safety blocked' };
        } else {
          const localRes = await runIdempotentCommand({
            action: 'cleanup',
            bin: 'git',
            args: ['branch', '-d', branch],
            commandCwd: cleanupCwd,
            attempts: RETRY.cleanup,
            isMissing: (res: any) => /not found|does not exist|not a valid branch name/i.test(res.stderr || ''),
          });
          local = {
            code: localRes.code,
            attempts: localRes.attempts,
            stdout: localRes.stdout,
            stderr: localRes.stderr,
            killed: localRes.killed,
            missing: localRes.missing,
          };
        }
      } else {
        local = { skipped: true, reason: 'branch not provided' };
      }
    } else {
      local = { skipped: true, reason: 'deleteLocalBranch disabled' };
    }

    if (includeRemote) {
      if (branch) {
        if (dryRun || blocked) {
          remoteRes = { skipped: true, reason: dryRun ? 'dry-run' : 'safety blocked' };
        } else {
          const remoteDelete = await runIdempotentCommand({
            action: 'cleanup',
            bin: 'git',
            args: ['push', remote, '--delete', branch],
            commandCwd: cleanupCwd,
            attempts: RETRY.cleanup,
            isMissing: (res: any) =>
              /remote ref does not exist|unable to delete|not found|does not exist/i.test(res.stderr || ''),
          });
          remoteRes = {
            code: remoteDelete.code,
            attempts: remoteDelete.attempts,
            stdout: remoteDelete.stdout,
            stderr: remoteDelete.stderr,
            killed: remoteDelete.killed,
            missing: remoteDelete.missing,
          };
        }
      } else {
        remoteRes = { skipped: true, reason: 'branch not provided' };
      }
    } else {
      remoteRes = { skipped: true, reason: 'includeRemote disabled' };
    }

    const ok =
      !blocked &&
      Boolean(worktree.skipped || worktree.code === 0 || worktree.missing) &&
      Boolean(local.skipped || local.code === 0 || local.missing) &&
      Boolean(remoteRes.skipped || remoteRes.code === 0 || remoteRes.missing);
    return emit(
      makeEnvelope({
        ok,
        phase: ok ? 'success' : 'failure',
        action: 'cleanup',
        params: {
          branch,
          worktreePath,
          remote,
          includeRemote,
          deleteLocalBranch,
          removeWorktree,
          baseBranch,
          prState,
          mergedSha,
          dryRun,
        },
        result: {
          safety,
          worktree,
          local,
          remote: remoteRes,
        },
        durationMs: Date.now() - t0,
        timestamp: startedAt,
      })
    );
  }

  async function postMergeCleanup({
    taskId,
    branch,
    worktreePath,
    remote = 'origin',
    prUrl = null,
    mergedAt,
    mergedSha,
    baseBranch,
    prState,
    deleteRemoteBranch: shouldDeleteRemoteBranch = true,
  }: any = {}) {
    const archiveEnv = await archiveTask({ taskId, prUrl, mergedAt });
    const remoteEnv = branch && shouldDeleteRemoteBranch
      ? await deleteRemoteBranch({ branch, remote })
      : emitSkip({
          action: 'deleteRemoteBranch',
          params: { branch, remote },
          reason: branch ? 'remote branch preservation requested' : 'branch not provided',
        });
    const cleanupEnv =
      branch || worktreePath
        ? await cleanup({
            branch,
            worktreePath,
            remote,
            includeRemote: false,
            deleteLocalBranch: true,
            removeWorktree: true,
            baseBranch,
            prState,
            mergedSha,
          })
        : emitSkip({
            action: 'cleanup',
            params: {
              branch,
              worktreePath,
              remote,
              includeRemote: false,
              deleteLocalBranch: true,
              removeWorktree: true,
            },
            reason: 'branch and worktreePath not provided',
          });
    return {
      ok: archiveEnv.ok && remoteEnv.ok && cleanupEnv.ok,
      archiveTask: archiveEnv,
      deleteRemoteBranch: remoteEnv,
      cleanup: cleanupEnv,
    };
  }

  return {
    push,
    openPr,
    readyPr,
    requestReview,
    pollChecks,
    gatePr,
    mergePr,
    archiveTask,
    deleteRemoteBranch,
    deleteBranch,
    cleanup,
    postMergeCleanup,
    bus,
    on: (event: any, listener: any) => {
      bus.on(event, listener);
      return () => bus.off(event, listener);
    },
  };
}

module.exports = {
  createIntegrationGateway,
  buildGatewayGateInput,
  RETRY,
  DEFAULT_TIMEOUT_MS,
};
