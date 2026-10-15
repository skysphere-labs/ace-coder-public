/**
 * ops-refresh.cts
 *
 * Source-refresh engine for the Operations Command Center (hybrid pull model).
 * Derives a source registry from the Sources watchlists (ops-sources.cts),
 * pulls feeds natively (RSS/Atom over fetch), GitHub releases via the gh CLI,
 * and X/news/vendor updates via ONE headless research-agent call, then
 * persists per-source lastAttempt/lastSuccess state, an ndjson run history,
 * and a local intel file (ace.ops.intel-local.v1).
 *
 * NO electron imports — Node built-ins only, with every side effect
 * (clock, fetch, exec, agent runner, timers) injectable for tests.
 * Public functions never throw. No hardcoded URLs or account ids.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const birdclawSource = require('./birdclaw-source.cts');

// ---------------------------------------------------------------------------
// Constants (file names are relative to a caller-supplied stateDir, normally
// Electron's userDataPath — same pattern as ops-brief-scheduler.cts).
// ---------------------------------------------------------------------------

const OPS_REFRESH_STATE_FILE = 'ops-source-state.json';
const OPS_REFRESH_HISTORY_FILE = 'ops-refresh.ndjson';
const LOCAL_INTEL_FILE = 'ops-intel-local.json';

// Default catch-up slots mirror the ops-brief lens cadence. The caller passes
// a normalized schedule from ops-config when one exists; this is the fallback.
const OPS_REFRESH_SCHEDULE: Array<{ hour: number; minute: number; lens: string }> = [
  { hour: 7, minute: 30, lens: 'morning' },
  { hour: 13, minute: 0, lens: 'midday' },
  { hour: 20, minute: 30, lens: 'evening' },
];

// Agent-leg source ids -> research output section keys.
const AGENT_SECTION_KEYS: Record<string, string> = {
  'agent:social': 'platform_accounts',
  'agent:news': 'world_news',
  'agent:vendors': 'vendor_updates',
};

// ---------------------------------------------------------------------------
// Small helpers (never throw)
// ---------------------------------------------------------------------------

/** Safely coerce an arbitrary value to a deduped non-empty string array. */
function safeStringArray(val: unknown): string[] {
  try {
    if (!Array.isArray(val)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of val) {
      const s = String(item ?? '').trim();
      if (s.length > 0 && !seen.has(s)) {
        seen.add(s);
        result.push(s);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * A feed/changelog target must parse as an absolute http(s) URL before we hand
 * it to fetch. A watchlist entry that is a bare label (e.g. "GitHub Changelog")
 * makes fetch throw "Failed to parse URL from ..."; guarding here turns that
 * into an honest per-source `broken` state with a clear reason instead of a
 * cryptic lane-killing error. Never throws.
 */
function isHttpUrl(target: any): boolean {
  try {
    if (typeof target !== 'string' || !target.trim()) return false;
    const u = new URL(target.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether a gh/exec error text looks like an HTTP 404 (dead/renamed repo). */
function looksLike404(err: any): boolean {
  try {
    const text = `${err?.message ?? ''} ${err?.stderr ?? ''} ${err?.stdout ?? ''}`;
    return /\b(HTTP\s*)?404\b/i.test(text) || /not found/i.test(text);
  } catch {
    return false;
  }
}

/** Read+parse a JSON file. Missing/corrupt -> null. */
function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Read ops-source-state.json from stateDir. Missing/corrupt -> { sources: {} }. */
function readSourceState(stateDir: any): any {
  if (typeof stateDir !== 'string' || stateDir.length === 0) return { sources: {} };
  const parsed = readJsonFile(path.join(stateDir, OPS_REFRESH_STATE_FILE));
  if (!parsed || typeof parsed !== 'object' || !parsed.sources || typeof parsed.sources !== 'object') {
    return { sources: {} };
  }
  return parsed;
}

/** Last parseable line of ops-refresh.ndjson. Missing/corrupt -> null. */
function readLastHistoryEntry(stateDir: string): any {
  try {
    const lines = fs
      .readFileSync(path.join(stateDir, OPS_REFRESH_HISTORY_FILE), 'utf8')
      .split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // skip malformed lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Newest history `at` for a run where at least one source actually succeeded
// (ok > 0). Catch-up treats a slot as "covered" only by a run that pulled
// something — a fully-failed run (e.g. offline at the slot) must NOT suppress
// the next boot catch-up (matches the documented successful-refresh contract).
function lastSuccessfulRunAt(stateDir: string): string | null {
  try {
    const lines = fs
      .readFileSync(path.join(stateDir, OPS_REFRESH_HISTORY_FILE), 'utf8')
      .split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && Number(parsed.ok) > 0) {
          return typeof parsed.at === 'string' ? parsed.at : null;
        }
      } catch {
        // skip malformed lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// deriveSourceRegistry
// ---------------------------------------------------------------------------

/**
 * Derive the refresh source registry from ops-sources watchlists.
 *
 * - feeds: one native source per url ('feed:<url>')
 * - repos: one native source per repo ('repo:<owner/repo>')
 * - accounts: ALL handles -> ONE aggregate research-agent source 'agent:social'
 * - changelogs: ALL vendors -> ONE aggregate research-agent source 'agent:vendors'
 * - always: 'agent:news' (research agent) and 'report:finance' (state derived
 *   from the external latest.json report by the caller — never fetched here).
 *
 * Never throws; junk input yields just the four aggregate sources.
 */
function deriveSourceRegistry(
  watchlists: any
): Array<{ id: string; class: string; label: string; target: any }> {
  try {
    const wl = watchlists && typeof watchlists === 'object' ? watchlists : {};
    const feeds = safeStringArray(wl.feeds);
    const accounts = safeStringArray(wl.accounts);
    const repos = safeStringArray(wl.repos);
    const changelogs = safeStringArray(wl.changelogs);

    const registry: Array<{ id: string; class: string; label: string; target: any }> = [];
    for (const url of feeds) {
      registry.push({ id: `feed:${url}`, class: 'feeds', label: url, target: url });
    }
    for (const repo of repos) {
      registry.push({ id: `repo:${repo}`, class: 'repos', label: repo, target: repo });
    }
    registry.push({
      id: 'agent:social',
      class: 'accounts',
      label: 'Social / X (research agent)',
      target: accounts,
    });
    registry.push({
      id: 'agent:vendors',
      class: 'changelogs',
      label: 'Vendor changelogs (research agent)',
      target: changelogs,
    });
    registry.push({
      id: 'agent:news',
      class: 'news',
      label: 'World news (research agent)',
      target: [],
    });
    registry.push({
      id: 'report:finance',
      class: 'finance',
      label: 'Market prices (intel report)',
      target: [],
    });
    return registry;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// parseFeedXml — minimal RSS 2.0 + Atom extractor (regex/string-scan; no deps)
// ---------------------------------------------------------------------------

/** Decode the five common XML entities (&amp; last so &amp;lt; stays "&lt;"). */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Unwrap CDATA sections, strip tags, decode entities, collapse whitespace. */
function cleanText(raw: any): string {
  return decodeEntities(
    String(raw ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate to ~max chars with an ellipsis. */
function truncate(s: string, max: number = 280): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** First content of <tag ...>...</tag> within a block, or null. */
function tagContent(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

/**
 * Item/entry link: Atom href attr (rel="alternate" preferred, else the first
 * link with an href), falling back to RSS <link>url</link> text content.
 */
function extractLink(block: string): string | null {
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  let firstHref: string | null = null;
  for (const tag of tags) {
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    if (!href) continue;
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    if (rel === 'alternate') return href;
    if (!firstHref) firstHref = href;
  }
  if (firstHref) return firstHref;
  const text = tagContent(block, 'link');
  if (text) {
    const v = cleanText(text);
    if (v) return v;
  }
  return null;
}

/**
 * Item timestamp from pubDate|published|updated -> ISO string.
 * NEVER fabricates: missing or unparseable dates yield null, never "now".
 */
function extractTimestamp(block: string): string | null {
  for (const tag of ['pubDate', 'published', 'updated']) {
    const raw = tagContent(block, tag);
    if (!raw) continue;
    const parsed = new Date(cleanText(raw));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Minimal RSS 2.0 (<item>) + Atom (<entry>) extractor.
 *
 * Returns [{ id, title, summary, url, timestamp }] capped at opts.maxItems
 * (default 20). Summaries are tag-stripped, entity-decoded, ~280 chars.
 * Malformed/non-XML input -> []. Never throws.
 */
function parseFeedXml(
  xml: any,
  opts?: { maxItems?: number }
): Array<{ id: string; title: string; summary: string; url: string | null; timestamp: string | null }> {
  try {
    if (typeof xml !== 'string' || xml.length === 0) return [];
    const max =
      Number.isInteger(opts?.maxItems) && (opts as any).maxItems > 0
        ? (opts as any).maxItems
        : 20;
    let blocks = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
    if (blocks.length === 0) blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];

    const items: any[] = [];
    for (let i = 0; i < blocks.length && items.length < max; i++) {
      const block = blocks[i];
      const title = cleanText(tagContent(block, 'title') ?? '');
      const url = extractLink(block);
      if (!title && !url) continue; // unusable entry
      const guid = cleanText(tagContent(block, 'guid') ?? tagContent(block, 'id') ?? '');
      const summary = truncate(
        cleanText(tagContent(block, 'description') ?? tagContent(block, 'summary') ?? '')
      );
      items.push({
        id: guid || url || title || `item-${i}`,
        title,
        summary,
        url,
        timestamp: extractTimestamp(block),
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// buildResearchPrompt / parseResearchOutput — the headless agent leg contract
// ---------------------------------------------------------------------------

/**
 * Compact prompt for the headless research agent covering all three agent
 * sections (X accounts, world news, vendor updates) in a single call.
 * Never throws.
 */
function buildResearchPrompt(input: any = {}): string {
  try {
    const accounts = safeStringArray(input?.accounts);
    const vendors = safeStringArray(input?.vendors);
    const nowIso =
      typeof input?.nowIso === 'string' && input.nowIso ? input.nowIso : new Date().toISOString();
    return [
      `You are a research agent gathering operations intel. Current time: ${nowIso}.`,
      'Research, using only verifiable public information:',
      `1. platform_accounts — latest notable posts from these X/Twitter accounts: ${
        accounts.length ? accounts.join(', ') : '(none watched)'
      }.`,
      '2. world_news — significant AI/tech world news from roughly the last 12 hours.',
      `3. vendor_updates — official vendor/product updates for: ${
        vendors.length ? vendors.join(', ') : '(none watched)'
      }.`,
      'Respond with ONLY a single JSON object — no prose, no markdown, no code fences. Schema:',
      '{"sections":[{"key":"platform_accounts"|"world_news"|"vendor_updates","items":[{"title":string,"summary":string,"url":string|null,"timestamp":string|null,"handle"?:string}]}]}',
      'Use real ISO 8601 timestamps when known, otherwise null. NEVER invent items or URLs — omit anything you cannot verify. Empty items arrays are allowed.',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * Tolerant parse of the research agent's output: strips code fences, takes
 * the first '{'..last '}' span, validates sections/keys, drops malformed
 * items, and coerces strings. Anything unusable -> null. Never throws.
 */
function parseResearchOutput(text: any): { sections: any[] } | null {
  try {
    if (typeof text !== 'string' || text.length === 0) return null;
    const stripped = text.replace(/```[a-zA-Z0-9_-]*/g, '');
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    const parsed = JSON.parse(stripped.slice(first, last + 1));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sections)) return null;

    const allowed = new Set(Object.values(AGENT_SECTION_KEYS));
    const sections: any[] = [];
    for (const section of parsed.sections) {
      const key = section?.key;
      if (typeof key !== 'string' || !allowed.has(key)) continue;
      const items: any[] = [];
      for (const item of Array.isArray(section.items) ? section.items : []) {
        if (!item || typeof item !== 'object') continue;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        if (!title) continue;
        const out: any = {
          title,
          summary: typeof item.summary === 'string' ? item.summary : '',
          url: typeof item.url === 'string' && item.url ? item.url : null,
          timestamp: typeof item.timestamp === 'string' && item.timestamp ? item.timestamp : null,
        };
        if (typeof item.handle === 'string' && item.handle) out.handle = item.handle;
        items.push(out);
      }
      sections.push({ key, items });
    }
    return { sections };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default seams (overridable via runOpsRefresh ctx)
// ---------------------------------------------------------------------------

/** Default fetch: global fetch with an AbortController timeout. */
function defaultFetch(url: string, opts: { timeoutMs?: number } = {}): Promise<any> {
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 10000;
  const controller = new (globalThis as any).AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return (globalThis as any)
    .fetch(url, { signal: controller.signal, redirect: 'follow' })
    .finally(() => clearTimeout(timer));
}

/**
 * Default gh runner: promisified execFile('gh', args) with a 15s timeout.
 * Rejects with the raw error (err.code === 'ENOENT' when gh is absent) so
 * callers can degrade — same idiom as ops-status probeCiDrift.
 */
function defaultExecGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        'gh',
        args,
        { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
        (error: any, stdout: any) => {
          if (error) reject(error);
          else resolve(String(stdout || ''));
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// runOpsRefresh — pull every registry source, persist state/history/intel
// ---------------------------------------------------------------------------

/**
 * Refresh every source in the registry. Per-source failures degrade to honest
 * status ('error' | 'auth-needed' | 'unavailable'); lastSuccess only advances
 * on success and is preserved from the previous state file on failure.
 *
 * Persists (all fail-safe, mkdir -p, never throws):
 *  - stateDir/ops-source-state.json  (ace.ops.source-state.v1)
 *  - stateDir/ops-refresh.ndjson     (one run line appended)
 *  - localIntelPath                  (ace.ops.intel-local.v1; sections
 *    that failed THIS run keep their previously written content —
 *    stale-but-real beats gone)
 *
 * Returns { at, trigger, lens, sources, localIntelPath } regardless.
 */
async function runOpsRefresh(ctx: any): Promise<any> {
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const now: () => Date =
    typeof safeCtx.now === 'function' ? safeCtx.now : () => new Date();
  let at: string;
  try {
    at = now().toISOString();
  } catch {
    at = new Date().toISOString();
  }
  const trigger =
    safeCtx.trigger === 'manual' || safeCtx.trigger === 'catch-up'
      ? safeCtx.trigger
      : 'scheduled';
  const lens = typeof safeCtx.lens === 'string' && safeCtx.lens ? safeCtx.lens : null;
  const stateDir =
    typeof safeCtx.stateDir === 'string' && safeCtx.stateDir ? safeCtx.stateDir : null;
  const localIntelPath =
    typeof safeCtx.localIntelPath === 'string' && safeCtx.localIntelPath
      ? safeCtx.localIntelPath
      : stateDir
        ? path.join(stateDir, LOCAL_INTEL_FILE)
        : null;
  const result: any = { at, trigger, lens, sources: [], localIntelPath };

  try {
    const fetchImpl = typeof safeCtx.fetchImpl === 'function' ? safeCtx.fetchImpl : defaultFetch;
    const fetchTimeoutMs =
      typeof safeCtx.fetchTimeoutMs === 'number' ? safeCtx.fetchTimeoutMs : 10000;
    const execGh = typeof safeCtx.execGh === 'function' ? safeCtx.execGh : defaultExecGh;
    const research =
      safeCtx.research && typeof safeCtx.research === 'object' ? safeCtx.research : {};
    const researchEnabled = research.enabled !== false;
    const researchTimeoutMs =
      typeof research.timeoutMs === 'number' ? research.timeoutMs : 300000;
    const watchlists = safeCtx.watchlists ?? {};

    const registry = deriveSourceRegistry(watchlists);
    const states = new Map<string, any>();
    for (const src of registry) {
      states.set(src.id, {
        id: src.id,
        class: src.class,
        label: src.label,
        status: 'unavailable',
        lastAttempt: null,
        lastSuccess: null,
        error: null,
        itemCount: 0,
        // Additive (FIX 2): true when the entry itself is misconfigured/dead
        // (invalid URL, 404) — a config problem the owner fixes in the
        // watchlist, distinct from a transient network `error`. Surfaced in the
        // Sources UI so broken entries are visible and editable.
        broken: false,
      });
    }

    const prev = readSourceState(stateDir);
    const feedItemsBySource = new Map<string, any[]>();
    const repoItems: any[] = [];
    const agentItemsByKey: Record<string, any[]> = {};

    // --- feeds (native fetch, concurrent) ---
    const feedSources = registry.filter((s) => s.class === 'feeds');
    await Promise.allSettled(
      feedSources.map(async (src) => {
        const state = states.get(src.id);
        state.lastAttempt = now().toISOString();
        // FIX 2: guard the target before fetch — a non-http(s) entry is broken
        // config, not a network error, and must never reach fetchImpl (whose
        // "Failed to parse URL" would otherwise mark it a plain error).
        if (!isHttpUrl(src.target)) {
          state.status = 'error';
          state.broken = true;
          state.error = 'invalid feed URL — must be an http(s) address (fix this entry in Sources)';
          return;
        }
        try {
          const res = await fetchImpl(src.target, { timeoutMs: fetchTimeoutMs });
          if (res && res.ok) {
            // 0 parsed items with an HTTP 200 is still a successful pull.
            const items = parseFeedXml(await res.text());
            state.status = 'ok';
            state.lastSuccess = now().toISOString();
            state.itemCount = items.length;
            feedItemsBySource.set(src.id, items);
          } else {
            state.status = 'error';
            state.error = `HTTP ${res?.status ?? 'request failed'}`; // no body dumps
          }
        } catch (err: any) {
          state.status = 'error';
          state.error = err?.message ?? String(err);
        }
      })
    );

    // --- repos (gh CLI releases, concurrent) ---
    const repoSources = registry.filter((s) => s.class === 'repos');
    await Promise.allSettled(
      repoSources.map(async (src) => {
        const state = states.get(src.id);
        state.lastAttempt = now().toISOString();
        try {
          const stdout = await execGh(['api', `repos/${src.target}/releases?per_page=3`]);
          const releases = JSON.parse(String(stdout));
          const items = (Array.isArray(releases) ? releases : []).map((rel: any) => ({
            title: String(rel?.name || rel?.tag_name || '(untitled release)'),
            summary: '',
            url: rel?.html_url ?? null,
            timestamp: rel?.published_at ?? null,
          }));
          state.status = 'ok';
          state.lastSuccess = now().toISOString();
          state.itemCount = items.length;
          repoItems.push(...items);
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            // gh missing -> degrade, mirroring ops-status probeCiDrift.
            state.status = 'unavailable';
            state.error = 'GitHub CLI not installed';
          } else if (looksLike404(err)) {
            // FIX 2: a 404 means the repo is gone/renamed — broken config the
            // owner fixes in the watchlist, not a transient error.
            state.status = 'error';
            state.broken = true;
            state.error = 'HTTP 404 — repo not found or renamed (fix this entry in Sources)';
          } else {
            state.status = 'error';
            state.error = err?.message ?? String(err);
          }
        }
      })
    );

    // --- agent leg (social / news / vendors) ---
    const agentSources = registry.filter((s) => AGENT_SECTION_KEYS[s.id]);
    for (const src of agentSources) {
      states.get(src.id).lastAttempt = now().toISOString();
    }

    // FIX 5: birdclaw is the PREFERRED provider for the social lane when the
    // owner has configured a birdclaw DB (ops-config.json birdclaw.dbPath,
    // passed in as ctx.birdclaw). It is opened READ-ONLY and any problem
    // degrades that one lane honestly (auth-needed / broken) without ever
    // throwing; the research agent still covers news + vendors. When birdclaw
    // is not configured the social lane keeps the research-agent path below.
    let socialViaBirdclaw = false;
    const birdclawCfg =
      safeCtx.birdclaw && typeof safeCtx.birdclaw === 'object' ? safeCtx.birdclaw : null;
    if (birdclawCfg) {
      try {
        const bc = birdclawSource.fetchBirdclawSocial({
          dbPath: birdclawCfg.dbPath,
          configPath: birdclawCfg.configPath,
          Database: birdclawCfg.Database,
          limit: 50,
        });
        if (bc.configured) {
          socialViaBirdclaw = true;
          const state = states.get('agent:social');
          if (state) {
            state.label = 'Social / X (birdclaw)';
            if (bc.status === 'ok') {
              state.status = 'ok';
              state.lastSuccess = now().toISOString();
              state.itemCount = bc.items.length;
              agentItemsByKey.platform_accounts = bc.items;
            } else if (bc.status === 'auth-needed') {
              state.status = 'auth-needed';
              state.error = bc.hint || bc.error || 'birdclaw not set up';
            } else {
              // 'broken' -> keep the OpsSourceStatus enum honest ('error') plus
              // the additive broken marker so the Sources UI can distinguish it.
              state.status = 'error';
              state.broken = true;
              state.error = bc.error || 'birdclaw read failed';
            }
          }
        }
      } catch {
        // birdclaw is best-effort — any unexpected failure falls back to the
        // research-agent social path (socialViaBirdclaw stays false).
        socialViaBirdclaw = false;
      }
    }

    // Research-agent leg covers the remaining agent sources: always news +
    // vendors, and social only when birdclaw is NOT the provider.
    const researchAgentSources = socialViaBirdclaw
      ? agentSources.filter((s) => s.id !== 'agent:social')
      : agentSources;

    if (!researchEnabled) {
      for (const src of researchAgentSources) {
        const state = states.get(src.id);
        // X has no native/API path, so the social source is auth-needed
        // rather than merely unavailable when the agent leg is off.
        state.status = src.id === 'agent:social' ? 'auth-needed' : 'unavailable';
        state.error = 'research agent disabled (ops-config refresh.research.enabled)';
      }
    } else if (typeof research.runAgent !== 'function') {
      for (const src of researchAgentSources) {
        const state = states.get(src.id);
        state.status = 'unavailable';
        state.error = 'research agent unavailable (no runner wired)';
      }
    } else if (researchAgentSources.length > 0) {
      try {
        const prompt = buildResearchPrompt({
          // Drop accounts from the prompt when birdclaw owns the social lane —
          // no point paying the research agent to research what birdclaw covers.
          accounts: socialViaBirdclaw ? [] : safeStringArray((watchlists as any)?.accounts),
          vendors: safeStringArray((watchlists as any)?.changelogs),
          nowIso: now().toISOString(),
        });
        const raw = await research.runAgent({ prompt, timeoutMs: researchTimeoutMs });
        const parsed = parseResearchOutput(raw);
        if (!parsed) throw new Error('research agent output was not parseable JSON');
        const byKey = new Map(parsed.sections.map((s: any) => [s.key, s.items]));
        for (const src of researchAgentSources) {
          const state = states.get(src.id);
          const key = AGENT_SECTION_KEYS[src.id];
          if (byKey.has(key)) {
            const items = byKey.get(key) ?? [];
            state.status = 'ok';
            state.lastSuccess = now().toISOString();
            state.itemCount = items.length;
            agentItemsByKey[key] = items;
          } else {
            state.status = 'error';
            state.error = `research agent returned no ${key} section`;
          }
        }
      } catch (err: any) {
        for (const src of researchAgentSources) {
          const state = states.get(src.id);
          state.status = 'error';
          state.error = err?.message ?? String(err);
        }
      }
    }

    // --- finance (derived from the external report's freshness; never
    // fetched natively — provenance stays with latest.json, so no fabricated
    // lastSuccess even when ok) ---
    const finance = states.get('report:finance');
    if (finance) {
      finance.lastAttempt = now().toISOString();
      const rf = safeCtx.reportFreshness;
      if (rf === 'fresh' || rf === 'stale') {
        finance.status = 'ok';
        finance.lastSuccess = null;
      } else {
        finance.status = 'unavailable';
        finance.error =
          rf === 'expired'
            ? 'external intel report expired (>24h old)'
            : 'external intel report missing';
      }
    }

    // lastSuccess only advances on success; failures keep the previous value.
    for (const state of states.values()) {
      if (state.status !== 'ok') {
        state.lastSuccess = prev.sources?.[state.id]?.lastSuccess ?? null;
      }
    }

    result.sources = registry.map((src) => states.get(src.id));

    // --- persist (all best-effort; never throw) ---
    const updatedAt = now().toISOString();
    if (stateDir) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        // Rebuild from the CURRENT registry only — sources dropped from the
        // watchlist must not linger forever as ghost 'ok' entries in the brief
        // source-freshness line. Surviving sources already carry forward their
        // prior lastSuccess (restored above on failure).
        const sourcesMap: any = {};
        for (const state of states.values()) sourcesMap[state.id] = state;
        fs.writeFileSync(
          path.join(stateDir, OPS_REFRESH_STATE_FILE),
          JSON.stringify(
            { $schema: 'ace.ops.source-state.v1', updatedAt, sources: sourcesMap },
            null,
            2
          )
        );
      } catch {
        // state persistence is convenience-only; never throw.
      }
      try {
        const ok = result.sources.filter((s: any) => s.status === 'ok').length;
        const failed = result.sources.filter((s: any) => s.status === 'error').length;
        fs.appendFileSync(
          path.join(stateDir, OPS_REFRESH_HISTORY_FILE),
          JSON.stringify({
            at,
            trigger,
            lens,
            ok,
            failed,
            sources: result.sources.map((s: any) => ({ id: s.id, status: s.status })),
          }) + '\n'
        );
      } catch {
        // history persistence is convenience-only; never throw.
      }
    }

    if (localIntelPath) {
      try {
        const existing = readJsonFile(localIntelPath);
        const prevSections = new Map(
          (Array.isArray(existing?.sections) ? existing.sections : [])
            .filter((s: any) => s && typeof s === 'object' && typeof s.key === 'string')
            .map((s: any) => [s.key, s])
        );
        const sections: any[] = [];
        const pushSection = (
          key: string,
          title: string,
          provenance: string,
          succeeded: boolean,
          items: any[]
        ) => {
          if (succeeded) {
            sections.push({ key, title, provenance, fetchedAt: updatedAt, items });
          } else if (prevSections.has(key)) {
            // stale-but-real beats gone: keep the previously fetched section.
            sections.push(prevSections.get(key));
          }
        };

        const feedOk = feedSources.some((src) => states.get(src.id).status === 'ok');
        const feedItems: any[] = [];
        for (const items of feedItemsBySource.values()) feedItems.push(...items);
        feedItems.sort((a: any, b: any) => {
          // newest first; null/unparseable timestamps sort last.
          const ta = a?.timestamp ? Date.parse(a.timestamp) : NaN;
          const tb = b?.timestamp ? Date.parse(b.timestamp) : NaN;
          if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
          if (Number.isNaN(ta)) return 1;
          if (Number.isNaN(tb)) return -1;
          return tb - ta;
        });
        pushSection('official_feeds', 'Official feeds', 'native', feedOk, feedItems);

        const repoOk = repoSources.some((src) => states.get(src.id).status === 'ok');
        pushSection('github_watch', 'GitHub watch', 'native', repoOk, repoItems);

        pushSection(
          'platform_accounts',
          'Social / X',
          'agent',
          states.get('agent:social')?.status === 'ok',
          agentItemsByKey.platform_accounts ?? []
        );
        pushSection(
          'world_news',
          'World news',
          'agent',
          states.get('agent:news')?.status === 'ok',
          agentItemsByKey.world_news ?? []
        );
        pushSection(
          'vendor_updates',
          'Vendor updates',
          'agent',
          states.get('agent:vendors')?.status === 'ok',
          agentItemsByKey.vendor_updates ?? []
        );

        fs.mkdirSync(path.dirname(localIntelPath), { recursive: true });
        fs.writeFileSync(
          localIntelPath,
          JSON.stringify(
            { $schema: 'ace.ops.intel-local.v1', generatedAt: updatedAt, sections },
            null,
            2
          )
        );
      } catch {
        // local intel persistence is convenience-only; never throw.
      }
    }
  } catch (err: any) {
    try {
      (safeCtx.logger ?? console).error('[ace] ops source refresh failed:', err);
    } catch {
      // even logging is best-effort
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// refreshStatus — pure read, safe to wire directly as an IPC handler
// ---------------------------------------------------------------------------

/**
 * Snapshot of persisted source state: { sources (sorted by class then id),
 * lastRunAt, lastTrigger }. Missing/corrupt files -> empty/null fields.
 * Never throws.
 */
function refreshStatus(input: any = {}): {
  sources: any[];
  lastRunAt: string | null;
  lastTrigger: string | null;
} {
  const out: any = { sources: [], lastRunAt: null, lastTrigger: null };
  try {
    const stateDir = input?.stateDir;
    if (typeof stateDir !== 'string' || stateDir.length === 0) return out;
    const state = readSourceState(stateDir);
    const sources = Object.values(state.sources ?? {}).filter(
      (s: any) => s && typeof s === 'object'
    );
    sources.sort((a: any, b: any) => {
      const byClass = String(a.class ?? '').localeCompare(String(b.class ?? ''));
      return byClass !== 0 ? byClass : String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });
    out.sources = sources;
    const lastEntry = readLastHistoryEntry(stateDir);
    if (lastEntry) {
      out.lastRunAt = typeof lastEntry.at === 'string' ? lastEntry.at : null;
      out.lastTrigger = typeof lastEntry.trigger === 'string' ? lastEntry.trigger : null;
    } else if (typeof state.updatedAt === 'string') {
      out.lastRunAt = state.updatedAt;
    }
  } catch {
    // fall through to the empty snapshot
  }
  return out;
}

// ---------------------------------------------------------------------------
// mostRecentPastSlot / scheduleOpsSourceCatchUp — boot catch-up
// ---------------------------------------------------------------------------

/**
 * Most recent occurrence of any [{hour, minute, lens}] local-time slot at or
 * before `now` (may be yesterday's last slot). Empty/invalid schedule -> null.
 */
function mostRecentPastSlot(schedule: any, now: Date = new Date()): Date | null {
  try {
    if (!Array.isArray(schedule) || schedule.length === 0) return null;
    let best: Date | null = null;
    for (const entry of schedule) {
      const hour = entry?.hour;
      const minute = entry?.minute ?? 0;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) continue;
      const slot = new Date(now);
      slot.setHours(hour, minute, 0, 0);
      if (slot > now) slot.setDate(slot.getDate() - 1);
      if (!best || slot > best) best = slot;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Arm a one-shot boot catch-up: when the newest successful refresh predates
 * the most recent past schedule slot (or no refresh ever ran), run
 * store.opsRefreshSources({ trigger: 'catch-up' }) after delayMs (default
 * 30s). Failures inside the callback are swallowed so the runtime survives.
 *
 * Returns false when the contract is unmet (no getStore / subscriptions
 * array) or when no catch-up is needed; true when a timer was armed.
 */
function scheduleOpsSourceCatchUp(options: any): boolean {
  const getStore = options?.getStore;
  const subscriptions = options?.subscriptions;
  if (typeof getStore !== 'function' || !Array.isArray(subscriptions)) return false;

  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const now: () => Date = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 30000;
  const schedule =
    Array.isArray(options.schedule) && options.schedule.length > 0
      ? options.schedule
      : OPS_REFRESH_SCHEDULE;

  const slot = mostRecentPastSlot(schedule, now());
  if (!slot) return false;

  const coveredAt = lastSuccessfulRunAt(options.stateDir);
  if (coveredAt) {
    const lastMs = Date.parse(coveredAt);
    if (!Number.isNaN(lastMs) && lastMs >= slot.getTime()) return false; // covered by a successful run
  }

  const timer = setTimeoutImpl(() => {
    Promise.resolve()
      .then(() => getStore().opsRefreshSources({ trigger: 'catch-up', allowResearchAgent: false }))
      .catch((err: any) => {
        logger.error('[ace] ops source catch-up refresh failed:', err);
      });
  }, delayMs);
  subscriptions.push(() => clearTimeoutImpl(timer));
  return true;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  LOCAL_INTEL_FILE,
  OPS_REFRESH_HISTORY_FILE,
  OPS_REFRESH_STATE_FILE,
  buildResearchPrompt,
  deriveSourceRegistry,
  mostRecentPastSlot,
  parseFeedXml,
  parseResearchOutput,
  refreshStatus,
  runOpsRefresh,
  scheduleOpsSourceCatchUp,
};
