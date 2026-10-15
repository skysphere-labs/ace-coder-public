// loop-lineage.test — Phase 1 plumbing proof: the auto-iterate fields ride the
// intake spec onto the ledger (no schema migration), a cycle intent carries NO
// featureId/laneId (the run↔task collision guard), and the lineage-id convention
// resolves consistently across cycles.
//
// Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/loop-lineage.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

let kernelModule: any;
try {
  kernelModule = require('../kernel.cjs');
} catch {
  kernelModule = require('../kernel.cts');
}
const { createKernel } = kernelModule;

let eventLedgerModule: any;
try {
  eventLedgerModule = require('../event-ledger.cjs');
} catch {
  eventLedgerModule = require('../event-ledger.cts');
}
const { createMemoryEventLog } = eventLedgerModule;

let loopSignatureModule: any;
try {
  loopSignatureModule = require('../loop-signature.cjs');
} catch {
  loopSignatureModule = require('../loop-signature.cts');
}
const { lineageIdOf } = loopSignatureModule;

function specOf(ledger: any, runId: string) {
  const created = ledger.readRun(runId).find((e: any) => e.type === 'run.created');
  return created && created.payload ? created.payload.spec : null;
}

test('auto-iterate fields ride the intake spec onto run.created (durable, no migration)', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const runId = k.submitIntent({
    goal: 'build the settings panel',
    scope: { workspaceId: 'prj_42', allow: ['src/settings/'] },
    autoIterate: true,
    iteration: 1,
    maxIterations: 3,
  });
  const spec = specOf(ledger, runId);
  assert.equal(spec.autoIterate, true);
  assert.equal(spec.iteration, 1);
  assert.equal(spec.maxIterations, 3);
  assert.deepEqual(spec.scope.allow, ['src/settings/']);
});

test('a cycle intent carries NO featureId/laneId (the run↔task collision guard)', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  // Exactly the shape `run submit --auto-iterate` builds in buildIpcParams.
  const runId = k.submitIntent({
    goal: 'fix the toggle',
    scope: { workspaceId: 'prj_42', allow: [] },
    autoIterate: true,
    iteration: 1,
    maxIterations: 5,
  });
  const spec = specOf(ledger, runId);
  assert.equal(spec.featureId, undefined, 'no featureId — else runIdFor would collide cycles into one run');
  assert.equal(spec.laneId, undefined, 'no laneId — same reason');
});

test('lineageIdOf: a root run is its own lineage; a child carries the root id', () => {
  // Root: autoIterate, no loopLineageId on the spec → lineage id is its runId.
  assert.equal(lineageIdOf('run-7', { autoIterate: true, iteration: 1 }), 'run-7');
  // Child: explicit loopLineageId (= the root runId) wins.
  assert.equal(lineageIdOf('run-9', { autoIterate: true, iteration: 2, loopLineageId: 'run-7' }), 'run-7');
  // Defensive: missing spec → own runId.
  assert.equal(lineageIdOf('run-3', null), 'run-3');
});
