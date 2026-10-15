// Ace telemetry/event spine (L0 of Operations & Observability) —
// append-only operational event log UNDER the existing real probes
// (ops-status / missions).
//
// One module owns the whole spine: the typed tagged event schema, the lean
// store (one sqlite table on the active data root + rotating day-keyed
// ndjson), the additive emit() helper, opportunistic retention/rotation
// (~90 days, NO new daemon — sweeps piggyback on emit), and the read-only
// query/aggregate surface the IPC handler calls. Aggregates are derived on
// read; nothing is precomputed or cached.
//
// Hard rule: secrets, tokens, and credential URLs must never persist.
// Every string field and every meta value passes redactSecrets() before it
// touches sqlite or ndjson, and meta keys that look credential-shaped are
// dropped wholesale. Over-redaction is the safe direction.
//
// Everything is factory-injected (sqlite opener, fs, clock), so tests run
// against node:sqlite with temp dirs. emit()
// must never throw into a caller — every failure degrades to a dropped
// event and a remembered lastError.

const fs = require('fs');
const path = require('path');

const TELEMETRY_SCHEMA = 'ace.telemetry.v1';
const TELEMETRY_DIRNAME = 'telemetry';
const TELEMETRY_DB_FILE = 'telemetry.db';
const RETENTION_DAYS = 90;
// Opportunistic sweep cadence: at most one retention pass per interval,
// triggered from emit() — never a timer.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const MAX_TAG_LEN = 200;
const MAX_TYPE_LEN = 64;
const MAX_META_KEYS = 20;
const MAX_META_KEY_LEN = 100;
const MAX_META_VALUE_LEN = 500;
const MAX_META_JSON_LEN = 2048;
const QUERY_DEFAULT_LIMIT = 200;
const QUERY_MAX_LIMIT = 1000;
// Allowlisted aggregate dimensions -> column names (never interpolate caller
// input into SQL).
const AGGREGATE_COLUMNS: any = {
  type: 'type',
  project: 'project',
  agent: 'agent',
  lane: 'lane',
  mission: 'mission',
  stream: 'stream',
  source: 'source',
  severity: 'severity',
  errorClass: 'error_class',
};

// ── Secret redaction ─────────────────────────────────────────────────────────

const REDACTED = '[redacted]';
// Literal token shapes first, then structured carriers (auth headers, URL
// userinfo, credential query params, KEY=value assignments).
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // ALL URL userinfo forms: //user:pass@, //token@ — the whole userinfo is
  // credential-equivalent, so it is redacted wholesale.
  [/(\/\/)[^/\s@]+(@)/g, `$1${REDACTED}$2`],
  [
    /([?&#][^=&\s#]*(?:token|secret|key|password|passwd|pwd|auth|credential|signature)[^=&\s#]*=)[^&\s#]+/gi,
    `$1${REDACTED}`,
  ],
  // Case-insensitive: catches password=, aws_secret_access_key=, --password=
  // CLI flags as well as the classic UPPER_SNAKE env assignments. Compound
  // names tolerate dash, underscore, or neither (--api-key=, APIKEY=).
  [
    /\b([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?)[A-Z0-9_-]*)=\S+/gi,
    `$1=${REDACTED}`,
  ],
];
// Meta keys that are credential-shaped lose their value entirely.
const SECRET_KEY_RE =
  /token|secret|passwd|password|credential|api[-_]?key|access[-_]?key|authorization|cookie|bearer|private[-_]?key/i;

function redactSecrets(value: any) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// ── Event normalization (the typed tagged schema) ────────────────────────────

function clampString(value: any, maxLen: number) {
  const text = redactSecrets(value).trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function finiteOrNull(value: any) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Bounded, redacted meta: scalars only (max depth 2), credential-shaped keys
// dropped, each string redacted+clamped, whole object capped at MAX_META_KEYS
// keys / MAX_META_JSON_LEN serialized bytes.
function boundMeta(meta: any, depth = 0): any {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out: any = {};
  let keys = 0;
  for (const [rawKey, value] of Object.entries(meta)) {
    if (keys >= MAX_META_KEYS) break;
    // Key NAMES persist too: redact + clamp them like any other string so a
    // secret embedded in a key (URL-with-token, accidental key/value swap)
    // never outlives its redacted value.
    const key = clampString(rawKey, MAX_META_KEY_LEN);
    if (!key) continue;
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      keys += 1;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = clampString(value, MAX_META_VALUE_LEN) ?? '';
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 1) {
      const nested = boundMeta(value, depth + 1);
      if (nested && Object.keys(nested).length > 0) out[key] = nested;
      else continue;
    } else {
      continue; // arrays, functions, deep objects: dropped, never serialized
    }
    keys += 1;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function serializeMeta(meta: any) {
  const bounded = boundMeta(meta);
  if (!bounded) return null;
  const json = JSON.stringify(bounded);
  return json.length > MAX_META_JSON_LEN ? JSON.stringify({ truncated: true }) : json;
}

// Input -> normalized event row, or null when the event is malformed
// (missing/empty type). Tags: ts,type,project,agent,lane,mission,stream,
// source,severity,durationMs,tokensIn,tokensOut,ok,errorClass,meta.
function normalizeEvent(input: any, nowMs: number) {
  const type = clampString(input?.type, MAX_TYPE_LEN);
  if (!type) return null;
  const ts = Number.isFinite(Number(input?.ts)) && Number(input?.ts) > 0 ? Math.round(Number(input.ts)) : nowMs;
  const severityRaw = String(input?.severity ?? '').trim().toLowerCase();
  return {
    ts,
    type,
    project: clampString(input?.project, MAX_TAG_LEN),
    agent: clampString(input?.agent, MAX_TAG_LEN),
    lane: clampString(input?.lane, MAX_TAG_LEN),
    mission: clampString(input?.mission, MAX_TAG_LEN),
    stream: clampString(input?.stream, MAX_TAG_LEN),
    source: clampString(input?.source, MAX_TAG_LEN),
    severity: SEVERITIES.includes(severityRaw) ? severityRaw : 'info',
    durationMs: finiteOrNull(input?.durationMs),
    tokensIn: finiteOrNull(input?.tokensIn),
    tokensOut: finiteOrNull(input?.tokensOut),
    ok: typeof input?.ok === 'boolean' ? input.ok : null,
    errorClass: clampString(input?.errorClass, MAX_TAG_LEN),
    meta: serializeMeta(input?.meta),
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

// Write-mode sqlite opener (lazy native require so the module never loads
// better-sqlite3 at import time; tests inject node:sqlite instead).
function defaultDbOpener(dbPath: string) {
  const Database = require('better-sqlite3');
  return new Database(dbPath);
}

const EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  project TEXT,
  agent TEXT,
  lane TEXT,
  mission TEXT,
  stream TEXT,
  source TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  ok INTEGER,
  error_class TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_ts ON telemetry_events(ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type_ts ON telemetry_events(type, ts);
`;

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function ndjsonFileName(ms: number) {
  return `events-${dayKey(ms)}.ndjson`;
}

function rowToEvent(row: any) {
  let meta = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta);
    } catch {
      meta = null;
    }
  }
  return {
    ts: row.ts,
    type: row.type,
    project: row.project ?? null,
    agent: row.agent ?? null,
    lane: row.lane ?? null,
    mission: row.mission ?? null,
    stream: row.stream ?? null,
    source: row.source ?? null,
    severity: row.severity,
    durationMs: row.duration_ms ?? null,
    tokensIn: row.tokens_in ?? null,
    tokensOut: row.tokens_out ?? null,
    ok: row.ok == null ? null : row.ok === 1,
    errorClass: row.error_class ?? null,
    meta,
  };
}

// The store: lazy-opened sqlite + day-keyed ndjson under <dir>/. Both sinks
// degrade independently; nothing here ever throws into a caller.
function createTelemetryStore(options: any = {}) {
  const {
    dir,
    openDb = defaultDbOpener,
    fsImpl = fs,
    now = () => Date.now(),
    retentionDays = RETENTION_DAYS,
  } = options;
  if (!dir || typeof dir !== 'string') {
    throw new Error('telemetry store requires a dir');
  }

  let db: any = null;
  let dbError: string | null = null;
  let lastSweepMs = 0;
  let written = 0;
  let dropped = 0;

  function ensureDb() {
    if (db || dbError) return db;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      db = openDb(path.join(dir, TELEMETRY_DB_FILE));
      // WAL keeps emit() cheap; ignore openers that reject pragmas.
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        /* best effort */
      }
      db.exec(EVENTS_TABLE_SQL);
    } catch (err: any) {
      db = null;
      dbError = err?.message || 'telemetry db unavailable';
    }
    return db;
  }

  function appendNdjson(event: any) {
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.appendFileSync(
        path.join(dir, ndjsonFileName(event.ts)),
        JSON.stringify(event) + '\n'
      );
      return true;
    } catch {
      return false;
    }
  }

  // Retention: delete sqlite rows and unlink ndjson day files older than the
  // window. Runs at most once per SWEEP_INTERVAL_MS, piggybacked on emit().
  function sweepRetention(force = false) {
    const nowMs = now();
    if (!force && nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return false;
    lastSweepMs = nowMs;
    const cutoffMs = nowMs - retentionDays * 86_400_000;
    const handle = ensureDb();
    if (handle) {
      try {
        handle.prepare('DELETE FROM telemetry_events WHERE ts < ?').run(cutoffMs);
      } catch {
        /* best effort */
      }
    }
    const cutoffDay = dayKey(cutoffMs);
    try {
      for (const name of fsImpl.readdirSync(dir)) {
        const match = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
        if (match && match[1] < cutoffDay) {
          try {
            fsImpl.unlinkSync(path.join(dir, name));
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      /* dir unreadable: nothing to rotate */
    }
    return true;
  }

  // Additive fire-and-forget append. Returns true when at least one sink
  // accepted the event; never throws.
  function emit(input: any) {
    try {
      const event = normalizeEvent(input, now());
      if (!event) {
        dropped += 1;
        return false;
      }
      let stored = false;
      const handle = ensureDb();
      if (handle) {
        try {
          handle
            .prepare(
              `INSERT INTO telemetry_events
                 (ts, type, project, agent, lane, mission, stream, source, severity,
                  duration_ms, tokens_in, tokens_out, ok, error_class, meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              event.ts,
              event.type,
              event.project,
              event.agent,
              event.lane,
              event.mission,
              event.stream,
              event.source,
              event.severity,
              event.durationMs,
              event.tokensIn,
              event.tokensOut,
              event.ok == null ? null : event.ok ? 1 : 0,
              event.errorClass,
              event.meta
            );
          stored = true;
        } catch (err: any) {
          dbError = err?.message || 'telemetry insert failed';
        }
      }
      const ndjsonEvent = { ...event, meta: event.meta ? JSON.parse(event.meta) : null };
      if (appendNdjson(ndjsonEvent)) stored = true;
      if (stored) written += 1;
      else dropped += 1;
      sweepRetention();
      return stored;
    } catch {
      dropped += 1;
      return false;
    }
  }

  function buildWhere(filters: any) {
    const clauses: string[] = [];
    const params: any[] = [];
    const nowMs = now();
    const sinceMs = Number.isFinite(Number(filters?.sinceMs))
      ? Number(filters.sinceMs)
      : nowMs - 24 * 60 * 60 * 1000;
    clauses.push('ts >= ?');
    params.push(sinceMs);
    if (Number.isFinite(Number(filters?.untilMs))) {
      clauses.push('ts <= ?');
      params.push(Number(filters.untilMs));
    }
    for (const key of ['type', 'project', 'agent', 'lane', 'mission', 'stream', 'source', 'severity', 'errorClass']) {
      const value = typeof filters?.[key] === 'string' ? filters[key].trim() : '';
      if (value) {
        clauses.push(`${AGGREGATE_COLUMNS[key] || key} = ?`);
        params.push(value);
      }
    }
    if (typeof filters?.ok === 'boolean') {
      clauses.push('ok = ?');
      params.push(filters.ok ? 1 : 0);
    }
    return { where: clauses.join(' AND '), params };
  }

  // Read-only event query: filters + limit, newest first.
  function query(filters: any = {}) {
    const base = { schema: TELEMETRY_SCHEMA, ok: false, total: 0, events: [] as any[], error: null as string | null };
    const handle = ensureDb();
    if (!handle) return { ...base, error: dbError || 'telemetry db unavailable' };
    try {
      const { where, params } = buildWhere(filters);
      const limitRaw = Number(filters?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), QUERY_MAX_LIMIT) : QUERY_DEFAULT_LIMIT;
      const total = handle
        .prepare(`SELECT COUNT(*) AS n FROM telemetry_events WHERE ${where}`)
        .get(...params).n;
      const rows = handle
        .prepare(
          `SELECT * FROM telemetry_events WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ?`
        )
        .all(...params, limit);
      return { ...base, ok: true, total: Number(total) || 0, events: rows.map(rowToEvent) };
    } catch (err: any) {
      return { ...base, error: err?.message || 'telemetry query failed' };
    }
  }

  // Derived-on-read aggregate over an allowlisted dimension.
  function aggregate(filters: any = {}) {
    const base = { schema: TELEMETRY_SCHEMA, ok: false, groupBy: null as string | null, rows: [] as any[], error: null as string | null };
    const column = AGGREGATE_COLUMNS[String(filters?.groupBy || 'type')];
    if (!column) return { ...base, error: `unknown groupBy: ${filters?.groupBy}` };
    const handle = ensureDb();
    if (!handle) return { ...base, error: dbError || 'telemetry db unavailable' };
    try {
      const { where, params } = buildWhere(filters);
      const rows = handle
        .prepare(
          `SELECT COALESCE(${column}, '') AS key,
                  COUNT(*) AS count,
                  SUM(CASE WHEN ok = 0 OR severity = 'error' THEN 1 ELSE 0 END) AS errors,
                  AVG(duration_ms) AS avgDurationMs,
                  COALESCE(SUM(tokens_in), 0) AS tokensIn,
                  COALESCE(SUM(tokens_out), 0) AS tokensOut
           FROM telemetry_events WHERE ${where}
           GROUP BY key ORDER BY count DESC`
        )
        .all(...params);
      return {
        ...base,
        ok: true,
        groupBy: String(filters?.groupBy || 'type'),
        rows: rows.map((row: any) => ({
          key: row.key,
          count: Number(row.count) || 0,
          errors: Number(row.errors) || 0,
          avgDurationMs: row.avgDurationMs == null ? null : Math.round(Number(row.avgDurationMs)),
          tokensIn: Number(row.tokensIn) || 0,
          tokensOut: Number(row.tokensOut) || 0,
        })),
      };
    } catch (err: any) {
      return { ...base, error: err?.message || 'telemetry aggregate failed' };
    }
  }

  function status() {
    return { schema: TELEMETRY_SCHEMA, dir, written, dropped, dbError };
  }

  function close() {
    try {
      db?.close?.();
    } catch {
      /* best effort */
    }
    db = null;
  }

  return { emit, query, aggregate, sweepRetention, status, close };
}

// ── Module singleton (the additive emit() wiring surface) ────────────────────
//
// initTelemetry() is called once from createAceStore with the active data
// root (userDataPath). Until then — and in CLI/test contexts that never init —
// telemetryEmit() is a silent no-op, so requiring this module from anywhere
// can never change existing behavior.

let activeStore: any = null;

function initTelemetry(options: any = {}) {
  try {
    const baseDir = options.dir || (options.userDataPath ? path.join(options.userDataPath, TELEMETRY_DIRNAME) : null);
    if (!baseDir) {
      // No data root: drop any previous store so emit() is a no-op again.
      activeStore = null;
      return null;
    }
    activeStore = createTelemetryStore({ ...options, dir: baseDir });
    activeStore.sweepRetention(true);
  } catch {
    activeStore = null;
  }
  return activeStore;
}

function telemetryEmit(event: any) {
  try {
    return activeStore ? activeStore.emit(event) : false;
  } catch {
    return false;
  }
}

function telemetryQuery(payload: any = {}) {
  const empty = {
    schema: TELEMETRY_SCHEMA,
    ok: false,
    total: 0,
    events: [],
    rows: [],
    error: 'telemetry not initialized',
  };
  try {
    if (!activeStore) return empty;
    if (payload?.kind === 'aggregate') return activeStore.aggregate(payload);
    return activeStore.query(payload);
  } catch (err: any) {
    return { ...empty, error: err?.message || 'telemetry query failed' };
  }
}

function getTelemetryStore() {
  return activeStore;
}

module.exports = {
  TELEMETRY_SCHEMA,
  RETENTION_DAYS,
  SEVERITIES,
  redactSecrets,
  boundMeta,
  normalizeEvent,
  createTelemetryStore,
  initTelemetry,
  telemetryEmit,
  telemetryQuery,
  getTelemetryStore,
};
