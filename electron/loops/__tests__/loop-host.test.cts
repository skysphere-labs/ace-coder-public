// loop-host tests — the OUTER recursion engine / multi-loop supervisor (PRD §10-A2).
// node:test + node:assert/strict so it runs under BOTH vitest and node --test.
//
// All effects are in-memory fakes (PRD §5/§R2): a fake submitIntent that mints
// run ids, a scripted observeRun that returns a sequence of reconciler states per
// run, and a fake store. No better-sqlite3, no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-host.cts');
} catch {
  mod = require('../loop-host.cjs');
}
const { createLoopHost } = mod;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A valid code-kind LoopSpec with NO ceilings (primary stop = converged/no-progress).
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

function fakeStore(spec: any): any {
  return { get: (id: string) => (spec && spec.id === id ? spec : null) };
}

// A reconciler state for one iteration. Mirrors the IterationRunState shape
// loop-lineage folds (worker/validator/pr/merge/telemetry/currentHeadSha).
function runState(opts: any = {}): any {
  return {
    worker: { done: opts.workerDone !== false, outcome: opts.workerOutcome || 'DONE' },
    validator: opts.validatorOutcome
      ? { done: true, outcome: opts.validatorOutcome, computerUseEvidence: !!opts.cu }
      : { done: false },
    pr: { exists: !!opts.prExists, headSha: opts.headSha || null },
    merge: { merged: !!opts.merged, headSha: opts.headSha || null },
    currentHeadSha: opts.headSha || null,
    telemetry: { totals: { tokens: opts.tokens || 0, spendUsd: opts.spendUsd || 0 } },
  };
}

// Build a host whose observeRun returns a scripted terminal state per run id, in
// the order runs are submitted. `scripts[i]` is the terminal state observed for
// the i-th submitted run.
function scriptedHost(spec: any, scripts: any[], hostOpts: any = {}) {
  const submitted: string[] = [];
  const byRun = new Map<string, any>();
  const submitIntent = (intent: any) => {
    const runId = `run-${submitted.length + 1}`;
    submitted.push(runId);
    byRun.set(runId, scripts[submitted.length - 1] ?? null);
    return runId;
  };
  const observeRun = (runId: string) => byRun.get(runId) ?? null;
  const host = createLoopHost({
    submitIntent,
    observeRun,
    store: fakeStore(spec),
    now: () => 1000,
    ...hostOpts,
  });
  return { host, submitted };
}

// ---------------------------------------------------------------------------
// A2: drives >=2 iterations, observes evidence, stops on converged
// ---------------------------------------------------------------------------

test('A2: invokeLoop drives multiple iterations and stops on a simulated converged', async () => {
  // iter0: validator request-changes with a head (progress, continue)
  // iter1: validator pass, no PR (agentic-style DONE) -> converged (next-goal no_goal)
  const { host, submitted } = scriptedHost(codeLoopSpec(), [
    runState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES', tokens: 10 }),
    runState({ headSha: 'sha-b', validatorOutcome: 'PASS', tokens: 10 }),
  ]);

  const res = await host.invokeLoop('ci-green', {});

  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
  assert.ok(res.iterations.length >= 2, `expected >=2 iterations, got ${res.iterations.length}`);
  // evidence observed each iteration
  assert.ok(res.iterations[0].evidence, 'iter0 evidence observed');
  assert.equal(res.iterations[0].evidence.headSha, 'sha-a');
  assert.equal(res.iterations[1].evidence.headSha, 'sha-b');
  assert.equal(submitted.length, 2);
  // lineage folded
  assert.ok(res.lineage);
  assert.equal(res.lineage.iterationCount, 2);
});

test('A2: invokeLoop stops on a simulated no-progress (latest adds no new evidence)', async () => {
  // iter0: head sha-a, request-changes (progress)
  // iter1: SAME head sha-a, same request-changes -> no new evidence -> no-progress
  const { host } = scriptedHost(codeLoopSpec(), [
    runState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES' }),
    runState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES' }),
  ]);

  const res = await host.invokeLoop('ci-green', {});

  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'no-progress');
  assert.ok(res.iterations.length >= 2);
});

test('invokeLoop stops on a blocked iteration', async () => {
  const { host } = scriptedHost(codeLoopSpec(), [
    runState({ headSha: 'sha-a', workerOutcome: 'BLOCKED', workerDone: true }),
  ]);
  const res = await host.invokeLoop('ci-green', {});
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'blocked');
  assert.equal(res.iterations.length, 1);
});

test('invokeLoop stops cap-hit when a ceiling is SET and exceeded', async () => {
  const spec = codeLoopSpec({
    contract: {
      stop: { primary: 'converged' },
      ceilings: { maxIterations: 2 },
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
  });
  // keep producing progress so only the ceiling stops it
  const { host } = scriptedHost(spec, [
    runState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES' }),
    runState({ headSha: 'sha-b', validatorOutcome: 'REQUEST-CHANGES' }),
    runState({ headSha: 'sha-c', validatorOutcome: 'REQUEST-CHANGES' }),
  ]);
  const res = await host.invokeLoop('ci-green', {});
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'cap-hit');
  // capped at 2 iterations
  assert.equal(res.iterations.length, 2);
});

test('spec-not-found returns a clean terminal result, never throws', async () => {
  const { host } = scriptedHost(codeLoopSpec(), []);
  const res = await host.invokeLoop('does-not-exist', {});
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'spec-not-found');
  assert.equal(res.iterations.length, 0);
});

// ---------------------------------------------------------------------------
// A2: owner-gated merge inheritance — converged code iter with an open PR parks
// ---------------------------------------------------------------------------

test('owner-gated: a validator-pass iteration with an OPEN PR parks (ready_for_review), not converged', async () => {
  // PASS + prExists => READY_FOR_REVIEW (owner-held). next-goal is NOT no_goal,
  // so the loop does not treat an awaiting-merge change as converged.
  const { host } = scriptedHost(codeLoopSpec(), [
    runState({ headSha: 'sha-a', validatorOutcome: 'PASS', prExists: true }),
    // a second observation at the SAME head -> no-progress terminal (it parks)
    runState({ headSha: 'sha-a', validatorOutcome: 'PASS', prExists: true }),
  ]);
  const res = await host.invokeLoop('ci-green', {});
  assert.equal(res.finished, true);
  // It does NOT report 'converged' (no auto-merge); it stops on no-progress while
  // parked at READY_FOR_REVIEW.
  assert.notEqual(res.finishReason, 'converged');
  assert.equal(res.latestRunOutcome, 'READY_FOR_REVIEW');
});

test('intent carries the loop merge tokenRef through to the spine gate (never merges itself)', async () => {
  const captured: any[] = [];
  const spec = codeLoopSpec({
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true, tokenRef: 'OWNER_LOOP_TOKEN' },
    },
  });
  const submitIntent = (intent: any) => {
    captured.push(intent);
    return `run-${captured.length}`;
  };
  const states = [runState({ headSha: 'sha-a', validatorOutcome: 'PASS' })];
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  const host = createLoopHost({ submitIntent, observeRun, store: fakeStore(spec), now: () => 0 });
  await host.invokeLoop('ci-green', {});
  assert.equal(captured[0].merge.ownerGated, true);
  assert.equal(captured[0].merge.tokenRef, 'OWNER_LOOP_TOKEN');
  assert.equal(captured[0].scope.workspace, 'loops');
  assert.equal(captured[0].agent, 'codex');
  assert.equal(captured[0].loopId, 'ci-green');
});

// ---------------------------------------------------------------------------
// Ship-loop fixback bridge: failing CI / Clawpatch findings author the NEXT goal
// ---------------------------------------------------------------------------

// A richer state helper that carries the PR gate facts the fixback bridge reads.
function shipState(opts: any = {}): any {
  return {
    worker: { done: opts.workerDone !== false, outcome: opts.workerOutcome || 'DONE' },
    validator: opts.validatorOutcome
      ? { done: true, outcome: opts.validatorOutcome, computerUseEvidence: opts.cu !== false }
      : { done: false },
    pr: {
      exists: opts.prExists !== false,
      headSha: opts.headSha || null,
      number: opts.prNumber ?? null,
      url: opts.prUrl ?? null,
      checkState: opts.checkState ?? null,
    },
    merge: { merged: !!opts.merged, headSha: opts.headSha || null },
    currentHeadSha: opts.headSha || null,
    telemetry: { totals: { tokens: opts.tokens || 0 } },
  };
}

test('failing CI on the prior iteration authors a CI-fixback goal for the next iteration', async () => {
  // iter0: validator PASS + open PR + RED CI -> parks (READY_FOR_REVIEW), continue.
  // iter1: fresh head, merged -> converged.
  const { host } = scriptedHost(codeLoopSpec(), [
    shipState({ headSha: 'sha-a', validatorOutcome: 'PASS', prExists: true, prNumber: 42, checkState: 'failure' }),
    shipState({ headSha: 'sha-b', validatorOutcome: 'PASS', prExists: true, prNumber: 42, merged: true, checkState: 'success' }),
  ]);
  const res = await host.invokeLoop('ci-green', {});
  assert.ok(res.iterations.length >= 2, `expected >=2 iterations, got ${res.iterations.length}`);
  // iter1's goal was enriched with the CI-failure directive derived from iter0.
  assert.match(res.iterations[1].goal, /CI is FAILING on PR #42/);
  assert.match(res.iterations[1].goal, /gh pr checks 42/);
});

test('a converged ship loop hands a run-summary record to writeRunSummary (fail-open)', async () => {
  const written: any[] = [];
  const spec = codeLoopSpec({
    routing: { agent: 'codex', skills: [], workspace: 'loops', target: { repo: '/repo', workspaceId: 'prj_9', allow: ['**'] } },
  });
  const states = [
    shipState({ headSha: 'sha-a', validatorOutcome: 'PASS', prExists: true, merged: true, prNumber: 7 }),
  ];
  const submitIntent = (_i: any) => 'run-1';
  const observeRun = (_r: string) => states[0];
  const host = createLoopHost({
    submitIntent,
    observeRun,
    store: fakeStore(spec),
    now: () => 0,
    writeRunSummary: (rec: any) => written.push(rec),
  });
  const res = await host.invokeLoop('ci-green', {});
  assert.equal(res.finishReason, 'converged');
  assert.equal(written.length, 1, 'writeRunSummary called exactly once on convergence');
  assert.equal(written[0].kind, 'loop_run_summary');
  assert.equal(written[0].projectId, 'prj_9');
  assert.equal(written[0].projectDir, '/repo');
});

test('a writeRunSummary that throws NEVER breaks loop termination (fail-open)', async () => {
  const spec = codeLoopSpec();
  const states = [shipState({ headSha: 'sha-a', validatorOutcome: 'PASS', prExists: true, merged: true })];
  const host = createLoopHost({
    submitIntent: () => 'run-1',
    observeRun: () => states[0],
    store: fakeStore(spec),
    now: () => 0,
    writeRunSummary: () => {
      throw new Error('disk full');
    },
  });
  const res = await host.invokeLoop('ci-green', {});
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
});

test('a validator request-changes iteration pulls Clawpatch findings into the next goal', async () => {
  const observed: string[] = [];
  const spec = codeLoopSpec();
  const states = [
    shipState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES', prExists: true, prNumber: 5 }),
    shipState({ headSha: 'sha-b', validatorOutcome: 'PASS', prExists: false }),
  ];
  let n = 0;
  const submitIntent = (_i: any) => `run-${++n}`;
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  const observeClawpatch = (runId: string) => {
    observed.push(runId);
    return {
      required: true,
      readable: true,
      status: 'fail',
      blockingFindings: [{ severity: 'high', count: 3 }],
      reportText: 'high: SQL injection risk in query builder',
      reportPath: '.clawpatch/report.md',
    };
  };
  const host = createLoopHost({ submitIntent, observeRun, store: fakeStore(spec), now: () => 0, observeClawpatch });
  const res = await host.invokeLoop('ci-green', {});
  assert.ok(res.iterations.length >= 2);
  assert.deepEqual(observed, ['run-1'], 'clawpatch observed only for the request-changes prior run');
  assert.match(res.iterations[1].goal, /3 high/);
  assert.match(res.iterations[1].goal, /SQL injection risk/);
});

test('run-form --input workspace/allow override the template target for the dispatched intent', async () => {
  const captured: any[] = [];
  // Template target has NO workspaceId and a broad allow; the run form supplies both.
  const spec = codeLoopSpec({
    routing: { agent: 'auto', skills: [], workspace: 'loops', target: { repo: '/repo', allow: ['**'] } },
  });
  const submitIntent = (intent: any) => {
    captured.push(intent);
    return `run-${captured.length}`;
  };
  const states = [runState({ headSha: 'sha-a', validatorOutcome: 'PASS' })];
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  const host = createLoopHost({ submitIntent, observeRun, store: fakeStore(spec), now: () => 0 });
  await host.invokeLoop('ci-green', { goal: 'ship it', workspace: 'prj_42', allow: 'src/**, docs/**' });
  assert.equal(captured[0].scope.workspaceId, 'prj_42');
  assert.deepEqual(captured[0].scope.allow, ['src/**', 'docs/**']);
});

// ---------------------------------------------------------------------------
// A2: killAll halts mid-loop
// ---------------------------------------------------------------------------

test('killAll halts the loop before the next dispatch', async () => {
  let submittedCount = 0;
  const states: any[] = [];
  let hostRef: any;
  const submitIntent = (intent: any) => {
    submittedCount += 1;
    // After the FIRST dispatch, trip the master kill so the 2nd never fires.
    if (submittedCount === 1) hostRef.killAll();
    states[submittedCount - 1] = runState({ headSha: `sha-${submittedCount}`, validatorOutcome: 'REQUEST-CHANGES' });
    return `run-${submittedCount}`;
  };
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  hostRef = createLoopHost({ submitIntent, observeRun, store: fakeStore(codeLoopSpec()), now: () => 0 });

  const res = await hostRef.invokeLoop('ci-green', {});
  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'killed');
  // exactly one dispatch happened; the kill stopped the second
  assert.equal(submittedCount, 1);
  // no active invocations remain
  assert.equal(hostRef.activeInvocations().length, 0);
});

test('regression: killAll does not poison the host — a later invokeLoop starts fresh', async () => {
  // Caught by the built-Electron behavioral test: killAll used to set a host-GLOBAL
  // sticky flag, so EVERY subsequent invokeLoop finished 'killed' with zero iterations.
  let submitted = 0;
  let killFirst = true;
  const states: any[] = [];
  let hostRef: any;
  const submitIntent = () => {
    submitted += 1;
    if (killFirst && submitted === 1) hostRef.killAll();
    // 1st invocation gets killed; the 2nd invocation's run is a clean validator
    // PASS with no open PR -> converges in a single iteration.
    states[submitted - 1] =
      killFirst && submitted === 1
        ? runState({ headSha: 'sha-1', validatorOutcome: 'REQUEST-CHANGES' })
        : runState({ headSha: `sha-${submitted}`, validatorOutcome: 'PASS' });
    return `run-${submitted}`;
  };
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  hostRef = createLoopHost({ submitIntent, observeRun, store: fakeStore(codeLoopSpec()), now: () => 0 });

  const first = await hostRef.invokeLoop('ci-green', {});
  assert.equal(first.finishReason, 'killed');
  assert.equal(submitted, 1);

  // A fresh invocation on the SAME host must dispatch + converge, NOT be killed.
  killFirst = false;
  const second = await hostRef.invokeLoop('ci-green', {});
  assert.ok(submitted >= 2, `second invocation must dispatch (submitted=${submitted})`);
  assert.notEqual(second.finishReason, 'killed');
  assert.equal(second.finishReason, 'converged');
});

test('stop(invocationId) halts a single invocation mid-loop', async () => {
  // Drive an invocation whose first iteration makes progress; stop it via its id
  // captured from a submitIntent side-channel, so the 2nd iteration never fires.
  let submittedCount = 0;
  const states: any[] = [];
  let hostRef: any;
  let invId: string | null = null;
  const submitIntent = (intent: any) => {
    submittedCount += 1;
    invId = `loopinv-ci-green-1`; // deterministic first id
    if (submittedCount === 1 && invId) hostRef.stop(invId);
    states[submittedCount - 1] = runState({ headSha: `sha-${submittedCount}`, validatorOutcome: 'REQUEST-CHANGES' });
    return `run-${submittedCount}`;
  };
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  hostRef = createLoopHost({ submitIntent, observeRun, store: fakeStore(codeLoopSpec()), now: () => 0 });

  const res = await hostRef.invokeLoop('ci-green', {});
  assert.equal(res.finishReason, 'killed');
  assert.equal(submittedCount, 1);
});

// ---------------------------------------------------------------------------
// A2: concurrencyCap respected across multiple concurrent invokeLoop calls
// ---------------------------------------------------------------------------

test('concurrencyCap is respected across many concurrent invokeLoop calls', async () => {
  const cap = 2;
  let peak = 0;
  let current = 0;

  // submitIntent + observeRun model an in-flight iteration: each dispatch occupies
  // a slot from submit until the FIRST observe resolves it. We assert the Host
  // never has more than `cap` iterations between submit and terminal observe.
  const pending = new Map<string, any>();
  let runCounter = 0;

  const submitIntent = async (intent: any) => {
    current += 1;
    if (current > peak) peak = current;
    // never exceed the cap
    assert.ok(current <= cap, `in-flight ${current} exceeded cap ${cap}`);
    await Promise.resolve();
    runCounter += 1;
    const runId = `run-${runCounter}`;
    // terminal on first observe: converged (PASS no PR)
    pending.set(runId, runState({ headSha: `sha-${runCounter}`, validatorOutcome: 'PASS' }));
    return runId;
  };
  const observeRun = async (runId: string) => {
    await Promise.resolve();
    const st = pending.get(runId) ?? null;
    if (st) {
      // releasing the iteration: it reached terminal, slot frees after driveIteration
      current -= 1;
    }
    return st;
  };

  // Each loop converges in ONE iteration (PASS no PR), so 5 concurrent invocations
  // = 5 single-iteration dispatches; with cap=2 the peak in-flight must stay <=2.
  const host = createLoopHost({
    submitIntent,
    observeRun,
    store: fakeStore(codeLoopSpec()),
    now: () => 0,
    concurrencyCap: cap,
  });

  const runs = await Promise.all([
    host.invokeLoop('ci-green', {}),
    host.invokeLoop('ci-green', {}),
    host.invokeLoop('ci-green', {}),
    host.invokeLoop('ci-green', {}),
    host.invokeLoop('ci-green', {}),
  ]);

  for (const r of runs) {
    assert.equal(r.finished, true);
    assert.equal(r.finishReason, 'converged');
  }
  assert.ok(peak <= cap, `peak in-flight ${peak} must be <= cap ${cap}`);
  assert.ok(peak >= 1, 'at least one iteration was in flight');
  // all slots released
  assert.equal(host.inFlightCount(), 0);
});

test('goalTemplate is rendered with inputs + prior evidence per iteration', async () => {
  const captured: any[] = [];
  const submitIntent = (intent: any) => {
    captured.push(intent.goal);
    return `run-${captured.length}`;
  };
  const states = [
    runState({ headSha: 'sha-a', validatorOutcome: 'REQUEST-CHANGES' }),
    runState({ headSha: 'sha-b', validatorOutcome: 'PASS' }),
  ];
  const observeRun = (runId: string) => states[Number(runId.split('-')[1]) - 1] ?? null;
  const host = createLoopHost({ submitIntent, observeRun, store: fakeStore(codeLoopSpec()), now: () => 0 });
  await host.invokeLoop('ci-green', {});
  assert.ok(captured[0].includes('iteration 0'));
  assert.ok(captured[1].includes('iteration 1'));
  // prior outcome threaded into iter1's goal (sha-a iter was request-changes -> NEEDS_OWNER_DECISION)
  assert.ok(captured[1].includes('prior='), 'prior token rendered');
});

// ---------------------------------------------------------------------------
// Slice 2: agentic (evidence-only) loops — converge on a finished worker, no
// validator / PR / merge gate (PRD §1/§9).
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
    evidence: { criteria: 'a sourced digest with a recommended action' },
    ...overrides,
  });
}

test('agentic: invokeLoop converges on a SINGLE finished-worker iteration (no validator, no PR)', async () => {
  const spec = agenticLoopSpec();
  const { host, submitted } = scriptedHost(spec, [
    runState({ workerDone: true, workerOutcome: 'DONE', headSha: 'sha-a' }),
  ]);
  const res = await host.invokeLoop('intel-digest', {});

  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
  assert.equal(res.iterations.length, 1, 'agentic loop ships on the first finished worker');
  assert.equal(submitted.length, 1);
  assert.equal(res.latestRunOutcome, 'DONE');
  // No validator/PR was involved.
  assert.equal(res.iterations[0].evidence.validatorDone, false);
  assert.equal(res.iterations[0].evidence.prExists, false);
});

test('agentic: an in-flight worker (not done) keeps looping, then ships once it finishes', async () => {
  const spec = agenticLoopSpec();
  const { host } = scriptedHost(spec, [
    // iter0: worker still running (no terminal) but produced a head -> progress, continue
    runState({ workerDone: false, workerOutcome: 'NONE', headSha: 'sha-a' }),
    // iter1: worker finished with a NEW head -> agentic DONE -> converged
    runState({ workerDone: true, workerOutcome: 'DONE', headSha: 'sha-b' }),
  ]);
  const res = await host.invokeLoop('intel-digest', {});

  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
  assert.ok(res.iterations.length >= 2);
});

test('agentic with requireComputerUseEvidence: a finished worker WITHOUT a CU attestation does not converge', async () => {
  const spec = agenticLoopSpec({
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: false, requireComputerUseEvidence: true },
      permissions: [],
      merge: { ownerGated: true },
    },
  });
  // Two finished-DONE iterations with the SAME head and NO computer-use evidence:
  // never satisfies the evidence gate -> not converged -> stalls no-progress.
  const { host } = scriptedHost(spec, [
    runState({ workerDone: true, workerOutcome: 'DONE', headSha: 'sha-a' }),
    runState({ workerDone: true, workerOutcome: 'DONE', headSha: 'sha-a' }),
  ]);
  const res = await host.invokeLoop('intel-digest', {});

  assert.equal(res.finished, true);
  assert.notEqual(res.finishReason, 'converged');
  assert.equal(res.finishReason, 'no-progress');
});

test('agentic with requireComputerUseEvidence: a finished worker WITH a CU attestation converges', async () => {
  const spec = agenticLoopSpec({
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: false, requireComputerUseEvidence: true },
      permissions: [],
      merge: { ownerGated: true },
    },
  });
  // A finished worker with a validator-attested computer-use evidence flag.
  const { host } = scriptedHost(spec, [
    runState({ workerDone: true, workerOutcome: 'DONE', headSha: 'sha-a', validatorOutcome: 'PASS', cu: true }),
  ]);
  const res = await host.invokeLoop('intel-digest', {});

  assert.equal(res.finished, true);
  assert.equal(res.finishReason, 'converged');
  assert.equal(res.iterations.length, 1);
});
