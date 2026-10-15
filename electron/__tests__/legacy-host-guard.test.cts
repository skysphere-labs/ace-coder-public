import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAceStore } = require('../local-core.cts');
const { BetterSqlite3NodeShim } = require('./helpers/better-sqlite3-node-shim.cts');

// The legacy-host guard at the createAceStore seam — the closures the
// lower-level pty-host tests cannot reach: ensureStreamStarted's refusal, the
// restore pass skipping blocked lanes, and the once-only interruption notice.
//
// Runs under vitest (so `npm test` actually gates it) by injecting the
// node:sqlite shim the same way local-core.test.cts does; the packaged
// better-sqlite3 is Electron-ABI and cannot load in a plain node runner.

function fakePtyHost({ blocked = [], retired = [] } = {}) {
  const spawns = [];
  let retiredLeft = [...retired];
  return {
    spawns,
    host: {
      isConnected: () => true,
      ensureConnected: async () => [],
      connectExisting: async () => [],
      hostPid: () => 4242,
      spawnedChildHandle: () => null,
      blockedSurvivorStreamIds: () => [...blocked],
      takeRetiredStreamIds: () => { const t = retiredLeft; retiredLeft = []; return t; },
      spawnStream: (opts) => {
        spawns.push(opts);
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      },
      adoptStream: async () => null,
      release: async () => {},
      killStream: async () => {},
    },
  };
}

describe('legacy pty-host guard at the store seam', () => {
  let root;
  let repo;
  let restorePath;
  let stores;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-legacy-guard-'));
    repo = path.join(root, 'repo');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    const cp = require('node:child_process');
    const genv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    cp.execFileSync('git', ['init', '-q'], { cwd: repo });
    cp.execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo, env: genv });
    restorePath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${restorePath}`;
    stores = [];
  });

  afterEach(() => {
    for (const s of stores) { try { s.shutdown(); } catch {} }
    if (restorePath !== undefined) process.env.PATH = restorePath;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  function bootStore(ptyHost) {
    const store = createAceStore(path.join(root, 'ud'), {
      Database: BetterSqlite3NodeShim,
      ptyHost,
      exposeInternals: true,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });
    stores.push(store);
    return store;
  }

  // Drives the REAL detached-off branch: no injected ptyHost (so the sweep runs
  // and its result is latched by production code), just a stub client the
  // factory hands back, plus an in-process pty so lanes can still spawn.
  function bootSweepStore(sweepResult, spawns) {
    const prev = process.env.ACE_DETACHED_AGENTS;
    process.env.ACE_DETACHED_AGENTS = '0';
    try {
      const store = createAceStore(path.join(root, 'ud'), {
        Database: BetterSqlite3NodeShim,
        exposeInternals: true,
        verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
        ptyImpl: {
          spawn(bin, args, opts) {
            spawns.push({ bin, args, opts });
            return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
          },
        },
        ptyHostClientFactory: () => ({
          retireOutdatedSurvivor: async () => sweepResult,
          close() {},
        }),
      });
      stores.push(store);
      return store;
    } finally {
      if (prev == null) delete process.env.ACE_DETACHED_AGENTS;
      else process.env.ACE_DETACHED_AGENTS = prev;
    }
  }

  async function makeLane(store, name = 'lane') {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const t = await store.createThread({
      workspaceId,
      input: { name, agent: 'claude', prompt: null, kind: 'cli' },
    });
    return `conversation:${t.conversationId}`;
  }

  it('refuses to start a lane still running inside an un-retired legacy host', async () => {
    const fake = fakePtyHost();
    const store = bootStore(fake.host);
    const streamId = await makeLane(store);

    // The pty-host reports this lane alive in a host it could not retire.
    fake.host.blockedSurvivorStreamIds = () => [streamId];

    const res = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(res.ok).toBe(false);
    expect(res.blockedByLegacyHost).toBe(true);
    expect(String(res.error)).toMatch(/pty-host left over from a previous version/i);
    // Nothing was spawned — a second CLI on that session is the whole hazard.
    expect(fake.spawns).toHaveLength(0);
  });

  it('starts a lane normally once nothing is blocked', async () => {
    const fake = fakePtyHost();
    const store = bootStore(fake.host);
    const streamId = await makeLane(store);

    const res = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(res.ok).toBe(true);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0].id).toBe(streamId);
  });

  it('tells a retired lane it was restarted — exactly once', async () => {
    const fake = fakePtyHost();
    const store = bootStore(fake.host);
    const streamId = await makeLane(store);
    // This lane's CLI died with an outdated host we retired.
    fake.host.takeRetiredStreamIds = (() => {
      let left = [streamId];
      return () => { const t = left; left = []; return t; };
    })();

    const chunks = [];
    const off = store.onPtyData(({ id, chunk }) => { if (id === streamId) chunks.push(chunk); });

    await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    const notices = () => chunks.filter((c) => c.includes('restarted onto an updated pty-host'));
    expect(notices()).toHaveLength(1);
    // It names the recovery, because wake prompts are opt-in and a mid-turn
    // lane would otherwise sit at an idle composer with no explanation.
    expect(notices()[0]).toMatch(/continue/i);

    // A later open must not repeat it.
    store._internals.getStream(streamId)?.pty?.kill?.();
    await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(notices()).toHaveLength(1);
    off?.();
  });

  // Create the lane in a first store (sweep finds nothing), shut it down, then
  // reopen the SAME userData with a sweep result naming it. The lane row
  // persists, so the second boot is exactly the upgrade-launch shape.
  async function laneThenSweep(sweepResult, name) {
    const spawns = [];
    const first = bootSweepStore({ outcome: 'none', retired: [], blocked: [] }, spawns);
    const streamId = await makeLane(first, name);
    try { first.shutdown(); } catch {}
    stores = stores.filter((s2) => s2 !== first);
    spawns.length = 0;
    const store = bootSweepStore(sweepResult(streamId), spawns);
    return { store, streamId, spawns };
  }

  it('detached-off: a blocked survivor stops both manual start and boot restore', async () => {
    const { store, streamId, spawns } = await laneThenSweep(
      (id) => ({ outcome: 'blocked', retired: [], blocked: [id] }),
      'swept-blocked'
    );
    const res = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(res.ok).toBe(false);
    expect(res.blockedByLegacyHost).toBe(true);
    const summary = await store.restoreAgentStreams({ relaunchMissing: true });
    expect(summary.relaunched).toBe(0);
    expect(spawns).toHaveLength(0);
  });

  it('detached-off: an unknown sweep refuses to start or resume anything', async () => {
    const { store, streamId, spawns } = await laneThenSweep(
      () => ({ outcome: 'unknown', retired: [], blocked: [] }),
      'swept-unknown'
    );
    // We could not tell whether a legacy host holds this lane, so nothing runs.
    const res = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(res.ok).toBe(false);
    expect(res.blockedByLegacyHost).toBe(true);
    expect(spawns).toHaveLength(0);
    const summary = await store.restoreAgentStreams({ relaunchMissing: true });
    expect(summary.relaunched).toBe(0);
  });

  it('detached-off: a retired survivor latches its lanes for the notice', async () => {
    const { store, streamId, spawns } = await laneThenSweep(
      (id) => ({ outcome: 'retired', retired: [id], blocked: [] }),
      'swept-retired'
    );
    const chunks = [];
    const off = store.onPtyData(({ id, chunk }) => { if (id === streamId) chunks.push(chunk); });
    const res = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(res.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(chunks.filter((c) => c.includes('restarted onto an updated pty-host'))).toHaveLength(1);
    off?.();
  });

  it('does not resume a blocked lane during the boot restore', async () => {
    const fake = fakePtyHost();
    const store = bootStore(fake.host);
    const streamId = await makeLane(store);

    // Register it as a lane the restore pass would otherwise bring back...
    await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
    expect(fake.spawns).toHaveLength(1);
    store._internals.getStream(streamId)?.pty?.kill?.();
    store._internals.getStream(streamId).status = 'exited';

    // ...then have the host report it as still alive in an un-retired survivor.
    fake.host.blockedSurvivorStreamIds = () => [streamId];
    const summary = await store.restoreAgentStreams({ relaunchMissing: true });
    expect(summary.relaunched).toBe(0);
    expect(fake.spawns).toHaveLength(1); // no second CLI
  });
});
