import { useEffect, useSyncExternalStore } from 'react';
import { aceApi } from '../lib/ace-api';
import type {
  TranscriptEntry,
  TranscriptReplacePayload,
  TranscriptResetPayload,
  TranscriptResetReason,
  TranscriptSnapshot,
} from '../lib/ace-api';

export type TranscriptViewEntry = TranscriptEntry & {
  startedAt?: number;
  tokenCount?: number;
  optimisticConfirmed?: boolean;
  resetReason?: TranscriptResetReason;
};

export type TranscriptRevivalState = 'reviving' | 'recovered';

export type TranscriptCompactStatus = {
  reason: 'compact';
  state: TranscriptRevivalState;
  at: number | null;
};

type StreamState = {
  phase: 'unavailable' | 'linked' | 'streaming' | 'settled' | 'compacted' | 'cleared' | 'error';
  loading: boolean;
  error: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  hasOlder: boolean;
  available: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  agent: 'claude' | 'codex' | 'gemini' | 'hermes' | null;
  entries: TranscriptViewEntry[];
  warnings: Array<{ code: string; error?: string; tAt: number }>;
  lastResetReason: TranscriptResetReason | null;
  lastCompactedAt: number | null;
  revivalState: TranscriptRevivalState | null;
};

const TRANSCRIPT_PAGE_SIZE = 80;
const SETTLED_TRANSCRIPT_REFRESH_DELAYS_MS = [80, 180];
const DETACHED_ACTIVE_TRANSCRIPT_RELEASE_DELAY_MS = 260;

const DEFAULT_STATE: StreamState = {
  phase: 'unavailable',
  loading: false,
  error: null,
  loadingOlder: false,
  olderError: null,
  hasOlder: false,
  available: false,
  sessionId: null,
  sessionFile: null,
  agent: null,
  entries: [],
  warnings: [],
  lastResetReason: null,
  lastCompactedAt: null,
  revivalState: null,
};

const states = new Map<string, StreamState>();
const listeners = new Map<string, Set<() => void>>();
const subscribedStreams = new Set<string>();
const refCounts = new Map<string, number>();
let globalUnsub: null | (() => void) = null;
let optimisticUserEntrySeq = 0;

const OPTIMISTIC_USER_ENTRY_ID_BASE = 9_000_000_000_000;
const OPTIMISTIC_USER_ENTRY_WINDOW_MS = 5 * 60 * 1000;
// Real transcript echoes can stamp slightly before the optimistic entry when
// the agent's wall clock or session-file write lands a few hundred ms earlier
// than the client's Date.now() at send. Tolerate that skew so the real echo
// reconciles instead of leaving two duplicate Chief bubbles at the bottom.
// Kept under ~1s so older identical sends (test fixtures use 1.5s) still
// stay distinct.
const OPTIMISTIC_USER_ENTRY_BACKWARD_SKEW_MS = 750;

function ensureState(streamId: string): StreamState {
  const existing = states.get(streamId);
  if (existing) return existing;
  states.set(streamId, { ...DEFAULT_STATE });
  return states.get(streamId)!;
}

function notify(streamId: string) {
  const set = listeners.get(streamId);
  if (!set) return;
  for (const fn of set) fn();
}

function patch(streamId: string, delta: Partial<StreamState>) {
  const state = ensureState(streamId);
  const next = { ...state, ...delta };
  states.set(streamId, next);
  notify(streamId);
}

function entryTokenCount(entry: TranscriptEntry): number | undefined {
  if (entry.role !== 'agent' && entry.role !== 'reasoning') return undefined;
  const tokens = (entry as TranscriptEntry & { tokens?: number | { input?: number; output?: number; total?: number } }).tokens;
  if (!tokens) return undefined;
  if (typeof tokens === 'number') return tokens > 0 ? tokens : undefined;
  if (typeof tokens.total === 'number' && tokens.total > 0) return tokens.total;
  const input = typeof tokens.input === 'number' ? tokens.input : 0;
  const output = typeof tokens.output === 'number' ? tokens.output : 0;
  const total = input + output;
  return total > 0 ? total : undefined;
}

function extendEntry(entry: TranscriptEntry, previous?: TranscriptViewEntry): TranscriptViewEntry {
  return {
    ...entry,
    startedAt: previous?.startedAt ?? entry.tAt,
    tokenCount: entryTokenCount(entry),
  };
}

function extendEntries(entries: TranscriptEntry[]): TranscriptViewEntry[] {
  return entries.map((entry) => extendEntry(entry));
}

function sortEntries(entries: TranscriptViewEntry[]): TranscriptViewEntry[] {
  return [...entries].sort((a, b) => {
    const at = a.tAt || 0;
    const bt = b.tAt || 0;
    if (at !== bt) return at - bt;
    return a.id - b.id;
  });
}

function hasOpenTranscriptActivity(entries: TranscriptEntry[]): boolean {
  return entries.some(
    (entry) =>
      (entry.role === 'agent' || entry.role === 'reasoning' || entry.role === 'tool') &&
      entry.lifecycle === 'open'
  );
}

function isRecoveryActivity(entry: TranscriptEntry): boolean {
  return entry.role === 'agent' || entry.role === 'reasoning' || entry.role === 'tool';
}

function phaseForEntries(
  entries: TranscriptEntry[],
  fallback: StreamState['phase'] = 'linked'
): StreamState['phase'] {
  if (hasOpenTranscriptActivity(entries)) return 'streaming';
  if (entries.length > 0) return 'settled';
  return fallback === 'unavailable' || fallback === 'error' ? 'linked' : fallback;
}

function oldestRealEntryId(entries: TranscriptViewEntry[]): number | undefined {
  let oldest: number | undefined;
  for (const entry of entries) {
    if (isOptimisticUserEntry(entry)) continue;
    if (oldest === undefined || entry.id < oldest) oldest = entry.id;
  }
  return oldest;
}

function isOptimisticUserEntry(entry: TranscriptEntry): entry is Extract<TranscriptEntry, { role: 'user' }> {
  return entry.role === 'user' && entry.id >= OPTIMISTIC_USER_ENTRY_ID_BASE;
}

function isExpiredOptimisticUserEntry(entry: TranscriptEntry, now = Date.now()): boolean {
  return (
    isOptimisticUserEntry(entry) &&
    !(entry as TranscriptViewEntry).optimisticConfirmed &&
    now - entry.tAt > OPTIMISTIC_USER_ENTRY_WINDOW_MS
  );
}

function withoutExpiredOptimisticUserEntries(entries: TranscriptViewEntry[], now = Date.now()): TranscriptViewEntry[] {
  return entries.filter((entry) => !isExpiredOptimisticUserEntry(entry, now));
}

function pruneExpiredOptimisticUserEntries(streamId: string, now = Date.now()): TranscriptViewEntry[] {
  const state = ensureState(streamId);
  const entries = withoutExpiredOptimisticUserEntries(state.entries, now);
  if (entries.length !== state.entries.length) states.set(streamId, { ...state, entries });
  return entries;
}

export function matchesOptimisticUserEntry(
  optimistic: TranscriptEntry,
  real: TranscriptEntry
): boolean {
  if (!isOptimisticUserEntry(optimistic) || real.role !== 'user') return false;
  if (optimistic.text !== real.text) return false;
  const delta = real.tAt - optimistic.tAt;
  return delta >= -OPTIMISTIC_USER_ENTRY_BACKWARD_SKEW_MS && delta <= OPTIMISTIC_USER_ENTRY_WINDOW_MS;
}

export function filterPendingOptimisticUserEntries(
  realEntries: TranscriptEntry[],
  optimisticEntries: TranscriptViewEntry[],
  now = Date.now()
): TranscriptViewEntry[] {
  return optimisticEntries.filter(
    (entry) =>
      isOptimisticUserEntry(entry) &&
      !isExpiredOptimisticUserEntry(entry, now) &&
      !realEntries.some((real) => matchesOptimisticUserEntry(entry, real))
  );
}

export function pruneStaleOptimisticEntries(
  entries: TranscriptViewEntry[],
  now: number = Date.now()
): TranscriptViewEntry[] {
  const next = withoutExpiredOptimisticUserEntries(entries, now);
  return next.length === entries.length ? entries : next;
}

export function mergePendingOptimisticUserEntries(
  entries: TranscriptViewEntry[],
  optimisticEntries: TranscriptViewEntry[],
  now: number = Date.now()
): TranscriptViewEntry[] {
  const pending = filterPendingOptimisticUserEntries(entries, optimisticEntries, now);
  if (pending.length === 0) return entries;
  const existingIds = new Set(entries.map((entry) => entry.id));
  const missing = pending.filter((entry) => !existingIds.has(entry.id));
  return missing.length === 0 ? entries : sortEntries([...entries, ...missing]);
}

function aliasOptimisticUserEntries(streamId: string, sessionFile: string | null | undefined): TranscriptViewEntry[] {
  if (!sessionFile) return [];
  const optimistic: TranscriptViewEntry[] = [];
  for (const [candidateStreamId, state] of states) {
    if (candidateStreamId === streamId || state.sessionFile !== sessionFile) continue;
    optimistic.push(...withoutExpiredOptimisticUserEntries(state.entries).filter(isOptimisticUserEntry));
  }
  return optimistic;
}

function withAliasOptimisticUserEntries(
  streamId: string,
  entries: TranscriptViewEntry[],
  sessionFile: string | null | undefined
): TranscriptViewEntry[] {
  return mergePendingOptimisticUserEntries(entries, aliasOptimisticUserEntries(streamId, sessionFile));
}

function withPendingOptimisticEntries(streamId: string, entries: TranscriptEntry[]): TranscriptViewEntry[] {
  const extended = extendEntries(entries);
  const stateEntries = pruneExpiredOptimisticUserEntries(streamId);
  const optimistic = stateEntries.filter(isOptimisticUserEntry);
  const pending = filterPendingOptimisticUserEntries(extended, optimistic);
  if (pending.length !== optimistic.length) {
    const pendingIds = new Set(pending.map((entry) => entry.id));
    const state = ensureState(streamId);
    states.set(streamId, {
      ...state,
      entries: state.entries.filter((entry) => !isOptimisticUserEntry(entry) || pendingIds.has(entry.id)),
    });
  }
  return mergePendingOptimisticUserEntries(extended, pending);
}

function mergeSnapshotEntries(streamId: string, entries: TranscriptEntry[]): TranscriptViewEntry[] {
  const state = ensureState(streamId);
  if (state.phase === 'cleared') return withPendingOptimisticEntries(streamId, entries);

  const current = pruneExpiredOptimisticUserEntries(streamId);
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const byId = new Map<number, TranscriptViewEntry>();
  for (const entry of current) {
    if (!isOptimisticUserEntry(entry)) byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    byId.set(entry.id, extendEntry(entry, currentById.get(entry.id)));
  }
  const mergedRealEntries = Array.from(byId.values());
  const pendingOptimistic = filterPendingOptimisticUserEntries(
    mergedRealEntries,
    current.filter(isOptimisticUserEntry)
  );
  return mergePendingOptimisticUserEntries(mergedRealEntries, pendingOptimistic);
}

function appendEntry(streamId: string, entry: TranscriptEntry) {
  const state = ensureState(streamId);
  const entries = pruneExpiredOptimisticUserEntries(streamId);
  const idx = entries.findIndex((e) => e.id === entry.id);
  const next = extendEntry(entry, idx >= 0 ? entries[idx] : undefined);
  let nextEntries = idx >= 0
    ? [...entries.slice(0, idx), next, ...entries.slice(idx + 1)]
    : sortEntries([...entries, next]);
  if (entry.role === 'user') {
    const optimisticIdx = nextEntries.findIndex((candidate) => matchesOptimisticUserEntry(candidate, entry));
    if (optimisticIdx >= 0) nextEntries = nextEntries.filter((_, i) => i !== optimisticIdx);
  }
  nextEntries = pruneStaleOptimisticEntries(nextEntries);
  patch(streamId, {
    entries: nextEntries,
    phase: phaseForEntries(nextEntries, 'streaming'),
    revivalState:
      state.lastResetReason === 'compact' && state.revivalState === 'reviving' && isRecoveryActivity(entry)
        ? 'recovered'
        : state.revivalState,
  });
}

function updateEntry(streamId: string, entry: TranscriptEntry) {
  const state = ensureState(streamId);
  const entries = pruneExpiredOptimisticUserEntries(streamId);
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx < 0) return;
  const next = extendEntry(entry, entries[idx]);
  const nextEntries = [...entries.slice(0, idx), next, ...entries.slice(idx + 1)];
  patch(streamId, {
    entries: nextEntries,
    phase: phaseForEntries(nextEntries, ensureState(streamId).phase),
    revivalState:
      state.lastResetReason === 'compact' && state.revivalState === 'reviving' && isRecoveryActivity(entry)
        ? 'recovered'
        : state.revivalState,
  });
}

function truncate(streamId: string, nextCursor: number) {
  const state = ensureState(streamId);
  const entries = state.entries.filter((e) => e.id < nextCursor);
  patch(streamId, {
    entries,
    hasOlder: entries.length > 0 ? state.hasOlder && entries[0].id > 0 : false,
    phase: phaseForEntries(entries, 'cleared'),
  });
}

function isDestructiveResetReason(reason: TranscriptResetPayload['reason']): boolean {
  return reason === 'clear' || reason === 'file-truncate';
}

function isActiveStreamState(state: string | null | undefined): boolean {
  return state === 'busy' || state === 'booting' || state === 'awaiting-approval';
}

function isSettledStreamState(state: string | null | undefined): boolean {
  return (
    state === 'awaiting-input' ||
    state === 'turn-complete' ||
    state === 'interrupted' ||
    state === 'error'
  );
}

function shouldRetainDetachedTranscript(streamId: string): boolean {
  const state = ensureState(streamId);
  return state.phase === 'streaming' || state.phase === 'compacted' || state.revivalState === 'reviving';
}

function disposeTranscriptSubscription(streamId: string) {
  subscribedStreams.delete(streamId);
}

function releaseDormantDetachedTranscript(streamId: string) {
  if (refCounts.has(streamId)) return;
  if (shouldRetainDetachedTranscript(streamId)) return;
  disposeTranscriptSubscription(streamId);
}

function scheduleDetachedTranscriptRelease(streamId: string) {
  window.setTimeout(() => releaseDormantDetachedTranscript(streamId), DETACHED_ACTIVE_TRANSCRIPT_RELEASE_DELAY_MS);
}

function resetStream(streamId: string, payload: TranscriptResetPayload = { streamId, nextCursor: 0, reason: 'clear' }) {
  const reason = payload.reason ?? 'clear';
  if (!isDestructiveResetReason(reason)) {
    const entries = pruneExpiredOptimisticUserEntries(streamId);
    patch(streamId, {
      entries,
      phase: phaseForEntries(entries, 'linked'),
      lastResetReason: reason,
      lastCompactedAt: null,
      revivalState: null,
    });
    probedStreams.delete(streamId);
    return;
  }
  patch(streamId, {
    entries: [],
    phase: 'cleared',
    warnings: [],
    hasOlder: false,
    olderError: null,
    loadingOlder: false,
    lastResetReason: reason,
    lastCompactedAt: null,
    revivalState: null,
  });
  // Allow the probe to re-fire once the new link lands, so renderers that
  // miss the live `tab-chat-available` event still catch up.
  probedStreams.delete(streamId);
}

function replaceStream(streamId: string, payload: TranscriptReplacePayload) {
  // /compact: drop everything and render the summary as the sole entry.
  // Subsequent transcript:append events will build on top of it.
  const reason = payload.reason ?? 'compact';
  const summary = { ...extendEntry(payload.summary), resetReason: reason };
  const compacted = reason === 'compact';
  patch(streamId, {
    entries: [summary],
    phase: compacted ? 'compacted' : phaseForEntries([summary], 'linked'),
    warnings: [],
    hasOlder: false,
    olderError: null,
    loadingOlder: false,
    lastResetReason: reason,
    lastCompactedAt: compacted ? payload.summary.tAt : null,
    revivalState: compacted ? 'reviving' : null,
  });
}

function markCompactionRecovered(streamId: string) {
  const state = ensureState(streamId);
  if (state.lastResetReason !== 'compact' || state.revivalState !== 'reviving') return;
  patch(streamId, {
    phase: phaseForEntries(state.entries, state.phase === 'compacted' ? 'linked' : state.phase),
    revivalState: 'recovered',
  });
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

function startGlobalSubscriber() {
  if (globalUnsub) return;
  globalUnsub = aceApi.streams.onEvent((eventPayload) => {
    const event = eventPayload?.event;
    const payload = eventPayload?.payload;
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId : '';

    if (event === 'tab-chat-available') {
      const agent = payload?.agent;
      if (
        !streamId ||
        (agent !== 'claude' && agent !== 'gemini' && agent !== 'hermes') ||
        typeof payload?.sessionId !== 'string' ||
        typeof payload?.sessionFile !== 'string'
      )
        return;
      const state = ensureState(streamId);
      const entries = withAliasOptimisticUserEntries(streamId, state.entries, payload.sessionFile);
      patch(streamId, {
        phase: phaseForEntries(entries, 'linked'),
        available: true,
        sessionId: payload.sessionId,
        sessionFile: payload.sessionFile,
        agent,
        entries,
      });
      return;
    }

    if (!streamId || !subscribedStreams.has(streamId)) return;
    if (event === 'transcript:append' && payload?.entry) {
      appendEntry(streamId, payload.entry as TranscriptEntry);
      return;
    }
    if (event === 'transcript:update' && payload?.entry) {
      updateEntry(streamId, payload.entry as TranscriptEntry);
      return;
    }
    if (event === 'transcript:reset') {
      resetStream(streamId, {
        streamId,
        nextCursor: typeof payload.nextCursor === 'number' ? payload.nextCursor : 0,
        reason: payload.reason as TranscriptResetReason | undefined,
      });
      return;
    }
    if (event === 'transcript:replace' && payload?.summary) {
      replaceStream(streamId, {
        nextCursor: typeof payload.nextCursor === 'number' ? payload.nextCursor : 0,
        summary: payload.summary as TranscriptEntry,
        reason: payload.reason as TranscriptResetReason | undefined,
      });
      return;
    }
    if (event === 'transcript:truncate') {
      truncate(streamId, typeof payload.nextCursor === 'number' ? payload.nextCursor : 0);
      return;
    }
    if (event !== 'state-change') return;
    const streamState = typeof payload?.to === 'string' ? payload.to : undefined;
    if (isActiveStreamState(streamState)) {
      patch(streamId, { phase: 'streaming' });
      return;
    }
    if (isSettledStreamState(streamState)) {
      markCompactionRecovered(streamId);
      void loadTranscript(streamId).then(() => scheduleDetachedTranscriptRelease(streamId));
      for (const delay of SETTLED_TRANSCRIPT_REFRESH_DELAYS_MS) {
        window.setTimeout(() => {
          if (subscribedStreams.has(streamId)) void loadTranscript(streamId);
        }, delay);
      }
    }
  });
}

// Fetches the current availability/snapshot once. Backs up the event-based
// `tab-chat-available` signal so renderers that mount after linking still
// light up the Chat toggle without needing a round-trip spawn.
const probedStreams = new Set<string>();
async function probeAvailability(streamId: string) {
  if (probedStreams.has(streamId)) return;
  probedStreams.add(streamId);
  try {
    const snap = (await aceApi.streams.transcript(streamId, { limit: 1 })) as TranscriptSnapshot | null;
    if (!snap) {
      // A link can land after this first mount-time probe. Do not permanently
      // cache the negative result; a remount/retry must be able to discover it.
      probedStreams.delete(streamId);
      return;
    }
    if (snap.agent === 'codex') return;
    const state = ensureState(streamId);
    const entries = withAliasOptimisticUserEntries(streamId, state.entries, snap.sessionFile);
    patch(streamId, {
      phase: phaseForEntries(entries, 'linked'),
      available: true,
      sessionId: snap.sessionId,
      sessionFile: snap.sessionFile,
      agent: snap.agent,
      entries,
    });
  } catch {
    probedStreams.delete(streamId);
  }
}

export async function __probeAvailabilityForTests(streamId: string): Promise<void> {
  await probeAvailability(streamId);
}

async function loadTranscript(streamId: string): Promise<void> {
  patch(streamId, { loading: true, error: null });
  try {
    const snap = (await aceApi.streams.transcript(streamId, { limit: TRANSCRIPT_PAGE_SIZE })) as TranscriptSnapshot | null;
    if (!snap) {
      patch(streamId, { loading: false, available: false, hasOlder: false, phase: 'unavailable' });
      return;
    }
    if (snap.agent === 'codex') {
      patch(streamId, { loading: false, available: false, hasOlder: false, phase: 'unavailable' });
      return;
    }
    const mergedEntries = withAliasOptimisticUserEntries(
      streamId,
      mergeSnapshotEntries(streamId, snap.entries),
      snap.sessionFile
    );
    patch(streamId, {
      loading: false,
      phase: phaseForEntries(mergedEntries, 'linked'),
      available: true,
      agent: snap.agent,
      sessionId: snap.sessionId,
      sessionFile: snap.sessionFile,
      entries: mergedEntries,
      hasOlder: snap.hasMoreBefore === true,
      warnings: snap.warnings,
    });
  } catch (err) {
    patch(streamId, { loading: false, phase: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

export async function loadOlderTranscript(streamId: string): Promise<void> {
  const state = ensureState(streamId);
  const before = oldestRealEntryId(state.entries);
  if (before === undefined || state.loadingOlder || !state.hasOlder) return;
  patch(streamId, { loadingOlder: true, olderError: null });
  try {
    const snap = (await aceApi.streams.transcript(streamId, {
      before,
      limit: TRANSCRIPT_PAGE_SIZE,
    })) as TranscriptSnapshot | null;
    if (!snap) {
      patch(streamId, { loadingOlder: false, available: false, hasOlder: false, phase: 'unavailable' });
      return;
    }
    const current = ensureState(streamId).entries;
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    const byId = new Map<number, TranscriptViewEntry>();
    for (const entry of snap.entries) byId.set(entry.id, extendEntry(entry, currentById.get(entry.id)));
    for (const entry of current) byId.set(entry.id, entry);
    const mergedEntries = sortEntries(Array.from(byId.values()));
    patch(streamId, {
      loadingOlder: false,
      phase: phaseForEntries(mergedEntries, 'linked'),
      available: true,
      agent: snap.agent,
      sessionId: snap.sessionId,
      sessionFile: snap.sessionFile,
      entries: mergedEntries,
      hasOlder: snap.hasMoreBefore === true,
      warnings: snap.warnings,
    });
  } catch (err) {
    patch(streamId, {
      loadingOlder: false,
      olderError: err instanceof Error ? err.message : String(err),
    });
  }
}

export function appendOptimisticUserEntry(streamId: string, text: string): number {
  const state = ensureState(streamId);
  // sortEntries orders by tAt (then id). The agent's session-file stamp can run
  // AHEAD of the client's Date.now() (the same sub-second skew that
  // OPTIMISTIC_USER_ENTRY_BACKWARD_SKEW_MS exists for), so a just-finished
  // previous turn's entries can carry a tAt greater than the client clock at
  // send. Stamping this fresh Chief message with a bare Date.now() would
  // then sort it ABOVE those older messages — the "my message jumped above the
  // previous turn" bug. Stamp it just past the newest existing entry so it
  // always lands at the bottom, while staying close enough that the real echo
  // still reconciles within the skew window. Ignore corrupt far-future stamps
  // so they can't push the optimistic entry out of that window.
  const now = Date.now();
  let maxTAt = 0;
  for (const existing of state.entries) {
    if (existing.tAt > maxTAt && existing.tAt <= now + OPTIMISTIC_USER_ENTRY_BACKWARD_SKEW_MS) {
      maxTAt = existing.tAt;
    }
  }
  const tAt = Math.max(now, maxTAt + 1);
  const entry: TranscriptViewEntry = {
    id: OPTIMISTIC_USER_ENTRY_ID_BASE + optimisticUserEntrySeq++,
    role: 'user',
    text,
    lifecycle: 'finished',
    tAt,
  };
  entry.startedAt = entry.tAt;
  const entries = sortEntries([...state.entries, entry]);
  patch(streamId, { entries, phase: 'streaming' });
  return entry.id;
}

export function confirmOptimisticUserEntry(streamId: string, entryId: number): void {
  ensureState(streamId);
  for (const [candidateStreamId, state] of states) {
    const idx = state.entries.findIndex((entry) => entry.id === entryId && isOptimisticUserEntry(entry));
    if (idx < 0) continue;
    const entry = state.entries[idx];
    const entries = [
      ...state.entries.slice(0, idx),
      { ...entry, optimisticConfirmed: true },
      ...state.entries.slice(idx + 1),
    ];
    patch(candidateStreamId, { entries, phase: phaseForEntries(entries, state.phase) });
  }
}

export function removeOptimisticUserEntry(streamId: string, entryId: number): void {
  ensureState(streamId);
  for (const [candidateStreamId, state] of states) {
    if (!state.entries.some((entry) => entry.id === entryId && isOptimisticUserEntry(entry))) continue;
    const entries = state.entries.filter((entry) => entry.id !== entryId);
    patch(candidateStreamId, { entries, phase: phaseForEntries(entries, state.phase) });
  }
}

export function attachTranscript(streamId: string): () => void {
  startGlobalSubscriber();
  const count = (refCounts.get(streamId) || 0) + 1;
  refCounts.set(streamId, count);
  subscribedStreams.add(streamId);
  if (count === 1) {
    void loadTranscript(streamId);
  }
  return () => {
    const next = (refCounts.get(streamId) || 1) - 1;
    if (next <= 0) {
      refCounts.delete(streamId);
      if (!shouldRetainDetachedTranscript(streamId)) {
        disposeTranscriptSubscription(streamId);
      }
    } else {
      refCounts.set(streamId, next);
    }
  };
}

export function useTranscript(streamId: string | null): StreamState {
  return useSyncExternalStore(
    (fn) => (streamId ? subscribe(streamId, fn) : () => {}),
    () => (streamId ? ensureState(streamId) : DEFAULT_STATE),
    () => DEFAULT_STATE
  );
}

export function __getTranscriptStateForTests(streamId: string): StreamState {
  return ensureState(streamId);
}

export function __resetTranscriptRegistryForTests(): void {
  if (globalUnsub) {
    try {
      globalUnsub();
    } catch {
      /* noop */
    }
  }
  states.clear();
  listeners.clear();
  subscribedStreams.clear();
  refCounts.clear();
  probedStreams.clear();
  globalUnsub = null;
  optimisticUserEntrySeq = 0;
}

export function useChatAvailable(streamId: string | null): boolean {
  const transcript = useTranscript(streamId);
  useEffect(() => {
    if (!streamId) return;
    startGlobalSubscriber();
    void probeAvailability(streamId);
  }, [streamId]);
  return transcript.available;
}
