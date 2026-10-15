const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCompactionController } = require('../orchestrator-compaction.cjs');

function createHarness({ threshold, envThreshold, statesByTaskId, dbError, getStateError, resumeCheckpoint } = {}) {
  const prev = process.env.ACE_COMPACT_AFTER;
  if (envThreshold == null) delete process.env.ACE_COMPACT_AFTER;
  else process.env.ACE_COMPACT_AFTER = String(envThreshold);
  const events = new EventEmitter();
  const sent = [];
  const waited = [];
  const logs = [];
  const store = {
    on: (event, listener) => {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    emit: (event, payload) => events.emit(event, payload),
  };
  const db = {
    prepare: () => ({
      get: (taskId) => {
        if (dbError) throw dbError;
        return { id: `${taskId}-conv` };
      },
    }),
  };
  const streamApi = {
    getState: async ({ streamId }) => {
      if (getStateError) throw getStateError;
      const taskId = String(streamId).replace(/^conversation:/, '').replace(/-conv$/, '');
      return { state: statesByTaskId?.[taskId] || 'turn-complete' };
    },
    sendInput: async (args) => { sent.push(args); return { ok: true }; },
    submit: async () => ({ ok: true }),
    waitFor: async (args) => { waited.push(args); return { state: 'turn-complete' }; },
  };
  const logger = {
    warn: (msg, err) => logs.push({ level: 'warn', msg, err }),
    error: (msg, err) => logs.push({ level: 'error', msg, err }),
    log: (msg) => logs.push({ level: 'log', msg }),
  };
  const checkpoint = resumeCheckpoint || (() => ({
    packet: {
      schema: 'AceResumePacket/v1',
      missionId: 'msn-1',
      workspaceId: 'prj-1',
      primaryPlanDoc: '/tmp/plan.md',
      referenceFiles: ['/tmp/plan.md'],
      currentPhase: 'review-required',
      currentGate: 'review-required',
      activePrs: [123],
      activeWorkers: [{ streamId: 'variant:var-1', taskId: 'tsk-worker', branch: 'worker-branch', pr: 123 }],
      watchers: [],
      forbiddenActions: ['no rebuild/relaunch', 'no destructive cleanup/delete/prune/branch deletion'],
      liveRecheckCommands: ['ace --json mission board --workspace prj-1 --mission msn-1'],
      nextAction: 'Recheck REVIEW_REQUIRED before acting.',
    },
  }));
  const controller = createCompactionController({
    aceStore: store,
    db,
    streamApi,
    threshold,
    logger,
    resumeCheckpoint: checkpoint,
  });
  const stop = controller.start();
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function emit(taskId, change = {}) {
    store.emit('orchestrator-runtime:state-change', {
      taskId,
      from: 'integrate',
      to: 'cleanup',
      ...change,
    });
    await flush();
  }
  function restoreEnv() {
    if (prev == null) delete process.env.ACE_COMPACT_AFTER;
    else process.env.ACE_COMPACT_AFTER = prev;
  }
  return { sent, waited, logs, emit, stop, restoreEnv };
}

test('createCompactionController: increments per cleanup event', async () => {
  const h = createHarness({ threshold: 2 });
  try {
    await h.emit('tsk-1');
    assert.equal(h.sent.length, 0);
    await h.emit('tsk-1');
    assert.equal(h.sent[0].text, '/compact');
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: triggers /compact at threshold', async () => {
  const h = createHarness({ threshold: 2 });
  try {
    await h.emit('tsk-1');
    await h.emit('tsk-1');
    assert.equal(h.sent[0].text, '/compact');
    assert.equal(h.sent[0].mode, 'type');
    assert.equal(h.sent[1].mode, 'type');
    assert.match(h.sent[1].text, /ACE_RESUME_PACKET v1/);
    assert.match(h.sent[1].text, /"missionId": "msn-1"/);
    assert.match(h.sent[1].text, /"primaryPlanDoc": "\/tmp\/plan.md"/);
    assert.match(h.sent[1].text, /"currentGate": "review-required"/);
    assert.match(h.sent[1].text, /no rebuild\/relaunch/);
    assert.match(h.sent[1].text, /ace --json mission board --workspace prj-1 --mission msn-1/);
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: sends reload prompt after turn-complete', async () => {
  const h = createHarness({ threshold: 1 });
  try {
    await h.emit('tsk-1');
    assert.deepEqual(h.waited, [
      { streamId: 'conversation:tsk-1-conv', predicate: { turnComplete: true }, timeoutMs: 300_000 },
    ]);
    assert.match(h.sent[1].text, /Re-read the bundled skill `ace-hermes-router`/);
    assert.match(h.sent[1].text, /ACE_RESUME_PACKET v1/);
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: defers when stream state is busy', async () => {
  const statesByTaskId = { 'tsk-1': 'busy' };
  const h = createHarness({ threshold: 2, statesByTaskId });
  try {
    await h.emit('tsk-1');
    await h.emit('tsk-1');
    assert.equal(h.sent.length, 0);
    assert.match(h.logs[0].msg, /compaction deferred: state=busy/);
    statesByTaskId['tsk-1'] = 'turn-complete';
    await h.emit('tsk-1');
    assert.equal(h.sent[0].text, '/compact');
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: env override reads threshold', async () => {
  const h = createHarness({ envThreshold: 3 });
  try {
    await h.emit('tsk-1');
    await h.emit('tsk-1');
    assert.equal(h.sent.length, 0);
    await h.emit('tsk-1');
    assert.equal(h.sent[0].text, '/compact');
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: per-taskId counts are isolated', async () => {
  const h = createHarness({ threshold: 2 });
  try {
    await h.emit('tsk-a');
    await h.emit('tsk-b');
    await h.emit('tsk-a');
    assert.equal(h.sent[0].text, '/compact');
    assert.match(h.sent[0].streamId, /tsk-a/);
    h.sent.length = 0;
    await h.emit('tsk-b');
    assert.match(h.sent[0].streamId, /tsk-b/);
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: handler failures are swallowed and logged', async () => {
  const h = createHarness({ threshold: 1, getStateError: new Error('boom') });
  try {
    assert.doesNotThrow(() =>
      h.emit('tsk-1', { event: 'cleaned', from: 'cleanup', to: 'cleanup' })
    );
    await h.emit('tsk-1');
    assert.equal(h.sent.length, 0);
    assert.match(h.logs[0].msg, /compaction failed/);
    assert.equal(h.logs[0].err.message, 'boom');
  } finally {
    h.stop();
    h.restoreEnv();
  }
});

test('createCompactionController: defers when resume checkpoint fails', async () => {
  const h = createHarness({
    threshold: 1,
    resumeCheckpoint: () => {
      throw new Error('checkpoint boom');
    },
  });
  try {
    await h.emit('tsk-1');
    assert.equal(h.sent.length, 0);
    assert.match(h.logs[0].msg, /compaction deferred: resume packet failed/);
    assert.equal(h.logs[0].err.message, 'checkpoint boom');
  } finally {
    h.stop();
    h.restoreEnv();
  }
});
