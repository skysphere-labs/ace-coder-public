import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../../../lib/utils';

// The single source of the tactile press treatment (`.mobile-press` = scale
// 0.96 on :active, defined in index.css). Everything tappable on mobile that
// is not already a more specific atom composes this instead of re-adding the
// class ad hoc.
export const MobilePressable = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn('mobile-press', className)} {...props} />
));
MobilePressable.displayName = 'MobilePressable';
