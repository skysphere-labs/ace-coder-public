// projection — the six owner PANELS, derived from the event ledger.
//
// These panels are VIEWS, never state owners. The single source of truth is the
// append-only event log (event-ledger.cts); the next-action verdict and merge
// gate are owned by the orchestration-policy spine and surfaced through
// reconciler.reconcile. This module does NO decision logic of its own: it only
// (a) collects the distinct runIds, (b) reconciles each, and (c) buckets the
// resulting summary into exactly one of the six panels by decision.next.
//
// Pure given the event log: no I/O, no Date.now()/Math.random() at module top
// level. The event log is injected (eventLog.readAll()/readRun(runId)).

// Build-agnostic sibling imports: the compiled .cjs is gitignored and may be
// absent in a fresh worktree, so fall back to the .cts that tsx resolves.
let reconcilerModule: any;
try {
  reconcilerModule = require('./reconciler.cjs');
} catch {
  reconcilerModule = require('./reconciler.cts');
}
const { reconcile } = reconcilerModule;

let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS } = orchestrationPolicy;

/**
 * @typedef {Object} Run  A single run's projected summary (a VIEW row).
 * @property {string} runId
 * @property {Object} state          The folded state from the reconciler.
 * @property {Object} decision       The spine next-action verdict.
 * @property {Object|null} gate       The merge-gate verdict (forced on, may be null).
 * @property {string|null} lastEventType  Type of the last event seen for the run.
 * @property {*} lastTs               ts of the last event seen for the run.
 */

// Heuristic split of a `blocked` decision into a SPINE/PREFLIGHT/INFRA block
// (the autonomy loop itself is broken — these should also surface in
// brokenAutonomy so the operator fixes the machinery) versus a PRODUCT block
// (the worker/validator made a legitimate product judgment — these belong only
// in needsChief). We classify off decision.reason because that is the spine's
// own explanation; the product reasons are the small, enumerated set the policy
// emits when a human must rule on scope/correctness, everything else
// (retry-cap exhaustion, unparseable trailers, stale-head reruns, unrecognised
// states) is the autonomy machinery failing and is treated as broken-autonomy.
const PRODUCT_BLOCK_HINTS = Object.freeze([
  'worker returned blocked', // worker BLOCKED outright — human scope/correctness call
  'blocked-scope', // validator VERDICT=blocked-scope
  'request-changes', // simple-mode review repair, owner decides
  'manual-required', // validator needs manual verification
  'computer-use', // validator needs computer-use evidence (a real test gap)
]);

function reasonText(decision: any) {
  return String((decision && decision.reason) || '').toLowerCase();
}

// True when a blocked decision is a spine/preflight/infra failure rather than a
// product judgment. Default to broken-autonomy (true) for any blocked reason
// that does NOT match a known product-block hint: an unexplained block is the
// machinery failing, which is exactly what the operator must see.
function isBrokenAutonomyBlock(decision: any) {
  const reason = reasonText(decision);
  if (PRODUCT_BLOCK_HINTS.some((hint) => reason.includes(hint))) return false;
  return true;
}

// Pull the last event (by array order — the ledger is append-ordered) for a run
// so the panel row can show what most recently happened.
function lastEventFor(events: any[]) {
  if (!Array.isArray(events) || events.length === 0) {
    return { lastEventType: null, lastTs: null };
  }
  const last = events[events.length - 1] || {};
  return {
    lastEventType: last.type == null ? null : String(last.type),
    lastTs: last.ts === undefined ? null : last.ts,
  };
}

// Build the per-run summary VIEW. Forces the gate on (wantGate) so readyToShip
// can read gate?.ok even when the spine's next action is dispatch_release_goal
// (which does not itself compute the gate).
function summarizeRun(runId: string, eventLog: any): any {
  const { state, decision, gate, autoship } = reconcile(runId, eventLog, { wantGate: true });
  const events = typeof eventLog.readRun === 'function' ? eventLog.readRun(runId) : [];
  const { lastEventType, lastTs } = lastEventFor(events);
  return { runId, state, decision, gate, autoship, lastEventType, lastTs };
}

// Distinct runIds in first-seen order, so panels keep a stable, deterministic
// ordering that follows the ledger.
function distinctRunIds(events: any[]) {
  const ids: string[] = [];
  const seen = new Set();
  for (const raw of Array.isArray(events) ? events : []) {
    const runId = raw && raw.runId != null ? String(raw.runId) : '';
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    ids.push(runId);
  }
  return ids;
}

/**
 * Derive the six owner panels from the event ledger.
 *
 * Each run lands in EXACTLY ONE primary panel, bucketed by decision.next:
 *   intake        dispatch_goal_worker (worker not dispatched yet / no run)
 *   active        sync_worker | dispatch_goal_validator | dispatch_fixback_worker
 *   needsChief    blocked
 *   readyToShip   gate (gate.ok) | dispatch_release_goal | nothing-but-not-terminal
 *   recent        terminal: merged & cleaned up (decision.next === nothing) or released
 *   brokenAutonomy  MIRROR of the needsChief runs whose block is a spine/
 *                   preflight/infra failure (not a product judgment).
 *
 * A blocked run with a product reason appears only in needsChief; a blocked run
 * with a spine/infra reason appears in needsChief AND is mirrored into
 * brokenAutonomy.
 *
 * @param {{ readAll: Function, readRun: Function }} eventLog
 * @returns {{ intake: Run[], active: Run[], needsChief: Run[], readyToShip: Run[], brokenAutonomy: Run[], recent: Run[] }}
 */
function project(eventLog: any) {
  const panels: any = {
    intake: [],
    active: [],
    needsChief: [],
    readyToShip: [],
    brokenAutonomy: [],
    recent: [],
  };
  if (!eventLog || typeof eventLog.readAll !== 'function') return panels;

  const allEvents = eventLog.readAll();
  for (const runId of distinctRunIds(allEvents)) {
    const run = summarizeRun(runId, eventLog);
    const next = run.decision && run.decision.next;

    switch (next) {
      case NEXT_ACTIONS.DISPATCH_GOAL_WORKER:
        panels.intake.push(run);
        break;

      case NEXT_ACTIONS.SYNC_WORKER:
      case NEXT_ACTIONS.DISPATCH_GOAL_VALIDATOR:
      case NEXT_ACTIONS.DISPATCH_FIXBACK_WORKER:
        panels.active.push(run);
        break;

      case NEXT_ACTIONS.BLOCKED:
        panels.needsChief.push(run);
        // brokenAutonomy MIRRORS the spine/preflight/infra blocks only.
        if (isBrokenAutonomyBlock(run.decision)) panels.brokenAutonomy.push(run);
        break;

      case NEXT_ACTIONS.GATE:
      case NEXT_ACTIONS.DISPATCH_RELEASE_GOAL:
        panels.readyToShip.push(run);
        break;

      case NEXT_ACTIONS.NOTHING:
        // The spine reports `nothing` only when a feature is merged AND cleaned
        // up — that is the terminal/recent state. A `released` event reinforces
        // it. If for any reason `nothing` is reached without a merge, keep it in
        // readyToShip rather than implying a completed ship.
        if (run.state && run.state.merge && run.state.merge.merged) {
          panels.recent.push(run);
        } else if (run.lastEventType === 'released' || run.lastEventType === 'merged') {
          panels.recent.push(run);
        } else {
          panels.readyToShip.push(run);
        }
        break;

      default:
        // Unknown next-action: surface as needs-chief so it is never silently
        // dropped from the owner's view.
        panels.needsChief.push(run);
        break;
    }
  }

  return panels;
}

module.exports = {
  project,
  isBrokenAutonomyBlock,
};
