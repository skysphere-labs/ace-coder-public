import { useSyncExternalStore } from 'react';
import { aceApi } from '../lib/ace-api';
import { openRef as openPaneRef } from './pane-layout-registry';

export type OpenFile = {
  path: string;
};

type TaskEditorState = {
  openFiles: OpenFile[];
  activeFile: string | null;
  dirty: Set<string>;
};

const PERSIST_DEBOUNCE_MS = 400;

const states = new Map<string, TaskEditorState>();
const listeners = new Map<string, Set<() => void>>();
const hydrated = new Set<string>();
const saveTimers = new Map<string, number>();

function getOrCreate(taskId: string): TaskEditorState {
  let state = states.get(taskId);
  if (!state) {
    state = { openFiles: [], activeFile: null, dirty: new Set() };
    states.set(taskId, state);
  }
  return state;
}

function notify(taskId: string) {
  const set = listeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

function schedulePersist(taskId: string) {
  if (!hydrated.has(taskId)) return;
  const existing = saveTimers.get(taskId);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    saveTimers.delete(taskId);
    const state = states.get(taskId);
    if (!state) return;
    void aceApi.sessions
      .saveEditorOpenFiles(
        taskId,
        state.openFiles.map((f) => f.path),
        state.activeFile
      )
      .catch((err) => console.warn('[ace] saveEditorOpenFiles failed', err));
  }, PERSIST_DEBOUNCE_MS);
  saveTimers.set(taskId, timer);
}

function replace(taskId: string, next: TaskEditorState, opts: { persist?: boolean } = {}) {
  states.set(taskId, next);
  notify(taskId);
  if (opts.persist !== false) schedulePersist(taskId);
}

export function openFile(taskId: string, path: string) {
  const state = getOrCreate(taskId);
  if (state.openFiles.some((f) => f.path === path)) {
    if (state.activeFile !== path) {
      replace(taskId, { ...state, activeFile: path });
    }
  } else {
    replace(taskId, {
      ...state,
      openFiles: [...state.openFiles, { path }],
      activeFile: path,
    });
  }
  // Activate the file in the focused pane — adds a new tab if it doesn't
  // already exist somewhere, otherwise surfaces the existing one.
  openPaneRef(taskId, { kind: 'file', path });
}

export function closeFile(taskId: string, path: string) {
  const state = getOrCreate(taskId);
  const nextFiles = state.openFiles.filter((f) => f.path !== path);
  let nextActive = state.activeFile;
  if (state.activeFile === path) {
    const idx = state.openFiles.findIndex((f) => f.path === path);
    const neighbour = nextFiles[idx] ?? nextFiles[idx - 1] ?? null;
    nextActive = neighbour?.path ?? null;
  }
  const nextDirty = new Set(state.dirty);
  nextDirty.delete(path);
  replace(taskId, {
    openFiles: nextFiles,
    activeFile: nextActive,
    dirty: nextDirty,
  });
}

export function setDirty(taskId: string, path: string, dirty: boolean) {
  const state = getOrCreate(taskId);
  const isCurrentlyDirty = state.dirty.has(path);
  if (dirty === isCurrentlyDirty) return;
  const next = new Set(state.dirty);
  if (dirty) next.add(path);
  else next.delete(path);
  replace(taskId, { ...state, dirty: next }, { persist: false });
}

export async function hydrateEditorOpenFiles(taskId: string): Promise<void> {
  if (hydrated.has(taskId)) return;
  try {
    const result = await aceApi.sessions.listEditorOpenFiles(taskId);
    const hasLocal = (states.get(taskId)?.openFiles.length ?? 0) > 0;
    if (!hasLocal) {
      replace(
        taskId,
        {
          openFiles: result.openFiles.map((p) => ({ path: p })),
          activeFile: result.activeFile,
          dirty: new Set(),
        },
        { persist: false }
      );
    }
  } catch (err) {
    console.warn('[ace] listEditorOpenFiles failed', err);
  } finally {
    hydrated.add(taskId);
    if ((states.get(taskId)?.openFiles.length ?? 0) > 0) schedulePersist(taskId);
  }
}

export function useEditorState(taskId: string | null): TaskEditorState {
  const subscribe = (listener: () => void) => {
    if (!taskId) return () => {};
    let set = listeners.get(taskId);
    if (!set) {
      set = new Set();
      listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  };

  const getSnapshot = () => {
    if (!taskId) return EMPTY;
    return getOrCreate(taskId);
  };

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

const EMPTY: TaskEditorState = {
  openFiles: [],
  activeFile: null,
  dirty: new Set(),
};
