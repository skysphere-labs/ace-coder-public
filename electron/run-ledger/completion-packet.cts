// EvidenceBundle — the structured synthesis a completed run hands to the
// reconciler and the next-goal drafter.
//
// Gap G1: the bundle must be a CONCRETE typed shape, not an abstract idea.
// The completion inbox (electron/ace-control/completion-inbox.cts) emits
// raw per-trailer records (streamId, prUrl, branch, kind/outcome, detail).
// Those records say "an agent finished"; they do NOT carry the evidence the
// reconciler needs to decide pass/block/request-changes. This module defines
// that evidence as a single typed envelope so every consumer reads the same
// fields with the same defaults.
//
// Pure module: no I/O, no spine imports, no Date.now()/Math.random() at the
// top level. buildEvidenceBundle is deterministic given its input.

/**
 * @typedef {Object} EvidenceBundle
 * @property {string} runId               Stable id for the run this evidence describes.
 * @property {string} [featureId]         Optional FEATURES.json feature id.
 * @property {string[]} commands          Commands run as acceptance evidence (lint/build/test/cli).
 * @property {string[]} screenshots       Screenshot paths/urls captured during validation.
 * @property {boolean} computerUseEvidence Whether a real computer-use behavioral test was run.
 * @property {{ url:string, headSha:string, baseSha:string, checks:string } | null} pr
 *   Pull-request facts (compatible with completion-inbox prUrl), or null when none.
 * @property {{ allowedPaths:string[], changedFiles:string[] }} diffScope
 *   Allowed-path contract vs. files actually changed (for scope-creep checks).
 * @property {Array<{ id:string, met:boolean, evidence:string }> | null} validatorScorecard
 *   Per-criterion validator scorecard, or null when no validator ran.
 * @property {Array<{ id:string, status:('pass'|'fail'|'deferred') }>} acceptanceResults
 *   Per acceptance A-ID outcome.
 * @property {('pass'|'request-changes'|'block') | null} verdict
 *   Reconciler/validator verdict, or null when undecided.
 * @property {string} detail               Human-readable summary (compatible with trailer detail).
 */

const EVIDENCE_BUNDLE_FIELDS = Object.freeze([
  'runId',
  'featureId',
  'commands',
  'screenshots',
  'computerUseEvidence',
  'pr',
  'diffScope',
  'validatorScorecard',
  'acceptanceResults',
  'verdict',
  'detail',
]);

const VERDICTS = Object.freeze(['pass', 'request-changes', 'block']);
const ACCEPTANCE_STATUSES = Object.freeze(['pass', 'fail', 'deferred']);

function isObject(x: any) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function toStringArray(value: any) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function normalizePr(pr: any) {
  if (!isObject(pr)) return null;
  return {
    url: String(pr.url || ''),
    headSha: String(pr.headSha || ''),
    baseSha: String(pr.baseSha || ''),
    checks: String(pr.checks || ''),
  };
}

function normalizeDiffScope(scope: any) {
  return {
    allowedPaths: toStringArray(scope?.allowedPaths),
    changedFiles: toStringArray(scope?.changedFiles),
  };
}

function normalizeScorecard(scorecard: any) {
  if (!Array.isArray(scorecard)) return null;
  return scorecard
    .filter(isObject)
    .map((entry) => ({
      id: String(entry.id || ''),
      met: entry.met === true,
      evidence: String(entry.evidence || ''),
    }));
}

function normalizeAcceptance(results: any) {
  if (!Array.isArray(results)) return [];
  return results.filter(isObject).map((entry) => ({
    id: String(entry.id || ''),
    status: ACCEPTANCE_STATUSES.includes(entry.status) ? entry.status : 'deferred',
  }));
}

/**
 * Build a fully-defaulted EvidenceBundle from a partial input.
 * Arrays default to [], pr defaults to null, verdict defaults to null,
 * strings default to '', booleans default to false.
 * @param {Partial<EvidenceBundle>} [input]
 * @returns {EvidenceBundle}
 */
function buildEvidenceBundle(input: any = {}) {
  const src = isObject(input) ? input : {};
  const verdict = VERDICTS.includes(src.verdict) ? src.verdict : null;
  const bundle: any = {
    runId: String(src.runId || ''),
    commands: toStringArray(src.commands),
    screenshots: toStringArray(src.screenshots),
    computerUseEvidence: src.computerUseEvidence === true,
    pr: normalizePr(src.pr),
    diffScope: normalizeDiffScope(src.diffScope),
    validatorScorecard: normalizeScorecard(src.validatorScorecard),
    acceptanceResults: normalizeAcceptance(src.acceptanceResults),
    verdict,
    detail: String(src.detail || ''),
  };
  // featureId is optional: only present when provided.
  if (src.featureId != null && String(src.featureId)) {
    bundle.featureId = String(src.featureId);
  }
  return bundle;
}

/**
 * Validate that a value is a well-formed EvidenceBundle.
 * Returns false for null / non-object / wrong field types.
 * @param {unknown} x
 * @returns {boolean}
 */
function isEvidenceBundle(x: any) {
  if (!isObject(x)) return false;
  if (typeof x.runId !== 'string') return false;
  if (x.featureId !== undefined && typeof x.featureId !== 'string') return false;
  if (!Array.isArray(x.commands) || !x.commands.every((c: any) => typeof c === 'string')) return false;
  if (!Array.isArray(x.screenshots) || !x.screenshots.every((s: any) => typeof s === 'string')) return false;
  if (typeof x.computerUseEvidence !== 'boolean') return false;

  if (x.pr !== null) {
    if (!isObject(x.pr)) return false;
    if (
      typeof x.pr.url !== 'string' ||
      typeof x.pr.headSha !== 'string' ||
      typeof x.pr.baseSha !== 'string' ||
      typeof x.pr.checks !== 'string'
    ) {
      return false;
    }
  }

  if (!isObject(x.diffScope)) return false;
  if (
    !Array.isArray(x.diffScope.allowedPaths) ||
    !x.diffScope.allowedPaths.every((p: any) => typeof p === 'string')
  ) {
    return false;
  }
  if (
    !Array.isArray(x.diffScope.changedFiles) ||
    !x.diffScope.changedFiles.every((p: any) => typeof p === 'string')
  ) {
    return false;
  }

  if (x.validatorScorecard !== null) {
    if (!Array.isArray(x.validatorScorecard)) return false;
    for (const entry of x.validatorScorecard) {
      if (!isObject(entry)) return false;
      if (typeof entry.id !== 'string' || typeof entry.met !== 'boolean' || typeof entry.evidence !== 'string') {
        return false;
      }
    }
  }

  if (!Array.isArray(x.acceptanceResults)) return false;
  for (const entry of x.acceptanceResults) {
    if (!isObject(entry)) return false;
    if (typeof entry.id !== 'string' || !ACCEPTANCE_STATUSES.includes(entry.status)) return false;
  }

  if (x.verdict !== null && !VERDICTS.includes(x.verdict)) return false;
  if (typeof x.detail !== 'string') return false;

  return true;
}

module.exports = {
  EVIDENCE_BUNDLE_FIELDS,
  buildEvidenceBundle,
  isEvidenceBundle,
};
