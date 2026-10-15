// board-read-only.test — pins the READ-ONLY GUARANTEE: the board is a pure
// function of the events. Reading it appends nothing, locks nothing, and
// mutates no file; nothing in the dispatch/gate/merge path imports or awaits
// the board.
//
// ACCEPTED EXCEPTIONS (documented, deliberate, NOT read-path violations):
//   1. ONE-TIME BOOT HYGIENE inside harness construction: auto-archive
//      (run-archive) runs before createFileEventLog, whose constructor then
//      compacts. Both happen once, in the construction window, before any
//      board read — every board() call AFTER init is a pure read (pinned
//      below by the bytes-unchanged test).
//   2. electron/loops/workspace-cleanup-loop.cts READS runBoard to classify
//      worktrees for cleanup. That is a consumer of the view on a cleanup
//      path — not dispatch/gate/merge — and it only reads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunLedgerHarness } = require('../harness.cts');
const { projectLeanBoard } = require('../board-projection.cts');

const repoRoot = path.join(__dirname, '..', '..', '..');
const NOW = 1_750_000_000_000;

function tmpLedgerFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-board-ro-'));
  return { file: path.join(dir, 'events.ndjson'), archive: path.join(dir, 'events-archive.ndjson') };
}

function bytesOf(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '<absent>';
  }
}

test('board() on a file ledger is a pure read: no appends, no byte changes, stable output', async () => {
  const { file, archive } = tmpLedgerFile();
  const h = createRunLedgerHarness({ ledgerPath: file, now: () => NOW });
  // Put real state on the ledger through the ONLY writer (a failing dispatch
  // walks intake -> blocked, appending several event types).
  const runId = h.submit({ runId: 'run-ro', goal: 'Read-only pin', driver: 'codex' });
  await h.runToQuiescence(runId);

  // From here on the read path must be inert. Spy the ledger's append.
  let appendCalls = 0;
  const realAppend = h.ledger.append;
  h.ledger.append = (...appendArgs: any[]) => {
    appendCalls += 1;
    return realAppend(...appendArgs);
  };
  const ledgerBytes = bytesOf(file);
  const archiveBytes = bytesOf(archive);

  const first = h.board();
  const second = h.board();

  assert.equal(appendCalls, 0, 'board() never appends');
  assert.equal(bytesOf(file), ledgerBytes, 'events.ndjson bytes unchanged by board reads');
  assert.equal(bytesOf(archive), archiveBytes, 'events-archive.ndjson bytes unchanged by board reads');
  assert.deepEqual(second, first, 'same events + same clock => same board');
  assert.ok(first.cards.some((c: any) => c.id === 'run-ro'));
});

test('projectLeanBoard touches ONLY readAll/readRun on the event log — no other method, ever', () => {
  const calls: string[] = [];
  const events = [
    { id: 'r1:run.created:0', runId: 'r1', ts: 1, type: 'run.created', payload: { spec: { goal: 'x' } } },
  ];
  const spyLog = new Proxy(
    {
      readAll: () => {
        calls.push('readAll');
        return events.slice();
      },
      readRun: (runId: any) => {
        calls.push('readRun');
        return events.filter((e) => e.runId === runId);
      },
      append: () => {
        throw new Error('projection must never append');
      },
    },
    {
      get(target: any, prop: any) {
        if (typeof prop === 'string' && !['readAll', 'readRun'].includes(prop) && typeof target[prop] === 'function') {
          calls.push(`FORBIDDEN:${prop}`);
        }
        return target[prop];
      },
    },
  );

  const board = projectLeanBoard(spyLog);
  assert.equal(board.counts.total, 1);
  assert.ok(calls.length > 0);
  assert.deepEqual(
    calls.filter((c) => c.startsWith('FORBIDDEN:')),
    [],
    'only readAll/readRun were touched',
  );
});

test('source guard: kernel/drivers/spine-effects (the dispatch/gate/merge path) never reference the board', () => {
  for (const rel of ['electron/run-ledger/kernel.cts', 'electron/run-ledger/drivers.cts', 'electron/run-ledger/spine-effects.cts']) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(src, /projectLeanBoard|leanBoard|runBoard\b/, `${rel} must not reference the board projection`);
  }
});

test('source guard: controller runSubmit/driveRun never read the board', () => {
  const controller = fs.readFileSync(path.join(repoRoot, 'electron/ace-control/index.cts'), 'utf8');

  // driveRun (the autonomy pulse) body: from its declaration to the autonomy
  // outer-loop section that follows it.
  const driveStart = controller.indexOf('function driveRun(runId: any)');
  const driveEnd = controller.indexOf('// ---- Autonomy OUTER loop');
  assert.ok(driveStart !== -1 && driveEnd > driveStart, 'driveRun body located');
  const driveRunBody = controller.slice(driveStart, driveEnd);
  assert.doesNotMatch(driveRunBody, /leanBoard|\.board\(\)/, 'driveRun never reads the board');

  // runSubmit (intake) body: from its method key to the next method key.
  const submitStart = controller.indexOf('runSubmit: (p: any) =>');
  const submitEnd = controller.indexOf('runLoopStop:');
  assert.ok(submitStart !== -1 && submitEnd > submitStart, 'runSubmit body located');
  const runSubmitBody = controller.slice(submitStart, submitEnd);
  assert.doesNotMatch(runSubmitBody, /leanBoard|\.board\(\)/, 'runSubmit never reads the board');

  // The loop harness itself: runToQuiescence never calls board().
  const harness = fs.readFileSync(path.join(repoRoot, 'electron/run-ledger/harness.cts'), 'utf8');
  const loopStart = harness.indexOf('async function runToQuiescence');
  const loopEnd = harness.indexOf('function board()');
  assert.ok(loopStart !== -1 && loopEnd > loopStart, 'runToQuiescence body located');
  assert.doesNotMatch(harness.slice(loopStart, loopEnd), /board\(\)|projectLeanBoard/, 'the loop never reads the board');
});

test('followUpStore.digest is a pure read — zero writes to the backing db', () => {
  let followUpSupervisor: any;
  try {
    followUpSupervisor = require('../../../tools/ace/src/follow-up-supervisor.cts');
  } catch {
    followUpSupervisor = require('../../../tools/ace/src/follow-up-supervisor.cjs');
  }
  const writes: string[] = [];
  const records = new Map();
  const spyDb = {
    get: (id: any) => records.get(id) || null,
    set: (id: any, record: any) => {
      writes.push(`set:${id}`);
      records.set(id, record);
    },
    delete: (id: any) => {
      writes.push(`delete:${id}`);
      records.delete(id);
    },
    all: () => Array.from(records.values()),
  };
  const store = followUpSupervisor.createFollowUpStore({ db: spyDb, now: () => NOW });
  store.upsert({ row: { taskId: 'tsk-ro', workspaceId: 'ws-ro', laneStatus: 'done' }, now: NOW, source: 'completion' });
  const writesAfterUpsert = writes.length;
  assert.ok(writesAfterUpsert > 0, 'upsert writes (sanity)');

  const digest = store.digest({ now: NOW });
  assert.ok(digest && typeof digest === 'object');
  assert.equal(writes.length, writesAfterUpsert, 'digest performed no backing writes');
});
