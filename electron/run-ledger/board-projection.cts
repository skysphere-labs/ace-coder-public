// board-projection — the LEAN mission board, derived from the run-ledger.
//
// Owner decision (2026-06-15): simplify the board UI to a lifecycle view, then
// delete the rich mission domain. This is the READ side of that path: it maps
// the spine's six-panel projection into a small, board-shaped structure the
// simplified UI can render — columns (todo / in_progress / ready_to_review /
// done / blocked) of cards carrying ~9 fields, NOT the 72-field rich card.
//
// VIEW-ONLY — the board is a WATCHER, never a gate (owner directive 2026-06-15).
// The autonomy loop NEVER reads or waits on this board: the loop runs on the
// event ledger + the spine (reconciler decisions + drivers). The board only
// derives itself from the same events and auto-moves cards. It has ZERO
// side-effects — unlike the old getMissionBoard, which did archive DB WRITES
// inside its read (cleanupMerged/Superseded) and was glued into the loop, making
// the system slow and token-wasteful. Nothing has to "update the board"; it is a
// pure function of the events. Recompute it on read; the UI re-fetches on change.
//
// It is a pure VIEW over the event ledger: no new decision logic (the panels
// come from projection.project, which reconciles each run via the spine). The
// descriptive fields (name / mission / workspace / branch / assignee) ride the
// intake `spec` captured at submitIntent — no event-schema change is required,
// the spec is freeform. PR facts come from gate.evaluated events.
//
// AGENT-KEYED CARDS + TELEMETRY: each card carries the codename of the agent
// working it (`agentId`, surfaced in the display `key`) and a telemetry summary
// (rubric/score/commands/duration/token-cost) that the AGENT wrote into the
// ledger when it finished. The board only FOLDS that telemetry — it spends zero
// tokens collecting it. Distinct agent-tasks (distinct runIds) are distinct
// cards; the runId stays the spine's per-run lifecycle key.

// Sibling import — .cts first so esbuild inlines it (a .cjs-first require breaks
// inside the bundle; see reference notes). tsx resolves the .cts for tests.
let projectionModule: any;
try {
  projectionModule = require('./projection.cts');
} catch {
  projectionModule = require('./projection.cjs');
}
const { project } = projectionModule;

let taskTitleModule: any;
try {
  taskTitleModule = require('../task-title.cts');
} catch {
  taskTitleModule = require('../task-title.cjs');
}
const { deriveTaskTitle } = taskTitleModule;

// The five PRIMARY projection panels map 1:1 to lean board columns. (Operations'
// brokenAutonomy panel is a MIRROR of needsChief, so it is not iterated here —
// each run lands in exactly one column.)
const PANEL_STAGE: any = Object.freeze({
  intake: 'todo',
  active: 'in_progress',
  readyToShip: 'ready_to_review',
  recent: 'done',
  needsChief: 'blocked',
});

const STAGES = Object.freeze(['todo', 'in_progress', 'ready_to_review', 'done', 'blocked']);

function asObject(v: any) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Summarize the run's folded telemetry into the few fields a card shows. The
// agent WROTE this on finish; the board only reads it — zero token cost.
function leanTelemetryFrom(state: any) {
  const tel = asObject(state.telemetry);
  const totals = asObject(tel.totals);
  const latest = asObject(tel.latest);
  if (!tel.latest && (!tel.entries || tel.entries.length === 0)) return null;
  return {
    agent: latest.agent || null,
    rubric: latest.rubric || null,
    score: typeof latest.score === 'number' ? latest.score : null,
    commands: Number(totals.commands) || 0,
    durationMs: Number(totals.durationMs) || 0,
    tokens: Number(totals.tokens) || 0,
    reports: Number(totals.runs) || (Array.isArray(tel.entries) ? tel.entries.length : 0),
  };
}

// Coerce acceptance/constraints rows (strings OR {text} objects) to non-empty
// strings — the intake spec is freeform, so the board reads either shape.
function toStringList(items: any): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    if (typeof it === 'string' && it.trim()) out.push(it.trim());
    else if (it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim()) out.push(it.text.trim());
  }
  return out;
}

// Lifecycle transition history for the detail drawer: a CAPPED, newest-last
// list of {type, ts} folded from the run's own ledger slice. Only lifecycle
// events qualify (submit/dispatch/complete/validate/gate/merge/release/
// fixback/autoship) and payloads are always dropped, so 95 runs of history
// stay a tiny fraction of the board payload — this is a transition trail,
// not a transcript.
const HISTORY_CAP = 30;
const HISTORY_TYPE_RE = /^(run\.|worker\.|validator\.|gate\.|fixback\.|autoship\.)|^(merged|released)$/;
function historyFrom(events: any[]) {
  if (!Array.isArray(events)) return [];
  const out: any[] = [];
  for (const e of events) {
    if (!e || typeof e.type !== 'string' || !HISTORY_TYPE_RE.test(e.type)) continue;
    out.push({ type: e.type, ts: e.ts === undefined ? null : e.ts });
  }
  return out.slice(-HISTORY_CAP);
}

// The durable dispatch annotation a *.dispatch.linked event carries (taskId/
// streamId/branch/worktreePath) — the card's deep-link to the live worker. Last
// one wins (a re-dispatch supersedes). Pure read; no fold.
function linkOfType(events: any[], type: string) {
  if (!Array.isArray(events)) return {};
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.type === type && e.payload) return asObject(e.payload);
  }
  return {};
}

function indexedEventLog(eventLog: any) {
  if (!eventLog || typeof eventLog.readAll !== 'function') return eventLog;
  const allEvents = eventLog.readAll();
  const byRun = new Map();
  for (const e of Array.isArray(allEvents) ? allEvents : []) {
    const runId = e && e.runId != null ? String(e.runId) : '';
    if (!runId) continue;
    const list = byRun.get(runId);
    if (list) list.push(e);
    else byRun.set(runId, [e]);
  }
  return {
    readAll: () => allEvents.slice(),
    readRun: (runId: any) => {
      const id = String(runId == null ? '' : runId);
      return (byRun.get(id) || []).slice();
    },
  };
}

// The RICH per-card detail the expanded JIRA-style ticket renders. EVERY field
// is folded from data the reconcile already computed (spec/worker/validator/pr/
// merge/decision/gate) plus the durable dispatch links — the board spends zero
// agent tokens collecting it. Raw ledger event history is intentionally not
// copied into every card; the drawer's transition trail is the CAPPED,
// types-only `history` fold — the board stays a lifecycle summary, not a
// transcript viewer.
function leanDetailFrom(state: any, events: any[], decision: any, gate: any, autoship: any = null) {
  const spec = asObject(state.spec);
  const worker = asObject(state.worker);
  const validator = asObject(state.validator);
  const pr = asObject(state.pr);
  const merge = asObject(state.merge);
  const workerLink = linkOfType(events, 'worker.dispatch.linked');
  const validatorLink = linkOfType(events, 'validator.dispatch.linked');
  return {
    description: spec.goal || spec.name || null,
    context: spec.context != null && String(spec.context).trim() ? String(spec.context) : null,
    acceptance: toStringList(spec.acceptance),
    constraints: toStringList(spec.constraints),
    risk: spec.risk != null ? String(spec.risk) : null,
    // The worker the brain spawned — its live terminal stream + the branch/
    // worktree the gate and merge act on.
    worker: {
      taskId: workerLink.taskId != null ? String(workerLink.taskId) : null,
      streamId: workerLink.streamId != null ? String(workerLink.streamId) : null,
      workspaceId: workerLink.workspaceId || asObject(spec.scope).workspaceId || spec.workspaceId || null,
      branch: workerLink.branch || spec.branch || null,
      worktreePath: workerLink.worktreePath || null,
      outcome: worker.outcome && worker.outcome !== 'NONE' ? worker.outcome : null,
      // Fail-closed signal: when the spawn/link failed, the card carries the
      // exact error (and the run sits in the blocked column) instead of showing
      // a healthy in-flight worker with null task/stream/worktree fields.
      dispatchError: worker.dispatchFailed === true ? (worker.dispatchError || 'worker dispatch failed') : null,
    },
    // The codex validator (always codex) + its computer-use evidence.
    validator: {
      taskId: validatorLink.taskId != null ? String(validatorLink.taskId) : null,
      streamId: validatorLink.streamId != null ? String(validatorLink.streamId) : null,
      outcome: validator.outcome && validator.outcome !== 'NONE' ? validator.outcome : null,
      computerUseRequired: validator.computerUseRequired === true,
      evidence: validator.computerUseEvidence != null ? String(validator.computerUseEvidence) : null,
    },
    pr: {
      number: pr.number ?? null,
      url: pr.url || null,
      state: pr.state || null,
      mergeable: pr.mergeable != null ? String(pr.mergeable) : null,
      checkState: pr.checkState != null ? String(pr.checkState) : null,
      changedFiles: Array.isArray(pr.changedFiles) ? pr.changedFiles.slice(0, 50) : [],
    },
    merge: { merged: merge.merged === true, sha: merge.sha || null, cleanedUp: merge.cleanedUp === true },
    decision: { next: (decision && decision.next) || null, reason: (decision && decision.reason) || null },
    // Capped lifecycle transition trail (types only, newest last) for the
    // ticket drawer — see historyFrom for the cap + type filter.
    history: historyFrom(events),
    gate: gate ? { ok: gate.ok === true, reason: gate.reason || null } : null,
    autoship: autoship
      ? {
          enabled: autoship.enabled === true,
          status: autoship.status || null,
          autoMergeAllowed: autoship.autoMergeAllowed === true,
          autoBuildAllowed: autoship.autoBuildAllowed === true,
          requiresOwnerApproval: autoship.requiresOwnerApproval === true,
          reason: autoship.reason || null,
        }
      : null,
  };
}

// Autonomy OUTER-loop lineage info for a card, or null when the run isn't part
// of a loop. Surfaces cycle N / cap + the latest settle decision (terminal +
// gaps found) from this run's next-goal.derived event, so the Run Board can show
// "loop run-7 · cycle 2/5 · 1 gap → continue". Additive; non-loop cards omit it.
function loopInfoFrom(spec: any, runId: any, events: any[]) {
  if (!spec || spec.autoIterate !== true) return null;
  const lineageId = spec.loopLineageId ? String(spec.loopLineageId) : String(runId);
  let latest: any = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (e && e.type === 'next-goal.derived' && e.payload && String(e.payload.parentRunId || '') === String(runId)) {
      latest = e.payload;
    }
  }
  return {
    lineageId,
    iteration: Number(spec.iteration) || 1,
    maxIterations: Number(spec.maxIterations) || 0,
    parentRunId: spec.parentRunId || null,
    terminal: latest ? (latest.terminal || null) : null,
    gaps: latest && Array.isArray(latest.followups) ? latest.followups.length : null,
    computerUseEvidence: latest ? latest.computerUseEvidence === true : null,
  };
}

function numericTs(value: any) {
  if (value == null || value === '') return null; // Number(null) is 0 — never a ts
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// AUTO-COLLECTED lifecycle summary for a card, derived from the reconciler's
// folded timeline (event ts stamps — zero agent cooperation) plus an optional
// injected `now`. Descriptive only; when `now` is null (deterministic tests,
// replay) the relative ages are omitted rather than guessed.
function lifecycleFrom(run: any, state: any, now: any) {
  const timeline = asObject(state.timeline);
  const createdAt = numericTs(timeline.createdAt);
  const lastTs = numericTs(run.lastTs != null ? run.lastTs : timeline.lastTs);
  const nowTs = numericTs(now);
  const workStart = numericTs(timeline.linkedAt) ?? numericTs(timeline.dispatchedAt) ?? createdAt;
  const workEnd = numericTs(timeline.workerCompletedAt);
  return {
    timeline: {
      createdAt,
      dispatchedAt: numericTs(timeline.dispatchedAt),
      linkedAt: numericTs(timeline.linkedAt),
      workerCompletedAt: workEnd,
      validatorCompletedAt: numericTs(timeline.validatorCompletedAt),
      mergedAt: numericTs(timeline.mergedAt),
      lastTs,
    },
    ageMs: nowTs != null && createdAt != null ? Math.max(0, nowTs - createdAt) : null,
    idleMs: nowTs != null && lastTs != null ? Math.max(0, nowTs - lastTs) : null,
    // Wall-clock work duration: dispatch link -> worker completion. Falls back
    // to null (never guesses) when either edge is missing.
    durationMs: workStart != null && workEnd != null && workEnd >= workStart ? workEnd - workStart : null,
  };
}

// Build a lean card from a projection run summary + its column/stage. `events`
// is the run's raw ledger slice for worker/validator links; pass [] when
// unavailable and the detail degrades gracefully. `now` (optional, injected)
// only adds descriptive age fields — omitted when absent so the projection
// stays deterministic.
function leanCardFrom(run: any, stage: string, events: any[] = [], now: any = null) {
  const state = asObject(run.state);
  const spec = asObject(state.spec);
  const pr = asObject(state.pr);
  const worker = asObject(state.worker);
  const validator = asObject(state.validator);
  const merge = asObject(state.merge);
  const autoship = run.autoship?.enabled === true ? run.autoship : null;
  const telemetry = leanTelemetryFrom(state);
  const lifecycle = lifecycleFrom(run, state, now);
  const workerLink = linkOfType(events, 'worker.dispatch.linked');
  const currentHeadSha = state.currentHeadSha || pr.headSha || merge.headSha || null;
  const validatedHeadSha = state.validatedHeadSha || validator.validatedHeadSha || null;
  // The card is keyed by the AGENT that is working it: telemetry the agent wrote
  // wins, else the spec'd driver/assignee. Cards therefore carry the worker's
  // identity, and distinct agent-tasks (distinct runIds) are distinct cards.
  const agentId = (telemetry && telemetry.agent) || spec.driver || spec.agent || spec.assignee || null;
  const name = deriveTaskTitle({
    label: spec.label,
    goal: spec.goal,
    prompt: spec.context,
    agent: agentId,
    fallback: spec.name || run.runId,
  });
  return {
    id: run.runId,
    // A human card key that surfaces the working agent without fragmenting the
    // spine's per-run history (the runId stays the lifecycle key).
    key: agentId ? `${agentId}/${run.runId}` : run.runId,
    agentId,
    name: name || run.runId,
    missionId: spec.missionId || null,
    // The intake intent carries the workspace under scope.workspaceId (the spine
    // intent shape), so fall back to it — otherwise a real linked run would show
    // a null workspaceId on the board even though `ace ls` has the stream.
    workspaceId: spec.workspaceId || asObject(spec.scope).workspaceId || null,
    stage,
    assignee: agentId,
    branch: workerLink.branch || spec.branch || pr.headBranch || null,
    prUrl: pr.url || null,
    prStatus: pr.state || null,
    // Exact-head proof inputs for external writeback. Descriptive only: the
    // bridge may publish validation proof iff both are non-null and equal.
    currentHeadSha,
    validatedHeadSha,
    skysphereRef: typeof spec.skysphereRef === 'string' ? spec.skysphereRef : null,
    skysphere: spec.skysphere && typeof spec.skysphere === 'object' && !Array.isArray(spec.skysphere)
      ? { ...spec.skysphere }
      : null,
    workerOutcome: worker.outcome && worker.outcome !== 'NONE' ? worker.outcome : null,
    validationStatus: merge.merged === true ? 'MERGED' : validator.outcome && validator.outcome !== 'NONE' ? validator.outcome : null,
    blocked: stage === 'blocked',
    nextAction: (run.decision && run.decision.next) || null,
    autoshipStatus: autoship?.status || null,
    autoshipReason: autoship?.reason || null,
    telemetry,
    lastEventType: run.lastEventType || null,
    // AUTO-COLLECTED lifecycle facts (event-ts folds — zero agent cooperation):
    // when the run last moved, how old it is, and how long the worker took.
    // lastTs doubles as what the renderer uses to split long-done runs into
    // the collapsed Archived strip.
    lastTs: run.lastTs !== undefined && run.lastTs !== null ? run.lastTs : lifecycle.timeline.lastTs,
    lastTransition: run.lastEventType
      ? { type: String(run.lastEventType), ts: run.lastTs !== undefined ? run.lastTs : null }
      : null,
    timeline: lifecycle.timeline,
    ageMs: lifecycle.ageMs,
    idleMs: lifecycle.idleMs,
    durationMs: lifecycle.durationMs != null ? lifecycle.durationMs : telemetry && telemetry.durationMs > 0 ? telemetry.durationMs : null,
    // Autonomy outer-loop lineage (cycle N/cap + latest settle), or null.
    loop: loopInfoFrom(spec, run.runId, events),
    // The rich JIRA-style ticket body — folded for free from the same reconcile.
    detail: leanDetailFrom(state, events, run.decision, run.gate, autoship),
  };
}

/**
 * Project the event ledger into a lean board: column id-lists + the card array.
 * READ-ONLY: a pure function of the events (plus the OPTIONAL injected `now`,
 * which only adds descriptive card ages — omit it and the output is fully
 * deterministic). It never appends, never locks, never touches disk.
 * @param {{ readAll: Function, readRun: Function }} eventLog
 * @param {{ now?: number|null }} [opts]
 * @returns {{ columns: Record<string,string[]>, cards: object[], counts: object }}
 */
function projectLeanBoard(eventLog: any, opts: any = {}) {
  const now = opts && opts.now != null && Number.isFinite(Number(opts.now)) ? Number(opts.now) : null;
  const indexedLog = indexedEventLog(eventLog);
  const panels = project(indexedLog);
  const columns: any = { todo: [], in_progress: [], ready_to_review: [], done: [], blocked: [] };
  const cards: any[] = [];
  const seen = new Set();

  for (const panelKey of Object.keys(PANEL_STAGE)) {
    const stage = PANEL_STAGE[panelKey];
    for (const run of panels[panelKey] || []) {
      if (!run || seen.has(run.runId)) continue; // each run lands in one column
      seen.add(run.runId);
      // Read the run's indexed ledger slice for the worker links
      // the rich detail needs; the panel summary doesn't carry them.
      const events = typeof indexedLog.readRun === 'function' ? indexedLog.readRun(run.runId) : [];
      cards.push(leanCardFrom(run, stage, events, now));
      columns[stage].push(run.runId);
    }
  }

  return {
    columns,
    cards,
    counts: {
      todo: columns.todo.length,
      inProgress: columns.in_progress.length,
      readyToReview: columns.ready_to_review.length,
      done: columns.done.length,
      blocked: columns.blocked.length,
      total: cards.length,
    },
  };
}

module.exports = { projectLeanBoard, PANEL_STAGE, STAGES };
