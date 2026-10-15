// autoship-policy — first-class Auto-Ship Loop policy overlay.
//
// This is deliberately a thin, pure policy layer over the existing merge gate
// and automerge eligibility checks. It never shells out and never performs a
// merge. Callers use the verdict to decide whether to ask the integration
// gateway to merge with gate.automerge=true.

let automergePolicy: any;
try {
  automergePolicy = require('./automerge-policy.cjs');
} catch {
  automergePolicy = require('./automerge-policy.cts');
}
let workspaceAutomergePolicy: any;
try {
  workspaceAutomergePolicy = require('./workspace-automerge-policy.cjs');
} catch {
  workspaceAutomergePolicy = require('./workspace-automerge-policy.cts');
}
let prScopePolicy: any;
try {
  prScopePolicy = require('./pr-scope-policy.cjs');
} catch {
  prScopePolicy = require('./pr-scope-policy.cts');
}
const { evaluatePrScope } = prScopePolicy;

const AUTOSHIP_STATUSES = Object.freeze({
  READY: 'ready_to_autoship',
  MERGING: 'autoship_merging',
  BUILDING: 'autoship_building',
  SHIPPED: 'shipped',
  PARKED: 'parked_owner_review',
});

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function upper(value: any) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function autoshipConfig(spec: any = {}) {
  const s = asObject(spec);
  const workspacePolicy = workspaceAutomergePolicy.resolveWorkspaceAutomergePolicy({ spec: s, projectDir: s.projectDir });
  const workspacePolicyPresent = workspacePolicy.source !== 'default';
  const raw =
    s.autoShip !== undefined
      ? s.autoShip
      : s.autoship !== undefined
        ? s.autoship
        : s.auto_ship !== undefined
          ? s.auto_ship
          : s.autoChain && typeof s.autoChain === 'object'
          ? s.autoChain.autoShip ?? s.autoChain.autoship
          : undefined;
  const cfg = asObject(raw);
  const explicitEnabled =
    raw === true ||
    cfg.enabled === true ||
    (cfg.enabled !== false && (cfg.autoMerge === true || cfg.auto_merge === true));
  const enabled =
    workspacePolicyPresent ? workspacePolicy.enabled === true : explicitEnabled;
  return {
    enabled,
    autoMerge:
      enabled &&
      (workspacePolicyPresent ? workspacePolicy.autoMerge === true : true) &&
      cfg.autoMerge !== false &&
      cfg.auto_merge !== false &&
      s.autoMerge !== false &&
      s.auto_merge !== false,
    autoBuild:
      cfg.autoBuild === true ||
      cfg.auto_build === true ||
      s.autoBuild === true ||
      s.auto_build === true,
    ownerHold:
      workspacePolicy.ownerHold === true ||
      cfg.ownerHold === true ||
      cfg.owner_hold === true ||
      s.ownerHold === true ||
      s.owner_hold === true ||
      s.hold === true,
    releaseWorkflow:
      workspacePolicy.releaseWorkflow ||
      cfg.releaseWorkflow ||
      cfg.release_workflow ||
      s.releaseWorkflow ||
      s.release_workflow ||
      null,
    workspacePolicy,
    allowedRiskTiers: Array.isArray(workspacePolicy.allowedRiskTiers) ? workspacePolicy.allowedRiskTiers : [],
    targetBranches: Array.isArray(workspacePolicy.targetBranches) ? workspacePolicy.targetBranches : [],
    draftBehavior: workspacePolicy.draftBehavior || 'ready',
    requireValidator: workspacePolicy.requireValidator !== false,
    requireChecks: workspacePolicy.requireChecks !== false,
    releaseTrainGuard: workspacePolicy.releaseTrainGuard !== false,
    exactAllowPaths: workspacePolicy.exactAllowPaths !== false,
    allowPaths: Array.isArray(workspacePolicy.allowPaths) ? workspacePolicy.allowPaths : [],
  };
}

function changedFilesFrom({ state, gate }: any = {}) {
  const pr = asObject(asObject(state).pr);
  const scope = asObject(gate?.scope);
  if (Array.isArray(scope.changedFiles)) return scope.changedFiles;
  if (Array.isArray(pr.changedFiles)) return pr.changedFiles;
  if (Array.isArray(gate?.changedFiles)) return gate.changedFiles;
  return [];
}

function hasComputerUseEvidence(state: any, gate: any) {
  const validator = asObject(asObject(state).validator);
  const validation = asObject(gate?.validation);
  return (
    validator.computerUseEvidence === true ||
    validation.computerUseEvidence === true ||
    gate?.computerUseEvidence === true
  );
}

function allowedPathsFrom({ spec, state, gate, cfg }: any = {}) {
  if (Array.isArray(cfg?.allowPaths) && cfg.allowPaths.length) return cfg.allowPaths;
  const scope = asObject(gate?.scope);
  const st = asObject(state);
  const pr = asObject(st.pr);
  const specScope = asObject(asObject(spec).scope);
  if (Array.isArray(scope.allowedPaths)) return scope.allowedPaths;
  if (Array.isArray(gate?.allowedPaths)) return gate.allowedPaths;
  if (Array.isArray(pr.allowedPaths)) return pr.allowedPaths;
  if (Array.isArray(specScope.allow)) return specScope.allow;
  if (Array.isArray(specScope.paths)) return specScope.paths;
  return [];
}

function baseBranchFrom({ state, gate }: any = {}) {
  const pr = asObject(asObject(state).pr);
  return pr.baseBranch || gate?.actualBaseBranch || gate?.baseBranch || gate?.actualPr?.baseRef || null;
}

function evaluateAutoshipPolicy({ spec, state, gate }: any = {}) {
  const cfg = autoshipConfig(spec);
  const st = asObject(state);
  const merge = asObject(st.merge);
  const autoship = asObject(st.autoship);
  const validation = asObject(gate?.validation || st.pr?.validation);
  const independentPass = upper(validation.independent) === 'PASS' || upper(validation.independent) === 'PASSED';
  const highRisk = validation.highRisk === true || st.highRisk === true || upper(st.risk) === 'HIGH';
  const reasons: any[] = [];

  if (merge.merged === true) {
    if (cfg.autoBuild) {
      return {
        enabled: cfg.enabled,
        status: AUTOSHIP_STATUSES.BUILDING,
        autoMergeAllowed: false,
        autoBuildAllowed: true,
        requiresOwnerApproval: false,
        reason: 'merged; policy allows post-merge build handoff',
        reasons,
      };
    }
    return {
      enabled: cfg.enabled,
      status: AUTOSHIP_STATUSES.SHIPPED,
      autoMergeAllowed: false,
      autoBuildAllowed: false,
      requiresOwnerApproval: false,
      reason: 'merged',
      reasons,
    };
  }

  if (autoship.mergeStarted === true) {
    return {
      enabled: cfg.enabled,
      status: AUTOSHIP_STATUSES.MERGING,
      autoMergeAllowed: false,
      autoBuildAllowed: cfg.autoBuild,
      requiresOwnerApproval: false,
      reason: 'autoship merge in progress',
      reasons,
    };
  }

  if (!cfg.enabled) {
    reasons.push({ code: 'autoship_not_enabled', message: 'autoship requires an explicit run policy opt-in' });
  }
  if (cfg.ownerHold) {
    reasons.push({ code: 'autoship_owner_hold', message: 'autoship is held by explicit owner/run policy' });
  }
  if (!cfg.autoMerge) {
    reasons.push({ code: 'autoship_auto_merge_disabled', message: 'autoship auto-merge is disabled by policy' });
  }
  if (autoship.lastBlocker) {
    reasons.push({
      code: 'autoship_merge_failed',
      message: `previous autoship merge attempt failed: ${autoship.lastBlocker}`,
    });
  }
  if (!gate || gate.ok !== true) {
    const failures = Array.isArray(gate?.failures) ? gate.failures : [];
    reasons.push(
      failures.length
        ? { code: 'autoship_gate_blocked', message: 'merge gate is blocked', failures }
        : { code: 'autoship_gate_required', message: 'autoship requires a current passing merge gate' }
    );
  }

  const changedFiles = changedFilesFrom({ state, gate });
  const eligibility = automergePolicy.evaluateAutomergeEligibility({
    changedFiles,
    independentPass,
    computerUseEvidence: hasComputerUseEvidence(state, gate),
    highRisk,
  });
  reasons.push(...eligibility.holds);
  const allowedRiskTiers = (cfg.allowedRiskTiers || []).map((tier: any) => String(tier).toLowerCase());
  if (allowedRiskTiers.length && !allowedRiskTiers.includes(String(eligibility.riskClass || '').toLowerCase())) {
    reasons.push({
      code: 'workspace_policy_risk_tier_hold',
      message: `workspace autoship policy does not allow ${eligibility.riskClass} risk changes`,
      actual: eligibility.riskClass,
      allowed: cfg.allowedRiskTiers,
    });
  }
  const baseBranch = baseBranchFrom({ state, gate });
  if (cfg.targetBranches.length > 0) {
    if (!baseBranch) {
      reasons.push({
        code: 'workspace_policy_base_branch_unknown',
        message: 'workspace autoship policy requires target branch evidence before auto-merge',
        expected: cfg.targetBranches,
      });
    } else if (!cfg.targetBranches.includes(baseBranch)) {
      reasons.push({
        code: 'workspace_policy_base_branch_mismatch',
        message: `workspace autoship policy only allows target branch ${cfg.targetBranches.join(', ')}`,
        actual: baseBranch,
        expected: cfg.targetBranches,
      });
    }
  }
  if (st.pr?.isDraft === true || gate?.isDraft === true) {
    reasons.push({
      code: 'workspace_policy_draft_hold',
      message: 'draft PRs park for review before workspace autoship can merge',
    });
  }
  if (cfg.exactAllowPaths) {
    const allowedPaths = allowedPathsFrom({ spec, state, gate, cfg });
    if (changedFiles.length > 0 && allowedPaths.length === 0) {
      reasons.push({
        code: 'workspace_policy_allow_paths_required',
        message: 'workspace autoship policy requires exact allowed paths for changed files',
      });
    } else {
      const scope = evaluatePrScope({ allowedPaths, changedFiles });
      if (!scope.ok) reasons.push({ code: scope.code, message: scope.message, allowedPaths: scope.allowedPaths, changedFiles: scope.changedFiles, unexpectedFiles: scope.unexpectedFiles });
    }
  }

  const autoMergeAllowed = reasons.length === 0;
  return {
    enabled: cfg.enabled,
    status: autoMergeAllowed ? AUTOSHIP_STATUSES.READY : AUTOSHIP_STATUSES.PARKED,
    autoMergeAllowed,
    autoBuildAllowed: cfg.autoBuild,
    requiresOwnerApproval: !autoMergeAllowed,
    reason: autoMergeAllowed ? 'autoship policy passed' : reasons[0]?.message || 'autoship policy held',
    reasons,
    releaseWorkflow: cfg.releaseWorkflow,
    releaseTrainGuard: cfg.releaseTrainGuard,
    allowedPaths: allowedPathsFrom({ spec, state, gate, cfg }),
    targetBranches: cfg.targetBranches,
    workspacePolicy: cfg.workspacePolicy,
  };
}

module.exports = {
  AUTOSHIP_STATUSES,
  autoshipConfig,
  evaluateAutoshipPolicy,
};
