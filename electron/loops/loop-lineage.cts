// loop-lineage — the OBSERVE / re-ingest side of a Loop (PRD §3, §8).
//
// A Loop is composition over the run-ledger spine: each iteration of a loop is a
// CANONICAL run on the ledger, tagged with its loopId (PRD §2 invariant 3). This
// module reads the spine's OUTPUT — the per-iteration `state` the run-ledger
// reconciler produces (`foldEventsToState` in electron/run-ledger/reconciler.cts:
// `{ worker, validator, pr, merge, fixback, telemetry, currentHeadSha, ... }`) —
// and FOLDS the loop's ordered iteration states into a single LoopLineageState
// the Loop Host's controller reads to decide continue|terminal.
//
// It READS spine output and NEVER writes (PRD §2 invariant 2: loops never bypass
// or write the spine). The Host derives loop lineage by folding those runs
// read-only (PRD §8 "the Host derives loop lineage by folding those runs").
//
// PURITY (PRD §5, §R2): pure given the iteration list — no better-sqlite3, no
// Electron, no top-level Date.now / Math.random. The only "effects" are the
// iteration states handed in (themselves produced by the injected ledger +
// reconciler upstream), so this module is unit-testable with synthetic states.

import type { StopState, LoopKind } from './loop-spec.cts';

/**
 * One run-ledger reconciler state, as produced by foldEventsToState. We only
 * read the fields the lineage fold needs; the shape is intentionally permissive
 * (the reconciler may carry more). All fields optional so a partial/synthetic
 * iteration state folds without throwing.
 *
 * @typedef {Object} IterationRunState
 */
export interface IterationRunState {
  /** worker rollup: { dispatched, linked, done, outcome, ... }. */
  worker?: any;
  /** validator rollup: { dispatched, done, outcome, computerUseEvidence, ... }. */
  validator?: any;
  /** pr rollup: { exists, mergeable, checkState, headSha, ... }. */
  pr?: any;
  /** merge rollup: { merged, sha, cleanedUp, headSha }. */
  merge?: any;
  /** fixback rollup: { attempts }. */
  fixback?: any;
  /**
   * Descriptive telemetry the reconciler folds for free (rubric/commands/
   * duration/tokens). `totals.tokens` is the only spend signal the spine carries
   * today; treated as a token-spend proxy (see PRD §7 spend_money guardrail).
   */
  telemetry?: any;
  currentHeadSha?: any;
  validatedHeadSha?: any;
  [key: string]: any;
}

/**
 * The per-iteration projection the lineage fold derives from one IterationRunState.
 * Flat, owner/controller-readable: enough to classify continue|terminal without
 * re-reading raw events.
 *
 * @typedef {Object} LoopIteration
 */
export interface LoopIteration {
  /** 0-based ordinal of this iteration within the loop lineage. */
  index: number;
  /** optional run id when the caller tagged the iteration state with one. */
  runId?: string;
  /** worker outcome token: 'DONE'|'BLOCKED'|'BLOCKED_SCOPE'|'NONE'. */
  workerOutcome: string;
  workerDone: boolean;
  /** validator verdict token: 'PASS'|'REQUEST-CHANGES'|'BLOCK'|'NONE'. */
  validatorOutcome: string;
  validatorDone: boolean;
  /** a real computer-use behavioral test was attested this iteration. */
  computerUseEvidence: boolean;
  /** PR opened for this iteration. */
  prExists: boolean;
  /** PR number this iteration's gate observed, or null (for a CI-failure fixback goal). */
  prNumber: number | null;
  /** PR url this iteration's gate observed, or null. */
  prUrl: string | null;
  /**
   * Aggregate PR check state the gate folded ('success'|'failure'|'pending'|…), or
   * null when no gate ran. A code iteration that parked with checkState!=='success'
   * is a CI failure the loop turns into the next iteration's fixback goal.
   */
  checkState: string | null;
  /** this iteration's branch merged to main (owner-gated; PRD §2 invariant 5). */
  merged: boolean;
  /** head sha this iteration produced (progress signal across iterations). */
  headSha: string | null;
  /** fixback attempts recorded on this iteration. */
  fixbackAttempts: number;
  /** token spend proxy from telemetry.totals.tokens (PRD §7). */
  tokens: number;
  /** approximate USD spend if the caller stamped one onto telemetry; else 0. */
  spendUsd: number;
  /**
   * Terminal stop-state this single iteration resolved to, mapped onto the
   * shared StopState vocabulary (loop-spec). A non-terminal iteration is null.
   */
  stopState: StopState | null;
  /** the iteration produced NEW work vs the prior iteration (head/outcome moved). */
  madeProgress: boolean;
}

/**
 * The folded view of a whole loop's iteration history — what the Loop Host's
 * controller (`classifyLoopTerminal`) reads. Pure projection of the ordered
 * iteration states.
 *
 * @typedef {Object} LoopLineageState
 */
export interface LoopLineageState {
  /** the loop this lineage belongs to (stable kebab id from the LoopSpec). */
  loopId: string;
  /** per-iteration projections, in order. */
  iterations: LoopIteration[];
  /** number of iterations folded (iterations.length). */
  iterationCount: number;
  /** Σ spendUsd across iterations (token-token proxy when no USD stamped). */
  totalSpendUsd: number;
  /** Σ tokens across iterations (descriptive). */
  totalTokens: number;
  /**
   * index of the LAST iteration that made progress, or null if none did. A loop
   * that has not progressed past this for N iterations is the no-progress signal
   * the controller stalls on (PRD §6 reuse of harness no-progress semantics).
   */
  lastProgressAt: number | null;
  /** the EVIDENCE the latest iteration produced (its flat projection), or null. */
  lastEvidence: LoopIteration | null;
  /**
   * the latest iteration's resolved StopState, or null when the latest iteration
   * is still mid-flight (no terminal yet). This is the loop's current outcome.
   */
  latestRunOutcome: StopState | null;
}

function asObject(value: any): any {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normToken(value: any): string {
  const tok = String(value == null ? '' : value).trim().toUpperCase();
  return tok || 'NONE';
}

/**
 * Map ONE iteration's reconciler state onto the shared StopState vocabulary
 * (loop-spec). Fail-closed and deterministic — only positive evidence resolves a
 * terminal; ambiguous / in-flight iterations resolve to null (not-terminal).
 *
 * Precedence (most decisive first):
 *  - merged                         → DONE        (owner-gated merge landed)
 *  - worker BLOCKED / BLOCKED_SCOPE → BLOCKED
 *  - validator BLOCK                → BLOCKED
 *  - validator REQUEST-CHANGES      → NEEDS_OWNER_DECISION (needs another pass)
 *  - validator PASS + PR open       → READY_FOR_REVIEW (parks owner-gated, §5)
 *  - validator PASS (no PR)         → DONE         (agentic: evidence is the ship)
 *  - agentic worker DONE            → DONE         (PRD §1/§9: evidence-only, no PR)
 *  - worker DONE, no PR, no validator→ CLEAN_NOOP  (finished, produced nothing)
 *  - otherwise                      → null         (still in-flight)
 *
 * `kind` is the LoopSpec.kind threaded from the fold (default 'code'). For an
 * AGENTIC loop (PRD §1/§9) evidence is the ship: a worker that finishes DONE is a
 * TERMINAL iteration even when it produced a head and never opened a PR or ran a
 * validator — agentic loops never gate on validator-pass / PR / merge. For a CODE
 * loop the same worker-DONE-with-head is still IN-FLIGHT (a PR is about to open),
 * so the agentic terminal is gated behind kind==='agentic' and never changes the
 * code path (every Slice-1 lineage fixture folds identically).
 */
function iterationStopState(iter: LoopIteration, kind?: LoopKind): StopState | null {
  if (iter.merged) return 'DONE';

  const wo = iter.workerOutcome;
  if (wo === 'BLOCKED' || wo === 'BLOCKED_SCOPE' || wo === 'BLOCKED-SCOPE') return 'BLOCKED';

  const vo = iter.validatorOutcome;
  if (iter.validatorDone) {
    if (vo === 'BLOCK') return 'BLOCKED';
    if (vo === 'REQUEST-CHANGES' || vo === 'REQUEST_CHANGES') return 'NEEDS_OWNER_DECISION';
    if (vo === 'PASS') return iter.prExists ? 'READY_FOR_REVIEW' : 'DONE';
  }

  // AGENTIC (PRD §1/§9): evidence is the ship. A finished worker IS the terminal —
  // no validator/PR/merge. A blocked worker was already caught above; an in-flight
  // worker (not done) falls through to null. This is gated on kind so a code loop's
  // worker-DONE-with-head stays in-flight (its PR has yet to open).
  if (kind === 'agentic' && iter.workerDone && wo === 'DONE') return 'DONE';

  // Worker finished cleanly but produced no PR and no head movement and no
  // validator — a clean no-op iteration (nothing to do).
  if (iter.workerDone && wo === 'DONE' && !iter.prExists && !iter.headSha && !iter.validatorDone) {
    return 'CLEAN_NOOP';
  }

  return null;
}

/**
 * Project ONE run-ledger reconciler state into a flat LoopIteration. `prior` is
 * the immediately-preceding projection (or null for the first), used only for
 * the progress comparison.
 */
function projectIteration(rawState: any, index: number, prior: LoopIteration | null, kind?: LoopKind): LoopIteration {
  const state = asObject(rawState);
  const worker = asObject(state.worker);
  const validator = asObject(state.validator);
  const pr = asObject(state.pr);
  const merge = asObject(state.merge);
  const fixback = asObject(state.fixback);
  const telemetry = asObject(state.telemetry);
  const totals = asObject(telemetry.totals);

  const headSha =
    state.currentHeadSha != null
      ? String(state.currentHeadSha)
      : merge.headSha != null
        ? String(merge.headSha)
        : pr.headSha != null
          ? String(pr.headSha)
          : null;

  const tokens = toFiniteNumber(totals.tokens);
  // spend_money proxy (PRD §7): callers may stamp an approximate USD onto the
  // iteration state or telemetry totals; otherwise spend is 0 (token spend is
  // descriptive-only and not counted as money).
  const spendUsd = toFiniteNumber(
    state.spendUsd != null ? state.spendUsd : totals.spendUsd != null ? totals.spendUsd : 0,
  );

  const iter: LoopIteration = {
    index,
    runId: state.runId != null ? String(state.runId) : undefined,
    workerOutcome: normToken(worker.outcome),
    workerDone: worker.done === true,
    validatorOutcome: normToken(validator.outcome),
    validatorDone: validator.done === true,
    computerUseEvidence: validator.computerUseEvidence === true,
    prExists: pr.exists === true,
    prNumber: pr.number != null && Number.isFinite(Number(pr.number)) ? Number(pr.number) : null,
    prUrl: pr.url != null ? String(pr.url) : null,
    checkState: pr.checkState != null ? String(pr.checkState) : null,
    merged: merge.merged === true,
    headSha,
    fixbackAttempts: toFiniteNumber(fixback.attempts),
    tokens,
    spendUsd,
    stopState: null,
    madeProgress: false,
  };

  iter.stopState = iterationStopState(iter, kind);

  // Progress = this iteration advanced the loop beyond the prior one. The first
  // iteration makes progress if it did ANYTHING observable (a worker outcome, a
  // head, a PR, or a terminal). Subsequent iterations make progress when the
  // head moved, a terminal was reached that the prior had not, the PR newly
  // exists, or a merge landed.
  if (!prior) {
    iter.madeProgress =
      iter.workerDone ||
      iter.validatorDone ||
      iter.prExists ||
      iter.merged ||
      iter.headSha != null ||
      iter.stopState != null;
  } else {
    // A head that moves AFTER the prior iteration already PASSED validation does
    // NOT count as progress — it INVALIDATES that validation (the validated head is
    // now stale) and forces a re-validation, so the churn must not read as advancing
    // toward convergence (that is what stalls the validate/park closeout loop: a
    // post-PASS head bump looked like progress and reset the no-progress detector,
    // so the loop never settled). An UN-validated head move (ordinary builder
    // progress) still counts, and a head move after a request-changes verdict is the
    // fixback the loop asked for — that progress is carried by newValidatorVerdict.
    const priorPassValidated = prior.validatorDone && prior.validatorOutcome === 'PASS';
    const headMoved = iter.headSha != null && iter.headSha !== prior.headSha && !priorPassValidated;
    const newPr = iter.prExists && !prior.prExists;
    const newMerge = iter.merged && !prior.merged;
    const newTerminal = iter.stopState != null && prior.stopState == null;
    const newValidatorVerdict =
      iter.validatorDone && (!prior.validatorDone || iter.validatorOutcome !== prior.validatorOutcome);
    iter.madeProgress = headMoved || newPr || newMerge || newTerminal || newValidatorVerdict;
  }

  return iter;
}

/**
 * Fold a loop's ordered iteration run states (each produced by the run-ledger
 * reconciler's foldEventsToState) into a single LoopLineageState.
 *
 * Pure given the iteration list — no I/O, no clock. The caller is responsible
 * for reading the canonical runs off the ledger (read-only) and reconciling each
 * to a state BEFORE handing the ordered list here; this is the observe/reingest
 * seam, never a writer (PRD §2 invariants 2 & 3).
 *
 * @param loopId           the loop this lineage belongs to (LoopSpec.id).
 * @param iterationRuns    ordered reconciler states, oldest → newest.
 * @param opts             optional fold options. `kind` (LoopSpec.kind, default
 *                         'code') makes an AGENTIC loop's finished worker fold to a
 *                         terminal DONE without a PR/validator (PRD §1/§9). Omitting
 *                         it preserves the exact code-loop fold (Slice-1 compatible).
 * @returns LoopLineageState
 */
export function foldLoopLineage(
  loopId: any,
  iterationRuns: any,
  opts?: { kind?: LoopKind },
): LoopLineageState {
  const id = String(loopId == null ? '' : loopId);
  const list = Array.isArray(iterationRuns) ? iterationRuns : [];
  const kind: LoopKind | undefined = opts && opts.kind ? opts.kind : undefined;

  const iterations: LoopIteration[] = [];
  let totalSpendUsd = 0;
  let totalTokens = 0;
  let lastProgressAt: number | null = null;

  let prior: LoopIteration | null = null;
  for (let i = 0; i < list.length; i += 1) {
    const iter = projectIteration(list[i], i, prior, kind);
    iterations.push(iter);
    totalSpendUsd += iter.spendUsd;
    totalTokens += iter.tokens;
    if (iter.madeProgress) lastProgressAt = iter.index;
    prior = iter;
  }

  const lastEvidence = iterations.length ? iterations[iterations.length - 1] : null;
  const latestRunOutcome = lastEvidence ? lastEvidence.stopState : null;

  return {
    loopId: id,
    iterations,
    iterationCount: iterations.length,
    totalSpendUsd,
    totalTokens,
    lastProgressAt,
    lastEvidence,
    latestRunOutcome,
  };
}

module.exports = {
  foldLoopLineage,
  iterationStopState,
  projectIteration,
};
