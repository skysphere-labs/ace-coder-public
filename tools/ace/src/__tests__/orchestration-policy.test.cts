const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextActionForFeature,
  NEXT_ACTIONS,
} = require('../orchestration-policy.cts');

// Hermes is required to use nextActionForFeature instead of inferring from
// wake-brief, dormant streams, awaiting-input, or chat-history guessing.
// These tests pin the eight-state contract so any drift surfaces loudly.

test('nextActionForFeature: no worker dispatched → dispatch_goal_worker', () => {
  const r = nextActionForFeature({});
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_GOAL_WORKER);
  assert.match(r.reason, /no worker dispatched/);
  assert.ok(r.requiredEvidence.includes('Goal Ledger initialised'));
});

test('nextActionForFeature: worker dispatched but not done → sync_worker', () => {
  const r = nextActionForFeature({ worker: { dispatched: true, done: false } });
  assert.equal(r.next, NEXT_ACTIONS.SYNC_WORKER);
  assert.match(r.reason, /no DONE\/BLOCKED trailer/);
});

test('nextActionForFeature: worker BLOCKED → blocked (no auto-fixback at worker layer)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'BLOCKED' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.reason, /worker returned BLOCKED/);
});

test('nextActionForFeature: worker DONE advances to PR gates without a validator', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.ok(
    r.requiredEvidence.some((e: string) => /same-worker native review/.test(e)),
    'requires review in the original worker lane'
  );
});

test('nextActionForFeature: current-head native review and ReviewBot PASS are enforced before release', () => {
  const base = {
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    currentHeadSha: 'head-2',
    spec: { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' },
    pr: {
      exists: true,
      headSha: 'head-2',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      validation: { self: 'PASS', headSha: 'head-2' },
    },
  };

  const missingReviewBot = nextActionForFeature(base);
  assert.equal(missingReviewBot.next, NEXT_ACTIONS.GATE);
  assert.notEqual(missingReviewBot.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(missingReviewBot.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);

  const staleReviewBot = nextActionForFeature({
    ...base,
    pr: { ...base.pr, reviewBot: { name: 'validate', state: 'success', headSha: 'head-1' } },
  });
  assert.equal(staleReviewBot.next, NEXT_ACTIONS.GATE);

  const reviewed = nextActionForFeature({
    ...base,
    pr: { ...base.pr, reviewBot: { name: 'validate', state: 'success', headSha: 'head-2' } },
  });
  assert.equal(reviewed.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);
});

test('nextActionForFeature: medium/high Clawpatch evidence is a hard release gate', () => {
  const reviewedPr = {
    exists: true,
    headSha: 'head-2',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: 'PASS', headSha: 'head-2' },
    reviewBot: { name: 'validate', state: 'success', headSha: 'head-2' },
  };
  for (const changedFiles of [
    ['tools/ace/src/parser.cts'],
    ['electron/auth/session.cts'],
  ]) {
    const missing = nextActionForFeature({
      worker: { dispatched: true, done: true, outcome: 'DONE' },
      currentHeadSha: 'head-2',
      spec: { changedFiles, changedLineCount: 220 },
      pr: reviewedPr,
    });
    assert.equal(missing.clawpatchRequired, true, changedFiles[0]);
    assert.equal(missing.next, NEXT_ACTIONS.GATE, changedFiles[0]);
    assert.notEqual(missing.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
    assert.notEqual(missing.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);

    const missingHead = nextActionForFeature({
      worker: { dispatched: true, done: true, outcome: 'DONE' },
      currentHeadSha: 'head-2',
      spec: { changedFiles, changedLineCount: 220 },
      pr: {
        ...reviewedPr,
        clawpatch: {
          enforced: true,
          present: true,
          status: 'pass',
          inconclusive: false,
          blockingFindings: [],
        },
      },
    });
    assert.equal(missingHead.next, NEXT_ACTIONS.GATE, `${changedFiles[0]}: missing Clawpatch head`);
    assert.notEqual(missingHead.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
    assert.notEqual(missingHead.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);

    const stale = nextActionForFeature({
      worker: { dispatched: true, done: true, outcome: 'DONE' },
      currentHeadSha: 'head-2',
      spec: { changedFiles, changedLineCount: 220 },
      pr: {
        ...reviewedPr,
        clawpatch: {
          enforced: true,
          present: true,
          status: 'pass',
          inconclusive: false,
          blockingFindings: [],
          validatedHeadSha: 'head-1',
        },
      },
    });
    assert.equal(stale.next, NEXT_ACTIONS.GATE, `${changedFiles[0]}: stale Clawpatch head`);
    assert.notEqual(stale.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
    assert.notEqual(stale.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);

    const clean = nextActionForFeature({
      worker: { dispatched: true, done: true, outcome: 'DONE' },
      currentHeadSha: 'head-2',
      spec: { changedFiles, changedLineCount: 220 },
      pr: {
        ...reviewedPr,
        clawpatch: {
          enforced: true,
          present: true,
          status: 'pass',
          inconclusive: false,
          blockingFindings: [],
          validatedHeadSha: 'head-2',
        },
      },
    });
    assert.equal(clean.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, changedFiles[0]);
  }
});

test('nextActionForFeature: high-risk UI computer-use evidence gates without agent dispatch', () => {
  const base = {
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    currentHeadSha: 'head-ui',
    spec: { changedFiles: ['src/components/App.tsx'], changedLineCount: 20 },
    pr: {
      exists: true,
      headSha: 'head-ui',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      validation: { self: 'PASS', headSha: 'head-ui' },
      reviewBot: { name: 'validate', state: 'success', headSha: 'head-ui' },
      clawpatch: {
        enforced: true,
        present: true,
        status: 'pass',
        inconclusive: false,
        blockingFindings: [],
        validatedHeadSha: 'head-ui',
      },
    },
  };
  const missing = nextActionForFeature(base);
  assert.equal(missing.next, NEXT_ACTIONS.GATE);
  assert.notEqual(missing.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(missing.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);

  const evidenced = nextActionForFeature({
    ...base,
    pr: {
      ...base.pr,
      computerUseEvidence: { verified: true, headSha: 'head-ui', artifactPath: '.ace/computer-use/completion.json' },
    },
  });
  assert.equal(evidenced.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);
});

test('nextActionForFeature: worker DONE + trivial no-code bypass does not dispatch validator', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    spec: { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' },
    validationBypass: { allowed: true },
    pr: { exists: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.equal(r.validationRequired, false);
  assert.equal(r.validationBypass.evidenceComplete, true);
});

test('nextActionForFeature: worker DONE + high risk gates without a validator', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    spec: { changedFiles: ['electron/auth/session.cts'] },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.equal(r.riskClass, 'high');
  assert.equal(r.independentValidatorRequired, false);
  assert.equal(r.clawpatchRequired, true);
});

test('nextActionForFeature: policy inputs never auto-dispatch a validator', () => {
  const cases = [
    [{ taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' }, NEXT_ACTIONS.GATE],
    [{ changedFiles: ['tools/ace/src/parser.cts'], changedLineCount: 220, goal: 'Update runtime parser behavior' }, NEXT_ACTIONS.GATE],
    [{ changedFiles: ['electron/auth/session.cts'] }, NEXT_ACTIONS.GATE],
    [{ priorValidationFailed: true }, NEXT_ACTIONS.GATE],
    [{ validationRequired: true }, NEXT_ACTIONS.GATE],
    [{ validation: { required: true } }, NEXT_ACTIONS.GATE],
  ];
  for (const [spec, expectedNext] of cases) {
    const r = nextActionForFeature({
      worker: { dispatched: true, done: true, outcome: 'DONE' },
      spec,
    });
    assert.equal(r.next, expectedNext);
    assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  }
});

test('nextActionForFeature: validator dispatched but not done → sync_worker', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.SYNC_WORKER);
  assert.match(r.reason, /validator is dispatched but no verdict/);
});

test('nextActionForFeature: validator FIXBACK_REQUIRED returns findings to the original worker stream', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'FIXBACK_REQUIRED' },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.reason, /original worker stream/);
  assert.match(r.reason, /round 1\/3/);
});

test('nextActionForFeature: validator REQUEST-CHANGES (reconciler token) also routes to same-stream fixback', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'REQUEST-CHANGES' },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: fixback in flight after validator findings → sync the original stream', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE', fixbackInFlight: true },
    validator: { dispatched: true, done: true, outcome: 'FIXBACK_REQUIRED' },
    fixback: { attempts: 1 },
  });
  assert.equal(r.next, NEXT_ACTIONS.SYNC_WORKER);
  assert.match(r.reason, /fixback is in flight/);
});

test('nextActionForFeature: validator FIXBACK_REQUIRED needs no opt-in (closure is the default)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'FIXBACK_REQUIRED' },
    fixback: { attempts: 0 },
    spec: {},
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: validator findings past the fixback cap are a bounded blocker', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'FIXBACK_REQUIRED' },
    fixback: { attempts: 99 },
    spec: {},
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /fixback retry cap/);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: validator BLOCKED_SCOPE → blocked (no fixback)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'BLOCKED_SCOPE' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /blocked-scope/);
});

test('nextActionForFeature: validator COMPUTER_USE_REQUIRED → blocked (need evidence)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'COMPUTER_USE_REQUIRED' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.ok(
    r.requiredEvidence.some((e: string) => /screenshot/.test(e)),
    'requires a screenshot to unblock'
  );
});

test('nextActionForFeature: validator MANUAL_REQUIRED → blocked', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'MANUAL_REQUIRED' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /manual-required/);
});

test('nextActionForFeature: validator PASS but computer-use required without evidence → blocked', () => {
  // Validator returned bare DONE but the feature is UI: gate must refuse PASS
  // until evidence is recorded. We tell the policy by setting
  // computerUseRequired:true on the validator state.
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: {
      dispatched: true,
      done: true,
      outcome: 'PASS',
      computerUseRequired: true,
      computerUseEvidence: null,
    },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /computer-use evidence/);
});

test('nextActionForFeature: validator PASS with no live PR review evidence → gate', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS', validatedHeadSha: 'head-1' },
    pr: { exists: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: exact-head PASS suppresses new validator', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS', validatedHeadSha: 'head-1' },
    currentHeadSha: 'head-1',
    spec: { changedFiles: ['electron/missions.cts'] },
    pr: { exists: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
});

test('nextActionForFeature: old-head PASS waits for manual current-head validation', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS', validatedHeadSha: 'old-head' },
    currentHeadSha: 'new-head',
    spec: { changedFiles: ['electron/missions.cts'] },
    pr: { exists: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.equal(r.staleValidation, true);
});

test('nextActionForFeature: PR exists but checks pending → gate', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'pending' },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
});

test('nextActionForFeature: PR conflicting → gate', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'success', mergeable: 'CONFLICTING' },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
});

test('nextActionForFeature: PR green and mergeable but not merged → dispatch_release_goal', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS', validatedHeadSha: 'head-1' },
    currentHeadSha: 'head-1',
    spec: { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' },
    pr: {
      exists: true,
      headSha: 'head-1',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      validation: { self: 'PASS', headSha: 'head-1' },
      reviewBot: { name: 'validate', state: 'success', headSha: 'head-1' },
    },
    merge: { merged: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);
  assert.ok(r.requiredEvidence.some((e: string) => /integrate pr-merge/.test(e)));
});

test('nextActionForFeature: merged but cleanup pending → dispatch_release_goal (cleanup phase)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'success', mergeable: 'MERGEABLE' },
    merge: { merged: true, sha: 'abc1234', cleanedUp: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);
  assert.ok(r.requiredEvidence.some((e: string) => /integrate cleanup/.test(e)));
});

test('nextActionForFeature: merged + cleaned up → nothing', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'success', mergeable: 'MERGEABLE' },
    merge: { merged: true, sha: 'abc1234', cleanedUp: true },
  });
  assert.equal(r.next, NEXT_ACTIONS.NOTHING);
  assert.match(r.reason, /merged and cleaned up/);
});

test('nextActionForFeature: validator returns no trailer → blocked', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'NONE' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
});

test('nextActionForFeature: spec hint surfaces computer-use requirement even if validator omitted the flag', () => {
  // Validator state did not declare computerUseRequired, but the underlying
  // spec is a UI feature. The policy must still gate the PASS verdict.
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: {
      dispatched: true,
      done: true,
      outcome: 'PASS',
      computerUseRequired: null,
      computerUseEvidence: null,
    },
    spec: { taskClass: 'ui_product_design' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
});

// Failing protected checks route the findings back into the ORIGINAL worker
// stream automatically (contractual review closure) — bounded by the fixback
// cap, no opt-in flag, and never a standalone validator agent.

test('nextActionForFeature: PR checks FAILING → same-stream fixback round', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'failure' },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.reason, /PR checks are failing/);
  assert.match(r.reason, /original worker stream/);
  assert.match(r.reason, /round 1\/3/);
});

test('nextActionForFeature: failed checks after worker completion fixback the original stream, never a validator', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    pr: {
      exists: true,
      checkState: 'failure',
      reviewBot: { name: 'validate', state: 'failure' },
    },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.match(r.reason, /original worker stream/);
});

test('nextActionForFeature: review-bot check FAILING → same-stream fixback naming the check', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: {
      exists: true,
      checkState: 'failure',
      reviewBot: { name: 'validate', state: 'failure', score: 2, mustFix: ['handle the empty list'] },
    },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.reason, /review-bot check 'validate' is failing/);
  assert.match(r.reason, /original worker stream/);
});

test('nextActionForFeature: fixback in flight for failing checks → sync the original stream', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE', fixbackInFlight: true },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'failure' },
    fixback: { attempts: 1 },
  });
  assert.equal(r.next, NEXT_ACTIONS.SYNC_WORKER);
  assert.match(r.reason, /fixback is in flight/);
});

test('nextActionForFeature: draft PR is non-terminal — gate to mark ready + request ready-head review', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'pending', isDraft: true },
    fixback: { attempts: 0 },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.match(r.reason, /draft/);
  assert.match(r.reason, /ready-head ReviewBot \+ \/codex review/);
});

test('nextActionForFeature: PR checks PENDING + fixback armed → gate (pending is not a failure)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'pending' },
    fixback: { attempts: 0 },
    spec: { allowFixbackWorker: true },
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
});

test('nextActionForFeature: PR checks FAILING past the fixback cap are a bounded blocker', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'failure' },
    fixback: { attempts: 99 },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /fixback retry cap/);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: merged run with stale failing checkState never fixbacks (merge evidence wins)', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'PASS' },
    pr: { exists: true, checkState: 'failure' },
    merge: { merged: true, sha: 'abc1234', cleanedUp: true },
    fixback: { attempts: 0 },
    spec: { allowFixbackWorker: true },
  });
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('nextActionForFeature: a FAILED fixback dispatch is a bounded blocker — never a replacement goal worker', () => {
  const r = nextActionForFeature({
    worker: { dispatched: false, done: true, outcome: 'DONE', dispatchFailed: true, dispatchFailedCount: 1, dispatchError: 'stream gone' },
    validator: { dispatched: false, done: false, outcome: 'NONE' },
    pr: { exists: true, checkState: 'failure', headSha: 'h1' },
    fixback: { attempts: 1 },
    currentHeadSha: 'h1',
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /fixback dispatch failed/);
  assert.match(r.reason, /never spawn a replacement lane/);
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_GOAL_WORKER);
});

test('nextActionForFeature: a fixback round closed since the gate read → GATE re-read, not another round', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: false, done: false, outcome: 'NONE' },
    pr: { exists: true, checkState: 'failure', headSha: 'h1', reviewBot: { name: 'validate', state: 'failure', headSha: 'h1' } },
    fixback: { attempts: 1 },
    review: { roundClosedSinceGate: true },
    currentHeadSha: 'h1',
  });
  assert.equal(r.next, NEXT_ACTIONS.GATE);
  assert.match(r.reason, /read before the last fixback round completed/);
});

test('nextActionForFeature: validator findings superseded by a closed round (no head on completions) → gate walk, not re-fix', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatched: true, done: true, outcome: 'FIXBACK_REQUIRED' },
    fixback: { attempts: 1 },
    review: { roundClosedSinceVerdict: true },
  });
  assert.notEqual(r.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});
