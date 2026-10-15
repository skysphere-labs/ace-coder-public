import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import type { OpsBrief, OpsPulseResult, OpsStatusResult } from '../lib/ace-api';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

// Mirrors core-registry.ts: a useSyncExternalStore-backed snapshot store with a
// bootstrap that hydrates from IPC and a hook that mounts + subscribes with a
// 250ms debounce (copied from MissionBoardPanel). Each slice — status / brief /
// pulse — loads independently via Promise.allSettled so one failing slice
// degrades only its panel.

// C8 (real data only): every slice is real or it is an error. There is no
// mock fallback anywhere in Operations — a slice that cannot reach its live
// source reports 'error' with the real reason and null/empty data.
export type SliceState<T> = {
  status: 'loading' | 'ready' | 'error';
  data: T;
  error: string | null;
};

export type OperationsState = {
  // Wall-clock of the last successful (or attempted) live refresh.
  lastRefreshedAt: string | null;
  refreshing: boolean;
  status: SliceState<OpsStatusResult | null>;
  brief: SliceState<OpsBrief | null>;
  // L4 Pulse — per-project signals + ranked next step. No mock fallback: the
  // slice is real or it is an error.
  pulse: SliceState<OpsPulseResult | null>;
};

function initialSlice<T>(data: T): SliceState<T> {
  return { status: 'loading', data, error: null };
}

const INITIAL_STATE: OperationsState = {
  lastRefreshedAt: null,
  refreshing: false,
  status: initialSlice<OpsStatusResult | null>(null),
  brief: initialSlice<OpsBrief | null>(null),
  pulse: initialSlice<OpsPulseResult | null>(null),
};

const store = createSnapshotStore<OperationsState>(INITIAL_STATE);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setSlice<K extends 'status' | 'brief' | 'pulse'>(
  key: K,
  next: OperationsState[K]
) {
  store.setSnapshot((current) => ({ ...current, [key]: next }));
}

// ---------------------------------------------------------------------------
// Bootstrap — Promise.allSettled across the slices (contracts §7).
// ---------------------------------------------------------------------------

let bootstrapPromise: Promise<void> | null = null;

export async function bootstrapOperationsRegistry(
  query?: { workspaceId?: string | null }
): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  store.setSnapshot((current) => ({ ...current, refreshing: true }));

  bootstrapPromise = Promise.allSettled([
    aceApi.ops.status(query),
    aceApi.ops.brief({ lens: 'morning' }),
    aceApi.ops.pulse(),
  ])
    .then(([statusRes, briefRes, pulseRes]) => {
      // Every slice: real or error (C8). No environment renders invented data.
      if (statusRes.status === 'fulfilled') {
        setSlice('status', { status: 'ready', data: statusRes.value, error: null });
      } else {
        setSlice('status', {
          status: 'error',
          data: null,
          error: errorMessage(statusRes.reason),
        });
      }
      if (pulseRes.status === 'fulfilled') {
        setSlice('pulse', { status: 'ready', data: pulseRes.value, error: null });
      } else {
        setSlice('pulse', {
          status: 'error',
          data: null,
          error: errorMessage(pulseRes.reason),
        });
      }
      if (briefRes.status === 'fulfilled') {
        setSlice('brief', { status: 'ready', data: briefRes.value, error: null });
      } else {
        setSlice('brief', {
          status: 'error',
          data: null,
          error: errorMessage(briefRes.reason),
        });
      }
    })
    .finally(() => {
      store.setSnapshot((current) => ({
        ...current,
        refreshing: false,
        lastRefreshedAt: new Date().toISOString(),
      }));
      bootstrapPromise = null;
    });

  return bootstrapPromise;
}

// Manual refresh for the header Refresh button. Re-runs the bootstrap path.
export async function refreshOperationsStatus(query?: {
  workspaceId?: string | null;
}): Promise<void> {
  return bootstrapOperationsRegistry(query);
}

// ---------------------------------------------------------------------------
// Hook — mount + subscribe with a 250ms debounce (copied from MissionBoardPanel).
// ---------------------------------------------------------------------------

export function useOperationsData(query?: { workspaceId?: string | null }): OperationsState {
  const workspaceId = query?.workspaceId ?? null;

  useEffect(() => {
    void bootstrapOperationsRegistry({ workspaceId });

    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refreshOperationsStatus({ workspaceId });
      }, 250);
    };
    const unsubscribers = [
      aceApi.core.subscribe(scheduleRefresh),
      aceApi.core.onGitChanged(scheduleRefresh),
      aceApi.streams.onEvent(scheduleRefresh),
    ];
    return () => {
      if (timer) window.clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [workspaceId]);

  return useStoreValue(store);
}

export function getOperationsSnapshot(): OperationsState {
  return store.getSnapshot();
}
