// drivers.test — the Ring-1 effect plugs translate an injected effect's result
// into the event the kernel appends, and pause (return null) for async dispatches
// whose completion arrives later via the Ring-2 observer.
const test = require('node:test');
const assert = require('node:assert');

const { createDrivers } = require('../drivers.cts');

const CTX = { runId: 'r1', state: { spec: { goal: 'x' } }, decision: { next: 'dispatch_goal_worker' } };

test('dispatchWorker maps a synchronous outcome to a worker.completed event', async () => {
  const drivers = createDrivers({
    dispatchWorker: async () => ({ outcome: 'DONE', currentHeadSha: 's1', telemetry: { agent: 'rook', tokens: 10 } }),
  });
  const ev = await drivers.dispatchWorker(CTX);
  assert.equal(ev.type, 'worker.completed');
  assert.equal(ev.payload.outcome, 'DONE');
  assert.equal(ev.payload.telemetry.agent, 'rook');
});

test('an async dispatch (effect returns nothing) yields null — Ring 2 appends the completion', async () => {
  const drivers = createDrivers({ dispatchWorker: async () => null });
  assert.equal(await drivers.dispatchWorker(CTX), null);
});

test('dispatchFixback falls back to dispatchWorker when no fixback effect is given', async () => {
  let called = false;
  const drivers = createDrivers({ dispatchWorker: async () => { called = true; return { outcome: 'DONE' }; } });
  const ev = await drivers.dispatchFixback(CTX);
  assert.equal(called, true);
  assert.equal(ev.type, 'worker.completed');
});

test('runValidation maps to a validator.completed event carrying the verdict record', async () => {
  const drivers = createDrivers({
    runValidation: async () => ({ record: { detail: 'VERDICT=PASS' }, validatedHeadSha: 's1' }),
  });
  const ev = await drivers.runValidation(CTX);
  assert.equal(ev.type, 'validator.completed');
  assert.equal(ev.payload.record.detail, 'VERDICT=PASS');
});

test('gatePr always emits a gate.evaluated event of the PR facts (the fold re-runs the spine gate)', async () => {
  const drivers = createDrivers({ gatePr: async () => ({ tracked: true, checkState: 'success', mergeable: true }) });
  const ev = await drivers.gatePr(CTX);
  assert.equal(ev.type, 'gate.evaluated');
  assert.equal(ev.payload.checkState, 'success');
});

test('release maps a merge result to a merged event; an empty merge yields null', async () => {
  const merged = await createDrivers({ release: async () => ({ sha: 'm1', cleanedUp: true, headSha: 's1' }) }).release(CTX);
  assert.equal(merged.type, 'merged');
  assert.equal(merged.payload.cleanedUp, true);
  const none = await createDrivers({ release: async () => ({}) }).release(CTX);
  assert.equal(none, null);
});

test('an effect may hand back a ready-made { event } which passes through verbatim', async () => {
  const drivers = createDrivers({ dispatchWorker: async () => ({ event: { type: 'worker.completed', payload: { outcome: 'BLOCKED' } } }) });
  const ev = await drivers.dispatchWorker(CTX);
  assert.equal(ev.payload.outcome, 'BLOCKED');
});

test('missing effects are safe no-ops (null), never throw', async () => {
  const drivers = createDrivers();
  assert.equal(await drivers.dispatchWorker(CTX), null);
  assert.equal(await drivers.runValidation(CTX), null);
  assert.equal(await drivers.release(CTX), null);
  // gatePr always emits an (empty-facts) gate event even with no effect.
  assert.equal((await drivers.gatePr(CTX)).type, 'gate.evaluated');
});
