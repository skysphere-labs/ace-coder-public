// wave-join — predicate over child-registry rows that decides whether a
// wave's lanes are all terminal. The validator must not start until every
// expected lane has reached a terminal state. A lane counts as terminal
// when:
//   - `laneStatus` is one of the terminal worker outcomes the orchestrator
//     emits (done/blocked/error/timeout/awaiting-approval/max-rounds/
//     done-unverified/approval-needed),
//   - or the PR has reached a terminal state (merged/closed),
//   - or `terminalAt` is set.
// Anything else (busy, booting, no row yet) is nonterminal and blocks the
// join. lastTrailer on a real registry row is the worker's free-text
// detail, not a structured kind, so it is not a join signal — laneStatus
// is the canonical terminal field, written by orchestrator.runTask.

const TERMINAL_LANE_STATUSES = new Set([
  'done',
  'blocked',
  'error',
  'timeout',
  'approval-needed',
  'awaiting-approval',
  'max-rounds',
  'done-unverified',
]);

const TERMINAL_PR_STATES = new Set(['merged', 'closed', 'MERGED', 'CLOSED']);

function laneIsTerminal(row: any) {
  if (!row) return false;
  if (row.terminalAt) return true;
  const status = String(row.laneStatus || '').toLowerCase();
  if (status && TERMINAL_LANE_STATUSES.has(status)) return true;
  if (row.prState && TERMINAL_PR_STATES.has(row.prState)) return true;
  return false;
}

function evaluateWaveJoin({ rows, waveId, expectedLaneIds }: any = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const filtered = waveId == null ? all : all.filter((r: any) => r && r.waveId === waveId);

  // A lane can own several task rows — a failed dispatch attempt followed by
  // a retry. The join is over LANES, so the newest row per laneId speaks for
  // the lane; otherwise a zombie row from a dead attempt (no laneStatus,
  // never terminal) deadlocks the wave forever. Rows without a laneId still
  // stand alone.
  const byLane = new Map();
  const lanes: any[] = [];
  for (const row of filtered) {
    const key = row.laneId || null;
    if (!key) {
      lanes.push(row);
      continue;
    }
    const prev = byLane.get(key);
    if (!prev || Number(row.updatedAt || 0) >= Number(prev.updatedAt || 0)) byLane.set(key, row);
  }
  lanes.push(...byLane.values());

  const terminal: any[] = [];
  const nonterminal: any[] = [];
  for (const row of lanes) {
    if (laneIsTerminal(row)) terminal.push(row);
    else nonterminal.push(row);
  }

  const seen = new Set(lanes.map((r: any) => r.laneId).filter(Boolean));
  const expected = Array.isArray(expectedLaneIds) ? expectedLaneIds : [];
  const missingLanes = expected.filter((id: any) => id && !seen.has(id));

  // An empty wave is not ready. Without this, an empty child-registry
  // would let a validator launch against a wave the dispatcher hasn't
  // registered any lanes for yet.
  const empty = lanes.length === 0 && expected.length === 0;

  return {
    waveId: waveId ?? null,
    ready: !empty && nonterminal.length === 0 && missingLanes.length === 0,
    laneCount: lanes.length,
    terminalCount: terminal.length,
    nonterminalCount: nonterminal.length,
    nonterminalLanes: nonterminal.map((r: any) => r.laneId || r.taskId),
    missingLanes,
    empty,
  };
}

// Throw a structured error when a wave is not ready. Reachable via
// `ace mission validate --wave <id>`, which must refuse to
// launch the wave validator while any lane is still nonterminal.
function assertWaveReady({ rows, waveId, expectedLaneIds }: any = {}) {
  const verdict = evaluateWaveJoin({ rows, waveId, expectedLaneIds });
  if (verdict.ready) return verdict;
  const reasons: string[] = [];
  if (verdict.empty) reasons.push('no lanes registered for this wave');
  if (verdict.nonterminalCount > 0) {
    reasons.push(`${verdict.nonterminalCount} nonterminal lane(s) (${verdict.nonterminalLanes.join(', ')})`);
  }
  if (verdict.missingLanes.length > 0) {
    reasons.push(`${verdict.missingLanes.length} missing lane(s) (${verdict.missingLanes.join(', ')})`);
  }
  const err: any = new Error(
    `wave ${waveId} not ready: ${reasons.join('; ') || 'unknown'}`
  );
  err.code = 'WAVE_NOT_READY';
  err.error = 'wave_not_ready';
  err.verdict = verdict;
  throw err;
}

// Group rows by waveId and compute a join verdict per wave. Used by
// `ace supervise` to surface a wave-level join gate without
// requiring callers to write the grouping themselves.
function summarizeWaveJoin(rows: any) {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.waveId == null) continue;
    const list = buckets.get(row.waveId) || [];
    list.push(row);
    buckets.set(row.waveId, list);
  }
  const summaries: any[] = [];
  for (const [waveId, laneRows] of buckets) {
    summaries.push(evaluateWaveJoin({ rows: laneRows, waveId }));
  }
  return summaries;
}

module.exports = { evaluateWaveJoin, laneIsTerminal, summarizeWaveJoin, assertWaveReady };
