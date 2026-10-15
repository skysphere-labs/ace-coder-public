import { beforeEach, expect, test, vi } from 'vitest';
import type { ProviderUsageReport } from '../lib/ace-api';

const usageApi = vi.hoisted(() => {
  const listeners = new Set<(report: unknown) => void>();
  return {
    listeners,
    getProviders: vi.fn(),
    onChanged: vi.fn((listener: (report: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
});

vi.mock('../lib/ace-api', () => ({
  aceApi: {
    usage: {
      getProviders: usageApi.getProviders,
      onChanged: usageApi.onChanged,
    },
  },
}));

import { usageRegistryInternals } from './usage-registry';

const { store, retain, release } = usageRegistryInternals;

function report(generatedAt: number): ProviderUsageReport {
  return { providers: [], generatedAt } as ProviderUsageReport;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.useRealTimers();
  usageApi.listeners.clear();
  usageApi.getProviders.mockReset();
  usageApi.onChanged.mockClear();
  store.setSnapshot({ report: null, error: null });
});

test('one consumer triggers exactly one fetch and one push subscription', async () => {
  usageApi.getProviders.mockResolvedValue(report(1));
  retain();
  try {
    await flush();
    expect(usageApi.getProviders).toHaveBeenCalledTimes(1);
    expect(usageApi.onChanged).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().report?.generatedAt).toBe(1);
  } finally {
    release();
  }
});

test('many consumers share the single subscription (no per-component timers)', async () => {
  usageApi.getProviders.mockResolvedValue(report(1));
  retain();
  retain();
  retain();
  try {
    await flush();
    expect(usageApi.getProviders).toHaveBeenCalledTimes(1);
    expect(usageApi.onChanged).toHaveBeenCalledTimes(1);
    expect(usageApi.listeners.size).toBe(1);
  } finally {
    release();
    release();
    release();
  }
  expect(usageApi.listeners.size).toBe(0); // full teardown at zero consumers
});

test('a pushed report lands in the store without a re-fetch', async () => {
  usageApi.getProviders.mockResolvedValue(report(1));
  retain();
  try {
    await flush();
    const pushed = report(2);
    for (const listener of usageApi.listeners) listener(pushed);
    expect(store.getSnapshot().report?.generatedAt).toBe(2);
    expect(usageApi.getProviders).toHaveBeenCalledTimes(1); // push is payload-carrying
  } finally {
    release();
  }
});

test('a failed refresh keeps the last good report and records the error', async () => {
  usageApi.getProviders.mockResolvedValueOnce(report(1));
  retain();
  try {
    await flush();
    usageApi.getProviders.mockRejectedValueOnce(new Error('bridge down'));
    usageRegistryInternals.refresh();
    await flush();
    const snap = store.getSnapshot();
    expect(snap.report?.generatedAt).toBe(1);
    expect(snap.error).toBe('bridge down');
  } finally {
    release();
  }
});

test('slow fallback interval re-fetches while retained and stops on release', async () => {
  vi.useFakeTimers();
  usageApi.getProviders.mockResolvedValue(report(1));
  retain();
  expect(usageApi.getProviders).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(usageApi.getProviders).toHaveBeenCalledTimes(2);
  release();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(usageApi.getProviders).toHaveBeenCalledTimes(2);
});
