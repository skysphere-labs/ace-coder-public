// wiki-knowledge.cts — the LLM-wiki writeback spine.
//
//   raw evidence → KnowledgeEvent (append-only) → WikiCandidate → tiered gate
//                  → auto-promote into OKF canon  OR  → owner inbox
//
// This module sits ON TOP of project-wiki-curator.cts (which owns the canon
// Markdown format) and adds the event/candidate/gate/inbox layer the PRD
// describes. Hard rules (mirrors the curator + knowledge-contract):
//   - Node built-ins only. No electron, no third-party deps.
//   - Markdown canon is the source of truth; these ndjson stores are evidence
//     and queue state, never authoritative knowledge.
//   - Auto-promotion is conservative: a candidate reaches canon only when it is
//     sourced, confident, non-sensitive AND non-contradicting (D3). Anything
//     that contradicts/supersedes canon or is sensitive ALWAYS goes to the
//     inbox for owner review — the BEE-scar guard (never LLM-auto-write canon).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  KNOWLEDGE_SCHEMAS,
  KNOWLEDGE_EVENT_KINDS,
  WIKI_CANDIDATE_TYPES,
  DEFAULT_PROMOTE_CONFIDENCE,
  SENSITIVITY_CLASSES,
  normalizeSensitivity,
  normalizeConfidence,
  isAutoPromotableSensitivity,
  secretHits,
  redactSecrets,
  describeContamination,
  parseFrontmatter,
} = require('../../../electron/harness/knowledge-contract.cts');

// The curator owns the canon Markdown writer. Lazy + dual-extension require so
// this loads at runtime (.cjs bundle) and in isolated tsx tests (.cts source).
function loadCurator(): any {
  try { return require('./project-wiki-curator.cjs'); } catch { /* fall through */ }
  return require('./project-wiki-curator.cts');
}

const EVENTS_FILE = 'wiki-events.ndjson';
const INBOX_FILE = 'wiki-inbox.ndjson';

// ---------------------------------------------------------------------------
// Small shared helpers (kept local so this module has no curator-internal deps)
// ---------------------------------------------------------------------------

function aceDir(projectDir: any): string {
  return path.join(path.resolve(String(projectDir || process.cwd())), '.ace');
}
function eventsPath(projectDir: any): string {
  return path.join(aceDir(projectDir), EVENTS_FILE);
}
function inboxPath(projectDir: any): string {
  return path.join(aceDir(projectDir), INBOX_FILE);
}
function wikiDir(projectDir: any): string {
  return path.join(aceDir(projectDir), 'wiki');
}
function isoNow(now?: any): string {
  return now ? new Date(now).toISOString() : new Date().toISOString();
}
function cleanText(value: any): string {
  return String(value == null ? '' : value).trim();
}
function asArray(value: any): any[] {
  if (Array.isArray(value)) return value.filter((v) => cleanText(v) !== '');
  return cleanText(value) === '' ? [] : [value];
}
function slugify(value: any): string {
  const text = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return text || 'project';
}
function normalizeLine(value: any): string {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
}
function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha16(value: any): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex').slice(0, 16);
}
function readNdjson(filePath: string): any[] {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function appendNdjson(filePath: string, value: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

// ---------------------------------------------------------------------------
// KnowledgeEvent store (append-only, content-addressed, idempotent)
// ---------------------------------------------------------------------------

function normalizeEvent(input: any): any {
  const payloadIn = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const payload = {
    completedItems: asArray(payloadIn.completedItems ?? input.completedItems).map(cleanText).filter(Boolean),
    nextActions: asArray(payloadIn.nextActions ?? input.nextActions).map(cleanText).filter(Boolean),
    blockers: asArray(payloadIn.blockers ?? input.blockers).map(cleanText).filter(Boolean),
    decisions: asArray(payloadIn.decisions ?? input.decisions).map(cleanText).filter(Boolean),
    facts: asArray(payloadIn.facts ?? input.facts).map(cleanText).filter(Boolean),
  };
  const kind = KNOWLEDGE_EVENT_KINDS.includes(cleanText(input.kind)) ? cleanText(input.kind) : 'operator_note';
  const event: any = {
    schema: KNOWLEDGE_SCHEMAS.knowledgeEvent,
    kind,
    projectId: cleanText(input.projectId || input.workspaceId),
    projectName: cleanText(input.projectName) || null,
    workspaceId: cleanText(input.workspaceId) || null,
    missionId: cleanText(input.missionId) || null,
    featureId: cleanText(input.featureId) || null,
    sourceRef: cleanText(input.sourceRef || input.source || input.prNumber || input.runId || input.sessionId) || null,
    summary: cleanText(input.summary),
    payload,
    sensitivity: normalizeSensitivity(input.sensitivity),
    confidence: normalizeConfidence(input.confidence),
    createdAt: cleanText(input.createdAt) || isoNow(input.now),
  };
  return event;
}

/**
 * Append a KnowledgeEvent. Content-addressed eventId dedupes re-emits, so the
 * store is append-only but idempotent: emitting the same event twice yields one
 * record. Secrets are redacted; contaminated events are stored quarantined and
 * never produce candidates. Returns { eventId, path, event, appended }.
 */
function appendKnowledgeEvent(input: any): any {
  const projectDir = input.projectDir || process.cwd();
  let event = normalizeEvent(input.event || input);
  if (!event.projectId) throw new Error('projectId is required for knowledge events');

  if (secretHits(event).length > 0) {
    event = redactSecrets(event);
    event.redactions = ['secret-like-content'];
  }
  const contamination = describeContamination(event, { allowSentinel: true });
  if (contamination.length > 0) {
    event.quarantined = true;
    event.quarantineReasons = contamination;
  }

  // Content-addressed on the SEMANTIC identity only (not createdAt / derived
  // flags), so re-emitting the same event — even at a different wall-clock —
  // dedupes to one record (append-only but idempotent).
  event.eventId = `evt_${sha16({
    kind: event.kind, projectId: event.projectId, workspaceId: event.workspaceId,
    missionId: event.missionId, featureId: event.featureId, sourceRef: event.sourceRef,
    summary: event.summary, payload: event.payload, sensitivity: event.sensitivity,
  })}`;

  // Collapse onto the existing project's canon page (projectName drives the
  // page slug). Done AFTER the eventId hash (projectName is not part of the
  // identity) so dedup stays stable.
  event.projectName = resolveProjectName(projectDir, event.projectId, event.projectName);

  const target = eventsPath(projectDir);
  const existing = new Set(readKnowledgeEvents({ projectDir, includeQuarantined: true }).map((e: any) => e.eventId));
  if (existing.has(event.eventId)) {
    return { eventId: event.eventId, path: target, event, appended: false };
  }
  appendNdjson(target, event);
  return { eventId: event.eventId, path: target, event, appended: true };
}

function readKnowledgeEvents(input: any = {}): any[] {
  const projectDir = input.projectDir || process.cwd();
  const includeQuarantined = input.includeQuarantined === true;
  const seen = new Set();
  const out = [];
  for (const event of readNdjson(eventsPath(projectDir))) {
    if (!event?.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (!includeQuarantined && event.quarantined === true) continue;
    out.push(event);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event → WikiCandidate extraction (§5.3). Every candidate carries the
// originating eventId so retrieval and audit can cite a verifiable source.
// ---------------------------------------------------------------------------

// Resolve the canonical project NAME for a projectId by scanning existing canon
// project pages' frontmatter. This collapses projectId-only WIKI_UPDATE packets
// onto the EXISTING project page (e.g. projects/brampton.md, projectId
// prj-e33a215d) instead of minting a duplicate projects/<projectId>.md. When no
// canon page matches, the fallback name (or the projectId) is used so the first
// event still bootstraps one page. Fail-safe: any error → fallback.
function resolveProjectName(projectDir: any, projectId: any, fallbackName: any): string {
  const id = cleanText(projectId);
  const fallback = cleanText(fallbackName) || id;
  if (!id) return fallback;
  const projectsDir = path.join(wikiDir(projectDir), 'projects');
  let files: string[] = [];
  try { files = fs.readdirSync(projectsDir).filter((f: string) => f.endsWith('.md')); } catch { return fallback; }
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(projectsDir, file), 'utf8'); } catch { continue; }
    const { data } = parseFrontmatter(content);
    if (cleanText(data.projectId) === id) {
      // Prefer the page's title; fall back to its filename slug so the curator's
      // projectSlug(projectName) re-derives the SAME existing page filename.
      return cleanText(data.title) || file.replace(/\.md$/, '');
    }
  }
  return fallback;
}

function projectPageFor(event: any): string {
  return `projects/${slugify(event.projectName || event.projectId)}.md`;
}
function decisionPageFor(event: any): string {
  return `decisions/${slugify(event.projectName || event.projectId)}-decisions.md`;
}

function makeCandidate(event: any, type: string, text: string, targetPage: string, extra: any = {}): any {
  const body: any = {
    schema: KNOWLEDGE_SCHEMAS.wikiCandidate,
    type,
    text: cleanText(text),
    targetPage,
    projectId: event.projectId,
    projectName: event.projectName || event.projectId,
    sourceEventIds: [event.eventId].filter(Boolean),
    confidence: normalizeConfidence(extra.confidence ?? event.confidence),
    sensitivity: normalizeSensitivity(extra.sensitivity ?? event.sensitivity),
    contradicts: null,
    supersedes: cleanText(extra.supersedes) || detectSupersedeMarker(text),
    status: 'proposed',
    missionId: event.missionId || null,
    prNumber: event.sourceRef && /^\d+$/.test(String(event.sourceRef)) ? Number(event.sourceRef) : null,
    createdAt: event.createdAt || isoNow(),
  };
  body.candidateId = `cand_${sha16({ ...body, candidateId: undefined })}`;
  return body;
}

function eventToCandidates(event: any): any[] {
  if (!event || event.quarantined === true || !event.projectId) return [];
  const candidates: any[] = [];
  const projectPage = projectPageFor(event);
  const decisionPage = decisionPageFor(event);
  if (cleanText(event.summary)) {
    candidates.push(makeCandidate(event, 'status_update', event.summary, projectPage));
  }
  for (const item of event.payload?.completedItems || []) candidates.push(makeCandidate(event, 'completed_item', item, projectPage));
  for (const item of event.payload?.nextActions || []) candidates.push(makeCandidate(event, 'next_action', item, projectPage));
  for (const item of event.payload?.blockers || []) candidates.push(makeCandidate(event, 'blocker', item, projectPage));
  for (const item of event.payload?.decisions || []) candidates.push(makeCandidate(event, 'decision', item, decisionPage));
  for (const item of event.payload?.facts || []) candidates.push(makeCandidate(event, 'fact', item, projectPage));
  return candidates;
}

// ---------------------------------------------------------------------------
// Tiered promotion gate (D3 / A3.x)
// ---------------------------------------------------------------------------

const SUPERSEDE_RX = /\b(supersedes?|superseding|replaces?|replacing|deprecates?|overrides?|no longer|instead of|rolled back|reverts?)\b/i;
function detectSupersedeMarker(text: any): string | null {
  return SUPERSEDE_RX.test(cleanText(text)) ? cleanText(text).match(SUPERSEDE_RX)![0].toLowerCase() : null;
}

/**
 * Read canon statements an incoming candidate could conflict with: decision
 * lines and project bullet lines already written to canon. Fail-safe: missing
 * wiki → [].
 */
function readCanonStatements(projectDir: any): Array<{ page: string; text: string }> {
  const root = wikiDir(projectDir);
  const out: Array<{ page: string; text: string }> = [];
  const walk = (dir: string) => {
    let entries: any[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (/^(deprecated|templates)\//.test(rel)) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const trimmed = line.replace(/^[-*]\s*\[[ x]\]\s*/, '').replace(/^[-*#]+\s*/, '').trim();
        if (trimmed.length >= 12) out.push({ page: rel, text: trimmed });
      }
    }
  };
  walk(root);
  return out;
}

// "key: value" / "key is value" extraction for same-key/different-value conflict.
function keyValue(text: any): { key: string; value: string } | null {
  const t = cleanText(text);
  const m = t.match(/^(.{3,60}?)\s*(?:[:=]|\bis\b|\bare\b|\bshould be\b|\bmust be\b)\s+(.+)$/i);
  if (!m) return null;
  return { key: normalizeLine(m[1]), value: normalizeLine(m[2]) };
}

/**
 * Detect whether a candidate contradicts or supersedes existing canon.
 * Returns { kind: 'supersede'|'value-conflict', page, text } or null.
 * Deterministic + conservative: explicit supersede markers ALWAYS trip
 * (BEE-scar guard), plus same-key/different-value conflicts on decisions/facts.
 */
function detectContradiction(candidate: any, canonStatements: Array<{ page: string; text: string }>): any {
  // Detect a supersede claim from the explicit field OR the candidate text, so
  // the guard trips even for hand-built candidates / post-edited text.
  const marker = cleanText(candidate.supersedes) || detectSupersedeMarker(candidate.text);
  if (marker) {
    return { kind: 'supersede', page: candidate.targetPage, text: marker };
  }
  if (!['decision', 'fact', 'status_update'].includes(candidate.type)) return null;
  const kv = keyValue(candidate.text);
  if (!kv) return null;
  for (const statement of canonStatements) {
    const other = keyValue(statement.text);
    if (!other) continue;
    if (other.key === kv.key && other.value !== kv.value) {
      return { kind: 'value-conflict', page: statement.page, text: statement.text };
    }
  }
  return null;
}

/**
 * The tiered gate. Returns { decision, reasons, candidate } where decision is
 * one of 'auto_promote' | 'inbox' | 'reject'. Order matters: a missing source
 * is a hard reject; sensitivity and contradiction force inbox even at confidence
 * 1.0; only then does the confidence threshold apply.
 */
function gateCandidate(candidate: any, opts: any = {}): any {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : DEFAULT_PROMOTE_CONFIDENCE;
  const canonStatements = opts.canonStatements || (opts.projectDir ? readCanonStatements(opts.projectDir) : []);
  const reasons: string[] = [];

  if (!Array.isArray(candidate.sourceEventIds) || candidate.sourceEventIds.length === 0) {
    return { decision: 'reject', reasons: ['missing-source-event'], candidate: { ...candidate, status: 'rejected' } };
  }
  if (cleanText(candidate.text).length < 12) {
    return { decision: 'reject', reasons: ['text-too-short'], candidate: { ...candidate, status: 'rejected' } };
  }
  if (secretHits(candidate).length > 0) {
    return { decision: 'reject', reasons: ['secret-like-content'], candidate: { ...candidate, status: 'rejected' } };
  }

  const contradiction = detectContradiction(candidate, canonStatements);
  const sensitive = !isAutoPromotableSensitivity(candidate.sensitivity);
  const lowConfidence = normalizeConfidence(candidate.confidence) < threshold;

  if (contradiction) reasons.push(`contradicts-canon:${contradiction.kind}`);
  if (sensitive) reasons.push(`sensitive:${candidate.sensitivity}`);
  if (lowConfidence) reasons.push(`below-confidence-threshold:${threshold}`);

  const enriched = { ...candidate, contradicts: contradiction || candidate.contradicts };
  // Sensitivity and contradiction ALWAYS route to inbox (never auto-promote),
  // regardless of confidence. Low-confidence-only also routes to inbox.
  if (contradiction || sensitive || lowConfidence) {
    return { decision: 'inbox', reasons, candidate: { ...enriched, status: 'inbox' } };
  }
  return { decision: 'auto_promote', reasons: [], candidate: { ...enriched, status: 'auto_promoted' } };
}

// ---------------------------------------------------------------------------
// Inbox store (pending owner review of inbox/rejected candidates)
// ---------------------------------------------------------------------------

function appendInboxEntry(projectDir: any, candidate: any, reasons: string[]): any {
  const entry = {
    schema: KNOWLEDGE_SCHEMAS.wikiInbox,
    inboxId: `inbox_${sha16({ candidateId: candidate.candidateId, reasons })}`,
    candidate,
    reasons,
    status: 'pending',
    createdAt: candidate.createdAt || isoNow(),
    resolvedAt: null,
  };
  const existing = new Set(readInbox({ projectDir, includeResolved: true }).map((e: any) => e.inboxId));
  if (existing.has(entry.inboxId)) return { ...entry, appended: false };
  appendNdjson(inboxPath(projectDir), entry);
  return { ...entry, appended: true };
}

function readInbox(input: any = {}): any[] {
  const projectDir = input.projectDir || process.cwd();
  const includeResolved = input.includeResolved === true;
  // Last write per inboxId wins (resolution is an appended record).
  const byId = new Map<string, any>();
  for (const entry of readNdjson(inboxPath(projectDir))) {
    if (!entry?.inboxId) continue;
    byId.set(entry.inboxId, entry);
  }
  const out = Array.from(byId.values());
  return includeResolved ? out : out.filter((e: any) => e.status === 'pending');
}

function resolveInbox(input: any): any {
  const projectDir = input.projectDir || process.cwd();
  const inboxId = cleanText(input.inboxId);
  const status = input.status === 'rejected' ? 'rejected' : 'promoted';
  const current = readInbox({ projectDir, includeResolved: true }).find((e: any) => e.inboxId === inboxId);
  if (!current) return { ok: false, error: `inbox entry not found: ${inboxId}` };
  const resolved = { ...current, status, resolvedAt: isoNow(input.now) };
  appendNdjson(inboxPath(projectDir), resolved);
  return { ok: true, entry: resolved };
}

// ---------------------------------------------------------------------------
// Promotion to canon
//
// A promoted candidate is written as a DURABLE dump record (id = candidateId)
// and the curator re-runs its full curation. This keeps the curator the single
// canon writer (one Markdown format, one validation path) and makes canon the
// UNION of all evidence — promoting one event never overwrites pages built from
// other dumps/events. The dump's id is the candidateId (which encodes the
// sourceEventIds), so canon's `sources` cite a verifiable trail.
// ---------------------------------------------------------------------------

function candidateToDumpRecord(candidate: any): any {
  const record: any = {
    kind: 'knowledge_event',
    identity: 'curator',
    projectId: candidate.projectId,
    projectName: candidate.projectName || candidate.projectId,
    source: (candidate.sourceEventIds || []).join(',') || candidate.candidateId,
    trust: normalizeConfidence(candidate.confidence) >= 0.9 ? 'verified' : 'self_report',
    title: cleanText(candidate.text).slice(0, 80),
    id: candidate.candidateId,
    capturedAt: candidate.createdAt || isoNow(),
    missionId: candidate.missionId || null,
    prNumber: candidate.prNumber || null,
  };
  switch (candidate.type) {
    case 'status_update': record.summary = candidate.text; break;
    case 'completed_item': record.completedItems = [candidate.text]; break;
    case 'next_action': record.proposedNextActions = [candidate.text]; break;
    case 'blocker': record.blockers = [candidate.text]; break;
    case 'decision': record.decisions = [candidate.text]; break;
    default: record.summary = candidate.text; // fact
  }
  return record;
}

function promoteCandidates(input: any): any {
  const projectDir = input.projectDir || process.cwd();
  const candidates = input.candidates || [];
  if (candidates.length === 0) return { written: [], dumps: [] };
  const curator = loadCurator();
  const dumps: string[] = [];
  for (const candidate of candidates) {
    const result = curator.writeDumpRecord({ projectDir, record: candidateToDumpRecord(candidate) });
    dumps.push(result.record.id);
  }
  // Re-curate: the curator regenerates canon from ALL dumps (originals + the
  // ones just written), so promotion is additive, not destructive.
  const curation = curator.runNightlyProjectWikiCuration({ projectDir, identity: 'all', now: isoNow(input.now) });
  return { written: curation.projectPagesUpdated || [], dumps, curation };
}

/** Promote a single inbox entry to canon and mark it resolved. */
function promoteInboxEntry(input: any): any {
  const projectDir = input.projectDir || process.cwd();
  const inboxId = cleanText(input.inboxId);
  const entry = readInbox({ projectDir, includeResolved: true }).find((e: any) => e.inboxId === inboxId);
  if (!entry) return { ok: false, error: `inbox entry not found: ${inboxId}` };
  const applied = promoteCandidates({ projectDir, candidates: [entry.candidate], now: input.now });
  const resolved = resolveInbox({ projectDir, inboxId, status: 'promoted', now: input.now });
  return { ok: true, written: applied.written, dumps: applied.dumps, entry: resolved.entry };
}

// ---------------------------------------------------------------------------
// Orchestration: events → candidates → gate → (canon | inbox)
// ---------------------------------------------------------------------------

function dedupeBy(items: any[], keyFn: any): any[] {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Curate every pending KnowledgeEvent: extract candidates, run the tiered gate,
 * auto-promote the safe ones to canon and queue the rest in the inbox. Pure
 * deterministic — no LLM. Idempotent: re-running promotes nothing new (canon
 * writes dedupe; inbox entries dedupe by id). Returns a summary.
 */
function curateFromEvents(input: any = {}): any {
  const projectDir = input.projectDir || process.cwd();
  const threshold = Number.isFinite(Number(input.threshold)) ? Number(input.threshold) : DEFAULT_PROMOTE_CONFIDENCE;
  // Re-resolve each event's project name against current canon (a matching
  // project page may have been created after the event was first stored), so
  // candidates target the existing page rather than a projectId-named duplicate.
  const events = readKnowledgeEvents({ projectDir }).map((event: any) => ({
    ...event,
    projectName: resolveProjectName(projectDir, event.projectId, event.projectName),
  }));
  const rawCandidates = events.flatMap(eventToCandidates);
  const candidates = dedupeBy(rawCandidates, (c: any) => `${c.type}:${normalizeLine(c.text)}:${c.targetPage}`);
  const canonStatements = readCanonStatements(projectDir);

  const promoted: any[] = [];
  const inboxed: any[] = [];
  const rejected: any[] = [];
  for (const candidate of candidates) {
    const result = gateCandidate(candidate, { threshold, canonStatements });
    if (result.decision === 'auto_promote') promoted.push(result.candidate);
    else if (result.decision === 'inbox') { inboxed.push(result.candidate); appendInboxEntry(projectDir, result.candidate, result.reasons); }
    else rejected.push({ candidate: result.candidate, reasons: result.reasons });
  }
  const applied = promoteCandidates({ projectDir, candidates: promoted, now: input.now });
  return {
    schema: 'AceWikiEventCuration/v1',
    eventsRead: events.length,
    candidatesExtracted: candidates.length,
    autoPromoted: promoted.length,
    inboxed: inboxed.length,
    rejected: rejected.length,
    written: applied.written,
    rejectedDetail: rejected,
  };
}

// ---------------------------------------------------------------------------
// WIKI_UPDATE writeback packet (D5 / §5.4 / A4.1)
// ---------------------------------------------------------------------------

/**
 * Parse a `WIKI_UPDATE:` block out of a worker's DONE/BLOCKED output. The block
 * is an indented mini-YAML subset (one project + an `events:` list). Returns
 * { project, events: [...] } or null when no block is present.
 *
 * This parser is intentionally INDEPENDENT of verdict.cts: it never touches the
 * DONE/BLOCKED/VERDICT trailer grammar, so adding a WIKI_UPDATE block to a
 * completion message cannot change how the verdict/scorecard parser reads it.
 */
function parseWikiUpdatePacket(text: any): any {
  const body = String(text == null ? '' : text);
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^\s*WIKI_UPDATE\s*:\s*$/i.test(line));
  if (startIdx < 0) return null;

  const baseIndent = (lines[startIdx].match(/^\s*/) || [''])[0].length;
  const packet: any = { project: null, events: [] };
  let inEvents = false;
  let current: any = null;

  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (cleanText(line) === '') continue;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    // Dedent back to/below the WIKI_UPDATE key ends the block.
    if (indent <= baseIndent) break;

    const trimmed = line.trim();
    const projectMatch = trimmed.match(/^project\s*:\s*(.+)$/i);
    if (projectMatch && !inEvents) { packet.project = cleanText(projectMatch[1]).replace(/^['"]|['"]$/g, ''); continue; }
    if (/^events\s*:\s*$/i.test(trimmed)) { inEvents = true; continue; }
    if (!inEvents) continue;

    const itemMatch = trimmed.match(/^-\s*(.*)$/);
    if (itemMatch) {
      if (current) packet.events.push(current);
      current = {};
      const rest = cleanText(itemMatch[1]);
      if (rest) applyPacketField(current, rest);
      continue;
    }
    if (current) applyPacketField(current, trimmed);
  }
  if (current) packet.events.push(current);
  return packet.events.length || packet.project ? packet : null;
}

function applyPacketField(target: any, kv: string): void {
  const m = kv.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
  if (!m) return;
  const key = m[1].trim();
  const value = cleanText(m[2]).replace(/^['"]|['"]$/g, '');
  const map: Record<string, string> = {
    kind: 'kind', summary: 'summary', sourceref: 'sourceRef', source: 'sourceRef',
    sensitivity: 'sensitivity', confidence: 'confidence', mission: 'missionId', feature: 'featureId',
  };
  const field = map[key.toLowerCase()];
  if (field) target[field] = value;
}

/**
 * Ingest a worker DONE/BLOCKED message: parse its WIKI_UPDATE packet and append
 * one KnowledgeEvent per listed event. No-op (returns null) when there is no
 * packet. `defaults.projectId` is used when the packet omits `project:`.
 */
function ingestWikiUpdate(input: any): any {
  const projectDir = input.projectDir || process.cwd();
  const packet = parseWikiUpdatePacket(input.text);
  if (!packet) return null;
  const projectId = cleanText(packet.project) || cleanText(input.defaults?.projectId) || cleanText(input.projectId);
  const appended: any[] = [];
  for (const ev of packet.events) {
    if (!projectId) continue;
    const result = appendKnowledgeEvent({
      projectDir,
      event: {
        kind: ev.kind || 'goal_done',
        projectId,
        projectName: input.defaults?.projectName,
        missionId: ev.missionId || input.defaults?.missionId,
        featureId: ev.featureId || input.defaults?.featureId,
        sourceRef: ev.sourceRef,
        summary: ev.summary,
        sensitivity: ev.sensitivity,
        confidence: ev.confidence,
        now: input.now,
      },
    });
    appended.push(result);
  }
  return { schema: 'AceWikiWriteback/v1', project: projectId, events: appended };
}

module.exports = {
  // event store
  appendKnowledgeEvent,
  readKnowledgeEvents,
  // candidate extraction
  eventToCandidates,
  resolveProjectName,
  // tiered gate
  gateCandidate,
  detectContradiction,
  readCanonStatements,
  // inbox
  appendInboxEntry,
  readInbox,
  resolveInbox,
  // promotion
  promoteCandidates,
  promoteInboxEntry,
  candidateToDumpRecord,
  // orchestration
  curateFromEvents,
  // writeback packet
  parseWikiUpdatePacket,
  ingestWikiUpdate,
  _internal: { eventsPath, inboxPath, wikiDir, slugify, keyValue, SENSITIVITY_CLASSES, WIKI_CANDIDATE_TYPES },
};
