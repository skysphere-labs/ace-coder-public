// Fail-closed detached-agent teardown (Sky front door A3).
//
// On sign-out / seat-revoke, a signed-out user must retain NO running agents —
// including host-backed detached PTYs. An AUTH teardown ALWAYS force-terminates
// the detached host PROCESS by its reported PID (after a best-effort graceful kill
// of the REGISTERED streams), because the registry is not a reliable enumeration
// of what the daemon is running — adoption can fail or be partial, so a survivor
// may never register at all. Deps are injected so the paths are deterministic.

// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
import { expect, test } from 'vitest';

const { terminateDetachedHost, terminatePreservedDetachedHost, makeHostIdentityGuard, discoverSurvivorHostPid } = require('../local-core.cts');
const { denyRequiresTeardown } = require('../front-door.cts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDetachedEnabled(fn) {
  const prev = process.env.ACE_DETACHED_AGENTS;
  delete process.env.ACE_DETACHED_AGENTS; // default = enabled
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (prev === undefined) delete process.env.ACE_DETACHED_AGENTS; else process.env.ACE_DETACHED_AGENTS = prev; });
}

test('acknowledged registered kills → still ALWAYS terminates the host', async () => {
  const killed = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [Promise.resolve(), Promise.resolve()],
    hostPid: 4242,
    timeoutMs: 1000,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
  });
  // Even when every registered kill acked, the host is terminated — an unadopted
  // survivor never appears in pendingKills, so acks alone don't prove the daemon
  // is clean.
  expect(outcome).toBe('terminated');
  expect(killed).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
});

test('ZERO registered kills (unregistered survivors) → host is STILL terminated', async () => {
  // The round-9 gap: adoption failed, so killAll() saw no streams and pendingKills
  // is empty — but the daemon may still hold survivors. Terminate the host anyway.
  const killed = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: 4242,
    timeoutMs: 1000,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
  });
  expect(outcome).toBe('terminated');
  expect(killed).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
});

test('a hung/rejected registered kill cannot stall teardown — host still terminated', async () => {
  const killed = [];
  const outcome = await terminateDetachedHost({
    // One never-settles, one rejects (connection loss) — neither may block the
    // bounded graceful phase, and the host kill still runs.
    pendingKills: [new Promise(() => {}), Promise.reject(new Error('pty-host connection lost'))],
    hostPid: 4242,
    timeoutMs: 5,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
  });
  expect(outcome).toBe('terminated');
  expect(killed).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
});

// ensureConnected RACE: the killDetached teardown must discover the survivor PID with a
// SURVIVOR-ONLY connect that never spawns — a lingering ensureConnected() could spawn a
// daemon that outlives sign-out. And the bounded race must leave no live host when it wins.

test('survivor PID discovery uses connectExisting only — never ensureConnected/spawn (timeout-wins → no pid)', async () => {
  let ensureCalls = 0;
  let connectCalls = 0;
  const ptyHost = {
    hostPid: () => null, // not learned yet
    ensureConnected: async () => { ensureCalls += 1; return []; }, // would SPAWN — must NOT be called
    connectExisting: () => { connectCalls += 1; return new Promise(() => {}); }, // hangs → timeout wins
  };
  const pid = await discoverSurvivorHostPid(ptyHost, 5, sleep);
  expect(ensureCalls).toBe(0);   // never the spawn path
  expect(connectCalls).toBe(1);  // survivor-only connect
  expect(pid).toBe(null);        // timeout won → no live host discovered → nothing to kill/spawn
});

test('survivor PID discovery returns the survivor pid when connectExisting finds one', async () => {
  const ptyHost = {
    _pid: null,
    hostPid() { return this._pid; },
    connectExisting() { this._pid = 7777; return Promise.resolve([]); }, // survivor answered hello
    ensureConnected: async () => { throw new Error('must never spawn on the teardown path'); },
  };
  const pid = await discoverSurvivorHostPid(ptyHost, 1000, sleep);
  expect(pid).toBe(7777);
});

test('survivor PID discovery short-circuits when the pid is already known (no connect at all)', async () => {
  let connectCalls = 0;
  const ptyHost = { hostPid: () => 4242, connectExisting: () => { connectCalls += 1; return Promise.resolve([]); } };
  const pid = await discoverSurvivorHostPid(ptyHost, 1000, sleep);
  expect(pid).toBe(4242);
  expect(connectCalls).toBe(0);
});

// PID-REUSE SAFETY: a raw numeric pid can be reused by the OS after the daemon exits.
// terminateDetachedHost must NOT blind-SIGKILL — it identity-verifies before each signal
// and prefers a retained ChildProcess handle.

test('SIGKILL is skipped when the pid identity no longer matches after SIGTERM (no blind-kill)', async () => {
  const killed = [];
  let checks = 0;
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: 4242,
    timeoutMs: 5,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
    // Ours before SIGTERM; gone/reused before the SIGKILL escalation.
    verifyIdentity: () => { checks += 1; return checks === 1; },
    logger: { warn: () => {} },
  });
  expect(outcome).toBe('terminated-graceful');
  expect(killed).toEqual([[4242, 'SIGTERM']]); // SIGTERM landed, SIGKILL skipped
});

test('identity gone BEFORE any signal → nothing is sent at all', async () => {
  const killed = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: 4242,
    timeoutMs: 5,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
    verifyIdentity: () => false,
    logger: { warn: () => {} },
  });
  expect(outcome).toBe('no-host');
  expect(killed).toEqual([]);
});

test('escalation STILL fires when identity matches throughout', async () => {
  const killed = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: 4242,
    timeoutMs: 5,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
    verifyIdentity: () => true,
  });
  expect(outcome).toBe('terminated');
  expect(killed).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
});

test('a retained ChildProcess handle is killed directly — the raw pid is never signalled', async () => {
  const handleSignals = [];
  const pidKills = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: 4242,
    timeoutMs: 5,
    kill: (pid, sig) => pidKills.push([pid, sig]),
    sleep,
    childHandle: { kill: (sig) => handleSignals.push(sig) },
    verifyIdentity: () => { throw new Error('must not consult pid identity when a handle is present'); },
  });
  expect(outcome).toBe('terminated');
  expect(handleSignals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(pidKills).toEqual([]);
});

test('makeHostIdentityGuard: matches only when alive AND the signature is unchanged', () => {
  // Signature captured at adopt time = 'sig-A'. Later the pid may be dead, reused
  // (different signature), or still ours (same signature + alive).
  const guardStillOurs = makeHostIdentityGuard(4242, { readSignature: () => 'sig-A', isAlive: () => true });
  expect(guardStillOurs(4242)).toBe(true);

  const guardDead = makeHostIdentityGuard(4242, { readSignature: () => 'sig-A', isAlive: () => false });
  expect(guardDead(4242)).toBe(false); // not alive → not ours

  let n = 0;
  const guardReused = makeHostIdentityGuard(4242, {
    readSignature: () => (n++ === 0 ? 'sig-A' : 'sig-B'), // captured sig-A, now reads sig-B (reused pid)
    isAlive: () => true,
  });
  expect(guardReused(4242)).toBe(false); // signature changed → foreign process

  const guardUnknown = makeHostIdentityGuard(4242, { readSignature: () => '', isAlive: () => true });
  expect(guardUnknown(4242)).toBe(false); // could not capture identity → fail closed
});

test('no known host PID → nothing is killed (never a stray signal)', async () => {
  const killed = [];
  const outcome = await terminateDetachedHost({
    pendingKills: [],
    hostPid: null,
    timeoutMs: 5,
    kill: (pid, sig) => killed.push([pid, sig]),
    sleep,
  });
  expect(outcome).toBe('no-host');
  expect(killed).toEqual([]);
});

// R-1: an account revoked while Ace was CLOSED. The next launch is denied at the
// front door and the heavy runtime never boots — so the boot deny-path teardown
// (terminatePreservedDetachedHost) must find and kill the prior session's
// preserved detached host directly, WITHOUT spawning a fresh daemon.

test('confirmed deny at boot: a survivor detached host is terminated by PID', async () => {
  await withDetachedEnabled(async () => {
    const killed = [];
    let closed = 0;
    const client = {
      // A survivor daemon answered `hello` (empty adopted-stream list is fine —
      // the host-PID kill takes every PTY it holds, registered or not).
      connectExisting: async () => [],
      hostPid: () => 5150,
      close: () => { closed += 1; },
    };
    const outcome = await terminatePreservedDetachedHost({
      userDataPath: '/tmp/ace-boot-deny',
      createClient: () => client,
      kill: (pid, sig) => killed.push([pid, sig]),
      sleep,
      timeoutMs: 10,
      makeIdentityGuard: () => () => true, // identity confirmed throughout — test the kill path
    });
    expect(outcome).toBe('terminated');
    expect(killed).toEqual([[5150, 'SIGTERM'], [5150, 'SIGKILL']]);
    expect(closed).toBe(1); // the throwaway client is always closed
  });
});

test('no survivor host at boot: nothing killed and NO daemon is spawned', async () => {
  await withDetachedEnabled(async () => {
    const killed = [];
    let spawned = false;
    const client = {
      connectExisting: async () => null, // no daemon listening
      hostPid: () => null,
      ensureConnected: async () => { spawned = true; return null; }, // must NOT be called
      close: () => {},
    };
    const outcome = await terminatePreservedDetachedHost({
      userDataPath: '/tmp/ace-boot-deny',
      createClient: () => client,
      kill: (pid, sig) => killed.push([pid, sig]),
      sleep,
    });
    expect(outcome).toBe('no-host');
    expect(killed).toEqual([]);
    expect(spawned).toBe(false); // a denied user must never start a runtime
  });
});

test('detached streams disabled → a preserved survivor is STILL torn down', async () => {
  // This path only ever connects to an already-running daemon; it never spawns
  // one. Skipping it when detached mode is off left a preserved survivor alive
  // through a confirmed denial — including a pre-upgrade host still running the
  // credential gateway and its TCP listener.
  const prev = process.env.ACE_DETACHED_AGENTS;
  process.env.ACE_DETACHED_AGENTS = '0';
  try {
    const killed = [];
    let ensured = false;
    const outcome = await terminatePreservedDetachedHost({
      userDataPath: '/tmp/ace-boot-deny',
      createClient: () => ({
        connectExisting: async () => [],
        ensureConnected: async () => { ensured = true; return []; },
        hostPid: () => 5150,
        close() {},
      }),
      kill: (pid, signal) => killed.push([pid, signal]),
      sleep: async () => {},
      makeIdentityGuard: () => () => true,
    });
    expect(outcome).toBe('terminated');
    expect(killed.map(([pid]) => pid)).toEqual([5150, 5150]);
    expect(ensured).toBe(false); // survivor-only: never spawns a daemon
  } finally {
    if (prev === undefined) delete process.env.ACE_DETACHED_AGENTS; else process.env.ACE_DETACHED_AGENTS = prev;
  }
});

test('detached streams disabled + NO survivor → still never spawns a daemon', async () => {
  const prev = process.env.ACE_DETACHED_AGENTS;
  process.env.ACE_DETACHED_AGENTS = '0';
  try {
    let ensured = false;
    const killed = [];
    const outcome = await terminatePreservedDetachedHost({
      userDataPath: '/tmp/ace-boot-deny',
      createClient: () => ({
        connectExisting: async () => null,
        ensureConnected: async () => { ensured = true; return []; },
        hostPid: () => null,
        close() {},
      }),
      kill: (pid, signal) => killed.push([pid, signal]),
    });
    expect(outcome).toBe('no-host');
    expect(killed).toEqual([]);
    expect(ensured).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.ACE_DETACHED_AGENTS; else process.env.ACE_DETACHED_AGENTS = prev;
  }
});

// denyRequiresTeardown is the SINGLE gate for EVERY teardown site: the boot deny
// path (terminate preserved agents), the live revocation watchdog (checkRevocation),
// and the post-boot deny branch (hardRelaunchToLogin). Every DEFINITIVE deny fires it
// (a revoke that also invalidates the session surfaces as a reachable 401/403
// needs-login, NOT `locked` — so keying on `locked` alone would miss the common
// revoke path). Only allow:true (permanent cached session) and inconclusive/no-
// authority denials are spared.
test('denyRequiresTeardown: every definitive deny terminates preserved agents', () => {
  // Confirmed revoke + explicit auth rejections (401/403) + cached revoke + signed-out.
  expect(denyRequiresTeardown({ allow: false, status: 'locked', reason: 'entitlement-revoked' })).toBe(true);
  expect(denyRequiresTeardown({ allow: false, status: 'locked', reason: 'entitlement-suspended' })).toBe(true);
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'session-expired' })).toBe(true); // 401
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'access-forbidden' })).toBe(true); // 403
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'entitlement-revoked-cached' })).toBe(true);
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'signed-out' })).toBe(true);
  // Allowed entries (incl. permanent offline cached session) are never a deny → never kill.
  expect(denyRequiresTeardown({ allow: true, status: 'authed', reason: 'offline-session', offlineGrace: true })).toBe(false);
  expect(denyRequiresTeardown({ allow: true, status: 'authed', reason: 'entitled' })).toBe(false);
  // Inconclusive / no-authority denials — cannot assert a revoke → leave agents alone.
  // (entitlement-unconfirmed = signed in but offline and never confirmed for this account.)
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'entitlement-unconfirmed' })).toBe(false);
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'control-plane-unavailable' })).toBe(false);
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'gate-error' })).toBe(false);
  expect(denyRequiresTeardown({ allow: false, status: 'needs-login', reason: 'front-door-unavailable' })).toBe(false);
  expect(denyRequiresTeardown(null)).toBe(false);
});

// Permanent sign-in: an outage must never block or kill an EXISTING session. The
// live watchdog (checkRevocation) and the post-boot deny branch both gate on
// denyRequiresTeardown, so a still-online-authed session that later evaluates to
// `entitlement-unconfirmed` during an outage (its best-effort marker write had
// failed) must NOT be classified for teardown — otherwise the watchdog would kill
// running agents on a transient blip.
test('live watchdog: entitlement-unconfirmed during an outage does NOT trigger teardown', () => {
  const authed = { allow: true, status: 'authed', reason: 'entitled' };
  const outage = { allow: false, status: 'needs-login', reason: 'entitlement-unconfirmed' };
  expect(denyRequiresTeardown(authed)).toBe(false);   // online: stays up
  expect(denyRequiresTeardown(outage)).toBe(false);   // later outage: session preserved, agents untouched
});
