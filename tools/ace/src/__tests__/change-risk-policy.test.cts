const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyChangeRisk,
  validationBypassEvidenceComplete,
} = require('../change-risk-policy.cts');

test('docs-only <=50 LOC is trivial and skips validator and Clawpatch', () => {
  const policy = classifyChangeRisk({
    changedFiles: ['docs/ops/runbook.md'],
    changedLineCount: 12,
  });
  assert.equal(policy.riskClass, 'trivial');
  assert.equal(policy.validationRequired, false);
  assert.equal(policy.independentValidatorRequired, false);
  assert.equal(policy.clawpatchRequired, false);
});

test('small deterministic runtime <=150 LOC bypasses independent validation', () => {
  const policy = classifyChangeRisk({
    changedFiles: ['tools/ace/src/parser.cts'],
    changedLineCount: 45,
    goal: 'small deterministic parser bugfix',
  });
  assert.equal(policy.riskClass, 'small');
  assert.equal(policy.validationRequired, false);
  assert.deepEqual(policy.evidenceRequired, ['headSha', 'changedFiles', 'testEvidence']);
  assert.equal(
    validationBypassEvidenceComplete(policy, {
      headSha: 'abc',
      changedFiles: ['tools/ace/src/parser.cts'],
      commands: [{ command: 'node --test parser.test.cts', status: 0 }],
    }),
    true
  );
});

test('medium runtime risk requires Clawpatch but never selects an independent validator', () => {
  const medium = classifyChangeRisk({
    changedFiles: ['tools/ace/src/parser.cts'],
    changedLineCount: 220,
    goal: 'Update runtime parser behavior',
  });
  assert.equal(medium.riskClass, 'medium');
  assert.equal(medium.validationRequired, false);
  assert.equal(medium.independentValidatorRequired, false);
  assert.equal(medium.clawpatchRequired, true);

  const low = classifyChangeRisk({
    changedFiles: ['docs/ops/runbook.md'],
    changedLineCount: 12,
  });
  assert.equal(low.riskClass, 'trivial');
  assert.equal(low.clawpatchRequired, false);
});

test('UI/browser path requires computer-use and is high risk', () => {
  const policy = classifyChangeRisk({
    changedFiles: ['src/components/agents/MissionBoardPanel.tsx'],
    changedLineCount: 20,
  });
  assert.equal(policy.riskClass, 'high');
  assert.equal(policy.computerUseRequired, true);
  assert.equal(policy.clawpatchRequired, true);
  assert.equal(policy.independentValidatorRequired, false);
});

test('auth/security/db/schema/migration/release path is high risk', () => {
  for (const file of [
    'electron/auth/session.cts',
    'db/migrations/001.sql',
    'tools/release/package.cts',
  ]) {
    const policy = classifyChangeRisk({ changedFiles: [file], changedLineCount: 10 });
    assert.equal(policy.riskClass, 'high', file);
    assert.equal(policy.clawpatchRequired, true, file);
    assert.equal(policy.independentValidatorRequired, false);
  }
});

test('explicit validation and Clawpatch overrides force requirements', () => {
  const validation = classifyChangeRisk({
    changedFiles: ['docs/readme.md'],
    changedLineCount: 3,
    explicitValidationRequired: true,
  });
  assert.equal(validation.validationRequired, true);
  assert.equal(validation.independentValidatorRequired, true);

  const clawpatch = classifyChangeRisk({
    changedFiles: ['docs/readme.md'],
    changedLineCount: 3,
    explicitClawpatchRequired: true,
  });
  assert.equal(clawpatch.clawpatchRequired, true);
});
