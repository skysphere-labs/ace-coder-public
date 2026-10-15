const { listTerminalTrailers } = require('../../tools/ace/src/trailers.cjs');

function commonPrefixLength(a: any, b: any) {
  const left = String(a || '');
  const right = String(b || '');
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) i++;
  return i;
}

function normalizeContext(ctx: any, streamId: any) {
  const expectedLaneIds = Array.isArray(ctx?.expectedLaneIds)
    ? ctx.expectedLaneIds.filter(Boolean)
    : null;
  return {
    streamId,
    taskId: ctx?.taskId ?? null,
    targetTaskId: ctx?.targetTaskId ?? null,
    validatorTaskId: ctx?.validatorTaskId ?? null,
    parentTaskId: ctx?.parentTaskId ?? ctx?.parent_task_id ?? null,
    rootTaskId: ctx?.rootTaskId ?? ctx?.root_task_id ?? null,
    isRootGoalAgent: ctx?.isRootGoalAgent ?? ctx?.is_root_goal_agent ?? null,
    isInternalSubagent: ctx?.isInternalSubagent ?? ctx?.is_internal_subagent ?? null,
    role: ctx?.role ?? null,
    roleMode: ctx?.roleMode ?? null,
    taskType: ctx?.taskType ?? null,
    agentClass: ctx?.agentClass ?? null,
    missionId: ctx?.missionId ?? null,
    workspaceId: ctx?.workspaceId ?? null,
    agent: ctx?.agent ?? null,
    branch: ctx?.branch ?? null,
    worktreePath: ctx?.worktreePath ?? ctx?.cwd ?? null,
    prNumber: ctx?.prNumber ?? null,
    prUrl: ctx?.prUrl ?? null,
    waveId: ctx?.waveId ?? null,
    laneId: ctx?.laneId ?? null,
    expectedLaneIds,
  };
}

function createCompletionInbox({ now = () => Date.now() }: any = {}) {
  const records: any[] = [];
  const seen = new Set();
  const turnByStream = new Map();
  const highWaterByStream = new Map();
  let nextSeq = 1;

  function ensureStream(streamId: any, baselineText: any) {
    if (!streamId || highWaterByStream.has(streamId)) return;
    highWaterByStream.set(streamId, String(baselineText || ''));
  }

  function beginTurn(streamId: any, baselineText: any) {
    if (!streamId) return null;
    const prev = turnByStream.get(streamId) || {};
    const turnId = (prev.turnId || 0) + 1;
    const turn = {
      streamId,
      turnId,
      baselineText: String(baselineText || ''),
    };
    turnByStream.set(streamId, turn);
    highWaterByStream.set(streamId, turn.baselineText);
    return turn;
  }

  function observeReady({ streamId, state, text, context, allowSyntheticTurn = false, excludeTrailerKeys }: any = {}) {
    if (!streamId || (state !== 'turn-complete' && state !== 'awaiting-input')) return [];
    const current = String(text || '');
    let turn = turnByStream.get(streamId);
    if (!turn) {
      if (!allowSyntheticTurn || !highWaterByStream.has(streamId)) return [];
      turn = beginTurn(streamId, highWaterByStream.get(streamId));
    }
    const start = commonPrefixLength(turn.baselineText, current);
    // Keys still explainable as the submitted prompt's pty echo (Set or array).
    const echoSource = Array.isArray(excludeTrailerKeys) ? new Set(excludeTrailerKeys) : excludeTrailerKeys;
    const echo = echoSource && echoSource.size ? echoSource : null;
    const trailers = listTerminalTrailers(current.slice(start)).filter(
      (t: any) => !echo || !echo.has(`${t.kind} ${t.detail || ''}`)
    );
    if (!trailers.length) return [];

    const meta = normalizeContext(context, streamId);
    const created: any[] = [];
    for (const trailer of trailers) {
      const key = [
        meta.streamId,
        turn.turnId,
        state,
        start,
        trailer.kind,
        trailer.detail || '',
      ].join('\u0000');
      if (seen.has(key)) continue;
      // Cross-sink identity: the raw-ring fallback may already have recorded
      // this exact trailer for this turn (or vice versa) — never twice.
      const crossKey = crossSinkKey(streamId, turn.turnId, trailer);
      if (seen.has(crossKey)) continue;
      seen.add(key);
      seen.add(crossKey);
      const record = buildRecord({ meta, state, turnId: turn.turnId, trailer });
      records.push(record);
      created.push(record);
    }
    if (created.length) {
      turn.baselineText = current;
      highWaterByStream.set(streamId, current);
    }
    return created;
  }

  function crossSinkKey(streamId: any, turnId: any, trailer: any) {
    return ['x', streamId, turnId == null ? '' : turnId, trailer.kind, trailer.detail || ''].join('\u0000');
  }

  function buildRecord({ meta, state, turnId, trailer }: any) {
    const timestamp = now();
    return {
      id: `wc_${timestamp}_${nextSeq++}`,
      streamId: meta.streamId,
      taskId: meta.taskId,
      targetTaskId: meta.targetTaskId,
      validatorTaskId: meta.validatorTaskId,
      parentTaskId: meta.parentTaskId,
      rootTaskId: meta.rootTaskId,
      isRootGoalAgent: meta.isRootGoalAgent,
      isInternalSubagent: meta.isInternalSubagent,
      role: meta.role,
      roleMode: meta.roleMode,
      taskType: meta.taskType,
      agentClass: meta.agentClass,
      missionId: meta.missionId,
      workspaceId: meta.workspaceId,
      agent: meta.agent,
      branch: meta.branch,
      worktreePath: meta.worktreePath,
      prNumber: meta.prNumber,
      prUrl: meta.prUrl,
      waveId: meta.waveId,
      laneId: meta.laneId,
      expectedLaneIds: meta.expectedLaneIds,
      state,
      turnId,
      kind: trailer.kind,
      outcome: trailer.kind,
      detail: trailer.detail,
      trailer,
      timestamp,
      ackedAt: null,
    };
  }

  // Direct record for a trailer the state machine proved in the ANSI-stripped
  // raw byte ring when the rendered-scrollback diff missed it (TUI repaint).
  // The dedupe key includes the turn generation, so a LATER turn (a fixback
  // round) with an identical trailer still records.
  function recordDirect({ streamId, state, trailer, context }: any = {}) {
    if (!streamId || !trailer || !trailer.kind) return null;
    const kind = String(trailer.kind).toLowerCase();
    if (kind !== 'done' && kind !== 'blocked' && kind !== 'verdict') return null;
    const normalized = {
      kind,
      detail: trailer.detail == null ? null : String(trailer.detail),
    };
    const turn = turnByStream.get(streamId) || null;
    const turnId = turn ? turn.turnId : null;
    const key = ['raw', streamId, turnId == null ? '' : turnId, normalized.kind, normalized.detail || ''].join('\u0000');
    const crossKey = crossSinkKey(streamId, turnId, normalized);
    if (seen.has(key) || seen.has(crossKey)) return null;
    seen.add(key);
    seen.add(crossKey);
    const meta = normalizeContext(context, streamId);
    const record = buildRecord({
      meta,
      state: state === 'awaiting-input' ? state : 'turn-complete',
      turnId,
      trailer: normalized,
    });
    (record as any).dedupeKeys = [key, crossKey];
    records.push(record);
    return record;
  }

  // Roll back a record whose durable downstream write failed, so the SAME
  // trailer can re-record on the next observation instead of stranding.
  function retract(id: any) {
    const idx = records.findIndex((candidate) => candidate.id === id);
    if (idx < 0) return false;
    const record: any = records[idx];
    records.splice(idx, 1);
    for (const key of Array.isArray(record.dedupeKeys) ? record.dedupeKeys : []) seen.delete(key);
    return true;
  }

  function list({ includeAcked = false, workspaceId, streamId }: any = {}) {
    return records
      .filter((record) => includeAcked || !record.ackedAt)
      .filter((record) => !workspaceId || record.workspaceId === workspaceId)
      .filter((record) => !streamId || record.streamId === streamId);
  }

  function ack(id: any) {
    const record = records.find((candidate) => candidate.id === id);
    if (!record) return null;
    if (!record.ackedAt) record.ackedAt = now();
    return record;
  }

  return { ensureStream, beginTurn, observeReady, recordDirect, retract, list, ack };
}

module.exports = { createCompletionInbox };
