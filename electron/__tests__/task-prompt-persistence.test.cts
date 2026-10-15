const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const { createAceStore } = require('../local-core.cjs');

function git(cwd: any, ...args: any[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(filePath: any, contents: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

async function createFixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-prompt-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');

  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  writeFile(path.join(repoPath, 'AGENTS.md'), '# Agents\n');
  writeFile(path.join(repoPath, 'CLAUDE.md'), '# Claude\n');
  git(repoPath, 'add', 'README.md', 'AGENTS.md', 'CLAUDE.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });

  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { store, workspaceId };
}

test('createDelegatedTask with prompt persists initial_prompt', async (t: any) => {
  const { store, workspaceId } = await createFixture(t);

  const created = await store.createDelegatedTask({
    workspaceId,
    agent: 'codex',
    goal: 'Persist delegated prompt',
    label: 'prompt-persistence-bug',
    prompt: '# Goal\nPersist this delegated prompt',
    taskType: 'bug',
  });

  const spec = store.getTaskSpec({ taskId: created.taskId });
  assert.equal(spec.initialPrompt, '# Goal\nPersist this delegated prompt');
});

test('createDelegatedTask with null prompt warns once and still creates task', async (t: any) => {
  const { store, workspaceId } = await createFixture(t);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const created = await store.createDelegatedTask({
    workspaceId,
    agent: 'codex',
    goal: 'Missing delegated prompt',
    label: 'missing-prompt-bug',
    prompt: null,
    taskType: 'bug',
  });

  const promptWarnings = warnings.filter((line) =>
    line.startsWith('[ace] delegation missing initial_prompt:')
  );
  assert.equal(promptWarnings.length, 1);
  assert.match(promptWarnings[0], new RegExp(`taskId=${created.taskId}`));
  assert.match(promptWarnings[0], /agent=codex/);
  assert.match(promptWarnings[0], /kind=task/);
  const spec = store.getTaskSpec({ taskId: created.taskId });
  assert.equal(spec.initialPrompt, null);
});

test('createThread with prompt persists initial_prompt', async (t: any) => {
  const { store, workspaceId } = await createFixture(t);

  const created = await store.createThread({
    workspaceId,
    input: {
      name: 'Prompted thread',
      agent: 'codex',
      prompt: 'thread prompt text',
      autoApproveEnabled: false,
    },
  });

  const spec = store.getTaskSpec({ taskId: created.id });
  assert.equal(spec.initialPrompt, 'thread prompt text');
});

test('non-delegated empty thread does not warn', async (t: any) => {
  const { store, workspaceId } = await createFixture(t);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await store.createThread({
    workspaceId,
    input: {
      name: 'Manual empty thread',
      agent: 'codex',
      prompt: null,
      autoApproveEnabled: true,
    },
  });

  assert.equal(
    warnings.some((line) => line.startsWith('[ace] delegation missing initial_prompt:')),
    false
  );
});

test('createAdhocThread with prompt persists initial_prompt', async (t: any) => {
  const { store, workspaceId } = await createFixture(t);

  const created = await store.createAdhocThread({
    workspaceId,
    agent: 'codex',
    label: 'adhoc-prompt',
    kind: 'cli',
    prompt: 'adhoc framed prompt',
  });

  const spec = store.getTaskSpec({ taskId: created.taskId });
  assert.equal(spec.initialPrompt, 'adhoc framed prompt');
});
