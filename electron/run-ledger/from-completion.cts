// from-completion — the Ring 2 event-source mapper.
//
// acespinekernelprune.md §3: the completion observer
// (ace-control/index.cts:196 observeCompletions) is the canonical event
// source. It already builds completion RECORDS (taskId, laneId/featureId, kind,
// detail, streamId, ...). This module translates ONE such record into ONE
// append-only kernel event, so the observer can mirror every real completion
// into the run-ledger with a single `kernel.recordEvent(fromCompletion(record))`
// — additively, changing no existing behavior.
//
// A record carrying a validator VERDICT (detail parses to a verdict) becomes a
// `validator.completed` event whose payload.record the reconciler re-parses via
// parseValidatorRecordVerdict (single source of verdict truth). Any other
// done/blocked record becomes a `worker.completed` event with DONE/BLOCKED.
//
// Pure module: no I/O, no clocks. Deterministic given the record.

// Build-agnostic spine import: .cjs is gitignored and may be absent in a fresh
// worktree, so fall back to the .cts that tsx resolves.
let verdictModule: any;
try {
  verdictModule = require('../../tools/ace/src/verdict.cjs');
} catch {
  verdictModule = require('../../tools/ace/src/verdict.cts');
}
const { parseValidatorRecordVerdict } = verdictModule;

// The runId for a completion is the feature/lane it belongs to, falling back to
// the task id. (The mission domain keys features by laneId === featureId.)
function runIdFor(record: any) {
  const r = record && typeof record === 'object' ? record : {};
  const row = r.registryRow && typeof r.registryRow === 'object' ? r.registryRow : {};
  const id = r.featureId || r.laneId || row.laneId || r.taskId || row.taskId || '';
  return id ? String(id) : '';
}

// detail string the verdict parser reads (mirrors the observer's own lookup).
function detailOf(record: any) {
  const r = record && typeof record === 'object' ? record : {};
  return String(r.detail || (r.trailer && r.trailer.detail) || '');
}

// The codename of the agent that produced this completion — used to key/label
// the board card by the working agent. Falls back across the record shapes the
// observer builds.
function agentOf(record: any) {
  const r = record && typeof record === 'object' ? record : {};
  const row = r.registryRow && typeof r.registryRow === 'object' ? r.registryRow : {};
  const id = r.agent || r.assignee || r.codename || row.agent || row.assignee || row.codename || null;
  return id ? String(id) : null;
}

// Telemetry the agent attached to its completion (rubric/commands/duration/its
// own token spend). Pulled through verbatim so the watcher folds it for free.
// `agent` is back-filled so a card always knows who did the work.
function telemetryOf(record: any, agent: string | null) {
  const r = record && typeof record === 'object' ? record : {};
  const t = r.telemetry && typeof r.telemetry === 'object' && !Array.isArray(r.telemetry) ? r.telemetry : null;
  if (!t) return undefined;
  return t.agent != null ? t : { ...t, agent };
}

/**
 * AUTO-COLLECTED telemetry for a completion record that carries none — the
 * Ring-2 seam that makes every card self-populate with ZERO agent cooperation.
 * Computes what the spine already knows for free:
 *   agent       from the record/registry row (agentOf)
 *   durationMs  completion timestamp minus the newest *.dispatch.linked ts in
 *               the run's ledger slice (the spine stamped both clocks itself)
 * Returns null when the record already has real telemetry (agent-written wins)
 * or when there is nothing computable. Descriptive only — folded by
 * mergeTelemetry like any agent-written telemetry, never read by decisions.
 *
 * @param {any} record        A completion-inbox record from observeCompletions.
 * @param {any[]} runEvents   The run's ledger events (eventLog.readRun(runId)).
 * @returns {{ agent: string|null, durationMs: number, notes: string } | null}
 */
function autoTelemetryFor(record: any, runEvents: any[]) {
  const r = record && typeof record === 'object' ? record : {};
  if (r.telemetry && typeof r.telemetry === 'object' && !Array.isArray(r.telemetry)) return null;
  const agent = agentOf(r);
  const list = Array.isArray(runEvents) ? runEvents : [];
  let linkedTs: number | null = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (!e || typeof e.type !== 'string' || !e.type.endsWith('.dispatch.linked')) continue;
    const ts = Number(e.ts);
    if (Number.isFinite(ts)) {
      linkedTs = ts;
      break;
    }
  }
  const completionTs = Number(r.timestamp);
  const durationMs =
    linkedTs != null && Number.isFinite(completionTs) && completionTs >= linkedTs
      ? completionTs - linkedTs
      : 0;
  if (agent == null && durationMs === 0) return null; // nothing computable
  return { agent, durationMs, notes: 'auto-collected:spine' };
}

/**
 * Translate a completion record into a single kernel event, or null when the
 * record cannot map (no runId, or not a terminal done/blocked completion).
 *
 * @param {any} record  A completion-inbox record from observeCompletions.
 * @returns {{ runId:string, type:string, payload:object } | null}
 */
function fromCompletion(record: any, runIdOverride?: any) {
  const r = record && typeof record === 'object' ? record : {};
  // A spine-dispatched task carries no mission feature/lane, so runIdFor would
  // key the completion by taskId and open a PHANTOM run. The caller resolves the
  // originating spine runId from the dispatch annotation and passes it here; it
  // wins over the taskId fallback so the completion closes the right run.
  const override = runIdOverride != null && String(runIdOverride).trim() ? String(runIdOverride).trim() : '';
  const runId = override || runIdFor(r);
  if (!runId) return null;

  const kind = String(r.kind || '').toLowerCase();
  const detail = detailOf(r);
  const agent = agentOf(r);
  const telemetry = telemetryOf(r, agent);

  // Validator verdicts ride the same completion stream; route them to a
  // validator.completed event so the reconciler folds the parsed verdict.
  const parsed = detail ? parseValidatorRecordVerdict({ detail }) : null;
  if (parsed && parsed.verdict) {
    return {
      runId,
      type: 'validator.completed',
      payload: {
        record: { detail },
        validatedHeadSha: r.headSha || r.currentHeadSha || null,
        streamId: r.streamId || null,
        agent,
        ...(telemetry !== undefined ? { telemetry } : {}),
      },
    };
  }

  // Only terminal worker outcomes become events; progress/unknown are skipped
  // (the observer still emits its own bus events for those).
  if (kind === 'done' || kind === 'done-unverified' || kind === 'blocked') {
    return {
      runId,
      type: 'worker.completed',
      payload: {
        outcome: kind === 'blocked' ? 'BLOCKED' : 'DONE',
        detail: detail || null,
        currentHeadSha: r.headSha || r.currentHeadSha || null,
        taskId: r.taskId || null,
        streamId: r.streamId || null,
        agent,
        ...(telemetry !== undefined ? { telemetry } : {}),
      },
    };
  }

  return null;
}

/**
 * True only when the reconciled run is still WAITING on this exact stream —
 * the sole condition under which a raw-ring trailer may become a completion.
 * A finished run refuses (no stale-run pollution from later human turns on
 * the same tab); a re-dispatched fixback links a fresh generation and passes.
 *
 * @param {any} state      Reconciled run state (kernel.reconcile(runId).state).
 * @param {any[]} runEvents The run's ledger events (readRun(runId)).
 * @param {any} streamId   The stream that produced the trailer.
 * @returns {boolean}
 */
function runWaitingForStream(state: any, runEvents: any[], streamId: any) {
  const sid = streamId == null ? '' : String(streamId);
  if (!sid) return false;
  const st = state && typeof state === 'object' ? state : {};
  const worker = st.worker && typeof st.worker === 'object' ? st.worker : {};
  const validator = st.validator && typeof st.validator === 'object' ? st.validator : {};
  let phase = '';
  if (validator.dispatched && !validator.done) phase = 'validator';
  else if ((worker.dispatched && !worker.done) || worker.fixbackInFlight) phase = 'worker';
  if (!phase) return false;
  const wantType = `${phase}.dispatch.linked`;
  const list = Array.isArray(runEvents) ? runEvents : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (!e || e.type !== wantType || !e.payload) continue;
    return String(e.payload.streamId || '') === sid;
  }
  return false;
}

/**
 * Admission decision for a raw-ring trailer the state machine reconciled:
 *   'record'  — the run is waiting on this stream; record the completion.
 *   'consume' — definitively not ours (no link in a populated ledger, or the
 *               run is not waiting); drop the trailer.
 *   'retry'   — indeterminate (no harness yet, or an empty ledger read that
 *               may be a masked I/O failure); keep the trailer pending.
 */
function rawTrailerAdmission({ harnessAvailable, ledgerEvents, spineRunId, reconciledState, runEvents, streamId }: any = {}) {
  if (!harnessAvailable) return 'retry';
  if (!spineRunId) {
    const events = Array.isArray(ledgerEvents) ? ledgerEvents : [];
    return events.length > 0 ? 'consume' : 'retry';
  }
  return runWaitingForStream(reconciledState, runEvents, streamId) ? 'record' : 'consume';
}

module.exports = { fromCompletion, autoTelemetryFor, runWaitingForStream, rawTrailerAdmission };
