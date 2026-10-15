// loops-service — wire the Loop subsystem to the LIVE run-ledger spine (PRD §5,
// §3 two-plane architecture). This is the thin GLUE layer that the IPC handlers
// (electron/main.cts ace:loops-*) and the `ace loops *` surface call.
//
// It is the ONLY loops module that touches the live kernel/harness + node:fs; the
// pure modules (loop-spec / loop-store / loop-controller / loop-lineage /
// loop-host) stay effect-injected and native-ABI-free. This module:
//
//   1. builds a real createLoopStore over <userData>/loops/catalog.json (fs effects
//      injected here, node:fs is the only side-channel),
//   2. constructs createLoopHost binding submitIntent + observeRun to the LIVE
//      ledger per the recon seams:
//        · submitIntent(loopIntent) → harness.submit(mapLoopIntentToRunIntent) then
//          driveRun(runId) so a loop iteration advances IDENTICALLY to a CLI
//          `run submit` (worker → validator → PARK at ready_to_review),
//        · observeRun(runId) → kernel.reconcile(runId).state, the reconciler's
//          foldEventsToState shape the loop-host/loop-lineage fold,
//   3. exposes the service methods the IPC layer delegates to.
//
// HOT PATH FROZEN (PRD §2 invariant 1): this module CALLS the run-ledger public
// API (harness.submit, kernel.reconcile, ledger.readAll) and never edits it. It
// never re-implements "what to do next" for a run (orchestration-policy owns that)
// and never writes/gates the board (PRD §2 invariant 2).
//
// OWNER-HELD SHIP (PRD §2 invariant 5 / §7): merge stays owner-gated — the service
// passes the loop's contract.merge.tokenRef THROUGH the intent so the spine's
// existing fail-closed gate decides. No token ⇒ no merge ⇒ a converged code
// iteration parks at ready_to_review. The service never merges.
//
// SPINE-DISABLED GUARD: the master kill is ACE_RUN_LEDGER=0, which leaves the
// live runLedgerHarness null. Every run-touching service method (runLoop /
// loopStatus) then throws 'run-ledger spine disabled', mirroring methods.runSubmit.
// The definition-only methods (list/get/lockOn/save) still work — the catalog is a
// plain JSON file independent of the ledger.

import type { LoopSpec, LoopSpecDraft, LockOnResult } from './loop-spec.cts';
import type { LoopInvocationResult } from './loop-host.cts';

// Sibling .cts requires — require the .cts SOURCE first (the build deletes stale
// .cjs before compiling; the .cjs is the fallback). Ref: esbuild run-ledger
// bundling — require .cts-first, path-resolved relative siblings.
function requireSibling(name: string): any {
  // Keep this opaque to esbuild. If esbuild sees `require('./' + name + '.cjs')`,
  // it treats generated sibling .cjs files as build inputs and then refuses to
  // overwrite loops-service.cjs during compile-electron.
  const runtimeRequire = module.require.bind(module);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return runtimeRequire('./' + name + '.cts');
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return runtimeRequire('./' + name + '.cjs');
  }
}

const { lockOnLoopSpec, validateLoopSpec } = requireSibling('loop-spec') as typeof import('./loop-spec.cts');
const { createLoopStore } = requireSibling('loop-store') as typeof import('./loop-store.cts');
const { createLoopHost } = requireSibling('loop-host') as typeof import('./loop-host.cts');
const { foldLoopLineage } = requireSibling('loop-lineage') as typeof import('./loop-lineage.cts');
const { compileFromNL, selectLoopForIntent } = requireSibling('loop-forge') as typeof import('./loop-forge.cts');
const { createLoopTriggerScheduler } = requireSibling('loop-triggers') as typeof import('./loop-triggers.cts');
const {
  WORKSPACE_CLEANUP_LOOP_ID,
  WORKSPACE_CLEANUP_LOOP_SPEC,
  runWorkspaceCleanupLoop,
  readWorkspaceCleanupLineage,
} = requireSibling('workspace-cleanup-loop') as typeof import('./workspace-cleanup-loop.cts');
const { ALL_LOOP_TEMPLATES } = requireSibling('loop-templates') as typeof import('./loop-templates.cts');

const nodePath = require('path');

// ----------------------------------------------------------------------------
// Injected live dependencies (PRD §5 — effects injected, the spine's pattern).
// ----------------------------------------------------------------------------

/**
 * The live run-ledger harness as composed in ace-control (createRunLedgerHarness)
 * — { kernel, ledger, submit, ... }. We only use the public surface the recon
 * seams call: .submit(intent) → runId, .kernel.reconcile(runId).state, and
 * .ledger.readAll() for loop lineage. May be null when the spine is disabled
 * (ACE_RUN_LEDGER=0) — every run-touching method then fail-closed throws.
 */
export interface LoopsServiceHarness {
  submit: (intent: any) => string | null | undefined;
  kernel: {
    reconcile: (runId: string, deps?: any) => { state?: any; [k: string]: any };
    [k: string]: any;
  };
  ledger: { readAll: () => any[]; [k: string]: any };
  [k: string]: any;
}

/** Minimal fs surface the catalog store needs — node:fs-backed in production. */
export interface LoopsServiceFs {
  /** read a file's utf8 contents, or null when absent. */
  readFile: (path: string) => string | null | undefined;
  /** write (overwrite) a file; the impl ensures the parent dir exists. */
  writeFile: (path: string, contents: string) => void;
}

export interface LoopsServiceDeps {
  /**
   * The LIVE run-ledger harness (ace-control's runLedgerHarness). null when
   * ACE_RUN_LEDGER=0 — run-touching methods then throw 'run-ledger spine
   * disabled' (definition methods still work off the plain JSON catalog).
   */
  harness: LoopsServiceHarness | null;
  /**
   * The SAME driveRun(runId) ace-control uses for `run submit`, so a loop
   * iteration advances identically (worker → validator → park). Reused so loops
   * never get their own dispatch path. A no-op is tolerated (the service still
   * submits; the spine's boot-replay / periodic reconcile would pick it up).
   */
  driveRun: (runId: string) => void;
  /** injected fs effects for the definition catalog. node:fs in production. */
  fs: LoopsServiceFs;
  /** absolute path to the loops definition catalog JSON (under userData). */
  catalogPath: string;
  /** injected clock (no top-level Date.now). Used for lock-on meta stamping. */
  now?: () => number | string;
  /**
   * GLOBAL cap on simultaneous in-flight loop iterations across ALL loops
   * (PRD §7/§R6). Forwarded to the host. Default 4.
   */
  concurrencyCap?: number;
  /**
   * Injected timers for the trigger scheduler (PRD §9 Slice 3). Default = the
   * ambient setTimeout/clearTimeout. Tests pass fakes; the scheduler never arms
   * until startTriggers() is called, so this stays inert by default.
   */
  timers?: {
    setTimeout?: (fn: () => void, ms: number) => any;
    clearTimeout?: (handle: any) => void;
  };
  /**
   * Builtin system LoopSpecs (PRD §10) to seed into the catalog at construction.
   * Each is validated against validateLoopSpec; an invalid one is skipped + logged
   * (the catalog is fail-closed). Seeding is idempotent — a builtin already present
   * (e.g. an operator edit) is never clobbered. Absent ⇒ no seeding.
   */
  builtins?: LoopSpec[];
  /**
   * For kind==='system' loops: the in-process runner a "Run now" invokes INSTEAD of
   * the spine. Keyed by spec.systemRunRef (falling back to spec.id). Returns the
   * runner's result (carried back under LoopsRunResult.systemResult). A system loop
   * with no matching runner returns a finished/no-op result.
   */
  systemRunners?: Record<string, (inputs: any) => Promise<any> | any>;
  /**
   * For kind==='system' loops: read the matching in-process scheduler state for the
   * loop's status panel (system loops have no ledger runs to fold). Best-effort.
   */
  systemStatus?: (loop: LoopSpec) => any;
  workspaceCleanup?: import('./workspace-cleanup-loop.cts').WorkspaceCleanupDeps;
}

// ----------------------------------------------------------------------------
// Service result shapes (renderer-facing, mirrored in ace-api.ts).
// ----------------------------------------------------------------------------

export interface LoopsLockOnResult {
  /** the runnable spec when the draft locked. */
  spec?: LoopSpec;
  /** the joined fail-closed validation errors when it did not. */
  errors?: string[];
}

export interface LoopsCompileResult {
  /** the proposed draft compiled from NL — NOT locked (operator reviews then locks). */
  draft: LoopSpecDraft;
  /** human-readable notes on what the compiler inferred. */
  notes: string[];
}

export interface LoopsRunResult {
  /** the invocation id the host minted (for stop()). */
  invocationId: string;
  loopId: string;
  loopLineageId: string;
  finished: boolean;
  finishReason: LoopInvocationResult['finishReason'];
  reasonDetail: string;
  /** the latest resolved StopState, or null. */
  latestRunOutcome: LoopInvocationResult['latestRunOutcome'];
  /** per-iteration runIds + classifications for the Live Run pane. */
  iterations: Array<{
    index: number;
    runId: string;
    goal: string;
    classification: string;
    reason: string;
  }>;
  /**
   * For kind==='system' loops only: the in-process runner's raw result (e.g. the
   * db-monitor scan/purge payload). Absent for agent (code/agentic) loops, which
   * surface their work as ledger-tagged iterations instead.
   */
  systemResult?: any;
}

export interface LoopsStopResult {
  stopped: boolean;
}

export interface LoopsStatusResult {
  /** active host invocation ids. */
  active: string[];
  /** in-flight iteration count across all loops (concurrency gauge). */
  inFlight: number;
  /**
   * per-loop folded lineage when an id is requested, else a map of loopId →
   * lineage for every loop that has runs on the ledger. Read-only fold of the
   * canonical runs tagged with the loop (PRD §8 — the Host derives lineage by
   * folding those runs; zero new run tables).
   */
  lineage?: any;
  lineages?: Record<string, any>;
  /**
   * For a kind==='system' loop id: the matching scheduler state (deps.systemStatus),
   * returned INSTEAD of a ledger fold (system loops have no ledger runs).
   */
  system?: any;
}

export interface LoopsService {
  listLoops: () => LoopSpec[];
  getLoop: (id: string) => LoopSpec | null;
  /** compile free-text intent into a proposed draft (PRD §9 Slice 3 forge). */
  compileLoop: (text: string) => LoopsCompileResult;
  lockOnLoop: (draft: LoopSpecDraft) => LoopsLockOnResult;
  saveLoop: (spec: LoopSpec) => LoopSpec;
  runLoop: (id: string, inputs?: Record<string, any>) => Promise<LoopsRunResult>;
  stopLoop: (invocationIdOrLoopId: string) => LoopsStopResult;
  removeLoop: (id: string) => { removed: boolean };
  killAllLoops: () => { ok: true };
  loopStatus: (idOrAll?: string | null) => LoopsStatusResult;
  /** arm the trigger scheduler for every enabled schedule trigger (PRD §9 Slice 3). */
  startTriggers: () => { armed: number };
  /** disarm all trigger timers. */
  stopTriggers: () => { ok: true };
  /** fire every loop whose enabled event trigger matches; returns the fired ids. */
  fireLoopEvent: (event: string) => { fired: string[] };
  /** select the saved loop best matching a free-text intent (manager seam; no fire). */
  selectLoop: (description: string) => { loopId: string | null; score: number; ranked: Array<{ loopId: string; score: number }> };
  /**
   * Seed builtin system LoopSpecs (PRD §10) into the catalog. Validated + idempotent:
   * an invalid spec is skipped + logged; a spec already present is never clobbered.
   * Returns the ids actually seeded this call. Called automatically when
   * deps.builtins is provided.
   */
  seedBuiltins: (specs: LoopSpec[]) => { seeded: string[] };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function isNonEmptyString(v: any): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function toKebabId(value: any): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Flatten a loop-host LoopIntent into the run-ledger intent shape the spine's
 * submitIntent expects (recon submitIntentSeam): the kernel intent carries
 * { goal, workspace/workspaceId, agent?, allow?[], merge? }. We TAG it with
 * loopId/loopLineageId/iteration so loop-lineage can fold the run back (PRD §2
 * invariant 3 — every iteration is a canonical run tagged with its loopId), and
 * pass the owner-gated merge tokenRef THROUGH so the spine's fail-closed gate
 * decides (the service never merges).
 */
function mapLoopIntentToRunIntent(loopIntent: any): any {
  const li = loopIntent && typeof loopIntent === 'object' ? loopIntent : {};
  const scope = li.scope && typeof li.scope === 'object' ? li.scope : {};
  const merge = li.merge && typeof li.merge === 'object' ? li.merge : {};
  // EXECUTION-target workspace LABEL (PRD §9 Slice 4 control-vs-target): the loop's
  // CONTROL surface stays Loops — loopStatus folds the run back by its loopId tag
  // regardless of which workspace it executed in. This is a human label, NOT a
  // projects.id, and must NEVER be used as the spawn workspaceId.
  const targetWorkspace = isNonEmptyString(scope.workspace) ? String(scope.workspace) : 'loops';

  // EXECUTION project id — a REAL projects.id the spine's worker dispatch spawns a
  // worktree from (spine-effects dispatchOne → resolveRunTask(workspaceId)). The
  // loop's target.workspaceId wins; else fall back to the SAME spine workspace
  // ace-control injects at createSpineEffects (ACE_SPINE_WORKSPACE_ID) so a
  // single-project deployment Just Works. Never the 'loops' label.
  const execWorkspaceId = isNonEmptyString(scope.workspaceId)
    ? String(scope.workspaceId)
    : isNonEmptyString(process.env.ACE_SPINE_WORKSPACE_ID)
      ? String(process.env.ACE_SPINE_WORKSPACE_ID)
      : undefined;
  const repo = isNonEmptyString(scope.repo) ? String(scope.repo) : undefined;
  const paths = Array.isArray(scope.allow) ? scope.allow.filter((p: any) => isNonEmptyString(p)) : [];

  // Build a NESTED TaskSpec scope. The spine's parseSpec (tools/ace/src/spec.cts)
  // + runSpecFor (`scope: spec.scope || {}`) require scope to declare at least one of
  // {repo, paths, workspaceId}. The pre-fix shape emitted these FLAT at the intent
  // top-level (workspaceId was even the 'loops' LABEL) with no `scope` object, so
  // state.spec.scope folded EMPTY → every run died `worker.dispatch.failed:
  // parseSpec: scope must declare at least one of {repo,paths,workspaceId}` and NO
  // worker ever attached. runSpecFor defaults baseBranch ('main') + role ('editor');
  // we only owe a non-empty nested scope + a non-empty acceptance.
  const taskScope: any = {};
  if (isNonEmptyString(execWorkspaceId)) taskScope.workspaceId = execWorkspaceId;
  if (repo) taskScope.repo = repo;
  if (paths.length) { taskScope.paths = paths; taskScope.allow = paths; }

  // acceptance MUST be non-empty (parseSpec). Carry an explicit acceptance if the
  // loop supplied one; else derive one deterministic A-ID from the goal so the
  // worker is never spec-less.
  const explicitAcceptance = Array.isArray(li.acceptance)
    ? li.acceptance.filter((a: any) => isNonEmptyString(a))
    : [];
  const acceptance = explicitAcceptance.length ? explicitAcceptance : [deriveAcceptanceFromGoal(li.goal)];

  return {
    goal: li.goal,
    // Carry both label keys for back-compat readers that key on `workspace`.
    workspace: targetWorkspace,
    workspaceId: execWorkspaceId,
    controlWorkspace: 'loops',
    agent: li.agent || 'auto',
    kind: li.kind,
    skills: Array.isArray(li.skills) ? li.skills : [],
    // NESTED scope (the fix) + flat repo/allow kept for any board reader.
    scope: taskScope,
    repo,
    allow: paths,
    acceptance,
    merge: { ownerGated: true, tokenRef: isNonEmptyString(merge.tokenRef) ? merge.tokenRef : undefined },
    // A tokenRef marks the owner-approved hands-off ship lane — arm the bounded
    // same-branch fixback worker so failing CI / review-bot checks fail-forward
    // instead of parking the iteration.
    ...(isNonEmptyString(merge.tokenRef) ? { allowFixbackWorker: true } : {}),
    // Loop tagging — read back by loopStatus's lineage fold off the ledger.
    loopId: li.loopId,
    loopLineageId: li.loopLineageId,
    iteration: li.iteration,
  };
}

/**
 * Derive one deterministic acceptance A-ID from a loop's goal so the dispatched
 * TaskSpec always carries a non-empty acceptance[] (parseSpec requires it). Pure:
 * regex/string only, no clock/random.
 */
function deriveAcceptanceFromGoal(goal: any): string {
  const g = isNonEmptyString(goal) ? String(goal).trim().replace(/\s+/g, ' ') : '';
  if (!g) return 'The loop goal is satisfied with verifiable evidence.';
  return `Goal satisfied with verifiable evidence: ${g.slice(0, 180)}`;
}

/**
 * Summarize BLOCKING (critical/high) Clawpatch findings from a report's text,
 * mirroring the CLI's summarizeFindings regex. Returns [{ severity, count }] for
 * each blocking tier with a non-zero count; [] when the report is clean. Pure.
 */
function summarizeBlockingFindings(reportText: string): Array<{ severity: string; count: number }> {
  const out: Array<{ severity: string; count: number }> = [];
  for (const severity of ['critical', 'high'] as const) {
    const match = String(reportText || '').match(new RegExp(`${severity}[^0-9]{0,20}(\\d+)`, 'i'));
    const count = match ? Number(match[1]) || 0 : 0;
    if (count > 0) out.push({ severity, count });
  }
  return out;
}

/**
 * Lazy-require the project-wiki curator (tools/ace/src) for the run-summary
 * write-back. Opaque require string so esbuild never bundles it into the electron
 * bundle; .cjs (built app) first, .cts (fresh worktree / node --test) fallback.
 */
function requireProjectWikiCurator(): any {
  const runtimeRequire = module.require.bind(module);
  const rel = '../../tools/ace/src/project-wiki-curator';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return runtimeRequire(rel + '.cjs');
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return runtimeRequire(rel + '.cts');
  }
}

/**
 * Extract the loop tag (loopId) from one INTENT_CREATED event's payload, or null
 * for a non-loop run. The intent is stored as payload.intent (kernel.submitIntent).
 */
function intentLoopId(event: any): string | null {
  const intent = event && event.payload && event.payload.intent;
  if (!intent || typeof intent !== 'object') return null;
  return isNonEmptyString(intent.loopId) ? String(intent.loopId) : null;
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

export function createLoopsService(deps: LoopsServiceDeps): LoopsService {
  if (!deps || !deps.fs || typeof deps.fs.readFile !== 'function' || typeof deps.fs.writeFile !== 'function') {
    throw new Error('loops-service: createLoopsService requires injected fs { readFile, writeFile }');
  }
  if (!isNonEmptyString(deps.catalogPath)) {
    throw new Error('loops-service: createLoopsService requires a catalogPath');
  }

  const harness = deps.harness || null;
  const driveRun = typeof deps.driveRun === 'function' ? deps.driveRun : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const hasWorkspaceCleanup = !!deps.workspaceCleanup;

  // The definition store — a real catalog JSON under userData. Independent of the
  // ledger, so list/get/lockOn/save work even when the spine is disabled.
  const store = createLoopStore({
    readFile: deps.fs.readFile,
    writeFile: deps.fs.writeFile,
    catalogPath: deps.catalogPath,
  });

  function requireSpine(): LoopsServiceHarness {
    if (!harness) throw new Error('run-ledger spine disabled');
    return harness;
  }

  // submitIntent seam — flatten LoopIntent → run intent, submit to the LIVE
  // kernel via the harness, then driveRun(runId) so the iteration advances like a
  // CLI run submit. Returns the minted runId the host observes.
  function submitIntent(loopIntent: any): string {
    const h = requireSpine();
    const runId = h.submit(mapLoopIntentToRunIntent(loopIntent));
    const id = runId ? String(runId) : '';
    if (id) {
      try {
        driveRun(id);
      } catch {
        /* driveRun is fire-and-forget; the periodic reconcile re-arms the run. */
      }
    }
    return id;
  }

  // observeRun seam — fold the run's reconciled state (foldEventsToState) into the
  // IterationRunState the host/lineage read. Read-only (PRD §2 invariant 2).
  function observeRun(runId: string): any {
    if (!harness) return null;
    try {
      const reconciled = harness.kernel.reconcile(String(runId));
      return reconciled && reconciled.state ? reconciled.state : null;
    } catch {
      return null;
    }
  }

  // Resolve a run's worker worktree path from the ledger's worker.dispatch.linked
  // annotation (the LAST one wins — a re-dispatch supersedes). Read-only.
  function worktreePathForRun(runId: string): string | null {
    if (!harness || !harness.ledger || typeof harness.ledger.readRun !== 'function') return null;
    let events: any[] = [];
    try {
      events = harness.ledger.readRun(String(runId));
    } catch {
      return null;
    }
    for (let i = (Array.isArray(events) ? events.length : 0) - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e && e.type === 'worker.dispatch.linked' && e.payload && isNonEmptyString(e.payload.worktreePath)) {
        return String(e.payload.worktreePath);
      }
    }
    return null;
  }

  // observeClawpatch seam (loop-host fixback bridge, requirement §4): read the
  // run's Clawpatch report from its worktree so the NEXT iteration's fixback goal
  // can name the blocking findings. Best-effort + read-only: a missing/unreadable
  // report returns null (no enrichment) — the loop's merge stays fail-closed on the
  // validator PASS + green CI gate regardless, so nothing merges past findings.
  function observeClawpatch(runId: string): any {
    const worktree = worktreePathForRun(String(runId));
    if (!worktree) return null;
    const reportRel = nodePath.join('.clawpatch', 'report.md');
    const reportAbs = nodePath.join(worktree, reportRel);
    let reportText: string | null = null;
    try {
      reportText = deps.fs.readFile(reportAbs) ?? null;
    } catch {
      reportText = null;
    }
    if (!isNonEmptyString(reportText)) return null;
    const blockingFindings = summarizeBlockingFindings(String(reportText));
    return {
      required: true,
      readable: true,
      status: blockingFindings.length ? 'fail' : 'pass',
      blockingFindings,
      reportText: String(reportText),
      reportPath: reportRel,
    };
  }

  // writeRunSummary seam (wiki write-back, requirement §5): route the ship loop's
  // converged run-summary through the project-wiki curator's writeDumpRecord so it
  // lands as a secret-scanned, contamination-gated RAW-tier dump the nightly
  // knowledge indexer ingests (never direct canon). FAIL-OPEN: any error logs and
  // never breaks loop termination (the loop-host also wraps this call in try/catch).
  function writeRunSummary(record: any): void {
    try {
      const projectDir = record && isNonEmptyString(record.projectDir) ? String(record.projectDir) : null;
      const projectId = record && isNonEmptyString(record.projectId) ? String(record.projectId) : null;
      if (!projectDir || !projectId) {
        if (typeof console !== 'undefined') {
          console.warn('[ace] loop run-summary write-back skipped: no resolvable projectDir/projectId');
        }
        return;
      }
      let curator: any;
      try {
        curator = requireProjectWikiCurator();
      } catch {
        return;
      }
      curator.writeDumpRecord({ projectDir, record });
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[ace] loop run-summary write-back failed:', err);
    }
  }

  // The multi-loop supervisor, bound to the live seams. Concurrency cap + master
  // kill live HERE (in the host) per PRD §7/§R6.
  const host = createLoopHost({
    submitIntent,
    observeRun,
    store: { get: (id: string) => store.get(id) },
    now,
    concurrencyCap: Number.isFinite(Number(deps.concurrencyCap)) ? Number(deps.concurrencyCap) : undefined,
    observeClawpatch,
    writeRunSummary,
  });

  // The trigger scheduler (PRD §9 Slice 3) — re-reads the catalog each cycle and
  // fires the SAME runLoop the button calls. Inert until startTriggers() is called.
  const ambientSetTimeout =
    deps.timers && typeof deps.timers.setTimeout === 'function'
      ? deps.timers.setTimeout
      : (fn: () => void, ms: number) => setTimeout(fn, ms);
  const ambientClearTimeout =
    deps.timers && typeof deps.timers.clearTimeout === 'function'
      ? deps.timers.clearTimeout
      : (handle: any) => clearTimeout(handle);
  const triggerScheduler = createLoopTriggerScheduler({
    now: () => Number(now()) || 0,
    setTimeout: ambientSetTimeout,
    clearTimeout: ambientClearTimeout,
    listLoops: () => store.list(),
    // Fire-and-forget the canonical runLoop; the scheduler logs/catches rejections.
    runLoop: (loopId: string) => {
      void runLoop(loopId, {});
    },
  });

  // ---- definition methods (work even when the spine is disabled) ----

  function listLoops(): LoopSpec[] {
    const saved = store.list().filter((loop) => loop.id !== WORKSPACE_CLEANUP_LOOP_ID);
    return hasWorkspaceCleanup ? [WORKSPACE_CLEANUP_LOOP_SPEC, ...saved] : saved;
  }

  function getLoop(id: string): LoopSpec | null {
    if (id === WORKSPACE_CLEANUP_LOOP_ID && hasWorkspaceCleanup) return WORKSPACE_CLEANUP_LOOP_SPEC;
    return store.get(id);
  }

  function compileLoop(text: string): LoopsCompileResult {
    const compiled = compileFromNL(String(text == null ? '' : text));
    return { draft: compiled.draft, notes: compiled.notes };
  }

  function lockOnLoop(draft: LoopSpecDraft): LoopsLockOnResult {
    const res: LockOnResult = lockOnLoopSpec(draft, { now, idFromName: toKebabId });
    if (!res.locked || !res.spec) {
      return { errors: isNonEmptyString(res.reason) ? String(res.reason).split('; ') : ['lock-on failed'] };
    }
    return { spec: res.spec };
  }

  // True once startTriggers() armed the scheduler — so a catalog edit (save/remove)
  // re-arms immediately rather than waiting for the next boot.
  let triggersActive = false;

  function saveLoop(spec: LoopSpec): LoopSpec {
    if (spec && spec.id === WORKSPACE_CLEANUP_LOOP_ID) {
      throw new Error('loops-service: built-in system loop cannot be overwritten');
    }
    const saved = store.save(spec);
    if (triggersActive) triggerScheduler.start();
    return saved;
  }

  /**
   * Seed builtin system LoopSpecs (PRD §10) into the catalog. Each spec is validated
   * against validateLoopSpec (the catalog is fail-closed); an invalid one is skipped
   * + logged so a single bad builtin never poisons the whole list. Idempotent: a
   * builtin already present (e.g. an operator edit) is NEVER clobbered.
   */
  function seedBuiltins(specs: LoopSpec[]): { seeded: string[] } {
    const seeded: string[] = [];
    for (const spec of Array.isArray(specs) ? specs : []) {
      const id = spec && isNonEmptyString((spec as any).id) ? String((spec as any).id) : '';
      if (!id) continue;
      if (store.get(id)) continue; // never clobber a user edit.
      const res = validateLoopSpec(spec);
      if (!res.ok) {
        if (typeof console !== 'undefined') {
          console.warn(`[ace] builtin loop '${id}' skipped (invalid): ${res.errors.join('; ')}`);
        }
        continue;
      }
      store.save(spec);
      seeded.push(id);
    }
    return { seeded };
  }

  // ---- run methods (require the live spine) ----

  async function runLoop(id: string, inputs: Record<string, any> = {}): Promise<LoopsRunResult> {
    if (id === WORKSPACE_CLEANUP_LOOP_ID) {
      if (!deps.workspaceCleanup) throw new Error('workspace cleanup loop unavailable');
      return runWorkspaceCleanupLoop(inputs || {}, deps.workspaceCleanup);
    }

    // System loops (PRD §10) run an in-process aceStore method (systemRunRef),
    // NOT a spine worker — so do NOT requireSpine. They have no ledger runs / no
    // agent-iteration cards: we synthesize a single terminal completion carrying the
    // runner's raw result under `systemResult` for the kind-aware result card.
    const spec = store.get(String(id));
    if (spec && spec.kind === 'system') {
      const ref = isNonEmptyString(spec.systemRunRef) ? String(spec.systemRunRef) : spec.id;
      const runner = deps.systemRunners ? deps.systemRunners[ref] : undefined;
      let systemResult: any = null;
      if (typeof runner === 'function') {
        systemResult = await Promise.resolve(runner(inputs || {}));
      } else {
        systemResult = { ok: false, error: `no system runner for '${ref}'` };
      }
      const invocationId = `loopinv-${spec.id}-system-${String(now())}`;
      return {
        invocationId,
        loopId: spec.id,
        loopLineageId: spec.id,
        finished: true,
        finishReason: 'system',
        reasonDetail: 'system maintenance loop completed in-process',
        latestRunOutcome: null,
        iterations: [],
        systemResult,
      };
    }
    requireSpine();
    const result: LoopInvocationResult = await host.invokeLoop(id, inputs || {});
    return {
      invocationId: result.invocationId,
      loopId: result.loopId,
      loopLineageId: result.loopLineageId,
      finished: result.finished,
      finishReason: result.finishReason,
      reasonDetail: result.reasonDetail,
      latestRunOutcome: result.latestRunOutcome,
      iterations: result.iterations.map((it) => ({
        index: it.index,
        runId: it.runId,
        goal: it.goal,
        classification: it.classification,
        reason: it.reason,
      })),
    };
  }

  function stopLoop(invocationIdOrLoopId: string): LoopsStopResult {
    const target = isNonEmptyString(invocationIdOrLoopId) ? String(invocationIdOrLoopId) : '';
    if (!target) return { stopped: false };
    // An explicit host invocation id stops just that invocation.
    if (target.startsWith('loopinv-')) return { stopped: host.stop(target) };
    // Otherwise treat it as a loopId and stop every active invocation of that loop
    // (the Loops tab only knows the loopId of the selected card).
    const prefix = `loopinv-${target}-`;
    let stopped = false;
    for (const invId of host.activeInvocations()) {
      if (invId.startsWith(prefix)) stopped = host.stop(invId) || stopped;
    }
    return { stopped };
  }

  function removeLoop(id: string): { removed: boolean } {
    if (id === WORKSPACE_CLEANUP_LOOP_ID) return { removed: false };
    const removed = store.remove(String(id));
    if (triggersActive && removed) triggerScheduler.start();
    return { removed };
  }

  function killAllLoops(): { ok: true } {
    host.killAll();
    return { ok: true };
  }

  /**
   * Read loop lineage from the ledger (PRD §8 — fold the canonical runs tagged
   * with the loop; zero new run tables). For a specific id we collect that loop's
   * tagged runs, reconcile each to its state, and fold; for 'all'/null we build a
   * map loopId → lineage. Always reports the host's live active/in-flight gauges.
   */
  function loopStatus(idOrAll?: string | null): LoopsStatusResult {
    const base: LoopsStatusResult = {
      active: host.activeInvocations(),
      inFlight: host.inFlightCount(),
    };

    // System loops (PRD §10) have no ledger runs — return the matching scheduler
    // state (deps.systemStatus) INSTEAD of a ledger fold. The agent-loop fold below
    // applies only to code/agentic loops.
    const wantSpec =
      isNonEmptyString(idOrAll) && idOrAll !== 'all' ? store.get(String(idOrAll)) : null;
    if (wantSpec && wantSpec.kind === 'system') {
      let system: any = null;
      if (typeof deps.systemStatus === 'function') {
        try {
          system = deps.systemStatus(wantSpec);
        } catch {
          system = null;
        }
      }
      return { ...base, system };
    }

    const cleanupLineage = deps.workspaceCleanup ? readWorkspaceCleanupLineage(deps.workspaceCleanup) : null;
    if (!harness) {
      if (idOrAll === WORKSPACE_CLEANUP_LOOP_ID) return { ...base, lineage: cleanupLineage };
      return cleanupLineage ? { ...base, lineages: { [WORKSPACE_CLEANUP_LOOP_ID]: cleanupLineage } } : base;
    }

    // Group the loop-tagged runs (ordered by first-seen, oldest → newest) per loop.
    const order = new Map<string, string[]>(); // loopId -> ordered runIds
    const seenRun = new Set<string>();
    let events: any[] = [];
    try {
      events = harness.ledger.readAll();
    } catch {
      events = [];
    }
    for (const e of Array.isArray(events) ? events : []) {
      const loopId = intentLoopId(e);
      if (!loopId) continue;
      const runId = e && e.runId ? String(e.runId) : '';
      if (!runId) continue;
      const key = `${loopId}::${runId}`;
      if (seenRun.has(key)) continue;
      seenRun.add(key);
      if (!order.has(loopId)) order.set(loopId, []);
      (order.get(loopId) as string[]).push(runId);
    }

    // Fold each loop's runs kind-aware (PRD §1/§9): an agentic loop's finished
    // worker folds to a terminal DONE without a PR/validator. The kind comes from
    // the saved definition (the catalog), independent of the ledger.
    const kindOf = (loopId: string): 'code' | 'agentic' | undefined => {
      const spec = store.get(loopId);
      return spec && spec.kind ? spec.kind : undefined;
    };

    const wantId = isNonEmptyString(idOrAll) && idOrAll !== 'all' ? String(idOrAll) : null;
    if (wantId) {
      if (wantId === WORKSPACE_CLEANUP_LOOP_ID) return { ...base, lineage: cleanupLineage };
      const runIds = order.get(wantId) || [];
      return { ...base, lineage: foldLoopLineage(wantId, collectStates(runIds, observeRun), { kind: kindOf(wantId) }) };
    }

    const lineages: Record<string, any> = {};
    if (cleanupLineage) lineages[WORKSPACE_CLEANUP_LOOP_ID] = cleanupLineage;
    for (const [loopId, runIds] of order.entries()) {
      lineages[loopId] = foldLoopLineage(loopId, collectStates(runIds, observeRun), { kind: kindOf(loopId) });
    }
    return { ...base, lineages };
  }

  // ---- triggers + manager seam (PRD §9 Slice 3) ----

  function startTriggers(): { armed: number } {
    triggersActive = true;
    triggerScheduler.start();
    return { armed: triggerScheduler.armedCount() };
  }

  function stopTriggers(): { ok: true } {
    triggersActive = false;
    triggerScheduler.stop();
    return { ok: true };
  }

  function fireLoopEvent(event: string): { fired: string[] } {
    return { fired: triggerScheduler.fireEvent(String(event == null ? '' : event)) };
  }

  function selectLoop(
    description: string,
  ): { loopId: string | null; score: number; ranked: Array<{ loopId: string; score: number }> } {
    const res = selectLoopForIntent(String(description == null ? '' : description), listLoops());
    return {
      loopId: res.match ? res.match.loopId : null,
      score: res.match ? res.match.score : 0,
      ranked: res.ranked,
    };
  }

  // Seed the built-in loops once at construction when the caller supplies the system
  // builtins (PRD §10). Two families are seeded here through the SAME idempotent path:
  //   1. deps.builtins       — the kind:'system' maintenance loops (locked in the UI),
  //   2. ALL_LOOP_TEMPLATES  — the editable kind:'code' starter templates (WS-F) PLUS
  //      the owner-approved loop-ship auto-merge loop.
  // seedBuiltins is idempotent + fail-closed: a builtin already present (e.g. an
  // operator edit) is never clobbered, and an invalid spec is skipped + logged.
  // Gated on deps.builtins so a bare service (a test constructing without builtins)
  // still starts from an empty catalog.
  if (Array.isArray(deps.builtins) && deps.builtins.length > 0) {
    try {
      seedBuiltins(deps.builtins);
      // ALL_LOOP_TEMPLATES = the four parking starters + the owner-approved
      // loop-ship (auto-merge). seedBuiltins is idempotent + fail-closed.
      seedBuiltins(ALL_LOOP_TEMPLATES);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[ace] builtin loop seeding failed:', err);
    }
  }

  return {
    listLoops,
    getLoop,
    compileLoop,
    lockOnLoop,
    saveLoop,
    runLoop,
    stopLoop,
    removeLoop,
    killAllLoops,
    loopStatus,
    startTriggers,
    stopTriggers,
    fireLoopEvent,
    selectLoop,
    seedBuiltins,
  };
}

/**
 * Reconcile every runId to its state (skipping unobservable runs) and stamp the
 * runId so the lineage fold can key on it. Ordered oldest → newest as handed in.
 */
function collectStates(runIds: string[], observeRun: (runId: string) => any): any[] {
  const states: any[] = [];
  for (const runId of Array.isArray(runIds) ? runIds : []) {
    const state = observeRun(runId);
    if (state) {
      if (state.runId == null) state.runId = runId;
      states.push(state);
    }
  }
  return states;
}

module.exports = {
  createLoopsService,
  mapLoopIntentToRunIntent,
};
