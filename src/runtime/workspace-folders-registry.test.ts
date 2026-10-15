import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEY,
  UNGROUPED_ID,
  __resetWorkspaceFoldersForTests,
  applyAutoSuggestions,
  assignWorkspace,
  createFolder,
  deriveGroupKey,
  folderForWorkspace,
  listFolders,
  reconcile,
  setCollapsed,
} from './workspace-folders-registry';

beforeEach(() => __resetWorkspaceFoldersForTests());

describe('deriveGroupKey (pure, generic — no hardcoded org)', () => {
  it('parses a github owner/repo', () => {
    expect(deriveGroupKey({ githubRepo: 'acme/web' })).toEqual({
      host: 'github.com', org: 'acme', label: 'acme',
    });
  });
  it('parses a github URL form', () => {
    expect(deriveGroupKey({ githubRepo: 'https://github.com/org-x/repo' })?.org).toBe('org-x');
  });
  it('parses an scp-style git remote in path', () => {
    expect(deriveGroupKey({ path: 'git@gitlab.com:team/proj.git' })).toEqual({
      host: 'gitlab.com', org: 'team', label: 'team',
    });
  });
  it('parses an https git remote in path and strips .git', () => {
    expect(deriveGroupKey({ path: 'https://bitbucket.org/grp/repo.git' })).toEqual({
      host: 'bitbucket.org', org: 'grp', label: 'grp',
    });
  });
  it('falls back to the local parent directory', () => {
    expect(deriveGroupKey({ path: '/Users/me/dev/parentdir/repo' })).toEqual({
      host: 'local', org: 'parentdir', label: 'parentdir',
    });
  });
  it('returns null when nothing meaningful', () => {
    expect(deriveGroupKey({ path: 'garbage' })).toBeNull();
    expect(deriveGroupKey({})).toBeNull();
  });
});

describe('folder membership', () => {
  it('keeps a workspace in at most one folder (assign moves it)', () => {
    const a = createFolder('A');
    const b = createFolder('B');
    assignWorkspace('w1', a);
    expect(folderForWorkspace('w1')).toBe(a);
    assignWorkspace('w1', b);
    expect(folderForWorkspace('w1')).toBe(b);
  });
  it('assigning null moves a workspace to Ungrouped', () => {
    const a = createFolder('A');
    assignWorkspace('w1', a);
    assignWorkspace('w1', null);
    expect(folderForWorkspace('w1')).toBeNull();
  });
  it('listFolders excludes the Ungrouped bucket and sorts by order', () => {
    createFolder('First');
    createFolder('Second');
    setCollapsed(UNGROUPED_ID, true); // creates the virtual placeholder
    const ids = listFolders().map((f) => f.name);
    expect(ids).toEqual(['First', 'Second']);
  });
});

describe('reconcile (orphan cleanup)', () => {
  it('strips memberships for dead workspaces', () => {
    const a = createFolder('A');
    assignWorkspace('w1', a);
    assignWorkspace('w2', a);
    reconcile(['w2']);
    expect(folderForWorkspace('w1')).toBeNull();
    expect(folderForWorkspace('w2')).toBe(a);
  });
  it('prunes empty AUTO folders but keeps empty manual folders', () => {
    applyAutoSuggestions([
      { id: 'w1', githubRepo: 'acme/a' },
      { id: 'w2', githubRepo: 'acme/b' },
    ]);
    const manual = createFolder('Keep me');
    expect(listFolders().some((f) => f.auto)).toBe(true);
    reconcile([]); // every workspace gone
    const names = listFolders();
    expect(names.some((f) => f.auto)).toBe(false); // auto pruned
    expect(names.some((f) => f.id === manual)).toBe(true); // manual kept
  });
});

describe('applyAutoSuggestions', () => {
  it('creates one folder per ≥2-member group and leaves singletons ungrouped', () => {
    applyAutoSuggestions([
      { id: 'w1', githubRepo: 'acme/a' },
      { id: 'w2', githubRepo: 'acme/b' },
      { id: 'w3', githubRepo: 'solo/x' },
    ]);
    const folders = listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0].workspaceIds.sort()).toEqual(['w1', 'w2']);
    expect(folderForWorkspace('w3')).toBeNull();
  });
  it('is idempotent and never moves a manually-filed workspace', () => {
    const list = [
      { id: 'w1', githubRepo: 'acme/a' },
      { id: 'w2', githubRepo: 'acme/b' },
    ];
    applyAutoSuggestions(list);
    const manual = createFolder('Mine');
    assignWorkspace('w1', manual); // user override
    applyAutoSuggestions(list); // re-run
    expect(folderForWorkspace('w1')).toBe(manual); // not clobbered
    expect(listFolders().filter((f) => f.auto)).toHaveLength(1); // no duplicate auto folder
  });
});

describe('persistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal('window', { localStorage: ls });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('writes the versioned key after the debounce', () => {
    const a = createFolder('Persisted');
    setCollapsed(a, true);
    vi.advanceTimersByTime(300);
    const raw = store.get(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.folders.find((f: { id: string }) => f.id === a)?.collapsed).toBe(true);
  });
});

afterEach(() => __resetWorkspaceFoldersForTests());
