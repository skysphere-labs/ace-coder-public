import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { InfoTip } from './InfoTip';

// Dense label/value fact row for operations panels. Values stay 13px; labels
// use the muted 12px tier — never below the type floor.
export function KeyValue({
  label,
  children,
  infoTip,
  className,
}: {
  label: string;
  children: ReactNode;
  // Optional plain-language explanation for operational terms (C2).
  infoTip?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3 py-0.5', className)}>
      <span className="flex shrink-0 items-center gap-1 text-xs text-foreground/60">
        {label}
        {infoTip && <InfoTip label={infoTip} />}
      </span>
      <span className="min-w-0 truncate text-right text-[13px] text-foreground/85">{children}</span>
    </div>
  );
}
