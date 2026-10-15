const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeDumpRecord,
  runNightlyProjectWikiCuration,
  buildAgentPack,
  auditProjectWiki,
} = require('../project-wiki-curator.cts');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-project-wiki-pack-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  return dir;
}

function seedCanon(projectDir: string) {
  writeDumpRecord({
    projectDir,
    kind: 'ace_mission',
    identity: 'ace',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'Canonical project page exists for role pack testing.',
    proposedNextActions: ['Validate role pack excludes dump folders'],
    decisions: ['Role packs read canonical pages only'],
    source: 'pack-test',
  });
  return runNightlyProjectWikiCuration({
    projectDir,
    identity: 'all',
    describeCommands: ['wiki dump', 'wiki nightly', 'wiki pack', 'wiki audit'],
    now: '2026-05-23T12:00:00.000Z',
  });
}

test('buildAgentPack includes only canonical orchestrator pages and forbids dump paths', () => {
  const projectDir = tempProject();
  seedCanon(projectDir);
  const result = buildAgentPack({ projectDir, role: 'orchestrator', projectId: 'prj_ace' });

  assert.equal(result.pack.schema, 'AceWikiPack/v1');
  assert.equal(result.pack.role, 'orchestrator');
  assert.ok(result.pack.pages.includes('projects/ace.md'));
  assert.ok(result.pack.pages.includes('decisions/ace-decisions.md'));
  assert.ok(result.pack.pages.includes('00_index/NEXT_ACTIONS.md'));
  assert.equal(result.pack.pages.some((page: string) => /dump|quarantine|deprecated|diagnostic/.test(page)), false);
  assert.match(fs.readFileSync(result.path, 'utf8'), /AceWikiPack\/v1/);
  assert.equal(auditProjectWiki({ projectDir }).ok, true);
});

test('worker and validator packs stay role-specific and canonical', () => {
  const projectDir = tempProject();
  seedCanon(projectDir);
  const worker = buildAgentPack({ projectDir, role: 'worker', projectId: 'prj_ace' }).pack;
  const validator = buildAgentPack({ projectDir, role: 'validator', projectId: 'prj_ace' }).pack;

  assert.deepEqual(worker.pages, ['projects/ace.md', '00_index/NEXT_ACTIONS.md']);
  assert.ok(validator.pages.includes('projects/ace.md'));
  assert.ok(validator.pages.includes('decisions/ace-decisions.md'));
  for (const pack of [worker, validator]) {
    for (const page of pack.pages) {
      const text = fs.readFileSync(path.join(projectDir, '.ace', 'wiki', page), 'utf8');
      assert.match(text, /^---\n/);
      assert.doesNotMatch(page, /wiki-dump|quarantine|deprecated|diagnostic/);
    }
  }
});
