const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { createScreenReader } = require('./screen-reader.cjs');
const { createStateMachine, compileProfile } = require('./state-machine.cjs');
const { createInput, sanitizeTerminalInputPayload } = require('./input.cjs');
const { createStreamEventBus } = require('./events.cjs');
const { createRecorders, loadRecording } = require('./recorder.cjs');
const { writeSnapshot, SNAPSHOT_DIR } = require('./snapshot.cjs');
const { createTranscriptController } = require('./transcript/index.cjs');
const { getProvider, resolveSessionFile, sessionFileState } = require('../agent-providers.cjs');
const { createCompletionInbox } = require('./completion-inbox.cjs');
const {
  createChildRegistry,
  createFileDb,
  defaultStorePath,
} = require('../../tools/ace/src/child-registry.cjs');
let workspaceAutomergePolicy: any;
try {
  workspaceAutomergePolicy = require('../../tools/ace/src/workspace-automerge-policy.cjs');
} catch {
  workspaceAutomergePolicy = require('../../tools/ace/src/workspace-automerge-policy.cts');
}
let codexTrust: any;
try {
  codexTrust = require('../codex-trust.cjs');
} catch {
  codexTrust = require('../codex-trust.cts');
}
let intakeGate: any;
try {
  intakeGate = require('../run-ledger/intake-gate.cjs');
} catch {
  intakeGate = require('../run-ledger/intake-gate.cts');
}
let followUpSupervisor: any;
try {
  followUpSupervisor = require('../../tools/ace/src/follow-up-supervisor.cjs');
} catch {
  followUpSupervisor = require('../../tools/ace/src/follow-up-supervisor.cts');
}
let orchestrationPolicyModule: any;
try {
  orchestrationPolicyModule = require('../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicyModule = require('../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS, FIXBACK_RETRY_CAP } = orchestrationPolicyModule;
const { evaluateWaveJoin } = require('../../tools/ace/src/wave-join.cjs');
const { isValidatorVerdictText } = require('../../tools/ace/src/verdict.cjs');

// Build-agnostic loader for the run-ledger (spine-kernel) modules. We resolve an
// ABSOLUTE path via __dirname so esbuild leaves this as a runtime require of the
// STANDALONE run-ledger .cjs — whose own __dirname is electron/run-ledger/, so
// its relative sibling requires (./event-ledger.cjs etc.) resolve correctly.
// A literal/templated relative require would let esbuild glob-bundle the modules
// INTO this bundle, breaking the inlined kernel's sibling resolution.
function requireRunLedger(name: string) {
  const base = path.join(__dirname, '..', 'run-ledger');
  try {
    return require(path.join(base, name + '.cjs'));
  } catch {
    return require(path.join(base, name + '.cts'));
  }
}

// Build-agnostic loader for the additive Loops subsystem modules (electron/loops/*),
// resolved by ABSOLUTE path via __dirname for the same esbuild reason as the
// run-ledger loader above (a literal/templated relative require would glob-bundle
// the modules and break their sibling resolution). .cjs-first, .cts fallback.
function requireLoops(name: string) {
  const base = path.join(__dirname, '..', 'loops');
  try {
    return require(path.join(base, name + '.cjs'));
  } catch {
    return require(path.join(base, name + '.cts'));
  }
}

const DEFAULT_ASK_TIMEOUT = 5 * 60 * 1000;
const SUBMIT_RETRY_MS = 500;
const DEFAULT_PROFILE_ID = 'default';

// Substitutes profile-config tokens with runtime paths. Profile JSON is
// shipped static, but transcript globs need to point at the actual
// userData directory at runtime — Ace spawns Hermes with HERMES_HOME
// rooted in <userData>/hermes-home* for every workspace. Token-substitute
// at load so the linker watches the right tree.
function expandProfileTemplates(raw: any, userDataPath: any) {
  if (!raw || typeof raw !== 'object') return raw;
  const replace = (value: any) => {
    if (typeof value !== 'string') return value;
    if (!userDataPath) return value;
    return value.split('{userDataPath}').join(userDataPath);
  };
  if (raw.transcript && typeof raw.transcript === 'object') {
    if (typeof raw.transcript.sessionGlob === 'string') {
      raw.transcript.sessionGlob = replace(raw.transcript.sessionGlob);
    }
  }
  return raw;
}

function loadProfilesFromDisk(dir: any, userDataPath?: any) {
  const out = new Map();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ent.name), 'utf8'));
    expandProfileTemplates(raw, userDataPath);
    out.set(raw.id, compileProfile(raw));
  }
  if (!out.has(DEFAULT_PROFILE_ID)) {
    throw new Error('ace-control: default.json profile missing');
  }
  return out;
}

function profileForAgent(profiles: any, agentId: any) {
  for (const [, p] of profiles) {
    if ((p as any).detect?.agent === agentId) return p;
  }
  return profiles.get(DEFAULT_PROFILE_ID);
}

function publicProfile(p: any) {
  if (!p) return null;
  const { _rx, ...rest } = p;
  void _rx;
  return rest;
}

function createAceController({ aceStore, userDataPath, transcriptDb, transcriptStore }: any) {
  if (!aceStore) throw new Error('aceStore required');

  const profilesDir = path.join(__dirname, 'profiles');
  const profiles = loadProfilesFromDisk(profilesDir, userDataPath);
  const screen = createScreenReader();
  const bus = createStreamEventBus();
  const tabs = new Map();
  const rawTerminalInput = new Map<string, string>();
  const terminalInputEndedWithCr = new Set<string>();
  const resumePickerStreams = new Set<string>();
  const terminalObservationQueues = new Map<string, Promise<any>>();

  // Run-ledger (spine-kernel) event source — Ring 2. Additive: every worker/
  // validator completion is mirrored into an append-only ledger so the kernel
  // can reconcile/project the SAME runs the live mission system drives. This
  // changes no existing behavior (the ledger only fills) and never throws —
  // it is the delete-after-parity cutover's foundation. Disable with
  // ACE_RUN_LEDGER=0. Keyed under the controller's own userDataPath.
  // The Run-Ledger spine, composed as the ONE harness (event ledger + kernel +
  // Ring-1 drivers + the loop). Ring 2 (the completion observer below) mirrors
  // every worker/validator completion into the ledger; Ring 0 (kernel) reconciles
  // it; Ring 3 (the lean board IPC) projects it as a read-only watcher. The
  // autonomy LOOP (runToQuiescence) runs LIVE by default with real Ring-1
  // effects — worker/validator dispatch is real; merge_to_main is fail-closed
  // behind the owner token (no token => park at ready_to_review). Disable
  // the whole spine with ACE_RUN_LEDGER=0.
  let runLedgerHarness: any = null;
  let runLedgerFromCompletion: any = null;
  let runLedgerAutoTelemetry: any = null;
  let runLedgerRawTrailerAdmission: any = null;
  let runLedgerInitAttempted = false;
  // Lazy in-process client for the Ring-1 effects. The real dispatch effects
  // need the in-process client, which is built later in this factory (it closes
  // over `methods`). The thunk resolves it at first effect call, so there is no
  // init-order cycle.
  let deferredInProcessClient: () => any = () => {
    throw new Error('spine-effects: in-process client not ready yet');
  };

  function ensureRunLedgerHarness() {
    if (runLedgerHarness || runLedgerInitAttempted) return runLedgerHarness;
    runLedgerInitAttempted = true;
    if (process.env.ACE_RUN_LEDGER !== '0' && userDataPath) {
      try {
        const { createRunLedgerHarness } = requireRunLedger('harness');
        const fromCompletionModule = requireRunLedger('from-completion');
        runLedgerFromCompletion = fromCompletionModule.fromCompletion;
        runLedgerAutoTelemetry = fromCompletionModule.autoTelemetryFor || null;
        runLedgerRawTrailerAdmission = fromCompletionModule.rawTrailerAdmission || null;
        const ledgerPath = path.join(userDataPath, '.ace', 'run-ledger', 'events.ndjson');
        // LIVE by default: dispatchWorker creates a real worktree + spawns a
        // real agent, validators run, and release is fail-closed — merge_to_main
        // requires the resolved owner token (env ACE_OWNER_AUTH_TOKEN or the
        // ops-config autoship token), otherwise the run PARKS at
        // ready_to_review with main untouched. ACE_RUN_LEDGER=0 disables the spine.
        // Real Ring-1 dispatch effects are ON in the default boot (master kill:
        // ACE_RUN_LEDGER=0). dispatchWorker/dispatchFixback/runValidation spawn
        // real worktrees+agents via the in-process client; gate supplies live PR
        // facts and release is fail-closed (no owner token => no merge), so a run
        // dispatches, validates, and PARKS at ready_to_review with main untouchable.
        const { createSpineEffects } = requireRunLedger('spine-effects');
        const effects = createSpineEffects({
          client: { invoke: (m: string, p: any) => deferredInProcessClient().invoke(m, p) },
          workspaceId: process.env.ACE_SPINE_WORKSPACE_ID || null,
        });
        runLedgerHarness = createRunLedgerHarness({ ledgerPath, now: () => Date.now(), effects });
      } catch (err: any) {
        console.warn('[ace] run-ledger spine disabled: ' + (err?.message || err));
        runLedgerHarness = null;
      }
    }
    return runLedgerHarness;
  }

  function workspaceForRunIntent(intent: any) {
    const workspaceId = intent?.scope?.workspaceId || intent?.workspaceId || null;
    if (!workspaceId) return { workspaceId: null, workspace: null, projectDir: null };
    const workspaces = aceStore.getState()?.workspaces || [];
    const workspace = (Array.isArray(workspaces) ? workspaces : []).find((ws: any) => ws && ws.id === workspaceId) || null;
    const projectDir = workspace ? (workspace.isRemote ? workspace.remotePath || workspace.path : workspace.path) : null;
    return { workspaceId, workspace, projectDir };
  }

  function applyWorkspaceAutomergePolicy(intent: any) {
    const spec = intent && typeof intent === 'object' ? intent : {};
    const { workspace, projectDir } = workspaceForRunIntent(spec);
    const policy = workspaceAutomergePolicy.resolveWorkspaceAutomergePolicy({ spec, workspace, projectDir });
    if (policy.source === 'default') return spec;
    const next = { ...spec, workspaceAutoMergePolicy: policy };
    const scope = next.scope && typeof next.scope === 'object' && !Array.isArray(next.scope) ? next.scope : {};
    if ((!Array.isArray(scope.allow) || scope.allow.length === 0) && policy.allowPaths.length > 0) {
      next.scope = { ...scope, allow: policy.allowPaths };
    }
    if (next.autoShip === undefined && policy.enabled === true) {
      next.autoShip = { enabled: true, autoMerge: policy.autoMerge === true };
    }
    return next;
  }

  // The LEAN, READ-ONLY board view (owner directive: the board is a watcher,
  // never a gate). A pure projection over the SAME ledger the Ring-2 observer
  // fills — it spends zero tokens and has zero side-effects. Returns an empty
  // board when the ledger is disabled so the IPC read never throws. The renderer
  // auto-refreshes it via the existing state-changed / stream-event pushes; the
  // autonomy loop never reads or waits on it.
  function leanBoard() {
    const empty = {
      columns: { todo: [], in_progress: [], ready_to_review: [], done: [], blocked: [] },
      cards: [],
      counts: { todo: 0, inProgress: 0, readyToReview: 0, done: 0, blocked: 0, total: 0 },
      followUps: followUpStore.digest({ now: Date.now() }),
    };
    const harness = ensureRunLedgerHarness();
    if (!harness) return empty;
    try {
      return { ...harness.board(), followUps: followUpStore.digest({ now: Date.now() }) };
    } catch {
      // A failed projection must stay distinguishable from a genuinely empty
      // board: run-minting gates fail closed on `degraded` instead of reading
      // "no runs". (No harness needs no mark — with the spine disabled,
      // runSubmit throws its own clearer error and nothing can be duplicated.)
      return { ...empty, degraded: true };
    }
  }
  // Resolve a completion's ORIGINATING spine runId from the dispatch annotation
  // the spine wrote when it spawned the task (spine-effects `*.dispatch.linked`,
  // carrying taskId). The ledger is the source of truth, so this survives
  // restart and needs no in-memory index. Returns null for non-spine tasks (the
  // Ring-2 mirror then falls back to taskId keying, today's behavior).
  function resolveSpineRunId(taskId: any, streamId: any = null) {
    if (!runLedgerHarness) return null;
    const tid = taskId == null ? null : String(taskId);
    const sid = streamId == null ? null : String(streamId);
    if (tid == null && sid == null) return null;
    try {
      const events = runLedgerHarness.ledger.readAll();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (!e || typeof e.type !== 'string' || !e.type.endsWith('.dispatch.linked') || !e.payload) continue;
        // Match by taskId OR streamId. A spine worker runs on a variant stream
        // whose completion record can carry a null taskId (contextForStream may
        // not resolve it across a restart), but the streamId is ALWAYS on the
        // dispatch link — so streamId is the reliable key back to the run.
        const taskMatch = tid != null && e.payload.taskId != null && String(e.payload.taskId) === tid;
        const streamMatch = sid != null && e.payload.streamId != null && String(e.payload.streamId) === sid;
        if (taskMatch || streamMatch) return e.runId;
      }
    } catch {}
    return null;
  }
  // Run-ledger change push — the board's live refresh signal. Fired after any
  // controller path that APPENDS to the ledger settles (submit, drive-to-
  // quiescence, loop stop), so the renderer re-reads the ~0.1s lean projection
  // immediately instead of waiting for the 30s safety poll. Listeners are
  // best-effort and must never throw into the spine. Pure notification — it
  // carries no ledger data and gates nothing.
  const runLedgerListeners = new Set<any>();
  function notifyRunLedgerChanged() {
    for (const listener of runLedgerListeners) {
      try { listener({ ts: Date.now() }); } catch { /* listener error is never the spine's problem */ }
    }
  }
  // Drive a run to quiescence and SURFACE any driver error. The loop captures an
  // effect failure in the step result (it never throws), so without this the
  // failure is silently dropped — a real autonomy run would stall with no signal.
  // After it settles, the autonomy OUTER-loop neuron may author + dispatch the
  // next cycle (guarded, never throws into the spine).
  const drivingRuns = new Set<string>();
  function driveRun(runId: any) {
    if (!runLedgerHarness || !runId) return;
    const key = String(runId);
    // Guard against concurrent loops on the SAME run (a completion push and the
    // periodic reconcile sweep can both fire) — overlapping runToQuiescence calls
    // would race the ledger and could double-dispatch the validator.
    if (drivingRuns.has(key)) return;
    drivingRuns.add(key);
    Promise.resolve(runLedgerHarness.runToQuiescence(runId))
      .then((steps: any[]) => {
        for (const s of Array.isArray(steps) ? steps : []) {
          if (s && s.ok === false) console.warn(`[spine] run ${runId} step ${s.next} failed: ${s.error}`);
        }
        maybeAdvanceAutonomyLoop(runId);
      })
      .catch((e: any) => console.warn(`[spine] run ${runId} loop error: ${(e && e.message) || e}`))
      .finally(() => {
        drivingRuns.delete(key);
        // The quiescence loop appended events — push the board refresh signal.
        notifyRunLedgerChanged();
      });
  }

  // ---- Autonomy OUTER loop (the new neuron) --------------------------------
  // Lazy, build-agnostic imports of the pure loop brain + the gate-side evidence
  // reader. Resolved once; a resolution failure disables the neuron, never the
  // spine.
  let _autonomyLoop: any;
  function autonomyLoop() {
    if (_autonomyLoop !== undefined) return _autonomyLoop;
    try { _autonomyLoop = requireRunLedger('autonomy-loop'); } catch { _autonomyLoop = null; }
    return _autonomyLoop;
  }
  let _goalValidationPolicy: any;
  function readBehavioralCompletionSafe(args: any) {
    try {
      if (_goalValidationPolicy === undefined) {
        try { _goalValidationPolicy = require('../../tools/ace/src/goal-validation-policy.cjs'); }
        catch { _goalValidationPolicy = require('../../tools/ace/src/goal-validation-policy.cts'); }
      }
      return _goalValidationPolicy.readBehavioralCompletion(args);
    } catch { return { ok: false, reason: 'evidence reader unavailable' }; }
  }

  // The latest dispatch link of a given type within ONE run's ledger slice
  // (dispatchOne appends worker.dispatch.linked / validator.dispatch.linked to
  // the dispatching run). Carries the task's branch + worktreePath.
  function dispatchLinkForRun(runId: any, type: string) {
    try {
      const events = runLedgerHarness.ledger.readRun(runId);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e && e.type === type && e.payload && e.payload.taskId) {
          return { taskId: String(e.payload.taskId), branch: e.payload.branch || null, worktreePath: e.payload.worktreePath || null };
        }
      }
    } catch { /* no link yet */ }
    return null;
  }

  // All next-goal.derived events for a lineage, oldest→newest (across all cycles).
  function lineageNextGoalEvents(lineageId: any) {
    const out: any[] = [];
    try {
      for (const e of runLedgerHarness.ledger.readAll()) {
        if (e && e.type === 'next-goal.derived' && e.payload && String(e.payload.loopLineageId || '') === String(lineageId)) {
          out.push(e);
        }
      }
    } catch { /* ledger read best-effort */ }
    return out;
  }

  // Read the validator's computer-use evidence ARTIFACT (never the trailer prose):
  // `.ace/computer-use/completion.json`. The validator runs in its OWN worktree
  // but reviews the WORKER's tree and may write the artifact in either, so we check
  // both. A missing / failing read yields computerUseEvidence=false → the loop
  // refuses to converge and re-dispatches to obtain real evidence (cap-bounded),
  // never a false pass.
  function readValidatorEvidence(vlink: any, wlink: any, state: any) {
    const fallback = { computerUseEvidence: false, followups: [], proposedNextGoal: '' };
    try {
      const path = require('node:path');
      const validatedHeadSha = (state && (state.validatedHeadSha || (state.validator && state.validator.validatedHeadSha))) || null;
      const roots = [vlink && vlink.worktreePath, wlink && wlink.worktreePath].filter(Boolean);
      if (!roots.length) return fallback;
      let best: any = null;
      for (const root of roots) {
        const completionJsonPath = path.join(String(root), '.ace', 'computer-use', 'completion.json');
        const res = readBehavioralCompletionSafe({ completionJsonPath, validatedHeadSha, requiredIds: [] });
        let parsed = res && res.completion ? res.completion : null;
        if (!parsed) { try { parsed = JSON.parse(require('node:fs').readFileSync(completionJsonPath, 'utf8')); } catch { /* unreadable here — try the next root */ } }
        if (res && res.ok === true) {
          return {
            computerUseEvidence: true,
            followups: parsed && Array.isArray(parsed.followups) ? parsed.followups.filter((f: any) => typeof f === 'string') : [],
            proposedNextGoal: parsed && typeof parsed.proposedNextGoal === 'string' ? parsed.proposedNextGoal : '',
          };
        }
        // Keep any parseable-but-not-ok artifact (its followups still steer the loop).
        if (parsed && !best) best = parsed;
      }
      return {
        computerUseEvidence: false,
        followups: best && Array.isArray(best.followups) ? best.followups.filter((f: any) => typeof f === 'string') : [],
        proposedNextGoal: best && typeof best.proposedNextGoal === 'string' ? best.proposedNextGoal : '',
      };
    } catch { return fallback; }
  }

  // A DONE worker surfaces its gaps via the adversarial validator; a BLOCKED
  // worker's own detail is a clear self-reported followup.
  function workerSelfReport(state: any) {
    const w = state && state.worker;
    if (w && String(w.outcome || '').toUpperCase() === 'BLOCKED' && w.detail) return [String(w.detail)];
    return [];
  }

  // The neuron: at a SETTLED auto-iterate run, decide + (continue) author and
  // dispatch the next cycle, or (terminal) record + notify. Idempotent across
  // reboots: each run's settle yields exactly one next-goal.derived. Never throws
  // into the spine.
  function maybeAdvanceAutonomyLoop(runId: any) {
    if (process.env.ACE_AUTONOMY_LOOP === '0' || !runLedgerHarness || !runId) return; // outer-loop kill (inner spine unaffected)
    const loop = autonomyLoop();
    if (!loop || typeof loop.decideNextCycle !== 'function') return;
    try {
      const { state, decision } = runLedgerHarness.kernel.reconcile(runId);
      const spec = (state && state.spec) || {};
      if (spec.autoIterate !== true) return;
      // Act ONLY at a settled boundary — never mid-flight, never during the inner
      // fixback loop (those are active states the next completion re-enters on).
      const next = String((decision && decision.next) || '').toLowerCase();
      if (next !== 'gate' && next !== 'dispatch_release_goal' && next !== 'blocked' && next !== 'nothing') return;

      const lineageId = typeof loop.lineageIdOf === 'function' ? loop.lineageIdOf(runId, spec) : (spec.loopLineageId || String(runId));
      const lineageEvents = lineageNextGoalEvents(lineageId);
      // Idempotency: this run's settle is processed exactly once (reboot-safe).
      if (lineageEvents.some((e: any) => String(e.payload.parentRunId || '') === String(runId))) return;
      // Owner stop (run loop --stop) or a prior terminal halts the lineage.
      if (lineageEvents.some((e: any) => e.payload && e.payload.stopped === true)) return;
      const priorSignature = lineageEvents.length ? String(lineageEvents[lineageEvents.length - 1].payload.signature || '') : '';

      const vlink = dispatchLinkForRun(runId, 'validator.dispatch.linked');
      const wlink = dispatchLinkForRun(runId, 'worker.dispatch.linked');
      const evidence = readValidatorEvidence(vlink, wlink, state);

      const result = loop.decideNextCycle({
        runId, spec, state, decision,
        computerUseEvidence: evidence.computerUseEvidence,
        validatorFollowups: evidence.followups,
        proposedNextGoal: evidence.proposedNextGoal,
        workerFollowups: workerSelfReport(state),
        priorSignature,
        workerBranch: wlink && wlink.branch,
        workerWorktreePath: wlink && wlink.worktreePath,
      });

      // Durable decision: audit trail + dedup anchor + stop marker + board feed.
      runLedgerHarness.kernel.recordEvent({
        runId,
        type: 'next-goal.derived',
        payload: {
          loopLineageId: lineageId,
          parentRunId: String(runId),
          iteration: result.iteration,
          terminal: result.terminal,
          reason: result.reason,
          signature: result.signature,
          followups: result.followups,
          computerUseEvidence: result.computerUseEvidence,
          proposal: ('no_goal' in result.nextGoal) ? null : { goal: result.nextGoal.goal, agent: result.nextGoal.agent },
          stopped: result.terminal !== 'continue',
        },
      });

      if (result.terminal === 'continue' && result.nextIntent) {
        const nextRunId = runLedgerHarness.submit(result.nextIntent);
        bus.emit('autonomy-loop', { event: 'cycle', lineageId, fromRunId: String(runId), toRunId: nextRunId, iteration: result.iteration + 1, goal: result.nextIntent.goal });
        bus.emitAny({ event: 'autonomy-loop', payload: { event: 'cycle', lineageId, fromRunId: String(runId), toRunId: nextRunId, iteration: result.iteration + 1 } });
        if (nextRunId) driveRun(nextRunId);
      } else {
        // Terminal: converged (awaiting owner merge token) | blocked | cap-hit | no-progress.
        bus.emit('autonomy-loop', { event: result.terminal, lineageId, runId: String(runId), reason: result.reason });
        bus.emitAny({ event: 'autonomy-loop', payload: { event: result.terminal, lineageId, runId: String(runId), reason: result.reason } });
      }
    } catch (e: any) {
      console.warn(`[spine] autonomy loop neuron error for ${runId}: ${(e && e.message) || e}`);
    }
  }

  // Periodic PULL reconcile for in-flight runs. The completion PUSH (the Ring-2
  // observer) depends on an in-memory completion turn; a fire-and-forget worker
  // that finishes after a controller restart loses that turn, so its run is
  // stranded at SYNC_WORKER (board stuck in_progress though the stream shows a
  // DONE trailer). This must stay cheap: the full board projection is rich and
  // expensive on a large ledger, so the poller scans only recent event tails and
  // drives a small bounded batch of plausibly in-flight runs.
  const RUN_RECONCILE_RECENT_MS = Math.max(
    60_000,
    Number(process.env.ACE_RUN_RECONCILE_RECENT_MS || 6 * 60 * 60 * 1000)
  );
  const RUN_RECONCILE_MAX_PER_TICK = Math.max(
    1,
    Number(process.env.ACE_RUN_RECONCILE_MAX_PER_TICK || 5)
  );
  let reconcileCandidatesModule: any;
  try { reconcileCandidatesModule = require('./reconcile-candidates.cjs'); }
  catch { reconcileCandidatesModule = require('./reconcile-candidates.cts'); }
  const { selectReconcileCandidates } = reconcileCandidatesModule;
  let runReconcileTick = 0;

  function recentReconcileRunIds() {
    const rows = new Map<string, { runId: string; lastType: string; lastTs: number; streamId: string }>();
    const events = runLedgerHarness?.ledger?.readAll?.() || [];
    for (const e of Array.isArray(events) ? events : []) {
      const runId = e && e.runId != null ? String(e.runId) : '';
      const type = e && e.type != null ? String(e.type) : '';
      if (!runId || !type) continue;
      const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0;
      const prev = rows.get(runId);
      // Keep the newest dispatch link's streamId: a stalled run appends no
      // events, so LINKED-STREAM liveness (not event recency) is what proves
      // it is still worth reconciling (selection: reconcile-candidates.cts).
      const streamId =
        type.endsWith('.dispatch.linked') && e.payload && e.payload.streamId != null
          ? String(e.payload.streamId)
          : (prev && prev.streamId) || '';
      rows.set(runId, { runId, lastType: type, lastTs: ts, streamId });
    }
    return selectReconcileCandidates([...rows.values()], {
      now: Date.now(),
      recentMs: RUN_RECONCILE_RECENT_MS,
      maxPerTick: RUN_RECONCILE_MAX_PER_TICK,
      tick: runReconcileTick++,
      isStreamLive: (id: any) => {
        const machine = sm.get(id);
        return Boolean(machine && !machine.exited);
      },
    });
  }

  function reconcileInflightRuns() {
    if (!runLedgerHarness) return;
    try {
      for (const runId of recentReconcileRunIds()) driveRun(runId);
    } catch (e: any) {
      console.warn(`[spine] inflight reconcile error: ${(e && e.message) || e}`);
    }
  }
  const RUN_RECONCILE_MS = 30000;
  const runReconcilePoller = setInterval(reconcileInflightRuns, RUN_RECONCILE_MS);
  if (typeof (runReconcilePoller as any).unref === 'function') (runReconcilePoller as any).unref();
  // One sweep shortly after boot so workers that finished while the controller
  // was down (and were adopted from the detached pty-host) heal without waiting a
  // full tick.
  const bootReconcileTimer = setTimeout(reconcileInflightRuns, 8000);
  if (typeof (bootReconcileTimer as any).unref === 'function') (bootReconcileTimer as any).unref();

  // PR fixback watcher — the world→agent feedback edge for FAILING PR checks.
  // The GitHub-side PR validator / CI failing on an open task PR used to just
  // sit (scorecard comment posted, auto-merge disarmed) until the owner opened
  // the agent's tab and asked for a fix. The watcher polls each workspace's
  // open PRs and delivers a bounded fixback prompt into the owning task's own
  // stream (orchestrator.runFixback), so the agent fixes and re-pushes
  // unprompted. When the task belongs to a spine run, the dispatch is also
  // recorded as a fixback.dispatched ledger event so the reconciler's
  // FIXBACK_RETRY_CAP counts these rounds too. Kill: ACE_PR_FIXBACK=0.
  let prFixbackWatcher: any = null;
  try {
    let prFixbackModule: any;
    try { prFixbackModule = require('../pr-fixback-watcher.cjs'); }
    catch { prFixbackModule = require('../pr-fixback-watcher.cts'); }
    prFixbackWatcher = prFixbackModule.createPrFixbackWatcher({
      store: aceStore,
      client: { invoke: (m: string, p: any) => deferredInProcessClient().invoke(m, p) },
      userDataPath,
      // Spine runs close their own review loop (contractual same-stream
      // fixback); the watcher only drives NON-spine tasks so the two automatic
      // dispatchers never race one stream or overshoot the shared round cap.
      // Classification FAILS CLOSED only on genuine indeterminacy: the harness
      // is LAZY, so the predicate initializes it itself (sync + idempotent) —
      // a fresh boot classifies on the first tick instead of throwing forever.
      // With the spine deliberately disabled the watcher drives everything (no
      // spine runs can exist); a harness whose init genuinely failed throws,
      // and the watcher skips that task's tick (detached spine streams from a
      // prior process may still be live — never risk double-dispatch blind).
      skipTask: ({ taskId }: any) => {
        if (String(process.env.ACE_RUN_LEDGER || '') === '0') return false;
        if (!ensureRunLedgerHarness()) {
          throw new Error('run-ledger harness unavailable — cannot classify task ownership');
        }
        return !!resolveSpineRunId(taskId, null);
      },
      onDispatched: ({ taskId, streamId, prNumber, prUrl, headSha, attempts }: any) => {
        const runId = resolveSpineRunId(taskId, streamId);
        if (!runId || !runLedgerHarness) return;
        runLedgerHarness.ledger.append({
          runId,
          type: 'fixback.dispatched',
          payload: { source: 'pr-fixback-watcher', prNumber, prUrl, headSha, attempts, taskId, streamId },
        });
      },
    });
    prFixbackWatcher.start();
  } catch (err: any) {
    console.warn('[ace] pr-fixback watcher disabled: ' + (err?.message || err));
  }
  let sm: any;
  const transcripts = createTranscriptController({
    userDataPath: userDataPath || process.cwd(),
    db: transcriptDb,
    store: transcriptStore,
    bus,
    profiles,
    onSessionLinked: ({ streamId, sessionId }: any) => {
      if (sessionId) {
        const previousSessionId = aceStore.resolveStreamOwner?.(streamId)?.sessionId || null;
        aceStore.writeSessionIdForStream?.(streamId, sessionId);
        return () => aceStore.writeSessionIdForStream?.(streamId, previousSessionId, 'resume-rollback');
      }
    },
    // matchBySessionId profiles (claude): the owner row already holds the
    // session id Ace minted at spawn, so the linker can claim exactly the
    // file named after it — resolved lazily because the id is written to the
    // DB just after the PTY starts.
    resolveExpectedSessionId: (streamId: any) => {
      try {
        return aceStore.resolveStreamOwner?.(streamId)?.sessionId || null;
      } catch {
        return null;
      }
    },
    canSwitchSession: (streamId: any, sessionId: any) => {
      try {
        return aceStore.canBindSessionIdForStream?.(streamId, sessionId) !== false;
      } catch {
        return false;
      }
    },
    resolveSelectedSessionId: (streamId: any) => {
      try {
        return aceStore.resolveLiveClaudeSessionIdForStream?.(streamId) || null;
      } catch {
        return null;
      }
    },
    onResumeSwitchSettled: ({ streamId }: any) => {
      resumePickerStreams.delete(streamId);
      rawTerminalInput.delete(streamId);
      terminalInputEndedWithCr.delete(streamId);
    },
    resolveExpectedSessionFile: (streamId: any, agent: any) => {
      try {
        const owner = aceStore.resolveStreamOwner?.(streamId);
        const sessionId = owner?.sessionId || null;
        const provider = getProvider(agent || owner?.agent);
        const sessionFile = resolveSessionFile(provider, owner?.cwd, sessionId);
        if (!sessionId || !sessionFile || sessionFileState(sessionFile) !== 'present') return null;
        return { sessionId, sessionFile, cwd: owner?.cwd || null };
      } catch {
        return null;
      }
    },
    resolveResumeSessionDir: (streamId: any, agent: any) => {
      try {
        const owner = aceStore.resolveStreamOwner?.(streamId);
        const provider = getProvider(agent || owner?.agent);
        const sessionFile = resolveSessionFile(provider, owner?.cwd, owner?.sessionId || null);
        return sessionFile ? path.dirname(sessionFile) : null;
      } catch {
        return null;
      }
    },
    shouldPruneTranscriptAlias: ({ aliasStreamId, streamId }: any) => {
      const aliasState = sm?.get(aliasStreamId)?.state || null;
      const ownerState = sm?.get(streamId)?.state || null;
      const aliasIsSettled =
        aliasState === 'awaiting-input' ||
        aliasState === 'turn-complete' ||
        aliasState === 'awaiting-approval' ||
        aliasState === 'busy';
      if (aliasIsSettled && ownerState === 'booting') return false;
      return true;
    },
  });
  sm = createStateMachine({
    screen,
    emit: (event: any, payload: any) => {
      if (event === 'state-change') {
        const pending = pendingHermesSubmissions.get(payload?.streamId);
        const looksDropped =
          pending &&
          pending.compressionSeen &&
          looksLikeHermesCompressionDroppedPrompt(payload.streamId, pending);
        const shouldReplayCompressionTurn =
          pending &&
          !pending.recovering &&
          pending.compressionSeen &&
          pending.attempts < 1 &&
          (
            payload?.to === 'awaiting-input' ||
            payload?.to === 'interrupted' ||
            payload?.to === 'turn-complete'
          );
        if (shouldReplayCompressionTurn && looksDropped) {
          maybeRecoverHermesCompressionReady(payload.streamId);
        } else if (
          pending &&
          !pending.recovering &&
          (
            payload?.to === 'awaiting-input' ||
            payload?.to === 'turn-complete' ||
            payload?.to === 'interrupted' ||
            payload?.to === 'error'
          )
        ) {
          pendingHermesSubmissions.delete(payload.streamId);
        }
      }
      bus.emit(event, payload);
      bus.emitAny({ event, payload });
    },
  });
  const input = createInput({
    writeTerminalInput: async (streamId: any, data: any) => {
      const res = await aceStore.writeTerminalInput({ streamId, data });
      if (!res || res.ok === false) {
        throw new Error(`write failed for stream ${streamId}`);
      }
    },
    profileFor: (streamId: any) => tabs.get(streamId)?.profile || profiles.get(DEFAULT_PROFILE_ID),
  });
  const recorders = createRecorders();
  const completionInbox = createCompletionInbox();
  // Store residency: an explicit env pin always wins (main.cts pins both into
  // userData); otherwise key the stores under THIS controller's userDataPath.
  // The bare home default (~/.ace/*) is only the last resort for env-less,
  // userData-less embedders — it is what let ad-hoc controller tests leak
  // fixture rows into the operator's real ~/.ace/child-registry.json and
  // ~/.ace/follow-ups.json.
  const childRegistryPath = process.env.ACE_CHILD_REGISTRY_PATH
    ? process.env.ACE_CHILD_REGISTRY_PATH
    : userDataPath
      ? path.join(userDataPath, 'child-registry.json')
      : defaultStorePath();
  const followUpStorePath = process.env.ACE_FOLLOW_UP_STORE_PATH
    ? process.env.ACE_FOLLOW_UP_STORE_PATH
    : userDataPath
      ? path.join(userDataPath, 'follow-ups.json')
      : followUpSupervisor.defaultFollowUpStorePath();
  const childRegistry = createChildRegistry({ db: createFileDb(childRegistryPath) });
  const followUpStore = followUpSupervisor.createFollowUpStore({
    filePath: followUpStorePath,
  });

  const waiters = new Map();
  const evalScheduled = new Set();
  const trailingEvalTimers = new Map();
  const TRAILING_QUIET_MS = 550;
  // Trailing settle-eval delay: past BOTH state-machine settle windows (quiet
  // AND min-turn) plus a margin, so the follow-up eval always lands after the
  // reconcile gate can open. Env-tuned in tests to avoid multi-second sleeps.
  const settleEnv = (name: string) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : 2500;
  };
  const SETTLE_EVAL_MS = Math.max(300, Math.max(settleEnv('ACE_SM_QUIET_MS'), settleEnv('ACE_SM_MIN_TURN_MS')) + 100);
  const HERMES_COMPRESSION_EXIT_RE = /\b(?:preflight compression|compacting context|compact(?:ing|ion)|compress(?:ing|ion))\b/i;
  const pendingHermesSubmissions = new Map();

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function contextForStream(streamId: any) {
    try {
      if (typeof aceStore.getContextForStream === 'function') {
        const ctx = aceStore.getContextForStream({ streamId });
        if (ctx) return ctx;
      }
    } catch {}
    const owner = safeResolveOwner(streamId) || {};
    const tab = tabs.get(streamId) || {};
    return {
      streamId,
      agent: tab.agent || owner.agent || null,
      cwd: tab.cwd || owner.cwd || null,
      workspaceId: tab.workspaceId || owner.project?.id || null,
      taskId: null,
      branch: null,
      worktreePath: tab.cwd || owner.cwd || null,
    };
  }

  function markCompletionTurn(streamId: any) {
    completionInbox.beginTurn(streamId, screen.scrollback(streamId, 4000));
  }

  function observeCompletions(streamId: any) {
    const m = sm.get(streamId);
    const created = completionInbox.observeReady({
      streamId,
      state: m?.state,
      text: screen.scrollback(streamId, 4000),
      context: contextForStream(streamId),
      allowSyntheticTurn: m?.state === 'turn-complete' && m?.lastCompletionReason === 'trailer-reconciled',
      excludeTrailerKeys:
        typeof sm.echoTrailerKeysFor === 'function' ? sm.echoTrailerKeysFor(streamId) : [],
    });
    // TUI repaints erase the trailer from the rendered scrollback: record the
    // raw-ring trailer the reconcile proved, only for a spine run WAITING on
    // this exact stream. Consume only on success or DEFINITIVE ineligibility —
    // a transient reconcile/ledger failure must keep the trailer for retry.
    if (
      !created.length &&
      m?.state === 'turn-complete' &&
      m?.lastCompletionReason === 'trailer-reconciled' &&
      m?.lastReconciledTrailer
    ) {
      let consume = false;
      try {
        const context = contextForStream(streamId);
        const harness = ensureRunLedgerHarness();
        const spineRunId = resolveSpineRunId(context.taskId, streamId);
        const decision = runLedgerRawTrailerAdmission
          ? runLedgerRawTrailerAdmission({
              harnessAvailable: Boolean(harness),
              ledgerEvents: harness && !spineRunId ? harness.ledger.readAll() || [] : [],
              spineRunId,
              reconciledState: harness && spineRunId ? harness.kernel.reconcile(spineRunId)?.state : null,
              runEvents: harness && spineRunId ? harness.ledger.readRun(spineRunId) || [] : [],
              streamId,
            })
          : 'retry';
        if (decision === 'record') {
          const record = completionInbox.recordDirect({
            streamId,
            state: m.state,
            trailer: m.lastReconciledTrailer,
            context,
          });
          if (record) {
            (record as any).rawFallback = true;
            created.push(record);
          } else {
            consume = true; // per-turn dedupe already recorded this trailer
          }
        } else if (decision === 'consume') {
          consume = true;
        }
        // 'retry': indeterminate — keep the trailer for the next evaluate.
      } catch (e: any) {
        console.warn(`[ace-control] raw-ring completion fallback failed: ${(e && e.message) || e}`);
      }
      if (!created.length && consume) sm.markTrailerEmitted(streamId);
    }
    // Rendered-path records consume immediately; a raw-fallback record
    // consumes only after its ledger mirror succeeds (see the loop below).
    if (created.length && !created.some((r: any) => r.rawFallback)) sm.markTrailerEmitted(streamId);
    for (const record of created) {
      try {
        if (record.taskId) {
          const registryRow = childRegistry.recordWorkerCompletion(record);
          record.registryRow = registryRow;
          record.waveId = record.waveId || registryRow?.waveId || null;
          record.laneId = record.laneId || registryRow?.laneId || null;
          if (record.waveId) {
            record.waveJoin = evaluateWaveJoin({
              rows: childRegistry.list(),
              waveId: record.waveId,
              expectedLaneIds: record.expectedLaneIds,
            });
          }
          // (Legacy mission-feature completion sync retired — the run-ledger
          // Ring-2 mirror below is the single completion sink now.)
        }
      } catch {}
      try {
        const result = followUpStore.upsert({
          row: {
            ...record,
            laneStatus: record.kind,
          },
          now: record.timestamp || Date.now(),
          source: 'completion',
        });
        record.followUp = result.record;
        if (result.ping) {
          record.followUpPing = result.ping;
          bus.emit('follow-up-ping', result.ping);
          bus.emitAny({ event: 'follow-up-ping', payload: result.ping });
        }
      } catch {}
      bus.emit('worker-completion', record);
      bus.emitAny({ event: 'worker-completion', payload: record });
      // Ring 2: mirror this completion into the run-ledger (additive, guarded —
      // a ledger failure must never disturb the live completion flow).
      if (runLedgerHarness && runLedgerFromCompletion) {
        try {
          const spineRunId = resolveSpineRunId(record.taskId, record.streamId);
          // AUTO-COLLECTION: when the agent reported no telemetry (the common
          // case — nothing in production writes record.telemetry), synthesize
          // the descriptive facts the spine already knows for free: the agent
          // codename and durationMs = completion ts − dispatch.linked ts. Zero
          // agent cooperation; descriptive only (never feeds decisions).
          try {
            if (runLedgerAutoTelemetry) {
              const lookupRunId = spineRunId || record.taskId || null;
              const runEvents = lookupRunId ? runLedgerHarness.ledger.readRun(lookupRunId) : [];
              const auto = runLedgerAutoTelemetry(record, runEvents);
              if (auto) record.telemetry = auto;
            }
          } catch (e: any) {
            console.warn(`[ace-control] completion auto-telemetry failed: ${(e && e.message) || e}`);
          }
          const evt = runLedgerFromCompletion(record, spineRunId);
          if (evt) {
            runLedgerHarness.kernel.recordEvent(evt);
            // Durable write landed — nothing below may roll it back.
            (record as any).ledgerMirrored = true;
            try {
              // Ring 1 (the pulse): advance the autonomy loop off this completion.
              if (evt.runId) driveRun(evt.runId);
            } catch (e: any) {
              console.warn(`[ace-control] post-mirror drive failed: ${(e && e.message) || e}`);
            }
          } else {
            // Maps to no ledger event (never will) — retrying cannot succeed.
            (record as any).ledgerMirrored = true;
          }
        } catch (e: any) {
          // A silently dropped worker.completed strands the run — leave a trace.
          if ((record as any).ledgerMirrored !== true) (record as any).ledgerMirrored = false;
          console.warn(`[ace-control] run-ledger completion mirror failed: ${(e && e.message) || e}`);
        }
      }
    }
    // A raw-fallback record consumes the trailer ONLY on EXPLICIT mirror
    // success; anything else retracts so the syncWorker pull (the durable,
    // poller-driven retry) or the next evaluate can retry.
    for (const record of created) {
      if (!(record as any).rawFallback) continue;
      if ((record as any).ledgerMirrored === true) {
        sm.markTrailerEmitted(streamId);
      } else {
        try { completionInbox.retract(record.id); } catch { /* keep going */ }
      }
    }
  }

  function scheduleEvaluate(streamId: any) {
    if (!evalScheduled.has(streamId)) {
      evalScheduled.add(streamId);
      setImmediate(async () => {
        evalScheduled.delete(streamId);
        await screen.flush(streamId);
        sm.evaluate(streamId);
        observeCompletions(streamId);
        runWaiters(streamId);
      });
    }
    // Trailing re-eval after the PTY goes quiet — the state machine's
    // byte-activity gate only clears once no data has arrived for a while.
    // Without this timer, a stream that stopped emitting would never get
    // a fresh evaluation to transition to turn-complete / awaiting-input.
    // We schedule the timer past the state machine's MIN_TURN_DURATION
    // grace period when an open turn is in flight, so an evaluate fires
    // right after the grace window closes (otherwise turn-complete sits
    // forever waiting for a byte that never comes).
    const existing = trailingEvalTimers.get(streamId);
    if (existing) clearTimeout(existing);
    const m = sm.get(streamId);
    let delay = TRAILING_QUIET_MS;
    if (m && m.submittedAt > 0) {
      // Match the state machine's two grace constraints — wait past
      // both MIN_TURN_DURATION_MS (since submit) and
      // POST_ACTIVITY_QUIET_MS (since last byte) before re-evaluating.
      // Add a small margin so the eval runs *after* grace has lapsed.
      const sinceSubmit = Date.now() - m.submittedAt;
      const remainingMin = SETTLE_EVAL_MS - sinceSubmit;
      if (remainingMin > delay) delay = remainingMin;
      if (SETTLE_EVAL_MS > delay) delay = SETTLE_EVAL_MS;
    }
    trailingEvalTimers.set(streamId, setTimeout(async () => {
      trailingEvalTimers.delete(streamId);
      await screen.flush(streamId);
      sm.evaluate(streamId);
      observeCompletions(streamId);
      runWaiters(streamId);
      // One bounded follow-up look after the reconcile settle window (2.5s)
      // fully lapses — it can outlast this first quiet tick.
      const after = sm.get(streamId);
      const unsettled = after && (after.state === 'busy' || after.state === 'booting');
      const pendingTrailer =
        typeof sm.hasPendingRawTrailer === 'function' && sm.hasPendingRawTrailer(streamId);
      if (after && (unsettled || pendingTrailer) && !trailingEvalTimers.has(streamId)) {
        trailingEvalTimers.set(streamId, setTimeout(async () => {
          trailingEvalTimers.delete(streamId);
          await screen.flush(streamId);
          sm.evaluate(streamId);
          observeCompletions(streamId);
          runWaiters(streamId);
        }, SETTLE_EVAL_MS + 100));
      }
    }, delay));
  }

  function trackTab(streamId: any, extra: any = {}) {
    if (tabs.has(streamId)) {
      Object.assign(tabs.get(streamId), extra);
      return tabs.get(streamId);
    }
    const owner = safeResolveOwner(streamId);
    const agentId = extra.agent || owner?.agent || null;
    const profile = profileForAgent(profiles, agentId);
    // Workspace id comes from the resolved stream owner (conversation/
    // variant rows know their project). Hermes identity lanes share an
    // agent across Rook/King so workspaceId is the only safe per-stream
    // discriminator the linker can use to pick the correct session file.
    const workspaceId = extra.workspaceId || owner?.project?.id || null;
    const tab = {
      streamId,
      agent: agentId,
      cwd: extra.cwd || owner?.cwd || null,
      workspaceId,
      profile,
      label: extra.label || null,
      openedAt: Date.now(),
      ...extra,
    };
    tabs.set(streamId, tab);
    maybeAdoptHermesCompressionSubmission(streamId, tab);
    screen.ensure(streamId);
    sm.ensure(streamId, profile);
    completionInbox.ensureStream(streamId, screen.scrollback(streamId, 4000));
    bus.emit('tab-opened', { streamId, agent: tab.agent, cwd: tab.cwd });
    bus.emitAny({ event: 'tab-opened', payload: { streamId, agent: tab.agent, cwd: tab.cwd } });
    if ((tab.profile as any)?.transcript && tab.agent) {
      transcripts
        .linkPending(streamId, {
          agent: tab.agent,
          cwd: tab.cwd,
          workspaceId: tab.workspaceId,
          spawnedAt: tab.openedAt,
        })
        .catch(() => {});
    }
    return tab;
  }

  function safeResolveOwner(streamId: any) {
    try {
      return aceStore.resolveStreamOwner(streamId);
    } catch {
      return null;
    }
  }

  function cleanCommunicationText(value: any) {
    const text = String(value == null ? '' : value).trim();
    return text || null;
  }

  function normalizeCommunicationCaller(caller: any) {
    const streamId = cleanCommunicationText(caller?.streamId);
    if (!streamId) return null;
    return {
      streamId,
      label: cleanCommunicationText(caller.label) || cleanCommunicationText(caller.identity),
      agent: cleanCommunicationText(caller.agent),
      command: cleanCommunicationText(caller.command),
    };
  }

  function peerForStream(streamId: any, fallback: any = {}) {
    const tab = tabs.get(streamId);
    const owner = safeResolveOwner(streamId) || {};
    return {
      streamId,
      label: cleanCommunicationText(tab?.label) || cleanCommunicationText(fallback.label) || cleanCommunicationText(owner.label || owner.title),
      agent: cleanCommunicationText(tab?.agent) || cleanCommunicationText(fallback.agent) || cleanCommunicationText(owner.agent),
    };
  }

  function appendCommunicationSent({ caller, targetStreamId, command, body }: any) {
    const source = normalizeCommunicationCaller(caller);
    if (!source || !targetStreamId) return;
    const targetPeer = peerForStream(targetStreamId);
    try {
      transcripts.appendCommunication(source.streamId, {
        direction: 'sent',
        command: command || source.command,
        body,
        peer: targetPeer,
      });
    } catch {}
    if (source.streamId === targetStreamId) return;
    try {
      transcripts.appendCommunication(targetStreamId, {
        direction: 'received',
        command: command || source.command,
        body,
        peer: source,
      });
    } catch {}
  }

  function appendCommunicationReply({ caller, targetStreamId, command, body }: any) {
    const source = normalizeCommunicationCaller(caller);
    if (!source || !targetStreamId) return;
    try {
      transcripts.appendCommunication(source.streamId, {
        direction: 'received',
        command: command || source.command,
        body,
        peer: peerForStream(targetStreamId),
      });
    } catch {}
  }

  function closeTab(streamId: any) {
    if (!tabs.has(streamId)) return;
    tabs.delete(streamId);
    screen.dispose(streamId);
    sm.dispose(streamId);
    recorders.stop(streamId);
    transcripts.shutdownStream(streamId).catch(() => {});
    const list = waiters.get(streamId);
    if (list) {
      for (const w of list) w.reject(new Error('stream closed'));
      waiters.delete(streamId);
    }
    bus.emit('tab-closed', { streamId });
    bus.emitAny({ event: 'tab-closed', payload: { streamId } });
  }

  const unsubs = [
    aceStore.onPtyData(({ id, chunk }: any) => {
      if (!id || typeof chunk !== 'string') return;
      if (!tabs.has(id)) trackTab(id);
      screen.write(id, chunk);
      markHermesCompressionSeen(id, chunk);
      recorders.write(id, { type: 'data', chunk });
      scheduleEvaluate(id);
    }),
    ...(typeof aceStore.onPtyOpened === 'function' ? [
      aceStore.onPtyOpened(({ id, agent, cwd }: any) => {
        if (!id) return;
        trackTab(id, { agent, cwd });
      }),
    ] : []),
    aceStore.onPtyExit(({ id, code }: any) => {
      if (!tabs.has(id)) return;
      recorders.write(id, { type: 'exit', code });
      if (maybeRecoverHermesCompressionExit(id, code)) return;
      sm.markExit(id, code);
      closeTab(id);
    }),
  ];

  function rememberHermesSubmission(streamId: any, text: any) {
    const tab = tabs.get(streamId);
    if (tab?.agent !== 'hermes' && tab?.profile?.id !== 'hermes') return;
    const body = typeof text === 'string' ? text : '';
    if (!body.trim()) return;
    const previous = pendingHermesSubmissions.get(streamId);
    pendingHermesSubmissions.set(streamId, {
      text: body,
      attempts: previous?.attempts || 0,
      recovering: false,
      compressionSeen: previous?.compressionSeen || false,
      compressionSeenAt: previous?.compressionSeenAt || 0,
      context: hermesSubmissionContext(streamId, tab),
      submittedAt: Date.now(),
    });
  }

  function hermesSubmissionContext(streamId: any, tab: any = tabs.get(streamId)) {
    const owner = safeResolveOwner(streamId) || {};
    return {
      streamId,
      cwd: tab?.cwd || owner.cwd || null,
      workspaceId: tab?.workspaceId || owner.project?.id || null,
      label: tab?.label || owner.label || owner.title || null,
    };
  }

  function sameHermesSubmissionContext(pending: any, streamId: any, tab: any) {
    const previous = pending?.context || {};
    const next = hermesSubmissionContext(streamId, tab);
    if (previous.cwd && next.cwd) return previous.cwd === next.cwd;
    if (previous.workspaceId && next.workspaceId && previous.workspaceId === next.workspaceId) {
      return Boolean(previous.label && next.label && previous.label === next.label);
    }
    return false;
  }

  function maybeAdoptHermesCompressionSubmission(streamId: any, tab: any) {
    if (!tab || (tab.agent !== 'hermes' && tab.profile?.id !== 'hermes')) return false;
    if (pendingHermesSubmissions.has(streamId)) return false;
    for (const [sourceStreamId, pending] of pendingHermesSubmissions) {
      if (sourceStreamId === streamId) continue;
      if (!pending?.text || !pending.compressionSeen || pending.redirectStreamId) continue;
      if (!sameHermesSubmissionContext(pending, streamId, tab)) continue;

      const redirected = {
        ...pending,
        redirectStreamId: streamId,
        recovering: true,
      };
      pendingHermesSubmissions.set(sourceStreamId, redirected);
      const adopted = {
        ...pending,
        attempts: Math.max(Number(pending.attempts) || 0, 1),
        recovering: true,
        compressionSeen: false,
        compressionSeenAt: 0,
        redirectedFromStreamId: sourceStreamId,
        redirectStreamId: undefined,
        context: hermesSubmissionContext(streamId, tab),
        submittedAt: Date.now(),
      };
      pendingHermesSubmissions.set(streamId, adopted);
      recoverHermesCompressionReady(streamId, adopted).catch((err: any) => {
        pendingHermesSubmissions.delete(streamId);
        try {
          screen.write(streamId, `\r\n[ace] Hermes compression replay failed: ${err?.message || err}\r\n`);
        } catch {}
        sm.markExit(streamId, -1);
        closeTab(streamId);
      });
      return true;
    }
    return false;
  }

  function forgetHermesSubmission(streamId: any, text: any) {
    const pending = pendingHermesSubmissions.get(streamId);
    if (!pending) return;
    if (typeof text === 'string' && pending.text !== text) return;
    pendingHermesSubmissions.delete(streamId);
  }

  function markHermesCompressionSeen(streamId: any, chunk: any) {
    const tab = tabs.get(streamId);
    if (!tab || (tab.agent !== 'hermes' && tab.profile?.id !== 'hermes')) return;
    const pending = pendingHermesSubmissions.get(streamId);
    if (!pending || pending.recovering) return;
    if (!HERMES_COMPRESSION_EXIT_RE.test(String(chunk || ''))) return;
    pending.compressionSeen = true;
    pending.compressionSeenAt = Date.now();
    pendingHermesSubmissions.set(streamId, pending);
  }

  function lastHermesCompressionMarkerIndex(text: any) {
    const re = /\b(?:preflight compression|compacting context|compact(?:ing|ion)|compress(?:ing|ion))\b/ig;
    let last = -1;
    for (const match of String(text || '').matchAll(re)) {
      if (typeof match.index === 'number') last = match.index;
    }
    return last;
  }

  function stripTerminalEscapes(text: any) {
    return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  }

  function hasHermesPostCompressionActivity(streamId: any, pending: any) {
    const recent = screen.scrollback(streamId, 4000);
    const compressionIdx = lastHermesCompressionMarkerIndex(recent);
    if (compressionIdx < 0) return false;
    const afterCompression = stripTerminalEscapes(recent.slice(compressionIdx));
    const lines = afterCompression
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.some((line) => {
      if (HERMES_COMPRESSION_EXIT_RE.test(line)) return false;
      if (/^Welcome to Hermes Agent!?$/i.test(line)) return false;
      if (/^Initializing agent/i.test(line)) return false;
      if (/^❯\s*$/.test(line)) return false;
      if (/^[─\-_= ]+$/.test(line)) return false;
      if (pending?.text && line === pending.text) return false;
      return true;
    });
  }

  function looksLikeHermesCompressionDroppedPrompt(streamId: any, pending: any) {
    if (hasHermesPostCompressionActivity(streamId, pending)) return false;
    const postCompression = stripTerminalEscapes(screen.scrollback(streamId, 4000));
    const compressionIdx = lastHermesCompressionMarkerIndex(postCompression);
    if (compressionIdx >= 0) {
      const afterCompression = postCompression.slice(compressionIdx);
      if (/❯\s*$/.test(afterCompression.trim())) {
        return !afterCompression.includes(pending.text);
      }
    }
    const recent = screen.scrollback(streamId, 160);
    const bannerIdx = recent.lastIndexOf('Welcome to Hermes Agent');
    if (bannerIdx < 0) return false;
    const afterBanner = recent.slice(bannerIdx);
    return !afterBanner.includes(pending.text);
  }

  function maybeRecoverHermesCompressionReady(streamId: any) {
    const tab = tabs.get(streamId);
    if (!tab || (tab.agent !== 'hermes' && tab.profile?.id !== 'hermes')) return false;
    const pending = pendingHermesSubmissions.get(streamId);
    if (!pending || pending.recovering || !pending.compressionSeen || pending.attempts >= 1) return false;
    pending.recovering = true;
    pending.attempts += 1;
    pendingHermesSubmissions.set(streamId, pending);
    recoverHermesCompressionReady(streamId, pending).catch((err: any) => {
      if (pending.redirectStreamId) return;
      pendingHermesSubmissions.delete(streamId);
      try {
        screen.write(streamId, `\r\n[ace] Hermes compression replay failed: ${err?.message || err}\r\n`);
      } catch {}
      sm.markExit(streamId, -1);
      closeTab(streamId);
    });
    return true;
  }

  function maybeRecoverHermesCompressionExit(streamId: any, code: any) {
    const tab = tabs.get(streamId);
    if (!tab || (tab.agent !== 'hermes' && tab.profile?.id !== 'hermes')) return false;
    const pending = pendingHermesSubmissions.get(streamId);
    if (!pending || pending.recovering || pending.attempts >= 1) return false;
    if (!(code === 0 || code === null || typeof code === 'undefined')) return false;
    const recent = screen.scrollback(streamId, 120);
    if (!HERMES_COMPRESSION_EXIT_RE.test(recent)) return false;
    pending.recovering = true;
    pending.attempts += 1;
    pendingHermesSubmissions.set(streamId, pending);
    recoverHermesCompressionExit(streamId, tab, pending).catch((err: any) => {
      const message = String(err?.message || err || '');
      if (/stream closed|unknown stream|write failed/i.test(message)) {
        pending.recoveryError = message;
        pendingHermesSubmissions.set(streamId, pending);
      } else {
        pendingHermesSubmissions.delete(streamId);
      }
      try {
        screen.write(streamId, `\r\n[ace] Hermes compression recovery failed: ${err?.message || err}\r\n`);
      } catch {}
      sm.markExit(streamId, code);
      closeTab(streamId);
    });
    return true;
  }

  async function recoverHermesCompressionExit(streamId: any, tab: any, pending: any) {
    sm.dispose(streamId);
    sm.ensure(streamId, tab.profile);
    await aceStore.ensureStreamStarted({ streamId, cols: 120, rows: 40 });
    trackTab(streamId, {
      agent: tab.agent,
      cwd: tab.cwd,
      workspaceId: tab.workspaceId,
      label: tab.label,
    });
    await waitFor(streamId, { awaitingInput: true }, { timeoutMs: 45_000 });
    pending.compressionSeen = false;
    pending.compressionSeenAt = 0;
    await pasteAndSubmit(streamId, pending.text);
    pending.recovering = false;
    pending.submittedAt = Date.now();
    pendingHermesSubmissions.set(streamId, pending);
  }

  async function recoverHermesCompressionReady(streamId: any, pending: any) {
    await waitFor(streamId, { awaitingInput: true }, { timeoutMs: 45_000 });
    pending.compressionSeen = false;
    pending.compressionSeenAt = 0;
    await pasteAndSubmit(streamId, pending.text);
    pending.recovering = false;
    pending.submittedAt = Date.now();
    pendingHermesSubmissions.set(streamId, pending);
  }

  async function waitForHermesRedirectStream(streamId: any, timeoutMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const pending = pendingHermesSubmissions.get(streamId);
      const redirected = pending?.redirectStreamId;
      if (redirected && tabs.has(redirected)) return redirected;
      await sleep(100);
    }
    return null;
  }

  function runWaiters(streamId: any) {
    const list = waiters.get(streamId);
    if (!list || list.length === 0) return;
    const m = sm.get(streamId);
    const now = Date.now();
    const remaining = [];
    for (const w of list) {
      if (w.predicate({ state: m?.state, screen, streamId, lastActivityMs: screen.lastActivityMs(streamId), now })) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve({ state: m?.state, elapsedMs: now - w.startedAt });
      } else {
        remaining.push(w);
      }
    }
    if (remaining.length) waiters.set(streamId, remaining);
    else waiters.delete(streamId);
  }

  function waitFor(streamId: any, predicateSpec: any, { timeoutMs }: any = {}) {
    return new Promise((resolve, reject) => {
      const predicate = compilePredicate(predicateSpec);
      // Fast path: already satisfies.
      const m = sm.get(streamId);
      if (predicate({ state: m?.state, screen, streamId, lastActivityMs: screen.lastActivityMs(streamId), now: Date.now() })) {
        resolve({ state: m?.state, elapsedMs: 0 });
        return;
      }
      const limit = Math.max(1, timeoutMs | 0 || DEFAULT_ASK_TIMEOUT);
      const entry = {
        predicate,
        startedAt: Date.now(),
        resolve,
        reject,
        timer: setTimeout(() => {
          const arr = waiters.get(streamId) || [];
          const i = arr.indexOf(entry);
          if (i >= 0) arr.splice(i, 1);
          reject(new Error(`wait timed out after ${limit}ms (state=${sm.get(streamId)?.state})`));
        }, limit),
      };
      const arr = waiters.get(streamId) || [];
      arr.push(entry);
      waiters.set(streamId, arr);
      // quiet-for needs a periodic check; schedule a tick
      if (predicateSpec.quietForMs) startQuietPoller(streamId);
    });
  }

  const quietPollers = new Map();
  function startQuietPoller(streamId: any) {
    if (quietPollers.has(streamId)) return;
    const id = setInterval(() => {
      if (!waiters.get(streamId)) {
        clearInterval(id);
        quietPollers.delete(streamId);
        return;
      }
      runWaiters(streamId);
    }, 150);
    quietPollers.set(streamId, id);
  }

  function compilePredicate(spec: any): any {
    if (spec.state) {
      return ({ state }: any) => state === spec.state;
    }
    if (spec.turnComplete) {
      return ({ state }: any) => state === 'turn-complete';
    }
    if (spec.awaitingInput) {
      // Both states mean "Ace is ready to accept a new prompt" from the
      // caller's point of view. Distinguishing them only matters for
      // post-turn analysis, which the `--turn-complete` predicate covers.
      return ({ state }: any) => state === 'awaiting-input' || state === 'turn-complete';
    }
    if (spec.awaitingApproval) {
      return ({ state }: any) => state === 'awaiting-approval';
    }
    if (spec.awaitingInputOrApproval) {
      // Ready to accept a prompt OR sitting at an approval gate. The dispatch
      // path waits on this so a Claude worker that boots into `awaiting-approval`
      // (trust/permission prompt) is detected and cleared instead of hanging a
      // bare awaitingInput wait until timeout (the empty-turn dispatch bug).
      return ({ state }: any) =>
        state === 'awaiting-input' || state === 'turn-complete' || state === 'awaiting-approval';
    }
    if (spec.pattern) {
      const rx = spec.pattern instanceof RegExp
        ? spec.pattern
        : new RegExp(spec.pattern, 'm');
      return ({ screen: s, streamId }: any) => rx.test(s.scrollback(streamId, 120));
    }
    if (spec.quietForMs) {
      const ms = spec.quietForMs;
      return ({ lastActivityMs, now }: any) => now - lastActivityMs >= ms;
    }
    throw new Error('waitFor requires one of: state, turnComplete, awaitingInput, awaitingApproval, awaitingInputOrApproval, pattern, quietForMs');
  }

  function catalogFromState() {
    const out: any[] = [];
    let state;
    try { state = aceStore.getState(); } catch { return out; }
    if (!state || !Array.isArray(state.workspaces)) return out;
    for (const ws of state.workspaces) {
      for (const task of ws.tasks || []) {
        for (const conv of task.conversations || []) {
          out.push({
            streamId: `conversation:${conv.id}`,
            agent: conv.agent || null,
            cwd: null,
            taskId: task.id,
            workspaceId: ws.id,
            label: conv.title || null,
          });
        }
        for (const wt of task.worktrees || []) {
          for (const v of wt.variants || []) {
            out.push({
              streamId: `variant:${v.id}`,
              agent: v.agent || null,
              cwd: wt.path || null,
              taskId: task.id,
              workspaceId: ws.id,
              label: v.name || null,
            });
          }
        }
      }
    }
    return out;
  }

  function humanizeIdentityLabel(value: any) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return raw
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function streamDisplayLabel(streamId: any, tab: any, linked: any = null) {
    const explicit = String(tab?.label || linked?.label || '').trim();
    if (explicit) return explicit;
    const agent = String(tab?.agent || linked?.agent || '').trim().toLowerCase();
    if (agent !== 'hermes') return null;
    const ctx = contextForStream(streamId);
    return (
      String(ctx?.agentLaneLabel || '').trim() ||
      humanizeIdentityLabel(ctx?.personalIdentity) ||
      null
    );
  }

  async function listStreams() {
    const out = [];
    const seen = new Set();
    // Build a streamId -> {taskId, workspaceId} map from DB state so live
    // streams can be tagged with the same linkage as dormant ones.
    const catalogByStream = new Map();
    for (const entry of catalogFromState()) {
      catalogByStream.set(entry.streamId, entry);
    }
    for (const [streamId, tab] of tabs) {
      const m = sm.get(streamId);
      const linked = catalogByStream.get(streamId);
      seen.add(streamId);
      out.push({
        streamId,
        agent: tab.agent,
        cwd: tab.cwd,
        label: streamDisplayLabel(streamId, tab, linked),
        taskId: linked?.taskId,
        workspaceId: linked?.workspaceId,
        state: m?.state || 'unknown',
        profile: tab.profile?.id || DEFAULT_PROFILE_ID,
        live: true,
      });
    }
    for (const entry of catalogFromState()) {
      if (seen.has(entry.streamId)) continue;
      const profile = profileForAgent(profiles, entry.agent);
      out.push({
        streamId: entry.streamId,
        agent: entry.agent,
        cwd: entry.cwd,
        label: entry.label,
        taskId: entry.taskId,
        workspaceId: entry.workspaceId,
        state: 'dormant',
        profile: (profile as any).id,
        live: false,
      });
    }
    return { streams: out };
  }

  async function readScreen({ streamId, tail }: any) {
    await wakeIfDormant(streamId);
    await screen.flush(streamId);
    const text = tail && tail > 0 ? screen.scrollback(streamId, tail) : screen.text(streamId);
    return {
      text,
      cursor: screen.cursor(streamId),
      state: sm.get(streamId)?.state || 'unknown',
    };
  }

  // NON-WAKING screen peek for the spine syncWorker PULL reconcile. Reads the
  // current scrollback + state WITHOUT wakeIfDormant, so reconciling a finished
  // worker NEVER re-spawns/restarts a dormant PTY (which would relaunch the
  // agent's work). Returns empty text + 'unknown' state when the controller is
  // not tracking the stream (e.g. before pty-host adoption), so the puller waits
  // for the next tick instead of fabricating a completion. Read-only: no submit,
  // no spawn, no state mutation.
  async function peekScreen({ streamId, tail }: any) {
    if (!streamId) throw new Error('streamId required');
    let text = '';
    let rawTail = '';
    try {
      await screen.flush(streamId);
      text = tail && tail > 0 ? screen.scrollback(streamId, tail) : screen.text(streamId);
      // ANSI-stripped raw ring tail: the redraw-immune trailer source. TUI
      // renderers repaint the scrollback, so a finished worker's DONE line
      // may exist ONLY here — the syncWorker pull parses this as fallback.
      if (typeof screen.strippedRing === 'function') {
        rawTail = screen.strippedRing(streamId).slice(-65536);
      }
    } catch { /* untracked/dormant stream — leave text empty, never wake it */ }
    // Submitted-prompt trailer lines: the pull must not accept their echo
    // (window-bounded — beyond the echo region the keys are empty).
    const echoTrailerKeys =
      typeof sm.echoTrailerKeysFor === 'function' ? sm.echoTrailerKeysFor(streamId) : [];
    return { text: text || '', rawTail, echoTrailerKeys, state: sm.get(streamId)?.state || 'unknown' };
  }

  async function getState({ streamId }: any) {
    await wakeIfDormant(streamId);
    await screen.flush(streamId);
    sm.evaluate(streamId);
    observeCompletions(streamId);
    return { state: sm.get(streamId)?.state || 'unknown' };
  }

  // Route a caller-requested paste through `type` for profiles that flag
  // bracketed paste as unsupported. Gemini CLI's Ink-based input widget
  // treats the `\x1b[200~`/`\x1b[201~` markers as garbage and leaves the
  // input in a half-composed state where Enter adds a newline instead of
  // submitting. Type mode sidesteps that entirely.
  function profilePaste(streamId: any, text: any) {
    const tab = tabs.get(streamId);
    if (tab?.profile?.bracketedPaste === false) {
      return input.type(streamId, text);
    }
    return input.paste(streamId, text);
  }

  // For type-mode profiles, give the input widget a beat to commit the
  // typed characters before sending Enter. Without this, fused paste +
  // submit races and Enter gets interpreted as a newline. 200ms is the
  // shortest delay that worked reliably against Gemini.
  async function pasteAndSubmit(streamId: any, text: any) {
    const tab = tabs.get(streamId);
    const wantsTypeMode = tab?.profile?.bracketedPaste === false;
    const wantsSubmitDelay = wantsTypeMode || tab?.profile?.id === 'claude-code' || tab?.agent === 'claude';
    sm.setTrailerReconcilePaused(streamId, true);
    let pasteResult: any;
    try {
      pasteResult = await profilePaste(streamId, text);
    } finally {
      sm.setTrailerReconcilePaused(streamId, false);
    }
    if (pasteResult?.ok === false) return pasteResult;
    if (wantsSubmitDelay) await new Promise((r) => setTimeout(r, 200));
    markCompletionTurn(streamId);
    sm.markSubmit(streamId, text);
    return input.submit(streamId);
  }

  async function sendInput({ streamId, text, mode, caller }: any) {
    if (mode !== 'keys' && !text) return { ok: true };
    const safeText = mode === 'keys' ? text : sanitizeTerminalInputPayload(text);
    if (safeText === null) return { ok: false };
    await wakeIfDormant(streamId);
    let result;
    if (mode === 'paste') result = await profilePaste(streamId, safeText);
    else if (mode === 'type') result = await input.type(streamId, safeText);
    else if (mode === 'keys') result = await input.keys(streamId, safeText);
    else result = await profilePaste(streamId, safeText);
    appendCommunicationSent({ caller, targetStreamId: streamId, command: caller?.command || 'send', body: safeText });
    return result;
  }

  async function sendKeys({ streamId, key, repeat }: any) {
    await wakeIfDormant(streamId);
    return input.keys(streamId, key, { repeat });
  }

  async function submit({ streamId }: any) {
    await wakeIfDormant(streamId);
    markCompletionTurn(streamId);
    sm.markSubmit(streamId);
    return input.submit(streamId);
  }

  async function clearComposer({ streamId }: any) {
    await wakeIfDormant(streamId);
    await input.keys(streamId, 'ctrl+u');
    return { ok: true, streamId, submitted: false };
  }

  async function sendSubmit({ streamId, text, mode }: any) {
    if (typeof text !== 'string') throw new Error('text required');
    const start = Date.now();
    const safeText = sanitizeTerminalInputPayload(text);
    if (safeText === null) return { ok: false, telemetry: { promptMs: Date.now() - start } };
    await wakeIfDormant(streamId);
    const tab = tabs.get(streamId);
    const shouldRememberHermes = tab?.agent === 'hermes' || tab?.profile?.id === 'hermes';
    try {
      if (mode === 'type') {
        sm.setTrailerReconcilePaused(streamId, true);
        try {
          const typeResult = await input.type(streamId, safeText);
          if (typeResult?.ok === false) return { ...typeResult, telemetry: { promptMs: Date.now() - start } };
        } finally {
          sm.setTrailerReconcilePaused(streamId, false);
        }
        await new Promise((r) => setTimeout(r, 200));
        markCompletionTurn(streamId);
        sm.markSubmit(streamId, safeText);
        await input.submit(streamId);
      } else {
        const pasteResult = await pasteAndSubmit(streamId, safeText);
        if (pasteResult?.ok === false) return { ...pasteResult, telemetry: { promptMs: Date.now() - start } };
      }
      if (shouldRememberHermes) rememberHermesSubmission(streamId, safeText);
    } catch (err) {
      if (shouldRememberHermes) forgetHermesSubmission(streamId, safeText);
      throw err;
    }
    if (tab?.profile?.id === 'claude-code' || tab?.agent === 'claude') {
      await new Promise((r) => setTimeout(r, 250));
      await screen.flush(streamId);
      sm.evaluate(streamId);
      const visible = screen.text(streamId);
      if (/\[Pasted text #\d+/.test(visible) && sm.get(streamId)?.state !== 'busy') {
        markCompletionTurn(streamId);
        sm.markSubmit(streamId, safeText);
        await input.submit(streamId);
      }
    }
    return { ok: true, telemetry: { promptMs: Date.now() - start } };
  }

  async function abort({ streamId, reason }: any) {
    await wakeIfDormant(streamId);
    pendingHermesSubmissions.delete(streamId);
    const result = await input.abort(streamId);
    sm.markInterrupted(streamId, reason || 'abort');
    runWaiters(streamId);
    return { ...result, state: sm.get(streamId)?.state || 'unknown' };
  }

  async function ask({ streamId, prompt, timeoutMs, submitRetryMs, mode, caller }: any) {
    await wakeIfDormant(streamId);
    if (typeof prompt !== 'string' || !prompt) throw new Error('ask: prompt required');
    const timeout = Math.max(1000, timeoutMs | 0 || DEFAULT_ASK_TIMEOUT);
    const retryAfter = Math.max(100, submitRetryMs | 0 || SUBMIT_RETRY_MS);

    const m = sm.get(streamId);
    let readyMs = 0;
    if (m?.state !== 'awaiting-input' && m?.state !== 'turn-complete') {
      const ready = await waitFor(streamId, { awaitingInput: true }, { timeoutMs: timeout });
      readyMs = typeof (ready as any)?.elapsedMs === 'number' ? (ready as any).elapsedMs : 0;
    }

    screen.diff(streamId);
    const start = Date.now();
    const promptStart = Date.now();
    const tab = tabs.get(streamId);
    const shouldRememberHermes = tab?.agent === 'hermes' || tab?.profile?.id === 'hermes';
    const explicitTypeMode = mode === 'type';
    const wantsTypeMode = explicitTypeMode || tab?.profile?.bracketedPaste === false;
    sm.setTrailerReconcilePaused(streamId, true);
    try {
      if (explicitTypeMode) {
        await input.type(streamId, prompt);
      } else {
        await profilePaste(streamId, prompt);
      }
    } finally {
      sm.setTrailerReconcilePaused(streamId, false);
    }
    // Ink-based terminal apps (Gemini) need a beat between typed chars and Enter;
    // otherwise Enter arrives while the input widget is still committing
    // the typed content and gets interpreted as a newline. 200ms has been
    // enough on a local pty.
    if (wantsTypeMode) await new Promise((r) => setTimeout(r, 200));
    markCompletionTurn(streamId);
    sm.markSubmit(streamId, prompt);
    await input.submit(streamId);
    if (shouldRememberHermes) rememberHermesSubmission(streamId, prompt);
    appendCommunicationSent({ caller, targetStreamId: streamId, command: caller?.command || 'ask', body: prompt });

    // Retry-submit is a safety net for bracketed-paste-capable terminal apps that
    // may drop an Enter immediately after a paste-end marker. For
    // type-mode profiles it does more harm than good — a second Enter on
    // a Ace that already accepted the first can land as an empty new
    // turn. Skip the retry for those.
    if (!wantsTypeMode) {
      await new Promise((r) => setTimeout(r, retryAfter));
      if (sm.get(streamId)?.state === 'awaiting-input') {
        markCompletionTurn(streamId);
        sm.markSubmit(streamId, prompt);
        await input.submit(streamId);
      }
    }
    const promptMs = Date.now() - promptStart;

    const remaining = Math.max(1000, timeout - (Date.now() - start));
    const waitForAskOutcome = async (targetStreamId: any, delayMs = 350) => {
      // Let compression recovery mark the replayed prompt as a new turn before
      // evaluating the next terminal-complete signal.
      if (delayMs > 0) await sleep(delayMs);
      const remainingAfterRecovery = Math.max(1000, timeout - (Date.now() - start));
      const followUps = [
        waitFor(targetStreamId, { turnComplete: true }, { timeoutMs: remainingAfterRecovery }).then((next: any) => ({ ...next, ok: true, endState: 'turn-complete' })),
        waitFor(targetStreamId, { awaitingApproval: true }, { timeoutMs: remainingAfterRecovery }).then((next: any) => ({ ...next, ok: true, endState: 'awaiting-approval' })),
        waitFor(targetStreamId, { state: 'error' }, { timeoutMs: remainingAfterRecovery }).then((next: any) => ({ ...next, ok: false, endState: 'error', error: 'stream entered error state' })),
      ];
      try {
        return await Promise.race(followUps);
      } finally {
        for (const wait of followUps) wait.catch(() => {});
      }
    };
    try {
      const turnCompleteWait = waitFor(streamId, { turnComplete: true }, { timeoutMs: remaining }).then(async (r: any) => {
        const pending = pendingHermesSubmissions.get(streamId);
        if (shouldRememberHermes && pending?.recovering) {
          return waitForAskOutcome(streamId);
        }
        return { ...r, ok: true, endState: 'turn-complete' };
      });
      const interruptedWait = waitFor(streamId, { state: 'interrupted' }, { timeoutMs: remaining }).then(async (r: any) => {
        const pending = pendingHermesSubmissions.get(streamId);
        if (shouldRememberHermes && pending?.compressionSeen) {
          return waitForAskOutcome(streamId);
        }
        return { ...r, ok: false, endState: 'interrupted', error: 'turn interrupted' };
      });
      const waits = [
        turnCompleteWait,
        waitFor(streamId, { awaitingApproval: true }, { timeoutMs: remaining }).then((r: any) => ({ ...r, ok: true, endState: 'awaiting-approval' })),
        interruptedWait,
        waitFor(streamId, { state: 'error' }, { timeoutMs: remaining }).then((r: any) => ({ ...r, ok: false, endState: 'error', error: 'stream entered error state' })),
      ];
      let result: any;
      try {
        result = await Promise.race(waits);
      } finally {
        for (const wait of waits) wait.catch(() => {});
      }
      const newOutput = screen.diff(streamId);
      appendCommunicationReply({ caller, targetStreamId: streamId, command: caller?.command || 'ask', body: newOutput });
      return {
        ok: result.ok !== false,
        elapsedMs: Date.now() - start,
        endState: result.endState,
        ...(result.error ? { error: result.error } : {}),
        newOutput,
        telemetry: {
          readyMs,
          promptMs,
          firstOutputMs: newOutput ? Date.now() - start : null,
        },
      };
    } catch (err: any) {
      if (shouldRememberHermes && /stream closed/i.test(String(err?.message || err || ''))) {
        const redirectWaitMs = Math.max(0, Math.min(15_000, timeout - (Date.now() - start)));
        const redirectedStreamId = await waitForHermesRedirectStream(streamId, redirectWaitMs);
        if (redirectedStreamId) {
          const result: any = await waitForAskOutcome(redirectedStreamId, 0);
          const redirectedOutput = screen.diff(redirectedStreamId);
          appendCommunicationReply({ caller, targetStreamId: redirectedStreamId, command: caller?.command || 'ask', body: redirectedOutput });
          return {
            ok: result.ok !== false,
            elapsedMs: Date.now() - start,
            endState: result.endState,
            redirectedStreamId,
            ...(result.error ? { error: result.error } : {}),
            newOutput: redirectedOutput,
            telemetry: {
              readyMs,
              promptMs,
              firstOutputMs: redirectedOutput ? Date.now() - start : null,
            },
          };
        }
      }
      const newOutput = screen.diff(streamId);
      appendCommunicationReply({ caller, targetStreamId: streamId, command: caller?.command || 'ask', body: newOutput });
      return {
        ok: false,
        elapsedMs: Date.now() - start,
        endState: sm.get(streamId)?.state || 'unknown',
        error: err.message,
        newOutput,
        telemetry: {
          readyMs,
          promptMs,
          firstOutputMs: newOutput ? Date.now() - start : null,
        },
      };
    }
  }

  async function slash({ streamId, command, args }: any) {
    await wakeIfDormant(streamId);
    const tab = tabs.get(streamId);
    if (!tab.profile?.slash?.includes(command)) {
      throw new Error(`slash command "${command}" not declared in profile "${tab.profile?.id}"`);
    }
    const body = args && args.length ? `/${command} ${args.join(' ')}` : `/${command}`;
    const result = await pasteAndSubmit(streamId, body);
    // `/clear` makes Codex/Gemini write a brand-new session file. Re-enqueue
    // the tab with the linker so the new file gets claimed and the existing
    // link is swapped (resetStream fires when the filename changes). We do
    // NOT drop the transcript pre-emptively: if the terminal's /clear fails,
    // no new session file appears and the chat view stays as-is.
    if (command === 'clear' && tab.profile?.transcript) {
      transcripts
        .onSlashClear(streamId, { agent: tab.agent, cwd: tab.cwd })
        .catch((err: any) => console.warn('[ace-control] onSlashClear failed:', err?.message));
    }
    if (command === 'resume' && (!args || args.length === 0) && tab.agent === 'claude' && tab.profile?.transcript) {
      await armClaudeResume(streamId, tab);
    }
    return result;
  }

  async function armClaudeResume(streamId: any, tab = tabs.get(streamId)) {
    if (!tab || tab.agent !== 'claude') return { ok: false, reason: 'not-claude' };
    if (resumePickerStreams.has(streamId)) return { ok: true, alreadyArmed: true };
    const result = await transcripts.onSlashResume(streamId, { agent: tab.agent, cwd: tab.cwd });
    if (result?.ok !== false) resumePickerStreams.add(streamId);
    return result;
  }

  function normalizedTerminalLine(raw: any) {
    let line = String(raw || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    let out = '';
    for (const ch of line) {
      if (ch === '\x7f' || ch === '\b') out = out.slice(0, -1);
      else if (ch >= ' ' && ch !== '\x7f') out += ch;
    }
    return out.trim();
  }

  // Observe raw xterm /resume input because it bypasses streamSlash.
  async function observeTerminalInputSerial({ streamId, data }: any) {
    if (!streamId || typeof data !== 'string') return { ok: false };
    const tab = tabs.get(streamId);
    if (!tab || tab.agent !== 'claude') return { ok: true };
    if (data === '\x1b' && resumePickerStreams.has(streamId)) {
      resumePickerStreams.delete(streamId);
      rawTerminalInput.delete(streamId);
      terminalInputEndedWithCr.delete(streamId);
      await transcripts.cancelResumeSelection(streamId);
      return { ok: true, cancelled: true };
    }

    let chunk = data;
    if (terminalInputEndedWithCr.has(streamId) && chunk.startsWith('\n')) chunk = chunk.slice(1);
    if (chunk.endsWith('\r')) terminalInputEndedWithCr.add(streamId);
    else terminalInputEndedWithCr.delete(streamId);
    const combined = ((rawTerminalInput.get(streamId) || '') + chunk).replace(/\r\n/g, '\r');
    let start = 0;
    for (let i = 0; i < combined.length; i += 1) {
      if (combined[i] !== '\r' && combined[i] !== '\n') continue;
      const line = normalizedTerminalLine(combined.slice(start, i));
      start = i + 1;
      if (/^\/resume$/i.test(line)) {
        await armClaudeResume(streamId, tab);
      } else if (resumePickerStreams.has(streamId)) {
        resumePickerStreams.delete(streamId);
        await transcripts.onResumeSelection(streamId);
      }
    }
    rawTerminalInput.set(streamId, combined.slice(start).slice(-1024));
    return { ok: true };
  }

  function observeTerminalInput(input: any) {
    const streamId = String(input?.streamId || '');
    if (!streamId) return Promise.resolve({ ok: false });
    const previous = terminalObservationQueues.get(streamId) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => observeTerminalInputSerial(input));
    terminalObservationQueues.set(streamId, current);
    current.finally(() => {
      if (terminalObservationQueues.get(streamId) === current) {
        terminalObservationQueues.delete(streamId);
      }
    }).catch(() => {});
    return current;
  }

  async function ref({ streamId, filePath }: any) {
    await wakeIfDormant(streamId);
    const tab = tabs.get(streamId);
    const sigil = tab.profile?.fileRef || '@';
    return profilePaste(streamId, `${sigil}${filePath}`);
  }

  async function approve({ streamId, answer }: any) {
    await wakeIfDormant(streamId);
    const m = sm.get(streamId);
    if (m?.state !== 'awaiting-approval') {
      await waitFor(streamId, { awaitingApproval: true }, { timeoutMs: 15_000 });
    }
    const yes = answer !== 'no';
    const tab = tabs.get(streamId);
    if (yes) {
      // Profiles can override the yes-input. Gemini's menu has option 1
      // pre-highlighted with no letter shortcut, so a typed `y` lands as
      // a character in the input buffer instead of an answer — Enter
      // alone activates the default. Claude/Codex accept the y+Enter
      // path (Codex's `[y/N]` literally needs it).
      const yesKey = tab?.profile?.approveYesKey;
      if (yesKey) {
        sm.markSubmit(streamId);
        await input.keys(streamId, yesKey);
      } else {
        await input.type(streamId, 'y');
        sm.markSubmit(streamId);
        await input.submit(streamId);
      }
    } else {
      // No is awkward across terminal apps: Claude puts "No" on option 3 with
      // a "Yes session" between, so pressing 'n' types into a buffer
      // and Enter still confirms the highlighted Yes. Esc cancels on
      // every approval prompt we've measured (Claude shows "Esc to
      // cancel", Gemini's "No" option literally annotates "(esc)",
      // Codex's `[y/N]` accepts esc as a discard).
      sm.markSubmit(streamId);
      await input.keys(streamId, 'esc');
    }
    sm.markApprovalAnswered(streamId);
    return { ok: true, answer: yes ? 'yes' : 'no' };
  }

  async function interrupt({ streamId }: any) {
    return abort({ streamId, reason: 'interrupt' });
  }

  async function waitForApi({ streamId, predicate, timeoutMs }: any) {
    await wakeIfDormant(streamId);
    return waitFor(streamId, predicate || {}, { timeoutMs });
  }

  async function spawn({ agent, taskId, kind, launchIntent }: any) {
    if (!agent) throw new Error('spawn: agent required');
    if (!taskId) throw new Error('spawn: taskId required (V1 spawns into an existing workspace task)');
    const res = aceStore.createConversation({ workItemId: taskId, agent, kind: kind || 'cli' });
    if (!res?.id) throw new Error('spawn: createConversation failed');
    const streamId = `conversation:${res.id}`;
    await aceStore.ensureStreamStarted({ streamId, cols: 120, rows: 40, launchIntent });
    trackTab(streamId, { agent });
    return { streamId, conversationId: res.id };
  }

  async function spawnIntoVariant({ variantId, agent, launchIntent }: any) {
    if (!variantId) throw new Error('spawnIntoVariant: variantId required');
    const streamId = `variant:${variantId}`;
    await aceStore.ensureStreamStarted({ streamId, cols: 120, rows: 40, launchIntent });
    trackTab(streamId, { agent: agent || null });
    return { streamId, variantId };
  }

  // Ad-hoc spawn: create a lightweight thread task in the given workspace
  // and drop an agent into it — no pre-existing task required. This is
  // the endpoint `ace task run --workspace …` and the MCP
  // `ace_spawn_adhoc` tool call into, so an orchestrator can spin up
  // sub-workers on demand without human setup.
  async function spawnAdhoc({ agent, workspaceId, label, kind, prompt, initialPrompt, mode, readyTimeoutMs, launchIntent }: any) {
    if (!agent) throw new Error('spawnAdhoc: agent required');
    if (!workspaceId) throw new Error('spawnAdhoc: workspaceId required');
    if (typeof aceStore.createAdhocThread !== 'function') {
      throw new Error('spawnAdhoc: aceStore.createAdhocThread unavailable');
    }
    const res = await aceStore.createAdhocThread({
      workspaceId,
      agent,
      label: label || null,
      kind: kind || 'cli',
      prompt: initialPrompt || prompt || null,
    });
    if (!res?.streamId) throw new Error('spawnAdhoc: createAdhocThread returned no streamId');
    await aceStore.ensureStreamStarted({ streamId: res.streamId, cols: 120, rows: 40, launchIntent });
    trackTab(res.streamId, { agent, label: label || null });
    let promptDelivered = false;
    if (typeof prompt === 'string' && prompt.length > 0) {
      try {
        const readyTimeout = Math.max(1_000, (readyTimeoutMs | 0) || 180_000);
        await waitFor(res.streamId, { awaitingInput: true }, { timeoutMs: readyTimeout });
        const deliveryMode = mode === 'paste' ? 'paste' : 'type';
        await sendInput({ streamId: res.streamId, text: prompt, mode: deliveryMode });
        await new Promise((r) => setTimeout(r, deliveryMode === 'type' ? 200 : 50));
        sm.markSubmit(res.streamId);
        await input.submit(res.streamId);
        promptDelivered = true;
      } catch (err: any) {
        // Spawn succeeded; prompt delivery is best-effort. Surface the
        // failure in the response so the caller can decide what to do.
        return {
          streamId: res.streamId,
          conversationId: res.conversationId,
          taskId: res.taskId,
          promptDelivered: false,
          promptError: err?.message || String(err),
        };
      }
    }
    return {
      streamId: res.streamId,
      conversationId: res.conversationId,
      taskId: res.taskId,
      promptDelivered,
    };
  }

  async function close({ streamId }: any) {
    if (streamId.startsWith('shell:')) {
      aceStore.killShellStream({ streamId });
    } else {
      // Kill the PTY for any tab kind. We deliberately don't delete the
      // underlying conversation/variant DB row — the Ace UI still owns
      // that lifecycle, and an orchestrator can re-spawn onto the same
      // workspace slot without a dangling-row cleanup step.
      aceStore.killStream(streamId);
    }
    closeTab(streamId);
    return { ok: true };
  }

  async function rename({ streamId, label }: any) {
    const tab = tabs.get(streamId);
    if (!tab) throw new Error(`unknown stream: ${streamId}`);
    tab.label = typeof label === 'string' ? label : null;
    bus.emit('tab-renamed', { streamId, label: tab.label });
    bus.emitAny({ event: 'tab-renamed', payload: { streamId, label: tab.label } });
    return { ok: true, label: tab.label };
  }

  async function recordStart({ streamId, outPath }: any) {
    await wakeIfDormant(streamId);
    if (!outPath) throw new Error('recordStart: outPath required');
    return recorders.start(streamId, outPath);
  }

  async function recordStop({ streamId }: any) {
    return recorders.stop(streamId);
  }

  async function replay({ recordPath, agent }: any) {
    const { header, frames } = loadRecording(recordPath);
    const virtualId = `replay:${header.streamId}:${Date.now()}`;
    trackTab(virtualId, { agent: agent || 'claude', cwd: null });
    const transitions: any[] = [];
    const unsub = bus.on('state-change', (p: any) => {
      if (p.streamId === virtualId) transitions.push({ t: Date.now(), from: p.from, to: p.to });
    });
    for (const frame of frames) {
      if (frame.type === 'data') {
        screen.write(virtualId, frame.chunk);
        sm.evaluate(virtualId);
      } else if (frame.type === 'submit') {
        sm.markSubmit(virtualId);
      } else if (frame.type === 'exit') {
        sm.markExit(virtualId, frame.code);
      }
    }
    unsub();
    const finalState = sm.get(virtualId)?.state;
    closeTab(virtualId);
    return { ok: true, frames: frames.length, finalState, transitions };
  }

  async function follow({ streamId }: any) {
    await wakeIfDormant(streamId);
    return { text: screen.diff(streamId), state: sm.get(streamId)?.state || 'unknown' };
  }

  async function snapshot({ streamId }: any) {
    await wakeIfDormant(streamId);
    await screen.flush(streamId);
    const ansi = screen.ansiSnapshot(streamId);
    const text = screen.text(streamId);
    const paths = await writeSnapshot({ streamId, ansi, text });
    return {
      ok: true,
      ...paths,
      cursor: screen.cursor(streamId),
      state: sm.get(streamId)?.state || 'unknown',
      dir: SNAPSHOT_DIR,
    };
  }

  function requireTab(streamId: any) {
    if (!streamId) throw new Error('streamId required');
    if (!tabs.has(streamId)) throw new Error(`unknown stream: ${streamId}`);
  }

  // Wake a dormant stream: if the streamId matches a conversation/variant
  // row in the DB but no PTY has been spawned yet, call ensureStreamStarted
  // and block until we see the first data chunk (or time out). After this
  // returns, the stream is tracked and all other verbs behave normally.
  async function wakeIfDormant(streamId: any, timeoutMs = 30_000) {
    if (!streamId) throw new Error('streamId required');
    if (tabs.has(streamId)) return;
    const owner = safeResolveOwner(streamId);
    if (!owner) throw new Error(`unknown stream: ${streamId}`);

    let timer: any = null;
    let offData: any = null;
    let offOpened: any = null;
    let settled = false;
    let resolveWake: any;
    let rejectWake: any;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (offData) offData();
      offData = null;
      if (offOpened) offOpened();
      offOpened = null;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWake();
    };
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWake(err);
    };
    const wakePromise = new Promise<void>((resolve, reject) => {
      resolveWake = resolve;
      rejectWake = reject;
      timer = setTimeout(() => {
        fail(new Error(`wake timed out after ${timeoutMs}ms (stream did not emit data)`));
      }, timeoutMs);
      // Subscribe before spawning. Some PTYs emit their first chunk
      // synchronously/very quickly; subscribing afterwards can miss it and
      // falsely report a dormant wake timeout.
      offData = aceStore.onPtyData(({ id }: any) => {
        if (id !== streamId) return;
        finish();
      });
      if (typeof aceStore.onPtyOpened === 'function') {
        offOpened = aceStore.onPtyOpened(({ id, agent, cwd }: any) => {
          if (id !== streamId) return;
          trackTab(id, { agent, cwd });
          finish();
        });
      }
    });

    let startResult: any;
    try {
      startResult = await aceStore.ensureStreamStarted({ streamId, cols: 120, rows: 40 });
    } catch (err: any) {
      settled = true;
      cleanup();
      throw err;
    }
    if (!startResult || startResult.ok === false) {
      const detail = startResult?.error || startResult?.message || 'ensureStreamStarted returned ok=false';
      const err = new Error(`failed to start stream ${streamId}: ${detail}`);
      settled = true;
      cleanup();
      throw err;
    }
    if (tabs.has(streamId)) {
      finish();
      return;
    }
    await wakePromise;
  }

  async function reloadProfiles() {
    const fresh = loadProfilesFromDisk(profilesDir, userDataPath);
    profiles.clear();
    for (const [id, p] of fresh) profiles.set(id, p);
    let rebound = 0;
    for (const [streamId, tab] of tabs) {
      const next = profileForAgent(profiles, tab.agent);
      tab.profile = next;
      sm.setProfile(streamId, next);
      rebound++;
      // Re-run evaluation so new patterns take effect on the current viewport.
      await screen.flush(streamId);
      sm.evaluate(streamId);
      observeCompletions(streamId);
      runWaiters(streamId);
    }
    bus.emit('profiles-reloaded', { count: profiles.size, rebound });
    bus.emitAny({ event: 'profiles-reloaded', payload: { count: profiles.size, rebound } });
    return { count: profiles.size, rebound };
  }

  // Auto-reload on profile file changes. Debounced so a multi-file save
  // (e.g. editor atomic write) reloads once.
  let profileReloadTimer: any = null;
  const profileWatcher = (() => {
    try {
      return fs.watch(profilesDir, { persistent: false }, () => {
        if (profileReloadTimer) clearTimeout(profileReloadTimer);
        profileReloadTimer = setTimeout(() => {
          profileReloadTimer = null;
          reloadProfiles().catch((err: any) => {
            console.error('[ace-control] profile hot-reload failed:', err.message);
          });
        }, 100);
      });
    } catch (err: any) {
      console.error('[ace-control] profile watcher unavailable:', err.message);
      return null;
    }
  })();
  // Fallback for the fs.watch above, which is best-effort on macOS and can
  // silently drop events after some editor rewrites. This interval compares
  // file mtimes and re-reads if anything's newer than the last load. It runs
  // in the main process — the same event loop that serves every mobile HTTP
  // and websocket response — so the old 1s cadence meant a readdir + stat of
  // every profile file every second forever, a steady idle-CPU drain that
  // starves the remote server. 30s keeps the safety net (profiles are config,
  // not a hot path; the 100ms-debounced watcher already covers the fast case)
  // while cutting that background work 30×.
  const PROFILE_MTIME_FALLBACK_MS = 30_000;
  const profileFileMtimes = new Map();
  async function primeMtimes() {
    for (const name of await fsp.readdir(profilesDir)) {
      if (!name.endsWith('.json')) continue;
      const stat = await fsp.stat(path.join(profilesDir, name));
      profileFileMtimes.set(name, stat.mtimeMs);
    }
  }
  void primeMtimes();
  const mtimePoller = setInterval(async () => {
    try {
      let changed = false;
      for (const name of await fsp.readdir(profilesDir)) {
        if (!name.endsWith('.json')) continue;
        const stat = await fsp.stat(path.join(profilesDir, name));
        const prev = profileFileMtimes.get(name);
        if (prev !== stat.mtimeMs) {
          profileFileMtimes.set(name, stat.mtimeMs);
          changed = true;
        }
      }
      if (changed) await reloadProfiles();
    } catch {}
  }, PROFILE_MTIME_FALLBACK_MS);

  function shutdown() {
    for (const off of unsubs) { try { off(); } catch {} }
    for (const id of quietPollers.values()) clearInterval(id);
    quietPollers.clear();
    for (const t of trailingEvalTimers.values()) clearTimeout(t);
    trailingEvalTimers.clear();
    rawTerminalInput.clear();
    terminalInputEndedWithCr.clear();
    resumePickerStreams.clear();
    terminalObservationQueues.clear();
    if (profileReloadTimer) clearTimeout(profileReloadTimer);
    clearInterval(mtimePoller);
    clearInterval(runReconcilePoller);
    clearTimeout(bootReconcileTimer);
    try { prFixbackWatcher?.stop(); } catch {}
    try { profileWatcher?.close(); } catch {}
    recorders.disposeAll();
    try { transcripts.shutdown(); } catch {}
  }

  // Public API — mounted on aceStore by the caller so remote-server
  // auto-dispatches them over WebSocket.
  const methods = {
    // Lean READ-ONLY run-ledger board (watcher, never a gate). Exposed as a store
    // method so both the IPC handler and the `ace run board` CLI reach it.
    runBoard: () => leanBoard(),
    // Submit a run-ledger intent (the spine's intake — the brain's single entry).
    // Mints a run, then drives it to quiescence: real worker+validator dispatch,
    // parking at ready_to_review. Returns { runId }. On by default (master kill:
    // ACE_RUN_LEDGER=0); merge stays fail-closed behind the owner token.
    runSubmit: (p: any) => {
      const h = ensureRunLedgerHarness();
      if (!h) throw new Error('run-ledger spine disabled');
      const intent = applyWorkspaceAutomergePolicy((p && p.intent) || p || {});
      // Intake gate (electron/run-ledger/intake-gate.cts): fail-fast checks
      // for conditions that are inevitable at dispatch anyway — missing/unknown
      // workspace (spine-effects cannot spawn) and empty acceptance (parseSpec
      // rejects it one tick later). Throws BEFORE h.submit, so a rejected
      // intake never mints or drives a run.
      const { workspaceId, workspace, projectDir } = workspaceForRunIntent(intent);
      intakeGate.validateRunIntake({ intent, workspaceId, workspace });
      // Pre-trust the workspace root for codex so no lane (worker OR the
      // always-codex validator) stalls at the interactive trust prompt in its
      // spine-created worktree. Idempotent, best-effort, never blocks intake.
      if (projectDir) codexTrust.ensureCodexTrustedProject(projectDir);
      const runId = h.submit(intent);
      if (runId) {
        // Push the board refresh signal for the mint itself; driveRun pushes
        // again when the quiescence loop settles. Covers external `ace run
        // submit` (socket bridge), which touches neither the app store nor a
        // pty stream until dispatch.
        notifyRunLedgerChanged();
        driveRun(runId);
      }
      return { runId };
    },
    // Human-invoked fixback (Skysphere review loop): force DISPATCH_FIXBACK_WORKER
    // through the kernel's durable-marker + link-proof + fail-closed machinery,
    // carrying the human's confirmed prompt as fixbackDirectives into the fixback
    // spec context (spine-effects fixbackSpecOverride). Intentionally bypasses the
    // autonomy-only fixbackWorkerExplicitlyAllowed gate — that gates AUTONOMOUS
    // decisions; this one is invoked by a human — but keeps FIXBACK_RETRY_CAP and
    // refuses while the worker is in flight (use the live stream instead).
    runFixback: async (p: any) => {
      const h = ensureRunLedgerHarness();
      if (!h) throw new Error('run-ledger spine disabled');
      const runId = p && p.runId != null ? String(p.runId) : '';
      const prompt = p && typeof p.prompt === 'string' ? p.prompt.slice(0, 20_000).trim() : '';
      if (!runId) throw new Error('runFixback: runId required');
      if (!prompt) throw new Error('runFixback: prompt required');
      if (h.ledger.readRun(runId).length === 0) throw new Error(`runFixback: run ${runId} not found`);
      const state = (h.kernel.reconcile(runId) || {}).state || {};
      const worker = state.worker || {};
      // Mirror the kernel force guard: fixbackInFlight covers an in-flight
      // FIXBACK worker, which `dispatched && !done` cannot see (done stays
      // true from the original completion).
      if ((worker.dispatched && !worker.done) || worker.fixbackInFlight) throw new Error('worker in flight — use the live stream');
      const attempts = Number(state.fixback && state.fixback.attempts) || 0;
      if (attempts >= FIXBACK_RETRY_CAP) {
        throw new Error(`fixback retry cap (${FIXBACK_RETRY_CAP}) reached for run ${runId}`);
      }
      try {
        const step = await h.kernel.runStep(runId, {
          force: {
            next: NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER,
            reason: 'skysphere-review-fixback',
            fixbackDirectives: prompt,
          },
        });
        if (step && step.ok === false) throw new Error(step.error || 'fixback dispatch failed');
        return { ok: true, runId, next: step?.next ?? null, ran: step?.ran ?? null };
      } finally {
        notifyRunLedgerChanged();
      }
    },
    // Halt an autonomy OUTER-loop lineage: append a terminal stop marker so the
    // neuron and boot-replay never dispatch another cycle for it. The lineageId
    // is the lineage's root runId. Idempotent — a second stop is a harmless
    // duplicate marker. (To kill ALL loops at once: env ACE_AUTONOMY_LOOP=0.)
    runLoopStop: (p: any) => {
      const h = ensureRunLedgerHarness();
      if (!h) throw new Error('run-ledger spine disabled');
      const lineageId = p && p.lineageId ? String(p.lineageId) : '';
      if (!lineageId) throw new Error('lineageId required');
      h.kernel.recordEvent({
        runId: lineageId,
        type: 'next-goal.derived',
        payload: { loopLineageId: lineageId, stopped: true, reason: 'owner stop via run loop --stop' },
      });
      notifyRunLedgerChanged();
      return { ok: true, lineageId, stopped: true };
    },
    // Board hygiene: move finished/dead runs' events out of the live ledger
    // into events-archive.ndjson so the board (a pure projection over the live
    // events) stops rendering them. Selectors: explicit runs, or the
    // threshold policy (terminal limits to done+blocked; olderThanHours
    // overrides the bucket thresholds). dryRun reports without moving. Safe
    // in-process under the live appender (synchronous I/O, readAll re-reads).
    runArchive: (p: any) => {
      const h = ensureRunLedgerHarness();
      if (!h) throw new Error('run-ledger spine disabled');
      const runs = Array.isArray(p?.runs) ? p.runs : p?.runs ? [p.runs] : [];
      return h.archive({
        runIds: runs.map((r: any) => String(r)).filter(Boolean),
        terminal: p?.terminal === true,
        olderThanHours: p?.olderThanHours != null ? Number(p.olderThanHours) : undefined,
        dryRun: p?.dryRun === true,
      });
    },
    streamList: () => listStreams(),
    streamReadScreen: (p: any) => readScreen(p || {}),
    streamPeekScreen: (p: any) => peekScreen(p || {}),
    streamGetState: (p: any) => getState(p || {}),
    streamSendInput: (p: any) => sendInput(p || {}),
    streamObserveTerminalInput: (p: any) => observeTerminalInput(p || {}),
    streamSendKeys: (p: any) => sendKeys(p || {}),
    streamSubmit: (p: any) => submit(p || {}),
    streamClearComposer: (p: any) => clearComposer(p || {}),
    streamSendSubmit: async (p: any) => {
      const { streamId, caller } = p || {};
      if (!streamId) throw new Error('streamId required');
      const result = await sendSubmit(p || {});
      appendCommunicationSent({ caller, targetStreamId: streamId, command: caller?.command || 'send', body: p?.text });
      return result;
    },
    streamAbort: (p: any) => abort(p || {}),
    streamAsk: (p: any) => ask(p || {}),
    streamSlash: (p: any) => slash(p || {}),
    streamRef: (p: any) => ref(p || {}),
    streamApprove: (p: any) => approve(p || {}),
    streamInterrupt: (p: any) => interrupt(p || {}),
    streamWaitFor: (p: any) => waitForApi(p || {}),
    streamSpawn: (p: any) => spawn(p || {}),
    streamSpawnIntoVariant: (p: any) => spawnIntoVariant(p || {}),
    streamSpawnAdhoc: (p: any) => spawnAdhoc(p || {}),
    streamStartOrchestrator: (p: any) => {
      if (typeof aceStore.startOrchestrator !== 'function') {
        throw new Error('startOrchestrator: aceStore.startOrchestrator unavailable');
      }
      return aceStore.startOrchestrator(p || {});
    },
    streamCreateDelegatedTask: (p: any) => aceStore.createDelegatedTask(p || {}),
    streamVerifyTaskProgress: (p: any) => aceStore.verifyTaskProgress(p || {}),
    streamGetContext: (p: any) => aceStore.getContextForStream(p || {}),
    streamTrackedGithubProjects: () => aceStore.listTrackedGithubProjects(),
    streamClose: (p: any) => close(p || {}),
    streamRename: (p: any) => rename(p || {}),
    streamRecordStart: (p: any) => recordStart(p || {}),
    streamRecordStop: (p: any) => recordStop(p || {}),
    streamReplay: (p: any) => replay(p || {}),
    streamFollow: (p: any) => follow(p || {}),
    streamSnapshot: (p: any) => snapshot(p || {}),
    streamCompletionList: (p: any = {}) => ({
      completions: completionInbox.list({
        includeAcked: !!p.includeAcked,
        workspaceId: p.workspaceId || null,
        streamId: p.streamId || null,
      }),
    }),
    streamCompletionAck: (p: any = {}) => {
      if (!p.id) throw new Error('completion ack: id required');
      const completion = completionInbox.ack(p.id);
      if (!completion) {
        const err = new Error(`completion not found: ${p.id}`);
        (err as any).code = 'NOT_FOUND';
        throw err;
      }
      return { ok: true, completion };
    },
    streamProfiles: () => ({
      profiles: Array.from(profiles.values()).map(publicProfile),
    }),
    streamReloadProfiles: () => reloadProfiles(),
    // Lets in-process consumers (the backend's orchestrator bootstrapper)
    // subscribe to bus events without polling streamList. Returns a
    // function that unsubscribes. Supported events include 'tab-opened',
    // 'tab-closed', 'state-change', 'tab-ready', 'approval-requested',
    // and 'worker-completion'.
    onStreamBus: (event: any, listener: any) => bus.on(event, listener),
    streamTranscript: ({ streamId, since, before, limit }: any = {}) => {
      if (!streamId) throw new Error('streamId required');
      return transcripts.snapshot(streamId, { since, before, limit });
    },
  };

  // The autonomy loop is the Run-Ledger spine now (see the Ring-2 completion
  // observer above): each terminal completion arms runLedgerHarness.runToQuiescence
  // for that run (live by default; ACE_RUN_LEDGER=0 kill). The old mission-coupled auto-rally
  // (validator dispatch → gate → release → MERGES TO MAIN) is retired with the
  // mission domain; its real-effect bindings are the owner-gated full Ring-1 swap.

  // The in-process client closes over the fully-built `methods` table +
  // aceStore — the single channel the Ring-1 spine effects use to drive the
  // real limbs (worktree create, agent spawn, integration gate/merge). The
  // legacy auto-validator is gone: the spine's runValidation effect is the sole
  // validator dispatcher (worker.completed advances the run to its validator).
  const inProcessClient = {
    invoke: async (method: any, params: any) => {
      if (typeof (methods as any)[method] === 'function') {
        return (methods as any)[method](params || {});
      }
      if (typeof aceStore[method] === 'function') {
        return aceStore[method](params || {});
      }
      throw new Error(`in-process client cannot resolve ${method}`);
    },
  };
  deferredInProcessClient = () => inProcessClient;

  // ---- Loops subsystem (additive limb over the SAME spine; PRD §3 two-plane) ----
  // Built ONCE here, closing over the SAME runLedgerHarness + driveRun the run
  // submit path uses, so a loop iteration lands as a real run on the SAME ledger
  // and advances identically to a CLI `run submit` (no second harness/ledger). Its
  // service methods are merged onto `methods` (and thus onto aceStore via the
  // Object.assign in main.cts), exposing ace:loops-* to IPC. The service guards
  // a null harness (ACE_RUN_LEDGER=0 master kill) and throws 'run-ledger spine
  // disabled' from its run-touching methods, exactly like runSubmit. Never throws
  // at construction — a failure leaves the loops methods absent (the IPC handlers
  // surface a clear "loops unavailable" error rather than crashing the controller).
  try {
    if (userDataPath) {
      const { createLoopsService } = requireLoops('loops-service');
      const { validateLoopSpec } = requireLoops('loop-spec');
      const loopsCatalogPath = path.join(userDataPath, 'loops', 'catalog.json');

      // Builtin SYSTEM loops (PRD §10): each runs an in-process aceStore method
      // (systemRunRef), NOT a spine worker. They carry a minimal VALID routing
      // (workspace:'loops', empty target.allow) so the code-kind repo/allow rules in
      // validateLoopSpec never apply, and contract.verify booleans:false (no
      // validator/computer-use). `schedule` mirrors the in-process schedulers in
      // main.cts (display-only). builtin:true ⇒ no delete/edit/forge in the UI.
      const systemLoopMeta = { version: 1 };
      const baseSystemRouting = {
        agent: 'auto' as const,
        skills: [] as string[],
        workspace: 'loops' as const,
        target: { allow: [] as string[] },
      };
      const baseSystemContract = (permissions: string[] = []) => ({
        stop: { primary: 'converged' as const },
        ceilings: {},
        verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
        permissions,
        merge: { ownerGated: true as const },
      });
      // NOTE: mission-archive is intentionally omitted — aceStore.missionArchive
      // does not exist on this base (origin/main), so there is no method to run. The
      // owner-gated machinery (delete_or_archive_data → Run-now disabled until ack)
      // stays in place for any future gated builtin; no current builtin exercises it.
      const builtinSystemLoops: any[] = [
        {
          id: 'sys-knowledge-nightly',
          name: 'Knowledge Nightly',
          description: 'Nightly knowledge reindex, audit, decay and per-project wiki curation.',
          useWhen: 'Nightly knowledge-plane maintenance.',
          kind: 'system',
          inputs: {},
          goalTemplate: 'Run the nightly knowledge reindex + audit + decay pass.',
          routing: baseSystemRouting,
          contract: baseSystemContract([]),
          evidence: {},
          builtin: true,
          systemRunRef: 'sys-knowledge-nightly',
          schedule: 'daily 03:30',
          meta: systemLoopMeta,
        },
        {
          id: 'sys-ops-brief',
          name: 'Ops Brief',
          description: 'Generate and deliver the operations intel brief.',
          useWhen: 'Scheduled Rook ops briefs (07:30 / 13:00 / 20:30).',
          kind: 'system',
          inputs: {},
          goalTemplate: 'Generate and deliver the current operations brief.',
          routing: baseSystemRouting,
          contract: baseSystemContract([]),
          evidence: {},
          builtin: true,
          systemRunRef: 'sys-ops-brief',
          schedule: 'daily 07:30, 13:00, 20:30',
          meta: systemLoopMeta,
        },
        {
          id: 'sys-todo-digest',
          name: 'Todo Digest',
          description: 'Synthesize the twice-daily todo digest (rule-based proposals).',
          useWhen: 'Scheduled todo digests (07:00 morning / 21:00 night).',
          kind: 'system',
          inputs: {},
          goalTemplate: 'Synthesize and deliver the current todo digest.',
          routing: baseSystemRouting,
          contract: baseSystemContract([]),
          evidence: {},
          builtin: true,
          systemRunRef: 'sys-todo-digest',
          schedule: 'daily 07:00, 21:00',
          meta: systemLoopMeta,
        },
      ];

      // Validate each builtin BEFORE wiring (the catalog is fail-closed; an invalid
      // builtin would be silently skipped by seedBuiltins, so surface it here too).
      for (const spec of builtinSystemLoops) {
        try {
          const res = validateLoopSpec(spec);
          if (!res.ok) {
            console.warn(`[ace] builtin loop '${spec.id}' failed validation: ${res.errors.join('; ')}`);
          }
        } catch (err: any) {
          console.warn(`[ace] builtin loop '${spec.id}' validation threw: ${err?.message || err}`);
        }
      }

      // In-process runners for each system loop's "Run now" (NOT a spine worker).
      // Optional-chained: a store missing a method (e.g. missionArchive lives on a
      // sibling branch) returns a clear no-op rather than crashing the runner.
      const systemRunners: Record<string, (inputs: any) => Promise<any> | any> = {
        'sys-knowledge-nightly': () => aceStore.knowledgeNightly({ source: 'loop' }),
        'sys-ops-brief': () => aceStore.opsBriefGenerate({}),
        'sys-todo-digest': () => aceStore.deliverTodoDigest({}),
      };

      // Per-system-loop status reader (system loops have no ledger runs to fold).
      // Best-effort: each branch tolerates a missing store method.
      const systemStatus = (loop: any) => {
        const ref = (loop && (loop.systemRunRef || loop.id)) || '';
        try {
          switch (ref) {
            case 'sys-knowledge-nightly':
              return typeof aceStore.knowledgeNightlyStatus === 'function'
                ? aceStore.knowledgeNightlyStatus()
                : null;
            case 'sys-ops-brief':
              return typeof aceStore.opsBriefSchedule === 'function' ? aceStore.opsBriefSchedule() : null;
            case 'sys-todo-digest':
              return typeof aceStore.opsTodoDigest === 'function' ? aceStore.opsTodoDigest() : null;
            default:
              return { schedule: loop && loop.schedule ? loop.schedule : null };
          }
        } catch {
          return null;
        }
      };

      // Materialize the SSD loop workspace (idempotent + fail-safe) so it appears in
      // the Workspaces sidebar 'System' group and loop agents spawn there in the
      // regular Ace path. ensureLoopWorkspace resolves the SSD root dynamically.
      void Promise.resolve(aceStore.ensureLoopWorkspace?.()).catch(() => {});

      const loopsService = createLoopsService({
        harness: runLedgerHarness,
        driveRun,
        fs: {
          readFile: (p: string) => {
            try {
              return fs.readFileSync(p, 'utf8');
            } catch {
              return null;
            }
          },
          writeFile: (p: string, contents: string) => {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, contents);
          },
        },
        catalogPath: loopsCatalogPath,
        now: () => Date.now(),
        builtins: builtinSystemLoops,
        systemRunners,
        systemStatus,
        workspaceCleanup: {
          userDataPath,
          now: () => Date.now(),
          listWorkspaces: () => aceStore.getState()?.workspaces || [],
          listStreams: () => methods.streamList(),
          runBoard: () => methods.runBoard(),
        },
      });
      Object.assign(methods, {
        loopsList: () => loopsService.listLoops(),
        loopsGet: (p: any) => loopsService.getLoop(p && p.id),
        loopsCompile: (p: any) => loopsService.compileLoop((p && (p.text ?? p.prompt)) || ''),
        loopsLockOn: (p: any) => loopsService.lockOnLoop((p && p.draft) || p || {}),
        loopsSave: (p: any) => loopsService.saveLoop(p && p.spec),
        loopsRun: (p: any) => loopsService.runLoop(p && p.loopId, (p && p.inputs) || {}),
        loopsStop: (p: any) => loopsService.stopLoop(p && (p.invocationId ?? p.loopId)),
        loopsRemove: (p: any) => loopsService.removeLoop(p && p.id),
        loopsStatus: (p: any) => loopsService.loopStatus((p && (p.id ?? p.loopId)) ?? null),
        loopsSelect: (p: any) => loopsService.selectLoop((p && (p.description ?? p.text)) || ''),
        loopsKillAll: () => loopsService.killAllLoops(),
      });

      // Trigger scheduler (PRD §9 Slice 3) is OPT-IN: default behavior is unchanged
      // (explicit launch only). ACE_LOOP_TRIGGERS=1 arms schedule triggers at
      // boot, firing the SAME runLoop the button calls (PRD §7).
      if (process.env.ACE_LOOP_TRIGGERS === '1') {
        try {
          const armed = loopsService.startTriggers();
          if (typeof console !== 'undefined') console.log('[ace] loop triggers armed:', armed.armed);
        } catch (err) {
          if (typeof console !== 'undefined') console.warn('[ace] loop triggers failed to arm:', err);
        }
      }
    }
  } catch (err: any) {
    console.warn('[ace] loops subsystem disabled: ' + (err?.message || err));
  }

  // Boot replay: re-arm the autonomy loop for runs a prior process left open.
  // Idempotent by construction — nextActionForFeature returns SYNC_WORKER for a
  // dispatched-but-incomplete run (never re-DISPATCH), so no duplicate worktree
  // is spawned; merge stays owner-token gated. Skipped when the spine is off.
  if (runLedgerHarness) {
    try {
      const seen = new Set<string>();
      for (const e of runLedgerHarness.ledger.readAll()) {
        const runId = e && e.runId ? String(e.runId) : '';
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        driveRun(runId);
      }
    } catch {}
  }

  return {
    methods,
    bus,
    leanBoard,
    // Subscribe to run-ledger append settles (submit / quiescence / loop stop).
    // main.cts fans this out to the renderer as 'ace:run-ledger-changed' so the
    // read-only board refreshes itself without polling. Returns an unsubscribe.
    onRunLedgerChanged: (listener: any) => {
      runLedgerListeners.add(listener);
      return () => runLedgerListeners.delete(listener);
    },
    shutdown,
    transcripts,
    // Test-only: evaluate synchronously.
    _internal: { screen, sm, trackTab, closeTab, profiles, transcripts, completionInbox, profileForAgent: (a: any) => profileForAgent(profiles, a) },
  };
}

module.exports = { createAceController, loadProfilesFromDisk, profileForAgent };
