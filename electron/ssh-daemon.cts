

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const IS_WINDOWS = process.platform === 'win32';

function controlPathFor(agentUser: any) {
  const socketDir = path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 's');
  try {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  } catch { /* SSH reports an unusable control path when connecting. */ }
  const prefix = agentUser || 'root';
  return path.join(socketDir, `${prefix}-%C`);
}

function sshBaseOptions(agentUser: any = null) {
  const base = ['-o', 'BatchMode=yes'];
  if (!IS_WINDOWS) {
    base.push(
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=600',
      '-o', `ControlPath=${controlPathFor(agentUser)}`
    );
  }
  return base;
}

function spawnAsync(cmd: any, args: any, { input, encoding = 'utf8', maxBuffer = 32 * 1024 * 1024 }: any = {}): Promise<any> {
  return new Promise((resolve: any) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: any[] = [];
    const stderrChunks: any[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let overflowed = false;
    proc.stdout.on('data', (chunk: any) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) overflowed = true;
      else stdoutChunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: any) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) overflowed = true;
      else stderrChunks.push(chunk);
    });
    proc.on('error', (err: any) => {
      resolve({ status: -1, stdout: '', stderr: err.message });
    });
    proc.on('close', (code: any) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      resolve({
        status: overflowed ? -1 : code,
        stdout: encoding ? stdout.toString(encoding) : stdout,
        stderr: encoding ? stderr.toString(encoding) : stderr,
      });
    });
    if (input !== undefined) {
      proc.stdin.end(input);
    } else {
      proc.stdin.end();
    }
  });
}

const DAEMON_VERSION = '0.5.0';
const RPC_TIMEOUT_MS = 30000;

const REMOTE_PASTES_DIR_DEFAULT = '~/.ace-coder/pastes';

function resolveDaemonPaths(agentUser: any) {
  if (agentUser) {
    const home = `/home/${agentUser}`;
    return {
      dir: `${home}/.ace-coder`,
      binary: `${home}/.ace-coder/ace-coder-daemon`,
      pastesDir: `${home}/.ace-coder/pastes`,
    };
  }
  return {
    dir: '~/.ace-coder',
    binary: '~/.ace-coder/ace-coder-daemon',
    pastesDir: REMOTE_PASTES_DIR_DEFAULT,
  };
}

const DAEMON_REMOTE_PASTES_DIR = REMOTE_PASTES_DIR_DEFAULT;

function getBinaryPath(osName: any, arch: any) {
  const base = path.join(__dirname, 'bin');
  const key = `${osName}-${arch}`;
  return path.join(base, `ace-coder-daemon-${key}`);
}

function mapUname(unameSys: any, unameArch: any) {
  const sys = unameSys.trim().toLowerCase();
  const archRaw = unameArch.trim().toLowerCase();
  let osName;
  if (sys.includes('linux')) osName = 'linux';
  else if (sys.includes('darwin')) osName = 'darwin';
  else return null;

  let arch;
  if (archRaw === 'x86_64' || archRaw === 'amd64') arch = 'amd64';
  else if (archRaw === 'aarch64' || archRaw === 'arm64') arch = 'arm64';
  else return null;

  return { os: osName, arch };
}

class AceDaemon extends EventEmitter {
  host: any;
  agentUser: any;
  remoteDir: any;
  remotePath: any;
  pastesDir: any;
  proc: any;
  seq: any;
  pending: any;
  bufferHead: any;
  status: any;
  readyPromise: any;
  stderrBuf: any;

  constructor(host: any, agentUser: any = null) {
    super();
    this.host = host;
    this.agentUser = agentUser;
    const paths = resolveDaemonPaths(agentUser);
    this.remoteDir = paths.dir;
    this.remotePath = paths.binary;
    this.pastesDir = paths.pastesDir;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.bufferHead = Buffer.alloc(0);
    this.status = 'idle';
    this.readyPromise = null;
    this.stderrBuf = '';
  }

  async ensureReady() {
    if (this.status === 'ready') return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._connect().catch((err: any) => {
      this.readyPromise = null;
      this.status = 'closed';
      throw err;
    });
    return this.readyPromise;
  }

  async _connect() {
    this.status = 'connecting';







    try {
      await this._spawnAndVerify();
      this.status = 'ready';
      return;
    } catch (err) {

      this._teardownProc();


    }

    await this._bootstrap();
    await this._spawnAndVerify();
    this.status = 'ready';
  }

  async _spawnAndVerify() {
















    const remoteExec = this.agentUser
      ? `su ${this.agentUser} -s /bin/bash -c 'cd /home/${this.agentUser} && HOME=/home/${this.agentUser} USER=${this.agentUser} LOGNAME=${this.agentUser} exec ${this.remotePath} serve --stdio'`
      : `exec ${this.remotePath} serve --stdio`;
    const args = [
      ...sshBaseOptions(this.agentUser),
      '-T',
      '-o', 'ServerAliveInterval=30',
      this.host,
      remoteExec,
    ];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.bufferHead = Buffer.alloc(0);
    this.stderrBuf = '';

    proc.stdout.on('data', (chunk: any) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk: any) => {
      this.stderrBuf += chunk.toString('utf8');
      if (this.stderrBuf.length > 4000) {
        this.stderrBuf = this.stderrBuf.slice(-4000);
      }
    });
    proc.on('exit', (code: any) => this._onExit(code));
    proc.on('error', (err: any) => this._onError(err));




    const versionInfo: any = await Promise.race([
      this._request('version', {}),
      new Promise((_: any, reject: any) =>
        setTimeout(() => reject(new Error('version probe timeout')), 8000)
      ),
    ]);
    if (versionInfo?.protocol !== '1') {
      throw new Error(`unexpected ace-coder-daemon protocol: ${versionInfo?.protocol}`);
    }
    if (versionInfo?.daemon_version !== DAEMON_VERSION) {
      throw new Error(
        `ace-coder-daemon version mismatch: remote ${versionInfo?.daemon_version}, expected ${DAEMON_VERSION}`
      );
    }

    // Resolve `~` in pastesDir once, now, while we know the daemon is alive.
    // fs.list('~') returns the absolute home dir — caching it here means
    // every subsequent caller sees a fully-resolved pastesDir and we never
    // have to shell-expand a path later.
    if (typeof this.pastesDir === 'string' && this.pastesDir.startsWith('~')) {
      try {
        const home = await this._resolveHome();
        if (home) {
          this.pastesDir = home + this.pastesDir.slice(1);
        }
      } catch {
        // Non-fatal: pasteClipboardImageRemote will fall back to the raw
        // `~`-prefixed path and the daemon's own expandPath() handles it
        // server-side. We just lose the guarantee of an absolute return.
      }
    }
  }

  async _resolveHome() {
    const result: any = await this._request('fs.list', { path: '~' });
    return typeof result?.home === 'string' ? result.home : null;
  }

  _teardownProc() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('daemon reconnecting'));
    }
    this.pending.clear();
  }

  async _bootstrap() {






    const base = sshBaseOptions(null);






    let script = 'uname -s && uname -m && ';
    if (this.agentUser) {
      script +=
        `(id -u ${this.agentUser} >/dev/null 2>&1 || useradd -m -s /bin/bash ${this.agentUser}) && ` +
        `install -d -o ${this.agentUser} -g ${this.agentUser} -m 0755 ` +
        `${this.remoteDir} ${this.pastesDir} /home/${this.agentUser}/workspaces && `;
    } else {
      script += `mkdir -p ${this.remoteDir} ${this.pastesDir} && `;
    }
    script +=
      `if [ -x ${this.remotePath} ]; then ${this.remotePath} version; else echo missing; fi`;

    const detect = await spawnAsync('ssh', [...base, this.host, script]);
    if (detect.status !== 0) {
      throw new Error(`ssh ${this.host}: ${detect.stderr || 'unable to connect'}`);
    }
    const lines = detect.stdout.trim().split('\n');
    if (lines.length < 3) {
      throw new Error(`unexpected bootstrap output: ${detect.stdout}`);
    }
    const mapped = mapUname(lines[0], lines[1]);
    if (!mapped) {
      throw new Error(`unsupported remote platform: ${lines.slice(0, 2).join(' ')}`);
    }
    const localBin = getBinaryPath(mapped.os, mapped.arch);
    if (!fs.existsSync(localBin)) {
      throw new Error(`Remote daemon binary missing: ${localBin}. Build it with bash electron/remote-daemon/build.sh (Go 1.22 or newer required).`);
    }
    const remoteVersion = lines[2];
    if (remoteVersion === DAEMON_VERSION) {
      return;
    }




    const binaryBytes = await fs.promises.readFile(localBin);
    let uploadCmd =
      `cat > ${this.remotePath}.new && ` +
      `chmod +x ${this.remotePath}.new && ` +
      `mv ${this.remotePath}.new ${this.remotePath}`;
    if (this.agentUser) {
      uploadCmd += ` && chown ${this.agentUser}:${this.agentUser} ${this.remotePath}`;
    }
    const upload = await spawnAsync('ssh', [
      ...base,
      this.host,
      uploadCmd,
    ], { input: binaryBytes });
    if (upload.status !== 0) {
      throw new Error(`ace-coder-daemon upload failed: ${upload.stderr?.toString() || ''}`);
    }
  }

  _onStdout(chunk: any) {
    this.bufferHead = Buffer.concat([this.bufferHead, chunk]);
    while (true) {
      const headerEnd = this.bufferHead.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.bufferHead.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.bufferHead = Buffer.alloc(0);
        return;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.bufferHead.length - bodyStart < len) return;
      const body = this.bufferHead.slice(bodyStart, bodyStart + len);
      this.bufferHead = this.bufferHead.slice(bodyStart + len);
      this._handleMessage(body);
    }
  }

  _handleMessage(body: any) {
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch (err) {
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'pty.data') {
      this.emit('pty.data', msg.params);
    } else if (msg.method === 'pty.exit') {
      this.emit('pty.exit', msg.params);
    }
  }

  _request(method: any, params: any, { timeoutMs = RPC_TIMEOUT_MS }: any = {}): Promise<any> {
    return new Promise((resolve: any, reject: any) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error('daemon not running'));
        return;
      }
      const id = ++this.seq;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ace-coder-daemon ${method} timed out`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(header + body);
    });
  }

  _notify(method: any, params: any) {
    if (!this.proc || this.proc.killed) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.proc.stdin.write(header + body);
  }

  _onExit(code: any) {
    this.status = 'closed';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`daemon exited with code ${code}`));
    }
    this.pending.clear();
    this.emit('closed', { code, stderr: this.stderrBuf });
  }

  _onError(err: any) {
    this.emit('error', err);
  }


  async startPty({ cmd, args = [], cols, rows, cwd, env }: any) {
    await this.ensureReady();
    return this._request('pty.start', { cmd, args, cols, rows, cwd, env });
  }

  writePty(id: any, data: any) {
    const encoded = Buffer.from(data, 'utf8').toString('base64');
    this._notify('pty.write', { id, data: encoded });
  }

  resizePty(id: any, cols: any, rows: any) {
    this._notify('pty.resize', { id, cols, rows });
  }

  killPty(id: any) {
    this._notify('pty.kill', { id });
  }

  async exec({ cmd, args = [], cwd, env, stdin, loginShell, timeoutMs }: any) {
    await this.ensureReady();
    const payload: any = { cmd, args, cwd };
    if (env) payload.env = env;
    if (loginShell) payload.loginShell = true;
    if (stdin) {
      payload.stdin = Buffer.isBuffer(stdin)
        ? stdin.toString('base64')
        : Buffer.from(stdin).toString('base64');
    }
    const result = await this._request('exec.run', payload, { timeoutMs });
    return {
      code: result.code,
      stdout: Buffer.from(result.stdout || '', 'base64').toString('utf8'),
      stderr: Buffer.from(result.stderr || '', 'base64').toString('utf8'),
    };
  }

  async fsList(remotePath: any) {
    await this.ensureReady();
    return this._request('fs.list', { path: remotePath });
  }

  async fsRead(remotePath: any) {
    await this.ensureReady();
    const result = await this._request('fs.read', { path: remotePath });
    return Buffer.from(result.bytes || '', 'base64');
  }

  async fsWrite(remotePath: any, data: any) {
    await this.ensureReady();
    const bytes = Buffer.isBuffer(data)
      ? data.toString('base64')
      : Buffer.from(data, 'utf8').toString('base64');
    return this._request('fs.write', { path: remotePath, bytes });
  }

  async fsMkdir(remotePath: any, recursive: any = true) {
    await this.ensureReady();
    return this._request('fs.mkdir', { path: remotePath, recursive });
  }

  async fsRemove(remotePath: any, recursive: any = false) {
    await this.ensureReady();
    return this._request('fs.remove', { path: remotePath, recursive });
  }

  async fsRename(from: any, to: any) {
    await this.ensureReady();
    return this._request('fs.rename', { from, to });
  }

  async fsStat(remotePath: any) {
    await this.ensureReady();
    return this._request('fs.stat', { path: remotePath });
  }

  close() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.status = 'closed';
  }
}

function daemonKey(host: any, agentUser: any) {
  return `${host}::${agentUser || 'root'}`;
}

class SshDaemonManager {
  byKey: any;

  constructor() {
    this.byKey = new Map();
  }

  get(host: any, agentUser: any = null) {
    const key = daemonKey(host, agentUser);
    let d = this.byKey.get(key);
    if (!d) {
      d = new AceDaemon(host, agentUser);
      d.on('closed', () => {
        if (this.byKey.get(key) === d) {
          this.byKey.delete(key);
        }
      });
      this.byKey.set(key, d);
    }
    return d;
  }

  close(host: any, agentUser: any = null) {
    const key = daemonKey(host, agentUser);
    const d = this.byKey.get(key);
    if (d) {
      d.close();
      this.byKey.delete(key);
    }
  }

  closeAll() {
    for (const d of this.byKey.values()) d.close();
    this.byKey.clear();
  }






  warm(host: any, agentUser: any = null) {
    this.get(host, agentUser).ensureReady().catch(() => {});
  }
}

async function listSshHosts() {
  const file = path.join(os.homedir(), '.ssh', 'config');
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const aliases: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^host\s/i.test(trimmed)) continue;
    const rest = trimmed.slice(4).trim();
    for (const name of rest.split(/\s+/)) {
      if (name.includes('*') || name.includes('?') || name === '') continue;
      if (!aliases.includes(name)) aliases.push(name);
    }
  }
  const resolved = await Promise.all(
    aliases.map(async (alias: any) => {
      const g = await spawnAsync('ssh', ['-G', alias]);
      if (g.status !== 0) {
        return { alias, host: alias, user: null, port: null };
      }
      const fields: Record<string, any> = {};
      for (const row of g.stdout.split('\n')) {
        const [k, ...rest] = row.split(' ');
        if (k) fields[k.toLowerCase()] = rest.join(' ').trim();
      }
      return {
        alias,
        host: fields.hostname || alias,
        user: fields.user || null,
        port: fields.port ? Number(fields.port) : null,
      };
    })
  );
  return resolved;
}

module.exports = {
  SshDaemonManager,
  listSshHosts,
};
