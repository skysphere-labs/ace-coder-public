import { useRef, useState } from 'react';
import { GitBranch, ChevronDown, X, Plus } from 'lucide-react';
import { cn, useClickAway } from '../../lib/utils';
import { agentMeta } from '../../lib/agent-style';
import { Spinner } from '../ui/spinner';
import { Checkbox } from '../ui/checkbox';
import type { WorktreeGroup } from '../../lib/types';

interface WorktreeSelectorProps {
  worktreeGroups: WorktreeGroup[];
  activeWorktreeId: string;
  onWorktreeSelect: (id: string) => void;
  onAddWorktree?: () => void;
  onDeleteWorktree?: (id: string) => void;
  selectedWorktreeIds?: string[];
  onToggleWorktreeSelection?: (id: string) => void;
  onSelectAllDeletableWorktrees?: () => void;
  onDeleteSelectedWorktrees?: () => void;
  onClearWorktreeSelection?: () => void;
}

export default function WorktreeSelector({
  worktreeGroups,
  activeWorktreeId,
  onWorktreeSelect,
  onAddWorktree,
  onDeleteWorktree,
  selectedWorktreeIds = [],
  onToggleWorktreeSelection,
  onSelectAllDeletableWorktrees,
  onDeleteSelectedWorktrees,
  onClearWorktreeSelection,
}: WorktreeSelectorProps) {
  const wtRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useClickAway(wtRef, () => setOpen(false), open);

  const activeWt = worktreeGroups.find((g) => g.worktreeId === activeWorktreeId);
  if (!activeWt) return null;

  const selectedSet = new Set(selectedWorktreeIds);
  const canBulkDelete = worktreeGroups.length > 1;
  const deletableCount = canBulkDelete ? worktreeGroups.length - 1 : 0;

  return (
    <div ref={wtRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={`${activeWt.displayName} (${activeWt.branch})`}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
          'hover:text-foreground',
          open && 'text-foreground'
        )}
      >
        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="max-w-[180px] truncate text-xs font-medium text-foreground">
          {activeWt.displayName}
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="glass-surface absolute left-0 top-full z-50 mt-1.5 min-w-[320px] max-w-[440px] overflow-hidden rounded-xl">
          {canBulkDelete && (
            <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
              <span className="text-[10px] text-muted-foreground">
                {selectedWorktreeIds.length > 0
                  ? `${selectedWorktreeIds.length} selected`
                  : 'Select worktrees to delete'}
              </span>
              {selectedWorktreeIds.length > 0 ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onClearWorktreeSelection?.()}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteSelectedWorktrees?.();
                      setOpen(false);
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Delete selected
                  </button>
                </div>
              ) : onSelectAllDeletableWorktrees && deletableCount > 0 ? (
                <button
                  type="button"
                  onClick={() => onSelectAllDeletableWorktrees()}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                  Select all other worktrees
                </button>
              ) : null}
            </div>
          )}
          <div className="p-1.5">
            {worktreeGroups.map((wt) => {
              const isActive = wt.worktreeId === activeWorktreeId;
              const busy = wt.variants.some((v) => v.busy);
              const canDelete = worktreeGroups.length > 1;
              return (
                <div
                  key={wt.worktreeId}
                  aria-current={isActive || undefined}
                  className={cn(
                    'glass-item group flex w-full items-center gap-2 px-2.5 py-2',
                    isActive ? 'text-foreground' : 'text-foreground/80'
                  )}
                >
                  {canDelete && onToggleWorktreeSelection && (
                    <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedSet.has(wt.worktreeId)}
                        onCheckedChange={() => onToggleWorktreeSelection(wt.worktreeId)}
                        aria-label={`Select worktree ${wt.displayName}`}
                        className="h-4 w-4"
                      />
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onWorktreeSelect(wt.worktreeId);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={`${wt.displayName} (${wt.branch})`}
                  >
                    <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {wt.displayName}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {wt.variants.map((v) => agentMeta[v.agent]?.label || v.agent).join(', ')}
                      </span>
                    </div>
                    {busy && <Spinner size="sm" className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteWorktree?.(wt.worktreeId);
                        setOpen(false);
                      }}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title={`Remove worktree ${wt.displayName}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {onAddWorktree && (
            <div className="border-t border-white/[0.06] p-1.5">
              <button
                type="button"
                onClick={() => {
                  onAddWorktree();
                  setOpen(false);
                }}
                className="glass-item flex w-full items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New worktree</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
