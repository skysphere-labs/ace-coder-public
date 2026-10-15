// LRU budget for live WebGL contexts. Chromium hard-caps ~16 per renderer
// process and silently evicts past it (3s context-not-restored stall, then
// the victim — often a visible terminal — falls to the slow DOM renderer).
// This pool keeps the count deterministically under that cap: over budget it
// retires OUR least-recently-acquired holder via the destroy hook instead of
// letting Chromium pick a victim. Pure data structure so the eviction rules
// are unit-testable without xterm or a GPU (terminal-webgl-pool.test.ts).

export interface WebglPoolHooks<S> {
  /** Build + attach a context for the session. False/throw = no slot taken. */
  create(session: S): boolean;
  /** Dispose the session's context (and force-lose it so the slot frees now). */
  destroy(session: S): void;
}

export function createWebglPool<S>(max: number, hooks: WebglPoolHooks<S>) {
  const lru: S[] = [];

  function drop(session: S) {
    const i = lru.indexOf(session);
    if (i >= 0) lru.splice(i, 1);
  }

  const pool = {
    holders: (): readonly S[] => [...lru],
    size: () => lru.length,
    has: (session: S) => lru.includes(session),

    /**
     * Give the session a context, retiring LRU holders first if the pool is
     * full. Re-acquiring an existing holder just bumps it to most-recent.
     * Returns whether the session holds a context afterwards.
     */
    acquire(session: S): boolean {
      if (pool.has(session)) {
        drop(session);
        lru.push(session);
        return true;
      }
      while (lru.length >= max) pool.release(lru[0]);
      let created = false;
      try {
        created = hooks.create(session);
      } catch {
        created = false;
      }
      if (created) lru.push(session);
      return created;
    },

    /** Retire a holder's context. No-op (idempotent) for non-holders. */
    release(session: S) {
      if (!pool.has(session)) return;
      drop(session);
      try {
        hooks.destroy(session);
      } catch {}
    },

    /**
     * The context died on its own (GPU reset, OS eviction): vacate the slot
     * WITHOUT calling destroy — there is nothing left to dispose.
     */
    forget(session: S) {
      drop(session);
    },
  };
  return pool;
}
