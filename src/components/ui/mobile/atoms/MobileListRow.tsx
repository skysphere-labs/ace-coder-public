import { forwardRef, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../../lib/utils';

// Generic tappable list row (Slate Ledger): leading visual + title/subtitle +
// trailing slot + optional chevron, ruled like an editorial table. 16px title,
// 14px AA subtitle, ≥56px target. `live` paints a 2px amber left-rail (the only
// amber in a resting list); `divider` adds the bottom hairline (the caller omits
// it on the last row so the group reads as one ruled block).
export const MobileListRow = forwardRef<
  HTMLButtonElement,
  {
    leading?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    trailing?: ReactNode;
    chevron?: boolean;
    live?: boolean;
    divider?: boolean;
    onClick?: () => void;
    className?: string;
  }
>(({ leading, title, subtitle, trailing, chevron, live, divider, onClick, className }, ref) => (
  <button
    ref={ref}
    type="button"
    onClick={onClick}
    className={cn(
      'mobile-press relative flex min-h-[56px] w-full items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-[var(--m-surface)]',
      divider && 'border-b border-[var(--m-hairline)]',
      className
    )}
  >
    {live && (
      <span
        aria-hidden="true"
        className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-[var(--m-accent)]"
      />
    )}
    {leading}
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className="min-w-0 truncate text-[16px] leading-snug tracking-[-0.006em] text-[var(--m-text)]"
        style={{ fontWeight: 480 }}
      >
        {title}
      </span>
      {subtitle && (
        <span className="min-w-0 truncate text-[14px] leading-snug text-[var(--m-text-secondary)]">
          {subtitle}
        </span>
      )}
    </span>
    {trailing}
    {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-[var(--m-text-tertiary)]" />}
  </button>
));
MobileListRow.displayName = 'MobileListRow';
