const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { BrowserWindow, clipboard, dialog, shell, systemPreferences } = require('electron');
const { fileURLToPath, pathToFileURL } = require('url');
const {
  isTrustedHermesDesktopResource,
  sendHermesDesktopOpenLink,
} = require('./hermes-dashboard.cts');
const {
  isCronJobMutation,
  sanitizeCronJobMutationBody,
} = require('./hermes-home-chat.cts');

let nodePty = null;
try {
  nodePty = require('node-pty');
} catch {
  nodePty = null;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const DATA_URL_READ_MAX_BYTES = 50 * 1024 * 1024;
const PREVIEW_WATCH_DEBOUNCE_MS = 120;
const LOCAL_PREVIEW_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1', '[::1]', 'localhost']);
const HIDDEN_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
  'venv',
]);
const GIT_SCAN_JUNK_DIRS = new Set([
  'Applications',
  'Library',
  'node_modules',
  'site-packages',
  'vendor',
  'venv',
]);
const GIT_SCAN_DEFAULT_MAX_DEPTH = 3;
const GIT_SCAN_MAX_DEPTH = 8;
const GIT_SCAN_MAX_CONCURRENCY = 32;

const MIME_BY_EXT = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};

const PREVIEW_LANGUAGE_BY_EXT = {
  '.css': 'css',
  '.go': 'go',
  '.html': 'html',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.sh': 'shell',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.txt': 'text',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

function mimeTypeForPath(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function looksBinary(buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

async function scanGitReposForBridge(roots: any, options: any = {}, deps: any = {}) {
  const requestedDepth = Number(options?.maxDepth);
  const maxDepth = Number.isFinite(requestedDepth) && requestedDepth >= 0
    ? Math.min(GIT_SCAN_MAX_DEPTH, Math.floor(requestedDepth))
    : GIT_SCAN_DEFAULT_MAX_DEPTH;
  const requestedConcurrency = Number(deps?.maxConcurrency);
  const maxConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(GIT_SCAN_MAX_CONCURRENCY, Math.floor(requestedConcurrency))
    : GIT_SCAN_MAX_CONCURRENCY;
  const scanFs = deps?.fsImpl ?? fs;
  const searchRoots = Array.isArray(roots) && roots.length > 0 ? roots : [os.homedir()];
  const found = new Map();
  const normalizedRoots = searchRoots
    .map((root: any) => String(root || '').trim())
    .filter(Boolean);
  const queue = normalizedRoots.map((dir: string) => ({ depth: 0, dir }));
  const waiters: any[] = [];
  let remaining = queue.length;

  function wakeWorkers() {
    while (waiters.length > 0 && (queue.length > 0 || remaining === 0)) {
      const wake = waiters.shift();
      wake();
    }
  }

  async function takeJob() {
    while (queue.length === 0) {
      if (remaining === 0) return null;
      await new Promise((resolve) => waiters.push(resolve));
    }
    return queue.shift();
  }

  async function worker() {
    while (true) {
      const job = await takeJob();
      if (!job) return;
      let entries: any[] = [];
      try {
        entries = await scanFs.promises.readdir(job.dir, { withFileTypes: true });
      } catch {}

      const subdirs: string[] = [];
      if (entries.some((entry: any) => entry.name === '.git' && entry.isDirectory())) {
        const root = job.dir.replace(/[/\\]+$/, '');
        found.set(root, path.basename(root) || root);
      } else if (job.depth < maxDepth) {
        for (const entry of entries) {
          if (
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            !GIT_SCAN_JUNK_DIRS.has(entry.name)
          ) {
            subdirs.push(path.join(job.dir, entry.name));
          }
        }
      }

      for (const dir of subdirs) queue.push({ depth: job.depth + 1, dir });
      remaining += subdirs.length - 1;
      wakeWorkers();
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return [...found.entries()]
    .map(([root, label]) => ({ label, root }))
    .sort((left, right) => left.root.localeCompare(right.root));
}

function senderIsTrusted(event, trustOptions = {}) {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isTrustedHermesDesktopResource(url, 'index', trustOptions);
}

function assertTrustedSender(event, trustOptions = {}) {
  if (!senderIsTrusted(event, trustOptions)) {
    throw new Error('Hermes Desktop bridge is only available to the embedded Hermes.app renderer');
  }
}

function hermesProfileRootUrl(currentUrl: any, profile: any = null, now: any = Date.now()) {
  const url = new URL(String(currentUrl || ''));
  const profileName = String(profile || '').trim();
  if (profileName) {
    url.searchParams.set('aceProfile', profileName);
  } else {
    url.searchParams.delete('aceProfile');
  }
  url.searchParams.set('aceProfileReload', String(now));
  url.hash = '/';
  return url.toString();
}

function reloadSender(sender: any) {
  try {
    sender.reloadIgnoringCache?.();
  } catch {
    try { sender.reload?.(); } catch {}
  }
}

function loadHermesProfileRoot(sender: any, profile: any) {
  try {
    const nextUrl = hermesProfileRootUrl(sender?.getURL?.(), profile);
    if (typeof sender?.loadURL === 'function') {
      const load = sender.loadURL(nextUrl);
      if (load && typeof load.catch === 'function') load.catch(() => reloadSender(sender));
      return;
    }
  } catch {
    // Fall back to Electron's normal reload path if the sender URL is absent.
  }
  reloadSender(sender);
}

function fetchJson(url, token, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = client.request(
      parsed,
      {
        method: options.method || 'GET',
        timeout: options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Session-Token': token,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            const err: any = new Error(`${res.statusCode}: ${text || res.statusMessage}`);
            err.statusCode = res.statusCode || 500;
            reject(err);
            return;
          }
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`Hermes backend returned non-JSON for ${parsed.pathname}: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Hermes backend request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A freshly (re)spawned Hermes sidecar binds its HTTP server and answers the
// liveness route (/api/status, which is how waitForReady passes) a beat BEFORE
// every @app.get route is registered. The embedded SPA's boot sequence ends
// with GET /api/profiles/sessions; if that one call races the route mount it
// gets a transient 404 and the SPA latches its un-retried "Hermes couldn't
// start" overlay (the gateway already connected — only this HTTP call failed).
// So idempotent GETs retry briefly on the transient boot statuses; non-GET and
// real failures (400/401/403, or a 404 that never clears) still surface. The
// window is short because the route mounts within ~1-2s of the server binding;
// the cap keeps a genuine steady-state 404 from stalling more than ~4s.
const BOOT_RETRY_STATUS = new Set([404, 502, 503]);
const BOOT_RETRY_MAX_ATTEMPTS = 6;
const BOOT_RETRY_BACKOFFS_MS = [200, 400, 800, 1200, 1600];

function isBootRetryableError(err: any) {
  const status = err && typeof err.statusCode === 'number' ? err.statusCode : null;
  if (status != null) return BOOT_RETRY_STATUS.has(status);
  // No HTTP status → a transport-level failure (connection refused/reset while
  // the sidecar is still warming). Retry those too; a hard config error simply
  // exhausts the short budget and surfaces.
  return true;
}

const defaultSleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

// deps is injectable so tests can supply an instant sleep + a scripted fetch
// without standing up a real warming sidecar; production passes nothing.
async function fetchJsonWithBootRetry(url: any, token: any, options: any = {}, deps: any = {}) {
  const fetchImpl = deps.fetchJson || fetchJson;
  const sleep = deps.sleep || defaultSleep;
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') return fetchImpl(url, token, options);
  let lastErr;
  for (let attempt = 0; attempt < BOOT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, token, options);
    } catch (err) {
      lastErr = err;
      if (attempt === BOOT_RETRY_MAX_ATTEMPTS - 1 || !isBootRetryableError(err)) throw err;
      await sleep(BOOT_RETRY_BACKOFFS_MS[Math.min(attempt, BOOT_RETRY_BACKOFFS_MS.length - 1)]);
    }
  }
  throw lastErr;
}

function safeApiPath(input) {
  const raw = String(input || '');
  if (!raw.startsWith('/api/')) throw new Error(`Refusing non-API Hermes path: ${raw || '(empty)'}`);
  return raw;
}

// Profile-scoped API paths name the profile two ways, and BOTH must be aliased
// to the name the backend actually serves: a path segment
// (`/api/profiles/<op>/soul`, `/api/profiles/<op>`) and query parameters
// (`profile=<op>` and the sidebar batch's `recents_profile=<op>`). When the
// embed sidecar is rooted at an operator's identity home it has no named profile
// — only 'default' — but the SPA still asks for `<op>`, which the backend rejects
// 404 "Profile '<op>' does not exist". backendProfile (from appConnection) is
// 'default' in that case, so <op>→default resolves to the identity home.
// Reserved segments (the cross-profile `sessions` aggregate, `all`, `default`,
// the `active`-profile lookup), a matching value, and a falsy backendProfile
// (real named profile) are all left untouched. `active` is NOT a profile name —
// /api/profiles/active returns the current profile, so rewriting it to
// /api/profiles/default 404s "No such API endpoint".
const ALIAS_RESERVED_SEGMENTS = new Set(['sessions', 'all', 'default', 'active']);

function aliasApiPathProfile(apiPath: any, backendProfile: any) {
  const target = typeof backendProfile === 'string' ? backendProfile.trim() : '';
  if (!target) return apiPath;
  let raw = String(apiPath || '');
  // Path segment: /api/profiles/<name>[/...] — rewrite <name> only.
  const seg = raw.match(/^(\/api\/profiles\/)([^/?]+)([^?]*)(\?.*)?$/);
  if (seg) {
    let decoded = seg[2];
    try { decoded = decodeURIComponent(seg[2]); } catch { /* keep raw */ }
    if (!ALIAS_RESERVED_SEGMENTS.has(decoded) && decoded !== target) {
      raw = `${seg[1]}${encodeURIComponent(target)}${seg[3] || ''}${seg[4] || ''}`;
    }
  }
  // Query parameters are independent of the segment rewrite.
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(raw.slice(qIdx + 1));
    let changed = false;
    for (const key of ['profile', 'recents_profile']) {
      const current = params.get(key);
      if (current && current !== 'all' && current !== target) {
        params.set(key, target);
        changed = true;
      }
    }
    if (changed) raw = `${raw.slice(0, qIdx)}?${params.toString()}`;
  }
  return raw;
}

function safeResolvedPath(input, fallback = os.homedir()) {
  const raw = String(input || '');
  if (raw.startsWith('file:')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return fallback;
    }
  }
  try {
    return path.resolve(raw || fallback);
  } catch {
    return fallback;
  }
}

function directoryExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithin(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPackagedInstallPathForBridge(dir, appInstance) {
  if (!appInstance?.isPackaged) return false;
  let resolved = '';
  try {
    resolved = path.resolve(String(dir || ''));
  } catch {
    return false;
  }
  const roots = [
    typeof appInstance.getAppPath === 'function' ? appInstance.getAppPath() : null,
    process.resourcesPath,
    path.dirname(process.execPath),
  ].filter(Boolean).map((root) => {
    try {
      return path.resolve(String(root));
    } catch {
      return '';
    }
  }).filter(Boolean);
  return roots.some((root) => isPathWithin(resolved, root));
}

function bridgeDefaultCwd(appInstance) {
  try {
    const home = appInstance?.getPath?.('home');
    if (home && directoryExists(home)) return path.resolve(home);
  } catch {}
  return os.homedir();
}

function sanitizeWorkspaceCwdForBridge(cwd, appInstance) {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  const fallback = bridgeDefaultCwd(appInstance);

  if (!trimmed || isPackagedInstallPathForBridge(trimmed, appInstance)) {
    return { cwd: fallback, sanitized: Boolean(trimmed) };
  }

  try {
    const resolved = path.resolve(trimmed);
    if (!isPackagedInstallPathForBridge(resolved, appInstance) && directoryExists(resolved)) {
      return { cwd: resolved, sanitized: false };
    }
  } catch {
    // Fall through to the safe default.
  }

  return { cwd: fallback, sanitized: Boolean(trimmed) };
}

function expandPreviewPath(value: any, appInstance: any) {
  const raw = String(value || '').trim();
  let home = os.homedir();
  try { home = appInstance?.getPath?.('home') || home; } catch {}
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith(`~${path.sep}`)) {
    return path.join(home, raw.slice(2));
  }
  return raw;
}

function previewFileMetadataForBridge(filePath: string, mimeType: string) {
  const stat = fs.statSync(filePath);
  let binary = false;
  if (!mimeType.startsWith('image/') && stat.size > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const sample = Buffer.alloc(Math.min(stat.size, 4096));
      const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
      binary = looksBinary(sample.subarray(0, bytesRead));
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    binary,
    byteSize: stat.size,
    large: stat.size > TEXT_PREVIEW_MAX_BYTES,
  };
}

async function normalizePreviewTargetForBridge(rawTarget: any, baseDir: any = '', appInstance: any = null) {
  const raw = String(rawTarget || '').trim();
  if (!raw) return null;

  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) return null;
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
      return {
        kind: 'url',
        label: `${url.host}${url.pathname === '/' ? '' : url.pathname}`,
        source: raw,
        url: url.toString(),
      };
    }

    const base = sanitizeWorkspaceCwdForBridge(baseDir, appInstance).cwd;
    let resolved = raw.startsWith('file:')
      ? fileURLToPath(raw)
      : expandPreviewPath(raw, appInstance);
    if (!path.isAbsolute(resolved)) resolved = path.resolve(base, resolved);
    if (directoryExists(resolved)) resolved = path.join(resolved, 'index.html');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;

    const ext = path.extname(resolved).toLowerCase();
    const mimeType = mimeTypeForPath(resolved);
    const metadata = previewFileMetadataForBridge(resolved, mimeType);
    const isHtml = ext === '.html' || ext === '.htm';
    const isImage = mimeType.startsWith('image/');
    return {
      ...metadata,
      kind: 'file',
      label: path.basename(resolved),
      language: PREVIEW_LANGUAGE_BY_EXT[ext] || 'text',
      mimeType,
      path: resolved,
      previewKind: isHtml ? 'html' : isImage ? 'image' : metadata.binary ? 'binary' : 'text',
      source: raw,
      url: pathToFileURL(resolved).toString(),
    };
  } catch {
    return null;
  }
}

function windowForSender(event) {
  return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow() || undefined;
}

function defaultBootProgress() {
  return {
    phase: 'backend.ready',
    message: 'Hermes Desktop is ready.',
    progress: 100,
    running: true,
    visible: false,
    error: null,
    at: Date.now(),
  };
}

function defaultConnectionConfig(profile = null) {
  return {
    envOverride: false,
    mode: 'local',
    profile: profile || null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: null,
    remoteTokenSet: false,
    remoteUrl: '',
  };
}

function normalizeLogicalProfile(profile: any) {
  const value = String(profile || '').trim();
  return value && value !== 'default' ? value : '';
}

function tagSessionProfile(session: any, profile: string) {
  if (!profile || !session || typeof session !== 'object' || Array.isArray(session)) return session;
  const existing = String(session.profile || '').trim();
  if (existing && existing !== 'default') return session;
  return { ...session, profile };
}

function shouldTagSessionResponse(apiPath: any) {
  const cleanPath = String(apiPath || '').split('?')[0];
  return (
    cleanPath === '/api/sessions' ||
    cleanPath === '/api/profiles/sessions' ||
    cleanPath === '/api/profiles/sessions/sidebar' ||
    cleanPath === '/api/sessions/search' ||
    /^\/api\/sessions\/[^/]+$/.test(cleanPath)
  );
}

function tagSessionContainer(response: any, logicalProfile: string) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;

  let next = response;
  let hasSessionRows = false;

  if (Array.isArray(response.sessions)) {
    hasSessionRows = true;
    next = next === response ? { ...response } : next;
    next.sessions = response.sessions.map((session: any) => tagSessionProfile(session, logicalProfile));
  }

  if (response.session && typeof response.session === 'object' && !Array.isArray(response.session)) {
    hasSessionRows = true;
    next = next === response ? { ...response } : next;
    next.session = tagSessionProfile(response.session, logicalProfile);
  }

  if (Array.isArray(response.results)) {
    const tagged = response.results.map((item: any) => tagSessionProfile(item, logicalProfile));
    if (tagged.some((item: any, index: number) => item !== response.results[index])) {
      hasSessionRows = true;
      next = next === response ? { ...response } : next;
      next.results = tagged;
    }
  }

  if (hasSessionRows && typeof response.total === 'number') {
    const totals =
      response.profile_totals && typeof response.profile_totals === 'object'
        ? { ...response.profile_totals }
        : {};
    if (totals[logicalProfile] == null) totals[logicalProfile] = response.total;
    next = next === response ? { ...response } : next;
    next.profile_totals = totals;
  } else if (
    hasSessionRows &&
    response.profile_totals &&
    typeof response.profile_totals === 'object'
  ) {
    const totals = { ...response.profile_totals };
    if (totals[logicalProfile] == null && totals.default != null) {
      totals[logicalProfile] = totals.default;
      next = next === response ? { ...response } : next;
      next.profile_totals = totals;
    }
  }

  return next;
}

function tagSessionResponseProfile(apiPath: any, response: any, profile: any) {
  const logicalProfile = normalizeLogicalProfile(profile);
  if (!logicalProfile || !shouldTagSessionResponse(apiPath)) return response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;

  let next = tagSessionContainer(response, logicalProfile);
  if (String(apiPath || '').split('?')[0] !== '/api/profiles/sessions/sidebar') return next;

  // Hermes 0.19 batches its sidebar into nested recents/messaging/cron
  // containers. Retag each group just like the older top-level session-list
  // response so the SPA's logical operator filter does not discard backend
  // `default` rows after the request alias resolves the identity home.
  for (const group of ['recents', 'messaging', 'cron']) {
    const original = response[group];
    const tagged = tagSessionContainer(original, logicalProfile);
    if (tagged !== original) {
      next = next === response ? { ...response } : next;
      next[group] = tagged;
    }
  }
  return next;
}

function findGitRoot(start) {
  let dir = safeResolvedPath(start);
  for (let i = 0; i < 50; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function terminalShellCommand() {
  const configured = process.env.SHELL || '';
  const shellPath =
    (path.isAbsolute(configured) && fs.existsSync(configured) && configured) ||
    ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => fs.existsSync(candidate)) ||
    '/bin/sh';
  const name = path.basename(shellPath);
  return { command: shellPath, args: name.includes('zsh') || name.includes('bash') ? ['-il'] : ['-i'], name };
}

const ZOOM_FACTOR_BASE = 1.2;
const MIN_ZOOM_LEVEL = -9;
const MAX_ZOOM_LEVEL = 9;

function clampZoomLevel(value: any) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
}

function zoomLevelToPercent(level: any) {
  return Math.round(Math.pow(ZOOM_FACTOR_BASE, clampZoomLevel(level)) * 100);
}

function percentToZoomLevel(percent: any) {
  const numeric = Number(percent);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return clampZoomLevel(Math.log(numeric / 100) / Math.log(ZOOM_FACTOR_BASE));
}

function remoteDisplayReasonForBridge(env: any = process.env, platform: any = process.platform) {
  const override = String(env?.HERMES_DESKTOP_DISABLE_GPU || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(override)) {
    return 'override (HERMES_DESKTOP_DISABLE_GPU)';
  }
  if (['0', 'false', 'no', 'off'].includes(override)) return null;
  if (env?.SSH_CONNECTION || env?.SSH_CLIENT || env?.SSH_TTY) return 'ssh-session';
  if (platform === 'linux') {
    const display = String(env?.DISPLAY || '');
    if (display.includes(':') && display.split(':')[0]) {
      return `x11-forwarding (DISPLAY=${display})`;
    }
  }
  if (platform === 'win32') {
    const sessionName = String(env?.SESSIONNAME || '');
    if (/^rdp-/i.test(sessionName)) return `rdp (SESSIONNAME=${sessionName})`;
  }
  return null;
}

function apiPathWithQuery(route: string, values: any = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

function registerHermesDesktopBridge({
  ipcMain,
  app,
  store,
  trustOptions = {},
  fetchApi = fetchJsonWithBootRetry,
  probeApi = fetchJson,
  platform = process.platform,
}) {
  const terminalSessions = new Map();
  const previewWatchers = new Map();
  const secondaryWindows = new Map();
  let microphoneAccessRequest: Promise<boolean> | null = null;
  let petOverlayWindow: any = null;
  let petOverlaySender: any = null;

  const connection = (profile = null) => store.hermesDesktopAppConnection({ profile });
  const callApi = async (apiPath: string, options: any = {}, profile: any = null) => {
    const conn = await connection(profile);
    return fetchApi(`${conn.baseUrl}${apiPath}`, conn.token, options);
  };
  const withTrust = (handler) => async (event, ...args) => {
    assertTrustedSender(event, trustOptions);
    return handler(event, ...args);
  };
  const rendererWindowUrl = (sender: any, sessionId: any = null, options: any = {}) => {
    const url = new URL(String(sender?.getURL?.() || ''));
    url.searchParams.set('win', options.overlay ? 'overlay' : 'secondary');
    if (options.newSession) url.searchParams.set('new', '1');
    else url.searchParams.delete('new');
    if (options.watch) url.searchParams.set('watch', '1');
    else url.searchParams.delete('watch');
    url.hash = options.overlay || options.newSession ? '/' : `/${encodeURIComponent(String(sessionId || ''))}`;
    return url;
  };
  const preloadForRendererUrl = (url: URL) => {
    const indexPath = fileURLToPath(url);
    const preloadPath = path.join(path.dirname(path.dirname(indexPath)), 'electron', 'preload.cjs');
    if (!isTrustedHermesDesktopResource(preloadPath, 'preload', trustOptions)) {
      throw new Error('Could not resolve the trusted Hermes Desktop preload');
    }
    return preloadPath;
  };
  const createHermesWindow = (event: any, sessionId: any = null, options: any = {}) => {
    const url = rendererWindowUrl(event.sender, sessionId, options);
    const preload = preloadForRendererUrl(url);
    const win = new BrowserWindow({
      width: options.overlay ? Math.max(240, Number(options.bounds?.width) || 320) : 900,
      height: options.overlay ? Math.max(300, Number(options.bounds?.height) || 420) : 760,
      ...(options.overlay ? {
        frame: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
      } : { show: false, title: 'Hermes' }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (options.bounds) win.setBounds?.(options.bounds);
    if (options.overlay) win.setAlwaysOnTop?.(true, 'floating');
    win.once?.('ready-to-show', () => {
      if (!win.isDestroyed?.()) win.show?.();
    });
    const load = win.loadURL(url.toString());
    if (load && typeof load.catch === 'function') load.catch(() => win.close?.());
    return win;
  };

  ipcMain.handle('hermes:connection', withTrust((_event, profile) => connection(profile)));
  ipcMain.handle('hermes:connection:revalidate', withTrust(async () => {
    const rebuild = async () => {
      if (typeof store.hermesDesktopRestart !== 'function') {
        throw new Error('Hermes sidecar restart is unavailable in this Ace build.');
      }
      const restarted = await store.hermesDesktopRestart({});
      if (!restarted?.ok) {
        throw new Error(restarted?.error || 'Hermes sidecar restart failed.');
      }
      return { ok: true, rebuilt: true };
    };

    let conn;
    try {
      conn = await connection();
    } catch {
      return rebuild();
    }
    if (!conn?.baseUrl) return rebuild();
    try {
      await probeApi(`${String(conn.baseUrl).replace(/\/+$/, '')}/api/status`, conn.token, {
        timeoutMs: 2_500,
      });
      return { ok: true, rebuilt: false };
    } catch {
      return rebuild();
    }
  }));
  ipcMain.handle('hermes:backend:touch', withTrust(async (_event, profile) => ({
    ok: true,
    touched: Boolean(store.hermesDesktopTouchAppProfile?.({ profile })),
  })));
  ipcMain.handle('hermes:gateway:ws-url', withTrust(async (_event, profile) => {
    const conn = await connection(profile);
    return conn.wsUrl;
  }));
  ipcMain.handle('hermes:window:openSession', withTrust(async (event, sessionId, options = {}) => {
    const key = String(sessionId || '').trim();
    if (!key) return { ok: false, error: 'invalid-session-id' };
    const existing = secondaryWindows.get(key);
    if (existing && !existing.isDestroyed?.()) {
      existing.show?.();
      existing.focus?.();
      return { ok: true };
    }
    const win = createHermesWindow(event, key, { watch: options.watch === true });
    secondaryWindows.set(key, win);
    win.on?.('closed', () => {
      if (secondaryWindows.get(key) === win) secondaryWindows.delete(key);
    });
    return { ok: true };
  }));
  ipcMain.handle('hermes:window:openNewSession', withTrust(async (event) => {
    createHermesWindow(event, null, { newSession: true });
    return { ok: true };
  }));
  ipcMain.handle('hermes:pet-overlay:open', withTrust(async (event, request = {}) => {
    const raw = request?.bounds || request || {};
    const bounds = {
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      width: Math.max(240, Number(raw.width) || 320),
      height: Math.max(300, Number(raw.height) || 420),
    };
    if (!request?.screen) {
      const content = windowForSender(event)?.getContentBounds?.();
      if (content) {
        bounds.x += Number(content.x) || 0;
        bounds.y += Number(content.y) || 0;
      }
    }
    petOverlaySender = event.sender;
    if (!petOverlayWindow || petOverlayWindow.isDestroyed?.()) {
      petOverlayWindow = createHermesWindow(event, null, { overlay: true, bounds });
      petOverlayWindow.on?.('closed', () => { petOverlayWindow = null; });
    } else {
      petOverlayWindow.setBounds?.(bounds);
      petOverlayWindow.show?.();
    }
    return { bounds: petOverlayWindow.getBounds?.() || bounds };
  }));
  ipcMain.handle('hermes:pet-overlay:close', withTrust(async () => {
    try { petOverlayWindow?.close?.(); } catch {}
    petOverlayWindow = null;
    return { ok: true };
  }));
  ipcMain.on('hermes:pet-overlay:set-bounds', (event, bounds) => {
    try { assertTrustedSender(event, trustOptions); petOverlayWindow?.setBounds?.(bounds); } catch {}
  });
  ipcMain.on('hermes:pet-overlay:ignore-mouse', (event, ignore) => {
    try { assertTrustedSender(event, trustOptions); petOverlayWindow?.setIgnoreMouseEvents?.(Boolean(ignore)); } catch {}
  });
  ipcMain.on('hermes:pet-overlay:set-focusable', (event, focusable) => {
    try {
      assertTrustedSender(event, trustOptions);
      petOverlayWindow?.setFocusable?.(Boolean(focusable));
      if (focusable) petOverlayWindow?.focus?.();
    } catch {}
  });
  ipcMain.on('hermes:pet-overlay:state', (event, payload) => {
    try {
      assertTrustedSender(event, trustOptions);
      petOverlaySender = event.sender;
      petOverlayWindow?.webContents?.send?.('hermes:pet-overlay:state', payload);
    } catch {}
  });
  ipcMain.on('hermes:pet-overlay:control', (event, payload) => {
    try {
      assertTrustedSender(event, trustOptions);
      if (petOverlaySender && !petOverlaySender.isDestroyed?.()) {
        petOverlaySender.send?.('hermes:pet-overlay:control', payload);
      }
    } catch {}
  });
  ipcMain.handle('hermes:boot-progress:get', withTrust(async () => defaultBootProgress()));
  ipcMain.handle('hermes:bootstrap:get', withTrust(async () => ({
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: Date.now(),
    unsupportedPlatform: null,
  })));
  ipcMain.handle('hermes:bootstrap:reset', withTrust(async () => ({ ok: true })));
  ipcMain.handle('hermes:bootstrap:repair', withTrust(async () => ({ ok: true })));
  ipcMain.handle('hermes:bootstrap:cancel', withTrust(async () => ({ ok: false, cancelled: false })));

  ipcMain.handle('hermes:connection-config:get', withTrust(async (_event, profile) => defaultConnectionConfig(profile)));
  ipcMain.handle('hermes:connection-config:save', withTrust(async (_event, payload = {}) => defaultConnectionConfig(payload.profile)));
  ipcMain.handle('hermes:connection-config:apply', withTrust(async (_event, payload = {}) => defaultConnectionConfig(payload.profile)));
  ipcMain.handle('hermes:connection-config:test', withTrust(async (_event, payload = {}) => {
    const conn = await connection(payload.profile);
    const status = await fetchJson(`${conn.baseUrl}/api/status`, conn.token, { timeoutMs: 8_000 });
    return { ok: true, baseUrl: conn.baseUrl, version: status?.version || null };
  }));
  ipcMain.handle('hermes:connection-config:probe', withTrust(async (_event, rawUrl) => ({
    baseUrl: String(rawUrl || ''),
    reachable: false,
    authMode: 'unknown',
  })));
  ipcMain.handle('hermes:connection-config:oauth-login', withTrust(async (_event, rawUrl) => ({
    ok: false,
    baseUrl: String(rawUrl || ''),
    connected: false,
  })));
  ipcMain.handle('hermes:connection-config:oauth-logout', withTrust(async () => ({ ok: true, connected: false })));

  ipcMain.handle('hermes:profile:get', withTrust(async () => store.hermesDesktopGetActiveProfile()));
  ipcMain.handle('hermes:profile:set', withTrust(async (event, name) => {
    const result = await store.hermesDesktopSetActiveProfile({ profile: name });
    // Reload only on a real switch: re-selecting the active lane keeps the
    // backend and webview alive, so the in-flight chat (and its websocket-
    // bound event stream) survives the click.
    if (result?.changed !== false) {
      setTimeout(() => {
        loadHermesProfileRoot(event.sender, result?.profile || name);
      }, 50);
    }
    return result;
  }));

  ipcMain.handle('hermes:api', withTrust(async (_event, request = {}) => {
    const conn = await connection(request.profile);
    const requestedPath = safeApiPath(request.path);
    // Alias the SPA's operator id ('<op>') to the profile the backend actually
    // serves ('default' for an identity-home sidecar) so profile-scoped GETs
    // resolve instead of 404ing. Responses are still tagged with the operator
    // id (conn.profile) so the SPA's own profile view stays consistent.
    const apiPath = aliasApiPathProfile(requestedPath, conn.backendProfile);
    // Cron job create/update bodies are scrubbed of session-attach fields and
    // implicit broadcast delivery (hermes-home-chat.cts): embed-created cron
    // runs stay isolated, and the home chat only ever gains cron output via
    // the exactly-once home-delivery relay — never a second writer.
    const body = isCronJobMutation(requestedPath, request.method)
      ? sanitizeCronJobMutationBody(request.body, request.method)
      : request.body;
    // GETs ride the boot-retry wrapper so the SPA's first /api/profiles/sessions
    // call doesn't latch the boot overlay on a transient route-not-mounted 404
    // (see fetchJsonWithBootRetry). Mutations go straight through — never retried.
    const response = await fetchJsonWithBootRetry(`${conn.baseUrl}${apiPath}`, conn.token, {
      method: request.method || 'GET',
      body,
      timeoutMs: request.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
    });
    return tagSessionResponseProfile(requestedPath, response, conn.profile || request.profile);
  }));

  ipcMain.handle('hermes:notify', withTrust(async () => false));
  ipcMain.handle('hermes:get-remote-display-reason', withTrust(async () => remoteDisplayReasonForBridge(process.env, platform)));
  ipcMain.handle('hermes:requestMicrophoneAccess', withTrust(async () => {
    if (platform !== 'darwin') return true;
    const status = typeof systemPreferences.getMediaAccessStatus === 'function'
      ? systemPreferences.getMediaAccessStatus('microphone')
      : 'unknown';
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') return false;
    if (typeof systemPreferences.askForMediaAccess !== 'function') return false;
    // Hermes can issue this request from more than one mounted voice control.
    // Coalesce them so a first-time grant creates one OS request, while an
    // existing grant never re-enters the TCC prompt path.
    if (!microphoneAccessRequest) {
      microphoneAccessRequest = Promise.resolve(systemPreferences.askForMediaAccess('microphone'))
        .then(Boolean)
        .finally(() => {
          microphoneAccessRequest = null;
        });
    }
    return microphoneAccessRequest;
  }));
  ipcMain.handle('hermes:readFileDataUrl', withTrust(async (_event, filePath) => {
    const resolved = safeResolvedPath(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('File preview path is not a file');
    if (stat.size > DATA_URL_READ_MAX_BYTES) throw new Error('File is too large to preview');
    const data = fs.readFileSync(resolved);
    return `data:${mimeTypeForPath(resolved)};base64,${data.toString('base64')}`;
  }));
  ipcMain.handle('hermes:readFileText', withTrust(async (_event, filePath) => {
    const resolved = safeResolvedPath(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Text preview path is not a file');
    const size = Math.min(stat.size, TEXT_PREVIEW_MAX_BYTES);
    const fd = fs.openSync(resolved, 'r');
    try {
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
      const sample = buffer.subarray(0, Math.min(bytesRead, 4096));
      return {
        binary: looksBinary(sample),
        byteSize: stat.size,
        language: PREVIEW_LANGUAGE_BY_EXT[path.extname(resolved).toLowerCase()] || 'text',
        mimeType: mimeTypeForPath(resolved),
        path: resolved,
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: stat.size > TEXT_PREVIEW_MAX_BYTES,
      };
    } finally {
      fs.closeSync(fd);
    }
  }));
  ipcMain.handle('hermes:selectPaths', withTrust(async (event, options = {}) => {
    const properties = options.directories ? ['openDirectory'] : ['openFile'];
    if (options.multiple !== false) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(windowForSender(event), {
      title: options.title || 'Add context',
      defaultPath: options.defaultPath ? safeResolvedPath(options.defaultPath) : undefined,
      properties,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
    });
    return result.canceled ? [] : result.filePaths;
  }));
  ipcMain.handle('hermes:writeClipboard', withTrust(async (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  }));
  ipcMain.handle('hermes:saveImageFromUrl', withTrust(async (_event, url) => {
    if (typeof fetch !== 'function') return false;
    const res = await fetch(String(url || ''));
    if (!res.ok) return false;
    const ext = path.extname(new URL(String(url)).pathname) || '.png';
    const buffer = Buffer.from(await res.arrayBuffer());
    const out = path.join(app.getPath('temp'), `hermes-image-${Date.now()}${ext}`);
    fs.writeFileSync(out, buffer);
    return true;
  }));
  ipcMain.handle('hermes:saveImageBuffer', withTrust(async (_event, payload = {}) => {
    const ext = String(payload.ext || '.png').replace(/[^a-z0-9.]/gi, '') || '.png';
    const buffer = Buffer.from(payload.data || []);
    const out = path.join(app.getPath('temp'), `hermes-image-${Date.now()}${ext.startsWith('.') ? ext : `.${ext}`}`);
    fs.writeFileSync(out, buffer);
    return out;
  }));
  ipcMain.handle('hermes:saveClipboardImage', withTrust(async () => {
    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return '';
    const out = path.join(app.getPath('temp'), `hermes-clipboard-${Date.now()}.png`);
    fs.writeFileSync(out, image.toPNG());
    return out;
  }));
  const stopPreviewFileWatch = (id: any) => {
    const key = String(id || '');
    const watcher = previewWatchers.get(key);
    if (!watcher) return false;
    previewWatchers.delete(key);
    try { watcher.close(); } catch {}
    return true;
  };
  ipcMain.handle('hermes:normalizePreviewTarget', withTrust(async (_event, target, baseDir) =>
    normalizePreviewTargetForBridge(target, baseDir, app)
  ));
  ipcMain.handle('hermes:watchPreviewFile', withTrust(async (event, rawUrl) => {
    const filePath = fileURLToPath(String(rawUrl || ''));
    if (!fs.statSync(filePath).isFile()) throw new Error('Preview target is not a file');
    const id = crypto.randomUUID();
    const targetName = path.basename(filePath);
    let timer: any = null;
    const watcher = fs.watch(path.dirname(filePath), (_eventType: any, filename: any) => {
      const changedName = filename ? path.basename(String(filename)) : '';
      if (changedName && changedName !== targetName) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          if (!fs.statSync(filePath).isFile() || event.sender?.isDestroyed?.()) return;
          event.sender?.send?.('hermes:preview-file-changed', {
            id,
            path: filePath,
            url: pathToFileURL(filePath).toString(),
          });
        } catch {}
      }, PREVIEW_WATCH_DEBOUNCE_MS);
    });
    previewWatchers.set(id, {
      close: () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    });
    try { event.sender?.once?.('destroyed', () => stopPreviewFileWatch(id)); } catch {}
    return { id, path: filePath };
  }));
  ipcMain.handle('hermes:stopPreviewFileWatch', withTrust(async (_event, id) => stopPreviewFileWatch(id)));
  ipcMain.on('hermes:titlebar-theme', () => {});
  ipcMain.on('hermes:native-theme', () => {});
  ipcMain.on('hermes:translucency', () => {});
  ipcMain.on('hermes:previewShortcutActive', () => {});
  ipcMain.handle('hermes:openExternal', withTrust(async (_event, url) => {
    const raw = String(url || '');
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'mailto:', 'file:'].includes(parsed.protocol)) {
      throw new Error('Invalid external URL');
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      sendHermesDesktopOpenLink(windowForSender(_event)?.webContents, parsed.toString())
    ) {
      return true;
    }
    await shell.openExternal(raw);
    return true;
  }));
  ipcMain.handle('hermes:openPreviewInBrowser', withTrust(async (event, url) => {
    const raw = String(url || '');
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      throw new Error('Invalid preview URL');
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      sendHermesDesktopOpenLink(windowForSender(event)?.webContents, parsed.toString())
    ) {
      return true;
    }
    await shell.openExternal(parsed.toString());
    return true;
  }));
  ipcMain.handle('hermes:fetchLinkTitle', withTrust(async () => ''));
  ipcMain.handle('hermes:workspace:sanitize', withTrust(async (_event, cwd) => sanitizeWorkspaceCwdForBridge(cwd, app)));
  ipcMain.handle('hermes:zoom:get', withTrust(async (event) => {
    const level = event.sender?.getZoomLevel?.() || 0;
    return { level, percent: zoomLevelToPercent(level) };
  }));
  ipcMain.on('hermes:zoom:set-percent', (event, percent) => {
    try {
      assertTrustedSender(event, trustOptions);
      const level = percentToZoomLevel(percent);
      event.sender?.setZoomLevel?.(level);
      event.sender?.send?.('hermes:zoom:changed', { level, percent: zoomLevelToPercent(level) });
    } catch {}
  });

  ipcMain.handle('hermes:setting:defaultProjectDir:get', withTrust(async () => ({
    dir: null,
    defaultLabel: path.join(os.homedir(), 'hermes-projects'),
  })));
  ipcMain.handle('hermes:setting:defaultProjectDir:set', withTrust(async (_event, dir) => ({ dir: dir || null })));
  ipcMain.handle('hermes:setting:defaultProjectDir:pick', withTrust(async (event) => {
    const result = await dialog.showOpenDialog(windowForSender(event), {
      title: 'Choose default project directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: os.homedir(),
    });
    return result.canceled || result.filePaths.length === 0
      ? { canceled: true, dir: null }
      : { canceled: false, dir: result.filePaths[0] };
  }));

  ipcMain.handle('hermes:logs:reveal', withTrust(async () => ({ ok: false, path: '', error: 'logs are managed by Ace' })));
  ipcMain.handle('hermes:logs:recent', withTrust(async () => ({ path: '', lines: [] })));
  ipcMain.handle('hermes:fs:readDir', withTrust(async (_event, dirPath) => {
    const resolved = safeResolvedPath(dirPath);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((d) => !HIDDEN_DIRS.has(d.name))
        .map((d) => ({ name: d.name, path: path.join(resolved, d.name), isDirectory: d.isDirectory() }))
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      return { entries };
    } catch (err) {
      return { entries: [], error: err?.code || 'read-error' };
    }
  }));
  ipcMain.handle('hermes:fs:gitRoot', withTrust(async (_event, startPath) => findGitRoot(startPath)));
  ipcMain.handle('hermes:fs:reveal', withTrust(async (_event, targetPath) => {
    const target = String(targetPath || '').trim();
    if (!target) return false;
    try {
      shell.showItemInFolder(target);
      return true;
    } catch {
      return false;
    }
  }));
  ipcMain.handle('hermes:fs:rename', withTrust(async (_event, targetPath, newName) => {
    const source = String(targetPath || '').trim();
    const name = String(newName || '').trim();
    if (!source || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error('Invalid rename');
    }
    const destination = path.join(path.dirname(source), name);
    if (destination === source) return { path: destination };
    if (fs.existsSync(destination)) throw new Error(`"${name}" already exists`);
    await fs.promises.rename(source, destination);
    return { path: destination };
  }));
  ipcMain.handle('hermes:fs:writeText', withTrust(async (_event, filePath, content) => {
    const raw = String(filePath || '').trim();
    const text = String(content ?? '');
    if (!raw) throw new Error('Invalid path');
    if (Buffer.byteLength(text, 'utf8') > TEXT_PREVIEW_MAX_BYTES) throw new Error('Content too large');
    const resolved = safeResolvedPath(raw, '');
    if (!resolved || !directoryExists(path.dirname(resolved))) {
      throw new Error('Parent directory does not exist');
    }
    await fs.promises.writeFile(resolved, text, 'utf8');
    return { path: resolved };
  }));
  ipcMain.handle('hermes:fs:trash', withTrust(async (_event, targetPath) => {
    const target = String(targetPath || '').trim();
    if (!target) throw new Error('Invalid delete');
    await shell.trashItem(target);
    return true;
  }));

  // Reuse the sidecar's authenticated, path-hardened git implementation for
  // the embedded renderer. This keeps Ace and the standalone desktop on one
  // contract without duplicating worktree/review mutation logic in Electron.
  ipcMain.handle('hermes:git:repoStatus', withTrust(async (_event, repoPath) =>
    callApi(apiPathWithQuery('/api/git/status', { path: repoPath }))
  ));
  ipcMain.handle('hermes:git:worktreeList', withTrust(async (_event, repoPath) => {
    const result: any = await callApi(apiPathWithQuery('/api/git/worktrees', { path: repoPath }));
    return result?.worktrees || [];
  }));
  ipcMain.handle('hermes:git:branchList', withTrust(async (_event, repoPath) => {
    const result: any = await callApi(apiPathWithQuery('/api/git/branches', { path: repoPath }));
    return result?.branches || [];
  }));
  ipcMain.handle('hermes:git:fileDiff', withTrust(async (_event, repoPath, filePath) => {
    const result: any = await callApi(apiPathWithQuery('/api/git/file-diff', { path: repoPath, file: filePath }));
    return result?.diff || '';
  }));
  ipcMain.handle('hermes:git:review:list', withTrust(async (_event, repoPath, scope, baseRef) =>
    callApi(apiPathWithQuery('/api/git/review/list', { path: repoPath, scope, base: baseRef }))
  ));
  ipcMain.handle('hermes:git:review:diff', withTrust(async (_event, repoPath, filePath, scope, baseRef, staged) => {
    const result: any = await callApi(apiPathWithQuery('/api/git/review/diff', {
      path: repoPath,
      file: filePath,
      scope,
      base: baseRef,
      staged: Boolean(staged),
    }));
    return result?.diff || '';
  }));
  ipcMain.handle('hermes:git:review:commitContext', withTrust(async (_event, repoPath) =>
    callApi(apiPathWithQuery('/api/git/review/commit-context', { path: repoPath }))
  ));
  ipcMain.handle('hermes:git:review:revParse', withTrust(async (_event, repoPath, ref) => {
    const result: any = await callApi(apiPathWithQuery('/api/git/review/rev-parse', { path: repoPath, ref }));
    return result?.sha || null;
  }));
  ipcMain.handle('hermes:git:review:shipInfo', withTrust(async (_event, repoPath) =>
    callApi(apiPathWithQuery('/api/git/review/ship-info', { path: repoPath }))
  ));
  const gitPost = (route: string, body: any) => callApi(route, { method: 'POST', body });
  ipcMain.handle('hermes:git:review:stage', withTrust(async (_event, repoPath, filePath) =>
    gitPost('/api/git/review/stage', { path: repoPath, file: filePath ?? null })
  ));
  ipcMain.handle('hermes:git:review:unstage', withTrust(async (_event, repoPath, filePath) =>
    gitPost('/api/git/review/unstage', { path: repoPath, file: filePath ?? null })
  ));
  ipcMain.handle('hermes:git:review:revert', withTrust(async (_event, repoPath, filePath) =>
    gitPost('/api/git/review/revert', { path: repoPath, file: filePath ?? null })
  ));
  ipcMain.handle('hermes:git:review:commit', withTrust(async (_event, repoPath, message, push) =>
    gitPost('/api/git/review/commit', { path: repoPath, message, push: Boolean(push) })
  ));
  ipcMain.handle('hermes:git:review:push', withTrust(async (_event, repoPath) =>
    gitPost('/api/git/review/push', { path: repoPath })
  ));
  ipcMain.handle('hermes:git:review:createPr', withTrust(async (_event, repoPath) =>
    gitPost('/api/git/review/create-pr', { path: repoPath })
  ));
  ipcMain.handle('hermes:git:worktreeAdd', withTrust(async (_event, repoPath, options = {}) =>
    gitPost('/api/git/worktree/add', { path: repoPath, ...options })
  ));
  ipcMain.handle('hermes:git:worktreeRemove', withTrust(async (_event, repoPath, worktreePath, options = {}) =>
    gitPost('/api/git/worktree/remove', {
      path: repoPath,
      worktreePath,
      force: Boolean(options.force),
    })
  ));
  ipcMain.handle('hermes:git:branchSwitch', withTrust(async (_event, repoPath, branch) =>
    gitPost('/api/git/branch/switch', { path: repoPath, branch })
  ));
  ipcMain.handle('hermes:git:scanRepos', withTrust(async (_event, roots, options) => {
    try {
      return await scanGitReposForBridge(roots || [], options || {});
    } catch {
      return [];
    }
  }));
  ipcMain.handle('hermes:vscode-theme:search', withTrust(async () => {
    throw new Error('Marketplace theme installation is available in the standalone Hermes app.');
  }));
  ipcMain.handle('hermes:vscode-theme:fetch', withTrust(async () => {
    throw new Error('Marketplace theme installation is available in the standalone Hermes app.');
  }));

  ipcMain.handle('hermes:terminal:start', withTrust(async (event, payload = {}) => {
    if (!nodePty) throw new Error('PTY support is unavailable in this Ace build.');
    const id = crypto.randomUUID();
    const { command, args, name } = terminalShellCommand();
    const cwd = safeResolvedPath(payload.cwd, os.homedir());
    const cols = Math.max(2, Number.parseInt(String(payload.cols || 80), 10) || 80);
    const rows = Math.max(2, Number.parseInt(String(payload.rows || 24), 10) || 24);
    const proc = nodePty.spawn(command, args, {
      cols,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      name: 'xterm-256color',
      rows,
    });
    terminalSessions.set(id, proc);
    const send = (suffix, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(`hermes:terminal:${id}:${suffix}`, payload);
    };
    proc.onData((data) => send('data', data));
    proc.onExit(({ exitCode, signal }) => {
      terminalSessions.delete(id);
      send('exit', { code: exitCode, signal: signal || null });
    });
    event.sender.once('destroyed', () => {
      try { proc.kill(); } catch {}
      terminalSessions.delete(id);
    });
    return { cwd, id, shell: name };
  }));
  ipcMain.handle('hermes:terminal:write', withTrust(async (_event, id, data) => {
    const proc = terminalSessions.get(String(id || ''));
    if (!proc) return false;
    proc.write(String(data || ''));
    return true;
  }));
  ipcMain.handle('hermes:terminal:resize', withTrust(async (_event, id, size = {}) => {
    const proc = terminalSessions.get(String(id || ''));
    if (!proc) return false;
    proc.resize(Math.max(2, Number(size.cols) || 80), Math.max(2, Number(size.rows) || 24));
    return true;
  }));
  ipcMain.handle('hermes:terminal:dispose', withTrust(async (_event, id) => {
    const proc = terminalSessions.get(String(id || ''));
    if (!proc) return false;
    terminalSessions.delete(String(id || ''));
    try { proc.kill(); } catch {}
    return true;
  }));

  ipcMain.handle('hermes:version', withTrust(async () => {
    const result = await store.hermesDesktopEnsure({});
    return {
      appVersion: result?.desktopAppVersion || app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      hermesRoot: result?.desktopAppPath || '',
    };
  }));
  ipcMain.handle('hermes:updates:check', withTrust(async () => ({
    supported: false,
    reason: 'embedded',
    message: 'Use the standalone Hermes app to update Hermes Desktop.',
  })));
  ipcMain.handle('hermes:updates:apply', withTrust(async () => ({
    ok: false,
    manual: true,
    command: 'hermes update',
    message: 'Use the standalone Hermes app to update Hermes Desktop.',
  })));
  ipcMain.handle('hermes:updates:branch:get', withTrust(async () => ({ branch: 'main' })));
  ipcMain.handle('hermes:updates:branch:set', withTrust(async (_event, name) => ({ branch: name || 'main' })));
  ipcMain.handle('hermes:uninstall:summary', withTrust(async () => ({
    hermes_home: '',
    agent_installed: true,
    gui_installed: true,
    source_built_artifacts: [],
    packaged_app_paths: [],
    userdata_dir: app.getPath('userData'),
    userdata_exists: true,
    platform: process.platform,
    running_app_path: null,
  })));
  ipcMain.handle('hermes:uninstall:run', withTrust(async () => ({
    ok: false,
    message: 'Uninstall is available from the standalone Hermes app.',
  })));
}

module.exports = {
  apiPathWithQuery,
  aliasApiPathProfile,
  fetchJsonWithBootRetry,
  isBootRetryableError,
  BOOT_RETRY_STATUS,
  BOOT_RETRY_MAX_ATTEMPTS,
  hermesProfileRootUrl,
  loadHermesProfileRoot,
  normalizePreviewTargetForBridge,
  percentToZoomLevel,
  registerHermesDesktopBridge,
  remoteDisplayReasonForBridge,
  scanGitReposForBridge,
  sanitizeWorkspaceCwdForBridge,
  senderIsTrusted,
  tagSessionResponseProfile,
  zoomLevelToPercent,
};
