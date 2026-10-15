import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, KanbanSquare, Plus, Sparkles } from 'lucide-react';
import { aceApi } from '../lib/ace-api';
import type { AgentLane } from '../lib/agent-lanes';
import { chooseActiveAgentLane, sortAgentLanes } from '../lib/agent-lanes';
import { ACTIVE_AGENT_LANE_STORAGE_KEY } from '../lib/agent-control';
import { getOperator } from '../lib/operators';
import type { OperatorsConfig } from '../lib/operators';
import { cn } from '../lib/utils';
import { useOperators } from '../runtime/operators-registry';
import AgentLogo from './ProviderGlyph';
import { AgentLaneCreateDialog } from './agents/AgentLaneCreateDialog';
import { AgentLaneScreen } from './agents/AgentLaneScreen';
import { useApp } from '../store';

// Shared with the Operations "Agent Control" panel (src/lib/agent-control.ts)
// so its "Open lane" action lands on the same restored tab.
const ACTIVE_AGENT_STORAGE_KEY = ACTIVE_AGENT_LANE_STORAGE_KEY;

function readInitialLaneId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function laneIcon(lane: AgentLane) {
  if (lane.providerKind === 'hermes-profile' || lane.providerKind === 'builtin-personal') {
    return Sparkles;
  }
  return Bot;
}

// Identity glyph for personal lanes whose personal-identity metadata matches a
// configured operator with an identity mark (e.g. a migrated install's ♜/♔).
function laneOperatorGlyph(lane: AgentLane, config: OperatorsConfig): string | null {
  if (lane.providerKind !== 'builtin-personal') return null;
  const operator = getOperator(config, lane.metadata?.personalIdentity);
  const emoji = typeof operator?.emoji === 'string' ? operator.emoji.trim() : '';
  return emoji || null;
}

function laneAgentLabel(lane: AgentLane) {
  return String(lane.agent || 'agent');
}

function laneProfileLabel(lane: AgentLane) {
  if (lane.providerKind === 'hermes-profile') return lane.profileId || 'profile';
  if (lane.providerKind === 'builtin-personal') return 'personal';
  return 'native';
}

function listAgentLanes() {
  return aceApi.agentLanes.list();
}

export function AgentsScreen() {
  const operators = useOperators();
  const { setView } = useApp();
  const [lanes, setLanes] = useState<AgentLane[]>([]);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(readInitialLaneId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refreshLanes = useCallback(async () => {
    const next = sortAgentLanes(await listAgentLanes());
    setError(null);
    setLanes(next);
    setActiveLaneId((current) => chooseActiveAgentLane(next, current)?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    listAgentLanes()
      .then((raw) => {
        if (cancelled) return;
        const next = sortAgentLanes(raw);
        setError(null);
        setLanes(next);
        setActiveLaneId((current) => chooseActiveAgentLane(next, current)?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      if (activeLaneId) window.localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, activeLaneId);
      else window.localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY);
    } catch {
      // Tab persistence is convenience-only.
    }
  }, [activeLaneId]);

  const sortedLanes = useMemo(() => sortAgentLanes(lanes), [lanes]);
  const activeLane = chooseActiveAgentLane(sortedLanes, activeLaneId);

  const handleCreated = (lane: AgentLane) => {
    setDialogOpen(false);
    setLanes((current) => sortAgentLanes([...current.filter((item) => item.id !== lane.id), lane]));
    setActiveLaneId(lane.id);
    void refreshLanes();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto">
          {sortedLanes.map((lane) => {
            const Icon = laneIcon(lane);
            const glyph = laneOperatorGlyph(lane, operators);
            const selected = activeLane?.id === lane.id;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => setActiveLaneId(lane.id)}
                aria-pressed={selected}
                title={`${lane.label} · ${laneAgentLabel(lane)} · ${laneProfileLabel(lane)}`}
                className={cn(
                  'group flex min-w-[9rem] max-w-[12rem] shrink-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors sm:min-w-[11rem] sm:max-w-[16rem]',
                  selected
                    ? 'border-sky-200/20 bg-white/[0.08] text-foreground'
                    : 'border-white/[0.07] bg-white/[0.025] text-foreground/65 hover:border-white/[0.13] hover:bg-white/[0.04] hover:text-foreground'
                )}
              >
                {lane.providerKind === 'native-orchestrator' ? (
                  <AgentLogo agent={lane.agent} className="h-5 w-5 shrink-0" />
                ) : glyph ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center text-[15px] leading-none',
                      selected ? 'text-sky-200' : 'text-foreground/55'
                    )}
                  >
                    {glyph}
                  </span>
                ) : (
                  <Icon className={cn('h-5 w-5 shrink-0', selected ? 'text-sky-200' : 'text-foreground/55')} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium leading-tight">{lane.label}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-foreground/45">
                    <span className="truncate">{laneAgentLabel(lane)}</span>
                    <span className="text-foreground/25">/</span>
                    <span className="truncate">{laneProfileLabel(lane)}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-foreground/45">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      lane.autoStart ? 'bg-emerald-300/80' : 'bg-foreground/25'
                    )}
                    aria-label={lane.autoStart ? `${lane.label} auto-starts` : `${lane.label} does not auto-start`}
                  />
                  {lane.autoStart ? 'live' : 'manual'}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          title="Open Run Board"
          aria-label="Open Run Board"
          onClick={() => setView('board')}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-white/[0.07] px-2.5 text-xs font-medium text-foreground/65 transition-colors hover:border-white/[0.13] hover:bg-white/[0.04] hover:text-foreground"
        >
          <KanbanSquare className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Run Board</span>
        </button>
        <button
          type="button"
          title="Add orchestrator agent"
          aria-label="Add orchestrator agent"
          onClick={() => setDialogOpen(true)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-foreground/50">Loading agent lanes…</div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-sm text-rose-300/85">{error}</div>
            <button
              type="button"
              onClick={() => void refreshLanes()}
              className="rounded-lg bg-white/[0.06] px-3 py-2 text-sm text-foreground/70 hover:bg-white/[0.10]"
            >
              Retry
            </button>
          </div>
        ) : activeLane ? (
          <AgentLaneScreen key={activeLane.id} lane={activeLane} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <Sparkles className="h-8 w-8 text-sky-300/80" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">No orchestrator agents configured yet.</h2>
              <p className="mt-1 max-w-md text-sm text-foreground/55">
                Add Hermes, a Hermes profile, or Claude Code as a persistent Ace agent lane.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-400/15 px-4 py-2 text-sm font-medium text-sky-100 hover:bg-sky-400/25"
            >
              <Plus className="h-4 w-4" />
              Add orchestrator agent
            </button>
          </div>
        )}
      </div>

      <AgentLaneCreateDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
