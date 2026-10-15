import { motion } from 'framer-motion';
import { cn } from '../../../../lib/utils';

// Slim position indicator (Slate Ledger / SLIPSTREAM graft): a row of dots with
// a stretched amber capsule (shared `layoutId`) marking the active index, so a
// swipe and the indicator always agree on "where am I". Reused for section
// position (under the shell header) and in-task tab position (above the
// composer); each mount passes a distinct `layoutId`. Renders nothing for a
// single page (no rail needed).
export function GestureDots({
  count,
  index,
  layoutId = 'm-gesture-dots',
  className,
}: {
  count: number;
  index: number;
  layoutId?: string;
  className?: string;
}) {
  if (count <= 1) return null;
  return (
    <div
      aria-hidden="true"
      className={cn('flex items-center justify-center gap-1.5 py-1.5', className)}
    >
      {Array.from({ length: count }).map((_, i) => {
        const active = i === index;
        return (
          <span key={i} data-active={active || undefined} className="relative flex h-1 items-center">
            {active ? (
              <motion.span
                layoutId={layoutId}
                className="block h-1 w-4 rounded-full bg-[var(--m-accent)]"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            ) : (
              <span className="block h-1 w-1 rounded-full bg-[var(--m-text-tertiary)]" />
            )}
          </span>
        );
      })}
    </div>
  );
}
