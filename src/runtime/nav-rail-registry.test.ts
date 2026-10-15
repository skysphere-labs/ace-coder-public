import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NAV_RAIL_COLLAPSED_WIDTH,
  NAV_RAIL_EXPANDED_WIDTH,
  __resetNavRailForTests,
  isPinned,
  setPinned,
  toggleNavRailPinned,
} from './nav-rail-registry';

const STORAGE_KEY = 'ace:nav-rail-v1';

// Map-backed localStorage stub — the module reads the global `localStorage`
// (which is undefined under the node test env), so persistence/load tests stub
// it explicitly. Matches the workspace-folders-registry test style.
function makeStorage(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe('nav-rail-registry width constants', () => {
  it('exposes the collapsed and expanded rail widths', () => {
    expect(NAV_RAIL_COLLAPSED_WIDTH).toBe(56);
    expect(NAV_RAIL_EXPANDED_WIDTH).toBe(208);
    expect(NAV_RAIL_EXPANDED_WIDTH).toBeGreaterThan(NAV_RAIL_COLLAPSED_WIDTH);
  });
});

describe('pinned state (in-memory)', () => {
  afterEach(() => __resetNavRailForTests());

  it('defaults to unpinned', () => {
    expect(isPinned()).toBe(false);
  });

  it('setPinned and toggle flip the flag', () => {
    setPinned(true);
    expect(isPinned()).toBe(true);
    toggleNavRailPinned();
    expect(isPinned()).toBe(false);
    toggleNavRailPinned();
    expect(isPinned()).toBe(true);
  });

  it('setPinned is idempotent when the value is unchanged', () => {
    setPinned(false);
    expect(isPinned()).toBe(false);
    setPinned(true);
    setPinned(true);
    expect(isPinned()).toBe(true);
  });
});

describe('persistence', () => {
  afterEach(() => {
    __resetNavRailForTests();
    vi.unstubAllGlobals();
  });

  it('writes the pinned flag to localStorage', () => {
    const ls = makeStorage();
    vi.stubGlobal('localStorage', ls);
    setPinned(true);
    expect(ls.store.get(STORAGE_KEY)).toBe(JSON.stringify({ pinned: true }));
  });

  it('clears the key on reset', () => {
    const ls = makeStorage();
    vi.stubGlobal('localStorage', ls);
    setPinned(true);
    expect(ls.store.has(STORAGE_KEY)).toBe(true);
    __resetNavRailForTests();
    expect(ls.store.has(STORAGE_KEY)).toBe(false);
  });
});

describe('load from storage (fresh module init)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function freshModule(seed?: Record<string, string>) {
    vi.stubGlobal('localStorage', makeStorage(seed));
    vi.resetModules();
    return import('./nav-rail-registry');
  }

  it('rehydrates pinned:true from storage', async () => {
    const mod = await freshModule({ [STORAGE_KEY]: JSON.stringify({ pinned: true }) });
    expect(mod.isPinned()).toBe(true);
  });

  it('falls back to unpinned on missing storage', async () => {
    const mod = await freshModule();
    expect(mod.isPinned()).toBe(false);
  });

  it('falls back to unpinned on invalid JSON without throwing', async () => {
    const mod = await freshModule({ [STORAGE_KEY]: 'not-json{' });
    expect(mod.isPinned()).toBe(false);
  });

  it('falls back to unpinned when pinned is not a boolean', async () => {
    const mod = await freshModule({ [STORAGE_KEY]: JSON.stringify({ pinned: 'yes' }) });
    expect(mod.isPinned()).toBe(false);
  });
});
