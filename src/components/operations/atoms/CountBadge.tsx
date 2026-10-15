import { cn } from '../../../lib/utils';

// Canonical numeric count pill (jump-nav counts, section totals, "4 open").
// Type standard: text-xs tabular-nums text-foreground/70 — never below 12px.
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-xs font-medium tabular-nums text-foreground/70',
        className
      )}
    >
      {count}
    </span>
  );
}
