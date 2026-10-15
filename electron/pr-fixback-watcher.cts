// pr-fixback-watcher — auto-fixback when GitHub PR checks fail.
//
// Reviewbot (`AI review gate`) and the CI workflows gate every agent PR: a
// failing review or a failing build FAILS the check run, blocks the
// integration gateway and posts a scorecard comment — and then the PR just sat
// until the owner opened the owning agent's tab and typed "the validator
// failed, fix it". This module closes that loop: it polls each local
// workspace's OPEN PRs, and when a PR's checks are FAILING it delivers a
// bounded fixback prompt into the owning task's OWN agent stream (the same
// `orchestrator.runFixback` primitive the spine uses), so the agent fixes the
// findings and re-pushes without a manual nudge. A spine-dispatched task's PR
// and a hand-opened agent tab's PR go through the same path — the watcher only
// needs task↔branch linkage, which both share.
//
// Safety rails (all decisions are pure + unit-tested):
//   · one dispatch per failing HEAD — a head is only re-attacked after the
//     agent pushes a NEW head that still fails;
//   · at most `maxRounds` dispatches per PR (default: the spine's
//     FIXBACK_RETRY_CAP), then the watcher parks the PR and logs once;
//   · a task whose stream is mid-turn (busy/booting/awaiting-approval) is
//     skipped this tick — never interrupt a working agent;
//   · draft PRs, PRs with no owning task, and remote/personal workspaces are
//     ignored; a dead `gh` degrades to a no-op tick.
//
// Attempt state persists to <userDataPath>/.ace/pr-fixback-state.json so a
// restart neither re-fires on an already-handled head nor forgets the cap.
// Master kill: ACE_PR_FIXBACK=0. Cadence: ACE_PR_FIXBACK_MS (default 120s).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Reuse the spine's fixback retry cap so the watcher and the run-ledger agree
// on how many automated repair rounds a change gets before a human looks.
let orchestrationPolicy: any;
try { orchestrationPolicy = require('../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicy = require('../tools/ace/src/orchestration-policy.cts'); }
const { FIXBACK_RETRY_CAP } = orchestrationPolicy;

const DEFAULT_INTERVAL_MS = 120_000;
const MIN_INTERVAL_MS = 30_000;
const BOOT_DELAY_MS = 20_000;
const GH_TIMEOUT_MS = 15_000;
// Stream states that mean "the agent is mid-turn — do not paste into it now".
const BUSY_STREAM_STATES = new Set(['busy', 'booting', 'awaiting-approval']);
// Scorecard markers: Reviewbot's live comment, plus leftover PR Validator posts.
const VALIDATOR_COMMENT_MARKER = '## PR Validator:';
const REVIEWBOT_COMMENT_MARKER = '## Reviewbot';
const MAX_SCORECARD_CHARS = 1500;

// ── Pure helpers (exported for tests) ───────────────────────────────────────

// A check-rollup entry that terminally failed (mirrors local-core's
// deriveChecksStatus failure set — pending/neutral entries never count).
function failedRollupEntries(rollup: any) {
  if (!Array.isArray(rollup)) return [];
  return rollup.filter((entry: any) => {
    const conclusion = String(entry?.conclusion || '').toUpperCase();
    return conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT';
  });
}

function checkNameOf(entry: any) {
  return String(entry?.name || entry?.context || entry?.workflowName || 'check').trim();
}

// The active (non-archived) task owning a branch: match the task's primary
// branch or any of its worktree branches.
function taskForBranch(tasks: any, branch: any) {
  const wanted = String(branch || '').trim();
  if (!wanted) return null;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.archivedAt) continue;
    const branches = [task.branch, ...((task.worktrees || []).map((w: any) => w && w.branch))];
    if (branches.some((b: any) => String(b || '') === wanted)) return task;
  }
  return null;
}

// The latest PR-validator scorecard comment body, capped so the fixback prompt
// stays lean. Returns '' when the validator has not commented (plain CI fail).
function extractValidatorScorecard(comments: any) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const body = String(list[i]?.body || '');
    if (body.includes(VALIDATOR_COMMENT_MARKER) || body.includes(REVIEWBOT_COMMENT_MARKER)) {
      return body.trim().slice(0, MAX_SCORECARD_CHARS);
    }
  }
  return '';
}

// The scorecard's "### Must fix" bullets, as fixback findings the worker can
// tick off one by one. Empty for plain CI failures.
function mustFixFindings(scorecardBody: any) {
  const body = String(scorecardBody || '');
  const section = body.split(/^### Must[- ]fix\b.*$/m)[1];
  if (!section) return [];
  const items: string[] = [];
  for (const line of section.split('\n')) {
    if (/^#{2,3} /.test(line)) break; // next section
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m && m[1].trim()) items.push(m[1].trim());
  }
  return items.map((text) => ({
    criterion: text,
    status: 'must_fix',
    evidence: 'Review scorecard comment',
    fix: 'Address this finding on the same branch and push.',
  }));
}

/**
 * Decide whether a failing PR head warrants a fixback dispatch right now.
 * `record` is this PR's persisted attempt state ({ attempts, lastHeadSha }).
 * One dispatch per failing head; hard cap across heads.
 */
function shouldDispatch({ record, headSha, maxRounds }: any) {
  const attempts = Number(record?.attempts) || 0;
  const cap = Number(maxRounds) > 0 ? Number(maxRounds) : FIXBACK_RETRY_CAP;
  if (attempts >= cap) return { ok: false, reason: 'cap_exhausted' };
  if (attempts > 0) {
    // A re-dispatch needs PROOF of a new head; without both SHAs we cannot
    // tell a fresh failure from the one already being worked — stay quiet.
    if (!headSha || !record?.lastHeadSha) return { ok: false, reason: 'head_unknown' };
    if (String(record.lastHeadSha) === String(headSha)) {
      return { ok: false, reason: 'head_already_handled' };
    }
  }
  return { ok: true, reason: 'dispatch' };
}

// The runFixback failure packet for a failing PR: what failed (checks +
// scorecard findings) and how to investigate it, on the SAME branch/PR.
function buildFixbackPacket({ pr, failing, scorecard, baseBranch }: any) {
  const failingChecks = (Array.isArray(failing) ? failing : []).map(
    (e: any) => `${checkNameOf(e)} (${String(e?.conclusion || 'FAILURE').toLowerCase()})`,
  );
  const scoreMatch =
    String(scorecard || '').match(/## PR Validator: (\d)\/5/) ||
    String(scorecard || '').match(/Slop score: \*\*(\d+(?:\.\d+)?)\/5\*\*/);
  return {
    prUrl: pr?.url || null,
    branch: pr?.headRefName || null,
    baseBranch: baseBranch || null,
    actual: scoreMatch
      ? `Review scored ${scoreMatch[1]}/5 — the AI review gate is blocking merge.`
      : `GitHub checks failed on head ${String(pr?.headRefOid || '').slice(0, 12)}.`,
    expected: 'Every required PR check green (AI review gate passing, CI passing) so the integration gateway can merge.',
    rootCause:
      `Investigate on this branch: \`gh pr checks ${pr?.number}\` lists the failing checks; ` +
      '`gh run view --log-failed` shows their logs. ' +
      (scorecard ? `Validator scorecard:\n${scorecard}` : ''),
    failingChecks,
    findings: mustFixFindings(scorecard),
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createPrFixbackWatcher({
  store,
  client,
  userDataPath,
  execFileImpl = execFile,
  runFixbackImpl = null,
  onDispatched = null,
  // Ownership predicate: ({taskId, workspaceId, prNumber}) => truthy when the
  // task belongs to a live run-ledger spine run. Spine runs close their own
  // review loop (contractual same-stream fixback, bounded by the reconciler's
  // FIXBACK_RETRY_CAP), so the watcher must NOT also dispatch into them — two
  // uncoordinated dispatchers would race duplicate prompts and overshoot the
  // shared round cap. The spine is authoritative for its own tasks.
  skipTask = null,
  intervalMs = null,
  maxRounds = null,
  log = (msg: string) => console.warn(msg),
}: any = {}) {
  if (!store || typeof store.getState !== 'function') {
    throw new Error('pr-fixback-watcher: a store with getState() is required');
  }
  if (!client || typeof client.invoke !== 'function') {
    throw new Error('pr-fixback-watcher: an in-process client with .invoke is required');
  }

  const cap = Number(maxRounds ?? process.env.ACE_PR_FIXBACK_MAX_ROUNDS) > 0
    ? Number(maxRounds ?? process.env.ACE_PR_FIXBACK_MAX_ROUNDS)
    : FIXBACK_RETRY_CAP;
  const everyMs = Math.max(
    MIN_INTERVAL_MS,
    Number(intervalMs ?? process.env.ACE_PR_FIXBACK_MS) || DEFAULT_INTERVAL_MS,
  );
  const stateFile = userDataPath
    ? path.join(userDataPath, '.ace', 'pr-fixback-state.json')
    : null;

  // Lazy orchestrator import (heavy) — injectable for tests.
  let _runFixback = runFixbackImpl;
  function resolveRunFixback() {
    if (_runFixback) return _runFixback;
    let mod: any;
    try { mod = require('../tools/ace/src/orchestrator.cjs'); }
    catch { mod = require('../tools/ace/src/orchestrator.cts'); }
    _runFixback = mod.runFixback;
    return _runFixback;
  }

  // Attempt state: { entries: { "<workspaceId>#<prNumber>": { attempts, lastHeadSha, exhaustedLogged } } }
  let state: any = { version: 1, entries: {} };
  if (stateFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries) state = parsed;
    } catch { /* fresh state */ }
  }
  function saveState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e: any) {
      log(`[pr-fixback] state persist failed: ${e?.message || e}`);
    }
  }

  function execCapture(args: any, cwd: any): Promise<{ code: any; stdout: string }> {
    return new Promise((resolve) => {
      try {
        execFileImpl(
          'gh',
          args,
          { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (error: any, stdout: any) => resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout || '') }),
        );
      } catch {
        resolve({ code: 1, stdout: '' });
      }
    });
  }

  async function listOpenPrs(cwd: any) {
    const { code, stdout } = await execCapture(
      ['pr', 'list', '--state', 'open', '--limit', '50', '--json',
        'number,title,url,headRefName,baseRefName,headRefOid,isDraft,statusCheckRollup'],
      cwd,
    );
    if (code !== 0) return null; // gh missing/unauthed — degrade to no-op
    try {
      const parsed = JSON.parse(stdout || '[]');
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function fetchScorecard(cwd: any, prNumber: any) {
    const { code, stdout } = await execCapture(
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      cwd,
    );
    if (code !== 0) return '';
    try { return extractValidatorScorecard(JSON.parse(stdout || '{}').comments); }
    catch { return ''; }
  }

  // The task's stream to deliver into: prefer a LIVE idle stream, else a
  // dormant one (delivery wakes it). Returns undefined when the task has no
  // stream at all (runFixback then spawns one onto the task), and the sentinel
  // 'busy' when the only live stream is mid-turn (skip this tick).
  function streamForTask(streams: any, taskId: any) {
    const mine = (Array.isArray(streams) ? streams : []).filter(
      (s: any) => s && String(s.taskId || '') === String(taskId),
    );
    if (!mine.length) return { streamId: undefined };
    const live = mine.filter((s: any) => s.live);
    for (const s of live) {
      if (!BUSY_STREAM_STATES.has(String(s.state || ''))) return { streamId: s.streamId };
    }
    if (live.length) return { busy: true };
    return { streamId: mine[0].streamId }; // dormant — delivery wakes it
  }

  let ticking = false;
  async function tick() {
    if (ticking) return { skipped: 'overlap' };
    ticking = true;
    try {
      return await sweep();
    } catch (e: any) {
      log(`[pr-fixback] sweep error: ${e?.message || e}`);
      return { error: String(e?.message || e) };
    } finally {
      ticking = false;
    }
  }

  async function sweep() {
    const workspaces = (store.getState()?.workspaces || []).filter(
      (ws: any) => ws && ws.path && !ws.isRemote && !ws.isPersonal,
    );
    const dispatched: any[] = [];
    let streams: any = null; // fetched once, only when a candidate appears
    let stateDirty = false;

    for (const ws of workspaces) {
      const prs = await listOpenPrs(ws.path);
      if (!prs) continue;

      // Prune attempt records for PRs no longer open in this workspace, so the
      // state file stays bounded and a reopened number starts fresh.
      const openKeys = new Set(prs.map((pr: any) => `${ws.id}#${pr.number}`));
      for (const key of Object.keys(state.entries)) {
        if (key.startsWith(`${ws.id}#`) && !openKeys.has(key)) {
          delete state.entries[key];
          stateDirty = true;
        }
      }

      for (const pr of prs) {
        if (!pr || pr.isDraft) continue;
        const failing = failedRollupEntries(pr.statusCheckRollup);
        if (!failing.length) continue;
        const task = taskForBranch(ws.tasks, pr.headRefName);
        if (!task) continue; // manual/foreign PR — not ours to drive

        // Spine-owned task: the run-ledger closure loop is authoritative. FAIL
        // CLOSED on indeterminacy — if ownership cannot be classified (predicate
        // throws, e.g. the harness is not ready yet), skip this tick rather
        // than risk double-dispatching into a spine-owned stream; the next tick
        // reclassifies.
        if (typeof skipTask === 'function') {
          let spineOwned = true;
          try { spineOwned = !!(await skipTask({ taskId: task.id, workspaceId: ws.id, prNumber: pr.number })); }
          catch { spineOwned = true; }
          if (spineOwned) continue;
        }

        const key = `${ws.id}#${pr.number}`;
        const record = state.entries[key] || { attempts: 0, lastHeadSha: null };
        const verdict = shouldDispatch({ record, headSha: pr.headRefOid, maxRounds: cap });
        if (!verdict.ok) {
          if (verdict.reason === 'cap_exhausted' && !record.exhaustedLogged) {
            record.exhaustedLogged = true;
            state.entries[key] = record;
            stateDirty = true;
            log(`[pr-fixback] PR #${pr.number} (${ws.name || ws.id}): fixback cap (${cap}) exhausted — owner attention needed`);
          }
          continue;
        }

        if (streams == null) {
          try { streams = (await client.invoke('streamList', {}))?.streams || []; }
          catch { streams = []; }
        }
        const resolved = streamForTask(streams, task.id);
        if (resolved.busy) continue; // agent mid-turn — retry next tick

        const scorecard = await fetchScorecard(ws.path, pr.number);
        const packet = buildFixbackPacket({ pr, failing, scorecard, baseBranch: pr.baseRefName });
        const attempts = record.attempts + 1;
        try {
          await resolveRunFixback()(client, {
            row: {
              streamId: resolved.streamId,
              taskId: task.id,
              workspaceId: ws.id,
              branch: pr.headRefName,
              prUrl: pr.url,
              workerAgent: task.agent || null,
              allowPaths: [],
            },
            packet,
            attempts,
            remaining: Math.max(0, cap - attempts),
          });
        } catch (e: any) {
          log(`[pr-fixback] dispatch failed for PR #${pr.number}: ${e?.message || e}`);
          continue; // head stays unhandled — retried next tick
        }

        state.entries[key] = { attempts, lastHeadSha: pr.headRefOid || null };
        stateDirty = true;
        dispatched.push({ workspaceId: ws.id, prNumber: pr.number, taskId: task.id, headSha: pr.headRefOid });
        log(`[pr-fixback] PR #${pr.number} (${ws.name || ws.id}): checks failing — fixback ${attempts}/${cap} delivered to task ${task.id}`);
        if (typeof onDispatched === 'function') {
          try {
            onDispatched({
              workspaceId: ws.id, prNumber: pr.number, prUrl: pr.url,
              taskId: task.id, streamId: resolved.streamId || null,
              headSha: pr.headRefOid || null, attempts,
            });
          } catch { /* observer must never break the sweep */ }
        }
      }
    }

    if (stateDirty) saveState();
    return { dispatched };
  }

  let timer: any = null;
  let bootTimer: any = null;
  function start() {
    if (process.env.ACE_PR_FIXBACK === '0') return false;
    if (timer) return true;
    timer = setInterval(tick, everyMs);
    if (typeof timer.unref === 'function') timer.unref();
    bootTimer = setTimeout(tick, BOOT_DELAY_MS);
    if (typeof bootTimer.unref === 'function') bootTimer.unref();
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (bootTimer) clearTimeout(bootTimer);
    timer = null;
    bootTimer = null;
  }

  return { start, stop, tick };
}

module.exports = {
  createPrFixbackWatcher,
  failedRollupEntries,
  taskForBranch,
  extractValidatorScorecard,
  mustFixFindings,
  shouldDispatch,
  buildFixbackPacket,
};
