const VALID_LANES = new Set(['backend', 'frontend', 'orchestrator']);
const VALID_ROLE_MODES = new Set(['implementer', 'reviewer', 'fixback', 'no-code']);
const VALID_EXPLICIT_AGENTS = new Set(['codex', 'claude', 'hermes', 'qwen', 'gemini', 'opencode', 'cursor', 'amp', 'copilot', 'droid']);
// Mirrors DEFAULT_EFFORT_BY_PROVIDER in agent-catalog.cts. Routing falls back
// to this only when the agent-catalog effort resolution returns no value;
// keep them aligned so the route summary never reports a stale default.
const DEFAULT_EFFORT_BY_AGENT: Record<string, string> = {
  codex: 'xhigh',
  claude: 'xhigh',
  hermes: 'medium',
  qwen: 'medium',
  gemini: 'medium',
  opencode: 'medium',
  cursor: 'medium',
  amp: 'medium',
  copilot: 'medium',
  droid: 'medium',
};
let toolContractCore: any;
try {
  toolContractCore = require('./tool-contract.cjs');
} catch {
  toolContractCore = require('./tool-contract.cts');
}
const { requiresClawpatchValidation } = toolContractCore;

let manifestCore: any;
try {
  manifestCore = require('./manifest.cjs');
} catch {
  manifestCore = require('./manifest.cts');
}
const { manifestNeedsClaude, resolveTaskManifest } = manifestCore;
let agentCatalogCore: any;
try {
  agentCatalogCore = require('./agent-catalog.cjs');
} catch {
  agentCatalogCore = require('./agent-catalog.cts');
}
const { resolveAgentCatalog } = agentCatalogCore;

const UI_TASK_TYPES = new Set(['ui', 'frontend', 'design', 'ux', 'product-design']);
const REVIEW_TASK_TYPES = new Set(['code-review', 'reviewer', 'validator', 'validator-merger', 'github-merger']);
const CLAUDE_OPT_IN_TASK_TYPES = new Set(['debug', 'ambiguous', 'hard-debug', 'goal-orchestrator', 'research-grill', 'research', 'planning', 'plan', 'architect', 'architecture']);
const TASK_CLASSES = Object.freeze([
  'no_code_research',
  'code_change',
  'review_validate',
  'pr_merge_cleanup',
  'ui_product_design',
  'release_deploy',
  'incident_debug',
]);
const VALID_TASK_CLASSES = new Set(TASK_CLASSES);

const CLASS_TASK_TYPES: Record<string, string[]> = {
  // P6 Claude/Codex specialty matrix (ADDITIVE — no existing target re-pointed):
  //   Claude (xhigh / max ultracode) ← planning, architect, ambiguous,
  //     hard-debug, orchestration, research, ui (kept in their existing classes
  //     below — no_code_research / incident_debug / ui_product_design).
  //   Codex (high→xhigh, with multi_tool_use.parallel) ← feature-impl, refactor,
  //     migration, backend/api, deterministic high-volume — all code_change.
  no_code_research: ['no-code', 'research', 'planning', 'plan', 'docs', 'documentation', 'architect', 'architecture'],
  code_change: ['feature-impl', 'feat', 'feature', 'engineer', 'coding', 'backend', 'api', 'bug', 'bug-fix', 'fix', 'refactor', 'maintenance', 'migration', 'data-migration', 'deterministic', 'high-volume', 'codegen', 'mechanical'],
  review_validate: ['code-review', 'reviewer', 'review', 'validate', 'validation', 'validator', 'security-review', 'security'],
  pr_merge_cleanup: ['github-steward', 'github-merger', 'validator-merger', 'cleanup', 'merge-cleanup', 'pr-cleanup', 'branch-cleanup'],
  ui_product_design: ['ui', 'frontend', 'product-design', 'design', 'ux'],
  release_deploy: ['ops', 'release', 'deploy', 'deployment', 'publish', 'cloudflare'],
  incident_debug: ['debug', 'hard-debug', 'incident', 'outage', 'regression'],
};
const TASK_TYPE_TO_CLASS = new Map(
  Object.entries(CLASS_TASK_TYPES).flatMap(([taskClass, taskTypes]) =>
    taskTypes.map((taskType: any) => [taskType, taskClass])
  )
);

const CODE_HINT_RX = /\.(ts|tsx|js|jsx|cjs|mjs|py|go|rs|java|rb|md|css|html|json|yaml|yml)\b|src\/|tests?\/|spec\/|\bimplement\b|\bfix\b|\brefactor\b|\bcommit\b|npm run|yarn |pnpm |make\b|cargo\b|pytest|jest|mocha|vitest/i;
const REVIEW_HINT_RX = /\b(review|validate|verification|audit|inspect)\b.*\b(pr|pull request|diff|changes?|implementation|branch)\b|\b(pr|pull request)\b.*\b(review|validate|verification|audit|inspect)\b/i;
const PR_CLEANUP_HINT_RX = /\b(pr|pull request|branch|worktree|merge|post-merge|cleanup|stale)\b.*\b(cleanup|clean up|merge|delete|prune|stale|inventory)\b|\bgithub steward\b/i;
const UI_HINT_RX = /\b(ui|ux|frontend|product|design|layout|component|figma|interaction|copy)\b/i;
const RELEASE_HINT_RX = /\b(release|deploy|deployment|publish|ship|rollout|version|changelog|tag)\b/i;
const INCIDENT_HINT_RX = /\b(incident|outage|sev[0-9]?|production down|root cause|debug|regression|failure|failing|crash|timeout|error)\b/i;
const RESEARCH_HINT_RX = /\b(research|investigate|explore|summarize|explain|plan|strategy|no-code|read-only|docs?|documentation)\b/i;

function normalizeRoleMode(value: any) {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_ROLE_MODES.has(mode) ? mode : null;
}

function normalizeTaskClass(value: any) {
  const taskClass = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return VALID_TASK_CLASSES.has(taskClass) ? taskClass : null;
}

function textForSpec(input: any) {
  return [
    input?.goal,
    input?.context,
    ...(Array.isArray(input?.constraints) ? input.constraints : []),
    ...(Array.isArray(input?.deliverables) ? input.deliverables : []),
    ...(Array.isArray(input?.acceptance) ? input.acceptance : []),
  ].map((part: any) => String(part || '')).join('\n');
}

function classifyTaskSpec(spec: any) {
  const input = spec && typeof spec === 'object' ? spec : {};
  const explicit = normalizeTaskClass(input.taskClass || input.task_class || input.manifest?.taskClass || input.manifest?.task_class);
  if (explicit) return explicit;

  const lane = typeof input.lane === 'string' ? input.lane.trim().toLowerCase() : '';
  const role = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
  const taskType = typeof input.taskType === 'string' ? input.taskType.trim().toLowerCase() : '';
  const roleMode = roleModeForSpec(input, taskType, role);
  const mapped = TASK_TYPE_TO_CLASS.get(taskType);
  if (mapped) return mapped;

  const capabilities = new Set(resolveTaskManifest({ ...input, taskType, role, roleMode }).capabilities || []);
  const text = textForSpec(input);
  if (lane === 'frontend' || capabilities.has('ui') || UI_HINT_RX.test(text)) return 'ui_product_design';
  if (PR_CLEANUP_HINT_RX.test(text)) return 'pr_merge_cleanup';
  if (RELEASE_HINT_RX.test(text)) return 'release_deploy';
  if (capabilities.has('ambiguous') || capabilities.has('recovery') || INCIDENT_HINT_RX.test(text)) return 'incident_debug';
  if (roleMode === 'reviewer' || role === 'viewer' || capabilities.has('review') || REVIEW_HINT_RX.test(text)) {
    return 'review_validate';
  }
  if (roleMode === 'no-code') return 'no_code_research';
  if (RESEARCH_HINT_RX.test(text) && !CODE_HINT_RX.test(text)) return 'no_code_research';
  return 'code_change';
}

function roleModeForSpec(input: any, taskType: any, role: any) {
  const explicit = normalizeRoleMode(input.roleMode || input.role_mode || input.workerMode || input.worker_mode);
  if (explicit) return explicit;
  if (taskType === 'github-steward') return 'no-code';
  if (role === 'viewer' || REVIEW_TASK_TYPES.has(taskType)) return 'reviewer';
  if (taskType === 'fixback') return 'fixback';
  if (
    taskType === 'no-code' ||
    taskType === 'research' ||
    taskType === 'planning' ||
    taskType === 'plan' ||
    taskType === 'architect' ||
    taskType === 'architecture' ||
    taskType === 'docs' ||
    taskType === 'documentation'
  ) return 'no-code';
  return 'implementer';
}

function route(agent: any, manifest: any, reason: any, extra: any = {}) {
  const { spec, ...routeExtra } = extra;
  const catalog = resolveAgentCatalog(spec || {}, { manifest, provider: agent });
  return {
    agent,
    provider: agent,
    ...routeExtra,
    effort: catalog.effort || DEFAULT_EFFORT_BY_AGENT[agent] || extra.effort,
    agentClass: catalog.agentClass,
    toolMode: catalog.toolMode,
    mcpMode: catalog.mcpMode,
    browserMode: catalog.browserMode,
    prerequisites: catalog.prerequisites,
    forbiddenOperations: catalog.forbiddenOperations,
    reason,
    roleMode: manifest.roleMode,
    skillPack: manifest.skillPack,
    taskClass: manifest.taskClass,
    capabilities: manifest.capabilities,
    baselineSkills: manifest.baselineSkills,
    taskPackSkills: manifest.taskPackSkills,
    validationSkills: manifest.validationSkills,
  };
}

function claudeCapabilityReason(manifest: any) {
  const capabilities = new Set(manifest?.capabilities || []);
  if (capabilities.has('ui')) return 'ui-capability';
  if (capabilities.has('ambiguous')) return 'ambiguous-capability';
  if (capabilities.has('recovery')) return 'recovery-capability';
  return 'claude-capability';
}

function routeForSpec(spec: any) {
  const input = spec && typeof spec === 'object' ? spec : {};
  const lane = typeof input.lane === 'string' ? input.lane.trim().toLowerCase() : '';
  const role = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
  const taskType =
    typeof input.taskType === 'string' ? input.taskType.trim().toLowerCase() : '';
  const roleMode = roleModeForSpec(input, taskType, role);
  const sensedTaskClass = classifyTaskSpec({ ...input, taskType, role });
  const manifest = resolveTaskManifest({ ...input, taskType, role, roleMode, taskClass: sensedTaskClass });
  const explicitAgent =
    typeof input.agent === 'string' ? input.agent.trim().toLowerCase() :
      typeof input.preferredAgent === 'string' ? input.preferredAgent.trim().toLowerCase() : '';

  if (lane && !VALID_LANES.has(lane)) {
    throw new Error(
      `routeForSpec: unknown lane '${lane}' (expected one of ${[...VALID_LANES].join('|')})`
    );
  }

  if (explicitAgent) {
    if (!VALID_EXPLICIT_AGENTS.has(explicitAgent)) {
      throw new Error(
        `routeForSpec: unknown explicit agent '${explicitAgent}' (expected one of ${[...VALID_EXPLICIT_AGENTS].join('|')})`
      );
    }
    if (explicitAgent === 'claude' && (role === 'viewer' || lane === 'orchestrator' || roleMode === 'reviewer')) {
      return route('claude', manifest, 'explicit-claude-specialist', { spec: input });
    }
    return route(explicitAgent, manifest, `explicit-agent-${explicitAgent}`, { spec: input });
  }

  if (lane === 'frontend') {
    return route('claude', manifest, 'frontend-lane', { spec: input });
  }

  if (UI_TASK_TYPES.has(taskType)) {
    return route('claude', manifest, 'ui-task-type', { spec: input });
  }

  if (CLAUDE_OPT_IN_TASK_TYPES.has(taskType)) {
    return route('claude', manifest, `${taskType}-task-type`, { spec: input });
  }

  if (manifestNeedsClaude(manifest)) {
    return route('claude', manifest, claudeCapabilityReason(manifest), { spec: input });
  }

  if (sensedTaskClass === 'ui_product_design') {
    return route('claude', manifest, 'ui-product-design-task-class', { spec: input });
  }

  if (sensedTaskClass === 'incident_debug') {
    return route('claude', manifest, 'incident-debug-task-class', { spec: input });
  }

  if (sensedTaskClass === 'no_code_research') {
    return route('claude', manifest, 'no-code-research-task-class', { spec: input });
  }

  if (lane === 'backend') {
    return route('codex', manifest, 'backend-lane', { spec: input });
  }

  return route('codex', manifest, 'codex-default', { spec: input });
}

function validatorPolicyForSpec(spec: any) {
  const input = spec && typeof spec === 'object' ? spec : {};
  const validation = input.validation && typeof input.validation === 'object' ? input.validation : {};
  const integrate = input.integrate && typeof input.integrate === 'object' ? input.integrate : {};
  const merge = integrate.merge && typeof integrate.merge === 'object' ? integrate.merge : {};
  const risk = String(input.risk || input.riskLevel || input.risk_level || '').trim().toLowerCase();
  const highRisk = input.highRisk === true || input.high_risk === true || risk === 'high';
  const mediumRisk = risk === 'medium';
  const manualValidationRequested =
    input.validationRequired === true ||
    input.validation_required === true ||
    input.explicitValidationRequired === true ||
    input.explicit_validation_required === true ||
    validation.required === true ||
    validation.validationRequired === true ||
    validation.validation_required === true ||
    integrate.validationRequired === true ||
    integrate.validation_required === true ||
    merge.validationRequired === true ||
    merge.validation_required === true;
  const priorValidationFailed =
    input.priorValidationFailed === true ||
    input.prior_validation_failed === true;
  return {
    spawnValidator: false,
    defaultReview: 'same-worker-native-review',
    reason: manualValidationRequested
      ? 'manual-owner-validation-only'
      : priorValidationFailed
        ? 'prior-failure-native-review'
        : highRisk
          ? 'high-risk-native-review'
          : mediumRisk
            ? 'medium-risk-native-review'
            : 'low-risk-native-review',
    clawpatchRequired: requiresClawpatchValidation(input),
  };
}

module.exports = {
  routeForSpec,
  validatorPolicyForSpec,
  classifyTaskSpec,
  TASK_CLASSES,
  VALID_LANES,
  VALID_ROLE_MODES,
  VALID_EXPLICIT_AGENTS,
};
