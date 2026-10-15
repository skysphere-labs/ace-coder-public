const test = require('node:test');
const assert = require('node:assert/strict');

const { createCompletionInbox } = require('../completion-inbox.cjs');

test('completion inbox queues DONE trailer with stream/task/worktree metadata', () => {
  let now = 1000;
  const inbox = createCompletionInbox({ now: () => now++ });
  inbox.beginTurn('conversation:done', 'prompt\n');

  const created = inbox.observeReady({
    streamId: 'conversation:done',
    state: 'turn-complete',
    text: 'prompt\nDONE: shipped the fix\n> ',
    context: {
      taskId: 'tsk_done',
      rootTaskId: 'tsk_done',
      isRootGoalAgent: true,
      isInternalSubagent: false,
      workspaceId: 'prj_1',
      branch: 'handoff-feat',
      worktreePath: '/tmp/handoff-feat',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      waveId: 'wave-1',
      laneId: 'lane-a',
      expectedLaneIds: ['lane-a', 'lane-b'],
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'done');
  assert.equal(created[0].detail, 'shipped the fix');
  assert.equal(created[0].streamId, 'conversation:done');
  assert.equal(created[0].taskId, 'tsk_done');
  assert.equal(created[0].rootTaskId, 'tsk_done');
  assert.equal(created[0].parentTaskId, null);
  assert.equal(created[0].isRootGoalAgent, true);
  assert.equal(created[0].isInternalSubagent, false);
  assert.equal(created[0].workspaceId, 'prj_1');
  assert.equal(created[0].branch, 'handoff-feat');
  assert.equal(created[0].worktreePath, '/tmp/handoff-feat');
  assert.equal(created[0].prNumber, 12);
  assert.equal(created[0].prUrl, 'https://github.com/o/r/pull/12');
  assert.equal(created[0].waveId, 'wave-1');
  assert.equal(created[0].laneId, 'lane-a');
  assert.deepEqual(created[0].expectedLaneIds, ['lane-a', 'lane-b']);
  assert.equal(created[0].outcome, 'done');
  assert.equal(inbox.list().length, 1);

  const acked = inbox.ack(created[0].id);
  assert.equal(acked.ackedAt, 1001);
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.list({ includeAcked: true }).length, 1);
});

test('completion inbox queues BLOCKED once for repeated ready renders in the same turn', () => {
  const inbox = createCompletionInbox({ now: () => 2000 });
  inbox.beginTurn('conversation:block', '');
  const payload = {
    streamId: 'conversation:block',
    state: 'turn-complete',
    text: 'BLOCKED: gh auth unavailable\n> ',
    context: { taskId: 'tsk_block', workspaceId: 'prj_1' },
  };

  assert.equal(inbox.observeReady(payload).length, 1);
  assert.equal(inbox.observeReady(payload).length, 0);

  const rows = inbox.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'blocked');
  assert.equal(rows[0].detail, 'gh auth unavailable');
});

test('completion inbox queues only the final Claude status glyph trailer', () => {
  const inbox = createCompletionInbox({ now: () => 2500 });
  inbox.beginTurn('conversation:claude-glyph', '');

  const created = inbox.observeReady({
    streamId: 'conversation:claude-glyph',
    state: 'turn-complete',
    text: '⏺ DONE: fixed trigger parsing\n⏺ BLOCKED: follow-up blocker\n',
    context: { taskId: 'tsk_glyph', workspaceId: 'prj_1' },
  });

  assert.deepEqual(
    created.map((row: any) => [row.kind, row.detail]),
    [
      ['blocked', 'follow-up blocker'],
    ]
  );
});

test('completion inbox keeps simultaneous stream completions independent', () => {
  const inbox = createCompletionInbox({ now: () => 3000 });
  inbox.beginTurn('conversation:a', 'A prompt\n');
  inbox.beginTurn('conversation:b', 'B prompt\n');

  const a = inbox.observeReady({
    streamId: 'conversation:a',
    state: 'turn-complete',
    text: 'A prompt\nDONE: opened PR\n> ',
    context: { taskId: 'tsk_a', workspaceId: 'prj_1', branch: 'a-feat' },
  });
  const b = inbox.observeReady({
    streamId: 'conversation:b',
    state: 'turn-complete',
    text: 'B prompt\nBLOCKED: tests need credentials\n> ',
    context: { taskId: 'tsk_b', workspaceId: 'prj_1', branch: 'b-feat' },
  });

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.deepEqual(
    inbox.list().map((row: any) => [row.streamId, row.taskId, row.branch, row.kind]),
    [
      ['conversation:a', 'tsk_a', 'a-feat', 'done'],
      ['conversation:b', 'tsk_b', 'b-feat', 'blocked'],
    ]
  );
});

test('completion inbox synthesizes a first turn for no-submit DONE', () => {
  const inbox = createCompletionInbox({ now: () => 4000 });
  inbox.ensureStream('conversation:no-submit', '');

  const created = inbox.observeReady({
    streamId: 'conversation:no-submit',
    state: 'turn-complete',
    text: 'worker output\nDONE: shipped without submit\n',
    context: { taskId: 'tsk_no_submit', workspaceId: 'prj_1' },
    allowSyntheticTurn: true,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].turnId, 1);
  assert.equal(created[0].kind, 'done');
  assert.equal(created[0].detail, 'shipped without submit');
});

test('completion inbox emits two ordered real trailers without duplicates', () => {
  let now = 5000;
  const inbox = createCompletionInbox({ now: () => now++ });
  inbox.ensureStream('conversation:multi-done', '');

  const first = inbox.observeReady({
    streamId: 'conversation:multi-done',
    state: 'turn-complete',
    text: 'DONE: shipped one\n',
    context: { taskId: 'tsk_multi', workspaceId: 'prj_1' },
    allowSyntheticTurn: true,
  });
  const duplicate = inbox.observeReady({
    streamId: 'conversation:multi-done',
    state: 'turn-complete',
    text: 'DONE: shipped one\n',
    context: { taskId: 'tsk_multi', workspaceId: 'prj_1' },
    allowSyntheticTurn: true,
  });
  const second = inbox.observeReady({
    streamId: 'conversation:multi-done',
    state: 'turn-complete',
    text: 'DONE: shipped one\nmore output\nDONE: shipped two\n',
    context: { taskId: 'tsk_multi', workspaceId: 'prj_1' },
    allowSyntheticTurn: true,
  });

  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);
  assert.equal(second.length, 1);
  assert.deepEqual(
    inbox.list().map((row: any) => row.detail),
    ['shipped one', 'shipped two']
  );
});

test('completion inbox ignores markdown prompt examples and queues final validator DONE', () => {
  const inbox = createCompletionInbox({ now: () => 6000 });
  inbox.ensureStream('conversation:stale-validator', '');

  const created = inbox.observeReady({
    streamId: 'conversation:stale-validator',
    state: 'turn-complete',
    text: [
      'Claude Code v2.1.138',
      '',
      '❯ # Deliverables',
      '- PR comment with VERDICT: pass|request-changes|block and concise findings.',
      '- DONE: VERDICT=<pass|request-changes|block> on PR #192.',
      '',
      '# Escape hatch',
      '- BLOCKED: missing context',
      '',
      '⏺ Posted verdict on PR #192.',
      '',
      '  DONE: VERDICT=pass on PR #192.',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ merge it',
    ].join('\n'),
    context: { taskId: 'tsk_validator', workspaceId: 'ws1' },
    allowSyntheticTurn: true,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'done');
  assert.equal(created[0].detail, 'VERDICT=pass on PR #192.');
});

test('completion inbox ignores prompt-contained command registry trailers and queues final DONE', () => {
  let now = 7000;
  const inbox = createCompletionInbox({ now: () => now++ });
  inbox.ensureStream('variant:var-39f77c4f', '');

  const registryOnly = [
    'command registry:',
    'BLOCKED: trailer state back to the feature.","ipcMethod":"special:missionSync","flags":',
    '›',
  ].join('\n');
  const falseBlocked = inbox.observeReady({
    streamId: 'variant:var-39f77c4f',
    state: 'turn-complete',
    text: registryOnly,
    context: { taskId: 'tsk_live', workspaceId: 'ws1' },
    allowSyntheticTurn: true,
  });
  assert.equal(falseBlocked.length, 0);

  const created = inbox.observeReady({
    streamId: 'variant:var-39f77c4f',
    state: 'turn-complete',
    text: [
      registryOnly,
      'assistant final:',
      'DONE: lane A observed describe/mission commands; no code changes.',
      '›',
    ].join('\n'),
    context: { taskId: 'tsk_live', workspaceId: 'ws1' },
    allowSyntheticTurn: true,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'done');
  assert.equal(created[0].detail, 'lane A observed describe/mission commands; no code changes.');
});

test('recordDirect: creates a completion record for a raw-ring trailer and dedupes repeats', () => {
  let now = 9000;
  const inbox = createCompletionInbox({ now: () => now++ });

  const record = inbox.recordDirect({
    streamId: 'variant:var-raw',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'repaint-survivor completion' },
    context: { taskId: 'tsk_raw', workspaceId: 'ws1', agent: 'claude', branch: 'feat/raw' },
  });
  assert.ok(record, 'record created');
  assert.equal(record.kind, 'done');
  assert.equal(record.outcome, 'done');
  assert.equal(record.detail, 'repaint-survivor completion');
  assert.equal(record.taskId, 'tsk_raw');
  assert.equal(record.agent, 'claude');
  assert.equal(record.branch, 'feat/raw');
  assert.equal(inbox.list({ streamId: 'variant:var-raw' }).length, 1);

  // The same reconciled trailer observed again must not double-record.
  const dupe = inbox.recordDirect({
    streamId: 'variant:var-raw',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'repaint-survivor completion' },
    context: { taskId: 'tsk_raw' },
  });
  assert.equal(dupe, null, 'identical trailer dedupes');
  assert.equal(inbox.list({ streamId: 'variant:var-raw' }).length, 1);

  // A genuinely new trailer (fixback round with a new detail) records again.
  const next = inbox.recordDirect({
    streamId: 'variant:var-raw',
    state: 'turn-complete',
    trailer: { kind: 'blocked', detail: 'second round parked' },
    context: { taskId: 'tsk_raw' },
  });
  assert.ok(next, 'new trailer records');
  assert.equal(inbox.list({ streamId: 'variant:var-raw' }).length, 2);

  // A NEW TURN (fixback prompt delivered) with an IDENTICAL trailer must
  // still record — the dedupe is per turn generation, not per detail.
  inbox.beginTurn('variant:var-raw', 'fixback prompt baseline');
  const fixbackRepeat = inbox.recordDirect({
    streamId: 'variant:var-raw',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'repaint-survivor completion' },
    context: { taskId: 'tsk_raw' },
  });
  assert.ok(fixbackRepeat, 'identical trailer on a later turn records');
  assert.equal(fixbackRepeat.turnId, 1);
  assert.equal(inbox.list({ streamId: 'variant:var-raw' }).length, 3);
});

test('recordDirect: refuses malformed input', () => {
  const inbox = createCompletionInbox({ now: () => 1 });
  assert.equal(inbox.recordDirect({ streamId: '', trailer: { kind: 'done', detail: 'x' } }), null);
  assert.equal(inbox.recordDirect({ streamId: 's', trailer: null }), null);
  assert.equal(inbox.recordDirect({ streamId: 's', trailer: {} }), null);
  assert.equal(
    inbox.recordDirect({ streamId: 's', trailer: { kind: 'progress', detail: 'x' } }),
    null,
    'non-terminal kinds are refused'
  );
});

test('observeReady: excludeTrailerKeys drops a prompt-echo trailer; the worker trailer records', () => {
  let now = 12000;
  const inbox = createCompletionInbox({ now: () => now++ });
  inbox.beginTurn('variant:var-echo', 'baseline');
  const echoKeys = new Set(['blocked fake blocker']);

  const echoed = inbox.observeReady({
    streamId: 'variant:var-echo',
    state: 'turn-complete',
    text: 'baseline\nBLOCKED: fake blocker\n',
    context: { taskId: 'tsk_echo' },
    excludeTrailerKeys: echoKeys,
  });
  assert.equal(echoed.length, 0, 'the echoed prompt trailer never records');

  const real = inbox.observeReady({
    streamId: 'variant:var-echo',
    state: 'turn-complete',
    text: 'baseline\nBLOCKED: fake blocker\nDONE: real completion\n',
    context: { taskId: 'tsk_echo' },
    excludeTrailerKeys: echoKeys,
  });
  assert.equal(real.length, 1);
  assert.equal(real[0].detail, 'real completion');
});

test('a raw-ring record followed by a rendered repaint of the SAME trailer never double-records', () => {
  let now = 15000;
  const inbox = createCompletionInbox({ now: () => now++ });
  inbox.beginTurn('variant:var-cross', 'baseline');

  const direct = inbox.recordDirect({
    streamId: 'variant:var-cross',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'one completion only' },
    context: { taskId: 'tsk_cross' },
  });
  assert.ok(direct);

  // The TUI later repaints the same trailer into the rendered scrollback.
  const rendered = inbox.observeReady({
    streamId: 'variant:var-cross',
    state: 'turn-complete',
    text: 'baseline\nDONE: one completion only\n',
    context: { taskId: 'tsk_cross' },
  });
  assert.equal(rendered.length, 0, 'rendered sink dedupes against the raw sink');
  assert.equal(inbox.list({ streamId: 'variant:var-cross' }).length, 1);

  // And the reverse order: rendered first, raw second.
  inbox.beginTurn('variant:var-cross2', 'base');
  const r1 = inbox.observeReady({
    streamId: 'variant:var-cross2',
    state: 'turn-complete',
    text: 'base\nDONE: reverse order\n',
    context: { taskId: 'tsk_cross2' },
  });
  assert.equal(r1.length, 1);
  const d2 = inbox.recordDirect({
    streamId: 'variant:var-cross2',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'reverse order' },
    context: { taskId: 'tsk_cross2' },
  });
  assert.equal(d2, null, 'raw sink dedupes against the rendered sink');
});

test('retract: a rolled-back raw record clears its dedupe so the trailer can re-record', () => {
  let now = 20000;
  const inbox = createCompletionInbox({ now: () => now++ });
  const first = inbox.recordDirect({
    streamId: 'variant:var-retract',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'mirror failed once' },
    context: { taskId: 'tsk_retract' },
  });
  assert.ok(first);
  assert.equal(inbox.retract(first.id), true);
  assert.equal(inbox.list({ streamId: 'variant:var-retract' }).length, 0);

  const second = inbox.recordDirect({
    streamId: 'variant:var-retract',
    state: 'turn-complete',
    trailer: { kind: 'done', detail: 'mirror failed once' },
    context: { taskId: 'tsk_retract' },
  });
  assert.ok(second, 'the same trailer records again after retract');
  assert.equal(inbox.retract('missing-id'), false);
});
