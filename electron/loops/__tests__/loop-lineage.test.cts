// loop-lineage tests — fold synthetic iteration run states (as produced by the
// run-ledger reconciler) into a LoopLineageState.
// node:test + node:assert/strict so it runs under BOTH vitest and node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-lineage.cts');
} catch {
  mod = require('../loop-lineage.cjs');
}
const { foldLoopLineage, iterationStopState, projectIteration } = mod;

// A reconciler-shaped iteration state. Helper so each fixture tweaks one thing;
// mirrors foldEventsToState's `{ worker, validator, pr, merge, fixback, telemetry }`.
function iterState(overrides: any = {}): any {
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

// ── shape / basics ──────────────────────────────────────────────────────────

test('empty lineage folds to a stable empty state', () => {
  const s = foldLoopLineage('ci-green-loop', []);
  assert.equal(s.loopId, 'ci-green-loop');
  assert.deepEqual(s.iterations, []);
  assert.equal(s.iterationCount, 0);
  assert.equal(s.totalSpendUsd, 0);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.lastProgressAt, null);
  assert.equal(s.lastEvidence, null);
  assert.equal(s.latestRunOutcome, null);
});

test('non-array / null inputs fold defensively, never throw', () => {
  assert.equal(foldLoopLineage(null, null).iterationCount, 0);
  assert.equal(foldLoopLineage(undefined, undefined).loopId, '');
  assert.equal(foldLoopLineage('x', { not: 'array' } as any).iterationCount, 0);
});

test('indexes iterations in order and stamps iterationCount', () => {
  const s = foldLoopLineage('l', [iterState(), iterState(), iterState()]);
  assert.equal(s.iterationCount, 3);
  assert.deepEqual(
    s.iterations.map((i: any) => i.index),
    [0, 1, 2],
  );
});

// ── per-iteration StopState mapping (A3-style fixtures) ──────────────────────

test('merged iteration → DONE (owner-gated merge landed)', () => {
  const iter = projectIteration(
    iterState({ merge: { merged: true, sha: 'abc', headSha: 'h1' } }),
    0,
    null,
  );
  assert.equal(iter.merged, true);
  assert.equal(iter.stopState, 'DONE');
});

test('worker BLOCKED → BLOCKED', () => {
  const iter = projectIteration(iterState({ worker: { done: true, outcome: 'BLOCKED' } }), 0, null);
  assert.equal(iter.stopState, 'BLOCKED');
});

test('validator BLOCK → BLOCKED', () => {
  const iter = projectIteration(
    iterState({ validator: { done: true, outcome: 'BLOCK' } }),
    0,
    null,
  );
  assert.equal(iter.stopState, 'BLOCKED');
});

test('validator REQUEST-CHANGES → NEEDS_OWNER_DECISION', () => {
  const iter = projectIteration(
    iterState({ validator: { done: true, outcome: 'REQUEST-CHANGES' } }),
    0,
    null,
  );
  assert.equal(iter.stopState, 'NEEDS_OWNER_DECISION');
});

test('validator PASS + PR open → READY_FOR_REVIEW (parks owner-gated)', () => {
  const iter = projectIteration(
    iterState({
      validator: { done: true, outcome: 'PASS', computerUseEvidence: true },
      pr: { exists: true, headSha: 'h9' },
    }),
    0,
    null,
  );
  assert.equal(iter.stopState, 'READY_FOR_REVIEW');
  assert.equal(iter.computerUseEvidence, true);
  assert.equal(iter.prExists, true);
});

test('validator PASS without PR → DONE (agentic: evidence is the ship)', () => {
  const iter = projectIteration(
    iterState({ validator: { done: true, outcome: 'PASS' }, pr: { exists: false } }),
    0,
    null,
  );
  assert.equal(iter.stopState, 'DONE');
});

test('worker DONE, no PR, no head, no validator → CLEAN_NOOP', () => {
  const iter = projectIteration(iterState({ worker: { done: true, outcome: 'DONE' } }), 0, null);
  assert.equal(iter.stopState, 'CLEAN_NOOP');
});

test('mid-flight iteration (worker linked, nothing done) → null stopState', () => {
  const iter = projectIteration(iterState(), 0, null);
  assert.equal(iter.stopState, null);
});

test('iterationStopState is exported and matches projectIteration', () => {
  const iter = projectIteration(iterState({ merge: { merged: true } }), 0, null);
  // recompute directly off the projected iteration
  assert.equal(iterationStopState(iter), 'DONE');
});

// ── lineage rollups: spend, tokens, latestRunOutcome, lastEvidence ───────────

test('sums spendUsd and tokens across iterations', () => {
  const s = foldLoopLineage('l', [
    iterState({ telemetry: { totals: { tokens: 100 } }, spendUsd: 0.5 }),
    iterState({ telemetry: { totals: { tokens: 250 } }, spendUsd: 1.25 }),
  ]);
  assert.equal(s.totalTokens, 350);
  assert.equal(s.totalSpendUsd, 1.75);
});

test('spendUsd also reads telemetry.totals.spendUsd', () => {
  const s = foldLoopLineage('l', [
    iterState({ telemetry: { totals: { tokens: 10, spendUsd: 2 } } }),
  ]);
  assert.equal(s.totalSpendUsd, 2);
});

test('latestRunOutcome + lastEvidence reflect the NEWEST iteration', () => {
  const s = foldLoopLineage('l', [
    iterState({ worker: { done: true, outcome: 'BLOCKED' } }), // BLOCKED
    iterState({
      validator: { done: true, outcome: 'PASS' },
      pr: { exists: true, headSha: 'h2' },
    }), // READY_FOR_REVIEW
  ]);
  assert.equal(s.latestRunOutcome, 'READY_FOR_REVIEW');
  assert.ok(s.lastEvidence);
  assert.equal(s.lastEvidence.index, 1);
  assert.equal(s.lastEvidence.stopState, 'READY_FOR_REVIEW');
});

test('latestRunOutcome is null when the newest iteration is still in-flight', () => {
  const s = foldLoopLineage('l', [
    iterState({ validator: { done: true, outcome: 'PASS' }, pr: { exists: true, headSha: 'h1' } }),
    iterState(), // in-flight
  ]);
  assert.equal(s.latestRunOutcome, null);
  assert.equal(s.lastEvidence.index, 1);
});

// ── progress / no-progress detection (harness no-progress semantics) ─────────

test('lastProgressAt tracks the last iteration that moved the loop', () => {
  const s = foldLoopLineage('l', [
    iterState({ currentHeadSha: 'h1', worker: { done: true, outcome: 'DONE' } }), // progress (i0)
    iterState({ currentHeadSha: 'h2', worker: { done: true, outcome: 'DONE' } }), // head moved (i1)
    iterState({ currentHeadSha: 'h2', worker: { done: true, outcome: 'DONE' } }), // SAME head: no progress
  ]);
  assert.equal(s.lastProgressAt, 1);
});

test('a brand-new first iteration that did nothing observable made no progress', () => {
  const s = foldLoopLineage('l', [iterState()]);
  assert.equal(s.lastProgressAt, null);
  assert.equal(s.iterations[0].madeProgress, false);
});

test('first iteration making any observable output counts as progress', () => {
  const s = foldLoopLineage('l', [iterState({ currentHeadSha: 'h1' })]);
  assert.equal(s.lastProgressAt, 0);
  assert.equal(s.iterations[0].madeProgress, true);
});

test('newly-opened PR counts as progress even with same head', () => {
  const s = foldLoopLineage('l', [
    iterState({ currentHeadSha: 'h1' }),
    iterState({ currentHeadSha: 'h1', pr: { exists: true, headSha: 'h1' } }), // newPr
  ]);
  assert.equal(s.lastProgressAt, 1);
  assert.equal(s.iterations[1].madeProgress, true);
});

test('stalled run (identical states) stops advancing lastProgressAt', () => {
  const stalled = iterState({ currentHeadSha: 'h1', worker: { done: true, outcome: 'DONE' } });
  const s = foldLoopLineage('l', [stalled, iterState({ ...stalled }), iterState({ ...stalled })]);
  // i0 progresses; i1, i2 are identical → no further progress.
  assert.equal(s.lastProgressAt, 0);
});

// ── carried fields ───────────────────────────────────────────────────────────

test('carries runId, fixbackAttempts, headSha onto the projection', () => {
  const s = foldLoopLineage('l', [
    iterState({ runId: 'run-7', fixback: { attempts: 2 }, currentHeadSha: 'deadbeef' }),
  ]);
  const i0 = s.iterations[0];
  assert.equal(i0.runId, 'run-7');
  assert.equal(i0.fixbackAttempts, 2);
  assert.equal(i0.headSha, 'deadbeef');
});

test('headSha falls back to merge.headSha then pr.headSha', () => {
  const fromMerge = projectIteration(
    iterState({ currentHeadSha: null, merge: { merged: true, headSha: 'm1' } }),
    0,
    null,
  );
  assert.equal(fromMerge.headSha, 'm1');
  const fromPr = projectIteration(
    iterState({ currentHeadSha: null, pr: { exists: true, headSha: 'p1' } }),
    0,
    null,
  );
  assert.equal(fromPr.headSha, 'p1');
});

// ── agentic (evidence-only) folding — Slice 2 ─────────────────────────────────

test('agentic: a finished worker with a head but no PR/validator folds to terminal DONE', () => {
  const state = iterState({
    worker: { dispatched: true, linked: true, done: true, outcome: 'DONE' },
    currentHeadSha: 'sha-agentic-1',
  });
  const s = foldLoopLineage('intel-loop', [state], { kind: 'agentic' });
  assert.equal(s.iterations[0].stopState, 'DONE');
  assert.equal(s.latestRunOutcome, 'DONE');
  assert.equal(s.iterations[0].workerDone, true);
});

test('the SAME finished-worker-with-head state folds to in-flight (null) for a CODE loop', () => {
  const state = iterState({
    worker: { dispatched: true, linked: true, done: true, outcome: 'DONE' },
    currentHeadSha: 'sha-code-1',
  });
  // default (no kind) == code: a PR is about to open, so still in-flight.
  assert.equal(foldLoopLineage('ci-loop', [state]).iterations[0].stopState, null);
  assert.equal(foldLoopLineage('ci-loop', [state], { kind: 'code' }).iterations[0].stopState, null);
});

test('agentic: a finished worker that produced nothing observable also ships (DONE, not stuck)', () => {
  const state = iterState({
    worker: { dispatched: true, linked: true, done: true, outcome: 'DONE' },
  });
  const s = foldLoopLineage('digest-loop', [state], { kind: 'agentic' });
  assert.equal(s.iterations[0].stopState, 'DONE');
});

test('agentic: a blocked worker is BLOCKED, never a false DONE', () => {
  const state = iterState({
    worker: { dispatched: true, linked: true, done: true, outcome: 'BLOCKED' },
  });
  const s = foldLoopLineage('digest-loop', [state], { kind: 'agentic' });
  assert.equal(s.iterations[0].stopState, 'BLOCKED');
});

test('iterationStopState honors an explicit agentic kind argument', () => {
  const iter = {
    workerOutcome: 'DONE',
    workerDone: true,
    validatorOutcome: 'NONE',
    validatorDone: false,
    prExists: false,
    merged: false,
    headSha: 'h1',
  };
  assert.equal(iterationStopState(iter), null); // code default
  assert.equal(iterationStopState(iter, 'agentic'), 'DONE');
});
