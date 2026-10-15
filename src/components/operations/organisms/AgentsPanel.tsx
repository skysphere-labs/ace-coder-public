import { useCallback, useEffect, useState } from 'react';
import { Bot, ExternalLink, Info, RefreshCcw, Square } from 'lucide-react';
import type { AgentLane } from '../../../lib/agent-lanes';
import type { StreamEntry, TelemetryAggregateRow } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import {
  ACTIVE_AGENT_LANE_STORAGE_KEY,
  joinLanesWithStreams,
  laneProviderLabel,
  streamStateTone,
  type AgentLaneControlRow,
} from '../../../lib/agent-control';
import { getAgentAccentColor } from '../../../lib/agent-style';
import { useApp } from '../../../store';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/spinner';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { Chip } from '../atoms/Chip';
import { Identifier } from '../atoms/Identifier';
import { IdentityMark } from '../atoms/IdentityMark';
import { InfoTip } from '../atoms/InfoTip';
import { KeyValue } from '../atoms/KeyValue';
import { EmptyState, ErrorState, LoadingState } from '../atoms/states';
import { ConfirmDialog } from '../molecules/ConfirmDialog';
import { OverflowMenu, type OverflowMenuItem } from '../molecules/OverflowMenu';
import { EvidenceDrawer } from './EvidenceDrawer';

// AgentsPanel — the single Operations → Monitor agents organism. Merges the old
// AgentActivityPanel (per-agent liveness + 24h telemetry) and AgentControlPanel
// (safe Open / Stop / Restart actions) into ONE panel with ONE shared fetch:
// agentLanes.list + streams.listStreams + telemetry.aggregate('agent') pulled
// together, instead of the two panels each fetching lanes + streams separately.
//
// One row per lane, agent-first: identity mark + agent, the lane's live stream
// state, its 24h telemetry (events / errors), and the lane's actions. Every
// action routes through an EXISTING safe API — Open navigates to the lane, Stop
// closes the lane's tracked stream (confirm-gated), Restart goes through the
// Hermes app sidecar manager (stop + ensure). No raw process control; lanes
// without a tracked stream stay status read-only on purpose.

const TELEMETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

type ConfirmAction =
  | { kind: 'stop-stream'; row: AgentLaneControlRow }
  | { kind: 'restart-app' };

// Per-row Details target for the shared EvidenceDrawer (machine internals —
// stream ids / workspace — live here, not on the row).
type DrawerTarget = { kind: 'lane'; row: AgentLaneControlRow };

function SubHeader({ label }: { label: string }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-foreground/45">{label}</span>
  );
}

// One lane row: agent identity + live stream state + 24h telemetry + actions.
function AgentLaneRow({
  row,
  telemetry,
  onOpen,
  onStop,
  onDetails,
}: {
  row: AgentLaneControlRow;
  telemetry: TelemetryAggregateRow | null;
  onOpen: (lane: AgentLane) => void;
  onStop: (row: AgentLaneControlRow) => void;
  onDetails: (row: AgentLaneControlRow) => void;
}) {
  const agent = String(row.lane.agent || 'agent');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 transition-colors hover:border-white/[0.1]">
      <IdentityMark name={agent} accentColor={getAgentAccentColor(agent)} />
      <span
        className="min-w-0 truncate text-[13px] text-foreground/85"
        title={[agent, laneProviderLabel(row.lane), row.workspace].filter(Boolean).join(' · ')}
      >
        {row.lane.label}
      </span>
      {/* 24h telemetry for this lane's agent — only when the spine has rows;
          absent data renders nothing (never fabricated). */}
      {telemetry ? (
        <span className="text-xs tabular-nums text-foreground/55">
          {telemetry.count} events · {telemetry.errors} err (24h)
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5">
        <Chip tone={streamStateTone(row.streamState)}>{row.streamState}</Chip>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpen(row.lane)}
          className="h-6 gap-1 px-1.5 text-xs"
          title="Open this lane on the Agents screen"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          Open
        </Button>
        <OverflowMenu
          ariaLabel={`More actions for ${row.lane.label}`}
          items={[
            {
              key: 'details',
              label: 'Details',
              icon: Info,
              onSelect: () => onDetails(row),
            },
            ...(row.live && row.stream
              ? [
                  {
                    key: 'stop',
                    label: 'Stop',
                    icon: Square,
                    destructive: true,
                    title: "Close this lane's tracked terminal stream",
                    onSelect: () => onStop(row),
                  } satisfies OverflowMenuItem,
                ]
              : []),
          ]}
        />
      </span>
    </div>
  );
}

export function AgentsPanel() {
  const { setView } = useApp();
  const [lanes, setLanes] = useState<AgentLane[]>([]);
  const [streams, setStreams] = useState<StreamEntry[]>([]);
  const [telemetryByAgent, setTelemetryByAgent] = useState<Map<string, TelemetryAggregateRow>>(
    () => new Map()
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [acting, setActing] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);

  // ONE fetch for the whole panel: lanes + streams + telemetry pulled together.
  // Each slice degrades independently (Promise.allSettled) so one failing IPC
  // never blanks the panel.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [laneResult, streamResult, telemetryResult] = await Promise.allSettled([
      aceApi.agentLanes.list(),
      aceApi.streams.listStreams(),
      aceApi.telemetry.aggregate('agent', { sinceMs: Date.now() - TELEMETRY_WINDOW_MS }),
    ]);
    try {
      if (laneResult.status === 'rejected') {
        throw laneResult.reason instanceof Error
          ? laneResult.reason
          : new Error(String(laneResult.reason));
      }
      setLanes(laneResult.value);
      setStreams(streamResult.status === 'fulfilled' ? streamResult.value.streams : []);
      const rows =
        telemetryResult.status === 'fulfilled' && telemetryResult.value.ok
          ? telemetryResult.value.rows
          : [];
      setTelemetryByAgent(new Map(rows.map((r) => [r.key, r])));
      setStatus('ready');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openLane = useCallback(
    (lane: AgentLane) => {
      try {
        window.localStorage.setItem(ACTIVE_AGENT_LANE_STORAGE_KEY, lane.id);
      } catch {
        // Persistence is convenience-only; navigation still lands on Agents.
      }
      setView('hermes');
    },
    [setView]
  );

  const runConfirmed = useCallback(async () => {
    if (!confirm) return;
    setActing(true);
    try {
      if (confirm.kind === 'stop-stream' && confirm.row.stream) {
        await aceApi.streams.close(confirm.row.stream.streamId);
      } else if (confirm.kind === 'restart-app') {
        await aceApi.hermesDesktop.restart();
      }
    } catch {
      // The refresh below reflects whatever actually happened.
    } finally {
      setActing(false);
      setConfirm(null);
      void refresh();
    }
  }, [confirm, refresh]);

  const rows = joinLanesWithStreams(lanes, streams);

  return (
    <PanelShell>
      <SectionHeader
        title="Agents"
        icon={Bot}
        tone="emerald"
        actions={
          <>
            <InfoTip label="The agent lanes Ace tracks, with per-lane live stream state and 24h telemetry (events / errors). Every action routes through an existing Ace API — Stop closes a tracked stream and Restart goes through the Hermes app sidecar manager. No raw process control." />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="h-7 gap-1 px-2 text-xs"
              title="Refresh agents"
            >
              {refreshing ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : (
                <RefreshCcw className="h-3 w-3" aria-hidden="true" />
              )}
              Refresh
            </Button>
          </>
        }
      />
      <p className="-mt-2 text-xs text-foreground/65">
        Which agents are tracked, whether each is live, its 24h telemetry, and safe lane controls
      </p>

      {status === 'loading' && <LoadingState />}
      {status === 'error' && <ErrorState message={error ?? 'Failed to load agents.'} />}

      {status === 'ready' && (
        <div className="flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150">
          {/* ── Agent lanes ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <SubHeader label="Agent lanes" />
            {rows.length === 0 ? (
              <EmptyState
                label="No agent lanes configured"
                hint="Add orchestrator lanes from the Agents screen."
              />
            ) : (
              rows.map((row) => (
                <AgentLaneRow
                  key={row.lane.id}
                  row={row}
                  telemetry={telemetryByAgent.get(String(row.lane.agent || '')) ?? null}
                  onOpen={openLane}
                  onStop={(r) => setConfirm({ kind: 'stop-stream', row: r })}
                  onDetails={(r) => setDrawer({ kind: 'lane', row: r })}
                />
              ))
            )}
            <p className="text-xs text-foreground/50">
              Lanes without a tracked stream are read-only here — lane processes are managed from the
              Agents screen, not this panel.
            </p>
          </div>

          {/* ── Hermes app sidecar (global restart) ───────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <SubHeader label="Hermes app sidecar" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirm({ kind: 'restart-app' })}
                className="h-6 px-1.5 text-xs"
                title="Restart the always-on Hermes app sidecar through the manager (stop + ensure)"
              >
                Restart app sidecar
              </Button>
            </div>
            <p className="text-xs text-foreground/60">
              Backend process rows were retired with the monitoring collector. Restart still uses the
              sidecar manager when the Teams surface needs a fresh app backend.
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'stop-stream'
            ? `Stop ${confirm.row.lane.label}'s stream?`
            : 'Restart the Hermes app sidecar?'
        }
        body={
          confirm?.kind === 'stop-stream'
            ? 'Closes the lane’s tracked terminal stream through the existing stream API. The lane row stays and can be reopened from the Agents screen.'
            : 'Stops the always-on Hermes app sidecar and immediately ensures a fresh one through the existing manager. In-flight Hermes turns on that sidecar are interrupted.'
        }
        riskTier="low"
        showGuardrails={false}
        destructive={confirm?.kind !== 'restart-app'}
        confirmLabel={confirm?.kind === 'restart-app' ? 'Restart' : 'Stop'}
        busy={acting}
        onConfirm={() => void runConfirmed()}
        onCancel={() => {
          if (!acting) setConfirm(null);
        }}
      />

      <EvidenceDrawer
        open={drawer !== null}
        eyebrow="Agent lane"
        title={drawer?.kind === 'lane' ? drawer.row.lane.label : ''}
        onClose={() => setDrawer(null)}
      >
        {drawer?.kind === 'lane' && (
          <div className="flex flex-col gap-0.5">
            <KeyValue label="Agent">{String(drawer.row.lane.agent || 'agent')}</KeyValue>
            <KeyValue label="Provider">{laneProviderLabel(drawer.row.lane)}</KeyValue>
            <KeyValue label="Workspace">{drawer.row.workspace ?? '—'}</KeyValue>
            <KeyValue label="Stream state">{drawer.row.streamState}</KeyValue>
            {drawer.row.stream && (
              <KeyValue label="Stream id">
                <Identifier value={drawer.row.stream.streamId} />
              </KeyValue>
            )}
          </div>
        )}
      </EvidenceDrawer>
    </PanelShell>
  );
}
