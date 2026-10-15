// kernel-force-step — the human-invoked fixback path: runStep(runId, { force })
// uses the caller's decision INSTEAD of the reconciled one while flowing through
// the SAME durable-marker + link-proof + fail-closed machinery, refuses while
// the worker lane is in flight, and carries decision.fixbackDirectives into the
// resumed fixback spec context (spine-effects resumeFixback).
//
//   node --test --require tsx/cjs electron/run-ledger/__tests__/kernel-force-step.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

let eventLedgerModule: any;
try { eventLedgerModule = require('../event-ledger.cjs'); } catch { eventLedgerModule = require('../event-ledger.cts'); }
const { createMemoryEventLog } = eventLedgerModule;

let kernelModule: any;
try { kernelModule = require('../kernel.cjs'); } catch { kernelModule = require('../kernel.cts'); }
const { createKernel } = kernelModule;

let spineEffectsModule: any;
try { spineEffectsModule = require('../spine-effects.cjs'); } catch { spineEffectsModule = require('../spine-effects.cts'); }
const { createSpineEffects } = spineEffectsModule;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
const { NEXT_ACTIONS } = orchestrationPolicy;

const SPEC = {
  goal: 'SKY-142: wire the review gate',
  context: 'Original ticket context.',
  acceptance: ['review passes'],
  scope: { workspaceId: 'prj-1' },
};

function seededLedger(extraEvents: any[] = []) {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', ts: 1, type: 'run.created', payload: { spec: SPEC } });
  let ts = 2;
  for (const event of extraEvents) ledger.append({ runId: 'run-1', ts: ts++, ...event });
  return ledger;
}

const FORCE = {
  next: NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER,
  reason: 'skysphere-review-fixback',
  fixbackDirectives: 'Fix the null guard the review flagged.',
};

test('force dispatches the forced action with the durable marker written BEFORE the driver runs', async () => {
  const ledger = seededLedger();
  const seen: any[] = [];
  const kernel = createKernel({
    ledger,
    drivers: {
      dispatchFixback: async (ctx: any) => {
        seen.push({
          decision: ctx.decision,
          markerAlreadyOnLedger: ledger.readRun('run-1').some((e: any) => e.type === 'fixback.dispatched'),
        });
        // Prove the dispatch is real: synchronous link proof, like spine-effects.
        ctx.ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 't-1', streamId: 's-1' } });
        return null;
      },
    },
  });
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, true);
  assert.equal(result.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.equal(result.ran, 'dispatchFixback');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].markerAlreadyOnLedger, true);
  assert.equal(seen[0].decision.fixbackDirectives, FORCE.fixbackDirectives);
  assert.equal(seen[0].decision.reason, 'skysphere-review-fixback');
});

test('a forced dispatch that links nothing fails closed through the existing link-proof machinery', async () => {
  const ledger = seededLedger();
  const kernel = createKernel({ ledger, drivers: { dispatchFixback: async () => null } });
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /no linked stream/i);
  const types = ledger.readRun('run-1').map((e: any) => e.type);
  assert.ok(types.includes('fixback.dispatched'), 'durable marker still recorded');
  assert.ok(types.includes('worker.dispatch.failed'), 'fail-closed failure event recorded');
});

test('force refuses while the worker lane is in flight — no marker, no driver call', async () => {
  const ledger = seededLedger([{ type: 'worker.dispatched', payload: {} }]);
  let driverCalls = 0;
  const kernel = createKernel({ ledger, drivers: { dispatchFixback: async () => { driverCalls += 1; return null; } } });
  const before = ledger.readRun('run-1').length;
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, false);
  assert.equal(result.ran, null);
  assert.match(String(result.error), /worker in flight — use the live stream/);
  assert.equal(driverCalls, 0);
  assert.equal(ledger.readRun('run-1').length, before, 'nothing appended by a refused force');
});

test('force refuses while a FIXBACK worker is in flight — worker.done stays true from the original completion', async () => {
  // The exact review-fixback shape: original worker completed (done=true,
  // never reset), then fixback #1 dispatched and linked but NOT yet completed.
  // `dispatched && !done` alone passes here; only fixbackInFlight refuses.
  const ledger = seededLedger([
    { type: 'worker.dispatched', payload: {} },
    { type: 'worker.completed', payload: { outcome: 'DONE' } },
    { type: 'fixback.dispatched', payload: {} },
    { type: 'worker.dispatch.linked', payload: { taskId: 't-2', streamId: 's-2' } },
  ]);
  let driverCalls = 0;
  const kernel = createKernel({ ledger, drivers: { dispatchFixback: async (ctx: any) => {
    driverCalls += 1;
    ctx.ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 't-3', streamId: 's-3' } });
    return null;
  } } });
  const before = ledger.readRun('run-1').length;
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, false);
  assert.equal(result.ran, null);
  assert.match(String(result.error), /worker in flight — use the live stream/);
  assert.equal(driverCalls, 0);
  assert.equal(ledger.readRun('run-1').length, before, 'nothing appended by a refused force');

  // Once the fixback worker completes, the lane reopens and a new force runs.
  ledger.append({ runId: 'run-1', ts: 100, type: 'worker.completed', payload: { outcome: 'DONE' } });
  const after = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.ran, 'dispatchFixback');
  assert.equal(driverCalls, 1);
});

test('a failed fixback dispatch clears the in-flight flag so a later force is not wedged', async () => {
  const ledger = seededLedger([
    { type: 'worker.dispatched', payload: {} },
    { type: 'worker.completed', payload: { outcome: 'DONE' } },
    { type: 'fixback.dispatched', payload: {} },
    { type: 'worker.dispatch.failed', payload: { error: 'spawn failed' } },
  ]);
  const kernel = createKernel({ ledger, drivers: { dispatchFixback: async (ctx: any) => {
    ctx.ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 't-2', streamId: 's-2' } });
    return null;
  } } });
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.ran, 'dispatchFixback');
});

test('fixbackDirectives land in the resumed fixback spec context (spine-effects resumeFixback)', async () => {
  const ledger = seededLedger([
    { type: 'worker.dispatched', payload: {} },
    { type: 'worker.dispatch.linked', payload: { taskId: 't-1', streamId: 's-1', branch: 'feat/sky-142' } },
    { type: 'worker.completed', payload: { outcome: 'DONE' } },
  ]);
  const dispatched: any[] = [];
  const effects = createSpineEffects({
    client: { invoke: async () => ({}) },
    runTask: async (_client: any, args: any) => {
      dispatched.push(args);
      const link = { taskId: 't-1', streamId: 's-1', worktreeId: 'w-1', worktreePath: '/tmp/w-1', branch: 'feat/sky-142' };
      if (typeof args.onStreamCreated === 'function') args.onStreamCreated(link);
      return link;
    },
  });
  const kernel = createKernel({ ledger, drivers: { dispatchFixback: effects.dispatchFixback } });
  const result = await kernel.runStep('run-1', { force: FORCE });
  assert.equal(result.ok, true, result.error);
  assert.equal(dispatched.length, 1);
  const spec = dispatched[0].spec;
  assert.ok(String(spec.context).includes('Original ticket context.'), 'original spec context preserved');
  assert.ok(String(spec.context).includes(FORCE.fixbackDirectives), 'human directives appended to the spec context');
  assert.ok(String(dispatched[0].label || '').startsWith('fix '), 'dispatched as a fixback');
  const types = ledger.readRun('run-1').map((e: any) => e.type);
  assert.ok(types.includes('worker.dispatch.linked'), 'link proof recorded');
});

test('runStep without opts is unchanged (reconciled decision drives the step)', async () => {
  const ledger = seededLedger();
  const calls: string[] = [];
  const kernel = createKernel({
    ledger,
    drivers: {
      dispatchWorker: async (ctx: any) => {
        calls.push('dispatchWorker');
        ctx.ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 't-1', streamId: 's-1' } });
        return null;
      },
      dispatchFixback: async () => { calls.push('dispatchFixback'); return null; },
    },
  });
  const result = await kernel.runStep('run-1');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['dispatchWorker']);
});
