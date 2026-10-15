/**
 * birdclaw-source.cts
 *
 * READ-ONLY adapter over a local birdclaw (steipete/birdclaw) SQLite database —
 * the social/X lane's preferred provider when the owner has birdclaw set up.
 *
 * birdclaw is a local Twitter/X memory workspace (archive import + live sync of
 * tweets/bookmarks/likes/…) into ONE SQLite file with FTS5. It is v0.x with
 * documented schema churn, so this adapter is defensive to a fault:
 *   - opens the DB READ-ONLY ({ readonly: true, fileMustExist: true }) — never
 *     writes, never triggers a sync, never spawns the CLI;
 *   - feature-detects tables AND columns before every query;
 *   - degrades to a lane status ('auth-needed' | 'broken') on ANY problem and
 *     NEVER throws — a failing birdclaw can never wedge an ops refresh.
 *
 * The better-sqlite3 constructor is INJECTED (default: lazy require) — exactly
 * like knowledge-index.cts — so the native addon is only loaded when a birdclaw
 * DB is actually opened. Tests inject a node:sqlite adapter (better-sqlite3 is
 * built for Electron's ABI and can't load under the test runner's node).
 *
 * NO electron imports — Node built-ins only. No hardcoded paths, handles, or
 * account ids; the dbPath comes from ~/.ace/ops-config.json (owner's local
 * settings) or is passed in.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Setup hint shown when birdclaw is configured but the DB is absent/unreadable
// — mirrors the X research-agent auth-needed placeholder. No personal handles.
const BIRDCLAW_SETUP_HINT =
  'Install birdclaw (brew install steipete/tap/birdclaw), import your X archive ' +
  'or run a sync, then point ops-config.json birdclaw.dbPath at the SQLite file.';

// Cap per refresh (spec): never pull more than this many rows into the lane.
const DEFAULT_LIMIT = 50;

/** Read+parse a JSON file. Missing/corrupt -> null. Never throws. */
function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Default ops-config path (owner's local settings). */
function defaultConfigPath(): string {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json');
}

/**
 * Resolve the birdclaw DB path: an explicit opts.dbPath wins; otherwise read
 * `birdclaw.dbPath` from ops-config.json (opts.configPath overrides the default
 * path). Returns null when nothing is configured — the caller then falls back
 * to the research-agent social path (current behavior). Never throws.
 */
function resolveBirdclawDbPath(opts?: { dbPath?: any; configPath?: any }): string | null {
  const explicit = opts && typeof opts.dbPath === 'string' && opts.dbPath.trim();
  if (explicit) return opts!.dbPath.trim();
  const configPath =
    opts && typeof opts.configPath === 'string' && opts.configPath
      ? opts.configPath
      : defaultConfigPath();
  const cfg = readJsonFile(configPath);
  const p = cfg?.birdclaw?.dbPath;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/** Lazy default constructor — only touches the native addon when opening. */
function defaultDatabaseCtor(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('better-sqlite3');
}

// Candidate column names per logical field (birdclaw schema churn tolerance).
// First present column wins.
const TEXT_COLS = ['full_text', 'text', 'content', 'body', 'tweet_text'];
const CREATED_COLS = ['created_at', 'created', 'timestamp', 'ts', 'date', 'time'];
const HANDLE_COLS = [
  'screen_name',
  'username',
  'handle',
  'author',
  'author_handle',
  'user_screen_name',
  'user',
];
const URL_COLS = ['url', 'tweet_url', 'permalink', 'link'];
const ID_COLS = ['id', 'tweet_id', 'id_str', 'rest_id', 'rowid'];

/** First candidate present in the detected column set, or null. */
function pick(candidates: string[], present: Set<string>): string | null {
  for (const c of candidates) if (present.has(c)) return c;
  return null;
}

/** Normalize a birdclaw-ish timestamp to ISO, or null (never fabricated). */
function toIso(value: any): string | null {
  if (value == null || value === '') return null;
  // Numeric epoch (seconds or ms) or a date string.
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    let n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 1e12) n *= 1000; // seconds -> ms
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ~140-char single-line title from tweet body. */
function titleFromText(text: string): string {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 140) return oneLine;
  return oneLine.slice(0, 139).trimEnd() + '…';
}

/**
 * Fetch recent social items from a birdclaw SQLite DB, mapped onto the shared
 * intel social-lane item shape ({ id, title, summary, url, timestamp, handle }).
 *
 * Returns a discriminated result — the caller reads `.configured` to decide
 * whether birdclaw owns the social lane:
 *   { configured: false }                              -> not set up; use research agent
 *   { configured: true, status: 'auth-needed', hint }  -> configured but DB absent/unreadable
 *   { configured: true, status: 'broken', error }      -> DB present but schema/query failed
 *   { configured: true, status: 'ok', items }          -> pulled rows (capped)
 *
 * NEVER throws. NEVER writes. NEVER triggers a sync or spawns a CLI.
 */
function fetchBirdclawSocial(opts?: {
  dbPath?: any;
  configPath?: any;
  Database?: any;
  limit?: any;
}): {
  configured: boolean;
  status: 'ok' | 'auth-needed' | 'broken';
  items: any[];
  error: string | null;
  hint: string | null;
  dbPath: string | null;
} {
  const base = {
    configured: false as boolean,
    status: 'auth-needed' as 'ok' | 'auth-needed' | 'broken',
    items: [] as any[],
    error: null as string | null,
    hint: null as string | null,
    dbPath: null as string | null,
  };
  let db: any = null;
  try {
    const dbPath = resolveBirdclawDbPath(opts);
    if (!dbPath) return base; // not configured -> research-agent path

    base.configured = true;
    base.dbPath = dbPath;

    if (!fs.existsSync(dbPath)) {
      return { ...base, status: 'auth-needed', hint: BIRDCLAW_SETUP_HINT };
    }

    const Database = opts && typeof opts.Database === 'function' ? opts.Database : defaultDatabaseCtor();
    const limit = Number.isInteger(opts?.limit) && (opts as any).limit > 0
      ? Math.min((opts as any).limit, DEFAULT_LIMIT)
      : DEFAULT_LIMIT;

    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err: any) {
      // Cannot open (missing/permission/locked-exclusive) -> treat as setup.
      return { ...base, status: 'auth-needed', error: err?.message ?? String(err), hint: BIRDCLAW_SETUP_HINT };
    }

    // Feature-detect the tweets table (the union of ingested content). birdclaw
    // stores timeline/likes/bookmarks in `tweets`; without it there is nothing
    // to read -> broken (schema drift / not a birdclaw DB).
    const tables = new Set<string>();
    try {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        if (row && typeof row.name === 'string') tables.add(row.name);
      }
    } catch (err: any) {
      return { ...base, status: 'broken', error: `schema read failed: ${err?.message ?? String(err)}` };
    }
    if (!tables.has('tweets')) {
      return { ...base, status: 'broken', error: 'birdclaw schema: no `tweets` table (unexpected schema version)' };
    }

    // Feature-detect columns on `tweets`.
    const cols = new Set<string>();
    try {
      for (const row of db.prepare('PRAGMA table_info(tweets)').all()) {
        if (row && typeof row.name === 'string') cols.add(row.name);
      }
    } catch (err: any) {
      return { ...base, status: 'broken', error: `column read failed: ${err?.message ?? String(err)}` };
    }

    const textCol = pick(TEXT_COLS, cols);
    if (!textCol) {
      return { ...base, status: 'broken', error: 'birdclaw schema: no recognizable tweet text column' };
    }
    const createdCol = pick(CREATED_COLS, cols);
    const handleCol = pick(HANDLE_COLS, cols);
    const urlCol = pick(URL_COLS, cols);
    const idCol = pick(ID_COLS, cols);

    // Build a SELECT from ONLY detected columns; alias to stable output names.
    // rowid is always available for a stable ordering fallback.
    const parts: string[] = [`"${textCol}" AS text`];
    parts.push(createdCol ? `"${createdCol}" AS created` : 'NULL AS created');
    parts.push(handleCol ? `"${handleCol}" AS handle` : 'NULL AS handle');
    parts.push(urlCol ? `"${urlCol}" AS url` : 'NULL AS url');
    parts.push(idCol && idCol !== 'rowid' ? `"${idCol}" AS ext_id` : 'NULL AS ext_id');
    const orderBy = createdCol ? `"${createdCol}" DESC` : 'rowid DESC';
    const sql = `SELECT ${parts.join(', ')}, rowid AS rid FROM tweets ORDER BY ${orderBy} LIMIT ${limit}`;

    let rows: any[] = [];
    try {
      rows = db.prepare(sql).all();
    } catch (err: any) {
      return { ...base, status: 'broken', error: `query failed: ${err?.message ?? String(err)}` };
    }

    const items: any[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const text = String(row?.text ?? '').trim();
      if (!text) continue; // skip empty/media-only rows
      const handleRaw = row?.handle != null ? String(row.handle).trim() : '';
      const handle = handleRaw ? (handleRaw.startsWith('@') ? handleRaw : `@${handleRaw}`) : null;
      const extId = row?.ext_id != null ? String(row.ext_id) : String(row?.rid ?? items.length);
      items.push({
        id: `birdclaw:${extId}`,
        title: titleFromText(text),
        summary: text,
        url: row?.url ? String(row.url) : null,
        timestamp: toIso(row?.created),
        handle,
      });
    }

    return { ...base, status: 'ok', items };
  } catch (err: any) {
    // Absolute backstop: any unexpected error degrades, never throws.
    return { ...base, status: 'broken', error: err?.message ?? String(err) };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // close is best-effort
      }
    }
  }
}

module.exports = {
  BIRDCLAW_SETUP_HINT,
  resolveBirdclawDbPath,
  fetchBirdclawSocial,
};
