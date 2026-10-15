const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VERDICTS,
  classifyCleanupCandidate,
  classifyCleanupCandidates,
} = require('../cleanup-classifier.cjs');

test('cleanup-classifier exports dry-run classifiers only', () => {
  const exports = require('../cleanup-classifier.cjs');
  assert.deepEqual(Object.keys(exports).sort(), [
    'VERDICTS',
    'classifyCleanupCandidate',
    'classifyCleanupCandidates',
  ]);
});

test('classifyCleanupCandidate: active open PR preserves candidate', () => {
  const r = classifyCleanupCandidate({
    branch: 'feature/open-pr',
    worktreePath: '/repo/.ace/worktrees/open-pr',
    headSha: 'abc123',
    prs: [{ number: 42, state: 'OPEN', headSha: 'abc123' }],
    branchHeadIsAncestorOfBase: true,
  });

  assert.equal(r.verdict, VERDICTS.ACTIVE_PR);
  assert.equal(r.shouldPreserve, true);
  assert.equal(r.eligibleForCleanup, false);
  assert.deepEqual(r.reasons, ['open-pr-42']);
});

test('classifyCleanupCandidate: dirty worktree preserves candidate before merge checks', () => {
  const r = classifyCleanupCandidate({
    branch: 'feature/dirty',
    worktreePath: '/repo/.ace/worktrees/dirty',
    gitStatus: { modified: 1 },
    branchHeadIsAncestorOfBase: true,
  });

  assert.equal(r.verdict, VERDICTS.DIRTY);
  assert.equal(r.shouldPreserve, true);
  assert.deepEqual(r.reasons, ['worktree-has-uncommitted-changes']);
});

test('classifyCleanupCandidate: gone clean registration is a cleanup candidate', () => {
  const r = classifyCleanupCandidate({
    branch: 'feature/gone',
    worktreePath: '/repo/.ace/worktrees/gone',
    registered: true,
    pathExists: false,
    gitStatus: { files: [] },
  });

  assert.equal(r.verdict, VERDICTS.GONE_CLEAN);
  assert.equal(r.eligibleForCleanup, true);
  assert.deepEqual(r.reasons, ['registered-worktree-path-gone', 'no-dirty-status-facts']);
});

test('classifyCleanupCandidate: normally merged branch is merged-safe', () => {
  const r = classifyCleanupCandidate({
    branch: 'feature/merged-normal',
    worktreePath: '/repo/.ace/worktrees/merged-normal',
    headSha: 'def456',
    branchHeadIsAncestorOfBase: true,
  });

  assert.equal(r.verdict, VERDICTS.MERGED_SAFE);
  assert.equal(r.eligibleForCleanup, true);
  assert.deepEqual(r.reasons, ['branch-head-is-ancestor-of-base']);
});

test('classifyCleanupCandidate: squash-merged PR is not treated as ancestry-safe', () => {
  const r = classifyCleanupCandidate({
    branch: 'feature/squash',
    worktreePath: '/repo/.ace/worktrees/squash',
    headSha: 'feedface',
    branchHeadIsAncestorOfBase: false,
    pr: { number: 77, state: 'MERGED', headSha: 'feedface' },
  });

  assert.equal(r.verdict, VERDICTS.SQUASH_MERGED_NEEDS_PR_EVIDENCE);
  assert.equal(r.recommendation, 'review');
  assert.equal(r.eligibleForCleanup, false);
  assert.deepEqual(r.reasons, ['merged-pr-present', 'branch-head-not-ancestor-of-base']);
});

test('classifyCleanupCandidate: active stream cwd under candidate preserves candidate', () => {
  const r = classifyCleanupCandidate(
    {
      branch: 'feature/active-stream',
      worktreePath: '/repo/.ace/worktrees/active-stream',
      branchHeadIsAncestorOfBase: true,
    },
    {
      activeStreamCwds: ['/repo/.ace/worktrees/active-stream/packages/app'],
    }
  );

  assert.equal(r.verdict, VERDICTS.UNKNOWN_PRESERVE);
  assert.equal(r.shouldPreserve, true);
  assert.equal(r.eligibleForCleanup, false);
  assert.equal(r.reasons[0], 'active-stream-cwd-under-candidate');
});

test('classifyCleanupCandidate: clean temp validation worktree is classified separately', () => {
  const r = classifyCleanupCandidate({
    branch: 'validation/task-123',
    worktreePath: '/repo/.ace/worktrees/validation-task-123',
    kind: 'temp-validation',
  });

  assert.equal(r.verdict, VERDICTS.TEMP_VALIDATION);
  assert.equal(r.eligibleForCleanup, true);
  assert.deepEqual(r.reasons, ['temp-validation-worktree']);
});

test('classifyCleanupCandidates maps plain fact records without side effects', () => {
  const candidates = [
    { id: 'a', branch: 'one', pathExists: false },
    { id: 'b', branch: 'two', dirty: true },
  ];
  const out = classifyCleanupCandidates(candidates);

  assert.deepEqual(
    out.map((r: any) => r.verdict),
    [VERDICTS.GONE_CLEAN, VERDICTS.DIRTY]
  );
  assert.equal(candidates[0].id, 'a');
});
