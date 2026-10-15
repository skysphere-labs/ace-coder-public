// Daily in-process ops-status snapshot scheduler. (The 04:00 mission-archive
// sweep was retired with the mission domain — the run-ledger spine owns
// lifecycle now; this module keeps only the read-only ops-status snapshot.)
// Single in-process timer — no relaunch (relaunch would kill the live session)
// and no separate daemon/queue. See docs/ops/ace-wiki-truth-contract.md §6.
const OPS_STATUS_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OPS_STATUS_SNAPSHOT_HOUR = 6;

function nextOpsStatusSnapshotRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(OPS_STATUS_SNAPSHOT_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleOpsStatusSnapshot(options: any) {
  const getStore = options?.getStore;
  const subscriptions = options?.subscriptions;
  if (typeof getStore !== 'function' || !Array.isArray(subscriptions)) return false;

  const store = getStore();
  if (!store || typeof store.opsStatusSnapshot !== 'function') return false;

  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const setIntervalImpl = options.setInterval ?? setInterval;
  const clearIntervalImpl = options.clearInterval ?? clearInterval;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;

  const runSnapshot = () => {
    setTimeoutImpl(() => {
      Promise.resolve()
        // Evidence-only: opsStatusSnapshot runs the probes READ-ONLY and writes
        // distilled wiki sections + raw evidence. It never dispatches, merges,
        // deploys, or spawns. A failure is swallowed so the runtime survives a
        // wiki/probe I/O error (fail-closed).
        .then(() => getStore().opsStatusSnapshot({ source: 'scheduler' }))
        .catch((err: any) => logger.error('[ace] ops status snapshot failed:', err));
    }, 0);
  };

  const current = now();
  const next = nextOpsStatusSnapshotRun(current);
  const firstTimer = setTimeoutImpl(() => {
    runSnapshot();
    const dailyTimer = setIntervalImpl(runSnapshot, OPS_STATUS_SNAPSHOT_INTERVAL_MS);
    subscriptions.push(() => clearIntervalImpl(dailyTimer));
  }, next.getTime() - current.getTime());
  subscriptions.push(() => clearTimeoutImpl(firstTimer));
  return true;
}

module.exports = {
  OPS_STATUS_SNAPSHOT_INTERVAL_MS,
  nextOpsStatusSnapshotRun,
  scheduleOpsStatusSnapshot,
};
