// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
//
// End-to-end test of the detached pty-host (daemon + client): spawn a stream,
// lose the client (app "quit"), reconnect (app "restart"), adopt the stream
// with a full buffer replay, and observe exits that happened while away.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPtyHostClient, ptyHostSocketPath } = require('../pty-host.cts');

const STUB_NODE_PTY = path.join(__dirname, 'fixtures', 'stub-node-pty.cjs');
const DAEMON_SRC = path.join(__dirname, '..', 'pty-host-daemon.cts');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

describe('pty-host daemon + client', () => {
  let tmpDir;
  let daemonCjs;
  let daemonPid = null;
  const clients = [];

  function makeClient() {
    const client = createPtyHostClient({
      userDataPath: tmpDir,
      execPath: process.execPath, // plain node; daemon is dependency-free
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
    });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-host-test-'));
    daemonCjs = path.join(tmpDir, 'pty-host-daemon.cjs');
    const { build } = require('esbuild');
    await build({
      entryPoints: [DAEMON_SRC],
      outfile: daemonCjs,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      packages: 'external',
      logLevel: 'silent',
    });
  }, 30_000);

  afterAll(async () => {
    for (const c of clients) {
      try { c.close(); } catch {}
    }
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const sock = ptyHostSocketPath(tmpDir);
    try { fs.unlinkSync(sock); } catch {}
  });

  it('spawns the daemon, hosts a stream, survives client loss, replays on adopt', async () => {
    // ── boot 1: spawn the host and a stream ─────────────────────────────────
    const client1 = makeClient();
    const survivors1 = await client1.ensureConnected();
    expect(survivors1).toEqual([]);
    expect(client1.isConnected()).toBe(true);

    const chunks1 = [];
    const handle = client1.spawnStream({
      id: 'conversation:test-1',
      bin: '/bin/fake-claude',
      args: ['--resume', 'abc'],
      cwd: tmpDir,
      env: { PATH: process.env.PATH },
      cols: 80,
      rows: 24,
      agent: 'claude',
    });
    handle.onData((d) => chunks1.push(d));
    await waitFor(() => chunks1.join('').includes('spawned:/bin/fake-claude:--resume,abc'));

    handle.write('hello-agent');
    await waitFor(() => chunks1.join('').includes('echo:hello-agent'));

    // ── app "quit": drop the client; the host keeps the stream ─────────────
    client1.close();
    await sleep(100);

    // ── boot 2: reconnect, find the survivor, adopt with replay ────────────
    const client2 = makeClient();
    const survivors2 = await client2.ensureConnected();
    expect(survivors2).toHaveLength(1);
    expect(survivors2[0]).toMatchObject({
      id: 'conversation:test-1',
      agent: 'claude',
      status: 'running',
    });

    const { handle: adopted, status } = await client2.adoptStream('conversation:test-1');
    expect(status).toBe('running');
    const replayed = [];
    // Replay events arrived before this wiring; the handle queues them.
    adopted.onData((d) => replayed.push(d));
    await waitFor(() => replayed.join('').includes('echo:hello-agent'));
    expect(replayed.join('')).toContain('spawned:/bin/fake-claude');

    // Still interactive after adoption.
    adopted.write('after-restart');
    await waitFor(() => replayed.join('').includes('echo:after-restart'));

    // ── exit while the app is away ──────────────────────────────────────────
    adopted.write('__EXIT__7');
    await sleep(150);
    client2.close();
    await sleep(100);

    // ── boot 3: the exit was retained for us ────────────────────────────────
    const client3 = makeClient();
    const survivors3 = await client3.ensureConnected();
    expect(survivors3).toHaveLength(1);
    expect(survivors3[0]).toMatchObject({
      id: 'conversation:test-1',
      status: 'exited',
      exitCode: 7,
    });

    // Release clears the record.
    await client3.release('conversation:test-1');
    const after = await client3.ensureConnected();
    expect(after).toEqual([]);

    // ── kill path: a spawned-then-killed stream leaves nothing behind ──────
    const h2 = client3.spawnStream({
      id: 'conversation:test-2',
      bin: '/bin/fake-codex',
      args: [],
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
      agent: 'codex',
    });
    const got = [];
    h2.onData((d) => got.push(d));
    await waitFor(() => got.join('').includes('spawned:/bin/fake-codex'));
    // kill() returns the daemon round-trip so an auth teardown can CONFIRM the
    // kill before closing the host socket (a discarded request could be dropped
    // on immediate close, leaving a detached daemon alive). Awaiting it resolves
    // once the daemon acknowledges.
    const killAck = h2.kill();
    expect(typeof killAck.then).toBe('function');
    await killAck;
    const finalList = await client3.ensureConnected();
    expect(finalList).toEqual([]);

    // ── spawn-conflict: a stream surviving from a previous app generation ──
    // Boot adoption can miss a survivor; the tab then calls spawn for an id
    // the host already runs. That must reattach (with replay), not dead-end
    // in a "stream already running" failure loop.
    const h3 = client3.spawnStream({
      id: 'conversation:test-3',
      bin: '/bin/fake-claude',
      args: [],
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
      agent: 'claude',
    });
    const pre = [];
    h3.onData((d) => pre.push(d));
    await waitFor(() => pre.join('').includes('spawned:/bin/fake-claude'));
    h3.write('before-conflict');
    await waitFor(() => pre.join('').includes('echo:before-conflict'));
    client3.close();
    await sleep(100);

    const client4 = makeClient();
    await client4.ensureConnected();
    // No adoption pass — go straight to spawn with the surviving id.
    const conflicted = client4.spawnStream({
      id: 'conversation:test-3',
      bin: '/bin/fake-claude',
      args: [],
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
      agent: 'claude',
    });
    const reattachChunks = [];
    let exited = null;
    conflicted.onData((d) => reattachChunks.push(d));
    conflicted.onExit(({ exitCode }) => { exited = exitCode; });
    await waitFor(() => reattachChunks.join('').includes('Reattached to the agent already running'));
    // Replay arrived and the stream is still interactive — no failure exit.
    expect(reattachChunks.join('')).toContain('echo:before-conflict');
    conflicted.write('after-conflict');
    await waitFor(() => reattachChunks.join('').includes('echo:after-conflict'));
    expect(exited).toBe(null);
    expect(reattachChunks.join('')).not.toContain('Failed to launch');
    conflicted.write('__EXIT__0');
    await sleep(150);

    // Remember the daemon pid for teardown.
    daemonPid = client4.hostPid();
    expect(typeof daemonPid).toBe('number');
  }, 30_000);

  it('a duplicate spawn for a running lane is rejected and reattached, not respawned', async () => {
    // Boot adoption can miss a survivor; the tab then spawns an id the host is
    // already running. That duplicate must be rejected and the caller reattached
    // to the LIVE process rather than starting a second CLI on the same lane.
    const client = makeClient();
    await client.ensureConnected();

    const firstChunks = [];
    const first = client.spawnStream({
      id: 'conversation:dup', bin: '/bin/fake-claude', args: [], cwd: tmpDir, env: {},
      cols: 80, rows: 24, agent: 'claude',
    });
    first.onData((d) => firstChunks.push(d));
    await waitFor(() => firstChunks.join('').includes('spawned:/bin/fake-claude'));

    const dupChunks = [];
    const dup = client.spawnStream({
      id: 'conversation:dup', bin: '/bin/fake-claude', args: [], cwd: tmpDir, env: {},
      cols: 80, rows: 24, agent: 'claude',
    });
    dup.onData((d) => dupChunks.push(d));
    await waitFor(() => dupChunks.join('').includes('Reattached to the agent already running'));
    // The reattach REPLAYS the live lane's buffer (so the original spawn banner
    // shows up again) rather than starting a second CLI — the daemon still holds
    // exactly one stream for this id.
    const hello = await client.connectExisting();
    expect(hello.filter((s2) => s2.id === 'conversation:dup')).toHaveLength(1);

    first.write('__EXIT__0');
    await sleep(150);
    daemonPid = client.hostPid();
  }, 30_000);

  it('retires a survivor daemon from an older build instead of adopting it', async () => {
    // A daemon outlives an app update. Adopting a pre-upgrade survivor means it
    // keeps serving its OWN (old) code to every lane — which is how the deleted
    // credential gateway kept running, port and all, after the build that
    // removed it. ensureConnected must retire it and stand up a current one.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-legacy-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    // A stand-in for the old daemon: answers `hello` with NO protocol field,
    // exactly as a pre-versioning daemon does.
    const standInPath = path.join(legacyDir, 'legacy-daemon.cjs');
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock, () => process.send && process.send('up'));",
      "const bye = () => { try { require('fs').unlinkSync(sock); } catch {} process.exit(0); };",
      "process.on('SIGTERM', bye);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));

    const client = createPtyHostClient({
      userDataPath: legacyDir,
      execPath: process.execPath,
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
    });
    clients.push(client);

    const streams = await client.ensureConnected();
    expect(streams).not.toBe(null);
    // We ended up on a CURRENT daemon, and it is not the legacy process.
    expect(client.hostProtocol()).toBeGreaterThanOrEqual(2);
    expect(client.hostPid()).not.toBe(child.pid);
    // The outdated survivor was killed, not left running alongside.
    await waitFor(() => {
      try { process.kill(child.pid, 0); return false; } catch { return true; }
    });

    const replacementPid = client.hostPid();
    client.close();
    try { process.kill(replacementPid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('refuses to serve an outdated host that survives retirement', async () => {
    // If the identity guard cannot confirm the survivor (a platform whose
    // signature read fails), retirement sends no signal at all — the old host
    // keeps the socket and the retry loop reconnects straight back to it.
    // Handing that host back would put every lane on the code this build
    // replaced, so ensureConnected must fail closed instead.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-stubborn-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    const standInPath = path.join(legacyDir, 'stubborn-daemon.cjs');
    // Re-binds whenever the socket name is removed — standing in for a Windows
    // named pipe, which an unlink cannot hand over to a replacement daemon.
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const fs = require('fs');",
      "const sock = process.argv[2];",
      "function serve() {",
      "  const server = net.createServer((c) => {",
      "    let buf = '';",
      "    c.on('data', (chunk) => {",
      "      buf += chunk.toString('utf8');",
      "      let i;",
      "      while ((i = buf.indexOf('\\n')) >= 0) {",
      "        const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "        if (!line.trim()) continue;",
      "        const msg = JSON.parse(line);",
      "        c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [] }) + '\\n');",
      "      }",
      "    });",
      "  });",
      "  server.on('error', () => {});",
      "  server.listen(sock);",
      "  return server;",
      "}",
      "let server = serve();",
      "setInterval(() => {",
      "  if (!fs.existsSync(sock)) { try { server.close(); } catch {} server = serve(); }",
      "}, 15).unref?.();",
      "setInterval(() => {}, 1000);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));

    const client = createPtyHostClient({
      userDataPath: legacyDir,
      execPath: process.execPath,
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
      // Identity can never be confirmed (stands in for a platform whose
      // signature read fails) -> fail-closed, no signal is ever sent.
      makeIdentityGuard: () => () => false,
    });
    clients.push(client);

    const streams = await client.ensureConnected();
    // Detached streams are disabled rather than served by the outdated host.
    expect(streams).toBe(null);
    expect(client.isConnected()).toBe(false);
    // Nothing was retired, so no lane may be "resumed" — its original CLI is
    // still alive in the old host and a relaunch would double it up.
    expect(client.takeRetiredStreamIds()).toEqual([]);

    client.close();
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 45_000);

  it('sweeps an outdated survivor when detached mode is off, without spawning one', async () => {
    // With detached agents disabled this launch wants NO daemon — but a
    // preserved outdated one keeps running (it does not idle-exit while it holds
    // stream records) with the code this build replaced still loaded. The sweep
    // must kill it and NOT stand a replacement up.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-sweep-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    const standInPath = path.join(legacyDir, 'legacy-daemon.cjs');
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));

    const client = createPtyHostClient({
      userDataPath: legacyDir,
      execPath: process.execPath,
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
    });
    clients.push(client);

    const swept = await client.retireOutdatedSurvivor();
    expect(swept.outcome).toBe('retired');
    // The client is discarded right after, so the lanes it killed must travel
    // with the result — otherwise nothing can notice them or refuse to relaunch.
    expect(swept.retired).toEqual([]);
    expect(swept.blocked).toEqual([]);
    await waitFor(() => {
      try { process.kill(child.pid, 0); return false; } catch { return true; }
    });
    // No replacement was started: the socket is gone and nothing is listening.
    expect(fs.existsSync(legacySock)).toBe(false);
    expect(client.spawnedChildHandle()).toBe(null);

    client.close();
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('retires an outdated host once under concurrent callers', async () => {
    // Several lanes can start at the same moment during an upgrade. If each ran
    // its own retirement, one would SIGTERM the host while another failed its
    // identity check and blocked every lane — or they would unlink and spawn
    // twice. ensureConnected is single-flight, so they share one retirement.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-race-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    const standInPath = path.join(legacyDir, 'legacy-daemon.cjs');
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      // one RUNNING lane and one EXITED record: only the running one may block
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [",
      "        { id: 'conversation:live', status: 'running' },",
      "        { id: 'conversation:done', status: 'exited' },",
      "      ] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));

    const client = createPtyHostClient({
      userDataPath: legacyDir,
      execPath: process.execPath,
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
    });
    clients.push(client);

    const [a, b, c] = await Promise.all([
      client.ensureConnected(),
      client.ensureConnected(),
      client.ensureConnected(),
    ]);
    // One shared outcome, one current daemon, one retirement.
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(client.hostProtocol()).toBeGreaterThanOrEqual(2);
    expect(client.hostPid()).not.toBe(child.pid);
    // Only the RUNNING lane was interrupted; the exited record is not "lost
    // work" and must not be reported or blocked.
    expect(client.takeRetiredStreamIds()).toEqual(['conversation:live']);
    expect(client.blockedSurvivorStreamIds()).toEqual([]);

    const replacementPid = client.hostPid();
    client.close();
    try { process.kill(replacementPid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('will not retire a host holding a lane it cannot resume', async () => {
    // Retirement kills the CLIs; they return only through --resume. A lane the
    // app cannot resume (a codex stream whose rollout id was never linked, so
    // its persisted session id is still the 'seen' sentinel) would just be
    // destroyed — so refuse, block it, and leave the survivor for the owner.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-unresumable-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    const standInPath = path.join(legacyDir, 'legacy-daemon.cjs');
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [",
      "        { id: 'variant:resumable', status: 'running' },",
      "        { id: 'variant:unlinked', status: 'running' },",
      "      ] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));

    const client = createPtyHostClient({
      userDataPath: legacyDir,
      execPath: process.execPath,
      daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY,
      logger: { warn: () => {} },
      isLaneResumable: (id) => id !== 'variant:unlinked',
    });
    clients.push(client);

    expect(await client.ensureConnected()).toBe(null);
    // The legacy daemon is untouched — its in-flight work is still there.
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    // And every lane it holds is blocked, so nothing relaunches them beside it.
    expect(client.blockedSurvivorStreamIds().sort()).toEqual(['variant:resumable', 'variant:unlinked']);
    expect(client.takeRetiredStreamIds()).toEqual([]);

    client.close();
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('reports the lanes a detached-off sweep killed, and the ones it would not', async () => {
    // The sweep's client is thrown away immediately, so its findings only reach
    // the app through the returned ids: the killed lanes need the "restarted,
    // send continue" notice, and a host left standing must block its lanes.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-sweepids-'));
    const legacySock = ptyHostSocketPath(legacyDir);
    const standInPath = path.join(legacyDir, 'legacy-daemon.cjs');
    fs.writeFileSync(standInPath, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, streams: [",
      "        { id: 'conversation:live', status: 'running' },",
      "        { id: 'conversation:done', status: 'exited' },",
      "      ] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock);",
    ].join('\n'));

    // (a) A host it will not retire, because a lane cannot be resumed.
    let child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));
    const blockedClient = createPtyHostClient({
      userDataPath: legacyDir, execPath: process.execPath, daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY, logger: { warn: () => {} },
      isLaneResumable: () => false,
    });
    clients.push(blockedClient);
    const blockedSweep = await blockedClient.retireOutdatedSurvivor();
    expect(blockedSweep.outcome).toBe('blocked');
    expect(blockedSweep.blocked).toEqual(['conversation:live']); // exited record excluded
    expect(blockedSweep.retired).toEqual([]);
    expect(() => process.kill(child.pid, 0)).not.toThrow(); // untouched
    blockedClient.close();
    try { child.kill('SIGKILL'); } catch {}

    // (b) The same host, now resumable: retired, and its running lane reported.
    await waitFor(() => { try { process.kill(child.pid, 0); return false; } catch { return true; } });
    try { fs.rmSync(legacySock, { force: true }); } catch {}
    child = require('child_process').spawn(process.execPath, [standInPath, legacySock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(legacySock));
    const okClient = createPtyHostClient({
      userDataPath: legacyDir, execPath: process.execPath, daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY, logger: { warn: () => {} },
      isLaneResumable: () => true,
    });
    clients.push(okClient);
    const retiredSweep = await okClient.retireOutdatedSurvivor();
    expect(retiredSweep.outcome).toBe('retired');
    expect(retiredSweep.retired).toEqual(['conversation:live']);
    expect(retiredSweep.blocked).toEqual([]);

    okClient.close();
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('blocks the lanes a CURRENT survivor holds when this launch adopts nothing', async () => {
    // With detached mode off we leave a current-protocol host alone — but it is
    // still running those lanes and we keep no client to adopt them through, so
    // they must come back blocked or restore starts a second CLI on each.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-kept-'));
    const sock = ptyHostSocketPath(dir);
    const standIn = path.join(dir, 'current-daemon.cjs');
    fs.writeFileSync(standIn, [
      "const net = require('net');",
      "const sock = process.argv[2];",
      "const server = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (chunk) => {",
      "    buf += chunk.toString('utf8');",
      "    let i;",
      "    while ((i = buf.indexOf('\\n')) >= 0) {",
      "      const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "      if (!line.trim()) continue;",
      "      const msg = JSON.parse(line);",
      // protocol 2 = a CURRENT daemon, not one to retire
      "      c.write(JSON.stringify({ req: msg.req, ok: true, pid: process.pid, protocol: 2, streams: [",
      "        { id: 'conversation:held', status: 'running' },",
      "        { id: 'conversation:done', status: 'exited' },",
      "      ] }) + '\\n');",
      "    }",
      "  });",
      "});",
      "server.listen(sock);",
    ].join('\n'));
    const child = require('child_process').spawn(process.execPath, [standIn, sock], { stdio: 'ignore' });
    await waitFor(() => fs.existsSync(sock));

    const client = createPtyHostClient({
      userDataPath: dir, execPath: process.execPath, daemonPath: daemonCjs,
      nodePtyPath: STUB_NODE_PTY, logger: { warn: () => {} },
    });
    clients.push(client);

    const swept = await client.retireOutdatedSurvivor();
    expect(swept.outcome).toBe('kept');
    expect(swept.retired).toEqual([]);
    expect(swept.blocked).toEqual(['conversation:held']); // exited record excluded
    // It is CURRENT, so it is left running.
    expect(() => process.kill(child.pid, 0)).not.toThrow();

    client.close();
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  it('does not open any TCP listener — the daemon is a pty multiplexer only', async () => {
    // Lanes talk to api.anthropic.com directly on the CLI's own login; the
    // daemon must not stand up a local HTTP credential proxy for them.
    const client = makeClient();
    await client.ensureConnected();
    const pid = client.hostPid();
    expect(typeof pid).toBe('number');
    // lsof exits 1 with no output when nothing matches — exactly the pass case.
    let listeners = '';
    try {
      listeners = require('child_process')
        .execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .trim();
    } catch (err) {
      listeners = String(err?.stdout ?? '').trim();
    }
    expect(listeners).toBe('');
    daemonPid = pid;
  }, 30_000);
});

describe('hostIsGone', () => {
  const { hostIsGone } = require('../pty-host.cts');

  it('proves death only on ESRCH — a live or unsignalable process is not gone', async () => {
    // process.kill(pid, 0) throws ESRCH for "no such process" but EPERM for one
    // that exists and we may not signal (an elevated survivor). Reading EPERM as
    // death would let retirement skip the kill, call the lanes retired, and
    // relaunch them beside originals that are still running.
    expect(hostIsGone(process.pid)).toBe(false);

    // pid 1 (launchd/init) exists and this process cannot signal it -> EPERM on
    // macOS/Linux as a non-root user. Alive, therefore not gone.
    expect(hostIsGone(1)).toBe(false);

    // A pid we watched exit IS gone (ESRCH).
    const child = require('child_process').spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    await waitFor(() => hostIsGone(child.pid));
    expect(hostIsGone(child.pid)).toBe(true);
  }, 10_000);
});

describe('stageNodePtyForPlainNode', () => {
  const { stageNodePtyForPlainNode } = require('../pty-host.cts');
  let tmpDir;

  function makeFakeUnpackedNodePty(root) {
    const pkgRoot = path.join(
      root, 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty'
    );
    fs.mkdirSync(path.join(pkgRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: '9.9.9' }));
    fs.writeFileSync(path.join(pkgRoot, 'lib', 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(pkgRoot, 'build', 'Release', 'pty.node'), 'native');
    fs.writeFileSync(path.join(pkgRoot, 'build', 'Release', 'spawn-helper'), '#!/bin/sh\n', { mode: 0o755 });
    return pkgRoot;
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-stage-test-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('leaves non-asar paths untouched', () => {
    const p = path.join(tmpDir, 'plain', 'node_modules', 'node-pty', 'lib', 'index.js');
    expect(stageNodePtyForPlainNode(p, tmpDir, { warn: () => {} })).toBe(p);
  });

  it('stages an app.asar.unpacked node-pty outside the bundle, preserving the helper exec bit', () => {
    const userData = path.join(tmpDir, 'userData');
    fs.mkdirSync(userData, { recursive: true });
    const pkgRoot = makeFakeUnpackedNodePty(path.join(tmpDir, 'FakeApp'));
    const staged = stageNodePtyForPlainNode(path.join(pkgRoot, 'lib', 'index.js'), userData, { warn: () => {} });

    expect(staged).not.toContain('app.asar');
    expect(staged.startsWith(userData)).toBe(true);
    expect(fs.existsSync(path.join(staged, 'lib', 'index.js'))).toBe(true);
    const helper = path.join(staged, 'build', 'Release', 'spawn-helper');
    expect(fs.existsSync(helper)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(helper).mode & 0o100).toBeTruthy();
    }
    // The staged path must survive node-pty's own app.asar -> app.asar.unpacked
    // replace without being mangled (the bug this staging exists to avoid).
    expect(staged.replace('app.asar', 'app.asar.unpacked')).toBe(staged);

    // Second call with unchanged sources reuses the staged copy.
    const stamp = path.join(staged, '.staged.json');
    const before = fs.statSync(stamp).mtimeMs;
    const again = stageNodePtyForPlainNode(path.join(pkgRoot, 'lib', 'index.js'), userData, { warn: () => {} });
    expect(again).toBe(staged);
    expect(fs.statSync(stamp).mtimeMs).toBe(before);

    // A changed native binary (new Electron ABI rebuild) re-stages.
    fs.writeFileSync(path.join(pkgRoot, 'build', 'Release', 'pty.node'), 'native-rebuilt-bigger');
    stageNodePtyForPlainNode(path.join(pkgRoot, 'lib', 'index.js'), userData, { warn: () => {} });
    expect(fs.readFileSync(path.join(staged, 'build', 'Release', 'pty.node'), 'utf8')).toBe('native-rebuilt-bigger');

    // ...and so does a rebuild of the SAME BYTE LENGTH. `npm rebuild` for a new
    // Electron ABI routinely produces an identically sized binary; a size-only
    // stamp would leave the previous build staged and the daemon would load a
    // native module built for the wrong ABI.
    const sameLength = 'x'.repeat('native-rebuilt-bigger'.length);
    fs.writeFileSync(path.join(pkgRoot, 'build', 'Release', 'pty.node'), sameLength);
    stageNodePtyForPlainNode(path.join(pkgRoot, 'lib', 'index.js'), userData, { warn: () => {} });
    expect(fs.readFileSync(path.join(staged, 'build', 'Release', 'pty.node'), 'utf8')).toBe(sameLength);

    // spawn-helper is fingerprinted alongside it, so it gets the same treatment.
    const helperSrc = path.join(pkgRoot, 'build', 'Release', 'spawn-helper');
    const helperBefore = fs.readFileSync(helperSrc, 'utf8');
    const helperSameLength = 'y'.repeat(helperBefore.length);
    expect(helperSameLength).not.toBe(helperBefore);
    fs.writeFileSync(helperSrc, helperSameLength);
    stageNodePtyForPlainNode(path.join(pkgRoot, 'lib', 'index.js'), userData, { warn: () => {} });
    expect(fs.readFileSync(path.join(staged, 'build', 'Release', 'spawn-helper'), 'utf8')).toBe(helperSameLength);
  });
});

describe('resolvePtyHostExecPath', () => {
  const { resolvePtyHostExecPath } = require('../pty-host.cts');
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-exec-test-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('uses the macOS helper executable for packaged app node-mode children', () => {
    const appExe = path.join(tmpDir, 'Ace.app', 'Contents', 'MacOS', 'Ace');
    const helperExe = path.join(
      tmpDir,
      'Ace.app',
      'Contents',
      'Frameworks',
      'Ace Helper.app',
      'Contents',
      'MacOS',
      'Ace Helper'
    );
    fs.mkdirSync(path.dirname(appExe), { recursive: true });
    fs.mkdirSync(path.dirname(helperExe), { recursive: true });
    fs.writeFileSync(appExe, '');
    fs.writeFileSync(helperExe, '');

    const resolved = resolvePtyHostExecPath(appExe);
    expect(resolved).toBe(process.platform === 'darwin' ? helperExe : appExe);
  });

  it('falls back to the requested executable when no helper exists', () => {
    const appExe = path.join(tmpDir, 'NoHelper.app', 'Contents', 'MacOS', 'NoHelper');
    fs.mkdirSync(path.dirname(appExe), { recursive: true });
    fs.writeFileSync(appExe, '');

    expect(resolvePtyHostExecPath(appExe)).toBe(appExe);
  });
});

describe('pty-host daemon spawn-helper validation', () => {
  let tmpDir;
  let daemonCjs;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pty-validate-test-'));
    daemonCjs = path.join(tmpDir, 'pty-host-daemon.cjs');
    const { build } = require('esbuild');
    await build({
      entryPoints: [DAEMON_SRC],
      outfile: daemonCjs,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      packages: 'external',
      logLevel: 'silent',
    });
  }, 30_000);

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('refuses to start when node-pty has a native build but no spawn-helper', async function () {
    if (process.platform === 'win32') return; // helper is POSIX-only
    // Real-looking node-pty: pty.node present, spawn-helper MISSING. A daemon
    // that started anyway would fail (and leak a pty fd) on every spawn.
    const pkgRoot = path.join(tmpDir, 'broken-node-pty');
    fs.mkdirSync(path.join(pkgRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: '9.9.9', main: './lib/index.js' }));
    fs.writeFileSync(path.join(pkgRoot, 'lib', 'index.js'), 'module.exports = { spawn() { throw new Error("never"); } };\n');
    fs.writeFileSync(path.join(pkgRoot, 'build', 'Release', 'pty.node'), 'native');

    const { spawn } = require('child_process');
    const sock = path.join(tmpDir, 'validate.sock');
    const logPath = path.join(tmpDir, 'validate.log');
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [daemonCjs], {
        env: {
          ...process.env,
          ACE_PTY_HOST_SOCK: sock,
          ACE_PTY_HOST_NODE_PTY: pkgRoot,
          ACE_PTY_HOST_LOG: logPath,
        },
      });
      child.on('exit', (c) => resolve(c));
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(-1); }, 10_000);
    });
    expect(code).toBe(2);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('spawn-helper missing');
    expect(fs.existsSync(sock)).toBe(false);
  }, 20_000);
});
