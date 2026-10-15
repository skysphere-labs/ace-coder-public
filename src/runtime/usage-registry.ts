import { useEffect } from 'react';
import { aceApi, type ProviderUsageReport } from '../lib/ace-api';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

// Shared provider-usage subscription. One `usage:changed` push listener and
// one slow fallback refresh feed every consumer (LedgerStrip,
// ProviderUsagePill, mobile PlusSheet, popovers) through a single snapshot
// store — never one timer per component. The push event carries the full
// report, so meters update within the backend debounce of a source-file
// change; the fallback re-query only covers dropped events and bridges
// without the push channel (older remote servers).

export type UsageState = {
  report: ProviderUsageReport | null;
  error: string | null;
};

const FALLBACK_REFRESH_MS = 60_000;

const store = createSnapshotStore<UsageState>({ report: null, error: null });

let consumers = 0;
let offChanged: (() => void) | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

function applyReport(report: ProviderUsageReport) {
  store.setSnapshot({ report, error: null });
}

function refresh() {
  aceApi.usage
    .getProviders()
    .then(applyReport)
    .catch((err: unknown) => {
      store.setSnapshot((current) => ({
        // Keep the last good report visible — a transient refresh failure
        // must not blank meters that were already rendered.
        report: current.report,
        error: err instanceof Error ? err.message : 'Failed to read usage',
      }));
    });
}

function retain() {
  consumers += 1;
  if (consumers > 1) return;
  refresh();
  offChanged = aceApi.usage.onChanged(applyReport);
  fallbackTimer = setInterval(refresh, FALLBACK_REFRESH_MS);
}

function release() {
  consumers -= 1;
  if (consumers > 0) return;
  try { offChanged?.(); } catch { /* noop */ }
  offChanged = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
}

export function useProviderUsage(): UsageState {
  useEffect(() => {
    retain();
    return release;
  }, []);
  return useStoreValue(store);
}

// Exported for tests: drive the store without a React renderer.
export const usageRegistryInternals = { store, retain, release, refresh, applyReport };
