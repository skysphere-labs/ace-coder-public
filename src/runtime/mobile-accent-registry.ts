import { useSyncExternalStore } from 'react';
import { setTint } from './tint-registry';

// The swappable half of the Indigo Ledger theme. index.css ships the indigo
// defaults under :root.ace-touch; picking a different accent writes the same
// --m-accent* / --m-status-busy custom properties inline on <html> (inline
// beats the stylesheet), so every consumer — NavTab, StatusDot, GestureDots,
// swipe seam, smart-bar accent chips, the composer send — re-colors from one
// apply. Paired glass-tint hues ride along via tint-registry so the floating
// glass panes agree with the accent. Touch-only: applying these vars on a
// desktop root would clobber the legacy desktop --m-* aliases.

const STORAGE_KEY = 'ace:mobile-accent-v1';

export type MobileAccent = {
  id: string;
  label: string;
  /** Accent color, HSL parts. */
  hue: number;
  sat: number;
  light: number;
  /** Glass tint pairing applied alongside the accent. */
  tintHue: number;
  tintSat: number;
  /** Knock the glyph out in dark ink instead of white (light accents). */
  darkInk?: boolean;
};

export const MOBILE_ACCENTS: readonly MobileAccent[] = [
  { id: 'indigo', label: 'Indigo', hue: 233, sat: 82, light: 66, tintHue: 233, tintSat: 55 },
  { id: 'ember', label: 'Ember', hue: 33, sat: 92, light: 58, tintHue: 33, tintSat: 45, darkInk: true },
  { id: 'emerald', label: 'Emerald', hue: 155, sat: 60, light: 52, tintHue: 155, tintSat: 45, darkInk: true },
  { id: 'cyan', label: 'Cyan', hue: 192, sat: 76, light: 56, tintHue: 192, tintSat: 55, darkInk: true },
  { id: 'violet', label: 'Violet', hue: 268, sat: 74, light: 64, tintHue: 268, tintSat: 50 },
  { id: 'rose', label: 'Rose', hue: 342, sat: 76, light: 60, tintHue: 342, tintSat: 55 },
];

export const DEFAULT_ACCENT_ID = 'indigo';

/** The full var set an accent choice writes. Pure — unit-testable. */
export function accentVars(a: MobileAccent): Record<string, string> {
  const { hue: h, sat: s, light: l } = a;
  const base = `hsl(${h} ${s}% ${l}%)`;
  return {
    '--m-accent': base,
    // Glyphs knocked out of the filled disc: near-white on deep accents,
    // near-black on light ones (amber/emerald/cyan), so contrast holds.
    '--m-accent-ink': a.darkInk ? `hsl(${h} 50% 10%)` : `hsl(${h} 100% 98%)`,
    '--m-accent-quiet': `hsl(${h} ${s}% ${l}% / 0.14)`,
    '--m-accent-glow': `hsl(${h} ${s}% ${l}% / 0.45)`,
    '--m-ring-active': base,
    '--m-status-busy': `${h} ${s}% ${l}%`,
    '--m-accent-fill': `linear-gradient(180deg, hsl(${h} ${Math.min(100, s + 2)}% ${Math.min(100, l + 4)}%), hsl(${h + 3} ${Math.max(0, s - 6)}% ${Math.max(0, l - 6)}%))`,
    '--m-accent-raise': [
      `inset 0 1px 0 0 hsl(${h} 100% 90% / 0.30)`,
      `0 1px 2px hsl(240 60% 3% / 0.5)`,
      `0 4px 14px -4px hsl(${h} 80% 60% / 0.5)`,
    ].join(', '),
  };
}

export function getAccent(id: string): MobileAccent {
  return MOBILE_ACCENTS.find((a) => a.id === id) ?? MOBILE_ACCENTS[0];
}

// Same navigator-based touch detection main.tsx uses for `ace-touch` —
// module init runs before main.tsx's body puts the class on <html>.
function isTouchClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
      return !('aceDesktop' in window);
    }
  } catch {}
  return /iPad|iPhone|iPod|Android|Mobi/i.test(navigator.userAgent);
}

function loadAccentId(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_ID;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && MOBILE_ACCENTS.some((a) => a.id === raw)) return raw;
  } catch {}
  return DEFAULT_ACCENT_ID;
}

function applyAccent(accent: MobileAccent) {
  if (typeof document === 'undefined' || !isTouchClient()) return;
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(accentVars(accent))) {
    style.setProperty(key, value);
  }
}

let state = loadAccentId();
// Re-assert a persisted non-default accent before first paint. The default
// needs no inline vars — index.css already ships it — which keeps <html>
// clean for the common case.
if (state !== DEFAULT_ACCENT_ID) applyAccent(getAccent(state));

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function setMobileAccent(id: string) {
  const accent = getAccent(id);
  state = accent.id;
  applyAccent(accent);
  // Keep the glass panes on the accent's hue; intensity stays user-owned.
  setTint({ hue: accent.tintHue, saturation: accent.tintSat });
  try {
    localStorage.setItem(STORAGE_KEY, state);
  } catch {}
  notify();
}

export function useMobileAccent(): string {
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
