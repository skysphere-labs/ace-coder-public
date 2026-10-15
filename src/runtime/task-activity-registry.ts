// Per-task "is the agent actively working?" + "did it finish something I
// haven't looked at?" tracking. The stored task.status on the backend is
// always 'idle' today, so we synthesize this client-side from PTY activity:
// any byte of output on a task's terminal stream marks it busy;
// IDLE_DEBOUNCE_MS of silence flips it back. Quiescence beats prompt-string
// matching: no false positives on custom shells.
//
// A task is busy if any of its conversations (threads) OR any of its
// variants (tasks-with-worktrees) is busy. Busy→idle transitions that
// lasted at least MIN_BUSY_MS and happen on a task the user isn't
// currently viewing are added to the unread set. SHORTER busy periods are
// treated as view-switch noise (PTY respawn) and dropped.
import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import { createSnapshotStore, useStoreSelector } from './create-snapshot-store';
import { getCoreSnapshot } from './core-registry';

const IDLE_DEBOUNCE_MS = 2000;
const MIN_BUSY_MS = 3000;

type ConvState = { busy: boolean; busySince: number | null };

// Keyed by the backend stream id (without prefix). For conversations that
// means `conv:<uuid>`, for variants `variant:<uuid>`. We track them by
// their full stream key so the PTY listener and chat listener don't alias
// each other.
const convState = new Map<string, ConvState>();
const cliIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const taskLastBusyStart = new Map<string, number>();

const busyStore = createSnapshotStore<Set<string>>(new Set());
const unreadStore = createSnapshotStore<Set<string>>(new Set());
let prevBusy: Set<string> = new Set();
let currentTaskId: string | null = null;
let initialized = false;

type TaskRef = { id: string; streamKeys: string[] };

function listAllTasks(): TaskRef[] {
  const snap = getCoreSnapshot();
  const tasks: TaskRef[] = [];
  for (const ws of snap.workspaces) {
    for (const t of [...ws.tasks, ...ws.archivedTasks]) {
      const keys: string[] = [];
      for (const c of t.conversations ?? []) keys.push(`conversation:${c.id}`);
      for (const wt of t.worktrees ?? []) {
        for (const v of wt.variants ?? []) keys.push(`variant:${v.id}`);
      }
      tasks.push({ id: t.id, streamKeys: keys });
    }
  }
  return tasks;
}

function recompute() {
  const tasks = listAllTasks();
  const nextBusy = new Set<string>();
  const nowMs = Date.now();
  for (const task of tasks) {
    for (const key of task.streamKeys) {
      if (convState.get(key)?.busy) {
        nextBusy.add(task.id);
        if (!taskLastBusyStart.has(task.id)) taskLastBusyStart.set(task.id, nowMs);
        break;
      }
    }
  }

  let unreadChanged = false;
  const nextUnread = new Set(unreadStore.getSnapshot());
  for (const taskId of prevBusy) {
    if (nextBusy.has(taskId)) continue;
    const busySince = taskLastBusyStart.get(taskId);
    taskLastBusyStart.delete(taskId);
    // View switches / PTY respawns / chat restarts can trigger brief busy
    // periods that look like turns but aren't. Require a minimum duration
    // so those don't promote to "agent finished" pips.
    if (!busySince || nowMs - busySince < MIN_BUSY_MS) continue;
    if (taskId === currentTaskId) continue;
    if (!nextUnread.has(taskId)) {
      nextUnread.add(taskId);
      unreadChanged = true;
    }
  }
  if (currentTaskId && nextUnread.has(currentTaskId)) {
    nextUnread.delete(currentTaskId);
    unreadChanged = true;
  }
  prevBusy = nextBusy;
  busyStore.setSnapshot(nextBusy);
  if (unreadChanged) unreadStore.setSnapshot(nextUnread);
}

function setConvBusy(streamKey: string, busy: boolean) {
  const prev = convState.get(streamKey);
  if (prev && prev.busy === busy) return;
  convState.set(streamKey, {
    busy,
    busySince: busy ? (prev?.busySince ?? Date.now()) : null,
  });
  recompute();
}

function markCliActivity(streamKey: string) {
  setConvBusy(streamKey, true);
  const existing = cliIdleTimers.get(streamKey);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cliIdleTimers.delete(streamKey);
    setConvBusy(streamKey, false);
  }, IDLE_DEBOUNCE_MS);
  cliIdleTimers.set(streamKey, t);
}

function ensureInit() {
  if (initialized) return;
  initialized = true;

  // PTY data fires for both conversation and variant streams. Use the full
  // stream id as the key — listAllTasks() builds the same keys when
  // aggregating, so they line up.
  aceApi.core.onPtyData(({ id }) => {
    if (!id.startsWith('conversation:') && !id.startsWith('variant:')) return;
    markCliActivity(id);
  });

  aceApi.core.onPtyExit(({ id }) => {
    if (!id.startsWith('conversation:') && !id.startsWith('variant:')) return;
    const existing = cliIdleTimers.get(id);
    if (existing) clearTimeout(existing);
    cliIdleTimers.delete(id);
    setConvBusy(id, false);
  });

  // Remote clients only receive pty:data for streams they subscribed to (the
  // on-screen terminal), so the byte-quiescence heuristic above goes blind for
  // everything else — a phone on the Today dashboard would show no Active
  // tasks while ten agents stream. state-change events ride the stream:event
  // channel, which the server forwards to every client unfiltered, so they
  // carry the busy signal for off-screen streams on both desktop and remote.
  // The two sources compose: state 'busy'/'booting' latches busy (and cancels
  // the quiescence timer so silence can't flip a working agent idle); any
  // settled state clears it, exactly like pty:exit does.
  aceApi.streams.onEvent((p) => {
    if (p?.event !== 'state-change') return;
    const payload = p.payload as { streamId?: string; to?: string } | undefined;
    const id = payload?.streamId;
    const to = payload?.to;
    if (!id || !to) return;
    if (!id.startsWith('conversation:') && !id.startsWith('variant:')) return;
    if (to === 'busy' || to === 'booting') {
      const existing = cliIdleTimers.get(id);
      if (existing) {
        clearTimeout(existing);
        cliIdleTimers.delete(id);
      }
      setConvBusy(id, true);
    } else {
      const existing = cliIdleTimers.get(id);
      if (existing) {
        clearTimeout(existing);
        cliIdleTimers.delete(id);
      }
      setConvBusy(id, false);
    }
  });

  aceApi.core.subscribe(() => recompute());
}

// The set of task ids with a live (PTY-active) agent — the REAL "running"
// signal, since the backend task.status is always 'idle'. Cross-workspace
// consumers (e.g. the Today dashboard Active list) read this instead of
// task.status.
export function useBusyTaskIds(): Set<string> {
  useEffect(() => {
    ensureInit();
  }, []);
  return useStoreSelector(busyStore, (s) => s);
}

export function useTaskActivity(taskId: string | null | undefined): {
  busy: boolean;
  unread: boolean;
} {
  useEffect(() => {
    ensureInit();
  }, []);
  const busy = useStoreSelector(busyStore, (s) => (taskId ? s.has(taskId) : false));
  const unread = useStoreSelector(unreadStore, (s) => (taskId ? s.has(taskId) : false));
  return { busy, unread };
}

export function setCurrentTask(taskId: string | null) {
  ensureInit();
  if (currentTaskId === taskId) return;
  currentTaskId = taskId;
  // Any unread pip on the task we just focused is cleared — no need to
  // make the user click the sidebar row they already navigated into.
  if (taskId) markTaskRead(taskId);
}

export function markTaskRead(taskId: string) {
  ensureInit();
  const current = unreadStore.getSnapshot();
  if (!current.has(taskId)) return;
  const next = new Set(current);
  next.delete(taskId);
  unreadStore.setSnapshot(next);
}
