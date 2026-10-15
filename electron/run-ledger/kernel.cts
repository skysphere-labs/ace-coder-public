// kernel — the single Ring-0 API the rest of the app touches.
//
// acespinekernelprune.md §2: make the Run-Ledger spine THE core kernel and
// expose ONE narrow surface so every surviving feature plugs in through it and
// nothing reaches into kernel internals:
//
//   createKernel({ ledger, drivers }) -> {
//     submitIntent(intent) -> runId,   // Ring 3 command  (UI / intake)
//     recordEvent(event),              // Ring 2 entry    (event sources)
//     reconcile(runId) -> {state, decision, gate},
//     project() -> panels,             // Ring 3 read     (board / projections)
//     runStep(runId) -> {next, ran, ok, ...}  // advance one tick (calls drivers)
//   }
//
// `drivers` is the PLUG SOCKET (Ring 1) — the exact injection pattern auto-rally
// already uses (createAutoRally({ runFixback, runValidation, runRelease })). The
// kernel NEVER imports a driver; it only calls the function it was handed. This
// is also what makes concurrent multi-agent loops safe (§4): the kernel is
// stateless given the ledger and keyed by runId, so N runs reconcile with zero
// cross-talk.
//
// This module is composition only — it reuses reconciler/projection/event-ledger
// verbatim and adds NO decision logic. It is electron-free (imports only the pure
// run-ledger siblings + the pure spine), so it runs under node --test.

// Sibling imports — require the .cts SOURCE first. The build deletes stale .cjs
// before compiling, so a .cjs-first require is unresolvable at build time and
// esbuild emits a broken runtime require inside the bundle. The .cts source is
// always present: esbuild INLINES it into kernel.cjs (self-contained, no runtime
// sibling lookup) and tsx resolves it for node --test. The .cjs is kept only as
// a fallback for any consumer that ships .cjs without .cts.
let eventLedgerModule: any;
try {
  eventLedgerModule = require('./event-ledger.cts');
} catch {
  eventLedgerModule = require('./event-ledger.cjs');
}
const { EVENT_TYPES } = eventLedgerModule;

let reconcilerModule: any;
try {
  reconcilerModule = require('./reconciler.cts');
} catch {
  reconcilerModule = require('./reconciler.cjs');
}
const { reconcile } = reconcilerModule;

let projectionModule: any;
try {
  projectionModule = require('./projection.cts');
} catch {
  projectionModule = require('./projection.cjs');
}
const { project } = projectionModule;

let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS } = orchestrationPolicy;

// next-action -> driver name. The kernel asks the spine what to do next, then
// calls the matching injected driver. BLOCKED and NOTHING have no driver: the
// owner rules on a block, and NOTHING is terminal. SYNC_WORKER polls an
// in-flight worker (auto-rally's missionSyncFeature) — optional.
const ACTION_DRIVER: any = Object.freeze({
  [NEXT_ACTIONS.DISPATCH_GOAL_WORKER]: 'dispatchWorker',
  [NEXT_ACTIONS.SYNC_WORKER]: 'syncWorker',
  [NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR]: 'runValidation',
  [NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER]: 'dispatchFixback',
  [NEXT_ACTIONS.GATE]: 'gatePr',
  [NEXT_ACTIONS.DISPATCH_RELEASE_GOAL]: 'release',
});

// The dispatch MARKER event a runStep appends before calling its driver, so the
// ledger records "we started this" durably even if the driver's completion event
// arrives later (or never, on crash — replay resumes from the marker).
const ACTION_MARKER: any = Object.freeze({
  [NEXT_ACTIONS.DISPATCH_GOAL_WORKER]: EVENT_TYPES.WORKER_DISPATCHED,
  [NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR]: EVENT_TYPES.VALIDATOR_DISPATCHED,
  [NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER]: EVENT_TYPES.FIXBACK_DISPATCHED,
});

// The FAIL-CLOSED counterpart to ACTION_MARKER. The marker says "we started the
// dispatch" (durable-first, so a crash mid-dispatch is replayable). But a driver
// is the real external boundary — when it THROWS (spawn failed, no stream
// created, link not recorded), the marker alone is a lie: the board would report
// a healthy in-flight worker that never existed. So on a driver throw we append
// the matching failure event, carrying the exact error, and the reconciler folds
// it back to a BLOCKED decision (dispatch_failed) instead of a phantom dispatch.
const ACTION_FAILURE: any = Object.freeze({
  [NEXT_ACTIONS.DISPATCH_GOAL_WORKER]: EVENT_TYPES.WORKER_DISPATCH_FAILED,
  [NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER]: EVENT_TYPES.WORKER_DISPATCH_FAILED,
  [NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR]: EVENT_TYPES.VALIDATOR_DISPATCH_FAILED,
});

// The POSITIVE proof a dispatch must produce to count as real. #507 made a
// driver THROW fail closed (ACTION_FAILURE). But a driver can also return
// WITHOUT throwing yet WITHOUT linking anything — a dry/no-op effect, or an
// async spawn that never recorded a stream — which leaves the durable marker
// standing alone as a phantom "worker.dispatched" run with null stream/task/
// worktree and no stream in `ace ls` (exactly the brief's bad shape). The
// real spine-effects append `*.dispatch.linked` SYNCHRONOUSLY before returning
// (a fast/sync effect instead appends the completion), so after a genuine
// dispatch step at least one of these proof events is on the run's ledger slice.
// Their ABSENCE means no Ace-visible worker was actually linked → the kernel
// fails closed the same way a throw does (records ACTION_FAILURE), so the run
// reconciles to BLOCKED (dispatch_failed) instead of floating in_progress.
const ACTION_LINK_PROOF: any = Object.freeze({
  [NEXT_ACTIONS.DISPATCH_GOAL_WORKER]: [EVENT_TYPES.WORKER_DISPATCH_LINKED, EVENT_TYPES.WORKER_COMPLETED],
  [NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER]: [EVENT_TYPES.WORKER_DISPATCH_LINKED, EVENT_TYPES.WORKER_COMPLETED],
  [NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR]: [EVENT_TYPES.VALIDATOR_DISPATCH_LINKED, EVENT_TYPES.VALIDATOR_COMPLETED],
});

// Did the dispatch step append linkage/completion proof? Scans only the events
// added from `beforeLen` onward (the marker the kernel wrote + anything the
// effect appended this step), so a stale proof from an earlier attempt cannot
// mask a phantom re-dispatch.
function dispatchHasProof(ledger: any, runId: string, beforeLen: number, proofTypes: string[]) {
  const events = ledger.readRun(runId);
  for (let i = Math.max(0, beforeLen); i < events.length; i += 1) {
    const e = events[i];
    if (e && proofTypes.indexOf(e.type) !== -1) return true;
  }
  return false;
}

function distinctRunIds(events: any[]) {
  const seen = new Set<string>();
  for (const e of Array.isArray(events) ? events : []) {
    const id = e && e.runId != null ? String(e.runId) : '';
    if (id) seen.add(id);
  }
  return seen;
}

// Append an event/array of events returned by a driver. Drivers may instead
// append directly via the ledger handed to them; both are supported. Non-event
// return values (or null) are ignored.
function appendDriverEvents(ledger: any, runId: string, ret: any) {
  const appended: any[] = [];
  const list = Array.isArray(ret) ? ret : ret ? [ret] : [];
  for (const item of list) {
    if (item && typeof item === 'object' && item.type) {
      const evt = ledger.append({ runId, ...item });
      if (evt) appended.push(evt);
    }
  }
  return appended;
}

/**
 * Build the kernel over an injected event ledger and driver socket.
 *
 * @param {{ ledger: { append:Function, readAll:Function, readRun:Function },
 *           drivers?: Record<string, Function> }} args
 */
function createKernel({ ledger, drivers = {} }: any = {}) {
  if (!ledger || typeof ledger.append !== 'function' || typeof ledger.readAll !== 'function' || typeof ledger.readRun !== 'function') {
    throw new Error('createKernel: ledger with append/readAll/readRun is required');
  }

  // Mint over every id the ledger has EVER seen (live + archive), allocating
  // max(numeric suffix)+1 — count+1 re-mints an existing id once archival makes
  // the id space sparse. Deterministic: no Date.now / Math.random.
  // Guarantee scope: collision-proof among writers running this ledger code
  // (the append boundary enforces reservation); legacy binaries are outside it.
  function knownIds(): Set<string> {
    return typeof (ledger as any).knownRunIds === 'function'
      ? (ledger as any).knownRunIds()
      : distinctRunIds(ledger.readAll());
  }

  function mintRunId() {
    const known: Set<string> = knownIds();
    // BigInt: Number suffix math stops advancing past MAX_SAFE_INTEGER.
    let max = 0n;
    for (const id of known) {
      const m = /^run-(\d+)$/.exec(id);
      if (m) {
        const n = BigInt(m[1]);
        if (n > max) max = n;
      }
    }
    // Reserve-and-recheck: read-compute-append is not atomic across processes;
    // the post-reservation recheck covers writers that append without reserving.
    const canReserve = typeof (ledger as any).reserveRunId === 'function';
    for (;;) {
      const candidate = `run-${max + 1n}`;
      max += 1n;
      if (known.has(candidate)) continue;
      if (!canReserve) return candidate;
      if (!(ledger as any).reserveRunId(candidate)) continue;
      if (knownIds().has(candidate)) continue;
      return candidate;
    }
  }

  // Ring 3 command: seed a NEW run from an intake intent; returns its runId.
  // submitIntent must never append into an existing run's slice — explicit ids
  // are rejected when known anywhere in live or archived history.
  function submitIntent(intent: any = {}) {
    const spec = intent && typeof intent === 'object' ? intent : {};
    // Trim to match the ledger's append-boundary trim, or "run-1 " would slip
    // the guard and land on the existing run-1 slice.
    const suppliedId = spec.runId != null ? spec.runId : spec.id;
    const explicit = suppliedId != null ? String(suppliedId).trim() : '';
    // A supplied id that trims to empty is invalid input — never silently mint.
    if (suppliedId != null && !explicit) {
      throw new Error(
        'kernel: explicit runId is empty or whitespace-only — supply a real id or omit it to mint one',
      );
    }
    if (explicit && knownIds().has(explicit)) {
      throw new Error(
        `kernel: runId ${explicit} already exists (live or archived) — submitIntent never appends into an existing run; pick a different id`,
      );
    }
    // Explicit ids take the same atomic reservation as minted ones.
    if (
      explicit &&
      typeof (ledger as any).reserveRunId === 'function' &&
      !(ledger as any).reserveRunId(explicit)
    ) {
      throw new Error(
        `kernel: runId ${explicit} is already reserved (a concurrent submission or a crashed prior claim) — submitIntent never appends into another claimant's run; pick a different id`,
      );
    }
    // Recheck after reserving: reservation cannot exclude a non-reserving
    // writer that appended this id inside the check→reserve window.
    if (explicit && knownIds().has(explicit)) {
      throw new Error(
        `kernel: runId ${explicit} was appended by another writer during submission — submitIntent never appends into an existing run; pick a different id`,
      );
    }
    const runId = explicit || mintRunId();
    const ts = spec.ts;
    ledger.append({ runId, ts, type: EVENT_TYPES.INTENT_CREATED, payload: { intent: spec } });
    ledger.append({
      runId,
      ts,
      type: EVENT_TYPES.RUN_CREATED,
      payload: { spec, risk: spec.risk || 'low' },
    });
    return runId;
  }

  // Ring 2 entry: append a world->kernel event (completion observer, CI/PR
  // status). Idempotent + validated by the ledger.
  function recordEvent(event: any) {
    return ledger.append(event);
  }

  // Reconcile one run from its event slice only (keyed by runId -> safe under
  // concurrency). Pass-through to the reconciler facade.
  function reconcileRun(runId: any, deps: any = {}) {
    return reconcile(runId, ledger, deps);
  }

  // Ring 3 read: the six owner panels.
  function projectPanels() {
    return project(ledger);
  }

  // Advance ONE tick for a run: reconcile -> pick the driver for the next action
  // -> append the dispatch marker (durable-first) -> call the driver -> append
  // whatever event(s) it returns. Owner/terminal actions (BLOCKED / NOTHING) run
  // no driver. Pure-ish: all effects go through the injected drivers + ledger.
  //
  // opts.force: a caller-supplied decision object (human-invoked, e.g. the
  // Skysphere review fixback) used INSTEAD of the reconciled decision. It flows
  // through the SAME durable-marker + link-proof + fail-closed machinery below.
  // Forcing while the worker lane is in flight fails closed (a forced dispatch
  // then would double-dispatch the run's worker) — use the live stream instead.
  async function runStep(runId: any, opts: any = {}) {
    let reconciled = reconcile(runId, ledger);
    if (reconciled.decision?.next === NEXT_ACTIONS.DISPATCH_RELEASE_GOAL) {
      reconciled = reconcile(runId, ledger, { wantGate: true });
    }
    const { state, gate, autoship } = reconciled;
    const force = opts && opts.force && typeof opts.force === 'object' ? opts.force : null;
    if (force) {
      const worker = (state && state.worker) || {};
      // `dispatched && !done` covers an in-flight ORIGINAL worker only:
      // worker.done stays true after the first completion and a fixback
      // re-dispatch never resets it, so an in-flight FIXBACK worker (the only
      // worker that can be in flight at review-fixback time) is visible solely
      // through the reconciler's fixbackInFlight flag. Check both, or a second
      // force would double-dispatch on the same branch/worktree lineage.
      if ((worker.dispatched && !worker.done) || worker.fixbackInFlight) {
        return {
          runId: String(runId), next: force.next, reason: force.reason, gate, autoship,
          ran: null, ok: false, error: 'worker in flight — use the live stream', appended: [],
        };
      }
    }
    const decision = force || reconciled.decision;
    const next = decision && decision.next;
    const driverName = ACTION_DRIVER[next];
    const result: any = { runId: String(runId), next, reason: decision && decision.reason, gate, autoship, ran: null, ok: true, appended: [] };

    if (!driverName) return result; // BLOCKED (owner) or NOTHING (terminal)
    const driver = drivers[driverName];
    if (typeof driver !== 'function') {
      // No driver wired for this action: surface it without inventing effects.
      result.ran = null;
      result.skipped = driverName;
      return result;
    }

    // Durable-first: record the dispatch marker before the effect runs. Capture
    // the run's length first so the fail-closed linkage check below only inspects
    // events appended during THIS step.
    const markerType = ACTION_MARKER[next];
    const beforeLen = markerType ? ledger.readRun(String(runId)).length : 0;
    if (markerType) ledger.append({ runId: String(runId), type: markerType, payload: {} });

    result.ran = driverName;
    try {
      const ret = await driver({ runId: String(runId), state, decision, gate, ledger });
      result.appended = appendDriverEvents(ledger, String(runId), ret);
      // FAIL-CLOSED LINKAGE: a dispatch action must produce concrete linkage (the
      // effect appends *.dispatch.linked synchronously) or a synchronous
      // completion. If the driver returned without throwing yet NOTHING proved a
      // real, Ace-visible worker was created/linked, the durable marker alone
      // is a phantom "dispatched" run (null stream/task/worktree). Record the same
      // fail-closed counterpart a throw would, so the reconciler routes the run to
      // BLOCKED (dispatch_failed) with a clear error instead of leaving it
      // floating in_progress with a lone worker.dispatched. (See ACTION_LINK_PROOF.)
      const proofTypes = ACTION_LINK_PROOF[next];
      if (proofTypes && !dispatchHasProof(ledger, String(runId), beforeLen, proofTypes)) {
        result.ok = false;
        result.error = `dispatch produced no linked stream/task/worktree (no ${proofTypes.join(' or ')} event)`;
        const failureType = ACTION_FAILURE[next];
        if (failureType) {
          const evt = ledger.append({
            runId: String(runId),
            type: failureType,
            payload: { error: result.error, action: next },
          });
          if (evt) result.appended.push(evt);
        }
      }
    } catch (err: any) {
      // Drivers are the real (external) boundary. If the driver already linked a
      // real stream/task in this step, keep the run in-flight; otherwise fail
      // closed so a durable marker alone never looks like a healthy dispatch.
      const error = err && err.message ? String(err.message) : String(err);
      const proofTypes = ACTION_LINK_PROOF[next];
      if (proofTypes && dispatchHasProof(ledger, String(runId), beforeLen, proofTypes)) {
        result.warning = `dispatch linked before driver error: ${error}`;
        return result;
      }
      result.ok = false;
      result.error = error;
      const failureType = ACTION_FAILURE[next];
      if (failureType) {
        try {
          const evt = ledger.append({
            runId: String(runId),
            type: failureType,
            payload: { error, action: next },
          });
          if (evt) result.appended.push(evt);
        } catch { /* ledger append is the last line of defense; nothing else to do */ }
      }
    }
    return result;
  }

  return {
    submitIntent,
    recordEvent,
    reconcile: reconcileRun,
    project: projectPanels,
    runStep,
    // expose the ledger for event sources that prefer to append directly
    ledger,
  };
}

module.exports = {
  createKernel,
  ACTION_DRIVER,
  ACTION_MARKER,
  ACTION_FAILURE,
};
