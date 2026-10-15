const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createDelegatedTaskWithDeps,
  deriveStreamLabelForTask,
  deriveTaskSlug,
  deriveTaskTitle,
  resolveTaskTypeTag,
  computeFreeBranchName,
} = require('../local-core.cjs');

test('resolveTaskTypeTag: closed vocabulary with update fallback', () => {
  assert.equal(resolveTaskTypeTag('feature-impl'), 'feat');
  assert.equal(resolveTaskTypeTag('feat'), 'feat');
  assert.equal(resolveTaskTypeTag('bug-fix'), 'bug');
  assert.equal(resolveTaskTypeTag('BUG'), 'bug');
  assert.equal(resolveTaskTypeTag('ui'), 'ui');
  assert.equal(resolveTaskTypeTag('refactor'), 'refactor');
  assert.equal(resolveTaskTypeTag('code-review'), 'review');
  assert.equal(resolveTaskTypeTag('ops'), 'ops');
  // Folded / unknown / missing → update
  assert.equal(resolveTaskTypeTag('research'), 'update');
  assert.equal(resolveTaskTypeTag('planning'), 'update');
  assert.equal(resolveTaskTypeTag('docs'), 'update');
  assert.equal(resolveTaskTypeTag('generic'), 'update');
  assert.equal(resolveTaskTypeTag(null), 'update');
  assert.equal(resolveTaskTypeTag(''), 'update');
});

test('computeFreeBranchName: returns the base candidate when nothing collides', async () => {
  const r = await computeFreeBranchName({
    baseCandidate: 'smoke-ui',
    refExists: async () => false,
    pathExists: async () => false,
    worktreeJoin: (name: any) => path.join('/root', name),
  });
  assert.equal(r.branch, 'smoke-ui');
  assert.equal(r.worktreePath, path.join('/root', 'smoke-ui'));
});

test('computeFreeBranchName: appends -2 when the first candidate collides', async () => {
  // Two tasks named "Smoke UI" with taskType=ui — first gets smoke-ui, the
  // second must get smoke-ui-2.
  const existingRefs = new Set(['smoke-ui']);
  const r = await computeFreeBranchName({
    baseCandidate: 'smoke-ui',
    refExists: async (name: any) => existingRefs.has(name),
    pathExists: async () => false,
    worktreeJoin: (name: any) => path.join('/root', name),
  });
  assert.equal(r.branch, 'smoke-ui-2');
  assert.equal(r.worktreePath, path.join('/root', 'smoke-ui-2'));
});

test('computeFreeBranchName: walks past -2, -3 to the first free suffix', async () => {
  const existingRefs = new Set(['weebee-feat', 'weebee-feat-2', 'weebee-feat-3']);
  const r = await computeFreeBranchName({
    baseCandidate: 'weebee-feat',
    refExists: async (name: any) => existingRefs.has(name),
    pathExists: async () => false,
    worktreeJoin: (name: any) => path.join('/root', name),
  });
  assert.equal(r.branch, 'weebee-feat-4');
});

test('computeFreeBranchName: a colliding worktree dir counts the same as a ref', async () => {
  // No refs exist, but the worktree dir is already on disk from a prior
  // failed run. Must skip to the -2 suffix anyway.
  const existingPaths = new Set([path.join('/root', 'social-update')]);
  const r = await computeFreeBranchName({
    baseCandidate: 'social-update',
    refExists: async () => false,
    pathExists: async (p: any) => existingPaths.has(p),
    worktreeJoin: (name: any) => path.join('/root', name),
  });
  assert.equal(r.branch, 'social-update-2');
});

test('computeFreeBranchName: throws after maxTries collisions', async () => {
  await assert.rejects(
    () =>
      computeFreeBranchName({
        baseCandidate: 'x-feat',
        refExists: async () => true, // everything collides
        pathExists: async () => false,
        worktreeJoin: (name: any) => '/root/' + name,
        maxTries: 3,
      }),
    /could not find a free branch name after 3 tries/
  );
});

test('deriveTaskSlug + resolveTaskTypeTag: expected branch-bases for representative task names', () => {
  // Mirrors the "paste the resolved branch name" examples. The worktree
  // layer caps the slug at 40 chars; this is the reference input for that.
  // When the slug already ends with the tag (orchestrator followed the
  // `<slug>-<type>` label convention), we don't re-append.
  const cases = [
    { name: 'Smoke UI', type: 'ui', expected: 'smoke-ui' },
    { name: 'Smoke', type: 'ui', expected: 'smoke-ui' },
    { name: 'Weebee auth endpoint', type: 'feature-impl', expected: 'weebee-auth-endpoint-feat' },
    { name: 'Social share update', type: null, expected: 'social-share-update' },
    { name: 'Fix crash on startup', type: 'bug-fix', expected: 'fix-crash-on-startup-bug' },
    { name: 'Tidy login flow', type: 'refactor', expected: 'tidy-login-flow-refactor' },
    { name: 'PR review 42', type: 'code-review', expected: 'pr-review-42-review' },
    { name: 'Fix future task run display titles branch names worktree dirs', type: 'feature-impl', expected: 'fix-future-task-run-display-titles-feat' },
  ];
  for (const c of cases) {
    const slug = deriveTaskSlug(c.name, { maxLength: 40 });
    const tag = resolveTaskTypeTag(c.type);
    const base = slug === tag || slug.endsWith(`-${tag}`) ? slug : `${slug}-${tag}`;
    assert.equal(base, c.expected, `case ${c.name} / ${c.type}`);
  }
});

test('deriveTaskTitle: strips goal-mode prompt boilerplate into concise titles', () => {
  const cases = [
    {
      label: null,
      agent: 'codex',
      goal: '/goal Read and execute /workspace/wiki/ace-ops/live-tracks/ace-better-worktree-branch-titles-2026-06-19.md. Fix future task/run display titles, branch names, worktree dirs, and safe stream labels to use concise human titles, not raw prompt boilerplate. Done when: A1 passes.',
      expected: 'Fix future task run display titles branch names worktree dirs',
    },
    {
      label: null,
      agent: 'claude',
      goal: '/goal Fix Hermes Teams mobile nav bug. DONE/BLOCKED trailer required.',
      expected: 'Fix Hermes Teams mobile nav bug',
    },
    {
      label: null,
      agent: 'claude',
      goal: 'ultracode xhigh dynamic workflows: implement Ace title slugs for generated runs',
      expected: 'Implement Ace title slugs for generated runs',
    },
    {
      label: null,
      agent: 'codex',
      goal: '/workspace/wiki/ace-ops/live-tracks/some-brief-2026-06-19.md\nImplement scoped PR handoff labels without branch churn',
      expected: 'Implement scoped PR handoff labels without branch churn',
    },
    {
      label: 'codex',
      agent: 'codex',
      goal: '/goal Fix Hermes Teams mobile stream labels',
      expected: 'Fix Hermes Teams mobile stream labels',
    },
  ];
  for (const c of cases) {
    assert.equal(deriveTaskTitle(c), c.expected, c.goal);
  }
});

test('deriveTaskTitle: explicit labels still win', () => {
  assert.equal(
    deriveTaskTitle({
      label: 'branch-policy-feat',
      agent: 'codex',
      goal: '/goal Read and execute /tmp/noisy.md. This should not win.',
    }),
    'branch-policy-feat'
  );
});

test('deriveStreamLabelForTask: generic agent labels fall back to task title', () => {
  assert.equal(
    deriveStreamLabelForTask({
      taskName: 'codex',
      agent: 'codex',
      goal: '/goal Fix Hermes Teams mobile stream labels',
    }),
    'Fix Hermes Teams mobile stream labels'
  );
  assert.equal(
    deriveStreamLabelForTask({ taskName: 'Fix Hermes Teams mobile stream labels', agent: 'codex' }),
    'Fix Hermes Teams mobile stream labels'
  );
});

test('createDelegatedTaskWithDeps: generic labels do not become task names', async () => {
  const createTaskCalls: any[] = [];
  const delegated = await createDelegatedTaskWithDeps({
    workspaceId: 'prj-1',
    agent: 'codex',
    label: 'codex',
    goal: '/goal Read and execute /workspace/wiki/ace-ops/live-tracks/ace-better-worktree-branch-titles-2026-06-19.md. Fix future task/run display titles, branch names, worktree dirs, and safe stream labels to use concise human titles, not raw prompt boilerplate. Done when: A1 passes.',
    refreshBase: 'false',
    refreshProjectDefaultBranchImpl: async () => {},
    getEffectiveBaseBranchImpl: () => ({ effectiveBaseBranch: 'origin/main' }),
    createTaskImpl: async ({ input }: any) => {
      createTaskCalls.push(input);
      return { id: 'tsk-1' };
    },
    getTaskArtifactsImpl: async () => ({ worktree: null, variant: null }),
    now: () => new Date('2026-06-19T12:00:00.000Z'),
  });
  assert.equal(createTaskCalls[0].name, 'Fix future task run display titles branch names worktree dirs');
  assert.equal(delegated.name, 'Fix future task run display titles branch names worktree dirs');
});
