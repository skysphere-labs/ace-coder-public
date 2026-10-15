import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { useMobileBackHandler } from '../../runtime/mobile-back-stack';
import { useBodyScrollLock } from '../../runtime/use-body-scroll-lock';

// Bottom-sheet primitive shared by `PlusSheet` and `MenuSheet`. Fixed-position
// overlay, drag handle, title, and a scrollable body. Locks body scroll and
// participates in the mobile back-stack so the system back button dismisses
// it before navigating away from the screen behind it.
export function ActionSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useBodyScrollLock();
  useMobileBackHandler(true, onClose);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90]"
      style={{ position: 'fixed' }}
      onClick={onClose}
    >
      <div className="glass-overlay absolute inset-0" />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'tween', duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        className="mobile-drawer-surface absolute inset-x-0 bottom-0 flex max-h-[min(60dvh,520px)] flex-col rounded-t-[28px] border-t border-white/[0.07] pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 landscape:max-h-[min(80dvh,300px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-white/[0.18]" />
        <div className="shrink-0 px-4 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          {title}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-1">
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}

// Row inside an ActionSheet — icon, label, optional description, optional
// trailing element (checkmark, toggle, etc). Same row shape across sheets.
// Renders as a `<label htmlFor>` when `htmlFor` is provided so the row can
// open a paired file input on iOS Safari without a programmatic `.click()`.
export function SheetButton({
  icon,
  label,
  description,
  onClick,
  trailing,
  destructive,
  htmlFor,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  onClick?: () => void;
  trailing?: React.ReactNode;
  destructive?: boolean;
  htmlFor?: string;
}) {
  if (htmlFor) {
    return (
      <label
        htmlFor={htmlFor}
        onClick={onClick}
        className={cn(
          'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors active:bg-white/[0.06]',
          destructive && 'text-rose-300'
        )}
      >
        <SheetButtonBody
          icon={icon}
          label={label}
          description={description}
          trailing={trailing}
          destructive={destructive}
        />
      </label>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors active:bg-white/[0.06]',
        destructive && 'text-rose-300'
      )}
    >
      <SheetButtonBody
        icon={icon}
        label={label}
        description={description}
        trailing={trailing}
        destructive={destructive}
      />
    </button>
  );
}

function SheetButtonBody({
  icon,
  label,
  description,
  trailing,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  trailing?: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-foreground/85',
          destructive && 'text-rose-300'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-[14px] font-medium',
            destructive ? 'text-rose-200' : 'text-foreground'
          )}
        >
          {label}
        </span>
        {description && (
          <span className="block truncate text-[11.5px] text-muted-foreground/75">
            {description}
          </span>
        )}
      </span>
      {trailing}
    </>
  );
}
