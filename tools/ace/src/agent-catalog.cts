// Custom-agent catalog defaults and enforcement shared by spec parsing,
// routing, prompt telemetry, and CLI dry-runs.

let manifestCore: any;
try {
  manifestCore = require('./manifest.cjs');
} catch {
  manifestCore = require('./manifest.cts');
}
const { resolveTaskManifest } = manifestCore;

const VALID_AGENT_CLASSES = new Set([
  'implementer',
  'orchestrator',
  'planner-architect',
  'validator',
  'validator-merger',
  'github-merger',
  'fixback',
  'browser-ui',
  'release-human',
]);

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_TOOL_MODES = new Set(['off', 'on']);
const VALID_MCP_MODES = new Set(['off', 'global']);
const VALID_BROWSER_MODES = new Set(['off', 'on']);
// Claude defaults to xhigh (Ace-internal canonical representation of
// "Claude Max"). Codex defaults to xhigh — owner doctrine: Codex /goal runs at
// model_reasoning_effort xhigh, always (matches driver-packs.cts). Hermes is
// the manager/router lane — owner doctrine: it always thinks at high. Other
// providers keep the prior medium baseline since the platform has no
// guaranteed parity for them yet.
const DEFAULT_EFFORT_BY_PROVIDER: Record<string, string> = {
  codex: 'xhigh',
  claude: 'xhigh',
  hermes: 'high',
  qwen: 'medium',
  gemini: 'medium',
  opencode: 'medium',
  cursor: 'medium',
  amp: 'medium',
  copilot: 'medium',
  droid: 'medium',
};
// Rank for "is this a downgrade?" checks: raising effort above a provider's
// default never needs justification; only LOWERING it does (silent
// under-powering is the failure mode the override reason exists to catch).
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
const EFFORT_ALIASES: Record<string, string> = {};
const VALID_PROVIDERS = new Set(Object.keys(DEFAULT_EFFORT_BY_PROVIDER));

const CLASS_ALIASES: Record<string, string> = {
  implementer: 'implementer',
  implementation: 'implementer',
  orchestrator: 'orchestrator',
  controller: 'orchestrator',
  'workspace-orchestrator': 'orchestrator',
  planner: 'planner-architect',
  architect: 'planner-architect',
  'planner-architect': 'planner-architect',
  reviewer: 'validator',
  review: 'validator',
  validator: 'validator',
  validation: 'validator',
  'validator-merger': 'validator-merger',
  'github-merger': 'github-merger',
  merger: 'github-merger',
  fixback: 'fixback',
  ui: 'browser-ui',
  browser: 'browser-ui',
  'browser-ui': 'browser-ui',
  release: 'release-human',
  deploy: 'release-human',
  'release-human': 'release-human',
};

const REQUIRED_PREREQS: Record<string, string[]> = {
  validator: [],
  'validator-merger': ['rubric', 'architecture', 'workerSpec', 'pr', 'head'],
  'github-merger': ['rubric', 'architecture', 'workerSpec', 'pr', 'head'],
};

function normalizeKey(value: any) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function manifestObject(spec: any) {
  return spec?.manifest && typeof spec.manifest === 'object' && !Array.isArray(spec.manifest)
    ? spec.manifest
    : {};
}

function manifestValue(spec: any, camel: any, snake: any) {
  const manifest = manifestObject(spec);
  return spec?.[camel] ?? spec?.[snake] ?? manifest?.[camel] ?? manifest?.[snake];
}

function normalizeAgentClass(value: any) {
  const key = normalizeKey(value);
  return CLASS_ALIASES[key] || (VALID_AGENT_CLASSES.has(key) ? key : null);
}

function objectValue(spec: any, key: any) {
  const value = spec?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasPrEvidence(spec: any) {
  const prereqs = objectValue(spec, 'validatorPrereqs');
  const validation = objectValue(spec, 'validation');
  return !!(
    spec?.pr ||
    spec?.prUrl ||
    spec?.prNumber ||
    prereqs.pr ||
    prereqs.prUrl ||
    prereqs.prNumber ||
    validation.pr ||
    validation.prUrl ||
    validation.prNumber
  );
}

function hasHeadEvidence(spec: any) {
  const prereqs = objectValue(spec, 'validatorPrereqs');
  const validation = objectValue(spec, 'validation');
  return !!(
    spec?.head ||
    spec?.headRef ||
    spec?.headSha ||
    spec?.validatedHeadSha ||
    prereqs.head ||
    prereqs.headRef ||
    prereqs.headSha ||
    validation.head ||
    validation.headRef ||
    validation.headSha
  );
}

function hasPrHeadEvidence(spec: any) {
  return hasPrEvidence(spec) && hasHeadEvidence(spec);
}

function inferAgentClass(spec: any, manifest: any) {
  const explicit = normalizeAgentClass(manifestValue(spec, 'agentClass', 'agent_class'));
  if (explicit) return explicit;
  const taskType = normalizeKey(spec?.taskType);
  const taskClass = normalizeKey(spec?.taskClass || manifest?.taskClass).replace(/-/g, '_');
  const roleMode = normalizeKey(manifest?.roleMode);
  if (taskType === 'goal-orchestrator') return 'orchestrator';
  if (taskType === 'validator-merger') return 'validator-merger';
  if (taskType === 'github-merger') return 'github-merger';
  if (taskType === 'validator') return 'validator';
  if (taskClass === 'pr_merge_cleanup' && hasPrHeadEvidence(spec)) return 'github-merger';
  if (taskClass === 'review_validate' && hasPrHeadEvidence(spec)) return 'validator-merger';
  if (taskClass === 'review_validate') return 'validator';
  if (roleMode === 'reviewer' && hasPrHeadEvidence(spec)) return 'validator-merger';
  if (roleMode === 'reviewer') return 'validator';
  if (taskType === 'fixback' || roleMode === 'fixback') return 'fixback';
  if (taskClass === 'ui_product_design') return 'browser-ui';
  if (taskClass === 'release_deploy') return 'release-human';
  if (taskClass === 'no_code_research') return 'planner-architect';
  return 'implementer';
}

function providerForClass(agentClass: any, explicitProvider: any) {
  const explicit = normalizeKey(explicitProvider);
  if (VALID_PROVIDERS.has(explicit)) return explicit;
  if (agentClass === 'orchestrator' || agentClass === 'planner-architect' || agentClass === 'browser-ui') return 'claude';
  return 'codex';
}

function normalizeEffort(value: any) {
  if (value == null || value === '') return null;
  const raw = normalizeKey(value);
  const effort = EFFORT_ALIASES[raw] || raw;
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`agentCatalog: effort must be one of ${[...VALID_EFFORTS].join('|')}`);
  }
  return effort;
}

function defaultEffortForProvider(provider: any) {
  return DEFAULT_EFFORT_BY_PROVIDER[provider] || 'high';
}

function normalizeMode(value: any, valid: Set<string>, label: string) {
  if (value == null || value === '') return 'off';
  const mode = normalizeKey(value);
  if (!valid.has(mode)) {
    throw new Error(`agentCatalog: ${label} must be one of ${[...valid].join('|')}`);
  }
  return mode;
}

function firstString(spec: any, names: string[]) {
  for (const name of names) {
    const snake = name.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`);
    const value = manifestValue(spec, name, snake);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function prereqValue(spec: any, key: any) {
  const prereqs = spec?.validatorPrereqs && typeof spec.validatorPrereqs === 'object' && !Array.isArray(spec.validatorPrereqs)
    ? spec.validatorPrereqs
    : {};
  const validation = spec?.validation && typeof spec.validation === 'object' && !Array.isArray(spec.validation)
    ? spec.validation
    : {};
  if (key === 'rubric') return spec.rubric || spec.rubricPath || prereqs.rubric || prereqs.rubricPath || validation.rubric || validation.rubricPath;
  if (key === 'architecture') return spec.architecture || spec.architecturePath || prereqs.architecture || prereqs.architecturePath || validation.architecture || validation.architecturePath;
  if (key === 'workerSpec') return spec.workerSpec || spec.workerSpecPath || prereqs.workerSpec || prereqs.workerSpecPath || validation.workerSpec || validation.workerSpecPath;
  if (key === 'pr') return spec.pr || spec.prUrl || spec.prNumber || prereqs.pr || prereqs.prUrl || prereqs.prNumber || validation.pr || validation.prUrl || validation.prNumber;
  if (key === 'head') return spec.head || spec.headRef || spec.headSha || prereqs.head || prereqs.headRef || prereqs.headSha || validation.head || validation.headRef || validation.headSha;
  return null;
}

function missingPrereqs(spec: any, agentClass: any) {
  const required = REQUIRED_PREREQS[agentClass] || [];
  return required.filter((key) => {
    const value = prereqValue(spec, key);
    return value == null || String(value).trim() === '';
  });
}

function resolveAgentCatalog(spec: any, opts: any = {}) {
  const manifest = opts.manifest || resolveTaskManifest(spec || {});
  const agentClass = inferAgentClass(spec || {}, manifest);
  const provider = providerForClass(agentClass, opts.provider || spec?.agent || spec?.preferredAgent);
  const effortOverrideReason = firstString(spec, ['effortOverrideReason', 'effort_override_reason']);
  const toolOverrideReason = firstString(spec, ['toolOverrideReason', 'tool_override_reason']);
  const defaultEffort = defaultEffortForProvider(provider);
  const effort = normalizeEffort(manifestValue(spec, 'effort', 'effort')) || defaultEffort;
  const toolMode = normalizeMode(manifestValue(spec, 'toolMode', 'tool_mode'), VALID_TOOL_MODES, 'toolMode');
  const mcpMode = normalizeMode(manifestValue(spec, 'mcpMode', 'mcp_mode'), VALID_MCP_MODES, 'mcpMode');
  const browserMode = normalizeMode(manifestValue(spec, 'browserMode', 'browser_mode'), VALID_BROWSER_MODES, 'browserMode');
  if (EFFORT_RANK[effort] < EFFORT_RANK[defaultEffort] && !effortOverrideReason) {
    throw new Error(`agentCatalog: effort ${effort} is below the ${provider} default (${defaultEffort}) and requires effortOverrideReason`);
  }
  const optInModes = [
    toolMode !== 'off' ? 'toolMode' : '',
    mcpMode !== 'off' ? 'mcpMode' : '',
    browserMode !== 'off' ? 'browserMode' : '',
  ].filter(Boolean);
  if (optInModes.length && !toolOverrideReason) {
    throw new Error(`agentCatalog: ${optInModes.join('/')} opt-in requires toolOverrideReason`);
  }
  const missing = missingPrereqs(spec || {}, agentClass);
  if (missing.length) {
    throw new Error(`agentCatalog: ${agentClass} requires ${missing.join(', ')}`);
  }
  return {
    agentClass,
    provider,
    effort,
    effortOverrideReason: effortOverrideReason || null,
    toolMode,
    mcpMode,
    browserMode,
    toolOverrideReason: toolOverrideReason || null,
    forbiddenOperations:
      agentClass === 'validator'
        ? ['edit', 'push', 'merge', 'cleanup']
        : agentClass === 'validator-merger'
          ? ['edit', 'push', 'raw-github-merge', 'replacement-pr', 'external-cleanup']
          : agentClass === 'github-merger'
            ? ['edit']
            : agentClass === 'orchestrator'
              ? ['edit', 'push', 'raw-git-merge', 'raw-github-merge', 'direct-code-work']
              : agentClass === 'planner-architect' || agentClass === 'release-human'
                ? ['edit', 'merge', 'cleanup']
                : [],
    prerequisites: REQUIRED_PREREQS[agentClass] || [],
  };
}

module.exports = {
  VALID_AGENT_CLASSES,
  VALID_EFFORTS,
  EFFORT_ALIASES,
  DEFAULT_EFFORT_BY_PROVIDER,
  resolveAgentCatalog,
  normalizeAgentClass,
  normalizeEffort,
};
