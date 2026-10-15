import { useSyncExternalStore } from 'react';
import type { AgentId } from '../lib/types';

const agents = new Map<string, AgentId>();
const listeners = new Map<string, Set<() => void>>();

function notify(taskId: string) {
  const set = listeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

export function setActiveDisplayAgent(taskId: string, agent: AgentId | null) {
  if (!taskId) return;
  const current = agents.get(taskId);
  if (agent === null) {
    if (!current) return;
    agents.delete(taskId);
  } else {
    if (current === agent) return;
    agents.set(taskId, agent);
  }
  notify(taskId);
}

export function useActiveDisplayAgent(taskId: string | null): AgentId | null {
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
  const getSnapshot = () => (taskId ? agents.get(taskId) ?? null : null);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
