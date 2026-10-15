// loop-harness — the committed regression net for the mission-card bus loop.
//
// Drives the full chain IN PROCESS through the REAL load-bearing modules:
//   auto-rally (bus driver) · verdict.cts (trailer/scorecard parse) ·
//   acceptance-ledger.cts (temp-file ledger) · goal-validation-policy
//   (evidence-artifact readers) · pr-gate evaluateMergeGate +
//   integration-gateway (REAL gateway, mocked gh) — the exact field-shape
//   handoff layer where the old inline chain's broken-closed bug hid.
// The mission STORE is faked (local-core needs electron), but its gate mock
// COMPOSES the same real policy pieces local-core's missionGateFeature uses,
// so a behavior change in any of them breaks this harness loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoRally } = require('../../../../electron/ace-control/auto-rally.cts');
const { createChildRegistry, createMemoryDb } = require('../child-registry.cjs');
const acceptanceLedger = require('../acceptance-ledger.cjs');
const goalValidationPolicy = require('../goal-validation-policy.cjs');
const { evaluateMergeGate } = require('../pr-gate.cjs');
const { createIntegrationGateway, buildGatewayGateInput } = require('../../../../electron/integration-gateway.cjs');

const HEAD = 'abc123abc123';
const PR_URL = 'https://github.com/example-org/example-project/pull/7';

function createBus() {
  const listeners = new Map();
  const events: any[] = [];
  return {
    events,
    on(event: string, cb: any) {
      const list = listeners.get(event) || [];
      list.push(cb);
      listeners.set(event, list);
      return () => {};
    },
    emit(event: string, payload: any) {
      events.push({ event, payload });
      for (const cb of listeners.get(event) || []) cb(payload);
    },
    emitAny() {},
  };
}

// One temp artifact tree per fixture: .ace/goals/msn_1/ft_1/acceptance.json
// + .ace/goals/msn_1/validator/ft_1/{computer-use/completion.json,branch-proof.json}
function makeArtifacts({ withCompletion = true, withProof = true, completionSha = HEAD, proofSha = 'abc123a' } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-loop-'));
  const { ledgerPath } = acceptanceLedger.ensureAcceptanceLedger({
    rootDir,
    missionId: 'msn_1',
    featureId: 'ft_1',
    acceptance: [
      'CLI subcommand exits 0 with the new field',
      'Board card shows the new state chip',
      'Unit tests pass',
    ],
    behavioral: [
      { id: 'A1', artifactType: 'CLI', steps: ['run the command'], expected: 'exit 0', evidence: 'stdout' },
      { id: 'A2', artifactType: 'UI', steps: ['open board'], expected: 'chip visible', evidence: 'screenshot' },
    ],
  });
  const validatorDir = path.join(rootDir, '.ace', 'goals', 'msn_1', 'validator', 'ft_1');
  const completionJsonPath = path.join(validatorDir, 'computer-use', 'completion.json');
  const branchProofPath = path.join(validatorDir, 'branch-proof.json');
  if (withCompletion) {
    fs.mkdirSync(path.dirname(completionJsonPath), { recursive: true });
    fs.writeFileSync(completionJsonPath, JSON.stringify({
      schema: goalValidationPolicy.BEHAVIORAL_COMPLETION_SCHEMA,
      artifactType: 'UI',
      validatedHeadSha: completionSha,
      passed: true,
      regressionSmoke: { passed: true, notes: 'boot + overlay smoke ok' },
      checkedAcceptance: [
        { id: 'A1', status: 'pass', evidence: 'stdout.log' },
        { id: 'A2', status: 'pass', evidence: 'screenshots/after.png' },
      ],
    }));
  }
  if (withProof) {
    fs.mkdirSync(path.dirname(branchProofPath), { recursive: true });
    fs.writeFileSync(branchProofPath, JSON.stringify({ sha: proofSha, bootOk: true, socketOk: true, at: 'now' }));
  }
  return { rootDir, ledgerPath, completionJsonPath, branchProofPath };
}

// The REAL A7 gate composition (mirrors local-core missionGateFeature's
// evidence section): scorecard flips happened upstream; this reads the
// artifacts and decides merge_ready vs blocked.
function gateWithRealPolicy(state: any, artifacts: any, { validatedHeadSha, currentHeadSha }: any) {
  if (!validatedHeadSha || !currentHeadSha || validatedHeadSha !== currentHeadSha) {
    return { gateStatus: 'blocked', detail: 'exact-head mismatch' };
  }
  const ledger = acceptanceLedger.readAcceptanceLedger(artifacts.ledgerPath);
  const behavioralIds = acceptanceLedger.behavioralIds(ledger);
  const read = goalValidationPolicy.readBehavioralCompletion({
    completionJsonPath: artifacts.completionJsonPath,
    validatedHeadSha,
    requiredIds: behavioralIds,
  });
  if (!read.ok) return { gateStatus: 'blocked', detail: `behavioral evidence rejected: ${read.reason}` };
  for (const id of behavioralIds) {
    const entry = ledger.entries.find((e: any) => e.id === id);
    if (entry && entry.status !== 'passing') {
      acceptanceLedger.flipEntry(artifacts.ledgerPath, id, { evidence: artifacts.completionJsonPath, flippedBy: 'gate' });
    }
  }
  const failing = acceptanceLedger.countFailingInScope(acceptanceLedger.readAcceptanceLedger(artifacts.ledgerPath));
  if (failing > 0) return { gateStatus: 'blocked', detail: `${failing} failing ledger entries` };
  const proof = goalValidationPolicy.readBranchProof({ branchProofPath: artifacts.branchProofPath, validatedHeadSha });
  if (!proof.ok) return { gateStatus: 'blocked', detail: `branch-proof rejected: ${proof.reason}` };
  state.gateStatus = 'merge_ready';
  return { gateStatus: 'merge_ready', detail: 'all evidence verified' };
}

// gh-playing execFile mock for the REAL integration gateway. STATEFUL: after
// `pr merge` runs, subsequent `pr view` reports MERGED so the gateway's
// post-merge verification (poll-until-MERGED) resolves instead of retrying
// against a perpetually-OPEN fixture.
function ghScript(calls: any[], { headSha = HEAD, isDraft = false } = {}) {
  let merged = false;
  return (bin: any, args: any, _opts: any, cb: any) => {
    calls.push({ bin, args: args.slice() });
    if (args[0] === 'pr' && args[1] === 'view') {
      process.nextTick(() => cb(null, JSON.stringify({
        number: 7,
        url: PR_URL,
        state: merged ? 'MERGED' : 'OPEN',
        mergedAt: merged ? '2026-06-09T00:00:00Z' : null,
        mergeCommit: merged ? { oid: HEAD } : null,
        baseRefName: 'main',
        headRefName: 'feat/loop-test',
        headRefOid: headSha,
        baseRefOid: 'base000base000',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        isDraft,
        reviewDecision: null,
        files: [{ path: 'src/a/new-field.ts' }],
      }), ''));
      return;
    }
    if (args[0] === 'run' && args[1] === 'list') {
      process.nextTick(() => cb(null, JSON.stringify([{ status: 'completed', databaseId: 1, event: 'push' }]), ''));
      return;
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      merged = true;
      process.nextTick(() => cb(null, 'merged abc123abc123', ''));
      return;
    }
    process.nextTick(() => cb(null, '', ''));
  };
}

// Build the harness: real auto-rally over a fake store whose gate/merge legs
// run the real policy + the real gateway.
function makeLoop({ artifacts, autoChain = true, ghOpts = {}, fixbackBudget = { attempts: 0 } } = {} as any) {
  const bus = createBus();
  const registry = createChildRegistry({ db: createMemoryDb() });
  const ghCalls: any[] = [];
  const gateway = createIntegrationGateway({
    cwd: '/tmp',
    logger: { info() {}, warn() {}, error() {} },
    execFileImpl: ghScript(ghCalls, ghOpts),
  });
  const state: any = {
    gateStatus: null,
    releaseTaskId: null,
    validationDispatches: [],
    releaseDispatches: [],
    mergeEnvelope: null,
    autoChain,
  };
  registry.register({
    taskId: 'tsk_worker',
    streamId: 'variant:worker',
    workspaceId: 'prj_1',
    branch: 'feat/loop-test',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    laneId: 'ft_1',
  });
  registry.updatePrState('tsk_worker', { prUrl: PR_URL, prNumber: 7 });

  const client = {
    async invoke(method: string, params: any) {
      switch (method) {
        case 'missionSyncFeature':
          return { synced: true };
        case 'missionNextAction': {
          if (state.releaseDone) return { next: 'record_cleanup' };
          if (state.gateStatus === 'merge_ready') return { next: 'dispatch_release_goal' };
          if (state.workerDone) return { next: 'dispatch_goal_validator' };
          return { next: 'nothing' };
        }
        case 'missionAcceptanceLedgerPath':
          return {
            featureId: 'ft_1',
            missionId: 'msn_1',
            acceptanceLedgerPath: artifacts.ledgerPath,
            completionJsonPath: artifacts.completionJsonPath,
          };
        case 'missionPrepareValidation': {
          if (!state.autoChain && params.force !== true) {
            return { ready: false, reason: 'auto_chain_disabled', featureId: params.featureId };
          }
          state.validationDispatches.push(params);
          return { ready: true, featureId: 'ft_1', missionId: 'msn_1', workspaceId: 'prj_1', agent: 'claude', spec: { goal: 'validate' }, label: 'Validate ft_1' };
        }
        case 'missionGateFeature': {
          // The validator's PASS arrives here; run the REAL evidence policy.
          return gateWithRealPolicy(state, artifacts, {
            validatedHeadSha: HEAD,
            currentHeadSha: ghOpts.headSha || HEAD,
          });
        }
        case 'missionPrepareRelease': {
          if (!state.autoChain && params.force !== true) {
            return { ready: false, reason: 'auto_chain_disabled', featureId: params.featureId };
          }
          if (state.gateStatus !== 'merge_ready') return { ready: false, reason: 'gate not merge_ready' };
          if (state.releaseTaskId) return { ready: false, reason: 'release_already_dispatched' };
          state.releaseTaskId = 'pending:test';
          return { ready: true, featureId: 'ft_1', missionId: 'msn_1', workspaceId: 'prj_1', agent: 'codex', spec: { goal: 'release' }, label: 'Release ft_1' };
        }
        case 'missionAttachRelease':
          state.releaseTaskId = params.taskId;
          return { attached: true };
        case 'missionClearReleaseDispatch':
          if (String(state.releaseTaskId || '').startsWith('pending:')) state.releaseTaskId = null;
          return { cleared: true };
        case 'missionFixback':
          state.fixbacks = (state.fixbacks || 0) + 1;
          return fixbackBudget.exhausted
            ? { status: 'BLOCKED', fixback: { exhausted: true } }
            : { fixback: { attempts: state.fixbacks, remaining: 2 - state.fixbacks } };
        case 'integrationMergePr': {
          // THE REAL MERGE LEG: a previously computed gate RESULT (nested
          // expectedPr shape) goes through the real gateway, whose
          // buildGatewayGateInput + evaluateMergeGate must preserve the pin.
          const pinned = evaluateMergeGate({
            tracked: true,
            prNumber: 7,
            automerge: true,
            expectedHeadSha: HEAD,
            actualHeadSha: ghOpts.headSha || HEAD,
            headRefName: 'feat/loop-test',
            baseRefName: 'main',
            baseBranch: 'main',
            expectedBaseBranch: 'main',
            prState: 'OPEN',
            checkState: 'success',
            mergeable: 'MERGEABLE',
            changedFiles: ['src/a/new-field.ts'],
            allowedPaths: ['src/a/'],
            validation: { self: null, independent: 'PASS', fixback: null, required: true, highRisk: false },
            computerUseEvidence: true,
          });
          const envelope = await gateway.mergePr({
            prNumber: 7,
            taskId: params.taskId || 'tsk_release',
            gate: { ...pinned, allowedPaths: ['src/a/'] },
            feature: { computerUseEvidence: { verified: true } },
            missionRef: { missionId: 'msn_1', featureId: 'ft_1' },
            branch: 'feat/loop-test',
            worktreePath: '/tmp/wt',
          });
          state.mergeEnvelope = envelope;
          return envelope;
        }
        default:
          return {};
      }
    },
  };

  const rally = createAutoRally({
    bus,
    client,
    childRegistry: registry,
    runValidation: async (payload: any) => {
      const prepared = await client.invoke('missionPrepareValidation', payload);
      if (prepared.ready === false) return { dispatched: false, reason: prepared.reason };
      return { dispatched: true, validatorTaskId: 'tsk_validator' };
    },
    runRelease: async (payload: any) => {
      const prepared = await client.invoke('missionPrepareRelease', payload);
      if (prepared.ready !== true) return { dispatched: false, reason: prepared.reason };
      state.releaseDispatches.push(payload);
      // The release worker's first act in this harness: the gated merge
      // through the REAL gateway.
      const envelope = await client.invoke('integrationMergePr', { taskId: 'tsk_release' });
      if (!envelope?.ok) return { dispatched: false, reason: `merge blocked: ${(envelope?.result?.failures || []).map((f: any) => f.code).join(',')}` };
      await client.invoke('missionAttachRelease', { featureId: 'ft_1', taskId: 'tsk_release', streamId: 'variant:release' });
      registry.register({ taskId: 'tsk_release', workspaceId: 'prj_1', laneId: 'release:ft_1' });
      return { dispatched: true, taskId: 'tsk_release' };
    },
  });

  return { bus, rally, registry, state, ghCalls, client };
}

test('happy path: worker DONE → validator PASS+scorecard → ledger flips → evidence gate → REAL gated merge → release completion closes the card', async () => {
  const artifacts = makeArtifacts();
  const { bus, rally, state, ghCalls } = makeLoop({ artifacts });

  // 1. Worker DONE → validation dispatched.
  state.workerDone = true;
  const workerResult = await rally.handleRootWorkerCompletion({
    kind: 'done',
    taskId: 'tsk_worker',
    laneId: 'ft_1',
    workspaceId: 'prj_1',
    detail: 'implemented the new field',
  });
  assert.equal(workerResult.dispatched, true);
  assert.equal(state.validationDispatches.length, 1);

  // 2. Validator PASS with the canonical trailer + scorecard JSON.
  const verdictResult = await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    workspaceId: 'prj_1',
    detail: `VERDICT=pass on ${PR_URL} ${JSON.stringify({
      verdict: 'pass',
      taskId: 'tsk_worker',
      scorecard: [
        { id: 'A1', met: true, evidence: 'stdout.log' },
        { id: 'A2', met: 'deferred' },
        { id: 'A3', met: true, evidence: 'npm test output' },
      ],
    })}`,
  });
  assert.equal(verdictResult.action, 'pass');

  // Scorecard flipped A1+A3; the gate flipped the DEFERRED A2 from the
  // verified completion.json; zero failing remains.
  const ledger = acceptanceLedger.readAcceptanceLedger(artifacts.ledgerPath);
  assert.deepEqual(ledger.entries.map((e: any) => [e.id, e.status]), [
    ['A1', 'passing'],
    ['A2', 'passing'],
    ['A3', 'passing'],
  ]);
  assert.equal(state.gateStatus, 'merge_ready');

  // 3. The REAL gateway merged through the real gate (round-tripped pin).
  assert.equal(state.releaseDispatches.length, 1);
  assert.equal(state.mergeEnvelope?.ok, true);
  const mergeCall = ghCalls.find((c: any) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(mergeCall, 'gh pr merge must run');
  assert.ok(mergeCall.args.includes('--squash'));
  const bodyIdx = mergeCall.args.indexOf('--body');
  assert.ok(bodyIdx > 0, 'squash body must carry the mission trailer');
  assert.match(mergeCall.args[bodyIdx + 1], /Mission-Id: msn_1/);
  assert.match(mergeCall.args[bodyIdx + 1], /Feature-Id: ft_1/);

  // 4. Release worker DONE → completion routes and the card advances.
  state.releaseDone = true;
  const release = await rally.handleReleaseCompletion({
    kind: 'done',
    taskId: 'tsk_release',
    laneId: 'release:ft_1',
    workspaceId: 'prj_1',
    detail: 'merged to main, cleanup done',
  });
  assert.equal(release.action, 'release-completed');
  assert.ok(bus.events.some((e: any) => e.event === 'release-goal-completed'));
  assert.ok(!bus.events.some((e: any) => e.event === 'validator-escalation'));
});

test('spoof resistance: validator PASS with NO completion.json artifact never reaches merge', async () => {
  const artifacts = makeArtifacts({ withCompletion: false });
  const { rally, state, ghCalls } = makeLoop({ artifacts });
  state.workerDone = true;

  const verdictResult = await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    workspaceId: 'prj_1',
    detail: `VERDICT=pass on ${PR_URL} {"verdict":"pass","taskId":"tsk_worker","scorecard":[{"id":"A1","met":true,"evidence":"x"},{"id":"A2","met":true,"evidence":"claimed!"},{"id":"A3","met":true,"evidence":"y"}]}`,
  });
  assert.equal(verdictResult.action, 'pass'); // the verdict is recorded…
  assert.notEqual(state.gateStatus, 'merge_ready'); // …but the gate fail-closes
  assert.equal(state.releaseDispatches.length, 0);
  assert.ok(!ghCalls.some((c: any) => c.args[0] === 'pr' && c.args[1] === 'merge'), 'merge must never run');
});

test('stale evidence: completion.json at a different head fail-closes the gate', async () => {
  const artifacts = makeArtifacts({ completionSha: 'def456def456' });
  const { rally, state } = makeLoop({ artifacts });
  state.workerDone = true;
  await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    detail: `VERDICT=pass on ${PR_URL} {"verdict":"pass","taskId":"tsk_worker","scorecard":[{"id":"A1","met":true,"evidence":"x"},{"id":"A3","met":true,"evidence":"y"}]}`,
  });
  assert.notEqual(state.gateStatus, 'merge_ready');
  assert.equal(state.releaseDispatches.length, 0);
});

test('failing ledger entry: an UNMET criterion blocks the gate even with valid behavioral evidence', async () => {
  const artifacts = makeArtifacts();
  const { rally, state } = makeLoop({ artifacts });
  state.workerDone = true;
  await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    detail: `VERDICT=pass on ${PR_URL} {"verdict":"pass","taskId":"tsk_worker","scorecard":[{"id":"A1","met":true,"evidence":"x"},{"id":"A3","met":false,"reason":"tests red"}]}`,
  });
  assert.notEqual(state.gateStatus, 'merge_ready');
  assert.equal(state.releaseDispatches.length, 0);
});

test('missing branch-proof: auto-chain merge requires the packaged boot proof', async () => {
  const artifacts = makeArtifacts({ withProof: false });
  const { rally, state } = makeLoop({ artifacts });
  state.workerDone = true;
  await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    detail: `VERDICT=pass on ${PR_URL} {"verdict":"pass","taskId":"tsk_worker","scorecard":[{"id":"A1","met":true,"evidence":"x"},{"id":"A2","met":"deferred"},{"id":"A3","met":true,"evidence":"y"}]}`,
  });
  assert.notEqual(state.gateStatus, 'merge_ready');
});

test('draft PR: the REAL gateway refuses the merge even after a clean gate pass', async () => {
  const artifacts = makeArtifacts();
  const { rally, state } = makeLoop({ artifacts, ghOpts: { isDraft: true } });
  state.workerDone = true;
  await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    detail: `VERDICT=pass on ${PR_URL} {"verdict":"pass","taskId":"tsk_worker","scorecard":[{"id":"A1","met":true,"evidence":"x"},{"id":"A2","met":"deferred"},{"id":"A3","met":true,"evidence":"y"}]}`,
  });
  assert.equal(state.gateStatus, 'merge_ready'); // policy gate passed…
  assert.equal(state.mergeEnvelope?.ok, false); // …but the gateway fail-closed on draft
  assert.ok(state.mergeEnvelope.result.failures.some((f: any) => f.code === 'draft_pr'));
});

test('autoChain=0: the whole chain is inert (validation refusal is a quiet skip)', async () => {
  const artifacts = makeArtifacts();
  const { bus, rally, state } = makeLoop({ artifacts, autoChain: false });
  state.workerDone = true;
  const result = await rally.handleRootWorkerCompletion({
    kind: 'done',
    taskId: 'tsk_worker',
    laneId: 'ft_1',
    detail: 'implemented',
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'auto_chain_disabled');
  assert.equal(state.validationDispatches.length, 0);
  assert.ok(!bus.events.some((e: any) => e.event === 'validator-escalation'));
});

test('fixback budget: an exhausted budget escalates instead of looping', async () => {
  const artifacts = makeArtifacts();
  const { bus, rally } = makeLoop({ artifacts, fixbackBudget: { exhausted: true } });
  const result = await rally.handleValidatorCompletion({
    kind: 'done',
    taskId: 'tsk_validator',
    detail: `VERDICT=request-changes on ${PR_URL} {"verdict":"request-changes","taskId":"tsk_worker","findings":[{"criterion":"A3","status":"unmet","evidence":"tests red","fix":"fix tests"}]}`,
  });
  assert.equal(result.action, 'escalated');
  assert.equal(result.reason, 'rally_budget_exhausted');
  assert.ok(bus.events.some((e: any) => e.event === 'validator-escalation'));
});
