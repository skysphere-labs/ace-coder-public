import { useSyncExternalStore } from 'react';

export type TerminalMode = 'bottom' | 'right' | 'tab';

type State = {
  open: boolean;
  mode: TerminalMode;
  hasOpenedOnce: boolean;
  tabActive: boolean;
};

// Per-task terminal state. The terminal used to live in a single global slot,
// which meant opening it on task A leaked the "open" flag across to task B
// when switching. Now each task (or thread) has its own state bag, persisted
// under its own storage key so open/mode survive restarts.

const DEFAULT: State = {
  open: false,
  mode: 'bottom',
  hasOpenedOnce: false,
  tabActive: false,
};

const STORAGE_PREFIX = 'ace:terminal-mode:';

const states = new Map<string, State>();
const listeners = new Map<string, Set<() => void>>();

function storageKey(id: string) {
  return `${STORAGE_PREFIX}${id}`;
}

function loadFor(id: string): State {
  if (typeof localStorage === 'undefined') return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<State>;
    const mode: TerminalMode =
      parsed.mode === 'right' || parsed.mode === 'tab' ? parsed.mode : 'bottom';
    return {
      open: parsed.open === true,
      mode,
      hasOpenedOnce: parsed.hasOpenedOnce === true,
      // tabActive represents the pane-layout tab focus — that's transient
      // runtime state, not something we want to rehydrate across launches.
      tabActive: false,
    };
  } catch {
    return { ...DEFAULT };
  }
}

function persist(id: string, state: State) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      storageKey(id),
      JSON.stringify({
        open: state.open,
        mode: state.mode,
        hasOpenedOnce: state.hasOpenedOnce,
      })
    );
  } catch {}
}

function ensure(id: string): State {
  const existing = states.get(id);
  if (existing) return existing;
  const loaded = loadFor(id);
  states.set(id, loaded);
  return loaded;
}

function notify(id: string) {
  const set = listeners.get(id);
  if (!set) return;
  for (const fn of set) fn();
}

function subscribe(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(id);
  };
}

function apply(id: string, patch: Partial<State>) {
  const current = ensure(id);
  const next: State = { ...current, ...patch };
  if (
    next.open === current.open &&
    next.mode === current.mode &&
    next.hasOpenedOnce === current.hasOpenedOnce &&
    next.tabActive === current.tabActive
  ) {
    return;
  }
  states.set(id, next);
  persist(id, next);
  notify(id);
}

// Snap-pulse is a one-shot animation the mode-switcher plays on the very
// first time the user opens the terminal for a task. Tracked per-task so a
// fresh task still gets the hint even if other tasks have used it before.
const pulseConsumed = new Set<string>();

export function consumeSnapPulse(taskId: string | null): boolean {
  if (!taskId) return false;
  if (pulseConsumed.has(taskId)) return false;
  const state = ensure(taskId);
  if (state.hasOpenedOnce) {
    pulseConsumed.add(taskId);
    return false;
  }
  pulseConsumed.add(taskId);
  return true;
}

export function getTerminalState(taskId: string | null): State {
  if (!taskId) return DEFAULT;
  return ensure(taskId);
}

function openTerminal(taskId: string) {
  const state = ensure(taskId);
  if (state.open) return;
  apply(taskId, {
    open: true,
    hasOpenedOnce: true,
    tabActive: state.mode === 'tab',
  });
}

export function closeTerminal(taskId: string | null) {
  if (!taskId) return;
  const state = ensure(taskId);
  if (!state.open) return;
  apply(taskId, { open: false, tabActive: false });
}

export function toggleTerminal(taskId: string | null) {
  if (!taskId) return;
  const state = ensure(taskId);
  if (state.open) closeTerminal(taskId);
  else openTerminal(taskId);
}

export function setTerminalMode(taskId: string | null, mode: TerminalMode) {
  if (!taskId) return;
  const state = ensure(taskId);
  if (state.mode === mode) return;
  apply(taskId, { mode, tabActive: state.open && mode === 'tab' });
}

export function deactivateTerminalTab(taskId: string | null) {
  if (!taskId) return;
  const state = ensure(taskId);
  if (!state.tabActive) return;
  apply(taskId, { tabActive: false });
}

export function useTerminalState(taskId: string | null): State {
  return useSyncExternalStore(
    (fn) => (taskId ? subscribe(taskId, fn) : () => {}),
    () => (taskId ? ensure(taskId) : DEFAULT),
    () => DEFAULT
  );
}
