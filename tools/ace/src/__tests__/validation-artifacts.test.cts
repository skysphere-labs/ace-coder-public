const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeValidationResult,
  isValidationResult,
  normalizeValidationFailurePacket,
  isValidationFailurePacket,
  normalizeFixbackPacket,
  isFixbackPacket,
  normalizeWaveVerdict,
  createWaveVerdict,
  isWaveVerdict,
  normalizeMergeResult,
  isMergeResult,
  normalizeCleanupResult,
  isCleanupResult,
} = require('../validation-artifacts.cts');

const BASE = {
  round: 2,
  taskId: 'task-123',
  streamId: 'conversation:worker-123',
  worktreePath: '/tmp/ace/worktrees/task-123',
  waveId: 'milestone_1',
  laneId: 'lane_backend',
  prUrl: 'https://github.com/example-org/example-project/pull/127',
  branch: 'validator-artifacts-foundation-o-update',
  baseBranch: 'main',
};

test('normalizeValidationResult: accepts PASS, FAIL, and BLOCKED statuses', () => {
  const pass = normalizeValidationResult({ ...BASE, status: 'PASS', summary: 'validator passed' });
  assert.equal(pass.schema, 'ValidationResult/v1');
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.round, 2);
  assert.equal(pass.taskId, BASE.taskId);
  assert.equal(pass.prUrl, BASE.prUrl);
  assert.equal(pass.prNumber, 127);
  assert.equal(pass.branch, BASE.branch);
  assert.equal(pass.baseBranch, 'main');
  assert.deepEqual(pass.blockerReasons, []);
  assert.equal(pass.summary, 'validator passed');

  const fail = normalizeValidationResult({
    ...BASE,
    status: 'fail',
    blockerReasons: [{ code: 'validation_failed', message: 'lint failed' }],
  });
  assert.equal(fail.status, 'FAIL');
  assert.deepEqual(fail.blockerReasons, [{ code: 'validation_failed', message: 'lint failed' }]);

  const blocked = normalizeValidationResult({
    ...BASE,
    status: 'BLOCKED',
    blockerReasons: [{ code: 'missing_validator_context', message: 'validator transcript unavailable' }],
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.blockerReasons, [
    { code: 'missing_validator_context', message: 'validator transcript unavailable' },
  ]);
});

test('normalizeValidationResult: rejects invalid round numbers and missing blocker reason codes', () => {
  assert.throws(
    () => normalizeValidationResult({ ...BASE, status: 'PASS', round: 0 }),
    /round must be a positive integer/
  );
  assert.throws(
    () => normalizeValidationResult({ ...BASE, status: 'BLOCKED' }),
    /BLOCKED artifacts require at least one blocker reason code/
  );
  assert.equal(isValidationResult({ ...BASE, status: 'PASS', round: 1 }), true);
  assert.equal(isValidationResult({ ...BASE, status: 'BLOCKED' }), false);
});

test('normalizeValidationFailurePacket: maps non-pass verdicts to FAIL or BLOCKED packets', () => {
  const failPacket = normalizeValidationFailurePacket({
    ...BASE,
    verdict: 'request-changes',
    reasons: ['validation_failed'],
    failingChecks: ['npm run lint'],
    failingFiles: ['tools/ace/src/validation-artifacts.cts'],
    expected: 'schema helper normalizes validator artifacts',
    actual: 'round was accepted as zero',
    rootCause: 'schema_validation_gap',
    reproduction: ['node --test --require tsx/cjs tools/ace/src/__tests__/validation-artifacts.test.cts'],
  });
  assert.equal(failPacket.schema, 'ValidationFailurePacket/v1');
  assert.equal(failPacket.status, 'FAIL');
  assert.equal(failPacket.verdict, 'request-changes');
  assert.deepEqual(failPacket.blockerReasons, [{ code: 'validation_failed', message: null }]);
  assert.deepEqual(failPacket.failingChecks, ['npm run lint']);
  assert.deepEqual(failPacket.failingFiles, ['tools/ace/src/validation-artifacts.cts']);
  assert.equal(failPacket.expected, 'schema helper normalizes validator artifacts');
  assert.equal(failPacket.actual, 'round was accepted as zero');
  assert.equal(failPacket.rootCause, 'schema_validation_gap');
  assert.equal(isValidationFailurePacket(failPacket), true);

  const blockedPacket = normalizeValidationFailurePacket({
    ...BASE,
    verdict: 'block',
    blockerReasons: [{ code: 'conflicting_pr', message: 'PR cannot merge cleanly' }],
  });
  assert.equal(blockedPacket.status, 'BLOCKED');
  assert.equal(blockedPacket.verdict, 'block');
  assert.deepEqual(blockedPacket.blockerReasons, [{ code: 'conflicting_pr', message: 'PR cannot merge cleanly' }]);
});

test('normalizeValidationFailurePacket: rejects PASS packets', () => {
  assert.throws(
    () => normalizeValidationFailurePacket({ ...BASE, status: 'PASS' }),
    /status must be FAIL or BLOCKED/
  );
  assert.equal(isValidationFailurePacket({ ...BASE, status: 'PASS' }), false);
});

test('normalizeFixbackPacket: preserves PR, branch, task, round, and retry fields', () => {
  const packet = normalizeFixbackPacket({
    ...BASE,
    action: 'delegate-fixback',
    validationFailure: {
      ...BASE,
      status: 'FAIL',
      blockerReasons: [{ code: 'failed_pr_checks', message: 'typecheck failed' }],
      failingChecks: ['npm run build'],
    },
    retry: { attempts: 1, maxAttempts: 3 },
  });

  assert.equal(packet.schema, 'FixbackPacket/v1');
  assert.equal(packet.action, 'delegate-fixback');
  assert.equal(packet.status, 'FAIL');
  assert.equal(packet.round, 2);
  assert.equal(packet.taskId, BASE.taskId);
  assert.equal(packet.streamId, BASE.streamId);
  assert.equal(packet.worktreePath, BASE.worktreePath);
  assert.equal(packet.waveId, BASE.waveId);
  assert.equal(packet.laneId, BASE.laneId);
  assert.equal(packet.prNumber, 127);
  assert.equal(packet.branch, BASE.branch);
  assert.deepEqual(packet.blockerReasons, [{ code: 'failed_pr_checks', message: 'typecheck failed' }]);
  assert.deepEqual(packet.validationFailure.blockerReasons, [
    { code: 'failed_pr_checks', message: 'typecheck failed' },
  ]);
  assert.deepEqual(packet.retry, { attempts: 1, maxAttempts: 3, remaining: 2, exhausted: false });
  assert.equal(isFixbackPacket(packet), true);
});

test('normalizeWaveVerdict: records PASS lane and PR evidence', () => {
  const verdict = normalizeWaveVerdict({
    status: 'PASS',
    missionId: 'msn_123',
    waveId: 'milestone_1',
    validatorTaskId: 'validator-task',
    validatorStreamId: 'validator-stream',
    laneVerdicts: [
      {
        laneId: 'lane_backend',
        featureId: 'ft_backend',
        status: 'PASS',
        taskId: BASE.taskId,
        streamId: 'worker-stream',
        worktreePath: BASE.worktreePath,
        prUrl: BASE.prUrl,
        branch: BASE.branch,
        baseBranch: BASE.baseBranch,
        evidence: ['lint and build passed'],
      },
    ],
    evidence: ['wave validator passed'],
  });

  assert.equal(verdict.schema, 'WaveVerdict/v1');
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.missionId, 'msn_123');
  assert.equal(verdict.waveId, 'milestone_1');
  assert.equal(verdict.mergeAllowed, true);
  assert.deepEqual(verdict.evidence, ['wave validator passed']);
  assert.equal(verdict.laneVerdicts[0].prNumber, 127);
  assert.equal(verdict.laneVerdicts[0].streamId, 'worker-stream');
  assert.deepEqual(verdict.failingLanes, []);
  assert.deepEqual(verdict.fixbackPackets, []);
  assert.equal(isWaveVerdict(verdict), true);
});

test('createWaveVerdict: FAIL routes fixback to original worker branch and PR', () => {
  const verdict = createWaveVerdict({
    status: 'FAIL',
    round: 2,
    missionId: 'msn_123',
    waveId: 'milestone_1',
    validatorTaskId: 'validator-task',
    validatorStreamId: 'validator-stream',
    laneVerdicts: [
      {
        laneId: 'lane_backend',
        featureId: 'ft_backend',
        status: 'FAIL',
        taskId: BASE.taskId,
        streamId: 'worker-stream',
        worktreePath: BASE.worktreePath,
        prUrl: BASE.prUrl,
        branch: BASE.branch,
        baseBranch: BASE.baseBranch,
        blockerReasons: [{ code: 'validation_failed', message: 'validator rejected lane' }],
        failingChecks: ['npm run lint'],
        failingFiles: ['tools/ace/src/validation-artifacts.cts'],
        expected: 'wave verdict should route same-worker fixback',
        actual: 'no fixback packet was emitted',
      },
    ],
    evidence: ['validator found lane_backend regression'],
  });

  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.mergeAllowed, false);
  assert.equal(verdict.failingLanes.length, 1);
  assert.equal(verdict.failingLanes[0].laneId, 'lane_backend');
  assert.equal(verdict.fixbackPackets.length, 1);

  const packet = verdict.fixbackPackets[0];
  assert.equal(packet.schema, 'FixbackPacket/v1');
  assert.equal(packet.action, 'delegate-fixback');
  assert.equal(packet.status, 'FAIL');
  assert.equal(packet.round, 2);
  assert.equal(packet.taskId, BASE.taskId);
  assert.equal(packet.streamId, 'worker-stream');
  assert.equal(packet.worktreePath, BASE.worktreePath);
  assert.equal(packet.waveId, 'milestone_1');
  assert.equal(packet.laneId, 'lane_backend');
  assert.equal(packet.prUrl, BASE.prUrl);
  assert.equal(packet.prNumber, 127);
  assert.equal(packet.branch, BASE.branch);
  assert.equal(packet.baseBranch, BASE.baseBranch);
  assert.deepEqual(packet.blockerReasons, [{ code: 'validation_failed', message: 'validator rejected lane' }]);
  assert.deepEqual(packet.validationFailure.failingChecks, ['npm run lint']);
});

test('normalizeWaveVerdict: BLOCKED requires blocker reasons and blocks merge', () => {
  const blocked = normalizeWaveVerdict({
    status: 'BLOCKED',
    missionId: 'msn_123',
    waveId: 'milestone_1',
    blockerReasons: [{ code: 'missing_validator_context', message: 'validator transcript missing' }],
    laneVerdicts: [
      {
        laneId: 'lane_backend',
        status: 'BLOCKED',
        blockerReasons: [{ code: 'missing_worker_pr', message: 'worker PR was not available' }],
      },
    ],
  });

  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.mergeAllowed, false);
  assert.deepEqual(blocked.blockerReasons, [
    { code: 'missing_validator_context', message: 'validator transcript missing' },
  ]);
  assert.equal(blocked.failingLanes[0].status, 'BLOCKED');
  assert.equal(isWaveVerdict({ status: 'BLOCKED', missionId: 'msn_123', waveId: 'milestone_1', laneVerdicts: [] }), false);
});

test('normalizeMergeResult: records merge PASS and BLOCKED reason codes', () => {
  const pass = normalizeMergeResult({
    ...BASE,
    status: 'PASS',
    mergeCommit: 'abc123',
    method: 'squash',
    evidence: ['gh pr merge completed'],
  });
  assert.equal(pass.schema, 'MergeResult/v1');
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.mergeCommit, 'abc123');
  assert.equal(pass.method, 'squash');
  assert.deepEqual(pass.evidence, ['gh pr merge completed']);
  assert.equal(isMergeResult(pass), true);

  const blocked = normalizeMergeResult({
    ...BASE,
    status: 'BLOCKED',
    blockerReasons: [{ code: 'unresolved_fixback', message: 'validator did not rerun' }],
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.blockerReasons, [{ code: 'unresolved_fixback', message: 'validator did not rerun' }]);
});

test('normalizeCleanupResult: records cleanup PASS and branch/task evidence', () => {
  const result = normalizeCleanupResult({
    ...BASE,
    status: 'PASS',
    deletedRemoteBranch: true,
    removedWorktree: true,
    worktreePath: '/tmp/ace/worktree',
    evidence: ['deleted remote branch', 'removed worktree'],
  });

  assert.equal(result.schema, 'CleanupResult/v1');
  assert.equal(result.status, 'PASS');
  assert.equal(result.taskId, BASE.taskId);
  assert.equal(result.prUrl, BASE.prUrl);
  assert.equal(result.branch, BASE.branch);
  assert.equal(result.deletedRemoteBranch, true);
  assert.equal(result.removedWorktree, true);
  assert.equal(result.worktreePath, '/tmp/ace/worktree');
  assert.deepEqual(result.evidence, ['deleted remote branch', 'removed worktree']);
  assert.equal(isCleanupResult(result), true);
  assert.equal(isCleanupResult({ ...BASE, status: 'BLOCKED' }), false);
});
