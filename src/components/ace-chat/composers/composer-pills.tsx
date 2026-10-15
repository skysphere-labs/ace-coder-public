import { useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';

// Shared smart-bar pill atoms. Visuals live in the `.ace-pill*` classes
// (index.css) so every composer's chips draw from the Ember token palette.

export type PillTone = 'neutral' | 'accent' | 'ok' | 'info' | 'danger';

const TONE_CLASS: Record<PillTone, string | undefined> = {
  neutral: undefined,
  accent: 'ace-pill-accent',
  ok: 'ace-pill-ok',
  info: 'ace-pill-info',
  danger: 'ace-pill-danger',
};

export function ComposerPill({
  icon,
  label,
  tone = 'neutral',
  open,
  chevron = true,
}: {
  icon?: ReactNode;
  label: ReactNode;
  tone?: PillTone;
  open?: boolean;
  chevron?: boolean;
}) {
  return (
    <div
      className={cn(
        'ace-pill group inline-flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium',
        TONE_CLASS[tone],
        open && 'ace-pill-open'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {chevron && (
        <ChevronDown
          className={cn('h-3 w-3 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
        />
      )}
    </div>
  );
}

export type PillOption = {
  key: string;
  label: string;
  hint?: string;
  tone?: PillTone;
};

// Popover-menu pill: shows the selected option, opens a token-styled list.
export function PillSelect({
  icon,
  title,
  options,
  selectedKey,
  onSelect,
  align = 'start',
  optionIcon,
}: {
  icon?: ReactNode;
  title: string;
  options: readonly PillOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
  align?: 'start' | 'end';
  optionIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === selectedKey) ?? options[0];
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" title={title} className="min-w-0">
          <ComposerPill icon={icon} label={current.label} tone={current.tone} open={open} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align={align}
          sideOffset={8}
          className="glass-surface z-[220] w-[260px] overflow-hidden rounded-2xl py-1 animate-in fade-in-0 zoom-in-95"
        >
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onSelect(o.key);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors',
                o.key === selectedKey ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
              )}
            >
              {optionIcon && <span className="mt-1 shrink-0">{optionIcon}</span>}
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-foreground">{o.label}</div>
                {o.hint && <div className="text-[10.5px] text-muted-foreground/80">{o.hint}</div>}
              </div>
              {o.key === selectedKey && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
              )}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// Action pill: fires once on click (e.g. Codex's model/approvals pickers,
// which are interactive TUI dialogs we jump the user into).
export function PillButton({
  icon,
  label,
  tone = 'neutral',
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  tone?: PillTone;
  title: string;
  onClick: () => void;
}) {
  return (
    <button type="button" title={title} onClick={onClick} className="min-w-0">
      <ComposerPill icon={icon} label={label} tone={tone} chevron={false} />
    </button>
  );
}

// The little accent dot used as a pill icon (model pills).
export function PillDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--ace-accent))]', className)}
    />
  );
}
