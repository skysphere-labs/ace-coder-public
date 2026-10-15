import type { ReactNode } from 'react';
import { cn } from '../../../../lib/utils';

// Empty ≠ healthy (mirrors the ops `states.tsx` contract): shown when a mobile
// list has nothing REAL to show — never a fake row. Slate Ledger: a calm
// recessed warm shelf (inset shadow + hairline) with a low-opacity amber glyph
// well, left-aligned — reads as "a quiet empty shelf", not a broken dashed box.
export function MobileEmptyState({
  icon,
  label,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-2 rounded-2xl border border-[var(--m-hairline)] bg-[var(--m-bg-sunken)] px-4 py-10 text-left shadow-[inset_0_1px_2px_hsl(30_10%_2%/0.5)]',
        className
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--m-accent-quiet)] text-[var(--m-accent)] opacity-80"
        >
          {icon}
        </span>
      )}
      <span className="text-[14px] text-[var(--m-text-secondary)]">{label}</span>
      {hint && <span className="text-[12.5px] text-[var(--m-text-tertiary)]">{hint}</span>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
