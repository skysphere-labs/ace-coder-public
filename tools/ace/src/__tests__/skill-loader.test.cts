const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadSkillContent,
  candidatePaths,
  referenceCandidatePaths,
  parseQualifiedAddress,
  resolveSkillRequirements,
  launchIntentSkillIds,
} = require('../skill-loader.cjs');
const { buildTaskPrompt } = require('../prompt.cjs');

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skill-loader-'));
}

function writeSkill(home: any, dir: any, id: any, body: any) {
  const full = path.join(home, dir, 'skills', id);
  fs.mkdirSync(full, { recursive: true });
  const p = path.join(full, 'SKILL.md');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

function writeHermesSkill(home: any, id: any, body: any) {
  const full = path.join(home, 'Library', 'Application Support', 'Ace', 'hermes-home', 'skills', id);
  fs.mkdirSync(full, { recursive: true });
  const p = path.join(full, 'SKILL.md');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('candidatePaths: emits codex, claude, hermes-home, bundled assets in order', () => {
  const paths = candidatePaths('my-skill', '/tmp/home');
  assert.equal(paths.length, 4);
  assert.match(paths[0], /\.codex\/skills\/my-skill\/SKILL\.md$/);
  assert.match(paths[1], /\.claude\/skills\/my-skill\/SKILL\.md$/);
  assert.match(paths[2], /hermes-home\/skills\/my-skill\/SKILL\.md$/);
  assert.match(paths[3], /electron\/assets\/skills\/my-skill\/SKILL\.md$/);
});

test('loadSkillContent: resolves ~/.codex/skills first (codex-dir hit)', () => {
  const home = mkTmpHome();
  const codexPath = writeSkill(home, '.codex', 'ace-github-flow', '# codex body');
  writeSkill(home, '.claude', 'ace-github-flow', '# claude body');
  writeHermesSkill(home, 'ace-github-flow', '# hermes body');

  const r = loadSkillContent('ace-github-flow', { home });
  assert.equal(r.id, 'ace-github-flow');
  assert.equal(r.path, codexPath);
  assert.equal(r.body, '# codex body');
});

test('loadSkillContent: falls through to ~/.claude/skills (claude-dir hit)', () => {
  const home = mkTmpHome();
  const claudePath = writeSkill(home, '.claude', 'ace-github-flow', '# claude body');
  writeHermesSkill(home, 'ace-github-flow', '# hermes body');

  const r = loadSkillContent('ace-github-flow', { home });
  assert.equal(r.path, claudePath);
  assert.equal(r.body, '# claude body');
});

test('loadSkillContent: falls through to hermes-home (hermes-dir hit)', () => {
  const home = mkTmpHome();
  const hermesPath = writeHermesSkill(home, 'ace-github-flow', '# hermes body');

  const r = loadSkillContent('ace-github-flow', { home });
  assert.equal(r.path, hermesPath);
  assert.equal(r.body, '# hermes body');
});

test('loadSkillContent: missing everywhere returns null', () => {
  const home = mkTmpHome();
  const r = loadSkillContent('no-such-skill', { home });
  assert.equal(r, null);
});

test('loadSkillContent: falls through to bundled assets for ace-github-flow', () => {
  const home = mkTmpHome();
  const r = loadSkillContent('ace-github-flow', { home });
  assert.equal(r.id, 'ace-github-flow');
  assert.match(r.path, /electron\/assets\/skills\/ace-github-flow\/SKILL\.md$/);
  assert.match(r.body, /name: ace-github-flow/);
});

test('loadSkillContent: rejects empty/non-string ids', () => {
  assert.equal(loadSkillContent('', { home: '/tmp' }), null);
  assert.equal(loadSkillContent(null, { home: '/tmp' }), null);
  assert.equal(loadSkillContent(undefined, { home: '/tmp' }), null);
});

test('resolveSkillRequirements: missing optional warns, missing required errors', () => {
  const home = mkTmpHome();
  writeSkill(home, '.codex', 'present-required', '# present');

  const r = resolveSkillRequirements({
    requiredSkills: ['present-required', 'missing-required'],
    optionalSkills: ['missing-optional'],
  }, { home });

  assert.equal(r.requiredSkills[0].available, true);
  assert.equal(r.requiredSkills[1].available, false);
  assert.equal(r.optionalSkills[0].available, false);
  assert.deepEqual(r.missingRequired, ['missing-required']);
  assert.deepEqual(r.missingOptional, ['missing-optional']);
  assert.deepEqual(r.warnings, ['optional skill missing: missing-optional']);
  assert.deepEqual(r.errors, ['required skill missing: missing-required']);
});

// --- prompt-builder integration: compact skill pointers for every driver ---

test('buildTaskPrompt: driver=claude keeps the compact "Skills to load" reference', () => {
  const out = buildTaskPrompt(
    { goal: 'x', skills: ['ace-github-flow'] },
    { driver: 'claude' }
  );
  assert.match(out, /# Skills to load/);
  assert.match(out, /- ace-github-flow/);
  assert.match(out, /~\/\.claude\/skills\/</);
  assert.doesNotMatch(out, /^# Skills$/m);
});

test('buildTaskPrompt: default driver (claude) preserves existing compact behaviour', () => {
  const withDefault = buildTaskPrompt({ goal: 'x', skills: ['ace-github-flow'] });
  const withExplicit = buildTaskPrompt(
    { goal: 'x', skills: ['ace-github-flow'] },
    { driver: 'claude' }
  );
  assert.equal(withDefault, withExplicit);
  assert.doesNotMatch(withDefault, /^# Skills$/m);
});

test('buildTaskPrompt: driver=codex also gets a compact "Skills to load" reference', () => {
  const out = buildTaskPrompt(
    { goal: 'x', skills: ['ace-github-flow'] },
    { driver: 'codex' }
  );
  assert.match(out, /# Skills to load/);
  assert.match(out, /- ace-github-flow/);
  assert.match(out, /~\/\.codex\/skills\/</);
  assert.match(out, /AGENTS\.md \/ CLAUDE\.md/);
  assert.doesNotMatch(out, /^# Skills$/m);
  assert.doesNotMatch(out, /PR-BODY|CLI-BODY|THINK-BODY|SIMPLE-BODY/);
});

test('buildTaskPrompt: non-claude non-codex drivers fall back to $AGENT_CONFIG skill path', () => {
  const out = buildTaskPrompt(
    { goal: 'x', skills: ['ace-github-flow'] },
    { driver: 'gemini' }
  );
  assert.match(out, /# Skills to load/);
  assert.match(out, /\$AGENT_CONFIG\/skills\/</);
  assert.doesNotMatch(out, /^# Skills$/m);
});

// --- Qualified addressing: skill: / ref: / path: ---

test('parseQualifiedAddress: skill:<id> recognises the qualified skill prefix', () => {
  assert.deepEqual(parseQualifiedAddress('skill:ace-github-flow'), { kind: 'skill', id: 'ace-github-flow' });
});

test('parseQualifiedAddress: ref:<skill>/<reference> requires both segments', () => {
  assert.deepEqual(parseQualifiedAddress('ref:ace-github-flow/REFERENCE.md'), {
    kind: 'ref',
    skillId: 'ace-github-flow',
    refPath: 'REFERENCE.md',
  });
  const noSlash = parseQualifiedAddress('ref:ace-github-flow');
  assert.equal(noSlash.kind, 'invalid');
  const dotDot = parseQualifiedAddress('ref:ace-github-flow/../escape');
  assert.equal(dotDot.kind, 'invalid');
});

test('parseQualifiedAddress: path:<file> is accepted as a verbatim file reference', () => {
  assert.deepEqual(parseQualifiedAddress('path:/etc/hosts'), { kind: 'path', path: '/etc/hosts' });
  assert.deepEqual(parseQualifiedAddress('path:docs/ops/wake.md'), { kind: 'path', path: 'docs/ops/wake.md' });
});

test('parseQualifiedAddress: bare ids without prefix are treated as the legacy form', () => {
  assert.deepEqual(parseQualifiedAddress('ace-github-flow'), { kind: 'bare', id: 'ace-github-flow' });
});

test('parseQualifiedAddress: unknown prefix surfaces invalid with a remediation message', () => {
  const r = parseQualifiedAddress('install:ace-github-flow');
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /skill:|ref:|path:/);
});

test('loadSkillContent: skill:<id> falls through to bundled assets just like a bare id', () => {
  const home = mkTmpHome();
  const r = loadSkillContent('skill:ace-validator-worker', { home });
  assert.equal(r.kind, 'skill');
  assert.match(r.path, /electron\/assets\/skills\/ace-validator-worker\/SKILL\.md$/);
});

test('loadSkillContent: ref:<skill>/<reference> reads a sibling reference file in the bundled skills dir', () => {
  const home = mkTmpHome();
  const skillDir = path.join(home, '.codex', 'skills', 'demo-ref-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo body\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'REFERENCE.md'), '# reference body\n', 'utf8');

  const r = loadSkillContent('ref:demo-ref-skill/REFERENCE.md', { home });
  assert.equal(r.kind, 'ref');
  assert.equal(r.skillId, 'demo-ref-skill');
  assert.equal(r.refPath, 'REFERENCE.md');
  assert.match(r.body, /reference body/);
});

test('loadSkillContent: ref:<skill>/<reference> does NOT load the skill SKILL.md by accident', () => {
  const home = mkTmpHome();
  const skillDir = path.join(home, '.codex', 'skills', 'demo-ref-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo body\n', 'utf8');

  const r = loadSkillContent('ref:demo-ref-skill/MISSING.md', { home });
  assert.equal(r, null);
});

test('loadSkillContent: path:<absolute> reads the file verbatim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skill-loader-path-'));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, 'hello path mode\n', 'utf8');
  const r = loadSkillContent(`path:${file}`, { home: dir });
  assert.equal(r.kind, 'path');
  assert.equal(r.path, file);
  assert.match(r.body, /hello path mode/);
});

test('loadSkillContent: invalid prefix returns a clear error envelope', () => {
  const r = loadSkillContent('install:ace-github-flow');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_address');
  assert.match(r.message, /skill:|ref:|path:/);
});

test('loadSkillContent: bare id ambiguous with a reference convention is rejected with a remediation hint', () => {
  // A bare id ending in "-reference" is the conventional reference-doc shape;
  // the loader refuses to register/load it as a skill without an explicit prefix.
  const home = mkTmpHome();
  // Provide a SKILL.md so the bare-id path would normally succeed.
  const dir = path.join(home, '.codex', 'skills', 'ace-runtime-reference');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# body\n', 'utf8');
  const r = loadSkillContent('ace-runtime-reference', { home });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous_address');
  assert.match(r.message, /skill:|ref:/);
});

test('referenceCandidatePaths: covers all the standard skill mount points', () => {
  const paths = referenceCandidatePaths('demo-ref-skill', 'REFERENCE.md', '/tmp/home');
  assert.equal(paths.length, 4);
  assert.match(paths[0], /\.codex\/skills\/demo-ref-skill\/REFERENCE\.md$/);
  assert.match(paths[1], /\.claude\/skills\/demo-ref-skill\/REFERENCE\.md$/);
  assert.match(paths[2], /hermes-home\/skills\/demo-ref-skill\/REFERENCE\.md$/);
  assert.match(paths[3], /electron\/assets\/skills\/demo-ref-skill\/REFERENCE\.md$/);
});

// launchIntentSkillIds — the shared extractor both spawn paths (orchestrator +
// Mission Board dispatch) use to wire telemetry → launchIntent.skillIds → role
// doctrine. Regression guard for the mission-dispatch skill-wiring fix.
test('launchIntentSkillIds: collects + de-dups across all telemetry skill arrays in order', () => {
  const ids = launchIntentSkillIds({
    baselineSkills: ['ace-runtime-contract', { id: 'ace-goal-worker' }],
    taskPackSkills: ['ace-agent-pack-engineer', 'karpathy-surgical-changes'],
    validationSkills: ['ace-validator-worker'],
    requiredSkills: ['karpathy-surgical-changes'], // dup — dropped
    optionalSkills: [{ name: 'karpathy-simplicity-first' }, '', null],
  });
  assert.deepEqual(ids, [
    'ace-runtime-contract',
    'ace-goal-worker',
    'ace-agent-pack-engineer',
    'karpathy-surgical-changes',
    'ace-validator-worker',
    'karpathy-simplicity-first',
  ]);
});

test('launchIntentSkillIds: empty / missing telemetry yields []', () => {
  assert.deepEqual(launchIntentSkillIds(), []);
  assert.deepEqual(launchIntentSkillIds({}), []);
  assert.deepEqual(launchIntentSkillIds({ baselineSkills: 'not-an-array' }), []);
});
