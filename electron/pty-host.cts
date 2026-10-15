// Client for the detached PTY host (electron/pty-host-daemon.cts).
//
// The host owns the node-pty processes for claude/codex agent tabs so they
// keep working across app quits/restarts/crashes. This client connects the
// Electron main process to it, spawns the host on demand (detached,
// ELECTRON_RUN_AS_NODE), and exposes node-pty-shaped stream handles
// ({ write, resize, kill, onData, onExit }) so the pty registry can treat
// host-backed and in-process streams identically.
//
// Handles queue data/exit events until the first callback is wired, so a
// reattach replay that arrives before the registry finishes adopting the
// stream is never dropped.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 250;
const CONNECT_RETRIES = 16;

// The daemon generation this build requires. A daemon SURVIVES an app update, so
// a pre-upgrade host would otherwise keep serving its own (old) code to every
// lane — that is how the credential gateway kept running, port and all, after
// the build that deleted it. Generation 2 = no gateway (docs/architecture/lane-auth.md).
const REQUIRED_PTY_HOST_PROTOCOL = 2;

function ptyHostSocketPath(userDataPath: any) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ace-pty-${path.basename(userDataPath || 'default')}`;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtimeDir, `ace-pty.${path.basename(userDataPath || 'default')}.sock`);
}

// Files inside app.asar are invisible to a plain Node child process; the
// daemon script and node-pty are asarUnpack'ed, so retarget paths there.
function resolveUnpacked(p: string) {
  return p.includes(`app.asar${path.sep}`)
    ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : p;
}

function defaultNodePtyPath() {
  try {
    return resolveUnpacked(require.resolve('node-pty'));
  } catch {
    return null;
  }
}

function resolvePtyHostExecPath(execPath: string) {
  const candidate = execPath || process.execPath;
  if (process.platform !== 'darwin') return candidate;
  try {
    const contentsDir = path.resolve(path.dirname(candidate), '..');
    if (path.basename(contentsDir) !== 'Contents') return candidate;
    const appName = path.basename(candidate);
    const helper = path.join(
      contentsDir,
      'Frameworks',
      `${appName} Helper.app`,
      'Contents',
      'MacOS',
      `${appName} Helper`
    );
    if (fs.existsSync(helper)) return helper;
  } catch {}
  return candidate;
}

// node-pty must NOT be loaded by the daemon from inside app.asar.unpacked:
// its lib/unixTerminal.js computes the spawn-helper path with
// `helperPath.replace('app.asar', 'app.asar.unpacked')`, which mangles an
// already-unpacked __dirname into `app.asar.unpacked.unpacked/…`. The helper
// then doesn't exist, posix_spawn fails ENOENT for EVERY spawn (surfaced as
// the generic "posix_spawnp failed."), and each failed native spawn leaks a
// pty master fd — enough retries exhaust the machine-wide pty pool
// (kern.tty.ptmx_max) and break terminals system-wide. Stage the package to
// a real directory under userData and hand the daemon that path instead.
function stageNodePtyForPlainNode(resolvedPath: any, userDataPath: any, logger: any = console) {
  if (!resolvedPath || !userDataPath || !resolvedPath.includes('app.asar')) return resolvedPath;
  try {
    const marker = `${path.sep}node-pty${path.sep}`;
    const idx = resolvedPath.lastIndexOf(marker);
    if (idx < 0) return resolvedPath;
    const pkgRoot = resolvedPath.slice(0, idx + marker.length - 1);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const stageRoot = path.join(userDataPath, 'pty-host', `node-pty-${pkg.version || '0'}`);
    const stampPath = path.join(stageRoot, '.staged.json');
    // pty.node is rebuilt per Electron ABI, so the version alone is not a
    // sufficient cache key — fingerprint the native binaries too. By CONTENT,
    // not size: `npm rebuild` for a new Electron ABI routinely produces a
    // binary of the same byte length, and a size-only stamp would then leave
    // the previous build staged. The daemon would load a native module built
    // for the wrong ABI and every detached lane would fail to start.
    const fingerprint = (root: string) => {
      const out: any = {};
      for (const rel of ['build/Release/pty.node', 'build/Release/spawn-helper']) {
        try {
          out[rel] = crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(root, rel)))
            .digest('hex');
        } catch {
          out[rel] = null;
        }
      }
      return JSON.stringify({ version: pkg.version || '0', ...out });
    };
    const wanted = fingerprint(pkgRoot);
    let current = null;
    try { current = fs.readFileSync(stampPath, 'utf8'); } catch {}
    if (current !== wanted) {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.mkdirSync(stageRoot, { recursive: true });
      for (const entry of ['package.json', 'lib', 'build', 'prebuilds']) {
        const src = path.join(pkgRoot, entry);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(stageRoot, entry), { recursive: true });
      }
      fs.writeFileSync(stampPath, wanted);
    }
    if (!fs.existsSync(path.join(stageRoot, 'lib', 'index.js'))) return resolvedPath;
    return stageRoot;
  } catch (err: any) {
    logger?.warn?.('[ace] node-pty staging failed; using unpacked path:', err?.message || err);
    return resolvedPath;
  }
}

// Capture a process's identity (start-time + argv signature via `ps`) NOW and return a
// verifier that re-reads it later and confirms the pid is STILL the same process (signal-0
// liveness + exact signature match). Fail-closed: an empty/unreadable signature ⇒ false
// (never confirm), so a caller skips the kill rather than risk a reused pid. Deps injected.
// Proof that a pid is GONE — not merely unreachable. process.kill(pid, 0)
// throws ESRCH for "no such process", but EPERM/EACCES for one that exists and
// we may not signal (a survivor started elevated, say). Treating EPERM as death
// would let retirement skip the kill, declare the lanes retired, and relaunch
// them beside originals that are still running.
function hostIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: any) {
    return err?.code === 'ESRCH';
  }
}

function makeHostIdentityGuard(pid: number, deps?: {
  readSignature?: (pid: number) => string;
  isAlive?: (pid: number) => boolean;
}): (checkPid: number) => boolean {
  const readSignature = deps?.readSignature ?? defaultProcessSignature;
  const isAlive = deps?.isAlive ?? ((p: number) => !hostIsGone(p));
  const expected = readSignature(pid);
  return (checkPid: number) => {
    if (!expected) return false;
    if (!isAlive(checkPid)) return false;
    return readSignature(checkPid) === expected;
  };
}

function defaultProcessSignature(pid: number): string {
  try {
    // Start time + command line: enough to tell OUR daemon from a stranger that
    // inherited its pid. `ps` does not exist on Windows, and an empty signature
    // is fail-closed (never confirm), which would leave a legacy daemon owning
    // the named pipe forever — so Windows gets the CIM equivalent.
    const out =
      process.platform === 'win32'
        ? require('child_process').execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | ` +
                'ForEach-Object { "$($_.CreationDate) $($_.CommandLine)" }',
            ],
            { encoding: 'utf8', timeout: 4000, windowsHide: true },
          )
        : require('child_process').execFileSync(
            'ps', ['-o', 'lstart=,command=', '-p', String(pid)],
            { encoding: 'utf8', timeout: 1500 },
          );
    return String(out).trim();
  } catch {
    return '';
  }
}

function createPtyHostClient({
  userDataPath,
  execPath,
  daemonPath,
  nodePtyPath,
  logger = console,
  // Injectable so a test can drive the fail-closed branch (a platform where the
  // signature read fails), mirroring terminateDetachedHost's makeIdentityGuard.
  makeIdentityGuard = makeHostIdentityGuard,
  // Asked, per lane, before an outdated host is retired: may this stream's CLI
  // be killed and brought back? A lane the app cannot resume (a Codex stream
  // whose rollout id was never linked, say) would be destroyed outright, so
  // retirement refuses instead and the survivor is left for the owner to clear.
  isLaneResumable = null,
}: any = {}) {
  const sockPath = ptyHostSocketPath(userDataPath);
  const logPath = userDataPath ? path.join(userDataPath, 'pty-host.log') : null;
  const resolvedDaemonPath = daemonPath || resolveUnpacked(path.join(__dirname, 'pty-host-daemon.cjs'));
  const resolvedNodePtyPath = stageNodePtyForPlainNode(nodePtyPath || defaultNodePtyPath(), userDataPath, logger);

  let socket: any = null;
  let alive = false;
  let closing = false;
  let hostPid: any = null;
  // Protocol generation reported by the connected daemon (0 = pre-versioning).
  let hostProtocol = 0;
  // Captured the moment a `hello` proves the pid is OUR daemon; re-checked before
  // every signal so a pid the daemon has since released is never blind-killed.
  let hostIdentity: ((pid: number) => boolean) | null = null;
  // Lanes an OUTDATED host was holding when we retired it. Their CLIs died with
  // it, so the caller relaunches them with --resume and tells the owner which
  // ones were interrupted (a mid-turn worker resumes at an idle composer unless
  // wake prompts are opted in).
  let retiredStreamIds: string[] = [];
  // Lanes still RUNNING inside an outdated host we could not retire. Relaunching
  // them would put a second agent on the same transcript, so the app must skip
  // them entirely until the survivor is gone.
  let blockedSurvivorStreamIds: string[] = [];
  // The ChildProcess for a daemon THIS client spawned (null when we only adopted a
  // survivor by pid). Retained so teardown can kill it via the handle, not a raw pid.
  let spawnedChild: any = null;
  let nextReq = 1;
  const pending = new Map(); // req -> { resolve, reject, timer }
  const handles = new Map(); // stream id -> handle internals

  function makeHandle(id: string) {
    const internal: any = {
      id,
      lastSeq: 0,
      dataCbs: [],
      exitCbs: [],
      queuedData: [],
      queuedExit: null,
      exited: false,
    };
    const fireData = (data: string) => {
      if (internal.dataCbs.length === 0) {
        internal.queuedData.push(data);
        return;
      }
      for (const cb of internal.dataCbs) cb(data);
    };
    const fireExit = (exitCode: number) => {
      if (internal.exited) return;
      internal.exited = true;
      if (internal.exitCbs.length === 0) {
        internal.queuedExit = { exitCode };
        return;
      }
      for (const cb of internal.exitCbs) cb({ exitCode });
    };
    internal.fireData = fireData;
    internal.fireExit = fireExit;
    const handle = {
      detachedHost: true,
      onData(cb: any) {
        internal.dataCbs.push(cb);
        while (internal.queuedData.length) cb(internal.queuedData.shift());
      },
      onExit(cb: any) {
        internal.exitCbs.push(cb);
        if (internal.queuedExit) {
          const queued = internal.queuedExit;
          internal.queuedExit = null;
          cb(queued);
        }
      },
      write(data: string) {
        request('write', { id, data }).catch(() => {});
      },
      resize(cols: number, rows: number) {
        request('resize', { id, cols, rows }).catch(() => {});
      },
      kill() {
        handles.delete(id);
        // Return the in-flight kill request so an AUTH teardown can await
        // daemon-confirmed termination before closing the host socket (a
        // discarded request could be dropped on immediate socket close, leaving
        // a detached daemon running). Attach a catch so fire-and-forget callers
        // never trigger an unhandled rejection.
        const pending = request('kill', { id });
        pending.catch(() => {});
        return pending;
      },
    };
    internal.handle = handle;
    handles.set(id, internal);
    return internal;
  }

  function rejectAllPending(reason: string) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function handleSocketDown() {
    const wasAlive = alive;
    alive = false;
    socket = null;
    rejectAllPending('pty-host connection lost');
    if (closing || !wasAlive) return;
    // The host going down takes its PTYs with it — surface that as exits so
    // tabs don't look alive when nothing is behind them.
    logger.warn?.('[ace] pty-host connection lost; marking detached streams exited');
    for (const internal of handles.values()) internal.fireExit(-1);
    handles.clear();
  }

  function handleEvent(msg: any) {
    const internal = handles.get(msg.id);
    if (!internal) return;
    if (msg.ev === 'data') {
      if (typeof msg.seq === 'number') {
        if (msg.seq <= internal.lastSeq) return; // replay overlap dedupe
        internal.lastSeq = msg.seq;
      }
      internal.fireData(String(msg.data ?? ''));
    } else if (msg.ev === 'exit') {
      internal.fireExit(typeof msg.code === 'number' ? msg.code : -1);
      handles.delete(msg.id);
    }
  }

  function request(op: string, params: any = {}) {
    return new Promise((resolve, reject) => {
      if (!alive || !socket) return reject(new Error('pty-host not connected'));
      const req = nextReq++;
      const timer = setTimeout(() => {
        pending.delete(req);
        reject(new Error(`pty-host request timed out: ${op}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(req, { resolve, reject, timer });
      try {
        socket.write(JSON.stringify({ req, op, ...params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(req);
        reject(err);
      }
    });
  }

  function connectOnce(): Promise<any> {
    return new Promise((resolve) => {
      const sock = net.connect(sockPath);
      let buf = '';
      let settled = false;
      sock.once('connect', () => {
        socket = sock;
        alive = true;
        sock.on('data', (chunk: any) => {
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
            if (msg.ev) {
              try { handleEvent(msg); } catch (err: any) {
                logger.warn?.('[ace] pty-host event handler failed:', err?.message || err);
              }
            } else if (msg.req != null && pending.has(msg.req)) {
              const entry = pending.get(msg.req);
              pending.delete(msg.req);
              clearTimeout(entry.timer);
              if (msg.ok) entry.resolve(msg);
              else entry.reject(new Error(msg.error || 'pty-host request failed'));
            }
          }
        });
        sock.on('close', handleSocketDown);
        sock.on('error', () => {});
        request('hello')
          .then((res: any) => {
            settled = true;
            hostPid = res.pid ?? null;
            hostProtocol = Number(res.protocol) || 0;
            // ONLY for a host we may have to retire. The signature read shells
            // out (PowerShell on Windows, ~seconds) and this runs on the main
            // thread, so a current daemon must never pay for it.
            hostIdentity =
              hostProtocol < REQUIRED_PTY_HOST_PROTOCOL && typeof hostPid === 'number' && hostPid > 0
                ? makeIdentityGuard(hostPid)
                : null;
            resolve(Array.isArray(res.streams) ? res.streams : []);
          })
          .catch(() => {
            settled = true;
            resolve(null);
          });
      });
      sock.once('error', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  function spawnDaemon() {
    if (!resolvedNodePtyPath) throw new Error('node-pty path unresolvable for pty-host');
    if (!fs.existsSync(resolvedDaemonPath)) {
      throw new Error(`pty-host daemon script missing: ${resolvedDaemonPath}`);
    }
    let logFd: any = null;
    try {
      if (logPath) logFd = fs.openSync(logPath, 'a');
    } catch {}
    const child = spawn(resolvePtyHostExecPath(execPath || process.execPath), [resolvedDaemonPath], {
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        ACE_PTY_HOST_SOCK: sockPath,
        ACE_PTY_HOST_NODE_PTY: resolvedNodePtyPath,
        ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
        ...(logPath ? { ACE_PTY_HOST_LOG: logPath } : {}),
      },
    });
    // Retain the handle so an auth teardown can kill THIS spawned daemon via the
    // ChildProcess (immune to pid reuse) instead of signalling a raw numeric pid.
    spawnedChild = child;
    child.on('exit', () => { if (spawnedChild === child) spawnedChild = null; });
    child.unref();
    if (logFd != null) {
      try { fs.closeSync(logFd); } catch {}
    }
  }

  // Kill an outdated daemon and stand a current one up in its place.
  //   { outcome: 'blocked' }  -> the old host is (or may still be) alive; NOTHING
  //                              was unlinked or spawned, and its lanes must not
  //                              be relaunched.
  //   { outcome: 'retired', streams } -> the old host is provably gone. `streams`
  //                              is the replacement's list, or null if the
  //                              replacement did not come up (the retirement
  //                              still happened, so its lanes are recorded).
  async function retireOutdatedHost(doomed: string[]) {
    const stale = hostPid;
    // Identity captured at THIS host's hello. It answers "is this pid still our
    // daemon" — NOT "is it dead": a signature we cannot read also returns false.
    // Death is a separate, independent question (signal 0), because treating an
    // unreadable signature as death is what would let us unlink the socket out
    // from under a live daemon and start a second one beside it.
    const stillOurs = hostIdentity;
    const isGone = hostIsGone;
    try { socket?.destroy(); } catch {}
    socket = null;
    alive = false;
    rejectAllPending('pty-host retired (outdated protocol)');
    if (!(typeof stale === 'number' && stale > 0 && stale !== process.pid) || !stillOurs) {
      logger.warn?.('[ace] cannot identify the outdated pty-host; leaving it alone');
      return { outcome: 'blocked' as const, streams: null };
    }
    // It may have exited between `hello` and here — in which case there is no
    // agent left to duplicate and nothing to block. `stillOurs` alone cannot
    // tell that apart from an unreadable signature, so ask isGone directly.
    if (stillOurs(stale)) {
      try { process.kill(stale, 'SIGTERM'); } catch {}
      // Escalate only while the pid is still verifiably OURS, so a number a
      // stranger has since inherited is never signalled again.
      for (let i = 0; i < 10 && !isGone(stale); i++) {
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
        if (i === 5 && stillOurs(stale)) { try { process.kill(stale, 'SIGKILL'); } catch {} }
      }
    }
    if (!isGone(stale)) {
      logger.warn?.(`[ace] outdated pty-host pid ${stale} is still alive; detached streams stay disabled`);
      return { outcome: 'blocked' as const, streams: null };
    }
    // Provably dead: its lanes were interrupted, so record them for the notice
    // NOW — whether or not the replacement comes up on this attempt.
    retiredStreamIds = doomed;
    try { fs.unlinkSync(sockPath); } catch {}
    hostPid = null;
    hostProtocol = 0;
    hostIdentity = null;
    try {
      spawnDaemon();
    } catch (err: any) {
      logger.warn?.('[ace] failed to spawn replacement pty-host:', err?.message || err);
      return { outcome: 'retired' as const, streams: null };
    }
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
      const fresh = await connectOnce();
      if (fresh !== null && hostProtocol >= REQUIRED_PTY_HOST_PROTOCOL) {
        return { outcome: 'retired' as const, streams: fresh };
      }
    }
    logger.warn?.('[ace] replacement pty-host did not come up');
    return { outcome: 'retired' as const, streams: null };
  }

  // Lanes a legacy host is actually RUNNING. Its `hello` also lists exited
  // records (they live until `release`), and blocking those would strand
  // perfectly resumable sessions.
  function runningIds(streams: any[]): string[] {
    return (streams || [])
      .filter((s2: any) => s2 && s2.status === 'running' && typeof s2.id === 'string')
      .map((s2: any) => s2.id);
  }

  // Retire the outdated host we are currently attached to, and report what the
  // caller should do with its lanes. Shared by both discovery points (the first
  // connect, and a retry that reaches a daemon the first attempt missed) so a
  // legacy host is never merely detected and left running.
  async function handleOutdatedHost(streams: any[]) {
    logger.warn?.(
      `[ace] pty-host protocol ${hostProtocol} < ${REQUIRED_PTY_HOST_PROTOCOL} (survivor of an older build); retiring it`
    );
    const doomed = runningIds(streams);
    // Retirement kills these CLIs; they come back only through --resume. A lane
    // the app cannot resume would simply be destroyed, so refuse rather than
    // silently drop in-flight work — the owner clears the survivor and nothing
    // is lost. Blocking also stops anything relaunching them meanwhile.
    if (typeof isLaneResumable === 'function') {
      const unresumable = doomed.filter((id: string) => {
        // A lookup that throws proves nothing; treat it as NOT resumable rather
        // than killing a lane on an unverified assumption.
        try { return !isLaneResumable(id); } catch { return true; }
      });
      if (unresumable.length) {
        logger.warn?.(
          `[ace] outdated pty-host holds ${unresumable.length} lane(s) that cannot be resumed (${unresumable.join(', ')}); not retiring it`
        );
        blockedSurvivorStreamIds = doomed;
        try { socket?.destroy(); } catch {}
        socket = null;
        alive = false;
        return null;
      }
    }
    const result = await retireOutdatedHost(doomed);
    if (result.outcome === 'blocked') {
      // Still alive with those lanes in it: report NO survivors AND flag them,
      // so nothing "resumes" a session whose original agent is still running.
      blockedSurvivorStreamIds = doomed;
      try { socket?.destroy(); } catch {}
      socket = null;
      alive = false;
      return null;
    }
    return result.streams;
  }

  // Connect to a live host, spawning one if needed. Resolves with the host's
  // surviving stream list (possibly empty), or null when unavailable.
  // SINGLE-FLIGHT: concurrent lane starts during an upgrade must not each enter
  // retirement — one would SIGTERM the host while another fails its identity
  // check and blocks every lane, or they would unlink/spawn twice.
  let connectInFlight: Promise<any> | null = null;
  function ensureConnected() {
    if (!connectInFlight) {
      connectInFlight = ensureConnectedOnce().finally(() => { connectInFlight = null; });
    }
    return connectInFlight;
  }

  async function ensureConnectedOnce() {
    let streams: any = null;
    const served = (list: any) => {
      // We are on a current host: whatever was blocked by an earlier pass is
      // resumable again, or this pass would refuse those lanes forever.
      blockedSurvivorStreamIds = [];
      return list;
    };
    if (alive) {
      try {
        const res: any = await request('hello');
        hostPid = res.pid ?? hostPid;
        hostProtocol = Number(res.protocol) || 0;
        hostIdentity =
          hostProtocol < REQUIRED_PTY_HOST_PROTOCOL && typeof hostPid === 'number' && hostPid > 0
            ? makeIdentityGuard(hostPid)
            : null;
        streams = Array.isArray(res.streams) ? res.streams : [];
      } catch {
        return null;
      }
      // Fall through to the protocol gate below: connectExisting() (boot
      // teardown) may already have attached us to an outdated survivor.
      if (hostProtocol >= REQUIRED_PTY_HOST_PROTOCOL) return served(streams);
    } else {
      streams = await connectOnce();
    }
    // A survivor from a previous app generation runs the code it was STARTED
    // with. Adopting one silently reinstates whatever this build removed (the
    // credential gateway and its listener, account-scoped CODEX_HOMEs, the old
    // spawn env) for every lane it holds. Retire it instead; the app's normal
    // agent_resume_state path brings its lanes back with --resume on the fresh
    // daemon, which is what already happens whenever a daemon dies.
    if (streams !== null && hostProtocol < REQUIRED_PTY_HOST_PROTOCOL) {
      const replaced = await handleOutdatedHost(streams);
      if (replaced !== null) return served(replaced);
      if (blockedSurvivorStreamIds.length) return null;
      streams = null;
    }
    if (streams !== null) return served(streams);
    try {
      spawnDaemon();
    } catch (err: any) {
      logger.warn?.('[ace] failed to spawn pty-host:', err?.message || err);
      return null;
    }
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
      streams = await connectOnce();
      if (streams !== null) break;
    }
    // The retry can reach a legacy daemon the first attempt missed (briefly
    // unreachable), or land back on one we failed to retire. Either way it is
    // the same problem, so run the same retirement — detecting it and walking
    // away would leave its gateway and TCP listener up indefinitely.
    if (streams !== null && hostProtocol < REQUIRED_PTY_HOST_PROTOCOL) {
      const replaced = await handleOutdatedHost(streams);
      if (replaced !== null) return served(replaced);
      logger.warn?.('[ace] outdated pty-host survives; detached agent streams disabled');
      return null;
    }
    if (streams !== null) return served(streams);
    logger.warn?.('[ace] pty-host did not come up; detached agent streams disabled');
    return null;
  }

  // Survivor-only sweep for a launch that keeps NO host client (detached mode
  // off). A preserved daemon does not exit while it holds stream records, so an
  // outdated one would sit there running the code this build replaced — its
  // credential gateway and TCP listener included. Connect without spawning; if
  // it is outdated, kill it and DO NOT stand a replacement up (nobody wants a
  // daemon this launch). Returns { outcome, retired, blocked }: this client is
  // discarded straight after, so the lane ids have to travel with the result or
  // the caller cannot notice the interrupted ones — nor refuse to relaunch lanes
  // still alive inside a host we left standing.
  async function retireOutdatedSurvivor() {
    const streams = await connectExisting();
    if (streams === null) return { outcome: 'none', retired: [], blocked: [] };
    const running = runningIds(streams);
    if (hostProtocol >= REQUIRED_PTY_HOST_PROTOCOL) {
      close();
      // A CURRENT host is left alone — but it is still holding these lanes, and
      // this launch keeps no client to adopt them through. Report them blocked
      // or restore reads them as "missing" and starts a second CLI on each
      // one's session and transcript.
      return { outcome: 'kept', retired: [], blocked: running };
    }
    // Same rule as handleOutdatedHost: killing a lane the app cannot resume
    // destroys it outright, so leave the survivor for the owner instead.
    if (typeof isLaneResumable === 'function') {
      const unresumable = running.filter((id: string) => {
        try { return !isLaneResumable(id); } catch { return true; }
      });
      if (unresumable.length) {
        logger.warn?.(
          `[ace] outdated pty-host holds ${unresumable.length} lane(s) that cannot be resumed; not retiring it`
        );
        blockedSurvivorStreamIds = running;
        close();
        return { outcome: 'blocked', retired: [], blocked: running };
      }
    }
    logger.warn?.(
      `[ace] outdated pty-host (protocol ${hostProtocol}) survives with detached mode off; retiring it`
    );
    const stale = hostPid;
    const stillOurs = hostIdentity;
    const isGone = hostIsGone;
    close();
    const blockedResult = { outcome: 'blocked' as const, retired: [] as string[], blocked: running };
    if (!(typeof stale === 'number' && stale > 0 && stale !== process.pid) || !stillOurs) return blockedResult;
    if (stillOurs(stale)) {
      try { process.kill(stale, 'SIGTERM'); } catch {}
      for (let i = 0; i < 10 && !isGone(stale); i++) {
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
        if (i === 5 && stillOurs(stale)) { try { process.kill(stale, 'SIGKILL'); } catch {} }
      }
    }
    if (!isGone(stale)) return blockedResult;
    try { fs.unlinkSync(sockPath); } catch {}
    return { outcome: 'retired' as const, retired: running, blocked: [] as string[] };
  }

  // Connect to a SURVIVOR host only — never spawn. Resolves the surviving stream
  // list (possibly empty) and learns the host PID, or null when no daemon is
  // listening. The boot deny-path teardown uses this to find and kill a prior
  // session's detached host without starting a new runtime for a denied user.
  async function connectExisting() {
    if (alive) {
      try {
        const res: any = await request('hello');
        hostPid = res.pid ?? hostPid;
        hostProtocol = Number(res.protocol) || 0;
        hostIdentity =
          hostProtocol < REQUIRED_PTY_HOST_PROTOCOL && typeof hostPid === 'number' && hostPid > 0
            ? makeIdentityGuard(hostPid)
            : null;
        return Array.isArray(res.streams) ? res.streams : [];
      } catch {
        return null;
      }
    }
    return connectOnce();
  }

  // Synchronous by design: callers sit in the (synchronous) pty registry
  // spawn path. Spawn failures surface through the handle as data + exit.
  function spawnStream({ id, bin, args, cwd, env, cols, rows, agent }: any) {
    const internal = makeHandle(id);
    request('spawn', { id, bin, args, cwd, env, cols, rows, agent })
      .catch(async (err: any) => {
        // The host may still be running this stream from a previous app
        // generation (e.g. boot adoption was missed). The running agent IS
        // the session the caller wants — reattach instead of failing, which
        // otherwise dead-ends the tab in a "stream already running" loop.
        if (/already running/i.test(String(err?.message || ''))) {
          try {
            const res: any = await request('attach', { id });
            internal.fireData('\x1b[33m[ace] Reattached to the agent already running in the pty-host.\x1b[0m\r\n');
            if (res.status === 'exited') {
              internal.fireExit(typeof res.exitCode === 'number' ? res.exitCode : -1);
              handles.delete(id);
            }
            return;
          } catch (attachErr: any) {
            err = attachErr;
          }
        }
        internal.fireData(`\x1b[31mFailed to launch ${agent || 'agent'} via pty-host: ${err?.message || err}\x1b[0m\r\n`);
        internal.fireExit(-1);
        handles.delete(id);
      });
    return internal.handle;
  }

  // Reattach to a stream that survived inside the host. The attach replay is
  // delivered through the handle (queued until callbacks are wired).
  async function adoptStream(id: string) {
    const internal = handles.get(id) || makeHandle(id);
    const res: any = await request('attach', { id });
    return { handle: internal.handle, status: res.status, exitCode: res.exitCode ?? null };
  }

  async function release(id: string) {
    try { await request('release', { id }); } catch {}
  }

  async function killStream(id: string) {
    handles.delete(id);
    try { await request('kill', { id }); } catch {}
  }

  function close() {
    closing = true;
    rejectAllPending('pty-host client closed');
    try { socket?.end(); } catch {}
    try { socket?.destroy(); } catch {}
    socket = null;
    alive = false;
  }

  return {
    socketPath: sockPath,
    isConnected: () => alive,
    hostPid: () => hostPid,
    hostProtocol: () => hostProtocol,
    // Drained once: the lanes lost to an outdated-host retirement this launch.
    takeRetiredStreamIds: () => { const ids = retiredStreamIds; retiredStreamIds = []; return ids; },
    // Lanes locked inside an un-retirable outdated host. NOT drained: they stay
    // blocked for as long as that host is up, and every relaunch pass must skip
    // them or it will start a second agent on a live session.
    blockedSurvivorStreamIds: () => [...blockedSurvivorStreamIds],
    retireOutdatedSurvivor,
    spawnedChildHandle: () => spawnedChild,
    ensureConnected,
    connectExisting,
    spawnStream,
    adoptStream,
    release,
    killStream,
    close,
  };
}

module.exports = { createPtyHostClient, ptyHostSocketPath, stageNodePtyForPlainNode, resolvePtyHostExecPath, makeHostIdentityGuard, hostIsGone };
