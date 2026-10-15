// @vitest-environment happy-dom
//
// Behavioral integration tests for the parked-terminal pipeline: the REAL
// terminal-registry and REAL xterm parser, with only the IPC boundary
// (ace-api) and core-registry mocked. Chunks enter through the same
// onPtyData handler production uses, and assertions read the rendered
// terminal buffer — not source text.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PtyHandler = (p: { id: string; chunk: string; seq?: number }) => void;
type SyncHandler = (p: {
  streamId: string;
  state: string;
  seq: number;
  cols: number;
  rows: number;
}) => void;

const bridge: {
  ptyData: PtyHandler | null;
  ptySync: SyncHandler | null;
  getTerminalSync: ReturnType<typeof vi.fn>;
  remote: boolean;
  requestedSyncs: string[];
} = {
  ptyData: null,
  ptySync: null,
  getTerminalSync: vi.fn(),
  remote: false,
  requestedSyncs: [],
};

vi.mock('../lib/ace-api', () => ({
  isRemoteClient: () => bridge.remote,
  aceApi: {
    core: {
      onPtyData: (h: PtyHandler) => {
        bridge.ptyData = h;
        return () => {};
      },
      onPtyExit: () => () => {},
      onPtySync: (h: SyncHandler) => {
        bridge.ptySync = h;
        return () => {};
      },
      sendPtySubscribe: () => {},
      sendPtyUnsubscribe: () => {},
      sendPtyRequestSync: (id: string) => bridge.requestedSyncs.push(id),
    },
    runtime: {
      writeTerminalInput: () => Promise.resolve({ ok: true }),
      resizeTerminal: () => Promise.resolve({ ok: true }),
      pasteClipboardImage: () => Promise.resolve(null),
      pasteClipboardImageRemote: () => Promise.resolve(null),
    },
    sessions: {
      ensureStreamStarted: () => Promise.resolve({ ok: true }),
      getTerminalSync: (streamId: string) => bridge.getTerminalSync(streamId),
    },
    workspaces: { openExternal: () => Promise.resolve() },
  },
}));

vi.mock('./core-registry', () => ({
  getCoreSnapshot: () => ({ workspaces: [] }),
}));

import {
  acquireSession,
  destroyTerminalSession,
  resumeParkedStream,
} from './terminal-registry';

let streamN = 0;

function newStream() {
  streamN += 1;
  const id = `shell:itest-${streamN}`;
  const session = acquireSession(id) as unknown as {
    id: string;
    opened: boolean;
    attached: boolean;
    lastSeq: number;
    syncing: boolean;
    parked: { chunks: string[]; units: number; overflow: boolean };
    pendingSyncChunks: Array<{ chunk: string; seq?: number }>;
    terminal: {
      buffer: { active: { length: number; getLine(n: number): { translateToString(t: boolean): string } | undefined } };
      write(d: string, cb?: () => void): void;
    };
  };
  // Rendering never opens in jsdom (no layout); parsing is independent of
  // open(), and `opened` gates the parked path exactly as in production.
  session.opened = true;
  return { id, session };
}

function emit(id: string, chunk: string, seq: number) {
  bridge.ptyData!({ id, chunk, seq });
}

function screenText(session: ReturnType<typeof newStream>['session']): string {
  const buf = session.terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

function flushWrites(session: ReturnType<typeof newStream>['session']): Promise<void> {
  return new Promise((resolve) => session.terminal.write('', resolve));
}

beforeEach(() => {
  bridge.getTerminalSync.mockReset();
  bridge.remote = false;
  bridge.requestedSyncs = [];
});

describe('parked terminal integration (real registry + real xterm)', () => {
  it('attached sessions render chunks; parked sessions hold them unparsed', async () => {
    const { id, session } = newStream();
    session.attached = true;
    emit(id, 'live-line\r\n', 1);
    await flushWrites(session);
    expect(screenText(session)).toContain('live-line');

    session.attached = false;
    emit(id, 'hidden-line\r\n', 2);
    await flushWrites(session);
    expect(screenText(session)).not.toContain('hidden-line');
    expect(session.parked.chunks).toEqual(['hidden-line\r\n']);
    expect(session.lastSeq).toBe(2);
    destroyTerminalSession(id);
  });

  it('re-attach replays held chunks in order into the rendered buffer', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'first\r\n', 1);
    emit(id, 'second\r\n', 2);
    session.attached = true;
    resumeParkedStream(id);
    await flushWrites(session);
    const text = screenText(session);
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(session.parked.chunks).toEqual([]);
    destroyTerminalSession(id);
  });

  it('overflow recovery: queue opens before the fetch, snapshot renders, mid-flight chunks replay after it', async () => {
    const { id, session } = newStream();
    session.attached = false;
    // Overflow the parked buffer.
    emit(id, 'x'.repeat(500 * 1024), 3);
    expect(session.parked.overflow).toBe(true);

    let resolveSnap!: (p: unknown) => void;
    bridge.getTerminalSync.mockReturnValue(new Promise((r) => { resolveSnap = r; }));

    session.attached = true;
    resumeParkedStream(id);
    // Queue must be open BEFORE the snapshot resolves...
    expect(session.syncing).toBe(true);
    // ...so a chunk racing the fetch is held, not written to the screen the
    // snapshot will clear.
    emit(id, 'mid-flight\r\n', 4);
    expect(session.pendingSyncChunks.length).toBe(1);
    await flushWrites(session);
    expect(screenText(session)).not.toContain('mid-flight');

    resolveSnap({ streamId: id, state: 'snapshot-content\r\n', seq: 3, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    const text = screenText(session);
    // Force mode: seq 3 === lastSeq 3, yet the snapshot must render (the
    // screen was missing the dropped output).
    expect(text).toContain('snapshot-content');
    expect(text).toContain('mid-flight');
    expect(text.indexOf('snapshot-content')).toBeLessThan(text.indexOf('mid-flight'));
    expect(session.lastSeq).toBe(4);
    destroyTerminalSession(id);
  });

  it('overflow recovery with a failed fetch closes the queue and flushes held chunks', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'y'.repeat(500 * 1024), 5);
    bridge.getTerminalSync.mockRejectedValue(new Error('ipc down'));

    session.attached = true;
    resumeParkedStream(id);
    expect(session.syncing).toBe(true);
    emit(id, 'after-failure\r\n', 6);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    expect(screenText(session)).toContain('after-failure');
    expect(session.lastSeq).toBe(6);
    destroyTerminalSession(id);
  });

  it('overflow recovery refetches once when the snapshot is older than rendered seq, then applies', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'z'.repeat(500 * 1024), 10);
    bridge.getTerminalSync
      .mockResolvedValueOnce({ streamId: id, state: 'old-snap\r\n', seq: 4, cols: 80, rows: 24 })
      .mockResolvedValueOnce({ streamId: id, state: 'fresh-snap\r\n', seq: 11, cols: 80, rows: 24 });

    session.attached = true;
    resumeParkedStream(id);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    expect(bridge.getTerminalSync).toHaveBeenCalledTimes(2);
    const text = screenText(session);
    expect(text).toContain('fresh-snap');
    expect(text).not.toContain('old-snap');
    expect(session.lastSeq).toBe(11);
    destroyTerminalSession(id);
  });

  it('ordinary pty:sync with an identical seq skips the replay (wake-storm guard) but a forced one never does', async () => {
    const { id, session } = newStream();
    session.attached = true;
    emit(id, 'existing\r\n', 7);
    await flushWrites(session);

    // Identical-seq push (the phone's wake-time resync): must NOT clear/replay.
    bridge.ptySync!({ streamId: id, state: 'should-not-render\r\n', seq: 7, cols: 80, rows: 24 });
    await flushWrites(session);
    const text = screenText(session);
    expect(text).toContain('existing');
    expect(text).not.toContain('should-not-render');
    destroyTerminalSession(id);
  });

  it('ordinary pty:sync with a newer seq replaces the screen and dedupes queued chunks', async () => {
    const { id, session } = newStream();
    session.attached = true;
    emit(id, 'before-sync\r\n', 1);
    await flushWrites(session);

    bridge.ptySync!({ streamId: id, state: 'synced-state\r\n', seq: 5, cols: 80, rows: 24 });
    // Chunks landing during the replay: seq 4 is covered by the snapshot
    // (deduped); seq 6 is newer and must render after it.
    emit(id, 'covered\r\n', 4);
    emit(id, 'newer\r\n', 6);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    const text = screenText(session);
    expect(text).toContain('synced-state');
    expect(text).toContain('newer');
    expect(text).not.toContain('covered');
    expect(text).not.toContain('before-sync');
    expect(session.lastSeq).toBe(6);
    destroyTerminalSession(id);
  });
});

describe('overflow recovery lifecycle races', () => {
  it('a snapshot resolving after destroy+recreate never touches the successor session', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'q'.repeat(500 * 1024), 8);

    let resolveSnap!: (p: unknown) => void;
    bridge.getTerminalSync.mockReturnValue(new Promise((r) => { resolveSnap = r; }));
    session.attached = true;
    resumeParkedStream(id);
    expect(session.syncing).toBe(true);

    // Stream killed and reopened while the fetch is in flight.
    destroyTerminalSession(id);
    const successor = acquireSession(id) as unknown as typeof session;
    successor.opened = true;
    successor.attached = true;

    resolveSnap({ streamId: id, state: 'ghost-snapshot\r\n', seq: 8, cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 50));
    await flushWrites(successor);
    expect(screenText(successor)).not.toContain('ghost-snapshot');
    expect(successor.syncing).toBe(false);
    destroyTerminalSession(id);
  });

  it('a failed fetch after destroy+recreate never closes the successor queue or flushes into it', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'w'.repeat(500 * 1024), 9);
    bridge.getTerminalSync.mockRejectedValue(new Error('gone'));
    session.attached = true;
    resumeParkedStream(id);

    destroyTerminalSession(id);
    const successor = acquireSession(id) as unknown as typeof session;
    successor.opened = true;
    successor.syncing = true; // successor mid-replay of its own
    await new Promise((r) => setTimeout(r, 50));
    // The predecessor's finishWithoutSnapshot must not clear this.
    expect(successor.syncing).toBe(true);
    successor.syncing = false;
    destroyTerminalSession(id);
  });

  it('re-parking mid-fetch still applies the catch-up snapshot once, then chunks park again', async () => {
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'v'.repeat(500 * 1024), 12);

    let resolveSnap!: (p: unknown) => void;
    bridge.getTerminalSync.mockReturnValue(new Promise((r) => { resolveSnap = r; }));
    session.attached = true;
    resumeParkedStream(id);
    // User tabs away again before the snapshot lands.
    session.attached = false;

    resolveSnap({ streamId: id, state: 'late-catchup\r\n', seq: 12, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    expect(screenText(session)).toContain('late-catchup');
    // Post-recovery output while parked goes back to the hold buffer.
    emit(id, 'parked-again\r\n', 13);
    await flushWrites(session);
    expect(screenText(session)).not.toContain('parked-again');
    expect(session.parked.chunks).toEqual(['parked-again\r\n']);
    destroyTerminalSession(id);
  });
});

describe('remote overflow recovery', () => {
  it('resets lastSeq before requesting the socket sync so the arriving snapshot can never be rejected against a holed screen', async () => {
    bridge.remote = true;
    const { id, session } = newStream();
    session.attached = false;
    emit(id, 'r'.repeat(500 * 1024), 20); // lastSeq advances to 20, chunks dropped
    expect(session.parked.overflow).toBe(true);

    session.attached = true;
    resumeParkedStream(id);
    expect(bridge.requestedSyncs).toEqual([id]);

    // Without the reset this snapshot (seq 20 === lastSeq) would be skipped
    // as identical, permanently preserving the overflow gap.
    bridge.ptySync!({ streamId: id, state: 'remote-recovery\r\n', seq: 20, cols: 80, rows: 24 });
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await flushWrites(session);
    expect(screenText(session)).toContain('remote-recovery');
    expect(session.lastSeq).toBe(20);
    destroyTerminalSession(id);
  });
});
