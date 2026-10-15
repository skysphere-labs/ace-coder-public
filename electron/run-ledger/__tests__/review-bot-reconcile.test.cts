// review-bot-reconcile.test — the review-bot ('validate' / PR Validator) gate
// facts fold into state.pr.reviewBot, and a FAILING verdict routes the findings
// back into the ORIGINAL worker stream as an automatic same-stream fixback
// round (contractual review closure — no operator forwarding).

const test = require('node:test');
const assert = require('node:assert/strict');

let reconcilerModule: any;
try { reconcilerModule = require('../reconciler.cjs'); } catch { reconcilerModule = require('../reconciler.cts'); }
const { foldEventsToState } = reconcilerModule;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
const { nextActionForFeature, NEXT_ACTIONS } = orchestrationPolicy;

function eventsForFailingReviewBot(spec: any) {
  return [
    { type: 'run.created', payload: { spec } },
    { type: 'worker.dispatched', payload: {} },
    { type: 'worker.dispatch.linked', payload: { taskId: 'tsk_1', streamId: 'str_1', branch: 'feat/x' } },
    { type: 'worker.completed', payload: { outcome: 'DONE', headSha: 'head-1' } },
    { type: 'validator.dispatched', payload: {} },
    { type: 'validator.dispatch.linked', payload: { taskId: 'tsk_v', streamId: 'str_v' } },
    {
      type: 'validator.completed',
      payload: { record: { detail: 'VERDICT=pass {"verdict":"pass"}' }, validatedHeadSha: 'head-1' },
    },
    {
      type: 'gate.evaluated',
      payload: {
        prExists: true,
        prNumber: 7,
        prUrl: 'https://example.invalid/pr/7',
        checkState: 'failure',
        mergeable: 'MERGEABLE',
        headSha: 'head-1',
        reviewBot: { name: 'validate', state: 'failure', score: 2, mustFix: ['fix the empty-list crash'] },
      },
    },
  ];
}

test('GATE_EVALUATED folds payload.reviewBot into state.pr.reviewBot', () => {
  const state = foldEventsToState(eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } }));
  assert.deepEqual(state.pr.reviewBot, {
    name: 'validate',
    state: 'failure',
    score: 2,
    mustFix: ['fix the empty-list crash'],
  });
});

test('failing review-bot verdict → same-stream fixback round (no opt-in required)', () => {
  const state = foldEventsToState(eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } }));
  const decision = nextActionForFeature(state);
  assert.equal(decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(decision.reason, /review-bot check 'validate' is failing/);
  assert.match(decision.reason, /original worker stream/);
});

test('failing review-bot verdict with fixback in flight → sync the original stream', () => {
  const events: any[] = eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } });
  events.push({ type: 'fixback.dispatched', payload: {} });
  const state = foldEventsToState(events);
  const decision = nextActionForFeature(state);
  assert.equal(decision.next, NEXT_ACTIONS.SYNC_WORKER);
  assert.match(decision.reason, /fixback is in flight/);
});

test('a fixback-round completion makes the recorded gate facts stale → GATE re-read, never a blind next round', () => {
  const events: any[] = eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } });
  events.push({ type: 'fixback.dispatched', payload: {} });
  // Production-shaped round completion: NO head SHA on the record.
  events.push({ type: 'worker.completed', payload: { outcome: 'DONE', detail: 'fixback round 1 — fixed' } });
  const state = foldEventsToState(events);
  assert.equal(state.review.roundClosedSinceGate, true);
  const decision = nextActionForFeature(state);
  assert.equal(decision.next, NEXT_ACTIONS.GATE, 'frozen failing facts never burn another round');
  assert.match(decision.reason, /re-read at the live head/);
});

test('failing review-bot verdict past the fixback cap → bounded blocker (on FRESH facts)', () => {
  const events: any[] = eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } });
  for (let i = 0; i < 3; i += 1) {
    events.push({ type: 'fixback.dispatched', payload: {} });
    events.push({ type: 'worker.completed', payload: { outcome: 'DONE', detail: `fixback round ${i + 1}` } });
    // Each round is followed by a FRESH gate read that still reports failure
    // at the validated head (e.g. the round never actually pushed a fix).
    events.push({
      type: 'gate.evaluated',
      payload: {
        prExists: true,
        prNumber: 7,
        checkState: 'failure',
        mergeable: 'MERGEABLE',
        headSha: 'head-1',
        reviewBot: { name: 'validate', state: 'failure', score: 2 },
      },
    });
  }
  const state = foldEventsToState(events);
  assert.equal(state.review.roundClosedSinceGate, false, 'fresh facts cleared the staleness flag');
  const decision = nextActionForFeature(state);
  assert.equal(decision.next, NEXT_ACTIONS.BLOCKED);
  assert.match(decision.reason, /fixback retry cap/);
});

test('review.requested folds the requested head for once-per-head idempotency', () => {
  const events: any[] = eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } });
  events.push({ type: 'review.requested', payload: { headSha: 'head-1', prNumber: 7 } });
  const state = foldEventsToState(events);
  assert.equal(state.review.requestedHeadSha, 'head-1');
  assert.equal(state.review.requests, 1);
  // A later request for a NEW head (post-push) supersedes.
  events.push({ type: 'review.requested', payload: { headSha: 'head-2', prNumber: 7 } });
  const later = foldEventsToState(events);
  assert.equal(later.review.requestedHeadSha, 'head-2');
  assert.equal(later.review.requests, 2);
});

test('gate evidence is current-head, clears stale facts, and never dispatches validator/fixback', () => {
  const events: any[] = [
    {
      type: 'run.created',
      payload: {
        spec: {
          taskType: 'no-code',
          roleMode: 'no-code',
          goal: 'no-code smoke diagnostic',
        },
      },
    },
    { type: 'worker.dispatched', payload: {} },
    { type: 'worker.dispatch.linked', payload: { taskId: 'tsk_1', streamId: 'str_1' } },
    { type: 'worker.completed', payload: { outcome: 'DONE', headSha: 'head-2' } },
  ];
  events.push({
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: 'head-2',
      validation: { self: 'PASS', headSha: 'head-2' },
      reviewBot: { name: 'validate', state: 'success', headSha: 'head-2' },
    },
  });
  const current = foldEventsToState(events);
  assert.equal(nextActionForFeature(current).next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);

  events.push({
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: 'head-3',
    },
  });
  const staleCleared = foldEventsToState(events);
  const decision = nextActionForFeature(staleCleared);
  assert.equal(staleCleared.pr.validation, null);
  assert.equal(staleCleared.pr.reviewBot, null);
  assert.equal(decision.next, NEXT_ACTIONS.GATE);
  assert.notEqual(decision.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
  assert.notEqual(decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});

test('a headless gate event never clears round-closure staleness (degraded read cannot re-authorize a round)', () => {
  const events: any[] = eventsForFailingReviewBot({ goal: 'g', scope: { workspaceId: 'prj_1' } });
  events.push({ type: 'fixback.dispatched', payload: {} });
  events.push({ type: 'worker.completed', payload: { outcome: 'DONE', detail: 'fixback round 1 — fixed' } });
  events.push({ type: 'gate.evaluated', payload: { prExists: true, checkState: 'failure' } }); // no headSha
  const state = foldEventsToState(events);
  assert.equal(state.review.roundClosedSinceGate, true, 'headless read keeps the staleness flag');
  const decision = nextActionForFeature(state);
  assert.notEqual(decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
});
