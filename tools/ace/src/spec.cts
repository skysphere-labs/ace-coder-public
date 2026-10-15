// TaskSpec v1.0 parser — see the ace-github-flow skill
//
// One canonical shape every orchestrator hands to a delegated worker.
// parseSpec accepts either a JSON string or a plain object, validates the
// required v1.0 fields, and returns a normalized object. Optional fields are
// preserved as-is (callers add their own context/constraints/deliverables).
//
// Required fields (v1.0): goal, baseBranch, role, scope, acceptance.
// `role` is enforced downstream by enforcement.cjs#assertViewerRole.

const VALID_ROLES = new Set(['viewer', 'editor']);
const VALID_GOAL_MODES = new Set(['auto', 'on', 'off']);
const VALID_GOAL_LEDGER_MODES = new Set(['auto', 'on', 'off']);
const VALID_NATIVE_TEAM_MODES = new Set(['auto', 'optional', 'on', 'off']);
const VALID_ROLE_MODES = new Set(['implementer', 'reviewer', 'fixback', 'no-code']);
const VALID_CODEX_RUNTIME_PROFILES = new Set(['app-parity']);
let agentCatalogCore: any;
try {
  agentCatalogCore = require('./agent-catalog.cjs');
} catch {
  agentCatalogCore = require('./agent-catalog.cts');
}
const { resolveAgentCatalog } = agentCatalogCore;
const VALID_TASK_CLASSES = new Set([
  'no_code_research',
  'code_change',
  'review_validate',
  'pr_merge_cleanup',
  'ui_product_design',
  'release_deploy',
  'incident_debug',
]);
const GITHUB_STEWARD_CONSTRAINTS = Object.freeze([
  'Read-only only: no file edits, no git writes, no gh mutations, no branch/worktree deletion, no PR comments unless explicitly asked.',
  'Classify, do not clean.',
  'Open PR worktrees are protected from deletion.',
  'Dirty worktrees are protected and must be reported.',
  'Do not merge, close, delete, prune, rebuild, relaunch, or bypass review/admin gates.',
]);

function normalizeGoalMode(value: any) {
  if (value == null || value === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!VALID_GOAL_MODES.has(mode)) {
    throw new Error(`parseSpec: goalMode must be one of ${[...VALID_GOAL_MODES].join('|')}`);
  }
  return mode;
}

function normalizeGoalLedgerMode(value: any) {
  if (value == null || value === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!VALID_GOAL_LEDGER_MODES.has(mode)) {
    throw new Error(`parseSpec: goalLedgerMode must be one of ${[...VALID_GOAL_LEDGER_MODES].join('|')}`);
  }
  return mode;
}

function normalizeNativeTeamMode(value: any) {
  if (value == null || value === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!VALID_NATIVE_TEAM_MODES.has(mode)) {
    throw new Error(`parseSpec: nativeTeamMode must be one of ${[...VALID_NATIVE_TEAM_MODES].join('|')}`);
  }
  return mode === 'on' || mode === 'auto' ? 'optional' : mode;
}

function normalizeRoleMode(value: any) {
  if (value == null || value === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!VALID_ROLE_MODES.has(mode)) {
    throw new Error(`parseSpec: roleMode must be one of ${[...VALID_ROLE_MODES].join('|')}`);
  }
  return mode;
}

function normalizeTaskClass(value: any) {
  if (value == null || value === '') return null;
  const taskClass = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (!VALID_TASK_CLASSES.has(taskClass)) {
    throw new Error(`parseSpec: taskClass must be one of ${[...VALID_TASK_CLASSES].join('|')}`);
  }
  return taskClass;
}

function normalizeCodexRuntimeProfile(value: any) {
  if (value == null || value === '') return null;
  const profile = String(value).trim().toLowerCase();
  if (!VALID_CODEX_RUNTIME_PROFILES.has(profile)) {
    throw new Error(`parseSpec: codexRuntimeProfile must be one of ${[...VALID_CODEX_RUNTIME_PROFILES].join('|')}`);
  }
  return profile;
}

function normalizeNonNegativeInteger(value: any, label: string) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`parseSpec: ${label} must be a non-negative integer`);
  }
  return n;
}

const SKYSPHERE_REF_RE = /^skysphere:v1:[0-9a-f]{8}-[0-9a-f-]{27}:[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const SKYSPHERE_BINDING_KEYS = new Set([
  'connectionId',
  'origin',
  'workspaceSlug',
  'workspaceId',
  'projectId',
  'issueId',
  'ticketKey',
]);

function normalizeSkysphereBinding(raw: any) {
  const ref = raw.skysphereRef == null ? '' : String(raw.skysphereRef).trim();
  const bindingRaw = raw.skysphere;
  if (!ref && bindingRaw == null) return null;
  if (!SKYSPHERE_REF_RE.test(ref)) {
    throw new Error('parseSpec: skysphereRef must be an opaque skysphere:v1 workspace/issue reference');
  }
  if (!bindingRaw || typeof bindingRaw !== 'object' || Array.isArray(bindingRaw)) {
    throw new Error('parseSpec: skysphere binding object required with skysphereRef');
  }
  for (const key of Object.keys(bindingRaw)) {
    if (!SKYSPHERE_BINDING_KEYS.has(key)) {
      throw new Error(`parseSpec: unsupported skysphere binding field ${key}`);
    }
  }
  const binding: any = {};
  for (const key of SKYSPHERE_BINDING_KEYS) {
    const value = bindingRaw[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
      throw new Error(`parseSpec: skysphere.${key} must be a non-empty bounded string`);
    }
    binding[key] = value.trim();
  }
  if (!/^sky-[0-9a-f-]{36}$/i.test(binding.connectionId)) {
    throw new Error('parseSpec: skysphere.connectionId is invalid');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(binding.workspaceSlug)) {
    throw new Error('parseSpec: skysphere.workspaceSlug is invalid');
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}-[1-9][0-9]{0,9}$/.test(binding.ticketKey)) {
    throw new Error('parseSpec: skysphere.ticketKey is invalid');
  }
  let origin: URL;
  try { origin = new URL(binding.origin); }
  catch { throw new Error('parseSpec: skysphere.origin is invalid'); }
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]';
  if (
    origin.username || origin.password || origin.search || origin.hash ||
    (origin.pathname !== '/' && origin.pathname !== '') ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))
  ) {
    throw new Error('parseSpec: skysphere.origin must be an HTTPS origin (or loopback HTTP for development)');
  }
  binding.origin = origin.origin;
  return { ref, binding };
}

function manifestObject(raw: any) {
  return raw?.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest)
    ? raw.manifest
    : {};
}

function manifestValue(raw: any, camel: any, snake: any) {
  const manifest = manifestObject(raw);
  return raw?.[camel] ?? raw?.[snake] ?? manifest?.[camel] ?? manifest?.[snake];
}

function normalizeStringList(value: any, label: any) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`parseSpec: ${label} must be an array of strings`);
  }
  return value.map((item: any, index: any) => {
    const text = String(item || '').trim();
    if (!text) throw new Error(`parseSpec: ${label}[${index}] must be a non-empty string`);
    return text;
  });
}

function parseSpec(input: any) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw new Error(`parseSpec: invalid JSON (${err.message})`);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parseSpec: spec object required');
  }

  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  if (!goal) throw new Error('parseSpec: goal required (non-empty string)');

  const baseBranch = typeof raw.baseBranch === 'string' ? raw.baseBranch.trim() : '';
  if (!baseBranch) throw new Error('parseSpec: baseBranch required (non-empty string)');

  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!VALID_ROLES.has(role)) {
    throw new Error(`parseSpec: role required (one of ${[...VALID_ROLES].join('|')})`);
  }

  if (!raw.scope || typeof raw.scope !== 'object' || Array.isArray(raw.scope)) {
    throw new Error('parseSpec: scope required (object)');
  }
  if (Object.keys(raw.scope).length === 0) {
    throw new Error('parseSpec: scope must declare at least one of {repo, paths, workspaceId}');
  }

  if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0) {
    throw new Error('parseSpec: acceptance required (non-empty array of strings)');
  }
  const acceptance = raw.acceptance.map((a: any, i: any) => {
    if (typeof a !== 'string' || !a.trim()) {
      throw new Error(`parseSpec: acceptance[${i}] must be a non-empty string`);
    }
    return a.trim();
  });

  // `integrate` accepts either `true` (shorthand: push + openPr, draft, no
  // auto-merge) or the richer object form that orchestrator.cjs's
  // normalizeIntegrateSpec reads (push/openPr/merge/postMergeCleanup/...).
  // `false` / undefined / null are the off switch. Anything else is rejected.
  let integrate: any;
  const rawIntegrate = raw.integrate;
  if (rawIntegrate === true || rawIntegrate === false || rawIntegrate == null) {
    integrate = rawIntegrate === true ? true : undefined;
  } else if (typeof rawIntegrate === 'object' && !Array.isArray(rawIntegrate)) {
    integrate = { ...rawIntegrate };
  } else {
    throw new Error(
      'parseSpec: integrate must be true/false or an object ' +
        '(see the ace-github-flow skill)'
    );
  }
  const integrateActive = integrate === true || (integrate && typeof integrate === 'object');

  const skills = Array.isArray(raw.skills)
    ? raw.skills.map((s: any) => String(s).trim()).filter(Boolean)
    : null;
  const goalMode = normalizeGoalMode(raw.goalMode ?? raw.goal_mode);
  const goalLedgerMode = normalizeGoalLedgerMode(raw.goalLedgerMode ?? raw.goal_ledger_mode);
  const goalLedgerPath =
    typeof raw.goalLedgerPath === 'string'
      ? raw.goalLedgerPath.trim()
      : typeof raw.goal_ledger_path === 'string'
        ? raw.goal_ledger_path.trim()
        : '';
  const nativeTeamMode = normalizeNativeTeamMode(raw.nativeTeamMode ?? raw.native_team_mode);
  const roleMode = normalizeRoleMode(
    manifestValue(raw, 'roleMode', 'role_mode') ?? raw.workerMode ?? raw.worker_mode
  );
  const skillPack = typeof manifestValue(raw, 'skillPack', 'skill_pack') === 'string'
    ? manifestValue(raw, 'skillPack', 'skill_pack').trim()
    : '';
  const capabilities = normalizeStringList(manifestValue(raw, 'capabilities', 'capabilities'), 'capabilities');
  const baselineSkills = normalizeStringList(
    manifestValue(raw, 'baselineSkills', 'baseline_skills'),
    'baselineSkills'
  );
  const taskPackSkills = normalizeStringList(
    manifestValue(raw, 'taskPackSkills', 'task_pack_skills'),
    'taskPackSkills'
  );
  const validationSkills = normalizeStringList(
    manifestValue(raw, 'validationSkills', 'validation_skills'),
    'validationSkills'
  );
  const requiredSkills = normalizeStringList(
    manifestValue(raw, 'requiredSkills', 'required_skills'),
    'requiredSkills'
  );
  const optionalSkills = normalizeStringList(
    manifestValue(raw, 'optionalSkills', 'optional_skills'),
    'optionalSkills'
  );
  const taskClass = normalizeTaskClass(manifestValue(raw, 'taskClass', 'task_class'));
  const sizeClass =
    typeof raw.sizeClass === 'string'
      ? raw.sizeClass.trim()
      : typeof raw.size_class === 'string'
        ? raw.size_class.trim()
        : '';
  const agentClass =
    typeof manifestValue(raw, 'agentClass', 'agent_class') === 'string'
      ? manifestValue(raw, 'agentClass', 'agent_class').trim()
      : '';
  const effort =
    typeof manifestValue(raw, 'effort', 'effort') === 'string'
      ? manifestValue(raw, 'effort', 'effort').trim().toLowerCase()
      : '';
  const effortOverrideReason =
    typeof manifestValue(raw, 'effortOverrideReason', 'effort_override_reason') === 'string'
      ? manifestValue(raw, 'effortOverrideReason', 'effort_override_reason').trim()
      : '';
  const toolMode =
    typeof manifestValue(raw, 'toolMode', 'tool_mode') === 'string'
      ? manifestValue(raw, 'toolMode', 'tool_mode').trim().toLowerCase()
      : '';
  const mcpMode =
    typeof manifestValue(raw, 'mcpMode', 'mcp_mode') === 'string'
      ? manifestValue(raw, 'mcpMode', 'mcp_mode').trim().toLowerCase()
      : '';
  const browserMode =
    typeof manifestValue(raw, 'browserMode', 'browser_mode') === 'string'
      ? manifestValue(raw, 'browserMode', 'browser_mode').trim().toLowerCase()
      : '';
  const codexRuntimeProfile = normalizeCodexRuntimeProfile(
    manifestValue(raw, 'codexRuntimeProfile', 'codex_runtime_profile')
  );
  // Codex CLI model pin (e.g. the validator lane's gpt-5.6-sol). Passthrough
  // only — the id is delivered as `-c model="<id>"` and the CLI is the
  // authority on whether it exists; parseSpec does not validate it.
  const codexModel =
    typeof manifestValue(raw, 'codexModel', 'codex_model') === 'string'
      ? manifestValue(raw, 'codexModel', 'codex_model').trim()
      : '';
  const toolOverrideReason =
    typeof manifestValue(raw, 'toolOverrideReason', 'tool_override_reason') === 'string'
      ? manifestValue(raw, 'toolOverrideReason', 'tool_override_reason').trim()
      : '';
  const risk =
    raw.risk != null && String(raw.risk).trim()
      ? String(raw.risk).trim()
      : '';
  const riskLevel =
    raw.riskLevel != null && String(raw.riskLevel).trim()
      ? String(raw.riskLevel).trim()
      : raw.risk_level != null && String(raw.risk_level).trim()
        ? String(raw.risk_level).trim()
        : '';
  const hasHighRisk = typeof raw.highRisk === 'boolean' || typeof raw.high_risk === 'boolean';
  const highRisk = raw.highRisk === true || raw.high_risk === true;
  const hasPriorValidationFailed =
    typeof raw.priorValidationFailed === 'boolean' ||
    typeof raw.prior_validation_failed === 'boolean';
  const priorValidationFailed =
    raw.priorValidationFailed === true || raw.prior_validation_failed === true;
  const hasValidationRequired =
    typeof raw.validationRequired === 'boolean' || typeof raw.validation_required === 'boolean';
  const validationRequired = raw.validationRequired === true || raw.validation_required === true;
  const hasClawpatchRequired =
    typeof raw.clawpatchRequired === 'boolean' || typeof raw.clawpatch_required === 'boolean';
  const clawpatchRequired = raw.clawpatchRequired === true || raw.clawpatch_required === true;
  const maxRounds = normalizeNonNegativeInteger(raw.maxRounds ?? raw.max_rounds, 'maxRounds');
  const maxVerifyRounds = normalizeNonNegativeInteger(raw.maxVerifyRounds ?? raw.max_verify_rounds, 'maxVerifyRounds');
  const skysphere = normalizeSkysphereBinding(raw);

  resolveAgentCatalog({
    ...raw,
    ...(roleMode ? { roleMode } : {}),
    ...(taskClass ? { taskClass } : {}),
    ...(agentClass ? { agentClass } : {}),
    ...(effort ? { effort } : {}),
    ...(effortOverrideReason ? { effortOverrideReason } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(mcpMode ? { mcpMode } : {}),
    ...(browserMode ? { browserMode } : {}),
    ...(codexRuntimeProfile ? { codexRuntimeProfile } : {}),
    ...(toolOverrideReason ? { toolOverrideReason } : {}),
  });

  // Editors that ask Ace to run the post-DONE push+PR flow MUST list
  // ace-github-flow in their skills pack. Without it the child has no contract
  // for how to frame the PR body / branch / trailer, and the integration
  // gateway has no skill-guard on the write side.
  if (role === 'editor' && integrateActive) {
    const prSkillDeclared = skills?.includes('ace-github-flow') || requiredSkills?.includes('ace-github-flow');
    if (!prSkillDeclared) {
      throw new Error(
        "parseSpec: role='editor' with integrate requires 'ace-github-flow' in spec.skills or requiredSkills " +
          '(add "requiredSkills": ["ace-github-flow", ...] — see the ace-github-flow skill)'
      );
    }
  }

  return {
    schema: 'TaskSpec/v1',
    goal,
    baseBranch,
    role,
    scope: { ...raw.scope },
    acceptance,
    // Behavioral Test Plan (per A-ID: artifactType UI|CLI|API, steps, expected,
    // evidence) authored at PRD time — transported verbatim so the runtime can
    // materialize the acceptance ledger and thread the plan to the validator.
    ...(Array.isArray(raw.behavioral) ? { behavioral: raw.behavioral.map((b: any) => ({ ...b })) } : {}),
    ...(raw.acceptanceLedgerPath != null ? { acceptanceLedgerPath: String(raw.acceptanceLedgerPath) } : {}),
    ...(raw.context != null ? { context: String(raw.context) } : {}),
    ...(Array.isArray(raw.constraints) ? { constraints: raw.constraints.map(String) } : {}),
    ...(Array.isArray(raw.deliverables) ? { deliverables: raw.deliverables.map(String) } : {}),
    ...(raw.validation && typeof raw.validation === 'object' && !Array.isArray(raw.validation)
      ? { validation: { ...raw.validation } }
      : {}),
    ...(raw.validatorPrereqs && typeof raw.validatorPrereqs === 'object' && !Array.isArray(raw.validatorPrereqs)
      ? { validatorPrereqs: { ...raw.validatorPrereqs } }
      : {}),
    ...(raw.rubric != null ? { rubric: String(raw.rubric) } : {}),
    ...(raw.rubricPath != null ? { rubricPath: String(raw.rubricPath) } : {}),
    ...(raw.architecture != null ? { architecture: String(raw.architecture) } : {}),
    ...(raw.architecturePath != null ? { architecturePath: String(raw.architecturePath) } : {}),
    ...(raw.workerSpec != null ? { workerSpec: String(raw.workerSpec) } : {}),
    ...(raw.workerSpecPath != null ? { workerSpecPath: String(raw.workerSpecPath) } : {}),
    ...(raw.pr != null ? { pr: String(raw.pr) } : {}),
    ...(raw.prUrl != null ? { prUrl: String(raw.prUrl) } : {}),
    ...(raw.prNumber != null ? { prNumber: String(raw.prNumber) } : {}),
    ...(raw.head != null ? { head: String(raw.head) } : {}),
    ...(raw.headRef != null ? { headRef: String(raw.headRef) } : {}),
    ...(raw.headSha != null ? { headSha: String(raw.headSha) } : {}),
    ...(skysphere ? { skysphereRef: skysphere.ref, skysphere: skysphere.binding } : {}),
    ...(typeof raw.taskType === 'string' && raw.taskType.trim() ? { taskType: raw.taskType.trim() } : {}),
    ...(roleMode ? { roleMode } : {}),
    ...(skillPack ? { skillPack } : {}),
    ...(taskClass ? { taskClass } : {}),
    ...(capabilities && capabilities.length ? { capabilities } : {}),
    ...(baselineSkills && baselineSkills.length ? { baselineSkills } : {}),
    ...(taskPackSkills && taskPackSkills.length ? { taskPackSkills } : {}),
    ...(validationSkills && validationSkills.length ? { validationSkills } : {}),
    ...(requiredSkills && requiredSkills.length ? { requiredSkills } : {}),
    ...(optionalSkills && optionalSkills.length ? { optionalSkills } : {}),
    ...(goalMode ? { goalMode } : {}),
    ...(goalLedgerPath ? { goalLedgerPath } : {}),
    ...(goalLedgerMode ? { goalLedgerMode } : {}),
    ...(nativeTeamMode ? { nativeTeamMode } : {}),
    ...(sizeClass ? { sizeClass } : {}),
    ...(agentClass ? { agentClass } : {}),
    ...(effort ? { effort } : {}),
    ...(effortOverrideReason ? { effortOverrideReason } : {}),
    // Orthogonal to effort: the launcher sends `/effort ultracode` before the
    // brief when set (the spine sets it for every Claude worker).
    ...(raw.ultraCode === true || raw.ultra_code === true ? { ultraCode: true } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(mcpMode ? { mcpMode } : {}),
    ...(browserMode ? { browserMode } : {}),
    ...(codexRuntimeProfile ? { codexRuntimeProfile } : {}),
    ...(codexModel ? { codexModel } : {}),
    ...(toolOverrideReason ? { toolOverrideReason } : {}),
    ...(risk ? { risk } : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(hasHighRisk ? { highRisk } : {}),
    ...(hasPriorValidationFailed ? { priorValidationFailed } : {}),
    ...(hasValidationRequired ? { validationRequired } : {}),
    ...(hasClawpatchRequired ? { clawpatchRequired } : {}),
    ...(maxRounds != null ? { maxRounds } : {}),
    ...(maxVerifyRounds != null ? { maxVerifyRounds } : {}),
    ...(typeof raw.requireChanges === 'boolean' ? { requireChanges: raw.requireChanges } : {}),
    ...(typeof raw.escapeHatch === 'string' ? { escapeHatch: raw.escapeHatch } : {}),
    ...(typeof raw.promptBudgetOverrideReason === 'string' && raw.promptBudgetOverrideReason.trim()
      ? { promptBudgetOverrideReason: raw.promptBudgetOverrideReason.trim() }
      : {}),
    ...(integrate !== undefined ? { integrate } : {}),
    ...(skills ? { skills } : {}),
  };
}

function buildGitHubStewardInventorySpec(input: any = {}) {
  const repo = String(input.repo || input.githubRepo || input.github_repo || '').trim();
  const workspaceId = String(input.workspaceId || input.workspace_id || '').trim();
  if (!repo && !workspaceId) {
    throw new Error('buildGitHubStewardInventorySpec: repo or workspaceId required');
  }
  const primaryPlanDoc = String(input.primaryPlanDoc || input.primaryPlan || '').trim();
  const referenceFiles = Array.isArray(input.referenceFiles)
    ? input.referenceFiles.map((file: any) => String(file).trim()).filter(Boolean)
    : [];
  const context = [
    'GitHub Steward is an inventory-only role for Ace orchestration.',
    primaryPlanDoc ? `Current primary plan doc: ${primaryPlanDoc}` : '',
    referenceFiles.length ? `Reference files: ${referenceFiles.join(', ')}` : '',
    'Do not rebuild/relaunch. Do not delete/close/merge anything.',
  ].filter(Boolean).join('\n');
  return {
    schema: 'TaskSpec/v1',
    goal: 'Inventory Ace GitHub PRs, branches, and local worktrees; produce a cleanup plan only, no changes.',
    baseBranch: String(input.baseBranch || input.base_branch || 'main').trim() || 'main',
    role: 'viewer',
    roleMode: 'no-code',
    taskType: 'github-steward',
    skillPack: 'github-steward',
    capabilities: ['github-steward', 'read-only', 'inventory'],
    taskPackSkills: ['ace-cli'],
    requireChanges: false,
    scope: {
      ...(repo ? { repo } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      paths: [],
    },
    context,
    constraints: [...GITHUB_STEWARD_CONSTRAINTS],
    deliverables: [
      'Table: open PR -> base/head/status/checks/review gate/worktree if known/action.',
      'Table: local worktrees -> branch/head/dirty/open PR/live stream/classification.',
      'Table: cleanup candidates -> reason, evidence, risk, required approval.',
      'Recommended post-merge cleanup sequence.',
    ],
    acceptance: [
      'No repo or GitHub mutation occurred.',
      'Every delete/close candidate has evidence and is deferred until approval.',
      'Ends with DONE: inventory-only cleanup plan or BLOCKED: true blocker.',
    ],
  };
}

module.exports = {
  parseSpec,
  buildGitHubStewardInventorySpec,
  GITHUB_STEWARD_CONSTRAINTS,
  VALID_ROLES,
  VALID_GOAL_MODES,
  VALID_GOAL_LEDGER_MODES,
  VALID_ROLE_MODES,
  VALID_TASK_CLASSES,
  normalizeGoalMode,
  normalizeGoalLedgerMode,
  normalizeRoleMode,
  normalizeTaskClass,
};
