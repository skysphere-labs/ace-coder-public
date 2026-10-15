// knowledge-index.cts — the unified knowledge-plane search index.
//
// One disposable SQLite FTS5 database (knowledge.db) over every knowledge
// source: the ops wiki vault, per-project .ace/wiki/ canon, wiki-dump
// intake (raw tier), and — in later phases — memory candidates, goal ledgers,
// and read-only Hermes memories.
//
// Design constraints (mirrors wiki-graph-indexer.cts):
//   - NO electron / store / IPC imports. Node built-ins only.
//   - The better-sqlite3 Database constructor is INJECTED — this module never
//     requires native deps itself, so it stays unit-testable and ABI-neutral.
//   - Fail-safe: unreadable roots/files are skipped, never thrown.
//   - The index is REBUILDABLE AND DISPOSABLE: `rm knowledge.db` + reindex is
//     the supported recovery path. Source markdown is always the truth.
//   - Retrieval is deliberately boring: FTS5 BM25 × trust × freshness × decay.
//     No embeddings, no rerankers (owner calibration: rich organization,
//     simple technology).

'use strict';

const fs = require('fs');
const path = require('path');

const {
  TRUST_TIERS,
  TRUST_WEIGHTS,
  FRESHNESS_WEIGHTS,
  DECAY_DEFAULT,
  DECAY_MIN,
  DECAY_RESULT_FLOOR,
  OPS_PAGE_KINDS,
  KNOWLEDGE_SCHEMAS,
  computeFreshness,
  inferVaultKind,
  inferVaultTrust,
  isAllowedTag,
  parseFrontmatter,
  secretHits,
} = require('./harness/knowledge-contract.cts');

const {
  extractTitle,
  extractTags,
  makeExcerpt,
} = require('./wiki-graph-indexer.cts');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.obsidian', '.trash']);
/** Files larger than this are skipped entirely (defensive bound). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Body text indexed into FTS is capped at this many chars. */
const MAX_BODY_CHARS = 200_000;
const EXCERPT_LENGTH = 240;
const MAX_QUERY_CHARS = 500;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
/** Over-fetch factor before JS re-ranking applies trust/fresh/decay weights. */
const CANDIDATE_POOL = 200;
// Raw-tier docs (unverified dump intake) carry NO finding-based decay, so
// without a time term a stale raw page keeps its full 1.0 multiplier forever
// (observed: 0 of ~1.3k live docs ever demoted below the fresh bucket). Apply
// an age half-life to raw tier ONLY so stale raw pages sink in ranking over
// time. Constraint: the time term is floored at DECAY_RESULT_FLOOR so time
// ALONE can never push a raw doc below the retrieval floor — this demotes
// ordering, never deletes (owner "decay don't delete" rule). Half-life = 30d
// mirrors the freshness `stale` cutoff: a raw page is worth ~half after a month.
const RAW_DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  rel_path TEXT NOT NULL,
  project TEXT,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'reference',
  trust TEXT NOT NULL DEFAULT 'working',
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT,
  expires_at TEXT,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  decay REAL NOT NULL DEFAULT 1.0,
  decay_reasons TEXT NOT NULL DEFAULT '[]',
  excerpt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS docs_source_idx ON docs(source, project);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, tags,
  content='', contentless_delete=1,
  tokenize='porter unicode61'
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFiles(dir: string, extension: string, out: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectFiles(full, extension, out);
      else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
    }
  } catch {
    // unreadable directory → return what we have
  }
  return out;
}

function readSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function statSafe(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { mtimeMs: Math.floor(stat.mtimeMs), size: stat.size };
  } catch {
    return null;
  }
}

function relPosix(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/** Legacy vault convention: an `Updated: <date>` prose line near the top. */
function extractLegacyUpdatedAt(content: string): string | null {
  const match = content.slice(0, 2000).match(/^Updated:\s*(.+)$/im);
  if (!match) return null;
  const parsed = Date.parse(match[1].trim());
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeTags(rawTags: any, content: string): string[] {
  const out = new Set<string>();
  const fromFrontmatter = Array.isArray(rawTags) ? rawTags : [];
  for (const tag of fromFrontmatter) {
    const text = String(tag == null ? '' : tag).trim().toLowerCase();
    if (text) out.add(text);
  }
  if (out.size === 0) {
    for (const tag of extractTags(content)) out.add(tag);
  }
  return Array.from(out);
}

function clampDecay(value: any): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DECAY_DEFAULT;
  return Math.max(DECAY_MIN, Math.min(1, num));
}

/**
 * Build one indexable doc from a markdown vault page. Returns null when the
 * file is unreadable or contains secret-like content (secrets are NEVER
 * indexed — dump-ingest is the first gate, this is the second).
 */
function docFromMarkdown(source: any, absPath: string): any | null {
  const content = readSafe(absPath);
  if (content === null) return null;
  if (secretHits(content).length > 0) return null;
  const stat = statSafe(absPath);
  if (!stat) return null;

  const relPath = relPosix(source.root, absPath);
  const { data } = parseFrontmatter(content);

  const trust = TRUST_TIERS.includes(String(data.trust))
    ? String(data.trust)
    : (source.defaultTrust || inferVaultTrust(relPath));
  const kind = OPS_PAGE_KINDS.includes(String(data.kind))
    ? String(data.kind)
    : (source.defaultKind || inferVaultKind(relPath));
  const updatedAt =
    (data.updatedAt && !Number.isNaN(Date.parse(String(data.updatedAt)))
      ? new Date(Date.parse(String(data.updatedAt))).toISOString()
      : null) ||
    extractLegacyUpdatedAt(content) ||
    new Date(stat.mtimeMs).toISOString();
  const expiresAt =
    data.expiresAt && !Number.isNaN(Date.parse(String(data.expiresAt)))
      ? new Date(Date.parse(String(data.expiresAt))).toISOString()
      : null;

  return {
    source: source.source,
    path: absPath,
    relPath,
    project: source.project || (typeof data.project === 'string' ? data.project : null),
    title: String(data.title || extractTitle(content, absPath)).slice(0, 300),
    kind,
    trust,
    tags: normalizeTags(data.tags, content),
    updatedAt,
    expiresAt,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    body: content.slice(0, MAX_BODY_CHARS),
    excerpt: makeExcerpt(content).slice(0, EXCERPT_LENGTH),
  };
}

/** Build one indexable doc from a wiki-dump JSON record (raw tier). */
function docFromDumpRecord(source: any, absPath: string): any | null {
  const content = readSafe(absPath);
  if (content === null) return null;
  const stat = statSafe(absPath);
  if (!stat) return null;
  let record: any;
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  // Dump records are secret-scanned + redacted at ingest (writeDumpRecord);
  // re-scan anyway so a hand-planted file can never reach the index.
  if (secretHits(record).length > 0) return null;

  const parts = [
    record.title, record.summary,
    ...(Array.isArray(record.decisions) ? record.decisions : []),
    ...(Array.isArray(record.completedItems) ? record.completedItems : []),
    ...(Array.isArray(record.proposedNextActions) ? record.proposedNextActions : []),
    ...(Array.isArray(record.blockers) ? record.blockers : []),
  ].filter((part) => typeof part === 'string' && part.trim());

  const updatedAt =
    record.capturedAt && !Number.isNaN(Date.parse(String(record.capturedAt)))
      ? new Date(Date.parse(String(record.capturedAt))).toISOString()
      : new Date(stat.mtimeMs).toISOString();

  const body = parts.join('\n').slice(0, MAX_BODY_CHARS);
  return {
    source: source.source,
    path: absPath,
    relPath: relPosix(source.root, absPath),
    project: source.project || (typeof record.projectId === 'string' ? record.projectId : null),
    title: String(record.title || record.kind || 'dump').slice(0, 300),
    kind: 'reference',
    trust: 'raw',
    tags: ['wiki'],
    updatedAt,
    expiresAt: null,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    body,
    excerpt: body.replace(/\s+/g, ' ').slice(0, EXCERPT_LENGTH).trim(),
  };
}

/**
 * Memory candidates (ace.memory_candidate.v1) from a worker's
 * completion.json — one doc per candidate, path-keyed `<file>#<index>`.
 * Worker self-reports are structured but unverified → trust 'working'.
 */
function docsFromCompletionFile(source: any, absPath: string): any[] {
  const content = readSafe(absPath);
  if (content === null) return [];
  const stat = statSafe(absPath);
  if (!stat) return [];
  let result: any;
  try {
    result = JSON.parse(content);
  } catch {
    return [];
  }
  const candidates = Array.isArray(result?.memoryCandidates) ? result.memoryCandidates : [];
  const docs: any[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const claim = typeof candidate === 'string' ? candidate : String(candidate?.claim || '').trim();
    if (!claim) continue;
    const evidence = typeof candidate === 'object' && candidate?.evidence ? String(candidate.evidence) : '';
    const category = typeof candidate === 'object' && candidate?.category ? String(candidate.category).toLowerCase() : '';
    const body = [claim, evidence].filter(Boolean).join('\n');
    if (secretHits(body).length > 0) continue;
    docs.push({
      source: source.source,
      path: `${absPath}#${i}`,
      relPath: `${relPosix(source.root, absPath)}#${i}`,
      project: source.project || null,
      title: claim.slice(0, 120),
      kind: category === 'decision' ? 'decision' : 'lesson',
      trust: 'working',
      tags: ['ace', ...(category && /^[a-z][a-z0-9-]*$/.test(category) ? [category] : [])],
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      expiresAt: null,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      body: body.slice(0, MAX_BODY_CHARS),
      excerpt: body.replace(/\s+/g, ' ').slice(0, EXCERPT_LENGTH).trim(),
    });
  }
  return docs;
}

/**
 * Escape a free-text query into safe FTS5 MATCH syntax: every token becomes a
 * quoted phrase term (AND semantics), the final token gets prefix matching.
 */
function buildMatchExpression(query: string): string | null {
  const tokens = String(query || '')
    .slice(0, MAX_QUERY_CHARS)
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the knowledge index.
 *
 * @param opts.Database  better-sqlite3 constructor (injected).
 * @param opts.dbPath    absolute path for knowledge.db, or ':memory:'.
 */
function createKnowledgeIndex(opts: any) {
  const Database = opts?.Database;
  const dbPath = opts?.dbPath;
  if (typeof Database !== 'function') throw new Error('knowledge-index: Database constructor required');
  if (!dbPath || typeof dbPath !== 'string') throw new Error('knowledge-index: dbPath required');

  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_SQL);

  const upsertDoc = db.prepare(`
    INSERT INTO docs (source, path, rel_path, project, title, kind, trust, tags, updated_at, expires_at, mtime_ms, size_bytes, excerpt)
    VALUES (@source, @path, @relPath, @project, @title, @kind, @trust, @tags, @updatedAt, @expiresAt, @mtimeMs, @sizeBytes, @excerpt)
    ON CONFLICT(path) DO UPDATE SET
      source=excluded.source, rel_path=excluded.rel_path, project=excluded.project,
      title=excluded.title, kind=excluded.kind, trust=excluded.trust, tags=excluded.tags,
      updated_at=excluded.updated_at, expires_at=excluded.expires_at,
      mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, excerpt=excluded.excerpt
  `);
  const selectId = db.prepare('SELECT id FROM docs WHERE path = ?');
  const deleteFts = db.prepare('DELETE FROM docs_fts WHERE rowid = ?');
  const insertFts = db.prepare('INSERT INTO docs_fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)');
  const deleteDoc = db.prepare('DELETE FROM docs WHERE id = ?');
  const listBySource = db.prepare('SELECT id, path, mtime_ms, size_bytes FROM docs WHERE source = ?');

  function indexDoc(doc: any) {
    upsertDoc.run({
      ...doc,
      project: doc.project || null,
      tags: JSON.stringify(doc.tags || []),
      updatedAt: doc.updatedAt || null,
      expiresAt: doc.expiresAt || null,
    });
    const row = selectId.get(doc.path);
    if (!row) return;
    deleteFts.run(row.id);
    insertFts.run(row.id, doc.title || '', doc.body || '', (doc.tags || []).join(' '));
  }

  function removeDocByRow(row: any) {
    deleteFts.run(row.id);
    deleteDoc.run(row.id);
  }

  /**
   * Incrementally reindex the given sources.
   *
   * @param sources  Array of:
   *   { source: 'ops-wiki',     root, project: null }
   *   { source: 'project-wiki', root, project, defaultTrust?: 'canon' }
   *   { source: 'project-dump', root, project }
   * Unknown roots are skipped silently (fail-safe).
   * Docs whose files vanished are removed; unchanged (mtime,size) docs are
   * left untouched.
   */
  function reindex(input: any = {}) {
    const sources = Array.isArray(input.sources) ? input.sources : [];
    const stats = { scanned: 0, indexed: 0, removed: 0, skipped: 0, sources: sources.length };

    const bySourceName = new Map<string, any[]>();
    for (const sourceConfig of sources) {
      if (!sourceConfig || typeof sourceConfig.root !== 'string' || !sourceConfig.source) continue;
      if (!bySourceName.has(sourceConfig.source)) bySourceName.set(sourceConfig.source, []);
      bySourceName.get(sourceConfig.source)!.push(sourceConfig);
    }

    const run = db.transaction(() => {
      for (const [sourceName, configs] of bySourceName.entries()) {
        const known = new Map<string, any>();
        for (const row of listBySource.all(sourceName)) known.set(row.path, row);
        const seen = new Set<string>();

        for (const sourceConfig of configs) {
          const format = sourceConfig.format
            || (sourceName === 'project-dump' ? 'json'
              : sourceName === 'memory-candidate' ? 'completion'
                : 'md');

          if (format === 'custom' && typeof sourceConfig.collect === 'function') {
            // Pre-built docs (e.g. read-only Hermes memories). Incremental by
            // each doc's own (mtimeMs, sizeBytes).
            let docs: any[] = [];
            try { docs = sourceConfig.collect() || []; } catch { docs = []; }
            for (const doc of docs) {
              if (!doc || typeof doc.path !== 'string') continue;
              stats.scanned += 1;
              seen.add(doc.path);
              const existing = known.get(doc.path);
              if (existing && existing.mtime_ms === doc.mtimeMs && existing.size_bytes === doc.sizeBytes) continue;
              indexDoc(doc);
              stats.indexed += 1;
            }
          } else if (format === 'completion') {
            // One file → many candidate docs keyed `<file>#<index>`.
            const files = collectFiles(sourceConfig.root, '.json')
              .filter((absPath) => path.basename(absPath) === 'completion.json');
            for (const absPath of files) {
              stats.scanned += 1;
              const stat = statSafe(absPath);
              if (!stat) { stats.skipped += 1; continue; }
              const firstKnown = known.get(`${absPath}#0`);
              const unchanged = firstKnown && firstKnown.mtime_ms === stat.mtimeMs && firstKnown.size_bytes === stat.size;
              const docs = unchanged ? [] : docsFromCompletionFile(sourceConfig, absPath);
              if (unchanged) {
                for (const knownPath of known.keys()) {
                  if (knownPath.startsWith(`${absPath}#`)) seen.add(knownPath);
                }
                continue;
              }
              for (const doc of docs) {
                seen.add(doc.path);
                indexDoc(doc);
                stats.indexed += 1;
              }
            }
          } else {
            const isDump = format === 'json';
            const files = collectFiles(sourceConfig.root, isDump ? '.json' : '.md');
            for (const absPath of files) {
              stats.scanned += 1;
              seen.add(absPath);
              const existing = known.get(absPath);
              const stat = statSafe(absPath);
              if (!stat) { stats.skipped += 1; continue; }
              if (existing && existing.mtime_ms === stat.mtimeMs && existing.size_bytes === stat.size) continue;
              const doc = isDump ? docFromDumpRecord(sourceConfig, absPath) : docFromMarkdown(sourceConfig, absPath);
              if (!doc) { stats.skipped += 1; continue; }
              indexDoc(doc);
              stats.indexed += 1;
            }
          }
        }

        for (const [knownPath, row] of known.entries()) {
          if (seen.has(knownPath)) continue;
          removeDocByRow(row);
          stats.removed += 1;
        }
      }
    });
    run();
    return stats;
  }

  /**
   * Search the index. Ranking: bm25(title×4, body×1, tags×2) × trustW ×
   * freshW × decay, computed in JS over a bounded candidate pool.
   */
  function search(params: any = {}) {
    const match = buildMatchExpression(params.query);
    const limit = Math.max(1, Math.min(Number(params.limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const now = Number(params.now) || Date.now();
    const includeDecayed = params.includeDecayed === true;

    if (!match) {
      return { schema: KNOWLEDGE_SCHEMAS.searchResult, query: String(params.query || ''), total: 0, results: [] };
    }

    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT d.*, -bm25(docs_fts, 4.0, 1.0, 2.0) AS raw_score
        FROM docs_fts
        JOIN docs d ON d.id = docs_fts.rowid
        WHERE docs_fts MATCH ?
        ORDER BY raw_score DESC
        LIMIT ?
      `).all(match, CANDIDATE_POOL);
    } catch {
      rows = [];
    }

    // Contentless FTS5 yields tiny bm25 magnitudes; normalize against the
    // pool's best match so weighted scores land in a stable (0, 1] range.
    const maxRaw = rows.reduce((best, row) => Math.max(best, Number(row.raw_score) || 0), 0);

    const wantedTier = params.tier && TRUST_TIERS.includes(String(params.tier)) ? String(params.tier) : null;
    const wantedKind = params.kind ? String(params.kind) : null;
    const wantedProject = params.project ? String(params.project) : null;
    const wantedTags = Array.isArray(params.tags)
      ? params.tags.map((t: any) => String(t).toLowerCase()).filter(Boolean)
      : [];

    const results: any[] = [];
    for (const row of rows) {
      if (wantedTier && row.trust !== wantedTier) continue;
      if (wantedKind && row.kind !== wantedKind) continue;
      if (wantedProject && row.project !== wantedProject) continue;
      let tags: string[] = [];
      try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
      if (wantedTags.length > 0 && !wantedTags.every((tag: string) => tags.includes(tag))) continue;

      let decay = clampDecay(row.decay);
      let decayReasons: string[] = [];
      try { decayReasons = JSON.parse(row.decay_reasons || '[]'); } catch { decayReasons = []; }
      // expiresAt past due → decay floor (temporal facts fade out by default)
      if (row.expires_at && Date.parse(row.expires_at) < now && decay > DECAY_MIN * 2) {
        decay = DECAY_MIN * 2;
        if (!decayReasons.includes('expired-fact')) decayReasons = [...decayReasons, 'expired-fact'];
      }
      // Raw tier ages out on a half-life so stale dump intake sinks in ranking.
      // Floored at DECAY_RESULT_FLOOR so time alone demotes but never excludes.
      if (row.trust === 'raw') {
        const ageMs = now - (row.updated_at ? Date.parse(row.updated_at) : Number(row.mtime_ms));
        if (Number.isFinite(ageMs) && ageMs > 0) {
          const timeDecay = Math.max(DECAY_RESULT_FLOOR, Math.pow(0.5, ageMs / RAW_DECAY_HALF_LIFE_MS));
          if (timeDecay < decay) {
            decay = timeDecay;
            if (!decayReasons.includes('stale-raw')) decayReasons = [...decayReasons, 'stale-raw'];
          }
        }
      }
      if (!includeDecayed && decay < DECAY_RESULT_FLOOR) continue;

      const trustWeight = TRUST_WEIGHTS[row.trust] ?? TRUST_WEIGHTS.working;
      const freshness = computeFreshness(
        row.updated_at ? Date.parse(row.updated_at) : row.mtime_ms,
        now,
      );
      const freshWeight = FRESHNESS_WEIGHTS[freshness] ?? FRESHNESS_WEIGHTS.unknown;
      const rawScore = maxRaw > 0 ? Math.max(0, Number(row.raw_score) || 0) / maxRaw : 0;
      const score = rawScore * trustWeight * freshWeight * decay;

      results.push({
        path: row.path,
        relPath: row.rel_path,
        source: row.source,
        project: row.project,
        title: row.title,
        kind: row.kind,
        trust: row.trust,
        tags,
        updatedAt: row.updated_at,
        freshness,
        decay,
        decayReasons,
        excerpt: row.excerpt,
        score: Math.round(score * 10000) / 10000,
      });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    return {
      schema: KNOWLEDGE_SCHEMAS.searchResult,
      query: String(params.query || '').slice(0, MAX_QUERY_CHARS),
      total: results.length,
      results: top,
    };
  }

  /** Stats for health surfaces. */
  function describe() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    const byTrust = db.prepare('SELECT trust, COUNT(*) AS n FROM docs GROUP BY trust').all();
    const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM docs GROUP BY source').all();
    return { dbPath, total, byTrust, bySource };
  }

  /**
   * Organized overview for the Knowledge tab: who writes memory (per dump
   * identity), Hermes memories per workspace, candidates per project, recent
   * run digests + journal days. Everything derives from the index — no extra
   * filesystem walks.
   */
  function overview() {
    const agents = db.prepare(`
      SELECT
        CASE WHEN instr(rel_path, '/') > 0 THEN substr(rel_path, 1, instr(rel_path, '/') - 1) ELSE 'unknown' END AS identity,
        project,
        COUNT(*) AS docs,
        MAX(updated_at) AS lastAt
      FROM docs WHERE source = 'project-dump'
      GROUP BY identity, project
      ORDER BY lastAt DESC
    `).all();
    const hermes = db.prepare(`
      SELECT COALESCE(project, 'shared') AS workspace, COUNT(*) AS docs, MAX(updated_at) AS lastAt
      FROM docs WHERE source = 'hermes-memory'
      GROUP BY COALESCE(project, 'shared')
      ORDER BY lastAt DESC
    `).all();
    const candidates = db.prepare(`
      SELECT COALESCE(project, 'unknown') AS project, COUNT(*) AS docs, MAX(updated_at) AS lastAt
      FROM docs WHERE source = 'memory-candidate'
      GROUP BY COALESCE(project, 'unknown')
      ORDER BY lastAt DESC
    `).all();
    const byProject = db.prepare(`
      SELECT COALESCE(project, 'ops') AS project, COUNT(*) AS docs, MAX(updated_at) AS lastAt
      FROM docs
      GROUP BY COALESCE(project, 'ops')
      ORDER BY docs DESC
      LIMIT 12
    `).all();
    const recentRuns = db.prepare(`
      SELECT title, path, rel_path AS relPath, project, updated_at AS updatedAt
      FROM docs WHERE kind = 'run-digest'
      ORDER BY updated_at DESC LIMIT 6
    `).all();
    const recentJournal = db.prepare(`
      SELECT title, path, rel_path AS relPath, updated_at AS updatedAt
      FROM docs WHERE kind = 'journal'
      ORDER BY updated_at DESC LIMIT 3
    `).all();
    return { ...describe(), agents, hermes, candidates, byProject, recentRuns, recentJournal };
  }

  /** Set decay for a doc (nightly auditor surface). */
  function setDecay(docPath: string, decay: number, reasons: string[] = []) {
    db.prepare('UPDATE docs SET decay = ?, decay_reasons = ? WHERE path = ?')
      .run(clampDecay(decay), JSON.stringify(reasons || []), String(docPath || ''));
  }

  /**
   * Decay recovery: every doc NOT in `flaggedPaths` returns to 1.0. Decay is
   * recomputed from current findings each night — never ratcheted.
   */
  function resetDecayExcept(flaggedPaths: string[] = []) {
    const flagged = new Set(Array.isArray(flaggedPaths) ? flaggedPaths : []);
    const decayedRows = db.prepare('SELECT path FROM docs WHERE decay < 1.0').all();
    const restore = db.prepare("UPDATE docs SET decay = 1.0, decay_reasons = '[]' WHERE path = ?");
    for (const row of decayedRows) {
      if (!flagged.has(row.path)) restore.run(row.path);
    }
  }

  function close() {
    try { db.close(); } catch { /* already closed */ }
  }

  return { dbPath, reindex, search, describe, overview, setDecay, resetDecayExcept, indexDoc, close };
}

/**
 * Containment guard for path-based reads: resolved realpath must live under
 * one of the registered knowledge roots. Returns the real path or null.
 */
function containedRealPath(candidate: any, roots: any[]): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let realFile: string;
  try {
    realFile = fs.realpathSync(path.resolve(candidate));
  } catch {
    return null;
  }
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root.trim()) continue;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    if (realFile === realRoot || realFile.startsWith(realRoot + path.sep)) return realFile;
  }
  return null;
}

// Canon-first explain is single-sourced in the knowledge contract (pure, ships
// with the CLI too); re-exported here for retrieval-side callers.
const { explainFromResults } = require('./harness/knowledge-contract.cts');

module.exports = {
  createKnowledgeIndex,
  containedRealPath,
  buildMatchExpression,
  docFromMarkdown,
  docFromDumpRecord,
  docsFromCompletionFile,
  explainFromResults,
};
