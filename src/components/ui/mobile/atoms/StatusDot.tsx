import { cn } from '../../../../lib/utils';

// The single place a task/agent status maps to a color — keeps the status-color
// ternary out of every row. Slate Ledger: a busy/running agent is the one loud
// signal (breathing amber glow via `.m-busy-dot`); done/error stay calm and
// flat; idle is a hollow tertiary ring (never colored). Tokens (`--m-status-*`)
// live in index.css so the palette is themeable in one spot.
export type MobileStatus = 'idle' | 'busy' | 'done' | 'error';

const TONE: Record<MobileStatus, string> = {
  idle: 'border border-[var(--m-text-tertiary)] bg-transparent',
  busy: 'm-busy-dot bg-[hsl(var(--m-status-busy))]',
  done: 'bg-[hsl(var(--m-status-done))]',
  error: 'bg-[hsl(var(--m-status-error))]',
};

export function StatusDot({ status, className }: { status: MobileStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE[status], className)}
    />
  );
}
