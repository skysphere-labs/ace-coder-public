const test = require('node:test');
const assert = require('node:assert/strict');

let automergePolicy: any;
try {
  automergePolicy = require('../automerge-policy.cjs');
} catch {
  automergePolicy = require('../automerge-policy.cts');
}
const { evaluateAutomergeEligibility, AUTOMERGE_HOLD_CODES } = automergePolicy;

function codes(result: any) {
  return result.holds.map((hold: any) => hold.code);
}

test('validated docs-only change is automerge-eligible', () => {
  const result = evaluateAutomergeEligibility({
    changedFiles: ['docs/ops/update-pipeline.md'],
    independentPass: true,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.holds, []);
  assert.equal(result.riskClass, 'trivial');
});

test('validated medium-risk runtime change is automerge-eligible', () => {
  const result = evaluateAutomergeEligibility({
    changedFiles: ['electron/ops-status.cts'],
    independentPass: true,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.riskClass, 'medium');
});

test('missing independent validator PASS always holds', () => {
  const result = evaluateAutomergeEligibility({
    changedFiles: ['docs/notes.md'],
    independentPass: false,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), [AUTOMERGE_HOLD_CODES.VALIDATOR]);
});

test('high-risk paths hold for an operator even with validator PASS', () => {
  const result = evaluateAutomergeEligibility({
    changedFiles: ['electron/integration-gateway.cts'],
    independentPass: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.riskClass, 'high');
  assert.ok(codes(result).includes(AUTOMERGE_HOLD_CODES.HIGH_RISK));
});

test('UI changes hold for an operator; QA evidence narrows the reason but does not lift the gate', () => {
  // src/components/** is the deterministic "ambiguous UI" signal — it
  // classifies high via the computer-use decision, so UI work never
  // automerges on green CI alone (e.g. PR #386-style Mission Board UI).
  const without = evaluateAutomergeEligibility({
    changedFiles: ['src/components/AgentsScreen.tsx'],
    independentPass: true,
  });
  assert.equal(without.eligible, false);
  assert.ok(codes(without).includes(AUTOMERGE_HOLD_CODES.UI));
  assert.ok(codes(without).includes(AUTOMERGE_HOLD_CODES.HIGH_RISK));

  const withQa = evaluateAutomergeEligibility({
    changedFiles: ['src/components/AgentsScreen.tsx'],
    independentPass: true,
    computerUseEvidence: true,
  });
  assert.equal(withQa.eligible, false);
  assert.ok(!codes(withQa).includes(AUTOMERGE_HOLD_CODES.UI));
  assert.ok(codes(withQa).includes(AUTOMERGE_HOLD_CODES.HIGH_RISK));
});

test('explicit highRisk flag forces an operator hold', () => {
  const result = evaluateAutomergeEligibility({
    changedFiles: ['docs/notes.md'],
    independentPass: true,
    highRisk: true,
  });
  assert.equal(result.eligible, false);
  assert.ok(codes(result).includes(AUTOMERGE_HOLD_CODES.HIGH_RISK));
});

test('release-pipeline files hold for an operator even with validator PASS', () => {
  const pipelinePaths = [
    '.github/workflows/release.yml',
    '.github/workflows/promote.yml',
    '.github/workflows/ci-fast.yml',
    'scripts/generate-release-state.cts',
    'scripts/generate-update-manifest.cts',
    'scripts/release-workflow-validator.cts',
    'scripts/update-live-feed-probe.cts',
    'scripts/update-artifact-guard.cts',
    'scripts/stamp-build-info.cts',
    'scripts/r2-transfer.sh',
    'electron/app-updater.cts',
    'electron/update-types.cts',
    'tools/ace/src/automerge-policy.cts',
  ];
  for (const file of pipelinePaths) {
    const result = evaluateAutomergeEligibility({ changedFiles: [file], independentPass: true });
    assert.equal(result.eligible, false, file);
    assert.ok(codes(result).includes(AUTOMERGE_HOLD_CODES.RELEASE_PIPELINE), file);
  }
});

test('autoship and run-ledger control-plane files hold for an operator even with validator PASS', () => {
  const controlPlanePaths = [
    'tools/ace/src/autoship-policy.cts',
    'electron/run-ledger/reconciler.cts',
    'electron/run-ledger/spine-effects.cts',
  ];
  for (const file of controlPlanePaths) {
    const result = evaluateAutomergeEligibility({ changedFiles: [file], independentPass: true });
    assert.equal(result.eligible, false, file);
    assert.ok(codes(result).includes(AUTOMERGE_HOLD_CODES.CONTROL_PLANE), file);
  }
});

test('an at-cap changed-file list holds for an operator (classification may be truncated)', () => {
  const files = Array.from({ length: 100 }, (_, i) => `docs/notes-${i}.md`);
  const result = evaluateAutomergeEligibility({ changedFiles: files, independentPass: true });
  assert.equal(result.eligible, false);
  assert.ok(codes(result).includes(AUTOMERGE_HOLD_CODES.LARGE_DIFF));
});
