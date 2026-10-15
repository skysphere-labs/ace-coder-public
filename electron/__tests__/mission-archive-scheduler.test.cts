import { describe, expect, it } from 'vitest';

const {
  OPS_STATUS_SNAPSHOT_INTERVAL_MS,
  nextOpsStatusSnapshotRun,
  scheduleOpsStatusSnapshot,
} = require('../mission-archive-scheduler.cts');

describe('ops status snapshot scheduler', () => {
  it('computes the next run at 06:00 local time', () => {
    const now = new Date(2026, 4, 25, 5, 15, 0, 0);
    const next = nextOpsStatusSnapshotRun(now);

    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(0);
    expect(next.getSeconds()).toBe(0);
  });

  it('returns false when the store lacks opsStatusSnapshot', () => {
    expect(
      scheduleOpsStatusSnapshot({ getStore: () => ({}), subscriptions: [] })
    ).toBe(false);
  });

  it('defers the first snapshot and repeats every 24 hours, in-process (no relaunch)', async () => {
    const calls = [];
    const timeouts = [];
    const intervals = [];
    const subscriptions = [];
    const store = {
      opsStatusSnapshot: (input) => {
        calls.push(input);
      },
    };
    const now = new Date(2026, 4, 25, 5, 15, 0, 0);

    const scheduled = scheduleOpsStatusSnapshot({
      getStore: () => store,
      subscriptions,
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: (fn, ms) => {
        const timer = { fn, ms };
        intervals.push(timer);
        return timer;
      },
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    expect(scheduled).toBe(true);
    expect(timeouts[0].ms).toBe(45 * 60 * 1000);

    timeouts[0].fn();
    expect(calls).toEqual([]);
    expect(intervals[0].ms).toBe(OPS_STATUS_SNAPSHOT_INTERVAL_MS);
    expect(OPS_STATUS_SNAPSHOT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);

    timeouts[1].fn();
    await Promise.resolve();
    expect(calls).toEqual([{ source: 'scheduler' }]);
    expect(subscriptions).toHaveLength(2);
  });
});
