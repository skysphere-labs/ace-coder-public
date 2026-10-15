// pulse-wiring — the Ring-2 → pulse chain exactly as ace-control/index.cts
// wires it: a real completion record becomes a kernel event, the harness records
// it, the autonomy loop advances the run, and the watcher board surfaces an
// agent-keyed, telemetry-folded card. This is the live "give it a pulse" path,
// minus the electron shell (the controller calls these same three lines).

const test = require('node:test');
const assert = require('node:assert/strict');

let harnessMod: any;
try { harnessMod = require('../harness.cts'); } catch { harnessMod = require('../harness.cjs'); }
let fcMod: any;
try { fcMod = require('../from-completion.cts'); } catch { fcMod = require('../from-completion.cjs'); }
const { createRunLedgerHarness } = harnessMod;
const { fromCompletion } = fcMod;

// Mirrors observeCompletions:
//   const evt = fromCompletion(record);
//   harness.kernel.recordEvent(evt);
//   harness.runToQuiescence(evt.runId)   // armed under ACE_AUTO_RALLY
test('pulse wiring: a worker completion drives the loop and surfaces an agent-keyed card', async () => {
  // memory ledger. The pulse advances a worker-DONE run to the validator dispatch;
  // give it a linking effect (the real spine-effects append validator.dispatch.
  // linked synchronously) so the dispatch is genuine — a dry/no-op validator would
  // now correctly FAIL CLOSED (no linked stream), which is not this test's subject.
  const h = createRunLedgerHarness({
    effects: {
      runValidation: ({ runId, ledger }: any) => {
        ledger.append({ runId, type: 'validator.dispatch.linked', payload: { taskId: 'v-tsk', streamId: 'v-stream' } });
        return null;
      },
    },
  });

  const record = {
    taskId: 'tsk-1',
    laneId: 'ft-pulse',
    kind: 'done',
    detail: 'DONE: implemented the thing',
    streamId: 'stream:var-1',
    agent: 'rook',
    telemetry: { runs: 1, commands: 3, durationMs: 1200, tokens: 64 },
  };

  const evt = fromCompletion(record);
  assert.equal(evt.runId, 'ft-pulse');
  assert.equal(evt.type, 'worker.completed');
  assert.equal(evt.payload.outcome, 'DONE');

  h.kernel.recordEvent(evt);
  // The pulse: drive the run forward. The worker is DONE, so the loop dispatches
  // the validator (which links via the injected effect) and then pauses for the
  // Ring-2 verdict — the loop returns its steps and never throws.
  const steps = await h.runToQuiescence(evt.runId);
  assert.ok(Array.isArray(steps) && steps.length >= 1, 'runToQuiescence ran the loop');
  assert.ok(steps.every((s: any) => s.ok !== false), 'no driver threw');

  const board = h.board();
  const card = board.cards.find((c: any) => c.id === 'ft-pulse');
  assert.ok(card, 'the completed run surfaces as a watcher card');
  assert.equal(card.agentId, 'rook'); // keyed by the working agent
  assert.equal(card.key, 'rook/ft-pulse'); // agent-surfaced display key, runId stays lifecycle key
  assert.equal(card.workerOutcome, 'DONE');
  assert.ok(card.telemetry, 'agent-written telemetry folded onto the card');
  assert.equal(card.telemetry.agent, 'rook');
});

// Gated-OFF invariant: with ACE_AUTO_RALLY unset the controller records the
// completion but never calls runToQuiescence. Sensing + projection alone must
// still surface the card — the board is a watcher independent of the loop.
test('pulse wiring: sensing-only (no drive) still surfaces the completion to the watcher', async () => {
  const h = createRunLedgerHarness();

  const evt = fromCompletion({
    taskId: 'tsk-2',
    laneId: 'ft-sense',
    kind: 'blocked',
    detail: 'BLOCKED: needs owner decision',
    agent: 'king',
    telemetry: { runs: 1, commands: 1, durationMs: 200, tokens: 8 },
  });
  assert.equal(evt.type, 'worker.completed');
  assert.equal(evt.payload.outcome, 'BLOCKED');

  h.kernel.recordEvent(evt); // NO runToQuiescence — mirrors AUTO_RALLY unset

  const board = h.board();
  const card = board.cards.find((c: any) => c.id === 'ft-sense');
  assert.ok(card, 'a blocked completion is visible to the watcher without the loop');
  assert.equal(card.agentId, 'king'); // agent-keyed from the telemetry it self-reported
});
