// A6 materialization proof: the full universal ticket-worker skill set — the
// worker baseline (incl. all four Karpathy skills), the Matt Pocock
// engineering trio, and the Skysphere handoff additions — actually lands in
// BOTH Claude's and Codex's native skill dirs, from the REAL bundled sources
// (electron/assets/skills), through the REAL seed + sync path
// (hermesHome.ensureBundledAceSkill → ensureBaselineSkillsForAgent). Runs on
// whatever OS executes the suite: path handling is path.join throughout and
// the symlink call uses type 'junction' (the win32-compatible form; ignored
// elsewhere), with a copy fallback — so a green run on win32 CI proves the
// Windows path and a green run on darwin proves macOS.
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
  MP_ENGINEERING_SKILL_IDS,
  missingBundledSkillSources,
  ensureBaselineSkillsForAgent,
} = skillsCore;
// The canonical exported definition — the same one production dispatches with.
const {
  DEFAULT_HANDOFF_SKILLS,
  UNIVERSAL_TICKET_SKILL_IDS: UNIVERSAL_SKILL_IDS,
} = require('../skysphere/bridge.cjs');
const ALL_BUNDLED_MP_SKILL_IDS = [
  'mp-tdd', 'mp-diagnose', 'mp-handoff',
  'mp-grill-with-docs', 'mp-grill-me', 'mp-to-prd', 'mp-to-issues', 'mp-caveman',
];

test('every universal + Matt Pocock skill has a bundled source (packaged availability)', () => {
  assert.deepEqual(missingBundledSkillSources(UNIVERSAL_SKILL_IDS), []);
  assert.deepEqual(missingBundledSkillSources(ALL_BUNDLED_MP_SKILL_IDS), []);
});

test('ensureBundledAceSkill seeds every universal and Matt Pocock skill into hermes-home', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-univ-ud-'));
  hermesHome.ensureBaseHermesHome(userData, {});
  hermesHome.ensureBundledAceSkill(userData);
  const base = path.join(hermesHome.baseHermesHome(userData), 'skills');
  for (const id of [...UNIVERSAL_SKILL_IDS, ...ALL_BUNDLED_MP_SKILL_IDS]) {
    assert.equal(
      fs.existsSync(path.join(base, id, 'SKILL.md')),
      true,
      `${id} seeded into hermes-home/skills`
    );
  }
});

test('the universal set materializes into BOTH Claude and Codex native skill dirs on this OS', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skills-univ-ud2-'));
  // The exact launcher shape: baseline implicit, ticket additions riding
  // extraSkillIds — what local-core passes from launchIntent.skillIds. The
  // sync internally runs ensureBundledAceSkill so the REAL bundled sources
  // are what materialize.
  const extraSkillIds = [...MP_ENGINEERING_SKILL_IDS, ...DEFAULT_HANDOFF_SKILLS];
  for (const agent of ['claude', 'codex']) {
    const result = await ensureBaselineSkillsForAgent(agent, userData, { extraSkillIds });
    assert.ok(result, `${agent}: sync returned a result`);
    assert.equal(result.missing, 0, `${agent}: no universal skill was silently skipped as source-missing`);
    assert.equal(result.failed, 0, `${agent}: no universal skill failed to link/copy`);
    const skillsDir = path.join(tmpHome, agent === 'claude' ? '.claude' : '.codex', 'skills');
    for (const id of UNIVERSAL_SKILL_IDS) {
      assert.equal(
        fs.existsSync(path.join(skillsDir, id, 'SKILL.md')),
        true,
        `${agent}: ${id} resolves at ${path.join(skillsDir, id, 'SKILL.md')}`
      );
    }
  }
});
