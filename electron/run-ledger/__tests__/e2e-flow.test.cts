// e2e-flow — the NERVOUS-SYSTEM flow test: ONE composed harness driven through
// the FULL autonomy lifecycle with injected fake effects, asserting the signal
// travels brain → spine → dispatch → same-worker review → gate → fail-closed
// merge end to end. The sibling tests cover each organ in isolation
// (spine-effects = the limbs, loop = the policy, pulse-wiring = the Ring-2
// pulse, harness = the loop closing on synthetic effects); NONE drive the REAL
// spine-effects through ONE harness across the whole lifecycle. This does.
//
// Composition under test (exactly the live wiring, minus electron):
//   createRunLedgerHarness({ effects: createSpineEffects({ client, runTask }) })
// The brain intent is submitted; the loop dispatches a REAL (faked) fire-and-
// forget worker; completions are mirrored back the way ace-control's
// observeCompletions does — fromCompletion(record, runId) → kernel.recordEvent
// → runToQuiescence — never by hand-appending intermediate lifecycle events.
//
// Determinism: every event/record carries a caller-supplied ts (no Date.now /
// Math.random). Env (ACE_OWNER_AUTH_TOKEN) is set + restored per-test.
//
//   node --test --require tsx/cjs electron/run-ledger/__tests__/e2e-flow.test.cts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Build-agnostic sibling imports: the compiled .cjs is gitignored and may be
// absent in a fresh worktree, so fall back to the .cts that tsx resolves.
let harnessMod: any;
try { harnessMod = require('../harness.cts'); } catch { harnessMod = require('../harness.cjs'); }
const { createRunLedgerHarness } = harnessMod;

let spineEffectsMod: any;
try { spineEffectsMod = require('../spine-effects.cts'); } catch { spineEffectsMod = require('../spine-effects.cjs'); }
const { createSpineEffects } = spineEffectsMod;

let eventLedgerMod: any;
try { eventLedgerMod = require('../event-ledger.cts'); } catch { eventLedgerMod = require('../event-ledger.cjs'); }
const { createMemoryEventLog } = eventLedgerMod;

let fromCompletionMod: any;
try { fromCompletionMod = require('../from-completion.cts'); } catch { fromCompletionMod = require('../from-completion.cjs'); }
const { fromCompletion } = fromCompletionMod;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
const { NEXT_ACTIONS } = orchestrationPolicy;

let boardProjectionMod: any;
try { boardProjectionMod = require('../board-projection.cts'); } catch { boardProjectionMod = require('../board-projection.cjs'); }
const { projectLeanBoard } = boardProjectionMod;

// A head sha shared by the worker output, the validator attestation, and the PR
// gate facts. The policy's stale-head guard only lets a PASS walk to the gate
// when the validated head matches the current head, so every limb attests the
// SAME head on the pass path. (>=7 chars so the spine's startsWith fuzz holds.)
const HEAD = 'deadbeefcafe01';
const WORKSPACE = 'prj_e2e';

// --- Fakes (the only seams the spine touches) -----------------------------

// The in-process IPC client: gate (integrationOpenPr/integrationGate) and merge
// (integrationMergePr). Records every call so we can assert merge-count
// invariants exactly like spine-effects.test.cts does, but through the harness.
function fakeClient(responses: any = {}) {
  const calls: any[] = [];
  return {
    calls,
    count: (method: string) => calls.filter((c) => c.method === method).length,
    find: (method: string) => calls.find((c) => c.method === method),
    invoke: async (method: string, params: any) => {
      calls.push({ method, params });
      const r = responses[method];
      return typeof r === 'function' ? r(params) : (r === undefined ? {} : r);
    },
  };
}

// The PROVEN fire-and-forget spawn+deliver primitive (orchestrator.runTask),
// injected. Records the opts it was dispatched with and returns a stream
// descriptor — exactly what the real path returns AFTER delivery, so the spine
// records worker.dispatch.linked and returns null (Ring 2 completes it later).
function fakeRunTask(result?: any) {
  const calls: any[] = [];
  const fn = async (_client: any, opts: any) => {
    calls.push(opts);
    return result || { taskId: 'tsk_e2e', streamId: 'str_e2e', worktreeId: 'wt_e2e', branch: 'feat/e2e', baseBranch: 'main' };
  };
  (fn as any).calls = calls;
  return fn;
}

// Build the one composed harness exactly as the live controller would: a memory
// ledger + the REAL Ring-1 spine effects over the fakes.
function composeHarness(opts: any = {}) {
  const client = fakeClient(opts.responses || {});
  const runTask = fakeRunTask(opts.runTaskResult);
  const effects = createSpineEffects({ client, runTask, workspaceId: WORKSPACE });
  const ledger = createMemoryEventLog();
  const h = createRunLedgerHarness({ ledger, effects });
  return { h, client, runTask, ledger };
}

// A worker completion RECORD as observeCompletions builds it (taskId/kind/detail
// /streamId/agent + a head). fromCompletion(record, runId) maps it to ONE kernel
// event; the runId override correlates it to the spine run (no phantom run).
function workerRecord({ outcome = 'DONE', headSha = HEAD, agent = 'codex', ts = 0 }: any = {}) {
  return {
    record: {
      taskId: 'tsk_e2e',
      kind: outcome === 'BLOCKED' ? 'blocked' : 'done',
      detail: `DONE: implemented — head ${headSha}`,
      streamId: 'str_e2e',
      headSha,
      agent,
    },
    ts,
  };
}

// A validator completion RECORD carrying a real VERDICT trailer (exactly what
// verdict.cts parses). The single-line JSON is the machine carrier.
function validatorRecord({ verdict = 'pass', headSha = HEAD, ts = 0 }: any = {}) {
  const token = verdict === 'pass' ? 'PASS' : verdict === 'request-changes' ? 'REQUEST-CHANGES' : 'BLOCK';
  const prefix = verdict === 'pass' ? 'DONE' : 'BLOCKED';
  const carrier = JSON.stringify({ verdict, taskId: 'tsk_e2e', scorecard: [{ id: 'A1', met: verdict === 'pass', evidence: 'evidence.log' }] });
  return {
    record: {
      taskId: 'tsk_validator',
      kind: verdict === 'pass' ? 'done' : 'blocked',
      detail: `${prefix}: VERDICT=${token} on https://github.com/acme/repo/pull/9 ${carrier}`,
      streamId: 'str_validator',
      headSha,
      agent: 'codex',
    },
    ts,
  };
}

// Mirror observeCompletions: fromCompletion(record, runId) → recordEvent. The
// runId override wins over the taskId fallback so the completion closes THIS run
// (the synapse the live observer resolves from the dispatch annotation).
function deliver(h: any, runId: string, { record, ts }: any) {
  const evt = fromCompletion(record, runId);
  assert.ok(evt, 'fromCompletion produced a kernel event for the record');
  return h.kernel.recordEvent({ ...evt, ts });
}

// Drive worker → owner-attached validator → gated/green for one run, returning
// the harness + runId once the run sits in the ready-to-ship state. Independent
// validation is represented explicitly here so the ordinary worker path never
// creates a validator agent.
async function driveToReadyToShip(opts: any = {}) {
  const ctx = composeHarness(opts);
  const { h } = ctx;
  const runId = 'run-e2e';

  // BRAIN: the operator's structured intent. ownerAuthToken (when present) rides
  // on autoChain so the fail-closed release predicate can read it.
  h.submit({
    runId,
    ts: 1,
    goal: 'Add a --version flag to the CLI',
    agent: 'codex',
    taskType: 'no-code',
    roleMode: 'no-code',
    scope: { workspaceId: WORKSPACE, allow: ['src/'] },
    context: 'Hermes intake: ship a version flag.',
    constraints: ['stay surgical'],
    acceptance: [{ id: 'A1', text: 'ace --version prints the version' }],
    ...(opts.ownerAuthToken ? { autoChain: { ownerAuthToken: opts.ownerAuthToken } } : {}),
  });

  // SPINE → DISPATCH: the loop dispatches the worker once, then pauses (the real
  // fire-and-forget effect returns null; Ring 2 will deliver the completion).
  await h.runToQuiescence(runId);

  // WORKER DONE. Before the controller advances to release, the owner manually
  // attaches an independent validator to this run.
  deliver(h, runId, workerRecord({ outcome: 'DONE', ts: 2 }));
  h.kernel.recordEvent({ runId, ts: 3, type: 'validator.dispatched', payload: { source: 'manual-owner-action' } });
  h.kernel.recordEvent({ runId, ts: 4, type: 'validator.dispatch.linked', payload: { taskId: 'tsk_validator', streamId: 'str_validator' } });

  // The manually attached validator passes on the exact worker head.
  deliver(h, runId, validatorRecord({ verdict: 'pass', ts: 5 }));
  await h.runToQuiescence(runId);

  // GATE FACTS: a real, green, mergeable PR at the same head. Fed the way the
  // gate effect / CI observer would surface them — never a hand-rolled
  // intermediate lifecycle event.
  h.kernel.recordEvent({
    runId,
    ts: 6,
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: HEAD,
      validation: { self: 'PASS', independent: 'PASS', required: true, headSha: HEAD },
      reviewBot: { name: 'validate', state: 'success', headSha: HEAD },
    },
  });

  return { ...ctx, runId };
}

describe('run-ledger nervous-system flows (one harness, full lifecycle)', () => {
  it('WORKER DONE EVIDENCE GATES: review, Clawpatch, and UI computer-use never spawn validator/fixback', async () => {
    const { h, runTask, ledger } = composeHarness();
    const cleanClawpatch = {
      enforced: true,
      present: true,
      status: 'pass',
      inconclusive: false,
      blockingFindings: [],
      validatedHeadSha: HEAD,
    };
    const reviewed = {
      prExists: true,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha: HEAD,
      validation: { self: 'PASS', headSha: HEAD },
      reviewBot: { name: 'validate', state: 'success', headSha: HEAD },
    };

    const mediumRun = 'run-medium-evidence';
    h.submit({
      runId: mediumRun,
      ts: 1,
      goal: 'Update runtime parser behavior',
      agent: 'codex',
      changedFiles: ['tools/ace/src/parser.cts'],
      changedLineCount: 220,
      scope: { workspaceId: WORKSPACE },
    });
    await h.runToQuiescence(mediumRun);
    deliver(h, mediumRun, workerRecord({ outcome: 'DONE', ts: 2 }));
    let decision = h.kernel.reconcile(mediumRun).decision;
    assert.equal(decision.next, NEXT_ACTIONS.GATE, 'DONE alone cannot reach release');
    h.kernel.recordEvent({ runId: mediumRun, ts: 3, type: 'gate.evaluated', payload: reviewed });
    decision = h.kernel.reconcile(mediumRun).decision;
    assert.equal(decision.next, NEXT_ACTIONS.GATE, 'review evidence alone cannot bypass medium Clawpatch');
    h.kernel.recordEvent({
      runId: mediumRun,
      ts: 4,
      type: 'gate.evaluated',
      payload: {
        ...reviewed,
        clawpatch: { ...cleanClawpatch, validatedHeadSha: 'stale-head' },
      },
    });
    decision = h.kernel.reconcile(mediumRun).decision;
    assert.equal(decision.next, NEXT_ACTIONS.GATE, 'stale Clawpatch evidence cannot release');
    assert.notEqual(decision.next, NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR);
    assert.notEqual(decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER);
    h.kernel.recordEvent({
      runId: mediumRun,
      ts: 5,
      type: 'gate.evaluated',
      payload: { ...reviewed, clawpatch: cleanClawpatch },
    });
    assert.equal(h.kernel.reconcile(mediumRun).decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);

    const uiRun = 'run-ui-evidence';
    h.submit({
      runId: uiRun,
      ts: 6,
      goal: 'Fix browser UI flow',
      agent: 'codex',
      changedFiles: ['src/components/App.tsx'],
      changedLineCount: 20,
      scope: { workspaceId: WORKSPACE },
    });
    await h.runToQuiescence(uiRun);
    deliver(h, uiRun, workerRecord({ outcome: 'DONE', ts: 7 }));
    h.kernel.recordEvent({
      runId: uiRun,
      ts: 8,
      type: 'gate.evaluated',
      payload: { ...reviewed, clawpatch: cleanClawpatch },
    });
    decision = h.kernel.reconcile(uiRun).decision;
    assert.equal(decision.next, NEXT_ACTIONS.GATE, 'high-risk UI waits for computer-use evidence');
    h.kernel.recordEvent({
      runId: uiRun,
      ts: 9,
      type: 'gate.evaluated',
      payload: {
        ...reviewed,
        clawpatch: cleanClawpatch,
        computerUseEvidence: {
          verified: true,
          headSha: HEAD,
          artifactPath: '.ace/computer-use/completion.json',
        },
      },
    });
    assert.equal(h.kernel.reconcile(uiRun).decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL);

    for (const runId of [mediumRun, uiRun]) {
      const types = ledger.readRun(runId).map((event: any) => event.type);
      assert.ok(!types.includes('validator.dispatched'), `${runId}: no validator dispatch`);
      assert.ok(!types.includes('fixback.dispatched'), `${runId}: no fixback dispatch`);
    }
    assert.equal((runTask as any).calls.length, 2, 'only the two original workers were spawned');
  });

  it('HAPPY PATH: brain intent → worker → manual validator → gated-green ⇒ readyToShip / DISPATCH_RELEASE_GOAL', async () => {
    const { h, runTask, ledger, runId } = await driveToReadyToShip();

    // DISPATCH: the WORKER was dispatched exactly once through the proven
    // fire-and-forget path, carrying the STRUCTURED brain intent (not an empty
    // tab). Manual validation is attached through ledger evidence, never through
    // the automatic runTask primitive.
    const workerLinks = ledger.readRun(runId).filter((e: any) => e.type === 'worker.dispatch.linked');
    assert.equal(workerLinks.length, 1, 'exactly one WORKER dispatch linked to the run');
    const dispatchOpts = (runTask as any).calls[0];
    assert.equal(dispatchOpts.agent, 'codex');
    assert.equal(dispatchOpts.workspaceId, WORKSPACE);
    assert.equal(dispatchOpts.fireAndForget, true);
    assert.equal(dispatchOpts.spec.goal, 'Add a --version flag to the CLI');

    // The synapse: the worker dispatch is linked to THIS run so the completion
    // closed run-e2e (not a phantom keyed by taskId).
    assert.ok(workerLinks[0].payload.taskId === 'tsk_e2e', 'worker.dispatch.linked carries the taskId under the run');

    // A validator exists only because the owner attached one explicitly.
    const types = ledger.readRun(runId).map((e: any) => e.type);
    assert.ok(types.includes('worker.dispatched'), 'worker dispatch marker recorded');
    assert.ok(types.includes('validator.dispatched'), 'manual validator marker recorded');
    assert.equal((runTask as any).calls.length, 1, 'ordinary worker completion never auto-dispatches a validator');

    // SPINE VERDICT: a clean PASS on a gated, green, mergeable PR ⇒ the run is
    // ready to ship and the next action is the release goal (the merge).
    const r = h.kernel.reconcile(runId);
    assert.equal(r.state.worker.outcome, 'DONE');
    assert.equal(r.state.validator.outcome, 'PASS');
    assert.equal(r.decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, 'gated, green, mergeable PASS ⇒ dispatch_release_goal');

    // PROJECTION: the watcher surfaces exactly one ready-to-ship run, nowhere else.
    const panels = h.project();
    assert.equal(panels.readyToShip.length, 1, 'exactly one run ready to ship');
    assert.equal(panels.readyToShip[0].runId, runId);
    assert.equal(panels.needsChief.length, 0);
    assert.equal(panels.brokenAutonomy.length, 0);
    assert.equal(panels.active.length, 0);
  });

  it('LIFECYCLE TO DONE: the read-only gate opens the PR and release merges only after evidence ⇒ done', async () => {
    // Regression for the "stuck in_progress / ready_to_review" bug: the release
    // driver must OPEN the PR when none exists (the policy keeps asking it to),
    // not just merge. Earlier tests hand-injected gate.evaluated, masking that the
    // merge-only release could never produce it. Here NOTHING hand-injects a gate
    // event — the spine must open+gate the PR on its own, then merge to terminal.
    const responses = {
      integrationOpenPr: { result: { prNumber: 42 } },
      integrationGate: {
        result: {
          pr: { number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: false, headRefName: 'feat/e2e', baseRefName: 'main', headSha: HEAD, baseSha: 'b0', checkState: 'success', mergeable: 'MERGEABLE', files: ['docs/a.md'] },
          validation: { self: 'PASS', required: false, headSha: HEAD },
          reviewBot: { name: 'validate', state: 'success' },
        },
      },
      integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged', headSha: HEAD, cleanedUp: true } },
    };
    const prev = process.env.ACE_OWNER_AUTH_TOKEN;
    try {
      // --- WITHOUT a token: the PR still OPENS (safe, no main write) and the run
      //     parks at ready_to_review with a real, reviewable PR. ---
      delete process.env.ACE_OWNER_AUTH_TOKEN;
      const open = composeHarness({ responses });
      open.h.submit({ runId: 'run-open', ts: 1, goal: 'no-code smoke diagnostic', taskType: 'no-code', roleMode: 'no-code', agent: 'codex', scope: { workspaceId: WORKSPACE, allow: ['docs/'] }, acceptance: [{ id: 'A1', text: 'works' }] });
      await open.h.runToQuiescence('run-open');
      deliver(open.h, 'run-open', workerRecord({ outcome: 'DONE', ts: 2 }));
      await open.h.runToQuiescence('run-open');
      assert.equal(open.client.count('integrationOpenPr'), 1, 'the gate opened the PR with NO hand-injected event');
      const openTypes = open.ledger.readRun('run-open').map((e: any) => e.type);
      assert.ok(openTypes.includes('gate.evaluated'), 'the read-only gate emitted current-head evidence');
      assert.ok(!openTypes.includes('validator.dispatched'), 'ordinary release flow creates no validator');
      assert.ok(!openTypes.includes('merged'), 'no token ⇒ no merge (fail-closed), but the PR IS open');
      assert.equal(open.client.count('integrationMergePr'), 0, 'open phase never merges');
      assert.equal(open.h.project().readyToShip.length, 1, 'parks at ready_to_review with an open, reviewable PR');

      // --- WITH a valid token: open phase THEN merge phase ⇒ terminal (done). ---
      process.env.ACE_OWNER_AUTH_TOKEN = 'secret-xyz';
      const done = composeHarness({ responses });
      done.h.submit({ runId: 'run-done', ts: 1, goal: 'no-code smoke diagnostic', taskType: 'no-code', roleMode: 'no-code', agent: 'codex', scope: { workspaceId: WORKSPACE, allow: ['docs/'] }, acceptance: [{ id: 'A1', text: 'works' }], autoChain: { ownerAuthToken: 'secret-xyz' } });
      await done.h.runToQuiescence('run-done');
      deliver(done.h, 'run-done', workerRecord({ outcome: 'DONE', ts: 2 }));
      await done.h.runToQuiescence('run-done'); // opens PR, then merges, then terminal — all driver-driven

      assert.equal(done.client.count('integrationOpenPr'), 1, 'the PR was opened by the read-only gate');
      assert.equal(done.client.count('integrationMergePr'), 1, 'exactly one merge fired with a valid token');
      const doneTypes = done.ledger.readRun('run-done').map((e: any) => e.type);
      assert.ok(doneTypes.includes('gate.evaluated') && doneTypes.includes('merged'), 'the full open→gate→merge chain is on the ledger');
      assert.ok(!doneTypes.includes('validator.dispatched'), 'worker completion never auto-dispatches a validator');
      const r = done.h.kernel.reconcile('run-done');
      assert.equal(r.state.merge.merged, true);
      assert.equal(r.decision.next, NEXT_ACTIONS.NOTHING, 'merged + cleaned up ⇒ terminal');
      const panels = done.h.project();
      assert.equal(panels.recent.length, 1, 'the run reached DONE (recent/terminal)');
      assert.equal(panels.recent[0].runId, 'run-done');
      assert.equal(panels.readyToShip.length, 0, 'no longer parked at ready_to_review');
    } finally {
      if (prev === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
      else process.env.ACE_OWNER_AUTH_TOKEN = prev;
    }
  });

  it('FAIL-CLOSED MERGE: no token parks at ready-to-review; valid token merges exactly once; wrong token never merges', async () => {
    // 1) NO TOKEN — the most safety-critical invariant. ACE_OWNER_AUTH_TOKEN
    //    unset AND no autoChain.ownerAuthToken ⇒ release returns {} ⇒ NO merged
    //    event ⇒ main untouched, run parks at ready-to-ship.
    const prev = process.env.ACE_OWNER_AUTH_TOKEN;
    try {
      delete process.env.ACE_OWNER_AUTH_TOKEN;
      const noToken = await driveToReadyToShip({
        responses: { integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged', headSha: HEAD, cleanedUp: true } } },
      });
      await noToken.h.runToQuiescence(noToken.runId); // attempt the release goal
      assert.equal(noToken.client.count('integrationMergePr'), 0, 'no merge attempted without a token');
      const noTokenTypes = noToken.ledger.readRun(noToken.runId).map((e: any) => e.type);
      assert.ok(!noTokenTypes.includes('merged'), 'NO merged event is appended without an owner token');
      const parked = noToken.h.kernel.reconcile(noToken.runId);
      assert.equal(parked.state.merge.merged, false, 'main untouched — the run is not merged');
      assert.equal(parked.decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, 'run parks at ready-to-review (still wants the release goal)');
      assert.equal(noToken.h.project().readyToShip.length, 1, 'still ready-to-ship, never recent');

      // 2) VALID TOKEN — env secret matches the per-run autoChain token ⇒ exactly
      //    ONE merge fires and the run becomes terminal (merged + cleaned up).
      process.env.ACE_OWNER_AUTH_TOKEN = 'secret-xyz';
      const ok = await driveToReadyToShip({
        ownerAuthToken: 'secret-xyz',
        responses: { integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged', headSha: HEAD, cleanedUp: true } } },
      });
      await ok.h.runToQuiescence(ok.runId);
      assert.equal(ok.client.count('integrationMergePr'), 1, 'exactly one merge fires with a valid owner token');
      const okTypes = ok.ledger.readRun(ok.runId).map((e: any) => e.type);
      assert.ok(okTypes.includes('merged'), 'a merged event is appended on a valid-token release');
      const merged = ok.h.kernel.reconcile(ok.runId);
      assert.equal(merged.state.merge.merged, true);
      assert.equal(merged.state.merge.sha, 'sha_merged');
      assert.equal(merged.decision.next, NEXT_ACTIONS.NOTHING, 'merged + cleaned up ⇒ terminal');
      const okPanels = ok.h.project();
      assert.equal(okPanels.recent.length, 1, 'the merged run surfaces as recent (terminal)');
      assert.equal(okPanels.readyToShip.length, 0);

      // 3) WRONG TOKEN — env secret set but the per-run token does not match ⇒
      //    no merge, run parks (fail-closed on a mismatch, not just an unset env).
      const wrong = await driveToReadyToShip({
        ownerAuthToken: 'WRONG',
        responses: { integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged', headSha: HEAD, cleanedUp: true } } },
      });
      await wrong.h.runToQuiescence(wrong.runId);
      assert.equal(wrong.client.count('integrationMergePr'), 0, 'wrong token ⇒ no merge attempted');
      const wrongTypes = wrong.ledger.readRun(wrong.runId).map((e: any) => e.type);
      assert.ok(!wrongTypes.includes('merged'), 'wrong token ⇒ NO merged event');
      assert.equal(wrong.h.kernel.reconcile(wrong.runId).state.merge.merged, false, 'wrong token ⇒ main untouched');
    } finally {
      if (prev === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
      else process.env.ACE_OWNER_AUTH_TOKEN = prev;
    }
  });

  it('VALIDATION FINDINGS: request-changes resumes the ORIGINAL worker stream — same-stream fixback, no new lane', async () => {
    const { h, runTask, ledger } = composeHarness({
      responses: {
        // The original stream is settled and addressable — the resume seam.
        streamPeekScreen: { result: { state: 'turn-complete', text: '', rawTail: '' } },
      },
    });
    const runId = 'run-fix';

    h.submit({
      runId,
      ts: 1,
      goal: 'Add a flag',
      agent: 'codex',
      scope: { workspaceId: WORKSPACE },
    });
    await h.runToQuiescence(runId); // dispatch worker

    deliver(h, runId, workerRecord({ outcome: 'DONE', ts: 2 }));
    h.kernel.recordEvent({ runId, ts: 3, type: 'validator.dispatched', payload: { source: 'manual-owner-action' } });
    h.kernel.recordEvent({ runId, ts: 4, type: 'validator.dispatch.linked', payload: { taskId: 'tsk_validator', streamId: 'str_validator' } });
    h.kernel.recordEvent({ runId, ts: 5, type: 'validator.completed', payload: { outcome: 'FIXBACK_REQUIRED', validatedHeadSha: HEAD } });
    await h.runToQuiescence(runId); // dispatches the same-stream fixback round

    const fixbackMarkers = ledger.readRun(runId).filter((e: any) => e.type === 'fixback.dispatched').length;
    assert.equal(fixbackMarkers, 1, 'exactly one fixback round dispatched');
    assert.equal((runTask as any).calls.length, 2, 'findings delivered via the dispatch primitive');
    const fixCall = (runTask as any).calls[1];
    assert.equal(fixCall.streamId, 'str_e2e', 'findings resume the ORIGINAL worker stream');
    assert.equal(fixCall.taskId, 'tsk_e2e', 'same task/worktree lineage');
    assert.equal(fixCall.newTask, false, 'no new lane/worktree is created');
    assert.equal(fixCall.kind, 'mission-fixback');
    const links = ledger.readRun(runId).filter((e: any) => e.type === 'worker.dispatch.linked');
    const lastLink = links[links.length - 1];
    assert.equal(lastLink.payload.resumed, true, 'the link records a same-stream resume');
    assert.equal(lastLink.payload.streamId, 'str_e2e');

    const inFlight = h.kernel.reconcile(runId);
    assert.equal(inFlight.decision.next, NEXT_ACTIONS.SYNC_WORKER, 'in-flight round syncs the original stream');

    // The round completes on the SAME stream with a NEW trailer. PRODUCTION-
    // SHAPED: no head SHA on the record — the stale validator findings are
    // superseded by EVENT ORDER (a round closed after the verdict), so the run
    // walks the exact-head review gate instead of re-fixing.
    deliver(h, runId, {
      record: {
        taskId: 'tsk_e2e',
        kind: 'done',
        detail: 'DONE: fixback round 1 — findings fixed',
        streamId: 'str_e2e',
        agent: 'codex',
      },
      ts: 6,
    });
    const after = h.kernel.reconcile(runId);
    assert.equal(after.state.worker.fixbackInFlight, false, 'the completion closes the round');
    assert.equal(after.state.review.roundClosedSinceVerdict, true, 'the round supersedes the verdict by event order');
    assert.notEqual(after.decision.next, NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER, 'stale findings never re-fix a superseded head');
  });

  // CONTRACTUAL REVIEW CLOSURE, end to end for BOTH agent families: the
  // controller requests the ready-head review after PR creation (draft → ready
  // + /codex review, once per head), a failing 2/5 ReviewBot verdict resumes
  // the ORIGINAL worker stream, the fixback's push invalidates the old evidence
  // and re-requests the exact-head review, a 5/5 pass walks to release — and
  // the merge stays owner-gated (no token ⇒ parked, main untouched). One run,
  // one board card, replay-safe.
  for (const agent of ['codex', 'claude']) {
    it(`CONTRACTUAL CLOSURE (${agent}): draft→ready request → 2/5 findings → same-stream fixback → new head → 5/5 → owner-gated park`, async () => {
      const savedToken = process.env.ACE_OWNER_AUTH_TOKEN;
      delete process.env.ACE_OWNER_AUTH_TOKEN; // merges stay owner-gated in this flow
      try {
        const HEAD2 = 'feedbeefcafe22';
        const prBase = {
          number: 9, url: 'https://x/pr/9', state: 'OPEN', headRefName: 'feat/e2e', baseRefName: 'main',
          mergeable: 'MERGEABLE', files: ['src/flag.ts'],
        };
        const gateScript = [
          // 1: fresh PR is a DRAFT at head 1 — ReviewBot skips drafts.
          { result: { pr: { ...prBase, isDraft: true, headSha: HEAD, checkState: 'pending' }, validation: null, reviewBot: null } },
          // 2: re-read after `gh pr ready` — ready at head 1, review pending.
          { result: { pr: { ...prBase, isDraft: false, headSha: HEAD, checkState: 'pending' }, validation: null, reviewBot: null } },
          // 3: ReviewBot verdict lands: 2/5 with Must-fix findings — FAILING.
          {
            result: {
              pr: { ...prBase, isDraft: false, headSha: HEAD, checkState: 'failure' },
              validation: null,
              reviewBot: { name: 'validate', state: 'failure', score: 2, mustFix: ['persist the flag', 'cover the empty list'] },
            },
          },
          // 4: after the same-stream fixback pushed head 2 — review re-running.
          { result: { pr: { ...prBase, isDraft: false, headSha: HEAD2, checkState: 'pending' }, validation: null, reviewBot: null } },
          // 5: exact-head review passes at head 2 (5/5) + native review + clawpatch.
          {
            result: {
              pr: { ...prBase, isDraft: false, headSha: HEAD2, checkState: 'success' },
              validation: { self: 'PASS', headSha: HEAD2 },
              reviewBot: { name: 'validate', state: 'success', score: 5 },
              clawpatch: {
                enforced: true, present: true, status: 'pass', inconclusive: false,
                blockingFindings: [], validatedHeadSha: HEAD2,
              },
            },
          },
        ];
        let gateCalls = 0;
        const { h, client, runTask, ledger } = composeHarness({
          responses: {
            integrationOpenPr: { result: { prNumber: 9 } },
            integrationGate: () => gateScript[Math.min(gateCalls++, gateScript.length - 1)],
            integrationReadyPr: {},
            integrationRequestReview: {},
            streamPeekScreen: { result: { state: 'turn-complete', text: '', rawTail: '' } },
          },
        });
        const runId = `run-closure-${agent}`;

        h.submit({ runId, ts: 1, goal: 'Add a flag', agent, scope: { workspaceId: WORKSPACE } });
        await h.runToQuiescence(runId); // dispatch worker
        assert.equal((runTask as any).calls.length, 1);
        assert.equal((runTask as any).calls[0].agent, agent);

        deliver(h, runId, workerRecord({ outcome: 'DONE', ts: 2, agent }));
        await h.runToQuiescence(runId);

        // A1: the controller marked the draft ready and requested the review
        // for the exact head — and the failing verdict resumed the ORIGINAL
        // stream with no operator forwarding and no new lane.
        assert.equal(client.count('integrationReadyPr'), 1, 'draft PR marked ready by the controller');
        assert.ok(client.count('integrationRequestReview') >= 1, '/codex review requested');
        let requests = ledger.readRun(runId).filter((e: any) => e.type === 'review.requested');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].payload.headSha, HEAD);
        assert.equal(ledger.readRun(runId).filter((e: any) => e.type === 'fixback.dispatched').length, 1, 'one fixback round in flight');
        const fixCall = (runTask as any).calls[1];
        assert.equal(fixCall.streamId, 'str_e2e', `${agent} findings resume the ORIGINAL stream`);
        assert.equal(fixCall.taskId, 'tsk_e2e', 'same task/worktree lineage');
        assert.equal(fixCall.newTask, false, 'no new lane');
        assert.equal(fixCall.agent, agent, 'the original agent family drives its own fixback');
        assert.match(String(fixCall.spec.context), /persist the flag/, 'Must-fix findings ride into the stream');
        assert.equal(h.kernel.reconcile(runId).decision.next, NEXT_ACTIONS.SYNC_WORKER, 'round in flight — sync the stream');

        // The round completes on the SAME stream. PRODUCTION-SHAPED: completion
        // records carry NO head SHA — the controller must detect staleness by
        // event order (round closed since the last gate read) and re-read the
        // gate at the live head, never by a head the record cannot supply.
        deliver(h, runId, {
          record: {
            taskId: 'tsk_e2e', kind: 'done', detail: 'DONE: fixback round 1 — fixed both findings',
            streamId: 'str_e2e', agent,
          },
          ts: 3,
        });
        await h.runToQuiescence(runId);

        // A3: the push invalidated the old evidence — the exact-head review was
        // re-requested for head 2 and the 5/5 pass walked to release.
        requests = ledger.readRun(runId).filter((e: any) => e.type === 'review.requested');
        assert.equal(requests.length, 2, 'each head gets its own review request');
        assert.equal(requests[1].payload.headSha, HEAD2);
        const final = h.kernel.reconcile(runId);
        assert.equal(final.decision.next, NEXT_ACTIONS.DISPATCH_RELEASE_GOAL, 'all exact-head evidence present');
        assert.equal(final.decision.releaseEvidence?.ok, true);
        assert.equal(ledger.readRun(runId).filter((e: any) => e.type === 'fixback.dispatched').length, 1, 'no second round after the pass');

        // Owner gate: the release effect ran and PARKED — no token, no merge.
        assert.equal(client.count('integrationMergePr'), 0, 'merge stays owner-gated — main untouched');
        assert.equal(ledger.readRun(runId).filter((e: any) => e.type === 'merged').length, 0);

        // A4: one run, ONE card — the fixback never minted an extra card.
        const board = projectLeanBoard(ledger);
        const cards = board.cards.filter((c: any) => c.id === runId);
        assert.equal(cards.length, 1, 'same-stream closure adds no extra card');
        assert.equal(board.cards.length, 1, 'the whole ledger holds exactly one card for this run');

        // Replay safety: reconcile is deterministic, and re-delivering a stale
        // duplicate of the ORIGINAL verdict (stable id) changes nothing.
        const again = h.kernel.reconcile(runId);
        assert.deepEqual(again.decision, final.decision, 'reconcile replays to the identical decision');
        const staleEvt = fromCompletion(workerRecord({ outcome: 'DONE', ts: 2, agent }).record, runId);
        const staleDelivery = { ...staleEvt, id: `${runId}:worker.completed:stale-dup`, ts: 2 };
        h.kernel.recordEvent(staleDelivery);
        const dup = h.kernel.recordEvent(staleDelivery);
        assert.equal(dup, null, 'duplicate stale verdict is dropped by the ledger');
        await h.runToQuiescence(runId);
        assert.equal(ledger.readRun(runId).filter((e: any) => e.type === 'fixback.dispatched').length, 1, 'stale duplicate never re-opens the round');
        assert.equal(client.count('integrationMergePr'), 0, 'still no merge');
      } finally {
        if (savedToken === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
        else process.env.ACE_OWNER_AUTH_TOKEN = savedToken;
      }
    });
  }

  it('IDEMPOTENT REPLAY: the SAME completion delivered twice collapses to one event — no duplicate dispatch', async () => {
    const { h, runTask, ledger } = composeHarness();
    const runId = 'run-replay';

    h.submit({ runId, ts: 1, goal: 'Add a flag', agent: 'codex', scope: { workspaceId: WORKSPACE } });
    await h.runToQuiescence(runId); // dispatch worker once
    assert.equal((runTask as any).calls.length, 1, 'worker dispatched once');

    // Build ONE completion event with a STABLE id (mirrors a Ring-2 delivery
    // whose id is derived from the durable record — the same record always maps
    // to the same id). The ledger dedups on id.
    const evt = fromCompletion(workerRecord({ outcome: 'DONE', ts: 2 }).record, runId);
    const completion = { ...evt, id: `${runId}:worker.completed:fixed`, ts: 2 };

    // First delivery is stored; a duplicate (a retried Ring-2 delivery / a
    // restart re-mirroring the inbox) is SKIPPED.
    const first = h.kernel.recordEvent(completion);
    assert.ok(first, 'first completion delivery is stored');
    const dup = h.kernel.recordEvent(completion);
    assert.equal(dup, null, 'duplicate completion delivery is skipped (idempotent)');

    const completions = ledger.readRun(runId).filter((e: any) => e.type === 'worker.completed');
    assert.equal(completions.length, 1, 'exactly one worker.completed stored after a double delivery');

    // Advancing twice (e.g. the observer re-armed the loop on each delivery)
    // must not create a validator. Re-deliver the duplicate between drives to
    // prove the dedup holds under restart-style replay.
    await h.runToQuiescence(runId);
    h.kernel.recordEvent(completion); // duplicate replay again
    await h.runToQuiescence(runId);

    const validatorDispatches = ledger.readRun(runId).filter((e: any) => e.type === 'validator.dispatched').length;
    assert.equal(validatorDispatches, 0, 'no validator was dispatched from either completion delivery');
    assert.equal((runTask as any).calls.length, 1, 'the worker remains the only runTask dispatch');
  });
});
