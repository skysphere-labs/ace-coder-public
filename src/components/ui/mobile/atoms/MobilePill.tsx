import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../../../lib/utils';

// The circular icon button used across mobile chrome (back, files, menu,
// new-folder, done…). Replaces the repeated
// `.mobile-header-pill flex h-11 w-11 … rounded-full` block. Under the Slate
// Ledger touch theme the `.mobile-header-pill` glass is stripped by CSS to a
// bare glyph (the back gesture is primary), so this reads as a quiet
// secondary-tone glyph. Size is overridable via className (twMerge wins).
export const MobilePill = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      'mobile-header-pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--m-text-secondary)] transition-colors active:text-[var(--m-text)]',
      className
    )}
    {...props}
  />
));
MobilePill.displayName = 'MobilePill';
