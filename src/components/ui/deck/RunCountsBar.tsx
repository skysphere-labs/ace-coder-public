import { ChevronRight } from 'lucide-react';
import type { RunLedgerBoard } from '../../../lib/types';
import { StatCell } from './StatCell';

// The five run-ledger lifecycle counts in one row, reusing the board's column
// tones. The whole bar routes to Operations. Renders nothing when the ledger is
// empty (counts.total === 0) so Home never shows a zeroed-out shell.
export function RunCountsBar({
  counts,
  followUpCount = 0,
  onOpen,
}: {
  counts: RunLedgerBoard['counts'] | undefined;
  followUpCount?: number;
  onOpen: () => void;
}) {
  if (!counts || counts.total === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-white/[0.05] bg-[hsl(var(--ace-surface)/0.5)] px-4 py-3 text-left shadow-raise transition-colors hover:border-white/[0.1]"
    >
      <StatCell count={counts.todo} label="To Do" tone="muted" />
      <StatCell count={counts.inProgress} label="In Progress" tone="sky" />
      <StatCell count={counts.readyToReview} label="Ready to Review" tone="amber" />
      <StatCell count={counts.done} label="Done" tone="emerald" />
      <StatCell count={counts.blocked} label="Blocked" tone="rose" />
      {followUpCount > 0 && (
        <span className="mono-data text-[11px] text-foreground/45">
          {followUpCount} follow-up{followUpCount === 1 ? '' : 's'} pending
        </span>
      )}
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-foreground/30 transition-colors group-hover:text-foreground/60" />
    </button>
  );
}
