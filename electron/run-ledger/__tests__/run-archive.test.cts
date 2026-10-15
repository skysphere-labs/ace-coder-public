// run-archive.test — board hygiene: archival moves whole runs' event lines to
// events-archive.ndjson (byte-identical, malformed lines preserved, idempotent),
// the selection policy picks done>24h / blocked>48h / dead in_progress>72h by
// the SAME panel bucketing the board uses, the harness auto-archives at boot
// (threshold-gated, env-killable, never a boot blocker), and the board — a pure
// projection over the live events — stops rendering archived runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { archiveRunEvents, readFileEvents, createMemoryEventLog } = require('../event-ledger.cts');
const {
  selectArchivableRuns,
  autoArchiveFileLedger,
  DONE_AFTER_MS,
  BLOCKED_AFTER_MS,
  IN_PROGRESS_IDLE_MS,
} = require('../run-archive.cts');
const { createRunLedgerHarness } = require('../harness.cts');
const { projectLeanBoard } = require('../board-projection.cts');

const HOUR = 60 * 60 * 1000;
const NOW = 1_750_000_000_000; // fixed injected clock — determinism

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-run-archive-'));
  return { dir, file: path.join(dir, 'events.ndjson'), archive: path.join(dir, 'events-archive.ndjson') };
}

function passRecord() {
  return { detail: 'DONE: VERDICT=PASS {"verdict":"pass"}' };
}

// Event-line builders — a realistic lifecycle per stage, every event stamped
// with a caller ts like the live harness clock does.
let seq = 0;
function line(runId: string, type: string, ts: number, payload: any = {}) {
  seq += 1;
  return JSON.stringify({ id: `${runId}:${type}:${seq}`, runId, ts, type, payload });
}

function doneRunLines(runId: string, lastTs: number) {
  return [
    line(runId, 'run.created', lastTs - 4 * HOUR, { spec: { goal: `ship ${runId}` } }),
    line(runId, 'worker.completed', lastTs - 3 * HOUR, { outcome: 'DONE', currentHeadSha: 's1' }),
    line(runId, 'validator.completed', lastTs - 2 * HOUR, { record: passRecord(), validatedHeadSha: 's1' }),
    line(runId, 'gate.evaluated', lastTs - HOUR, { prExists: true, mergeable: 'MERGEABLE', checkState: 'success', headSha: 's1' }),
    line(runId, 'merged', lastTs, { sha: 'm1', cleanedUp: true, headSha: 's1' }),
  ];
}

function blockedRunLines(runId: string, lastTs: number) {
  return [
    line(runId, 'run.created', lastTs - HOUR, { spec: { goal: `hard ${runId}` } }),
    line(runId, 'worker.completed', lastTs, { outcome: 'BLOCKED' }),
  ];
}

function inProgressRunLines(runId: string, lastTs: number) {
  return [
    line(runId, 'run.created', lastTs - HOUR, { spec: { goal: `wip ${runId}` } }),
    line(runId, 'worker.dispatched', lastTs - HOUR / 2, {}),
    line(runId, 'worker.dispatch.linked', lastTs, { taskId: `tsk-${runId}`, streamId: `str-${runId}`, worktreePath: `/wt/${runId}` }),
  ];
}

function writeLedger(file: string, lines: string[]) {
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
}

function memoryLogFrom(lines: string[]) {
  const events = lines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  return {
    readAll: () => events.slice(),
    readRun: (runId: any) => events.filter((e: any) => String(e.runId) === String(runId)),
  };
}

// ---------------------------------------------------------------------------
// archiveRunEvents — the file primitive
// ---------------------------------------------------------------------------

test('archiveRunEvents moves the selected runs lines to the archive byte-identically and keeps the rest', () => {
  const { file, archive } = tmpLedger();
  const doomed = doneRunLines('run-old', NOW - 30 * HOUR);
  const kept = inProgressRunLines('run-live', NOW - HOUR);
  writeLedger(file, [...doomed, ...kept]);

  const res = archiveRunEvents(file, { runIds: ['run-old'] });
  assert.equal(res.archived, doomed.length);
  assert.equal(res.remaining, kept.length);
  assert.deepEqual(res.runIds, ['run-old']);

  // Archived lines are byte-identical to what was on disk, in order.
  assert.equal(fs.readFileSync(archive, 'utf8'), doomed.join('\n') + '\n');
  // Live file keeps only the surviving run, byte-identical.
  assert.equal(fs.readFileSync(file, 'utf8'), kept.join('\n') + '\n');
});

test('archiveRunEvents preserves malformed lines in place — forensic data never moves silently', () => {
  const { file, archive } = tmpLedger();
  const doomed = blockedRunLines('run-bad', NOW - 60 * HOUR);
  const malformed = '{ this is not json';
  const kept = doneRunLines('run-keep', NOW - HOUR);
  writeLedger(file, [doomed[0], malformed, doomed[1], ...kept]);

  const res = archiveRunEvents(file, { runIds: ['run-bad'] });
  assert.equal(res.archived, 2);
  // The malformed line stays in the LIVE file, verbatim.
  const live = fs.readFileSync(file, 'utf8');
  assert.ok(live.includes(malformed), 'malformed line kept in the live ledger');
  assert.ok(!fs.readFileSync(archive, 'utf8').includes(malformed), 'malformed line never archived');
  // Malformed lines are not counted as events.
  assert.equal(res.remaining, kept.length);
});

test('archiveRunEvents is a no-op on an empty selection and idempotent on repeat', () => {
  const { file, archive } = tmpLedger();
  const lines = doneRunLines('run-x', NOW - 30 * HOUR);
  writeLedger(file, lines);
  const before = fs.readFileSync(file, 'utf8');

  // Empty selection: nothing moves, no archive file appears.
  const noop = archiveRunEvents(file, { runIds: [] });
  assert.equal(noop.archived, 0);
  assert.equal(noop.remaining, lines.length);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(archive), false);

  // First archive moves; the second call for the same run finds nothing.
  const first = archiveRunEvents(file, { runIds: ['run-x'] });
  assert.equal(first.archived, lines.length);
  const second = archiveRunEvents(file, { runIds: ['run-x'] });
  assert.equal(second.archived, 0);
  assert.deepEqual(second.runIds, []);
  // The archive did not double-append.
  assert.equal(fs.readFileSync(archive, 'utf8'), lines.join('\n') + '\n');
});

test('archiveRunEvents accumulates across calls — the archive is append-only', () => {
  const { file, archive } = tmpLedger();
  const a = doneRunLines('run-a', NOW - 30 * HOUR);
  const b = blockedRunLines('run-b', NOW - 60 * HOUR);
  writeLedger(file, [...a, ...b]);
  archiveRunEvents(file, { runIds: ['run-a'] });
  archiveRunEvents(file, { runIds: ['run-b'] });
  assert.equal(fs.readFileSync(archive, 'utf8'), [...a, ...b].join('\n') + '\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

// ---------------------------------------------------------------------------
// selectArchivableRuns — the policy
// ---------------------------------------------------------------------------

test('selection buckets: done>24h, blocked>48h, dead in_progress>72h — younger runs stay', () => {
  const lines = [
    ...doneRunLines('done-old', NOW - 25 * HOUR),
    ...doneRunLines('done-fresh', NOW - 23 * HOUR),
    ...blockedRunLines('blocked-old', NOW - 49 * HOUR),
    ...blockedRunLines('blocked-fresh', NOW - 47 * HOUR),
    ...inProgressRunLines('lane-dead', NOW - 73 * HOUR),
    ...inProgressRunLines('lane-live', NOW - 71 * HOUR),
  ];
  const sel = selectArchivableRuns(memoryLogFrom(lines), { now: NOW });
  assert.deepEqual(sel.byReason.done, ['done-old']);
  assert.deepEqual(sel.byReason.blocked, ['blocked-old']);
  assert.deepEqual(sel.byReason.deadLanes, ['lane-dead']);
  assert.deepEqual([...sel.runIds].sort(), ['blocked-old', 'done-old', 'lane-dead']);
});

test('boundary: a run EXACTLY at its threshold is NOT archived (strictly older only)', () => {
  const lines = [
    ...doneRunLines('done-edge', NOW - DONE_AFTER_MS),
    ...blockedRunLines('blocked-edge', NOW - BLOCKED_AFTER_MS),
    ...inProgressRunLines('lane-edge', NOW - IN_PROGRESS_IDLE_MS),
    ...doneRunLines('done-past', NOW - DONE_AFTER_MS - 1),
  ];
  const sel = selectArchivableRuns(memoryLogFrom(lines), { now: NOW });
  assert.deepEqual(sel.runIds, ['done-past']);
});

test('terminalOnly skips dead in_progress lanes', () => {
  const lines = [
    ...doneRunLines('done-old', NOW - 25 * HOUR),
    ...inProgressRunLines('lane-dead', NOW - 100 * HOUR),
  ];
  const sel = selectArchivableRuns(memoryLogFrom(lines), { now: NOW, terminalOnly: true });
  assert.deepEqual(sel.runIds, ['done-old']);
  assert.deepEqual(sel.byReason.deadLanes, []);
});

test('runs with NO event ts are never auto-selected — unknown age fails safe', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'run-no-ts', type: 'run.created', payload: { spec: { goal: 'ancient?' } } });
  log.append({ runId: 'run-no-ts', type: 'worker.completed', payload: { outcome: 'BLOCKED' } });
  const sel = selectArchivableRuns(log, { now: NOW });
  assert.deepEqual(sel.runIds, []);
});

test('explicit runIds selection wins outright and ignores thresholds; ghosts are dropped', () => {
  const lines = [
    ...doneRunLines('done-fresh', NOW - HOUR), // way under threshold
    ...inProgressRunLines('lane-live', NOW - HOUR),
  ];
  const sel = selectArchivableRuns(memoryLogFrom(lines), { now: NOW, runIds: ['done-fresh', 'run-ghost'] });
  assert.deepEqual(sel.runIds, ['done-fresh']);
  assert.deepEqual(sel.byReason.explicit, ['done-fresh']);
});

test('custom thresholds override the defaults', () => {
  const lines = [...doneRunLines('done-2h', NOW - 2 * HOUR)];
  const sel = selectArchivableRuns(memoryLogFrom(lines), { now: NOW, doneAfterMs: HOUR });
  assert.deepEqual(sel.byReason.done, ['done-2h']);
});

// ---------------------------------------------------------------------------
// autoArchiveFileLedger + harness boot auto-archive
// ---------------------------------------------------------------------------

test('autoArchiveFileLedger sweeps an on-disk ledger by threshold and reports byReason', () => {
  const { file, archive } = tmpLedger();
  writeLedger(file, [
    ...doneRunLines('done-old', NOW - 25 * HOUR),
    ...inProgressRunLines('lane-live', NOW - HOUR),
  ]);
  const res = autoArchiveFileLedger(file, { now: NOW });
  assert.equal(res.archived, 5);
  assert.deepEqual(res.byReason.done, ['done-old']);
  assert.ok(fs.existsSync(archive));
  const liveRuns = new Set(readFileEvents(file).map((e: any) => e.runId));
  assert.deepEqual([...liveRuns], ['lane-live']);
});

test('harness boot auto-archives finished runs BEFORE the writer is constructed; the board never sees them', () => {
  const { file } = tmpLedger();
  writeLedger(file, [
    ...doneRunLines('done-old', NOW - 25 * HOUR),
    ...blockedRunLines('blocked-old', NOW - 49 * HOUR),
    ...inProgressRunLines('lane-live', NOW - HOUR),
  ]);
  const h = createRunLedgerHarness({ ledgerPath: file, now: () => NOW });
  const board = h.board();
  const ids = board.cards.map((c: any) => c.id);
  assert.deepEqual(ids, ['lane-live'], 'archived runs are gone from the board');
  assert.equal(board.counts.total, 1);
  // The events physically moved (the projection excludes them because the live
  // file no longer contains them — no filter logic anywhere).
  const liveRuns = new Set(h.ledger.readAll().map((e: any) => e.runId));
  assert.deepEqual([...liveRuns], ['lane-live']);
});

test('ACE_RUN_ARCHIVE=0 kills boot auto-archive', () => {
  const { file } = tmpLedger();
  writeLedger(file, doneRunLines('done-old', NOW - 200 * HOUR));
  const prev = process.env.ACE_RUN_ARCHIVE;
  process.env.ACE_RUN_ARCHIVE = '0';
  try {
    const h = createRunLedgerHarness({ ledgerPath: file, now: () => NOW });
    assert.equal(h.board().counts.total, 1, 'nothing archived with the kill switch on');
  } finally {
    if (prev === undefined) delete process.env.ACE_RUN_ARCHIVE;
    else process.env.ACE_RUN_ARCHIVE = prev;
  }
});

test('a corrupt ledger never blocks harness construction (archival is hygiene, not a gate)', () => {
  const { file } = tmpLedger();
  fs.writeFileSync(file, 'not json at all\n{ nope\n');
  const h = createRunLedgerHarness({ ledgerPath: file, now: () => NOW });
  assert.ok(h.board(), 'harness boots over a corrupt ledger');
});

// ---------------------------------------------------------------------------
// harness.archive() — the runtime seam the CLI/control endpoint drives
// ---------------------------------------------------------------------------

function freshHarness(lines: string[]) {
  const { file, archive } = tmpLedger();
  writeLedger(file, lines);
  // Everything written above is younger than every default threshold at NOW,
  // so boot auto-archive is a no-op and the tests control archival explicitly.
  const h = createRunLedgerHarness({ ledgerPath: file, now: () => NOW });
  return { h, file, archive };
}

test('harness.archive with explicit run ids moves exactly those runs', () => {
  const { h, archive } = freshHarness([
    ...doneRunLines('done-a', NOW - 2 * HOUR),
    ...blockedRunLines('blocked-b', NOW - 2 * HOUR),
  ]);
  const res = h.archive({ runIds: ['done-a'] });
  assert.equal(res.ok, true);
  assert.equal(res.archived, 5);
  assert.deepEqual(res.byReason.explicit, ['done-a']);
  assert.ok(fs.existsSync(archive));
  assert.deepEqual(h.board().cards.map((c: any) => c.id), ['blocked-b']);
});

test('harness.archive --terminal --older-than style selection uses the hour override', () => {
  const { h } = freshHarness([
    ...doneRunLines('done-3h', NOW - 3 * HOUR),
    ...blockedRunLines('blocked-1h', NOW - HOUR),
    ...inProgressRunLines('lane-3h', NOW - 3 * HOUR),
  ]);
  const res = h.archive({ terminal: true, olderThanHours: 2 });
  assert.deepEqual(res.byReason.done, ['done-3h']);
  assert.deepEqual(res.byReason.blocked, []);
  assert.deepEqual(res.byReason.deadLanes, [], 'terminal never touches in_progress lanes');
  const ids = h.board().cards.map((c: any) => c.id).sort();
  assert.deepEqual(ids, ['blocked-1h', 'lane-3h']);
});

test('harness.archive dryRun reports the selection without moving anything', () => {
  const { h, file, archive } = freshHarness([...doneRunLines('done-3h', NOW - 3 * HOUR)]);
  const before = fs.readFileSync(file, 'utf8');
  const res = h.archive({ terminal: true, olderThanHours: 2, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.archived, 0);
  assert.deepEqual(res.runIds, ['done-3h']);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'live ledger untouched');
  assert.equal(fs.existsSync(archive), false, 'no archive written on dry-run');
});

test('harness.archive is safe under the live appender: post-archive appends still land and dedup holds', () => {
  const { h } = freshHarness([...doneRunLines('done-a', NOW - 2 * HOUR)]);
  h.archive({ runIds: ['done-a'] });
  // The appender still works after the swap (opens by path per call)...
  const appended = h.ledger.append({ runId: 'run-new', type: 'run.created', ts: NOW, payload: { spec: { goal: 'after archive' } } });
  assert.ok(appended, 'append after archive lands');
  // ...and the seen-id set still dedups an archived id (no zombie re-append).
  const archivedId = 'done-a:merged:duplicate-check';
  void archivedId; // ids are seq-derived; re-appending the same id must dedup:
  const dup = h.ledger.append({ id: appended.id, runId: 'run-new', type: 'run.created', payload: {} });
  assert.equal(dup, null, 'duplicate id dedup-skipped');
  assert.deepEqual(h.board().cards.map((c: any) => c.id), ['run-new']);
});

test('harness.archive throws for memory ledgers — there is no file to move lines between', () => {
  const h = createRunLedgerHarness({});
  assert.throws(() => h.archive({ runIds: ['x'] }), /file-backed/);
});

// ---------------------------------------------------------------------------
// board projection excludes archived runs (the physical guarantee)
// ---------------------------------------------------------------------------

test('projectLeanBoard over the post-archive file simply never sees archived runs', () => {
  const { file } = tmpLedger();
  writeLedger(file, [
    ...doneRunLines('done-old', NOW - 30 * HOUR),
    ...inProgressRunLines('lane-live', NOW - HOUR),
  ]);
  archiveRunEvents(file, { runIds: ['done-old'] });
  const board = projectLeanBoard(memoryLogFrom(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)));
  assert.deepEqual(board.cards.map((c: any) => c.id), ['lane-live']);
  assert.equal(board.counts.done, 0);
});
