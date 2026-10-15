import { AlertOctagon, AlertTriangle, Bot, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { OpsPulseResult, OpsStatusResult } from '../../../lib/ace-api';
import type { RunLedgerBoard } from '../../../lib/types';
import type { SliceState } from '../../../runtime/operations-registry';
import { asSeverity, SEVERITY_ICON } from '../severity';
import { Chip } from '../atoms/Chip';
import { deriveAttention, type AttentionChip, type AttentionTab } from '../attention';

// Glyph per chip key. The severity chip normally uses SEVERITY_ICON (keyed by
// its own severity) so it stays colorblind-safe: color + glyph + label; the
// 'severity' entry here is only a fallback for the (unreachable) case where a
// severity chip arrives without its severity set.
const CHIP_ICON: Record<AttentionChip['key'], LucideIcon> = {
  severity: AlertTriangle,
  blocked: AlertOctagon,
  review: ShieldCheck,
  agents: Bot,
};

function ChipView({
  chip,
  onNavigate,
}: {
  chip: AttentionChip;
  onNavigate: (tab: AttentionTab) => void;
}) {
  const Icon = chip.key === 'severity' && chip.severity ? SEVERITY_ICON[chip.severity] : CHIP_ICON[chip.key];
  const body = (
    <Chip tone={chip.tone}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {chip.label}
    </Chip>
  );
  if (!chip.targetTab) return body;
  const target = chip.targetTab;
  return (
    <button
      type="button"
      onClick={() => onNavigate(target)}
      title="Open Monitor"
      className="rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
    >
      {body}
    </button>
  );
}

// The Board "Needs you" strip — a thin attention bar above the run board. Every
// datum is derived from slices the screen already has flowing (status rollup +
// pulse) and the shared run-ledger board (blocked / ready-to-review). It renders
// NOTHING when nothing needs the operator (deriveAttention returns []), so an
// idle board carries no clutter. No fetch of its own.
export function AttentionStrip({
  status,
  pulse,
  board,
  onNavigate,
}: {
  status: SliceState<OpsStatusResult | null>;
  pulse: SliceState<OpsPulseResult | null>;
  board: RunLedgerBoard | null;
  onNavigate: (tab: AttentionTab) => void;
}) {
  const severity =
    status.status === 'ready' && status.data ? asSeverity(status.data.rollup?.severity) : null;
  const liveAgents =
    pulse.status === 'ready' && pulse.data
      ? pulse.data.projects.reduce((n, p) => n + p.agents.busy, 0)
      : null;

  const chips = deriveAttention({
    severity,
    blocked: board?.counts.blocked ?? null,
    readyToReview: board?.counts.readyToReview ?? null,
    liveAgents,
  });

  if (chips.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2">
      <span className="text-xs font-medium uppercase tracking-wide text-foreground/45">Needs you</span>
      {chips.map((chip) => (
        <ChipView key={chip.key} chip={chip} onNavigate={onNavigate} />
      ))}
    </div>
  );
}
