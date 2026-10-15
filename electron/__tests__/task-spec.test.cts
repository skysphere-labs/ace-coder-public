import { test } from 'vitest';
const assert = require('node:assert/strict');

const {
  parseInitialPrompt,
  createGetTaskSpec,
  extractPromptMarkdownPaths,
} = require('../task-spec.cjs');

const FRAMED = [
  '# Skills to load',
  '- ace-cli',
  '- karpathy-think-before-coding',
  '- karpathy-simplicity-first',
  '- karpathy-surgical-changes',
  '- karpathy-goal-driven-execution',
  '',
  'Open each skill before acting.',
  '',
  '# Role manifest',
  'role: implementer (Implementer)',
  'skillPack: feature-impl',
  'capabilities: code-change, verify, implementation',
  'taskPackSkills: karpathy-surgical-changes, karpathy-simplicity-first',
  '',
  '# Goal',
  'Worker-tab task-spec visibility pane.',
  '',
  '# Constraints',
  '- STEP 0: git fetch origin',
  '- Keep scope tight',
  '',
  '# Acceptance criteria (orchestrator will check these)',
  '- Spec pane shows goal + skills + acceptance',
  '- Reuses tasks.initial_prompt',
  '',
  '# Escape hatch',
  'If blocked, return BLOCKED:',
  '',
].join('\n');

test('parseInitialPrompt: expanded spec includes goal, skills, acceptance', () => {
  const spec = parseInitialPrompt(FRAMED);
  assert.equal(spec.hasContent, true);
  assert.match(spec.goal, /Worker-tab task-spec visibility/);
  assert.deepEqual(spec.skills, [
    'ace-cli',
    'karpathy-think-before-coding',
    'karpathy-simplicity-first',
    'karpathy-surgical-changes',
    'karpathy-goal-driven-execution',
  ]);
  assert.equal(spec.roleMode, 'implementer');
  assert.equal(spec.skillPack, 'feature-impl');
  assert.deepEqual(spec.capabilities, ['code-change', 'verify', 'implementation']);
  assert.deepEqual(spec.taskPackSkills, ['karpathy-surgical-changes', 'karpathy-simplicity-first']);
  assert.deepEqual(spec.constraints, ['STEP 0: git fetch origin', 'Keep scope tight']);
  assert.deepEqual(spec.acceptance, [
    'Spec pane shows goal + skills + acceptance',
    'Reuses tasks.initial_prompt',
  ]);
});

test('parseInitialPrompt: empty input reports No spec recorded fallback', () => {
  const empty = parseInitialPrompt(null);
  assert.equal(empty.hasContent, false);
  assert.equal(empty.goal, null);
  assert.deepEqual(empty.skills, []);
  assert.deepEqual(empty.acceptance, []);

  const blank = parseInitialPrompt('   \n\n   ');
  assert.equal(blank.hasContent, false);
});

test('parseInitialPrompt: codex-framed prompt (skills inlined at bottom) parses Goal/Constraints/Deliverables/Acceptance', () => {
  // Mirrors what buildTaskPrompt(spec, { driver: 'codex' }) emits: no top
  // "Skills to load" section, but a bottom "# Skills" block with `## <id>`
  // inlined bodies. The pane should still surface the standard sections;
  // skills array stays empty (codex skills are body-text, not chips).
  const CODEX = [
    '# Goal',
    'Make codex tabs surface the spec.',
    '',
    '# Constraints',
    '- driver-agnostic',
    '- no special-casing in the pane',
    '',
    '# Deliverables',
    '- electron/__tests__/task-spec.test.cts: codex-shape coverage',
    '',
    '# Acceptance',
    '- npm run lint passes',
    '- npm run build passes',
    '',
    '# Escape hatch',
    'End with exactly one of: `DONE: <one-line>` or `BLOCKED: <one-line>`.',
    '',
    '# Skills',
    '## ace-cli',
    '',
    'Drive Ace agent tabs.',
    '',
    '## karpathy-think-before-coding',
    '',
    'Surface assumptions before coding.',
    '',
  ].join('\n');
  const spec = parseInitialPrompt(CODEX);
  assert.equal(spec.hasContent, true);
  assert.match(spec.goal, /Make codex tabs surface the spec/);
  assert.deepEqual(spec.constraints, ['driver-agnostic', 'no special-casing in the pane']);
  assert.deepEqual(spec.deliverables, [
    'electron/__tests__/task-spec.test.cts: codex-shape coverage',
  ]);
  assert.deepEqual(spec.acceptance, ['npm run lint passes', 'npm run build passes']);
  // Codex skills are inlined as `## <id>` headings inside the `# Skills`
  // section body — not bullets — so the chip list is empty by design.
  assert.deepEqual(spec.skills, []);
});

test('parseInitialPrompt: free-form prompt without headings becomes the goal', () => {
  const spec = parseInitialPrompt('Just fix the thing.');
  assert.equal(spec.hasContent, true);
  assert.equal(spec.goal, 'Just fix the thing.');
  assert.deepEqual(spec.acceptance, []);
});

test('extractPromptMarkdownPaths: preserves prompt order for unquoted and quoted paths', () => {
  const prompt = [
    '/goal Read /Users/ace/wiki/brief-one.md.',
    'Then inspect "/Users/ace/wiki/brief with spaces.md" and `/Users/ace/wiki/brief-three.md`.',
    "Finally read '/Users/ace/wiki/brief-four.md'.",
  ].join('\n');

  assert.deepEqual(extractPromptMarkdownPaths(prompt), [
    '/Users/ace/wiki/brief-one.md',
    '/Users/ace/wiki/brief with spaces.md',
    '/Users/ace/wiki/brief-three.md',
    '/Users/ace/wiki/brief-four.md',
  ]);
});

test('extractPromptMarkdownPaths: dedupes paths and caps prompt artifacts at eight', () => {
  const paths = Array.from({ length: 10 }, (_, i) => `/tmp/prompt-artifact-${i + 1}.md`);
  const prompt = [
    `Read ${paths[0]} twice: ${paths[0]}.`,
    ...paths.slice(1).map((p) => `Read ${p}.`),
  ].join('\n');

  assert.deepEqual(extractPromptMarkdownPaths(prompt), paths.slice(0, 8));
});

test('createGetTaskSpec: returns initial_prompt + branch + baseBranch + prUrl shape', () => {
  const stmts = {
    getTaskById: {
      get: (id) => {
        if (id !== 'tsk_1') return null;
        return {
          id: 'tsk_1',
          project_id: 'prj_1',
          name: 'worker-tab',
          primary_agent: 'claude',
          initial_prompt: FRAMED,
          archived_at: null,
        };
      },
    },
    getProjectById: {
      get: (id) => (id === 'prj_1' ? { id: 'prj_1', default_branch: 'main' } : null),
    },
  };
  const worktree = {
    task_id: 'tsk_1',
    branch: 'worker-tab-update',
    base_branch: 'main',
    path: '/tmp/wt',
  };
  const db = {
    prepare: (sql) => ({
      get: (...args) => {
        assert.match(sql, /FROM worktrees WHERE task_id=\?/);
        return args[0] === 'tsk_1' ? worktree : null;
      },
    }),
  };
  const metaCache = new Map([
    [
      'prj_1',
      {
        openPrs: [
          {
            number: 42,
            headRef: 'worker-tab-update',
            url: 'https://github.com/x/y/pull/42',
          },
        ],
      },
    ],
  ]);
  const getTaskSpec = createGetTaskSpec({ stmts, db, workspaceMetaCache: metaCache });
  const out = getTaskSpec({ taskId: 'tsk_1' });
  assert.equal(out.taskId, 'tsk_1');
  assert.equal(out.initialPrompt, FRAMED);
  assert.equal(out.branch, 'worker-tab-update');
  assert.equal(out.baseBranch, 'main');
  assert.equal(out.worktreePath, '/tmp/wt');
  assert.equal(out.archivedAt, null);
  assert.equal(out.prNumber, 42);
  assert.equal(out.prUrl, 'https://github.com/x/y/pull/42');
});

test('createGetTaskSpec: graceful when no worktree + no cached PR', () => {
  const stmts = {
    getTaskById: {
      get: () => ({
        id: 'tsk_2',
        project_id: 'prj_2',
        name: 'preexisting',
        primary_agent: 'claude',
        initial_prompt: null,
        archived_at: '2026-04-20T00:00:00Z',
      }),
    },
    getProjectById: {
      get: () => ({ id: 'prj_2', default_branch: 'main' }),
    },
  };
  const db = { prepare: () => ({ get: () => null }) };
  const getTaskSpec = createGetTaskSpec({ stmts, db, workspaceMetaCache: new Map() });
  const out = getTaskSpec({ taskId: 'tsk_2' });
  assert.equal(out.initialPrompt, null);
  assert.equal(out.branch, null);
  assert.equal(out.baseBranch, 'main');
  assert.equal(out.prUrl, null);
  assert.equal(out.archivedAt, '2026-04-20T00:00:00Z');
});

test('createGetTaskSpec: throws without taskId and on missing task', () => {
  const stmts = { getTaskById: { get: () => null }, getProjectById: { get: () => null } };
  const db = { prepare: () => ({ get: () => null }) };
  const getTaskSpec = createGetTaskSpec({ stmts, db, workspaceMetaCache: new Map() });
  assert.throws(() => getTaskSpec({}), /taskId required/);
  assert.throws(() => getTaskSpec({ taskId: 'missing' }), /task not found/);
});
