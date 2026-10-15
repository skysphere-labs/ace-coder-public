import { afterEach, expect, test, vi } from 'vitest';

const { EventEmitter } = require('node:events');
const { createGithubCore, parseAuthStatus, writeTokenToGh } = require('../github-core.cts');

const cores = [];
const requestId = 'ghreq_12345678-1234-4123-8123-123456789abc';
const deviceCode = `device_${'d'.repeat(32)}`;
const accessToken = `gho_${'a'.repeat(36)}`;

afterEach(() => {
  for (const core of cores.splice(0)) core.loginCancel();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deviceResponse(expiresIn = 900) {
  return {
    device_code: deviceCode,
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device',
    expires_in: expiresIn,
    interval: 5,
  };
}

function authCore(options = {}) {
  const core = createGithubCore({
    detectGhImpl: async () => ({ installed: true, version: '2.80.0' }),
    ...options,
  });
  cores.push(core);
  return core;
}

test('GitHub account discovery tolerates forced-color auth status output', () => {
  const output = [
    '\u001b[0;1;39mgithub.com\u001b[0m',
    '  \u001b[0;32m✓\u001b[0m Logged in to github.com account \u001b[0;1;39moctodev\u001b[0m (keyring)',
    '  - Active account: \u001b[0;1;39mtrue\u001b[0m',
    '',
    '  \u001b[0;32m✓\u001b[0m Logged in to github.com account \u001b[0;1;39mother-dev\u001b[0m (keyring)',
    '  - Active account: \u001b[0;1;39mfalse\u001b[0m',
  ].join('\n');

  expect(parseAuthStatus(output)).toEqual([
    { login: 'octodev', isActive: true },
    { login: 'other-dev', isActive: false },
  ]);
});

test('GitHub account discovery ignores non-github.com host blocks', () => {
  expect(parseAuthStatus([
    'enterprise.example.test',
    '  ✓ Logged in to enterprise.example.test account employee',
    '  - Active account: true',
  ].join('\n'))).toEqual([]);
});

test('keeps the device credential in the main process and coalesces duplicate polls', async () => {
  let tokenRequests = 0;
  let handoffs = 0;
  const requests = [];
  const authLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const core = authCore({
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/login/device/code')) return json(deviceResponse());
      tokenRequests += 1;
      return json({ access_token: accessToken, token_type: 'bearer', scope: 'repo' });
    },
    writeTokenToGhImpl: async (token) => {
      handoffs += 1;
      expect(token).toBe(accessToken);
      return { ok: true };
    },
    invalidateAccountStateImpl: () => {},
    listAccountsImpl: async () => [{ login: 'octodev', isActive: true }],
  });

  const started = await core.loginStart({ requestId });
  expect(started).toMatchObject({ ok: true, requestId, userCode: 'ABCD-EFGH' });
  expect(started).not.toHaveProperty('deviceCode');
  expect(JSON.stringify(started)).not.toContain(deviceCode);

  const first = core.loginPoll({ requestId });
  const second = core.loginPoll({ requestId });
  expect(first).toBe(second);
  await expect(Promise.all([first, second])).resolves.toEqual([
    { ok: true, login: 'octodev' },
    { ok: true, login: 'octodev' },
  ]);
  expect(tokenRequests).toBe(1);
  expect(handoffs).toBe(1);

  expect(requests).toHaveLength(2);
  expect(requests[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(requests[0].init.body))).toEqual({
    client_id: '178c6fc778ccc68e1d6a',
    scope: 'repo read:org gist workflow',
  });
  expect(requests[1].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(requests[1].init.body))).toEqual({
    client_id: '178c6fc778ccc68e1d6a',
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  expect(JSON.stringify(authLog.mock.calls)).not.toContain('ABCD-EFGH');
  expect(JSON.stringify(authLog.mock.calls)).not.toContain(deviceCode);
  expect(JSON.stringify(authLog.mock.calls)).not.toContain(accessToken);
});

test('cancels a login start before device-code creation completes', async () => {
  let releaseDetection;
  const detection = new Promise((resolve) => { releaseDetection = resolve; });
  let fetched = false;
  const core = authCore({
    detectGhImpl: () => detection,
    fetchImpl: async () => { fetched = true; return json(deviceResponse()); },
  });

  const starting = core.loginStart({ requestId });
  expect(core.loginCancel({ requestId })).toEqual({ ok: true });
  releaseDetection({ installed: true });

  await expect(starting).resolves.toEqual({ ok: false, error: 'cancelled' });
  expect(fetched).toBe(false);
  expect(core.loginPoll({ requestId })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
});

test('cancellation aborts an in-flight token poll before keyring handoff', async () => {
  let pollStartedResolve;
  const pollStarted = new Promise((resolve) => { pollStartedResolve = resolve; });
  let handoffs = 0;
  const core = authCore({
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/login/device/code')) return json(deviceResponse());
      pollStartedResolve();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
    writeTokenToGhImpl: async () => { handoffs += 1; return { ok: true }; },
  });
  await core.loginStart({ requestId });
  const polling = core.loginPoll({ requestId });
  await pollStarted;
  core.loginCancel({ requestId });

  await expect(polling).resolves.toEqual({ ok: false, error: 'cancelled' });
  expect(handoffs).toBe(0);
});

test('a cancellation racing a committed keyring handoff still reconciles and publishes the account', async () => {
  let handoffStartedResolve;
  let releaseHandoff;
  const handoffStarted = new Promise((resolve) => { handoffStartedResolve = resolve; });
  const handoffGate = new Promise((resolve) => { releaseHandoff = resolve; });
  const invalidate = vi.fn();
  const listAccounts = vi.fn(async () => [{ login: 'committed-user', isActive: true }]);
  const core = authCore({
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/login/device/code')) return json(deviceResponse());
      return json({ access_token: accessToken, token_type: 'bearer', scope: 'repo' });
    },
    writeTokenToGhImpl: async () => {
      handoffStartedResolve();
      await handoffGate;
      return { ok: true };
    },
    invalidateAccountStateImpl: invalidate,
    listAccountsImpl: listAccounts,
  });

  await core.loginStart({ requestId });
  const polling = core.loginPoll({ requestId });
  await handoffStarted;
  expect(core.loginCancel({ requestId })).toEqual({ ok: true });
  releaseHandoff();

  await expect(polling).resolves.toEqual({ ok: true, login: 'committed-user' });
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(listAccounts).toHaveBeenCalledTimes(1);
});

test('expires an abandoned device session without renderer cleanup', async () => {
  vi.useFakeTimers();
  const core = authCore({ fetchImpl: async () => json(deviceResponse(60)) });
  await core.loginStart({ requestId });

  await vi.advanceTimersByTimeAsync(60_001);
  expect(core.loginPoll({ requestId })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
});

test('terminates a stalled GitHub CLI token handoff within its deadline', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => {}, write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  let spawnOptions;

  await expect(writeTokenToGh(accessToken, {
    ghBinary: '/fake/gh',
    env: {
      PATH: '/safe/bin',
      GH_TOKEN: 'must-not-reach-gh',
      GITHUB_TOKEN: 'must-not-reach-gh',
      GH_ENTERPRISE_TOKEN: 'must-not-reach-gh',
      GITHUB_ENTERPRISE_TOKEN: 'must-not-reach-gh',
    },
    spawnImpl: (_binary, _args, options) => {
      spawnOptions = options;
      return child;
    },
    timeoutMs: 10,
  })).resolves.toEqual({ ok: false, error: 'GitHub CLI credential handoff timed out' });
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(child.stdin.write).toHaveBeenCalledWith(`${accessToken}\n`);
  expect(spawnOptions.env).toEqual({ PATH: '/safe/bin' });
});

test('a stale account refresh cannot retry and publish old state while an account switch is pending', async () => {
  let activeLogin = 'old-user';
  let oldHydrationCount = 0;
  let releaseFirstHydration;
  let releaseRetryHydration;
  let firstHydrationStartedResolve;
  let retryHydrationStartedResolve;
  let releaseSwitch;
  let switchStartedResolve;
  const firstHydration = new Promise((resolve) => { releaseFirstHydration = resolve; });
  const retryHydration = new Promise((resolve) => { releaseRetryHydration = resolve; });
  const firstHydrationStarted = new Promise((resolve) => { firstHydrationStartedResolve = resolve; });
  const retryHydrationStarted = new Promise((resolve) => { retryHydrationStartedResolve = resolve; });
  const switchGate = new Promise((resolve) => { releaseSwitch = resolve; });
  const switchStarted = new Promise((resolve) => { switchStartedResolve = resolve; });
  const status = () => [
    'github.com',
    `  ✓ Logged in to github.com account ${activeLogin} (keyring)`,
    '  - Active account: true',
  ].join('\n');
  const core = authCore({
    runGhImpl: async (args) => {
      if (args[0] === 'auth' && args[1] === 'switch') {
        switchStartedResolve();
        await switchGate;
        activeLogin = args[5];
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: status(), stderr: '', code: 0 };
    },
    getTokenImpl: async (login) => `token-for-${login}`,
    hydrateProfileImpl: async (login) => {
      if (login === 'old-user') {
        oldHydrationCount += 1;
        if (oldHydrationCount === 1) {
          firstHydrationStartedResolve();
          await firstHydration;
        } else if (oldHydrationCount === 2) {
          retryHydrationStartedResolve();
          await retryHydration;
        }
      }
      return null;
    },
  });

  const stale = core.listAccounts({ force: true });
  await firstHydrationStarted;
  const switching = core.switchAccount({ login: 'new-user' });
  await switchStarted;
  releaseFirstHydration();
  await retryHydrationStarted;
  releaseSwitch();
  const switched = await switching;
  releaseRetryHydration();

  expect(switched).toMatchObject([{ login: 'new-user', isActive: true }]);
  await expect(stale).resolves.toMatchObject([{ login: 'new-user', isActive: true }]);
  await expect(core.listAccounts()).resolves.toMatchObject([{ login: 'new-user', isActive: true }]);
});

test('a forced account refresh bypasses cached GitHub profile metadata', async () => {
  const login = 'profile-refresh-user';
  let profileVersion = 0;
  const core = authCore({
    runGhImpl: async () => ({
      stdout: [
        'github.com',
        `  ✓ Logged in to github.com account ${login} (keyring)`,
        '  - Active account: true',
      ].join('\n'),
      stderr: '',
      code: 0,
    }),
    getTokenImpl: async () => 'safe-test-token',
    ghFetchImpl: async () => {
      profileVersion += 1;
      return {
        ok: true,
        data: {
          name: `Profile ${profileVersion}`,
          html_url: `https://github.com/${login}`,
        },
      };
    },
  });

  await expect(core.listAccounts({ force: true })).resolves.toMatchObject([
    { login, name: 'Profile 1' },
  ]);
  await expect(core.listAccounts({ force: true })).resolves.toMatchObject([
    { login, name: 'Profile 2' },
  ]);
  expect(profileVersion).toBe(2);
});
