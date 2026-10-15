// loop.test — the day-one PROOF that the autonomy loop CLOSES through the new
// Run Ledger layer. It exercises the real spine modules end to end:
//   event-ledger (append-only source of truth) -> reconciler.foldEventsToState
//   -> orchestration-policy.nextActionForFeature -> projection.project (six
//   panels) -> next-goal.deriveNextGoal (outer-loop handoff).
//
// Nothing is mocked: realistic event payloads drive the real fold + the real
// policy + the real verdict parser. Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/loop.test.cts
//
// Determinism: ids/timestamps are supplied per-event (no Date.now/Math.random).

const test = require('node:test');
const assert = require('node:assert/strict');

// Build-agnostic sibling imports: the compiled .cjs is gitignored and may be
// absent in a fresh worktree, so fall back to the .cts that tsx resolves.
let eventLedgerModule: any;
try {
  eventLedgerModule = require('../event-ledger.cjs');
} catch {
  eventLedgerModule = require('../event-ledger.cts');
}
const { createMemoryEventLog } = eventLedgerModule;

let reconcilerModule: any;
try {
  reconcilerModule = require('../reconciler.cjs');
} catch {
  reconcilerModule = require('../reconciler.cts');
}
const { reconcile, foldEventsToState } = reconcilerModule;

let projectionModule: any;
try {
  projectionModule = require('../projection.cjs');
} catch {
  projectionModule = require('../projection.cts');
}
const { project } = projectionModule;

let boardProjectionModule: any;
try {
  boardProjectionModule = require('../board-projection.cjs');
} catch {
  boardProjectionModule = require('../board-projection.cts');
}
const { projectLeanBoard } = boardProjectionModule;

let completionPacketModule: any;
try {
  completionPacketModule = require('../completion-packet.cjs');
} catch {
  completionPacketModule = require('../completion-packet.cts');
}
const { buildEvidenceBundle } = completionPacketModule;

let nextGoalModule: any;
try {
  nextGoalModule = require('../next-goal.cjs');
} catch {
  nextGoalModule = require('../next-goal.cts');
}
const { deriveNextGoal } = nextGoalModule;

let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS } = orchestrationPolicy;

let verdictModule: any;
try {
  verdictModule = require('../../../tools/ace/src/verdict.cjs');
} catch {
  verdictModule = require('../../../tools/ace/src/verdict.cts');
}
const { parseValidatorRecordVerdict } = verdictModule;

// A head sha shared by the worker output and the validator attestation. The
// policy's stale-head guard only lets a PASS walk to the gate when the
// validated head matches the current head, so we keep them equal on the pass
// path. (>=7 chars so the spine's startsWith fuzz still treats them as equal.)
const HEAD = 'deadbeefcafe01';

// A realistic validator trailer detail line (exactly what verdict.cts parses):
// `DONE: VERDICT=<v> on <pr-url> {json carrier}`. The single-line JSON object is
// the machine carrier — scorecard rides inside it.
function validatorDetail(verdict: string, scorecard: any[]) {
  const token = verdict === 'pass' ? 'PASS' : verdict === 'request-changes' ? 'REQUEST-CHANGES' : 'BLOCK';
  const prefix = verdict === 'pass' ? 'DONE' : 'BLOCKED';
  const carrier = JSON.stringify({ verdict, taskId: 'tsk_worker', scorecard });
  return `${prefix}: VERDICT=${token} on https://github.com/acme/repo/pull/9 ${carrier}`;
}

// A validator.completed payload whose `.record.detail` is what the reconciler
// fold runs through parseValidatorRecordVerdict.
function validatorRecord(verdict: string, scorecard: any[]) {
  return { detail: validatorDetail(verdict, scorecard) };
}

test('PASS path: run.created -> worker DONE -> validator PASS -> gate ok lands in readyToShip', () => {
  const log = createMemoryEventLog();
  const runId = 'run_pass';

  // Keep the fixture trivial so this test isolates review evidence; medium/high
  // Clawpatch enforcement is covered by the dedicated evidence-gate flow.
  assert.ok(log.append({ runId, ts: 1, type: 'run.created', payload: { spec: { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke diagnostic' } } }));

  // 1. Worker dispatched, then DONE with the head it produced.
  log.append({ runId, ts: 2, type: 'worker.dispatched', payload: {} });

  // After dispatch but before completion the spine syncs the worker.
  let r = reconcile(runId, log);
  assert.equal(r.decision.next, NEXT_ACTIONS.SYNC_WORKER, 'in-flight worker is sync_worker');

  log.append({
    runId,
    ts: 3,
    type: 'worker.completed',
    payload: { outcome: 'DONE', headSha: HEAD },
  });

  // 2. Worker DONE + no evidence advances to the read-only PR gate.
  r = reconcile(runId, log);
  assert.equal(
    r.decision.next,
    NEXT_ACTIONS.GATE,
    'worker DONE waits for live review evidence without a validator'
  );
  assert.equal(r.state.worker.done, true);
  assert.equal(r.state.worker.outcome, 'DONE');

  // 3. The owner manually attaches a validator, whose PASS remains supported.
  log.append({ runId, ts: 4, type: 'validator.dispatched', payload: {} });
  r = reconcile(runId, log);
  assert.equal(r.decision.next, NEXT_ACTIONS.SYNC_WORKER, 'in-flight validator is sync_worker');

  log.append({
    runId,
    ts: 5,
    type: 'validator.completed',
    payload: {
      record: validatorRecord('pass', [
        { id: 'A1', met: true, evidence: 'stdout.log' },
        { id: 'A2', met: true, evidence: 'npm test output' },
      ]),
      validatedHeadSha: HEAD,
    },
  });

  // The fold mapped the parsed verdict onto the validator outcome.
  r = reconcile(runId, log);
  assert.equal(r.state.validator.done, true);
  assert.equal(r.state.validator.outcome, 'PASS');
  assert.equal(r.state.validatedHeadSha, HEAD);
  // Validator PASS alone still cannot bypass ordinary current-head review.
  assert.equal(
    r.decision.next,
    NEXT_ACTIONS.GATE,
    'a clean manual PASS still waits for the live PR review gate'
  );

  // 4. gate.evaluated(ok:true) — the PR exists, checks are green, mergeable.
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
      validation: { self: 'PASS', independent: 'PASS', required: true, headSha: HEAD },
      reviewBot: { name: 'validate', state: 'success', headSha: HEAD },
    },
  });

  r = reconcile(runId, log);
  // PR exists, green, mergeable, not merged ⇒ release goal performs the merge.
  assert.equal(
    r.decision.next,
    NEXT_ACTIONS.DISPATCH_RELEASE_GOAL,
    'gated, green, mergeable PR ⇒ dispatch_release_goal'
  );

  // 5. The six-panel projection lands this run in readyToShip (and nowhere
  //    else).
  const panels = project(log);
  assert.equal(panels.readyToShip.length, 1, 'exactly one run is ready to ship');
  assert.equal(panels.readyToShip[0].runId, runId);
  assert.equal(panels.intake.length, 0);
  assert.equal(panels.active.length, 0);
  assert.equal(panels.needsChief.length, 0);
  assert.equal(panels.brokenAutonomy.length, 0);
  assert.equal(panels.recent.length, 0);
});

test('stale projection recovery: current gate PASS at live PR head unblocks autoship readiness', () => {
  const log = createMemoryEventLog();
  const runId = 'run_autoship_recover';
  const OLD_HEAD = 'aaa1111aaa1111';
  const LIVE_HEAD = 'bbb2222bbb2222';

  log.append({
    runId,
    ts: 1,
    type: 'run.created',
    payload: {
      spec: {
        autoShip: { enabled: true, autoMerge: true },
        scope: { allow: ['src/'] },
      },
    },
  });
  log.append({
    runId,
    ts: 2,
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_worker', branch: 'feat/autoship', worktreePath: '/tmp/wt-autoship' },
  });
  log.append({ runId, ts: 3, type: 'worker.completed', payload: { outcome: 'DONE', headSha: OLD_HEAD } });
  log.append({ runId, ts: 4, type: 'validator.dispatched', payload: {} });
  log.append({
    runId,
    ts: 5,
    type: 'validator.completed',
    payload: { record: validatorRecord('pass', [{ id: 'A1', met: true, evidence: 'old run' }]), validatedHeadSha: OLD_HEAD },
  });

  // Fresh live PR evidence says the fixed/current PR head has independent PASS,
  // green checks, clean scope, and is mergeable. This must override the stale
  // folded validator head instead of rerunning the old parser projection forever.
  log.append({
    runId,
    ts: 6,
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      prNumber: 17,
      prUrl: 'https://github.com/acme/repo/pull/17',
      prState: 'OPEN',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: LIVE_HEAD,
      headBranch: 'feat/autoship',
      changedFiles: ['src/autoship.ts'],
      allowedPaths: ['src/'],
      validation: { self: 'PASS', independent: 'PASS', required: true, headSha: LIVE_HEAD },
      reviewBot: { name: 'validate', state: 'success', headSha: LIVE_HEAD },
      clawpatch: {
        enforced: true,
        present: true,
        status: 'pass',
        inconclusive: false,
        blockingFindings: [],
        headSha: LIVE_HEAD,
      },
    },
  });

  const r = reconcile(runId, log, { wantGate: true });
  assert.equal(r.state.currentHeadSha, LIVE_HEAD);
  assert.equal(r.state.validatedHeadSha, LIVE_HEAD);
  assert.equal(r.decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);
  assert.equal(r.gate.ok, true);
  assert.equal(r.autoship.status, 'ready_to_autoship');
  assert.equal(r.autoship.autoMergeAllowed, true);

  const panels = project(log);
  assert.equal(panels.readyToShip.length, 1);
  assert.equal(panels.readyToShip[0].autoship.status, 'ready_to_autoship');
});

test('projection repair: merged PR evidence supersedes stale validator request-changes', () => {
  const log = createMemoryEventLog();
  const runId = 'run_stale_request_changes_merged';
  const OLD_HEAD = 'old1111old1111';
  const LIVE_HEAD = 'new2222new2222';

  log.append({
    runId,
    ts: 1,
    type: 'run.created',
    payload: { spec: { scope: { allow: ['src/'] } } },
  });
  log.append({
    runId,
    ts: 2,
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_worker', branch: 'feat/repair', worktreePath: '/tmp/wt-repair' },
  });
  log.append({ runId, ts: 3, type: 'worker.completed', payload: { outcome: 'DONE', headSha: OLD_HEAD } });
  log.append({ runId, ts: 4, type: 'validator.dispatched', payload: {} });
  log.append({
    runId,
    ts: 5,
    type: 'validator.completed',
    payload: { outcome: 'FIXBACK_REQUIRED', validatedHeadSha: OLD_HEAD },
  });

  let r = reconcile(runId, log, { wantGate: true });
  assert.equal(r.decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.decision.reason, /request-changes/);

  log.append({
    runId,
    ts: 6,
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      prNumber: 23,
      prUrl: 'https://github.com/acme/repo/pull/23',
      prState: 'OPEN',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: LIVE_HEAD,
      headBranch: 'feat/repair',
      baseBranch: 'main',
      changedFiles: ['src/repair.ts'],
      allowedPaths: ['src/'],
      validation: { independent: 'PASS', required: true },
    },
  });
  log.append({
    runId,
    ts: 7,
    type: 'merged',
    payload: {
      sha: 'merge123',
      headSha: LIVE_HEAD,
      cleanedUp: true,
      prNumber: 23,
      prUrl: 'https://github.com/acme/repo/pull/23',
      prState: 'MERGED',
      headBranch: 'feat/repair',
      baseBranch: 'main',
    },
  });

  r = reconcile(runId, log, { wantGate: true });
  assert.equal(r.state.validator.outcome, 'FIXBACK_REQUIRED', 'old validator event remains historical evidence');
  assert.equal(r.state.merge.merged, true);
  assert.equal(r.state.pr.url, 'https://github.com/acme/repo/pull/23');
  assert.equal(r.state.pr.state, 'MERGED');
  assert.equal(r.decision.next, NEXT_ACTIONS.NOTHING);

  const panels = project(log);
  assert.equal(panels.needsChief.length, 0);
  assert.equal(panels.recent.length, 1);
  assert.equal(panels.recent[0].runId, runId);

  const board = projectLeanBoard(log);
  const card = board.cards.find((row: any) => row.id === runId);
  assert.equal(card.stage, 'done');
  assert.equal(card.prUrl, 'https://github.com/acme/repo/pull/23');
  assert.equal(card.prStatus, 'MERGED');
  assert.equal(card.validationStatus, 'MERGED');
  assert.equal(card.detail.merge.merged, true);
});

test('FAIL path: validator request-changes routes findings to the original worker stream', () => {
  const log = createMemoryEventLog();
  const runId = 'run_fix';

  log.append({ runId, ts: 1, type: 'run.created', payload: { spec: {} } });
  log.append({ runId, ts: 2, type: 'worker.dispatched', payload: {} });
  log.append({ runId, ts: 3, type: 'worker.completed', payload: { outcome: 'DONE', headSha: HEAD } });
  log.append({ runId, ts: 4, type: 'validator.dispatched', payload: {} });
  log.append({
    runId,
    ts: 5,
    type: 'validator.completed',
    payload: { outcome: 'FIXBACK_REQUIRED', validatedHeadSha: HEAD },
  });

  const r = reconcile(runId, log);
  assert.equal(r.state.validator.outcome, 'FIXBACK_REQUIRED');
  assert.equal(r.decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
  assert.match(r.decision.reason, /original worker stream/);
  // reconcile() is a pure read — the fixback marker is appended only by a
  // kernel runStep, so the decision alone must not touch the ledger.
  assert.equal(log.readRun(runId).filter((event: any) => event.type === 'fixback.dispatched').length, 0);
});

test('idempotency: appending the same event id twice does not duplicate', () => {
  const log = createMemoryEventLog();
  const runId = 'run_idem';

  log.append({ runId, ts: 1, type: 'run.created', payload: { spec: {} } });
  const dispatched = log.append({ runId, ts: 2, type: 'worker.dispatched', payload: {} });
  assert.ok(dispatched && dispatched.id, 'first append returns the event with a derived id');

  const before = log.readRun(runId).length;

  // Re-append the SAME event id: the log must skip it (returns null) and the
  // run length must be unchanged.
  const dup = log.append({ id: dispatched.id, runId, ts: 2, type: 'worker.dispatched', payload: {} });
  assert.equal(dup, null, 'duplicate id is skipped');
  assert.equal(log.readRun(runId).length, before, 'readRun length unchanged after duplicate append');
});

test('fidelity: a realistic validator record folds to the verdict parseValidatorRecordVerdict reads', () => {
  // The verdict parser is the single source of truth for the trailer. This test
  // asserts (a) the parser reads each verdict and (b) the reconciler fold's
  // record path maps it onto the exact validator.outcome token it actually
  // emits today. It deliberately PINS the current reconciler→spine vocabulary
  // gap so a future fix surfaces here:
  //   parser 'pass'            -> fold 'PASS'            (spine-recognized)
  //   parser 'request-changes' -> fold 'REQUEST-CHANGES' (spine sees NONE!)
  //   parser 'block'           -> fold 'BLOCK'           (spine sees NONE!)
  // Only 'PASS' is a token the spine's evaluateValidatorVerdict understands; the
  // other two are NOT in KNOWN_OUTCOMES (which uses FIXBACK_REQUIRED /
  // BLOCKED_SCOPE), so a record-driven request-changes/block currently
  // mis-routes to a "no parseable trailer" BLOCK. Noted in the summary.
  const SPINE_RECOGNIZED = new Set(['PASS', 'FIXBACK_REQUIRED', 'BLOCKED_SCOPE', 'COMPUTER_USE_REQUIRED', 'MANUAL_REQUIRED', 'NONE']);
  const cases = [
    { verdict: 'pass', foldedOutcome: 'PASS', spineRecognized: true },
    { verdict: 'request-changes', foldedOutcome: 'REQUEST-CHANGES', spineRecognized: false },
    { verdict: 'block', foldedOutcome: 'BLOCK', spineRecognized: false },
  ] as const;

  for (const { verdict, foldedOutcome, spineRecognized } of cases) {
    const record = validatorRecord(verdict, [{ id: 'A1', met: verdict === 'pass', evidence: 'x' }]);

    // 1. Direct parse — what the trailer carries.
    const parsed = parseValidatorRecordVerdict(record);
    assert.equal(parsed && parsed.verdict, verdict, `direct parse reads ${verdict}`);

    // 2. The same record, run through the fold via a validator.completed event.
    const state = foldEventsToState([
      { type: 'run.created', payload: { spec: {} } },
      { type: 'worker.dispatched', payload: {} },
      { type: 'worker.completed', payload: { outcome: 'DONE', headSha: HEAD } },
      { type: 'validator.dispatched', payload: {} },
      { type: 'validator.completed', payload: { record, validatedHeadSha: HEAD } },
    ]);
    assert.equal(state.validator.outcome, foldedOutcome, `fold maps ${verdict} -> ${foldedOutcome}`);

    // 3. Pin the contract gap: which folded tokens the spine actually accepts.
    assert.equal(
      SPINE_RECOGNIZED.has(state.validator.outcome),
      spineRecognized,
      `folded outcome ${foldedOutcome} spine-recognized=${spineRecognized}`
    );
  }
});

test('next-goal: a passing bundle yields no_goal or an owner-approval proposal — never auto-dispatch', () => {
  // A clean pass with no failing criteria and no follow-ups ⇒ no_goal.
  const passBundle = buildEvidenceBundle({
    runId: 'run_pass',
    verdict: 'pass',
    acceptanceResults: [{ id: 'A1', status: 'pass' }],
    detail: 'all criteria met',
  });
  const noGoal = deriveNextGoal(passBundle);
  assert.ok('no_goal' in noGoal, 'a clean pass proposes no follow-up goal');
  assert.equal((noGoal as any).goal, undefined, 'no_goal carries no dispatchable goal');

  // A pass WITH an explicit owner follow-up ⇒ a PROPOSAL, but it must require
  // owner approval and must never carry an auto-dispatch flag.
  const proposal = deriveNextGoal(passBundle, { followups: ['Plan the next slice'] });
  assert.equal('no_goal' in proposal, false, 'an explicit follow-up yields a proposal, not no_goal');
  assert.equal((proposal as any).requiresOwnerApproval, true, 'proposal always requires owner approval');
  assert.equal((proposal as any).runspec.autoValidate, false, 'never auto-validate');
  assert.equal((proposal as any).runspec.autoMerge, false, 'never auto-merge');
  assert.equal((proposal as any).runspec.autoRelease, false, 'never auto-release');
});
