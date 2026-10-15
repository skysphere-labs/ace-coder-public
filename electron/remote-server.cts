

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { writePasteImage } = require('./paste-store.cjs');
const { injectHermesDesktopEmbedShim } = require('./hermes-desktop-embed-shim.cts');

let WebSocketServer: any = null;
try {
  ({ WebSocketServer } = require('ws'));
} catch (err: any) {
  console.error('[ace] ws package unavailable:', err.message);
}

let Bonjour: any = null;
try {
  Bonjour = require('bonjour-service').default || require('bonjour-service').Bonjour;
} catch {

}

const DEFAULT_PORT = 9419;
const ENROLL_TTL_MS = 5 * 60 * 1000;
const REMOTE_TOKEN_COOKIE = 'ace.remoteToken';
const HERMES_DESKTOP_PROXY_PREFIX = '/hermes-desktop';
const HERMES_DESKTOP_CLIPBOARD_PERMISSIONS_POLICY = 'clipboard-read=(self), clipboard-write=(self)';
const MIME: any = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// Text-ish assets worth compressing over the tunnel. Fonts/images/wasm are
// already compressed, so re-encoding them only burns CPU for no size win.
const COMPRESSIBLE_EXT = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt', '.webmanifest',
]);
// Below this, compression framing overhead outweighs the savings.
const COMPRESS_MIN_BYTES = 1024;

// Prefer brotli (better ratio, still cheap at quality 5) then gzip. Returns
// null when the client advertised neither so we fall back to identity.
function negotiateEncoding(req: any): 'br' | 'gzip' | null {
  const ae = typeof req?.headers?.['accept-encoding'] === 'string'
    ? req.headers['accept-encoding']
    : '';
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

// Streaming compressor so a file is never buffered whole and the event loop
// (shared with every agent's PTY pump) is never blocked on a sync deflate.
function compressStream(encoding: 'br' | 'gzip') {
  return encoding === 'br'
    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : zlib.createGzip({ level: 6 });
}

// Full-state getState() envelopes are large JSON; compressing them turns a
// multi-hundred-KB tunnel transfer into tens of KB. Async so main never
// blocks on the deflate; identity fallback keeps error/enroll bodies simple.
function jsonResponse(res: any, status: any, body: any, req?: any) {
  const payload = Buffer.from(JSON.stringify(body));
  const encoding = payload.length >= COMPRESS_MIN_BYTES ? negotiateEncoding(req) : null;
  const sendIdentity = () => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  if (!encoding) return sendIdentity();
  const done = (err: any, compressed: Buffer) => {
    if (err) return sendIdentity();
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': encoding,
      'content-length': compressed.length,
      'cache-control': 'no-store',
      vary: 'Accept-Encoding',
    });
    res.end(compressed);
  };
  if (encoding === 'br') {
    zlib.brotliCompress(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
  } else {
    zlib.gzip(payload, { level: 6 }, done);
  }
}

function sendText(res: any, status: any, text: any) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
  });
  res.end(payload);
}

function withHermesDesktopClipboardPolicy(headers: any = {}) {
  const next = { ...(headers || {}) };
  delete next['permissions-policy'];
  delete next['Permissions-Policy'];
  delete next['feature-policy'];
  delete next['Feature-Policy'];
  next['permissions-policy'] = HERMES_DESKTOP_CLIPBOARD_PERMISSIONS_POLICY;
  return next;
}

function htmlWithRemoteBase(data: any) {
  const html = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (/<base\s/i.test(html)) return Buffer.from(html, 'utf8');
  const withBase = html.replace(
    /<head(\s[^>]*)?>/i,
    (match: string) => `${match}\n    <base href="/" data-ace-remote-base />`
  );
  return Buffer.from(withBase, 'utf8');
}

function sendIndexHtml(res: any, data: any) {
  const payload = htmlWithRemoteBase(data);
  res.writeHead(200, {
    'content-type': MIME['.html'],
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function staticCacheHeaders(relPath: string, ext: string) {
  if (
    relPath === '/sw.js' ||
    relPath === '/registerSW.js' ||
    ext === '.webmanifest'
  ) {
    return { 'cache-control': 'no-store' };
  }
  // Vite emits content-hashed filenames under /assets (a new build changes the
  // hash → a new URL), and the copied material-icons set is content-stable. So
  // a phone can cache them for a year and skip re-downloading ~2MB of JS/CSS on
  // every reload; `immutable` also suppresses revalidation round-trips over the
  // tunnel. index.html itself stays no-store (served via sendIndexHtml).
  if (relPath.startsWith('/assets/') || relPath.startsWith('/material-icons/')) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  return {};
}

function tokenFromCookie(headerValue: any) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  for (const part of headerValue.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== REMOTE_TOKEN_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

function rewriteHermesDesktopProxyText(text: string, contentType: string) {
  const prefix = HERMES_DESKTOP_PROXY_PREFIX;
  let out = String(text || '');
  if (/text\/html|application\/xhtml/i.test(contentType)) {
    out = out
      .replace(/window\.__HERMES_BASE_PATH__="[^"]*"/g, `window.__HERMES_BASE_PATH__="${prefix}"`)
      .replace(/\b(src|href)=("|')\/(?!\/)/g, (_m, attr, quote) => `${attr}=${quote}${prefix}/`)
      .replace(/\b(action)=("|')\/(?!\/)/g, (_m, attr, quote) => `${attr}=${quote}${prefix}/`);
    // The Hermes DESKTOP SPA refuses to boot without its window.hermesDesktop
    // preload bridge ("Desktop IPC bridge is unavailable"), and every recovery
    // button on that overlay calls the bridge too. The remote iframe has no
    // preload, so install the same-origin stand-in that mirrors what
    // hermes-desktop-bridge.cts answers on the desktop webview path.
    out = injectHermesDesktopEmbedShim(out);
  }
  if (/text\/css|text\/html|application\/javascript|text\/javascript/i.test(contentType)) {
    out = out
      .replace(/url\((['"]?)\/(?!\/)/g, (_m, quote) => `url(${quote}${prefix}/`)
      .replace(/(["'`])\/(assets|favicon\.ico)(\/?[^"'`]*)\1/g, (_m, quote, first, rest) =>
        `${quote}${prefix}/${first}${rest}${quote}`
      );
  }
  return out;
}

function readBody(req: any, max = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: any[] = [];
    req.on('data', (chunk: any) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hashToken(token: any, salt: any) {
  return crypto.createHmac('sha256', salt).update(token).digest('hex');
}

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function which(bin: any) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

function execFileP(cmd: any, args: any, opts: any = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, ...opts }, (err: any, stdout: any, stderr: any) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function buildTailscaleServeHttpsArgs(port: any) {
  return ['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${port}`];
}

async function ensureTailscaleHttpsProxy(port: any) {
  const tailscale = which('tailscale');
  if (!tailscale) return { ok: false, error: 'tailscale not found' };
  const result: any = await execFileP(tailscale, buildTailscaleServeHttpsArgs(port), { timeout: 12_000 });
  if (result.err) return { ok: false, error: result.stderr || result.err.message };
  return { ok: true };
}

function primaryRemoteUrl(input: any) {
  if (input.tunnelMode === 'loopback') return `http://127.0.0.1:${input.port}`;
  if (input.tunnelMode === 'tailscale' && input.tailscaleHost) {
    if (input.tailscaleHttpsReady) return `https://${input.tailscaleHost}`;
    return `http://${input.tailscaleHost}:${input.port}`;
  }
  const host = input.lanHost || '127.0.0.1';
  return `http://${host}:${input.port}`;
}

async function detectTunnels() {
  const tunnels: any[] = [];
  if (which('tailscale')) {
    let tsHost = null;
    try {
      const r: any = await execFileP('tailscale', ['status', '--json']);
      if (!r.err && r.stdout) {
        const parsed = JSON.parse(r.stdout);
        const dns = parsed?.Self?.DNSName;
        if (dns) tsHost = dns.replace(/\.$/, '');
      }
    } catch {}
    tunnels.push({
      id: 'tailscale',
      name: 'Tailscale',
      recommended: true,
      available: true,
      host: tsHost,
    });
  } else {
    tunnels.push({
      id: 'tailscale',
      name: 'Tailscale',
      recommended: true,
      available: false,
      host: null,
      installUrl: 'https://tailscale.com/download',
    });
  }
  return tunnels;
}

// Serialize a broadcast frame ONCE and hand the identical string to every
// connected client, instead of JSON.stringify-ing the same ~4000-row snapshot
// per client. Stream-scoped channels (pty:data) still branch per subscription
// and must not use this path. Returns the serialized frame (or null if the
// payload could not be encoded) so callers/tests can assert byte-identity.
function broadcastFrameToClients(clients: any, type: any, payload: any) {
  let frame: string;
  try {
    frame = JSON.stringify({ type, payload });
  } catch {
    return null;
  }
  for (const ws of clients) {
    if (!ws || ws.readyState !== 1) continue;
    try {
      ws.send(frame);
    } catch {}
  }
  return frame;
}

function createRemoteServer({
  aceStore,
  aceController = null,
  githubCore = null,
  userDataPath,
  devProxyUrl = null,
}: any) {
  if (!aceStore) throw new Error('aceStore required');
  if (!WebSocketServer) throw new Error('ws package unavailable');

  const events = new EventEmitter();
  events.setMaxListeners(0);




  const state: any = {
    enabled: false,
    port: DEFAULT_PORT,
    lanHost: null,
    tailscaleHost: null,
    tunnelMode: 'lan',
    tailscaleHttpsReady: false,
    tailscaleHttpsError: null,
    serverSecret: '',
  };
  const enrollments = new Map();
  let httpServer: any = null;
  let wsServer: any = null;
  let boundHost: any = null;
  let bonjour: any = null;
  let bonjourService: any = null;
  const connectedClients = new Set();
  const hermesProxySockets = new Set();
  let stateForwarderOff: any = null;
  let usageForwarderOff: any = null;

  function getAllowlist() {




    const entries = new Set();
    const port = state.port;
    const add = (host: any) => entries.add(String(host).toLowerCase());
    add(`127.0.0.1:${port}`);
    add(`localhost:${port}`);
    add(`[::1]:${port}`);
    if (state.lanHost) add(`${state.lanHost}:${port}`);
    if (state.tailscaleHost) {
      add(`${state.tailscaleHost}:${port}`);
      add(`${state.tailscaleHost}:443`);
      add(state.tailscaleHost);
    }
    return entries;
  }

  function hostMatches(header: any) {
    if (!header) return false;
    return getAllowlist().has(String(header).toLowerCase());
  }

  function originMatches(header: any) {
    if (!header) return false;
    try {
      const u = new URL(header);
      return getAllowlist().has(u.host.toLowerCase());
    } catch {
      return false;
    }
  }

  function applyCors(req: any, res: any) {
    const origin = req.headers.origin;
    if (origin && originMatches(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
  }

  function refreshSettings() {
    const row = aceStore.getRemoteSettings();
    state.enabled = !!row.enabled;
    state.port = row.port || DEFAULT_PORT;
    state.serverSecret = row.serverSecret || '';
    // Old or unsupported exposure modes never widen the listening interface.
    state.tunnelMode = ['lan', 'tailscale', 'loopback'].includes(row.tunnelMode) ? row.tunnelMode : 'loopback';
    return row;
  }

  function desiredBindHost() {
    return state.tunnelMode === 'loopback' ? '127.0.0.1' : '0.0.0.0';
  }

  function deviceIsRevoked(deviceId: any) {
    if (!deviceId || typeof aceStore.listRemoteDevices !== 'function') return false;
    try {
      return aceStore.listRemoteDevices().some((device: any) => device.id === deviceId && device.revoked);
    } catch {
      return false;
    }
  }

  function closeDeviceConnections(deviceId: any, reason = 'device revoked') {
    if (!deviceId) return;
    for (const ws of connectedClients) {
      if ((ws as any).aceDeviceId !== deviceId) continue;
      try { (ws as any).close(4003, reason); } catch {}
      try { (ws as any).terminate?.(); } catch {}
    }
    for (const socket of [...hermesProxySockets]) {
      if ((socket as any).aceDeviceId !== deviceId) continue;
      try { (socket as any).destroy(); } catch {}
    }
  }

  if (typeof aceStore.onRemoteDevicesChanged === 'function') {
    aceStore.onRemoteDevicesChanged((devices: any[] = []) => {
      for (const device of devices) {
        if (device?.revoked) closeDeviceConnections(device.id);
      }
    });
  }


  function validateBearer(headerValue: any) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (!m) return null;
    const token = m[1].trim();
    if (!token) return null;
    const tokenHash = hashToken(token, state.serverSecret);
    const device = aceStore.findRemoteDeviceByHash(tokenHash);
    if (!device || device.revoked) return null;
    aceStore.touchRemoteDevice(device.id);
    return device;
  }

  function validateRemoteRequest(req: any) {
    return validateBearer(req.headers.authorization) ||
      validateBearer(`Bearer ${tokenFromCookie(req.headers.cookie) || ''}`);
  }






  const METHOD_ALIAS: any = {

    // ops-v2: renderer method names whose store methods differ (mobile/remote
    // Operations parity — without these the HTTP bridge 404s).
    opsSignals: 'streamOperationsSignals',
    opsRecommendations: 'streamOperationsRecommendations',
    opsBrief: 'streamOperationsBrief',
    opsIntel: 'streamOperationsIntel',
    opsRefresh: 'opsRefreshSources',
    missionMove: 'missionMoveFeature',
    missionAssign: 'missionAssignFeature',

    skillsGetCatalog: 'getSkillsCatalog',
    skillsRefreshCatalog: 'refreshSkillsCatalog',
    skillsGetDetail: 'getSkillDetail',
    skillsSearch: 'searchSkillsSh',
    skillsInstall: 'installSkill',
    skillsUninstall: 'uninstallSkill',
    skillsCreate: 'createSkill',
    skillsDetectedAgents: 'getDetectedSkillAgents',

    mcpLoadAll: 'loadMcp',
    mcpSaveServer: 'saveMcpServer',
    mcpRemoveServer: 'removeMcpServer',
    mcpGetProviders: 'getMcpProviders',

    gitStatus: 'getGitStatus',
    gitLog: 'getTaskGitLog',
    gitShow: 'getCommitDetail',
    gitShowFile: 'getCommitFileDiff',
    gitDiffFile: 'getFileDiff',
    gitStage: 'stageFiles',
    gitUnstage: 'unstageFiles',
    gitStageAll: 'stageAll',
    gitUnstageAll: 'unstageAll',
    gitCommit: 'commitChanges',
    gitRevert: 'revertCommit',
    gitReset: 'resetToCommit',
    gitPush: 'pushChanges',
    gitCreatePR: 'createPR',

    getAgentCatalog: 'getAgentCatalog',
    startInstallAgent: 'startInstallAgent',
    getStarredAgents: 'getStarredAgents',
    setAgentStarred: 'setAgentStarred',

    remoteListDevices: 'listRemoteDevices',
    remoteRevokeDevice: 'revokeRemoteDevice',

    listWorkspaceFiles: 'listTaskFiles',
    readWorkspaceFile: 'readTaskFile',
    writeWorkspaceFile: 'writeTaskFile',
    createWorkspaceFile: 'createTaskFile',
    createWorkspaceFolder: 'createTaskFolder',
    renameWorkspacePath: 'renameTaskPath',
    deleteWorkspacePath: 'deleteTaskPath',
    revealWorkspacePath: 'revealTaskPath',

    setTaskAutoApprove: 'setTaskAutoApprove',

    browseLocalDir: 'browseLocalDir',
  };

  // Methods on githubCore — same naming pattern as CHAT_STORE_METHOD.
  const GITHUB_METHOD: any = {
    githubIsAvailable: 'isAvailable',
    githubRefreshAvailability: 'refreshAvailability',
    githubListAccounts: 'listAccounts',
    githubSwitchAccount: 'switchAccount',
    githubLoginStart: 'loginStart',
    githubLoginPoll: 'loginPoll',
    githubLoginCancel: 'loginCancel',
    githubRemoveAccount: 'removeAccount',
    githubListRepos: 'listRepos',
    githubListStars: 'listStars',
    githubListTrending: 'listTrending',
    githubCloneRepo: 'cloneRepo',
    githubFetchContributions: 'fetchContributions',
    githubStarRepo: 'starRepo',
    githubUnstarRepo: 'unstarRepo',
  };


  let _getProviderUsage: any = null;
  try {
    _getProviderUsage = require('./usage-core.cjs').getProviderUsage;
  } catch {}

  async function invokeMethod(method: any, payload: any, device: any) {
    if (method === 'getState') return aceStore.getState();
    if (method === 'seedState') return aceStore.seedState();


    if (method === 'pickDirectory') return { path: null };
    if (method === 'openFolder') return { ok: false };
    if (method === 'openExternal') return { ok: false };
    if (method === 'revealTaskPath' || method === 'revealWorkspacePath') return { ok: false };

    if (method === 'usageGetProviders') {
      if (!_getProviderUsage) return { providers: [], generatedAt: Date.now() };
      return _getProviderUsage();
    }

    // Private service routes stay unavailable even if a legacy store exposes
    // a similarly named method. Pairing remains mandatory for every API call.
    if (
      /^(tickets|controlPlane|cloudflare|remoteCloudflare|remoteSetCloudflare|setRemoteCloudflare)/i.test(String(method)) ||
      /^update(GetStatus|Check|Download|Install|SetChannel|SetAutoCheck)$/.test(String(method))
    ) {
      const error: any = new Error('This service is not available in ACE CODER.');
      error.status = 404;
      throw error;
    }

    if (method === 'operatorsList') {
      if (!userDataPath) {
        const err: any = new Error('operator config unavailable on this host.');
        err.status = 503;
        throw err;
      }
      const operators = require('./operators.cts');
      return operators.loadOperatorsConfig(userDataPath);
    }

    if (method === 'operatorsSave') {
      if (!userDataPath) {
        const err: any = new Error('operator config unavailable on this host.');
        err.status = 503;
        throw err;
      }
      const operators = require('./operators.cts');
      operators.saveOperatorsConfig(userDataPath, payload?.config);
      return { ok: true };
    }


    if (method === 'remoteGetStatus' || method === 'getRemoteSettings') return getStatus();
    if (method === 'remoteSetEnabled' || method === 'setRemoteEnabled') return setEnabled(payload?.enabled);
    if (method === 'remoteSetTunnelMode' || method === 'setRemoteTunnelMode') return setTunnelMode(payload?.mode);

    if (method === 'remoteDetectTunnels') {
      const { detectTunnels: dt } = require('./remote-server.cjs');
      return dt();
    }
    if (method === 'remoteMintEnrollment') {
      const token = mintEnrollment();
      const status = getStatus();
      return { token: token.token, expiresAt: token.expiresAt, url: status.primaryUrl, status };
    }

    if (method === 'pasteClipboardImage') {
      try {
        return await writePasteImage({
          bytes: payload?.bytes,
          ext: payload?.ext,
          baseTempDir: os.tmpdir(),
        });
      } catch (err: any) {
        return { path: null, error: err.message };
      }
    }

    const ghMethod = GITHUB_METHOD[method];
    if (ghMethod) {
      if (!githubCore) {
        const err: any = new Error('GitHub unavailable on this host.');
        err.status = 503;
        throw err;
      }
      const ghFn = githubCore[ghMethod];
      if (typeof ghFn !== 'function') {
        const err: any = new Error(`Unknown github method: ${method} (resolved: ${ghMethod})`);
        err.status = 404;
        throw err;
      }
      return ghFn.call(githubCore, payload);
    }

    const storeName = METHOD_ALIAS[method] || method;
    const fn = aceStore[storeName];
    if (typeof fn !== 'function') {
      const err: any = new Error(`Unknown method: ${method} (resolved: ${storeName})`);
      err.status = 404;
      throw err;
    }
    return fn.call(aceStore, payload);
  }



  async function handleRequest(req: any, res: any) {
    try {
      if (req.method === 'OPTIONS') {
        applyCors(req, res);
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);


      if (url.pathname === '/healthz') {
        return sendText(res, 200, 'ok');
      }

      if (!hostMatches(req.headers.host)) {
        return sendText(res, 403, 'forbidden (host)');
      }
      applyCors(req, res);

      if (url.pathname === '/enroll' && req.method === 'POST') {
        return handleEnroll(req, res);
      }

      if (url.pathname.startsWith('/api/')) {
        const device = validateBearer(req.headers.authorization);
        if (!device) return sendText(res, 403, 'forbidden (token)');
        return handleApi(req, res, url, device);
      }

      if (url.pathname === HERMES_DESKTOP_PROXY_PREFIX || url.pathname.startsWith(`${HERMES_DESKTOP_PROXY_PREFIX}/`)) {
        const device = validateRemoteRequest(req);
        if (!device) return sendText(res, 403, 'forbidden (token)');
        return await proxyToHermesDesktop(req, res, url);
      }

      return handleStatic(req, res, url);
    } catch (err) {
      console.error('[ace-remote] request error:', err);
      if (!res.headersSent) sendText(res, 500, 'internal error');
    }
  }

  async function handleEnroll(req: any, res: any) {
    try {
      const raw: any = await readBody(req, 64 * 1024);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const token = body?.enrollmentToken;
      const name = typeof body?.name === 'string' ? body.name.slice(0, 80) : 'Unnamed device';
      if (!token) return jsonResponse(res, 400, { error: 'enrollmentToken required' });
      const record: any = enrollments.get(token);
      if (!record || record.expiresAt < Date.now()) {
        enrollments.delete(token);
        return jsonResponse(res, 403, { error: 'invalid or expired enrollment token' });
      }
      enrollments.delete(token);

      const deviceToken = newToken();
      const tokenHash = hashToken(deviceToken, state.serverSecret);
      const device = aceStore.registerRemoteDevice({ name, tokenHash });
      jsonResponse(res, 200, {
        deviceId: device.id,
        token: deviceToken,
        name: device.name,
      });
    } catch (err: any) {
      jsonResponse(res, 400, { error: err.message });
    }
  }

  async function handleApi(req: any, res: any, url: any, device: any) {
    if (req.method !== 'POST') {
      return sendText(res, 405, 'method not allowed');
    }
    const method = url.pathname.slice('/api/'.length);
    let payload = null;
    try {
      const raw: any = await readBody(req);
      if (raw.length) payload = JSON.parse(raw.toString('utf8'));
    } catch (err: any) {
      return jsonResponse(res, 400, { error: `bad json: ${err.message}` });
    }
    try {
      const result = await invokeMethod(method, payload, device);
      jsonResponse(res, 200, { ok: true, result }, req);
    } catch (err: any) {
      const status = err?.status || 500;
      jsonResponse(res, status, { ok: false, error: err?.message || String(err) });
    }
  }

  async function handleStatic(req: any, res: any, url: any) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'method not allowed');
    }

    if (devProxyUrl) {
      return proxyToVite(req, res, url);
    }
    return serveFromDist(req, res, url);
  }

  function proxyToVite(req: any, res: any, url: any) {
    const proxy = require('http').request(
      {
        host: new URL(devProxyUrl).hostname,
        port: new URL(devProxyUrl).port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...req.headers, host: new URL(devProxyUrl).host },
      },
      (upstream: any) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      }
    );
    proxy.on('error', () => sendText(res, 502, 'dev proxy unavailable'));
    req.pipe(proxy);
  }

  function proxyViteUpgrade(req: any, socket: any, head: any, url: any) {
    if (!devProxyUrl) {
      socket.destroy();
      return;
    }
    if (!hostMatches(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const origin = req.headers.origin;
    if (origin && !originMatches(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }

    const target = new URL(devProxyUrl);
    if (target.protocol !== 'http:') {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return socket.destroy();
    }
    const upstream = net.connect(Number(target.port) || 80, target.hostname);
    upstream.on('connect', () => {
      const headers = { ...(req.headers || {}), host: target.host };
      if (headers.origin) headers.origin = target.origin;
      const lines = [`${req.method || 'GET'} ${url.pathname}${url.search} HTTP/${req.httpVersion || '1.1'}`];
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`);
        } else if (value != null) {
          lines.push(`${key}: ${value}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => {
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
    });
  }

  // Single-sidecar: every request proxies to the one app sidecar (no per-profile
  // sub-proxy), mirroring the desktop webview.
  async function hermesDesktopProxyTarget() {
    const fn = aceStore?.hermesDesktopProxyTarget;
    if (typeof fn !== 'function') return null;
    const target = fn.call(aceStore);
    if (!target || !target.host || !target.port) return null;
    return target;
  }

  function upstreamHermesPath(url: any) {
    let pathname = url.pathname.slice(HERMES_DESKTOP_PROXY_PREFIX.length);
    if (!pathname) pathname = '/';
    return pathname + url.search;
  }

  function hermesProxyHeaders(req: any, target: any) {
    const headers = { ...(req.headers || {}) };
    headers.host = `${target.host}:${target.port}`;
    if (headers.origin) headers.origin = `http://${target.host}:${target.port}`;
    // Forward `authorization` UNLESS it is Ace's own device credential:
    // the embedded SPA authenticates to its OWN sidecar with the session
    // token the sidecar injected into the page (Bearer
    // __HERMES_SESSION_TOKEN__), and stripping that 401s every protected
    // /api route behind the proxy. A Ace device token (the alternative
    // auth validateRemoteRequest accepts on this route) must still never
    // reach the sidecar process — same hygiene as the cookie strip below.
    if (headers.authorization && validateBearer(headers.authorization)) {
      delete headers.authorization;
    }
    delete headers['proxy-authorization'];
    delete headers.cookie;
    delete headers['content-length'];
    return headers;
  }

  function trackHermesProxySocket(socket: any, deviceId: any = null) {
    if (deviceId) socket.aceDeviceId = deviceId;
    hermesProxySockets.add(socket);
    const cleanup = () => hermesProxySockets.delete(socket);
    try { socket.once?.('close', cleanup); } catch {}
    try { socket.once?.('error', cleanup); } catch {}
  }

  async function proxyToHermesDesktop(req: any, res: any, url: any) {
    const target = await hermesDesktopProxyTarget();
    if (!target) return sendText(res, 503, 'Hermes Desktop is starting');
    const upstreamReq = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: upstreamHermesPath(url),
        headers: hermesProxyHeaders(req, target),
      },
      (upstream: any) => {
        const headers = { ...(upstream.headers || {}) };
        delete headers['content-length'];
        delete headers['x-frame-options'];
        // Strip the Hermes SPA's CSP on the embed path. On desktop the Teams
        // embed drives the SPA with executeJavaScript inside a <webview>; on
        // mobile/remote it's a same-origin <iframe> and the SAME adaptations run
        // via contentWindow.eval (profile-rail read → Ace lane tabs, mobile
        // layout CSS). A passed-through script-src without 'unsafe-eval' silently
        // blocks that eval, which is why mobile Teams showed the bare Hermes
        // Sessions dashboard with no lane tabs. This is the user's own loopback
        // Hermes embedded in their own Ace, mirroring the x-frame-options
        // strip just above.
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        const responseHeaders = withHermesDesktopClipboardPolicy(headers);
        const contentType = String(headers['content-type'] || '');
        if (/text\/html|text\/css|application\/javascript|text\/javascript/i.test(contentType)) {
          const chunks: any[] = [];
          upstream.on('data', (chunk: any) => chunks.push(chunk));
          upstream.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const rewritten = Buffer.from(rewriteHermesDesktopProxyText(body, contentType), 'utf8');
            delete responseHeaders['transfer-encoding'];
            delete responseHeaders['Transfer-Encoding'];
            responseHeaders['content-length'] = rewritten.length;
            res.writeHead(upstream.statusCode || 502, responseHeaders);
            if (req.method !== 'HEAD') res.end(rewritten);
            else res.end();
          });
          upstream.on('error', () => {
            if (!res.headersSent) sendText(res, 502, 'Hermes Desktop proxy failed');
          });
          return;
        }
        res.writeHead(upstream.statusCode || 502, responseHeaders);
        if (req.method === 'HEAD') {
          upstream.resume();
          res.end();
        } else {
          upstream.pipe(res);
        }
      }
    );
    upstreamReq.on('error', () => sendText(res, 502, 'Hermes Desktop proxy unavailable'));
    if (req.method === 'GET' || req.method === 'HEAD') upstreamReq.end();
    else req.pipe(upstreamReq);
  }

  async function handleHermesDesktopUpgrade(req: any, socket: any, head: any, url: any) {
    try {
      if (!hostMatches(req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const origin = req.headers.origin;
      if (origin && !originMatches(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const device = validateRemoteRequest(req);
      if (!device) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const target = await hermesDesktopProxyTarget();
      if (!target) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return socket.destroy();
      }
      const upstream = net.connect(target.port, target.host);
      trackHermesProxySocket(socket, device.id);
      trackHermesProxySocket(upstream, device.id);
      // A phone that locks or backgrounds the PWA can leave a half-open socket
      // that never fires 'close'. Enable TCP keep-alive on both legs so a dead
      // peer is detected, and tear the partner down on close/error. Destroying
      // the upstream when the phone drops gives the sidecar a clean client-gone
      // signal (so its orphan-grace timer runs) instead of leaking a zombie pipe.
      try { socket.setKeepAlive(true, 30_000); } catch {}
      try { upstream.setKeepAlive(true, 30_000); } catch {}
      const closeUpstream = () => { try { upstream.destroy(); } catch {} };
      socket.on('close', closeUpstream);
      socket.on('error', closeUpstream);
      upstream.on('connect', () => {
        const headers = hermesProxyHeaders(req, target);
        const lines = [`GET ${upstreamHermesPath(url)} HTTP/1.1`];
        for (const [key, value] of Object.entries(headers)) {
          if (Array.isArray(value)) {
            for (const item of value) lines.push(`${key}: ${item}`);
          } else if (value != null) {
            lines.push(`${key}: ${value}`);
          }
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => {
        try { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        try { socket.destroy(); } catch {}
      });
      upstream.on('close', () => { try { socket.destroy(); } catch {} });
    } catch {
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
    }
  }

  function serveFromDist(req: any, res: any, url: any) {
    const distDir = path.join(__dirname, '..', 'dist');
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === '/' || !relPath) relPath = '/index.html';
    const abs = path.resolve(distDir, '.' + relPath);
    if (!abs.startsWith(distDir)) return sendText(res, 403, 'forbidden');
    fs.stat(abs, (err: any, stat: any) => {
      if (err || !stat.isFile()) {


        const fallback = path.join(distDir, 'index.html');
        fs.readFile(fallback, (err2: any, data: any) => {
          if (err2) return sendText(res, 404, 'not found');
          sendIndexHtml(res, data);
        });
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      if (ext === '.html') {
        fs.readFile(abs, (readErr: any, data: any) => {
          if (readErr) return sendText(res, 404, 'not found');
          sendIndexHtml(res, data);
        });
        return;
      }
      const cacheHeaders = staticCacheHeaders(relPath, ext);
      const encoding = COMPRESSIBLE_EXT.has(ext) && stat.size >= COMPRESS_MIN_BYTES
        ? negotiateEncoding(req)
        : null;
      if (encoding) {
        // Chunked (no content-length): the compressed size isn't known until
        // the stream finishes, and streaming keeps main off a sync deflate
        // that would stall the shared PTY/websocket event loop.
        res.writeHead(200, {
          'content-type': type,
          'content-encoding': encoding,
          vary: 'Accept-Encoding',
          ...cacheHeaders,
        });
        const source = fs.createReadStream(abs);
        const compressor = compressStream(encoding);
        source.on('error', () => { try { res.destroy(); } catch {} });
        compressor.on('error', () => { try { res.destroy(); } catch {} });
        source.pipe(compressor).pipe(res);
        return;
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': stat.size,
        ...cacheHeaders,
      });
      fs.createReadStream(abs).pipe(res);
    });
  }



  function handleUpgrade(req: any, socket: any, head: any) {
    if (!hostMatches(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const origin = req.headers.origin;
    if (origin && !originMatches(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }




    const protoHeader = req.headers['sec-websocket-protocol'];
    const protocols = String(protoHeader || '')
      .split(',')
      .map((s: any) => s.trim())
      .filter(Boolean);
    const tokenProto = protocols.find((p: any) => p.startsWith('ace-token.'));
    if (!tokenProto) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const token = tokenProto.slice('ace-token.'.length);
    const device = validateBearer(`Bearer ${token}`);
    if (!device) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wsServer.handleUpgrade(req, socket, head, (ws: any) => {
      ws.aceDeviceId = device.id;
      wsServer.emit('connection', ws, req, device);
    });
  }

  function wireConnection(ws: any, _req: any, device: any) {
    connectedClients.add(ws);
    events.emit('client-connect', { deviceId: device.id, total: connectedClients.size });

    const subscribedStreams = new Set();
    // Browser-tab screencast subscriptions for THIS connection: key →
    // {taskId, tabId}. Frames are heavy (base64 JPEG), so they are only
    // forwarded to connections that subscribed to that exact tab, mirroring
    // the pty:data model.
    const browserSubs = new Map();
    const browserSubKey = (taskId: any, tabId: any) => `${taskId}\n${tabId}`;

    const forwarders = [
      // NOTE: 'state' is broadcast once per emit at the server level (see
      // start()), not per client, so it is intentionally absent here. Only
      // stream-scoped / per-client channels stay in this list.
      aceStore.onPtyData((payload: any) => {
        if (subscribedStreams.size > 0 && !subscribedStreams.has(payload.id)) return;
        send('pty:data', payload);
      }),
      aceStore.onPtyExit((payload: any) => send('pty:exit', payload)),
      aceStore.onGitChanged((payload: any) => send('git:changed', payload)),
      aceStore.onInstallData((payload: any) => send('install:data', payload)),
      aceStore.onInstallExit((payload: any) => send('install:exit', payload)),
      aceStore.onStarredAgentsChanged((payload: any) => send('starred:changed', payload)),
      aceStore.onHermesDesktopEvent((payload: any) => send('hermes-desktop:event', payload)),
    ];
    // Browser surface events (optional: mock stores in tests omit them).
    if (typeof aceStore.onBrowserUiRequest === 'function') {
      forwarders.push(aceStore.onBrowserUiRequest((payload: any) => send('browser:ui-request', payload)));
    }
    if (typeof aceStore.onBrowserControlStatus === 'function') {
      forwarders.push(aceStore.onBrowserControlStatus((payload: any) => send('browser:control-status', payload)));
    }
    if (typeof aceStore.onBrowserStreamEvent === 'function') {
      forwarders.push(
        aceStore.onBrowserStreamEvent((payload: any) => {
          if (!browserSubs.has(browserSubKey(payload?.taskId, payload?.tabId))) return;
          send('browser:frame', payload);
        })
      );
    }
    if (aceController && aceController.bus) {
      forwarders.push(aceController.bus.onAny((payload: any) => send('stream:event', payload)));
    }

    function send(type: any, payload: any) {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type, payload }));
      } catch {}
    }

    async function handleClientMessage(raw: any) {
      try {
        if (deviceIsRevoked(device.id)) {
          closeDeviceConnections(device.id);
          return;
        }
        const msg = JSON.parse(raw);
        if (!msg || !msg.type) return;
        if (msg.type === 'pty:subscribe' && msg.streamId) {
          subscribedStreams.add(msg.streamId);
          try {
            // `scrollback` is the client's advertised buffer depth — the
            // snapshot is serialized capped to what the client will keep
            // (phones keep far less than the server's full mirror).
            const syncData = await aceStore.getTerminalSync({
              streamId: msg.streamId,
              scrollback: msg.scrollback,
            });
            if (syncData) {
              send('pty:sync', { streamId: msg.streamId, ...syncData });
            }
          } catch {}
        } else if (msg.type === 'pty:unsubscribe' && msg.streamId) {
          subscribedStreams.delete(msg.streamId);
        } else if (msg.type === 'pty:requestSync' && msg.streamId) {
          try {
            const syncData = await aceStore.getTerminalSync({
              streamId: msg.streamId,
              scrollback: msg.scrollback,
            });
            if (syncData) {
              send('pty:sync', { streamId: msg.streamId, ...syncData });
            }
          } catch {}
        } else if (
          msg.type === 'browser:subscribe' &&
          msg.taskId &&
          msg.tabId &&
          typeof aceStore.browserStreamOpen === 'function'
        ) {
          const k = browserSubKey(msg.taskId, msg.tabId);
          const alreadySubscribed = browserSubs.has(k);
          browserSubs.set(k, { taskId: msg.taskId, tabId: msg.tabId });
          try {
            // Re-subscribes (reconnect, resize-driven) must not leak refs.
            if (alreadySubscribed) {
              aceStore.browserStreamResize?.({
                taskId: msg.taskId,
                tabId: msg.tabId,
                width: msg.width,
                height: msg.height,
                dpr: msg.dpr,
              });
            } else {
              const snap = await aceStore.browserStreamOpen({
                taskId: msg.taskId,
                tabId: msg.tabId,
                width: msg.width,
                height: msg.height,
                dpr: msg.dpr,
              });
              if (snap) send('browser:frame', { taskId: msg.taskId, tabId: msg.tabId, ...snap });
            }
          } catch (err: any) {
            send('browser:frame', {
              taskId: msg.taskId,
              tabId: msg.tabId,
              error: err?.message || 'browser stream unavailable',
            });
          }
        } else if (msg.type === 'browser:unsubscribe' && msg.taskId && msg.tabId) {
          const k = browserSubKey(msg.taskId, msg.tabId);
          if (browserSubs.delete(k)) {
            try {
              aceStore.browserStreamClose?.({ taskId: msg.taskId, tabId: msg.tabId });
            } catch {}
          }
        }
      } catch {}
    }

    try { send('state', aceStore.getState()); } catch {}

    ws.on('message', (data: any) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      handleClientMessage(raw);
    });
    ws.on('close', () => {
      connectedClients.delete(ws);
      subscribedStreams.clear();
      for (const sub of browserSubs.values()) {
        try {
          aceStore.browserStreamClose?.({ taskId: sub.taskId, tabId: sub.tabId });
        } catch {}
      }
      browserSubs.clear();
      for (const off of forwarders) try { off(); } catch {}
      events.emit('client-disconnect', {
        deviceId: device.id,
        total: connectedClients.size,
      });
    });
    ws.on('error', () => {});
  }



  function startMdns() {
    if (!Bonjour) return;
    try {
      bonjour = new Bonjour();
      bonjourService = bonjour.publish({
        name: `Ace on ${os.hostname()}`,
        type: 'ace',
        port: state.port,
        txt: { v: '1' },
      });



      const host = `${os.hostname().replace(/\.local$/, '').toLowerCase()}.local`;
      state.lanHost = host;
    } catch (err: any) {
      console.error('[ace-remote] mDNS publish failed:', err.message);
    }
  }

  function stopMdns() {
    try { bonjourService?.stop(() => {}); } catch {}
    try { bonjour?.destroy(); } catch {}
    bonjourService = null;
    bonjour = null;
    state.lanHost = null;
  }



  async function refreshTailscale() {
    if (!which('tailscale')) {
      state.tailscaleHost = null;
      return null;
    }
    try {
      const r: any = await execFileP('tailscale', ['status', '--json']);
      if (r.err || !r.stdout) return null;
      const parsed = JSON.parse(r.stdout);
      const dns = parsed?.Self?.DNSName;
      if (dns) {
        state.tailscaleHost = dns.replace(/\.$/, '');
        return state.tailscaleHost;
      }
    } catch {}
    return null;
  }



  async function ensureTailscaleHttps() {
    if (state.tunnelMode !== 'tailscale' || !state.tailscaleHost) {
      state.tailscaleHttpsReady = false;
      state.tailscaleHttpsError = null;
      return { ok: false, error: null };
    }
    const result = await ensureTailscaleHttpsProxy(state.port);
    state.tailscaleHttpsReady = !!result.ok;
    state.tailscaleHttpsError = result.ok ? null : (result.error || 'Tailscale Serve HTTPS is unavailable');
    if (!result.ok) console.error('[ace-remote] tailscale HTTPS proxy unavailable:', state.tailscaleHttpsError);
    events.emit('tunnel-changed', {
      tunnel: 'tailscale',
      url: state.tailscaleHttpsReady ? `https://${state.tailscaleHost}` : null,
      httpsReady: state.tailscaleHttpsReady,
      error: state.tailscaleHttpsError,
    });
    return result;
  }

  async function start() {
    if (httpServer) return;
    refreshSettings();
    httpServer = http.createServer(handleRequest);
    wsServer = new WebSocketServer({ noServer: true, handleProtocols: (protocols: any) => {


      for (const p of protocols) {
        if (typeof p === 'string' && p.startsWith('ace-token.')) return p;
      }
      return false;
    }});
    wsServer.on('connection', wireConnection);
    // Single server-level state forwarder: serialize the snapshot once per emit
    // and send the identical frame to every connected client.
    if (!stateForwarderOff) {
      stateForwarderOff = aceStore.onState((payload: any) =>
        broadcastFrameToClients(connectedClients, 'state', payload)
      );
    }
    // Usage forwarder: the same usage-events subscription main.cts fans out to
    // desktop windows, mirrored to every remote client as one typed frame.
    if (!usageForwarderOff) {
      try {
        usageForwarderOff = require('./usage-events.cjs').subscribeUsageChanged((report: any) =>
          broadcastFrameToClients(connectedClients, 'usage:changed', report)
        );
      } catch { /* usage events optional — remote falls back to slow refresh */ }
    }
    httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname === HERMES_DESKTOP_PROXY_PREFIX || url.pathname.startsWith(`${HERMES_DESKTOP_PROXY_PREFIX}/`)) {
        handleHermesDesktopUpgrade(req, socket, head, url);
        return;
      }
      if (url.pathname !== '/ws') {
        if (devProxyUrl) {
          proxyViteUpgrade(req, socket, head, url);
          return;
        }
        socket.destroy();
        return;
      }
      handleUpgrade(req, socket, head);
    });

    const bindHost = desiredBindHost();
    try {
      await new Promise<void>((resolve, reject) => {
        const server = httpServer;
        server.once('error', reject);
        server.listen(state.port, bindHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      try { wsServer?.close(); } catch {}
      try { httpServer?.close(); } catch {}
      wsServer = null;
      httpServer = null;
      boundHost = null;
      throw err;
    }
    boundHost = bindHost;
    await refreshTailscale();
    await ensureTailscaleHttps();
    if (state.tunnelMode === 'lan') startMdns();
    events.emit('started', { port: state.port });
  }

  async function stop() {
    stopMdns();
    if (stateForwarderOff) {
      try { stateForwarderOff(); } catch {}
      stateForwarderOff = null;
    }
    if (usageForwarderOff) {
      try { usageForwarderOff(); } catch {}
      usageForwarderOff = null;
    }
    for (const socket of [...hermesProxySockets]) {
      try { (socket as any).destroy(); } catch {}
    }
    hermesProxySockets.clear();
    if (wsServer) {
      for (const ws of connectedClients) {
        try { (ws as any).close(1001, 'server stopping'); } catch {}
      }
      wsServer.close();
      wsServer = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer = null;
    }
    boundHost = null;
    events.emit('stopped', {});
  }
  async function setEnabled(enabled: any) {
    refreshSettings();
    if (enabled && !httpServer) {
      aceStore.setRemoteEnabled(true);
      refreshSettings();
      await start();
    } else if (!enabled && httpServer) {
      aceStore.setRemoteEnabled(false);
      refreshSettings();
      await stop();
    }
    return getStatus();
  }

  async function setTunnelMode(mode: any) {
    if (!['lan', 'tailscale', 'loopback'].includes(mode)) {
      throw new Error('Unsupported remote access mode. Choose LAN, Tailscale, or loopback.');
    }
    const wasRunning = Boolean(httpServer);
    const previousBindHost = boundHost;
    aceStore.setRemoteTunnelMode(mode);
    refreshSettings();
    stopMdns();
    if (!wasRunning) return getStatus();
    if (previousBindHost && previousBindHost !== desiredBindHost()) {
      await stop();
      await start();
      return getStatus();
    }
    if (mode === 'lan') startMdns();
    if (mode === 'tailscale') {
      await refreshTailscale();
      await ensureTailscaleHttps();
    } else {
      state.tailscaleHttpsReady = false;
      state.tailscaleHttpsError = null;
    }
    return getStatus();
  }

  function mintEnrollment() {
    const token = newToken(24);
    enrollments.set(token, { expiresAt: Date.now() + ENROLL_TTL_MS });

    for (const [k, v] of enrollments.entries()) {
      if ((v as any).expiresAt < Date.now()) enrollments.delete(k);
    }
    return { token, expiresAt: Date.now() + ENROLL_TTL_MS };
  }

  function primaryUrl() {
    return primaryRemoteUrl({
      tunnelMode: state.tunnelMode,
      tailscaleHost: state.tailscaleHost,
      tailscaleHttpsReady: state.tailscaleHttpsReady,
      lanHost: state.lanHost,
      port: state.port,
    });
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      running: Boolean(httpServer),
      port: state.port,
      tunnelMode: state.tunnelMode,
      lanHost: state.lanHost,
      tailscaleHost: state.tailscaleHost,
      tailscaleHttpsReady: state.tailscaleHttpsReady,
      tailscaleHttpsError: state.tailscaleHttpsError,
      primaryUrl: primaryUrl(),
      allowlist: Array.from(getAllowlist()),
      connectedClients: connectedClients.size,
    };
  }

  return {
    events,
    start,
    stop,
    setEnabled,
    setTunnelMode,
    refreshSettings,
    refreshTailscale,
    detectTunnels,
    mintEnrollment,
    getStatus,
    primaryUrl,
    get connectedClients() { return connectedClients.size; },
  };
}

module.exports = {
  createRemoteServer,
  detectTunnels,
  rewriteHermesDesktopProxyText,
  broadcastFrameToClients,
  // Exported for tests (same pattern as broadcastFrameToClients): the static
  // caching + compression helpers that back serveFromDist / jsonResponse.
  staticCacheHeaders,
  negotiateEncoding,
  compressStream,
};
