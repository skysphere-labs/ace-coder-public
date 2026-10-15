// run-archive — the archival SELECTION policy over the run-ledger.
//
// Board hygiene: every run ever written to events.ndjson yields a board card
// forever, because the projection derives itself from ALL events. Archival is
// the physical answer — move a finished run's event lines to the sibling
// events-archive.ndjson (event-ledger.archiveRunEvents) and the projection
// simply never sees the run again. This module decides WHICH runs are safe to
// move: it reuses projection.project (the same panel bucketing the board uses,
// so selection can never disagree with what the board shows) plus each run's
// lastTs, and applies age thresholds per lifecycle bucket:
//
//   done         > DONE_AFTER_MS      (default 24h)  — terminal, merged/shipped
//   blocked      > BLOCKED_AFTER_MS   (default 48h)  — parked for a human who
//                                                      never came; the events
//                                                      stay forensic in archive
//   in_progress  > IN_PROGRESS_IDLE_MS (default 72h) — a DEAD LANE: no event in
//     three days means the worker is gone. Owner decision (PR notes): these are
//     archived AS-IS and reported under byReason.deadLanes — we never fabricate
//     ledger history (no synthetic run.blocked event). RISK (documented): the
//     archived *.dispatch.linked annotation is what keys a late completion back
//     to its run; a worker waking after archive would mint a taskId-keyed
//     phantom run. The 72h idle threshold makes that vanishingly unlikely.
//
// Runs whose age is UNKNOWN (no event carries a ts) are never auto-selected —
// fail-safe: we only archive what we can prove is old.
//
// Pure given the event log: `now` is always injected (no Date.now()/
// Math.random() at module top level — spine determinism gate). File I/O lives
// only in autoArchiveFileLedger/archiveRunEvents, both called with explicit
// paths.

// Sibling imports — .cts first so esbuild inlines it (see board-projection).
let projectionModule: any;
try {
  projectionModule = require('./projection.cts');
} catch {
  projectionModule = require('./projection.cjs');
}
const { project } = projectionModule;

let eventLedgerModule: any;
try {
  eventLedgerModule = require('./event-ledger.cts');
} catch {
  eventLedgerModule = require('./event-ledger.cjs');
}
const { archiveRunEvents, readFileEvents } = eventLedgerModule;

const HOUR_MS = 60 * 60 * 1000;

// Default age thresholds (owner decision points — see the PR body). Env
// overrides let an operator tune hygiene without a build:
//   ACE_RUN_ARCHIVE_DONE_HOURS / _BLOCKED_HOURS / _IDLE_HOURS
// and ACE_RUN_ARCHIVE=0 kills boot auto-archive entirely (harness.cts).
const DONE_AFTER_MS = 24 * HOUR_MS;
const BLOCKED_AFTER_MS = 48 * HOUR_MS;
const IN_PROGRESS_IDLE_MS = 72 * HOUR_MS;

function envHoursMs(name: string, fallbackMs: number) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallbackMs;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : fallbackMs;
}

// The effective thresholds: defaults <- env overrides <- explicit args.
function resolveThresholds(opts: any = {}) {
  return {
    doneAfterMs: Number.isFinite(Number(opts.doneAfterMs)) && Number(opts.doneAfterMs) >= 0
      ? Number(opts.doneAfterMs)
      : envHoursMs('ACE_RUN_ARCHIVE_DONE_HOURS', DONE_AFTER_MS),
    blockedAfterMs: Number.isFinite(Number(opts.blockedAfterMs)) && Number(opts.blockedAfterMs) >= 0
      ? Number(opts.blockedAfterMs)
      : envHoursMs('ACE_RUN_ARCHIVE_BLOCKED_HOURS', BLOCKED_AFTER_MS),
    inProgressIdleMs: Number.isFinite(Number(opts.inProgressIdleMs)) && Number(opts.inProgressIdleMs) >= 0
      ? Number(opts.inProgressIdleMs)
      : envHoursMs('ACE_RUN_ARCHIVE_IDLE_HOURS', IN_PROGRESS_IDLE_MS),
  };
}

function numericTs(value: any) {
  if (value == null || value === '') return null; // Number(null) is 0 — never a ts
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide which runs are safe to archive.
 *
 * @param {{ readAll: Function, readRun: Function }} eventLog
 * @param {{
 *   now: number,                    // REQUIRED — injected clock (determinism)
 *   runIds?: string[],              // explicit selection: archive exactly these
 *   terminalOnly?: boolean,         // only done+blocked buckets (no dead lanes)
 *   doneAfterMs?: number, blockedAfterMs?: number, inProgressIdleMs?: number,
 * }} opts
 * @returns {{ runIds: string[], byReason: { done: string[], blocked: string[], deadLanes: string[], explicit: string[] } }}
 */
function selectArchivableRuns(eventLog: any, opts: any = {}) {
  const byReason: any = { done: [], blocked: [], deadLanes: [], explicit: [] };
  const empty = { runIds: [], byReason };
  if (!eventLog || typeof eventLog.readAll !== 'function') return empty;

  // Explicit selection wins outright: the operator named the runs. Only runs
  // actually present in the ledger are returned (archiving a ghost is a no-op).
  if (Array.isArray(opts.runIds) && opts.runIds.length > 0) {
    const present = new Set(
      (eventLog.readAll() || [])
        .map((e: any) => (e && e.runId != null ? String(e.runId) : ''))
        .filter(Boolean),
    );
    const picked: string[] = [];
    const seen = new Set();
    for (const raw of opts.runIds) {
      const id = String(raw == null ? '' : raw).trim();
      if (!id || seen.has(id) || !present.has(id)) continue;
      seen.add(id);
      picked.push(id);
    }
    byReason.explicit = picked.slice();
    return { runIds: picked, byReason };
  }

  const now = numericTs(opts.now);
  if (now == null) return empty; // no clock, no age — never guess

  const { doneAfterMs, blockedAfterMs, inProgressIdleMs } = resolveThresholds(opts);
  const panels = project(eventLog);
  const picked: string[] = [];

  const age = (run: any) => {
    const lastTs = numericTs(run && run.lastTs);
    return lastTs == null ? null : now - lastTs;
  };

  for (const run of panels.recent || []) {
    const a = age(run);
    if (a != null && a > doneAfterMs) {
      byReason.done.push(run.runId);
      picked.push(run.runId);
    }
  }
  for (const run of panels.needsChief || []) {
    const a = age(run);
    if (a != null && a > blockedAfterMs) {
      byReason.blocked.push(run.runId);
      picked.push(run.runId);
    }
  }
  if (opts.terminalOnly !== true) {
    // Dead in_progress lanes: archived as-is (no synthetic run.blocked — never
    // fabricate history), reported separately so the operator sees them.
    for (const run of panels.active || []) {
      const a = age(run);
      if (a != null && a > inProgressIdleMs) {
        byReason.deadLanes.push(run.runId);
        picked.push(run.runId);
      }
    }
  }
  return { runIds: picked, byReason };
}

// Boot-time hygiene over an on-disk ledger, BEFORE its single writer exists
// (harness.cts calls this right before createFileEventLog — the same
// construction-window safety compaction uses). Reads the file without
// constructing a log (no compaction side-effect), selects by threshold, moves
// the selected runs' lines to events-archive.ndjson. Deterministic given
// `now`; the harness injects its clock.
function autoArchiveFileLedger(filePath: any, opts: any = {}) {
  const file = String(filePath || '').trim();
  if (!file) throw new Error('run-archive: filePath required');
  const events = readFileEvents(file);
  const eventLog = {
    readAll: () => events,
    readRun: (runId: any) => {
      const id = String(runId == null ? '' : runId);
      return events.filter((e: any) => String(e.runId) === id);
    },
  };
  const selection = selectArchivableRuns(eventLog, opts);
  if (selection.runIds.length === 0) {
    return { archived: 0, remaining: events.length, runIds: [], byReason: selection.byReason };
  }
  const result = archiveRunEvents(file, { runIds: selection.runIds, archivePath: opts.archivePath });
  return { ...result, byReason: selection.byReason };
}

module.exports = {
  DONE_AFTER_MS,
  BLOCKED_AFTER_MS,
  IN_PROGRESS_IDLE_MS,
  resolveThresholds,
  selectArchivableRuns,
  autoArchiveFileLedger,
};
