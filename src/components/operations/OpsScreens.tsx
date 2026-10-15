import { useCallback, useState, type ReactNode } from 'react';
import { Activity, ChevronRight, RefreshCcw, BookOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { TooltipProvider } from '../ui/tooltip';
import { useApp } from '../../store';
import {
  useOperationsData,
  refreshOperationsStatus,
  type SliceState,
} from '../../runtime/operations-registry';
import { useIsMobileViewport } from '../../runtime/use-mobile-viewport';
import { cn } from '../../lib/utils';
import type { OpsBrief } from '../../lib/ace-api';
import { asSeverity } from './severity';
import { StatusPill } from './atoms/StatusPill';
import { FreshnessLabel } from './atoms/FreshnessLabel';
import { SystemHealthPanel } from './organisms/SystemHealthPanel';
import { ServicesPanel } from './organisms/ServicesPanel';
import { VectorOpsPanel } from './organisms/VectorOpsPanel';
import { IntelHub } from './intel/IntelHub';
import { WikiHealthPanel } from './organisms/WikiHealthPanel';
import { BriefsTab } from './organisms/BriefsTab';
import { OpsTab } from './organisms/OpsTab';
import { TodosPanel } from './organisms/TodosPanel';
import { WikiGraphPanel } from './organisms/WikiGraphPanel';
import { KnowledgeSearchPanel } from './organisms/KnowledgeSearchPanel';
import { KnowledgeQuarantinePanel } from './organisms/KnowledgeQuarantinePanel';
import { SourcesPanel } from './organisms/SourcesPanel';
import { AgentsPanel } from './organisms/AgentsPanel';

// ─── Promoted Operations surfaces ────────────────────────────────────────────
// The 6-sub-tab Operations hub was retired; each kept feature is now its own
// top-level surface, composing the SAME existing panels/organisms (no rewrite,
// same data wiring). Board (run-ledger) + Todos fold in from Home/Today
// deep-links; Monitor / Intel / Knowledge are top-level nav tabs. Tickets moved
// out entirely to the embedded Sky tab (SkyScreen).

// Scrolling tab body: full-width (no wasted side gutters), one spacing rhythm.
function ScrollPanel({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex w-full flex-col gap-4 px-5 py-5">{children}</div>
    </div>
  );
}

// Mobile Intel: Briefs + Vector Ops + Sources share one parent scroll so nothing
// is lost on a phone (desktop mounts the unified IntelHub instead).
function MobileIntelPanel({ slice }: { slice: SliceState<OpsBrief | null> }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex w-full flex-col gap-4 px-3 py-4 sm:px-5">
        <BriefsTab slice={slice} />
        <VectorOpsPanel embedded />
        <SourcesPanel />
      </div>
    </div>
  );
}

// Owner decision: keep the wiki graph/browser, but collapsed. WikiGraphPanel
// self-fetches its graph + renders a large SVG on mount, so we gate it behind
// a lazy mount — `graphOpen && <WikiGraphPanel />` — meaning NO wikiGraph fetch
// and NO SVG render until the operator expands the section.
function CollapsedWikiGraph() {
  const [graphOpen, setGraphOpen] = useState(false);
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={graphOpen}
        onClick={() => setGraphOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-foreground/40 motion-safe:transition-transform motion-safe:duration-150',
            graphOpen && 'rotate-90'
          )}
          aria-hidden="true"
        />
        <span className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
          <BookOpen className="h-4 w-4 text-foreground/50" aria-hidden="true" />
          Wiki graph &amp; browser
        </span>
        <span className="ml-auto text-xs text-foreground/45">{graphOpen ? 'Hide' : 'Show'}</span>
      </button>
      {graphOpen && (
        <div className="border-t border-white/[0.06] p-3">
          <WikiGraphPanel />
        </div>
      )}
    </div>
  );
}

// Board — the read-only run-ledger Kanban with a thin "Needs you" attention
// strip above it. OpsTab owns the shared board fetch + its own scroll. The
// attention strip's only navigation target is Monitor (severity / live-agent
// chips), so onNavigate routes there.
export function BoardScreen() {
  const state = useOperationsData();
  const { setView } = useApp();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <OpsTab state={state} onNavigate={() => setView('monitor')} />
      </div>
    </TooltipProvider>
  );
}

// Todos — Chief's intake (ace.ops.todo.v1), the full dense TodosPanel organism.
export function TodosScreen() {
  return (
    <TooltipProvider delayDuration={200}>
      <ScrollPanel>
        <TodosPanel />
      </ScrollPanel>
    </TooltipProvider>
  );
}

// Monitor — the merged Agents panel first (per-agent liveness + telemetry + safe
// lane controls), then the health/services grid. Keeps the
// header rollup pill + freshness clocks + manual Refresh that used to live on
// the retired hub header, since this is the operations-status surface.
export function MonitorScreen() {
  const state = useOperationsData();
  const status = state.status.data;
  const globalRollup = asSeverity(status?.rollup?.severity);

  // Snapshot "last" clock — the freshest non-live finding timestamp.
  const snapshotAt = (() => {
    let newest: string | null = null;
    for (const finding of status?.findings ?? []) {
      if (finding.isLive) continue;
      const at = finding.evidence?.lastChecked ?? null;
      if (at && (!newest || at > newest)) newest = at;
    }
    return newest;
  })();

  const handleRefresh = useCallback(() => {
    void refreshOperationsStatus();
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-white/[0.06] px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Activity className="h-5 w-5 text-sky-200" aria-hidden="true" />
              <h1 className="text-base font-semibold text-foreground">Monitor</h1>
              {state.status.status === 'ready' && status && (
                <StatusPill severity={globalRollup} size="lg" />
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end gap-0.5">
                <FreshnessLabel
                  timestamp={state.lastRefreshedAt}
                  freshness="live"
                  prefix="LIVE as-of"
                />
                <FreshnessLabel timestamp={snapshotAt} prefix="Snapshot" />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={state.refreshing}
                className="h-8 gap-1.5 px-2.5 text-xs"
                title="Refresh probes"
              >
                {state.refreshing ? (
                  <Spinner size="sm" className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Refresh
              </Button>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ScrollPanel>
            {/* Agents (dissolved Agents tab): one panel, one shared fetch —
                per-agent liveness + telemetry + safe Open/Stop/Restart. */}
            <AgentsPanel />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <SystemHealthPanel slice={state.status} />
              <ServicesPanel slice={state.status} />
            </div>
          </ScrollPanel>
        </div>
      </div>
    </TooltipProvider>
  );
}

// Intel — the unified IntelHub (Brief / Intel / Sources behind a segmented
// sub-nav) on desktop; mobile keeps its stacked panel so nothing is lost.
export function IntelScreen() {
  const state = useOperationsData();
  const isMobile = useIsMobileViewport();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {isMobile ? <MobileIntelPanel slice={state.brief} /> : <IntelHub />}
      </div>
    </TooltipProvider>
  );
}

// Knowledge — slimmed knowledge plane: search, wiki write health, quarantine
// review (renders only when non-empty), and the Obsidian-style browser/graph
// behind a collapsed, lazy-mounted section (no fetch / no SVG render until
// expanded).
export function KnowledgeScreen() {
  return (
    <TooltipProvider delayDuration={200}>
      <ScrollPanel>
        <KnowledgeSearchPanel />
        <WikiHealthPanel />
        <KnowledgeQuarantinePanel />
        <CollapsedWikiGraph />
      </ScrollPanel>
    </TooltipProvider>
  );
}
