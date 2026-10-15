import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type MockPayload = Record<string, unknown>;
  type MockListener = (payload: MockPayload) => void;
  const appendListeners = new Map<string, MockListener>();
  const updateListeners = new Map<string, MockListener>();
  const resetListeners = new Map<string, MockListener>();
  const replaceListeners = new Map<string, MockListener>();
  const truncateListeners = new Map<string, MockListener>();
  const eventListeners = new Set<MockListener>();
  const tabAvailableListeners = new Set<MockListener>();
  const transcript = vi.fn(async (streamId: string) => ({
    streamId,
    sessionId: 'session-1',
    sessionFile: '/tmp/hermes-home/state.db',
    agent: 'hermes',
    entries: [],
    nextCursor: 0,
    hasMoreBefore: false,
    warnings: [],
  }));

  const bindMap = (map: Map<string, MockListener>) =>
    vi.fn((streamId: string, listener: MockListener) => {
      map.set(streamId, listener);
      return () => map.delete(streamId);
    });

  return {
    appendListeners,
    updateListeners,
    resetListeners,
    replaceListeners,
    truncateListeners,
    eventListeners,
    tabAvailableListeners,
    transcript,
    aceApi: {
      streams: {
        onTabChatAvailable: vi.fn((listener: MockListener) => {
          tabAvailableListeners.add(listener);
          return () => tabAvailableListeners.delete(listener);
        }),
        transcript,
        onTranscriptAppend: bindMap(appendListeners),
        onTranscriptUpdate: bindMap(updateListeners),
        onTranscriptReset: bindMap(resetListeners),
        onTranscriptReplace: bindMap(replaceListeners),
        onTranscriptTruncate: bindMap(truncateListeners),
        onEvent: vi.fn((listener: MockListener) => {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        }),
      },
    },
    reset() {
      appendListeners.clear();
      updateListeners.clear();
      resetListeners.clear();
      replaceListeners.clear();
      truncateListeners.clear();
      eventListeners.clear();
      tabAvailableListeners.clear();
      transcript.mockClear();
      vi.mocked(this.aceApi.streams.onTabChatAvailable).mockClear();
      vi.mocked(this.aceApi.streams.onTranscriptAppend).mockClear();
      vi.mocked(this.aceApi.streams.onTranscriptUpdate).mockClear();
      vi.mocked(this.aceApi.streams.onTranscriptReset).mockClear();
      vi.mocked(this.aceApi.streams.onTranscriptReplace).mockClear();
      vi.mocked(this.aceApi.streams.onTranscriptTruncate).mockClear();
      vi.mocked(this.aceApi.streams.onEvent).mockClear();
    },
  };
});

vi.mock('../lib/ace-api', () => ({ aceApi: mocks.aceApi }));

import {
  __getTranscriptStateForTests,
  __probeAvailabilityForTests,
  __resetTranscriptRegistryForTests,
  attachTranscript,
} from './transcript-registry';

function compactPayload() {
  return {
    streamId: 'stream-1',
    nextCursor: 2,
    reason: 'compact',
    summary: {
      id: 1,
      role: 'system',
      subtype: 'info',
      text: 'Hermes auto-compacted prior conversation. Prior context was summarized; reviving from compacted context.',
      lifecycle: 'finished',
      tAt: 1000,
    },
  };
}

function emitStreamEvent(event: string, payload: Record<string, unknown>) {
  for (const listener of mocks.eventListeners) listener({ event, payload });
}

beforeEach(() => {
  __resetTranscriptRegistryForTests();
  mocks.reset();
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
});

describe('transcript registry active-stream retention', () => {
  it('routes retained streams through one global stream-event subscription', async () => {
    const detaches = Array.from({ length: 12 }, (_, index) => attachTranscript(`active-${index}`));
    await Promise.resolve();

    expect(mocks.aceApi.streams.onEvent).toHaveBeenCalledTimes(1);
    expect(mocks.aceApi.streams.onTranscriptAppend).not.toHaveBeenCalled();
    expect(mocks.aceApi.streams.onTranscriptUpdate).not.toHaveBeenCalled();
    expect(mocks.aceApi.streams.onTranscriptReset).not.toHaveBeenCalled();
    expect(mocks.aceApi.streams.onTranscriptReplace).not.toHaveBeenCalled();
    expect(mocks.aceApi.streams.onTranscriptTruncate).not.toHaveBeenCalled();

    emitStreamEvent('transcript:append', {
      streamId: 'active-7',
      entry: {
        id: 7,
        role: 'reasoning',
        text: 'one routed progress update',
        lifecycle: 'open',
        tAt: 2000,
      },
    });

    expect(__getTranscriptStateForTests('active-7').entries.at(-1)?.text).toBe(
      'one routed progress update'
    );
    expect(__getTranscriptStateForTests('active-6').entries).toEqual([]);

    for (const detach of detaches) detach();
  });

  it('retries availability after an early probe finds no transcript link', async () => {
    mocks.transcript
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        streamId: 'late-link',
        sessionId: 'session-late',
        sessionFile: '/tmp/session-late.jsonl',
        agent: 'claude',
        entries: [],
        nextCursor: 0,
        hasMoreBefore: false,
        warnings: [],
      });

    await __probeAvailabilityForTests('late-link');
    expect(__getTranscriptStateForTests('late-link').available).toBe(false);

    await __probeAvailabilityForTests('late-link');
    expect(mocks.transcript).toHaveBeenCalledTimes(2);
    expect(__getTranscriptStateForTests('late-link').available).toBe(true);
    expect(__getTranscriptStateForTests('late-link').sessionId).toBe('session-late');
  });

  it('keeps detached active Hermes streams subscribed but releases dormant streams', async () => {
    const activeDetach = attachTranscript('active-stream');
    await Promise.resolve();

    emitStreamEvent('state-change', { streamId: 'active-stream', to: 'busy' });
    activeDetach();

    emitStreamEvent('transcript:append', {
      streamId: 'active-stream',
      entry: {
        id: 2,
        role: 'reasoning',
        text: 'still thinking off tab',
        lifecycle: 'open',
        tAt: 2000,
      },
    });
    expect(__getTranscriptStateForTests('active-stream').entries.at(-1)?.text).toBe('still thinking off tab');

    const dormantDetach = attachTranscript('dormant-stream');
    await Promise.resolve();
    dormantDetach();

    emitStreamEvent('transcript:append', {
      streamId: 'dormant-stream',
      entry: {
        id: 3,
        role: 'reasoning',
        text: 'must be ignored after detach',
        lifecycle: 'open',
        tAt: 2100,
      },
    });
    expect(__getTranscriptStateForTests('dormant-stream').entries).toEqual([]);
  });

  it('releases a detached active stream once the turn settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    try {
      const activeDetach = attachTranscript('settling-stream');
      await Promise.resolve();
      emitStreamEvent('state-change', { streamId: 'settling-stream', to: 'busy' });
      activeDetach();

      emitStreamEvent('state-change', { streamId: 'settling-stream', to: 'turn-complete' });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300);

      emitStreamEvent('transcript:append', {
        streamId: 'settling-stream',
        entry: {
          id: 4,
          role: 'reasoning',
          text: 'must be ignored after settlement release',
          lifecycle: 'open',
          tAt: 2200,
        },
      });
      expect(__getTranscriptStateForTests('settling-stream').entries).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('transcript registry compaction revival state', () => {
  it('preserves compact replace metadata and recovers when assistant activity arrives', async () => {
    attachTranscript('stream-1');
    await Promise.resolve();

    emitStreamEvent('transcript:replace', compactPayload());
    let state = __getTranscriptStateForTests('stream-1');

    expect(state.phase).toBe('compacted');
    expect(state.lastResetReason).toBe('compact');
    expect(state.lastCompactedAt).toBe(1000);
    expect(state.revivalState).toBe('reviving');
    expect(state.entries[0].resetReason).toBe('compact');

    emitStreamEvent('transcript:append', {
      streamId: 'stream-1',
      entry: {
        id: 2,
        role: 'tool',
        name: 'terminal',
        status: 'running',
        lifecycle: 'open',
        tAt: 1100,
      },
    });
    state = __getTranscriptStateForTests('stream-1');

    expect(state.phase).toBe('streaming');
    expect(state.revivalState).toBe('recovered');
  });

  it('marks compact revival recovered when Hermes reports ready', async () => {
    attachTranscript('stream-1');
    await Promise.resolve();

    emitStreamEvent('transcript:replace', compactPayload());
    emitStreamEvent('state-change', { streamId: 'stream-1', to: 'turn-complete' });

    const state = __getTranscriptStateForTests('stream-1');
    expect(state.phase).toBe('settled');
    expect(state.lastResetReason).toBe('compact');
    expect(state.revivalState).toBe('recovered');
  });

  it('keeps clear and alias-prune reset reasons distinct from compact', async () => {
    attachTranscript('stream-1');
    await Promise.resolve();

    emitStreamEvent('transcript:reset', { streamId: 'stream-1', nextCursor: 0, reason: 'alias-prune' });
    let state = __getTranscriptStateForTests('stream-1');
    expect(state.phase).toBe('linked');
    expect(state.lastResetReason).toBe('alias-prune');
    expect(state.revivalState).toBeNull();

    emitStreamEvent('transcript:replace', compactPayload());
    emitStreamEvent('transcript:reset', { streamId: 'stream-1', nextCursor: 0, reason: 'clear' });
    state = __getTranscriptStateForTests('stream-1');
    expect(state.phase).toBe('cleared');
    expect(state.lastResetReason).toBe('clear');
    expect(state.revivalState).toBeNull();
    expect(state.entries).toEqual([]);
  });
});
