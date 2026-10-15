// Operators registry — a useSyncExternalStore-backed snapshot store for the
// install's operator config (see src/lib/operators.ts). Holds neutral
// DEFAULT_OPERATORS until initOperatorsRegistry is called with a fetcher at app
// boot by the IPC wiring (a later unit). This module must stay free of
// window.aceDesktop / ace-api access — the fetcher is injected so the
// contract works standalone before IPC exists.

import { DEFAULT_OPERATORS, OPERATORS_SCHEMA } from '../lib/operators';
import type { OperatorsConfig } from '../lib/operators';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

const store = createSnapshotStore<OperatorsConfig>(DEFAULT_OPERATORS);

let initPromise: Promise<void> | null = null;
let hydrated = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

// ace-api calls this at module scope, which runs while the front door still
// shows the login screen — the operators IPC handler is only registered inside
// bootRuntime(), so the first fetch rejects. Retry on a backoff rather than
// keying off any single readiness event: the gate has several entry paths
// (startup, post-login poll, ace:auth-state) and ordering between them and IPC
// registration is not guaranteed.
const RETRY_DELAYS_MS = [250, 1000, 3000, 8000, 15000];

function isValidOperatorsConfig(value: OperatorsConfig | null): value is OperatorsConfig {
  return (
    value != null &&
    value.schema === OPERATORS_SCHEMA &&
    typeof value.defaultOperatorId === 'string' &&
    Array.isArray(value.operators) &&
    value.operators.length > 0
  );
}

function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(fetcher: () => Promise<OperatorsConfig | null>) {
  if (hydrated || retryTimer !== null) return;
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void initOperatorsRegistry(fetcher);
  }, delay);
  // Never hold a node process open on this timer.
  (retryTimer as unknown as { unref?: () => void })?.unref?.();
}

/**
 * Hydrate the registry from an injected fetcher. Only SUCCESS latches: a
 * rejected, null or malformed result schedules a backoff retry, so a config
 * that becomes reachable later is still picked up. Without this the renderer
 * stayed on neutral DEFAULT_OPERATORS for the whole session and every
 * configured operator's label, glyph and lane tab silently went generic.
 */
export function initOperatorsRegistry(
  fetcher: () => Promise<OperatorsConfig | null>
): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const fetched = await fetcher();
      if (isValidOperatorsConfig(fetched)) {
        store.setSnapshot(fetched);
        hydrated = true;
      }
    } catch {
      // Keep DEFAULT_OPERATORS; the backoff below retries.
    } finally {
      initPromise = null;
      if (hydrated) clearRetry();
      else scheduleRetry(fetcher);
    }
  })();
  return initPromise;
}

/** True once a valid config has been loaded. */
export function isOperatorsHydrated(): boolean {
  return hydrated;
}

/** Current config snapshot (DEFAULT_OPERATORS until init resolves). */
export function getOperatorsSnapshot(): OperatorsConfig {
  return store.getSnapshot();
}

/** Subscribe to config changes; returns an unsubscribe function. */
export function subscribeOperators(listener: () => void): () => void {
  return store.subscribe(listener);
}

/** React hook over the registry snapshot. */
export function useOperators(): OperatorsConfig {
  return useStoreValue(store);
}

/** Test-only reset so the singleton doesn't leak state across unit tests. */
export function __resetOperatorsRegistryForTests() {
  clearRetry();
  initPromise = null;
  hydrated = false;
  attempt = 0;
  store.setSnapshot(DEFAULT_OPERATORS);
}
