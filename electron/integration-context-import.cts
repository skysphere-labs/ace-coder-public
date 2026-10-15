const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FCHDIR_GIT_RUNNER = '/usr/bin/python3';
const GIT_RUNNER_BOOTSTRAP_FAILURE = 'ACE_CONTEXT_IMPORT_GIT_RUNNER_BOOTSTRAP_FAILED';
// Bound Git config reads to 64 KiB so special or growing files fail closed.
const GIT_CONFIG_MAX_BYTES = 64 * 1024;
const GIT_CONTROL_FILE_MAX_BYTES = 4 * 1024;
// Bound the immutable worktree-index snapshot to 16 MiB.
const GIT_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const FCHDIR_GIT_SCRIPT = [
  'import os, sys',
  'try:',
  '    os.fchdir(3)',
  '    os.execvp(sys.argv[1], sys.argv[1:])',
  'except BaseException:',
  `    os.write(2, b'${GIT_RUNNER_BOOTSTRAP_FAILURE}\\n')`,
  '    os._exit(126)',
].join('\n');

class ContextImportError extends Error {
  code: string;
  applicationCode: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContextImportError';
    this.code = code;
    this.applicationCode = code;
  }
}

function fail(code: string, message: string): never {
  throw new ContextImportError(code, message);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_input', `${field} must be a non-empty control-free string`);
  }
  return value;
}

function fullSha(value: unknown, field: string): string {
  const sha = requiredText(value, field);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail('invalid_sha', `${field} must be a lowercase full commit SHA`);
  }
  return sha;
}

function literalAllowedPaths(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    fail('invalid_allowed_path', 'at least one allowed path is required');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string' || raw.length === 0) {
      fail('invalid_allowed_path', 'allowed paths must be non-empty strings');
    }
    if (
      /[\u0000-\u001f\u007f]/.test(raw) ||
      raw.includes('\\') ||
      /[*?\[\]{}!]/.test(raw) ||
      path.posix.isAbsolute(raw) ||
      path.win32.isAbsolute(raw)
    ) {
      fail('invalid_allowed_path', `invalid literal allowed path: ${raw}`);
    }
    const segments = raw.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      fail('invalid_allowed_path', `invalid literal allowed path: ${raw}`);
    }
    if (seen.has(raw)) {
      fail('invalid_allowed_path', `duplicate allowed path: ${raw}`);
    }
    seen.add(raw);
    result.push(raw);
  }
  return result.sort();
}

function stableIdentity(stats: any) {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function canonicalExistingDirectory(value: unknown, field: string, deps: any) {
  const inputPath = requiredText(value, field);
  if (!path.isAbsolute(inputPath)) {
    fail('path_not_canonical', `${field} must be absolute`);
  }
  let entry;
  let canonical;
  let identity;
  let fd: number | null = null;
  try {
    entry = deps.lstat(inputPath);
    canonical = deps.realpath(inputPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== inputPath) {
      fail('path_not_canonical', `${field} must be an existing canonical non-symlink directory`);
    }
    fd = deps.open(
      inputPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const descriptorIdentity = stableIdentity(deps.fstat(fd));
    const pathIdentity = stableIdentity(deps.stat(inputPath));
    if (descriptorIdentity.dev !== pathIdentity.dev || descriptorIdentity.ino !== pathIdentity.ino) {
      fail('identity_drift', `${field} changed while it was being pinned`);
    }
    identity = descriptorIdentity;
  } catch (error) {
    if (fd !== null) {
      try { deps.close(fd); } catch {}
    }
    if (error instanceof ContextImportError) throw error;
    fail('path_not_canonical', `${field} must be an existing canonical directory`);
  }
  return { path: inputPath, identity, fd };
}

function canonicalJson(payload: any): string {
  return JSON.stringify({
    schema: payload.schema,
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    repoPath: payload.repoPath,
    worktreePath: payload.worktreePath,
    branch: payload.branch,
    headSha: payload.headSha,
    baseBranch: payload.baseBranch,
    baseSha: payload.baseSha,
    allowedPaths: payload.allowedPaths,
    repoIdentity: payload.repoIdentity,
    worktreeIdentity: payload.worktreeIdentity,
  });
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Buffer(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeGithubRemote(remote: unknown): string | null {
  if (typeof remote !== 'string') return null;
  const value = remote.trim();
  const match = value.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i)
    || value.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i)
    || value.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!owner || !repo || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`.toLowerCase();
}

function normalizeGithubRepoId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    const [owner, rawRepo] = trimmed.split('/');
    const repo = rawRepo.replace(/\.git$/i, '');
    return owner && repo ? `${owner}/${repo}`.toLowerCase() : null;
  }
  return normalizeGithubRemote(trimmed);
}

function parseWorktreePorcelainZ(output: Buffer) {
  const records: Array<{ path: string; head: string; branch: string | null }> = [];
  let current: { path: string; head: string; branch: string | null } | null = null;
  for (const field of output.toString('utf8').split('\0')) {
    if (field === '') {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: field.slice('worktree '.length), head: '', branch: null };
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    }
  }
  if (current) records.push(current);
  return records;
}

function nulStrings(output: Buffer): string[] {
  return output.toString('utf8').split('\0').filter((value) => value.length > 0);
}

function safeGitEnvironment(source: any) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!key.startsWith('GIT_') && typeof value === 'string') env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

function gitConfigEntries(output: Buffer) {
  return output.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\n');
    if (separator <= 0) fail('remote_mismatch', 'Git config is malformed');
    return { key: record.slice(0, separator), value: record.slice(separator + 1) };
  });
}

function createIntegrationContextImporter(deps: any) {
  const resolved = {
    ...deps,
    realpath: deps.realpath || fs.realpathSync.native,
    lstat: deps.lstat || fs.lstatSync,
    stat: deps.stat || fs.statSync,
    open: deps.open || fs.openSync,
    fstat: deps.fstat || fs.fstatSync,
    close: deps.close || fs.closeSync,
    read: deps.read || fs.readSync,
    write: deps.write || fs.writeSync,
    fsync: deps.fsync || fs.fsyncSync,
    unlink: deps.unlink || fs.unlinkSync,
    tmpdir: deps.tmpdir || os.tmpdir,
    gitRunnerPath: deps.gitRunnerPath || FCHDIR_GIT_RUNNER,
    gitRunnerAvailable: deps.gitRunnerAvailable || ((runnerPath: string) => {
      if (process.platform !== 'darwin') return false;
      try {
        fs.accessSync(runnerPath, fs.constants.X_OK);
        return fs.statSync('/.vol').isDirectory();
      } catch {
        return false;
      }
    }),
  };

  resolved.execGitRunner = deps.execGitRunner || ((runnerPath: string, args: string[], options: any) => (
    childProcess.execFileSync(
      runnerPath,
      ['-I', '-c', FCHDIR_GIT_SCRIPT, 'git', ...args],
      options,
    )
  ));

  resolved.execGit = deps.execGit || ((target: any, args: string[], options: any) => {
    if (!resolved.gitRunnerAvailable(resolved.gitRunnerPath)) {
      fail('path_pin_unsupported', 'descriptor-relative Git execution is unavailable');
    }
    try {
      return resolved.execGitRunner(resolved.gitRunnerPath, args, {
        env: options.env,
        encoding: 'buffer',
        input: options.input,
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          'pipe',
          'pipe',
          target.fd,
          ...(options.extraTargets || []).map((entry: any) => entry.fd),
        ],
      });
    } catch (error: any) {
      if (error instanceof ContextImportError) throw error;
      const stderr = Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString('utf8')
        : String(error?.stderr || '');
      if (error?.status === 126 && stderr.includes(GIT_RUNNER_BOOTSTRAP_FAILURE)) {
        fail('git_execution_failed', 'descriptor-relative Git runner failed before exec');
      }
      if (Number.isInteger(error?.status)) throw error;
      fail('git_execution_failed', 'descriptor-relative Git execution failed');
    }
  });

  function descriptorCapability(target: any): string {
    if (process.platform !== 'darwin') {
      fail('path_pin_unsupported', 'descriptor capability paths require macOS');
    }
    const candidate = `/.vol/${target.identity.dev}/${target.identity.ino}`;
    try {
      const identity = stableIdentity(fs.statSync(candidate));
      if (identity.dev !== target.identity.dev || identity.ino !== target.identity.ino) {
        fail('identity_drift', 'descriptor capability identity changed');
      }
      return candidate;
    } catch (error) {
      if (error instanceof ContextImportError) throw error;
      fail('path_pin_unsupported', 'descriptor capability path is unavailable');
    }
  }

  function git(
    target: any,
    args: string[],
    code: string,
    binding: any = null,
    invocation: any = {},
  ): Buffer {
    try {
      const attestIndex = () => {
        if (!binding?.indexSource || !binding?.indexSnapshot) return;
        requireSameIdentity(binding.indexSource);
        requireSameIdentity(binding.indexSnapshot);
      };
      attestIndex();
      const fullArgs = [
        '--no-optional-locks',
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
      ];
      const env = safeGitEnvironment(process.env);
      const extraTargets: any[] = [];
      if (binding) {
        env.GIT_INDEX_FILE = '/dev/fd/4';
        extraTargets.push(binding.indexSnapshot);
        if (target === binding.common) {
          fullArgs.push('--git-dir=.');
        } else if (target === binding.worktree) {
          fullArgs.push(
            `--git-dir=${descriptorCapability(binding.common)}`,
            '--work-tree=.',
          );
          extraTargets.push(binding.common, binding.gitDir);
        } else {
          fail('path_pin_unsupported', 'Git proof target is not pinned');
        }
      }
      fullArgs.push(...args);
      let output: Buffer | null = null;
      let executionError: any = null;
      try {
        output = resolved.execGit(target, fullArgs, {
          descriptorRelative: true,
          env,
          extraTargets,
          input: invocation.input,
        });
      } catch (error) {
        executionError = error;
      }
      attestIndex();
      if (executionError) throw executionError;
      return output!;
    } catch (error) {
      if (error instanceof ContextImportError) throw error;
      fail(code, `Git verification failed: ${args[0]}`);
    }
  }

  function requireSameIdentity(target: any) {
    if (target.kind === 'detached_file') {
      try {
        const stats = resolved.fstat(target.fd);
        if (!stats.isFile()
          || stats.nlink !== 0
          || String(stats.mode) !== String(target.snapshot.mode)
          || String(stats.size) !== String(target.snapshot.size)
          || String(stats.mtimeMs) !== String(target.snapshot.mtimeMs)
          || String(stats.ctimeMs) !== String(target.snapshot.ctimeMs)
          || stableIdentity(stats).dev !== target.identity.dev
          || stableIdentity(stats).ino !== target.identity.ino) {
          fail('identity_drift', 'detached index snapshot identity changed');
        }
        return;
      } catch (error) {
        if (error instanceof ContextImportError) throw error;
        fail('identity_drift', 'detached index snapshot identity changed');
      }
    }
    if (target.parent) {
      let pathFd: number | null = null;
      try {
        const descriptorStats = resolved.fstat(target.fd);
        const flags = fs.constants.O_RDONLY
          | fs.constants.O_NONBLOCK
          | fs.constants.O_NOFOLLOW
          | (target.kind === 'directory' ? fs.constants.O_DIRECTORY : 0);
        pathFd = resolved.open(`${descriptorCapability(target.parent)}/${target.basename}`, flags);
        const pathStats = resolved.fstat(pathFd);
        const correctType = target.kind === 'directory'
          ? descriptorStats.isDirectory() && pathStats.isDirectory()
          : descriptorStats.isFile() && pathStats.isFile()
            && descriptorStats.nlink === 1 && pathStats.nlink === 1
            && String(descriptorStats.size) === String(target.snapshot.size)
            && String(descriptorStats.mtimeMs) === String(target.snapshot.mtimeMs)
            && String(descriptorStats.ctimeMs) === String(target.snapshot.ctimeMs);
        if (!correctType
          || String(descriptorStats.mode) !== String(target.snapshot.mode)
          || stableIdentity(descriptorStats).dev !== target.identity.dev
          || stableIdentity(descriptorStats).ino !== target.identity.ino
          || stableIdentity(pathStats).dev !== target.identity.dev
          || stableIdentity(pathStats).ino !== target.identity.ino) {
          fail('identity_drift', 'filesystem identity changed during verification');
        }
        if (target.contentAttestation) {
          const current = boundedRegularFile(
            target.fd,
            'identity_drift',
            target.contentAttestation.label,
            target.contentAttestation.maxBytes,
            true,
          ).content;
          if (current.length !== target.contentAttestation.content.length
            || sha256Buffer(current) !== target.contentAttestation.digest
            || !current.equals(target.contentAttestation.content)) {
            fail('identity_drift', `${target.contentAttestation.label} content changed`);
          }
        }
        return;
      } catch (error) {
        if (error instanceof ContextImportError) throw error;
        fail('identity_drift', 'filesystem identity changed during verification');
      } finally {
        if (pathFd !== null) {
          try { resolved.close(pathFd); } catch {}
        }
      }
    }
    try {
      const entry = resolved.lstat(target.path);
      const canonical = resolved.realpath(target.path);
      const pathIdentity = stableIdentity(resolved.stat(target.path));
      const descriptorIdentity = stableIdentity(resolved.fstat(target.fd));
      if (!entry.isDirectory()
        || entry.isSymbolicLink()
        || canonical !== target.path
        || pathIdentity.dev !== target.identity.dev
        || pathIdentity.ino !== target.identity.ino
        || descriptorIdentity.dev !== target.identity.dev
        || descriptorIdentity.ino !== target.identity.ino) {
        fail('identity_drift', 'filesystem identity changed during verification');
      }
    } catch (error) {
      if (error instanceof ContextImportError) throw error;
      fail('identity_drift', 'filesystem identity changed during verification');
    }
  }

  function releasePins(verified: any) {
    const pins = verified?.pins;
    if (!pins || pins.released) return;
    pins.released = true;
    for (const target of [...pins.targets].reverse()) {
      try { resolved.close(target.fd); } catch {}
    }
  }

  function requireAllPinIdentities(verified: any) {
    for (const target of verified.pins.targets) requireSameIdentity(target);
  }

  function boundedRegularFile(
    fd: number,
    code: string,
    label: string,
    maxBytes: number,
    singleLink = false,
  ): { content: Buffer; stats: any } {
    const before = resolved.fstat(fd);
    if (!before.isFile() || (singleLink && before.nlink !== 1)) {
      fail(code, `${label} is not a single-link regular file`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      fail(code, `${label} exceeds the ${maxBytes}-byte attestation limit`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maxBytes + 1 - total));
      const bytesRead = resolved.read(fd, chunk, 0, chunk.length, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.length) {
        fail(code, `${label} returned an invalid read length`);
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail(code, `${label} grew beyond its attestation limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = resolved.fstat(fd);
    if (!after.isFile()
      || (singleLink && after.nlink !== 1)
      || String(before.dev) !== String(after.dev)
      || String(before.ino) !== String(after.ino)
      || String(before.mode) !== String(after.mode)
      || String(before.size) !== String(after.size)
      || String(before.mtimeMs) !== String(after.mtimeMs)
      || String(before.ctimeMs) !== String(after.ctimeMs)
      || total !== before.size) {
      fail('identity_drift', `${label} changed during attestation`);
    }
    return { content: Buffer.concat(chunks, total), stats: after };
  }

  function validateStandaloneIndex(content: Buffer) {
    if (content.length < 12 || content.subarray(0, 4).toString('ascii') !== 'DIRC') {
      fail('unsupported_index', 'worktree index header is invalid');
    }
    const version = content.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      fail('unsupported_index', 'worktree index version is unsupported');
    }
    const checksumLength = [32, 20].find((length) => {
      if (content.length < 12 + length) return false;
      const algorithm = length === 32 ? 'sha256' : 'sha1';
      const expected = crypto.createHash(algorithm).update(content.subarray(0, -length)).digest();
      return crypto.timingSafeEqual(expected, content.subarray(-length));
    });
    if (!checksumLength) fail('unsupported_index', 'worktree index checksum is invalid');
    const entriesEnd = content.length - checksumLength;
    const entryCount = content.readUInt32BE(8);
    let offset = 12;
    for (let entry = 0; entry < entryCount; entry += 1) {
      const flagsOffset = offset + 40 + checksumLength;
      if (flagsOffset + 2 > entriesEnd) fail('unsupported_index', 'worktree index entry is truncated');
      const mode = content.readUInt32BE(offset + 24);
      if ((mode & 0o170000) === 0o040000) {
        fail('unsupported_index', 'sparse indexes are unsupported');
      }
      const flags = content.readUInt16BE(flagsOffset);
      let nameOffset = flagsOffset + 2;
      if ((flags & 0x4000) !== 0) {
        if (version < 3 || nameOffset + 2 > entriesEnd) {
          fail('unsupported_index', 'worktree index extended flags are invalid');
        }
        nameOffset += 2;
      }
      const nameLength = flags & 0x0fff;
      const terminator = nameLength < 0x0fff
        ? nameOffset + nameLength
        : content.indexOf(0, nameOffset);
      if (terminator < nameOffset || terminator >= entriesEnd || content[terminator] !== 0) {
        fail('unsupported_index', 'worktree index path is malformed');
      }
      const entryLength = terminator + 1 - offset;
      offset += Math.ceil(entryLength / 8) * 8;
      if (offset > entriesEnd) fail('unsupported_index', 'worktree index entry exceeds its bound');
    }
    while (offset < entriesEnd) {
      if (offset + 8 > entriesEnd) fail('unsupported_index', 'worktree index extension is truncated');
      const signature = content.subarray(offset, offset + 4).toString('ascii');
      const size = content.readUInt32BE(offset + 4);
      offset += 8;
      if (size > entriesEnd - offset) fail('unsupported_index', 'worktree index extension exceeds its bound');
      if (signature === 'FSMN') {
        fail('unsupported_index', 'filesystem-monitor indexes are unsupported');
      }
      if (signature === 'link' || signature === 'sdir') {
        fail('unsupported_index', 'sparse and split indexes are unsupported');
      }
      offset += size;
    }
  }

  function pinnedRegularFile(
    target: any,
    relativePath: string,
    code: string,
    label: string,
    maxBytes: number,
    allowMissing = false,
  ): Buffer | null {
    const filePath = `${descriptorCapability(target)}/${relativePath}`;
    let fd: number | null = null;
    try {
      fd = resolved.open(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
      );
      return boundedRegularFile(fd, code, label, maxBytes).content;
    } catch (error: any) {
      if (error instanceof ContextImportError) throw error;
      if (allowMissing && error?.code === 'ENOENT') return null;
      fail(code, `${label} cannot be attested`);
    } finally {
      if (fd !== null) {
        try { resolved.close(fd); } catch {}
      }
    }
  }

  function privateIndexSnapshot(content: Buffer, pins: any) {
    let tempRoot: any = null;
    let basename: string | null = null;
    let writeFd: number | null = null;
    let snapshot: any = null;
    let createdIdentity: any = null;
    try {
      const canonicalTempRoot = resolved.realpath(resolved.tmpdir());
      tempRoot = canonicalExistingDirectory(canonicalTempRoot, 'indexSnapshotTempRoot', resolved);
      basename = `ace-context-import-index-${crypto.randomBytes(16).toString('hex')}`;
      const snapshotPath = `${descriptorCapability(tempRoot)}/${basename}`;
      writeFd = resolved.open(
        snapshotPath,
        fs.constants.O_RDWR
          | fs.constants.O_NONBLOCK
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const createdStats = resolved.fstat(writeFd);
      createdIdentity = stableIdentity(createdStats);
      if (!createdStats.isFile() || createdStats.nlink !== 1 || createdStats.size !== 0) {
        fail('path_pin_unsupported', 'private index snapshot is invalid');
      }
      let written = 0;
      while (written < content.length) {
        const count = resolved.write(writeFd, content, written, content.length - written, written);
        if (!Number.isSafeInteger(count) || count <= 0) {
          fail('path_pin_unsupported', 'private index snapshot write failed');
        }
        written += count;
      }
      resolved.fsync(writeFd);
      const linkedStats = resolved.fstat(writeFd);
      const linkedIdentity = stableIdentity(linkedStats);
      if (!linkedStats.isFile()
        || linkedStats.nlink !== 1
        || linkedStats.size !== content.length
        || linkedIdentity.dev !== createdIdentity.dev
        || linkedIdentity.ino !== createdIdentity.ino) {
        fail('path_pin_unsupported', 'private index snapshot is invalid');
      }
      snapshot = pinLeaf(
        tempRoot,
        basename,
        path.join(tempRoot.path, basename),
        'path_pin_unsupported',
        'private index snapshot',
      );
      const readOnlyStats = resolved.fstat(snapshot.fd);
      if (stableIdentity(readOnlyStats).dev !== stableIdentity(linkedStats).dev
        || stableIdentity(readOnlyStats).ino !== stableIdentity(linkedStats).ino) {
        fail('identity_drift', 'private index snapshot identity changed');
      }
      snapshot.contentAttestation = {
        label: 'private index snapshot',
        maxBytes: GIT_INDEX_MAX_BYTES,
        digest: sha256Buffer(content),
        content,
      };
      requireSameIdentity(snapshot);
      resolved.close(writeFd);
      writeFd = null;
      resolved.beforeIndexSnapshotCleanup?.({
        tempRootPath: tempRoot.path,
        basename,
      });
      requireSameIdentity(tempRoot);
      requireSameIdentity(snapshot);
      resolved.unlink(descriptorCapability(snapshot));
      const detached = boundedRegularFile(
        snapshot.fd,
        'identity_drift',
        'private index snapshot',
        GIT_INDEX_MAX_BYTES,
      );
      if (detached.stats.nlink !== 0
        || sha256Buffer(detached.content) !== snapshot.contentAttestation.digest
        || !detached.content.equals(content)) {
        fail('identity_drift', 'private index snapshot content changed');
      }
      resolved.close(tempRoot.fd);
      tempRoot = null;
      snapshot.kind = 'detached_file';
      snapshot.identity = stableIdentity(detached.stats);
      snapshot.snapshot = detached.stats;
      pins.targets.push(snapshot);
      const retained = snapshot;
      snapshot = null;
      return retained;
    } catch (error) {
      let cleanupDrift = false;
      let cleanupFd: number | null = null;
      if (tempRoot && basename && writeFd !== null && !createdIdentity) {
        try {
          const ownedStats = resolved.fstat(writeFd);
          if (!ownedStats.isFile() || ownedStats.nlink !== 1) {
            cleanupDrift = true;
          } else {
            createdIdentity = stableIdentity(ownedStats);
          }
        } catch {
          cleanupDrift = true;
        }
      }
      if (tempRoot && basename && createdIdentity) {
        try {
          requireSameIdentity(tempRoot);
          cleanupFd = resolved.open(
            `${descriptorCapability(tempRoot)}/${basename}`,
            fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
          );
          const cleanupStats = resolved.fstat(cleanupFd);
          if (!cleanupStats.isFile()
            || cleanupStats.nlink !== 1
            || stableIdentity(cleanupStats).dev !== createdIdentity.dev
            || stableIdentity(cleanupStats).ino !== createdIdentity.ino) {
            cleanupDrift = true;
          } else {
            resolved.unlink(descriptorCapability({ identity: createdIdentity }));
          }
        } catch (cleanupError: any) {
          if (cleanupError instanceof ContextImportError || cleanupError?.code !== 'ENOENT') {
            cleanupDrift = true;
          }
        } finally {
          if (cleanupFd !== null) {
            try { resolved.close(cleanupFd); } catch {}
          }
        }
      }
      if (writeFd !== null) {
        try { resolved.close(writeFd); } catch {}
      }
      if (snapshot) {
        try { resolved.close(snapshot.fd); } catch {}
      }
      if (tempRoot) {
        try { resolved.close(tempRoot.fd); } catch {}
      }
      if (cleanupDrift) fail('identity_drift', 'private index snapshot cleanup identity changed');
      if (error instanceof ContextImportError) throw error;
      fail('path_pin_unsupported', 'private index snapshot cannot be created');
    }
  }

  function pinLeaf(
    parent: any,
    basename: string,
    expectedPath: string,
    code: string,
    label: string,
    directoryOnly = false,
  ) {
    let fd: number | null = null;
    try {
      const candidate = `${descriptorCapability(parent)}/${basename}`;
      fd = resolved.open(
        candidate,
        fs.constants.O_RDONLY
          | fs.constants.O_NONBLOCK
          | fs.constants.O_NOFOLLOW
          | (directoryOnly ? fs.constants.O_DIRECTORY : 0),
      );
      const stats = resolved.fstat(fd);
      if ((!stats.isDirectory() && !stats.isFile()) || (directoryOnly && !stats.isDirectory())) {
        fail(code, `${label} is not a supported filesystem entry`);
      }
      const entry = resolved.lstat(candidate);
      const pathIdentity = stableIdentity(resolved.stat(candidate));
      const identity = stableIdentity(stats);
      if (entry.isSymbolicLink()
        || pathIdentity.dev !== identity.dev
        || pathIdentity.ino !== identity.ino) {
        fail(code, `${label} is not canonical`);
      }
      const target: any = {
        path: expectedPath,
        identity,
        fd,
        parent,
        basename,
        kind: stats.isDirectory() ? 'directory' : 'file',
        snapshot: stats,
      };
      fd = null;
      return target;
    } catch (error) {
      if (error instanceof ContextImportError) throw error;
      fail(code, `${label} cannot be pinned`);
    } finally {
      if (fd !== null) {
        try { resolved.close(fd); } catch {}
      }
    }
  }

  function pinAbsoluteGitDirectory(candidate: string, code: string, label: string, pins: any) {
    if (!path.isAbsolute(candidate) || path.basename(candidate) === path.sep) {
      fail(code, `${label} path is invalid`);
    }
    try {
      const parent = canonicalExistingDirectory(path.dirname(candidate), `${label}Parent`, resolved);
      pins.targets.push(parent);
      const target = pinLeaf(parent, path.basename(candidate), candidate, code, label, true);
      pins.targets.push(target);
      return target;
    } catch (error) {
      if (error instanceof ContextImportError && error.code !== 'path_not_canonical') throw error;
      fail(code, `${label} cannot be pinned`);
    }
  }

  function pinCheckoutAdmin(checkout: any, code: string, label: string, pins: any) {
    const gitPath = path.join(checkout.path, '.git');
    const gitLeaf = pinLeaf(checkout, '.git', gitPath, code, `${label} .git`);
    pins.targets.push(gitLeaf);
    if (gitLeaf.kind === 'directory') {
      return { gitLeaf, gitDir: gitLeaf, common: gitLeaf };
    }
    const gitFile = boundedRegularFile(
      gitLeaf.fd,
      code,
      `${label} .git pointer`,
      GIT_CONTROL_FILE_MAX_BYTES,
      true,
    );
    gitLeaf.snapshot = gitFile.stats;
    const match = gitFile.content.toString('utf8')
      .match(/^gitdir: ([^\u0000-\u001f\u007f]+)\r?\n?$/);
    if (!match || !path.isAbsolute(match[1])) {
      fail(code, `${label} .git pointer is malformed`);
    }
    const gitDir = pinAbsoluteGitDirectory(match[1], code, `${label} Git directory`, pins);
    const commonFile = pinnedRegularFile(
      gitDir,
      'commondir',
      code,
      `${label} common-dir pointer`,
      GIT_CONTROL_FILE_MAX_BYTES,
    );
    const commonValue = commonFile!.toString('utf8').trim();
    if (!commonValue || /[\u0000-\u001f\u007f]/.test(commonValue)) {
      fail(code, `${label} common-dir pointer is malformed`);
    }
    const commonPath = path.isAbsolute(commonValue)
      ? commonValue
      : path.resolve(gitDir.path, commonValue);
    const common = pinAbsoluteGitDirectory(commonPath, code, `${label} common directory`, pins);
    return { gitLeaf, gitDir, common };
  }

  function linkedBranch(gitDir: any): string {
    try {
      const head = pinnedRegularFile(
        gitDir,
        'HEAD',
        'branch_mismatch',
        'linked worktree HEAD',
        GIT_CONTROL_FILE_MAX_BYTES,
      )!.toString('utf8').trim();
      const prefix = 'ref: refs/heads/';
      if (!head.startsWith(prefix)) fail('branch_mismatch', 'worktree HEAD is detached');
      return head.slice(prefix.length);
    } catch (error) {
      if (error instanceof ContextImportError) throw error;
      fail('branch_mismatch', 'linked worktree HEAD cannot be read');
    }
  }

  function pinnedWorktreeConfig(gitDir: any): Buffer | null {
    return pinnedRegularFile(
      gitDir,
      'config.worktree',
      'remote_mismatch',
      'linked worktree config',
      GIT_CONFIG_MAX_BYTES,
      true,
    );
  }

  function pinnedConfigEntries(binding: any, content: Buffer, label: string) {
    const parsed = git(
      binding.common,
      ['config', '--file', '-', '--no-includes', '--null', '--list'],
      'remote_mismatch',
      binding,
      { input: content },
    );
    const entries = gitConfigEntries(parsed);
    for (const { key } of entries) {
      const normalized = key.toLowerCase();
      if (normalized === 'include.path' || normalized.startsWith('includeif.')) {
        fail('remote_mismatch', `${label} includes are unsupported`);
      }
    }
    return entries;
  }

  function worktreeRemoteConfigEntries(binding: any, commonConfig: Buffer): any[] {
    const enabled = git(
      binding.common,
      ['config', '--file', '-', '--no-includes', '--type=bool', '--get', '--default=false',
        'extensions.worktreeConfig'],
      'remote_mismatch',
      binding,
      { input: commonConfig },
    ).toString('utf8').trim();
    if (enabled !== 'true' && enabled !== 'false') {
      fail('remote_mismatch', 'extensions.worktreeConfig is ambiguous');
    }
    if (enabled === 'false') return [];
    const content = pinnedWorktreeConfig(binding.gitDir);
    if (content === null) return [];
    return pinnedConfigEntries(binding, content, 'linked worktree config');
  }

  function rewriteRemoteUrl(url: string, entries: any[], push: boolean) {
    const suffix = push ? '.pushinsteadof' : '.insteadof';
    const matches = entries.flatMap(({ key, value }) => {
      const normalized = key.toLowerCase();
      if (!normalized.startsWith('url.') || !normalized.endsWith(suffix)) return [];
      const base = key.slice('url.'.length, key.length - suffix.length);
      return url.startsWith(value) ? [{ base, prefix: value }] : [];
    });
    if (matches.length === 0) return { matched: false, url };
    const longest = Math.max(...matches.map((match) => match.prefix.length));
    const selected = matches.filter((match) => match.prefix.length === longest);
    const rewritten = new Set(selected.map((match) => `${match.base}${url.slice(longest)}`));
    if (rewritten.size !== 1) fail('remote_mismatch', 'remote URL rewrite is ambiguous');
    return { matched: true, url: [...rewritten][0] };
  }

  function effectiveRemoteUrls(entries: any[], push: boolean): string[] {
    const values = (variable: string) => entries
      .filter((entry) => {
        const firstSeparator = entry.key.indexOf('.');
        const lastSeparator = entry.key.lastIndexOf('.');
        return firstSeparator > 0
          && lastSeparator > firstSeparator
          && entry.key.slice(0, firstSeparator).toLowerCase() === 'remote'
          && entry.key.slice(firstSeparator + 1, lastSeparator) === 'origin'
          && entry.key.slice(lastSeparator + 1).toLowerCase() === variable;
      })
      .map((entry) => entry.value);
    const fetchUrls = values('url');
    const pushUrls = values('pushurl');
    if (!push) return fetchUrls.map((url) => rewriteRemoteUrl(url, entries, false).url);
    if (pushUrls.length > 0) {
      return pushUrls.map((url) => rewriteRemoteUrl(url, entries, false).url);
    }
    return fetchUrls.map((url) => {
      const pushRewritten = rewriteRemoteUrl(url, entries, true);
      return pushRewritten.matched
        ? pushRewritten.url
        : rewriteRemoteUrl(url, entries, false).url;
    });
  }

  function hasUnsupportedIndexConfig(entries: any[]): boolean {
    const unsupported = new Set([
      'core.sparsecheckout',
      'core.sparsecheckoutcone',
      'core.splitindex',
      'core.fsmonitor',
      'index.sparse',
    ]);
    const explicitFalse = new Set(['false', 'no', 'off', '0']);
    return entries.some(({ key, value }) => unsupported.has(key.toLowerCase())
      && !explicitFalse.has(String(value).trim().toLowerCase()));
  }

  function verifyCanonicalInput(input: any) {
    if (!input || typeof input !== 'object') fail('invalid_input', 'context import input is required');
    if (input.mode !== 'preview' && input.mode !== 'apply') {
      fail('invalid_input', 'mode must be preview or apply');
    }
    let repo: any = null;
    let worktree: any = null;
    try {
      repo = canonicalExistingDirectory(input.repoPath, 'repoPath', resolved);
      worktree = canonicalExistingDirectory(input.worktreePath, 'worktreePath', resolved);
      if (repo.path === worktree.path) {
        fail('invalid_input', 'repository and worktree paths must differ');
      }
      const payload = {
        schema: 'ace.integration-context-import.v1',
        requestId: requiredText(input.requestId, 'requestId'),
        workspaceId: requiredText(input.workspaceId, 'workspaceId'),
        repoPath: repo.path,
        worktreePath: worktree.path,
        branch: requiredText(input.branch, 'branch'),
        headSha: fullSha(input.headSha, 'headSha'),
        baseBranch: requiredText(input.baseBranch, 'baseBranch'),
        baseSha: fullSha(input.baseSha, 'baseSha'),
        allowedPaths: literalAllowedPaths(input.allowedPaths),
        repoIdentity: repo.identity,
        worktreeIdentity: worktree.identity,
      };
      const serialized = canonicalJson(payload);
      const verified = {
        payload,
        canonicalJson: serialized,
        digest: sha256(serialized),
        evidence: {},
      };
      Object.defineProperty(verified, 'pins', {
        value: {
          repo,
          worktree,
          targets: [repo, worktree],
          binding: null,
          released: false,
        },
        enumerable: false,
      });
      return verified;
    } catch (error) {
      for (const target of [repo, worktree]) {
        if (target) {
          try { resolved.close(target.fd); } catch {}
        }
      }
      throw error;
    }
  }

  function verifyIntegrationContext(input: any) {
    const verified = verifyCanonicalInput(input);
    const { payload } = verified;
    const { repo, worktree } = verified.pins;
    try {
      const project = resolved.db.prepare(
        'SELECT id, path, is_remote, github_repo, default_branch FROM projects WHERE id = ?',
      ).get(payload.workspaceId);
      if (!project) fail('workspace_not_found', 'workspace does not exist');
      if (Number(project.is_remote) !== 0) fail('workspace_not_local', 'workspace must be local');
      if (project.path !== payload.repoPath) {
        fail('repo_mapping_mismatch', 'workspace repository path does not match');
      }

      const repoAdmin = pinCheckoutAdmin(
        repo,
        'repo_mapping_mismatch',
        'repository',
        verified.pins,
      );
      const worktreeAdmin = pinCheckoutAdmin(
        worktree,
        'worktree_repo_mismatch',
        'linked worktree',
        verified.pins,
      );
      resolved.beforeGitDirectoryDiscovery?.();
      requireAllPinIdentities(verified);
      if (repoAdmin.common.identity.dev !== worktreeAdmin.common.identity.dev
        || repoAdmin.common.identity.ino !== worktreeAdmin.common.identity.ino) {
        fail('worktree_repo_mismatch', 'worktree belongs to a different repository');
      }
      const repoCommonDir = repoAdmin.common.path;
      const worktreeCommonDir = worktreeAdmin.common.path;
      const commonPin = repoAdmin.common;
      const gitDirPin = worktreeAdmin.gitDir;
      const indexSource = pinLeaf(
        gitDirPin,
        'index',
        path.join(gitDirPin.path, 'index'),
        'unsupported_index',
        'worktree index',
      );
      verified.pins.targets.push(indexSource);
      const indexAttestation = boundedRegularFile(
        indexSource.fd,
        'unsupported_index',
        'worktree index',
        GIT_INDEX_MAX_BYTES,
        true,
      );
      indexSource.snapshot = indexAttestation.stats;
      indexSource.contentAttestation = {
        label: 'worktree index',
        maxBytes: GIT_INDEX_MAX_BYTES,
        digest: sha256Buffer(indexAttestation.content),
        content: Buffer.from(indexAttestation.content),
      };
      validateStandaloneIndex(indexAttestation.content);
      requireSameIdentity(indexSource);
      const indexSnapshot = privateIndexSnapshot(indexAttestation.content, verified.pins);
      requireSameIdentity(indexSource);
      const binding = {
        common: commonPin,
        worktree,
        gitDir: gitDirPin,
        indexSource,
        indexSnapshot,
      };
      verified.pins.binding = binding;
      const prove = (args: string[], code: string) => git(commonPin, args, code, binding);
      const proveWorktree = (args: string[], code: string) => git(worktree, args, code, binding);
      const commonConfig = pinnedRegularFile(
        commonPin,
        'config',
        'remote_mismatch',
        'common Git config',
        GIT_CONFIG_MAX_BYTES,
      );
      const commonConfigEntries = pinnedConfigEntries(binding, commonConfig!, 'common Git config');

      for (const branch of [payload.branch, payload.baseBranch]) {
        const checked = prove(['check-ref-format', '--branch', branch], 'invalid_branch')
          .toString('utf8')
          .trim();
        if (checked !== branch) fail('invalid_branch', 'branch names must be literal');
      }

      const remoteConfigEntries = [
        ...commonConfigEntries,
        ...worktreeRemoteConfigEntries(binding, commonConfig!),
      ];
      if (hasUnsupportedIndexConfig(remoteConfigEntries)) {
        fail('unsupported_index', 'sparse, split, and fsmonitor indexes are unsupported');
      }
      const fetchUrls = effectiveRemoteUrls(remoteConfigEntries, false);
      const pushUrls = effectiveRemoteUrls(remoteConfigEntries, true);
      const pushUrl = pushUrls.length === 1 && pushUrls[0] === pushUrls[0].trim()
        ? pushUrls[0]
        : null;
      const originRepo = fetchUrls.length === 1 ? normalizeGithubRemote(fetchUrls[0]) : null;
      const pushRepo = pushUrl ? normalizeGithubRemote(pushUrl) : null;
      const expectedRepo = normalizeGithubRepoId(project.github_repo);
      if (!originRepo
        || !pushRepo
        || !expectedRepo
        || originRepo !== expectedRepo
        || pushRepo !== expectedRepo) {
        fail(
          'remote_mismatch',
          'origin fetch and push URLs must singularly match the workspace GitHub repository',
        );
      }

      const listed = parseWorktreePorcelainZ(
        prove(['worktree', 'list', '--porcelain', '-z'], 'worktree_not_listed'),
      ).filter((record) => record.path === payload.worktreePath
        && record.head === payload.headSha
        && record.branch === `refs/heads/${payload.branch}`);
      if (listed.length !== 1) {
        fail('worktree_not_listed', 'exact worktree registration was not found');
      }

      const actualBranch = linkedBranch(gitDirPin);
      if (actualBranch !== payload.branch) fail('branch_mismatch', 'worktree branch does not match');

      const actualHead = prove(
        ['rev-parse', '--verify', `refs/heads/${payload.branch}^{commit}`],
        'head_mismatch',
      ).toString('utf8').trim();
      if (actualHead !== payload.headSha) fail('head_mismatch', 'worktree HEAD does not match');

      const actualBase = prove(
        ['rev-parse', '--verify', `refs/remotes/origin/${payload.baseBranch}`],
        'base_mismatch',
      ).toString('utf8').trim();
      if (actualBase !== payload.baseSha) fail('base_mismatch', 'origin base does not match');
      const baseType = prove(['cat-file', '-t', payload.baseSha], 'base_mismatch')
        .toString('utf8').trim();
      if (baseType !== 'commit') fail('base_mismatch', 'base SHA must identify a commit object');

      prove(
        ['merge-base', '--is-ancestor', payload.baseSha, payload.headSha],
        'base_not_ancestor',
      );

      const sharedIndexPath = proveWorktree(
        ['rev-parse', '--shared-index-path'],
        'unsupported_index',
      ).toString('utf8').trim();
      if (sharedIndexPath) fail('unsupported_index', 'split indexes are unsupported');

      const indexStages = nulStrings(proveWorktree(
        ['ls-files', '--sparse', '--stage', '-z'],
        'unsupported_submodule',
      ));
      const treeEntries = [payload.baseSha, payload.headSha].flatMap((treeish) => nulStrings(prove(
        ['ls-tree', '-r', '-z', '--full-tree', treeish],
        'unsupported_submodule',
      )));
      if (indexStages.some((entry) => entry.startsWith('040000 '))) {
        fail('unsupported_index', 'sparse indexes are unsupported');
      }
      if (indexStages.some((entry) => entry.startsWith('160000 '))
        || treeEntries.some((entry) => entry.startsWith('160000 '))) {
        fail('unsupported_submodule', 'context import does not support Git submodules');
      }

      const changedPaths = nulStrings(prove(
        [
          '-c', 'diff.ignoreSubmodules=none',
          'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--name-only', '-z',
          `${payload.baseSha}..${payload.headSha}`,
        ],
        'scope_contamination',
      )).sort();
      const changed = new Set(changedPaths);
      const allowed = new Set(payload.allowedPaths);
      if (payload.allowedPaths.some((allowedPath: string) => !changed.has(allowedPath))) {
        fail('scope_missing', 'an allowed path is absent from the commit diff');
      }
      if (changedPaths.some((changedPath) => !allowed.has(changedPath))) {
        fail('scope_contamination', 'the commit diff contains an unexpected path');
      }

      const indexEntries = nulStrings(proveWorktree(
        ['ls-files', '--cached', '-v', '-z'],
        'dirty_worktree',
      ));
      if (indexEntries.some((entry) => entry[0] === 'S' || /^[a-z]$/.test(entry[0]))) {
        fail('dirty_worktree', 'index flags may not hide worktree changes');
      }

      proveWorktree(
        [
          '-c', 'diff.ignoreSubmodules=none',
          'diff-files', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
        ],
        'dirty_worktree',
      );
      proveWorktree(
        [
          '-c', 'diff.ignoreSubmodules=none',
          'diff-index', '--cached', '--quiet', '--no-ext-diff', '--no-textconv',
          '--ignore-submodules=none',
          payload.headSha, '--',
        ],
        'dirty_worktree',
      );
      const untracked = proveWorktree(
        ['ls-files', '--others', '--exclude-standard', '-z'],
        'dirty_worktree',
      );
      if (untracked.length !== 0) fail('dirty_worktree', 'worktree must be clean');

      requireAllPinIdentities(verified);
      verified.evidence = {
        originRepo,
        pushUrl,
        repoCommonDir,
        worktreeCommonDir,
        changedPaths,
      };
      return verified;
    } catch (error) {
      releasePins(verified);
      throw error;
    }
  }

  const transaction = resolved.db.transaction((verified: any) => {
    const { payload } = verified;
    const existingRequest = resolved.db.prepare(
      `SELECT audit_id, request_id, payload_digest, canonical_payload_json,
              push_url, task_id, worktree_id, created_at
         FROM integration_context_imports
        WHERE request_id = ?`,
    ).get(payload.requestId);
    if (existingRequest) {
      if (existingRequest.payload_digest !== verified.digest
        || existingRequest.canonical_payload_json !== verified.canonicalJson
        || existingRequest.push_url !== verified.evidence.pushUrl) {
        fail('request_conflict', 'request id is already bound to a different payload');
      }
      const mutableContext = resolved.db.prepare(
        `SELECT t.id AS task_id, t.project_id AS task_project_id, t.kind AS task_kind,
                w.id AS worktree_id, w.task_id AS worktree_task_id,
                w.project_id AS worktree_project_id, w.path, w.branch, w.base_branch,
                w.remote_base_ref, w.base_sha, w.local_base_sha
           FROM tasks t
           JOIN worktrees w ON w.task_id = t.id
          WHERE t.id = ? AND w.id = ?`,
      ).get(existingRequest.task_id, existingRequest.worktree_id);
      if (!mutableContext
        || mutableContext.task_project_id !== payload.workspaceId
        || mutableContext.task_kind !== 'task'
        || mutableContext.worktree_task_id !== existingRequest.task_id
        || mutableContext.worktree_project_id !== payload.workspaceId
        || mutableContext.path !== payload.worktreePath
        || mutableContext.branch !== payload.branch
        || mutableContext.base_branch !== payload.baseBranch
        || mutableContext.remote_base_ref !== `origin/${payload.baseBranch}`
        || mutableContext.base_sha !== payload.baseSha
        || mutableContext.local_base_sha !== payload.baseSha) {
        fail('replay_context_mismatch', 'replay context is missing or no longer matches its audit');
      }
      requireAllPinIdentities(verified);
      return {
        mode: 'apply',
        taskId: existingRequest.task_id,
        worktreeId: existingRequest.worktree_id,
        auditId: existingRequest.audit_id,
        digest: existingRequest.payload_digest,
        replayed: true,
        createdAt: existingRequest.created_at,
      };
    }

    const claimedWorktree = resolved.db.prepare(
      'SELECT id FROM worktrees WHERE path = ? LIMIT 1',
    ).get(payload.worktreePath);
    const claimedBranch = resolved.db.prepare(
      'SELECT id FROM worktrees WHERE project_id = ? AND branch = ? LIMIT 1',
    ).get(payload.workspaceId, payload.branch);
    const claimedAudit = resolved.db.prepare(
      `SELECT request_id FROM integration_context_imports
        WHERE payload_digest = ?
           OR worktree_path = ?
           OR (workspace_id = ? AND branch = ?)
        LIMIT 1`,
    ).get(verified.digest, payload.worktreePath, payload.workspaceId, payload.branch);
    if (claimedWorktree || claimedBranch || claimedAudit) {
      fail('registration_conflict', 'integration context is already registered');
    }

    const aheadRaw = git(
      verified.pins.binding.common,
      ['rev-list', '--count', `${payload.baseSha}..${payload.headSha}`],
      'head_mismatch',
      verified.pins.binding,
    ).toString('utf8').trim();
    const localAheadBy = Number(aheadRaw);
    if (!Number.isSafeInteger(localAheadBy) || localAheadBy < 0) {
      fail('head_mismatch', 'commit distance could not be verified');
    }
    requireAllPinIdentities(verified);

    const createdAt = resolved.now();
    const taskId = resolved.newId('tsk');
    const worktreeId = resolved.newId('wt');
    const auditId = resolved.newId('ctx');
    resolved.db.prepare(
      `INSERT INTO tasks
       (id, project_id, kind, name, primary_agent, is_multi_agent, initial_prompt,
        auto_approve, task_type, order_index, archived_at, created_at, updated_at)
       VALUES (?, ?, 'task', ?, 'codex', 0, NULL, 0, NULL,
               COALESCE((SELECT MAX(order_index) + 1 FROM tasks
                         WHERE project_id = ? AND archived_at IS NULL), 0),
               NULL, ?, ?)`,
    ).run(
      taskId,
      payload.workspaceId,
      `Imported ${payload.branch}`,
      payload.workspaceId,
      createdAt,
      createdAt,
    );
    resolved.db.prepare(
      `INSERT INTO worktrees
       (id, task_id, project_id, display_name, branch, base_branch, remote_base_ref,
        base_sha, local_base_sha, local_ahead_by, local_behind_by, branch_point, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      worktreeId,
      taskId,
      payload.workspaceId,
      payload.branch,
      payload.branch,
      payload.baseBranch,
      `origin/${payload.baseBranch}`,
      payload.baseSha,
      payload.baseSha,
      localAheadBy,
      `origin/${payload.baseBranch}`,
      payload.worktreePath,
      createdAt,
    );
    resolved.db.prepare(
      `INSERT INTO integration_context_imports
       (audit_id, request_id, payload_digest, canonical_payload_json, workspace_id,
        repo_path, worktree_path, branch, head_sha, base_branch, base_sha,
        push_url, allowed_paths_json, task_id, worktree_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      auditId,
      payload.requestId,
      verified.digest,
      verified.canonicalJson,
      payload.workspaceId,
      payload.repoPath,
      payload.worktreePath,
      payload.branch,
      payload.headSha,
      payload.baseBranch,
      payload.baseSha,
      verified.evidence.pushUrl,
      JSON.stringify(payload.allowedPaths),
      taskId,
      worktreeId,
      createdAt,
    );
    requireAllPinIdentities(verified);
    return {
      mode: 'apply',
      taskId,
      worktreeId,
      auditId,
      digest: verified.digest,
      replayed: false,
      createdAt,
    };
  });
  const applyTransaction = typeof transaction.immediate === 'function'
    ? (...args: any[]) => transaction.immediate(...args)
    : transaction;

  function importContext(input: any) {
    const verified = verifyIntegrationContext(input);
    try {
      if (input.mode === 'preview') {
        return { mode: 'preview', ...verified };
      }
      if (typeof input.digest !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.digest)
        || input.digest !== verified.digest) {
        fail('digest_mismatch', 'apply digest does not match the verified preview');
      }
      resolved.beforeApplyTransaction?.(verified);
      requireAllPinIdentities(verified);
      const result = applyTransaction(verified);
      try {
        resolved.appendLifecycle({
          schema: 'ace.event.v1',
          eventId: result.auditId,
          type: 'run.context.imported',
          at: result.createdAt,
          actor: 'system',
          workspaceId: verified.payload.workspaceId,
          repoRoot: verified.payload.repoPath,
          taskId: result.taskId,
          worktreeId: result.worktreeId,
          branch: verified.payload.branch,
          requestId: verified.payload.requestId,
          digest: verified.digest,
          summary: `Imported integration context ${result.taskId}`,
          evidence: [{
            headSha: verified.payload.headSha,
            baseSha: verified.payload.baseSha,
            allowedPaths: verified.payload.allowedPaths,
          }],
        }, { repoCapability: descriptorCapability(verified.pins.repo) });
      } catch {
        fail('projection_failed', 'context import committed but lifecycle projection failed; retry the identical apply');
      }
      const { createdAt: _createdAt, ...publicResult } = result;
      return publicResult;
    } finally {
      releasePins(verified);
    }
  }

  return { importContext };
}

module.exports = {
  ContextImportError,
  createIntegrationContextImporter,
  literalAllowedPaths,
  normalizeGithubRemote,
  parseWorktreePorcelainZ,
};
