import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  nextKnowledgeNightlyRun,
  scheduleKnowledgeNightly,
  readNightlyState,
  readNightlyHistory,
} = require('../knowledge-nightly-scheduler.cts');

let stateDir = '';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-nightly-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
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
  };
}

async function drainTimeouts(timers, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    const pending = timers.timeouts.splice(0);
    for (const timer of pending) timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('knowledge nightly scheduler', () => {
  it('computes the next run at 03:30 local time, clear of the 04:00/06:00 timers', () => {
    const before = nextKnowledgeNightlyRun(new Date(2026, 5, 10, 2, 0, 0, 0));
    expect(before.getDate()).toBe(10);
    expect(before.getHours()).toBe(3);
    expect(before.getMinutes()).toBe(30);

    const after = nextKnowledgeNightlyRun(new Date(2026, 5, 10, 3, 30, 0, 0));
    expect(after.getDate()).toBe(11);
  });

  it('runs knowledgeNightly daily and records run history', async () => {
    const timers = fakeTimers();
    const subscriptions = [];
    const calls = [];
    const store = {
      knowledgeNightly: (input) => {
        calls.push(input);
        return { ok: true, findings: 2, proposals: 3, quarantined: 0, index: { indexed: 5 }, curatedProjects: 1, reportPath: '/x.md' };
      },
    };

    const scheduled = scheduleKnowledgeNightly({
      getStore: () => store,
      subscriptions,
      stateDir,
      now: () => new Date(2026, 5, 10, 2, 0, 0, 0),
      logger: { error: () => {}, warn: () => {} },
      env: {},
      ...timers,
    });
    expect(scheduled).toBe(true);
    expect(timers.timeouts[0].ms).toBe(90 * 60 * 1000); // 02:00 → 03:30

    await drainTimeouts(timers);
    expect(calls.length).toBe(1);
    expect(timers.intervals.length).toBe(1);
    expect(timers.intervals[0].ms).toBe(24 * 60 * 60 * 1000);

    const state = readNightlyState(stateDir);
    expect(state.schema).toBe('AceKnowledgeNightlyRun/v1');
    expect(state.status).toBe('ok');
    expect(state.findings).toBe(2);
    expect(readNightlyHistory(stateDir).length).toBe(1);
  });

  it('records errors and never throws when the run fails', async () => {
    const timers = fakeTimers();
    const store = { knowledgeNightly: () => { throw new Error('boom'); } };
    scheduleKnowledgeNightly({
      getStore: () => store,
      subscriptions: [],
      stateDir,
      now: () => new Date(2026, 5, 10, 3, 0, 0, 0),
      logger: { error: () => {}, warn: () => {} },
      env: {},
      ...timers,
    });
    await drainTimeouts(timers);
    const state = readNightlyState(stateDir);
    expect(state.status).toBe('error');
    expect(state.error).toContain('boom');
  });

  it('honors the opt-out env and missing store method', () => {
    const timers = fakeTimers();
    expect(scheduleKnowledgeNightly({
      getStore: () => ({ knowledgeNightly: () => ({}) }),
      subscriptions: [],
      env: { ACE_KNOWLEDGE_NIGHTLY_DISABLE: '1' },
      ...timers,
    })).toBe(false);
    expect(scheduleKnowledgeNightly({
      getStore: () => ({}),
      subscriptions: [],
      env: {},
      ...timers,
    })).toBe(false);
    expect(timers.timeouts.length).toBe(0);
  });

  it('latches: an active run is never overlapped by the next tick', async () => {
    const timers = fakeTimers();
    let resolveRun;
    let started = 0;
    const store = {
      knowledgeNightly: () => {
        started += 1;
        return new Promise((resolve) => { resolveRun = resolve; });
      },
    };
    const warned = [];
    scheduleKnowledgeNightly({
      getStore: () => store,
      subscriptions: [],
      stateDir,
      now: () => new Date(2026, 5, 10, 3, 0, 0, 0),
      logger: { error: () => {}, warn: (msg) => warned.push(msg) },
      env: {},
      ...timers,
    });
    // fire the first timer → schedules the run + daily interval
    await drainTimeouts(timers, 2);
    expect(started).toBe(1);
    // simulate the next daily tick while the first run is still pending
    timers.intervals[0].fn();
    await drainTimeouts(timers, 2);
    expect(started).toBe(1);
    expect(warned.some((msg) => msg.includes('still active'))).toBe(true);
    resolveRun({ ok: true });
  });
});
