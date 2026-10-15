// autonomy-loop.test — the PURE neuron brain: decideNextCycle's converge /
// continue / no-progress / cap terminals and the child-intent contract (inherited
// scope, no featureId/laneId, no owner token, branch continuation). This is the
// "verify the loop policy BEFORE arming auto-dispatch" gate.
//
// Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/autonomy-loop.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

let autonomyLoopModule: any;
try { autonomyLoopModule = require('../autonomy-loop.cjs'); }
catch { autonomyLoopModule = require('../autonomy-loop.cts'); }
const { decideNextCycle, nextCycleIntent, verdictFromState, mergeFollowups } = autonomyLoopModule;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
const { NEXT_ACTIONS } = orchestrationPolicy;

const baseSpec = () => ({
  scope: { workspaceId: 'prj_42', allow: ['src/settings/'] },
  acceptance: ['the panel renders', 'the toggle persists'],
  autoIterate: true,
  iteration: 1,
  maxIterations: 5,
});

const passState = (extra: any = {}) => ({
  validator: { outcome: 'PASS', done: true },
  pr: { url: 'https://github.com/acme/repo/pull/9', headSha: 'deadbeef01', changedFiles: ['src/settings/panel.tsx'] },
  ...extra,
});

test('verdictFromState maps the spine vocabulary onto bundle verdicts', () => {
  assert.equal(verdictFromState({ validator: { outcome: 'PASS' } }), 'pass');
  assert.equal(verdictFromState({ validator: { outcome: 'FIXBACK_REQUIRED' } }), 'request-changes');
  assert.equal(verdictFromState({ validator: { outcome: 'BLOCKED_SCOPE' } }), 'block');
  assert.equal(verdictFromState({ validator: { outcome: 'NONE' } }), null);
});

test('converged: PASS + computer-use evidence + no followups → no next cycle', () => {
  const out = decideNextCycle({
    runId: 'run-7',
    spec: baseSpec(),
    state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: true,
    validatorFollowups: [],
    proposedNextGoal: '',
  });
  assert.equal(out.terminal, 'converged');
  assert.equal(out.nextIntent, null);
});

test('continue: PASS + adversarial followups → a well-formed next-cycle intent', () => {
  const out = decideNextCycle({
    runId: 'run-7',
    spec: baseSpec(),
    state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: true,
    validatorFollowups: ['the toggle does not persist across reload'],
    proposedNextGoal: 'Persist the toggle across reloads and re-run the behavioral test',
    workerBranch: 'ace/run-7-settings',
    workerWorktreePath: '/tmp/wt/run-7',
    priorSignature: 'OLDER',
  });
  assert.equal(out.terminal, 'continue');
  assert.ok(out.nextIntent, 'a continue produces a next intent');
  const ni = out.nextIntent;
  assert.equal(ni.goal, 'Persist the toggle across reloads and re-run the behavioral test', 'goal = proposedNextGoal');
  assert.equal(ni.iteration, 2, 'iteration incremented');
  assert.equal(ni.maxIterations, 5);
  assert.equal(ni.loopLineageId, 'run-7', 'lineage = root runId');
  assert.equal(ni.parentRunId, 'run-7');
  assert.equal(ni.autoIterate, true);
  // Scope inherited verbatim, same workspace.
  assert.deepEqual(ni.scope, { workspaceId: 'prj_42', allow: ['src/settings/'] });
  // Branch continuation.
  assert.equal(ni.continueBranch, 'ace/run-7-settings');
  assert.equal(ni.continueWorktreePath, '/tmp/wt/run-7');
  // The collision + fail-closed guards: NO featureId/laneId, NO owner token.
  assert.equal(ni.featureId, undefined, 'never a featureId (run↔task collision guard)');
  assert.equal(ni.laneId, undefined, 'never a laneId');
  assert.equal(ni.ownerAuthToken, undefined, 'auto-cycles NEVER carry a merge token (owner merges the converged branch)');
});

test('missing computer-use evidence injects a followup and continues (never converges)', () => {
  const out = decideNextCycle({
    runId: 'run-7',
    spec: baseSpec(),
    state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: false, // validator passed on say-so, no artifact
    validatorFollowups: [],
    proposedNextGoal: '',
    priorSignature: 'OLDER',
  });
  assert.notEqual(out.terminal, 'converged', 'no evidence ⇒ cannot converge');
  assert.equal(out.terminal, 'continue');
  assert.ok(out.nextIntent, 'continues to obtain real evidence');
  assert.ok(out.signature, 'the missing-evidence followup makes the signature non-empty');
});

test('no-progress: the same followups as the prior cycle halts the loop', () => {
  const spec = { ...baseSpec(), iteration: 2 };
  const followups = ['the toggle does not persist across reload'];
  // Compute the signature the prior cycle would have stored.
  const first = decideNextCycle({
    runId: 'run-7', spec: baseSpec(), state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: true, validatorFollowups: followups, proposedNextGoal: 'x', priorSignature: '',
  });
  const out = decideNextCycle({
    runId: 'run-9', spec, state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: true, validatorFollowups: followups, proposedNextGoal: 'x',
    priorSignature: first.signature,
  });
  assert.equal(out.terminal, 'no-progress');
  assert.equal(out.nextIntent, null, 'no-progress dispatches nothing');
});

test('cap-hit: reaching maxIterations halts even with fresh followups', () => {
  const spec = { ...baseSpec(), iteration: 5, maxIterations: 5 };
  const out = decideNextCycle({
    runId: 'run-9', spec, state: passState(),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    computerUseEvidence: true,
    validatorFollowups: ['a brand new gap'],
    proposedNextGoal: 'fix the brand new gap',
    priorSignature: 'DIFFERENT',
  });
  assert.equal(out.terminal, 'cap-hit');
  assert.equal(out.nextIntent, null);
});

test('blocked: the spine decision halts the loop for the owner', () => {
  const out = decideNextCycle({
    runId: 'run-9', spec: baseSpec(),
    state: { validator: { outcome: 'BLOCKED_SCOPE' }, pr: {} },
    decision: { next: NEXT_ACTIONS.BLOCKED },
    computerUseEvidence: false,
    validatorFollowups: ['scope exceeded'],
    proposedNextGoal: '',
    priorSignature: 'OLDER',
  });
  assert.equal(out.terminal, 'blocked');
  assert.equal(out.nextIntent, null);
});

test('mergeFollowups concatenates worker self-report + validator and dedups', () => {
  const merged = mergeFollowups(['gap A', 'gap B'], ['gap A', 'worker noted gap C']);
  assert.deepEqual(merged, ['gap A', 'gap B', 'worker noted gap C']);
});
