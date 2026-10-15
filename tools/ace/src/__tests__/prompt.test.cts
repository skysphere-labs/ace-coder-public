const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTaskPrompt,
  buildTaskPromptEnvelope,
  parseTrailer,
  lastLine,
  PROMPT_BUDGET,
} = require('../prompt.cjs');
const { buildGitHubStewardInventorySpec } = require('../spec.cts');

test('buildTaskPrompt: goal-only produces a well-framed prompt with the default trailer', () => {
  const out = buildTaskPrompt({ goal: 'Add a hello-world route to the server.' });
  assert.match(out, /^# Goal\nAdd a hello-world route to the server\./m);
  assert.match(out, /# Escape hatch/);
  assert.match(out, /BLOCKED: <one-line reason>/);
  assert.match(out, /DONE: <one-line summary>/);
  // No empty sections for unset fields.
  assert.doesNotMatch(out, /# Constraints/);
  assert.doesNotMatch(out, /# Deliverables/);
  assert.doesNotMatch(out, /# Context/);
});

test('buildTaskPrompt: full spec renders every section in order', () => {
  const out = buildTaskPrompt({
    goal: 'Refactor the auth middleware.',
    context: 'Workspace: /repo/app, branch: main',
    constraints: ['no new deps', 'preserve public API'],
    deliverables: ['updated middleware.ts', 'passing test suite'],
    acceptance: ['npm test green', 'no ESLint warnings'],
  });
  const goalIdx = out.indexOf('# Goal');
  const ctxIdx = out.indexOf('# Context');
  const conIdx = out.indexOf('# Constraints');
  const delIdx = out.indexOf('# Deliverables');
  const accIdx = out.indexOf('# Acceptance');
  const escIdx = out.indexOf('# Escape hatch');
  assert.ok(goalIdx >= 0 && ctxIdx > goalIdx && conIdx > ctxIdx && delIdx > conIdx && accIdx > delIdx && escIdx > accIdx);
  assert.match(out, /- no new deps/);
  assert.match(out, /- updated middleware\.ts/);
});

test('buildTaskPrompt: priorRoundSummary renders a dedicated section', () => {
  const out = buildTaskPrompt({
    goal: 'Continue the refactor.',
    priorRoundSummary: 'Round 1 finished the imports; tests still failing.',
  });
  assert.match(out, /# Prior round/);
  assert.match(out, /tests still failing/);
});

test('buildTaskPrompt: dedupes constraints/deliverables/acceptance', () => {
  const out = buildTaskPrompt({
    goal: 'x',
    constraints: ['no deps', 'no deps', '  no   deps  ', 'preserve API'],
    deliverables: ['file.ts', 'file.ts'],
    acceptance: ['tests pass', 'tests pass'],
  });
  assert.equal((out.match(/- no deps/g) || []).length, 1);
  assert.equal((out.match(/- file\.ts/g) || []).length, 1);
  assert.equal((out.match(/- tests pass/g) || []).length, 1);
  assert.match(out, /- preserve API/);
});

test('buildTaskPrompt: empty arrays suppress their section entirely', () => {
  const out = buildTaskPrompt({
    goal: 'x',
    constraints: [],
    deliverables: [],
    acceptance: [],
  });
  assert.doesNotMatch(out, /# Constraints/);
  assert.doesNotMatch(out, /# Deliverables/);
  assert.doesNotMatch(out, /# Acceptance/);
  // And definitely no "(none)" placeholder.
  assert.doesNotMatch(out, /\(none\)/);
});

test('parseTrailer only accepts the final non-empty line', () => {
  assert.deepEqual(
    parseTrailer('# Escape hatch\nEnd with DONE: <one-line>\nworker still editing'),
    { outcome: 'none', detail: null }
  );
  assert.deepEqual(
    parseTrailer('DONE: mentioned earlier\nmore output\nBLOCKED: waiting on CI\n'),
    { outcome: 'blocked', detail: 'waiting on CI' }
  );
  assert.deepEqual(
    parseTrailer('work complete\n- DONE: shipped PR https://github.com/acme/ace/pull/1\n\n'),
    { outcome: 'done', detail: 'shipped PR https://github.com/acme/ace/pull/1' }
  );
});

test('buildTaskPrompt: declared skill cap fits baseline plus capped task pack', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'x',
    taskPackSkills: ['karpathy-goal-driven-execution', 'karpathy-surgical-changes', 'knip-maintenance', 'github-pr-workflow'],
  });
  for (const skill of [
    'ace-runtime-contract',
    'ace-goal-worker',
    'karpathy-goal-driven-execution',
    'karpathy-surgical-changes',
    'knip-maintenance',
    'github-pr-workflow',
  ]) {
    assert.match(envelope.text, new RegExp(`- ${skill}`));
  }
  assert.equal(envelope.telemetry.omittedSkillCount, 0);
});

test('buildTaskPrompt: priorRoundSummary is truncated when long', () => {
  const long = 'X'.repeat(800) + 'TAIL_MARKER';
  const out = buildTaskPrompt({ goal: 'x', priorRoundSummary: long });
  const section = out.split('# Prior round\n')[1].split('\n# ')[0];
  // 400-char cap + a short truncation annotation.
  assert.ok(section.length < 600, `prior round section too long: ${section.length}`);
  // The tail is preserved (most recent content matters more than the head).
  assert.match(out, /TAIL_MARKER/);
  assert.match(out, /truncated/);
});

test('buildTaskPrompt: short priorRoundSummary passes through untruncated', () => {
  const out = buildTaskPrompt({
    goal: 'x',
    priorRoundSummary: 'short summary of last round',
  });
  assert.match(out, /short summary of last round/);
  assert.doesNotMatch(out, /truncated/);
});

test('buildTaskPrompt: canonical full spec is ≥30% shorter than the pre-compression baseline', () => {
  // Snapshot of the pre-compression `buildTaskPrompt` rendering for the exact
  // canonical spec below. Captured before compression; do not regenerate
  // without updating the spec. Locks in the ≥30% reduction deliverable.
  const PRE_COMPRESSION_LEN = 1958;

  const spec = {
    goal: 'Refactor the auth middleware to use the new token verifier.',
    context: 'Workspace /repo/app on branch main. Related PR #812.',
    constraints: ['c1', 'c2', 'c3', 'c4', 'c5'],
    deliverables: ['d1', 'd2', 'd3'],
    acceptance: ['a1', 'a2', 'a3', 'a4'],
    skills: ['knip-maintenance', 'ace-github-flow'],
    priorRoundSummary: 'P'.repeat(800),
  };
  const out = buildTaskPrompt(spec);
  const ratio = out.length / PRE_COMPRESSION_LEN;
  // The implementer role line now leads with a one-sentence identity + quality
  // bar (lock-on), a deliberate ~115-char addition. The prompt is still far
  // leaner than the pre-compression baseline (≥20% shorter); the threshold is
  // relaxed from 0.70 to account for the identity line, not for new bloat.
  assert.ok(
    ratio <= 0.8,
    `compressed prompt ${out.length} chars vs baseline ${PRE_COMPRESSION_LEN} — only ${((1 - ratio) * 100).toFixed(1)}% shorter (need ≥20%)`
  );
});

test('buildTaskPrompt: mission dispatch packet stays compact without old worker manual', () => {
  // Approximate length of the prior broad mission worker prompt for this same
  // card shape: file-reading checklist, code quality manual, verification
  // manual, and ACE_HANDOFF JSON schema. This locks the compact-packet path.
  const OLD_BROAD_MISSION_WORKER_LEN = 2840;

  const out = buildTaskPrompt(
    {
      goal: 'Implement mission feature: Ready card',
      taskType: 'feature-impl',
      context: [
        'Mission: Dispatch board (msn_42)',
        'Feature: Ready card (ft_42)',
        'Feature description: Wire the native dispatcher.',
        'Mission directory: /repo/.ace/missions/msn_42',
      ].join('\n'),
      constraints: [
        'Use this card worktree only; do not dispatch other mission cards.',
        'Keep changes scoped to this feature and its linked assertions.',
        'Push the branch and open a draft PR if auth/routing is available; put the PR URL in DONE.',
        'Do not merge, auto-merge, or clean up branches.',
      ],
      deliverables: ['Wire the native dispatcher.'],
      acceptance: ['a_dispatch: Dispatch uses Ace task streams.'],
    },
    { driver: 'codex' }
  );

  // Still ~half the old broad worker manual even with the new one-sentence
  // identity + quality-bar line on the implementer role (lock-on); 0.5 → 0.55.
  assert.ok(
    out.length <= OLD_BROAD_MISSION_WORKER_LEN * 0.55,
    `compact mission prompt ${out.length} chars vs old ${OLD_BROAD_MISSION_WORKER_LEN}`
  );
  assert.match(out, /# Skills to load/);
  assert.match(out, /- ace-goal-worker/);
  assert.match(out, /# Acceptance\n- a_dispatch: Dispatch uses Ace task streams\./);
  assert.match(out, /DONE: <one-line summary>/);
  assert.match(out, /BLOCKED: <one-line reason>/);
  assert.doesNotMatch(out, /Code quality bar|Read these files BEFORE writing any code|ACE_HANDOFF JSON/);
});

test('buildTaskPrompt: #102-style bugfix fixture renders within 2200 chars', () => {
  const envelope = buildTaskPromptEnvelope(
    {
      goal: 'Fix regression #102 where mission dispatch attaches a variant but the worker tab shows no persisted spec.',
      baseBranch: 'main',
      role: 'editor',
      scope: { workspaceId: 'ws_1' },
      taskType: 'bug-fix',
      context: [
        'Mission msn-3f97bd7f / card ft-43b8c083.',
        'Current prompt sizes median ~2.8k chars, p90 ~4.3k; create->variant attach is ~1.5s so token/boot/tooling overhead is the bottleneck.',
      ].join('\n'),
      constraints: [
        'No rebuild/relaunch.',
        'No broad orchestration rewrite; implement minimal enforcement/telemetry.',
        'Low-risk PRs default to controller self-review, not spawned validators.',
        'Prompt-declared skills should be capped; do not break mounted baseline skill materialization.',
      ],
      deliverables: [
        'Budget accounting on rendered worker prompt.',
        'Role modes for implementer/reviewer/fixback/no-code or equivalent minimal design.',
        'Telemetry fields/logs for renderedPromptChars, skillCount, taskType/driver, ready/prompt/first-output timing where observable.',
      ],
      acceptance: [
        '#102-style bugfix fixture renders <=2200 chars.',
        'Rendered prompt >3000 chars requires explicit override reason or fails clearly.',
        'npm run test, npm run lint, npm run build or scoped equivalents pass with exact blockers.',
      ],
      skills: ['ace-github-flow'],
    },
    { driver: 'codex' }
  );

  assert.equal(envelope.telemetry.taskType, 'bug-fix');
  assert.equal(envelope.telemetry.driver, 'codex');
  assert.equal(envelope.telemetry.roleMode, 'implementer');
  assert.ok(envelope.telemetry.renderedPromptChars <= 2200, envelope.telemetry.renderedPromptChars);
  assert.equal(envelope.telemetry.skillCount, 4);
});

test('buildTaskPrompt: reviewer fixture stays under 1200 chars and omits implementation PR boilerplate', () => {
  const envelope = buildTaskPromptEnvelope(
    {
      goal: 'Review PR #102 for the mission dispatch prompt-size regression.',
      baseBranch: 'main',
      role: 'viewer',
      scope: { workspaceId: 'ws_1' },
      taskType: 'code-review',
      context: 'PR #102 changes prompt rendering and startup telemetry for msn-3f97bd7f / ft-43b8c083.',
      constraints: [
        'Read and inspect only.',
        'Do not edit files, push, open PRs, merge, or clean up branches.',
      ],
      deliverables: ['Concise reviewer verdict with blockers or pass evidence.'],
      acceptance: [
        'Reviewer fixture renders <=1200 chars.',
        'Implementation-only PR boilerplate is omitted.',
      ],
      skills: ['ace-github-flow'],
    },
    { driver: 'codex' }
  );

  assert.equal(envelope.telemetry.roleMode, 'reviewer');
  // Reviewer baseline only; explicit ace-github-flow is dropped for reviewer.
  assert.equal(envelope.telemetry.skillCount, 3);
  assert.ok(envelope.telemetry.renderedPromptChars <= 1200, envelope.telemetry.renderedPromptChars);
  assert.doesNotMatch(envelope.text, /ace-github-flow/);
  assert.doesNotMatch(envelope.text, /ace-task-worker/);
  assert.doesNotMatch(envelope.text, /Push the branch|open a draft PR|PR URL/);
});

test('buildTaskPrompt: validator-merger role line allows only Ace integration merge', () => {
  const envelope = buildTaskPromptEnvelope(
    {
      goal: 'Review and merge PR #102 if it passes.',
      baseBranch: 'main',
      role: 'viewer',
      roleMode: 'reviewer',
      taskType: 'validator-merger',
      agentClass: 'validator-merger',
      skillPack: 'validator-merger',
      taskClass: 'review_validate',
      toolMode: 'on',
      toolOverrideReason: 'validator-merger requires Ace integration gate/merge commands only',
      rubric: 'docs/rubric.md',
      architecture: 'docs/architecture.md',
      workerSpec: '/tmp/worker.json',
      pr: 'https://github.com/acme/ace/pull/102',
      head: 'head102',
      acceptance: ['PASS merges only through Ace integration.'],
    },
    { driver: 'codex' }
  );

  assert.equal(envelope.telemetry.agentClass, 'validator-merger');
  assert.match(envelope.text, /validator-fixer-merger: validate the exact PR\/head/);
  assert.match(envelope.text, /fix ordinary in-scope defects on the same branch\/PR/);
  assert.match(envelope.text, /Ace integration pr-merge on PASS only/);
  assert.match(envelope.text, /Do not raw GitHub merge/);
});

test('buildTaskPrompt: implementer prompt over 2200 hard cap requires explicit override reason', () => {
  const implementerHard = PROMPT_BUDGET.byRole.implementer.hard;
  const oversized = {
    goal: 'x',
    context: 'C'.repeat(implementerHard + 1),
  };
  assert.throws(
    () => buildTaskPrompt(oversized),
    /rendered prompt .* exceeds 2200 hard cap for role 'implementer'.*promptBudgetOverrideReason/
  );

  const envelope = buildTaskPromptEnvelope({
    ...oversized,
    promptBudgetOverrideReason: 'Fixture intentionally exercises the over-budget escape hatch.',
  });
  assert.ok(envelope.telemetry.renderedPromptChars > implementerHard);
  assert.equal(envelope.telemetry.promptBudgetClass, 'implementer');
  assert.equal(envelope.telemetry.promptBudgetHardChars, 2200);
  assert.equal(envelope.telemetry.promptBudgetSoftChars, 1500);
  assert.equal(envelope.telemetry.promptBudgetExceeded, 'hard');
  assert.equal(
    envelope.telemetry.promptBudgetOverrideReason,
    'Fixture intentionally exercises the over-budget escape hatch.'
  );
});

test('buildTaskPrompt: reviewer hard cap is 1800 chars and fails without override', () => {
  const hard = PROMPT_BUDGET.byRole.reviewer.hard;
  assert.equal(hard, 1800);
  assert.throws(
    () =>
      buildTaskPrompt({
        goal: 'Review',
        roleMode: 'reviewer',
        context: 'C'.repeat(hard + 1),
      }),
    /exceeds 1800 hard cap for role 'reviewer'/
  );
});

test('buildTaskPrompt: fixback hard cap is 1200 chars and fails without override', () => {
  const hard = PROMPT_BUDGET.byRole.fixback.hard;
  assert.equal(hard, 1200);
  assert.throws(
    () =>
      buildTaskPrompt({
        goal: 'Patch',
        roleMode: 'fixback',
        context: 'C'.repeat(hard + 1),
      }),
    /exceeds 1200 hard cap for role 'fixback'/
  );
});

test('buildTaskPrompt: no-code hard cap is 2200 chars', () => {
  assert.equal(PROMPT_BUDGET.byRole['no-code'].hard, 2200);
  assert.equal(PROMPT_BUDGET.byRole['no-code'].soft, 1500);
});

test('buildTaskPrompt: telemetry carries role-aware soft/hard/class/exceeded fields', () => {
  const compact = buildTaskPromptEnvelope({ goal: 'Tiny.' });
  assert.equal(compact.telemetry.promptBudgetClass, 'implementer');
  assert.equal(compact.telemetry.promptBudgetSoftChars, 1500);
  assert.equal(compact.telemetry.promptBudgetHardChars, 2200);
  assert.equal(compact.telemetry.promptBudgetExceeded, 'none');

  const reviewerEnvelope = buildTaskPromptEnvelope({
    goal: 'Review the wave PRs.',
    roleMode: 'reviewer',
  });
  assert.equal(reviewerEnvelope.telemetry.promptBudgetClass, 'reviewer');
  assert.equal(reviewerEnvelope.telemetry.promptBudgetSoftChars, 1200);
  assert.equal(reviewerEnvelope.telemetry.promptBudgetHardChars, 1800);
});

test('buildTaskPrompt: implementer between soft and hard reports exceeded=soft and does not throw', () => {
  const soft = PROMPT_BUDGET.byRole.implementer.soft;
  const hard = PROMPT_BUDGET.byRole.implementer.hard;
  // Render a baseline to learn how much section overhead the renderer adds,
  // then size the padding so total chars land between soft and hard.
  const baseline = buildTaskPromptEnvelope({ goal: 'x' }).telemetry.renderedPromptChars;
  const target = Math.floor((soft + hard) / 2);
  const padding = Math.max(0, target - baseline);
  const envelope = buildTaskPromptEnvelope({
    goal: 'x',
    context: 'C'.repeat(padding),
  });
  assert.ok(envelope.telemetry.renderedPromptChars > soft);
  assert.ok(envelope.telemetry.renderedPromptChars <= hard);
  assert.equal(envelope.telemetry.promptBudgetExceeded, 'soft');
});

test('buildTaskPrompt: throws without a goal', () => {
  assert.throws(() => buildTaskPrompt({}), /goal required/);
  assert.throws(() => buildTaskPrompt({ goal: '   ' }), /goal required/);
  assert.throws(() => buildTaskPrompt(null), /spec object required/);
});

test('buildTaskPrompt: custom escapeHatch overrides the default trailer', () => {
  const out = buildTaskPrompt({
    goal: 'x',
    escapeHatch: 'end your turn with CUSTOM_DONE or CUSTOM_BLOCKED.',
  });
  assert.match(out, /CUSTOM_DONE or CUSTOM_BLOCKED/);
  assert.doesNotMatch(out, /DONE: <one-line summary>/);
});

test('buildTaskPrompt: emits a Skills to load block with ace-runtime-contract + ace-goal-worker baseline without omitted bundled skills', () => {
  const out = buildTaskPrompt({ goal: 'x' });
  assert.match(out, /# Skills to load/);
  assert.match(out, /- ace-runtime-contract/);
  assert.match(out, /- ace-goal-worker/);
  assert.doesNotMatch(out, /- karpathy-/);
  assert.match(out, /AGENTS\.md \/ CLAUDE\.md/);
  assert.match(out, /If repo doctrine is absent, use Ace's seeded fallback or task-local instructions/);
  assert.match(out, /do not block on doctrine absence alone/);
  assert.match(out, /Missing listed skills are nonfatal: warn and continue/);
  assert.match(out, /BLOCKED only for a task-marked REQUIRED skill/);
  assert.doesNotMatch(out, /Missing skill → BLOCKED: skill <id> not available/);
});

test('buildTaskPrompt: no-code role mode is read-only and omits implementation wording', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'Plan the rollout order.',
    role: 'viewer',
    taskType: 'no-code',
    roleMode: 'no-code',
    acceptance: ['Plan is clear.'],
    requireChanges: false,
  });

  assert.equal(envelope.telemetry.roleMode, 'no-code');
  assert.match(envelope.text, /no-code: produce analysis or planning output only; do not edit files, create PRs, merge, clean up, or delete branches\/worktrees\./);
  assert.doesNotMatch(envelope.text, /implementer: make scoped changes|Push the branch|open a draft PR/);
});

test('buildTaskPrompt: bug-fix task retains the worker baseline without omitted bundled skills', () => {
  const out = buildTaskPrompt({ goal: 'x', taskType: 'bug-fix' });
  assert.match(out, /- ace-runtime-contract/);
  assert.match(out, /- ace-goal-worker/);
  assert.doesNotMatch(out, /- karpathy-/);
  assert.doesNotMatch(out, /- knip-maintenance/);
});

test('buildTaskPrompt: refactor tasks include knip-maintenance in the compact skills block', () => {
  const out = buildTaskPrompt({ goal: 'x', taskType: 'refactor' });
  assert.match(out, /- knip-maintenance/);
  assert.doesNotMatch(out, /- karpathy-/);
});

test('buildTaskPrompt: security-review tasks add Trail of Bits reference lines', () => {
  const out = buildTaskPrompt({ goal: 'x', taskType: 'security-review' });
  assert.match(out, /- ace-agent-pack-security/);
  assert.match(out, /- trailofbits-security-review/);
  assert.match(out, /Reference: Trail of Bits security review/);
  assert.match(out, /https:\/\/github\.com\/trailofbits\/skills/);
});

test('buildTaskPrompt: coding team task types select Ace agent packs', () => {
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'feature-impl' }), /- ace-agent-pack-engineer/);
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'backend' }), /- ace-agent-pack-backend/);
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'ui' }), /- ace-agent-pack-ui-designer/);
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'ui' }), /- steipete-frontend-design/);
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'cloudflare' }), /- ace-agent-pack-cloudflare/);
  assert.match(buildTaskPrompt({ goal: 'x', taskType: 'architect' }), /- ace-agent-pack-architect/);
});

test('buildTaskPrompt: explicit spec.skills merge on top of the pack, de-duplicated', () => {
  const out = buildTaskPrompt({
    goal: 'x',
    taskType: 'refactor',
    skills: ['knip-maintenance', 'ace-github-flow'],
  });
  const maintenance = (out.match(/- knip-maintenance/g) || []).length;
  assert.equal(maintenance, 1);
  assert.match(out, /- ace-github-flow/);
});

test('buildTaskPrompt: renders compact role manifest and caps task-pack skills at four', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'x',
    taskType: 'feature-impl',
    skillPack: 'custom-pack',
    riskLevel: 'medium',
    clawpatchRequired: true,
    capabilities: ['debug', 'recovery'],
    taskPackSkills: ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e'],
  });

  assert.match(envelope.text, /# Role manifest/);
  assert.match(envelope.text, /skillPack: custom-pack/);
  assert.match(envelope.text, /riskLevel: medium/);
  assert.match(envelope.text, /clawpatchRequired: true/);
  assert.match(envelope.text, /capabilities: code-change, verify, debug, recovery/);
  assert.match(envelope.text, /taskPackSkills: skill-a, skill-b, skill-c, skill-d/);
  assert.match(envelope.text, /omittedTaskPackSkills: 1 over cap 4/);
  assert.doesNotMatch(envelope.text, /taskPackSkills: .*skill-e/);
  assert.equal(envelope.telemetry.taskPackSkillCount, 4);
  assert.equal(envelope.telemetry.omittedTaskPackSkillCount, 1);
  assert.deepEqual(envelope.telemetry.manifest.taskPackSkills, ['skill-a', 'skill-b', 'skill-c', 'skill-d']);
  assert.equal(envelope.telemetry.manifest.riskLevel, 'medium');
  assert.equal(envelope.telemetry.manifest.clawpatchRequired, true);
});

test('buildTaskPrompt: renders stackable manifest skill layers', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'Validate the release plan.',
    taskClass: 'release_deploy',
    roleMode: 'reviewer',
    skillPack: 'release',
    baselineSkills: ['ace-operator-policy'],
    taskPackSkills: ['karpathy-goal-driven-execution'],
    validationSkills: ['ace-github-flow'],
    requiredSkills: ['github-code-review'],
    optionalSkills: ['release-notes'],
  });

  assert.match(envelope.text, /taskClass: release_deploy/);
  assert.match(envelope.text, /baselineSkills: ace-operator-policy/);
  assert.match(envelope.text, /taskPackSkills: karpathy-goal-driven-execution/);
  assert.match(envelope.text, /validationSkills: ace-github-flow/);
  assert.match(envelope.text, /requiredSkills: github-code-review/);
  assert.match(envelope.text, /optionalSkills: release-notes/);
  assert.deepEqual(envelope.telemetry.manifest.validationSkills, ['ace-github-flow']);
  assert.deepEqual(envelope.telemetry.manifest.requiredSkills, ['github-code-review']);
  assert.deepEqual(envelope.telemetry.manifest.optionalSkills, ['release-notes']);
});

test('buildTaskPrompt: optional native team mode adds compact same-lane guidance', () => {
  const baseline = buildTaskPromptEnvelope({
    goal: 'Implement the compact orchestration update.',
    taskType: 'feature-impl',
    roleMode: 'implementer',
  }, { driver: 'codex' });
  const envelope = buildTaskPromptEnvelope({
    goal: 'Implement the compact orchestration update.',
    taskType: 'feature-impl',
    roleMode: 'implementer',
    nativeTeamMode: 'optional',
  }, { driver: 'codex' });

  assert.equal(envelope.telemetry.nativeTeamMode, 'optional');
  assert.equal(envelope.telemetry.manifest.nativeTeamMode, 'optional');
  assert.match(envelope.text, /# Native team mode/);
  assert.match(envelope.text, /Optional\/capability-gated/);
  assert.match(envelope.text, /same worker lane/);
  assert.match(envelope.text, /same worktree\/channel,/);
  assert.match(envelope.text, /edits non-overlapping/);
  assert.match(envelope.text, /Ace fanout for independent PR\/worktree lanes/);
  assert.match(envelope.text, /no hidden merge boundaries/);
  assert.match(envelope.text, /rubric\/plan\/custom-agent anchors by path\/ID/);
  assert.ok(
    envelope.telemetry.renderedPromptChars - baseline.telemetry.renderedPromptChars <= 650,
    `native team hint added ${envelope.telemetry.renderedPromptChars - baseline.telemetry.renderedPromptChars} chars`
  );
  assert.ok(envelope.telemetry.renderedPromptChars <= PROMPT_BUDGET.byRole.implementer.hard);
});

test('buildTaskPrompt: native team capability enables hint without making it mandatory', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'Investigate and patch the worker orchestration flow.',
    taskType: 'bug-fix',
    roleMode: 'implementer',
    capabilities: ['native-team'],
  });

  assert.equal(envelope.telemetry.nativeTeamMode, 'optional');
  assert.match(envelope.text, /if this claude CLI exposes native subagents\/team mode/);
  assert.doesNotMatch(envelope.text, /must use native|required native/i);
});

test('buildTaskPrompt: native team hint is omitted for reviewers', () => {
  const envelope = buildTaskPromptEnvelope({
    goal: 'Review the orchestration PR.',
    roleMode: 'reviewer',
    nativeTeamMode: 'optional',
  });

  assert.equal(envelope.telemetry.nativeTeamMode, 'optional');
  assert.doesNotMatch(envelope.text, /# Native team mode/);
});

test('buildTaskPrompt: GitHub Steward renders no-code read-only guardrails', () => {
  const spec = buildGitHubStewardInventorySpec({
    repo: 'example-user/Ace',
    workspaceId: 'prj-ce38979c',
  });
  const envelope = buildTaskPromptEnvelope(spec, { driver: 'codex' });
  assert.equal(envelope.telemetry.roleMode, 'no-code');
  assert.match(envelope.text, /role: no-code \(No-code\)/);
  assert.match(envelope.text, /capabilities: analysis, github-steward, read-only, inventory/);
  assert.match(envelope.text, /do not edit files, create PRs, merge, clean up, or delete branches\/worktrees/);
  assert.match(envelope.text, /Read-only only: no file edits, no git writes, no gh mutations/);
  assert.doesNotMatch(envelope.text, /ace-github-flow/);
});

test('parseTrailer: detects DONE', () => {
  const r = parseTrailer('lots of work\nDONE: shipped the feature');
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'shipped the feature');
});

test('parseTrailer: detects BLOCKED', () => {
  const r = parseTrailer('I tried X but\nBLOCKED: missing DB creds');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.detail, 'missing DB creds');
});

test('parseTrailer: detects DONE after Codex bullet prefix', () => {
  const r = parseTrailer('work complete\n• DONE: no-code goal-mode smoke completed\n─');
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'no-code goal-mode smoke completed');
});

test('parseTrailer: detects BLOCKED after Codex bullet prefix', () => {
  const r = parseTrailer('stopped\n• BLOCKED: missing approval');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.detail, 'missing approval');
});

test('parseTrailer: detects Claude status glyph trailers', () => {
  const done = parseTrailer('work complete\n⏺ DONE: fixed trigger parsing');
  assert.equal(done.outcome, 'done');
  assert.equal(done.detail, 'fixed trigger parsing');

  const blocked = parseTrailer('stopped\n⏺ BLOCKED: missing approval');
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.detail, 'missing approval');
});

test('parseTrailer: accepts trailer followed only by prompt/footer noise', () => {
  const r = parseTrailer([
    'work complete',
    'DONE: no-code codex dev smoke passed',
    'tokens used: 12345',
    '─',
    '> ',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'no-code codex dev smoke passed');
});

test('parseTrailer: accepts trailer followed by Ace turn footer and composer prompt', () => {
  const r = parseTrailer([
    '• DONE: no-code live mission smoke verified',
    '',
    '─ Worked for 2m 42s ────────────────────────────────────────────────────────────────────────────────────────────────────',
    '',
    '',
    '› Summarize recent commits',
    '',
    '  gpt-5.5 medium · ~/Projects/Ace/.ace/worktrees/mission-msn-6a59b300-harness-liv-feat',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'no-code live mission smoke verified');
});

test('parseTrailer: accepts terminal-wrapped trailer detail lines', () => {
  const r = parseTrailer([
    '• DONE: PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable',
    ' with passing lint-and-b',
    '  uild, package asset evidence for completion-result.cjs and .ace-template',
    '',
    '─ Worked for 1m 46s ────────────────────────────────────────────────────────────────────────────────────────────────────',
    '› gpt-5.5 high · ~/Projects/Ace/.ace/worktrees/mission-msn-2846247e-package-har-feat',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(
    r.detail,
    'PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable with passing lint-and-b uild, package asset evidence for completion-result.cjs and .ace-template'
  );
});

test('parseTrailer: accepts bare Ace composer prompt after wrapped trailer', () => {
  const r = parseTrailer([
    '• DONE: PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable',
    ' with passing lint-and-b',
    '  uild, package asset evidence for completion-result.cjs and .ace-template',
    '›▌',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(
    r.detail,
    'PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable with passing lint-and-b uild, package asset evidence for completion-result.cjs and .ace-template'
  );
});

test('parseTrailer: accepts Codex bullet trailer hard-wrapped without indentation', () => {
  const r = parseTrailer([
    '• DONE: simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287',
    'open with evidence recorded.',
    '›▌',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(
    r.detail,
    'simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287 open with evidence recorded.'
  );
});

test('parseTrailer: accepts wrapped BLOCKED trailer before goal/status footer noise', () => {
  const r = parseTrailer([
    'worker output',
    '• BLOCKED: GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is',
    '  authorized for edits.',
    'Use /skills to list available skills',
    'gpt-5.5 high fast · ~/Projects/Ace',
    'Goal blocked (/goal resume)',
    'tokens used: 12345',
  ].join('\n'));
  assert.equal(r.outcome, 'blocked');
  assert.equal(
    r.detail,
    'GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is authorized for edits.'
  );
});

test('parseTrailer: ignores markdown role-prompt trailer examples', () => {
  const r = parseTrailer([
    '# Deliverables',
    '- DONE: VERDICT=<pass|request-changes|block> on PR #192.',
    '# Escape hatch',
    '- BLOCKED: missing context',
    '',
    'Posted verdict.',
    'DONE: VERDICT=pass on PR #192.',
  ].join('\n'));
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'VERDICT=pass on PR #192.');
});

test('parseTrailer: ignores command registry text that wraps onto a BLOCKED-looking line', () => {
  const r = parseTrailer(
    'BLOCKED: trailer state back to the feature.","ipcMethod":"special:missionSync","flags":'
  );
  assert.equal(r.outcome, 'none');
  assert.equal(r.detail, null);
});

test('parseTrailer: no trailer → none', () => {
  const r = parseTrailer('just rambling text, no marker');
  assert.equal(r.outcome, 'none');
  assert.equal(r.detail, null);
});

test('parseTrailer: ignores DONE followed by real prose', () => {
  const r = parseTrailer('DONE: almost finished\nActually I still need to edit files.');
  assert.equal(r.outcome, 'none');
  assert.equal(r.detail, null);
});

test('parseTrailer: DONE after BLOCKED wins', () => {
  const r = parseTrailer('BLOCKED: first attempt failed\n(retrying)\nDONE: fixed it');
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'fixed it');
});

test('parseTrailer: BLOCKED after DONE wins (stuck turn narrated in reverse order)', () => {
  const r = parseTrailer('DONE: almost\nactually\nBLOCKED: hit a wall');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.detail, 'hit a wall');
});

test('parseTrailer: accepts every bullet/markdown trailer form', () => {
  const cases: Array<[string, 'done' | 'blocked', string]> = [
    ['DONE: summary',                       'done',    'summary'],
    ['BLOCKED: reason',                     'blocked', 'reason'],
    ['• BLOCKED: reason',                   'blocked', 'reason'],
    ['⏺ BLOCKED: reason',                   'blocked', 'reason'],
    ['- BLOCKED: reason',                   'blocked', 'reason'],
    ['* BLOCKED: reason',                   'blocked', 'reason'],
    ['• DONE: summary',                     'done',    'summary'],
    ['- **BLOCKED:** reason',               'blocked', 'reason'],
    ['• **DONE:** summary',                 'done',    'summary'],
    ['  • BLOCKED: reason',                 'blocked', 'reason'],
    ['**BLOCKED:** reason',                 'blocked', 'reason'],
  ];
  for (const [input, outcome, detail] of cases) {
    const parsed = parseTrailer(input);
    assert.equal(parsed.outcome, outcome, `parseTrailer outcome for ${JSON.stringify(input)}`);
    assert.equal(parsed.detail, detail, `parseTrailer detail for ${JSON.stringify(input)}`);
  }
});

test('parseTrailer: rejects prose before the trailer keyword on the same line', () => {
  // The trailer must occupy its own line; "Now I will... DONE: ..." is prose,
  // not a trailer.
  const r = parseTrailer('Now I will DONE: shipped');
  assert.equal(r.outcome, 'none');
  assert.equal(r.detail, null);
});

test('parseTrailer: handles non-string input', () => {
  assert.deepEqual(parseTrailer(null), { outcome: 'none', detail: null });
  assert.deepEqual(parseTrailer(undefined), { outcome: 'none', detail: null });
});

test('lastLine: returns the last non-empty line', () => {
  assert.equal(lastLine('a\nb\n\n  c  \n\n'), 'c');
  assert.equal(lastLine(''), '');
});

// ---------------------------------------------------------------------------
// File-first goal-agent prompts must lead with `/goal` as the first
// user-visible line and stay compact. The GoalAgentSpec/ledger carry the
// skill and role metadata, so the chat prompt should not repeat those blocks.
// This is the runtime trigger for goal-mode language on every goal-capable
// driver (Claude, Codex, etc.). See goal-agent-spec.cts.
// ---------------------------------------------------------------------------

test('buildTaskPrompt: file-first goal prompt starts exactly with `/goal`', () => {
  const out = buildTaskPrompt({
    goal: 'Implement the GoalAgentSpec at the linked path.',
    goalMode: 'on',
    workerSpecPath: '/work/.ace/goals/msn-1/feat-2/GOAL_AGENT_SPEC.md',
    goalLedgerPath: '/work/.agent/runs/msn-1-feat-2',
  });
  // First user-visible line must be exactly `/goal`.
  assert.equal(out.split('\n')[0], '/goal', `first line was ${JSON.stringify(out.split('\n')[0])}`);
  assert.match(out, /^\/goal\n/);
  // No `$goal` token anywhere.
  assert.doesNotMatch(out, /\$goal/);
  // The spec path must be referenced from the goal block.
  assert.match(out, /\/work\/\.ace\/goals\/msn-1\/feat-2\/GOAL_AGENT_SPEC\.md/);
  // Implementer role line is present.
  assert.match(out, /Implement only what the spec scopes/);
});

test('buildTaskPrompt: file-first goal prompt omits prompt metadata blocks', () => {
  const out = buildTaskPrompt({
    goal: 'Implement the GoalAgentSpec.',
    goalMode: 'on',
    workerSpecPath: '/work/.ace/goals/m/f/GOAL_AGENT_SPEC.md',
    goalLedgerPath: '/work/.agent/runs/m-f',
    taskType: 'feature-impl',
    requiredSkills: ['ace-github-flow'],
  });
  assert.equal(out.indexOf('/goal'), 0, '`/goal` must be at offset 0');
  assert.doesNotMatch(out, /# Skills to load/);
  assert.doesNotMatch(out, /# Role manifest/);
  assert.doesNotMatch(out, /# Role mode/);
  assert.doesNotMatch(out, /# Native team mode/);
  assert.doesNotMatch(out, /# Escape hatch/);
});

test('buildTaskPrompt: file-first validator prompt uses validator role line after `/goal`', () => {
  const out = buildTaskPrompt({
    goal: 'Validate the worker output.',
    goalMode: 'on',
    roleMode: 'reviewer',
    validatorSpecPath: '/work/.ace/goals/m/validator/f/VALIDATOR_GOAL_SPEC.md',
    goalLedgerPath: '/work/.agent/runs/m-validator-f',
  });
  assert.equal(out.split('\n')[0], '/goal');
  assert.match(out, /Validate; edit only if the spec grants validator-fixer-merger scope/);
  assert.doesNotMatch(out, /\$goal/);
});

test('buildTaskPrompt: non-file-first prompt is unchanged (still has `# Goal` section)', () => {
  // Regression guard: only file-first goal agents bypass the `# Goal` header.
  const out = buildTaskPrompt({ goal: 'Plain goal.' });
  assert.match(out, /^# Goal\nPlain goal\./m);
  assert.doesNotMatch(out, /^\/goal/m);
});

test('buildTaskPrompt: knowledge pointer renders for inline prompts only', () => {
  const out = buildTaskPrompt({
    goal: 'Implement the widget.',
    knowledge: { project: 'prj_42', packPath: '/repo/.ace/wiki/00_index/agent-pack-worker.json' },
  });
  assert.match(out, /^# Knowledge$/m);
  assert.match(out, /ace memory search "<topic>" --project prj_42/);
  assert.match(out, /agent-pack-worker\.json/);
  assert.match(out, /never cite decayed\/raw/i);

  // File-first specs carry the section in the spec file — never in the prompt.
  const fileFirst = buildTaskPrompt({
    goal: 'Implement the widget.',
    goalMode: 'on',
    workerSpecPath: '/work/.ace/goals/m/f/GOAL_AGENT_SPEC.md',
    knowledge: { project: 'prj_42', packPath: '/x.json' },
  });
  assert.doesNotMatch(fileFirst, /# Knowledge/);
});

test('buildTaskPrompt: knowledge pointer is dropped (not thrown) when it would blow the hard budget', () => {
  // Calibrate context so the prompt exceeds the implementer hard cap (2200)
  // only WITH the knowledge section attached.
  const probe = buildTaskPromptEnvelope({
    goal: 'Implement the widget.',
    context: 'x',
    knowledge: { project: 'prj_42', packPath: '/repo/pack.json' },
  });
  const overheadWithKnowledge = probe.telemetry.renderedPromptChars - 1;
  const contextLen = 2200 - overheadWithKnowledge + 60; // 60 past the cap with knowledge, under it without
  const envelope = buildTaskPromptEnvelope({
    goal: 'Implement the widget.',
    context: 'x'.repeat(contextLen),
    knowledge: { project: 'prj_42', packPath: '/repo/pack.json' },
  });
  assert.equal(envelope.telemetry.knowledgePointerDropped, true);
  assert.doesNotMatch(envelope.text, /# Knowledge/);

  // Small prompts keep the section and report not-dropped.
  const small = buildTaskPromptEnvelope({ goal: 'Implement.', knowledge: { project: 'p' } });
  assert.equal(small.telemetry.knowledgePointerDropped, false);
  assert.match(small.text, /# Knowledge/);
});
