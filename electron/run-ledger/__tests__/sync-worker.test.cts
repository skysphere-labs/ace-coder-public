// sync-worker — the PULL reconcile that heals a run whose completion PUSH never
// landed. A long-running fire-and-forget spine worker (detached pty-host) that
// finishes after a controller restart loses its in-memory completion turn, so
// the Ring-2 push never mirrors its DONE into the ledger and the run sits forever
// at SYNC_WORKER — board stuck in_progress though the stream shows a DONE
// trailer. The spine `syncWorker` effect must pull the live stream's terminal
// trailer and advance the run. A worker completion never creates a validator;
// when the owner has requested independent validation, the run waits at a gate
// until that validator is attached manually.
//
//   node --test --require tsx/cjs electron/run-ledger/__tests__/sync-worker.test.cts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

let harnessMod: any;
try { harnessMod = require('../harness.cts'); } catch { harnessMod = require('../harness.cjs'); }
const { createRunLedgerHarness } = harnessMod;

let spineEffectsMod: any;
try { spineEffectsMod = require('../spine-effects.cts'); } catch { spineEffectsMod = require('../spine-effects.cjs'); }
const { createSpineEffects } = spineEffectsMod;

let eventLedgerMod: any;
try { eventLedgerMod = require('../event-ledger.cts'); } catch { eventLedgerMod = require('../event-ledger.cjs'); }
const { createMemoryEventLog } = eventLedgerMod;

let orchestrationPolicy: any;
try { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cts'); }
catch { orchestrationPolicy = require('../../../tools/ace/src/orchestration-policy.cjs'); }
const { NEXT_ACTIONS } = orchestrationPolicy;

const WORKSPACE = 'prj_sync';

// A client whose streamPeekScreen returns a controllable per-stream { state, text }
// (exactly the shape ace-control's NON-WAKING peekScreen returns). The pull
// uses streamPeekScreen so it never re-spawns a dormant worker. screens[streamId]
// is mutated between drives to simulate the worker finishing.
function fakeClient(screens: Record<string, any>) {
  return {
    invoke: async (method: string, params: any) => {
      if (method === 'streamPeekScreen') {
        const s = screens[params?.streamId];
        return s || { state: 'unknown', text: '' };
      }
      return {}; // gate/merge unused here
    },
  };
}

// runTask result AFTER spawn+deliver — what the real path returns so the spine
// records *.dispatch.linked (carrying the variant streamId) and returns null.
function fakeRunTask(byCall: any[]) {
  let n = 0;
  const fn = async () => byCall[Math.min(n++, byCall.length - 1)];
  return fn;
}

function compose(screens: Record<string, any>, runTaskResults: any[]) {
  const client = fakeClient(screens);
  const effects = createSpineEffects({ client, runTask: fakeRunTask(runTaskResults), workspaceId: WORKSPACE });
  const ledger = createMemoryEventLog();
  return { h: createRunLedgerHarness({ ledger, effects }), ledger };
}

// Independent validation is requested explicitly. That request must park at the
// gate; it must not be interpreted as permission to create a validator agent.
function submitRun(h: any, runId: string) {
  h.submit({
    runId, ts: 1, goal: 'Add a flag', agent: 'claude',
    scope: { workspaceId: WORKSPACE, allow: ['src/'] },
    acceptance: [{ id: 'A1', text: 'works' }],
    explicitValidationRequired: true, computerUseRequired: true,
  });
}

describe('syncWorker PULL reconcile', () => {
  it('heals a stuck dispatched+linked run: pulls DONE and gates without auto-dispatching a validator', async () => {
    const WSTREAM = 'variant:var-worker';
    const VSTREAM = 'variant:var-validator';
    const screens: Record<string, any> = {
      // The worker is STILL WORKING when first dispatched (no trailer yet).
      [WSTREAM]: { state: 'busy', text: 'working...' },
    };
    const { h, ledger } = compose(screens, [
      { taskId: 'tsk_w', streamId: WSTREAM, worktreeId: 'wt_w', branch: 'feat/x', baseBranch: 'main' },
      { taskId: 'tsk_v', streamId: VSTREAM, worktreeId: 'wt_v', branch: 'feat/x', baseBranch: 'main' },
    ]);
    submitRun(h, 'run-stuck');

    // 1) Dispatch: the worker links and the loop pauses (async, no completion).
    await h.runToQuiescence('run-stuck');
    let board = h.board();
    assert.equal(board.counts.inProgress, 1, 'dispatched+linked worker is in_progress');
    let r = h.kernel.reconcile('run-stuck');
    assert.equal(r.decision.next, NEXT_ACTIONS.SYNC_WORKER, 'reconciler asks to SYNC_WORKER');
    assert.equal(r.state.worker.done, false, 'worker not done yet — push never arrived');

    // 2) Drive again WHILE the worker is still busy: syncWorker pulls, finds no
    //    terminal trailer, appends nothing — the run stays in_progress (no false done).
    await h.runToQuiescence('run-stuck');
    assert.ok(!ledger.readRun('run-stuck').some((e: any) => e.type === 'worker.completed'), 'no completion while the stream is still busy');
    assert.equal(h.board().counts.inProgress, 1, 'still in_progress while working');

    // 3) The worker FINISHES: its stream settles with a DONE trailer (the push
    //    never fired — lost turn). The periodic reconcile drives the run; the
    //    syncWorker PULL reads the live trailer and completes the worker.
    screens[WSTREAM] = { state: 'turn-complete', text: 'all done\nDONE: implemented the flag' };
    await h.runToQuiescence('run-stuck');

    const types = ledger.readRun('run-stuck').map((e: any) => e.type);
    assert.ok(types.includes('worker.completed'), 'syncWorker pulled the DONE trailer into worker.completed');
    r = h.kernel.reconcile('run-stuck');
    assert.equal(r.state.worker.done, true, 'worker is now done');
    assert.equal(r.state.worker.outcome, 'DONE');
    assert.ok(!types.includes('validator.dispatched'), 'worker DONE never creates a validator');
    assert.ok(!types.includes('validator.dispatch.linked'), 'no validator stream is linked automatically');
    assert.equal(r.decision.next, NEXT_ACTIONS.GATE, 'manual validation request waits at the gate');
    assert.match(r.decision.reason, /manual independent validation.*owner-attached evidence/i);
    assert.notEqual(r.decision.next, NEXT_ACTIONS.NOTHING, 'never terminal (done) off the worker DONE alone');
    assert.ok(!types.includes('merged'), 'never merged before manual validation evidence');
  });

  it('also PULLS the validator verdict when the SYNC is for an in-flight validator', async () => {
    const WSTREAM = 'variant:vw2';
    const VSTREAM = 'variant:vv2';
    const screens: Record<string, any> = {
      [WSTREAM]: { state: 'turn-complete', text: 'DONE: built it' },
      // Validator still deliberating at first; then returns a PASS verdict trailer.
      [VSTREAM]: { state: 'busy', text: 'reviewing...' },
    };
    const { h, ledger } = compose(screens, [
      { taskId: 'tsk_w2', streamId: WSTREAM, branch: 'feat/y', baseBranch: 'main' },
      { taskId: 'tsk_v2', streamId: VSTREAM, branch: 'feat/y', baseBranch: 'main' },
    ]);
    submitRun(h, 'run-val');

    await h.runToQuiescence('run-val'); // dispatch worker
    await h.runToQuiescence('run-val'); // pull worker DONE → gate for manual validation
    assert.ok(!ledger.readRun('run-val').some((e: any) => e.type === 'validator.dispatched'), 'worker completion did not dispatch a validator');

    // The owner explicitly attaches an independent validator to the existing
    // run. Once linked, the ordinary SYNC_WORKER effect may poll its stream.
    h.kernel.recordEvent({ runId: 'run-val', ts: 3, type: 'validator.dispatched', payload: { source: 'manual-owner-action' } });
    h.kernel.recordEvent({ runId: 'run-val', ts: 4, type: 'validator.dispatch.linked', payload: { taskId: 'tsk_v2', streamId: VSTREAM } });
    assert.ok(!ledger.readRun('run-val').some((e: any) => e.type === 'validator.completed'), 'no verdict while validator busy');

    // Validator finishes with a real PASS verdict trailer on its stream.
    screens[VSTREAM] = { state: 'turn-complete', text: 'DONE: VERDICT=PASS on https://github.com/x/y/pull/1 {"verdict":"pass","scorecard":[{"id":"A1","met":true}]}' };
    await h.runToQuiescence('run-val');

    const r = h.kernel.reconcile('run-val');
    assert.ok(ledger.readRun('run-val').some((e: any) => e.type === 'validator.completed'), 'syncWorker pulled the validator verdict into validator.completed');
    assert.equal(r.state.validator.done, true, 'validator now done');
    assert.equal(r.state.validator.outcome, 'PASS', 'verdict folded from the pulled trailer');
  });

  it('heals a TUI-repainted stream: trailer absent from the rendered text, present in the raw ring tail', async () => {
    const WSTREAM = 'variant:var-tui';
    const ESC = '\u001b';
    const screens: Record<string, any> = {
      [WSTREAM]: {
        state: 'turn-complete',
        // The rendered scrollback is repaint garbage — no parseable trailer
        // (exactly what a claude-code screen flattens to after the repaint).
        text: 't’Two-notes:nthenconfigured\n✻ Cooked for 27m 45s · 1 turn · 71.9k tokens\n────────\n⏵⏵ bypass permissions on (shift+tab to cycle)',
        // The ANSI-stripped raw ring still carries the DONE + chrome.
        rawTail: [
          'final summary of the work',
          `${ESC}[32mDONE: repainted worker finished — evidence recorded${ESC}[0m`,
          '╭──────╮',
          '│ >    │',
          '╰──────╯',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n'),
      },
    };
    const { h, ledger } = compose(screens, [
      { taskId: 'tsk_tui', streamId: WSTREAM, branch: 'feat/z', baseBranch: 'main' },
      { taskId: 'tsk_tui_v', streamId: 'variant:var-tui-v', branch: 'feat/z', baseBranch: 'main' },
    ]);
    submitRun(h, 'run-tui');

    await h.runToQuiescence('run-tui'); // dispatch links the worker
    await h.runToQuiescence('run-tui'); // pull heals from the raw ring tail

    const completed = ledger.readRun('run-tui').find((e: any) => e.type === 'worker.completed');
    assert.ok(completed, 'raw-ring fallback pulled the completion');
    assert.equal(completed.payload.detail, 'repainted worker finished — evidence recorded');
    const r = h.kernel.reconcile('run-tui');
    assert.equal(r.state.worker.done, true);
    assert.equal(r.state.worker.outcome, 'DONE');
    // Pull completions carry descriptive auto-telemetry so pull-healed runs
    // stop being telemetry-null on the board.
    assert.ok(completed.payload.telemetry, 'pull completion carries auto-telemetry');
    assert.equal(completed.payload.telemetry.notes, 'auto-collected:spine-sync');
  });

  it('does NOT complete from a prompt-echo trailer the peek flags via echoTrailerKeys', async () => {
    const WSTREAM = 'variant:var-echo-pull';
    const screens: Record<string, any> = {
      [WSTREAM]: {
        state: 'turn-complete',
        text: 'BLOCKED: fake prompt example',
        rawTail: 'BLOCKED: fake prompt example',
        echoTrailerKeys: ['blocked fake prompt example'],
      },
    };
    const { h, ledger } = compose(screens, [
      { taskId: 'tsk_echo', streamId: WSTREAM, branch: 'feat/e', baseBranch: 'main' },
    ]);
    submitRun(h, 'run-echo');
    await h.runToQuiescence('run-echo');
    await h.runToQuiescence('run-echo');
    assert.ok(
      !ledger.readRun('run-echo').some((e: any) => e.type === 'worker.completed'),
      'echoed prompt trailer never completes the run'
    );

    // The worker's REAL trailer still completes.
    screens[WSTREAM] = {
      state: 'turn-complete',
      text: 'DONE: genuinely finished',
      rawTail: 'DONE: genuinely finished',
      echoTrailerKeys: ['blocked fake prompt example'],
    };
    await h.runToQuiescence('run-echo');
    const completed = ledger.readRun('run-echo').find((e: any) => e.type === 'worker.completed');
    assert.ok(completed);
    assert.equal(completed.payload.detail, 'genuinely finished');
  });

  it('does NOT fabricate a completion when neither the rendered text nor the raw tail holds a terminal trailer', async () => {
    const WSTREAM = 'variant:var-tui-none';
    const screens: Record<string, any> = {
      [WSTREAM]: {
        state: 'turn-complete',
        text: '✻ Cooked for 3m · 1 turn · 9k tokens\n⏵⏵ bypass permissions on (shift+tab to cycle)',
        rawTail: 'mid-turn narration mentioning that we are not DONE yet\nmore substantive output',
      },
    };
    const { h, ledger } = compose(screens, [
      { taskId: 'tsk_none', streamId: WSTREAM, branch: 'feat/n', baseBranch: 'main' },
    ]);
    submitRun(h, 'run-none');

    await h.runToQuiescence('run-none');
    await h.runToQuiescence('run-none');

    assert.ok(
      !ledger.readRun('run-none').some((e: any) => e.type === 'worker.completed'),
      'no trailer anywhere ⇒ no completion'
    );
  });
});
