import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowUpCircle, ChevronRight, ExternalLink, GitBranch, GitPullRequest, Loader2,
  Minus, Plus, CheckCircle2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { FileIcon } from './FileIcon';
import {
  aceApi,
  type GitScope,
  type GitStatusResult,
} from '../lib/ace-api';
import { parseUnifiedDiff, type DiffLine, type DiffEntry } from '../lib/diff';

const EMPTY_STATUS: GitStatusResult = {
  staged: [],
  unstaged: [],
  totals: { additions: 0, deletions: 0 },
  branch: null,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  githubRepo: null,
};

type BusyKind = 'stage' | 'unstage' | 'commit' | 'push' | 'pr';

export function ChangesPanel({ scope }: { scope: GitScope }) {
  const taskId = 'taskId' in scope ? scope.taskId : null;
  const workspaceId = 'workspaceId' in scope ? scope.workspaceId : null;
  const watcherTaskId = taskId;
  const scopeKey = taskId ? `task:${taskId}` : `ws:${workspaceId}`;
  const gitScope = useMemo(
    () => (taskId ? { taskId } : { workspaceId: workspaceId! }),
    [taskId, workspaceId]
  );

  const [status, setStatus] = useState<GitStatusResult>(EMPTY_STATUS);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffCache, setDiffCache] = useState<Map<string, DiffEntry>>(new Map());

  const diffKey = (path: string, staged: boolean) => `${staged ? 's' : 'u'}:${path}`;

  const toggleExpand = useCallback(
    (path: string, staged: boolean) => {
      const key = diffKey(path, staged);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        next.add(key);
        return next;
      });
      setDiffCache((prev) => {
        if (prev.has(key)) return prev;
        const next = new Map(prev);
        next.set(key, { state: 'loading' });
        void aceApi.git
          .diffFile(gitScope, path, staged)
          .then((result) => {
            setDiffCache((current) => {
              const copy = new Map(current);
              copy.set(key, {
                state: 'loaded',
                diff: result.diff,
                binary: result.binary,
              });
              return copy;
            });
          })
          .catch((err: unknown) => {
            setDiffCache((current) => {
              const copy = new Map(current);
              copy.set(key, {
                state: 'error',
                message: err instanceof Error ? err.message : 'Failed to load diff',
              });
              return copy;
            });
          });
        return next;
      });
    },
    [gitScope]
  );

  const refresh = useCallback(
    async () => {
      try {
        const next = await aceApi.git.status(gitScope);
        setStatus(next);
        setLoadError(null);
        setDiffCache(new Map());
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load changes');
      }
    },
    [gitScope]
  );

  useEffect(
    () => {
      let cancelled = false;
      setInitialLoading(true);
      setStatus(EMPTY_STATUS);
      setActionError(null);
      setSummary('');
      setDescription('');
      setExpanded(new Set());
      setDiffCache(new Map());
      (async () => {
        try {
          const next = await aceApi.git.status(gitScope);
          if (!cancelled) {
            setStatus(next);
            setInitialLoading(false);
          }
        } catch (err) {
          if (!cancelled) {
            setLoadError(err instanceof Error ? err.message : 'Failed to load changes');
            setInitialLoading(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [gitScope, scopeKey]
  );

  useEffect(() => {
    if (!watcherTaskId) return;
    return aceApi.core.onGitChanged((payload) => {
      if (payload.taskId !== watcherTaskId) return;
      void refresh();
    });
  }, [watcherTaskId, refresh]);

  const withAction = useCallback(
    async (kind: BusyKind, fn: () => Promise<void>) => {
      setBusy(kind);
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Operation failed');
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const stageFile = (path: string) =>
    withAction('stage', async () => { await aceApi.git.stage(scope, [path]); });
  const unstageFile = (path: string) =>
    withAction('unstage', async () => { await aceApi.git.unstage(scope, [path]); });
  const stageAll = () =>
    withAction('stage', async () => { await aceApi.git.stageAll(scope); });
  const unstageAll = () =>
    withAction('unstage', async () => { await aceApi.git.unstageAll(scope); });
  const push = () =>
    withAction('push', async () => { await aceApi.git.push(scope); });
  const createPR = () =>
    withAction('pr', async () => {
      const result = await aceApi.git.createPR(scope);
      if (result.url) void aceApi.workspaces.openExternal(result.url);
    });

  const stagedCount = status.staged.length;
  const unstagedCount = status.unstaged.length;
  const canCommit = stagedCount > 0 && summary.trim().length > 0 && busy === null;

  const commit = () => {
    if (!canCommit) return;
    const trimmedSummary = summary.trim();
    const trimmedDescription = description.trim();
    const message = trimmedDescription
      ? `${trimmedSummary}\n\n${trimmedDescription}`
      : trimmedSummary;
    void withAction('commit', async () => {
      await aceApi.git.commit(scope, message);
      setSummary('');
      setDescription('');
    });
  };

  const handleCommitKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
      e.preventDefault();
      commit();
    }
  };

  if (initialLoading) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-xs text-muted-foreground/70">Loading…</p>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6">
        <p className="text-center text-xs font-medium text-rose-300/80">Unable to load</p>
        <p className="text-center text-[10px] text-muted-foreground/60">{loadError}</p>
      </div>
    );
  }

  const branchLabel = status.branch ?? '—';
  const commitLabel =
    stagedCount > 0 && status.branch
      ? `Commit ${stagedCount} to ${status.branch}`
      : status.branch
        ? `Commit to ${status.branch}`
        : 'Commit';
  const commitTooltip = !stagedCount
    ? 'Stage changes first'
    : !summary.trim()
      ? 'Enter a commit message'
      : 'Commit (⌘⏎)';

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2">
        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
          {branchLabel}
        </span>
        {status.hasUpstream && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
            {status.ahead > 0 && <span className="text-emerald-300/90">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="text-amber-300/90">↓{status.behind}</span>}
          </span>
        )}
        {status.githubRepo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() =>
                  void aceApi.workspaces.openExternal(
                    status.branch
                      ? `https://github.com/${status.githubRepo}/tree/${encodeURIComponent(status.branch)}`
                      : `https://github.com/${status.githubRepo}`
                  )
                }
                aria-label="Open on GitHub"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">Open on GitHub</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-0.5">
        {stagedCount === 0 && unstagedCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
            <CheckCircle2 className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-center text-[11px] text-muted-foreground/80">
              Working tree clean.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 pb-2">
            {[
              {
                title: 'Staged',
                files: status.staged,
                staged: true,
                expanded: stagedOpen,
                onToggle: () => setStagedOpen((v) => !v),
                bulkLabel: 'Unstage all',
                bulkBusy: busy === 'unstage',
                bulkIcon: <Minus className="h-3 w-3" />,
                bulkAction: unstageAll,
                fileLabel: 'Unstage',
                fileIcon: <Minus className="h-3 w-3" />,
                fileAction: unstageFile,
              },
              {
                title: 'Changes',
                files: status.unstaged,
                staged: false,
                expanded: changesOpen,
                onToggle: () => setChangesOpen((v) => !v),
                bulkLabel: 'Stage all',
                bulkBusy: busy === 'stage',
                bulkIcon: <Plus className="h-3 w-3" />,
                bulkAction: stageAll,
                fileLabel: 'Stage',
                fileIcon: <Plus className="h-3 w-3" />,
                fileAction: stageFile,
              },
            ].map((section) => section.files.length > 0 && (
              <CategorySection
                key={section.title}
                title={section.title}
                count={section.files.length}
                expanded={section.expanded}
                onToggle={section.onToggle}
                bulk={{
                  label: section.bulkLabel,
                  icon: section.bulkIcon,
                  busy: section.bulkBusy,
                  onClick: section.bulkAction,
                }}
              >
                {section.files.map((file) => {
                  const key = diffKey(file.path, section.staged);
                  return (
                    <DiffFileRow
                      key={key}
                      path={file.path}
                      additions={file.additions}
                      deletions={file.deletions}
                      isOpen={expanded.has(key)}
                      onToggle={() => toggleExpand(file.path, section.staged)}
                      diff={diffCache.get(key)}
                      action={{
                        icon: section.fileIcon,
                        label: section.fileLabel,
                        onClick: () => section.fileAction(file.path),
                        disabled: busy !== null,
                      }}
                    />
                  );
                })}
              </CategorySection>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] px-2 pb-2 pt-2">
        {actionError && (
          <div className="mb-2 rounded-md border border-rose-500/20 bg-rose-500/[0.04] px-2 py-1 text-[10px] text-rose-300/85">
            {actionError}
          </div>
        )}
        <input
          type="text"
          placeholder="Commit message"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={handleCommitKeyDown}
          disabled={busy !== null}
          className="w-full rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 transition-colors hover:bg-white/[0.03] focus:border-white/[0.10] focus:bg-white/[0.04] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={handleCommitKeyDown}
          rows={2}
          disabled={busy !== null}
          className="mt-1.5 w-full resize-none rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 transition-colors hover:bg-white/[0.03] focus:border-white/[0.10] focus:bg-white/[0.04] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="mt-1.5 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                onClick={commit}
                disabled={!canCommit}
                className="h-7 min-w-0 flex-1 gap-1.5 px-3 text-[11px] font-semibold"
              >
                {busy === 'commit' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span className="truncate">{commitLabel}</span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10px]">{commitTooltip}</TooltipContent>
          </Tooltip>
          <IconBtn
            onClick={push}
            busy={busy === 'push'}
            disabled={busy !== null}
            label={
              status.ahead > 0
                ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'}`
                : 'Push'
            }
          >
            <ArrowUpCircle className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn
            onClick={createPR}
            busy={busy === 'pr'}
            disabled={busy !== null}
            label="Create pull request"
          >
            <GitPullRequest className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  title,
  count,
  expanded,
  onToggle,
  bulk,
  children,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  bulk: {
    label: string;
    icon: ReactNode;
    busy: boolean;
    onClick: () => void;
  };
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90'
            )}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
            {title}
          </span>
          <span className="text-[10px] font-medium text-muted-foreground/60">{count}</span>
        </button>
        <div className="pr-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={bulk.onClick}
                disabled={bulk.busy}
                aria-label={bulk.label}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bulk.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : bulk.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[10px]">{bulk.label}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {expanded && <div className="flex flex-col pl-1">{children}</div>}
    </div>
  );
}

export function DiffFileRow({
  path,
  oldPath,
  binary,
  additions,
  deletions,
  isOpen,
  onToggle,
  diff,
  action,
  githubUrl,
}: {
  path: string;
  oldPath?: string | null;
  binary?: boolean;
  additions: number;
  deletions: number;
  isOpen: boolean;
  onToggle: () => void;
  diff: DiffEntry | undefined;
  action?: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    disabled: boolean;
  };
  githubUrl?: string | null;
}) {
  const filename = basename(path);
  const parent = path.slice(0, path.length - filename.length - 1);
  const hasStats = !binary && (additions > 0 || deletions > 0);
  const titleAttr = oldPath ? `${oldPath} → ${path}` : path;

  return (
    <div className="min-w-0">
      <div
        className={cn(
          'group flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 transition-colors',
          isOpen ? 'bg-white/[0.05]' : 'hover:bg-white/[0.04]'
        )}
        title={titleAttr}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-label={isOpen ? `Collapse ${path}` : `Expand ${path}`}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform duration-150',
              isOpen && 'rotate-90'
            )}
          />
        </button>
        <FileIcon path={path} className="h-3.5 w-3.5 shrink-0" />
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span className="truncate text-xs text-foreground/90">
            {oldPath ? (
              <>
                <span className="text-muted-foreground/60">{basename(oldPath)} → </span>
                {filename}
              </>
            ) : (
              filename
            )}
          </span>
          {parent && (
            <span className="shrink truncate text-[10px] text-muted-foreground/50">
              {parent}
            </span>
          )}
        </button>
        {hasStats && (
          <span className="shrink-0 font-mono text-[10px] opacity-70">
            {additions > 0 && (
              <span className="text-emerald-400">+{additions}</span>
            )}
            {additions > 0 && deletions > 0 && <span> </span>}
            {deletions > 0 && <span className="text-rose-400">−{deletions}</span>}
          </span>
        )}
        {binary && (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">binary</span>
        )}
        {githubUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void aceApi.workspaces.openExternal(githubUrl);
                }}
                aria-label="Open file on GitHub"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-white/[0.06] hover:text-foreground group-hover:opacity-100"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-[10px]">Open on GitHub</TooltipContent>
          </Tooltip>
        )}
        {action && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            disabled={action.disabled}
            aria-label={`${action.label} ${path}`}
            title={action.label}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-white/[0.06] hover:text-foreground group-hover:opacity-100 disabled:cursor-not-allowed"
          >
            {action.icon}
          </button>
        )}
      </div>
      {isOpen && <DiffView diff={diff} filePath={path} />}
    </div>
  );
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function DiffView({ diff, filePath }: { diff: DiffEntry | undefined; filePath: string }) {
  if (!diff || diff.state === 'loading') {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 px-2 py-1 text-[10px] text-muted-foreground/70">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading diff…
      </div>
    );
  }
  if (diff.state === 'error') {
    return (
      <div className="mt-0.5 px-2 py-1 text-[10px] text-rose-300/85">
        {diff.message}
      </div>
    );
  }
  if (diff.binary) {
    return (
      <div className="mt-0.5 px-2 py-1 text-[10px] italic text-muted-foreground">
        Binary file — diff not shown.
      </div>
    );
  }
  const hunks = parseUnifiedDiff(diff.diff);
  if (hunks.length === 0) {
    return (
      <div className="mt-0.5 px-2 py-1 text-[10px] italic text-muted-foreground">
        No changes to show.
      </div>
    );
  }
  return (
    <div className="mt-0.5 max-h-[480px] overflow-auto font-mono text-[11px] leading-[1.45]">
      {hunks.map((hunk, idx) => {
        const prev = hunks[idx - 1];
        const skipped = prev
          ? hunk.newStart - (prev.newStart + prev.newCount)
          : 0;
        return (
          <div key={`${filePath}:${idx}`}>
            {skipped > 0 && <UnchangedDivider count={skipped} />}
            {hunk.lines.map((line, lineIdx) => (
              <DiffLineRow key={`${idx}:${lineIdx}`} line={line} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function UnchangedDivider({ count }: { count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-0.5 text-[10px] text-muted-foreground/50">
      <span className="h-px flex-1 bg-white/[0.06]" aria-hidden="true" />
      <span>{count} unchanged {count === 1 ? 'line' : 'lines'}</span>
      <span className="h-px flex-1 bg-white/[0.06]" aria-hidden="true" />
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === 'meta') {
    return (
      <div className="px-2 py-0.5 text-[10px] italic text-muted-foreground/60">
        {line.text}
      </div>
    );
  }
  const isAdd = line.kind === 'add';
  const isDel = line.kind === 'del';
  const rowClass = isAdd
    ? 'bg-emerald-500/[0.08] text-emerald-100/90 border-l-2 border-emerald-400/60'
    : isDel
      ? 'bg-rose-500/[0.08] text-rose-100/90 border-l-2 border-rose-400/60'
      : 'border-l-2 border-transparent text-foreground/75';
  const lineNo = line.newLineNo ?? line.oldLineNo;
  return (
    <div className={cn('flex min-w-0 items-start', rowClass)}>
      <span className="w-8 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/40">
        {lineNo ?? ''}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">
        {line.text.length > 0 ? line.text : '\u00A0'}
      </span>
    </div>
  );
}

function IconBtn({
  onClick,
  disabled,
  busy,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.02] text-muted-foreground transition-colors',
            !disabled && 'hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-foreground',
            disabled && 'cursor-not-allowed opacity-40'
          )}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px]">{label}</TooltipContent>
    </Tooltip>
  );
}
