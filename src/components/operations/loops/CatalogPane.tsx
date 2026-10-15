import { Lock, Plus, Repeat } from 'lucide-react';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { StatusPill } from '../atoms/StatusPill';
import { Chip } from '../atoms/Chip';
import { EmptyState, ErrorState, LoadingState } from '../atoms/states';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';
import type { Severity } from '../severity';
import type {
  LoopSpec,
  LoopLineage,
  LoopsState,
} from '../../../runtime/loops-registry';

// ─── CatalogPane ──────────────────────────────────────────────────────────────
// Left pane of the Loops console (PRD §6): the saved loop catalog. Each row shows
// name, kind, a status badge (idle/running/blocked derived from live host
// lineage), and a last-run hint. A "＋ New Loop" header action opens the forge.
// C8: the loops slice is real or it surfaces an error — no mock catalog.

export type LoopRowStatus = 'idle' | 'running' | 'blocked';

// Map a loop's live status to the shared Severity scheme used by StatusPill so
// the badge color stays consistent with the rest of Operations.
const STATUS_SEVERITY: Record<LoopRowStatus, Severity> = {
  idle: 'green',
  running: 'yellow',
  blocked: 'red',
};

const STATUS_LABEL: Record<LoopRowStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  blocked: 'Blocked',
};

// Derive a row status from the host status slice: a loop is "running" if it is in
// the active set, "blocked" if its lineage's latest outcome is a blocked terminal,
// otherwise "idle".
// Module-local (not exported): keeping it un-exported lets this component file
// satisfy react-refresh/only-export-components (only components are exported).
function deriveLoopStatus(
  loopId: string,
  active: string[] | undefined,
  lineage: LoopLineage | null | undefined
): LoopRowStatus {
  if (active?.includes(loopId)) return 'running';
  const outcome = lineage?.latestRunOutcome;
  if (
    outcome === 'BLOCKED' ||
    outcome === 'STALLED_NO_PROGRESS' ||
    outcome === 'NEEDS_OWNER_DECISION' ||
    outcome === 'UNSAFE_REQUIRES_APPROVAL'
  ) {
    return 'blocked';
  }
  return 'idle';
}

function lastRunLabel(lineage: LoopLineage | null | undefined): string {
  if (!lineage || lineage.iterationCount === 0) return 'Never run';
  const iter = lineage.iterationCount === 1 ? 'iteration' : 'iterations';
  const outcome = lineage.latestRunOutcome ? ` · ${lineage.latestRunOutcome}` : '';
  return `${lineage.iterationCount} ${iter}${outcome}`;
}

export function CatalogPane({
  state,
  selectedId,
  onSelect,
  onNewLoop,
}: {
  state: LoopsState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewLoop: () => void;
}) {
  const { loops, status } = state;
  const lineages = status.data?.lineages;
  const active = status.data?.active;

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title="Catalog"
        icon={Repeat}
        tone="sky"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={onNewLoop}
            className="h-7 gap-1 px-2 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New Loop
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loops.status === 'loading' && <LoadingState label="Loading loops" />}
        {loops.status === 'error' && (
          <ErrorState message={loops.error ?? 'Failed to load the loop catalog'} />
        )}
        {loops.status === 'ready' && loops.data.length === 0 && (
          <EmptyState
            label="No loops yet"
            hint="Click ＋ New Loop to forge your first one from a description."
          />
        )}
        {loops.status === 'ready' && loops.data.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {loops.data.map((loop: LoopSpec) => {
              const lineage = lineages?.[loop.id] ?? null;
              const rowStatus = deriveLoopStatus(loop.id, active, lineage);
              const selected = loop.id === selectedId;
              return (
                <li key={loop.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(loop.id)}
                    aria-pressed={selected}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                      selected
                        ? 'border-sky-500/30 bg-sky-500/[0.08]'
                        : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {loop.builtin && (
                          <Lock
                            className="h-3 w-3 shrink-0 text-foreground/40"
                            aria-label="Built-in system loop — locked"
                          />
                        )}
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {loop.name}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {loop.builtin && (
                          <Chip tone="sky" className="uppercase tracking-wide">
                            system
                          </Chip>
                        )}
                        <StatusPill
                          severity={STATUS_SEVERITY[rowStatus]}
                          label={STATUS_LABEL[rowStatus]}
                        />
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-foreground/55">
                      <span className="rounded bg-white/[0.05] px-1.5 py-0.5 uppercase tracking-wide">
                        {loop.kind}
                      </span>
                      <span className="truncate">{lastRunLabel(lineage)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PanelShell>
  );
}
