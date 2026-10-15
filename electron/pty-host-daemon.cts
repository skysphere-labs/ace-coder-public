// Detached PTY host for Ace agent streams.
//
// Runs OUTSIDE the Electron main process (spawned detached with
// ELECTRON_RUN_AS_NODE=1) so the agent CLIs it hosts keep running when the
// app quits, restarts, or crashes. The app talks to it over a per-userData
// unix socket (named pipe on Windows) with newline-delimited JSON:
//
//   request  : { req?, op, ...params }
//   response : { req, ok, ...payload } | { req, ok: false, error }
//   event    : { ev: 'data'|'exit'|'spawned', id, ... }
//
// Output is ring-buffered per stream (BUFFER_CAP bytes) so a reconnecting
// app can replay what happened while it was away. Exited streams are kept
// (status + exit code + buffer) until the app acks them with `release` or
// `kill`. The host exits on its own when it has no streams and no client.
//
// Configuration comes from the environment (set by pty-host.cts):
//   ACE_PTY_HOST_SOCK     unix socket / named pipe path (required)
//   ACE_PTY_HOST_NODE_PTY resolved path of the node-pty module (required)
//   ACE_PTY_HOST_LOG      log file path (optional)

const fs = require('fs');
const net = require('net');
const path = require('path');

const SOCK_PATH = process.env.ACE_PTY_HOST_SOCK || '';
const NODE_PTY_PATH = process.env.ACE_PTY_HOST_NODE_PTY || '';
const LOG_PATH = process.env.ACE_PTY_HOST_LOG || '';
// Bumped whenever a daemon-behaviour change must not be served by a survivor of
// the previous app generation. 2 = no credential gateway: lanes run on the
// machine's own CLI login (see docs/architecture/lane-auth.md).
const PTY_HOST_PROTOCOL = 2;

const BUFFER_CAP = 2 * 1024 * 1024; // per-stream replay buffer, in bytes
const IDLE_SWEEP_MS = 30_000;
const STARTUP_GRACE_MS = 60_000;

function log(...parts: any[]) {
  const line = `[pty-host ${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (LOG_PATH) {
    try { fs.appendFileSync(LOG_PATH, line); } catch {}
  } else {
    try { process.stderr.write(line); } catch {}
  }
}

if (!SOCK_PATH || !NODE_PTY_PATH) {
  log('missing ACE_PTY_HOST_SOCK or ACE_PTY_HOST_NODE_PTY; exiting');
  process.exit(2);
}

let pty: any = null;
try {
  pty = require(NODE_PTY_PATH);
} catch (err: any) {
  log('failed to load node-pty from', NODE_PTY_PATH, err?.message || String(err));
  process.exit(2);
}

// Predict the spawn-helper path node-pty's unixTerminal.js will exec,
// replicating its loadNativeModule() search order AND its (buggy for
// already-unpacked paths) `replace('app.asar', 'app.asar.unpacked')`.
// Returns null when no native pty.node is found (e.g. the test stub) —
// nothing to validate then.
function predictedSpawnHelperPath(nodePtyPath: string) {
  try {
    const entry = require.resolve(nodePtyPath);
    const libDir = path.dirname(entry);
    const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
    for (const d of dirs) {
      for (const r of ['..', '.']) {
        if (!fs.existsSync(path.resolve(libDir, `${r}/${d}/pty.node`))) continue;
        let helper = path.resolve(libDir, `${r}/${d}/spawn-helper`);
        helper = helper.replace('app.asar', 'app.asar.unpacked');
        helper = helper.replace('node_modules.asar', 'node_modules.asar.unpacked');
        return helper;
      }
    }
  } catch {}
  return null;
}

// A host whose spawn-helper is missing would fail EVERY spawn (node-pty's
// native error path also leaks the freshly-opened pty master each time, so a
// retry storm exhausts kern.tty.ptmx_max machine-wide). Refuse to start
// instead — the app then falls back to in-process node-pty, which works.
if (process.platform !== 'win32') {
  const helper = predictedSpawnHelperPath(NODE_PTY_PATH);
  if (helper && !fs.existsSync(helper)) {
    log('node-pty spawn-helper missing at', helper, '— refusing to start (agent lanes will use in-process PTYs)');
    process.exit(2);
  }
}

process.title = 'ace-pty-host';

const startedAtMs = Date.now();
const records = new Map(); // id -> stream record
const clients = new Set(); // connected sockets

function streamMeta(rec: any) {
  return {
    id: rec.id,
    agent: rec.agent,
    cwd: rec.cwd,
    status: rec.status,
    exitCode: rec.exitCode,
    startedAt: rec.startedAt,
    cols: rec.cols,
    rows: rec.rows,
    seq: rec.seq,
  };
}

function writeLine(socket: any, obj: any) {
  try {
    if (!socket.destroyed) socket.write(JSON.stringify(obj) + '\n');
  } catch {}
}

function broadcast(obj: any) {
  for (const socket of clients) writeLine(socket, obj);
}

function pushChunk(rec: any, data: string) {
  rec.seq += 1;
  const bytes = Buffer.byteLength(data);
  rec.chunks.push({ seq: rec.seq, data, bytes });
  rec.bufferedBytes += bytes;
  while (rec.bufferedBytes > BUFFER_CAP && rec.chunks.length > 1) {
    const dropped = rec.chunks.shift();
    rec.bufferedBytes -= dropped.bytes;
  }
  return rec.seq;
}

function listOpenFds() {
  try {
    return new Set(
      fs.readdirSync('/dev/fd')
        .map((entry: string) => Number(entry))
        .filter((fd: number) => Number.isInteger(fd) && fd > 2)
    );
  } catch {
    return null;
  }
}

function ptyPoolExhausted() {
  if (process.platform === 'win32') return false;
  try {
    fs.closeSync(fs.openSync('/dev/ptmx', 'r+'));
    return false;
  } catch (err: any) {
    return err?.code === 'ENXIO';
  }
}

function spawnRecord({ id, bin, args, cwd, env, cols, rows, agent }: any) {
  const existing = records.get(id);
  if (existing && existing.status === 'running') {
    throw new Error(`stream ${id} already running`);
  }
  // node-pty's native error paths leak the pty master/slave fds they opened
  // before failing (microsoft/node-pty pty.cc never closes them on error).
  // Snapshot open fds so a failed spawn can be cleaned up — otherwise enough
  // failures exhaust the machine-wide pty pool and break terminals for every
  // process on the system.
  const fdsBefore = process.platform === 'win32' ? null : listOpenFds();
  let proc;
  try {
    proc = pty.spawn(bin, Array.isArray(args) ? args : [], {
      name: 'xterm-256color',
      cols: Math.max(2, (cols | 0) || 100),
      rows: Math.max(1, (rows | 0) || 28),
      cwd,
      env: env && typeof env === 'object' ? env : process.env,
    });
  } catch (err: any) {
    let closed = 0;
    if (fdsBefore) {
      const fdsAfter = listOpenFds();
      if (fdsAfter) {
        for (const fd of fdsAfter) {
          if (fdsBefore.has(fd)) continue;
          try { fs.closeSync(fd); closed += 1; } catch {}
        }
      }
    }
    const hint = ptyPoolExhausted()
      ? '; system pty pool exhausted (kern.tty.ptmx_max) — close pty-heavy processes or reboot'
      : '';
    log('spawn FAILED', id, bin, err?.message || String(err), closed ? `(closed ${closed} leaked fd(s))` : '', 'cwd', cwd);
    throw new Error(`${err?.message || String(err)}${hint}`);
  }
  const rec: any = {
    id,
    agent: agent || null,
    cwd: cwd || null,
    pty: proc,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    cols: Math.max(2, (cols | 0) || 100),
    rows: Math.max(1, (rows | 0) || 28),
    seq: 0,
    chunks: [],
    bufferedBytes: 0,
    killed: false,
  };
  records.set(id, rec);
  proc.onData((data: string) => {
    try {
      const seq = pushChunk(rec, data);
      broadcast({ ev: 'data', id, seq, data });
    } catch (err: any) {
      log('onData handler failed for', id, err?.message || String(err));
    }
  });
  proc.onExit(({ exitCode }: any) => {
    try {
      if (rec.killed || records.get(id) !== rec) return;
      rec.status = 'exited';
      rec.exitCode = typeof exitCode === 'number' ? exitCode : -1;
      rec.pty = null;
      broadcast({ ev: 'exit', id, code: rec.exitCode });
      log('stream exited', id, 'code', rec.exitCode);
    } catch (err: any) {
      log('onExit handler failed for', id, err?.message || String(err));
    }
  });
  log('spawned', id, bin, 'pid', proc.pid, 'cwd', cwd);
  return rec;
}

function handleRequest(socket: any, msg: any) {
  const req = msg.req ?? null;
  const reply = (payload: any) => writeLine(socket, { req, ok: true, ...payload });
  const fail = (error: string) => writeLine(socket, { req, ok: false, error });
  try {
    switch (msg.op) {
      case 'ping':
        return reply({ pid: process.pid });
      case 'hello':
        return reply({
          pid: process.pid,
          // Protocol generation. The client refuses to adopt a daemon below its
          // required generation and retires it instead — a daemon outlives an
          // app update, so without this a pre-upgrade host keeps serving its OWN
          // (old) code to every lane and a shipped fix silently never lands.
          protocol: PTY_HOST_PROTOCOL,
          streams: Array.from(records.values()).map(streamMeta),
        });
      case 'spawn': {
        // A duplicate spawn for an id the host is ALREADY running (boot adoption
        // missed the survivor): reject before mutating and let the client
        // reattach — the guard mirrors spawnRecord's own check.
        const running = records.get(msg.id);
        if (running && running.status === 'running') {
          return fail(`stream ${msg.id} already running`);
        }
        const rec = spawnRecord(msg);
        return reply({ id: rec.id, pid: rec.pty?.pid ?? null });
      }
      case 'attach': {
        const rec = records.get(msg.id);
        if (!rec) return fail(`unknown stream ${msg.id}`);
        // Reply BEFORE replaying: replay buffers run to megabytes, and the
        // client's fixed request timeout must not depend on buffer size —
        // busy streams used to time out here and miss boot adoption, leaving
        // them orphaned in the host ("stream already running" forever).
        // Replay events arriving after the reply are queued by the client
        // handle until its callbacks are wired, so nothing is dropped.
        reply({ id: rec.id, status: rec.status, exitCode: rec.exitCode });
        for (const chunk of rec.chunks) {
          writeLine(socket, { ev: 'data', id: rec.id, seq: chunk.seq, data: chunk.data });
        }
        if (rec.status === 'exited') {
          writeLine(socket, { ev: 'exit', id: rec.id, code: rec.exitCode ?? -1 });
        }
        return;
      }
      case 'write': {
        const rec = records.get(msg.id);
        if (!rec || rec.status !== 'running') return fail(`stream ${msg.id} not running`);
        rec.pty.write(String(msg.data ?? ''));
        return reply({});
      }
      case 'resize': {
        const rec = records.get(msg.id);
        if (!rec || rec.status !== 'running') return fail(`stream ${msg.id} not running`);
        rec.cols = Math.max(2, msg.cols | 0);
        rec.rows = Math.max(1, msg.rows | 0);
        rec.pty.resize(rec.cols, rec.rows);
        return reply({});
      }
      case 'kill': {
        const rec = records.get(msg.id);
        if (rec) {
          rec.killed = true;
          try { rec.pty?.kill(); } catch {}
          records.delete(msg.id);
          log('killed', msg.id);
        }
        return reply({});
      }
      case 'release': {
        const rec = records.get(msg.id);
        if (rec && rec.status === 'running') return fail(`stream ${msg.id} still running`);
        records.delete(msg.id);
        return reply({});
      }
      default:
        return fail(`unknown op ${String(msg.op)}`);
    }
  } catch (err: any) {
    return fail(err?.message || String(err));
  }
}

function wireClient(socket: any) {
  clients.add(socket);
  let buf = '';
  socket.on('data', (chunk: any) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handleRequest(socket, msg);
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

function startServer() {
  const server = net.createServer(wireClient);
  server.on('error', (err: any) => {
    log('server error:', err?.message || String(err));
    process.exit(1);
  });
  server.listen(SOCK_PATH, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(SOCK_PATH, 0o600); } catch {}
    }
    log('listening on', SOCK_PATH);
  });

  setInterval(() => {
    if (Date.now() - startedAtMs < STARTUP_GRACE_MS) return;
    if (records.size === 0 && clients.size === 0) {
      log('idle (no streams, no clients); exiting');
      try { server.close(); } catch {}
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(SOCK_PATH); } catch {}
      }
      process.exit(0);
    }
  }, IDLE_SWEEP_MS).unref?.();
}

function shutdown(signal: string) {
  log('received', signal, '— killing', records.size, 'stream(s) and exiting');
  for (const rec of records.values()) {
    rec.killed = true;
    try { rec.pty?.kill(); } catch {}
  }
  records.clear();
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCK_PATH); } catch {}
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Losing the controlling terminal (if any) must never kill hosted agents.
process.on('SIGHUP', () => log('ignoring SIGHUP'));
process.on('uncaughtException', (err: any) => {
  log('uncaught exception (suppressed):', err?.stack || err?.message || String(err));
});

// Single-instance: if a live host already owns the socket, defer to it.
if (process.platform !== 'win32' && fs.existsSync(SOCK_PATH)) {
  const probe = net.connect(SOCK_PATH);
  probe.setTimeout(1500);
  probe.once('connect', () => {
    probe.destroy();
    log('another pty-host already owns', SOCK_PATH, '— exiting');
    process.exit(0);
  });
  const stale = () => {
    probe.destroy();
    try { fs.unlinkSync(SOCK_PATH); } catch {}
    fs.mkdirSync(path.dirname(SOCK_PATH), { recursive: true });
    startServer();
  };
  probe.once('error', stale);
  probe.once('timeout', stale);
} else {
  try { fs.mkdirSync(path.dirname(SOCK_PATH), { recursive: true }); } catch {}
  startServer();
}
