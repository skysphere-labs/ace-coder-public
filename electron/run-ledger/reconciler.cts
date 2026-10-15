// reconciler — the Run Ledger FACADE.
//
// It folds the append-only event list (from event-ledger.readRun) into the
// exact `state` shape that the existing orchestration-policy spine already
// understands, then calls that spine. NO new decision logic lives here: the
// next-action verdict comes from nextActionForFeature, and the merge gate from
// evaluateMergeGate. This module only TRANSLATES events -> state -> spine input.
//
// Pure given the event list: no I/O, no Date.now()/Math.random() at module top
// level. The event log is injected (eventLog.readRun(runId)); the fold itself is
// deterministic over the events it is handed.

// Spine imports use the build-agnostic .cjs-then-.cts fallback: the compiled
// .cjs is gitignored and may be absent in a fresh worktree, but tsx resolves
// the .cts source.
let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS, FIXBACK_RETRY_CAP, nextActionForFeature } = orchestrationPolicy;

let verdictModule: any;
try {
  verdictModule = require('../../tools/ace/src/verdict.cjs');
} catch {
  verdictModule = require('../../tools/ace/src/verdict.cts');
}
const { parseValidatorRecordVerdict } = verdictModule;

let prGate: any;
try {
  prGate = require('../../tools/ace/src/pr-gate.cjs');
} catch {
  prGate = require('../../tools/ace/src/pr-gate.cts');
}
const { evaluateMergeGate } = prGate;

let autoshipPolicy: any;
try {
  autoshipPolicy = require('../../tools/ace/src/autoship-policy.cjs');
} catch {
  autoshipPolicy = require('../../tools/ace/src/autoship-policy.cts');
}
const { autoshipConfig, evaluateAutoshipPolicy } = autoshipPolicy;

const EVENT = Object.freeze({
  RUN_CREATED: 'run.created',
  WORKER_DISPATCHED: 'worker.dispatched',
  WORKER_DISPATCH_LINKED: 'worker.dispatch.linked',
  WORKER_DISPATCH_FAILED: 'worker.dispatch.failed',
  WORKER_COMPLETED: 'worker.completed',
  WORKER_TELEMETRY: 'worker.telemetry',
  VALIDATOR_DISPATCHED: 'validator.dispatched',
  VALIDATOR_DISPATCH_LINKED: 'validator.dispatch.linked',
  VALIDATOR_DISPATCH_FAILED: 'validator.dispatch.failed',
  VALIDATOR_COMPLETED: 'validator.completed',
  GATE_EVALUATED: 'gate.evaluated',
  REVIEW_REQUESTED: 'review.requested',
  FIXBACK_DISPATCHED: 'fixback.dispatched',
  AUTOSHIP_MERGE_STARTED: 'autoship.merge.started',
  AUTOSHIP_MERGE_BLOCKED: 'autoship.merge.blocked',
  MERGED: 'merged',
});

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function upper(value: any) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

// Map a worker outcome from the completed-event payload onto the spine's
// 'DONE'|'BLOCKED'|'NONE' vocabulary. Unknown/absent => 'NONE' (fail-open to
// "no usable trailer" rather than inventing a DONE).
function normalizeWorkerOutcome(outcome: any) {
  const tok = String(outcome == null ? '' : outcome).trim().toUpperCase();
  if (tok === 'DONE') return 'DONE';
  if (tok === 'BLOCKED') return 'BLOCKED';
  if (tok === 'BLOCKED_SCOPE' || tok === 'BLOCKED-SCOPE') return 'BLOCKED_SCOPE';
  return 'NONE';
}

// A validator verdict ('pass'|'request-changes'|'block') translated to the
// outcome token the policy's evaluateValidatorVerdict expects on validator.
function validatorOutcomeFromVerdict(verdict: any) {
  if (verdict === 'pass') return 'PASS';
  if (verdict === 'request-changes') return 'REQUEST-CHANGES';
  if (verdict === 'block') return 'BLOCK';
  return 'NONE';
}

// Telemetry is descriptive only — agents append it AFTER finishing a unit of
// work. It NEVER feeds nextActionForFeature (decisions stay deterministic over
// worker/validator/pr/merge state); it rides alongside so the board VIEW can
// show rubric/commands/duration/token-cost without the watcher spending a token.
// Fold each telemetry payload into a running accumulator: keep the ordered
// entries, the latest, and cheap totals.
function mergeTelemetry(state: any, raw: any, source: string) {
  const t = asObject(raw);
  if (Object.keys(t).length === 0) return;
  const entry = {
    agent: t.agent != null ? String(t.agent) : null,
    rubric: t.rubric != null ? String(t.rubric) : null,
    score: typeof t.score === 'number' ? t.score : null,
    commands: Array.isArray(t.commands) ? t.commands.filter((c: any) => typeof c === 'string') : [],
    durationMs: Number(t.durationMs) || 0,
    tokens: Number(t.tokens) || 0,
    notes: t.notes != null ? String(t.notes) : null,
    source,
  };
  state.telemetry.entries.push(entry);
  state.telemetry.latest = entry;
  state.telemetry.totals.runs += 1;
  state.telemetry.totals.commands += entry.commands.length;
  state.telemetry.totals.durationMs += entry.durationMs;
  state.telemetry.totals.tokens += entry.tokens;
}

// Fold the event list into the nextActionForFeature `state` shape. Each event
// type advances exactly the fields documented on the spine:
//   worker     { dispatched, done, outcome }
//   validator  { dispatched, done, outcome, computerUseRequired, computerUseEvidence }
//   pr         { exists, mergeable, checkState, headSha }
//   merge      { merged, sha, cleanedUp, headSha }
//   fixback    { attempts }
//   plus carried: spec, risk, currentHeadSha, validatedHeadSha
function foldEventsToState(events: any) {
  const list = Array.isArray(events) ? events : [];
  const state: any = {
    worker: { dispatched: false, linked: false, dispatchFailed: false, dispatchFailedCount: 0, dispatchError: null, done: false, outcome: 'NONE', fixbackInFlight: false },
    validator: {
      dispatched: false,
      linked: false,
      dispatchFailed: false,
      dispatchFailedCount: 0,
      dispatchError: null,
      done: false,
      outcome: 'NONE',
      computerUseRequired: undefined,
      computerUseEvidence: undefined,
    },
    pr: {
      exists: false,
      mergeable: null,
      checkState: null,
      headSha: null,
      validation: null,
      reviewBot: null,
      clawpatch: null,
      computerUseEvidence: null,
    },
    merge: { merged: false, sha: null, cleanedUp: false, headSha: null },
    autoship: { mergeStarted: false, lastBlocker: null },
    fixback: { attempts: 0 },
    // The last exact head the controller requested a ready-head review for,
    // plus EVENT-ORDER staleness flags. Production completion records carry no
    // head SHA, so head comparison alone cannot see that a fixback round
    // completed after the recorded facts — these flags encode exactly that:
    // roundClosedSinceGate    — a fixback-round completion landed after the
    //                           last gate.evaluated (its PR facts are stale;
    //                           re-read before deciding another round).
    // roundClosedSinceVerdict — a fixback-round completion landed after the
    //                           last validator.completed (its findings are
    //                           addressed; walk the exact-head review gate
    //                           instead of re-fixing them).
    review: {
      requestedHeadSha: null,
      requests: 0,
      roundClosedSinceGate: false,
      roundClosedSinceVerdict: false,
    },
    spec: {},
    risk: undefined,
    currentHeadSha: null,
    validatedHeadSha: null,
    // Descriptive only (never read by the spine). Agent-written, watcher-folded.
    telemetry: { entries: [], latest: null, totals: { runs: 0, commands: 0, durationMs: 0, tokens: 0 } },
    // Lifecycle timestamps folded from the events' own caller-supplied ts —
    // AUTO-COLLECTED (zero agent cooperation; the harness clock stamps every
    // file-ledger append). DESCRIPTIVE ONLY: like telemetry, the timeline MUST
    // NEVER feed nextActionForFeature — decisions stay deterministic over
    // worker/validator/pr/merge state (the doctrine above). The board derives
    // card age / last-transition / durations from these.
    timeline: {
      createdAt: null,
      dispatchedAt: null,
      linkedAt: null,
      workerCompletedAt: null,
      validatorCompletedAt: null,
      mergedAt: null,
      lastTs: null,
    },
  };

  const stamp = (field: string, ts: any) => {
    const n = Number(ts);
    if (!Number.isFinite(n)) return;
    state.timeline[field] = n;
  };

  for (const raw of list) {
    const event = asObject(raw);
    const payload = asObject(event.payload);
    // Timeline fold (descriptive only): first event with a ts anchors
    // createdAt; every ts advances lastTs; lifecycle events stamp their slot
    // (last write wins — a re-dispatch honestly supersedes).
    if (event.ts != null && Number.isFinite(Number(event.ts))) {
      if (state.timeline.createdAt == null) stamp('createdAt', event.ts);
      stamp('lastTs', event.ts);
      if (event.type === EVENT.WORKER_DISPATCHED) stamp('dispatchedAt', event.ts);
      else if (event.type === EVENT.WORKER_DISPATCH_LINKED) stamp('linkedAt', event.ts);
      else if (event.type === EVENT.WORKER_COMPLETED) stamp('workerCompletedAt', event.ts);
      else if (event.type === EVENT.VALIDATOR_COMPLETED) stamp('validatorCompletedAt', event.ts);
      else if (event.type === EVENT.MERGED) stamp('mergedAt', event.ts);
    }
    switch (event.type) {
      case EVENT.RUN_CREATED: {
        if (payload.spec !== undefined) state.spec = asObject(payload.spec);
        if (payload.risk !== undefined) state.risk = payload.risk;
        if (payload.currentHeadSha != null) state.currentHeadSha = payload.currentHeadSha;
        if (payload.validatedHeadSha != null) state.validatedHeadSha = payload.validatedHeadSha;
        break;
      }
      case EVENT.WORKER_DISPATCHED: {
        // The durable "we started it" marker. By itself it is NOT proof the
        // worker exists — that is the linked event below. A fresh attempt
        // supersedes any earlier failure on this run.
        state.worker.dispatched = true;
        state.worker.dispatchFailed = false;
        state.worker.dispatchError = null;
        break;
      }
      case EVENT.WORKER_DISPATCH_LINKED: {
        // Positive proof: a real, Ace-visible stream/task/worktree was
        // created and linked. This is the ONLY evidence that confirms a healthy
        // dispatch (see board-projection, which reads the same link).
        state.worker.dispatched = true;
        state.worker.linked = true;
        state.worker.dispatchFailed = false;
        state.worker.dispatchFailedCount = 0;
        state.worker.dispatchError = null;
        break;
      }
      case EVENT.WORKER_DISPATCH_FAILED: {
        // The marker was written but the real spawn/link FAILED — fail closed:
        // the worker is NOT dispatched, and the exact error rides to the gate
        // decision so the run blocks with dispatch_failed instead of looking
        // like a healthy in-flight worker. The consecutive-failure count is
        // deliberately NOT reset by a bare re-dispatch marker (only a real link
        // or completion clears it) so the retry cap can end a doomed loop.
        state.worker.dispatched = false;
        state.worker.linked = false;
        state.worker.fixbackInFlight = false;
        state.worker.dispatchFailed = true;
        state.worker.dispatchFailedCount = (Number(state.worker.dispatchFailedCount) || 0) + 1;
        state.worker.dispatchError = payload.error != null ? String(payload.error) : 'worker dispatch failed';
        break;
      }
      case EVENT.WORKER_COMPLETED: {
        // Capture BEFORE the flags below mutate: does this completion close an
        // in-flight fixback round? If so, every gate fact and validator verdict
        // recorded before it is now stale evidence (see state.review above).
        if (state.worker.fixbackInFlight === true) {
          state.review.roundClosedSinceGate = true;
          state.review.roundClosedSinceVerdict = true;
        }
        state.worker.dispatched = true;
        state.worker.done = true;
        state.worker.fixbackInFlight = false;
        // A real completion supersedes any earlier dispatch-failure noise.
        state.worker.dispatchFailed = false;
        state.worker.dispatchFailedCount = 0;
        state.worker.dispatchError = null;
        state.worker.outcome = normalizeWorkerOutcome(payload.outcome);
        // A worker completion carries the head it produced; treat it as the
        // current head and let later events override.
        if (payload.headSha != null) state.currentHeadSha = payload.headSha;
        if (payload.currentHeadSha != null) state.currentHeadSha = payload.currentHeadSha;
        if (payload.spec !== undefined) state.spec = asObject(payload.spec);
        if (payload.risk !== undefined) state.risk = payload.risk;
        // Telemetry may ride on the completion event (agent reports it on finish).
        if (payload.telemetry !== undefined) mergeTelemetry(state, payload.telemetry, 'worker.completed');
        break;
      }
      case EVENT.WORKER_TELEMETRY: {
        // A standalone telemetry append (rubric/commands/duration/tokens) the
        // agent emits after its work. Descriptive only; advances no spine state.
        mergeTelemetry(state, payload.telemetry !== undefined ? payload.telemetry : payload, 'worker.telemetry');
        break;
      }
      case EVENT.VALIDATOR_DISPATCHED: {
        state.validator.dispatched = true;
        state.validator.dispatchFailed = false;
        state.validator.dispatchError = null;
        break;
      }
      case EVENT.VALIDATOR_DISPATCH_LINKED: {
        state.validator.dispatched = true;
        state.validator.linked = true;
        state.validator.dispatchFailed = false;
        state.validator.dispatchFailedCount = 0;
        state.validator.dispatchError = null;
        break;
      }
      case EVENT.VALIDATOR_DISPATCH_FAILED: {
        // Consecutive-failure count survives a bare re-dispatch marker (only a
        // real link or completion clears it) so the retry cap can end the
        // dispatched->failed->re-dispatched storm a stale-head revalidation
        // request can otherwise spin forever.
        state.validator.dispatched = false;
        state.validator.linked = false;
        state.validator.dispatchFailed = true;
        state.validator.dispatchFailedCount = (Number(state.validator.dispatchFailedCount) || 0) + 1;
        state.validator.dispatchError = payload.error != null ? String(payload.error) : 'validator dispatch failed';
        break;
      }
      case EVENT.VALIDATOR_COMPLETED: {
        // A fresh verdict supersedes any round-closure staleness on the
        // validator lane.
        state.review.roundClosedSinceVerdict = false;
        state.validator.dispatched = true;
        state.validator.done = true;
        state.validator.dispatchFailed = false;
        state.validator.dispatchFailedCount = 0;
        state.validator.dispatchError = null;
        // Prefer a parsed verdict from the embedded trailer record; otherwise
        // fall back to an explicit outcome on the payload.
        const parsed = payload.record != null ? parseValidatorRecordVerdict(payload.record) : null;
        if (parsed && parsed.verdict) {
          state.validator.outcome = validatorOutcomeFromVerdict(parsed.verdict);
        } else if (payload.outcome != null) {
          state.validator.outcome = String(payload.outcome).trim().toUpperCase();
        }
        if (payload.computerUseRequired != null) {
          state.validator.computerUseRequired = payload.computerUseRequired === true;
        }
        if (payload.computerUseEvidence != null) {
          state.validator.computerUseEvidence = payload.computerUseEvidence;
        }
        // The head the validator actually attested to.
        const validatedHead =
          payload.validatedHeadSha != null
            ? payload.validatedHeadSha
            : payload.headSha != null
              ? payload.headSha
              : null;
        if (validatedHead != null) {
          state.validatedHeadSha = validatedHead;
          state.validator.validatedHeadSha = validatedHead;
        }
        // Validator telemetry (its rubric scorecard / commands) rides here too.
        if (payload.telemetry !== undefined) mergeTelemetry(state, payload.telemetry, 'validator.completed');
        break;
      }
      case EVENT.GATE_EVALUATED: {
        state.pr.exists = payload.prExists != null ? payload.prExists === true : true;
        if (payload.mergeable != null) state.pr.mergeable = payload.mergeable;
        if (payload.checkState != null) state.pr.checkState = payload.checkState;
        if (payload.headSha != null) {
          state.pr.headSha = payload.headSha;
          state.currentHeadSha = payload.headSha;
        }
        if (payload.baseSha != null) state.pr.baseSha = payload.baseSha;
        if (payload.prNumber != null) state.pr.number = payload.prNumber;
        if (payload.prUrl != null) state.pr.url = payload.prUrl;
        if (payload.baseBranch != null) state.pr.baseBranch = payload.baseBranch;
        if (payload.headBranch != null) state.pr.headBranch = payload.headBranch;
        if (payload.isDraft != null) state.pr.isDraft = payload.isDraft === true;
        if (payload.tracked != null) state.pr.tracked = payload.tracked === true;
        if (payload.allowedPaths != null) state.pr.allowedPaths = payload.allowedPaths;
        if (payload.changedFiles != null) state.pr.changedFiles = payload.changedFiles;
        // These facts all come from one live PR-head observation. Clear absent
        // values on every gate event so evidence from a previous head/check run
        // cannot survive a fresh read and accidentally authorize release.
        state.pr.validation = payload.validation != null ? payload.validation : null;
        state.pr.reviewBot = payload.reviewBot != null ? payload.reviewBot : null;
        state.pr.clawpatch = payload.clawpatch != null ? payload.clawpatch : null;
        state.pr.computerUseEvidence =
          payload.computerUseEvidence != null ? payload.computerUseEvidence : null;
        if (
          payload.headSha != null &&
          payload.validation &&
          upper(asObject(payload.validation).independent) === 'PASS'
        ) {
          state.validatedHeadSha = payload.headSha;
          state.validator.validatedHeadSha = payload.headSha;
        }
        if (payload.prState != null) state.pr.state = payload.prState;
        // Fresh facts supersede any round-closure staleness — but ONLY a read
        // that attests a real head. A headless gate event (a degraded/legacy
        // read) retains the previous head's check states in this fold, so it
        // must not clear the flag and re-authorize a fixback on stale evidence.
        if (payload.headSha != null) state.review.roundClosedSinceGate = false;
        break;
      }
      case EVENT.AUTOSHIP_MERGE_STARTED: {
        state.autoship.mergeStarted = true;
        state.autoship.lastBlocker = null;
        break;
      }
      case EVENT.AUTOSHIP_MERGE_BLOCKED: {
        state.autoship.mergeStarted = false;
        state.autoship.lastBlocker = payload.reason || payload.error || null;
        break;
      }
      case EVENT.MERGED: {
        state.autoship.mergeStarted = false;
        state.merge.merged = true;
        state.pr.exists = true;
        state.pr.state = payload.prState || payload.state || 'MERGED';
        if (payload.prNumber != null) state.pr.number = payload.prNumber;
        if (payload.prUrl != null) state.pr.url = payload.prUrl;
        if (payload.baseBranch != null) state.pr.baseBranch = payload.baseBranch;
        if (payload.headBranch != null) state.pr.headBranch = payload.headBranch;
        if (payload.sha != null) state.merge.sha = payload.sha;
        if (payload.headSha != null) {
          state.merge.headSha = payload.headSha;
          state.pr.headSha = payload.headSha;
          state.currentHeadSha = payload.headSha;
        }
        if (payload.cleanedUp != null) state.merge.cleanedUp = payload.cleanedUp === true;
        break;
      }
      case EVENT.REVIEW_REQUESTED: {
        if (payload.headSha != null) state.review.requestedHeadSha = String(payload.headSha);
        state.review.requests = (Number(state.review.requests) || 0) + 1;
        break;
      }
      case EVENT.FIXBACK_DISPATCHED: {
        state.fixback.attempts = (Number(state.fixback.attempts) || 0) + 1;
        // A fixback dispatch reopens the worker lane: worker.done stays true
        // from the ORIGINAL completion (fixback is the only re-dispatch that
        // happens after a completion), so `dispatched && !done` alone cannot
        // see this in-flight worker. The flag is cleared by the fixback
        // worker's own WORKER_COMPLETED or WORKER_DISPATCH_FAILED above; the
        // kernel force guard and runFixback pre-check read it to refuse a
        // concurrent duplicate fixback on the same branch/worktree lineage.
        state.worker.fixbackInFlight = true;
        break;
      }
      default:
        break;
    }
  }

  return state;
}

// Map the folded state (and the gate-relevant facts it carries) onto the
// flat input shape evaluateMergeGate expects. No new gate logic — just the
// field translation so the spine gate reads the same evidence the policy saw.
function buildGateInput(state: any, _events: any) {
  const pr = asObject(state.pr);
  const merge = asObject(state.merge);
  const workerLink = latestDispatchLink(_events, 'worker.dispatch.linked');
  const cfg = autoshipConfig(state.spec);
  const currentHeadSha = state.currentHeadSha || pr.headSha || merge.headSha || null;
  const validatedHeadSha = state.validatedHeadSha || asObject(state.validator).validatedHeadSha || null;
  const allowedPaths = Array.isArray(cfg.allowPaths) && cfg.allowPaths.length ? cfg.allowPaths : pr.allowedPaths ?? [];
  const expectedBaseBranch =
    Array.isArray(cfg.targetBranches) && cfg.targetBranches.length === 1 ? cfg.targetBranches[0] : pr.baseBranch ?? null;
  return {
    tracked: pr.tracked === true || !!workerLink.taskId,
    prNumber: pr.number ?? null,
    prUrl: pr.url ?? null,
    baseBranch: pr.baseBranch ?? null,
    expectedBaseBranch,
    headBranch: pr.headBranch ?? null,
    // Pin the validated head as the expected head; the live head is the actual.
    expectedHeadSha: validatedHeadSha,
    actualHeadSha: currentHeadSha,
    checkState: pr.checkState ?? null,
    mergeable: pr.mergeable ?? null,
    prState: pr.state ?? null,
    isDraft: pr.isDraft === true,
    validation: asObject(pr.validation),
    allowedPaths,
    changedFiles: pr.changedFiles ?? [],
    branch: workerLink.branch || pr.headBranch || null,
    worktreePath: workerLink.worktreePath || null,
  };
}

function latestDispatchLink(events: any, type: string) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = asObject(list[i]);
    if (e.type === type && e.payload) return asObject(e.payload);
  }
  return {};
}

// Read the run's events, fold to state, ask the spine for the next action, and
// (only when the spine says GATE, or the caller forces it via deps.wantGate)
// evaluate the merge gate. Returns the derived state alongside both verdicts.
function reconcile(runId: any, eventLog: any, deps: any = {}) {
  if (!eventLog || typeof eventLog.readRun !== 'function') {
    throw new Error('reconciler: eventLog with readRun(runId) is required');
  }
  const events = eventLog.readRun(runId);
  const state = foldEventsToState(events);
  const decision = nextActionForFeature(state);
  const gate =
    decision.next === NEXT_ACTIONS.GATE || deps.wantGate === true
      ? evaluateMergeGate(buildGateInput(state, events))
      : null;
  const autoship = evaluateAutoshipPolicy({ spec: state.spec, state, gate });
  return { state, decision, gate, autoship };
}

module.exports = {
  foldEventsToState,
  buildGateInput,
  reconcile,
  FIXBACK_RETRY_CAP,
};
