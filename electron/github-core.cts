// GitHub core — thin wrapper around the `gh` CLI plus a tiny REST fetcher.
// Ace never stores GitHub tokens itself; `gh` is the source of truth.

const { execFile, spawn } = require('child_process');
const { promisify, stripVTControlCharacters } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const execFileP = promisify(execFile);

const GH_CANDIDATES = [
  'gh',
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
];

let ghBinary: any = null;
let ghVersion: any = null;
let ghDetected = false;
let authGeneration = 0;

// Caches. All in-memory. No persistence.
let accountsCache: any = null;       // { at, data: [{ login, avatarUrl, isActive, ... }] }
const profileCache = new Map(); // login -> { at, data: profile }
const contributionsCache = new Map(); // login -> { at, data }
const tokenCache = new Map();   // login -> { token, at }
const reposCache = new Map();   // login -> { at, data }
const starsCache = new Map();   // login -> { at, data }
const trendingCache = new Map();// `${since}:${language}` -> { at, data }

const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const GITHUB_LOGIN_RE = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const GITHUB_CREDENTIAL_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

function validGithubLogin(value: any) {
  return typeof value === 'string' && GITHUB_LOGIN_RE.test(value);
}

function ghSubprocessEnv(source: any = process.env) {
  const env = { ...(source || {}) };
  for (const key of GITHUB_CREDENTIAL_ENV_KEYS) delete env[key];
  return env;
}

function invalidateAccountState({ clearTokens = false }: any = {}) {
  authGeneration += 1;
  accountsCache = null;
  profileCache.clear();
  reposCache.clear();
  starsCache.clear();
  if (clearTokens) tokenCache.clear();
  return authGeneration;
}

async function detectGh() {
  if (ghDetected) return { installed: Boolean(ghBinary), version: ghVersion };
  for (const candidate of GH_CANDIDATES) {
    try {
      const { stdout } = await execFileP(candidate, ['--version'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      ghBinary = await resolveAbsolute(candidate);
      const m = stdout.match(/gh version (\d+\.\d+\.\d+)/);
      ghVersion = m ? m[1] : stdout.split('\n')[0]?.trim() || null;
      ghDetected = true;
      return { installed: true, version: ghVersion };
    } catch {
      // keep trying
    }
  }
  ghDetected = true;
  return { installed: false };
}

// Resolve a bare command name (e.g. 'gh') to its absolute path so spawned
// consoles with a different PATH can still find it. Pass absolute paths through.
async function resolveAbsolute(cmd: any) {
  if (path.isAbsolute(cmd)) return cmd;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(lookup, [cmd], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const first = stdout.split(/\r?\n/).map((l: any) => l.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // fall through
  }
  return cmd;
}

// Force a re-detect — used after an install PTY claims success.
function invalidateDetection() {
  ghDetected = false;
  ghBinary = null;
  ghVersion = null;
  invalidateAccountState({ clearTokens: true });
}

async function runGh(args: any, opts: any = {}) {
  if (!ghBinary) {
    await detectGh();
    if (!ghBinary) throw new Error('GitHub CLI not installed');
  }
  try {
    const { env: requestedEnv, ...execOptions } = opts;
    const { stdout, stderr } = await execFileP(ghBinary, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
      ...execOptions,
      // The account shown in ACE comes from gh's stored github.com accounts.
      // Ambient CI/parent-process tokens must not silently override it.
      env: ghSubprocessEnv(requestedEnv || process.env),
    });
    // `spawned` = the process actually executed to completion. Distinguishes a
    // real gh result (incl. a clean "not logged in" non-zero exit) from a
    // transient inability to run gh at all (ENOENT / timeout), so callers can
    // treat "logged out" and "gh broken" differently.
    return { stdout, stderr, code: 0, spawned: true };
  } catch (err) {
    // execFile rejects on BOTH a non-zero exit AND a spawn failure. A numeric
    // exit code means the process ran and exited (spawned); a non-numeric code
    // (ENOENT, …) or a kill signal (timeout) means it never produced a result.
    const ranToExit = typeof err.code === 'number' && !err.killed;
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      code: typeof err.code === 'number' ? err.code : 1,
      spawned: ranToExit,
    };
  }
}

// ── Account listing ──────────────────────────────────────────────────────

function parseAuthStatus(combined: any) {
  // `gh auth status` writes to stdout on modern versions and stderr on older
  // ones. Callers pass the merged text. GitHub CLI honors FORCE_COLOR even
  // without a TTY, so strip terminal controls before matching account names.
  // We only care about github.com blocks.
  const lines = stripVTControlCharacters(String(combined || '')).split(/\r?\n/);
  const accounts = [];
  let inGithubCom = false;
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^[^\s]/.test(line)) {
      // Host header (e.g. "github.com"). Anything non-indented ends a prior
      // account block.
      inGithubCom = /^github\.com/.test(line);
      if (current) {
        accounts.push(current);
        current = null;
      }
      continue;
    }
    if (!inGithubCom) continue;
    const loginMatch = line.match(/Logged in to github\.com account (\S+)/);
    if (loginMatch && validGithubLogin(loginMatch[1])) {
      if (current) accounts.push(current);
      current = { login: loginMatch[1], isActive: false };
      continue;
    }
    const activeMatch = line.match(/Active account:\s*(true|false)/);
    if (activeMatch && current) {
      current.isActive = activeMatch[1] === 'true';
      continue;
    }
  }
  if (current) accounts.push(current);
  return accounts;
}

async function hydrateProfile(login: any, token: any, deps: any = {}, { force = false }: any = {}) {
  const cached = profileCache.get(login);
  if (!force && cached && Date.now() - cached.at < FIVE_MIN) return cached.data;
  try {
    const res = await (deps.ghFetchImpl || ghFetch)(`/users/${encodeURIComponent(login)}`, { token });
    if (res.ok && res.data) {
      const profile = {
        avatarUrl: res.data.avatar_url || null,
        name: res.data.name || null,
        bio: res.data.bio || null,
        htmlUrl: res.data.html_url || `https://github.com/${login}`,
        followers: typeof res.data.followers === 'number' ? res.data.followers : null,
        following: typeof res.data.following === 'number' ? res.data.following : null,
        publicRepos: typeof res.data.public_repos === 'number' ? res.data.public_repos : null,
        location: res.data.location || null,
        company: res.data.company || null,
        blog: res.data.blog || null,
      };
      profileCache.set(login, { at: Date.now(), data: profile });
      return profile;
    }
  } catch {}
  return null;
}

async function listAccounts({ force = false }: any = {}, deps: any = {}) {
  const generation = authGeneration;
  if (
    !force && accountsCache && accountsCache.generation === generation &&
    Date.now() - accountsCache.at < FIVE_MIN
  ) {
    return accountsCache.data;
  }
  const detect = await (deps.detectGhImpl || detectGh)();
  if (!detect.installed) return [];
  const { stdout, stderr, code } = await (deps.runGhImpl || runGh)(['auth', 'status']);
  // Parse both streams — older gh versions write to stderr, newer to stdout.
  const parsed = parseAuthStatus(`${stdout}\n${stderr}`);
  if (code !== 0 && parsed.length === 0) return [];

  // Hydrate profile data in parallel. Use each login's own token so the API
  // call is guaranteed to have scope for /users/:login.
  const withProfiles = await Promise.all(
    parsed.map(async (acc: any) => {
      let token = null;
      try {
        token = await (deps.getTokenImpl || getToken)(acc.login);
      } catch {}
      const profile = token
        ? await (deps.hydrateProfileImpl || hydrateProfile)(acc.login, token, deps, { force })
        : null;
      return {
        login: acc.login,
        isActive: acc.isActive,
        avatarUrl: profile?.avatarUrl ?? null,
        name: profile?.name ?? null,
        bio: profile?.bio ?? null,
        htmlUrl: profile?.htmlUrl ?? `https://github.com/${acc.login}`,
        followers: profile?.followers ?? null,
        following: profile?.following ?? null,
        publicRepos: profile?.publicRepos ?? null,
        location: profile?.location ?? null,
        company: profile?.company ?? null,
        blog: profile?.blog ?? null,
      };
    })
  );

  if (generation !== authGeneration) return listAccounts({ force: true }, deps);
  accountsCache = { at: Date.now(), generation, data: withProfiles };
  return withProfiles;
}

// Determinate active-login read for gates that must not confuse "logged out"
// with "gh unavailable". `determined:true` means gh actually ran and reported
// the auth state — `login` is the active account or null (a real logout).
// `determined:false` means gh could not run (not installed / spawn error /
// timeout): the caller should keep its last-known-good login rather than demote.
async function readActiveLogin(deps: any = {}) {
  const detect = await (deps.detectGhImpl || detectGh)();
  if (!detect.installed) return { determined: false, login: null };
  let result: any;
  try {
    result = await (deps.runGhImpl || runGh)(['auth', 'status']);
  } catch {
    return { determined: false, login: null };
  }
  if (!result || result.spawned === false) return { determined: false, login: null };
  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = parseAuthStatus(output);
  const active = parsed.find((acc: any) => acc.isActive) || null;
  // Only a POSITIVELY confirmed auth state may clear the last-known-good identity
  // (the caller preserves it on determined:false). A clean exit, or at least one
  // parsed account, is authoritative; a nonzero exit with no parseable accounts
  // is a confirmed logout ONLY if gh says so — otherwise it is a transient
  // network/keyring/config failure that must NOT revoke the seat.
  if (result.code === 0 || parsed.length > 0) {
    return { determined: true, login: active ? active.login : null };
  }
  if (/not logged in/i.test(output)) {
    return { determined: true, login: null };
  }
  return { determined: false, login: null };
}

async function switchAccount(login: any, deps: any = {}) {
  if (!validGithubLogin(login)) throw new Error('Invalid GitHub account login');
  invalidateAccountState();
  let result: any;
  try {
    result = await (deps.runGhImpl || runGh)([
      'auth', 'switch', '--hostname', 'github.com', '--user', login,
    ]);
  } finally {
    // A refresh that noticed the first invalidation may have retried while gh
    // was still switching. Invalidate again after the CLI mutation settles so
    // that retry cannot publish the pre-switch account under the new epoch.
    invalidateAccountState();
  }
  const { stderr, code } = result;
  if (code !== 0) throw new Error(stderr || `failed to switch to ${login}`);
  return listAccounts({ force: true }, deps);
}

async function removeAccount(login: any, deps: any = {}) {
  if (!validGithubLogin(login)) throw new Error('Invalid GitHub account login');
  invalidateAccountState();
  let result: any;
  try {
    result = await (deps.runGhImpl || runGh)([
      'auth', 'logout', '--hostname', 'github.com', '--user', login,
    ]);
  } finally {
    // Cover refreshes that restarted while logout was still in flight.
    invalidateAccountState({ clearTokens: true });
  }
  const { stderr, code } = result;
  if (code !== 0) throw new Error(stderr || `failed to sign out ${login}`);
  return listAccounts({ force: true }, deps);
}

// ── OAuth device flow login ──────────────────────────────────────────────
//
// We drive GitHub's OAuth device flow directly over HTTPS instead of spawning
// `gh auth login --web` in a PTY. The PTY approach had four recurring
// failures on Windows/Electron: (1) `gh` opens the browser from inside
// ConPTY, which sometimes doesn't reach the user's default browser; (2) gh
// shows follow-up prompts like "Authenticate Git with your GitHub
// credentials?" that block the exit indefinitely; (3) React StrictMode
// double-mounts race two PTYs through module state; (4) exit codes are
// opaque. Device flow removes all of that: clean HTTP, clear errors,
// non-interactive token handoff to `gh auth login --with-token`.

// Public client id for the "GitHub CLI" OAuth app — same value gh uses.
const GH_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a';
const GH_OAUTH_SCOPES = 'repo read:org gist workflow';
const GH_REQUEST_ID_RE = /^ghreq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GH_DEVICE_CODE_RE = /^[A-Za-z0-9_-]{20,512}$/;
const GH_USER_CODE_RE = /^[A-Z0-9]{4,10}(?:-[A-Z0-9]{4,10})?$/;
const AUTH_RESPONSE_BYTES = 64 * 1024;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const AUTH_HANDOFF_TIMEOUT_MS = 30_000;

const pendingDeviceStarts = new Map(); // requestId -> { controller, cancelled }
const deviceSessions = new Map(); // requestId -> main-process-only device authorization state

class GithubCoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GithubCoreError';
    this.code = code;
  }
}

function logAuth(...args: any) {
  console.log('[ace][gh-auth]', ...args);
}
function warnAuth(...args: any) {
  console.warn('[ace][gh-auth]', ...args);
}

function redactedAuthText(value: any) {
  return String(value || '')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/gi, '[REDACTED]')
    .replace(/\b[a-f0-9]{40}\b/gi, '[REDACTED]')
    .slice(0, 500);
}

async function boundedFetch(fetchImpl: any, url: string, init: any = {}, options: any = {}) {
  if (typeof fetchImpl !== 'function') throw new GithubCoreError('NETWORK_ERROR', 'GitHub networking is unavailable');
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs || AUTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const maximum = options.maxBytes || AUTH_RESPONSE_BYTES;
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength !== null && contentLength !== undefined) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
        throw new GithubCoreError('INVALID_RESPONSE', 'GitHub returned an invalid Content-Length');
      }
      const declared = Number(contentLength);
      if (!Number.isSafeInteger(declared) || declared > maximum) {
        throw new GithubCoreError('RESPONSE_TOO_LARGE', 'GitHub returned an oversized response');
      }
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      if (response.status === 204) return { response, text: '' };
      throw new GithubCoreError('INVALID_RESPONSE', 'GitHub returned an unreadable response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(new GithubCoreError(
        externalSignal?.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT',
        externalSignal?.aborted ? 'GitHub authorization was cancelled' : 'GitHub request timed out',
      ));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      while (true) {
        const read = reader.read();
        void read.catch(() => {});
        const { done, value } = await Promise.race([read, aborted]);
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new GithubCoreError('INVALID_RESPONSE', 'GitHub returned an invalid response stream');
        }
        length += value.byteLength;
        if (length > maximum) {
          void reader.cancel('response too large').catch(() => undefined);
          throw new GithubCoreError('RESPONSE_TOO_LARGE', 'GitHub returned an oversized response');
        }
        chunks.push(value);
      }
    } finally {
      if (controller.signal.aborted) void reader.cancel('request aborted').catch(() => undefined);
      try { reader.releaseLock(); } catch {}
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new GithubCoreError('INVALID_RESPONSE', 'GitHub returned invalid UTF-8'); }
    return { response, text };
  } catch (error: any) {
    if (error instanceof GithubCoreError) throw error;
    if (externalSignal?.aborted) throw new GithubCoreError('CANCELLED', 'GitHub authorization was cancelled');
    if (timedOut || error?.name === 'AbortError' || controller.signal.aborted) {
      throw new GithubCoreError('REQUEST_TIMEOUT', 'GitHub request timed out');
    }
    throw new GithubCoreError('NETWORK_ERROR', 'GitHub could not be reached');
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

async function boundedJson(fetchImpl: any, url: string, init: any = {}, options: any = {}) {
  const result = await boundedFetch(fetchImpl, url, init, options);
  let data: any = null;
  try { data = result.text ? JSON.parse(result.text) : null; }
  catch { throw new GithubCoreError('INVALID_RESPONSE', 'GitHub returned malformed JSON'); }
  return { ...result, data };
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new GithubCoreError('CANCELLED', 'GitHub authorization was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GithubCoreError('CANCELLED', 'GitHub authorization was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelDeviceAuthorization(requestId: string, reason = 'cancelled') {
  const pending = pendingDeviceStarts.get(requestId);
  if (pending) {
    pending.cancelled = true;
    pending.reason = reason;
    pending.controller.abort();
  }
  const session = deviceSessions.get(requestId);
  if (session) {
    // `gh auth login --with-token` can commit to the OS keyring before its
    // process exits. Once that handoff begins, aborting it and deleting the
    // session creates an unknowable half-cancelled state. Let the bounded
    // handoff settle and force account reconciliation; committed credentials
    // win deterministically even if the renderer closed meanwhile.
    if (session.handoffStarted) {
      session.cancelRequested = true;
      session.cancelReason = reason;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      return;
    }
    session.cancelled = true;
    session.cancelReason = reason;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.controller?.abort();
    deviceSessions.delete(requestId);
  }
}

function validVerificationUri(value: any) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === 'https://github.com' && url.pathname === '/login/device' &&
      !url.username && !url.password && !url.search && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

async function githubLoginStart(input: any = {}, deps: any = {}) {
  const requestId = GH_REQUEST_ID_RE.test(String(input?.requestId || ''))
    ? String(input.requestId)
    : `ghreq_${crypto.randomUUID()}`;
  if (pendingDeviceStarts.has(requestId) || deviceSessions.has(requestId)) {
    return { ok: false, error: 'A GitHub authorization with this request ID is already active.' };
  }
  const pending = { controller: new AbortController(), cancelled: false, reason: null };
  pendingDeviceStarts.set(requestId, pending);
  try {
    const detect = await (deps.detectGhImpl || detectGh)();
    if (pending.cancelled || pendingDeviceStarts.get(requestId) !== pending) {
      return { ok: false, error: 'cancelled' };
    }
    if (!detect.installed) {
      return { ok: false, error: 'GitHub CLI not installed. Install from https://cli.github.com' };
    }
    const { response, data } = await boundedJson(
      deps.fetchImpl || globalThis.fetch,
      'https://github.com/login/device/code',
      {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Ace',
      },
      body: new URLSearchParams({ client_id: GH_OAUTH_CLIENT_ID, scope: GH_OAUTH_SCOPES }).toString(),
      },
      { signal: pending.controller.signal, timeoutMs: deps.requestTimeoutMs || AUTH_REQUEST_TIMEOUT_MS },
    );
    if (pending.cancelled || pendingDeviceStarts.get(requestId) !== pending) {
      return { ok: false, error: 'cancelled' };
    }
    if (!response.ok) return { ok: false, error: `GitHub device-code request failed (${response.status}).` };
    const verificationUri = validVerificationUri(data?.verification_uri);
    const expiresIn = Number(data?.expires_in);
    const interval = Number(data?.interval);
    if (
      !GH_DEVICE_CODE_RE.test(String(data?.device_code || '')) ||
      !GH_USER_CODE_RE.test(String(data?.user_code || '')) || !verificationUri ||
      !Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 1800 ||
      !Number.isInteger(interval) || interval < 1 || interval > 60
    ) {
      warnAuth('device/code contract rejected');
      return { ok: false, error: 'GitHub returned an invalid device-code response.' };
    }
    const now = (deps.nowImpl || Date.now)();
    const session: any = {
      requestId,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri,
      interval,
      expiresAt: now + expiresIn * 1000,
      cancelled: false,
      cancelReason: null,
      controller: null,
      pollPromise: null,
      expiryTimer: null,
      handoffStarted: false,
      cancelRequested: false,
    };
    session.expiryTimer = setTimeout(() => cancelDeviceAuthorization(requestId, 'expired'), expiresIn * 1000);
    if (typeof session.expiryTimer.unref === 'function') session.expiryTimer.unref();
    deviceSessions.set(requestId, session);
    logAuth('device flow started', { expiresIn });
    return {
      ok: true,
      requestId,
      userCode: data.user_code,
      verificationUri,
      interval,
      expiresIn,
    };
  } catch (error: any) {
    if (pending.cancelled || error?.code === 'CANCELLED') return { ok: false, error: 'cancelled' };
    warnAuth('device/code failed', error?.code || 'UNKNOWN');
    return { ok: false, error: error?.code === 'REQUEST_TIMEOUT' ? 'GitHub device-code request timed out.' : 'Network error reaching github.com.' };
  } finally {
    if (pendingDeviceStarts.get(requestId) === pending) pendingDeviceStarts.delete(requestId);
  }
}

async function pollDeviceSession(state: any, deps: any) {
  const requestId = state.requestId;
  const controller = new AbortController();
  state.controller = controller;
  let pollSec = state.interval;
  const sleepImpl = deps.sleepImpl || abortableSleep;
  while (!state.cancelled && (deps.nowImpl || Date.now)() < state.expiresAt) {
    try {
      await sleepImpl(pollSec * 1000, controller.signal);
      if (state.cancelled || deviceSessions.get(requestId) !== state) break;
      const { response, data: body } = await boundedJson(
        deps.fetchImpl || globalThis.fetch,
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Ace',
          },
          body: new URLSearchParams({
            client_id: GH_OAUTH_CLIENT_ID,
            device_code: state.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }).toString(),
        },
        { signal: controller.signal, timeoutMs: deps.requestTimeoutMs || AUTH_REQUEST_TIMEOUT_MS },
      );
      if (state.cancelled || deviceSessions.get(requestId) !== state) break;
      if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
        warnAuth('poll response rejected', response.status);
        continue;
      }
      if (body.access_token !== undefined) {
        if (typeof body.access_token !== 'string' || !/^[\x21-\x7e]{20,4096}$/.test(body.access_token)) {
          return { ok: false, error: 'GitHub returned an invalid access token.' };
        }
        if (state.cancelled || deviceSessions.get(requestId) !== state) break;
        logAuth('token received, handing it to gh keyring');
        const handoffImpl = deps.writeTokenToGhImpl || writeTokenToGh;
        state.handoffStarted = true;
        let handoff: any;
        try {
          handoff = await handoffImpl(body.access_token, {
            signal: controller.signal,
            spawnImpl: deps.spawnImpl || spawn,
            timeoutMs: deps.handoffTimeoutMs || AUTH_HANDOFF_TIMEOUT_MS,
          });
        } catch {
          handoff = { ok: false, error: 'GitHub CLI credential handoff failed' };
        }
        // Always invalidate and reconcile after a handoff attempt. A process
        // timeout/failure can race a successful keyring write, and callers must
        // never continue to observe the pre-handoff cache in that case.
        (deps.invalidateAccountStateImpl || (() => invalidateAccountState({ clearTokens: true })))();
        let accounts: any[] = [];
        try {
          accounts = await (deps.listAccountsImpl || (() => listAccounts({ force: true })))();
        } catch (error: any) {
          warnAuth('post-handoff account reconciliation failed', error?.code || 'UNKNOWN');
        }
        if (!handoff?.ok) return handoff;
        const active = accounts.find((account: any) => account.isActive) || accounts[0] || null;
        logAuth('login complete', active?.login);
        return { ok: true, login: active?.login || null };
      }
      switch (body.error) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          pollSec = Math.min(60, pollSec + 5);
          state.interval = pollSec;
          logAuth('slow_down; new interval', pollSec);
          break;
        case 'expired_token':
          return { ok: false, error: 'The code expired before you authorized. Please try again.' };
        case 'access_denied':
          return { ok: false, error: 'Authorization was denied.' };
        case 'unsupported_grant_type':
        case 'incorrect_client_credentials':
        case 'incorrect_device_code':
        case 'device_flow_disabled':
          warnAuth('fatal poll error', body.error);
          return {
            ok: false,
            error: typeof body.error_description === 'string'
              ? redactedAuthText(body.error_description).slice(0, 300)
              : body.error,
          };
        default:
          warnAuth('unexpected poll response');
      }
    } catch (error: any) {
      if (state.cancelled || controller.signal.aborted || error?.code === 'CANCELLED') break;
      if (error?.code === 'INVALID_RESPONSE' || error?.code === 'RESPONSE_TOO_LARGE') {
        return { ok: false, error: 'GitHub returned an invalid authorization response.' };
      }
      warnAuth('poll request failed', error?.code || 'NETWORK_ERROR');
    }
  }
  if (state.cancelReason === 'expired' || (deps.nowImpl || Date.now)() >= state.expiresAt) {
    return { ok: false, error: 'The code expired before you authorized. Please try again.' };
  }
  return { ok: false, error: 'cancelled' };
}

function githubLoginPoll({ requestId }: any, deps: any = {}) {
  const state = deviceSessions.get(requestId);
  if (!state) return { ok: false, error: 'Unknown device-flow session. Restart the login.' };
  if (state.pollPromise) return state.pollPromise;
  const operation = pollDeviceSession(state, deps).finally(() => {
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.controller?.abort();
    if (deviceSessions.get(requestId) === state) deviceSessions.delete(requestId);
    state.pollPromise = null;
  });
  state.pollPromise = operation;
  return operation;
}

function githubLoginCancel({ requestId }: any = {}) {
  if (!requestId) {
    for (const id of [...pendingDeviceStarts.keys(), ...deviceSessions.keys()]) {
      cancelDeviceAuthorization(id);
    }
    return { ok: true };
  }
  if (!GH_REQUEST_ID_RE.test(String(requestId))) return { ok: false };
  cancelDeviceAuthorization(String(requestId));
  return { ok: true };
}

// Non-interactive token handoff. `gh auth login --with-token` reads the token
// from stdin and writes it to config/keyring; no prompts, no browser.
async function writeTokenToGh(token: any, options: any = {}): Promise<any> {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,4096}$/.test(token)) {
    return { ok: false, error: 'GitHub returned an invalid access token' };
  }
  let binary = options.ghBinary || ghBinary;
  if (!binary) {
    const detected = await (options.detectGhImpl || detectGh)();
    if (detected?.installed) binary = options.ghBinary || detected.binary || ghBinary;
  }
  return new Promise((resolve: any) => {
    if (!binary) {
      resolve({ ok: false, error: 'gh binary unavailable' });
      return;
    }
    const args = [
      'auth', 'login',
      '--hostname', 'github.com',
      '--git-protocol', 'https',
      '--with-token',
    ];
    let child;
    try {
      child = (options.spawnImpl || spawn)(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: ghSubprocessEnv(options.env || process.env),
      });
    } catch {
      resolve({ ok: false, error: 'gh could not be started' });
      return;
    }
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timeout: any = null;
    const maximumOutput = 64 * 1024;
    const kill = () => {
      try { child.kill?.('SIGTERM'); } catch {}
      const force = setTimeout(() => { try { child.kill?.('SIGKILL'); } catch {} }, 1000);
      if (typeof force.unref === 'function') force.unref();
    };
    const onAbort = () => {
      kill();
      finish({ ok: false, error: 'cancelled' });
    };
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const append = (current: string, chunk: any) => {
      const next = `${current}${String(chunk || '')}`;
      if (Buffer.byteLength(next, 'utf8') > maximumOutput) {
        kill();
        finish({ ok: false, error: 'gh produced too much output' });
        return current;
      }
      return next;
    };
    child.stderr?.on?.('data', (data: any) => { stderr = append(stderr, data); });
    child.stdout?.on?.('data', (data: any) => { stdout = append(stdout, data); });
    timeout = setTimeout(() => {
      kill();
      finish({ ok: false, error: 'GitHub CLI credential handoff timed out' });
    }, options.timeoutMs || AUTH_HANDOFF_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (err: any) => {
      warnAuth('gh --with-token process error', redactedAuthText(err?.message));
      finish({ ok: false, error: 'GitHub CLI credential handoff failed' });
    });
    child.on('close', (code: any) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        const message = redactedAuthText(stderr.trim() || stdout.trim() || `gh exited with code ${code}`);
        warnAuth('gh --with-token exited', code, message);
        finish({ ok: false, error: message });
      }
    });
    try {
      child.stdin.on?.('error', () => finish({ ok: false, error: 'GitHub CLI credential handoff failed' }));
      child.stdin.write(`${token}\n`);
      child.stdin.end();
    } catch {
      kill();
      finish({ ok: false, error: 'GitHub CLI credential handoff failed' });
    }
  });
}

// ── Token retrieval ──────────────────────────────────────────────────────

async function getToken(login: any) {
  if (!validGithubLogin(login)) throw new Error('Invalid GitHub account login');
  const cached = tokenCache.get(login);
  if (cached && Date.now() - cached.at < FIVE_MIN) return cached.token;
  const { stdout, stderr, code } = await runGh([
    'auth', 'token', '--hostname', 'github.com', '--user', login,
  ]);
  if (code !== 0) throw new Error(stderr || `no token for ${login}`);
  const token = stdout.trim();
  if (!token) throw new Error(`empty token for ${login}`);
  tokenCache.set(login, { token, at: Date.now() });
  return token;
}

async function getActiveLogin() {
  const accounts = await listAccounts();
  const active = accounts.find((a: any) => a.isActive);
  if (!active) throw new Error('no active github account');
  return active.login;
}

// ── REST wrapper ─────────────────────────────────────────────────────────

async function ghFetch(pathOrUrl: any, { token }: any = {}) {
  if (typeof token !== 'string' || !token || /[\0\r\n]/.test(token)) throw new Error('GitHub credential unavailable');
  let url: URL;
  try { url = new URL(String(pathOrUrl || ''), 'https://api.github.com/'); }
  catch { throw new Error('Invalid GitHub API URL'); }
  if (url.origin !== 'https://api.github.com' || url.username || url.password) {
    throw new Error('GitHub API origin mismatch');
  }
  const { response, data } = await boundedJson(globalThis.fetch, url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Ace',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, { maxBytes: 8 * 1024 * 1024 });
  return { ok: response.ok, status: response.status, data };
}

async function ghGraphQL(query: any, variables: any, token: any) {
  if (typeof token !== 'string' || !token || /[\0\r\n]/.test(token)) throw new Error('GitHub credential unavailable');
  const { response, data: json } = await boundedJson(globalThis.fetch, 'https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ace',
    },
    body: JSON.stringify({ query, variables }),
  }, { maxBytes: 8 * 1024 * 1024 });
  return { ok: response.ok && !json?.errors, status: response.status, data: json?.data || null, errors: json?.errors || null };
}

const CONTRIB_LEVEL_VALUE: Record<string, number> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchContributions({ login: requestedLogin, year }: any = {}) {
  const login = requestedLogin || (await getActiveLogin());
  const cacheKey = `${login}:${year || 'now'}`;
  const cached = contributionsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FIVE_MIN) return cached.data;
  const tokenLogin = await getActiveLogin();
  const token = await getToken(tokenLogin);
  // When a specific year is passed, bound the window to that calendar year.
  // Without from/to, GitHub returns the trailing ~52 weeks (current year view).
  const hasRange = typeof year === 'number' && Number.isFinite(year);
  const now = new Date();
  const from = hasRange ? new Date(Date.UTC(year, 0, 1)).toISOString() : null;
  const to = hasRange
    ? (year === now.getUTCFullYear()
        ? now.toISOString()
        : new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString())
    : null;
  const query = hasRange
    ? `query($login: String!, $from: DateTime!, $to: DateTime!) {
         user(login: $login) {
           contributionsCollection(from: $from, to: $to) {
             contributionCalendar {
               totalContributions
               weeks {
                 contributionDays { date contributionCount contributionLevel }
               }
             }
           }
         }
       }`
    : `query($login: String!) {
         user(login: $login) {
           contributionsCollection {
             contributionCalendar {
               totalContributions
               weeks {
                 contributionDays { date contributionCount contributionLevel }
               }
             }
           }
         }
       }`;
  const variables = hasRange ? { login, from, to } : { login };
  const res = await ghGraphQL(query, variables, token);
  if (!res.ok || !res.data?.user) {
    throw new Error(`contributions fetch failed: ${res.status}`);
  }
  const cal = res.data.user.contributionsCollection.contributionCalendar;
  const weeks = cal.weeks.map((w: any) => ({
    days: w.contributionDays.map((d: any) => ({
      date: d.date,
      count: d.contributionCount,
      level: CONTRIB_LEVEL_VALUE[d.contributionLevel] ?? 0,
    })),
  }));
  const data = { total: cal.totalContributions, weeks, year: year || null };
  contributionsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ── Repos / Stars ────────────────────────────────────────────────────────

function shapeRepo(r: any) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    owner: r.owner?.login,
    ownerAvatarUrl: r.owner?.avatar_url || null,
    description: r.description || null,
    private: !!r.private,
    fork: !!r.fork,
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    defaultBranch: r.default_branch,
    stars: r.stargazers_count || 0,
    language: r.language || null,
    pushedAt: r.pushed_at,
    updatedAt: r.updated_at,
    lastCommit: null, // hydrated lazily
  };
}

async function listRepos() {
  const login = await getActiveLogin();
  const cached = reposCache.get(login);
  if (cached && Date.now() - cached.at < FIVE_MIN) return cached.data;
  const token = await getToken(login);
  const res = await ghFetch('/user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator', { token });
  if (!res.ok) throw new Error(`repos fetch failed: ${res.status}`);
  const data = (res.data || []).map(shapeRepo);
  reposCache.set(login, { at: Date.now(), data });
  return data;
}

async function listStars() {
  const login = await getActiveLogin();
  const cached = starsCache.get(login);
  if (cached && Date.now() - cached.at < FIVE_MIN) return cached.data;
  const token = await getToken(login);
  const res = await ghFetch('/user/starred?per_page=50', { token });
  if (!res.ok) throw new Error(`stars fetch failed: ${res.status}`);
  const data = (res.data || []).map(shapeRepo);
  starsCache.set(login, { at: Date.now(), data });
  return data;
}

async function setStarred(fullName: any, starred: any) {
  if (
    typeof fullName !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(fullName) ||
    fullName.endsWith('/.') || fullName.endsWith('/..')
  ) {
    throw new Error('fullName required (owner/repo)');
  }
  const [owner, repo] = fullName.split('/');
  const login = await getActiveLogin();
  const token = await getToken(login);
  const url = `https://api.github.com${'/user/starred/'}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { response } = await boundedFetch(globalThis.fetch, url, {
    method: starred ? 'PUT' : 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Ace',
      'X-GitHub-Api-Version': '2022-11-28',
      // PUT requires an empty body with Content-Length: 0 per GitHub docs.
      ...(starred ? { 'Content-Length': '0' } : {}),
    },
  }, { maxBytes: AUTH_RESPONSE_BYTES });
  if (!response.ok) {
    throw new Error(`${starred ? 'star' : 'unstar'} failed: ${response.status}`);
  }
  starsCache.delete(login);
  return { ok: true, starred };
}

async function starRepo({ fullName }: any = {}) {
  return setStarred(fullName, true);
}

async function unstarRepo({ fullName }: any = {}) {
  return setStarred(fullName, false);
}

// ── Trending (scrape) ────────────────────────────────────────────────────

function stripTags(html: any) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: any) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseTrending(html: any) {
  const rows = [];
  // Split by repo rows.
  const rowRegex = /<article class="Box-row"[\s\S]*?(?=<article class="Box-row"|<\/div>\s*<\/div>\s*<\/div>\s*<\/main>)/g;
  const articles = html.match(rowRegex) || [];
  for (const article of articles) {
    const h2Match = article.match(/<h2[^>]*class="[^"]*lh-condensed[^"]*"[\s\S]*?<a[^>]*href="\/([^"]+)"/);
    if (!h2Match) continue;
    const fullName = decodeEntities(h2Match[1]).replace(/\/$/, '');

    const descMatch = article.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? decodeEntities(stripTags(descMatch[1])) : null;

    const langMatch = article.match(/<span itemprop="programmingLanguage">([\s\S]*?)<\/span>/);
    const language = langMatch ? decodeEntities(stripTags(langMatch[1])) : null;

    const gainedMatch = article.match(/<span[^>]*class="[^"]*\bd-inline-block\b[^"]*\bfloat-sm-right\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    let starsGained = null;
    let starsGainedText = null;
    if (gainedMatch) {
      const text = decodeEntities(stripTags(gainedMatch[1]));
      starsGainedText = text;
      const n = text.match(/([\d,]+)/);
      if (n) starsGained = parseInt(n[1].replace(/,/g, ''), 10);
    }

    const parseCount = (suffix: any) => {
      const re = new RegExp(`href="\\/[^"]+\\/${suffix}"[^>]*>([\\s\\S]*?)<\\/a>`);
      const m = article.match(re);
      if (!m) return null;
      const text = decodeEntities(stripTags(m[1]));
      const n = text.match(/([\d,]+)/);
      return n ? parseInt(n[1].replace(/,/g, ''), 10) : null;
    };
    const stars = parseCount('stargazers');
    const forks = parseCount('forks');

    const [owner, name] = fullName.split('/');
    rows.push({
      fullName,
      owner,
      name,
      description,
      language,
      stars,
      forks,
      starsGained,
      starsGainedText,
      htmlUrl: `https://github.com/${fullName}`,
      cloneUrl: `https://github.com/${fullName}.git`,
    });
  }
  return rows;
}

async function listTrending({ since = 'daily', language = null }: any = {}) {
  if (!['daily', 'weekly', 'monthly'].includes(since)) since = 'daily';
  if (typeof language !== 'string' || language.length > 80 || /[\0\r\n]/.test(language)) language = null;
  const key = `${since}:${language || ''}`;
  const cached = trendingCache.get(key);
  if (cached && Date.now() - cached.at < THIRTY_MIN) return cached;
  const qs = new URLSearchParams({ since });
  if (language) qs.set('language', language);
  const url = `https://github.com/trending?${qs.toString()}`;
  try {
    const { response, text: html } = await boundedFetch(globalThis.fetch, url, {
      headers: {
        'User-Agent': 'Ace',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, { maxBytes: 3 * 1024 * 1024 });
    if (!response.ok) {
      const payload = { at: Date.now(), data: [], error: `status ${response.status}` };
      trendingCache.set(key, payload);
      return payload;
    }
    const data = parseTrending(html);
    const payload = { at: Date.now(), data, error: data.length === 0 ? 'no rows parsed' : null };
    trendingCache.set(key, payload);
    return payload;
  } catch (error: any) {
    const payload = { at: Date.now(), data: [], error: error?.code || 'request failed' };
    trendingCache.set(key, payload);
    return payload;
  }
}

// ── Clone bridge ─────────────────────────────────────────────────────────

function defaultCloneRoot() {
  // Mirror what most GUIs do: ~/Documents/GitHub (Windows/macOS), ~/GitHub (Linux).
  const home = os.homedir();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return path.join(home, 'Documents', 'GitHub');
  }
  return path.join(home, 'GitHub');
}

async function cloneRepo({ fullName, cloneUrl, name }: any, store: any) {
  if (!store || typeof store.cloneWorkspace !== 'function') {
    throw new Error('workspace store unavailable');
  }
  const root = defaultCloneRoot();
  fs.mkdirSync(root, { recursive: true });
  const validFullName = typeof fullName === 'string' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(fullName) &&
    !fullName.endsWith('/.') && !fullName.endsWith('/..');
  if (fullName && !validFullName) throw new Error('Invalid GitHub repository name');
  // Keep the destination under the fixed clone root even when IPC input is
  // malformed. Dots are valid in repository names, but traversal segments are not.
  const inferredName = typeof name === 'string' && name ? name : (validFullName ? fullName.split('/')[1] : 'repo');
  const safeName = inferredName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('Invalid GitHub repository name');
  let target = path.join(root, safeName);
  if (path.dirname(path.resolve(target)) !== path.resolve(root)) throw new Error('Invalid clone destination');
  let suffix = 1;
  while (fs.existsSync(target)) {
    target = path.join(root, `${safeName}-${suffix++}`);
    if (suffix > 20) throw new Error('could not find free directory name');
  }

  // Prefer `gh repo clone` (inherits gh auth for private repos). Fall back
  // to the store's own git-clone path if gh isn't available.
  if (ghBinary && validFullName) {
    const { stderr, code } = await runGh(['repo', 'clone', fullName, target], { timeout: 30 * 60_000 });
    if (code !== 0) throw new Error(stderr || `gh repo clone ${fullName} failed`);
    return store.importWorkspace({ workspacePath: target });
  }
  let fallbackUrl: URL;
  try { fallbackUrl = new URL(String(cloneUrl || '')); }
  catch { throw new Error('Invalid GitHub clone URL'); }
  if (
    fallbackUrl.origin !== 'https://github.com' || fallbackUrl.username || fallbackUrl.password ||
    fallbackUrl.search || fallbackUrl.hash || !/^\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(?:\.git)?$/.test(fallbackUrl.pathname)
  ) throw new Error('Invalid GitHub clone URL');
  return store.cloneWorkspace({ repoUrl: fallbackUrl.toString(), localPath: target });
}

// ── Public surface ───────────────────────────────────────────────────────

function createGithubCore(options: any = {}) {
  const { store } = options;
  const accountDependencies = {
    detectGhImpl: options.detectGhImpl,
    runGhImpl: options.runGhImpl,
    getTokenImpl: options.getTokenImpl,
    hydrateProfileImpl: options.hydrateProfileImpl,
    ghFetchImpl: options.ghFetchImpl,
  };
  const deviceAuthDependencies = {
    detectGhImpl: options.detectGhImpl,
    fetchImpl: options.fetchImpl,
    spawnImpl: options.spawnImpl,
    sleepImpl: options.sleepImpl,
    nowImpl: options.nowImpl,
    requestTimeoutMs: options.requestTimeoutMs,
    handoffTimeoutMs: options.handoffTimeoutMs,
    writeTokenToGhImpl: options.writeTokenToGhImpl,
    listAccountsImpl: options.listAccountsImpl,
    invalidateAccountStateImpl: options.invalidateAccountStateImpl,
  };
  return {
    isAvailable: () => detectGh(),
    refreshAvailability: async () => {
      invalidateDetection();
      return detectGh();
    },
    listAccounts: (opts: any) => listAccounts(opts || {}, accountDependencies),
    readActiveLogin: () => readActiveLogin(accountDependencies),
    switchAccount: (input: any = {}) => switchAccount(input?.login, accountDependencies),
    loginStart: (input: any = {}) => githubLoginStart(input, deviceAuthDependencies),
    loginPoll: (opts: any) => githubLoginPoll(opts || {}, deviceAuthDependencies),
    loginCancel: (opts: any) => githubLoginCancel(opts || {}),
    removeAccount: (input: any = {}) => removeAccount(input?.login, accountDependencies),
    listRepos: () => listRepos(),
    listStars: () => listStars(),
    listTrending: (opts: any) => listTrending(opts || {}),
    cloneRepo: (input: any) => cloneRepo(input, store),
    fetchContributions: (opts: any) => fetchContributions(opts || {}),
    starRepo: (opts: any) => starRepo(opts || {}),
    unstarRepo: (opts: any) => unstarRepo(opts || {}),
  };
}

module.exports = { createGithubCore, parseAuthStatus, writeTokenToGh, readActiveLogin };
