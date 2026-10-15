// @ts-nocheck — keep this .cts test plain JavaScript for Vite.
import { expect, test } from 'vitest';
const { createRuntimeBoot } = require('../runtime-boot.cts');
const silent = { error: () => {}, warn: () => {} };
function makeBroadcast() {
  const events = [];
  return { fn: (channel, payload) => events.push({ channel, payload }), events };
}

test('local startup needs no account authority and publishes readiness only after constructors and IPC', async () => {
  const calls = [];
  const bc = makeBroadcast();
  const runtime = createRuntimeBoot({
    constructors: [
      { name: 'store', run: () => calls.push('store') },
      { name: 'github', run: () => calls.push('github') },
      { name: 'remote', run: () => calls.push('remote') },
    ],
    registerIpc: () => calls.push('ipc'),
    broadcast: (channel, state) => {
      expect(calls).toEqual(['store', 'github', 'remote', 'ipc']);
      bc.fn(channel, state);
    },
  });
  expect(calls).toEqual([]);
  expect(await runtime.boot()).toEqual({ ok: true, status: 'ready' });
  expect(runtime.isBooted()).toBe(true);
  expect(bc.events).toEqual([{ channel: 'ace:runtime-changed', payload: { status: 'ready' } }]);
  expect(await runtime.boot()).toEqual({ ok: true, status: 'ready', alreadyBooted: true });
  expect(calls).toEqual(['store', 'github', 'remote', 'ipc']);
  expect(bc.events).toHaveLength(1);
});

test('failed constructor holds the shell, stops construction, and awaits partial teardown', async () => {
  const calls = [];
  const bc = makeBroadcast();
  const runtime = createRuntimeBoot({
    constructors: [
      { name: 'store', run: () => calls.push('store') },
      { name: 'controller', run: () => { throw new Error('database unavailable'); } },
      { name: 'remote', run: () => calls.push('remote') },
    ],
    registerIpc: () => calls.push('ipc'),
    broadcast: bc.fn,
    teardownPartial: async () => { calls.push('cleanup-start'); await Promise.resolve(); calls.push('cleanup-done'); },
    logger: silent,
  });
  expect(await runtime.boot()).toMatchObject({ ok: false, status: 'boot-error', failedAt: 'controller' });
  expect(runtime.isBooted()).toBe(false);
  expect(calls).toEqual(['store', 'cleanup-start', 'cleanup-done']);
  expect(bc.events).toHaveLength(1);
  expect(bc.events[0]).toMatchObject({ channel: 'ace:runtime-changed', payload: { status: 'boot-error', boot: { failedAt: 'controller' } } });
  expect(bc.events[0].payload.reason).toContain('database unavailable');
});

test('IPC failure cleans partial handlers so a subsequent retry can register them once', async () => {
  const handlers = new Map();
  let attempts = 0;
  const bc = makeBroadcast();
  const runtime = createRuntimeBoot({
    constructors: [],
    registerIpc: () => {
      if (handlers.has('get-state')) throw new Error('duplicate handler');
      handlers.set('get-state', () => ({}));
      if (++attempts === 1) throw new Error('registration interrupted');
      handlers.set('get-settings', () => ({}));
    },
    teardownPartial: () => handlers.clear(),
    broadcast: bc.fn,
    logger: silent,
  });
  expect(await runtime.boot()).toMatchObject({ ok: false, failedAt: 'register-ipc' });
  expect(handlers.size).toBe(0);
  expect(await runtime.boot()).toMatchObject({ ok: true, status: 'ready' });
  expect([...handlers.keys()]).toEqual(['get-state', 'get-settings']);
  expect(bc.events.map((e) => e.payload.status)).toEqual(['boot-error', 'ready']);
});

test('retry waits for a failed attempt to finish teardown before reconstructing', async () => {
  const order = [];
  let releaseTeardown;
  const teardownDone = new Promise((resolve) => { releaseTeardown = resolve; });
  let attempt = 0;
  const runtime = createRuntimeBoot({
    constructors: [{ name: 'store', run: () => {
      attempt += 1;
      order.push(`construct-${attempt}`);
      if (attempt === 1) throw new Error('temporary failure');
    } }],
    registerIpc: () => order.push('ipc'),
    broadcast: () => {},
    teardownPartial: async () => { order.push('cleanup-start'); await teardownDone; order.push('cleanup-done'); },
    logger: silent,
  });
  const first = runtime.boot();
  await Promise.resolve();
  const retry = runtime.boot();
  await Promise.resolve();
  expect(order).toEqual(['construct-1', 'cleanup-start']);
  releaseTeardown();
  const [failed, recovered] = await Promise.all([first, retry]);
  expect(failed.ok).toBe(false);
  expect(recovered.ok).toBe(true);
  expect(order).toEqual(['construct-1', 'cleanup-start', 'cleanup-done', 'construct-2', 'ipc']);
});

test('teardown failure cannot turn startup failure into readiness', async () => {
  const bc = makeBroadcast();
  const runtime = createRuntimeBoot({
    constructors: [{ name: 'store', run: () => { throw new Error('broken store'); } }],
    registerIpc: () => {},
    broadcast: bc.fn,
    teardownPartial: () => { throw new Error('cleanup failed'); },
    logger: silent,
  });
  expect(await runtime.boot()).toMatchObject({ ok: false, status: 'boot-error' });
  expect(runtime.isBooted()).toBe(false);
  expect(bc.events.every((e) => e.payload.status !== 'ready')).toBe(true);
});
