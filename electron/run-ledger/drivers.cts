// drivers — the Ring-1 effect plugs the kernel's runStep calls.
//
// The kernel asks the spine for the next action, appends a durable dispatch
// MARKER, then calls the matching driver here with { runId, state, decision,
// gate, ledger }. A driver's ONLY job is to run the real effect (injected) and
// return the event(s) the effect produced, so the kernel appends them to the
// ledger. Drivers are the loop's EFFECTS — they APPEND events; they NEVER write
// the board. The board is a read-only projection over these same events (owner
// directive: the board is a watcher, never a gate), so the loop and the board
// share one source of truth and the loop never waits on the board.
//
// Effects are INJECTED (createDrivers(effects)) so this module is pure and
// testable and the kernel stays electron-free. Wiring the effects to the live
// Ace functions (ace-control dispatch, integration-gateway merge) is the
// owner-gated full Ring-1 swap; until then these drivers compose against mocks.
//
// Two driver shapes:
//  - ASYNC DISPATCH (dispatchWorker / dispatchFixback / runValidation /
//    syncWorker): trigger an agent/validator. The kernel's marker already
//    recorded the dispatch; the eventual worker.completed / validator.completed
//    arrives later via the Ring-2 completion observer. So these return the
//    completion event ONLY when the injected effect produced one synchronously
//    (e.g. a fast/mock effect or a sync poll); otherwise null (Ring 2 appends it).
//  - SYNCHRONOUS EVAL (gatePr / release): evaluate/merge now and return the
//    resulting gate.evaluated / merged event.

function asObject(v: any) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Translate an async-dispatch effect's optional return into a completion event,
// or null when the real completion will arrive later via the Ring-2 observer.
// An effect may also hand back a ready-made { event } to append verbatim.
function dispatchResultToEvent(ret: any, completionType: string) {
  const r = asObject(ret);
  if (r.event && r.event.type) return r.event;
  // The effect reported a synchronous terminal outcome — append it now.
  if (r.outcome != null || r.record != null || r.verdict != null) {
    return { type: completionType, payload: r };
  }
  return null; // async dispatch: Ring 2 will append the completion
}

/**
 * Build the Ring-1 driver map over injected effects.
 * @param {{
 *   dispatchWorker?: Function, dispatchFixback?: Function,
 *   runValidation?: Function, syncWorker?: Function,
 *   gatePr?: Function, release?: Function, merge?: Function,
 * }} [effects]
 * @returns {Record<string, Function>} drivers keyed by the kernel's ACTION_DRIVER names
 */
function createDrivers(effects: any = {}) {
  const e = asObject(effects);
  const noop = async () => null;

  return {
    dispatchWorker: async (ctx: any) =>
      dispatchResultToEvent(await (e.dispatchWorker || noop)(ctx), 'worker.completed'),

    dispatchFixback: async (ctx: any) =>
      dispatchResultToEvent(await (e.dispatchFixback || e.dispatchWorker || noop)(ctx), 'worker.completed'),

    runValidation: async (ctx: any) =>
      dispatchResultToEvent(await (e.runValidation || noop)(ctx), 'validator.completed'),

    syncWorker: async (ctx: any) =>
      dispatchResultToEvent(await (e.syncWorker || noop)(ctx), 'worker.completed'),

    // Synchronous evaluation: the gate effect returns the PR facts; emit the
    // gate.evaluated event the reconciler folds. The fold re-runs the spine gate,
    // so this driver carries facts, not a verdict.
    gatePr: async (ctx: any) => {
      const r = asObject(await (e.gatePr || noop)(ctx));
      if (r.event && r.event.type) return r.event;
      return { type: 'gate.evaluated', payload: r };
    },

    // The release/merge effect performs the merge and returns { sha, cleanedUp,
    // headSha, ... }; emit a merged event so the run reaches the terminal state.
    release: async (ctx: any) => {
      const r = asObject(await (e.release || e.merge || noop)(ctx));
      if (r.event && r.event.type) return r.event;
      if (Object.keys(r).length) return { type: 'merged', payload: r };
      return null;
    },
  };
}

module.exports = { createDrivers };
