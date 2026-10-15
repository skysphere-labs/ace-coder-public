import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

// The glass shell every organism panel sits in. Exact tokens per the UI lane
// spec: rounded-lg border border-white/[0.06] bg-white/[0.02] p-4.
export function PanelShell({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4',
        className
      )}
    >
      {children}
    </section>
  );
}
