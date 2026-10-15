const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('../wiki-generate.cts');
const wk = require('../wiki-knowledge.cts');

function tempProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wiki-generate-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function canonText(projectDir: string, rel: string): string {
  return fs.readFileSync(path.join(projectDir, '.ace', 'wiki', rel), 'utf8');
}

// --- pure: factSafe ---------------------------------------------------------

test('factSafe keeps concrete facts and drops short / supersede / stale ones', () => {
  const { factSafe } = gen._internal;
  assert.equal(factSafe('Package name: ace-demo (version 1.0.0).'), 'Package name: ace-demo (version 1.0.0).');
  assert.equal(factSafe('too short'), null);                              // < 12 chars
  assert.equal(factSafe('This replaces the old behavior entirely now.'), null); // supersede marker
  assert.equal(factSafe('Run ace-tui task run to dispatch a worker.'), null); // retired surface
  assert.equal(factSafe('Use mission create to open a lane somewhere.'), null);   // retired verb
  // long facts get truncated with an ellipsis
  const long = 'x'.repeat(400);
  const out = gen._internal.factSafe(long);
  assert.ok(out && out.length <= 280 && out.endsWith('…'));
});

// --- pure: surveyRepo / plan ------------------------------------------------

test('surveyRepo produces an ordered, source-grounded plan with input hashes', () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'demo-app', version: '2.1.0', description: 'A demo', scripts: { build: 'x', test: 'y' } }),
    'README.md': '# Demo App\n\n## Getting Started\nstuff\n\n## Architecture\nmore\n',
    '.ace/FEATURES.json': JSON.stringify({ features: [{ id: 'F1', title: 'Login' }, { id: 'F2', title: 'Logout' }] }),
  });
  const plan = gen.surveyRepo({ projectDir: dir });
  const ids = plan.map((p: any) => p.id);
  // dependency order preserved; only collectors that found source appear
  assert.deepEqual(ids, ['overview', 'readme', 'features']);
  const overview = plan.find((p: any) => p.id === 'overview');
  assert.ok(overview.facts.some((f: string) => f.includes('demo-app')));
  assert.ok(overview.inputHashes['package.json'] && /^[0-9a-f]{16}$/.test(overview.inputHashes['package.json']));
  assert.ok(/^[0-9a-f]{16}$/.test(overview.pageHash));
});

// --- pure: incremental diff -------------------------------------------------

test('diffIncremental marks unchanged pages fresh and changed/new pages stale', () => {
  const dir = tempProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'README.md': '# Demo\n## A\n' });
  const plan1 = gen.surveyRepo({ projectDir: dir });
  const manifest0 = gen.readManifest(dir);
  assert.deepEqual(gen.diffIncremental(plan1, manifest0).stale.map((p: any) => p.id), ['overview', 'readme']); // all new

  gen.writeManifest(dir, plan1, '2026-06-18T00:00:00.000Z');
  const manifest1 = gen.readManifest(dir);
  assert.equal(gen.diffIncremental(plan1, manifest1).stale.length, 0); // nothing changed

  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n## A\n## B added\n');
  const plan2 = gen.surveyRepo({ projectDir: dir });
  const diff2 = gen.diffIncremental(plan2, manifest1);
  assert.deepEqual(diff2.stale.map((p: any) => p.id), ['readme']); // only README changed
  assert.deepEqual(diff2.fresh.map((p: any) => p.id), ['overview']);
});

// --- integration: real tiered gate writes canon -----------------------------

test('generate() flows facts through the REAL gate and auto-promotes to canon', () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'ace-demo', version: '0.1.0', description: 'demo project' }),
    'README.md': '# Ace Demo\n\n## Overview\nx\n## Usage\ny\n',
  });
  const report = gen.generate({ projectDir: dir, now: '2026-06-18T00:00:00.000Z' });

  assert.equal(report.schema, 'AceWikiGenerate/v1');
  assert.equal(report.projectName, 'ace-demo');
  assert.ok(report.surveyed >= 2);
  assert.equal(report.regenerated, report.surveyed); // full run
  assert.ok(report.eventsAppended >= 2);
  assert.ok(report.curation.autoPromoted > 0, 'expected source-grounded facts to auto-promote');

  // Canon project page exists and cites the facts.
  const page = canonText(dir, 'projects/ace-demo.md');
  assert.match(page, /---[\s\S]*---/);             // frontmatter present
  assert.match(page, /ace-demo/);
  assert.ok(fs.existsSync(gen.manifestPathFor(dir)));
});

test('generate() is idempotent and incremental: a clean re-run regenerates nothing', () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'ace-demo', version: '0.1.0', description: 'demo' }),
    'README.md': '# Ace Demo\n## Overview\nx\n',
  });
  gen.generate({ projectDir: dir, now: '2026-06-18T00:00:00.000Z' });
  const before = canonText(dir, 'projects/ace-demo.md');

  const second = gen.generate({ projectDir: dir, incremental: true, now: '2026-06-18T01:00:00.000Z' });
  assert.equal(second.regenerated, 0, 'unchanged sources should regenerate nothing');
  assert.equal(second.eventsAppended, 0, 'content-addressed events dedupe on re-run');
  const after = canonText(dir, 'projects/ace-demo.md');
  assert.equal(before, after, 'canon must be unchanged when nothing changed');

  // Change a source → exactly that page regenerates.
  fs.writeFileSync(path.join(dir, 'README.md'), '# Ace Demo\n## Overview\nx\n## New Section\nz\n');
  const third = gen.generate({ projectDir: dir, incremental: true, now: '2026-06-18T02:00:00.000Z' });
  assert.equal(third.regenerated, 1);
  assert.equal(third.pages.find((p: any) => p.id === 'readme').regenerated, true);
  assert.equal(third.pages.find((p: any) => p.id === 'overview').regenerated, false);
});

// --- wiring: CLI handler + command registry ---------------------------------

test('handleWikiGenerate handler drives generate() end-to-end', async () => {
  const { createWikiKnowledgeHandlers } = require('../wiki-knowledge-handlers.cts');
  const dir = tempProject({
    'package.json': JSON.stringify({ name: 'ace-demo', version: '0.1.0', description: 'demo' }),
    'README.md': '# Ace Demo\n## Overview\nx\n',
  });
  const handlers = createWikiKnowledgeHandlers({
    die: (e: any) => { throw new Error(JSON.stringify(e)); },
    normalizeText: (v: any) => String(v == null ? '' : v).trim(),
    resolveProjectDirFlag: (flags: any) => flags.projectDir || dir,
    describeCommands: () => [],
  });
  const report = await handlers.handleWikiGenerate({ flags: { projectDir: dir }, positionals: [] });
  assert.equal(report.schema, 'AceWikiGenerate/v1');
  assert.ok(report.curation.autoPromoted > 0);
  assert.ok(fs.existsSync(path.join(dir, '.ace', 'wiki', 'projects', 'ace-demo.md')));

  // dry-run path through the handler
  const dir2 = tempProject({ 'package.json': JSON.stringify({ name: 'demo2' }), 'README.md': '# D\n## A\n' });
  const dryReport = await handlers.handleWikiGenerate({ flags: { projectDir: dir2, dryRun: true }, positionals: [] });
  assert.equal(dryReport.dryRun, true);
  assert.equal(fs.existsSync(path.join(dir2, '.ace', 'wiki')), false);
});

test('commands registry exposes `wiki generate` with the expected contract', () => {
  const registry = require('../commands.cts');
  const cmd = registry.getCommand('wiki generate');
  assert.ok(cmd, 'wiki generate must be registered');
  assert.equal(cmd.ipcMethod, 'special:wikiGenerate');
  const flagNames = (cmd.flags || []).map((f: any) => f.name);
  for (const expected of ['--incremental', '--dry-run', '--project-dir']) {
    assert.ok(flagNames.includes(expected), `missing flag ${expected}`);
  }
});

test('generate() dry-run writes nothing', () => {
  const dir = tempProject({ 'package.json': JSON.stringify({ name: 'ace-demo' }), 'README.md': '# D\n## A\n' });
  const report = gen.generate({ projectDir: dir, dryRun: true, now: '2026-06-18T00:00:00.000Z' });
  assert.equal(report.dryRun, true);
  assert.equal(report.eventsAppended, 0);
  assert.equal(report.curation, null);
  assert.equal(fs.existsSync(gen.manifestPathFor(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki')), false);
  // gate never invoked
  assert.equal(wk.readKnowledgeEvents({ projectDir: dir }).length, 0);
});
