import { MessageSquare, TerminalSquare } from 'lucide-react';
import { cn } from '../../lib/utils';

export type ViewToggleMode = 'cli' | 'chat';

export function ViewToggle({
  kind,
  onChange,
  disabledModes,
  disabledReason,
  className,
  showLabels = false,
}: {
  kind: ViewToggleMode;
  onChange: (next: ViewToggleMode) => void;
  disabledModes?: Partial<Record<ViewToggleMode, boolean>>;
  disabledReason?: string | null;
  className?: string;
  showLabels?: boolean;
}) {
  const cliTitle = disabledModes?.cli ? disabledReason ?? 'Terminal' : 'Terminal';
  const chatTitle = disabledModes?.chat ? disabledReason ?? 'Chat' : 'Chat';
  return (
    <div
      className={cn(
        'inline-flex shrink-0 rounded-full border border-white/[0.08] bg-black/20 p-1',
        className
      )}
    >
      <ToggleButton
        active={kind === 'cli'}
        disabled={!!disabledModes?.cli}
        title={cliTitle}
        onClick={() => onChange('cli')}
        icon={<TerminalSquare className="h-4 w-4" />}
        label={showLabels ? 'CLI' : undefined}
      />
      <ToggleButton
        active={kind === 'chat'}
        disabled={!!disabledModes?.chat}
        title={chatTitle}
        onClick={() => onChange('chat')}
        icon={<MessageSquare className="h-4 w-4" />}
        label={showLabels ? 'Chat' : undefined}
      />
    </div>
  );
}

function ToggleButton({
  active,
  disabled,
  title,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  icon: React.ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'flex h-9 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        label ? 'w-auto gap-1.5 px-3 text-[12px] font-medium' : 'w-9',
        active
          ? 'bg-white/[0.09] text-foreground'
          : disabled
            ? 'text-muted-foreground'
            : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
