import { test, expect } from 'vitest';

const {
  buildOrchestratorPrompt,
  displayNameFor,
  ORCHESTRATOR_SKILL_ID,
  OPERATOR_POLICY_SKILL_ID,
  FORBIDDEN_VERBS_SUMMARY,
} = require('../orchestrator-prompt.cts');

const BASE_INPUT = {
  agent: 'hermes',
  workspaceId: 'ws_123',
  workspaceName: 'alpha',
  workspacePath: '/Users/me/Projects/alpha',
  githubRepo: 'owner/alpha',
  defaultBranch: 'main',
  isRemote: false,
};

test('hermes variant includes intake role line, workspace identity, skill pointer, forbidden-verb summary, and first action', () => {
  const text = buildOrchestratorPrompt(BASE_INPUT);
  expect(text).toContain('You are the Hermes intake-router for workspace "alpha"');
  expect(text).toContain('Role: viewer');
  expect(text).toContain('spawn a fresh Claude workspace orchestrator for medium/large goals');
  expect(text).toContain('workspace_id: ws_123');
  expect(text).toContain('workspace_path: /Users/me/Projects/alpha');
  expect(text).toContain('default_branch: main');
  expect(text).toContain('github_repo: owner/alpha (origin: https://github.com/owner/alpha)');
  expect(text).toContain(`bundled skills \`${ORCHESTRATOR_SKILL_ID}\` + \`${OPERATOR_POLICY_SKILL_ID}\``);
  expect(text).toContain('after compaction/restart');
  expect(text).toContain('assertViewerRole');
  expect(text).toContain(FORBIDDEN_VERBS_SUMMARY);
  expect(text).toContain('Hard scope: workspace_id=ws_123');
  expect(text).toContain('never push to main');
  expect(text).toContain('Fresh session only:');
  expect(text).toContain('`ace tool heartbeat`');
  expect(text).toContain('`ace tool manifest --compact`');
  expect(text).toContain('`ace context`');
  expect(text).toContain('`ace run board`');
  expect(text).toContain('`ace ls`');
  expect(text).toContain('`ace tool audit`');
  expect(text).toContain('After context compression, resume the preserved active task');
  expect(text).not.toContain('/tmp/ace-start-batch.json');
  expect(text).toContain('Do not dispatch before run-board / tool-audit proof exists');
});

test('claude variant names Claude explicitly', () => {
  const text = buildOrchestratorPrompt({ ...BASE_INPUT, agent: 'claude' });
  expect(displayNameFor('claude')).toBe('Claude');
  expect(text).toContain('You are the Claude validator-orchestrator');
  expect(text).not.toContain('You are the Hermes intake-router');
  expect(text).not.toContain('You are the Codex validator-orchestrator');
});

test('codex variant names Codex explicitly', () => {
  const text = buildOrchestratorPrompt({ ...BASE_INPUT, agent: 'codex' });
  expect(displayNameFor('codex')).toBe('Codex');
  expect(text).toContain('You are the Codex validator-orchestrator');
  expect(text).not.toContain('You are the Hermes intake-router');
  expect(text).not.toContain('You are the Claude validator-orchestrator');
});

test('non-Claude/Codex provider names come from provider catalog', () => {
  const text = buildOrchestratorPrompt({ ...BASE_INPUT, agent: 'gemini' });
  expect(displayNameFor('gemini')).toBe('Gemini');
  expect(displayNameFor('qwen')).toBe('Qwen');
  expect(displayNameFor('opencode')).toBe('OpenCode');
  expect(displayNameFor('made-up-agent')).toBe('Made Up Agent');
  expect(text).toContain('You are the Gemini validator-orchestrator');
  expect(text).not.toContain('You are the Hermes intake-router');
});

test('missing defaultBranch, workspacePath, and githubRepo fall back to instructive placeholders', () => {
  const text = buildOrchestratorPrompt({
    agent: 'hermes',
    workspaceId: 'ws_x',
    workspaceName: 'bare',
    workspacePath: null,
    githubRepo: null,
    defaultBranch: null,
    isRemote: false,
  });
  expect(text).toContain('workspace_path: (unset — refuse destructive git ops until confirmed)');
  expect(text).toContain('default_branch: (unknown — resolve via `git symbolic-ref refs/remotes/origin/HEAD`)');
  expect(text).toContain('github_repo: (none detected — ask the user before pushing)');
  expect(text).toContain('never push to the default branch');
});

test('remote workspace annotates the path with (remote)', () => {
  const text = buildOrchestratorPrompt({ ...BASE_INPUT, isRemote: true });
  expect(text).toContain('workspace_path: /Users/me/Projects/alpha  (remote)');
});

test('no wall-of-doctrine sections leak into the live prompt (they live in the skill)', () => {
  const text = buildOrchestratorPrompt(BASE_INPUT);
  // The skill owns these — they must not be repeated inline.
  expect(text).not.toContain('ALLOWED surface');
  expect(text).not.toContain('Baseline skills bundle');
  expect(text).not.toContain('Bundle rule');
  expect(text).not.toContain('Branch naming:');
  expect(text).not.toContain('Research lives in context');
  expect(text).not.toContain('Delegation contract: every code-work spec');
});

test('default agent when unspecified is claude', () => {
  const text = buildOrchestratorPrompt({
    workspaceId: 'ws_x',
    workspaceName: 'bare',
  });
  expect(text).toContain('You are the Claude validator-orchestrator');
});

test('prompt advertises the loop-ship ship-to-main capability with the workspace id and exit codes', () => {
  const text = buildOrchestratorPrompt(BASE_INPUT);
  expect(text).toContain('ace loop run loop-ship');
  expect(text).toContain('--input workspace=ws_123');
  expect(text).toContain('exit code');
  expect(text).toContain('auto-merges ONLY when every gate is green');
  // fail-closed reminder is present so an agent knows it parks without a token.
  expect(text).toContain('parks at ready_to_review when no auto-ship token');
});
