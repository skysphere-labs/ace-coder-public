import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  createSidecarLeaseLedger,
  defaultProcessIdentity,
} = require('../hermes-sidecar-leases.cts');

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tempLeasePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-leases-')), 'sidecar-leases.json');
}

function leaseSeed(key = 'app') {
  return {
    key,
    kind: 'app',
    home: `/tmp/${key}`,
    host: '127.0.0.1',
    port: 43210,
    startedAt: 100,
  };
}

function createHarness({
  filePath = tempLeasePath(),
  parentPid = 1111,
  alive = new Set([parentPid]),
  identities = new Map([[parentPid, `proc-${parentPid}`]]),
  signals = [],
  ...overrides
} = {}) {
  const ledger = createSidecarLeaseLedger({
    filePath,
    parentPid,
    processAlive: (pid = 0) => alive.has(Number(pid)),
    processIdentity: (pid = 0) => identities.get(Number(pid)) ?? null,
    terminateProcess: (pid = 0, signal = '') => {
      signals.push({ pid: Number(pid), signal });
      alive.delete(Number(pid));
    },
    lockRetryMs: 2,
    lockTimeoutMs: 500,
    invalidParticipantStaleMs: 1_000,
    ...overrides,
  });
  return { alive, filePath, identities, ledger, parentPid, signals };
}

test('a contender waits on a live immutable choosing claim without deleting it', async () => {
  const filePath = tempLeasePath();
  const initEntered = deferred();
  const releaseInit = deferred();
  const first = createHarness({
    filePath,
    parentPid: 1111,
    alive: new Set([1111, 2222]),
    identities: new Map([[1111, 'ace-one'], [2222, 'ace-two']]),
    afterChoosingWrite: async () => {
      initEntered.resolve();
      await releaseInit.promise;
    },
  });
  const second = createHarness({
    filePath,
    parentPid: 2222,
    alive: first.alive,
    identities: first.identities,
  });

  const firstWrite = first.ledger.record({ ...leaseSeed('first'), childPid: 4001, childIdentity: 'child-one' });
  await initEntered.promise;
  const secondWrite = second.ledger.record({ ...leaseSeed('second'), childPid: 4002, childIdentity: 'child-two' });

  // This exceeds the old initialization grace that let a contender delete a
  // live common lock while its owner was descheduled before writeFileSync.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fs.existsSync(`${filePath}.lock`)).toBe(true);
  expect(fs.existsSync(filePath)).toBe(false);

  releaseInit.resolve();
  await Promise.all([firstWrite, secondWrite]);
  expect(Object.keys(first.ledger.snapshot()).sort()).toEqual(['first', 'second']);
});

test('release unlinks only its own claim and cannot remove a replacement claim', async () => {
  const filePath = tempLeasePath();
  const replacementToken = 'b'.repeat(36);
  let replacementPath = '';
  const harness = createHarness({
    filePath,
    alive: new Set([1111, 2222]),
    identities: new Map([[1111, 'ace-one'], [2222, 'ace-two']]),
    beforeLockRelease: async ({ lockPath }) => {
      replacementPath = path.join(lockPath, `claim-${replacementToken}.ticket`);
      fs.writeFileSync(replacementPath, JSON.stringify({
        version: 1,
        pid: 2222,
        identity: 'ace-two',
        token: replacementToken,
        kind: 'ticket',
        ticket: 1,
        createdAt: Date.now(),
      }));
    },
  });

  await harness.ledger.record({ ...leaseSeed(), childPid: 4001, childIdentity: 'child-one' });

  expect(fs.existsSync(replacementPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(replacementPath, 'utf8')).token).toBe(replacementToken);
  fs.rmSync(`${filePath}.lock`, { recursive: true, force: true });
});

test('two ledger instances preserve concurrent records for different sidecars', async () => {
  const filePath = tempLeasePath();
  const alive = new Set([1111, 2222]);
  const identities = new Map([[1111, 'ace-one'], [2222, 'ace-two']]);
  const first = createHarness({ filePath, parentPid: 1111, alive, identities });
  const second = createHarness({ filePath, parentPid: 2222, alive, identities });

  await Promise.all([
    first.ledger.record({ ...leaseSeed('alpha'), childPid: 4001, childIdentity: 'child-alpha' }),
    second.ledger.record({ ...leaseSeed('beta'), childPid: 4002, childIdentity: 'child-beta' }),
  ]);

  expect(first.ledger.snapshot()).toMatchObject({
    alpha: { ownerPid: 1111, childPid: 4001, childIdentity: 'child-alpha' },
    beta: { ownerPid: 2222, childPid: 4002, childIdentity: 'child-beta' },
  });
});

test('Windows process identity allows sidecar leases to record stable owner and child generations', async () => {
  const filePath = tempLeasePath();
  const calls = [];
  const rows = new Map([
    [1111, {
      ProcessId: 1111,
      CreationDate: '20260712140000.000000-240',
      ExecutablePath: 'C:\\Program Files\\Ace\\Ace.exe',
      CommandLine: 'Ace.exe --main',
    }],
    [4001, {
      ProcessId: 4001,
      CreationDate: '20260712140100.000000-240',
      ExecutablePath: 'C:\\Python\\python.exe',
      CommandLine: 'python.exe hermes dashboard --no-open',
    }],
  ]);
  const processIdentity = (pid = 0) => defaultProcessIdentity(pid, {
    platform: 'win32',
    execFileSync: (command = '', args = []) => {
      calls.push({ args, command });
      const match = String(args.at(-1) || '').match(/ProcessId = (\d+)/);
      const row = rows.get(Number(match?.[1] || 0));
      if (!row) throw new Error('process not found');
      return JSON.stringify(row);
    },
  });
  const originalChildIdentity = processIdentity(4001);
  const ledger = createSidecarLeaseLedger({
    filePath,
    parentPid: 1111,
    processAlive: (pid = 0) => rows.has(Number(pid)),
    processIdentity,
    lockRetryMs: 2,
    lockTimeoutMs: 500,
  });

  await ledger.record({ ...leaseSeed(), childPid: 4001 });

  expect(ledger.snapshot().app.ownerIdentity).toMatch(/^[a-f0-9]{64}$/);
  expect(ledger.snapshot().app.childIdentity).toBe(originalChildIdentity);
  expect(calls.every((call) => call.command === 'powershell.exe')).toBe(true);
  rows.set(4001, { ...rows.get(4001), CreationDate: '20260712150000.000000-240' });
  expect(processIdentity(4001)).not.toBe(originalChildIdentity);
});

test('stale cleanup unlinks only the observed claim and cannot delete a live replacement', async () => {
  const filePath = tempLeasePath();
  const lockPath = `${filePath}.lock`;
  const staleToken = 'a'.repeat(36);
  const replacementToken = 'b'.repeat(36);
  const stalePath = path.join(lockPath, `claim-${staleToken}.ticket`);
  const replacementPath = path.join(lockPath, `claim-${replacementToken}.ticket`);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(stalePath, JSON.stringify({
    version: 1,
    pid: 3333,
    identity: 'dead-owner',
    token: staleToken,
    kind: 'ticket',
    ticket: 1,
    createdAt: Date.now(),
  }));
  let replacementInstalled = false;
  const harness = createHarness({
    filePath,
    parentPid: 1111,
    alive: new Set([1111, 2222]),
    identities: new Map([[1111, 'ace-one'], [2222, 'ace-replacement']]),
    lockTimeoutMs: 40,
    beforeStaleClaimRemoval: async ({ claimPath }) => {
      if (replacementInstalled || claimPath !== stalePath) return;
      replacementInstalled = true;
      fs.writeFileSync(replacementPath, JSON.stringify({
        version: 1,
        pid: 2222,
        identity: 'ace-replacement',
        token: replacementToken,
        kind: 'ticket',
        ticket: 1,
        createdAt: Date.now(),
      }));
    },
  });

  await expect(
    harness.ledger.record({ ...leaseSeed(), childPid: 4001, childIdentity: 'child-one' })
  ).rejects.toThrow(/timed out waiting for Hermes sidecar ledger lock/);

  expect(fs.existsSync(stalePath)).toBe(false);
  expect(fs.existsSync(replacementPath)).toBe(true);
  fs.rmSync(lockPath, { recursive: true, force: true });
});

test('a reused persisted child PID is never signaled', async () => {
  const filePath = tempLeasePath();
  const alive = new Set([1111, 4242]);
  const identities = new Map([[1111, 'ace-old'], [4242, 'hermes-original']]);
  const first = createHarness({ filePath, parentPid: 1111, alive, identities });
  await first.ledger.record({ ...leaseSeed(), childPid: 4242, childIdentity: 'hermes-original' });

  alive.delete(1111);
  alive.add(2222);
  identities.set(2222, 'ace-new');
  identities.set(4242, 'unrelated-reused-pid');
  const second = createHarness({ filePath, parentPid: 2222, alive, identities });

  await second.ledger.reserve(leaseSeed());

  expect(second.signals).toEqual([]);
  expect(second.ledger.snapshot().app).toMatchObject({
    ownerPid: 2222,
    ownerIdentity: 'ace-new',
    childPid: null,
  });
});

test('a matching orphan identity is terminated once before ownership is reserved', async () => {
  const filePath = tempLeasePath();
  const alive = new Set([1111, 4242]);
  const identities = new Map([[1111, 'ace-old'], [4242, 'hermes-original']]);
  const first = createHarness({ filePath, parentPid: 1111, alive, identities });
  await first.ledger.record({ ...leaseSeed(), childPid: 4242, childIdentity: 'hermes-original' });

  alive.delete(1111);
  alive.add(2222);
  identities.set(2222, 'ace-new');
  const second = createHarness({ filePath, parentPid: 2222, alive, identities });

  await second.ledger.reserve(leaseSeed());

  expect(second.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  expect(second.ledger.snapshot().app.childPid).toBeNull();
});

test('an alive child without verifiable identity blocks safely instead of being killed', async () => {
  const filePath = tempLeasePath();
  const alive = new Set([1111, 4242]);
  const identities = new Map([[1111, 'ace-old'], [4242, 'hermes-original']]);
  const first = createHarness({ filePath, parentPid: 1111, alive, identities });
  await first.ledger.record({ ...leaseSeed(), childPid: 4242, childIdentity: 'hermes-original' });

  alive.delete(1111);
  alive.add(2222);
  identities.set(2222, 'ace-new');
  identities.delete(4242);
  const second = createHarness({ filePath, parentPid: 2222, alive, identities });

  await expect(second.ledger.reserve(leaseSeed())).rejects.toThrow(/cannot verify persisted Hermes dashboard process/);
  expect(second.signals).toEqual([]);
});
