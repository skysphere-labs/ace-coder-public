const fs = require('node:fs');
const path = require('node:path');

let prScopePolicy: any;
try {
  prScopePolicy = require('./pr-scope-policy.cjs');
} catch {
  prScopePolicy = require('./pr-scope-policy.cts');
}
const { normalizePathList } = prScopePolicy;

const CONFIG_FILES = Object.freeze([
  '.ace/workspace-automerge-policy.json',
  '.ace/automerge-policy.json',
]);

const DEFAULT_ALLOWED_RISK_TIERS = Object.freeze(['trivial', 'small', 'medium']);

const DEFAULT_WORKSPACE_AUTOMERGE_POLICY = Object.freeze({
  enabled: false,
  autoMerge: false,
  allowedRiskTiers: DEFAULT_ALLOWED_RISK_TIERS,
  targetBranches: [],
  draftBehavior: 'ready',
  requireValidator: true,
  requireChecks: true,
  releaseTrainGuard: true,
  exactAllowPaths: true,
  allowPaths: [],
  releaseWorkflow: null,
  ownerHold: false,
  source: 'default',
});

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanString(value: any) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function bool(value: any, fallback: boolean) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const tok = value.trim().toLowerCase();
    if (tok === 'true' || tok === 'yes' || tok === '1') return true;
    if (tok === 'false' || tok === 'no' || tok === '0') return false;
  }
  return fallback;
}

function stringList(value: any) {
  const raw = Array.isArray(value) ? value : value == null ? [] : String(value).split(/[\n,]/);
  const seen = new Set();
  const out: string[] = [];
  for (const item of raw) {
    const clean = cleanString(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function riskTiers(value: any) {
  const tiers = stringList(value).map((tier) => tier.toLowerCase()).filter(Boolean);
  return tiers.length ? tiers : DEFAULT_ALLOWED_RISK_TIERS.slice();
}

function draftBehavior(value: any, mode: string) {
  const raw = cleanString(value)?.toLowerCase() || (mode === 'draft' ? 'draft' : 'ready');
  if (raw === 'draft' || raw === 'park' || raw === 'review-only' || raw === 'review_only') return 'draft';
  return 'ready';
}

function unwrapPolicy(value: any) {
  if (value === true || value === false) return value;
  const obj = asObject(value);
  return (
    obj.workspaceAutoMergePolicy ??
    obj.workspaceAutomergePolicy ??
    obj.workspace_automerge_policy ??
    obj.autoMergePolicy ??
    obj.automergePolicy ??
    obj.auto_merge_policy ??
    obj.workspacePolicy ??
    obj.workspace_policy ??
    value
  );
}

function hasPolicyField(value: any) {
  const obj = asObject(value);
  return [
    'enabled',
    'autoMerge',
    'auto_merge',
    'mode',
    'behavior',
    'allowedRiskTiers',
    'allowed_risk_tiers',
    'targetBranches',
    'target_branches',
    'baseBranch',
    'base_branch',
    'draftBehavior',
    'draft_behavior',
    'requireValidator',
    'require_validator',
    'requireChecks',
    'require_checks',
    'releaseTrainGuard',
    'release_train_guard',
    'exactAllowPaths',
    'exact_allow_paths',
    'allowPaths',
    'allowedPaths',
    'allowed_paths',
  ].some((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function readJsonPolicy(projectDir: any, fsImpl: any = fs) {
  const root = cleanString(projectDir);
  if (!root) return null;
  for (const rel of CONFIG_FILES) {
    const file = path.join(root, rel);
    try {
      if (!fsImpl.existsSync(file)) continue;
      return { raw: unwrapPolicy(JSON.parse(fsImpl.readFileSync(file, 'utf8'))), source: rel };
    } catch {
      return null;
    }
  }
  return null;
}

function firstPolicy(input: any = {}) {
  const spec = asObject(input.spec);
  const workspace = asObject(input.workspace);
  const project = asObject(input.project);
  const inline =
    spec.workspaceAutoMergePolicy ??
    spec.workspaceAutomergePolicy ??
    spec.workspace_automerge_policy ??
    spec.autoMergePolicy ??
    spec.automergePolicy;
  if (inline !== undefined) return { raw: unwrapPolicy(inline), source: 'spec' };
  const ws = unwrapPolicy(workspace);
  if (ws !== workspace || hasPolicyField(workspace)) {
    return { raw: ws, source: 'workspace' };
  }
  const prj = unwrapPolicy(project);
  if (prj !== project || hasPolicyField(project)) {
    return { raw: prj, source: 'project' };
  }
  return readJsonPolicy(input.projectDir, input.fs || fs);
}

function normalizeWorkspaceAutomergePolicy(rawInput: any, source = 'spec') {
  const raw = unwrapPolicy(rawInput);
  const cfg = asObject(raw);
  const mode = cleanString(cfg.mode || cfg.behavior)?.toLowerCase() || '';
  const disabled = raw === false || cfg.enabled === false || mode === 'disabled' || mode === 'off';
  const enabled =
    !disabled &&
    (raw === true ||
      cfg.enabled === true ||
      cfg.autoMerge === true ||
      cfg.auto_merge === true ||
      mode === 'automerge' ||
      mode === 'auto-merge' ||
      mode === 'ready' ||
      mode === 'draft');
  const autoMerge =
    enabled &&
    mode !== 'ready' &&
    mode !== 'draft' &&
    mode !== 'review-only' &&
    mode !== 'review_only' &&
    cfg.autoMerge !== false &&
    cfg.auto_merge !== false &&
    (cfg.autoMerge === true || cfg.auto_merge === true || mode === 'automerge' || mode === 'auto-merge' || raw === true);
  const targetBranches = stringList(
    cfg.targetBranches ??
      cfg.target_branches ??
      cfg.baseBranches ??
      cfg.base_branches ??
      cfg.targetBranch ??
      cfg.target_branch ??
      cfg.baseBranch ??
      cfg.base_branch
  );
  return {
    enabled,
    autoMerge,
    allowedRiskTiers: riskTiers(cfg.allowedRiskTiers ?? cfg.allowed_risk_tiers ?? cfg.riskTiers ?? cfg.risk_tiers),
    targetBranches,
    draftBehavior: draftBehavior(cfg.draftBehavior ?? cfg.draft_behavior, mode),
    requireValidator: bool(cfg.requireValidator ?? cfg.require_validator ?? cfg.requireValidation ?? cfg.require_validation, true),
    requireChecks: bool(cfg.requireChecks ?? cfg.require_checks, true),
    releaseTrainGuard: bool(cfg.releaseTrainGuard ?? cfg.release_train_guard, true),
    exactAllowPaths: bool(cfg.exactAllowPaths ?? cfg.exact_allow_paths, true),
    allowPaths: normalizePathList(cfg.allowPaths ?? cfg.allowedPaths ?? cfg.allowed_paths ?? asObject(cfg.scope).allow),
    releaseWorkflow: cleanString(cfg.releaseWorkflow ?? cfg.release_workflow),
    ownerHold: bool(cfg.ownerHold ?? cfg.owner_hold ?? cfg.hold, false),
    source,
  };
}

function resolveWorkspaceAutomergePolicy(input: any = {}) {
  const found = firstPolicy(input);
  if (!found) return { ...DEFAULT_WORKSPACE_AUTOMERGE_POLICY, allowedRiskTiers: DEFAULT_ALLOWED_RISK_TIERS.slice(), allowPaths: [] };
  return normalizeWorkspaceAutomergePolicy(found.raw, found.source);
}

module.exports = {
  CONFIG_FILES,
  DEFAULT_WORKSPACE_AUTOMERGE_POLICY,
  DEFAULT_ALLOWED_RISK_TIERS,
  normalizeWorkspaceAutomergePolicy,
  resolveWorkspaceAutomergePolicy,
};
