const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMergeGate } = require('../pr-gate.cjs');

function cleanGate(extra: any = {}) {
  return {
    tracked: true,
    expectedBaseBranch: 'main',
    baseBranch: 'main',
    prState: 'OPEN',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    validation: { self: 'PASS' },
    cleanupRequired: false,
    allowedPaths: ['src/**'],
    changedFiles: ['src/app.ts'],
    ...extra,
  };
}

test('evaluateMergeGate blocks draft PRs', () => {
  const gate = evaluateMergeGate(cleanGate({ isDraft: true }));

  assert.equal(gate.readyToMerge, false);
  assert.ok(gate.failures.some((failure: any) => failure.code === 'draft_pr'));
});

test('evaluateMergeGate blocks out-of-scope changed files', () => {
  const gate = evaluateMergeGate(cleanGate({
    changedFiles: ['src/app.ts', 'smoke-lab/index.html'],
  }));

  assert.equal(gate.readyToMerge, false);
  const scope = gate.failures.find((failure: any) => failure.code === 'scope_contamination');
  assert.ok(scope);
  assert.deepEqual(scope.unexpectedFiles, ['smoke-lab/index.html']);
  assert.deepEqual(gate.scope.unexpectedFiles, ['smoke-lab/index.html']);
});

test('evaluateMergeGate passes clean allowed scope without cleanup requirement', () => {
  const gate = evaluateMergeGate(cleanGate());

  assert.equal(gate.readyToMerge, true);
  assert.deepEqual(gate.failures, []);
  assert.equal(gate.scope.ok, true);
  assert.equal(gate.cleanup.required, false);
});

test('evaluateMergeGate lets linked PR base SHA override stale generic base SHA', () => {
  const gate = evaluateMergeGate(cleanGate({
    baseSha: 'live-base-sha',
    expectedPrBaseSha: 'live-base-sha',
    expectedBaseSha: 'stale-base-sha',
  }));

  assert.equal(gate.readyToMerge, true);
  assert.deepEqual(gate.failures, []);
  assert.equal(gate.expectedPr.baseSha, 'live-base-sha');
});

test('evaluateMergeGate blocks while a release train is publishing', () => {
  const gate = evaluateMergeGate(cleanGate({
    releaseTrain: { state: 'publishing', workflow: 'release.yml', activeRuns: 1 },
  }));

  assert.equal(gate.readyToMerge, false);
  assert.deepEqual(gate.failures.map((failure: any) => failure.code), ['release_train_publishing']);
  assert.equal(gate.releaseTrain.state, 'publishing');
});

test('evaluateMergeGate ignores idle/unknown release-train evidence', () => {
  assert.equal(evaluateMergeGate(cleanGate({ releaseTrain: { state: 'idle' } })).readyToMerge, true);
  // Fail-open: a broken train probe must not block (validator + CI stay the hard gates).
  assert.equal(evaluateMergeGate(cleanGate({ releaseTrain: { state: 'unknown' } })).readyToMerge, true);
  assert.equal(evaluateMergeGate(cleanGate()).releaseTrain, null);
});

// Automerge fixtures pin the validated head SHA — exact-head evidence is a
// hard requirement of the lane.
function automergeClean(extra: any = {}) {
  return cleanGate({
    automerge: true,
    expectedPrHeadSha: 'headsha',
    headSha: 'headsha',
    ...extra,
  });
}

test('automerge requires an independent validator PASS on top of a clean gate', () => {
  // Self-validation alone passes the ordinary gate but NOT the automerge lane.
  const gate = evaluateMergeGate(automergeClean());

  assert.equal(gate.automerge, true);
  assert.equal(gate.readyToMerge, false);
  assert.deepEqual(gate.failures.map((failure: any) => failure.code), ['automerge_validator_pass_required']);

  const validated = evaluateMergeGate(automergeClean({
    validation: { self: 'PASS', independent: 'PASS' },
  }));
  assert.equal(validated.readyToMerge, true);
  assert.deepEqual(validated.failures, []);
});

test('automerge without pinned head SHA evidence is blocked', () => {
  // A mission feature that is not PR-backed has no recorded prHeadSha, so a
  // worker could push after validation — the lane fails closed instead.
  const gate = evaluateMergeGate(cleanGate({
    automerge: true,
    validation: { self: 'PASS', independent: 'PASS' },
  }));
  assert.equal(gate.readyToMerge, false);
  assert.deepEqual(
    gate.failures.map((failure: any) => failure.code),
    ['automerge_exact_head_evidence_required']
  );
});

test('automerge holds high-risk, release-pipeline, and UI changes for an operator even when validated', () => {
  const highRisk = evaluateMergeGate(automergeClean({
    validation: { self: 'PASS', independent: 'PASS' },
    allowedPaths: ['electron/**'],
    changedFiles: ['electron/integration-gateway.cts'],
  }));
  assert.equal(highRisk.readyToMerge, false);
  assert.ok(highRisk.failures.some((failure: any) => failure.code === 'automerge_operator_required_high_risk'));

  const pipeline = evaluateMergeGate(automergeClean({
    validation: { self: 'PASS', independent: 'PASS' },
    allowedPaths: ['.github/**'],
    changedFiles: ['.github/workflows/release.yml'],
  }));
  assert.equal(pipeline.readyToMerge, false);
  assert.ok(pipeline.failures.some((failure: any) => failure.code === 'automerge_operator_required_release_pipeline'));

  const ui = evaluateMergeGate(automergeClean({
    validation: { self: 'PASS', independent: 'PASS' },
    changedFiles: ['src/components/AgentsScreen.tsx'],
  }));
  assert.equal(ui.readyToMerge, false);
  assert.ok(ui.failures.some((failure: any) => failure.code === 'automerge_operator_required_ui'));
});

test('an otherwise-eligible automerge still blocks on a publishing train', () => {
  const gate = evaluateMergeGate(automergeClean({
    validation: { self: 'PASS', independent: 'PASS' },
    releaseTrain: { state: 'publishing', activeRuns: 2 },
  }));
  assert.equal(gate.readyToMerge, false);
  assert.deepEqual(gate.failures.map((failure: any) => failure.code), ['release_train_publishing']);
});

test('train publishing and eligibility holds report together', () => {
  const gate = evaluateMergeGate(automergeClean({
    releaseTrain: { state: 'publishing', activeRuns: 1 },
  }));
  assert.equal(gate.readyToMerge, false);
  assert.deepEqual(
    gate.failures.map((failure: any) => failure.code),
    ['release_train_publishing', 'automerge_validator_pass_required']
  );
});
