// spine-effects.test — proves the Ring-1 EFFECTS drive the real limbs correctly:
// the worker/validator dispatch goes through the PROVEN fire-and-forget spawn
// (runTask, injected here) carrying the STRUCTURED spec; the validator is ALWAYS
// codex on the computer-use skill; gatePr returns live FACTS; release is a
// FAIL-CLOSED owner-token merge. Recording mocks — no electron, no real agents.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let spineEffectsModule: any;
try { spineEffectsModule = require('../spine-effects.cjs'); } catch { spineEffectsModule = require('../spine-effects.cts'); }
const { createSpineEffects } = spineEffectsModule;

let eventLedgerModule: any;
try { eventLedgerModule = require('../event-ledger.cjs'); } catch { eventLedgerModule = require('../event-ledger.cts'); }
const { createMemoryEventLog } = eventLedgerModule;

let kernelModule: any;
try { kernelModule = require('../kernel.cjs'); } catch { kernelModule = require('../kernel.cts'); }
const { createKernel } = kernelModule;

let reconcilerModule: any;
try { reconcilerModule = require('../reconciler.cjs'); } catch { reconcilerModule = require('../reconciler.cts'); }
const { reconcile } = reconcilerModule;

let promptModule: any;
try { promptModule = require('../../../tools/ace/src/prompt.cjs'); } catch { promptModule = require('../../../tools/ace/src/prompt.cts'); }
const { buildTaskPromptEnvelope } = promptModule;

const RELEASE_DECISION = { releaseEvidence: { ok: true } };

// Mock in-process client (for gate/release, which call integration* methods).
function recorder(responses: any = {}) {
  const calls: any[] = [];
  return {
    calls,
    find: (method: string) => calls.find((c) => c.method === method),
    count: (method: string) => calls.filter((c) => c.method === method).length,
    invoke: async (method: string, params: any) => {
      calls.push({ method, params });
      const r = responses[method];
      return typeof r === 'function' ? r(params) : (r === undefined ? {} : r);
    },
  };
}

// Mock the proven spawn+deliver: records the opts it was dispatched with.
function runTaskRecorder(result?: any) {
  const calls: any[] = [];
  const fn = async (_client: any, opts: any) => {
    calls.push(opts);
    const out = result || { taskId: 'tsk_x', streamId: 'str_x', worktreeId: 'wt_x', branch: 'feat/x', baseBranch: 'main' };
    if (typeof opts.onStreamCreated === 'function') await opts.onStreamCreated(out);
    return out;
  };
  (fn as any).calls = calls;
  return fn;
}

test('dispatchWorker spawns via the PROVEN fire-and-forget path with the STRUCTURED spec, linked to the run', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = {
    goal: 'Add a --version flag to the CLI',
    agent: 'codex',
    scope: { workspaceId: 'prj_1', allow: ['src/'] },
    context: 'Hermes intake brief: ship a version flag.',
    constraints: ['stay surgical — touch only the flag parser'],
    acceptance: [{ id: 'A1', text: 'ace --version prints the version' }],
  };
  const ret = await fx.dispatchWorker({ runId: 'run-1', state: { spec }, ledger });
  assert.equal(ret, null, 'async dispatch returns null (Ring-2 completes it later)');

  // The brain dump reaches the agent as a STRUCTURED spec via the proven path.
  assert.equal((runTask as any).calls.length, 1);
  const opts = (runTask as any).calls[0];
  assert.equal(opts.agent, 'codex');
  assert.equal(opts.workspaceId, 'prj_1');
  assert.equal(opts.label, 'Add a --version flag to the CLI');
  assert.equal(opts.fireAndForget, true, 'fire-and-forget so Ring 2 observes completion');
  assert.equal(opts.spec.goal, 'Add a --version flag to the CLI');
  assert.equal(opts.spec.context, 'Hermes intake brief: ship a version flag.');
  assert.deepEqual(opts.spec.constraints, ['stay surgical — touch only the flag parser']);
  // acceptance rows are coerced to non-empty strings (runTask's parseSpec contract)
  assert.deepEqual(opts.spec.acceptance, ['ace --version prints the version']);

  // Linked to THIS run (the synapse: completion closes run-1, not a phantom).
  const links = ledger.readRun('run-1').filter((e: any) => e.type === 'worker.dispatch.linked');
  assert.equal(links.length, 1, 'onStreamCreated and runTask return write one idempotent link');
  const linked = links[0];
  assert.ok(linked && linked.payload.taskId === 'tsk_x', 'worker.dispatch.linked carries the taskId under run-1');
});

test('dispatchWorker gives a bounded generic structured run an audited prompt-budget reason while direct prompts stay fail-closed', async () => {
  const ledger = createMemoryEventLog();
  let dispatched: any;
  let envelope: any;
  const runTask = async (_client: any, opts: any) => {
    dispatched = opts;
    envelope = buildTaskPromptEnvelope(opts.spec, { driver: opts.agent });
    const out = { taskId: 'tsk_budget', streamId: 'str_budget', worktreeId: 'wt_budget', branch: 'fix/budget', baseBranch: 'main' };
    if (typeof opts.onStreamCreated === 'function') await opts.onStreamCreated(out);
    return out;
  };
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = {
    goal: 'Repair generic run-ledger prompt-budget propagation on origin/main.',
    agent: 'codex',
    scope: {
      workspaceId: 'prj_1',
      allow: ['electron/run-ledger/spine-effects.cts', 'electron/run-ledger/__tests__/spine-effects.test.cts'],
    },
    context: 'Verified root shape: electron/run-ledger/spine-effects.cts runSpecFor forwards promptBudgetOverrideReason only when the submitted run intent supplied one. The specialized Skysphere bridge now supplies a bounded audited reason, but a generic structured ace run submit path can render above the 2200 implementer cap and fail as worker.dispatch.failed. Fix the generic spine path narrowly: do not globally disable or weaken role-aware prompt fences, preserve explicit caller reasons, and keep oversized untrusted/direct task prompts fail-closed. Prefer a bounded and auditable spine-owned solution proven by tests.',
    constraints: [
      'Only edit electron/run-ledger/spine-effects.cts and electron/run-ledger/__tests__/spine-effects.test.cts; if the root cause truly requires a broader prompt-library change, stop and report before widening scope.',
      'Do not merge, deploy, relaunch, or handle credentials.',
    ],
    acceptance: [
      'A representative generic structured run intent that previously exceeded the implementer cap reaches worker dispatch without worker.dispatch.failed solely for a missing override reason.',
      'Direct non-spine prompt limits remain enforced, explicit promptBudgetOverrideReason is preserved, and any new default is bounded and auditable rather than an unconditional unlimited bypass.',
      'Focused spine tests, npm run test:spine, and npm run typecheck:spine pass.',
    ],
  };

  await fx.dispatchWorker({ runId: 'run-budget', state: { spec }, ledger });

  assert.ok(
    envelope.telemetry.renderedPromptChars > envelope.telemetry.promptBudgetHardChars,
    'fixture exercises the real implementer hard cap',
  );
  const directSpec = { ...dispatched.spec };
  delete directSpec.promptBudgetOverrideReason;
  assert.throws(
    () => buildTaskPromptEnvelope(directSpec, { driver: 'codex' }),
    /exceeds 2200 hard cap for role 'implementer'/,
    'the same non-spine prompt still fails without an explicit reason',
  );
  assert.equal(
    dispatched.spec.promptBudgetOverrideReason,
    `run-ledger spine bounded structured spec (${JSON.stringify(directSpec).length}/2200 chars)`,
    'the spine-owned exception records both the measured size and its bound',
  );
});

test('dispatchWorker does not auto-override a structured spec above the spine bound', async () => {
  const ledger = createMemoryEventLog();
  const calls: any[] = [];
  const runTask = async (_client: any, opts: any) => {
    calls.push(opts);
    buildTaskPromptEnvelope(opts.spec, { driver: opts.agent });
    return { taskId: 'tsk_large', streamId: 'str_large' };
  };
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = {
    goal: 'Reject an oversized generic structured run',
    agent: 'codex',
    scope: { workspaceId: 'prj_1' },
    context: 'x'.repeat(2200),
  };

  await assert.rejects(
    () => fx.dispatchWorker({ runId: 'run-large', state: { spec }, ledger }),
    /exceeds 2200 hard cap for role 'implementer'/,
  );
  assert.equal(calls[0].spec.promptBudgetOverrideReason, undefined);
});

test('partial-created dispatch timeout stays linked and does not dispatch a duplicate on reconcile', async () => {
  const ledger = createMemoryEventLog();
  const runTask = async (_client: any, opts: any) => {
    (runTask as any).calls.push(opts);
    await opts.onStreamCreated({
      taskId: 'tsk_timeout',
      streamId: 'conversation:timeout',
      worktreeId: 'wt_timeout',
      worktreePath: '/tmp/wt-timeout',
      branch: 'fix/timeout',
      baseBranch: 'main',
    });
    throw new Error('wait timed out after 30000ms (state=busy)');
  };
  (runTask as any).calls = [];
  let syncCalls = 0;
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const k = createKernel({
    ledger,
    drivers: {
      dispatchWorker: fx.dispatchWorker,
      syncWorker: async () => { syncCalls += 1; return null; },
    },
  });
  const runId = k.submitIntent({ goal: 'Fix the run-ledger duplicate dispatch bug', agent: 'codex', scope: { workspaceId: 'prj_1' } });

  const dispatched = await k.runStep(runId);
  assert.equal(dispatched.ran, 'dispatchWorker');
  assert.equal(dispatched.ok, true, 'a post-link timeout is non-terminal');
  assert.match(String(dispatched.warning), /wait timed out after 30000ms/);

  const events = ledger.readRun(runId);
  const links = events.filter((e: any) => e.type === 'worker.dispatch.linked');
  assert.equal(links.length, 1, 'exactly one worker.dispatch.linked event is recorded');
  assert.equal(links[0].payload.taskId, 'tsk_timeout');
  assert.equal(links[0].payload.streamId, 'conversation:timeout');
  assert.equal(links[0].payload.worktreePath, '/tmp/wt-timeout');
  assert.equal(events.some((e: any) => e.type === 'worker.dispatch.failed'), false, 'no terminal dispatch failure is written after link proof');

  const next = k.reconcile(runId).decision;
  assert.equal(next.next, 'sync_worker', 'linked timeout remains in-progress for sync, not blocked/re-dispatched');
  const reconciled = await k.runStep(runId);
  assert.equal(reconciled.ran, 'syncWorker');
  assert.equal(syncCalls, 1);
  assert.equal((runTask as any).calls.length, 1, 'next reconcile does not spawn a second worker');
});

test('dispatchWorker uses concise labels and ignores generic agent labels', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  await fx.dispatchWorker({ runId: 'run-1', state: { spec: {
    label: 'codex',
    goal: '/goal Fix Hermes Teams mobile stream labels. Done when: focused tests pass.',
    agent: 'codex',
    scope: { workspaceId: 'prj_1' },
  } }, ledger });
  assert.equal((runTask as any).calls[0].label, 'Fix Hermes Teams mobile stream labels');

  await fx.dispatchWorker({ runId: 'run-2', state: { spec: {
    label: 'owner-label-feat',
    goal: '/goal Read and execute /tmp/noisy.md. This goal should not win.',
    agent: 'codex',
    scope: { workspaceId: 'prj_1' },
  } }, ledger });
  assert.equal((runTask as any).calls[1].label, 'owner-label-feat');
});

test('dispatchWorker FAILS CLOSED when the spawn did not create a linked stream/task', async () => {
  const ledger = createMemoryEventLog();
  // runTask returns a stream but NO task (a partial/empty spawn) — not a real,
  // gate-able dispatch. dispatchOne must throw so the kernel records
  // worker.dispatch.failed instead of leaving a phantom "dispatched" run.
  const runTask = runTaskRecorder({ streamId: 'str_x' }); // taskId intentionally missing
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' } };
  await assert.rejects(
    () => fx.dispatchWorker({ runId: 'run-1', state: { spec }, ledger }),
    /dispatch did not create a linked stream\/task/,
    'a partial spawn (no taskId) throws so the kernel can fail the run closed',
  );
  // Never record a phantom link when the dispatch did not actually land.
  assert.equal(
    ledger.readRun('run-1').find((e: any) => e.type === 'worker.dispatch.linked'),
    undefined,
    'no worker.dispatch.linked is written for a failed spawn',
  );
});

test('dispatchWorker carries explicit tool/browser/capability opt-ins through to the worker spec', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  // The operator explicitly opted into elevated capabilities. The spine must not
  // silently downgrade them — route resolution defaults a MISSING mode to 'off'.
  const spec = {
    goal: 'Validate the app with computer use',
    agent: 'codex',
    scope: { workspaceId: 'prj_1' },
    toolMode: 'on',
    browserMode: 'on',
    mcpMode: 'on',
    codexRuntimeProfile: 'app-parity',
    toolOverrideReason: 'operator requested computer-use validation',
    capabilities: ['browser', 'computer-use', 'runtime'],
  };
  await fx.dispatchWorker({ runId: 'run-1', state: { spec }, ledger });
  const opts = (runTask as any).calls[0];
  assert.equal(opts.spec.toolMode, 'on');
  assert.equal(opts.spec.browserMode, 'on');
  assert.equal(opts.spec.mcpMode, 'on');
  assert.equal(opts.spec.codexRuntimeProfile, 'app-parity');
  assert.equal(opts.spec.toolOverrideReason, 'operator requested computer-use validation');
  assert.deepEqual(opts.spec.capabilities, ['browser', 'computer-use', 'runtime']);
});

test('dispatchWorker carries explicit effort override reasons through to the nested worker spec', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = {
    goal: 'Run a Claude max-effort worker',
    agent: 'claude',
    scope: { workspaceId: 'prj_1' },
    effort: 'max',
    effortOverrideReason: 'Chief explicitly requested Claude ultracode/max effort.',
    promptBudgetOverrideReason: 'The compact spec points to external sidecar artifacts.',
  };
  await fx.dispatchWorker({ runId: 'run-1', state: { spec }, ledger });
  const opts = (runTask as any).calls[0];
  assert.equal(opts.spec.effort, 'max');
  assert.equal(opts.spec.effortOverrideReason, 'Chief explicitly requested Claude ultracode/max effort.');
  assert.equal(opts.spec.promptBudgetOverrideReason, 'The compact spec points to external sidecar artifacts.');
});

test('spine policy: Claude workers spawn xhigh + UltraCode + goal-mode; Codex workers spawn xhigh (never fast)', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  // Claude worker → xhigh reasoning AND the /effort ultracode prelude (ultraCode).
  await fx.dispatchWorker({ runId: 'run-c', state: { spec: { goal: 'Build a landing page', agent: 'claude', scope: { workspaceId: 'prj_1' } } }, ledger });
  const claudeOpts = (runTask as any).calls[0];
  assert.equal(claudeOpts.spec.effort, 'xhigh');
  assert.equal(claudeOpts.spec.ultraCode, true, 'Claude worker is marked for UltraCode (/effort ultracode)');
  assert.equal(claudeOpts.goalMode, 'on', 'every spine worker spawns in goal-mode');
  // Codex worker → xhigh (never fast), no ultracode prelude.
  await fx.dispatchWorker({ runId: 'run-x', state: { spec: { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' } } }, ledger });
  const codexOpts = (runTask as any).calls[1];
  assert.equal(codexOpts.spec.effort, 'xhigh', 'Codex worker is xhigh, never fast');
  assert.notEqual(codexOpts.spec.ultraCode, true, 'Codex has no ultracode prelude');
});

test('worker.dispatch.linked payload carries the launch-mode facts (xhigh + ultraCode + goal-mode) as durable telemetry', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  await fx.dispatchWorker({
    runId: 'run-proof',
    state: { spec: { goal: 'Ship the feature', agent: 'claude', scope: { workspaceId: 'prj_1' } } },
    ledger,
  });
  const linked = ledger
    .readRun('run-proof')
    .find((e: any) => e.type === 'worker.dispatch.linked');
  assert.ok(linked, 'dispatch link recorded');
  // One `run submit` is provably sufficient: the ledger itself records the
  // launch mode, so no manager follow-up (/effort, /goal) is ever required.
  assert.equal(linked.payload.effort, 'xhigh');
  assert.equal(linked.payload.ultraCode, true);
  assert.equal(linked.payload.goalMode, 'on');
  // Task/stream/worktree visibility rides the same event.
  assert.equal(linked.payload.taskId, 'tsk_x');
  assert.equal(linked.payload.streamId, 'str_x');
  assert.equal(linked.payload.worktreeId, 'wt_x');
  assert.equal(linked.payload.branch, 'feat/x');
});

test('runValidation ALWAYS dispatches a CODEX validator driving the computer-use skill', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder({ taskId: 'tsk_v', streamId: 'str_v' });
  const fx = createSpineEffects({ client: recorder({}), runTask });
  // The worker was CLAUDE — the validator must still be codex (owner rule).
  const spec = { goal: 'Add a flag', agent: 'claude', scope: { workspaceId: 'prj_1' } };
  await fx.runValidation({ runId: 'run-1', state: { spec }, ledger });

  const opts = (runTask as any).calls[0];
  assert.equal(opts.agent, 'codex', 'validator is codex even when the worker was claude');
  assert.equal(opts.spec.taskType, 'validator');
  assert.ok((opts.spec.baselineSkills || []).includes('ace-computer-use-validator'), 'computer-use validator skill loaded');
  assert.equal(opts.spec.codexRuntimeProfile, 'app-parity');
  assert.equal(opts.spec.toolMode, 'on');
  assert.equal(opts.spec.mcpMode, 'global');
  assert.equal(opts.spec.browserMode, 'on');
  assert.ok((opts.spec.capabilities || []).includes('computer-use'));
  assert.match(String(opts.spec.goal), /^Validate \(computer-use\): /);
  assert.ok(ledger.readRun('run-1').find((e: any) => e.type === 'validator.dispatch.linked'), 'validator dispatch linked');
  // Owner doctrine: the validator lane is pinned to gpt-5.6-sol at HIGH
  // reasoning. Lowering below the codex xhigh default requires the
  // effortOverrideReason (agent-catalog contract); raising would not.
  assert.equal(opts.spec.codexModel, 'gpt-5.6-sol', 'validator model pinned to gpt-5.6-sol');
  assert.equal(opts.spec.effort, 'high', 'validator effort pinned to high');
  assert.match(String(opts.spec.effortOverrideReason), /validator lanes run gpt-5\.6-sol at high reasoning/);
});

test('runValidation honors the ACE_VALIDATOR_CODEX_MODEL escape hatch; workers carry NO model pin', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder();
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' } };
  const prev = process.env.ACE_VALIDATOR_CODEX_MODEL;
  try {
    process.env.ACE_VALIDATOR_CODEX_MODEL = 'gpt-5.7-alt';
    await fx.runValidation({ runId: 'run-1', state: { spec }, ledger });
    assert.equal((runTask as any).calls[0].spec.codexModel, 'gpt-5.7-alt', 'env escape hatch overrides the pin');
  } finally {
    if (prev === undefined) delete process.env.ACE_VALIDATOR_CODEX_MODEL;
    else process.env.ACE_VALIDATOR_CODEX_MODEL = prev;
  }
  // The WORKER lane is untouched: no model pin rides an ordinary dispatch.
  await fx.dispatchWorker({ runId: 'run-2', state: { spec }, ledger });
  assert.equal((runTask as any).calls[1].spec.codexModel, undefined, 'workers keep the user-config model');
  assert.equal((runTask as any).calls[1].spec.effort, 'xhigh', 'workers stay xhigh');
});

test('dispatchFixback with NO worker lineage FAILS CLOSED — a replacement lane is never spawned', async () => {
  const ledger = createMemoryEventLog();
  const runTask = runTaskRecorder({ taskId: 'tsk_fix', streamId: 'str_fix' });
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' } };
  await assert.rejects(
    () => fx.dispatchFixback({ runId: 'run-1', state: { spec }, ledger }),
    /no linked worker lineage/,
  );
  assert.equal((runTask as any).calls.length, 0, 'no dispatch of any kind happened');
  assert.equal(ledger.readRun('run-1').filter((e: any) => e.type === 'worker.dispatch.linked').length, 0);
});

test('dispatchFixback authors the failure evidence: validator findings + failing CI + review-bot Must-fix, repairing the SAME branch', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({
    runId: 'run-1',
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_w', streamId: 'str_w', branch: 'feat/flag' },
  });
  ledger.append({
    runId: 'run-1',
    type: 'validator.completed',
    payload: { record: { detail: 'VERDICT=request-changes {"verdict":"request-changes","findings":["the flag is not persisted"]}' } },
  });
  const runTask = runTaskRecorder({ taskId: 'tsk_fix', streamId: 'str_fix' });
  const fx = createSpineEffects({ client: recorder({}), runTask });
  const spec = { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' }, context: 'original brief' };
  const state = {
    spec,
    pr: {
      exists: true,
      number: 7,
      checkState: 'failure',
      reviewBot: { name: 'validate', state: 'failure', score: 2, mustFix: ['handle the empty list'] },
    },
  };
  await fx.dispatchFixback({ runId: 'run-1', state, ledger });
  const opts = (runTask as any).calls[0];
  // Same-lane repair: the fixback reattaches the ORIGINAL task (worktree +
  // branch travel with the task), never a replacement lane.
  assert.equal(opts.taskId, 'tsk_w', 'fixback reattaches the original task');
  assert.equal(opts.newTask, false, 'no new lane/worktree is created');
  assert.equal(opts.kind, 'mission-fixback');
  assert.match(String(opts.spec.goal), /^Fixback round 1\/3/, 'the round is named in the goal');
  assert.match(String(opts.spec.context), /SAME worker/, 'the fixer is told it is the original worker');
  // The evidence directives ride the context so the fixer attacks what failed.
  assert.match(String(opts.spec.context), /the flag is not persisted/, 'validator findings inlined');
  assert.match(String(opts.spec.context), /CI is FAILING on PR #7/);
  assert.match(String(opts.spec.context), /gh run view --log-failed/);
  assert.match(String(opts.spec.context), /review-bot check 'validate' is FAILING/);
  assert.match(String(opts.spec.context), /handle the empty list/, 'review-bot Must-fix findings inlined');
});

test('dispatchFixback resumes the ORIGINAL stream when it is settled; respawns the same task when it is gone', async () => {
  // Settled stream → the round is delivered INTO the original conversation.
  const ledger = createMemoryEventLog();
  ledger.append({
    runId: 'run-1',
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_w', streamId: 'str_w', branch: 'feat/flag', agent: 'claude' },
  });
  const alive = recorder({ streamPeekScreen: { result: { state: 'awaiting-input', text: '', rawTail: '' } } });
  const runTask = runTaskRecorder({ taskId: 'tsk_w', streamId: 'str_w' });
  const fx = createSpineEffects({ client: alive, runTask });
  const spec = { goal: 'Add a flag', agent: 'claude', scope: { workspaceId: 'prj_1' } };
  await fx.dispatchFixback({ runId: 'run-1', state: { spec, pr: { exists: true, number: 7 }, fixback: { attempts: 0 } }, ledger });
  const opts = (runTask as any).calls[0];
  assert.equal(opts.streamId, 'str_w', 'findings resume the ORIGINAL stream');
  assert.equal(opts.taskId, 'tsk_w');
  assert.equal(opts.agent, 'claude', 'the original agent family drives its own fixback');
  const links = ledger.readRun('run-1').filter((e: any) => e.type === 'worker.dispatch.linked');
  assert.equal(links[links.length - 1].payload.resumed, true, 'the link records a same-stream resume');

  // Dead/unknown stream → same TASK respawn (worktree/branch travel with it).
  const ledger2 = createMemoryEventLog();
  ledger2.append({
    runId: 'run-2',
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_w2', streamId: 'str_gone', branch: 'feat/flag' },
  });
  const dead = recorder({ streamPeekScreen: () => { throw new Error('no such stream'); } });
  const runTask2 = runTaskRecorder({ taskId: 'tsk_w2', streamId: 'str_new' });
  const fx2 = createSpineEffects({ client: dead, runTask: runTask2 });
  await fx2.dispatchFixback({ runId: 'run-2', state: { spec, pr: { exists: true }, fixback: { attempts: 1 } }, ledger: ledger2 });
  const opts2 = (runTask2 as any).calls[0];
  assert.equal(opts2.streamId, undefined, 'gone stream is not addressed');
  assert.equal(opts2.taskId, 'tsk_w2', 'respawn lands on the SAME task/worktree');
  assert.equal(opts2.newTask, false);
  assert.match(String(opts2.spec.goal), /^Fixback round 2\/3/, 'round counts prior attempts');
});

test('gatePr ensures a PR then returns LIVE facts mapped to the exact GATE_EVALUATED field names', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: {
      result: {
        status: 'PASS',
        pr: { number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: false, headRefName: 'feat/x', baseRefName: 'main', headSha: 'abc123def', baseSha: 'base123', checkState: 'success', mergeable: 'MERGEABLE', files: ['src/a.ts'] },
        validation: { self: 'PASS', required: false, headSha: 'validated-old' },
        reviewBot: { name: 'validate', state: 'failure', score: 2, mustFix: ['fix the crash'] },
        gate: {
          clawpatch: {
            enforced: true,
            present: true,
            status: 'pass',
            inconclusive: false,
            blockingFindings: [],
            validatedHeadSha: 'clawpatch-head',
          },
        },
      },
    },
  });
  const fx = createSpineEffects({ client });
  const facts = await fx.gatePr({
    runId: 'run-1',
    state: { spec: { scope: { allow: ['src/'] } } },
    decision: { clawpatchRequired: true },
    ledger,
  });

  assert.equal(facts.prExists, true);
  assert.equal(facts.prNumber, 42);
  assert.equal(facts.mergeable, 'MERGEABLE');
  assert.equal(facts.checkState, 'success');
  assert.equal(facts.headSha, 'abc123def');
  assert.equal(facts.prUrl, 'https://x/pr/42');
  assert.deepEqual(facts.changedFiles, ['src/a.ts']);
  assert.deepEqual(facts.reviewBot, { name: 'validate', state: 'failure', score: 2, mustFix: ['fix the crash'], headSha: 'abc123def' }, 'the review-bot check is pinned to the gate head');
  assert.equal(facts.validation.headSha, 'validated-old', 'native-review evidence keeps its actual validated head');
  assert.equal(facts.clawpatch.status, 'pass');
  assert.equal(facts.clawpatch.validatedHeadSha, 'clawpatch-head');
  assert.equal(facts.clawpatch.headSha, undefined, 'the live PR head is not fabricated onto Clawpatch evidence');
  assert.equal(client.find('integrationGate').params.clawpatchEnforced, true);
  assert.ok(client.find('integrationOpenPr'), 'a PR is ensured (idempotent open) before gating');
});

test('gatePr verifies the worker computer-use artifact against the live PR head', async () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-spine-computer-use-'));
  try {
    const evidenceDir = path.join(worktreePath, '.ace', 'computer-use');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'completion.json'), JSON.stringify({
      schema: 'ace.computer_use_behavioral_validation.v1',
      validatedHeadSha: 'abc123def',
      passed: true,
      screenshots: ['evidence/browser.png'],
      checkedAcceptance: [{ id: 'A1', status: 'pass', evidence: 'evidence/browser.png' }],
    }));
    const ledger = createMemoryEventLog();
    ledger.append({
      runId: 'run-ui',
      type: 'worker.dispatch.linked',
      payload: { taskId: 'tsk_ui', worktreePath },
    });
    const client = recorder({
      integrationOpenPr: { result: { prNumber: 42 } },
      integrationGate: {
        result: {
          pr: { number: 42, headSha: 'abc123def', checkState: 'success', mergeable: 'MERGEABLE' },
          validation: { self: 'PASS', headSha: 'abc123def' },
          reviewBot: { name: 'validate', state: 'success' },
        },
      },
    });
    const fx = createSpineEffects({ client });
    const facts = await fx.gatePr({
      runId: 'run-ui',
      state: { spec: { acceptance: [{ id: 'A1', text: 'browser works' }] } },
      decision: { computerUseRequired: true },
      ledger,
    });
    assert.equal(facts.computerUseEvidence.verified, true);
    assert.equal(facts.computerUseEvidence.headSha, 'abc123def');

    fs.writeFileSync(path.join(evidenceDir, 'completion.json'), JSON.stringify({
      schema: 'ace.computer_use_behavioral_validation.v1',
      validatedHeadSha: 'stale-head',
      passed: true,
      checkedAcceptance: [{ id: 'A1', status: 'pass' }],
    }));
    const stale = await fx.gatePr({
      runId: 'run-ui',
      state: { spec: { acceptance: [{ id: 'A1', text: 'browser works' }] } },
      decision: { computerUseRequired: true },
      ledger,
    });
    assert.equal(stale.computerUseEvidence.verified, false);
    assert.match(stale.computerUseEvidence.reason, /does not match/);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('release OPEN phase: no PR yet => opens+gates the PR (no token, no merge) and emits gate.evaluated', async () => {
  // The PR-open phase is what unblocks ready_to_review -> done: without it the
  // run stalls (the policy keeps asking to open the PR but a merge-only effect
  // cannot). Opening a PR is safe and needs NO owner token.
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: { result: { pr: { number: 42, url: 'https://x/pr/42', state: 'OPEN', headSha: 'h1', checkState: 'success', mergeable: 'MERGEABLE', files: ['src/a.ts'] }, validation: { required: false } } },
    integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged' } },
  });
  const fx = createSpineEffects({ client });
  // state.pr.exists is falsy => the open phase runs.
  const ret = await fx.release({ runId: 'run-1', state: { spec: {}, pr: {} }, ledger });
  assert.equal(ret.event.type, 'gate.evaluated', 'open phase emits gate.evaluated so pr.exists flips true');
  assert.equal(ret.event.payload.prExists, true);
  assert.equal(ret.event.payload.prNumber, 42);
  assert.equal(client.count('integrationOpenPr'), 1, 'the PR is opened');
  assert.equal(client.count('integrationMergePr'), 0, 'the open phase NEVER merges (no token needed, main untouched)');
});

test('release OPEN phase applies workspace policy draft/base/allow-path behavior', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: { result: { pr: { number: 42, state: 'OPEN', headSha: 'h1', checkState: 'pending', mergeable: 'MERGEABLE', files: ['docs/a.md'] }, validation: { required: false } } },
  });
  const fx = createSpineEffects({ client });
  const spec = {
    workspaceAutoMergePolicy: {
      enabled: true,
      autoMerge: false,
      mode: 'draft',
      targetBranches: ['main'],
      allowPaths: ['docs/'],
    },
  };

  await fx.release({ runId: 'run-1', state: { spec, pr: {} }, ledger });

  const call = client.find('integrationOpenPr');
  assert.equal(call.params.base, 'main');
  assert.equal(call.params.draft, true);
  assert.deepEqual(call.params.allowedPaths, ['docs/']);
});

test('release OPEN phase: no worker PR => no duplicate pending gate event', async () => {
  const ledger = createMemoryEventLog();
  const client = recorder({});
  const fx = createSpineEffects({ client });

  const ret = await fx.release({ runId: 'run-1', state: { spec: {}, pr: {} }, ledger });

  assert.deepEqual(ret, {}, 'no PR proof => no gate.evaluated append');
  assert.equal(client.count('integrationOpenPr'), 0, 'no worker task means there is nothing to open');
});

test('release MERGE phase is FAIL-CLOSED: no owner token => no merge; valid token => merges; wrong token => no merge', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const client = recorder({ integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged', headSha: 'abc', cleanedUp: true } } });
  const fx = createSpineEffects({ client });
  // pr.exists:true => the merge phase runs (the open phase is already done).
  const state = { spec: {}, pr: { exists: true, number: 42 } };

  const noToken = await fx.release({ runId: 'run-1', state, decision: RELEASE_DECISION, ledger });
  assert.deepEqual(noToken, {}, 'no token => no merged event');
  assert.equal(client.count('integrationMergePr'), 0, 'no merge attempted without a token');

  const prev = process.env.ACE_OWNER_AUTH_TOKEN;
  try {
    process.env.ACE_OWNER_AUTH_TOKEN = 'secret-xyz';
    const missingEvidence = await fx.release({
      runId: 'run-1',
      state: { spec: { ownerAuthToken: 'secret-xyz' }, pr: { exists: true, number: 42 } },
      ledger,
    });
    assert.deepEqual(missingEvidence, {}, 'owner token cannot bypass missing release evidence');
    assert.equal(client.count('integrationMergePr'), 0, 'missing evidence never reaches the merge gateway');

    const merged = await fx.release({ runId: 'run-1', state: { spec: { ownerAuthToken: 'secret-xyz' }, pr: { exists: true, number: 42 } }, decision: RELEASE_DECISION, ledger });
    assert.equal(merged.sha, 'sha_merged', 'valid token => merge sha returned');
    assert.equal(client.count('integrationMergePr'), 1, 'merge attempted exactly once with a valid token');
    // Branch deletion stays the gateway DEFAULT (mergePr deleteBranch=true +
    // postMergeCleanup): the spine must never opt out of it.
    const mergeCall = client.find('integrationMergePr');
    assert.notEqual(mergeCall.params.deleteBranch, false, 'spine merge leaves deleteBranch at its default-true (merged branch is deleted + worktree cleaned)');

    const wrong = await fx.release({ runId: 'run-1', state: { spec: { ownerAuthToken: 'WRONG' }, pr: { exists: true, number: 42 } }, decision: RELEASE_DECISION, ledger });
    assert.deepEqual(wrong, {}, 'wrong token => no merge');
    assert.equal(client.count('integrationMergePr'), 1, 'still only one merge total');
  } finally {
    if (prev === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
    else process.env.ACE_OWNER_AUTH_TOKEN = prev;
  }
});

test('release MERGE phase parks on a FAILING review-bot verdict even with a valid owner token', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const client = recorder({ integrationMergePr: { ok: true, result: { mergedSha: 'sha_merged' } } });
  const fx = createSpineEffects({ client });
  const prev = process.env.ACE_OWNER_AUTH_TOKEN;
  try {
    process.env.ACE_OWNER_AUTH_TOKEN = 'secret-xyz';
    const ret = await fx.release({
      runId: 'run-1',
      state: {
        spec: { ownerAuthToken: 'secret-xyz' },
        pr: { exists: true, number: 42, reviewBot: { name: 'validate', state: 'failure', mustFix: [] } },
      },
      decision: RELEASE_DECISION,
      ledger,
    });
    assert.deepEqual(ret, {}, 'failing review-bot verdict => park, never merge past it');
    assert.equal(client.count('integrationMergePr'), 0, 'no merge attempted');
  } finally {
    if (prev === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
    else process.env.ACE_OWNER_AUTH_TOKEN = prev;
  }
});

test('release MERGE phase: autoship policy can merge through integration gateway without owner token', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({
    runId: 'run-auto',
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_auto', branch: 'feat/autoship', worktreePath: '/tmp/wt-auto' },
  });
  const client = recorder({ integrationMergePr: { ok: true, result: { mergedSha: 'sha_auto', headSha: 'head123head123', cleanedUp: true } } });
  const fx = createSpineEffects({ client });
  const state = {
    spec: {
      workspaceAutoMergePolicy: {
        enabled: true,
        autoMerge: true,
        targetBranches: ['main'],
        releaseTrainGuard: true,
        allowPaths: ['src/'],
      },
    },
    validator: { done: true, outcome: 'PASS', validatedHeadSha: 'head123head123' },
    pr: {
      exists: true,
      number: 42,
      headSha: 'head123head123',
      baseBranch: 'main',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      state: 'OPEN',
      changedFiles: ['src/a.ts'],
      allowedPaths: ['src/'],
      validation: { independent: 'PASS', required: true },
    },
    currentHeadSha: 'head123head123',
    validatedHeadSha: 'head123head123',
  };
  const gate = {
    ok: true,
    validation: { independent: 'PASS', required: true },
    scope: { changedFiles: ['src/a.ts'] },
    computerUseEvidence: false,
  };

  const merged = await fx.release({ runId: 'run-auto', state, decision: RELEASE_DECISION, gate, ledger });
  assert.equal(merged.sha, 'sha_auto');
  assert.equal(client.count('integrationMergePr'), 1);
  const call = client.find('integrationMergePr');
  assert.equal(call.params.gate.automerge, true);
  assert.equal(call.params.gate.expectedHeadSha, 'head123head123');
  assert.equal(call.params.gate.expectedBaseBranch, 'main');
  assert.equal(call.params.gate.releaseTrainGuard, true);
  assert.deepEqual(call.params.allowedPaths, ['src/']);
  assert.ok(ledger.readRun('run-auto').some((e: any) => e.type === 'autoship.merge.started'));
});

test('release MERGE phase: autoship gateway throw records blocked so replay clears merge-start wedge', async () => {
  const ledger = createMemoryEventLog();
  const runId = 'run-auto-throw';
  const headSha = 'headthrow123';
  ledger.append({
    runId,
    type: 'run.created',
    payload: { spec: { autoShip: { enabled: true, autoMerge: true }, scope: { allow: ['src/'] } } },
  });
  ledger.append({
    runId,
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_auto_throw', branch: 'feat/autoship-throw', worktreePath: '/tmp/wt-auto-throw' },
  });
  ledger.append({ runId, type: 'worker.completed', payload: { outcome: 'DONE', currentHeadSha: headSha } });
  ledger.append({
    runId,
    type: 'gate.evaluated',
    payload: {
      prExists: true,
      prNumber: 43,
      prState: 'OPEN',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      headSha,
      headBranch: 'feat/autoship-throw',
      changedFiles: ['src/a.ts'],
      allowedPaths: ['src/'],
      validation: { independent: 'PASS', required: true },
    },
  });

  const client = recorder({
    integrationMergePr: () => {
      throw new Error('gateway unavailable');
    },
  });
  const fx = createSpineEffects({ client });
  const state = {
    spec: { autoShip: { enabled: true, autoMerge: true }, scope: { allow: ['src/'] } },
    validator: { done: true, outcome: 'PASS', validatedHeadSha: headSha },
    pr: {
      exists: true,
      number: 43,
      headSha,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      state: 'OPEN',
      changedFiles: ['src/a.ts'],
      allowedPaths: ['src/'],
      validation: { independent: 'PASS', required: true },
    },
    currentHeadSha: headSha,
    validatedHeadSha: headSha,
  };
  const gate = {
    ok: true,
    validation: { independent: 'PASS', required: true },
    scope: { changedFiles: ['src/a.ts'] },
    computerUseEvidence: false,
  };

  const result = await fx.release({ runId, state, decision: RELEASE_DECISION, gate, ledger });
  assert.deepEqual(result, {});
  assert.equal(client.count('integrationMergePr'), 1);

  const events = ledger.readRun(runId);
  assert.equal(events.filter((e: any) => e.type === 'autoship.merge.started').length, 1);
  const blocked = events.find((e: any) => e.type === 'autoship.merge.blocked');
  assert.ok(blocked, 'gateway throw records autoship.merge.blocked');
  assert.match(blocked.payload.reason, /gateway unavailable/);

  const recovered = reconcile(runId, ledger, { wantGate: true });
  assert.equal(recovered.state.autoship.mergeStarted, false);
  assert.match(recovered.state.autoship.lastBlocker, /gateway unavailable/);
  assert.equal(recovered.autoship.status, 'parked_owner_review');
  assert.equal(recovered.autoship.autoMergeAllowed, false);

  await fx.release({ runId, state: recovered.state, decision: RELEASE_DECISION, gate: recovered.gate, ledger });
  assert.equal(client.count('integrationMergePr'), 1, 'blocked replay parks instead of retrying blindly');
});

test('gatePr marks a draft PR ready and requests the ready-head review ONCE per head; a push re-arms it', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w', streamId: 'str_w' } });
  const prFacts = (over: any) => ({
    result: {
      pr: {
        number: 42, url: 'https://x/pr/42', state: 'OPEN', headRefName: 'feat/x', baseRefName: 'main',
        checkState: 'pending', mergeable: 'MERGEABLE', files: [], ...over,
      },
      validation: null,
      reviewBot: null,
    },
  });
  // Scripted gate reads: draft@h1 → ready@h1 → ready@h1 (same head re-gate) → ready@h2 (post-push).
  const script = [
    prFacts({ isDraft: true, headSha: 'abc123def' }),
    prFacts({ isDraft: false, headSha: 'abc123def' }),
    prFacts({ isDraft: false, headSha: 'abc123def' }),
    prFacts({ isDraft: false, headSha: 'def456abc' }),
  ];
  let gateCalls = 0;
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: () => script[Math.min(gateCalls++, script.length - 1)],
  });
  const fx = createSpineEffects({ client });
  const spec = { goal: 'g', scope: { workspaceId: 'prj_1' } };

  const facts = await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationReadyPr'), 1, 'the draft PR is marked ready');
  assert.equal(client.count('integrationRequestReview'), 1, 'the /codex review request is posted');
  assert.equal(facts.isDraft, false, 'facts are re-read after ready');
  let reqs = ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested');
  assert.equal(reqs.length, 1, 'one review.requested event');
  assert.equal(reqs[0].payload.headSha, 'abc123def');

  // Same head, next gate tick: idempotent — no duplicate ready/request.
  await fx.gatePr({ runId: 'run-1', state: { spec, review: { requestedHeadSha: 'abc123def' } }, decision: {}, ledger });
  assert.equal(client.count('integrationReadyPr'), 1, 'ready never repeats');
  assert.equal(client.count('integrationRequestReview'), 1, 'request is once per head');
  reqs = ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested');
  assert.equal(reqs.length, 1, 'no duplicate event at the same head');

  // A push produced a NEW head: the exact-head request re-arms.
  await fx.gatePr({ runId: 'run-1', state: { spec, review: { requestedHeadSha: 'abc123def' } }, decision: {}, ledger });
  assert.equal(client.count('integrationRequestReview'), 2, 'new head, new request');
  reqs = ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].payload.headSha, 'def456abc');
});

test('syncWorker fixback pull: a stale trailer (the original verdict still on screen) never closes the round; only a NEW trailer does', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w', streamId: 'str_w', agent: 'codex' } });
  ledger.append({ runId: 'run-1', type: 'worker.completed', payload: { outcome: 'DONE', detail: 'implemented — head h1' } });
  ledger.append({ runId: 'run-1', type: 'fixback.dispatched', payload: {} });
  const state = { worker: { dispatched: true, done: true, fixbackInFlight: true }, validator: {} };

  const staleClient = recorder({
    streamPeekScreen: { result: { state: 'turn-complete', text: 'DONE: implemented — head h1', rawTail: '' } },
  });
  const stale = await createSpineEffects({ client: staleClient }).syncWorker({ runId: 'run-1', state, ledger });
  assert.equal(stale, null, 'duplicate/stale verdict is dropped — the round stays open');

  const freshClient = recorder({
    streamPeekScreen: { result: { state: 'turn-complete', text: 'DONE: fixed the findings — head h2', rawTail: '' } },
  });
  const fresh = await createSpineEffects({ client: freshClient }).syncWorker({ runId: 'run-1', state, ledger });
  assert.ok(fresh, 'a new trailer closes the round');
  assert.equal(fresh.outcome, 'DONE');
  assert.match(String(fresh.detail), /fixed the findings/);
  assert.equal(fresh.agent, 'codex', 'completion carries the original agent');
});

test('gatePr treats gateway {ok:false} envelopes as FAILURES: no ready, no request, nothing recorded', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const draftFacts = {
    result: {
      pr: { number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: true, headRefName: 'feat/x', baseRefName: 'main', headSha: 'abc123def', checkState: 'pending', mergeable: 'MERGEABLE', files: [] },
      validation: null,
      reviewBot: null,
    },
  };
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: draftFacts,
    // The gateway NEVER throws — gh failures resolve as {ok:false} envelopes.
    integrationReadyPr: { ok: false, phase: 'failure', result: { error: 'gh exploded' } },
    integrationRequestReview: { ok: false, phase: 'failure', result: { error: 'gh exploded' } },
  });
  const fx = createSpineEffects({ client });
  const spec = { goal: 'g', scope: { workspaceId: 'prj_1' } };
  const facts = await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(facts.isDraft, true, 'a failed ready leaves the PR draft (non-terminal, retried)');
  assert.equal(ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested').length, 0,
    'a failed request records nothing — the next gate tick retries');
});

test('review.requested is finalized ONLY after the /codex review post lands — a throw or {ok:false} on the request retries; the marker is never recorded before success (#185)', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  // A NON-draft PR at a fixed head: ensureReadyHeadReview skips the ready block
  // and goes straight to the request-review step — the partial-failure surface
  // #185 hardened (the /codex review post itself failing AFTER readiness, which
  // the {ok:false}-at-ready test above never reaches because it returns early).
  const readyFacts = {
    result: {
      pr: {
        number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: false,
        headRefName: 'feat/x', baseRefName: 'main', headSha: 'abc123def',
        checkState: 'pending', mergeable: 'MERGEABLE', files: [],
      },
      validation: null,
      reviewBot: null,
    },
  };
  // The gateway never throws for gh failures (it resolves {ok:false}); a crash
  // mid-post DOES throw. Cover both before the post finally lands:
  // tick 1 throws → tick 2 {ok:false} → tick 3 {ok:true}.
  let reviewCalls = 0;
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: readyFacts,
    integrationRequestReview: () => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error('gh crashed mid-post');
      if (reviewCalls === 2) return { ok: false, phase: 'failure', result: { error: 'gh exploded' } };
      return { ok: true, result: {} };
    },
  });
  const fx = createSpineEffects({ client });
  const spec = { goal: 'g', scope: { workspaceId: 'prj_1' } };
  const reqEvents = () => ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested');

  // Tick 1 — the post THROWS: attempted once, nothing recorded (not finalized before success).
  await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationRequestReview'), 1, 'the post was attempted');
  assert.equal(reqEvents().length, 0, 'a throw records nothing — the exact-head request is retried, not dropped');

  // Tick 2 — the post returns {ok:false}: re-attempted, still nothing recorded.
  await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationRequestReview'), 2, 'an {ok:false} envelope re-arms the request next tick');
  assert.equal(reqEvents().length, 0, 'a false envelope records nothing — never finalized before the post succeeds');

  // Tick 3 — the post LANDS: NOW the headSha-keyed idempotency marker is recorded.
  await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationRequestReview'), 3, 'the post is retried until it lands');
  const recorded = reqEvents();
  assert.equal(recorded.length, 1, 'review.requested is finalized exactly once, only after the post succeeded');
  assert.equal(recorded[0].payload.headSha, 'abc123def');

  // Tick 4 — idempotent: the ledger marker suppresses any re-post at the same head.
  await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationRequestReview'), 3, 'no duplicate post once the head is recorded');
  assert.equal(reqEvents().length, 1, 'still exactly one review.requested at this head');
});

test('a LANDED /codex review post whose durable marker write keeps failing is bounded to ONE post and self-heals — it never reposts across repeated ticks (#185 post-success/marker-write-failure window)', async () => {
  // The window act-then-record opened: the post SUCCEEDS but the ledger append
  // of the idempotency marker throws. Without an in-process bound, every
  // subsequent tick sees no durable marker (reviewAlreadyRequested false) and
  // reposts /codex review forever. The fix latches a per-head postKey the moment
  // the post lands, so failing ticks RETRY only the append (recovery) and never
  // re-post — and the marker becomes durable the instant the ledger write works.
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  // Make ONLY the review.requested append fail, and only for the first 3 tries;
  // every other append (and readRun) is the real in-memory log.
  const realAppend = ledger.append.bind(ledger);
  let reviewAppendFailures = 3;
  ledger.append = (ev: any) => {
    if (ev && ev.type === 'review.requested' && reviewAppendFailures > 0) {
      reviewAppendFailures -= 1;
      throw new Error('durable ledger write unavailable');
    }
    return realAppend(ev);
  };

  const readyFacts = {
    result: {
      pr: {
        number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: false,
        headRefName: 'feat/x', baseRefName: 'main', headSha: 'abc123def',
        checkState: 'pending', mergeable: 'MERGEABLE', files: [],
      },
      validation: null,
      reviewBot: null,
    },
  };
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: readyFacts,
    integrationRequestReview: { ok: true, result: {} }, // the post ALWAYS lands
  });
  const fx = createSpineEffects({ client });
  const spec = { goal: 'g', scope: { workspaceId: 'prj_1' } };
  const reqEvents = () => ledger.readRun('run-1').filter((e: any) => e.type === 'review.requested');
  const tick = () => fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });

  // Tick 1 — post lands, marker append THROWS (failure 1/3): posted once, not yet durable.
  await tick();
  assert.equal(client.count('integrationRequestReview'), 1, 'the post landed exactly once');
  assert.equal(reqEvents().length, 0, 'the durable marker did not persist — the append threw');

  // Ticks 2 & 3 — marker append keeps THROWING: the post is NEVER repeated (the bound).
  await tick();
  assert.equal(client.count('integrationRequestReview'), 1, 'a failing marker write does NOT trigger a second post (tick 2)');
  assert.equal(reqEvents().length, 0, 'still no durable marker (tick 2)');
  await tick();
  assert.equal(client.count('integrationRequestReview'), 1, 'still exactly one post despite the marker write still failing (tick 3)');
  assert.equal(reqEvents().length, 0, 'still no durable marker (tick 3)');

  // Tick 4 — the ledger write recovers: the marker is finalized, still no re-post.
  await tick();
  assert.equal(client.count('integrationRequestReview'), 1, 'recovery writes the marker without any extra post');
  const recorded = reqEvents();
  assert.equal(recorded.length, 1, 'the marker self-heals to exactly one review.requested once the append succeeds');
  assert.equal(recorded[0].payload.headSha, 'abc123def');

  // Tick 5 — now durable in the ledger: cross-process idempotency holds.
  await tick();
  assert.equal(client.count('integrationRequestReview'), 1, 'no post after the marker is durable');
  assert.equal(reqEvents().length, 1, 'still exactly one review.requested');
});

test('gatePr respects an OWNER-held draft policy: draftBehavior "draft" is never auto-readied', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const draftFacts = {
    result: {
      pr: { number: 42, url: 'https://x/pr/42', state: 'OPEN', isDraft: true, headRefName: 'feat/x', baseRefName: 'main', headSha: 'abc123def', checkState: 'pending', mergeable: 'MERGEABLE', files: [] },
      validation: null,
      reviewBot: null,
    },
  };
  const client = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: draftFacts,
  });
  const fx = createSpineEffects({ client });
  const spec = {
    goal: 'g',
    scope: { workspaceId: 'prj_1' },
    workspaceAutoMergePolicy: { draftBehavior: 'draft' },
  };
  const facts = await fx.gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger });
  assert.equal(client.count('integrationReadyPr'), 0, 'owner-held draft is never un-drafted');
  assert.equal(facts.isDraft, true);
});

test('dispatchFixback FAILS CLOSED when the fire-and-forget delivery did not land (runTask resolves, never throws)', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({
    runId: 'run-1',
    type: 'worker.dispatch.linked',
    payload: { taskId: 'tsk_w', streamId: 'str_w', branch: 'feat/flag' },
  });
  const undelivered = async (_client: any, _opts: any) => ({
    taskId: 'tsk_w', streamId: 'str_w', outcome: 'error', promptDelivered: false,
  });
  const alive = recorder({ streamPeekScreen: { result: { state: 'awaiting-input', text: '', rawTail: '' } } });
  const fx = createSpineEffects({ client: alive, runTask: undelivered });
  const spec = { goal: 'Add a flag', agent: 'codex', scope: { workspaceId: 'prj_1' } };
  await assert.rejects(
    () => fx.dispatchFixback({ runId: 'run-1', state: { spec, pr: { exists: true }, fixback: { attempts: 0 } }, ledger }),
    /fixback delivery did not land/,
  );
  const links = ledger.readRun('run-1').filter((e: any) => e.type === 'worker.dispatch.linked');
  assert.equal(links.length, 1, 'no round link is recorded for an undelivered prompt (only the original)');
});

test('gatePr FAILS CLOSED on a failed or incomplete gate read — no gate.evaluated, staleness preserved', async () => {
  const ledger = createMemoryEventLog();
  ledger.append({ runId: 'run-1', type: 'worker.dispatch.linked', payload: { taskId: 'tsk_w' } });
  const spec = { goal: 'g', scope: { workspaceId: 'prj_1' } };

  // {ok:false} envelope (the gateway never throws) → the effect must throw.
  const failed = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: { ok: false, phase: 'failure', result: { error: 'gh exploded' } },
  });
  await assert.rejects(
    () => createSpineEffects({ client: failed }).gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger }),
    /gate read failed/,
  );

  // ok envelope but NO PR head → incomplete facts must also throw.
  const headless = recorder({
    integrationOpenPr: { result: { prNumber: 42 } },
    integrationGate: { result: { pr: { number: 42, checkState: 'pending' }, validation: null, reviewBot: null } },
  });
  await assert.rejects(
    () => createSpineEffects({ client: headless }).gatePr({ runId: 'run-1', state: { spec, review: {} }, decision: {}, ledger }),
    /no PR head/,
  );
});
