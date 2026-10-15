const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BLOCKER_CODES,
  OK_CODE,
  classifyPrAccountPreflight,
} = require('../pr-account-check.cjs');

test('classifyPrAccountPreflight: vectorcmd HTTP 403 org OAuth restriction blocks without echoing probe text', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'vectorcmd',
    repo: 'example-org/example-project',
    repoProbe: {
      ok: false,
      status: 403,
      stderr: 'HTTP 403: Resource protected by organization OAuth restrictions for credential REDACTED_PLACEHOLDER',
    },
    permission: { viewerPermission: 'ADMIN', isAdmin: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, BLOCKER_CODES.ACCOUNT_OAUTH);
  assert.deepEqual(result.reasonCodes, [BLOCKER_CODES.ACCOUNT_OAUTH]);
  assert.equal(result.blockers[0].account, 'vectorcmd');
  assert.equal(result.blockers[0].repo, 'example-org/example-project');
  assert.equal(result.blockers[0].details.statusCode, 403);
  assert.doesNotMatch(JSON.stringify(result), /REDACTED_PLACEHOLDER|Resource protected/);
});

test('classifyPrAccountPreflight: author plus last-pusher approval requirements are distinct blockers', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'example-user',
    repo: 'example-org/example-project',
    permission: { viewerPermission: 'ADMIN', isAdmin: true },
    branchProtection: {
      requiredApprovingReviewCount: 1,
      requiresApprovingReviews: true,
      requiresLastPushApproval: true,
    },
    pullRequest: {
      number: 123,
      authorLogin: 'example-user',
      lastPusherLogin: 'example-user',
      reviewDecision: 'REVIEW_REQUIRED',
      approvedBy: [],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasonCodes, [
    BLOCKER_CODES.LAST_PUSH_APPROVAL,
    BLOCKER_CODES.REVIEW_REQUIRED,
  ]);
  assert.match(result.blockers[0].message, /most recent push/);
  assert.match(result.blockers[1].message, /PR author/);
});

test('classifyPrAccountPreflight: disabled review gate ignores GitHub review endpoint defaults', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'example-user',
    repo: 'example-org/example-project',
    permission: { viewerPermission: 'ADMIN', isAdmin: true },
    branchProtection: {
      requiresApprovingReviews: false,
      requiredApprovingReviewCount: 1,
    },
    pullRequest: {
      number: 254,
      authorLogin: 'example-user',
      lastPusherLogin: 'example-user',
      reviewDecision: null,
      approvedBy: [],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, OK_CODE);
  assert.deepEqual(result.reasonCodes, []);
});

test('classifyPrAccountPreflight: missing admin permission blocks when admin is required', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'vectorcmd',
    repo: 'example-org/example-project',
    permission: {
      viewerPermission: 'WRITE',
      requiredPermission: 'ADMIN',
      isAdmin: false,
    },
    repoProbe: { ok: true, status: 200 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasonCodes, [BLOCKER_CODES.PERMISSION]);
  assert.equal(result.blockers[0].details.viewerPermission, 'WRITE');
  assert.equal(result.blockers[0].details.requiredPermission, 'ADMIN');
});

test('classifyPrAccountPreflight: unsatisfied last-push approval blocks even for a different merge account', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'example-user',
    repo: 'example-org/example-project',
    repoProbe: { ok: true, status: 200 },
    permission: { viewerPermission: 'ADMIN', isAdmin: true },
    branchProtection: {
      requiredApprovingReviewCount: 1,
      requiresApprovingReviews: true,
      requiresLastPushApproval: true,
    },
    pullRequest: {
      number: 132,
      authorLogin: 'worker-one',
      lastPusherLogin: 'vectorcmd',
      reviewDecision: 'APPROVED',
      approvedBy: ['reviewer-one'],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasonCodes, [BLOCKER_CODES.LAST_PUSH_APPROVAL]);
  assert.equal(result.blockers[0].details.lastPusherLogin, 'vectorcmd');
});

test('classifyPrAccountPreflight: example-user admin path is clean when branch-protection probes are satisfied', () => {
  const result = classifyPrAccountPreflight({
    mergeAccount: 'example-user',
    repo: 'example-org/example-project',
    repoProbe: { ok: true, status: 200 },
    permission: { viewerPermission: 'ADMIN', isAdmin: true },
    branchProtection: {
      requiredApprovingReviewCount: 1,
      requiresApprovingReviews: true,
      requiresLastPushApproval: true,
    },
    pullRequest: {
      number: 127,
      authorLogin: 'vectorcmd',
      lastPusherLogin: 'vectorcmd',
      reviewDecision: 'APPROVED',
      approvedBy: ['reviewer-one'],
      lastPushApprovalSatisfied: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, OK_CODE);
  assert.equal(result.primaryCode, null);
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(result.blockers, []);
});
