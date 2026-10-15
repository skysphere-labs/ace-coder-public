import { useSyncExternalStore } from 'react';
import type { AgentId } from '../lib/types';

// Minimal cross-component bridge so the mobile shell's fixed composer bar
// can target whatever terminal the task pane currently has focused — either
// a task variant (ParallelTaskScreen) or a thread conversation
// (SessionScreen) — without threading props through WorkspaceCanvas.

export type FocusedChat = {
  scopeId: string;
  agent: AgentId;
  streamId: string;
};

const byTask = new Map<string, FocusedChat>();
const listeners = new Map<string, Set<() => void>>();

function notify(taskId: string) {
  const set = listeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

export function setFocusedVariant(taskId: string, info: FocusedChat | null) {
  if (!taskId) return;
  const current = byTask.get(taskId);
  if (!info) {
    if (!current) return;
    byTask.delete(taskId);
  } else if (
    current &&
    current.scopeId === info.scopeId &&
    current.agent === info.agent &&
    current.streamId === info.streamId
  ) {
    return;
  } else {
    byTask.set(taskId, info);
  }
  notify(taskId);
}

export function useFocusedVariant(taskId: string | null): FocusedChat | null {
  const subscribe = (fn: () => void) => {
    if (!taskId) return () => {};
    let set = listeners.get(taskId);
    if (!set) {
      set = new Set();
      listeners.set(taskId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  };
  const getSnapshot = () => (taskId ? byTask.get(taskId) ?? null : null);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
