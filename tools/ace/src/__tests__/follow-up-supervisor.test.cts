const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildFollowUpDigest,
  classifyFollowUp,
  createFollowUpStore,
  updateFollowUpsFromSupervisorSnapshot,
} = require('../follow-up-supervisor.cjs');

function store() {
  return createFollowUpStore({ db: require('../follow-up-supervisor.cjs').createMemoryDb() });
}

test('follow-up classifier keeps a still-busy worker pending without ping-worthy action', () => {
  const s = store();
  const result = s.upsert({
    row: {
      workspaceId: 'prj_1',
      taskId: 'tsk_busy',
      streamId: 'conversation:busy',
      branch: 'feat/busy',
    },
    now: 1_000,
  });

  assert.equal(result.record.phase, 'waiting-worker');
  assert.equal(result.record.nextActionOwner, 'worker');
  assert.equal(result.ping, null);
  const digest = s.digest({ workspaceId: 'prj_1', now: 1_100 });
  assert.equal(digest.pendingCount, 1);
  assert.equal(digest.items[0].state, 'waiting-worker');
});

test('worker DONE with PR persists identity fields and owner action packet', () => {
  const s = store();
  const result = s.upsert({
    row: {
      workspaceId: 'prj_1',
      taskId: 'tsk_done',
      streamId: 'conversation:done',
      branch: 'feat/done',
      worktreePath: '/tmp/feat-done',
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      laneStatus: 'done',
    },
    child: { taskId: 'tsk_done', checkState: 'pending' },
    now: 2_000,
  });

  assert.equal(result.record.phase, 'PR-checks-running');
  assert.equal(result.record.prNumber, 42);
  assert.equal(result.record.streamId, 'conversation:done');
  assert.equal(result.record.worktreePath, '/tmp/feat-done');
  assert.equal(result.record.ownerActionPacket.managerTracks, 'The manager will keep checking the lane automatically.');
  assert.equal(result.ping.phase, 'PR-checks-running');
  assert.equal(result.ping.nextAction, 'poll PR checks and mergeability');
});

test('PR checks fail then pass emits one ping per actionable transition', () => {
  const s = store();
  const row = {
    workspaceId: 'prj_1',
    taskId: 'tsk_pr',
    streamId: 'conversation:pr',
    branch: 'feat/pr',
    worktreePath: '/tmp/feat-pr',
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    laneStatus: 'done',
  };

  const pending = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_pr', checkState: 'pending' }],
    prReconciliation: {
      pullRequests: [{ taskId: 'tsk_pr', number: 7, checkState: 'pending', mergeable: 'UNKNOWN', classification: 'active' }],
    },
    now: 3_000,
  });
  assert.deepEqual(pending.pings.map((p: any) => p.phase), ['PR-checks-running']);

  const failed = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_pr', checkState: 'failure' }],
    prReconciliation: {
      pullRequests: [{ taskId: 'tsk_pr', number: 7, checkState: 'failure', mergeable: 'MERGEABLE', classification: 'needs-fixback' }],
    },
    now: 4_000,
  });
  assert.deepEqual(failed.pings.map((p: any) => p.phase), ['fixback-needed']);
  assert.equal(failed.records[0].stopCondition, 'validation failed');

  const passed = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_pr', checkState: 'success' }],
    prReconciliation: {
      pullRequests: [{
        taskId: 'tsk_pr',
        number: 7,
        checkState: 'success',
        mergeable: 'MERGEABLE',
        classification: 'ready-to-review',
        gate: { ok: true, readyToMerge: true, failures: [] },
      }],
    },
    now: 5_000,
  });
  assert.deepEqual(passed.pings.map((p: any) => p.phase), ['merge-ready']);

  const repeated = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_pr', checkState: 'success' }],
    prReconciliation: {
      pullRequests: [{
        taskId: 'tsk_pr',
        number: 7,
        checkState: 'success',
        mergeable: 'MERGEABLE',
        classification: 'ready-to-review',
        gate: { ok: true, readyToMerge: true, failures: [] },
      }],
    },
    now: 6_000,
  });
  assert.deepEqual(repeated.pings, []);
});

test('gate states classify ready-to-review and blocked without raw stream dumps', () => {
  const ready = classifyFollowUp({
    row: { workspaceId: 'prj_1', taskId: 'tsk_review', prNumber: 11, laneStatus: 'done' },
    pr: {
      taskId: 'tsk_review',
      number: 11,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      classification: 'active',
      gate: { ok: false, readyToMerge: false, failures: [{ code: 'review_required' }] },
    },
    now: 7_000,
  });
  assert.equal(ready.phase, 'ready-to-review');
  assert.equal(ready.nextActionOwner, 'owner');
  assert.doesNotMatch(JSON.stringify(ready), /dormant/i);

  const blocked = classifyFollowUp({
    row: { workspaceId: 'prj_1', taskId: 'tsk_blocked_gate', prNumber: 12, laneStatus: 'done' },
    pr: {
      taskId: 'tsk_blocked_gate',
      number: 12,
      checkState: 'success',
      mergeable: 'MERGEABLE',
      classification: 'active',
      gate: { ok: false, readyToMerge: false, failures: [{ code: 'base_sha_mismatch' }] },
    },
    now: 8_000,
  });
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.eventTrigger, 'gate-blocked');
  assert.match(blocked.nextAction, /base_sha_mismatch/);
});

test('stale watcher blocks once and recovers when live PR state changes', () => {
  const s = store();
  const row = {
    workspaceId: 'prj_1',
    taskId: 'tsk_stale',
    streamId: 'conversation:stale',
    branch: 'feat/stale',
    prNumber: 19,
  };

  const stale = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_stale', prNumber: 19, stuckTicks: 3 }],
    now: 9_000,
  });
  assert.equal(stale.records[0].phase, 'blocked');
  assert.deepEqual(stale.pings.map((p: any) => p.phase), ['blocked']);

  const recovered = updateFollowUpsFromSupervisorSnapshot({
    store: s,
    rows: [row],
    children: [{ taskId: 'tsk_stale', prNumber: 19, checkState: 'pending', stuckTicks: 0 }],
    prReconciliation: {
      pullRequests: [{ taskId: 'tsk_stale', number: 19, checkState: 'pending', mergeable: 'UNKNOWN', classification: 'active' }],
    },
    now: 10_000,
  });
  assert.equal(recovered.records[0].phase, 'PR-checks-running');
  assert.deepEqual(recovered.pings.map((p: any) => p.phase), ['PR-checks-running']);
});

test('session rehydration digest survives a fresh file-backed store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-follow-ups-'));
  const filePath = path.join(dir, 'follow-ups.json');
  const first = createFollowUpStore({ filePath, now: () => 11_000 });
  first.upsert({
    row: {
      workspaceId: 'prj_1',
      taskId: 'tsk_rehydrate',
      streamId: 'conversation:rehydrate',
      prNumber: 31,
      prUrl: 'https://github.com/o/r/pull/31',
      laneStatus: 'done',
    },
    child: { taskId: 'tsk_rehydrate', checkState: 'pending' },
    now: 11_000,
  });

  const second = createFollowUpStore({ filePath, now: () => 12_000 });
  const digest = second.digest({ workspaceId: 'prj_1', now: 12_000 });
  assert.equal(digest.$schema, 'ace.follow-up-digest.v1');
  assert.equal(digest.pendingCount, 1);
  assert.equal(digest.items[0].taskId, 'tsk_rehydrate');
  assert.match(digest.text, /PR #31: PR-checks-running/);

  const standalone = buildFollowUpDigest(second.list({ workspaceId: 'prj_1' }), { now: 12_100 });
  assert.equal(standalone.items[0].evidenceLink, 'https://github.com/o/r/pull/31');
});
