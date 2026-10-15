// Automerge eligibility policy — one pure place to decide whether a PR may
// merge through the Ace integration gateway WITHOUT an operator saying
// "merge main".
//
// This is deliberately a NARROW eligibility check layered on top of
// evaluateMergeGate (pr-gate.cts), which already enforces draft, conflicts,
// green current-head CI, scope, exact-head SHA evidence, and fixback state.
// Eligibility adds the human-judgment dimension:
//
//   - automerge ALWAYS requires an independent validator PASS recorded at the
//     exact current PR head (mission wiring only sets independent=PASS when
//     validatedHeadSha === prHeadSha; expected-head SHA mismatches are blocked
//     separately by the merge gate).
//   - high-risk changes (release/deploy/security/control-plane paths via
//     classifyChangeRisk) always hold for an operator, even with validator
//     PASS.
//   - user-visible UI changes hold for an operator unless computer-use QA
//     evidence was recorded — "ambiguous UI" never automerges on green CI
//     alone.
//
// Conflict repair stays same-PR fixback; nothing here resolves conflicts or
// bypasses the gate. Holds are shaped like merge-gate failures so the gate
// can append them directly.

let changeRiskPolicy: any;
try {
  changeRiskPolicy = require('./change-risk-policy.cjs');
} catch {
  changeRiskPolicy = require('./change-risk-policy.cts');
}

let autoshipToken: any;
try {
  autoshipToken = require('./autoship-token.cjs');
} catch {
  autoshipToken = require('./autoship-token.cts');
}
const { resolveOwnerAuthToken } = autoshipToken;

const AUTOMERGE_HOLD_CODES = Object.freeze({
  VALIDATOR: 'automerge_validator_pass_required',
  HIGH_RISK: 'automerge_operator_required_high_risk',
  RELEASE_PIPELINE: 'automerge_operator_required_release_pipeline',
  CONTROL_PLANE: 'automerge_operator_required_control_plane',
  UI: 'automerge_operator_required_ui',
  LARGE_DIFF: 'automerge_operator_required_large_diff',
});

// Release-pipeline deny list for the automerge lane. classifyChangeRisk's
// HIGH_RISK_PATH_RX only matches whole path SEGMENTS named release/deploy/…,
// which misses the actual publishing surface (workflow files, updater
// scripts, the updater engine, and this policy itself). Anything that can
// move the user update feed — or weaken this gate — never automerges.
const RELEASE_PIPELINE_PATH_RX =
  /(^|\/)\.github\/workflows\/|(^|\/)scripts\/(generate-release-state|generate-update-manifest|release-workflow-validator|update-live-feed-probe|update-artifact-guard|stamp-build-info)\.cts$|(^|\/)scripts\/r2-transfer\.sh$|(^|\/)electron\/(app-updater|update-types)\.cts$|(^|\/)tools\/ace\/src\/automerge-policy\.cts$/i;

// Ownerless merge control-plane changes can weaken the policy/reconciler path
// itself. They always park for an owner decision, even when tests/checks pass.
const CONTROL_PLANE_PATH_RX =
  /(^|\/)tools\/ace\/src\/autoship-policy\.cts$|(^|\/)electron\/run-ledger\/(kernel|reconciler|spine-effects)\.cts$/i;

// `gh pr view --json files` truncates very large PRs (~100-file page), so an
// at-cap list may HIDE high-risk paths from classification entirely.
const CHANGED_FILES_CLASSIFIABLE_MAX = 100;

// Owner-auth bypass predicate for the auto-chain / loop-ship lane. An
// admin/squash merge bypass (the only way a high-risk / UI / release-pipeline
// hold can be waived without an operator clicking merge) requires owner
// authorization. DEFAULT-OFF: when NO owner token is configured (env
// ACE_OWNER_AUTH_TOKEN empty AND ops-config autoship.token absent), NO run can
// ever authorize a bypass, so the lane behaves exactly as the manual gate today.
//
// Two authorization shapes are accepted, both fail-closed:
//   1. tokenRef  — a run that carries `merge.tokenRef` (or autoChain.tokenRef /
//      a top-level tokenRef) NAMES a configured token WITHOUT carrying the secret
//      in its spec/ledger. This is the loop-ship path: the owner-approved template
//      persists only the NAME, and the token itself lives in the operator's local
//      ops-config (or env). A resolvable ref IS the standing authorization.
//   2. literal   — an operator-supplied `--owner-token` rides on the spec
//      (autoChain.ownerAuthToken / spec.ownerAuthToken) and must MATCH the
//      configured token exactly. This is the historical run-submit path.
function ownerAuthorizedBypass(spec: any = {}): boolean {
  const expected = String(resolveOwnerAuthToken() || '').trim();
  if (!expected) return false;
  const autoChain =
    spec && typeof spec.autoChain === 'object' && !Array.isArray(spec.autoChain) ? spec.autoChain : {};
  const merge =
    spec && typeof spec.merge === 'object' && !Array.isArray(spec.merge) ? spec.merge : {};
  // tokenRef path: a named reference to a configured token authorizes the run
  // (the secret is never in the spec — only its name). expected is confirmed
  // non-empty above, so a ref only authorizes when a token is actually configured.
  const tokenRef = String(merge.tokenRef ?? autoChain.tokenRef ?? spec?.tokenRef ?? '').trim();
  if (tokenRef) return true;
  // literal path: the presented token must equal the configured one.
  const presented = String(
    autoChain.ownerAuthToken ?? autoChain.owner_auth_token ?? spec?.ownerAuthToken ?? spec?.owner_auth_token ?? ''
  ).trim();
  if (!presented) return false;
  return presented === expected;
}

function evaluateAutomergeEligibility({
  changedFiles,
  independentPass,
  computerUseEvidence,
  highRisk,
}: any = {}) {
  const holds: any[] = [];
  const files = (Array.isArray(changedFiles) ? changedFiles : changedFiles == null ? [] : [changedFiles])
    .map((file: any) => String(file || '').trim())
    .filter(Boolean);
  const policy = changeRiskPolicy.classifyChangeRisk({
    changedFiles: files,
    highRisk: highRisk === true,
  });
  if (independentPass !== true) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.VALIDATOR,
      message: 'automerge requires an independent validator PASS at the exact current PR head',
    });
  }
  if (policy.riskClass === changeRiskPolicy.RISK_CLASSES.HIGH) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.HIGH_RISK,
      message: `high-risk changes require an operator merge decision (${policy.reasons.join(', ')})`,
    });
  }
  const pipelineFiles = files.filter((file: string) => RELEASE_PIPELINE_PATH_RX.test(file));
  if (pipelineFiles.length > 0) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.RELEASE_PIPELINE,
      message: `release-pipeline changes require an operator merge decision (${pipelineFiles.join(', ')})`,
    });
  }
  const controlPlaneFiles = files.filter((file: string) => CONTROL_PLANE_PATH_RX.test(file));
  if (controlPlaneFiles.length > 0) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.CONTROL_PLANE,
      message: `autoship/control-plane changes require an operator merge decision (${controlPlaneFiles.join(', ')})`,
    });
  }
  if (policy.computerUseRequired === true && computerUseEvidence !== true) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.UI,
      message:
        'user-visible UI changes require recorded computer-use QA evidence or an operator merge decision',
    });
  }
  if (files.length >= CHANGED_FILES_CLASSIFIABLE_MAX) {
    holds.push({
      code: AUTOMERGE_HOLD_CODES.LARGE_DIFF,
      message:
        `changed-file list is at the GitHub page cap (${files.length} >= ${CHANGED_FILES_CLASSIFIABLE_MAX}); ` +
        'risk classification may be incomplete — operator merge decision required',
    });
  }
  return {
    eligible: holds.length === 0,
    riskClass: policy.riskClass,
    reasons: policy.reasons,
    holds,
  };
}

module.exports = {
  AUTOMERGE_HOLD_CODES,
  RELEASE_PIPELINE_PATH_RX,
  CONTROL_PLANE_PATH_RX,
  CHANGED_FILES_CLASSIFIABLE_MAX,
  evaluateAutomergeEligibility,
  ownerAuthorizedBypass,
};
