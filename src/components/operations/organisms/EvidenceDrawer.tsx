import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Eyebrow } from '../atoms/Eyebrow';

// THE detail surface (Azure resource blade): board-card detail, intel item
// detail, backend process internals, todo editing — one right-side drawer for
// all of them. This is where machine identifiers, raw timestamps, and command
// output are allowed to live (C2); level-1 layouts stay calm because this
// exists. Escape or backdrop closes; focus lands on Close when opened.

export function EvidenceDrawer({
  open,
  title,
  eyebrow,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: string;
  // Small category label above the title ("Board card", "Backend process").
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Track onClose in a ref so the focus/Escape effect depends ONLY on `open`:
  // an inline onClose closure must not re-run the effect and steal focus from
  // drawer form fields on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[55]" role="presentation">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 motion-safe:animate-in motion-safe:fade-in-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-white/[0.08] bg-[#0d1117] shadow-2xl',
          'motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200',
          className
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-foreground/60',
              'transition-colors duration-150 hover:bg-white/[0.04] hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50'
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {children}
        </div>
        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
