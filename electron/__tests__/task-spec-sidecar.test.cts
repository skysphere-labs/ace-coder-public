import { test, expect } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractGoalSpecPath,
  extractPromptMarkdownPaths,
  readGoalSpecMarkdown,
  readPromptMarkdownSources,
  createGetTaskSpec,
} = require('../task-spec.cts');

// A1/A2 plumbing — the spec sidecar tab renders whatever getTaskSpec
// resolves here, so these shapes mirror the real prompts the orchestrator
// writes (Claude /goal pointer, Codex /goal pointer, framed task-run prompt).

const CLAUDE_GOAL_PROMPT = [
  '/goal',
  'Read and execute:',
  '/data/agent-artifacts/repo/.ace/goals/msn-1/ft-2/GOAL_AGENT_SPEC.md',
  '',
  'Use the Goal Ledger:',
  '/data/agent-artifacts/repo/.agent/runs/msn-1-ft-2/GOAL.md',
  'End with exactly DONE or BLOCKED.',
].join('\n');

const CODEX_GOAL_PROMPT =
  '/goal Complete the GoalAgentSpec at /tmp/goals/msn-9/ft-8/GOAL_AGENT_SPEC.md. Done when all acceptance criteria pass with evidence.';

const FRAMED_PROMPT = [
  '# Goal',
  'Build the widget.',
  '',
  '# Acceptance criteria',
  '- Widget builds',
].join('\n');

test('extractGoalSpecPath: Claude /goal pointer (path on the next line)', () => {
  expect(extractGoalSpecPath(CLAUDE_GOAL_PROMPT)).toBe(
    '/data/agent-artifacts/repo/.ace/goals/msn-1/ft-2/GOAL_AGENT_SPEC.md'
  );
});

test('extractGoalSpecPath: Codex /goal pointer (inline "GoalAgentSpec at")', () => {
  expect(extractGoalSpecPath(CODEX_GOAL_PROMPT)).toBe('/tmp/goals/msn-9/ft-8/GOAL_AGENT_SPEC.md');
});

test('extractGoalSpecPath: bare GOAL_AGENT_SPEC.md token anywhere', () => {
  expect(extractGoalSpecPath('see /data/x/GOAL_AGENT_SPEC.md for details')).toBe(
    '/data/x/GOAL_AGENT_SPEC.md'
  );
});

test('extractGoalSpecPath: framed prompt without a pointer returns null', () => {
  expect(extractGoalSpecPath(FRAMED_PROMPT)).toBeNull();
  expect(extractGoalSpecPath(null)).toBeNull();
  expect(extractGoalSpecPath('')).toBeNull();
});

test('extractPromptMarkdownPaths: all absolute .md paths in prompt order', () => {
  const prompt = [
    '/goal Read /tmp/ace-briefs/widget-fix.md.',
    'Also inspect /tmp/goals/msn-1/GOAL_AGENT_SPEC.md and /tmp/goals/msn-1/GOAL_AGENT_SPEC.md.',
  ].join('\n');

  expect(extractPromptMarkdownPaths(prompt)).toEqual([
    '/tmp/ace-briefs/widget-fix.md',
    '/tmp/goals/msn-1/GOAL_AGENT_SPEC.md',
  ]);
});

test('readGoalSpecMarkdown: reads .md files, rejects non-.md and missing paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sidecar-'));
  const specPath = path.join(dir, 'GOAL_AGENT_SPEC.md');
  fs.writeFileSync(specPath, '# GoalAgentSpec\n\n## Rubric\n- A1: pass');

  expect(readGoalSpecMarkdown(specPath)).toContain('## Rubric');
  expect(readGoalSpecMarkdown(path.join(dir, 'missing.md'))).toBeNull();
  expect(readGoalSpecMarkdown(path.join(dir, 'not-markdown.txt'))).toBeNull();
  expect(readGoalSpecMarkdown(dir)).toBeNull();
});

test('readGoalSpecMarkdown: caps pathological files at 512KB with a marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sidecar-cap-'));
  const bigPath = path.join(dir, 'big.md');
  fs.writeFileSync(bigPath, 'x'.repeat(512 * 1024 + 100));

  const content = readGoalSpecMarkdown(bigPath);
  expect(content).toContain('…(spec truncated at 512KB)');
  expect(String(content).length).toBeLessThan(512 * 1024 + 100);
});

test('readPromptMarkdownSources: returns only readable Markdown files with filenames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-md-sources-'));
  const briefPath = path.join(dir, 'widget-fix.md');
  const specPath = path.join(dir, 'GOAL_AGENT_SPEC.md');
  const missingPath = path.join(dir, 'missing.md');
  fs.writeFileSync(briefPath, '# Widget fix\n\nRead me.');
  fs.writeFileSync(specPath, '# GoalAgentSpec\n\n## Acceptance\n- A1');

  const prompt = [
    `/goal Widget. Read ${briefPath}.`,
    `Then read ${missingPath} and ${specPath}.`,
    `Duplicate ${briefPath} should not create a second tab.`,
  ].join('\n');

  const sources = readPromptMarkdownSources(prompt);
  expect(sources).toHaveLength(2);
  expect(sources[0]).toMatchObject({
    path: briefPath,
    name: 'widget-fix.md',
    markdown: '# Widget fix\n\nRead me.',
  });
  expect(sources[1]).toMatchObject({
    path: specPath,
    name: 'GOAL_AGENT_SPEC.md',
  });
});

test('createGetTaskSpec: resolves goalSpecPath + goalSpecMarkdown from the prompt pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sidecar-ipc-'));
  const specPath = path.join(dir, 'GOAL_AGENT_SPEC.md');
  fs.writeFileSync(specPath, '# GoalAgentSpec — widget\n\n## Acceptance\n- A1: works');

  const prompt = `/goal\nRead and execute:\n${specPath}\n\nEnd with exactly DONE or BLOCKED.`;
  const task = {
    name: 'Widget',
    primary_agent: 'claude',
    initial_prompt: prompt,
    project_id: 'prj-1',
    archived_at: null,
  };
  const getTaskSpec = createGetTaskSpec({
    stmts: {
      getTaskById: { get: () => task },
      getProjectById: { get: () => ({ default_branch: 'main' }) },
    },
    db: { prepare: () => ({ get: () => null }) },
    workspaceMetaCache: null,
  });

  const result = getTaskSpec({ taskId: 'tsk-1' });
  expect(result.initialPrompt).toBe(prompt);
  expect(result.goalSpecPath).toBe(specPath);
  expect(result.goalSpecMarkdown).toContain('# GoalAgentSpec — widget');
  expect(result.promptMarkdownSources).toEqual([
    {
      path: specPath,
      name: 'GOAL_AGENT_SPEC.md',
      markdown: '# GoalAgentSpec — widget\n\n## Acceptance\n- A1: works',
    },
  ]);
});

test('createGetTaskSpec: resolves arbitrary readable prompt Markdown source docs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-md-ipc-'));
  const briefPath = path.join(dir, 'kova-designer-orchestrator-architecture-fixback-2026-06-25.md');
  fs.writeFileSync(briefPath, '# Kova fixback\n\n## Acceptance\n- Source tab opens');

  const prompt = `/goal Prompt-md source tabs. Read ${briefPath}. PR required; do not merge.`;
  const task = {
    name: 'Prompt md',
    primary_agent: 'codex',
    initial_prompt: prompt,
    project_id: 'prj-1',
    archived_at: null,
  };
  const getTaskSpec = createGetTaskSpec({
    stmts: {
      getTaskById: { get: () => task },
      getProjectById: { get: () => ({ default_branch: 'main' }) },
    },
    db: { prepare: () => ({ get: () => null }) },
    workspaceMetaCache: null,
  });

  const result = getTaskSpec({ taskId: 'tsk-brief' });
  expect(result.promptMarkdownSources).toEqual([
    {
      path: briefPath,
      name: 'kova-designer-orchestrator-architecture-fixback-2026-06-25.md',
      markdown: '# Kova fixback\n\n## Acceptance\n- Source tab opens',
    },
  ]);
  expect(result.goalSpecPath).toBeNull();
  expect(result.goalSpecMarkdown).toBeNull();
});

test('createGetTaskSpec: framed prompt without pointer keeps sidecar fields null', () => {
  const task = {
    name: 'Widget',
    primary_agent: 'codex',
    initial_prompt: FRAMED_PROMPT,
    project_id: 'prj-1',
    archived_at: null,
  };
  const getTaskSpec = createGetTaskSpec({
    stmts: {
      getTaskById: { get: () => task },
      getProjectById: { get: () => ({ default_branch: 'main' }) },
    },
    db: { prepare: () => ({ get: () => null }) },
    workspaceMetaCache: null,
  });

  const result = getTaskSpec({ taskId: 'tsk-2' });
  expect(result.goalSpecPath).toBeNull();
  expect(result.goalSpecMarkdown).toBeNull();
  expect(result.promptMarkdownSources).toEqual([]);
  expect(result.initialPrompt).toBe(FRAMED_PROMPT);
});

test('createGetTaskSpec: dangling pointer degrades to path-only (renderer falls back to prompt)', () => {
  const task = {
    name: 'Widget',
    primary_agent: 'claude',
    initial_prompt: '/goal\nRead and execute:\n/gone/away/GOAL_AGENT_SPEC.md',
    project_id: 'prj-1',
    archived_at: null,
  };
  const getTaskSpec = createGetTaskSpec({
    stmts: {
      getTaskById: { get: () => task },
      getProjectById: { get: () => ({ default_branch: 'main' }) },
    },
    db: { prepare: () => ({ get: () => null }) },
    workspaceMetaCache: null,
  });

  const result = getTaskSpec({ taskId: 'tsk-3' });
  expect(result.goalSpecPath).toBe('/gone/away/GOAL_AGENT_SPEC.md');
  expect(result.goalSpecMarkdown).toBeNull();
  expect(result.promptMarkdownSources).toEqual([]);
});
