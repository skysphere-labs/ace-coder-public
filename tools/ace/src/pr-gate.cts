function upper(value: any) {
  return String(value || '').trim().toUpperCase();
}

function text(value: any) {
  const s = String(value || '').trim();
  return s ? s : null;
}

const { evaluatePrScope } = require('./pr-scope-policy.cjs');
let automergePolicy: any;
try {
  automergePolicy = require('./automerge-policy.cjs');
} catch {
  automergePolicy = require('./automerge-policy.cts');
}

const ANSI_CONTROL_SEQUENCE_RE =
  /(?:\u001b\][\s\S]*?(?:\u0007|\u001b\\))|(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b[PX^_][\s\S]*?\u001b\\)|(?:\u001b[()][AB012])|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const NON_JSON_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function parseGhJson(stdout: any, fallback: any) {
  const cleaned = String(stdout || '')
    .replace(ANSI_CONTROL_SEQUENCE_RE, '')
    .replace(NON_JSON_CONTROL_RE, '')
    .trim();
  if (!cleaned) return fallback;
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  const starts = [objectStart, arrayStart].filter((idx) => idx >= 0);
  const start = starts.length ? Math.min(...starts) : 0;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  const body = end >= start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  return JSON.parse(body);
}

function extractPrNumber(url: any) {
  const match = String(url || '').match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

// Owner decision: at most 2 same-worker fixback rounds, then escalate to the
// owner. Bounded loops, never thrash.
const FIXBACK_RETRY_MAX_ATTEMPTS = 2;

function rollupCheckState(rollup: any) {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPending = false;
  for (const c of rollup) {
    const s = upper(c.conclusion || c.state || c.status);
    if (!s) continue;
    if (s === 'FAILURE' || s === 'FAILED' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'CANCELLED') {
      return 'failure';
    }
    if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'WAITING') {
      sawPending = true;
    }
  }
  return sawPending ? 'pending' : 'success';
}

function validationInput(validation: any) {
  const v = validation && typeof validation === 'object' ? validation : {};
  return {
    self: v.self ?? v.rookSelf ?? v.selfValidation ?? null,
    independent: v.independent ?? v.independentValidation ?? null,
    headSha: v.headSha ?? v.validatedHeadSha ?? null,
    fixback: v.fixback ?? v.fixbackState ?? null,
    required: v.required === true || v.validationRequired === true,
    highRisk: v.highRisk === true || upper(v.riskLevel || v.risk) === 'HIGH',
    chiefOverride: v.chiefOverride === true,
  };
}

function isPass(value: any) {
  return upper(value) === 'PASS' || upper(value) === 'PASSED';
}

function isFail(value: any) {
  const s = upper(value);
  return s === 'FAIL' || s === 'FAILED' || s === 'FAILURE';
}

function isUnresolvedFixback(value: any) {
  const s = upper(value);
  return (
    s === 'OPEN' ||
    s === 'PENDING' ||
    s === 'REQUESTED' ||
    s === 'NEEDS_FIXBACK' ||
    s === 'NEEDS-FIXBACK' ||
    s === 'FAIL' ||
    s === 'FAILED' ||
    s === 'FAILURE'
  );
}

function cleanupReadiness(input: any = {}) {
  const c = input.cleanup && typeof input.cleanup === 'object' ? input.cleanup : {};
  const branch = text(c.branch ?? input.branch ?? input.headBranch ?? input.headRefName);
  const worktreePath = text(c.worktreePath ?? input.worktreePath);
  const branchExistsRemote =
    typeof c.branchExistsRemote === 'boolean'
      ? c.branchExistsRemote
      : typeof input.branchExistsRemote === 'boolean'
        ? input.branchExistsRemote
        : null;
  const required = input.cleanupRequired === false || c.required === false ? false : true;
  const missing = [];
  if (!branch) missing.push('branch');
  if (!worktreePath) missing.push('worktreePath');
  return {
    required,
    ready: missing.length === 0,
    branch,
    worktreePath,
    branchExistsRemote,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Clawpatch advisory tier (ADDITIVE, DEFAULT-OFF).
//
// The latest clawpatch validation artifact at
// .ace/validation/clawpatch/<newest>.json carries findings, status, and the
// validated head. By default this is advisory and never contributes a hard gate
// failure. Only when the caller passes clawpatchEnforced===true does a real
// blocking artifact (critical/high findings, or a failed run) become a hard
// block. On a missing / failed / timed-out artifact we DO NOT block forever —
// we fall back to the independent reviewer verdict.
// ---------------------------------------------------------------------------

function newestClawpatchArtifact(projectDir: any) {
  const dir = text(projectDir);
  if (!dir) return null;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const validationDir = path.join(dir, '.ace', 'validation', 'clawpatch');
    if (!fs.existsSync(validationDir)) return null;
    const files = fs
      .readdirSync(validationDir)
      .filter((name: any) => /\.json$/i.test(String(name)))
      .map((name: any) => {
        const full = path.join(validationDir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs || 0;
        } catch {
          mtime = 0;
        }
        return { name: String(name), full, mtime };
      })
      .sort((a: any, b: any) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    if (!files.length) return null;
    const raw = fs.readFileSync(files[0].full, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clawpatchAdvisory(input: any, independentPass: any) {
  // Resolve the artifact: a pre-parsed object wins (pure/testable); otherwise
  // read the newest one from disk when a projectDir is supplied.
  const enforced = input.clawpatchEnforced === true;
  const artifact =
    input.clawpatchArtifact && typeof input.clawpatchArtifact === 'object'
      ? input.clawpatchArtifact
      : input.projectDir
        ? newestClawpatchArtifact(input.projectDir)
        : null;

  const present = !!artifact;
  const status = present ? upper(artifact.status) : null;
  const blocking = present && Array.isArray(artifact.blockingFindings) ? artifact.blockingFindings : [];
  const hasBlockingFindings = blocking.length > 0;
  // A clawpatch run that did not produce a clean PASS verdict — blocked /
  // failed / timed-out / errored — is treated as "no usable artifact" for
  // fall-back purposes (we never want clawpatch to wedge the gate forever).
  const inconclusive =
    !present ||
    status === 'BLOCKED' ||
    status === 'FAIL' ||
    status === 'FAILED' ||
    status === 'ERROR' ||
    status === 'TIMED_OUT' ||
    status === 'TIMEOUT' ||
    status === 'SKIPPED';

  const note = {
    enforced,
    present,
    status: present ? (artifact.status || null) : null,
    blockingFindings: blocking,
    hasBlockingFindings,
    inconclusive,
    artifactPath: present ? (artifact.artifactPath || null) : null,
    validatedHeadSha: present ? (artifact.validatedHeadSha || null) : null,
    advisoryOnly: !enforced,
    fellBackToIndependent: false,
    note: null as any,
  };

  if (!enforced) {
    // Advisory mode (default): never block, just surface what we saw.
    note.note = hasBlockingFindings
      ? 'clawpatch reported blocking findings (advisory only; clawpatchEnforced unset → not blocking)'
      : present
        ? 'clawpatch artifact present (advisory; no blocking findings)'
        : 'no clawpatch artifact found (advisory mode)';
    return { note, failure: null };
  }

  // Enforced mode.
  if (present && !inconclusive && hasBlockingFindings) {
    note.note = 'clawpatch reported blocking findings and clawpatchEnforced is set';
    return {
      note,
      failure: {
        code: 'clawpatch_blocking_findings',
        message: 'clawpatch reported blocking (critical/high) findings',
        actual: blocking,
      },
    };
  }
  if (present && !inconclusive) {
    note.note = 'clawpatch enforced: artifact present with no blocking findings';
    return { note, failure: null };
  }

  // Missing / failed / timed-out artifact under enforcement: do NOT block
  // forever — fall back to the independent reviewer verdict. We block only when
  // the independent verdict itself is absent AND clawpatch is inconclusive.
  note.fellBackToIndependent = true;
  if (independentPass === true) {
    note.note = 'clawpatch inconclusive (missing/failed/timed-out); independent reviewer PASS satisfies enforcement';
    return { note, failure: null };
  }
  note.note = 'clawpatch inconclusive (missing/failed/timed-out) and no independent reviewer PASS to fall back on';
  return {
    note,
    failure: {
      code: 'clawpatch_inconclusive_no_independent',
      message:
        'clawpatch enforced but its artifact is missing/failed/timed-out and there is no independent reviewer PASS to fall back on',
      actual: note.status,
    },
  };
}

function evaluateMergeGate(input: any = {}) {
  const actualBaseBranch = input.baseBranch || input.baseRefName || null;
  const expectedBaseBranch =
    input.expectedBaseBranch != null && String(input.expectedBaseBranch).trim()
      ? String(input.expectedBaseBranch).trim()
      : actualBaseBranch;
  // Accept BOTH the flattened expected* fields and the nested `expectedPr`
  // shape this function itself RETURNS. Without the nested fallback, a gate
  // result re-used as a gate input silently loses its exact-head pin — the
  // gateway then evaluates with no expectedHeadSha and automerge fail-closes
  // forever (the #417 broken-closed bug).
  const expectedHeadRef = text(input.expectedHeadRef ?? input.expectedPrHeadRef ?? input.expectedPr?.headRef);
  const actualHeadRef = text(input.actualHeadRef ?? input.headRefName ?? input.headRef ?? input.headBranch);
  const expectedBaseRef = text(input.expectedBaseRef ?? input.expectedPrBaseRef ?? input.expectedPr?.baseRef);
  const actualBaseRef = text(input.actualBaseRef ?? input.baseRefName ?? input.baseRef ?? input.baseBranch);
  const expectedHeadSha = text(input.expectedHeadSha ?? input.expectedPrHeadSha ?? input.expectedPr?.headSha);
  const actualHeadSha = text(input.actualHeadSha ?? input.headSha ?? input.headRefOid);
  const expectedBaseSha = text(input.expectedPrBaseSha ?? input.expectedBaseSha ?? input.expectedPr?.baseSha);
  const actualBaseSha = text(input.actualBaseSha ?? input.baseSha ?? input.baseRefOid);
  const checkState = input.checkState || rollupCheckState(input.statusCheckRollup);
  const mergeable = input.mergeable || null;
  const prState = input.prState || input.state || null;
  const reviewDecision = input.reviewDecision || null;
  const isDraft = input.isDraft === true || input.draft === true;
  const validation = validationInput(input.validation);
  const selfPass = isPass(validation.self);
  const independentPass = isPass(validation.independent);
  const validationPassed = selfPass || independentPass;
  const validationFailed = isFail(validation.self) || isFail(validation.independent);
  const validationRequired = input.validationRequired === true || validation.required === true;
  const highRisk = input.highRisk === true || validation.highRisk;
  const chiefOverride = input.chiefOverride === true || validation.chiefOverride;
  const cleanup = cleanupReadiness(input);
  const failures = [];

  if (input.prViewError) {
    failures.push({ code: 'github_pr_view_failed', message: String(input.prViewError) });
  }
  if (input.tracked !== true) {
    failures.push({ code: 'untracked_pr', message: 'PR is not linked to a tracked child-registry row' });
  }
  if (expectedBaseBranch && actualBaseBranch !== expectedBaseBranch) {
    failures.push({
      code: 'wrong_base_branch',
      message: `PR base must be ${expectedBaseBranch}`,
      actual: actualBaseBranch,
      expected: expectedBaseBranch,
    });
  }
  if (expectedHeadRef && actualHeadRef !== expectedHeadRef) {
    failures.push({
      code: 'linked_pr_head_ref_mismatch',
      message: 'live PR head ref does not match linked mission evidence',
      actual: actualHeadRef,
      expected: expectedHeadRef,
    });
  }
  if (expectedBaseRef && actualBaseRef !== expectedBaseRef) {
    failures.push({
      code: 'linked_pr_base_ref_mismatch',
      message: 'live PR base ref does not match linked mission evidence',
      actual: actualBaseRef,
      expected: expectedBaseRef,
    });
  }
  if (expectedHeadSha && actualHeadSha !== expectedHeadSha) {
    failures.push({
      code: 'linked_pr_head_sha_mismatch',
      message: 'live PR head SHA does not match linked mission evidence',
      actual: actualHeadSha,
      expected: expectedHeadSha,
    });
  }
  if (expectedBaseSha && actualBaseSha !== expectedBaseSha) {
    failures.push({
      code: 'linked_pr_base_sha_mismatch',
      message: 'live PR base SHA does not match linked mission evidence',
      actual: actualBaseSha,
      expected: expectedBaseSha,
    });
    failures.push({
      code: 'base_sha_mismatch',
      message: 'live PR base SHA does not match linked mission evidence',
      actual: actualBaseSha,
      expected: expectedBaseSha,
    });
  }
  if (prState && upper(prState) !== 'OPEN') {
    failures.push({ code: 'pr_not_open', message: 'PR must be open', actual: prState });
  }
  if (isDraft && input.draftSafeMode !== true) {
    failures.push({ code: 'draft_pr', message: 'draft PRs cannot pass the merge gate', actual: true });
  }
  const scope = evaluatePrScope({
    allowedPaths: input.allowedPaths || input.scope?.allow || input.scope?.paths,
    changedFiles: input.changedFiles || input.files,
  });
  if (!scope.ok) {
    failures.push({
      code: scope.code,
      message: scope.message,
      allowedPaths: scope.allowedPaths,
      changedFiles: scope.changedFiles,
      unexpectedFiles: scope.unexpectedFiles,
    });
  }
  if (checkState !== 'success') {
    failures.push({ code: 'checks_not_green', message: 'status checks must be green', actual: checkState });
  }
  if (upper(mergeable) !== 'MERGEABLE') {
    failures.push({ code: 'not_mergeable', message: 'PR must be mergeable', actual: mergeable });
  }
  if (upper(reviewDecision) === 'REVIEW_REQUIRED') {
    failures.push({
      code: 'review_required',
      message: 'PR still requires approving review before merge',
      actual: reviewDecision,
    });
  }
  if (upper(reviewDecision) === 'CHANGES_REQUESTED') {
    failures.push({
      code: 'changes_requested',
      message: 'PR has requested changes and cannot be merged',
      actual: reviewDecision,
    });
  }
  if (validationFailed) {
    failures.push({ code: 'validation_failed', message: 'validation verdict is FAIL' });
  }
  if (validationRequired && !validationPassed && !validationFailed) {
    failures.push({ code: 'validation_required', message: 'required validation must pass before merge' });
  }
  if (highRisk && !chiefOverride && !independentPass) {
    failures.push({
      code: 'independent_validation_required',
      message: 'high-risk or cross-cutting changes require independent validator PASS',
    });
  }
  if (isUnresolvedFixback(validation.fixback)) {
    failures.push({ code: 'unresolved_fixback', message: 'fixback is unresolved', actual: validation.fixback });
  }
  if (cleanup.required && !cleanup.branch) {
    failures.push({ code: 'cleanup_branch_unknown', message: 'cleanup branch must be known before merge' });
  }
  if (cleanup.required && !cleanup.worktreePath) {
    failures.push({ code: 'cleanup_worktree_unknown', message: 'cleanup worktree path must be known before merge' });
  }
  // New checks append AFTER the existing codes — their order is pinned by
  // tests and downstream consumers.
  const releaseTrain =
    input.releaseTrain && typeof input.releaseTrain === 'object' ? input.releaseTrain : null;
  if (releaseTrain && upper(releaseTrain.state) === 'PUBLISHING') {
    failures.push({
      code: 'release_train_publishing',
      message: 'a release train is still publishing; merge after it completes so the update feed settles',
      actual: releaseTrain,
    });
  }
  const automerge = input.automerge === true;
  if (automerge) {
    // "Exact head" must be evidence, not an assumption: without a pinned
    // expected head SHA (e.g. a mission feature that is not PR-backed) a
    // worker could push commits AFTER validation and still carry
    // independent=PASS. The pin makes linked_pr_head_sha_mismatch the
    // stale-head blocker.
    if (!expectedHeadSha) {
      failures.push({
        code: 'automerge_exact_head_evidence_required',
        message: 'automerge requires pinned expected PR head SHA evidence for the validated head',
      });
    }
    const eligibility = automergePolicy.evaluateAutomergeEligibility({
      changedFiles: input.changedFiles || input.files,
      independentPass,
      computerUseEvidence: input.computerUseEvidence === true,
      highRisk,
    });
    failures.push(...eligibility.holds);
  }
  // Clawpatch advisory/enforcement tier. ADDITIVE + DEFAULT-OFF: with
  // clawpatchEnforced unset this never appends a failure (advisory note only).
  const clawpatch = clawpatchAdvisory(input, independentPass);
  if (clawpatch.failure) {
    failures.push(clawpatch.failure);
  }

  return {
    ok: failures.length === 0,
    readyToMerge: failures.length === 0,
    prNumber: input.prNumber ?? null,
    tracked: input.tracked === true,
    expectedBaseBranch,
    actualBaseBranch,
    expectedPr: {
      headRef: expectedHeadRef,
      baseRef: expectedBaseRef,
      headSha: expectedHeadSha,
      baseSha: expectedBaseSha,
    },
    actualPr: {
      headRef: actualHeadRef,
      baseRef: actualBaseRef,
      headSha: actualHeadSha,
      baseSha: actualBaseSha,
    },
    prState: prState || null,
    isDraft,
    scope,
    checkState,
    mergeable,
    reviewDecision,
    validation,
    validationRequired,
    cleanup,
    automerge,
    releaseTrain,
    clawpatch: clawpatch.note,
    failures,
  };
}

function rowMatchesPr(row: any, pr: any) {
  if (!row || !pr) return false;
  if (row.prNumber != null && Number(row.prNumber) === Number(pr.number)) return true;
  if (row.branch && pr.headRefName && row.branch === pr.headRefName) return true;
  const fromUrl = extractPrNumber(row.prUrl);
  return fromUrl != null && Number(fromUrl) === Number(pr.number);
}

function nonNegativeInt(value: any) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function fixbackAttempts(row: any) {
  const validation = row?.validation && typeof row.validation === 'object' ? row.validation : {};
  const fixback = validation.fixback && typeof validation.fixback === 'object' ? validation.fixback : {};
  return nonNegativeInt(
    row?.fixbackAttempts ??
    row?.fixback_attempts ??
    validation.fixbackAttempts ??
    validation.fixback_attempts ??
    validation.retryCount ??
    validation.retries ??
    fixback.attempts
  );
}

function createFixbackPacket({ pr, row, gate, classification, checkState }: any = {}) {
  if (!row || !pr) return null;
  if (classification !== 'needs-fixback' && classification !== 'conflicting') return null;

  const reasons = [];
  if (checkState === 'failure') reasons.push('failed_pr_checks');
  if (classification === 'conflicting' || upper(pr.mergeable) === 'CONFLICTING') reasons.push('conflicting_pr');
  for (const failure of gate?.failures || []) {
    if (failure?.code === 'validation_failed') reasons.push('validation_failed');
    if (failure?.code === 'unresolved_fixback') reasons.push('unresolved_fixback');
  }
  const uniqReasons = Array.from(new Set(reasons));
  const attempts = fixbackAttempts(row);
  const remaining = Math.max(0, FIXBACK_RETRY_MAX_ATTEMPTS - attempts);
  const exhausted = remaining === 0;

  return {
    type: 'FixbackPacket',
    action: exhausted ? 'retry-cap-exhausted' : 'delegate-fixback',
    taskId: row.taskId || null,
    streamId: row.streamId || null,
    prNumber: Number(pr.number),
    prUrl: pr.url || row.prUrl || null,
    branch: pr.headRefName || row.branch || null,
    baseBranch: pr.baseRefName || row.baseBranch || null,
    worktreePath: row.worktreePath || null,
    waveId: row.waveId || null,
    laneId: row.laneId || null,
    classification,
    reasons: uniqReasons,
    gateFailures: (gate?.failures || []).map((failure: any) => ({
      code: failure.code,
      message: failure.message,
      actual: failure.actual ?? null,
      expected: failure.expected ?? null,
    })),
    retry: {
      attempts,
      maxAttempts: FIXBACK_RETRY_MAX_ATTEMPTS,
      remaining,
      exhausted,
    },
    merge: {
      allowed: false,
      reason: 'fixback packets are repair instructions only; merge stays behind the explicit PR gate',
    },
    instructions: [
      'Patch the existing branch and PR; do not open a replacement PR unless the controller reroutes.',
      'Run the failing checks and validation acceptance before returning DONE.',
      'Do not merge, auto-merge, or clean up branches.',
    ],
  };
}

function classifyWorkspacePullRequests({ rows = [], pullRequests = [], baseBranch = 'main' }: any = {}) {
  const prs = Array.isArray(pullRequests) ? pullRequests : [];
  const byBranch = new Map();
  for (const pr of prs) {
    const key = pr.headRefName || '';
    const list = byBranch.get(key) || [];
    list.push(pr);
    byBranch.set(key, list);
  }
  const latestByBranch = new Map();
  for (const [branch, list] of byBranch) {
    latestByBranch.set(
      branch,
      list.reduce((best: any, pr: any) => (Number(pr.number) > Number(best.number) ? pr : best), list[0])
    );
  }

  const matchedRows = new Set();
  const fixbackPackets = [];
  const classified = prs.map((pr: any) => {
    const row = rows.find((candidate: any) => rowMatchesPr(candidate, pr)) || null;
    if (row) matchedRows.add(row.taskId);
    const checkState = rollupCheckState(pr.statusCheckRollup);
    const gate = evaluateMergeGate({
      prNumber: pr.number,
      tracked: !!row,
      baseBranch: pr.baseRefName || row?.baseBranch || null,
      prState: pr.state || null,
      checkState,
      mergeable: pr.mergeable || null,
      validation: row?.validation || null,
      expectedBaseBranch: baseBranch,
      branch: row?.branch || pr.headRefName || null,
      worktreePath: row?.worktreePath || null,
      branchExistsRemote: row?.branchExistsRemote,
    });
    const newest = latestByBranch.get(pr.headRefName || '');
    let classification = 'active';
    if (newest && Number(newest.number) !== Number(pr.number)) {
      classification = 'superseded';
    } else if (!row) {
      classification = 'untracked-open';
    } else if (upper(pr.mergeable) === 'CONFLICTING') {
      classification = 'conflicting';
    } else if (
      checkState === 'failure' ||
      gate.failures.some((failure: any) => failure.code === 'validation_failed' || failure.code === 'unresolved_fixback')
    ) {
      classification = 'needs-fixback';
    } else if (gate.ok) {
      classification = 'ready-to-review';
    }
    const fixbackPacket = createFixbackPacket({ pr, row, gate, classification, checkState });
    if (fixbackPacket) fixbackPackets.push(fixbackPacket);
    return {
      number: Number(pr.number),
      url: pr.url || null,
      title: pr.title || null,
      branch: pr.headRefName || null,
      baseBranch: pr.baseRefName || null,
      taskId: row?.taskId || null,
      tracked: !!row,
      classification,
      checkState,
      mergeable: pr.mergeable || null,
      gate,
      fixbackPacket,
    };
  });

  const staleRows = rows
    .filter((row: any) => row?.taskId && !matchedRows.has(row.taskId))
    .map((row: any) => ({
      taskId: row.taskId,
      prNumber: row.prNumber != null ? Number(row.prNumber) : null,
      prUrl: row.prUrl || null,
      branch: row.branch || null,
      baseBranch: row.baseBranch || null,
      previousPrState: row.prState || null,
      prState: 'stale',
      classification: 'stale',
      reason: 'tracked row has no matching open PR on the reconciled base',
    }));

  return { baseBranch, pullRequests: classified, staleRows, fixbackPackets };
}

function staleRowRef(row: any) {
  if (!row) return null;
  if (row.prNumber != null) return String(row.prNumber);
  const fromUrl = extractPrNumber(row.prUrl);
  return fromUrl != null ? String(fromUrl) : null;
}

function prViewMissing(textValue: any) {
  return /could not resolve|not found|no pull requests? found|http 404|graphql:.*not.*found/i.test(
    String(textValue || '')
  );
}

function normalizePrState(state: any) {
  const s = upper(state);
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  if (s === 'OPEN') return 'open';
  return text(state);
}

function staleRowFromView(row: any, parsed: any, baseBranch: any) {
  const state = normalizePrState(parsed?.state);
  const actualBaseBranch = parsed?.baseRefName || row.baseBranch || null;
  const closedAt = parsed?.closedAt || null;
  const mergedAt = parsed?.mergedAt || null;
  const base = text(baseBranch);
  const common = {
    taskId: row.taskId,
    prNumber: parsed?.number != null ? Number(parsed.number) : row.prNumber != null ? Number(row.prNumber) : null,
    prUrl: parsed?.url || row.prUrl || null,
    branch: parsed?.headRefName || row.branch || null,
    baseBranch: actualBaseBranch,
    expectedBaseBranch: base,
    previousPrState: row.prState || null,
    closedAt,
    mergedAt,
  };

  if (state === 'merged') {
    return {
      ...common,
      prState: 'merged',
      classification: 'closed',
      reason: 'tracked PR is merged and no longer open',
    };
  }
  if (state === 'closed') {
    return {
      ...common,
      prState: 'closed',
      classification: 'closed',
      reason: 'tracked PR is closed and no longer open',
    };
  }
  if (state === 'open' && base && actualBaseBranch && actualBaseBranch !== base) {
    return {
      ...common,
      prState: 'stale',
      classification: 'stale',
      reason: `tracked PR is open on base ${actualBaseBranch}, not reconciled base ${base}`,
    };
  }
  return {
    ...common,
    prState: state || 'stale',
    classification: 'stale',
    reason: 'tracked row has no matching open PR on the reconciled base',
  };
}

async function enrichStaleRows({ staleRows, rowsByTaskId, gh, cwd, baseBranch }: any) {
  const enriched = [];
  const fields = 'number,url,state,title,headRefName,baseRefName,mergedAt,closedAt';
  for (const stale of staleRows) {
    const row = rowsByTaskId.get(stale.taskId) || stale;
    const ref = staleRowRef(row);
    if (!ref) {
      enriched.push({
        ...stale,
        prState: row.prState === 'pr-open-failed' ? 'pr-open-failed' : 'stale',
        previousPrState: row.prState || null,
        reason: row.prState === 'pr-open-failed'
          ? 'tracked row never opened a PR'
          : 'tracked row has no PR number to reconcile',
      });
      continue;
    }

    const res = await gh(['pr', 'view', ref, '--json', fields], { cwd });
    if (!res || res.ok !== true) {
      const error = res?.stderr || res?.stdout || 'gh pr view failed';
      enriched.push({
        ...stale,
        prState: prViewMissing(error) ? 'missing' : 'stale',
        previousPrState: row.prState || null,
        classification: 'stale',
        reason: prViewMissing(error)
          ? 'tracked PR is missing from GitHub'
          : `tracked PR could not be viewed: ${String(error).trim()}`,
      });
      continue;
    }

    try {
      enriched.push(staleRowFromView(row, parseGhJson(res.stdout, {}), baseBranch));
    } catch (err) {
      enriched.push({
        ...stale,
        prState: 'stale',
        previousPrState: row.prState || null,
        classification: 'stale',
        reason: `tracked PR view could not be parsed: ${err?.message || String(err)}`,
      });
    }
  }
  return enriched;
}

async function reconcileWorkspacePullRequests({ rows = [], gh, cwd, baseBranch = 'main' }: any = {}) {
  if (typeof gh !== 'function') {
    return {
      ok: false,
      baseBranch,
      pullRequests: [],
      staleRows: [],
      error: 'gh function is required',
    };
  }
  const fields = 'number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision';
  const res = await gh(['pr', 'list', '--state', 'open', '--base', baseBranch, '--json', fields], { cwd });
  if (!res || res.ok !== true) {
    return {
      ok: false,
      baseBranch,
      pullRequests: [],
      staleRows: [],
      error: res?.stderr || res?.stdout || 'gh pr list failed',
    };
  }
  let pullRequests;
  try {
    pullRequests = parseGhJson(res.stdout, []);
  } catch (err) {
    return {
      ok: false,
      baseBranch,
      pullRequests: [],
      staleRows: [],
      error: err?.message || String(err),
    };
  }
  const classified = classifyWorkspacePullRequests({ rows, pullRequests, baseBranch });
  const rowsByTaskId = new Map((Array.isArray(rows) ? rows : []).map((row: any) => [row.taskId, row]));
  const staleRows = await enrichStaleRows({
    staleRows: classified.staleRows,
    rowsByTaskId,
    gh,
    cwd,
    baseBranch,
  });
  return { ok: true, ...classified, staleRows };
}

module.exports = {
  classifyWorkspacePullRequests,
  cleanupReadiness,
  createFixbackPacket,
  evaluateMergeGate,
  extractPrNumber,
  FIXBACK_RETRY_MAX_ATTEMPTS,
  parseGhJson,
  reconcileWorkspacePullRequests,
  rollupCheckState,
};
