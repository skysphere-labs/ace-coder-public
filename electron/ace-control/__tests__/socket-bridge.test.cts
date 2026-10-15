const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createSocketBridge, socketPath } = require('../socket-bridge.cts');

function tempUserDataPath(label: string) {
  return path.join(os.tmpdir(), `csb-${label}-${process.pid}`);
}

function listen(sockPath: string) {
  const server = net.createServer();
  return new Promise<any>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function close(server: any) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function socketRequest(sockPath: string, request: any) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('socket request timed out'));
    }, 2_000);
    const finish = (error: Error | null, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once('error', (error: Error) => finish(error));
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        if (response.id === request.id) finish(null, response);
      }
    });
  });
}

test('start leaves an already-active socket owned by another process intact', async () => {
  if (process.platform === 'win32') return;

  const userDataPath = tempUserDataPath('active');
  const sockPath = socketPath(userDataPath);
  try { fs.unlinkSync(sockPath); } catch {}

  const owner = await listen(sockPath);
  const bridge = createSocketBridge({
    aceStore: { ping: () => ({ ok: true }) },
    aceController: { bus: { onAny: () => () => {} } },
    userDataPath,
  });

  await bridge.start();
  bridge.stop();

  assert.equal(fs.existsSync(sockPath), true, 'non-owner bridge must not unlink a live socket');

  await close(owner);
  try { fs.unlinkSync(sockPath); } catch {}
});

test('stop removes the socket only when this bridge owns it', async () => {
  if (process.platform === 'win32') return;

  const userDataPath = tempUserDataPath('owned');
  const sockPath = socketPath(userDataPath);
  try { fs.unlinkSync(sockPath); } catch {}

  const bridge = createSocketBridge({
    aceStore: { ping: () => ({ ok: true }) },
    aceController: { bus: { onAny: () => () => {} } },
    userDataPath,
  });

  await bridge.start();
  assert.equal(fs.existsSync(sockPath), true);

  bridge.stop();
  assert.equal(fs.existsSync(sockPath), false);
});

test('socket bridge dispatches integrationContextImport to the store unchanged', async () => {
  if (process.platform === 'win32') return;

  const calls: any[] = [];
  const userDataPath = tempUserDataPath('context-import');
  fs.rmSync(userDataPath, { recursive: true, force: true });
  const bridge = createSocketBridge({
    aceStore: {
      integrationContextImport: (params: any) => {
        calls.push(params);
        return { digest: 'a'.repeat(64) };
      },
    },
    aceController: { bus: { onAny: () => () => {} } },
    userDataPath,
  });
  try {
    await bridge.start();
    const response = await socketRequest(bridge.path, {
      id: 'context-import-1',
      method: 'integrationContextImport',
      params: { requestId: 'req-1' },
    });
    assert.equal(response.ok, true);
    assert.deepEqual(calls, [{ requestId: 'req-1' }]);
    assert.equal(response.result.digest, 'a'.repeat(64));
  } finally {
    bridge.stop();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('socket bridge preserves explicitly tagged context import application codes', async () => {
  if (process.platform === 'win32') return;

  for (const code of [
    'dirty_worktree',
    'digest_mismatch',
    'NOT_FOUND',
    'TIMEOUT',
    'SOCKET_UNREACHABLE',
  ]) {
    const userDataPath = tempUserDataPath(`context-import-${code}`);
    fs.rmSync(userDataPath, { recursive: true, force: true });
    const bridge = createSocketBridge({
      aceStore: {
        integrationContextImport: () => {
          const error: any = new Error(`context import failed: ${code}`);
          error.code = code;
          error.applicationCode = code;
          throw error;
        },
      },
      aceController: { bus: { onAny: () => () => {} } },
      userDataPath,
    });
    try {
      await bridge.start();
      const response = await socketRequest(bridge.path, {
        id: `context-import-${code}`,
        method: 'integrationContextImport',
        params: { requestId: 'req-failure' },
      });
      assert.equal(response.ok, false);
      assert.equal(response.applicationCode, code);
      assert.equal(response.code, undefined);
      assert.match(response.error, new RegExp(code));
    } finally {
      bridge.stop();
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  }
});

test('socket bridge does not publish arbitrary internal error codes', async () => {
  if (process.platform === 'win32') return;

  const userDataPath = tempUserDataPath('internal-code');
  fs.rmSync(userDataPath, { recursive: true, force: true });
  const bridge = createSocketBridge({
    aceStore: {
      unrelatedMethod: () => {
        const error: any = new Error('database operation failed');
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    },
    aceController: { bus: { onAny: () => () => {} } },
    userDataPath,
  });
  try {
    await bridge.start();
    const response = await socketRequest(bridge.path, {
      id: 'internal-code',
      method: 'unrelatedMethod',
      params: {},
    });
    assert.equal(response.ok, false);
    assert.equal(response.applicationCode, undefined);
    assert.equal(response.code, undefined);
    assert.equal(response.error, 'database operation failed');
  } finally {
    bridge.stop();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
