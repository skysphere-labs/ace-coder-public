// knowledge-contract.cts — single source of truth for knowledge-plane invariants.
//
// Shared by BOTH the Electron app (wiki-truth, wiki-updater, wiki-graph-indexer,
// knowledge-index) and the standalone ace CLI (project-wiki-curator,
// project-harness-handlers, memory-handlers). The CLI ships with electron/harness/
// present (same pattern as electron/harness/completion-result.cts, required from
// tools/ace/src/index.cts), so cross-package requires compile and package fine.
//
// Hard rules:
//   - Node built-ins only. No electron, no third-party deps.
//   - Pure data + pure functions. No fs, no env reads, no I/O.
//   - Patterns here gate writes toward quarantine/refusal; widening a pattern
//     fails SAFE (more quarantine), narrowing one fails OPEN — never narrow
//     without checking every consumer.

// ---------------------------------------------------------------------------
// Failed-probe sentinel (the exact wording agents key on — never reword)
// ---------------------------------------------------------------------------

const WIKI_FAILED_SNAPSHOT_SENTENCE =
  'Snapshot failed; do not infer current state from this section.';

// ---------------------------------------------------------------------------
// Contamination patterns (union of the previously-duplicated per-module sets;
// every gate fails toward quarantine, so the union is the safe direction)
// ---------------------------------------------------------------------------

const DORMANT_STREAM_PATTERNS = [
  /dormant\s*\(\d+\):/i,
  /\|?\s*state=dormant/i,
  /live=false/i,
];

const FAILED_PROBE_PATTERNS = [
  /socket\s+not\s+found/i,
  /ECONNREFUSED/i,
  /401\s+unauthorized/i,
  /not\s+authenticated/i,
  /GH_TOKEN/i,
];

const RAW_TRANSCRIPT_PATTERNS = [
  /\b(raw )?(terminal|agent|chat) transcript\b/i,
  /\bUser:\s*[\s\S]{120,}\bAssistant:/i,
  /\btool_use_id\b/i,
];

const VAGUE_PATTERNS = [
  /^ace is broken\.?$/i,
  /^always validate everything\.?$/i,
  /^fix it\.?$/i,
  /^make it better\.?$/i,
  /^needs work\.?$/i,
];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|token|secret|authorization|cookie)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{12,}/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
];

// ---------------------------------------------------------------------------
// Trust tiers, freshness, decay
// ---------------------------------------------------------------------------

const TRUST_TIERS = ['canon', 'working', 'raw', 'external'];

const TRUST_WEIGHTS: Record<string, number> = {
  canon: 1.0,
  working: 0.8,
  external: 0.6,
  raw: 0.4,
};

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;   //  7 days
const STALE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

const FRESHNESS_WEIGHTS: Record<string, number> = {
  fresh: 1.0,
  stale: 0.7,
  expired: 0.4,
  unknown: 0.7,
};

const DECAY_DEFAULT = 1.0;
const DECAY_MIN = 0.05;
// Results whose effective score multiplier (trust × freshness × decay) falls
// below this are excluded from default retrieval (still reachable with
// --include-decayed). Decay alone below this floor also excludes.
const DECAY_RESULT_FLOOR = 0.3;

// ---------------------------------------------------------------------------
// LLM-wiki / OKF canon contracts (sensitivity, page status, event/candidate
// vocabularies, promotion threshold). The on-disk canon is Markdown + YAML
// frontmatter (Google OKF base + Ace fields); these constants are the
// single source of truth for the writeback → candidate → tiered-gate pipeline.
// ---------------------------------------------------------------------------

// Sensitivity gates BOTH promotion and retrieval (PRD §10). Ordered low→high.
const SENSITIVITY_CLASSES = ['public', 'internal', 'restricted', 'forbidden'];
const SENSITIVITY_DEFAULT = 'internal';
// Only public/internal may auto-promote into canon; restricted/forbidden are
// always routed to the owner inbox regardless of confidence.
const SENSITIVITY_AUTO_PROMOTABLE = ['public', 'internal'];
// `forbidden` is never returned by retrieval and never promoted; everything
// else is retrievable (restricted is retrievable but flagged by callers).
function normalizeSensitivity(value: any): string {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return SENSITIVITY_CLASSES.includes(text) ? text : SENSITIVITY_DEFAULT;
}
function isAutoPromotableSensitivity(value: any): boolean {
  return SENSITIVITY_AUTO_PROMOTABLE.includes(normalizeSensitivity(value));
}
function isRetrievableSensitivity(value: any): boolean {
  return normalizeSensitivity(value) !== 'forbidden';
}

// OKF/Ace page lifecycle (frontmatter `status:` for canon pages).
const WIKI_PAGE_STATUSES = ['draft', 'candidate', 'canon', 'superseded', 'deprecated'];

// KnowledgeEvent kinds (append-only spine; §5.2). `*_note` are operator/agent
// dumps already handled by the curator; the rest are runtime writeback events.
const KNOWLEDGE_EVENT_KINDS = [
  'goal_done', 'goal_blocked', 'pr_open', 'pr_merge',
  'validator_pass', 'validator_fail', 'release_verified',
  'chief_decision', 'research_capture', 'project_create', 'nightly',
  'operator_note', 'memory_note',
];

// WikiCandidate types (§5.3) — a superset of the existing curator candidate
// shape so the two pipelines stay interoperable.
const WIKI_CANDIDATE_TYPES = [
  'status_update', 'completed_item', 'next_action', 'blocker', 'decision', 'fact',
];

// Default auto-promote confidence threshold (rubric Q-C default 0.8).
const DEFAULT_PROMOTE_CONFIDENCE = 0.8;

// Map the curator's qualitative confidence labels to the PRD's 0–1 scale, and
// clamp numeric input. Unknown → a conservative 0.5 (below the promote bar).
const CONFIDENCE_LABELS: Record<string, number> = {
  verified: 0.95, high: 0.9, medium: 0.6, low: 0.3, unverified: 0.3,
};
function normalizeConfidence(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === '') return 0.5;
  if (/^-?\d*\.?\d+$/.test(text)) return Math.max(0, Math.min(1, Number(text)));
  return CONFIDENCE_LABELS[text] ?? 0.5;
}

// ---------------------------------------------------------------------------
// Ops-wiki page schema (AceOpsPage/v1)
// ---------------------------------------------------------------------------

const OPS_PAGE_SCHEMA = 'AceOpsPage/v1';

const OPS_PAGE_KINDS = [
  'project', 'todo', 'journal', 'run-digest', 'decision', 'lesson',
  'entity', 'concept', 'reference', 'dashboard',
  'plan', 'playbook', 'research', 'brief',
];

const OPS_PAGE_STATUSES = ['active', 'done', 'superseded', 'draft'];

// Controlled tag vocabulary: the existing SCHEMA.md taxonomy plus life-domain
// tags. Free-form tags are allowed only under the FREE_TAG_PREFIX (Obsidian
// nested tags), so the controlled vocabulary never silently grows.
const TAG_VOCABULARY = [
  // existing ~wiki/ace-ops SCHEMA.md taxonomy
  'ace', 'project', 'workspace', 'orchestrator', 'worker',
  'pr', 'worktree', 'deploy', 'ci-cd', 'mobile', 'prompt',
  'regression', 'skygems', 'ace', 'rhino', 'plugin', 'wiki',
  // knowledge-plane additions
  'life', 'daily', 'todo', 'decision', 'lesson', 'pitfall', 'pattern',
  'person', 'infra', 'health', 'finance', 'research', 'concept', 'reference',
];

const FREE_TAG_PREFIX = 'x/';

// Vault directory → default trust tier when a page has no (valid) frontmatter.
// Longest-prefix match wins; paths are vault-relative with posix slashes.
const VAULT_TRUST_BY_PREFIX: Array<[string, string]> = [
  ['inbox/', 'raw'],
  ['quarantine/', 'raw'],
  ['raw/', 'raw'],
  ['logs/', 'raw'],
  ['journal/', 'working'],
  ['runs/', 'working'],
  ['todo/', 'working'],
  ['briefs/', 'working'],
  ['dashboards/', 'canon'],
  ['portfolios/', 'canon'],
  ['decisions/', 'canon'],
  ['lessons/', 'canon'],
  ['entities/', 'canon'],
  ['concepts/', 'canon'],
  ['references/', 'canon'],
  ['plans/', 'canon'],
  ['playbooks/', 'canon'],
  ['research/', 'canon'],
];

// Vault directory → default kind (same matching rules).
const VAULT_KIND_BY_PREFIX: Array<[string, string]> = [
  ['journal/', 'journal'],
  ['runs/', 'run-digest'],
  ['todo/', 'todo'],
  ['briefs/', 'brief'],
  ['dashboards/', 'dashboard'],
  ['portfolios/', 'project'],
  ['decisions/', 'decision'],
  ['lessons/', 'lesson'],
  ['entities/', 'entity'],
  ['concepts/', 'concept'],
  ['references/', 'reference'],
  ['plans/', 'plan'],
  ['playbooks/', 'playbook'],
  ['research/', 'research'],
];

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

const KNOWLEDGE_SCHEMAS = {
  opsPage: OPS_PAGE_SCHEMA,
  searchResult: 'AceMemorySearchResult/v1',
  entry: 'AceMemoryEntry/v1',
  remember: 'AceMemoryRememberResult/v1',
  auditReport: 'AceKnowledgeAuditReport/v1',
  nightlyRun: 'AceKnowledgeNightlyRun/v1',
  knowledgeEvent: 'AceKnowledgeEvent/v1',
  wikiCandidate: 'AceWikiCandidate/v1',
  wikiInbox: 'AceWikiInboxEntry/v1',
  wikiHealth: 'AceWikiHealth/v1',
  explain: 'AceMemoryExplain/v1',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function allText(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (typeof value === 'object') return Object.values(value).map(allText).join('\n');
  return String(value);
}

function secretHits(value: any): string[] {
  const text = allText(value);
  return SECRET_PATTERNS.filter((rx) => rx.test(text)).map((rx) => rx.source);
}

function redactSecrets(value: any): any {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((text, rx) => text.replace(rx, '[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactSecrets(child);
    return out;
  }
  return value;
}

/**
 * Describe contamination in operator-facing text.
 *
 * @param opts.allowSentinel  when true (curator semantics), failed-probe text
 *   accompanied by the exact sentinel sentence is NOT contamination — the
 *   fail-closed block is the sanctioned way to record a failed probe.
 *   When false (wiki-truth operator-facing semantics), any failed-probe hint
 *   is contamination regardless of sentinel.
 */
function describeContamination(value: any, opts: any = {}): string[] {
  const text = allText(value);
  const reasons: string[] = [];
  if (!text) return reasons;
  if (DORMANT_STREAM_PATTERNS.some((rx) => rx.test(text))) reasons.push('raw-dormant-stream');
  if (RAW_TRANSCRIPT_PATTERNS.some((rx) => rx.test(text))) reasons.push('raw-transcript');
  if (FAILED_PROBE_PATTERNS.some((rx) => rx.test(text))) {
    if (!(opts.allowSentinel === true && text.includes(WIKI_FAILED_SNAPSHOT_SENTENCE))) {
      reasons.push('failed-probe-leak');
    }
  }
  return reasons;
}

function formatFailedSnapshotSection({
  section,
  timestamp,
  command,
  failureReason,
  nextLiveCommand,
}: any = {}) {
  const safeSection = String(section || 'snapshot').trim();
  const safeTimestamp = String(timestamp || new Date().toISOString()).trim();
  const safeCommand = String(command || '').trim();
  const safeReason = String(failureReason || 'unknown').trim();
  const safeNext = String(nextLiveCommand || '').trim();
  return [
    `## ${safeSection}`,
    '',
    WIKI_FAILED_SNAPSHOT_SENTENCE,
    '',
    `- timestamp: ${safeTimestamp}`,
    `- source-command: ${safeCommand || '(unknown)'}`,
    `- failure-reason: ${safeReason}`,
    `- next-live-command: ${safeNext || '(none specified)'}`,
    '- status: non-authoritative',
  ].join('\n');
}

function isAllowedTag(tag: any): boolean {
  const text = String(tag == null ? '' : tag).trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith(FREE_TAG_PREFIX)) return text.length > FREE_TAG_PREFIX.length;
  return TAG_VOCABULARY.includes(text);
}

function matchByPrefix(table: Array<[string, string]>, relPath: any): string | null {
  const normalized = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, value] of table) {
    if (normalized.startsWith(prefix) && prefix.length > bestLen) {
      best = value;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Default trust tier for a vault-relative path with no valid frontmatter. */
function inferVaultTrust(relPath: any): string {
  return matchByPrefix(VAULT_TRUST_BY_PREFIX, relPath) || 'working';
}

/** Default kind for a vault-relative path with no valid frontmatter. */
function inferVaultKind(relPath: any): string {
  return matchByPrefix(VAULT_KIND_BY_PREFIX, relPath) || 'reference';
}

function computeFreshness(mtimeMs: any, nowMs: any): string {
  const mtime = Number(mtimeMs);
  const now = Number(nowMs);
  if (!Number.isFinite(mtime) || !Number.isFinite(now)) return 'unknown';
  const age = now - mtime;
  if (age < FRESH_MS) return 'fresh';
  if (age < STALE_MS) return 'stale';
  return 'expired';
}

// ---------------------------------------------------------------------------
// Frontmatter parsing + validation (minimal YAML subset — strings, numbers,
// booleans, null, inline arrays, simple block arrays; no nesting beyond that)
// ---------------------------------------------------------------------------

function parseScalar(raw: string): any {
  const text = raw.trim();
  if (text === '' || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const unquoted = text.replace(/^['"]|['"]$/g, '');
  return unquoted;
}

function parseInlineArray(raw: string): any[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((part) => parseScalar(part)).filter((v) => v !== null && v !== '');
}

/**
 * Parse a leading YAML frontmatter block. Returns:
 *   { present: boolean, data: object, body: string }
 * Never throws; malformed lines are skipped.
 */
function parseFrontmatter(content: any): { present: boolean; data: any; body: string } {
  const text = String(content == null ? '' : content);
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!match) return { present: false, data: {}, body: text };
  const body = text.slice(match[0].length);
  const data: any = {};
  let pendingArrayKey: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    const itemMatch = rawLine.match(/^\s+-\s*(.*)$/);
    if (itemMatch && pendingArrayKey) {
      const value = parseScalar(itemMatch[1]);
      if (value !== null && value !== '') data[pendingArrayKey].push(value);
      continue;
    }
    const kvMatch = rawLine.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const rawValue = kvMatch[2];
    if (rawValue.trim() === '') {
      data[key] = [];
      pendingArrayKey = key;
      continue;
    }
    pendingArrayKey = null;
    if (rawValue.trim().startsWith('[')) data[key] = parseInlineArray(rawValue);
    else data[key] = parseScalar(rawValue);
  }
  return { present: true, data, body };
}

/**
 * Validate AceOpsPage/v1 frontmatter.
 *
 * Legacy pages (no frontmatter, or frontmatter without `schema:`) are NEVER
 * failures — they return { ok: true, legacy: true } so existing vault content
 * is permanently tolerated. Validation errors only apply to pages that claim
 * the schema.
 */
function validateOpsPageFrontmatter(data: any): { ok: boolean; legacy: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || !data.schema) {
    return { ok: true, legacy: true, errors };
  }
  if (data.schema !== OPS_PAGE_SCHEMA) {
    // Other schema families (AceProjectPage/v1 etc.) validate elsewhere.
    return { ok: true, legacy: true, errors };
  }
  if (!data.kind || !OPS_PAGE_KINDS.includes(String(data.kind))) {
    errors.push(`kind must be one of: ${OPS_PAGE_KINDS.join('|')}`);
  }
  if (data.status !== undefined && data.status !== null && !OPS_PAGE_STATUSES.includes(String(data.status))) {
    errors.push(`status must be one of: ${OPS_PAGE_STATUSES.join('|')}`);
  }
  const trust = String(data.trust || '');
  if (!TRUST_TIERS.includes(trust)) {
    errors.push(`trust must be one of: ${TRUST_TIERS.join('|')}`);
  }
  if (trust === 'canon') {
    const sources = Array.isArray(data.sources) ? data.sources.filter((s: any) => String(s || '').trim()) : [];
    if (sources.length === 0) errors.push('canon pages require non-empty sources[]');
  }
  if (data.tags !== undefined && !Array.isArray(data.tags)) {
    errors.push('tags must be an array');
  }
  const badTags = (Array.isArray(data.tags) ? data.tags : []).filter((t: any) => !isAllowedTag(t));
  if (badTags.length > 0) {
    errors.push(`tags outside vocabulary (use ${FREE_TAG_PREFIX}<name> for free tags): ${badTags.join(', ')}`);
  }
  if (data.updatedAt !== undefined && data.updatedAt !== null && Number.isNaN(Date.parse(String(data.updatedAt)))) {
    errors.push('updatedAt must be an ISO date');
  }
  if (data.expiresAt !== undefined && data.expiresAt !== null && Number.isNaN(Date.parse(String(data.expiresAt)))) {
    errors.push('expiresAt must be an ISO date');
  }
  return { ok: errors.length === 0, legacy: false, errors };
}

// ---------------------------------------------------------------------------
// Canon-first explain (pure) — shapes one cited answer from search rows that
// are already trust-ranked (canon outranks raw). Invariants: `forbidden` is
// never returned; a non-canon best hit is EXPLICITLY labeled a raw fallback.
// ---------------------------------------------------------------------------

function explainFromResults(input: any = {}): any {
  const query = String(input.query || '');
  const results = Array.isArray(input.results) ? input.results : [];
  const citationsByPath = input.citationsByPath || {};
  const visible = results.filter((r: any) => r && r.sensitivity !== 'forbidden');
  const canon = visible.filter((r: any) => r.trust === 'canon');
  const best = canon[0] || visible[0] || null;
  const rawFallback = !!best && best.trust !== 'canon';
  const cited = best && Array.isArray(citationsByPath[best.path]) && citationsByPath[best.path].length
    ? citationsByPath[best.path]
    : (best ? [best.relPath || best.path] : []);
  return {
    schema: KNOWLEDGE_SCHEMAS.explain,
    query,
    found: !!best,
    rawFallback,
    label: !best
      ? 'no-match'
      : (rawFallback ? 'raw-fallback — no canon hit; treat as unverified evidence' : 'canon'),
    answer: best ? (best.excerpt || best.title || '') : null,
    source: best
      ? { path: best.path, relPath: best.relPath, source: best.source, trust: best.trust, project: best.project, title: best.title, score: best.score }
      : null,
    citations: cited,
    canonCount: canon.length,
    totalCount: visible.length,
    alternatives: visible.slice(0, 5).map((r: any) => ({ path: r.path, trust: r.trust, title: r.title, score: r.score })),
  };
}

// ---------------------------------------------------------------------------
// Wiki/knowledge health summary (pure) — shared by the `wiki health` CLI, the
// `memory status` CLI and the renderer panel. Headline signal is
// `dumpOnlyProjects`: a non-empty list is the warning that would have caught
// the original dump-only-no-canon bug.
// ---------------------------------------------------------------------------

const HEALTH_FRESH_MS = 36 * 60 * 60 * 1000;
const HEALTH_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function healthNum(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function healthFreshness(at: any, nowMs: number): string {
  if (!at) return 'never';
  const t = Date.parse(String(at));
  if (Number.isNaN(t)) return 'unknown';
  const age = nowMs - t;
  if (age < HEALTH_FRESH_MS) return 'fresh';
  if (age < HEALTH_STALE_MS) return 'stale';
  return 'expired';
}

function summarizeWikiHealth(input: any = {}): any {
  const nowMs = healthNum(input.now, Date.now());
  const projects = Array.isArray(input.projects) ? input.projects : [];

  const dumpOnly = projects.filter((p: any) => p && p.dumpOnly === true);
  const dumpOnlyProjects = dumpOnly.map((p: any) => p.id || p.path).filter(Boolean);

  const canonPages = projects.reduce((s: number, p: any) => s + healthNum(p.canonPages), 0);
  const pagesWithSources = projects.reduce((s: number, p: any) => s + healthNum(p.pagesWithSources), 0);
  const stalePages = projects.reduce((s: number, p: any) => s + healthNum(p.stalePages), 0);
  const dumpRecords = projects.reduce((s: number, p: any) => s + healthNum(p.dumpRecords), 0);
  const sourceCoverage = canonPages > 0 ? Math.round((pagesWithSources / canonPages) * 100) / 100 : 1;

  // Raw-vs-canon ratio from index counts when present, else from fs page/record
  // counts (a faithful proxy that needs no running index).
  const canonDocs = healthNum(input.index?.canonDocs, canonPages);
  const rawDocs = healthNum(input.index?.rawDocs, dumpRecords);
  const rawVsCanonRatio = canonDocs > 0
    ? Math.round((rawDocs / canonDocs) * 100) / 100
    : (rawDocs > 0 ? null : 0);

  const lastNightlyAt = input.nightly?.at || null;
  const lastNightlyStatus = input.nightly?.status || (lastNightlyAt ? 'ok' : 'never');
  const indexFreshness = healthFreshness(lastNightlyAt, nowMs);

  const candidatesAccepted = healthNum(input.curation?.accepted);
  const candidatesRejected = healthNum(input.curation?.rejected);
  const inboxPending = healthNum(input.inbox?.pending);

  const flags: string[] = [];
  if (dumpOnlyProjects.length > 0) flags.push(`dump-only projects (no canon): ${dumpOnlyProjects.join(', ')}`);
  if (lastNightlyStatus === 'never') flags.push('nightly curator has never run');
  if (lastNightlyStatus === 'error') flags.push('last nightly curator run errored');
  if (indexFreshness === 'expired') flags.push('knowledge index is stale (no recent nightly)');
  if (rawVsCanonRatio === null) flags.push('raw knowledge with zero canon pages');
  if (sourceCoverage < 1 && canonPages > 0) flags.push(`${Math.round((1 - sourceCoverage) * 100)}% of canon pages lack a source trail`);
  if (inboxPending > 0) flags.push(`${inboxPending} candidate(s) awaiting owner review in the wiki inbox`);

  let severity: 'green' | 'amber' | 'black' = 'green';
  if (lastNightlyStatus === 'error') severity = 'black';
  else if (flags.length > 0) severity = 'amber';

  return {
    schema: KNOWLEDGE_SCHEMAS.wikiHealth,
    generatedAt: new Date(nowMs).toISOString(),
    severity,
    healthy: severity === 'green',
    projectsTotal: projects.length,
    dumpOnlyCount: dumpOnlyProjects.length,
    dumpOnlyProjects,
    canonPages,
    dumpRecords,
    stalePages,
    sourceCoverage,
    rawVsCanonRatio,
    indexTotal: input.index?.total ?? null,
    canonDocs,
    rawDocs,
    lastNightlyAt,
    lastNightlyStatus,
    indexFreshness,
    candidatesAccepted,
    candidatesRejected,
    inboxPending,
    flags,
  };
}

module.exports = {
  WIKI_FAILED_SNAPSHOT_SENTENCE,
  DORMANT_STREAM_PATTERNS,
  explainFromResults,
  summarizeWikiHealth,
  FAILED_PROBE_PATTERNS,
  RAW_TRANSCRIPT_PATTERNS,
  VAGUE_PATTERNS,
  SECRET_PATTERNS,
  TRUST_TIERS,
  TRUST_WEIGHTS,
  FRESH_MS,
  STALE_MS,
  FRESHNESS_WEIGHTS,
  DECAY_DEFAULT,
  DECAY_MIN,
  DECAY_RESULT_FLOOR,
  SENSITIVITY_CLASSES,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_AUTO_PROMOTABLE,
  WIKI_PAGE_STATUSES,
  KNOWLEDGE_EVENT_KINDS,
  WIKI_CANDIDATE_TYPES,
  DEFAULT_PROMOTE_CONFIDENCE,
  normalizeSensitivity,
  isAutoPromotableSensitivity,
  isRetrievableSensitivity,
  normalizeConfidence,
  OPS_PAGE_SCHEMA,
  OPS_PAGE_KINDS,
  OPS_PAGE_STATUSES,
  TAG_VOCABULARY,
  FREE_TAG_PREFIX,
  KNOWLEDGE_SCHEMAS,
  allText,
  secretHits,
  redactSecrets,
  describeContamination,
  formatFailedSnapshotSection,
  isAllowedTag,
  inferVaultTrust,
  inferVaultKind,
  computeFreshness,
  parseFrontmatter,
  validateOpsPageFrontmatter,
};
