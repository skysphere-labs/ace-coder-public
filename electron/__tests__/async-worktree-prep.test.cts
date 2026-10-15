import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Behavioural coverage of the async-worktree-prep flow can't run under vitest
// here (createAceStore needs the electron-ABI better-sqlite3 build, which won't
// load in plain node), so these lock the load-bearing wiring instead — the
// pattern used by session-active-conversation.test.ts. The invariant that most
// needs guarding is that DELEGATED creates stay synchronous: the orchestrator
// reads the worktree the instant createTask returns, so quietly making that
// path async would strand every delegated worker.
const root = resolve(process.cwd());
const localCore = readFileSync(resolve(root, 'electron/local-core.cts'), 'utf8');
const workspaceCanvas = readFileSync(resolve(root, 'src/components/WorkspaceCanvas.tsx'), 'utf8');
const preparingScreen = readFileSync(resolve(root, 'src/components/TaskPreparingScreen.tsx'), 'utf8');
const types = readFileSync(resolve(root, 'src/lib/types.ts'), 'utf8');

test('interactive createTask returns without awaiting the checkout', () => {
  const body = localCore.slice(localCore.indexOf('async function createTask('));
  // The non-delegated branch kicks off the background prep and returns the id
  // immediately — it must NOT await createWorktreeForTask.
  expect(body).toMatch(/if \(wantWorktree && input\.delegated !== true\) \{[\s\S]*?beginTaskWorktreePrep\(\{[\s\S]*?\}\);\s*return \{ id \};/);
});

test('delegated createTask keeps the checkout synchronous with rollback', () => {
  const body = localCore.slice(
    localCore.indexOf('async function createTask('),
    localCore.indexOf('async function createThread(')
  );
  // The delegated branch still awaits the checkout and rolls the task row back
  // on failure so a broken delegation never strands an orphan.
  expect(body).toContain('await createWorktreeForTask({');
  expect(body).toContain("db.prepare('DELETE FROM worktrees WHERE task_id=?').run(id)");
  expect(body).toContain('stmts.deleteTask.run(id)');
});

test('background prep flips preparing -> ready(clear)/error and never rolls back the task row', () => {
  const body = localCore.slice(
    localCore.indexOf('function beginTaskWorktreePrep('),
    localCore.indexOf('async function createTask(')
  );
  expect(body).toContain("taskPrep.set(taskRow.id, { state: 'preparing' })");
  // success path clears the marker and attaches the git watcher
  expect(body).toContain('taskPrep.delete(taskRow.id)');
  expect(body).toContain('gitWatcher.attachTask(taskRow.id)');
  // failure path parks an 'error' with the message — and crucially does NOT
  // delete the task row (that would be a silently vanished create).
  expect(body).toMatch(/state: 'error'/);
  expect(body).not.toContain('stmts.deleteTask.run');
});

test('retrying a failed create (0 worktrees) re-drives the async prep', () => {
  const body = localCore.slice(localCore.indexOf('async function createWorktree('));
  expect(body).toMatch(/existingCount === 0[\s\S]*?beginTaskWorktreePrep\(/);
});

test('state serialization stamps status/prepError from the prep marker', () => {
  expect(localCore).toContain('function projectWorkspaces(db, getTaskTotals, metaCache, prepFor)');
  expect(localCore).toContain("prep?.state === 'preparing' ? 'preparing' : prep?.state === 'error' ? 'error' : 'idle'");
  // getState feeds the live prep map in.
  expect(localCore).toContain('(taskId) => taskPrep.get(taskId) ?? null');
});

test("renderer gates the task view on readiness and exposes 'preparing'", () => {
  expect(types).toContain("'idle' | 'busy' | 'done' | 'error' | 'preparing'");
  expect(workspaceCanvas).toMatch(/activeTask\.status === 'preparing' \|\| activeTask\.status === 'error'/);
  expect(workspaceCanvas).toContain('<TaskPreparingScreen');
});

test('preparing screen offers retry and delete recovery', () => {
  expect(preparingScreen).toContain('createTaskWorktree(');
  expect(preparingScreen).toContain('deleteWorkspaceTask(');
  expect(preparingScreen).toContain("task.status === 'error'");
});
