import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid, Maximize2, X } from 'lucide-react';
import { aceApi, type StreamEntry, type StreamState } from '../lib/ace-api';
import { getAgentAccentColor, getTerminalBackground } from '../lib/agent-style';
import type { Workspace } from '../lib/types';
import { isAceChatAgent } from '../runtime/ace-chat-mode-registry';
import { useCoreSelectorEq, type CoreState } from '../runtime/core-registry';
import { deepEqual } from '../runtime/create-snapshot-store';
import { useApp } from '../store';
import { cn } from '../lib/utils';
import AgentLogo from './ProviderGlyph';
import { TerminalFeed } from './TerminalFeed';
import { Spinner } from './ui/spinner';
import {
  buildLaneTiles,
  groupBands,
  isLiveEntry,
  splitRows,
  type LaneTile,
  type ValidatorLink,
} from '../lib/lane-deck-model';

// Lane Deck — every CLI lane of one workspace tiled in a single view.
// Claude lanes fill the top band, Codex lanes the bottom, anything else in
// between. The layout is fixed math (no draggable splitters), so tiles only
// change size when the window or the lane count does — TerminalFeed's settled
// ResizeObserver fit handles those transitions without shredding the TUIs.
//
// This component is the data wiring (selectors + stream-liveness catalog);
// everything visual lives in LaneDeckBody, which is pure props and covered by
// lane-deck-screen.render.test.tsx.
export function LaneDeckScreen({ workspace }: { workspace: Workspace }) {
  const { openTask, toggleLaneDeck } = useApp();

  const selectValidatorLinks = useCallback(
    (s: CoreState): ValidatorLink[] =>
      s.missions
        .filter((mission) => mission.workspaceId === workspace.id)
        .flatMap((mission) => mission.features)
        .filter((feature) => feature.validatorTaskId)
        .map((feature) => ({
          validatorTaskId: feature.validatorTaskId as string,
          targetTaskId: feature.taskId ?? null,
          featureName: feature.name,
        })),
    [workspace.id]
  );
  const validatorLinks = useCoreSelectorEq(selectValidatorLinks, deepEqual);

  const tiles = useMemo(
    () => buildLaneTiles(workspace.tasks, validatorLinks, isAceChatAgent),
    [workspace.tasks, validatorLinks]
  );

  // Live-stream catalog. `null` until the first snapshot lands so tiles don't
  // flash dormant→live on open. Refreshed on stream state-change events
  // (debounced — a busy deck would otherwise refetch per output burst) plus a
  // slow visibility-gated poll as a safety net for spawn/exit transitions
  // that don't emit a state-change.
  const [liveById, setLiveById] = useState<Record<string, StreamEntry> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let debounceTimer: number | null = null;
    const refresh = () => {
      aceApi.streams
        .listStreams()
        .then(({ streams }) => {
          if (cancelled) return;
          const next: Record<string, StreamEntry> = {};
          for (const entry of streams) next[entry.streamId] = entry;
          setLiveById(next);
        })
        .catch(() => {
          if (!cancelled) setLiveById((prev) => prev ?? {});
        });
    };
    const scheduleRefresh = () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        refresh();
      }, 300);
    };
    refresh();
    const unsubscribe = aceApi.streams.onEvent((payload) => {
      if (payload?.event === 'state-change') scheduleRefresh();
    });
    const poll = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 15_000);
    return () => {
      cancelled = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [workspace.id]);

  return (
    <LaneDeckBody
      workspaceName={workspace.name}
      tiles={tiles}
      liveById={liveById}
      onExpand={(tile) => openTask(workspace.id, tile.taskId)}
      onExit={() => toggleLaneDeck(workspace.id)}
    />
  );
}

export function LaneDeckBody({
  workspaceName,
  tiles,
  liveById,
  onExpand,
  onExit,
}: {
  workspaceName: string;
  tiles: LaneTile[];
  liveById: Record<string, StreamEntry> | null;
  onExpand: (tile: LaneTile) => void;
  onExit: () => void;
}) {
  const bands = useMemo(() => groupBands(tiles), [tiles]);
  const liveCount =
    liveById === null
      ? 0
      : tiles.filter((tile) => isLiveEntry(liveById[tile.streamId])).length;

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: getTerminalBackground() }}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ace-accent))]" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground/90">
          {workspaceName}
        </span>
        <span className="shrink-0 text-[11px] text-foreground/40">
          Lane Deck
          {tiles.length > 0 && liveById !== null && (
            <> · {liveCount}/{tiles.length} live</>
          )}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onExit}
          title="Back to single lane"
          className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Exit deck
        </button>
      </header>

      {tiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <LayoutGrid className="h-6 w-6 text-foreground/20" />
          <p className="text-xs text-foreground/45">
            No lanes in this workspace yet — start a task and it will show up here.
          </p>
        </div>
      ) : liveById === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="lg" className="text-muted-foreground" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
          {bands.map((band) => (
            <DeckBand
              key={band.id}
              label={band.label}
              tiles={band.tiles}
              liveById={liveById}
              onExpand={onExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Keep these in sync with the DeckBand markup below: the band header is h-4
// (16px) and the section uses gap-1.5 (6px) between its children (1 header +
// N rows → N gaps).
const BAND_HEADER_PX = 16;
const BAND_GAP_PX = 6;

function DeckBand({
  label,
  tiles,
  liveById,
  onExpand,
}: {
  label: string;
  tiles: LaneTile[];
  liveById: Record<string, StreamEntry>;
  onExpand: (tile: LaneTile) => void;
}) {
  const rows = splitRows(tiles);
  const accent = getAgentAccentColor(tiles[0].agent);
  return (
    // flex-basis absorbs the band's fixed overhead (header + gaps) and
    // flex-grow distributes the remaining height by row count, so tiles come
    // out the same height across bands. No min-h-0 here: the section must
    // keep its natural min-height (header + each row's 150px floor) so a
    // short viewport makes the deck scroll instead of letting rows collapse
    // into — and overlap — the band below.
    <section
      className="flex flex-col gap-1.5"
      style={{
        flexGrow: rows.length,
        flexBasis: BAND_HEADER_PX + BAND_GAP_PX * rows.length,
      }}
    >
      <div className="flex h-4 shrink-0 items-center gap-1.5 px-1">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
        <span className="select-none text-[10px] font-semibold uppercase tracking-wider text-foreground/35">
          {label} · {tiles.length} {tiles.length === 1 ? 'lane' : 'lanes'}
        </span>
      </div>
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex min-h-[150px] flex-1 gap-1.5">
          {row.map((tile) => (
            <DeckTile
              key={tile.key}
              tile={tile}
              entry={liveById[tile.streamId]}
              onExpand={() => onExpand(tile)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function DeckTile({
  tile,
  entry,
  onExpand,
}: {
  tile: LaneTile;
  entry: StreamEntry | undefined;
  onExpand: () => void;
}) {
  const live = isLiveEntry(entry);
  const accent = getAgentAccentColor(tile.agent);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/40">
      <div
        className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/30 px-2"
        style={{ boxShadow: `inset 2px 0 0 ${accent}` }}
      >
        <AgentLogo agent={tile.agent} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate text-[11px] font-medium text-foreground/85">
          {tile.label}
        </span>
        {tile.branch && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-foreground/35 xl:inline">
            {tile.branch}
          </span>
        )}
        {tile.validatorFor && (
          <span
            className="max-w-[40%] shrink-0 truncate rounded bg-violet-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-violet-300"
            title={`Validator lane — validating "${tile.validatorFor}"`}
          >
            validates · {tile.validatorFor}
          </span>
        )}
        <div className="flex-1" />
        <StateDot state={live ? entry!.state : null} />
        <button
          type="button"
          onClick={onExpand}
          title="Open this lane in full view"
          aria-label="Open this lane in full view"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {live ? (
          <TerminalFeed streamId={tile.streamId} interactive />
        ) : (
          <button
            type="button"
            onClick={onExpand}
            className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-foreground/30 transition-colors hover:text-foreground/60"
          >
            <AgentLogo agent={tile.agent} className="h-5 w-5 opacity-50" />
            <span className="text-[11px]">Not running — open the lane to start it</span>
          </button>
        )}
      </div>
    </div>
  );
}

const STATE_DOT: Record<StreamState, { className: string; label: string }> = {
  busy: { className: 'bg-[hsl(var(--ace-accent))] animate-pulse', label: 'Working' },
  booting: { className: 'bg-foreground/40 animate-pulse', label: 'Booting' },
  'awaiting-input': { className: 'bg-sky-400', label: 'Awaiting input' },
  'awaiting-approval': { className: 'bg-amber-400', label: 'Awaiting approval' },
  'turn-complete': { className: 'bg-emerald-400', label: 'Turn complete' },
  interrupted: { className: 'bg-rose-400', label: 'Interrupted' },
  error: { className: 'bg-rose-500', label: 'Error' },
  unknown: { className: 'bg-foreground/25', label: 'Live' },
};

function StateDot({ state }: { state: StreamState | null }) {
  const dot = state ? STATE_DOT[state] ?? STATE_DOT.unknown : null;
  return (
    <span
      title={dot ? dot.label : 'Not running'}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        dot ? dot.className : 'bg-foreground/15'
      )}
    />
  );
}
