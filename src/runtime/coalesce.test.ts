import { describe, expect, it, vi } from 'vitest';
import { createLatestCoalescer } from './coalesce';

describe('createLatestCoalescer', () => {
  it('applies the first value immediately', () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const push = createLatestCoalescer<number>((v) => applied.push(v), 50);
    push(1);
    expect(applied).toEqual([1]);
    vi.runAllTimers();
    expect(applied).toEqual([1]);
    vi.useRealTimers();
  });

  it('collapses a burst to the latest value only', () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const push = createLatestCoalescer<number>((v) => applied.push(v), 50);
    push(1);
    push(2);
    push(3);
    push(4);
    expect(applied).toEqual([1]);
    vi.advanceTimersByTime(50);
    expect(applied).toEqual([1, 4]);
    vi.useRealTimers();
  });

  it('re-arms after the trailing apply so back-to-back bursts still coalesce', () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const push = createLatestCoalescer<number>((v) => applied.push(v), 50);
    push(1);
    push(2);
    vi.advanceTimersByTime(50); // -> applies 2, window re-armed
    push(3); // inside the re-armed window
    expect(applied).toEqual([1, 2]);
    vi.advanceTimersByTime(50);
    expect(applied).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });
});
