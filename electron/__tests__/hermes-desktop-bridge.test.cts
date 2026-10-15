import { expect, test, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const electronMock = {
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getFocusedWindow: vi.fn(() => undefined),
  },
  clipboard: {
    readImage: vi.fn(() => ({ isEmpty: () => true })),
    writeText: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => undefined),
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  apiPathWithQuery,
  hermesProfileRootUrl,
  loadHermesProfileRoot,
  normalizePreviewTargetForBridge,
  percentToZoomLevel,
  registerHermesDesktopBridge,
  remoteDisplayReasonForBridge,
  scanGitReposForBridge,
  sanitizeWorkspaceCwdForBridge,
  fetchJsonWithBootRetry,
  isBootRetryableError,
  BOOT_RETRY_MAX_ATTEMPTS,
  aliasApiPathProfile,
  tagSessionResponseProfile,
  zoomLevelToPercent,
} = require('../hermes-desktop-bridge.cts');

function desktopReleaseDirName() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
  return process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
}

function trustedBridgeHarness(fetchApi = vi.fn(async () => null), bridgeOptions = {}) {
  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-bridge-trust-'));
  const appPath = path.join(
    globalHome,
    'hermes-agent',
    'apps',
    'desktop',
    'release',
    desktopReleaseDirName(),
    'Hermes.app'
  );
  const resources = process.platform === 'darwin'
    ? path.join(appPath, 'Contents', 'Resources', 'app.asar')
    : path.join(appPath, 'resources', 'app.asar');
  const indexPath = path.join(resources, 'dist', 'index.html');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.mkdirSync(path.join(resources, 'electron'), { recursive: true });
  fs.writeFileSync(indexPath, '<div id="root"></div>');
  fs.writeFileSync(path.join(resources, 'electron', 'preload.cjs'), 'module.exports = {}');
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ version: '0.17.0' }));

  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    on: vi.fn((channel, handler) => listeners.set(channel, handler)),
  };
  const store = {
    hermesDesktopAppConnection: vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      token: 'test-token',
      wsUrl: 'ws://127.0.0.1:43210/api/ws',
    })),
    hermesDesktopGetActiveProfile: vi.fn(),
    hermesDesktopSetActiveProfile: vi.fn(),
    hermesDesktopEnsure: vi.fn(),
    hermesDesktopRestart: vi.fn(async () => ({ ok: true })),
  };
  const app = {
    getPath: vi.fn(() => os.homedir()),
    isPackaged: false,
  };
  const sender = {
    getURL: () => pathToFileURL(indexPath).toString(),
    getZoomLevel: vi.fn(() => 0),
    setZoomLevel: vi.fn(),
    send: vi.fn(),
  };
  const event = { sender, senderFrame: { url: pathToFileURL(indexPath).toString() } };

  registerHermesDesktopBridge({
    ipcMain,
    app,
    store,
    trustOptions: { globalHermesHome: () => globalHome },
    fetchApi,
    platform: 'darwin',
    ...bridgeOptions,
  });

  return { event, fetchApi, handlers, listeners, sender, store };
}

test('microphone bridge returns an existing grant without requesting it again', async () => {
  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('granted');
  electronMock.systemPreferences.askForMediaAccess.mockClear();
  const { event, handlers } = trustedBridgeHarness();

  await expect(handlers.get('hermes:requestMicrophoneAccess')(event)).resolves.toBe(true);
  expect(electronMock.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
});

test('microphone bridge does not re-prompt denied or restricted access', async () => {
  electronMock.systemPreferences.askForMediaAccess.mockClear();
  const { event, handlers } = trustedBridgeHarness();

  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('denied');
  await expect(handlers.get('hermes:requestMicrophoneAccess')(event)).resolves.toBe(false);
  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('restricted');
  await expect(handlers.get('hermes:requestMicrophoneAccess')(event)).resolves.toBe(false);
  expect(electronMock.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
});

test('microphone bridge coalesces concurrent first-time requests', async () => {
  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
  let resolveAccess = () => {};
  electronMock.systemPreferences.askForMediaAccess.mockImplementationOnce(
    () => new Promise((resolve) => { resolveAccess = resolve; })
  );
  const { event, handlers } = trustedBridgeHarness();
  const handler = handlers.get('hermes:requestMicrophoneAccess');

  const first = handler(event);
  const second = handler(event);
  expect(electronMock.systemPreferences.askForMediaAccess).toHaveBeenCalledTimes(1);
  resolveAccess(true);
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('granted');
});

test('microphone bridge bypasses macOS TCC APIs on other platforms', async () => {
  electronMock.systemPreferences.getMediaAccessStatus.mockImplementationOnce(() => {
    throw new Error('macOS TCC must not be queried');
  });
  electronMock.systemPreferences.askForMediaAccess.mockClear();
  const { event, handlers } = trustedBridgeHarness(undefined, { platform: 'linux' });

  await expect(handlers.get('hermes:requestMicrophoneAccess')(event)).resolves.toBe(true);
  expect(electronMock.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
  electronMock.systemPreferences.getMediaAccessStatus.mockReturnValue('granted');
});

test('connection revalidation probes the cached sidecar without rebuilding a healthy connection', async () => {
  const probeApi = vi.fn(async () => ({ ok: true }));
  const { event, handlers, store } = trustedBridgeHarness(undefined, { probeApi });

  await expect(handlers.get('hermes:connection:revalidate')(event)).resolves.toEqual({
    ok: true,
    rebuilt: false,
  });
  expect(probeApi).toHaveBeenCalledWith(
    'http://127.0.0.1:43210/api/status',
    'test-token',
    { timeoutMs: 2_500 }
  );
  expect(store.hermesDesktopRestart).not.toHaveBeenCalled();
});

test('connection revalidation restarts an unreachable embedded sidecar', async () => {
  const probeApi = vi.fn(async () => { throw new Error('connection refused'); });
  const { event, handlers, store } = trustedBridgeHarness(undefined, { probeApi });

  await expect(handlers.get('hermes:connection:revalidate')(event)).resolves.toEqual({
    ok: true,
    rebuilt: true,
  });
  expect(store.hermesDesktopRestart).toHaveBeenCalledWith({});
});

test('connection revalidation surfaces a failed sidecar restart', async () => {
  const probeApi = vi.fn(async () => { throw new Error('connection refused'); });
  const { event, handlers, store } = trustedBridgeHarness(undefined, { probeApi });
  store.hermesDesktopRestart.mockResolvedValueOnce({ ok: false, error: 'spawn failed' });

  await expect(handlers.get('hermes:connection:revalidate')(event)).rejects.toThrow(/spawn failed/);
});

// ── operator→backend profile alias (ft-08d2a768) ────────────────────────────
// An identity-home sidecar serves only 'default'; the SPA still asks for
// ?profile=alpha. aliasApiPathProfile rewrites the operator id to the backend's
// real profile so the call resolves instead of 404 "Profile 'alpha' does not exist".
test('aliasApiPathProfile rewrites the operator id to the backend profile', () => {
  expect(
    aliasApiPathProfile('/api/profiles/sessions?limit=50&profile=alpha&order=recent', 'default')
  ).toBe('/api/profiles/sessions?limit=50&profile=default&order=recent');
});

test('aliasApiPathProfile rewrites the sidebar recents operator to the backend profile', () => {
  expect(
    aliasApiPathProfile(
      '/api/profiles/sessions/sidebar?recents_profile=alpha&recents_limit=50&cron_limit=50',
      'default'
    )
  ).toBe(
    '/api/profiles/sessions/sidebar?recents_profile=default&recents_limit=50&cron_limit=50'
  );
});

test('tagSessionResponseProfile retags Hermes 0.19 nested sidebar session groups', () => {
  const backendResponse = {
    recents: {
      sessions: [{ id: 'recent-1', profile: 'default' }],
      total: 140,
      profile_totals: { default: 140 },
    },
    messaging: {
      sessions: [{ id: 'message-1', profile: 'default' }],
      total: 100,
    },
    cron: {
      sessions: [],
    },
    errors: [],
  };

  expect(
    tagSessionResponseProfile(
      '/api/profiles/sessions/sidebar?recents_profile=alpha&recents_limit=40',
      backendResponse,
      'alpha'
    )
  ).toEqual({
    recents: {
      sessions: [{ id: 'recent-1', profile: 'alpha' }],
      total: 140,
      profile_totals: { default: 140, alpha: 140 },
    },
    messaging: {
      sessions: [{ id: 'message-1', profile: 'alpha' }],
      total: 100,
      profile_totals: { alpha: 100 },
    },
    cron: {
      sessions: [],
    },
    errors: [],
  });
  expect(backendResponse.recents.sessions[0].profile).toBe('default');
});

test('aliasApiPathProfile leaves the cross-profile aggregate (all) untouched', () => {
  expect(aliasApiPathProfile('/api/profiles/sessions?profile=all', 'default')).toBe(
    '/api/profiles/sessions?profile=all'
  );
});

test('aliasApiPathProfile leaves the reserved /api/profiles/active segment untouched', () => {
  // 'active' is a sub-route, not a profile name: /api/profiles/active returns the
  // current profile, while /api/profiles/default 404s "No such API endpoint".
  expect(aliasApiPathProfile('/api/profiles/active', 'default')).toBe('/api/profiles/active');
});

test('aliasApiPathProfile is a no-op without a backend profile, profile param, or when already matching', () => {
  expect(aliasApiPathProfile('/api/profiles/sessions?profile=alpha', '')).toBe(
    '/api/profiles/sessions?profile=alpha'
  );
  expect(aliasApiPathProfile('/api/status', 'default')).toBe('/api/status');
  expect(aliasApiPathProfile('/api/profiles/sessions?profile=default', 'default')).toBe(
    '/api/profiles/sessions?profile=default'
  );
});

test('aliasApiPathProfile preserves a real named profile (backendProfile === requested)', () => {
  expect(aliasApiPathProfile('/api/profiles/sessions?profile=alpha', 'alpha')).toBe(
    '/api/profiles/sessions?profile=alpha'
  );
});

test('aliasApiPathProfile rewrites PATH-style profile segments (soul / setup-command / detail)', () => {
  // The SPA's getProfileSoul/updateProfileSoul/getProfileSetupCommand build
  // pure path-style URLs with no query string — these must alias too.
  expect(aliasApiPathProfile('/api/profiles/alpha/soul', 'default')).toBe('/api/profiles/default/soul');
  expect(aliasApiPathProfile('/api/profiles/alpha/setup-command', 'default')).toBe(
    '/api/profiles/default/setup-command'
  );
  expect(aliasApiPathProfile('/api/profiles/alpha', 'default')).toBe('/api/profiles/default');
});

test('aliasApiPathProfile never rewrites the cross-profile sessions endpoint segment, only its query', () => {
  // 'sessions' is an endpoint, not a profile name — segment stays; query aliases.
  expect(aliasApiPathProfile('/api/profiles/sessions?profile=alpha', 'default')).toBe(
    '/api/profiles/sessions?profile=default'
  );
  expect(aliasApiPathProfile('/api/profiles/sessions', 'default')).toBe('/api/profiles/sessions');
  // the bare list endpoint (no trailing segment) is untouched.
  expect(aliasApiPathProfile('/api/profiles', 'default')).toBe('/api/profiles');
});

// ── boot-readiness retry (ft-08d2a768) ──────────────────────────────────────
// A freshly (re)spawned sidecar answers /api/status before every @app.get route
// is registered; the SPA's boot GET /api/profiles/sessions then races the mount
// and gets a transient 404, latching the un-retried "Hermes couldn't start"
// overlay. The bridge swallows the transient boot status by retrying GETs.

const instantSleep = () => Promise.resolve();

function scriptedFetchJson(outcomes) {
  // outcomes: array of either {status} (reject with that HTTP code) or {body}
  // (resolve). Each call shifts the next outcome; the last one repeats.
  let i = 0;
  const calls = { count: 0 };
  const fn = async () => {
    calls.count += 1;
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome.status != null) {
      const err = new Error(`${outcome.status}: boom`);
      err.statusCode = outcome.status;
      throw err;
    }
    return outcome.body;
  };
  return { fn, calls };
}

test('isBootRetryableError: transient HTTP statuses + transport errors retry; hard statuses do not', () => {
  expect(isBootRetryableError({ statusCode: 404 })).toBe(true);
  expect(isBootRetryableError({ statusCode: 502 })).toBe(true);
  expect(isBootRetryableError({ statusCode: 503 })).toBe(true);
  expect(isBootRetryableError({ statusCode: 400 })).toBe(false);
  expect(isBootRetryableError({ statusCode: 401 })).toBe(false);
  expect(isBootRetryableError({ statusCode: 403 })).toBe(false);
  expect(isBootRetryableError({ statusCode: 500 })).toBe(false);
  // No statusCode => a transport-level failure (sidecar warming) => retry.
  expect(isBootRetryableError(new Error('ECONNREFUSED'))).toBe(true);
});

test('fetchJsonWithBootRetry: a GET that 404s twice then 200s resolves with the body', async () => {
  const { fn, calls } = scriptedFetchJson([{ status: 404 }, { status: 404 }, { body: { ok: true } }]);
  const result = await fetchJsonWithBootRetry('http://x/api/profiles/sessions', 'tok', {}, {
    fetchJson: fn,
    sleep: instantSleep,
  });
  expect(result).toEqual({ ok: true });
  expect(calls.count).toBe(3);
});

test('fetchJsonWithBootRetry: a persistent 404 GET exhausts the cap then throws', async () => {
  const { fn, calls } = scriptedFetchJson([{ status: 404 }]);
  await expect(
    fetchJsonWithBootRetry('http://x/api/profiles/sessions', 'tok', {}, { fetchJson: fn, sleep: instantSleep })
  ).rejects.toThrow(/404/);
  expect(calls.count).toBe(BOOT_RETRY_MAX_ATTEMPTS);
});

test('fetchJsonWithBootRetry: a real 401 GET surfaces immediately (no retry)', async () => {
  const { fn, calls } = scriptedFetchJson([{ status: 401 }, { body: { ok: true } }]);
  await expect(
    fetchJsonWithBootRetry('http://x/api/profiles/sessions', 'tok', {}, { fetchJson: fn, sleep: instantSleep })
  ).rejects.toThrow(/401/);
  expect(calls.count).toBe(1);
});

test('fetchJsonWithBootRetry: a non-GET (mutation) is never retried even on a transient 404', async () => {
  const { fn, calls } = scriptedFetchJson([{ status: 404 }, { body: { ok: true } }]);
  await expect(
    fetchJsonWithBootRetry('http://x/api/sessions', 'tok', { method: 'POST', body: {} }, {
      fetchJson: fn,
      sleep: instantSleep,
    })
  ).rejects.toThrow(/404/);
  expect(calls.count).toBe(1);
});

test('hermes profile route reset preserves the trusted app file and drops stale session hashes', () => {
  const next = hermesProfileRootUrl(
    'file:///Applications/Ace.app/Contents/Resources/app.asar/dist/index.html#/42249b39',
    'alpha',
    123
  );

  expect(next).toBe(
    'file:///Applications/Ace.app/Contents/Resources/app.asar/dist/index.html?aceProfile=alpha&ace-coderProfile=alpha&aceProfileReload=123&ace-coderProfileReload=123#/'
  );
});

test('hermes profile route reset replaces old profile query state', () => {
  const next = hermesProfileRootUrl(
    'file:///tmp/Hermes.app/Contents/Resources/app.asar/dist/index.html?aceProfile=beta&x=1#/bad-session',
    'alpha',
    456
  );

  expect(next).toBe(
    'file:///tmp/Hermes.app/Contents/Resources/app.asar/dist/index.html?aceProfile=alpha&x=1&ace-coderProfile=alpha&aceProfileReload=456&ace-coderProfileReload=456#/'
  );
});

test('loadHermesProfileRoot navigates the webview to the clean profile root', () => {
  const loadURL = vi.fn(() => Promise.resolve());
  const reloadIgnoringCache = vi.fn();
  const sender = {
    getURL: () => 'file:///tmp/Hermes.app/Contents/Resources/app.asar/dist/index.html#/42249b39',
    loadURL,
    reloadIgnoringCache,
  };

  loadHermesProfileRoot(sender, 'beta');

  expect(loadURL).toHaveBeenCalledTimes(1);
  expect(loadURL.mock.calls[0][0]).toMatch(
    /^file:\/\/\/tmp\/Hermes\.app\/Contents\/Resources\/app\.asar\/dist\/index\.html\?aceProfile=beta&ace-coderProfile=beta&aceProfileReload=\d+&ace-coderProfileReload=\d+#\/$/
  );
  expect(reloadIgnoringCache).not.toHaveBeenCalled();
});

test('loadHermesProfileRoot falls back to reload when URL rewriting is impossible', () => {
  const reloadIgnoringCache = vi.fn();
  const sender = {
    getURL: () => '',
    reloadIgnoringCache,
  };

  loadHermesProfileRoot(sender, 'alpha');

  expect(reloadIgnoringCache).toHaveBeenCalledTimes(1);
});

test('registerHermesDesktopBridge mirrors the Hermes workspace sanitize IPC channel', () => {
  const handlers = new Map();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    on: vi.fn(),
  };
  const app = {
    getPath: vi.fn(() => os.homedir()),
    isPackaged: false,
  };
  const store = {
    hermesDesktopAppConnection: vi.fn(),
    hermesDesktopGetActiveProfile: vi.fn(),
    hermesDesktopSetActiveProfile: vi.fn(),
    hermesDesktopEnsure: vi.fn(),
  };

  registerHermesDesktopBridge({ ipcMain, app, store });

  expect(handlers.has('hermes:workspace:sanitize')).toBe(true);
});

test('embedded bridge registers the boot-critical and full git/fs compatibility channels', () => {
  const { handlers, listeners } = trustedBridgeHarness();
  const expected = [
    'hermes:connection:revalidate',
    'hermes:get-remote-display-reason',
    'hermes:window:openSession',
    'hermes:window:openNewSession',
    'hermes:pet-overlay:open',
    'hermes:pet-overlay:close',
    'hermes:zoom:get',
    'hermes:fs:reveal',
    'hermes:fs:rename',
    'hermes:fs:writeText',
    'hermes:fs:trash',
    'hermes:git:repoStatus',
    'hermes:git:worktreeList',
    'hermes:git:worktreeAdd',
    'hermes:git:worktreeRemove',
    'hermes:git:branchSwitch',
    'hermes:git:branchList',
    'hermes:git:fileDiff',
    'hermes:git:review:list',
    'hermes:git:review:diff',
    'hermes:git:review:stage',
    'hermes:git:review:unstage',
    'hermes:git:review:revert',
    'hermes:git:review:revParse',
    'hermes:git:review:commit',
    'hermes:git:review:commitContext',
    'hermes:git:review:push',
    'hermes:git:review:shipInfo',
    'hermes:git:review:createPr',
    'hermes:git:scanRepos',
    'hermes:vscode-theme:search',
    'hermes:vscode-theme:fetch',
  ];

  expect(expected.filter((channel) => !handlers.has(channel))).toEqual([]);
  expect(listeners.has('hermes:zoom:set-percent')).toBe(true);
});

test('embedded repo discovery finds bounded real repos and skips hidden and linked worktrees', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-repo-scan-'));
  const repo = path.join(root, 'code', 'skysphere', 'ace');
  const linkedWorktree = path.join(root, 'code', 'ace-worktree');
  const hiddenRepo = path.join(root, '.cache', 'hidden');
  const tooDeepRepo = path.join(root, 'one', 'two', 'three', 'four');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(linkedWorktree, { recursive: true });
  fs.writeFileSync(path.join(linkedWorktree, '.git'), 'gitdir: ../ace/.git/worktrees/demo\n');
  fs.mkdirSync(path.join(hiddenRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tooDeepRepo, '.git'), { recursive: true });

  await expect(scanGitReposForBridge([root], { maxDepth: 3 })).resolves.toEqual([
    { label: 'ace', root: repo },
  ]);
});

test('embedded repo discovery uses one global filesystem concurrency budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-repo-concurrency-'));
  for (let outer = 0; outer < 8; outer += 1) {
    for (let inner = 0; inner < 8; inner += 1) {
      fs.mkdirSync(path.join(root, `group-${outer}`, `project-${inner}`), { recursive: true });
    }
  }
  let active = 0;
  let maxActive = 0;
  const fsImpl = {
    promises: {
      readdir: async (...args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await fs.promises.readdir(...args);
        } finally {
          active -= 1;
        }
      },
    },
  };

  await scanGitReposForBridge([root], { maxDepth: 2 }, { fsImpl, maxConcurrency: 4 });

  expect(maxActive).toBeGreaterThan(0);
  expect(maxActive).toBeLessThanOrEqual(4);
});

test('embedded repo discovery IPC returns actual filesystem scan results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-repo-handler-'));
  const repo = path.join(root, 'project');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const { event, handlers } = trustedBridgeHarness();

  await expect(handlers.get('hermes:git:scanRepos')(event, [root], { maxDepth: 2 })).resolves.toEqual([
    { label: 'project', root: repo },
  ]);
});

test('embedded Marketplace theme handlers report unsupported instead of fake empty success', async () => {
  const { event, handlers } = trustedBridgeHarness();

  await expect(handlers.get('hermes:vscode-theme:search')(event, 'dark')).rejects.toThrow(
    /standalone Hermes app/i
  );
  await expect(handlers.get('hermes:vscode-theme:fetch')(event, 'publisher.theme')).rejects.toThrow(
    /standalone Hermes app/i
  );
});

test('repo status IPC proxies to the authenticated Hermes git API', async () => {
  const fetchApi = vi.fn(async () => ({ branch: 'main', changed: 2 }));
  const { event, handlers } = trustedBridgeHarness(fetchApi);

  const result = await handlers.get('hermes:git:repoStatus')(event, '/tmp/demo repo');

  expect(result).toEqual({ branch: 'main', changed: 2 });
  expect(fetchApi).toHaveBeenCalledWith(
    'http://127.0.0.1:43210/api/git/status?path=%2Ftmp%2Fdemo+repo',
    'test-token',
    {}
  );
});

test('git mutations preserve their arguments when proxying to Hermes', async () => {
  const fetchApi = vi.fn(async () => ({ ok: true }));
  const { event, handlers } = trustedBridgeHarness(fetchApi);

  await handlers.get('hermes:git:review:commit')(event, '/tmp/repo', 'Fix queue', true);

  expect(fetchApi).toHaveBeenCalledWith(
    'http://127.0.0.1:43210/api/git/review/commit',
    'test-token',
    { method: 'POST', body: { path: '/tmp/repo', message: 'Fix queue', push: true } }
  );
});

test('bridge URL, zoom, and remote-display helpers match the desktop contracts', () => {
  expect(apiPathWithQuery('/api/git/status', { path: '/tmp/a b', empty: '' })).toBe(
    '/api/git/status?path=%2Ftmp%2Fa+b'
  );
  expect(zoomLevelToPercent(0)).toBe(100);
  expect(zoomLevelToPercent(percentToZoomLevel(125))).toBe(125);
  expect(remoteDisplayReasonForBridge({}, 'darwin')).toBeNull();
  expect(remoteDisplayReasonForBridge({ SSH_TTY: '/dev/ttys001' }, 'darwin')).toBe('ssh-session');
  expect(remoteDisplayReasonForBridge({ HERMES_DESKTOP_DISABLE_GPU: '1' }, 'darwin')).toMatch(/override/);
});

test('sanitizeWorkspaceCwdForBridge preserves existing directories and falls back safely', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-cwd-'));
  const app = {
    getPath: vi.fn(() => os.homedir()),
    getAppPath: vi.fn(() => '/Applications/Ace.app/Contents/Resources/app.asar'),
    isPackaged: true,
  };

  expect(sanitizeWorkspaceCwdForBridge(tmp, app)).toEqual({ cwd: tmp, sanitized: false });
  expect(sanitizeWorkspaceCwdForBridge('/Applications/Ace.app/Contents/Resources/app.asar', app)).toEqual({
    cwd: os.homedir(),
    sanitized: true,
  });
  expect(sanitizeWorkspaceCwdForBridge(path.join(tmp, 'missing'), app)).toEqual({
    cwd: os.homedir(),
    sanitized: true,
  });
});

test('normalizePreviewTargetForBridge resolves local HTML into Hermes live preview metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-preview-'));
  const html = path.join(root, 'index.html');
  fs.writeFileSync(html, '<!doctype html><title>Ace preview</title>');

  const target = await normalizePreviewTargetForBridge('./index.html', root, {
    getPath: vi.fn(() => os.homedir()),
    isPackaged: false,
  });

  expect(target).toMatchObject({
    kind: 'file',
    label: 'index.html',
    path: html,
    previewKind: 'html',
    source: './index.html',
  });
  expect(target.url).toBe(`file://${html}`);
});
