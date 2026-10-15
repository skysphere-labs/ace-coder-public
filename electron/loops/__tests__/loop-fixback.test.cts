// loop-fixback tests — the pure fixback goal composer + run-summary builder for
// the ship loop. node:test + node:assert/strict (runs under the .cts node --test
// runner AND vitest).

const { test } = require('node:test');
const assert = require('node:assert/strict');

let fixbackMod: any;
try {
  fixbackMod = require('../loop-fixback.cts');
} catch {
  fixbackMod = require('../loop-fixback.cjs');
}
const {
  composeShipGoal,
  ciFailureDirective,
  clawpatchDirective,
  isFailingCheckState,
  buildRunSummaryRecord,
} = fixbackMod;

let lineageMod: any;
try {
  lineageMod = require('../loop-lineage.cts');
} catch {
  lineageMod = require('../loop-lineage.cjs');
}
const { foldLoopLineage } = lineageMod;

// A folded LoopIteration stub (only the fields the composer reads).
function iter(overrides: any = {}): any {
  return {
    index: 0,
    runId: 'run-1',
    workerOutcome: 'DONE',
    workerDone: true,
    validatorOutcome: 'PASS',
    validatorDone: true,
    computerUseEvidence: true,
    prExists: true,
    prNumber: 42,
    prUrl: 'https://github.com/o/r/pull/42',
    checkState: 'success',
    merged: false,
    headSha: 'abc123',
    fixbackAttempts: 0,
    tokens: 0,
    spendUsd: 0,
    stopState: 'READY_FOR_REVIEW',
    madeProgress: true,
    ...overrides,
  };
}

test('isFailingCheckState only flags real failures, not success/pending/null', () => {
  assert.equal(isFailingCheckState('failure'), true);
  assert.equal(isFailingCheckState('FAILING'), true);
  assert.equal(isFailingCheckState('timed_out'), true);
  assert.equal(isFailingCheckState('success'), false);
  assert.equal(isFailingCheckState('pending'), false);
  assert.equal(isFailingCheckState(null), false);
  assert.equal(isFailingCheckState(undefined), false);
});

test('CI-failure directive names the PR and points to gh pr checks / gh run view', () => {
  const d = ciFailureDirective(iter({ checkState: 'failure', prNumber: 42 }));
  assert.match(d, /CI is FAILING on PR #42/);
  assert.match(d, /gh pr checks 42/);
  assert.match(d, /gh run view --log-failed/);
});

test('no CI directive when checks are green or no PR', () => {
  assert.equal(ciFailureDirective(iter({ checkState: 'success' })), '');
  assert.equal(ciFailureDirective(iter({ checkState: 'failure', prExists: false })), '');
  assert.equal(ciFailureDirective(null), '');
});

test('composeShipGoal leaves the base goal UNCHANGED for a clean prior iteration', () => {
  const base = 'Iteration 1: ship the thing.';
  assert.equal(composeShipGoal({ baseGoal: base, priorIteration: iter({ checkState: 'success' }) }), base);
  assert.equal(composeShipGoal({ baseGoal: base, priorIteration: null }), base);
});

test('composeShipGoal appends the CI-failure directive on a failing prior', () => {
  const base = 'Iteration 2: ship the thing.';
  const out = composeShipGoal({ baseGoal: base, priorIteration: iter({ checkState: 'failure' }) });
  assert.ok(out.startsWith(base));
  assert.match(out, /CI is FAILING/);
});

test('clawpatch directive inlines a SMALL report and lists blocking findings', () => {
  const d = clawpatchDirective({
    required: true,
    readable: true,
    status: 'fail',
    blockingFindings: [{ severity: 'high', count: 2 }],
    reportText: '# Clawpatch\n- high: unchecked input at foo.ts:10',
    reportPath: '.clawpatch/report.md',
  });
  assert.match(d, /2 high/);
  assert.match(d, /unchecked input at foo\.ts:10/);
});

test('clawpatch directive hands the PATH for a LARGE report instead of inlining', () => {
  const big = 'x'.repeat(5000);
  const d = clawpatchDirective({
    required: true,
    readable: true,
    status: 'fail',
    blockingFindings: [{ severity: 'critical', count: 1 }],
    reportText: big,
    reportPath: '.clawpatch/report.md',
  });
  assert.equal(d.includes(big), false);
  assert.match(d, /\.clawpatch\/report\.md/);
  assert.match(d, /1 critical/);
});

test('clawpatch directive is fail-closed on a REQUIRED but UNREADABLE report', () => {
  const d = clawpatchDirective({ required: true, readable: false, reason: 'report.md missing' });
  assert.match(d, /could not be read/);
  assert.match(d, /Do NOT proceed to merge past it/);
  assert.match(d, /report\.md missing/);
});

test('clawpatch directive is empty for a clean/passing review', () => {
  assert.equal(clawpatchDirective({ required: true, readable: true, status: 'pass', blockingFindings: [] }), '');
  assert.equal(clawpatchDirective(null), '');
});

test('composeShipGoal stacks CI + clawpatch directives', () => {
  const out = composeShipGoal({
    baseGoal: 'Iteration 3: ship.',
    priorIteration: iter({ checkState: 'failure' }),
    clawpatch: { required: true, readable: true, status: 'fail', blockingFindings: [{ severity: 'high', count: 1 }], reportText: 'high finding' },
  });
  assert.match(out, /CI is FAILING/);
  assert.match(out, /1 high/);
});

test('loop-lineage projects prNumber/prUrl/checkState so the composer can read them', () => {
  const state = {
    worker: { done: true, outcome: 'DONE' },
    validator: { done: true, outcome: 'PASS', computerUseEvidence: true },
    pr: { exists: true, number: 77, url: 'https://x/pull/77', checkState: 'failure', headSha: 'deadbeef' },
    merge: { merged: false },
    currentHeadSha: 'deadbeef',
  };
  const folded = foldLoopLineage('loop-ship', [state], { kind: 'code' });
  const it = folded.iterations[0];
  assert.equal(it.prNumber, 77);
  assert.equal(it.prUrl, 'https://x/pull/77');
  assert.equal(it.checkState, 'failure');
  // end-to-end: the folded iteration drives the CI directive.
  assert.match(ciFailureDirective(it), /PR #77/);
});

test('buildRunSummaryRecord assembles a raw-tier dump record (no token) for a merged run', () => {
  const result = {
    invocationId: 'loopinv-loop-ship-1',
    loopId: 'loop-ship',
    loopLineageId: 'lin-1',
    finished: true,
    finishReason: 'converged',
    reasonDetail: 'validator pass + evidence + next-goal {no_goal}',
    iterations: [{ index: 0, runId: 'run-1', goal: 'g', classification: 'converged', reason: 'ok' }],
    lineage: { iterations: [iter({ merged: true, checkState: 'success' })] },
    latestRunOutcome: 'DONE',
  };
  const rec = buildRunSummaryRecord({
    spec: { id: 'loop-ship' },
    result,
    inputs: { goal: 'add a settings toggle', workspace: 'prj_1' },
    projectId: 'prj_1',
    projectDir: '/repo',
    capturedAtRef: '2026-07-02T00:00:00.000Z',
  });
  assert.equal(rec.kind, 'loop_run_summary');
  assert.equal(rec.projectId, 'prj_1');
  assert.equal(rec.projectDir, '/repo');
  assert.match(rec.title, /add a settings toggle/);
  assert.ok(rec.completedItems.some((s: string) => /Merged to main via PR #42/.test(s)));
  // Never leaks a token/secret field.
  assert.equal(JSON.stringify(rec).toLowerCase().includes('ownerauthtoken'), false);
  assert.equal(JSON.stringify(rec).includes('autoship.token'), false);
});
