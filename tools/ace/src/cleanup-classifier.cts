const path = require('node:path');

const VERDICTS = Object.freeze({
  ACTIVE_PR: 'active-pr',
  DIRTY: 'dirty',
  GONE_CLEAN: 'gone-clean',
  MERGED_SAFE: 'merged-safe',
  SQUASH_MERGED_NEEDS_PR_EVIDENCE: 'squash-merged-needs-pr-evidence',
  TEMP_VALIDATION: 'temp-validation',
  UNKNOWN_PRESERVE: 'unknown-preserve',
});

const CLEANUP_CANDIDATE = 'cleanup-candidate';
const PRESERVE = 'preserve';
const REVIEW = 'review';

function normalizedPath(value: any) {
  if (!value) return '';
  return path.normalize(String(value));
}

function isSameOrChildPath(parent: any, child: any) {
  const parentPath = normalizedPath(parent);
  const childPath = normalizedPath(child);
  if (!parentPath || !childPath) return false;
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeSha(value: any) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBranch(value: any) {
  return String(value || '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .trim()
    .toLowerCase();
}

function hasDirtyStatus(candidate: any) {
  if (candidate?.dirty === true || candidate?.hasUncommittedChanges === true) return true;
  const status = candidate?.status || candidate?.gitStatus || {};
  if (status.dirty === true || status.hasChanges === true) return true;
  if (Array.isArray(status.files) && status.files.length > 0) return true;
  for (const key of ['staged', 'unstaged', 'untracked', 'modified', 'deleted', 'renamed']) {
    if (Number(status[key] || 0) > 0) return true;
  }
  return false;
}

function prFacts(candidate: any) {
  return [
    candidate?.openPr,
    candidate?.pr,
    candidate?.pullRequest,
    ...(Array.isArray(candidate?.prs) ? candidate.prs : []),
    ...(Array.isArray(candidate?.pullRequests) ? candidate.pullRequests : []),
  ].filter(Boolean);
}

function isOpenPr(pr: any) {
  const state = String(pr?.state || '').toLowerCase();
  return pr?.open === true || pr?.isOpen === true || state === 'open';
}

function isMergedPr(pr: any) {
  const state = String(pr?.state || '').toLowerCase();
  return pr?.merged === true || state === 'merged' || !!pr?.mergedAt;
}

function prMatchesCandidate(candidate: any, pr: any, allowWeakMatch = false) {
  const candidateSha = normalizeSha(candidate?.headSha || candidate?.branchSha || candidate?.sha);
  const prSha = normalizeSha(pr?.headSha || pr?.headRefOid || pr?.headOid || pr?.sha);
  if (candidateSha && prSha) return candidateSha === prSha;

  const candidateBranch = normalizeBranch(candidate?.branch || candidate?.branchName || candidate?.refName);
  const prBranch = normalizeBranch(pr?.headRefName || pr?.branch || pr?.branchName || pr?.refName);
  if (candidateBranch && prBranch) return candidateBranch === prBranch;

  return allowWeakMatch && (!candidateSha || !prSha) && (!candidateBranch || !prBranch);
}

function findOpenPr(candidate: any) {
  for (const pr of prFacts(candidate)) {
    if (isOpenPr(pr) && prMatchesCandidate(candidate, pr, pr === candidate?.openPr)) return pr;
  }
  return null;
}

function findMergedPr(candidate: any) {
  for (const pr of prFacts(candidate)) {
    if (isMergedPr(pr) && prMatchesCandidate(candidate, pr)) return pr;
  }
  return null;
}

function hasGoneCleanFacts(candidate: any) {
  const exists = candidate?.exists ?? candidate?.pathExists ?? candidate?.worktreeExists;
  return !hasDirtyStatus(candidate) && (candidate?.gone === true || candidate?.registrationGone === true || exists === false);
}

function hasNormalMergeFacts(candidate: any) {
  return (
    candidate?.branchHeadIsAncestorOfBase === true ||
    candidate?.headIsAncestorOfBase === true ||
    candidate?.mergedIntoBase === true ||
    candidate?.isMergedIntoBase === true
  );
}

function hasSquashMergeFacts(candidate: any, mergedPr: any) {
  return candidate?.squashMerged === true || (!!mergedPr && candidate?.branchHeadIsAncestorOfBase === false);
}

function squashMergeReasons(candidate: any, mergedPr: any) {
  return [
    mergedPr ? 'merged-pr-present' : 'squash-merged-fact',
    candidate?.branchHeadIsAncestorOfBase === false
      ? 'branch-head-not-ancestor-of-base'
      : 'branch-ancestry-not-proven-safe',
  ];
}

function isTempValidation(candidate: any) {
  if (candidate?.tempValidation === true || candidate?.isTempValidation === true) return true;
  const labels = [candidate?.kind, candidate?.purpose, candidate?.type, candidate?.role]
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean);
  return labels.includes('temp-validation') || labels.includes('validation-temp');
}

function activeStreamCwd(candidate: any, context: any) {
  const worktreePath = candidate?.worktreePath || candidate?.path;
  const cwds = [
    ...(Array.isArray(context?.activeStreamCwds) ? context.activeStreamCwds : []),
    ...(Array.isArray(context?.activeStreams)
      ? context.activeStreams.map((stream: any) => stream?.cwd || stream?.worktreePath).filter(Boolean)
      : []),
  ];
  return cwds.find((cwd) => isSameOrChildPath(worktreePath, cwd)) || null;
}

function result(candidate: any, verdict: string, recommendation: string, reasons: string[]) {
  return {
    id: candidate?.id ?? null,
    branch: candidate?.branch ?? candidate?.branchName ?? null,
    worktreePath: candidate?.worktreePath ?? candidate?.path ?? null,
    verdict,
    recommendation,
    shouldPreserve: recommendation !== CLEANUP_CANDIDATE,
    eligibleForCleanup: recommendation === CLEANUP_CANDIDATE,
    reasons,
  };
}

function classifyCleanupCandidate(candidate: any, context: any = {}) {
  const openPr = findOpenPr(candidate);
  if (openPr) {
    const prNumber = openPr.number ?? openPr.prNumber ?? null;
    return result(candidate, VERDICTS.ACTIVE_PR, PRESERVE, [
      prNumber == null ? 'open-pr' : `open-pr-${prNumber}`,
    ]);
  }

  if (hasDirtyStatus(candidate)) {
    return result(candidate, VERDICTS.DIRTY, PRESERVE, ['worktree-has-uncommitted-changes']);
  }

  const activeCwd = activeStreamCwd(candidate, context);
  if (activeCwd) {
    return result(candidate, VERDICTS.UNKNOWN_PRESERVE, PRESERVE, [
      'active-stream-cwd-under-candidate',
      String(activeCwd),
    ]);
  }

  if (hasGoneCleanFacts(candidate)) {
    return result(candidate, VERDICTS.GONE_CLEAN, CLEANUP_CANDIDATE, [
      'registered-worktree-path-gone',
      'no-dirty-status-facts',
    ]);
  }

  if (isTempValidation(candidate)) {
    return result(candidate, VERDICTS.TEMP_VALIDATION, CLEANUP_CANDIDATE, ['temp-validation-worktree']);
  }

  if (hasNormalMergeFacts(candidate)) {
    return result(candidate, VERDICTS.MERGED_SAFE, CLEANUP_CANDIDATE, ['branch-head-is-ancestor-of-base']);
  }

  const mergedPr = findMergedPr(candidate);
  if (hasSquashMergeFacts(candidate, mergedPr)) {
    return result(
      candidate,
      VERDICTS.SQUASH_MERGED_NEEDS_PR_EVIDENCE,
      REVIEW,
      squashMergeReasons(candidate, mergedPr)
    );
  }

  return result(candidate, VERDICTS.UNKNOWN_PRESERVE, PRESERVE, ['no-cleanup-evidence']);
}

function classifyCleanupCandidates(candidates: any, context: any = {}) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) =>
    classifyCleanupCandidate(candidate, context)
  );
}

module.exports = {
  VERDICTS,
  classifyCleanupCandidate,
  classifyCleanupCandidates,
};
