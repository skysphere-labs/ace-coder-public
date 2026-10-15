const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptController } = require('../../transcript/index.cts');

function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cap-session-link-'));
}

function createMemoryStore() {
  const links = new Map();
  const entries = new Map();
  return {
    link(streamId: any, row: any) {
      links.set(streamId, { streamId, ...row });
    },
    rebindSession(streamId: any, row: any) {
      entries.set(streamId, []);
      links.set(streamId, { streamId, ...row });
    },
    getLink(streamId: any) {
      return links.get(streamId) || null;
    },
    readEntries(streamId: any) {
      return entries.get(streamId) || [];
    },
    readLatestEntries(streamId: any) {
      return entries.get(streamId) || [];
    },
    readEntriesBefore() {
      return [];
    },
    hasEntriesBefore() {
      return false;
    },
    clear(streamId: any) {
      entries.set(streamId, []);
    },
    unlink(streamId: any) {
      links.delete(streamId);
    },
    unlinkSessionFileAliases(sessionFile: any, keepStreamId: any, options: any = {}) {
      const removed: string[] = [];
      for (const [streamId, link] of Array.from(links.entries())) {
        if (streamId === keepStreamId || link.sessionFile !== sessionFile) continue;
        if (typeof options.shouldUnlink === 'function' && !options.shouldUnlink(streamId, link)) {
          continue;
        }
        links.delete(streamId);
        removed.push(streamId);
      }
      return removed;
    },
    upsertByKey(streamId: any, key: any, build: any) {
      const entry = build(null);
      if (!entry) return null;
      const next = entries.get(streamId) || [];
      next.push({ ...entry, id: next.length, key });
      entries.set(streamId, next);
      return { entry: next[next.length - 1], created: true };
    },
    appendEntry(streamId: any, entry: any) {
      const next = entries.get(streamId) || [];
      const saved = { ...entry, id: next.length };
      next.push(saved);
      entries.set(streamId, next);
      return saved;
    },
    setByteOffset() {},
    setTurnState() {},
    truncateAfter() {},
    close() {},
  };
}

test('Hermes transcript link persists concrete session id to stream owner', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-2b81ec58', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const sessionId = '20260509_120000_abcd12';
  const sessionFile = path.join(sessionsDir, `session_${sessionId}.json`);
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({
      session_id: sessionId,
      session_start: '2026-05-09T12:00:00Z',
      last_updated: '2026-05-09T12:00:00Z',
      messages: [],
    })
  );

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map([[
      'hermes',
      {
        detect: { agent: 'hermes' },
        transcript: {
          kind: 'json-rewrite',
          sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
          matchByCwdField: null,
          matchByWorkspaceHome: true,
          allowExistingSessionFiles: true,
        },
      },
    ]]),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-c8f2cb1e', {
      agent: 'hermes',
      workspaceId: 'prj-2b81ec58',
      spawnedAt: Date.now(),
    });

    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], {
      streamId: 'conversation:conv-c8f2cb1e',
      agent: 'hermes',
      sessionId,
      sessionFile,
      cwd: null,
    });
    assert.deepEqual(
      store.readEntries('conversation:conv-c8f2cb1e'),
      [],
      'test fixture should not persist raw transcript content'
    );
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Hermes seen sentinel links do not overwrite stream owner session id', () => {
  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map(),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    controller._internal.store.link('conversation:conv-seen', {
      agent: 'hermes',
      sessionId: 'seen',
      sessionFile: '/tmp/session_seen.json',
      linkedAt: 1,
    });

    assert.deepEqual(persisted, []);
  } finally {
    controller.shutdown();
  }
});

test('Codex transcript link persists concrete session id to stream owner', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'codex', 'sessions', '2026', '05', '22');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const sessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';
  const cwd = path.join(dir, 'workspace');
  const sessionFile = path.join(sessionsDir, `rollout-2026-05-22T21-10-54-${sessionId}.jsonl`);
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    }) + '\n'
  );

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map([[
      'codex',
      {
        detect: { agent: 'codex' },
        transcript: {
          kind: 'jsonl-append',
          sessionGlob: path.join(dir, 'codex', 'sessions', '*/*/*/rollout-*.jsonl'),
          matchByCwdField: 'payload.cwd',
        },
      },
    ]]),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-codex', {
      agent: 'codex',
      cwd,
      spawnedAt: Date.now() - 1000,
    });

    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], {
      streamId: 'conversation:conv-codex',
      agent: 'codex',
      sessionId,
      sessionFile,
      cwd,
    });
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('known resumed sessions restore a missing transcript link immediately', async () => {
  const dir = await tmpDir();
  const cwd = path.join(dir, 'workspace');
  const sessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';
  const sessionFile = path.join(dir, 'codex', 'sessions', '2026', '05', '22', `rollout-old-${sessionId}.jsonl`);
  await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }) + '\n'
  );
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(sessionFile, old, old);

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map([[
      'codex',
      {
        detect: { agent: 'codex' },
        transcript: {
          kind: 'jsonl-append',
          sessionGlob: path.join(dir, 'codex', 'sessions', '*/*/*/rollout-*.jsonl'),
          matchByCwdField: 'payload.cwd',
        },
      },
    ]]),
    resolveExpectedSessionFile: () => ({ sessionId, sessionFile, cwd }),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-resumed', {
      agent: 'codex',
      cwd,
      spawnedAt: Date.now(),
    });

    assert.equal(persisted.length, 1);
    assert.equal(store.getLink('conversation:conv-resumed').sessionFile, sessionFile);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Claude drops a stale transcript link that does not match the live lane session', async () => {
  const dir = await tmpDir();
  const cwd = path.join(dir, 'workspace');
  const sessionsDir = path.join(dir, 'claude', 'projects', 'workspace');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const staleSessionId = '11111111-1111-4111-8111-111111111111';
  const liveSessionId = '22222222-2222-4222-8222-222222222222';
  const staleSessionFile = path.join(sessionsDir, `${staleSessionId}.jsonl`);
  await fsp.writeFile(staleSessionFile, '{"type":"summary"}\n');

  const store = createMemoryStore();
  const streamId = 'conversation:conv-stale-claude';
  store.link(streamId, {
    agent: 'claude',
    sessionId: staleSessionId,
    sessionFile: staleSessionFile,
    cwd,
    linkedAt: Date.now() - 60_000,
  });
  store.appendEntry(streamId, {
    role: 'agent',
    text: 'belongs to the old session',
    lifecycle: 'finished',
    tAt: Date.now() - 60_000,
  });
  const resets: any[] = [];
  const bus = new EventEmitter();
  bus.on('transcript:reset', (payload: any) => resets.push(payload));
  const controller = createTranscriptController({
    store,
    bus,
    profiles: new Map([[
      'claude',
      {
        detect: { agent: 'claude' },
        transcript: {
          kind: 'jsonl-append',
          sessionGlob: path.join(dir, 'claude', 'projects', '*', '*.jsonl'),
          matchBySessionId: true,
        },
      },
    ]]),
    resolveExpectedSessionId: () => liveSessionId,
  });

  try {
    await controller.linkPending(streamId, {
      agent: 'claude',
      cwd,
      spawnedAt: Date.now(),
    });

    assert.equal(store.getLink(streamId), null, 'the stale session must not remain advertised as live');
    assert.deepEqual(store.readEntries(streamId), [], 'entries from the stale session must not leak into the live lane');
    assert.equal(resets.at(-1)?.reason, 'clear');
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Claude /resume atomically rebinds the owner and transcript to the selected session', async () => {
  const dir = await tmpDir();
  const cwd = path.join(dir, 'workspace');
  const sessionsDir = path.join(dir, 'claude', 'projects', 'workspace');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const currentSessionId = '11111111-1111-4111-8111-111111111111';
  const selectedSessionId = '22222222-2222-4222-8222-222222222222';
  const currentSessionFile = path.join(sessionsDir, `${currentSessionId}.jsonl`);
  const selectedSessionFile = path.join(sessionsDir, `${selectedSessionId}.jsonl`);
  await fsp.writeFile(currentSessionFile, '{"type":"summary"}\n');
  await fsp.writeFile(selectedSessionFile, '{"type":"summary"}\n');
  const old = (Date.now() - 60_000) / 1000;
  await fsp.utimes(selectedSessionFile, old, old);

  const streamId = 'conversation:conv-claude-resume';
  const store = createMemoryStore();
  store.link(streamId, {
    agent: 'claude',
    sessionId: currentSessionId,
    sessionFile: currentSessionFile,
    cwd,
    linkedAt: Date.now() - 60_000,
  });
  store.appendEntry(streamId, {
    role: 'agent',
    text: 'old session turn',
    lifecycle: 'finished',
    tAt: Date.now() - 60_000,
  });
  const persisted = [];
  const settled = [];
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map([[
      'claude',
      {
        detect: { agent: 'claude' },
        transcript: {
          kind: 'jsonl-append',
          sessionGlob: path.join(dir, 'claude', 'projects', '*', '*.jsonl'),
          sessionIdFrom: 'filename',
          matchBySessionId: true,
          linkWindowMs: 60_000,
        },
      },
    ]]),
    resolveExpectedSessionId: () => currentSessionId,
    resolveResumeSessionDir: () => sessionsDir,
    resolveSelectedSessionId: () => selectedSessionId,
    canSwitchSession: () => true,
    onSessionLinked: (row: any) => persisted.push(row),
    onResumeSwitchSettled: (row: any) => settled.push(row),
  });

  try {
    await controller.onSlashResume(streamId, { agent: 'claude', cwd });
    await fsp.utimes(selectedSessionFile, Date.now() / 1000, Date.now() / 1000);
    await controller.onResumeSelection(streamId);
    const deadline = Date.now() + 2000;
    while (persisted.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].agent, 'claude');
    assert.equal(persisted[0].sessionId, selectedSessionId);
    assert.equal(store.getLink(streamId).sessionId, selectedSessionId);
    assert.equal(store.getLink(streamId).sessionFile, selectedSessionFile);
    assert.deepEqual(store.readEntries(streamId), []);
    assert.deepEqual(settled, [{ streamId, reason: 'linked' }]);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Claude /resume keeps the prior transcript pending when either durable rebind step fails', async () => {
  const dir = await tmpDir();
  const cwd = path.join(dir, 'workspace');
  const sessionsDir = path.join(dir, 'claude', 'projects', 'workspace');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const currentSessionId = '11111111-1111-4111-8111-111111111111';
  const selectedSessionId = '22222222-2222-4222-8222-222222222222';
  const currentSessionFile = path.join(sessionsDir, `${currentSessionId}.jsonl`);
  const selectedSessionFile = path.join(sessionsDir, `${selectedSessionId}.jsonl`);
  await fsp.writeFile(currentSessionFile, '{"type":"summary"}\n');
  await fsp.writeFile(selectedSessionFile, '{"type":"summary"}\n');
  const old = (Date.now() - 60_000) / 1000;
  await fsp.utimes(selectedSessionFile, old, old);

  const streamId = 'conversation:conv-claude-resume-persist-failure';
  const store = createMemoryStore();
  store.link(streamId, {
    agent: 'claude',
    sessionId: currentSessionId,
    sessionFile: currentSessionFile,
    cwd,
    linkedAt: Date.now() - 60_000,
  });
  store.appendEntry(streamId, {
    role: 'agent',
    text: 'prior transcript remains visible',
    lifecycle: 'finished',
    tAt: Date.now() - 60_000,
  });
  const settled = [];
  let ownerSessionId = currentSessionId;
  let failOwnerPersistence = true;
  let rollbackCalls = 0;
  const controller = createTranscriptController({
    store,
    bus: new EventEmitter(),
    profiles: new Map([[
      'claude',
      {
        detect: { agent: 'claude' },
        transcript: {
          kind: 'jsonl-append',
          sessionGlob: path.join(dir, 'claude', 'projects', '*', '*.jsonl'),
          sessionIdFrom: 'filename',
          matchBySessionId: true,
          linkWindowMs: 60_000,
        },
      },
    ]]),
    resolveExpectedSessionId: () => currentSessionId,
    resolveResumeSessionDir: () => sessionsDir,
    resolveSelectedSessionId: () => selectedSessionId,
    canSwitchSession: () => true,
    onSessionLinked: (row: any) => {
      if (failOwnerPersistence) throw new Error('owner persistence unavailable');
      const previousSessionId = ownerSessionId;
      ownerSessionId = row.sessionId;
      return () => {
        ownerSessionId = previousSessionId;
        rollbackCalls += 1;
      };
    },
    onResumeSwitchSettled: (row: any) => settled.push(row),
  });

  try {
    await controller.onSlashResume(streamId, { agent: 'claude', cwd });
    await fsp.utimes(selectedSessionFile, Date.now() / 1000, Date.now() / 1000);
    await controller.onResumeSelection(streamId);
    const deadline = Date.now() + 2000;
    while (!controller._internal.warnings.get(streamId)?.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(store.getLink(streamId).sessionId, currentSessionId);
    assert.equal(store.getLink(streamId).sessionFile, currentSessionFile);
    assert.deepEqual(store.readEntries(streamId).map((entry: any) => entry.text), ['prior transcript remains visible']);
    assert.deepEqual(settled, []);
    assert.ok(controller._internal.warnings.get(streamId)?.some((row: any) => row.code === 'session-link:persist'));

    failOwnerPersistence = false;
    store.rebindSession = () => { throw new Error('transcript persistence unavailable'); };
    await fsp.utimes(selectedSessionFile, Date.now() / 1000, Date.now() / 1000);
    await controller.onResumeSelection(streamId);
    const rollbackDeadline = Date.now() + 2000;
    while (rollbackCalls === 0 && Date.now() < rollbackDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(ownerSessionId, currentSessionId);
    assert.equal(rollbackCalls, 1);
    assert.equal(store.getLink(streamId).sessionId, currentSessionId);
    assert.equal(store.getLink(streamId).sessionFile, currentSessionFile);
    assert.deepEqual(store.readEntries(streamId).map((entry: any) => entry.text), ['prior transcript remains visible']);
    assert.deepEqual(settled, []);
    assert.ok(controller._internal.warnings.get(streamId)?.some((row: any) => row.code === 'session-link:rebind'));
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function touchStateDb(stateDb: string) {
  await fsp.writeFile(stateDb, '');
}

test('Modern Hermes state.db links wait for a concrete session id', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus: new EventEmitter(),
    profiles: new Map(),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-modern', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt: Date.now(),
    });

    assert.equal(store.getLink('conversation:conv-modern').sessionFile, stateDb);
    assert.equal(store.getLink('conversation:conv-modern').byteOffset, 0);
    assert.equal(store.getLink('conversation:conv-modern').sessionId, 'live');
    assert.equal(persisted.length, 0);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Modern Hermes state.db links do not inspect messages for a concrete session id', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern-concrete';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);
  const spawnedAt = Date.now() - 1000;

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus: new EventEmitter(),
    profiles: new Map(),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-modern-concrete', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt,
    });

    assert.equal(store.getLink('conversation:conv-modern-concrete').sessionId, 'live');
    assert.equal(controller._internal.tails.size, 0);
    assert.equal(persisted.length, 0);
    assert.deepEqual(store.readEntries('conversation:conv-modern-concrete'), []);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Modern Hermes visible lane relaunch preserves transcript entries without polling state.db messages', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern-visible-relaunch';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);
  const linkedAt = Date.now() - 120_000;
  const oldSessionId = '20260520_045636_d17c60';
  const oldStartedAt = (linkedAt + 1000) / 1000;
  const spawnedAt = Date.now();

  const persisted: any[] = [];
  const store = createMemoryStore();
  store.link('conversation:conv-modern-visible-relaunch', {
    agent: 'hermes',
    sessionId: oldSessionId,
    sessionFile: stateDb,
    cwd: '/tmp/workspace',
    linkedAt,
    byteOffset: 1,
  });
  store.appendEntry('conversation:conv-modern-visible-relaunch', {
    role: 'agent',
    text: 'prior visible answer',
    lifecycle: 'finished',
    tAt: oldStartedAt * 1000,
  });
  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus: new EventEmitter(),
    profiles: new Map(),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-modern-visible-relaunch', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt,
    });

    const link = store.getLink('conversation:conv-modern-visible-relaunch');
    assert.equal(link.sessionId, 'live');
    assert.ok(link.linkedAt >= spawnedAt);
    assert.deepEqual(
      store.readEntries('conversation:conv-modern-visible-relaunch').map((entry: any) => entry.text).filter(Boolean),
      ['prior visible answer']
    );
    assert.equal(controller._internal.tails.size, 0);
    assert.equal(persisted.length, 0);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Modern Hermes state.db alias pruning can preserve a protected live stream', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern-alias';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);
  const spawnedAt = Date.now() - 1000;

  const store = createMemoryStore();
  const bus = new EventEmitter();
  const resets: any[] = [];
  bus.on('transcript:reset', (payload: any) => resets.push(payload));
  store.link('conversation:active-rook', {
    agent: 'hermes',
    sessionId: 'live',
    sessionFile: stateDb,
    cwd: '/tmp/workspace',
    linkedAt: spawnedAt,
  });
  store.appendEntry('conversation:active-rook', {
    role: 'user',
    text: 'keep me visible',
    lifecycle: 'finished',
    tAt: spawnedAt,
  });

  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus,
    profiles: new Map(),
    shouldPruneTranscriptAlias: ({ aliasStreamId }: any) => aliasStreamId !== 'conversation:active-rook',
  });

  try {
    await controller.linkPending('conversation:booting-rook', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt,
    });

    assert.ok(store.getLink('conversation:active-rook'));
    assert.equal(store.readEntries('conversation:active-rook')[0].text, 'keep me visible');
    assert.equal(
      resets.some((payload) => payload?.streamId === 'conversation:active-rook'),
      false
    );
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Modern Hermes state.db alias pruning unlinks aliases without clearing their transcript entries', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern-alias-prune';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);
  const spawnedAt = Date.now() - 1000;

  const store = createMemoryStore();
  const bus = new EventEmitter();
  const resets: any[] = [];
  bus.on('transcript:reset', (payload: any) => resets.push(payload));
  store.link('conversation:stale-rook', {
    agent: 'hermes',
    sessionId: 'live',
    sessionFile: stateDb,
    cwd: '/tmp/workspace',
    linkedAt: spawnedAt,
  });
  store.appendEntry('conversation:stale-rook', {
    role: 'agent',
    text: 'stale transcript should not be deleted',
    lifecycle: 'finished',
    tAt: spawnedAt,
  });

  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus,
    profiles: new Map(),
  });

  try {
    await controller.linkPending('conversation:new-rook', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt,
    });

    assert.equal(store.getLink('conversation:stale-rook'), null);
    assert.equal(store.readEntries('conversation:stale-rook')[0].text, 'stale transcript should not be deleted');
    assert.ok(
      resets.some((payload) => payload?.streamId === 'conversation:stale-rook' && payload?.reason === 'alias-prune')
    );
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Modern Hermes state.db does not attach fresh streams to older background sessions', async () => {
  const dir = await tmpDir();
  const workspaceId = 'prj-modern-old';
  const home = path.join(dir, `hermes-home-${workspaceId}`);
  await fsp.mkdir(home, { recursive: true });
  const stateDb = path.join(home, 'state.db');
  await touchStateDb(stateDb);
  const spawnedAt = Date.now();

  const persisted = [];
  const store = createMemoryStore();
  const controller = createTranscriptController({
    userDataPath: dir,
    store,
    bus: new EventEmitter(),
    profiles: new Map(),
    onSessionLinked: (row: any) => persisted.push(row),
  });

  try {
    await controller.linkPending('conversation:conv-modern-old', {
      agent: 'hermes',
      workspaceId,
      cwd: '/tmp/workspace',
      spawnedAt,
    });

    assert.equal(store.getLink('conversation:conv-modern-old').sessionId, 'live');
    assert.equal(persisted.length, 0);
    assert.deepEqual(store.readEntries('conversation:conv-modern-old'), []);
  } finally {
    controller.shutdown();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
