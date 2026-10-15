// autonomy-loop — the PURE brain of the outer-loop neuron. Given a settled run's
// folded state + decision + the validator's computer-use evidence, it decides
// whether the loop continues (and builds the next cycle's intent) or terminates
// (converged | blocked | no-progress | cap-hit). All side effects (reading the
// ledger, reading completion.json, submitting the next run, notifying) live in
// the controller; this module is a deterministic function of its inputs so the
// whole loop policy is unit-testable with fixtures.
//
// Pure module: no I/O, no clocks, no Date.now()/Math.random().

// Build-agnostic sibling imports.
let completionPacket: any;
try { completionPacket = require('./completion-packet.cjs'); }
catch { completionPacket = require('./completion-packet.cts'); }
const { buildEvidenceBundle } = completionPacket;

let nextGoalModule: any;
try { nextGoalModule = require('./next-goal.cjs'); }
catch { nextGoalModule = require('./next-goal.cts'); }
const { deriveNextGoal } = nextGoalModule;

let loopSignatureModule: any;
try { loopSignatureModule = require('./loop-signature.cjs'); }
catch { loopSignatureModule = require('./loop-signature.cts'); }
const { followupSignature, classifyLoopTerminal, lineageIdOf } = loopSignatureModule;

// Map the spine's validator outcome vocabulary onto the EvidenceBundle verdict.
// Only 'pass' enables convergence; everything blocking maps to 'block'; the
// fixback/request-changes family maps to 'request-changes'; unknown → null.
function verdictFromState(state: any) {
  const outcome = String((state && state.validator && state.validator.outcome) || '').trim().toUpperCase();
  if (outcome === 'PASS') return 'pass';
  if (outcome === 'FIXBACK_REQUIRED' || outcome === 'REQUEST-CHANGES') return 'request-changes';
  if (outcome === 'BLOCKED_SCOPE' || outcome === 'MANUAL_REQUIRED' || outcome === 'COMPUTER_USE_REQUIRED' || outcome === 'BLOCK') {
    return 'block';
  }
  return null;
}

// Merge the validator's adversarial followups with any worker self-report, then
// de-duplicate by normalized identity (followupSignature dedups by the same
// normalization, so we just concat + let the signature collapse cosmetics).
function mergeFollowups(validatorFollowups: any, workerFollowups: any) {
  const a = Array.isArray(validatorFollowups) ? validatorFollowups : [];
  const b = Array.isArray(workerFollowups) ? workerFollowups : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...a, ...b]) {
    const s = typeof f === 'string' ? f.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Build the intent for the NEXT cycle. It INHERITS the parent's allow-paths +
 * workspace verbatim (scope cannot widen autonomously, same-workspace only),
 * carries the lineage identity + incremented iteration, and continues the SAME
 * branch. It deliberately carries NO featureId/laneId (the run↔task collision
 * guard) and NO ownerAuthToken (auto-iterated cycles NEVER merge — the owner
 * merges the converged branch with their token).
 * @returns {object} the kernel intent for cycle iteration+1
 */
function nextCycleIntent({ spec, runId, lineageId, nextGoal, continueBranch, continueWorktreePath }: any) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const scope = s.scope && typeof s.scope === 'object' ? s.scope : {};
  const iteration = (Number(s.iteration) || 1) + 1;
  const intent: any = {
    goal: nextGoal.goal,
    // INHERIT scope verbatim — never widen autonomously.
    scope: { workspaceId: scope.workspaceId, allow: Array.isArray(scope.allow) ? scope.allow : [] },
    agent: nextGoal.agent,
    autoIterate: true,
    iteration,
    maxIterations: Number(s.maxIterations) > 0 ? Number(s.maxIterations) : 5,
    loopLineageId: lineageId,
    parentRunId: String(runId),
  };
  // Carry the original acceptance forward so the next cycle is re-validated
  // against the same bar (plus whatever new followups its goal text encodes).
  if (Array.isArray(s.acceptance) && s.acceptance.length) intent.acceptance = s.acceptance;
  // Continue the SAME branch (the feature converges on one branch/PR).
  if (continueBranch) intent.continueBranch = String(continueBranch);
  if (continueWorktreePath) intent.continueWorktreePath = String(continueWorktreePath);
  return intent;
}

/**
 * Decide the loop's move at a settled run. Returns:
 *   { terminal, reason, signature, bundle, nextGoal, nextIntent }
 * where terminal ∈ converged|blocked|no-progress|cap-hit|continue and nextIntent
 * is the cycle iteration+1 intent (only when terminal==='continue', else null).
 *
 * @param {{
 *   runId: string,
 *   spec: object,                       // state.spec (the intake spec)
 *   state: object,                      // folded run state
 *   decision: { next?: string },        // reconciler decision
 *   computerUseEvidence: boolean,       // from the validator's completion.json (artifact-verified)
 *   validatorFollowups: string[],       // adversarial followups from completion.json
 *   proposedNextGoal: string,           // validator-authored next goal text
 *   workerFollowups?: string[],         // worker self-report (e.g. BLOCKED detail)
 *   priorSignature?: string|null,       // the lineage's most recent followup signature
 *   workerBranch?: string|null,         // branch to continue (worker.dispatch.linked)
 *   workerWorktreePath?: string|null,
 * }} input
 */
function decideNextCycle(input: any = {}) {
  const spec = input.spec && typeof input.spec === 'object' ? input.spec : {};
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  const lineageId = lineageIdOf(input.runId, spec);
  const computerUseEvidence = input.computerUseEvidence === true;

  let followups = mergeFollowups(input.validatorFollowups, input.workerFollowups);
  // Missing computer-use evidence is itself a gap: inject it as a followup so the
  // loop re-dispatches to OBTAIN real evidence (and so the signature is non-empty
  // — a run that keeps failing to produce evidence trips no-progress, not a
  // silent infinite spin).
  if (!computerUseEvidence) {
    followups = [...followups, 'produce real computer-use behavioral evidence — none was recorded for this run'];
  }
  const signature = followupSignature(followups);

  const bundle = buildEvidenceBundle({
    runId: input.runId,
    verdict: verdictFromState(state),
    computerUseEvidence,
    diffScope: {
      allowedPaths: (spec.scope && Array.isArray(spec.scope.allow)) ? spec.scope.allow : [],
      changedFiles: (state.pr && Array.isArray(state.pr.changedFiles)) ? state.pr.changedFiles : [],
    },
    pr: state.pr && state.pr.url ? { url: state.pr.url, headSha: state.pr.headSha || '', baseSha: state.pr.baseSha || '', checks: state.pr.checkState || '' } : null,
    detail: String((state.validator && state.validator.detail) || (state.worker && state.worker.detail) || ''),
  });

  const nextGoal = deriveNextGoal(bundle, { followups, proposedNextGoal: input.proposedNextGoal });

  const verdict = classifyLoopTerminal({
    bundle,
    decision: input.decision || null,
    nextGoal,
    iteration: Number(spec.iteration) || 1,
    maxIterations: Number(spec.maxIterations) || 0,
    signature,
    lastSignature: input.priorSignature || '',
  });

  let nextIntent: any = null;
  if (verdict.terminal === 'continue' && !('no_goal' in nextGoal)) {
    nextIntent = nextCycleIntent({
      spec,
      runId: input.runId,
      lineageId,
      nextGoal,
      continueBranch: input.workerBranch,
      continueWorktreePath: input.workerWorktreePath,
    });
  }

  return {
    terminal: verdict.terminal,
    reason: verdict.reason,
    lineageId,
    iteration: Number(spec.iteration) || 1,
    signature,
    followups,
    computerUseEvidence,
    bundle,
    nextGoal,
    nextIntent,
  };
}

module.exports = {
  decideNextCycle,
  nextCycleIntent,
  verdictFromState,
  mergeFollowups,
};
