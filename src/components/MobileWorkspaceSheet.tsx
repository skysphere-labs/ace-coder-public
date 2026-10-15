import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, ChevronRight, FolderGit2, FolderOpen, GitBranch,
  GitPullRequest, MessageSquare, RefreshCw, Trash, Wrench,
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
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useBodyScrollLock } from '../runtime/use-body-scroll-lock';
import type { Workspace } from '../lib/types';

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.07c-3.2.69-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.52-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.17.92-.26 1.9-.39 2.88-.39s1.96.13 2.88.39c2.2-1.48 3.16-1.17 3.16-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

type SubView = 'root' | 'prs' | 'branches';

export function MobileWorkspaceSheet({
  workspace, onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [subView, setSubView] = useState<SubView>('root');

  // Handle the hardware/system back button: pop sub-view first, then close.
  useMobileBackHandler(true, () => {
    if (subView !== 'root') setSubView('root');
    else onClose();
  });
  useBodyScrollLock();

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <motion.div
        key="ws-sheet-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        onClick={onClose}
        className="fixed inset-0 z-[89] bg-black/35"
      />
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
      className="mobile-drawer-surface inset-0 z-[90] flex flex-col text-foreground shadow-[-12px_0_40px_hsl(0_0%_0%/0.45)]"
      style={{
        position: 'fixed',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => (subView === 'root' ? onClose() : setSubView('root'))}
          aria-label={subView === 'root' ? 'Close' : 'Back'}
          className="mobile-header-pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors active:text-foreground"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
          {subView === 'root'
            ? workspace.name
            : subView === 'prs'
              ? 'Pull requests'
              : 'Stale branches'}
        </h1>
        <div className="w-11 shrink-0" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {subView === 'root' && (
          <SheetRoot
            workspace={workspace}
            onClose={onClose}
            onSubView={setSubView}
          />
        )}
        {subView === 'prs' && workspace.openPrs && (
          <div className="pt-2">
            <PullRequestQueue prs={workspace.openPrs} />
          </div>
        )}
        {subView === 'branches' && (
          <div className="pt-2">
            <BranchCleanupPanel
              workspaceId={workspace.id}
              branches={workspace.cleanupBranches ?? []}
            />
          </div>
        )}
      </div>
    </motion.div>
    </>,
    document.body
  );
}

function SheetRoot({
  workspace, onClose, onSubView,
}: {
  workspace: Workspace;
  onClose: () => void;
  onSubView: (v: SubView) => void;
}) {
  const { openWorkspace, setView, setPendingChatKind } = useApp();
  const [busy, setBusy] = useState<'init' | 'refresh' | 'remove' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState(workspace.defaultBranch ?? '');

  // Action handlers hit desktop-only IPC that rejects on the remote/mobile
  // client; without a catch an unhandled rejection used to tear down the whole
  // app. Surface the failure inline and keep the sheet alive instead.
  const runAction = (
    key: 'init' | 'refresh' | 'remove',
    fn: () => Promise<unknown>,
    onDone?: () => void
  ) => {
    setActionError(null);
    setBusy(key);
    fn()
      .then(() => onDone?.())
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'That action failed. Try again.');
      })
      .finally(() => setBusy(null));
  };

  const isInitialized = workspace.isInitialized !== false;
  const canCreateTask = isInitialized;
  const canInitializeRepo = !isInitialized;
  const prCount = workspace.openPrs?.length ?? 0;
  const branchCount = workspace.cleanupBranches?.length ?? 0;
  const showPrsEntry = canCreateTask && !workspace.isRemote && !!workspace.openPrs;
  const showBranchesEntry = canCreateTask;

  const selectedBaseBranch = baseBranch || workspace.defaultBranch;

  const openNewChat = (preset: 'thread' | 'task') => {
    setPendingChatKind(preset);
    openWorkspace(workspace.id, 'new-chat');
    onClose();
  };

  const revealFolder = () => {
    if (!workspace.path) return;
    setActionError(null);
    Promise.resolve(aceApi.workspaces.openFolder(workspace.path)).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Could not reveal the folder.');
    });
  };

  const refresh = () => runAction('refresh', () => refreshWorkspaceRecord(workspace.id));

  const initialize = () => runAction('init', () => initializeWorkspaceRepository(workspace.id));

  const openOnGithub = () => {
    if (!workspace.githubRepo) return;
    setActionError(null);
    Promise.resolve(
      aceApi.workspaces.openExternal(`https://github.com/${workspace.githubRepo}`)
    ).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Could not open GitHub.');
    });
  };

  const remove = () => {
    if (!window.confirm(`Remove workspace "${workspace.name}" from Ace?`)) return;
    runAction('remove', () => removeWorkspaceRecord(workspace.id), () => {
      onClose();
      setView('today');
    });
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Identity card */}
      <div className="mobile-glass-card flex items-start gap-3 rounded-2xl p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04]">
          <FolderGit2 className="h-4 w-4 text-foreground/80" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight">{workspace.name}</p>
          {workspace.githubRepo && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <GithubMark className="h-3 w-3 shrink-0" />
              <span className="truncate">{workspace.githubRepo}</span>
            </p>
          )}
          {workspace.path && (
            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70">
              {workspace.path}
            </p>
          )}
        </div>
      </div>

      {/* Base branch */}
      {canCreateTask && (
        <Section label="Base branch">
          <div className="flex items-center justify-between rounded-xl bg-white/[0.02] px-3 py-2.5">
            <span className="text-[11px] text-muted-foreground">Default for new tasks</span>
            <WorkspaceBranchPicker
              baseBranch={selectedBaseBranch}
              branchOptions={workspace.branches ?? []}
              onBaseBranchChange={setBaseBranch}
            />
          </div>
        </Section>
      )}

      {/* Quick create */}
      <Section label="Create">
        <div className="grid grid-cols-2 gap-2">
          <CreateCard
            icon={MessageSquare}
            label="New thread"
            hint="Direct chat"
            onClick={() => openNewChat('thread')}
          />
          {canCreateTask && (
            <CreateCard
              icon={GitBranch}
              label="New task"
              hint="Branch + worktree"
              onClick={() => openNewChat('task')}
            />
          )}
        </div>
      </Section>

      {/* Integrations */}
      {(showPrsEntry || showBranchesEntry) && (
        <Section label="GitHub">
          <div className="flex flex-col gap-1">
            {showPrsEntry && (
              <RowLink
                icon={GitPullRequest}
                label="Pull requests"
                count={prCount}
                onClick={() => onSubView('prs')}
              />
            )}
            {showBranchesEntry && (
              <RowLink
                icon={GitBranch}
                label="Stale branches"
                count={branchCount}
                onClick={() => onSubView('branches')}
              />
            )}
          </div>
        </Section>
      )}

      {/* Actions */}
      <Section label="Actions">
        <div className="flex flex-col gap-1">
          {!workspace.isRemote && (
            <RowAction icon={FolderOpen} label="Reveal in Finder" onClick={revealFolder} />
          )}
          <RowAction
            icon={RefreshCw}
            label="Refresh"
            onClick={refresh}
            busy={busy === 'refresh'}
            disabled={busy !== null}
          />
          {canInitializeRepo && (
            <RowAction
              icon={Wrench}
              label="Initialize repository"
              onClick={initialize}
              busy={busy === 'init'}
              disabled={busy !== null}
            />
          )}
          {workspace.githubRepo && (
            <RowAction icon={GithubMark} label="Open on GitHub" onClick={openOnGithub} />
          )}
        </div>
      </Section>

      {actionError && (
        <p className="rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-rose-200/90">
          {actionError}
        </p>
      )}

      {/* Destructive */}
      <Section label="Danger zone">
        <RowAction
          icon={Trash}
          label="Remove from Ace"
          onClick={remove}
          busy={busy === 'remove'}
          disabled={busy !== null}
          danger
        />
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/35">
        {label}
      </h2>
      {children}
    </section>
  );
}

function CreateCard({
  icon: Icon, label, hint, onClick,
}: {
  icon: (props: { className?: string }) => ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mobile-glass-card flex flex-col items-start gap-2 rounded-2xl p-3.5 text-left transition-colors active:bg-white/[0.06]"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04]">
        <Icon className="h-4 w-4 text-foreground/90" />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        <p className="text-[10.5px] text-muted-foreground">{hint}</p>
      </div>
    </button>
  );
}

function RowLink({
  icon: Icon, label, count, onClick,
}: {
  icon: (props: { className?: string }) => ReactNode;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mobile-glass-card flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors active:bg-white/[0.06]"
    >
      <Icon className="h-4 w-4 shrink-0 text-foreground/80" />
      <span className="flex-1 truncate text-[13px] font-medium text-foreground">{label}</span>
      {count > 0 && (
        <span className="inline-flex h-[20px] min-w-[22px] items-center justify-center rounded-full bg-white/[0.06] px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

function RowAction({
  icon: Icon, label, onClick, busy, disabled, danger,
}: {
  icon: (props: { className?: string }) => ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'mobile-glass-card flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors active:bg-white/[0.06]',
        danger && 'active:bg-rose-500/10',
        disabled && 'opacity-50'
      )}
    >
      {busy ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <Icon
          className={cn('h-4 w-4 shrink-0', danger ? 'text-rose-300' : 'text-foreground/80')}
        />
      )}
      <span
        className={cn(
          'flex-1 truncate text-[13px] font-medium',
          danger ? 'text-rose-200' : 'text-foreground'
        )}
      >
        {label}
      </span>
    </button>
  );
}
