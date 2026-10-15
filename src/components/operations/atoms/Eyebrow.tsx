import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

// The ONLY sanctioned sub-12px text in Operations (type standard): an 11px
// uppercase group/eyebrow label at /60. Everything else is 12px+.
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'text-[11px] font-semibold uppercase tracking-wide text-foreground/60',
        className
      )}
    >
      {children}
    </span>
  );
}
