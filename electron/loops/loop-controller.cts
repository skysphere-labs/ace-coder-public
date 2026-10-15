// loop-controller — the Loop Host's "should I fire another iteration?" brain.
//
// A Loop is composition over the run-ledger spine (ace-loops.prd.md §0): the
// OUTER recursion across iterations lives in the Loop Host, while each iteration
// EXECUTES through the body as a canonical run. After the Host observes an
// iteration's terminal evidence (the "reingest", PRD §3 lifecycle), it asks this
// module exactly one question: classifyLoopTerminal(lineageState, contract) →
// one of 'continue' | 'converged' | 'no-progress' | 'cap-hit' | 'blocked'.
//
// PRD §7 / §10-A3 decision contract:
//  - PRIMARY stop is converged (validator pass + evidence + deriveNextGoal says
//    {no_goal}) OR no-progress (an iteration appended ZERO new evidence vs the
//    prior). These mirror harness.runToQuiescence's no-progress/quiescence guard
//    one level UP: there it's "a step appended no event"; here it's "an iteration
//    appended no new evidence".
//  - Ceilings (maxIterations / maxSpendUsd / maxRuntimeMs / expiryIso) are
//    OPTIONAL owner guardrails, default UNSET. 'cap-hit' fires ONLY when a ceiling
//    is SET and exceeded (Chief dislikes mandatory caps — an unset ceiling never
//    stops a loop).
//  - 'blocked' is a HARD stop the loop cannot self-resolve (a blocked iteration,
//    an unsafe-requires-approval gate, or an explicit lineage block).
//
// PURITY (PRD §5, §R2): no better-sqlite3, no Electron, no top-level Date.now /
// Math.random. The lineage clock/elapsed is computed by the caller (loop-lineage)
// and handed in on the lineage state — this module is a deterministic function of
// (lineageState, contract). Types import from ./loop-spec.cts.

import type { LoopContract, LoopCeilings, StopState, LoopKind } from './loop-spec.cts';

/**
 * The verdict classifyLoopTerminal returns. 'continue' = fire iteration N+1; the
 * other four are terminal loop states the Host finalizes on.
 * @typedef {('continue'|'converged'|'no-progress'|'cap-hit'|'blocked')} LoopTerminalClass
 */
export type LoopTerminalClass = 'continue' | 'converged' | 'no-progress' | 'cap-hit' | 'blocked';

/**
 * One iteration's folded terminal facts, as the loop-lineage module derives them
 * from that iteration's canonical run on the ledger. Intentionally minimal — the
 * controller only needs the convergence/progress signals, not the full run state.
 * @typedef {Object} LoopIterationState
 */
export interface LoopIterationState {
  /** the canonical runId this iteration executed as (for traceability). */
  runId?: string;
  /**
   * the loop's kind (PRD §1/§9). A CODE iteration converges on a validator 'pass';
   * an AGENTIC iteration converges on a finished worker carrying evidence — no
   * validator-pass / PR / merge (evidence is the ship). Defaults to code semantics
   * when absent, so every Slice-1 fixture classifies identically.
   */
  kind?: LoopKind;
  /** the worker reached a terminal DONE this iteration (the agentic ship signal). */
  workerDone?: boolean;
  /**
   * validator verdict folded for this iteration. 'pass' is required (alongside
   * evidence + a no_goal next-goal) for a 'converged' classification on a CODE
   * loop. AGENTIC loops do not run a validator, so verdict is typically null.
   */
  verdict?: 'pass' | 'request-changes' | 'block' | null;
  /** did the validator pass actually carry the required evidence bundle. */
  hasEvidence?: boolean;
  /**
   * stable signatures of the NEW evidence this iteration produced (e.g. evidence
   * artifact ids / content hashes / headSha). no-progress is detected by an
   * iteration adding NO signature absent from the union of all prior iterations.
   */
  evidenceKeys?: string[];
  /**
   * deriveNextGoal's verdict for this iteration: true when it returned {no_goal}
   * (no obvious follow-up — the convergence signal). The Host computes this by
   * running deriveNextGoal over the iteration's evidence bundle and passing the
   * boolean down (keeps this module free of the next-goal import + its deps).
   */
  nextGoalNoGoal?: boolean;
  /**
   * this iteration itself reached a hard block the loop cannot self-resolve
   * (e.g. worker BLOCKED, validator 'block', or an unsafe-requires-approval gate).
   */
  blocked?: boolean;
  /** optional terminal StopState the lineage stamped (e.g. UNSAFE_REQUIRES_APPROVAL). */
  stopState?: StopState | null;
}

/**
 * The whole loop lineage's folded state — what loop-lineage.cts produces by
 * folding every iteration's canonical run. The controller reads ONLY aggregate
 * signals from here (no ledger access of its own — that's injected upstream).
 * @typedef {Object} LoopLineageState
 */
export interface LoopLineageState {
  /** the lineage id tying these iterations together (for traceability). */
  loopLineageId?: string;
  /** ordered iterations, oldest → newest. iterations[last] is the most recent. */
  iterations: LoopIterationState[];
  /** cumulative USD spend across the lineage (model tokens etc.); for maxSpendUsd. */
  spendUsd?: number;
  /** wall-clock ms elapsed since the lineage started; for maxRuntimeMs. caller-computed. */
  elapsedMs?: number;
  /** an ISO timestamp for "now", caller-supplied; compared to ceilings.expiryIso. */
  nowIso?: string;
  /**
   * a hard lineage-level block flag the Host can raise out-of-band (e.g. master
   * kill, an aggregate guard). Trumps everything.
   */
  blocked?: boolean;
}

function asObject(value: any): any {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function iterationsOf(lineageState: any): LoopIterationState[] {
  const list = lineageState && Array.isArray(lineageState.iterations) ? lineageState.iterations : [];
  return list.filter((it: any) => it && typeof it === 'object');
}

/** Stable, de-duplicated evidence signatures an iteration produced. */
function evidenceKeysOf(iteration: any): string[] {
  const keys = iteration && Array.isArray(iteration.evidenceKeys) ? iteration.evidenceKeys : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (k == null) continue;
    const s = String(k);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * An iteration is a HARD block the loop cannot self-resolve when it is flagged
 * blocked, the validator returned 'block', or it landed on an owner-decision /
 * unsafe stop state. (A 'request-changes' verdict is NOT a block — that's the
 * normal fixback path that keeps the loop going.)
 */
function iterationIsBlocked(iteration: any): boolean {
  if (!iteration || typeof iteration !== 'object') return false;
  if (iteration.blocked === true) return true;
  if (iteration.verdict === 'block') return true;
  const stop = iteration.stopState;
  return stop === 'BLOCKED' || stop === 'NEEDS_OWNER_DECISION' || stop === 'UNSAFE_REQUIRES_APPROVAL';
}

/**
 * Converged when the LATEST iteration cleanly finished with nothing left to do.
 * The ship signal is kind-specific (PRD §1/§9):
 *  - CODE    : validator 'pass' + evidence + deriveNextGoal {no_goal} (PRD §3 —
 *              "validator pass + evidence + deriveNextGoal {no_goal}").
 *  - AGENTIC : a finished worker (workerDone) + evidence + deriveNextGoal {no_goal}.
 *              Agentic loops never run a validator / open a PR / merge — evidence
 *              is the ship, so a validator-pass is NOT required (and never arrives).
 * Evidence + the {no_goal} signal are required for BOTH kinds; only the
 * worker-vs-validator gate differs. Absent `kind`, code semantics apply.
 */
function iterationIsConverged(iteration: any): boolean {
  if (!iteration || typeof iteration !== 'object') return false;
  if (iteration.hasEvidence !== true || iteration.nextGoalNoGoal !== true) return false;
  if (iteration.kind === 'agentic') return iteration.workerDone === true;
  return iteration.verdict === 'pass';
}

/**
 * No-progress: the latest iteration appended ZERO new evidence signatures versus
 * the UNION of every prior iteration's signatures. Mirrors the spine harness's
 * "a step that appended no event did not advance the run" guard, one level up.
 * Requires ≥2 iterations (the first iteration always brings net-new evidence, so
 * it can never be no-progress by definition).
 */
export function hasNoProgress(iterations: LoopIterationState[]): boolean {
  if (!Array.isArray(iterations) || iterations.length < 2) return false;
  const latest = iterations[iterations.length - 1];
  const latestKeys = evidenceKeysOf(latest);

  const priorKeys = new Set<string>();
  for (let i = 0; i < iterations.length - 1; i += 1) {
    for (const k of evidenceKeysOf(iterations[i])) priorKeys.add(k);
  }

  // Any signature on the latest that no prior iteration had ⇒ genuine progress.
  for (const k of latestKeys) {
    if (!priorKeys.has(k)) return false;
  }
  // Latest contributed no signature absent from the prior union ⇒ no progress
  // (covers both "latest produced zero evidence" and "latest re-produced only
  // already-seen evidence").
  return true;
}

/**
 * Which SET ceiling (if any) the lineage has exceeded. Unset ceilings are
 * ignored (PRD §7: default UNSET, no mandatory caps). Returns the offending
 * ceiling name or null. Iteration count is measured by completed iterations, so
 * maxIterations is "have we already run at least that many" — at the cap, stop.
 */
function exceededCeiling(lineageState: any, ceilings: LoopCeilings | any): string | null {
  const c = asObject(ceilings);
  const iterations = iterationsOf(lineageState);

  if (Number.isFinite(c.maxIterations) && Number(c.maxIterations) > 0) {
    if (iterations.length >= Number(c.maxIterations)) return 'maxIterations';
  }
  if (Number.isFinite(c.maxSpendUsd) && Number(c.maxSpendUsd) > 0) {
    const spend = Number(lineageState && lineageState.spendUsd) || 0;
    if (spend >= Number(c.maxSpendUsd)) return 'maxSpendUsd';
  }
  if (Number.isFinite(c.maxRuntimeMs) && Number(c.maxRuntimeMs) > 0) {
    const elapsed = Number(lineageState && lineageState.elapsedMs) || 0;
    if (elapsed >= Number(c.maxRuntimeMs)) return 'maxRuntimeMs';
  }
  if (typeof c.expiryIso === 'string' && c.expiryIso.trim()) {
    const nowIso = lineageState && typeof lineageState.nowIso === 'string' ? lineageState.nowIso : null;
    if (nowIso) {
      const now = Date.parse(nowIso);
      const expiry = Date.parse(c.expiryIso);
      if (Number.isFinite(now) && Number.isFinite(expiry) && now >= expiry) return 'expiryIso';
    }
  }
  return null;
}

/**
 * The detailed classification, exposing the reason + which ceiling tripped so the
 * Host can finalize an evidence bundle with the exact cause. classifyLoopTerminal
 * is the thin verdict-only wrapper most callers want.
 * @typedef {Object} ClassifyResult
 */
export interface ClassifyResult {
  verdict: LoopTerminalClass;
  reason: string;
  /** populated only when verdict === 'cap-hit'. */
  ceiling?: string;
}

/**
 * Detailed classification (verdict + reason). Precedence (PRD §10-A3):
 *   1. blocked   — a hard stop the loop cannot self-resolve trumps everything.
 *   2. cap-hit   — a SET ceiling exceeded (owner guardrail) before more spend.
 *   3. converged — primary success stop.
 *   4. no-progress — primary stall stop.
 *   5. continue  — fire the next iteration.
 *
 * Edge: an empty lineage (no iterations) cannot be terminal on its own merits, so
 * it is 'continue' unless a SET ceiling already excludes it (e.g. expiry passed)
 * or a lineage-level block is raised.
 */
export function classifyLoopTerminalDetailed(
  lineageState: LoopLineageState | any,
  contract: LoopContract | any,
): ClassifyResult {
  const ls = asObject(lineageState);
  const iterations = iterationsOf(ls);
  const ceilings = asObject(contract).ceilings;

  // 1. Hard block — lineage-level flag or the latest iteration is blocked.
  if (ls.blocked === true) {
    return { verdict: 'blocked', reason: 'lineage blocked (master kill / aggregate guard)' };
  }
  const latest = iterations.length ? iterations[iterations.length - 1] : null;
  if (latest && iterationIsBlocked(latest)) {
    const stop = latest.stopState ? ` (${latest.stopState})` : '';
    return { verdict: 'blocked', reason: `latest iteration blocked${stop}` };
  }

  // 2. A SET ceiling exceeded — stop before firing another (costly) iteration.
  const ceiling = exceededCeiling(ls, ceilings);
  if (ceiling) {
    return { verdict: 'cap-hit', reason: `ceiling exceeded: ${ceiling}`, ceiling };
  }

  // No iterations yet and nothing above tripped ⇒ go run the first one.
  if (!latest) {
    return { verdict: 'continue', reason: 'no iterations yet — fire the first' };
  }

  // 3. Converged — the latest iteration cleanly finished with no follow-up.
  if (iterationIsConverged(latest)) {
    return { verdict: 'converged', reason: 'validator pass + evidence + next-goal {no_goal}' };
  }

  // 4. No-progress — the latest iteration added no new evidence vs the prior union.
  if (hasNoProgress(iterations)) {
    return { verdict: 'no-progress', reason: 'latest iteration appended no new evidence vs prior iterations' };
  }

  // 5. Otherwise keep looping.
  return { verdict: 'continue', reason: 'iteration made progress and is not yet converged' };
}

/**
 * classifyLoopTerminal(lineageState, contract) → 'continue' | 'converged' |
 * 'no-progress' | 'cap-hit' | 'blocked'. The verdict-only entry point per PRD
 * §10-A3; see classifyLoopTerminalDetailed for the reason + tripped ceiling.
 */
export function classifyLoopTerminal(
  lineageState: LoopLineageState | any,
  contract: LoopContract | any,
): LoopTerminalClass {
  return classifyLoopTerminalDetailed(lineageState, contract).verdict;
}

module.exports = {
  classifyLoopTerminal,
  classifyLoopTerminalDetailed,
  hasNoProgress,
};
