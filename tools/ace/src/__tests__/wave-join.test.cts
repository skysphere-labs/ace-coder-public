const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateWaveJoin, laneIsTerminal, summarizeWaveJoin, assertWaveReady } = require('../wave-join.cjs');
const { createChildRegistry } = require('../child-registry.cjs');

test('wave-join: ready=false while any lane is nonterminal', () => {
  const rows = [
    { taskId: 't1', waveId: 'w', laneId: 'a', laneStatus: 'done' },
    { taskId: 't2', waveId: 'w', laneId: 'b' },
  ];
  const verdict = evaluateWaveJoin({ rows, waveId: 'w' });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.terminalCount, 1);
  assert.equal(verdict.nonterminalCount, 1);
  assert.deepEqual(verdict.nonterminalLanes, ['b']);
});

test('wave-join: ready=true once every lane carries a terminal laneStatus or PR state', () => {
  const rows = [
    { taskId: 't1', waveId: 'w', laneId: 'a', laneStatus: 'done' },
    { taskId: 't2', waveId: 'w', laneId: 'b', laneStatus: 'blocked' },
    { taskId: 't3', waveId: 'w', laneId: 'c', prState: 'merged' },
  ];
  const verdict = evaluateWaveJoin({ rows, waveId: 'w' });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.terminalCount, 3);
  assert.equal(verdict.nonterminalCount, 0);
});

test('wave-join: filters by waveId so unrelated rows do not leak in', () => {
  const rows = [
    { taskId: 't1', waveId: 'w', laneId: 'a', terminalAt: Date.now() },
    { taskId: 't2', waveId: 'other', laneId: 'b' },
  ];
  const verdict = evaluateWaveJoin({ rows, waveId: 'w' });
  assert.equal(verdict.laneCount, 1);
  assert.equal(verdict.ready, true);
});

test('wave-join: missing expectedLaneIds blocks even when present rows are terminal', () => {
  const rows = [
    { taskId: 't1', waveId: 'w', laneId: 'a', laneStatus: 'done' },
  ];
  const verdict = evaluateWaveJoin({ rows, waveId: 'w', expectedLaneIds: ['a', 'b'] });
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.missingLanes, ['b']);
});

test('wave-join: free-text lastTrailer detail is NOT a join signal', () => {
  // Real orchestrator-written rows store lastTrailer as the worker's
  // free-text DONE: detail. That is not a structured kind and must not
  // be treated as terminal — only laneStatus is.
  const rows = [
    { taskId: 't1', waveId: 'w', laneId: 'a', lastTrailer: 'shipped the thing' },
  ];
  const verdict = evaluateWaveJoin({ rows, waveId: 'w' });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.nonterminalCount, 1);
});

test('wave-join: registry rows written by orchestrator.runTask are recognized', () => {
  // Mirror the actual write path: register() then updatePrState with the
  // outcome the orchestrator computes. Wave join must read straight from
  // a real-shape row.
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_done', waveId: 'w', laneId: 'a', branch: 'b', worktreePath: '/w' });
  reg.updatePrState('tsk_done', { lastTrailer: 'shipped', laneStatus: 'done' });
  reg.register({ taskId: 'tsk_busy', waveId: 'w', laneId: 'b', branch: 'b2', worktreePath: '/w2' });

  const rows = reg.list();
  let verdict = evaluateWaveJoin({ rows, waveId: 'w' });
  assert.equal(verdict.ready, false, 'busy lane keeps the wave open');
  assert.deepEqual(verdict.nonterminalLanes, ['b']);

  reg.updatePrState('tsk_busy', { laneStatus: 'blocked' });
  verdict = evaluateWaveJoin({ rows: reg.list(), waveId: 'w' });
  assert.equal(verdict.ready, true);
});

test('wave-join: event-driven completion is not ready after first lane, ready after all expected lanes terminal', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_a', streamId: 'conversation:a', waveId: 'w', laneId: 'a', branch: 'feat/a', worktreePath: '/a' });
  reg.register({ taskId: 'tsk_b', streamId: 'conversation:b', waveId: 'w', laneId: 'b', branch: 'feat/b', worktreePath: '/b' });

  reg.recordWorkerCompletion({
    streamId: 'conversation:a',
    taskId: 'tsk_a',
    waveId: 'w',
    laneId: 'a',
    outcome: 'done',
    detail: 'lane a done',
  });
  let verdict = evaluateWaveJoin({ rows: reg.list(), waveId: 'w', expectedLaneIds: ['a', 'b'] });
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.nonterminalLanes, ['b']);

  reg.recordWorkerCompletion({
    streamId: 'conversation:b',
    taskId: 'tsk_b',
    waveId: 'w',
    laneId: 'b',
    outcome: 'blocked',
    detail: 'lane b blocked',
  });
  verdict = evaluateWaveJoin({ rows: reg.list(), waveId: 'w', expectedLaneIds: ['a', 'b'] });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.terminalCount, 2);
});

test('summarizeWaveJoin: returns one verdict per wave, skips rows without waveId', () => {
  const rows = [
    { taskId: 't1', waveId: 'w1', laneId: 'a', laneStatus: 'done' },
    { taskId: 't2', waveId: 'w1', laneId: 'b' },
    { taskId: 't3', waveId: 'w2', laneId: 'c', laneStatus: 'done' },
    { taskId: 't4' /* no waveId */, laneStatus: 'done' },
  ];
  const summaries = summarizeWaveJoin(rows);
  assert.equal(summaries.length, 2);
  const w1 = summaries.find((s: any) => s.waveId === 'w1');
  const w2 = summaries.find((s: any) => s.waveId === 'w2');
  assert.equal(w1.ready, false);
  assert.equal(w2.ready, true);
});

test('assertWaveReady: throws WAVE_NOT_READY while any lane is nonterminal', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_done', waveId: 'w', laneId: 'a', branch: 'b', worktreePath: '/w' });
  reg.updatePrState('tsk_done', { laneStatus: 'done' });
  reg.register({ taskId: 'tsk_busy', waveId: 'w', laneId: 'b', branch: 'b2', worktreePath: '/w2' });

  let caught: any = null;
  try {
    assertWaveReady({ rows: reg.list(), waveId: 'w' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'assertWaveReady must throw when a lane is nonterminal');
  assert.match(caught.message, /wave w not ready/);
  assert.equal(caught.code, 'WAVE_NOT_READY');
  assert.equal(caught.verdict.ready, false);
  assert.deepEqual(caught.verdict.nonterminalLanes, ['b']);
});

test('assertWaveReady: empty registry blocks the wave gate', () => {
  let caught: any = null;
  try {
    assertWaveReady({ rows: [], waveId: 'wave-1' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'empty registry must not green-light an unknown wave');
  assert.equal(caught.code, 'WAVE_NOT_READY');
  assert.equal(caught.verdict.empty, true);
  assert.match(caught.message, /no lanes registered/);
});

test('assertWaveReady: missing expectedLaneIds block even when present rows are terminal', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_a', waveId: 'w', laneId: 'a', branch: 'b', worktreePath: '/w' });
  reg.updatePrState('tsk_a', { laneStatus: 'done' });

  let caught: any = null;
  try {
    assertWaveReady({ rows: reg.list(), waveId: 'w', expectedLaneIds: ['a', 'b', 'c'] });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'missing lanes must block the gate');
  assert.deepEqual(caught.verdict.missingLanes, ['b', 'c']);
  assert.match(caught.message, /missing lane/);
});

test('assertWaveReady: returns the verdict once every lane lands', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_a', waveId: 'w', laneId: 'a', branch: 'b', worktreePath: '/w' });
  reg.updatePrState('tsk_a', { laneStatus: 'done' });
  reg.register({ taskId: 'tsk_b', waveId: 'w', laneId: 'b', branch: 'b2', worktreePath: '/w2' });
  reg.updatePrState('tsk_b', { laneStatus: 'blocked' });

  const verdict = assertWaveReady({ rows: reg.list(), waveId: 'w' });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.terminalCount, 2);
});

test('laneIsTerminal: laneStatus mappings cover every orchestrator outcome', () => {
  for (const status of ['done', 'blocked', 'error', 'timeout', 'awaiting-approval', 'max-rounds', 'done-unverified']) {
    assert.equal(laneIsTerminal({ laneStatus: status }), true, `${status} should be terminal`);
  }
  assert.equal(laneIsTerminal({ laneStatus: 'busy' }), false);
  assert.equal(laneIsTerminal(null), false);
  assert.equal(laneIsTerminal({}), false);
});

test('a zombie row from a failed dispatch attempt does not block the lane retry', () => {
  const verdict = evaluateWaveJoin({
    waveId: 'wv_retry',
    rows: [
      // dead first attempt: same lane, never got a laneStatus
      { taskId: 'tsk_dead', laneId: 'lane_a', waveId: 'wv_retry', updatedAt: 1000 },
      // live retry: newest row for the lane, terminal
      { taskId: 'tsk_live', laneId: 'lane_a', waveId: 'wv_retry', laneStatus: 'done', updatedAt: 2000 },
      { taskId: 'tsk_b', laneId: 'lane_b', waveId: 'wv_retry', laneStatus: 'done', updatedAt: 2000 },
    ],
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.laneCount, 2);
  assert.equal(verdict.nonterminalCount, 0);
});

test('the newest row per lane decides terminality even when older rows are terminal', () => {
  const verdict = evaluateWaveJoin({
    waveId: 'wv_redispatch',
    rows: [
      { taskId: 'tsk_old', laneId: 'lane_a', waveId: 'wv_redispatch', laneStatus: 'done', updatedAt: 1000 },
      // lane was re-dispatched and is running again — wave must NOT join
      { taskId: 'tsk_new', laneId: 'lane_a', waveId: 'wv_redispatch', updatedAt: 2000 },
    ],
  });
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.nonterminalLanes, ['lane_a']);
});
