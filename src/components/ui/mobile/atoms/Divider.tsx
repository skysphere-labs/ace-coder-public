import { cn } from '../../../../lib/utils';

// A 1px token-driven hairline. Replaces ad-hoc translucent-white border-t rules.
export function Divider({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('h-px w-full bg-[var(--m-hairline)]', className)} />;
}
