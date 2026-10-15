import { useEffect } from 'react';
import { createLatestCoalescer } from './coalesce';
import type { Mission, Workspace } from '../lib/types';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import {
  createSnapshotStore,
  useStoreSelector,
  useStoreSelectorEq,
  useStoreValue,
} from './create-snapshot-store';
import { recordPerf } from './perf-health';

export type CoreState = {
  status: 'loading' | 'ready' | 'error';
  workspaces: Workspace[];
  missions: Mission[];
  error: string | null;
};

const store = createSnapshotStore<CoreState>({
  status: 'loading',
  workspaces: [],
  missions: [],
  error: null,
});

let bootstrapPromise: Promise<void> | null = null;

function perfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// Highest snapshot revision applied so far. State reaches remote clients over
// two unordered transports (WS broadcasts + HTTP getState responses over the
// tunnel); without ordering, a slow in-flight getState can land after a newer
// broadcast and roll the UI back — the classic symptom was a just-created
// task vanishing and the phone bouncing back to the spawn screen. Servers
// stamp every snapshot build with a monotonic `rev`; anything older than what
// we've already applied is dropped. Unstamped snapshots (older servers) apply
// unconditionally, as before.
let lastAppliedRev = 0;

export function applyState(next: { workspaces: Workspace[]; missions?: Mission[]; rev?: number }) {
  const rev = typeof next.rev === 'number' && Number.isFinite(next.rev) ? next.rev : null;
  if (rev !== null) {
    if (rev < lastAppliedRev) {
      recordPerf({
        kind: 'span',
        name: 'core.applyState.staleDropped',
        durationMs: 0,
        meta: { rev, lastAppliedRev },
      });
      return;
    }
    lastAppliedRev = rev;
  }
  store.setSnapshot({
    status: 'ready',
    workspaces: next.workspaces,
    missions: next.missions ?? [],
    error: null,
  });
}

async function refreshCoreState() {
  const state = await aceApi.core.getState();
  applyState(state);
}

function watchNextCoreBroadcast(timeoutMs: number) {
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const promise = new Promise<boolean>((resolve) => {
    const finish = (received: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        if (unsubscribe) unsubscribe();
      } catch {}
      unsubscribe = null;
      resolve(received);
    };

    try {
      unsubscribe = aceApi.core.subscribe((state) => {
        applyState(state);
        finish(true);
      });
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch {
      finish(false);
    }
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        if (unsubscribe) unsubscribe();
      } catch {}
      unsubscribe = null;
      settled = true;
    },
  };
}

// How long to wait for the WS `state` echo after a mutation before falling
// back to a full getState(). Desktop IPC broadcasts arrive almost instantly;
// remote/mobile clients see the server's broadcast coalescing plus tunnel
// latency, and the full-state fallback is a large HTTP transfer there — so
// give the broadcast more headroom before paying for a refetch.
const BROADCAST_FALLBACK_DELAY_MS = 150;
const REMOTE_BROADCAST_FALLBACK_DELAY_MS = 1500;

export function defaultBroadcastFallbackDelayMs(): number {
  return isRemoteClient() ? REMOTE_BROADCAST_FALLBACK_DELAY_MS : BROADCAST_FALLBACK_DELAY_MS;
}

export async function runWithCoreStateRefresh<T>(
  action: () => Promise<T>,
  options: { fallbackDelayMs?: number } = {}
): Promise<T> {
  const watcher = watchNextCoreBroadcast(options.fallbackDelayMs ?? defaultBroadcastFallbackDelayMs());
  try {
    const result = await action();
    const receivedBroadcast = await watcher.promise;
    if (!receivedBroadcast) await refreshCoreState();
    return result;
  } catch (error) {
    watcher.cancel();
    throw error;
  }
}

async function bootstrapCoreRegistry() {
  if (store.getSnapshot().status === 'ready') return;
  if (bootstrapPromise) return bootstrapPromise;

  const started = perfNow();
  bootstrapPromise = aceApi.core
    .getState()
    .then((state) => {
      recordPerf({
        kind: 'span',
        name: 'core.bootstrap.getState',
        durationMs: perfNow() - started,
        meta: { ok: true, workspaces: state.workspaces.length, missions: state.missions?.length || 0 },
      });
      applyState(state);
    })
    .catch((error: unknown) => {
      recordPerf({
        kind: 'span',
        name: 'core.bootstrap.getState',
        durationMs: perfNow() - started,
        meta: { ok: false },
      });
      store.setSnapshot({
        status: 'error',
        workspaces: [],
        missions: [],
        error: error instanceof Error ? error.message : 'Failed to load local runtime state.',
      });
    })
    .finally(() => {
      bootstrapPromise = null;
    });

  return bootstrapPromise;
}

// Main emits full-state broadcasts in bursts; applying each one re-runs every
// store selector. First broadcast applies immediately, a burst collapses to
// one trailing apply of the LATEST snapshot (50ms window) — intermediate
// snapshots are superseded, never queued.
const pushCoreState = createLatestCoalescer<CoreState>((state) => applyState(state), 50);

export function useCoreBootstrap() {
  useEffect(() => {
    void bootstrapCoreRegistry();
    return aceApi.core.subscribe((state) => pushCoreState(state));
  }, []);

  return useStoreValue(store);
}

export function useCoreSelector<T>(select: (snapshot: CoreState) => T) {
  return useStoreSelector(store, select);
}

// Memoized variant: the consumer re-renders only when the selected slice
// changes under `isEqual`, not on every state push.
export function useCoreSelectorEq<T>(
  select: (snapshot: CoreState) => T,
  isEqual?: (a: T, b: T) => boolean
) {
  return useStoreSelectorEq(store, select, isEqual);
}

export function getCoreSnapshot() {
  return store.getSnapshot();
}
