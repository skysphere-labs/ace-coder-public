import type { ReactNode } from 'react';
import { AlertOctagon, Inbox } from 'lucide-react';
import { Spinner } from '../../ui/spinner';
import { cn } from '../../../lib/utils';

// Loading state — neutral, never implies health either way.
export function LoadingState({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 py-6 text-[13px] text-foreground/70',
        className
      )}
    >
      <Spinner size="sm" />
      {label}
    </div>
  );
}

// Error state — a panel that could not load its slice. Rose, with a glyph.
export function ErrorState({
  message,
  action,
  className,
}: {
  message: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-3 py-5 text-center',
        className
      )}
    >
      <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-full bg-rose-500/10">
        <AlertOctagon className="h-4 w-4 text-rose-400" />
      </span>
      <span className="text-[13px] text-rose-200">{message}</span>
      {action}
    </div>
  );
}

// Empty state — explicitly NEVER green. Empty is the absence of data, not an
// "all clear" (contracts §UI: empty != healthy). Rendered neutral/muted.
export function EmptyState({
  label = 'Nothing to show',
  hint,
  className,
}: {
  label?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-md border border-dashed border-white/[0.08] px-3 py-6 text-center',
        className
      )}
    >
      <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.05]">
        <Inbox className="h-4 w-4 text-foreground/35" />
      </span>
      <span className="text-[13px] text-foreground/70">{label}</span>
      {hint && <span className="text-xs text-foreground/60">{hint}</span>}
    </div>
  );
}
