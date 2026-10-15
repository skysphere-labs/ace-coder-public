// next-goal — outer-loop handoff. Given the EvidenceBundle a completed run
// produced, propose the NEXT Goal plus which driver should run it. This is a
// PROPOSAL only: it never dispatches. Owner approval is mandatory on every
// goal it returns (requiresOwnerApproval is always true), per the no-auto-
// archive / autonomous-operator policy where the operator holds the ship/dispatch.
//
// Pure module: no I/O, no clocks, no Date.now()/Math.random(). The decision is
// a deterministic function of the bundle (+ optional opts.followups), so it is
// trivially testable.

// Build-agnostic sibling import: the compiled .cjs is gitignored and may be
// absent in a fresh worktree, so fall back to the .cts that tsx resolves.
let completionPacket: any;
try {
  completionPacket = require('./completion-packet.cjs');
} catch {
  completionPacket = require('./completion-packet.cts');
}
const { isEvidenceBundle } = completionPacket;

/**
 * @typedef {import('./completion-packet').EvidenceBundle} EvidenceBundle
 */

/**
 * @typedef {Object} NextGoalRunspec
 * @property {string} goal
 * @property {('build'|'validation'|'research')} mode
 * @property {false} autoValidate
 * @property {false} autoMerge
 * @property {false} autoRelease
 */

/**
 * @typedef {Object} NextGoalProposal
 * @property {string} goal
 * @property {('claude'|'codex')} agent
 * @property {NextGoalRunspec} runspec
 * @property {true} requiresOwnerApproval
 */

/**
 * @typedef {Object} NoGoal
 * @property {string} no_goal  Human-readable reason no follow-up is proposed.
 */

// Driver heuristic mirroring claude-codex-specialty-router doctrine.
// Claude is the JUDGMENT engine; Codex is the THROUGHPUT engine. We classify
// the proposed goal text by keyword and default to Claude when unsure (the
// router's tie-break: ambiguity → Claude).
const CLAUDE_KEYWORDS = Object.freeze([
  'plan',
  'design',
  'architect',
  'architecture',
  'ambig',
  'unclear',
  'review',
  'request-changes',
  'request changes',
  'debug',
  'root cause',
  'investigate',
  'orchestrat',
  'ui',
  'ux',
  'product',
  'research',
  'prd',
]);

const CODEX_KEYWORDS = Object.freeze([
  'refactor',
  'rename',
  'migrat',
  'migration',
  'implement',
  'backend',
  'api',
  'pipeline',
  'boilerplate',
  'scaffold',
  'high-volume',
  'mechanical',
  'bulk',
  'codegen',
]);

/**
 * Pick the driver for a proposed goal by task shape.
 * Documented heuristic: a goal whose text reads as deterministic / refactor /
 * high-volume implementation routes to 'codex'; planning / ambiguity / review /
 * architecture / user-visible routes to 'claude'. Default 'claude' when neither
 * (or both) match — the router tie-break is "ambiguity → Claude".
 * @param {string} goal
 * @returns {('claude'|'codex')}
 */
function pickDriver(goal: any) {
  const text = String(goal || '').toLowerCase();
  const claudeHit = CLAUDE_KEYWORDS.some((kw) => text.includes(kw));
  const codexHit = CODEX_KEYWORDS.some((kw) => text.includes(kw));
  // Codex only wins when it matches AND Claude does not — judgment signals
  // (review/ambiguity/design) override throughput signals on a mixed goal.
  if (codexHit && !claudeHit) return 'codex';
  return 'claude';
}

/**
 * Pick the runspec mode from the goal text. Review/validation goals run as a
 * 'validation' pass; research/investigation as 'research'; everything else
 * 'build'. Kept deliberately small.
 * @param {string} goal
 * @returns {('build'|'validation'|'research')}
 */
function pickMode(goal: any) {
  const text = String(goal || '').toLowerCase();
  if (text.includes('research') || text.includes('investigate') || text.includes('root cause')) {
    return 'research';
  }
  if (text.includes('validate') || text.includes('validation') || text.includes('review')) {
    return 'validation';
  }
  return 'build';
}

function failingAcceptanceIds(bundle: any) {
  const results = Array.isArray(bundle.acceptanceResults) ? bundle.acceptanceResults : [];
  return results.filter((r: any) => r && r.status === 'fail').map((r: any) => String(r.id || '')).filter(Boolean);
}

/**
 * Derive the goal TEXT to propose from the bundle. Prefers concrete, actionable
 * signal: failing acceptance ids, then the verdict detail (request-changes /
 * block), then an explicit opts.followups item, then a generic follow-up.
 * @returns {string}
 */
function deriveGoalText(bundle: any, followups: string[]) {
  const failing = failingAcceptanceIds(bundle);
  if (failing.length) {
    return `Address failing acceptance criteria (${failing.join(', ')}) from run ${bundle.runId || 'unknown'}`;
  }
  const detail = String(bundle.detail || '').trim();
  if (bundle.verdict === 'request-changes') {
    return detail
      ? `Address review request-changes: ${detail}`
      : 'Address review request-changes from the prior run';
  }
  if (bundle.verdict === 'block') {
    return detail
      ? `Unblock the prior run: ${detail}`
      : 'Investigate and unblock the prior run';
  }
  if (followups.length) {
    return String(followups[0]);
  }
  return detail ? `Follow up on prior run: ${detail}` : 'Plan the next iteration from the prior run evidence';
}

/**
 * From a completed run's EvidenceBundle, propose the next Goal + driver.
 * Proposal only — never auto-dispatches; requiresOwnerApproval is always true.
 *
 * No-goal case: verdict 'pass' AND no failing acceptanceResults AND no
 * opts.followups → the work is complete with no obvious follow-up. NOTE this is
 * keyed on the followup SIGNAL, not on opts.proposedNextGoal: the validator's
 * proposed text is the phrasing, while a followup is what actually KEEPS the loop
 * going — a clean pass with only a "nice-to-have" proposal still converges.
 *
 * @param {EvidenceBundle} evidenceBundle
 * @param {{ followups?: string[], proposedNextGoal?: string }} [opts]
 * @returns {NextGoalProposal | NoGoal}
 */
function deriveNextGoal(evidenceBundle: any, opts: any = {}) {
  if (!isEvidenceBundle(evidenceBundle)) {
    return { no_goal: 'invalid evidence bundle' };
  }

  const followups = Array.isArray(opts && opts.followups)
    ? opts.followups.filter((f: any) => typeof f === 'string' && f.trim()).map((f: any) => f.trim())
    : [];
  // Hybrid driver: the computer-use validator folds in the authoring and may
  // supply a synthesized next goal (richer than any deterministic stitch). It is
  // PREFERRED as the goal text when present, but never changes the no-goal test.
  const proposedNextGoal =
    opts && typeof opts.proposedNextGoal === 'string' ? opts.proposedNextGoal.trim() : '';

  const failing = failingAcceptanceIds(evidenceBundle);
  const isComplete = evidenceBundle.verdict === 'pass' && failing.length === 0 && followups.length === 0;
  if (isComplete) {
    return { no_goal: `run ${evidenceBundle.runId || 'unknown'} passed with no failing criteria and no follow-ups` };
  }

  const goal = proposedNextGoal || deriveGoalText(evidenceBundle, followups);
  const agent = pickDriver(goal);
  const mode = pickMode(goal);

  const runspec = {
    goal,
    mode,
    autoValidate: false,
    autoMerge: false,
    autoRelease: false,
  };

  return {
    goal,
    agent,
    runspec,
    requiresOwnerApproval: true,
  };
}

module.exports = {
  deriveNextGoal,
  pickDriver,
};
