import { useSyncExternalStore } from 'react';
import { aceApi, type StreamState } from '../lib/ace-api';

type StreamState = { state: StreamState };
const DEFAULT_STATE: StreamState = { state: 'unknown' };

const states = new Map<string, StreamState>();
const listeners = new Map<string, Set<() => void>>();
const refs = new Map<string, number>();
let globalUnsub: null | (() => void) = null;

function patch(streamId: string, delta: Partial<StreamState>) {
  const current = states.get(streamId) || DEFAULT_STATE;
  const next = { ...current, ...delta };
  states.set(streamId, next);
  const set = listeners.get(streamId);
  if (set) for (const fn of set) fn();
}

function startGlobalSub() {
  if (globalUnsub) return;
  globalUnsub = aceApi.streams.onEvent((payload) => {
    if (payload?.event !== 'state-change') return;
    const p = payload.payload as { streamId?: string; to?: StreamState };
    if (!p?.streamId) return;
    if (p.to) patch(p.streamId, { state: p.to });
  });
}

export function attachStreamState(streamId: string): () => void {
  startGlobalSub();
  const next = (refs.get(streamId) || 0) + 1;
  refs.set(streamId, next);
  if (next === 1) {
    void aceApi.streams.getState(streamId).then((r) => patch(streamId, { state: r.state }));
  }
  return () => {
    const n = (refs.get(streamId) || 1) - 1;
    if (n <= 0) refs.delete(streamId);
    else refs.set(streamId, n);
  };
}

function subscribe(streamId: string, fn: () => void): () => void {
  let set = listeners.get(streamId);
  if (!set) {
    set = new Set();
    listeners.set(streamId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(streamId);
  };
}

export function useStreamState(streamId: string | null): StreamState {
  return useSyncExternalStore(
    (fn) => (streamId ? subscribe(streamId, fn) : () => {}),
    () => (streamId ? states.get(streamId) || DEFAULT_STATE : DEFAULT_STATE),
    () => DEFAULT_STATE
  );
}
