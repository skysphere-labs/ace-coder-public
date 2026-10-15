// Haptic feedback for touch clients. navigator.vibrate is the only web
// vibration API and it is Android-only — iOS Safari/PWAs expose no haptics to
// web content — so this degrades to a silent no-op there (visual press states
// remain the iOS feedback). Pulses stay short: these are UI ticks, not
// notifications.
export type HapticKind = 'tick' | 'success' | 'warning';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  success: [10, 40, 14],
  warning: [18, 30, 18],
};

export function haptic(kind: HapticKind = 'tick'): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    const vibrate = (navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean }).vibrate;
    if (typeof vibrate !== 'function') return false;
    return vibrate.call(navigator, PATTERNS[kind]);
  } catch {
    return false;
  }
}
