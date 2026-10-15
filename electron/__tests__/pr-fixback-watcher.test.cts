// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
// PR fixback watcher — pure decision helpers + a full injected-fake sweep
// (electron/pr-fixback-watcher.cts). No real gh, no real streams, no clock.

import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const watcherModule = require('../pr-fixback-watcher.cts');
const {
  createPrFixbackWatcher,
  failedRollupEntries,
  taskForBranch,
  extractValidatorScorecard,
  mustFixFindings,
  shouldDispatch,
  buildFixbackPacket,
} = watcherModule;

const SCORECARD = [
  '## PR Validator: 2/5 — blocked, fix and push ❌',
  '',
  '**Summary:** Broken error handling in the new watcher.',
  '',
  '### Must fix',
  '- unhandled rejection in sweep()',
  '- state file clobbers concurrent writers',
  '',
  '### Slop / cleanup suggestions',
  '- rename tick',
].join('\n');

function rollup({ failed = 0, pending = 0, ok = 0 } = {}) {
  const out = [];
  for (let i = 0; i < failed; i += 1) out.push({ name: `fail-${i}`, status: 'COMPLETED', conclusion: 'FAILURE' });
  for (let i = 0; i < pending; i += 1) out.push({ name: `pend-${i}`, status: 'IN_PROGRESS', conclusion: '' });
  for (let i = 0; i < ok; i += 1) out.push({ name: `ok-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' });
  return out;
}

describe('failedRollupEntries', () => {
  it('keeps only terminal failures (failure/cancelled/timed_out)', () => {
    const entries = [
      { name: 'validate', conclusion: 'FAILURE' },
      { name: 'ci-fast', conclusion: 'CANCELLED' },
      { name: 'ci-heavy', conclusion: 'TIMED_OUT' },
      { name: 'green', conclusion: 'SUCCESS' },
      { name: 'running', status: 'IN_PROGRESS', conclusion: '' },
    ];
    expect(failedRollupEntries(entries).map((e) => e.name)).toEqual(['validate', 'ci-fast', 'ci-heavy']);
    expect(failedRollupEntries(null)).toEqual([]);
  });
});

describe('taskForBranch', () => {
  const tasks = [
    { id: 't-archived', branch: 'feat/x', archivedAt: '2026-01-01' },
    { id: 't1', branch: 'feat/x', worktrees: [] },
    { id: 't2', branch: '', worktrees: [{ branch: 'feat/y' }] },
  ];
  it('matches the task primary branch and skips archived tasks', () => {
    expect(taskForBranch(tasks, 'feat/x').id).toBe('t1');
  });
  it('matches a worktree branch', () => {
    expect(taskForBranch(tasks, 'feat/y').id).toBe('t2');
  });
  it('returns null when no task owns the branch', () => {
    expect(taskForBranch(tasks, 'feat/none')).toBeNull();
    expect(taskForBranch(tasks, '')).toBeNull();
  });
});

describe('scorecard extraction', () => {
  it('finds the latest validator comment and caps it', () => {
    const comments = [
      { body: 'unrelated' },
      { body: SCORECARD },
      { body: 'also unrelated' },
    ];
    expect(extractValidatorScorecard(comments)).toContain('## PR Validator: 2/5');
    expect(extractValidatorScorecard([{ body: 'nope' }])).toBe('');
    expect(
      extractValidatorScorecard([{ body: '## Reviewbot — 🚫 merge blocked\n\n### Must-fix\n- pin the SHA' }])
    ).toContain('## Reviewbot');
  });
  it('parses must-fix bullets into findings and stops at the next section', () => {
    const findings = mustFixFindings(SCORECARD);
    expect(findings.map((f) => f.criterion)).toEqual([
      'unhandled rejection in sweep()',
      'state file clobbers concurrent writers',
    ]);
    expect(mustFixFindings('no sections here')).toEqual([]);
    expect(
      mustFixFindings('## Reviewbot — 🚫 merge blocked\n\n### Must-fix — resolve these\n- pin the SHA\n')
        .map((f) => f.criterion)
    ).toEqual(['pin the SHA']);
  });
});

describe('shouldDispatch', () => {
  it('dispatches a fresh failure', () => {
    expect(shouldDispatch({ record: null, headSha: 'a1', maxRounds: 3 }).ok).toBe(true);
  });
  it('never re-fires on the head already handled', () => {
    const verdict = shouldDispatch({ record: { attempts: 1, lastHeadSha: 'a1' }, headSha: 'a1', maxRounds: 3 });
    expect(verdict).toEqual({ ok: false, reason: 'head_already_handled' });
  });
  it('re-fires when a NEW head is still failing', () => {
    expect(shouldDispatch({ record: { attempts: 1, lastHeadSha: 'a1' }, headSha: 'b2', maxRounds: 3 }).ok).toBe(true);
  });
  it('stays quiet when a re-dispatch cannot prove a new head', () => {
    expect(shouldDispatch({ record: { attempts: 1, lastHeadSha: null }, headSha: 'b2', maxRounds: 3 }).ok).toBe(false);
    expect(shouldDispatch({ record: { attempts: 1, lastHeadSha: 'a1' }, headSha: null, maxRounds: 3 }).ok).toBe(false);
  });
  it('exhausts at the cap', () => {
    const verdict = shouldDispatch({ record: { attempts: 3, lastHeadSha: 'a1' }, headSha: 'b2', maxRounds: 3 });
    expect(verdict).toEqual({ ok: false, reason: 'cap_exhausted' });
  });
});

describe('buildFixbackPacket', () => {
  const pr = { number: 7, url: 'https://x/pr/7', headRefName: 'feat/x', headRefOid: 'abc123def456' };
  it('carries the validator score, failing checks, and findings', () => {
    const packet = buildFixbackPacket({
      pr,
      failing: [{ name: 'validate', conclusion: 'FAILURE' }],
      scorecard: SCORECARD,
      baseBranch: 'main',
    });
    expect(packet.actual).toContain('2/5');
    expect(packet.failingChecks).toEqual(['validate (failure)']);
    expect(packet.findings).toHaveLength(2);
    expect(packet.rootCause).toContain('gh pr checks 7');
    expect(packet.rootCause).toContain('## PR Validator: 2/5');
  });
  it('describes a plain CI failure when there is no scorecard', () => {
    const packet = buildFixbackPacket({ pr, failing: [{ name: 'ci-fast', conclusion: 'FAILURE' }], scorecard: '' });
    expect(packet.actual).toContain('abc123def456');
    expect(packet.findings).toEqual([]);
  });
});

// ── Sweep integration over injected fakes ────────────────────────────────────

function ghFake({ prs, comments = { comments: [{ body: SCORECARD }] } } = {}) {
  return (cmd, args, opts, cb) => {
    if (args[0] === 'pr' && args[1] === 'list') return cb(null, JSON.stringify(prs), '');
    if (args[0] === 'pr' && args[1] === 'view') return cb(null, JSON.stringify(comments), '');
    return cb(new Error(`unexpected gh call: ${args.join(' ')}`), '', '');
  };
}

function makeHarness({ prs, streams, maxRounds = 3, userDataPath = null, ghImpl = null, skipTask = null } = {}) {
  const calls = [];
  const dispatchedEvents = [];
  const store = {
    getState: () => ({
      workspaces: [
        { id: 'ws1', name: 'Repo', path: '/repo', isRemote: false, isPersonal: false,
          tasks: [{ id: 't1', branch: 'feat/x', agent: 'claude', worktrees: [] }] },
        { id: 'ws-remote', name: 'Remote', path: '/r', isRemote: true, isPersonal: false, tasks: [] },
      ],
    }),
  };
  const client = {
    invoke: async (method) => {
      if (method === 'streamList') return { streams };
      throw new Error(`unexpected invoke: ${method}`);
    },
  };
  const watcher = createPrFixbackWatcher({
    store,
    client,
    userDataPath,
    maxRounds,
    execFileImpl: ghImpl || ghFake({ prs }),
    runFixbackImpl: async (_client, args) => { calls.push(args); return { ok: true }; },
    onDispatched: (info) => dispatchedEvents.push(info),
    skipTask,
    log: () => {},
  });
  return { watcher, calls, dispatchedEvents };
}

const FAILING_PR = {
  number: 7,
  title: 'feat x',
  url: 'https://x/pr/7',
  headRefName: 'feat/x',
  baseRefName: 'main',
  headRefOid: 'head-1',
  isDraft: false,
  statusCheckRollup: rollup({ failed: 1, ok: 1 }),
};
const IDLE_STREAM = { streamId: 's1', taskId: 't1', live: true, state: 'turn-complete' };

describe('createPrFixbackWatcher sweep', () => {
  it('dispatches a fixback into the owning task stream with the scorecard packet', async () => {
    const { watcher, calls, dispatchedEvents } = makeHarness({ prs: [FAILING_PR], streams: [IDLE_STREAM] });
    const result = await watcher.tick();
    expect(result.dispatched).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].row).toMatchObject({ streamId: 's1', taskId: 't1', workspaceId: 'ws1', branch: 'feat/x', workerAgent: 'claude' });
    expect(calls[0].packet.findings).toHaveLength(2);
    expect(calls[0].attempts).toBe(1);
    expect(calls[0].remaining).toBe(2);
    expect(dispatchedEvents[0]).toMatchObject({ prNumber: 7, taskId: 't1', headSha: 'head-1', attempts: 1 });
  });

  it('does not re-dispatch for the same failing head, and re-arms on a new failing head up to the cap', async () => {
    const { watcher, calls } = makeHarness({ prs: [FAILING_PR], streams: [IDLE_STREAM], maxRounds: 2 });
    await watcher.tick();
    await watcher.tick(); // same head — quiet
    expect(calls).toHaveLength(1);
    FAILING_PR.headRefOid = 'head-2';
    await watcher.tick(); // new failing head — round 2
    expect(calls).toHaveLength(2);
    FAILING_PR.headRefOid = 'head-3';
    await watcher.tick(); // cap (2) exhausted — parked
    expect(calls).toHaveLength(2);
    FAILING_PR.headRefOid = 'head-1';
  });

  it('skips drafts, green PRs, foreign branches, and busy streams', async () => {
    const green = { ...FAILING_PR, number: 8, statusCheckRollup: rollup({ ok: 2 }) };
    const draft = { ...FAILING_PR, number: 9, isDraft: true };
    const foreign = { ...FAILING_PR, number: 10, headRefName: 'not-a-task-branch' };
    const { watcher, calls } = makeHarness({
      prs: [green, draft, foreign, FAILING_PR],
      streams: [{ ...IDLE_STREAM, state: 'busy' }],
    });
    const result = await watcher.tick();
    expect(calls).toHaveLength(0);
    expect(result.dispatched).toHaveLength(0);
  });

  it('dispatches with no stream at all (runFixback respawns onto the task)', async () => {
    const { watcher, calls } = makeHarness({ prs: [FAILING_PR], streams: [] });
    await watcher.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].row.streamId).toBeUndefined();
    expect(calls[0].row.workerAgent).toBe('claude');
  });

  it('persists attempt state across watcher instances and prunes closed PRs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fixback-'));
    const first = makeHarness({ prs: [FAILING_PR], streams: [IDLE_STREAM], userDataPath: dir });
    await first.watcher.tick();
    expect(first.calls).toHaveLength(1);

    // A restarted watcher must remember the handled head.
    const second = makeHarness({ prs: [FAILING_PR], streams: [IDLE_STREAM], userDataPath: dir });
    await second.watcher.tick();
    expect(second.calls).toHaveLength(0);

    // Once the PR is gone its record is pruned, so a reused number starts fresh.
    const third = makeHarness({ prs: [], streams: [IDLE_STREAM], userDataPath: dir });
    await third.watcher.tick();
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.ace', 'pr-fixback-state.json'), 'utf8'));
    expect(state.entries).toEqual({});
  });

  it('degrades to a no-op when gh fails', async () => {
    const { watcher, calls } = makeHarness({
      prs: [FAILING_PR],
      streams: [IDLE_STREAM],
      ghImpl: (cmd, args, opts, cb) => cb(Object.assign(new Error('gh: not logged in'), { code: 4 }), '', ''),
    });
    const result = await watcher.tick();
    expect(calls).toHaveLength(0);
    expect(result.dispatched).toHaveLength(0);
  });
});

describe('spine ownership handoff', () => {
  it('skips spine-owned tasks entirely — the run-ledger closure loop is authoritative', async () => {
    const seen = [];
    const { watcher, calls } = makeHarness({
      prs: [FAILING_PR],
      streams: [IDLE_STREAM],
      skipTask: (info) => { seen.push(info); return true; },
    });
    const result = await watcher.tick();
    expect(result.dispatched).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: 't1', workspaceId: 'ws1', prNumber: 7 });
  });

  it('still drives non-spine tasks when the predicate declines', async () => {
    const { watcher, calls } = makeHarness({
      prs: [FAILING_PR],
      streams: [IDLE_STREAM],
      skipTask: () => false,
    });
    const result = await watcher.tick();
    expect(result.dispatched).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('spine ownership fail-closed', () => {
  it('a throwing ownership predicate SKIPS the tick — indeterminacy never double-dispatches', async () => {
    const { watcher, calls } = makeHarness({
      prs: [FAILING_PR],
      streams: [IDLE_STREAM],
      skipTask: () => { throw new Error('harness not ready'); },
    });
    const result = await watcher.tick();
    expect(result.dispatched).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('spine ownership lazy initialization', () => {
  it('a lazily-initializing predicate classifies on the FIRST tick — fresh boots never suppress non-spine fixbacks', async () => {
    // Mirrors the ace-control wiring: the predicate ensures the harness itself
    // (sync, idempotent) and then classifies, instead of throwing while lazy
    // init has simply not happened yet.
    let harness = null;
    const ensureHarness = () => { if (!harness) harness = { ready: true }; return harness; };
    const { watcher, calls } = makeHarness({
      prs: [FAILING_PR],
      streams: [IDLE_STREAM],
      skipTask: () => {
        if (!ensureHarness()) throw new Error('unavailable');
        return false; // classified: not spine-owned
      },
    });
    const result = await watcher.tick();
    expect(result.dispatched).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(harness).not.toBeNull();
  });
});
