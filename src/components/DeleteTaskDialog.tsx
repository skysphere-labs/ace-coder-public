import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import type { Task } from '../lib/types';

export type DeleteTaskOptions = {
  deleteLocalBranch: boolean;
  deleteRemoteBranch: boolean;
  removeWorktree: boolean;
};

export function DeleteTaskDialog({
  task,
  onCancel,
  onConfirm,
}: {
  task: Task | null;
  onCancel: () => void;
  onConfirm: (options: DeleteTaskOptions) => Promise<void>;
}) {
  return (
    <AnimatePresence>
      {task && <DialogBody task={task} onCancel={onCancel} onConfirm={onConfirm} />}
    </AnimatePresence>
  );
}

function DialogBody({
  task,
  onCancel,
  onConfirm,
}: {
  task: Task;
  onCancel: () => void;
  onConfirm: (options: DeleteTaskOptions) => Promise<void>;
}) {
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [deleteLocalBranch, setDeleteLocalBranch] = useState(true);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const branch = task.worktrees?.[0]?.branch || task.branch;

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
    const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [busy, onCancel]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        removeWorktree,
        deleteLocalBranch: removeWorktree && deleteLocalBranch,
        deleteRemoteBranch,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
    }
  };

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="glass-overlay fixed inset-0 z-[200] flex items-center justify-center p-6"
      onClick={busy ? undefined : onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface w-full max-w-md overflow-hidden rounded-2xl"
      >
        <div className="flex items-start gap-3 px-6 pt-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/[0.08] text-rose-300">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold tracking-tight">
              Delete task
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/90">{task.name}</span>
              {branch && (
                <>
                  {' · '}
                  <span className="font-mono">{branch}</span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-1 px-6 pt-4">
          <OptionRow
            checked={removeWorktree}
            onChange={setRemoveWorktree}
            title="Remove worktree folder"
            description="Run git worktree remove and delete the folder on disk."
          />
          <OptionRow
            checked={deleteLocalBranch}
            onChange={setDeleteLocalBranch}
            disabled={!removeWorktree}
            title="Delete local branch"
            description={
              removeWorktree
                ? 'Run git branch -D on the feature branch.'
                : 'Requires removing the worktree first.'
            }
          />
          <OptionRow
            checked={deleteRemoteBranch}
            onChange={setDeleteRemoteBranch}
            title="Delete remote branch on origin"
            description="Run git push origin --delete to remove it from GitHub."
          />
        </div>

        {error && (
          <p className="mx-6 mt-4 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2 text-[11px] text-rose-200">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-white/[0.06] px-6 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={confirmBtnRef}
            type="button"
            size="sm"
            onClick={submit}
            disabled={busy}
            className="gap-1.5 bg-rose-500/90 text-white hover:bg-rose-500"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete task
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

function OptionRow({
  checked,
  onChange,
  title,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/[0.08] hover:bg-white/[0.03] ${
        disabled ? 'cursor-not-allowed opacity-50 hover:border-white/[0.04] hover:bg-white/[0.02]' : ''
      }`}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </div>
      </div>
    </label>
  );
}
