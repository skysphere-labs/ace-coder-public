import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { MobilePill } from './MobilePill';

// The shared drawer/sheet header (Slate Ledger): an optional (demoted) back
// pill, a 20px/640 LEFT-aligned title, and an optional trailing action. The back
// gesture is the primary "back" verb now, so the pill is a quiet fallback rather
// than the centerpiece — the title leads, editorial-style.
export function SheetHeader({
  title,
  onBack,
  right,
  className,
}: {
  title: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex h-14 shrink-0 items-center gap-2 px-3', className)}>
      {onBack ? (
        <MobilePill onClick={onBack} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </MobilePill>
      ) : (
        <div className="w-1 shrink-0" />
      )}
      <h1
        className="min-w-0 flex-1 truncate text-[20px] tracking-[-0.014em] text-[var(--m-text)]"
        style={{ fontWeight: 640 }}
      >
        {title}
      </h1>
      {right}
    </header>
  );
}
