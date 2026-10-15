// Operations Cockpit — canonical severity map (contracts §1, load-bearing).
//
// This is the ONLY place severity colors are defined. No organism, molecule,
// or atom re-derives a color inline. Every severity surface pairs color +
// glyph + text label so the scale is colorblind-safe (never color-only).
//
//   green  → OK / informational      → emerald-400 · CheckCircle2
//   yellow → degraded, workaround     → amber-400   · AlertTriangle
//   red    → major: blocks work/trust → rose-500    · AlertOctagon
//   black  → catastrophic / security  → muted + ring-rose-500/40 · ShieldAlert
//
// `black` is reserved for security events and a fail-closed wiki write failure
// (contracts §1, §6). Nothing else emits black in v1.

import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

export type Severity = 'green' | 'yellow' | 'red' | 'black';

// Worst-of rank: green(0) < yellow(1) < red(2) < black(3).
export const SEVERITY_RANK: Record<Severity, number> = {
  green: 0,
  yellow: 1,
  red: 2,
  black: 3,
};

// Human label paired with every surface.
export const SEVERITY_TEXT: Record<Severity, string> = {
  green: 'OK',
  yellow: 'Degraded',
  red: 'Major',
  black: 'Critical',
};

// Glyph paired with every surface (colorblind safety).
export const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  green: CheckCircle2,
  yellow: AlertTriangle,
  red: AlertOctagon,
  black: ShieldAlert,
};

// Badge variant mapping. `black` has no dedicated Badge variant, so it reuses
// the muted base and layers the rose halo via SEVERITY_BORDER below.
export const SEVERITY_BADGE: Record<Severity, 'success' | 'warning' | 'destructive' | 'muted'> = {
  green: 'success',
  yellow: 'warning',
  red: 'destructive',
  black: 'muted',
};

// Solid dot fill color (the SeverityDot atom uses this).
export const SEVERITY_DOT: Record<Severity, string> = {
  green: 'bg-emerald-400',
  yellow: 'bg-amber-400',
  red: 'bg-rose-500',
  black: 'bg-muted-foreground',
};

// Foreground text/icon tint per severity.
export const SEVERITY_TEXT_COLOR: Record<Severity, string> = {
  green: 'text-emerald-400',
  yellow: 'text-amber-400',
  red: 'text-rose-400',
  black: 'text-muted-foreground',
};

// Border / halo per severity. `black` carries the reserved rose halo ring.
export const SEVERITY_BORDER: Record<Severity, string> = {
  green: 'border-emerald-500/25',
  yellow: 'border-amber-500/25',
  red: 'border-rose-500/30',
  black: 'border-white/[0.08] ring-1 ring-rose-500/40',
};

// rollupSeverity() = worst-of across the provided severities.
export function rollupSeverity(severities: Array<Severity | undefined | null>): Severity {
  let worst: Severity = 'green';
  for (const sev of severities) {
    if (!sev) continue;
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[worst]) worst = sev;
  }
  return worst;
}

// Coerce an arbitrary string (e.g. from IPC) into a known Severity, defaulting
// to yellow so an unexpected value never renders as a green "all clear".
export function asSeverity(value: unknown): Severity {
  if (value === 'green' || value === 'yellow' || value === 'red' || value === 'black') {
    return value;
  }
  return 'yellow';
}
