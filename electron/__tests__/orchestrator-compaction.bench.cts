// Synthetic long-thread bench harness for orchestrator compaction.
//
// Generates a 1000-turn fixture of cleanup events for a single task, drives
// them through createCompactionController (with stubbed streamApi/db), and
// records:
//   - per-event handler latency (p50 / p95 / max)
//   - per-compaction wall time (the full /compact → waitFor → reload prompt
//     async chain inside maybeCompact)
//   - RSS delta across the full run
//
// The goal is to measure the controller's own overhead on a current-main
// build so the investigation report has concrete numbers. The bench prints a
// human-readable header followed by a single-line JSON summary as its last
// stdout line (machine-parseable).
//
// Run via: `npm run test:bench:compaction` (preferred — emits the JSON line
// as the last stdout line for machine parsing). The bare equivalent is
// `node --experimental-test-isolation=none --test
// electron/__tests__/orchestrator-compaction.bench.cts`. Without the
// isolation flag, node:test wraps the test file in a subprocess and frames
// its stdout with TAP `# ` prefixes — the bench still runs and asserts, but
// the JSON line ends up framed mid-stream rather than as the literal last
// line. The file requires `electron/orchestrator-compaction.cjs` (built via
// `npm run build:electron-main`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createCompactionController } = require('../orchestrator-compaction.cjs');

const TURNS = 1000;
const THRESHOLD = 10;
const TASK_ID = 'tsk-bench';
const RELOAD_PROMPT_PREFIX = 'Compaction complete.';

// Captured by the test, emitted on `exit` so the JSON line lands AFTER
// node:test's reporter summary — keeping it the last line of stdout. We
// write via fs.writeSync(1, ...) instead of console.log/stdout.write so the
// line bypasses node:test's TAP capture (which would prefix it with `# `).
let finalSummaryLine: string | null = null;
process.on('exit', () => {
  if (finalSummaryLine) fs.writeSync(1, finalSummaryLine + '\n');
});

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

async function flushMicrotasks(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('orchestrator-compaction: 1000-turn synthetic bench', async () => {
  const prevEnv = process.env.ACE_COMPACT_AFTER;
  delete process.env.ACE_COMPACT_AFTER;

  const events = new EventEmitter();
  const store = {
    on: (event: string, listener: any) => {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
  };
  const db = {
    prepare: () => ({
      get: (taskId: string) => ({ id: `${taskId}-conv` }),
    }),
  };

  const handlerLatencies: number[] = [];
  const compactionLatencies: number[] = [];
  const nonCompactionLatencies: number[] = [];

  let pending: { resolve: () => void; promise: Promise<void> } | null = null;
  let compactStart = 0;
  let compactionCount = 0;
  let sendInputCalls = 0;
  let waitForCalls = 0;

  const streamApi = {
    getState: async () => ({ state: 'turn-complete' }),
    sendInput: async (args: { text: string }) => {
      sendInputCalls++;
      if (args.text === '/compact') {
        compactStart = performance.now();
        compactionCount++;
      } else if (args.text.startsWith(RELOAD_PROMPT_PREFIX)) {
        compactionLatencies.push(performance.now() - compactStart);
        if (pending) {
          const p = pending;
          pending = null;
          // Defer resolve to next microtask so the controller can finish
          // its `counts.set(taskId, 0)` and `inFlight.delete(taskId)` work.
          queueMicrotask(() => p.resolve());
        }
      }
      return { ok: true };
    },
    submit: async () => ({ ok: true }),
    waitFor: async () => {
      waitForCalls++;
      return { state: 'turn-complete' };
    },
  };

  const silentLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
  };

  const controller = createCompactionController({
    aceStore: store,
    db,
    streamApi,
    threshold: THRESHOLD,
    logger: silentLogger,
  });
  const stop = controller.start();

  const rssBefore = process.memoryUsage().rss;
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  try {
    for (let i = 0; i < TURNS; i++) {
      const willTrigger = (i + 1) % THRESHOLD === 0;
      if (willTrigger) {
        let resolveFn: () => void = () => {};
        const promise = new Promise<void>((r) => {
          resolveFn = r;
        });
        pending = { resolve: resolveFn, promise };
      }

      const eStart = performance.now();
      events.emit('orchestrator-runtime:state-change', {
        taskId: TASK_ID,
        from: 'integrate',
        to: 'cleanup',
      });

      if (willTrigger) {
        await pending!.promise;
        // The reload-prompt sendInput resolves our pending promise, but the
        // controller's tail (`counts.set(taskId, 0)` + `inFlight.delete`)
        // still runs as later microtasks. Drain through a macrotask cycle
        // so the next emit doesn't land while inFlight is still true (which
        // would silently drop the event and skew counts.)
        await flushMicrotasks(2);
      } else {
        await flushMicrotasks(1);
      }

      const dt = performance.now() - eStart;
      handlerLatencies.push(dt);
      if (!willTrigger) nonCompactionLatencies.push(dt);
    }
    // Drain any tail work left in the controller's listener microtask chain
    // (last handle's `inFlight.delete` and the trailing `submit` after the
    // reload prompt resolves our pending promise).
    await flushMicrotasks(8);
  } finally {
    stop();
    if (prevEnv == null) delete process.env.ACE_COMPACT_AFTER;
    else process.env.ACE_COMPACT_AFTER = prevEnv;
  }

  const totalMs = performance.now() - t0;
  const rssAfter = process.memoryUsage().rss;
  const heapAfter = process.memoryUsage().heapUsed;

  const sortedAll = [...handlerLatencies].sort((a, b) => a - b);
  const sortedNonCompact = [...nonCompactionLatencies].sort((a, b) => a - b);
  const sortedCompact = [...compactionLatencies].sort((a, b) => a - b);

  const summary = {
    turns: TURNS,
    threshold: THRESHOLD,
    compactionCount,
    sendInputCalls,
    waitForCalls,
    totalMs: Number(totalMs.toFixed(3)),
    handler: {
      meanMs: Number(mean(handlerLatencies).toFixed(4)),
      p50Ms: Number(percentile(sortedAll, 50).toFixed(4)),
      p95Ms: Number(percentile(sortedAll, 95).toFixed(4)),
      maxMs: Number(Math.max(...handlerLatencies).toFixed(4)),
    },
    postCompactionHandler: {
      meanMs: Number(mean(nonCompactionLatencies).toFixed(4)),
      p50Ms: Number(percentile(sortedNonCompact, 50).toFixed(4)),
      p95Ms: Number(percentile(sortedNonCompact, 95).toFixed(4)),
    },
    compaction: {
      meanMs: Number(mean(compactionLatencies).toFixed(4)),
      p50Ms: Number(percentile(sortedCompact, 50).toFixed(4)),
      p95Ms: Number(percentile(sortedCompact, 95).toFixed(4)),
      totalMs: Number(compactionLatencies.reduce((a, b) => a + b, 0).toFixed(3)),
    },
    memory: {
      rssBeforeMB: Number((rssBefore / 1024 / 1024).toFixed(2)),
      rssAfterMB: Number((rssAfter / 1024 / 1024).toFixed(2)),
      rssDeltaMB: Number(((rssAfter - rssBefore) / 1024 / 1024).toFixed(2)),
      heapBeforeMB: Number((heapBefore / 1024 / 1024).toFixed(2)),
      heapAfterMB: Number((heapAfter / 1024 / 1024).toFixed(2)),
      heapDeltaMB: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    },
  };

  // Sanity: every threshold-th event must trigger exactly one /compact.
  assert.equal(compactionCount, Math.floor(TURNS / THRESHOLD));
  assert.equal(handlerLatencies.length, TURNS);

  // Human-readable header.
  console.log('');
  console.log('--- orchestrator-compaction bench ---');
  console.log(`turns=${TURNS} threshold=${THRESHOLD} compactions=${compactionCount}`);
  console.log(
    `handler  mean=${summary.handler.meanMs}ms  p50=${summary.handler.p50Ms}ms  ` +
      `p95=${summary.handler.p95Ms}ms  max=${summary.handler.maxMs}ms`
  );
  console.log(
    `post-compaction (non-trigger events)  p50=${summary.postCompactionHandler.p50Ms}ms  ` +
      `p95=${summary.postCompactionHandler.p95Ms}ms`
  );
  console.log(
    `compaction wall (per /compact → reload chain)  ` +
      `mean=${summary.compaction.meanMs}ms  p50=${summary.compaction.p50Ms}ms  ` +
      `total=${summary.compaction.totalMs}ms`
  );
  console.log(
    `RSS  before=${summary.memory.rssBeforeMB}MB  after=${summary.memory.rssAfterMB}MB  ` +
      `delta=${summary.memory.rssDeltaMB}MB`
  );
  console.log(
    `heap  before=${summary.memory.heapBeforeMB}MB  after=${summary.memory.heapAfterMB}MB  ` +
      `delta=${summary.memory.heapDeltaMB}MB`
  );

  // Stash the JSON; the `exit` handler at the top of the file will write
  // it as the last line of stdout (after node:test's reporter summary).
  finalSummaryLine = JSON.stringify(summary);
});
