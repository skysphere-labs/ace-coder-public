// Bundled-source materialization: the exported worker baseline plus explicitly
// selected engineering and Skysphere ticket skills can be seeded and synced
// into Claude's and Codex's native skill directories on the executing OS.
// This tests optional skill materialization, not automatic ticket dispatch.
//
// HOME is swapped to a tmp dir BEFORE require so AGENT_TARGETS resolves
// against the fake home (same harness as skills-core.baseline.test.cts).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-univ-home-'));
process.env.HOME = tmpHome;
if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;

for (const key of Object.keys(require.cache)) {
  if (key.includes('skills-core.cjs') || key.includes('hermes-home.cjs')) {
    delete require.cache[key];
  }
}

const skillsCore = require('../skills-core.cjs');
const hermesHome = require('../hermes-home.cjs');
const {
  WORKER_BASELINE_SKILL_IDS,
  MP_ENGINEERING_SKILL_IDS,
  missingBundledSkillSources,
  ensureBaselineSkillsForAgent,
} = skillsCore;
const SELECTED_EXTRA_SKILL_IDS = [...MP_ENGINEERING_SKILL_IDS, 'skysphere-tickets'];
const SELECTED_SKILL_IDS = [...WORKER_BASELINE_SKILL_IDS, ...SELECTED_EXTRA_SKILL_IDS];
const ALL_BUNDLED_MP_SKILL_IDS = [
  'mp-tdd', 'mp-diagnose', 'mp-handoff',
  'mp-grill-with-docs', 'mp-grill-me', 'mp-to-prd', 'mp-to-issues', 'mp-caveman',
];

test('baseline, selected ticket, and Matt Pocock skills have bundled sources', () => {
  assert.deepEqual(missingBundledSkillSources(SELECTED_SKILL_IDS), []);
  assert.deepEqual(missingBundledSkillSources(ALL_BUNDLED_MP_SKILL_IDS), []);
});

test('ensureBundledAceSkill seeds baseline, selected ticket, and Matt Pocock skills', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-univ-ud-'));
  hermesHome.ensureBaseHermesHome(userData, {});
  hermesHome.ensureBundledAceSkill(userData);
  const base = path.join(hermesHome.baseHermesHome(userData), 'skills');
  for (const id of [...SELECTED_SKILL_IDS, ...ALL_BUNDLED_MP_SKILL_IDS]) {
    assert.equal(
      fs.existsSync(path.join(base, id, 'SKILL.md')),
      true,
      `${id} seeded into hermes-home/skills`
    );
  }
});

test('baseline and explicitly selected skills materialize into Claude and Codex directories', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-univ-ud2-'));
  // Request optional skills explicitly through the public sync interface.
  // Real bundled sources are seeded by ensureBundledAceSkill during sync.
  const extraSkillIds = SELECTED_EXTRA_SKILL_IDS;
  for (const agent of ['claude', 'codex']) {
    const result = await ensureBaselineSkillsForAgent(agent, userData, { extraSkillIds });
    assert.ok(result, `${agent}: sync returned a result`);
    assert.equal(result.missing, 0, `${agent}: no selected skill was silently skipped as source-missing`);
    assert.equal(result.failed, 0, `${agent}: no selected skill failed to link/copy`);
    const skillsDir = path.join(tmpHome, agent === 'claude' ? '.claude' : '.codex', 'skills');
    for (const id of SELECTED_SKILL_IDS) {
      assert.equal(
        fs.existsSync(path.join(skillsDir, id, 'SKILL.md')),
        true,
        `${agent}: ${id} resolves at ${path.join(skillsDir, id, 'SKILL.md')}`
      );
    }
  }
});
