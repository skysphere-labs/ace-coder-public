import { useSyncExternalStore } from 'react';

export type ChatViewMode = 'cli' | 'chat';

const STORAGE_KEY = 'ace:default-tab-view';
const STORAGE_EVENT = 'ace:default-tab-view:change';
const DEFAULT_MODE: ChatViewMode = 'cli';

function readFromStorage(): ChatViewMode {
  if (typeof localStorage === 'undefined') return DEFAULT_MODE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'chat' ? 'chat' : 'cli';
  } catch {
    return DEFAULT_MODE;
  }
}

export function readDefaultViewMode(): ChatViewMode {
  return readFromStorage();
}

export function writeDefaultViewMode(mode: ChatViewMode) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage is preference-only.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT));
  }
}

export function useDefaultViewMode(): ChatViewMode {
  return useSyncExternalStore(
    (fn) => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener(STORAGE_EVENT, fn);
      window.addEventListener('storage', fn);
      return () => {
        window.removeEventListener(STORAGE_EVENT, fn);
        window.removeEventListener('storage', fn);
      };
    },
    readFromStorage,
    () => DEFAULT_MODE
  );
}
