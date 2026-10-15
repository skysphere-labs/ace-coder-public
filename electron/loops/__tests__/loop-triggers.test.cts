// loop-triggers tests — the schedule/event trigger scheduler (PRD §9 Slice 3).
// Pure module with INJECTED timers, so we drive it with a fake clock + fake
// setTimeout. node:test + node:assert/strict.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-triggers.cts');
} catch {
  mod = require('../loop-triggers.cjs');
}
const { computeNextFire, scheduleTriggersOf, loopsForEvent, createLoopTriggerScheduler, MIN_EVERY_MS } = mod;

function loop(id: string, triggers: any[]): any {
  return { id, name: id, useWhen: id, triggers };
}

// A controllable fake timer + clock.
function fakeTimers() {
  let nowMs = 1_000_000;
  let seq = 0;
  const scheduled: Array<{ id: number; fn: () => void; at: number }> = [];
  return {
    now: () => nowMs,
    setTimeout: (fn: () => void, ms: number) => {
      const h = { id: (seq += 1), fn, at: nowMs + ms };
      scheduled.push(h);
      return h;
    },
    clearTimeout: (h: any) => {
      const i = scheduled.findIndex((x) => x === h || x.id === (h && h.id));
      if (i >= 0) scheduled.splice(i, 1);
    },
    advance: (ms: number) => {
      nowMs += ms;
      const due = scheduled.filter((h) => h.at <= nowMs).sort((a, b) => a.at - b.at);
      for (const h of due) {
        const i = scheduled.indexOf(h);
        if (i >= 0) scheduled.splice(i, 1);
        h.fn();
      }
    },
    pending: () => scheduled.length,
  };
}

// ── computeNextFire ───────────────────────────────────────────────────────────

test('computeNextFire: interval trigger → now + everyMs', () => {
  assert.equal(computeNextFire({ kind: 'schedule', enabled: true, everyMs: 60_000 }, 1000), 61_000);
});

test('computeNextFire: disabled / event / malformed → null', () => {
  assert.equal(computeNextFire({ kind: 'schedule', enabled: false, everyMs: 60_000 }, 0), null);
  assert.equal(computeNextFire({ kind: 'event', enabled: true, event: 'x' }, 0), null);
  assert.equal(computeNextFire({ kind: 'schedule', enabled: true }, 0), null);
  assert.equal(computeNextFire(null, 0), null);
});

test('computeNextFire: an everyMs below the floor never fires (null)', () => {
  assert.equal(computeNextFire({ kind: 'schedule', enabled: true, everyMs: MIN_EVERY_MS - 1 }, 0), null);
});

test('computeNextFire: dailyAt resolves to the next local HH:MM strictly after now', () => {
  const base = new Date(2026, 5, 20, 8, 0, 0, 0).getTime(); // local 08:00
  const next = computeNextFire({ kind: 'schedule', enabled: true, dailyAt: '09:30' }, base);
  assert.equal(next, new Date(2026, 5, 20, 9, 30, 0, 0).getTime());
  // a time already passed today rolls to tomorrow
  const next2 = computeNextFire({ kind: 'schedule', enabled: true, dailyAt: '07:00' }, base);
  assert.equal(next2, new Date(2026, 5, 21, 7, 0, 0, 0).getTime());
});

// ── pure selectors ────────────────────────────────────────────────────────────

test('scheduleTriggersOf collects only enabled schedule triggers', () => {
  const loops = [
    loop('a', [{ kind: 'schedule', enabled: true, everyMs: 60_000 }, { kind: 'event', enabled: true, event: 'e' }]),
    loop('b', [{ kind: 'schedule', enabled: false, everyMs: 60_000 }]),
  ];
  const got = scheduleTriggersOf(loops);
  assert.equal(got.length, 1);
  assert.equal(got[0].loopId, 'a');
});

test('loopsForEvent matches enabled event triggers by name', () => {
  const loops = [
    loop('a', [{ kind: 'event', enabled: true, event: 'intel.refresh' }]),
    loop('b', [{ kind: 'event', enabled: false, event: 'intel.refresh' }]),
    loop('c', [{ kind: 'event', enabled: true, event: 'other' }]),
  ];
  assert.deepEqual(loopsForEvent(loops, 'intel.refresh'), ['a']);
  assert.deepEqual(loopsForEvent(loops, 'nope'), []);
});

// ── scheduler with fake timers ────────────────────────────────────────────────

test('scheduler arms an interval trigger, fires runLoop on tick, and reschedules', () => {
  const ft = fakeTimers();
  const fired: string[] = [];
  let loops = [loop('digest', [{ kind: 'schedule', enabled: true, everyMs: 60_000 }])];
  const sched = createLoopTriggerScheduler({
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
    listLoops: () => loops,
    runLoop: (id: string) => fired.push(id),
  });

  sched.start();
  assert.equal(sched.armedCount(), 1);
  assert.equal(fired.length, 0);

  ft.advance(60_000); // first tick
  assert.deepEqual(fired, ['digest']);
  assert.equal(sched.armedCount(), 1, 'rescheduled for the next cycle');

  ft.advance(60_000); // second tick
  assert.deepEqual(fired, ['digest', 'digest']);

  sched.stop();
  assert.equal(sched.armedCount(), 0);
});

test('scheduler does NOT fire a trigger that was removed/disabled before the tick', () => {
  const ft = fakeTimers();
  const fired: string[] = [];
  let loops = [loop('digest', [{ kind: 'schedule', enabled: true, everyMs: 60_000 }])];
  const sched = createLoopTriggerScheduler({
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
    listLoops: () => loops,
    runLoop: (id: string) => fired.push(id),
  });
  sched.start();
  // operator removes the loop before the tick lands
  loops = [];
  ft.advance(60_000);
  assert.deepEqual(fired, [], 'a removed trigger must not fire');
  assert.equal(sched.armedCount(), 0, 'and must not reschedule');
});

test('fireEvent fires every loop whose enabled event trigger matches', () => {
  const ft = fakeTimers();
  const fired: string[] = [];
  const loops = [
    loop('a', [{ kind: 'event', enabled: true, event: 'intel.refresh' }]),
    loop('b', [{ kind: 'event', enabled: true, event: 'intel.refresh' }]),
    loop('c', [{ kind: 'event', enabled: true, event: 'other' }]),
  ];
  const sched = createLoopTriggerScheduler({
    now: ft.now,
    setTimeout: ft.setTimeout,
    clearTimeout: ft.clearTimeout,
    listLoops: () => loops,
    runLoop: (id: string) => fired.push(id),
  });
  const out = sched.fireEvent('intel.refresh');
  assert.deepEqual(out.sort(), ['a', 'b']);
  assert.deepEqual(fired.sort(), ['a', 'b']);
});
