const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computeHermesCodeFingerprint,
  runHermesStaleCodeCheck,
} = require('../local-core.cjs');

function makeTmpAgentDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-fp-test-'));
}

function seedGitHead(agentDir: any, { head, refs = {} }: any) {
  fs.mkdirSync(path.join(agentDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, '.git', 'HEAD'), head);
  for (const [refRel, sha] of Object.entries(refs)) {
    const refPath = path.join(agentDir, '.git', ...refRel.split('/'));
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, sha as any);
  }
}

test('computeHermesCodeFingerprint resolves a symbolic HEAD through its ref file', () => {
  const agentDir = makeTmpAgentDir();
  seedGitHead(agentDir, {
    head: 'ref: refs/heads/main\n',
    refs: { 'refs/heads/main': 'abc123def4567890abc123def4567890abc123de\n' },
  });
  assert.equal(
    computeHermesCodeFingerprint({ hermesAgentDir: agentDir }),
    'abc123def4567890abc123def4567890abc123de'
  );
});

test('computeHermesCodeFingerprint returns a detached HEAD sha directly', () => {
  const agentDir = makeTmpAgentDir();
  seedGitHead(agentDir, { head: 'fedcba9876543210fedcba9876543210fedcba98\n' });
  assert.equal(
    computeHermesCodeFingerprint({ hermesAgentDir: agentDir }),
    'fedcba9876543210fedcba9876543210fedcba98'
  );
});

test('computeHermesCodeFingerprint falls back to the binary mtime when git state is unreadable', () => {
  const agentDir = makeTmpAgentDir(); // no .git at all
  const binPath = path.join(agentDir, 'hermes');
  fs.writeFileSync(binPath, '#!/bin/sh\n');
  const expected = `mtime:${fs.statSync(binPath).mtimeMs}`;
  assert.equal(computeHermesCodeFingerprint({ hermesAgentDir: agentDir, binPath }), expected);
});

test('computeHermesCodeFingerprint resolves symlinked binaries to their realpath for the fallback', () => {
  const agentDir = makeTmpAgentDir();
  const target = path.join(agentDir, 'hermes-real');
  const link = path.join(agentDir, 'hermes-link');
  fs.writeFileSync(target, '#!/bin/sh\n');
  fs.symlinkSync(target, link);
  const expected = `mtime:${fs.statSync(target).mtimeMs}`;
  assert.equal(computeHermesCodeFingerprint({ hermesAgentDir: agentDir, binPath: link }), expected);
});

test('computeHermesCodeFingerprint falls back when the ref file is missing, and nulls on total failure', () => {
  const agentDir = makeTmpAgentDir();
  // Symbolic HEAD whose ref file does not exist (e.g. packed refs).
  seedGitHead(agentDir, { head: 'ref: refs/heads/main\n' });
  const binPath = path.join(agentDir, 'hermes');
  fs.writeFileSync(binPath, '#!/bin/sh\n');
  assert.equal(
    computeHermesCodeFingerprint({ hermesAgentDir: agentDir, binPath }),
    `mtime:${fs.statSync(binPath).mtimeMs}`
  );
  // No git state AND a missing binary → null, never a throw.
  assert.equal(
    computeHermesCodeFingerprint({
      hermesAgentDir: path.join(agentDir, 'nope'),
      binPath: path.join(agentDir, 'missing-bin'),
    }),
    null
  );
});

// --- watchdog drift decision logic -----------------------------------------

function makeStream(overrides: any = {}) {
  return {
    agent: 'hermes',
    status: 'running',
    hermesCodeFingerprint: 'old-sha',
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

function makeHarness({ resumable = () => true, claim = () => ({ attempt: 1 }) }: any = {}) {
  const calls: any = { banners: [], killed: [], restarted: [] };
  const deps = {
    isResumableStream: resumable,
    claimRestart: claim,
    emitBanner: (id: any, chunk: any) => calls.banners.push({ id, chunk }),
    killStream: (id: any) => calls.killed.push(id),
    restartStream: (id: any, dims: any) => calls.restarted.push({ id, dims }),
    logger: { warn: () => {} },
  };
  return { calls, deps };
}

test('stale running hermes stream with a resumable session is killed and restarted with its dims', () => {
  const { calls, deps } = makeHarness();
  const stream = makeStream();
  const streams = new Map([['conversation:c1', stream]]);
  const summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 1, restarted: 1, notified: 0 });
  assert.deepEqual(calls.killed, ['conversation:c1']);
  assert.deepEqual(calls.restarted, [{ id: 'conversation:c1', dims: { cols: 100, rows: 30 } }]);
  assert.equal(calls.banners.length, 1);
  assert.match(calls.banners[0].chunk, /Hermes agent code updated on disk/);
  assert.match(calls.banners[0].chunk, /restarting this tab/);
});

test('streams whose fingerprint matches the on-disk code are untouched', () => {
  const { calls, deps } = makeHarness();
  const streams = new Map([['conversation:c1', makeStream({ hermesCodeFingerprint: 'new-sha' })]]);
  const summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 0, restarted: 0, notified: 0 });
  assert.equal(calls.banners.length + calls.killed.length + calls.restarted.length, 0);
});

test('null fingerprints (recorded or current) never trigger a restart', () => {
  const { calls, deps } = makeHarness();
  const streams = new Map([
    ['conversation:c1', makeStream({ hermesCodeFingerprint: null })],
    ['conversation:c2', makeStream()],
  ]);
  // Recorded fingerprint null → skipped even though current differs.
  let summary = runHermesStaleCodeCheck({ streams: new Map([['conversation:c1', streams.get('conversation:c1')]]), currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 0, restarted: 0, notified: 0 });
  // Current fingerprint null → nothing is touched at all.
  summary = runHermesStaleCodeCheck({ streams, currentFingerprint: null, ...deps });
  assert.deepEqual(summary, { stale: 0, restarted: 0, notified: 0 });
  assert.equal(calls.banners.length + calls.killed.length + calls.restarted.length, 0);
});

test('non-hermes and non-running streams are skipped', () => {
  const { calls, deps } = makeHarness();
  const streams = new Map([
    ['shell:t1', makeStream({ agent: 'shell' })],
    ['conversation:c1', makeStream({ agent: 'claude', hermesCodeFingerprint: 'old-sha' })],
    ['conversation:c2', makeStream({ status: 'exited' })],
  ]);
  const summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 0, restarted: 0, notified: 0 });
  assert.equal(calls.killed.length + calls.restarted.length, 0);
});

test('stale stream WITHOUT a resumable session gets a manual-restart banner only', () => {
  const { calls, deps } = makeHarness({ resumable: () => false });
  const streams = new Map([['conversation:c1', makeStream()]]);
  const summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 1, restarted: 0, notified: 1 });
  assert.equal(calls.killed.length, 0);
  assert.equal(calls.restarted.length, 0);
  assert.equal(calls.banners.length, 1);
  assert.match(calls.banners[0].chunk, /no resumable session/);
  assert.match(calls.banners[0].chunk, /restart it manually/);
});

test('a denied restart claim downgrades the restart to a manual-restart banner', () => {
  const { calls, deps } = makeHarness({ claim: () => null });
  const streams = new Map([['conversation:c1', makeStream()]]);
  const summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 1, restarted: 0, notified: 1 });
  assert.equal(calls.killed.length + calls.restarted.length, 0);
  assert.match(calls.banners[0].chunk, /restarted repeatedly/);
});

test('a stream is handled at most once per fingerprint change', () => {
  const { calls, deps } = makeHarness();
  const stream = makeStream();
  const streams = new Map([['conversation:c1', stream]]);
  let summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 1, restarted: 1, notified: 0 });
  // Same fingerprint again (e.g. the kill/restart had not finished by the
  // next tick): no second restart.
  summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'new-sha', ...deps });
  assert.deepEqual(summary, { stale: 0, restarted: 0, notified: 0 });
  assert.equal(calls.restarted.length, 1);
  // A NEW fingerprint change is handled again.
  summary = runHermesStaleCodeCheck({ streams, currentFingerprint: 'newer-sha', ...deps });
  assert.deepEqual(summary, { stale: 1, restarted: 1, notified: 0 });
  assert.equal(calls.restarted.length, 2);
});
