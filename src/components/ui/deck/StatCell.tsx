import { cn } from '../../../lib/utils';

export type StatTone = 'muted' | 'default' | 'sky' | 'amber' | 'emerald' | 'rose';

// The run-board column tones, shared by the Home run-counts row and the Ledger
// Strip so a "review" count reads amber in both places.
const STAT_TONE: Record<StatTone, string> = {
  muted: 'text-foreground/40',
  default: 'text-foreground/75',
  sky: 'text-sky-300/90',
  amber: 'text-[hsl(var(--ace-accent))]',
  emerald: 'text-emerald-300/90',
  rose: 'text-rose-300/90',
};

// A tabular-mono count paired with a quiet label — the atomic unit of both the
// run-counts row and the ledger strip.
export function StatCell({
  count,
  label,
  tone = 'default',
  className,
}: {
  count: React.ReactNode;
  label: string;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-1', className)}>
      <span className={cn('mono-data text-[12px] font-semibold', STAT_TONE[tone])}>{count}</span>
      <span className="text-[11px] text-foreground/45">{label}</span>
    </span>
  );
}
