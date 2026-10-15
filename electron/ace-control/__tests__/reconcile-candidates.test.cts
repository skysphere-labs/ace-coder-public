// reconcile-candidates.test — the in-flight reconcile poller's pure selection:
// stop/candidate filtering, the recency window, the live-stream bypass that
// heals stranded TUI runs, and the reserved+rotated slots that keep five newer
// runs from starving an old stranded one (and one stale run from monopolizing).
//
//   node --test --require tsx/cjs electron/ace-control/__tests__/reconcile-candidates.test.cts
const test = require('node:test');
const assert = require('node:assert/strict');

const { selectReconcileCandidates } = require('../reconcile-candidates.cts');

const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;
const OPTS = { now: NOW, recentMs: 6 * HOUR, maxPerTick: 5 };

const row = (runId, lastType, ageHours, streamId = '') => ({
  runId,
  lastType,
  lastTs: NOW - ageHours * HOUR,
  streamId,
});

test('in-window candidates are selected newest-first up to the cap', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`run-${n}`, 'worker.dispatch.linked', n * 0.5));
  const picked = selectReconcileCandidates(rows, OPTS);
  assert.deepEqual(picked, ['run-1', 'run-2', 'run-3', 'run-4', 'run-5']);
});

test('stop events and non-candidate tails are excluded', () => {
  const rows = [
    row('run-ok', 'worker.dispatch.linked', 1),
    row('run-failed', 'worker.dispatch.failed', 1),
    row('run-merged', 'merged', 1),
    row('run-created', 'run.created', 1),
  ];
  assert.deepEqual(selectReconcileCandidates(rows, OPTS), ['run-ok']);
});

test('a stale linked run is dropped without a live stream, kept with one', () => {
  const rows = [row('run-old', 'worker.dispatch.linked', 20, 'variant:v-old')];
  assert.deepEqual(selectReconcileCandidates(rows, { ...OPTS, isStreamLive: () => false }), []);
  assert.deepEqual(selectReconcileCandidates(rows, { ...OPTS, isStreamLive: () => true }), ['run-old']);
});

test('stale non-linked tails never bypass the window, live stream or not', () => {
  const rows = [row('run-old', 'worker.completed', 20, 'variant:v-old')];
  assert.deepEqual(selectReconcileCandidates(rows, { ...OPTS, isStreamLive: () => true }), []);
});

test('bypassed runs get reserved slots — five newer runs cannot starve a stranded one', () => {
  const rows = [
    ...[1, 2, 3, 4, 5].map((n) => row(`fresh-${n}`, 'worker.dispatch.linked', n * 0.5)),
    row('stranded', 'worker.dispatch.linked', 40, 'variant:v-stranded'),
  ];
  const picked = selectReconcileCandidates(rows, { ...OPTS, isStreamLive: () => true });
  assert.equal(picked.length, 5);
  assert.ok(picked.includes('stranded'), 'the window-bypassed run holds a reserved slot');
  assert.deepEqual(picked.slice(0, 3), ['fresh-1', 'fresh-2', 'fresh-3']);
});

test('the bypassed pool rotates by tick so no single stale run monopolizes', () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => row(`fresh-${n}`, 'worker.dispatch.linked', n * 0.5)),
    row('stranded-a', 'worker.dispatch.linked', 40, 'variant:a'),
    row('stranded-b', 'worker.dispatch.linked', 30, 'variant:b'),
    row('stranded-c', 'worker.dispatch.linked', 20, 'variant:c'),
  ];
  const opts = { ...OPTS, isStreamLive: () => true };
  const seen = new Set();
  for (let tick = 0; tick < 3; tick += 1) {
    for (const id of selectReconcileCandidates(rows, { ...opts, tick })) {
      if (id.startsWith('stranded')) seen.add(id);
    }
  }
  assert.deepEqual([...seen].sort(), ['stranded-a', 'stranded-b', 'stranded-c']);
});

test('an in-window pool one over the cap rotates: every candidate is polled across ticks', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => row(`run-${n}`, 'worker.dispatch.linked', n * 0.5));
  const seen = new Set();
  for (let tick = 0; tick < 6; tick += 1) {
    for (const id of selectReconcileCandidates(rows, { ...OPTS, tick })) seen.add(id);
  }
  assert.equal(seen.size, 6, 'no in-window candidate may be starved behind the cap');
});

test('cap 1 with both pools alternates the sole slot — neither pool starves', () => {
  const rows = [
    row('fresh', 'worker.dispatch.linked', 1),
    row('stranded-a', 'worker.dispatch.linked', 30, 'variant:a'),
    row('stranded-b', 'worker.dispatch.linked', 20, 'variant:b'),
  ];
  const opts = { ...OPTS, maxPerTick: 1, isStreamLive: () => true };
  const seen = new Set();
  for (let tick = 0; tick < 6; tick += 1) {
    for (const id of selectReconcileCandidates(rows, { ...opts, tick })) seen.add(id);
  }
  assert.deepEqual([...seen].sort(), ['fresh', 'stranded-a', 'stranded-b']);
});

test('cap 2 with both pools leaves the in-window pool at least one slot', () => {
  const rows = [
    row('fresh-1', 'worker.dispatch.linked', 1),
    row('fresh-2', 'worker.dispatch.linked', 2),
    row('stranded-a', 'worker.dispatch.linked', 30, 'variant:a'),
    row('stranded-b', 'worker.dispatch.linked', 20, 'variant:b'),
  ];
  const opts = { ...OPTS, maxPerTick: 2, isStreamLive: () => true };
  const seen = new Set();
  for (let tick = 0; tick < 4; tick += 1) {
    const picked = selectReconcileCandidates(rows, { ...opts, tick });
    assert.equal(picked.length, 2);
    assert.ok(picked.some((id) => id.startsWith('fresh')), 'in-window pool keeps a slot every tick');
    for (const id of picked) seen.add(id);
  }
  assert.equal(seen.size, 4, 'all candidates polled across ticks');
});

test('with no in-window candidates the cap still applies to bypassed runs', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    row(`old-${n}`, 'worker.dispatch.linked', 10 + n, `variant:${n}`)
  );
  const picked = selectReconcileCandidates(rows, { ...OPTS, isStreamLive: () => true });
  assert.equal(picked.length, 5);
});
