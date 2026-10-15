import { cn } from '../../../lib/utils';

// The ember — the one ambient signal. A soft amber glow + slow breathe on
// live/running elements only (via .ace-live, reduced-motion-off in index.css).
// Idle renders a quiet hollow dot so the amber stays meaningful.
export function LiveDot({ live = true, className }: { live?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block h-1.5 w-1.5 shrink-0 rounded-full',
        live ? 'ace-live bg-[hsl(var(--ace-accent))]' : 'bg-foreground/25',
        className
      )}
    />
  );
}
