// skill-injection.test — proves the preflight skill-mount gate.
//
// Uses a REAL temp skills dir (no loader stub): we materialize one SKILL.md
// under <tmp>/.claude/skills/<id>/ and point the loader at it via opts.home,
// the public seam skill-loader.loadSkillContent already honors. A known id
// resolves + injects as a skill:<id> pointer; an unknown id reports missing +
// ok:false; validateRunSpecSkills blocks on a missing id.
//
// Determinism: temp dir name is fixed per process (process.pid), no Date.now /
// Math.random. Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/skill-injection.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build-agnostic sibling import (compiled .cjs may be absent in a fresh worktree).
let skillInjection: any;
try {
  skillInjection = require('../skill-injection.cjs');
} catch {
  skillInjection = require('../skill-injection.cts');
}
const { resolveSkills, injectSkills, validateRunSpecSkills, skillPointer } = skillInjection;

const KNOWN = 'ace-goal-worker';
const UNKNOWN = 'no-such-skill-xyz';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `skill-inject-${process.pid}-`));
  const dir = path.join(home, '.claude', 'skills', KNOWN);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# known skill body\n', 'utf8');
  return home;
}

test('resolveSkills: known id resolves with a real path, unknown id is missing', () => {
  const home = makeHome();
  const { resolved, missing } = resolveSkills([KNOWN, UNKNOWN], { home });

  const known = resolved.find((r: any) => r.id === KNOWN);
  assert.equal(known.found, true);
  assert.ok(known.path && known.path.includes(KNOWN), 'resolved path points at the skill dir');

  const unknown = resolved.find((r: any) => r.id === UNKNOWN);
  assert.equal(unknown.found, false);
  assert.equal(unknown.path, null);

  assert.deepEqual(missing, [UNKNOWN]);
});

test('injectSkills: emits skill:<id> pointers and blocks on missing', () => {
  const home = makeHome();

  const okCase = injectSkills([KNOWN], { home });
  assert.deepEqual(okCase.pointers, [skillPointer(KNOWN)]);
  assert.deepEqual(okCase.pointers, ['skill:' + KNOWN]);
  assert.deepEqual(okCase.missing, []);
  assert.equal(okCase.ok, true);

  const blocked = injectSkills([KNOWN, UNKNOWN], { home });
  assert.equal(blocked.ok, false, 'block-on-missing: ok is false when any id is missing');
  assert.deepEqual(blocked.missing, [UNKNOWN]);
  // Only the resolved id gets a pointer.
  assert.deepEqual(blocked.pointers, [skillPointer(KNOWN)]);
});

test('validateRunSpecSkills: preflight gate blocks a RunSpec with a missing skill', () => {
  const home = makeHome();

  const good = validateRunSpecSkills({ skillIds: [KNOWN] }, { home });
  assert.equal(good.ok, true);
  assert.deepEqual(good.missing, []);

  const bad = validateRunSpecSkills({ skillIds: [KNOWN, UNKNOWN] }, { home });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, [UNKNOWN]);

  // Empty / absent skillIds is a no-op pass (nothing to mount).
  assert.equal(validateRunSpecSkills({}, { home }).ok, true);
  assert.equal(validateRunSpecSkills({ skillIds: [] }, { home }).ok, true);
});

test('resolveSkills: de-dupes and ignores blank ids', () => {
  const home = makeHome();
  const { resolved } = resolveSkills([KNOWN, KNOWN, '', '  '], { home });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, KNOWN);
});
