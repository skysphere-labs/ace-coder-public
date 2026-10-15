import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ace:glass-tint-v1';

export type Tint = {
  hue: number;
  saturation: number;
  alpha: number;
};

// Touch clients (phone PWA) ground their glass chrome in the Indigo Spade's
// hue; desktop keeps the warm Ember default. Detected via the same
// navigator-based check main.tsx uses for the `ace-touch` root class — module
// init runs before main.tsx's body, so the class isn't on <html> yet.
function isTouchClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
      return !('aceDesktop' in window);
    }
  } catch {}
  return /iPad|iPhone|iPod|Android|Mobi/i.test(navigator.userAgent);
}

export const DEFAULT_TINT: Tint = isTouchClient()
  ? { hue: 233, saturation: 55, alpha: 0.14 }
  : { hue: 33, saturation: 45, alpha: 0.10 };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function loadTint(): Tint {
  if (typeof localStorage === 'undefined') return DEFAULT_TINT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TINT;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.hue === 'number' &&
      typeof parsed?.saturation === 'number' &&
      typeof parsed?.alpha === 'number'
    ) {
      return {
        hue: clamp(parsed.hue, 0, 360),
        saturation: clamp(parsed.saturation, 0, 100),
        alpha: clamp(parsed.alpha, 0, 0.4),
      };
    }
  } catch {}
  return DEFAULT_TINT;
}

function applyTint(tint: Tint) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--glass-tint-h', String(tint.hue));
  root.style.setProperty('--glass-tint-s', `${tint.saturation}%`);
  root.style.setProperty('--glass-tint-a', String(tint.alpha));
}

let state: Tint = loadTint();
applyTint(state);

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function setTint(patch: Partial<Tint>) {
  state = {
    ...state,
    ...patch,
    hue: patch.hue !== undefined ? clamp(patch.hue, 0, 360) : state.hue,
    saturation:
      patch.saturation !== undefined ? clamp(patch.saturation, 0, 100) : state.saturation,
    alpha: patch.alpha !== undefined ? clamp(patch.alpha, 0, 0.4) : state.alpha,
  };
  applyTint(state);
  persist();
  notify();
}

export function resetTint() {
  state = DEFAULT_TINT;
  applyTint(state);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  notify();
}

export function useTint(): Tint {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state
  );
}
