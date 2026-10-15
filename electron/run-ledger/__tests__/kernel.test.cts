// kernel.test — proves the Ring-0 createKernel facade: intake -> the spine's
// next action -> the matching injected driver -> durable marker + completion
// events -> projection panel, plus driver-failure resilience and per-runId
// concurrency isolation. Pure (memory ledger), runs under node --test.
const test = require('node:test');
const assert = require('node:assert');

const { createKernel } = require('../kernel.cts');
const { createMemoryEventLog } = require('../event-ledger.cts');

function passRecord() {
  return { detail: 'DONE: VERDICT=PASS on https://github.com/x/y/pull/1 {"verdict":"pass","scorecard":[{"id":"A1","met":true}]}' };
}

test('submitIntent seeds a run that the spine routes to dispatch_goal_worker (intake)', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const runId = k.submitIntent({ goal: 'fix a typo', mode: 'build' });
  assert.ok(runId, 'returns a runId');
  const { decision } = k.reconcile(runId);
  assert.equal(decision.next, 'dispatch_goal_worker');
  const panels = k.project();
  assert.ok(panels.intake.some((r: any) => r.runId === runId), 'lands in intake');
});

test('runStep calls the matching driver and records the durable dispatch marker', async () => {
  const ledger = createMemoryEventLog();
  const calls: string[] = [];
  // A genuine dispatch effect appends its *.dispatch.linked proof synchronously
  // (exactly what the real spine-effects do) before returning null — so the
  // kernel's fail-closed linkage check sees a real, linked worker.
  const k = createKernel({
    ledger,
    drivers: {
      dispatchWorker: ({ runId, ledger }: any) => { calls.push('dispatchWorker:' + runId); ledger.append({ runId, type: 'worker.dispatch.linked', payload: { taskId: 'tsk', streamId: 'str' } }); return null; },
      runValidation: ({ runId, ledger }: any) => { calls.push('runValidation:' + runId); ledger.append({ runId, type: 'validator.dispatch.linked', payload: { taskId: 'tskv', streamId: 'strv' } }); return null; },
      gatePr: ({ runId }: any) => { calls.push('gatePr:' + runId); return null; },
      release: ({ runId }: any) => { calls.push('release:' + runId); return null; },
    },
  });
  const runId = k.submitIntent({ goal: 'add a setting', mode: 'build' });

  const s1 = await k.runStep(runId);
  assert.equal(s1.ran, 'dispatchWorker');
  assert.equal(s1.ok, true);
  assert.ok(ledger.readRun(runId).some((e: any) => e.type === 'worker.dispatched'), 'marker appended');
  assert.ok(ledger.readRun(runId).some((e: any) => e.type === 'worker.dispatch.linked'), 'linkage proof appended');
  assert.deepEqual(calls, ['dispatchWorker:' + runId]);

  // Worker reports DONE (Ring 2 event source) -> spine refreshes the PR gate.
  k.recordEvent({ runId, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'sha1' } });
  const s2 = await k.runStep(runId);
  assert.equal(s2.ran, 'gatePr');
  assert.ok(!ledger.readRun(runId).some((e: any) => e.type === 'validator.dispatched'), 'no validator marker appended');
  assert.deepEqual(calls, ['dispatchWorker:' + runId, 'gatePr:' + runId]);
});

test('FAIL-CLOSED LINKAGE: a dispatch driver that returns without linking records *.dispatch.failed (no phantom dispatched)', async () => {
  // The brief's exact bad shape: the driver returns (no throw) but never created
  // /linked a real stream/task/worktree. The kernel must NOT leave a lone
  // worker.dispatched marker standing — it records the fail-closed counterpart so
  // the run reconciles to BLOCKED instead of floating in_progress with null links.
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger, drivers: { dispatchWorker: () => null } });
  const runId = k.submitIntent({ goal: 'phantom dispatch', mode: 'build' });
  const s = await k.runStep(runId);
  assert.equal(s.ran, 'dispatchWorker');
  assert.equal(s.ok, false, 'a no-link dispatch fails closed');
  assert.match(String(s.error), /no linked stream\/task\/worktree/);
  const types = ledger.readRun(runId).map((e: any) => e.type);
  assert.ok(types.includes('worker.dispatched'), 'durable-first marker still recorded');
  assert.ok(types.includes('worker.dispatch.failed'), 'fail-closed counterpart recorded on a no-link dispatch');
  // The resting event is the failure, never a lone worker.dispatched marker.
  assert.equal(types[types.length - 1], 'worker.dispatch.failed');
  // The spine reconciles the run to a BLOCKED dispatch_failed (not sync_worker).
  const { decision } = k.reconcile(runId);
  assert.equal(decision.next, 'blocked');
});

test('worker completion never invokes the validator driver automatically', async () => {
  const ledger = createMemoryEventLog();
  const calls: string[] = [];
  const k = createKernel({
    ledger,
    drivers: {
      runValidation: () => {
        calls.push('runValidation');
        throw new Error('must not be called');
      },
      gatePr: () => { calls.push('gatePr'); return null; },
    },
  });
  const runId = k.submitIntent({ goal: 'missing workspace id', mode: 'build' });
  k.recordEvent({ runId, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'sha1' } });

  const first = await k.runStep(runId);
  assert.equal(first.ran, 'gatePr');
  assert.equal(first.ok, true);
  assert.ok(!ledger.readRun(runId).some((e: any) => e.type === 'validator.dispatched'));
  assert.deepEqual(calls, ['gatePr']);
});

test('PASS path resolves to a ship action and lands the run in readyToShip', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const runId = k.submitIntent({ goal: 'ship it', mode: 'build' });
  k.recordEvent({ runId, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'sha1' } });
  k.recordEvent({ runId, type: 'validator.completed', payload: { record: passRecord(), validatedHeadSha: 'sha1' } });

  // After a clean PASS with no tracked-PR evidence the spine routes to a ship
  // action (gate the PR, or dispatch the release goal). Both are ready-to-ship.
  const { decision } = k.reconcile(runId);
  assert.ok(['gate', 'dispatch_release_goal'].includes(decision.next), 'next is a ship action, got ' + decision.next);
  const panels = k.project();
  assert.ok(panels.readyToShip.some((r: any) => r.runId === runId), 'lands in readyToShip');

  // When PR evidence demands a gate, reconcile computes it (no new gate logic).
  k.recordEvent({ runId, type: 'gate.evaluated', payload: { prExists: true, mergeable: 'MERGEABLE', checkState: 'SUCCESS', headSha: 'sha1', tracked: true } });
  const gated = k.reconcile(runId, { wantGate: true });
  assert.ok(gated.gate, 'merge gate is evaluated via evaluateMergeGate');
});

test('a throwing driver is captured (ok:false) and the marker still persists', async () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({
    ledger,
    drivers: { dispatchWorker: () => { throw new Error('provider down'); } },
  });
  const runId = k.submitIntent({ goal: 'flaky dispatch', mode: 'build' });
  const s = await k.runStep(runId);
  assert.equal(s.ran, 'dispatchWorker');
  assert.equal(s.ok, false);
  assert.match(s.error, /provider down/);
  assert.ok(ledger.readRun(runId).some((e: any) => e.type === 'worker.dispatched'), 'marker survives a driver failure');
});

test('runs reconcile independently per runId (concurrency isolation)', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const a = k.submitIntent({ runId: 'A', goal: 'a' });
  const b = k.submitIntent({ runId: 'B', goal: 'b' });
  k.recordEvent({ runId: a, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: 'sa' } });
  // B stays at intake; A advances to the read-only gate — derived from each slice only.
  assert.equal(k.reconcile(a).decision.next, 'gate');
  assert.equal(k.reconcile(b).decision.next, 'dispatch_goal_worker');
});

// --- collision-proof run-id minting (live + archive + reservations) -----------

test('minted run ids never collide with live runs after ids go sparse', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const r1 = k.submitIntent({ goal: 'one' });
  const r2 = k.submitIntent({ goal: 'two' });
  assert.equal(r1, 'run-1');
  assert.equal(r2, 'run-2');
  // Sparse ids: count+1 would mint run-3; max+1 must skip past run-17.
  const explicit = k.submitIntent({ runId: 'run-17', goal: 'explicit' });
  assert.equal(explicit, 'run-17');
  const next = k.submitIntent({ goal: 'after sparse' });
  assert.equal(next, 'run-18', 'mint skips past the highest existing numeric id');
});

test('minted run ids never collide with ARCHIVED runs (knownRunIds union)', () => {
  // Post-archive shape: readAll is empty but knownRunIds reports the archive.
  const events: any[] = [];
  const archivedIds = new Set(['run-1', 'run-2', 'run-17']);
  const ledger = {
    append: (e: any) => { events.push(e); return e; },
    readAll: () => events.slice(),
    readRun: (runId: any) => events.filter((e) => String(e.runId) === String(runId)),
    knownRunIds: () => {
      const ids = new Set(archivedIds);
      for (const e of events) if (e && e.runId) ids.add(String(e.runId));
      return ids;
    },
  };
  const k = createKernel({ ledger });
  const minted = k.submitIntent({ goal: 'fresh after archive' });
  assert.equal(minted, 'run-18', 'mint reads live + archived history, not the live count');
  assert.ok(!archivedIds.has(minted), 'never reuses an archived id');
});

test('FILE LEDGER: archived runs still block their ids from being re-minted (board-fold incident class)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog, archiveRunEvents } = require('../event-ledger.cts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-kernel-mint-'));
  const file = path.join(tmp, 'events.ndjson');
  try {
    // Highest run is run-17; archiving everything empties the live file.
    let ledger = createFileEventLog(file);
    let k = createKernel({ ledger });
    for (let i = 1; i <= 3; i += 1) k.submitIntent({ goal: `run ${i}` });
    k.submitIntent({ runId: 'run-17', goal: 'historical high id' });
    archiveRunEvents(file, { runIds: ['run-1', 'run-2', 'run-3', 'run-17'] });
    assert.equal(ledger.readAll().length, 0, 'live file is empty after archive');

    // A fresh process constructs a new ledger over the same file (restart).
    ledger = createFileEventLog(file);
    k = createKernel({ ledger });
    const minted = k.submitIntent({ goal: 'fresh submission after archive' });
    assert.equal(minted, 'run-18', 'mint reads the ARCHIVE too — never folds into run-17');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: submitIntent REJECTS an explicit runId that already exists live', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  k.submitIntent({ runId: 'A', goal: 'first' });
  const before = ledger.readRun('A').length;
  assert.throws(() => k.submitIntent({ runId: 'A', goal: 'second' }), /already exists/);
  assert.equal(ledger.readRun('A').length, before, 'nothing appended into the existing run');
});

test('REGRESSION: submitIntent REJECTS an explicit runId that exists only in the ARCHIVE', () => {
  const events: any[] = [];
  const ledger = {
    append: (e: any) => { events.push(e); return e; },
    readAll: () => events.slice(),
    readRun: (runId: any) => events.filter((e) => String(e.runId) === String(runId)),
    knownRunIds: () => {
      const ids = new Set(['run-archived-7']);
      for (const e of events) if (e && e.runId) ids.add(String(e.runId));
      return ids;
    },
  };
  const k = createKernel({ ledger });
  assert.throws(() => k.submitIntent({ runId: 'run-archived-7', goal: 'reuse an archived id' }), /already exists/);
  assert.equal(events.length, 0, 'the archived run slice is untouched');
});

test('REGRESSION: a whitespace-padded explicit runId cannot slip past the collision guard', () => {
  // Untrimmed "run-1 " must not slip past the guard.
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  k.submitIntent({ runId: 'run-1', goal: 'original' });
  const before = ledger.readRun('run-1').length;
  assert.throws(() => k.submitIntent({ runId: 'run-1 ', goal: 'late duplicate' }), /already exists/);
  assert.throws(() => k.submitIntent({ runId: ' run-1', goal: 'late duplicate' }), /already exists/);
  assert.equal(ledger.readRun('run-1').length, before, 'the existing slice is untouched');
});

test('REGRESSION: a supplied explicit runId that trims to empty is REJECTED, never silently re-minted', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  assert.throws(() => k.submitIntent({ runId: '   ', goal: 'whitespace id' }), /empty or whitespace/);
  assert.throws(() => k.submitIntent({ runId: '', goal: 'empty id' }), /empty or whitespace/);
  assert.throws(() => k.submitIntent({ id: '  ', goal: 'legacy alias' }), /empty or whitespace/);
  assert.equal(ledger.readAll().length, 0, 'nothing was appended for rejected ids');
});

test('REGRESSION: explicit runId fails closed when an in-process writer claims it inside the check→reserve window', () => {
  const ledger = createMemoryEventLog();
  // The wrapper appends run-9 during reservation; auto-claim wins the id.
  const raced = Object.create(ledger);
  raced.reserveRunId = (id: any) => {
    ledger.append({ runId: String(id), type: 'run.created', payload: {} });
    return ledger.reserveRunId(String(id));
  };
  const k = createKernel({ ledger: raced });
  assert.throws(() => k.submitIntent({ runId: 'run-9', goal: 'racer' }), /already reserved/);
  assert.equal(
    ledger.readRun('run-9').length,
    1,
    'only the winning writer event exists — the losing racer appended nothing',
  );
});

test('REGRESSION: explicit runId fails closed when a LEGACY binary writes the id directly to disk inside the window', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog } = require('../event-ledger.cts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-legacy-race-'));
  try {
    const file = path.join(tmp, 'events.ndjson');
    const ledger = createFileEventLog(file);
    // Legacy binaries bypass append() entirely; only the recheck catches them.
    const raced = Object.create(ledger);
    raced.reserveRunId = (id: any) => {
      fs.appendFileSync(
        file,
        `${JSON.stringify({ id: `legacy:${id}`, runId: String(id), type: 'run.created', payload: {} })}\n`,
      );
      return ledger.reserveRunId(String(id));
    };
    const k = createKernel({ ledger: raced });
    assert.throws(() => k.submitIntent({ runId: 'run-9', goal: 'racer' }), /appended by another writer/);
    assert.equal(ledger.readRun('run-9').length, 1, 'the losing racer appended nothing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: a run-creation append cannot steal an id reserved by another ledger instance', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog } = require('../event-ledger.cts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-steal-'));
  try {
    const file = path.join(tmp, 'events.ndjson');
    const l1 = createFileEventLog(file);
    const l2 = createFileEventLog(file);
    assert.ok(l1.reserveRunId('run-2'), 'first instance owns the reservation');
    assert.throws(
      () => l2.append({ runId: 'run-2', type: 'run.created', payload: {} }),
      /another writer owns its reservation/,
    );
    assert.ok(l1.append({ runId: 'run-2', type: 'run.created', payload: {} }), 'the holder appends fine');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: allocation fails closed over a corrupt LIVE or ARCHIVE record (no silent id loss)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog } = require('../event-ledger.cts');
  const corruptLines = [
    '{"id":"run-17:run.created:0","runId":"run-17"', // truncated JSON
    '{"id":"run-17:run.created:0","type":"run.created","payload":{}}', // runId lost
    '{"id":"run-17:run.created:0","runId":"  ","type":"run.created","payload":{}}', // runId blank
    '{"id":"run-17:run.created:0","runId":"run-17","payload":{}}', // type lost
    '{"id":"run-17:run.created:0","runId":"run-17 ","type":"run.created","payload":{}}', // runId padded
    '{"id":"run-17:run.created:0","runId":"run-17","type":" run.created","payload":{}}', // type padded
  ];
  for (const target of ['events.ndjson', 'events-archive.ndjson']) {
    for (const corrupt of corruptLines) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-corrupt-'));
      try {
        const file = path.join(tmp, 'events.ndjson');
        const ledger = createFileEventLog(file);
        const k = createKernel({ ledger });
        k.submitIntent({ goal: 'good history' });
        fs.appendFileSync(path.join(tmp, target), `${corrupt}\n`);
        assert.throws(() => ledger.knownRunIds(), /malformed record/, `${target}: strict union throws on ${corrupt}`);
        assert.throws(() => k.submitIntent({ goal: 'over corruption' }), /malformed record/);
        assert.ok(Array.isArray(ledger.readAll()), `${target}: tolerant readAll keeps projections alive`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});

test('REGRESSION: true cross-process contention mints unique ids', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-xproc-'));
  try {
    const file = path.join(tmp, 'events.ndjson');
    const tsxLoader = require.resolve('tsx/cjs');
    const script = `
      const { createFileEventLog } = require(${JSON.stringify(require.resolve('../event-ledger.cts'))});
      const { createKernel } = require(${JSON.stringify(require.resolve('../kernel.cts'))});
      const k = createKernel({ ledger: createFileEventLog(${JSON.stringify(file)}) });
      const out = [];
      for (let i = 0; i < 10; i += 1) out.push(k.submitIntent({ goal: 'w' + i }));
      process.stdout.write(out.join('\\n'));
    `;
    const runWorker = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', tsxLoader, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: any) => { stdout += d; });
        child.stderr.on('data', (d: any) => { stderr += d; });
        child.on('close', (code: any) => (code === 0 ? resolve(stdout) : reject(new Error(`worker exit ${code}: ${stderr}`))));
      });
    const outputs: any[] = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()]);
    const ids = outputs.flatMap((o: any) => String(o).split('\n').filter(Boolean));
    assert.equal(ids.length, 40, 'every worker submission succeeded');
    assert.equal(new Set(ids).size, 40, `duplicate ids under contention: ${ids.join(',')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: run-id allocation FAILS CLOSED when live or archive history cannot be read', () => {
  // safeRead-style '' on an unreadable archive would make archived history
  // vanish and re-mint an archived run's id (the collision the contract
  // forbids). Both submitIntent paths must REFUSE instead: minting and the
  // explicit-id duplicate check each need the full known-id set.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog } = require('../event-ledger.cts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-strict-'));
  try {
    const file = path.join(tmp, 'events.ndjson');
    const ledger = createFileEventLog(file);
    const k = createKernel({ ledger });
    k.submitIntent({ goal: 'first' });

    // The archive becomes UNREADABLE (a directory → EISDIR on read).
    fs.mkdirSync(path.join(tmp, 'events-archive.ndjson'));
    assert.throws(() => ledger.knownRunIds(), /EISDIR|directory/i, 'knownRunIds propagates the real IO error');
    assert.throws(() => k.submitIntent({ goal: 'minted while archive unreadable' }), /EISDIR|directory/i);
    assert.throws(() => k.submitIntent({ runId: 'run-explicit', goal: 'explicit while archive unreadable' }), /EISDIR|directory/i);

    // Recovery: a readable archive restores allocation.
    fs.rmdirSync(path.join(tmp, 'events-archive.ndjson'));
    const minted = k.submitIntent({ goal: 'after recovery' });
    assert.match(minted, /^run-\d+$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: minting is ATOMIC across processes — a concurrently-reserved id is never re-minted', () => {
  // A sibling's reservation (no events yet) must push this process past it.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createFileEventLog } = require('../event-ledger.cts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-reserve-'));
  try {
    const file = path.join(tmp, 'events.ndjson');
    const k = createKernel({ ledger: createFileEventLog(file) });
    assert.equal(k.submitIntent({ goal: 'first' }), 'run-1');

    // Another process mid-mint: reservation exists, no events yet.
    const reservations = path.join(tmp, 'run-id-reservations');
    fs.mkdirSync(reservations, { recursive: true });
    fs.writeFileSync(path.join(reservations, 'run-2'), '', { flag: 'wx' });

    assert.equal(k.submitIntent({ goal: 'concurrent' }), 'run-3', 'the reserved id is skipped, never doubled');

    // Explicit submission of the foreign-reserved id fails closed too.
    assert.throws(() => k.submitIntent({ runId: 'run-2', goal: 'explicit clash' }), /already reserved/);

    // Sanity (sequential): a second adapter instance continues the sequence.
    const k2 = createKernel({ ledger: createFileEventLog(file) });
    const a = k.submitIntent({ goal: 'from k1' });
    const b = k2.submitIntent({ goal: 'from k2' });
    assert.notEqual(a, b, `both kernels minted ${a}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REGRESSION: an in-process submission burst mints strictly unique ids (memory backend reservation)', () => {
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const ids = Array.from({ length: 10 }, (_, i) => k.submitIntent({ goal: `burst ${i}` }));
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(',')}`);
});

test('REGRESSION: minting advances past Number.MAX_SAFE_INTEGER suffixes (no float-no-op spin)', () => {
  // Number math stalls past 2^53; BigInt suffix math must keep advancing.
  const ledger = createMemoryEventLog();
  const k = createKernel({ ledger });
  const huge = k.submitIntent({ runId: 'run-9007199254740992', goal: 'beyond 2^53' });
  assert.equal(huge, 'run-9007199254740992');
  const minted = k.submitIntent({ goal: 'must not hang' });
  assert.equal(minted, 'run-9007199254740993', 'exact BigInt increment, not a float rounding');
});
