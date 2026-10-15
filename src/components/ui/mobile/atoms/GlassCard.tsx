import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../../../lib/utils';

// The standard frosted mobile surface. Replaces the repeated
// `.mobile-glass-card rounded-2xl border …` so call sites stop re-declaring the
// surface treatment (and the raw translucent-white borders that came with it).
export const GlassCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mobile-glass-card rounded-2xl', className)} {...props} />
  )
);
GlassCard.displayName = 'GlassCard';
