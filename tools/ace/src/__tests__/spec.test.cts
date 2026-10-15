const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec, buildGitHubStewardInventorySpec } = require('../spec.cts');

const VALID = {
  goal: 'Add a hello route',
  baseBranch: 'main',
  role: 'editor',
  scope: { repo: 'me/app' },
  acceptance: ['npm run lint passes'],
};

test('parseSpec: accepts a minimal valid v1 spec (object)', () => {
  const out = parseSpec(VALID);
  assert.equal(out.schema, 'TaskSpec/v1');
  assert.equal(out.goal, 'Add a hello route');
  assert.equal(out.baseBranch, 'main');
  assert.equal(out.role, 'editor');
  assert.deepEqual(out.scope, { repo: 'me/app' });
  assert.deepEqual(out.acceptance, ['npm run lint passes']);
});

test('parseSpec: accepts a JSON string', () => {
  const out = parseSpec(JSON.stringify(VALID));
  assert.equal(out.goal, VALID.goal);
});

test('parseSpec: passes through optional fields', () => {
  const out = parseSpec({
    ...VALID,
    context: 'see PR #12',
    constraints: ['no new deps'],
    deliverables: ['src/route.ts'],
    goalMode: 'ON',
    nativeTeamMode: 'AUTO',
    roleMode: 'FIXBACK',
    sizeClass: 'medium',
    maxRounds: 0,
    maxVerifyRounds: 0,
    requireChanges: false,
    escapeHatch: 'CUSTOM',
    promptBudgetOverrideReason: 'Long fixture needs extra context.',
    codexRuntimeProfile: 'app-parity',
    toolOverrideReason: 'Operator requested app-parity runtime.',
  });
  assert.equal(out.context, 'see PR #12');
  assert.deepEqual(out.constraints, ['no new deps']);
  assert.deepEqual(out.deliverables, ['src/route.ts']);
  assert.equal(out.goalMode, 'on');
  assert.equal(out.nativeTeamMode, 'optional');
  assert.equal(out.roleMode, 'fixback');
  assert.equal(out.sizeClass, 'medium');
  assert.equal(out.maxRounds, 0);
  assert.equal(out.maxVerifyRounds, 0);
  assert.equal(out.requireChanges, false);
  assert.equal(out.escapeHatch, 'CUSTOM');
  assert.equal(out.promptBudgetOverrideReason, 'Long fixture needs extra context.');
  assert.equal(out.codexRuntimeProfile, 'app-parity');
  assert.equal(out.toolOverrideReason, 'Operator requested app-parity runtime.');
});

test('parseSpec: preserves the bounded Skysphere ticket binding without credential-shaped extras', () => {
  const out = parseSpec({
    ...VALID,
    skysphereRef: 'skysphere:v1:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444',
    skysphere: {
      connectionId: 'sky-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      origin: 'https://sky.example.test',
      workspaceSlug: 'skyslab',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      issueId: '44444444-4444-4444-8444-444444444444',
      ticketKey: 'SKY-142',
    },
  });
  assert.equal(out.skysphereRef, 'skysphere:v1:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444');
  assert.equal(out.skysphere.ticketKey, 'SKY-142');
  assert.equal(out.skysphere.origin, 'https://sky.example.test');
  assert.throws(
    () => parseSpec({ ...VALID, skysphereRef: out.skysphereRef, skysphere: { ...out.skysphere, token: 'plane_api_secret' } }),
    /unsupported skysphere binding field token/
  );
});

test('parseSpec: rejects invalid round budgets', () => {
  assert.throws(() => parseSpec({ ...VALID, maxRounds: -1 }), /maxRounds must be a non-negative integer/);
  assert.throws(() => parseSpec({ ...VALID, max_verify_rounds: 1.5 }), /maxVerifyRounds must be a non-negative integer/);
});

test('parseSpec: preserves valid Codex app-parity runtime profile aliases', () => {
  const out = parseSpec({
    ...VALID,
    codex_runtime_profile: 'APP-PARITY',
    toolOverrideReason: 'Operator requested app-parity runtime.',
  });
  assert.equal(out.codexRuntimeProfile, 'app-parity');
});

test('parseSpec: rejects invalid Codex runtime profiles', () => {
  assert.throws(
    () => parseSpec({
      ...VALID,
      codexRuntimeProfile: 'desktop',
      toolOverrideReason: 'Operator requested app-parity runtime.',
    }),
    /codexRuntimeProfile must be one of app-parity/
  );
  assert.throws(
    () => parseSpec({
      ...VALID,
      manifest: { codexRuntimeProfile: 'app_parity' },
      toolOverrideReason: 'Operator requested app-parity runtime.',
    }),
    /codexRuntimeProfile must be one of app-parity/
  );
});

test('parseSpec: preserves risk fields used by validator policy', () => {
  const out = parseSpec({
    ...VALID,
    risk: 'runtime-routing',
    riskLevel: 'high',
    highRisk: true,
    priorValidationFailed: true,
    validationRequired: true,
    clawpatchRequired: true,
  });
  assert.equal(out.risk, 'runtime-routing');
  assert.equal(out.riskLevel, 'high');
  assert.equal(out.highRisk, true);
  assert.equal(out.priorValidationFailed, true);
  assert.equal(out.validationRequired, true);
  assert.equal(out.clawpatchRequired, true);
});

test('parseSpec: normalizes snake-case risk fields to live TaskSpec shape', () => {
  const out = parseSpec({
    ...VALID,
    risk_level: 'HIGH',
    high_risk: true,
    prior_validation_failed: true,
    validation_required: true,
    clawpatch_required: true,
  });
  assert.equal(out.riskLevel, 'HIGH');
  assert.equal(out.highRisk, true);
  assert.equal(out.priorValidationFailed, true);
  assert.equal(out.validationRequired, true);
  assert.equal(out.clawpatchRequired, true);
});

test('parseSpec: passes through compact role manifest fields', () => {
  const out = parseSpec({
    ...VALID,
    manifest: {
      roleMode: 'REVIEWER',
      skillPack: 'security-review',
      taskClass: 'review-validate',
      capabilities: ['security-review', 'recovery'],
      baselineSkills: ['ace-operator-policy'],
      taskPackSkills: ['trailofbits-security-review', 'karpathy-simplicity-first'],
      validationSkills: ['ace-github-flow'],
      requiredSkills: ['trailofbits-security-review'],
      optionalSkills: ['github-code-review'],
    },
  });
  assert.equal(out.roleMode, 'reviewer');
  assert.equal(out.skillPack, 'security-review');
  assert.equal(out.taskClass, 'review_validate');
  assert.deepEqual(out.capabilities, ['security-review', 'recovery']);
  assert.deepEqual(out.baselineSkills, ['ace-operator-policy']);
  assert.deepEqual(out.taskPackSkills, ['trailofbits-security-review', 'karpathy-simplicity-first']);
  assert.deepEqual(out.validationSkills, ['ace-github-flow']);
  assert.deepEqual(out.requiredSkills, ['trailofbits-security-review']);
  assert.deepEqual(out.optionalSkills, ['github-code-review']);
});

test('buildGitHubStewardInventorySpec: defaults to read-only no-code semantics', () => {
  const spec = buildGitHubStewardInventorySpec({
    repo: 'example-user/Ace',
    workspaceId: 'prj-ce38979c',
    primaryPlanDoc: '/tmp/plan.md',
    referenceFiles: ['/tmp/control-plane.md'],
  });
  const out = parseSpec(spec);
  assert.equal(out.role, 'viewer');
  assert.equal(out.roleMode, 'no-code');
  assert.equal(out.taskType, 'github-steward');
  assert.equal(out.requireChanges, false);
  assert.equal(out.integrate, undefined);
  assert.deepEqual(out.scope, {
    repo: 'example-user/Ace',
    workspaceId: 'prj-ce38979c',
    paths: [],
  });
  assert.ok(out.constraints.some((line: string) => /no branch\/worktree deletion/.test(line)));
  assert.ok(out.constraints.some((line: string) => /Do not merge, close, delete, prune/.test(line)));
  assert.match(out.context, /\/tmp\/plan.md/);
});

test('parseSpec: rejects invalid JSON string', () => {
  assert.throws(() => parseSpec('{not json'), /invalid JSON/);
});

test('parseSpec: rejects non-object input', () => {
  assert.throws(() => parseSpec(null), /spec object required/);
  assert.throws(() => parseSpec([]), /spec object required/);
  assert.throws(() => parseSpec(42), /spec object required/);
});

test('parseSpec: rejects missing goal', () => {
  const { goal: _g, ...rest } = VALID;
  assert.throws(() => parseSpec(rest), /goal required/);
  assert.throws(() => parseSpec({ ...VALID, goal: '   ' }), /goal required/);
});

test('parseSpec: rejects missing baseBranch', () => {
  const { baseBranch: _b, ...rest } = VALID;
  assert.throws(() => parseSpec(rest), /baseBranch required/);
});

test('parseSpec: rejects missing or invalid role', () => {
  const { role: _r, ...rest } = VALID;
  assert.throws(() => parseSpec(rest), /role required/);
  assert.throws(() => parseSpec({ ...VALID, role: 'admin' }), /role required/);
});

test('parseSpec: rejects missing or empty scope', () => {
  const { scope: _s, ...rest } = VALID;
  assert.throws(() => parseSpec(rest), /scope required/);
  assert.throws(() => parseSpec({ ...VALID, scope: {} }), /scope must declare/);
  assert.throws(() => parseSpec({ ...VALID, scope: [] }), /scope required/);
});

test('parseSpec: rejects missing or empty acceptance', () => {
  const { acceptance: _a, ...rest } = VALID;
  assert.throws(() => parseSpec(rest), /acceptance required/);
  assert.throws(() => parseSpec({ ...VALID, acceptance: [] }), /acceptance required/);
  assert.throws(
    () => parseSpec({ ...VALID, acceptance: ['ok', '  '] }),
    /acceptance\[1\] must be a non-empty string/
  );
});

test('parseSpec: editor+integrate requires ace-github-flow in skills', () => {
  assert.throws(
    () => parseSpec({ ...VALID, role: 'editor', integrate: true }),
    /requires 'ace-github-flow' in spec.skills or requiredSkills/
  );
  assert.throws(
    () => parseSpec({ ...VALID, role: 'editor', integrate: true, skills: ['ace-cli'] }),
    /requires 'ace-github-flow' in spec.skills or requiredSkills/
  );
});

test('parseSpec: editor+integrate passes when ace-github-flow is in skills', () => {
  const out = parseSpec({
    ...VALID,
    role: 'editor',
    integrate: true,
    skills: ['ace-github-flow', 'ace-cli'],
  });
  assert.equal(out.integrate, true);
  assert.deepEqual(out.skills, ['ace-github-flow', 'ace-cli']);
});

test('parseSpec: editor+integrate passes when ace-github-flow is required', () => {
  const out = parseSpec({
    ...VALID,
    role: 'editor',
    integrate: true,
    requiredSkills: ['ace-github-flow'],
  });
  assert.equal(out.integrate, true);
  assert.deepEqual(out.requiredSkills, ['ace-github-flow']);
});

test('parseSpec: viewer+integrate does not require ace-github-flow skill', () => {
  // Integrate is an editor-role concern; viewers don't open PRs.
  const out = parseSpec({ ...VALID, role: 'viewer', integrate: true });
  assert.equal(out.integrate, true);
});

test('parseSpec: integrate omitted → role=editor has no skill requirement', () => {
  const out = parseSpec({ ...VALID, role: 'editor' });
  assert.equal(out.integrate, undefined);
});

test('parseSpec: preserves object form of integrate (merge + deleteBranch)', () => {
  const out = parseSpec({
    ...VALID,
    role: 'editor',
    integrate: { merge: true, deleteBranch: false, postMergeCleanup: true },
    skills: ['ace-github-flow'],
  });
  assert.deepEqual(out.integrate, {
    merge: true,
    deleteBranch: false,
    postMergeCleanup: true,
  });
});

test('parseSpec: preserves nested merge options', () => {
  const out = parseSpec({
    ...VALID,
    role: 'editor',
    integrate: { merge: { method: 'squash', deleteBranch: true } },
    skills: ['ace-github-flow'],
  });
  assert.deepEqual(out.integrate.merge, { method: 'squash', deleteBranch: true });
});

test('parseSpec: editor+integrate object still requires ace-github-flow in skills', () => {
  assert.throws(
    () => parseSpec({ ...VALID, role: 'editor', integrate: { merge: true } }),
    /requires 'ace-github-flow' in spec.skills or requiredSkills/
  );
});

test('parseSpec: integrate=false is treated as off', () => {
  const out = parseSpec({ ...VALID, role: 'editor', integrate: false });
  assert.equal(out.integrate, undefined);
});

test('parseSpec: rejects non-object/non-boolean integrate', () => {
  assert.throws(
    () => parseSpec({ ...VALID, role: 'editor', integrate: 'yes', skills: ['ace-github-flow'] }),
    /integrate must be true\/false or an object/
  );
  assert.throws(
    () => parseSpec({ ...VALID, role: 'editor', integrate: [], skills: ['ace-github-flow'] }),
    /integrate must be true\/false or an object/
  );
});

test('parseSpec: rejects invalid goalMode', () => {
  assert.throws(
    () => parseSpec({ ...VALID, goalMode: 'always' }),
    /goalMode must be one of auto\|on\|off/
  );
});

test('parseSpec: preserves goalLedgerPath and goalLedgerMode', () => {
  const out = parseSpec({
    ...VALID,
    goalLedgerPath: '/repo/.agent/runs/msn-1-feat-1-slug',
    goalLedgerMode: 'ON',
  });
  assert.equal(out.goalLedgerPath, '/repo/.agent/runs/msn-1-feat-1-slug');
  assert.equal(out.goalLedgerMode, 'on');
});

test('parseSpec: accepts snake_case goal_ledger_* aliases', () => {
  const out = parseSpec({
    ...VALID,
    goal_ledger_path: '/repo/.agent/runs/msn-2-feat-2-slug',
    goal_ledger_mode: 'auto',
  });
  assert.equal(out.goalLedgerPath, '/repo/.agent/runs/msn-2-feat-2-slug');
  assert.equal(out.goalLedgerMode, 'auto');
});

test('parseSpec: rejects invalid goalLedgerMode', () => {
  assert.throws(
    () => parseSpec({ ...VALID, goalLedgerMode: 'sometimes' }),
    /goalLedgerMode must be one of auto\|on\|off/
  );
});

test('parseSpec: rejects invalid roleMode', () => {
  assert.throws(
    () => parseSpec({ ...VALID, roleMode: 'validator' }),
    /roleMode must be one of implementer\|reviewer\|fixback\|no-code/
  );
});

test('parseSpec: rejects invalid nativeTeamMode', () => {
  assert.throws(
    () => parseSpec({ ...VALID, nativeTeamMode: 'required' }),
    /nativeTeamMode must be one of auto\|optional\|on\|off/
  );
});

test('parseSpec: rejects invalid taskClass', () => {
  assert.throws(
    () => parseSpec({ ...VALID, taskClass: 'unknown' }),
    /taskClass must be one of/
  );
});

test('parseSpec: rejects non-array manifest list fields', () => {
  assert.throws(
    () => parseSpec({ ...VALID, manifest: { capabilities: 'ui' } }),
    /capabilities must be an array of strings/
  );
  assert.throws(
    () => parseSpec({ ...VALID, taskPackSkills: ['ok', ''] }),
    /taskPackSkills\[1\] must be a non-empty string/
  );
  assert.throws(
    () => parseSpec({ ...VALID, optionalSkills: 'ok' }),
    /optionalSkills must be an array of strings/
  );
});

test('parseSpec: passes codexModel through verbatim (trimmed, no id validation)', () => {
  const out = parseSpec({ ...VALID, codexModel: '  gpt-5.6-sol  ' });
  assert.equal(out.codexModel, 'gpt-5.6-sol');
  const snake = parseSpec({ ...VALID, codex_model: 'gpt-5.6-sol' });
  assert.equal(snake.codexModel, 'gpt-5.6-sol');
  const absent = parseSpec(VALID);
  assert.equal('codexModel' in absent, false, 'no pin ⇒ the field is omitted entirely');
});
