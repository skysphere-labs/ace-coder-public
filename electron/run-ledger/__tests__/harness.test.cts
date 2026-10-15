// harness.test — the ONE composition closes the autonomy loop over the ledger,
// and the lean board is a pure read over the SAME events (the loop never reads
// the board). Synchronous mock effects let one runToQuiescence walk a run from
// intake to terminal; an async effect pauses the loop for the Ring-2 observer.
const test = require('node:test');
const assert = require('node:assert');

const { createRunLedgerHarness } = require('../harness.cts');

// Synchronous effects: the worker returns its completion immediately, so the
// loop can close end-to-end in a single runToQuiescence (no real agents). The
// read-only gate opens/observes the PR and emits current-head review evidence;
// only then does release merge and clean up. The head sha is held constant.
function syncEffects() {
  return {
    dispatchWorker: async () => ({ outcome: 'DONE', currentHeadSha: 's1', telemetry: { agent: 'rook', commands: ['npm test'], tokens: 5000 } }),
    gatePr: async () => ({
      event: {
        type: 'gate.evaluated',
        payload: {
          prExists: true,
          checkState: 'success',
          mergeable: 'MERGEABLE',
          headSha: 's1',
          validation: { self: 'PASS', headSha: 's1' },
          reviewBot: { name: 'validate', state: 'success', headSha: 's1' },
        },
      },
    }),
    release: async () => ({ event: { type: 'merged', payload: { sha: 'm1', cleanedUp: true, headSha: 's1' } } }),
  };
}

test('the loop closes: intake -> worker -> gate(review) -> release(merge) -> terminal without a validator', async () => {
  const h = createRunLedgerHarness({ effects: syncEffects() });
  const runId = h.submit({ runId: 'feat-1', goal: 'no-code smoke diagnostic', taskType: 'no-code', roleMode: 'no-code', driver: 'rook' });
  const steps = await h.runToQuiescence(runId);

  const ran = steps.map((s: any) => s.ran).filter(Boolean);
  assert.deepEqual(ran, ['dispatchWorker', 'gatePr', 'release']);
  // 3 driver steps + 1 terminal NOTHING step (reconcile finds no driver, breaks).
  assert.equal(steps.length, 4);
  // Final reconcile is the terminal NOTHING (merged + cleaned up).
  const last = steps[steps.length - 1];
  assert.equal(last.next, 'nothing');
  assert.equal(last.ran, null);
});

test('the lean board reads the SAME events the loop wrote — the run lands in done', async () => {
  const h = createRunLedgerHarness({ effects: syncEffects() });
  const runId = h.submit({ runId: 'feat-2', goal: 'no-code smoke diagnostic', taskType: 'no-code', roleMode: 'no-code', driver: 'rook' });
  await h.runToQuiescence(runId);

  const board = h.board();
  assert.equal(board.counts.done, 1);
  assert.deepEqual(board.columns.done, ['feat-2']);
  const card = board.cards.find((c: any) => c.id === 'feat-2');
  assert.equal(card.stage, 'done');
  // Telemetry the worker effect wrote rode through into the card (watcher folded
  // it for free).
  assert.equal(card.telemetry.agent, 'rook');
  assert.equal(card.telemetry.tokens, 5000);
  assert.equal(card.agentId, 'rook');
});

test('an async dispatch that LINKS pauses the loop in progress (Ring 2 re-arms it)', async () => {
  // A real fire-and-forget dispatch appends its worker.dispatch.linked proof
  // synchronously (the live spine-effects recipe) and returns null — the
  // completion arrives later via Ring 2. The kernel sees the linkage proof, so
  // the run is genuinely in flight and the board shows it in_progress WITH a
  // linked stream/task/worktree (never floating with null links).
  const h = createRunLedgerHarness({ effects: { dispatchWorker: async ({ runId, ledger }: any) => {
    ledger.append({ runId, type: 'worker.dispatch.linked', payload: { taskId: 'tsk', streamId: 'conversation:str', worktreePath: '/tmp/wt-3' } });
    return null;
  } } });
  const runId = h.submit({ runId: 'feat-3', goal: 'Async', driver: 'codex', scope: { workspaceId: 'prj-async' } });
  const steps = await h.runToQuiescence(runId);

  // One dispatch step, then a pause (no synchronous completion to fold).
  assert.equal(steps.length, 1);
  assert.equal(steps[0].ran, 'dispatchWorker');
  assert.equal(steps[0].ok, true);
  // The run is mid-flight: the board shows it in progress, not done — AND carries
  // the linked stream/task/worktree + workspaceId (A2: no floating card).
  const board = h.board();
  assert.equal(board.counts.inProgress, 1);
  assert.deepEqual(board.columns.in_progress, ['feat-3']);
  const card = board.cards.find((c: any) => c.id === 'feat-3');
  assert.equal(card.workspaceId, 'prj-async', 'card carries workspaceId from the intent scope');
  assert.equal(card.detail.worker.taskId, 'tsk');
  assert.equal(card.detail.worker.streamId, 'conversation:str');
  assert.equal(card.detail.worker.worktreePath, '/tmp/wt-3');
  assert.equal(card.detail.worker.workspaceId, 'prj-async');
});

test('an async dispatch that does NOT link FAILS CLOSED: no phantom worker.dispatched left floating', async () => {
  // The brief's exact bad shape: dispatchWorker returns without throwing AND
  // without creating/linking a stream (a dry/no-op effect). The kernel must fail
  // closed — record worker.dispatch.failed — never leave the run floating
  // in_progress with a lone worker.dispatched marker and null linkage.
  const h = createRunLedgerHarness({ effects: { dispatchWorker: async () => null } });
  const runId = h.submit({ runId: 'feat-phantom', goal: 'No link', driver: 'codex' });
  const steps = await h.runToQuiescence(runId);
  const last = steps[steps.length - 1];
  assert.equal(last.ok, false, 'a no-link dispatch fails closed');
  assert.match(String(last.error), /no linked stream\/task\/worktree/);

  const types = h.ledger.readRun(runId).map((e: any) => e.type);
  assert.ok(types.includes('worker.dispatched'), 'durable-first marker is recorded');
  assert.ok(types.includes('worker.dispatch.failed'), 'a no-link dispatch records the fail-closed counterpart');
  // A3: the resting event is never a lone worker.dispatched with null linkage.
  assert.equal(types[types.length - 1], 'worker.dispatch.failed');

  const board = h.board();
  assert.equal(board.counts.inProgress, 0, 'the phantom never shows as a healthy in-flight worker');
  assert.equal(board.counts.blocked, 1, 'a no-link dispatch lands in the blocked column');
  const card = board.cards.find((c: any) => c.id === 'feat-phantom');
  assert.equal(card.stage, 'blocked');
  assert.equal(card.detail.worker.taskId, null, 'no phantom task link');
  assert.equal(card.detail.worker.streamId, null, 'no phantom stream link');
  assert.match(String(card.detail.worker.dispatchError), /no linked stream/i);
});

test('a throwing dispatch FAILS CLOSED: records worker.dispatch.failed and blocks with the exact error', async () => {
  const h = createRunLedgerHarness({ effects: { dispatchWorker: async () => { throw new Error('spawn failed: no stream'); } } });
  const runId = h.submit({ runId: 'feat-4', goal: 'Boom', driver: 'rook' });
  const steps = await h.runToQuiescence(runId);
  const lastStep = steps[steps.length - 1];
  assert.equal(lastStep.ok, false);
  assert.match(String(lastStep.error), /spawn failed: no stream/);

  // The durable marker is on the ledger, but so is the FAIL-CLOSED counterpart
  // carrying the exact error — no phantom "dispatched" left standing alone.
  const events = h.ledger.readRun('feat-4');
  const types = events.map((e: any) => e.type);
  assert.ok(types.includes('worker.dispatched'), 'durable-first marker is recorded');
  const failed = events.find((e: any) => e.type === 'worker.dispatch.failed');
  assert.ok(failed, 'a worker.dispatch.failed event is recorded on the driver throw');
  assert.match(String(failed.payload.error), /spawn failed: no stream/);

  // The board reports the run BLOCKED with the exact spawn error — never a
  // healthy in-flight worker. The link fields stay null (nothing was linked).
  const board = h.board();
  assert.equal(board.counts.blocked, 1, 'a failed dispatch lands in the blocked column');
  assert.deepEqual(board.columns.blocked, ['feat-4']);
  const card = board.cards.find((c: any) => c.id === 'feat-4');
  assert.equal(card.stage, 'blocked');
  assert.equal(card.blocked, true);
  assert.match(String(card.detail.decision.reason), /worker dispatch failed/);
  assert.match(String(card.detail.worker.dispatchError), /spawn failed: no stream/);
  assert.equal(card.detail.worker.taskId, null, 'no phantom task link on a failed dispatch');
  assert.equal(card.detail.worker.streamId, null, 'no phantom stream link on a failed dispatch');
  assert.equal(card.detail.worker.worktreePath, null, 'no phantom worktree link on a failed dispatch');
});

test('a recovered re-dispatch after a failure clears the blocked state', async () => {
  // First dispatch throws; a fresh dispatch marker + link must supersede the
  // failure so the run is not stuck blocked once it actually lands.
  const h = createRunLedgerHarness({ effects: { dispatchWorker: async () => null } });
  const runId = h.submit({ runId: 'feat-5', goal: 'Retry', driver: 'rook' });
  // Simulate the first attempt failing, then a real re-dispatch that links.
  h.ledger.append({ runId, type: 'worker.dispatch.failed', payload: { error: 'transient spawn error' } });
  let board = h.board();
  assert.equal(board.cards.find((c: any) => c.id === 'feat-5').stage, 'blocked');
  h.ledger.append({ runId, type: 'worker.dispatched', payload: {} });
  h.ledger.append({ runId, type: 'worker.dispatch.linked', payload: { taskId: 'tsk_r', streamId: 'str_r', worktreePath: '/tmp/wt-r' } });
  board = h.board();
  const card = board.cards.find((c: any) => c.id === 'feat-5');
  assert.notEqual(card.stage, 'blocked', 'a successful re-dispatch clears the failure');
  assert.equal(card.detail.worker.taskId, 'tsk_r');
  assert.equal(card.detail.worker.dispatchError, null);
});
