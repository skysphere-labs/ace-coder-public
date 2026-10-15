import { test, expect, vi } from 'vitest';

const { createStreamStateManager, rewriteTruecolorBlack } = require('../pty-stream-states.cts');

function collect() {
  const out = [];
  return { out, deliver: (p) => out.push(p) };
}

test('first chunk after idle delivers immediately (keystroke echo stays instant)', () => {
  vi.useFakeTimers();
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 24);
  const { out, deliver } = collect();
  mgr.pump('s1', 'hello', deliver);
  expect(out.length).toBe(1);
  expect(out[0].rewritten).toBe('hello');
  expect(out[0].seq).toBe(1);
  mgr.remove('s1');
  vi.useRealTimers();
});

test('a streaming burst collapses to one delivery per window with bytes concatenated', () => {
  vi.useFakeTimers();
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 24);
  const { out, deliver } = collect();
  mgr.pump('s1', 'a', deliver); // leading
  mgr.pump('s1', 'b', deliver);
  mgr.pump('s1', 'c', deliver);
  mgr.pump('s1', 'd', deliver);
  expect(out.length).toBe(1);
  vi.advanceTimersByTime(16);
  expect(out.length).toBe(2);
  expect(out[1].rewritten).toBe('bcd');
  expect(out[1].seq).toBe(2); // one seq per flush, monotonic
  mgr.remove('s1');
  vi.useRealTimers();
});

test('continuous stream stays in batched mode across windows', () => {
  vi.useFakeTimers();
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 24);
  const { out, deliver } = collect();
  mgr.pump('s1', 'x', deliver); // leading
  mgr.pump('s1', 'y', deliver);
  vi.advanceTimersByTime(16); // flush 'y', window re-armed
  mgr.pump('s1', 'z', deliver); // lands inside the re-armed window
  expect(out.length).toBe(2);
  vi.advanceTimersByTime(16);
  expect(out.length).toBe(3);
  expect(out[2].rewritten).toBe('z');
  mgr.remove('s1');
  vi.useRealTimers();
});

test('sync() flushes the batched tail so snapshots never miss bytes', async () => {
  vi.useFakeTimers();
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 24);
  const { out, deliver } = collect();
  mgr.pump('s1', 'first ', deliver); // leading
  mgr.pump('s1', 'tail', deliver); // buffered
  const syncPromise = mgr.sync('s1'); // must flush 'tail' before serializing
  expect(out.length).toBe(2);
  expect(out[1].rewritten).toBe('tail');
  await vi.runAllTimersAsync();
  const snapshot = await syncPromise;
  expect(snapshot.seq).toBe(out[1].seq); // snapshot covers everything delivered
  expect(snapshot.state).toContain('first tail');
  mgr.remove('s1');
  vi.useRealTimers();
});

test('sync() caps serialized scrollback to the client-advertised depth', async () => {
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 4);
  // 40 numbered lines through a 4-row viewport => 36 scrollback rows.
  for (let i = 1; i <= 40; i++) mgr.writeData('s1', `line-${i}\r\n`);
  const full = await mgr.sync('s1');
  expect(full.state).toContain('line-1');
  const capped = await mgr.sync('s1', { scrollback: 5 });
  expect(capped.state).toContain('line-40');
  expect(capped.state).toContain('line-33'); // within 5 scrollback rows + viewport
  expect(capped.state).not.toContain('line-1'); // beyond the cap: dropped
  expect(capped.state.length).toBeLessThan(full.state.length);
  // Bogus caps fall back to the full buffer instead of throwing.
  const bogus = await mgr.sync('s1', { scrollback: 'nope' });
  expect(bogus.state).toContain('line-1');
  mgr.remove('s1');
});

test('remove() cancels a pending flush', () => {
  vi.useFakeTimers();
  const mgr = createStreamStateManager();
  mgr.ensureState('s1', 80, 24);
  const { out, deliver } = collect();
  mgr.pump('s1', 'a', deliver);
  mgr.pump('s1', 'b', deliver);
  mgr.remove('s1');
  vi.runAllTimers();
  expect(out.length).toBe(1); // buffered 'b' dropped with the stream
  vi.useRealTimers();
});

test('truecolor black rewrite stays boundary-safe across batched chunks', () => {
  const partial = { buf: '' };
  const esc = '\x1b[48;2;0;0;0m';
  const a = rewriteTruecolorBlack('pre' + esc.slice(0, 5), partial);
  const b = rewriteTruecolorBlack(esc.slice(5) + 'post', partial);
  expect(a + b).toBe('pre\x1b[40mpost');
});

test('a reused mirror resized to the respawned PTY dims keeps footer and composer on distinct rows', async () => {
  const mgr = createStreamStateManager();
  // The mirror survives from a previous lifecycle, two rows SHORTER than the
  // PTY the lane respawns at. ensureState deliberately does NOT touch it —
  // the spawn path calls resize() with the fresh PTY's real dims, so a failed
  // live-stream pty resize can never leave the mirror resized ahead of it.
  const state = mgr.ensureState('s1', 105, 40);
  expect(mgr.ensureState('s1', 105, 42)).toBe(state);
  expect(state.rows).toBe(40); // untouched: resize is the caller's move
  mgr.resize('s1', 105, 42); // what ensureStreamOnce now does before spawning
  expect(state.rows).toBe(42);

  // The TUI paints its footer on the PTY's last row: with matching dims the
  // composer row and the footer row stay distinct rows in the snapshot.
  // With the stale 40-row mirror, both writes would clamp onto row 40 and the
  // footer would overwrite the composer row (the live garble this fixes).
  mgr.writeData('s1', '\x1b[41;1H❯ ');
  mgr.writeData('s1', '\x1b[42;1H  ⏵⏵ bypass permissions on');
  const snap = await mgr.sync('s1', { scrollback: 0 });
  const rows = String(snap.state).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  const composerRow = rows.findIndex((r) => r.includes('❯'));
  const footerRow = rows.findIndex((r) => r.includes('bypass permissions'));
  expect(composerRow).toBeGreaterThanOrEqual(0);
  expect(footerRow).toBe(composerRow + 1); // clamped dims would merge these
  mgr.remove('s1');
});
