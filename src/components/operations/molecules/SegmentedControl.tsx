import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

// Canonical segmented control (generalizes BriefPanel's LensPicker and the
// All/New toggle). Raw <button>s are the sanctioned segmented-control
// exception; every OTHER action uses the shared ../../ui/button. Type
// standard: 13px font-medium, inactive /70, active sky fill at full -200.
export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'flex min-w-0 shrink-0 gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.03] p-0.5',
        className
      )}
    >
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const active = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(optionValue)}
            className={cn(
              'flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors duration-150',
              size === 'md' ? 'px-3 py-1.5 text-[13px]' : 'px-2 py-1 text-xs',
              active
                ? 'bg-sky-500/[0.15] text-sky-200'
                : 'text-foreground/70 hover:bg-white/[0.03] hover:text-foreground'
            )}
          >
            {Icon && (
              <Icon
                className={cn(
                  'shrink-0',
                  size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3',
                  active ? 'text-sky-300' : 'text-foreground/60'
                )}
                aria-hidden="true"
              />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
