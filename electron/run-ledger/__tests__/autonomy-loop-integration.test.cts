// autonomy-loop-integration.test — proves the OUTER loop CLOSES end-to-end through
// the REAL spine modules (createRunLedgerHarness + reconciler + decideNextCycle +
// board projection), with no electron and no real agents. It faithfully mirrors
// the controller neuron (maybeAdvanceAutonomyLoop): reconcile a settled run, read
// the dispatch links + prior signature from the ledger, call decideNextCycle,
// append the next-goal.derived marker, and submit the next cycle. The only thing
// simulated is what a real worker/validator + completion.json would supply
// (computer-use evidence + adversarial followups).
//
// Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/autonomy-loop-integration.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

let harnessModule: any;
try { harnessModule = require('../harness.cjs'); } catch { harnessModule = require('../harness.cts'); }
const { createRunLedgerHarness } = harnessModule;

let autonomyLoopModule: any;
try { autonomyLoopModule = require('../autonomy-loop.cjs'); } catch { autonomyLoopModule = require('../autonomy-loop.cts'); }
const { decideNextCycle } = autonomyLoopModule;

// Simulate the events a real cycle's worker + validator dispatch/complete would
// append (Ring-1 effects + the Ring-2 completion mirror) — a clean worker DONE +
// validator PASS so the run settles at dispatch_release_goal (parked, no token).
function simulateCycleToSettle(harness: any, runId: string, branch: string, headSha: string) {
  harness.ledger.append({ runId, type: 'worker.dispatch.linked', payload: { taskId: `t-${runId}`, branch, worktreePath: `/wt/${runId}` } });
  harness.ledger.append({ runId, type: 'worker.dispatched', payload: {} });
  harness.ledger.append({ runId, type: 'worker.completed', payload: { outcome: 'DONE', headSha } });
  harness.ledger.append({ runId, type: 'validator.dispatch.linked', payload: { taskId: `v-${runId}`, worktreePath: `/wt/v-${runId}` } });
  harness.ledger.append({ runId, type: 'validator.dispatched', payload: {} });
  harness.ledger.append({ runId, type: 'validator.completed', payload: { outcome: 'PASS', validatedHeadSha: headSha } });
}

// The controller neuron, faithfully: reconcile → read links + prior signature →
// decideNextCycle → record marker → submit next. Returns { result, nextRunId }.
function advance(harness: any, runId: string, evidence: any) {
  const { state, decision } = harness.kernel.reconcile(runId);
  const events = harness.ledger.readRun(runId);
  const wlink = [...events].reverse().find((e: any) => e.type === 'worker.dispatch.linked');
  const lineageId = (state.spec && state.spec.loopLineageId) || runId;
  const lineageNg = harness.ledger.readAll().filter((e: any) => e.type === 'next-goal.derived' && e.payload && e.payload.loopLineageId === lineageId);
  const priorSignature = lineageNg.length ? lineageNg[lineageNg.length - 1].payload.signature : '';

  const result = decideNextCycle({
    runId, spec: state.spec, state, decision,
    computerUseEvidence: evidence.computerUseEvidence,
    validatorFollowups: evidence.followups || [],
    proposedNextGoal: evidence.proposedNextGoal || '',
    priorSignature,
    workerBranch: wlink && wlink.payload.branch,
    workerWorktreePath: wlink && wlink.payload.worktreePath,
  });

  harness.ledger.append({
    runId, type: 'next-goal.derived',
    payload: { loopLineageId: result.lineageId, parentRunId: runId, iteration: result.iteration, terminal: result.terminal, signature: result.signature, followups: result.followups, computerUseEvidence: result.computerUseEvidence },
  });

  let nextRunId: any = null;
  if (result.terminal === 'continue' && result.nextIntent) nextRunId = harness.submit(result.nextIntent);
  return { result, nextRunId };
}

test('loop CONVERGES: cycle 1 surfaces a gap → cycle 2 fixes it → parks for owner merge', () => {
  const harness = createRunLedgerHarness({});
  const run1 = harness.submit({
    goal: 'Build the settings panel',
    scope: { workspaceId: 'w1', allow: ['src/settings/'] },
    acceptance: ['the panel renders'],
    autoIterate: true, iteration: 1, maxIterations: 5,
  });

  // Cycle 1: passes, but the adversarial validator finds a gap → continue.
  simulateCycleToSettle(harness, run1, 'ace/run-1-settings', 'sha1');
  const a1 = advance(harness, run1, {
    computerUseEvidence: true,
    followups: ['the toggle does not persist across reload'],
    proposedNextGoal: 'Persist the dark-mode toggle across reloads and re-run the behavioral test',
  });
  assert.equal(a1.result.terminal, 'continue');
  assert.ok(a1.nextRunId, 'a fresh cycle-2 run was submitted');

  // Cycle 2 inherited the lineage, scope, and branch; carries no featureId/token.
  const run2 = a1.nextRunId;
  const spec2 = harness.ledger.readRun(run2).find((e: any) => e.type === 'run.created').payload.spec;
  assert.equal(spec2.loopLineageId, run1, 'lineage = root runId');
  assert.equal(spec2.parentRunId, run1);
  assert.equal(spec2.iteration, 2);
  assert.deepEqual(spec2.scope, { workspaceId: 'w1', allow: ['src/settings/'] }, 'scope inherited verbatim');
  assert.equal(spec2.continueBranch, 'ace/run-1-settings', 'continues the same branch');
  assert.equal(spec2.featureId, undefined);
  assert.equal(spec2.ownerAuthToken, undefined, 'auto-cycles never carry a merge token');

  // Cycle 2: the fix lands, validator passes with evidence, NO new gaps → converge.
  simulateCycleToSettle(harness, run2, 'ace/run-1-settings', 'sha2');
  const a2 = advance(harness, run2, { computerUseEvidence: true, followups: [] });
  assert.equal(a2.result.terminal, 'converged');
  assert.equal(a2.nextRunId, null, 'converged ⇒ no further cycle; parked for the owner merge token');

  // The board shows the lineage on both cycle cards.
  const board = harness.board();
  const c1 = board.cards.find((c: any) => c.id === run1);
  const c2 = board.cards.find((c: any) => c.id === run2);
  assert.equal(c1.loop.lineageId, run1);
  assert.equal(c2.loop.lineageId, run1);
  assert.equal(c2.loop.iteration, 2);
});

test('loop HALTS on no-progress: the same gap twice → stop, no cycle 3', () => {
  const harness = createRunLedgerHarness({});
  const run1 = harness.submit({ goal: 'g', scope: { workspaceId: 'w1', allow: [] }, autoIterate: true, iteration: 1, maxIterations: 5 });
  simulateCycleToSettle(harness, run1, 'b1', 'sha1');
  const a1 = advance(harness, run1, { computerUseEvidence: true, followups: ['flaky thing'], proposedNextGoal: 'fix flaky thing' });
  assert.equal(a1.result.terminal, 'continue');

  const run2 = a1.nextRunId;
  simulateCycleToSettle(harness, run2, 'b1', 'sha2');
  // Same gap resurfaces → identical signature → no-progress halt.
  const a2 = advance(harness, run2, { computerUseEvidence: true, followups: ['flaky thing'], proposedNextGoal: 'fix flaky thing' });
  assert.equal(a2.result.terminal, 'no-progress');
  assert.equal(a2.nextRunId, null);
});

test('loop HALTS on the iteration cap', () => {
  const harness = createRunLedgerHarness({});
  const run1 = harness.submit({ goal: 'g', scope: { workspaceId: 'w1', allow: [] }, autoIterate: true, iteration: 1, maxIterations: 2 });
  simulateCycleToSettle(harness, run1, 'b1', 'sha1');
  const a1 = advance(harness, run1, { computerUseEvidence: true, followups: ['gap one'], proposedNextGoal: 'fix gap one' });
  assert.equal(a1.result.terminal, 'continue');

  const run2 = a1.nextRunId; // iteration 2 == maxIterations
  simulateCycleToSettle(harness, run2, 'b1', 'sha2');
  const a2 = advance(harness, run2, { computerUseEvidence: true, followups: ['a different gap two'], proposedNextGoal: 'fix gap two' });
  assert.equal(a2.result.terminal, 'cap-hit');
  assert.equal(a2.nextRunId, null);
});
