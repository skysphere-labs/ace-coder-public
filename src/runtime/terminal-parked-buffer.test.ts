import { describe, expect, it } from 'vitest';
import {
  createParkedBuffer,
  drainParked,
  pushParked,
  recoverFromOverflow,
  snapshotDecision,
} from './terminal-parked-buffer';

describe('terminal-parked-buffer', () => {
  it('accumulates chunks in order and drains them as one write', () => {
    const b = createParkedBuffer();
    pushParked(b, 'a', 100);
    pushParked(b, 'b', 100);
    pushParked(b, 'c', 100);
    expect(drainParked(b)).toEqual({ text: 'abc', needsResync: false });
  });

  it('drains empty as a no-op', () => {
    const b = createParkedBuffer();
    expect(drainParked(b)).toEqual({ text: null, needsResync: false });
  });

  it('drops everything past the cap and flags a resync', () => {
    const b = createParkedBuffer();
    pushParked(b, 'x'.repeat(60), 100);
    pushParked(b, 'y'.repeat(60), 100); // 120 > 100 — overflow
    expect(b.overflow).toBe(true);
    expect(b.chunks).toEqual([]); // a partial tail is useless for replay
    expect(b.units).toBe(0);
    const d = drainParked(b);
    expect(d.needsResync).toBe(true);
    expect(d.text).toBeNull();
  });

  it('ignores further pushes while overflowed (no unbounded growth)', () => {
    const b = createParkedBuffer();
    pushParked(b, 'x'.repeat(200), 100);
    for (let i = 0; i < 1000; i++) pushParked(b, 'y'.repeat(1000), 100);
    expect(b.chunks.length).toBe(0);
    expect(b.units).toBe(0);
  });

  it('drain resets overflow so the buffer is reusable after resync', () => {
    const b = createParkedBuffer();
    pushParked(b, 'x'.repeat(200), 100);
    drainParked(b);
    pushParked(b, 'ok', 100);
    expect(drainParked(b)).toEqual({ text: 'ok', needsResync: false });
  });

  it('exact-cap fill does not overflow', () => {
    const b = createParkedBuffer();
    pushParked(b, 'x'.repeat(100), 100);
    expect(b.overflow).toBe(false);
    expect(drainParked(b).text).toBe('x'.repeat(100));
  });
});

describe('snapshotDecision', () => {
  const base = { opened: true, syncing: false };

  it('drops snapshots older than what is rendered', () => {
    expect(snapshotDecision(5, 9, base)).toBe('stale');
  });

  it('skips seq-identical snapshots (wake-time resync storm)', () => {
    expect(snapshotDecision(9, 9, base)).toBe('identical');
  });

  it('applies newer snapshots', () => {
    expect(snapshotDecision(10, 9, base)).toBe('apply');
  });

  it('applies seq-identical snapshots while a replay is already in flight', () => {
    expect(snapshotDecision(9, 9, { ...base, syncing: true })).toBe('apply');
  });

  it('unsequenced snapshots (seq 0) always apply', () => {
    expect(snapshotDecision(0, 9, base)).toBe('apply');
  });

  it('force bypasses both guards — an overflowed screen is missing output, so seq equality does not mean content equality', () => {
    expect(snapshotDecision(9, 9, { ...base, force: true })).toBe('apply');
    expect(snapshotDecision(5, 9, { ...base, force: true })).toBe('apply');
  });
});

describe('recoverFromOverflow', () => {
  function harness(fetch: () => Promise<string | null>) {
    const calls: string[] = [];
    const done = recoverFromOverflow<string>({
      beginQueue: () => calls.push('beginQueue'),
      fetchSnapshot: () => {
        calls.push('fetch');
        return fetch();
      },
      applySnapshot: (s) => calls.push(`apply:${s}`),
      finishWithoutSnapshot: () => calls.push('finish'),
    });
    return { calls, done };
  }

  it('opens the queue BEFORE fetching, then applies the snapshot', async () => {
    const { calls, done } = harness(() => Promise.resolve('snap'));
    await done;
    expect(calls).toEqual(['beginQueue', 'fetch', 'apply:snap']);
  });

  it('a null snapshot still closes the queue (never strands syncing)', async () => {
    const { calls, done } = harness(() => Promise.resolve(null));
    await done;
    expect(calls).toEqual(['beginQueue', 'fetch', 'finish']);
  });

  it('a failed fetch still closes the queue', async () => {
    const { calls, done } = harness(() => Promise.reject(new Error('ipc down')));
    await done;
    expect(calls).toEqual(['beginQueue', 'fetch', 'finish']);
  });
});
