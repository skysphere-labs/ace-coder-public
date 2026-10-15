import { describe, expect, it } from 'vitest';
import { createMemoizedSelector, deepEqual, shallowEqual } from './create-snapshot-store';

type Task = { id: string; title: string };
type Workspace = { id: string; name: string; isPersonal?: boolean; tasks: Task[] };
type Snapshot = { workspaces: Workspace[] };

// Model an Electron IPC state push: the whole snapshot is re-parsed into brand
// new references on every emit, even when the underlying data is unchanged.
function ipcClone(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

const base: Snapshot = {
  workspaces: [
    { id: 'a', name: 'Alpha', tasks: [{ id: 't1', title: 'one' }] },
    { id: 'b', name: 'Beta', tasks: [{ id: 't2', title: 'two' }] },
  ],
};

describe('shallowEqual', () => {
  it('compares one level by Object.is', () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    const shared = {};
    expect(shallowEqual({ x: shared }, { x: shared })).toBe(true);
    // Different nested references are NOT shallow-equal (this is why the IPC
    // slices need deepEqual, not shallowEqual).
    expect(shallowEqual({ x: {} }, { x: {} })).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual({ a: 1 }, null)).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('deepEqual', () => {
  it('treats structurally identical nested values as equal', () => {
    expect(deepEqual(base, ipcClone(base))).toBe(true);
  });

  it('detects a deeply nested change', () => {
    const changed = ipcClone(base);
    changed.workspaces[0].tasks[0].title = 'ONE';
    expect(deepEqual(base, changed)).toBe(false);
  });

  it('handles null, arrays, and length changes', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual({ a: null }, { a: null })).toBe(true);
    expect(deepEqual(null, { a: 1 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('compares Date values by timestamp, not identity', () => {
    expect(deepEqual(new Date(10), new Date(10))).toBe(true);
    expect(deepEqual(new Date(10), new Date(11))).toBe(false);
  });
});

describe('createMemoizedSelector — unchanged slice yields a stable reference (no re-render)', () => {
  it('returns a reference-stable value across IPC-fresh snapshots with identical data', () => {
    const select = (s: Snapshot) => s.workspaces.filter((w) => !w.isPersonal);
    const memoized = createMemoizedSelector(select, deepEqual);

    const first = memoized(base);
    const second = memoized(ipcClone(base)); // new object graph, identical data

    // useSyncExternalStore re-renders iff getSnapshot() changes by Object.is,
    // so a stable reference here proves the consumer would NOT re-render.
    expect(second).toBe(first);
  });

  it('returns a new reference when the selected slice actually changes', () => {
    const select = (s: Snapshot) => s.workspaces.find((w) => w.id === 'a') ?? null;
    const memoized = createMemoizedSelector(select, deepEqual);

    const first = memoized(base);
    const changed = ipcClone(base);
    changed.workspaces[0].name = 'Alpha renamed';
    const second = memoized(changed);

    expect(second).not.toBe(first);
    expect(second?.name).toBe('Alpha renamed');
  });

  it('bails out for one workspace when a DIFFERENT workspace changes', () => {
    // The high-value case: a mutation in workspace "b" must not re-render a
    // consumer selecting workspace "a".
    const selectA = (s: Snapshot) => s.workspaces.find((w) => w.id === 'a') ?? null;
    const memoized = createMemoizedSelector(selectA, deepEqual);

    const first = memoized(base);
    const bChanged = ipcClone(base);
    bChanged.workspaces[1].tasks.push({ id: 't3', title: 'three' });
    const second = memoized(bChanged);

    expect(second).toBe(first);
  });

  it('is consistent: selecting the same snapshot twice returns the same value', () => {
    const select = (s: Snapshot) => s.workspaces;
    const memoized = createMemoizedSelector(select, deepEqual);

    const first = memoized(base);
    const again = memoized(base);
    expect(again).toBe(first);
  });

  it('recomputes when the selector is rebuilt (arg change) without returning a stale value', () => {
    // Models useMemo rebuilding the memoized selector when a hook argument
    // (e.g. workspaceId) changes, carrying the previously committed value.
    const committed = { hasValue: true, value: base.workspaces[0] as Workspace | null };
    const selectB = (s: Snapshot) => s.workspaces.find((w) => w.id === 'b') ?? null;
    const memoized = createMemoizedSelector(selectB, deepEqual, committed);

    const result = memoized(ipcClone(base));
    expect(result?.id).toBe('b');
  });

  it('bails against the committed value on the first read after a rebuild', () => {
    const catalog = base.workspaces;
    const committed = { hasValue: true, value: catalog };
    const select = (s: Snapshot) => s.workspaces;
    const memoized = createMemoizedSelector(select, deepEqual, committed);

    // Fresh snapshot, identical data -> should return the already-committed ref.
    const result = memoized(ipcClone(base));
    expect(result).toBe(catalog);
  });
});
