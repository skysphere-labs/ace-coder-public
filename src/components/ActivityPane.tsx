import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaseSensitive, ChevronDown, ChevronRight, Copy, ExternalLink, GitBranch,
  MoreHorizontal, PencilLine, Regex, RefreshCcw, Rewind, Search,
  Undo2, WholeWord, X,
} from 'lucide-react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  cn,
  formatBytes,
  formatCompactNumber,
  formatRelativeTime,
} from '../lib/utils';
import { useApp } from '../store';
import {
  aceApi,
  type ContentSearchMatch,
  type FileSearchScope,
  type FsEntry,
  type GitCommit as GitCommitRecord,
  type GitCommitDetail,
  type GitCommitFileChange,
  type GitScope,
  type GitStatusResult,
} from '../lib/ace-api';
import { FileIcon, FolderIcon } from './FileIcon';
import { ChangesPanel, DiffFileRow } from './ChangesPanel';
import { ActivityStatsPopoverContent } from './ActivityStatsPopover';
import type { WorkspaceStatsDetail } from '../lib/ace-api';
import { type DiffEntry } from '../lib/diff';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { FileContextMenu, type ContextMenuItem } from './FileContextMenu';
import { PromptDialog, type PromptRequest } from './PromptDialog';
// Lazy: TerminalPanel statically pulls the whole xterm stack (~580KB). It only
// renders when the inline terminal is toggled on, and ActivityPane is reused by
// the mobile activity drawer — a static import would drag xterm into the mobile
// boot bundle. Deferring it keeps xterm off the startup path entirely.
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
);
import { openFile as openEditorFile } from '../runtime/editor-registry';
import { deactivateTerminalTab } from '../runtime/terminal-mode';
import { deactivateScratchTabs } from '../runtime/scratch-tabs-registry';
import { getTaskStreamId, writeTerminalInput } from '../runtime/terminal-io';
import { useTerminalState } from '../runtime/terminal-mode';
import { pushUndo, undo as undoLastDelete, useUndoEntries } from '../runtime/undo-registry';

type FileScope =
  | { kind: 'task'; taskId: string; cwd: string | null }
  | { kind: 'workspace'; workspaceId: string; cwd: string | null };

type FsAdapter = {
  list: (relativePath: string) => Promise<{ entries: FsEntry[] }>;
  read: (relativePath: string) => Promise<{ content: string }>;
  createFile: (relativePath: string) => Promise<{ ok: boolean }>;
  createFolder: (relativePath: string) => Promise<{ ok: boolean }>;
  rename: (relativePath: string, newName: string) => Promise<{ ok: boolean }>;
  delete: (relativePath: string) => Promise<{ ok: boolean }>;
  reveal: (relativePath: string) => Promise<{ ok: boolean }>;
  scope: FileSearchScope;
};

function buildFsAdapter(kind: FileScope['kind'], id: string): FsAdapter {
  const deleteWithUndo = async (
    rel: string,
    call: () => Promise<{ ok: boolean; trashPath?: string | null; originalPath?: string }>
  ): Promise<{ ok: boolean }> => {
    const result = await call();
    if (result.ok && result.trashPath && result.originalPath) {
      pushUndo({
        kind: 'file-delete',
        scope: kind === 'task' ? { kind: 'task', id } : { kind: 'workspace', id },
        trashPath: result.trashPath,
        originalPath: result.originalPath,
        relativePath: rel,
        label: rel.split(/[\\/]/).pop() || rel,
      });
    }
    return { ok: result.ok };
  };
  if (kind === 'task') {
    return {
      list: (rel) => aceApi.fs.listTaskFiles(id, rel),
      read: (rel) => aceApi.fs.readTaskFile(id, rel),
      createFile: (rel) => aceApi.fs.createTaskFile(id, rel),
      createFolder: (rel) => aceApi.fs.createTaskFolder(id, rel),
      rename: (rel, newName) => aceApi.fs.renameTaskPath(id, rel, newName),
      delete: (rel) => deleteWithUndo(rel, () => aceApi.fs.deleteTaskPath(id, rel)),
      reveal: (rel) => aceApi.fs.revealTaskPath(id, rel),
      scope: { taskId: id },
    };
  }
  return {
    list: (rel) => aceApi.fs.listWorkspaceFiles(id, rel),
    read: (rel) => aceApi.fs.readWorkspaceFile(id, rel),
    createFile: (rel) => aceApi.fs.createWorkspaceFile(id, rel),
    createFolder: (rel) => aceApi.fs.createWorkspaceFolder(id, rel),
    rename: (rel, newName) => aceApi.fs.renameWorkspacePath(id, rel, newName),
    delete: (rel) => deleteWithUndo(rel, () => aceApi.fs.deleteWorkspacePath(id, rel)),
    reveal: (rel) => aceApi.fs.revealWorkspacePath(id, rel),
    scope: { workspaceId: id },
  };
}

type TabId = 'files' | 'changes' | 'history';

const TABS: { id: TabId; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
];

export function ActivityPane() {
  const { activeTask, activeWorkspace } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>('files');
  const { open: termOpen, mode: termMode } = useTerminalState(activeTask?.id ?? null);
  const showTerminalHere = termOpen && termMode === 'right' && !!activeTask;
  const [termHeight, setTermHeight] = useState(260);
  const dragStart = useRef<{ y: number; h: number } | null>(null);

  const taskCwd =
    activeTask?.worktrees?.[0]?.path ?? activeWorkspace?.path ?? null;

  const onDragHandle = (e: React.MouseEvent) => {
    dragStart.current = { y: e.clientY, h: termHeight };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (m: MouseEvent) => {
      if (!dragStart.current) return;
      const dy = dragStart.current.y - m.clientY;
      setTermHeight(Math.max(140, Math.min(640, dragStart.current.h + dy)));
    };
    const onUp = () => {
      dragStart.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <aside className="relative z-[45] flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-center px-3 pb-2 pt-3">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-[hsl(0_0%_100%/0.04)] p-0.5 shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.04)]">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const showTotals =
              tab.id === 'changes' &&
              activeTask &&
              ((activeTask.additions ?? 0) > 0 || (activeTask.deletions ?? 0) > 0);
            const disabled = false;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => !disabled && setActiveTab(tab.id)}
                disabled={disabled}
                title={
                  disabled
                    ? 'Context is only available for Ace Chat conversations.'
                    : undefined
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[hsl(var(--ace-surface-2))] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--ace-line)/var(--ace-line-strong-a))]'
                    : 'text-muted-foreground hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
                )}
              >
                {tab.label}
                {showTotals && (
                  <span className="flex items-center gap-1 tabular-nums">
                    {(activeTask.additions ?? 0) > 0 && (
                      <span className="text-[10px] font-semibold text-emerald-400/90">
                        +{activeTask.additions}
                      </span>
                    )}
                    {(activeTask.deletions ?? 0) > 0 && (
                      <span className="text-[10px] font-semibold text-rose-400/90">
                        −{activeTask.deletions}
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTask ? (
            activeTab === 'files' ? (
              <FilesPanel
                key={`task-${activeTask.id}`}
                scope={{ kind: 'task', taskId: activeTask.id, cwd: taskCwd }}
              />
            ) : activeTab === 'changes' ? (
              <ChangesPanel key={activeTask.id} scope={{ taskId: activeTask.id }} />
            ) : (
              <HistoryPanel
                key={activeTask.id}
                scope={{ taskId: activeTask.id }}
                onOpenChanges={() => setActiveTab('changes')}
              />
            )
          ) : activeWorkspace ? (
            activeTab === 'files' ? (
              <FilesPanel
                key={`workspace-${activeWorkspace.id}`}
                scope={{ kind: 'workspace', workspaceId: activeWorkspace.id, cwd: activeWorkspace.path }}
              />
            ) : activeTab === 'changes' ? (
              <ChangesPanel
                key={`ws-${activeWorkspace.id}`}
                scope={{ workspaceId: activeWorkspace.id }}
              />
            ) : (
              <HistoryPanel
                key={`ws-${activeWorkspace.id}`}
                scope={{ workspaceId: activeWorkspace.id }}
                onOpenChanges={() => setActiveTab('changes')}
              />
            )
          ) : (
            <EmptyState message="Select a task or thread to inspect its worktree." />
          )}
        </div>
        {showTerminalHere && activeTask && (
          <div className="mt-1 flex shrink-0 flex-col px-1 pb-1">
            <div
              onMouseDown={onDragHandle}
              className="group relative mx-auto flex h-3 w-full items-center justify-center shrink-0 cursor-row-resize"
            >
              <span className="block h-[3px] w-10 rounded-full bg-white/[0.08] transition-colors group-hover:bg-white/25" />
              <div className="absolute inset-x-0 -top-1 -bottom-1" />
            </div>
            <div className="shrink-0" style={{ height: termHeight }}>
              <Suspense fallback={<div className="h-full" />}>
                <TerminalPanel workItemId={activeTask.id} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function isMarkdownPath(p: string) {
  const base = p.split('/').pop() ?? p;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
}

async function writeToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {}
}

function formatFileCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${Math.round(n / 1000)}K`;
}

function StatsBar({
  stats,
  loading,
  onRefresh,
  statsScope,
  refreshKey,
}: {
  stats: { files: number; bytes: number; loc: number; remote?: boolean } | null;
  loading: boolean;
  onRefresh: () => void;
  statsScope: { kind: 'task' | 'workspace'; id: string };
  refreshKey: number;
}) {
  const content = stats?.remote
    ? 'Remote — stats unavailable'
    : stats
      ? `${formatFileCount(stats.files)} files · ${formatBytes(stats.bytes)} · ${formatCompactNumber(stats.loc)} lines`
      : loading
        ? 'Computing stats…'
        : '—';

  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<WorkspaceStatsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const loadedKeyRef = useRef<number | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const interactive = !!stats && !stats.remote;

  useEffect(() => {
    loadedKeyRef.current = null;
  }, [refreshKey]);

  useEffect(
    () => () => {
      cancelRef.current?.();
    },
    []
  );

  const handleOpenChange = (next: boolean) => {
    if (!interactive) return;
    setOpen(next);
    if (!next) return;
    if (loadedKeyRef.current === refreshKey) return;
    cancelRef.current?.();
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };
    setDetailLoading(true);
    setDetailError(null);
    aceApi.workspaces
      .getStatsDetail(statsScope)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        loadedKeyRef.current = refreshKey;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDetailError(err instanceof Error ? err.message : 'Failed to load breakdown');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
  };

  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-b border-white/[0.04] px-3 text-[10.5px] tabular-nums text-muted-foreground/70">
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={!interactive}
            className={cn(
              'truncate rounded px-1 -mx-1 text-left transition-colors',
              interactive
                ? 'cursor-pointer hover:bg-white/[0.04] hover:text-foreground/90'
                : 'cursor-default',
              open && 'bg-white/[0.05] text-foreground/90'
            )}
            title={interactive ? 'Show file breakdown' : content}
          >
            {content}
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="glass-surface z-[120] w-[340px] rounded-xl p-0 text-foreground animate-in fade-in-0 zoom-in-95"
          >
            <ActivityStatsPopoverContent
              detail={detail}
              loading={detailLoading}
              error={detailError}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Recompute stats"
        aria-label="Recompute stats"
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-white/[0.04] hover:text-foreground/80',
          loading && 'animate-spin'
        )}
      >
        <RefreshCcw className="h-3 w-3" />
      </button>
    </div>
  );
}

function flattenVisible(
  entries: FsEntry[],
  expanded: Set<string>,
  childrenMap: Map<string, FsEntry[]>
): FsEntry[] {
  const out: FsEntry[] = [];
  const visit = (list: FsEntry[]) => {
    for (const entry of list) {
      out.push(entry);
      if (entry.kind === 'dir' && expanded.has(entry.relativePath)) {
        const kids = childrenMap.get(entry.relativePath);
        if (kids) visit(kids);
      }
    }
  };
  visit(entries);
  return out;
}

type SearchMode = 'files' | 'text';

function FilesPanel({ scope }: { scope: FileScope }) {
  const taskId = scope.kind === 'task' ? scope.taskId : null;
  const scopeId = scope.kind === 'task' ? scope.taskId : scope.workspaceId;
  const cwd = scope.cwd;
  const fs = useMemo(() => buildFsAdapter(scope.kind, scopeId), [scope.kind, scopeId]);
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [childrenMap, setChildrenMap] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('files');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [stats, setStats] = useState<{ files: number; bytes: number; loc: number; remote?: boolean } | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);
  const [contentMatches, setContentMatches] = useState<ContentSearchMatch[]>([]);
  const [contentTruncated, setContentTruncated] = useState(false);
  const [contentSearching, setContentSearching] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(searchQuery);
  const hasQuery = searchQuery.trim().length > 0;

  const loadDir = useCallback(
    async (relativePath: string) => {
      const result = await fs.list(relativePath);
      return result.entries;
    },
    [fs]
  );

  const reloadFolder = useCallback(
    async (relativePath: string) => {
      try {
        const entries = await loadDir(relativePath);
        if (relativePath === '') {
          setRootEntries(entries);
        } else {
          setChildrenMap((prev) => {
            const next = new Map(prev);
            next.set(relativePath, entries);
            return next;
          });
        }
      } catch {}
    },
    [loadDir]
  );

  const reloadRoot = useCallback(() => {
    void reloadFolder('');
  }, [reloadFolder]);

  const expandFolder = useCallback(
    async (relativePath: string) => {
      if (!relativePath) return;
      setExpanded((prev) => {
        if (prev.has(relativePath)) return prev;
        const next = new Set(prev);
        next.add(relativePath);
        return next;
      });
      if (!childrenMap.has(relativePath)) {
        try {
          const entries = await loadDir(relativePath);
          setChildrenMap((prev) => {
            const next = new Map(prev);
            next.set(relativePath, entries);
            return next;
          });
        } catch {}
      }
    },
    [childrenMap, loadDir]
  );

  useEffect(() => {
    let cancelled = false;
    setRootEntries(null);
    setLoadError(null);
    setChildrenMap(new Map());
    setExpanded(new Set());
    setSelected(new Set());
    setAnchor(null);
    loadDir('')
      .then((entries) => {
        if (!cancelled) setRootEntries(entries);
      })
      .catch((err) => {
        if (!cancelled) {
          setRootEntries([]);
          setLoadError(err instanceof Error ? err.message : 'Failed to list files');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, loadDir]);

  useEffect(() => {
    if (!taskId) return;
    return aceApi.core.onGitChanged(async (payload) => {
      if (payload.taskId !== taskId) return;
      reloadRoot();
      const expandedPaths = Array.from(expanded);
      if (expandedPaths.length === 0) return;
      const results = await Promise.all(
        expandedPaths.map(async (p) => [p, await loadDir(p)] as const)
      );
      setChildrenMap((prev) => {
        const next = new Map(prev);
        for (const [p, entries] of results) next.set(p, entries);
        return next;
      });
    });
  }, [taskId, expanded, loadDir, reloadRoot]);

  const toggle = useCallback(
    async (entry: FsEntry) => {
      if (entry.kind !== 'dir') return;
      const key = entry.relativePath;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (childrenMap.has(key)) return;
      setLoading((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        const entries = await loadDir(key);
        setChildrenMap((prev) => {
          const next = new Map(prev);
          next.set(key, entries);
          return next;
        });
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [childrenMap, loadDir]
  );

  const runAction = useCallback(
    async (fn: () => Promise<void>) => {
      setActionError(null);
      try {
        await fn();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Action failed');
      }
    },
    []
  );

  const visibleFlat = useMemo(
    () => (rootEntries ? flattenVisible(rootEntries, expanded, childrenMap) : []),
    [rootEntries, expanded, childrenMap]
  );

  const toggleSelection = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setAnchor(path);
  }, []);

  const rangeSelect = useCallback(
    (path: string) => {
      if (!anchor) {
        setSelected(new Set([path]));
        setAnchor(path);
        return;
      }
      const aIdx = visibleFlat.findIndex((e) => e.relativePath === anchor);
      const bIdx = visibleFlat.findIndex((e) => e.relativePath === path);
      if (aIdx < 0 || bIdx < 0) {
        setSelected(new Set([path]));
        setAnchor(path);
        return;
      }
      const [start, end] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        next.add(visibleFlat[i].relativePath);
      }
      setSelected(next);
    },
    [anchor, visibleFlat]
  );

  const selectOnly = useCallback((path: string) => {
    setSelected(new Set([path]));
    setAnchor(path);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  const openFile = useCallback(
    (relativePath: string) => {
      if (!taskId) return;
      deactivateTerminalTab(taskId);
      deactivateScratchTabs(taskId);
      openEditorFile(taskId, relativePath);
    },
    [taskId]
  );

  useEffect(() => {
    setAllFiles(null);
    setContentMatches([]);
    setContentTruncated(false);
    setContentError(null);
  }, [scopeId]);

  useEffect(() => {
    if (searchMode !== 'files' || !hasQuery || allFiles !== null) return;
    let cancelled = false;
    aceApi.fs
      .searchFiles(fs.scope)
      .then((res) => {
        if (!cancelled) setAllFiles(res.files || []);
      })
      .catch(() => {
        if (!cancelled) setAllFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fs, searchMode, hasQuery, allFiles]);

  const scopeKind = scope.kind;
  const statsScope = useMemo(
    () =>
      scopeKind === 'task'
        ? ({ kind: 'task' as const, id: scopeId })
        : ({ kind: 'workspace' as const, id: scopeId }),
    [scopeKind, scopeId]
  );
  const refreshStats = useCallback(() => {
    let cancelled = false;
    setStatsLoading(true);
    setStatsRefreshKey((k) => k + 1);
    aceApi.workspaces
      .getStats(statsScope)
      .then((res) => {
        if (!cancelled) setStats(res);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statsScope]);

  useEffect(() => {
    setStats(null);
    return refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    if (!taskId) return;
    return aceApi.core.onGitChanged((payload) => {
      if (payload.taskId !== taskId) return;
      setAllFiles(null);
    });
  }, [taskId]);

  useEffect(() => {
    if (searchMode !== 'text') return;
    const query = deferredQuery.trim();
    if (!query) {
      setContentMatches([]);
      setContentTruncated(false);
      setContentError(null);
      setContentSearching(false);
      return;
    }
    let cancelled = false;
    setContentSearching(true);
    setContentError(null);
    aceApi.fs
      .searchFileContent(fs.scope, {
        query,
        caseSensitive,
        regex: useRegex,
        wholeWord,
        maxResults: 500,
      })
      .then((res) => {
        if (cancelled) return;
        setContentMatches(res.matches || []);
        setContentTruncated(!!res.truncated);
      })
      .catch((err) => {
        if (cancelled) return;
        setContentMatches([]);
        setContentTruncated(false);
        setContentError(err instanceof Error ? err.message : 'Search failed');
      })
      .finally(() => {
        if (!cancelled) setContentSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fs, searchMode, deferredQuery, caseSensitive, useRegex, wholeWord]);

  const filenameResults = useMemo<string[]>(() => {
    if (searchMode !== 'files' || !hasQuery || !allFiles) return [];
    return rankFileMatches(allFiles, deferredQuery.trim(), 200);
  }, [searchMode, hasQuery, allFiles, deferredQuery]);

  const groupedContentMatches = useMemo(() => {
    const map = new Map<string, ContentSearchMatch[]>();
    for (const m of contentMatches) {
      const list = map.get(m.path);
      if (list) list.push(m);
      else map.set(m.path, [m]);
    }
    return Array.from(map.entries());
  }, [contentMatches]);

  const revealInFinder = useCallback(
    (relativePath: string) => {
      void runAction(async () => {
        await fs.reveal(relativePath);
      });
    },
    [fs, runAction]
  );

  const addPathsToChat = useCallback(
    (relativePaths: string[]) => {
      if (!taskId) {
        setActionError('Start a task or thread first to send files to chat');
        return;
      }
      const streamId = getTaskStreamId(taskId);
      if (!streamId) {
        setActionError('No active agent to send file reference to');
        return;
      }
      const text = relativePaths.map((p) => `@${p}`).join(' ') + ' ';
      void writeTerminalInput(streamId, text);
    },
    [taskId]
  );

  const copyPath = useCallback(
    (relativePath: string) => {
      if (!cwd) return;
      const absolute = `${cwd}/${relativePath}`.replace(/\/+/g, '/');
      void writeToClipboard(absolute);
    },
    [cwd]
  );

  const copyRelativePath = useCallback((relativePath: string) => {
    void writeToClipboard(relativePath);
  }, []);

  const copyFile = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === 'dir') {
        void writeToClipboard(entry.name);
        return;
      }
      void runAction(async () => {
        const result = await fs.read(entry.relativePath);
        await writeToClipboard(result.content);
      });
    },
    [fs, runAction]
  );

  const renameEntry = useCallback(
    (entry: FsEntry) => {
      setPrompt({
        title: `Rename ${entry.kind === 'dir' ? 'folder' : 'file'}`,
        defaultValue: entry.name,
        confirmLabel: 'Rename',
        validate: (value) =>
          /[/\\]/.test(value) ? 'Name cannot contain / or \\' : null,
        onConfirm: (next) => {
          if (next === entry.name) return;
          void runAction(async () => {
            await fs.rename(entry.relativePath, next);
            const parent = entry.relativePath.includes('/')
              ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'))
              : '';
            await reloadFolder(parent);
            clearSelection();
          });
        },
      });
    },
    [fs, runAction, reloadFolder, clearSelection]
  );

  const deletePaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const ok = window.confirm(
        paths.length === 1
          ? `Delete "${paths[0].split('/').pop()}"?`
          : `Delete ${paths.length} items?`
      );
      if (!ok) return;
      void runAction(async () => {
        await Promise.all(paths.map((p) => fs.delete(p)));
        const parents = new Set<string>();
        for (const p of paths) {
          parents.add(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
        }
        await Promise.all(Array.from(parents).map((p) => reloadFolder(p)));
        clearSelection();
      });
    },
    [fs, runAction, reloadFolder, clearSelection]
  );

  const createFile = useCallback(
    (parentRelativePath: string) => {
      setPrompt({
        title: 'New file',
        description: parentRelativePath
          ? `Create inside ${parentRelativePath}/`
          : undefined,
        placeholder: 'filename.ext',
        confirmLabel: 'Create',
        validate: (value) =>
          /[/\\]/.test(value) ? 'Use the parent folder via right-click' : null,
        onConfirm: (name) => {
          const target = parentRelativePath
            ? `${parentRelativePath}/${name}`
            : name;
          void runAction(async () => {
            await fs.createFile(target);
            await expandFolder(parentRelativePath);
            await reloadFolder(parentRelativePath);
            if (taskId) openEditorFile(taskId, target);
          });
        },
      });
    },
    [fs, taskId, runAction, reloadFolder, expandFolder]
  );

  const createFolder = useCallback(
    (parentRelativePath: string) => {
      setPrompt({
        title: 'New folder',
        description: parentRelativePath
          ? `Create inside ${parentRelativePath}/`
          : undefined,
        placeholder: 'folder-name',
        confirmLabel: 'Create',
        validate: (value) =>
          /[/\\]/.test(value) ? 'Use the parent folder via right-click' : null,
        onConfirm: (name) => {
          const target = parentRelativePath
            ? `${parentRelativePath}/${name}`
            : name;
          void runAction(async () => {
            await fs.createFolder(target);
            await expandFolder(parentRelativePath);
            await reloadFolder(parentRelativePath);
          });
        },
      });
    },
    [fs, runAction, reloadFolder, expandFolder]
  );

  const singleFileMenu = useCallback(
    (entry: FsEntry): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];
      if (isMarkdownPath(entry.relativePath)) {
        items.push({
          kind: 'item',
          label: 'Open Preview',
          onSelect: () => openFile(entry.relativePath),
        });
      }
      items.push(
        { kind: 'item', label: 'Reveal in Finder', onSelect: () => revealInFinder(entry.relativePath) },
        { kind: 'item', label: 'Add File to Chat', onSelect: () => addPathsToChat([entry.relativePath]) },
        { kind: 'separator' },
        { kind: 'item', label: 'Copy', onSelect: () => copyFile(entry) },
        { kind: 'item', label: 'Copy Path', onSelect: () => copyPath(entry.relativePath) },
        { kind: 'item', label: 'Copy Relative Path', onSelect: () => copyRelativePath(entry.relativePath) },
        { kind: 'separator' },
        { kind: 'item', label: 'Rename', onSelect: () => renameEntry(entry) },
        { kind: 'item', label: 'Delete', danger: true, onSelect: () => deletePaths([entry.relativePath]) }
      );
      return items;
    },
    [openFile, revealInFinder, addPathsToChat, copyFile, copyPath, copyRelativePath, renameEntry, deletePaths]
  );

  const singleFolderMenu = useCallback(
    (entry: FsEntry): ContextMenuItem[] => [
      { kind: 'item', label: 'New File', onSelect: () => createFile(entry.relativePath) },
      { kind: 'item', label: 'New Folder', onSelect: () => createFolder(entry.relativePath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Reveal in Finder', onSelect: () => revealInFinder(entry.relativePath) },
      { kind: 'item', label: 'Add Folder to Chat', onSelect: () => addPathsToChat([entry.relativePath]) },
      { kind: 'separator' },
      { kind: 'item', label: 'Copy', onSelect: () => copyFile(entry) },
      { kind: 'item', label: 'Copy Path', onSelect: () => copyPath(entry.relativePath) },
      { kind: 'item', label: 'Copy Relative Path', onSelect: () => copyRelativePath(entry.relativePath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', onSelect: () => renameEntry(entry) },
      { kind: 'item', label: 'Delete', danger: true, onSelect: () => deletePaths([entry.relativePath]) },
    ],
    [createFile, createFolder, revealInFinder, addPathsToChat, copyFile, copyPath, copyRelativePath, renameEntry, deletePaths]
  );

  const bulkMenu = useCallback(
    (paths: string[]): ContextMenuItem[] => {
      return [
        {
          kind: 'item',
          label: `Add ${paths.length} ${paths.length === 1 ? 'item' : 'items'} to Chat`,
          onSelect: () => addPathsToChat(paths),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: `Delete ${paths.length} ${paths.length === 1 ? 'item' : 'items'}`,
          danger: true,
          onSelect: () => deletePaths(paths),
        },
      ];
    },
    [addPathsToChat, deletePaths]
  );

  const menuFor = useCallback(
    (entry: FsEntry): ContextMenuItem[] => {
      if (selected.size > 1 && selected.has(entry.relativePath)) {
        return bulkMenu(Array.from(selected));
      }
      return entry.kind === 'dir' ? singleFolderMenu(entry) : singleFileMenu(entry);
    },
    [selected, bulkMenu, singleFolderMenu, singleFileMenu]
  );

  const panelMenu = useMemo<ContextMenuItem[]>(
    () => [
      { kind: 'item', label: 'New File', onSelect: () => createFile('') },
      { kind: 'item', label: 'New Folder', onSelect: () => createFolder('') },
    ],
    [createFile, createFolder]
  );

  const handleRowClick = useCallback(
    (entry: FsEntry, e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        toggleSelection(entry.relativePath);
        return;
      }
      if (e.shiftKey) {
        rangeSelect(entry.relativePath);
        return;
      }
      if (entry.kind === 'dir') {
        selectOnly(entry.relativePath);
        void toggle(entry);
        return;
      }
      selectOnly(entry.relativePath);
      openFile(entry.relativePath);
    },
    [toggleSelection, rangeSelect, selectOnly, toggle, openFile]
  );

  const handleRowDragStart = useCallback(
    (entry: FsEntry, e: React.DragEvent<HTMLButtonElement>) => {
      const paths =
        selected.has(entry.relativePath) && selected.size > 1
          ? Array.from(selected)
          : [entry.relativePath];
      const text = paths.map((p) => `@${p}`).join(' ') + ' ';
      try {
        e.dataTransfer.setData('application/x-ace-paths', JSON.stringify(paths));
        e.dataTransfer.setData('text/plain', text);
        e.dataTransfer.effectAllowed = 'copy';
      } catch {}
    },
    [selected]
  );

  const handleRowContextMenu = useCallback(
    (entry: FsEntry) => {
      if (!selected.has(entry.relativePath) || selected.size <= 1) {
        selectOnly(entry.relativePath);
      }
    },
    [selected, selectOnly]
  );

  if (rootEntries === null) {
    return <LoadingState />;
  }
  if (loadError) {
    return <ErrorState message={loadError} />;
  }

  return (
    <div className="flex h-full flex-col">
      <FileSearchBar
        query={searchQuery}
        onQueryChange={setSearchQuery}
        mode={searchMode}
        onModeChange={setSearchMode}
        caseSensitive={caseSensitive}
        onCaseSensitiveChange={setCaseSensitive}
        regex={useRegex}
        onRegexChange={setUseRegex}
        wholeWord={wholeWord}
        onWholeWordChange={setWholeWord}
      />
      {!hasQuery && (
        <StatsBar
          stats={stats}
          loading={statsLoading}
          onRefresh={refreshStats}
          statsScope={statsScope}
          refreshKey={statsRefreshKey}
        />
      )}
      <RestoreChip />
      {actionError && (
        <div
          className="shrink-0 truncate border-b border-red-500/20 bg-red-500/10 px-3 py-1 text-[10px] text-red-300/90"
          title={actionError}
        >
          {actionError}
        </div>
      )}
      {hasQuery ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
          {searchMode === 'files' ? (
            allFiles === null ? (
              <SearchStatus text="Indexing files…" />
            ) : filenameResults.length === 0 ? (
              <SearchStatus text="No files match" />
            ) : (
              <FileResultsList
                results={filenameResults}
                query={deferredQuery.trim()}
                onOpen={openFile}
              />
            )
          ) : contentError ? (
            <SearchStatus text={contentError} tone="error" />
          ) : contentSearching && contentMatches.length === 0 ? (
            <SearchStatus text="Searching…" />
          ) : contentMatches.length === 0 ? (
            <SearchStatus text="No matches" />
          ) : (
            <ContentResultsList
              groups={groupedContentMatches}
              query={deferredQuery.trim()}
              caseSensitive={caseSensitive}
              regex={useRegex}
              truncated={contentTruncated}
              onOpen={openFile}
            />
          )}
        </div>
      ) : (
        <FileContextMenu items={panelMenu}>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-1 pb-3"
            onClick={(e) => {
              if (e.target === e.currentTarget) clearSelection();
            }}
          >
            {rootEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6">
                <p className="text-center text-xs text-muted-foreground">
                  This worktree is empty. Right-click to create a file.
                </p>
              </div>
            ) : (
              <FileTree
                entries={rootEntries}
                depth={0}
                childrenMap={childrenMap}
                expanded={expanded}
                loading={loading}
                selected={selected}
                onRowClick={handleRowClick}
                onRowContextMenu={handleRowContextMenu}
                menuFor={menuFor}
                onRowDragStart={handleRowDragStart}
              />
            )}
          </div>
        </FileContextMenu>
      )}
      <PromptDialog request={prompt} onClose={() => setPrompt(null)} />
    </div>
  );
}

function RestoreChip() {
  const entries = useUndoEntries();
  const last = entries[entries.length - 1];
  if (!last) return null;
  return (
    <div className="shrink-0 border-b border-white/[0.04] px-2 py-1.5">
      <button
        type="button"
        onClick={() => { void undoLastDelete(); }}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-white/[0.10]"
        title={`Restore ${last.label}`}
      >
        <span aria-hidden>↶</span>
        Restore <span className="max-w-[140px] truncate font-mono text-muted-foreground">{last.label}</span>
      </button>
    </div>
  );
}

function FileTree({
  entries, depth, childrenMap, expanded, loading, selected,
  onRowClick, onRowContextMenu, menuFor, onRowDragStart,
}: {
  entries: FsEntry[];
  depth: number;
  childrenMap: Map<string, FsEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  selected: Set<string>;
  onRowClick: (entry: FsEntry, e: React.MouseEvent) => void;
  onRowContextMenu: (entry: FsEntry) => void;
  menuFor: (entry: FsEntry) => ContextMenuItem[];
  onRowDragStart?: (entry: FsEntry, e: React.DragEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex flex-col">
      {entries.map((entry) => {
        const isDir = entry.kind === 'dir';
        const isOpen = expanded.has(entry.relativePath);
        const kids = childrenMap.get(entry.relativePath);
        const isLoading = loading.has(entry.relativePath);
        const isSelected = selected.has(entry.relativePath);
        return (
          <div key={entry.relativePath}>
            <FileContextMenu items={menuFor(entry)}>
              <button
                type="button"
                draggable={!!onRowDragStart}
                onDragStart={onRowDragStart ? (e) => onRowDragStart(entry, e) : undefined}
                onClick={(e) => onRowClick(entry, e)}
                onContextMenu={() => onRowContextMenu(entry)}
                className={cn(
                  'flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors',
                  isSelected
                    ? 'bg-[hsl(0_0%_100%/0.08)] text-foreground'
                    : 'text-foreground/80 hover:bg-[hsl(0_0%_100%/0.04)] hover:text-foreground'
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                {isDir ? (
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-90'
                    )}
                  />
                ) : (
                  <span className="h-3 w-3 shrink-0" />
                )}
                {isDir ? (
                  <FolderIcon
                    path={entry.name}
                    open={isOpen}
                    className="h-4 w-4 shrink-0"
                  />
                ) : (
                  <FileIcon path={entry.name} className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            </FileContextMenu>
            {isDir && isOpen && kids && (
              <FileTree
                entries={kids}
                depth={depth + 1}
                childrenMap={childrenMap}
                expanded={expanded}
                loading={loading}
                selected={selected}
                onRowClick={onRowClick}
                onRowContextMenu={onRowContextMenu}
                menuFor={menuFor}
                onRowDragStart={onRowDragStart}
              />
            )}
            {isDir && isOpen && !kids && isLoading && (
              <div
                className="py-1 text-[10px] text-muted-foreground/60"
                style={{ paddingLeft: 6 + (depth + 1) * 12 + 18 }}
              >
                Loading…
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryPanel({
  scope,
  onOpenChanges,
}: {
  scope: GitScope;
  onOpenChanges: () => void;
}) {
  const taskId = 'taskId' in scope ? scope.taskId : null;
  const workspaceId = 'workspaceId' in scope ? scope.workspaceId : null;
  const watcherTaskId = taskId;
  const gitScope = useMemo(
    () => (taskId ? { taskId } : { workspaceId: workspaceId! }),
    [taskId, workspaceId]
  );
  const [commits, setCommits] = useState<GitCommitRecord[] | null>(null);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [confirmReset, setConfirmReset] = useState<{ hash: string; shortHash: string; ahead: number } | null>(null);

  const load = useCallback(() => {
    return Promise.all([
      aceApi.git.log(gitScope, 80),
      aceApi.git.status(gitScope).catch(() => null),
    ])
      .then(([logResult, statusResult]) => {
        setCommits(logResult.commits);
        setStatus(statusResult);
        setLoadError(null);
      })
      .catch((err) => {
        setCommits([]);
        setLoadError(err instanceof Error ? err.message : 'Failed to load history');
      });
  }, [gitScope]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!watcherTaskId) return;
    return aceApi.core.onGitChanged((payload) => {
      if (payload.taskId !== watcherTaskId) return;
      void load();
    });
  }, [watcherTaskId, load]);

  const toggleExpanded = useCallback((hash: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  const revert = useCallback(
    async (hash: string) => {
      setActionError(null);
      try {
        await aceApi.git.revert(gitScope, hash);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Revert failed');
      }
    },
    [gitScope]
  );

  const doReset = useCallback(
    async (hash: string) => {
      setActionError(null);
      try {
        await aceApi.git.reset(gitScope, hash);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Rewind failed');
      }
    },
    [gitScope]
  );

  const buckets = useMemo(
    () => groupCommitsByDay(commits ?? []),
    [commits]
  );

  if (commits === null) return <LoadingState />;
  if (loadError) return <ErrorState message={loadError} />;

  const dirtyCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);

  return (
    <div className="flex h-full flex-col">
      <BranchHeader status={status} onRefresh={() => void load()} />
      {actionError && (
        <div
          className="shrink-0 truncate border-b border-red-500/20 bg-red-500/10 px-3 py-1 text-[10px] text-red-300/90"
          title={actionError}
        >
          {actionError}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {dirtyCount > 0 && (
          <WorkingChangesRow
            status={status!}
            onOpen={onOpenChanges}
          />
        )}

        {commits.length === 0 && dirtyCount === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No commits on this branch yet.
          </div>
        )}

        {buckets.map((bucket, bIdx) => (
          <div key={bucket.label} className={cn('pb-1', bIdx === 0 && dirtyCount === 0 && 'pt-1')}>
            <div className="sticky top-0 z-[5] px-2 pb-1.5 pt-2.5">
              <span className="inline-flex items-center rounded-full border border-white/[0.06] bg-[hsl(0_0%_8%/0.85)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 backdrop-blur-md">
                {bucket.label}
              </span>
            </div>
            <ol className="flex flex-col">
              {bucket.commits.map((commit, idx) => {
                const absoluteIdx = commits.findIndex((c) => c.hash === commit.hash);
                const aheadFromHead = Math.max(0, absoluteIdx);
                return (
                  <CommitCard
                    key={commit.hash}
                    commit={commit}
                    gitScope={gitScope}
                    githubRepo={status?.githubRepo ?? null}
                    isExpanded={expanded.has(commit.hash)}
                    isFirst={absoluteIdx === 0}
                    isBucketLast={idx === bucket.commits.length - 1}
                    onToggle={() => toggleExpanded(commit.hash)}
                    onRevert={() => void revert(commit.hash)}
                    onReset={() =>
                      setConfirmReset({
                        hash: commit.hash,
                        shortHash: commit.shortHash,
                        ahead: aheadFromHead,
                      })
                    }
                  />
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      {confirmReset && (
        <ResetConfirmDialog
          shortHash={confirmReset.shortHash}
          ahead={confirmReset.ahead}
          onCancel={() => setConfirmReset(null)}
          onConfirm={() => {
            const target = confirmReset.hash;
            setConfirmReset(null);
            void doReset(target);
          }}
        />
      )}
    </div>
  );
}

function BranchHeader({
  status,
  onRefresh,
}: {
  status: GitStatusResult | null;
  onRefresh: () => void;
}) {
  const branch = status?.branch ?? '—';
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const upstream = status?.hasUpstream ?? false;
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[11px] text-foreground/85">
        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground/80" />
        <span className="truncate font-medium">{branch}</span>
        {upstream && (ahead > 0 || behind > 0) && (
          <span className="ml-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            {ahead > 0 && (
              <span className="tabular-nums">↑{ahead}</span>
            )}
            {behind > 0 && (
              <span className="tabular-nums">↓{behind}</span>
            )}
          </span>
        )}
        {upstream && ahead === 0 && behind === 0 && (
          <span className="ml-0.5 text-[10px] text-muted-foreground">synced</span>
        )}
        {!upstream && branch !== '—' && (
          <span className="ml-0.5 text-[10px] text-muted-foreground">no remote</span>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        title="Refresh history"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
      >
        <RefreshCcw className="h-3 w-3" />
      </button>
    </div>
  );
}

function WorkingChangesRow({
  status,
  onOpen,
}: {
  status: GitStatusResult;
  onOpen: () => void;
}) {
  const count = status.staged.length + status.unstaged.length;
  const adds = status.totals.additions;
  const dels = status.totals.deletions;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group mb-1 mt-1 flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05]"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400/15 ring-1 ring-amber-400/25">
        <PencilLine className="h-3 w-3 text-amber-300" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-foreground">Working changes</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{count} file{count === 1 ? '' : 's'}</span>
          {(adds > 0 || dels > 0) && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1 tabular-nums">
                {adds > 0 && <span className="text-emerald-400/90">+{adds}</span>}
                {dels > 0 && <span className="text-rose-400/90">−{dels}</span>}
              </span>
            </>
          )}
        </span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

type DayBucket = { label: string; commits: GitCommitRecord[] };

function groupCommitsByDay(commits: GitCommitRecord[]): DayBucket[] {
  if (commits.length === 0) return [];
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const weekAgo = today - 6 * 86_400_000;
  const monthAgo = today - 30 * 86_400_000;

  const bucketForTs = (ts: number): string => {
    if (ts >= today) return 'Today';
    if (ts >= yesterday) return 'Yesterday';
    if (ts >= weekAgo) return 'This week';
    if (ts >= monthAgo) return 'Earlier this month';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  const out: DayBucket[] = [];
  let currentLabel: string | null = null;
  let currentList: GitCommitRecord[] = [];
  for (const commit of commits) {
    const ts = startOfDay(new Date(commit.date));
    const label = bucketForTs(ts);
    if (label !== currentLabel) {
      if (currentList.length > 0 && currentLabel) {
        out.push({ label: currentLabel, commits: currentList });
      }
      currentLabel = label;
      currentList = [];
    }
    currentList.push(commit);
  }
  if (currentList.length > 0 && currentLabel) {
    out.push({ label: currentLabel, commits: currentList });
  }
  return out;
}

function CommitCard({
  commit,
  gitScope,
  githubRepo,
  isExpanded,
  isFirst,
  isBucketLast,
  onToggle,
  onRevert,
  onReset,
}: {
  commit: GitCommitRecord;
  gitScope: GitScope;
  githubRepo: string | null;
  isExpanded: boolean;
  isFirst: boolean;
  isBucketLast: boolean;
  onToggle: () => void;
  onRevert: () => void;
  onReset: () => void;
}) {
  const relative = useMemo(() => formatRelativeTime(commit.date, true), [commit.date]);
  const subject = useMemo(() => commit.message.split('\n')[0], [commit.message]);
  const hasMergeParent = commit.parents.length > 1;

  return (
    <li className="relative">
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          'group relative flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-xs transition-colors',
          isExpanded
            ? 'bg-white/[0.04]'
            : 'hover:bg-white/[0.03]'
        )}
      >
        <div className="relative flex w-5 shrink-0 flex-col items-center self-stretch pt-[7px]">
          <span
            className={cn(
              'block h-2 w-2 shrink-0 rounded-full ring-2 ring-[hsl(0_0%_6%/0.9)]',
              hasMergeParent ? 'bg-indigo-400/90' : isFirst ? 'bg-emerald-400/90' : 'bg-white/35'
            )}
            aria-hidden
          />
          {!isBucketLast && (
            <span className="mt-0.5 w-px flex-1 bg-white/[0.07]" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <p
              className={cn(
                'min-w-0 flex-1 break-words text-foreground/95',
                !isExpanded && 'line-clamp-2'
              )}
              title={commit.message}
            >
              {subject}
            </p>
            {isFirst && (
              <span className="shrink-0 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-emerald-300">
                HEAD
              </span>
            )}
            {hasMergeParent && (
              <span className="shrink-0 rounded-full border border-indigo-400/20 bg-indigo-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-indigo-300">
                Merge
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="truncate">{commit.author}</span>
            <span>·</span>
            {relative && <span>{relative}</span>}
            {relative && <span>·</span>}
            <span className="font-mono text-muted-foreground/80">{commit.shortHash}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground/50 transition-transform',
              isExpanded && 'rotate-180 text-muted-foreground'
            )}
          />
          {githubRepo && (
            <div onClick={(e) => e.stopPropagation()}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() =>
                      void aceApi.workspaces.openExternal(
                        `https://github.com/${githubRepo}/commit/${commit.hash}`
                      )
                    }
                    aria-label="Open commit on GitHub"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[10px]">Open on GitHub</TooltipContent>
              </Tooltip>
            </div>
          )}
          <div onClick={(e) => e.stopPropagation()}>
            <CommitOverflowMenu
              shortHash={commit.shortHash}
              onRevert={onRevert}
              onReset={onReset}
            />
          </div>
        </div>
      </div>

      {isExpanded && (
        <CommitDetail
          gitScope={gitScope}
          hash={commit.hash}
          body={commit.message}
          githubRepo={githubRepo}
        />
      )}
    </li>
  );
}

function CommitOverflowMenu({
  shortHash,
  onRevert,
  onReset,
}: {
  shortHash: string;
  onRevert: () => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label="Commit actions"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground',
            open && 'bg-white/[0.08] text-foreground'
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="glass-surface z-[140] w-[240px] rounded-xl p-1 text-foreground animate-in fade-in-0 zoom-in-95"
        >
          <MenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Copy hash"
            sub={shortHash}
            onClick={() => {
              void writeToClipboard(shortHash);
              setOpen(false);
            }}
          />
          <div className="my-1 h-px bg-white/[0.06]" />
          <MenuItem
            icon={<Undo2 className="h-3.5 w-3.5" />}
            label="Undo this commit"
            sub="Creates a new commit that reverses this one"
            onClick={() => {
              setOpen(false);
              onRevert();
            }}
          />
          <MenuItem
            icon={<Rewind className="h-3.5 w-3.5 text-rose-300/90" />}
            label="Rewind branch to here"
            sub="Discards later commits and all uncommitted work"
            destructive
            onClick={() => {
              setOpen(false);
              onReset();
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MenuItem({
  icon,
  label,
  sub,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]',
        destructive && 'hover:bg-rose-500/10'
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px] font-medium', destructive ? 'text-rose-200' : 'text-foreground')}>
          {label}
        </span>
        {sub && (
          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}

function ResetConfirmDialog({
  shortHash,
  ahead,
  onCancel,
  onConfirm,
}: {
  shortHash: string;
  ahead: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="glass-surface w-[280px] rounded-2xl p-4 text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.6)] animate-in fade-in-0 zoom-in-95">
        <div className="flex items-start gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-500/15 ring-1 ring-rose-400/30">
            <Rewind className="h-3.5 w-3.5 text-rose-300" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-foreground">
              Rewind branch?
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              HEAD will point to <span className="font-mono text-foreground/90">{shortHash}</span>.
              {ahead > 0
                ? ` ${ahead} commit${ahead === 1 ? '' : 's'} ahead and any uncommitted changes will be discarded.`
                : ' Any uncommitted changes will be discarded.'}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-200 ring-1 ring-inset ring-rose-400/30 transition-colors hover:bg-rose-500/30"
          >
            Rewind
          </button>
        </div>
      </div>
    </div>
  );
}

function CommitDetail({
  gitScope,
  hash,
  body,
  githubRepo,
}: {
  gitScope: GitScope;
  hash: string;
  body: string;
  githubRepo: string | null;
}) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    aceApi.git
      .show(gitScope, hash)
      .then((r) => {
        if (cancelled) return;
        if (!r) setError('Commit not found');
        else setDetail(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load commit');
      });
    return () => {
      cancelled = true;
    };
  }, [gitScope, hash]);

  const bodyText = useMemo(() => {
    const parts = body.split('\n');
    return parts.slice(1).join('\n').trim();
  }, [body]);

  return (
    <div className="ml-[30px] mr-1 mb-1.5 overflow-hidden rounded-lg border border-white/[0.05] bg-white/[0.015]">
      {bodyText && (
        <div className="whitespace-pre-wrap border-b border-white/[0.05] px-3 py-2 text-[11px] leading-snug text-foreground/80">
          {bodyText}
        </div>
      )}
      {!detail && !error && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/70">Loading files…</div>
      )}
      {error && (
        <div className="px-3 py-2 text-[11px] text-rose-300/80">{error}</div>
      )}
      {detail && detail.files.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/70">
          No file changes (merge commit)
        </div>
      )}
      {detail && detail.files.length > 0 && (
        <ol className="flex flex-col py-1">
          {detail.files.map((file) => (
            <CommitFileRow
              key={(file.oldPath || '') + '→' + file.path}
              file={file}
              gitScope={gitScope}
              hash={hash}
              githubRepo={githubRepo}
              isOpen={openFile === file.path}
              onToggle={() => setOpenFile((p) => (p === file.path ? null : file.path))}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function CommitFileRow({
  file,
  gitScope,
  hash,
  githubRepo,
  isOpen,
  onToggle,
}: {
  file: GitCommitFileChange;
  gitScope: GitScope;
  hash: string;
  githubRepo: string | null;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [diff, setDiff] = useState<DiffEntry | undefined>(undefined);

  useEffect(() => {
    if (!isOpen || diff) return;
    let cancelled = false;
    aceApi.git
      .showFile(gitScope, hash, file.path)
      .then((r) => {
        if (cancelled) return;
        setDiff({
          state: 'loaded',
          diff: r.diff,
          binary: file.binary || r.binary,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiff({
          state: 'error',
          message: err instanceof Error ? err.message : 'Failed to load diff',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, diff, gitScope, hash, file.path, file.binary]);

  return (
    <li className="min-w-0">
      <DiffFileRow
        path={file.path}
        oldPath={file.oldPath}
        binary={file.binary}
        additions={file.additions}
        deletions={file.deletions}
        isOpen={isOpen}
        onToggle={onToggle}
        diff={diff}
        githubUrl={githubRepo ? `https://github.com/${githubRepo}/blob/${hash}/${file.path}` : null}
      />
    </li>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p className="text-center text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p className="text-center text-xs text-muted-foreground/70">Loading…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6">
      <p className="text-center text-xs font-medium text-red-300/80">Unable to load</p>
      <p className="text-center text-[10px] text-muted-foreground/60">{message}</p>
    </div>
  );
}

function FileSearchBar(props: {
  query: string;
  onQueryChange: (v: string) => void;
  mode: SearchMode;
  onModeChange: (v: SearchMode) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  regex: boolean;
  onRegexChange: (v: boolean) => void;
  wholeWord: boolean;
  onWholeWordChange: (v: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        props.onModeChange('text');
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="shrink-0 border-b border-border/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground/60" />
          <input
            ref={inputRef}
            type="text"
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            placeholder={props.mode === 'files' ? 'Search files by name' : 'Search in files'}
            spellCheck={false}
            className="h-7 w-full min-w-0 rounded-md border border-border/40 bg-background/40 pl-7 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/30 focus:outline-none"
          />
          {props.query && (
            <button
              type="button"
              onClick={() => props.onQueryChange('')}
              className="absolute right-1 rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-border/40 bg-background/40 p-0.5">
          <SegButton
            active={props.mode === 'files'}
            onClick={() => props.onModeChange('files')}
            title="Search filenames"
          >
            Files
          </SegButton>
          <SegButton
            active={props.mode === 'text'}
            onClick={() => props.onModeChange('text')}
            title="Search in file contents (⌘⇧F)"
          >
            Text
          </SegButton>
        </div>
      </div>
      {props.mode === 'text' && (
        <div className="mt-1.5 flex items-center gap-1 pl-1">
          <ToggleIcon
            active={props.caseSensitive}
            onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}
            title="Match case"
          >
            <CaseSensitive className="h-3 w-3" />
          </ToggleIcon>
          <ToggleIcon
            active={props.wholeWord}
            onClick={() => props.onWholeWordChange(!props.wholeWord)}
            title="Match whole word"
          >
            <WholeWord className="h-3 w-3" />
          </ToggleIcon>
          <ToggleIcon
            active={props.regex}
            onClick={() => props.onRegexChange(!props.regex)}
            title="Use regular expression"
          >
            <Regex className="h-3 w-3" />
          </ToggleIcon>
        </div>
      )}
    </div>
  );
}

function SegButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
        active ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function ToggleIcon({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded transition-colors',
        active
          ? 'bg-foreground/15 text-foreground'
          : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function SearchStatus({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'error' }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p
        className={cn(
          'text-center text-xs',
          tone === 'error' ? 'text-red-300/80' : 'text-muted-foreground/70'
        )}
      >
        {text}
      </p>
    </div>
  );
}

function FileResultsList({
  results,
  query,
  onOpen,
}: {
  results: string[];
  query: string;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="flex flex-col py-1">
      {results.map((p) => {
        const slash = p.lastIndexOf('/');
        const dir = slash >= 0 ? p.slice(0, slash) : '';
        const name = slash >= 0 ? p.slice(slash + 1) : p;
        return (
          <button
            key={p}
            type="button"
            onClick={() => onOpen(p)}
            className="group flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-foreground/90 hover:bg-foreground/5"
            title={p}
          >
            <FileIcon path={name} className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {highlightMatch(name, query)}
            </span>
            {dir && (
              <span className="ml-auto truncate pl-2 text-[10px] text-muted-foreground/50">
                {dir}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ContentResultsList({
  groups,
  query,
  caseSensitive,
  regex,
  truncated,
  onOpen,
}: {
  groups: [string, ContentSearchMatch[]][];
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  truncated: boolean;
  onOpen: (path: string) => void;
}) {
  const totalMatches = groups.reduce((acc, [, list]) => acc + list.length, 0);
  return (
    <div className="flex flex-col py-1">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {totalMatches} {totalMatches === 1 ? 'match' : 'matches'} in {groups.length}{' '}
        {groups.length === 1 ? 'file' : 'files'}
        {truncated && ' (truncated)'}
      </div>
      {groups.map(([path, matches]) => {
        const slash = path.lastIndexOf('/');
        const dir = slash >= 0 ? path.slice(0, slash) : '';
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <div key={path} className="mb-1">
            <button
              type="button"
              onClick={() => onOpen(path)}
              className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-foreground/5"
              title={path}
            >
              <FileIcon path={name} className="h-3 w-3 shrink-0" />
              <span className="truncate text-[11px] font-medium text-foreground/90">{name}</span>
              {dir && (
                <span className="ml-auto truncate pl-2 text-[10px] text-muted-foreground/50">
                  {dir}
                </span>
              )}
              <span className="shrink-0 rounded bg-foreground/10 px-1 py-0.5 text-[9px] tabular-nums text-muted-foreground/80">
                {matches.length}
              </span>
            </button>
            <div className="flex flex-col">
              {matches.map((m, i) => (
                <button
                  key={`${m.line}-${m.column}-${i}`}
                  type="button"
                  onClick={() => onOpen(path)}
                  className="flex min-w-0 items-baseline gap-2 rounded px-2 py-0.5 pl-7 text-left hover:bg-foreground/5"
                  title={`Line ${m.line}`}
                >
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/50">
                    {m.line}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-foreground/80">
                    {highlightContentMatch(m.preview, query, { caseSensitive, regex })}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function rankFileMatches(files: string[], query: string, limit: number): string[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const p of files) {
    const lower = p.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;
    const slash = lower.lastIndexOf('/');
    const baseIdx = slash >= 0 ? slash + 1 : 0;
    const nameHit = idx >= baseIdx;
    const nameExact = nameHit && lower.slice(baseIdx) === q;
    const nameStart = nameHit && idx === baseIdx;
    let score = 0;
    if (nameExact) score += 1000;
    else if (nameStart) score += 500;
    else if (nameHit) score += 250;
    score -= idx;
    score -= p.length * 0.5;
    scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <mark className="rounded bg-amber-400/25 px-0.5 text-foreground">{match}</mark>
      {after}
    </>
  );
}

function highlightContentMatch(
  text: string,
  query: string,
  opts: { caseSensitive: boolean; regex: boolean }
): React.ReactNode {
  if (!query || opts.regex) return text;
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    <>
      {before}
      <mark className="rounded bg-amber-400/25 px-0.5 text-foreground">{match}</mark>
      {after}
    </>
  );
}
