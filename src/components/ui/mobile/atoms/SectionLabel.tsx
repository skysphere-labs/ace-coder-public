import type { ReactNode } from 'react';
import { cn } from '../../../../lib/utils';

// Editorial section eyebrow (Slate Ledger): a sentence-case 13px/600 label in a
// quiet secondary tone, with whitespace — not a box — doing the grouping. An
// optional trailing mono count-chip ("Active · 03") reads like a build-log
// column. Replaces the old all-caps, wide-tracked, dim-muted eyebrow.
export function SectionLabel({
  children,
  count,
  className,
}: {
  children: ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'flex items-center gap-2 px-1 text-[13px] font-semibold leading-tight text-[var(--m-text-secondary)]',
        className
      )}
    >
      {children}
      {count != null && (
        <span className="mono-data text-[12.5px] font-medium text-[var(--m-text-tertiary)]">
          · {String(count).padStart(2, '0')}
        </span>
      )}
    </p>
  );
}
