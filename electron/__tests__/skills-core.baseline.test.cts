// Tests for ensureBaselineSkillsForAgent — the per-spawn hook that
// materialises the bundled skill pack into <agent>/skills/<id> so the
// child's native skill loader picks them up.
//
// HOME is swapped to a tmp dir BEFORE require() so AGENT_TARGETS resolves
// against the fake home. We also fake <userData>/hermes-home/skills/<id>
// source dirs — the real bundled copy isn't relevant here; we just want to
// confirm symlinks land where expected.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// This file (and its child-process test) loads the compiled ../skills-core.cjs,
// which is a gitignored generated artifact. Compile when it's missing or older
// than its .cts source so direct `node --test <this file>` runs never exercise
// a stale or absent module.
{
  const stale = ['skills-core', 'hermes-home'].some((base) => {
    const cjs = path.join(__dirname, '..', `${base}.cjs`);
    const cts = path.join(__dirname, '..', `${base}.cts`);
    try {
      return fs.statSync(cjs).mtimeMs < fs.statSync(cts).mtimeMs;
    } catch {
      return true;
    }
  });
  if (stale) {
    execFileSync('npm', ['run', 'build:electron-main'], {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'ignore',
    });
  }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-home-'));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;

// Drop any cached require so os.homedir() inside skills-core picks up the
// new HOME. (skills-core captures HOME at require-time.)
for (const key of Object.keys(require.cache)) {
  if (key.includes('/electron/skills-core.cjs') || key.includes('/electron/hermes-home.cjs')) {
    delete require.cache[key];
  }
}

const skillsCore = require('../skills-core.cjs');
const {
  BASELINE_SKILL_IDS,
  WORKER_BASELINE_SKILL_IDS,
  VALIDATOR_BASELINE_SKILL_IDS,
  ORCHESTRATOR_BASELINE_SKILL_IDS,
  AGENT_TARGETS,
} = skillsCore;
const skillsCatalog = require('../skills-catalog.json');

function makeTmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-ud-'));
}

function seedBundledSources(userDataPath) {
  const base = path.join(userDataPath, 'hermes-home', 'skills');
  for (const id of new Set([...WORKER_BASELINE_SKILL_IDS, ...ORCHESTRATOR_BASELINE_SKILL_IDS])) {
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: "${id}"\ndescription: "test"\n---\n# ${id}\n`);
  }
  return base;
}

function catalogWithCompatibility(overrides = {}) {
  return {
    skills: WORKER_BASELINE_SKILL_IDS.map((id) => ({
      id,
      agentCompatibility: overrides[id] || 'shared',
    })),
  };
}

after(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } finally {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('AGENT_TARGETS: Claude skillDir is the modern ~/.claude/skills path (not commands/)', () => {
  const claude = AGENT_TARGETS.find((t) => t.id === 'claude');
  assert.ok(claude, 'claude target should exist');
  assert.equal(claude.skillDir('x'), path.join(tmpHome, '.claude', 'skills', 'x'));
});

test('ensureBaselineSkillsForAgent(claude): defaults to worker baseline in ~/.claude/skills/', async () => {
  const ud = makeTmpUserData();
  try {
    const srcBase = seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    for (const id of WORKER_BASELINE_SKILL_IDS) {
      const dst = path.join(tmpHome, '.claude', 'skills', id);
      const lst = fs.lstatSync(dst);
      assert.ok(lst.isSymbolicLink(), `${id} should be a symlink`);
      const expected = path.join(srcBase, id);
      const actual = fs.readlinkSync(dst);
      const resolved = path.isAbsolute(actual)
        ? actual
        : path.resolve(path.dirname(dst), actual);
      assert.equal(resolved, expected, `${id} should point at ${expected}`);
      // SKILL.md reachable through the link (content comes from the real
      // bundled asset because ensureBundledAceSkill() re-seeds).
      assert.ok(
        fs.existsSync(path.join(dst, 'SKILL.md')),
        `${id}/SKILL.md should be reachable through the symlink`
      );
    }
    assert.equal(
      fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'ace-cli')),
      false,
      'worker/default baseline should not sync ace-cli'
    );
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.claude', 'skills', 'ace-runtime-contract')).isSymbolicLink(),
      'worker/default baseline should sync ace-runtime-contract'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent(codex): symlinks worker baseline into ~/.codex/skills/', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('codex', ud);
    for (const id of WORKER_BASELINE_SKILL_IDS) {
      const dst = path.join(tmpHome, '.codex', 'skills', id);
      assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${id} should be a symlink`);
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: skips claude-only baseline entries for codex and warns once', async () => {
  const ud = makeTmpUserData();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('codex', ud, {
      filterCompat: true,
      catalog: catalogWithCompatibility({ 'ace-goal-worker': 'claude-only' }),
    });
    assert.equal(
      fs.existsSync(path.join(tmpHome, '.codex', 'skills', 'ace-goal-worker')),
      false,
      'claude-only baseline skill should not sync to codex'
    );
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.codex', 'skills', 'ace-runtime-contract')).isSymbolicLink(),
      'shared baseline skill should still sync to codex'
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ace-goal-worker is claude-only/);
    assert.match(warnings[0], /Codex/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: shared baseline entries sync to both claude and codex', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud, {
      filterCompat: true,
      catalog: catalogWithCompatibility(),
    });
    await skillsCore.ensureBaselineSkillsForAgent('codex', ud, {
      filterCompat: true,
      catalog: catalogWithCompatibility(),
    });
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.claude', 'skills', 'ace-runtime-contract')).isSymbolicLink(),
      'shared baseline skill should sync to claude'
    );
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.codex', 'skills', 'ace-runtime-contract')).isSymbolicLink(),
      'shared baseline skill should sync to codex'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: all bundled worker baseline skills sync to claude and codex', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    await skillsCore.ensureBaselineSkillsForAgent('codex', ud);
    for (const id of WORKER_BASELINE_SKILL_IDS) {
      assert.ok(WORKER_BASELINE_SKILL_IDS.includes(id), `${id} should be in worker baseline`);
      assert.ok(
        fs.lstatSync(path.join(tmpHome, '.claude', 'skills', id)).isSymbolicLink(),
        `${id} should sync to claude`
      );
      assert.ok(
        fs.lstatSync(path.join(tmpHome, '.codex', 'skills', id)).isSymbolicLink(),
        `${id} should sync to codex`
      );
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: orchestrator baseline includes ace-cli and common skills', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud, { isOrchestrator: true });
    for (const id of ORCHESTRATOR_BASELINE_SKILL_IDS) {
      const dst = path.join(tmpHome, '.claude', 'skills', id);
      assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${id} should be a symlink`);
    }
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.claude', 'skills', 'ace-cli')).isSymbolicLink(),
      'orchestrator baseline should sync ace-cli'
    );
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.claude', 'skills', 'ace-github-flow')).isSymbolicLink(),
      'orchestrator baseline should sync ace-github-flow'
    );
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.claude', 'skills', 'ace-hermes-router')).isSymbolicLink(),
      'orchestrator baseline should sync ace-hermes-router'
    );
    assert.equal(
      fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'ace-goal-worker')),
      false,
      'orchestrator baseline should not sync the worker-only doctrine'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: orchestrator baseline syncs for model-agnostic providers', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('qwen', ud, { isOrchestrator: true });
    for (const id of ORCHESTRATOR_BASELINE_SKILL_IDS) {
      const dst = path.join(tmpHome, '.qwen', 'skills', id);
      assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${id} should be a qwen symlink`);
    }
    assert.ok(
      fs.lstatSync(path.join(tmpHome, '.qwen', 'skills', 'ace-cli')).isSymbolicLink(),
      'model-agnostic orchestrator baseline should sync ace-cli'
    );
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.qwen'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: syncs prompt-declared extra skills', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud, {
      extraSkillIds: ['grill-me', 'skill-cleaner', 'ace-agent-pack-engineer', 'grill-me'],
    });
    for (const id of ['grill-me', 'skill-cleaner', 'ace-agent-pack-engineer']) {
      const dst = path.join(tmpHome, '.claude', 'skills', id);
      assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${id} should be synced as an extra skill`);
      assert.ok(fs.existsSync(path.join(dst, 'SKILL.md')), `${id}/SKILL.md should exist`);
    }
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});


test('ensureBaselineSkillsForAgent: idempotent — re-running leaves good symlinks alone', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    const firstInode = fs.lstatSync(
      path.join(tmpHome, '.claude', 'skills', 'ace-goal-worker')
    ).ino;
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    const secondInode = fs.lstatSync(
      path.join(tmpHome, '.claude', 'skills', 'ace-goal-worker')
    ).ino;
    assert.equal(firstInode, secondInode, 'symlink should not have been replaced');
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: hot rerun reports cache-hit telemetry', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    const first = await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    const second = await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    assert.equal(first.cache, 'miss');
    assert.equal(second.cache, 'hit');
    assert.equal(second.agentId, 'claude');
    assert.equal(second.failed, 0);
    assert.ok(Array.isArray(second.syncedSkillIds));
    assert.ok(second.syncedSkillIds.includes('ace-goal-worker'));
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: repairs a stale symlink whose target changed', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    const link = path.join(tmpHome, '.claude', 'skills', 'ace-goal-worker');
    fs.unlinkSync(link);
    fs.symlinkSync('/tmp/ace-does-not-exist', link);
    await skillsCore.ensureBaselineSkillsForAgent('claude', ud);
    const expected = path.join(ud, 'hermes-home', 'skills', 'ace-goal-worker');
    const actual = fs.readlinkSync(link);
    const resolved = path.isAbsolute(actual)
      ? actual
      : path.resolve(path.dirname(link), actual);
    assert.equal(resolved, expected);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
  }
});

test('ensureBaselineSkillsForAgent: unknown agent id is a non-fatal warn', async () => {
  const ud = makeTmpUserData();
  try {
    seedBundledSources(ud);
    // Just has to not throw.
    await skillsCore.ensureBaselineSkillsForAgent('not-an-agent', ud);
    await skillsCore.ensureBaselineSkillsForAgent(null, ud);
    await skillsCore.ensureBaselineSkillsForAgent('claude', null);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('baseline skill lists split worker doctrine from orchestrator doctrine', () => {
  // Lean baselines (Ace v2): ace-runtime-contract is the compact
  // baseline every role reads first; worker adds the goal-worker contract +
  // the self-contained worker pair
  // (ace-internal-subagents + ace-integration); orchestrator (Hermes)
  // adds CLI + the lean router (ace-hermes-router) + the unified GitHub flow
  // doctrine (ace-github-flow).
  // Heavier doctrine loads lazily via task packs.
  assert.deepEqual(WORKER_BASELINE_SKILL_IDS.slice(), [
    'ace-runtime-contract',
    'ace-goal-worker',
    'ace-internal-subagents',
    'ace-integration',
  ]);
  assert.deepEqual(ORCHESTRATOR_BASELINE_SKILL_IDS.slice(), [
    'ace-runtime-contract',
    'ace-cli',
    'ace-hermes-router',
    'ace-github-flow',
  ]);
  assert.equal(WORKER_BASELINE_SKILL_IDS[0], 'ace-runtime-contract');
  assert.equal(ORCHESTRATOR_BASELINE_SKILL_IDS[0], 'ace-runtime-contract');
  assert.deepEqual(BASELINE_SKILL_IDS, WORKER_BASELINE_SKILL_IDS);
  assert.equal(WORKER_BASELINE_SKILL_IDS.includes('ace-cli'), false);
  assert.equal(ORCHESTRATOR_BASELINE_SKILL_IDS.includes('ace-cli'), true);
  assert.equal(WORKER_BASELINE_SKILL_IDS.includes('ace-goal-worker'), true);
  assert.equal(WORKER_BASELINE_SKILL_IDS.includes('ace-task-worker'), false);
  assert.equal(WORKER_BASELINE_SKILL_IDS.includes('ace-operator-policy'), false);
  assert.equal(VALIDATOR_BASELINE_SKILL_IDS.includes('autoreview'), true);
});

test('skills catalog registers baseline Ace policy/worker skills at bundled paths', () => {
  for (const skillId of ['ace-hermes-router', 'ace-grill-prd', 'ace-rubric-first', 'ace-github-flow', 'ace-major-prune-program', 'ace-graceful-rebuild-relaunch', 'ace-goal-worker', 'ace-validator-worker', 'autoreview', 'grill-me', 'skill-cleaner', 'ace-agent-pack-architect', 'ace-agent-pack-engineer', 'ace-agent-pack-backend', 'ace-agent-pack-ui-designer', 'steipete-frontend-design', 'ace-agent-pack-security', 'ace-agent-pack-cloudflare']) {
    const entry = skillsCatalog.skills.find((skill) => skill.id === skillId);
    assert.ok(entry, `${skillId} catalog entry should exist`);
    assert.equal(entry.bundledPath, `assets/skills/${skillId}/SKILL.md`);
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', entry.bundledPath)),
      `${skillId} bundled skill path should exist on disk`
    );
  }
});

test('isEphemeralSkillSource: tmp roots and sandbox homes are ephemeral, durable data roots are not', () => {
  const { isEphemeralSkillSource } = skillsCore;
  // System temp (covers /var/folders/... on macOS).
  assert.equal(isEphemeralSkillSource(path.join(os.tmpdir(), 'ace-codex-resume-x', 'user-data', 'hermes-home', 'skills')), true);
  // External-data-root tmp sandboxes: matched by their user-data store home.
  assert.equal(isEphemeralSkillSource('/Volumes/ExternalSSD/AppData/tmp/ace-agent-cli-socket-x/user-data/hermes-home/skills'), true);
  // 'user-data' sandbox-store segment alone is enough.
  assert.equal(isEphemeralSkillSource('/somewhere/user-data/hermes-home/skills'), true);
  // Durable app data roots are NOT ephemeral.
  assert.equal(isEphemeralSkillSource('/Volumes/ExternalSSD/AppData/hermes-home/skills'), false);
  assert.equal(isEphemeralSkillSource('/Users/someone/Library/Application Support/Ace/hermes-home/skills'), false);
  // Deliberately narrow: a durable root containing a `tmp` dir name is NOT
  // ephemeral — only os.tmpdir() and user-data store homes are.
  assert.equal(isEphemeralSkillSource('/Volumes/ExternalSSD/AppData/tmp/scratch/hermes-home/skills'), false);
});

test('ensureBaselineSkillsForAgent: never re-links a durable brain at a sandbox/test home', () => {
  // skills-core captures HOME at require-time (and the tsx require hook keeps
  // its own module cache, so an in-process re-require can return the old
  // instance). The durable-HOME scenario therefore runs in a child node
  // process against the compiled module: HOME points at a durable-shaped dir
  // (no tmp/user-data segment — under the gitignored out/ so an interrupted
  // run can't leave tracked-tree debris) while userData lives under
  // os.tmpdir() like every sandbox/test store. The sync must refuse to link
  // the brain and leave it untouched.
  const outRoot = path.join(__dirname, '..', '..', 'out');
  fs.mkdirSync(outRoot, { recursive: true });
  const fakeDurableHome = fs.mkdtempSync(path.join(outRoot, 'fake-durable-home-'));
  assert.equal(skillsCore.isEphemeralSkillSource(fakeDurableHome), false);
  try {
    const script = `
      const fs = require('fs'), path = require('path'), os = require('os');
      const core = require(process.argv[1]);
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-ud-'));
      core.ensureBaselineSkillsForAgent('codex', userData, {}).then((result) => {
        const brainTouched = fs.existsSync(path.join(process.env.HOME, '.codex', 'skills'));
        process.stdout.write('\\n' + JSON.stringify({
          skipped: !!(result && result.skippedEphemeralSource),
          linked: result ? result.linked : null,
          brainTouched,
        }));
      });
    `;
    const out = execFileSync(
      process.execPath,
      ['-e', script, path.join(__dirname, '..', 'skills-core.cjs')],
      { env: { ...process.env, HOME: fakeDurableHome }, encoding: 'utf8' }
    );
    const report = JSON.parse(out.slice(out.lastIndexOf('\n') + 1));
    assert.equal(report.skipped, true);
    assert.equal(report.linked, 0);
    assert.equal(report.brainTouched, false);
  } finally {
    fs.rmSync(fakeDurableHome, { recursive: true, force: true });
  }
});
