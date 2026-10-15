import { useState } from 'react';
import { PanelBottom, PanelRight, Maximize2, X, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import { TerminalFeed } from './TerminalFeed';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  closeTerminal,
  consumeSnapPulse,
  setTerminalMode,
  useTerminalState,
  type TerminalMode,
} from '../runtime/terminal-mode';
import {
  closeTerminalSession,
  openTerminalSession,
  selectTerminalSession,
  terminalSessionLabel,
  useTerminalSessions,
} from '../runtime/terminal-sessions-registry';
import { openRef } from '../runtime/pane-layout-registry';

interface TerminalPanelProps {
  workItemId: string;
  label?: string;
}

const MODES: Array<{
  id: TerminalMode;
  icon: typeof PanelBottom;
  title: string;
}> = [
  { id: 'bottom', icon: PanelBottom, title: 'Dock at bottom' },
  { id: 'right', icon: PanelRight, title: 'Dock in right sidebar' },
  { id: 'tab', icon: Maximize2, title: 'Open as tab' },
];

export function TerminalPanel({ workItemId, label }: TerminalPanelProps) {
  const { mode } = useTerminalState(workItemId);
  const [pulse] = useState(() => consumeSnapPulse(workItemId));
  const { sessions, activeId } = useTerminalSessions(workItemId);
  const streamId = activeId ?? sessions[0] ?? null;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_28px_rgba(0,0,0,0.3)] backdrop-blur-md"
      style={{ backgroundColor: 'hsl(0 0% 5% / 0.6)' }}
    >
      <div className="flex h-8 shrink-0 items-stretch gap-1 border-b border-white/[0.06] pl-2 pr-2">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1">
          {sessions.map((id) => {
            const isActive = id === streamId;
            const tabLabel = terminalSessionLabel(workItemId, id);
            return (
              <div
                key={id}
                onClick={() => selectTerminalSession(workItemId, id)}
                className={cn(
                  'group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-t-md px-2 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'bg-white/[0.06] text-foreground'
                    : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground/80'
                )}
              >
                <span className="truncate">{tabLabel}</span>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminalSession(workItemId, id);
                    }}
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded-sm transition-colors',
                      isActive
                        ? 'text-foreground/55 hover:bg-black/20 hover:text-foreground/90'
                        : 'text-muted-foreground/40 opacity-0 hover:bg-white/[0.06] hover:text-foreground/80 group-hover:opacity-100'
                    )}
                    aria-label={`Close ${tabLabel}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openTerminalSession(workItemId)}
                className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
                aria-label="New terminal"
              >
                <Plus className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New terminal</TooltipContent>
          </Tooltip>
          {label && (
            <span className="ml-2 truncate self-center text-[10.5px] text-muted-foreground/60">
              {label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 self-center">
          {MODES.map(({ id, icon: Icon, title }) => {
            const isActive = mode === id;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      setTerminalMode(workItemId, id);
                      if (id === 'tab') {
                        openRef(workItemId, { kind: 'terminal' });
                      }
                    }}
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded transition-colors',
                      isActive
                        ? 'bg-[hsl(0_0%_100%/0.08)] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]'
                        : 'text-muted-foreground hover:bg-[hsl(0_0%_100%/0.04)] hover:text-foreground',
                      pulse && !isActive && 'terminal-snap-pulse'
                    )}
                    aria-label={title}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{title}</TooltipContent>
              </Tooltip>
            );
          })}
          <div className="mx-1 h-3 w-px bg-border/40" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => closeTerminal(workItemId)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[hsl(0_0%_100%/0.04)] hover:text-foreground"
                aria-label="Close terminal"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close terminal</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {sessions.map((id) => (
          <div key={id} className={cn('h-full w-full', id !== streamId && 'hidden')}>
            <TerminalFeed streamId={id} />
          </div>
        ))}
      </div>
    </div>
  );
}
