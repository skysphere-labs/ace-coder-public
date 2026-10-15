import { useMemo, useSyncExternalStore } from 'react';

type Listener = () => void;

type SnapshotStore<T> = {
  getSnapshot: () => T;
  subscribe: (listener: Listener) => () => void;
  setSnapshot: (next: T | ((current: T) => T)) => T;
};

export function createSnapshotStore<T>(initialState: T): SnapshotStore<T> {
  let snapshot = initialState;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSnapshot: (next) => {
      const updated = typeof next === 'function' ? (next as (current: T) => T)(snapshot) : next;
      if (Object.is(updated, snapshot)) return snapshot;
      snapshot = updated;
      notify();
      return snapshot;
    },
  };
}

export function useStoreValue<T>(store: SnapshotStore<T>) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useStoreSelector<T, U>(store: SnapshotStore<T>, select: (snapshot: T) => U) {
  return select(useStoreValue(store));
}

/** One-level Object.is comparison of two values' own enumerable keys. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key) || !Object.is(aObj[key], bObj[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Structural (recursive) value comparison. Needed for slices that come off the
 * IPC state push: Electron re-parses the whole snapshot into fresh references on
 * every emit, so a shallow comparison of a workspace/task/list would never bail
 * out even when the underlying data is unchanged. deepEqual bails iff the data
 * is value-identical, so it can never drop a legitimate update.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

type SelectorMemoState<U> = { hasValue: boolean; value: U | undefined };

/**
 * Pure selector memoizer that mirrors React's `useSyncExternalStoreWithSelector`
 * bail-out: given a store snapshot it returns a REFERENCE-STABLE selected value
 * as long as `isEqual(previousSelection, nextSelection)` holds. Exported so the
 * bail-out can be unit-tested without a React renderer — `useSyncExternalStore`
 * re-renders iff the value returned here changes by `Object.is`, so a stable
 * reference is exactly "no re-render".
 *
 * `committed` carries the last value that was committed to the DOM so that when
 * the hook rebuilds this memoizer (e.g. the selector closure changed because a
 * hook argument changed) it can still bail against the real committed value.
 */
export function createMemoizedSelector<T, U>(
  selector: (snapshot: T) => U,
  isEqual: (a: U, b: U) => boolean,
  committed: SelectorMemoState<U> = { hasValue: false, value: undefined }
): (snapshot: T) => U {
  let hasMemo = false;
  let memoSnapshot: T;
  let memoSelection: U;
  return (nextSnapshot: T): U => {
    if (!hasMemo) {
      hasMemo = true;
      memoSnapshot = nextSnapshot;
      const nextSelection = selector(nextSnapshot);
      if (committed.hasValue) {
        const current = committed.value as U;
        if (isEqual(current, nextSelection)) {
          memoSelection = current;
          return current;
        }
      }
      memoSelection = nextSelection;
      return nextSelection;
    }
    if (Object.is(memoSnapshot, nextSnapshot)) {
      return memoSelection;
    }
    const nextSelection = selector(nextSnapshot);
    if (isEqual(memoSelection, nextSelection)) {
      memoSnapshot = nextSnapshot;
      return memoSelection;
    }
    memoSnapshot = nextSnapshot;
    memoSelection = nextSelection;
    return nextSelection;
  };
}

/**
 * Selector hook with a bail-out: consumers re-render only when the selected
 * slice changes under `isEqual` (default `shallowEqual`), instead of on every
 * store push. Does not change `useStoreSelector`'s semantics.
 *
 * `selector` must be referentially stable (module-scope or `useCallback`) for
 * the reference to stay stable across unrelated re-renders — an inline selector
 * still bails on store pushes but is rebuilt on every render.
 */
export function useStoreSelectorEq<T, U>(
  store: SnapshotStore<T>,
  selector: (snapshot: T) => U,
  isEqual: (a: U, b: U) => boolean = shallowEqual
): U {
  const getSelection = useMemo(() => {
    const memoized = createMemoizedSelector(selector, isEqual);
    return () => memoized(store.getSnapshot());
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
