const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAgentCatalog,
  normalizeEffort,
  DEFAULT_EFFORT_BY_PROVIDER,
} = require('../agent-catalog.cts');
const { parseSpec } = require('../spec.cts');
const { routeForSpec } = require('../routing-policy.cts');

const VALID = {
  goal: 'Implement catalog defaults.',
  baseBranch: 'main',
  role: 'editor',
  scope: { repo: 'me/app' },
  acceptance: ['targeted tests pass'],
};

const VALIDATOR_PREREQS = {
  validation: {
    rubric: 'docs/ops/rubrics/validator-merger-rubric.md',
    architecture: 'docs/ops/fast-wave-playbook.md',
    workerSpec: '/tmp/worker-spec.json',
    pr: 'https://github.com/me/app/pull/42',
    head: 'feature/catalog',
  },
};

test('agent catalog: codex defaults to xhigh effort with tools, MCP, and browser off', () => {
  // Owner doctrine: Codex /goal runs at model_reasoning_effort xhigh, always.
  const route = routeForSpec({ ...VALID, taskType: 'feature-impl' });
  assert.equal(route.provider, 'codex');
  assert.equal(route.agentClass, 'implementer');
  assert.equal(route.effort, 'xhigh');
  assert.equal(route.toolMode, 'off');
  assert.equal(route.mcpMode, 'off');
  assert.equal(route.browserMode, 'off');
});

test('agent catalog: explicit tool/browser/mcp + capability opt-in is HONORED, never silently downgraded', () => {
  // The brief's Problem 3: `--tool-mode on --browser-mode on --capability
  // browser --capability computer-use --capability runtime` (with a tool
  // override reason) must survive route resolution — not collapse to
  // off/review-only. resolveAgentCatalog reads the modes; routeForSpec carries
  // the explicit capabilities into the manifest (alongside the role defaults).
  const spec = {
    ...VALID,
    taskType: 'feature-impl',
    toolMode: 'on',
    browserMode: 'on',
    mcpMode: 'global',
    toolOverrideReason: 'authorized: computer-use lane',
    capabilities: ['browser', 'computer-use', 'runtime'],
  };
  const cat = resolveAgentCatalog(spec);
  assert.equal(cat.toolMode, 'on', 'toolMode honored');
  assert.equal(cat.browserMode, 'on', 'browserMode honored');
  assert.equal(cat.mcpMode, 'global', 'mcpMode honored');

  const route = routeForSpec(spec);
  assert.equal(route.toolMode, 'on');
  assert.equal(route.browserMode, 'on');
  assert.equal(route.mcpMode, 'global');
  for (const cap of ['browser', 'computer-use', 'runtime']) {
    assert.ok(route.capabilities.includes(cap), `route honors explicit --capability ${cap}`);
  }
});

test('agent catalog: tool/browser opt-in WITHOUT an override reason is REJECTED LOUDLY (no silent downgrade)', () => {
  // The acceptable alternative to honoring is a loud rejection — never a silent
  // downgrade to off. Missing toolOverrideReason throws with a clear message.
  assert.throws(
    () => resolveAgentCatalog({ ...VALID, toolMode: 'on', browserMode: 'on' }),
    /opt-in requires toolOverrideReason/,
  );
});

test('agent catalog: Codex effort BELOW the default requires an override reason', () => {
  // Default is 'xhigh'. Lowering must be justified (silent under-powering is
  // the failure mode); raising is never a downgrade so it needs no reason.
  for (const effort of ['low', 'medium', 'high']) {
    assert.throws(
      () => parseSpec({ ...VALID, effort }),
      new RegExp(`effort ${effort} is below the codex default`)
    );
    const spec = parseSpec({
      ...VALID,
      effort,
      effortOverrideReason: 'Chief requested non-default reasoning.',
    });
    assert.equal(resolveAgentCatalog(spec).effort, effort);
  }
  // Explicit 'xhigh' equals the default; no override reason needed.
  assert.equal(resolveAgentCatalog(parseSpec({ ...VALID, effort: 'xhigh' })).effort, 'xhigh');
});

test('agent catalog: Claude scoped tasks default to xhigh effort (Claude Max)', () => {
  assert.equal(resolveAgentCatalog({ ...VALID, agent: 'claude' }).effort, 'xhigh');
  assert.equal(resolveAgentCatalog({ ...VALID, agent: 'claude', effort: 'xhigh' }).effort, 'xhigh');
  for (const effort of ['low', 'medium', 'high']) {
    assert.throws(
      () => resolveAgentCatalog({ ...VALID, agent: 'claude', effort }),
      new RegExp(`effort ${effort} is below the claude default`)
    );
  }
  assert.equal(
    resolveAgentCatalog({
      ...VALID,
      agent: 'claude',
      effort: 'high',
      effortOverrideReason: 'Chief requested non-default reasoning.',
    }).effort,
    'high'
  );
});

test('agent catalog: Claude `max` effort is preserved and raising above default is free', () => {
  assert.equal(normalizeEffort('max'), 'max');
  assert.equal(normalizeEffort('MAX'), 'max');
  // max > xhigh default: RAISING effort never requires a justification.
  assert.equal(resolveAgentCatalog({ ...VALID, agent: 'claude', effort: 'max' }).effort, 'max');
});

test('agent catalog: hermes manager lanes default to high effort', () => {
  const spec = { ...VALID, agent: 'hermes' };
  const catalog = resolveAgentCatalog(spec);
  assert.equal(catalog.effort, 'high');
  // Raising hermes to xhigh is free; dropping to medium needs a reason.
  assert.equal(resolveAgentCatalog({ ...spec, effort: 'xhigh' }).effort, 'xhigh');
  assert.throws(
    () => resolveAgentCatalog({ ...spec, effort: 'medium' }),
    /effort medium is below the hermes default \(high\)/
  );
});

test('agent catalog: provider defaults map matches the published contract', () => {
  // Pin the public contract so future drift is loud.
  assert.equal(DEFAULT_EFFORT_BY_PROVIDER.codex, 'xhigh');
  assert.equal(DEFAULT_EFFORT_BY_PROVIDER.claude, 'xhigh');
  assert.equal(DEFAULT_EFFORT_BY_PROVIDER.hermes, 'high'); // manager lane always thinks
});

test('agent catalog: non-Claude/Codex explicit providers keep the medium baseline', () => {
  for (const agent of ['qwen', 'gemini', 'opencode']) {
    const catalog = resolveAgentCatalog({ ...VALID, agent });
    assert.equal(catalog.provider, agent);
    assert.equal(catalog.effort, 'medium');
    assert.equal(catalog.toolMode, 'off');
    assert.equal(catalog.mcpMode, 'off');
  }
});


test('agent catalog: tool, MCP, and browser opt-in require an override reason', () => {
  assert.throws(
    () => parseSpec({ ...VALID, toolMode: 'on' }),
    /toolMode opt-in requires toolOverrideReason/
  );
  assert.throws(
    () => parseSpec({ ...VALID, mcpMode: 'global' }),
    /mcpMode opt-in requires toolOverrideReason/
  );
  assert.throws(
    () => parseSpec({ ...VALID, browserMode: 'on' }),
    /browserMode opt-in requires toolOverrideReason/
  );
  const spec = parseSpec({
    ...VALID,
    toolMode: 'on',
    mcpMode: 'global',
    browserMode: 'on',
    toolOverrideReason: 'Acceptance explicitly requires browser MCP verification.',
  });
  const catalog = resolveAgentCatalog(spec);
  assert.equal(catalog.toolMode, 'on');
  assert.equal(catalog.mcpMode, 'global');
  assert.equal(catalog.browserMode, 'on');
});

test('agent catalog: output validators do not require PR, while merger classes do', () => {
  assert.throws(
    () => parseSpec({ ...VALID, role: 'viewer', taskType: 'validator-merger', ...VALIDATOR_PREREQS, validation: { ...VALIDATOR_PREREQS.validation, head: '' } }),
    /validator-merger requires head/
  );
  const validator = parseSpec({
    ...VALID,
    role: 'viewer',
    taskType: 'validator',
    validation: {
      rubric: 'docs/ops/rubrics/mission.md',
      architecture: 'docs/ops/mission.md',
      workerSpec: '/tmp/features.json',
    },
  });
  const merger = parseSpec({
    ...VALID,
    role: 'viewer',
    taskType: 'github-merger',
    ...VALIDATOR_PREREQS,
  });
  assert.equal(resolveAgentCatalog(validator).agentClass, 'validator');
  assert.equal(resolveAgentCatalog(merger).agentClass, 'github-merger');
});

test('agent catalog: review_validate resolves to validator or validator-merger, never implementer', () => {
  const plain = resolveAgentCatalog({ ...VALID, role: 'viewer', taskClass: 'review_validate' });
  assert.equal(plain.agentClass, 'validator');
  const merger = resolveAgentCatalog({
    ...VALID,
    role: 'viewer',
    taskClass: 'review_validate',
    taskType: 'validator-merger',
    toolMode: 'on',
    toolOverrideReason: 'validator-merger requires Ace integration gate/merge commands only',
    ...VALIDATOR_PREREQS,
  });
  assert.equal(merger.agentClass, 'validator-merger');
  assert.deepEqual(merger.forbiddenOperations, [
    'edit',
    'push',
    'raw-github-merge',
    'replacement-pr',
    'external-cleanup',
  ]);
});

test('agent catalog: goal orchestrator resolves to Claude controller class', () => {
  const catalog = resolveAgentCatalog({
    ...VALID,
    role: 'viewer',
    roleMode: 'no-code',
    taskType: 'goal-orchestrator',
  });
  assert.equal(catalog.agentClass, 'orchestrator');
  assert.equal(catalog.provider, 'claude');
  assert.equal(catalog.effort, 'xhigh');
  assert.deepEqual(catalog.forbiddenOperations, [
    'edit',
    'push',
    'raw-git-merge',
    'raw-github-merge',
    'direct-code-work',
  ]);
});
