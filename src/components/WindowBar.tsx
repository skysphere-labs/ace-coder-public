import { useState } from 'react';
import { BrushCleaning, ChevronRight, FolderGit2, PanelLeft, PanelRight, TerminalSquare } from 'lucide-react';
import AgentLogo from './ProviderGlyph';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useApp } from '../store';
import { aceApi } from '../lib/ace-api';
import { toggleTerminal, useTerminalState } from '../runtime/terminal-mode';
import { getTaskStreamId, pasteAndSubmit } from '../runtime/terminal-io';
import { useEditorState } from '../runtime/editor-registry';
import { useActiveDisplayAgent } from '../runtime/active-agent-registry';
import { RemoteActiveBadge } from './RemoteActiveBadge';
import { ProviderUsagePill } from './ProviderUsagePill';
import { PruneDialog } from './PruneDialog';
import { PRUNE_PROMPT } from '../lib/prune-prompt';
import { AceMark } from './ui/AceMark';

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac/.test(navigator.platform) &&
  !/iPod|iPhone|iPad/.test(navigator.platform) &&
  'aceDesktop' in window;

export function WindowBar() {
  const {
    view, activeWorkspace, activeTask,
    toggleLeftSidebar,
    rightSidebarOpen, toggleRightSidebar,
  } = useApp();
  const activeTaskId = activeTask?.id ?? null;
  const { open: termOpen, mode: termMode, tabActive: termTabActive } = useTerminalState(activeTaskId);
  const editorState = useEditorState(activeTask?.id ?? null);
  const displayAgent = useActiveDisplayAgent(activeTask?.id ?? null) ?? activeTask?.agent ?? null;
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false);

  const isAgentTabActive = !!activeTask && !termTabActive && !editorState.activeFile;

  const macTitleBarPad = IS_MAC ? 'pl-[88px]' : 'pl-2';
  const hasWorkspaceChrome = view === 'workspace';

  const handleToggleTerminal = () => {
    if (!activeTaskId) return;
    if (!termOpen && termMode === 'right' && !rightSidebarOpen) {
      toggleRightSidebar();
    }
    toggleTerminal(activeTaskId);
  };

  if (!hasWorkspaceChrome) {
    return (
      <header
        className={`relative z-[80] flex h-10 shrink-0 items-center ${macTitleBarPad}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className="flex flex-shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleLeftSidebar}
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex select-none items-center gap-2 pl-2.5">
          <AceMark size={18} />
          <span className="font-display text-[13px] font-semibold tracking-tight text-foreground">
            ACE CODER
          </span>
        </div>
        <div className="flex-1" />
      </header>
    );
  }

  return (
    <header
      className={`relative z-[80] flex h-10 shrink-0 items-center pr-3 ${macTitleBarPad}`}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="flex flex-shrink-0 items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleLeftSidebar}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
        </Tooltip>
      </div>

      {activeWorkspace && (
        <div
          className="flex min-w-0 flex-shrink items-center gap-1 pl-3"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              if (activeWorkspace.path) {
                void aceApi.workspaces.openFolder(activeWorkspace.path);
              }
            }}
            title={activeWorkspace.path ? `Reveal ${activeWorkspace.path} in Finder` : undefined}
            className="group flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full border border-white/[0.05] bg-white/[0.03] px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:border-white/[0.1] hover:bg-white/[0.06] hover:text-foreground"
          >
            <FolderGit2 className="h-3 w-3 shrink-0 opacity-80" />
            <span className="truncate tracking-tight">{activeWorkspace.name}</span>
          </button>

          {activeTask && (
            <>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              <div className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full border border-[hsl(var(--ace-accent)/0.3)] bg-[hsl(var(--ace-accent)/0.08)] px-2.5 text-[11.5px] shadow-[inset_0_1px_0_hsl(var(--ace-edge)/var(--ace-edge-alpha))]">
                {displayAgent && (
                  <AgentLogo agent={displayAgent} className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate font-semibold tracking-tight text-foreground">
                  {activeTask.name}
                </span>
                {activeTask.branch && (
                  <span className="shrink-0 truncate text-[10px] font-medium text-muted-foreground/70">
                    {activeTask.branch}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      <div
        className="flex flex-shrink-0 items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <RemoteActiveBadge />
        {isAgentTabActive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setPruneDialogOpen(true)}
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <BrushCleaning className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clean up</TooltipContent>
          </Tooltip>
        )}
        {activeTask && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleToggleTerminal}
                className={`h-7 w-7 text-muted-foreground hover:text-foreground ${termOpen ? 'text-foreground' : ''}`}
              >
                <TerminalSquare className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Terminal (⌃`)</TooltipContent>
          </Tooltip>
        )}
        {activeTask && <ProviderUsagePill />}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleRightSidebar}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle changes</TooltipContent>
        </Tooltip>
      </div>

      <PruneDialog
        open={pruneDialogOpen}
        onCancel={() => setPruneDialogOpen(false)}
        onConfirm={() => {
          const streamId = getTaskStreamId(activeTask?.id ?? null);
          if (streamId) {
            pasteAndSubmit(streamId, PRUNE_PROMPT);
          }
          setPruneDialogOpen(false);
        }}
      />
    </header>
  );
}
