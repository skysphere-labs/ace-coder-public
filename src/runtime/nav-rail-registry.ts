import { useSyncExternalStore } from 'react';

// The NavRail can be pinned open (expanded, taking layout width) or left as the
// slim icon rail that hover-expands as an overlay. Only the PINNED choice is
// durable — hover is ephemeral and lives in the component. Mirrors the
// tint-registry house style (module state + listener set + useSyncExternalStore
// + localStorage), safe when storage is missing or corrupt.

const STORAGE_KEY = 'ace:nav-rail-v1';

// The slim icon rail vs the pinned/expanded rail. w-14 / w-52 in Tailwind; kept
// as numbers here so DesktopShell can measure the live rail width for the left
// panel resize clamp.
export const NAV_RAIL_COLLAPSED_WIDTH = 56;
export const NAV_RAIL_EXPANDED_WIDTH = 208;

type NavRailState = { pinned: boolean };

const DEFAULT_STATE: NavRailState = { pinned: false };

function load(): NavRailState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pinned === 'boolean') return { pinned: parsed.pinned };
  } catch {}
  return DEFAULT_STATE;
}

let state: NavRailState = load();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function isPinned(): boolean {
  return state.pinned;
}

export function setPinned(pinned: boolean) {
  if (state.pinned === pinned) return;
  state = { pinned };
  persist();
  notify();
}

export function toggleNavRailPinned() {
  setPinned(!state.pinned);
}

export function useNavRailPinned(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state.pinned
  );
}

// Test-only reset so the singleton doesn't leak state across unit tests.
export function __resetNavRailForTests() {
  state = DEFAULT_STATE;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  notify();
}
