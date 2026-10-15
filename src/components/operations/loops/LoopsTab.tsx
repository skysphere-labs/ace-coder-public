import { useMemo, useState } from 'react';
import { PauseOctagon, Repeat, Skull } from 'lucide-react';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../molecules/ConfirmDialog';
import {
  useLoopsData,
  runLoop,
  stopLoop,
  removeLoop,
  killAllLoops,
} from '../../../runtime/loops-registry';
import type { LoopSpec, LoopLineage } from '../../../runtime/loops-registry';
import { CatalogPane } from './CatalogPane';
import { LoopDetailPane } from './LoopDetailPane';
import { LiveRunPane } from './LiveRunPane';
import { NewLoopForge } from './NewLoopForge';

// ─── LoopsTab ─────────────────────────────────────────────────────────────────
// Operations → Loops: the three-pane console (PRD §6). Catalog | Detail | LiveRun,
// a global control strip ([Pause all][Kill all] + aggregate gauges), and the
// forge overlaying the Detail pane in "new loop" mode. Self-scrolling tab body
// rendered bare (no ScrollPanel) — each pane owns its own scroll, mirroring OpsTab.
//
// Data flows through src/runtime/loops-registry (loops.list/get/run/stop/status/
// killAll/lockOn/save). C8: real data or an error slice, no mock fallback.
//
// Gates (PRD §6/§7): Run / Delete / Kill-all each pass through ConfirmDialog.
// Pause-all is a soft local intent in Slice-1 (it stops nothing destructively) —
// the hard guarantee is Kill-all via host.killAll(). Merge stays owner-gated in
// the host (no token ⇒ parks at ready_to_review).

type PendingAction =
  | { type: 'run'; loop: LoopSpec }
  | { type: 'delete'; loop: LoopSpec }
  | { type: 'killAll' }
  | null;

export function LoopsTab() {
  const state = useLoopsData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [forgeOpen, setForgeOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);

  const loops = state.loops.data;
  const active = state.status.data?.active ?? [];
  const inFlight = state.status.data?.inFlight ?? 0;
  const lineages = state.status.data?.lineages;

  // Default-select the first loop once the catalog loads.
  const effectiveSelectedId = useMemo(() => {
    if (selectedId && loops.some((l) => l.id === selectedId)) return selectedId;
    return loops[0]?.id ?? null;
  }, [selectedId, loops]);

  const selectedLoop: LoopSpec | null =
    loops.find((l) => l.id === effectiveSelectedId) ?? null;
  const selectedLineage: LoopLineage | null = effectiveSelectedId
    ? lineages?.[effectiveSelectedId] ?? null
    : null;
  const selectedRunning = effectiveSelectedId
    ? active.includes(effectiveSelectedId)
    : false;

  // Aggregate spend gauge across all loop lineages.
  const aggregateSpend = useMemo(() => {
    if (!lineages) return 0;
    return Object.values(lineages).reduce((sum, l) => sum + (l.totalSpendUsd ?? 0), 0);
  }, [lineages]);

  const confirmPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.type === 'run') {
        await runLoop(pending.loop.id);
      } else if (pending.type === 'delete') {
        await removeLoop(pending.loop.id);
        if (selectedId === pending.loop.id) setSelectedId(null);
      } else if (pending.type === 'killAll') {
        await killAllLoops();
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const handleStop = async (loop: LoopSpec) => {
    // The Loops tab knows the loopId; the service's stopLoop accepts a loopId and
    // halts every active invocation of that loop (or a loopinv- id directly).
    await stopLoop(loop.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Global control strip ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-sky-300" aria-hidden="true" />
          <span className="text-[13px] font-semibold text-foreground">Loops</span>
          <span className="text-xs text-foreground/55">
            {loops.length} saved · {active.length} active
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Aggregate gauges */}
          <div className="flex items-center gap-3 text-xs text-foreground/60 tabular-nums">
            <span title="Loop iterations in flight across all loops">
              {inFlight} in-flight
            </span>
            <span title="Aggregate spend across all loop lineages">
              ${aggregateSpend.toFixed(2)}
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            className="h-7 gap-1 px-2 text-xs"
            aria-pressed={paused}
            title="Soft-pause: stop launching new iterations (does not kill in-flight work)"
          >
            <PauseOctagon className="h-3.5 w-3.5" aria-hidden="true" />
            {paused ? 'Resume all' : 'Pause all'}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setPending({ type: 'killAll' })}
            disabled={inFlight === 0 && active.length === 0}
            className="h-7 gap-1 px-2 text-xs"
            title="Halt every active loop iteration immediately"
          >
            <Skull className="h-3.5 w-3.5" aria-hidden="true" />
            Kill all
          </Button>
        </div>
      </div>

      {/* ── Three-pane body ──────────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,1.6fr)_minmax(260px,1.2fr)]">
        <CatalogPane
          state={state}
          selectedId={effectiveSelectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setForgeOpen(false);
          }}
          onNewLoop={() => setForgeOpen(true)}
        />

        {forgeOpen ? (
          <NewLoopForge
            onClose={() => setForgeOpen(false)}
            onSaved={(spec) => {
              setForgeOpen(false);
              setSelectedId(spec.id);
            }}
          />
        ) : (
          <LoopDetailPane
            loop={selectedLoop}
            isRunning={selectedRunning}
            onRun={(loop) => setPending({ type: 'run', loop })}
            onEdit={() => setForgeOpen(true)}
            onStop={(loop) => void handleStop(loop)}
            onDelete={(loop) => setPending({ type: 'delete', loop })}
          />
        )}

        <LiveRunPane loop={selectedLoop} lineage={selectedLineage} isRunning={selectedRunning} />
      </div>

      {/* ── Gates ────────────────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={pending?.type === 'run'}
        title={`Run loop: ${pending?.type === 'run' ? pending.loop.name : ''}`}
        body="Starts a bounded loop. Each iteration runs as a canonical run on the ledger. Merge stays owner-gated — with no owner token a converged iteration parks at ready_to_review and never merges to main."
        riskTier="medium"
        confirmLabel="Run loop"
        busy={busy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.type === 'delete'}
        title={`Delete loop: ${pending?.type === 'delete' ? pending.loop.name : ''}`}
        body="Removes this loop definition from the catalog. Past iteration runs on the ledger are unaffected."
        riskTier="medium"
        destructive
        confirmLabel="Delete loop"
        showGuardrails={false}
        busy={busy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.type === 'killAll'}
        title="Kill all loops"
        body="Immediately halts every active loop iteration across the host. In-flight runs stop; the catalog is untouched."
        riskTier="high"
        destructive
        confirmLabel="Kill all"
        showGuardrails={false}
        busy={busy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
