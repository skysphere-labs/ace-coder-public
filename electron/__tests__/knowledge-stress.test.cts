import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createKnowledgeIndex } = require('../knowledge-index.cts');
const { createMemoryHandlers } = require('../../tools/ace/src/memory-handlers.cts');

const CORPUS_SIZE = 2000;

let tmpRoot = '';
let vaultRoot = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-stress-'));
  vaultRoot = path.join(tmpRoot, 'vault');
  fs.mkdirSync(vaultRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedCorpus() {
  const topics = ['release', 'worktree', 'rotation', 'dispatch', 'validator', 'updater', 'telemetry', 'sandbox'];
  const dirs = ['lessons', 'decisions', 'concepts', 'journal/2026', 'inbox', 'references'];
  for (let i = 0; i < CORPUS_SIZE; i += 1) {
    const dir = dirs[i % dirs.length];
    const topic = topics[i % topics.length];
    const target = path.join(vaultRoot, dir, `page-${i}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, [
      `# ${topic} note ${i}`,
      '',
      `Operational ${topic} knowledge entry number ${i}. Shared vocabulary: ace mission pipeline.`,
      `Unique marker token alpha${i}omega.`,
    ].join('\n'));
  }
}

describe('knowledge-plane stress smoke', () => {
  it('indexes ~2k docs quickly, searches fast, and rebuilds identically after db loss', () => {
    seedCorpus();
    const dbPath = path.join(tmpRoot, 'knowledge.db');
    const index = createKnowledgeIndex({ Database, dbPath });
    const sources = [{ source: 'ops-wiki', root: vaultRoot, project: null }];

    const indexStart = Date.now();
    const stats = index.reindex({ sources });
    const indexMs = Date.now() - indexStart;
    expect(stats.indexed).toBe(CORPUS_SIZE);
    expect(indexMs, `full index took ${indexMs}ms`).toBeLessThan(30_000);

    // incremental pass over unchanged corpus is near-free
    const incrementalStart = Date.now();
    expect(index.reindex({ sources }).indexed).toBe(0);
    expect(Date.now() - incrementalStart, 'incremental pass').toBeLessThan(5_000);

    // search latency over the full corpus
    const searchStart = Date.now();
    for (let i = 0; i < 50; i += 1) {
      const hit = index.search({ query: `unique marker alpha${i * 7}omega` });
      expect(hit.results.length).toBeGreaterThan(0);
    }
    const perSearchMs = (Date.now() - searchStart) / 50;
    expect(perSearchMs, `avg search ${perSearchMs}ms`).toBeLessThan(200);

    // disposability: delete the db, rebuild, identical doc count
    const total = index.describe().total;
    index.close();
    fs.rmSync(dbPath, { force: true });
    const rebuilt = createKnowledgeIndex({ Database, dbPath });
    rebuilt.reindex({ sources });
    expect(rebuilt.describe().total).toBe(total);
    rebuilt.close();
  });

  it('absorbs concurrent remember writes from distinct identities with zero loss', async () => {
    const projectDir = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const { handleMemoryRemember } = createMemoryHandlers({
      die: (payload) => { throw Object.assign(new Error(payload.message), payload); },
      normalizeText: (value) => String(value == null ? '' : value).trim(),
      resolveProjectDirFlag: () => projectDir,
    });

    const WRITERS = 8;
    const CLAIMS_PER_WRITER = 25;
    const writes = [];
    for (let writer = 0; writer < WRITERS; writer += 1) {
      for (let claim = 0; claim < CLAIMS_PER_WRITER; claim += 1) {
        writes.push(handleMemoryRemember({
          positionals: [`Writer ${writer} durable claim number ${claim} about pipeline stage ${claim % 5}.`],
          flags: { category: 'lesson', projectId: 'prj_stress', identity: `worker-${writer}` },
        }));
      }
    }
    const results = await Promise.all(writes);
    expect(results.length).toBe(WRITERS * CLAIMS_PER_WRITER);
    expect(results.every((result) => result.quarantined === false)).toBe(true);

    // every record landed on disk under its own identity dir
    const dumpRoot = path.join(projectDir, '.ace', 'wiki-dump');
    let found = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json')) found += 1;
      }
    };
    walk(dumpRoot);
    expect(found).toBe(WRITERS * CLAIMS_PER_WRITER);
    expect(fs.readdirSync(dumpRoot).filter((name) => name.startsWith('worker-')).length).toBe(WRITERS);
  });

  it('poison injection: secrets and contamination never reach default search results', () => {
    seedCorpus();
    // plant poison
    fs.writeFileSync(path.join(vaultRoot, 'lessons', 'poison-secret.md'),
      '# Poison\nThe deploy key is token: abcdef1234567890XYZ for the pipeline.');
    fs.writeFileSync(path.join(vaultRoot, 'inbox', 'poison-dormant.md'),
      '# Dormant wall\ndormant (12): stream inventory wall pipeline.');

    const index = createKnowledgeIndex({ Database, dbPath: ':memory:' });
    index.reindex({ sources: [{ source: 'ops-wiki', root: vaultRoot, project: null }] });

    // secret page is not indexed at all
    const secretHits = index.search({ query: 'deploy key token', includeDecayed: true });
    expect(secretHits.results.every((hit) => !hit.relPath.includes('poison-secret'))).toBe(true);

    // contaminated raw page exists but decays out once the audit flags it
    index.setDecay(path.join(vaultRoot, 'inbox', 'poison-dormant.md'), 0.1, ['contamination:raw-dormant-stream']);
    const dormantHits = index.search({ query: 'dormant stream inventory wall' });
    expect(dormantHits.results.every((hit) => !hit.relPath.includes('poison-dormant'))).toBe(true);
    index.close();
  });
});
