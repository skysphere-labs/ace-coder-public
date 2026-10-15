const BLOCKER_CODES = Object.freeze({
  ACCOUNT_OAUTH: 'BLOCKED_ACCOUNT_OAUTH',
  REVIEW_REQUIRED: 'BLOCKED_REVIEW_REQUIRED',
  LAST_PUSH_APPROVAL: 'BLOCKED_LAST_PUSH_APPROVAL',
  PERMISSION: 'BLOCKED_PERMISSION',
});

const OK_CODE = 'OK';
const PERMISSION_RANK: any = Object.freeze({
  NONE: 0,
  READ: 1,
  TRIAGE: 2,
  WRITE: 3,
  MAINTAIN: 4,
  ADMIN: 5,
});

function obj(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value: any) {
  const s = String(value || '').trim();
  return s ? s : null;
}

function upper(value: any) {
  return String(value || '').trim().toUpperCase();
}

function lowerLogin(value: any) {
  return text(value)?.toLowerCase() || null;
}

function statusCode(probe: any) {
  const p = obj(probe);
  const n = Number(p.status ?? p.statusCode ?? p.httpStatus ?? p.code);
  return Number.isFinite(n) ? n : null;
}

function probeBody(probe: any) {
  const p = obj(probe);
  return [p.message, p.error, p.stderr, p.stdout, p.body].filter(Boolean).join('\n');
}

function probes(input: any) {
  return [
    input.repoProbe,
    input.repositoryProbe,
    input.apiProbe,
    input.authProbe,
    input.auth,
    input.mergeProbe,
  ].filter(Boolean);
}

function accountName(input: any) {
  const auth = obj(input.auth || input.accountProbe || input.account);
  return text(input.mergeAccount || input.accountLogin || input.login || auth.login || auth.viewerLogin);
}

function repoName(input: any) {
  const repository = obj(input.repository);
  return text(input.repo || input.fullName || input.nameWithOwner || repository.nameWithOwner || repository.fullName);
}

function isOauthRestricted(probe: any) {
  if (statusCode(probe) !== 403) return false;
  return /oauth|saml|organization.+access restriction|resource protected by organization|grant.+organization access/i.test(
    probeBody(probe)
  );
}

function isPermissionDenied(probe: any) {
  const status = statusCode(probe);
  if (status === 401 || status === 404) return true;
  if (status === 403 && !isOauthRestricted(probe)) return true;
  return /permission|forbidden|not authorized|not authorised|access denied|insufficient/i.test(probeBody(probe));
}

function permissionInput(input: any) {
  return obj(input.permission || input.permissions || input.repositoryPermission || input.repository);
}

function viewerPermission(input: any) {
  const p = permissionInput(input);
  return upper(p.viewerPermission || p.permission || p.role || input.viewerPermission);
}

function requiredPermission(input: any) {
  const p = permissionInput(input);
  const protection = obj(input.branchProtection || input.protection);
  return upper(p.requiredPermission || input.requiredPermission || protection.requiredPermission || 'WRITE');
}

function lacksPermission(input: any) {
  const p = permissionInput(input);
  if (p.ok === false || p.hasPermission === false || p.canMerge === false || p.canPush === false) return true;

  const role = viewerPermission(input);
  const required = requiredPermission(input);
  if (required === 'ADMIN') {
    return !(p.admin === true || p.isAdmin === true || p.canAdmin === true || role === 'ADMIN');
  }

  const roleRank = PERMISSION_RANK[role];
  const requiredRank = PERMISSION_RANK[required];
  return roleRank != null && requiredRank != null && roleRank < requiredRank;
}

function approvals(pr: any) {
  const raw = pr.approvedBy || pr.approvals || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: any) => lowerLogin(entry?.login || entry?.author?.login || entry)).filter(Boolean);
}

function requiredReviewCount(protection: any) {
  const n = Number(
    protection.requiredApprovingReviewCount ??
      protection.requiredReviewCount ??
      protection.requiredReviews ??
      0
  );
  return Number.isFinite(n) ? n : 0;
}

function approvingReviewsExplicitlyDisabled(protection: any) {
  return (
    protection.requiresApprovingReviews === false ||
    protection.requireApprovingReviews === false ||
    protection.pullRequestReviewsRequired === false ||
    protection.reviewRequired === false ||
    protection.requiredPullRequestReviews === null ||
    protection.required_pull_request_reviews === null
  );
}

function reviewRequired(input: any, pr: any, protection: any) {
  const reviewDecision = upper(pr.reviewDecision || input.reviewDecision);
  if (reviewDecision === 'REVIEW_REQUIRED') return true;
  if (approvingReviewsExplicitlyDisabled(protection)) return false;
  return (
    protection.requiresApprovingReviews === true ||
    protection.requireApprovingReviews === true ||
    requiredReviewCount(protection) > 0
  );
}

function reviewSatisfied(pr: any, protection: any) {
  if (pr.reviewSatisfied === true || protection.reviewSatisfied === true) return true;
  if (upper(pr.reviewDecision) === 'APPROVED') return true;
  const required = requiredReviewCount(protection);
  return required > 0 && approvals(pr).length >= required;
}

function lastPushApprovalRequired(protection: any) {
  return (
    protection.requiresLastPushApproval === true ||
    protection.requireLastPushApproval === true ||
    protection.requiresMostRecentPushApproval === true ||
    protection.requireMostRecentPushApproval === true
  );
}

function lastPushApprovalSatisfied(input: any, pr: any, protection: any) {
  const lastPush = obj(input.lastPushApproval);
  return pr.lastPushApprovalSatisfied === true || protection.lastPushApprovalSatisfied === true || lastPush.satisfied === true;
}

function addBlocker(blockers: any, input: any, code: any, message: any, details: any = {}) {
  const pr = obj(input.pullRequest || input.pr);
  blockers.push({
    code,
    message,
    account: accountName(input) || null,
    repo: repoName(input) || null,
    prNumber: pr.number ?? null,
    details,
  });
}

function classifyPrAccountPreflight(input: any = {}) {
  const pr = obj(input.pullRequest || input.pr);
  const protection = obj(input.branchProtection || input.protection);
  const blockers: any[] = [];
  const account = lowerLogin(accountName(input));
  const author = lowerLogin(pr.authorLogin || pr.author?.login || pr.author);
  const lastPusher = lowerLogin(pr.lastPusherLogin || pr.lastPusher?.login || pr.lastPusher);

  const oauthProbe = probes(input).find(isOauthRestricted);
  if (oauthProbe) {
    addBlocker(
      blockers,
      input,
      BLOCKER_CODES.ACCOUNT_OAUTH,
      'GitHub returned HTTP 403 for this account with organization OAuth/SAML access restrictions.',
      { statusCode: statusCode(oauthProbe) }
    );
  }

  const permissionProbe = probes(input).find(isPermissionDenied);
  if (!oauthProbe && (permissionProbe || lacksPermission(input))) {
    addBlocker(
      blockers,
      input,
      BLOCKER_CODES.PERMISSION,
      'The account lacks the required repository permission for merge preflight.',
      {
        statusCode: permissionProbe ? statusCode(permissionProbe) : null,
        viewerPermission: viewerPermission(input) || null,
        requiredPermission: requiredPermission(input) || null,
      }
    );
  }

  if (
    lastPushApprovalRequired(protection) &&
    !lastPushApprovalSatisfied(input, pr, protection)
  ) {
    addBlocker(
      blockers,
      input,
      BLOCKER_CODES.LAST_PUSH_APPROVAL,
      'Branch protection requires approval of the most recent push by someone other than the last pusher.',
      { lastPusherLogin: lastPusher, requiresLastPushApproval: true }
    );
  }

  if (reviewRequired(input, pr, protection) && !reviewSatisfied(pr, protection)) {
    addBlocker(
      blockers,
      input,
      BLOCKER_CODES.REVIEW_REQUIRED,
      author && account === author
        ? 'Branch protection requires an approving review from someone other than the PR author.'
        : 'Branch protection requires an approving review before merge.',
      {
        reviewDecision: upper(pr.reviewDecision || input.reviewDecision) || null,
        authorLogin: author,
        requiredApprovingReviewCount: requiredReviewCount(protection),
        approvingReviewCount: approvals(pr).length,
      }
    );
  }

  return {
    ok: blockers.length === 0,
    code: blockers[0]?.code || OK_CODE,
    primaryCode: blockers[0]?.code || null,
    reasonCodes: blockers.map((blocker: any) => blocker.code),
    account: accountName(input) || null,
    repo: repoName(input) || null,
    prNumber: pr.number ?? null,
    blockers,
  };
}

module.exports = {
  BLOCKER_CODES,
  OK_CODE,
  classifyPrAccountPreflight,
};
