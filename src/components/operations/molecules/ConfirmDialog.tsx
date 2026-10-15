import { useEffect } from 'react';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/spinner';
import { Chip, type ChipTone } from '../atoms/Chip';

export type RiskTier = 'low' | 'medium' | 'high';

// Risk tier → shared Chip tone (same scheme everywhere risk renders).
const RISK_CHIP_TONE: Record<RiskTier, ChipTone> = {
  low: 'emerald',
  medium: 'amber',
  high: 'rose',
};

// ConfirmDialog — the single gate for any state-creating / agent-spawning action
// in Operations (ops-v2 D4: "Rook proposes, Chief disposes"). Stamps the risk
// tier, the feature-branch-only boundary, the Clawpatch requirement for medium+,
// and the validator gate. NOTHING spawns without passing through this confirm.
// Callers must pass a `body` that states concretely what will happen (e.g.
// 'Creates a ticket only — nothing spawns').
//
// Atom/molecule discipline: composes the shared Button + Chip + Spinner atoms
// with lucide icons and the shared dark tokens. No one-off styling.
export function ConfirmDialog({
  open,
  title,
  body,
  riskTier = 'medium',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  destructive = false,
  showGuardrails = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  riskTier?: RiskTier;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  destructive?: boolean;
  showGuardrails?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape dismisses (keyboard parity with the click-outside path) — never
  // mid-flight while busy.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const clawpatchRequired = riskTier === 'medium' || riskTier === 'high';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 motion-safe:animate-in motion-safe:fade-in-0"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-white/[0.08] bg-[#0d1117] p-4 shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {body && <div className="text-[13px] leading-relaxed text-foreground/85">{body}</div>}

        {showGuardrails && (
          <div className="flex flex-col gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={RISK_CHIP_TONE[riskTier]}>
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {riskTier} risk
              </Chip>
              {clawpatchRequired && (
                <Chip tone="sky">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                  Clawpatch required
                </Chip>
              )}
            </div>
            <p className="text-xs leading-snug text-foreground/70">
              Runs on a feature branch only — never main or production.{' '}
              {clawpatchRequired
                ? 'A Clawpatch review and a validator pass are required before any merge.'
                : 'A validator pass is required before any merge.'}
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy} className="text-xs">
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="gap-1.5 text-xs"
          >
            {busy ? (
              <>
                <Spinner size="sm" className="h-3.5 w-3.5" />
                Working…
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
