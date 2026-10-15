const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createIntegrationGateway,
  RETRY,
} = require('../integration-gateway.cjs');

// Build a mock execFile that plays scripted responses keyed by bin+first-arg.
// Each script entry is { stdout?, stderr?, err? } — err makes the callback
// fire with a non-null error.
function makeMockExecFile(script: any) {
  const calls: any[] = [];
  const queue = script.slice();
  const mock = (bin: any, args: any, opts: any, cb: any) => {
    calls.push({ bin, args: args.slice(), opts });
    const next = queue.shift();
    if (!next) {
      cb(null, '', '');
      return;
    }
    if (typeof next === 'function') {
      const result = next({ bin, args, opts });
      const err = result?.err ? Object.assign(new Error(result.stderr || 'mock err'), result.err) : null;
      process.nextTick(() => cb(err, result?.stdout || '', result?.stderr || ''));
      return;
    }
    const err = next.err ? Object.assign(new Error(next.stderr || 'mock err'), next.err) : null;
    process.nextTick(() => cb(err, next.stdout || '', next.stderr || ''));
  };
  return { mock, calls };
}

function silentLogger() {
  return { warn: () => {}, info: () => {}, error: () => {} };
}

function collect(gateway: any) {
  const events: any[] = [];
  gateway.on('integration', (env: any) => events.push(env));
  return events;
}

function validMergeGate(extra: any = {}) {
  return {
    tracked: true,
    expectedBaseBranch: 'dev',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    validation: { self: 'PASS', independent: null, fixback: null, highRisk: false },
    ...extra,
  };
}

function ansiWrapJson(value: any) {
  return `\u001b[33m\u001b]0;gh-json\u0007${JSON.stringify(value)}\u001b[0m\u0000`;
}

const mergeablePrView = {
  stdout: JSON.stringify({
    state: 'OPEN',
    baseRefName: 'dev',
    headRefOid: 'headsha',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    // A KNOWN (empty) changed-file list: automerge fail-closes on an UNKNOWN
    // list (changedFiles=null), so fixtures must carry one like real gh output.
    files: [],
  }),
};

test('push: happy path — one attempt, emits success envelope', async () => {
  const { mock, calls } = makeMockExecFile([{ stdout: 'ok' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const events = collect(gw);
  const res = await gw.push({ branch: 'feat/x' });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'push');
  assert.equal(res.phase, 'success');
  assert.equal(res.params.branch, 'feat/x');
  assert.equal(res.params.remote, 'origin');
  assert.equal(res.result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'git');
  assert.deepEqual(calls[0].args.slice(0, 2), ['push', '--set-upstream']);
  assert.equal(calls[0].opts.env, undefined, 'ordinary push environment must remain unchanged');
  assert.equal(events.length, 1);
  assert.equal(events[0], res, 'emitted envelope must be the returned envelope');
});

test('push: imported context binds an explicit synthetic URL to immutable audit evidence', async () => {
  const { mock, calls } = makeMockExecFile([{ stdout: 'ok' }]);
  const boundUrl = 'https://github.com/example/context-import.git';
  const nonce = 'gateway-public-seam-nonce';
  const priorGitDir = process.env.GIT_DIR;
  const priorConfigCount = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_DIR = '/hostile/repository';
  process.env.GIT_CONFIG_COUNT = '1';
  try {
    const gw = createIntegrationGateway({
      cwd: '/tmp',
      logger: silentLogger(),
      execFileImpl: mock,
      newPushNonce: () => nonce,
    });
    const result = await gw.push({ branch: 'feat/x', importedPushUrl: boundUrl });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const syntheticUrl = `https://ace.invalid/context-import/${nonce}`;
    assert.deepEqual(calls[0].args, [
      '-c', `url.${boundUrl}.pushInsteadOf=${syntheticUrl}`,
      'push', syntheticUrl, 'feat/x',
    ]);
    assert.equal(calls[0].opts.env.GIT_DIR, undefined);
    assert.equal(calls[0].opts.env.GIT_CONFIG_COUNT, undefined);

    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-push-routing-proof-'));
    try {
      childProcess.execFileSync('git', ['init', proofRoot], { env: calls[0].opts.env, stdio: 'ignore' });
      childProcess.execFileSync(
        'git', ['remote', 'add', 'imported', syntheticUrl],
        { cwd: proofRoot, env: calls[0].opts.env, stdio: 'ignore' },
      );
      const boundBare = path.join(proofRoot, 'bound.git');
      const attackerBare = path.join(proofRoot, 'attacker.git');
      childProcess.execFileSync('git', ['init', '--bare', boundBare], { env: calls[0].opts.env, stdio: 'ignore' });
      childProcess.execFileSync('git', ['init', '--bare', attackerBare], { env: calls[0].opts.env, stdio: 'ignore' });
      const resolved = childProcess.execFileSync(
        'git',
        [
          '-c', `url.${attackerBare}.pushInsteadOf=https://ace.invalid/context-import/`,
          '-c', `url.${boundBare}.pushInsteadOf=${syntheticUrl}`,
          'remote', 'get-url', '--push', 'imported',
        ],
        { cwd: proofRoot, env: calls[0].opts.env, encoding: 'utf8' },
      ).trim();
      assert.equal(resolved, boundBare, 'push URL proof must use pushInsteadOf and exact-match precedence');
    } finally {
      fs.rmSync(proofRoot, { recursive: true, force: true });
    }
  } finally {
    if (priorGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorGitDir;
    if (priorConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = priorConfigCount;
  }
});

test('push: imported failure redacts URLs and diagnostics from result, event, and retry logs', async () => {
  const boundUrl = 'https://github.com/example/redacted.git';
  const syntheticUrl = 'https://ace.invalid/context-import/redaction-nonce';
  const raw = `bound=${boundUrl} synthetic=${syntheticUrl} raw-diagnostic-secret`;
  const warnings: string[] = [];
  const { mock, calls } = makeMockExecFile([
    { err: { code: 7 }, stdout: `stdout ${raw}`, stderr: `stderr ${raw}` },
    { err: { code: 7 }, stdout: `stdout ${raw}`, stderr: `stderr ${raw}` },
    { err: { code: 7 }, stdout: `stdout ${raw}`, stderr: `stderr ${raw}` },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: { warn: (message: string) => warnings.push(message), info() {}, error() {} },
    execFileImpl: mock,
    newPushNonce: () => 'redaction-nonce',
  });
  const events = collect(gw);
  const result = await gw.push({ branch: 'feat/x', importedPushUrl: boundUrl });
  assert.equal(result.ok, false);
  assert.equal(result.result.stdout, '');
  assert.equal(result.result.stderr, '');
  assert.equal(result.result.diagnosticsRedacted, true);
  assert.equal(events.length, 1);
  assert.equal(events[0], result);
  assert.deepEqual(warnings, [1, 2, 3].map((attempt) =>
    `[integration-gateway] imported push failed (attempt ${attempt}/3, code=7)`));
  const serialized = JSON.stringify({ result, events, warnings });
  assert.equal(serialized.includes(boundUrl), false);
  assert.equal(serialized.includes(syntheticUrl), false);
  assert.equal(serialized.includes('raw-diagnostic-secret'), false);
  assert.equal(calls.length, 3);
});

test('push: imported success conservatively redacts command diagnostics', async () => {
  const boundUrl = 'https://github.com/example/success.git';
  const syntheticUrl = 'https://ace.invalid/context-import/success-nonce';
  const { mock } = makeMockExecFile([{ stdout: `${boundUrl} ${syntheticUrl}`, stderr: 'rewritten URL' }]);
  const gw = createIntegrationGateway({
    cwd: '/tmp', logger: silentLogger(), execFileImpl: mock,
    newPushNonce: () => 'success-nonce',
  });
  const result = await gw.push({ branch: 'feat/x', importedPushUrl: boundUrl });
  assert.equal(result.ok, true);
  assert.equal(result.result.stdout, '');
  assert.equal(result.result.stderr, '');
  assert.equal(result.result.diagnosticsRedacted, true);
});

test('push: ordinary diagnostics and retry warnings remain unchanged', async () => {
  const warnings: string[] = [];
  const raw = 'ordinary remote diagnostic';
  const { mock, calls } = makeMockExecFile([
    { err: { code: 9 }, stderr: raw },
    { err: { code: 9 }, stderr: raw },
    { err: { code: 9 }, stderr: raw },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: { warn: (message: string) => warnings.push(message), info() {}, error() {} },
    execFileImpl: mock,
  });
  const result = await gw.push({ branch: 'feat/x' });
  assert.equal(result.ok, false);
  assert.equal(result.result.stderr, raw);
  assert.equal(result.result.diagnosticsRedacted, undefined);
  assert.equal(calls.length, 3);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((message) => message.includes('git push --set-upstream origin feat/x')));
  assert.ok(warnings.every((message) => message.includes(raw)));
});

test('push: imported real push delivers without creating synthetic upstream tracking', async (t: any) => {
  const localGitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ace Imported Push Test',
    GIT_AUTHOR_EMAIL: 'imported-push@example.invalid',
    GIT_COMMITTER_NAME: 'Ace Imported Push Test',
    GIT_COMMITTER_EMAIL: 'imported-push@example.invalid',
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-imported-push-tracking-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const boundBare = path.join(root, 'bound.git');
  const attackerBare = path.join(root, 'attacker.git');
  childProcess.execFileSync('git', ['init', '--bare', boundBare], { env: localGitEnv, stdio: 'ignore' });
  childProcess.execFileSync('git', ['init', '--bare', attackerBare], { env: localGitEnv, stdio: 'ignore' });
  childProcess.execFileSync('git', ['init', '-b', 'feat/x', source], { env: localGitEnv, stdio: 'ignore' });
  fs.writeFileSync(path.join(source, 'payload.txt'), 'imported push\n', 'utf8');
  childProcess.execFileSync('git', ['add', 'payload.txt'], { cwd: source, env: localGitEnv, stdio: 'ignore' });
  childProcess.execFileSync('git', ['commit', '-m', 'imported push'], { cwd: source, env: localGitEnv, stdio: 'ignore' });
  const syntheticUrl = 'https://ace.invalid/context-import/real-push-nonce';
  childProcess.execFileSync(
    'git',
    ['config', 'url.' + attackerBare + '.pushInsteadOf', 'https://ace.invalid/context-import/'],
    { cwd: source, env: localGitEnv, stdio: 'ignore' },
  );
  const hostileKeys = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  ];
  const hostileValues: Record<string, string> = {
    GIT_DIR: '/hostile/git-dir',
    GIT_WORK_TREE: '/hostile/work-tree',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.' + attackerBare + '.pushInsteadOf',
    GIT_CONFIG_VALUE_0: syntheticUrl,
  };
  const prior = new Map<string, string | undefined>();
  for (const key of hostileKeys) {
    prior.set(key, process.env[key]);
    process.env[key] = hostileValues[key];
  }
  try {
    const calls: any[] = [];
    const gateway = createIntegrationGateway({
      cwd: source,
      logger: silentLogger(),
      newPushNonce: () => 'real-push-nonce',
      execFileImpl(bin: string, args: string[], options: any, callback: any) {
        calls.push({ bin, args: [...args], options });
        return childProcess.execFile(bin, args, options, callback);
      },
    });
    const beforeTracking = () => childProcess.execFileSync(
      'git', ['config', '--get', 'branch.feat/x.remote'],
      { cwd: source, env: localGitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.throws(beforeTracking, /exit code|Command failed/);
    const result = await gateway.push({ branch: 'feat/x', importedPushUrl: boundBare });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      '-c', `url.${boundBare}.pushInsteadOf=${syntheticUrl}`,
      'push', syntheticUrl, 'feat/x',
    ]);
    assert.equal(calls[0].options.env.GIT_DIR, undefined);
    assert.equal(calls[0].options.env.GIT_CONFIG_COUNT, undefined);
    assert.doesNotThrow(() => childProcess.execFileSync(
      'git', ['show-ref', '--verify', 'refs/heads/feat/x'],
      { cwd: boundBare, env: localGitEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    assert.throws(() => childProcess.execFileSync(
      'git', ['show-ref', '--verify', 'refs/heads/feat/x'],
      { cwd: attackerBare, env: localGitEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    assert.throws(beforeTracking, /exit code|Command failed/);
    assert.throws(() => childProcess.execFileSync(
      'git', ['rev-parse', '--abbrev-ref', '@{upstream}'],
      { cwd: source, env: localGitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ));
  } finally {
    for (const key of hostileKeys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('push: transient failure then success — retries up to RETRY.push', async () => {
  const fail = { err: { code: 1 }, stderr: 'fatal: remote hiccup' };
  const ok = { stdout: 'pushed' };
  const { mock, calls } = makeMockExecFile([fail, fail, ok]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.push({ branch: 'feat/x' });
  assert.equal(res.ok, true);
  assert.equal(res.result.attempts, 3);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.bin, 'git');
    assert.equal(c.args[0], 'push');
  }
});

test('push: exhausts all retries → failure envelope, attempts == RETRY.push', async () => {
  const fail = { err: { code: 1 }, stderr: 'dead' };
  const { mock, calls } = makeMockExecFile([fail, fail, fail, fail]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.push({ branch: 'feat/x' });
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'failure');
  assert.equal(res.result.attempts, RETRY.push);
  assert.equal(calls.length, RETRY.push);
});

test('push: idempotent re-push — second call on the same branch re-issues same command', async () => {
  // Real-world: branch already exists on remote. git push returns "Everything
  // up-to-date" with exit 0. Second call must produce another success envelope
  // with identical shape — no state from the first call should leak.
  const { mock, calls } = makeMockExecFile([
    { stdout: 'Everything up-to-date' },
    { stdout: 'Everything up-to-date' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const first = await gw.push({ branch: 'feat/x' });
  const second = await gw.push({ branch: 'feat/x' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.result.attempts, 1);
  assert.equal(second.result.attempts, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args, 'same invocation both times');
});

test('push: missing branch param short-circuits to failure without shelling', async () => {
  const { mock, calls } = makeMockExecFile([]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.push({});
  assert.equal(res.ok, false);
  assert.match(res.result.error, /branch/);
  assert.equal(calls.length, 0);
});

test('openPr: passes gh pr create with --draft by default', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: 'src/app.ts\n' },
    { stdout: 'https://github.com/o/r/pull/42' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({ base: 'main', head: 'feat/x', title: 't', body: 'b', allowedPaths: ['src/**'] });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'openPr');
  const prCreate = calls[calls.length - 1];
  assert.equal(prCreate.bin, 'gh');
  assert.equal(prCreate.args[0], 'pr');
  assert.equal(prCreate.args[1], 'create');
  assert.ok(prCreate.args.includes('--draft'));
});

test('openPr: draft=false omits --draft', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: 'src/app.ts\n' },
    { stdout: 'url' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  await gw.openPr({ base: 'main', head: 'x', title: 't', draft: false, allowedPaths: ['src/**'] });
  assert.ok(!calls[calls.length - 1].args.includes('--draft'));
});

test('openPr: blocks before gh pr create when diff is out of scope', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: 'src/app.ts\nelectron/local-core.cts\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({ base: 'main', head: 'x', title: 't', allowedPaths: ['src/**'] });
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.error, 'scope_contamination');
  assert.deepEqual(res.result.unexpectedFiles, ['electron/local-core.cts']);
  assert.equal(calls.some((call: any) => call.bin === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create'), false);
});

test('openPr: blocks before gh pr create when changed files lack allowed paths', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: 'src/app.ts\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({ base: 'main', head: 'x', title: 't' });
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.error, 'scope_missing');
  assert.deepEqual(res.result.changedFiles, ['src/app.ts']);
  assert.deepEqual(res.result.unexpectedFiles, ['src/app.ts']);
  assert.equal(calls.some((call: any) => call.bin === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create'), false);
});

test('openPr: allows exact allowed path before gh pr create', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: 'smoke-lab/index.html\n' },
    { stdout: 'https://github.com/o/r/pull/43' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({
    base: 'main',
    head: 'feat/smoke',
    title: 'smoke',
    allowedPaths: ['smoke-lab/index.html'],
  });
  assert.equal(res.ok, true);
  assert.equal(calls[calls.length - 1].bin, 'gh');
  assert.deepEqual(calls[calls.length - 1].args.slice(0, 3), ['pr', 'create', '--base']);
});

test('openPr: accepts stale expected base only when live base is ancestor of head and scope is clean', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'live-base-sha\n' },
    { stdout: 'head-sha\n' },
    { stdout: '' },
    { stdout: 'src/app.ts\n' },
    { stdout: 'https://github.com/o/r/pull/44' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({
    base: 'main',
    head: 'feat/current-base',
    title: 'current base',
    allowedPaths: ['src/**'],
    expectedBaseSha: 'stale-base-sha',
  });

  assert.equal(res.ok, true);
  assert.equal(res.result.preflight.baseRefresh.refreshed, true);
  assert.equal(res.result.preflight.baseRefresh.previousBaseSha, 'stale-base-sha');
  assert.equal(res.result.preflight.remoteBaseSha, 'live-base-sha');
  assert.equal(res.result.preflight.headSha, 'head-sha');
  const mergeBase = calls.find((call: any) => call.bin === 'git' && call.args[0] === 'merge-base');
  assert.ok(mergeBase);
  assert.deepEqual(mergeBase.args, ['merge-base', '--is-ancestor', 'live-base-sha', 'head-sha']);
  assert.equal(calls[calls.length - 1].bin, 'gh');
});

test('openPr: keeps blocking stale expected base when live base is not in head history', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: 'live-base-sha\n' },
    { stdout: 'head-sha\n' },
    { err: { code: 1 }, stderr: '' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.openPr({
    base: 'main',
    head: 'feat/stale-history',
    title: 'stale',
    allowedPaths: ['src/**'],
    expectedBaseSha: 'stale-base-sha',
  });

  assert.equal(res.ok, false);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.error, 'base_sha_mismatch');
  assert.equal(res.result.remoteBaseSha, 'live-base-sha');
  assert.equal(res.result.expectedBaseSha, 'stale-base-sha');
  assert.equal(res.result.headSha, 'head-sha');
  assert.equal(calls.some((call: any) => call.bin === 'git' && call.args[0] === 'diff'), false);
  assert.equal(calls.some((call: any) => call.bin === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create'), false);
});

test('mergePr: squash by default without raw branch deletion', async () => {
  const { mock, calls } = makeMockExecFile([mergeablePrView, { stdout: 'merged' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: validMergeGate() });
  assert.equal(res.ok, true);
  assert.equal(calls[1].bin, 'gh');
  assert.deepEqual(calls[1].args.slice(0, 3), ['pr', 'merge', '42']);
  assert.ok(calls[1].args.includes('--squash'));
  assert.ok(!calls[1].args.includes('--delete-branch'));
});

test('mergePr: serializes concurrent merges per repo', async () => {
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: 'merged 1' },
    mergeablePrView,
    { stdout: 'merged 2' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const [first, second] = await Promise.all([
    gw.mergePr({ prNumber: 41, gate: validMergeGate() }),
    gw.mergePr({ prNumber: 42, gate: validMergeGate() }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(calls.map((call) => call.args[1]), ['view', 'merge', 'view', 'merge']);
});

test('mergePr: explicit allowed paths satisfy changed-file scope gate', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        baseRefName: 'dev',
        headRefName: 'feat/x',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        files: [{ path: 'src/app.ts' }],
      }),
    },
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    gate: validMergeGate({ allowedPaths: ['src/**'] }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.result?.gate, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['pr', 'merge', '42']);
});

test('mergePr: blocks when GitHub review decision still requires review', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        baseRefName: 'dev',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        reviewDecision: 'REVIEW_REQUIRED',
      }),
    },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: validMergeGate() });

  assert.equal(res.ok, false);
  assert.equal(res.result.error, 'merge gate blocked');
  assert.deepEqual(
    res.result.failures.map((failure: any) => failure.code),
    ['review_required']
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['pr', 'view', '42']);
  assert.match(calls[0].args.join(' '), /reviewDecision/);
});

test('mergePr: denies merge when gate is missing tracking', async () => {
  const { mock, calls } = makeMockExecFile([mergeablePrView]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42 });
  assert.equal(res.ok, false);
  assert.equal(res.phase, 'failure');
  assert.equal(res.result.error, 'merge gate blocked');
  assert.deepEqual(
    res.result.failures.map((failure: any) => failure.code),
    ['untracked_pr', 'cleanup_branch_unknown', 'cleanup_worktree_unknown']
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['pr', 'view', '42']);
});

test('mergePr: adopts task-matched PR context without a child-registry row', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: { expectedBaseBranch: 'dev' },
  });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['pr', 'merge', '42']);
});

test('mergePr: unmatched PR head stays untracked', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        headRefName: 'other/x',
        baseRefName: 'dev',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: { expectedBaseBranch: 'dev' },
  });

  assert.equal(res.ok, false);
  assert.deepEqual(res.result.failures.map((failure: any) => failure.code), ['untracked_pr']);
  assert.equal(calls.length, 1);
});

test('mergePr: wrong-base task match stays blocked by untracked and base gates', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'release',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: { expectedBaseBranch: 'dev' },
  });

  assert.equal(res.ok, false);
  assert.deepEqual(
    res.result.failures.map((failure: any) => failure.code),
    ['untracked_pr', 'wrong_base_branch']
  );
  assert.equal(calls.length, 1);
});

test('mergePr: blocks stale linked PR ref and SHA evidence without merging', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        headRefName: 'feat/live',
        baseRefName: 'dev',
        headRefOid: 'live-head-sha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
    { stdout: 'live-base-sha\n' },
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    branch: 'feat/live',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({
      branch: 'feat/live',
      expectedPrHeadRef: 'feat/stale',
      expectedPrBaseRef: 'release',
      expectedPrHeadSha: 'old-head-sha',
      expectedPrBaseSha: 'old-base-sha',
    }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.phase, 'failure');
  assert.equal(res.result.error, 'merge gate blocked');
  assert.deepEqual(
    res.result.failures.map((failure: any) => failure.code),
    [
      'linked_pr_head_ref_mismatch',
      'linked_pr_base_ref_mismatch',
      'linked_pr_head_sha_mismatch',
      'linked_pr_base_sha_mismatch',
      'base_sha_mismatch',
    ]
  );
  assert.deepEqual(
    calls.map((call) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['git', 'rev-parse', 'origin/dev'],
    ]
  );
  assert.ok(!calls.some((call) => call.bin === 'gh' && call.args[1] === 'merge'));
});

test('mergePr: retries up to RETRY.merge on failure', async () => {
  const fail = { err: { code: 1 }, stderr: 'not mergeable yet' };
  const { mock, calls } = makeMockExecFile([mergeablePrView, fail, fail, fail, fail]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 7, gate: validMergeGate() });
  assert.equal(res.ok, false);
  assert.equal(res.result.attempts, RETRY.merge);
  assert.equal(calls.length, RETRY.merge + 1);
});

test('mergePr: successful merge triggers archive + remote delete + cleanup hook', async (t: any) => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-merge-cleanup-'));
  t.after(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
  const archived: any[] = [];
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: 'merged' },
    {
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-04T12:00:00Z',
        mergeCommit: { oid: 'merge-sha' },
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-after\n' },
    { stdout: '' },
    { stdout: 'remote deleted' },
    { stdout: '' },
    { stdout: '  feat/x\n' },
    { stdout: '' },
    { stdout: 'removed worktree' },
    { stdout: 'Deleted branch feat/x' },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async (payload: any) => {
      archived.push(payload);
    },
  });

  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath,
    prUrl: 'https://github.com/o/r/pull/42',
    gate: validMergeGate(),
  });

  assert.equal(res.ok, true);
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0], {
    taskId: 'tsk_42',
    prUrl: 'https://github.com/o/r/pull/42',
    mergedAt: '2026-05-04T12:00:00Z',
  });
  assert.equal(res.result.postMergeCleanup.ok, true);
  assert.deepEqual(
    calls.map((c) => [c.bin, c.args[0], c.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['gh', 'pr', 'merge'],
      ['gh', 'pr', 'view'],
      ['git', 'fetch', 'origin'],
      ['git', 'rev-parse', '--verify'],
      ['git', 'merge-base', '--is-ancestor'],
      ['git', 'push', 'origin'],
      ['git', '-C', worktreePath],
      ['git', 'branch', '--merged'],
      ['git', 'merge-base', '--is-ancestor'],
      ['git', 'worktree', 'remove'],
      ['git', 'branch', '-d'],
    ]
  );
});

test('pollChecks: polls until checks pass — pending then success', async (t: any) => {
  // Swap setTimeout so the 30s poll interval doesn't block the test.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn: any) => realSetTimeout(fn, 0);
  t.after(() => { global.setTimeout = realSetTimeout; });

  const pending = { stdout: 'some check pending', err: { code: 8 } };
  const done = { stdout: 'all passed' };
  const { mock, calls } = makeMockExecFile([pending, pending, done]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.pollChecks({ prNumber: 42 });
  assert.equal(res.ok, true);
  assert.equal(res.result.attempts, 3);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.bin, 'gh');
    assert.deepEqual(c.args.slice(0, 2), ['pr', 'checks']);
  }
});

test('mergePr: auto mode waits for verified merge evidence before cleanup', async (t: any) => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-auto-wait-cleanup-'));
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn: any) => realSetTimeout(fn, 0);
  t.after(() => {
    global.setTimeout = realSetTimeout;
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
  const archived: any[] = [];
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: 'auto enabled' },
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        mergedAt: null,
        mergeCommit: null,
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-before\n' },
    {
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-04T12:00:00Z',
        mergeCommit: { oid: 'merge-sha' },
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-after\n' },
    { stdout: '' },
    { stdout: 'remote deleted' },
    { stdout: '' },
    { stdout: '  feat/x\n' },
    { stdout: '' },
    { stdout: 'removed worktree' },
    { stdout: 'Deleted branch feat/x' },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async (payload: any) => archived.push(payload),
  });
  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath,
    prUrl: 'https://github.com/o/r/pull/42',
    method: 'squash',
    auto: true,
    gate: validMergeGate(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'success');
  assert.equal(res.result.mergeMode, 'auto');
  assert.equal(res.result.mergeVerification.ok, true);
  assert.equal(res.result.mergeVerification.attempts, 2);
  assert.equal(res.result.mergeVerification.waitAttempts[0].state, 'OPEN');
  assert.equal(res.result.mergeVerification.waitAttempts[1].state, 'MERGED');
  assert.equal(res.result.postMergeCleanup.ok, true);
  assert.equal(archived.length, 1);
  const mergeCall = calls.find((call) => call.bin === 'gh' && call.args[1] === 'merge');
  assert.ok(!mergeCall.args.includes('--auto'));
  assert.ok(!mergeCall.args.includes('--admin'));
  assert.equal(calls.some((call) => call.bin === 'git' && call.args[0] === 'push' && call.args[2] === '--delete'), true);
  assert.equal(calls.some((call) => call.bin === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove'), true);
});

test('mergePr: auto mode treats closed-unmerged as unverified and does not cleanup', async (t: any) => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-auto-closed-cleanup-'));
  t.after(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
  const archived: any[] = [];
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: 'auto enabled' },
    {
      stdout: JSON.stringify({
        state: 'CLOSED',
        mergedAt: null,
        mergeCommit: null,
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-before\n' },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async (payload: any) => archived.push(payload),
  });

  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath,
    auto: true,
    gate: validMergeGate(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.phase, 'pending');
  assert.equal(res.result.error, 'merge_not_verified');
  assert.equal(res.result.mergeVerification.githubMerged, false);
  assert.equal(res.result.mergeVerification.pr.state, 'CLOSED');
  assert.equal(res.result.postMergeCleanup, undefined);
  assert.equal(archived.length, 0);
  assert.equal(calls.some((call) => call.bin === 'git' && call.args[0] === 'push' && call.args[2] === '--delete'), false);
  assert.equal(calls.some((call) => call.bin === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove'), false);
});

test('mergePr: auto mode runs cleanup after GitHub reports verified merged evidence', async (t: any) => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-auto-merge-cleanup-'));
  t.after(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
  const archived: any[] = [];
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: 'merged' },
    {
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-04T12:00:00Z',
        mergeCommit: { oid: 'merge-sha' },
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-after\n' },
    { stdout: '' },
    { stdout: 'remote deleted' },
    { stdout: '' },
    { stdout: '  feat/x\n' },
    { stdout: '' },
    { stdout: 'removed worktree' },
    { stdout: 'Deleted branch feat/x' },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async (payload: any) => {
      archived.push(payload);
    },
  });

  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath,
    prUrl: 'https://github.com/o/r/pull/42',
    auto: true,
    gate: validMergeGate(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'success');
  assert.equal(res.result.mergeMode, 'auto');
  assert.equal(res.result.mergeVerification.ok, true);
  assert.equal(res.result.postMergeCleanup.ok, true);
  assert.deepEqual(archived[0], {
    taskId: 'tsk_42',
    prUrl: 'https://github.com/o/r/pull/42',
    mergedAt: '2026-05-04T12:00:00Z',
  });
  const mergeCall = calls.find((call) => call.bin === 'gh' && call.args[1] === 'merge');
  assert.ok(!mergeCall.args.includes('--auto'));
  assert.equal(calls.some((call) => call.bin === 'git' && call.args[0] === 'push' && call.args[2] === '--delete'), true);
});

test('mergePr: auto mode waits for pending checks, rereads PR state, then merges directly', async (t: any) => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn: any) => realSetTimeout(fn, 0);
  t.after(() => { global.setTimeout = realSetTimeout; });

  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        state: 'OPEN',
        baseRefName: 'dev',
        mergeable: 'UNKNOWN',
        statusCheckRollup: [{ state: 'PENDING' }],
      }),
    },
    { err: { code: 8 }, stdout: 'lint-and-build pending' },
    { stdout: 'lint-and-build pass' },
    mergeablePrView,
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    gate: validMergeGate({ cleanup: { required: false } }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.result.mergeMode, 'auto');
  assert.equal(res.result.checkWait.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['gh', 'pr', 'checks'],
      ['gh', 'pr', 'checks'],
      ['gh', 'pr', 'view'],
      ['gh', 'pr', 'merge'],
    ]
  );
  const mergeCall = calls.find((call) => call.bin === 'gh' && call.args[1] === 'merge');
  assert.ok(!mergeCall.args.includes('--auto'));
});

test('mergePr: auto mode falls back to admin merge when branch policy requires it', async (t: any) => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn: any) => realSetTimeout(fn, 0);
  t.after(() => { global.setTimeout = realSetTimeout; });

  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-auto-fallback-cleanup-'));
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));

  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { stdout: 'admin merged' },
    {
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-04T12:00:00Z',
        mergeCommit: { oid: 'merge-sha' },
        headRefOid: 'head-sha',
        baseRefName: 'dev',
      }),
    },
    { stdout: '' },
    { stdout: 'base-after\n' },
    { stdout: '' },
    { stdout: 'remote deleted' },
    { stdout: '' },
    { stdout: '  feat/x\n' },
    { stdout: '' },
    { stdout: 'removed worktree' },
    { stdout: 'Deleted branch feat/x' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath,
    gate: validMergeGate(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.result.githubAutoRequested, false);
  assert.equal(res.result.adminFallbackRequested, true);
  assert.equal(res.result.adminReason, 'Ace auto-merge PR #42: gate passed, checks green, PR mergeable; direct merge blocked by branch policy.');
  const mergeCalls = calls.filter((call) => call.bin === 'gh' && call.args[1] === 'merge');
  assert.equal(mergeCalls.length, 4);
  assert.ok(!mergeCalls[0].args.includes('--auto'));
  assert.ok(!mergeCalls[3].args.includes('--auto'));
  assert.ok(mergeCalls[3].args.includes('--admin'));
});

test('mergePr: unauthorized GitHub merge errors are explicit and do not fall back to auto', async () => {
  const authFail = { err: { code: 1 }, stderr: 'HTTP 401: Unauthorized; gh auth login required' };
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    authFail,
    authFail,
    authFail,
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    gate: validMergeGate({ cleanup: { required: false } }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.result.error, 'github_auth_or_permission_failure');
  assert.match(res.result.safeNextCommand, /gh auth status/);
  assert.equal(res.result.auth.unauthorized, true);
  const mergeCalls = calls.filter((call) => call.bin === 'gh' && call.args[1] === 'merge');
  assert.equal(mergeCalls.length, RETRY.merge);
  assert.ok(mergeCalls.every((call) => !call.args.includes('--auto')));
  assert.ok(mergeCalls.every((call) => !call.args.includes('--admin')));
});

test('mergePr: admin mode requires explicit reason', async () => {
  const { mock, calls } = makeMockExecFile([]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, admin: true, gate: validMergeGate() });
  assert.equal(res.ok, false);
  assert.equal(res.result.error, 'admin_reason_required');
  assert.equal(calls.length, 0);
});

test('mergePr: branch policy rejection returns safe Ace next command', async () => {
  const { mock } = makeMockExecFile([
    mergeablePrView,
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
    { err: { code: 1 }, stderr: 'GraphQL: Pull request is not mergeable; use --auto or --admin' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    taskId: 'tsk_42',
    gate: validMergeGate({ cleanup: { required: false } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.result.error, 'branch_policy_requires_auto_or_admin');
  assert.deepEqual(res.result.recommendedModes, ['auto', 'admin']);
  assert.match(res.result.safeNextCommand, /ace integrate pr-merge --task tsk_42 --pr 42 --auto/);
});

test('pollChecks: bails out on hard failure (non-pending)', async (t: any) => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn: any) => realSetTimeout(fn, 0);
  t.after(() => { global.setTimeout = realSetTimeout; });

  const hard = { err: { code: 1 }, stderr: 'no such PR' };
  const { mock, calls } = makeMockExecFile([hard]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.pollChecks({ prNumber: 999 });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1);
});

test('pollChecks: missing param → failure envelope, no shell', async () => {
  const { mock, calls } = makeMockExecFile([]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.pollChecks({});
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

test('gatePr: reports PASS with exact head/base evidence and performs no mutation', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'OPEN',
        title: 'ready',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        isDraft: false,
        reviewDecision: 'APPROVED',
      }),
    },
    { stdout: 'basesha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate(),
    feature: { missionId: 'msn_1', featureId: 'ft_1', validationStatus: 'validation_passed' },
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'pass');
  assert.equal(res.action, 'gatePr');
  assert.equal(res.result.status, 'PASS');
  assert.equal(res.result.pr.headSha, 'headsha');
  assert.equal(res.result.pr.baseSha, 'basesha');
  assert.equal(res.result.pr.checkState, 'success');
  assert.equal(res.result.gate.readyToMerge, true);
  assert.deepEqual(
    calls.map((call) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['git', 'rev-parse', 'origin/dev'],
    ]
  );
  assert.ok(!calls.some((call) => call.bin === 'gh' && call.args[1] === 'merge'));
  assert.ok(!calls.some((call) => call.bin === 'git' && call.args.includes('--delete')));
});

test('gatePr: parses ANSI-wrapped gh --json stdout', async () => {
  const { mock } = makeMockExecFile([
    {
      stdout: ansiWrapJson({
        number: 47,
        url: 'https://github.com/o/r/pull/47',
        state: 'OPEN',
        title: 'ready',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        isDraft: false,
        reviewDecision: 'APPROVED',
      }),
    },
    { stdout: 'basesha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 47,
    taskId: 'tsk_47',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'pass');
  assert.equal(res.result.status, 'PASS');
  assert.equal(res.result.pr.state, 'OPEN');
  assert.equal(res.result.pr.checkState, 'success');
  assert.equal(res.result.gate.failures.some((failure: any) => failure.code === 'github_pr_view_failed'), false);
  assert.doesNotMatch(JSON.stringify(res.result), /Unexpected token/);
});

test('gatePr: linked PR base SHA wins over stale generic expected base SHA', async () => {
  const { mock } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 48,
        url: 'https://github.com/o/r/pull/48',
        state: 'OPEN',
        title: 'ready',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        isDraft: false,
        reviewDecision: 'APPROVED',
      }),
    },
    { stdout: 'live-base-sha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 48,
    taskId: 'tsk_48',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({ expectedBaseSha: 'stale-base-sha' }),
    feature: { missionId: 'msn_1', featureId: 'ft_1', prBaseSha: 'live-base-sha' },
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'pass');
  assert.equal(res.result.status, 'PASS');
  assert.equal(res.result.gate.expectedPr.baseSha, 'live-base-sha');
  assert.equal(res.result.gate.actualPr.baseSha, 'live-base-sha');
  assert.equal(res.result.reasons.some((reason: any) => reason.code === 'base_sha_mismatch'), false);
  assert.equal(res.result.reasons.some((reason: any) => reason.code === 'linked_pr_base_sha_mismatch'), false);
});

test('gatePr: reports BLOCKED reasons without merge or cleanup', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 43,
        url: 'https://github.com/o/r/pull/43',
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'CONFLICTING',
        statusCheckRollup: [{ conclusion: 'FAILURE' }],
      }),
    },
    { stdout: 'basesha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 43,
    taskId: 'tsk_43',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({ validation: { self: 'FAIL', independent: null, fixback: 'open' } }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.status, 'BLOCKED');
  assert.deepEqual(
    res.result.reasons.map((reason: any) => reason.code),
    ['checks_not_green', 'not_mergeable', 'validation_failed', 'unresolved_fixback']
  );
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((call) => call.bin === 'gh' && call.args[1] === 'merge'));
  assert.ok(!calls.some((call) => call.bin === 'git' && call.args[0] === 'branch'));
});

test('gatePr: includes PR changed files and blocks scope contamination', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 45,
        url: 'https://github.com/o/r/pull/45',
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        files: [{ path: 'src/app.ts' }, { path: 'electron/local-core.cts' }],
      }),
    },
    { stdout: 'basesha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 45,
    taskId: 'tsk_45',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({ allowedPaths: ['src/**'] }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.status, 'BLOCKED');
  assert.deepEqual(res.result.pr.files, ['src/app.ts', 'electron/local-core.cts']);
  const scope = res.result.reasons.find((reason: any) => reason.code === 'scope_contamination');
  assert.ok(scope);
  assert.deepEqual(scope.unexpectedFiles, ['electron/local-core.cts']);
  assert.deepEqual(res.result.gate.scope.unexpectedFiles, ['electron/local-core.cts']);
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((call) => call.bin === 'gh' && call.args[1] === 'merge'));
});

test('gatePr: blocks changed files when scope is missing', async () => {
  const { mock } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 46,
        url: 'https://github.com/o/r/pull/46',
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        files: [{ path: 'src/app.ts' }],
      }),
    },
    { stdout: 'basesha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 46,
    taskId: 'tsk_46',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'blocked');
  const scope = res.result.reasons.find((reason: any) => reason.code === 'scope_missing');
  assert.ok(scope);
  assert.deepEqual(scope.changedFiles, ['src/app.ts']);
  assert.deepEqual(scope.unexpectedFiles, ['src/app.ts']);
});

test('gatePr: blocks stale linked PR ref and SHA evidence even with green checks', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 44,
        url: 'https://github.com/o/r/pull/44',
        state: 'OPEN',
        headRefName: 'feat/live',
        baseRefName: 'dev',
        headRefOid: 'live-head-sha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
    },
    { stdout: 'live-base-sha\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 44,
    taskId: 'tsk_44',
    branch: 'feat/live',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({
      branch: 'feat/live',
      expectedPrHeadRef: 'feat/stale',
      expectedPrBaseRef: 'release',
      expectedPrHeadSha: 'old-head-sha',
      expectedPrBaseSha: 'old-base-sha',
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.status, 'BLOCKED');
  assert.equal(res.result.pr.checkState, 'success');
  assert.equal(res.result.pr.mergeable, 'MERGEABLE');
  assert.deepEqual(
    res.result.reasons.map((reason: any) => reason.code),
    [
      'linked_pr_head_ref_mismatch',
      'linked_pr_base_ref_mismatch',
      'linked_pr_head_sha_mismatch',
      'linked_pr_base_sha_mismatch',
      'base_sha_mismatch',
    ]
  );
  assert.deepEqual(res.result.gate.expectedPr, {
    headRef: 'feat/stale',
    baseRef: 'release',
    headSha: 'old-head-sha',
    baseSha: 'old-base-sha',
  });
  assert.deepEqual(res.result.gate.actualPr, {
    headRef: 'feat/live',
    baseRef: 'dev',
    headSha: 'live-head-sha',
    baseSha: 'live-base-sha',
  });
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((call) => call.bin === 'gh' && call.args[1] === 'merge'));
  assert.ok(!calls.some((call) => call.bin === 'git' && call.args[0] === 'branch'));
});

test('deleteBranch: local only by default', async () => {
  const { mock, calls } = makeMockExecFile([{ stdout: 'Deleted branch feat/x' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.deleteBranch({ branch: 'feat/x' });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['branch', '-D', 'feat/x']);
  assert.equal(res.result.remote, null);
});

test('deleteBranch: with includeRemote runs two commands', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: 'Deleted branch feat/x' },
    { stdout: 'remote deleted' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.deleteBranch({ branch: 'feat/x', includeRemote: true });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['push', 'origin', '--delete', 'feat/x']);
});

test('cleanup: treats a missing local branch as ok (idempotent)', async () => {
  const merged = { stdout: '  feat/x\n' };
  const missing = { err: { code: 1 }, stderr: "error: branch 'feat/x' not found." };
  const remoteOk = { stdout: 'deleted' };
  const { mock } = makeMockExecFile([merged, missing, remoteOk]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main' });
  assert.equal(res.ok, true);
  assert.equal(res.result.local.missing, true);
});

test('cleanup: treats missing remote ref as ok (idempotent re-run after merge)', async () => {
  const merged = { stdout: '  feat/x\n' };
  const localOk = { stdout: 'Deleted branch feat/x' };
  const remoteMissing = {
    err: { code: 1 },
    stderr: "error: unable to delete 'feat/x': remote ref does not exist",
  };
  const { mock } = makeMockExecFile([merged, localOk, remoteMissing]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main' });
  assert.equal(res.ok, true);
  assert.equal(res.result.remote.missing, true);
});

test('cleanup: dry-run reports safety without deleting anything', async () => {
  const { mock, calls } = makeMockExecFile([{ stdout: '  feat/x\n' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main', dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.result.safety.dryRun, true);
  assert.equal(res.result.local.skipped, true);
  assert.equal(res.result.remote.skipped, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['branch', '--merged', 'origin/main']);
});

test('cleanup: uses remote-tracking base before stale local base', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '  main\n  feat/x\n' },
    { stdout: 'Deleted branch feat/x' },
    { stdout: 'deleted' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main', remote: 'origin' });
  assert.equal(res.ok, true);
  assert.equal(res.result.safety.branch.evidenceRef, 'origin/main');
  assert.deepEqual(calls[0].args, ['branch', '--merged', 'origin/main']);
  assert.equal(calls.some((call) => call.bin === 'git' && call.args.join(' ') === 'branch --merged main'), false);
});

test('cleanup: verified merge commit allows squash-merged branches without branch ancestry', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: '  main\n' },
    { stdout: '* main\n' },
    { stdout: '' },
    { stdout: 'Deleted branch feat/x' },
    { stdout: 'deleted' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main', prState: 'MERGED', mergedSha: 'merge-sha' });
  assert.equal(res.ok, true);
  assert.equal(res.result.safety.mergeCommit.evidenceRef, 'origin/main');
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['branch', '--merged', 'origin/main'],
    ['branch', '--merged', 'main'],
    ['merge-base', '--is-ancestor', 'merge-sha'],
    ['branch', '-d', 'feat/x'],
    ['push', 'origin', '--delete'],
  ]);
});

test('cleanup: deletes branch from stable repo cwd after removing worktree', async (t: any) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cleanup-repo-'));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cleanup-wt-'));
  t.after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  const { mock, calls } = makeMockExecFile([
    { stdout: '' },
    { stdout: '  main\n' },
    { stdout: '  main\n' },
    { stdout: '' },
    { stdout: 'removed worktree' },
    ({ args, opts }: any) => {
      assert.deepEqual(args, ['branch', '-d', 'feat/x']);
      if (opts.cwd === worktreePath) {
        return { err: { code: 1 }, stderr: '' };
      }
      return { stdout: 'Deleted branch feat/x' };
    },
    { stdout: 'deleted' },
  ]);
  const gw = createIntegrationGateway({
    cwd: worktreePath,
    repoCwd: repoRoot,
    logger: silentLogger(),
    execFileImpl: mock,
  });
  const res = await gw.cleanup({ branch: 'feat/x', worktreePath, baseBranch: 'main', prState: 'MERGED', mergedSha: 'merge-sha' });

  assert.equal(res.ok, true);
  assert.equal(res.result.worktree.code, 0);
  assert.equal(res.result.local.code, 0);
  assert.equal(calls[4].opts.cwd, worktreePath, 'worktree removal keeps task cwd');
  assert.equal(calls[5].opts.cwd, repoRoot, 'local branch deletion uses stable repo cwd');
  assert.equal(calls[6].opts.cwd, repoRoot, 'remote branch deletion uses stable repo cwd');
});

test('cleanup: checked-out local branch blocker is reported as a failure', async () => {
  const checkedOut = {
    err: { code: 1 },
    stderr: "error: Cannot delete branch 'feat/x' checked out at '/tmp/other-worktree'",
  };
  const { mock } = makeMockExecFile([{ stdout: '  feat/x\n' }, checkedOut, checkedOut, checkedOut, { stdout: 'deleted' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.result.local.code, 1);
  assert.equal(res.result.local.missing, false);
  assert.match(res.result.local.stderr, /checked out/);
});

test('cleanup: empty branch-delete failure is not masked as idempotent success', async () => {
  const emptyFailure = { err: { code: 1 }, stderr: '' };
  const { mock } = makeMockExecFile([{ stdout: '  feat/x\n' }, emptyFailure, emptyFailure, emptyFailure, { stdout: 'deleted' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.result.local.code, 1);
  assert.equal(res.result.local.missing, false);
});

test('cleanup: blocks dirty worktree and does not remove branch or worktree', async (t: any) => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-dirty-cleanup-'));
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
  const { mock, calls } = makeMockExecFile([
    { stdout: ' M file.txt\n' },
    { stdout: '  feat/x\n' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', worktreePath, baseBranch: 'main' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.result.safety.blockers.map((b: any) => b.code), ['worktree_dirty']);
  assert.equal(res.result.worktree.reason, 'safety blocked');
  assert.equal(res.result.local.reason, 'safety blocked');
  assert.equal(calls.length, 2);
});

test('cleanup: blocks open or unmerged branches before deletion', async () => {
  const { mock, calls } = makeMockExecFile([{ stdout: '  main\n' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.cleanup({ branch: 'feat/x', baseBranch: 'main', prState: 'OPEN' });
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.result.safety.blockers.map((b: any) => b.code),
    ['pr_open', 'branch_unmerged']
  );
  assert.equal(res.result.local.reason, 'safety blocked');
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.args[0] === 'branch' && call.args[1] === '-d'), false);
});

test('postMergeCleanup: archive writes an integration event and missing git state is treated as idempotent', async () => {
  const archived = [];
  const remoteMissing = {
    err: { code: 1 },
    stderr: "error: unable to delete 'feat/x': remote ref does not exist",
  };
  const worktreeMissing = {
    err: { code: 1 },
    stderr: "fatal: '/tmp/wt' is not a working tree",
  };
  const localMissing = {
    err: { code: 1 },
    stderr: "error: branch 'feat/x' not found.",
  };
  const { mock } = makeMockExecFile([remoteMissing, { stdout: '  feat/x\n' }, worktreeMissing, localMissing]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async (payload: any) => {
      archived.push(payload);
    },
  });
  const events = collect(gw);

  const res = await gw.postMergeCleanup({
    taskId: 'tsk_1',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    prUrl: 'https://github.com/o/r/pull/1',
    mergedAt: '2026-04-20T12:00:00.000Z',
    baseBranch: 'main',
    prState: 'MERGED',
  });

  assert.equal(res.ok, true);
  assert.equal(archived.length, 1);
  assert.equal(res.archiveTask.ok, true);
  assert.equal(res.deleteRemoteBranch.ok, true);
  assert.equal(res.deleteRemoteBranch.result.missing, true);
  assert.equal(res.cleanup.ok, true);
  assert.equal(res.cleanup.result.worktree.missing, true);
  assert.equal(res.cleanup.result.local.missing, true);
  assert.deepEqual(
    events.map((env) => env.action),
    ['archiveTask', 'deleteRemoteBranch', 'cleanup']
  );
});

test('postMergeCleanup: one step failing does not block later steps', async () => {
  const { mock, calls } = makeMockExecFile([
    { stdout: 'remote deleted' },
    { stdout: '  feat/x\n' },
    { stdout: 'removed worktree' },
    { stdout: 'Deleted branch feat/x' },
  ]);
  const gw = createIntegrationGateway({
    cwd: '/tmp',
    logger: silentLogger(),
    execFileImpl: mock,
    archiveTaskImpl: async () => {
      throw new Error('db temporarily locked');
    },
  });

  const res = await gw.postMergeCleanup({
    taskId: 'tsk_1',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    prState: 'MERGED',
  });

  assert.equal(res.ok, false);
  assert.equal(res.archiveTask.ok, false);
  assert.equal(res.deleteRemoteBranch.ok, true);
  assert.equal(res.cleanup.ok, true);
  assert.equal(calls.length, 4, 'cleanup shell steps should still run after archive failure');
});

test('bus: action-specific event fires alongside the generic integration event', async () => {
  const { mock } = makeMockExecFile([{ stdout: 'ok' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const received = { integration: 0, push: 0 };
  gw.on('integration', () => (received.integration += 1));
  gw.on('push', () => (received.push += 1));
  await gw.push({ branch: 'feat/x' });
  assert.equal(received.integration, 1);
  assert.equal(received.push, 1);
});

test('envelope shape: every field present, durationMs is a non-negative integer', async () => {
  const { mock } = makeMockExecFile([{ stdout: 'ok' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.push({ branch: 'feat/x' });
  for (const key of ['ok', 'phase', 'action', 'params', 'result', 'durationMs', 'timestamp']) {
    assert.ok(key in res, `envelope missing ${key}`);
  }
  assert.equal(typeof res.durationMs, 'number');
  assert.ok(res.durationMs >= 0);
  assert.equal(typeof res.timestamp, 'number');
});

test('factory: requires cwd', () => {
  assert.throws(() => createIntegrationGateway({}), /cwd is required/);
});

// ── Automerge policy + release-train guard ──────────────────────────────────

function automergeGate(extra: any = {}) {
  return validMergeGate({
    automerge: true,
    expectedPrHeadSha: 'headsha',
    validation: { self: 'PASS', independent: 'PASS', fixback: null, highRisk: false },
    ...extra,
  });
}

// The train guard probes BOTH publishing workflows (release.yml + promote.yml).
const idleRunList = { stdout: JSON.stringify([{ status: 'completed', databaseId: 6, event: 'push' }]) };

test('mergePr: automerge blocks while a release train is publishing', async () => {
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: JSON.stringify([{ status: 'in_progress', databaseId: 7, event: 'push' }]) },
    idleRunList,
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: automergeGate() });

  assert.equal(res.ok, false);
  assert.equal(res.result.error, 'merge gate blocked');
  assert.ok(res.result.failures.some((failure: any) => failure.code === 'release_train_publishing'));
  assert.equal(res.result.gate.releaseTrain.state, 'publishing');
  // Train evidence is read live in the same pre-merge pass as the PR intel
  // (release.yml AND promote.yml), and the merge itself never runs.
  assert.deepEqual(
    calls.map((call: any) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['gh', 'run', 'list'],
      ['gh', 'run', 'list'],
    ]
  );
  assert.deepEqual(
    calls.filter((call: any) => call.args[0] === 'run').map((call: any) => call.args[3]),
    ['release.yml', 'promote.yml']
  );
});

test('mergePr: automerge proceeds once the release train is idle', async () => {
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    idleRunList,
    idleRunList,
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: automergeGate() });

  assert.equal(res.ok, true);
  assert.deepEqual(
    calls.map((call: any) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['gh', 'run', 'list'],
      ['gh', 'run', 'list'],
      ['gh', 'pr', 'merge'],
    ]
  );
});

test('mergePr: automerge requires an independent validator PASS', async () => {
  // Self-validation alone merges fine in the operator lane but NOT via automerge.
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { stdout: '[]' },
    { stdout: '[]' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({
    prNumber: 42,
    gate: validMergeGate({ automerge: true, expectedPrHeadSha: 'headsha' }),
  });

  assert.equal(res.ok, false);
  assert.ok(res.result.failures.some((failure: any) => failure.code === 'automerge_validator_pass_required'));
  assert.ok(!calls.some((call: any) => call.args[1] === 'merge'));
});

test('mergePr: a broken train probe fails open and does not block automerge', async () => {
  const { mock, calls } = makeMockExecFile([
    mergeablePrView,
    { err: { code: 1 }, stderr: 'could not find any workflows named release.yml' },
    { err: { code: 1 }, stderr: 'could not find any workflows named promote.yml' },
    { stdout: 'merged' },
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: automergeGate() });

  assert.equal(res.ok, true);
  // unknown (probe error) degrades open — the merge ran after the failed probes.
  assert.deepEqual(
    calls.map((call: any) => [call.bin, call.args[0], call.args[1]]),
    [
      ['gh', 'pr', 'view'],
      ['gh', 'run', 'list'],
      ['gh', 'run', 'list'],
      ['gh', 'pr', 'merge'],
    ]
  );
});

test('mergePr: operator merges without the guard never read train state', async () => {
  const { mock, calls } = makeMockExecFile([mergeablePrView, { stdout: 'merged' }]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.mergePr({ prNumber: 42, gate: validMergeGate() });

  assert.equal(res.ok, true);
  assert.ok(!calls.some((call: any) => call.bin === 'gh' && call.args[0] === 'run'));
});

test('gatePr: releaseTrainGuard reports live train evidence read-only', async () => {
  const { mock, calls } = makeMockExecFile([
    {
      stdout: JSON.stringify({
        number: 42,
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'dev',
        headRefOid: 'headsha',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        isDraft: false,
        reviewDecision: 'APPROVED',
      }),
    },
    { stdout: 'basesha\n' },
    { stdout: JSON.stringify([{ status: 'queued', databaseId: 9, event: 'push' }]) },
    idleRunList,
  ]);
  const gw = createIntegrationGateway({ cwd: '/tmp', logger: silentLogger(), execFileImpl: mock });
  const res = await gw.gatePr({
    prNumber: 42,
    taskId: 'tsk_42',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    gate: validMergeGate({ releaseTrainGuard: true }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.phase, 'blocked');
  assert.equal(res.result.status, 'BLOCKED');
  assert.ok(res.result.reasons.some((failure: any) => failure.code === 'release_train_publishing'));
  assert.equal(res.result.releaseTrain.state, 'publishing');
  assert.deepEqual(res.result.noMutation.github, ['gh pr view', 'gh run list']);
  assert.ok(!calls.some((call: any) => call.args[1] === 'merge'));
});

// --- buildGatewayGateInput: gate-result → gate-input round-trip (the #417
// broken-closed bug: nested expectedPr.headSha was dropped by the gateway's
// flattened-field mapping, so a re-used gate result lost its exact-head pin).
const { buildGatewayGateInput } = require('../integration-gateway.cjs');
const { evaluateMergeGate } = require('../../tools/ace/src/pr-gate.cjs');

function gatewayClawpatchGate(t: any, validatedHeadSha: string) {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-gateway-clawpatch-'));
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
  const artifactDir = path.join(worktreePath, '.ace', 'validation', 'clawpatch');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'latest.json'), JSON.stringify({
    schema: 'ace.clawpatch_validation.v1',
    status: 'pass',
    blockingFindings: [],
    validatedHeadSha,
  }));
  const input = buildGatewayGateInput({
    gate: { clawpatchEnforced: true },
    prNumber: 7,
    tracked: true,
    pr: { headBranch: 'feat/x', baseBranch: 'main', headSha: 'head-current', changedFiles: [] },
    expectedBaseBranch: 'main',
    branch: 'feat/x',
    worktreePath,
  });
  return evaluateMergeGate(input);
}

test('gateway propagates the Clawpatch artifact validated head', (t: any) => {
  const result = gatewayClawpatchGate(t, 'head-current');
  assert.equal(result.clawpatch.validatedHeadSha, 'head-current');
});

test('gateway preserves a stale Clawpatch artifact head without replacing it', (t: any) => {
  const result = gatewayClawpatchGate(t, 'head-stale');
  assert.equal(result.clawpatch.validatedHeadSha, 'head-stale');
  assert.notEqual(result.clawpatch.validatedHeadSha, result.actualPr.headSha);
});

test('evaluateMergeGate preserves the native-review validated head', () => {
  const result = evaluateMergeGate({
    tracked: true,
    baseBranch: 'main',
    expectedBaseBranch: 'main',
    headRefName: 'feat/x',
    expectedPrHeadRef: 'feat/x',
    headSha: 'head-current',
    expectedPrHeadSha: 'head-current',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    branch: 'feat/x',
    worktreePath: '/tmp/wt',
    validation: { self: 'PASS', validatedHeadSha: 'head-reviewed' },
  });
  assert.equal(result.validation.headSha, 'head-reviewed');
});

test('buildGatewayGateInput: nested expectedPr from a prior gate result survives the round-trip', () => {
  const pinned = evaluateMergeGate({
    tracked: true,
    prNumber: 7,
    expectedHeadSha: 'abc123abc123',
    actualHeadSha: 'abc123abc123',
    headRefName: 'feat/x',
    baseRefName: 'main',
    expectedBaseBranch: 'main',
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    prState: 'OPEN',
  });
  assert.equal(pinned.expectedPr.headSha, 'abc123abc123');
  // Re-use the RESULT as the gate input (what the merge path receives).
  const input = buildGatewayGateInput({
    gate: pinned,
    feature: null,
    prNumber: 7,
    tracked: true,
    pr: {
      headBranch: 'feat/x',
      baseBranch: 'main',
      headSha: 'abc123abc123',
      baseSha: null,
      isDraft: false,
      changedFiles: [],
      prState: 'OPEN',
      checkState: 'success',
      mergeable: 'MERGEABLE',
      reviewDecision: null,
    },
    expectedBaseBranch: 'main',
    branch: 'feat/x',
    worktreePath: null,
  });
  assert.equal(input.expectedPrHeadSha, 'abc123abc123');
  const second = evaluateMergeGate(input);
  assert.equal(second.expectedPr.headSha, 'abc123abc123');
  assert.equal(second.failures.some((f: any) => f.code === 'automerge_exact_head_evidence_required'), false);
});

test('buildGatewayGateInput: stale live head against the pinned head still blocks', () => {
  const pinned = evaluateMergeGate({
    tracked: true,
    prNumber: 7,
    expectedHeadSha: 'abc123abc123',
    actualHeadSha: 'abc123abc123',
    headRefName: 'feat/x',
    baseRefName: 'main',
    baseBranch: 'main',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    prState: 'OPEN',
  });
  const input = buildGatewayGateInput({
    gate: pinned,
    prNumber: 7,
    tracked: true,
    pr: { headBranch: 'feat/x', baseBranch: 'main', headSha: 'def456def456', changedFiles: [], prState: 'OPEN', checkState: 'success', mergeable: 'MERGEABLE' },
    expectedBaseBranch: 'main',
    branch: 'feat/x',
  });
  const second = evaluateMergeGate(input);
  assert.equal(second.ok, false);
  assert.equal(second.failures.some((f: any) => f.code === 'linked_pr_head_sha_mismatch'), true);
});
