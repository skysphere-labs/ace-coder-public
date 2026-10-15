import { test, expect, vi } from 'vitest';

const { createCoalescer } = require('../coalesce.cts');

test('isolated call runs immediately (leading edge)', () => {
  vi.useFakeTimers();
  const calls = [];
  const c = createCoalescer(() => calls.push(Date.now()), 100);
  c.call();
  expect(calls.length).toBe(1);
  vi.runAllTimers();
  expect(calls.length).toBe(1);
  vi.useRealTimers();
});

test('a burst collapses to leading + one trailing call with the final state delivered', () => {
  vi.useFakeTimers();
  let runs = 0;
  const c = createCoalescer(() => { runs += 1; }, 100);
  c.call();
  c.call();
  c.call();
  c.call();
  expect(runs).toBe(1);
  expect(c.pending()).toBe(true);
  vi.advanceTimersByTime(100);
  expect(runs).toBe(2);
  expect(c.pending()).toBe(false);
  vi.useRealTimers();
});

test('trailing flush re-arms the window so a follow-up burst still coalesces', () => {
  vi.useFakeTimers();
  let runs = 0;
  const c = createCoalescer(() => { runs += 1; }, 100);
  c.call();
  c.call();
  vi.advanceTimersByTime(100); // trailing -> runs=2, window re-armed
  c.call(); // inside the re-armed window -> pending, not immediate
  expect(runs).toBe(2);
  vi.advanceTimersByTime(100);
  expect(runs).toBe(3);
  vi.useRealTimers();
});

test('leading call propagates errors; trailing call swallows via onError', () => {
  vi.useFakeTimers();
  let boom = false;
  const seen = [];
  const c = createCoalescer(() => {
    if (boom) throw new Error('trailing-boom');
  }, 100, { onError: (e) => seen.push(String(e && e.message)) });
  c.call(); // leading, no throw
  c.call(); // pending
  boom = true;
  expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  expect(seen).toEqual(['trailing-boom']);
  boom = false;
  expect(() => c.call()).not.toThrow(); // idle again after window passes
  vi.useRealTimers();
});

test('cancel drops an owed trailing call', () => {
  vi.useFakeTimers();
  let runs = 0;
  const c = createCoalescer(() => { runs += 1; }, 100);
  c.call();
  c.call();
  c.cancel();
  vi.runAllTimers();
  expect(runs).toBe(1);
  vi.useRealTimers();
});
