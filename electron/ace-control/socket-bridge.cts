const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

// Local Unix-domain socket for the `ace` CLI. No auth — the socket
// inherits the user's login permissions (0600 on the dir), same trust
// boundary as the running app. Only valid when Ace is running on the
// same machine as the CLI. Remote clients use the existing auth'd WS path.
function socketPath(userDataPath: any) {
  if (process.platform === 'win32') {
    // Windows uses a named pipe. Node's net.createServer accepts the
    // `\\.\pipe\<name>` form directly.
    return `\\\\.\\pipe\\ace-${path.basename(userDataPath || 'default')}`;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtimeDir, `ace.${path.basename(userDataPath || 'default')}.sock`);
}

function createSocketBridge({ aceStore, aceController, userDataPath }: any) {
  if (!aceStore || !aceController) throw new Error('socket-bridge: controller required');
  const sockPath = socketPath(userDataPath);

  let server: any = null;
  let ownsSocket = false;
  const subs = new Set();

  async function handleRequest(msg: any) {
    if (!msg || typeof msg !== 'object') throw new Error('bad request');
    const { method, params } = msg;
    if (typeof method !== 'string') throw new Error('method required');
    if (method === 'ping') return { ok: true };
    const fn = aceStore[method];
    if (typeof fn !== 'function') throw new Error(`unknown method: ${method}`);
    return fn.call(aceStore, params || {});
  }

  function wireConnection(socket: any) {
    let buf = '';
    const unsubAny = aceController.bus.onAny((payload: any) => {
      writeEvent(socket, payload);
    });
    subs.add(unsubAny);
    socket.on('data', (chunk: any) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        const id = req.id;
        Promise.resolve()
          .then(() => handleRequest(req))
          .then((result) => writeResponse(socket, id, { ok: true, result }))
          .catch((err) => writeResponse(socket, id, {
            ok: false,
            error: String(err?.message || err),
            applicationCode: typeof err?.applicationCode === 'string' ? err.applicationCode : undefined,
          }));
      }
    });
    socket.on('close', () => {
      try { unsubAny(); } catch {}
      subs.delete(unsubAny);
    });
    socket.on('error', () => {});
  }

  function writeResponse(socket: any, id: any, payload: any) {
    try {
      socket.write(JSON.stringify({ id, ...payload }) + '\n');
    } catch {}
  }

  function writeEvent(socket: any, payload: any) {
    try {
      socket.write(JSON.stringify({ event: payload.event, payload: payload.payload }) + '\n');
    } catch {}
  }

  async function start() {
    if (server) return;
    try {
      if (process.platform !== 'win32') {
        if (fs.existsSync(sockPath)) {
          const active = await isSocketActive(sockPath);
          if (active) return;
          try { fs.unlinkSync(sockPath); } catch {}
        }
        fs.mkdirSync(path.dirname(sockPath), { recursive: true });
      }
      server = net.createServer(wireConnection);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, () => {
          server.off('error', reject);
          ownsSocket = true;
          if (process.platform !== 'win32') {
            try { fs.chmodSync(sockPath, 0o600); } catch {}
          }
          resolve();
        });
      });
    } catch (err: any) {
      console.error('[ace] socket bridge failed to start:', err.message);
      server = null;
      ownsSocket = false;
    }
  }

  function stop() {
    if (server) {
      try { server.close(); } catch {}
      server = null;
    }
    if (ownsSocket && process.platform !== 'win32') {
      try { fs.unlinkSync(sockPath); } catch {}
    }
    ownsSocket = false;
    for (const off of subs) { try { (off as any)(); } catch {} }
    subs.clear();
  }

  return { start, stop, path: sockPath };
}

function isSocketActive(sockPath: string) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(sockPath);
    let settled = false;
    const done = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

module.exports = { createSocketBridge, socketPath };
