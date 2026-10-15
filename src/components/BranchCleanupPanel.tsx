import { useState, useMemo } from 'react';
import { GitBranch, Trash2, RefreshCw, Search, Shield, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { aceApi } from '../lib/ace-api';
import { refreshWorkspaceRecord } from '../runtime/workspace-registry';
import type { CleanupBranch } from '../lib/types';

interface BranchCleanupPanelProps {
  workspaceId: string;
  branches: CleanupBranch[];
}

const isProtected = (branch: CleanupBranch) =>
  !!(branch.isDefaultBranch || branch.isCurrentBranch || (branch.taskNames && branch.taskNames.length > 0));

export default function BranchCleanupPanel({ workspaceId, branches }: BranchCleanupPanelProps) {
  const [selectedBranchNames, setSelectedBranchNames] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanupCandidates = useMemo(() => branches.filter((b) => !isProtected(b)), [branches]);

  const filteredBranches = useMemo(() => {
    if (!query.trim()) return branches;
    const q = query.toLowerCase();
    return branches.filter((b) => b.branch.toLowerCase().includes(q));
  }, [branches, query]);

  const selectedCleanupCandidates = cleanupCandidates.filter((b) =>
    selectedBranchNames.includes(b.branch)
  );

  const toggleSelectAll = () => {
    if (selectedCleanupCandidates.length === cleanupCandidates.length) {
      setSelectedBranchNames([]);
    } else {
      setSelectedBranchNames(cleanupCandidates.map((b) => b.branch));
    }
  };

  const toggleBranchSelection = (branch: string) => {
    setSelectedBranchNames((prev) =>
      prev.includes(branch) ? prev.filter((b) => b !== branch) : [...prev, branch]
    );
  };

  const allSelected =
    cleanupCandidates.length > 0 &&
    selectedCleanupCandidates.length === cleanupCandidates.length;

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshWorkspaceRecord(workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async (branch: CleanupBranch) => {
    if (isProtected(branch)) return;
    const detail = branch.hasRemote ? ' (and its remote)' : '';
    if (!window.confirm(`Delete branch "${branch.branch}"${detail}?`)) return;
    setBusyBranch(branch.branch);
    setError(null);
    try {
      await aceApi.workspaces.deleteBranch(workspaceId, branch.branch, {
        deleteRemote: branch.hasRemote,
      });
      setSelectedBranchNames((prev) => prev.filter((n) => n !== branch.branch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyBranch(null);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedCleanupCandidates.length === 0) return;
    const count = selectedCleanupCandidates.length;
    if (!window.confirm(`Delete ${count} branch${count === 1 ? '' : 'es'}?`)) return;
    setBulkDeleting(true);
    setError(null);
    try {
      for (const b of selectedCleanupCandidates) {
        try {
          await aceApi.workspaces.deleteBranch(workspaceId, b.branch, {
            deleteRemote: b.hasRemote,
          });
        } catch (err) {
          setError(
            `Failed to delete ${b.branch}: ${err instanceof Error ? err.message : String(err)}`
          );
          break;
        }
      }
      setSelectedBranchNames([]);
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Tidy up stale local branches here. Branches with a remote counterpart also get
        removed from origin. Protected branches (default, current, or attached to an
        active task) can&rsquo;t be deleted.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter branches"
            className="h-9 pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
        {cleanupCandidates.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-3 text-xs"
            onClick={toggleSelectAll}
          >
            {allSelected ? 'Clear selection' : 'Select deletable'}
          </Button>
        )}
        {selectedCleanupCandidates.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 border-rose-500/30 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
          >
            {bulkDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete {selectedCleanupCandidates.length}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{branches.length} branches</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{cleanupCandidates.length} deletable</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{branches.length - cleanupCandidates.length} protected</span>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {filteredBranches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-4 py-10 text-center text-sm text-muted-foreground">
            {branches.length === 0
              ? 'No extra branches to clean up.'
              : 'No branches match your filter.'}
          </div>
        ) : (
          filteredBranches.map((branch) => {
            const protected_ = isProtected(branch);
            const isSelected = selectedBranchNames.includes(branch.branch);
            const isBusy = busyBranch === branch.branch;

            return (
              <div
                key={branch.branch}
                className={cn(
                  'group flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 transition-colors',
                  'hover:border-white/[0.10] hover:bg-white/[0.04]',
                  isSelected && 'border-white/[0.16] bg-white/[0.06]'
                )}
              >
                {!protected_ ? (
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleBranchSelection(branch.branch)}
                    aria-label={`Select branch ${branch.branch}`}
                    className="h-4 w-4 shrink-0"
                  />
                ) : (
                  <div
                    className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/50"
                    title="Protected from cleanup"
                  >
                    <Shield className="h-3.5 w-3.5" />
                  </div>
                )}

                <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />

                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-mono text-sm">{branch.branch}</span>
                  <div className="flex flex-wrap items-center gap-1 text-[10px] tracking-wide text-muted-foreground/70">
                    {branch.hasLocal && (
                      <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 uppercase">
                        local
                      </span>
                    )}
                    {branch.hasRemote && (
                      <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 uppercase">
                        {branch.remote || 'origin'}
                      </span>
                    )}
                    {branch.isDefaultBranch && (
                      <span className="rounded border border-sky-400/20 bg-sky-400/[0.06] px-1.5 py-0.5 uppercase text-sky-300">
                        base
                      </span>
                    )}
                    {branch.isCurrentBranch && (
                      <span className="rounded border border-emerald-400/20 bg-emerald-400/[0.06] px-1.5 py-0.5 uppercase text-emerald-300">
                        current
                      </span>
                    )}
                    {branch.taskNames && branch.taskNames.length > 0 && (
                      <span className="rounded border border-amber-400/20 bg-amber-400/[0.06] px-1.5 py-0.5 text-amber-200">
                        task: {branch.taskNames[0]}
                        {branch.taskNames.length > 1 ? ` +${branch.taskNames.length - 1}` : ''}
                      </span>
                    )}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    'shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100',
                    protected_ && 'cursor-not-allowed opacity-0 group-hover:opacity-30'
                  )}
                  disabled={protected_ || isBusy}
                  aria-label={`Delete branch ${branch.branch}`}
                  title={
                    protected_
                      ? 'This branch is protected from cleanup'
                      : `Delete branch ${branch.branch}`
                  }
                  onClick={() => handleDelete(branch)}
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
