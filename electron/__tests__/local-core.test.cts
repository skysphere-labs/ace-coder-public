const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const Database = require('better-sqlite3');

const {
  archiveTaskRow,
  createAceStore,
  createAlwaysOnOrchestratorWatchdog,
  createGitWatcher,
  createPtyRegistry,
  hermesTerminalBottomPinEnv,
  hermesTerminalBottomPinEnvEntries,
  agentTerminalForcedEnvEntries,
  sanitizeAgentSpawnEnv,
  ensureAceCodexHome,
  codexDefaultWorkerEnv,
  laneIsInteractiveLane,
  respawnLaunchIntentFor,
  laneWorkerClassificationIntent,
  buildRemoteAgentCommand,
  shouldUseClaudeMcp,
  shouldUseGlobalCodexMcp,
  resolvePersonalIdentity,
  resolveClonePath,
  shouldAttachStartupGitWatchers,
  shouldUseFullTreeGitWatcher,
  shouldSuppressPersonalHermesAutoPrompt,
  shouldInjectPersonalHermesWakeBrief,
  hasExistingHermesWakeBrief,
  resolveClaudeProcessSessionId,
} = require('../local-core.cjs');
const claudeAuthPolicy = require('../claude-auth-policy.cjs');
const { BetterSqlite3NodeShim } = require('./helpers/better-sqlite3-node-shim.cts');
const {
  buildLaunchIntent,
  codexAppParityRequested,
} = require('../../tools/ace/src/orchestrator.cjs');

test('resolveClaudeProcessSessionId reads the exact live Claude process session record', () => {
  const originalSessionId = '11111111-1111-4111-8111-111111111111';
  const selectedSessionId = '22222222-2222-4222-8222-222222222222';
  const cwd = '/tmp/exact-claude-lane';
  const result = resolveClaudeProcessSessionId(
    { expectedSessionId: originalSessionId, cwd, configDir: '/tmp/claude-config' },
    {
      listProcesses: () => ` 123 /usr/local/bin/claude --session-id ${originalSessionId} --dangerously-skip-permissions\n`,
      readFile: (file) => {
        assert.equal(file, '/tmp/claude-config/sessions/123.json');
        return JSON.stringify({ pid: 123, cwd, sessionId: selectedSessionId });
      },
    }
  );
  assert.equal(result, selectedSessionId);

  const ambiguous = resolveClaudeProcessSessionId(
    { expectedSessionId: originalSessionId, cwd, configDir: '/tmp/claude-config' },
    {
      listProcesses: () => [
        `123 /usr/local/bin/claude --session-id ${originalSessionId}`,
        `456 /usr/local/bin/claude --resume ${originalSessionId}`,
      ].join('\n'),
      readFile: () => { throw new Error('must not read an ambiguous process'); },
    }
  );
  assert.equal(ambiguous, null);
});

function git(cwd: any, ...args: any[]) {
  return require('node:child_process').execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(filePath: any, contents: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function writeExecutable(filePath: any, contents: any) {
  writeFile(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

// ---- Lane-capability test fixtures (shared by the strip/restore tests) ----
const laneDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The strip is gated by ACE_ENABLE_{CLAUDE,CODEX}_MCP; clear them for the test and
// restore on cleanup so an operator's environment can't flip the assertions.
function clearMcpOptInEnv() {
  const prev = { claude: process.env.ACE_ENABLE_CLAUDE_MCP, codex: process.env.ACE_ENABLE_CODEX_MCP };
  delete process.env.ACE_ENABLE_CLAUDE_MCP;
  delete process.env.ACE_ENABLE_CODEX_MCP;
  return () => {
    if (prev.claude == null) delete process.env.ACE_ENABLE_CLAUDE_MCP; else process.env.ACE_ENABLE_CLAUDE_MCP = prev.claude;
    if (prev.codex == null) delete process.env.ACE_ENABLE_CODEX_MCP; else process.env.ACE_ENABLE_CODEX_MCP = prev.codex;
  };
}

// A pty impl that records every spawn's args so a test can assert the strip.
function capturingPtyImpl() {
  const spawned: any[] = [];
  return {
    spawned,
    ptyImpl: {
      spawn(bin: any, args: any, opts: any) {
        const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
        spawned.push(proc);
        return proc;
      },
    },
  };
}

// A createPtyRegistry wired to a capturing pty, a stubbed subscription-auth OK,
// and a fake `claude` on PATH (via extraEnv) so buildAgentCommand resolves it.
function laneRegistry() {
  const { spawned, ptyImpl } = capturingPtyImpl();
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {}, writeData(_id: any, d: string) { return { seq: 1, rewritten: d }; }, resize() {}, remove() {}, sync() { return { text: '' }; },
  }, {}, { ptyImpl, verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }) });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lane-bin-'));
  writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  const extraEnv = { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` };
  const restoreEnv = clearMcpOptInEnv();
  // Spawn/adopt a claude lane; returns the registry stream after it settles.
  const spawn = (streamId: string, ownerKind: string, ownerId: string, launchIntent?: any) =>
    registry.ensureStream({ streamId, agent: 'claude', cwd: '/tmp', ownerKind, ownerId, cols: 80, rows: 24, launchIntent, extraEnv });
  const cleanup = () => { restoreEnv(); fs.rmSync(binDir, { recursive: true, force: true }); };
  return { registry, spawned, extraEnv, spawn, cleanup };
}

// Boot the REAL createAceStore against the node:sqlite-backed driver (the packaged
// better-sqlite3 is Electron-ABI and won't load in the test runner). withRepo adds
// a git workspace + a fake `claude` on PATH so real claude lanes can spawn.
function bootLaneStore({ withRepo = false, ptyHost = undefined }: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lane-store-'));
  const { spawned, ptyImpl } = capturingPtyImpl();
  let repo: string | undefined;
  let restorePath: string | undefined;
  if (withRepo) {
    repo = path.join(root, 'repo');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
    const genv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const cpx = require('node:child_process');
    cpx.execFileSync('git', ['init', '-q'], { cwd: repo });
    cpx.execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: repo, env: genv });
    restorePath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${restorePath}`;
  }
  const restoreEnv = clearMcpOptInEnv();
  const store = createAceStore(path.join(root, 'ud'), {
    Database: BetterSqlite3NodeShim,
    ptyImpl,
    ptyHost,
    exposeInternals: true,
    verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
  });
  const cleanup = () => {
    restoreEnv();
    if (restorePath !== undefined) process.env.PATH = restorePath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, spawned, repo, cleanup };
}

// Create a claude conversation and spawn its lane through the REAL store path.
async function spawnStoreClaudeLane(store: any, workspaceId: any, name: string, launchIntent?: any) {
  const t = await store.createThread({ workspaceId, input: { name, agent: 'claude', prompt: null, kind: 'cli' } });
  const streamId = `conversation:${t.conversationId}`;
  await store.ensureStreamStarted({ streamId, cols: 80, rows: 24, ...(launchIntent ? { launchIntent } : {}) });
  return streamId;
}

const hasStrip = (proc: any) => !!proc && proc.args.includes('--strict-mcp-config');

class FakeRemoteDaemon extends EventEmitter {
  starts: any[] = [];
  kills: any[] = [];
  execs: any[] = [];
  claudeAuthStatus: any = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'max',
  };
  claudeSetupTokenPresent = false;
  nextPtyId = 1;

  async ensureReady() {}

  async fsStat() {
    return { exists: true, kind: 'dir' };
  }

  async fsList(remotePath: any) {
    return { path: remotePath, home: '/home/ace', entries: [], has_git: true };
  }

  async exec(spec: any = {}) {
    this.execs.push(spec);
    if (Array.isArray(spec.args) && spec.args.some((arg: any) =>
      String(arg).includes('CLAUDE_CODE_OAUTH_TOKEN')
    )) {
      return { code: this.claudeSetupTokenPresent ? 0 : 1, stdout: '', stderr: '' };
    }
    if (Array.isArray(spec.args) && spec.args.includes('auth') && spec.args.includes('status')) {
      return { code: 0, stdout: JSON.stringify(this.claudeAuthStatus), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async startPty(spec: any) {
    const id = `pty-${this.nextPtyId++}`;
    this.starts.push({ id, ...spec });
    return { id };
  }

  resizePty() {}
  writePty() {}
  killPty(id: any) { this.kills.push(id); }
  close() {}
}

function fakeRemoteManager(daemon: any) {
  return {
    get() { return daemon; },
    warm() {},
    closeAll() {},
  };
}

function insertRemoteWorkspace(store: any, root: string, id = 'prj-remote', opts: any = {}) {
  const now = new Date().toISOString();
  const remotePath = path.posix.join('/srv/ace', path.basename(root));
  const sshHost = opts.sshHost || 'cloud.example';
  const sshUser = opts.sshUser === undefined ? 'root' : opts.sshUser;
  const agentUser = opts.agentUser === undefined ? 'agent' : opts.agentUser;
  store.getDb()
    .prepare(
      `INSERT INTO projects (id, name, path, is_remote, ssh_host, ssh_user, remote_path, agent_user, original_owner, default_branch, github_repo, initialized, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, 'main', NULL, 1, ?, ?)`
    )
    .run(id, 'remote', `ssh://${sshHost}${remotePath}`, sshHost, sshUser, remotePath, agentUser, now, now);
  return { workspaceId: id, remotePath };
}

test('archiveTaskRow: writes archived_at + archived_pr_url without deleting the row', () => {
  const calls: any[] = [];
  const db = {
    prepare(sql: any) {
      assert.match(sql, /UPDATE tasks SET archived_at = \?, archived_pr_url = \?, updated_at = \? WHERE id = \?/);
      return {
        run(...args: any[]) {
          calls.push(args);
          return { changes: 1 };
        },
      };
    },
  };

  const mergedAt = '2026-04-20T12:34:56.000Z';
  const prUrl = 'https://github.com/example/ace/pull/77';
  const result = archiveTaskRow({
    db,
    getTaskById: (taskId: any) => ({ id: taskId }),
    taskId: 'tsk_77',
    prUrl,
    mergedAt,
  });

  assert.deepEqual(calls, [[mergedAt, prUrl, mergedAt, 'tsk_77']]);
  assert.deepEqual(result, { archivedAt: mergedAt, prUrl });
});

test('store boot clears legacy Hermes seen resume tokens without clearing concrete ids', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-seen-repair-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const first = createAceStore(userDataPath);
  const stores = [first];
  t.after(() => {
    for (const store of stores) {
      try { store.shutdown(); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await first.importWorkspace({ workspacePath: repoPath });
  const seenThread = await first.createThread({
    workspaceId,
    input: { name: 'King seen', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  const concreteThread = await first.createThread({
    workspaceId,
    input: { name: 'Rook concrete', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  first.writeSessionIdForStream(`conversation:${seenThread.conversationId}`, 'seen');
  first.writeSessionIdForStream(`conversation:${concreteThread.conversationId}`, '20260518_121500_bcde34');
  first.shutdown();

  fs.rmSync(path.join(userDataPath, '.hermes-seen-cleared-v2'), { force: true });
  const second = createAceStore(userDataPath);
  stores.push(second);
  const rows = second.getDb()
    .prepare('SELECT id, session_id FROM conversations WHERE id IN (?, ?) ORDER BY id')
    .all(seenThread.conversationId, concreteThread.conversationId);
  const byId = new Map(rows.map((row: any) => [row.id, row.session_id]));

  assert.equal(byId.get(seenThread.conversationId), null);
  assert.equal(byId.get(concreteThread.conversationId), '20260518_121500_bcde34');
});

test('store boot clears malformed Hermes concrete session ids but keeps healthy ids', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-invalid-session-repair-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const first = createAceStore(userDataPath);
  const stores = [first];
  t.after(() => {
    for (const store of stores) {
      try { store.shutdown(); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await first.importWorkspace({ workspacePath: repoPath });
  const badThread = await first.createThread({
    workspaceId,
    input: { name: 'Bad Hermes resume', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  const goodThread = await first.createThread({
    workspaceId,
    input: { name: 'Good Hermes resume', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  first.writeSessionIdForStream(`conversation:${badThread.conversationId}`, '20260513_193603_a71544');
  first.writeSessionIdForStream(`conversation:${goodThread.conversationId}`, '20260625_201812_c5deb0');

  const hermesStateDir = path.join(userDataPath, `hermes-home-${workspaceId}`);
  fs.mkdirSync(hermesStateDir, { recursive: true });
  const hdb = new Database(path.join(hermesStateDir, 'state.db'));
  try {
    hdb.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        model_config TEXT,
        billing_provider TEXT,
        billing_base_url TEXT
      )`
    );
    hdb.prepare(
      'INSERT INTO sessions (id, model, model_config, billing_provider, billing_base_url) VALUES (?, ?, ?, ?, ?)'
    ).run(
      '20260513_193603_a71544',
      'claude-opus-4-7',
      JSON.stringify({ max_iterations: 1000000 }),
      'te the pr',
      'ivate GitHub repo'
    );
    hdb.prepare(
      'INSERT INTO sessions (id, model, model_config, billing_provider, billing_base_url) VALUES (?, ?, ?, ?, ?)'
    ).run(
      '20260625_201812_c5deb0',
      'gpt-5.5',
      JSON.stringify({ max_iterations: 1000000 }),
      'openai-codex',
      'https://chatgpt.com/backend-api/codex'
    );
  } finally {
    hdb.close();
  }
  first.shutdown();

  const second = createAceStore(userDataPath);
  stores.push(second);
  const rows = second.getDb()
    .prepare('SELECT id, session_id FROM conversations WHERE id IN (?, ?) ORDER BY id')
    .all(badThread.conversationId, goodThread.conversationId);
  const byId = new Map(rows.map((row: any) => [row.id, row.session_id]));

  assert.equal(byId.get(badThread.conversationId), null);
  assert.equal(byId.get(goodThread.conversationId), '20260625_201812_c5deb0');
});

test('Hermes concrete resume follows the latest compression continuation tip before spawn', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-compression-tip-'));
  const home = path.join(root, 'home');
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'hermes'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = {
        bin,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Hermes compression tip', agent: 'hermes', prompt: null, kind: 'cli' },
  });

  const rootSessionId = '20260627_120000_root';
  const compressionChildId = '20260627_120010_mid';
  const tipSessionId = '20260627_120020_tip';
  const ignoredBranchId = '20260627_120030_branch';
  const ignoredToolId = '20260627_120040_tool';
  store.writeSessionIdForStream(`conversation:${thread.conversationId}`, rootSessionId);

  const hermesStateDir = path.join(userDataPath, `hermes-home-${workspaceId}`);
  fs.mkdirSync(hermesStateDir, { recursive: true });
  const hdb = new Database(path.join(hermesStateDir, 'state.db'));
  try {
    hdb.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        model TEXT,
        model_config TEXT,
        billing_provider TEXT,
        billing_base_url TEXT,
        parent_session_id TEXT,
        started_at REAL,
        ended_at REAL,
        end_reason TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        timestamp REAL
      )`
    );
    const insertSession = hdb.prepare(
      `INSERT INTO sessions
        (id, source, model, model_config, billing_provider, billing_base_url, parent_session_id, started_at, ended_at, end_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const modelConfig = JSON.stringify({ provider: 'openai-codex' });
    insertSession.run(rootSessionId, 'cli', 'gpt-5.5', modelConfig, 'openai-codex', null, null, 1, 2, 'compression');
    insertSession.run(compressionChildId, 'cli', 'gpt-5.5', modelConfig, 'openai-codex', null, rootSessionId, 3, 4, 'compression');
    insertSession.run(tipSessionId, 'cli', 'gpt-5.5', modelConfig, 'openai-codex', null, compressionChildId, 5, null, null);
    insertSession.run(ignoredBranchId, 'cli', 'gpt-5.5', JSON.stringify({ provider: 'openai-codex', _branched_from: rootSessionId }), 'openai-codex', null, rootSessionId, 100, null, null);
    insertSession.run(ignoredToolId, 'tool', 'gpt-5.5', modelConfig, 'openai-codex', null, rootSessionId, 101, null, null);
    hdb.prepare('INSERT INTO messages (session_id, timestamp) VALUES (?, ?)').run(tipSessionId, 200);
  } finally {
    hdb.close();
  }

  const result = await store.ensureStreamStarted({
    streamId: `conversation:${thread.conversationId}`,
    cols: 80,
    rows: 24,
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(0, 2), ['--resume', tipSessionId]);
  assert.equal(spawned[0].args.includes(rootSessionId), false);
  assert.equal(spawned[0].opts.env.HERMES_HOME, hermesStateDir);
  const row = store.getDb()
    .prepare('SELECT session_id FROM conversations WHERE id=?')
    .get(thread.conversationId);
  assert.equal(row.session_id, tipSessionId);
});

test('Codex concrete resume is exact and scoped to the rollout cwd', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-resume-'));
  const home = path.join(root, 'home');
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = {
        bin,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
      spawned.push(proc);
      return proc;
    },
  };

  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const matching = await store.createThread({
    workspaceId,
    input: { name: 'Codex exact', agent: 'codex', prompt: null, kind: 'cli' },
  });
  const stale = await store.createThread({
    workspaceId,
    input: { name: 'Codex stale', agent: 'codex', prompt: null, kind: 'cli' },
  });

  const matchingSessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';
  const staleSessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f3';
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '05', '22');
  fs.mkdirSync(sessionsDir, { recursive: true });
  writeFile(
    path.join(sessionsDir, `rollout-2026-05-22T21-10-54-${matchingSessionId}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: matchingSessionId, cwd: repoPath } }) + '\n'
  );
  writeFile(
    path.join(sessionsDir, `rollout-2026-05-22T21-10-55-${staleSessionId}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: staleSessionId, cwd: path.join(root, 'other') } }) + '\n'
  );

  store.writeSessionIdForStream(`conversation:${matching.conversationId}`, matchingSessionId);
  store.writeSessionIdForStream(`conversation:${stale.conversationId}`, staleSessionId);

  assert.equal(
    (await store.ensureStreamStarted({
      streamId: `conversation:${matching.conversationId}`,
      cols: 80,
      rows: 24,
    })).ok,
    true
  );
  assert.deepEqual(spawned[0].args.slice(0, 2), [
    '-c',
    'mcp_servers={}',
  ]);
  assert.deepEqual(spawned[0].args.slice(-2), ['resume', matchingSessionId]);

  assert.equal(
    (await store.ensureStreamStarted({
      streamId: `conversation:${stale.conversationId}`,
      cols: 80,
      rows: 24,
    })).ok,
    true
  );
  assert.equal(spawned[1].args.includes('resume'), false);
  const row = store.getDb()
    .prepare('SELECT session_id FROM conversations WHERE id=?')
    .get(stale.conversationId);
  assert.equal(row.session_id, 'seen');
});

test('remote Claude and Codex conversations launch with concrete stored session ids', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-conversation-resume-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId } = insertRemoteWorkspace(store, root);
  const cases = [
    { agent: 'claude', sessionId: '11111111-2222-4333-8444-555555555555', token: '--resume' },
    { agent: 'codex', sessionId: '019e5262-9cb2-7770-bcfa-397791c6c4f2', token: 'resume' },
  ];

  for (const item of cases) {
    const thread = await store.createThread({
      workspaceId,
      input: { name: `${item.agent} remote`, agent: item.agent, prompt: null, kind: 'cli' },
    });
    store.writeSessionIdForStream(`conversation:${thread.conversationId}`, item.sessionId);
    assert.equal(
      (await store.ensureStreamStarted({
        streamId: `conversation:${thread.conversationId}`,
        cols: 80,
        rows: 24,
      })).ok,
      true
    );

    const start = daemon.starts.at(-1);
    if (item.agent === 'claude') {
      assert.equal(start.cmd, 'env');
      for (const name of claudeAuthPolicy.CLAUDE_SUBSCRIPTION_BLOCKED_ENV_VARS) {
        const index = start.args.indexOf(name);
        assert.ok(index > 0, `remote Claude unsets ${name}`);
        assert.equal(start.args[index - 1], '-u');
      }
      assert.notEqual(start.args.indexOf('claude'), -1);
    }
    const resumeAt = start.args.indexOf(item.token);
    assert.notEqual(resumeAt, -1, `${item.agent} uses concrete resume token`);
    assert.equal(start.args[resumeAt + 1], item.sessionId);
  }
});

test('remote Claude API billing banner stops the lane without a retry', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-claude-auth-guard-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId } = insertRemoteWorkspace(store, root);
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Claude subscription guard', agent: 'claude', prompt: null, kind: 'cli' },
  });
  const streamId = `conversation:${thread.conversationId}`;
  assert.equal((await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 })).ok, true);

  const start = daemon.starts.at(-1);
  assert.ok(
    daemon.execs.some((spec: any) => spec.args?.includes('auth') && spec.args?.includes('status')),
    'remote subscription auth is verified before PTY start'
  );
  daemon.emit('pty.data', {
    id: start.id,
    data: Buffer.from(
      ' ▐▛███▜▌   Claude Code v2.1.206\r\n▝▜█████▛▘  Fable 5 · API Usage Billing\r\n'
    ).toString('base64'),
  });
  assert.deepEqual(daemon.kills, [start.id]);

  daemon.emit('pty.exit', { id: start.id, code: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemon.starts.length, 1, 'an auth-blocked remote lane is never retried');
});

test('remote Claude refuses API-console auth before starting a PTY', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-claude-auth-preflight-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  daemon.claudeAuthStatus = {
    loggedIn: true,
    authMethod: 'console',
    apiProvider: 'firstParty',
  };
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId } = insertRemoteWorkspace(store, root);
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Claude subscription preflight', agent: 'claude', prompt: null, kind: 'cli' },
  });
  const result = await store.ensureStreamStarted({
    streamId: `conversation:${thread.conversationId}`,
    cols: 80,
    rows: 24,
  });

  assert.equal(result.ok, false);
  assert.equal(daemon.starts.length, 0, 'model PTY is never started with API-console auth');
});

test('remote Claude accepts first-party OAuth when the remote setup token is present', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-claude-setup-token-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  daemon.claudeSetupTokenPresent = true;
  daemon.claudeAuthStatus = {
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
  };
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId } = insertRemoteWorkspace(store, root);
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Claude setup-token OAuth', agent: 'claude', prompt: null, kind: 'cli' },
  });
  const result = await store.ensureStreamStarted({
    streamId: `conversation:${thread.conversationId}`,
    cols: 80,
    rows: 24,
  });

  assert.equal(result.ok, true);
  assert.equal(daemon.starts.length, 1);
  const tokenProbe = daemon.execs.find((spec: any) =>
    spec.args?.some((arg: any) => String(arg).includes('CLAUDE_CODE_OAUTH_TOKEN'))
  );
  assert.ok(tokenProbe, 'setup-token presence is checked without returning or logging its value');
});

test('remote variant startup falls back to the task conversation concrete session id', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-variant-resume-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId, remotePath } = insertRemoteWorkspace(store, root);
  const now = new Date().toISOString();
  const taskId = 'tsk-remote-resume';
  const worktreeId = 'wt-remote-resume';
  const variantId = 'var-remote-resume';
  const conversationId = 'conv-remote-resume';
  const sessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';
  const db = store.getDb();
  db.prepare(
    `INSERT INTO tasks (id, project_id, kind, name, primary_agent, is_multi_agent, initial_prompt, auto_approve, task_type, order_index, archived_at, created_at, updated_at)
     VALUES (?, ?, 'task', 'Remote task', 'codex', 1, NULL, 1, 'feature-impl', 0, NULL, ?, ?)`
  ).run(taskId, workspaceId, now, now);
  db.prepare(
    `INSERT INTO worktrees (id, task_id, project_id, display_name, branch, base_branch, remote_base_ref, base_sha, local_base_sha, local_ahead_by, local_behind_by, branch_point, path, created_at)
     VALUES (?, ?, ?, 'remote-task', 'ace/remote-task', 'main', 'origin/main', 'base-sha', 'base-sha', 0, 0, 'base-sha', ?, ?)`
  ).run(worktreeId, taskId, workspaceId, path.posix.join(remotePath, '.ace', 'worktrees', taskId), now);
  db.prepare(
    `INSERT INTO conversations (id, task_id, title, agent, kind, is_main, is_active, display_order, session_id, created_at, updated_at)
     VALUES (?, ?, 'Main', 'codex', 'cli', 1, 1, 0, ?, ?, ?)`
  ).run(conversationId, taskId, sessionId, now, now);
  db.prepare(
    `INSERT INTO variants (id, worktree_id, task_id, name, agent, branch, review_mode, review_prompt, attached_at, order_index)
     VALUES (?, ?, ?, 'codex', 'codex', 'ace/remote-task', 0, NULL, ?, 0)`
  ).run(variantId, worktreeId, taskId, now);

  assert.equal(
    (await store.ensureStreamStarted({ streamId: `variant:${variantId}`, cols: 100, rows: 30 })).ok,
    true
  );

  const start = daemon.starts.at(-1);
  const resumeAt = start.args.indexOf('resume');
  assert.notEqual(resumeAt, -1);
  assert.equal(start.args[resumeAt + 1], sessionId);
  assert.equal(db.prepare('SELECT session_id FROM variants WHERE id=?').get(variantId).session_id, sessionId);
});

test('remote Claude root auto-approve retry preserves resume before stale-session fresh fallback', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-remote-stale-resume-'));
  const userDataPath = path.join(root, 'user-data');
  const daemon = new FakeRemoteDaemon();
  const store = createAceStore(userDataPath, { sshDaemons: fakeRemoteManager(daemon) });
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { workspaceId } = insertRemoteWorkspace(store, root, 'prj-remote-root', { agentUser: null });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Claude stale remote', agent: 'claude', prompt: null, kind: 'cli', autoApproveEnabled: true },
  });
  const streamId = `conversation:${thread.conversationId}`;
  store.writeSessionIdForStream(streamId, sessionId);

  assert.equal((await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 })).ok, true);
  assert.notEqual(daemon.starts[0].args.indexOf('--resume'), -1);
  assert.notEqual(daemon.starts[0].args.indexOf('--permission-mode'), -1);

  daemon.emit('pty.exit', { id: daemon.starts[0].id, code: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemon.starts.length, 2);
  assert.notEqual(daemon.starts[1].args.indexOf('--resume'), -1);
  assert.equal(daemon.starts[1].args.includes('--permission-mode'), false);
  assert.equal(daemon.starts[1].args.includes('--dangerously-skip-permissions'), false);

  daemon.emit('pty.exit', { id: daemon.starts[1].id, code: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemon.starts.length, 3);
  assert.equal(
    daemon.execs.filter((spec: any) => spec.args?.includes('auth') && spec.args?.includes('status')).length,
    3,
    'every remote relaunch re-verifies subscription auth before starting Claude'
  );
  assert.equal(daemon.starts[2].args.includes('--resume'), false);
  assert.equal(
    store.getDb().prepare('SELECT session_id FROM conversations WHERE id=?').get(thread.conversationId).session_id,
    null
  );
});

test('mission board marks stale merged features done without auto-archiving tasks', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-board-hygiene-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const task = await store.createTask({
    workspaceId,
    input: {
      name: 'Merged board worker',
      agent: 'codex',
      prompt: 'implement',
      baseBranch: 'main',
      skipWorktreeFetch: true,
    },
  });
  const ctx = store.getTaskIntegrationContext(task.id);
  const created = store.missionCreate({
    workspaceId,
    name: 'Board hygiene mission',
    features: [{ id: 'ft_merged', name: 'Merged feature', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_merged',
    missionId: created.missionId,
    workspaceId,
    taskId: task.id,
    streamId: 'variant:worker',
    branch: ctx.branch,
    worktreePath: ctx.worktreePath,
    workerAgent: 'codex',
  });
  store.missionSyncFeature({
    featureId: 'ft_merged',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: 'DONE: shipped',
  });
  store.missionLinkPr({
    featureId: 'ft_merged',
    missionId: created.missionId,
    workspaceId,
    pr: '77',
    prUrl: 'https://github.com/acme/ace/pull/77',
    taskId: task.id,
    branch: ctx.branch,
    headRef: ctx.branch,
    baseRef: 'main',
    state: 'merged',
  });

  assert.equal(store.getTaskSpec({ taskId: task.id }).archivedAt, null);
  const board = store.missionBoard({ missionId: created.missionId });
  const card = board.missions[0].cards[0];
  const spec = store.getTaskSpec({ taskId: task.id });

  assert.equal(card.prStatus, 'merged');
  assert.equal(card.cardStage, 'done');
  assert.equal(board.totals.done, 1);
  assert.equal(card.status, 'completed');
  assert.equal(spec.archivedAt, null, 'merged task remains active until manual archive');
  assert.equal(spec.prUrl, null, 'task remains queryable without an open PR cache hit');
});

test('mission link-pr and fixback record capped same-worker failure state locally', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-fixback-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Fixback mission',
    feature: [],
    features: [{ id: 'ft_fix', name: 'Fix me', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_fix',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_worker',
    streamId: 'variant:worker',
    branch: 'feat/fix',
    worktreePath: path.join(root, 'wt'),
    workerAgent: 'codex',
  });
  const linked = store.missionLinkPr({
    featureId: 'ft_fix',
    missionId: created.missionId,
    workspaceId,
    pr: '17',
    prUrl: 'https://github.com/acme/ace/pull/17',
    headRef: 'feat/fix',
    baseRef: 'main',
    headSha: 'head17',
    baseSha: 'base17',
  });
  assert.equal(linked.status, 'linked');
  assert.equal(linked.pr.number, 17);

  const first = store.missionFixback({
    featureId: 'ft_fix',
    missionId: created.missionId,
    workspaceId,
    reasons: ['failed_pr_checks'],
    detail: 'lint failed',
    failingChecks: ['npm run lint'],
  });
  assert.equal(first.status, 'FIXBACK');
  assert.equal(first.fixback.attempts, 1);
  assert.deepEqual(first.target, {
    taskId: 'tsk_worker',
    streamId: 'variant:worker',
    branch: 'feat/fix',
    prNumber: 17,
    prUrl: 'https://github.com/acme/ace/pull/17',
    workerAgent: 'codex',
  });

  store.missionFixback({ featureId: 'ft_fix', missionId: created.missionId, workspaceId, reasons: ['failed_pr_checks'], detail: 'lint failed again' });
  const third = store.missionFixback({ featureId: 'ft_fix', missionId: created.missionId, workspaceId, reasons: ['failed_pr_checks'], detail: 'lint still failed' });
  assert.equal(third.status, 'BLOCKED');
  assert.equal(third.fixback.attempts, 3);
  assert.equal(third.fixback.exhausted, true);
  const fourth = store.missionFixback({ featureId: 'ft_fix', missionId: created.missionId, workspaceId, reasons: ['failed_pr_checks'], detail: 'lint remains failed' });
  assert.equal(fourth.status, 'BLOCKED');
  assert.equal(fourth.fixback.attempts, 3);
  assert.equal(fourth.fixback.remaining, 0);

  const board = store.missionBoard({ missionId: created.missionId });
  const card = board.missions[0].cards[0];
  assert.equal(card.fixbackAttempts, 3);
  assert.equal(card.validationStatus, 'validation_failed');
  assert.equal(card.gateStatus, 'blocked');
  assert.equal(card.validationFailurePacket.schema, 'ValidationFailurePacket/v1');
});

test('mission link-pr keeps unsynced worker PRs in progress and points next action to sync', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-link-sync-missing-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Unsynced PR mission',
    features: [{ id: 'ft_unsynced', name: 'Unsynced PR feature', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_unsynced',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_worker',
    streamId: 'variant:worker',
    branch: 'feat/unsynced',
    worktreePath: path.join(root, 'wt'),
    workerAgent: 'codex',
  });
  const linked = store.missionLinkPr({
    featureId: 'ft_unsynced',
    missionId: created.missionId,
    workspaceId,
    pr: '101',
    prUrl: 'https://github.com/acme/ace/pull/101',
    taskId: 'tsk_worker',
    branch: 'feat/unsynced',
    headRef: 'feat/unsynced',
    baseRef: 'main',
    state: 'open',
  });

  const board = store.missionBoard({ missionId: created.missionId });
  const card = board.missions[0].cards[0];
  const next = store.missionNextAction({
    featureId: 'ft_unsynced',
    missionId: created.missionId,
    workspaceId,
  });

  assert.equal(linked.blockerEvidence, 'worker completion not synced');
  assert.equal(card.cardStage, 'in_progress');
  assert.equal(card.blockerEvidence, 'worker completion not synced');
  assert.equal(next.next, 'sync_worker');
  assert.equal(next.reason, 'pr_linked_sync_missing');
});

test('mission board reads linked PR metadata passively unless refresh is explicit', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-board-passive-pr-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const oldPath = process.env.PATH;
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const fakeBin = path.join(root, 'bin');
  const ghMarker = path.join(root, 'gh-called');
  writeExecutable(
    path.join(fakeBin, 'gh'),
    `#!/bin/sh
printf 'called' > ${JSON.stringify(ghMarker)}
cat <<'JSON'
${JSON.stringify({
  number: 101,
  url: 'https://github.com/acme/ace/pull/101',
  state: 'OPEN',
  headRefName: 'feat/passive',
  baseRefName: 'main',
  headRefOid: 'live-head-sha',
  baseRefOid: 'live-base-sha',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  isDraft: false,
})}
JSON
`
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ''}`;

  const store = createAceStore(userDataPath);
  t.after(() => {
    if (oldPath == null) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Passive PR board mission',
    features: [{ id: 'ft_passive', name: 'Passive PR feature', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_passive',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_worker',
    streamId: 'variant:worker',
    branch: 'feat/passive',
    worktreePath: path.join(root, 'wt'),
    workerAgent: 'codex',
  });
  store.missionLinkPr({
    featureId: 'ft_passive',
    missionId: created.missionId,
    workspaceId,
    pr: '101',
    prUrl: 'https://github.com/acme/ace/pull/101',
    taskId: 'tsk_worker',
    branch: 'feat/passive',
    headRef: 'feat/passive',
    baseRef: 'main',
    state: 'open',
  });

  const passiveBoard = store.missionBoard({ missionId: created.missionId });
  assert.equal(passiveBoard.missions.length, 1);
  assert.equal(fs.existsSync(ghMarker), false, 'passive Mission Board read should not shell out to gh');

  const refreshedBoard = store.missionBoard({ missionId: created.missionId, refreshLinkedPrStates: true });
  assert.equal(refreshedBoard.missions.length, 1);
  assert.equal(fs.existsSync(ghMarker), true, 'explicit refresh should still shell out to gh');
});

test('mission sync and chat validator evidence repair missing mission linkage', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-linkage-repair-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Linkage repair mission',
    features: [{ id: 'ft_repair', name: 'Repair linkage' }],
  });
  const prUrl = 'https://github.com/example-org/example-project/pull/253';
  store.missionSyncFeature({
    featureId: 'ft_repair',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: 'DONE: repaired linkage',
    taskId: 'tsk_worker',
    streamId: 'variant:var_worker',
    branch: 'ace/repair-linkage',
    worktreePath: path.join(root, 'wt-worker'),
  });
  store.missionAttachValidatorEvidence({
    featureId: 'ft_repair',
    missionId: created.missionId,
    workspaceId,
    streamId: 'conversation:conv-validator',
    verdict: 'PASS',
    commentUrl: `${prUrl}#issuecomment-1`,
    currentHeadSha: 'repair-head-sha',
    validatedHeadSha: 'repair-head-sha',
  });

  const card = store.missionBoard({ missionId: created.missionId }).missions[0].cards[0];
  assert.equal(card.status, 'completed');
  assert.equal(card.taskId, 'tsk_worker');
  assert.equal(card.streamId, 'variant:var_worker');
  assert.equal(card.branch, 'ace/repair-linkage');
  assert.equal(card.prUrl, prUrl);
  assert.equal(card.prNumber, 253);
  assert.equal(card.prHeadSha, 'repair-head-sha');
  assert.equal(card.validatorStreamId, 'conversation:conv-validator');
  assert.equal(card.validationStatus, 'validation_passed');
  assert.equal(card.gateStatus, 'merge_ready');
});

test('missionAttachWave keeps the full cohort when one lane synced before attach', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-attach-race-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Wave attach race mission',
    workerAgent: 'claude',
    activeControllerIdentity: 'rook',
    features: [
      { id: 'ft_lane_a', name: 'Lane A', allowPaths: ['README.md'] },
      { id: 'ft_lane_b', name: 'Lane B', allowPaths: ['README.md'] },
    ],
  });
  const boardBefore = store.missionBoard({ missionId: created.missionId });
  const milestoneId = boardBefore.missions[0].cards[0].milestoneId;

  store.missionSyncFeature({
    featureId: 'ft_lane_a',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: 'DONE: lane A auto-synced before wave attach',
  });

  const attached = store.missionAttachWave({
    missionId: created.missionId,
    milestoneId,
    controllerIdentity: 'rook',
    lanes: [
      {
        featureId: 'ft_lane_a',
        laneId: 'ft_lane_a',
        taskId: 'tsk_a',
        streamId: 'variant:a',
        worktreeId: 'wt_a',
        worktreePath: path.join(root, 'wt-a'),
        branch: 'mission/a',
        workerAgent: 'claude',
      },
      {
        featureId: 'ft_lane_b',
        laneId: 'ft_lane_b',
        taskId: 'tsk_b',
        streamId: 'variant:b',
        worktreeId: 'wt_b',
        worktreePath: path.join(root, 'wt-b'),
        branch: 'mission/b',
        workerAgent: 'claude',
      },
    ],
  });

  assert.equal(attached.lanes.length, 2);
  assert.deepEqual(attached.lanes.map((lane: any) => lane.featureId), ['ft_lane_a', 'ft_lane_b']);
  assert.deepEqual(attached.manifest.lanes.map((lane: any) => lane.featureId), ['ft_lane_a', 'ft_lane_b']);
  assert.equal(attached.manifest.joinPolicy, 'all_lanes_terminal');

  const boardAfter = store.missionBoard({ missionId: created.missionId });
  const laneA = boardAfter.missions[0].cards.find((card: any) => card.id === 'ft_lane_a');
  const laneB = boardAfter.missions[0].cards.find((card: any) => card.id === 'ft_lane_b');
  assert.equal(laneA.taskId, 'tsk_a');
  assert.equal(laneA.streamId, 'variant:a');
  assert.equal(laneA.status, 'completed');
  assert.equal(laneA.validationStatus, 'validation_needed');
  assert.equal(laneB.taskId, 'tsk_b');
  assert.equal(laneB.streamId, 'variant:b');
  assert.equal(laneB.status, 'in_progress');

  const waveEvent = store.getDb()
    .prepare(`SELECT message FROM mission_events WHERE mission_id=? AND type=? ORDER BY position DESC LIMIT 1`)
    .get(created.missionId, 'wave_dispatched');
  assert.match(waveEvent.message, /Wave dispatched: .* \(2 lanes\)/);
  assert.match(waveEvent.message, /ft_lane_a/);
  assert.match(waveEvent.message, /ft_lane_b/);
});

test('missionArchive archives only old completed cards and preserves events', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-archive-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Archive mission',
    features: [
      { id: 'ft_old', name: 'Old done', allowPaths: ['README.md'] },
      { id: 'ft_new', name: 'New done', allowPaths: ['README.md'] },
      { id: 'ft_active', name: 'Still active', allowPaths: ['README.md'] },
      { id: 'ft_blocked', name: 'Blocked card', allowPaths: ['README.md'] },
    ],
  });
  for (const featureId of ['ft_old', 'ft_new']) {
    store.missionAttachDispatch({
      featureId,
      missionId: created.missionId,
      workspaceId,
      taskId: `tsk_${featureId}`,
      streamId: `variant:${featureId}`,
    });
    store.missionSyncFeature({
      featureId,
      missionId: created.missionId,
      workspaceId,
      outcome: 'done',
      detail: 'DONE: complete',
    });
  }
  store.missionAttachDispatch({
    featureId: 'ft_active',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_active',
    streamId: 'variant:active',
  });
  store.missionAttachDispatch({
    featureId: 'ft_blocked',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_blocked',
    streamId: 'variant:blocked',
  });
  store.missionSyncFeature({
    featureId: 'ft_blocked',
    missionId: created.missionId,
    workspaceId,
    outcome: 'blocked',
    detail: 'BLOCKED: waiting on external credential',
  });
  store.getDb().prepare(`UPDATE mission_features SET completed_at=? WHERE id=?`).run('2026-05-01T00:00:00.000Z', 'ft_old');
  store.getDb().prepare(`UPDATE mission_features SET completed_at=? WHERE id=?`).run('2026-05-09T00:00:00.000Z', 'ft_new');

  const preview = store.missionArchive({
    workspaceId,
    olderThanDays: 3,
    dryRun: true,
    now: '2026-05-10T12:00:00.000Z',
  });
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.archivedCount, 0);
  assert.equal(preview.archived[0].featureId, 'ft_old');

  const archived = store.missionArchive({
    workspaceId,
    olderThanDays: 3,
    now: '2026-05-10T12:00:00.000Z',
  });
  assert.equal(archived.archivedCount, 1);

  const board = store.missionBoard({ workspaceId });
  assert.equal(board.totals.active, 3);
  assert.equal(board.totals.archived, 1);
  assert.deepEqual(board.missions[0].cards.map((card: any) => card.id), ['ft_new', 'ft_active', 'ft_blocked']);

  const withArchived = store.missionBoard({ workspaceId, includeArchived: true });
  assert.equal(withArchived.totals.cards, 4);
  assert.equal(withArchived.missions[0].cards.find((card: any) => card.id === 'ft_old').archived, true);
  const event = store.getDb()
    .prepare(`SELECT * FROM mission_events WHERE feature_id=? AND type=?`)
    .get('ft_old', 'feature_archived');
  assert.ok(event);
});

test('missionArchive canonicalizes merged PR cards with missing completion fields', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-archive-merged-null-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Archive merged-null mission',
    features: [{ id: 'ft_merged_null', name: 'Merged but unstamped', allowPaths: ['README.md'] }],
  });
  store.getDb()
    .prepare(
      `UPDATE mission_features
       SET pr_url=?,
           pr_number=?,
           last_seen_state='pr_merged',
           status='pending',
           completed_at=NULL
       WHERE id=?`
    )
    .run('https://github.com/acme/ace/pull/300', 300, 'ft_merged_null');

  const archived = store.missionArchive({
    workspaceId,
    missionId: created.missionId,
    olderThanDays: 0,
    now: '2026-05-10T12:00:00.000Z',
  });
  assert.equal(archived.archivedCount, 1);
  assert.equal(archived.archived[0].featureId, 'ft_merged_null');

  const row = store.getDb()
    .prepare(`SELECT status, completed_at, archived_at, last_seen_state FROM mission_features WHERE id=?`)
    .get('ft_merged_null');
  assert.equal(row.status, 'completed');
  assert.equal(row.completed_at, '2026-05-10T12:00:00.000Z');
  assert.equal(row.archived_at, '2026-05-10T12:00:00.000Z');
  assert.equal(row.last_seen_state, 'archived');

  const board = store.missionBoard({ workspaceId });
  assert.equal(board.totals.active, 0);
  assert.equal(board.totals.archived, 1);
});

test('missionBoard archives superseded duplicate mission cards', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-supersede-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const stale = store.missionCreate({
    workspaceId,
    name: 'Stale duplicate',
    features: [{ id: 'ft_stale', name: 'Board hygiene invariants' }],
  });
  const fresh = store.missionCreate({
    workspaceId,
    name: 'Canonical compact',
    features: [{ id: 'ft-6d6c72c2', name: 'Board hygiene invariants' }],
  });
  const prUrl = 'https://github.com/acme/ace/pull/456';
  store.getDb().prepare(`UPDATE missions SET created_at=? WHERE id=?`).run('2026-05-01T00:00:00.000Z', stale.missionId);
  store.getDb().prepare(`UPDATE missions SET created_at=? WHERE id=?`).run('2026-05-19T00:00:00.000Z', fresh.missionId);
  store.getDb().prepare(
    `UPDATE mission_features
        SET task_id='tsk_board_hygiene',
            branch='mission-msn-456c9f09-board-hygie-feat',
            pr_url=?,
            status=CASE WHEN id='ft_stale' THEN 'completed' ELSE 'pending' END,
            completed_at=CASE WHEN id='ft_stale' THEN '2026-05-18T00:00:00.000Z' ELSE NULL END`
  ).run(prUrl);

  const board = store.missionBoard({ workspaceId });
  assert.deepEqual(board.missions.flatMap((mission: any) => mission.cards).map((card: any) => card.id), ['ft-6d6c72c2']);

  const archivedAt = store.getDb()
    .prepare(`SELECT archived_at FROM mission_features WHERE id=?`)
    .get('ft_stale').archived_at;
  assert.ok(archivedAt);
  const event = store.getDb()
    .prepare(`SELECT * FROM mission_events WHERE feature_id=? AND type=?`)
    .get('ft_stale', 'feature_archived');
  assert.ok(event);
});

test('integration pr-merge carries explicit allow paths into direct task gate', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-direct-pr-merge-scope-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  const oldPath = process.env.PATH;
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');

  const store = createAceStore(userDataPath);
  t.after(() => {
    if (oldPath == null) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const task = await store.createTask({
    workspaceId,
    input: {
      name: 'Direct scoped merge worker',
      agent: 'codex',
      prompt: 'implement',
      baseBranch: 'main',
      skipWorktreeFetch: true,
    },
  });
  const ctx = store.getTaskIntegrationContext(task.id);
  const fakeBin = path.join(root, 'bin');
  const mergeMarker = path.join(root, 'merge-called');
  writeExecutable(
    path.join(fakeBin, 'gh'),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  printf 'merge called' > ${JSON.stringify(mergeMarker)}
  exit 0
fi
if [ "$1" != "pr" ] || [ "$2" != "view" ]; then
  echo "unexpected gh call: $*" >&2
  exit 2
fi
cat <<'JSON'
${JSON.stringify({
  number: 47,
  url: 'https://github.com/acme/ace/pull/47',
  state: 'OPEN',
  title: 'direct scoped PR',
  headRefName: ctx.branch,
  baseRefName: 'main',
  headRefOid: 'live-head-sha',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  files: [{ path: 'src/app.ts' }],
  isDraft: false,
})}
JSON
`
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ''}`;

  const merge = await store.integrationMergePr({
    taskId: task.id,
    prNumber: 47,
    allowedPaths: ['src/**'],
  });

  assert.notEqual(merge.result?.error, 'merge gate blocked');
  assert.equal(fs.existsSync(mergeMarker), true, 'explicit allow-path must pass the re-gate before gh pr merge');
});

test('integration gate and merge block stale mission-linked PR SHA evidence from prior validation', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mission-stale-gate-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  const oldPath = process.env.PATH;
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    if (oldPath == null) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const task = await store.createTask({
    workspaceId,
    input: {
      name: 'Stale gate worker',
      agent: 'codex',
      prompt: 'implement',
      baseBranch: 'main',
      skipWorktreeFetch: true,
    },
  });
  const ctx = store.getTaskIntegrationContext(task.id);
  assert.ok(ctx?.branch, 'task branch should exist');
  assert.ok(ctx?.worktreePath, 'task worktree should exist');
  assert.equal(ctx.cwd, ctx.worktreePath, 'interactive task cwd remains the worktree');
  assert.equal(ctx.repoCwd, repoPath, 'integration cleanup has a stable repo cwd after worktree removal');

  const fakeBin = path.join(root, 'bin');
  const mergeMarker = path.join(root, 'merge-called');
  const prUrl = 'https://github.com/acme/ace/pull/45';
  writeExecutable(
    path.join(fakeBin, 'gh'),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  printf 'merge called' > ${JSON.stringify(mergeMarker)}
  exit 0
fi
if [ "$1" != "pr" ] || [ "$2" != "view" ]; then
  echo "unexpected gh call: $*" >&2
  exit 2
fi
cat <<'JSON'
${JSON.stringify({
  number: 45,
  url: prUrl,
  state: 'OPEN',
  title: 'green but stale',
  headRefName: ctx.branch,
  baseRefName: 'main',
  headRefOid: 'live-head-sha',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  isDraft: false,
})}
JSON
`
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ''}`;

  const created = store.missionCreate({
    workspaceId,
    name: 'Stale gate mission',
    features: [{ id: 'ft_stale', name: 'Stale evidence feature', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_stale',
    missionId: created.missionId,
    workspaceId,
    taskId: task.id,
    streamId: 'variant:worker',
    branch: ctx.branch,
    worktreePath: ctx.worktreePath,
    workerAgent: 'codex',
  });
  store.missionSyncFeature({
    featureId: 'ft_stale',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: `DONE: shipped old validation ${prUrl}`,
  });
  store.missionLinkPr({
    featureId: 'ft_stale',
    missionId: created.missionId,
    workspaceId,
    pr: '45',
    prUrl,
    taskId: task.id,
    branch: ctx.branch,
    headRef: ctx.branch,
    baseRef: 'main',
    headSha: 'old-head-sha',
    baseSha: 'old-base-sha',
  });
  store.missionAttachValidation({
    featureId: 'ft_stale',
    missionId: created.missionId,
    workspaceId,
    taskId: 'tsk_validator',
    streamId: 'variant:validator',
    branch: 'validate/stale',
    validatorAgent: 'codex',
  });
  store.missionGateFeature({
    featureId: 'ft_stale',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: 'validated old linked PR evidence',
  });

  const gate = await store.integrationGate({ taskId: task.id, prNumber: 45 });
  assert.equal(gate.ok, true);
  assert.equal(gate.phase, 'blocked');
  assert.equal(gate.result.status, 'BLOCKED');
  assert.deepEqual(
    gate.result.reasons.map((reason: any) => reason.code),
    ['linked_pr_head_sha_mismatch', 'linked_pr_base_sha_mismatch', 'base_sha_mismatch']
  );
  assert.equal(gate.result.pr.checkState, 'success');
  assert.equal(gate.result.pr.mergeable, 'MERGEABLE');
  assert.equal(gate.result.feature.prHeadSha, 'old-head-sha');
  assert.equal(gate.result.feature.prBaseSha, 'old-base-sha');
  assert.equal(gate.result.gate.expectedPr.headSha, 'old-head-sha');
  assert.equal(gate.result.gate.expectedPr.baseSha, 'old-base-sha');
  assert.equal(gate.result.gate.actualPr.headSha, 'live-head-sha');

  const merge = await store.integrationMergePr({ taskId: task.id, prNumber: 45 });
  assert.equal(merge.ok, false);
  assert.equal(merge.phase, 'failure');
  assert.equal(merge.result.error, 'merge gate blocked');
  assert.deepEqual(
    merge.result.failures.map((reason: any) => reason.code),
    ['linked_pr_head_sha_mismatch', 'linked_pr_base_sha_mismatch', 'base_sha_mismatch']
  );
  assert.equal(merge.result.gate.actualPr.headSha, 'live-head-sha');
  assert.equal(fs.existsSync(mergeMarker), false, 'stale mission evidence must block before gh pr merge');
});

test('chat validator evidence controls mission validation gate for integration', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-chat-validator-gate-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');
  const oldPath = process.env.PATH;
  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  const store = createAceStore(userDataPath);
  t.after(() => {
    if (oldPath == null) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const task = await store.createTask({
    workspaceId,
    input: {
      name: 'Chat validator worker',
      agent: 'codex',
      prompt: 'implement',
      baseBranch: 'main',
      skipWorktreeFetch: true,
    },
  });
  const ctx = store.getTaskIntegrationContext(task.id);
  const prUrl = 'https://github.com/acme/ace/pull/46';
  const fakeBin = path.join(root, 'bin');
  writeExecutable(
    path.join(fakeBin, 'gh'),
    `#!/bin/sh
if [ "$1" != "pr" ] || [ "$2" != "view" ]; then
  echo "unexpected gh call: $*" >&2
  exit 2
fi
cat <<'JSON'
${JSON.stringify({
  number: 46,
  url: prUrl,
  state: 'OPEN',
  title: 'green chat validated',
  headRefName: ctx.branch,
  baseRefName: 'main',
  headRefOid: 'live-head-sha',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  isDraft: false,
})}
JSON
`
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ''}`;

  const created = store.missionCreate({
    workspaceId,
    name: 'Chat validator gate mission',
    features: [{ id: 'ft_chat', name: 'Chat validated feature', allowPaths: ['README.md'] }],
  });
  store.missionAttachDispatch({
    featureId: 'ft_chat',
    missionId: created.missionId,
    workspaceId,
    taskId: task.id,
    streamId: 'variant:worker',
    branch: ctx.branch,
    worktreePath: ctx.worktreePath,
    workerAgent: 'codex',
  });
  store.missionSyncFeature({
    featureId: 'ft_chat',
    missionId: created.missionId,
    workspaceId,
    outcome: 'done',
    detail: `DONE: shipped ${prUrl}`,
  });
  store.missionLinkPr({
    featureId: 'ft_chat',
    missionId: created.missionId,
    workspaceId,
    pr: '46',
    prUrl,
    taskId: task.id,
    branch: ctx.branch,
    headRef: ctx.branch,
    baseRef: 'main',
    headSha: 'live-head-sha',
  });

  const before = await store.integrationGate({ taskId: task.id, prNumber: 46 });
  assert.equal(before.result.status, 'BLOCKED');
  assert.deepEqual(before.result.reasons.map((reason: any) => reason.code), ['validation_required']);

  const failed = store.missionAttachValidatorEvidence({
    featureId: 'ft_chat',
    missionId: created.missionId,
    workspaceId,
    streamId: 'conversation:conv-review',
    verdict: 'FAIL',
    commentUrl: '#issuecomment-1',
    detail: 'chat validator requested changes',
  });
  assert.equal(failed.validationStatus, 'validation_failed');
  const afterFail = await store.integrationGate({ taskId: task.id, prNumber: 46 });
  assert.equal(afterFail.result.status, 'BLOCKED');
  assert.deepEqual(afterFail.result.reasons.map((reason: any) => reason.code), ['validation_failed']);

  const passed = store.missionAttachValidatorEvidence({
    featureId: 'ft_chat',
    missionId: created.missionId,
    workspaceId,
    streamId: 'conversation:conv-review',
    verdict: 'PASS',
    commentUrl: '#issuecomment-2',
    validatedHeadSha: 'live-head-sha',
  });
  assert.equal(passed.validationStatus, 'validation_passed');
  assert.equal(passed.gateStatus, 'merge_ready');
  const afterPass = await store.integrationGate({ taskId: task.id, prNumber: 46 });
  assert.equal(afterPass.result.status, 'PASS');
  assert.deepEqual(afterPass.result.reasons, []);
  assert.equal(afterPass.result.validation.self, 'PASS');
  assert.equal(afterPass.result.validation.headSha, 'live-head-sha');
});

test('createAlwaysOnOrchestratorWatchdog: tickOnce reuses the injected rehydration loop', async () => {
  const calls: any[] = [];
  const watchdog = createAlwaysOnOrchestratorWatchdog({
    rehydrate: async () => {
      calls.push('tick');
      return { started: 2 };
    },
    pollIntervalMs: 10_000,
    logger: { warn() {} },
  });

  const snapshot = await watchdog.tickOnce();
  assert.deepEqual(calls, ['tick']);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.result, { started: 2 });
  assert.equal(watchdog.snapshot(), snapshot);
});

test('createAlwaysOnOrchestratorWatchdog: failed rehydration is captured, not thrown', async () => {
  const warnings: any[] = [];
  const watchdog = createAlwaysOnOrchestratorWatchdog({
    rehydrate: async () => {
      throw new Error('boom');
    },
    pollIntervalMs: 10_000,
    logger: { warn: (...args: any[]) => warnings.push(args) },
  });

  const snapshot = await watchdog.tickOnce();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, 'boom');
  assert.equal(warnings.length, 1);
});

test('createPtyRegistry: stale exit/data from a killed stream cannot close the replacement stream', async () => {
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const listeners: any = { data: [], exit: [] };
      const proc = {
        bin,
        args,
        opts,
        killed: false,
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write() {},
        resize() {},
        kill() { proc.killed = true; },
        emitData(chunk: string) { for (const cb of listeners.data) cb(chunk); },
        emitExit(exitCode: number) { for (const cb of listeners.exit) cb({ exitCode }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const emitter = new EventEmitter();
  const events: any[] = [];
  emitter.on('pty:data', (e: any) => events.push(['data', e.chunk]));
  emitter.on('pty:exit', (e: any) => events.push(['exit', e.code]));
  const streamStates = {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  };

  const registry = createPtyRegistry(emitter, streamStates, {}, { ptyImpl: fakePty });
  const first = await registry.ensureStream({
    streamId: 'conversation:king',
    agent: 'shell',
    cwd: '/tmp',
    ownerKind: 'shell',
    ownerId: 'king',
    cols: 80,
    rows: 24,
  });
  registry.killStream('conversation:king');
  const second = await registry.ensureStream({
    streamId: 'conversation:king',
    agent: 'shell',
    cwd: '/tmp',
    ownerKind: 'shell',
    ownerId: 'king',
    cols: 80,
    rows: 24,
  });

  assert.notEqual(first, second);
  spawned[0].emitData('stale old bytes');
  spawned[0].emitExit(1);

  assert.equal(registry.getStream('conversation:king'), second);
  assert.equal(second.status, 'running');
  assert.deepEqual(events, []);
});

test('createPtyRegistry: a throwing data/exit handler never propagates into node-pty', async () => {
  // Regression: a throw inside the onData/onExit handler (e.g. a transient
  // "database connection is not open" while recording PTY output) used to
  // escape into node-pty's threadsafe callback and abort the whole app
  // (SIGABRT). The handlers must swallow such errors and keep the app alive.
  const spawned: any[] = [];
  const fakePty = {
    spawn() {
      const listeners: any = { data: [], exit: [] };
      const proc: any = {
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write() {},
        resize() {},
        kill() {},
        emitData(chunk: string) { for (const cb of listeners.data) cb(chunk); },
        emitExit(exitCode: number) { for (const cb of listeners.exit) cb({ exitCode }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const emitter = new EventEmitter();
  // Simulate the closed-DB failure: writeData throws, exactly like better-sqlite3.
  const streamStates = {
    ensureState() {},
    writeData() { throw new Error('The database connection is not open'); },
    resize() {},
    remove() { throw new Error('The database connection is not open'); },
    sync() { return { text: '' }; },
  };
  const registry = createPtyRegistry(emitter, streamStates, {}, { ptyImpl: fakePty });
  await registry.ensureStream({
    streamId: 'conversation:guard',
    agent: 'shell',
    cwd: '/tmp',
    ownerKind: 'shell',
    ownerId: 'guard',
    cols: 80,
    rows: 24,
  });
  const proc = spawned[0];

  // Without the try/catch guards these would throw out of the node-pty callback.
  assert.doesNotThrow(() => proc.emitData('some bytes'));
  assert.doesNotThrow(() => proc.emitExit(0));
});

test('createPtyRegistry: Claude API billing banner stops the lane and blocks inherited API auth', async () => {
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const listeners: any = { data: [], exit: [] };
      const proc: any = {
        bin,
        args,
        opts,
        killed: false,
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write() {},
        resize() {},
        kill() { proc.killed = true; },
        emitData(chunk: string) { for (const cb of listeners.data) cb(chunk); },
        emitExit(exitCode: number) { for (const cb of listeners.exit) cb({ exitCode }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const emitted: string[] = [];
  const emitter = new EventEmitter();
  emitter.on('pty:data', ({ chunk }: any) => emitted.push(chunk));
  const streamStates = {
    ensureState() {},
    pump(_id: any, data: string, emit: any) { emit({ seq: emitted.length + 1, rewritten: data }); },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  };
  const registry = createPtyRegistry(emitter, streamStates, {}, {
    ptyImpl: fakePty,
    verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'oauth_token' }),
  });
  const stream = await registry.ensureStream({
    streamId: 'conversation:subscription-only',
    agent: 'claude',
    cwd: os.tmpdir(),
    ownerKind: 'conversation',
    ownerId: 'subscription-only',
    cols: 80,
    rows: 24,
    extraEnv: {
      ANTHROPIC_API_KEY: 'must-not-reach-claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-oauth',
    },
  });
  const proc = spawned[0];

  assert.equal(proc.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(proc.opts.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(proc.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-oauth');

  proc.emitData('Total duration (API): 0s\r\nThe prompt discusses API Usage Billing.\r\n');
  assert.equal(proc.killed, false, 'generic API text does not stop a subscription lane');
  proc.emitData(' ▐▛███▜▌   Claude Code v2.1.206\r\n▝▜█████▛▘  Fable 5 · AP');
  proc.emitData('I Usage\x1b[0m Billing\r\n  ▘▘ ▝▝    /tmp/project\r\n');
  assert.equal(proc.killed, true);
  assert.equal(stream.claudeApiBillingBlocked, true);
  assert.ok(emitted.some((chunk) => chunk.includes('Stopped this Claude lane')));

  proc.emitExit(1);
  assert.equal(stream.status, 'exited');
  assert.equal(spawned.length, 1, 'blocked API billing is not auto-relaunched');
});

test('createPtyRegistry: Claude refuses non-subscription auth before node-pty spawn', async () => {
  let spawnCalls = 0;
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    pump() {},
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, {
    ptyImpl: { spawn() { spawnCalls += 1; } },
    verifyClaudeSubscriptionAuth: async () => ({
      ok: false,
      reason: 'non-subscription-auth',
      authMethod: 'console',
    }),
  });

  const stream = await registry.ensureStream({
    streamId: 'conversation:api-console',
    agent: 'claude',
    cwd: os.tmpdir(),
    ownerKind: 'conversation',
    ownerId: 'api-console',
    cols: 80,
    rows: 24,
  });

  assert.equal(stream.status, 'exited');
  assert.match(stream.error, /subscription authentication required \(console\)/);
  assert.equal(spawnCalls, 0);
});

// `/login` runs inside the lane's own PTY, so refusing to spawn a signed-out
// lane left first-run users with no route to authenticate at all.
test('createPtyRegistry: Claude spawns a signed-out lane so /login can run', async () => {
  let spawnCalls = 0;
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    pump() {},
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, {
    ptyImpl: {
      spawn() {
        spawnCalls += 1;
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 4242 };
      },
    },
    verifyClaudeSubscriptionAuth: async () => ({
      ok: false,
      reason: 'logged-out',
      authMethod: 'none',
    }),
  });

  const stream = await registry.ensureStream({
    streamId: 'conversation:signed-out',
    agent: 'claude',
    cwd: os.tmpdir(),
    ownerKind: 'conversation',
    ownerId: 'signed-out',
    cols: 80,
    rows: 24,
  });

  assert.notEqual(stream.status, 'exited');
  assert.equal(stream.error, undefined);
  assert.equal(spawnCalls, 1);
});

test('createPtyRegistry: Claude auth preflight yields before PTY spawn', async () => {
  let resolveAuth: any;
  const auth = new Promise((resolve) => { resolveAuth = resolve; });
  let spawnCalls = 0;
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    pump() {},
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, {
    ptyImpl: {
      spawn() {
        spawnCalls += 1;
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      },
    },
    verifyClaudeSubscriptionAuth: () => auth,
  });

  const started = registry.ensureStream({
    streamId: 'conversation:async-auth',
    agent: 'claude',
    cwd: os.tmpdir(),
    ownerKind: 'conversation',
    ownerId: 'async-auth',
    cols: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls, 0, 'slow auth does not block the event loop or start Claude');

  resolveAuth({ ok: true, authMethod: 'claude.ai' });
  const stream = await started;
  assert.equal(stream.status, 'running');
  assert.equal(spawnCalls, 1);
});

test('resumed local Claude API billing exit is handled without clearing or relaunching', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-local-claude-billing-resume-'));
  const home = path.join(root, 'home');
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const listeners: any = { data: [], exit: [] };
      const proc: any = {
        bin,
        args,
        opts,
        killed: false,
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write() {},
        resize() {},
        kill() { proc.killed = true; },
        emitData(chunk: string) { for (const cb of listeners.data) cb(chunk); },
        emitExit(exitCode: number) { for (const cb of listeners.exit) cb({ exitCode }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, {
    ptyImpl: fakePty,
    verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
  });
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Claude guarded resume', agent: 'claude', prompt: null, kind: 'cli' },
  });
  const streamId = `conversation:${thread.conversationId}`;
  const sessionId = '22222222-3333-4444-8555-666666666666';
  const encodedCwd = repoPath.replace(/[^A-Za-z0-9_-]/g, '-');
  writeFile(path.join(home, '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`), '{}\n');
  store.writeSessionIdForStream(streamId, sessionId);

  assert.equal((await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 })).ok, true);
  assert.ok(spawned[0].args.includes('--resume'), 'fixture is retry-eligible resume mode');
  spawned[0].emitData(
    ' ▐▛███▜▌   Claude Code v2.1.206\r\n▝▜█████▛▘  Fable 5 with xhigh effort · Claude API\r\n'
  );
  assert.equal(spawned[0].killed, true);
  spawned[0].emitExit(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawned.length, 1, 'guarded exit never launches the stale-session fallback');
  assert.equal(
    store.getDb().prepare('SELECT session_id FROM conversations WHERE id=?').get(thread.conversationId).session_id,
    sessionId,
    'guarded exit preserves the resumable session id'
  );
});

test('createPtyRegistry: missing local cwd fails before calling node-pty', async () => {
  let spawnCalls = 0;
  const fakePty = {
    spawn() {
      spawnCalls += 1;
      throw new Error('should not spawn');
    },
  };
  const events: any[] = [];
  const emitter = new EventEmitter();
  emitter.on('pty:data', (e: any) => events.push(['data', e.chunk]));
  emitter.on('pty:exit', (e: any) => events.push(['exit', e.code]));
  const registry = createPtyRegistry(emitter, {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, { ptyImpl: fakePty });

  const missingCwd = path.join(os.tmpdir(), `ace-missing-cwd-${Date.now()}`);
  fs.rmSync(missingCwd, { recursive: true, force: true });
  const stream = await registry.ensureStream({
    streamId: 'conversation:missing-cwd',
    agent: 'shell',
    cwd: missingCwd,
    ownerKind: 'shell',
    ownerId: 'missing-cwd',
    cols: 80,
    rows: 24,
  });

  assert.equal(stream.status, 'exited');
  assert.match(stream.error, /working directory missing/);
  assert.equal(spawnCalls, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(events[0][1], /working directory missing/);
  assert.deepEqual(events[1], ['exit', -1]);
});

test('Codex default worker env uses a sanitized Ace CODEX_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-home-test-'));
  const sourceHome = path.join(root, 'source');
  const targetHome = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"redacted":true}\n');
  fs.writeFileSync(path.join(sourceHome, 'installation_id'), 'install-1\n');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), [
    'model = "gpt-5.5"',
    'notify = ["/bad/computer-use"]',
    '[mcp_servers.chrome-devtools]',
    'command = "npx"',
    '[plugins."computer-use@openai-bundled"]',
    'enabled = true',
  ].join('\n'));

  try {
    // A DELEGATED worker lane (full orchestrator launchIntent carrying
    // `provider`, enableMcp:false) gets the sanitized Ace CODEX_HOME.
    const workerIntent = buildLaunchIntent('codex', {});
    const env = codexDefaultWorkerEnv('codex', { launchIntent: workerIntent }, { CODEX_HOME: sourceHome, ACE_CODEX_HOME: targetHome });
    assert.equal(env.CODEX_HOME, targetHome);
    assert.equal(fs.readFileSync(path.join(targetHome, 'auth.json'), 'utf8'), '{"redacted":true}\n');
    const config = fs.readFileSync(path.join(targetHome, 'config.toml'), 'utf8');
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /mcp_servers = \{\}/);
    assert.match(config, /plugins = false/);
    assert.doesNotMatch(config, /\[mcp_servers\.|plugins\."computer-use|notify =/);
    assert.ok(fs.lstatSync(path.join(targetHome, 'sessions')).isSymbolicLink());
    // Explicit MCP opt-in returns the real home (no sanitized swap).
    assert.deepEqual(
      codexDefaultWorkerEnv('codex', { launchIntent: { enableMcp: true } }, { CODEX_HOME: sourceHome, ACE_CODEX_HOME: targetHome }),
      {}
    );
    // Interactive lane (no launchIntent) also inherits the real ~/.codex.
    assert.deepEqual(
      codexDefaultWorkerEnv('codex', {}, { CODEX_HOME: sourceHome, ACE_CODEX_HOME: targetHome }),
      {}
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createPtyRegistry: closes new descriptors when node-pty spawn throws', async () => {
  const fakePty = {
    spawn() {
      throw new Error('posix_spawnp failed.');
    },
  };
  const fdSnapshots = [new Set([10, 11]), new Set([10, 11, 12, 13])];
  const closed: number[] = [];
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, {
    ptyImpl: fakePty,
    listOpenFds: () => fdSnapshots.shift() || new Set([10, 11]),
    closeFd: (fd: number) => closed.push(fd),
  });

  const stream = await registry.ensureStream({
    streamId: 'conversation:spawn-failure',
    agent: 'shell',
    cwd: os.tmpdir(),
    ownerKind: 'shell',
    ownerId: 'spawn-failure',
    cols: 80,
    rows: 24,
  });

  assert.equal(stream.status, 'exited');
  assert.match(stream.error, /posix_spawnp failed/);
  assert.deepEqual(closed, [12, 13]);
});

test('createPtyRegistry: smart-agent PTYs clear inherited NO_COLOR and force truecolor', async () => {
  const previous = process.env.HERMES_CHAT_BOTTOM_PIN;
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.HERMES_CHAT_BOTTOM_PIN;
  process.env.NO_COLOR = '1';
  try {
    const spawned: any[] = [];
    const fakePty = {
      spawn(bin: any, args: any, opts: any) {
        const proc = {
          bin,
          args,
          opts,
          onData() {},
          onExit() {},
          write() {},
          resize() {},
          kill() {},
        };
        spawned.push(proc);
        return proc;
      },
    };
    const registry = createPtyRegistry(new EventEmitter(), {
      ensureState() {},
      writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
      resize() {},
      remove() {},
      sync() { return { text: '' }; },
    }, {}, { ptyImpl: fakePty });

    await registry.ensureStream({
      streamId: 'conversation:rook',
      agent: 'hermes',
      cwd: '/tmp',
      ownerKind: 'shell',
      ownerId: 'rook',
      cols: 80,
      rows: 24,
      extraEnv: { ACE_AGENT: 'hermes' },
    });
    await registry.ensureStream({
      streamId: 'conversation:codex',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'shell',
      ownerId: 'codex',
      cols: 80,
      rows: 24,
      extraEnv: { ACE_AGENT: 'codex' },
    });

    assert.equal(spawned[0].opts.env.HERMES_CHAT_BOTTOM_PIN, '0');
    assert.equal(spawned[0].opts.env.HERMES_TERMINAL_THEME, 'dark');
    assert.equal(spawned[0].opts.env.COLORTERM, 'truecolor');
    assert.equal(spawned[0].opts.env.CLICOLOR_FORCE, '1');
    assert.equal(spawned[0].opts.env.FORCE_COLOR, '3');
    assert.equal(spawned[0].opts.env.NO_COLOR, undefined);
    assert.equal(spawned[1].opts.env.HERMES_CHAT_BOTTOM_PIN, undefined);
    assert.equal(spawned[1].opts.env.HERMES_TERMINAL_THEME, undefined);
    assert.equal(spawned[1].opts.env.COLORTERM, 'truecolor');
    assert.equal(spawned[1].opts.env.CLICOLOR_FORCE, '1');
    assert.equal(spawned[1].opts.env.FORCE_COLOR, '3');
    assert.equal(spawned[1].opts.env.NO_COLOR, undefined);
  } finally {
    if (previous == null) delete process.env.HERMES_CHAT_BOTTOM_PIN;
    else process.env.HERMES_CHAT_BOTTOM_PIN = previous;
    if (previousNoColor == null) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('createPtyRegistry: Hermes PTYs enforce one writer per HERMES_HOME', async () => {
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = {
        bin,
        args,
        opts,
        killed: false,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() { proc.killed = true; },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const exits: any[] = [];
  const emitter = new EventEmitter();
  emitter.on('pty:exit', (e: any) => exits.push(e));
  const registry = createPtyRegistry(emitter, {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {}, { ptyImpl: fakePty });

  await registry.ensureStream({
    streamId: 'conversation:rook-a',
    agent: 'hermes',
    cwd: '/tmp',
    ownerKind: 'conversation',
    ownerId: 'rook-a',
    cols: 80,
    rows: 24,
    extraEnv: { HERMES_HOME: '/tmp/ace-hhome-rook' },
  });
  const second = await registry.ensureStream({
    streamId: 'conversation:rook-b',
    agent: 'hermes',
    cwd: '/tmp',
    ownerKind: 'conversation',
    ownerId: 'rook-b',
    cols: 80,
    rows: 24,
    extraEnv: { HERMES_HOME: '/tmp/ace-hhome-rook' },
  });

  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].killed, true);
  assert.equal(registry.getStream('conversation:rook-a'), null);
  assert.equal(registry.getStream('conversation:rook-b'), second);
  assert.deepEqual(exits, [{ id: 'conversation:rook-a', code: 0 }]);
});

// Off-state regression for the Hermes Desktop surface: with no per-home
// dashboard claim, a hermes PTY spawn proceeds exactly as before — the guard
// is keyed on RUNNING dashboards only, never on any stored preference.
test('createPtyRegistry: hermes PTY spawns normally when no Hermes Desktop claim exists', async () => {
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      spawned.push(proc);
      return proc;
    },
  };
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {
    isHermesHomeClaimed: () => false,
  }, { ptyImpl: fakePty });

  const stream = await registry.ensureStream({
    streamId: 'conversation:rook-a',
    agent: 'hermes',
    cwd: '/tmp',
    ownerKind: 'conversation',
    ownerId: 'rook-a',
    cols: 80,
    rows: 24,
    extraEnv: { HERMES_HOME: '/tmp/ace-hhome-rook' },
  });

  assert.equal(spawned.length, 1);
  assert.equal(stream.status, 'running');
  assert.equal(registry.getStream('conversation:rook-a'), stream);
});

test('createPtyRegistry: hermes PTY is refused while a Hermes Desktop dashboard claims its home', async () => {
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      spawned.push(proc);
      return proc;
    },
  };
  const claimedHome = path.resolve('/tmp/ace-hhome-rook');
  const registry = createPtyRegistry(new EventEmitter(), {
    ensureState() {},
    writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
    resize() {},
    remove() {},
    sync() { return { text: '' }; },
  }, {
    isHermesHomeClaimed: (home: any) => home === claimedHome,
  }, { ptyImpl: fakePty });

  const refused = await registry.ensureStream({
    streamId: 'conversation:rook-a',
    agent: 'hermes',
    cwd: '/tmp',
    ownerKind: 'conversation',
    ownerId: 'rook-a',
    cols: 80,
    rows: 24,
    extraEnv: { HERMES_HOME: claimedHome },
  });

  assert.equal(spawned.length, 0);
  assert.equal(refused.status, 'exited');
  assert.match(refused.error, /Hermes Desktop surface/);

  // A different (unclaimed) home still spawns.
  const other = await registry.ensureStream({
    streamId: 'conversation:king-a',
    agent: 'hermes',
    cwd: '/tmp',
    ownerKind: 'conversation',
    ownerId: 'king-a',
    cols: 80,
    rows: 24,
    extraEnv: { HERMES_HOME: '/tmp/ace-hhome-king' },
  });
  assert.equal(spawned.length, 1);
  assert.equal(other.status, 'running');
});

test('persistent Hermes agent lane relaunches after unexpected non-zero exit', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-lane-restart-'));
  const userDataPath = path.join(root, 'user-data');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'hermes'), '#!/bin/sh\nexit 0\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const listeners: any = { data: [], exit: [] };
      const proc = {
        bin,
        args,
        opts,
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write() {},
        resize() {},
        kill() {},
        emitExit(exitCode: number) { for (const cb of listeners.exit) cb({ exitCode }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const lane = await store.getOrCreatePersonalIdentityWorkspace({ identity: 'rook' });
  const state = store.getState();
  const workspace = state.workspaces.find((item: any) => item.id === lane.workspaceId);
  const task = workspace?.tasks.find((item: any) => item.id === lane.taskId);
  const conversation = task?.conversations.find((item: any) => item.isMain);
  assert.ok(conversation?.id);
  const streamId = `conversation:${conversation.id}`;
  const exits: any[] = [];
  store.onPtyExit((event: any) => exits.push(event));

  const started = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });
  assert.equal(started.ok, true);
  assert.equal(spawned.length, 1);

  spawned[0].emitExit(1);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(spawned.length, 2);
  assert.deepEqual(exits.filter((event) => event.id === streamId), []);
});

test('autoStartAgentLanes launches Rook and King without automatic resume prompts', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-personal-lane-autostart-'));
  const userDataPath = path.join(root, 'user-data');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'hermes'), '#!/bin/sh\nexit 0\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const listeners: any = { data: [], exit: [] };
      const proc = {
        bin,
        args,
        opts,
        writes: [] as string[],
        onData(cb: any) { listeners.data.push(cb); },
        onExit(cb: any) { listeners.exit.push(cb); },
        write(data: string) { proc.writes.push(data); },
        resize() {},
        kill() {},
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rook = await store.getOrCreatePersonalIdentityWorkspace({ identity: 'rook' });
  const king = await store.getOrCreatePersonalIdentityWorkspace({ identity: 'king' });
  const manual = await store.createAgentLane({ agent: 'hermes', label: 'Manual Hermes', autoStart: true });
  assert.ok(spawned.length >= 1, 'manual lane starts immediately');

  const rookConversationId = store
    .getDb()
    .prepare('SELECT id FROM conversations WHERE task_id = ? AND is_main = 1')
    .get(rook.taskId).id;
  const kingConversationId = store
    .getDb()
    .prepare('SELECT id FROM conversations WHERE task_id = ? AND is_main = 1')
    .get(king.taskId).id;

  store.writeSessionIdForStream(`conversation:${rookConversationId}`, '20260603_120000_rook');
  store.writeSessionIdForStream(`conversation:${kingConversationId}`, '20260603_120000_king');
  store.writeSessionIdForStream(`conversation:${manual.mainConversationId}`, '20260603_120000_manual');

  const result = await store.autoStartAgentLanes();
  await new Promise((resolve) => setTimeout(resolve, 2200));

  assert.ok(result.started >= 2, 'Rook and King are considered for auto-start');
  const builtinPersonalSpawns = spawned.filter((proc: any) => {
    const env = proc.opts?.env || {};
    return env.ACE_IS_PERSONAL === '1' && env.ACE_AGENT_LANE_LABEL !== 'Manual Hermes';
  });
  assert.ok(builtinPersonalSpawns.length >= 1, 'built-in personal lane launches');
  for (const proc of builtinPersonalSpawns) {
    assert.deepEqual(proc.writes, [], 'built-in personal lane receives no automatic resume prompt');
  }
  // Owner doctrine: wake prompts are opt-in for EVERY lane, not just the
  // built-in personal ones. Without ACE_AUTO_WAKE_PROMPTS=1 (or a per-lane
  // metadata.autoResumePrompt) the manual lane must attach silently too.
  const manualSpawns = spawned.filter(
    (proc: any) => (proc.opts?.env || {}).ACE_AGENT_LANE_LABEL === 'Manual Hermes'
  );
  for (const proc of manualSpawns) {
    const typed = proc.writes.join('');
    assert.ok(
      !typed.includes('continue where you left off'),
      'manual lane receives no automatic resume prompt without opt-in'
    );
  }
});

test('Hermes PTY env helpers leave non-Hermes launch env unchanged', () => {
  assert.deepEqual(hermesTerminalBottomPinEnv('hermes'), {
    HERMES_CHAT_BOTTOM_PIN: '0',
    HERMES_TERMINAL_THEME: 'dark',
    COLORTERM: 'truecolor',
    CLICOLOR_FORCE: '1',
    FORCE_COLOR: '3',
  });
  assert.deepEqual(hermesTerminalBottomPinEnv('codex'), {});
  assert.deepEqual(
    hermesTerminalBottomPinEnvEntries('hermes', ['TERM=xterm-256color']),
    [
      'TERM=xterm-256color',
      'ACE_UNSET_NO_COLOR=1',
      'HERMES_CHAT_BOTTOM_PIN=0',
      'HERMES_TERMINAL_THEME=dark',
      'COLORTERM=truecolor',
      'CLICOLOR_FORCE=1',
      'FORCE_COLOR=3',
    ]
  );
  assert.deepEqual(
    hermesTerminalBottomPinEnvEntries('codex', ['TERM=xterm-256color']),
    ['TERM=xterm-256color']
  );
});

test('agent PTY env entries force truecolor for remote smart-agent launches', () => {
  assert.deepEqual(
    agentTerminalForcedEnvEntries('codex', ['TERM=xterm-256color']),
    [
      'TERM=xterm-256color',
      'ACE_UNSET_NO_COLOR=1',
      'COLORTERM=truecolor',
      'CLICOLOR_FORCE=1',
      'FORCE_COLOR=3',
    ]
  );
  assert.deepEqual(
    agentTerminalForcedEnvEntries('hermes', ['TERM=xterm-256color']),
    [
      'TERM=xterm-256color',
      'ACE_UNSET_NO_COLOR=1',
      'COLORTERM=truecolor',
      'CLICOLOR_FORCE=1',
      'FORCE_COLOR=3',
      'HERMES_CHAT_BOTTOM_PIN=0',
      'HERMES_TERMINAL_THEME=dark',
    ]
  );
  assert.deepEqual(
    agentTerminalForcedEnvEntries('shell', ['TERM=xterm-256color']),
    ['TERM=xterm-256color']
  );
});

test('sanitizeAgentSpawnEnv removes inherited Codex and stale Ace session env', () => {
  assert.deepEqual(
    sanitizeAgentSpawnEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'kept',
      CODEX_CI: '1',
      CODEX_THREAD_ID: 'old-thread',
      CLAUDE_CODE_CHILD_SESSION: '1',
      ACE_STREAM_ID: 'conversation:stale',
      ACE_USER_DATA_TAG: 'stale-tag',
      __CFBundleIdentifier: 'com.ace.app',
      ELECTRON_RUN_AS_NODE: '1',
    }),
    {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'kept',
    }
  );
});

test('local agent PTY env injects auth-backed Ace HTTP transport when remote is enabled', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-agent-cli-transport-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'hermes'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = {
        bin,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  store.setRemoteEnabled(true);
  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const first = await store.createThread({
    workspaceId,
    input: { name: 'Hermes one', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  const second = await store.createThread({
    workspaceId,
    input: { name: 'Hermes two', agent: 'hermes', prompt: null, kind: 'cli' },
  });

  assert.equal((await store.ensureStreamStarted({ streamId: `conversation:${first.conversationId}`, cols: 80, rows: 24 })).ok, true);
  assert.equal((await store.ensureStreamStarted({ streamId: `conversation:${second.conversationId}`, cols: 80, rows: 24 })).ok, true);
  assert.equal(spawned.length, 2);

  const env = spawned[0].opts.env;
  assert.equal(env.ACE_URL, 'http://127.0.0.1:9419');
  assert.equal(env.ACE_USER_DATA_TAG, path.basename(userDataPath));
  assert.match(env.ACE_SOCK, new RegExp(`ace\\.${path.basename(userDataPath)}\\.sock$`));
  assert.equal(typeof env.ACE_TOKEN, 'string');
  assert.ok(env.ACE_TOKEN.length > 20);
  assert.equal(spawned[1].opts.env.ACE_TOKEN, env.ACE_TOKEN);

  const tokenFile = path.join(userDataPath, '.ace-agent-cli-token.json');
  const tokenRecord = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  assert.equal(tokenRecord.token, env.ACE_TOKEN);
  assert.equal((fs.statSync(tokenFile).mode & 0o777), 0o600);

  const settings = store.getRemoteSettings();
  const tokenHash = createHmac('sha256', settings.serverSecret).update(env.ACE_TOKEN).digest('hex');
  const device = store.findRemoteDeviceByHash(tokenHash);
  assert.equal(device?.name, 'Ace local agent CLI transport');
  assert.equal(store.listRemoteDevices().length, 1);
});

test('local agent PTY env keeps socket transport without HTTP token when remote is disabled', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-agent-cli-socket-'));
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'hermes'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Hermes socket', agent: 'hermes', prompt: null, kind: 'cli' },
  });
  assert.equal((await store.ensureStreamStarted({ streamId: `conversation:${thread.conversationId}`, cols: 80, rows: 24 })).ok, true);
  assert.equal(spawned[0].opts.env.ACE_URL, undefined);
  assert.equal(spawned[0].opts.env.ACE_TOKEN, undefined);
  assert.match(spawned[0].opts.env.ACE_SOCK, new RegExp(`ace\\.${path.basename(userDataPath)}\\.sock$`));
});

test('local agent PTY env routes heavy storage to active external root', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-agent-storage-routing-'));
  const userDataPath = path.join(root, 'user-data');
  const externalRoot = path.join(root, 'AceData');
  const repoPath = path.join(root, 'repo');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const previousPath = process.env.PATH;
  const previousDataRoot = process.env.ACE_DATA_ROOT;
  const previousRoot = process.env.ACE_EXTERNAL_DATA_ROOT;
  const previousHome = process.env.ACE_HOME;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  delete process.env.ACE_DATA_ROOT;
  delete process.env.ACE_HOME;
  process.env.ACE_EXTERNAL_DATA_ROOT = externalRoot;
  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousDataRoot == null) delete process.env.ACE_DATA_ROOT;
    else process.env.ACE_DATA_ROOT = previousDataRoot;
    if (previousRoot == null) delete process.env.ACE_EXTERNAL_DATA_ROOT;
    else process.env.ACE_EXTERNAL_DATA_ROOT = previousRoot;
    if (previousHome == null) delete process.env.ACE_HOME;
    else process.env.ACE_HOME = previousHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const thread = await store.createThread({
    workspaceId,
    input: { name: 'Codex storage env', agent: 'codex', prompt: null, kind: 'cli' },
  });
  assert.equal((await store.ensureStreamStarted({ streamId: `conversation:${thread.conversationId}`, cols: 80, rows: 24 })).ok, true);

  const env = spawned[0].opts.env;
  assert.equal(env.ACE_HOME, path.join(externalRoot, '.ace'));
  assert.equal(env.ACE_ARTIFACT_ROOT, path.join(externalRoot, 'agent-artifacts'));
  assert.equal(env.TMPDIR, path.join(externalRoot, 'tmp'));
  assert.equal(env.npm_config_cache, path.join(externalRoot, 'caches', 'package-managers', 'npm'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join(externalRoot, 'downloads', 'playwright-browsers'));
  assert.equal(env.HF_HOME, path.join(externalRoot, 'model-assets'));
  assert.equal(spawned[0].opts.cwd, repoPath);
  assert.ok(fs.statSync(path.join(externalRoot, 'downloads', 'playwright-browsers')).isDirectory());
});

test('createPtyRegistry: Codex interactive lanes get full capability; delegated workers keep the MCP strip', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-bin-'));
  const codexBin = path.join(binDir, 'codex');
  fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codexBin, 0o755);
  const previous = {
    ACE_ENABLE_CODEX_MCP: process.env.ACE_ENABLE_CODEX_MCP,
    ACE_CODEX_HOME: process.env.ACE_CODEX_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_PROBE_LOG: process.env.CODEX_PROBE_LOG,
    ACE_STREAM_ID: process.env.ACE_STREAM_ID,
    CODEX_CI: process.env.CODEX_CI,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    __CFBundleIdentifier: process.env.__CFBundleIdentifier,
  };
  const codexHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-pty-home-'));
  const sourceCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-app-parity-home-'));
  const codexProbeLog = path.join(binDir, 'codex-probes.log');
  delete process.env.ACE_ENABLE_CODEX_MCP;
  process.env.ACE_CODEX_HOME = codexHomeRoot;
  process.env.ACE_STREAM_ID = 'conversation:stale-parent';
  process.env.CODEX_CI = '1';
  process.env.CODEX_THREAD_ID = 'old-thread';
  process.env.__CFBundleIdentifier = 'com.ace.app';
  try {
    const spawned: any[] = [];
    const fakePty = {
      spawn(bin: any, args: any, opts: any) {
        const proc = {
          bin,
          args,
          opts,
          onData() {},
          onExit() {},
          write() {},
          resize() {},
          kill() {},
        };
        spawned.push(proc);
        return proc;
      },
    };
    const registry = createPtyRegistry(new EventEmitter(), {
      ensureState() {},
      writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
      resize() {},
      remove() {},
      sync() { return { text: '' }; },
    }, {}, { ptyImpl: fakePty });

    await registry.ensureStream({
      streamId: 'conversation:codex-mcp-off',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-mcp-off',
      cols: 80,
      rows: 24,
      extraEnv: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        ACE_STREAM_ID: 'conversation:codex-mcp-off',
      },
    });
    // Interactive owner-opened lane (no launchIntent): FULL capability — no
    // `-c mcp_servers={}` strip and the real ~/.codex home (no sanitized swap).
    assert.equal(spawned[0].args.includes('mcp_servers={}'), false);
    assert.equal(spawned[0].args.includes('features.plugins=false'), false);
    assert.equal(spawned[0].opts.env.CODEX_CI, undefined);
    assert.equal(spawned[0].opts.env.CODEX_THREAD_ID, undefined);
    assert.equal(spawned[0].opts.env.__CFBundleIdentifier, undefined);
    // codexDefaultWorkerEnv returns {} for interactive lanes, so no sanitized
    // CODEX_HOME is injected — the child inherits the real ~/.codex.
    assert.equal(spawned[0].opts.env.CODEX_HOME, undefined);
    assert.equal(spawned[0].opts.env.ACE_STREAM_ID, 'conversation:codex-mcp-off');

    await registry.ensureStream({
      streamId: 'conversation:codex-medium',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-medium',
      cols: 80,
      rows: 24,
      launchIntent: { reasoningEffort: 'medium' },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.ok(spawned[1].args.includes('model_reasoning_effort="medium"'));

    await registry.ensureStream({
      streamId: 'conversation:codex-xhigh',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-xhigh',
      cols: 80,
      rows: 24,
      launchIntent: { reasoningEffort: 'xhigh' },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.ok(spawned[2].args.includes('model_reasoning_effort="xhigh"'));

    await assert.rejects(
      () => registry.ensureStream({
        streamId: 'conversation:codex-max',
        agent: 'codex',
        cwd: '/tmp',
        ownerKind: 'conversation',
        ownerId: 'codex-max',
        cols: 80,
        rows: 24,
        launchIntent: { reasoningEffort: 'max' },
        extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
      }),
      /codex reasoning effort "max" is not supported/
    );
    assert.equal(spawned.length, 3);

    await registry.ensureStream({
      streamId: 'conversation:codex-mcp-launch-intent',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-mcp-launch-intent',
      cols: 80,
      rows: 24,
      launchIntent: { enableMcp: true },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[3].args.includes('mcp_servers={}'), false);

    process.env.ACE_ENABLE_CODEX_MCP = '1';
    await registry.ensureStream({
      streamId: 'conversation:codex-mcp-opt-in',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-mcp-opt-in',
      cols: 80,
      rows: 24,
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[4].args.includes('mcp_servers={}'), false);

    fs.writeFileSync(codexBin, [
      '#!/bin/sh',
      'if [ -n "$CODEX_PROBE_LOG" ]; then printf "%s\\n" "$*" >> "$CODEX_PROBE_LOG"; fi',
      'if [ "$1" = "app-server" ]; then echo "Usage: codex app-server --listen"; exit 0; fi',
      'if [ "$1" = "plugin" ]; then echo "Manage Codex plugins"; exit 0; fi',
      'if [ "$1" = "features" ] && [ "$2" = "list" ]; then',
      '  echo "apps stable true"',
      '  echo "plugins stable true"',
      '  echo "browser_use stable true"',
      '  echo "browser_use_external stable true"',
      '  echo "computer_use stable true"',
      '  echo "in_app_browser stable true"',
      '  echo "enable_mcp_apps stable true"',
      '  exit 0',
      'fi',
      'echo "Commands: app-server plugin features"',
    ].join('\n') + '\n');
    delete process.env.ACE_ENABLE_CODEX_MCP;
    process.env.CODEX_HOME = sourceCodexHome;
    process.env.CODEX_PROBE_LOG = codexProbeLog;
    const generatedAppParityIntent = buildLaunchIntent('codex', {
      effort: 'xhigh',
      codexRuntimeProfile: 'app-parity',
      capabilities: ['computer-use'],
      toolOverrideReason: 'test fixture authorizes Codex app-parity runtime',
    });
    assert.equal(codexAppParityRequested(generatedAppParityIntent), true);
    await registry.ensureStream({
      streamId: 'conversation:codex-app-parity',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'codex-app-parity',
      cols: 80,
      rows: 24,
      launchIntent: generatedAppParityIntent,
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[5].args.includes('mcp_servers={}'), false);
    assert.ok(spawned[5].args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(spawned[5].args.includes('features.apps=true'));
    assert.ok(spawned[5].args.includes('features.plugins=true'));
    assert.ok(spawned[5].args.includes('features.computer_use=true'));
    assert.equal(spawned[5].opts.env.CODEX_HOME, sourceCodexHome);
    assert.equal(spawned[5].opts.env.ACE_CODEX_RUNTIME_PROFILE, 'app-parity');
    assert.equal(spawned[5].opts.env.ACE_CODEX_APP_PARITY, '1');
    const probes = fs.readFileSync(codexProbeLog, 'utf8');
    assert.match(probes, /--help/);
    assert.match(probes, /app-server --help/);
    assert.match(probes, /plugin --help/);
    assert.match(probes, /features list/);

    // Regression guard: a DELEGATED worker lane (full orchestrator launchIntent
    // carrying `provider`, enableMcp:false) MUST still get the strip + sanitized
    // CODEX_HOME so spawned workers do not inherit the heavy global MCP surface.
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_PROBE_LOG;
    const workerIntent = buildLaunchIntent('codex', {});
    assert.equal(workerIntent.provider, 'codex');
    assert.equal(workerIntent.enableMcp, false);
    await registry.ensureStream({
      streamId: 'variant:codex-worker',
      agent: 'codex',
      cwd: '/tmp',
      ownerKind: 'variant',
      ownerId: 'codex-worker',
      cols: 80,
      rows: 24,
      launchIntent: workerIntent,
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.deepEqual(spawned[6].args.slice(0, 2), ['-c', 'mcp_servers={}']);
    assert.equal(spawned[6].args.includes('features.plugins=false'), true);
    assert.equal(spawned[6].opts.env.CODEX_HOME, codexHomeRoot);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(codexHomeRoot, { recursive: true, force: true });
    fs.rmSync(sourceCodexHome, { recursive: true, force: true });
  }
});

test('createPtyRegistry: Claude PTYs apply scoped launch effort when provided', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-claude-bin-'));
  const claudeBin = path.join(binDir, 'claude');
  fs.writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(claudeBin, 0o755);
  try {
    const spawned: any[] = [];
    const fakePty = {
      spawn(bin: any, args: any, opts: any) {
        const proc = {
          bin,
          args,
          opts,
          onData() {},
          onExit() {},
          write() {},
          resize() {},
          kill() {},
        };
        spawned.push(proc);
        return proc;
      },
    };
    const registry = createPtyRegistry(new EventEmitter(), {
      ensureState() {},
      writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
      resize() {},
      remove() {},
      sync() { return { text: '' }; },
    }, {}, {
      ptyImpl: fakePty,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });

    await registry.ensureStream({
      streamId: 'conversation:claude-medium',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'claude-medium',
      cols: 80,
      rows: 24,
      launchIntent: { reasoningEffort: 'medium' },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[0].args.includes('--effort'), true);
    assert.equal(spawned[0].args[spawned[0].args.indexOf('--effort') + 1], 'medium');

    await registry.ensureStream({
      streamId: 'conversation:claude-max',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'claude-max',
      cols: 80,
      rows: 24,
      launchIntent: { reasoningEffort: 'max' },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[1].args.includes('--effort'), true);
    assert.equal(spawned[1].args[spawned[1].args.indexOf('--effort') + 1], 'max');
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('createPtyRegistry: Claude interactive lanes omit --strict-mcp-config; delegated workers keep it', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-claude-mcp-bin-'));
  const claudeBin = path.join(binDir, 'claude');
  fs.writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(claudeBin, 0o755);
  const prevEnable = process.env.ACE_ENABLE_CLAUDE_MCP;
  delete process.env.ACE_ENABLE_CLAUDE_MCP;
  try {
    const spawned: any[] = [];
    const fakePty = {
      spawn(bin: any, args: any, opts: any) {
        const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
        spawned.push(proc);
        return proc;
      },
    };
    const registry = createPtyRegistry(new EventEmitter(), {
      ensureState() {},
      writeData(_id: any, data: string) { return { seq: 1, rewritten: data }; },
      resize() {},
      remove() {},
      sync() { return { text: '' }; },
    }, {}, {
      ptyImpl: fakePty,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });

    // Interactive owner-opened lane (no launchIntent): Claude loads the user's
    // ~/.claude.json + claude.ai connectors, so NEITHER flag is pushed.
    await registry.ensureStream({
      streamId: 'conversation:claude-interactive',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'claude-interactive',
      cols: 80,
      rows: 24,
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[0].args.includes('--strict-mcp-config'), false);
    assert.equal(spawned[0].args.includes('--mcp-config'), false);

    // A thin interactive launchIntent (effort only, no `provider`) stays full.
    await registry.ensureStream({
      streamId: 'conversation:claude-interactive-effort',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'conversation',
      ownerId: 'claude-interactive-effort',
      cols: 80,
      rows: 24,
      launchIntent: { reasoningEffort: 'high' },
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[1].args.includes('--strict-mcp-config'), false);
    assert.ok(spawned[1].args.includes('--effort'));

    // Delegated worker lane (full orchestrator launchIntent carrying `provider`):
    // the strip STAYS ON so spawned workers do not inherit connectors/MCP.
    const workerIntent = buildLaunchIntent('claude', {});
    assert.equal(workerIntent.provider, 'claude');
    await registry.ensureStream({
      streamId: 'variant:claude-worker',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'variant',
      ownerId: 'claude-worker',
      cols: 80,
      rows: 24,
      launchIntent: workerIntent,
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[2].args.includes('--strict-mcp-config'), true);
    assert.equal(spawned[2].args.includes('--mcp-config'), true);

    // Explicit env opt-in forces full capability even for a worker intent.
    process.env.ACE_ENABLE_CLAUDE_MCP = '1';
    await registry.ensureStream({
      streamId: 'variant:claude-worker-optin',
      agent: 'claude',
      cwd: '/tmp',
      ownerKind: 'variant',
      ownerId: 'claude-worker-optin',
      cols: 80,
      rows: 24,
      launchIntent: buildLaunchIntent('claude', {}),
      extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });
    assert.equal(spawned[3].args.includes('--strict-mcp-config'), false);
  } finally {
    if (prevEnable == null) delete process.env.ACE_ENABLE_CLAUDE_MCP;
    else process.env.ACE_ENABLE_CLAUDE_MCP = prevEnable;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('laneIsInteractiveLane / shouldUseClaudeMcp / shouldUseGlobalCodexMcp: interactive vs worker predicate', () => {
  const prevClaude = process.env.ACE_ENABLE_CLAUDE_MCP;
  const prevCodex = process.env.ACE_ENABLE_CODEX_MCP;
  delete process.env.ACE_ENABLE_CLAUDE_MCP;
  delete process.env.ACE_ENABLE_CODEX_MCP;
  try {
    // Interactive: no launchIntent, or any intent WITHOUT an explicit delegation
    // marker — including one that merely carries `provider` (shape is not sniffed).
    assert.equal(laneIsInteractiveLane({}), true);
    assert.equal(laneIsInteractiveLane({ launchIntent: { resumePrompt: 'go' } }), true);
    assert.equal(laneIsInteractiveLane({ launchIntent: { providerAccountId: 'acct-1' } }), true);
    assert.equal(laneIsInteractiveLane({ launchIntent: { reasoningEffort: 'high' } }), true);
    // `provider` alone identifies an agent, not lane ownership: INTERACTIVE now.
    assert.equal(laneIsInteractiveLane({ launchIntent: { provider: 'claude' } }), true);
    // A top-level opts marker is NOT honored (no spawn site passes one): only the
    // launchIntent's explicit delegated/worker/headless marker classifies a worker.
    assert.equal(laneIsInteractiveLane({ delegated: true }), true);
    assert.equal(laneIsInteractiveLane({ worker: true }), true);
    assert.equal(laneIsInteractiveLane({ launchIntent: { delegated: true } }), false);
    assert.equal(laneIsInteractiveLane({ launchIntent: { worker: true } }), false);
    assert.equal(laneIsInteractiveLane({ launchIntent: { headless: true } }), false);
    // buildLaunchIntent (the worker-spawn producer) stamps the marker explicitly,
    // so orchestrator-spawned workers still classify as workers.
    assert.equal(buildLaunchIntent('claude', {}).delegated, true);
    assert.equal(buildLaunchIntent('codex', {}).delegated, true);
    assert.equal(laneIsInteractiveLane({ launchIntent: buildLaunchIntent('claude', {}) }), false);
    assert.equal(laneIsInteractiveLane({ launchIntent: buildLaunchIntent('codex', {}) }), false);

    // Claude MCP policy.
    assert.equal(shouldUseClaudeMcp({}), true);
    assert.equal(shouldUseClaudeMcp({ launchIntent: buildLaunchIntent('claude', {}) }), false);
    assert.equal(shouldUseClaudeMcp({ enableMcp: true, launchIntent: buildLaunchIntent('claude', {}) }), true);
    assert.equal(shouldUseClaudeMcp({ launchIntent: { enableMcp: true, provider: 'claude' } }), true);
    process.env.ACE_ENABLE_CLAUDE_MCP = '1';
    assert.equal(shouldUseClaudeMcp({ launchIntent: buildLaunchIntent('claude', {}) }), true);
    delete process.env.ACE_ENABLE_CLAUDE_MCP;

    // Codex MCP policy (interactive full; worker off; env + app-parity opt-ins).
    assert.equal(shouldUseGlobalCodexMcp({}), true);
    assert.equal(shouldUseGlobalCodexMcp({ launchIntent: buildLaunchIntent('codex', {}) }), false);
    assert.equal(shouldUseGlobalCodexMcp({ enableMcp: true, launchIntent: buildLaunchIntent('codex', {}) }), true);
    process.env.ACE_ENABLE_CODEX_MCP = '1';
    assert.equal(shouldUseGlobalCodexMcp({ launchIntent: buildLaunchIntent('codex', {}) }), true);
    delete process.env.ACE_ENABLE_CODEX_MCP;
  } finally {
    if (prevClaude == null) delete process.env.ACE_ENABLE_CLAUDE_MCP;
    else process.env.ACE_ENABLE_CLAUDE_MCP = prevClaude;
    if (prevCodex == null) delete process.env.ACE_ENABLE_CODEX_MCP;
    else process.env.ACE_ENABLE_CODEX_MCP = prevCodex;
  }
});

test('respawnLaunchIntentFor: a respawn preserves the original worker/interactive classification', () => {
  // Interactive lanes pass through unchanged — the thin respawn intent (extra
  // fields only) stays interactive, so nothing is added.
  assert.deepEqual(respawnLaunchIntentFor(undefined, { resumeMode: 'resume' }), {
    resumeMode: 'resume',
  });
  assert.deepEqual(respawnLaunchIntentFor({ resumePrompt: 'go' }, { resumeMode: 'resume' }), {
    resumeMode: 'resume',
  });
  assert.deepEqual(respawnLaunchIntentFor(null), {});

  // A worker lane (orchestrator intent, explicit delegated marker) is re-flagged
  // delegated so laneIsInteractiveLane keeps classifying it a worker — the
  // capability strip must NOT reopen on respawn.
  const claudeWorker = respawnLaunchIntentFor(buildLaunchIntent('claude', {}), { resumeMode: 'resume' });
  assert.equal(claudeWorker.delegated, true);
  assert.equal(claudeWorker.resumeMode, 'resume');
  assert.equal(laneIsInteractiveLane({ launchIntent: claudeWorker }), false);
  assert.equal(shouldUseClaudeMcp({ launchIntent: claudeWorker }), false);

  const codexWorker = respawnLaunchIntentFor(buildLaunchIntent('codex', {}));
  assert.equal(codexWorker.delegated, true);
  assert.equal(shouldUseGlobalCodexMcp({ launchIntent: codexWorker }), false);

  // No shape sniffing at the respawn seam either: an intent carrying `provider`
  // but NO delegated marker is INTERACTIVE and passes through untouched.
  assert.deepEqual(respawnLaunchIntentFor({ provider: 'codex' }, { resumeMode: 'resume' }), {
    resumeMode: 'resume',
  });

  // A worker that explicitly opted INTO MCP keeps that opt-in across the respawn
  // (both the delegated flag and the enableMcp passthrough are carried).
  const optInWorker = respawnLaunchIntentFor({ delegated: true, enableMcp: true });
  assert.equal(optInWorker.delegated, true);
  assert.equal(optInWorker.enableMcp, true);
});

test('buildRemoteAgentCommand: a remote worker relaunch keeps the strip; interactive relaunch does not (relaunchRemoteStream fix site)', () => {
  const prevClaude = process.env.ACE_ENABLE_CLAUDE_MCP;
  const prevCodex = process.env.ACE_ENABLE_CODEX_MCP;
  delete process.env.ACE_ENABLE_CLAUDE_MCP;
  delete process.env.ACE_ENABLE_CODEX_MCP;
  try {
    // Worker relaunch: the derived intent still classifies as a worker, so the
    // remote command re-applies the strip the original spawn had.
    const claudeWorker = buildRemoteAgentCommand('claude', {
      launchIntent: respawnLaunchIntentFor(buildLaunchIntent('claude', {})),
    });
    assert.equal(claudeWorker.args.includes('--strict-mcp-config'), true);
    assert.equal(claudeWorker.args.includes('--mcp-config'), true);

    const codexWorker = buildRemoteAgentCommand('codex', {
      launchIntent: respawnLaunchIntentFor(buildLaunchIntent('codex', {})),
    });
    assert.equal(codexWorker.args.includes('mcp_servers={}'), true);

    // Interactive relaunch (no retained intent): full capability preserved — the
    // relaunch must not silently START stripping an interactive lane either.
    const claudeInteractive = buildRemoteAgentCommand('claude', {
      launchIntent: respawnLaunchIntentFor(undefined),
    });
    assert.equal(claudeInteractive.args.includes('--strict-mcp-config'), false);

    const codexInteractive = buildRemoteAgentCommand('codex', {
      launchIntent: respawnLaunchIntentFor(undefined),
    });
    assert.equal(codexInteractive.args.includes('mcp_servers={}'), false);
  } finally {
    if (prevClaude == null) delete process.env.ACE_ENABLE_CLAUDE_MCP;
    else process.env.ACE_ENABLE_CLAUDE_MCP = prevClaude;
    if (prevCodex == null) delete process.env.ACE_ENABLE_CODEX_MCP;
    else process.env.ACE_ENABLE_CODEX_MCP = prevCodex;
  }
});

test('laneWorkerClassificationIntent: distills the DURABLE worker classification persisted for restart', () => {
  // Interactive lanes have nothing to persist.
  assert.equal(laneWorkerClassificationIntent(undefined), null);
  assert.equal(laneWorkerClassificationIntent({ resumePrompt: 'go' }), null);
  // No shape sniffing: `provider` without a delegated marker is interactive.
  assert.equal(laneWorkerClassificationIntent({ provider: 'claude' }), null);
  // Workers persist the minimal classifying intent; an MCP opt-in is retained.
  assert.deepEqual(laneWorkerClassificationIntent(buildLaunchIntent('claude', {})), { delegated: true });
  assert.deepEqual(laneWorkerClassificationIntent(buildLaunchIntent('codex', {})), { delegated: true });
  assert.deepEqual(laneWorkerClassificationIntent({ delegated: true, enableMcp: true }), {
    delegated: true,
    enableMcp: true,
  });
  // The persisted shape survives a JSON round-trip (agent_resume_state.launch_intent)
  // and still re-classifies as a worker at respawn time.
  const persisted = JSON.parse(JSON.stringify(laneWorkerClassificationIntent(buildLaunchIntent('claude', {}))));
  assert.equal(laneIsInteractiveLane({ launchIntent: persisted }), false);
});

test('createAceStore: capability classification persists; legacy (pre-migration) rows fail closed to a worker', () => {
  const { store, cleanup } = bootLaneStore();
  try {
    const now = new Date().toISOString();
    const ins = store.getDb().prepare(
      'INSERT INTO agent_resume_state (stream_id, cols, rows, launch_intent, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run('conversation:worker', 80, 24, JSON.stringify({ delegated: true }), now);
    ins.run('conversation:worker-mcp', 80, 24, JSON.stringify({ delegated: true, enableMcp: true }), now);
    ins.run('conversation:interactive', 80, 24, 'interactive', now); // explicit non-null sentinel
    ins.run('conversation:legacy', 80, 24, null, now);               // pre-migration NULL row
    ins.run('conversation:malformed', 80, 24, '{not valid json', now);
    ins.run('conversation:nonconforming', 80, 24, '{"resumePrompt":"go"}', now);
    // null (interactive) only for the sentinel or a missing row; worker intent,
    // legacy NULL, malformed, and nonconforming values all fail closed.
    const cls = (id: string) => store._internals.restoredLaneClassification(id);
    assert.deepEqual(cls('conversation:worker'), { delegated: true });
    assert.deepEqual(cls('conversation:worker-mcp'), { delegated: true, enableMcp: true });
    assert.equal(cls('conversation:interactive'), null);
    assert.deepEqual(cls('conversation:legacy'), { delegated: true });
    assert.deepEqual(cls('conversation:malformed'), { delegated: true });
    assert.deepEqual(cls('conversation:nonconforming'), { delegated: true });
    assert.equal(cls('conversation:missing'), null);
  } finally { cleanup(); }
});

test('createAceStore gates Claude resume targets by live ownership and forwards raw terminal input', async () => {
  const { store, repo, cleanup } = bootLaneStore({ withRepo: true });
  try {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const first = await spawnStoreClaudeLane(store, workspaceId, 'first');
    const second = await spawnStoreClaudeLane(store, workspaceId, 'second');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    store.writeSessionIdForStream(first, sessionId);

    assert.equal(store.canBindSessionIdForStream(first, sessionId), true);
    assert.equal(store.canBindSessionIdForStream(second, sessionId), false);

    // Historical bindings do not block an explicit /resume once their lane is no longer live.
    store.getDb().prepare('DELETE FROM agent_resume_state WHERE stream_id = ?').run(first);
    assert.equal(store.canBindSessionIdForStream(second, sessionId), true);

    const observed = [];
    store.streamObserveTerminalInput = (row: any) => { observed.push(row); };
    store.writeTerminalInput({ streamId: second, data: '/resume\r' });
    assert.deepEqual(observed, [{ streamId: second, data: '/resume\r' }]);
  } finally { cleanup(); }
});

test('createAceStore.restoreAgentStreams restores the worker strip onto an adopted lane across a restart', async () => {
  const adoptHandle = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const ptyHost: any = {
    isConnected: () => false,
    ensureConnected: async () => ptyHost._survivors || [],
    adoptStream: async () => ({ handle: adoptHandle }),
    killStream: async () => {}, release: async () => {}, _survivors: [],
  };
  const { store, repo, cleanup } = bootLaneStore({ withRepo: true, ptyHost });
  try {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const mkLane = async (name: string) => {
      const t = await store.createThread({ workspaceId, input: { name, agent: 'claude', prompt: null, kind: 'cli' } });
      const sid = `conversation:${t.conversationId}`;
      store.writeSessionIdForStream(sid, `20260101_000000_${name}`);
      return sid;
    };
    const workerSid = await mkLane('worker');
    const interactiveSid = await mkLane('interactive');
    const legacySid = await mkLane('legacy');

    // Seed the resume rows as they'd exist at restart, then have the pty-host
    // report all three lanes as survivors.
    const now = new Date().toISOString();
    const upsert = store.getDb().prepare(
      `INSERT INTO agent_resume_state (stream_id, cols, rows, launch_intent, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET launch_intent=excluded.launch_intent, updated_at=excluded.updated_at`
    );
    upsert.run(workerSid, 80, 24, JSON.stringify({ delegated: true }), now);
    upsert.run(interactiveSid, 80, 24, 'interactive', now);
    upsert.run(legacySid, 80, 24, null, now); // legacy pre-migration row
    ptyHost._survivors = [workerSid, interactiveSid, legacySid].map((id) => ({ id, status: 'running', cols: 80, rows: 24 }));

    const summary = await store.restoreAgentStreams({ relaunchMissing: false });
    assert.equal(summary.adopted, 3);
    // The real restore threaded the classification onto each adopted stream.
    assert.deepEqual(store._internals.laneLaunchIntent(workerSid), { delegated: true });
    assert.equal(store._internals.laneLaunchIntent(interactiveSid), null);
    assert.deepEqual(store._internals.laneLaunchIntent(legacySid), { delegated: true });
  } finally { cleanup(); }
});

test('createAceStore.ensureStreamStarted adopts a detached survivor before planning a new session', async () => {
  const adoptHandle = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  let adoptCalls = 0;
  let spawnCalls = 0;
  const ptyHost: any = {
    isConnected: () => true,
    ensureConnected: async () => ptyHost._survivors || [],
    adoptStream: async () => {
      adoptCalls += 1;
      return { handle: adoptHandle, status: 'running' };
    },
    spawnStream: () => {
      spawnCalls += 1;
      return adoptHandle;
    },
    killStream: async () => {},
    release: async () => {},
    _survivors: [],
  };
  const { store, repo, cleanup } = bootLaneStore({ withRepo: true, ptyHost });
  try {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const thread = await store.createThread({
      workspaceId,
      input: { name: 'survivor', agent: 'claude', prompt: null, kind: 'cli' },
    });
    const streamId = `conversation:${thread.conversationId}`;
    const persistedSessionId = '33333333-3333-4333-8333-333333333333';
    store.writeSessionIdForStream(streamId, persistedSessionId);
    ptyHost._survivors = [{ id: streamId, status: 'running', cols: 80, rows: 24 }];

    const result = await store.ensureStreamStarted({ streamId, cols: 80, rows: 24 });

    assert.equal(result.ok, true);
    assert.equal(result.adopted, true);
    assert.equal(adoptCalls, 1);
    assert.equal(spawnCalls, 0, 'must not ask the host to spawn and silently reattach');
    assert.equal(store.resolveStreamOwner(streamId).sessionId, persistedSessionId);
    assert.equal(store._internals.getStream(streamId).resumeMode, 'adopted');
  } finally { cleanup(); }
});

test('createAceStore._internals.handleLocalStreamExit keeps a worker stripped on a fast-exit resume retry', async () => {
  const { store, spawned, repo, cleanup } = bootLaneStore({ withRepo: true });
  try {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const workerSid = await spawnStoreClaudeLane(store, workspaceId, 'worker', buildLaunchIntent('claude', {}));
    assert.equal(hasStrip(spawned[0]), true);
    const stream = store._internals.getStream(workerSid);
    stream.resumeMode = 'resume'; // a resume that died instantly hits the fresh-restart retry
    stream.startedAt = Date.now();
    const before = spawned.length;
    assert.equal(store._internals.handleLocalStreamExit(workerSid, 1, stream), true);
    await laneDelay(200);
    assert.ok(spawned.length > before);
    assert.equal(hasStrip(spawned[spawned.length - 1]), true);
  } finally { cleanup(); }
});

test('resolvePersonalIdentity: personal_identity drives King/Rook identity even when renamed', () => {
  assert.equal(resolvePersonalIdentity({ is_personal: 1, name: 'Renamed Ops', personal_identity: 'rook' }), 'rook');
  assert.equal(resolvePersonalIdentity({ is_personal: 1, name: 'Renamed Ops', personal_identity: 'King' }), 'king');
  assert.equal(resolvePersonalIdentity({ is_personal: 1, name: 'Rook', personal_identity: null }), 'rook');
  assert.equal(resolvePersonalIdentity({ is_personal: 0, name: 'Rook', personal_identity: 'rook' }), null);
});

test('shouldSuppressPersonalHermesAutoPrompt: Rook and King suppress automatic wake/resume prompts', () => {
  assert.equal(
    shouldSuppressPersonalHermesAutoPrompt({
      agentId: 'hermes',
      project: { is_personal: 1, personal_identity: 'rook', name: 'Rook' },
      streamId: 'conversation:rook',
    }),
    true
  );
  assert.equal(
    shouldSuppressPersonalHermesAutoPrompt({
      agentId: 'hermes',
      project: { is_personal: 1, personal_identity: 'king', name: 'King' },
      streamId: 'conversation:king',
    }),
    true
  );
  assert.equal(
    shouldInjectPersonalHermesWakeBrief({
      agentId: 'hermes',
      project: { is_personal: 1, personal_identity: 'rook', name: 'Rook' },
      streamId: 'conversation:rook',
    }),
    false
  );
  assert.equal(
    shouldInjectPersonalHermesWakeBrief({
      agentId: 'hermes',
      project: { is_personal: 1, personal_identity: 'king', name: 'King' },
      streamId: 'conversation:king',
    }),
    false
  );
  assert.equal(
    shouldSuppressPersonalHermesAutoPrompt({
      agentId: 'hermes',
      project: { is_personal: 1, personal_identity: 'lane:abc', name: 'Manual Hermes' },
      streamId: 'conversation:manual',
    }),
    false
  );
  assert.equal(
    shouldInjectPersonalHermesWakeBrief({
      agentId: 'codex',
      project: { is_personal: 1, personal_identity: 'rook', name: 'Rook' },
      streamId: 'conversation:rook',
    }),
    false
  );
  assert.equal(
    shouldInjectPersonalHermesWakeBrief({
      agentId: 'hermes',
      project: { is_personal: 0, personal_identity: 'king', name: 'King' },
      streamId: 'conversation:king',
    }),
    false
  );
});

test('hasExistingHermesWakeBrief: detects corrected wake prompts so relaunches do not repeat them', () => {
  assert.equal(hasExistingHermesWakeBrief('Welcome\nHermes wake-up brief\n❯'), false);
  assert.equal(
    hasExistingHermesWakeBrief('Hermes wake-up: post the brief below verbatim\nRole: viewer (read-only)\n❯'),
    false
  );
  assert.equal(
    hasExistingHermesWakeBrief('Morning. Ace Agents are up — Rook and King are the standing operator lanes; repo workspace orchestrators are opt-in.'),
    true
  );
  assert.equal(hasExistingHermesWakeBrief('Rook wake-up: post the brief below verbatim\n❯'), true);
  assert.equal(hasExistingHermesWakeBrief('King wake-up: post the brief below verbatim\n❯'), true);
  assert.equal(hasExistingHermesWakeBrief('King wake-up: use the brief below to rehydrate\n❯'), true);
  assert.equal(hasExistingHermesWakeBrief('Welcome to Hermes Agent!\n❯'), false);
});

function createFakeChokidar() {
  const watchCalls: any[] = [];
  return {
    watchCalls,
    impl: {
      watch(cwd: string, options: any) {
        watchCalls.push({ cwd, options });
        return {
          on() { return this; },
          close() {},
          getWatched() { return {}; },
        };
      },
    },
  };
}

test('shouldAttachStartupGitWatchers: default startup keeps bounded local git refresh enabled', () => {
  assert.equal(
    shouldAttachStartupGitWatchers({ activeLocalTaskCount: 2, env: {} }),
    true
  );
  assert.equal(
    shouldAttachStartupGitWatchers({ activeLocalTaskCount: 42, env: {} }),
    true
  );
  assert.equal(
    shouldAttachStartupGitWatchers({
      activeLocalTaskCount: 42,
      env: { ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1' },
    }),
    true
  );
  assert.equal(
    shouldAttachStartupGitWatchers({
      activeLocalTaskCount: 2,
      env: { ACE_DISABLE_GIT_WATCHER: '1' },
    }),
    false
  );
});

test('shouldUseFullTreeGitWatcher: full-worktree chokidar is explicit opt-in', () => {
  assert.equal(shouldUseFullTreeGitWatcher({ env: {} }), false);
  assert.equal(
    shouldUseFullTreeGitWatcher({ env: { ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1' } }),
    true
  );
  assert.equal(
    shouldUseFullTreeGitWatcher({ env: { ACE_ENABLE_STARTUP_GIT_WATCHER: '1' } }),
    true
  );
  assert.equal(
    shouldUseFullTreeGitWatcher({
      env: {
        ACE_DISABLE_GIT_WATCHER: '1',
        ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1',
      },
    }),
    false
  );
});

test('createGitWatcher: default task attach does not start full-tree chokidar watchers', () => {
  const fakeChokidar = createFakeChokidar();
  const watcher = createGitWatcher(
    new EventEmitter(),
    (taskId: string) => path.join(os.tmpdir(), `ace-${taskId}`),
    { env: {}, chokidarImpl: fakeChokidar.impl }
  );

  watcher.attachTask('tsk_default_1');
  watcher.attachTask('tsk_default_2');

  assert.equal(fakeChokidar.watchCalls.length, 0);
  watcher.shutdown();
});

test('createGitWatcher: disable env wins over full-tree watcher opt-in', () => {
  const fakeChokidar = createFakeChokidar();
  const watcher = createGitWatcher(
    new EventEmitter(),
    () => os.tmpdir(),
    {
      env: {
        ACE_DISABLE_GIT_WATCHER: '1',
        ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1',
      },
      chokidarImpl: fakeChokidar.impl,
    }
  );

  watcher.attachTask('tsk_disabled');

  assert.equal(fakeChokidar.watchCalls.length, 0);
  assert.deepEqual(watcher.getTaskTotals('tsk_disabled'), { additions: 0, deletions: 0 });
  watcher.shutdown();
});

test('createGitWatcher: explicit full-tree watcher opt-in starts chokidar per cwd', () => {
  const fakeChokidar = createFakeChokidar();
  const watcher = createGitWatcher(
    new EventEmitter(),
    (taskId: string) => path.join(os.tmpdir(), `ace-${taskId}`),
    {
      env: { ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1' },
      chokidarImpl: fakeChokidar.impl,
    }
  );

  watcher.attachTask('tsk_opt_in_1');
  watcher.attachTask('tsk_opt_in_2');

  assert.equal(fakeChokidar.watchCalls.length, 2);
  assert.match(fakeChokidar.watchCalls[0].cwd, /ace-tsk_opt_in_1$/);
  assert.equal(fakeChokidar.watchCalls[0].options.ignoreInitial, true);
  assert.equal(fakeChokidar.watchCalls[0].options.depth, 20);
  watcher.shutdown();
});

// resolveClonePath tests — no network I/O, pure path logic.
const FAKE_ROOT = '/fake/clone/root';

test('resolveClonePath: simple relative name lands under clone root', () => {
  assert.equal(
    resolveClonePath('goldbot', FAKE_ROOT),
    path.join(FAKE_ROOT, 'goldbot')
  );
});

test('resolveClonePath: nested relative path stays under clone root', () => {
  assert.equal(
    resolveClonePath('foo/bar', FAKE_ROOT),
    path.join(FAKE_ROOT, 'foo', 'bar')
  );
});

test('resolveClonePath: absolute path is returned as-is (normalized)', () => {
  const abs = '/Users/alice/projects/myrepo';
  assert.equal(resolveClonePath(abs, FAKE_ROOT), path.normalize(abs));
});

test('resolveClonePath: traversal via .. is rejected', () => {
  assert.throws(
    () => resolveClonePath('../bad', FAKE_ROOT),
    /escapes the clone root/
  );
});

test('resolveClonePath: bare .. is rejected', () => {
  assert.throws(
    () => resolveClonePath('..', FAKE_ROOT),
    /escapes the clone root/
  );
});

// ── resolveOperatorProfileHome: source-aware session routing ────────────────

function seedSessions(dbPath: any, count: number, source = 'tui') {
  // Craft a Hermes-shaped state.db: a `sessions` table with `source` rows and
  // an empty `messages` table — exactly the King/Rook shape (sessions with 0
  // message rows) the old message-count probe mis-read as empty.
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)');
    for (let i = 0; i < count; i += 1) insert.run(`${source}-s${i}`, source);
  } finally {
    db.close();
  }
}

function writeBuiltinPersonalOperator(userDataPath: any, id: any, hermesHome: any) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, 'operators.json'),
    JSON.stringify(
      {
        schema: 'ace.operators.v1',
        defaultOperatorId: 'hermes',
        operators: [
          {
            id: 'hermes',
            label: 'Hermes',
            agent: 'hermes',
            providerKind: 'neutral',
            isControlPlane: false,
            autoStart: false,
            persona: null,
            workspaceDirName: 'workspace',
            terminalDirName: 'hermes',
          },
          {
            id,
            label: id,
            agent: 'hermes',
            providerKind: 'builtin-personal',
            isControlPlane: true,
            autoStart: true,
            persona: null,
            hermesHome,
            workspaceDirName: `${id}-workspace`,
            terminalDirName: `${id}-hermes`,
          },
        ],
      },
      null,
      2
    )
  );
}

test('resolveOperatorProfileHome falls through (null) when configured home has 0 sessions but the --profile re-root has >0', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const configuredHome = path.join(root, 'configured-home'); // stays empty
  const fakeHome = path.join(root, 'fake-home');
  fs.mkdirSync(configuredHome, { recursive: true });
  writeBuiltinPersonalOperator(userDataPath, 'kingtest', configuredHome);

  // The legacy `--profile` re-root lives at $HOME/.hermes/profiles/<id>; the
  // resolver reads it via os.homedir(), so redirect HOME to a tmp dir and seed
  // it with TUI sessions — never touching the real ~/.hermes.
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  seedSessions(path.join(fakeHome, '.hermes', 'profiles', 'kingtest', 'state.db'), 5);

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Configured home has 0 dashboard-visible sessions, the re-root has 5 →
  // fall through to the legacy `--profile` path (null) so the populated
  // chats render.
  assert.equal(store.resolveOperatorProfileHome('kingtest'), null);

  // Positive control: once the configured home itself has sessions, the
  // resolver routes straight to it (no fall-through).
  seedSessions(path.join(configuredHome, 'state.db'), 3);
  assert.equal(store.resolveOperatorProfileHome('kingtest'), configuredHome);
});

test('resolveOperatorProfileHome counts CLI sessions as populated and ignores cron-only noise', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const configuredHome = path.join(root, 'configured-home');
  const fakeHome = path.join(root, 'fake-home');
  fs.mkdirSync(configuredHome, { recursive: true });
  writeBuiltinPersonalOperator(userDataPath, 'kingtest', configuredHome);

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // Re-root holds a couple of dashboard (tui) sessions; the configured home
  // holds the owner's REAL history as `cli` sessions from PTY lanes. The
  // dashboard renders cli sessions (it only excludes cron), so the configured
  // home must win — the old tui-only count read it as empty and fell through.
  seedSessions(path.join(fakeHome, '.hermes', 'profiles', 'kingtest', 'state.db'), 2);
  seedSessions(path.join(configuredHome, 'state.db'), 4, 'cli');

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(store.resolveOperatorProfileHome('kingtest'), configuredHome);
});

test('resolveOperatorProfileHome ignores cron-only noise: a cron-only home still falls through to a populated re-root', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const cronHome = path.join(root, 'cron-home');
  const fakeHome = path.join(root, 'fake-home');
  fs.mkdirSync(cronHome, { recursive: true });
  writeBuiltinPersonalOperator(userDataPath, 'kingtest', cronHome);

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // Cron-only sessions are invisible on the dashboard's recents list and must
  // not count as "populated".
  seedSessions(path.join(cronHome, 'state.db'), 7, 'cron');
  seedSessions(path.join(fakeHome, '.hermes', 'profiles', 'kingtest', 'state.db'), 2);

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(store.resolveOperatorProfileHome('kingtest'), null);
});

test('resolveOperatorProfileHome resolves a builtin-personal operator with NO explicit hermesHome to its per-identity home', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const fakeHome = path.join(root, 'fake-home');
  // hermesHome: null — the live-config shape after a config revert. The
  // resolver must still derive the per-identity home from the project row
  // instead of dumping the identity into the empty `--profile` re-root.
  writeBuiltinPersonalOperator(userDataPath, 'kingtest', null);

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Without a project row (and without an explicit hermesHome) there is no
  // derivable per-identity home: stay on the legacy `--profile` path.
  assert.equal(store.resolveOperatorProfileHome('kingtest'), null);
  // Resolution alone must not mint a phantom home dir.
  assert.equal(fs.existsSync(path.join(userDataPath, 'hermes-home-kingtest')), false);

  // Seed the identity's personal project row — the generic mapping the
  // resolver derives the home from.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(userDataPath, 'ace.db'));
  try {
    db.prepare(
      `INSERT INTO projects (id, name, path, is_personal, personal_identity, initialized, order_index, created_at, updated_at)
       VALUES ('prj-kt1', 'KingTest', ?, 1, 'kingtest', 1, 0, '2026-01-01', '2026-01-01')`
    ).run(path.join(root, 'kingtest-workspace'));
  } finally {
    db.close();
  }

  const resolved = store.resolveOperatorProfileHome('kingtest');
  assert.equal(resolved, path.join(userDataPath, 'hermes-home-prj-kt1'));

  // Non-personal operators keep the legacy `--profile` path.
  assert.equal(store.resolveOperatorProfileHome('hermes'), null);
});

test('resolveOperatorProfileHome derives a missing operator identity from ace.db before falling through to --profile', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const fakeHome = path.join(root, 'fake-home');
  fs.mkdirSync(userDataPath, { recursive: true });
  // Stale/missing operator migration shape: the config does not list the
  // personal identity, but ace.db still has the authoritative row.
  fs.writeFileSync(
    path.join(userDataPath, 'operators.json'),
    JSON.stringify(
      {
        schema: 'ace.operators.v1',
        defaultOperatorId: 'hermes',
        operators: [
          {
            id: 'hermes',
            label: 'Hermes',
            agent: 'hermes',
            providerKind: 'builtin-personal',
            isControlPlane: true,
            autoStart: true,
            persona: null,
            workspaceDirName: 'personal-workspace',
            terminalDirName: 'personal-hermes',
          },
        ],
      },
      null,
      2
    )
  );

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const Database = require('better-sqlite3');
  const db = new Database(path.join(userDataPath, 'ace.db'));
  try {
    db.prepare(
      `INSERT INTO projects (id, name, path, is_personal, personal_identity, initialized, order_index, created_at, updated_at)
       VALUES ('prj-kt-missing', 'KingTest', ?, 1, 'kingtest', 1, 0, '2026-01-01', '2026-01-01')`
    ).run(path.join(root, 'kingtest-workspace'));
  } finally {
    db.close();
  }

  assert.equal(
    store.resolveOperatorProfileHome('kingtest'),
    path.join(userDataPath, 'hermes-home-prj-kt-missing')
  );
  assert.equal(store.resolveOperatorProfileHome('alice'), null);
});

test('resolveOperatorProfileHome never routes an unknown profile into the default operator home', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-resolve-profile-home-'));
  const userDataPath = path.join(root, 'user-data');
  const configuredHome = path.join(root, 'configured-home');
  const fakeHome = path.join(root, 'fake-home');
  fs.mkdirSync(configuredHome, { recursive: true });
  seedSessions(path.join(configuredHome, 'state.db'), 3);
  // Make the BUILTIN-PERSONAL operator the default: normalizeOperatorId falls
  // back to defaultOperatorId for unknown names, which must NOT cause an
  // ad-hoc profile ('alice') to resolve into the default identity's home — a
  // second backend writing that identity's state.db.
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, 'operators.json'),
    JSON.stringify({
      schema: 'ace.operators.v1',
      defaultOperatorId: 'kingtest',
      operators: [
        {
          id: 'kingtest',
          label: 'kingtest',
          agent: 'hermes',
          providerKind: 'builtin-personal',
          isControlPlane: true,
          autoStart: true,
          persona: null,
          hermesHome: configuredHome,
          workspaceDirName: 'kingtest-workspace',
          terminalDirName: 'kingtest-hermes',
        },
      ],
    }, null, 2)
  );

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const store = createAceStore(userDataPath);
  t.after(() => {
    process.env.HOME = realHome;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Exact-id profiles resolve; unknown names stay on `--profile`.
  assert.equal(store.resolveOperatorProfileHome('kingtest'), configuredHome);
  assert.equal(store.resolveOperatorProfileHome('alice'), null);
});

// ---- Session-rebind cross-attach fix (drives the REAL planResume seam) ------
// Regression cover for the HIGH-severity bug where claude tabs that share a
// project-root cwd got their sessions SHUFFLED on respawn. Each test boots the
// real store, points HOME at a temp dir so resolveSessionFile/findNewest scan
// there, and calls store._internals.planResume (the production planner).
const REBIND_A = '11111111-1111-4111-8111-111111111111';
const REBIND_C = '33333333-3333-4333-8333-333333333333';
const REBIND_O = '44444444-4444-4444-8444-444444444444';
const REBIND_S = '55555555-5555-4555-8555-555555555555';
const REBIND_S2 = '66666666-6666-4666-8666-666666666666';

function writeClaudeSession(homeDir: any, cwd: any, id: any, mtimeMs?: any) {
  const slug = String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
  const dir = path.join(homeDir, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, '{"x":1}\n');
  if (mtimeMs) { const d = new Date(mtimeMs); fs.utimesSync(file, d, d); }
  return file;
}

async function withRebindStore(fn: any) {
  const { store, repo, cleanup } = bootLaneStore({ withRepo: true });
  const prevHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-rebind-home-'));
  try {
    const { id: workspaceId } = await store.importWorkspace({ workspacePath: repo });
    const mk = async (name: string, agent = 'claude') => {
      const t = await store.createThread({ workspaceId, input: { name, agent, prompt: null, kind: 'cli' } });
      const streamId = `conversation:${t.conversationId}`;
      // Model a LIVE tab: the ambiguity gate counts agent_resume_state rows (a
      // tab is live/respawning whether or not its session_id is currently
      // bound), so a bare conversation row is not enough — a real racing tab
      // has a resume-state row that survives a mid-respawn session clear.
      store.getDb().prepare(
        'INSERT INTO agent_resume_state (stream_id, cols, rows, launch_intent, updated_at) VALUES (?, 80, 24, ?, ?)'
      ).run(streamId, 'interactive', new Date().toISOString());
      return { conversationId: t.conversationId, streamId };
    };
    const setSession = (conversationId: any, sessionId: any) =>
      store.getDb().prepare('UPDATE conversations SET session_id=? WHERE id=?').run(sessionId, conversationId);
    const seedHistory = (streamId: any, sessionId: any) =>
      store.getDb().prepare(
        'INSERT INTO stream_session_history (stream_id, provider, cwd, session_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(streamId, 'claude', repo, sessionId, 'bind', new Date().toISOString());
    const useHome = () => { process.env.HOME = tmpHome; };
    await fn({ store, repo, tmpHome, mk, setSession, seedHistory, useHome });
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    cleanup();
  }
}

test('planResume: a transient SSD stat error keeps the stored session (no rebind)', async () => {
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, useHome }: any) => {
    const me = await mk('me');
    setSession(me.conversationId, REBIND_S);
    // Make the slug PATH a FILE so statSync of <slug>/<id>.jsonl throws ENOTDIR
    // (a transient/non-ENOENT class) — the external-SSD false-missing scenario.
    const slug = String(repo).replace(/[^A-Za-z0-9_-]/g, '-');
    const projects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, slug), 'not a dir');
    useHome();
    const plan = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: me.streamId });
    assert.equal(plan.resumeMode, 'resume');
    assert.equal(plan.storedSessionId, REBIND_S); // kept the stored id, did NOT rebind
    const rows = store.getDb().prepare('SELECT reason FROM stream_session_history WHERE stream_id=?').all(me.streamId);
    assert.ok(rows.some((r: any) => r.reason === 'transient-error-kept-stored'), 'left a transient-keep audit row');
  });
});

test('planResume: a definitive ENOENT rebinds to this tab OWN history, not a newer sibling', async () => {
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, seedHistory, useHome }: any) => {
    const sib = await mk('sibling');
    const me = await mk('me');
    writeClaudeSession(tmpHome, repo, REBIND_A, Date.now());            // sibling's, newest
    writeClaudeSession(tmpHome, repo, REBIND_C, Date.now() - 60_000);   // mine, older
    setSession(sib.conversationId, REBIND_A);
    setSession(me.conversationId, REBIND_S); // stale, file is absent (ENOENT)
    seedHistory(me.streamId, REBIND_C);      // my OWN prior session for this cwd
    useHome();
    const plan = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: me.streamId });
    assert.equal(plan.resumeMode, 'resume');
    assert.equal(plan.storedSessionId, REBIND_C); // OWN history wins
    assert.notEqual(plan.storedSessionId, REBIND_A); // never the sibling's newest
    assert.equal(plan.reason, 'rebind-own-history');
  });
});

test('planResume: a stale lane sharing a cwd never steals a sibling live session or an orphan', async () => {
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, useHome }: any) => {
    const sib = await mk('sibling');
    const me = await mk('me');
    writeClaudeSession(tmpHome, repo, REBIND_A, Date.now() - 30_000); // sibling live
    writeClaudeSession(tmpHome, repo, REBIND_O, Date.now());          // orphan, newest, nobody's
    setSession(sib.conversationId, REBIND_A);
    setSession(me.conversationId, REBIND_S); // stale, absent; no own history
    useHome();
    const plan = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: me.streamId });
    assert.equal(plan.resumeMode, 'fresh'); // preferred fresh over stealing
    assert.notEqual(plan.storedSessionId, REBIND_A);
    assert.notEqual(plan.storedSessionId, REBIND_O);
    assert.equal(plan.reason, 'fresh-no-match');
  });
});

test('planResume: two tabs both stale in one cwd both go fresh (cannot collide)', async () => {
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, useHome }: any) => {
    const one = await mk('one');
    const two = await mk('two');
    writeClaudeSession(tmpHome, repo, REBIND_O, Date.now()); // one orphan on disk
    setSession(one.conversationId, REBIND_S);
    setSession(two.conversationId, REBIND_S2);
    useHome();
    const p1 = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: one.streamId });
    const p2 = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S2, cwd: repo, isRemote: false, streamId: two.streamId });
    assert.equal(p1.resumeMode, 'fresh');
    assert.equal(p2.resumeMode, 'fresh');
    // Neither grabbed the orphan, so they cannot land on the same session.
    assert.notEqual(p1.storedSessionId, REBIND_O);
    assert.notEqual(p2.storedSessionId, REBIND_O);
  });
});

test('planResume: a sibling cleared mid-respawn (session_id -> null) is still counted, so the other tab does NOT grab its orphan', async () => {
  // The exact production race: during respawn tab A's session_id is cleared to
  // null before its relaunch completes. If the ambiguity gate counted only
  // non-null tabs, tab B would see the cwd as unambiguous and rebind to A's
  // orphaned session — the cross-attach. A's live agent_resume_state row keeps
  // it counted, so B must prefer fresh.
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, useHome }: any) => {
    const a = await mk('A');
    const b = await mk('B');
    writeClaudeSession(tmpHome, repo, REBIND_A, Date.now()); // A's session, newest, on disk
    setSession(a.conversationId, null); // A cleared mid-respawn (production does this)
    setSession(b.conversationId, REBIND_S); // B stale, absent, no own history
    useHome();
    const plan = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: b.streamId });
    assert.equal(plan.resumeMode, 'fresh'); // did NOT grab A's orphan
    assert.notEqual(plan.storedSessionId, REBIND_A);
    assert.equal(plan.reason, 'fresh-no-match');
  });
});

test('planResume: a reservation stops a concurrent rebind from grabbing the same session', async () => {
  await withRebindStore(async ({ store, repo, tmpHome, mk, setSession, seedHistory, useHome }: any) => {
    const one = await mk('one');
    const two = await mk('two');
    writeClaudeSession(tmpHome, repo, REBIND_C, Date.now()); // the only real session on disk
    // Simulate the pre-persist race window: both tabs have C in their own
    // history and both are stale, so both WANT to rebind to C.
    seedHistory(one.streamId, REBIND_C);
    seedHistory(two.streamId, REBIND_C);
    setSession(one.conversationId, REBIND_S);
    setSession(two.conversationId, REBIND_S2);
    useHome();
    // First rebinds to C and RESERVES it (we deliberately do NOT persist).
    const p1 = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S, cwd: repo, isRemote: false, streamId: one.streamId });
    assert.equal(p1.storedSessionId, REBIND_C);
    // Second must NOT also grab C while it is reserved -> falls through to fresh.
    const p2 = store._internals.planResume({ agent: 'claude', sessionId: REBIND_S2, cwd: repo, isRemote: false, streamId: two.streamId });
    assert.equal(p2.resumeMode, 'fresh');
    assert.notEqual(p2.storedSessionId, REBIND_C);
  });
});

test('planResume: a brand-new tab (null session) starts fresh', async () => {
  await withRebindStore(async ({ store, repo, mk, useHome }: any) => {
    const me = await mk('new');
    useHome();
    const plan = store._internals.planResume({ agent: 'claude', sessionId: null, cwd: repo, isRemote: false, streamId: me.streamId });
    assert.equal(plan.resumeMode, 'fresh');
    assert.ok(plan.freshSessionId); // claude mints a fresh uuid for a new tab
    assert.equal(plan.reason, 'fresh-new-tab');
  });
});

test('createAceStore migrates a PRE-#93 stream_session_history table instead of crashing at boot', () => {
  // Reproduces the real dev.68 boot crash: an install whose ace.db already had
  // stream_session_history with the OLD shape (agent/recorded_at, no provider).
  // CREATE TABLE IF NOT EXISTS is a no-op against it, so the new prepares that
  // name `provider` threw at store construction — a hard boot crash on real data
  // a fresh-DB suite never sees. The migration must drop-and-recreate so boot
  // succeeds and the new schema is present.
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-sshmig-'));
  const dbPath = path.join(ud, 'ace.db');
  // Seed the OLD-schema table WITH a row, before the store ever opens the db.
  const seed = new BetterSqlite3NodeShim(dbPath);
  seed.exec(
    'CREATE TABLE stream_session_history (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT, agent TEXT, session_id TEXT, reason TEXT, recorded_at TEXT)'
  );
  seed.prepare(
    'INSERT INTO stream_session_history (stream_id, agent, session_id, reason, recorded_at) VALUES (?, ?, ?, ?, ?)'
  ).run('conversation:old', 'claude', 'sess-old', 'bind', '2026-07-01T00:00:00.000Z');
  seed.close();

  let store: any;
  assert.doesNotThrow(() => {
    store = createAceStore(ud, {
      Database: BetterSqlite3NodeShim,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });
  }, 'store must boot against a pre-#93 stream_session_history table');
  const cols = store.getDb().prepare('PRAGMA table_info(stream_session_history)').all().map((c: any) => c.name);
  assert.ok(cols.includes('provider'), 'migrated table has the provider column');
  assert.ok(cols.includes('cwd') && cols.includes('created_at'), 'migrated table has cwd + created_at');
  // The historical row must survive — never dropped — and be back-filled.
  const row: any = store.getDb().prepare("SELECT * FROM stream_session_history WHERE stream_id='conversation:old'").get();
  assert.ok(row, 'the pre-existing audit row is preserved, not dropped');
  assert.equal(row.provider, 'claude'); // back-filled from agent
  assert.equal(row.created_at, '2026-07-01T00:00:00.000Z'); // back-filled from recorded_at
  assert.equal(row.session_id, 'sess-old');
  try { store.shutdown(); } catch {}
  fs.rmSync(ud, { recursive: true, force: true });
});

test('createAceStore completes a PARTIALLY-migrated stream_session_history (provider added, cwd/created_at missing)', () => {
  // A crash after adding `provider` but before `cwd`/`created_at` left a partial
  // shape. An outer `!includes(provider)` gate would skip it forever and wedge
  // boot. Each column is checked independently, so this must still complete.
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-sshpart-'));
  const dbPath = path.join(ud, 'ace.db');
  const seed = new BetterSqlite3NodeShim(dbPath);
  seed.exec(
    'CREATE TABLE stream_session_history (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id TEXT, agent TEXT, session_id TEXT, reason TEXT, recorded_at TEXT, provider TEXT)'
  );
  seed.close();

  let store: any;
  assert.doesNotThrow(() => {
    store = createAceStore(ud, {
      Database: BetterSqlite3NodeShim,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });
  }, 'store must complete a partial migration and boot');
  const cols = store.getDb().prepare('PRAGMA table_info(stream_session_history)').all().map((c: any) => c.name);
  assert.ok(cols.includes('cwd') && cols.includes('created_at'), 'partial migration completed cwd + created_at');
  try { store.shutdown(); } catch {}
  fs.rmSync(ud, { recursive: true, force: true });
});

test('planResume: codex `seen` sentinel still starts fresh (unchanged)', async () => {
  await withRebindStore(async ({ store, repo, mk, useHome }: any) => {
    const me = await mk('codex-tab', 'codex');
    useHome();
    const plan = store._internals.planResume({ agent: 'codex', sessionId: 'seen', cwd: repo, isRemote: false, streamId: me.streamId });
    assert.equal(plan.resumeMode, 'fresh');
    assert.equal(plan.reason, 'fresh-seen-sentinel');
  });
});
