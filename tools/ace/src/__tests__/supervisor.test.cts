const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  cleanupReadiness,
  createSupervisor,
  evaluateMergeGate,
  reconcileWorkspacePullRequests,
  rollupCheckState,
  FIXBACK_RETRY_MAX_ATTEMPTS,
} = require('../supervisor.cjs');
const { createChildRegistry } = require('../child-registry.cjs');
const { createFollowUpStore, createMemoryDb } = require('../follow-up-supervisor.cjs');

function makeGh(map: any) {
  // map: key (joined args) -> { ok, stdout?, stderr?, code? }, or function
  return async (args: any /* , opts */) => {
    const key = args.join(' ');
    const entry = map[key];
    if (typeof entry === 'function') return entry(args);
    if (entry) return { ok: true, code: 0, stdout: '', stderr: '', ...entry };
    return { ok: false, code: 1, stdout: '', stderr: `no mock for: ${key}` };
  };
}

function ansiWrapJson(value: any) {
  return `\u001b[36m\u001b]0;gh-json\u0007${JSON.stringify(value)}\u001b[0m\u0000`;
}

test('rollupCheckState: collapses gh status array into tri-state', () => {
  assert.equal(rollupCheckState(null), null);
  assert.equal(rollupCheckState([]), null);
  assert.equal(
    rollupCheckState([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }]),
    'success'
  );
  assert.equal(
    rollupCheckState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]),
    'pending'
  );
  assert.equal(
    rollupCheckState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]),
    'failure'
  );
});

test('supervisor: tickOnce refreshes intel and writes back to registry', async () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_1', branch: 'feat/x', worktreePath: '/w' });
  reg.updatePrState('tsk_1', { prNumber: 7 });

  const gh = makeGh({
    'pr view 7 --json state,mergeable,statusCheckRollup': {
      stdout: ansiWrapJson({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
  });
  const git = makeGh({
    'ls-remote --exit-code --heads origin feat/x': { stdout: 'sha\trefs/heads/feat/x\n' },
  });

  const sup = createSupervisor({ childRegistry: reg, gh, git, pollIntervalMs: 60_000 });
  const snap = await sup.tickOnce();
  assert.equal(snap.children.length, 1);
  const c = snap.children[0];
  assert.equal(c.prState, 'OPEN');
  assert.equal(c.checkState, 'success');
  assert.equal(c.mergeable, 'MERGEABLE');
  assert.equal(c.branchExistsRemote, true);
  assert.equal(c.cleanup.ready, true);
  assert.equal(c.cleanup.branch, 'feat/x');
  assert.equal(c.cleanup.worktreePath, '/w');

  const row = reg.get('tsk_1');
  assert.equal(row.prState, 'OPEN');
  assert.equal(row.checkState, 'success');
  assert.equal(row.mergeable, 'MERGEABLE');
  assert.equal(row.branchExistsRemote, true);
});

test('supervisor: reconciles open dev PRs into gate-aware classifications', async () => {
  const rows = [
    {
      taskId: 'tsk_73',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-73',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-73',
      prNumber: 73,
      validation: { self: 'PASS', independent: 'PASS', fixback: null },
    },
    {
      taskId: 'tsk_71',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-71',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-71',
      prNumber: 71,
      validation: { self: 'PASS', independent: null, fixback: null },
    },
    {
      taskId: 'tsk_19',
      streamId: 'conversation:worker-19',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-19',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-19',
      prNumber: 19,
      prUrl: 'https://github.com/owner/repo/pull/19',
      waveId: 'wave-1',
      laneId: 'lane-19',
      fixbackAttempts: 1,
      validation: { self: 'FAIL', independent: null, fixback: 'open' },
    },
    {
      taskId: 'tsk_20',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-20',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-20',
      prNumber: 20,
      fixbackAttempts: FIXBACK_RETRY_MAX_ATTEMPTS,
      validation: { self: 'PASS', independent: 'PASS', fixback: null },
    },
    {
      taskId: 'tsk_21',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-21',
      baseBranch: 'dev',
      prNumber: 21,
      validation: { self: 'PASS', independent: null, fixback: null },
    },
    {
      taskId: 'tsk_stale',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-stale',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-stale',
      prNumber: 17,
      validation: { self: 'PASS', independent: null, fixback: null },
    },
  ];
  const openPrs = [
    {
      number: 73,
      url: 'https://github.com/owner/repo/pull/73',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-73',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 71,
      url: 'https://github.com/owner/repo/pull/71',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-71',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'IN_PROGRESS' }],
    },
    {
      number: 18,
      url: 'https://github.com/owner/repo/pull/18',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-71',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 19,
      url: 'https://github.com/owner/repo/pull/19',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-19',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 20,
      url: 'https://github.com/owner/repo/pull/20',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-20',
      mergeable: 'CONFLICTING',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    },
    {
      number: 21,
      url: 'https://github.com/owner/repo/pull/21',
      state: 'OPEN',
      baseRefName: 'dev',
      headRefName: 'ace/pr-21',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    },
  ];
  const gh = makeGh({
    'pr list --state open --base dev --json number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision': {
      stdout: JSON.stringify(openPrs),
    },
  });

  const out = await reconcileWorkspacePullRequests({ rows, gh, baseBranch: 'dev' });
  assert.equal(out.ok, true);
  const byNumber = new Map(out.pullRequests.map((pr: any) => [pr.number, pr]));
  assert.deepEqual(
    [73, 71, 18, 19, 20, 21].map((n) => byNumber.get(n).classification),
    ['ready-to-review', 'active', 'superseded', 'needs-fixback', 'conflicting', 'needs-fixback']
  );
  assert.deepEqual(out.fixbackPackets.map((packet: any) => packet.prNumber), [19, 20, 21]);
  assert.deepEqual(byNumber.get(19).fixbackPacket.reasons, ['validation_failed', 'unresolved_fixback']);
  assert.equal(byNumber.get(19).fixbackPacket.streamId, 'conversation:worker-19');
  assert.equal(byNumber.get(19).fixbackPacket.taskId, 'tsk_19');
  assert.equal(byNumber.get(19).fixbackPacket.branch, 'ace/pr-19');
  assert.equal(byNumber.get(19).fixbackPacket.prUrl, 'https://github.com/owner/repo/pull/19');
  assert.equal(byNumber.get(19).fixbackPacket.worktreePath, '/tmp/wt-19');
  assert.equal(byNumber.get(19).fixbackPacket.waveId, 'wave-1');
  assert.equal(byNumber.get(19).fixbackPacket.laneId, 'lane-19');
  assert.equal(byNumber.get(19).fixbackPacket.action, 'delegate-fixback');
  // Cap is 2 (owner decision: ≤2 fixback rounds, then escalate); 1 attempt used.
  assert.equal(byNumber.get(19).fixbackPacket.retry.remaining, 1);
  assert.deepEqual(byNumber.get(20).fixbackPacket.reasons, ['conflicting_pr']);
  assert.equal(byNumber.get(20).fixbackPacket.action, 'retry-cap-exhausted');
  assert.equal(byNumber.get(20).fixbackPacket.merge.allowed, false);
  assert.deepEqual(byNumber.get(21).fixbackPacket.reasons, ['failed_pr_checks']);
  assert.equal(out.staleRows.length, 1);
  assert.equal(out.staleRows[0].taskId, 'tsk_stale');
  assert.equal(byNumber.get(73).gate.readyToMerge, true);
  assert.equal(byNumber.get(73).gate.cleanup.ready, true);
});

test('supervisor: reconciliation parses ANSI-wrapped gh --json stdout', async () => {
  const rows = [
    {
      taskId: 'tsk_90',
      workspaceId: 'prj-ce38979c',
      branch: 'ace/pr-90',
      baseBranch: 'dev',
      worktreePath: '/tmp/wt-90',
      prNumber: 90,
      prState: 'open',
    },
  ];
  const gh = makeGh({
    'pr list --state open --base dev --json number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision': {
      stdout: ansiWrapJson([]),
    },
    'pr view 90 --json number,url,state,title,headRefName,baseRefName,mergedAt,closedAt': {
      stdout: ansiWrapJson({
        number: 90,
        url: 'https://github.com/owner/repo/pull/90',
        state: 'MERGED',
        headRefName: 'ace/pr-90',
        baseRefName: 'dev',
        mergedAt: '2026-06-02T11:00:00Z',
      }),
    },
  });

  const out = await reconcileWorkspacePullRequests({ rows, gh, baseBranch: 'dev' });
  assert.equal(out.ok, true);
  assert.equal(out.error, undefined);
  assert.equal(out.staleRows.length, 1);
  assert.equal(out.staleRows[0].prState, 'merged');
  assert.equal(out.staleRows[0].classification, 'closed');
  assert.doesNotMatch(JSON.stringify(out), /Unexpected token/);
});

test('supervisor: stale registry rows are closed/merged/missing, not active truth', async () => {
  const rows = [
    {
      taskId: 'tsk_86',
      workspaceId: 'prj-ce38979c',
      branch: 'subagent-speed-ops-update',
      baseBranch: 'main',
      worktreePath: '/tmp/wt-86',
      prNumber: 86,
      prState: 'open',
    },
    {
      taskId: 'tsk_87',
      workspaceId: 'prj-ce38979c',
      branch: 'cli-board-ui-codex-update',
      baseBranch: 'main',
      worktreePath: '/tmp/wt-87',
      prNumber: 87,
      prState: 'open',
    },
    {
      taskId: 'tsk_88',
      workspaceId: 'prj-ce38979c',
      branch: 'native-tickets-feat-update',
      baseBranch: 'main',
      worktreePath: '/tmp/wt-88',
      prNumber: 88,
      prState: 'open',
    },
    {
      taskId: 'tsk_wrong_base',
      workspaceId: 'prj-ce38979c',
      branch: 'wrong-base',
      baseBranch: 'main',
      worktreePath: '/tmp/wt-wrong',
      prNumber: 89,
      prState: 'open',
    },
    {
      taskId: 'tsk_no_pr',
      workspaceId: 'prj-ce38979c',
      branch: 'pr-open-failed',
      baseBranch: 'main',
      worktreePath: '/tmp/wt-no-pr',
      prState: 'pr-open-failed',
    },
  ];
  const calls = [];
  const gh = async (args: any) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (key === 'pr list --state open --base main --json number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision') {
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    }
    if (key === 'pr view 86 --json number,url,state,title,headRefName,baseRefName,mergedAt,closedAt') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          number: 86,
          url: 'https://github.com/example-org/example-project/pull/86',
          state: 'MERGED',
          headRefName: 'subagent-speed-ops-update',
          baseRefName: 'main',
          mergedAt: '2026-05-04T12:00:00Z',
        }),
        stderr: '',
      };
    }
    if (key === 'pr view 87 --json number,url,state,title,headRefName,baseRefName,mergedAt,closedAt') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          number: 87,
          url: 'https://github.com/example-org/example-project/pull/87',
          state: 'CLOSED',
          headRefName: 'cli-board-ui-codex-update',
          baseRefName: 'main',
          closedAt: '2026-05-04T13:00:00Z',
        }),
        stderr: '',
      };
    }
    if (key === 'pr view 89 --json number,url,state,title,headRefName,baseRefName,mergedAt,closedAt') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          number: 89,
          url: 'https://github.com/example-org/example-project/pull/89',
          state: 'OPEN',
          headRefName: 'wrong-base',
          baseRefName: 'dev',
        }),
        stderr: '',
      };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'could not resolve to a PullRequest' };
  };

  const out = await reconcileWorkspacePullRequests({ rows, gh });
  assert.equal(out.ok, true);
  assert.equal(out.baseBranch, 'main');
  assert.ok(calls[0].includes('--base main'));
  const byTask = new Map(out.staleRows.map((row: any) => [row.taskId, row]));
  assert.deepEqual(
    ['tsk_86', 'tsk_87', 'tsk_88', 'tsk_wrong_base', 'tsk_no_pr'].map((taskId) => [
      taskId,
      byTask.get(taskId).prState,
      byTask.get(taskId).classification,
    ]),
    [
      ['tsk_86', 'merged', 'closed'],
      ['tsk_87', 'closed', 'closed'],
      ['tsk_88', 'missing', 'stale'],
      ['tsk_wrong_base', 'stale', 'stale'],
      ['tsk_no_pr', 'pr-open-failed', 'stale'],
    ]
  );
  assert.match(byTask.get('tsk_wrong_base').reason, /base dev, not reconciled base main/);
});

test('supervisor: merge gate enforces PR hygiene before ready-to-merge', () => {
  const denied = evaluateMergeGate({
    prNumber: 73,
    tracked: false,
    baseBranch: 'main',
    checkState: 'pending',
    mergeable: 'CONFLICTING',
    reviewDecision: 'REVIEW_REQUIRED',
    validation: { self: 'FAIL', independent: null, fixback: 'open', highRisk: true },
    expectedBaseBranch: 'dev',
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(
    denied.failures.map((failure: any) => failure.code),
    [
      'untracked_pr',
      'wrong_base_branch',
      'checks_not_green',
      'not_mergeable',
      'review_required',
      'validation_failed',
      'independent_validation_required',
      'unresolved_fixback',
      'cleanup_branch_unknown',
      'cleanup_worktree_unknown',
    ]
  );

  const allowedWithoutRecordedValidation = evaluateMergeGate({
    prNumber: 73,
    tracked: true,
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: null, independent: null, fixback: null, highRisk: false },
    branch: 'ace/pr-73',
    worktreePath: '/tmp/wt-73',
  });
  assert.equal(allowedWithoutRecordedValidation.ok, true);
  assert.equal(allowedWithoutRecordedValidation.readyToMerge, true);
  assert.equal(allowedWithoutRecordedValidation.expectedBaseBranch, 'main');
  assert.equal(allowedWithoutRecordedValidation.cleanup.ready, true);
  assert.deepEqual(allowedWithoutRecordedValidation.failures, []);

  const requiredValidationNeedsPass = evaluateMergeGate({
    prNumber: 75,
    tracked: true,
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: null, independent: null, fixback: null, required: true },
    branch: 'ace/pr-75',
    worktreePath: '/tmp/wt-75',
  });
  assert.equal(requiredValidationNeedsPass.ok, false);
  assert.deepEqual(
    requiredValidationNeedsPass.failures.map((failure: any) => failure.code),
    ['validation_required']
  );

  const highRiskNeedsIndependentPass = evaluateMergeGate({
    prNumber: 74,
    tracked: true,
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: 'PASS', independent: null, fixback: null, highRisk: true },
    branch: 'ace/pr-74',
    worktreePath: '/tmp/wt-74',
  });
  assert.equal(highRiskNeedsIndependentPass.ok, false);
  assert.deepEqual(
    highRiskNeedsIndependentPass.failures.map((failure: any) => failure.code),
    ['independent_validation_required']
  );

  const changesRequestedBlocksMerge = evaluateMergeGate({
    prNumber: 76,
    tracked: true,
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    reviewDecision: 'CHANGES_REQUESTED',
    validation: { self: 'PASS', independent: null, fixback: null, highRisk: false },
    branch: 'ace/pr-76',
    worktreePath: '/tmp/wt-76',
  });
  assert.equal(changesRequestedBlocksMerge.ok, false);
  assert.deepEqual(
    changesRequestedBlocksMerge.failures.map((failure: any) => failure.code),
    ['changes_requested']
  );

  assert.deepEqual(cleanupReadiness({ branch: 'b', worktreePath: '/w' }), {
    required: true,
    ready: true,
    branch: 'b',
    worktreePath: '/w',
    branchExistsRemote: null,
    missing: [],
  });
});

test('supervisor: tick loop fires on the configured interval', async () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 't_loop', branch: null });
  // No prNumber, no branch — fetchChildIntel is a no-op but tick still runs.
  const gh = makeGh({});
  const git = makeGh({});
  let ticks = 0;
  const sup = createSupervisor({
    childRegistry: reg,
    gh,
    git,
    pollIntervalMs: 15,
    onTick: () => { ticks += 1; },
  });
  sup.start();
  await new Promise((r) => setTimeout(r, 80));
  sup.stop();
  assert.ok(ticks >= 2, `expected >=2 ticks, got ${ticks}`);
});

test('supervisor: onStuck triggers after >2 ticks without intel change', async () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 't_stuck', branch: 'b' });
  reg.updatePrState('t_stuck', { prNumber: 99 });

  const stableView = {
    stdout: JSON.stringify({
      state: 'OPEN',
      mergeable: 'CONFLICTING',
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    }),
  };
  const gh = makeGh({
    'pr view 99 --json state,mergeable,statusCheckRollup': stableView,
  });
  const git = makeGh({
    'ls-remote --exit-code --heads origin b': { stdout: 'sha\trefs/heads/b\n' },
  });

  const stuckIds: any[] = [];
  const sup = createSupervisor({
    childRegistry: reg,
    gh,
    git,
    pollIntervalMs: 60_000,
    onStuck: (id: any) => stuckIds.push(id),
  });

  await sup.tickOnce(); // baseline (stuckTicks=0, no fire)
  await sup.tickOnce(); // unchanged → stuckTicks=1
  assert.deepEqual(stuckIds, []);
  await sup.tickOnce(); // unchanged → stuckTicks=2 (not > 2 yet)
  assert.deepEqual(stuckIds, []);
  await sup.tickOnce(); // unchanged → stuckTicks=3 (> 2) → fires
  assert.deepEqual(stuckIds, ['t_stuck']);
});

test('supervisor: onStuck stays silent when intel changes between ticks', async () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 't_progress', branch: 'b' });
  reg.updatePrState('t_progress', { prNumber: 7 });

  const states = [
    { state: 'OPEN', mergeable: 'UNKNOWN', statusCheckRollup: [{ status: 'IN_PROGRESS' }] },
    { state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    { state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    { state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    { state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
  ];
  let i = 0;
  const gh = async (args: any) => {
    if (args.join(' ').startsWith('pr view 7')) {
      const body = states[Math.min(i, states.length - 1)];
      i += 1;
      return { ok: true, code: 0, stdout: JSON.stringify(body), stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unmocked' };
  };
  const git = makeGh({
    'ls-remote --exit-code --heads origin b': { stdout: 'sha\trefs/heads/b\n' },
  });

  const stuckIds: any[] = [];
  const sup = createSupervisor({
    childRegistry: reg,
    gh,
    git,
    pollIntervalMs: 60_000,
    onStuck: (id: any) => stuckIds.push(id),
  });

  for (let n = 0; n < 5; n++) await sup.tickOnce();
  // Only the last two ticks were stable; counter never exceeded 2.
  assert.deepEqual(stuckIds, []);
});

test('supervise --live: prints one JSON line per tick', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-supervise-live-'));
  const store = path.join(tmp, 'registry.json');
  fs.writeFileSync(store, JSON.stringify({}));

  const bin = path.join(__dirname, '..', '..', 'bin', 'ace');
  const proc = spawn(
    'node',
    [bin, 'supervise', '--workspace', 'prj_any', '--live', '--interval-ms', '20', '--max-ticks', '2'],
    {
      env: { ...process.env, ACE_CHILD_REGISTRY_PATH: store },
    }
  );

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: any) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: any) => { stderr += d.toString(); });

  const code = await new Promise((resolve) => {
    proc.on('exit', (c: any) => resolve(c));
    setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 5000);
  });
  assert.equal(code, 0, `exit ${code}; stderr=${stderr}; stdout=${stdout}`);

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length >= 2, `expected >=2 JSON lines, got ${lines.length}: ${stdout}`);
  for (const line of lines.slice(0, 2)) {
    const env = JSON.parse(line);
    assert.equal(env.ok, true);
    assert.equal(env.data.workspace, 'prj_any');
    assert.ok(Array.isArray(env.data.children));
    assert.ok(Array.isArray(env.data.fixbackPackets));
    assert.ok(env.data.followUps);
    assert.ok(typeof env.data.tickAt === 'number');
  }
});

test('supervisor: tickOnce persists durable follow-up digest and pings transitions', async () => {
  const reg = createChildRegistry();
  reg.register({
    workspaceId: 'prj_1',
    taskId: 'tsk_follow',
    streamId: 'conversation:follow',
    branch: 'feat/follow',
    worktreePath: '/tmp/follow',
  });
  reg.recordWorkerCompletion({
    workspaceId: 'prj_1',
    taskId: 'tsk_follow',
    streamId: 'conversation:follow',
    branch: 'feat/follow',
    worktreePath: '/tmp/follow',
    prNumber: 88,
    prUrl: 'https://github.com/o/r/pull/88',
    kind: 'done',
  });

  const gh = makeGh({
    'pr view 88 --json state,mergeable,statusCheckRollup': {
      stdout: JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ status: 'IN_PROGRESS' }],
      }),
    },
    'pr list --state open --base main --json number,title,headRefName,baseRefName,state,mergeable,statusCheckRollup,reviewDecision,url,author,additions,deletions,changedFiles,updatedAt,isDraft': {
      stdout: JSON.stringify([{
        number: 88,
        title: 'Follow up',
        headRefName: 'feat/follow',
        baseRefName: 'main',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ status: 'IN_PROGRESS' }],
        reviewDecision: 'REVIEW_REQUIRED',
        url: 'https://github.com/o/r/pull/88',
        author: { login: 'bot' },
        additions: 1,
        deletions: 0,
        changedFiles: [],
        updatedAt: new Date(0).toISOString(),
        isDraft: false,
      }]),
    },
    'pr view 88 --json body,comments,reviews,files,commits,closingIssuesReferences,headRefName,baseRefName,headRefOid,baseRefOid': {
      stdout: JSON.stringify({
        body: 'DONE: follow',
        comments: [],
        reviews: [],
        files: [],
        commits: [{ oid: 'abc123' }],
        closingIssuesReferences: [],
        headRefName: 'feat/follow',
        baseRefName: 'main',
        headRefOid: 'abc123',
        baseRefOid: 'base123',
      }),
    },
  });
  const git = makeGh({
    'ls-remote --exit-code --heads origin feat/follow': { stdout: 'sha\trefs/heads/feat/follow\n' },
  });
  const followUpStore = createFollowUpStore({ db: createMemoryDb() });
  const sup = createSupervisor({
    childRegistry: reg,
    gh,
    git,
    followUpStore,
    pollIntervalMs: 60_000,
  });

  const snap = await sup.tickOnce();
  assert.equal(snap.followUps.records.length, 1);
  assert.deepEqual(snap.followUps.pings.map((p: any) => p.phase), ['PR-checks-running']);
  assert.equal(snap.followUps.digest.pendingCount, 1);
  assert.equal(snap.followUps.digest.items[0].prNumber, 88);

  const repeated = await sup.tickOnce();
  assert.deepEqual(repeated.followUps.pings, []);
});
