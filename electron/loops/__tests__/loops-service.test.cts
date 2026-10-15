// loops-service tests — the LIVE glue layer (PRD §5, §3 two-plane). node:test +
// node:assert/strict so it runs under the repo's .cts runner (vitest cannot parse
// .cts here). All effects are in-memory fakes: a fake harness (submit mints run
// ids + tags loop intents into a fake ledger; kernel.reconcile returns scripted
// states), a fake driveRun spy, and an in-memory catalog fs. No better-sqlite3,
// no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let svcMod: any;
try {
  svcMod = require('../loops-service.cts');
} catch {
  svcMod = require('../loops-service.cjs');
}
const { createLoopsService, mapLoopIntentToRunIntent } = svcMod;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function codeLoopSpec(overrides: any = {}): any {
  return {
    id: 'ci-green',
    name: 'CI Green',
    description: 'harden CI until Spine Guard is green',
    useWhen: 'CI is flaky',
    kind: 'code',
    inputs: {},
    goalTemplate: 'iteration {{iteration}}: harden CI (prior={{priorOutcome}})',
    routing: {
      agent: 'codex',
      skills: ['gh-fix-ci'],
      workspace: 'loops',
      target: { repo: '/repo', allow: ['.github/**'] },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: {},
    meta: { version: 1 },
    ...overrides,
  };
}

// In-memory catalog fs (single-file model, matches loop-store).
function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p: string) => (files.has(p) ? (files.get(p) as string) : null),
    writeFile: (p: string, c: string) => {
      files.set(p, c);
    },
  };
}

// A fake harness: submit appends an INTENT_CREATED event carrying the loop tag,
// kernel.reconcile returns a scripted state queue per run, ledger.readAll surfaces
// the appended intents so loopStatus can fold lineage.
function fakeHarness(scriptByRun: Record<string, any[]> = {}) {
  const events: any[] = [];
  let counter = 0;
  const reconcileCalls: string[] = [];
  return {
    submitted: [] as any[],
    events,
    reconcileCalls,
    submit(intent: any) {
      counter += 1;
      const runId = `run-${counter}`;
      this.submitted.push(intent);
      events.push({ runId, type: 'intent.created', payload: { intent: { ...intent } } });
      events.push({ runId, type: 'run.created', payload: { spec: intent } });
      return runId;
    },
    kernel: {
      reconcile(runId: string) {
        reconcileCalls.push(runId);
        const q = scriptByRun[runId];
        // Return the LAST scripted state for this run (terminal) so the host's
        // inner observe loop reaches quiescence immediately.
        const state = q && q.length ? q[q.length - 1] : null;
        return { state };
      },
    },
    ledger: { readAll: () => events.slice() },
  };
}

function makeService(harness: any, opts: any = {}) {
  const fs = opts.fs || memFs();
  const driveRunCalls: string[] = [];
  const svc = createLoopsService({
    harness,
    driveRun: (runId: string) => driveRunCalls.push(runId),
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    concurrencyCap: opts.concurrencyCap,
  });
  return { svc, fs, driveRunCalls };
}

// ---------------------------------------------------------------------------
// list / save / get
// ---------------------------------------------------------------------------

test('saveLoop persists and listLoops/getLoop read it back', () => {
  const { svc } = makeService(fakeHarness());
  assert.deepEqual(svc.listLoops(), []);
  const saved = svc.saveLoop(codeLoopSpec());
  assert.equal(saved.id, 'ci-green');
  const list = svc.listLoops();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ci-green');
  assert.equal(svc.getLoop('ci-green')!.name, 'CI Green');
  assert.equal(svc.getLoop('nope'), null);
});

test('removeLoop deletes a saved loop from the catalog', () => {
  const { svc } = makeService(fakeHarness());
  svc.saveLoop(codeLoopSpec());
  assert.equal(svc.listLoops().length, 1);
  assert.equal(svc.removeLoop('ci-green').removed, true);
  assert.equal(svc.listLoops().length, 0);
  assert.equal(svc.getLoop('ci-green'), null);
  // removing a missing id is a clean false, never throws.
  assert.equal(svc.removeLoop('ci-green').removed, false);
});

test('stopLoop accepts a loopId (not just a host invocation id) without throwing', () => {
  const { svc } = makeService(fakeHarness());
  svc.saveLoop(codeLoopSpec());
  // No active invocation -> stopped:false, but the loopId path must not throw.
  assert.equal(svc.stopLoop('ci-green').stopped, false);
  assert.equal(svc.stopLoop('loopinv-ci-green-1').stopped, false);
  assert.equal(svc.stopLoop('').stopped, false);
});

// ---------------------------------------------------------------------------
// lockOn (fail-closed)
// ---------------------------------------------------------------------------

test('lockOnLoop returns a spec for a valid draft and errors for an unsafe one', () => {
  const { svc } = makeService(fakeHarness());

  const ok = svc.lockOnLoop(codeLoopSpec({ id: undefined, meta: undefined }));
  assert.ok(ok.spec, 'valid draft should lock');
  assert.equal(ok.spec!.id, 'ci-green'); // derived from name
  assert.equal(ok.errors, undefined);

  // Unsafe: requests merge_to_main without owner ack ⇒ fail-closed.
  const unsafe = svc.lockOnLoop(
    codeLoopSpec({ contract: { ...codeLoopSpec().contract, permissions: ['merge_to_main'] } }),
  );
  assert.equal(unsafe.spec, undefined);
  assert.ok(Array.isArray(unsafe.errors) && unsafe.errors.length > 0);
  assert.ok(unsafe.errors!.some((e: string) => /UNSAFE_REQUIRES_APPROVAL/.test(e)));

  // Missing required field ⇒ errors.
  const bad = svc.lockOnLoop({ name: 'X' });
  assert.equal(bad.spec, undefined);
  assert.ok(bad.errors!.length > 0);
});

// ---------------------------------------------------------------------------
// runLoop drives an iteration through the live submit seam + maps the intent
// ---------------------------------------------------------------------------

test('runLoop submits a mapped run intent, calls driveRun, and converges', async () => {
  // One iteration: validator PASS, no PR (agentic-style DONE) ⇒ converged.
  const harness = fakeHarness({
    'run-1': [
      {
        worker: { done: true, outcome: 'DONE' },
        validator: { done: true, outcome: 'PASS' },
        pr: { exists: false },
        merge: { merged: false },
        currentHeadSha: 'sha-1',
      },
    ],
  });
  const { svc, driveRunCalls } = makeService(harness);
  svc.saveLoop(codeLoopSpec());

  const res = await svc.runLoop('ci-green', { extra: 'x' });

  assert.ok(res.invocationId);
  assert.equal(res.loopId, 'ci-green');
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
  assert.equal(res.iterations.length, 1);
  assert.equal(res.iterations[0].runId, 'run-1');

  // Intent mapping: submit got the flattened run-ledger intent shape + loop tag.
  assert.equal(harness.submitted.length, 1);
  const intent = harness.submitted[0];
  assert.equal(intent.workspace, 'loops');
  assert.equal(intent.agent, 'codex');
  assert.equal(intent.loopId, 'ci-green');
  assert.deepEqual(intent.allow, ['.github/**']);
  assert.equal(intent.repo, '/repo');
  assert.equal(intent.merge.ownerGated, true);

  // driveRun was called with the minted runId (loop iteration advances like a CLI run).
  assert.deepEqual(driveRunCalls, ['run-1']);
});

test('runLoop returns spec-not-found for an unknown loop without submitting', async () => {
  const harness = fakeHarness();
  const { svc } = makeService(harness);
  const res = await svc.runLoop('missing');
  assert.equal(res.finishReason, 'spec-not-found');
  assert.equal(harness.submitted.length, 0);
});

// ---------------------------------------------------------------------------
// killAll / stop / status
// ---------------------------------------------------------------------------

test('killAllLoops returns ok and loopStatus reports gauges + folds lineage', async () => {
  const harness = fakeHarness({
    'run-1': [
      {
        worker: { done: true, outcome: 'DONE' },
        validator: { done: true, outcome: 'PASS' },
        pr: { exists: false },
        merge: { merged: false },
        currentHeadSha: 'sha-1',
      },
    ],
  });
  const { svc } = makeService(harness);
  svc.saveLoop(codeLoopSpec());
  await svc.runLoop('ci-green');

  assert.deepEqual(svc.killAllLoops(), { ok: true });

  // stop on an unknown invocation is false.
  assert.deepEqual(svc.stopLoop('nope'), { stopped: false });

  // status('all') folds the ledger's loop-tagged runs into a per-loop lineage.
  const status = svc.loopStatus('all');
  assert.ok(Array.isArray(status.active));
  assert.equal(typeof status.inFlight, 'number');
  assert.ok(status.lineages && status.lineages['ci-green']);
  assert.equal(status.lineages['ci-green'].iterationCount, 1);

  // status for a specific id returns a single folded lineage.
  const one = svc.loopStatus('ci-green');
  assert.ok(one.lineage);
  assert.equal(one.lineage.loopId, 'ci-green');
  assert.equal(one.lineage.iterationCount, 1);
});

// ---------------------------------------------------------------------------
// Slice 2: agentic (evidence-only) loop through the live glue — converges on a
// finished worker (no validator/PR) and loopStatus folds it to a terminal DONE.
// ---------------------------------------------------------------------------

function agenticLoopSpec(overrides: any = {}): any {
  return codeLoopSpec({
    id: 'intel-digest',
    name: 'Intel Digest',
    kind: 'agentic',
    routing: { agent: 'claude', skills: [], workspace: 'loops', target: { allow: [] } },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: { criteria: 'a sourced digest' },
    ...overrides,
  });
}

test('runLoop on an agentic spec converges on a finished worker; loopStatus folds it DONE', async () => {
  const harness = fakeHarness({
    'run-1': [
      {
        worker: { done: true, outcome: 'DONE' },
        validator: { done: false },
        pr: { exists: false },
        merge: { merged: false },
        currentHeadSha: 'sha-agentic-1',
      },
    ],
  });
  const { svc, driveRunCalls } = makeService(harness);
  svc.saveLoop(agenticLoopSpec());

  const res = await svc.runLoop('intel-digest', {});
  assert.equal(res.finishReason, 'converged');
  assert.equal(res.latestRunOutcome, 'DONE');
  assert.equal(res.iterations.length, 1);

  // The mapped intent carried kind=agentic and no merge token (owner-gated).
  const intent = harness.submitted[0];
  assert.equal(intent.kind, 'agentic');
  assert.equal(intent.merge.tokenRef, undefined);
  assert.deepEqual(driveRunCalls, ['run-1']);

  // loopStatus folds the loop's tagged runs kind-aware -> terminal DONE.
  const status = svc.loopStatus('intel-digest');
  assert.equal(status.lineage.latestRunOutcome, 'DONE');
});

// ---------------------------------------------------------------------------
// Slice 3: forge compile + manager-select + triggers through the service glue.
// ---------------------------------------------------------------------------

test('compileLoop turns free text into a proposed draft with inference notes', () => {
  const { svc } = makeService(fakeHarness());
  const res = svc.compileLoop('Produce a daily intel digest of findings');
  assert.ok(res.draft && res.draft.kind === 'agentic');
  assert.ok(Array.isArray(res.notes) && res.notes.length > 0);
  // the proposed draft locks on cleanly
  const locked = svc.lockOnLoop(res.draft);
  assert.ok(locked.spec, JSON.stringify(locked.errors));
});

test('selectLoop matches a saved loop by useWhen and returns null below threshold', () => {
  const { svc } = makeService(fakeHarness());
  svc.saveLoop(codeLoopSpec({ id: 'ci-green', useWhen: 'CI is flaky and the spine guard fails' }));
  const hit = svc.selectLoop('the spine guard CI is flaky again');
  assert.equal(hit.loopId, 'ci-green');
  assert.ok(hit.score > 0);
  const miss = svc.selectLoop('totally unrelated banana recipe');
  assert.equal(miss.loopId, null);
});

test('startTriggers arms enabled schedule triggers; fireLoopEvent fires matching event loops', () => {
  // Fake timers so nothing actually fires during the test.
  const handles: any[] = [];
  const fakeSetTimeout = (_fn: any, _ms: number) => {
    const h = { id: handles.length };
    handles.push(h);
    return h;
  };
  const fakeClearTimeout = (_h: any) => {};

  const harness = fakeHarness({
    'run-1': [{ worker: { done: true, outcome: 'DONE' }, validator: { done: false }, pr: { exists: false }, merge: { merged: false }, currentHeadSha: 's1' }],
  });
  const fs = memFs();
  const driveRunCalls: string[] = [];
  const svc = createLoopsService({
    harness,
    driveRun: (runId: string) => driveRunCalls.push(runId),
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    timers: { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout },
  });

  svc.saveLoop(
    codeLoopSpec({
      id: 'scheduled-loop',
      triggers: [{ kind: 'schedule', enabled: true, everyMs: 3_600_000 }],
    }),
  );
  svc.saveLoop(
    agenticLoopSpec({
      id: 'event-loop',
      triggers: [{ kind: 'event', enabled: true, event: 'intel.refresh' }],
    }),
  );

  const armed = svc.startTriggers();
  assert.equal(armed.armed, 1, 'one schedule trigger armed');

  const fired = svc.fireLoopEvent('intel.refresh');
  assert.deepEqual(fired.fired, ['event-loop']);

  svc.stopTriggers();
});

test('triggers re-arm when the catalog changes after startTriggers (no boot-order gap)', () => {
  const handles: any[] = [];
  const svc = createLoopsService({
    harness: fakeHarness(),
    driveRun: () => {},
    fs: memFs(),
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    timers: { setTimeout: (_f: any) => ({ id: handles.push(0) }), clearTimeout: () => {} },
  });
  // start with an EMPTY catalog (mirrors boot-before-save): nothing armed.
  assert.equal(svc.startTriggers().armed, 0);
  // saving a scheduled loop now re-arms it immediately.
  svc.saveLoop(codeLoopSpec({ id: 'later', triggers: [{ kind: 'schedule', enabled: true, everyMs: 3_600_000 }] }));
  // a follow-up startTriggers reports the now-armed count (re-arm happened on save).
  assert.equal(svc.startTriggers().armed, 1);
  svc.stopTriggers();
});

// ---------------------------------------------------------------------------
// Slice 4: cross-workspace targeting — a loop executes in a target workspace but
// still surfaces (folds) in the Loops control plane via its loopId tag.
// ---------------------------------------------------------------------------

test('runLoop on a cross-workspace code loop submits to the target workspace and still folds in Loops', async () => {
  const harness = fakeHarness({
    'run-1': [
      {
        worker: { done: true, outcome: 'DONE' },
        validator: { done: true, outcome: 'PASS' },
        pr: { exists: false },
        merge: { merged: false },
        currentHeadSha: 'sha-x',
      },
    ],
  });
  const { svc } = makeService(harness);
  svc.saveLoop(
    codeLoopSpec({
      id: 'cross-loop',
      routing: { agent: 'codex', skills: [], workspace: 'loops', target: { repo: '/x', allow: ['**'], workspace: 'project-x' } },
    }),
  );

  const res = await svc.runLoop('cross-loop', {});
  assert.equal(res.finishReason, 'converged');

  // The submitted run intent executed in the TARGET workspace...
  const intent = harness.submitted[0];
  assert.equal(intent.workspace, 'project-x');
  assert.equal(intent.controlWorkspace, 'loops');
  assert.equal(intent.loopId, 'cross-loop');

  // ...yet loopStatus still folds it back into the Loops control plane by loopId.
  const status = svc.loopStatus('cross-loop');
  assert.ok(status.lineage && status.lineage.iterationCount === 1);
});

// ---------------------------------------------------------------------------
// spine-disabled guard (ACE_RUN_LEDGER=0 ⇒ harness null)
// ---------------------------------------------------------------------------

test('run-touching methods throw when the spine is disabled; definitions still work', async () => {
  const { svc } = makeService(null);
  // Definition methods work off the plain catalog.
  svc.saveLoop(codeLoopSpec());
  assert.equal(svc.listLoops().length, 1);
  assert.ok(svc.lockOnLoop(codeLoopSpec({ id: undefined, meta: undefined })).spec);

  // runLoop fail-closed throws.
  await assert.rejects(() => svc.runLoop('ci-green'), /run-ledger spine disabled/);

  // loopStatus still returns gauges (no ledger to fold).
  const status = svc.loopStatus('all');
  assert.deepEqual(status.active, []);
  assert.equal(status.inFlight, 0);
  assert.equal(status.lineages, undefined);
});

// ---------------------------------------------------------------------------
// mapLoopIntentToRunIntent unit
// ---------------------------------------------------------------------------

test('mapLoopIntentToRunIntent routes to the target workspace label but keeps the loop tag (Slice 4)', () => {
  const out = mapLoopIntentToRunIntent({
    loopId: 'cross',
    loopLineageId: 'cross-lin',
    iteration: 0,
    goal: 'edit project X',
    agent: 'codex',
    kind: 'code',
    skills: [],
    scope: { workspace: 'project-x', controlWorkspace: 'loops', workspaceId: 'prj-abc', repo: '/x', allow: ['**'] },
    merge: { ownerGated: true },
  });
  // executes in the target workspace LABEL...
  assert.equal(out.workspace, 'project-x');
  // ...the EXECUTION project id (real projects.id) is threaded separately, NOT the label.
  assert.equal(out.workspaceId, 'prj-abc');
  assert.equal(out.scope.workspaceId, 'prj-abc');
  // ...but control stays Loops + the loop tag is preserved so it folds back there.
  assert.equal(out.controlWorkspace, 'loops');
  assert.equal(out.loopId, 'cross');
  assert.equal(out.repo, '/x');
  assert.equal(out.scope.repo, '/x');
});

test('mapLoopIntentToRunIntent defaults to the loops workspace label when no target set', () => {
  const out = mapLoopIntentToRunIntent({ loopId: 'l', goal: 'g', scope: { allow: [] }, merge: {} });
  assert.equal(out.workspace, 'loops');
  assert.equal(out.controlWorkspace, 'loops');
  // acceptance is always non-empty (parseSpec requires it) — derived from the goal.
  assert.ok(Array.isArray(out.acceptance) && out.acceptance.length >= 1);
});

test('mapLoopIntentToRunIntent NESTS scope + carries acceptance + passes merge token through', () => {
  const out = mapLoopIntentToRunIntent({
    loopId: 'l1',
    loopLineageId: 'l1-lin',
    iteration: 2,
    goal: 'do the thing',
    agent: 'claude',
    kind: 'code',
    skills: ['s'],
    scope: { workspace: 'loops', workspaceId: 'prj-1', repo: '/r', allow: ['a/**'] },
    merge: { ownerGated: true, tokenRef: 'tok-1' },
  });
  assert.equal(out.goal, 'do the thing');
  assert.equal(out.workspace, 'loops');
  assert.equal(out.agent, 'claude');
  // NESTED scope (the junction fix): declares workspaceId + repo + paths.
  assert.equal(out.scope.workspaceId, 'prj-1');
  assert.equal(out.scope.repo, '/r');
  assert.deepEqual(out.scope.paths, ['a/**']);
  assert.deepEqual(out.allow, ['a/**']);
  assert.ok(out.acceptance.length >= 1);
  assert.equal(out.merge.tokenRef, 'tok-1');
  assert.equal(out.loopId, 'l1');
  assert.equal(out.iteration, 2);
});

test('mapLoopIntentToRunIntent falls back to the injected spine workspace (ACE_SPINE_WORKSPACE_ID)', () => {
  const prev = process.env.ACE_SPINE_WORKSPACE_ID;
  process.env.ACE_SPINE_WORKSPACE_ID = 'prj-injected';
  try {
    const out = mapLoopIntentToRunIntent({ loopId: 'l', goal: 'g', scope: { workspace: 'loops', allow: [] }, merge: {} });
    assert.equal(out.workspaceId, 'prj-injected');
    assert.equal(out.scope.workspaceId, 'prj-injected');
  } finally {
    if (prev === undefined) delete process.env.ACE_SPINE_WORKSPACE_ID;
    else process.env.ACE_SPINE_WORKSPACE_ID = prev;
  }
});

// THE junction proof: the mapped intent, fed through the spine's REAL parseSpec the
// way runSpecFor builds the worker spec (baseBranch+role defaulted, scope+acceptance
// from the intent), must PARSE — i.e. no more `worker.dispatch.failed: parseSpec:
// scope must declare at least one of {repo,paths,workspaceId}`. This is the exact
// failure that left every prior loop run with worker:NONE.
test('mapped intent + runSpecFor defaults passes the spine parseSpec (worker can attach)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { parseSpec } = require('../../../tools/ace/src/spec.cts');
  const intent = mapLoopIntentToRunIntent({
    loopId: 'pr-closeout',
    goal: 'Close out PR #523 at head abc123: validate, fixback, merge under policy.',
    agent: 'claude',
    kind: 'code',
    skills: [],
    scope: { workspace: 'loops', workspaceId: 'prj-da541490', repo: '/repo', allow: ['**'] },
    merge: { ownerGated: true },
  });
  // runSpecFor (spine-effects) defaults baseBranch/role and passes scope+acceptance through.
  const workerSpec = {
    goal: intent.goal,
    baseBranch: 'main',
    role: 'editor',
    scope: intent.scope,
    acceptance: intent.acceptance,
  };
  const parsed = parseSpec(workerSpec); // throws if invalid — pre-fix this threw on the empty scope
  assert.equal(parsed.goal, intent.goal);
  assert.equal(parsed.scope.workspaceId, 'prj-da541490');
  assert.ok(parsed.acceptance.length >= 1);
});

// ---------------------------------------------------------------------------
// System loops (PRD §10): builtin seed specs, kind-aware run + status.
// ---------------------------------------------------------------------------

let specMod: any;
try {
  specMod = require('../loop-spec.cts');
} catch {
  specMod = require('../loop-spec.cjs');
}
const { validateLoopSpec } = specMod;

// The EXACT builtin system LoopSpec shape ace-control wires (kind:'system',
// builtin:true, minimal valid routing, contract.verify booleans:false).
function builtinSystemLoops(): any[] {
  const meta = { version: 1 };
  const routing = { agent: 'auto', skills: [], workspace: 'loops', target: { allow: [] } };
  const contract = (permissions: string[] = []) => ({
    stop: { primary: 'converged' },
    ceilings: {},
    verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
    permissions,
    merge: { ownerGated: true },
  });
  const mk = (id: string, ref: string, schedule: string, permissions: string[] = []) => ({
    id,
    name: id,
    description: `system loop ${id}`,
    useWhen: `system maintenance ${id}`,
    kind: 'system',
    inputs: {},
    goalTemplate: `run ${id}`,
    routing,
    contract: contract(permissions),
    evidence: {},
    builtin: true,
    systemRunRef: ref,
    schedule,
    meta,
  });
  return [
    mk('sys-knowledge-nightly', 'sys-knowledge-nightly', 'daily 03:30'),
    mk('sys-ops-brief', 'sys-ops-brief', 'daily 07:30, 13:00, 20:30'),
    mk('sys-todo-digest', 'sys-todo-digest', 'daily 07:00, 21:00'),
  ];
}

test('builtin system loops: all 3 builtin specs pass validateLoopSpec', () => {
  const specs = builtinSystemLoops();
  assert.equal(specs.length, 3);
  for (const spec of specs) {
    const res = validateLoopSpec(spec);
    assert.equal(res.ok, true, `expected ${spec.id} to validate: ${(res.errors || []).join('; ')}`);
  }
});

test('a gated system loop is fail-closed UNSAFE_REQUIRES_APPROVAL until owner ack', () => {
  // No current builtin is gated, but the gated path must stay enforced for any
  // future system loop that requests an OWNER_APPROVAL permission.
  const base = builtinSystemLoops().find((s) => s.id === 'sys-knowledge-nightly');
  const gated = { ...base, id: 'sys-gated', contract: { ...base.contract, permissions: ['delete_or_archive_data'] } };
  const res = validateLoopSpec(gated);
  // delete_or_archive_data without an explicit owner ack ⇒ does NOT lock.
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => /UNSAFE_REQUIRES_APPROVAL/.test(e)));
  // ...and WOULD validate once an owner ack is present (the runnable path).
  const acked = validateLoopSpec({ ...gated, ownerApproved: true });
  assert.equal(acked.ok, true, (acked.errors || []).join('; '));
});

test('seedBuiltins seeds valid builtins idempotently and skips invalid ones', () => {
  const { svc } = makeService(fakeHarness());
  const valid = builtinSystemLoops().filter((s) => s.id !== 'sys-mission-archive');
  const first = svc.seedBuiltins(valid);
  assert.deepEqual(first.seeded.sort(), valid.map((s: any) => s.id).sort());
  // idempotent: a second seed clobbers nothing.
  const second = svc.seedBuiltins(valid);
  assert.deepEqual(second.seeded, []);
  // invalid builtin (missing goalTemplate) is skipped, not thrown.
  const skipped = svc.seedBuiltins([{ id: 'sys-broken', kind: 'system' } as any]);
  assert.deepEqual(skipped.seeded, []);
});

test('a system loop runs in-process via systemRunners (no spine) + carries systemResult', async () => {
  const fs = memFs();
  const ran: any[] = [];
  const svc = createLoopsService({
    harness: null, // spine OFF: a system loop must still run.
    driveRun: () => {},
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    builtins: builtinSystemLoops().filter((s) => s.id === 'sys-todo-digest'),
    systemRunners: {
      'sys-todo-digest': (inputs: any) => {
        ran.push(inputs);
        return { ok: true, digest: { delivered: true } };
      },
    },
    systemStatus: () => ({ ok: true, state: { lastRun: 'never' }, history: [] }),
  });
  const res = await svc.runLoop('sys-todo-digest', { now: true });
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'system');
  assert.deepEqual(res.iterations, []);
  assert.equal(res.systemResult.ok, true);
  assert.equal(ran.length, 1);
  // loopStatus returns the scheduler state under `system`, not a ledger fold.
  const status = svc.loopStatus('sys-todo-digest');
  assert.ok(status.system);
  assert.equal(status.system.ok, true);
});

test('seedBuiltins auto-runs from deps.builtins and lists the seeded system loops', () => {
  const { svc } = makeService(fakeHarness(), {});
  // makeService does not pass builtins; construct directly to exercise the path.
  const fs = memFs();
  const direct = createLoopsService({
    harness: null,
    driveRun: () => {},
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    builtins: builtinSystemLoops().filter((s) => s.id !== 'sys-mission-archive'),
  });
  const ids = direct.listLoops().map((s: any) => s.id);
  assert.ok(ids.includes('sys-ops-brief'));
});
