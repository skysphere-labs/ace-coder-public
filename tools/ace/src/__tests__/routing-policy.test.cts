const test = require('node:test');
const assert = require('node:assert/strict');
let routingPolicy: any;
try {
  routingPolicy = require('../routing-policy.cjs');
} catch (err: any) {
  if (err?.code !== 'MODULE_NOT_FOUND') throw err;
  routingPolicy = require('../routing-policy.cts');
}
const { classifyTaskSpec, routeForSpec, validatorPolicyForSpec } = routingPolicy;
let specCore: any;
try {
  specCore = require('../spec.cjs');
} catch (err: any) {
  if (err?.code !== 'MODULE_NOT_FOUND') throw err;
  specCore = require('../spec.cts');
}
const { parseSpec } = specCore;

function agentFor(spec: any) {
  return routeForSpec(spec).agent;
}

function routeSummary(spec: any) {
  const route = routeForSpec(spec);
  return {
    agent: route.agent,
    ...(route.effort ? { effort: route.effort } : {}),
    reason: route.reason,
    roleMode: route.roleMode,
    skillPack: route.skillPack,
  };
}

test('routeForSpec: explains codex default and backend routes (codex=xhigh)', () => {
  // Owner doctrine: Codex /goal runs at xhigh, always.
  assert.deepEqual(routeSummary({}), {
    agent: 'codex',
    effort: 'xhigh',
    reason: 'codex-default',
    roleMode: 'implementer',
    skillPack: 'generic',
  });
  assert.deepEqual(routeSummary({ lane: 'backend' }), {
    agent: 'codex',
    effort: 'xhigh',
    reason: 'backend-lane',
    roleMode: 'implementer',
    skillPack: 'generic',
  });
  assert.equal(routeForSpec({ agent: 'codex' }).effort, 'xhigh');
});

test('routeForSpec: explains explicit Claude, UI, and debug routes (claude=xhigh)', () => {
  // Final enforcement: Claude default effort is xhigh (Claude Max).
  assert.deepEqual(routeSummary({ lane: 'orchestrator', agent: 'claude' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'explicit-claude-specialist',
    roleMode: 'implementer',
    skillPack: 'generic',
  });
  assert.deepEqual(routeSummary({ taskType: 'ui' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'ui-task-type',
    roleMode: 'implementer',
    skillPack: 'ui',
  });
  assert.deepEqual(routeSummary({ taskType: 'architect' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'architect-task-type',
    roleMode: 'no-code',
    skillPack: 'architect',
  });
  assert.deepEqual(routeSummary({ taskType: 'debug' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'debug-task-type',
    roleMode: 'implementer',
    skillPack: 'debug',
  });
});

test('routeForSpec: exposes reviewer and no-code route modes', () => {
  assert.deepEqual(routeSummary({ taskType: 'code-review' }), {
    agent: 'codex',
    effort: 'xhigh',
    reason: 'codex-default',
    roleMode: 'reviewer',
    skillPack: 'code-review',
  });
  assert.deepEqual(routeSummary({ taskType: 'no-code' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'no-code-research-task-class',
    roleMode: 'no-code',
    skillPack: 'no-code',
  });
});

test('routeForSpec: viewer role defaults to codex without making Claude a middle layer', () => {
  assert.equal(agentFor({ role: 'viewer' }), 'codex');
});

test('routeForSpec: reviewer mode stays codex unless Claude is explicit', () => {
  assert.equal(agentFor({ roleMode: 'reviewer' }), 'codex');
  assert.equal(agentFor({ taskType: 'code-review' }), 'codex');
  assert.deepEqual(routeSummary({ roleMode: 'reviewer', agent: 'claude' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'explicit-claude-specialist',
    roleMode: 'reviewer',
    skillPack: 'generic',
  });
});

test('routeForSpec: viewer role no longer overrides backend routing to Claude', () => {
  assert.equal(agentFor({ lane: 'backend', role: 'viewer' }), 'codex');
});

test('routeForSpec: orchestrator lane defaults to codex unless Claude is explicit', () => {
  assert.equal(agentFor({ lane: 'orchestrator' }), 'codex');
});

test('routeForSpec: explicit Claude keeps the legacy specialist recovery path', () => {
  assert.deepEqual(routeSummary({ lane: 'orchestrator', agent: 'claude' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'explicit-claude-specialist',
    roleMode: 'implementer',
    skillPack: 'generic',
  });
  assert.deepEqual(routeSummary({ role: 'viewer', preferredAgent: 'claude' }), {
    agent: 'claude',
    effort: 'xhigh',
    reason: 'explicit-claude-specialist',
    roleMode: 'reviewer',
    skillPack: 'generic',
  });
});

test('routeForSpec: frontend lane routes to claude', () => {
  assert.equal(agentFor({ lane: 'frontend' }), 'claude');
});

test('routeForSpec: taskType=ui routes to claude', () => {
  assert.equal(agentFor({ taskType: 'ui' }), 'claude');
});

test('routeForSpec: taskType=bug now defaults to codex', () => {
  assert.equal(agentFor({ taskType: 'bug' }), 'codex');
});

test('routeForSpec: taskType=plan routes to claude no-code planning', () => {
  assert.equal(agentFor({ taskType: 'plan' }), 'claude');
});

test('routeForSpec: taskType=debug routes to claude', () => {
  assert.equal(agentFor({ taskType: 'debug' }), 'claude');
});

test('routeForSpec: taskType=ambiguous routes to claude', () => {
  assert.equal(agentFor({ taskType: 'ambiguous' }), 'claude');
});

test('routeForSpec: explicit recovery capability routes to claude', () => {
  assert.equal(agentFor({ capabilities: ['recovery'] }), 'claude');
  assert.equal(agentFor({ manifest: { capabilities: ['ambiguous'] } }), 'claude');
});

test('routeForSpec: backend lane routes to codex', () => {
  assert.equal(agentFor({ lane: 'backend' }), 'codex');
});

test('routeForSpec: generic spec defaults to codex (flipped)', () => {
  assert.equal(agentFor({}), 'codex');
});

test('routeForSpec: taskType=feat now defaults to codex', () => {
  assert.equal(agentFor({ taskType: 'feat' }), 'codex');
});

test('routeForSpec: taskType=feature-impl defaults to codex', () => {
  assert.equal(agentFor({ taskType: 'feature-impl' }), 'codex');
});

test('routeForSpec: taskType=refactor defaults to codex', () => {
  assert.equal(agentFor({ taskType: 'refactor' }), 'codex');
});

test('routeForSpec: fixback defaults to codex and no-code routes to claude research', () => {
  assert.equal(agentFor({ roleMode: 'fixback' }), 'codex');
  assert.equal(agentFor({ roleMode: 'no-code' }), 'claude');
});

test('routeForSpec: GitHub Steward maps to github-merger when PR/head prereqs exist', () => {
  assert.deepEqual(routeForSpec({
    taskType: 'github-steward',
    role: 'viewer',
    validation: {
      rubric: 'docs/rubric.md',
      architecture: 'docs/architecture.md',
      workerSpec: '/tmp/worker.json',
      pr: 'https://github.com/acme/ace/pull/7',
      head: 'head7',
    },
  }), {
    agent: 'codex',
    provider: 'codex',
    effort: 'xhigh',
    agentClass: 'github-merger',
    toolMode: 'off',
    mcpMode: 'off',
    browserMode: 'off',
    prerequisites: ['rubric', 'architecture', 'workerSpec', 'pr', 'head'],
    forbiddenOperations: ['edit'],
    reason: 'codex-default',
    roleMode: 'no-code',
    skillPack: 'github-steward',
    taskClass: 'pr_merge_cleanup',
    capabilities: ['analysis', 'github-steward', 'read-only', 'inventory'],
    baselineSkills: ['ace-runtime-contract', 'ace-memory', 'ace-validator-worker'],
    taskPackSkills: ['ace-cli'],
    validationSkills: [],
  });
});

test('classifyTaskSpec: maps representative specs to required task classes', () => {
  assert.equal(classifyTaskSpec({ taskType: 'research', goal: 'Research provider options' }), 'no_code_research');
  assert.equal(classifyTaskSpec({ goal: 'Implement src/auth.ts token support' }), 'code_change');
  assert.equal(classifyTaskSpec({ role: 'viewer', goal: 'Review PR #42 for regressions' }), 'review_validate');
  assert.equal(classifyTaskSpec({ taskType: 'github-steward', goal: 'Inventory stale PR branches' }), 'pr_merge_cleanup');
  assert.equal(classifyTaskSpec({ taskType: 'ui', goal: 'Design the onboarding layout' }), 'ui_product_design');
  assert.equal(classifyTaskSpec({ taskType: 'backend', goal: 'Implement API route' }), 'code_change');
  assert.equal(classifyTaskSpec({ taskType: 'security', goal: 'Review auth boundaries' }), 'review_validate');
  assert.equal(classifyTaskSpec({ taskType: 'architect', goal: 'Plan module boundary change' }), 'no_code_research');
  assert.equal(classifyTaskSpec({ taskType: 'cloudflare', goal: 'Deploy Worker dev environment' }), 'release_deploy');
  assert.equal(classifyTaskSpec({ taskType: 'release', goal: 'Prepare release notes and deploy checklist' }), 'release_deploy');
  assert.equal(classifyTaskSpec({ taskType: 'debug', goal: 'Debug production incident timeout' }), 'incident_debug');
});

test('routeForSpec: task classes select provider families', () => {
  assert.equal(routeForSpec({ taskType: 'feature-impl', goal: 'Implement parser' }).provider, 'codex');
  assert.equal(routeForSpec({ role: 'viewer', goal: 'Review PR #42' }).provider, 'codex');
  assert.equal(routeForSpec({ taskType: 'github-steward', goal: 'Cleanup merged PR worktrees' }).provider, 'codex');
  assert.equal(routeForSpec({ taskType: 'release', goal: 'Draft release deploy plan' }).provider, 'codex');
  assert.equal(routeForSpec({ taskType: 'backend', goal: 'Add API route' }).provider, 'codex');
  assert.equal(routeForSpec({ taskType: 'cloudflare', goal: 'Deploy Worker dev environment' }).provider, 'codex');
  assert.equal(routeForSpec({ taskType: 'research', goal: 'Research provider options' }).provider, 'claude');
  assert.equal(routeForSpec({ taskType: 'architect', goal: 'Plan runtime boundary' }).provider, 'claude');
  assert.equal(routeForSpec({ taskType: 'ui', goal: 'Design product settings screen' }).provider, 'claude');
  assert.equal(routeForSpec({ taskType: 'debug', goal: 'Investigate hard incident regression' }).provider, 'claude');
});

test('routeForSpec: taskType is case-insensitive', () => {
  assert.equal(agentFor({ taskType: 'BUG' }), 'codex');
  assert.equal(agentFor({ taskType: 'UI' }), 'claude');
  assert.equal(agentFor({ taskType: 'DEBUG' }), 'claude');
});

test('routeForSpec: frontend lane wins over codex default even with feat taskType', () => {
  assert.equal(agentFor({ lane: 'frontend', taskType: 'feat' }), 'claude');
});

test('routeForSpec: rejects unknown lane', () => {
  assert.throws(() => routeForSpec({ lane: 'mobile' }), /unknown lane 'mobile'/);
});

test('routeForSpec: rejects unknown explicit agent', () => {
  assert.throws(() => routeForSpec({ agent: 'unknown-agent' }), /unknown explicit agent 'unknown-agent'/);
});

test('routeForSpec: non-Claude explicit providers are accepted without changing the default', () => {
  assert.deepEqual(routeSummary({ agent: 'qwen' }), {
    agent: 'qwen',
    effort: 'medium',
    reason: 'explicit-agent-qwen',
    roleMode: 'implementer',
    skillPack: 'generic',
  });
  assert.equal(agentFor({}), 'codex');
});

test('validatorPolicyForSpec: low-risk PRs default to same-worker native review', () => {
  assert.deepEqual(validatorPolicyForSpec({ taskType: 'bug-fix' }), {
    spawnValidator: false,
    defaultReview: 'same-worker-native-review',
    reason: 'low-risk-native-review',
    clawpatchRequired: false,
  });
});

test('validatorPolicyForSpec: risk, prior failure, and generic validation never auto-spawn a validator', () => {
  assert.deepEqual(validatorPolicyForSpec({ validationRequired: true }), {
    spawnValidator: false,
    defaultReview: 'same-worker-native-review',
    reason: 'manual-owner-validation-only',
    clawpatchRequired: false,
  });
  assert.equal(validatorPolicyForSpec({ explicitValidationRequired: true }).spawnValidator, false);
  assert.equal(validatorPolicyForSpec({ validation: { required: true } }).spawnValidator, false);
  assert.deepEqual(validatorPolicyForSpec({ risk: 'high' }), {
    spawnValidator: false,
    defaultReview: 'same-worker-native-review',
    reason: 'high-risk-native-review',
    clawpatchRequired: true,
  });
  assert.deepEqual(validatorPolicyForSpec({ riskLevel: 'medium' }), {
    spawnValidator: false,
    defaultReview: 'same-worker-native-review',
    reason: 'medium-risk-native-review',
    clawpatchRequired: true,
  });
  assert.equal(validatorPolicyForSpec({ priorValidationFailed: true }).spawnValidator, false);
});

test('validatorPolicyForSpec: normalized policy inputs never auto-spawn a validator', () => {
  const base = {
    goal: 'Patch runtime routing.',
    baseBranch: 'main',
    role: 'editor',
    scope: { repo: 'me/app' },
    acceptance: ['targeted tests pass'],
  };
  for (const riskSpec of [
    { risk: 'low' },
    { risk: 'medium' },
    { highRisk: true },
    { riskLevel: 'high' },
    { risk: 'high' },
    { priorValidationFailed: true },
    { high_risk: true },
    { risk_level: 'HIGH' },
    { prior_validation_failed: true },
    { validationRequired: true },
    { validation_required: true },
  ]) {
    assert.equal(validatorPolicyForSpec(parseSpec({ ...base, ...riskSpec })).spawnValidator, false);
  }
});
