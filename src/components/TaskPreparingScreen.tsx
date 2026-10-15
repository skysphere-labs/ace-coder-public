import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Task } from '../lib/types';
import { useApp } from '../store';
import { createTaskWorktree, deleteWorkspaceTask } from '../runtime/workspace-registry';
import { Spinner } from './ui/spinner';
import { Button } from './ui/button';

// Shown in place of the task workspace while a freshly-created task's worktree
// checkout runs off the createTask response path (task.status === 'preparing'),
// or when that checkout failed (task.status === 'error'). Once the worktree
// lands, the task's variant appears in state and WorkspaceCanvas swaps this out
// for the real ParallelTaskScreen — the terminal auto-attaches there. Keep this
// minimal: it's a transient interstitial, not a screen the user lives on.
export function TaskPreparingScreen({ task }: { task: Task }) {
  const { setView } = useApp();
  const [busy, setBusy] = useState<null | 'retry' | 'delete'>(null);

  const retry = async () => {
    if (busy) return;
    setBusy('retry');
    try {
      // Server ignores an empty branch and re-derives the default base; this
      // re-drives the same preparing → ready/error flow as the initial create.
      await createTaskWorktree(task.id, {
        name: task.name,
        agent: task.agent,
        branch: '',
        reviewMode: false,
      });
    } catch (err) {
      window.alert(`Retry failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('delete');
    try {
      await deleteWorkspaceTask(task.id);
      setView('today');
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      setBusy(null);
    }
  };

  if (task.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            Couldn’t set up the worktree
          </h2>
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-muted-foreground">
            {task.prepError || 'git worktree add failed.'}
          </p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button variant="default" size="sm" onClick={retry} disabled={!!busy}>
            {busy === 'retry' ? 'Retrying…' : 'Retry'}
          </Button>
          <Button variant="ghost" size="sm" onClick={remove} disabled={!!busy}>
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Spinner size="lg" className="text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="text-[14px] font-medium text-foreground">Setting up worktree…</p>
        <p className="text-[12px] text-muted-foreground">{task.name}</p>
      </div>
    </div>
  );
}
