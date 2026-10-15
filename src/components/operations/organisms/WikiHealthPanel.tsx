import { useCallback, useEffect, useState } from 'react';
import { BookText, RefreshCw } from 'lucide-react';
import type { KnowledgeNightlyStatus, OpsStatusResult, OpsWikiHealth } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { formatRelativeTime } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { StatusPill } from '../atoms/StatusPill';
import { InfoTip } from '../atoms/InfoTip';
import { ErrorState, LoadingState } from '../atoms/states';
import { SNAPSHOT_SENTINEL } from '../molecules/SnapshotBanner';
import type { Severity } from '../severity';

// AceWikiHealth/v1 — the shape `ace wiki health` / `memory status`
// return (single-sourced in electron/harness/knowledge-contract.cts). Optional
// here: when supplied (e.g. by a wiki-health slice) the panel renders the real
// metrics; otherwise it falls back to the ops-status wiki/snapshot warnings.
export interface WikiHealthMetrics {
  severity?: 'green' | 'amber' | 'black';
  dumpOnlyProjects?: string[];
  canonPages?: number;
  dumpRecords?: number;
  stalePages?: number;
  sourceCoverage?: number;
  rawVsCanonRatio?: number | null;
  lastNightlyAt?: string | null;
  indexFreshness?: string;
  candidatesAccepted?: number;
  candidatesRejected?: number;
  inboxPending?: number;
  flags?: string[];
}

// Pure view-model: turn the metrics object into a small list of labelled rows
// plus a severity, so the rendering is trivial and unit-testable.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveWikiHealthView(metrics: WikiHealthMetrics | null | undefined): {
  severity: Severity;
  rows: Array<{ label: string; value: string }>;
  flags: string[];
} | null {
  if (!metrics) return null;
  const severity: Severity = metrics.severity === 'black' ? 'black' : metrics.severity === 'amber' ? 'yellow' : 'green';
  const ratio = metrics.rawVsCanonRatio;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Dump-only projects', value: String(metrics.dumpOnlyProjects?.length ?? 0) },
    { label: 'Canon pages', value: String(metrics.canonPages ?? 0) },
    { label: 'Raw : canon', value: ratio === null || ratio === undefined ? '—' : `${ratio}` },
    { label: 'Source coverage', value: metrics.sourceCoverage === undefined ? '—' : `${Math.round(metrics.sourceCoverage * 100)}%` },
    { label: 'Stale pages', value: String(metrics.stalePages ?? 0) },
    { label: 'Inbox pending', value: String(metrics.inboxPending ?? 0) },
    { label: 'Last nightly', value: metrics.lastNightlyAt ? metrics.lastNightlyAt.slice(0, 10) : 'never' },
    { label: 'Index freshness', value: metrics.indexFreshness ?? 'unknown' },
  ];
  return { severity, rows, flags: metrics.flags ?? [] };
}

// Wiki write health. The wiki truth contract makes a wiki write FAILURE the
// only `black` finding (catastrophic / fail-closed). The panel SELF-FETCHES live
// AceWikiHealth/v1 metrics via aceApi.ops.wikiHealth() (parity with
// WikiGraphPanel) and renders them (dump-only count, raw-vs-canon, source
// coverage, last nightly, …). When metrics are unavailable it falls back to the
// ops-status snapshot warnings. A `wikiHealth` prop overrides the fetch (tests).
//
// D12 calm contract: when healthy this renders NOTHING but a single quiet line.
function WikiHealthContent({
  slice,
  wikiHealth,
}: {
  slice?: SliceState<OpsStatusResult | null>;
  wikiHealth?: OpsWikiHealth | null;
}) {
  // `undefined` = not yet fetched (loading); an explicit prop skips the fetch.
  const [fetched, setFetched] = useState<OpsWikiHealth | null | undefined>(undefined);

  useEffect(() => {
    if (wikiHealth !== undefined) return; // explicit prop wins (tests / callers)
    let cancelled = false;
    aceApi.ops
      .wikiHealth()
      .then((h) => {
        if (!cancelled) setFetched(h ?? null);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wikiHealth]);

  const metrics = wikiHealth !== undefined ? wikiHealth : fetched;
  const view = deriveWikiHealthView(metrics);

  // Metrics path: render the real wiki-health numbers when supplied.
  if (view) {
    if (view.severity === 'green') {
      return <p className="text-xs text-foreground/55">Wiki healthy · canon-first · last nightly ok</p>;
    }
    return (
      <PanelShell>
        <SectionHeader
          title="Wiki Health"
          icon={BookText}
          tone="amber"
          leading={<StatusPill severity={view.severity} />}
          actions={<InfoTip label="Health of the Markdown canon + knowledge index: dump-only projects (no canon), raw-vs-canon ratio, source coverage, stale pages, inbox backlog, and last nightly. Markdown canon is the source of truth; the index is a disposable helper." />}
        />
        <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {view.rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-foreground/55">{row.label}</span>
              <span className="font-mono text-code text-foreground/80">{row.value}</span>
            </div>
          ))}
        </div>
        {view.flags.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {view.flags.map((flag, index) => (
              <div
                key={`${index}:${flag}`}
                className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                <p className="min-w-0 break-words font-mono text-code text-amber-200">{flag}</p>
              </div>
            ))}
          </div>
        )}
      </PanelShell>
    );
  }

  // Still fetching live metrics (no explicit prop, no slice fallback resolved
  // yet) → quiet loading line.
  if (metrics === undefined && !slice) {
    return <LoadingState label="Checking wiki health…" className="justify-start py-1" />;
  }

  // Fallback path (metrics unavailable): ops-status wiki/snapshot warnings.
  const warnings = slice?.data?.warnings ?? [];
  const wikiWarnings = warnings.filter((w) => /wiki|snapshot/i.test(w));
  const sentinelSeen = wikiWarnings.some((w) => w.includes(SNAPSHOT_SENTINEL));
  const severity: Severity = sentinelSeen ? 'black' : 'yellow';

  // Healthy / no slice → one quiet line, no panel chrome.
  if (!slice || (slice.status === 'ready' && wikiWarnings.length === 0)) {
    return <p className="text-xs text-foreground/55">Wiki healthy · last snapshot ok</p>;
  }

  // Loading → quiet too; the full panel only materializes for real findings.
  if (slice.status === 'loading') {
    return <LoadingState label="Checking wiki health…" className="justify-start py-1" />;
  }

  return (
    <PanelShell>
      <SectionHeader
        title="Wiki Health"
        icon={BookText}
        tone="amber"
        leading={slice.status === 'ready' ? <StatusPill severity={severity} /> : null}
        actions={
          <InfoTip label="Tracks whether wiki snapshot writes are succeeding. Only distilled summaries reach current-state.md; a failed wiki write is the most severe finding here and marks the page non-authoritative until the next successful write." />
        }
      />
      {slice.status === 'error' && (
        <ErrorState message={slice.error ?? 'Failed to load wiki health.'} />
      )}
      {slice.status === 'ready' &&
        (sentinelSeen ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 ring-1 ring-rose-500/40">
            <p className="font-mono text-[13px] font-semibold text-rose-200">{SNAPSHOT_SENTINEL}</p>
            <p className="mt-1 text-xs text-foreground/70">
              This section is non-authoritative. Do not infer current state from it.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {wikiWarnings.map((warning, index) => (
              <div
                key={`${index}:${warning}`}
                className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2"
              >
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  aria-hidden="true"
                />
                <p className="min-w-0 break-words font-mono text-code text-amber-200">{warning}</p>
              </div>
            ))}
          </div>
        ))}
    </PanelShell>
  );
}

// Nightly knowledge loop — a single folded status line (last run + status) with
// a "Reindex now" action. This is the surviving summary from the retired
// KnowledgeNightlyPanel: the 03:30 loop (reindex → audit → decay → quarantine →
// curation → report) is deterministic and proposals-only, so the Knowledge tab
// only needs its last-run status here rather than a full panel.
function NightlyStatusLine() {
  const [status, setStatus] = useState<KnowledgeNightlyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);

  // Initial state is loading; the effect only calls setState inside the async
  // callbacks (react-hooks effect rule).
  const refresh = useCallback(() => {
    aceApi.knowledge
      .nightlyStatus()
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const reindexNow = useCallback(() => {
    setReindexing(true);
    aceApi.knowledge
      .reindex()
      .catch(() => {})
      .finally(() => {
        setReindexing(false);
        refresh();
      });
  }, [refresh]);

  const state = status?.state ?? null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/55">
      <span className="font-medium text-foreground/45">Nightly loop</span>
      {loading ? (
        <span>checking…</span>
      ) : status?.disabled ? (
        <span className="text-amber-200">disabled via ACE_KNOWLEDGE_NIGHTLY_DISABLE</span>
      ) : state ? (
        <span>
          last run {formatRelativeTime(state.at)} — {state.status}
          {state.error ? `: ${state.error}` : ''}
        </span>
      ) : (
        <span>no run recorded yet — first runs at 03:30 local time</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={reindexNow}
        disabled={reindexing}
        className="ml-auto h-6 gap-1 px-2 text-xs text-foreground/70"
        title="Rebuild the knowledge index now"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        {reindexing ? 'Reindexing…' : 'Reindex now'}
      </Button>
    </div>
  );
}

// Wiki write health + the folded nightly-loop status line. The health summary
// stays calm (one quiet line when healthy, a full panel only for real
// findings); the nightly line always shows the last-run status + Reindex.
export function WikiHealthPanel(props: {
  slice?: SliceState<OpsStatusResult | null>;
  wikiHealth?: OpsWikiHealth | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <WikiHealthContent {...props} />
      <NightlyStatusLine />
    </div>
  );
}
