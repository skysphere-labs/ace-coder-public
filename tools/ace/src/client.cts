const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = (() => {
  const env = process.env.ACE_TIMEOUT_MS;
  if (!env) return 60_000;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

function tagged(code: any, message: any) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizePath(raw: any) {
  const value = String(raw || '').trim();
  if (!value) return null;
  return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function readJsonIfPresent(filePath: any) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pushUnique(list: any[], value: any) {
  if (!value || list.includes(value)) return;
  list.push(value);
}

function externalDataRootCandidates() {
  const roots: string[] = [];
  const addRoot = (raw: any) => {
    const root = normalizePath(raw);
    if (!root) return;
    pushUnique(roots, root);
  };

  addRoot(process.env.ACE_DATA_ROOT);
  addRoot(process.env.ACE_EXTERNAL_DATA_ROOT);

  const configTags = [
    process.env.ACE_USER_DATA_TAG,
    'ACE CODER',
  ].filter(Boolean);
  for (const tag of configTags) {
    const local = path.join(os.homedir(), 'Library', 'Application Support', String(tag));
    const configured = readJsonIfPresent(path.join(local, 'external-data-root.json'));
    if (configured?.enabled === true && configured.root) addRoot(configured.root);
  }

  return roots;
}

function withDeadline(promise: any, timeoutMs: any, label: any) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_: any, reject: any) => {
    timer = setTimeout(
      () => reject(tagged('TIMEOUT', `request ${label || ''} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resolveSocketPath() {
  if (process.env.ACE_SOCK) return process.env.ACE_SOCK;
  if (process.platform === 'win32') {
    const tag = process.env.ACE_USER_DATA_TAG || 'ACE CODER';
    return `\\\\.\\pipe\\ace-${tag}`;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const externalRoots = externalDataRootCandidates();
  const runtimeDirs = [runtimeDir];
  for (const root of externalRoots) {
    pushUnique(runtimeDirs, path.join(root, 'tmp'));
  }
  // Try common userData basenames in order — the dev build appends a suffix.
  const candidates = [
    process.env.ACE_USER_DATA_TAG,
    'ACE CODER',
    'ACE CODER-Dev',
  ].filter(Boolean);
  for (const root of externalRoots) {
    pushUnique(candidates, path.basename(root));
  }
  for (const tag of candidates) {
    for (const dir of runtimeDirs) {
      const p = path.join(dir, `ace.${tag}.sock`);
      if (fs.existsSync(p)) return p;
    }
  }
  // Discover only this public app family; never attach to another installed app.
  try {
    for (const name of fs.readdirSync(runtimeDir)) {
      if ((name.startsWith('ace.ACE CODER-') || name === 'ace.ACE CODER.sock') && name.endsWith('.sock')) {
        return path.join(runtimeDir, name);
      }
    }
  } catch {}
  // Defense in depth: when nothing turned up in the primary runtimeDir, a
  // TMPDIR-nesting mismatch (e.g. the app and this CLI saw different os.tmpdir()
  // values) can leave the socket in a sibling dir. Scan os.tmpdir(), the parent
  // of runtimeDir, and /tmp for `ace.*.sock`. To avoid latching onto a stale
  // socket from a different instance, only accept a match here when its tag
  // equals ACE_USER_DATA_TAG.
  const ownTag = process.env.ACE_USER_DATA_TAG;
  if (ownTag) {
    const extraDirs = [os.tmpdir(), path.dirname(runtimeDir), '/tmp'];
    const seen = new Set([runtimeDir]);
    for (const dir of extraDirs) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      const candidate = path.join(dir, `ace.${ownTag}.sock`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(runtimeDir, `ace.ACE CODER.sock`);
}

function createSocketClient() {
  const sockPath = resolveSocketPath();

  // Detect "socket file does not exist" up front for non-Windows. Without
  // this, net.createConnection emits a generic ENOENT at the next tick which
  // looks like every other transport hiccup. We tag it explicitly so the CLI
  // can map it to exit code 3 with `socket_unreachable`.
  let upfrontUnreachable = null;
  if (process.platform !== 'win32' && !fs.existsSync(sockPath)) {
    upfrontUnreachable = tagged(
      'SOCKET_UNREACHABLE',
      `ace socket not found at ${sockPath}`
    );
  }

  const sock = upfrontUnreachable ? null : net.createConnection(sockPath);
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  const eventSubs = new Set();
  let readyResolve;
  let readyReject;
  const ready = new Promise((res: any, rej: any) => {
    readyResolve = res;
    readyReject = rej;
  });

  if (upfrontUnreachable) {
    readyReject(upfrontUnreachable);
  } else {
    sock.on('connect', () => readyResolve());
    sock.on('data', (chunk: any) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'number') {
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            if (msg.ok) entry.resolve(msg.result);
            else {
              const error: any = new Error(msg.error || 'request failed');
              if (typeof msg.applicationCode === 'string') {
                error.applicationCode = msg.applicationCode;
              }
              entry.reject(error);
            }
          }
        } else if (msg.event) {
          for (const cb of eventSubs) { try { cb(msg); } catch {} }
        }
      }
    });
    sock.on('error', (err: any) => {
      // Map common transport errors to the tagged contract.
      let tag = err;
      if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        tag = tagged('SOCKET_UNREACHABLE', `ace socket unreachable: ${err.message}`);
      }
      readyReject(tag);
      for (const [, e] of pending) e.reject(tag);
      pending.clear();
    });
  }

  async function invoke(method: any, params: any, timeoutMs: any) {
    const work = (async () => {
      await ready;
      return new Promise((resolve: any, reject: any) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });
    })();
    return withDeadline(work, timeoutMs, method);
  }

  function onEvent(cb: any) {
    eventSubs.add(cb);
    return () => eventSubs.delete(cb);
  }

  function close() {
    try { sock && sock.end(); } catch {}
  }

  return { invoke, onEvent, close, transport: 'socket', endpoint: sockPath };
}

function createHttpClient({ baseUrl, token }: any) {
  const base = new URL(baseUrl);
  const lib = base.protocol === 'https:' ? https : http;

  async function invoke(method: any, params: any, timeoutMs: any) {
    const work = new Promise((resolve: any, reject: any) => {
      const body = Buffer.from(JSON.stringify(params ?? null));
      const req = lib.request(
        {
          method: 'POST',
          host: base.hostname,
          port: base.port || (base.protocol === 'https:' ? 443 : 80),
          path: `/api/${method}`,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'content-length': body.length,
          },
        },
        (res: any) => {
          const chunks = [];
          res.on('data', (c: any) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (parsed && parsed.ok) resolve(parsed.result);
              else reject(new Error(parsed?.error || `HTTP ${res.statusCode}`));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', (err: any) => {
        if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')) {
          reject(tagged('SOCKET_UNREACHABLE', `Ace HTTP endpoint unreachable: ${err.message}`));
        } else {
          reject(err);
        }
      });
      req.write(body);
      req.end();
    });
    return withDeadline(work, timeoutMs, method);
  }

  function onEvent() {
    // TODO: event subscription over WS for remote clients. For V1 the CLI's
    // `watch` command uses the local socket; remote `watch` is best-effort
    // polling.
    throw new Error('onEvent() over HTTP transport is not supported in V1; use the local socket or poll via `ace state`.');
  }

  function close() {}

  return { invoke, onEvent, close, transport: 'http', endpoint: baseUrl };
}

function createClient() {
  if (process.env.ACE_URL && process.env.ACE_TOKEN) {
    return createHttpClient({
      baseUrl: process.env.ACE_URL,
      token: process.env.ACE_TOKEN,
    });
  }
  return createSocketClient();
}

module.exports = { createClient, resolveSocketPath, DEFAULT_TIMEOUT_MS };
