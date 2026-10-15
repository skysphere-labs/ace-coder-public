import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createKnowledgeIndex } = require('../knowledge-index.cts');

let tmpRoot = '';
let dumpRoot = '';
let index;

function writeDump(name, capturedAt) {
  const file = path.join(dumpRoot, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: 'AceDumpRecord/v1',
    kind: 'operator_note',
    identity: 'worker',
    projectId: 'prj_1',
    // identical title + summary → identical FTS relevance for both docs
    title: 'Widget deploy checklist',
    summary: 'release gate widget deploy checklist steps',
    capturedAt,
  }));
  return file;
}

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-raw-decay-'));
  dumpRoot = path.join(tmpRoot, 'wiki-dump');
  fs.mkdirSync(dumpRoot, { recursive: true });
  index = createKnowledgeIndex({ Database, dbPath: ':memory:' });
});

afterEach(() => {
  index?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('raw-tier time decay in search ranking', () => {
  it('sinks a stale raw doc below a fresh raw doc of equal FTS relevance, into a demoted bucket', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    const freshFile = writeDump('fresh', new Date(now).toISOString());
    const oldFile = writeDump('old', new Date(now - 120 * DAY_MS).toISOString());

    index.reindex({ sources: [{ source: 'project-dump', root: dumpRoot, project: 'prj_1' }] });

    const hits = index.search({ query: 'widget deploy checklist', now });
    const results = hits.results;
    expect(results.length).toBe(2); // both survive — demotion, not deletion

    const fresh = results.find((r) => r.path === freshFile);
    const old = results.find((r) => r.path === oldFile);
    expect(fresh).toBeTruthy();
    expect(old).toBeTruthy();

    // Ordering: fresh ranks above stale.
    expect(results[0].path).toBe(freshFile);
    expect(fresh.score).toBeGreaterThan(old.score);

    // Fresh raw carries no time decay; stale raw is demoted below 0.5 and tagged.
    expect(fresh.decay).toBe(1);
    expect(fresh.decayReasons).not.toContain('stale-raw');
    expect(old.decay).toBeLessThan(fresh.decay);
    expect(old.decay).toBeLessThan(0.5);
    expect(old.decayReasons).toContain('stale-raw');
  });

  it('never pushes a stale raw doc below the retrieval floor by time alone', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    // A very old raw doc (2 years) still surfaces in default (non-decayed) search.
    writeDump('ancient', new Date(now - 730 * DAY_MS).toISOString());
    index.reindex({ sources: [{ source: 'project-dump', root: dumpRoot, project: 'prj_1' }] });

    const hits = index.search({ query: 'widget deploy checklist', now });
    expect(hits.results.length).toBe(1);
    // Floored at the retrieval floor (0.3) so time alone never excludes it.
    expect(hits.results[0].decay).toBeGreaterThanOrEqual(0.3);
    expect(hits.results[0].decay).toBeLessThan(0.5);
    expect(hits.results[0].decayReasons).toContain('stale-raw');
  });
});
