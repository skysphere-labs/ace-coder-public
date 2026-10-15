// loop-host — the recursion engine / multi-loop supervisor (PRD §3, §5, §7, §10-A2).
//
// A Loop is composition over the run-ledger spine (ace-loops.prd.md §0): the
// OUTER recursion across iterations is the new part, and it lives HERE, outside the
// body. Each iteration EXECUTES through the body as a canonical run — the Host
// never executes work itself; the ONLY way it causes work is the injected
// `submitIntent` (the canonical intake, in production `createKernel().submitIntent`;
// tests pass an in-memory fake). The Host then OBSERVES each iteration's terminal
// state via the injected `observeRun` (wraps the reconciler projection), folds the
// loop lineage (loop-lineage.foldLoopLineage), and asks the controller
// (loop-controller.classifyLoopTerminal) whether to fire iteration N+1.
//
// TWO PLANES (PRD §2 invariant 4): recursion/control is here; execution/visibility
// is the body. They are coupled ONLY at the canonical intake (submitIntent) + the
// observe seam (observeRun). The Host never re-implements "what to do next" for a
// run (that stays the spine's orchestration-policy) and never writes/gates the
// board — owner-gated merge is INHERITED from the spine (PRD §2 invariant 5): the
// Host just passes the intent through (carrying the loop's contract.merge.tokenRef
// when present) and the spine's fail-closed gate parks a converged code iteration
// at ready_to_review unless a token is supplied.
//
// MANY CONCURRENT LOOPS (Chief: "as many as we want", PRD §7/§R6): the Host tracks
// active invocations in a map keyed by an invocation id and enforces a GLOBAL
// concurrencyCap on simultaneous in-flight iterations ACROSS ALL loops, plus a
// master kill (killAll) and a per-invocation stop(invocationId) — both checked
// BEFORE any dispatch so a runaway never fires another iteration.
//
// INNER vs OUTER loop (PRD §6): the inner per-iteration step loop reuses
// harness.runToQuiescence's no-progress / max-step / error guard SEMANTICS (drive
// a single run forward until it reaches a state with no progress, an error, or a
// step cap). The OUTER recursion across iterations is the genuinely new layer.
//
// PURITY (PRD §5, §R2): no better-sqlite3, no Electron, no top-level Date.now /
// Math.random. Every effect — submitIntent, observeRun, the store, the clock —
// is INJECTED via the factory, exactly the spine's createKernel({ ledger, drivers })
// pattern. That keeps the module unit-testable with in-memory fakes and dodges the
// native-ABI mismatch noted in QA.

import type { LoopSpec, LoopContract, StopState } from './loop-spec.cts';
import type {
  LoopLineageState as ControllerLineageState,
  LoopIterationState as ControllerIterationState,
  LoopTerminalClass,
} from './loop-controller.cts';
import type { LoopIteration, LoopLineageState as FoldedLineageState } from './loop-lineage.cts';
import type { ClawpatchObservation } from './loop-fixback.cts';

// Sibling .cts requires — require the .cts SOURCE first (the build deletes stale
// .cjs before compiling, so a .cjs-first require is unresolvable at build time;
// esbuild INLINES the .cts and tsx resolves it for node --test). The .cjs is kept
// only as a fallback. Ref: esbuild run-ledger bundling.
let lineageModule: any;
try {
  lineageModule = require('./loop-lineage.cts');
} catch {
  lineageModule = require('./loop-lineage.cjs');
}
const { foldLoopLineage } = lineageModule;

let controllerModule: any;
try {
  controllerModule = require('./loop-controller.cts');
} catch {
  controllerModule = require('./loop-controller.cjs');
}
const { classifyLoopTerminalDetailed } = controllerModule;

let fixbackModule: any;
try {
  fixbackModule = require('./loop-fixback.cts');
} catch {
  fixbackModule = require('./loop-fixback.cjs');
}
const { composeShipGoal, buildRunSummaryRecord } = fixbackModule;

// ----------------------------------------------------------------------------
// Injected effect contracts
// ----------------------------------------------------------------------------

/**
 * The canonical intake — in production `createKernel().submitIntent`. The ONLY way
 * the Host causes work. Returns the runId the iteration executes as. May be async
 * (a kernel-backed intake can be sync; a service-backed one async) — the Host
 * awaits it either way.
 */
export type SubmitIntent = (intent: LoopIntent) => string | Promise<string>;

/**
 * Observe an iteration's run — wraps the run-ledger reconciler projection. Returns
 * the per-iteration reconciler state (the IterationRunState shape loop-lineage
 * folds) or null when the run is not yet observable. May be async. The Host calls
 * this read-only (PRD §2 invariant 2: loops never write the spine).
 */
export type ObserveRun = (runId: string) => IterationRunState | null | Promise<IterationRunState | null>;

/** One run-ledger reconciler state, as loop-lineage folds it (permissive). */
export interface IterationRunState {
  worker?: any;
  validator?: any;
  pr?: any;
  merge?: any;
  fixback?: any;
  telemetry?: any;
  currentHeadSha?: any;
  /** convergence signal the Host reads to set nextGoalNoGoal (see resolveNextGoalNoGoal). */
  nextGoalNoGoal?: boolean;
  [key: string]: any;
}

/** The minimal store surface the Host needs (loop-store.LoopStore is a superset). */
export interface LoopHostStore {
  get: (id: string) => LoopSpec | null;
}

/**
 * The canonical intake intent the Host fires per iteration. Carries the loop
 * tagging (PRD §2 invariant 3: every iteration is a canonical run tagged with its
 * loopId/loopLineageId), the per-iteration goal, the routed agent, and the loops
 * workspace scope. `merge` carries the loop's owner-gated token ref so the spine's
 * fail-closed gate can decide — the Host never merges.
 */
export interface LoopIntent {
  loopId: string;
  loopLineageId: string;
  /** 0-based ordinal within the lineage. */
  iteration: number;
  goal: string;
  agent: 'claude' | 'codex' | 'auto';
  kind: LoopSpec['kind'];
  skills: string[];
  /**
   * Execution scope. `workspace` is the EXECUTION-target workspace (PRD §9 Slice 4
   * control-vs-target): defaults to 'loops' but may be another workspace the loop
   * edits, while the loop's control/lineage stays in Loops via its loopId tag.
   * `controlWorkspace` is always 'loops' (where the loop surfaces).
   */
  scope: { workspace: string; controlWorkspace: 'loops'; workspaceId?: string; repo?: string; allow: string[] };
  /** owner-gated merge inheritance — passed THROUGH to the spine gate, never acted on here. */
  merge: { ownerGated: true; tokenRef?: string };
  /** the prior iteration's evidence, so goalTemplate can parameterize on it. */
  priorEvidence: LoopIteration | null;
}

export interface LoopHostDeps {
  submitIntent: SubmitIntent;
  observeRun: ObserveRun;
  store: LoopHostStore;
  /**
   * Optional controller override (defaults to loop-controller). Must expose
   * classifyLoopTerminalDetailed(lineageState, contract) → { verdict, reason }.
   */
  controller?: {
    classifyLoopTerminalDetailed: (
      lineageState: ControllerLineageState | any,
      contract: LoopContract | any,
    ) => { verdict: LoopTerminalClass; reason: string; ceiling?: string };
  };
  /** injected clock (no top-level Date.now). Used only for lineage ids / timestamps. */
  now?: () => number | string;
  /**
   * GLOBAL cap on simultaneous in-flight iterations across ALL loops (PRD §7/§R6).
   * Default 4. <=0 is treated as 1 (never deadlock to zero).
   */
  concurrencyCap?: number;
  /**
   * Inner per-iteration observe budget — max polls of observeRun before the Host
   * treats the iteration as quiescent at its last-observed state. Mirrors
   * harness.runToQuiescence's maxSteps guard (default 24).
   */
  maxObservePolls?: number;
  /**
   * Hard ceiling on outer iterations regardless of contract ceilings — a final
   * runaway guard so a misconfigured loop with no ceilings + an always-"continue"
   * controller still terminates. Default 100. The PRIMARY stop stays
   * converged/no-progress per the controller (PRD §3); this is only a backstop.
   */
  maxIterationsHardCap?: number;
  /**
   * OPTIONAL: read a run's Clawpatch review facts from its worktree (loops-service
   * resolves the worktree off the ledger). Called ONLY when the prior iteration's
   * validator requested changes / blocked, so its findings enrich the NEXT
   * iteration's fixback goal. Absent ⇒ no Clawpatch enrichment (the loop still
   * runs). Read-only; may be async; a throw is swallowed (best-effort enrichment).
   */
  observeClawpatch?: (runId: string) => ClawpatchObservation | null | Promise<ClawpatchObservation | null>;
  /**
   * OPTIONAL: persist a converged ship loop's raw-tier run-summary record to the
   * knowledge inbox (loops-service maps it to writeDumpRecord). FAIL-OPEN — a
   * throw here NEVER breaks loop termination. Absent ⇒ no write-back.
   */
  writeRunSummary?: (record: any) => void;
}

// ----------------------------------------------------------------------------
// Result shapes
// ----------------------------------------------------------------------------

/** Why the outer recursion stopped firing iterations. */
export type LoopFinishReason =
  | 'converged'
  | 'no-progress'
  | 'cap-hit'
  | 'blocked'
  | 'killed'
  | 'hard-cap'
  | 'spec-not-found'
  // Builtin system loops (PRD §10) finish in-process (no spine worker iteration).
  | 'system'
  | 'error';

/** One observed iteration in an invocation's history. */
export interface LoopInvocationIteration {
  index: number;
  runId: string;
  goal: string;
  /** the folded per-iteration projection observeRun produced (null if unobservable). */
  evidence: LoopIteration | null;
  /** the controller verdict AFTER this iteration was folded into the lineage. */
  classification: LoopTerminalClass;
  reason: string;
}

export interface LoopInvocationResult {
  invocationId: string;
  loopId: string;
  loopLineageId: string;
  finished: boolean;
  finishReason: LoopFinishReason;
  reasonDetail: string;
  iterations: LoopInvocationIteration[];
  /** the final folded lineage (loop-lineage shape) for the owner evidence bundle. */
  lineage: FoldedLineageState | null;
  /** the latest resolved StopState (or null when none terminal). */
  latestRunOutcome: StopState | null;
}

export interface LoopHost {
  invokeLoop: (loopId: string, inputs?: Record<string, any>) => Promise<LoopInvocationResult>;
  /** halt a single invocation before its next dispatch. Returns true if it was active. */
  stop: (invocationId: string) => boolean;
  /** master kill — halt ALL active invocations before their next dispatch. */
  killAll: () => void;
  /** active invocation ids (for the Loops tab aggregate gauges). */
  activeInvocations: () => string[];
  /** current count of in-flight iterations across all loops (for the concurrency gauge). */
  inFlightCount: () => number;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function asObject(value: any): any {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isNonEmptyString(v: any): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse a run-form `allow` input into a path-scope array. Accepts an array
 * verbatim, or a comma/whitespace-separated string (the CLI hands `--input
 * allow="a b,c"` as a string). Empty / absent ⇒ [] (the loop-host then keeps the
 * template's target.allow).
 */
function parseAllowInput(value: any): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Render a per-iteration goal from the loop's goalTemplate, parameterized by the
 * run inputs + the prior iteration's evidence (PRD §4 goalTemplate). Deterministic
 * {{key}} substitution over inputs, plus a couple of well-known evidence tokens.
 * Unknown tokens are left intact (visible to the worker rather than silently
 * dropped). No model call — v1 is deterministic template-fill (PRD §5/§9).
 */
function renderGoal(
  template: string,
  inputs: Record<string, any>,
  priorEvidence: LoopIteration | null,
  iterationIndex: number,
): string {
  const tokens: Record<string, any> = {
    ...asObject(inputs),
    iteration: iterationIndex,
    priorOutcome: priorEvidence ? priorEvidence.stopState || priorEvidence.workerOutcome || '' : '',
    priorHeadSha: priorEvidence && priorEvidence.headSha ? priorEvidence.headSha : '',
    priorValidator: priorEvidence ? priorEvidence.validatorOutcome || '' : '',
  };
  return String(template == null ? '' : template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => {
    const v = tokens[String(key)];
    return v == null ? whole : String(v);
  });
}

/**
 * Bridge ONE folded loop-lineage LoopIteration into the controller's
 * LoopIterationState vocabulary. The lineage carries reconciler tokens
 * (validatorOutcome 'PASS'|'REQUEST-CHANGES'|'BLOCK', a headSha, a StopState); the
 * controller wants verdict 'pass'|'request-changes'|'block', evidenceKeys, a
 * blocked flag, and nextGoalNoGoal. This is the observe→classify seam.
 *
 * evidenceKeys = stable signatures the iteration produced (headSha + runId +
 * stopState + a PR/merge marker), so the controller's no-progress detector fires
 * when an iteration re-produces only already-seen signatures.
 */
function toControllerIteration(
  iter: LoopIteration,
  nextGoalNoGoal: boolean,
  kind?: LoopSpec['kind'],
  requireComputerUseEvidence?: boolean,
): ControllerIterationState {
  let verdict: ControllerIterationState['verdict'] = null;
  switch (iter.validatorOutcome) {
    case 'PASS':
      verdict = 'pass';
      break;
    case 'REQUEST-CHANGES':
    case 'REQUEST_CHANGES':
      verdict = 'request-changes';
      break;
    case 'BLOCK':
      verdict = 'block';
      break;
    default:
      verdict = null;
  }

  const evidenceKeys: string[] = [];
  if (iter.headSha) evidenceKeys.push(`head:${iter.headSha}`);
  if (iter.merged) evidenceKeys.push(`merged:${iter.headSha || iter.runId || iter.index}`);
  if (iter.prExists) evidenceKeys.push(`pr:${iter.headSha || iter.runId || iter.index}`);
  if (iter.validatorDone) evidenceKeys.push(`val:${iter.validatorOutcome}:${iter.headSha || iter.index}`);
  if (iter.computerUseEvidence) evidenceKeys.push(`cu:${iter.headSha || iter.runId || iter.index}`);
  // A folded terminal with no head/PR (e.g. agentic DONE / CLEAN_NOOP) still needs
  // at least one signature on its FIRST appearance, else two clean-noop iterations
  // would look like progress→no-progress incorrectly. Tag the stopState only when
  // it carries no other signal so genuine re-runs of the same terminal collapse.
  if (evidenceKeys.length === 0 && iter.stopState) {
    evidenceKeys.push(`stop:${iter.stopState}`);
  }

  // A 'request-changes' verdict is the NORMAL fixback path that keeps the loop
  // going (loop-controller doctrine) — even though loop-lineage stamps it as the
  // NEEDS_OWNER_DECISION stopState. So we do NOT treat a request-changes-derived
  // NEEDS_OWNER_DECISION as a hard block: the loop should fire the next iteration.
  // Only a genuine worker/validator block or an unsafe-approval gate is a hard stop.
  const requestChangesOnly = verdict === 'request-changes';
  const blocked =
    iter.stopState === 'BLOCKED' ||
    iter.stopState === 'UNSAFE_REQUIRES_APPROVAL' ||
    (iter.stopState === 'NEEDS_OWNER_DECISION' && !requestChangesOnly) ||
    iter.workerOutcome === 'BLOCKED' ||
    iter.workerOutcome === 'BLOCKED_SCOPE' ||
    verdict === 'block';

  // The lineage stamps a request-changes iteration as NEEDS_OWNER_DECISION, but in
  // the loop that is the normal fixback CONTINUE path — not a hard stop. The
  // controller's classifier ALSO hard-blocks on a NEEDS_OWNER_DECISION stopState
  // (loop-controller.iterationIsBlocked), so we must NOT forward that stopState for
  // a request-changes-only iteration, or the loop would block on its first fixback.
  const controllerStopState = requestChangesOnly && iter.stopState === 'NEEDS_OWNER_DECISION'
    ? null
    : iter.stopState;

  // Evidence gate is kind-specific (PRD §1/§9):
  //  - CODE: a validator PASS IS the evidence; otherwise any produced signature.
  //  - AGENTIC: evidence is the worker's finished output — a finished worker (DONE)
  //    that produced at least one signature, AND (when the contract demands it) a
  //    real computer-use attestation. No validator/PR is involved.
  const hasEvidence =
    kind === 'agentic'
      ? iter.workerDone === true &&
        iter.workerOutcome === 'DONE' &&
        evidenceKeys.length > 0 &&
        (requireComputerUseEvidence ? iter.computerUseEvidence === true : true)
      : iter.validatorDone
        ? verdict === 'pass'
        : evidenceKeys.length > 0;

  return {
    runId: iter.runId,
    kind,
    workerDone: iter.workerDone === true,
    verdict,
    hasEvidence,
    evidenceKeys,
    nextGoalNoGoal,
    blocked,
    stopState: controllerStopState,
  };
}

/**
 * Build the controller LoopLineageState from a folded loop-lineage, mapping every
 * iteration through toControllerIteration. nextGoalNoGoal for the LATEST iteration
 * is resolved by the injected/derived convergence signal (resolveNextGoalNoGoal);
 * prior iterations carry false (they continued, by definition).
 */
function toControllerLineage(
  folded: FoldedLineageState,
  lineageId: string,
  latestNextGoalNoGoal: boolean,
  blockedFlag: boolean,
  kind?: LoopSpec['kind'],
  requireComputerUseEvidence?: boolean,
): ControllerLineageState {
  const iterations = folded.iterations.map((it, i) =>
    toControllerIteration(
      it,
      i === folded.iterations.length - 1 ? latestNextGoalNoGoal : false,
      kind,
      requireComputerUseEvidence,
    ),
  );
  return {
    loopLineageId: lineageId,
    iterations,
    spendUsd: folded.totalSpendUsd,
    blocked: blockedFlag,
  };
}

/**
 * The convergence signal the controller needs (nextGoalNoGoal). The body's
 * deriveNextGoal brain runs over the iteration's evidence bundle and returns
 * {no_goal} when there is nothing left to do. The Host computes the BOOLEAN and
 * passes it down (keeps the controller free of the next-goal import). v1 derives
 * it deterministically from the folded iteration:
 *  - CODE: a validator PASS that carries evidence and is not parked for review (no
 *    open PR awaiting owner merge) means "nothing left" — the loop converged. An
 *    open PR awaiting an owner-gated merge is READY_FOR_REVIEW (parks, owner-held)
 *    — NOT converged-with-no-goal, so the loop does not keep firing against an
 *    already-reviewable change.
 *  - AGENTIC (PRD §1/§9): evidence is the ship — a finished worker (DONE) means
 *    nothing left, regardless of validator/PR (there is none). The folded agentic
 *    iteration carries stopState DONE (loop-lineage agentic branch); a CLEAN_NOOP
 *    finished-but-empty iteration also has nothing left.
 */
function resolveNextGoalNoGoal(latest: LoopIteration | null, kind?: LoopSpec['kind']): boolean {
  if (!latest) return false;
  if (kind === 'agentic') {
    if (latest.stopState === 'DONE' || latest.stopState === 'CLEAN_NOOP') return true;
    return latest.workerDone === true && latest.workerOutcome === 'DONE';
  }
  if (latest.stopState === 'DONE' || latest.stopState === 'CLEAN_NOOP') return true;
  if (latest.validatorDone && latest.validatorOutcome === 'PASS' && !latest.prExists) return true;
  return false;
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

/**
 * Create the multi-loop supervisor. All effects injected (PRD §5). Concurrency cap
 * + master kill are enforced HERE, before any dispatch (PRD §7/§R6), so the Host is
 * the single safe choke point for "run as many as we want".
 */
export function createLoopHost(deps: LoopHostDeps): LoopHost {
  if (!deps || typeof deps.submitIntent !== 'function' || typeof deps.observeRun !== 'function') {
    throw new Error('loop-host: createLoopHost requires injected { submitIntent, observeRun }');
  }
  if (!deps.store || typeof deps.store.get !== 'function') {
    throw new Error('loop-host: createLoopHost requires an injected store with get(id)');
  }

  const submitIntent = deps.submitIntent;
  const observeRun = deps.observeRun;
  const store = deps.store;
  const classify =
    deps.controller && typeof deps.controller.classifyLoopTerminalDetailed === 'function'
      ? deps.controller.classifyLoopTerminalDetailed
      : classifyLoopTerminalDetailed;
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const rawCap = Number(deps.concurrencyCap);
  const concurrencyCap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : Number.isFinite(rawCap) ? 1 : 4;
  const maxObservePolls = Number.isFinite(Number(deps.maxObservePolls)) && Number(deps.maxObservePolls) > 0
    ? Math.floor(Number(deps.maxObservePolls))
    : 24;
  const maxIterationsHardCap = Number.isFinite(Number(deps.maxIterationsHardCap)) && Number(deps.maxIterationsHardCap) > 0
    ? Math.floor(Number(deps.maxIterationsHardCap))
    : 100;
  const observeClawpatch = typeof deps.observeClawpatch === 'function' ? deps.observeClawpatch : null;
  const writeRunSummary = typeof deps.writeRunSummary === 'function' ? deps.writeRunSummary : null;

  // ---- shared mutable supervisor state (keyed by invocationId; no cross-talk) ----
  interface ActiveInvocation {
    invocationId: string;
    loopId: string;
    killed: boolean;
    // true when this invocation was halted by killAll() (vs a targeted stop()).
    // killAll halts only the invocations active AT THE TIME it is called — it does
    // NOT set a host-global sticky flag, so a later invokeLoop starts fresh.
    killedByAll: boolean;
  }
  const active = new Map<string, ActiveInvocation>();
  let inFlight = 0; // in-flight iterations across ALL loops (the global semaphore count)
  let idCounter = 0;

  function nextInvocationId(loopId: string): string {
    idCounter += 1;
    return `loopinv-${loopId}-${idCounter}`;
  }

  // Concurrency gate: wait until an in-flight slot frees, OR the invocation is
  // halted (kill). Pure cooperative scheduling — yields to the microtask queue so
  // sibling concurrent invokeLoop calls release their slots. Returns true when a
  // slot was acquired, false when halted before acquiring.
  async function acquireSlot(inv: ActiveInvocation): Promise<boolean> {
    // Bounded spin on the microtask queue: every concurrent invocation that holds
    // a slot releases it after its dispatch, which lets a waiter through. The
    // bound is generous (no real wall-clock wait — this is cooperative, in-memory).
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      if (inv.killed) return false;
      if (inFlight < concurrencyCap) {
        inFlight += 1;
        return true;
      }
      // yield: let a sibling that holds a slot finish its dispatch + release.
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    return false;
  }

  function releaseSlot(): void {
    if (inFlight > 0) inFlight -= 1;
  }

  /**
   * Drive ONE iteration: fire it via submitIntent (acquiring a concurrency slot),
   * then OBSERVE it to quiescence reusing runToQuiescence semantics — poll
   * observeRun until the iteration reaches a terminal StopState OR stops making
   * progress (the folded iteration's StopState/headSha stops moving) OR the poll
   * budget is hit. Returns the runId + the final folded LoopIteration evidence for
   * THIS run (folded standalone for the inner observe; the outer lineage re-folds
   * the whole history). Holds the concurrency slot for the iteration's lifetime and
   * always releases it.
   */
  async function driveIteration(
    inv: ActiveInvocation,
    intent: LoopIntent,
  ): Promise<{ runId: string; evidence: LoopIteration | null }> {
    const gotSlot = await acquireSlot(inv);
    if (!gotSlot) return { runId: '', evidence: null };
    try {
      const runId = String(await submitIntent(intent));

      // Inner observe loop — runToQuiescence semantics one level applied to the
      // observe seam: poll until terminal / no-progress / budget. The Host never
      // STEPS the run (the spine's own harness does that in the body); it observes.
      let last: IterationRunState | null = null;
      let lastSignature: string | null = null;
      let stableObservations = 0;
      for (let poll = 0; poll < maxObservePolls; poll += 1) {
        if (inv.killed) break;
        // eslint-disable-next-line no-await-in-loop
        const observed = await observeRun(runId);
        if (observed != null) last = observed;

        // Fold THIS single run to read its terminal/progress signal (kind-aware so
        // an agentic worker-DONE reads as terminal and the observe loop quiesces).
        const single = foldLoopLineage(intent.loopId, last ? [last] : [], { kind: intent.kind }) as FoldedLineageState;
        const iter = single.iterations.length ? single.iterations[0] : null;

        if (iter && iter.stopState != null) break; // terminal — quiescent.

        // No-progress guard (harness parity): if the observed signature did not
        // move across polls, the run is parked/in-flight with nothing new to see;
        // stop polling and let the OUTER loop decide on the last-observed state.
        const sig = iter ? `${iter.stopState || ''}|${iter.headSha || ''}|${iter.validatorOutcome}|${iter.workerOutcome}` : '';
        if (sig === lastSignature) {
          stableObservations += 1;
          if (stableObservations >= 2) break;
        } else {
          stableObservations = 0;
          lastSignature = sig;
        }
      }

      const folded = foldLoopLineage(intent.loopId, last ? [last] : [], { kind: intent.kind }) as FoldedLineageState;
      const evidence = folded.iterations.length ? folded.iterations[0] : null;
      return { runId, evidence };
    } finally {
      releaseSlot();
    }
  }

  /**
   * Open a loop lineage and drive iterations until the controller says stop (or a
   * kill / hard-cap halts it). Each iteration fires via submitIntent, is observed,
   * folded into the running lineage, and classified. PRIMARY stop is
   * converged/no-progress from the controller (PRD §3); kill and the hard cap are
   * backstops; ceilings come from the loop's own contract (PRD §7) via the
   * controller. Owner-gated merge is inherited (the intent carries the tokenRef;
   * the spine gate decides — the Host never merges).
   */
  async function invokeLoop(loopId: string, inputs: Record<string, any> = {}): Promise<LoopInvocationResult> {
    const invocationId = nextInvocationId(loopId);
    const lineageId = `${loopId}-lineage-${String(now())}-${idCounter}`;
    const inv: ActiveInvocation = { invocationId, loopId, killed: false, killedByAll: false };
    active.set(invocationId, inv);

    const result: LoopInvocationResult = {
      invocationId,
      loopId,
      loopLineageId: lineageId,
      finished: false,
      finishReason: 'error',
      reasonDetail: '',
      iterations: [],
      lineage: null,
      latestRunOutcome: null,
    };

    try {
      const spec = store.get(loopId);
      if (!spec) {
        result.finished = true;
        result.finishReason = 'spec-not-found';
        result.reasonDetail = `no LoopSpec found for id '${loopId}'`;
        return result;
      }

      const contract: LoopContract = asObject(spec.contract) as LoopContract;
      const routing = asObject(spec.routing);
      const target = asObject(routing.target);

      // Run-form input overrides (PRD §4 inputs). A loop-ship style loop is pointed
      // at a project + scope AT RUN TIME via `--input workspace=<projectId>` and an
      // optional `--input allow="<path> …"`, without editing the saved template.
      // Inputs win over the template's routing.target; absent ⇒ the template value.
      const inputWorkspaceId = isNonEmptyString((inputs as any).workspaceId)
        ? String((inputs as any).workspaceId)
        : isNonEmptyString((inputs as any).workspace)
          ? String((inputs as any).workspace)
          : null;
      const inputAllow = parseAllowInput((inputs as any).allow);
      const scopeWorkspaceId = inputWorkspaceId || (isNonEmptyString((target as any).workspaceId) ? String((target as any).workspaceId) : undefined);
      const scopeAllow = inputAllow.length ? inputAllow : Array.isArray(target.allow) ? target.allow : [];

      for (let index = 0; index < maxIterationsHardCap; index += 1) {
        // Halt checks BEFORE any dispatch (PRD §7/§R6 — the master kill / per-inv
        // stop must prevent the NEXT iteration from firing).
        if (inv.killed) {
          result.finished = true;
          result.finishReason = 'killed';
          result.reasonDetail = inv.killedByAll ? 'killAll() halted the loop before the next iteration' : 'stop() halted the loop before the next iteration';
          break;
        }

        const priorRecord: LoopInvocationIteration | null =
          result.iterations.length ? result.iterations[result.iterations.length - 1] : null;
        const priorEvidence: LoopIteration | null = priorRecord ? priorRecord.evidence : null;
        const baseGoal = renderGoal(spec.goalTemplate, inputs, priorEvidence, index);
        // Fixback bridge: enrich iteration N+1's goal with what iteration N failed
        // on (failing CI checks / Clawpatch findings) so the loop converges instead
        // of re-running the same goal. Additive — a clean prior leaves baseGoal
        // byte-identical. Clawpatch facts are read only when the prior validator
        // requested changes / blocked (the natural fixback trigger), best-effort.
        let clawpatch: ClawpatchObservation | null = null;
        if (
          observeClawpatch &&
          priorRecord &&
          priorEvidence &&
          (priorEvidence.validatorOutcome === 'REQUEST-CHANGES' ||
            priorEvidence.validatorOutcome === 'REQUEST_CHANGES' ||
            priorEvidence.validatorOutcome === 'BLOCK')
        ) {
          try {
            // eslint-disable-next-line no-await-in-loop
            clawpatch = await observeClawpatch(priorRecord.runId);
          } catch {
            clawpatch = null;
          }
        }
        const goal = composeShipGoal({ baseGoal, priorIteration: priorEvidence, clawpatch });

        const intent: LoopIntent = {
          loopId,
          loopLineageId: lineageId,
          iteration: index,
          goal,
          agent: (routing.agent as LoopIntent['agent']) || 'auto',
          kind: spec.kind,
          skills: Array.isArray(routing.skills) ? routing.skills : [],
          scope: {
            // Execution target (PRD §9 Slice 4): the loop's chosen target workspace,
            // defaulting to 'loops'. Control/lineage stays in Loops (controlWorkspace).
            workspace: isNonEmptyString(target.workspace) ? String(target.workspace) : 'loops',
            controlWorkspace: 'loops',
            // EXECUTION project id (a real projects.id) the spine spawns a worker
            // worktree from — distinct from the `workspace` label above. Threaded to
            // the run intent's scope.workspaceId so the dispatch can actually attach
            // a worker (else parseSpec rejects the empty scope and nothing attaches).
            // A run-form `--input workspace=<id>` overrides the template's target.
            workspaceId: scopeWorkspaceId,
            repo: isNonEmptyString(target.repo) ? String(target.repo) : undefined,
            // A run-form `--input allow="<path> …"` narrows the template's scope.
            allow: scopeAllow,
          },
          merge: {
            ownerGated: true,
            tokenRef:
              contract.merge && isNonEmptyString((contract.merge as any).tokenRef)
                ? String((contract.merge as any).tokenRef)
                : undefined,
          },
          priorEvidence,
        };

        // Fire + observe this iteration (concurrency-gated).
        // eslint-disable-next-line no-await-in-loop
        const { runId, evidence } = await driveIteration(inv, intent);

        if (!runId) {
          // Slot was never acquired — only happens when a kill landed during the
          // wait. Treat as killed.
          result.finished = true;
          result.finishReason = 'killed';
          result.reasonDetail = 'halted while waiting for a concurrency slot';
          break;
        }

        // Re-fold the WHOLE lineage so the controller classifies on the full
        // history (its no-progress detector needs the prior iterations). The Host
        // accumulates folded LoopIteration projections; rebuildRawStates rehydrates
        // a minimal reconciler state per iteration so foldLoopLineage re-derives
        // the same projections deterministically.
        const folded = foldLoopLineage(loopId, rebuildRawStates(result.iterations, evidence), {
          kind: spec.kind,
        }) as FoldedLineageState;
        result.lineage = folded;
        result.latestRunOutcome = folded.latestRunOutcome;

        const latest = folded.iterations.length ? folded.iterations[folded.iterations.length - 1] : null;
        const nextGoalNoGoal = resolveNextGoalNoGoal(latest, spec.kind);
        // The controller's `blocked` lineage flag is for genuine aggregate guards;
        // a master kill / per-invocation stop is NOT a 'blocked' terminal, it is a
        // 'killed' one — so we do NOT fold the kill flag into the controller block.
        const requireCu = !!(contract && contract.verify && (contract.verify as any).requireComputerUseEvidence);
        const ctrlLineage = toControllerLineage(folded, lineageId, nextGoalNoGoal, false, spec.kind, requireCu);
        const detail = classify(ctrlLineage, contract);

        result.iterations.push({
          index,
          runId,
          goal,
          evidence,
          classification: detail.verdict,
          reason: detail.reason,
        });

        // A kill landed during this iteration's dispatch/observe ⇒ finalize as
        // 'killed' (the iteration's own evidence is preserved above, but the loop
        // does not fire another and the terminal reason is the kill, not the
        // iteration's natural classification).
        if (inv.killed) {
          result.finished = true;
          result.finishReason = 'killed';
          result.reasonDetail = inv.killedByAll
            ? 'killAll() halted the loop'
            : 'stop() halted the loop';
          break;
        }

        if (detail.verdict !== 'continue') {
          result.finished = true;
          result.finishReason = detail.verdict as LoopFinishReason;
          result.reasonDetail = detail.reason;
          break;
        }

        // continue — loop to fire iteration N+1 (after the halt checks at the top).
        if (index === maxIterationsHardCap - 1) {
          result.finished = true;
          result.finishReason = 'hard-cap';
          result.reasonDetail = `hard iteration cap (${maxIterationsHardCap}) reached without convergence`;
        }
      }

      // Wiki write-back (gated, proposals-only): on a CONVERGED ship loop, hand a
      // deterministic raw-tier run-summary to the injected writer. FAIL-OPEN — a
      // write failure logs (in the injected writer) and never changes termination.
      if (result.finishReason === 'converged' && writeRunSummary) {
        try {
          const record = buildRunSummaryRecord({
            spec,
            result,
            inputs,
            projectId: isNonEmptyString((target as any).workspaceId) ? String((target as any).workspaceId) : null,
            projectDir: isNonEmptyString(target.repo) ? String(target.repo) : null,
            capturedAtRef: String(now()),
          });
          writeRunSummary(record);
        } catch {
          /* fail-open: a run-summary write never breaks loop termination. */
        }
      }

      return result;
    } catch (err: any) {
      result.finished = true;
      result.finishReason = 'error';
      result.reasonDetail = err && err.message ? String(err.message) : String(err);
      return result;
    } finally {
      active.delete(invocationId);
    }
  }

  function stop(invocationId: string): boolean {
    const inv = active.get(invocationId);
    if (!inv) return false;
    inv.killed = true;
    return true;
  }

  function killAll(): void {
    // Halt only the invocations active right now — no host-global sticky flag, so
    // a subsequent invokeLoop is unaffected (the bug the built-Electron test caught).
    for (const inv of active.values()) {
      inv.killed = true;
      inv.killedByAll = true;
    }
  }

  function activeInvocations(): string[] {
    return Array.from(active.keys());
  }

  function inFlightCount(): number {
    return inFlight;
  }

  return { invokeLoop, stop, killAll, activeInvocations, inFlightCount };
}

/**
 * Rebuild the ordered raw iteration states the lineage folds from the invocation's
 * accumulated folded iterations + the newest evidence. The Host accumulates folded
 * LoopIteration projections (one per observed iteration); foldLoopLineage expects
 * raw reconciler states, but a folded LoopIteration is already the projection of
 * one run, so we hand the projections back as states — projectIteration over a
 * shape that already carries worker/validator rollups would be lossy, so instead
 * we reconstruct a minimal reconciler-state per prior iteration from its folded
 * projection. Kept deterministic + pure.
 */
function rebuildRawStates(
  priorIterations: LoopInvocationIteration[],
  newest: LoopIteration | null,
): IterationRunState[] {
  const states: IterationRunState[] = [];
  for (const it of priorIterations) {
    if (it.evidence) states.push(iterationToRawState(it.evidence));
  }
  if (newest) states.push(iterationToRawState(newest));
  return states;
}

/**
 * Reconstruct a minimal run-ledger reconciler state from a folded LoopIteration so
 * the lineage fold re-derives the same projection deterministically. Only the
 * fields loop-lineage.projectIteration reads are reconstructed.
 */
function iterationToRawState(iter: LoopIteration): IterationRunState {
  const workerOutcomeRaw =
    iter.workerOutcome === 'NONE' ? undefined : iter.workerOutcome;
  const validatorOutcomeRaw =
    iter.validatorOutcome === 'NONE' ? undefined : iter.validatorOutcome;
  return {
    runId: iter.runId,
    worker: { done: iter.workerDone, outcome: workerOutcomeRaw },
    validator: {
      done: iter.validatorDone,
      outcome: validatorOutcomeRaw,
      computerUseEvidence: iter.computerUseEvidence,
    },
    pr: {
      exists: iter.prExists,
      headSha: iter.headSha,
      number: iter.prNumber != null ? iter.prNumber : undefined,
      url: iter.prUrl != null ? iter.prUrl : undefined,
      checkState: iter.checkState != null ? iter.checkState : undefined,
    },
    merge: { merged: iter.merged, headSha: iter.headSha },
    fixback: { attempts: iter.fixbackAttempts },
    telemetry: { totals: { tokens: iter.tokens, spendUsd: iter.spendUsd } },
    currentHeadSha: iter.headSha,
  };
}

module.exports = {
  createLoopHost,
};
