import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Database,
  Loader2,
  Terminal,
} from 'lucide-react';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { StatusPill } from '../atoms/StatusPill';
import { EmptyState } from '../atoms/states';
import { Button } from '../../ui/button';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { asSeverity } from '../severity';
import { aceApi } from '../../../lib/ace-api';
import type {
  LoopSpec,
  LoopLineage,
  LoopIteration,
  LoopStopState,
} from '../../../runtime/loops-registry';

// ─── LiveRunPane ──────────────────────────────────────────────────────────────
// Right pane (PRD §6): per-iteration GUI status cards for the selected loop's live
// lineage — state, evidence summary, spend/runtime — plus a "watch terminal"
// drill-in affordance that opens the loop's lane in the Loops workspace. The
// drill-in target is stubbed for now (Slice 1): it emits a window event the shell
// can later route; we never make the terminal the primary surface.

// Terminal stop-states that read as a clean pass vs a block.
const PASS_STATES: LoopStopState[] = ['DONE', 'CLEAN_NOOP', 'READY_FOR_REVIEW'];
const BLOCK_STATES: LoopStopState[] = [
  'BLOCKED',
  'STALLED_NO_PROGRESS',
  'NEEDS_OWNER_DECISION',
  'UNSAFE_REQUIRES_APPROVAL',
];

type IterTone = 'running' | 'pass' | 'blocked' | 'idle';

function iterationTone(iter: LoopIteration): IterTone {
  if (iter.stopState == null) {
    // No terminal yet: if the worker is mid-flight, it's running.
    return iter.workerDone ? 'idle' : 'running';
  }
  if (PASS_STATES.includes(iter.stopState)) return 'pass';
  if (BLOCK_STATES.includes(iter.stopState)) return 'blocked';
  return 'idle';
}

const TONE_META: Record<
  IterTone,
  { Icon: typeof CheckCircle2; ring: string; text: string; label: string }
> = {
  running: {
    Icon: Loader2,
    ring: 'border-sky-500/30 bg-sky-500/[0.06]',
    text: 'text-sky-200',
    label: 'Running',
  },
  pass: {
    Icon: CheckCircle2,
    ring: 'border-emerald-500/30 bg-emerald-500/[0.06]',
    text: 'text-emerald-200',
    label: 'Pass',
  },
  blocked: {
    Icon: CircleSlash,
    ring: 'border-rose-500/30 bg-rose-500/[0.06]',
    text: 'text-rose-200',
    label: 'Blocked',
  },
  idle: {
    Icon: CircleDashed,
    ring: 'border-white/[0.08] bg-white/[0.02]',
    text: 'text-foreground/60',
    label: 'Idle',
  },
};

function evidenceSummary(iter: LoopIteration): string {
  const parts: string[] = [];
  parts.push(`worker:${iter.workerOutcome || (iter.workerDone ? 'done' : 'running')}`);
  if (iter.validatorOutcome || iter.validatorDone) {
    parts.push(`validator:${iter.validatorOutcome || (iter.validatorDone ? 'done' : '…')}`);
  }
  if (iter.computerUseEvidence) parts.push('computer-use ✓');
  if (iter.prExists) parts.push(iter.merged ? 'merged' : 'PR open');
  if (iter.reportPath) parts.push(`report:${iter.reportPath}`);
  return parts.join(' · ');
}

function IterationCard({
  iter,
  onWatch,
}: {
  iter: LoopIteration;
  onWatch: (iter: LoopIteration) => void;
}) {
  const tone = iterationTone(iter);
  const meta = TONE_META[tone];
  const { Icon } = meta;
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-md border px-3 py-2.5', meta.ring)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            className={cn('h-4 w-4 shrink-0', meta.text, tone === 'running' && 'animate-spin')}
            aria-hidden="true"
          />
          <span className="text-[13px] font-medium text-foreground">
            Iteration {iter.index + 1}
          </span>
          <span className={cn('text-xs font-medium', meta.text)}>{meta.label}</span>
        </div>
        {iter.runId && (
          <span className="font-mono text-xs text-foreground/45">{iter.runId}</span>
        )}
      </div>

      <p className="font-mono text-xs leading-relaxed text-foreground/65">
        {evidenceSummary(iter)}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-foreground/55">
        <span className="tabular-nums">${iter.spendUsd.toFixed(2)} spend</span>
        <span className="tabular-nums">{iter.tokens.toLocaleString()} tok</span>
        {iter.fixbackAttempts > 0 && (
          <span className="tabular-nums">{iter.fixbackAttempts} fixback</span>
        )}
        {iter.stopState && <span className="font-mono">{iter.stopState}</span>}
      </div>

      <div className="pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onWatch(iter)}
          className="h-6 gap-1 px-1.5 text-xs text-foreground/60 hover:text-foreground"
          title="Open this iteration's lane in the Loops workspace"
        >
          <Terminal className="h-3 w-3" aria-hidden="true" />
          Watch terminal
        </Button>
      </div>
    </div>
  );
}

// Open the loop's lane for watching. Emits a window event the shell routes. The
// loop's CONTROL surface is always the Loops workspace; for a cross-workspace loop
// (PRD §9 Slice 4) the iteration EXECUTES in target.workspace, so we carry both:
// controlWorkspace='loops' (where to surface) + targetWorkspace (where the lane
// actually runs). Never throws if no listener is attached.
function openLoopLane(loop: LoopSpec, iter: LoopIteration) {
  if (typeof window === 'undefined') return;
  const targetWorkspace = loop.routing.target.workspace || loop.routing.workspace;
  window.dispatchEvent(
    new CustomEvent('ace:loops:watch-terminal', {
      detail: {
        loopId: loop.id,
        controlWorkspace: loop.routing.workspace,
        targetWorkspace,
        runId: iter.runId ?? null,
      },
    })
  );
}

// ─── System run history (PRD §10 / GRILLED DESIGN #2) ──────────────────────────
// A kind==='system' loop has no agent iterations. Instead we render ONE result
// card per run — a one-line digest ("scanned N DBs · swept M temp dirs ·
// integrity ok") + timestamp — and a short run-history list, both folded from
// loopStatus().system (state = latest run, history = the ndjson tail). The
// scheduler record shape: { at, source, status, rollup, dbCount, tmpLeak,
// tmpSweepable, swept, error }.

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v ? v : fallback;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Build the one-line result summary from a run record, tolerant of missing
// fields (different system loops persist different shapes).
function runSummary(run: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof run.dbCount === 'number') parts.push(`scanned ${run.dbCount} DB${run.dbCount === 1 ? '' : 's'}`);
  if (typeof run.swept === 'number') parts.push(`swept ${run.swept} temp dir${run.swept === 1 ? '' : 's'}`);
  if (typeof run.tmpSweepable === 'number' && run.dbCount != null)
    parts.push(`${num(run.tmpSweepable)} sweepable`);
  if (run.status === 'error') parts.push(`error: ${str(run.error, 'unknown')}`);
  else if (run.rollup) parts.push(`integrity ${str(run.rollup) === 'green' ? 'ok' : str(run.rollup)}`);
  return parts.length > 0 ? parts.join(' · ') : 'completed';
}

function SystemResultCard({ run, latest }: { run: Record<string, unknown>; latest?: boolean }) {
  const at = str(run.at);
  const isErr = run.status === 'error';
  const severity = isErr ? 'red' : asSeverity(str(run.rollup, 'green'));
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-3 py-2.5',
        isErr ? 'border-rose-500/30 bg-rose-500/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          <Database
            className={cn('h-3.5 w-3.5 shrink-0', isErr ? 'text-rose-300' : 'text-sky-300/80')}
            aria-hidden="true"
          />
          {latest ? 'Latest run' : 'Run'}
        </span>
        <StatusPill severity={severity} label={isErr ? 'error' : 'ok'} />
      </div>
      <p className="font-mono text-xs leading-relaxed text-foreground/70">{runSummary(run)}</p>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-foreground/55">
        {at && (
          <span className="tabular-nums" title={at}>
            {formatRelativeTime(at) || at}
          </span>
        )}
        {run.source && <span className="font-mono">via {str(run.source)}</span>}
      </div>
    </div>
  );
}

function SystemRunPane({ loop }: { loop: LoopSpec }) {
  const [systemLoad, setSystemLoad] = useState<{
    loopId: string;
    system: Record<string, unknown> | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    aceApi.loops
      .status({ id: loop.id })
      .then((res) => {
        if (cancelled) return;
        setSystemLoad({
          loopId: loop.id,
          system: (res?.system ?? null) as Record<string, unknown> | null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSystemLoad({ loopId: loop.id, system: null });
      });
    return () => {
      cancelled = true;
    };
  }, [loop.id]);

  const loaded = systemLoad?.loopId === loop.id;
  const system = loaded ? systemLoad.system : null;
  const state = (system?.state ?? null) as Record<string, unknown> | null;
  const history = Array.isArray(system?.history)
    ? (system!.history as Array<Record<string, unknown>>)
    : [];
  // History newest-last → show newest first; drop the latest (rendered as the
  // result card) from the trailing list.
  const past = history.slice().reverse();
  const trailing = state ? past.slice(1) : past;

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title="Last run"
        icon={Activity}
        tone="sky"
        actions={
          loop.schedule ? (
            <span className="font-mono text-xs text-foreground/55">{loop.schedule}</span>
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <EmptyState label="Loading run state…" />
        ) : !state && history.length === 0 ? (
          <EmptyState
            label="No runs yet"
            hint="This maintenance loop records a result card here after its first run."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {state && <SystemResultCard run={state} latest />}
            {trailing.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-wide text-foreground/45">
                  Run history
                </span>
                <ol className="flex flex-col gap-1">
                  {trailing.slice(0, 12).map((run, i) => {
                    const at = str(run.at);
                    const isErr = run.status === 'error';
                    return (
                      <li
                        key={`${at}:${i}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5 text-xs text-foreground/60"
                      >
                        <span className="min-w-0 truncate" title={runSummary(run)}>
                          {runSummary(run)}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {at && (
                            <span className="tabular-nums text-foreground/45" title={at}>
                              {formatRelativeTime(at) || at}
                            </span>
                          )}
                          <StatusPill
                            severity={isErr ? 'red' : asSeverity(str(run.rollup, 'green'))}
                            label={isErr ? 'error' : 'ok'}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

export function LiveRunPane({
  loop,
  lineage,
  isRunning,
}: {
  loop: LoopSpec | null;
  lineage: LoopLineage | null;
  isRunning: boolean;
}) {
  // System loops have no agent iterations — render the result-card + history view.
  if (loop && loop.kind === 'system') {
    return <SystemRunPane loop={loop} />;
  }

  if (!loop) {
    return (
      <PanelShell className="h-full min-h-0">
        <SectionHeader title="Live run" icon={Activity} />
        <div className="flex flex-1 items-center justify-center">
          <EmptyState label="No loop selected" hint="Run a loop to watch its iterations here." />
        </div>
      </PanelShell>
    );
  }

  const iterations = lineage?.iterations ?? [];

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title="Live run"
        icon={Activity}
        tone={isRunning ? 'sky' : 'neutral'}
        actions={
          lineage ? (
            <span
              className="max-w-[18rem] truncate font-mono text-xs text-foreground/55 tabular-nums"
              title={lineage.lastReportPath || lineage.lastArtifactPath || undefined}
            >
              {lineage.lastArtifactPath
                ? lineage.lastArtifactPath
                : `$${lineage.totalSpendUsd.toFixed(2)} · ${lineage.totalTokens.toLocaleString()} tok`}
            </span>
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {iterations.length === 0 ? (
          <EmptyState
            label={isRunning ? 'Starting first iteration…' : 'No iterations yet'}
            hint={isRunning ? undefined : 'Press Run on the detail pane to start this loop.'}
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {iterations.map((iter) => (
              <li key={`${iter.index}-${iter.runId ?? 'pending'}`}>
                <IterationCard iter={iter} onWatch={(it) => openLoopLane(loop, it)} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </PanelShell>
  );
}
