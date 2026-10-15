// knowledge-nightly-scheduler.cts — the autonomous nightly knowledge loop.
//
// 03:30 daily (deliberately clear of the 04:00 mission archive and the 06:00
// ops snapshot — see mission-archive-scheduler.cts): incremental reindex →
// deterministic audit + decay recompute → per-project wiki curation (the
// previously CLI-only `ace wiki nightly`, finally autonomous) → rotation
// → report. In-process timers, fail-swallowed, opt-out via
// ACE_KNOWLEDGE_NIGHTLY_DISABLE=1. Run history lands in
// <stateDir>/knowledge-nightly.ndjson (AceKnowledgeNightlyRun/v1).

'use strict';

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KNOWLEDGE_NIGHTLY_HOUR = 3;
const KNOWLEDGE_NIGHTLY_MINUTE = 30;
const HISTORY_FILE = 'knowledge-nightly.ndjson';
const STATE_FILE = 'knowledge-nightly-state.json';

function isDisabled(env: any = process.env) {
  return env.ACE_KNOWLEDGE_NIGHTLY_DISABLE === '1';
}

function nextKnowledgeNightlyRun(now = new Date(), hour = KNOWLEDGE_NIGHTLY_HOUR, minute = KNOWLEDGE_NIGHTLY_MINUTE) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function recordRun({ stateDir, run }: any) {
  try {
    if (!stateDir) return;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, HISTORY_FILE), `${JSON.stringify(run)}\n`);
    fs.writeFileSync(path.join(stateDir, STATE_FILE), `${JSON.stringify(run, null, 2)}\n`);
  } catch { /* history is best-effort, never breaks the loop */ }
}

function readNightlyState(stateDir: any) {
  try {
    return JSON.parse(fs.readFileSync(path.join(String(stateDir || ''), STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function readNightlyHistory(stateDir: any, limit = 14) {
  try {
    const lines = fs.readFileSync(path.join(String(stateDir || ''), HISTORY_FILE), 'utf8')
      .split('\n')
      .filter(Boolean);
    return lines.slice(-limit).map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function scheduleKnowledgeNightly(options: any) {
  const getStore = options?.getStore;
  const subscriptions = options?.subscriptions;
  if (typeof getStore !== 'function' || !Array.isArray(subscriptions)) return false;
  if (isDisabled(options.env)) return false;

  const store = getStore();
  if (!store || typeof store.knowledgeNightly !== 'function') return false;

  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const setIntervalImpl = options.setInterval ?? setInterval;
  const clearIntervalImpl = options.clearInterval ?? clearInterval;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  const stateDir = options.stateDir || null;
  const hour = Number.isFinite(Number(options.hour)) ? Number(options.hour) : KNOWLEDGE_NIGHTLY_HOUR;
  const minute = Number.isFinite(Number(options.minute)) ? Number(options.minute) : KNOWLEDGE_NIGHTLY_MINUTE;

  // Running latch: a slow run must never overlap the next tick.
  let running = false;

  const runNightly = () => {
    setTimeoutImpl(() => {
      if (running) {
        logger.warn('[ace] knowledge nightly skipped: previous run still active');
        return;
      }
      running = true;
      const startedAt = new Date(now().getTime()).toISOString();
      Promise.resolve()
        .then(() => getStore().knowledgeNightly({ source: 'scheduler' }))
        .then((result: any) => {
          recordRun({
            stateDir,
            run: {
              schema: 'AceKnowledgeNightlyRun/v1',
              at: startedAt,
              status: result?.ok === false ? 'error' : 'ok',
              error: result?.ok === false ? String(result?.error || 'unknown') : null,
              findings: result?.findings ?? null,
              proposals: result?.proposals ?? null,
              quarantined: result?.quarantined ?? null,
              indexedDocs: result?.index?.indexed ?? null,
              curatedProjects: result?.curatedProjects ?? null,
              reportPath: result?.reportPath ?? null,
            },
          });
        })
        .catch((err: any) => {
          logger.error('[ace] knowledge nightly failed:', err);
          recordRun({
            stateDir,
            run: {
              schema: 'AceKnowledgeNightlyRun/v1',
              at: startedAt,
              status: 'error',
              error: String(err?.message || err),
            },
          });
        })
        .finally(() => {
          running = false;
        });
    }, 0);
  };

  const current = now();
  const next = nextKnowledgeNightlyRun(current, hour, minute);
  const firstTimer = setTimeoutImpl(() => {
    runNightly();
    const dailyTimer = setIntervalImpl(runNightly, KNOWLEDGE_NIGHTLY_INTERVAL_MS);
    subscriptions.push(() => clearIntervalImpl(dailyTimer));
  }, next.getTime() - current.getTime());
  subscriptions.push(() => clearTimeoutImpl(firstTimer));
  return true;
}

module.exports = {
  KNOWLEDGE_NIGHTLY_INTERVAL_MS,
  KNOWLEDGE_NIGHTLY_HOUR,
  KNOWLEDGE_NIGHTLY_MINUTE,
  nextKnowledgeNightlyRun,
  scheduleKnowledgeNightly,
  readNightlyState,
  readNightlyHistory,
};
