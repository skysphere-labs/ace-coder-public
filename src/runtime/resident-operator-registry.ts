import { useSyncExternalStore } from 'react';

// Presentation state + full-canvas anchor for the resident operator surface.
// The embed is a resident of the shell, so its presentation is host state — not
// a route. Hermes owns all session state. nav-rail-registry house style; safe
// when storage is absent.

const STORAGE_KEY = 'ace:resident-operator-v1';

/** The three host presentations. One DOM instance; these differ only in layout. */
export type ResidentOperatorMode = 'collapsed' | 'popup' | 'full';

type ResidentOperatorState = { mode: ResidentOperatorMode };

// Launcher visible, popup closed: a fresh install never boots into a covered canvas.
const DEFAULT_STATE: ResidentOperatorState = { mode: 'collapsed' };

const MODES: ResidentOperatorMode[] = ['collapsed', 'popup', 'full'];

function load(): ResidentOperatorState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (MODES.includes(parsed?.mode)) return { mode: parsed.mode };
    // v1 stored { open: boolean } while full canvas was still the Teams route.
    if (typeof parsed?.open === 'boolean') return { mode: parsed.open ? 'popup' : 'collapsed' };
  } catch {}
  return DEFAULT_STATE;
}

let state: ResidentOperatorState = load();
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

/**
 * Presentation, in precedence order. The diff viewer is itself a full-canvas
 * overlay, so it outranks full mode rather than being covered by it.
 */
export function resolveResidentMode(input: {
  mode: ResidentOperatorMode;
  showDiffViewer?: boolean;
}): ResidentOperatorMode {
  if (input.mode === 'full' && input.showDiffViewer) return 'popup';
  return input.mode;
}

export function getResidentOperatorMode(): ResidentOperatorMode {
  return state.mode;
}

export function setResidentOperatorMode(mode: ResidentOperatorMode) {
  if (state.mode === mode) return;
  state = { mode };
  persist();
  notify();
}

export function useResidentOperatorMode(): ResidentOperatorMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state.mode
  );
}

// ── Full-canvas anchor ──────────────────────────────────────────────────────
// The surface mounts above the shell swap, so shells cannot pass a ref down;
// they register their content element here instead.

let anchor: HTMLElement | null = null;
const anchorListeners = new Set<() => void>();

export function registerResidentAnchor(el: HTMLElement | null) {
  if (anchor === el) return;
  anchor = el;
  for (const l of anchorListeners) l();
}

export function getResidentAnchor(): HTMLElement | null {
  return anchor;
}

export function useResidentAnchor(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      anchorListeners.add(listener);
      return () => {
        anchorListeners.delete(listener);
      };
    },
    () => anchor
  );
}

/** Test-only reset so the singletons don't leak across unit tests. */
export function __resetResidentOperatorForTests() {
  state = DEFAULT_STATE;
  anchor = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  notify();
  for (const l of anchorListeners) l();
}
