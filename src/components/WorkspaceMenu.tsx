import { useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ArrowLeft, Bot, ChevronRight, FolderGit2, FolderOpen, GitBranch,
  GitPullRequest, MessageSquare, Pin, PinOff, RefreshCw, Trash, Wrench,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Spinner } from './ui/spinner';
import WorkspaceBranchPicker from './WorkspaceBranchPicker';
import PullRequestQueue from './PullRequestQueue';
import BranchCleanupPanel from './BranchCleanupPanel';
import { useApp } from '../store';
import { aceApi } from '../lib/ace-api';
import {
  initializeWorkspaceRepository,
  refreshWorkspaceRecord,
  removeWorkspaceRecord,
} from '../runtime/workspace-registry';
import type { Workspace } from '../lib/types';

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.07c-3.2.69-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.52-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.17.92-.26 1.9-.39 2.88-.39s1.96.13 2.88.39c2.2-1.48 3.16-1.17 3.16-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

type SubView = 'root' | 'prs' | 'branches';

export function WorkspaceMenu({
  workspace, children, align = 'start',
}: {
  workspace: Workspace;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState<SubView>('root');

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSubView('root');
      }}
    >
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          align={align}
          collisionPadding={12}
          className={cn(
            'glass-surface z-[120] overflow-hidden rounded-xl p-0 text-foreground',
            'animate-in fade-in-0 zoom-in-95',
            subView === 'root' ? 'w-[340px]' : 'w-[520px]'
          )}
        >
          {subView === 'root' ? (
            <MenuRoot
              workspace={workspace}
              onClose={() => setOpen(false)}
              onSubView={setSubView}
            />
          ) : (
            <MenuSubPanel
              title={subView === 'prs' ? 'Pull requests' : 'Stale branches'}
              onBack={() => setSubView('root')}
            >
              {subView === 'prs' && workspace.openPrs && (
                <PullRequestQueue prs={workspace.openPrs} />
              )}
              {subView === 'branches' && (
                <BranchCleanupPanel
                  workspaceId={workspace.id}
                  branches={workspace.cleanupBranches ?? []}
                />
              )}
            </MenuSubPanel>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MenuRoot({
  workspace, onClose, onSubView,
}: {
  workspace: Workspace;
  onClose: () => void;
  onSubView: (v: SubView) => void;
}) {
  const { openWorkspace, setView, setPendingChatKind } = useApp();
  const [busy, setBusy] = useState<
    'init' | 'refresh' | 'remove' | 'orchestrator-hermes' | 'always-on' | null
  >(null);
  const [baseBranch, setBaseBranch] = useState(workspace.defaultBranch ?? '');

  const isInitialized = workspace.isInitialized !== false;
  const canCreateTask = isInitialized;
  const canInitializeRepo = !isInitialized;
  const prCount = workspace.openPrs?.length ?? 0;
  const branchCount = workspace.cleanupBranches?.length ?? 0;
  const showPrsEntry = canCreateTask && !workspace.isRemote && !!workspace.openPrs;
  const showBranchesEntry = canCreateTask;

  const selectedBaseBranch = baseBranch || workspace.defaultBranch;

  const revealFolder = () => {
    if (workspace.path) void aceApi.workspaces.openFolder(workspace.path);
    onClose();
  };

  const refresh = () => {
    setBusy('refresh');
    void refreshWorkspaceRecord(workspace.id).finally(() => setBusy(null));
  };

  const initialize = () => {
    setBusy('init');
    void initializeWorkspaceRepository(workspace.id).finally(() => setBusy(null));
  };

  const openOnGithub = () => {
    if (!workspace.githubRepo) return;
    void aceApi.workspaces.openExternal(`https://github.com/${workspace.githubRepo}`);
    onClose();
  };

  const remove = () => {
    if (!window.confirm(`Remove workspace "${workspace.name}" from Ace?`)) return;
    setBusy('remove');
    void removeWorkspaceRecord(workspace.id)
      .then(() => {
        onClose();
        setView('home');
      })
      .finally(() => setBusy(null));
  };

  const openNewChat = (preset: 'thread' | 'task') => {
    setPendingChatKind(preset);
    openWorkspace(workspace.id, 'new-chat');
    onClose();
  };

  const startOrchestrator = () => {
    setBusy('orchestrator-hermes');
    void aceApi.workspaces
      .startOrchestrator(workspace.id, 'hermes')
      .then(() => {
        onClose();
      })
      .catch((err) => {
        window.alert(`Could not start Hermes orchestrator:\n${err?.message ?? err}`);
      })
      .finally(() => setBusy(null));
  };

  const toggleAlwaysOn = () => {
    const wasOn = !!workspace.alwaysOnOrchestrator;
    const agent = wasOn ? undefined : workspace.alwaysOnAgent || 'hermes';
    setBusy('always-on');
    void aceApi.workspaces
      .setAlwaysOnOrchestrator(workspace.id, !wasOn, agent)
      .then(async () => {
        if (!wasOn) {
          // Enabling also needs to spawn the orchestrator now — boot-time
          // auto-start only fires on app launch. startOrchestrator is idempotent
          // so a re-toggle on an already-live workspace is a no-op.
          await aceApi.workspaces.startOrchestrator(workspace.id, agent as 'hermes' | 'claude' | 'codex');
        }
        await refreshWorkspaceRecord(workspace.id);
      })
      .catch((err) => {
        window.alert(`Could not update always-on:\n${err?.message ?? err}`);
      })
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-white/[0.06] p-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-tight">{workspace.name}</div>
            {workspace.githubRepo && (
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                <GithubMark className="h-3 w-3 shrink-0" />
                <span className="truncate">{workspace.githubRepo}</span>
              </div>
            )}
            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
              {workspace.path}
            </div>
          </div>
        </div>
        {canCreateTask && (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="shrink-0">Base branch</span>
            <WorkspaceBranchPicker
              baseBranch={selectedBaseBranch}
              branchOptions={workspace.branches ?? []}
              onBaseBranchChange={setBaseBranch}
            />
          </div>
        )}
      </div>

      <div className="border-b border-white/[0.06] p-1.5">
        <MenuItem icon={MessageSquare} label="New thread" onClick={() => openNewChat('thread')} />
        {canCreateTask && (
          <MenuItem icon={GitBranch} label="New task" onClick={() => openNewChat('task')} />
        )}
        <MenuItem
          icon={Bot}
          label="Start Hermes orchestrator"
          onClick={startOrchestrator}
          busy={busy === 'orchestrator-hermes'}
          disabled={busy !== null}
        />
        <MenuItem
          icon={workspace.alwaysOnOrchestrator ? PinOff : Pin}
          label={
            workspace.alwaysOnOrchestrator
              ? `Always-on: ${workspace.alwaysOnAgent ?? 'hermes'} (click to disable)`
              : 'Keep Hermes always-on'
          }
          onClick={toggleAlwaysOn}
          busy={busy === 'always-on'}
          disabled={busy !== null}
        />
      </div>

      <div className="p-1.5">
        {showPrsEntry && (
          <MenuItem
            icon={GitPullRequest}
            label="Pull requests"
            count={prCount}
            onClick={() => onSubView('prs')}
            trailing={<ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
          />
        )}
        {showBranchesEntry && (
          <MenuItem
            icon={GitBranch}
            label="Stale branches"
            count={branchCount}
            onClick={() => onSubView('branches')}
            trailing={<ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
          />
        )}
        {!workspace.isRemote && (
          <MenuItem icon={FolderOpen} label="Reveal in Finder" onClick={revealFolder} />
        )}
        <MenuItem
          icon={RefreshCw}
          label="Refresh"
          onClick={refresh}
          busy={busy === 'refresh'}
          disabled={busy !== null}
        />
        {canInitializeRepo && (
          <MenuItem
            icon={Wrench}
            label="Initialize repository"
            onClick={initialize}
            busy={busy === 'init'}
            disabled={busy !== null}
          />
        )}
        {workspace.githubRepo && (
          <MenuItem
            icon={GithubIcon}
            label="Open on GitHub"
            onClick={openOnGithub}
          />
        )}
      </div>

      <div className="border-t border-white/[0.06] p-1.5">
        <MenuItem
          icon={Trash}
          label="Remove from Ace"
          onClick={remove}
          busy={busy === 'remove'}
          disabled={busy !== null}
          danger
        />
      </div>
    </div>
  );
}

function MenuSubPanel({
  title, onBack, children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex max-h-[520px] flex-col">
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <span className="ml-1 text-sm font-semibold">{title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return <GithubMark className={className} />;
}

function MenuItem({
  icon: Icon, label, onClick, count, busy, disabled, danger, trailing,
}: {
  icon: (props: { className?: string }) => ReactNode;
  label: string;
  onClick: () => void;
  count?: number;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'glass-item flex w-full items-center gap-2.5 px-2.5 py-1.5 text-[13px] text-left',
        danger
          ? 'text-rose-300 hover:!bg-rose-500/10 hover:!text-rose-200'
          : 'text-foreground/85',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      {busy ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <Icon className={cn('h-3.5 w-3.5', danger ? 'text-rose-300/80' : 'text-muted-foreground')} />
      )}
      <span className="flex-1 truncate">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-white/[0.06] px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      {trailing}
    </button>
  );
}
