const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const RETIRED_MISSION_BEHAVIOR_TESTS = new Set([
  'mission ready calls the read-only board socket method with filters',
  'mission archive calls native archive socket method with dry-run summary flags',
  'mission create calls the native mission socket method with Rook controller context',
  'kanban materialize sends descriptor to packaged-safe mission materialize method',
  'mission dispatch prepares, spawns through visible task path, and attaches linkage',
  'mission dispatch preserves Codex xhigh effort in launch intent',
  'mission dispatch blocks before spawning when start audit proof is missing',
  'mission wave-dispatch --prepare-only returns the WaveManifest without spawning lanes',
  'mission wave-dispatch refuses lane fanout without explicit-wave opt-in',
  'mission wave-dispatch fans out 3 ready lanes through the visible task path then attaches the wave',
  'mission wave-dispatch writes child-registry rows with waveId/laneId so the wave-join gate can see lanes',
  'mission validate prepares, spawns visible high-effort chat validator, and attaches linkage',
  'mission dispatch --wave registers the lane in child-registry at dispatch (fire-and-forget)',
  'mission validate --wave refuses to launch validator against an empty registry',
  'mission validate --wave --expected-lane blocks while a required lane is missing',
  'mission validate --wave refuses to launch validator while a lane is nonterminal',
  'mission sync blocks before reading worker stream when sync audit proof is missing',
  'sync audit is satisfied by scoped screen + mission next from the same run',
  'mission sync parses DONE trailer and updates the attached feature',
  'mission sync consumes completion inbox before reading terminal stream',
  'mission sync records child completion without advancing mission lifecycle',
  'mission sync does not ack completion inbox before successful sync',
  'mission sync returns checkedSources when attachment recovery fails',
  'mission sync parses bullet-prefixed and plain DONE/BLOCKED trailers with prompt noise',
  'mission sync ignores non-final DONE text in the worker tail',
  'mission sync ignores stale DONE followed by substantive assistant text',
  'mission sync terminalizes child-registry row so mission validate --wave can launch',
  'mission validate --rerun preserves rerun intent through prepare and attach',
  'mission link-pr, fixback, attach-validator, release-gate, and integrate gate avoid merge side effects',
  'mission attach-validator forwards exact head and base evidence',
  'smoke mission-lifecycle verifies no-code lifecycle without product side effects',
  'smoke mission-lifecycle tolerates already validation-passed no-code card',
  'mission gate parses validator DONE trailer and records merge readiness without merging',
  'mission gate parses validator BLOCKED trailer and returns blocker evidence',
]);

function test(name: string, optionsOrFn: any, maybeFn?: any) {
  if (RETIRED_MISSION_BEHAVIOR_TESTS.has(name)) {
    return nodeTest(name, { skip: 'mission/smoke command surface is archived in Ace v0.2.0' }, () => {});
  }
  return maybeFn === undefined ? nodeTest(name, optionsOrFn) : nodeTest(name, optionsOrFn, maybeFn);
}

const CLI_ENTRY = path.join(__dirname, '..', 'index.cts');
const NODE_WITH_TSX = ['--require', 'tsx/cjs'];
const NODE_WITH_TSX_ABS = ['--require', require.resolve('tsx/cjs')];
const { resolveSocketPath } = require('../client.cts');
let testEnvSeq = 0;

function withProcessEnv(next: any, fn: any) {
  const saved: any = {};
  const keys = Object.keys(next);
  for (const key of keys) saved[key] = process.env[key];
  try {
    for (const key of keys) {
      if (next[key] === undefined) delete process.env[key];
      else process.env[key] = next[key];
    }
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function isolatedCliEnv(env: any = {}, args: any[] = []) {
  const next: any = { ...process.env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('ACE_')) delete next[key];
  }
  Object.assign(next, env);
  if (!next.ACE_USER_DATA_TAG) {
    testEnvSeq += 1;
    next.ACE_USER_DATA_TAG = `cli-test-${process.pid}-${testEnvSeq}`;
  }
  if (next.ACE_TEST_AUDIT_PROOF !== '0') seedAuditProof(next.ACE_USER_DATA_TAG, args);
  delete next.ACE_TEST_AUDIT_PROOF;
  return next;
}

function seedAuditProof(userDataTag: string, args: any[] = []) {
  const command = args[0] === 'mission' && args[1] ? `mission ${args[1]}` : '';
  const proof: any = {
    'mission dispatch': [
      ['start', 'tool heartbeat'],
      ['start', 'tool manifest'],
      ['start', 'context'],
      ['start', 'mission board'],
      ['start', 'ls'],
      ['dispatch', 'mission board'],
    ],
    'mission wave-dispatch': [
      ['start', 'tool heartbeat'],
      ['start', 'tool manifest'],
      ['start', 'context'],
      ['start', 'mission board'],
      ['start', 'ls'],
      ['dispatch', 'mission board'],
    ],
    'mission sync': [['sync', 'task result']],
    'mission validate': [['validate', 'mission sync']],
    'mission gate': [['gate', 'mission validate']],
  }[command];
  if (!proof) return;
  const safeTag = String(userDataTag).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'default';
  const ledgerPath = path.join(os.tmpdir(), 'ace-tool-ledger', safeTag, 'tool-usage.ndjson');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  for (const [phase, proofCommand] of proof) {
    fs.appendFileSync(ledgerPath, JSON.stringify({
      schema: 'ace.tool_use.v1',
      at: new Date().toISOString(),
      command: proofCommand,
      role: 'orchestrator',
      phase,
      ok: true,
    }) + '\n');
  }
}

function emptyWorkspaceLookup(req: any) {
  if (req.method === 'getState') return { workspaces: [] };
  if (req.method === 'streamTrackedGithubProjects') return { projects: [] };
  return null;
}

function run(args: any, env = {}) {
  return spawnSync('node', [...NODE_WITH_TSX, CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: isolatedCliEnv(env, args),
    timeout: 8000,
  });
}

function currentGitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '..', '..', '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function runAsync(args: any, env = {}, options: any = {}) {
  return new Promise((resolve: any, reject: any) => {
    const child = spawn('node', [...NODE_WITH_TSX_ABS, CLI_ENTRY, ...args], {
      env: isolatedCliEnv(env, args),
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 8000);

    child.stdout.on('data', (chunk: any) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: any) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: any) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: any, signal: any) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : code,
        signal: timedOut ? (signal || 'SIGTERM') : signal,
        stdout,
        stderr,
      });
    });
  });
}

function parseLine(stream: any) {
  const trimmed = stream.trim();
  if (!trimmed) throw new Error('empty stream');
  const firstNl = trimmed.indexOf('\n');
  const line = firstNl >= 0 ? trimmed.slice(0, firstNl) : trimmed;
  return JSON.parse(line);
}

function writeFakeGh(binDir: any, logPath: any, body: any) {
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');`,
      body,
    ].join('\n'),
    { mode: 0o755 }
  );
  return ghPath;
}

async function withSocketServer(handler: any, runClient: any) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cli-'));
  const sockPath = path.join(tmp, 'ace-test.sock');
  const server = net.createServer((socket: any) => {
    let buf = '';
    socket.on('data', (chunk: any) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        try {
          const result = handler(req);
          socket.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
        } catch (err: any) {
          socket.write(JSON.stringify({
            id: req.id,
            ok: false,
            error: err?.message || String(err),
            applicationCode: err?.applicationCode,
          }) + '\n');
        }
      }
    });
  });

  await new Promise((resolve: any, reject: any) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });

  try {
    return await runClient(sockPath);
  } finally {
    await new Promise((resolve: any) => server.close(() => resolve()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

test('describe: emits valid JSON envelope listing every command', () => {
  const r = run(['describe']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.data.commands));
  assert.ok(env.data.commands.length >= 25);
  assert.ok(env.data.exitCodes['0']);
  assert.ok(env.data.transport.socket);
  assert.equal(typeof env.data.version, 'string');
});

test('integrate context-import preview forwards the exact explicit socket payload', async () => {
  const requests: any[] = [];
  const result: any = await withSocketServer(
    (req: any) => {
      requests.push(req);
      return { mode: 'preview', digest: 'a'.repeat(64) };
    },
    (sockPath: string) => runAsync([
      '--json',
      'integrate',
      'context-import',
      '--workspace', 'prj_1',
      '--repo', '/canonical/repo',
      '--worktree', '/canonical/wt',
      '--branch', 'feat/import',
      '--head-sha', '1'.repeat(40),
      '--base-branch', 'main',
      '--base-sha', '2'.repeat(40),
      '--allow-path', 'src/a.ts',
      '--allow-path', 'test/a.test.ts',
      '--request-id', 'req-1',
      '--preview',
    ], { ACE_SOCK: sockPath })
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'integrationContextImport');
  assert.deepEqual(requests[0].params, {
    workspaceId: 'prj_1',
    repoPath: '/canonical/repo',
    worktreePath: '/canonical/wt',
    branch: 'feat/import',
    headSha: '1'.repeat(40),
    baseBranch: 'main',
    baseSha: '2'.repeat(40),
    allowedPaths: ['src/a.ts', 'test/a.test.ts'],
    requestId: 'req-1',
    mode: 'preview',
    digest: null,
  });
});

test('integrate context-import apply forwards the preview digest', async () => {
  const requests: any[] = [];
  const digest = 'a'.repeat(64);
  const result: any = await withSocketServer(
    (req: any) => {
      requests.push(req);
      return { mode: 'apply', digest, taskId: 'tsk_1' };
    },
    (sockPath: string) => runAsync([
      '--json',
      'integrate',
      'context-import',
      '--workspace', 'prj_1',
      '--repo', '/canonical/repo',
      '--worktree', '/canonical/wt',
      '--branch', 'feat/import',
      '--head-sha', '1'.repeat(40),
      '--base-branch', 'main',
      '--base-sha', '2'.repeat(40),
      '--allow-path', 'src/a.ts',
      '--request-id', 'req-1',
      '--apply',
      '--digest', digest,
    ], { ACE_SOCK: sockPath })
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'integrationContextImport');
  assert.equal(requests[0].params.mode, 'apply');
  assert.equal(requests[0].params.digest, digest);
});

test('integrate context-import keeps application codes separate from transport codes', async () => {
  const common = [
    '--workspace', 'prj_1',
    '--repo', '/canonical/repo',
    '--worktree', '/canonical/wt',
    '--branch', 'feat/import',
    '--head-sha', '1'.repeat(40),
    '--base-branch', 'main',
    '--base-sha', '2'.repeat(40),
    '--allow-path', 'src/a.ts',
    '--request-id', 'req-1',
  ];
  for (const entry of [
    { code: 'dirty_worktree', args: ['--preview'] },
    { code: 'digest_mismatch', args: ['--apply', '--digest', 'a'.repeat(64)] },
    { code: 'NOT_FOUND', args: ['--preview'] },
    { code: 'TIMEOUT', args: ['--preview'] },
    { code: 'SOCKET_UNREACHABLE', args: ['--preview'] },
  ]) {
    const result: any = await withSocketServer(
      () => {
        const error: any = new Error(`context import failed: ${entry.code}`);
        error.code = entry.code;
        error.applicationCode = entry.code;
        throw error;
      },
      (sockPath: string) => runAsync(
        ['--json', 'integrate', 'context-import', ...common, ...entry.args],
        { ACE_SOCK: sockPath },
      ),
    );
    assert.equal(result.status, 5, result.stderr);
    const envelope = parseLine(result.stderr);
    assert.equal(envelope.error, entry.code);
    assert.match(envelope.message, new RegExp(entry.code));
  }
});

test('integrate context-import does not expose an untagged internal error code', async () => {
  const result: any = await withSocketServer(
    () => {
      const error: any = new Error('database operation failed');
      error.code = 'SQLITE_BUSY';
      throw error;
    },
    (sockPath: string) => runAsync([
      '--json',
      'integrate',
      'context-import',
      '--workspace', 'prj_1',
      '--repo', '/canonical/repo',
      '--worktree', '/canonical/wt',
      '--branch', 'feat/import',
      '--head-sha', '1'.repeat(40),
      '--base-branch', 'main',
      '--base-sha', '2'.repeat(40),
      '--allow-path', 'src/a.ts',
      '--request-id', 'req-1',
      '--preview',
    ], { ACE_SOCK: sockPath }),
  );
  assert.equal(result.status, 5, result.stderr);
  const envelope = parseLine(result.stderr);
  assert.equal(envelope.error, 'server_error');
  assert.notEqual(envelope.error, 'SQLITE_BUSY');
});

test('integrate context-import rejects invalid mode and digest combinations before transport', () => {
  const common = [
    '--workspace', 'prj_1',
    '--repo', '/canonical/repo',
    '--worktree', '/canonical/wt',
    '--branch', 'feat/import',
    '--head-sha', '1'.repeat(40),
    '--base-branch', 'main',
    '--base-sha', '2'.repeat(40),
    '--allow-path', 'src/a.ts',
    '--request-id', 'req-1',
  ];
  const cases = [
    { args: [], error: 'invalid_mode' },
    { args: ['--preview', '--apply', '--digest', 'a'.repeat(64)], error: 'invalid_mode' },
    { args: ['--apply'], error: 'missing_arg' },
    { args: ['--preview', '--digest', 'a'.repeat(64)], error: 'invalid_arg' },
  ];
  for (const entry of cases) {
    const result = run(['--json', 'integrate', 'context-import', ...common, ...entry.args]);
    assert.equal(result.status, 2, `stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(parseLine(result.stderr).error, entry.error);
  }
});

test('integrate context-import requires at least one literal allowed path', () => {
  const result = run([
    '--json',
    'integrate',
    'context-import',
    '--workspace', 'prj_1',
    '--repo', '/canonical/repo',
    '--worktree', '/canonical/wt',
    '--branch', 'feat/import',
    '--head-sha', '1'.repeat(40),
    '--base-branch', 'main',
    '--base-sha', '2'.repeat(40),
    '--request-id', 'req-1',
    '--preview',
  ]);
  assert.equal(result.status, 2, `stdout=${result.stdout}; stderr=${result.stderr}`);
  const error = parseLine(result.stderr);
  assert.equal(error.error, 'missing_arg');
  assert.equal(error.details.flag, '--allow-path');
});

test('socket discovery checks an explicitly configured external root', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cli-external-sock-'));
  const runtimeDir = path.join(tmp, 'runtime');
  const externalRoot = path.join(tmp, 'AceData');
  const externalTmp = path.join(externalRoot, 'tmp');
  const sockPath = path.join(externalTmp, 'ace.AceData.sock');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(externalTmp, { recursive: true });
  fs.writeFileSync(sockPath, '');

  try {
    const resolved = withProcessEnv(
      {
        ACE_SOCK: undefined,
        ACE_USER_DATA_TAG: undefined,
        ACE_DATA_ROOT: undefined,
        ACE_EXTERNAL_DATA_ROOT: externalRoot,
        XDG_RUNTIME_DIR: runtimeDir,
      },
      () => resolveSocketPath()
    );
    assert.equal(resolved, sockPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('JSON output exits cleanly when downstream closes early', async () => {
  const child = spawn('node', [...NODE_WITH_TSX_ABS, CLI_ENTRY, '--json', 'describe'], {
    env: isolatedCliEnv({}, ['--json', 'describe']),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk: any) => {
    stderr += chunk.toString('utf8');
  });
  const status: any = await new Promise((resolve: any) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: null, signal: 'SIGTERM' });
    }, 8000);
    child.on('close', (code: any, signal: any) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.notEqual(status.signal, 'SIGTERM', `CLI hung after EPIPE; stderr=${stderr}`);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/);
});

function assertUnknownCommandResult(result: any, expectedName: string) {
  assert.equal(result.status, 6, `stdout=${result.stdout}; stderr=${result.stderr}`);
  const err = parseLine(result.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error, 'unknown_command');
  assert.equal(err.details.name, expectedName);
}

test('describe omits archived native mission board commands', () => {
  const r = run(['describe']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const names = parseLine(r.stdout).data.commands.map((c: any) => c.cli);
  assert.deepEqual(names.filter((name: string) => name.startsWith('mission ')), []);
  assert.equal(names.includes('smoke mission-lifecycle'), false);
  assert.ok(names.includes('smoke fast-lifecycle'));
});

test('describe mission wave-dispatch: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission wave-dispatch']);
  assertUnknownCommandResult(r, 'mission wave-dispatch');
});

test('describe ls: returns the ls registry entry', () => {
  const r = run(['describe', 'ls']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'ls');
  assert.equal(env.data.ipcMethod, 'streamList');
});

test('workspace create --dry-run resolves path without creating or contacting Ace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-create-'));
  const target = path.join(root, 'new-workspace');
  const r = run(['workspace', 'create', '--path', target, '--init-git', '--dry-run']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.path, target);
  assert.equal(env.data.dryRun, true);
  assert.equal(env.data.wouldCreateDirectory, true);
  assert.equal(env.data.wouldInitialize, true);
  assert.equal(fs.existsSync(target), false);
});

test('workspace create creates directory, imports workspace, and optionally initializes git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-create-'));
  const target = path.join(root, 'new-workspace');
  const requests: any[] = [];
  await withSocketServer((req: any) => {
    requests.push(req);
    if (req.method === 'importWorkspace') {
      assert.equal(req.params.workspacePath, target);
      assert.equal(fs.existsSync(target), true);
      return { id: 'prj_new' };
    }
    if (req.method === 'initializeWorkspace') return { ok: true };
    if (req.method === 'refreshWorkspace') return { ok: true };
    throw new Error(`unexpected method ${req.method}`);
  }, async (sockPath: string) => {
    const r: any = await runAsync(['workspace', 'create', '--path', target, '--init-git'], { ACE_SOCK: sockPath });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const env = parseLine(r.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.data.workspaceId, 'prj_new');
    assert.equal(env.data.path, target);
    assert.equal(env.data.createdDirectory, true);
    assert.equal(env.data.initialized, true);
  });
  assert.deepEqual(requests.map((req) => req.method), ['importWorkspace', 'initializeWorkspace', 'refreshWorkspace']);
});

test('workspace base-branch supports --set origin/main and --clear/--unset', async () => {
  const requests: any[] = [];
  const runBase = (args: any[]) => withSocketServer((req: any) => {
    requests.push(req);
    if (req.method === 'projectsSetBaseBranch') {
      return {
        projectId: req.params.projectId,
        preferredBaseBranch: req.params.clear ? null : req.params.branch,
        defaultBranch: 'origin/main',
        effectiveBaseBranch: req.params.clear ? 'origin/main' : req.params.branch,
      };
    }
    throw new Error(`unexpected method ${req.method}`);
  }, (sockPath: string) => runAsync(
    ['--json', 'workspace', 'base-branch', '--workspace', 'prj_42', ...args],
    { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '' }
  ));

  let r: any = await runBase(['--set', 'origin/main']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(requests.pop().params, { projectId: 'prj_42', branch: 'origin/main' });
  assert.equal(parseLine(r.stdout).data.effectiveBaseBranch, 'origin/main');

  r = await runBase(['--clear']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(requests.pop().params, { projectId: 'prj_42', clear: true });
  assert.equal(parseLine(r.stdout).data.preferredBaseBranch, null);

  r = await runBase(['--unset']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(requests.pop().params, { projectId: 'prj_42', clear: true });
});

test('describe exposes tool contract and Clawpatch validation commands', () => {
  const r = run(['describe']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const names = parseLine(r.stdout).data.commands.map((c: any) => c.cli);
  for (const name of ['tool manifest', 'tool heartbeat', 'tool audit', 'tool batch', 'validation clawpatch', 'mcp-core', 'control-plane status', 'smoke fast-lifecycle']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.equal(names.includes('smoke mission-lifecycle'), false);

  const manifest = run(['describe', 'tool manifest']);
  assert.equal(manifest.status, 0, `stderr=${manifest.stderr}`);
  assert.equal(parseLine(manifest.stdout).data.ipcMethod, 'special:toolManifest');
});

test('validation clawpatch records the checked-out commit as its validated head', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-clawpatch-head-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-clawpatch-bin-'));
  try {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    assert.equal(git('init', '--initial-branch=main').status, 0);
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# fixture\n');
    assert.equal(git('add', 'README.md').status, 0);
    assert.equal(git('-c', 'user.name=Ace Test', '-c', 'user.email=ace@example.com', 'commit', '-m', 'fixture').status, 0);
    const headSha = git('rev-parse', 'HEAD').stdout.trim();

    const clawpatch = path.join(binDir, 'clawpatch');
    fs.writeFileSync(clawpatch, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(clawpatch, 0o755);
    const result = run(
      ['--json', 'validation', 'clawpatch', '--project-dir', projectDir, '--required'],
      { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    );
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const artifact = parseLine(result.stdout).data;
    assert.equal(artifact.validatedHeadSha, headSha);
    assert.equal(JSON.parse(fs.readFileSync(artifact.artifactPath, 'utf8')).validatedHeadSha, headSha);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('tool manifest, heartbeat, and audit operate on a local project ledger', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-cli-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });

  const manifest = run(['tool', 'manifest', '--role', 'orchestrator', '--phase', 'start', '--compact', '--project-dir', projectDir]);
  assert.equal(manifest.status, 0, `stderr=${manifest.stderr}`);
  const manifestEnv = parseLine(manifest.stdout);
  assert.equal(manifestEnv.ok, true);
  assert.ok(manifestEnv.data.required.includes('run board|run list'));
  assert.equal(manifestEnv.data.required.includes('mission board|mission ready'), false);

  const heartbeat = run(['tool', 'heartbeat', '--role', 'orchestrator', '--phase', 'start', '--workspace', 'prj_42', '--project-dir', projectDir]);
  assert.equal(heartbeat.status, 0, `stderr=${heartbeat.stderr}`);
  assert.equal(parseLine(heartbeat.stdout).data.written, true);

  const audit = run(['tool', 'audit', '--role', 'orchestrator', '--phase', 'start', '--workspace', 'prj_42', '--project-dir', projectDir]);
  assert.equal(audit.status, 0, `stderr=${audit.stderr}`);
  const auditEnv = parseLine(audit.stdout);
  assert.equal(auditEnv.ok, true);
  assert.equal(auditEnv.data.ok, false);
  assert.ok(auditEnv.data.missingRequiredEvents.includes('context'));
});

test('tool startup commands infer top-level Ace session scope', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-inferred-scope-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const env = {
    ACE_WORKSPACE_ID: 'prj_inferred',
    ACE_STREAM_ID: 'variant:var_inferred',
    ACE_REPO_ROOT: projectDir,
  };

  try {
    const manifest = run([
      'tool', 'manifest', '--compact', '--project-dir', projectDir,
    ], env);
    assert.equal(manifest.status, 0, `stderr=${manifest.stderr}`);
    const manifestData = parseLine(manifest.stdout).data;
    assert.equal(manifestData.role, 'orchestrator');
    assert.equal(manifestData.phase, 'start');
    assert.ok(manifestData.required.includes('tool heartbeat'));

    const heartbeat = run([
      'tool', 'heartbeat', '--project-dir', projectDir,
    ], env);
    assert.equal(heartbeat.status, 0, `stderr=${heartbeat.stderr}`);
    const heartbeatData = parseLine(heartbeat.stdout).data;
    assert.equal(heartbeatData.event.role, 'orchestrator');
    assert.equal(heartbeatData.event.phase, 'start');
    assert.equal(heartbeatData.event.workspaceId, 'prj_inferred');
    assert.equal(heartbeatData.event.streamId, 'variant:var_inferred');

    const audit = run([
      'tool', 'audit', '--project-dir', projectDir,
    ], env);
    assert.equal(audit.status, 0, `stderr=${audit.stderr}`);
    const auditData = parseLine(audit.stdout).data;
    assert.equal(auditData.role, 'orchestrator');
    assert.equal(auditData.phase, 'start');
    assert.ok(auditData.missingRequiredEvents.includes('context'));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('wait accepts --busy as a named-state shortcut', async () => {
  const result: any = await withSocketServer((req: any) => {
    assert.equal(req.method, 'streamWaitFor');
    assert.equal(req.params.streamId, 'variant:var_busy');
    assert.deepEqual(req.params.predicate, { state: 'busy' });
    return { matched: 'busy', elapsedMs: 1 };
  }, (sockPath: string) => runAsync([
    '--json', 'wait', 'variant:var_busy', '--busy', '--timeout', '120000',
  ], { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '' }));

  assert.equal(result.status, 0, `stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.equal(parseLine(result.stdout).data.matched, 'busy');
});

test('tool batch runs independent read commands, writes one ledger event, and audit recognizes children', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-batch-cli-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const inputPath = path.join(projectDir, 'batch.json');
  fs.writeFileSync(inputPath, JSON.stringify({
    schema: 'ace.tool_batch.v1',
    runId: 'run_batch_42',
    role: 'orchestrator',
    phase: 'start',
    workspaceId: 'prj_42',
    calls: [
      { id: 'heartbeat', command: 'tool heartbeat', args: { role: 'orchestrator', phase: 'start' } },
      { id: 'manifest', command: 'tool manifest', args: { role: 'orchestrator', phase: 'start', compact: true } },
      { id: 'context', command: 'context', args: { stream: 'conversation:1' } },
      { id: 'board', command: 'run board', args: {} },
      { id: 'streams', command: 'ls', args: {} },
    ],
    dependencies: [],
  }));
  const seen: any[] = [];
  const r: any = await withSocketServer((req: any) => {
    seen.push(req.method);
    if (req.method === 'streamGetContext') return { streamId: req.params.streamId, workspaceId: 'prj_42' };
    if (req.method === 'runBoard') return { columns: {}, cards: [], counts: {} };
    if (req.method === 'streamList') return { streams: [{ streamId: 'conversation:1' }] };
    return {};
  }, (sockPath: string) => runAsync([
    '--json',
    'tool',
    'batch',
    '--input',
    inputPath,
    '--parallel',
    '--max-concurrency',
    '4',
	    '--project-dir',
	    projectDir,
	    '--run',
	    'run_cli_42',
	  ], { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '' }));

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.schema, 'ace.tool_batch_result.v1');
  assert.equal(env.data.parallel, true);
  assert.equal(env.data.results.length, 5);
  assert.ok(env.data.results.every((result: any) => result.ok === true));
  assert.deepEqual(new Set(seen), new Set(['streamGetContext', 'runBoard', 'streamList']));

  const ledger = fs.readFileSync(path.join(projectDir, '.ace', 'tool-usage.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
	  assert.equal(ledger.length, 1);
	  assert.equal(ledger[0].schema, 'ace.tool_batch_result.v1');
	  assert.equal(ledger[0].runId, 'run_batch_42');
	  assert.ok(ledger[0].results.every((result: any) => result.runId === 'run_batch_42'));

	  const audit = run(['tool', 'audit', '--role', 'orchestrator', '--phase', 'start', '--workspace', 'prj_42', '--run', 'run_batch_42', '--project-dir', projectDir]);
	  assert.equal(audit.status, 0, `stderr=${audit.stderr}`);
	  assert.equal(parseLine(audit.stdout).data.ok, true);
	  const wrongRunAudit = run(['tool', 'audit', '--role', 'orchestrator', '--phase', 'start', '--workspace', 'prj_42', '--run', 'run_other', '--project-dir', projectDir]);
	  assert.equal(wrongRunAudit.status, 0, `stderr=${wrongRunAudit.stderr}`);
	  assert.equal(parseLine(wrongRunAudit.stdout).data.ok, false);
	});

test('tool audit resolves workspace repo ledger outside caller cwd', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-audit-workspace-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const ledgerPath = path.join(projectDir, '.ace', 'tool-usage.ndjson');
  for (const command of ['tool heartbeat', 'tool manifest', 'context', 'run board', 'ls']) {
    fs.appendFileSync(ledgerPath, JSON.stringify({
      schema: 'ace.tool_use.v1',
      at: new Date().toISOString(),
      command,
      role: 'orchestrator',
      phase: 'start',
      workspaceId: 'prj_42',
      runId: 'smoke_123',
      ok: true,
    }) + '\n');
  }
  const r: any = await withSocketServer((req: any) => {
    if (req.method === 'getState') return { workspaces: [{ id: 'prj_42', path: projectDir }] };
    if (req.method === 'streamTrackedGithubProjects') return { projects: [{ workspaceId: 'prj_42', workspacePath: projectDir }] };
    throw new Error(`unexpected method ${req.method}`);
  }, (sockPath: string) => runAsync([
    '--json',
    'tool',
    'audit',
    '--role',
    'orchestrator',
    '--phase',
    'start',
    '--workspace',
    'prj_42',
    '--run',
    'smoke_123',
  ], { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '', ACE_TEST_AUDIT_PROOF: '0' }, { cwd: os.tmpdir() }));

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.ok, true);
  assert.equal(data.runId, 'smoke_123');
  assert.equal(data.ledgerPath, ledgerPath);
});

test('tool batch records failed child calls without hiding the failure', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-batch-fail-cli-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const inputPath = path.join(projectDir, 'batch.json');
  fs.writeFileSync(inputPath, JSON.stringify({
    schema: 'ace.tool_batch.v1',
    role: 'orchestrator',
    phase: 'start',
    calls: [
      { id: 'state', command: 'state', args: {} },
      { id: 'streams', command: 'ls', args: {} },
    ],
  }));
  const r: any = await withSocketServer((req: any) => {
    if (req.method === 'streamList') return { streams: [] };
    return {};
  }, (sockPath: string) => runAsync([
    '--json',
    'tool',
    'batch',
    '--input',
    inputPath,
    '--parallel',
    '--project-dir',
    projectDir,
  ], { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '', ACE_STREAM_ID: '' }));
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  const failed = data.results.find((result: any) => result.id === 'state');
  assert.equal(failed.ok, false);
  assert.equal(failed.isError, true);
  assert.match(failed.summary, /requires args\.stream/);
  assert.equal(data.results.find((result: any) => result.id === 'streams').ok, true);
});

test('tool batch rejects unsafe commands before opening transport', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-batch-unsafe-cli-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const inputPath = path.join(projectDir, 'batch.json');
  fs.writeFileSync(inputPath, JSON.stringify({
    schema: 'ace.tool_batch.v1',
    role: 'orchestrator',
    phase: 'gate',
    calls: [
      { id: 'bad', command: 'integrate pr-merge', args: { task: 'task_1' } },
    ],
  }));
  const r = run(['--json', 'tool', 'batch', '--input', inputPath, '--project-dir', projectDir], {
    ACE_SOCK: '/tmp/ace-no-socket-for-batch-unsafe.sock',
  });
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'invalid_batch');
  assert.match(err.message, /unsafe command|unallowed command/);
});

test('describe nonexistent: exits 6 with unknown_command error', () => {
  const r = run(['describe', 'nonexistent-thing']);
  assert.equal(r.status, 6);
  const err = parseLine(r.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.code, 6);
  assert.equal(err.error, 'unknown_command');
});

test('describe mission ls: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission ls']);
  assert.equal(r.status, 6);
  const err = parseLine(r.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error, 'unknown_command');
});

test('describe mission board: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission board']);
  assertUnknownCommandResult(r, 'mission board');
});

test('mission checkpoint and resume are archived unknown commands', async () => {
  const checkpoint = await runAsync([
    '--json',
    'mission',
    'checkpoint',
    '--workspace',
    'prj_42',
    '--mission',
    'msn_42',
  ]);
  assertUnknownCommandResult(checkpoint, 'mission');

  const resume = await runAsync([
    '--json',
    'mission',
    'resume',
    '--workspace',
    'prj_42',
    '--mission',
    'msn_42',
  ]);
  assertUnknownCommandResult(resume, 'mission');
});

test('describe mission create: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission create']);
  assertUnknownCommandResult(r, 'mission create');
});

test('describe browser: returns the task-scoped browser command group', () => {
  const r = run(['describe', 'browser']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'browser');
  assert.equal(env.data.ipcMethod, 'special:browser');
  assert.ok(env.data.flags.some((f: any) => f.name === '--task'));
});

test('describe mission dispatch: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission dispatch']);
  assertUnknownCommandResult(r, 'mission dispatch');
});

test('describe mission validate: exits 6 because Missions are archived', () => {
  const r = run(['describe', 'mission validate']);
  assertUnknownCommandResult(r, 'mission validate');
});

test('describe joins unquoted multi-word command names', () => {
  const r = run(['describe', 'task', 'validate']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'task validate');
  assert.equal(env.data.ipcMethod, 'special:taskValidate');
});

test('ls --help: exits 0 and prints flags / exit codes block', () => {
  const r = run(['ls', '--help']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /ace ls/);
  assert.match(r.stdout, /Exit codes:/);
});

test('ask --bogus-flag: exits 2 with unknown_flag error', () => {
  const r = run(['ask', '--bogus-flag', 'x', 'y']);
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'unknown_flag');
  assert.equal(err.details.flag, '--bogus-flag');
});

test('ask with no positionals: exits 2 with missing_arg', () => {
  const r = run(['ask']);
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'missing_arg');
});

test('ACE_SOCK pointed at a missing path: exits 3 transport_failed', () => {
  const r = run(['ls'], {
    ACE_SOCK: '/tmp/ace-nonexistent-test.sock',
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_TIMEOUT_MS: '4000',
  });
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'transport_failed');
});

test('describe --markdown: exits 0 with markdown body', () => {
  const r = run(['describe', '--markdown']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /^# ace v/);
  assert.match(r.stdout, /## Commands/);
  assert.match(r.stdout, /ace ls/);
  assert.match(r.stdout, /ace --json run closeout --run run-7 --dry-run/);
  assert.match(r.stdout, /ace --json smoke fast-lifecycle --workspace prj_42 --no-code/);
  assert.doesNotMatch(r.stdout, /ace (?:--json )?mission\b/);
  assert.doesNotMatch(r.stdout, /ace (?:--json )?smoke mission-lifecycle\b/);
});

test('--help on a command with --json returns the registry entry as JSON', () => {
  const r = run(['ls', '--help', '--json']);
  assert.equal(r.status, 0);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'ls');
});

test('top-level help: exits 0 with command list', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ace v/);
  assert.match(r.stdout, /describe/);
});

test('--version: prints build identity without opening a socket', () => {
  const r = run(['--version'], {
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_SOCK: '/tmp/ace-no-socket-version.sock',
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /ace v\d/);
  assert.match(r.stdout, /Node: v/);
  assert.match(r.stdout, /Platform: /);
});

test('version --json: returns structured payload without socket', () => {
  const r = run(['version', '--json'], {
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_SOCK: '/tmp/ace-no-socket-version-json.sock',
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(typeof env.data.cliVersion, 'string');
  assert.equal(typeof env.data.node, 'string');
  assert.equal(typeof env.data.platform, 'string');
  assert.ok(env.data.schema === 'ace.cli.version.v1');
});

test('version (no flag): prints human-readable identity', () => {
  const r = run(['version'], {
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_SOCK: '/tmp/ace-no-socket-version-bare.sock',
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /ace v\d/);
  assert.match(r.stdout, /Node: v/);
});

test('send --mode=invalid: exits 2 with invalid_choice', () => {
  const r = run(['send', 'conversation:x', 'hi', '--mode=garbage']);
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'invalid_choice');
});

test('task run --json failures emit a single ok:false stdout envelope', () => {
  const r = run(['--json', 'task', 'run', 'codex', '--stream', 'conversation:abc'], {
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_SOCK: '',
  });
  assert.equal(r.status, 2, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'missing_arg');
  assert.equal(env.details.command, 'task run');
});

test('ask and send pass caller communication metadata from env', async () => {
  const requests: any[] = [];
  const env = {
    ACE_URL: '',
    ACE_TOKEN: '',
    ACE_STREAM_ID: 'conversation:rook',
    ACE_PERSONAL_IDENTITY: 'Rook',
    ACE_AGENT: 'hermes',
    ACE_TASK_ID: 'tsk_rook',
  };
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'streamAsk') {
        return { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' };
      }
      if (req.method === 'streamSendInput') return { ok: true };
      throw new Error(`unexpected method ${req.method}`);
    },
    async (sockPath: any) => {
      const ask = await runAsync(['ask', 'conversation:worker', 'hello'], {
        ...env,
        ACE_SOCK: sockPath,
      });
      const send = await runAsync(['send', 'conversation:worker', 'hello'], {
        ...env,
        ACE_SOCK: sockPath,
      });
      return { ask, send };
    }
  );

  assert.equal(r.ask.status, 0, `stdout=${r.ask.stdout}; stderr=${r.ask.stderr}`);
  assert.equal(r.send.status, 0, `stdout=${r.send.stdout}; stderr=${r.send.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), ['streamAsk', 'streamSendInput']);
  for (const req of requests) {
    assert.equal(req.params.caller.streamId, 'conversation:rook');
    assert.equal(req.params.caller.identity, 'Rook');
    assert.equal(req.params.caller.agent, 'hermes');
    assert.equal(req.params.caller.taskId, 'tsk_rook');
  }
  assert.equal(requests[0].params.caller.command, 'ask');
  assert.equal(requests[1].params.caller.command, 'send');
});

test('keys --repeat=NaN: exits 2 with invalid_number', () => {
  const r = run(['keys', 'conversation:x', 'Enter', '--repeat=banana']);
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'invalid_number');
});

test('spawn missing required --task: exits 2 missing_arg', () => {
  const r = run(['spawn', 'claude']);
  assert.equal(r.status, 2);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'missing_arg');
});

test('task run --help: per-subcommand help works', () => {
  const r = run(['task', 'run', '--help']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /ace task run/);
  assert.match(r.stdout, /--workspace/);
});

test('command help stays in parity with describe metadata for orchestration commands', () => {
  for (const cli of ['task run', 'relay']) {
    const described = run(['describe', cli]);
    assert.equal(described.status, 0, `${cli} describe stderr=${described.stderr}`);
    const entry = parseLine(described.stdout).data;

    const helped = run([...cli.split(' '), '--help']);
    assert.equal(helped.status, 0, `${cli} help stderr=${helped.stderr}`);
    assert.match(helped.stdout, new RegExp(`ace ${cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const flag of entry.flags) {
      assert.match(helped.stdout, new RegExp(flag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${cli}: help missing ${flag.name}`);
    }
    for (const positional of entry.positionals) {
      assert.match(helped.stdout, new RegExp(`<${positional.name}>`), `${cli}: help missing <${positional.name}>`);
    }
  }
});

test('describe task run: documents unbounded max-rounds', () => {
  const r = run(['describe', 'task run']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  const flag = env.data.flags.find((f: any) => f.name === '--max-rounds');
  assert.match(flag.description, /0 for unbounded/);
});

test('describe task run: documents goal-mode choices for Codex', () => {
  const r = run(['describe', 'task run']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  const flag = env.data.flags.find((f: any) => f.name === '--goal-mode');
  assert.ok(flag, 'expected --goal-mode flag');
  assert.deepEqual(flag.choices, ['auto', 'on', 'off']);
  assert.match(flag.description, /Codex/);
  assert.match(flag.description, /TaskSpec-derived \/goal objective/);
  assert.match(flag.description, /code\/UI work/);
});

test('describe task run: documents effort and tool opt-in flags', () => {
  const r = run(['describe', 'task run']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  const effort = env.data.flags.find((f: any) => f.name === '--effort');
  const mcpMode = env.data.flags.find((f: any) => f.name === '--mcp-mode');
  const browserMode = env.data.flags.find((f: any) => f.name === '--browser-mode');
  assert.deepEqual(effort.choices, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.match(effort.description, /Scoped subagents default to medium/);
  assert.deepEqual(mcpMode.choices, ['off', 'global']);
  assert.match(mcpMode.description, /Default off/);
  assert.deepEqual(browserMode.choices, ['off', 'on']);
  assert.match(browserMode.description, /Default off/);
});

test('describe task run: documents dry-run route explanation', () => {
  const r = run(['describe', 'task run']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  const flag = env.data.flags.find((f: any) => f.name === '--dry-run');
  assert.ok(flag, 'expected --dry-run flag');
  assert.match(flag.description, /route explanation/);
});

test('describe goal launch: documents Hermes intake launcher', () => {
  const r = run(['describe', 'goal launch']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'goal launch');
  assert.equal(env.data.ipcMethod, 'special:goalLaunch');
  const flagNames = env.data.flags.map((f: any) => f.name);
  assert.ok(flagNames.includes('--workspace'));
  assert.ok(flagNames.includes('--size'));
  assert.ok(flagNames.includes('--orchestrator-agent'));
  assert.equal(flagNames.includes('--force-new'), false);
});

test('describe orchestrator start: defaults manual recovery controllers to Claude', () => {
  const r = run(['describe', 'orchestrator start']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'orchestrator start');
  const agentFlag = env.data.flags.find((f: any) => f.name === '--agent');
  assert.equal(agentFlag.default, 'claude');
  assert.ok(agentFlag.choices.includes('hermes'));
  assert.match(env.data.description, /Defaults to Claude/);
});

test('task run --dry-run returns route explanation before transport setup', () => {
  const r = run(
    ['--json', 'task', 'run', '--dry-run', '--goal', 'Explain the failing UI state', '--task-type', 'debug'],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-route-dry-run.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.schema, 'AceTaskRunResult/v1');
  assert.equal(env.data.version, 1);
  assert.equal(env.data.dryRun, true);
  assert.equal(env.data.agent, 'claude');
  assert.equal(env.data.provider, 'claude');
  assert.equal(env.data.streamKind, 'cli');
  assert.equal(env.data.roleMode, 'reviewer');
  assert.equal(env.data.taskClass, 'incident_debug');
  assert.equal(env.data.route.reason, 'debug-task-type');
  assert.equal(env.data.route.roleMode, 'reviewer');
  assert.equal(env.data.route.skillPack, 'debug');
  assert.deepEqual(env.data.baselineSkills, ['ace-runtime-contract', 'ace-memory', 'ace-validator-worker']);
  assert.deepEqual(env.data.validationSkills, []);
  assert.deepEqual(env.data.requiredSkills, []);
  assert.deepEqual(env.data.optionalSkills, []);
  assert.deepEqual(env.data.warnings, []);
  assert.equal(typeof env.data.promptChars, 'number');
  assert.equal(env.data.validationPolicy.defaultReview, 'same-worker-native-review');
  assert.equal(env.data.telemetry.schema, 'AceTaskRunTelemetry/v1');
  assert.equal(env.data.telemetry.version, 1);
  assert.equal(env.data.telemetry.provider, 'claude');
  assert.equal(env.data.telemetry.effort, 'xhigh');
  assert.deepEqual(env.data.telemetry.launchIntent.cliArgs, ['--effort', 'xhigh']);
  assert.equal(env.data.telemetry.skillPack, 'debug');
  assert.equal(typeof env.data.telemetry.renderedPromptChars, 'number');
  assert.equal(env.data.telemetry.skillCount, 5);
  assert.equal(env.data.telemetry.mcpMode, 'off');
  assert.equal(env.data.telemetry.baseRefreshMode, 'false');
  assert.equal(env.data.telemetry.readyMs, null);
  assert.equal(env.data.telemetry.promptMs, null);
  assert.equal(env.data.telemetry.firstOutputMs, null);
  assert.equal(env.data.telemetry.routeReason, 'debug-task-type');
});

test('goal launch --dry-run large resolves to the research-grill agent (no orchestra)', () => {
  const r = run(
    ['--json', 'goal', 'launch', '--workspace', 'prj_42', '--goal', 'Rework Hermes operations into intake router and Claude controller workflow', '--size', 'large', '--dry-run'],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-goal-launch-large.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.schema, 'AceGoalLaunchResult/v1');
  assert.equal(env.data.dryRun, true);
  assert.equal(env.data.launchMode, 'research-grill');
  assert.equal(env.data.workspaceId, 'prj_42');
  assert.equal(env.data.agent, 'claude');
  assert.equal(env.data.newTask, false);
  assert.equal(env.data.agentClass, 'orchestrator');
  assert.equal(env.data.roleMode, 'no-code');
  assert.ok(env.data.taskPackSkills.includes('ace-grill-prd'));
  assert.ok(env.data.telemetry.launchIntent.skillIds.includes('ace-internal-subagents'));
  assert.equal(env.data.telemetry.launchIntent.skillIds.includes('[object Object]'), false);
  // v2.1: the research-grill agent must NOT spawn external Ace workers; it
  // spawns internal sub-agents only.
  assert.ok(env.data.spec.constraints.some((line: string) => /INTERNAL sub-agents only/i.test(line)));
  assert.ok(env.data.spec.constraints.some((line: string) => /Do NOT spawn external Ace workers/i.test(line)));
});

test('goal launch --dry-run tiny resolves to one direct worker', () => {
  const r = run(
    ['--json', 'goal', 'launch', '--workspace', 'prj_42', '--goal', 'Fix README typo', '--size', 'tiny', '--dry-run'],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-goal-launch-tiny.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.launchMode, 'direct-worker');
  assert.equal(env.data.agent, 'codex');
  assert.equal(env.data.newTask, true);
  assert.equal(env.data.spec.role, 'editor');
  assert.equal(env.data.spec.taskType, 'feature-impl');
});

test('task run --dry-run reports chat stream kind for Codex validator specs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-validator-chat-dry-run-'));
  try {
    const specPath = path.join(tmp, 'validator.json');
    fs.writeFileSync(specPath, JSON.stringify({
      goal: 'Validate a GoalAgent validator still routes to a branch/worktree when chat kind is requested.',
      baseBranch: 'main',
      role: 'viewer',
      roleMode: 'reviewer',
      taskType: 'validator',
      agentClass: 'validator',
      effort: 'high',
      effortOverrideReason: 'Chief doctrine: Mission validators run as visible Codex-high chat validators',
      rubric: 'docs/harness/ACE_GOAL_PROTOCOL.md',
      architecture: 'docs/harness/ACE_HARNESS_BLUEPRINT.md',
      workerSpec: 'docs/harness/ACE_PROJECT_SCAFFOLD.md',
      scope: { paths: [] },
      acceptance: [
        'GoalAgent validator delivery uses a task worktree, not a chat-only stream.',
        'Dry-run reports the effective worktree-backed stream kind.',
      ],
      requireChanges: false,
    }));
    const r = run(['--json', 'task', 'run', 'codex', '--dry-run', '--kind', 'chat', '--spec', specPath], {
      ACE_SOCK: '/tmp/ace-no-socket-for-validator-chat-dry-run.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    });
    assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
    const env = parseLine(r.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.data.dryRun, true);
    assert.equal(env.data.agent, 'codex');
    assert.equal(env.data.streamKind, 'task-worktree');
    assert.equal(env.data.agentClass, 'validator');
    assert.equal(env.data.effort, 'high');
    assert.equal(env.data.telemetry.launchIntent.reasoningEffort, 'high');
    assert.equal(env.data.validationPolicy.spawnValidator, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task run --dry-run keeps high-risk review in the worker lane', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-risk-dry-run-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Patch runtime routing.',
    baseBranch: 'main',
    role: 'editor',
    scope: { repo: 'me/app' },
    riskLevel: 'high',
    acceptance: ['targeted tests pass'],
  }), 'utf8');
  const r = run(['--json', 'task', 'run', '--dry-run', '--spec', specPath], {
    ACE_SOCK: '/tmp/ace-no-socket-for-risk-dry-run.sock',
    ACE_URL: '',
    ACE_TOKEN: '',
  });
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.data.validationPolicy.spawnValidator, false);
  assert.equal(env.data.validationPolicy.defaultReview, 'same-worker-native-review');
  assert.equal(env.data.validationPolicy.reason, 'high-risk-native-review');
});

test('task run --dry-run resolves missing optional skills as warnings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-route-dry-run-'));
  const home = path.join(tmp, 'home');
  const specPath = path.join(tmp, 'spec.json');
  const requiredPath = path.join(home, '.codex', 'skills', 'required-present');
  fs.mkdirSync(requiredPath, { recursive: true });
  fs.writeFileSync(path.join(requiredPath, 'SKILL.md'), '# required present', 'utf8');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Review PR #42 for prompt budget regressions.',
    baseBranch: 'main',
    role: 'viewer',
    scope: { repo: 'me/app' },
    taskType: 'code-review',
    requiredSkills: ['required-present'],
    optionalSkills: ['missing-optional'],
    acceptance: ['Reviewer verdict is clear.'],
  }));

  const r = run(['--json', 'task', 'run', '--dry-run', '--spec', specPath], {
    SKILL_LOADER_HOME: home,
    ACE_SOCK: '/tmp/ace-no-socket-for-route-dry-run.sock',
    ACE_URL: '',
    ACE_TOKEN: '',
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.data.taskClass, 'review_validate');
  assert.equal(env.data.requiredSkills[0].id, 'required-present');
  assert.equal(env.data.requiredSkills[0].available, true);
  assert.equal(env.data.optionalSkills[0].id, 'missing-optional');
  assert.equal(env.data.optionalSkills[0].available, false);
  assert.deepEqual(env.data.warnings, ['optional skill missing: missing-optional']);
});

test('task run --dry-run blocks missing required skills before transport setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-route-dry-run-'));
  const home = path.join(tmp, 'home');
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Implement src/auth.ts token support.',
    baseBranch: 'main',
    role: 'editor',
    scope: { repo: 'me/app' },
    taskType: 'feature-impl',
    requiredSkills: ['missing-required'],
    acceptance: ['npm run lint passes.'],
  }));

  const r = run(['--json', 'task', 'run', '--dry-run', '--spec', specPath], {
    SKILL_LOADER_HOME: home,
    ACE_SOCK: '/tmp/ace-no-socket-for-route-dry-run.sock',
    ACE_URL: '',
    ACE_TOKEN: '',
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  assert.equal(r.status, 2, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stderr, '');
  const env = parseLine(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'missing_required_skill');
  assert.deepEqual(env.details.missingRequired, ['missing-required']);
});

test('task run --dry-run reports Codex xhigh effort and blocks non-default without override', () => {
  // Owner doctrine: Codex default effort = xhigh, always. Non-defaults still
  // require an explicit override reason; low/medium/high fall into that
  // bucket now that xhigh is the default.
  const envBase = {
    ACE_SOCK: '/tmp/ace-no-socket-for-effort-test.sock',
    ACE_URL: '',
    ACE_TOKEN: '',
  };
  const xhigh = run(['--json', 'task', 'run', 'codex', '--dry-run', '--goal', 'Implement src/auth.ts'], envBase);
  assert.equal(xhigh.status, 0, `stdout=${xhigh.stdout}; stderr=${xhigh.stderr}`);
  const xhighData = parseLine(xhigh.stdout).data;
  assert.equal(xhighData.telemetry.effort, 'xhigh');
  assert.deepEqual(xhighData.telemetry.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);

  const explicitXhigh = run(
    ['--json', 'task', 'run', 'codex', '--dry-run', '--goal', 'Implement src/auth.ts', '--effort', 'xhigh'],
    envBase
  );
  assert.equal(explicitXhigh.status, 0, `stdout=${explicitXhigh.stdout}; stderr=${explicitXhigh.stderr}`);
  assert.equal(parseLine(explicitXhigh.stdout).data.telemetry.effort, 'xhigh');

  for (const effort of ['low', 'medium', 'high']) {
    const blocked = run(
      ['--json', 'task', 'run', 'codex', '--dry-run', '--goal', 'Implement src/auth.ts', '--effort', effort],
      envBase
    );
    assert.equal(blocked.status, 2, `stdout=${blocked.stdout}; stderr=${blocked.stderr}`);
    const err = parseLine(blocked.stdout);
    assert.equal(err.error, 'invalid_spec');
    assert.match(err.message, new RegExp(`effort ${effort} requires effortOverrideReason`));
  }

  for (const effort of ['low', 'high', 'xhigh']) {
    const allowed = run(
      [
        '--json',
        'task',
        'run',
        'codex',
        '--dry-run',
        '--goal',
        'Implement src/auth.ts',
        '--effort',
        effort,
        '--effort-override',
        'Chief requested non-default reasoning.',
      ],
      envBase
    );
    assert.equal(allowed.status, 0, `stdout=${allowed.stdout}; stderr=${allowed.stderr}`);
    const data = parseLine(allowed.stdout).data;
    assert.equal(data.telemetry.effort, effort);
    if (effort === 'xhigh') {
      assert.deepEqual(data.telemetry.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);
    }
  }

  const unsupportedMax = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--goal',
      'Implement src/auth.ts',
      '--effort',
      'max',
      '--effort-override',
      'Chief requested Codex max reasoning.',
    ],
    envBase
  );
  assert.equal(unsupportedMax.status, 2, `stdout=${unsupportedMax.stdout}; stderr=${unsupportedMax.stderr}`);
  const maxErr = parseLine(unsupportedMax.stdout);
  assert.equal(maxErr.error, 'invalid_spec');
  assert.match(maxErr.message, /Codex reasoning effort "max" is not supported/);
});

test('task run --dry-run preserves explicit Claude max effort through launch intent', () => {
  const r = run(
    [
      '--json',
      'task',
      'run',
      'claude',
      '--dry-run',
      '--goal',
      'Investigate a hard UI regression',
      '--effort',
      'max',
      '--effort-override',
      'Chief requested true Claude max effort.',
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-claude-max-effort-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.agent, 'claude');
  assert.equal(data.telemetry.effort, 'max');
  assert.deepEqual(data.telemetry.launchIntent.cliArgs, ['--effort', 'max']);
  assert.equal(data.telemetry.launchIntent.ultraCode, true);
  assert.equal(data.telemetry.launchIntent.workflowMode, 'dynamic-workflow');
  assert.match(data.telemetry.launchIntent.guidance, /xhigh remains extra-high reasoning only/);
});

test('task run --dry-run maps Codex tool-mode opt-in to app-parity runtime', () => {
  const r = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--goal',
      'Implement src/auth.ts',
      '--tool-mode',
      'on',
      '--tool-override',
      'Chief requested tool access.',
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-tool-mode-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.telemetry.toolMode, 'on');
  assert.equal(data.telemetry.launchIntent.requestedToolMode, 'on');
  assert.equal(data.telemetry.launchIntent.effectiveToolMode, 'app-parity');
  assert.equal(data.telemetry.launchIntent.codexRuntimeProfile, 'app-parity');
  assert.ok(data.telemetry.launchIntent.codexConfigOverrides.includes('features.computer_use=true'));
  assert.deepEqual(data.warnings, []);
});

test('task run --dry-run rejects capability-only Codex app-parity without audit reason', () => {
  const r = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--goal',
      'Inspect the app with computer use',
      '--capability',
      'computer-use',
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-capability-audit-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 2, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stdout);
  assert.equal(err.error, 'invalid_spec');
  assert.match(err.message, /app-parity runtime requires toolOverrideReason/);
});

test('task run --dry-run maps reasoned Codex capability to app-parity runtime', () => {
  const r = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--goal',
      'Inspect the app with computer use',
      '--capability',
      'computer-use',
      '--tool-override',
      'Acceptance explicitly requires app-parity computer-use validation.',
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-reasoned-capability-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.telemetry.launchIntent.codexRuntimeProfile, 'app-parity');
  assert.equal(data.telemetry.launchIntent.appParityAuditReason, 'Acceptance explicitly requires app-parity computer-use validation.');
  assert.ok(data.telemetry.launchIntent.codexConfigOverrides.includes('features.computer_use=true'));
  assert.deepEqual(data.warnings, []);
});

test('task run --dry-run preserves TaskSpec Codex app-parity runtime profile into launch intent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-run-codex-profile-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Validate the built app with Codex app parity',
    baseBranch: 'main',
    role: 'editor',
    scope: { repo: 'me/app' },
    acceptance: ['Codex app-parity launch intent is selected'],
    codexRuntimeProfile: 'app-parity',
    toolOverrideReason: 'Operator requested Codex app-parity runtime.',
  }), 'utf8');
  const r = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--spec',
      specPath,
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-spec-profile-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.telemetry.launchIntent.codexRuntimeProfile, 'app-parity');
  assert.equal(data.telemetry.launchIntent.requestedCodexRuntimeProfile, 'app-parity');
  assert.equal(data.telemetry.launchIntent.appParityAuditReason, 'Operator requested Codex app-parity runtime.');
  assert.ok(data.telemetry.launchIntent.codexConfigOverrides.includes('features.enable_mcp_apps=true'));
});

test('task run --dry-run maps mcp-mode global to Codex MCP launch intent', () => {
  const r = run(
    [
      '--json',
      'task',
      'run',
      'codex',
      '--dry-run',
      '--goal',
      'Inspect the app with Computer Use',
      '--mcp-mode',
      'global',
      '--tool-override',
      'Chief requested Computer Use smoke.',
    ],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-mcp-mode-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.telemetry.mcpMode, 'global');
  assert.equal(data.telemetry.launchIntent.requestedMcpMode, 'global');
  assert.equal(data.telemetry.launchIntent.enableMcp, true);
});

test('task run --spec rejects schema-invalid JSON before dispatch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-spec-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ goal: 'missing canonical fields' }));
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: should not run' };
    },
    (sockPath: any) => runAsync(
      ['task', 'run', 'codex', '--stream', 'conversation:abc', '--spec', specPath],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  assert.equal(r.status, 2, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'invalid_spec');
  assert.match(err.message, /baseBranch required/);
  assert.equal(requests.length, 0, 'invalid specs must not dispatch to the socket');
});

test('task run --spec schema errors are reported before transport setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-spec-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ goal: 'missing canonical fields' }));
  const r = run(
    ['task', 'run', 'codex', '--stream', 'conversation:abc', '--spec', specPath],
    {
      ACE_SOCK: '/tmp/ace-no-socket-for-schema-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  assert.equal(r.status, 2, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'invalid_spec');
  assert.match(err.message, /baseBranch required/);
});

test('mission ready calls the read-only board socket method with filters', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      assert.equal(req.method, 'missionBoard');
      return {
        filters: req.params,
        totals: { missions: 1, cards: 1, ready: 1, blocked: 0 },
        missions: [],
      };
    },
    (sockPath: any) => runAsync(
      ['mission', 'ready', '--workspace', 'prj_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, {
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    readyOnly: true,
  });
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.totals.ready, 1);
});

test('mission archive calls native archive socket method with dry-run summary flags', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      assert.equal(req.method, 'missionArchive');
      return {
        dryRun: true,
        olderThanDays: 3,
        cutoff: '2026-05-07T00:00:00.000Z',
        archivedCount: 0,
        candidateCount: 1,
        archived: [{ missionId: 'msn_42', featureId: 'ft_42' }],
      };
    },
    (sockPath: any) => runAsync(
      ['mission', 'archive', '--workspace', 'prj_42', '--mission', 'msn_42', '--older-than-days', '3', '--dry-run'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, {
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    olderThanDays: 3,
    dryRun: true,
  });
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.candidateCount, 1);
});

test('mission create calls the native mission socket method with Rook controller context', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      assert.equal(req.method, 'missionCreate');
      assert.deepEqual(req.params, {
        workspaceId: 'prj_42',
        name: 'Native ticket',
        summary: 'Use Ace-native missions.',
        features: [
          { name: 'Create card', description: 'Persist native feature row' },
        ],
        createdByIdentity: 'rook',
        ownerIdentity: 'shared',
        activeControllerIdentity: 'rook',
        createdByTaskId: 'tsk_rook',
        createdByStreamId: 'conversation:rook',
        sourceContextSummary: 'Hermes trigger materialized natively',
        sourceFiles: ['docs/ops/ace-native-mission-board.md'],
        allowPaths: ['tools/ace/src/index.cts', 'electron/missions.cts'],
        statusNote: 'Ready',
        nextAction: 'Dispatch worker',
        orchestratorAgent: null,
        workerAgent: 'codex',
        validatorAgent: null,
      });
      return {
        missionId: 'msn_42',
        workspaceId: 'prj_42',
        status: 'ready',
        featureIds: ['ft_42'],
        createdByIdentity: 'rook',
        ownerIdentity: 'shared',
        activeControllerIdentity: 'rook',
      };
    },
    (sockPath: any) => runAsync(
      [
        'mission',
        'create',
        '--workspace',
        'prj_42',
        '--name',
        'Native ticket',
        '--summary',
        'Use Ace-native missions.',
        '--feature',
        'Create card::Persist native feature row',
        '--owner',
        'shared',
        '--controller',
        'rook',
        '--source-context',
        'Hermes trigger materialized natively',
        '--source-file',
        'docs/ops/ace-native-mission-board.md',
        '--allow-path',
        'tools/ace/src/index.cts',
        '--allow-path',
        'electron/missions.cts',
        '--status-note',
        'Ready',
        '--next-action',
        'Dispatch worker',
        '--worker',
        'codex',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_TASK_ID: 'tsk_rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.missionId, 'msn_42');
});

test('kanban materialize sends descriptor to packaged-safe mission materialize method', async () => {
  const descriptor = {
    id: 'KAN-42',
    title: 'Materialize Kanban',
    summary: 'Native Mission is source of truth.',
    items: [
      { name: 'Create native card', description: 'Persist feature row.' },
    ],
  };
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      assert.equal(req.method, 'missionMaterializeKanban');
      assert.deepEqual(req.params, {
        descriptor,
        workspaceId: 'prj_42',
        kanbanTaskId: 'KAN-42',
        name: null,
        summary: null,
        ownerIdentity: 'rook',
        activeControllerIdentity: 'rook',
        createdByIdentity: 'rook',
        createdByTaskId: 'tsk_rook',
        createdByStreamId: 'conversation:rook',
        orchestratorAgent: null,
        workerAgent: 'codex',
        validatorAgent: null,
      });
      return {
        missionId: 'msn_kanban',
        workspaceId: 'prj_42',
        status: 'ready',
        featureIds: ['ft_kanban'],
        source: 'hermes-kanban',
        kanbanTaskId: 'KAN-42',
      };
    },
    (sockPath: any) => runAsync(
      [
        'kanban',
        'materialize',
        'KAN-42',
        '--workspace',
        'prj_42',
        '--json-text',
        JSON.stringify(descriptor),
        '--owner',
        'rook',
        '--controller',
        'rook',
        '--worker',
        'codex',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_TASK_ID: 'tsk_rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.missionId, 'msn_kanban');
  assert.equal(env.data.kanbanTaskId, 'KAN-42');
});

test('mission dispatch prepares, spawns through visible task path, and attaches linkage', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareDispatch') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          agent: 'claude',
          redispatch: null, // wave-dispatch (#443) rides along on every dispatch
          spawnedByIdentity: 'rook',
          spawnedByStreamId: 'conversation:rook',
        });
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          milestoneId: 'ms_1',
          agent: 'claude',
          label: 'Mission msn_42: Ready card',
          spec: {
            goal: 'Implement mission feature: Ready card',
            baseBranch: 'dev',
            role: 'editor',
            scope: {
              workspaceId: 'prj_42',
              missionId: 'msn_42',
              featureId: 'ft_42',
            },
            taskType: 'feature-impl',
            context: 'Context',
            constraints: ['Stay scoped'],
            deliverables: ['Ready card'],
            acceptance: ['Card complete'],
            effort: 'max',
            effortOverrideReason: 'Chief requested true Claude max effort.',
            requireChanges: true,
	          },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCreateDelegatedTask') {
	        assert.equal(req.params.workspaceId, 'prj_42');
        assert.equal(req.params.agent, 'claude');
        assert.equal(req.params.goal, 'Implement mission feature: Ready card');
        assert.equal(req.params.label, 'Mission msn_42: Ready card');
        assert.match(req.params.prompt, /# Goal\nImplement mission feature: Ready card/);
        assert.match(req.params.prompt, /# Skills to load/);
        assert.match(req.params.prompt, /- ace-goal-worker/);
        assert.doesNotMatch(req.params.prompt, /Code quality bar|Read these files BEFORE writing any code/);
        assert.ok(req.params.prompt.length < 1300, `mission prompt too long: ${req.params.prompt.length}`); // +ace-memory baseline (~60 chars)
        return {
          taskId: 'tsk_42',
          variantId: 'var_42',
          worktreeId: 'wt_42',
          worktreePath: '/tmp/ace/wt_42',
          branch: 'ace/mission-ft-42',
          baseBranch: 'dev',
          baseHygiene: {
            baseBranch: 'main',
            selectedBase: 'origin/main',
            selectedBaseKind: 'remote',
            remoteBaseRef: 'origin/main',
            remoteBaseSha: 'abc123',
            localBaseSha: 'def456',
            localAheadBy: 1,
            localBehindBy: 0,
            diverged: false,
            branchPoint: 'origin/main',
            ok: true,
          },
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        assert.equal(req.params.variantId, 'var_42');
        assert.deepEqual(req.params.launchIntent.cliArgs, ['--effort', 'max']);
        assert.equal(req.params.launchIntent.ultraCode, true);
        assert.equal(req.params.launchIntent.workflowMode, 'dynamic-workflow');
        return { streamId: 'variant:var_42', variantId: 'var_42' };
      }
      if (req.method === 'streamWaitFor') {
        assert.deepEqual(req.params.predicate, { awaitingInput: true });
        return { matched: 'awaiting-input', elapsedMs: 1 };
      }
      if (req.method === 'streamSendInput') {
        assert.equal(req.params.streamId, 'variant:var_42');
        assert.equal(req.params.text, '/effort ultracode');
        assert.equal(req.params.mode, 'paste');
        return { ok: true };
      }
      if (req.method === 'streamSubmit') {
        assert.equal(req.params.streamId, 'variant:var_42');
        return { ok: true };
      }
      if (req.method === 'streamSendSubmit') {
        assert.equal(req.params.streamId, 'variant:var_42');
        assert.match(req.params.text, /# Escape hatch/);
        assert.equal(req.params.mode, 'paste');
        return { ok: true, telemetry: { promptMs: 2 } };
      }
      if (req.method === 'missionAttachDispatch') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          taskId: 'tsk_42',
          streamId: 'variant:var_42',
          worktreeId: 'wt_42',
          worktreePath: '/tmp/ace/wt_42',
          branch: 'ace/mission-ft-42',
          baseBranch: 'dev',
          baseHygiene: {
            baseBranch: 'main',
            selectedBase: 'origin/main',
            selectedBaseKind: 'remote',
            remoteBaseRef: 'origin/main',
            remoteBaseSha: 'abc123',
            localBaseSha: 'def456',
            localAheadBy: 1,
            localBehindBy: 0,
            diverged: false,
            branchPoint: 'origin/main',
            ok: true,
          },
          workerAgent: 'claude',
          rootTaskId: 'tsk_42',
          parentTaskId: null,
          isRootGoalAgent: true,
          isInternalSubagent: false,
          spawnedByIdentity: 'rook',
          spawnedByStreamId: 'conversation:rook',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          taskId: 'tsk_42',
          streamId: 'variant:var_42',
          worktreeId: 'wt_42',
          worktreePath: '/tmp/ace/wt_42',
          branch: 'ace/mission-ft-42',
          workerAgent: 'claude',
          dispatchStatus: 'dispatched',
	        };
	      }
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'dispatch', '--feature', 'ft_42', '--agent', 'claude', '--mission', 'msn_42', '--workspace', 'prj_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(
    requests.map((req) => req.method),
	    [
	      'missionPrepareDispatch',
	      'getState',
	      'streamTrackedGithubProjects',
	      'streamCreateDelegatedTask',
	      'streamSpawnIntoVariant',
	      'missionAttachDispatch',
	      'streamWaitFor',
	      'streamSendInput',
	      'streamSubmit',
	      'streamWaitFor',
	      'streamWaitFor',
	      'streamSendSubmit',
	    ]
	  );
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.featureId, 'ft_42');
  assert.equal(env.data.taskId, 'tsk_42');
  assert.equal(env.data.streamId, 'variant:var_42');
  assert.equal(env.data.worktreePath, '/tmp/ace/wt_42');
  assert.equal(env.data.branch, 'ace/mission-ft-42');
  assert.equal(env.data.dispatchStatus, 'dispatched');
});

test('mission dispatch preserves Codex xhigh effort in launch intent', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareDispatch') {
        return {
          missionId: 'msn_xhigh',
          workspaceId: 'prj_xhigh',
          featureId: 'ft_xhigh',
          milestoneId: 'ms_1',
          agent: 'codex',
          label: 'Mission msn_xhigh: Xhigh card',
          spec: {
            goal: 'Implement mission feature: Xhigh card',
            baseBranch: 'dev',
            role: 'editor',
            scope: {
              workspaceId: 'prj_xhigh',
              missionId: 'msn_xhigh',
              featureId: 'ft_xhigh',
            },
            taskType: 'feature-impl',
            goalMode: 'on',
            context: 'Mission context',
            constraints: ['Stay scoped'],
            deliverables: ['Xhigh card'],
            acceptance: ['Card complete'],
            effort: 'xhigh',
            effortOverrideReason: 'Chief requested extra-high Codex reasoning.',
            maxRounds: 0,
            requireChanges: true,
          },
        };
      }
      const workspaceLookup = emptyWorkspaceLookup(req);
      if (workspaceLookup) return workspaceLookup;
      if (req.method === 'streamCreateDelegatedTask') {
        return {
          taskId: 'tsk_xhigh',
          variantId: 'var_xhigh',
          worktreeId: 'wt_xhigh',
          worktreePath: '/tmp/ace/wt_xhigh',
          branch: 'ace/mission-ft-xhigh',
          baseBranch: 'dev',
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        assert.deepEqual(req.params.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);
        assert.equal(req.params.launchIntent.reasoningEffort, 'xhigh');
        return { streamId: 'variant:var_xhigh', variantId: 'var_xhigh' };
      }
      if (req.method === 'streamWaitFor') return { matched: 'awaiting-input', elapsedMs: 1 };
      if (req.method === 'streamSendInput') {
        assert.match(req.params.text, /unbounded rounds allowed until terminal result/);
        assert.doesNotMatch(req.params.text, /max rounds 3/);
        return { ok: true };
      }
      if (req.method === 'streamSubmit') return { ok: true };
      if (req.method === 'streamSendSubmit') return { ok: true, telemetry: { promptMs: 2 } };
      if (req.method === 'missionAttachDispatch') {
        return {
          featureId: 'ft_xhigh',
          missionId: 'msn_xhigh',
          workspaceId: 'prj_xhigh',
          taskId: 'tsk_xhigh',
          streamId: 'variant:var_xhigh',
          worktreeId: 'wt_xhigh',
          worktreePath: '/tmp/ace/wt_xhigh',
          branch: 'ace/mission-ft-xhigh',
          workerAgent: 'codex',
          dispatchStatus: 'dispatched',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'dispatch', '--feature', 'ft_xhigh', '--mission', 'msn_xhigh', '--workspace', 'prj_xhigh'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.ok(requests.some((req) => req.method === 'streamSpawnIntoVariant'));
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.streamId, 'variant:var_xhigh');
});

test('mission dispatch blocks before spawning when start audit proof is missing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-missing-dispatch-audit-'));
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareDispatch') {
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'codex',
          label: 'Mission msn_42: Ready card',
          spec: { goal: 'Implement mission feature: Ready card', baseBranch: 'main', role: 'editor' },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'dispatch', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_USER_DATA_TAG: `missing-dispatch-${Date.now()}`,
        ACE_TEST_AUDIT_PROOF: '0',
      },
      { cwd }
    )
  );

  fs.rmSync(cwd, { recursive: true, force: true });
	  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareDispatch', 'getState', 'streamTrackedGithubProjects']);
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'tool_audit_missing');
  assert.match(err.message, /mission dispatch blocked by tool audit/);
  assert.match(err.message, /missing orchestrator.start events: tool heartbeat, tool manifest, context, run board\|run list, ls\|watch\|screen\|state/);
});

test('mission wave-dispatch --prepare-only returns the WaveManifest without spawning lanes', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareWaveDispatch') {
        assert.deepEqual(req.params, {
          missionId: 'msn_alpha',
          milestoneId: 'ms_alpha',
          featureIds: null,
          agent: null,
          controllerIdentity: 'rook',
        });
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_alpha',
          missionId: 'msn_alpha',
          workspaceId: 'prj_alpha',
          milestoneId: 'ms_alpha',
          controllerIdentity: 'rook',
          expectedLaneCount: 2,
          lanes: [
            {
              laneId: 'ft_a',
              featureId: 'ft_a',
              workerAgent: 'codex',
              roleMode: 'implementer',
              taskType: 'feature-impl',
              label: 'Mission msn_alpha: A',
              prepared: { agent: 'codex', missionId: 'msn_alpha', workspaceId: 'prj_alpha', featureId: 'ft_a', label: 'Mission msn_alpha: A', spec: { goal: 'g', baseBranch: 'main', role: 'editor', scope: {}, taskType: 'feature-impl' } },
            },
            {
              laneId: 'ft_b',
              featureId: 'ft_b',
              workerAgent: 'codex',
              roleMode: 'implementer',
              taskType: 'feature-impl',
              label: 'Mission msn_alpha: B',
              prepared: { agent: 'codex', missionId: 'msn_alpha', workspaceId: 'prj_alpha', featureId: 'ft_b', label: 'Mission msn_alpha: B', spec: { goal: 'g', baseBranch: 'main', role: 'editor', scope: {}, taskType: 'feature-impl' } },
            },
          ],
          manifest: {
            schema: 'WaveManifest/v1',
            missionId: 'msn_alpha',
            waveId: 'ms_alpha',
            milestoneId: 'ms_alpha',
            controllerIdentity: 'rook',
            joinPolicy: 'all_lanes_terminal',
            lanes: [
              { laneId: 'ft_a', featureId: 'ft_a' },
              { laneId: 'ft_b', featureId: 'ft_b' },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'mission', 'wave-dispatch', '--mission', 'msn_alpha', '--wave', 'ms_alpha', '--prepare-only'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareWaveDispatch']);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.schema, 'WaveManifest/v1');
  assert.equal(env.data.waveId, 'ms_alpha');
  assert.equal(env.data.prepareOnly, true);
  assert.equal(env.data.lanes.length, 2);
  assert.equal(env.data.manifest.joinPolicy, 'all_lanes_terminal');
});

test('mission wave-dispatch refuses lane fanout without explicit-wave opt-in', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareWaveDispatch') {
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_blocked',
          missionId: 'msn_blocked',
          workspaceId: 'prj_blocked',
          milestoneId: 'ms_blocked',
          controllerIdentity: 'rook',
          expectedLaneCount: 1,
          lanes: [
            {
              laneId: 'ft_a',
              featureId: 'ft_a',
              workerAgent: 'codex',
              roleMode: 'implementer',
              taskType: 'feature-impl',
              label: 'Mission msn_blocked: A',
              prepared: { agent: 'codex', missionId: 'msn_blocked', workspaceId: 'prj_blocked', featureId: 'ft_a', label: 'Mission msn_blocked: A', spec: { goal: 'g', baseBranch: 'main', role: 'editor', scope: {}, taskType: 'feature-impl' } },
            },
          ],
          manifest: { schema: 'WaveManifest/v1', missionId: 'msn_blocked', waveId: 'ms_blocked', joinPolicy: 'all_lanes_terminal', lanes: [] },
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'mission', 'wave-dispatch', '--mission', 'msn_blocked', '--wave', 'ms_blocked'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 5, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareWaveDispatch']);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'server_error');
  assert.match(err.message, /requires --explicit-wave/);
});

test('mission wave-dispatch fans out 3 ready lanes through the visible task path then attaches the wave', async () => {
  const requests: any[] = [];
  let dispatchCounter = 0;
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareWaveDispatch') {
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_three',
          missionId: 'msn_three',
          workspaceId: 'prj_three',
          milestoneId: 'ms_three',
          controllerIdentity: 'rook',
          expectedLaneCount: 3,
          lanes: ['ft_a', 'ft_b', 'ft_c'].map((id) => ({
            laneId: id,
            featureId: id,
            workerAgent: 'codex',
            roleMode: 'implementer',
            taskType: 'feature-impl',
            label: `Mission msn_three: ${id}`,
            prepared: {
              agent: 'codex',
              missionId: 'msn_three',
              workspaceId: 'prj_three',
              featureId: id,
              label: `Mission msn_three: ${id}`,
              spec: {
                goal: `Implement mission feature: ${id}`,
                baseBranch: 'main',
                role: 'editor',
                scope: { workspaceId: 'prj_three', missionId: 'msn_three', featureId: id },
                taskType: 'feature-impl',
                context: 'ctx',
                constraints: [],
                deliverables: [id],
                acceptance: [`Feature ${id} complete`],
                requireChanges: true,
              },
            },
          })),
          manifest: { schema: 'WaveManifest/v1', missionId: 'msn_three', waveId: 'ms_three', joinPolicy: 'all_lanes_terminal', lanes: [] },
	        };
	      }
	      if (req.method === 'streamCreateDelegatedTask') {
        const idx = ++dispatchCounter;
        // Validator R5: each lane spawn must carry waveId/laneId so
        // child-registry rows can join the cohort.
        assert.equal(req.params.waveId, 'ms_three');
        assert.equal(req.params.laneId, ['ft_a', 'ft_b', 'ft_c'][idx - 1]);
        return {
          taskId: `tsk_${idx}`,
          variantId: `var_${idx}`,
          worktreeId: `wt_${idx}`,
          worktreePath: `/tmp/wt_${idx}`,
          branch: `ace/wave-${idx}`,
          baseBranch: 'main',
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        return { streamId: `variant:${req.params.variantId}`, variantId: req.params.variantId };
      }
      if (req.method === 'streamWaitFor') {
        return { matched: 'awaiting-input', elapsedMs: 1 };
      }
      if (req.method === 'streamSendSubmit') {
        return { ok: true, telemetry: { promptMs: 1 } };
      }
      if (req.method === 'missionAttachWave') {
        assert.equal(req.params.missionId, 'msn_three');
        assert.equal(req.params.milestoneId, 'ms_three');
        assert.equal(req.params.controllerIdentity, 'rook');
        assert.equal(req.params.lanes.length, 3);
        assert.deepEqual(req.params.lanes.map((l: any) => l.featureId), ['ft_a', 'ft_b', 'ft_c']);
        for (const lane of req.params.lanes) {
          assert.equal(lane.waveId, 'ms_three');
          assert.equal(lane.laneId, lane.featureId);
        }
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_three',
          missionId: 'msn_three',
          workspaceId: 'prj_three',
          controllerIdentity: 'rook',
          lanes: req.params.lanes.map((l: any) => ({ ...l, laneId: l.featureId, dispatchStatus: 'dispatched' })),
          manifest: { schema: 'WaveManifest/v1', missionId: 'msn_three', waveId: 'ms_three', joinPolicy: 'all_lanes_terminal', lanes: [] },
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'mission', 'wave-dispatch', '--mission', 'msn_three', '--wave', 'ms_three', '--explicit-wave'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const methods = requests.map((req) => req.method);
  assert.equal(methods[0], 'missionPrepareWaveDispatch');
  assert.equal(methods[methods.length - 1], 'missionAttachWave');
  // Three lanes => three full per-lane dispatch sequences.
  assert.equal(methods.filter((m) => m === 'streamCreateDelegatedTask').length, 3);
  assert.equal(methods.filter((m) => m === 'missionAttachWave').length, 1);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.schema, 'WaveManifest/v1');
  assert.equal(env.data.lanes.length, 3);
});

test('mission wave-dispatch writes child-registry rows with waveId/laneId so the wave-join gate can see lanes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-rows-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  let dispatchCounter = 0;
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareWaveDispatch') {
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_join',
          missionId: 'msn_join',
          workspaceId: 'prj_join',
          milestoneId: 'ms_join',
          controllerIdentity: 'rook',
          expectedLaneCount: 2,
          lanes: ['ft_a', 'ft_b'].map((id) => ({
            laneId: id,
            featureId: id,
            workerAgent: 'codex',
            roleMode: 'implementer',
            taskType: 'feature-impl',
            label: `Mission msn_join: ${id}`,
            prepared: {
              agent: 'codex',
              missionId: 'msn_join',
              workspaceId: 'prj_join',
              featureId: id,
              label: `Mission msn_join: ${id}`,
              spec: {
                goal: `Implement mission feature: ${id}`,
                baseBranch: 'main',
                role: 'editor',
                scope: { workspaceId: 'prj_join', missionId: 'msn_join', featureId: id },
                taskType: 'feature-impl',
                context: 'ctx',
                constraints: [],
                deliverables: [id],
                acceptance: [`Feature ${id} complete`],
                requireChanges: true,
              },
            },
          })),
          manifest: { schema: 'WaveManifest/v1', missionId: 'msn_join', waveId: 'ms_join', joinPolicy: 'all_lanes_terminal', lanes: [] },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCreateDelegatedTask') {
        const idx = ++dispatchCounter;
        return {
          taskId: `tsk_${idx}`,
          variantId: `var_${idx}`,
          worktreeId: `wt_${idx}`,
          worktreePath: `/tmp/wt_${idx}`,
          branch: `ace/wave-${idx}`,
          baseBranch: 'main',
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        return { streamId: `variant:${req.params.variantId}`, variantId: req.params.variantId };
      }
      if (req.method === 'streamWaitFor') return { matched: 'awaiting-input', elapsedMs: 1 };
      if (req.method === 'streamSendSubmit') return { ok: true, telemetry: { promptMs: 1 } };
      if (req.method === 'missionAttachWave') {
        return {
          schema: 'WaveManifest/v1',
          waveId: 'ms_join',
          missionId: 'msn_join',
          workspaceId: 'prj_join',
          controllerIdentity: 'rook',
          lanes: req.params.lanes,
          manifest: { schema: 'WaveManifest/v1', missionId: 'msn_join', waveId: 'ms_join', joinPolicy: 'all_lanes_terminal', lanes: [] },
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'mission', 'wave-dispatch', '--mission', 'msn_join', '--wave', 'ms_join', '--explicit-wave'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  // The child-registry must now contain exactly the dispatched lanes,
  // each tagged with waveId/laneId so the wave-join gate (PR #171) can
  // refuse to launch the validator while any lane is nonterminal. Both
  // rows are present and neither carries a terminal laneStatus, so the
  // gate has the input it needs to refuse.
  const persisted = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const rows = Object.values(persisted) as any[];
  assert.equal(rows.length, 2, `expected 2 rows, got ${rows.length}: ${JSON.stringify(persisted)}`);
  for (const row of rows) {
    assert.equal(row.waveId, 'ms_join');
    assert.ok(['ft_a', 'ft_b'].includes(row.laneId), `lane ${row.laneId}`);
    assert.equal(row.workspaceId, 'prj_join');
    assert.ok(!row.laneStatus, 'lane should not be terminal yet');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mission validate prepares, spawns visible high-effort chat validator, and attaches linkage', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareValidation') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          agent: null,
          spawnedByIdentity: 'rook',
          spawnedByStreamId: 'conversation:rook',
          head: null,
          baseSha: null,
          replaceStaleValidator: false,
          // CLI = operator-invoked: bypasses the auto-chain choke.
          force: true,
        });
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          milestoneId: 'ms_1',
          agent: 'codex',
          label: 'Validate msn_42: Ready card',
          spec: {
            goal: 'Validate mission feature: Ready card',
            baseBranch: 'ace/mission-ft-42',
            role: 'viewer',
            scope: {
              workspaceId: 'prj_42',
              missionId: 'msn_42',
              featureId: 'ft_42',
            },
            taskType: 'code-review',
            effort: 'high',
            effortOverrideReason: 'Chief doctrine: Mission validators run as visible Codex-high chat validators',
            context: 'Worker branch: ace/mission-ft-42',
            constraints: ['Read-only validation'],
            deliverables: ['Verdict'],
            acceptance: ['Card validated'],
            requireChanges: false,
          },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCreateDelegatedTask') {
        assert.equal(req.params.workspaceId, 'prj_42');
        assert.equal(req.params.agent, 'codex');
        assert.equal(req.params.goal, 'Validate mission feature: Ready card');
        assert.equal(req.params.label, 'Validate msn_42: Ready card');
        assert.match(req.params.prompt, /# Goal\nValidate mission feature: Ready card/);
        return {
          taskId: 'tsk_val',
          variantId: 'var_val',
          worktreeId: 'wt_val',
          worktreePath: '/tmp/ace/wt_val',
          branch: 'ace/validate-ft-42',
          baseBranch: 'ace/mission-ft-42',
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        assert.equal(req.params.variantId, 'var_val');
        assert.equal(req.params.launchIntent.reasoningEffort, 'high');
        return { streamId: 'conversation:var_val' };
      }
      if (req.method === 'streamWaitFor') {
        assert.deepEqual(req.params.predicate, { awaitingInput: true });
        return { matched: 'awaiting-input', elapsedMs: 1 };
      }
      if (req.method === 'streamSendSubmit') {
        assert.equal(req.params.streamId, 'conversation:var_val');
        assert.match(req.params.text, /# Escape hatch/);
        assert.equal(req.params.mode, 'paste');
        return { ok: true, telemetry: { promptMs: 2 } };
      }
      if (req.method === 'missionAttachValidation') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          taskId: 'tsk_val',
          streamId: 'conversation:var_val',
          worktreeId: 'wt_val',
          worktreePath: '/tmp/ace/wt_val',
          branch: 'ace/validate-ft-42',
          validatorAgent: 'codex',
          spawnedByIdentity: 'rook',
          spawnedByStreamId: 'conversation:rook',
          validatedHeadSha: null,
          validatedBaseSha: null,
          replaceStaleValidator: false,
          deliveryStatus: 'prompt_delivered',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          validatorTaskId: 'tsk_val',
          validatorStreamId: 'conversation:var_val',
          validatorWorktreePath: '/tmp/ace/wt_val',
          validatorBranch: 'ace/validate-ft-42',
          validatorAgent: 'codex',
          validationStatus: 'validating',
          gateStatus: 'blocked',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(
    requests.map((req) => req.method),
	    [
	      'missionPrepareValidation',
	      'getState',
	      'streamTrackedGithubProjects',
	      'streamCreateDelegatedTask',
	      'streamSpawnIntoVariant',
	      'streamWaitFor',
	      'streamSendSubmit',
	      'missionAttachValidation',
	    ]
	  );
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.validatorTaskId, 'tsk_val');
  assert.equal(env.data.validatorStreamId, 'conversation:var_val');
  assert.equal(env.data.validationStatus, 'validating');
  assert.equal(env.data.gateStatus, 'blocked');
});

test('mission dispatch --wave registers the lane in child-registry at dispatch (fire-and-forget)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-dispatch-'));
  const registryPath = path.join(tmp, 'child-registry.json');

  const r = await withSocketServer(
    (req: any) => {
      if (req.method === 'missionPrepareDispatch') {
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'codex',
          label: 'Mission msn_42: lane A',
          spec: {
            goal: 'Implement lane A',
            baseBranch: 'main',
            role: 'editor',
            scope: { workspaceId: 'prj_42', missionId: 'msn_42', featureId: 'ft_42' },
            taskType: 'feature-impl',
            constraints: ['Stay scoped'],
            deliverables: ['Lane A'],
            acceptance: ['Lane A complete'],
            requireChanges: true,
          },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCreateDelegatedTask') {
        return { taskId: 'tsk_disp', variantId: 'var_disp', worktreeId: 'wt_disp', worktreePath: '/tmp/wt_disp', branch: 'feat/a', baseBranch: 'main' };
      }
      if (req.method === 'streamSpawnIntoVariant') return { streamId: 'variant:var_disp', variantId: 'var_disp' };
      if (req.method === 'streamWaitFor') return { matched: 'awaiting-input', elapsedMs: 1 };
      if (req.method === 'streamSendSubmit') return { ok: true, telemetry: { promptMs: 2 } };
      if (req.method === 'missionAttachDispatch') return { dispatchStatus: 'dispatched', taskId: 'tsk_disp' };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'dispatch', '--feature', 'ft_42', '--agent', 'codex', '--mission', 'msn_42', '--workspace', 'prj_42', '--wave', 'wave-1', '--lane', 'A'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  assert.equal((r as any).status, 0, `status=${(r as any).status} stderr=${(r as any).stderr} stdout=${(r as any).stdout}`);
  // The fire-and-forget runTask returned at dispatch — well before any
  // post-DONE write. The early register call must have stamped the row
  // already so the join gate can see it.
  const stored = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  fs.rmSync(tmp, { recursive: true, force: true });
  const row = stored.tsk_disp;
  assert.ok(row, 'registry row must be written at dispatch time');
  assert.equal(row.waveId, 'wave-1');
  assert.equal(row.laneId, 'A');
  assert.equal(row.workspaceId, 'prj_42');
  assert.equal(row.branch, 'feat/a');
});

test('mission validate --wave refuses to launch validator against an empty registry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-empty-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  // Empty registry — no lane has registered for this wave yet.
  fs.writeFileSync(registryPath, JSON.stringify({}));

  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
	      if (req.method === 'missionPrepareValidation') {
	        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'codex',
          label: 'Validate wave-1',
	          spec: { goal: 'Validate wave-1', baseBranch: 'main', role: 'viewer' },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42', '--wave', 'wave-1'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  fs.rmSync(tmp, { recursive: true, force: true });
	  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareValidation', 'getState', 'streamTrackedGithubProjects']);
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'wave_not_ready');
  assert.equal(err.details.verdict.empty, true);
});

test('mission validate --wave --expected-lane blocks while a required lane is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-missing-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  // Only lane "a" has registered — "b" is still missing entirely.
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      tsk_done: {
        taskId: 'tsk_done',
        workspaceId: 'prj_42',
        waveId: 'wave-1',
        laneId: 'a',
        branch: 'b',
        worktreePath: '/w',
        laneStatus: 'done',
      },
    })
  );

  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareValidation') {
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'codex',
          label: 'Validate wave-1',
	          spec: { goal: 'Validate wave-1', baseBranch: 'main', role: 'viewer' },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42', '--wave', 'wave-1', '--expected-lane', 'a', '--expected-lane', 'b'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  fs.rmSync(tmp, { recursive: true, force: true });
	  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareValidation', 'getState', 'streamTrackedGithubProjects']);
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'wave_not_ready');
  assert.deepEqual(err.details.verdict.missingLanes, ['b']);
});

test('mission validate --wave refuses to launch validator while a lane is nonterminal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wave-gate-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  // One terminal lane (laneStatus=done) and one busy lane in wave-1.
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      tsk_done: {
        taskId: 'tsk_done',
        workspaceId: 'prj_42',
        waveId: 'wave-1',
        laneId: 'a',
        branch: 'b',
        worktreePath: '/w',
        laneStatus: 'done',
      },
      tsk_busy: {
        taskId: 'tsk_busy',
        workspaceId: 'prj_42',
        waveId: 'wave-1',
        laneId: 'b',
        branch: 'b2',
        worktreePath: '/w2',
      },
    })
  );

  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareValidation') {
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'claude',
          label: 'Validate wave-1',
	          spec: { goal: 'Validate wave-1', baseBranch: 'main', role: 'viewer' },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42', '--wave', 'wave-1'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  // Gate must refuse to launch — only missionPrepareValidation runs.
	  assert.deepEqual(requests.map((req) => req.method), ['missionPrepareValidation', 'getState', 'streamTrackedGithubProjects']);
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'wave_not_ready');
  assert.match(err.message, /wave wave-1 not ready/);
  assert.equal(err.details.verdict.ready, false);
  assert.deepEqual(err.details.verdict.nonterminalLanes, ['b']);
});

test('mission sync blocks before reading worker stream when sync audit proof is missing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-missing-sync-audit-'));
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  taskId: 'tsk_42',
                  streamId: 'variant:var_42',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_USER_DATA_TAG: `missing-sync-${Date.now()}`,
        ACE_TEST_AUDIT_PROOF: '0',
      },
      { cwd }
    )
  );

  fs.rmSync(cwd, { recursive: true, force: true });
	  assert.deepEqual(requests.map((req) => req.method), ['missionBoard', 'getState', 'streamTrackedGithubProjects']);
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'tool_audit_missing');
  assert.match(err.message, /mission sync blocked by tool audit/);
  assert.match(err.message, /missing orchestrator.sync events: screen\|state\|task result\|run list\|mission next/);
});

test('sync audit is satisfied by scoped task result + run list run with --role/--phase', () => {
  // Defect 5: mission sync used to require a prior mission sync. The new
  // proof group is observability commands. Running `task result` and
  // `run list` with the right --role/--phase scope must auto-record
  // proof events that satisfy a subsequent orchestrator.sync audit.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-defect5-task-result-'));
  fs.mkdirSync(path.join(projectDir, '.ace', 'run', 'run_42'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.ace', 'run', 'run_42', 'completion.json'),
    JSON.stringify({
      schema: 'ace.completion_result.v1',
      runId: 'run_42',
      outcome: 'done',
      detail: 'done',
    })
  );

  const tr = run(
    [
      '--json',
      'task',
      'result',
      '--run',
      'run_42',
      '--role',
      'orchestrator',
      '--phase',
      'sync',
      '--workspace',
      'prj_42',
      '--mission',
      'msn_42',
      '--project-dir',
      projectDir,
    ],
    { ACE_TEST_AUDIT_PROOF: '0' }
  );
  assert.equal(tr.status, 0, `task result stderr=${tr.stderr}`);

  const rl = run(
    [
      '--json',
      'run',
      'list',
      '--role',
      'orchestrator',
      '--phase',
      'sync',
      '--workspace',
      'prj_42',
      '--mission',
      'msn_42',
      '--project-dir',
      projectDir,
    ],
    { ACE_TEST_AUDIT_PROOF: '0' }
  );
  assert.equal(rl.status, 0, `run list stderr=${rl.stderr}`);

  const ledgerPath = path.join(projectDir, '.ace', 'tool-usage.ndjson');
  const ledger = fs
    .readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const commandsSeen = ledger.map((event: any) => event.command);
  assert.ok(commandsSeen.includes('task result'), `ledger missing task result: ${commandsSeen.join(',')}`);
  assert.ok(commandsSeen.includes('run list'), `ledger missing run list: ${commandsSeen.join(',')}`);
  for (const event of ledger) {
    if (event.command === 'task result' || event.command === 'run list') {
      assert.equal(event.role, 'orchestrator');
      assert.equal(event.phase, 'sync');
    }
  }

  const audit = run(
    [
      'tool',
      'audit',
      '--role',
      'orchestrator',
      '--phase',
      'sync',
      '--workspace',
      'prj_42',
      '--mission',
      'msn_42',
      '--project-dir',
      projectDir,
    ],
    { ACE_TEST_AUDIT_PROOF: '0' }
  );
  assert.equal(audit.status, 0, `audit stderr=${audit.stderr}`);
  const auditData = parseLine(audit.stdout).data;
  assert.equal(auditData.ok, true);
  assert.deepEqual(auditData.missingRequiredEvents, []);

  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('sync audit is satisfied by scoped screen + mission next from the same run', async () => {
  // Defect 5: the new proof group also accepts screen + mission next. Both
  // route through the socket but auto-record under the same CLI context so
  // a scoped sync audit can recognize them as proof.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-defect5-screen-next-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });

  await withSocketServer(
    (req: any) => {
      if (req.method === 'streamReadScreen') {
        return { text: 'worker output' };
      }
      if (req.method === 'missionNextAction') {
        return { featureId: req.params?.featureId || null, next: null };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    async (sockPath: string) => {
      const sc = await runAsync(
        [
          '--json',
          'screen',
          'variant:var_42',
          '--tail',
          '100',
          '--role',
          'orchestrator',
          '--phase',
          'sync',
          '--workspace',
          'prj_42',
          '--mission',
          'msn_42',
          '--project-dir',
          projectDir,
        ],
        {
          ACE_SOCK: sockPath,
          ACE_URL: '',
          ACE_TOKEN: '',
          ACE_TEST_AUDIT_PROOF: '0',
        }
      );
      assert.equal(sc.status, 0, `screen stderr=${sc.stderr}`);

      const mn = await runAsync(
        [
          '--json',
          'mission',
          'next',
          '--feature',
          'ft_42',
          '--mission',
          'msn_42',
          '--workspace',
          'prj_42',
          '--role',
          'orchestrator',
          '--phase',
          'sync',
          '--project-dir',
          projectDir,
        ],
        {
          ACE_SOCK: sockPath,
          ACE_URL: '',
          ACE_TOKEN: '',
          ACE_TEST_AUDIT_PROOF: '0',
        }
      );
      assert.equal(mn.status, 0, `mission next stderr=${mn.stderr}`);
    }
  );

  const ledgerPath = path.join(projectDir, '.ace', 'tool-usage.ndjson');
  const ledger = fs
    .readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const commandsSeen = ledger.map((event: any) => event.command);
  assert.ok(commandsSeen.includes('screen'), `ledger missing screen: ${commandsSeen.join(',')}`);
  assert.ok(commandsSeen.includes('mission next'), `ledger missing mission next: ${commandsSeen.join(',')}`);

  const audit = run(
    [
      'tool',
      'audit',
      '--role',
      'orchestrator',
      '--phase',
      'sync',
      '--workspace',
      'prj_42',
      '--mission',
      'msn_42',
      '--project-dir',
      projectDir,
    ],
    { ACE_TEST_AUDIT_PROOF: '0' }
  );
  assert.equal(audit.status, 0, `audit stderr=${audit.stderr}`);
  const auditData = parseLine(audit.stdout).data;
  assert.equal(auditData.ok, true);
  assert.deepEqual(auditData.missingRequiredEvents, []);

  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('mission sync parses DONE trailer and updates the attached feature', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  streamId: 'variant:var_42',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCompletionList') return { completions: [] };
	      if (req.method === 'streamReadScreen') {
        assert.deepEqual(req.params, { streamId: 'variant:var_42', tail: 300 });
        return { text: 'worker output\nDONE: implemented native dispatch\n' };
      }
      if (req.method === 'missionSyncFeature') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          outcome: 'done',
          detail: 'implemented native dispatch',
          taskId: null,
          streamId: 'variant:var_42',
          rootTaskId: null,
          parentTaskId: null,
          isRootGoalAgent: true,
          isInternalSubagent: false,
          source: 'terminal_trailer',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          streamId: 'variant:var_42',
          synced: true,
          outcome: 'done',
          status: 'completed',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42', '--tail', '300'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
	  assert.deepEqual(requests.map((req) => req.method), [
	    'missionBoard',
	    'getState',
	    'streamTrackedGithubProjects',
	    'streamCompletionList',
	    'streamReadScreen',
	    'missionSyncFeature',
	  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, true);
  assert.equal(env.data.outcome, 'done');
  assert.equal(env.data.status, 'completed');
});

test('mission sync consumes completion inbox before reading terminal stream', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  taskId: 'tsk_42',
                  streamId: 'variant:var_42',
                  branch: 'feat/x',
                  worktreePath: '/tmp/wt',
                },
              ],
            },
          ],
        };
      }
      const workspaceLookup = emptyWorkspaceLookup(req);
      if (workspaceLookup) return workspaceLookup;
      if (req.method === 'streamCompletionList') {
        assert.deepEqual(req.params, {
          workspaceId: 'prj_42',
          streamId: 'variant:var_42',
        });
        return {
          completions: [
            {
              id: 'cmp_1',
              kind: 'done',
              missionId: 'msn_42',
              laneId: 'ft_42',
              taskId: 'tsk_42',
              streamId: 'variant:var_42',
              detail: 'inbox done',
              prUrl: 'https://github.com/o/r/pull/270',
              prNumber: 270,
              branch: 'feat/x',
              worktreePath: '/tmp/wt',
            },
          ],
        };
      }
      if (req.method === 'missionSyncFeature') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          outcome: 'done',
          detail: 'inbox done',
          prUrl: 'https://github.com/o/r/pull/270',
          prNumber: 270,
          taskId: 'tsk_42',
          streamId: 'variant:var_42',
          rootTaskId: 'tsk_42',
          parentTaskId: null,
          isRootGoalAgent: true,
          isInternalSubagent: false,
          branch: 'feat/x',
          worktreePath: '/tmp/wt',
          source: 'completion_inbox',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          streamId: 'variant:var_42',
          synced: true,
          outcome: 'done',
          status: 'completed',
        };
      }
      if (req.method === 'streamCompletionAck') {
        assert.deepEqual(req.params, { id: 'cmp_1' });
        return { ok: true };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), [
    'missionBoard',
    'getState',
    'streamTrackedGithubProjects',
    'streamCompletionList',
    'missionSyncFeature',
    'streamCompletionAck',
  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, true);
  assert.equal(env.data.outcome, 'done');
  assert.equal(env.data.source, 'completion_inbox');
  assert.equal(env.data.completionId, 'cmp_1');
});

test('mission sync records child completion without advancing mission lifecycle', async () => {
  const requests: any[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-child-completion-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  taskId: 'tsk_root',
                  streamId: 'variant:root',
                },
              ],
            },
          ],
        };
      }
      const workspaceLookup = emptyWorkspaceLookup(req);
      if (workspaceLookup) return workspaceLookup;
      if (req.method === 'streamCompletionList') {
        return {
          completions: [
            {
              id: 'cmp_child',
              kind: 'done',
              missionId: 'msn_42',
              laneId: 'ft_42',
              taskId: 'tsk_child',
              streamId: 'variant:child',
              parentTaskId: 'tsk_root',
              rootTaskId: 'tsk_root',
              isInternalSubagent: true,
              detail: 'child helper done',
            },
          ],
        };
      }
      if (req.method === 'streamCompletionAck') {
        assert.deepEqual(req.params, { id: 'cmp_child' });
        return { ok: true };
      }
      if (req.method === 'streamReadScreen') throw new Error('must not read root terminal for child completion');
      if (req.method === 'missionSyncFeature') throw new Error('child completion must not advance mission feature');
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), [
    'missionBoard',
    'getState',
    'streamTrackedGithubProjects',
    'streamCompletionList',
    'streamCompletionAck',
  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, false);
  assert.equal(env.data.outcome, 'child-recorded');
  assert.match(env.data.detail, /waiting for root GoalAgent/);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(registry.tsk_child.isInternalSubagent, true);
  assert.equal(registry.tsk_child.rootTaskId, 'tsk_root');
});

test('mission sync does not ack completion inbox before successful sync', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  taskId: 'tsk_42',
                  streamId: 'variant:var_42',
                },
              ],
            },
          ],
        };
      }
      const workspaceLookup = emptyWorkspaceLookup(req);
      if (workspaceLookup) return workspaceLookup;
      if (req.method === 'streamCompletionList') {
        return {
          completions: [
            {
              id: 'cmp_1',
              kind: 'done',
              missionId: 'msn_42',
              laneId: 'ft_42',
              taskId: 'tsk_42',
              streamId: 'variant:var_42',
              detail: 'inbox done',
            },
          ],
        };
      }
      if (req.method === 'missionSyncFeature') {
        assert.equal(req.params.source, 'completion_inbox');
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          streamId: 'variant:var_42',
          synced: false,
          outcome: 'done',
          status: 'in_progress',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), [
    'missionBoard',
    'getState',
    'streamTrackedGithubProjects',
    'streamCompletionList',
    'missionSyncFeature',
  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, false);
  assert.equal(env.data.source, 'completion_inbox');
  assert.equal(env.data.completionId, 'cmp_1');
});

test('mission sync returns checkedSources when attachment recovery fails', async () => {
  const r = await withSocketServer(
    (req: any) => {
      const workspaceLookup = emptyWorkspaceLookup(req);
      if (workspaceLookup) return workspaceLookup;
      if (req.method === 'missionBoard') {
        return {
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [{ id: 'ft_42', missionId: 'msn_42', workspaceId: 'prj_42' }],
            },
          ],
        };
      }
      if (req.method === 'missionRecoverAttachment') {
        return {
          recovered: false,
          attached: false,
          reason: 'no recoverable attachment found',
          checkedSources: ['mission_events.payload_json', '.ace/events.ndjson', 'variants.task_id', 'worktrees.task_id'],
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.synced, false);
  assert.deepEqual(data.checkedSources, ['mission_events.payload_json', '.ace/events.ndjson', 'variants.task_id', 'worktrees.task_id']);
});

test('mission sync parses bullet-prefixed and plain DONE/BLOCKED trailers with prompt noise', async () => {
  const cases = [
    {
      name: 'bullet done',
      text: 'worker output\n• DONE: implemented bullet sync\n❯ \n',
      outcome: 'done',
      detail: 'implemented bullet sync',
      status: 'completed',
    },
    {
      name: 'plain done',
      text: 'worker output\nDONE: implemented plain sync\n❯ \n',
      outcome: 'done',
      detail: 'implemented plain sync',
      status: 'completed',
    },
    {
      name: 'bullet blocked',
      text: 'worker output\n• BLOCKED: missing approval\n❯ \n',
      outcome: 'blocked',
      detail: 'missing approval',
      status: 'blocked',
    },
    {
      name: 'plain blocked',
      text: 'worker output\nBLOCKED: missing token\n❯ \n',
      outcome: 'blocked',
      detail: 'missing token',
      status: 'blocked',
    },
    {
      name: 'codex footer done',
      text: [
        'worker output',
        '• DONE: no-code live mission smoke verified',
        '',
        '─ Worked for 2m 42s ────────────────────────────────────────────────────────────────────────────────────────────────────',
        '',
        '',
        '› Summarize recent commits',
        '',
        '  gpt-5.5 medium · ~/Projects/Ace/.ace/worktrees/mission-msn-6a59b300-harness-liv-feat',
      ].join('\n'),
      outcome: 'done',
      detail: 'no-code live mission smoke verified',
      status: 'completed',
    },
    {
      name: 'wrapped codex done',
      text: [
        'worker output',
        '• DONE: PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable',
        ' with passing lint-and-b',
        '  uild, package asset evidence for completion-result.cjs and .ace-template',
        '',
        '─ Worked for 1m 46s ────────────────────────────────────────────────────────────────────────────────────────────────────',
        '› gpt-5.5 high · ~/Projects/Ace/.ace/worktrees/mission-msn-2846247e-package-har-feat',
      ].join('\n'),
      outcome: 'done',
      detail:
        'PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable with passing lint-and-b uild, package asset evidence for completion-result.cjs and .ace-template',
      status: 'completed',
    },
    {
      name: 'wrapped codex done with bare composer prompt',
      text: [
        'worker output',
        '• DONE: PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable',
        ' with passing lint-and-b',
        '  uild, package asset evidence for completion-result.cjs and .ace-template',
        '›▌',
      ].join('\n'),
      outcome: 'done',
      detail:
        'PR #233 is ready for validator review: https://github.com/example-org/example-project/pull/233 is open/mergeable with passing lint-and-b uild, package asset evidence for completion-result.cjs and .ace-template',
      status: 'completed',
    },
    {
      name: 'bullet codex done with unindented hard wrap',
      text: [
        'worker output',
        '• DONE: simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287',
        'open with evidence recorded.',
        '›▌',
      ].join('\n'),
      outcome: 'done',
      detail:
        'simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287 open with evidence recorded.',
      status: 'completed',
    },
    {
      name: 'wrapped blocked with goal footer',
      text: [
        'worker output',
        '• BLOCKED: GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is',
        '  authorized for edits.',
        'Use /skills to list available skills',
        'gpt-5.5 high fast · ~/Projects/Ace',
        'Goal blocked (/goal resume)',
        'tokens used: 12345',
      ].join('\n'),
      outcome: 'blocked',
      detail:
        'GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is authorized for edits.',
      status: 'blocked',
    },
  ];

  for (const fixture of cases) {
    const requests: any[] = [];
    const r = await withSocketServer(
      (req: any) => {
        requests.push(req);
        if (req.method === 'missionBoard') {
          return {
            filters: req.params,
            totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
            missions: [
              {
                id: 'msn_42',
                workspaceId: 'prj_42',
                cards: [
                  {
                    id: 'ft_42',
                    missionId: 'msn_42',
                    workspaceId: 'prj_42',
                    streamId: 'variant:var_42',
                  },
                ],
              },
	            ],
	          };
	        }
	        const workspaceLookup = emptyWorkspaceLookup(req);
	        if (workspaceLookup) return workspaceLookup;
	        if (req.method === 'streamCompletionList') return { completions: [] };
	        if (req.method === 'streamReadScreen') {
          return { text: fixture.text };
        }
        if (req.method === 'missionSyncFeature') {
          assert.deepEqual(req.params, {
            featureId: 'ft_42',
            missionId: 'msn_42',
            workspaceId: 'prj_42',
            outcome: fixture.outcome,
            detail: fixture.detail,
            taskId: null,
            streamId: 'variant:var_42',
            rootTaskId: null,
            parentTaskId: null,
            isRootGoalAgent: true,
            isInternalSubagent: false,
            source: 'terminal_trailer',
          }, fixture.name);
          return {
            featureId: 'ft_42',
            missionId: 'msn_42',
            streamId: 'variant:var_42',
            synced: true,
            outcome: fixture.outcome,
            status: fixture.status,
          };
        }
        throw new Error(`unexpected method ${req.method}`);
      },
      (sockPath: any) => runAsync(
        ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
        {
          ACE_SOCK: sockPath,
          ACE_URL: '',
          ACE_TOKEN: '',
        }
      )
    );

    assert.equal(r.status, 0, `${fixture.name}: stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.deepEqual(
      requests.map((req) => req.method),
	      ['missionBoard', 'getState', 'streamTrackedGithubProjects', 'streamCompletionList', 'streamReadScreen', 'missionSyncFeature'],
	      fixture.name
	    );
    const env = parseLine(r.stdout);
    assert.equal(env.ok, true, fixture.name);
    assert.equal(env.data.synced, true, fixture.name);
    assert.equal(env.data.outcome, fixture.outcome, fixture.name);
    assert.equal(env.data.status, fixture.status, fixture.name);
  }
});

test('mission sync ignores non-final DONE text in the worker tail', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  streamId: 'variant:var_42',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCompletionList') return { completions: [] };
	      if (req.method === 'streamReadScreen') {
        return { text: '# Escape hatch\nEnd with DONE: <one-line summary>\nworker still running\n' };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
	  assert.deepEqual(requests.map((req) => req.method), ['missionBoard', 'getState', 'streamTrackedGithubProjects', 'streamCompletionList', 'streamReadScreen']);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, false);
  assert.equal(env.data.outcome, 'none');
});

test('mission sync ignores stale DONE followed by substantive assistant text', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  streamId: 'variant:var_42',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCompletionList') return { completions: [] };
	      if (req.method === 'streamReadScreen') {
        return { text: 'DONE: almost finished\nActually I still need to edit files.\n' };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.deepEqual(requests.map((req) => req.method), ['missionBoard', 'getState', 'streamTrackedGithubProjects', 'streamCompletionList', 'streamReadScreen']);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, false);
  assert.equal(env.data.outcome, 'none');
});

test('mission sync terminalizes child-registry row so mission validate --wave can launch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-sync-wave-'));
  const registryPath = path.join(tmp, 'child-registry.json');
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      tsk_lane: {
        taskId: 'tsk_lane',
        workspaceId: 'prj_42',
        waveId: 'wave-1',
        laneId: 'ft_42',
        branch: 'feat/lane',
        worktreePath: '/tmp/lane',
      },
    })
  );

  const requests: any[] = [];
  const result: any = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  taskId: 'tsk_lane',
                  streamId: 'variant:var_42',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCompletionList') return { completions: [] };
	      if (req.method === 'streamReadScreen') {
        return { text: 'worker output\nDONE: implemented wave lane\n' };
      }
      if (req.method === 'missionSyncFeature') {
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          streamId: 'variant:var_42',
          synced: true,
          outcome: 'done',
          status: 'completed',
        };
      }
      if (req.method === 'missionPrepareValidation') {
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          agent: 'claude',
          label: 'Validate wave-1',
          spec: {
            goal: 'Validate wave-1',
            baseBranch: 'main',
            role: 'viewer',
            scope: { workspaceId: 'prj_42', missionId: 'msn_42', featureId: 'ft_42' },
            taskType: 'code-review',
            effort: 'high',
            effortOverrideReason: 'Chief doctrine: Mission validators run as visible Codex-high chat validators',
            context: 'Wave validation',
            constraints: ['Read-only validation'],
            deliverables: ['Verdict'],
            acceptance: ['Wave validated'],
            requireChanges: false,
          },
	        };
	      }
	      if (req.method === 'streamCreateDelegatedTask') {
        return {
          taskId: 'tsk_val',
          variantId: 'var_val',
          worktreeId: 'wt_val',
          worktreePath: '/tmp/val',
          branch: 'validate/wave-1',
          baseBranch: 'main',
        };
      }
      if (req.method === 'streamSpawn') {
        assert.equal(req.params.kind, 'chat');
        assert.equal(req.params.launchIntent.reasoningEffort, 'high');
        return { taskId: 'tsk_val', conversationId: 'conv_val', streamId: 'conversation:conv_val' };
      }
      if (req.method === 'streamWaitFor') return { matched: 'awaiting-input', elapsedMs: 1 };
      if (req.method === 'streamSendSubmit') return { ok: true, telemetry: { promptMs: 1 } };
      if (req.method === 'missionAttachValidation') {
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          validatorTaskId: 'tsk_val',
          validatorStreamId: 'conversation:conv_val',
          validatorWorktreePath: null,
          validatorBranch: null,
          validatorAgent: 'codex',
          validationStatus: 'validating',
          gateStatus: 'blocked',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    async (sockPath: any) => {
      const env = {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_PERSONAL_IDENTITY: 'rook',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_CHILD_REGISTRY_PATH: registryPath,
      };
      const sync = await runAsync(
        ['mission', 'sync', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42'],
        env
      );
      const rowAfterSync = JSON.parse(fs.readFileSync(registryPath, 'utf8')).tsk_lane;
      const validate = await runAsync(
        ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--workspace', 'prj_42', '--wave', 'wave-1', '--expected-lane', 'ft_42'],
        env
      );
      return { sync, validate, rowAfterSync };
    }
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.sync.status, 0, `stdout=${result.sync.stdout}; stderr=${result.sync.stderr}`);
  assert.equal(result.rowAfterSync.laneStatus, 'done');
  assert.equal(result.rowAfterSync.lastTrailer, 'implemented wave lane');
  assert.equal(typeof result.rowAfterSync.terminalAt, 'number');
  assert.equal(result.validate.status, 0, `stdout=${result.validate.stdout}; stderr=${result.validate.stderr}`);
  assert.ok(requests.some((req) => req.method === 'streamCreateDelegatedTask'), 'validator should launch after synced lane is terminal');
});

test('mission validate --rerun preserves rerun intent through prepare and attach', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionPrepareValidation') {
        assert.equal(req.params.rerun, true);
        return {
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          featureId: 'ft_42',
          milestoneId: 'ms_1',
          agent: 'codex',
          label: 'Revalidate msn_42: Ready card',
          spec: {
            goal: 'Revalidate mission feature: Ready card',
            baseBranch: 'ace/mission-ft-42',
            role: 'viewer',
            scope: { workspaceId: 'prj_42', missionId: 'msn_42', featureId: 'ft_42' },
            taskType: 'code-review',
            effort: 'high',
            effortOverrideReason: 'Chief doctrine: Mission validators run as visible Codex-high chat validators',
            context: 'Previous validation handoff: failed',
            constraints: ['Read-only validation'],
            deliverables: ['Verdict'],
            acceptance: ['Card validated'],
            requireChanges: false,
	          },
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamCreateDelegatedTask') {
	        return {
          taskId: 'tsk_val_2',
          variantId: 'var_val_2',
          worktreeId: 'wt_val_2',
          worktreePath: '/tmp/ace/wt_val_2',
          branch: 'ace/revalidate-ft-42',
        };
      }
      if (req.method === 'streamSpawnIntoVariant') {
        assert.equal(req.params.variantId, 'var_val_2');
        assert.equal(req.params.launchIntent.reasoningEffort, 'high');
        return { streamId: 'conversation:var_val_2' };
      }
      if (req.method === 'streamWaitFor') return { matched: 'awaiting-input', elapsedMs: 1 };
      if (req.method === 'streamSendSubmit') return { ok: true };
      if (req.method === 'missionAttachValidation') {
        assert.equal(req.params.rerun, true);
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          validatorTaskId: 'tsk_val_2',
          validatorStreamId: 'conversation:conv_val_2',
          validationStatus: 'validating',
          gateStatus: 'blocked',
          validationAttempts: [{ validatorTaskId: 'tsk_old' }],
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'validate', '--feature', 'ft_42', '--mission', 'msn_42', '--rerun'],
      { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '', ACE_WORKSPACE_ID: 'prj_42' }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
	  assert.deepEqual(requests.map((req) => req.method), [
	    'missionPrepareValidation',
	    'getState',
	    'streamTrackedGithubProjects',
	    'streamCreateDelegatedTask',
	    'streamSpawnIntoVariant',
	    'streamWaitFor',
	    'streamSendSubmit',
	    'missionAttachValidation',
	  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.data.validationAttempts.length, 1);
});

test('mission link-pr, fixback, attach-validator, release-gate, and integrate gate avoid merge side effects', async () => {
  const requests: any[] = [];
  const runWith = (args: string[]) => withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionLinkPr') {
        return { missionId: 'msn_42', featureId: 'ft_42', workspaceId: 'prj_42', status: 'linked', pr: { number: 17 } };
      }
      if (req.method === 'missionFixback') {
        return {
          missionId: 'msn_42',
          featureId: 'ft_42',
          status: 'FIXBACK',
          target: { taskId: 'tsk_42', branch: 'feat/x', prNumber: 17 },
          validationFailurePacket: { schema: 'ValidationFailurePacket/v1' },
          fixback: { attempts: 1, maxAttempts: 3, remaining: 2, exhausted: false },
        };
      }
      if (req.method === 'missionAttachValidatorEvidence') {
        return {
          missionId: 'msn_42',
          featureId: 'ft_42',
          workspaceId: 'prj_42',
          validatorStreamId: 'conversation:validator',
          validationStatus: req.params.verdict === 'PASS' ? 'validation_passed' : 'validation_failed',
          gateStatus: req.params.verdict === 'PASS' ? 'merge_ready' : 'blocked',
          synced: true,
          verdict: req.params.verdict,
        };
      }
      if (req.method === 'missionReleaseGate') {
        return { status: 'BLOCKED', action: 'package', release: { performsAction: false }, blockers: [] };
      }
      if (req.method === 'integrationGate') {
        return { ok: true, phase: 'blocked', action: 'gatePr', result: { status: 'BLOCKED', noMutation: { merges: false, cleanup: false } } };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(args, {
      ACE_SOCK: sockPath,
      ACE_URL: '',
      ACE_TOKEN: '',
      ACE_AGENT: '',
      ACE_PERSONAL_IDENTITY: '',
      ACE_STREAM_ID: '',
      ACE_TASK_ID: '',
    })
  );

  assert.equal((await runWith(['mission', 'link-pr', '--feature', 'ft_42', '--pr', '17', '--url', 'https://github.com/acme/ace/pull/17', '--task', 'tsk_42', '--branch', 'feat/x'])).status, 0);
  assert.equal((await runWith(['mission', 'fixback', '--feature', 'ft_42', '--reason', 'failed_pr_checks', '--detail', 'lint failed'])).status, 0);
  assert.equal((await runWith(['mission', 'attach-validator', '--feature', 'ft_42', '--stream', 'conversation:validator', '--verdict', 'PASS', '--comment-url', '#issuecomment-1'])).status, 0);
  assert.equal((await runWith(['mission', 'attach-validator', '--feature', 'ft_42', '--stream', 'conversation:validator', '--verdict', 'FAIL', '--detail', 'validator requested changes'])).status, 0);
  assert.equal((await runWith(['mission', 'release-gate', '--mission', 'msn_42', '--action', 'package'])).status, 0);
  assert.equal((await runWith(['integrate', 'gate', '--task', 'tsk_42', '--pr', '17'])).status, 0);

  assert.deepEqual(requests.map((req) => req.method), [
    'missionLinkPr',
    'missionFixback',
    'missionAttachValidatorEvidence',
    'missionAttachValidatorEvidence',
    'missionReleaseGate',
    'integrationGate',
  ]);
  assert.ok(!requests.some((req) => /merge|cleanup|delete/i.test(String(req.method))));
  assert.deepEqual(requests[0].params, {
    featureId: 'ft_42',
    missionId: null,
    workspaceId: null,
    pr: '17',
    prUrl: 'https://github.com/acme/ace/pull/17',
    taskId: 'tsk_42',
    branch: 'feat/x',
    headRef: null,
    baseRef: null,
    headSha: null,
    baseSha: null,
    state: null,
    gateDetail: null,
  });
  assert.deepEqual(requests[2].params, {
    featureId: 'ft_42',
    missionId: null,
    workspaceId: null,
    streamId: 'conversation:validator',
    verdict: 'PASS',
    commentUrl: '#issuecomment-1',
    detail: null,
    validatedHeadSha: null,
    validatedBaseSha: null,
    validatorAgent: null,
    taskId: null,
    spawnedByIdentity: null,
    spawnedByStreamId: null,
  });
  assert.deepEqual(requests[3].params, {
    featureId: 'ft_42',
    missionId: null,
    workspaceId: null,
    streamId: 'conversation:validator',
    verdict: 'FAIL',
    commentUrl: null,
    detail: 'validator requested changes',
    validatedHeadSha: null,
    validatedBaseSha: null,
    validatorAgent: null,
    taskId: null,
    spawnedByIdentity: null,
    spawnedByStreamId: null,
  });
});

test('integrate pr-merge forwards explicit allow-path scope', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'integrationMergePr') {
        return { ok: true, phase: 'success', action: 'mergePr', result: { code: 0 } };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      [
        'integrate',
        'pr-merge',
        '--task',
        'tsk_42',
        '--pr',
        '17',
        '--allow-path',
        'src/**',
        '--allow-path',
        'tools/ace/**',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_AGENT: '',
        ACE_PERSONAL_IDENTITY: '',
        ACE_STREAM_ID: '',
        ACE_TASK_ID: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'integrationMergePr');
  assert.deepEqual(requests[0].params.allowedPaths, ['src/**', 'tools/ace/**']);
});

test('mission attach-validator forwards exact head and base evidence', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method !== 'missionAttachValidatorEvidence') {
        throw new Error(`unexpected method ${req.method}`);
      }
      return {
        missionId: 'msn_42',
        featureId: 'ft_42',
        workspaceId: 'prj_42',
        validatorStreamId: req.params.streamId,
        validationStatus: 'validation_passed',
        gateStatus: 'merge_ready',
        synced: true,
      };
    },
    (sockPath: any) => runAsync(
      [
        'mission',
        'attach-validator',
        '--feature',
        'ft_42',
        '--stream',
        'conversation:validator',
        '--verdict',
        'PASS',
        '--head',
        'head-sha-123',
        '--base-sha',
        'base-sha-456',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.validatedHeadSha, 'head-sha-123');
  assert.equal(requests[0].params.validatedBaseSha, 'base-sha-456');
});

test('smoke mission-lifecycle verifies no-code lifecycle without product side effects', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-smoke-lifecycle-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-smoke-wiki-'));
  const currentStatePath = path.join(wikiDir, 'dashboards', 'current-state.md');
  const logPath = path.join(wikiDir, 'log.md');
  fs.mkdirSync(path.dirname(currentStatePath), { recursive: true });
  const nextByCall = [
    'dispatch_goal_worker',
    'sync_worker',
    'dispatch_goal_validator',
    'sync_worker',
    'dispatch_release_goal',
  ];
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'getState') return { workspaces: [{ id: 'prj_42', path: projectDir }] };
      if (req.method === 'streamTrackedGithubProjects') return { projects: [{ workspaceId: 'prj_42', workspacePath: projectDir }] };
      if (req.method === 'missionBoard') return { totals: { missions: 0, cards: 0 }, missions: [] };
      if (req.method === 'missionCreate') {
        return { missionId: 'msn_smoke', featureIds: ['ft_smoke'] };
      }
      if (req.method === 'missionNextAction') {
        return { next: nextByCall.shift() || 'dispatch_release_goal', reason: 'smoke' };
      }
      if (req.method === 'missionAttachDispatch') {
        fs.appendFileSync(path.join(projectDir, '.ace', 'events.ndjson'), JSON.stringify({ missionId: 'msn_smoke', type: 'worker_stream_attached' }) + '\n');
        fs.writeFileSync(currentStatePath, [
          '# Ace current state',
          '<!-- ace:section:start id=mission:msn_smoke -->',
          '## Mission msn_smoke',
          '- [2026-05-20T00:00:00.000Z] worker.stream.attached (codex) feature=ft_smoke - Worker stream attached: ft_smoke -> conversation:smoke',
          '<!-- ace:section:end id=mission:msn_smoke -->',
          '',
        ].join('\n'));
        return { attached: true, taskId: req.params.taskId, streamId: req.params.streamId };
      }
      if (req.method === 'missionSyncFeature') return { synced: true, outcome: req.params.outcome };
      if (req.method === 'missionAttachValidation') return { attached: true, validatorStreamId: req.params.streamId };
      if (req.method === 'missionGateFeature') return { synced: true, gateStatus: 'merge_ready' };
      if (req.method === 'missionReleaseGate') {
        return {
          status: 'BLOCKED',
          release: { performsAction: false, diagnostic: true, allowed: false },
          blockers: [{ code: 'merged_pr_evidence_missing' }],
        };
      }
      if (req.method === 'integrationGate') {
        return { ok: true, phase: 'blocked', result: { status: 'BLOCKED', noMutation: { merges: false, cleanup: false } } };
      }
      if (req.method === 'missionArchive') return { archivedCount: 1 };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'smoke', 'mission-lifecycle', '--workspace', 'prj_42', '--agent', 'codex', '--no-code', '--expected-runtime-sha', currentGitSha()],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_WIKI_PATH: currentStatePath,
        ACE_WIKI_LOG_PATH: logPath,
      }
    )
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.ok, true);
  assert.equal(data.noCode, true);
  assert.equal(data.productPr, false);
  assert.equal(data.pushed, false);
  assert.equal(data.merged, false);
  for (const step of [
    'mission next fresh',
    'dispatch attaches worker',
    'mission next after dispatch',
    'DONE detection',
    'sync simulated worker',
    'mission next after sync',
    'validate attaches validator',
    'mission next after validate',
    'gate simulated validator',
    'mission next monotonic',
    'release-gate diagnostic',
    'wiki event',
    'safe integration refusal',
    'runtime current',
  ]) {
    assert.ok(data.steps.some((item: any) => item.step === step && item.ok === true), `missing smoke step ${step}`);
  }
  assert.match(fs.readFileSync(logPath, 'utf8'), /mission=msn_smoke/);
  assert.match(fs.readFileSync(currentStatePath, 'utf8'), /msn_smoke/);
  assert.equal(requests.find((req) => req.method === 'missionReleaseGate')?.params.noCode, true);
  assert.ok(!requests.some((req) => /push|merge|cleanup|prOpen/i.test(String(req.method))));
});

test('smoke mission-lifecycle tolerates already validation-passed no-code card', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-smoke-already-valid-'));
  fs.mkdirSync(path.join(projectDir, '.ace'), { recursive: true });
  const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-smoke-wiki-valid-'));
  const currentStatePath = path.join(wikiDir, 'dashboards', 'current-state.md');
  const logPath = path.join(wikiDir, 'log.md');
  fs.mkdirSync(path.dirname(currentStatePath), { recursive: true });
  const nextByCall = [
    'dispatch_goal_worker',
    'sync_worker',
    'dispatch_goal_validator',
    'dispatch_release_goal',
    'dispatch_release_goal',
  ];
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'getState') return { workspaces: [{ id: 'prj_42', path: projectDir }] };
      if (req.method === 'streamTrackedGithubProjects') return { projects: [{ workspaceId: 'prj_42', workspacePath: projectDir }] };
      if (req.method === 'missionBoard') return { totals: { missions: 0, cards: 0 }, missions: [] };
      if (req.method === 'missionCreate') return { missionId: 'msn_smoke', featureIds: ['ft_smoke'] };
      if (req.method === 'missionNextAction') {
        return { next: nextByCall.shift() || 'dispatch_release_goal', reason: 'smoke' };
      }
      if (req.method === 'missionAttachDispatch') {
        fs.appendFileSync(path.join(projectDir, '.ace', 'events.ndjson'), JSON.stringify({ missionId: 'msn_smoke', type: 'worker_stream_attached' }) + '\n');
        fs.writeFileSync(currentStatePath, [
          '# Ace current state',
          '<!-- ace:section:start id=mission:msn_smoke -->',
          '## Mission msn_smoke',
          '- [2026-05-20T00:00:00.000Z] worker.stream.attached (codex) feature=ft_smoke - Worker stream attached: ft_smoke -> conversation:smoke',
          '<!-- ace:section:end id=mission:msn_smoke -->',
          '',
        ].join('\n'));
        return { attached: true, taskId: req.params.taskId, streamId: req.params.streamId };
      }
      if (req.method === 'missionSyncFeature') return { synced: true, outcome: req.params.outcome };
      if (req.method === 'missionAttachValidation') throw new Error('mission feature already passed validation');
      if (req.method === 'missionGateFeature') throw new Error('mission gate should be skipped for already-valid no-code smoke');
      if (req.method === 'missionReleaseGate') {
        return {
          status: 'BLOCKED',
          release: { performsAction: false, diagnostic: true, allowed: false },
          blockers: [{ code: 'merged_pr_evidence_missing' }],
        };
      }
      if (req.method === 'integrationGate') {
        return { ok: true, phase: 'blocked', result: { status: 'BLOCKED', noMutation: { merges: false, cleanup: false } } };
      }
      if (req.method === 'missionArchive') return { archivedCount: 1 };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'smoke', 'mission-lifecycle', '--workspace', 'prj_42', '--agent', 'codex', '--no-code'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_WIKI_PATH: currentStatePath,
        ACE_WIKI_LOG_PATH: logPath,
      }
    )
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.ok, true);
  assert.equal(data.steps.find((item: any) => item.step === 'validate attaches validator')?.validate?.alreadyValid, true);
  assert.equal(data.steps.find((item: any) => item.step === 'gate simulated validator')?.gate?.skipped, true);
  assert.ok(!requests.some((req) => req.method === 'missionGateFeature'));
});

test('mission gate parses validator DONE trailer and records merge readiness without merging', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  validatorStreamId: 'variant:var_val',
                  prHeadSha: 'head-sha-123',
                  prBaseSha: 'base-sha-456',
                  validationAttempts: [
                    {
                      status: 'passed',
                      verdict: 'PASS',
                      validatedHeadSha: 'head-sha-123',
                      validatedBaseSha: 'base-sha-456',
                    },
                  ],
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamReadScreen') {
        assert.deepEqual(req.params, { streamId: 'variant:var_val', tail: 300 });
        return { text: 'validator output\nDONE: validation passed, ready for review merge\n' };
      }
      if (req.method === 'missionGateFeature') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          outcome: 'done',
          detail: 'validation passed, ready for review merge',
          currentHeadSha: 'head-sha-123',
          validatedHeadSha: 'head-sha-123',
          validatedBaseSha: 'base-sha-456',
          validatorText: 'validator output\nDONE: validation passed, ready for review merge\n',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          validatorStreamId: 'variant:var_val',
          synced: true,
          outcome: 'done',
          validationStatus: 'validation_passed',
          gateStatus: 'merge_ready',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'gate', '--feature', 'ft_42', '--mission', 'msn_42', '--tail', '300'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
	  assert.deepEqual(requests.map((req) => req.method), [
	    'missionBoard',
	    'getState',
	    'streamTrackedGithubProjects',
	    'streamReadScreen',
	    'missionGateFeature',
	  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.synced, true);
  assert.equal(env.data.outcome, 'done');
  assert.equal(env.data.gateStatus, 'merge_ready');
  assert.ok(!requests.some((req) => String(req.method).toLowerCase().includes('merge')));
});

test('mission gate parses validator BLOCKED trailer and returns blocker evidence', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'missionBoard') {
        return {
          filters: req.params,
          totals: { missions: 1, cards: 1, ready: 0, blocked: 0 },
          missions: [
            {
              id: 'msn_42',
              workspaceId: 'prj_42',
              activeControllerIdentity: 'rook',
              cards: [
                {
                  id: 'ft_42',
                  missionId: 'msn_42',
                  workspaceId: 'prj_42',
                  activeControllerIdentity: 'rook',
                  validatorAgent: 'claude',
                  validatorStreamId: 'variant:var_val',
                  validatorSpawnedByIdentity: 'king',
                  validatorSpawnedByStreamId: 'conversation:king',
                },
              ],
            },
	          ],
	        };
	      }
	      const workspaceLookup = emptyWorkspaceLookup(req);
	      if (workspaceLookup) return workspaceLookup;
	      if (req.method === 'streamReadScreen') {
        return { text: 'validator output\nBLOCKED: npm run lint failed at src/foo.ts:12\n' };
      }
      if (req.method === 'missionGateFeature') {
        assert.deepEqual(req.params, {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          outcome: 'blocked',
          detail: 'npm run lint failed at src/foo.ts:12',
          currentHeadSha: null,
          validatedHeadSha: null,
          validatedBaseSha: null,
          validatorText: 'validator output\nBLOCKED: npm run lint failed at src/foo.ts:12\n',
        });
        return {
          featureId: 'ft_42',
          missionId: 'msn_42',
          workspaceId: 'prj_42',
          validatorStreamId: 'variant:var_val',
          synced: true,
          outcome: 'blocked',
          detail: 'npm run lint failed at src/foo.ts:12',
          activeControllerIdentity: 'rook',
          validatorAgent: 'claude',
          validatorSpawnedByIdentity: 'king',
          validatorSpawnedByStreamId: 'conversation:king',
          validationStatus: 'validation_failed',
          gateStatus: 'blocked',
          validationHandoff: 'npm run lint failed at src/foo.ts:12',
          gateDetail: 'npm run lint failed at src/foo.ts:12',
          blockerEvidence: 'npm run lint failed at src/foo.ts:12',
        };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['mission', 'gate', '--feature', 'ft_42', '--mission', 'msn_42'],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
	  assert.deepEqual(requests.map((req) => req.method), [
	    'missionBoard',
	    'getState',
	    'streamTrackedGithubProjects',
	    'streamReadScreen',
	    'missionGateFeature',
	  ]);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.gateStatus, 'blocked');
  assert.equal(env.data.activeControllerIdentity, 'rook');
  assert.equal(env.data.validatorSpawnedByIdentity, 'king');
  assert.equal(env.data.validatorSpawnedByStreamId, 'conversation:king');
  assert.equal(env.data.gateDetail, 'npm run lint failed at src/foo.ts:12');
  assert.equal(env.data.blockerEvidence, 'npm run lint failed at src/foo.ts:12');
  assert.ok(!requests.some((req) => String(req.method).toLowerCase().includes('merge')));
});

test('task run --new-task --goal submits a run-ledger intent to the spine (no premature dispatch)', async () => {
  // Post-#495, a NEW dispatch is the run-ledger spine's job: `task run --new-task`
  // submits an intent (mints run-1) and the spine drives dispatch→validate→gate
  // asynchronously. The CLI therefore reports honest INTAKE ('submitted', NOT
  // 'dispatched'): no worker stream/task/worktree exists at this point — the
  // board flips to dispatched only once a real one is created and linked.
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'runSubmit') return { runId: 'run-1' };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      [
        '--json',
        'task',
        'run',
        'claude',
        '--workspace',
        'prj-inline',
        '--new-task',
        '--refresh-base',
        'force',
        '--goal',
        'Wire canonical specs',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_BASE_BRANCH: 'dev',
        ACE_WORKSPACE_ID: 'prj-inline',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_PERSONAL_IDENTITY: 'Rook',
        ACE_AGENT: 'hermes',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  // Honest intake: the spine accepted the run; nothing is dispatched yet.
  assert.equal(env.data.outcome, 'submitted');
  assert.equal(env.data.runId, 'run-1');
  assert.equal(env.data.agent, 'claude');
  assert.equal(env.data.workspaceId, 'prj-inline');
  const methods = requests.map((req) => req.method);
  assert.deepEqual(methods, ['runSubmit'], 'new task is intake-only at the CLI; the spine dispatches');
  assert.ok(!methods.includes('streamSpawnAdhoc'), 'new task path must not use adhoc/headless dispatch');
  const submitReq = requests.find((req) => req.method === 'runSubmit');
  assert.equal(submitReq.params.intent.goal, 'Wire canonical specs');
  assert.equal(submitReq.params.intent.agent, 'claude');
  assert.equal(submitReq.params.intent.scope.workspaceId, 'prj-inline');
});

test('task run --new-task --spec carries the mission scope into the spine intent', async () => {
  // The mission completion-sync now happens inside the spine (Ring-2 completion
  // → fromCompletion → missionSyncFeature), so at the CLI boundary we only assert
  // the INTAKE: the run-ledger intent preserves the TaskSpec's mission scope
  // (workspaceId/missionId/featureId) so the spine can close the right feature.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-run-mission-sync-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Repair mission linkage',
    baseBranch: 'main',
    role: 'editor',
    scope: { workspaceId: 'prj_42', missionId: 'msn_42', featureId: 'ft_42' },
    taskType: 'feature-impl',
    constraints: ['Stay scoped'],
    deliverables: ['Linked mission state'],
    acceptance: ['Feature complete'],
    requireChanges: true,
    requiredSkills: ['ace-github-flow'],
    integrate: { openPr: true, draft: true },
  }), 'utf8');
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'runSubmit') return { runId: 'run-7' };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['--json', 'task', 'run', 'codex', '--workspace', 'prj_42', '--new-task', '--spec', specPath],
      { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '', ACE_WORKSPACE_ID: 'prj_42' }
    )
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const methods = requests.map((req) => req.method);
  assert.deepEqual(methods, ['runSubmit']);
  const submitReq = requests.find((req) => req.method === 'runSubmit');
  assert.equal(submitReq.params.intent.scope.workspaceId, 'prj_42');
  assert.equal(submitReq.params.intent.scope.missionId, 'msn_42');
  assert.equal(submitReq.params.intent.scope.featureId, 'ft_42');
  assert.equal(submitReq.params.intent.taskType, 'feature-impl');
  const env = parseLine(r.stdout);
  assert.equal(env.data.outcome, 'submitted');
  assert.equal(env.data.runId, 'run-7');
});

test('relay passes caller communication metadata to relayed asks', async () => {
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'streamFollow') return { text: '' };
      if (req.method === 'streamAsk') {
        return { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: relayed' };
      }
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      [
        'relay',
        'conversation:a',
        'conversation:b',
        '--seed',
        'please review',
        '--max-rounds',
        '1',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_STREAM_ID: 'conversation:rook',
        ACE_PERSONAL_IDENTITY: 'Rook',
        ACE_AGENT: 'hermes',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const askReq = requests.find((req) => req.method === 'streamAsk');
  assert.ok(askReq, 'expected relay to invoke streamAsk');
  assert.equal(askReq.params.caller.streamId, 'conversation:rook');
  assert.equal(askReq.params.caller.identity, 'Rook');
  assert.equal(askReq.params.caller.agent, 'hermes');
  assert.equal(askReq.params.caller.command, 'relay');
});

test('task run --new-task planning submits a no-code-typed intent to the spine', async () => {
  // The no-code prompt shaping happens inside the spine's dispatch (runTask); at
  // the CLI boundary we assert the intent carries the planning taskType so the
  // spine resolves no-code semantics and skips change verification downstream.
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'runSubmit') return { runId: 'run-3' };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      [
        '--json',
        'task',
        'run',
        'codex',
        '--workspace',
        'prj-inline',
        '--new-task',
        '--task-type',
        'planning',
        '--goal',
        'Plan the rollout order',
      ],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_BASE_BRANCH: 'dev',
        ACE_WORKSPACE_ID: 'prj-inline',
      }
    )
  );

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const methods = requests.map((req) => req.method);
  assert.deepEqual(methods, ['runSubmit']);
  const submitReq = requests.find((req) => req.method === 'runSubmit');
  assert.equal(submitReq.params.intent.taskType, 'planning');
  assert.equal(submitReq.params.intent.goal, 'Plan the rollout order');
  const env = parseLine(r.stdout);
  assert.equal(env.data.outcome, 'submitted');
});

test('task run --new-task --spec honors EXPLICIT capability flags (no silent downgrade) into the spine intent', async () => {
  // Regression: a --spec FILE made loadSpec ignore inline flags, AND the spine
  // intent dropped capability fields — so explicit --tool-mode/--browser-mode/
  // --capability were silently downgraded to the route's 'off' default. The
  // operator's explicit opt-ins must override the file and reach the intent.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-task-run-caps-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    goal: 'Validate the built app with computer use',
    baseBranch: 'main',
    role: 'editor',
    scope: { workspaceId: 'prj_caps' },
    taskType: 'feature-impl',
    acceptance: ['Feature works in the real app'],
    codexRuntimeProfile: 'app-parity',
  }), 'utf8');
  const requests: any[] = [];
  const r = await withSocketServer(
    (req: any) => {
      requests.push(req);
      if (req.method === 'runSubmit') return { runId: 'run-caps' };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      [
        '--json', 'task', 'run', 'codex',
        '--workspace', 'prj_caps',
        '--new-task',
        '--spec', specPath,
        '--tool-mode', 'on',
        '--browser-mode', 'on',
        '--mcp-mode', 'global',
        '--tool-override', 'operator requested computer-use validation',
        '--capability', 'browser',
        '--capability', 'computer-use',
        '--capability', 'runtime',
      ],
      { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '', ACE_WORKSPACE_ID: 'prj_caps' }
    )
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const submitReq = requests.find((req) => req.method === 'runSubmit');
  assert.ok(submitReq, 'intent submitted to the spine');
  assert.equal(submitReq.params.intent.toolMode, 'on');
  assert.equal(submitReq.params.intent.browserMode, 'on');
  assert.equal(submitReq.params.intent.mcpMode, 'global');
  assert.equal(submitReq.params.intent.codexRuntimeProfile, 'app-parity');
  assert.equal(submitReq.params.intent.toolOverrideReason, 'operator requested computer-use validation');
  assert.deepEqual(submitReq.params.intent.capabilities, ['browser', 'computer-use', 'runtime']);
});

function closeoutBoardFixture(extra: any = {}) {
  const prUrl = 'https://github.com/acme/ace/pull/42';
  return {
    columns: { ready_to_review: ['run-closeout'] },
    counts: { total: 1 },
    cards: [{
      id: 'run-closeout',
      stage: extra.stage || 'ready_to_review',
      workspaceId: 'prj_42',
      branch: 'feat/closeout',
      workerOutcome: extra.workerOutcome || 'DONE',
      validationStatus: extra.validationStatus || null,
      prUrl,
      detail: {
        worker: {
          taskId: 'tsk_closeout',
          streamId: 'conversation:worker',
          workspaceId: 'prj_42',
          branch: 'feat/closeout',
          worktreePath: '/tmp/ace-closeout',
          outcome: extra.workerOutcome || 'DONE',
        },
        validator: {
          taskId: 'tsk_validator',
          streamId: extra.validatorStreamId === undefined ? 'conversation:validator' : extra.validatorStreamId,
          outcome: extra.validationStatus || null,
        },
        pr: {
          number: 42,
          url: prUrl,
          state: 'OPEN',
          headSha: extra.projectionHead || 'old-head',
          checkState: 'success',
          mergeable: 'MERGEABLE',
        },
      },
    }],
  };
}

function closeoutGateFixture(headSha: string, failures: any[] = [], extra: any = {}) {
  const ok = failures.length === 0;
  return {
    ok: true,
    phase: ok ? 'passed' : 'blocked',
    action: 'gatePr',
    result: {
      status: ok ? 'PASS' : 'BLOCKED',
      pr: {
        number: 42,
        url: extra.prUrl || 'https://github.com/acme/ace/pull/42',
        state: 'OPEN',
        isDraft: failures.some((failure: any) => failure.code === 'draft_pr'),
        headRefName: 'feat/closeout',
        baseRefName: 'main',
        headSha,
        baseSha: 'base-sha',
        checkState: extra.checkState || (ok ? 'success' : 'failure'),
        mergeable: extra.mergeable || (ok ? 'MERGEABLE' : 'CONFLICTING'),
        files: extra.files || ['tools/ace/src/index.cts'],
        checks: extra.checks || [],
      },
      gate: {
        ok,
        readyToMerge: ok,
        status: ok ? 'PASS' : 'BLOCKED',
        failures,
      },
      validation: { required: true },
      noMutation: { merges: false, cleanup: false },
    },
  };
}

function closeoutRunWith(handler: any, args: string[] = []) {
  const requests: any[] = [];
  const runPromise = withSocketServer(
    (req: any) => {
      requests.push(req);
      return handler(req, requests);
    },
    (sockPath: any) => runAsync(
      ['--json', 'run', 'closeout', '--run', 'run-closeout', '--allow-path', 'tools/ace/src/**', ...args],
      { ACE_SOCK: sockPath, ACE_URL: '', ACE_TOKEN: '' }
    )
  );
  return runPromise.then((result: any) => ({ result, requests }));
}

function followupBoardFixture(extra: any = {}) {
  const withPr = extra.withPr !== false;
  const prUrl = 'https://github.com/acme/ace/pull/42';
  return {
    columns: { ready_to_review: ['run-followup'] },
    counts: { total: 1 },
    cards: [{
      id: 'run-followup',
      stage: extra.stage || 'ready_to_review',
      workspaceId: 'prj_42',
      branch: 'feat/followup',
      workerOutcome: extra.workerOutcome === undefined ? 'DONE' : extra.workerOutcome,
      validationStatus: extra.validationStatus || null,
      prUrl: withPr ? prUrl : null,
      detail: {
        worker: {
          taskId: 'tsk_followup',
          streamId: 'conversation:worker',
          workspaceId: 'prj_42',
          branch: 'feat/followup',
          worktreePath: '/tmp/ace-followup',
          outcome: extra.workerOutcome === undefined ? 'DONE' : extra.workerOutcome,
        },
        validator: {
          taskId: extra.validatorTaskId === undefined ? 'tsk_validator' : extra.validatorTaskId,
          streamId: extra.validatorStreamId === undefined ? 'conversation:validator' : extra.validatorStreamId,
          outcome: extra.validationStatus || null,
        },
        pr: withPr ? {
          number: 42,
          url: prUrl,
          state: 'OPEN',
          headSha: extra.projectionHead || 'old-head',
          checkState: extra.checkState || 'success',
          mergeable: 'MERGEABLE',
        } : {},
        autoship: extra.autoship || {},
      },
    }],
  };
}

function followupGateFixture(headSha: string, failures: any[] = [], extra: any = {}) {
  const ok = failures.length === 0;
  return {
    ok: true,
    phase: ok ? 'passed' : 'blocked',
    action: 'gatePr',
    result: {
      status: ok ? 'PASS' : 'BLOCKED',
      pr: {
        number: 42,
        url: 'https://github.com/acme/ace/pull/42',
        state: 'OPEN',
        isDraft: failures.some((failure: any) => failure.code === 'draft_pr'),
        headRefName: 'feat/followup',
        baseRefName: 'main',
        headSha,
        baseSha: 'base-sha',
        checkState: extra.checkState || (ok ? 'success' : 'failure'),
        mergeable: extra.mergeable || (ok ? 'MERGEABLE' : 'CONFLICTING'),
        files: extra.files || ['tools/ace/src/index.cts'],
        checks: extra.checks || [],
      },
      gate: {
        ok,
        readyToMerge: ok,
        status: ok ? 'PASS' : 'BLOCKED',
        failures,
      },
      validation: { required: true },
      noMutation: { merges: false, cleanup: false },
    },
  };
}

function followupRunWith(handler: any, args: string[] = []) {
  const requests: any[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-followup-cli-'));
  const runPromise = withSocketServer(
    (req: any) => {
      requests.push(req);
      return handler(req, requests);
    },
    (sockPath: any) => runAsync(
      ['--json', 'run', 'followup', '--run', 'run-followup', '--allow-path', 'tools/ace/src/**', ...args],
      {
        ACE_SOCK: sockPath,
        ACE_URL: '',
        ACE_TOKEN: '',
        ACE_CHILD_REGISTRY_PATH: path.join(tmp, 'child-registry.json'),
      }
    )
  );
  return runPromise.then((result: any) => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { result, requests };
  });
}

test('run followup treats DONE case-insensitively and does not infer completion from empty busy output', async () => {
  for (const workerOutcome of ['DONE', 'done']) {
    const { result: r } = await followupRunWith((req: any) => {
      if (req.method === 'runBoard') return followupBoardFixture({ withPr: false, workerOutcome });
      if (req.method === 'streamGetState') return { state: 'awaiting-input' };
      if (req.method === 'streamReadScreen') return { text: '' };
      throw new Error(`unexpected method ${req.method}`);
    });
    assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.equal(parseLine(r.stdout).data.status, 'PR_NEEDED');
  }

  const { result: busy } = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ withPr: false, workerOutcome: null });
    if (req.method === 'streamGetState') return { state: 'busy' };
    if (req.method === 'streamReadScreen') return { text: '' };
    throw new Error(`unexpected method ${req.method}`);
  });
  assert.equal(busy.status, 0, `stdout=${busy.stdout}; stderr=${busy.stderr}`);
  assert.equal(parseLine(busy.stdout).data.status, 'WORKER_ACTIVE');
});

test('run followup --auto recovers a missing PR only through integration gateway push and pr-open', async () => {
  const { result: r, requests } = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ withPr: false });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') return { text: 'DONE: implemented' };
    if (req.method === 'integrationPush') return { ok: true, phase: 'pushed', result: { branch: 'feat/followup' } };
    if (req.method === 'integrationOpenPr') {
      assert.equal(req.params.taskId, 'tsk_followup');
      assert.equal(req.params.draft, false);
      assert.deepEqual(req.params.allowedPaths, ['tools/ace/src/**']);
      return { ok: true, phase: 'created', result: { prNumber: 55, prUrl: 'https://github.com/acme/ace/pull/55' } };
    }
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'PR_OPENED');
  assert.equal(data.pr.number, 55);
  assert.deepEqual(requests.map((req: any) => req.method), [
    'runBoard',
    'streamGetState',
    'streamReadScreen',
    'integrationPush',
    'integrationOpenPr',
  ]);
});

test('run followup --auto dispatches a missing validator when the gate requires validation', async () => {
  const { result: r, requests } = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ validatorStreamId: null, validatorTaskId: null });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') return { text: 'DONE: implemented' };
    if (req.method === 'integrationGate') return followupGateFixture('head-validator', [{ code: 'validation_required', message: 'validator required' }], { checkState: 'success' });
    if (req.method === 'streamSpawn') {
      assert.equal(req.params.taskId, 'tsk_followup');
      assert.equal(req.params.agent, 'codex');
      return { streamId: 'conversation:validator-new' };
    }
    if (req.method === 'streamSendInput') {
      assert.equal(req.params.streamId, 'conversation:validator-new');
      assert.match(req.params.text, /Validate the exact current PR head head-validator/);
      return { ok: true };
    }
    if (req.method === 'streamSubmit') return { ok: true };
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'VALIDATOR_DISPATCHED');
  assert.equal(data.validator.streamId, 'conversation:validator-new');
  assert.deepEqual(
    requests.filter((req: any) => ['streamSpawn', 'streamSendInput', 'streamSubmit'].includes(req.method)).map((req: any) => req.method),
    ['streamSpawn', 'streamSendInput', 'streamSubmit']
  );
});

test('run followup --auto routes validator request-changes to same-worker fixback', async () => {
  const gates = [
    followupGateFixture('head-fixback'),
    followupGateFixture('head-fixback'),
    followupGateFixture('head-fixback'),
  ];
  const { result: r, requests } = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ projectionHead: 'head-fixback' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: '' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:validator') {
      return {
        ok: true,
        endState: 'turn-complete',
        newOutput: 'DONE: VERDICT=request-changes {"verdict":"request-changes","validatedHeadSha":"head-fixback","failingFiles":["tools/ace/src/index.cts"],"actual":"followup gap"}',
      };
    }
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:worker') {
      assert.match(req.params.prompt, /ValidationFailurePacket/);
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: fixed followup gap' };
    }
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'FIXBACK_SENT');
  assert.ok(data.closeout.packet.validationFailurePacket);
  assert.deepEqual(
    requests.filter((req: any) => req.method === 'streamAsk').map((req: any) => req.params.streamId),
    ['conversation:validator', 'conversation:worker']
  );
});

test('run followup reports check pending, merge-auth park, and gateway merge decisions', async () => {
  const pendingGates = [
    followupGateFixture('head-pending', [], { checkState: 'pending' }),
    followupGateFixture('head-pending', [], { checkState: 'pending' }),
    followupGateFixture('head-pending', [], { checkState: 'pending' }),
  ];
  const pending = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ projectionHead: 'head-pending', checkState: 'pending' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-pending"}' };
    }
    if (req.method === 'integrationGate') return pendingGates.shift();
    if (req.method === 'integrationPollChecks') return { ok: true, phase: 'pending', result: { checkState: 'pending', checks: [{ name: 'build', status: 'PENDING' }] } };
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);
  assert.equal(parseLine(pending.result.stdout).data.status, 'CHECKS_PENDING');

  const parkGates = [
    followupGateFixture('head-park'),
    followupGateFixture('head-park'),
    followupGateFixture('head-park'),
    followupGateFixture('head-park'),
  ];
  const parked = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ projectionHead: 'head-park' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-park"}' };
    }
    if (req.method === 'integrationGate') return parkGates.shift();
    if (req.method === 'integrationPollChecks') return { ok: true, phase: 'success', result: { checkState: 'success', checks: [{ name: 'build', status: 'SUCCESS' }] } };
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);
  assert.equal(parseLine(parked.result.stdout).data.status, 'MERGE_AUTH_NEEDED');

  const mergeGates = [
    followupGateFixture('head-merge'),
    followupGateFixture('head-merge'),
    followupGateFixture('head-merge'),
    followupGateFixture('head-merge'),
  ];
  const merged = await followupRunWith((req: any) => {
    if (req.method === 'runBoard') return followupBoardFixture({ projectionHead: 'head-merge', autoship: { autoMergeAllowed: true } });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-merge"}' };
    }
    if (req.method === 'integrationGate') return mergeGates.shift();
    if (req.method === 'integrationPollChecks') return { ok: true, phase: 'success', result: { checkState: 'success', checks: [{ name: 'build', status: 'SUCCESS' }] } };
    if (req.method === 'integrationMergePr') {
      assert.equal(req.params.taskId, 'tsk_followup');
      assert.equal(req.params.prNumber, 42);
      return { ok: true, result: { mergedSha: 'merge-sha' } };
    }
    throw new Error(`unexpected method ${req.method}`);
  }, ['--auto']);
  assert.equal(parseLine(merged.result.stdout).data.status, 'MERGED');
});

test('run closeout --dry-run performs no stream or merge mutations', async () => {
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture();
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: '' };
    }
    if (req.method === 'integrationGate') return closeoutGateFixture('head-dry');
    throw new Error(`unexpected method ${req.method}`);
  }, ['--dry-run']);

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.schema, 'ace.run_closeout_packet.v1');
  assert.equal(data.status, 'blocked');
  assert.equal(data.noMutation.dryRun, true);
  assert.equal(data.noMutation.streamPrompts, 0);
  assert.equal(data.noMutation.merges, false);
  assert.ok(data.actions.some((action: any) => action.type === 'would_validate_exact_head'));
  assert.ok(!requests.some((req: any) => req.method === 'streamAsk'));
  assert.ok(!requests.some((req: any) => req.method === 'integrationMergePr'));
});

test('run closeout requires exact-head validation before CI or gate can pass', async () => {
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ validatorStreamId: null });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') return { text: 'DONE: implemented' };
    if (req.method === 'integrationGate') return closeoutGateFixture('head-no-validation');
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.ok(data.blockers.some((blocker: any) => blocker.code === 'validation_required'));
  assert.ok(!requests.some((req: any) => req.method === 'integrationPollChecks'));
  assert.ok(!requests.some((req: any) => req.method === 'integrationMergePr'));
});

test('run closeout ignores stale validator request-changes when PR has a newer head', async () => {
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'old-head', validationStatus: 'REQUEST-CHANGES' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=request-changes {"verdict":"request-changes","validatedHeadSha":"old-head","failingFiles":["tools/ace/src/index.cts"]}' };
    }
    if (req.method === 'integrationGate') return closeoutGateFixture('new-head');
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:validator') {
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"new-head"}' };
    }
    if (req.method === 'integrationPollChecks') {
      return { ok: true, phase: 'success', action: 'pollChecks', result: { checkState: 'success', checks: [{ name: 'lint', status: 'SUCCESS', url: 'https://ci/lint' }] } };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'merge_ready');
  assert.equal(data.packet.validation.validatedHeadSha, 'new-head');
  assert.deepEqual(
    requests.filter((req: any) => req.method === 'streamAsk').map((req: any) => req.params.streamId),
    ['conversation:validator']
  );
});

test('run closeout sends same-worker fixback, then revalidates the new exact PR head before final gate', async () => {
  const gates = [
    closeoutGateFixture('head-1'),
    closeoutGateFixture('head-2'),
    closeoutGateFixture('head-2'),
    closeoutGateFixture('head-2'),
  ];
  let validatorAsks = 0;
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-1' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: '' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:validator') {
      validatorAsks += 1;
      if (validatorAsks === 1) {
        return {
          ok: true,
          endState: 'turn-complete',
          newOutput: 'DONE: VERDICT=request-changes {"verdict":"request-changes","validatedHeadSha":"head-1","failingFiles":["tools/ace/src/index.cts"],"actual":"missing closeout packet"}',
        };
      }
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-2"}' };
    }
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:worker') {
      assert.match(req.params.prompt, /ValidationFailurePacket/);
      assert.match(req.params.prompt, /feat\/closeout/);
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: fixed closeout' };
    }
    if (req.method === 'integrationPollChecks') {
      return { ok: true, phase: 'success', action: 'pollChecks', result: { checkState: 'success', checks: [{ name: 'build', status: 'SUCCESS', url: 'https://ci/build' }] } };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'merge_ready');
  assert.equal(data.packet.validation.validatedHeadSha, 'head-2');
  assert.deepEqual(
    requests.filter((req: any) => req.method === 'streamAsk').map((req: any) => req.params.streamId),
    ['conversation:validator', 'conversation:worker', 'conversation:validator']
  );
  assert.equal(requests.filter((req: any) => req.method === 'integrationGate').length, 4);
});

test('run closeout blocks with a ValidationFailurePacket when validation fails outside allowed scope', async () => {
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture();
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: '' };
    }
    if (req.method === 'integrationGate') return closeoutGateFixture('head-scope');
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:validator') {
      return {
        ok: true,
        endState: 'turn-complete',
        newOutput: 'DONE: VERDICT=request-changes {"verdict":"request-changes","validatedHeadSha":"head-scope","failingFiles":["src/unrelated.ts"],"actual":"scope leak"}',
      };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.equal(data.packet.validationFailurePacket.schema, 'ValidationFailurePacket/v1');
  assert.ok(data.blockers.some((blocker: any) => blocker.code === 'scope_contamination'));
  assert.ok(!requests.some((req: any) => req.method === 'streamAsk' && req.params.streamId === 'conversation:worker'));
});

test('run closeout reports exact read-only gate blockers after exact-head validation', async () => {
  const gateBlockers = [
    { code: 'draft_pr', message: 'draft PRs cannot pass the merge gate' },
    { code: 'owner_approval_required', message: 'owner approval required' },
    { code: 'scope_contamination', message: 'unexpected file', unexpectedFiles: ['src/out.ts'] },
    { code: 'checks_not_green', message: 'checks failed' },
    { code: 'not_mergeable', message: 'PR has conflicts' },
  ];
  const gates = [closeoutGateFixture('head-block'), closeoutGateFixture('head-block'), closeoutGateFixture('head-block', gateBlockers)];
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-block' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-block"}' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'integrationPollChecks') {
      return { ok: true, phase: 'success', action: 'pollChecks', result: { checkState: 'success', checks: [{ name: 'lint', status: 'SUCCESS', url: 'https://ci/lint' }] } };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.deepEqual(
    data.blockers.map((blocker: any) => blocker.code),
    ['draft_pr', 'owner_approval_required', 'scope_contamination', 'checks_not_green', 'not_mergeable']
  );
  assert.equal(data.noMutation.merges, false);
  assert.ok(!requests.some((req: any) => req.method === 'integrationMergePr'));
});

test('run closeout blocks CI resolution for a PR from the wrong GitHub repo', async () => {
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-repo' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-repo"}' };
    }
    if (req.method === 'integrationGate') return closeoutGateFixture('head-repo', [], { prUrl: 'https://github.com/acme/other/pull/42' });
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.ok(data.blockers.some((blocker: any) => blocker.code === 'wrong_github_repo'));
  assert.ok(!requests.some((req: any) => req.method === 'integrationPollChecks'));
});

test('run closeout blocks when PR head changes during CI watch', async () => {
  const gates = [closeoutGateFixture('head-ci-1'), closeoutGateFixture('head-ci-2')];
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-ci-1' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-ci-1"}' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'integrationPollChecks') {
      return { ok: true, phase: 'success', action: 'pollChecks', result: { checkState: 'success', checks: [{ name: 'lint', status: 'SUCCESS', url: 'https://ci/lint' }] } };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.ok(data.blockers.some((blocker: any) => blocker.code === 'ci_head_changed'));
  assert.equal(requests.filter((req: any) => req.method === 'integrationGate').length, 2);
});

test('run closeout watches CI to terminal success and reports check names and URLs', async () => {
  const gates = [closeoutGateFixture('head-ci-ok'), closeoutGateFixture('head-ci-ok'), closeoutGateFixture('head-ci-ok')];
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-ci-ok' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-ci-ok"}' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'integrationPollChecks') {
      return {
        ok: true,
        phase: 'success',
        action: 'pollChecks',
        result: {
          checkState: 'success',
          checks: [
            { name: 'lint', status: 'SUCCESS', url: 'https://ci.example/lint' },
            { name: 'build', status: 'SUCCESS', url: 'https://ci.example/build' },
          ],
        },
      };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'merge_ready');
  assert.equal(data.packet.ci.state, 'success');
  assert.deepEqual(
    data.packet.ci.checks.map((check: any) => [check.name, check.state, check.url]),
    [['lint', 'success', 'https://ci.example/lint'], ['build', 'success', 'https://ci.example/build']]
  );
  assert.equal(requests.filter((req: any) => req.method === 'integrationPollChecks').length, 1);
});

test('run closeout sends same-worker CI fixback, then re-watches the new head before validation', async () => {
  const gates = [
    closeoutGateFixture('head-ci-1'),
    closeoutGateFixture('head-ci-1'),
    closeoutGateFixture('head-ci-2'),
    closeoutGateFixture('head-ci-2'),
    closeoutGateFixture('head-ci-2'),
  ];
  let validatorAsks = 0;
  let ciPolls = 0;
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-ci-1' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: '' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:validator') {
      validatorAsks += 1;
      const head = validatorAsks === 1 ? 'head-ci-1' : 'head-ci-2';
      return { ok: true, endState: 'turn-complete', newOutput: `DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"${head}"}` };
    }
    if (req.method === 'integrationPollChecks') {
      ciPolls += 1;
      if (ciPolls === 1) {
        return {
          ok: false,
          phase: 'failure',
          action: 'pollChecks',
          result: { checkState: 'failure', checks: [{ name: 'lint', status: 'FAILURE', url: 'https://ci.example/lint' }] },
        };
      }
      return {
        ok: true,
        phase: 'success',
        action: 'pollChecks',
        result: { checkState: 'success', checks: [{ name: 'lint', status: 'SUCCESS', url: 'https://ci.example/lint' }] },
      };
    }
    if (req.method === 'streamAsk' && req.params.streamId === 'conversation:worker') {
      assert.match(req.params.prompt, /ci_checks_failed/);
      assert.match(req.params.prompt, /https:\/\/ci\.example\/lint/);
      return { ok: true, endState: 'turn-complete', newOutput: 'DONE: fixed CI' };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'merge_ready');
  assert.equal(data.packet.validation.validatedHeadSha, 'head-ci-2');
  assert.equal(data.packet.ci.headSha, 'head-ci-2');
  assert.deepEqual(
    requests.filter((req: any) => req.method === 'streamAsk').map((req: any) => req.params.streamId),
    ['conversation:validator', 'conversation:worker', 'conversation:validator']
  );
  assert.deepEqual(
    data.actions
      .filter((action: any) => ['watch_ci', 'send_same_worker_ci_fixback', 'revalidate_exact_head_after_ci_fixback'].includes(action.type))
      .map((action: any) => `${action.type}:${action.headSha || action.streamId}`),
    [
      'watch_ci:head-ci-1',
      'send_same_worker_ci_fixback:conversation:worker',
      'watch_ci:head-ci-2',
      'revalidate_exact_head_after_ci_fixback:conversation:validator',
    ]
  );
  assert.equal(requests.filter((req: any) => req.method === 'integrationPollChecks').length, 2);
});

test('run closeout blocks cancelled CI with a precise packet instead of code fixback', async () => {
  const gates = [closeoutGateFixture('head-cancelled'), closeoutGateFixture('head-cancelled')];
  const { result: r, requests } = await closeoutRunWith((req: any) => {
    if (req.method === 'runBoard') return closeoutBoardFixture({ projectionHead: 'head-cancelled' });
    if (req.method === 'streamGetState') return { state: 'awaiting-input' };
    if (req.method === 'streamReadScreen') {
      if (req.params.streamId === 'conversation:worker') return { text: 'DONE: implemented' };
      return { text: 'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"head-cancelled"}' };
    }
    if (req.method === 'integrationGate') return gates.shift();
    if (req.method === 'integrationPollChecks') {
      return {
        ok: false,
        phase: 'failure',
        action: 'pollChecks',
        result: { checkState: 'failure', checks: [{ name: 'e2e', status: 'CANCELLED', url: 'https://ci.example/e2e' }] },
      };
    }
    throw new Error(`unexpected method ${req.method}`);
  });

  assert.equal(r.status, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
  const data = parseLine(r.stdout).data;
  assert.equal(data.status, 'blocked');
  assert.equal(data.packet.ciFailurePacket.schema, 'ValidationFailurePacket/v1');
  assert.equal(data.packet.ciFailurePacket.status, 'BLOCKED');
  assert.ok(data.blockers.some((blocker: any) => blocker.code === 'ci_cancelled'));
  assert.ok(!requests.some((req: any) => req.method === 'streamAsk' && req.params.streamId === 'conversation:worker'));
});

test('task run cross-workspace delegation: rejected with scope_violation before transport', () => {
  const r = run(
    ['task', 'run', 'claude', '--workspace', 'prj-other', '--new-task', '--goal', 'steal sibling workspace'],
    {
      ACE_WORKSPACE_ID: 'prj-mine',
      ACE_TASK_ID: 'tsk-mine',
      ACE_AGENT: 'hermes',
      ACE_PERSONAL_IDENTITY: '',
      ACE_SOCK: '',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error, 'scope_violation');
  assert.equal(err.details.callerWorkspace, 'prj-mine');
  assert.equal(err.details.targetWorkspace, 'prj-other');
  assert.equal(err.details.command, 'task run');
});

test('spawn into own task: rejected with scope_violation', () => {
  const r = run(
    ['spawn', 'claude', '--task', 'tsk-mine'],
    {
      ACE_WORKSPACE_ID: 'prj-mine',
      ACE_TASK_ID: 'tsk-mine',
      ACE_AGENT: 'hermes',
      ACE_SOCK: '',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'scope_violation');
  assert.match(err.message, /own task tsk-mine/);
});

test('task run within own workspace: guard passes and transport fails later', () => {
  const r = run(
    ['task', 'run', 'claude', '--workspace', 'prj-mine', '--new-task', '--goal', 'do the thing'],
    {
      ACE_WORKSPACE_ID: 'prj-mine',
      ACE_SOCK: '/tmp/ace-nonexistent-enforcement-test.sock',
      ACE_URL: '',
      ACE_TOKEN: '',
      ACE_TIMEOUT_MS: '2000',
    }
  );
  assert.notEqual(r.status, 2, `guard should not have fired; stderr=${r.stderr}`);
  assert.equal(r.status, 3, `expected transport_failed exit 3, got ${r.status}; stderr=${r.stderr}`);
});

test('task run cross-instance delegation: rejected with instance_mismatch before transport', () => {
  const r = run(
    ['task', 'run', 'claude', '--workspace', 'prj-other', '--new-task', '--goal', 'cross instance'],
    {
      ACE_WORKSPACE_ID: 'prj-mine',
      ACE_CALLER_INSTANCE_TAG: 'Ace',
      ACE_USER_DATA_TAG: 'Ace-Ace',
      ACE_SOCK: '',
      ACE_URL: '',
      ACE_TOKEN: '',
    }
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  const err = parseLine(r.stderr);
  assert.equal(err.error, 'instance_mismatch');
  assert.equal(err.details.callerInstanceTag, 'Ace');
  assert.equal(err.details.activeInstanceTag, 'Ace-Ace');
});

test('doctor workspace: returns caller/active tags and active-instance workspaces', async () => {
  const r = await withSocketServer(
    (req: any) => {
      assert.equal(req.method, 'getState');
      return {
        workspaces: [
          { id: 'prj-1', name: 'Ace', path: '/repo/Ace', isRemote: false },
          { id: 'prj-2', name: 'Other', path: '/repo/Other', isRemote: false },
        ],
      };
    },
    (sockPath: any) => runAsync(
      ['doctor', 'workspace'],
      {
        ACE_SOCK: sockPath,
        ACE_WORKSPACE_ID: 'prj-old',
        ACE_CALLER_INSTANCE_TAG: 'Ace',
        ACE_USER_DATA_TAG: 'Ace-Dev',
        ACE_REPO_ROOT: '/repo/Ace',
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.activeInstanceTag, 'Ace-Dev');
  assert.equal(env.data.callerInstanceTag, 'Ace');
  assert.equal(env.data.callerWorkspaceId, 'prj-old');
  assert.equal(env.data.mismatch, true);
  assert.deepEqual(env.data.workspacesInActiveInstance, [
    { id: 'prj-1', name: 'Ace' },
    { id: 'prj-2', name: 'Other' },
  ]);
});

test('control-plane status resolves external Ace data root for Hermes homes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-control-plane-ext-'));
  const externalRoot = path.join(tmp, 'AceData');
  const repoRoot = path.join(tmp, 'repo');
  const workspaceId = 'prj-ext';
  const baseSkills = path.join(externalRoot, 'hermes-home', 'skills');
  const home = path.join(externalRoot, `hermes-home-${workspaceId}`);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(baseSkills, { recursive: true });
  for (const skill of ['ace-task-worker', 'ace-runtime-contract', 'ace-github-flow']) {
    fs.mkdirSync(path.join(baseSkills, skill), { recursive: true });
    fs.writeFileSync(path.join(baseSkills, skill, 'SKILL.md'), `# ${skill}\n`);
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'state.db'), '');
  fs.writeFileSync(path.join(home, 'config.yaml'), `terminal:\n  cwd: ${repoRoot}\n`);
  fs.symlinkSync(baseSkills, path.join(home, 'skills'), 'dir');

  const r = await withSocketServer(
    (req: any) => {
      if (req.method === 'getState') {
        return { workspaces: [{ id: workspaceId, name: 'Ext', path: repoRoot, isRemote: false }] };
      }
      if (req.method === 'missionBoard') return { missions: [] };
      if (req.method === 'streamTrackedGithubProjects') return { projects: [] };
      throw new Error(`unexpected method ${req.method}`);
    },
    (sockPath: any) => runAsync(
      ['control-plane', 'status', '--workspace', workspaceId],
      {
        ACE_SOCK: sockPath,
        ACE_USER_DATA_TAG: 'AceData',
        ACE_EXTERNAL_DATA_ROOT: externalRoot,
        ACE_URL: '',
        ACE_TOKEN: '',
      }
    )
  );

  try {
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const env = parseLine(r.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.data.hermesHomePath, home);
    assert.equal(env.data.hermesHome, 'ok');
    assert.equal(env.data.skills, 'ok');
    assert.deepEqual(
      env.data.warnings.filter((warning: string) => /Hermes home missing|skills path missing|missing required Ace skills/.test(warning)),
      []
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('supervise --json: returns only rows explicitly linked to the requested workspace', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-supervise-'));
  const store = path.join(tmp, 'registry.json');
  // Seed directly — the CLI reads via createFileDb(store).
  fs.writeFileSync(
    store,
    JSON.stringify({
      tsk_sv1: {
        taskId: 'tsk_sv1',
        workspaceId: 'prj_any',
        branch: 'ace/sv-1',
        worktreePath: '/tmp/wt1',
        prNumber: 11,
        prUrl: 'https://github.com/o/r/pull/11',
        prState: 'open',
        prChecks: null,
        lastTrailer: 'shipped',
        updatedAt: 1,
      },
      tsk_global_stale: {
        taskId: 'tsk_global_stale',
        branch: 'ace/old-global',
        worktreePath: '/tmp/old',
        prNumber: 99,
        prUrl: 'https://github.com/o/r/pull/99',
        prState: 'open',
        prChecks: null,
        lastTrailer: 'old',
        updatedAt: 1,
      },
      tsk_other: {
        taskId: 'tsk_other',
        workspaceId: 'prj_other',
        branch: 'ace/other',
        worktreePath: '/tmp/other',
        prNumber: 12,
        prUrl: 'https://github.com/o/r/pull/12',
        prState: 'open',
        prChecks: null,
        lastTrailer: 'other',
        updatedAt: 1,
      },
    })
  );
  const r = spawnSync(
    'node',
    [...NODE_WITH_TSX_ABS, CLI_ENTRY, '--json', 'supervise', '--workspace', 'prj_any'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACE_CHILD_REGISTRY_PATH: store,
        // Redirect the follow-up store too — supervise --json upserts follow-up
        // rows, and without this pin the fixture rows (tsk_sv1/prj_any) land in
        // the operator's REAL ~/.ace/follow-ups.json.
        ACE_FOLLOW_UP_STORE_PATH: path.join(tmp, 'follow-ups.json'),
        ACE_SUPERVISE_RECONCILE: '0',
      },
      timeout: 8000,
    }
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.workspace, 'prj_any');
  assert.ok(Array.isArray(env.data.rows));
  assert.equal(env.data.rows.length, 1);
  assert.equal(env.data.rows[0].taskId, 'tsk_sv1');
  assert.equal(env.data.rows[0].prNumber, 11);
  assert.equal(env.data.rows[0].prUrl, 'https://github.com/o/r/pull/11');
  assert.equal(env.data.rows[0].prState, 'open');
});

test('supervise --json: reconciles from row git cwd and defaults base to main', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-supervise-cwd-'));
  const store = path.join(tmp, 'registry.json');
  const repo = path.join(tmp, 'repo');
  const nonGitCwd = path.join(tmp, 'not-git');
  const binDir = path.join(tmp, 'bin');
  const ghLog = path.join(tmp, 'gh.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(nonGitCwd, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeFakeGh(
    binDir,
    ghLog,
    [
      "if (args.join(' ') === 'pr list --state open --base main --json number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision') {",
      "  process.stdout.write('[]\\n');",
      '  process.exit(0);',
      '}',
      "process.stderr.write('unexpected gh args: ' + args.join(' ') + '\\n');",
      'process.exit(1);',
    ].join('\n')
  );
  fs.writeFileSync(
    store,
    JSON.stringify({
      tsk_sv1: {
        taskId: 'tsk_sv1',
        workspaceId: 'prj_any',
        branch: 'ace/sv-1',
        worktreePath: repo,
        prState: 'pr-open-failed',
        updatedAt: 1,
      },
    })
  );

  const r = spawnSync(
    'node',
    [...NODE_WITH_TSX_ABS, CLI_ENTRY, '--json', 'supervise', '--workspace', 'prj_any'],
    {
      cwd: nonGitCwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        ACE_CHILD_REGISTRY_PATH: store,
        ACE_FOLLOW_UP_STORE_PATH: path.join(tmp, 'follow-ups.json'),
        ACE_BASE_BRANCH: '',
        ACE_REPO_ROOT: '',
        ACE_WORKTREE_PATH: '',
      },
      timeout: 8000,
    }
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.prReconciliation.ok, true);
  assert.equal(env.data.prReconciliation.baseBranch, 'main');
  const ghCalls = fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ghCalls[0].cwd, fs.realpathSync(repo));
  assert.deepEqual(ghCalls[0].args.slice(0, 6), ['pr', 'list', '--state', 'open', '--base', 'main']);
});

test('supervise --json: marks closed stale PR rows without deleting audit rows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-supervise-stale-'));
  const store = path.join(tmp, 'registry.json');
  const repo = path.join(tmp, 'repo');
  const binDir = path.join(tmp, 'bin');
  const ghLog = path.join(tmp, 'gh.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeFakeGh(
    binDir,
    ghLog,
    [
      "if (args.join(' ') === 'pr list --state open --base main --json number,url,state,title,headRefName,baseRefName,mergeable,statusCheckRollup,isDraft,reviewDecision') {",
      "  process.stdout.write('[]\\n');",
      '  process.exit(0);',
      '}',
      "if (args.join(' ') === 'pr view 86 --json number,url,state,title,headRefName,baseRefName,mergedAt,closedAt') {",
      "  process.stdout.write(JSON.stringify({ number: 86, url: 'https://github.com/o/r/pull/86', state: 'MERGED', headRefName: 'ace/old', baseRefName: 'main', mergedAt: '2026-05-04T12:00:00Z' }) + '\\n');",
      '  process.exit(0);',
      '}',
      "process.stderr.write('unexpected gh args: ' + args.join(' ') + '\\n');",
      'process.exit(1);',
    ].join('\n')
  );
  fs.writeFileSync(
    store,
    JSON.stringify({
      tsk_old: {
        taskId: 'tsk_old',
        workspaceId: 'prj_any',
        branch: 'ace/old',
        baseBranch: 'main',
        worktreePath: repo,
        prNumber: 86,
        prUrl: 'https://github.com/o/r/pull/86',
        prState: 'open',
        updatedAt: 1,
      },
    })
  );

  const r = spawnSync(
    'node',
    [...NODE_WITH_TSX_ABS, CLI_ENTRY, '--json', 'supervise', '--workspace', 'prj_any'],
    {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        ACE_CHILD_REGISTRY_PATH: store,
        ACE_FOLLOW_UP_STORE_PATH: path.join(tmp, 'follow-ups.json'),
        ACE_BASE_BRANCH: '',
        ACE_REPO_ROOT: repo,
      },
      timeout: 8000,
    }
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.data.rows.length, 1);
  assert.equal(env.data.rows[0].taskId, 'tsk_old');
  assert.equal(env.data.rows[0].prState, 'merged');
  assert.equal(env.data.rows[0].staleClassification, 'closed');
  const stored = JSON.parse(fs.readFileSync(store, 'utf8')).tsk_old;
  assert.equal(stored.prState, 'merged');
  assert.equal(stored.staleClassification, 'closed');
});

test('supervise: human-readable table when --json not set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-supervise-'));
  const store = path.join(tmp, 'registry.json');
  fs.writeFileSync(store, JSON.stringify({}));
  const r = spawnSync('node', [...NODE_WITH_TSX, CLI_ENTRY, 'supervise', '--workspace', 'x'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACE_CHILD_REGISTRY_PATH: store,
      ACE_FOLLOW_UP_STORE_PATH: path.join(tmp, 'follow-ups.json'),
    },
    timeout: 8000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no child-registry rows/);
});

test('--json before command: accepted as global flag, not routed as subcommand', () => {
  // Regression: `ace --json describe` used to die with
  // unknown_command because resolveCommand ran before extractGlobalFlags.
  const r = run(['--json', 'describe', 'ls']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const env = parseLine(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cli, 'ls');
});
