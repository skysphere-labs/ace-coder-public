// The renderer asks for the operators config before the front door has booted
// the runtime that registers its IPC handler, so the first fetch always
// rejects. Latching that rejection pinned the session to DEFAULT_OPERATORS and
// every configured operator's label, glyph and lane tab silently went generic.
// These tests drive the real lifecycle on fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPERATORS, OPERATORS_SCHEMA } from '../lib/operators';
import type { OperatorsConfig } from '../lib/operators';
import {
  getOperatorsSnapshot,
  initOperatorsRegistry,
  isOperatorsHydrated,
  subscribeOperators,
  __resetOperatorsRegistryForTests,
} from './operators-registry';

const CONFIG: OperatorsConfig = {
  schema: OPERATORS_SCHEMA,
  defaultOperatorId: 'aurora',
  operators: [
    {
      id: 'aurora', label: 'Aurora', emoji: '✦', agent: 'hermes',
      providerKind: 'builtin-personal', isControlPlane: true, autoStart: false,
      sortOrder: 0, workspaceDirName: 'w', terminalDirName: 't',
      chat: { placeholder: '', busyRow: '', gerunds: [] }, ownerTitle: 'Owner',
    },
  ],
};

const NO_HANDLER = () =>
  Promise.reject(new Error("No handler registered for 'ace:operators-list'"));

/** Let the backoff fire and its async fetch settle. */
async function tick() {
  await vi.runOnlyPendingTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetOperatorsRegistryForTests();
});
afterEach(() => {
  __resetOperatorsRegistryForTests();
  vi.useRealTimers();
});

describe('operators registry hydration lifecycle', () => {
  it('recovers on its own once the IPC handler appears after boot', async () => {
    // Pre-boot: the handler does not exist yet.
    let handlerRegistered = false;
    const fetcher = vi.fn(() =>
      handlerRegistered ? Promise.resolve(CONFIG) : NO_HANDLER()
    );

    await initOperatorsRegistry(fetcher);
    expect(isOperatorsHydrated()).toBe(false);
    expect(getOperatorsSnapshot()).toEqual(DEFAULT_OPERATORS);

    // bootRuntime() registers the handler at some unspecified later moment —
    // no event is delivered to the registry.
    handlerRegistered = true;

    await tick();

    expect(isOperatorsHydrated()).toBe(true);
    expect(getOperatorsSnapshot().defaultOperatorId).toBe('aurora');
  });

  it('keeps retrying across several failures, not just once', async () => {
    let failures = 0;
    const fetcher = vi.fn(() => {
      if (failures < 3) { failures += 1; return NO_HANDLER(); }
      return Promise.resolve(CONFIG);
    });

    await initOperatorsRegistry(fetcher);
    for (let i = 0; i < 3; i += 1) {
      expect(isOperatorsHydrated()).toBe(false);
      await tick();
    }
    expect(isOperatorsHydrated()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retries a null or malformed config the same way', async () => {
    const fetcher = vi
      .fn<() => Promise<OperatorsConfig | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ schema: 'wrong' } as unknown as OperatorsConfig)
      .mockResolvedValue(CONFIG);

    await initOperatorsRegistry(fetcher);
    expect(isOperatorsHydrated()).toBe(false);
    await tick();
    expect(isOperatorsHydrated()).toBe(false);
    await tick();
    expect(isOperatorsHydrated()).toBe(true);
  });

  it('notifies subscribers when late hydration lands', async () => {
    const seen: string[] = [];
    subscribeOperators(() => seen.push(getOperatorsSnapshot().defaultOperatorId));
    let ready = false;
    const fetcher = vi.fn(() => (ready ? Promise.resolve(CONFIG) : NO_HANDLER()));

    await initOperatorsRegistry(fetcher);
    expect(seen).toEqual([]);
    ready = true;
    await tick();
    expect(seen).toContain('aurora');
  });

  it('stops fetching and cancels the backoff once hydrated', async () => {
    const fetcher = vi.fn<() => Promise<OperatorsConfig | null>>().mockResolvedValue(CONFIG);
    await initOperatorsRegistry(fetcher);
    expect(isOperatorsHydrated()).toBe(true);

    await tick();
    await initOperatorsRegistry(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces concurrent callers onto one in-flight fetch', async () => {
    const fetcher = vi.fn<() => Promise<OperatorsConfig | null>>().mockResolvedValue(CONFIG);
    await Promise.all([initOperatorsRegistry(fetcher), initOperatorsRegistry(fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
