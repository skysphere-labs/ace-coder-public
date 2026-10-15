const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKnowledgeMigrateHandlers } = require('../knowledge-migrate.cts');

function makeHandler() {
  const { handleKnowledgeMigrate } = createKnowledgeMigrateHandlers({
    die: (payload) => { throw Object.assign(new Error(payload.message), payload); },
    normalizeText: (value) => String(value == null ? '' : value).trim(),
    resolveProjectDirFlag: (flags) => flags.projectDir || process.cwd(),
  });
  return handleKnowledgeMigrate;
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-migrate-'));
  // legacy page (inline Tags/Updated, no frontmatter)
  fs.mkdirSync(path.join(root, 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'concepts', 'legacy.md'), [
    '# Ace Orchestration Model',
    '',
    'Tags: concept, ace, orchestrator',
    'Updated: 2026-04-23 13:01:21 EDT',
    '',
    'Orchestrators stay concise.',
  ].join('\n'));
  // already-schema'd page must be untouched
  fs.mkdirSync(path.join(root, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lessons', 'modern.md'), [
    '---', 'schema: AceOpsPage/v1', 'kind: lesson', 'trust: canon', 'sources: [run_1]', '---', '', '# Modern',
  ].join('\n'));
  // machine log must be skipped
  fs.writeFileSync(path.join(root, 'log.md'), '- [2026-06-01T00:00:00Z] note — entry\n');
  fs.writeFileSync(path.join(root, 'SCHEMA.md'), '# Wiki Schema\n');
  return root;
}

test('dry-run proposes frontmatter stamps without changing anything', async () => {
  const root = makeVault();
  const handle = makeHandler();
  const before = fs.readFileSync(path.join(root, 'concepts', 'legacy.md'), 'utf8');
  const result = await handle({ flags: { wikiRoot: root } });

  assert.equal(result.applied, false);
  assert.equal(result.pagesNeedingFrontmatter, 1);
  assert.equal(result.stamped, 0);
  assert.deepEqual(result.proposals[0], {
    path: 'concepts/legacy.md', kind: 'concept', trust: 'canon', tags: ['concept', 'ace', 'orchestrator'],
  });
  assert.equal(fs.readFileSync(path.join(root, 'concepts', 'legacy.md'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(root, 'SCHEMA.md'), 'utf8'), '# Wiki Schema\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--apply stamps frontmatter preserving content, updates SCHEMA.md, is idempotent', async () => {
  const root = makeVault();
  const handle = makeHandler();
  const result = await handle({ flags: { wikiRoot: root, apply: true, skipRotation: true } });
  assert.equal(result.applied, true);
  assert.equal(result.stamped, 1);
  assert.equal(result.schemaUpdated, true);

  const stamped = fs.readFileSync(path.join(root, 'concepts', 'legacy.md'), 'utf8');
  assert.match(stamped, /^---\nschema: AceOpsPage\/v1\nkind: concept\n/);
  assert.match(stamped, /updatedAt: 2026-04-23T/);
  assert.match(stamped, /sources: \[migration-backfill\]/);
  assert.match(stamped, /Orchestrators stay concise\./); // body preserved
  assert.match(stamped, /Tags: concept, ace, orchestrator/); // legacy lines preserved
  assert.match(fs.readFileSync(path.join(root, 'SCHEMA.md'), 'utf8'), /Knowledge-plane taxonomy/);

  // idempotent: second apply finds nothing to do
  const again = await handle({ flags: { wikiRoot: root, apply: true, skipRotation: true } });
  assert.equal(again.pagesNeedingFrontmatter, 0);
  assert.equal(again.schemaUpdated, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backfills promoteToWiki candidates as untrusted dump records', async () => {
  const root = makeVault();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-migrate-project-'));
  const runDir = path.join(projectDir, '.ace', 'run', 'run_77');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'completion.json'), JSON.stringify({
    schema: 'ace.completion_result.v1',
    runId: 'run_77',
    outcome: 'done',
    memoryCandidates: [
      { claim: 'Scope vitest with --dir here.', category: 'lesson', promoteToWiki: true },
      { claim: 'Not for the wiki.', category: 'lesson', promoteToWiki: false },
    ],
  }));

  const handle = makeHandler();
  const dry = await handle({ flags: { wikiRoot: root, projectDir, projectId: 'prj_42' } });
  assert.equal(dry.candidatesBackfilled, 1);
  assert.match(dry.backfilled[0], /proposed/);

  const applied = await handle({ flags: { wikiRoot: root, projectDir, projectId: 'prj_42', apply: true, skipRotation: true } });
  assert.equal(applied.candidatesBackfilled, 1);
  assert.ok(fs.existsSync(applied.backfilled[0]));
  const record = JSON.parse(fs.readFileSync(applied.backfilled[0], 'utf8'));
  assert.equal(record.identity, 'migration');
  assert.equal(record.category, 'lesson');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('missing wiki root dies with not_found', async () => {
  const handle = makeHandler();
  await assert.rejects(
    () => handle({ flags: { wikiRoot: '/nonexistent/vault-xyz' } }),
    /wiki root not found/,
  );
});
