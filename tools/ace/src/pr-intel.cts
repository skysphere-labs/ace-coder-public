// pr-intel — live GitHub PR evidence helpers for the merge gate. Relocated
// from the (deleted) inline auto-chain so the mission-card bus loop's gateway
// seam can pin the validated head, classify change risk, and fail closed on
// unknown changed files. Pure gh-CLI reads + pure policy classifiers; no
// orchestration here.

const { execFileSync } = require('node:child_process');

let changeRiskPolicyModule: any = null;
try {
  changeRiskPolicyModule = require('./change-risk-policy.cjs');
} catch {
  try {
    changeRiskPolicyModule = require('./change-risk-policy.cts');
  } catch {
    changeRiskPolicyModule = null;
  }
}

// Fetch the live PR head SHA (the head being validated / merged) so the merge
// gate can pin the validated head and refuse a stale-head auto-merge. Returns
// null on any failure → the gate's automerge_exact_head_evidence_required then
// fail-closes (no head evidence ⇒ no auto-merge).
function fetchPrHeadSha(prNumber: any): string | null {
  if (prNumber == null) return null;
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const sha = String(out || '').trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// Fetch the PR's changed file paths so the merge gate can classify change risk
// (the UI / high-risk / release-pipeline / large-diff automerge holds are
// derived from this list). Returns an array (possibly empty) or null on failure.
function fetchPrChangedFiles(prNumber: any): string[] | null {
  if (prNumber == null) return null;
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'files', '-q', '[.files[].path]'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const parsed = JSON.parse(String(out || '[]'));
    return Array.isArray(parsed) ? parsed.map((p: any) => String(p || '')).filter(Boolean) : null;
  } catch {
    return null;
  }
}

// Roll a GitHub statusCheckRollup array up to a single check state. 'success'
// only when every check concluded successfully (or neutral/skipped); 'failure'
// if any failed/errored/cancelled/timed-out; 'pending' while any is still
// running; null when there are no checks. Mirrors the supervisor's rollup so
// the merge gate sees the same 'success' the gateway will.
function rollupPrCheckState(rollup: any): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let pending = false;
  for (const c of rollup) {
    const status = String(c?.status || '').toUpperCase();
    const conclusion = String(c?.conclusion || c?.state || '').toUpperCase();
    if (status && status !== 'COMPLETED') { pending = true; continue; }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED', ''].includes(conclusion)) continue;
    return 'failure';
  }
  return pending ? 'pending' : 'success';
}

// Fetch live PR review-state intel (state / mergeable / checks / reviewDecision
// / isDraft) so the merge gate evaluates against REALITY instead of a row whose
// checkState/mergeable were never populated. Returns null on any failure
// → callers leave the fields unset and the gate fail-closes.
function fetchPrIntel(prNumber: any): any {
  if (prNumber == null) return null;
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'state,mergeable,statusCheckRollup,reviewDecision,isDraft'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const json = JSON.parse(String(out || '{}'));
    return {
      prState: json.state || null,
      mergeable: json.mergeable || null,
      checkState: rollupPrCheckState(json.statusCheckRollup),
      reviewDecision: json.reviewDecision || null,
      isDraft: json.isDraft === true,
    };
  } catch {
    return null;
  }
}

// Fail-closed guard: when auto-merge is on but the changed-file list is unknown
// (null — e.g. `gh pr view` failed), force the gate to hold for an operator.
// The automerge eligibility holds (UI/high-risk/release/large-diff) classify an
// empty list as "no risk" and the policy coerces null→empty, so without this a
// transient fetch failure would silently clear every risk hold. A known-empty
// list ([]) is left as-is (genuinely no files). Returns the gate unchanged when
// auto-merge is off or the list is known.
function holdGateOnUnknownChanges(mergeGate: any, { autoMerge, changedFiles }: any) {
  if (!autoMerge || changedFiles != null) return mergeGate;
  return {
    ...mergeGate,
    ok: false,
    failures: [
      ...(Array.isArray(mergeGate?.failures) ? mergeGate.failures : []),
      {
        code: 'automerge_changed_files_unknown',
        message:
          'could not determine the PR changed-file list; the risk holds cannot be evaluated — operator merge decision required',
      },
    ],
  };
}

// Classify whether a changed-file list is HIGH risk (auth/security/migration/
// release/etc. paths) so the merge gate's high-risk hold can fire. Degrades to
// false when the change-risk policy module is unavailable.
function computeHighRisk(changedFiles: any): boolean {
  try {
    const classify = changeRiskPolicyModule?.classifyChangeRisk;
    const HIGH = changeRiskPolicyModule?.RISK_CLASSES?.HIGH;
    if (typeof classify !== 'function' || !HIGH) return false;
    const files = Array.isArray(changedFiles) ? changedFiles : [];
    if (!files.length) return false;
    return classify({ changedFiles: files }).riskClass === HIGH;
  } catch {
    return false;
  }
}

module.exports = {
  fetchPrHeadSha,
  fetchPrChangedFiles,
  rollupPrCheckState,
  fetchPrIntel,
  holdGateOnUnknownChanges,
  computeHighRisk,
};
