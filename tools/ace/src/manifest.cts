// Compact role/capability/skill-pack manifest resolution shared by routing,
// prompt rendering, and Mission Board projections.

const MAX_TASK_PACK_SKILLS = 4;

const VALID_ROLE_MODES = new Set(['implementer', 'reviewer', 'fixback', 'no-code']);
const VALID_TASK_CLASSES = new Set([
  'no_code_research',
  'code_change',
  'review_validate',
  'pr_merge_cleanup',
  'ui_product_design',
  'release_deploy',
  'incident_debug',
]);

const ROLE_LABELS: Record<string, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  fixback: 'Fixback',
  'no-code': 'No-code',
};

const ROLE_CAPABILITIES: Record<string, string[]> = {
  implementer: ['code-change', 'verify'],
  reviewer: ['review'],
  fixback: ['fixback'],
  'no-code': ['analysis'],
};

const TASK_TYPE_SKILL_PACK: Record<string, string[]> = {
  // v2.1: the BIG-task path is a research+grill+PRD agent (Claude), NOT an
  // orchestra. It grills the owner, researches, writes a PRD, then implements
  // by spawning INTERNAL sub-agents only — never external Ace workers.
  'goal-orchestrator': ['ace-grill-prd', 'ace-hermes-router', 'mp-grill-with-docs', 'mp-to-prd', 'ace-rubric-first'],
  'research-grill': ['ace-grill-prd', 'ace-hermes-router', 'mp-grill-with-docs', 'mp-to-prd', 'ace-rubric-first'],
  'feature-impl': ['ace-agent-pack-engineer'],
  feature: ['ace-agent-pack-engineer'],
  feat: ['ace-agent-pack-engineer'],
  engineer: ['ace-agent-pack-engineer'],
  coding: ['ace-agent-pack-engineer'],
  architect: ['ace-agent-pack-architect', 'ace-rubric-first'],
  architecture: ['ace-agent-pack-architect', 'ace-rubric-first'],
  backend: ['ace-agent-pack-backend'],
  api: ['ace-agent-pack-backend'],
  bug: [],
  'bug-fix': [],
  debug: [],
  'hard-debug': [],
  ambiguous: [],
  refactor: ['knip-maintenance'],
  // P6 specialty matrix (ADDITIVE): migration is a deterministic, high-volume
  // code_change → routed to Codex with the same engineer pack as refactor.
  migration: ['ace-agent-pack-engineer'],
  'data-migration': ['ace-agent-pack-engineer'],
  maintenance: ['knip-maintenance', 'skill-cleaner'],
  'code-review': [],
  validator: ['ace-validator-worker', 'autoreview'],
  'github-merger': ['ace-validator-worker', 'autoreview', 'github-pr-workflow'],
  'security-review': ['ace-agent-pack-security', 'trailofbits-security-review'],
  security: ['ace-agent-pack-security', 'trailofbits-security-review'],
  'github-steward': ['ace-cli'],
  fixback: [],
  'no-code': [],
  research: [],
  planning: [],
  plan: [],
  ops: [],
  release: ['ace-agent-pack-engineer'],
  deploy: ['ace-agent-pack-cloudflare'],
  deployment: ['ace-agent-pack-cloudflare'],
  cloudflare: ['ace-agent-pack-cloudflare'],
  ui: ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'anthropics-frontend-design'],
  frontend: ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'anthropics-frontend-design'],
  design: ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'anthropics-frontend-design'],
  ux: ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'anthropics-frontend-design'],
  'product-design': ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'anthropics-frontend-design'],
  generic: [],
};

const TASK_TYPE_CAPABILITIES: Record<string, string[]> = {
  // research+grill+PRD agent: analyses + grills + may fan out INTERNAL sub-agents
  // (native-team), but never orchestrates external Ace workers.
  'goal-orchestrator': ['analysis', 'native-team'],
  'research-grill': ['analysis', 'native-team'],
  'feature-impl': ['implementation'],
  feature: ['implementation'],
  feat: ['implementation'],
  engineer: ['implementation'],
  coding: ['implementation'],
  architect: ['architecture', 'planning'],
  architecture: ['architecture', 'planning'],
  backend: ['backend', 'implementation'],
  api: ['backend', 'implementation'],
  bug: ['debug'],
  'bug-fix': ['debug'],
  debug: ['recovery'],
  'hard-debug': ['recovery'],
  ambiguous: ['ambiguous'],
  refactor: ['refactor'],
  migration: ['migration', 'refactor'],
  'data-migration': ['migration', 'refactor'],
  maintenance: ['maintenance'],
  'code-review': ['review'],
  validator: ['review', 'validation'],
  'github-merger': ['review', 'validation', 'merge-gate'],
  'security-review': ['security-review'],
  security: ['security-review'],
  'github-steward': ['github-steward', 'read-only', 'inventory'],
  fixback: ['fixback'],
  'no-code': ['analysis'],
  research: ['analysis', 'research'],
  planning: ['analysis', 'planning'],
  plan: ['analysis', 'planning'],
  ops: ['ops'],
  release: ['release'],
  deploy: ['deploy'],
  deployment: ['deploy'],
  cloudflare: ['deploy', 'cloudflare'],
  ui: ['ui'],
  frontend: ['ui'],
  design: ['ui'],
  ux: ['ui'],
  'product-design': ['ui'],
  generic: [],
};

function normalizeKey(value: any) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function asList(value: any) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((v: any) => asList(v));
  return String(value)
    .split(',')
    .map((s: any) => s.trim())
    .filter(Boolean);
}

function dedupe(items: any) {
  const seen = new Set();
  const out = [];
  for (const raw of asList(items)) {
    const key = normalizeKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
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

function normalizeRoleMode(value: any) {
  const mode = normalizeKey(value);
  return VALID_ROLE_MODES.has(mode) ? mode : null;
}

function resolveRoleMode(spec: any) {
  const explicit = normalizeRoleMode(
    manifestValue(spec, 'roleMode', 'role_mode') ??
      spec?.workerMode ??
      spec?.worker_mode
  );
  if (explicit) return explicit;
  const taskType = normalizeKey(spec?.taskType);
  const role = normalizeKey(spec?.role);
  if (taskType === 'github-steward') return 'no-code';
  if (
    role === 'viewer' ||
    taskType === 'code-review' ||
    taskType === 'reviewer' ||
    taskType === 'validator' ||
    taskType === 'github-merger'
  ) return 'reviewer';
  if (taskType === 'fixback' || spec?.verifyFeedback) return 'fixback';
  if (
    taskType === 'no-code' ||
    taskType === 'research' ||
    taskType === 'planning' ||
    taskType === 'plan' ||
    taskType === 'architect' ||
    taskType === 'architecture'
  ) return 'no-code';
  return 'implementer';
}

function resolveSkillPack(spec: any) {
  const explicit = normalizeKey(manifestValue(spec, 'skillPack', 'skill_pack'));
  if (explicit && explicit !== 'general') return explicit;
  const taskType = normalizeKey(spec?.taskType);
  return TASK_TYPE_SKILL_PACK[taskType] ? taskType : 'generic';
}

function explicitTaskPackSkills(spec: any) {
  return dedupe(manifestValue(spec, 'taskPackSkills', 'task_pack_skills'));
}

function resolveTaskPackSkills(spec: any, skillPack: any) {
  const explicit = explicitTaskPackSkills(spec);
  const raw = explicit.length
    ? explicit
    : TASK_TYPE_SKILL_PACK[skillPack] || TASK_TYPE_SKILL_PACK.generic;
  return {
    taskPackSkills: raw.slice(0, MAX_TASK_PACK_SKILLS),
    omittedTaskPackSkills: raw.slice(MAX_TASK_PACK_SKILLS),
  };
}

function resolveBaselineSkills(spec: any, roleMode: any) {
  const explicit = dedupe(manifestValue(spec, 'baselineSkills', 'baseline_skills'));
  if (explicit.length) return explicit;
  // ace-runtime-contract is the compact baseline every Ace role
  // reads first; ace-memory teaches the knowledge-base retrieval ladder
  // and dump-only write rules. Validators get the goal-validator contract on
  // top; workers get the goal-worker contract; no-code/reviewer lanes pick up
  // the validator stack so they can produce VERDICTs without code edits.
  if (roleMode === 'reviewer' || roleMode === 'no-code') {
    return ['ace-runtime-contract', 'ace-memory', 'ace-validator-worker'];
  }
  if (roleMode === 'fixback') {
    return ['ace-runtime-contract', 'ace-memory', 'ace-goal-worker'];
  }
  return ['ace-runtime-contract', 'ace-memory', 'ace-goal-worker'];
}

function resolveValidationSkills(spec: any) {
  return dedupe(manifestValue(spec, 'validationSkills', 'validation_skills'));
}

function resolveRequiredSkills(spec: any) {
  return dedupe(manifestValue(spec, 'requiredSkills', 'required_skills'));
}

function resolveOptionalSkills(spec: any) {
  return dedupe([
    ...dedupe(manifestValue(spec, 'optionalSkills', 'optional_skills')),
    ...dedupe(spec?.skills),
  ]);
}

function resolveCapabilities(spec: any, roleMode: any, skillPack: any) {
  return dedupe([
    ...(ROLE_CAPABILITIES[roleMode] || []),
    ...(TASK_TYPE_CAPABILITIES[skillPack] || []),
    ...dedupe(manifestValue(spec, 'capabilities', 'capabilities')),
  ]);
}

function resolveTaskManifest(spec: any) {
  const roleMode = resolveRoleMode(spec);
  const skillPack = resolveSkillPack(spec);
  const { taskPackSkills, omittedTaskPackSkills } = resolveTaskPackSkills(spec, skillPack);
  const taskClass = normalizeTaskClass(manifestValue(spec, 'taskClass', 'task_class'));
  return {
    roleMode,
    roleLabel: ROLE_LABELS[roleMode] || roleMode,
    skillPack,
    taskClass,
    capabilities: resolveCapabilities(spec, roleMode, skillPack),
    baselineSkills: resolveBaselineSkills(spec, roleMode),
    taskPackSkills,
    omittedTaskPackSkills,
    taskPackSkillCap: MAX_TASK_PACK_SKILLS,
    validationSkills: resolveValidationSkills(spec),
    requiredSkills: resolveRequiredSkills(spec),
    optionalSkills: resolveOptionalSkills(spec),
  };
}

function normalizeTaskClass(value: any) {
  const key = normalizeKey(value).replace(/-/g, '_');
  return VALID_TASK_CLASSES.has(key) ? key : null;
}

function manifestNeedsClaude(manifest: any) {
  const capabilities = new Set(dedupe(manifest?.capabilities || []));
  return (
    capabilities.has('ui') ||
    capabilities.has('ambiguous') ||
    capabilities.has('recovery') ||
    capabilities.has('orchestrate') ||
    capabilities.has('research') ||
    capabilities.has('planning')
  );
}

module.exports = {
  MAX_TASK_PACK_SKILLS,
  TASK_TYPE_SKILL_PACK,
  VALID_TASK_CLASSES,
  VALID_ROLE_MODES,
  normalizeTaskClass,
  normalizeRoleMode,
  resolveRoleMode,
  resolveTaskManifest,
  manifestNeedsClaude,
};
