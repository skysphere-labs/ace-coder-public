import { useSyncExternalStore } from 'react';
import { aceApi } from '../lib/ace-api';
import { destroyTerminalSession } from './terminal-registry';

// Per-task list of shell sessions. First session's streamId is `shell:${taskId}`
// (preserving the legacy single-terminal stream ID) and labels as "Terminal 1";
// additional sessions are `shell:${taskId}:${n}` where n is the ordinal.
//
// On open we reuse the lowest positive integer not currently in use, so
// closing Terminal 2 then opening a new one gives "Terminal 2" again.

export type TerminalSessions = {
  sessions: string[];
  activeId: string | null;
};

const EMPTY: TerminalSessions = { sessions: [], activeId: null };
const STORAGE_PREFIX = 'ace:terminal-sessions:';

const states = new Map<string, TerminalSessions>();
const listeners = new Map<string, Set<() => void>>();

function storageKey(taskId: string) {
  return `${STORAGE_PREFIX}${taskId}`;
}

function baseStreamId(taskId: string) {
  return `shell:${taskId}`;
}

function nthStreamId(taskId: string, n: number) {
  return n === 1 ? baseStreamId(taskId) : `shell:${taskId}:${n}`;
}

function ordinalOf(taskId: string, sessionId: string): number | null {
  if (sessionId === baseStreamId(taskId)) return 1;
  const match = new RegExp(`^shell:${taskId}:(\\d+)$`).exec(sessionId);
  return match ? Number(match[1]) : null;
}

function nextAvailableOrdinal(taskId: string, sessions: string[]): number {
  const used = new Set<number>();
  for (const id of sessions) {
    const n = ordinalOf(taskId, id);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function loadPersisted(taskId: string): TerminalSessions | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TerminalSessions>;
    if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return null;
    const sessions = parsed.sessions.filter((s): s is string => typeof s === 'string');
    if (sessions.length === 0) return null;
    const activeId =
      typeof parsed.activeId === 'string' && sessions.includes(parsed.activeId)
        ? parsed.activeId
        : sessions[0];
    return { sessions, activeId };
  } catch {
    return null;
  }
}

function persist(taskId: string, state: TerminalSessions) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(taskId), JSON.stringify(state));
  } catch {}
}

function ensure(taskId: string): TerminalSessions {
  const existing = states.get(taskId);
  if (existing) return existing;
  const persisted = loadPersisted(taskId);
  if (persisted) {
    states.set(taskId, persisted);
    return persisted;
  }
  const first = baseStreamId(taskId);
  const created: TerminalSessions = { sessions: [first], activeId: first };
  states.set(taskId, created);
  return created;
}

function notify(taskId: string) {
  const set = listeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

function subscribe(taskId: string, fn: () => void): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(taskId);
  };
}

function setState(taskId: string, next: TerminalSessions) {
  states.set(taskId, next);
  persist(taskId, next);
  notify(taskId);
}

export function useTerminalSessions(taskId: string | null): TerminalSessions {
  return useSyncExternalStore(
    (fn) => (taskId ? subscribe(taskId, fn) : () => {}),
    () => (taskId ? ensure(taskId) : EMPTY),
    () => EMPTY
  );
}

export function openTerminalSession(taskId: string): string {
  const current = ensure(taskId);
  const ordinal = nextAvailableOrdinal(taskId, current.sessions);
  const id = nthStreamId(taskId, ordinal);
  // Insert in ordinal order so the tab strip stays sorted even after reuse.
  const sessions = [...current.sessions, id].sort((a, b) => {
    const oa = ordinalOf(taskId, a) ?? Number.MAX_SAFE_INTEGER;
    const ob = ordinalOf(taskId, b) ?? Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
  setState(taskId, { sessions, activeId: id });
  return id;
}

export function selectTerminalSession(taskId: string, sessionId: string) {
  const current = ensure(taskId);
  if (current.activeId === sessionId) return;
  if (!current.sessions.includes(sessionId)) return;
  setState(taskId, { ...current, activeId: sessionId });
}

export function closeTerminalSession(taskId: string, sessionId: string) {
  const current = ensure(taskId);
  const idx = current.sessions.indexOf(sessionId);
  if (idx < 0) return;
  const sessions = current.sessions.filter((s) => s !== sessionId);
  let activeId = current.activeId;
  if (activeId === sessionId) {
    activeId = sessions[Math.max(0, idx - 1)] ?? null;
  }
  // Kill the PTY and tear down the xterm session so nothing leaks. We never
  // close the only remaining tab (the UI hides the X in that case), so this
  // is always safe — the primary shell survives.
  void aceApi.sessions.killShellStream(sessionId).catch(() => undefined);
  destroyTerminalSession(sessionId);
  if (sessions.length === 0) {
    const first = baseStreamId(taskId);
    setState(taskId, { sessions: [first], activeId: first });
    return;
  }
  setState(taskId, { sessions, activeId });
}

export function terminalSessionLabel(taskId: string, sessionId: string): string {
  const n = ordinalOf(taskId, sessionId);
  return n === null ? 'Terminal' : `Terminal ${n}`;
}
