// loop-fixback — pure goal-composition + run-summary assembly for the ship loop.
//
// Two deterministic responsibilities, both pure (no I/O, no clock, no
// Date.now/Math.random — the loop-host injects any effects and hands the results
// in here):
//
//   composeShipGoal(...)      — given the rendered base goal for the NEXT iteration
//     plus the PRIOR iteration's folded evidence, APPEND fail-forward fixback
//     directives so the next worker attacks what actually failed:
//       · failing CI checks  → name the PR + tell it to run `gh pr checks` /
//         `gh run view --log-failed`, fix, and push (the reconciler already parked
//         the run at ready_to_review because pr.checkState!=='success').
//       · Clawpatch findings → inline the report when small, else the report path +
//         a blocking-findings summary; an UNREADABLE required report becomes an
//         explicit "resolve Clawpatch, do NOT merge past it" directive (fail-closed).
//     When the prior iteration surfaced neither, the base goal is returned
//     UNCHANGED (byte-identical), so non-ship loops and clean iterations are
//     unaffected.
//
//   buildRunSummaryRecord(...) — on convergence, assemble ONE small raw-tier dump
//     record (goal, iterations, PR number/sha, gates passed, key learnings) the
//     nightly knowledge indexer ingests as gated/raw content. Deterministic
//     assembly — NO model call. It NEVER carries a token (the ship loop references
//     its token by name only).

import type { LoopIteration } from './loop-lineage.cts';
import type { LoopInvocationResult } from './loop-host.cts';
import type { LoopSpec } from './loop-spec.cts';

/** A Clawpatch observation the loop-host injected (read from the run's worktree). */
export interface ClawpatchObservation {
  /** clawpatch was required for this run's risk tier. */
  required?: boolean;
  /** the report/artifact was readable (false + required ⇒ fail-closed directive). */
  readable?: boolean;
  /** 'pass' | 'fail' | 'blocked' | 'skipped' | string. */
  status?: string;
  /** blocking findings rollup, e.g. [{ severity:'high', count:2 }]. */
  blockingFindings?: Array<{ severity: string; count: number }>;
  /** the raw report text (inlined when small). */
  reportText?: string | null;
  /** the report path relative to the worktree (e.g. `.clawpatch/report.md`). */
  reportPath?: string | null;
  /** a one-line reason the report was unreadable, when readable === false. */
  reason?: string | null;
}

// Inline the Clawpatch report verbatim only when it is small; above this we hand
// the worker the PATH + a findings summary instead of drowning the goal prompt.
const MAX_INLINE_CLAWPATCH_CHARS = 1200;

function isNonEmptyString(v: any): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * A PR check state that represents a genuine FAILURE (not merely pending/success).
 * The reconciler routes any non-'success' state to GATE, but a fixback only makes
 * sense for a real failure — a still-'pending' run is just not done checking.
 */
export function isFailingCheckState(checkState: any): boolean {
  const s = String(checkState == null ? '' : checkState).trim().toLowerCase();
  return (
    s === 'failure' ||
    s === 'fail' ||
    s === 'failing' ||
    s === 'error' ||
    s === 'errored' ||
    s === 'timed_out' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'action_required'
  );
}

/** The PR reference for a directive: prefer number, fall back to url, else a hint. */
function prRef(iter: LoopIteration | null): string {
  if (iter && iter.prNumber != null) return `#${iter.prNumber}`;
  if (iter && isNonEmptyString(iter.prUrl)) return String(iter.prUrl);
  return 'the open PR';
}

/** Build the CI-failure fixback directive, or '' when the prior iteration was clean. */
export function ciFailureDirective(prior: LoopIteration | null): string {
  if (!prior || prior.prExists !== true) return '';
  if (!isFailingCheckState(prior.checkState)) return '';
  const ref = prRef(prior);
  return (
    `The previous iteration parked at ready_to_review because CI is FAILING on PR ${ref} ` +
    `(checkState=${prior.checkState}). Do NOT treat the goal as done. Identify the specific ` +
    `failing checks with \`gh pr checks ${prior.prNumber != null ? prior.prNumber : ref}\` and ` +
    `read their logs with \`gh run view --log-failed\`, fix the underlying failures on the branch, ` +
    `and push so the checks re-run. The loop only merges once every check is green.`
  );
}

/** Build the Clawpatch fixback directive from an observation, or '' when none. */
export function clawpatchDirective(observation: ClawpatchObservation | null | undefined): string {
  if (!observation || typeof observation !== 'object') return '';
  // Fail-closed: a required review whose report could not be read must NOT be
  // merged past — tell the worker to resolve the Clawpatch run before proceeding.
  if (observation.required === true && observation.readable === false) {
    const why = isNonEmptyString(observation.reason) ? ` (${String(observation.reason).trim()})` : '';
    return (
      `A Clawpatch review was required for this change but its report could not be read${why}. ` +
      `Do NOT proceed to merge past it: re-run \`ace validation clawpatch\`, read \`.clawpatch/report.md\`, ` +
      `and address every blocking finding before returning.`
    );
  }
  const status = String(observation.status == null ? '' : observation.status).trim().toLowerCase();
  const blocking = Array.isArray(observation.blockingFindings) ? observation.blockingFindings : [];
  const hasBlocking = blocking.length > 0;
  // Nothing actionable: a passing/skipped review with no blocking findings.
  if (!hasBlocking && status !== 'fail' && status !== 'blocked') return '';

  const summary = hasBlocking
    ? blocking.map((f) => `${f.count} ${f.severity}`).join(', ')
    : `status=${status || 'unknown'}`;
  const report = isNonEmptyString(observation.reportText) ? String(observation.reportText).trim() : '';
  if (report && report.length <= MAX_INLINE_CLAWPATCH_CHARS) {
    return (
      `Clawpatch review flagged blocking findings (${summary}). Address each one, then re-review. Report:\n` +
      report
    );
  }
  const pathHint = isNonEmptyString(observation.reportPath) ? String(observation.reportPath).trim() : '.clawpatch/report.md';
  return (
    `Clawpatch review flagged blocking findings (${summary}). Read the full report at \`${pathHint}\` ` +
    `(or re-run \`ace validation clawpatch\`), address every blocking finding, and re-review.`
  );
}

/**
 * Append CI-failure + Clawpatch fixback directives to the next iteration's base
 * goal. Returns the base goal UNCHANGED when the prior iteration surfaced neither.
 */
export function composeShipGoal(input: {
  baseGoal: string;
  priorIteration?: LoopIteration | null;
  clawpatch?: ClawpatchObservation | null;
}): string {
  const base = String(input && input.baseGoal != null ? input.baseGoal : '');
  const prior = input && input.priorIteration ? input.priorIteration : null;
  const directives = [ciFailureDirective(prior), clawpatchDirective(input && input.clawpatch)].filter(Boolean);
  if (directives.length === 0) return base;
  return [base, ...directives].join('\n\n');
}

/**
 * Assemble the raw-tier run-summary dump record for a converged ship loop. Pure +
 * deterministic — the loop-host hands in the settled invocation result. The shape
 * matches the knowledge indexer's dump-record ingest (title/summary/decisions/
 * completedItems/proposedNextActions/blockers + projectId), so the nightly indexer
 * folds it as gated/raw content. NEVER carries a token.
 */
export function buildRunSummaryRecord(input: {
  spec: LoopSpec;
  result: LoopInvocationResult;
  inputs?: Record<string, any>;
  projectId?: string | null;
  projectDir?: string | null;
  capturedAtRef?: string | null;
}): any {
  const spec = input && input.spec ? input.spec : ({} as LoopSpec);
  const result = input && input.result ? input.result : ({} as LoopInvocationResult);
  const inputs = input && input.inputs && typeof input.inputs === 'object' ? input.inputs : {};
  const lineage = result.lineage || null;
  const iterations = Array.isArray(result.iterations) ? result.iterations : [];
  const last = lineage && Array.isArray(lineage.iterations) && lineage.iterations.length
    ? lineage.iterations[lineage.iterations.length - 1]
    : null;

  const goal = isNonEmptyString((inputs as any).goal) ? String((inputs as any).goal) : String(spec.description || spec.id || 'loop-ship run');
  const merged = !!(last && last.merged);
  const prNumber = last && last.prNumber != null ? last.prNumber : null;
  const headSha = last && isNonEmptyString(last.headSha) ? String(last.headSha) : null;

  const completedItems: string[] = [];
  if (merged) completedItems.push(`Merged to main${prNumber != null ? ` via PR #${prNumber}` : ''}${headSha ? ` at ${headSha}` : ''}.`);
  completedItems.push(`Converged after ${iterations.length} iteration(s): ${result.finishReason}.`);

  const decisions: string[] = [];
  if (last && last.validatorOutcome === 'PASS') decisions.push('Computer-use validator PASSED at the merged head.');
  if (last && last.checkState) decisions.push(`Final CI checkState: ${last.checkState}.`);

  const proposedNextActions: string[] = [];
  const blockers: string[] = [];
  if (!merged) blockers.push(`Did not merge: terminal reason ${result.finishReason} — ${result.reasonDetail}`);

  return {
    schema: 'ace.loop.run_summary.v1',
    kind: 'loop_run_summary',
    identity: 'loop',
    projectId: isNonEmptyString(input.projectId) ? String(input.projectId) : '',
    projectDir: isNonEmptyString(input.projectDir) ? String(input.projectDir) : null,
    title: `loop-ship: ${goal}`.slice(0, 300),
    summary:
      `Ship loop ${result.loopId || spec.id || 'loop-ship'} ${merged ? 'MERGED' : 'ended'} ` +
      `(${result.finishReason}). ${goal}`.slice(0, 2000),
    decisions,
    completedItems,
    proposedNextActions,
    blockers,
    prNumber,
    tags: ['loop', 'ship', merged ? 'merged' : 'unmerged'],
    capturedAt: isNonEmptyString(input.capturedAtRef) ? String(input.capturedAtRef) : undefined,
    loopLineageId: result.loopLineageId || null,
  };
}

module.exports = {
  composeShipGoal,
  ciFailureDirective,
  clawpatchDirective,
  isFailingCheckState,
  buildRunSummaryRecord,
  MAX_INLINE_CLAWPATCH_CHARS,
};
