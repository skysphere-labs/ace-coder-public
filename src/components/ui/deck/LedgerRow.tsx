import { cn } from '../../../lib/utils';

// A hairline-divided row. Consecutive LedgerRows separate with a single top
// hairline (.ledger-row + .ledger-row in index.css) — structure from rules and
// whitespace, never boxes-in-boxes. Renders a <button> when clickable, else a
// plain <div>.
export function LedgerRow({
  onClick,
  children,
  className,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const base = 'ledger-row flex w-full items-center gap-3 px-4 py-2.5 text-left';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(base, 'transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', className)}
      >
        {children}
      </button>
    );
  }
  return <div className={cn(base, className)}>{children}</div>;
}
