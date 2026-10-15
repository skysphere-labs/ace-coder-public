// loop-lineage regression — a head that moves AFTER a prior PASS validation must
// NOT count as progress (it invalidates that validation). This is the WS-F fix to
// projectIteration's `headMoved` progress signal (loop-lineage.cts): a post-PASS
// head bump used to reset the no-progress detector, so the validate/park closeout
// loop never settled. node:test + node:assert/strict so it runs under the repo's
// .cts runner (node --test --require tsx/cjs) like the sibling loop tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod;
try {
  mod = require('../loop-lineage.cts');
} catch {
  mod = require('../loop-lineage.cjs');
}
const { foldLoopLineage } = mod;

// Reconciler-shaped iteration state, mirrors foldEventsToState (matches the helper
// in loop-lineage.test.cts).
function iterState(overrides = {}) {
  return {
    worker: { dispatched: true, linked: true, done: false, outcome: 'NONE' },
    validator: { dispatched: false, done: false, outcome: 'NONE', computerUseEvidence: false },
    pr: { exists: false, mergeable: null, checkState: null, headSha: null },
    merge: { merged: false, sha: null, cleanedUp: false, headSha: null },
    fixback: { attempts: 0 },
    telemetry: { entries: [], latest: null, totals: { runs: 0, commands: 0, durationMs: 0, tokens: 0 } },
    currentHeadSha: null,
    ...overrides,
  };
}

test('a head that moves AFTER a prior PASS validation does NOT count as progress', () => {
  const s = foldLoopLineage('loop-validate-park', [
    // i0: validator PASS on head h1 with a PR open → READY_FOR_REVIEW (progress).
    iterState({ validator: { done: true, outcome: 'PASS' }, pr: { exists: true, headSha: 'h1' }, currentHeadSha: 'h1' }),
    // i1: the head bumped to h2 with NO new validator verdict / PR / merge — this
    // invalidates the prior PASS, so it must NOT read as progress.
    iterState({ pr: { exists: true, headSha: 'h1' }, currentHeadSha: 'h2', worker: { done: true, outcome: 'DONE' } }),
  ]);
  assert.equal(s.iterations[1].madeProgress, false, 'post-PASS head bump must not be progress');
  // lastProgressAt stays at the PASS iteration; the loop can now detect no-progress.
  assert.equal(s.lastProgressAt, 0);
});

test('an UN-validated head move still counts as progress (ordinary builder advance)', () => {
  const s = foldLoopLineage('l', [
    iterState({ currentHeadSha: 'h1', worker: { done: true, outcome: 'DONE' } }),
    iterState({ currentHeadSha: 'h2', worker: { done: true, outcome: 'DONE' } }),
  ]);
  assert.equal(s.iterations[1].madeProgress, true, 'un-validated head move is still progress');
  assert.equal(s.lastProgressAt, 1);
});

test('a head move after a REQUEST-CHANGES verdict still counts (that is the fixback)', () => {
  const s = foldLoopLineage('l', [
    // i0: validator REQUEST-CHANGES on head h1 (not a PASS, so nothing to invalidate).
    iterState({ validator: { done: true, outcome: 'REQUEST-CHANGES' }, pr: { exists: true, headSha: 'h1' }, currentHeadSha: 'h1' }),
    // i1: the builder responds by moving the head to h2 — that IS progress.
    iterState({ pr: { exists: true, headSha: 'h1' }, currentHeadSha: 'h2', worker: { done: true, outcome: 'DONE' } }),
  ]);
  assert.equal(s.iterations[1].madeProgress, true, 'a fixback head move after request-changes is progress');
  assert.equal(s.lastProgressAt, 1);
});

test('a new validator verdict on the moved head is still progress even after a prior PASS', () => {
  const s = foldLoopLineage('l', [
    // i0: PASS on h1.
    iterState({ validator: { done: true, outcome: 'PASS' }, pr: { exists: true, headSha: 'h1' }, currentHeadSha: 'h1' }),
    // i1: head moved to h2 AND the validator re-ran (BLOCK). The head-bump itself is
    // suppressed, but the NEW validator verdict is a genuine progress signal.
    iterState({ validator: { done: true, outcome: 'BLOCK' }, pr: { exists: true, headSha: 'h2' }, currentHeadSha: 'h2' }),
  ]);
  assert.equal(s.iterations[1].madeProgress, true, 'a new validator verdict is progress regardless of the head-move suppression');
  assert.equal(s.lastProgressAt, 1);
});
