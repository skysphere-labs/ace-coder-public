import { useSyncExternalStore } from 'react';

// Client-side workspace grouping. Folders are a presentation overlay keyed by
// workspace.id, persisted to localStorage — workspaces stay the server-owned
// source of truth, so this never touches the backend. Anything a folder does
// not claim lives in the virtual "Ungrouped" bucket. Mirrors the house registry
// style (module state + listener set + useSyncExternalStore) used by
// scratch-tabs-registry / editor-registry.

export type WorkspaceFolder = {
  id: string;
  name: string;
  collapsed: boolean;
  workspaceIds: string[];
  order: number;
  // True when created by auto-suggest; auto folders are pruned once empty so a
  // transient remote payload can't leave a dead container behind. User folders
  // are kept even when empty.
  auto?: boolean;
};

// Virtual bucket id. Never a real user folder; only ever persisted to carry its
// own collapsed choice.
export const UNGROUPED_ID = '__ungrouped__';
export const STORAGE_KEY = 'ace:workspace-folders-v1';
const PERSIST_DEBOUNCE_MS = 300;

export type GroupKey = { host: string; org: string; label: string };
type FoldersState = { folders: WorkspaceFolder[] };

let state: FoldersState = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function load(): FoldersState {
  if (typeof window === 'undefined') return { folders: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { folders: [] };
    const parsed = JSON.parse(raw) as { folders?: unknown };
    if (!parsed || !Array.isArray(parsed.folders)) return { folders: [] };
    const folders = parsed.folders
      .filter(
        (f): f is WorkspaceFolder =>
          !!f &&
          typeof (f as WorkspaceFolder).id === 'string' &&
          typeof (f as WorkspaceFolder).name === 'string' &&
          Array.isArray((f as WorkspaceFolder).workspaceIds)
      )
      .map((f, i) => ({
        id: f.id,
        name: f.name,
        collapsed: !!f.collapsed,
        workspaceIds: f.workspaceIds.filter((w) => typeof w === 'string'),
        order: typeof f.order === 'number' ? f.order : i,
        auto: !!f.auto,
      }));
    return { folders };
  } catch {
    return { folders: [] };
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, folders: state.folders }));
    } catch {
      // Quota / Safari private mode — grouping is a nice-to-have, not critical.
    }
  }, PERSIST_DEBOUNCE_MS);
}

function notify() {
  for (const fn of listeners) fn();
}

function commit(folders: WorkspaceFolder[]) {
  state = { folders };
  persist();
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): FoldersState {
  return state;
}

export function useWorkspaceFolders(): FoldersState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function genId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// --- queries -------------------------------------------------------------

// User folders only (Ungrouped excluded), sorted by display order.
export function listFolders(): WorkspaceFolder[] {
  return state.folders
    .filter((f) => f.id !== UNGROUPED_ID)
    .slice()
    .sort((a, b) => a.order - b.order);
}

export function folderForWorkspace(wsId: string): string | null {
  for (const f of state.folders) {
    if (f.id !== UNGROUPED_ID && f.workspaceIds.includes(wsId)) return f.id;
  }
  return null;
}

export function isCollapsed(id: string): boolean {
  return state.folders.find((f) => f.id === id)?.collapsed ?? false;
}

// --- mutations -----------------------------------------------------------

export function createFolder(name: string): string {
  const id = genId('fld');
  const order = state.folders.reduce((m, f) => Math.max(m, f.order), -1) + 1;
  commit([...state.folders, { id, name: name.trim() || 'Folder', collapsed: false, workspaceIds: [], order }]);
  return id;
}

export function renameFolder(id: string, name: string): void {
  commit(state.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)));
}

export function deleteFolder(id: string): void {
  // Members fall back to Ungrouped simply by dropping the folder.
  commit(state.folders.filter((f) => f.id !== id));
}

export function setCollapsed(id: string, collapsed: boolean): void {
  const existing = state.folders.find((f) => f.id === id);
  if (existing) {
    commit(state.folders.map((f) => (f.id === id ? { ...f, collapsed } : f)));
    return;
  }
  // Allow the virtual Ungrouped bucket to persist its collapsed choice via a
  // placeholder record (filtered out of listFolders).
  const order = state.folders.reduce((m, f) => Math.max(m, f.order), -1) + 1;
  commit([...state.folders, { id, name: '', collapsed, workspaceIds: [], order }]);
}

// Move a workspace into folderId (null → Ungrouped). A workspace lives in at
// most one folder, so it is removed from any other first.
export function assignWorkspace(wsId: string, folderId: string | null): void {
  let folders = state.folders.map((f) =>
    f.workspaceIds.includes(wsId)
      ? { ...f, workspaceIds: f.workspaceIds.filter((w) => w !== wsId) }
      : f
  );
  if (folderId && folderId !== UNGROUPED_ID) {
    folders = folders.map((f) =>
      f.id === folderId ? { ...f, workspaceIds: [...f.workspaceIds, wsId] } : f
    );
  }
  commit(folders);
}

export function reorderFolders(orderedIds: string[]): void {
  const index = new Map(orderedIds.map((id, i) => [id, i]));
  commit(state.folders.map((f) => (index.has(f.id) ? { ...f, order: index.get(f.id)! } : f)));
}

export function reorderWithinFolder(folderId: string, orderedWsIds: string[]): void {
  commit(
    state.folders.map((f) =>
      f.id === folderId ? { ...f, workspaceIds: orderedWsIds.filter((w) => f.workspaceIds.includes(w)) } : f
    )
  );
}

// --- lifecycle / integrity ----------------------------------------------

// Drop memberships for workspaces that no longer exist and prune empty AUTO
// folders. Idempotent: only commits when something actually changed.
export function reconcile(liveWorkspaceIds: string[]): void {
  const live = new Set(liveWorkspaceIds);
  let changed = false;
  const stripped = state.folders.map((f) => {
    const kept = f.workspaceIds.filter((w) => live.has(w));
    if (kept.length !== f.workspaceIds.length) {
      changed = true;
      return { ...f, workspaceIds: kept };
    }
    return f;
  });
  const pruned = stripped.filter((f) => !(f.auto && f.workspaceIds.length === 0));
  if (pruned.length !== stripped.length) changed = true;
  if (changed) commit(pruned);
}

// PURE — exported for unit tests. Derive a stable group key from a workspace's
// repo/path. Generic: never hardcodes a specific org. Order: github owner →
// git remote URL → local parent directory.
export function deriveGroupKey(input: { path?: string | null; githubRepo?: string | null }): GroupKey | null {
  const repo = (input.githubRepo ?? '').trim();
  if (repo) {
    const segs = repo.replace(/^https?:\/\/[^/]+\//, '').split('/').filter(Boolean);
    const org = segs[0];
    if (org) return { host: 'github.com', org, label: org };
  }
  const path = (input.path ?? '').trim();
  if (path) {
    // git@host:org/repo(.git)
    const scp = path.match(/^[^@\s]+@([^:\s]+):([^/\s]+)\/[^/\s]+?(?:\.git)?$/);
    if (scp) return { host: scp[1], org: scp[2], label: scp[2] };
    // (https|ssh)://[user@]host/org/repo(.git)
    const url = path.match(/^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/[^/\s]+?(?:\.git)?$/);
    if (url) return { host: url[1], org: url[2], label: url[2] };
    // local filesystem path → parent directory groups sibling repos
    const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) {
      const org = parts[parts.length - 2];
      if (org) return { host: 'local', org, label: org };
    }
  }
  return null;
}

// Suggest (never force) folders: create an `auto:` folder per group with ≥2
// members and file only currently-Ungrouped workspaces into it. Idempotent —
// the folder id is deterministic and manual assignments are never moved.
export function applyAutoSuggestions(
  workspaces: { id: string; path?: string | null; githubRepo?: string | null }[]
): void {
  const assigned = new Set<string>();
  for (const f of state.folders) for (const w of f.workspaceIds) assigned.add(w);

  const groups = new Map<string, { key: GroupKey; ids: string[] }>();
  for (const ws of workspaces) {
    if (assigned.has(ws.id)) continue;
    const key = deriveGroupKey(ws);
    if (!key) continue;
    const id = `auto:${key.host}/${key.org}`;
    const g = groups.get(id) ?? { key, ids: [] };
    g.ids.push(ws.id);
    groups.set(id, g);
  }

  const folders = state.folders.map((f) => ({ ...f, workspaceIds: [...f.workspaceIds] }));
  let changed = false;
  let maxOrder = folders.reduce((m, f) => Math.max(m, f.order), -1);
  for (const [id, g] of groups) {
    if (g.ids.length < 2) continue;
    let folder = folders.find((f) => f.id === id);
    if (!folder) {
      folder = { id, name: g.key.label, collapsed: false, workspaceIds: [], order: ++maxOrder, auto: true };
      folders.push(folder);
      changed = true;
    }
    for (const w of g.ids) {
      if (!folder.workspaceIds.includes(w)) {
        folder.workspaceIds.push(w);
        changed = true;
      }
    }
  }
  if (changed) commit(folders);
}

// Test-only reset so the singleton doesn't leak state across unit tests.
export function __resetWorkspaceFoldersForTests(): void {
  state = { folders: [] };
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
