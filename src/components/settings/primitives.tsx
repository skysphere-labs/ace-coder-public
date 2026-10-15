// Local settings atoms for the props-driven sections in this directory.
//
// The Tailwind classes are copied byte-for-byte from PreferencesScreen's
// internal SettingsSection / SettingsRow / ToggleRow (and the resolved
// outline Button classes) so these sections render identically when mounted
// next to the existing tabs. Consolidating PreferencesScreen onto these
// shared primitives happens in a later integration unit — do not import this
// file from PreferencesScreen yet.

import { cn } from '../../lib/utils';

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h3>
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  icon,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description != null && (
          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// Controlled variant of PreferencesScreen's ToggleRow (that one holds local
// state; these sections are fully props-driven).
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      title={label}
      description={description}
      action={
        <button
          type="button"
          role="switch"
          onClick={() => onChange(!checked)}
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          className={cn(
            'flex h-7 w-12 shrink-0 items-center rounded-full border px-[3px] transition-colors duration-150 sm:h-[22px] sm:w-[40px]',
            checked
              ? 'justify-end border-emerald-400/30 bg-emerald-500/25'
              : 'justify-start border-white/[0.08] bg-white/[0.04]',
            disabled && 'pointer-events-none opacity-50'
          )}
        >
          <div
            className={cn(
              'h-5 w-5 rounded-full transition-colors duration-150 sm:h-4 sm:w-4',
              checked ? 'bg-foreground' : 'bg-foreground/60'
            )}
          />
        </button>
      }
    />
  );
}

// Resolved classes of `<Button variant="outline" size="sm" className="h-7
// text-[11px]">` as used across PreferencesScreen, inlined so this directory
// has a dependency-light atom.
export function ActionButton({
  children,
  onClick,
  disabled = false,
  variant = 'default',
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md px-3 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 sm:h-7 sm:text-[11px]',
        variant === 'danger'
          ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:border-rose-500/40 hover:bg-rose-500/15'
          : 'border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
