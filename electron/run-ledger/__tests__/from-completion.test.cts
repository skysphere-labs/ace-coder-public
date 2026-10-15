// from-completion.test — proves the Ring 2 mapper turns observer completion
// records into the right kernel events (worker vs validator), keys them by
// feature/lane, and skips records it cannot map. Pure, runs under node --test.
const test = require('node:test');
const assert = require('node:assert');

const { fromCompletion } = require('../from-completion.cts');

test('a DONE worker completion maps to worker.completed keyed by laneId', () => {
  const e = fromCompletion({ laneId: 'feat-1', taskId: 't1', kind: 'done', detail: 'finished' });
  assert.equal(e.runId, 'feat-1');
  assert.equal(e.type, 'worker.completed');
  assert.equal(e.payload.outcome, 'DONE');
});

test('a BLOCKED completion maps to worker.completed with BLOCKED', () => {
  const e = fromCompletion({ featureId: 'feat-2', kind: 'blocked', detail: 'cannot proceed' });
  assert.equal(e.runId, 'feat-2');
  assert.equal(e.payload.outcome, 'BLOCKED');
});

test('a validator VERDICT record maps to validator.completed (reconciler re-parses)', () => {
  const e = fromCompletion({
    laneId: 'feat-3',
    kind: 'done',
    detail: 'DONE: VERDICT=PASS on https://github.com/x/y/pull/1 {"verdict":"pass"}',
  });
  assert.equal(e.runId, 'feat-3');
  assert.equal(e.type, 'validator.completed');
  assert.equal(e.payload.record.detail.includes('VERDICT=PASS'), true);
});

test('falls back to registryRow.laneId then taskId for the runId', () => {
  assert.equal(fromCompletion({ registryRow: { laneId: 'feat-4' }, kind: 'done' }).runId, 'feat-4');
  assert.equal(fromCompletion({ taskId: 'task-only', kind: 'done' }).runId, 'task-only');
});

test('a runIdOverride closes the ORIGINATING run, not the phantom taskId run', () => {
  // A spine-dispatched task carries no lane/feature, so without the override its
  // completion would key by taskId ('task-9') and open a phantom run. The Ring-2
  // observer resolves the originating spine runId from the dispatch annotation
  // and passes it here; it must win over the taskId fallback.
  const e = fromCompletion({ taskId: 'task-9', kind: 'done', detail: 'finished' }, 'run-3');
  assert.equal(e.runId, 'run-3');
  assert.equal(e.type, 'worker.completed');
  // A blank/absent override still falls back to the record's own keys.
  assert.equal(fromCompletion({ taskId: 'task-9', kind: 'done' }, '').runId, 'task-9');
  assert.equal(fromCompletion({ taskId: 'task-9', kind: 'done' }).runId, 'task-9');
});

test('records with no identity or non-terminal kind map to null', () => {
  assert.equal(fromCompletion({ kind: 'done' }), null); // no runId
  assert.equal(fromCompletion({ laneId: 'feat-5', kind: 'progress' }), null); // not terminal
  assert.equal(fromCompletion(null), null);
});

// --- runWaitingForStream: the raw-ring fallback's admission gate -----------
const { runWaitingForStream } = require('../from-completion.cts');

const link = (phase: any, streamId: any, ts: any) => ({ type: `${phase}.dispatch.linked`, ts, payload: { taskId: 't', streamId } });

test('runWaitingForStream: worker waiting on this stream passes; other streams refuse', () => {
  const state = { worker: { dispatched: true, done: false }, validator: {} };
  const events = [link('worker', 'variant:w1', 1)];
  assert.equal(runWaitingForStream(state, events, 'variant:w1'), true);
  assert.equal(runWaitingForStream(state, events, 'variant:other'), false);
});

test('runWaitingForStream: a finished run refuses — later turns on the tab cannot pollute it', () => {
  const state = { worker: { dispatched: true, done: true }, validator: {} };
  assert.equal(runWaitingForStream(state, [link('worker', 'variant:w1', 1)], 'variant:w1'), false);
});

test('runWaitingForStream: validator phase takes precedence and binds to the VALIDATOR link', () => {
  const state = {
    worker: { dispatched: true, done: true },
    validator: { dispatched: true, done: false },
  };
  const events = [link('worker', 'variant:w1', 1), link('validator', 'variant:v1', 2)];
  assert.equal(runWaitingForStream(state, events, 'variant:v1'), true);
  assert.equal(runWaitingForStream(state, events, 'variant:w1'), false);
});

test('runWaitingForStream: a fixback in flight re-admits the worker stream (done stays true)', () => {
  const state = { worker: { dispatched: true, done: true, fixbackInFlight: true }, validator: {} };
  const events = [link('worker', 'variant:w1', 1), link('worker', 'variant:w2', 2)];
  // The NEWEST worker link wins — the fixback generation's stream.
  assert.equal(runWaitingForStream(state, events, 'variant:w2'), true);
  assert.equal(runWaitingForStream(state, events, 'variant:w1'), false);
});

test('runWaitingForStream: refuses malformed input', () => {
  assert.equal(runWaitingForStream(null, [], 's'), false);
  assert.equal(runWaitingForStream({ worker: { dispatched: true, done: false } }, [], 's'), false);
  assert.equal(runWaitingForStream({ worker: { dispatched: true, done: false } }, [link('worker', 's', 1)], ''), false);
});

// --- rawTrailerAdmission: consume vs retry vs record ----------------------
const { rawTrailerAdmission } = require('../from-completion.cts');

test('rawTrailerAdmission: no harness (disabled or not yet initialized) retries', () => {
  assert.equal(rawTrailerAdmission({ harnessAvailable: false }), 'retry');
});

test('rawTrailerAdmission: no link in an EMPTY ledger retries (masked I/O failure)', () => {
  assert.equal(
    rawTrailerAdmission({ harnessAvailable: true, spineRunId: null, ledgerEvents: [] }),
    'retry'
  );
});

test('rawTrailerAdmission: no link in a populated ledger consumes (not a spine stream)', () => {
  assert.equal(
    rawTrailerAdmission({ harnessAvailable: true, spineRunId: null, ledgerEvents: [{ type: 'run.created' }] }),
    'consume'
  );
});

test('rawTrailerAdmission: waiting run records; finished run consumes', () => {
  const events = [link('worker', 'variant:w', 1)];
  assert.equal(
    rawTrailerAdmission({
      harnessAvailable: true,
      spineRunId: 'run-1',
      reconciledState: { worker: { dispatched: true, done: false } },
      runEvents: events,
      streamId: 'variant:w',
    }),
    'record'
  );
  assert.equal(
    rawTrailerAdmission({
      harnessAvailable: true,
      spineRunId: 'run-1',
      reconciledState: { worker: { dispatched: true, done: true } },
      runEvents: events,
      streamId: 'variant:w',
    }),
    'consume'
  );
});
