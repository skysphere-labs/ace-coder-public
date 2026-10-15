import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import type {
  RendererLoopSpec,
  RendererLoopSpecDraft,
  RendererLoopLockOnResult,
  RendererLoopCompileResult,
  RendererLoopRunResult,
  RendererLoopStatusResult,
  RendererLoopLineage,
  RendererLoopIteration,
  RendererLoopKind,
  RendererLoopPermission,
  RendererLoopStopState,
} from '../lib/ace-api';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

// loops-registry — the renderer-side typed API for the Loops tab (PRD §6), a
// direct mirror of operations-registry.ts: a useSyncExternalStore-backed snapshot
// store, a Promise.allSettled bootstrap that hydrates from IPC, a hook that
// mounts + subscribes with a 250ms debounce, and action helpers that re-bootstrap
// on success. It reaches window.ace.loops.* via aceApi.loops.* → invoke →
// the ace:loops-* IPC channels → the loops-service.
//
// C8 (real data only): every slice is real or it is an error. No mock fallback —
// a slice that cannot reach its live source reports 'error' with the real reason.

// Re-export the LoopSpec-facing types the GUI consumes (the GUI imports from the
// registry, not from electron — these are the renderer-safe mirrors).
export type {
  RendererLoopSpec as LoopSpec,
  RendererLoopSpecDraft as LoopSpecDraft,
  RendererLoopLockOnResult as LoopLockOnResult,
  RendererLoopRunResult as LoopRunResult,
  RendererLoopStatusResult as LoopStatusResult,
  RendererLoopLineage as LoopLineage,
  RendererLoopIteration as LoopIteration,
  RendererLoopKind as LoopKind,
  RendererLoopPermission as LoopPermission,
  RendererLoopStopState as LoopStopState,
};

export type SliceState<T> = {
  status: 'loading' | 'ready' | 'error';
  data: T;
  error: string | null;
};

export type LoopsState = {
  lastRefreshedAt: string | null;
  refreshing: boolean;
  // The saved loop catalog (definitions). Real or error (C8).
  loops: SliceState<RendererLoopSpec[]>;
  // Live host status: active invocations + in-flight gauge + per-loop lineage.
  status: SliceState<RendererLoopStatusResult | null>;
};

function initialSlice<T>(data: T): SliceState<T> {
  return { status: 'loading', data, error: null };
}

const INITIAL_STATE: LoopsState = {
  lastRefreshedAt: null,
  refreshing: false,
  loops: initialSlice<RendererLoopSpec[]>([]),
  status: initialSlice<RendererLoopStatusResult | null>(null),
};

const store = createSnapshotStore<LoopsState>(INITIAL_STATE);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setSlice<K extends 'loops' | 'status'>(key: K, next: LoopsState[K]) {
  store.setSnapshot((current) => ({ ...current, [key]: next }));
}

// ---------------------------------------------------------------------------
// Bootstrap — Promise.allSettled across the slices (C8: real or error).
// ---------------------------------------------------------------------------

let bootstrapPromise: Promise<void> | null = null;

export async function bootstrapLoopsRegistry(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  store.setSnapshot((current) => ({ ...current, refreshing: true }));

  bootstrapPromise = Promise.allSettled([
    aceApi.loops.list(),
    aceApi.loops.status(),
  ])
    .then(([loopsRes, statusRes]) => {
      if (loopsRes.status === 'fulfilled') {
        setSlice('loops', { status: 'ready', data: loopsRes.value ?? [], error: null });
      } else {
        setSlice('loops', { status: 'error', data: [], error: errorMessage(loopsRes.reason) });
      }
      if (statusRes.status === 'fulfilled') {
        setSlice('status', { status: 'ready', data: statusRes.value, error: null });
      } else {
        setSlice('status', {
          status: 'error',
          data: null,
          error: errorMessage(statusRes.reason),
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

export async function refreshLoops(): Promise<void> {
  return bootstrapLoopsRegistry();
}

// ---------------------------------------------------------------------------
// Action helpers — re-bootstrap on success so the panes reflect the new state.
// Each surfaces the underlying result so the caller can show inline outcomes
// (validation errors, the minted invocation id) before the refresh lands.
// ---------------------------------------------------------------------------

export async function compileLoop(text: string): Promise<RendererLoopCompileResult> {
  return aceApi.loops.compile({ text });
}

export async function lockOnLoop(
  draft: RendererLoopSpecDraft
): Promise<RendererLoopLockOnResult> {
  const result = await aceApi.loops.lockOn({ draft });
  return result;
}

export async function saveLoop(spec: RendererLoopSpec): Promise<RendererLoopSpec> {
  const saved = await aceApi.loops.save({ spec });
  await refreshLoops();
  return saved;
}

export async function runLoop(
  loopId: string,
  inputs?: Record<string, unknown>
): Promise<RendererLoopRunResult> {
  const result = await aceApi.loops.run({ loopId, inputs });
  await refreshLoops();
  return result;
}

export async function stopLoop(invocationId: string): Promise<{ stopped: boolean }> {
  const result = await aceApi.loops.stop({ invocationId });
  await refreshLoops();
  return result;
}

export async function removeLoop(id: string): Promise<{ removed: boolean }> {
  const result = await aceApi.loops.remove({ id });
  await refreshLoops();
  return result;
}

export async function killAllLoops(): Promise<{ ok: true }> {
  const result = await aceApi.loops.killAll();
  await refreshLoops();
  return result;
}

export async function getLoop(id: string): Promise<RendererLoopSpec | null> {
  return aceApi.loops.get({ id });
}

// ---------------------------------------------------------------------------
// Hook — mount + subscribe with a 250ms debounce (copied from operations-registry).
// Loop iterations land as real runs on the run-ledger, so the same state-changed /
// git-changed / stream-event pushes that move the run board also re-pull loop
// status. No polling, zero agent tokens.
// ---------------------------------------------------------------------------

export function useLoopsData(): LoopsState {
  useEffect(() => {
    void bootstrapLoopsRegistry();

    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refreshLoops();
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
  }, []);

  return useStoreValue(store);
}

export function getLoopsSnapshot(): LoopsState {
  return store.getSnapshot();
}
