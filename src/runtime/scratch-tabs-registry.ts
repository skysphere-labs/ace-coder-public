import { useSyncExternalStore } from 'react';
import { aceApi } from '../lib/ace-api';
import { openRef } from './pane-layout-registry';

export type ScratchTabKind = 'browser' | 'notes';

export type ScratchTab = {
  id: string;
  kind: ScratchTabKind;
  title: string;
  url?: string;
  favicon?: string | null;
  content?: string;
  savedPath?: string | null;
  dirty?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
};

type TaskScratchState = {
  tabs: ScratchTab[];
  activeId: string | null;
};

const EMPTY: TaskScratchState = { tabs: [], activeId: null };
const PERSIST_OMIT: (keyof ScratchTab)[] = ['canGoBack', 'canGoForward', 'loading'];
const PERSIST_DEBOUNCE_MS = 400;

const states = new Map<string, TaskScratchState>();
const listeners = new Map<string, Set<() => void>>();
const hydrated = new Set<string>();
const saveTimers = new Map<string, number>();

function getOrCreate(taskId: string): TaskScratchState {
  let state = states.get(taskId);
  if (!state) {
    state = { tabs: [], activeId: null };
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
    const serialized = state.tabs.map((t) => {
      const copy: ScratchTab = { ...t };
      for (const key of PERSIST_OMIT) delete copy[key];
      return copy;
    });
    void aceApi.sessions
      .saveScratchTabs(taskId, serialized, state.activeId)
      .catch((err) => console.warn('[ace] saveScratchTabs failed', err));
  }, PERSIST_DEBOUNCE_MS);
  saveTimers.set(taskId, timer);
}

function replace(taskId: string, next: TaskScratchState, opts: { persist?: boolean } = {}) {
  states.set(taskId, next);
  notify(taskId);
  if (opts.persist !== false) schedulePersist(taskId);
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function openBrowserTab(taskId: string, initialUrl?: string, tabId?: string): string {
  const state = getOrCreate(taskId);
  const id = tabId || uid('br');
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    updateScratchTab(taskId, id, {
      kind: 'browser',
      title: existing.title || 'New tab',
      url: initialUrl ?? existing.url ?? '',
    });
    replace(taskId, { ...getOrCreate(taskId), activeId: id });
    return id;
  }
  const tab: ScratchTab = {
    id,
    kind: 'browser',
    title: 'New tab',
    url: initialUrl || '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  };
  replace(taskId, {
    tabs: [...state.tabs, tab],
    activeId: id,
  });
  return id;
}

function activateScratchTab(taskId: string, tabId: string) {
  const state = getOrCreate(taskId);
  if (!state.tabs.some((t) => t.id === tabId)) return;
  replace(taskId, { ...state, activeId: tabId });
}

if (typeof window !== 'undefined') {
  aceApi.browser.onUiRequest((payload) => {
    if (!payload?.taskId || !payload.tabId) return;
    if (payload.type === 'open') {
      openBrowserTab(payload.taskId, payload.url, payload.tabId);
      openRef(payload.taskId, { kind: 'scratch', tabId: payload.tabId });
    } else if (payload.type === 'activate') {
      activateScratchTab(payload.taskId, payload.tabId);
      openRef(payload.taskId, { kind: 'scratch', tabId: payload.tabId });
    } else if (payload.type === 'navigate') {
      openBrowserTab(payload.taskId, payload.url, payload.tabId);
      updateScratchTab(payload.taskId, payload.tabId, {
        url: payload.url || '',
        loading: true,
      });
      openRef(payload.taskId, { kind: 'scratch', tabId: payload.tabId });
    }
  });
}

export function openNotesTab(taskId: string): string {
  const state = getOrCreate(taskId);
  const id = uid('nt');
  const tab: ScratchTab = {
    id,
    kind: 'notes',
    title: 'Untitled',
    content: '',
    dirty: false,
    savedPath: null,
  };
  replace(taskId, {
    tabs: [...state.tabs, tab],
    activeId: id,
  });
  return id;
}

export function closeScratchTab(taskId: string, tabId: string) {
  const state = getOrCreate(taskId);
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const nextTabs = state.tabs.filter((t) => t.id !== tabId);
  let nextActive = state.activeId;
  if (state.activeId === tabId) {
    const neighbour = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
    nextActive = neighbour?.id ?? null;
  }
  replace(taskId, { tabs: nextTabs, activeId: nextActive });
}

export function deactivateScratchTabs(taskId: string) {
  const state = getOrCreate(taskId);
  if (state.activeId === null) return;
  replace(taskId, { ...state, activeId: null });
}

export function updateScratchTab(
  taskId: string,
  tabId: string,
  patch: Partial<ScratchTab>
) {
  const state = getOrCreate(taskId);
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const current = state.tabs[idx];
  const next: ScratchTab = { ...current, ...patch };
  const tabs = [...state.tabs];
  tabs[idx] = next;
  const touchedPersistable = Object.keys(patch).some(
    (k) => !(PERSIST_OMIT as string[]).includes(k)
  );
  replace(taskId, { ...state, tabs }, { persist: touchedPersistable });
}

export async function hydrateScratchTabs(taskId: string): Promise<void> {
  if (hydrated.has(taskId)) return;
  try {
    const result = await aceApi.sessions.listScratchTabs(taskId);
    const hasLocal = (states.get(taskId)?.tabs.length ?? 0) > 0;
    if (!hasLocal) {
      replace(
        taskId,
        {
          tabs: result.tabs.map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            url: t.url ?? '',
            favicon: (t as { favicon?: string | null }).favicon ?? null,
            content: t.content ?? undefined,
            savedPath: t.savedPath ?? null,
            dirty: !!t.dirty,
          })),
          activeId: result.activeId,
        },
        { persist: false }
      );
    }
  } catch (err) {
    console.warn('[ace] listScratchTabs failed', err);
  } finally {
    hydrated.add(taskId);
    if ((states.get(taskId)?.tabs.length ?? 0) > 0) schedulePersist(taskId);
  }
}

export function useScratchTabs(taskId: string | null): TaskScratchState {
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
