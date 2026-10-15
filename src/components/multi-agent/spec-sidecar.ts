import { useEffect, useSyncExternalStore } from 'react';
import { aceApi } from '../../lib/ace-api';
import type { TaskSpecResult } from '../../lib/task-spec';

// State for task spec data used by the pinned TaskSpecPane and optional
// read-only markdown tabs. The cache keeps the worker screen, manual Spec
// tab, and prompt-markdown artifact tabs on one IPC result per task.

const specPromises = new Map<string, Promise<TaskSpecResult>>();
const specResults = new Map<string, TaskSpecResult>();
const specListeners = new Map<string, Set<() => void>>();

function notifySpec(taskId: string) {
  const set = specListeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

export function fetchTaskSpec(taskId: string, opts: { force?: boolean } = {}): Promise<TaskSpecResult> {
  const existing = specPromises.get(taskId);
  if (existing && !opts.force) return existing;
  const promise = aceApi.workspaces.getTaskSpec(taskId).then((res) => {
    specResults.set(taskId, res);
    notifySpec(taskId);
    return res;
  });
  specPromises.set(taskId, promise);
  promise.catch(() => {
    // Let the next caller retry instead of caching the failure forever.
    if (specPromises.get(taskId) === promise) specPromises.delete(taskId);
  });
  return promise;
}

// Resolved spec for the task, or null while loading / on failure. Kicks off
// the (cached) fetch on first use.
export function useTaskSpec(taskId: string | null): TaskSpecResult | null {
  const spec = useSyncExternalStore(
    (listener) => {
      if (!taskId) return () => {};
      let set = specListeners.get(taskId);
      if (!set) {
        set = new Set();
        specListeners.set(taskId, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    () => (taskId ? specResults.get(taskId) ?? null : null),
    () => null
  );
  useEffect(() => {
    if (taskId) fetchTaskSpec(taskId).catch(() => undefined);
  }, [taskId]);
  return spec;
}

export function getPromptMarkdownSources(spec: TaskSpecResult | null) {
  return spec?.promptMarkdownSources ?? [];
}

export function getPromptMarkdownSource(spec: TaskSpecResult | null, path: string) {
  return getPromptMarkdownSources(spec).find((source) => source.path === path) ?? null;
}

// A task has fallback sidecar content when there is anything spec-shaped to
// show: the resolved GoalAgentSpec markdown, or the framed prompt itself.
export function hasSpecSidecarContent(spec: TaskSpecResult | null): boolean {
  return !!(spec && (spec.goalSpecMarkdown || spec.initialPrompt));
}
