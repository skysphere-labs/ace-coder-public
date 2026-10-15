const test = require('node:test');
const assert = require('node:assert/strict');

let autoshipPolicy: any;
try {
  autoshipPolicy = require('../autoship-policy.cjs');
} catch {
  autoshipPolicy = require('../autoship-policy.cts');
}
const { AUTOSHIP_STATUSES, evaluateAutoshipPolicy } = autoshipPolicy;

function gate(files = ['electron/ops-status.cts']) {
  return {
    ok: true,
    validation: { independent: 'PASS', required: true },
    checkState: 'success',
    baseBranch: 'main',
    scope: { changedFiles: files, allowedPaths: ['electron/', 'docs/'] },
  };
}

test('explicit low-risk autoship policy allows auto-merge', () => {
  const result = evaluateAutoshipPolicy({
    spec: { autoShip: { enabled: true, autoMerge: true } },
    state: { pr: { changedFiles: ['electron/ops-status.cts'] }, validator: {} },
    gate: gate(['electron/ops-status.cts']),
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.READY);
  assert.equal(result.autoMergeAllowed, true);
  assert.equal(result.requiresOwnerApproval, false);
});

test('workspace policy enables eligible autoship without per-run autoShip', () => {
  const result = evaluateAutoshipPolicy({
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        allowedRiskTiers: ['trivial', 'small', 'medium'],
        targetBranches: ['main'],
        draftBehavior: 'ready',
        requireValidator: true,
        requireChecks: true,
        releaseTrainGuard: true,
        exactAllowPaths: true,
        allowPaths: ['electron/'],
      },
    },
    state: { pr: { baseBranch: 'main', changedFiles: ['electron/ops-status.cts'] }, validator: {} },
    gate: gate(['electron/ops-status.cts']),
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.READY);
  assert.equal(result.autoMergeAllowed, true);
  assert.equal(result.requiresOwnerApproval, false);
  assert.equal(result.releaseTrainGuard, true);
});

test('autoship is fail-closed when not explicitly enabled', () => {
  const result = evaluateAutoshipPolicy({
    spec: {},
    state: { pr: { changedFiles: ['docs/notes.md'] } },
    gate: gate(['docs/notes.md']),
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.PARKED);
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(result.requiresOwnerApproval, true);
  assert.equal(result.reasons[0].code, 'autoship_not_enabled');
});

test('legacy autoMerge alone is not an autoship opt-in', () => {
  const result = evaluateAutoshipPolicy({
    spec: { autoMerge: true },
    state: { pr: { changedFiles: ['docs/notes.md'] } },
    gate: gate(['docs/notes.md']),
  });
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(result.reasons[0].code, 'autoship_not_enabled');
});

test('disabled workspace policy overrides per-run autoship opt-in', () => {
  const result = evaluateAutoshipPolicy({
    spec: {
      autoShip: { enabled: true, autoMerge: true },
      workspaceAutoMergePolicy: { enabled: false, autoMerge: true },
    },
    state: { pr: { baseBranch: 'main', changedFiles: ['docs/notes.md'] } },
    gate: gate(['docs/notes.md']),
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.PARKED);
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(result.reasons[0].code, 'autoship_not_enabled');
});

test('high-risk paths park for owner review even with independent PASS', () => {
  const result = evaluateAutoshipPolicy({
    spec: { autoShip: true },
    state: { pr: { changedFiles: ['electron/integration-gateway.cts'] } },
    gate: gate(['electron/integration-gateway.cts']),
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.PARKED);
  assert.equal(result.autoMergeAllowed, false);
  assert.ok(result.reasons.some((reason: any) => reason.code === 'automerge_operator_required_high_risk'));
});

test('workspace policy parks disallowed risk tiers and draft PRs', () => {
  const disallowedRisk = evaluateAutoshipPolicy({
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        allowedRiskTiers: ['trivial', 'small'],
        targetBranches: ['main'],
        allowPaths: ['electron/'],
      },
    },
    state: { pr: { baseBranch: 'main', changedFiles: ['electron/ops-status.cts'] } },
    gate: gate(['electron/ops-status.cts']),
  });
  assert.equal(disallowedRisk.status, AUTOSHIP_STATUSES.PARKED);
  assert.ok(disallowedRisk.reasons.some((reason: any) => reason.code === 'workspace_policy_risk_tier_hold'));

  const draft = evaluateAutoshipPolicy({
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        allowedRiskTiers: ['trivial', 'small', 'medium'],
        targetBranches: ['main'],
        allowPaths: ['docs/'],
      },
    },
    state: { pr: { baseBranch: 'main', isDraft: true, changedFiles: ['docs/notes.md'] } },
    gate: gate(['docs/notes.md']),
  });
  assert.equal(draft.status, AUTOSHIP_STATUSES.PARKED);
  assert.ok(draft.reasons.some((reason: any) => reason.code === 'workspace_policy_draft_hold'));
});

test('workspace policy parks wrong target branches and missing allow paths', () => {
  const wrongBase = evaluateAutoshipPolicy({
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        targetBranches: ['main'],
        allowPaths: ['docs/'],
      },
    },
    state: { pr: { baseBranch: 'release', changedFiles: ['docs/notes.md'] } },
    gate: { ...gate(['docs/notes.md']), baseBranch: 'release' },
  });
  assert.equal(wrongBase.status, AUTOSHIP_STATUSES.PARKED);
  assert.ok(wrongBase.reasons.some((reason: any) => reason.code === 'workspace_policy_base_branch_mismatch'));

  const missingAllow = evaluateAutoshipPolicy({
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        targetBranches: ['main'],
        exactAllowPaths: true,
      },
    },
    state: { pr: { baseBranch: 'main', changedFiles: ['docs/notes.md'] } },
    gate: {
      ok: true,
      validation: { independent: 'PASS', required: true },
      checkState: 'success',
      baseBranch: 'main',
      scope: { changedFiles: ['docs/notes.md'], allowedPaths: [] },
    },
  });
  assert.equal(missingAllow.status, AUTOSHIP_STATUSES.PARKED);
  assert.ok(missingAllow.reasons.some((reason: any) => reason.code === 'workspace_policy_allow_paths_required'));
});

test('autoship and run-ledger control-plane paths park for owner review', () => {
  const controlPlanePaths = [
    'tools/ace/src/autoship-policy.cts',
    'electron/run-ledger/reconciler.cts',
    'electron/run-ledger/spine-effects.cts',
  ];
  for (const file of controlPlanePaths) {
    const result = evaluateAutoshipPolicy({
      spec: { autoShip: { enabled: true, autoMerge: true } },
      state: { pr: { changedFiles: [file] } },
      gate: gate([file]),
    });
    assert.equal(result.status, AUTOSHIP_STATUSES.PARKED, file);
    assert.equal(result.autoMergeAllowed, false, file);
    assert.ok(
      result.reasons.some((reason: any) => reason.code === 'automerge_operator_required_control_plane'),
      file,
    );
  }
});

test('post-merge build handoff is policy-driven and does not imply prod deploy', () => {
  const result = evaluateAutoshipPolicy({
    spec: { autoShip: { enabled: true, autoMerge: true, autoBuild: true } },
    state: { merge: { merged: true } },
    gate: null,
  });
  assert.equal(result.status, AUTOSHIP_STATUSES.BUILDING);
  assert.equal(result.autoBuildAllowed, true);
  assert.equal(result.autoMergeAllowed, false);
});
