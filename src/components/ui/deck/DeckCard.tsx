import { cn } from '../../../lib/utils';

// A deck panel — warm surface step + soft warm depth (shadow-raise), never cold
// black glass. Carries the amber corner tick only when it holds live/attention
// state, so the "instrument" mark stays meaningful.
export function DeckCard({
  tick = false,
  className,
  children,
}: {
  tick?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-white/[0.05] bg-[hsl(var(--ace-surface)/0.5)] shadow-raise',
        tick && 'ace-tick',
        className
      )}
    >
      {children}
    </div>
  );
}
