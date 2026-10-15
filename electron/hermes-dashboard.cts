// Hermes Desktop surface: dashboard sidecar manager + surface preference.
//
// Ace can drive a per-HERMES_HOME `hermes dashboard --no-open` sidecar and
// embed its served SPA instead of the terminal lane. This module owns:
//
//   1. The surface preference file <userData>/hermes-surface.json — read with
//      the operators.cts main→bak→default fallback and written with its
//      atomic tmp+rename+.bak contract. An absent file means terminal lanes
//      (the default surface); load never creates the file.
//   2. The per-home claim ledger: at most ONE dashboard per resolved
//      HERMES_HOME, registered BEFORE spawn so PTY writers and the dashboard
//      can never race for the same state.db. A claim exists only while a
//      dashboard process is starting/running — NEVER because of the stored
//      preference — so lanes (including always-on personal operator
//      orchestrators) behave exactly as before until a dashboard actually
//      owns their home.
//
// Security contract (verified live against `hermes dashboard`): the server
// injects the per-spawn session token into the served SPA HTML, so the plain
// root URL is the credential. Dashboards therefore bind loopback-only with a
// fresh crypto.randomBytes(32) token per spawn, and the token/URL never
// appear in status(), events, or logs.
//
// Everything is factory-injected (spawn, fs, port allocation, home
// resolution) so the manager unit-tests with fakes and never hardcodes user
// paths — homes come from the injected resolver, the preference file derives
// from userDataPath (the external SSD root when active).

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
// `.cts` specifier: the compile plugin rewrites it to an external `.cjs`
// require instead of inlining a second copy into this bundle.
const hermesPaths = require('./hermes-paths.cts');
const {
  createSidecarLeaseLedger,
  defaultProcessAlive,
  defaultProcessIdentity,
  defaultTerminateProcess,
} = require('./hermes-sidecar-leases.cts');

const SURFACE_FILE = 'hermes-surface.json';
const SURFACE_BAK_FILE = 'hermes-surface.json.bak';
const HERMES_DESKTOP_APP_OWNER_KEY = 'hermes-desktop-app';
const HERMES_DESKTOP_APP_LEDGER_KEY = '__ace_hermes_desktop_app__';
const HERMES_DESKTOP_REMOTE_PATH = '/hermes-desktop/';
const DESKTOP_PROFILE_FILE = 'hermes-desktop-active-profile.json';
const SIDECAR_LEASE_FILE = 'sidecar-leases.json';
const EXTRACT_COMPLETE_MARKER = '.ace-extract-complete';
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Single-sidecar embed: EVERY profile routes to the one always-on
// app sidecar (re-rooted via setAppProfile), never a second pooled python
// process. Two processes sharing one state.db split the SPA's single gateway
// socket — the root of the sticky "session busy" desync. The old multi-profile
// pool (and its HERMES_DESKTOP_MULTI_PROFILE opt-out) has been removed.
//
// Self-heal is likewise unconditional: a crashed always-on sidecar re-arms one
// more attempt after a decaying backoff instead of dead-ending the tab.
// Crash-loop ceiling for the always-on Teams app sidecar: after this many
// restarts inside the rolling window it stops auto-restarting (status 'exited',
// emits 'error') instead of respawning the python backend forever. It comes
// back on the next manual ensure() (reopening Teams / Retry).
const ALWAYSON_RESTART_WINDOW_MS = 60_000;
const ALWAYSON_MAX_RESTARTS = 3;
const PROCESS_IDENTITY_CAPTURE_TIMEOUT_MS = 750;
const HERMES_TITLEBAR_HEIGHT = 34;
const HERMES_MACOS_TRAFFIC_LIGHTS_HEIGHT = 14;
const HERMES_WINDOW_BUTTON_POSITION = {
  x: 24,
  y: HERMES_TITLEBAR_HEIGHT / 2 - HERMES_MACOS_TRAFFIC_LIGHTS_HEIGHT / 2,
};
const HERMES_NATIVE_OVERLAY_BUTTON_WIDTH = 144;

// HERMES_HOME now lives under a symlinked ~/.hermes (migrated to the external
// SSD), so path.resolve() alone can leave two spellings of the same home
// (symlinked vs realpath) that would miss each other in the claim ledger.
// Resolve symlinks when the path exists; fall back to a plain resolve for
// not-yet-created homes. The PTY guard normalizes its input the same way so
// both sides of the per-home match agree.
function normalizeHomePath(homePath: any) {
  const resolved = path.resolve(String(homePath));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
const HERMES_SURFACES = ['lanes', 'dashboard'];
// The served dashboard page embeds the session token — only ever bind
// loopback. Anything else would publish the credential to the network.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
// Must equal HERMES_DESKTOP_APP_PARTITION in
// src/components/teams/hermes-dashboard-pane-logic.ts (a test asserts it).
const HERMES_DESKTOP_APP_PARTITION = 'persist:ace-browser-hermes-desktop-app';
const FORBIDDEN_DASHBOARD_EXTRA_ARGS = new Set([
  '--host',
  '--port',
  '--profile',
  '--no-open',
  '--token',
  '--auth',
  '--web-dist',
  '--session-token',
]);

function defaultSurfaceConfig() {
  return {
    version: 1,
    defaultSurface: 'lanes',
    workspaceOverrides: {},
    dashboard: {
      host: '127.0.0.1',
      extraArgs: [],
      desktopAppPath: null,
    },
  };
}

function unsafeDashboardExtraArg(arg: string) {
  if (arg === '--') return '-- is not allowed';
  const key = String(arg || '').split('=')[0];
  if (FORBIDDEN_DASHBOARD_EXTRA_ARGS.has(key)) return `${key} is managed by Ace`;
  if (/^(?:--.*token|--.*auth|--.*secret)$/i.test(key)) return `${key} is credential-related`;
  return null;
}

function safeDashboardExtraArgs(dashboard: any) {
  const args = Array.isArray(dashboard?.extraArgs)
    ? dashboard.extraArgs.filter((arg: any) => typeof arg === 'string')
    : [];
  const unsafe = args.map(unsafeDashboardExtraArg).find(Boolean);
  if (unsafe) throw new Error(`dashboard.extraArgs contains unsafe flag: ${unsafe}`);
  return args;
}

// Returns a list of problems; empty array means the config is valid.
function validateSurfaceConfig(value: any): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['config must be an object'];
  }
  if (value.version !== 1) problems.push('version must be 1');
  if (!HERMES_SURFACES.includes(value.defaultSurface)) {
    problems.push(`defaultSurface must be one of: ${HERMES_SURFACES.join(', ')}`);
  }
  const overrides = value.workspaceOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    problems.push('workspaceOverrides must be an object');
  } else {
    for (const [key, surface] of Object.entries(overrides)) {
      if (!HERMES_SURFACES.includes(surface as any)) {
        problems.push(`workspaceOverrides['${key}'] must be one of: ${HERMES_SURFACES.join(', ')}`);
      }
    }
  }
  const dashboard = value.dashboard;
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    problems.push('dashboard must be an object');
    return problems;
  }
  if (typeof dashboard.host !== 'string' || !LOOPBACK_HOSTS.has(dashboard.host)) {
    problems.push('dashboard.host must be a loopback host (127.0.0.1, ::1, or localhost)');
  }
  if (
    !Array.isArray(dashboard.extraArgs) ||
    dashboard.extraArgs.some((arg: any) => typeof arg !== 'string')
  ) {
    problems.push('dashboard.extraArgs must be an array of strings');
  } else {
    const unsafe = dashboard.extraArgs.map(unsafeDashboardExtraArg).find(Boolean);
    if (unsafe) problems.push(`dashboard.extraArgs contains unsafe flag: ${unsafe}`);
  }
  if (dashboard.desktopAppPath !== null && typeof dashboard.desktopAppPath !== 'string') {
    problems.push('dashboard.desktopAppPath must be a string or null');
  }
  return problems;
}

function readSurfaceFile(filePath: string, fsImpl: any) {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (validateSurfaceConfig(parsed).length > 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

// READ-ONLY: an absent (or unreadable) file always resolves to the lanes
// default and is never pre-created — loading the preference can never flip
// an install into dashboard mode on its own.
function loadSurfaceConfig(userDataPath: string, fsImpl: any = fs) {
  const main = readSurfaceFile(path.join(userDataPath, SURFACE_FILE), fsImpl);
  if (main) return main;
  const bak = readSurfaceFile(path.join(userDataPath, SURFACE_BAK_FILE), fsImpl);
  if (bak) return bak;
  return defaultSurfaceConfig();
}

// Atomic write contract (operators.cts saveOperatorsConfig): back up the
// current file only when it is parseable JSON, then tmp + rename so a crash
// mid-write can never leave a torn preference that gates process control.
function saveSurfaceConfig(userDataPath: string, config: any, fsImpl: any = fs) {
  const problems = validateSurfaceConfig(config);
  if (problems.length > 0) {
    throw new Error(`refusing to save invalid hermes surface config: ${problems.join('; ')}`);
  }
  const filePath = path.join(userDataPath, SURFACE_FILE);
  try {
    if (fsImpl.existsSync(filePath)) {
      JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      fsImpl.copyFileSync(filePath, path.join(userDataPath, SURFACE_BAK_FILE));
    }
  } catch {
    // Current file unparseable: leave any existing .bak alone.
  }
  const tmpPath = path.join(
    userDataPath,
    `${SURFACE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    fsImpl.mkdirSync(userDataPath, { recursive: true });
    fsImpl.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fsImpl.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

// Ephemeral loopback port: bind 0, read the kernel-assigned port, release.
function allocateLoopbackPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('failed to allocate a loopback port'));
      });
    });
  });
}

function formatDashboardHost(host: string) {
  return host.includes(':') ? `[${host}]` : host;
}

// Case-insensitive: Windows env names are, but baseEnv() is a case-SENSITIVE
// spread copy, so an exact-key delete would miss `Hermes_Desktop`.
function deleteEnvVar(env: any, name: string) {
  const target = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === target) delete env[key];
  }
}

// Collapses every case variant to ONE canonical key, keeping the first NON-EMPTY
// value. Empty counts as unset (the gateway reads empty as absent).
function setEnvVarCanonical(env: any, name: string, fallback: any) {
  const target = name.toUpperCase();
  let override;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== target) continue;
    if (override === undefined && env[key]) override = env[key];
    delete env[key];
  }
  const value = override === undefined ? fallback : override;
  if (value !== undefined) env[target] = value;
  return value;
}

// Platform-aware; see hermes-paths.cts.
function defaultGlobalHermesHome(fsImpl: any = fs) {
  return hermesPaths.globalHermesHome({ fsImpl });
}

// Names the locations actually searched on THIS platform.
function missingHermesCliMessage(home: any = null, fsImpl: any = fs) {
  const resolved = String(home || hermesPaths.globalHermesHome({ fsImpl }));
  const searched = hermesPaths.hermesCliSearchDirs({ home: resolved, fsImpl }).join(', ');
  return (
    'Hermes CLI not found. Searched your PATH and ' + searched + '. ' +
    'Install Hermes (Settings → Agents → Hermes Agent shows the install command for this platform), ' +
    'or set HERMES_HOME if it is installed somewhere else.'
  );
}

function asPath(value: any) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file:')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return '';
    }
  }
  return raw;
}

// `platform` is injectable so the non-darwin layout is testable from macOS.
function resourcePathsForDesktopApp(appPath: string, platform: any = process.platform) {
  const appRoot = asPath(appPath);
  const resourcesRoot =
    platform === 'darwin'
      ? path.join(appRoot, 'Contents', 'Resources')
      : path.join(appRoot, 'resources');
  const asarPath = path.join(resourcesRoot, 'app.asar');
  return {
    appPath: appRoot,
    asarPath,
    indexPath: path.join(asarPath, 'dist', 'index.html'),
    preloadPath: path.join(asarPath, 'electron', 'preload.cjs'),
    packagePath: path.join(asarPath, 'package.json'),
  };
}

function readDesktopAppVersion(packagePath: string, fsImpl: any = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(packagePath, 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function realPathOrResolve(value: string, fsImpl: any = fs) {
  try {
    const realpath = fsImpl.realpathSync?.native || fsImpl.realpathSync;
    if (typeof realpath === 'function') return realpath.call(fsImpl.realpathSync, value);
  } catch {}
  return path.resolve(value);
}

function isManagedHermesEmbedPath(candidate: string, home: string, fsImpl: any = fs) {
  if (!candidate || !home) return false;
  try {
    // ~/.hermes commonly symlinks to the external SSD home. Resolve both sides
    // physically so a persisted ~/.hermes/hermes-embed/... snapshot is still
    // recognized when globalHome() returns /Volumes/.../.hermes.
    const embedRoot = realPathOrResolve(path.join(home, 'hermes-embed'), fsImpl);
    const resolved = realPathOrResolve(candidate, fsImpl);
    const relative = path.relative(embedRoot, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

// One list shared by resolution and the not-found warning, so they cannot drift.
function desktopAppCandidates(config: any, fsImpl: any, home: string, target: any = {}) {
  const configured = asPath(config?.dashboard?.desktopAppPath);
  // A LIST, and not `.app` paths: only macOS wraps builds in a bundle, and x64
  // macOS lives in `mac`. See hermes-paths.cts.
  const sourceBuilt = hermesPaths.hermesDesktopSourceRoots({ home, fsImpl, ...target });
  // Ace-managed embed copies are immutable snapshots named for the Hermes
  // commit that produced them. Once a newer source-built release exists under
  // the live Hermes home, an old persisted embed path must not pin every future
  // launch to that stale renderer. Arbitrary user-configured app paths remain
  // first so an intentional standalone/custom override still wins.
  const configuredIsManagedSnapshot = isManagedHermesEmbedPath(configured, home, fsImpl);
  const configuredFirst = configured && !configuredIsManagedSnapshot ? [configured] : [];
  const configuredAfterSource = configured && configuredIsManagedSnapshot ? [configured] : [];
  return [
    ...configuredFirst,
    ...sourceBuilt,
    ...configuredAfterSource,
    ...hermesPaths.hermesDesktopInstalledRoots({ home, fsImpl, ...target }),
  ].filter(Boolean);
}

function resolveHermesDesktopApp(
  config: any = null,
  fsImpl: any = fs,
  globalHome: any = defaultGlobalHermesHome,
  // Test-only seam (see resourcePathsForDesktopApp); production always passes
  // through the real process values.
  target: any = {}
) {
  const platform = target.platform || process.platform;
  const home = String(typeof globalHome === 'function' ? globalHome() : defaultGlobalHermesHome(fsImpl));
  const candidates = desktopAppCandidates(config, fsImpl, home, target);

  for (const candidate of candidates) {
    const paths = resourcePathsForDesktopApp(candidate, platform);
    try {
      if (!fsImpl.existsSync(paths.indexPath) || !fsImpl.existsSync(paths.preloadPath)) {
        continue;
      }
      return {
        ...paths,
        rendererUrl: `${pathToFileURL(paths.indexPath).toString()}#/`,
        preloadUrl: pathToFileURL(paths.preloadPath).toString(),
        version: readDesktopAppVersion(paths.packagePath, fsImpl),
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Port-agnostic (each respawn allocates a fresh one). Callers MUST also confirm
// the Hermes partition, or a browser tab on localhost would match.
function isLoopbackHttpUrl(value: any) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // URL.hostname keeps IPv6 brackets ('[::1]'), which formatDashboardHost emits.
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function safeParseUrl(value: any) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

// Electron 37+ carries event params on the event object; the positional args
// remain (deprecated). Read whichever this runtime actually supplies.
function resolveIsMainFrame(event: any, positional: any) {
  if (typeof positional === 'boolean') return positional;
  if (event && typeof event.isMainFrame === 'boolean') return event.isMainFrame;
  return true;
}

// Divert a guest navigation into Ace's browser pane only when it is a main-frame,
// cross-origin http(s) target. Subframes stay untouched (cancelling an iframe
// redirect breaks embedded content); same-origin is the guest's own routing.
function shouldDivertHermesGuestNavigation(options: any = {}) {
  const { url, guestUrl, isMainFrame } = options;
  if (isMainFrame === false) return false;
  const target = safeParseUrl(url);
  if (!target) return false;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const guest = safeParseUrl(guestUrl);
  if (guest && target.origin !== 'null' && target.origin === guest.origin) return false;
  return true;
}

function normalizePossiblyFileUrl(value: any) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file:')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return '';
    }
  }
  return raw;
}

function normalizeTrustedResourcePath(value: any) {
  const resolved = normalizePossiblyFileUrl(value);
  return resolved ? path.normalize(path.resolve(resolved)) : '';
}

function trustedHermesDesktopApp(options: any = {}) {
  const fsImpl = options.fsImpl || fs;
  const config =
    options.config ||
    (options.userDataPath ? loadSurfaceConfig(options.userDataPath, fsImpl) : null);
  return resolveHermesDesktopApp(config, fsImpl, options.globalHermesHome || defaultGlobalHermesHome);
}

function isTrustedHermesDesktopResource(value: any, kind: 'index' | 'preload', options: any = {}) {
  const resolved = normalizeTrustedResourcePath(value);
  if (!resolved) return false;
  const desktopApp = trustedHermesDesktopApp(options);
  if (!desktopApp) return false;
  const expected = normalizeTrustedResourcePath(kind === 'index' ? desktopApp.indexPath : desktopApp.preloadPath);
  if (resolved !== expected) return false;
  try {
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function isTrustedHermesDesktopWebview(params: any = {}, webPreferences: any = {}, options: any = {}) {
  const src = params.src || params.srcURL || params.url;
  const preload = webPreferences.preloadURL || webPreferences.preload || params.preload;
  return isTrustedHermesDesktopResource(src, 'index', options) && isTrustedHermesDesktopResource(preload, 'preload', options);
}

function sendHermesDesktopOpenLink(hostWebContents: any, value: any) {
  let normalized = '';
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    normalized = parsed.toString();
  } catch {
    return false;
  }
  if (!hostWebContents || typeof hostWebContents.send !== 'function') return false;
  try {
    hostWebContents.send('ace:hermes-desktop-event', { type: 'open-link', url: normalized });
    return true;
  } catch {
    return false;
  }
}

function embeddedHermesWindowState() {
  return {
    isFullscreen: false,
    nativeOverlayWidth: process.platform === 'darwin' ? 0 : HERMES_NATIVE_OVERLAY_BUTTON_WIDTH,
    windowButtonPosition: process.platform === 'darwin' ? HERMES_WINDOW_BUTTON_POSITION : null,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeDashboard(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res: any) => {
      res.resume();
      // Readiness probes hit /api/status (the unauthenticated liveness
      // endpoint) and must see a real 200. The old 200-499 window declared
      // a sidecar "ready" even when it answered 404 on every route.
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForDashboardReady(url: string, options: any = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  const intervalMs = options.intervalMs ?? 500;
  while (Date.now() <= deadline) {
    if (await probeDashboard(url, options.probeTimeoutMs ?? 1000)) return;
    await wait(intervalMs);
  }
  throw new Error('hermes dashboard did not become ready');
}

// One dashboard sidecar per resolved HERMES_HOME. All mutations run on the
// main-process event loop; the claim (a map entry whose status is not
// 'exited') is registered synchronously in ensure() before any await, so a
// concurrent PTY spawn or second ensure() can never slip past it.
function createHermesDashboardManager({
  userDataPath,
  ensureHermesHome,
  whichHermes,
  emit,
  hermesCodeFingerprint = () => null,
  baseEnv = () => process.env,
  spawnImpl = spawn,
  fsImpl = fs,
  allocatePort = allocateLoopbackPort,
  // Injected stop-then-claim hook: kills any LIVE hermes PTY already writing
  // the resolved home. Runs after the claim lands in the ledger (so no new
  // writer can race in) and before the dashboard spawns — the two writers
  // never coexist on one state.db.
  stopHermesPtyForHome = null,
  waitForReady = waitForDashboardReady,
  globalHermesHome = () => defaultGlobalHermesHome(fsImpl),
  // Injected Ace CLI transport env (ACE_SOCK + auth-backed
  // ACE_URL/ACE_TOKEN when remote access is enabled) for the
  // dashboard sidecars, mirroring the PTY lane spawns. baseEnv() is
  // sanitizeAgentSpawnEnv-scrubbed, which strips every ACE_* var, so
  // without this explicit re-injection the embedded operator agents have
  // no transport for the ace CLI: their exec sandbox denies AF_UNIX
  // (EPERM on the socket) and they never see the loopback HTTP fallback.
  // Computed per spawn so settings changes (remote enable/disable, token
  // rotation) take effect on the next sidecar start.
  aceTransportEnv = () => ({}),
  // Injected, generic profile→home resolver. Given a Hermes profile name it
  // returns that identity's REAL per-identity HERMES_HOME *only* when the
  // operator config supplies an explicit home (OperatorProfile.hermesHome);
  // it returns null for every other profile (default/new users, unconfigured
  // names). The wiring lives in local-core (operators config + db) so this
  // module never hardcodes identities or paths. When the resolver yields a
  // home, the backend uses it directly as HERMES_HOME with NO `--profile`, so
  // it opens the identity's populated state.db instead of an empty re-root.
  resolveProfileHome = null,
  // Cross-process ownership. The in-memory claim map prevents duplicates only
  // inside one Electron main process; these seams let startup reap a child
  // orphaned by a crashed/replaced Ace process before another dashboard opens
  // the same state.db.
  parentPid = process.pid,
  processAlive = defaultProcessAlive,
  processIdentity = defaultProcessIdentity,
  terminateProcess = defaultTerminateProcess,
}: any) {
  // resolved HERMES_HOME -> dashboard entry. Exited entries stay for
  // status() visibility (error + manual-restart affordance) but hold no claim.
  const dashboards = new Map();
  // Single-sidecar: nothing populates this anymore (the multi-profile pool was
  // removed). Retained because monitoringSnapshot() still reports pool rows
  // (empty now) and setAppProfile defensively clears any entry for the promoted
  // lane — both stay correct against an always-empty map.
  const profileBackends = new Map();
  // Extracted web-dist cache dirs handed to ANY sidecar this process spawned.
  // The prune in extractedHermesWebDist must never delete one of these: a
  // live backend keeps serving its dist long after a Hermes.app update lands
  // on disk, and deleting it 404s that backend's lazy-loaded chunks. Stale
  // dirs are reaped on the next app launch instead (fresh, empty set).
  const servedWebDists = new Set();
  let profileIdleReaper: any = null;
  const sidecarLeasePath = path.join(userDataPath, 'hermes-desktop-sidecar', SIDECAR_LEASE_FILE);
  const sidecarLeases = createSidecarLeaseLedger({
    filePath: sidecarLeasePath,
    parentPid,
    fsImpl,
    processAlive,
    processIdentity,
    terminateProcess,
  });

  function recordSidecarLease(entry: any, effectiveHome: any) {
    return sidecarLeases.record({
      key: entry.key,
      childPid: entry.pid,
      childIdentity: entry.processIdentity,
      kind: entry.kind,
      home: normalizeHomePath(effectiveHome),
      host: entry.host,
      port: entry.port,
      startedAt: entry.startedAt,
    });
  }

  function clearSidecarLease(
    entry: any,
    childPid: any = null,
    childIdentity: any = entry.processIdentity ?? null
  ) {
    return sidecarLeases.clear({
      key: entry.key,
      childPid,
      childIdentity: childPid == null ? null : childIdentity,
    });
  }

  function reclaimPersistedSidecar(entry: any) {
    return sidecarLeases.reserve({
      key: entry.key,
      kind: entry.kind,
      home: entry.home ? normalizeHomePath(entry.home) : null,
    });
  }

  async function captureSpawnedProcessIdentity(pid: any, stillOwned: any) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
    const deadline = Date.now() + PROCESS_IDENTITY_CAPTURE_TIMEOUT_MS;
    while (true) {
      if (typeof stillOwned === 'function' && !stillOwned()) return null;
      let identity = null;
      try { identity = processIdentity(numericPid); } catch {}
      if (identity) return identity;
      if (!processAlive(numericPid) || Date.now() >= deadline) return null;
      await wait(25);
    }
  }

  function isHomeClaimed(homePath: any) {
    if (!homePath) return false;
    const entry = dashboards.get(normalizeHomePath(homePath));
    return !!entry && entry.status !== 'exited';
  }

  function describeEntry(entry: any) {
    return {
      ownerKey: entry.ownerKey,
      home: entry.home ?? null,
      kind: entry.kind ?? 'home',
      remotePath: entry.remotePath ?? null,
      host: entry.host ?? null,
      port: entry.port ?? null,
      pid: entry.pid ?? null,
      status: entry.status,
      startedAt: entry.startedAt ?? null,
      restarts: entry.restarts,
      lastExit: entry.lastExit ?? null,
      error: entry.error ?? null,
    };
  }

  function status() {
    const config = loadSurfaceConfig(userDataPath, fsImpl);
    return {
      surface: config.defaultSurface,
      config,
      dashboards: [...dashboards.values()].map(describeEntry),
    };
  }

  // Sanitized in-memory snapshot for the Operations "Hermes Monitoring"
  // panel: managed dashboards + pooled profile backends as plain rows. Same
  // security contract as status()/describeEntry — NEVER the token or any URL.
  function monitoringSnapshot() {
    const now = Date.now();
    const rows: any[] = [];
    for (const entry of dashboards.values()) {
      rows.push({
        kind: entry.kind ?? 'home',
        ownerKey: entry.ownerKey ?? null,
        profile: entry.profile ?? null,
        port: entry.port ?? null,
        pid: entry.pid ?? null,
        status: entry.status,
        startedAt: entry.startedAt ?? null,
        uptimeMs:
          entry.status === 'running' && entry.startedAt ? now - entry.startedAt : null,
        restarts: entry.restarts ?? 0,
      });
    }
    for (const [profile, entry] of profileBackends.entries()) {
      rows.push({
        kind: 'profile-pool',
        ownerKey: null,
        profile,
        port: entry.port ?? null,
        pid: entry.pid ?? null,
        status: entry.pid ? 'running' : 'starting',
        startedAt: entry.startedAt ?? null,
        uptimeMs: entry.pid && entry.startedAt ? now - entry.startedAt : null,
        restarts: 0,
      });
    }
    return rows;
  }

  function emitEvent(type: string, entry: any = null) {
    if (typeof emit !== 'function') return;
    try {
      emit({ type, ...(entry ? describeEntry(entry) : {}) });
    } catch {
      // A renderer push failure must never break dashboard lifecycle.
    }
  }

  function finishStoppedEntry(entry: any) {
    if (entry.stopKillTimer) {
      try { clearTimeout(entry.stopKillTimer); } catch {}
      entry.stopKillTimer = null;
    }
    void clearSidecarLease(entry, entry.pid, entry.processIdentity).catch((err: any) => {
      console.warn('[ace] failed to clear Hermes dashboard lease:', err?.message || err);
    });
    entry.proc = null;
    entry.pid = null;
    entry.processIdentity = null;
    entry.status = 'exited';
    entry.host = null;
    entry.port = null;
    entry.baseUrl = null;
    entry.wsUrl = null;
    entry.token = null;
    dashboards.delete(entry.key ?? entry.home);
    emitEvent('stopped', entry);
    if (entry.resolveStopped) {
      try { entry.resolveStopped({ ok: true, stopped: true }); } catch {}
      entry.resolveStopped = null;
      entry.stopped = null;
    }
  }

  function cleanProfileName(name: any) {
    return (typeof name === 'string' ? name.trim() : '').replace(/^ace-session:/i, '');
  }

  function readActiveDesktopProfile() {
    try {
      const raw = fsImpl.readFileSync(path.join(userDataPath, DESKTOP_PROFILE_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      const name = cleanProfileName(parsed?.profile);
      if (name && (name === 'default' || PROFILE_NAME_RE.test(name))) return name;
    } catch {
      // Missing or malformed means no explicit desktop profile preference.
    }
    return null;
  }

  function writeActiveDesktopProfile(name: any) {
    const value = cleanProfileName(name);
    if (value && value !== 'default' && !PROFILE_NAME_RE.test(value)) {
      throw new Error(`invalid Hermes profile name: ${value}`);
    }
    const next = value || null;
    fsImpl.mkdirSync(userDataPath, { recursive: true });
    fsImpl.writeFileSync(
      path.join(userDataPath, DESKTOP_PROFILE_FILE),
      JSON.stringify({ profile: next }, null, 2) + '\n'
    );
    return next;
  }

  function normalizeProfileName(name: any) {
    const value = cleanProfileName(name);
    if (!value || value === 'default') return null;
    if (!PROFILE_NAME_RE.test(value)) {
      throw new Error(`invalid Hermes profile name: ${value}`);
    }
    return value;
  }

  function stopProfileBackend(profile: any) {
    const key = normalizeProfileName(profile);
    if (!key) return;
    const entry = profileBackends.get(key);
    if (!entry) return;
    profileBackends.delete(key);
    if (entry.proc && !entry.proc.killed) {
      try { entry.proc.kill('SIGTERM'); } catch {}
    }
  }

  function stopAllProfileBackends() {
    for (const profile of [...profileBackends.keys()]) stopProfileBackend(profile);
    if (profileIdleReaper) {
      try { clearInterval(profileIdleReaper); } catch {}
      profileIdleReaper = null;
    }
  }

  function touchProfileBackend(profile: any) {
    const key = normalizeProfileName(profile);
    if (!key) return false;
    const entry = profileBackends.get(key);
    if (!entry) return false;
    entry.lastActiveAt = Date.now();
    return true;
  }

  // Single source of truth for the embedded Hermes desktop bundle and its
  // served web dist. Both the per-profile backend and the always-on app
  // sidecar route through here so HERMES_WEB_DIST can never drift between them
  // (a divergence would serve a stale/404 SPA from one path but not the
  // other).
  //
  // OPTIONAL and not platform-gated: a null return means "serve the sidecar's
  // own web UI". The one-shot warning keeps a missing bundle visible.
  let warnedMissingDesktopApp = false;
  function optionalDesktopApp() {
    const config = loadSurfaceConfig(userDataPath, fsImpl);
    const desktopApp = resolveHermesDesktopApp(config, fsImpl, globalHermesHome);
    if (!desktopApp && !warnedMissingDesktopApp) {
      warnedMissingDesktopApp = true;
      const searched = desktopAppCandidates(config, fsImpl, String(globalHermesHome()));
      console.warn(
        '[ace] Hermes desktop bundle not found; serving the sidecar web UI instead. Searched: ' +
          searched.join(', ')
      );
    }
    return desktopApp;
  }

  function hermesWebDist(desktopApp: any) {
    // The sidecar is Python and cannot read inside app.asar; Electron's own
    // fs IS asar-aware, so a naive existsSync check would happily bless an
    // asar-internal path that 404s every non-API route on the sidecar
    // ("Frontend not built"). Invisible on desktop — the webview loads the
    // SPA from file:// — but fatal for the remote/mobile proxy, which serves
    // the SPA through the sidecar. Only hand over a dist the sidecar can
    // actually read: an already-unpacked dist as-is, an asar-packed dist via
    // extraction to a plain cache directory. Otherwise return null so the
    // spawn omits the override and the sidecar serves its built-in browser
    // UI — which is the degraded "web UI instead of the desktop app" mobile
    // Teams surface, so this is strictly a last resort.
    const asarPath = String(desktopApp?.asarPath || '');
    if (!asarPath) return null;
    const candidates = /\.asar$/i.test(asarPath)
      ? [path.join(`${asarPath}.unpacked`, 'dist')]
      : [path.join(asarPath, 'dist')];
    for (const dir of candidates) {
      try {
        if (fsImpl.statSync(dir).isDirectory()) return dir;
      } catch {
        // Candidate missing — fall through.
      }
    }
    return extractedHermesWebDist(desktopApp);
  }

  function copyDistTreeSync(src: string, dest: string) {
    fsImpl.mkdirSync(dest, { recursive: true });
    for (const name of fsImpl.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      // lstat, never stat: a symlink in the source tree (asar archives can
      // carry links) must not be followed — an absolute or cyclic link would
      // copy foreign content into the sidecar-served cache or recurse
      // forever. A Vite dist is plain files+dirs; skip anything else.
      const entry = fsImpl.lstatSync(from);
      if (entry.isDirectory()) copyDistTreeSync(from, to);
      else if (entry.isFile()) fsImpl.writeFileSync(to, fsImpl.readFileSync(from));
    }
  }

  // One live build per install: stale extractions of replaced Hermes.app
  // versions (and orphaned .tmp-* dirs from a crashed copy) are dead weight,
  // prune them — EXCEPT dirs a backend spawned by this process is still
  // serving (see servedWebDists).
  function pruneStaleWebDists(cacheRoot: string, keepName: string) {
    let names;
    try {
      names = fsImpl.readdirSync(cacheRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keepName) continue;
      if (servedWebDists.has(path.join(cacheRoot, name))) continue;
      try { fsImpl.rmSync(path.join(cacheRoot, name), { recursive: true, force: true }); } catch {}
    }
  }

  // Packaged Hermes.app builds ship the SPA inside app.asar with no
  // .unpacked copy. Electron's fs reads through the archive, so copy the
  // dist out to a plain directory under userData that the Python sidecar can
  // serve — that is what puts the real desktop SPA (not the sidecar's
  // built-in browser UI) on the remote/mobile Teams surface. Cached per
  // desktop-app build: the fingerprint is version + index.html content hash,
  // NOT the archive's stat — Electron's asar-faked stat reports size 0 and
  // mtime "now" on every call, which would churn the cache (and prune a dist
  // a live sidecar is still serving) on every spawn. index.html embeds the
  // hashed asset names, so any rebuilt SPA changes the hash. A marker file
  // gates reuse so a half-written copy is never served. Any failure returns
  // null and the spawn falls back to the built-in UI exactly as before.
  function extractedHermesWebDist(desktopApp: any) {
    try {
      const asarPath = String(desktopApp?.asarPath || '');
      const srcDist = path.join(asarPath, 'dist');
      if (!fsImpl.statSync(srcDist).isDirectory()) return null;
      const indexHash = crypto
        .createHash('sha256')
        .update(fsImpl.readFileSync(path.join(srcDist, 'index.html')))
        .digest('hex')
        .slice(0, 16);
      const fingerprint = [String(desktopApp?.version || '0'), indexHash]
        .join('-')
        .replace(/[^A-Za-z0-9.-]/g, '_');
      const cacheRoot = path.join(userDataPath, 'hermes-desktop-sidecar', 'web-dist');
      const target = path.join(cacheRoot, fingerprint);
      const marker = path.join(target, EXTRACT_COMPLETE_MARKER);
      if (fsImpl.existsSync(marker)) {
        servedWebDists.add(target);
        // Reuse still prunes: a relaunch lands here (the marker survived),
        // and this is exactly when the dists the PREVIOUS process protected
        // become reapable.
        pruneStaleWebDists(cacheRoot, fingerprint);
        return target;
      }
      const tmp = path.join(cacheRoot, `.tmp-${process.pid}-${fingerprint}`);
      fsImpl.rmSync(tmp, { recursive: true, force: true });
      copyDistTreeSync(srcDist, tmp);
      fsImpl.writeFileSync(path.join(tmp, EXTRACT_COMPLETE_MARKER), '');
      fsImpl.rmSync(target, { recursive: true, force: true });
      fsImpl.renameSync(tmp, target);
      servedWebDists.add(target);
      pruneStaleWebDists(cacheRoot, fingerprint);
      return target;
    } catch (err: any) {
      console.warn('[ace] hermes desktop web dist extraction failed:', err?.message || err);
      return null;
    }
  }

  // Best-effort append log inside the per-home logs/ dir (a LOCAL_ONLY_DIRS
  // location, so it lands on the SSD with the rest of the home). Never the
  // URL or token — the log carries only process stdout/stderr.
  function openDashboardLog(home: string) {
    try {
      const logsDir = path.join(home, 'logs');
      fsImpl.mkdirSync(logsDir, { recursive: true });
      return fsImpl.createWriteStream(path.join(logsDir, 'dashboard.log'), { flags: 'a' });
    } catch {
      return null;
    }
  }

  async function startEntry(entry: any) {
    let ownedProc: any = null;
    let ownedProcessIdentity: string | null = null;
    try {
      await reclaimPersistedSidecar(entry);
      if (entry.stopRequested) throw new Error('dashboard stopped before spawn');
      const desktopApp = entry.kind === 'app' ? optionalDesktopApp() : null;
      const bin = whichHermes();
      // The CLI is the only hard precondition; a missing bundle is not.
      if (!bin) throw new Error(missingHermesCliMessage(globalHermesHome(), fsImpl));
      const config = loadSurfaceConfig(userDataPath, fsImpl);
      const configuredHost = config.dashboard?.host;
      // Defense in depth: even a hand-edited config never binds off-loopback.
      const host = LOOPBACK_HOSTS.has(configuredHost) ? configuredHost : '127.0.0.1';
      const port = await allocatePort(host);
      if (entry.stopRequested) throw new Error('dashboard stopped before spawn');
      const token = crypto.randomBytes(32).toString('base64url');
      const extraArgs = safeDashboardExtraArgs(config.dashboard);
      const logStream = openDashboardLog(entry.logHome || entry.home || path.join(userDataPath, 'hermes-desktop-sidecar'));
      const env = {
        ...baseEnv(),
        ...aceTransportEnv(),
        HERMES_DASHBOARD_SESSION_TOKEN: token,
      };
      if (entry.kind === 'app') {
        // HERMES_DESKTOP=1 on BOTH paths: it starts the sidecar's cron ticker
        // and suppresses the CLI's Windows profile reroute. HERMES_WEB_DIST names
        // a dist inside the bundle, so without one it must be absent. Scrubbed
        // first so an ambient value never rides in from baseEnv().
        deleteEnvVar(env, 'HERMES_DESKTOP');
        deleteEnvVar(env, 'HERMES_WEB_DIST');
        env.HERMES_DESKTOP = '1';
        if (desktopApp) {
          const webDist = hermesWebDist(desktopApp);
          if (webDist) env.HERMES_WEB_DIST = webDist;
        }
        // Keep an idle (between-turns) embed session alive when the phone sleeps
        // or backgrounds the PWA: a 30-min orphan-reap grace replaces the gateway's
        // 20s default, so returning to Teams resumes the same session instead of a
        // fresh empty one. A non-empty operator override still wins.
        setEnvVarCanonical(env, 'HERMES_TUI_WS_ORPHAN_REAP_GRACE_S', '1800');
      }
      // The always-on app sidecar follows the same identity-home seam as the
      // per-profile backend: when an active desktop profile is set, ask the
      // resolver for that identity's real HERMES_HOME. If it returns one, point
      // HERMES_HOME there and DROP `--profile` (the CLI's `--profile` re-roots
      // to $HERMES_HOME/profiles/<name>/, an empty state.db — the empty-chat
      // bug). When it returns null the legacy `--profile`+global path is kept
      // byte-identically, so default/new users and CLI-only configured homes
      // are unchanged.
      const activeProfile = entry.kind === 'app' ? readActiveDesktopProfile() : null;
      let identityHome: string | null = null;
      if (activeProfile && typeof resolveProfileHome === 'function') {
        try {
          identityHome = resolveProfileHome(activeProfile) || null;
        } catch (err: any) {
          console.warn(`[ace] hermes profile home resolution failed for '${activeProfile}':`, err?.message || err);
          identityHome = null;
        }
      }
      if (entry.home) {
        env.HERMES_HOME = entry.home;
      } else if (identityHome) {
        // Resolved identity home: open the real per-identity state.db directly.
        env.HERMES_HOME = identityHome;
      } else {
        // The embedded Teams app must be the real global Hermes dashboard so
        // named non-primary profiles appear. A lane-scoped HERMES_HOME
        // would collapse that surface to a single isolated default profile.
        env.HERMES_HOME = globalHermesHome();
      }
      // Record whether this sidecar is rooted at an identity home (so it serves
      // only the 'default' profile) vs a real named --profile. appConnection
      // exposes the resulting backend profile name so the embed transport can
      // alias the SPA's operator id ('<op>') → 'default' on profile-scoped APIs.
      entry.identityHome = entry.kind === 'app' ? identityHome : null;
      entry.activeProfileName = activeProfile;
      const dashboardArgs = ['dashboard', ...extraArgs, '--no-open', '--host', host, '--port', String(port)];
      if (activeProfile && !identityHome) dashboardArgs.unshift('--profile', activeProfile);
      const proc = spawnImpl(
        bin,
        dashboardArgs,
        {
          env,
          // Never inherit Ace's own cwd ('/' when GUI-launched): the
          // agent's codex sandbox roots its workspace at the backend's cwd,
          // and sessions created without an explicit workspace fall back
          // to it.
          cwd: os.homedir(),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      ownedProc = proc;
      entry.host = host;
      entry.port = port;
      entry.proc = proc;
      entry.pid = proc.pid ?? null;
      entry.status = 'starting';
      entry.startedAt = Date.now();
      entry.error = null;
      entry.baseUrl = `http://${formatDashboardHost(host)}:${port}`;
      entry.wsUrl = `ws://${formatDashboardHost(host)}:${port}/api/ws?token=${encodeURIComponent(token)}`;
      entry.token = token;
      entry.desktopApp = desktopApp;
      entry.profile = activeProfile;
      // Snapshot of the on-disk hermes code at spawn time, mirroring the PTY
      // stream stamp, so drift tooling can flag `hermes update` under a
      // running dashboard.
      entry.hermesCodeFingerprint = hermesCodeFingerprint();
      // Register child events before the first post-spawn await. A very short-
      // lived process must not disappear while identity capture is waiting for
      // the OS process table to publish its creation metadata.
      proc.stdout?.on('data', (chunk: any) => { try { logStream?.write(chunk); } catch {} });
      proc.stderr?.on('data', (chunk: any) => { try { logStream?.write(chunk); } catch {} });
      proc.on('error', (err: any) => {
        try { logStream?.end(); } catch {}
        handleProcExit(entry, proc, -1, err);
      });
      proc.on('exit', (code: any) => {
        try { logStream?.end(); } catch {}
        handleProcExit(entry, proc, code, null);
      });
      ownedProcessIdentity = await captureSpawnedProcessIdentity(
        entry.pid,
        () => entry.proc === proc
      );
      if (entry.proc !== proc) {
        throw new Error('Hermes dashboard exited before its process identity was captured');
      }
      if (!ownedProcessIdentity) {
        throw new Error(`could not capture Hermes dashboard process identity for ${entry.pid}`);
      }
      entry.processIdentity = ownedProcessIdentity;
      // Persist ownership before readiness probing. If Ace dies anywhere after
      // spawn, the next main process can identify and reap this exact child;
      // no dashboard credential is written to disk.
      const leaseRecord = recordSidecarLease(entry, env.HERMES_HOME);
      await leaseRecord;
      if (entry.proc !== ownedProc) {
        throw new Error('Hermes dashboard exited before its ownership lease was recorded');
      }
      // The served page embeds the session token, so this URL is the
      // credential: it goes only to the requesting caller over IPC and must
      // never be logged or included in status()/events. Readiness is probed
      // against the unauthenticated /api/status liveness endpoint instead.
      const url = `${entry.baseUrl}/`;
      await waitForReady(`${entry.baseUrl}/api/status`, entry);
      if (entry.proc !== ownedProc || entry.stopRequested) {
        throw new Error('Hermes dashboard was replaced before it became ready');
      }
      entry.status = 'running';
      emitEvent('started', entry);
      startLivenessProbe(entry);
      if (entry.kind === 'app') {
        return {
          ok: true,
          // Bundle: packaged SPA over file://. No bundle: the served web UI.
          url: desktopApp ? desktopApp.rendererUrl : url,
          surface: desktopApp ? 'desktop' : 'web',
          dashboardUrl: url,
          baseUrl: entry.baseUrl,
          wsUrl: entry.wsUrl,
          token,
          authMode: 'token',
          mode: 'local',
          source: 'local',
          // The sidecar is rooted at the active desktop profile — say so, so
          // the SPA registers its primary gateway under the right profile key
          // instead of 'default'.
          profile: entry.profile ?? undefined,
          remotePath: entry.remotePath ?? null,
          preloadPath: desktopApp?.preloadPath ?? null,
          preloadUrl: desktopApp?.preloadUrl ?? null,
          desktopAppPath: desktopApp?.appPath ?? null,
          desktopAppVersion: desktopApp?.version ?? null,
          host,
          port,
          home: entry.home ?? null,
          ownerKey: entry.ownerKey,
        };
      }
      return {
        ok: true,
        url,
        remotePath: entry.remotePath ?? null,
        host,
        port,
        home: entry.home ?? null,
        ownerKey: entry.ownerKey,
      };
    } catch (err) {
      const proc = ownedProc;
      const stillOwned = entry.proc === proc || !entry.proc;
      if (proc && entry.proc === proc) {
        try { proc.kill('SIGTERM'); } catch {}
      }
      try {
        const clearedChild = await clearSidecarLease(entry, proc?.pid ?? null, ownedProcessIdentity);
        if (!clearedChild) await clearSidecarLease(entry, null, null);
      } catch (clearErr: any) {
        console.warn('[ace] failed to clear Hermes dashboard lease:', clearErr?.message || clearErr);
      }
      if (stillOwned) {
        entry.proc = null;
        entry.pid = null;
        entry.processIdentity = null;
        entry.status = 'exited';
        entry.baseUrl = null;
        entry.wsUrl = null;
        entry.token = null;
      }
      const message = err && err.message ? err.message : String(err || 'dashboard start failed');
      if (stillOwned) {
        entry.error = message;
        entry.lastExit = entry.lastExit ?? null;
        emitEvent('error', entry);
      }
      return { ok: false, error: message, home: entry.home ?? null, ownerKey: entry.ownerKey };
    }
  }

  // Liveness probe: a sidecar can be "running" (process alive) yet hung
  // (/api/status unresponsive) — the exit-only supervisor was blind to this.
  // On repeated misses, recycle the process through the normal exit→restart
  // path so the self-heal logic applies.
  function startLivenessProbe(entry: any) {
    if (entry.livenessTimer) { try { clearInterval(entry.livenessTimer); } catch {} }
    let misses = 0;
    entry.livenessTimer = setInterval(() => {
      if (entry.stopRequested || entry.status !== 'running' || !entry.baseUrl) return;
      probeDashboard(`${entry.baseUrl}/api/status`, 2000)
        .then((ok: boolean) => {
          if (ok) { misses = 0; return; }
          misses += 1;
          if (misses >= 3) {
            misses = 0;
            try { entry.proc?.kill('SIGTERM'); } catch {}
          }
        })
        .catch(() => {});
    }, 10_000);
    try { entry.livenessTimer.unref?.(); } catch {}
  }

  function handleProcExit(entry: any, proc: any, code: any, err: any) {
    // node may deliver callbacks for a process this entry no longer owns
    // (stopped, or already replaced by the auto-restart) — never let a stale
    // exit mutate the replacement.
    if (entry.proc !== proc) return;
    void clearSidecarLease(entry, proc.pid, entry.processIdentity).catch((clearErr: any) => {
      console.warn('[ace] failed to clear Hermes dashboard lease:', clearErr?.message || clearErr);
    });
    if (entry.livenessTimer) { try { clearInterval(entry.livenessTimer); } catch {} entry.livenessTimer = null; }
    entry.proc = null;
    entry.pid = null;
    entry.processIdentity = null;
    entry.lastExit = { code: code ?? -1, at: Date.now() };
    if (err) entry.error = err.message ?? String(err);
    if (entry.stopRequested) {
      finishStoppedEntry(entry);
      return;
    }
    if (entry.alwaysOn && !entry.stopRequested) {
      // Crash-loop ceiling: an always-on sidecar still gives up after too many
      // restarts in a short window, so a backend that cannot stay up (bad
      // install, port conflict) never becomes an infinite respawn loop pegging
      // CPU. status 'exited' lets a later ensure() rebuild the entry on demand.
      const now = Date.now();
      entry.restartWindow = (entry.restartWindow || []).filter(
        (t: number) => now - t < ALWAYSON_RESTART_WINDOW_MS
      );
      if (entry.restartWindow.length >= ALWAYSON_MAX_RESTARTS) {
        entry.status = 'exited';
        entry.error =
          entry.error ||
          `hermes dashboard crashed ${entry.restartWindow.length} times in ${Math.round(
            ALWAYSON_RESTART_WINDOW_MS / 1000
          )}s; auto-restart paused`;
        emitEvent('error', entry);
        entry.host = null;
        entry.port = null;
        entry.baseUrl = null;
        entry.wsUrl = null;
        entry.token = null;
        if (!entry.stopRequested) {
          // Don't dead-end the tab: after a long, decaying backoff (60s → 5m cap)
          // clear the crash window and try once more, so a transient cause (flaky
          // port, briefly-unavailable dependency) recovers with no manual Retry.
          entry.selfHealAttempts = (entry.selfHealAttempts || 0) + 1;
          const healDelay = Math.min(5 * 60_000, 60_000 * entry.selfHealAttempts);
          entry.restartTimer = setTimeout(() => {
            entry.restartTimer = null;
            if (entry.stopRequested) return;
            entry.restartWindow = [];
            entry.status = 'starting';
            emitEvent('restarting', entry);
            entry.ready = startEntry(entry);
          }, healDelay);
          try { entry.restartTimer.unref?.(); } catch {}
        }
        return;
      }
      entry.restartWindow.push(now);
      entry.restarts += 1;
      entry.status = 'starting';
      emitEvent('restarting', entry);
      const delay = Math.min(30_000, 1000 * Math.max(1, Math.min(entry.restarts, 30)));
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null;
        if (entry.stopRequested) return;
        entry.ready = startEntry(entry);
      }, delay);
      try { entry.restartTimer.unref?.(); } catch {}
      return;
    }
    if (entry.restarts < 1) {
      // Crash-loop guard: exactly one automatic restart, then the dashboard
      // stays down until a manual ensure().
      entry.restarts += 1;
      entry.status = 'starting';
      emitEvent('restarting', entry);
      entry.ready = startEntry(entry);
      return;
    }
    entry.status = 'exited';
    entry.error = entry.error || `hermes dashboard exited (${code ?? 'unknown'})`;
    // status 'exited' releases the per-home claim: lanes may spawn again.
    emitEvent('exited', entry);
    entry.host = null;
    entry.port = null;
    entry.baseUrl = null;
    entry.wsUrl = null;
    entry.token = null;
  }

  function makeAppEntry() {
    const logHome = path.join(userDataPath, 'hermes-desktop-sidecar');
    return {
      key: HERMES_DESKTOP_APP_LEDGER_KEY,
      ownerKey: HERMES_DESKTOP_APP_OWNER_KEY,
      kind: 'app',
      remotePath: HERMES_DESKTOP_REMOTE_PATH,
      home: null,
      logHome,
      host: null,
      port: null,
      baseUrl: null,
      wsUrl: null,
      token: null,
      desktopApp: null,
      profile: null,
      proc: null,
      pid: null,
      status: 'starting',
      startedAt: null,
      restarts: 0,
      lastExit: null,
      error: null,
      stopRequested: false,
      alwaysOn: true,
      restartTimer: null,
      stopKillTimer: null,
      stopped: null,
      resolveStopped: null,
      hermesCodeFingerprint: null,
      ready: null,
    };
  }

  function makeHomeEntry(ownerKey: string, home: string) {
    return {
      key: home,
      ownerKey,
      kind: 'home',
      remotePath: null,
      home,
      logHome: home,
      host: null,
      port: null,
      baseUrl: null,
      wsUrl: null,
      token: null,
      desktopApp: null,
      profile: null,
      proc: null,
      pid: null,
      status: 'starting',
      startedAt: null,
      restarts: 0,
      lastExit: null,
      error: null,
      stopRequested: false,
      alwaysOn: false,
      restartTimer: null,
      stopKillTimer: null,
      stopped: null,
      resolveStopped: null,
      hermesCodeFingerprint: null,
      ready: null,
    };
  }

  function staleHermesCodeFingerprint(entry: any) {
    const recorded = entry?.hermesCodeFingerprint;
    if (!recorded) return null;
    let current = null;
    try { current = hermesCodeFingerprint(); } catch { current = null; }
    if (!current || current === recorded) return null;
    if (entry.staleHermesCodeHandledFingerprint === current) return null;
    return current;
  }

  function restartEntryForFreshHermesCode(existing: any, drifted: any, respawn: any) {
    existing.staleHermesCodeHandledFingerprint = drifted;
    existing.staleHermesCodeRestart = (async () => {
      console.warn(
        `[ace] hermes desktop sidecar (${existing.kind}${existing.home ? `:${existing.home}` : ''}) is running stale Hermes code (${String(existing.hermesCodeFingerprint).slice(0, 12)} -> ${String(drifted).slice(0, 12)}); respawning so existing sessions resume on the new code.`
      );
      await releaseEntry(existing);
      emitEvent('restarting', { ...existing, status: 'starting' });
      return respawn();
    })();
    return existing.staleHermesCodeRestart;
  }

  function ensureApp() {
    const existing = dashboards.get(HERMES_DESKTOP_APP_LEDGER_KEY);
    if (existing && existing.status !== 'exited') {
      if (existing.staleHermesCodeRestart) return existing.staleHermesCodeRestart;
      const drifted = existing.status === 'running' ? staleHermesCodeFingerprint(existing) : null;
      if (drifted) {
        return restartEntryForFreshHermesCode(existing, drifted, () => ensureApp());
      }
      return existing.ready;
    }
    const entry = makeAppEntry();
    dashboards.set(HERMES_DESKTOP_APP_LEDGER_KEY, entry);
    entry.ready = startEntry(entry);
    return entry.ready;
  }

  // ensure({ ownerKey }) — idempotent per home: returns the live dashboard's
  // URL when one is already starting/running, otherwise claims the home and
  // spawns. The claim lands in the ledger synchronously, before any await.
  // ensure() with no ownerKey starts the always-on global Hermes app sidecar
  // used by Teams; it intentionally does not claim a lane home and points
  // HERMES_HOME at the resolved global ~/.hermes root.
  function ensure({ ownerKey }: any = {}) {
    if (!ownerKey) return ensureApp();
    let home;
    try {
      home = normalizeHomePath(ensureHermesHome(ownerKey));
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: err && err.message ? err.message : String(err || 'hermes home resolution failed'),
        ownerKey,
      });
    }
    const existing = dashboards.get(home);
    if (existing && existing.status !== 'exited') {
      if (existing.staleHermesCodeRestart) return existing.staleHermesCodeRestart;
      const drifted = existing.status === 'running' ? staleHermesCodeFingerprint(existing) : null;
      if (drifted) {
        return restartEntryForFreshHermesCode(existing, drifted, () => ensure({ ownerKey }));
      }
      return existing.ready;
    }
    const entry: any = makeHomeEntry(ownerKey, home);
    dashboards.set(home, entry);
    // Claim is registered; now stop any live PTY writer on this home before
    // the dashboard spawns (claim → stop → spawn keeps the no-dual-write
    // invariant airtight: new PTYs are refused by the guard, the old one is
    // gone before the dashboard opens state.db).
    if (typeof stopHermesPtyForHome === 'function') {
      try {
        stopHermesPtyForHome(home);
      } catch (err) {
        // Fail closed: a sweep that threw midway may have left a live PTY
        // still writing this home — spawning the dashboard anyway would be
        // the exact dual-write this hook exists to prevent (the guard only
        // refuses NEW writers). Release the claim so lanes are not stranded
        // behind a dashboard that never spawned, and surface the error; a
        // retry re-runs the whole claim → sweep → spawn sequence.
        dashboards.delete(home);
        const message = err && err.message ? err.message : String(err || 'sweep failed');
        return Promise.resolve({
          ok: false,
          error: `lane handoff failed: ${message}`,
          home,
          ownerKey,
        });
      }
    }
    entry.ready = startEntry(entry);
    return entry.ready;
  }

  async function appConnection(profile: any = null) {
    const result = await ensureApp();
    if (!result?.ok) {
      throw new Error(result?.error || 'Hermes Desktop backend is unavailable');
    }
    // EVERY requested profile resolves to the one always-on app sidecar: after
    // setAppProfile the sidecar is (re)spawned rooted at that profile, so it IS
    // that profile's backend (same as upstream Hermes desktop). There is no
    // second pooled process to split the SPA's single gateway socket across two
    // pythons on one state.db — the root of the silent operator-lane no-reply
    // bug. The returned token always comes from the fresh ensureApp() result, so
    // a restarted sidecar can't hand back a stale credential.
    const requestedProfile = normalizeProfileName(profile);
    // The active app sidecar serves only 'default' when it was rooted at an
    // identity home (see startEntry: identityHome → HERMES_HOME, no --profile).
    // Report that as backendProfile so the embed transport rewrites the SPA's
    // operator id ('<op>') → 'default' on profile-scoped paths instead of 404ing
    // with "Profile '<op>' does not exist".
    const appEntry = dashboards.get(HERMES_DESKTOP_APP_LEDGER_KEY);
    const backendProfile = appEntry?.identityHome ? 'default' : (requestedProfile || result.profile || undefined);
    return {
      baseUrl: result.baseUrl,
      mode: 'local',
      source: 'local',
      authMode: result.authMode || 'token',
      token: result.token,
      wsUrl: result.wsUrl,
      logs: [],
      profile: requestedProfile || result.profile || undefined,
      backendProfile,
      ...embeddedHermesWindowState(),
    };
  }

  async function setAppProfile(name: any) {
    const previous = readActiveDesktopProfile();
    const profile = writeActiveDesktopProfile(name);
    const existing = dashboards.get(HERMES_DESKTOP_APP_LEDGER_KEY);
    const running = Boolean(existing && existing.status !== 'exited');
    if (running && profile === previous) {
      // Re-selecting the already-active lane is a no-op. Killing and
      // respawning the backend here destroyed any in-flight turn — the
      // session detached to the stdio black hole and the reply vanished —
      // for zero routing benefit.
      return { profile, changed: false };
    }
    // The promoted profile's pooled backend (if any) is superseded by the
    // re-rooted app sidecar; stop only that one so other profiles' backends
    // — and their in-flight turns — survive the switch.
    if (profile) stopProfileBackend(profile);
    if (running) {
      await releaseEntry(existing);
      emitEvent('restarting', { ...existing, status: 'starting' });
      await ensureApp();
    }
    return { profile, changed: true };
  }

  function findEntry({ ownerKey, home }: any = {}) {
    if (home) return dashboards.get(normalizeHomePath(home)) ?? null;
    if (!ownerKey) return null;
    for (const entry of dashboards.values()) {
      if (entry.ownerKey === ownerKey) return entry;
    }
    return null;
  }

  function releaseEntry(entry: any) {
    if (entry.status === 'exited') return Promise.resolve({ ok: true, stopped: false });
    if (entry.status === 'stopping') {
      return entry.stopped || Promise.resolve({ ok: true, stopped: true });
    }
    entry.stopRequested = true;
    if (entry.restartTimer) {
      try { clearTimeout(entry.restartTimer); } catch {}
      entry.restartTimer = null;
    }
    if (entry.livenessTimer) {
      try { clearInterval(entry.livenessTimer); } catch {}
      entry.livenessTimer = null;
    }
    const proc = entry.proc;
    entry.status = 'stopping';
    entry.stopped = new Promise((resolve) => {
      entry.resolveStopped = resolve;
    });
    const stoppedPromise = entry.stopped;
    entry.ready = Promise.resolve({
      ok: false,
      error: 'Hermes dashboard is stopping',
      home: entry.home ?? null,
      ownerKey: entry.ownerKey,
    });
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      entry.stopKillTimer = setTimeout(() => {
        if (entry.proc === proc) {
          try { proc.kill('SIGKILL'); } catch {}
        }
      }, 5_000);
      try { entry.stopKillTimer.unref?.(); } catch {}
    } else {
      finishStoppedEntry(entry);
      return Promise.resolve({ ok: true, stopped: true });
    }
    emitEvent('stopping', entry);
    return stoppedPromise;
  }

  async function stop(ref: any = {}) {
    const entry = findEntry(ref);
    if (!entry) return { ok: true, stopped: false };
    if (entry.kind === 'app') stopAllProfileBackends();
    await releaseEntry(entry);
    return { ok: true, stopped: true };
  }

  async function stopAll() {
    const entries = [...dashboards.values()];
    await Promise.all(entries.map((entry) => releaseEntry(entry)));
    const profileCount = profileBackends.size;
    stopAllProfileBackends();
    return { ok: true, stopped: entries.length + profileCount };
  }

  async function setSurface(surface: any) {
    if (!HERMES_SURFACES.includes(surface)) {
      throw new Error(`surface must be one of: ${HERMES_SURFACES.join(', ')}`);
    }
    // Flipping back to lanes releases every claim first so lane boots never
    // race a dying dashboard for state.db.
    if (surface === 'lanes') await stopAll();
    const config = loadSurfaceConfig(userDataPath, fsImpl);
    saveSurfaceConfig(userDataPath, { ...config, defaultSurface: surface }, fsImpl);
    emitEvent('config-changed');
    return status();
  }

  function proxyTarget() {
    const entry = dashboards.get(HERMES_DESKTOP_APP_LEDGER_KEY);
    if (!entry || entry.status !== 'running' || !entry.host || !entry.port) return null;
    return {
      ownerKey: entry.ownerKey,
      host: entry.host,
      port: entry.port,
      remotePath: entry.remotePath,
    };
  }

  // Narrow restart for the Operations "Agent Control" panel: composes the
  // existing stop() then ensure() (no ownerKey = the always-on app sidecar;
  // never a raw kill), and the result is SANITIZED — only ok/status/pid ever
  // leave here. The embed URL and session token from ensure() are
  // secret-equivalent and go ONLY to the surface that called ensure() itself.
  async function restart(ref: any = {}) {
    const ownerKey =
      typeof ref?.ownerKey === 'string' && ref.ownerKey.trim() ? ref.ownerKey.trim() : null;
    await stop({ ownerKey: ownerKey || HERMES_DESKTOP_APP_OWNER_KEY });
    const result = await (ownerKey ? ensure({ ownerKey }) : ensure({}));
    if (result && result.ok === false) {
      return {
        ok: false,
        ownerKey: ownerKey || HERMES_DESKTOP_APP_OWNER_KEY,
        error: result.error || 'hermes backend restart failed',
      };
    }
    const entry = ownerKey
      ? findEntry({ ownerKey })
      : dashboards.get(HERMES_DESKTOP_APP_LEDGER_KEY);
    return {
      ok: true,
      ownerKey: ownerKey || HERMES_DESKTOP_APP_OWNER_KEY,
      status: entry?.status ?? 'running',
      pid: entry?.pid ?? null,
    };
  }

  return {
    ensure,
    stop,
    stopAll,
    restart,
    status,
    monitoringSnapshot,
    setSurface,
    isHomeClaimed,
    proxyTarget,
    appConnection,
    touchAppProfile: (profile: any) => touchProfileBackend(profile),
    readActiveDesktopProfile: () => ({ profile: readActiveDesktopProfile() }),
    setAppProfile,
  };
}

module.exports = {
  HERMES_SURFACE_FILE: SURFACE_FILE,
  HERMES_SURFACE_BAK_FILE: SURFACE_BAK_FILE,
  HERMES_DESKTOP_APP_OWNER_KEY,
  HERMES_DESKTOP_REMOTE_PATH,
  DESKTOP_PROFILE_FILE,
  HERMES_DESKTOP_APP_PARTITION,
  resolveHermesDesktopApp,
  missingHermesCliMessage,
  isLoopbackHttpUrl,
  resolveIsMainFrame,
  shouldDivertHermesGuestNavigation,
  isTrustedHermesDesktopResource,
  isTrustedHermesDesktopWebview,
  sendHermesDesktopOpenLink,
  defaultSurfaceConfig,
  validateSurfaceConfig,
  loadSurfaceConfig,
  saveSurfaceConfig,
  createHermesDashboardManager,
};
