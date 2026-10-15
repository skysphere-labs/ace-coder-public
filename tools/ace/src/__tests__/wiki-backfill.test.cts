const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const curator = require('../project-wiki-curator.cts');
const bootstrap = require('../../../../electron/wiki-bootstrap.cts');
const { parseFrontmatter } = require('../../../../electron/harness/knowledge-contract.cts');

// Build the bug shape: a project with .ace/wiki-dump/ records but NO
// .ace/wiki/ canon. This is the Brampton-shaped repro.
function dumpOnlyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-dumponly-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  curator.writeDumpRecord({
    projectDir: dir,
    record: {
      kind: 'operator_note', identity: 'chief', projectId: 'prj_brampton', projectName: 'Brampton',
      summary: 'Release gate requires validator PASS before merge',
      completedItems: ['Wired the merge gate'],
      decisions: ['Auto-promote confidence threshold is 0.8'],
    },
  });
  return dir;
}

// --- A0.1 / A0.2: the dump-only-no-canon repro -----------------------------

test('A0.1 a dump-only project has dumps but no canon (the bug)', () => {
  const dir = dumpOnlyProject();
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki-dump')), true);
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki')), false);
  assert.equal(curator.isDumpOnly(dir), true);
  assert.equal(curator.hasCanon(dir), false);
});

test('A0.2 the legacy wiki-only enumeration SKIPS a dump-only project; the fix includes it', () => {
  const dir = dumpOnlyProject();
  const projects = [{ id: 'prj_brampton', path: dir }];
  // Legacy behaviour = the bug: curate only projects that already have a wiki.
  assert.equal(bootstrap.legacyWikiOnlyTargets(projects).length, 0);
  // Fixed enumeration: dump-or-wiki, dump-only flagged.
  const fixed = bootstrap.enumerateCurationTargets(projects);
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].dumpOnly, true);
});

// --- A1.1 / A1.2 / A1.3: bootstrap + backfill ------------------------------

test('A1.1 bootstrapWikiSkeleton writes the OKF skeleton (index.md, log.md, 00_index/)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skel-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  const result = curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki', 'index.md')), true);
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki', 'log.md')), true);
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki', '00_index')), true);
});

test('A1.3 skeleton frontmatter conforms (schema + sources + ISO timestamps)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-skel-fm-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  const { present, data } = parseFrontmatter(fs.readFileSync(path.join(dir, '.ace', 'wiki', 'index.md'), 'utf8'));
  assert.equal(present, true);
  assert.equal(data.schema, 'AceWikiIndex/v1');
  assert.equal(data.projectId, 'prj_x');
  assert.ok(Array.isArray(data.sources) && data.sources.length > 0);
  assert.ok(!Number.isNaN(Date.parse(String(data.updatedAt))));
});

test('A1.2 backfillProject bootstraps canon for a dump-only project and is idempotent', () => {
  const dir = dumpOnlyProject();
  const first = curator.backfillProject({ projectDir: dir, projectId: 'prj_brampton', projectName: 'Brampton' });
  assert.equal(first.before.dumpOnly, true);
  assert.equal(first.after.dumpOnly, false);
  assert.equal(first.after.hasCanon, true);
  assert.equal(first.skeletonCreated, true);
  // The dump's content reached canon.
  const page = fs.readFileSync(path.join(dir, '.ace', 'wiki', 'projects', 'brampton.md'), 'utf8');
  assert.ok(page.includes('Release gate requires validator PASS'));

  // Idempotent: re-run creates no new skeleton; canon stays present.
  const second = curator.backfillProject({ projectDir: dir, projectId: 'prj_brampton', projectName: 'Brampton' });
  assert.equal(second.skeletonCreated, false);
  assert.equal(second.after.hasCanon, true);
});

test('curateAllProjects bootstraps canon for every dump-or-wiki project (the autonomous fix)', () => {
  const dir = dumpOnlyProject();
  const out = bootstrap.curateAllProjects({ projects: [{ id: 'prj_brampton', path: dir }] });
  assert.equal(out.targets, 1);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].dumpOnlyBefore, true);
  assert.equal(curator.isDumpOnly(dir), false);
  assert.equal(curator.hasCanon(dir), true);
});
