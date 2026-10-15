// coalesce — leading+trailing throttle for main-thread event storms.
//
// The state pipeline's contract: an ISOLATED call runs immediately (zero
// perceived latency on a user mutation), a BURST collapses to the leading call
// plus at most one trailing call per window, and the trailing call always runs
// after the last burst member (the final state is never dropped). This is the
// same shape as local-core's state:invalidate throttle; extracted so direct
// emitState() callers (41 sites) share one tested implementation instead of
// each site inventing its own timing.
//
// Error semantics: the LEADING call propagates exceptions to the caller
// (unchanged behavior for direct call sites); the TRAILING call runs on a
// timer with no caller to throw to, so it swallows via the onError hook
// (default: silent) rather than crashing the process.

function createCoalescer(fn: () => void, windowMs: number, opts: { onError?: (err: unknown) => void } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const arm = () => {
    timer = setTimeout(flushTrailing, windowMs);
    // Never keep the process alive just to deliver a trailing state emit.
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
  };

  const flushTrailing = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    try {
      fn();
    } catch (err) {
      try { opts.onError?.(err); } catch { /* never throw from a timer */ }
    }
    arm();
  };

  return {
    /** Leading edge if idle; otherwise mark dirty for the trailing flush. */
    call() {
      if (timer) {
        pending = true;
        return;
      }
      try {
        fn();
      } finally {
        arm();
      }
    },
    /** True while a trailing call is owed. */
    pending() {
      return pending;
    },
    /** Cancel any owed trailing call (shutdown path). */
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}

module.exports = { createCoalescer };
