// Board "Needs you" attention strip — pure derivation.
//
// Turns the three signals the Board tab already has flowing (run-ledger blocked
// / ready-to-review counts, the status rollup severity, and busy-agent count)
// into a small ordered chip list. Returns an EMPTY list when nothing needs the
// operator, so the strip renders null instead of adding clutter. No IPC, no
// React — unit-tested directly.
//
// Type-only import of Severity keeps this module runtime-dependency-free.
import type { Severity } from './severity';

// Tabs a chip can navigate to when clicked. Blocked / review runs live on the
// Board itself, so those chips are informational (no target); severity and live
// agents both surface on Monitor.
export type AttentionTab = 'monitoring';

export type AttentionChip = {
  key: 'severity' | 'blocked' | 'review' | 'agents';
  label: string;
  tone: 'rose' | 'amber' | 'sky';
  // Present only for the severity chip; drives the colorblind-safe glyph.
  severity?: Severity;
  // When set, the chip is a button that switches to this tab.
  targetTab?: AttentionTab;
};

export type AttentionInput = {
  // Worst status rollup severity, or null when the status slice isn't ready.
  severity: Severity | null;
  // Run-ledger counts, or null when the board hasn't loaded.
  blocked: number | null;
  readyToReview: number | null;
  // Busy agents across projects, or null when the pulse slice isn't ready.
  liveAgents: number | null;
};

const NON_GREEN: ReadonlySet<Severity> = new Set(['yellow', 'red', 'black']);

// Reuses severity.ts wording without importing its lucide-bearing runtime.
const SEVERITY_LABEL: Record<Exclude<Severity, 'green'>, string> = {
  yellow: 'Degraded',
  red: 'Major',
  black: 'Critical',
};

export function deriveAttention(input: AttentionInput): AttentionChip[] {
  const chips: AttentionChip[] = [];

  // A green rollup is "all clear" and stays silent; anything worse is worth a
  // glance and jumps to Monitor.
  if (input.severity && NON_GREEN.has(input.severity)) {
    const severity = input.severity as Exclude<Severity, 'green'>;
    chips.push({
      key: 'severity',
      label: SEVERITY_LABEL[severity],
      tone: severity === 'yellow' ? 'amber' : 'rose',
      severity,
      targetTab: 'monitoring',
    });
  }

  const blocked = input.blocked ?? 0;
  if (blocked > 0) {
    chips.push({ key: 'blocked', label: `${blocked} blocked`, tone: 'rose' });
  }

  const review = input.readyToReview ?? 0;
  if (review > 0) {
    chips.push({ key: 'review', label: `${review} to review`, tone: 'amber' });
  }

  // Live agents are ambient context, not an alert on their own: only ride along
  // when the strip is already surfacing something that needs the operator.
  const agents = input.liveAgents ?? 0;
  if (chips.length > 0 && agents > 0) {
    chips.push({
      key: 'agents',
      label: `${agents} agent${agents === 1 ? '' : 's'} live`,
      tone: 'sky',
      targetTab: 'monitoring',
    });
  }

  return chips;
}
