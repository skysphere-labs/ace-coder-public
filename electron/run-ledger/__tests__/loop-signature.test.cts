// loop-signature.test — proves the PURE outer-loop deciders before any of them
// is armed (nothing imports loop-signature.cts in the live spine yet). Covers:
//   followupSignature   — order-independence, normalization, dedup, empty.
//   classifyLoopTerminal — the converged/blocked/no-progress/cap/continue truth
//     table, INCLUDING the load-bearing rule: a PASS without computer-use
//     evidence must NEVER converge.
//   next-goal           — proposedNextGoal is preferred text but never overrides
//     the no-goal (convergence) test.
//
// Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/loop-signature.test.cts
//
// Determinism: no Date.now/Math.random anywhere; every output is a function of
// the literal inputs.

const test = require('node:test');
const assert = require('node:assert/strict');

// Build-agnostic sibling imports (compiled .cjs is gitignored / absent in a
// fresh worktree, so fall back to the .cts that tsx resolves).
let loopSignatureModule: any;
try {
  loopSignatureModule = require('../loop-signature.cjs');
} catch {
  loopSignatureModule = require('../loop-signature.cts');
}
const { followupSignature, classifyLoopTerminal, normalizeFollowup } = loopSignatureModule;

let completionPacketModule: any;
try {
  completionPacketModule = require('../completion-packet.cjs');
} catch {
  completionPacketModule = require('../completion-packet.cts');
}
const { buildEvidenceBundle } = completionPacketModule;

let nextGoalModule: any;
try {
  nextGoalModule = require('../next-goal.cjs');
} catch {
  nextGoalModule = require('../next-goal.cts');
}
const { deriveNextGoal } = nextGoalModule;

let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS } = orchestrationPolicy;

// ---------------------------------------------------------------------------
// followupSignature
// ---------------------------------------------------------------------------

test('followupSignature is order-independent', () => {
  const a = followupSignature(['Add logging', 'Race condition in poller']);
  const b = followupSignature(['Race condition in poller', 'Add logging']);
  assert.equal(a, b, 'reordering the same gaps yields the same signature');
  assert.ok(a, 'a non-empty followup set produces a non-empty signature');
});

test('followupSignature normalizes cosmetic restatements of the same gap', () => {
  // Leading action verb is meaningless to the gap identity.
  assert.equal(
    followupSignature(['Address the flaky test']),
    followupSignature(['the flaky test']),
    'a leading verb is stripped',
  );
  // Volatile sha/id tokens are dropped.
  assert.equal(
    followupSignature(['Race condition at deadbeefcafe']),
    followupSignature(['Race condition at']),
    'a bare sha is dropped',
  );
  // Case + punctuation do not change identity.
  assert.equal(
    followupSignature(['DARK-MODE toggle!!!']),
    followupSignature(['dark mode toggle']),
    'case and punctuation are normalized away',
  );
});

test('followupSignature dedups and treats empty/whitespace/punctuation-only as no signature', () => {
  assert.equal(
    followupSignature(['flaky test', 'flaky test', 'flaky test']),
    followupSignature(['flaky test']),
    'duplicates collapse',
  );
  assert.equal(followupSignature([]), '', 'empty list → empty signature');
  assert.equal(followupSignature(['   ', '!!!', '']), '', 'whitespace/punctuation-only → empty signature');
  assert.equal(normalizeFollowup('  Fix:  the   spacing  '), 'the spacing', 'normalize collapses runs of whitespace');
});

// ---------------------------------------------------------------------------
// classifyLoopTerminal — the truth table
// ---------------------------------------------------------------------------

const passWithComputerUse = buildEvidenceBundle({
  runId: 'run_1',
  verdict: 'pass',
  computerUseEvidence: true,
  acceptanceResults: [{ id: 'A1', status: 'pass' }],
});

test('converged: PASS + real computer-use + no next goal', () => {
  const out = classifyLoopTerminal({
    bundle: passWithComputerUse,
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { no_goal: 'all criteria met' },
    iteration: 2,
    maxIterations: 5,
    signature: '',
    lastSignature: '',
  });
  assert.equal(out.terminal, 'converged');
});

test('a PASS WITHOUT computer-use evidence must NEVER converge', () => {
  const out = classifyLoopTerminal({
    bundle: buildEvidenceBundle({ runId: 'run_x', verdict: 'pass', computerUseEvidence: false }),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { no_goal: 'claims complete' },
    iteration: 1,
    maxIterations: 5,
    signature: '',
    lastSignature: '',
  });
  assert.notEqual(out.terminal, 'converged', 'no computer-use ⇒ not converged');
  assert.equal(out.terminal, 'continue', 'instead the loop continues to obtain real evidence');
});

test('blocked: the spine parked the run for the owner', () => {
  const out = classifyLoopTerminal({
    bundle: buildEvidenceBundle({ runId: 'run_b', verdict: 'block', computerUseEvidence: false }),
    decision: { next: NEXT_ACTIONS.BLOCKED },
    nextGoal: {},
    iteration: 2,
    maxIterations: 5,
    signature: 'sig-b',
    lastSignature: 'sig-a',
  });
  assert.equal(out.terminal, 'blocked');
});

test('no-progress: the same non-empty signature twice in a row', () => {
  const out = classifyLoopTerminal({
    bundle: buildEvidenceBundle({ runId: 'run_np', verdict: 'request-changes', computerUseEvidence: true }),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { goal: 'retry', requiresOwnerApproval: true },
    iteration: 2,
    maxIterations: 5,
    signature: 'abc123',
    lastSignature: 'abc123',
  });
  assert.equal(out.terminal, 'no-progress');
});

test('empty signatures never trigger a false no-progress', () => {
  const out = classifyLoopTerminal({
    bundle: buildEvidenceBundle({ runId: 'run_e', verdict: 'request-changes', computerUseEvidence: true }),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { goal: 'do work' },
    iteration: 1,
    maxIterations: 5,
    signature: '',
    lastSignature: '',
  });
  assert.equal(out.terminal, 'continue');
});

test('cap-hit: iteration reached the ceiling', () => {
  const out = classifyLoopTerminal({
    bundle: buildEvidenceBundle({ runId: 'run_c', verdict: 'request-changes', computerUseEvidence: true }),
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { goal: 'more work' },
    iteration: 5,
    maxIterations: 5,
    signature: 'new',
    lastSignature: 'old',
  });
  assert.equal(out.terminal, 'cap-hit');
});

test('convergence wins over the cap (a run that finishes on the last cycle is done, not capped)', () => {
  const out = classifyLoopTerminal({
    bundle: passWithComputerUse,
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { no_goal: 'complete' },
    iteration: 5,
    maxIterations: 5,
    signature: '',
    lastSignature: '',
  });
  assert.equal(out.terminal, 'converged');
});

test('continue: a pass that still surfaced new followups keeps iterating', () => {
  const out = classifyLoopTerminal({
    bundle: passWithComputerUse,
    decision: { next: NEXT_ACTIONS.DISPATCH_RELEASE_GOAL },
    nextGoal: { goal: 'address the newly-found edge case', requiresOwnerApproval: true },
    iteration: 1,
    maxIterations: 5,
    signature: 'fresh',
    lastSignature: 'stale',
  });
  assert.equal(out.terminal, 'continue');
});

// ---------------------------------------------------------------------------
// next-goal — proposedNextGoal preference
// ---------------------------------------------------------------------------

test('deriveNextGoal prefers a validator-supplied proposedNextGoal as the goal text', () => {
  const failingBundle = buildEvidenceBundle({
    runId: 'run_g',
    verdict: 'request-changes',
    acceptanceResults: [{ id: 'A3', status: 'fail' }],
    detail: 'A3 failed',
  });
  const proposal = deriveNextGoal(failingBundle, {
    followups: ['the toggle does not persist'],
    proposedNextGoal: 'Persist the dark-mode toggle across reloads and re-run the behavioral test',
  });
  assert.equal('no_goal' in proposal, false, 'failing run yields a proposal');
  assert.equal(
    (proposal as any).goal,
    'Persist the dark-mode toggle across reloads and re-run the behavioral test',
    'the synthesized goal text wins over the deterministic stitch',
  );
  assert.equal((proposal as any).requiresOwnerApproval, true, 'still owner-approval-bound');
});

test('proposedNextGoal does NOT override convergence (a clean pass still yields no_goal)', () => {
  const passBundle = buildEvidenceBundle({
    runId: 'run_p',
    verdict: 'pass',
    computerUseEvidence: true,
    acceptanceResults: [{ id: 'A1', status: 'pass' }],
  });
  const out = deriveNextGoal(passBundle, { proposedNextGoal: 'a nice-to-have enhancement' });
  assert.ok('no_goal' in out, 'a clean pass converges even when a nice-to-have was proposed');
});
