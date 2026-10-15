const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createChildRegistry,
  createMemoryDb,
  createFileDb,
  isInternalSubagentCompletion,
  isRootGoalAgentRow,
} = require('../child-registry.cjs');

test('child-registry: register creates a row with defaults and returns it', () => {
  const reg = createChildRegistry();
  const row = reg.register({
    taskId: 'tsk_1',
    branch: 'ace/foo',
    worktreePath: '/tmp/wt1',
  });
  assert.equal(row.taskId, 'tsk_1');
  assert.equal(row.branch, 'ace/foo');
  assert.equal(row.worktreePath, '/tmp/wt1');
  assert.equal(row.prNumber, null);
  assert.equal(row.prUrl, null);
  assert.equal(row.prState, null);
  assert.equal(row.workspaceId, null);
  assert.equal(row.baseBranch, null);
  assert.deepEqual(row.validation, {
    self: null,
    independent: null,
    fixback: null,
    required: false,
    highRisk: false,
    chiefOverride: false,
  });
  assert.ok(typeof row.updatedAt === 'number');
});

test('child-registry: get/list round-trip', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_a', branch: 'b-a', worktreePath: '/a' });
  reg.register({ taskId: 'tsk_b', branch: 'b-b', worktreePath: '/b' });
  assert.equal(reg.get('tsk_a').branch, 'b-a');
  assert.equal(reg.get('tsk_b').branch, 'b-b');
  assert.equal(reg.list().length, 2);
});

test('child-registry: updatePrState patches fields and bumps updatedAt', async () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_1', branch: 'b', worktreePath: '/w' });
  const first = reg.get('tsk_1');
  await new Promise((r) => setTimeout(r, 2));
  const updated = reg.updatePrState('tsk_1', {
    prNumber: 42,
    prUrl: 'https://github.com/o/r/pull/42',
    prState: 'open',
    prChecks: 'pending',
  });
  assert.equal(updated.prNumber, 42);
  assert.equal(updated.prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(updated.prState, 'open');
  assert.equal(updated.prChecks, 'pending');
  assert.ok(updated.updatedAt > first.updatedAt);
});

test('child-registry: updatePrState throws when row not registered', () => {
  const reg = createChildRegistry();
  assert.throws(
    () => reg.updatePrState('tsk_missing', { prState: 'open' }),
    /no row for taskId tsk_missing/
  );
});

test('child-registry: remove deletes the row', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_gone', branch: 'b', worktreePath: '/w' });
  assert.ok(reg.get('tsk_gone'));
  reg.remove('tsk_gone');
  assert.equal(reg.get('tsk_gone'), null);
});

test('child-registry: register requires taskId', () => {
  const reg = createChildRegistry();
  assert.throws(() => reg.register({}), /taskId required/);
});

test('child-registry: db injection is honored (memory db passes CRUD)', () => {
  const db = createMemoryDb();
  const reg = createChildRegistry({ db });
  reg.register({ taskId: 'tsk_x', branch: 'b', worktreePath: '/w' });
  assert.equal(db.get('tsk_x').branch, 'b');
});

test('child-registry: register stores waveId/laneId when provided', () => {
  const reg = createChildRegistry();
  const row = reg.register({
    taskId: 'tsk_w',
    branch: 'feat/x',
    worktreePath: '/w',
    waveId: 'wave-1',
    laneId: 'lane-A',
  });
  assert.equal(row.waveId, 'wave-1');
  assert.equal(row.laneId, 'lane-A');
  // Re-registering without wave/lane keeps the existing values.
  const reregistered = reg.register({ taskId: 'tsk_w', branch: 'feat/x', worktreePath: '/w' });
  assert.equal(reregistered.waveId, 'wave-1');
  assert.equal(reregistered.laneId, 'lane-A');
});

test('child-registry: worker-completion event marks a lane terminal without polling', () => {
  const reg = createChildRegistry();
  reg.register({ taskId: 'tsk_a', streamId: 'conversation:a', branch: 'feat/a', worktreePath: '/wa', waveId: 'wave-1', laneId: 'lane-a' });

  const row = reg.recordWorkerCompletion({
    streamId: 'conversation:a',
    taskId: 'tsk_a',
    workspaceId: 'prj_1',
    branch: 'feat/a',
    worktreePath: '/wa',
    prNumber: 42,
    prUrl: 'https://github.com/o/r/pull/42',
    waveId: 'wave-1',
    laneId: 'lane-a',
    outcome: 'done',
    detail: 'opened draft PR',
    timestamp: 1234,
  });

  assert.equal(row.streamId, 'conversation:a');
  assert.equal(row.laneStatus, 'done');
  assert.equal(row.lastTrailer, 'opened draft PR');
  assert.equal(row.terminalAt, 1234);
  assert.equal(row.prNumber, 42);
  assert.equal(row.prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(row.waveId, 'wave-1');
  assert.equal(row.laneId, 'lane-a');
  assert.equal(row.rootTaskId, 'tsk_a');
  assert.equal(row.parentTaskId, null);
  assert.equal(row.isRootGoalAgent, true);
  assert.equal(row.isInternalSubagent, false);
});

test('child-registry: child completions keep root lineage but are not root GoalAgents', () => {
  const reg = createChildRegistry();
  const row = reg.recordChildCompletion({
    streamId: 'conversation:child',
    taskId: 'tsk_child',
    parentTaskId: 'tsk_root',
    rootTaskId: 'tsk_root',
    workspaceId: 'prj_1',
    outcome: 'done',
    detail: 'child helper done',
  });

  assert.equal(row.parentTaskId, 'tsk_root');
  assert.equal(row.rootTaskId, 'tsk_root');
  assert.equal(row.isRootGoalAgent, false);
  assert.equal(row.isInternalSubagent, true);
  assert.equal(isInternalSubagentCompletion(row), true);
  assert.equal(isRootGoalAgentRow(row), false);
});

test('child-registry: file db persists across registry instances', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-child-reg-'));
  const file = path.join(tmp, 'registry.json');
  const a = createChildRegistry({ db: createFileDb(file) });
  a.register({ taskId: 'tsk_p', branch: 'bp', worktreePath: '/wp' });
  a.updatePrState('tsk_p', { prNumber: 9, prUrl: 'https://x/pull/9' });

  const b = createChildRegistry({ db: createFileDb(file) });
  const row = b.get('tsk_p');
  assert.equal(row.prNumber, 9);
  assert.equal(row.prUrl, 'https://x/pull/9');
  assert.equal(b.list().length, 1);
});
