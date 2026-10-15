// Holding buffer for PTY output that arrives while a terminal is parked
// (mounted once, now hidden). Parked terminals don't parse — with dozens of
// live lanes, background parse on the renderer main thread is what queued
// wheel/touch events behind agent output ("small delay" scrolling). Chunks
// are held here and replayed in one write on re-attach; past the byte cap
// the buffer is abandoned and the caller resyncs from the server's
// authoritative snapshot instead (the same recovery path remote reattach
// already uses). Pure data structure — behavioral tests in
// terminal-parked-buffer.test.ts.

export type ParkedBuffer = {
  chunks: string[];
  // UTF-16 code units, not bytes: string.length is the cheap measure and
  // memory scales with it (~2 bytes/unit) — precise enough for a hold cap.
  units: number;
  overflow: boolean;
};

export function createParkedBuffer(): ParkedBuffer {
  return { chunks: [], units: 0, overflow: false };
}

export function pushParked(buf: ParkedBuffer, chunk: string, capUnits: number): void {
  if (buf.overflow) return;
  buf.units += chunk.length;
  if (buf.units > capUnits) {
    // Past the cap the tail alone is useless — a replay must be
    // prefix-complete or escape sequences tear. Drop everything and let the
    // caller snapshot-resync.
    buf.chunks = [];
    buf.units = 0;
    buf.overflow = true;
    return;
  }
  buf.chunks.push(chunk);
}

export function drainParked(buf: ParkedBuffer): { text: string | null; needsResync: boolean } {
  const needsResync = buf.overflow;
  const text = !needsResync && buf.chunks.length > 0 ? buf.chunks.join('') : null;
  buf.chunks = [];
  buf.units = 0;
  buf.overflow = false;
  return { text, needsResync };
}

/**
 * Whether a sync snapshot should apply. Ordinary snapshots are dropped when
 * older than what the terminal already rendered ('stale') and skipped when
 * seq-identical to it ('identical' — the phone's wake-time resync storm).
 * A FORCED snapshot (overflow recovery) bypasses both: the screen is known
 * to be missing dropped output, so seq equality no longer implies content
 * equality, and even an older-seq snapshot beats a screen with a hole —
 * queued chunks replay the difference afterwards.
 */
export function snapshotDecision(
  seq: number,
  lastSeq: number,
  opts: { force?: boolean; opened: boolean; syncing: boolean }
): 'stale' | 'identical' | 'apply' {
  if (opts.force) return 'apply';
  if (seq > 0 && seq < lastSeq) return 'stale';
  if (seq > 0 && seq === lastSeq && opts.opened && !opts.syncing) return 'identical';
  return 'apply';
}

/**
 * Overflow recovery ordering contract. The queue MUST open before the
 * (async) snapshot fetch: output that lands mid-flight must be held and
 * reconciled after the snapshot, not written to a screen the snapshot is
 * about to clear (it would be erased) or ahead of it (the snapshot would
 * look stale and be rejected). Every exit — null snapshot, fetch failure —
 * must close the queue, or the terminal freezes in syncing state.
 *
 * Stale policy: a snapshot older than the newest sequence this client has
 * seen shouldn't normally exist (the server serializes from the same state
 * the sequence numbers come from), so `isStale` triggering means either a
 * race worth one refetch, or — if the refetch is stale too — the server's
 * sequence space reset underneath us (PTY respawn). In that second case the
 * "stale" snapshot IS the current authoritative screen and rendering it is
 * correct; clinging to the higher number would freeze the terminal on
 * content the server no longer has.
 */
export async function recoverFromOverflow<Snap>(io: {
  beginQueue(): void;
  fetchSnapshot(): Promise<Snap | null>;
  isStale?(snapshot: Snap): boolean;
  applySnapshot(snapshot: Snap): void;
  finishWithoutSnapshot(): void;
}): Promise<void> {
  io.beginQueue();
  let snapshot: Snap | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      snapshot = await io.fetchSnapshot();
    } catch {
      snapshot = null;
    }
    if (snapshot === null) break;
    if (!io.isStale?.(snapshot)) break;
  }
  if (snapshot === null) {
    io.finishWithoutSnapshot();
    return;
  }
  io.applySnapshot(snapshot);
}
