import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radar,
  Package,
  FileClock,
  Rss,
  AtSign,
  Eye,
  TrendingUp,
  Newspaper,
  Globe,
  MessagesSquare,
  GraduationCap,
  Target,
  GitBranch,
  Flame,
  RefreshCcw,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { aceApi } from '../../../lib/ace-api';
import type { OpsIntel, OpsIntelProjectFit, OpsIntelSection } from '../../../lib/ace-api';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/spinner';
import { Chip } from '../atoms/Chip';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { CountBadge } from '../atoms/CountBadge';
import { Eyebrow } from '../atoms/Eyebrow';
import { KeyValue } from '../atoms/KeyValue';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { IntelFreshnessChip } from '../atoms/IntelFreshnessChip';
import { NewOnlyToggle } from '../atoms/NewOnlyToggle';
import { LoadingState, ErrorState, EmptyState } from '../atoms/states';
import {
  SectionJumpNav,
  SectionJumpRail,
  type JumpGroup,
} from '../molecules/SectionJumpNav';
import { IntelSectionCard } from '../molecules/IntelSectionCard';
import {
  itemSourceClass,
  sectionDisplayLabel,
  sectionSourceClass,
  type IntelSourceClass,
} from '../intel-labels';
import { IntelItemRow } from '../molecules/IntelItemRow';
import { EvidenceDrawer } from './EvidenceDrawer';

// Stable layout across refreshes (Proposal 3), regrouped by source class
// (PRD v2 D5): Top signals (curated) → GitHub → X/Social → News/HN →
// Research → Vendors. Unknown keys are appended in source order.
const SECTION_ORDER = [
  'top_signals',
  'github_watch',
  'github_trending',
  'platform_accounts',
  'world_news',
  'hackernews',
  'reddit',
  'arxiv',
  'vendor_updates',
  'platform_changelogs',
  'official_feeds',
] as const;

// Jump-nav feed grouping mirrors the body order — one labeled group per
// source-class lane (D5).
const FEED_GROUP_ORDER: ReadonlyArray<{ eyebrow: string; classes: IntelSourceClass[] }> = [
  { eyebrow: 'GitHub', classes: ['github'] },
  { eyebrow: 'X / Social', classes: ['social'] },
  { eyebrow: 'News & HN', classes: ['news', 'hackernews', 'reddit'] },
  { eyebrow: 'Research', classes: ['research'] },
  { eyebrow: 'Vendors', classes: ['vendor'] },
];

// key → lucide icon map (module const).
const ICON_BY_KEY: Record<string, LucideIcon> = {
  top_signals: Radar,
  vendor_updates: Package,
  platform_changelogs: FileClock,
  official_feeds: Rss,
  platform_accounts: AtSign,
  github_watch: Eye,
  github_trending: TrendingUp,
  hackernews: Newspaper,
  world_news: Globe,
  reddit: MessagesSquare,
  arxiv: GraduationCap,
};

function iconFor(key: string): LucideIcon {
  return ICON_BY_KEY[key] ?? Radar;
}

// FIX 3: top-level intel provenance (external is the calm default → no chip).
// Additive backend field, read via a local widening so ace-api stays untouched.
const PROVENANCE_LABEL: Record<string, string> = {
  local: 'local pull',
  merged: 'report + local pull',
  missing: 'no external report',
};

// VectorOpsPanel — ONE self-fetching organism. intel() is NOT a registry slice,
// so it self-fetches with local loading/error/empty state, mirroring
// SourcesPanel's load()/useCallback/useEffect shape. Renders the full Vector Ops
// dashboard: prices ticker, hero, sticky jump-nav, hot app, project fit/moves,
// all feed sections, and the embedded editable Sources watchlist.
export function VectorOpsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  // ── Load state ────────────────────────────────────────────────────────────
  // intel() is NOT a registry slice → self-fetch. Status starts 'loading' and
  // setState only ever fires inside async .then/.catch under a cancelled guard,
  // so the mount effect never calls setState synchronously
  // (react-hooks/set-state-in-effect).
  const [intel, setIntel] = useState<OpsIntel | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping this re-runs the fetch effect (retry without synchronous setState).
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    aceApi.ops
      .intel()
      .then((result) => {
        if (cancelled) return;
        setIntel(result);
        setLoadError(null);
        setLoadState('idle');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load Vector Ops intel.');
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  // Retry is a click handler (not an effect), so synchronous setState is fine.
  const retry = useCallback(() => {
    setLoadState('loading');
    setLoadError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  // ── Manual source refresh (success state) ─────────────────────────────────
  // ops.refresh() is LONG-RUNNING (the research-agent leg can take minutes):
  // the button disables + spins while busy and the panel stays interactive.
  // On completion (success OR failure) the existing intel fetch re-runs so
  // whatever DID land is shown; a result-level error surfaces inline.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const rootClassName = embedded ? 'overflow-visible' : 'h-full overflow-y-auto';
  const contentClassName = embedded
    ? 'flex w-full flex-col gap-4'
    : 'flex w-full flex-col gap-4 px-5 py-5';

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await aceApi.ops.refresh();
      if (result.error) setRefreshError(result.error);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
      setReloadNonce((n) => n + 1);
    }
  }, []);

  // Scheduled/manual refreshes broadcast ops:intel-refreshed — re-fetch the
  // intel so the dashboard never silently rots while the tab is open.
  useEffect(() => {
    const unsubscribe = aceApi.ops.onIntelRefreshed(() => {
      setReloadNonce((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [newOnly, setNewOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['top_signals']));
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Project Fit detail (why/moves/mission template) lives in the EvidenceDrawer;
  // level 1 keeps only name + priority/fit chips. The template text is
  // drawer-only (C2).
  const [fitDetail, setFitDetail] = useState<OpsIntelProjectFit | null>(null);
  const closeFitDetail = useCallback(() => setFitDetail(null), []);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Derived: ordered feed sections (stable layout) ────────────────────────
  const orderedSections = useMemo<OpsIntelSection[]>(() => {
    if (!intel) return [];
    const rank = (key: string) => {
      const i = SECTION_ORDER.indexOf(key as (typeof SECTION_ORDER)[number]);
      return i === -1 ? SECTION_ORDER.length : i;
    };
    return [...intel.sections]
      .map((s, srcIndex) => ({ s, srcIndex }))
      .sort((a, b) => {
        const ra = rank(a.s.key);
        const rb = rank(b.s.key);
        if (ra !== rb) return ra - rb;
        return a.srcIndex - b.srcIndex;
      })
      .map(({ s }) => s);
  }, [intel]);

  // ── Derived: jump-nav groups ──────────────────────────────────────────────
  const jumpGroups = useMemo<JumpGroup[]>(() => {
    if (!intel) return [];
    const feedEntry = (s: OpsIntelSection) => ({
      key: s.key,
      // C2: never let a raw feed key leak into the nav spine.
      label: sectionDisplayLabel(s),
      count: s.items.length,
      newCount: s.items.filter((i) => i.isNew).length,
    });

    const intelligence: JumpGroup['entries'] = [];
    const topSignals = orderedSections.find((s) => s.key === 'top_signals');
    if (topSignals) intelligence.push(feedEntry(topSignals));
    if (intel.hotAiApp) {
      intelligence.push({
        key: 'hot_app',
        label: 'Hot App',
        count: 1,
        newCount: intel.hotAiApp.isNew ? 1 : 0,
      });
    }
    intelligence.push({
      key: 'project_fit',
      label: 'Project Fit',
      count: intel.projectFit.length,
      newCount: 0,
    });
    intelligence.push({
      key: 'project_moves',
      label: 'Project Moves',
      count: intel.projectMoves.facts.length + intel.projectMoves.suggestions.length,
      newCount: 0,
    });

    // D5: feeds group by source class, mirroring the body order. Unknown keys
    // (class 'signal' outside top_signals) land in a trailing Other group.
    const feedSections = orderedSections.filter((s) => s.key !== 'top_signals');
    const groups: JumpGroup[] = [{ eyebrow: 'Signals', entries: intelligence }];
    for (const { eyebrow, classes } of FEED_GROUP_ORDER) {
      const entries = feedSections
        .filter((s) => classes.includes(sectionSourceClass(s.key)))
        .map(feedEntry);
      if (entries.length > 0) groups.push({ eyebrow, entries });
    }
    const knownClasses = new Set(FEED_GROUP_ORDER.flatMap((g) => g.classes));
    const other = feedSections
      .filter((s) => !knownClasses.has(sectionSourceClass(s.key)))
      .map(feedEntry);
    if (other.length > 0) groups.push({ eyebrow: 'Other feeds', entries: other });

    // Sources/watchlist moved to the dedicated Sources tab — no Config group.
    return groups;
  }, [intel, orderedSections]);

  // ── Active-anchor tracking (DOM-side-effect only — setState lives inside the
  // IntersectionObserver callback, mirroring OpsTabBar discipline, so this does
  // not trip react-hooks/set-state-in-effect). The observer is rooted on the
  // panel-owned scroller (NOT the viewport): the Intel tabpanel is
  // overflow-hidden on desktop and mobile, so a viewport root would never see
  // sections intersect. ──────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!intel) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[id^="vo-"]'));
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveKey(entry.target.id.replace(/^vo-/, ''));
            break;
          }
        }
      },
      { root: scrollRef.current, rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [intel, newOnly]);

  // ── States up front (each inside the panel-owned scroll root so the tab
  // scrolls on desktop AND mobile — the tabpanel parent is overflow-hidden). ──
  if (loadState === 'loading') {
    return (
      <div className={rootClassName}>
        <div className={contentClassName}>
          <LoadingState />
        </div>
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className={rootClassName}>
        <div className={contentClassName}>
          <ErrorState
            message={loadError ?? 'Failed to load Vector Ops intel.'}
            action={
              <Button variant="outline" size="sm" onClick={retry} className="mt-1 text-xs">
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }
  if (intel === null) {
    return (
      <div className={rootClassName}>
        <div className={contentClassName}>
          <EmptyState
            label="No intel yet"
            hint="The Vector Ops pipeline hasn't produced a report — check back after the next sync."
          />
        </div>
      </div>
    );
  }

  return (
    // Panel-owned scroll root: the sticky jump-nav sticks within this scroller
    // and the IntersectionObserver above is rooted on it.
    <div ref={scrollRef} className={rootClassName}>
      <div className={contentClassName}>
        {/* Body — the sticky jump-nav rail + feed content. The old full-width hero
            (exec summary, Rook's read, metrics, applies-to) and the price ticker
            were removed per design; the essential controls (freshness, New filter,
            Refresh) now sit in a slim strip atop the content column so the rail
            stays clean and sticky from the very top. */}
        <div className="flex gap-5">
          <SectionJumpNav groups={jumpGroups} activeKey={activeKey} newOnly={newOnly} />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* Slim control strip — freshness + New filter + Refresh (the only
                survivors of the removed hero), aligned to the content top so the
                jump-nav rail stays clean alongside it. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <IntelFreshnessChip
                  freshness={intel.sourceFreshness}
                  intelAsOf={intel.generatedAt}
                />
                {intel.lastRefreshAt && (
                  <FreshnessLabel timestamp={intel.lastRefreshAt} prefix="pulled" />
                )}
                {(() => {
                  const provenance = (intel as OpsIntel & { provenance?: string }).provenance;
                  return provenance && PROVENANCE_LABEL[provenance] ? (
                    <span title="Where this intel came from">
                      <Chip tone="neutral">{PROVENANCE_LABEL[provenance]}</Chip>
                    </span>
                  ) : null;
                })()}
                {(intel as OpsIntel & { judged?: boolean }).judged && (
                  <span
                    className="text-xs text-foreground/50"
                    title="A headless judgment pass deduped, filtered, and authored the why/move/next on these items"
                  >
                    AI-reviewed
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <NewOnlyToggle value={newOnly} onChange={setNewOnly} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRefresh()}
                  disabled={refreshing}
                  title="Pull every source now — can take a few minutes when the research agent runs"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  {refreshing ? (
                    <Spinner size="sm" className="h-3 w-3" />
                  ) : (
                    <RefreshCcw className="h-3 w-3" aria-hidden="true" />
                  )}
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
            </div>
            {refreshError && (
              <p className="text-xs leading-snug text-rose-200">Refresh failed — {refreshError}</p>
            )}

            {/* below-lg chip-rail */}
            <SectionJumpRail groups={jumpGroups} activeKey={activeKey} newOnly={newOnly} />

            {/* (3a) Hot App — the hottest item of the day should READ as hot:
                stronger sky ring + a chip that says what this section is. */}
            {intel.hotAiApp && (
              <PanelShell id="vo-hot_app" className="scroll-mt-4 ring-1 ring-sky-500/40">
                <SectionHeader
                  title="Hot App"
                  icon={Flame}
                  leading={<Chip tone="sky">hottest this cycle</Chip>}
                />
                <IntelItemRow
                  item={intel.hotAiApp}
                  // Curated key → refine the badge from the item's own provenance.
                  sourceClass={itemSourceClass(intel.hotAiApp, 'top_signals')}
                  emphasized
                />
              </PanelShell>
            )}

          {/* (3b) Project Fit — compact summary rows (name + priority/fit
              chips); the full readout (why, moves, mission template) opens in
              the EvidenceDrawer below. */}
          <PanelShell id="vo-project_fit" className="scroll-mt-4">
            <SectionHeader
              title="Project Fit"
              icon={Target}
              leading={<CountBadge count={intel.projectFit.length} />}
            />
            {intel.projectFit.length === 0 ? (
              <p className="text-xs text-foreground/50">No project fits in this report.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {intel.projectFit.map((fit, i) => (
                  <button
                    key={`${i}:${fit.project}`}
                    type="button"
                    onClick={() => setFitDetail(fit)}
                    className="group flex w-full items-center gap-1.5 rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-2 text-left transition-colors hover:border-white/[0.1] hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground/90 group-hover:text-sky-100">
                      {fit.project}
                    </span>
                    {/* Pills carry their own labels — never bare enum values. */}
                    {fit.priority && (
                      <Chip
                        tone={fit.priority.toLowerCase() === 'high' ? 'amber' : 'neutral'}
                        className="shrink-0"
                      >
                        priority {fit.priority}
                      </Chip>
                    )}
                    {fit.fit && <Chip className="shrink-0">fit {fit.fit}</Chip>}
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-foreground/40 transition-colors group-hover:text-foreground/70"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            )}
          </PanelShell>

          {/* (3c) Project Moves */}
          <PanelShell id="vo-project_moves" className="scroll-mt-4">
            <SectionHeader title="Project Moves" icon={GitBranch} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Facts</Eyebrow>
                {intel.projectMoves.facts.length === 0 ? (
                  <p className="text-xs text-foreground/50">No facts in this report.</p>
                ) : (
                  intel.projectMoves.facts.map((fact, i) => (
                    <p key={i} className="max-w-[72ch] text-[13px] leading-relaxed text-foreground/75">
                      {fact}
                    </p>
                  ))
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Suggestions</Eyebrow>
                {intel.projectMoves.suggestions.length === 0 ? (
                  <p className="text-xs text-foreground/50">No suggestions in this report.</p>
                ) : (
                  intel.projectMoves.suggestions.map((s, i) => (
                    <p key={i} className="max-w-[72ch] text-[13px] leading-relaxed text-sky-200">
                      → {s}
                    </p>
                  ))
                )}
              </div>
            </div>
          </PanelShell>

          {/* (3d) Feed sections — top_signals is the curated spine, so its rows
              render emphasized; raw feeds stay compact. */}
          {orderedSections.map((s) => (
            <IntelSectionCard
              key={s.key}
              section={s}
              icon={iconFor(s.key)}
              newOnly={newOnly}
              expanded={expanded.has(s.key)}
              onToggle={() => toggleExpanded(s.key)}
              emphasized={s.key === 'top_signals'}
            />
          ))}
          {/* Sources/watchlist moved to the dedicated Sources tab. */}
        </div>
      </div>
      </div>

      {/* Project Fit detail blade — why/moves plus the mission template, which
          is machine text and therefore drawer-only (C2). */}
      {fitDetail && (
        <EvidenceDrawer
          open
          title={fitDetail.project}
          eyebrow="Project fit"
          onClose={closeFitDetail}
        >
          {(fitDetail.priority || fitDetail.fit) && (
            <div className="flex flex-col">
              {fitDetail.priority && <KeyValue label="Priority">{fitDetail.priority}</KeyValue>}
              {fitDetail.fit && <KeyValue label="Fit">{fitDetail.fit}</KeyValue>}
            </div>
          )}
          {fitDetail.why && (
            <div className="flex flex-col gap-1">
              <Eyebrow>Why</Eyebrow>
              <p className="text-[13px] leading-relaxed text-foreground/80">{fitDetail.why}</p>
            </div>
          )}
          {fitDetail.moves.length > 0 && (
            <div className="flex flex-col gap-1">
              <Eyebrow>Moves</Eyebrow>
              {fitDetail.moves.map((move, mi) => (
                <p key={mi} className="text-[13px] leading-snug text-sky-200">
                  → {move}
                </p>
              ))}
            </div>
          )}
          {fitDetail.missionTemplate && (
            <div className="flex flex-col gap-1">
              <Eyebrow>Mission template</Eyebrow>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-white/[0.06] bg-white/[0.03] px-3 py-2 font-mono text-xs leading-relaxed text-foreground/70">
                {fitDetail.missionTemplate}
              </pre>
            </div>
          )}
        </EvidenceDrawer>
      )}
    </div>
  );
}
