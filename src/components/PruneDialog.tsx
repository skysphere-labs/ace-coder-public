import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { BrushCleaning, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { useState } from 'react';
import { PRUNE_PROMPT } from '../lib/prune-prompt';

export function PruneDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AnimatePresence>
      {open && <DialogBody onCancel={onCancel} onConfirm={onConfirm} />}
    </AnimatePresence>
  );
}

function DialogBody({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    onConfirm();
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
        className="glass-surface w-full max-w-lg overflow-hidden rounded-2xl"
      >
        <div className="flex items-start gap-3 px-6 pt-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/[0.08] text-amber-300">
            <BrushCleaning className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold tracking-tight">
              Clean up codebase
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Ask the active agent to tidy up the code — remove unused files, dead code, and unnecessary complexity. Nothing changes functionally.
            </p>
          </div>
        </div>

        <div className="px-6 pt-4">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This will instruct the agent to:
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
            <li>Run static analysis to find unused code and dependencies</li>
            <li>Remove what's no longer needed — files, exports, imports, dead code</li>
            <li>Simplify overly complex patterns where possible</li>
            <li>Verify everything still works (lint, typecheck, build, tests)</li>
          </ul>
        </div>

        <div className="mx-6 mt-4 max-h-40 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground/80">
            {PRUNE_PROMPT}
          </pre>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-white/[0.06] px-6 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={busy}
            className="gap-1.5 bg-amber-500/90 text-white hover:bg-amber-500"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <BrushCleaning className="h-3.5 w-3.5" />
            )}
            Send to agent
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}
