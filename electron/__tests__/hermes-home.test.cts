import { test } from 'vitest';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  baseHermesHome,
  workspaceHermesHome,
  ensureHermesHomeForWorkspace,
  ensureIdentityHermesHome,
  ensureBundledAceSkill,
  configWithMemoryDbPath,
  seedBundledSkill,
  SHARED_ENTRIES,
} = require('../hermes-home.cts');

function makeTmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hhome-test-'));
}

function seedBase(userDataPath, { files = {}, dirs = [] } = {}) {
  const base = baseHermesHome(userDataPath);
  fs.mkdirSync(base, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(base, name), contents);
  }
  for (const name of dirs) fs.mkdirSync(path.join(base, name), { recursive: true });
  return base;
}

test('baseHermesHome + workspaceHermesHome compute expected paths', () => {
  assert.equal(baseHermesHome('/u'), '/u/hermes-home');
  assert.equal(workspaceHermesHome('/u', 'ws-a'), '/u/hermes-home-ws-a');
});

test('workspaceHermesHome sanitizes unsafe chars in workspaceId', () => {
  assert.equal(
    workspaceHermesHome('/u', 'ws/../evil'),
    '/u/hermes-home-ws_.._evil'
  );
  assert.equal(workspaceHermesHome('/u', 'a b c'), '/u/hermes-home-a_b_c');
});

test('ensureHermesHomeForWorkspace: creates dir and symlinks every shared entry that exists', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, {
      files: { 'auth.json': '{}', 'config.yaml': 'y', 'SOUL.md': 's', '.env': '' },
      dirs: ['skills', 'bin'],
    });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'ws-alpha');
    assert.equal(wsHome, path.join(ud, 'hermes-home-ws-alpha'));
    for (const name of ['auth.json', 'config.yaml', 'SOUL.md', '.env', 'skills', 'bin']) {
      const linkPath = path.join(wsHome, name);
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), `${name} should be a symlink`);
      assert.equal(
        fs.readlinkSync(linkPath),
        path.join(baseHermesHome(ud), name),
        `${name} symlink should point at base`
      );
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: skips shared entries the base does not have', () => {
  const ud = makeTmpUserData();
  try {
    // Only seed auth.json; the rest should simply be skipped, not error.
    seedBase(ud, { files: { 'auth.json': '{}' } });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'ws-partial');
    assert.ok(fs.lstatSync(path.join(wsHome, 'auth.json')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(wsHome, 'config.yaml')), true, 'config.yaml should be repaired');
    for (const missing of ['skills', 'bin', 'vendor', 'SOUL.md']) {
      assert.equal(fs.existsSync(path.join(wsHome, missing)), false, `${missing} should not exist`);
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: state.db stays per-workspace (NOT symlinked)', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{}', 'state.db': 'SHARED-DB' } });
    const a = ensureHermesHomeForWorkspace(ud, 'ws-a');
    const b = ensureHermesHomeForWorkspace(ud, 'ws-b');
    // No state.db file or symlink in either workspace yet — each starts fresh.
    assert.equal(fs.existsSync(path.join(a, 'state.db')), false);
    assert.equal(fs.existsSync(path.join(b, 'state.db')), false);
    // Writes to ws-a's state.db must not leak to ws-b or the base.
    fs.writeFileSync(path.join(a, 'state.db'), 'alpha');
    fs.writeFileSync(path.join(b, 'state.db'), 'bravo');
    assert.equal(fs.readFileSync(path.join(a, 'state.db'), 'utf8'), 'alpha');
    assert.equal(fs.readFileSync(path.join(b, 'state.db'), 'utf8'), 'bravo');
    assert.equal(
      fs.readFileSync(path.join(baseHermesHome(ud), 'state.db'), 'utf8'),
      'SHARED-DB',
      'base state.db must be untouched'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: idempotent — re-running leaves good symlinks alone', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{}' }, dirs: ['skills'] });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'ws-idem');
    const firstInode = fs.lstatSync(path.join(wsHome, 'auth.json')).ino;
    // Call again.
    ensureHermesHomeForWorkspace(ud, 'ws-idem');
    const secondInode = fs.lstatSync(path.join(wsHome, 'auth.json')).ino;
    assert.equal(firstInode, secondInode, 'symlink should not have been replaced');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: repairs a stale symlink whose target changed', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{}' } });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'ws-stale');
    // Replace the good symlink with one pointing at a bogus path.
    const linkPath = path.join(wsHome, 'auth.json');
    fs.unlinkSync(linkPath);
    fs.symlinkSync('/tmp/does-not-exist', linkPath);
    // Re-run: should detect wrong target and repair.
    ensureHermesHomeForWorkspace(ud, 'ws-stale');
    assert.equal(
      fs.readlinkSync(linkPath),
      path.join(baseHermesHome(ud), 'auth.json')
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: preserves a real file at the dst (does not overwrite user data)', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{"shared":true}' } });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'ws-override');
    // User manually replaced the symlink with a real file — maybe they want
    // a per-workspace override. Must not be overwritten on subsequent calls.
    fs.unlinkSync(path.join(wsHome, 'auth.json'));
    fs.writeFileSync(path.join(wsHome, 'auth.json'), '{"override":true}');
    ensureHermesHomeForWorkspace(ud, 'ws-override');
    assert.equal(
      fs.readFileSync(path.join(wsHome, 'auth.json'), 'utf8'),
      '{"override":true}'
    );
    assert.equal(fs.lstatSync(path.join(wsHome, 'auth.json')).isSymbolicLink(), false);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureHermesHomeForWorkspace: no workspaceId → returns base (no isolation)', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, {});
    assert.equal(ensureHermesHomeForWorkspace(ud, ''), baseHermesHome(ud));
    assert.equal(ensureHermesHomeForWorkspace(ud, null), baseHermesHome(ud));
    assert.equal(ensureHermesHomeForWorkspace(ud, undefined), baseHermesHome(ud));
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureIdentityHermesHome: replaces stale shared auth symlink with fresher local auth copy', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{"base":"old"}' } });
    const freshAuth = path.join(ud, 'local-auth.json');
    fs.writeFileSync(freshAuth, '{"local":"fresh"}');
    fs.utimesSync(path.join(baseHermesHome(ud), 'auth.json'), new Date(1000), new Date(1000));
    fs.utimesSync(freshAuth, new Date(2000), new Date(2000));

    const wsHome = ensureIdentityHermesHome(ud, 'prj-king', {
      identity: 'king',
      authCandidatePaths: [freshAuth],
      includeDefaultAuthCandidates: false,
    });
    const authPath = path.join(wsHome, 'auth.json');
    assert.equal(fs.lstatSync(authPath).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(authPath, 'utf8'), '{"local":"fresh"}');
    assert.equal(fs.readFileSync(path.join(baseHermesHome(ud), 'auth.json'), 'utf8'), '{"base":"old"}');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureIdentityHermesHome: preserves an existing real identity auth file', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{"base":"old"}' } });
    const wsHome = ensureHermesHomeForWorkspace(ud, 'prj-rook');
    fs.unlinkSync(path.join(wsHome, 'auth.json'));
    fs.writeFileSync(path.join(wsHome, 'auth.json'), '{"identity":"keep"}');
    const freshAuth = path.join(ud, 'local-auth.json');
    fs.writeFileSync(freshAuth, '{"local":"fresh"}');

    ensureIdentityHermesHome(ud, 'prj-rook', {
      identity: 'rook',
      authCandidatePaths: [freshAuth],
      includeDefaultAuthCandidates: false,
    });
    assert.equal(fs.readFileSync(path.join(wsHome, 'auth.json'), 'utf8'), '{"identity":"keep"}');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('two workspaces get independent state.db + sessions dirs', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{}' }, dirs: ['skills'] });
    const a = ensureHermesHomeForWorkspace(ud, 'ws-a');
    const b = ensureHermesHomeForWorkspace(ud, 'ws-b');
    // Per-workspace writes isolated.
    fs.writeFileSync(path.join(a, 'sessions', 's1.json'), 'alpha-session');
    fs.writeFileSync(path.join(b, 'sessions', 's1.json'), 'bravo-session');
    assert.equal(
      fs.readFileSync(path.join(a, 'sessions', 's1.json'), 'utf8'),
      'alpha-session'
    );
    assert.equal(
      fs.readFileSync(path.join(b, 'sessions', 's1.json'), 'utf8'),
      'bravo-session'
    );
    // But they share skills via the symlink.
    assert.equal(
      fs.readlinkSync(path.join(a, 'skills')),
      path.join(baseHermesHome(ud), 'skills')
    );
    assert.equal(
      fs.readlinkSync(path.join(b, 'skills')),
      path.join(baseHermesHome(ud), 'skills')
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureBundledAceSkill: seeds ace-task-worker into the shared hermes skill dir', () => {
  const ud = makeTmpUserData();
  try {
    ensureBundledAceSkill(ud);
    for (const skillId of ['ace-hermes-router', 'ace-grill-prd', 'ace-worker-brief-writing', 'ace-internal-subagents', 'ace-integration', 'ace-validator-worker', 'ace-rubric-first', 'ace-github-flow', 'ace-major-prune-program', 'ace-graceful-rebuild-relaunch', 'ace-task-worker', 'autoreview', 'grill-me', 'skill-cleaner', 'ace-agent-pack-architect', 'ace-agent-pack-engineer', 'ace-agent-pack-backend', 'ace-agent-pack-ui-designer', 'steipete-frontend-design', 'ace-agent-pack-security', 'ace-agent-pack-cloudflare']) {
      const skillPath = path.join(baseHermesHome(ud), 'skills', skillId, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `${skillId} should be seeded`);
      assert.match(fs.readFileSync(skillPath, 'utf8'), new RegExp(`name: ${skillId}`));
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureBundledAceSkill: seeds goal-agent baseline (runtime-contract, goal-worker, goal-validator)', () => {
  // Regression guard for the rebase gap where existing Hermes homes were
  // missing the three goal-agent baseline skills referenced by
  // WORKER_BASELINE_SKILL_IDS / VALIDATOR_BASELINE_SKILL_IDS.
  const ud = makeTmpUserData();
  try {
    ensureBundledAceSkill(ud);
    for (const skillId of ['ace-runtime-contract', 'ace-goal-worker', 'ace-validator-worker']) {
      const skillPath = path.join(baseHermesHome(ud), 'skills', skillId, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `${skillId} should be seeded into hermes-home/skills/`);
      assert.match(fs.readFileSync(skillPath, 'utf8'), new RegExp(`name: ${skillId}`));
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

// ── operator-profile options (cross-unit contract with electron/operators.cts) ──

test('ensureIdentityHermesHome without soul never writes any SOUL.md — base stays byte-identical', () => {
  const ud = makeTmpUserData();
  try {
    const soulBytes = 'THE BASE SOUL — operator persona, owned by the user.\n';
    seedBase(ud, { files: { 'auth.json': '{}', 'SOUL.md': soulBytes } });
    const baseSoulPath = path.join(baseHermesHome(ud), 'SOUL.md');
    const before = fs.readFileSync(baseSoulPath);

    const wsHome = ensureIdentityHermesHome(ud, 'prj-nosoul', {
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
      terminalCwd: path.join(ud, 'workdir'),
      memoryDbPath: path.join(ud, 'memory_store.db'),
    });

    // Base SOUL.md byte-identical, and the workspace copy is still the
    // shared symlink — no per-workspace override was materialized.
    assert.ok(before.equals(fs.readFileSync(baseSoulPath)), 'base SOUL.md must be byte-identical');
    assert.ok(fs.lstatSync(path.join(wsHome, 'SOUL.md')).isSymbolicLink(), 'workspace SOUL.md must stay a symlink');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('ensureIdentityHermesHome with soul writes only the workspace override, never the base', () => {
  const ud = makeTmpUserData();
  try {
    const soulBytes = 'THE BASE SOUL\n';
    seedBase(ud, { files: { 'auth.json': '{}', 'SOUL.md': soulBytes } });
    const wsHome = ensureIdentityHermesHome(ud, 'prj-soul', {
      soul: 'CUSTOM PERSONA\n',
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
    });
    const overridePath = path.join(wsHome, 'SOUL.md');
    assert.equal(fs.lstatSync(overridePath).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(overridePath, 'utf8'), 'CUSTOM PERSONA\n');
    assert.equal(fs.readFileSync(path.join(baseHermesHome(ud), 'SOUL.md'), 'utf8'), soulBytes);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('memoryDbPath replaces the hermes-memory-store db_path and preserves auto_extract + other lines', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, {
      files: {
        'config.yaml':
          'terminal:\n  cwd: /old/cwd\nplugins:\n  hermes-memory-store:\n    db_path: /old/memory_store.db\n    auto_extract: true\n',
      },
    });
    const cwd = path.join(ud, 'workdir');
    const wsHome = ensureIdentityHermesHome(ud, 'prj-mem', {
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
      terminalCwd: cwd,
      memoryDbPath: '/new/memory_store.db',
    });
    assert.equal(
      fs.readFileSync(path.join(wsHome, 'config.yaml'), 'utf8'),
      `terminal:\n  cwd: ${cwd}\nplugins:\n  hermes-memory-store:\n    db_path: /new/memory_store.db\n    auto_extract: true\n`
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('memoryDbPath undefined leaves the inherited plugin block byte-identical', () => {
  const ud = makeTmpUserData();
  try {
    const pluginBlock =
      'plugins:\n  hermes-memory-store:\n    db_path: /old/memory_store.db\n    auto_extract: true\n';
    seedBase(ud, { files: { 'config.yaml': `terminal:\n  cwd: /old/cwd\n${pluginBlock}` } });
    const cwd = path.join(ud, 'workdir');
    const wsHome = ensureIdentityHermesHome(ud, 'prj-nomem', {
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
      terminalCwd: cwd,
    });
    assert.equal(
      fs.readFileSync(path.join(wsHome, 'config.yaml'), 'utf8'),
      `terminal:\n  cwd: ${cwd}\n${pluginBlock}`
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('memoryDbPath alone (no terminalCwd) writes the config override with only the db_path changed', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, {
      files: {
        'config.yaml':
          'terminal:\n  cwd: /old/cwd\nplugins:\n  hermes-memory-store:\n    db_path: /old/memory_store.db\n    auto_extract: true\n',
      },
    });
    const wsHome = ensureIdentityHermesHome(ud, 'prj-memonly', {
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
      memoryDbPath: '/new/memory_store.db',
    });
    assert.equal(
      fs.readFileSync(path.join(wsHome, 'config.yaml'), 'utf8'),
      'terminal:\n  cwd: /old/cwd\nplugins:\n  hermes-memory-store:\n    db_path: /new/memory_store.db\n    auto_extract: true\n'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('memoryDbPath creates the plugin block when the base config has none', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'config.yaml': 'terminal:\n  cwd: /old/cwd\n' } });
    const cwd = path.join(ud, 'workdir');
    const wsHome = ensureIdentityHermesHome(ud, 'prj-newblock', {
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
      terminalCwd: cwd,
      memoryDbPath: '/new/memory_store.db',
    });
    assert.equal(
      fs.readFileSync(path.join(wsHome, 'config.yaml'), 'utf8'),
      `terminal:\n  cwd: ${cwd}\nplugins:\n  hermes-memory-store:\n    db_path: /new/memory_store.db\n    auto_extract: true\n`
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('configWithMemoryDbPath line-scan edge cases', () => {
  // Quoted value replaced, surrounding lines untouched.
  assert.equal(
    configWithMemoryDbPath(
      'plugins:\n  hermes-memory-store:\n    db_path: "/old/db.sqlite"\n    auto_extract: false\n',
      '/new/db.sqlite'
    ),
    'plugins:\n  hermes-memory-store:\n    db_path: /new/db.sqlite\n    auto_extract: false\n'
  );
  // Block exists without db_path: one is inserted under the header.
  assert.equal(
    configWithMemoryDbPath('plugins:\n  hermes-memory-store:\n    auto_extract: true\n', '/new/db.sqlite'),
    'plugins:\n  hermes-memory-store:\n    db_path: /new/db.sqlite\n    auto_extract: true\n'
  );
  // plugins: section exists without the block: block added under it.
  assert.equal(
    configWithMemoryDbPath('plugins:\n  other-plugin:\n    enabled: true\n', '/new/db.sqlite'),
    'plugins:\n  hermes-memory-store:\n    db_path: /new/db.sqlite\n    auto_extract: true\n  other-plugin:\n    enabled: true\n'
  );
  // Empty config: full block appended.
  assert.equal(
    configWithMemoryDbPath('', '/new/db.sqlite'),
    'plugins:\n  hermes-memory-store:\n    db_path: /new/db.sqlite\n    auto_extract: true\n'
  );
});

test('legacyAuthDirs drives the auth candidate splice (operator-profile contract)', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{"base":"old"}' } });
    fs.utimesSync(path.join(baseHermesHome(ud), 'auth.json'), new Date(1000), new Date(1000));
    const customDir = path.join(ud, 'hermes-home-custom-operator');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'auth.json'), '{"custom":"operator"}');
    // Future mtime so this candidate deterministically beats any real
    // ~/.hermes/auth.json on the machine running the tests.
    const future = new Date('2099-01-01T00:00:00Z');
    fs.utimesSync(path.join(customDir, 'auth.json'), future, future);

    const wsHome = ensureIdentityHermesHome(ud, 'prj-custom', {
      legacyAuthDirs: ['hermes-home-custom-operator'],
    });
    assert.equal(fs.readFileSync(path.join(wsHome, 'auth.json'), 'utf8'), '{"custom":"operator"}');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('legacyAuthDirs undefined keeps the legacy rook splice; an explicit list replaces it', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{"base":"old"}' } });
    fs.utimesSync(path.join(baseHermesHome(ud), 'auth.json'), new Date(1000), new Date(1000));
    const legacyDir = path.join(ud, 'hermes-home-personal-hermes');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'auth.json'), '{"legacy":"rook"}');
    const future = new Date('2099-01-01T00:00:00Z');
    fs.utimesSync(path.join(legacyDir, 'auth.json'), future, future);

    // Default (undefined): the hardcoded rook dir still wins.
    const defaults = ensureIdentityHermesHome(ud, 'prj-rook-default', { identity: 'rook' });
    assert.equal(fs.readFileSync(path.join(defaults, 'auth.json'), 'utf8'), '{"legacy":"rook"}');

    // Explicit empty list: the legacy splice is gone.
    const replaced = ensureIdentityHermesHome(ud, 'prj-rook-replaced', {
      identity: 'rook',
      legacyAuthDirs: [],
    });
    const replacedAuth = path.join(replaced, 'auth.json');
    if (fs.existsSync(replacedAuth) && !fs.lstatSync(replacedAuth).isSymbolicLink()) {
      assert.notEqual(fs.readFileSync(replacedAuth, 'utf8'), '{"legacy":"rook"}');
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('hermesHomeOverride routes the identity home to an explicit dir', () => {
  const ud = makeTmpUserData();
  try {
    seedBase(ud, { files: { 'auth.json': '{}', 'SOUL.md': 'BASE\n' } });
    const overrideDir = path.join(ud, 'custom-operator-home');
    const wsHome = ensureIdentityHermesHome(ud, 'prj-ovr', {
      hermesHomeOverride: overrideDir,
      soul: 'OVERRIDE PERSONA\n',
      legacyAuthDirs: [],
      includeDefaultAuthCandidates: false,
    });
    assert.equal(wsHome, overrideDir);
    assert.ok(fs.statSync(path.join(overrideDir, 'sessions')).isDirectory());
    assert.ok(fs.lstatSync(path.join(overrideDir, 'auth.json')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(overrideDir, 'SOUL.md'), 'utf8'), 'OVERRIDE PERSONA\n');
    assert.equal(fs.readFileSync(path.join(baseHermesHome(ud), 'SOUL.md'), 'utf8'), 'BASE\n');
    // The default per-workspace dir is not created when an override is used.
    assert.equal(fs.existsSync(workspaceHermesHome(ud, 'prj-ovr')), false);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('seedBundledSkill skips any skill dir carrying a .local-override marker', () => {
  const ud = makeTmpUserData();
  try {
    const dstDir = path.join(baseHermesHome(ud), 'skills', 'ace-task-worker');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(path.join(dstDir, 'SKILL.md'), 'CUSTOM OWNER DOCTRINE');
    fs.writeFileSync(path.join(dstDir, '.local-override'), '');

    seedBundledSkill(ud, 'ace-task-worker');
    assert.equal(
      fs.readFileSync(path.join(dstDir, 'SKILL.md'), 'utf8'),
      'CUSTOM OWNER DOCTRINE',
      '.local-override skill must never be re-seeded'
    );

    // Control: without the marker the customized copy is overwritten by the
    // bundled source (size mismatch forces the copy).
    const controlDir = path.join(baseHermesHome(ud), 'skills', 'ace-goal-worker');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(path.join(controlDir, 'SKILL.md'), 'CUSTOM');
    seedBundledSkill(ud, 'ace-goal-worker');
    assert.notEqual(fs.readFileSync(path.join(controlDir, 'SKILL.md'), 'utf8'), 'CUSTOM');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('SHARED_ENTRIES is the contract — keep the isolation boundary explicit', () => {
  // Snapshot-style assertion so future edits that accidentally add state.db
  // or sessions/ to SHARED_ENTRIES fail loudly.
  assert.deepEqual(
    SHARED_ENTRIES.slice().sort(),
    ['.env', 'SOUL.md', 'auth.json', 'bin', 'config.yaml', 'skills', 'vendor']
      .slice()
      .sort()
  );
  assert.ok(!SHARED_ENTRIES.includes('state.db'));
  assert.ok(!SHARED_ENTRIES.includes('sessions'));
  assert.ok(!SHARED_ENTRIES.includes('memories'));
  assert.ok(!SHARED_ENTRIES.includes('logs'));
});
