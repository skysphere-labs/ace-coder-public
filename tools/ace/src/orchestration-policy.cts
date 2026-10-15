// Ace mission-next policy.
//
// Single source of truth for "what is the exact next action for this
// feature?" — Hermes intake/router and workspace controllers MUST consult
// this helper instead of inferring from wake-brief, dormant streams,
// awaiting-input flags, or chat-history guessing. The contract returns one
// of eight discrete next actions plus the reason and the evidence the
// caller still has to produce before that action becomes safe.
//
// Pure, sync, no I/O.

let goalValidationPolicy: any;
try {
  goalValidationPolicy = require('./goal-validation-policy.cjs');
} catch {
  goalValidationPolicy = require('./goal-validation-policy.cts');
}
const { evaluateValidatorVerdict, evidenceIsComplete, requiresComputerUse } =
  goalValidationPolicy;
let changeRiskPolicy: any;
try {
  changeRiskPolicy = require('./change-risk-policy.cjs');
} catch {
  changeRiskPolicy = require('./change-risk-policy.cts');
}
const {
  classifyChangeRisk,
  validationBypassEvidenceComplete,
} = changeRiskPolicy;
let reviewBotPolicy: any;
try {
  reviewBotPolicy = require('./review-bot.cjs');
} catch {
  reviewBotPolicy = require('./review-bot.cts');
}
const { isFailingCheckState } = reviewBotPolicy;

const NEXT_ACTIONS = Object.freeze({
  DISPATCH_GOAL_WORKER: 'dispatch_goal_worker',
  SYNC_WORKER: 'sync_worker',
  DISPATCH_GOAL_VALIDATOR: 'dispatch_goal_validator',
  DISPATCH_FIXBACK_WORKER: 'dispatch_fixback_worker',
  GATE: 'gate',
  DISPATCH_RELEASE_GOAL: 'dispatch_release_goal',
  BLOCKED: 'blocked',
  NOTHING: 'nothing',
});

const FIXBACK_RETRY_CAP = 3;

// Hard ceiling on CONSECUTIVE spawn/link failures for one agent lane of a run.
// Independent-validator dispatch stays owner-manual, but same-stream fixback
// dispatch is automatic again (contractual review closure), so the ceiling
// guards both owner-triggered evidence and the automatic fixback loop. The
// fold clears the count only on a real link or completion.
const DISPATCH_RETRY_CAP = 3;

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function decision(next: string, reason: string, requiredEvidence: any[] = [], extra: any = {}) {
  return {
    next,
    reason,
    requiredEvidence: Array.isArray(requiredEvidence) ? requiredEvidence : [],
    ...extra,
  };
}

function firstNonEmptyArray(...values: any[]) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function policyInputFromState(state: any, spec: any) {
  const risk = asObject(state.risk || state.changeRisk || state.policyInput);
  const pr = asObject(state.pr);
  return {
    ...spec,
    ...risk,
    changedFiles: firstNonEmptyArray(
      pr.changedFiles,
      risk.changedFiles,
      risk.changed_files,
      spec.changedFiles,
      spec.changed_files,
      state.changedFiles,
    ),
    changedLineCount:
      risk.changedLineCount ??
      risk.changed_line_count ??
      spec.changedLineCount ??
      spec.changed_line_count ??
      state.changedLineCount,
    filesChanged: risk.filesChanged ?? spec.filesChanged ?? state.filesChanged,
    explicitValidationRequired:
      risk.explicitValidationRequired === true ||
      spec.explicitValidationRequired === true ||
      state.explicitValidationRequired === true,
    explicitClawpatchRequired:
      risk.explicitClawpatchRequired === true ||
      spec.explicitClawpatchRequired === true ||
      state.explicitClawpatchRequired === true,
    computerUseRequired:
      risk.computerUseRequired ?? spec.computerUseRequired ?? state.computerUseRequired,
  };
}

function manualIndependentValidationRequested(state: any, spec: any) {
  const stateValidation = asObject(state.validation);
  const specValidation = asObject(spec.validation);
  const integrate = asObject(spec.integrate);
  const merge = asObject(integrate.merge);
  return (
    state.validationRequired === true ||
    state.validation_required === true ||
    state.explicitValidationRequired === true ||
    state.explicit_validation_required === true ||
    spec.validationRequired === true ||
    spec.validation_required === true ||
    spec.explicitValidationRequired === true ||
    spec.explicit_validation_required === true ||
    stateValidation.required === true ||
    stateValidation.validationRequired === true ||
    stateValidation.validation_required === true ||
    specValidation.required === true ||
    specValidation.validationRequired === true ||
    specValidation.validation_required === true ||
    integrate.validationRequired === true ||
    integrate.validation_required === true ||
    merge.validationRequired === true ||
    merge.validation_required === true
  );
}

function bypassEvidenceFromState(state: any, policy: any, currentHeadSha: any) {
  const raw =
    state.validationBypass ||
    state.bypassEvidence ||
    asObject(state.validator).validationBypass ||
    asObject(state.merge).validationBypass ||
    {};
  return {
    ...asObject(raw),
    headSha: raw.headSha || raw.prHeadSha || raw.currentHeadSha || currentHeadSha || null,
    validationHandoff: raw.validationHandoff || state.validationHandoff || null,
  };
}

function validatedHeadFromValidator(validator: any) {
  return (
    validator.validatedHeadSha ||
    validator.headSha ||
    validator.prHeadSha ||
    validator.currentHeadSha ||
    null
  );
}

function upper(value: any) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function evidenceMatchesHead(evidence: any, currentHeadSha: any) {
  const item = asObject(evidence);
  const evidenceHead = item.headSha || item.validatedHeadSha || item.currentHeadSha || null;
  return !!currentHeadSha && !!evidenceHead && String(evidenceHead) === String(currentHeadSha);
}

// Release evidence comes from the live gate projection. Missing or stale facts
// return to the read-only gate without creating another agent lane.
function releaseEvidenceForState(state: any, policy: any, currentHeadSha: any) {
  const pr = asObject(state.pr);
  const validator = asObject(state.validator);
  const validation = asObject(pr.validation);
  const reviewBot = asObject(pr.reviewBot);
  const clawpatch = asObject(pr.clawpatch);
  const computerUseEvidence = asObject(
    pr.computerUseEvidence || validator.computerUseEvidence || state.computerUseEvidence,
  );
  const missing: string[] = [];

  if (!pr.exists) missing.push('live PR gate evidence');
  if (!currentHeadSha) missing.push('current PR head SHA');

  const nativeReviewPassed = upper(validation.self) === 'PASS';
  const nativeReviewCurrent = nativeReviewPassed && evidenceMatchesHead(validation, currentHeadSha);
  if (!nativeReviewPassed) missing.push('same-worker native review PASS');
  else if (!nativeReviewCurrent) missing.push('same-worker native review PASS on the current PR head');

  const reviewBotPassed = upper(reviewBot.state) === 'SUCCESS';
  const reviewBotCurrent = reviewBotPassed && evidenceMatchesHead(reviewBot, currentHeadSha);
  if (!reviewBotPassed) missing.push('/codex review / ReviewBot success');
  else if (!reviewBotCurrent) missing.push('/codex review / ReviewBot success on the current PR head');

  let clawpatchPassed = true;
  if (policy.clawpatchRequired === true) {
    const blocking = Array.isArray(clawpatch.blockingFindings) ? clawpatch.blockingFindings : [];
    clawpatchPassed =
      clawpatch.enforced === true &&
      clawpatch.present === true &&
      upper(clawpatch.status) === 'PASS' &&
      clawpatch.inconclusive !== true &&
      blocking.length === 0 &&
      evidenceMatchesHead(clawpatch, currentHeadSha);
    if (!clawpatchPassed) missing.push('clean Clawpatch PASS evidence on the current PR head');
  }

  let computerUsePassed = true;
  if (policy.computerUseRequired === true) {
    computerUsePassed =
      computerUseEvidence.verified === true &&
      evidenceMatchesHead(computerUseEvidence, currentHeadSha);
    if (!computerUsePassed) {
      missing.push('verified computer-use completion evidence on the current PR head');
    }
  }

  return {
    ok: missing.length === 0,
    headSha: currentHeadSha || null,
    nativeReviewPassed: nativeReviewCurrent,
    reviewBotPassed: reviewBotCurrent,
    clawpatchPassed,
    computerUsePassed,
    missing,
  };
}

function releaseDecisionAfterValidation({ pr, merge, validationLabel, worker = {}, fixback = {}, review = {}, currentHeadSha = null }: any) {
  if (!pr.exists) {
    return decision(
      NEXT_ACTIONS.DISPATCH_RELEASE_GOAL,
      `${validationLabel} — push branch and open PR via the release goal`,
      ['ReleaseGoalSpec/v1 written', 'integrate push + integrate pr-open']
    );
  }
  // A fixback round supersedes the recorded gate facts. Two independent
  // signals, because production completion records carry NO head SHA: (a) the
  // live head advanced past the head the facts were read at, (b) a fixback
  // round COMPLETED after the last gate read (event order — the round pushed,
  // so the draft flag / check states / review verdicts are stale evidence).
  // Either way: re-read at the live head before deciding — never fixback on a
  // superseded verdict, never burn the cap against frozen facts.
  const factsStale =
    (pr.headSha != null && currentHeadSha != null && String(pr.headSha) !== String(currentHeadSha)) ||
    (review.roundClosedSinceGate === true && worker.fixbackInFlight !== true);
  if (!merge.merged && factsStale) {
    return decision(
      NEXT_ACTIONS.GATE,
      review.roundClosedSinceGate === true
        ? 'PR gate facts were read before the last fixback round completed — re-read at the live head'
        : `PR gate facts are for a superseded head (${pr.headSha} != ${currentHeadSha}) — re-read at the current head`,
      ['fresh PR gate facts at the current head', 'ready-head review requested for the current head']
    );
  }
  // A draft PR is NON-TERMINAL: the review-bot skips drafts, so no review can
  // exist yet. The gate effect marks the PR ready and requests the ready-head
  // review; the run keeps gating until a real review lands.
  if (pr.exists && !merge.merged && pr.isDraft === true) {
    return decision(
      NEXT_ACTIONS.GATE,
      'PR is draft — controller marks it ready and requests ready-head ReviewBot + /codex review',
      ['PR marked ready for review', 'ReviewBot + /codex review requested for the current head']
    );
  }
  if (pr.exists && pr.checkState !== 'success') {
    const reviewBot = asObject(pr.reviewBot);
    const reviewBotFailing = isFailingCheckState(reviewBot.state);
    const ciFailing = isFailingCheckState(pr.checkState);
    if (!merge.merged && (ciFailing || reviewBotFailing)) {
      // Ordinary findings close in the ORIGINAL worker stream, automatically —
      // never via Hermes/operator forwarding. While a fixback round is in
      // flight, sync its stream; past the cap, the run is a bounded blocker.
      if (worker.fixbackInFlight === true) {
        return decision(
          NEXT_ACTIONS.SYNC_WORKER,
          'same-stream fixback is in flight for the failing review findings — sync the original worker stream',
          ['fixback DONE/BLOCKED trailer on the original worker stream']
        );
      }
      const attempts = Number(fixback.attempts) || 0;
      if (attempts >= FIXBACK_RETRY_CAP) {
        return decision(
          NEXT_ACTIONS.BLOCKED,
          `fixback retry cap (${FIXBACK_RETRY_CAP}) exhausted with PR checks still failing — bounded blocker, escalate to owner`,
          ['owner decision on further retries or scope']
        );
      }
      return decision(
        NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER,
        reviewBotFailing
          ? `PR review-bot check '${reviewBot.name || 'validate'}' is failing — return findings to the original worker stream (fixback round ${attempts + 1}/${FIXBACK_RETRY_CAP})`
          : `PR checks are failing (${pr.checkState}) — return findings to the original worker stream (fixback round ${attempts + 1}/${FIXBACK_RETRY_CAP})`,
        [
          'findings delivered into the original worker stream',
          'fix committed and branch pushed so exact-head review re-runs',
        ]
      );
    }
    return decision(
      NEXT_ACTIONS.GATE,
      `PR exists but checks are ${pr.checkState || 'pending'} — gate before merge`,
      ['green PR checks', 'PR mergeable=MERGEABLE']
    );
  }
  if (pr.exists && pr.mergeable && pr.mergeable !== 'MERGEABLE') {
    return decision(
      NEXT_ACTIONS.GATE,
      `PR mergeable=${pr.mergeable} — must be MERGEABLE before merge`,
      ['conflict-free PR']
    );
  }
  if (!merge.merged) {
    return decision(
      NEXT_ACTIONS.DISPATCH_RELEASE_GOAL,
      'PR is gated and mergeable — release goal performs the merge',
      ['integrate pr-merge', 'merge sha recorded']
    );
  }
  if (merge.merged && !merge.cleanedUp) {
    return decision(
      NEXT_ACTIONS.DISPATCH_RELEASE_GOAL,
      'merge succeeded but local worktree/branch cleanup is pending',
      ['integrate cleanup', 'local worktree removed', 'task branch removed']
    );
  }
  if (merge.merged && merge.cleanedUp) {
    return decision(
      NEXT_ACTIONS.NOTHING,
      'feature merged and cleaned up — mission card can be marked complete',
      []
    );
  }
  return decision(NEXT_ACTIONS.BLOCKED, 'unrecognised release state — escalate', [
    'human inspection of feature state',
  ]);
}

function releaseDecisionWithEvidence({ state, pr, merge, policy, currentHeadSha, validationLabel }: any) {
  const release = releaseDecisionAfterValidation({
    pr,
    merge,
    validationLabel,
    worker: asObject(state.worker),
    fixback: asObject(state.fixback),
    review: asObject(state.review),
    currentHeadSha,
  });
  if (release.next !== NEXT_ACTIONS.DISPATCH_RELEASE_GOAL) return release;
  const releaseEvidence = releaseEvidenceForState(state, policy, currentHeadSha);
  if (!releaseEvidence.ok) {
    return decision(
      NEXT_ACTIONS.GATE,
      `release evidence incomplete — ${releaseEvidence.missing.join('; ')}`,
      releaseEvidence.missing,
      { releaseEvidence },
    );
  }
  return { ...release, releaseEvidence };
}

// Required state shape:
//   worker: { dispatched, done, outcome: 'DONE'|'BLOCKED'|'NONE' }
//   validator: { dispatched, done, outcome, computerUseRequired, computerUseEvidence }
//   pr: { exists, mergeable, checkState }
//   merge: { merged, sha, cleanedUp }
//   spec: { ... } — original feature spec, used as a fallback for
//                   requiresComputerUse when the validator state omits it
function nextActionForFeature(state: any = {}) {
  const worker = asObject(state.worker);
  const validator = asObject(state.validator);
  const pr = asObject(state.pr);
  const merge = asObject(state.merge);
  const spec = asObject(state.spec);
  const policy = classifyChangeRisk(policyInputFromState(state, spec));
  const currentHeadSha =
    state.currentHeadSha ||
    state.prHeadSha ||
    pr.headSha ||
    pr.currentHeadSha ||
    merge.headSha ||
    null;
  const validatedHeadSha =
    state.validatedHeadSha ||
    validatedHeadFromValidator(validator);
  const policyExtra = {
    riskClass: policy.riskClass,
    validationRequired: policy.validationRequired,
    independentValidatorRequired: policy.independentValidatorRequired,
    clawpatchRequired: policy.clawpatchRequired,
    computerUseRequired: policy.computerUseRequired,
    currentHeadSha,
    validatedHeadSha,
    validationBypass: {
      allowed: policy.validationRequired === false,
      reason: (policy.reasons || []).join('; ') || `${policy.riskClass} change`,
      requiredEvidence: policy.evidenceRequired || [],
    },
  };

  // Current merge evidence supersedes stale worker/validator state in the
  // read model. A same-PR fixback can merge after an older validator
  // request-changes event; once the gateway/GitHub merge evidence is in the
  // ledger, the run must not remain terminally blocked on that stale verdict.
  if (merge.merged) {
    return { ...releaseDecisionAfterValidation({ pr, merge, validationLabel: 'merge evidence' }), ...policyExtra };
  }

  // -1) Dispatch retry cap. Repeated spawn/link failures fail closed once they
  // reach the cap, for owner-triggered lanes and the automatic same-stream
  // fixback loop alike.
  if ((Number(worker.dispatchFailedCount) || 0) >= DISPATCH_RETRY_CAP) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      `worker dispatch failed ${worker.dispatchFailedCount}x consecutively (cap ${DISPATCH_RETRY_CAP}) — ${worker.dispatchError || 'spawn/link error'} — fix the spec and submit a fresh run`,
      ['the exact spawn/link error', 'a corrected spec on a fresh run']
    , policyExtra);
  }
  if ((Number(validator.dispatchFailedCount) || 0) >= DISPATCH_RETRY_CAP) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      `validator dispatch failed ${validator.dispatchFailedCount}x consecutively (cap ${DISPATCH_RETRY_CAP}) — ${validator.dispatchError || 'spawn/link error'} — fix the spec and submit a fresh run`,
      ['the exact spawn/link error', 'a corrected spec on a fresh run']
    , policyExtra);
  }

  // 0) A dispatch was ATTEMPTED but the real spawn/link FAILED. Fail closed:
  // surface the exact spawn/link error to the owner instead of silently
  // re-dispatching (which would mask a persistent failure) or leaving a phantom
  // in-flight worker the board reports as healthy. A fresh dispatch marker or a
  // completion clears this (see the reconciler fold), so a transient failure can
  // still be retried by an explicit re-dispatch.
  if (worker.dispatchFailed && !worker.done) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      `worker dispatch failed — ${worker.dispatchError || 'spawn/link error'}`,
      ['a Ace-visible stream/task/worktree linked to this run', 'or the exact spawn/link error']
    , policyExtra);
  }

  // 0b) A FIXBACK-round dispatch failed after the original completion (resume
  // threw; dead stream and the same-task respawn also failed). The fold leaves
  // done=true with dispatched=false, which branch 1 below would misread as "no
  // worker yet" and spawn a REPLACEMENT lane for the original goal — a second
  // worktree/branch/PR that orphans the existing one. Fail closed instead:
  // this is a bounded infrastructure blocker.
  if (worker.dispatchFailed && worker.done) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      `same-stream fixback dispatch failed — ${worker.dispatchError || 'spawn/link error'} — bounded blocker; the original branch/PR stays authoritative (never spawn a replacement lane)`,
      ['the exact spawn/link error', 'an owner-invoked fixback re-dispatch once the stream/task is reachable']
    , policyExtra);
  }

  // 1) Worker hasn't even been dispatched yet — kick off the goal worker.
  if (!worker.dispatched) {
    return decision(
      NEXT_ACTIONS.DISPATCH_GOAL_WORKER,
      'no worker dispatched yet for this feature',
      ['GoalAgentSpec/v1 written under .ace/goals/<m>/<f>/', 'Goal Ledger initialised']
    , policyExtra);
  }

  // 2) Worker is running but no trailer yet — sync the stream.
  if (worker.dispatched && !worker.done) {
    return decision(
      NEXT_ACTIONS.SYNC_WORKER,
      'worker is dispatched but no DONE/BLOCKED trailer has been observed yet',
      ['worker stream sync', 'updated implementation-notes.html']
    , policyExtra);
  }

  // Worker finished. If it returned BLOCKED outright, the next action is
  // bounded by whether there is a parent validator already.
  if (worker.done && (worker.outcome === 'BLOCKED' || worker.outcome === 'BLOCKED_SCOPE')) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      'worker returned BLOCKED — escalate to chief before further dispatch',
      ['worker BLOCKED reason', 'human decision on scope']
    , policyExtra);
  }

  // A same-stream fixback round is in flight (fixback.dispatched appended,
  // completion not yet observed). worker.done stays true from the ORIGINAL
  // completion, so this must be checked before any gate/validator walk — the
  // only correct action is to sync the original worker stream for the round's
  // new DONE/BLOCKED trailer.
  if (worker.done && worker.fixbackInFlight === true) {
    return decision(
      NEXT_ACTIONS.SYNC_WORKER,
      'same-stream fixback is in flight on the original worker stream — waiting for its DONE/BLOCKED trailer',
      ['fixback DONE/BLOCKED trailer on the original worker stream']
    , policyExtra);
  }

  // A validator dispatch was attempted but the real spawn/link FAILED. Check
  // before the generic "no validator dispatched" branch because the reconciler
  // folds a failed validator dispatch back to dispatched=false.
  if (validator.dispatchFailed && !validator.done) {
    return decision(
      NEXT_ACTIONS.BLOCKED,
      `validator dispatch failed — ${validator.dispatchError || 'spawn/link error'}`,
      ['a Ace-visible validator stream linked to this run', 'or the exact spawn/link error']
    , policyExtra);
  }

  // 3) Worker is DONE but no validator dispatched. Ordinary review stays in
  // the original worker lane and protected PR gates: the controller requests
  // the ready-head ReviewBot + /codex review and returns any findings to the
  // SAME worker stream (bounded fixback rounds) until the exact-head review
  // passes. Independent validation is available only as a deliberate owner
  // action, never as this policy's next automatic dispatch.
  if (worker.done && !validator.dispatched) {
    const manualValidationRequested = manualIndependentValidationRequested(state, spec);
    let bypassEvidenceComplete = false;
    if (policy.validationRequired === false) {
      const evidence = bypassEvidenceFromState(state, policy, currentHeadSha);
      bypassEvidenceComplete = validationBypassEvidenceComplete(policy, evidence);
    }
    if (manualValidationRequested) {
      return decision(
        NEXT_ACTIONS.GATE,
        'manual independent validation was requested; waiting at the PR gate for owner-attached evidence',
        ['owner-requested independent validation result attached to the current head'],
        {
          ...policyExtra,
          validationBypass: {
            ...policyExtra.validationBypass,
            evidenceComplete: bypassEvidenceComplete,
          },
        }
      );
    }
    const release = releaseDecisionWithEvidence({
      state,
      pr,
      merge,
      policy,
      currentHeadSha,
      validationLabel: 'same-worker native review',
    });
    return {
      ...release,
      ...policyExtra,
      reason: `same-worker native review; ${release.reason}`,
      requiredEvidence: Array.from(new Set([
        ...(release.requiredEvidence || []),
        'same-worker native review',
        'ReviewBot result',
        '/codex review on the current PR head',
      ])),
      validationBypass: {
        ...policyExtra.validationBypass,
        evidenceComplete: bypassEvidenceComplete,
      },
    };
  }

  // 4) Validator is running.
  if (validator.dispatched && !validator.done) {
    return decision(
      NEXT_ACTIONS.SYNC_WORKER,
      'validator is dispatched but no verdict trailer has been observed yet',
      ['validator stream sync']
    , policyExtra);
  }

  // Validator finished. Evaluate the verdict through the gate so the
  // computer-use rule is applied uniformly.
  if (validator.done) {
    const computerUseRequiredFromValidator =
      validator.computerUseRequired === true ||
      (validator.computerUseRequired == null && requiresComputerUse(spec).required);
    const verdict = evaluateValidatorVerdict({
      outcome: validator.outcome,
      computerUseRequired: computerUseRequiredFromValidator,
      computerUseEvidence: validator.computerUseEvidence,
    });

    if (verdict.outcome === 'FIXBACK_REQUIRED') {
      // Validator findings are ordinary findings: they return to the ORIGINAL
      // worker stream automatically, bounded by the same fixback cap. But a
      // fixback round supersedes them — either the head advanced past the
      // attested head, or (production completions carry no head) a round
      // COMPLETED after this verdict landed. Stale findings walk the exact-head
      // review gate for the new head instead of re-fixing what a round fixed.
      const staleFindings =
        (!!currentHeadSha && !!validatedHeadSha && String(currentHeadSha) !== String(validatedHeadSha)) ||
        asObject(state.review).roundClosedSinceVerdict === true;
      if (!staleFindings) {
        const attempts = Number(asObject(state.fixback).attempts) || 0;
        if (attempts >= FIXBACK_RETRY_CAP) {
          return decision(
            NEXT_ACTIONS.BLOCKED,
            `fixback retry cap (${FIXBACK_RETRY_CAP}) exhausted with validator findings still open — bounded blocker, escalate to owner`,
            ['owner decision on further retries or scope']
          , policyExtra);
        }
        return decision(
          NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER,
          `validator returned VERDICT=request-changes — return findings to the original worker stream (fixback round ${attempts + 1}/${FIXBACK_RETRY_CAP})`,
          [
            'findings delivered into the original worker stream',
            'fix committed and branch pushed so exact-head review re-runs',
          ]
        , policyExtra);
      }
      return {
        ...releaseDecisionWithEvidence({
          state,
          pr,
          merge,
          policy,
          currentHeadSha,
          validationLabel: 'validator findings superseded by a newer head — exact-head review required',
        }),
        ...policyExtra,
      };
    }

    if (verdict.outcome === 'BLOCKED_SCOPE') {
      return decision(NEXT_ACTIONS.BLOCKED, 'validator returned VERDICT=blocked-scope', [
        'human decision on scope blocker',
      ], policyExtra);
    }

    if (verdict.outcome === 'COMPUTER_USE_REQUIRED' || verdict.nextAction === 'computer-use-required') {
      return decision(
        NEXT_ACTIONS.BLOCKED,
        verdict.failures[0] || 'validator requires computer-use evidence before re-verdict',
        [
          'ace browser screenshot evidence under evidence/',
          'ace browser console error capture',
          'checked acceptance list with pass status',
        ]
      , policyExtra);
    }

    if (verdict.outcome === 'MANUAL_REQUIRED') {
      return decision(
        NEXT_ACTIONS.BLOCKED,
        'validator returned VERDICT=manual-required — no auto re-verdict possible',
        ['recorded manual verification steps']
      , policyExtra);
    }

    if (verdict.outcome === 'NONE') {
      return decision(NEXT_ACTIONS.BLOCKED, verdict.failures[0] || 'validator returned no parseable trailer', [
        'owner may request a validator with a clearer trailer',
      ], policyExtra);
    }

    // verdict.outcome === 'PASS' (verdict.ok is true here)
    if (currentHeadSha && validatedHeadSha && currentHeadSha !== validatedHeadSha) {
      return decision(
        NEXT_ACTIONS.GATE,
        'validator PASS is stale for a previous head; owner must request validation for the current exact head',
        ['manual owner-requested validation at the current head'],
        {
          ...policyExtra,
          staleValidation: true,
        }
      );
    }
    if (currentHeadSha && !validatedHeadSha) {
      return decision(
        NEXT_ACTIONS.GATE,
        'validator PASS has no exact-head evidence; owner must request validation for the current exact head',
        ['manual owner-requested validation at the current head'],
        policyExtra
      );
    }
    // Walk the merge gate forward.
    return {
      ...releaseDecisionWithEvidence({
        state,
        pr,
        merge,
        policy,
        currentHeadSha,
        validationLabel: 'validator PASS',
      }),
      ...policyExtra,
    };
  }

  // Shouldn't reach here, but fail closed.
  return decision(NEXT_ACTIONS.BLOCKED, 'unrecognised feature state — escalate', [
    'human inspection of feature state',
  ], policyExtra);
}

module.exports = {
  NEXT_ACTIONS,
  FIXBACK_RETRY_CAP,
  DISPATCH_RETRY_CAP,
  releaseEvidenceForState,
  nextActionForFeature,
};
