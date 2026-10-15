// dispatch-retry-cap — pins the fixes for the June-2026 validator dispatch
// storm: 14 runs with unresolvable specs were re-dispatched ~33k times because
// (a) a bare re-dispatch marker cleared the failure flag, and (b) the
// stale-head revalidation branch bypassed the dispatchFailed guard once
// validator.done was true. The fold now carries a consecutive-failure count
// that only a real link/completion clears, the policy terminally blocks at
// DISPATCH_RETRY_CAP, and the file ledger compacts storm repetition at boot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let reconcilerModule: any;
try { reconcilerModule = require('../reconciler.cts'); }
catch { reconcilerModule = require('../reconciler.cjs'); }
const { foldEventsToState } = reconcilerModule;

let policyModule: any;
try { policyModule = require('../../../tools/ace/src/orchestration-policy.cts'); }
catch { policyModule = require('../../../tools/ace/src/orchestration-policy.cjs'); }
const { nextActionForFeature, NEXT_ACTIONS, DISPATCH_RETRY_CAP } = policyModule;

let eventLedgerModule: any;
try { eventLedgerModule = require('../event-ledger.cts'); }
catch { eventLedgerModule = require('../event-ledger.cjs'); }
const { createFileEventLog, compactFileEventLog, COMPACT_KEEP_LAST } = eventLedgerModule;

const ev = (type: string, payload: any = {}, i: number = 0) => ({
  id: `run-1:${type}:${i}`,
  runId: 'run-1',
  type,
  payload,
});

// ---------------------------------------------------------------------------
// Fold: consecutive dispatch-failure counters
// ---------------------------------------------------------------------------

test('fold: validator failure count survives a bare re-dispatch marker', () => {
  const events = [
    ev('run.created', { spec: {} }),
    ev('validator.dispatched', {}, 1),
    ev('validator.dispatch.failed', { error: 'workspaceId required' }, 2),
    ev('validator.dispatched', {}, 3),
    ev('validator.dispatch.failed', { error: 'workspaceId required' }, 4),
  ];
  const state = foldEventsToState(events);
  assert.equal(state.validator.dispatchFailedCount, 2);
  assert.equal(state.validator.dispatchFailed, true);
});

test('fold: a real validator link resets the failure count', () => {
  const events = [
    ev('validator.dispatched', {}, 1),
    ev('validator.dispatch.failed', { error: 'boom' }, 2),
    ev('validator.dispatch.linked', { taskId: 't', streamId: 's' }, 3),
  ];
  const state = foldEventsToState(events);
  assert.equal(state.validator.dispatchFailedCount, 0);
  assert.equal(state.validator.dispatchFailed, false);
});

test('fold: worker failure count increments and completion resets it', () => {
  const failing = foldEventsToState([
    ev('worker.dispatched', {}, 1),
    ev('worker.dispatch.failed', { error: 'spawn failed' }, 2),
    ev('worker.dispatched', {}, 3),
    ev('worker.dispatch.failed', { error: 'spawn failed' }, 4),
    ev('worker.dispatched', {}, 5),
    ev('worker.dispatch.failed', { error: 'spawn failed' }, 6),
  ]);
  assert.equal(failing.worker.dispatchFailedCount, 3);
  const recovered = foldEventsToState([
    ev('worker.dispatch.failed', { error: 'spawn failed' }, 1),
    ev('worker.completed', { outcome: 'DONE' }, 2),
  ]);
  assert.equal(recovered.worker.dispatchFailedCount, 0);
});

// ---------------------------------------------------------------------------
// Policy: terminal block at the cap
// ---------------------------------------------------------------------------

test('policy: validator failures at the cap terminally block', () => {
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: { dispatchFailed: true, dispatchFailedCount: DISPATCH_RETRY_CAP, dispatchError: 'workspaceId required' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /validator dispatch failed 3x consecutively/);
  assert.match(r.reason, /workspaceId required/);
});

test('policy: the storm scenario — validator PASS with stale head + capped failures blocks instead of re-dispatching', () => {
  // Pre-fix, this exact state fell through to the stale-head revalidation
  // branch (validator.done bypasses the dispatchFailed guard) and re-issued
  // DISPATCH_GOAL_VALIDATOR forever.
  const r = nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    validator: {
      dispatched: false,
      done: true,
      outcome: 'PASS',
      dispatchFailed: true,
      dispatchFailedCount: DISPATCH_RETRY_CAP + 1,
      dispatchError: 'spine-effects: workspaceId (a projects.id) required',
    },
    currentHeadSha: 'abc123',
    validatedHeadSha: 'def456',
    spec: { explicitValidationRequired: true },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /fix the spec and submit a fresh run/);
});

test('policy: failures below the cap keep the existing fail-closed behavior', () => {
  const r = nextActionForFeature({
    worker: { dispatchFailed: true, dispatchFailedCount: 1, dispatchError: 'transient', done: false },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /worker dispatch failed — transient/);
});

test('policy: worker failures at the cap terminally block before any dispatch branch', () => {
  const r = nextActionForFeature({
    worker: { dispatched: false, dispatchFailed: true, dispatchFailedCount: DISPATCH_RETRY_CAP, dispatchError: 'pty spawn failed' },
  });
  assert.equal(r.next, NEXT_ACTIONS.BLOCKED);
  assert.match(r.reason, /worker dispatch failed 3x consecutively/);
});

// ---------------------------------------------------------------------------
// Ledger compaction
// ---------------------------------------------------------------------------

function writeStormLedger(file: string, stormCycles: number) {
  const lines: string[] = [];
  let seq = 0;
  const push = (runId: string, type: string, payload: any = {}) => {
    lines.push(JSON.stringify({ id: `${runId}:${type}:${seq}`, runId, type, payload, ts: seq }));
    seq += 1;
  };
  push('run-keep', 'run.created', { spec: { goal: 'healthy run' } });
  push('run-keep', 'worker.dispatched');
  push('run-keep', 'worker.dispatch.linked', { taskId: 't1', streamId: 's1' });
  push('run-keep', 'worker.completed', { outcome: 'DONE' });
  for (let i = 0; i < stormCycles; i += 1) {
    push('run-storm', 'validator.dispatched');
    push('run-storm', 'validator.dispatch.failed', { error: 'workspaceId required' });
    push('run-storm', 'gate.evaluated', { prExists: false });
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return lines.length;
}

test('compaction: policy-verdict-preserving — count saturates at keepLast, verdict identical, nothing destroyed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-compact-'));
  const file = path.join(dir, 'events.ndjson');
  const total = writeStormLedger(file, 5000);
  assert.ok(total > 10000);
  // A malformed (non-JSON) line must survive compaction verbatim.
  fs.appendFileSync(file, 'this is not json but must not be destroyed\n');

  const readEvents = () => String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const foldStorm = (evs: any[]) => foldEventsToState(evs.filter((e) => e.runId === 'run-storm'));
  const preState = foldStorm(readEvents());
  const preDecision = nextActionForFeature(preState);

  const result = compactFileEventLog(file, { threshold: 10000 });
  assert.equal(result.compacted, true);
  assert.ok(result.after < 30, `expected a tiny ledger, got ${result.after}`);
  assert.equal(result.before, total);

  // Every dropped event line is in the archive — nothing destroyed.
  const archived = String(fs.readFileSync(path.join(dir, 'events-archive.ndjson'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(archived.length, result.archived);
  assert.equal(result.after + result.archived, total);
  // The malformed line is preserved in the live file.
  assert.ok(String(fs.readFileSync(file, 'utf8')).includes('this is not json but must not be destroyed'));

  // HONEST semantics: the consecutive-failure count SATURATES at keepLast
  // (5000 true failures fold to COMPACT_KEEP_LAST after compaction)...
  const postState = foldStorm(readEvents());
  assert.equal(preState.validator.dispatchFailedCount, 5000);
  assert.equal(postState.validator.dispatchFailedCount, COMPACT_KEEP_LAST);
  // ...which preserves the POLICY VERDICT because keepLast >= DISPATCH_RETRY_CAP.
  const postDecision = nextActionForFeature(postState);
  assert.equal(preDecision.next, NEXT_ACTIONS.BLOCKED);
  assert.equal(postDecision.next, preDecision.next);
  assert.equal(postState.validator.dispatchFailed, preState.validator.dispatchFailed);
  assert.equal(postState.validator.dispatchError, preState.validator.dispatchError);
  // The healthy run's non-collapsible events are untouched.
  assert.equal(readEvents().filter((e) => e.runId === 'run-keep').length, 4);
});

test('compaction invariant: COMPACT_KEEP_LAST covers every counter-reading policy threshold', () => {
  // If a cap raise ever exceeds what compaction retains, saturated counts
  // could drop below the threshold and un-block storm runs. Pin it.
  assert.ok(
    COMPACT_KEEP_LAST >= DISPATCH_RETRY_CAP,
    `COMPACT_KEEP_LAST (${COMPACT_KEEP_LAST}) must be >= DISPATCH_RETRY_CAP (${DISPATCH_RETRY_CAP})`,
  );
});

test('compaction: below the threshold is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-compact-'));
  const file = path.join(dir, 'events.ndjson');
  writeStormLedger(file, 10);
  const result = compactFileEventLog(file, { threshold: 10000 });
  assert.equal(result.compacted, false);
  assert.ok(!fs.existsSync(path.join(dir, 'events-archive.ndjson')));
});

test('compaction: createFileEventLog auto-compacts an oversized ledger at construction and stays appendable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-compact-'));
  const file = path.join(dir, 'events.ndjson');
  writeStormLedger(file, 5000);
  const log = createFileEventLog(file, { now: () => 1 });
  assert.ok(log.readAll().length < 30);
  const appended = log.append({ runId: 'run-new', type: 'run.created', payload: { spec: {} } });
  assert.ok(appended);
  assert.equal(log.readRun('run-new').length, 1);
});
