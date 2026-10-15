/**
 * vector-ops-adapter.cts
 *
 * Pure adapter: turns a configured daily report into Ace Operations
 * contract objects (ace.ops.brief.v1, OpsRecommendation[], OpsSignal[]).
 *
 * NO electron/store/IPC imports — only Node built-ins fs, os, path.
 * Zero hardcoded http(s) URLs or account ids.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Default data path (no literal home path — uses os.homedir() at runtime)
// ---------------------------------------------------------------------------

// Three-tier intel freshness (spec E2):
//   age < 12h          -> 'fresh'   (green)
//   12h <= age <= 24h  -> 'stale'   (yellow)
//   age > 24h          -> 'expired' (red)
//   absent/unreadable  -> 'missing'
type IntelFreshness = 'fresh' | 'stale' | 'expired' | 'missing';

const DEFAULT_STALE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 hours -> stale (yellow)
const DEFAULT_EXPIRED_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours -> expired (red)

function defaultReportPath(): string {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops', 'latest.json');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable slug: lowercase, non-alnum -> '-', trim dashes, max 40 chars.
 */
function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Tiered freshness for a generated_at timestamp. Unparseable or absent
 * timestamps map to 'expired' (unverifiable age is never fresh/live).
 */
function computeFreshness(
  generatedAt: string | null,
  now: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  expiredAfterMs: number = DEFAULT_EXPIRED_AFTER_MS,
): IntelFreshness {
  if (!generatedAt) return 'expired';
  const generatedMs = new Date(generatedAt).getTime();
  if (isNaN(generatedMs)) return 'expired';
  const ageMs = now - generatedMs;
  if (ageMs > expiredAfterMs) return 'expired';
  if (ageMs > staleAfterMs) return 'stale';
  return 'fresh';
}

/**
 * Parse a timestamp-ish value to a normalized ISO string, or null when
 * absent/unparseable. Timestamps are never fabricated (R3).
 */
function toIsoOrNull(value: any): string | null {
  if (!value) return null;
  const ms = new Date(String(value)).getTime();
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Newest parseable timestamp from a list, preserving the original string.
 */
function newestIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(String(v)).getTime();
    if (isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = String(v);
  }
  return best;
}

/**
 * Compact relative age from an injected epoch-ms `now` (no ambient clock):
 * 'just now' / '<n>m ago' / '<n>h ago' / '<n>d ago'. Null when unparseable.
 */
function relativeAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(String(iso)).getTime();
  if (isNaN(ms)) return null;
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// loadLatestReport
// ---------------------------------------------------------------------------

interface LoadedReport {
  report: any | null;
  prices: any[];
  freshness: IntelFreshness;
  intelAsOf: string | null;
  path: string;
}

function loadLatestReport(opts?: {
  path?: string;
  now?: number;
  staleAfterMs?: number;
  expiredAfterMs?: number;
}): LoadedReport {
  const filePath: string = opts?.path ?? defaultReportPath();
  const now: number = opts?.now ?? Date.now();
  const staleAfterMs: number = opts?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const expiredAfterMs: number = opts?.expiredAfterMs ?? DEFAULT_EXPIRED_AFTER_MS;

  try {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { report: null, prices: [], freshness: 'missing', intelAsOf: null, path: filePath };
    }

    const prices: any[] = Array.isArray(parsed?.prices) ? parsed.prices : [];
    const report: any = parsed?.report ?? null;
    if (!report) {
      return { report: null, prices, freshness: 'missing', intelAsOf: null, path: filePath };
    }

    const generatedAt: string | null = report.generated_at ?? null;
    const freshness: IntelFreshness = computeFreshness(generatedAt, now, staleAfterMs, expiredAfterMs);

    return { report, prices, freshness, intelAsOf: generatedAt, path: filePath };
  } catch {
    return { report: null, prices: [], freshness: 'missing', intelAsOf: null, path: filePath };
  }
}

// ---------------------------------------------------------------------------
// loadLocalIntel — locally pulled intel (ace.ops.intel-local.v1), written
// by ops-refresh.cts. The caller supplies the path (no electron access in
// this module); a missing path simply means local intel is absent.
// ---------------------------------------------------------------------------

function loadLocalIntel(opts?: { path?: string; now?: number }): {
  local: any | null;
  path: string | null;
} {
  const filePath: string | null = opts?.path ?? null;
  if (!filePath) return { local: null, path: null };
  try {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    const parsed: any = JSON.parse(raw);
    if (parsed?.$schema !== 'ace.ops.intel-local.v1') {
      return { local: null, path: filePath };
    }
    return { local: parsed, path: filePath };
  } catch {
    return { local: null, path: filePath };
  }
}

// ---------------------------------------------------------------------------
// synthesizeRecommendations
// ---------------------------------------------------------------------------

function synthesizeRecommendations(
  report: any | null,
  opts?: { intelAsOf?: string | null },
): any[] {
  if (!report) return [];

  const intelAsOf: string | null = opts?.intelAsOf ?? report.generated_at ?? null;
  const filePath: string = defaultReportPath();

  try {
    const recs: any[] = [];

    // Map project_fit items
    const projectFit: any[] = Array.isArray(report.project_fit) ? report.project_fit : [];
    for (const fit of projectFit) {
      try {
        const title: string = String(fit.project ?? 'Unknown project');
        const why: string = String(fit.why ?? '');
        const priority: string = String(fit.priority ?? '');
        const fitLevel: string = String(fit.fit ?? '');
        const moves: string[] = Array.isArray(fit.moves) ? fit.moves.map(String) : [];
        const missionTemplate: string = String(fit.mission_template ?? '');

        const slug = slugify(title);
        const id = `rec:vops:${slug}`;

        const risk: 'high' | 'medium' | 'low' =
          priority === 'P0' ? 'high' : priority === 'P1' ? 'medium' : 'low';

        const confidence: number =
          fitLevel === 'High' ? 0.8 : fitLevel === 'Med' || fitLevel === 'Medium' ? 0.6 : 0.4;

        const nextAction: string = moves[0] ?? why;

        recs.push({
          id,
          decision: 'ask',
          title,
          reason: why,
          owner: 'rook',
          nextAction,
          risk,
          severity: 'yellow',
          confidence,
          evidence: [
            {
              source: 'vector-ops',
              path: filePath,
              findingId: null,
              lastChecked: intelAsOf ?? new Date().toISOString(),
            },
          ],
          candidateMissionDraft: {
            workspaceId: '',
            name: `[VecOps] ${title}`,
            summary: missionTemplate || why,
            source: 'vector-ops',
            statusNote: 'CANDIDATE — from Vector Ops project_fit',
            nextAction,
          },
        });
      } catch {
        // skip malformed entry
      }
    }

    // Map new vendor_updates (is_new == true) as additional recommendations
    const vendorUpdates: any[] = Array.isArray(report.vendor_updates)
      ? report.vendor_updates
      : [];
    for (const update of vendorUpdates) {
      if (!update.is_new) continue;
      try {
        const vendor: string = String(update.vendor ?? update.label ?? 'Unknown vendor');
        const title: string = String(update.title ?? vendor);
        const why: string = String(update.summary ?? '');
        const slug = slugify(`vendor-${vendor}-${title}`);
        const id = `rec:vops:${slug}`;
        const nextAction: string = why;

        recs.push({
          id,
          decision: 'ask',
          title,
          reason: why,
          owner: 'rook',
          nextAction,
          risk: 'low' as const,
          severity: 'yellow',
          confidence: 0.4,
          evidence: [
            {
              source: 'vector-ops',
              path: filePath,
              findingId: null,
              lastChecked: intelAsOf ?? new Date().toISOString(),
            },
          ],
          candidateMissionDraft: {
            workspaceId: '',
            name: `[VecOps] ${title}`,
            summary: why,
            source: 'vector-ops',
            statusNote: 'CANDIDATE — from Vector Ops project_fit',
            nextAction,
          },
        });
      } catch {
        // skip
      }
    }

    // Map new platform_changelogs (is_new == true)
    const platformChangelogs: any[] = Array.isArray(report.platform_changelogs)
      ? report.platform_changelogs
      : [];
    for (const changelog of platformChangelogs) {
      if (!changelog.is_new) continue;
      try {
        const vendor: string = String(changelog.vendor ?? 'Unknown');
        const product: string = String(changelog.product ?? '');
        const title: string = String(changelog.title ?? `${vendor} ${product}`);
        const why: string = String(changelog.summary ?? '');
        const slug = slugify(`changelog-${vendor}-${title}`);
        const id = `rec:vops:${slug}`;
        const nextAction: string = why;

        recs.push({
          id,
          decision: 'ask',
          title,
          reason: why,
          owner: 'rook',
          nextAction,
          risk: 'low' as const,
          severity: 'yellow',
          confidence: 0.4,
          evidence: [
            {
              source: 'vector-ops',
              path: filePath,
              findingId: null,
              lastChecked: intelAsOf ?? new Date().toISOString(),
            },
          ],
          candidateMissionDraft: {
            workspaceId: '',
            name: `[VecOps] ${title}`,
            summary: why,
            source: 'vector-ops',
            statusNote: 'CANDIDATE — from Vector Ops project_fit',
            nextAction,
          },
        });
      } catch {
        // skip
      }
    }

    return recs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// synthesizeSignals
// ---------------------------------------------------------------------------

function synthesizeSignals(report: any | null, opts?: { intelAsOf?: string | null }): any[] {
  if (!report) return [];

  const intelAsOf: string | null = opts?.intelAsOf ?? report.generated_at ?? null;

  try {
    const signals: any[] = [];
    const topSignals: any[] = Array.isArray(report.top_signals) ? report.top_signals : [];

    for (const sig of topSignals) {
      try {
        const title: string = String(sig.title ?? 'Unknown signal');
        const slug = slugify(title);
        const id = `vops:${slug}`;
        const message: string = String(sig.summary ?? '');
        const url: string | null = sig.url ? String(sig.url) : null;
        const firstSeen: string | null = sig.first_seen ? String(sig.first_seen) : null;
        const lastChecked: string | null = firstSeen ?? intelAsOf;

        signals.push({
          id,
          source: 'vector-ops',
          severity: 'yellow',
          title,
          message,
          path: url,
          lastChecked,
          isLive: false,
        });
      } catch {
        // skip malformed
      }
    }

    return signals;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source state — per-source pull state ({ sources: [{ id, class, status,
// lastAttempt, lastSuccess, error, itemCount, label }] }) aggregated onto
// intel sections and the brief's Source freshness lines.
// ---------------------------------------------------------------------------

// Worst-first severity for aggregating multiple sources into one status.
const STATUS_RANK: Record<string, number> = { ok: 0, unavailable: 1, 'auth-needed': 2, error: 3 };

function aggregateSources(sources: any[]): {
  status: string | null;
  statusMessage: string | null;
  lastAttempt: string | null;
  lastSuccess: string | null;
} | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  let worst: any = sources[0];
  for (const s of sources) {
    if ((STATUS_RANK[String(s?.status)] ?? 0) > (STATUS_RANK[String(worst?.status)] ?? 0)) {
      worst = s;
    }
  }
  return {
    status: worst?.status ? String(worst.status) : null,
    statusMessage: worst?.error ? String(worst.error) : null,
    lastAttempt: newestIso(sources.map((s: any) => s?.lastAttempt)),
    lastSuccess: newestIso(sources.map((s: any) => s?.lastSuccess)),
  };
}

/**
 * The sources that feed a given intel section key (feed:* -> official_feeds,
 * repo:* -> github_watch, agent legs, report:finance -> prices).
 */
function sourcesForSection(sourceState: any, key: string): any[] {
  const sources: any[] = Array.isArray(sourceState?.sources) ? sourceState.sources : [];
  const id = (s: any): string => String(s?.id ?? '');
  switch (key) {
    case 'official_feeds':
      return sources.filter((s: any) => id(s).startsWith('feed:'));
    case 'github_watch':
      return sources.filter((s: any) => id(s).startsWith('repo:'));
    case 'platform_accounts':
      return sources.filter((s: any) => id(s) === 'agent:social');
    case 'world_news':
      return sources.filter((s: any) => id(s) === 'agent:news');
    case 'vendor_updates':
      return sources.filter((s: any) => id(s) === 'agent:vendors');
    case 'prices':
      return sources.filter((s: any) => id(s) === 'report:finance');
    default:
      return [];
  }
}

// Source class -> Chief-facing label for brief Source freshness lines.
const SOURCE_CLASS_LABELS: Record<string, string> = {
  feeds: 'Official feeds',
  repos: 'GitHub watch',
  accounts: 'Social / X',
  social: 'Social / X',
  news: 'World news',
  world_news: 'World news',
  vendors: 'Vendor updates',
  changelogs: 'Vendor updates',
  finance: 'Market prices',
};

/**
 * One compact, honest line per source class; 'Source pull state untracked'
 * when no per-source state exists.
 */
function buildSourceFreshnessSection(
  sourceState: any,
  now: number,
): { title: string; items: Array<{ text: string }> } {
  const sources: any[] = Array.isArray(sourceState?.sources) ? sourceState.sources : [];
  if (sources.length === 0) {
    return { title: 'Source freshness', items: [{ text: 'Source pull state untracked' }] };
  }
  const order: string[] = [];
  const groups = new Map<string, any[]>();
  for (const s of sources) {
    const cls = String(s?.class ?? 'unknown');
    if (!groups.has(cls)) {
      groups.set(cls, []);
      order.push(cls);
    }
    (groups.get(cls) as any[]).push(s);
  }
  const items = order.map((cls) => {
    const group = groups.get(cls) as any[];
    const agg = aggregateSources(group) as any;
    const label: string =
      SOURCE_CLASS_LABELS[cls] ??
      (group.length === 1 && group[0]?.label ? String(group[0].label) : cls);
    const status: string = agg.status ?? 'unknown';
    if (status === 'ok') {
      const age = relativeAge(agg.lastSuccess, now);
      return { text: age ? `${label} — ok, ${age}` : `${label} — ok` };
    }
    if (status === 'error' && agg.statusMessage) {
      return { text: `${label} — error: ${agg.statusMessage}` };
    }
    return { text: `${label} — ${status}` };
  });
  return { title: 'Source freshness', items };
}

// ---------------------------------------------------------------------------
// synthesizeBrief
// ---------------------------------------------------------------------------

// FIX 3: flatten the locally pulled intel (ace.ops.intel-local.v1) into brief
// item shape ({ text, url, why, move }), newest-first, capped. Used as the
// fallback body when the external report is expired/missing so a brief is never
// empty just because the external dashboard went stale. Never throws.
function buildLocalBriefItems(
  localIntel: any,
  max: number,
): Array<{ text: string; url: string | null; why: string | null; move: string | null }> {
  try {
    const sections: any[] = Array.isArray(localIntel?.sections) ? localIntel.sections : [];
    const all: Array<{ title: string; url: string | null; summary: string; ts: number }> = [];
    for (const sec of sections) {
      const items: any[] = Array.isArray(sec?.items) ? sec.items : [];
      for (const it of items) {
        const title = String(it?.title ?? '').trim();
        if (!title) continue;
        const tsIso = it?.timestamp ? new Date(String(it.timestamp)).getTime() : NaN;
        all.push({
          title,
          url: it?.url ? String(it.url) : null,
          summary: String(it?.summary ?? '').trim(),
          ts: Number.isNaN(tsIso) ? -Infinity : tsIso,
        });
      }
    }
    all.sort((a, b) => b.ts - a.ts); // newest first; undated sort last
    return all.slice(0, max).map((x) => ({
      text: x.title,
      url: x.url,
      why: x.summary || null,
      move: null,
    }));
  } catch {
    return [];
  }
}

function synthesizeBrief(
  report: any | null,
  lens: 'morning' | 'midday' | 'evening',
  opts: {
    now: number;
    sourceFreshness: IntelFreshness;
    intelAsOf: string | null;
    sourceState?: any | null;
    // FIX 3: locally pulled intel (ace.ops.intel-local.v1). When the external
    // report is expired/missing this is surfaced as the brief body so briefs
    // fall back to Ace's own live pull instead of stale/empty content.
    localIntel?: any | null;
  },
): any {
  const generatedAt = new Date(opts.now).toISOString();
  const recommendations: any[] = synthesizeRecommendations(report, { intelAsOf: opts.intelAsOf });
  const candidateCount = recommendations.length;
  const local = opts.localIntel ?? null;
  const externalStale = opts.sourceFreshness === 'expired' || opts.sourceFreshness === 'missing';

  if (!report) {
    // No external report at all — fall back entirely to local intel when present.
    const localItems = local ? buildLocalBriefItems(local, 8) : [];
    const sections: any[] = [];
    if (localItems.length > 0) {
      sections.push({ title: 'Local intel (live pull)', items: localItems });
    }
    if (opts.sourceState) sections.push(buildSourceFreshnessSection(opts.sourceState, opts.now));
    return {
      $schema: 'ace.ops.brief.v1',
      lens,
      generatedAt,
      intelAsOf: localItems.length > 0 ? (local?.generatedAt ?? null) : null,
      sourceFreshness: 'missing',
      // FIX 3: provenance so the UI can label where the body came from.
      provenance: localItems.length > 0 ? 'local' : 'missing',
      headline:
        localItems.length > 0
          ? 'External intel unavailable — showing locally pulled intel'
          : 'Intel unavailable',
      sections,
      deltaSummary: 'intel unavailable',
      candidateCount: 0,
    };
  }

  const intelAsOf = opts.intelAsOf;
  const newCount: number = typeof report.new_count === 'number' ? report.new_count : 0;
  const deltaSummary = `${newCount} new signals since last run`;
  const headline: string = String(report.executive_summary ?? 'No summary available');

  const sections: Array<{
    title: string;
    items: Array<{ text: string; url?: string | null; why?: string | null; move?: string | null }>;
  }> = [];

  if (lens === 'morning') {
    // New top_signals (is_new) section
    const newSignals: any[] = Array.isArray(report.top_signals)
      ? (report.top_signals as any[]).filter((s: any) => s.is_new)
      : [];
    if (newSignals.length > 0) {
      sections.push({
        title: 'New Signals',
        items: newSignals.map((s: any) => ({
          text: String(s.title ?? ''),
          url: s.url ? String(s.url) : null,
          why: s.why ? String(s.why) : null,
          move: s.move ? String(s.move) : null,
        })),
      });
    }

    // Top 3 project_fit moves
    const projectFit: any[] = Array.isArray(report.project_fit) ? report.project_fit : [];
    const fitMoves: Array<{
      text: string;
      url?: string | null;
      why?: string | null;
      move?: string | null;
    }> = [];
    for (const fit of projectFit) {
      const moves: string[] = Array.isArray(fit.moves) ? fit.moves.map(String) : [];
      if (moves.length > 0) {
        fitMoves.push({
          text: `[${fit.project}] ${moves[0]}`,
          url: null,
          why: fit.why ? String(fit.why) : null,
          move: moves[0],
        });
      }
      if (fitMoves.length >= 3) break;
    }
    if (fitMoves.length > 0) {
      sections.push({
        title: 'Top Project Moves',
        items: fitMoves,
      });
    }
  } else {
    // midday / evening — intel sections (live mission delta injected later by scheduler)
    const topSignals: any[] = Array.isArray(report.top_signals) ? report.top_signals : [];
    if (topSignals.length > 0) {
      // Score-ordered (desc, missing score -> 0) before the top-5 cut.
      const ordered: any[] = topSignals
        .slice()
        .sort(
          (a: any, b: any) =>
            (typeof b?.score === 'number' ? b.score : 0) -
            (typeof a?.score === 'number' ? a.score : 0),
        );
      sections.push({
        title: 'Intel Signals',
        items: ordered.slice(0, 5).map((s: any) => ({
          text: String(s.title ?? ''),
          url: s.url ? String(s.url) : null,
          why: s.why ? String(s.why) : null,
          move: s.move ? String(s.move) : null,
        })),
      });
    }
  }

  // Suggested Tickets (spec G7) — top 5 from this module's own recommendation
  // synthesis so briefs always carry concrete, actionable ticket suggestions.
  if (recommendations.length > 0) {
    sections.push({
      title: 'Suggested Tickets',
      items: recommendations.slice(0, 5).map((rec: any) => ({
        text: String(rec.title ?? ''),
        url: null,
        why: rec.reason ? String(rec.reason) : null,
        move: rec.nextAction ? String(rec.nextAction) : null,
      })),
    });
  }

  // FIX 3: when the external report is expired/missing, merge in Ace's own
  // locally pulled intel so the brief reflects live pulls instead of stale
  // content. A fresh/stale-but-usable external report is left untouched.
  const localItems = externalStale && local ? buildLocalBriefItems(local, 8) : [];
  const useLocal = localItems.length > 0;
  if (useLocal) {
    sections.push({ title: 'Local intel (live pull)', items: localItems });
  }
  const provenance = useLocal ? 'merged' : 'external';

  // Source freshness — always last; honest about untracked pull state.
  sections.push(buildSourceFreshnessSection(opts.sourceState ?? null, opts.now));

  return {
    $schema: 'ace.ops.brief.v1',
    lens,
    generatedAt,
    intelAsOf,
    sourceFreshness: opts.sourceFreshness,
    // FIX 3: external | merged | local | missing — where the body came from.
    provenance,
    headline,
    sections,
    deltaSummary,
    candidateCount,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// synthesizeIntel — the FULL Vector Ops dashboard, normalized into one payload
// (ace.ops.intel.v1). Mirrors what the external dashboard surfaces so the
// Operations "Vector Ops" tab shows everything, not just top signals.
// ---------------------------------------------------------------------------

/**
 * Structured item timestamp: first parseable of the source-provided fields,
 * normalized to ISO. No parseable timestamp -> null, never fabricated (R3).
 */
function extractTimestamp(it: any): string | null {
  for (const key of ['published_at', 'published', 'pushed_at', 'first_seen']) {
    const iso = toIsoOrNull(it?.[key]);
    if (iso) return iso;
  }
  return null;
}

function normalizeFeedItem(it: any, idx: number, sectionKey: string): any {
  const title = String(it?.title ?? it?.app ?? it?.repo ?? it?.name ?? 'Untitled');
  const url = it?.url ? String(it.url) : null;
  const summary = String(it?.summary ?? it?.description ?? '');
  const source = it?.source_label ? String(it.source_label) : it?.source ? String(it.source) : null;
  const meta = String(
    it?.meta ??
      it?.published_at ??
      it?.published ??
      it?.pushed_at ??
      it?.first_seen ??
      it?.market_state ??
      ''
  ) || null;
  const score = typeof it?.score === 'number' ? it.score : null;
  return {
    id: `${sectionKey}:${slugify(title)}:${idx}`,
    title,
    summary,
    url,
    source,
    meta,
    timestamp: extractTimestamp(it),
    isNew: it?.is_new === true,
    score,
    handle: it?.handle ? String(it.handle) : null,
    why: it?.why ? String(it.why) : null,
    move: it?.move ? String(it.move) : null,
  };
}

/**
 * Local-intel items (ace.ops.intel-local.v1) already carry a structured
 * `timestamp`; map them onto the same item shape normalizeFeedItem emits.
 */
function normalizeLocalItem(it: any, idx: number, sectionKey: string): any {
  const title = String(it?.title ?? 'Untitled');
  return {
    id: it?.id ? String(it.id) : `${sectionKey}:${slugify(title)}:${idx}`,
    title,
    summary: String(it?.summary ?? ''),
    url: it?.url ? String(it.url) : null,
    source: it?.source ? String(it.source) : null,
    meta: it?.timestamp ? String(it.timestamp) : null,
    timestamp: toIsoOrNull(it?.timestamp),
    isNew: it?.is_new === true,
    score: typeof it?.score === 'number' ? it.score : null,
    handle: it?.handle ? String(it.handle) : null,
    why: null,
    move: null,
  };
}

function arr(report: any, key: string): any[] {
  return Array.isArray(report?.[key]) ? report[key] : [];
}

// Section order + human titles mirror the dashboard's information hierarchy.
const INTEL_SECTIONS: { key: string; title: string }[] = [
  { key: 'top_signals', title: 'Top Signals' },
  { key: 'vendor_updates', title: 'Vendor Updates' },
  { key: 'platform_changelogs', title: 'Platform Changelogs' },
  { key: 'official_feeds', title: 'Official Feeds' },
  { key: 'platform_accounts', title: 'Social / X' },
  { key: 'github_watch', title: 'GitHub Watch' },
  { key: 'github_trending', title: 'GitHub Trending' },
  { key: 'hackernews', title: 'Hacker News' },
  { key: 'world_news', title: 'World News' },
  { key: 'reddit', title: 'Reddit' },
  { key: 'arxiv', title: 'arXiv' },
];

// Sections that only exist for source-state honesty (no report key feeds
// them); emitted solely when their source is non-ok.
const STATE_ONLY_SECTIONS: { key: string; title: string }[] = [
  { key: 'prices', title: 'Market Prices' },
];

// Provenance label when a locally pulled section wins the merge.
const LOCAL_PROVENANCE: Record<string, string> = {
  official_feeds: 'live-pull',
  github_watch: 'live-pull',
  platform_accounts: 'agent',
  world_news: 'agent',
  vendor_updates: 'agent',
};

function synthesizeIntel(
  report: any | null,
  opts?: {
    prices?: any[];
    intelAsOf?: string | null;
    sourceFreshness?: IntelFreshness;
    localIntel?: any | null;
    sourceState?: any | null;
    now?: number;
  }
): any {
  const prices: any[] = Array.isArray(opts?.prices) ? (opts as any).prices : [];
  const now: number = opts?.now ?? Date.now();
  const localIntel: any = opts?.localIntel ?? null;
  const sourceState: any = opts?.sourceState ?? null;
  const stateSources: any[] = Array.isArray(sourceState?.sources) ? sourceState.sources : [];
  const generatedAt: string | null = report?.generated_at ?? opts?.intelAsOf ?? null;
  const base = {
    $schema: 'ace.ops.intel.v1',
    generatedAt,
    sourceFreshness:
      opts?.sourceFreshness ?? (report ? computeFreshness(generatedAt, now) : 'missing'),
    lastRefreshAt: newestIso(stateSources.map((s: any) => s?.lastSuccess)),
    executiveSummary: String(report?.executive_summary ?? ''),
    operatorTake: String(report?.operator_take ?? ''),
    newCount: typeof report?.new_count === 'number' ? report.new_count : 0,
    seenItemsTotal: typeof report?.seen_items_total === 'number' ? report.seen_items_total : 0,
    // FIX 3: external | local | merged | missing — computed after the section
    // merge below. Honest top-level label for the UI to show provenance.
    provenance: 'missing' as string,
    sections: [] as any[],
    projectFit: [] as any[],
    projectMoves: { facts: [] as string[], suggestions: [] as string[] },
    hotAiApp: null as any,
    prices: [] as any[],
  };
  try {
    // Sections merge: per key, the side (external report vs local pull) with
    // the newer timestamp wins; provenance + asOf are labeled accordingly.
    const localSections = new Map<string, any>();
    const localList: any[] = Array.isArray(localIntel?.sections) ? localIntel.sections : [];
    for (const sec of localList) {
      if (sec?.key) localSections.set(String(sec.key), sec);
    }
    const generatedMs: number = generatedAt ? new Date(generatedAt).getTime() : NaN;

    base.sections = INTEL_SECTIONS.concat(STATE_ONLY_SECTIONS)
      .map((s) => {
        let items: any[] = arr(report, s.key).map((it: any, i: number) =>
          normalizeFeedItem(it, i, s.key)
        );
        let provenance: string = 'intel-report';
        let asOf: string | null = generatedAt;
        const local: any = localSections.get(s.key);
        if (local) {
          const fetchedAt: string | null = local.fetchedAt ? String(local.fetchedAt) : null;
          const fetchedMs: number = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
          if (!isNaN(fetchedMs) && (isNaN(generatedMs) || fetchedMs > generatedMs)) {
            items = (Array.isArray(local.items) ? local.items : []).map((it: any, i: number) =>
              normalizeLocalItem(it, i, s.key)
            );
            provenance = LOCAL_PROVENANCE[s.key] ?? 'live-pull';
            asOf = fetchedAt;
          }
        }
        const state = aggregateSources(sourcesForSection(sourceState, s.key));
        // Honest freshness: a section with no real items must NOT borrow the
        // report's generatedAt and show a fabricated 'fresh' chip. Base its
        // as-of on the section's own last successful pull (null -> 'missing'),
        // so unavailable/auth-needed/error sections read stale/expired/missing.
        const honestAsOf = items.length > 0 ? asOf : state ? state.lastSuccess : null;
        return {
          key: s.key,
          title: s.title,
          items,
          provenance,
          asOf: honestAsOf,
          freshness: computeFreshness(honestAsOf, now),
          status: state ? state.status : null,
          statusMessage: state ? state.statusMessage : null,
          lastAttempt: state ? state.lastAttempt : null,
          lastSuccess: state ? state.lastSuccess : null,
        };
      })
      // Empty sections vanish UNLESS their source is in a non-ok state —
      // auth-needed/unavailable/error must stay visible, never fake or hidden.
      .filter((s: any) => s.items.length > 0 || (s.status != null && s.status !== 'ok'));

    // FIX 3: top-level provenance — a section's provenance is 'live-pull'/'agent'
    // only when the local pull won the per-section merge (fresher than the
    // report), so any such section means local data contributed.
    const localWon = base.sections.some(
      (s: any) => s.provenance === 'live-pull' || s.provenance === 'agent',
    );
    base.provenance =
      report && localWon ? 'merged' : localWon ? 'local' : report ? 'external' : 'missing';
  } catch {
    // partial intel is fine; never throw
  }
  if (!report) {
    base.prices = prices.map((p: any, i: number) => normalizePrice(p, i));
    return base;
  }
  try {
    base.projectFit = arr(report, 'project_fit').map((f: any) => ({
      project: String(f?.project ?? ''),
      priority: String(f?.priority ?? ''),
      fit: String(f?.fit ?? ''),
      why: String(f?.why ?? ''),
      moves: Array.isArray(f?.moves) ? f.moves.map(String) : [],
      missionTemplate: String(f?.mission_template ?? ''),
    }));

    const pm = report?.project_moves ?? {};
    base.projectMoves = {
      facts: Array.isArray(pm?.facts) ? pm.facts.map(String) : [],
      suggestions: Array.isArray(pm?.suggestions) ? pm.suggestions.map(String) : [],
    };

    if (report?.hot_ai_app && typeof report.hot_ai_app === 'object') {
      base.hotAiApp = normalizeFeedItem(report.hot_ai_app, 0, 'hot_ai_app');
    }

    base.prices = prices.map((p: any, i: number) => normalizePrice(p, i));
  } catch {
    // partial intel is fine; never throw
  }
  return base;
}

function normalizePrice(p: any, idx: number): any {
  return {
    id: `price:${slugify(String(p?.symbol ?? idx))}`,
    symbol: String(p?.symbol ?? ''),
    name: String(p?.name ?? ''),
    price: typeof p?.price === 'number' ? p.price : null,
    change: typeof p?.change === 'number' ? p.change : null,
    changePct: typeof p?.change_pct === 'number' ? p.change_pct : null,
    marketState: p?.market_state ? String(p.market_state) : null,
  };
}

// ---------------------------------------------------------------------------
// judgeIntel — OPTIONAL headless-agent judgment pass over a synthesized intel
// payload. Replaces the verbatim why/move pass-through (and the trivial
// nextAction = moves[0] ?? why) with ONE agent call that dedups,
// relevance-filters, and AUTHORS per-item why/move + a real nextAction.
//
// Fail-closed like ops-todos' synthesizeTodoDigestWithAgent: no runAgent, or
// ANY failure (throw, sync-throw, hang/timeout, junk output, nothing usable),
// returns the payload with every item stamped judged:false — byte-for-byte the
// current verbatim behavior plus that additive marker. runAgent is INJECTED
// (never imported) so this module stays electron/IPC-free. Hard-capped ≤120s.
// ---------------------------------------------------------------------------

// Race a promise against a hard timeout so a hung agent can never wedge intel.
// (Same shape as ops-todos withHardTimeout.)
function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`intel judgment agent timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Tolerant JSON extraction: direct parse, then a ```json fence, then the
// outermost {...} slice. Returns null on failure. (Mirrors ops-todos.)
function extractJsonObject(raw: unknown): any {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const tryParse = (s: string): any => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let obj = tryParse(text);
  if (obj !== undefined) return obj;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    obj = tryParse(fence[1].trim());
    if (obj !== undefined) return obj;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    obj = tryParse(text.slice(start, end + 1));
    if (obj !== undefined) return obj;
  }
  return null;
}

// Return a shallow clone of the intel payload with every section item stamped
// `judged` = value and a top-level `judged` flag. This IS the verbatim result
// (value=false) — the fail-closed fallback.
function stampJudged(intel: any, value: boolean): any {
  const sections = (Array.isArray(intel?.sections) ? intel.sections : []).map((s: any) => ({
    ...s,
    items: (Array.isArray(s?.items) ? s.items : []).map((it: any) => ({ ...it, judged: value })),
  }));
  return { ...intel, sections, judged: value === true };
}

function buildJudgePrompt(items: any[]): string {
  const compact = items.map((it) => ({
    id: it.id,
    title: it.title,
    summary: typeof it.summary === 'string' ? it.summary.slice(0, 300) : '',
    url: it.url,
    section: it.sectionKey,
  }));
  return [
    'You are triaging operations intel for a solo AI-tooling founder.',
    'For EACH item below decide keep (relevant + non-duplicate) or drop, and when',
    'kept AUTHOR: a one-line why (why it matters to the projects), a concrete move',
    '(suggested next step), and a short nextAction (imperative, under 100 chars).',
    'Drop noise, off-topic items, and duplicates (set keep:false on the dupes).',
    'Reference ONLY the ids given. Do not invent items, facts, or urls.',
    '',
    'Items (JSON):',
    JSON.stringify(compact),
    '',
    'Respond with ONLY this JSON object — no prose, no markdown fences:',
    '{"items":[{"id":"<id>","keep":true|false,"why":"<one line>","move":"<one line>","nextAction":"<imperative>"}]}',
  ].join('\n');
}

// Parse the agent's verdict into a Map id -> { keep, why, move, nextAction }.
// Unknown/malformed entries are dropped; empty map -> null (fall back verbatim).
function parseJudgeOutput(raw: unknown): Map<string, any> | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) return null;
  const map = new Map<string, any>();
  for (const it of obj.items) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string') continue;
    map.set(it.id, {
      keep: it.keep === false ? false : true,
      why: typeof it.why === 'string' && it.why.trim() ? it.why.trim().slice(0, 240) : null,
      move: typeof it.move === 'string' && it.move.trim() ? it.move.trim().slice(0, 240) : null,
      nextAction:
        typeof it.nextAction === 'string' && it.nextAction.trim()
          ? it.nextAction.trim().slice(0, 200)
          : null,
    });
  }
  return map.size > 0 ? map : null;
}

async function judgeIntel(
  intel: any,
  opts?: {
    runAgent?: (args: { prompt: string; timeoutMs: number }) => Promise<string> | string;
    timeoutMs?: number;
    maxItems?: number;
  },
): Promise<any> {
  if (!intel || typeof intel !== 'object') return intel;
  // Verbatim baseline (also the fail-closed fallback): items judged:false.
  const verbatim = stampJudged(intel, false);
  const runAgent = opts && typeof opts.runAgent === 'function' ? opts.runAgent : null;
  if (!runAgent) return verbatim;

  const sections: any[] = Array.isArray(intel.sections) ? intel.sections : [];
  const flat: any[] = [];
  for (const s of sections) {
    for (const it of Array.isArray(s?.items) ? s.items : []) {
      flat.push({ id: it.id, title: it.title, summary: it.summary, url: it.url, sectionKey: s.key });
    }
  }
  if (flat.length === 0) return verbatim;

  const maxItems =
    opts && Number.isInteger(opts.maxItems) && (opts.maxItems as number) > 0
      ? Math.min(opts.maxItems as number, 60)
      : 40;
  const capped = flat.slice(0, maxItems);
  const capMs = (() => {
    const t = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 120000;
    return Math.max(1, Math.min(t, 120000));
  })();

  try {
    const prompt = buildJudgePrompt(capped);
    const raw = await withHardTimeout(
      Promise.resolve().then(() => runAgent({ prompt, timeoutMs: capMs })),
      capMs,
    );
    const verdicts = parseJudgeOutput(raw);
    if (!verdicts) return verbatim;

    const seenKeys = new Set<string>(); // deterministic dedup safety net
    let anyJudged = false;
    const newSections = sections.map((s: any) => {
      const items: any[] = [];
      for (const it of Array.isArray(s?.items) ? s.items : []) {
        const verdict = verdicts.get(it.id);
        if (verdict && verdict.keep === false) continue; // relevance-filter / dedup drop
        const dedupKey = it.url
          ? String(it.url).toLowerCase()
          : String(it.title ?? '')
              .toLowerCase()
              .trim();
        if (dedupKey && seenKeys.has(dedupKey)) continue;
        if (dedupKey) seenKeys.add(dedupKey);
        if (verdict) {
          anyJudged = true;
          items.push({
            ...it,
            why: verdict.why != null ? verdict.why : it.why,
            move: verdict.move != null ? verdict.move : it.move,
            nextAction: verdict.nextAction != null ? verdict.nextAction : null,
            judged: true,
          });
        } else {
          // Item the agent did not address stays verbatim (judged:false).
          items.push({ ...it, judged: false });
        }
      }
      return { ...s, items };
    });
    if (!anyJudged) return verbatim;
    return { ...intel, sections: newSections, judged: true };
  } catch {
    // Fail-closed: ANY error (throw, timeout, junk) => verbatim payload.
    return verbatim;
  }
}

module.exports = {
  slugify,
  computeFreshness,
  loadLatestReport,
  loadLocalIntel,
  synthesizeRecommendations,
  synthesizeSignals,
  synthesizeBrief,
  synthesizeIntel,
  judgeIntel,
};
