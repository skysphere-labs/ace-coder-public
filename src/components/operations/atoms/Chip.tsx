import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

// Canonical small chip/tag (type standard: text-xs font-medium; colored chips
// use the -200 shade at FULL opacity — never colored/70). Replaces the one-off
// KindChip / fit pill / risk pill / "skipped" tag patterns across Operations.
export type ChipTone = 'neutral' | 'sky' | 'amber' | 'emerald' | 'rose';

const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'border-white/[0.08] bg-white/[0.04] text-foreground/70',
  sky: 'border-sky-500/25 bg-sky-500/[0.08] text-sky-200',
  amber: 'border-amber-500/25 bg-amber-500/[0.08] text-amber-200',
  emerald: 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200',
  rose: 'border-rose-500/25 bg-rose-500/[0.08] text-rose-200',
};

export function Chip({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
