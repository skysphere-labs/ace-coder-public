const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWikiKnowledgeHandlers } = require('../wiki-knowledge-handlers.cts');
const curator = require('../project-wiki-curator.cts');
const wk = require('../wiki-knowledge.cts');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wkh-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  return dir;
}
function handlers(projectDir) {
  const errors = [];
  const die = (e) => { errors.push(e); throw new Error(e.message || e.error); };
  const h = createWikiKnowledgeHandlers({
    die,
    normalizeText: (v) => String(v == null ? '' : v).trim(),
    resolveProjectDirFlag: (flags) => (flags && flags.projectDir) || projectDir,
    describeCommands: () => [],
  });
  return { h, errors };
}

// --- memory explain: canon-first + citations + labeled raw fallback (A5) ----

test('A5.1/A5.2 memory explain returns a canon answer WITH citations', async () => {
  const dir = project();
  curator.writeDumpRecord({ projectDir: dir, record: { kind: 'operator_note', identity: 'chief', projectId: 'prj_x', projectName: 'X', summary: 'The release gate requires a validator PASS before any merge' } });
  curator.backfillProject({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  const { h } = handlers(dir);
  const result = await h.handleMemoryExplain({ positionals: ['release gate validator'], flags: {} });
  assert.equal(result.found, true);
  assert.equal(result.rawFallback, false);
  assert.equal(result.label, 'canon');
  assert.ok(result.source.trust === 'canon');
  assert.ok(Array.isArray(result.citations) && result.citations.length > 0);
});

test('A5.1 memory explain labels a raw fallback when no canon hit exists', async () => {
  const dir = project();
  // Only a raw dump exists — no canon yet.
  curator.writeDumpRecord({ projectDir: dir, record: { kind: 'operator_note', identity: 'chief', projectId: 'prj_x', summary: 'an obscure xyzzy detail worth recording' } });
  const { h } = handlers(dir);
  const result = await h.handleMemoryExplain({ positionals: ['xyzzy detail'], flags: {} });
  assert.equal(result.found, true);
  assert.equal(result.rawFallback, true);
  assert.match(result.label, /raw-fallback/);
});

test('memory explain requires a query', async () => {
  const dir = project();
  const { h } = handlers(dir);
  await assert.rejects(() => h.handleMemoryExplain({ positionals: [], flags: {} }), /query required/);
});

// --- wiki health: dump-only flag + metrics (A6.1 / A6.3) -------------------

test('A6.3 wiki health flags a dump-only project (would have caught the bug)', async () => {
  const dir = project();
  curator.writeDumpRecord({ projectDir: dir, record: { kind: 'operator_note', identity: 'chief', projectId: 'prj_x', summary: 'dump with no canon yet' } });
  const { h } = handlers(dir);
  const health = await h.handleWikiHealth({ flags: {} });
  assert.equal(health.schema, 'AceWikiHealth/v1');
  assert.equal(health.dumpOnlyCount, 1);
  assert.equal(health.severity, 'amber');
  assert.ok(health.flags.some((f) => /dump-only/.test(f)));
});

test('A6.1 wiki health reports the required metrics after backfill', async () => {
  const dir = project();
  curator.writeDumpRecord({ projectDir: dir, record: { kind: 'operator_note', identity: 'chief', projectId: 'prj_x', projectName: 'X', summary: 'release gate requires validator PASS' } });
  curator.backfillProject({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  const { h } = handlers(dir);
  const health = await h.handleWikiHealth({ flags: {} });
  for (const key of ['lastNightlyAt', 'dumpOnlyProjects', 'candidatesAccepted', 'candidatesRejected', 'stalePages', 'sourceCoverage', 'rawVsCanonRatio', 'indexFreshness', 'canonPages']) {
    assert.ok(key in health, `missing metric: ${key}`);
  }
  assert.equal(health.dumpOnlyCount, 0);
  assert.ok(health.canonPages > 0);
});

test('memory status surfaces canon-vs-raw and reinforces Markdown-is-truth', async () => {
  const dir = project();
  curator.backfillProject({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  const { h } = handlers(dir);
  const status = await h.handleMemoryStatus({ flags: {} });
  assert.equal(status.schema, 'AceMemoryStatus/v1');
  assert.match(status.note, /source of truth/i);
});

// --- wiki inbox + promote CLI handlers -------------------------------------

test('wiki inbox lists pending and wiki promote writes canon', async () => {
  const dir = project();
  curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_x', projectName: 'X' });
  wk.appendKnowledgeEvent({ projectDir: dir, event: { kind: 'chief_decision', projectId: 'prj_x', projectName: 'X', summary: 'New gate policy replaces the prior one', confidence: 0.95 } });
  wk.curateFromEvents({ projectDir: dir });

  const { h } = handlers(dir);
  const inbox = await h.handleWikiInbox({ flags: {} });
  assert.ok(inbox.pending >= 1);
  const promoted = await h.handleWikiPromote({ positionals: [inbox.entries[0].inboxId], flags: {} });
  assert.equal(promoted.promoted, true);
  assert.ok(promoted.written.length >= 1);
});

test('wiki writeback ingests a WIKI_UPDATE packet from --text', async () => {
  const dir = project();
  const { h } = handlers(dir);
  const text = ['DONE: done', 'WIKI_UPDATE:', '  project: prj_x', '  events:', '    - kind: goal_done', '      summary: shipped the slice'].join('\n');
  const result = await h.handleWikiWriteback({ flags: { text } });
  assert.equal(result.events.length, 1);
  assert.equal(wk.readKnowledgeEvents({ projectDir: dir }).length, 1);
});
