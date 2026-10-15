// board-projection.test — proves the LEAN board: spine projection panels map to
// lifecycle columns, each run lands in exactly one column, and lean cards carry
// the descriptive fields (name/mission/assignee/branch) from the intake spec.
const test = require('node:test');
const assert = require('node:assert');

const { createMemoryEventLog } = require('../event-ledger.cts');
const { projectLeanBoard, PANEL_STAGE } = require('../board-projection.cts');

function passRecord() {
  return { detail: 'DONE: VERDICT=PASS on https://github.com/x/y/pull/1 {"verdict":"pass"}' };
}

function seed(log: any, runId: string, spec: any, steps: any[]) {
  log.append({ runId, type: 'run.created', payload: { spec } });
  for (const s of steps) log.append({ runId, type: s.type, payload: s.payload || {} });
}

function build() {
  const log = createMemoryEventLog();
  seed(log, 'feat-todo', { goal: 'Add a toggle', missionId: 'm1', workspaceId: 'w1', driver: 'codex', branch: 'feat/toggle' }, []);
  seed(log, 'feat-prog', { goal: 'Build API', missionId: 'm1', driver: 'claude' }, [
    { type: 'worker.dispatched' },
    { type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 's1' } },
  ]);
  seed(log, 'feat-ready', { goal: 'Ship it', missionId: 'm1' }, [
    { type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 's2' } },
    { type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 's2' } },
  ]);
  seed(log, 'feat-blocked', { goal: 'Hard one' }, [
    { type: 'worker.completed', payload: { outcome: 'BLOCKED' } },
  ]);
  return projectLeanBoard(log);
}

test('runs auto-bucket into the right lifecycle columns', () => {
  const b = build();
  assert.deepEqual(b.columns.todo, ['feat-todo']);
  assert.deepEqual(b.columns.in_progress, []);
  assert.deepEqual(b.columns.ready_to_review, ['feat-prog', 'feat-ready']);
  assert.deepEqual(b.columns.blocked, ['feat-blocked']);
  // 'done' = the spine's terminal NOTHING state (merged + cleaned), which is
  // only reached through the real merge pipeline — the recent panel maps to it.
  assert.equal(PANEL_STAGE.recent, 'done');
});

test('lean cards carry descriptive fields from the intake spec', () => {
  const b = build();
  const todo = b.cards.find((c: any) => c.id === 'feat-todo');
  assert.equal(todo.name, 'Add a toggle');
  assert.equal(todo.missionId, 'm1');
  assert.equal(todo.workspaceId, 'w1');
  assert.equal(todo.assignee, 'codex');
  assert.equal(todo.branch, 'feat/toggle');
  assert.equal(todo.stage, 'todo');
  const blocked = b.cards.find((c: any) => c.id === 'feat-blocked');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.stage, 'blocked');
});

test('lean card names derive concise titles from ugly run goals', () => {
  const log = createMemoryEventLog();
  seed(log, 'feat-noisy', {
    label: 'codex',
    agent: 'codex',
    goal: '/goal Read and execute /workspace/wiki/ace-ops/live-tracks/ace-better-worktree-branch-titles-2026-06-19.md. Fix future task/run display titles, branch names, worktree dirs, and safe stream labels to use concise human titles, not raw prompt boilerplate. Done when: A1 passes.',
  }, []);
  const card = projectLeanBoard(log).cards.find((c: any) => c.id === 'feat-noisy');
  assert.equal(card.name, 'Fix future task run display titles branch names worktree dirs');
  assert.doesNotMatch(card.name, /\/goal|Users|Done when|codex/i);
});

// A run that walks the FULL lifecycle and lands in `done` via a real merge —
// proves the stage transitions register all the way through (todo→…→done), not
// just the early columns.
function mergedBoard() {
  const log = createMemoryEventLog();
  seed(log, 'feat-done', { goal: 'Ship the flag', workspaceId: 'w-acme' }, [
    { type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 's3' } },
    { type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 's3' } },
    { type: 'gate.evaluated', payload: { prExists: true, mergeable: 'MERGEABLE', checkState: 'success', headSha: 's3', prNumber: 7, prUrl: 'https://x/pr/7' } },
    { type: 'merged', payload: { sha: 'merged_sha', headSha: 's3', cleanedUp: true } },
  ]);
  return projectLeanBoard(log);
}

test('a fully-merged run registers in the done column', () => {
  const b = mergedBoard();
  assert.deepEqual(b.columns.done, ['feat-done'], 'merged + cleaned run lands in done');
  const done = b.cards.find((c: any) => c.id === 'feat-done');
  assert.equal(done.stage, 'done');
  assert.equal(done.detail.merge.merged, true);
  assert.equal(done.detail.merge.sha, 'merged_sha');
});

test('autoship status is visible on ready cards', () => {
  const log = createMemoryEventLog();
  seed(log, 'feat-autoship', { goal: 'Autoship the safe fix', autoShip: { enabled: true, autoMerge: true }, scope: { allow: ['src/'] } }, [
    { type: 'worker.dispatch.linked', payload: { taskId: 'tsk_auto', branch: 'feat/autoship', worktreePath: '/tmp/wt-auto' } },
    { type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'abc123abc123' } },
    { type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 'abc123abc123' } },
    {
      type: 'gate.evaluated',
      payload: {
        prExists: true,
        prState: 'OPEN',
        mergeable: 'MERGEABLE',
        checkState: 'success',
        headSha: 'abc123abc123',
        changedFiles: ['src/a.ts'],
        allowedPaths: ['src/'],
        validation: { independent: 'PASS', required: true },
      },
    },
  ]);
  const card = projectLeanBoard(log).cards.find((c: any) => c.id === 'feat-autoship');
  assert.equal(card.autoshipStatus, 'ready_to_autoship');
  assert.equal(card.detail.autoship.autoMergeAllowed, true);
  assert.equal(card.detail.autoship.requiresOwnerApproval, false);
});

// The rich detail every card now carries — folded for free from the same
// reconcile. Proves the JIRA-style ticket body (what it's about, worker link,
// validator result) is populated from real events without copying raw ledger
// event history into each card.
function richBoard() {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-rich', type: 'run.created', payload: { spec: {
    goal: 'Add a --version flag', context: 'Hermes intake brief: ship a version flag.', workspaceId: 'w-acme',
    driver: 'codex', branch: 'feat/version',
    acceptance: [{ id: 'A1', text: 'ace --version prints the version' }],
    constraints: ['stay surgical — touch only the flag parser'],
  } } });
  log.append({ runId: 'feat-rich', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w', streamId: 'str_w', branch: 'feat/version', worktreePath: '/wt/version' } });
  log.append({ runId: 'feat-rich', type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 's1', telemetry: { agent: 'codex', commands: ['edit', 'run'], durationMs: 4200, tokens: 1800 } } });
  log.append({ runId: 'feat-rich', type: 'validator.dispatch.linked', payload: { taskId: 'tsk_v', streamId: 'str_v' } });
  log.append({ runId: 'feat-rich', type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 's1', telemetry: { agent: 'codex', rubric: 'computer-use', score: 1 } } });
  return projectLeanBoard(log);
}

test('cards carry rich detail: description, worker link, validator result', () => {
  const card = richBoard().cards.find((c: any) => c.id === 'feat-rich');
  const d = card.detail;
  // What the ticket is about.
  assert.equal(d.description, 'Add a --version flag');
  assert.equal(d.context, 'Hermes intake brief: ship a version flag.');
  assert.deepEqual(d.acceptance, ['ace --version prints the version'], 'acceptance coerced from {text} rows');
  assert.deepEqual(d.constraints, ['stay surgical — touch only the flag parser']);
  // Link to the worker the brain spawned.
  assert.equal(d.worker.taskId, 'tsk_w');
  assert.equal(d.worker.streamId, 'str_w');
  assert.equal(d.worker.worktreePath, '/wt/version');
  assert.equal(d.worker.outcome, 'DONE');
  // The codex validator + its verdict.
  assert.equal(d.validator.streamId, 'str_v');
  assert.equal(d.validator.outcome, 'PASS');
  assert.equal('timeline' in d, false, 'card detail omits per-event history from the board payload');
});

test('Skysphere cards surface opaque binding plus exact current/validated heads for proof writeback', () => {
  const log = createMemoryEventLog();
  const binding = {
    connectionId: 'sky-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    origin: 'https://sky.example.test',
    workspaceSlug: 'skyslab',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    issueId: '44444444-4444-4444-8444-444444444444',
    ticketKey: 'SKY-142',
  };
  log.append({ runId: 'run-sky', type: 'run.created', payload: { spec: {
    goal: 'SKY-142', skysphereRef: 'skysphere:v1:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444',
    skysphere: binding,
  } } });
  log.append({ runId: 'run-sky', type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'abc123' } });
  log.append({ runId: 'run-sky', type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 'abc123' } });
  const card = projectLeanBoard(log).cards.find((item: any) => item.id === 'run-sky');
  assert.equal(card.skysphereRef.includes('skysphere:v1:'), true);
  assert.deepEqual(card.skysphere, binding);
  assert.equal(card.currentHeadSha, 'abc123');
  assert.equal(card.validatedHeadSha, 'abc123');
});

test('projectLeanBoard snapshots the ledger once instead of reparsing for every card', () => {
  const log = createMemoryEventLog();
  seed(log, 'feat-one', { goal: 'One' }, []);
  seed(log, 'feat-two', { goal: 'Two' }, [{ type: 'worker.dispatched' }]);
  let readAllCount = 0;
  let readRunCount = 0;
  const wrapped = {
    readAll: () => {
      readAllCount += 1;
      return log.readAll();
    },
    readRun: (runId: string) => {
      readRunCount += 1;
      return log.readRun(runId);
    },
  };

  const board = projectLeanBoard(wrapped);

  assert.equal(board.counts.total, 2);
  assert.equal(readAllCount, 1, 'the file-backed ledger is read once per board projection');
  assert.equal(readRunCount, 0, 'per-card details use the in-memory projection snapshot');
});

test('A2 stream attachment: a linked run carries workspaceId (from scope) + worker stream/task/worktree', () => {
  // The spine intent stores the workspace under scope.workspaceId (not top-level),
  // and the dispatch link carries the same stream/task/worktree that `ace ls`
  // shows. The board card + detail must surface both so an operator never sees a
  // board row without its stream.
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-linked', type: 'run.created', payload: { spec: { goal: 'Wire it', scope: { workspaceId: 'prj-xyz' } } } });
  log.append({ runId: 'feat-linked', type: 'worker.dispatched', payload: {} });
  log.append({ runId: 'feat-linked', type: 'worker.dispatch.linked', payload: { workspaceId: 'prj-xyz', taskId: 'tsk_l', streamId: 'conversation:abc', branch: 'feat/x', worktreePath: '/wt/x' } });
  const b = projectLeanBoard(log);
  const card = b.cards.find((c: any) => c.id === 'feat-linked');
  assert.equal(card.stage, 'in_progress', 'a linked, in-flight worker is in progress');
  assert.equal(card.workspaceId, 'prj-xyz', 'card workspaceId resolves from the intent scope');
  assert.equal(card.branch, 'feat/x');
  assert.equal(card.detail.worker.workspaceId, 'prj-xyz');
  assert.equal(card.detail.worker.taskId, 'tsk_l');
  assert.equal(card.detail.worker.streamId, 'conversation:abc');
  assert.equal(card.detail.worker.worktreePath, '/wt/x');
  assert.equal(card.detail.worker.branch, 'feat/x');
  assert.equal(card.detail.worker.dispatchError, null, 'a linked worker has no dispatch error');
});

test('every run appears in exactly one column; counts add up', () => {
  const b = build();
  const ids = Object.values(b.columns).flat();
  assert.equal(ids.length, new Set(ids).size, 'no run duplicated across columns');
  assert.equal(b.counts.total, b.cards.length);
  assert.equal(b.counts.total, 4);
  assert.equal(
    b.counts.todo + b.counts.inProgress + b.counts.readyToReview + b.counts.done + b.counts.blocked,
    b.counts.total,
  );
});

// --- AUTO-COLLECTED lifecycle (timeline / age / last transition) ------------
// Every file-ledger event carries a harness-stamped ts; the reconciler folds
// them into a descriptive timeline and the card derives age/idle/duration from
// an INJECTED now — omitted (null) when no clock is passed, so the projection
// stays deterministic.

test('cards carry the auto-collected timeline, lastTransition, and durations from event ts stamps', () => {
  const log = createMemoryEventLog();
  const t0 = 1_000_000;
  log.append({ runId: 'run-tl', ts: t0, type: 'run.created', payload: { spec: { goal: 'Timeline me' } } });
  log.append({ runId: 'run-tl', ts: t0 + 1_000, type: 'worker.dispatched', payload: {} });
  log.append({ runId: 'run-tl', ts: t0 + 2_000, type: 'worker.dispatch.linked', payload: { taskId: 'tsk-tl', streamId: 'str-tl' } });
  log.append({ runId: 'run-tl', ts: t0 + 62_000, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 's1' } });

  const now = t0 + 100_000;
  const board = projectLeanBoard(log, { now });
  const card = board.cards.find((c: any) => c.id === 'run-tl');

  assert.equal(card.timeline.createdAt, t0);
  assert.equal(card.timeline.dispatchedAt, t0 + 1_000);
  assert.equal(card.timeline.linkedAt, t0 + 2_000);
  assert.equal(card.timeline.workerCompletedAt, t0 + 62_000);
  assert.equal(card.timeline.lastTs, t0 + 62_000);
  assert.equal(card.lastTs, t0 + 62_000);
  assert.deepEqual(card.lastTransition, { type: 'worker.completed', ts: t0 + 62_000 });
  assert.equal(card.ageMs, 100_000, 'age = now - createdAt');
  assert.equal(card.idleMs, 38_000, 'idle = now - lastTs');
  assert.equal(card.durationMs, 60_000, 'work duration = linked -> worker.completed');
});

test('without an injected now the card omits relative ages (deterministic projection)', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'run-det', ts: 500, type: 'run.created', payload: { spec: { goal: 'No clock' } } });
  const card = projectLeanBoard(log).cards.find((c: any) => c.id === 'run-det');
  assert.equal(card.ageMs, null);
  assert.equal(card.idleMs, null);
  assert.equal(card.timeline.createdAt, 500, 'absolute timestamps still fold');
  const again = projectLeanBoard(log).cards.find((c: any) => c.id === 'run-det');
  assert.deepEqual(again, card, 'projection without a clock is fully deterministic');
});

test('ts-less events (legacy ledgers) degrade gracefully: null timeline, null ages, no throw', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'run-legacy', type: 'run.created', payload: { spec: { goal: 'Old events' } } });
  const card = projectLeanBoard(log, { now: 123_456 }).cards.find((c: any) => c.id === 'run-legacy');
  assert.equal(card.timeline.createdAt, null);
  assert.equal(card.ageMs, null);
  assert.equal(card.idleMs, null);
  assert.equal(card.durationMs, null);
});

test('an auto-iterate run carries the loop lineage on its card; a normal run does not', () => {
  const log = createMemoryEventLog();
  // A normal (non-loop) run.
  seed(log, 'run-norm', { goal: 'plain run', workspaceId: 'w1' }, []);
  // An auto-iterate cycle-2 run with a recorded settle decision.
  seed(log, 'run-loop2', {
    goal: 'iterate the panel', workspaceId: 'w1',
    autoIterate: true, iteration: 2, maxIterations: 5, loopLineageId: 'run-loop1', parentRunId: 'run-loop1',
  }, [
    { type: 'next-goal.derived', payload: { loopLineageId: 'run-loop1', parentRunId: 'run-loop2', iteration: 2, terminal: 'continue', signature: 'abc', followups: ['gap x', 'gap y'], computerUseEvidence: true } },
  ]);
  const b = projectLeanBoard(log);
  const norm = b.cards.find((c: any) => c.id === 'run-norm');
  const loop = b.cards.find((c: any) => c.id === 'run-loop2');
  assert.equal(norm.loop, null, 'a non-loop run has no loop lineage');
  assert.ok(loop.loop, 'an auto-iterate run carries a loop lineage');
  assert.equal(loop.loop.lineageId, 'run-loop1');
  assert.equal(loop.loop.iteration, 2);
  assert.equal(loop.loop.maxIterations, 5);
  assert.equal(loop.loop.terminal, 'continue');
  assert.equal(loop.loop.gaps, 2);
  assert.equal(loop.loop.computerUseEvidence, true);
});

// Card age + the drawer's transition trail — the board's Archived split and the
// ticket drawer's History section both fold from these. Neutral fixture paths
// only (de-personalization gate).
test('cards carry lastTs from the run\'s newest ledger event; missing ts degrades to null', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-aged', type: 'run.created', ts: 1000, payload: { spec: { goal: 'Age me' } } });
  log.append({ runId: 'feat-aged', type: 'worker.dispatched', ts: 2000, payload: {} });
  // A second run whose events carry no ts at all.
  seed(log, 'feat-no-clock', { goal: 'No clock' }, []);
  const b = projectLeanBoard(log);
  const aged = b.cards.find((c: any) => c.id === 'feat-aged');
  assert.equal(aged.lastTs, 2000, 'lastTs is the ts of the newest event for the run');
  const noClock = b.cards.find((c: any) => c.id === 'feat-no-clock');
  assert.equal(noClock.lastTs, null, 'no usable ts folds to null, never NaN/undefined');
});

test('detail history: lifecycle {type, ts} pairs only, capped at 30, newest last', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-hist', type: 'run.created', ts: 1, payload: { spec: { goal: 'Trace me', workspaceId: 'w1' } } });
  // Non-lifecycle noise must NOT appear in the trail.
  log.append({ runId: 'feat-hist', type: 'next-goal.derived', ts: 2, payload: { parentRunId: 'feat-other' } });
  log.append({ runId: 'feat-hist', type: 'worker.completed', ts: 3, payload: { outcome: 'DONE', currentHeadSha: 's9' } });
  log.append({ runId: 'feat-hist', type: 'validator.completed', ts: 4, payload: { record: passRecord(), validatedHeadSha: 's9' } });
  // A storm of repeated gate polls — the cap keeps the payload lean.
  for (let i = 0; i < 40; i += 1) {
    log.append({ runId: 'feat-hist', type: 'gate.evaluated', ts: 10 + i, payload: { prExists: true, mergeable: 'MERGEABLE', checkState: 'pending', headSha: 's9' } });
  }
  log.append({ runId: 'feat-hist', type: 'merged', ts: 99, payload: { sha: 'sha_m', headSha: 's9', cleanedUp: true } });
  const card = projectLeanBoard(log).cards.find((c: any) => c.id === 'feat-hist');
  const hist = card.detail.history;
  assert.equal(hist.length, 30, 'history is capped');
  assert.deepEqual(hist[hist.length - 1], { type: 'merged', ts: 99 }, 'newest event is last');
  assert.ok(!hist.some((h: any) => h.type === 'next-goal.derived'), 'non-lifecycle noise is excluded');
  for (const h of hist) {
    assert.deepEqual(Object.keys(h).sort(), ['ts', 'type'], 'entries carry type+ts only, never payloads');
  }
});

test('history entries without a ts fold to ts null (memory-log events may be unstamped)', () => {
  const log = createMemoryEventLog();
  seed(log, 'feat-unstamped', { goal: 'Unstamped' }, [{ type: 'worker.dispatched' }]);
  const card = projectLeanBoard(log).cards.find((c: any) => c.id === 'feat-unstamped');
  assert.ok(card.detail.history.length >= 2, 'run.created + worker.dispatched are lifecycle events');
  for (const h of card.detail.history) assert.equal(h.ts, null);
});
