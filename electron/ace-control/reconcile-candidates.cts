// Pure candidate selection for the in-flight run reconcile poller: in-flight
// tails only; the recency window is bypassed for a dispatch link whose stream
// is still live (a stalled run appends no events); bypassed runs hold
// reserved slots and every over-cap pool rotates by tick (no starvation).

const RUN_RECONCILE_CANDIDATE_EVENTS = new Set([
  'worker.dispatched',
  'worker.dispatch.linked',
  'worker.completed',
  'validator.dispatched',
  'validator.dispatch.linked',
  'validator.completed',
]);

const RUN_RECONCILE_STOP_EVENTS = new Set([
  'worker.dispatch.failed',
  'validator.dispatch.failed',
  'run.blocked',
  'merged',
  'released',
]);

const BYPASS_RESERVED_SLOTS = 2;

/**
 * @param {Array<{runId:string,lastType:string,lastTs:number,streamId?:string}>} rows
 *   One row per run: its LAST event type/ts and the newest dispatch link's streamId.
 * @param {{now:number,recentMs:number,maxPerTick:number,tick?:number,isStreamLive?:(id:string)=>boolean}} opts
 * @returns {string[]} runIds to drive this tick.
 */
function selectReconcileCandidates(rows: any[], opts: any = {}) {
  const now = Number(opts.now) || 0;
  const recentMs = Number(opts.recentMs) || 0;
  const maxPerTick = Math.max(1, Number(opts.maxPerTick) || 1);
  const tick = Math.max(0, Number(opts.tick) || 0);
  const isStreamLive = typeof opts.isStreamLive === 'function' ? opts.isStreamLive : () => false;

  const inWindow: any[] = [];
  const bypassed: any[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.runId || !row.lastType) continue;
    if (RUN_RECONCILE_STOP_EVENTS.has(row.lastType)) continue;
    if (!RUN_RECONCILE_CANDIDATE_EVENTS.has(row.lastType)) continue;
    const stale = row.lastTs > 0 && now - row.lastTs > recentMs;
    if (!stale) {
      inWindow.push(row);
    } else if (row.lastType.endsWith('.dispatch.linked') && row.streamId && isStreamLive(row.streamId)) {
      bypassed.push(row);
    }
  }
  inWindow.sort((a, b) => b.lastTs - a.lastTs);
  bypassed.sort((a, b) => a.lastTs - b.lastTs);

  // Any pool larger than its share rotates by tick — no run may be starved
  // out of polling by a permanently-newer (or permanently-older) cohort.
  const rotate = (pool: any[], slots: number) =>
    pool.length > slots && pool.length > 0
      ? pool.slice(tick % pool.length).concat(pool.slice(0, tick % pool.length))
      : pool;

  if (!bypassed.length) {
    return rotate(inWindow, maxPerTick).slice(0, maxPerTick).map((r) => r.runId);
  }
  if (!inWindow.length) {
    return rotate(bypassed, maxPerTick).slice(0, maxPerTick).map((r) => r.runId);
  }

  // Both pools populated. A single slot alternates between the pools by tick
  // parity; otherwise the bypassed pool's reserve leaves the in-window pool
  // at least one slot — no pool may be starved at any supported cap.
  if (maxPerTick === 1) {
    const pool = tick % 2 === 1 ? bypassed : inWindow;
    const offset = Math.floor(tick / 2) % pool.length;
    return [pool[offset].runId];
  }
  const reserve = Math.min(BYPASS_RESERVED_SLOTS, maxPerTick - 1, bypassed.length);
  const picked = rotate(inWindow, maxPerTick - reserve).slice(0, maxPerTick - reserve);
  for (const row of rotate(bypassed, reserve)) {
    if (picked.length >= maxPerTick) break;
    picked.push(row);
  }
  return picked.map((r) => r.runId);
}

module.exports = {
  selectReconcileCandidates,
  RUN_RECONCILE_CANDIDATE_EVENTS,
  RUN_RECONCILE_STOP_EVENTS,
};
