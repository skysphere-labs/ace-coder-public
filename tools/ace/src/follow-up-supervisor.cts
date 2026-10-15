const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_SCHEMA = 'ace.follow-ups.v1';
const DIGEST_SCHEMA = 'ace.follow-up-digest.v1';
const DEFAULT_NEXT_CHECK_MS = 30_000;

const ACTIONABLE_PHASES = new Set([
  'worker-done-unvalidated',
  'PR-checks-running',
  'fixback-needed',
  'ready-to-review',
  'merge-ready',
  'blocked',
  'shipped',
]);
const HIDDEN_DIGEST_PHASES = new Set(['shipped', 'parked']);

function defaultFollowUpStorePath() {
  if (process.env.ACE_FOLLOW_UP_STORE_PATH) return process.env.ACE_FOLLOW_UP_STORE_PATH;
  const home = process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder');
  return path.join(home, 'follow-ups.json');
}

function createMemoryDb() {
  const records = new Map();
  return {
    get(id: any) {
      return records.get(id) || null;
    },
    set(id: any, record: any) {
      records.set(id, record);
    },
    delete(id: any) {
      records.delete(id);
    },
    all() {
      return Array.from(records.values());
    },
  };
}

function createFileDb(filePath: any) {
  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.$schema === STORE_SCHEMA && parsed.records && typeof parsed.records === 'object') {
        return parsed.records;
      }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  function writeAll(records: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ $schema: STORE_SCHEMA, records }, null, 2));
  }
  return {
    get(id: any) {
      return readAll()[id] || null;
    },
    set(id: any, record: any) {
      const all = readAll();
      all[id] = record;
      writeAll(all);
    },
    delete(id: any) {
      const all = readAll();
      delete all[id];
      writeAll(all);
    },
    all() {
      return Object.values(readAll());
    },
  };
}

function clean(value: any) {
  const text = String(value ?? '').trim();
  return text || null;
}

function lower(value: any) {
  return String(value ?? '').trim().toLowerCase();
}

function numberOrNull(value: any) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function first(...values: any[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function followUpId(input: any = {}) {
  const workspaceId = clean(input.workspaceId);
  if (clean(input.runId)) return `run:${input.runId}`;
  if (clean(input.taskId)) return `task:${input.taskId}`;
  if (clean(input.streamId)) return `stream:${input.streamId}`;
  if (input.prNumber != null) return `pr:${workspaceId || 'unknown'}:${Number(input.prNumber)}`;
  return null;
}

function hasFailure(gate: any, code: string) {
  return Array.isArray(gate?.failures) && gate.failures.some((failure: any) => failure?.code === code);
}

function gateFailureCodes(gate: any) {
  return Array.isArray(gate?.failures)
    ? gate.failures.map((failure: any) => clean(failure?.code)).filter(Boolean)
    : [];
}

function evidenceLink(input: any = {}) {
  if (input.prUrl) return input.prUrl;
  if (input.streamId) return `ace screen ${input.streamId}`;
  if (input.runId) return 'ace run board --json';
  return null;
}

function checkSummary(phase: string, input: any = {}) {
  const pr = input.prNumber != null ? `PR #${input.prNumber}` : 'the lane';
  switch (phase) {
    case 'dispatched':
    case 'waiting-worker':
      return `Worker is still running; manager will keep watching ${pr}.`;
    case 'worker-done-unvalidated':
      return 'Worker reported DONE; validate the output or open/link the PR before merge decisions.';
    case 'validating':
      return 'Validation is still in progress or required before the next gate.';
    case 'fixback-needed':
      return `${pr} needs repair before review can continue.`;
    case 'PR-checks-running':
      return `${pr} is open and checks are still running.`;
    case 'ready-to-review':
      return `${pr} is ready for owner review.`;
    case 'merge-ready':
      return `${pr} passed the merge gate and is ready for the owner merge decision.`;
    case 'parked':
      return `${pr} is parked or closed; no automatic follow-up is pending.`;
    case 'shipped':
      return `${pr} is merged; follow-up is complete.`;
    case 'blocked':
      return `${pr} is blocked and needs intervention.`;
    default:
      return 'Manager follow-up is pending.';
  }
}

function ownerPacket(record: any) {
  const phase = record.phase;
  const pr = record.prNumber != null ? `PR #${record.prNumber}` : 'the lane';
  let ownerCanDo = 'No owner action yet; wait for the next tracked transition.';
  let managerTracks = 'The manager will keep checking the lane automatically.';
  let nextDecisionGate = record.nextAction || 'wait for a live transition';

  if (phase === 'worker-done-unvalidated') {
    ownerCanDo = 'Review the worker output or ask the manager to validate it.';
    nextDecisionGate = 'validation or PR linkage';
  } else if (phase === 'fixback-needed') {
    ownerCanDo = `Wait for the manager to dispatch fixback on ${pr}, or choose to take over.`;
    managerTracks = 'The manager will track the fixback and checks.';
    nextDecisionGate = 'fixback DONE followed by passing checks';
  } else if (phase === 'ready-to-review') {
    ownerCanDo = `Review ${pr} and decide approve, request changes, park, or merge.`;
    nextDecisionGate = 'owner review';
  } else if (phase === 'merge-ready') {
    ownerCanDo = `Merge ${pr} after final owner review, or park it.`;
    nextDecisionGate = 'owner merge/park decision';
  } else if (phase === 'blocked') {
    ownerCanDo = record.stopCondition || 'Resolve the blocker or cancel the lane.';
    nextDecisionGate = 'blocker resolution';
  } else if (phase === 'shipped') {
    ownerCanDo = 'Nothing; the PR is merged.';
    managerTracks = 'Tracking stopped because the terminal condition was reached.';
    nextDecisionGate = 'none';
  } else if (phase === 'parked') {
    ownerCanDo = 'Nothing automatic; reopen or cancel explicitly if needed.';
    managerTracks = 'Tracking is parked and will not ping unless adopted again.';
    nextDecisionGate = 'owner cancellation/reopen';
  }

  return {
    ownerCanDo,
    managerTracks,
    nextDecisionGate,
    terminalCondition: record.stopCondition,
  };
}

function classifyFollowUp(input: any = {}) {
  const row = input.row || {};
  const child = input.child || {};
  const pr = input.pr || {};
  const stale = input.stale || {};
  const gate = pr.gate || input.gate || null;
  const now = Number(input.now) || Date.now();
  const intervalMs = Number(input.intervalMs) > 0 ? Number(input.intervalMs) : DEFAULT_NEXT_CHECK_MS;
  const staleThreshold = Number(input.staleTickThreshold) >= 0 ? Number(input.staleTickThreshold) : 2;

  const taskId = clean(first(row.taskId, child.taskId, pr.taskId, stale.taskId, input.taskId));
  const streamId = clean(first(row.streamId, child.streamId, input.streamId));
  const workspaceId = clean(first(row.workspaceId, input.workspaceId));
  const runId = clean(first(row.runId, row.spineRunId, input.runId));
  const prNumber = numberOrNull(first(row.prNumber, child.prNumber, pr.number, stale.prNumber, input.prNumber));
  const prUrl = clean(first(row.prUrl, child.prUrl, pr.url, stale.prUrl, input.prUrl));
  const branch = clean(first(row.branch, child.branch, pr.branch, stale.branch, input.branch));
  const baseBranch = clean(first(row.baseBranch, pr.baseBranch, stale.baseBranch, input.baseBranch));
  const worktreePath = clean(first(row.worktreePath, input.worktreePath));
  const outcome = lower(first(row.laneStatus, row.outcome, row.kind, input.outcome));
  const prState = lower(first(stale.prState, pr.prState, child.prState, row.prState, gate?.prState, input.prState));
  const classification = lower(first(stale.classification, pr.classification, input.classification));
  const checkState = lower(first(pr.checkState, child.checkState, row.checkState, row.prChecks, gate?.checkState, input.checkState));
  const mergeable = clean(first(pr.mergeable, child.mergeable, row.mergeable, gate?.mergeable, input.mergeable));
  const stuckTicks = Number(first(child.stuckTicks, row.stuckTicks, input.stuckTicks, 0)) || 0;
  const awaitingApproval = lower(first(child.state, row.streamState, input.streamState)) === 'awaiting-approval';
  const gateFailures = gateFailureCodes(gate);

  let phase = 'waiting-worker';
  let nextActionOwner = 'worker';
  let nextAction = 'wait for worker DONE/BLOCKED';
  let eventTrigger = 'worker-completion';
  let stopCondition = 'DONE, BLOCKED, or owner cancellation';

  if (!taskId && !streamId && !runId && prNumber == null) {
    throw new Error('follow-up requires taskId, streamId, runId, or prNumber');
  }

  if (prState === 'merged') {
    phase = 'shipped';
    nextActionOwner = 'manager';
    nextAction = 'stop tracking; PR merged';
    eventTrigger = 'pr-merged';
    stopCondition = 'PR merged';
  } else if (prState === 'closed' || classification === 'closed') {
    phase = 'parked';
    nextActionOwner = 'owner';
    nextAction = 'reopen/adopt only if this work should continue';
    eventTrigger = 'pr-closed';
    stopCondition = 'PR closed/parked';
  } else if (outcome === 'blocked' || outcome === 'block') {
    phase = 'blocked';
    nextActionOwner = 'owner';
    nextAction = 'resolve worker BLOCKED reason or cancel the lane';
    eventTrigger = 'worker-blocked';
    stopCondition = 'BLOCKED';
  } else if (awaitingApproval) {
    phase = 'blocked';
    nextActionOwner = 'owner';
    nextAction = 'answer the approval prompt';
    eventTrigger = 'awaiting-approval';
    stopCondition = 'approval required';
  } else if (stuckTicks > staleThreshold) {
    phase = 'blocked';
    nextActionOwner = 'manager';
    nextAction = 'inspect stale lane and recover or cancel';
    eventTrigger = 'watchdog-stale';
    stopCondition = 'watchdog stale threshold';
  } else if (prNumber != null || prUrl) {
    if (classification === 'needs-fixback' || classification === 'conflicting' || checkState === 'failure') {
      phase = 'fixback-needed';
      nextActionOwner = 'manager';
      nextAction = 'delegate fixback on the existing branch/PR';
      eventTrigger = 'pr-checks-failed';
      stopCondition = 'validation failed';
    } else if (checkState === 'pending' || checkState === 'in_progress' || !checkState) {
      phase = 'PR-checks-running';
      nextActionOwner = 'manager';
      nextAction = 'poll PR checks and mergeability';
      eventTrigger = outcome === 'done' ? 'worker-done' : 'pr-checks';
      stopCondition = 'PR checks pass/fail';
    } else if (hasFailure(gate, 'validation_required') || hasFailure(gate, 'independent_validation_required')) {
      phase = 'validating';
      nextActionOwner = 'validator';
      nextAction = 'run or wait for required validation';
      eventTrigger = 'validation-required';
      stopCondition = 'validation pass/fail';
    } else if (hasFailure(gate, 'review_required')) {
      phase = 'ready-to-review';
      nextActionOwner = 'owner';
      nextAction = 'review PR and approve/request changes';
      eventTrigger = 'review-required';
      stopCondition = 'approval required';
    } else if (gate && gate.readyToMerge === true) {
      phase = 'merge-ready';
      nextActionOwner = 'owner';
      nextAction = 'owner merge/park decision';
      eventTrigger = 'gate-pass';
      stopCondition = 'PR merged/parked';
    } else if (gate && gate.ok === false && gateFailures.length) {
      phase = 'blocked';
      nextActionOwner = 'manager';
      nextAction = `clear gate blocker: ${gateFailures.join(', ')}`;
      eventTrigger = 'gate-blocked';
      stopCondition = 'gate BLOCKED';
    } else if (checkState === 'success') {
      phase = 'ready-to-review';
      nextActionOwner = 'owner';
      nextAction = 'review PR and decide next action';
      eventTrigger = 'pr-checks-passed';
      stopCondition = 'PR merged/parked';
    }
  } else if (outcome === 'done') {
    phase = 'worker-done-unvalidated';
    nextActionOwner = 'manager';
    nextAction = 'validate worker output and link or open PR';
    eventTrigger = 'worker-done';
    stopCondition = 'DONE validated or validation failed';
  }

  const record: any = {
    id: followUpId({ runId, taskId, streamId, workspaceId, prNumber }),
    workspaceId,
    runId,
    taskId,
    streamId,
    branch,
    worktreePath,
    prNumber,
    prUrl,
    prHead: branch,
    prBase: baseBranch,
    prState: prState || null,
    checkState: checkState || null,
    mergeable,
    phase,
    nextActionOwner,
    nextAction,
    nextCheckAt: HIDDEN_DIGEST_PHASES.has(phase) ? null : now + intervalMs,
    eventTrigger,
    stopCondition,
    evidenceLink: evidenceLink({ prUrl, streamId, runId }),
    ownerSummary: checkSummary(phase, { prNumber }),
    ownerActionPacket: null,
    gateFailures,
    staleTicks: stuckTicks,
    source: input.source || 'supervisor',
    updatedAt: now,
  };
  record.ownerActionPacket = ownerPacket(record);
  return record;
}

function transitionKey(record: any) {
  return [
    record.phase || '',
    record.checkState || '',
    record.prState || '',
    record.mergeable || '',
    Array.isArray(record.gateFailures) ? record.gateFailures.join(',') : '',
  ].join('|');
}

function isActionable(record: any) {
  return ACTIONABLE_PHASES.has(record.phase);
}

function mergeRecord(existing: any, next: any, now: number) {
  const merged = {
    ...(existing || {}),
    ...next,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  for (const field of ['workspaceId', 'runId', 'taskId', 'streamId', 'branch', 'worktreePath', 'prUrl', 'prHead', 'prBase']) {
    if (merged[field] == null && existing?.[field] != null) merged[field] = existing[field];
  }
  if (merged.prNumber == null && existing?.prNumber != null) merged.prNumber = existing.prNumber;
  return merged;
}

function createPing(previous: any, record: any, key: string, now: number) {
  return {
    id: `ping:${record.id}:${now}`,
    recordId: record.id,
    workspaceId: record.workspaceId,
    taskId: record.taskId,
    streamId: record.streamId,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    fromPhase: previous?.phase || null,
    phase: record.phase,
    transitionKey: key,
    owner: record.nextActionOwner,
    nextAction: record.nextAction,
    evidenceLink: record.evidenceLink,
    stopCondition: record.stopCondition,
    summary: record.ownerSummary,
    at: now,
  };
}

function createFollowUpStore({ db, filePath, now = () => Date.now() }: any = {}) {
  const backing = db || createFileDb(filePath || defaultFollowUpStorePath());

  function upsert(input: any = {}, opts: any = {}) {
    const nowMs = Number(opts.now ?? input.updatedAt ?? now()) || Date.now();
    const next = input.phase ? { ...input, id: input.id || followUpId(input), updatedAt: nowMs } : classifyFollowUp({ ...input, now: nowMs });
    if (!next.id) throw new Error('follow-up id could not be derived');
    const existing = backing.get(next.id);
    const record = mergeRecord(existing, next, nowMs);
    const key = transitionKey(record);
    const initialActionable = !existing && isActionable(record);
    const changedActionable = !!existing && existing.lastTransitionKey !== key && isActionable(record);
    const ping = opts.suppressPing === true || (!initialActionable && !changedActionable)
      ? null
      : createPing(existing, record, key, nowMs);
    record.lastTransitionKey = key;
    if (ping) {
      record.lastPingAt = nowMs;
      record.lastPingKey = key;
      record.pingCount = Number(existing?.pingCount || 0) + 1;
    } else {
      record.lastPingAt = existing?.lastPingAt || null;
      record.lastPingKey = existing?.lastPingKey || null;
      record.pingCount = Number(existing?.pingCount || 0);
    }
    backing.set(record.id, record);
    return { record, ping };
  }

  function list(filters: any = {}) {
    return backing.all()
      .filter((record: any) => !filters.workspaceId || record.workspaceId === filters.workspaceId)
      .filter((record: any) => !filters.taskId || record.taskId === filters.taskId)
      .filter((record: any) => !filters.includeStopped ? !HIDDEN_DIGEST_PHASES.has(record.phase) : true)
      .sort((a: any, b: any) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function digest(filters: any = {}) {
    return buildFollowUpDigest(list(filters), filters);
  }

  return {
    upsert,
    get: (id: any) => backing.get(id),
    list,
    remove: (id: any) => backing.delete(id),
    digest,
  };
}

function digestPriority(record: any) {
  if (record.phase === 'blocked') return 0;
  if (record.phase === 'fixback-needed') return 1;
  if (record.phase === 'merge-ready' || record.phase === 'ready-to-review') return 2;
  if (record.phase === 'worker-done-unvalidated') return 3;
  return 4;
}

function buildFollowUpDigest(records: any = [], opts: any = {}) {
  const now = Number(opts.now) || Date.now();
  const workspaceId = opts.workspaceId || null;
  const filtered = (Array.isArray(records) ? records : [])
    .filter((record: any) => !workspaceId || record.workspaceId === workspaceId)
    .filter((record: any) => opts.includeStopped === true || !HIDDEN_DIGEST_PHASES.has(record.phase))
    .sort((a: any, b: any) => digestPriority(a) - digestPriority(b) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 12;
  const items = filtered.slice(0, limit).map((record: any) => ({
    id: record.id,
    workspaceId: record.workspaceId,
    runId: record.runId,
    taskId: record.taskId,
    streamId: record.streamId,
    branch: record.branch,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    state: record.phase,
    nextAction: record.nextAction,
    owner: record.nextActionOwner,
    evidenceLink: record.evidenceLink,
    stopCondition: record.stopCondition,
    summary: record.ownerSummary,
    ownerActionPacket: record.ownerActionPacket,
    nextCheckAt: record.nextCheckAt,
    updatedAt: record.updatedAt,
  }));
  return {
    $schema: DIGEST_SCHEMA,
    generatedAt: now,
    pendingCount: filtered.length,
    items,
    text: renderFollowUpDigestText(items),
  };
}

function renderFollowUpDigestText(items: any = []) {
  if (!items.length) return 'No pending delegated-lane follow-ups.';
  return items.map((item: any) => {
    const ref = item.prNumber != null ? `PR #${item.prNumber}` : item.taskId || item.streamId || item.runId || item.id;
    return `${ref}: ${item.state}; ${item.owner} -> ${item.nextAction}; evidence: ${item.evidenceLink || 'n/a'}; stop: ${item.stopCondition || 'n/a'}`;
  }).join('\n');
}

function updateFollowUpsFromSupervisorSnapshot({ store, rows = [], children = [], prReconciliation = null, now = Date.now(), intervalMs = DEFAULT_NEXT_CHECK_MS, staleTickThreshold = 2 }: any = {}) {
  if (!store || typeof store.upsert !== 'function') return { records: [], pings: [], digest: buildFollowUpDigest([]) };
  const childByTask = new Map((Array.isArray(children) ? children : []).map((child: any) => [child.taskId, child]));
  const prByTask = new Map();
  const prByNumber = new Map();
  for (const pr of prReconciliation?.pullRequests || []) {
    if (pr.taskId) prByTask.set(pr.taskId, pr);
    if (pr.number != null) prByNumber.set(Number(pr.number), pr);
  }
  const staleByTask = new Map((prReconciliation?.staleRows || []).map((stale: any) => [stale.taskId, stale]));
  const records = [];
  const pings = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const pr = prByTask.get(row.taskId) || (row.prNumber != null ? prByNumber.get(Number(row.prNumber)) : null) || null;
    const child = childByTask.get(row.taskId) || null;
    const stale = staleByTask.get(row.taskId) || null;
    const result = store.upsert({
      row,
      child,
      pr,
      stale,
      now,
      intervalMs,
      staleTickThreshold,
      source: 'supervisor',
    });
    records.push(result.record);
    if (result.ping) pings.push(result.ping);
  }
  return { records, pings, digest: store.digest({ workspaceId: rows[0]?.workspaceId || null, now }) };
}

module.exports = {
  STORE_SCHEMA,
  DIGEST_SCHEMA,
  createFollowUpStore,
  createMemoryDb,
  createFileDb,
  defaultFollowUpStorePath,
  classifyFollowUp,
  buildFollowUpDigest,
  renderFollowUpDigestText,
  updateFollowUpsFromSupervisorSnapshot,
};
