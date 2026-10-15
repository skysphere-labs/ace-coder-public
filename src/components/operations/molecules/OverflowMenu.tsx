import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

// C3 "one primary CTA": every secondary action on a card/row lives behind this
// ⋯ menu instead of its own always-visible button. Destructive entries render
// rose and still route through their caller's ConfirmDialog — the menu never
// bypasses an existing gate.
//
// Keyboard contract: Enter/Space/ArrowDown open and focus the first item;
// ArrowUp/ArrowDown move with wrap; Escape closes and refocuses the trigger.

export type OverflowMenuItem = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
};

export function OverflowMenu({
  items,
  ariaLabel = 'More actions',
  className,
}: {
  items: OverflowMenuItem[];
  ariaLabel?: string;
  className?: string;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Outside click / Escape close.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus the first enabled item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [open]);

  const moveFocus = (delta: 1 | -1) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(current + delta + buttons.length) % buttons.length];
    next?.focus();
  };

  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    }
  };

  const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className={cn('relative shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02]',
          'text-foreground/60 transition-colors duration-150 hover:bg-white/[0.04] hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50',
          open && 'bg-white/[0.05] text-foreground'
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={handleMenuKeyDown}
          className={cn(
            'absolute right-0 top-full z-50 mt-1 flex min-w-[11rem] flex-col gap-0.5 rounded-md border border-white/[0.08] bg-[#0d1117] p-1 shadow-2xl',
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-100'
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]',
                  'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400/50',
                  item.destructive
                    ? 'text-rose-200 hover:bg-rose-500/[0.08]'
                    : 'text-foreground/85 hover:bg-white/[0.04]',
                  item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent'
                )}
              >
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
