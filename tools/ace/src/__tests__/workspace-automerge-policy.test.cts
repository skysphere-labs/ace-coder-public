const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let policyModule: any;
try {
  policyModule = require('../workspace-automerge-policy.cjs');
} catch {
  policyModule = require('../workspace-automerge-policy.cts');
}
const { resolveWorkspaceAutomergePolicy } = policyModule;

test('workspace automerge policy defaults fail-closed', () => {
  const policy = resolveWorkspaceAutomergePolicy({});
  assert.equal(policy.source, 'default');
  assert.equal(policy.enabled, false);
  assert.equal(policy.autoMerge, false);
  assert.equal(policy.requireValidator, true);
  assert.equal(policy.requireChecks, true);
  assert.equal(policy.releaseTrainGuard, true);
  assert.equal(policy.exactAllowPaths, true);
});

test('workspace automerge policy resolves from repo .ace config seam', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-automerge-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.ace', 'workspace-automerge-policy.json'),
    JSON.stringify({
      enabled: true,
      autoMerge: true,
      allowedRiskTiers: ['trivial', 'small'],
      targetBranches: ['main'],
      draftBehavior: 'ready',
      requireValidator: true,
      requireChecks: true,
      releaseTrainGuard: true,
      exactAllowPaths: true,
      allowPaths: ['docs/ops/'],
    }),
  );

  const policy = resolveWorkspaceAutomergePolicy({ projectDir });
  assert.equal(policy.source, '.ace/workspace-automerge-policy.json');
  assert.equal(policy.enabled, true);
  assert.equal(policy.autoMerge, true);
  assert.deepEqual(policy.allowedRiskTiers, ['trivial', 'small']);
  assert.deepEqual(policy.targetBranches, ['main']);
  assert.deepEqual(policy.allowPaths, ['docs/ops/']);
});

test('workspace disabled policy overrides an explicit run autoship opt-in', () => {
  const policy = resolveWorkspaceAutomergePolicy({
    spec: {
      autoShip: { enabled: true, autoMerge: true },
      workspaceAutoMergePolicy: { enabled: false, autoMerge: true },
    },
  });
  assert.equal(policy.source, 'spec');
  assert.equal(policy.enabled, false);
  assert.equal(policy.autoMerge, false);
});
