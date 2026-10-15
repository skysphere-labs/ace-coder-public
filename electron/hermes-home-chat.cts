// Canonical home-chat policy for the resident Hermes bubble.
//
// SHIPPED TODAY — home restore: the partition-hygiene clear (main.cts) wipes
// the SPA's remembered-session keys, so bubble reopen cold-boots blank. This
// module re-points the SPA at the canonical home chat by EXPLICIT session id
// (never a `--continue`/latest token; cron/worker/test/maintenance,
// other-profile, and archived sessions are never candidates).
//
// CAPABILITY-GATED — scheduled/completion → home delivery. The transport is
// `POST /api/sessions/<id>/messages`, shipped by the hermes-agent fork
// (example-user/hermes-agent#40): it appends durably and is idempotent on a
// `dedupe_key`. Against a sidecar that still serves the path GET-only the sweep
// gets 405, reports `{ unsupported: true }`, and releases its claims (fail
// closed, no write) — so the exactly-once machinery stays inert until the
// serving sidecar has the route, then activates automatically. Run rows from
// /runs are SESSION rows (preview = the PROMPT); final output is read from the
// run session's own transcript. Live child delegation stays native to the
// sidecar bubble (WS prompt.background); this module only delivers durably so a
// result that lands while the bubble is closed reappears on reopen.
//
// All I/O is factory-injected; this module never imports Electron.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// Session `source` classes that must never be the home-restore target and
// must never receive the cron home delivery. Mirrors the goal contract:
// cron, worker, test, and maintenance sessions are background lanes, not the
// operator's conversation.
const HOME_RESTORE_EXCLUDED_SOURCES = ['cron', 'worker', 'test', 'maintenance'];

const DEFAULT_SESSIONS_LIMIT = 50;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
// A claim younger than this is an in-flight delivery (skip); older is a
// crashed attempt (reconcile + retry). Bounded at-least-once across a crash
// exactly mid-delivery; exactly-once everywhere else.
const PENDING_CLAIM_RETRY_MS = 10 * 60_000;
// The runs endpoint is newest-first and takes only `limit` (no offset paging),
// so per job we request the most-recent window. It is wide enough to cover a
// realistic app-offline gap; a full window means older, historical runs exist
// beyond it (reported via `partial`) that scheduled delivery deliberately does
// not flood into the home chat.
const CRON_RUNS_WINDOW = 200;
// Marker reconciliation pages the whole home transcript (API clamp 500);
// hitting the page budget is UNKNOWN, never "not delivered".
const RECONCILE_PAGE_LIMIT = 500;
const RECONCILE_MAX_PAGES = 40;

function normalizeSource(value: any) {
  return String(value ?? '').trim().toLowerCase();
}

// Canonical logical-profile id. Lower-cased to match the sidecar, which keys
// sessions/pins/scope by the lower-cased profile id: the scraped rail label is a
// DISPLAY name ('Vector'), so both sides of the candidate filter, the pin key,
// and the ledger/serving scope must canonicalize identically or a mixed-case
// caller mis-keys (excludes its own rows, or binds the default profile). 'default'
// collapses to the sentinel — identity-home sidecars serve owned state as default.
function normalizeLogicalProfile(profile: any) {
  const value = String(profile ?? '').trim().toLowerCase();
  return value && value !== 'default' ? value : '';
}

/** The sessions query used to shortlist home-restore candidates: server-side
 *  source exclusion (the same `exclude_sources` the desktop's own recents
 *  list uses) + recent-first ordering. The local policy filter re-verifies
 *  every row — the query is an optimization, never the boundary. */
function homeRestoreSessionsApiPath(options: any = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : DEFAULT_SESSIONS_LIMIT;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('order', 'recent');
  params.set('exclude_sources', HOME_RESTORE_EXCLUDED_SOURCES.join(','));
  return `/api/sessions?${params.toString()}`;
}

/**
 * Whether a session row may be restored as (or delivered into) the operator's
 * home chat. Excludes:
 *  - rows without a non-empty string id,
 *  - excluded sources (cron/worker/test/maintenance; `kind` is checked the
 *    same way as `source` for forward compatibility),
 *  - archived rows,
 *  - other-profile rows: when the caller has a logical profile and the row is
 *    stamped with a DIFFERENT named profile it is another operator's session.
 *    A row stamped `default` belongs to the serving backend (identity-home
 *    sidecars serve the operator's own state.db as `default`), so it counts
 *    as owned.
 */
function isHomeRestoreCandidate(row: any, options: any = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return false;
  const source = normalizeSource(row.source);
  if (HOME_RESTORE_EXCLUDED_SOURCES.includes(source)) return false;
  const kind = normalizeSource(row.kind);
  if (HOME_RESTORE_EXCLUDED_SOURCES.includes(kind)) return false;
  if (row.archived === true || row.archived === 1) return false;
  const wanted = normalizeLogicalProfile(options.profile);
  const rowProfile = normalizeLogicalProfile(row.profile);
  if (wanted && rowProfile && rowProfile !== wanted) return false;
  return true;
}

function rowActivity(row: any) {
  const last = Number(row?.last_active);
  if (Number.isFinite(last)) return last;
  const started = Number(row?.started_at);
  if (Number.isFinite(started)) return started;
  return 0;
}

function rowHasHistory(row: any) {
  const count = Number(row?.message_count ?? row?.messages);
  // Rows without a message-count field fail open: history unknown ≠ blank.
  if (!Number.isFinite(count)) return true;
  return count > 0;
}

// Accumulated conversation depth, or null when the row omits the count. Used to
// rank the MOST-ESTABLISHED chat as home; unknown counts stay out of that
// comparison (fall through to recency) rather than being treated as zero.
function rowMessageCount(row: any) {
  const count = Number(row?.message_count ?? row?.messages);
  return Number.isFinite(count) ? count : null;
}

/**
 * Deterministic canonical pick and STABLE home identity. Precedence, most
 * authoritative first — the caller never falls to a weaker signal while a
 * stronger one is present:
 *  1. an EXISTING DURABLE PIN — fetchHomeSession resolves and verifies it before
 *     ever calling here, so a bound home is authoritative and self-perpetuating;
 *  2. a USER-PINNED sidecar row (`row.pinned`) — an explicit, durable operator
 *     signal that THIS chat is home, honored ahead of any content heuristic;
 *  3. the CONTENT HEURISTIC, the explicit last-resort bootstrap used only when
 *     neither authoritative signal exists: has history, then greatest message
 *     depth, then recent activity and id as the final tiebreaks.
 * Ranking depth before recency means a freshly-opened secondary/scratch chat can
 * never displace the home the user built. The heuristic winner is pinned by the
 * caller on first pick, so it is a one-time bootstrap, not a per-boot recency
 * inference; an explicit id is always lifted from the candidate rows — never a
 * "latest session in the db" / `--continue` token.
 */
function pickHomeRestoreSession(rows: any, options: any = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const candidates = list.filter((row) => isHomeRestoreCandidate(row, options));
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinned !== 0) return pinned;
    const history = Number(rowHasHistory(b)) - Number(rowHasHistory(a));
    if (history !== 0) return history;
    const depthA = rowMessageCount(a);
    const depthB = rowMessageCount(b);
    if (depthA !== null && depthB !== null && depthA !== depthB) return depthB - depthA;
    const activity = rowActivity(b) - rowActivity(a);
    if (activity !== 0) return activity;
    return String(a.id).localeCompare(String(b.id));
  });
  const top = sorted[0];
  return { id: String(top.id), title: typeof top.title === 'string' ? top.title : null };
}

/**
 * In-frame restore script — runs only when storage was actually WIPED. The
 * `ace.homeRestore.epoch` sentinel is written on every run and survives
 * everything except a partition clear: sentinel present + blank memory means
 * the user reached blank with intact storage (an explicit choice) → no-op.
 * Also no-ops on a remembered session (explicit New Chat keeps the previous
 * id), a remembered non-'/' route ('/' is ambient — written every boot), or
 * an already-routed frame.
 */
function buildHomeRestoreScript(sessionId: any, profile: any = null) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  const logical = normalizeLogicalProfile(profile);
  return `
  (() => {
    try {
      if (window.__aceHomeRestoreRan) return { restored: false, reason: 'already-ran' };
      window.__aceHomeRestoreRan = true;
      const id = ${JSON.stringify(id)};
      const suffix = ${JSON.stringify(logical)} ? '.' + ${JSON.stringify(logical)} : '';
      const idKey = 'hermes.desktop.lastSessionId' + suffix;
      const routeKey = 'hermes.desktop.lastRoute' + suffix;
      const epochKey = 'ace.homeRestore.epoch' + suffix;
      const read = (key) => {
        try {
          const value = window.localStorage.getItem(key);
          return value && value.trim() ? value.trim() : null;
        } catch (error) { return null; }
      };
      const write = (key, value) => {
        try { window.localStorage.setItem(key, value); } catch (error) {}
      };
      const storageIntact = read(epochKey) !== null;
      write(epochKey, String(Date.now()));
      if (read(idKey)) return { restored: false, reason: 'remembered-session' };
      const rememberedRoute = read(routeKey);
      if (rememberedRoute && rememberedRoute !== '/') {
        return { restored: false, reason: 'remembered-route' };
      }
      // Blank memory with the sentinel intact = the user cleared to blank on
      // purpose (storage was never wiped) — never take that away.
      if (storageIntact) return { restored: false, reason: 'explicit-blank' };
      const hash = String(window.location.hash || '');
      const route = hash.charAt(0) === '#' ? hash.slice(1) : hash;
      if (route !== '' && route !== '/') return { restored: false, reason: 'routed' };
      const target = '/' + encodeURIComponent(id);
      write(idKey, id);
      write(routeKey, target);
      window.location.hash = '#' + target;
      return { restored: true, sessionId: id };
    } catch (error) {
      return { restored: false, reason: String((error && error.message) || error) };
    }
  })()
  `;
}

// ── Cron job mutation hygiene ───────────────────────────────────────────────

// Fields that would attach a cron RUN (or its delivery) to a live chat
// session at the scheduler level. Ace's home delivery is the one sanctioned
// path into the home chat; letting a job carry these would create the second
// writer the whole design exists to avoid.
const CRON_SESSION_ATTACH_FIELDS = [
  'attach_to_session',
  'origin',
  'session',
  'session_id',
  'session_key',
  'session_target',
];

function stripCronSessionAttachFields(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let next = value;
  for (const field of CRON_SESSION_ATTACH_FIELDS) {
    if (field in next) {
      if (next === value) next = { ...value };
      delete next[field];
    }
  }
  return next;
}

/**
 * Strip session-attach fields (top level + `updates`). Only a CREATE with
 * `deliver` unset gets 'local' pinned; updates never gain a deliver they did
 * not carry, and explicit values pass through.
 */
function sanitizeCronJobMutationBody(body: any, method: any = 'POST') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const isCreate = String(method || 'POST').toUpperCase() === 'POST';
  let next = stripCronSessionAttachFields(body);
  if (next.updates && typeof next.updates === 'object' && !Array.isArray(next.updates)) {
    const updates = stripCronSessionAttachFields(next.updates);
    if (updates !== next.updates) {
      if (next === body) next = { ...body };
      next.updates = updates;
    }
  }
  if (isCreate && !(typeof next.deliver === 'string' && next.deliver.trim())) {
    if (next === body) next = { ...body };
    next.deliver = 'local';
  }
  return next;
}

function isCronJobMutation(apiPath: any, method: any) {
  const verb = String(method || 'GET').toUpperCase();
  const cleanPath = String(apiPath || '').split('?')[0];
  // CREATE is POST on the collection; UPDATE is PUT on the item. Anything else
  // — a POST on the item (pause/resume live under sub-paths; a bare item POST
  // is not a create) or an item sub-path — is neither, and must not be
  // rewritten (never inject deliver:'local' into a non-create request).
  const isCollectionCreate = verb === 'POST' && cleanPath === '/api/cron/jobs';
  const isItemUpdate = verb === 'PUT' && /^\/api\/cron\/jobs\/[^/]+$/.test(cleanPath);
  return isCollectionCreate || isItemUpdate;
}

// ── Completed-run extraction ────────────────────────────────────────────────

/**
 * Completed runs from /runs, oldest first. Production rows are SESSION rows
 * (`cron_<jobId>_<ts>`; `ended_at` = complete; `preview` = the PROMPT). The
 * output is NOT in the row — read the run session's transcript.
 */
function extractCompletedCronRuns(jobId: any, response: any) {
  const job = String(jobId ?? '').trim();
  if (!job) return [];
  const rows = Array.isArray(response)
    ? response
    : Array.isArray(response?.runs)
      ? response.runs
      : [];
  const out: any[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const runId = String(row.id ?? '').trim();
    if (!runId || !runId.startsWith(`cron_${job}_`)) continue;
    const finishedAt = Number(row.ended_at ?? 0) || 0;
    if (!finishedAt) continue; // still running (or never finished)
    out.push({ jobId: job, runId, finishedAt });
  }
  out.sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId));
  return out;
}

/** Last non-empty assistant message from a /messages transcript (string or
 *  part-list content); null when nothing deliverable. */
function extractFinalAssistantOutput(messagesResponse: any) {
  const messages = Array.isArray(messagesResponse?.messages)
    ? messagesResponse.messages
    : Array.isArray(messagesResponse)
      ? messagesResponse
      : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;
    if (String(message.role || '').toLowerCase() !== 'assistant') continue;
    const content = message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    text = text.trim();
    if (text) return text;
  }
  return null;
}

/** Stable per-run marker embedded in the delivered message — the dedupe key
 *  made visible, so a transcript can be audited for exactly-once delivery. */
function cronHomeDeliveryMarker(jobId: any, runId: any) {
  return `[ace-cron ${String(jobId)}#${String(runId)}]`;
}

function buildCronHomeDeliveryMessage(run: any, jobName: any = null) {
  const name = String(jobName ?? '').trim();
  const header = name ? `Cron result — ${name}` : 'Cron result';
  return `${header}\n\n${run.output}\n\n${cronHomeDeliveryMarker(run.jobId, run.runId)}`;
}

// ── Exactly-once delivery ledger ────────────────────────────────────────────

/**
 * Exactly-once ledger under Ace userData (never inside HERMES_HOME).
 * Per-key wx-created claim + delivered marker files: no shared RMW, so
 * overlapping instances cannot double-claim or clobber confirmations.
 * Stale-claim takeover = atomic rename (one winner), flagged for transcript
 * reconciliation. `scope` = logical+backend profile (independent stores mint
 * identical run ids). The metadata JSON holds only schema + corruption
 * watermark; non-ENOENT read failures fail closed via `uncertainSince`.
 */
function createCronDeliveryLedger({ filePath, fsImpl = fs, now = Date.now }: any) {
  const claimsDir = `${filePath}.claims`;
  const deliveredDir = `${filePath}.delivered`;

  function keyOf(scope: any, jobId: any, runId: any) {
    return `${String(scope || 'default')}::${String(jobId)}#${String(runId)}`;
  }

  function fileFor(dir: string, key: string) {
    return path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
  }

  // Legacy version-1 ledgers stored entries inline. Migrate them faithfully:
  // delivered entries become per-key delivered markers (no redelivery),
  // pending entries become steal tokens (their outcome is unknown, so the
  // next claimant reconciles). Any migration failure falls to the uncertain
  // watermark — conservative, never fail-open.
  function migrateV1Entries(entries: any) {
    for (const [key, entry] of Object.entries(entries || {})) {
      const status = (entry as any)?.status;
      if (status === 'delivered') {
        fsImpl.mkdirSync(deliveredDir, { recursive: true });
        try {
          fsImpl.writeFileSync(fileFor(deliveredDir, key), JSON.stringify({ at: now(), key }) + '\n', { flag: 'wx' });
        } catch (err: any) {
          if (err?.code !== 'EEXIST') throw err;
        }
      } else if (status === 'pending') {
        fsImpl.mkdirSync(claimsDir, { recursive: true });
        const keyHash = path.basename(fileFor(claimsDir, key), '.json');
        try {
          fsImpl.writeFileSync(path.join(claimsDir, `${keyHash}.steal-migrated-v1`), JSON.stringify({ at: now(), key }) + '\n', { flag: 'wx' });
        } catch (err: any) {
          if (err?.code !== 'EEXIST') throw err;
        }
      }
    }
  }

  function loadMeta() {
    let raw: any = null;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { state: { version: 2 }, uncertain: false };
      return { state: { version: 2 }, uncertain: true };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === 2) {
        return { state: { version: 2, uncertainSince: Number(parsed.uncertainSince) || undefined }, uncertain: false };
      }
      if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        try {
          migrateV1Entries(parsed.entries);
          const migrated = { version: 2, uncertainSince: Number(parsed.uncertainSince) || undefined };
          saveMeta(migrated);
          return { state: migrated, uncertain: false };
        } catch {
          return { state: { version: 2, uncertainSince: Number(parsed.uncertainSince) || undefined }, uncertain: true };
        }
      }
    } catch {
      // Torn/corrupt content falls through to uncertain.
    }
    return { state: { version: 2 }, uncertain: true };
  }

  function saveMeta(state: any) {
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fsImpl.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
      fsImpl.renameSync(tmpPath, filePath);
    } catch {
      // Best effort — an unpersisted watermark re-stamps on the next load.
    }
  }

  // Corruption watermark: stamped once when the metadata file is unreadable.
  // Always a definite number (0 = no watermark), never undefined.
  function uncertainSince() {
    const loaded = loadMeta();
    if (loaded.uncertain && !Number(loaded.state.uncertainSince)) {
      loaded.state.uncertainSince = now();
      saveMeta(loaded.state);
    }
    return Number(loaded.state.uncertainSince) || 0;
  }

  function readClaimAt(claimFile: string) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(claimFile, 'utf8'));
      const at = Number(parsed?.at);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null; // unreadable claim = age unknown = treat as stale
    }
  }

  return {
    isDelivered(scope: any, jobId: any, runId: any) {
      loadMeta(); // triggers the one-time v1 → marker-file migration
      try {
        return fsImpl.statSync(fileFor(deliveredDir, keyOf(scope, jobId, runId))).isFile();
      } catch (err: any) {
        // Only a definitive ENOENT means "not delivered". Any other I/O
        // failure (permissions, storage) makes the state unverifiable —
        // throw so the caller fails closed instead of double-appending.
        if (err?.code === 'ENOENT') return false;
        throw err;
      }
    },
    /** Atomic claim. `retriedAfterCrash` = outcome unknown (stale takeover,
     *  unresolved takeover token, or run predates the corruption watermark):
     *  the caller MUST reconcile the transcript marker before appending.
     *  Takeover renames the stale claim to a persistent steal token (one
     *  winner; survives until confirm), and every grant scans tokens — a
     *  claimant of a doubted key can never append unreconciled. */
    claim(scope: any, jobId: any, runId: any, finishedAtMs: any = 0) {
      const key = keyOf(scope, jobId, runId);
      if (this.isDelivered(scope, jobId, runId)) return { granted: false, retriedAfterCrash: false };
      const watermark = uncertainSince();
      const predatesWatermark = watermark > 0 && (Number(finishedAtMs) || 0) <= watermark;
      const claimFile = fileFor(claimsDir, key);
      const keyHash = path.basename(claimFile, '.json');
      const hasStealTokens = () => {
        try {
          return fsImpl.readdirSync(claimsDir).some((name: string) => name.startsWith(`${keyHash}.steal-`));
        } catch (err: any) {
          // Unreadable claims dir ⇒ tokens MIGHT exist ⇒ reconcile
          // (fail closed); only a missing dir proves there are none.
          return err?.code !== 'ENOENT';
        }
      };
      const writeClaim = () => {
        fsImpl.mkdirSync(claimsDir, { recursive: true });
        fsImpl.writeFileSync(claimFile, JSON.stringify({ at: now(), key }) + '\n', { flag: 'wx' });
      };
      try {
        writeClaim(); // exclusive create — the atomic cross-instance gate
        return { granted: true, retriedAfterCrash: predatesWatermark || hasStealTokens() };
      } catch (err: any) {
        if (err?.code !== 'EEXIST') return { granted: false, retriedAfterCrash: false };
      }
      const at = readClaimAt(claimFile);
      if (at !== null && now() - at < PENDING_CLAIM_RETRY_MS) return { granted: false, retriedAfterCrash: false };
      // Stale (or unreadable) claim: rename is atomic — exactly one contender
      // wins the token; losers get ENOENT and stand down. The token is kept
      // (not unlinked) so any gap claimant sees the doubt.
      const stolen = path.join(claimsDir, `${keyHash}.steal-${process.pid}-${Math.random().toString(36).slice(2)}`);
      try {
        fsImpl.renameSync(claimFile, stolen);
      } catch {
        return { granted: false, retriedAfterCrash: false };
      }
      try {
        writeClaim();
      } catch {
        // A gap claimant re-created the claim first — it saw our token and
        // reconciles; we stand down and the token stays until confirm().
        return { granted: false, retriedAfterCrash: false };
      }
      return { granted: true, retriedAfterCrash: true };
    },
    confirm(scope: any, jobId: any, runId: any) {
      const key = keyOf(scope, jobId, runId);
      try {
        fsImpl.mkdirSync(deliveredDir, { recursive: true });
        fsImpl.writeFileSync(fileFor(deliveredDir, key), JSON.stringify({ at: now(), key }) + '\n', { flag: 'wx' });
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
      }
      const claimFile = fileFor(claimsDir, key);
      try { fsImpl.unlinkSync(claimFile); } catch { /* released */ }
      // The key is resolved: retire its doubt tokens.
      const keyHash = path.basename(claimFile, '.json');
      try {
        for (const name of fsImpl.readdirSync(claimsDir)) {
          if (name.startsWith(`${keyHash}.steal-`)) {
            try { fsImpl.unlinkSync(path.join(claimsDir, name)); } catch { /* best effort */ }
          }
        }
      } catch { /* no claims dir */ }
    },
    release(scope: any, jobId: any, runId: any) {
      // Steal tokens are NOT retired here: release means "no append happened
      // THIS attempt", not "the doubt is resolved".
      try { fsImpl.unlinkSync(fileFor(claimsDir, keyOf(scope, jobId, runId))); } catch { /* already gone */ }
    },
  };
}

// ── HTTP plumbing (self-contained; mirrors the bridge's fetchJson) ─────────

function fetchJson(url: any, token: any, options: any = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = client.request(
      parsed,
      {
        method: options.method || 'GET',
        timeout: options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Session-Token': token,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
      },
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk: any) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            const err: any = new Error(`${res.statusCode}: ${text || res.statusMessage}`);
            err.statusCode = res.statusCode || 500;
            reject(err);
            return;
          }
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); } catch (err: any) {
            reject(new Error(`Hermes backend returned non-JSON for ${parsed.pathname}: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Hermes backend request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * The main-process controller behind the `ace:hermes-home-restore` /
 * `ace:hermes-cron-home-sync` IPC. `connection` is the dashboard manager's
 * appConnection (baseUrl + token + logical profile + backendProfile);
 * everything else is injectable for tests.
 */
function createHomeChatController({
  connection,
  ledgerPath,
  canonicalPath = null,
  fetchApi = fetchJson,
  fsImpl = fs,
  now = Date.now,
}: any) {
  const ledger = createCronDeliveryLedger({ filePath: ledgerPath, fsImpl, now });
  // Unsupported-append record, keyed by backend INSTANCE (baseUrl + per-spawn
  // token): a same-port respawn re-probes instead of staying suppressed.
  let unsupportedBackendId: string | null = null;
  const backendId = (conn: any) => `${String(conn?.baseUrl || '')}#${String(conn?.token || '')}`;
  // One pin file per profile (no shared RMW; unique tmp + atomic rename) so
  // concurrent profile sweeps never clobber each other. Restore AND delivery
  // use the pin; it drops only when the session is proven gone/ineligible.
  // The old combined JSON stays as a read-only legacy fallback.
  const canonicalFile = canonicalPath || `${ledgerPath}.canonical.json`;
  const canonicalDir = `${canonicalFile}.d`;
  const syncInFlight = new Map();

  function pinFileFor(profileKey: string) {
    return path.join(canonicalDir, `${encodeURIComponent(profileKey)}.json`);
  }

  function loadPin(profileKey: string) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(pinFileFor(profileKey), 'utf8'));
      const sessionId = String(parsed?.sessionId ?? '').trim();
      if (sessionId) return sessionId;
    } catch { /* fall through to legacy */ }
    try {
      const legacy = JSON.parse(fsImpl.readFileSync(canonicalFile, 'utf8'));
      const sessionId = String(legacy?.profiles?.[profileKey]?.sessionId ?? '').trim();
      return sessionId || null;
    } catch {
      return null;
    }
  }

  function savePin(profileKey: string, sessionId: string) {
    try {
      fsImpl.mkdirSync(canonicalDir, { recursive: true });
      const tmpPath = `${pinFileFor(profileKey)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fsImpl.writeFileSync(tmpPath, JSON.stringify({ sessionId, pinnedAt: now() }) + '\n');
      fsImpl.renameSync(tmpPath, pinFileFor(profileKey));
    } catch {
      // Best effort: an unpersisted pin degrades to the deterministic re-pick.
    }
  }

  const callApi = async (conn: any, apiPath: string, options: any = {}) =>
    fetchApi(`${conn.baseUrl}${apiPath}`, conn.token, options);

  // The profile name the SERVING sidecar answers to. Cron listing defaults to
  // profile=all upstream, so every cron call must be scoped with this — an
  // unscoped list would let another profile's runs leak into this home chat.
  function servingProfile(conn: any) {
    const backend = String(conn?.backendProfile ?? '').trim();
    if (backend) return backend;
    return normalizeLogicalProfile(conn?.profile) || 'default';
  }

  // Ledger claim scope. backendProfile alone is NOT unique: every
  // identity-home sidecar reports 'default', so two operators' independent
  // state.dbs (which can mint identical cron_<jobId>_<ts> ids) would collide.
  // The logical operator profile disambiguates the store identity.
  function ledgerScope(conn: any) {
    const logical = normalizeLogicalProfile(conn?.profile) || 'default';
    const backend = String(conn?.backendProfile ?? '').trim() || 'default';
    return `${logical}/${backend}`;
  }

  function finishedAtToMs(finishedAt: any) {
    const raw = Number(finishedAt) || 0;
    if (!raw) return 0;
    return raw > 1e12 ? raw : raw * 1000;
  }

  // Direct row lookup for pin validation. null ⇒ the session provably does
  // not exist (404); undefined ⇒ the lookup itself failed (keep the pin —
  // absence of proof is not proof of absence).
  async function fetchSessionRow(conn: any, sessionId: string) {
    try {
      const response: any = await callApi(conn, `/api/sessions/${encodeURIComponent(sessionId)}`);
      const row = response?.session && typeof response.session === 'object' ? response.session : response;
      return row && typeof row === 'object' && row.id ? row : null;
    } catch (err: any) {
      return err?.statusCode === 404 ? null : undefined;
    }
  }

  // Drop a profile's pin (the pinned session is proven gone/ineligible): the
  // next restore/sweep re-picks deterministically and re-pins. The legacy
  // combined file's entry is cleared too so the fallback cannot resurrect it.
  function dropCanonicalPin(profileKey: string) {
    try { fsImpl.unlinkSync(pinFileFor(profileKey)); } catch { /* no pin file */ }
    try {
      const legacy = JSON.parse(fsImpl.readFileSync(canonicalFile, 'utf8'));
      if (legacy?.profiles?.[profileKey]) {
        delete legacy.profiles[profileKey];
        const tmpPath = `${canonicalFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fsImpl.writeFileSync(tmpPath, JSON.stringify(legacy, null, 2) + '\n');
        fsImpl.renameSync(tmpPath, canonicalFile);
      }
    } catch { /* no legacy file */ }
  }

  // `requireVerified` distinguishes the two callers' safety needs. Restore (read
  // side) may reopen a last-known-good pin that momentarily failed to verify —
  // the worst case is briefly showing a chat that turns out archived. Delivery
  // (write side) must NOT: appending cron output into an unverified pin can land
  // it in an archived/reclassified/non-home session, so delivery fails closed
  // (null) until the destination is positively confirmed and retries next sweep.
  async function fetchHomeSession(conn: any, { requireVerified = false } = {}) {
    const profile = normalizeLogicalProfile(conn.profile) || null;
    const profileKey = profile || 'default';
    // Pin first, before any network I/O: the shortlist only freshness-checks the
    // pin, it is not a prerequisite for having a home to reopen. Loading it first
    // lets a transient shortlist failure still restore last-known-good.
    const pinnedId = loadPin(profileKey) || '';
    let rows: any[];
    try {
      const response: any = await callApi(conn, homeRestoreSessionsApiPath());
      rows = Array.isArray(response?.sessions) ? response.sessions : [];
    } catch {
      // Shortlist itself unavailable: restore reopens last-known-good; delivery
      // fails closed until the destination is positively confirmed.
      return !requireVerified && pinnedId ? { id: pinnedId, title: null } : null;
    }
    if (pinnedId) {
      // The shortlist is a bounded window — a pin older than the newest 50
      // eligible sessions is NOT invalid. Verify directly and repick only
      // when the pinned session is proven missing or ineligible.
      const pinnedRow =
        rows.find((row: any) => row?.id === pinnedId) ?? (await fetchSessionRow(conn, pinnedId));
      if (pinnedRow === undefined) {
        // Transient/unverified direct lookup. Delivery fails closed; restore keeps last-known-good.
        return requireVerified ? null : { id: pinnedId, title: null };
      }
      if (pinnedRow && isHomeRestoreCandidate(pinnedRow, { profile })) {
        return { id: pinnedId, title: typeof pinnedRow.title === 'string' ? pinnedRow.title : null };
      }
    }
    const picked = pickHomeRestoreSession(rows, { profile });
    if (picked && picked.id !== pinnedId) {
      savePin(profileKey, picked.id);
    }
    return picked;
  }

  /** Resolve the canonical home chat and the cold-start seed script for the
   *  live embed frame. `{ sessionId: null }` when no eligible session exists
   *  (a genuinely fresh install boots blank — correctly). */
  async function restoreHomeSession(options: any = {}) {
    const conn = await connection(options.profile ?? null);
    const picked = await fetchHomeSession(conn);
    if (!picked) return { sessionId: null, script: null };
    return {
      sessionId: picked.id,
      script: buildHomeRestoreScript(picked.id, normalizeLogicalProfile(conn.profile) || null),
    };
  }

  // Crashed/ambiguous prior attempt: the transcript marker is the arbiter.
  // Pages the FULL transcript (API clamp 500/page); an exhausted-page-budget
  // search throws (unknown ⇒ caller keeps the claim pending — fail closed;
  // a "not found" verdict is only valid when every page was scanned).
  async function reconcileCrashedDelivery(conn: any, homeId: string, run: any) {
    const marker = cronHomeDeliveryMarker(run.jobId, run.runId);
    let offset = 0;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
      const messages: any = await callApi(
        conn,
        `/api/sessions/${encodeURIComponent(homeId)}/messages?limit=${RECONCILE_PAGE_LIMIT}&offset=${offset}`
      );
      const rows = Array.isArray(messages?.messages) ? messages.messages : [];
      const found = rows.some((message: any) => {
        const content = message?.content;
        return typeof content === 'string' && content.includes(marker);
      });
      if (found) return true;
      // Advance by the ACTUAL row count and treat only an empty page as the end
      // (a sidecar may clamp pages below the request; a short page is NOT the
      // end, as fetchRunFinalOutput already handles).
      if (rows.length === 0) return false;
      offset += rows.length;
    }
    throw new Error('marker reconciliation exhausted its page budget');
  }

  // The final assistant message of a run, read by paging the FULL transcript
  // (the endpoint clamps to RECONCILE_PAGE_LIMIT/page). A single unpaginated
  // read could omit the last message on a long run; the caller would then
  // confirm terminal-empty and lose the delivery. Pages until a short page or
  // the defensive budget; a budget-exhausted read throws so the caller keeps
  // the claim (never a false terminal-empty).
  async function fetchRunFinalOutput(conn: any, runId: string) {
    const messages: any[] = [];
    let offset = 0;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
      const response: any = await callApi(
        conn,
        `/api/sessions/${encodeURIComponent(runId)}/messages?limit=${RECONCILE_PAGE_LIMIT}&offset=${offset}`
      );
      const rows = Array.isArray(response?.messages) ? response.messages : [];
      // Advance by the ACTUAL page size (a sidecar may clamp below the request),
      // and stop on an empty page — the reliable end signal that a
      // request-vs-returned-count heuristic gets wrong against a clamping API.
      if (rows.length === 0) return extractFinalAssistantOutput({ messages });
      messages.push(...rows);
      offset += rows.length;
    }
    throw new Error('run transcript exceeded the page budget');
  }

  // Completed runs for one job. The runs endpoint takes only `limit` (no
  // offset — offset paging is a no-op there), so it returns the most-recent
  // window. Request a window wide enough to cover a realistic app-offline gap
  // and deliver every undelivered run in it exactly once (the ledger dedups the
  // already-delivered prefix). `partial` is honest: a FULL window means runs
  // older than it exist and were not enumerated — for scheduled delivery those
  // are historical, deliberately not flooded into the home chat, and the next
  // sweep still catches anything that re-enters the recent window.
  async function fetchCompletedRuns(conn: any, jobId: string, cronProfile: string) {
    let response: any = null;
    try {
      response = await callApi(
        conn,
        `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${CRON_RUNS_WINDOW}&profile=${cronProfile}`
      );
    } catch {
      return { runs: [], partial: true };
    }
    const rowCount = Array.isArray(response?.runs) ? response.runs.length : 0;
    return { runs: extractCompletedCronRuns(jobId, response), partial: rowCount >= CRON_RUNS_WINDOW };
  }

  // Whether an empty-output run is definitively terminal: ended long enough
  // ago that a still-flushing transcript is no longer plausible. `finishedAt`
  // arrives in unix seconds from the sessions row (ms tolerated).
  function emptyOutputIsTerminal(finishedAt: any) {
    const finishedMs = finishedAtToMs(finishedAt);
    if (!finishedMs) return false;
    return now() - finishedMs > PENDING_CLAIM_RETRY_MS;
  }

  async function syncOnce(options: any = {}) {
    const conn = await connection(options.profile ?? null);
    if (unsupportedBackendId && unsupportedBackendId === backendId(conn)) {
      return {
        ok: false,
        delivered: [],
        skipped: 0,
        unsupported: true,
        suppressed: true,
        reason: 'append-route-unsupported',
      };
    }
    const home = await fetchHomeSession(conn, { requireVerified: true });
    // No verified home chat ⇒ nothing to deliver INTO. Never fall back to a
    // cron/worker/etc session (that re-creates the leak this excludes), and a
    // transiently-unverified pin fails closed here so the claim retries rather
    // than appending output into a session we cannot confirm is still home.
    if (!home) return { ok: true, delivered: [], skipped: 0, reason: 'no-home-session' };

    // Scope EVERY cron call to the serving profile: upstream job listing
    // defaults to profile=all, which would surface other profiles' runs here.
    const serving = servingProfile(conn);
    const scope = ledgerScope(conn);
    const cronProfile = encodeURIComponent(serving);
    let jobsResponse: any = null;
    try {
      jobsResponse = await callApi(conn, `/api/cron/jobs?profile=${cronProfile}`);
    } catch {
      return { ok: false, delivered: [], skipped: 0, reason: 'cron-jobs-unavailable' };
    }
    const allJobs = (Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs : Array.isArray(jobsResponse) ? jobsResponse : [])
      .filter((job: any) => job && typeof job === 'object' && typeof job.id === 'string' && job.id.trim())
      // Belt and braces on top of the scoped query: a job row tagged with a
      // DIFFERENT profile is never delivered into this home.
      .filter((job: any) => {
        const owner = String(job.profile ?? '').trim();
        return !owner || owner === serving;
      });
    // Every job in the single (unpaginated) /api/cron/jobs response is swept —
    // no client-side ceiling drops a job, so a job is never permanently
    // stranded here. The response is the complete per-profile set; if the
    // endpoint ever grew server-side pagination that would be a separate
    // continuation, never silently masked as completeness.
    let partial = false;
    const jobs = allJobs;

    const delivered: any[] = [];
    let skipped = 0;
    let unsupported = false;
    let homeMissing = false;
    for (const job of jobs) {
      // Jobs with an explicit non-local delivery target already deliver
      // through their own platform path — relaying them here would be a
      // second delivery of the same run. Only local-output jobs are relayed.
      const jobDeliver = normalizeSource(job.deliver) || 'local';
      if (jobDeliver !== 'local') { continue; }
      const jobRuns = await fetchCompletedRuns(conn, job.id, cronProfile);
      partial = partial || jobRuns.partial;
      for (const run of jobRuns.runs) {
        // Unverifiable ledger state (I/O failure) fails closed: never append
        // a run whose delivered/claimed status cannot be proven.
        let claim: any;
        try {
          if (ledger.isDelivered(scope, run.jobId, run.runId)) { skipped += 1; continue; }
          claim = ledger.claim(scope, run.jobId, run.runId, finishedAtToMs(run.finishedAt));
        } catch {
          skipped += 1;
          continue;
        }
        if (!claim.granted) { skipped += 1; continue; }

        // Unknown-outcome retry: reconcile first; a failed read keeps the claim pending.
        if (claim.retriedAfterCrash) {
          let alreadyLanded = false;
          try {
            alreadyLanded = await reconcileCrashedDelivery(conn, home.id, run);
          } catch {
            skipped += 1;
            continue;
          }
          if (alreadyLanded) {
            ledger.confirm(scope, run.jobId, run.runId);
            skipped += 1;
            continue;
          }
        }

        // Output comes from the run's own transcript. 404 = run session gone
        // (close claim); other read failures release (no append yet). Page the
        // FULL transcript (API clamps to RECONCILE_PAGE_LIMIT/page): a single
        // unpaginated read could omit the final assistant message on a long run
        // and then falsely confirm terminal-empty, losing the delivery.
        let output: any = null;
        try {
          output = await fetchRunFinalOutput(conn, run.runId);
        } catch (err: any) {
          if (err?.statusCode === 404) ledger.confirm(scope, run.jobId, run.runId);
          else ledger.release(scope, run.jobId, run.runId);
          skipped += 1;
          continue;
        }
        if (!output) {
          // Terminal-empty closes; a just-ended transcript may still be
          // flushing — release (no append yet) and retry next sweep.
          if (emptyOutputIsTerminal(run.finishedAt)) {
            ledger.confirm(scope, run.jobId, run.runId);
          } else {
            ledger.release(scope, run.jobId, run.runId);
          }
          skipped += 1;
          continue;
        }

        // Append: 405 = capability missing (release, fail closed); 404 = home
        // session vanished (release + drop pin, never poison the backend);
        // anything else is ambiguous — keep the claim pending so the retry
        // reconciles the marker before any second append.
        try {
          await callApi(conn, `/api/sessions/${encodeURIComponent(home.id)}/messages`, {
            method: 'POST',
            body: {
              role: 'user',
              content: buildCronHomeDeliveryMessage({ ...run, output }, job.name),
              display_kind: 'ace-home-delivery',
              // Sidecar-side idempotency: the same per-run marker as the ledger
              // claim, so an ambiguous-response retry is a no-op at the append
              // route (has_platform_message_id) as well as in the ledger.
              dedupe_key: cronHomeDeliveryMarker(run.jobId, run.runId),
            },
          });
        } catch (err: any) {
          if (err?.statusCode === 405) {
            ledger.release(scope, run.jobId, run.runId);
            unsupported = true;
            break;
          }
          if (err?.statusCode === 404) {
            ledger.release(scope, run.jobId, run.runId);
            dropCanonicalPin(normalizeLogicalProfile(conn.profile) || 'default');
            homeMissing = true;
            break;
          }
          continue;
        }
        ledger.confirm(scope, run.jobId, run.runId);
        delivered.push({ jobId: run.jobId, runId: run.runId, sessionId: home.id });
      }
      if (unsupported || homeMissing) break;
    }
    if (unsupported) {
      if (unsupportedBackendId !== backendId(conn)) {
        unsupportedBackendId = backendId(conn);
        console.warn(
          '[ace] hermes cron home delivery unavailable: this sidecar serves GET-only on the transcript route; deliveries stay claimed-free and land once a capable sidecar runs.'
        );
      }
      return { ok: false, delivered, skipped, unsupported: true, reason: 'append-route-unsupported' };
    }
    if (homeMissing) {
      // The pin was dropped; the next sweep re-picks a fresh home session.
      return { ok: false, delivered, skipped, reason: 'home-session-missing' };
    }
    return { ok: true, delivered, skipped, sessionId: home.id, ...(partial ? { partial: true } : {}) };
  }

  /** Exactly-once cron→home delivery sweep. Coalesced PER PROFILE:
   *  concurrent callers for one profile share an in-flight sweep (two
   *  triggers cannot double-deliver even before the claim lands), while a
   *  different profile's sweep runs independently instead of receiving the
   *  first profile's result. */
  function syncCronHomeDelivery(options: any = {}) {
    const key = String(options.profile ?? '');
    const inFlight = syncInFlight.get(key);
    if (inFlight) return inFlight;
    const sweep = Promise.resolve()
      .then(() => syncOnce(options))
      .catch((err: any) => ({ ok: false, delivered: [], skipped: 0, reason: String(err?.message || err) }))
      .finally(() => { syncInFlight.delete(key); });
    syncInFlight.set(key, sweep);
    return sweep;
  }

  return { restoreHomeSession, syncCronHomeDelivery };
}

module.exports = {
  HOME_RESTORE_EXCLUDED_SOURCES,
  homeRestoreSessionsApiPath,
  isHomeRestoreCandidate,
  pickHomeRestoreSession,
  buildHomeRestoreScript,
  sanitizeCronJobMutationBody,
  isCronJobMutation,
  extractCompletedCronRuns,
  extractFinalAssistantOutput,
  cronHomeDeliveryMarker,
  buildCronHomeDeliveryMessage,
  createCronDeliveryLedger,
  createHomeChatController,
};
