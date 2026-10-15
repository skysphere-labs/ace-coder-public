// spine-multitasking — proves the run-ledger spine is repeatable, scalable, and
// safe under MANY concurrent calls keyed by distinct runIds. This is the
// "multiple calls to the spine / multi-tasking on the same system" guarantee:
// big/medium/small tasks ride the SAME ledger + reconciler with zero cross-run
// interference, idempotent writes, and credential redaction at the write
// boundary. Nothing is mocked — the real fold + policy + projection run.
//
//   node --test --require tsx/cjs electron/run-ledger/__tests__/spine-multitasking.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

let eventLedgerModule: any;
try { eventLedgerModule = require('../event-ledger.cjs'); } catch { eventLedgerModule = require('../event-ledger.cts'); }
const { createMemoryEventLog, redactSecrets } = eventLedgerModule;

let reconcilerModule: any;
try { reconcilerModule = require('../reconciler.cjs'); } catch { reconcilerModule = require('../reconciler.cts'); }
const { reconcile } = reconcilerModule;

let projectionModule: any;
try { projectionModule = require('../projection.cjs'); } catch { projectionModule = require('../projection.cts'); }
const { project } = projectionModule;

let harnessModule: any;
try { harnessModule = require('../harness.cjs'); } catch { harnessModule = require('../harness.cts'); }
const { createRunLedgerHarness } = harnessModule;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
const { NEXT_ACTIONS } = orchestrationPolicy;

const HEAD = 'deadbeefcafe01';

function passTrailer() {
  const carrier = JSON.stringify({ verdict: 'pass', taskId: 'tsk', scorecard: [{ id: 'A1', met: true, evidence: 'x' }] });
  return `DONE: VERDICT=PASS on https://github.com/acme/repo/pull/9 ${carrier}`;
}

// Append a full PASS lifecycle for one run (-> readyToShip). ts is a per-run
// monotonic counter; runs may be appended INTERLEAVED into a shared ledger.
function appendPassRun(log: any, runId: string, spec: any = {}) {
  const runSpec = Object.keys(spec).length
    ? spec
    : { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' };
  log.append({ runId, ts: 1, type: 'run.created', payload: { spec: runSpec } });
  log.append({ runId, ts: 2, type: 'worker.dispatched', payload: {} });
  log.append({ runId, ts: 3, type: 'worker.completed', payload: { outcome: 'DONE', headSha: HEAD } });
  log.append({ runId, ts: 4, type: 'validator.dispatched', payload: {} });
  log.append({ runId, ts: 5, type: 'validator.completed', payload: { record: { detail: passTrailer() }, validatedHeadSha: HEAD } });
  log.append({
    runId,
    ts: 6,
    type: 'gate.evaluated',
    payload: {
      ok: true,
      prExists: true,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: HEAD,
      validation: { self: 'PASS', independent: 'PASS', headSha: HEAD },
      reviewBot: { name: 'validate', state: 'success', headSha: HEAD },
    },
  });
}

// Append a worker-blocked run (-> needsChief) without any validator/fixback lane.
function appendBlockedRun(log: any, runId: string) {
  log.append({ runId, ts: 1, type: 'run.created', payload: { spec: {} } });
  log.append({ runId, ts: 2, type: 'worker.dispatched', payload: {} });
  log.append({ runId, ts: 3, type: 'worker.completed', payload: { outcome: 'BLOCKED' } });
}

test('multitasking: big/medium/small runs share one ledger with zero cross-run bleed', () => {
  const log = createMemoryEventLog();

  // SMALL: a single run that ships. MEDIUM: a single run that gets stuck and
  // needs the owner. BIG: split into a 3-lane wave, each lane its own run.
  const small = 'small-1';
  const medium = 'medium-1';
  const big = ['big-f1', 'big-f2', 'big-f3'];

  // Build per-run event scripts, then append them INTERLEAVED (round-robin) so
  // the ledger is a realistic mixed stream — proving the reconciler keys purely
  // on runId, not on event adjacency.
  const scripts: Array<[string, (l: any) => void]> = [
    [small, (l) => appendPassRun(l, small)],
    [medium, (l) => appendBlockedRun(l, medium)],
    ...big.map((id) => [id, (l: any) => appendPassRun(l, id)] as [string, (l: any) => void]),
  ];
  // Capture each run's event list, then zip them.
  const perRun = scripts.map(([id, fn]) => { const tmp = createMemoryEventLog(); fn(tmp); return tmp.readRun(id); });
  const maxLen = Math.max(...perRun.map((e) => e.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const events of perRun) {
      if (i < events.length) {
        const e = events[i];
        log.append({ runId: e.runId, ts: e.ts, type: e.type, payload: e.payload });
      }
    }
  }

  // Each run reconciles to its OWN decision, unaffected by the others' events.
  assert.equal(reconcile(small, log).decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, 'small ships');
  for (const id of big) {
    assert.equal(reconcile(id, log).decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, `${id} ships`);
  }
  const med = reconcile(medium, log);
  assert.equal(med.decision.next, NEXT_ACTIONS.BLOCKED, 'medium is blocked by its worker result');
  assert.match(med.decision.reason, /worker returned BLOCKED/i);

  // The six-panel projection buckets all five runs correctly and completely.
  const panels = project(log);
  const ship = new Set(panels.readyToShip.map((r: any) => r.runId));
  assert.equal(panels.readyToShip.length, 4, 'small + 3 big lanes are ready to ship');
  assert.ok([small, ...big].every((id) => ship.has(id)), 'every shipping run is present');
  assert.equal(panels.needsChief.length, 1, 'only the medium run needs the owner');
  assert.equal(panels.needsChief[0].runId, medium);
});

test('scalability: 50 independent runs each reconcile + project correctly', () => {
  const log = createMemoryEventLog();
  const ids = Array.from({ length: 50 }, (_, i) => `scale-${i}`);
  // Half ship, half block — interleaved by parity.
  ids.forEach((id, i) => (i % 2 === 0 ? appendPassRun(log, id) : appendBlockedRun(log, id)));

  const shipping = ids.filter((_, i) => i % 2 === 0);
  const blocked = ids.filter((_, i) => i % 2 === 1);

  for (const id of shipping) {
    assert.equal(reconcile(id, log).decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, `${id} ships`);
  }
  for (const id of blocked) {
    assert.equal(reconcile(id, log).decision.next, NEXT_ACTIONS.BLOCKED, `${id} blocked`);
  }

  const panels = project(log);
  assert.equal(panels.readyToShip.length, shipping.length, 'all shipping runs surface');
  assert.equal(panels.needsChief.length, blocked.length, 'all blocked runs surface');
  // No duplicate runIds across panels (clean partition).
  const allRunIds = [...panels.readyToShip, ...panels.needsChief, ...panels.active].map((r: any) => r.runId);
  assert.equal(new Set(allRunIds).size, allRunIds.length, 'each run appears in exactly one panel');
});

test('concurrency: many runToQuiescence calls in flight at once never interfere', async () => {
  // Each seeded run is worker-DONE, so the loop's next action is the read-only
  // gate. An unwired gate parks each run without spawning another agent.
  const h = createRunLedgerHarness({
    effects: {
      release: () => null,
    },
  });
  const ids = Array.from({ length: 12 }, (_, i) => `cc-${i}`);
  // Seed each run + a real completion carrying its OWN agent.
  for (const id of ids) {
    h.kernel.recordEvent({ runId: id, type: 'run.created', payload: { spec: {} } });
    h.kernel.recordEvent({ runId: id, type: 'worker.completed', payload: { outcome: 'DONE', headSha: HEAD, agent: id }, ts: 1 });
    h.kernel.recordEvent({ runId: id, type: 'worker.telemetry', payload: { agent: id, runs: 1, commands: 1, durationMs: 10, tokens: 4 } });
  }

  // Drive every run forward AT ONCE. Each parks at release; no throw.
  const results = await Promise.all(ids.map((id) => h.runToQuiescence(id)));
  assert.equal(results.length, ids.length);
  for (const steps of results) {
    assert.ok(Array.isArray(steps) && steps.length >= 1, 'each run advanced');
    assert.ok(steps.every((s: any) => s.ok !== false), 'no driver threw');
  }

  // The board shows exactly the distinct runs, each keyed to its own agent —
  // no card carries another run's agent (the cross-run bleed failure mode).
  const board = h.board();
  for (const id of ids) {
    const card = board.cards.find((c: any) => c.id === id);
    assert.ok(card, `run ${id} surfaces as a card`);
    assert.equal(card.agentId, id, `card ${id} keyed to its own agent, not a neighbor's`);
  }
});

test('idempotency: duplicate completion deliveries collapse to one stored event', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'idem', ts: 1, type: 'run.created', payload: { spec: {} } });
  const done = { id: 'idem:worker.completed:fixed', runId: 'idem', ts: 2, type: 'worker.completed', payload: { outcome: 'DONE', headSha: HEAD } };

  const first = log.append(done);
  assert.ok(first, 'first delivery is stored');
  // Re-deliver the SAME id 5 times (duplicate Ring-2 deliveries / retries).
  for (let i = 0; i < 5; i += 1) assert.equal(log.append(done), null, 'duplicate id skipped');
  assert.equal(log.readRun('idem').filter((e: any) => e.type === 'worker.completed').length, 1, 'exactly one completion stored');
});

test('security: credentials in an event payload are redacted at the write boundary', () => {
  const log = createMemoryEventLog();
  // A worker trailer that leaked several credential shapes inline.
  const leaky =
    'DONE: VERDICT=PASS ran gh auth with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ' +
    'and sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB and header Bearer CCCCCCCCCCCCCCCCCCCCCCCC ' +
    'and plane_api_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF and ace_rt_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG ' +
    'env api_key=DDDDDDDDDDDDDDDDDDDD';
  const stored = log.append({ runId: 'sec', ts: 1, type: 'worker.completed', payload: { outcome: 'DONE', detail: leaky } });

  const blob = JSON.stringify(stored);
  for (const secret of ['ghp_AAAA', 'sk-ant-api03-BBBB', 'Bearer CCCC', 'plane_api_FFFF', 'ace_rt_GGGG', 'DDDDDDDDDDDDDDDDDDDD']) {
    assert.ok(!blob.includes(secret), `secret "${secret}" must not be durably written`);
  }
  assert.ok(blob.includes('[REDACTED]'), 'secrets are masked, not dropped');
  // Control tokens the reconciler depends on survive redaction untouched.
  assert.ok(stored.payload.detail.includes('VERDICT=PASS'), 'verdict marker preserved');
  assert.equal(stored.payload.outcome, 'DONE', 'non-secret fields preserved');

  // The exported helper redacts nested structures too.
  const nested = redactSecrets({ a: ['ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], b: { c: 'token=EEEEEEEEEEEEEEEE' } });
  assert.equal(nested.a[0], '[REDACTED]');
  assert.ok(String(nested.b.c).includes('[REDACTED]'));
});
