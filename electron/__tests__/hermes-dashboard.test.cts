import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Injected fakes only — no real spawn, no real port binding. The manager's
// per-home claim ledger and the surface-config contract are the units under
// test (see electron/hermes-dashboard.cts).
const hermesDashboard = require('../hermes-dashboard.cts');
const hermesPaths = require('../hermes-paths.cts');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-surface-'));
}

// Build the fixture where the resolver actually looks, instead of
// re-implementing the layout here — a second copy is how this drifted from
// electron-builder's real output in the first place (see hermes-paths.cts).
// hermes-paths.test.cts owns the per-platform layout assertions.
function makeFakeHermesDesktopAppPath(globalHome) {
  return hermesPaths.hermesDesktopSourceRoots({ home: globalHome })[0];
}

function populateFakeHermesDesktopApp(appPath, version = '0.15.1') {
  const resources = process.platform === 'darwin'
    ? path.join(appPath, 'Contents', 'Resources', 'app.asar')
    : path.join(appPath, 'resources', 'app.asar');
  fs.mkdirSync(path.join(resources, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'dist', 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(resources, 'electron', 'preload.cjs'), 'module.exports = {}');
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ version }));
  return appPath;
}

function makeFakeHermesDesktopApp(globalHome) {
  return populateFakeHermesDesktopApp(makeFakeHermesDesktopAppPath(globalHome));
}

// Inferred-type helpers: keep the file type-clean without TS syntax
// (vitest parses entry .cts test files as plain JS, operators.test.cts
// precedent). Seeded defaults give every array/object a concrete shape.
const defaultSpawnOpts = () => ({
  env: {
    HERMES_HOME: '',
    HERMES_DASHBOARD_SESSION_TOKEN: '',
    HERMES_DESKTOP: '',
    HERMES_WEB_DIST: '',
  },
});
const noopOnExit = (code = 0) => Boolean(code);

// Fake child process: records spawn args/env, lets tests drive exits.
function makeFakeProc(bin = '', args = [''], opts = defaultSpawnOpts()) {
  const exitListeners = [noopOnExit].slice(0, 0);
  const errorListeners = [noopOnExit].slice(0, 0);
  const proc = {
    bin,
    args,
    opts,
    pid: 4242,
    killedWith: '',
    stdout: { on() {} },
    stderr: { on() {} },
    on(event = '', cb = noopOnExit) {
      if (event === 'exit') exitListeners.push(cb);
      if (event === 'error') errorListeners.push(cb);
    },
    kill(signal = 'SIGTERM') {
      proc.killedWith = signal;
    },
    emitExit(code = 1) {
      for (const cb of exitListeners) cb(code);
    },
  };
  return proc;
}

function procArray() {
  return [makeFakeProc()].slice(0, 0);
}

function fakeSpawnImpl(spawned = procArray()) {
  return (bin = '', args = [''], opts = defaultSpawnOpts()) => {
    const proc = makeFakeProc(bin, args, opts);
    spawned.push(proc);
    return proc;
  };
}

function makeManager(overrides = {}) {
  // Harness-only knobs (not factory params): reuse an existing userData /
  // global home so a test can model "same install, updated Hermes.app".
  const { userDataPathOverride, globalHomeOverride, ...factoryOverrides } = {
    userDataPathOverride: '',
    globalHomeOverride: '',
    ...overrides,
  };
  const userDataPath = userDataPathOverride || tmpUserData();
  const homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-homes-'));
  const globalHome = globalHomeOverride || fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-global-'));
  const desktopAppPath = globalHomeOverride
    ? makeFakeHermesDesktopAppPath(globalHome)
    : makeFakeHermesDesktopApp(globalHome);
  const spawned = procArray();
  const events = [{}].slice(0, 0);
  let nextPort = 43210;
  const manager = hermesDashboard.createHermesDashboardManager({
    userDataPath,
    ensureHermesHome: (ownerKey = '') => {
      const home = path.join(homesRoot, `hermes-home-${ownerKey}`);
      fs.mkdirSync(home, { recursive: true });
      return home;
    },
    whichHermes: () => '/fake/bin/hermes',
    emit: (payload = {}) => events.push(payload),
    spawnImpl: fakeSpawnImpl(spawned),
    allocatePort: async () => nextPort++,
    waitForReady: async () => {},
    globalHermesHome: () => globalHome,
    processIdentity: (pid = 0) => `test-process-${pid}`,
    ...factoryOverrides,
  });
  return { manager, userDataPath, homesRoot, globalHome, desktopAppPath, spawned, events };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── surface config ─────────────────────────────────────────────────────────

test('absent surface file loads lanes defaults and never creates the file', () => {
  const userData = tmpUserData();
  const config = hermesDashboard.loadSurfaceConfig(userData);
  expect(config).toEqual({
    version: 1,
    defaultSurface: 'lanes',
    workspaceOverrides: {},
    dashboard: { host: '127.0.0.1', extraArgs: [], desktopAppPath: null },
  });
  expect(fs.existsSync(path.join(userData, 'hermes-surface.json'))).toBe(false);
});

test('save is atomic: tmp+rename, parseable current backed up to .bak, corrupt main falls back to .bak', () => {
  const userData = tmpUserData();
  const filePath = path.join(userData, 'hermes-surface.json');
  const bakPath = path.join(userData, 'hermes-surface.json.bak');

  const first = hermesDashboard.defaultSurfaceConfig();
  hermesDashboard.saveSurfaceConfig(userData, first);
  expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).defaultSurface).toBe('lanes');
  expect(fs.existsSync(bakPath)).toBe(false);

  const second = { ...first, defaultSurface: 'dashboard' };
  hermesDashboard.saveSurfaceConfig(userData, second);
  expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).defaultSurface).toBe('dashboard');
  // The previous (parseable) file became the backup.
  expect(JSON.parse(fs.readFileSync(bakPath, 'utf8')).defaultSurface).toBe('lanes');

  // Corrupt main file: load falls back to the .bak contents.
  fs.writeFileSync(filePath, '{not json');
  expect(hermesDashboard.loadSurfaceConfig(userData).defaultSurface).toBe('lanes');

  // Saving over a corrupt main never clobbers the good .bak.
  hermesDashboard.saveSurfaceConfig(userData, second);
  expect(JSON.parse(fs.readFileSync(bakPath, 'utf8')).defaultSurface).toBe('lanes');
  // No stray .tmp files left behind.
  expect(fs.readdirSync(userData).filter((f) => f.includes('.tmp'))).toEqual([]);
});

test('saveSurfaceConfig refuses invalid configs (bad surface, off-loopback host, bad extraArgs)', () => {
  const userData = tmpUserData();
  const base = hermesDashboard.defaultSurfaceConfig();
  expect(() =>
    hermesDashboard.saveSurfaceConfig(userData, { ...base, defaultSurface: 'tui' })
  ).toThrow(/defaultSurface/);
  expect(() =>
    hermesDashboard.saveSurfaceConfig(userData, {
      ...base,
      dashboard: { ...base.dashboard, host: '0.0.0.0' },
    })
  ).toThrow(/loopback/);
  expect(() =>
    hermesDashboard.saveSurfaceConfig(userData, {
      ...base,
      dashboard: { ...base.dashboard, extraArgs: [42] },
    })
  ).toThrow(/extraArgs/);
  expect(() =>
    hermesDashboard.saveSurfaceConfig(userData, {
      ...base,
      dashboard: { ...base.dashboard, extraArgs: ['--host', '0.0.0.0'] },
    })
  ).toThrow(/unsafe flag/);
  expect(() =>
    hermesDashboard.saveSurfaceConfig(userData, {
      ...base,
      dashboard: { ...base.dashboard, extraArgs: ['--profile=alpha'] },
    })
  ).toThrow(/unsafe flag/);
  expect(fs.existsSync(path.join(userData, 'hermes-surface.json'))).toBe(false);
});

test('dashboard extraArgs cannot override Ace-managed bind flags', async () => {
  const ctx = makeManager();
  const config = hermesDashboard.defaultSurfaceConfig();
  hermesDashboard.saveSurfaceConfig(ctx.userDataPath, {
    ...config,
    dashboard: { ...config.dashboard, extraArgs: ['--verbose'] },
  });
  const result = await ctx.manager.ensure({ ownerKey: 'prj-1' });
  expect(result.ok).toBe(true);
  const args = ctx.spawned[0].args;
  const verboseIndex = args.indexOf('--verbose');
  expect(verboseIndex).toBeGreaterThan(-1);
  expect(args.slice(verboseIndex, verboseIndex + 5)).toEqual(['--verbose', '--no-open', '--host', '127.0.0.1', '--port']);
  expect(args.at(-1)).toBe(String(result.port));
});

test('trusted Hermes Desktop resources must match the resolved app exactly', () => {
  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-trusted-'));
  makeFakeHermesDesktopApp(globalHome);
  const desktop = hermesDashboard.resolveHermesDesktopApp(null, fs, () => globalHome);
  expect(desktop).toBeTruthy();

  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-other-'));
  makeFakeHermesDesktopApp(otherHome);
  const otherDesktop = hermesDashboard.resolveHermesDesktopApp(null, fs, () => otherHome);
  expect(otherDesktop).toBeTruthy();

  const trustOptions = { globalHermesHome: () => globalHome };
  expect(hermesDashboard.isTrustedHermesDesktopResource(desktop.indexPath, 'index', trustOptions)).toBe(true);
  expect(hermesDashboard.isTrustedHermesDesktopResource(desktop.preloadPath, 'preload', trustOptions)).toBe(true);
  expect(hermesDashboard.isTrustedHermesDesktopResource(otherDesktop.indexPath, 'index', trustOptions)).toBe(false);
  expect(hermesDashboard.isTrustedHermesDesktopResource(otherDesktop.preloadPath, 'preload', trustOptions)).toBe(false);
  expect(
    hermesDashboard.isTrustedHermesDesktopWebview(
      { src: desktop.rendererUrl },
      { preload: desktop.preloadPath },
      trustOptions
    )
  ).toBe(true);
});

test('a live source-built Hermes release supersedes a stale Ace-managed embed snapshot', () => {
  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-current-'));
  const sourceBuilt = makeFakeHermesDesktopApp(globalHome);
  const staleEmbed = populateFakeHermesDesktopApp(
    path.join(globalHome, 'hermes-embed', 'oldsha123', 'Hermes.app'),
    '0.14.0'
  );
  const config = {
    ...hermesDashboard.defaultSurfaceConfig(),
    dashboard: {
      ...hermesDashboard.defaultSurfaceConfig().dashboard,
      desktopAppPath: staleEmbed,
    },
  };

  const resolved = hermesDashboard.resolveHermesDesktopApp(config, fs, () => globalHome);

  expect(resolved.appPath).toBe(sourceBuilt);
  expect(resolved.version).toBe('0.15.1');
});

test('managed embed detection follows the ~/.hermes symlink to the external home', () => {
  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-physical-home-'));
  const sourceBuilt = makeFakeHermesDesktopApp(globalHome);
  populateFakeHermesDesktopApp(
    path.join(globalHome, 'hermes-embed', 'oldsha123', 'Hermes.app'),
    '0.14.0'
  );
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-home-alias-'));
  const aliasHome = path.join(aliasParent, '.hermes');
  fs.symlinkSync(globalHome, aliasHome, 'dir');
  const config = {
    ...hermesDashboard.defaultSurfaceConfig(),
    dashboard: {
      ...hermesDashboard.defaultSurfaceConfig().dashboard,
      desktopAppPath: path.join(aliasHome, 'hermes-embed', 'oldsha123', 'Hermes.app'),
    },
  };

  const resolved = hermesDashboard.resolveHermesDesktopApp(config, fs, () => globalHome);

  expect(resolved.appPath).toBe(sourceBuilt);
  expect(resolved.version).toBe('0.15.1');
});

test('an explicit custom Hermes app path still overrides the live source-built release', () => {
  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-custom-home-'));
  makeFakeHermesDesktopApp(globalHome);
  const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-custom-app-'));
  const customApp = populateFakeHermesDesktopApp(path.join(customRoot, 'Hermes.app'), '9.9.9');
  const config = {
    ...hermesDashboard.defaultSurfaceConfig(),
    dashboard: {
      ...hermesDashboard.defaultSurfaceConfig().dashboard,
      desktopAppPath: customApp,
    },
  };

  const resolved = hermesDashboard.resolveHermesDesktopApp(config, fs, () => globalHome);

  expect(resolved.appPath).toBe(customApp);
  expect(resolved.version).toBe('9.9.9');
});

test('Hermes web links route to the host renderer without allowing unsafe schemes', () => {
  const send = vi.fn();
  const host = { send };

  expect(hermesDashboard.sendHermesDesktopOpenLink(host, 'https://example.com/docs')).toBe(true);
  expect(send).toHaveBeenCalledWith('ace:hermes-desktop-event', {
    type: 'open-link',
    url: 'https://example.com/docs',
  });
  expect(hermesDashboard.sendHermesDesktopOpenLink(host, 'javascript:alert(1)')).toBe(false);
  expect(hermesDashboard.sendHermesDesktopOpenLink(host, 'file:///tmp/demo.html')).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});

// ── claim ledger + spawn lifecycle ─────────────────────────────────────────

test('ensure registers the per-home claim BEFORE spawn and spawns with home-scoped env', async () => {
  const claimedAtSpawn = [true].slice(0, 0);
  const spawned = procArray();
  const ctx = makeManager({
    spawnImpl: (bin = '', args = [''], opts = defaultSpawnOpts()) => {
      // The ledger must already own this home when the process starts.
      claimedAtSpawn.push(ctx.manager.isHomeClaimed(opts.env.HERMES_HOME));
      return fakeSpawnImpl(spawned)(bin, args, opts);
    },
  });
  const result = await ctx.manager.ensure({ ownerKey: 'prj-1' });
  expect(result.ok).toBe(true);
  expect(claimedAtSpawn).toEqual([true]);
  expect(spawned).toHaveLength(1);
  expect(spawned[0].bin).toBe('/fake/bin/hermes');
  expect(spawned[0].args.slice(0, 4)).toEqual(['dashboard', '--no-open', '--host', '127.0.0.1']);
  expect(spawned[0].args[5]).toBe(String(result.port));
  expect(spawned[0].opts.env.HERMES_HOME).toBe(result.home);
  expect(spawned[0].opts.env.HERMES_DASHBOARD_SESSION_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(result.url).toBe(`http://127.0.0.1:${result.port}/`);
});

test('sidecar startup retries process identity capture while the spawned PID is alive', async () => {
  let childIdentityAttempts = 0;
  const { manager, spawned } = makeManager({
    parentPid: 1111,
    processAlive: (pid = 0) => pid === 1111 || pid === 4242,
    processIdentity: (pid = 0) => {
      if (pid === 1111) return 'ace-owner';
      if (pid !== 4242) return null;
      childIdentityAttempts += 1;
      return childIdentityAttempts >= 3 ? 'hermes-child-generation' : null;
    },
  });

  const result = await manager.ensure({ ownerKey: 'identity-retry' });

  expect(result.ok).toBe(true);
  expect(spawned).toHaveLength(1);
  expect(childIdentityAttempts).toBe(3);
});

test('ensure is idempotent per home: one dashboard, second call reuses it', async () => {
  const { manager, spawned } = makeManager();
  const first = await manager.ensure({ ownerKey: 'prj-1' });
  const again = await manager.ensure({ ownerKey: 'prj-1' });
  expect(spawned).toHaveLength(1);
  expect(again.url).toBe(first.url);
  // A different home spawns its own dashboard.
  await manager.ensure({ ownerKey: 'prj-2' });
  expect(spawned).toHaveLength(2);
});

test('ensure waits for the dashboard HTTP server before returning the embed URL', async () => {
  const readinessChecks = [''].slice(0, 0);
  const { manager } = makeManager({
    waitForReady: async (url = '') => {
      readinessChecks.push(url);
    },
  });
  const result = await manager.ensure();
  expect(result.ok).toBe(true);
  // Readiness probes the unauthenticated liveness endpoint, never the
  // credential-bearing root URL.
  expect(readinessChecks).toEqual([`${result.baseUrl}/api/status`]);
});

test('ensure without an owner starts the global Hermes app sidecar with the global HERMES_HOME', async () => {
  const globalHome = path.join(tmpUserData(), 'global-hermes');
  const desktopAppPath = makeFakeHermesDesktopApp(globalHome);
  const { manager, spawned } = makeManager({ globalHermesHome: () => globalHome });
  const result = await manager.ensure();
  expect(result.ok).toBe(true);
  expect(result.ownerKey).toBe(hermesDashboard.HERMES_DESKTOP_APP_OWNER_KEY);
  expect(result.home).toBe(null);
  expect(result.remotePath).toBe(hermesDashboard.HERMES_DESKTOP_REMOTE_PATH);
  // Derive from the RESOLVED app root, never a hardcoded bundle name: only
  // macOS wraps the build in `Hermes.app` — on Windows/Linux the unpacked
  // release dir is itself the root, so a literal `/Hermes.app/` here would
  // fail on those runners even though the resolver is correct.
  const resourcesSegment = process.platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const asarSegment = `${resourcesSegment}/app.asar`;
  expect(result.url).toContain(`${asarSegment}/dist/index.html#/`);
  expect(result.url.startsWith(pathToFileURL(desktopAppPath).toString())).toBe(true);
  expect(result.dashboardUrl).toBe(`http://127.0.0.1:${result.port}/`);
  expect(result.preloadPath).toBe(
    path.join(desktopAppPath, ...asarSegment.split('/'), 'electron', 'preload.cjs')
  );
  expect(result.preloadUrl).toMatch(/^file:/);
  expect(result.desktopAppPath).toBe(desktopAppPath);
  expect(spawned).toHaveLength(1);
  expect(spawned[0].args.slice(0, 4)).toEqual(['dashboard', '--no-open', '--host', '127.0.0.1']);
  expect(spawned[0].opts.env.HERMES_HOME).toBe(globalHome);
  expect(spawned[0].opts.env.HERMES_DESKTOP).toBe('1');
  expect(spawned[0].opts.env.HERMES_DASHBOARD_SESSION_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(manager.proxyTarget()).toEqual({
    ownerKey: hermesDashboard.HERMES_DESKTOP_APP_OWNER_KEY,
    host: '127.0.0.1',
    port: result.port,
    remotePath: hermesDashboard.HERMES_DESKTOP_REMOTE_PATH,
  });
  expect(manager.isHomeClaimed(result.home)).toBe(false);
});

test('a new Ace process reaps the previous orphaned app sidecar before spawning', async () => {
  const first = makeManager({ parentPid: 1111 });
  const firstResult = await first.manager.ensure({});
  expect(firstResult.ok).toBe(true);
  expect(first.spawned).toHaveLength(1);
  const leaseText = fs.readFileSync(
    path.join(first.userDataPath, 'hermes-desktop-sidecar', 'sidecar-leases.json'),
    'utf8'
  );
  expect(leaseText).toContain(String(first.spawned[0].pid));
  expect(leaseText).not.toContain(first.spawned[0].opts.env.HERMES_DASHBOARD_SESSION_TOKEN);

  const terminated = [];
  const secondSpawned = procArray();
  const livePids = new Set([first.spawned[0].pid]);
  const second = makeManager({
    userDataPathOverride: first.userDataPath,
    globalHomeOverride: first.globalHome,
    parentPid: 2222,
    processAlive: (pid = 0) => livePids.has(pid),
    terminateProcess: (pid = 0, signal = '') => {
      terminated.push({ pid, signal });
      livePids.delete(pid);
    },
    spawnImpl: (bin = '', args = [''], opts = defaultSpawnOpts()) => {
      const proc = makeFakeProc(bin, args, opts);
      proc.pid = 5252;
      secondSpawned.push(proc);
      return proc;
    },
  });

  const secondResult = await second.manager.ensure({});

  expect(secondResult.ok).toBe(true);
  expect(terminated).toEqual([{ pid: first.spawned[0].pid, signal: 'SIGTERM' }]);
  expect(secondSpawned).toHaveLength(1);
  expect(secondSpawned[0].pid).toBe(5252);
});

test('a live Ace owner blocks a second process instead of creating a duplicate sidecar', async () => {
  const first = makeManager({ parentPid: 1111 });
  await first.manager.ensure({});
  const secondSpawned = procArray();
  const second = makeManager({
    userDataPathOverride: first.userDataPath,
    globalHomeOverride: first.globalHome,
    parentPid: 2222,
    processAlive: (pid = 0) => pid === 1111 || pid === first.spawned[0].pid,
    spawnImpl: fakeSpawnImpl(secondSpawned),
  });

  const result = await second.manager.ensure({});

  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/another running Ace process/);
  expect(secondSpawned).toHaveLength(0);
});

test('cross-process ownership is reserved before the first sidecar even spawns', async () => {
  let releasePort = () => {};
  const portGate = new Promise((resolve) => {
    releasePort = () => resolve(43210);
  });
  const first = makeManager({
    parentPid: 1111,
    allocatePort: () => portGate,
  });
  const firstPending = first.manager.ensure({});
  await settle();
  expect(first.spawned).toHaveLength(0);

  const reservation = JSON.parse(
    fs.readFileSync(
      path.join(first.userDataPath, 'hermes-desktop-sidecar', 'sidecar-leases.json'),
      'utf8'
    )
  );
  const appLease = reservation.entries.__ace_hermes_desktop_app__;
  expect(appLease).toMatchObject({ ownerPid: 1111, childPid: null });

  const secondSpawned = procArray();
  const second = makeManager({
    userDataPathOverride: first.userDataPath,
    globalHomeOverride: first.globalHome,
    parentPid: 2222,
    processAlive: (pid = 0) => pid === 1111,
    spawnImpl: fakeSpawnImpl(secondSpawned),
  });
  const secondResult = await second.manager.ensure({});
  expect(secondResult.ok).toBe(false);
  expect(secondSpawned).toHaveLength(0);

  releasePort();
  expect((await firstPending).ok).toBe(true);
  expect(first.spawned).toHaveLength(1);
});

test('appConnection routes a named non-active profile to the one app sidecar', async () => {
  const { manager, spawned } = makeManager();
  const primary = await manager.appConnection();
  expect(spawned).toHaveLength(1);

  // Single-sidecar: a named profile never spawns a second pooled backend — it
  // resolves to the same always-on app sidecar (same baseUrl, same fresh token).
  // The old multi-profile pool that split the gateway socket across two pythons
  // on one state.db is gone.
  const alpha = await manager.appConnection('alpha');
  expect(spawned).toHaveLength(1);
  expect(alpha.profile).toBe('alpha');
  expect(alpha.baseUrl).toBe(primary.baseUrl);
  expect(alpha.token).toBe(primary.token);
});

test('a throwing resolveProfileHome falls back to the legacy --profile app sidecar path', async () => {
  // The configured-home routing seam lives in the app sidecar (startEntry); a
  // resolver that throws must fall back to the legacy --profile + global home
  // path instead of blocking the connection. Identity-home routing itself is
  // covered by the app-sidecar tests below; the old per-profile pool is gone.
  const { manager, spawned, globalHome } = makeManager({
    resolveProfileHome: () => {
      throw new Error('resolver exploded');
    },
  });
  await manager.appConnection();
  expect(spawned).toHaveLength(1);
  const switchToGamma = manager.setAppProfile('gamma');
  spawned[0].emitExit(0);
  await switchToGamma;
  expect(spawned).toHaveLength(2);
  expect(spawned[1].args.slice(0, 3)).toEqual(['--profile', 'gamma', 'dashboard']);
  expect(spawned[1].opts.env.HERMES_HOME).toBe(globalHome);
});

test('appConnection: every profile (active or not) resolves to the one app sidecar', async () => {
  // The active desktop profile IS the app sidecar: setAppProfile re-roots the
  // sidecar at that profile, so it is that profile's backend. Routing the
  // active profile to a second pooled process split the SPA's single gateway
  // socket across TWO python processes sharing one state.db — the first
  // reconnect landed on a process that had never seen the visible session and
  // every in-flight turn detached to the gateway's stdio black hole (the
  // silent operator-lane no-reply bug).
  const { manager, spawned } = makeManager();
  await manager.appConnection();
  expect(spawned).toHaveLength(1);

  const switchToBeta = manager.setAppProfile('beta');
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const switched = await switchToBeta;
  expect(switched.changed).toBe(true);
  expect(spawned).toHaveLength(2);
  expect(spawned[1].args.slice(0, 3)).toEqual(['--profile', 'beta', 'dashboard']);
  const appToken = spawned[1].opts.env.HERMES_DASHBOARD_SESSION_TOKEN;

  // The app sidecar's own connection carries the active profile.
  const appAfterSwitch = await manager.appConnection();
  expect(appAfterSwitch.token).toBe(appToken);
  expect(appAfterSwitch.profile).toBe('beta');

  // Requesting the ACTIVE profile by name resolves to the app sidecar itself:
  // same process, same fresh token — never a second backend on the same
  // state.db.
  const beta = await manager.appConnection('beta');
  expect(spawned).toHaveLength(2);
  expect(beta.profile).toBe('beta');
  expect(beta.token).toBe(appToken);
  expect(beta.baseUrl).toBe(appAfterSwitch.baseUrl);

  // Re-selecting the already-active lane is a no-op: no kill, no respawn —
  // an in-flight turn survives the click.
  const reselect = await manager.setAppProfile('beta');
  expect(reselect.changed).toBe(false);
  expect(spawned).toHaveLength(2);
  expect(spawned[1].killedWith).toBe('');

  // Single-sidecar: a non-active named profile ALSO resolves to the one app
  // sidecar — no second pooled backend, same baseUrl, same fresh token.
  const alpha = await manager.appConnection('alpha');
  expect(spawned).toHaveLength(2);
  expect(alpha.baseUrl).toBe(appAfterSwitch.baseUrl);
  expect(alpha.token).toBe(appToken);
});

test('an asar-packed web dist is extracted to a sidecar-readable cache and passed via HERMES_WEB_DIST', async () => {
  // The sidecar is Python — it cannot read inside app.asar, so handing it an
  // asar-internal path 404s every non-API route ("Frontend not built").
  // Electron's fs IS asar-aware: extract the dist to a plain directory under
  // userData and hand THAT over, so the remote/mobile Teams proxy serves the
  // real desktop SPA instead of the sidecar's built-in browser UI.
  const { manager, spawned, userDataPath } = makeManager();
  await manager.appConnection();
  const webDist = spawned[0].opts.env.HERMES_WEB_DIST;
  const cacheRoot = path.join(userDataPath, 'hermes-desktop-sidecar', 'web-dist');
  expect(webDist).toBeDefined();
  expect(path.dirname(webDist)).toBe(cacheRoot);
  expect(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')).toBe('<div id="root"></div>');

  // The re-rooted app sidecar reuses the same extracted cache — no re-copy drift.
  const switchToAlpha = manager.setAppProfile('alpha');
  spawned[0].emitExit(0);
  await switchToAlpha;
  expect(spawned[1].opts.env.HERMES_WEB_DIST).toBe(webDist);
});

test('pruning never deletes a dist a backend spawned by this process is still serving', async () => {
  // hermes update can replace Hermes.app while the always-on app sidecar is
  // live. The next backend spawn extracts the NEW build — it must not prune
  // the old extraction out from under the running sidecar (live clients
  // lazy-load chunks from it). Stale dirs are reaped on the next app launch.
  const { manager, spawned, desktopAppPath, userDataPath, globalHome } = makeManager();
  await manager.appConnection();
  const firstDist = spawned[0].opts.env.HERMES_WEB_DIST;
  expect(firstDist).toBeDefined();

  const resources = process.platform === 'darwin'
    ? path.join(desktopAppPath, 'Contents', 'Resources', 'app.asar')
    : path.join(desktopAppPath, 'resources', 'app.asar');
  fs.writeFileSync(path.join(resources, 'dist', 'index.html'), '<div id="root">v2</div>');
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ version: '0.16.0' }));

  const switchToAlpha = manager.setAppProfile('alpha');
  spawned[0].emitExit(0);
  await switchToAlpha;
  const secondDist = spawned[1].opts.env.HERMES_WEB_DIST;
  expect(secondDist).not.toBe(firstDist);
  expect(fs.existsSync(path.join(firstDist, 'index.html'))).toBe(true);
  expect(fs.readFileSync(path.join(secondDist, 'index.html'), 'utf8')).toBe('<div id="root">v2</div>');

  // Relaunch (fresh manager, same install): the marker-reuse path serves the
  // current extraction AND reaps the dist the previous process was protecting.
  const relaunch = makeManager({
    userDataPathOverride: userDataPath,
    globalHomeOverride: globalHome,
  });
  await relaunch.manager.appConnection();
  expect(relaunch.spawned[0].opts.env.HERMES_WEB_DIST).toBe(secondDist);
  expect(fs.existsSync(firstDist)).toBe(false);
});

test('extraction copies plain files and dirs only — symlinks are never followed', async () => {
  // asar archives can carry links; following one out of the dist tree would
  // copy foreign content into the sidecar-served cache (or recurse forever
  // on a cycle). lstat + skip keeps the cache to the dist's own files.
  const { manager, spawned, desktopAppPath } = makeManager();
  const resources = process.platform === 'darwin'
    ? path.join(desktopAppPath, 'Contents', 'Resources', 'app.asar')
    : path.join(desktopAppPath, 'resources', 'app.asar');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the dist');
  fs.mkdirSync(path.join(resources, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'dist', 'assets', 'app.js'), 'console.log(1)');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(resources, 'dist', 'escape-link'));
  fs.symlinkSync(outside, path.join(resources, 'dist', 'escape-dir'));

  await manager.appConnection();
  const webDist = spawned[0].opts.env.HERMES_WEB_DIST;
  expect(webDist).toBeDefined();
  expect(fs.readFileSync(path.join(webDist, 'assets', 'app.js'), 'utf8')).toBe('console.log(1)');
  expect(fs.existsSync(path.join(webDist, 'escape-link'))).toBe(false);
  expect(fs.existsSync(path.join(webDist, 'escape-dir'))).toBe(false);
});

test('a changed Hermes.app build re-extracts and prunes the stale cache directory', async () => {
  const first = makeManager();
  await first.manager.appConnection();
  const firstDist = first.spawned[0].opts.env.HERMES_WEB_DIST;
  expect(firstDist).toBeDefined();

  // Same userData, "updated" desktop app: new content + version → new
  // fingerprint. The old extraction is pruned, the new one is served.
  const resources = process.platform === 'darwin'
    ? path.join(first.desktopAppPath, 'Contents', 'Resources', 'app.asar')
    : path.join(first.desktopAppPath, 'resources', 'app.asar');
  fs.writeFileSync(path.join(resources, 'dist', 'index.html'), '<div id="root">v2</div>');
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ version: '0.16.0' }));

  const second = makeManager({
    userDataPathOverride: first.userDataPath,
    globalHomeOverride: first.globalHome,
  });
  await second.manager.appConnection();
  const secondDist = second.spawned[0].opts.env.HERMES_WEB_DIST;
  expect(secondDist).toBeDefined();
  expect(secondDist).not.toBe(firstDist);
  expect(fs.readFileSync(path.join(secondDist, 'index.html'), 'utf8')).toBe('<div id="root">v2</div>');
  expect(fs.existsSync(firstDist)).toBe(false);
});

test('an app.asar.unpacked web dist is passed through to the sidecar', async () => {
  const { manager, spawned, desktopAppPath } = makeManager();
  const resources = process.platform === 'darwin'
    ? path.join(desktopAppPath, 'Contents', 'Resources')
    : path.join(desktopAppPath, 'resources');
  const unpackedDist = path.join(resources, 'app.asar.unpacked', 'dist');
  fs.mkdirSync(unpackedDist, { recursive: true });

  await manager.appConnection();
  expect(spawned[0].opts.env.HERMES_WEB_DIST).toBe(unpackedDist);
});

test('startEntry app sidecar with a configured-home active profile spawns without --profile at the resolved home', async () => {
  // Defect B: when the active desktop profile resolves to an explicit per-
  // identity home, the always-on app sidecar must open THAT home directly
  // (HERMES_HOME=resolved) with NO `--profile` re-root.
  const identityHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-app-identity-'));
  const { manager, spawned, globalHome } = makeManager({
    resolveProfileHome: (profile = '') => (profile === 'configured' ? identityHome : null),
  });
  await manager.appConnection();
  expect(spawned).toHaveLength(1);
  // Baseline: no active profile → global HERMES_HOME, no --profile.
  expect(spawned[0].args).not.toContain('--profile');
  expect(spawned[0].opts.env.HERMES_HOME).toBe(globalHome);

  const switchToConfigured = manager.setAppProfile('configured');
  spawned[0].emitExit(0);
  await switchToConfigured;
  expect(spawned).toHaveLength(2);
  // Resolved configured home: drop --profile, HERMES_HOME is the real home.
  expect(spawned[1].args).not.toContain('--profile');
  expect(spawned[1].args.slice(0, 4)).toEqual(['dashboard', '--no-open', '--host', '127.0.0.1']);
  expect(spawned[1].opts.env.HERMES_HOME).toBe(identityHome);
  expect(spawned[1].opts.env.HERMES_DESKTOP).toBe('1');
});

test('appConnection reports backendProfile=default for an identity-home sidecar, else the named profile', () => {
  // ft-08d2a768: an identity-home sidecar (no --profile) only serves 'default';
  // appConnection must report that so the embed transport aliases alpha->default.
  const identityHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-bp-'));
  const { manager, spawned } = makeManager({
    resolveProfileHome: (profile = '') => (profile === 'alpha' ? identityHome : null),
  });
  return (async () => {
    // Active profile = alpha → identity-home sidecar → backendProfile 'default'.
    await manager.setAppProfile('alpha');
    const kingConn = await manager.appConnection();
    expect(kingConn.profile).toBe('alpha');
    expect(kingConn.backendProfile).toBe('default');
    // Requesting the active profile by name resolves to the same app sidecar.
    const kingByName = await manager.appConnection('alpha');
    expect(kingByName.backendProfile).toBe('default');

    // A non-identity profile keeps its real name (legacy --profile path).
    const switchToPlain = manager.setAppProfile('plain');
    spawned[spawned.length - 1].emitExit(0);
    await switchToPlain;
    const plainConn = await manager.appConnection();
    expect(plainConn.profile).toBe('plain');
    expect(plainConn.backendProfile).toBe('plain');
  })();
});

test('startEntry app sidecar with a CLI-only active profile keeps the legacy --profile + global home path', async () => {
  // The flip side of Defect B: when the resolver returns null (CLI-only /
  // unconfigured profile) the app sidecar is byte-identical to before.
  const { manager, spawned, globalHome } = makeManager({
    resolveProfileHome: () => null,
  });
  await manager.appConnection();
  const switchToPlain = manager.setAppProfile('plain');
  spawned[0].emitExit(0);
  await switchToPlain;
  expect(spawned).toHaveLength(2);
  expect(spawned[1].args.slice(0, 3)).toEqual(['--profile', 'plain', 'dashboard']);
  expect(spawned[1].opts.env.HERMES_HOME).toBe(globalHome);
});

test('isHomeClaimed: false before ensure, true while running, false after stop', async () => {
  const { manager, spawned, homesRoot } = makeManager();
  const home = path.join(homesRoot, 'hermes-home-prj-1');
  expect(manager.isHomeClaimed(home)).toBe(false);
  await manager.ensure({ ownerKey: 'prj-1' });
  expect(manager.isHomeClaimed(home)).toBe(true);
  const stopped = manager.stop({ ownerKey: 'prj-1' });
  expect(manager.isHomeClaimed(home)).toBe(true);
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const stopResult = await stopped;
  expect(stopResult).toEqual({ ok: true, stopped: true });
  expect(manager.isHomeClaimed(home)).toBe(false);
  // A late exit callback from the killed process is inert.
  spawned[0].emitExit(0);
  await settle();
  expect(manager.isHomeClaimed(home)).toBe(false);
  expect(manager.status().dashboards).toEqual([]);
});

test('stopAll releases every claim', async () => {
  const { manager, spawned, homesRoot } = makeManager();
  await manager.ensure({ ownerKey: 'prj-1' });
  await manager.ensure({ ownerKey: 'prj-2' });
  const stopped = manager.stopAll();
  expect(manager.isHomeClaimed(path.join(homesRoot, 'hermes-home-prj-1'))).toBe(true);
  expect(manager.isHomeClaimed(path.join(homesRoot, 'hermes-home-prj-2'))).toBe(true);
  spawned[0].emitExit(0);
  spawned[1].emitExit(0);
  const result = await stopped;
  expect(result).toEqual({ ok: true, stopped: 2 });
  expect(manager.isHomeClaimed(path.join(homesRoot, 'hermes-home-prj-1'))).toBe(false);
  expect(manager.isHomeClaimed(path.join(homesRoot, 'hermes-home-prj-2'))).toBe(false);
  expect(spawned.map((p) => p.killedWith)).toEqual(['SIGTERM', 'SIGTERM']);
});

test('crash auto-restarts exactly once, then requires a manual ensure', async () => {
  const { manager, spawned, homesRoot } = makeManager();
  const home = path.join(homesRoot, 'hermes-home-prj-1');
  await manager.ensure({ ownerKey: 'prj-1' });
  expect(spawned).toHaveLength(1);

  // First crash: one automatic restart with a fresh port + token.
  spawned[0].emitExit(1);
  await settle();
  expect(spawned).toHaveLength(2);
  expect(manager.isHomeClaimed(home)).toBe(true);
  expect(spawned[1].opts.env.HERMES_DASHBOARD_SESSION_TOKEN).not.toBe(
    spawned[0].opts.env.HERMES_DASHBOARD_SESSION_TOKEN
  );

  // Second crash: stays down, claim released, no third spawn.
  spawned[1].emitExit(1);
  await settle();
  expect(spawned).toHaveLength(2);
  expect(manager.isHomeClaimed(home)).toBe(false);
  const snapshot = manager.status().dashboards;
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0].status).toBe('exited');
  expect(snapshot[0].restarts).toBe(1);

  // Manual restart works and resets the crash-loop budget.
  const again = await manager.ensure({ ownerKey: 'prj-1' });
  expect(again.ok).toBe(true);
  expect(spawned).toHaveLength(3);
  expect(manager.isHomeClaimed(home)).toBe(true);
});

test('always-on app sidecar bounds its crash loop instead of restarting forever', async () => {
  vi.useFakeTimers();
  try {
    const { manager, spawned, events } = makeManager();
    // The Teams app sidecar (no ownerKey) is alwaysOn — the regression was that
    // it respawned the python dashboard forever on a crash-on-launch.
    await manager.ensure({});
    expect(spawned).toHaveLength(1);

    // Each alwaysOn restart is scheduled on a short backoff timer; advance time
    // (staying well inside the 60s window) so the restart fires, then crash
    // again. After the ceiling (3 restarts) it must give up.
    for (let i = 0; i < 3; i += 1) {
      spawned[i].emitExit(1);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(spawned).toHaveLength(4); // initial + exactly 3 restarts

    // The 4th crash trips the ceiling: no 5th spawn, status exited, error event.
    spawned[3].emitExit(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawned).toHaveLength(4);
    const app = manager.status().dashboards.find((d) => d.kind === 'app');
    expect(app && app.status).toBe('exited');
    expect(events.some((e) => e.type === 'error')).toBe(true);

    // A manual ensure() rebuilds a fresh entry and runs again (ceiling resets).
    await manager.ensure({});
    expect(spawned).toHaveLength(5);
  } finally {
    vi.useRealTimers();
  }
});

test('resolveHermesDesktopApp finds a real Windows install layout', () => {
  // End-to-end proof of the actual bug, run from macOS: build the exact tree
  // electron-builder produces on Windows — release\win-unpacked\resources\
  // app.asar, NO Hermes.app, home at %LOCALAPPDATA%\hermes — and confirm the
  // resolver now finds it. Before the fix every candidate missed and the
  // surface died with "Hermes did not start."
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-win-'));
  const target = { platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: localAppData }, homedir: localAppData };
  const appRoot = hermesPaths.hermesDesktopAppRoots(target)[0];
  expect(appRoot).toContain('win-unpacked');
  expect(appRoot).not.toContain('Hermes.app');

  const asar = path.join(appRoot, 'resources', 'app.asar');
  fs.mkdirSync(path.join(asar, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(asar, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(asar, 'dist', 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(asar, 'electron', 'preload.cjs'), 'module.exports = {}');
  fs.writeFileSync(path.join(asar, 'package.json'), JSON.stringify({ version: '0.17.0' }));

  const home = hermesPaths.globalHermesHome(target);
  expect(home).toBe(path.join(localAppData, 'hermes'));

  const resolved = hermesDashboard.resolveHermesDesktopApp(null, fs, () => home, target);
  expect(resolved).toBeTruthy();
  expect(resolved.appPath).toBe(appRoot);
  expect(resolved.version).toBe('0.17.0');
  expect(resolved.indexPath).toBe(path.join(asar, 'dist', 'index.html'));
  // Windows resources sit in resources/, not Contents/Resources/.
  expect(resolved.indexPath).not.toContain('Contents');
});

test('resolveHermesDesktopApp returns null when a Windows install has no desktop build', () => {
  // install.ps1 only builds the desktop app with -IncludeDesktop, so this is
  // the NORMAL Windows shape — it must degrade, not throw.
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-win-nobuild-'));
  const target = { platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: localAppData }, homedir: localAppData };
  const home = hermesPaths.globalHermesHome(target);
  expect(hermesDashboard.resolveHermesDesktopApp(null, fs, () => home, target)).toBe(null);
});

test('the CLI-missing message never leaks a machine-specific location', () => {
  const message = hermesDashboard.missingHermesCliMessage('/tmp/fake-hermes-home');
  expect(message).toContain('/tmp/fake-hermes-home');
  // The old desktop-bundle error hardcoded the maintainer's own setup ("the
  // external SSD"), which every user saw verbatim.
  expect(message).not.toMatch(/external SSD|Volumes/i);
});

// ── no desktop bundle: degrade to the sidecar's own web UI ─────────────────

test('a missing desktop bundle starts the sidecar instead of dead-ending', async () => {
  // The Windows desktop build is opt-in (install.ps1 -IncludeDesktop), so the
  // bundle is normally absent there. Requiring it threw before any spawn and
  // stranded the whole surface — "Hermes did not start." — for users whose
  // hermes CLI was working fine.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-nobundle-'));
  const ctx = makeManager({ globalHomeOverride: emptyHome });
  fs.rmSync(ctx.desktopAppPath, { recursive: true, force: true });

  const result = await ctx.manager.ensure({});
  expect(result.ok).toBe(true);
  expect(ctx.spawned).toHaveLength(1);
  expect(result.surface).toBe('web');
  // The sidecar's served page (it embeds the session token), not a file:// SPA.
  expect(result.url).toBe(`${result.baseUrl}/`);
  expect(result.preloadUrl).toBeNull();
  expect(result.preloadPath).toBeNull();
  expect(result.desktopAppPath).toBeNull();
  expect(result.desktopAppVersion).toBeNull();

  const env = ctx.spawned[0].opts.env;
  // No bundle means no dist to point at, so HERMES_WEB_DIST must be absent.
  expect(env.HERMES_WEB_DIST).toBeUndefined();
  // HERMES_DESKTOP stays set: it means "app-spawned backend", which is still
  // true here, and it is what starts the sidecar's own cron ticker. Gating it
  // on the bundle silently stopped every scheduled job on this path.
  expect(env.HERMES_DESKTOP).toBe('1');
  // Still a real sidecar on the real global home.
  expect(env.HERMES_HOME).toBe(emptyHome);
});

test('the bundle-less spawn never inherits a stale HERMES_WEB_DIST', async () => {
  // baseEnv() is process.env by default, so a stale HERMES_WEB_DIST would
  // otherwise ride into the fallback spawn and serve an unrelated dist as the
  // SPA. The dist must come from the resolved bundle alone, never from how the
  // app happened to be launched.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-staleenv-'));
  const ctx = makeManager({
    globalHomeOverride: emptyHome,
    baseEnv: () => ({
      PATH: '/usr/bin',
      HERMES_WEB_DIST: '/stale/from/a/previous/bundle/dist',
    }),
  });

  const result = await ctx.manager.ensure({});
  expect(result.ok).toBe(true);
  expect(result.surface).toBe('web');
  const envKeys = Object.keys(ctx.spawned[0].opts.env);
  expect(envKeys.filter((key) => key.toUpperCase() === 'HERMES_WEB_DIST')).toEqual([]);
  // Unrelated inherited vars are still passed through.
  expect(envKeys).toContain('PATH');
});

test('the env scrub is case-insensitive, as Windows environment names are', async () => {
  // Windows treats `Hermes_Web_Dist` and `HERMES_WEB_DIST` as ONE variable, but
  // baseEnv() is a plain (case-SENSITIVE) spread copy, so an exact-key delete
  // missed mixed-case inherited values — and they then reached the child under
  // their original casing, setting the variable after all, on the very
  // platform this fallback exists for. Two colliding spellings are supplied so
  // a single-delete implementation cannot pass either.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-caseenv-'));
  const ctx = makeManager({
    globalHomeOverride: emptyHome,
    baseEnv: () => ({
      PATH: '/usr/bin',
      hermes_web_dist: '/stale/dist',
      HERMES_WEB_DIST: '/another/stale/dist',
      Hermes_Web_Dist: '/a/third/stale/dist',
    }),
  });

  const result = await ctx.manager.ensure({});
  expect(result.ok).toBe(true);
  expect(result.surface).toBe('web');
  // No HERMES_WEB_DIST of ANY casing may survive: an exact-key check would pass
  // here while Windows still delivered the variable to the child.
  const envKeys = Object.keys(ctx.spawned[0].opts.env);
  expect(envKeys.filter((key) => key.toUpperCase() === 'HERMES_WEB_DIST')).toEqual([]);
  // And exactly one spelling of HERMES_DESKTOP, so the OS never has to choose.
  expect(envKeys.filter((key) => key.toUpperCase() === 'HERMES_DESKTOP')).toEqual(['HERMES_DESKTOP']);
  expect(envKeys).toContain('PATH');
});

test('the orphan-reap grace collapses to one key across every case permutation', async () => {
  // Windows env names are case-insensitive, so two spellings of this variable
  // can coexist in the inherited env. A naive "read a value, then maybe
  // delete-and-set" is wrong BOTH ways: a blank read first deletes a real
  // override in another spelling; a real value read first leaves both keys for
  // the OS to choose between. Every permutation must yield exactly ONE key,
  // carrying the operator's value when they set a non-empty one.
  const cases = [
    { env: {}, expected: '1800', why: 'nothing set' },
    { env: { HERMES_TUI_WS_ORPHAN_REAP_GRACE_S: '' }, expected: '1800', why: 'empty is unset' },
    { env: { Hermes_Tui_Ws_Orphan_Reap_Grace_S: '' }, expected: '1800', why: 'mixed-case empty is unset' },
    { env: { HERMES_TUI_WS_ORPHAN_REAP_GRACE_S: '600' }, expected: '600', why: 'canonical override wins' },
    { env: { Hermes_Tui_Ws_Orphan_Reap_Grace_S: '60' }, expected: '60', why: 'mixed-case override wins' },
    {
      env: { Hermes_Tui_Ws_Orphan_Reap_Grace_S: '', HERMES_TUI_WS_ORPHAN_REAP_GRACE_S: '600' },
      expected: '600',
      why: 'a blank variant must not delete a real override',
    },
    {
      env: { HERMES_TUI_WS_ORPHAN_REAP_GRACE_S: '600', Hermes_Tui_Ws_Orphan_Reap_Grace_S: '' },
      expected: '600',
      why: 'a real override must not leave a second spelling behind',
    },
  ];

  for (const { env: inherited, expected, why } of cases) {
    const ctx = makeManager({ baseEnv: () => ({ PATH: '/usr/bin', ...inherited }) });
    await ctx.manager.ensure({});
    const entries = Object.entries(ctx.spawned[0].opts.env).filter(
      ([key]) => key.toUpperCase() === 'HERMES_TUI_WS_ORPHAN_REAP_GRACE_S'
    );
    expect(entries, why).toEqual([['HERMES_TUI_WS_ORPHAN_REAP_GRACE_S', expected]]);
  }
});

test('the not-found warning names the configured bundle path, not just the defaults', async () => {
  // A broken explicitly-configured bundle is the case where the diagnostic
  // matters most, so the warning shares resolution's own candidate list.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-warn-'));
  const userDataPath = tmpUserData();
  hermesDashboard.saveSurfaceConfig(userDataPath, {
    ...hermesDashboard.defaultSurfaceConfig(),
    dashboard: {
      ...hermesDashboard.defaultSurfaceConfig().dashboard,
      desktopAppPath: '/configured/but/broken/Hermes.app',
    },
  });
  // Typed-empty idiom (matches `events` above): plain `[]` infers never[].
  const warnings = [''].slice(0, 0);
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { manager } = makeManager({ userDataPathOverride: userDataPath, globalHomeOverride: emptyHome });
    // MUST await: startEntry awaits reclaimPersistedSidecar before resolving the
    // bundle, so a synchronous restore below would put console.warn back before
    // the warning is ever emitted.
    await manager.ensure({});
  } finally {
    console.warn = warn;
  }
  const hit = warnings.find((w) => w.includes('Hermes desktop bundle not found'));
  expect(hit).toBeTruthy();
  expect(hit).toContain('/configured/but/broken/Hermes.app');
  expect(hit).toContain(emptyHome);
});

test('a named profile with NO bundle still sets HERMES_DESKTOP, so the CLI does not re-exec', async () => {
  // This combination is why HERMES_DESKTOP must not be gated on the bundle.
  // The pinned Hermes CLI reroutes a non-default profile by re-spawning itself
  // (hermes_cli/main.py) — and on Windows that re-exec is a subprocess.Popen
  // whose child would NOT die with the parent Ace kills, leaving an orphaned
  // dashboard writing the same state.db. The reroute is gated on
  // HERMES_DESKTOP != "1", so setting it is what keeps the spawned process the
  // one Ace actually owns.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-profile-nobundle-'));
  const ctx = makeManager({ globalHomeOverride: emptyHome });
  const first = await ctx.manager.ensure({});
  expect(first.surface).toBe('web');

  const switching = ctx.manager.setAppProfile('alpha');
  ctx.spawned[0].emitExit(0);
  await switching;
  expect(ctx.spawned).toHaveLength(2);
  // A named profile with no resolved identity home keeps the legacy --profile
  // path — exactly the shape the CLI would reroute.
  expect(ctx.spawned[1].args).toContain('--profile');
  expect(ctx.spawned[1].opts.env.HERMES_DESKTOP).toBe('1');
  expect(ctx.spawned[1].opts.env.HERMES_WEB_DIST).toBeUndefined();
});

test('a present desktop bundle still takes the file:// desktop path', async () => {
  const ctx = makeManager();
  const result = await ctx.manager.ensure({});
  expect(result.ok).toBe(true);
  expect(result.surface).toBe('desktop');
  expect(result.url).toMatch(/^file:/);
  expect(result.preloadUrl).toBeTruthy();
  expect(result.desktopAppPath).toBe(ctx.desktopAppPath);
  expect(ctx.spawned[0].opts.env.HERMES_DESKTOP).toBe('1');
});

test('isLoopbackHttpUrl recognizes a sidecar URL and nothing else', () => {
  // Used by main.cts to answer "is this webview our Hermes surface?" for the
  // bundle-less guest. Port-agnostic (each respawn allocates a fresh one), but
  // it must never bless a remote origin — the partition guard in main.cts is
  // the second half of that protection.
  for (const ok of [
    'http://127.0.0.1:43210/',
    'http://localhost:1/?aceProfile=alpha',
    'http://[::1]:8080/',
    'https://127.0.0.1:9/',
  ]) {
    expect(hermesDashboard.isLoopbackHttpUrl(ok), ok).toBe(true);
  }
  for (const bad of [
    '',
    null,
    'file:///Applications/Hermes.app/Contents/Resources/app.asar/dist/index.html',
    'http://example.com/',
    'http://127.0.0.1.evil.com/',
    'ace://open?x=1',
    'ws://127.0.0.1:43210/api/ws',
  ]) {
    expect(hermesDashboard.isLoopbackHttpUrl(bad), String(bad)).toBe(false);
  }
});

test('the main-process partition constant matches the renderer webview partition', () => {
  // Two module graphs, one string: the renderer sets it on the <webview>, the
  // main process matches wc.session against it. If they drift, link routing and
  // guest hardening silently stop recognizing the Hermes surface.
  const rendererLogic = fs.readFileSync(
    path.join(process.cwd(), 'src/components/teams/hermes-dashboard-pane-logic.ts'),
    'utf8'
  );
  const match = /HERMES_DESKTOP_APP_PARTITION = '([^']+)'/.exec(rendererLogic);
  expect(match).toBeTruthy();
  expect(hermesDashboard.HERMES_DESKTOP_APP_PARTITION).toBe(match[1]);
});

// ── guest navigation routing (behavioral) ──────────────────────────────────

test('resolveIsMainFrame reads whichever shape the Electron runtime supplies', () => {
  // Electron 37+ puts params on the event object; the positional args remain and
  // are deprecated. Reading only one shape is how the subframe guard silently
  // did nothing.
  expect(hermesDashboard.resolveIsMainFrame({ preventDefault() {} }, false)).toBe(false);
  expect(hermesDashboard.resolveIsMainFrame({ preventDefault() {} }, true)).toBe(true);
  expect(hermesDashboard.resolveIsMainFrame({ isMainFrame: false }, undefined)).toBe(false);
  expect(hermesDashboard.resolveIsMainFrame({ isMainFrame: true }, undefined)).toBe(true);
  // Positional wins when both are present (it is what Electron documents).
  expect(hermesDashboard.resolveIsMainFrame({ isMainFrame: true }, false)).toBe(false);
  // Neither present: treat as main frame so a real cross-origin escape is still
  // diverted rather than silently allowed.
  expect(hermesDashboard.resolveIsMainFrame({}, undefined)).toBe(true);
});

test('shouldDivertHermesGuestNavigation diverts only main-frame cross-origin web targets', () => {
  const guestUrl = 'http://127.0.0.1:43210/';
  const divert = (extra) =>
    hermesDashboard.shouldDivertHermesGuestNavigation({ guestUrl, isMainFrame: true, ...extra });

  // Leaves the origin -> divert into Ace's browser pane.
  expect(divert({ url: 'https://example.com/docs' })).toBe(true);
  expect(divert({ url: 'http://192.168.1.5:8080/' })).toBe(true);

  // The guest's own routing -> never touch it.
  expect(divert({ url: 'http://127.0.0.1:43210/c/abc' })).toBe(false);
  expect(divert({ url: 'http://127.0.0.1:43210/?aceProfile=alpha' })).toBe(false);

  // A different port IS a different origin, so it is diverted.
  expect(divert({ url: 'http://127.0.0.1:43211/' })).toBe(true);

  // Subframes are never cancelled — that would break embedded content.
  expect(divert({ url: 'https://example.com/embed', isMainFrame: false })).toBe(false);

  // Non-web schemes are handled elsewhere (ace://) or by the OS.
  for (const url of ['ace://open?x=1', 'mailto:a@b.c', 'file:///etc/hosts', '', null]) {
    expect(divert({ url }), String(url)).toBe(false);
  }

  // Packaged file:// guest: origin is 'null', so every web target is diverted —
  // byte-identical to the behavior before the bundle-less surface existed.
  const packaged = 'file:///Applications/Hermes.app/Contents/Resources/app.asar/dist/index.html';
  expect(
    hermesDashboard.shouldDivertHermesGuestNavigation({
      url: 'https://example.com/',
      guestUrl: packaged,
      isMainFrame: true,
    })
  ).toBe(true);
});

test('a subframe redirect is left alone even when it leaves the origin', () => {
  // The exact case the earlier event.isMainFrame-only check failed to exclude.
  expect(
    hermesDashboard.shouldDivertHermesGuestNavigation({
      url: 'https://auth.example.com/callback',
      guestUrl: 'http://127.0.0.1:43210/',
      isMainFrame: hermesDashboard.resolveIsMainFrame({ preventDefault() {} }, false),
    })
  ).toBe(false);
});

test('ensure fails cleanly when the hermes CLI is missing — no claim left behind', async () => {
  const { manager, homesRoot, globalHome } = makeManager({ whichHermes: () => null });
  const result = await manager.ensure({ ownerKey: 'prj-1' });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/Hermes CLI not found/);
  // Actionable and TRUE on the reader's machine: it names the dirs actually
  // searched on THIS platform, not the maintainer's layout.
  expect(result.error).toContain(path.join(globalHome, 'hermes-agent', 'venv'));
  expect(manager.isHomeClaimed(path.join(homesRoot, 'hermes-home-prj-1'))).toBe(false);
});

// ── secret hygiene ─────────────────────────────────────────────────────────

test('status() and events never leak the session token or dashboard URL', async () => {
  const { manager, spawned, events } = makeManager();
  const result = await manager.ensure({ ownerKey: 'prj-1' });
  expect(result.ok).toBe(true);
  const token = spawned[0].opts.env.HERMES_DASHBOARD_SESSION_TOKEN;
  const statusJson = JSON.stringify(manager.status());
  const eventsJson = JSON.stringify(events);
  expect(statusJson).not.toContain(token);
  expect(statusJson).not.toContain('url');
  expect(statusJson).not.toContain('token');
  expect(eventsJson).not.toContain(token);
  expect(eventsJson).not.toContain('http://');
});

// ── surface preference behavior ────────────────────────────────────────────

test('setSurface persists the preference and flipping to lanes stops dashboards first', async () => {
  const { manager, userDataPath, spawned } = makeManager();
  await manager.ensure({ ownerKey: 'prj-1' });

  const toDashboard = await manager.setSurface('dashboard');
  expect(toDashboard.surface).toBe('dashboard');
  expect(hermesDashboard.loadSurfaceConfig(userDataPath).defaultSurface).toBe('dashboard');
  // Switching TO dashboard never kills running dashboards.
  expect(spawned[0].killedWith).toBe('');

  const toLanesPending = manager.setSurface('lanes');
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const toLanes = await toLanesPending;
  expect(toLanes.surface).toBe('lanes');
  expect(toLanes.dashboards).toEqual([]);
  expect(hermesDashboard.loadSurfaceConfig(userDataPath).defaultSurface).toBe('lanes');

  await expect(manager.setSurface('tui')).rejects.toThrow(/surface/);
});

test('isHomeClaimed matches a symlinked spelling of the same home', async () => {
  // ~/.hermes is now a symlink to the external SSD, so the PTY guard may see a
  // home spelled through the symlink while the ledger key was realpath'd (or
  // vice versa). The manager normalizes both via realpath, so a symlinked
  // parent must still resolve to the same claim.
  const realRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-realhome-'))
  );
  const linkParent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-link-'))
  );
  const linkRoot = path.join(linkParent, 'hermes-link');
  fs.symlinkSync(realRoot, linkRoot);

  const { manager } = makeManager({
    // ensureHermesHome hands back the REAL path; the guard probes the
    // SYMLINKED spelling.
    ensureHermesHome: (ownerKey = '') => {
      const home = path.join(realRoot, `hermes-home-${ownerKey}`);
      fs.mkdirSync(home, { recursive: true });
      return home;
    },
  });
  await manager.ensure({ ownerKey: 'prj-1' });

  expect(manager.isHomeClaimed(path.join(linkRoot, 'hermes-home-prj-1'))).toBe(true);
  expect(manager.isHomeClaimed(path.join(realRoot, 'hermes-home-prj-1'))).toBe(true);
});

test('dormant default: a fresh manager claims nothing and status reports lanes', () => {
  const { manager } = makeManager();
  const snapshot = manager.status();
  expect(snapshot.surface).toBe('lanes');
  expect(snapshot.dashboards).toEqual([]);
  expect(manager.isHomeClaimed('/anything/at/all')).toBe(false);
});

test('stop-then-claim: ensure() sweeps live PTY writers after the claim lands and before spawn', async () => {
  const sweeps = [{ home: '', claimedDuringSweep: false, spawnCountDuringSweep: 0 }].slice(0, 0);
  const holder = { manager: { isHomeClaimed: (home = '') => Boolean(home) }, spawned: procArray() };
  const { manager, spawned } = makeManager({
    stopHermesPtyForHome: (home = '') => {
      sweeps.push({
        home,
        // The claim must already be registered when the sweep runs…
        claimedDuringSweep: holder.manager.isHomeClaimed(home),
        // …and the dashboard must not have spawned yet.
        spawnCountDuringSweep: holder.spawned.length,
      });
      return 1;
    },
  });
  holder.manager = manager;
  holder.spawned = spawned;

  const result = await manager.ensure({ ownerKey: 'prj-1' });
  expect(result.ok).toBe(true);
  expect(sweeps).toHaveLength(1);
  expect(sweeps[0].home).toBe(result.home);
  expect(sweeps[0].claimedDuringSweep).toBe(true);
  expect(sweeps[0].spawnCountDuringSweep).toBe(0);
  expect(spawned).toHaveLength(1);

  // Idempotent re-ensure of a live dashboard must NOT re-sweep.
  await manager.ensure({ ownerKey: 'prj-1' });
  expect(sweeps).toHaveLength(1);
});

test('a throwing PTY sweep fails closed: claim released, no spawn, retry recovers', async () => {
  // A sweep that throws midway may have left a live PTY writer on the home —
  // spawning anyway would reopen the dual-write hazard, so ensure() must
  // release the claim and report the failure instead.
  const holder = { failures: 1 };
  const { manager, spawned } = makeManager({
    stopHermesPtyForHome: () => {
      if (holder.failures > 0) {
        holder.failures -= 1;
        throw new Error('sweep exploded');
      }
      return 0;
    },
  });

  const failed = await manager.ensure({ ownerKey: 'prj-1' });
  expect(failed.ok).toBe(false);
  expect(failed.error).toMatch(/lane handoff failed/);
  expect(failed.error).toMatch(/sweep exploded/);
  expect(failed.home).toBeTruthy();
  expect(spawned).toHaveLength(0);
  // No half-state: the claim is gone, so lanes can spawn again immediately…
  expect(manager.isHomeClaimed(failed.home)).toBe(false);
  expect(manager.status().dashboards).toEqual([]);

  // …and a retry re-runs claim → sweep → spawn cleanly.
  const retried = await manager.ensure({ ownerKey: 'prj-1' });
  expect(retried.ok).toBe(true);
  expect(spawned).toHaveLength(1);
  expect(manager.isHomeClaimed(retried.home)).toBe(true);
});

// ── restart (narrow Agent Control surface) ──────────────────────────────────

test('restart stops then re-ensures the app sidecar and returns a sanitized result', async () => {
  const { manager, spawned } = makeManager();
  await manager.ensure({});
  expect(spawned).toHaveLength(1);

  const pending = manager.restart({});
  // The existing stop() path: SIGTERM, never a raw kill from outside.
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const result = await pending;

  expect(spawned).toHaveLength(2);
  expect(result.ok).toBe(true);
  expect(result.ownerKey).toBe(hermesDashboard.HERMES_DESKTOP_APP_OWNER_KEY);
  // Sanitized: only ok/ownerKey/status/pid — never the embed URL or token.
  expect(Object.keys(result).sort()).toEqual(['ok', 'ownerKey', 'pid', 'status']);
  const flat = JSON.stringify(result).toLowerCase();
  expect(flat).not.toContain('token');
  expect(flat).not.toContain('http');
  expect(flat).not.toContain('url');
});

test('restart targets a lane-home dashboard by ownerKey and starts it when absent', async () => {
  const { manager, spawned, homesRoot } = makeManager();
  await manager.ensure({ ownerKey: 'prj-1' });
  const home = path.join(homesRoot, 'hermes-home-prj-1');

  const pending = manager.restart({ ownerKey: 'prj-1' });
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.ownerKey).toBe('prj-1');
  expect(spawned).toHaveLength(2);
  expect(manager.isHomeClaimed(home)).toBe(true);

  // Restarting something that is not running is just a clean start.
  const fresh = makeManager();
  const started = await fresh.manager.restart({ ownerKey: 'prj-9' });
  expect(started.ok).toBe(true);
  expect(fresh.spawned).toHaveLength(1);
});

test('restart surfaces ensure() failures without leaking ensure payload fields', async () => {
  const { manager } = makeManager({ whichHermes: () => null });
  const result = await manager.restart({});
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/hermes/i);
  expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'ownerKey']);
});

// ── Ace CLI transport env on sidecar spawns ────────────────────────────

test('every sidecar spawn carries the injected Ace CLI transport env', async () => {
  const transport = {
    ACE_SOCK: '/fake/run/ace.Ace.sock',
    ACE_URL: 'http://127.0.0.1:9419',
    ACE_TOKEN: 'fake-agent-cli-token',
    ACE_USER_DATA_TAG: 'Ace',
  };
  const { manager, spawned } = makeManager({
    baseEnv: () => ({}),
    aceTransportEnv: () => ({ ...transport }),
  });

  // Per-home dashboard sidecar.
  const home = await manager.ensure({ ownerKey: 'prj-1' });
  expect(home.ok).toBe(true);
  // App sidecar (global Teams surface).
  await manager.appConnection();
  // Single-sidecar: switching the active profile re-roots (kills + respawns) the
  // app sidecar — a third spawn that must also carry the transport env.
  const switchToAlpha = manager.setAppProfile('alpha');
  spawned[1].emitExit(0);
  await switchToAlpha;

  expect(spawned.length).toBeGreaterThanOrEqual(3);
  for (const proc of spawned) {
    for (const [key, value] of Object.entries(transport)) {
      expect(proc.opts.env[key]).toBe(value);
    }
    // The transport env must not displace the sidecar contract vars.
    expect(proc.opts.env.HERMES_DASHBOARD_SESSION_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  }
});

test('transport env defaults to empty: no ACE_* leaks without the injected dep', async () => {
  const { manager, spawned } = makeManager({ baseEnv: () => ({}) });
  await manager.ensure({ ownerKey: 'prj-1' });
  expect(spawned).toHaveLength(1);
  const envKeys = Object.keys(spawned[0].opts.env).filter((k) => k.startsWith('ACE_'));
  expect(envKeys).toEqual([]);
});

// ── profile id normalization + stale Hermes code self-heal ────────────────

test('ace-session profile ids normalize before resolving to the app sidecar', async () => {
  const { manager, spawned } = makeManager();
  const primary = await manager.appConnection();
  // Single-sidecar: the normalized id resolves to the one app sidecar, no 2nd spawn.
  const conn = await manager.appConnection('ace-session:alpha');
  expect(spawned).toHaveLength(1);
  expect(conn.profile).toBe('alpha');
  expect(conn.baseUrl).toBe(primary.baseUrl);
});

test('a Hermes code update under the running app sidecar respawns it on the next connection', async () => {
  let fp = 'sha-old';
  const { manager, spawned, events } = makeManager({ hermesCodeFingerprint: () => fp });
  await manager.ensure();
  expect(spawned).toHaveLength(1);

  await manager.appConnection();
  await manager.appConnection();
  expect(spawned).toHaveLength(1);

  fp = 'sha-new';
  const pending = manager.appConnection();
  expect(spawned[0].killedWith).toBe('SIGTERM');
  spawned[0].emitExit(0);
  const conn = await pending;
  expect(spawned).toHaveLength(2);
  expect(conn.token).toBe(spawned[1].opts.env.HERMES_DASHBOARD_SESSION_TOKEN);
  expect(JSON.stringify(events)).toContain('"type":"restarting"');

  await manager.appConnection();
  await manager.appConnection();
  expect(spawned).toHaveLength(2);
});

test('fingerprint drift never fires without evidence', async () => {
  const nullFp = makeManager();
  await nullFp.manager.ensure();
  await nullFp.manager.appConnection();
  await nullFp.manager.appConnection();
  expect(nullFp.spawned).toHaveLength(1);

  let fp = 'sha-old';
  const flaky = makeManager({ hermesCodeFingerprint: () => fp });
  await flaky.manager.ensure();
  fp = '';
  await flaky.manager.appConnection();
  expect(flaky.spawned).toHaveLength(1);
});

test('a drifted per-home dashboard respawns and the home claim never lapses', async () => {
  let fp = 'sha-old';
  const { manager, spawned } = makeManager({ hermesCodeFingerprint: () => fp });
  const first = await manager.ensure({ ownerKey: 'tsk-drift' });
  expect(first.ok).toBe(true);
  expect(manager.isHomeClaimed(first.home)).toBe(true);

  fp = 'sha-new';
  const pending = manager.ensure({ ownerKey: 'tsk-drift' });
  expect(spawned[0].killedWith).toBe('SIGTERM');
  expect(manager.isHomeClaimed(first.home)).toBe(true);
  spawned[0].emitExit(0);
  const second = await pending;
  expect(second.ok).toBe(true);
  expect(spawned).toHaveLength(2);
  expect(manager.isHomeClaimed(second.home)).toBe(true);
});
