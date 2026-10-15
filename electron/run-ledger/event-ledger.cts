// event-ledger — the append-only event log that is the Run Ledger source of
// truth. Every higher projection (six-panel, Kanban, next-goal derivation)
// reads from here; nothing in this module routes to disk beyond the caller's
// filePath, and it is pure of spine imports.
//
// CONCURRENCY (gap G2): proper-lockfile is intentionally NOT a dependency.
// The design is a single writer — one auto-rally engine appends in order — so
// fs.appendFileSync (atomic for one writer) is sufficient, and the unlocked
// local-core.cts:5590 append is the existing precedent. If a SECOND writer
// process is ever introduced, do NOT add a dependency: guard the append with a
// dependency-free fs.mkdirSync('<dir>/.lock') mutex (mkdir is atomic on POSIX)
// or split into per-run files. Until then, locking is deliberately omitted.
//
// Determinism: no Date.now()/Math.random() at module top-level. ids are derived
// from a per-log monotonic counter; ts is supplied by the caller (an optional
// { now } clock is accepted on the file factory only for a default fallback).

const fs = require('node:fs');
const path = require('node:path');

const EVENT_TYPES = Object.freeze({
  INTENT_CREATED: 'intent.created',
  RUN_CREATED: 'run.created',
  WORKER_DISPATCHED: 'worker.dispatched',
  // The durable spawn FACT: a real, Ace-visible stream/task/worktree was
  // created and linked to this run. WORKER_DISPATCHED is only the "we started
  // it" marker; this is the positive proof the dispatch actually landed.
  WORKER_DISPATCH_LINKED: 'worker.dispatch.linked',
  // Fail-closed counterpart: the spawn/link FAILED. Carries the exact error so
  // the run reconciles to BLOCKED instead of leaving a phantom "dispatched"
  // marker the board would report as a healthy in-flight worker.
  WORKER_DISPATCH_FAILED: 'worker.dispatch.failed',
  WORKER_PROGRESS: 'worker.progress',
  WORKER_COMPLETED: 'worker.completed',
  // Telemetry an agent appends AFTER it finishes its unit of work (rubric score,
  // acceptance commands run, wall-clock, its own token spend). The watcher folds
  // these for free — it never spends tokens to collect them. See reconciler fold.
  WORKER_TELEMETRY: 'worker.telemetry',
  VALIDATOR_DISPATCHED: 'validator.dispatched',
  VALIDATOR_DISPATCH_LINKED: 'validator.dispatch.linked',
  VALIDATOR_DISPATCH_FAILED: 'validator.dispatch.failed',
  VALIDATOR_COMPLETED: 'validator.completed',
  GATE_EVALUATED: 'gate.evaluated',
  // The controller requested the ready-head review (ReviewBot ready/trigger +
  // the /codex review comment) for one exact PR head. Appended with an id keyed
  // by headSha so re-gating the same head never double-requests.
  REVIEW_REQUESTED: 'review.requested',
  FIXBACK_DISPATCHED: 'fixback.dispatched',
  AUTOSHIP_MERGE_STARTED: 'autoship.merge.started',
  AUTOSHIP_MERGE_BLOCKED: 'autoship.merge.blocked',
  MERGED: 'merged',
  RELEASED: 'released',
  MEMORY_PROMOTED: 'memory.promoted',
  RUN_BLOCKED: 'run.blocked',
  NEXT_GOAL_DERIVED: 'next-goal.derived',
});

// Events that create a run's identity; their append requires owning the id's
// reservation (see each backend's append).
const RUN_CREATION_TYPES = new Set<string>([EVENT_TYPES.INTENT_CREATED, EVENT_TYPES.RUN_CREATED]);

// Secret redaction (gap G-secrets): worker trailers / CI output flow into event
// payloads, so a leaked credential must never be durably written to the ledger.
// Mask credential-shaped substrings at the write boundary. Deterministic (regex
// only, no Date/random) so replay stays exact. Kept intentionally small —
// source creds from env/keychain, this is the last-line backstop.
const SECRET_PATTERNS = Object.freeze([
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bplane_api_[A-Za-z0-9_-]{20,}\b/g,
  /\bace_(?:at|rt|dc|ws|os)_[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g,
  /\b(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{12,}/gi,
]);

function redactSecrets(value: any): any {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) out[k] = redactSecrets(value[k]);
    return out;
  }
  return value;
}

// Normalize/validate an incoming event into the canonical shape. Returns null
// when it cannot be a valid event (missing runId or type). `deriveId` mints a
// stable id from the per-log counter when the caller omits one.
function prepareEvent(raw: any, deriveId: (runId: string, type: string) => string) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const runId = event.runId == null ? '' : String(event.runId).trim();
  const type = event.type == null ? '' : String(event.type).trim();
  if (!runId || !type) return null;
  const id = event.id == null || String(event.id).trim() === ''
    ? deriveId(runId, type)
    : String(event.id);
  return {
    id,
    runId,
    ts: event.ts, // caller-supplied; left undefined when absent (no Date.now here)
    type,
    payload: redactSecrets(event.payload === undefined ? null : event.payload),
  };
}

// Array-backed event log. Same interface as the file log, no persistence.
function createMemoryEventLog() {
  const events: any[] = [];
  const seen = new Set();
  let seq = 0;
  const deriveId = (runId: string, type: string) => `${runId}:${type}:${seq}`;

  function append(raw: any) {
    const event = prepareEvent(raw, deriveId);
    if (!event) return null;
    if (seen.has(event.id)) return null; // idempotent: same id => skip
    // Seam parity with the file log: run-creation appends claim the id
    // (single instance, so check-and-add cannot lose to a foreign holder).
    if (RUN_CREATION_TYPES.has(event.type) && !reservedRunIds.has(String(event.runId))) {
      reservedRunIds.add(String(event.runId));
    }
    seen.add(event.id);
    seq += 1;
    events.push(event);
    return event;
  }

  function readAll() {
    return events.slice();
  }

  function readRun(runId: any) {
    const id = String(runId == null ? '' : runId);
    return events.filter((e) => e.runId === id);
  }

  // Every runId this log has ever seen; seam-compatible with the file log.
  function knownRunIds() {
    const ids = new Set<string>();
    for (const e of events) {
      const id = e && e.runId != null ? String(e.runId).trim() : '';
      if (id) ids.add(id);
    }
    return ids;
  }

  // In-process check-and-add reservation; same seam as the file log's 'wx'.
  const reservedRunIds = new Set<string>();
  function reserveRunId(runId: any) {
    const id = String(runId == null ? '' : runId).trim();
    if (!id || reservedRunIds.has(id)) return false;
    reservedRunIds.add(id);
    return true;
  }

  return { append, readAll, readRun, knownRunIds, reserveRunId };
}

// Allocation-path parse: any malformed non-empty line throws — a corrupt
// record could hide a historical runId and let it be re-minted.
function parseNdjsonStrict(content: string, sourceLabel: string) {
  const out: any[] = [];
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: any) {
      throw new Error(
        `event-ledger: malformed record at ${sourceLabel}:${i + 1} — run-id allocation refuses corrupt history (${err && err.message})`,
      );
    }
    // prepareEvent guarantees id + trimmed non-empty runId/type on every
    // written record; anything less here is corruption and fails allocation.
    const runId = parsed && typeof parsed === 'object' && parsed.runId != null ? String(parsed.runId) : '';
    const type = parsed && typeof parsed === 'object' && parsed.type != null ? String(parsed.type) : '';
    if (
      !parsed || typeof parsed !== 'object' || parsed.id == null ||
      runId === '' || runId !== runId.trim() ||
      type === '' || type !== type.trim()
    ) {
      throw new Error(
        `event-ledger: malformed record at ${sourceLabel}:${i + 1} — run-id allocation refuses corrupt history (missing or non-canonical id/runId/type)`,
      );
    }
    out.push(parsed);
  }
  return out;
}

// Parse NDJSON content into events, skipping blank/corrupt lines defensively.
function parseNdjson(content: string) {
  const out: any[] = [];
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed.id != null) out.push(parsed);
    } catch {
      // corrupt line (e.g. a partial write) — skip, never throw
    }
  }
  return out;
}

// Event types that a dispatch/reconcile loop can emit in unbounded repetition
// for the SAME run (the June-2026 storm wrote 81k of these across 14 runs and
// pushed every board/watch fold past 38s). The fold is last-write-wins on the
// fields these advance, so only the newest few occurrences per (run, type)
// carry state; older repeats are pure noise.
const COLLAPSIBLE_TYPES = Object.freeze([
  EVENT_TYPES.WORKER_DISPATCHED,
  EVENT_TYPES.WORKER_DISPATCH_FAILED,
  EVENT_TYPES.VALIDATOR_DISPATCHED,
  EVENT_TYPES.VALIDATOR_DISPATCH_FAILED,
  EVENT_TYPES.GATE_EVALUATED,
]);

// How many newest events per (runId, collapsible type) compaction retains.
// SEMANTICS — compaction is POLICY-VERDICT-PRESERVING, not fold-identical:
// history-dependent counters (the reconciler's consecutive dispatchFailedCount)
// SATURATE at this value after compaction. That preserves every policy verdict
// as long as this constant stays >= any threshold that reads those counters
// (orchestration-policy DISPATCH_RETRY_CAP = 3); a cross-module test pins the
// invariant (dispatch-retry-cap.test.cts). Raise this alongside any cap raise.
const COMPACT_KEEP_LAST = 3;

// Compact an on-disk NDJSON ledger IN PLACE: for each (runId, collapsible
// type) keep only the newest `keepLast` events. Relative order of every kept
// line is preserved, non-collapsible events are untouched, and malformed
// (non-JSON) lines are kept in place verbatim — compaction never destroys
// forensic data. Every dropped event line is appended to the archive file
// FIRST, so no event is ever lost. No-op below `threshold` events.
// Single-writer only: call BEFORE the log is handed to appenders
// (createFileEventLog runs it at construction). Deterministic — no clocks,
// stable archive name.
function compactFileEventLog(filePath: any, { keepLast = COMPACT_KEEP_LAST, threshold = 10000, archivePath }: any = {}) {
  const file = String(filePath || '').trim();
  if (!file) throw new Error('event-ledger: filePath required');
  // One entry per non-empty line: { line, event } with event=null for
  // malformed lines (kept verbatim, never counted, never dropped).
  const rows: Array<{ line: string; event: any }> = [];
  let eventCount = 0;
  for (const line of safeRead(file).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any = null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed.id != null) event = parsed;
    } catch {
      // malformed line - carried through below
    }
    if (event) eventCount += 1;
    // Keep the ORIGINAL line bytes (no trim, no re-serialization) so kept and
    // archived lines are byte-identical to what was on disk — malformed lines
    // are forensic data. Only fully-blank lines are dropped.
    rows.push({ line, event });
  }
  if (eventCount < Math.max(1, Number(threshold) || 0)) {
    return { compacted: false, before: eventCount, after: eventCount };
  }
  const collapsible = new Set(COLLAPSIBLE_TYPES as readonly string[]);
  const positions = new Map<string, number[]>();
  rows.forEach(({ event }, i) => {
    if (!event || !collapsible.has(String(event.type))) return;
    const key = `${event.runId} ${event.type}`;
    const arr = positions.get(key) || [];
    arr.push(i);
    positions.set(key, arr);
  });
  const drop = new Set<number>();
  for (const idxs of positions.values()) {
    for (let i = 0; i < idxs.length - keepLast; i += 1) drop.add(idxs[i]);
  }
  if (drop.size === 0) {
    return { compacted: false, before: eventCount, after: eventCount };
  }
  const archive = String(archivePath || '').trim() || path.join(path.dirname(file), 'events-archive.ndjson');
  const dropped: string[] = [];
  const kept: string[] = [];
  rows.forEach(({ line }, i) => (drop.has(i) ? dropped : kept).push(line));
  // Archive FIRST (append - the archive accumulates across compactions), then
  // swap the live file via write-temp + rename so a crash mid-compaction
  // leaves either the old file or the new file, never a partial one.
  fs.appendFileSync(archive, `${dropped.join('\n')}\n`);
  const tmp = `${file}.compact.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  return { compacted: true, before: eventCount, after: eventCount - dropped.length, archived: dropped.length, archive };
}

// Archive WHOLE RUNS out of an on-disk NDJSON ledger IN PLACE: every event line
// whose parsed runId is in `runIds` moves to the archive file; everything else
// (including malformed/non-JSON lines — forensic data) stays exactly where it
// was, byte-identical. Same durability recipe as compactFileEventLog: archived
// lines are APPENDED to events-archive.ndjson FIRST, then the live file is
// swapped via write-temp + rename, so a crash mid-archive leaves either the old
// file or the new file, never a partial one — and no event line is ever lost.
// Empty selection (or no matching lines) is a no-op that touches nothing.
// Single-writer only: call BEFORE the log is handed to appenders, or from the
// SAME process that owns the appender (all ledger I/O is synchronous and
// readAll() re-reads the file per call, so an in-process archive under the live
// appender is safe). Deterministic — no clocks, stable archive name.
function archiveRunEvents(filePath: any, { runIds, archivePath }: any = {}) {
  const file = String(filePath || '').trim();
  if (!file) throw new Error('event-ledger: filePath required');
  const ids = new Set((Array.isArray(runIds) ? runIds : []).map((id: any) => String(id)).filter(Boolean));
  const archive = String(archivePath || '').trim() || path.join(path.dirname(file), 'events-archive.ndjson');
  const kept: string[] = [];
  const dropped: string[] = [];
  let eventCount = 0;
  const archivedRunIds = new Set<string>();
  for (const line of safeRead(file).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any = null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed.id != null) event = parsed;
    } catch {
      // malformed line — always kept in place verbatim (never archived, never
      // counted): archival must not destroy forensic data.
    }
    if (event) eventCount += 1;
    // Keep ORIGINAL line bytes (no trim, no re-serialization) so both kept and
    // archived lines are byte-identical to what was on disk.
    if (event && ids.has(String(event.runId))) {
      archivedRunIds.add(String(event.runId));
      dropped.push(line);
    } else {
      kept.push(line);
    }
  }
  if (ids.size === 0 || dropped.length === 0) {
    return { archived: 0, remaining: eventCount, runIds: [], archive };
  }
  // Archive FIRST (append — the archive accumulates), then swap the live file.
  fs.appendFileSync(archive, `${dropped.join('\n')}\n`);
  const tmp = `${file}.archive.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  return {
    archived: dropped.length,
    remaining: eventCount - dropped.length,
    runIds: Array.from(archivedRunIds),
    archive,
  };
}

// Parse an on-disk NDJSON ledger WITHOUT constructing a log (no compaction, no
// writes) — the read-only seam archival selection uses to look at a ledger
// before its single writer exists.
function readFileEvents(filePath: any) {
  return parseNdjson(safeRead(String(filePath || '').trim()));
}

// File-backed append-only NDJSON log at filePath. Single-writer durability via
// fs.appendFileSync (see CONCURRENCY note). The optional { now } clock is only a
// default-ts fallback so module top-level stays free of Date.now.
function createFileEventLog(filePath: any, { now }: any = {}) {
  const file = String(filePath || '').trim();
  if (!file) throw new Error('event-ledger: filePath required');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Boot-time hygiene: collapse dispatch-storm repetition before seeding so a
  // polluted ledger can never again drag every readAll()-backed fold to tens
  // of seconds. Safe here: the single writer is being constructed, so nothing
  // else appends; dropped lines land in events-archive.ndjson first.
  try {
    compactFileEventLog(file);
  } catch {
    // compaction is hygiene, never a boot blocker
  }

  // Seed the counter + dedup set from what is already on disk so ids stay
  // stable and appends stay idempotent across process restarts.
  let seq = 0;
  const seen = new Set();
  for (const e of parseNdjson(safeRead(file))) {
    seen.add(String(e.id));
    seq += 1;
  }
  const deriveId = (runId: string, type: string) => `${runId}:${type}:${seq}`;

  function append(raw: any) {
    const event = prepareEvent(raw, deriveId);
    if (!event) return null;
    if (seen.has(event.id)) return null; // idempotent: same id => skip
    // Run-creation appends must own the id's reservation ('wx' taken here when
    // absent) — closes the append-side race for writers running this code.
    if (RUN_CREATION_TYPES.has(event.type) && !heldReservations.has(String(event.runId)) && !reserveRunId(event.runId)) {
      throw new Error(
        `event-ledger: run-creation append for ${event.runId} rejected — another writer owns its reservation`,
      );
    }
    if (event.ts === undefined && typeof now === 'function') event.ts = now();
    seen.add(event.id);
    seq += 1;
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    return event;
  }

  function readAll() {
    return parseNdjson(safeRead(file));
  }

  function readRun(runId: any) {
    const id = String(runId == null ? '' : runId);
    return readAll().filter((e) => String(e.runId) === id);
  }

  // Every runId this ledger has EVER seen — union of the LIVE file and the
  // sibling events-archive.ndjson. Minting reads this instead of readAll() so
  // a fresh id can never collide with an archived run's id.
  //
  // Fail closed: reads throw real IO errors (only ENOENT is empty history) —
  // an unreadable file must never look like empty history and re-mint old ids.
  function knownRunIds() {
    const ids = new Set<string>();
    const collect = (events: any[]) => {
      for (const e of events) {
        const id = e && e.runId != null ? String(e.runId).trim() : '';
        if (id) ids.add(id);
      }
    };
    const archive = path.join(path.dirname(file), 'events-archive.ndjson');
    collect(parseNdjsonStrict(strictRead(file), file));
    collect(parseNdjsonStrict(strictRead(archive), archive));
    return ids;
  }

  // Cross-process reservation: exclusive-create ('wx') sidecar per id.
  // Reservations are never deleted — a crashed claim permanently retires its
  // id (fail-closed, cheap). Non-EEXIST IO errors propagate.
  const heldReservations = new Set<string>();
  function reserveRunId(runId: any) {
    const id = String(runId == null ? '' : runId).trim();
    if (!id) return false;
    const dir = path.join(path.dirname(file), 'run-id-reservations');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, encodeURIComponent(id)), '', { flag: 'wx' });
      heldReservations.add(id);
      return true;
    } catch (err: any) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
  }

  return { append, readAll, readRun, knownRunIds, reserveRunId };
}

function safeRead(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Strict sibling of safeRead for collision-critical readers: real IO errors
// propagate (the caller must fail closed), only a missing file reads empty.
function strictRead(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

module.exports = {
  EVENT_TYPES,
  COMPACT_KEEP_LAST,
  createMemoryEventLog,
  createFileEventLog,
  compactFileEventLog,
  archiveRunEvents,
  readFileEvents,
  redactSecrets,
};
