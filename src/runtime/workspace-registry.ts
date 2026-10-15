import { useCallback } from 'react';
import { aceApi } from '../lib/ace-api';
import type {
  AttachVariantInput,
  CreateWorkspaceTaskInput,
  CreateWorkspaceThreadInput,
  CreateWorktreeInput,
} from '../lib/local-core';
import type { Task, Workspace } from '../lib/types';
import { deepEqual } from './create-snapshot-store';
import { runWithCoreStateRefresh, useCoreSelectorEq, type CoreState } from './core-registry';
import { getVariantStreamId, pasteAndSubmit } from './terminal-io';

function findWorkspace(workspaces: Workspace[], workspaceId: string | null) {
  if (!workspaceId) return null;
  return workspaces.find((w) => w.id === workspaceId) ?? null;
}

function findTask(workspace: Workspace | null, taskId: string | null): Task | null {
  if (!workspace || !taskId) return null;
  return (
    [...workspace.tasks, ...workspace.archivedTasks].find((t) => t.id === taskId) ?? null
  );
}

// These selectors return fresh arrays/objects on every state push (the snapshot
// is re-parsed from IPC each time), so they bail out on value equality: a
// consumer re-renders only when its workspace/task/catalog actually changed.
// The selectors are kept referentially stable (module scope / useCallback) so
// the memoized reference also survives unrelated re-renders.
const selectWorkspaceCatalog = (s: CoreState) => s.workspaces.filter((w) => !w.isPersonal);

export function useWorkspaceCatalog() {
  return useCoreSelectorEq(selectWorkspaceCatalog, deepEqual);
}

export function useWorkspaceRecord(workspaceId: string | null) {
  const select = useCallback(
    (s: CoreState) => findWorkspace(s.workspaces, workspaceId),
    [workspaceId]
  );
  return useCoreSelectorEq(select, deepEqual);
}

export function useTaskRecord(workspaceId: string | null, taskId: string | null) {
  const select = useCallback(
    (s: CoreState) => findTask(findWorkspace(s.workspaces, workspaceId), taskId),
    [workspaceId, taskId]
  );
  return useCoreSelectorEq(select, deepEqual);
}

export async function pickWorkspaceDirectory(input: {
  title: string;
  message?: string;
  buttonLabel?: string;
  defaultPath?: string;
  createDirectory?: boolean;
}) {
  return aceApi.workspaces.pickDirectory(input);
}

export async function importWorkspacePath(workspacePath: string) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.workspaces.importWorkspace(workspacePath)
  );
  return { id: result.id };
}

export async function openWorkspaceFromDialog() {
  const selected = await pickWorkspaceDirectory({
    title: 'Open Workspace',
    message: 'Select a workspace folder to add to Ace.',
    createDirectory: true,
  });
  if (!selected.path) return null;
  return importWorkspacePath(selected.path);
}

export async function createWorkspaceFromDialog(options?: { initializeRepo?: boolean }) {
  const selected = await pickWorkspaceDirectory({
    title: options?.initializeRepo ? 'New Repository' : 'New Workspace',
    message: options?.initializeRepo
      ? 'Select or create a folder for the new repository.'
      : 'Select or create a workspace folder to add to Ace.',
    createDirectory: true,
  });
  if (!selected.path) return null;
  const created = await importWorkspacePath(selected.path);
  if (options?.initializeRepo) await initializeWorkspaceRepository(created.id);
  return created;
}

export async function cloneWorkspaceRepository(repoUrl: string, localPath: string) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.workspaces.cloneWorkspace(repoUrl, localPath)
  );
  return { id: result.id };
}

export async function removeWorkspaceRecord(workspaceId: string) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.removeWorkspace(workspaceId));
}

export async function initializeWorkspaceRepository(workspaceId: string) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.initializeWorkspace(workspaceId));
}

export async function refreshWorkspaceRecord(workspaceId: string) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.refreshWorkspace(workspaceId));
}

export async function createWorkspaceTask(workspaceId: string, input: CreateWorkspaceTaskInput) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.workspaces.createTask(workspaceId, input)
  );
  return { id: result.id };
}

export async function createWorkspaceThread(
  workspaceId: string,
  input: CreateWorkspaceThreadInput
) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.workspaces.createThread(workspaceId, input)
  );
  return { id: result.id };
}

export async function deleteWorkspaceTask(
  taskId: string,
  options?: {
    deleteLocalBranch?: boolean;
    deleteRemoteBranch?: boolean;
    removeWorktree?: boolean;
  }
) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.deleteTask(taskId, options));
}

export async function archiveWorkspaceTask(taskId: string) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.archiveTask(taskId));
}

export async function unarchiveWorkspaceTask(taskId: string) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.unarchiveTask(taskId));
}

export async function reorderWorkspaceList(workspaceIds: string[]) {
  await runWithCoreStateRefresh(() => aceApi.workspaces.reorderWorkspaces(workspaceIds));
}

export async function reorderTasksInWorkspaceList(workspaceId: string, taskIds: string[]) {
  await runWithCoreStateRefresh(() =>
    aceApi.workspaces.reorderTasksInWorkspace(workspaceId, taskIds)
  );
}

export async function createTaskWorktree(workItemId: string, input: CreateWorktreeInput) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.runtime.createWorktree(workItemId, input)
  );
  return { worktreeId: result.worktreeId, variantId: result.variantId };
}

export async function deleteTaskWorktree(
  worktreeId: string,
  options?: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean }
) {
  await runWithCoreStateRefresh(() => aceApi.runtime.deleteWorktree(worktreeId, options));
}

export async function attachTaskVariant(workItemId: string, input: AttachVariantInput) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.runtime.attachVariant(workItemId, input)
  );
  return { variantId: result.variantId };
}

export async function removeTaskVariant(variantId: string) {
  await runWithCoreStateRefresh(() => aceApi.runtime.removeVariant(variantId));
}

export async function broadcastTaskCommand(
  _workItemId: string,
  variantIds: string[],
  message: string
) {
  for (const variantId of variantIds) {
    pasteAndSubmit(getVariantStreamId(variantId), message);
  }
}
