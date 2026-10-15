const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ContextImportError, createIntegrationContextImporter } = require('../integration-context-import.cts');
const { createIntegrationGateway } = require('../integration-gateway.cts');
const { appendProjectLifecycleEvent, createAceStore } = require('../local-core.cjs');
const { BetterSqlite3NodeShim } = require('./helpers/better-sqlite3-node-shim.cts');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ace Context Import Test',
  GIT_AUTHOR_EMAIL: 'context-import@example.invalid',
  GIT_COMMITTER_NAME: 'Ace Context Import Test',
  GIT_COMMITTER_EMAIL: 'context-import@example.invalid',
};
const FCHDIR_GIT_SCRIPT = [
  'import os, sys',
  'os.fchdir(3)',
  'os.execvp(sys.argv[1], sys.argv[1:])',
].join('\n');
const GIT_RUNNER_BOOTSTRAP_FAILURE = 'ACE_CONTEXT_IMPORT_GIT_RUNNER_BOOTSTRAP_FAILED';

test('ContextImportError explicitly tags its public application code', () => {
  const error = new ContextImportError('dirty_worktree', 'worktree is dirty');
  assert.equal(error.code, 'dirty_worktree');
  assert.equal(error.applicationCode, 'dirty_worktree');
});

test('ordinary project lifecycle append remains best-effort without importer capability', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lifecycle-compat-'));
  try {
    const event = { eventId: 'evt-ordinary', type: 'ordinary.lifecycle' };
    assert.doesNotThrow(() => appendProjectLifecycleEvent(null, event));
    assert.doesNotThrow(() => appendProjectLifecycleEvent(root, event));
    assert.deepEqual(
      fs.readFileSync(path.join(root, '.ace', 'events.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line)),
      [event],
    );

    fs.rmSync(path.join(root, '.ace'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ace'), 'not a directory');
    assert.doesNotThrow(
      () => appendProjectLifecycleEvent(root, { eventId: 'evt-best-effort', type: 'ordinary.failure' }),
      'ordinary lifecycle delivery failures remain best-effort',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBuffer(cwd: string, args: string[], env: any = GIT_ENV): Buffer {
  return childProcess.execFileSync('git', args, {
    cwd,
    env,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function invocationPath(target: any): string {
  return typeof target === 'string' ? target : target.path;
}

function invocationArgs(args: string[]): string[] {
  const command = [...args];
  while (true) {
    if (command[0] === '-c' && command[1] === 'core.fsmonitor=false') {
      command.splice(0, 2);
    } else if (command[0] === '--no-optional-locks'
      || command[0] === '--no-replace-objects'
      || command[0]?.startsWith('--git-dir=')
      || command[0]?.startsWith('--work-tree=')) {
      command.shift();
    } else {
      break;
    }
  }
  return command;
}

function hostileFsmonitor(fixture: any, label: string) {
  const hookPath = path.join(fixture.root, `${label}-fsmonitor`);
  const markerPath = path.join(fixture.root, `${label}-called`);
  fs.writeFileSync(hookPath, [
    '#!/bin/sh',
    `printf 'called\\n' >> ${JSON.stringify(markerPath)}`,
    "printf 'stale-token\\0'",
  ].join('\n'), { mode: 0o700 });
  return { hookPath, markerPath };
}

function gitBufferAtPinnedDirectory(target: any, args: string[], options: any = {}): Buffer {
  if (typeof target === 'string') return gitBuffer(target, args, options.env || GIT_ENV);
  const runner = '/usr/bin/python3';
  assert.equal(fs.existsSync(runner), true, 'descriptor-relative Git test requires /usr/bin/python3');
  return childProcess.execFileSync(
    runner,
    ['-I', '-c', FCHDIR_GIT_SCRIPT, 'git', ...args],
    {
      env: { ...GIT_ENV, ...(options.env || {}) },
      encoding: 'buffer',
      input: options.input,
      stdio: [
        options.input === undefined ? 'ignore' : 'pipe',
        'pipe',
        'pipe',
        target.fd,
        ...(options.extraTargets || []).map((entry: any) => entry.fd),
      ],
    },
  );
}

function fdTracker() {
  const opened: number[] = [];
  const closed: number[] = [];
  return {
    opened,
    closed,
    open(candidate: string, flags: number, mode?: number) {
      const fd = fs.openSync(candidate, flags, mode);
      opened.push(fd);
      return fd;
    },
    close(fd: number) {
      closed.push(fd);
      fs.closeSync(fd);
    },
    assertBalanced() {
      assert.deepEqual([...closed].sort((a, b) => a - b), [...opened].sort((a, b) => a - b));
    },
  };
}

function withHostileGitEnv(run: () => void) {
  const hostile = {
    GIT_DIR: '/hostile/git-dir',
    GIT_WORK_TREE: '/hostile/work-tree',
    GIT_COMMON_DIR: '/hostile/common-dir',
    GIT_INDEX_FILE: '/hostile/index',
    GIT_OBJECT_DIRECTORY: '/hostile/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/hostile/alternate-objects',
    GIT_NAMESPACE: 'hostile-namespace',
    GIT_CEILING_DIRECTORIES: '/',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    GIT_GRAFT_FILE: '/hostile/grafts',
    GIT_SHALLOW_FILE: '/hostile/shallow',
    GIT_REPLACE_REF_BASE: 'refs/hostile/',
    GIT_CONFIG: '/hostile/config',
    GIT_CONFIG_GLOBAL: '/hostile/global-config',
    GIT_CONFIG_SYSTEM: '/hostile/system-config',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_EXTERNAL_DIFF: '/hostile/external-diff',
  };
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(hostile)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createTestSchema(db: any) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      is_remote INTEGER NOT NULL DEFAULT 0,
      github_repo TEXT,
      default_branch TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      primary_agent TEXT NOT NULL,
      is_multi_agent INTEGER NOT NULL DEFAULT 0,
      initial_prompt TEXT,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      task_type TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      remote_base_ref TEXT,
      base_sha TEXT,
      local_base_sha TEXT,
      local_ahead_by INTEGER NOT NULL DEFAULT 0,
      local_behind_by INTEGER NOT NULL DEFAULT 0,
      branch_point TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE integration_context_imports (
      audit_id TEXT NOT NULL UNIQUE,
      request_id TEXT PRIMARY KEY,
      payload_digest TEXT NOT NULL UNIQUE,
      canonical_payload_json TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES projects(id),
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      push_url TEXT NOT NULL,
      allowed_paths_json TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      worktree_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, branch)
    );
    CREATE TRIGGER integration_context_imports_no_update
    BEFORE UPDATE ON integration_context_imports BEGIN
      SELECT RAISE(ABORT, 'integration context audit is immutable');
    END;
    CREATE TRIGGER integration_context_imports_no_delete
    BEFORE DELETE ON integration_context_imports BEGIN
      SELECT RAISE(ABORT, 'integration context audit is immutable');
    END;
  `);
}

function makeImportFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-context-import-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  childProcess.execFileSync('git', ['init', '--bare', bare], { env: GIT_ENV, stdio: 'ignore' });
  childProcess.execFileSync('git', ['clone', bare, repo], { env: GIT_ENV, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n', 'utf8');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'push', '-u', 'origin', 'main');
  const baseSha = git(repo, 'rev-parse', 'refs/remotes/origin/main');
  git(repo, 'worktree', 'add', '-b', 'feat/import', worktree, 'main');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'allowed.ts'), 'export const allowed = true;\n', 'utf8');
  git(worktree, 'add', 'src/allowed.ts');
  git(worktree, 'commit', '-m', 'add allowed file');
  const headSha = git(worktree, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/example/context-import.git');

  const canonicalRepo = fs.realpathSync.native(repo);
  const canonicalWorktree = fs.realpathSync.native(worktree);
  const dbPath = path.join(root, 'ace.db');
  const db = new BetterSqlite3NodeShim(dbPath);
  createTestSchema(db);
  db.prepare(
    `INSERT INTO projects (id, path, is_remote, github_repo, default_branch)
     VALUES (?, ?, 0, ?, 'main')`
  ).run('prj_1', canonicalRepo, 'example/context-import');
  const lifecycle: any[] = [];
  let id = 0;
  const makeImporter = (overrides: any = {}) => createIntegrationContextImporter({
      db,
      newId: (prefix: string) => `${prefix}_${++id}`,
      now: () => '2026-08-04T00:00:00.000Z',
      appendLifecycle: (event: any) => {
        if (!lifecycle.some((entry: any) => entry.eventId === event.eventId)) lifecycle.push(event);
      },
      ...overrides,
    });
  const importer = makeImporter();

  const input = (overrides: any = {}) => ({
    workspaceId: 'prj_1',
    repoPath: canonicalRepo,
    worktreePath: canonicalWorktree,
    branch: 'feat/import',
    headSha,
    baseBranch: 'main',
    baseSha,
    allowedPaths: ['src/allowed.ts'],
    requestId: 'req-1',
    mode: 'preview',
    digest: null,
    ...overrides,
  });
  const countRows = () => ({
    tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    worktrees: db.prepare('SELECT COUNT(*) AS n FROM worktrees').get().n,
    audits: db.prepare('SELECT COUNT(*) AS n FROM integration_context_imports').get().n,
  });
  const row = (table: string, idValue: string, idColumn = 'id') =>
    db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(idValue);
  const insertWorktreeClaim = (claimedPath: string, claimedBranch: string) => {
    const suffix = String(++id);
    const taskId = `existing_task_${suffix}`;
    db.prepare(
      `INSERT INTO tasks
       (id, project_id, kind, name, primary_agent, is_multi_agent, initial_prompt,
        auto_approve, task_type, order_index, archived_at, created_at, updated_at)
       VALUES (?, 'prj_1', 'task', 'Existing', 'codex', 0, NULL, 0, NULL, 0, NULL, ?, ?)`,
    ).run(taskId, '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
    db.prepare(
      `INSERT INTO worktrees
       (id, task_id, project_id, display_name, branch, base_branch, remote_base_ref,
        base_sha, local_base_sha, local_ahead_by, local_behind_by, branch_point, path, created_at)
       VALUES (?, ?, 'prj_1', ?, ?, 'main', 'origin/main', ?, ?, 1, 0,
               'origin/main', ?, ?)`,
    ).run(
      `existing_worktree_${suffix}`,
      taskId,
      claimedBranch,
      claimedBranch,
      baseSha,
      baseSha,
      claimedPath,
      '2026-08-04T00:00:00.000Z',
    );
  };
  const cleanup = () => {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    repo: canonicalRepo,
    worktree: canonicalWorktree,
    branch: 'feat/import',
    baseSha,
    headSha,
    db,
    lifecycle,
    importer,
    makeImporter,
    input,
    countRows,
    row,
    insertWorktreeClaim,
    cleanup,
  };
}

function withFixture(run: (fixture: ReturnType<typeof makeImportFixture>) => void) {
  const fixture = makeImportFixture();
  try {
    run(fixture);
  } finally {
    fixture.cleanup();
  }
}

function assertImportCode(mutate: (input: any, fixture: any) => void, expectedCode: string) {
  withFixture((fixture) => {
    const input = fixture.input();
    mutate(input, fixture);
    assert.throws(
      () => fixture.importer.importContext(input),
      (error: any) => error?.code === expectedCode,
    );
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
    assert.equal(fixture.lifecycle.length, 0);
  });
}

test('preview proves canonical Git identity and writes nothing', () => {
  withFixture((fixture) => {
    const before = fixture.countRows();
    const result = fixture.importer.importContext(fixture.input());
    assert.equal(result.mode, 'preview');
    assert.match(result.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.payload.allowedPaths, ['src/allowed.ts']);
    assert.deepEqual(result.payload.repoIdentity, {
      dev: String(fs.statSync(fixture.repo).dev),
      ino: String(fs.statSync(fixture.repo).ino),
    });
    assert.deepEqual(result.payload.worktreeIdentity, {
      dev: String(fs.statSync(fixture.worktree).dev),
      ino: String(fs.statSync(fixture.worktree).ino),
    });
    assert.equal(result.evidence.originRepo, 'example/context-import');
    assert.equal(result.evidence.repoCommonDir, result.evidence.worktreeCommonDir);
    assert.deepEqual(result.evidence.changedPaths, ['src/allowed.ts']);
    assert.deepEqual(fixture.countRows(), before);
    assert.equal(fixture.lifecycle.length, 0);
  });
});

test('preview accepts the standard macOS temporary directory alias', () => {
  withFixture((fixture) => {
    const defaultTmpdir = path.resolve(childProcess.execFileSync(
      '/usr/bin/getconf',
      ['DARWIN_USER_TEMP_DIR'],
      { encoding: 'utf8' },
    ).trim());
    assert.notEqual(
      fs.realpathSync.native(defaultTmpdir),
      defaultTmpdir,
      'the regression requires the standard /var to /private/var alias',
    );
    const result = fixture.makeImporter({ tmpdir: () => defaultTmpdir })
      .importContext(fixture.input());
    assert.equal(result.mode, 'preview');
  });
});

for (const operation of ['write', 'fsync', 'first fstat'] as const) {
  test(`preview removes its private index snapshot after injected ${operation} failure`, () => {
    withFixture((fixture) => {
      const tracker = fdTracker();
      const tempRoot = path.join(fixture.root, `snapshot-${operation.replace(' ', '-')}-failure`);
      fs.mkdirSync(tempRoot);
      let snapshotFd: number | null = null;
      let injected = false;
      const importer = fixture.makeImporter({
        tmpdir: () => tempRoot,
        open(candidate: string, flags: number, mode?: number) {
          const fd = tracker.open(candidate, flags, mode);
          if (path.basename(candidate).startsWith('ace-context-import-index-')) snapshotFd = fd;
          return fd;
        },
        close: tracker.close,
        fstat(fd: number) {
          if (operation === 'first fstat' && fd === snapshotFd && !injected) {
            injected = true;
            throw new Error('injected private index snapshot fstat failure');
          }
          return fs.fstatSync(fd);
        },
        write(fd: number, ...args: any[]) {
          if (operation === 'write' && fd === snapshotFd && !injected) {
            injected = true;
            throw new Error('injected private index snapshot write failure');
          }
          return (fs.writeSync as any)(fd, ...args);
        },
        fsync(fd: number) {
          if (operation === 'fsync' && fd === snapshotFd && !injected) {
            injected = true;
            throw new Error('injected private index snapshot fsync failure');
          }
          return fs.fsyncSync(fd);
        },
      });
      assert.throws(
        () => importer.importContext(fixture.input()),
        (error: any) => error?.code === 'path_pin_unsupported'
          && error?.message === 'private index snapshot cannot be created',
      );
      assert.equal(injected, true);
      assert.deepEqual(fs.readdirSync(tempRoot), [], 'owned snapshot must not leak');
      tracker.assertBalanced();
    });
  });
}

test('preview preserves an attacker replacement after snapshot failure cleanup drift', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const tempRoot = path.join(fixture.root, 'snapshot-failure-replacement');
    const parkedSnapshot = path.join(fixture.root, 'snapshot-failure-evidence');
    const replacement = Buffer.from('attacker replacement must survive\n', 'utf8');
    fs.mkdirSync(tempRoot);
    let snapshotFd: number | null = null;
    let replacementPath = '';
    let injected = false;
    const importer = fixture.makeImporter({
      tmpdir: () => tempRoot,
      open(candidate: string, flags: number, mode?: number) {
        const fd = tracker.open(candidate, flags, mode);
        if (path.basename(candidate).startsWith('ace-context-import-index-')) {
          snapshotFd = fd;
          replacementPath = path.join(tempRoot, path.basename(candidate));
        }
        return fd;
      },
      close: tracker.close,
      fstat(fd: number) {
        if (fd === snapshotFd && !injected) {
          injected = true;
          fs.renameSync(replacementPath, parkedSnapshot);
          fs.writeFileSync(replacementPath, replacement);
          throw new Error('injected first fstat failure after replacement');
        }
        return fs.fstatSync(fd);
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift'
        && error?.message === 'private index snapshot cleanup identity changed',
    );
    assert.deepEqual(fs.readFileSync(replacementPath), replacement);
    assert.ok(fs.statSync(parkedSnapshot).isFile(), 'owned snapshot evidence must be retained');
    tracker.assertBalanced();
  });
});

test('preview preserves snapshot evidence when the pinned temp-root path is replaced at cleanup', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const tempRoot = path.join(fixture.root, 'snapshot-temp-root');
    const parkedRoot = path.join(fixture.root, 'snapshot-temp-root-parked');
    fs.mkdirSync(tempRoot);
    let replacementIdentity: any = null;
    const replaceTempRoot = () => {
      if (replacementIdentity) return;
      fs.renameSync(tempRoot, parkedRoot);
      fs.mkdirSync(tempRoot);
      replacementIdentity = fs.statSync(tempRoot);
    };
    const importer = fixture.makeImporter({
      tmpdir: () => tempRoot,
      open: tracker.open,
      close: tracker.close,
      beforeIndexSnapshotCleanup: replaceTempRoot,
      unlink(candidate: string) {
        replaceTempRoot();
        fs.unlinkSync(candidate);
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.ok(replacementIdentity);
    assert.equal(fs.statSync(tempRoot).ino, replacementIdentity!.ino, 'replacement root must survive');
    assert.ok(fs.readdirSync(parkedRoot).length > 0, 'owned snapshot evidence must be retained');
    tracker.assertBalanced();
  });
});

test('preview never removes a replacement snapshot leaf during cleanup', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const tempRoot = path.join(fixture.root, 'snapshot-leaf-race');
    const parkedSnapshot = path.join(fixture.root, 'snapshot-leaf-evidence');
    const replacement = Buffer.from('replacement snapshot must survive\n', 'utf8');
    fs.mkdirSync(tempRoot);
    let replacementPath = '';
    const importer = fixture.makeImporter({
      tmpdir: () => tempRoot,
      open: tracker.open,
      close: tracker.close,
      beforeIndexSnapshotCleanup({ basename }: any) {
        replacementPath = path.join(tempRoot, basename);
        fs.renameSync(replacementPath, parkedSnapshot);
        fs.writeFileSync(replacementPath, replacement);
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.deepEqual(fs.readFileSync(replacementPath), replacement);
    assert.ok(fs.statSync(parkedSnapshot).isFile(), 'owned snapshot evidence must be retained');
    tracker.assertBalanced();
  });
});

for (const [label, mutate, code] of [
  ['empty request', (input: any) => { input.requestId = ''; }, 'invalid_input'],
  ['short head', (input: any) => { input.headSha = 'abc'; }, 'invalid_sha'],
  ['uppercase base sha', (input: any) => { input.baseSha = `A${input.baseSha.slice(1)}`; }, 'invalid_sha'],
  ['duplicate path', (input: any) => { input.allowedPaths = ['src/allowed.ts', 'src/allowed.ts']; }, 'invalid_allowed_path'],
  ['glob', (input: any) => { input.allowedPaths = ['src/*.ts']; }, 'invalid_allowed_path'],
  ['absolute path', (input: any) => { input.allowedPaths = ['/src/allowed.ts']; }, 'invalid_allowed_path'],
  ['escape', (input: any) => { input.allowedPaths = ['../secret']; }, 'invalid_allowed_path'],
  ['backslash alias', (input: any) => { input.allowedPaths = ['src\\allowed.ts']; }, 'invalid_allowed_path'],
  ['control byte', (input: any) => { input.allowedPaths = ['src/allowed\u0001.ts']; }, 'invalid_allowed_path'],
  ['noncanonical repo', (input: any) => { input.repoPath += '/.'; }, 'path_not_canonical'],
] as const) {
  test(`preview rejects ${label}`, () => assertImportCode(mutate, code));
}

test('preview rejects workspace unknown', () => {
  withFixture((fixture) => {
    fixture.db.prepare('DELETE FROM projects WHERE id = ?').run('prj_1');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'workspace_not_found',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
  });
});

test('preview rejects workspace remote row', () => {
  withFixture((fixture) => {
    fixture.db.prepare('UPDATE projects SET is_remote = 1 WHERE id = ?').run('prj_1');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'workspace_not_local',
    );
  });
});

test('preview rejects workspace repository mapping mismatch', () => {
  withFixture((fixture) => {
    fixture.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(fixture.root, 'prj_1');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'repo_mapping_mismatch',
    );
  });
});

test('preview rejects remote URL mismatch', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'remote', 'set-url', 'origin', 'git@github.com:other/repository.git');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview rejects any additional origin fetch URL', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', '--add', 'remote.origin.url', 'git@github.com:other/repository.git');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview rejects any additional or mismatched origin push URL', () => {
  withFixture((fixture) => {
    git(
      fixture.repo,
      'remote', 'set-url', '--add', '--push',
      'origin',
      'https://github.com/example/context-import.git',
    );
    git(
      fixture.repo,
      'remote', 'set-url', '--add', '--push',
      'origin',
      'git@github.com:other/repository.git',
    );
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview does not treat the case-sensitive remote subsection Origin as origin', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', '--rename-section', 'remote.origin', 'remote.Origin');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview treats remote section and variable spelling as case-insensitive', () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture.repo, '.git', 'config');
    const config = fs.readFileSync(configPath, 'utf8')
      .replace('[remote "origin"]', '[ReMoTe "origin"]')
      .replace(
        '\turl = https://github.com/example/context-import.git',
        [
          '\tURL = https://github.com/example/context-import.git',
          '\tPuShUrL = git@github.com:example/context-import.git',
        ].join('\n'),
      );
    fs.writeFileSync(configPath, config, 'utf8');
    const preview = fixture.importer.importContext(fixture.input());
    assert.equal(preview.evidence.originRepo, 'example/context-import');
    assert.equal(preview.evidence.pushUrl, 'git@github.com:example/context-import.git');
  });
});

test('preview treats a matching no-op pushInsteadOf as authoritative', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'remote', 'set-url', 'origin', 'mirror:example/context-import.git');
    git(fixture.repo, 'config', 'url.https://github.com/.insteadOf', 'mirror:');
    git(fixture.repo, 'config', 'url.mirror:.pushInsteadOf', 'mirror:');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

for (const rewriteKey of ['insteadOf', 'pushInsteadOf']) {
  test(`preview applies an empty ${rewriteKey} prefix from the pinned config snapshot`, () => {
    withFixture((fixture) => {
      git(fixture.repo, 'config', `url.https://attacker.invalid/.${rewriteKey}`, '');
      assert.throws(
        () => fixture.importer.importContext(fixture.input()),
        (error: any) => error?.code === 'remote_mismatch',
      );
    });
  });
}

test('preview rejects a common config include before it can affect remote URLs', () => {
  withFixture((fixture) => {
    const includePath = path.join(fixture.root, 'included-origin.config');
    fs.writeFileSync(
      includePath,
      '[remote "origin"]\n\tpushurl = https://github.com/example/context-import.git\n',
      'utf8',
    );
    git(fixture.repo, 'config', 'include.path', includePath);
    const tracker = fdTracker();
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    tracker.assertBalanced();
  });
});

test('preview rejects a matching common config includeIf', () => {
  withFixture((fixture) => {
    const includePath = path.join(fixture.root, 'conditional-origin.config');
    fs.writeFileSync(
      includePath,
      '[remote "origin"]\n\tpushurl = https://github.com/example/context-import.git\n',
      'utf8',
    );
    git(fixture.repo, 'config', 'includeIf.onbranch:main.path', includePath);
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview rejects a symlinked external common config include target', () => {
  withFixture((fixture) => {
    const targetPath = path.join(fixture.root, 'origin-target.config');
    const includePath = path.join(fixture.root, 'origin-link.config');
    fs.writeFileSync(
      targetPath,
      '[remote "origin"]\n\tpushurl = https://github.com/example/context-import.git\n',
      'utf8',
    );
    fs.symlinkSync(targetPath, includePath);
    git(fixture.repo, 'config', 'include.path', includePath);
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview rejects a mutable external common config include before remote attestation', () => {
  withFixture((fixture) => {
    const includePath = path.join(fixture.root, 'mutable-origin.config');
    fs.writeFileSync(
      includePath,
      '[remote "origin"]\n\tpushurl = https://github.com/example/context-import.git\n',
      'utf8',
    );
    git(fixture.repo, 'config', 'include.path', includePath);
    let mutated = false;
    const importer = fixture.makeImporter({
      execGit(target: any, args: string[], options: any) {
        const output = gitBufferAtPinnedDirectory(target, args, options);
        const command = invocationArgs(args);
        if (!mutated && command.join('\0') === ['remote', 'get-url', '--all', 'origin'].join('\0')) {
          mutated = true;
          fs.writeFileSync(
            includePath,
            '[remote "origin"]\n\tpushurl = git@github.com:example/context-import.git\n',
            'utf8',
          );
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    assert.equal(mutated, false, 'include must be rejected before remote URL attestation');
  });
});

test('preview binds remote attestation to the captured common config after pathname replacement', () => {
  withFixture((fixture) => {
    const commonConfigPath = path.join(fixture.repo, '.git', 'config');
    const replacementPath = path.join(fixture.repo, '.git', 'config.replacement');
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    const original = fs.readFileSync(commonConfigPath, 'utf8');
    fs.writeFileSync(
      path.join(linkedGitDir, 'config.worktree'),
      '[remote "origin"]\n\tpushurl = git@github.com:attacker/worktree-replaced.git\n',
      'utf8',
    );
    let replaced = false;
    const importer = fixture.makeImporter({
      execGit(target: any, args: string[], options: any) {
        const command = invocationArgs(args);
        if (!replaced && command[0] === 'check-ref-format') {
          replaced = true;
          fs.writeFileSync(
            replacementPath,
            `${original.replace(
              'https://github.com/example/context-import.git',
              'git@github.com:attacker/replaced.git',
            )}\n[extensions]\n\tworktreeConfig = true\n`,
            'utf8',
          );
          fs.renameSync(replacementPath, commonConfigPath);
        }
        return gitBufferAtPinnedDirectory(target, args, options);
      },
    });
    const preview = importer.importContext(fixture.input());
    assert.equal(replaced, true);
    assert.equal(preview.evidence.originRepo, 'example/context-import');
    assert.equal(preview.evidence.pushUrl, 'https://github.com/example/context-import.git');
  });
});

test('preview rejects a malicious linked-worktree-specific origin push URL', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    git(
      fixture.worktree,
      'config', '--worktree',
      'remote.origin.pushurl',
      'git@github.com:attacker/redirected.git',
    );
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    tracker.assertBalanced();
  });
});

test('preview accepts one matching effective linked-worktree origin push URL', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    git(
      fixture.worktree,
      'config', '--worktree',
      'remote.origin.pushurl',
      'git@github.com:example/context-import.git',
    );
    assert.equal(fixture.importer.importContext(fixture.input()).mode, 'preview');
  });
});

test('preview rejects multiple effective linked-worktree origin push URLs', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    for (let index = 0; index < 2; index += 1) {
      git(
        fixture.worktree,
        'config', '--worktree', '--add',
        'remote.origin.pushurl',
        'https://github.com/example/context-import.git',
      );
    }
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
  });
});

test('preview opens linked-worktree config nonblocking and rejects a FIFO with balanced fds', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    const configPath = path.join(linkedGitDir, 'config.worktree');
    childProcess.execFileSync('/usr/bin/mkfifo', [configPath]);
    const tracker = fdTracker();
    let configFlags = 0;
    const importer = fixture.makeImporter({
      open(candidate: string, flags: number) {
        if (candidate === configPath || candidate.endsWith('/config.worktree')) {
          configFlags = flags;
          if ((flags & fs.constants.O_NONBLOCK) === 0) {
            throw Object.assign(new Error('blocking FIFO open forbidden by test seam'), { code: 'EWOULDBLOCK' });
          }
        }
        return tracker.open(candidate, flags);
      },
      close: tracker.close,
    });
    const startedAt = Date.now();
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    assert.ok((configFlags & fs.constants.O_NONBLOCK) !== 0, 'config.worktree must use O_NONBLOCK');
    assert.ok(Date.now() - startedAt < 1_000, 'FIFO rejection must be prompt');
    tracker.assertBalanced();
  });
});

test('preview rejects oversized sparse linked-worktree config promptly with balanced fds', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    const configPath = path.join(linkedGitDir, 'config.worktree');
    fs.closeSync(fs.openSync(configPath, 'w'));
    fs.truncateSync(configPath, 1024 * 1024);
    const tracker = fdTracker();
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
    });
    const startedAt = Date.now();
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    assert.ok(Date.now() - startedAt < 1_000, 'sparse-file rejection must be prompt');
    tracker.assertBalanced();
  });
});

test('preview bounds linked-worktree config growth during the read loop and balances fds', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    git(
      fixture.worktree,
      'config', '--worktree', 'remote.origin.pushurl',
      'https://github.com/example/context-import.git',
    );
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    const configPath = path.join(linkedGitDir, 'config.worktree');
    const configIdentity = fs.statSync(configPath);
    const tracker = fdTracker();
    let grew = false;
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
        const bytesRead = fs.readSync(fd, buffer, offset, length, position);
        const stats = fs.fstatSync(fd);
        if (!grew && stats.dev === configIdentity.dev && stats.ino === configIdentity.ino) {
          grew = true;
          fs.appendFileSync(configPath, Buffer.alloc(70 * 1024, 0x61));
        }
        return bytesRead;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    assert.equal(grew, true);
    tracker.assertBalanced();
  });
});

for (const [field, value] of [
  ['branch', 'feat/import^{commit}'],
  ['baseBranch', 'main^{commit}'],
] as const) {
  test(`preview rejects revision syntax in ${field}`, () => {
    assertImportCode((input) => { input[field] = value; }, 'invalid_branch');
  });
}

test('preview rejects worktree absent from worktree list', () => {
  withFixture((fixture) => {
    const importer = fixture.makeImporter({
      execGit: (target: any, args: string[], options: any) => {
        const command = invocationArgs(args);
        const output = gitBufferAtPinnedDirectory(target, args, options);
        if (command.join('\0') === ['worktree', 'list', '--porcelain', '-z'].join('\0')) {
          return Buffer.from(output.toString('utf8').replaceAll(fixture.worktree, `${fixture.worktree}-absent`));
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'worktree_not_listed',
    );
  });
});

test('preview rejects worktree common directory mismatch', () => {
  withFixture((fixture) => {
    const otherCommonDir = path.join(fixture.root, 'other-common');
    fs.mkdirSync(otherCommonDir);
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    fs.writeFileSync(path.join(linkedGitDir, 'commondir'), `${otherCommonDir}\n`, 'utf8');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'worktree_repo_mismatch',
    );
  });
});

test('preview rejects branch mismatch', () => {
  withFixture((fixture) => {
    const input = fixture.input({ branch: 'feat/other' });
    const importer = fixture.makeImporter({
      execGit: (target: any, args: string[], options: any) => {
        const command = invocationArgs(args);
        const output = gitBufferAtPinnedDirectory(target, args, options);
        if (command.join('\0') === ['worktree', 'list', '--porcelain', '-z'].join('\0')) {
          return Buffer.from(output.toString('utf8').replace('refs/heads/feat/import', 'refs/heads/feat/other'));
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(input),
      (error: any) => error?.code === 'branch_mismatch',
    );
  });
});

test('preview rejects head mismatch', () => {
  withFixture((fixture) => {
    const input = fixture.input({ headSha: fixture.baseSha });
    const importer = fixture.makeImporter({
      execGit: (target: any, args: string[], options: any) => {
        const command = invocationArgs(args);
        const output = gitBufferAtPinnedDirectory(target, args, options);
        if (command.join('\0') === ['worktree', 'list', '--porcelain', '-z'].join('\0')) {
          return Buffer.from(output.toString('utf8').replace(fixture.headSha, fixture.baseSha));
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(input),
      (error: any) => error?.code === 'head_mismatch',
    );
  });
});

test('preview rejects base branch or SHA mismatch', () => {
  assertImportCode((input) => { input.baseSha = input.headSha; }, 'base_mismatch');
});

test('preview rejects base that is not an ancestor', () => {
  withFixture((fixture) => {
    const tree = git(fixture.repo, 'rev-parse', 'HEAD^{tree}');
    const divergent = git(fixture.repo, 'commit-tree', tree, '-m', 'divergent root');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/divergent', divergent);
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ baseBranch: 'divergent', baseSha: divergent })),
      (error: any) => error?.code === 'base_not_ancestor',
    );
  });
});

test('preview rejects dirty tracked worktree', () => {
  withFixture((fixture) => {
    fs.appendFileSync(path.join(fixture.worktree, 'src', 'allowed.ts'), '// dirty\n');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'dirty_worktree',
    );
  });
});

test('preview rejects dirty untracked worktree', () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture.worktree, 'untracked.txt'), 'dirty\n');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'dirty_worktree',
    );
  });
});

for (const indexFlag of ['--assume-unchanged', '--skip-worktree']) {
  test(`preview rejects tracked dirt hidden by ${indexFlag}`, () => {
    withFixture((fixture) => {
      git(fixture.worktree, 'update-index', indexFlag, 'src/allowed.ts');
      fs.appendFileSync(path.join(fixture.worktree, 'src', 'allowed.ts'), '// hidden dirt\n');
      assert.throws(
        () => fixture.importer.importContext(fixture.input()),
        (error: any) => error?.code === 'dirty_worktree',
      );
    });
  });
}

test('preview rejects scope missing', () => {
  assertImportCode(
    (input) => { input.allowedPaths = ['src/allowed.ts', 'src/missing.ts']; },
    'scope_missing',
  );
});

test('preview rejects scope contamination', () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture.worktree, 'src', 'extra.ts'), 'export const extra = true;\n');
    git(fixture.worktree, 'add', 'src/extra.ts');
    git(fixture.worktree, 'commit', '-m', 'add unexpected file');
    const headSha = git(fixture.worktree, 'rev-parse', 'HEAD');
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ headSha })),
      (error: any) => error?.code === 'scope_contamination',
    );
  });
});

test('preview rejects a real redirected submodule before following nested Git metadata', () => {
  withFixture((fixture) => {
    const submoduleSource = path.join(fixture.root, 'submodule-source');
    fs.mkdirSync(submoduleSource);
    git(submoduleSource, 'init');
    fs.writeFileSync(path.join(submoduleSource, 'payload.txt'), 'submodule\n');
    git(submoduleSource, 'add', 'payload.txt');
    git(submoduleSource, 'commit', '-m', 'submodule base');
    git(
      fixture.worktree,
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', submoduleSource, 'vendor/submodule',
    );
    git(fixture.worktree, 'commit', '-m', 'add unsupported submodule');
    const headSha = git(fixture.worktree, 'rev-parse', 'HEAD');
    const redirectedWorktree = path.join(fixture.root, 'redirected-submodule-worktree');
    fs.mkdirSync(redirectedWorktree);
    git(path.join(fixture.worktree, 'vendor/submodule'), 'config', 'core.worktree', redirectedWorktree);
    assert.throws(
      () => fixture.importer.importContext(fixture.input({
        headSha,
        allowedPaths: ['.gitmodules', 'src/allowed.ts', 'vendor/submodule'],
      })),
      (error: any) => error?.code === 'unsupported_submodule',
    );
  });
});

test('preview uses pinned directories so swap-clean-restore cannot hide dirt', () => {
  withFixture((fixture) => {
    const cleanReplacement = path.join(fixture.root, 'clean-replacement');
    const parkedOriginal = path.join(fixture.root, 'parked-original');
    fs.cpSync(fixture.worktree, cleanReplacement, { recursive: true });
    let swapped = false;
    const importer = fixture.makeImporter({
      execGit: (target: any, args: string[], options: any) => {
        if (!swapped) {
          fs.appendFileSync(path.join(fixture.worktree, 'src', 'allowed.ts'), '// hidden dirt\n');
          fs.renameSync(fixture.worktree, parkedOriginal);
          fs.renameSync(cleanReplacement, fixture.worktree);
          swapped = true;
        }
        const output = gitBufferAtPinnedDirectory(target, args, options);
        if (invocationArgs(args)[0] === 'diff') {
          fs.renameSync(fixture.worktree, cleanReplacement);
          fs.renameSync(parkedOriginal, fixture.worktree);
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'dirty_worktree',
    );
  });
});

test('preview rejects worktree index replacement between proofs without reopening its pathname', () => {
  withFixture((fixture) => {
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const parkedIndex = path.join(fixture.root, 'parked-worktree-index');
    const observedIndexPaths = new Set<string>();
    let replaced = false;
    const importer = fixture.makeImporter({
      execGit(target: any, args: string[], options: any) {
        if (options.env.GIT_INDEX_FILE) observedIndexPaths.add(options.env.GIT_INDEX_FILE);
        const output = gitBufferAtPinnedDirectory(target, args, options);
        const command = invocationArgs(args);
        if (!replaced && command[0] === 'ls-files' && command.includes('--stage')) {
          fs.renameSync(indexPath, parkedIndex);
          fs.copyFileSync(parkedIndex, indexPath);
          replaced = true;
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(replaced, true);
    assert.equal(observedIndexPaths.size, 1, 'every worktree proof must use one immutable index snapshot');
    assert.doesNotMatch([...observedIndexPaths][0], /\/index$/);
  });
});

for (const [name, mutate] of [
  ['absent', (indexPath: string, fixture: any) => {
    fs.renameSync(indexPath, path.join(fixture.root, 'absent-worktree-index'));
  }],
  ['symlinked', (indexPath: string, fixture: any) => {
    const parked = path.join(fixture.root, 'symlink-target-index');
    fs.renameSync(indexPath, parked);
    fs.symlinkSync(parked, indexPath);
  }],
  ['multi-link', (indexPath: string, fixture: any) => {
    fs.linkSync(indexPath, path.join(fixture.root, 'hard-linked-worktree-index'));
  }],
] as const) {
  test(`preview rejects ${name} worktree index state with balanced fds`, () => {
    withFixture((fixture) => {
      const tracker = fdTracker();
      const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
      mutate(indexPath, fixture);
      const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
      assert.throws(
        () => importer.importContext(fixture.input()),
        (error: any) => error?.code === 'unsupported_index',
      );
      tracker.assertBalanced();
    });
  });
}

test('preview rejects a worktree index that grows during its bounded snapshot read', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const indexIdentity = fs.statSync(indexPath);
    let grew = false;
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
        const count = fs.readSync(fd, buffer, offset, length, position);
        const stats = fs.fstatSync(fd);
        if (!grew && stats.dev === indexIdentity.dev && stats.ino === indexIdentity.ino) {
          fs.appendFileSync(indexPath, Buffer.from([0]));
          grew = true;
        }
        return count;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(grew, true);
    tracker.assertBalanced();
  });
});

test('preview rejects same-inode index rewrite-and-restore during a proof', () => {
  withFixture((fixture) => {
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const original = fs.readFileSync(indexPath);
    let rewrote = false;
    const importer = fixture.makeImporter({
      execGit(target: any, args: string[], options: any) {
        const output = gitBufferAtPinnedDirectory(target, args, options);
        const command = invocationArgs(args);
        if (!rewrote && command[0] === 'ls-files' && command.includes('--stage')) {
          const changed = Buffer.from(original);
          changed[0] ^= 0xff;
          fs.writeFileSync(indexPath, changed);
          fs.writeFileSync(indexPath, original);
          rewrote = true;
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(rewrote, true);
  });
});

test('preview rejects same-inode index content drift when metadata appears unchanged', () => {
  withFixture((fixture) => {
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const original = fs.readFileSync(indexPath);
    const baseline = fs.statSync(indexPath);
    let rewrote = false;
    const importer = fixture.makeImporter({
      fstat(fd: number) {
        const stats = fs.fstatSync(fd);
        if (stats.dev !== baseline.dev || stats.ino !== baseline.ino) return stats;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          size: baseline.size,
          mtimeMs: baseline.mtimeMs,
          ctimeMs: baseline.ctimeMs,
        });
      },
      execGit(target: any, args: string[], options: any) {
        const output = gitBufferAtPinnedDirectory(target, args, options);
        if (!rewrote && invocationArgs(args)[0] === 'config') {
          const changed = Buffer.from(original);
          changed[0] ^= 0xff;
          fs.writeFileSync(indexPath, changed);
          rewrote = true;
        }
        return output;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(rewrote, true);
  });
});

test('preview rejects an oversized worktree index before allocation', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    fs.truncateSync(indexPath, (16 * 1024 * 1024) + 1);
    const startedAt = Date.now();
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'unsupported_index',
    );
    assert.ok(Date.now() - startedAt < 1_000, 'oversized index rejection must be prompt');
    tracker.assertBalanced();
  });
});

test('preview rejects split-index indirection before worktree proofs', () => {
  withFixture((fixture) => {
    git(fixture.worktree, 'update-index', '--split-index');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'unsupported_index',
    );
  });
});

test('preview rejects sparse-index semantics before worktree proofs', () => {
  withFixture((fixture) => {
    git(fixture.worktree, 'sparse-checkout', 'init', '--cone', '--sparse-index');
    git(fixture.worktree, 'sparse-checkout', 'set', 'src');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'unsupported_index',
    );
  });
});

test('preview rejects a real FSMN index whose stale hook hides tracked dirt', () => {
  withFixture((fixture) => {
    const { hookPath, markerPath } = hostileFsmonitor(fixture, 'stale');
    git(fixture.worktree, 'config', 'core.fsmonitor', hookPath);
    git(fixture.worktree, 'config', 'core.fsmonitorHookVersion', '2');
    git(fixture.worktree, 'update-index', '--fsmonitor');
    git(fixture.worktree, 'status', '--porcelain');
    fs.writeFileSync(markerPath, '');
    fs.writeFileSync(
      path.join(fixture.worktree, 'src', 'allowed.ts'),
      'export const allowed = "dirty but hidden";\n',
    );
    const stale = childProcess.spawnSync(
      'git',
      ['--no-optional-locks', 'diff-files', '--quiet'],
      { cwd: fixture.worktree, env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' } },
    );
    const trusted = childProcess.spawnSync(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'diff-files', '--quiet'],
      { cwd: fixture.worktree, env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' } },
    );
    assert.equal(stale.status, 0, 'the hostile fsmonitor must hide the tracked modification');
    assert.equal(trusted.status, 1, 'disabling fsmonitor must expose the tracked modification');
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    assert.equal(fs.readFileSync(indexPath).includes(Buffer.from('FSMN')), true);
    git(fixture.worktree, 'config', 'core.fsmonitor', 'false');
    fs.writeFileSync(markerPath, '');
    assert.throws(
      () => fixture.importer.importContext(fixture.input()),
      (error: any) => error?.code === 'unsupported_index',
    );
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '', 'the importer must not invoke the hook');
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
  });
});

for (const scope of ['common', 'worktree'] as const) {
  test(`preview rejects ${scope} core.fsmonitor configuration without invoking its hook`, () => {
    withFixture((fixture) => {
      const { hookPath, markerPath } = hostileFsmonitor(fixture, scope);
      if (scope === 'worktree') {
        git(fixture.worktree, 'config', 'extensions.worktreeConfig', 'true');
        git(fixture.worktree, 'config', '--worktree', 'core.fsmonitor', hookPath);
      } else {
        git(fixture.worktree, 'config', 'core.fsmonitor', hookPath);
      }
      fs.writeFileSync(markerPath, '');
      assert.throws(
        () => fixture.importer.importContext(fixture.input()),
        (error: any) => error?.code === 'unsupported_index',
      );
      assert.equal(fs.readFileSync(markerPath, 'utf8'), '', 'the importer must not invoke the hook');
    });
  });
}

test('preview bounds a malformed FSMN extension and balances descriptors', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const { hookPath } = hostileFsmonitor(fixture, 'oversized');
    git(fixture.worktree, 'config', 'core.fsmonitor', hookPath);
    git(fixture.worktree, 'config', 'core.fsmonitorHookVersion', '2');
    git(fixture.worktree, 'update-index', '--fsmonitor');
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const content = fs.readFileSync(indexPath);
    const signatureOffset = content.indexOf(Buffer.from('FSMN'), 12);
    assert.ok(signatureOffset > 12 && signatureOffset < content.length - 28);
    content.writeUInt32BE(0xffffffff, signatureOffset + 4);
    const checksumOffset = content.length - 20;
    crypto.createHash('sha1').update(content.subarray(0, checksumOffset)).digest().copy(content, checksumOffset);
    fs.writeFileSync(indexPath, content);
    git(fixture.worktree, 'config', 'core.fsmonitor', 'false');
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'unsupported_index',
    );
    tracker.assertBalanced();
  });
});

test('apply re-attests the source index immediately before its transaction', () => {
  withFixture((fixture) => {
    const preview = fixture.importer.importContext(fixture.input());
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const parked = path.join(fixture.root, 'pre-apply-worktree-index');
    let replaced = false;
    const importer = fixture.makeImporter({
      beforeApplyTransaction() {
        fs.renameSync(indexPath, parked);
        fs.copyFileSync(parked, indexPath);
        replaced = true;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(replaced, true);
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
  });
});

test('apply rechecks source index content when metadata appears unchanged', () => {
  withFixture((fixture) => {
    const preview = fixture.importer.importContext(fixture.input());
    const indexPath = git(fixture.worktree, 'rev-parse', '--git-path', 'index');
    const original = fs.readFileSync(indexPath);
    const baseline = fs.statSync(indexPath);
    let rewrote = false;
    const importer = fixture.makeImporter({
      fstat(fd: number) {
        const stats = fs.fstatSync(fd);
        if (stats.dev !== baseline.dev || stats.ino !== baseline.ino) return stats;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          size: baseline.size,
          mtimeMs: baseline.mtimeMs,
          ctimeMs: baseline.ctimeMs,
        });
      },
      beforeApplyTransaction() {
        const changed = Buffer.from(original);
        changed[0] ^= 0xff;
        fs.writeFileSync(indexPath, changed);
        rewrote = true;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(rewrote, true);
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
  });
});

test('preview invokes every Git proof with optional locks and replace refs disabled', () => {
  withFixture((fixture) => {
    const calls: any[] = [];
    const importer = fixture.makeImporter({
      execGit: (target: any, args: string[], options: any) => {
        calls.push({ target, args, options });
        return gitBufferAtPinnedDirectory(target, args, options);
      },
    });
    importer.importContext(fixture.input());
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(typeof call.target, 'object');
      assert.ok(Number.isInteger(call.target.fd));
      assert.equal(call.args[0], '--no-optional-locks');
      assert.equal(call.args[1], '--no-replace-objects');
      assert.equal(call.args[2], '-c');
      assert.equal(call.args[3], 'core.fsmonitor=false');
      assert.equal(call.options?.env?.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(call.options?.env?.GIT_NO_REPLACE_OBJECTS, '1');
      assert.equal(call.options?.env?.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(call.options?.env?.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(call.options?.descriptorRelative, true);
    }
    const indexPaths = calls.map((call) => call.options?.env?.GIT_INDEX_FILE);
    assert.equal(
      indexPaths.every((indexPath) => typeof indexPath === 'string'),
      true,
      'every Git proof must receive the immutable index snapshot',
    );
    assert.equal(new Set(indexPaths).size, 1, 'every Git proof must receive the same snapshot path');
    assert.match(indexPaths[0], /^\/dev\/fd\/\d+$/);
    const snapshotFds = calls.map((call) => call.options.extraTargets[0]?.fd);
    assert.equal(snapshotFds.every(Number.isInteger), true);
    assert.equal(new Set(snapshotFds).size, 1, 'every Git proof must inherit the same snapshot fd');
    for (const command of ['diff-files', 'diff-index', 'ls-files']) {
      assert.ok(
        calls.find((call) => invocationArgs(call.args).includes(command)),
        `${command} clean-tree proof must be observed`,
      );
    }
    for (const command of ['diff', 'diff-files', 'diff-index']) {
      const proof = calls.find((call) => invocationArgs(call.args).includes(command));
      assert.ok(proof, `${command} proof must be observed`);
      assert.ok(invocationArgs(proof.args).includes('--no-ext-diff'));
      assert.ok(invocationArgs(proof.args).includes('--no-textconv'));
    }
    const indexFlags = calls.find((call) => {
      const args = invocationArgs(call.args);
      return args[0] === 'ls-files' && args.includes('-v');
    });
    assert.ok(indexFlags, 'index flag proof must be observed');
    assert.ok(!invocationArgs(indexFlags.args).includes('--recurse-submodules'));
    assert.ok(calls.some((call) => {
      const args = invocationArgs(call.args);
      return args[0] === 'ls-files' && args.includes('--stage');
    }), 'index gitlink proof must be observed');
    assert.ok(calls.some((call) => invocationArgs(call.args)[0] === 'ls-tree'), 'tree gitlink proof must be observed');
  });
});

test('preview rejects an unavailable descriptor runner and releases every pin', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const unavailablePath = path.join(fixture.root, 'missing-descriptor-runner');
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      gitRunnerPath: unavailablePath,
      gitRunnerAvailable: (candidate: string) => {
        assert.equal(candidate, unavailablePath);
        return false;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'path_pin_unsupported',
    );
    tracker.assertBalanced();
  });
});

test('preview rejects descriptor runner execution failure and releases every pin', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      gitRunnerAvailable: () => true,
      execGitRunner: (runnerPath: string, args: string[], options: any) => {
        if (invocationArgs(args)[0] === 'config') {
          throw new Error('injected descriptor runner failure');
        }
        return childProcess.execFileSync(
          runnerPath,
          ['-I', '-c', FCHDIR_GIT_SCRIPT, 'git', ...args],
          options,
        );
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'git_execution_failed',
    );
    assert.ok(tracker.opened.length >= 4, 'directory pins and bounded control-file reads must be observed');
    tracker.assertBalanced();
  });
});

test('preview classifies marked integer-status runner bootstrap failure and releases pins', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      gitRunnerAvailable: () => true,
      execGitRunner: () => {
        const error: any = new Error('python helper failed before Git exec');
        error.status = 126;
        error.stderr = Buffer.from(`${GIT_RUNNER_BOOTSTRAP_FAILURE}\n`, 'utf8');
        throw error;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'git_execution_failed',
    );
    tracker.assertBalanced();
  });
});

test('preview classifies a real descriptor-runner execvp failure and releases pins', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    const priorPath = process.env.PATH;
    process.env.PATH = path.join(fixture.root, 'no-executables');
    try {
      assert.throws(
        () => importer.importContext(fixture.input()),
        (error: any) => error?.code === 'git_execution_failed',
      );
      tracker.assertBalanced();
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
});

test('preview retains contextual code for an unmarked integer-status Git failure', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      gitRunnerAvailable: () => true,
      execGitRunner: () => {
        const error: any = new Error('ordinary Git evidence failure');
        error.status = 128;
        error.stderr = Buffer.from('fatal: not a git repository\n', 'utf8');
        throw error;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'remote_mismatch',
    );
    tracker.assertBalanced();
  });
});

test('descriptor open failure releases every successfully opened fd', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    let attempts = 0;
    const importer = fixture.makeImporter({
      open: (candidate: string, flags: number) => {
        attempts += 1;
        if (attempts === 2) throw new Error('injected descriptor open failure');
        return tracker.open(candidate, flags);
      },
      close: tracker.close,
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'path_not_canonical',
    );
    tracker.assertBalanced();
  });
});

test('preview success and digest failure close exactly the descriptors they open', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const snapshotTemp = path.join(fixture.root, 'snapshot-fd-balance');
    const unlinkCalls: string[] = [];
    fs.mkdirSync(snapshotTemp);
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      tmpdir: () => snapshotTemp,
      unlink(candidate: string) {
        unlinkCalls.push(candidate);
        fs.unlinkSync(candidate);
      },
    });
    const preview = importer.importContext(fixture.input());
    tracker.assertBalanced();
    assert.deepEqual(fs.readdirSync(snapshotTemp), []);
    assert.deepEqual(unlinkCalls.map((candidate) => /^\/\.vol\/\d+\/\d+$/.test(candidate)), [true]);
    const wrongDigest = `${preview.digest[0] === '0' ? '1' : '0'}${preview.digest.slice(1)}`;
    assert.throws(
      () => importer.importContext(fixture.input({ mode: 'apply', digest: wrongDigest })),
      (error: any) => error?.code === 'digest_mismatch',
    );
    tracker.assertBalanced();
    assert.deepEqual(fs.readdirSync(snapshotTemp), []);
    assert.deepEqual(unlinkCalls.map((candidate) => /^\/\.vol\/\d+\/\d+$/.test(candidate)), [true, true]);
  });
});

test('preview scrubs hostile Git routing environment before every proof', () => {
  withFixture((fixture) => {
    withHostileGitEnv(() => {
      const result = fixture.importer.importContext(fixture.input());
      assert.equal(result.mode, 'preview');
      assert.deepEqual(result.evidence.changedPaths, ['src/allowed.ts']);
    });
  });
});

test('preview rejects repository .git replacement after capability pin without invoking Git', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const repositoryGitDir = path.join(fixture.repo, '.git');
    const parkedGitDir = path.join(fixture.root, 'parked-repository-gitdir');
    const sentinel = Buffer.from('attacker metadata must remain untouched\n', 'utf8');
    let gitCalls = 0;
    let replaced = false;
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      beforeGitDirectoryDiscovery() {
        fs.renameSync(repositoryGitDir, parkedGitDir);
        fs.mkdirSync(repositoryGitDir);
        fs.writeFileSync(path.join(repositoryGitDir, 'ATTACKER_SENTINEL'), sentinel);
        replaced = true;
      },
      execGit(target: any, args: string[], options: any) {
        gitCalls += 1;
        return gitBufferAtPinnedDirectory(target, args, options);
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(replaced, true);
    assert.equal(gitCalls, 0, 'no Git process may observe replacement metadata');
    assert.deepEqual(fs.readFileSync(path.join(repositoryGitDir, 'ATTACKER_SENTINEL')), sentinel);
    tracker.assertBalanced();
  });
});

test('preview rejects linked-worktree .git replacement after capability pin without invoking Git', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    const gitFile = path.join(fixture.worktree, '.git');
    const parkedGitFile = path.join(fixture.root, 'parked-worktree-gitfile');
    const attackerGitDir = path.join(fixture.root, 'attacker-worktree-gitdir');
    const sentinel = Buffer.from('attacker linked metadata must remain untouched\n', 'utf8');
    fs.mkdirSync(attackerGitDir);
    fs.writeFileSync(path.join(attackerGitDir, 'ATTACKER_SENTINEL'), sentinel);
    let gitCalls = 0;
    let replaced = false;
    const importer = fixture.makeImporter({
      open: tracker.open,
      close: tracker.close,
      beforeGitDirectoryDiscovery() {
        fs.renameSync(gitFile, parkedGitFile);
        fs.writeFileSync(gitFile, `gitdir: ${attackerGitDir}\n`, 'utf8');
        replaced = true;
      },
      execGit(target: any, args: string[], options: any) {
        gitCalls += 1;
        return gitBufferAtPinnedDirectory(target, args, options);
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.equal(replaced, true);
    assert.equal(gitCalls, 0, 'no Git process may observe replacement metadata');
    assert.deepEqual(fs.readFileSync(path.join(attackerGitDir, 'ATTACKER_SENTINEL')), sentinel);
    tracker.assertBalanced();
  });
});

test('preview rejects a linked-worktree .git file with multiple hard links', () => {
  withFixture((fixture) => {
    const tracker = fdTracker();
    fs.linkSync(path.join(fixture.worktree, '.git'), path.join(fixture.root, 'linked-gitfile-copy'));
    const importer = fixture.makeImporter({ open: tracker.open, close: tracker.close });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'worktree_repo_mismatch',
    );
    tracker.assertBalanced();
  });
});

test('preview descriptor-binds linked gitdir across swap and restore', () => {
  withFixture((fixture) => {
    const linkedGitDir = git(fixture.worktree, 'rev-parse', '--absolute-git-dir');
    const cleanReplacement = path.join(fixture.root, 'clean-linked-gitdir');
    const parkedOriginal = path.join(fixture.root, 'parked-linked-gitdir');
    fs.cpSync(linkedGitDir, cleanReplacement, { recursive: true });
    let swapped = false;
    const importer = fixture.makeImporter({
      open(candidate: string, flags: number) {
        const fd = fs.openSync(candidate, flags);
        if (candidate.endsWith('/commondir') && !swapped) {
          fs.writeFileSync(path.join(linkedGitDir, 'HEAD'), 'ref: refs/heads/hostile\n', 'utf8');
          fs.renameSync(linkedGitDir, parkedOriginal);
          fs.renameSync(cleanReplacement, linkedGitDir);
          swapped = true;
        }
        return fd;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input()),
      (error: any) => error?.code === 'identity_drift',
    );
  });
});

test('preview disables replace refs for ancestry and scope proofs', () => {
  withFixture((fixture) => {
    const tree = git(fixture.worktree, 'rev-parse', 'HEAD^{tree}');
    const divergent = git(fixture.repo, 'commit-tree', tree, '-m', 'divergent head');
    const replacement = git(
      fixture.repo,
      'commit-tree', tree, '-p', fixture.baseSha, '-m', 'replacement ancestor',
    );
    git(fixture.repo, 'update-ref', 'refs/heads/feat/import', divergent, fixture.headSha);
    git(fixture.repo, 'replace', divergent, replacement);
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ headSha: divergent })),
      (error: any) => error?.code === 'base_not_ancestor',
    );
  });
});

test('preview does not let a replacement tree hide scope contamination', () => {
  withFixture((fixture) => {
    fs.writeFileSync(
      path.join(fixture.worktree, 'src', 'unexpected.ts'),
      'export const unexpected = true;\n',
      'utf8',
    );
    git(fixture.worktree, 'add', 'src/unexpected.ts');
    git(fixture.worktree, 'commit', '-m', 'add unexpected file');
    const contaminatedHead = git(fixture.worktree, 'rev-parse', 'HEAD');
    const allowedTree = git(fixture.repo, 'rev-parse', `${fixture.headSha}^{tree}`);
    const replacement = git(
      fixture.repo,
      'commit-tree', allowedTree, '-p', fixture.baseSha, '-m', 'replacement clean tree',
    );
    git(fixture.repo, 'replace', contaminatedHead, replacement);
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ headSha: contaminatedHead })),
      (error: any) => error?.code === 'scope_contamination',
    );
  });
});

test('preview rejects an annotated-tag-valued origin base ref', () => {
  withFixture((fixture) => {
    git(fixture.repo, 'tag', '-a', 'annotated-base', fixture.baseSha, '-m', 'annotated base');
    const tagObject = git(fixture.repo, 'rev-parse', 'refs/tags/annotated-base');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/tagged', tagObject);
    assert.throws(
      () => fixture.importer.importContext(
        fixture.input({ baseBranch: 'tagged', baseSha: fixture.baseSha }),
      ),
      (error: any) => error?.code === 'base_mismatch',
    );
  });
});

for (const target of ['repository', 'worktree'] as const) {
  test(`preview rejects identity drift for ${target}`, () => {
    withFixture((fixture) => {
      const targetPath = target === 'repository' ? fixture.repo : fixture.worktree;
      let calls = 0;
      const importer = fixture.makeImporter({
        stat: (candidate: string) => {
          const stats = fs.statSync(candidate);
          if (candidate === targetPath && ++calls === 2) {
            return { dev: stats.dev, ino: Number(stats.ino) + 1 };
          }
          return stats;
        },
      });
      assert.throws(
        () => importer.importContext(fixture.input()),
        (error: any) => error?.code === 'identity_drift',
      );
    });
  });
}

function previewAndApply(fixture: ReturnType<typeof makeImportFixture>, overrides: any = {}) {
  const previewInput = fixture.input({ ...overrides, mode: 'preview', digest: null });
  const preview = fixture.importer.importContext(previewInput);
  const applied = fixture.importer.importContext(
    fixture.input({ ...overrides, mode: 'apply', digest: preview.digest }),
  );
  return { preview, applied };
}

test('apply atomically creates genuine task worktree and audit', () => {
  withFixture((fixture) => {
    const { preview, applied } = previewAndApply(fixture);
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.replayed, false);
    assert.equal(fixture.row('tasks', applied.taskId).kind, 'task');
    assert.equal(fixture.row('tasks', applied.taskId).primary_agent, 'codex');
    const worktree = fixture.row('worktrees', applied.worktreeId);
    assert.equal(worktree.path, fixture.worktree);
    assert.equal(worktree.branch, fixture.branch);
    assert.equal(worktree.remote_base_ref, 'origin/main');
    assert.equal(worktree.base_sha, fixture.baseSha);
    assert.equal(worktree.local_ahead_by, 1);
    const audit = fixture.row('integration_context_imports', applied.auditId, 'audit_id');
    assert.equal(audit.payload_digest, preview.digest);
    assert.equal(audit.push_url, 'https://github.com/example/context-import.git');
    assert.equal(audit.task_id, applied.taskId);
    assert.equal(audit.worktree_id, applied.worktreeId);
    assert.deepEqual(fixture.lifecycle.map((event: any) => event.type), ['run.context.imported']);
  });
});

test('apply rejects digest mismatch without writes', () => {
  withFixture((fixture) => {
    const preview = fixture.importer.importContext(fixture.input());
    const wrongDigest = `${preview.digest[0] === '0' ? '1' : '0'}${preview.digest.slice(1)}`;
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ mode: 'apply', digest: wrongDigest })),
      (error: any) => error?.code === 'digest_mismatch',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
    assert.equal(fixture.lifecycle.length, 0);
  });
});

test('apply exact replay reverifies and returns original ids', () => {
  withFixture((fixture) => {
    const { preview, applied } = previewAndApply(fixture);
    const replay = fixture.importer.importContext(
      fixture.input({ mode: 'apply', digest: preview.digest }),
    );
    assert.deepEqual(replay, { ...applied, replayed: true });
    assert.deepEqual(fixture.countRows(), { tasks: 1, worktrees: 1, audits: 1 });
    assert.equal(fixture.lifecycle.length, 1);
  });
});

test('apply exact replay rejects newly dirty worktree', () => {
  withFixture((fixture) => {
    const { preview } = previewAndApply(fixture);
    fs.writeFileSync(path.join(fixture.worktree, 'dirty-after-apply.txt'), 'dirty\n');
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'dirty_worktree',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 1, worktrees: 1, audits: 1 });
    assert.equal(fixture.lifecycle.length, 1);
  });
});

test('apply rejects request conflict after reverified payload change', () => {
  withFixture((fixture) => {
    previewAndApply(fixture);
    fs.writeFileSync(path.join(fixture.worktree, 'src', 'second.ts'), 'export const second = true;\n');
    git(fixture.worktree, 'add', 'src/second.ts');
    git(fixture.worktree, 'commit', '-m', 'second allowed file');
    const headSha = git(fixture.worktree, 'rev-parse', 'HEAD');
    const changed = { headSha, allowedPaths: ['src/allowed.ts', 'src/second.ts'] };
    const preview = fixture.importer.importContext(fixture.input({ ...changed, mode: 'preview' }));
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ ...changed, mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'request_conflict',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 1, worktrees: 1, audits: 1 });
  });
});

test('apply rejects registration conflict for another request', () => {
  withFixture((fixture) => {
    previewAndApply(fixture);
    const preview = fixture.importer.importContext(fixture.input({ requestId: 'req-2' }));
    assert.throws(
      () => fixture.importer.importContext(
        fixture.input({ requestId: 'req-2', mode: 'apply', digest: preview.digest }),
      ),
      (error: any) => error?.code === 'registration_conflict',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 1, worktrees: 1, audits: 1 });
  });
});

test('apply rejects registration conflict for claimed worktree path', () => {
  withFixture((fixture) => {
    fixture.insertWorktreeClaim(fixture.worktree, 'feat/existing');
    const before = fixture.countRows();
    const preview = fixture.importer.importContext(fixture.input());
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'registration_conflict',
    );
    assert.deepEqual(fixture.countRows(), before);
  });
});

test('apply rejects registration conflict for claimed workspace branch', () => {
  withFixture((fixture) => {
    fixture.insertWorktreeClaim(path.join(fixture.root, 'other-path'), fixture.branch);
    const before = fixture.countRows();
    const preview = fixture.importer.importContext(fixture.input());
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'registration_conflict',
    );
    assert.deepEqual(fixture.countRows(), before);
  });
});

test('apply rolls back task and worktree when audit insert fails', () => {
  withFixture((fixture) => {
    fixture.db.exec(`
      CREATE TRIGGER integration_context_imports_fail_insert
      BEFORE INSERT ON integration_context_imports BEGIN
        SELECT RAISE(ABORT, 'injected audit failure');
      END;
    `);
    const preview = fixture.importer.importContext(fixture.input());
    assert.throws(
      () => fixture.importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      /injected audit failure/,
    );
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
    assert.equal(fixture.lifecycle.length, 0);
  });
});

test('context import audit is immutable', () => {
  withFixture((fixture) => {
    const { applied } = previewAndApply(fixture);
    assert.throws(
      () => fixture.db.prepare(
        'UPDATE integration_context_imports SET head_sha = ? WHERE audit_id = ?',
      ).run(fixture.baseSha, applied.auditId),
      /immutable/,
    );
    assert.throws(
      () => fixture.db.prepare('DELETE FROM integration_context_imports WHERE audit_id = ?')
        .run(applied.auditId),
      /immutable/,
    );
  });
});

test('apply rejects identity drift immediately before writes', () => {
  withFixture((fixture) => {
    const preview = fixture.importer.importContext(fixture.input());
    let calls = 0;
    const importer = fixture.makeImporter({
      stat: (candidate: string) => {
        const stats = fs.statSync(candidate);
        if (candidate === fixture.worktree && ++calls === 3) {
          return { dev: stats.dev, ino: Number(stats.ino) + 1 };
        }
        return stats;
      },
    });
    assert.throws(
      () => importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'identity_drift',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 0, worktrees: 0, audits: 0 });
  });
});

test('apply surfaces projection failure and exact replay delivers it once', () => {
  withFixture((fixture) => {
    let shouldFail = true;
    const importer = fixture.makeImporter({
      appendLifecycle: (event: any) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('injected projection failure');
        }
        if (!fixture.lifecycle.some((entry: any) => entry.eventId === event.eventId)) {
          fixture.lifecycle.push(event);
        }
      },
    });
    const preview = importer.importContext(fixture.input());
    assert.throws(
      () => importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.deepEqual(fixture.countRows(), { tasks: 1, worktrees: 1, audits: 1 });
    assert.equal(fixture.lifecycle.length, 0);
    const replay = importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest }));
    assert.equal(replay.replayed, true);
    assert.equal(fixture.lifecycle.length, 1);
    importer.importContext(fixture.input({ mode: 'apply', digest: preview.digest }));
    assert.equal(fixture.lifecycle.length, 1);
  });
});

test('store lifecycle append failure recovers idempotently on exact replay', async () => {
  const fixture = makeImportFixture();
  const userDataPath = path.join(fixture.root, 'projection-store-data');
  const store = createAceStore(userDataPath, {
    Database: BetterSqlite3NodeShim,
    ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
  });
  try {
    const workspaceId = 'prj_projection_replay';
    const db = store.getDb();
    db.prepare(
      `INSERT INTO projects
       (id, name, path, is_remote, default_branch, github_repo, initialized,
        order_index, created_at, updated_at)
       VALUES (?, 'Projection Replay', ?, 0, 'main', 'example/context-import', 1, 0, ?, ?)`,
    ).run(
      workspaceId,
      fixture.repo,
      '2026-08-04T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );
    const input = (extra: any = {}) => fixture.input({ workspaceId, ...extra });
    const preview = store.integrationContextImport(input());
    const acePath = path.join(fixture.repo, '.ace');
    fs.writeFileSync(acePath, 'blocks lifecycle directory\n', 'utf8');
    assert.throws(
      () => store.integrationContextImport(input({ mode: 'apply', digest: preview.digest })),
      (error: any) => error?.code === 'projection_failed',
    );
    const audit = db.prepare(
      'SELECT * FROM integration_context_imports WHERE request_id = ?',
    ).get('req-1');
    assert.ok(audit, 'committed immutable audit survives projection failure');
    fs.unlinkSync(acePath);
    const replay = store.integrationContextImport(input({ mode: 'apply', digest: preview.digest }));
    assert.equal(replay.replayed, true);
    store.integrationContextImport(input({ mode: 'apply', digest: preview.digest }));
    const events = fs.readFileSync(path.join(acePath, 'events.ndjson'), 'utf8')
      .trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(events.filter((event: any) => event.eventId === audit.audit_id).length, 1);
  } finally {
    try { await store.shutdown(); } catch {}
    fixture.cleanup();
  }
});

function makePendingProjectionFixture(label: string, testHooks: any = {}) {
  const fixture = makeImportFixture();
  const userDataPath = path.join(fixture.root, `projection-${label}-store-data`);
  const store = createAceStore(userDataPath, {
    Database: BetterSqlite3NodeShim,
    ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
    ...testHooks,
  });
  const workspaceId = `prj_projection_${label}`;
  const db = store.getDb();
  db.prepare(
    `INSERT INTO projects
     (id, name, path, is_remote, default_branch, github_repo, initialized,
      order_index, created_at, updated_at)
     VALUES (?, 'Projection Security', ?, 0, 'main', 'example/context-import', 1, 0, ?, ?)`,
  ).run(
    workspaceId,
    fixture.repo,
    '2026-08-04T00:00:00.000Z',
    '2026-08-04T00:00:00.000Z',
  );
  const input = (extra: any = {}) => fixture.input({ workspaceId, ...extra });
  const preview = store.integrationContextImport(input());
  const acePath = path.join(fixture.repo, '.ace');
  fs.writeFileSync(acePath, 'blocks lifecycle directory\n', 'utf8');
  assert.throws(
    () => store.integrationContextImport(input({ mode: 'apply', digest: preview.digest })),
    (error: any) => error?.code === 'projection_failed',
  );
  const audit = db.prepare(
    'SELECT * FROM integration_context_imports WHERE request_id = ?',
  ).get('req-1');
  assert.ok(audit);
  fs.unlinkSync(acePath);
  return { fixture, userDataPath, store, db, input, preview, acePath, audit };
}

async function cleanupProjectionFixture(context: any, extraStores: any[] = []) {
  for (const store of [context.store, ...extraStores]) {
    try { await store.shutdown(); } catch {}
  }
  context.fixture.cleanup();
}

test('overlapping exact replays serialize through durable projection status', async () => {
  let overlapArmed = false;
  let overlapAttempts = 0;
  let overlapError: any = null;
  let secondStore: any = null;
  let replayInput: any = null;
  const context = makePendingProjectionFixture('overlap', {
    contextImportProjectionBeforeAppend: () => {
      if (!overlapArmed) return;
      overlapArmed = false;
      overlapAttempts += 1;
      try { secondStore.integrationContextImport(replayInput); } catch (error) { overlapError = error; }
    },
  });
  try {
    secondStore = createAceStore(context.userDataPath, {
      Database: BetterSqlite3NodeShim,
      ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    replayInput = context.input({ mode: 'apply', digest: context.preview.digest });
    overlapArmed = true;
    const replay = context.store.integrationContextImport(replayInput);
    assert.equal(replay.replayed, true);
    assert.equal(overlapAttempts, 1, 'second store must overlap the pending delivery');
    assert.ok(overlapError, 'overlapping writer must fail closed while delivery is serialized');
    const secondReplay = secondStore.integrationContextImport(replayInput);
    assert.equal(secondReplay.replayed, true);
    const events = fs.readFileSync(path.join(context.acePath, 'events.ndjson'), 'utf8')
      .trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(events.filter((event: any) => event.eventId === context.audit.audit_id).length, 1);
    const projection = context.db.prepare(
      'SELECT delivered_at FROM integration_context_import_projections WHERE audit_id = ?',
    ).get(context.audit.audit_id);
    assert.ok(projection?.delivered_at);
  } finally {
    await cleanupProjectionFixture(context, secondStore ? [secondStore] : []);
  }
});

test('projection replay rejects a hard link added after the bounded lifecycle read', async () => {
  let linkedPath = '';
  let attackerPath = '';
  const context = makePendingProjectionFixture('hardlink-race', {
    contextImportLifecycleAfterRead: ({ eventPath }: any) => {
      linkedPath = eventPath;
      fs.linkSync(eventPath, attackerPath);
    },
  });
  try {
    fs.mkdirSync(context.acePath);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    attackerPath = path.join(context.fixture.root, 'hardlinked-events.ndjson');
    fs.writeFileSync(eventsPath, `${JSON.stringify({ eventId: 'existing-event' })}\n`, 'utf8');
    assert.throws(
      () => context.store.integrationContextImport(
        context.input({ mode: 'apply', digest: context.preview.digest }),
      ),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.equal(linkedPath.endsWith('/events.ndjson'), true);
    assert.equal(fs.statSync(eventsPath).nlink, 2);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay rejects a same-size rewrite after the bounded lifecycle read', async () => {
  let replacementPath = '';
  const context = makePendingProjectionFixture('same-size-race', {
    contextImportLifecycleAfterRead: ({ eventPath }: any) => {
      replacementPath = eventPath;
      fs.writeFileSync(eventPath, `${JSON.stringify({ eventId: 'attacker-event' })}\n`, 'utf8');
    },
  });
  try {
    fs.mkdirSync(context.acePath);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    const original = `${JSON.stringify({ eventId: 'existing-event' })}\n`;
    const replacement = `${JSON.stringify({ eventId: 'attacker-event' })}\n`;
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
    fs.writeFileSync(eventsPath, original, 'utf8');
    assert.throws(
      () => context.store.integrationContextImport(
        context.input({ mode: 'apply', digest: context.preview.digest }),
      ),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.equal(replacementPath.endsWith('/events.ndjson'), true);
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), replacement);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay verifies exact post-fsync lifecycle bytes before delivery', async () => {
  let tampered = false;
  const context = makePendingProjectionFixture('post-fsync-rewrite', {
    contextImportLifecycleAfterFsync: ({ eventPath, line, offset }: any) => {
      const replacement = Buffer.from(line);
      replacement[0] = replacement[0] === 0x7b ? 0x5b : 0x7b;
      const fd = fs.openSync(eventPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        assert.equal(fs.writeSync(fd, replacement, 0, replacement.length, offset), replacement.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      tampered = true;
    },
  });
  try {
    const replayInput = context.input({ mode: 'apply', digest: context.preview.digest });
    assert.throws(
      () => context.store.integrationContextImport(replayInput),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.equal(tampered, true);
    const projection = context.db.prepare(
      'SELECT delivered_at FROM integration_context_import_projections WHERE audit_id = ?',
    ).get(context.audit.audit_id);
    assert.equal(projection?.delivered_at == null, true);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('identical replay repairs only its own strict partial lifecycle line', async () => {
  let writeCalls = 0;
  let intendedLine: Buffer | null = null;
  const context = makePendingProjectionFixture('partial-line-recovery', {
    contextImportLifecycleWrite: (
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      writeCalls += 1;
      if (writeCalls === 1) {
        intendedLine = Buffer.from(buffer.subarray(offset, offset + length));
        const shortLength = Math.max(1, Math.floor(length / 2));
        return fs.writeSync(fd, buffer, offset, shortLength, position);
      }
      if (writeCalls === 2) throw new Error('injected lifecycle write failure');
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  });
  try {
    const replayInput = context.input({ mode: 'apply', digest: context.preview.digest });
    assert.throws(
      () => context.store.integrationContextImport(replayInput),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.ok(intendedLine);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    const partial = fs.readFileSync(eventsPath);
    assert.ok(partial.length > 0 && partial.length < intendedLine!.length);
    assert.equal(partial.equals(intendedLine!.subarray(0, partial.length)), true);

    assert.equal(context.store.integrationContextImport(replayInput).replayed, true);
    assert.equal(context.store.integrationContextImport(replayInput).replayed, true);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).eventId, context.audit.audit_id);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('identical replay fsyncs a complete pending lifecycle line before delivery', async () => {
  let fsyncCalls = 0;
  const context = makePendingProjectionFixture('fsync-recovery', {
    contextImportLifecycleFsync: (fd: number) => {
      fsyncCalls += 1;
      if (fsyncCalls === 1) throw new Error('injected lifecycle fsync failure');
      return fs.fsyncSync(fd);
    },
  });
  try {
    const replayInput = context.input({ mode: 'apply', digest: context.preview.digest });
    assert.throws(
      () => context.store.integrationContextImport(replayInput),
      (error: any) => error?.code === 'projection_failed',
    );
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    const pendingLines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(pendingLines.length, 1);
    assert.equal(JSON.parse(pendingLines[0]).eventId, context.audit.audit_id);

    assert.equal(context.store.integrationContextImport(replayInput).replayed, true);
    assert.equal(context.store.integrationContextImport(replayInput).replayed, true);
    assert.ok(fsyncCalls >= 2);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).eventId, context.audit.audit_id);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay rejects an events file symlink without touching its target', async () => {
  const context = makePendingProjectionFixture('symlink');
  try {
    fs.mkdirSync(context.acePath);
    const attackerPath = path.join(context.fixture.root, 'attacker-events.ndjson');
    const original = `${JSON.stringify({ eventId: 'attacker-event' })}\n`;
    fs.writeFileSync(attackerPath, original, 'utf8');
    fs.symlinkSync(attackerPath, path.join(context.acePath, 'events.ndjson'));
    assert.throws(
      () => context.store.integrationContextImport(
        context.input({ mode: 'apply', digest: context.preview.digest }),
      ),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.equal(fs.readFileSync(attackerPath, 'utf8'), original);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay rejects malformed or truncated existing events fail closed', async () => {
  const context = makePendingProjectionFixture('malformed');
  try {
    fs.mkdirSync(context.acePath);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    fs.writeFileSync(eventsPath, '{"eventId":"truncated"', 'utf8');
    assert.throws(
      () => context.store.integrationContextImport(
        context.input({ mode: 'apply', digest: context.preview.digest }),
      ),
      (error: any) => error?.code === 'projection_failed'
        && !String(error.message).includes('JSON'),
    );
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), '{"eventId":"truncated"');
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay rejects an over-limit lifecycle file before append', async () => {
  const context = makePendingProjectionFixture('oversize');
  try {
    fs.mkdirSync(context.acePath);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    const oversized = JSON.stringify({ eventId: 'other', padding: 'x'.repeat(4 * 1024 * 1024) });
    fs.writeFileSync(eventsPath, `${oversized}\n`, 'utf8');
    assert.throws(
      () => context.store.integrationContextImport(
        context.input({ mode: 'apply', digest: context.preview.digest }),
      ),
      (error: any) => error?.code === 'projection_failed',
    );
    assert.equal(fs.statSync(eventsPath).size, Buffer.byteLength(`${oversized}\n`));
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection lifecycle event open is nonblocking before file-type validation', async () => {
  const openFlags: number[] = [];
  const context = makePendingProjectionFixture('nonblocking-open', {
    contextImportLifecycleEventsOpen: (flags: number) => openFlags.push(flags),
  });
  try {
    const replay = context.store.integrationContextImport(
      context.input({ mode: 'apply', digest: context.preview.digest }),
    );
    assert.equal(replay.replayed, true);
    assert.equal(openFlags.length, 1);
    assert.notEqual(openFlags[0] & fs.constants.O_NONBLOCK, 0);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('projection replay rejects an events FIFO promptly without blocking open', async () => {
  const context = makePendingProjectionFixture('fifo');
  try {
    await context.store.shutdown();
    fs.mkdirSync(context.acePath);
    const eventsPath = path.join(context.acePath, 'events.ndjson');
    childProcess.execFileSync('/usr/bin/mkfifo', [eventsPath]);
    const replayInput = context.input({ mode: 'apply', digest: context.preview.digest });
    const childScript = [
      "const {createAceStore}=require('./electron/local-core.cjs')",
      "const {BetterSqlite3NodeShim}=require('./electron/__tests__/helpers/better-sqlite3-node-shim.cts')",
      "const store=createAceStore(process.env.ACE_FIFO_USER_DATA,{Database:BetterSqlite3NodeShim,ptyImpl:{spawn(){throw new Error('unexpected pty spawn')}}})",
      "setTimeout(()=>{try{store.integrationContextImport(JSON.parse(process.env.ACE_FIFO_INPUT));process.exit(2)}catch(error){process.exit(error?.code==='projection_failed'?0:3)}},500)",
    ].join(';');
    const result = childProcess.spawnSync(
      process.execPath,
      ['--require', 'tsx/cjs', '-e', childScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ACE_FIFO_USER_DATA: context.userDataPath,
          ACE_FIFO_INPUT: JSON.stringify(replayInput),
        },
        timeout: 10_000,
        encoding: 'utf8',
      },
    );
    assert.equal(result.error, undefined, `FIFO replay blocked or failed to launch: ${result.error}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await cleanupProjectionFixture(context);
  }
});

test('task deletion preserves audit evidence and rejects replay without mutable context', async () => {
  const fixture = makeImportFixture();
  const userDataPath = path.join(fixture.root, 'store-data');
  const store = createAceStore(userDataPath, {
    Database: BetterSqlite3NodeShim,
    ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
  });
  try {
    const workspaceId = 'prj_store_context_import';
    const db = store.getDb();
    db.prepare(
      `INSERT INTO projects
       (id, name, path, is_remote, default_branch, github_repo, initialized,
        order_index, created_at, updated_at)
       VALUES (?, 'Context Import', ?, 0, 'main', 'example/context-import', 1, 0, ?, ?)`,
    ).run(
      workspaceId,
      fixture.repo,
      '2026-08-04T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );
    const preview = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'preview', digest: null }),
    );
    const applied = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'apply', digest: preview.digest }),
    );
    const originalAudit = db.prepare(
      'SELECT * FROM integration_context_imports WHERE audit_id = ?',
    ).get(applied.auditId);

    await store.archiveTask({ taskId: applied.taskId });
    assert.ok(db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(applied.taskId).archived_at);
    assert.deepEqual(
      db.prepare('SELECT * FROM integration_context_imports WHERE audit_id = ?').get(applied.auditId),
      originalAudit,
    );

    await store.deleteTask({
      taskId: applied.taskId,
      deleteLocalBranch: false,
      deleteRemoteBranch: false,
      removeWorktree: false,
    });
    assert.equal(db.prepare('SELECT * FROM tasks WHERE id = ?').get(applied.taskId), undefined);
    assert.equal(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(applied.worktreeId), undefined);
    assert.deepEqual(
      db.prepare('SELECT * FROM integration_context_imports WHERE audit_id = ?').get(applied.auditId),
      originalAudit,
    );
    assert.throws(
      () => store.integrationContextImport(
        fixture.input({ workspaceId, mode: 'apply', digest: preview.digest }),
      ),
      (error: any) => error?.code === 'replay_context_mismatch',
    );
  } finally {
    try { await store.shutdown(); } catch {}
    fixture.cleanup();
  }
});

test('imported-task push uses immutable attested URL after live config and hostile-env mutation', async () => {
  const fixture = makeImportFixture();
  const userDataPath = path.join(fixture.root, 'bound-push-store-data');
  const spawned: any[] = [];
  const nonce = 'fixed-public-seam-nonce';
  const gatewayFactory = (options: any) => createIntegrationGateway({
    ...options,
    newPushNonce: () => nonce,
    execFileImpl(bin: string, args: string[], opts: any, callback: any) {
      spawned.push({ bin, args: [...args], opts });
      process.nextTick(() => callback(null, 'captured\n', ''));
    },
  });
  const store = createAceStore(userDataPath, {
    Database: BetterSqlite3NodeShim,
    ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
    createIntegrationGateway: gatewayFactory,
  });
  const hostileKeys = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  ];
  const prior = new Map<string, string | undefined>();
  try {
    const workspaceId = 'prj_bound_context_push';
    const db = store.getDb();
    db.prepare(
      `INSERT INTO projects
       (id, name, path, is_remote, default_branch, github_repo, initialized,
        order_index, created_at, updated_at)
       VALUES (?, 'Bound Push Import', ?, 0, 'main', 'example/context-import', 1, 0, ?, ?)`,
    ).run(
      workspaceId,
      fixture.repo,
      '2026-08-04T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );
    const preview = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'preview', digest: null }),
    );
    const applied = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'apply', digest: preview.digest }),
    );
    const audit = db.prepare(
      'SELECT push_url FROM integration_context_imports WHERE audit_id = ?',
    ).get(applied.auditId);
    assert.equal(audit.push_url, 'https://github.com/example/context-import.git');

    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    git(
      fixture.worktree,
      'config', '--worktree', 'remote.origin.pushurl',
      'git@github.com:attacker/live-config-redirect.git',
    );
    git(
      fixture.worktree,
      'config', '--worktree',
      'url.git@github.com:attacker/live-rewrite.git.pushInsteadOf',
      'https://ace.invalid/context-import/',
    );
    const syntheticUrl = `https://ace.invalid/context-import/${nonce}`;
    const hostileValues: Record<string, string> = {
      GIT_DIR: '/hostile/git-dir',
      GIT_WORK_TREE: '/hostile/work-tree',
      GIT_COMMON_DIR: '/hostile/common-dir',
      GIT_INDEX_FILE: '/hostile/index',
      GIT_CONFIG: '/hostile/config',
      GIT_CONFIG_GLOBAL: '/hostile/global-config',
      GIT_CONFIG_SYSTEM: '/hostile/system-config',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.git@github.com:attacker/env-redirect.git.pushInsteadOf',
      GIT_CONFIG_VALUE_0: syntheticUrl,
    };
    for (const key of hostileKeys) {
      prior.set(key, process.env[key]);
      process.env[key] = hostileValues[key];
    }

    const result = await store.integrationPush({ taskId: applied.taskId });
    assert.equal(result.ok, true);
    assert.equal(spawned.length, 1);
    const invocation = spawned[0];
    assert.equal(invocation.bin, 'git');
    assert.deepEqual(invocation.args, [
      '-c', `url.${audit.push_url}.pushInsteadOf=${syntheticUrl}`,
      'push', syntheticUrl, fixture.branch,
    ]);
    assert.ok(!invocation.args.includes('origin'));
    assert.ok(!invocation.args.some((arg: string) => arg.includes('attacker')));
    for (const key of hostileKeys) assert.equal(invocation.opts.env[key], undefined, `${key} must be scrubbed`);

    const pushProofRoot = path.join(fixture.root, 'push-routing-proof');
    const boundBare = path.join(pushProofRoot, 'bound.git');
    const attackerBare = path.join(pushProofRoot, 'attacker.git');
    fs.mkdirSync(pushProofRoot);
    childProcess.execFileSync('git', ['init', '--bare', boundBare], { env: GIT_ENV, stdio: 'ignore' });
    childProcess.execFileSync('git', ['init', '--bare', attackerBare], { env: GIT_ENV, stdio: 'ignore' });
    const pushProofSynthetic = 'https://ace.invalid/context-import/push-proof-nonce';
    childProcess.execFileSync(
      'git',
      [
        '-c', `url.${attackerBare}.pushInsteadOf=https://ace.invalid/context-import/`,
        '-c', `url.${boundBare}.pushInsteadOf=${pushProofSynthetic}`,
        'push', pushProofSynthetic, 'HEAD:refs/heads/push-proof',
      ],
      { cwd: fixture.worktree, env: invocation.opts.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.doesNotThrow(() => git(boundBare, 'show-ref', '--verify', 'refs/heads/push-proof'));
    assert.throws(
      () => git(attackerBare, 'show-ref', '--verify', 'refs/heads/push-proof'),
      /fatal:/,
      'hostile namespace prefix must not receive the exact synthetic push',
    );
  } finally {
    for (const key of hostileKeys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await store.shutdown(); } catch {}
    fixture.cleanup();
  }
});

test('imported task integration context reaches existing gateway entry points unchanged', async () => {
  const fixture = makeImportFixture();
  const userDataPath = path.join(fixture.root, 'gateway-store-data');
  const gatewayContexts: any[] = [];
  const gatewayCalls: any[] = [];
  const refreshCalls: string[] = [];
  const gatewayFactory = (options: any) => {
    gatewayContexts.push(options);
    const gateway = new EventEmitter() as any;
    gateway.push = async (params: any) => { gatewayCalls.push(['push', params]); return { ok: true }; };
    gateway.openPr = async (params: any) => { gatewayCalls.push(['open', params]); return { ok: false, result: {} }; };
    gateway.gatePr = async (params: any) => { gatewayCalls.push(['gate', params]); return { ok: true }; };
    gateway.mergePr = async (params: any) => { gatewayCalls.push(['merge', params]); return { ok: true }; };
    return gateway;
  };
  const store = createAceStore(userDataPath, {
    Database: BetterSqlite3NodeShim,
    ptyImpl: { spawn() { throw new Error('unexpected pty spawn'); } },
    createIntegrationGateway: gatewayFactory,
    refreshWorkspaceMeta: async (workspaceId: string) => { refreshCalls.push(workspaceId); },
  });
  const oldPath = process.env.PATH;
  try {
    const workspaceId = 'prj_gateway_context_import';
    store.getDb().prepare(
      `INSERT INTO projects
       (id, name, path, is_remote, default_branch, github_repo, initialized,
        order_index, created_at, updated_at)
       VALUES (?, 'Gateway Import', ?, 0, 'main', 'example/context-import', 1, 0, ?, ?)`,
    ).run(
      workspaceId,
      fixture.repo,
      '2026-08-04T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );
    const preview = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'preview', digest: null }),
    );
    const applied = await store.integrationContextImport(
      fixture.input({ workspaceId, mode: 'apply', digest: preview.digest }),
    );
    const context = store.getTaskIntegrationContext(applied.taskId);
    assert.deepEqual(context, {
      taskId: applied.taskId,
      projectId: workspaceId,
      cwd: fixture.worktree,
      repoCwd: fixture.repo,
      branch: fixture.branch,
      baseBranch: 'main',
      worktreePath: fixture.worktree,
    });
    for (const name of ['integrationPush', 'integrationOpenPr', 'integrationGate', 'integrationMergePr']) {
      assert.equal(typeof store[name], 'function');
    }

    const fakeBin = path.join(fixture.root, 'fail-closed-bin');
    fs.mkdirSync(fakeBin);
    for (const command of ['git', 'gh']) {
      const executable = path.join(fakeBin, command);
      fs.writeFileSync(executable, '#!/bin/sh\nexit 77\n', 'utf8');
      fs.chmodSync(executable, 0o755);
    }
    process.env.PATH = fakeBin;

    await store.integrationPush({ taskId: applied.taskId });
    assert.equal(gatewayContexts.length, 1, 'push must use the injected safe gateway');
    await store.integrationOpenPr({
      taskId: applied.taskId,
      title: 'Imported context',
      body: 'test',
      allowedPaths: ['src/allowed.ts'],
    });
    await store.integrationGate({
      taskId: applied.taskId,
      prNumber: 7,
      allowedPaths: ['src/allowed.ts'],
    });
    await store.integrationMergePr({
      taskId: applied.taskId,
      prNumber: 7,
      allowedPaths: ['src/allowed.ts'],
    });

    assert.equal(gatewayContexts.length, 4);
    for (const options of gatewayContexts) {
      assert.equal(options.cwd, fixture.worktree);
      assert.equal(options.repoCwd, fixture.repo);
    }
    assert.deepEqual(gatewayCalls.map(([name]: any[]) => name), ['push', 'open', 'gate', 'merge']);
    assert.equal(gatewayCalls[0][1].branch, fixture.branch);
    assert.equal(gatewayCalls[1][1].base, 'main');
    assert.equal(gatewayCalls[1][1].head, fixture.branch);
    assert.equal(gatewayCalls[2][1].worktreePath, fixture.worktree);
    assert.equal(gatewayCalls[2][1].gate.expectedBaseBranch, 'main');
    assert.equal(gatewayCalls[3][1].worktreePath, fixture.worktree);
    assert.equal(gatewayCalls[3][1].gate.expectedBaseBranch, 'main');
    assert.deepEqual(refreshCalls, [workspaceId]);
  } finally {
    if (oldPath == null) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try { await store.shutdown(); } catch {}
    fixture.cleanup();
  }
});
