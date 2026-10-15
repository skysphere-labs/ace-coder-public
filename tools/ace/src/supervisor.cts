// supervisor — periodic refresh of every child-registry row's PR/CI/branch
// state. On each tick we ask `gh` (and, optionally, the integration gateway)
// for the latest intel about each child's pull request and write the result
// back to the registry. Rows whose intel doesn't change for more than two
// consecutive ticks are reported via onStuck so the orchestrator (or, in a
// later PR, an automated re-spec dispatcher) can intervene.
//
// The supervisor only reads. All write-side operations (push, openPr, merge,
// cleanup) live on the integration gateway and are explicitly out of scope
// here — automated re-spec is left as a TODO at the onStuck call site.
//
// Inputs are injectable so unit tests can drive the loop without shelling out:
//   gh(args) -> { ok, code, stdout, stderr }
//   integrationGateway — kept on the API for forward compatibility; today the
//     supervisor only reads via `gh`. Wiring it in now means the CLI can hand
//     the same gateway instance through once write-side automation lands.

const { execFile } = require('child_process');
const {
  cleanupReadiness,
  createFixbackPacket,
  evaluateMergeGate,
  FIXBACK_RETRY_MAX_ATTEMPTS,
  parseGhJson,
  reconcileWorkspacePullRequests,
  rollupCheckState,
} = require('./pr-gate.cjs');
let followUpSupervisor: any;
try {
  followUpSupervisor = require('./follow-up-supervisor.cjs');
} catch {
  followUpSupervisor = require('./follow-up-supervisor.cts');
}
const { updateFollowUpsFromSupervisorSnapshot } = followUpSupervisor;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const STUCK_TICK_THRESHOLD = 2;
const GH_TIMEOUT_MS = 15_000;

function defaultGh(args: any, { cwd }: any = {}) {
  return new Promise((resolve: any) => {
    execFile(
      'gh',
      args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err: any, stdout: any, stderr: any) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      }
    );
  });
}

function defaultGit(args: any, { cwd }: any = {}) {
  return new Promise((resolve: any) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err: any, stdout: any, stderr: any) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      }
    );
  });
}

async function fetchChildIntel(row: any, { gh, git, cwd }: any) {
  const intel = {
    prState: null,
    checkState: null,
    mergeable: null,
    branchExistsRemote: null,
  };

  if (row.prNumber != null) {
    const view = await gh(
      ['pr', 'view', String(row.prNumber), '--json', 'state,mergeable,statusCheckRollup'],
      { cwd }
    );
    if (view.ok) {
      try {
        const json = parseGhJson(view.stdout, {});
        intel.prState = json.state || null;
        intel.mergeable = json.mergeable || null;
        intel.checkState = rollupCheckState(json.statusCheckRollup);
      } catch {
        // Malformed gh output — leave intel fields null so the supervisor
        // treats this row as unchanged rather than fabricating a transition.
      }
    }
  }

  if (row.branch) {
    const ls = await git(['ls-remote', '--exit-code', '--heads', 'origin', row.branch], { cwd });
    intel.branchExistsRemote = ls.ok;
  }

  return intel;
}

function intelChanged(prev: any, next: any) {
  if (!prev) return true;
  return (
    prev.prState !== next.prState ||
    prev.checkState !== next.checkState ||
    prev.mergeable !== next.mergeable ||
    prev.branchExistsRemote !== next.branchExistsRemote
  );
}

function createSupervisor({
  childRegistry,
  integrationGateway = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  gh = defaultGh,
  git = defaultGit,
  cwd = process.cwd(),
  onStuck = (childId: any) => {
    // TODO(supervisor): automated re-spec dispatch — when a child has been
    // stuck for >2 ticks, spawn a fresh delegate with the original spec plus
    // a summary of the last gateway intel so the worker can self-correct.
    // Out of scope for this PR; landing the detection signal first.
    console.warn(`[supervisor] child ${childId} appears stuck (no PR/CI progress for >${STUCK_TICK_THRESHOLD} ticks)`);
  },
  onTick = null,
  logger = console,
  baseBranch = process.env.ACE_BASE_BRANCH || 'main',
  followUpStore = null,
}: any = {}) {
  if (!childRegistry || typeof childRegistry.list !== 'function') {
    throw new Error('createSupervisor: childRegistry with .list() is required');
  }
  // integrationGateway is reserved for write-side automation in a follow-up
  // PR; reference it once so lint/dead-code checks don't flag it as orphan.
  void integrationGateway;

  const stuckCounters = new Map();
  const lastIntel = new Map();
  let timer = null;
  let latestSnapshot = null;
  let inFlight = null;

  async function tickOnce() {
    const tickAt = Date.now();
    const rows = childRegistry.list();
    const children = [];
    for (const row of rows) {
      let intel;
      try {
        intel = await fetchChildIntel(row, { gh, git, cwd });
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[supervisor] fetch failed for ${row.taskId}: ${err && err.message ? err.message : err}`);
        }
        intel = { prState: null, checkState: null, mergeable: null, branchExistsRemote: null };
      }

      const prev = lastIntel.get(row.taskId);
      const changed = intelChanged(prev, intel);
      let stuckTicks;
      if (!prev) {
        stuckTicks = 0;
      } else if (changed) {
        stuckTicks = 0;
      } else {
        stuckTicks = (stuckCounters.get(row.taskId) || 0) + 1;
      }
      stuckCounters.set(row.taskId, stuckTicks);
      lastIntel.set(row.taskId, intel);

      try {
        childRegistry.updatePrState(row.taskId, {
          prState: intel.prState != null ? intel.prState : row.prState || null,
          checkState: intel.checkState,
          mergeable: intel.mergeable,
          branchExistsRemote: intel.branchExistsRemote,
        });
      } catch (err) {
        // Row may have been removed between list() and update; skip silently.
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[supervisor] registry update skipped for ${row.taskId}: ${err && err.message ? err.message : err}`);
        }
      }

      if (stuckTicks > STUCK_TICK_THRESHOLD) {
        try {
          onStuck(row.taskId);
        } catch (err) {
          if (logger && typeof logger.warn === 'function') {
            logger.warn(`[supervisor] onStuck threw for ${row.taskId}: ${err && err.message ? err.message : err}`);
          }
        }
      }

      const cleanup = cleanupReadiness({
        branch: row.branch || null,
        worktreePath: row.worktreePath || null,
        branchExistsRemote: intel.branchExistsRemote,
      });

      children.push({
        taskId: row.taskId,
        branch: row.branch || null,
        prNumber: row.prNumber != null ? row.prNumber : null,
        prUrl: row.prUrl || null,
        ...intel,
        cleanup,
        stuckTicks,
        changed,
      });
    }
    let prReconciliation = null;
    if (rows.length) {
      prReconciliation = await reconcileWorkspacePullRequests({ rows, gh, cwd, baseBranch });
    }
    const followUps = followUpStore
      ? updateFollowUpsFromSupervisorSnapshot({
          store: followUpStore,
          rows,
          children,
          prReconciliation,
          now: tickAt,
          intervalMs: pollIntervalMs,
          staleTickThreshold: STUCK_TICK_THRESHOLD,
        })
      : null;
    latestSnapshot = {
      tickAt,
      intervalMs: pollIntervalMs,
      children,
      prReconciliation,
      fixbackPackets: prReconciliation?.fixbackPackets || [],
      followUps,
    };
    if (typeof onTick === 'function') {
      try {
        onTick(latestSnapshot);
      } catch (err) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[supervisor] onTick threw: ${err && err.message ? err.message : err}`);
        }
      }
    }
    return latestSnapshot;
  }

  function scheduleNext() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      inFlight = tickOnce()
        .catch((err: any) => {
          if (logger && typeof logger.warn === 'function') {
            logger.warn(`[supervisor] tick failed: ${err && err.message ? err.message : err}`);
          }
        })
        .finally(() => {
          inFlight = null;
          if (running) scheduleNext();
        });
    }, pollIntervalMs);
  }

  let running = false;

  function start() {
    if (running) return;
    running = true;
    inFlight = tickOnce()
      .catch((err: any) => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[supervisor] tick failed: ${err && err.message ? err.message : err}`);
        }
      })
      .finally(() => {
        inFlight = null;
        if (running) scheduleNext();
      });
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function snapshot() {
    return latestSnapshot;
  }

  return { start, stop, snapshot, tickOnce };
}

module.exports = {
  createFixbackPacket,
  createSupervisor,
  cleanupReadiness,
  defaultGh,
  evaluateMergeGate,
  FIXBACK_RETRY_MAX_ATTEMPTS,
  reconcileWorkspacePullRequests,
  rollupCheckState,
  STUCK_TICK_THRESHOLD,
  DEFAULT_POLL_INTERVAL_MS,
};
