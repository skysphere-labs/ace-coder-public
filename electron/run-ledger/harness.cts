// harness — the ONE composition that wires the whole Run-Ledger spine into a
// single object: event ledger + kernel (Ring 0) + Ring-1 drivers + the loop
// driver. This is the single seam the rest of Ace (the CLI, the controller,
// a future loop engine) plugs into, so there is exactly one place that knows how
// the pieces fit together — "one harness, one CLI".
//
//   createRunLedgerHarness({ ledger | ledgerPath, effects, now }) -> {
//     kernel, ledger,
//     submit(intent) -> runId,            // intake (Ring 3 command)
//     step(runId) -> stepResult,          // advance one tick (calls a driver)
//     runToQuiescence(runId, opts) -> [],  // drive until blocked/nothing/no-driver
//     board() -> lean read-only board,    // the watcher view (zero side-effects)
//     project() -> six owner panels,
//   }
//
// The loop (step / runToQuiescence) appends events through the drivers; the
// board() read is a pure projection over those same events. The loop NEVER reads
// or waits on board() — they only share the ledger. Electron-free: composes the
// pure run-ledger siblings + the injected effects, so it runs under node --test.

let eventLedgerModule: any;
try {
  eventLedgerModule = require('./event-ledger.cts');
} catch {
  eventLedgerModule = require('./event-ledger.cjs');
}
const { createFileEventLog, createMemoryEventLog } = eventLedgerModule;

let kernelModule: any;
try {
  kernelModule = require('./kernel.cts');
} catch {
  kernelModule = require('./kernel.cjs');
}
const { createKernel } = kernelModule;

let driversModule: any;
try {
  driversModule = require('./drivers.cts');
} catch {
  driversModule = require('./drivers.cjs');
}
const { createDrivers } = driversModule;

let boardModule: any;
try {
  boardModule = require('./board-projection.cts');
} catch {
  boardModule = require('./board-projection.cjs');
}
const { projectLeanBoard } = boardModule;

let runArchiveModule: any;
try {
  runArchiveModule = require('./run-archive.cts');
} catch {
  runArchiveModule = require('./run-archive.cjs');
}
const { selectArchivableRuns, autoArchiveFileLedger, resolveThresholds } = runArchiveModule;

const { archiveRunEvents } = eventLedgerModule;

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {{
 *   ledger?: object, ledgerPath?: string, effects?: object,
 *   now?: () => any,
 * }} [args]
 */
function createRunLedgerHarness(args: any = {}) {
  const ledgerPath = args.ledger ? null : args.ledgerPath || null;
  const clock = () => {
    const t = typeof args.now === 'function' ? Number(args.now()) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  };
  // Boot-time BOARD HYGIENE: move long-finished runs (done > 24h, blocked >
  // 48h, dead in_progress lanes idle > 72h — env-overridable, see run-archive)
  // out of the live ledger BEFORE the single writer is constructed — the same
  // construction-window safety compaction relies on ("nothing else appends
  // yet"). Ordering matters: archive first, THEN createFileEventLog (whose
  // constructor still compacts what remains). Threshold-gated + env kill
  // (ACE_RUN_ARCHIVE=0) and guarded — hygiene is never a boot blocker.
  if (ledgerPath && process.env.ACE_RUN_ARCHIVE !== '0') {
    try {
      autoArchiveFileLedger(ledgerPath, { now: clock() });
    } catch {
      // archival is hygiene, never a boot blocker
    }
  }
  const ledger =
    args.ledger ||
    (ledgerPath ? createFileEventLog(ledgerPath, { now: args.now }) : createMemoryEventLog());
  const drivers = createDrivers(args.effects || {});
  const kernel = createKernel({ ledger, drivers });

  function submit(intent: any) {
    return kernel.submitIntent(intent);
  }

  function step(runId: any) {
    return kernel.runStep(runId);
  }

  // Drive a single run forward until it reaches a state with no driver to call:
  // BLOCKED (owner rules), NOTHING (terminal), or an unwired action (skipped).
  // Bounded by maxSteps and by progress: if a step neither runs a driver nor
  // appends an event, stop (avoids spinning on a stuck async dispatch). Returns
  // the ordered step results. This is the autonomy loop over one run.
  async function runToQuiescence(runId: any, opts: any = {}) {
    const maxSteps = Number(opts.maxSteps) || 24;
    const results: any[] = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const r = await step(runId);
      results.push(r);
      if (!r.ran) break; // no driver for this action (blocked / nothing / skipped)
      if (r.ok === false) break; // driver threw — leave the run reconcilable
      // No-progress guard: a driver that appended NO event did not advance the
      // run, so the next reconcile would pick the same action and spin. Stop and
      // let the next external pulse re-arm the loop. This covers BOTH an async
      // dispatch waiting on the Ring-2 completion (marker written, no completion
      // yet) AND a fail-closed park (e.g. release without an owner token emits no
      // `merged`) — re-running either in a tight loop only burns cycles.
      if (r.appended == null || r.appended.length === 0) break;
    }
    return results;
  }

  function board() {
    // Pass the clock so cards can carry descriptive age/idle durations; the
    // projection itself stays a pure read (now is data, not a side-effect).
    return projectLeanBoard(ledger, { now: typeof args.now === 'function' ? clock() : null });
  }

  function project() {
    return kernel.project();
  }

  // Archive runs out of the live file ledger. Selectors: explicit runIds, or
  // threshold selection (terminal limits to done+blocked; olderThanHours
  // overrides every bucket threshold). dryRun reports the selection without
  // moving anything. Safe under the live appender: all ledger I/O in this
  // process is synchronous, readAll() re-reads the file per call, and the
  // appender's `seen` id set still dedups re-appends of archived ids. Throws
  // for memory ledgers — there is no file to move lines between.
  function archive(opts: any = {}) {
    if (!ledgerPath) throw new Error('run archive requires a file-backed ledger');
    const now = opts.now != null && Number.isFinite(Number(opts.now)) ? Number(opts.now) : clock();
    const olderThanMs = Number(opts.olderThanHours) > 0 ? Number(opts.olderThanHours) * HOUR_MS : null;
    const thresholds = resolveThresholds(
      olderThanMs != null
        ? { doneAfterMs: olderThanMs, blockedAfterMs: olderThanMs, inProgressIdleMs: olderThanMs }
        : {},
    );
    const selection = selectArchivableRuns(ledger, {
      now,
      runIds: Array.isArray(opts.runIds) && opts.runIds.length ? opts.runIds : undefined,
      terminalOnly: opts.terminal === true,
      ...thresholds,
    });
    if (opts.dryRun === true || selection.runIds.length === 0) {
      return {
        ok: true,
        dryRun: opts.dryRun === true,
        archived: 0,
        remaining: ledger.readAll().length,
        runIds: selection.runIds,
        byReason: selection.byReason,
      };
    }
    const result = archiveRunEvents(ledgerPath, { runIds: selection.runIds });
    return { ok: true, dryRun: false, ...result, byReason: selection.byReason };
  }

  return { kernel, ledger, ledgerPath, submit, step, runToQuiescence, board, project, archive };
}

module.exports = { createRunLedgerHarness };
