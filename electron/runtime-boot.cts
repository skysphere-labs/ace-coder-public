// Failure-safe orchestration of the heavy-runtime construction sequence (store,
// controllers, bridges, remote server, IPC). Lifted out of main.cts so the central
// boot-enforcement contract is unit-testable with injected fakes. Contract:
//   - boot() runs the constructors IN ORDER, then registerIpc, then declares booted.
//   - `booted` flips true ONLY after the full sequence succeeds — never before — so a
//     constructor throw can't leave the app claiming ready over a broken shell.
//   - a throw from any step: loud log, best-effort teardownPartial(), an HONEST
//     `boot-error` readiness broadcast (never `ready`), and { ok:false }. The caller keeps
//     the renderer on a recoverable startup screen.
//   - idempotent: a second boot() after success is a no-op (each constructor +
//     registerIpc runs at most once).
// No Electron imports — pure, so main.cts remains the only place wiring the real deps.

export type RuntimeConstructor = { name: string; run: () => void };
export type RuntimeBootResult =
  | { ok: true; status: 'ready'; alreadyBooted?: boolean }
  | { ok: false; status: 'boot-error'; failedAt: string; error: any; reason: string };

function createRuntimeBoot(opts: {
  constructors: Array<RuntimeConstructor>;
  registerIpc: () => void;
  broadcast: (channel: string, payload: any) => void;
  teardownPartial?: () => void | Promise<void>;
  logger?: { log?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
}) {
  const logger = opts.logger ?? console;
  let booted = false;
  let inFlight: Promise<RuntimeBootResult> | null = null;

  async function fail(failedAt: string, error: any): Promise<RuntimeBootResult> {
    // Log LOUDLY — a boot failure must never be a silent catch.
    logger.error?.(`[ace] runtime boot FAILED at "${failedAt}":`, (error && (error.stack || error.message)) || error);
    // AWAIT the best-effort teardown of partial construction — a retry must never
    // reconstruct against an in-flight teardown (aceStore.shutdown() is async).
    try { await opts.teardownPartial?.(); } catch (e: any) { logger.warn?.('[ace] partial-boot teardown failed:', (e && e.message) || e); }
    const message = error && error.message ? String(error.message) : String(error);
    const reason = `boot-error: ${message}`;
    // Honest readiness state — NEVER `ready`. Renderer stays on a recoverable screen.
    try { opts.broadcast('ace:runtime-changed', { status: 'boot-error', reason, boot: { failedAt } }); } catch {}
    return { ok: false, status: 'boot-error', failedAt, error, reason };
  }

  async function runOnce(): Promise<RuntimeBootResult> {
    for (const c of opts.constructors) {
      try { c.run(); }
      catch (error: any) { return await fail(c.name, error); }
    }
    try { opts.registerIpc(); }
    catch (error: any) { return await fail('register-ipc', error); }
    booted = true; // ONLY after the full sequence + IPC registration succeed.
    try {
      opts.broadcast('ace:runtime-changed', {
        status: 'ready',
      });
    } catch {}
    return { ok: true, status: 'ready' };
  }

  // Serialize the whole lifecycle (one op at a time): a re-entrant boot() — e.g. a
  // retry racing an in-flight teardown — WAITS for the current attempt (constructors +
  // registerIpc + any teardownPartial) to fully settle before running anything, so
  // constructors never execute concurrently with a teardown.
  async function boot(): Promise<RuntimeBootResult> {
    while (inFlight) { try { await inFlight; } catch {} }
    if (booted) return { ok: true, status: 'ready', alreadyBooted: true };
    const p = runOnce();
    inFlight = p;
    try { return await p; } finally { if (inFlight === p) inFlight = null; }
  }

  return { boot, isBooted: () => booted };
}

module.exports = { createRuntimeBoot };
