import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  createKnowledgeIndex,
  containedRealPath,
  buildMatchExpression,
} = require('../knowledge-index.cts');

let tmpRoot = '';
let vaultRoot = '';
let index;

function writePage(relPath, content) {
  const target = path.join(vaultRoot, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function opsSource() {
  return { source: 'ops-wiki', root: vaultRoot, project: null };
}

const CANON_LESSON = [
  '---',
  'schema: AceOpsPage/v1',
  'kind: lesson',
  'title: Release gate lesson',
  'trust: canon',
  'sources: [run_1]',
  'tags: [ace, lesson]',
  'updatedAt: __NOW__',
  '---',
  '',
  '# Release gate lesson',
  'Always verify the release gate before merging to main.',
].join('\n');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-'));
  vaultRoot = path.join(tmpRoot, 'vault');
  fs.mkdirSync(vaultRoot, { recursive: true });
  index = createKnowledgeIndex({ Database, dbPath: path.join(tmpRoot, 'knowledge.db') });
});

afterEach(() => {
  index?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('knowledge-index reindex', () => {
  it('indexes vault pages with inferred trust/kind and skips secret content', () => {
    writePage('lessons/release-gate.md', CANON_LESSON.replace('__NOW__', new Date().toISOString()));
    writePage('raw/leaky.md', '# Leak\napi_key: abcd1234efgh5678ijkl');
    writePage('journal/2026/2026-06-10.md', '# 2026-06-10\n- release gate checked');

    const stats = index.reindex({ sources: [opsSource()] });
    expect(stats.indexed).toBe(2);
    expect(stats.skipped).toBe(1); // secret page never reaches the index

    const described = index.describe();
    expect(described.total).toBe(2);
    const hit = index.search({ query: 'release gate' });
    expect(hit.results.length).toBeGreaterThan(0);
    expect(hit.results[0].trust).toBe('canon');
    expect(hit.results[0].kind).toBe('lesson');
  });

  it('is incremental: unchanged untouched, edits re-indexed, deletions removed, rebuild identical', () => {
    const pagePath = writePage('concepts/orchestration.md', '# Orchestration\nWorkers run in worktrees.');
    writePage('concepts/static.md', '# Static\nNever changes.');
    index.reindex({ sources: [opsSource()] });

    // edit (bump mtime + size)
    fs.writeFileSync(pagePath, '# Orchestration\nWorkers run in isolated git worktrees now.');
    const second = index.reindex({ sources: [opsSource()] });
    expect(second.indexed).toBe(1);

    // delete
    fs.rmSync(pagePath);
    const third = index.reindex({ sources: [opsSource()] });
    expect(third.removed).toBe(1);
    expect(index.describe().total).toBe(1);

    // disposability: rebuild from scratch matches
    const rebuilt = createKnowledgeIndex({ Database, dbPath: ':memory:' });
    rebuilt.reindex({ sources: [opsSource()] });
    expect(rebuilt.describe().total).toBe(index.describe().total);
    rebuilt.close();
  });

  it('indexes legacy pages (inline Tags:/Updated:) without frontmatter', () => {
    writePage('concepts/legacy.md', [
      '# Ace Orchestration Model',
      '',
      'Tags: concept, ace, orchestrator',
      'Updated: 2026-04-23 13:01:21 EDT',
      '',
      'Orchestrators stay concise.',
    ].join('\n'));
    index.reindex({ sources: [opsSource()] });
    const hit = index.search({ query: 'orchestrators concise' });
    expect(hit.results.length).toBe(1);
    expect(hit.results[0].tags).toContain('ace');
    expect(hit.results[0].trust).toBe('canon'); // concepts/ default
  });

  it('indexes dump records as raw tier', () => {
    const dumpRoot = path.join(tmpRoot, 'wiki-dump');
    fs.mkdirSync(path.join(dumpRoot, 'orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(dumpRoot, 'orchestrator', 'dump_1.json'), JSON.stringify({
      schema: 'AceDumpRecord/v1', kind: 'operator_note', identity: 'orchestrator',
      projectId: 'prj_42', title: 'Mission smoke', summary: 'Smoke test passed on the release gate.',
      capturedAt: new Date().toISOString(),
    }));
    index.reindex({ sources: [{ source: 'project-dump', root: dumpRoot, project: 'prj_42' }] });
    const hit = index.search({ query: 'smoke release gate', includeDecayed: true });
    expect(hit.results.length).toBe(1);
    expect(hit.results[0].trust).toBe('raw');
    expect(hit.results[0].project).toBe('prj_42');
  });
});

describe('knowledge-index search ranking', () => {
  it('ranks canon above raw for the same content', () => {
    const now = new Date().toISOString();
    writePage('lessons/gate.md', CANON_LESSON.replace('__NOW__', now));
    writePage('inbox/gate-note.md', '# Gate note\nAlways verify the release gate before merging to main.');
    index.reindex({ sources: [opsSource()] });
    const hits = index.search({ query: 'release gate merging', includeDecayed: true });
    expect(hits.results.length).toBe(2);
    expect(hits.results[0].trust).toBe('canon');
    expect(hits.results[1].trust).toBe('raw');
    expect(hits.results[0].score).toBeGreaterThan(hits.results[1].score);
  });

  it('filters by tier, kind, tag and project', () => {
    writePage('lessons/gate.md', CANON_LESSON.replace('__NOW__', new Date().toISOString()));
    writePage('inbox/gate-note.md', '# Gate note\nrelease gate idea');
    index.reindex({ sources: [opsSource()] });
    expect(index.search({ query: 'release gate', tier: 'canon' }).results.every((r) => r.trust === 'canon')).toBe(true);
    expect(index.search({ query: 'release gate', kind: 'lesson' }).results.every((r) => r.kind === 'lesson')).toBe(true);
    expect(index.search({ query: 'release gate', tags: ['lesson'] }).results.length).toBe(1);
    expect(index.search({ query: 'release gate', project: 'prj_none' }).results.length).toBe(0);
  });

  it('decay excludes below floor by default, includeDecayed surfaces with reasons', () => {
    const target = writePage('lessons/gate.md', CANON_LESSON.replace('__NOW__', new Date().toISOString()));
    index.reindex({ sources: [opsSource()] });
    index.setDecay(target, 0.1, ['contamination-pattern']);

    expect(index.search({ query: 'release gate' }).results.length).toBe(0);
    const included = index.search({ query: 'release gate', includeDecayed: true });
    expect(included.results.length).toBe(1);
    expect(included.results[0].decay).toBe(0.1);
    expect(included.results[0].decayReasons).toContain('contamination-pattern');
  });

  it('expired expiresAt facts decay out of default results', () => {
    writePage('todo/exam.md', [
      '---',
      'schema: AceOpsPage/v1',
      'kind: todo',
      'trust: working',
      'tags: [todo]',
      'expiresAt: 2026-01-01T00:00:00Z',
      '---',
      'Prepare for the certification exam tomorrow.',
    ].join('\n'));
    index.reindex({ sources: [opsSource()] });
    expect(index.search({ query: 'certification exam' }).results.length).toBe(0);
    const included = index.search({ query: 'certification exam', includeDecayed: true });
    expect(included.results.length).toBe(1);
    expect(included.results[0].decayReasons).toContain('expired-fact');
  });

  it('caps limit and survives hostile queries', () => {
    writePage('concepts/a.md', '# A\nalpha beta gamma');
    index.reindex({ sources: [opsSource()] });
    expect(index.search({ query: 'alpha" OR 1=1; DROP TABLE docs; --' }).results).toBeDefined();
    expect(index.search({ query: 'NEAR( AND OR NOT' }).results).toBeDefined();
    expect(index.search({ query: '' }).results).toEqual([]);
    expect(index.describe().total).toBe(1); // table still alive
  });
});

describe('containment + match expression', () => {
  it('contains paths to registered roots, blocking traversal and symlink escapes', () => {
    const inside = writePage('concepts/inside.md', '# Inside');
    const outside = path.join(tmpRoot, 'outside.md');
    fs.writeFileSync(outside, '# Outside');
    expect(containedRealPath(inside, [vaultRoot])).toBe(fs.realpathSync(inside));
    expect(containedRealPath(outside, [vaultRoot])).toBe(null);
    expect(containedRealPath(path.join(vaultRoot, '..', 'outside.md'), [vaultRoot])).toBe(null);

    const link = process.platform === 'win32'
      ? path.join(vaultRoot, 'sneaky', 'outside.md')
      : path.join(vaultRoot, 'sneaky.md');
    if (process.platform === 'win32') {
      fs.symlinkSync(tmpRoot, path.join(vaultRoot, 'sneaky'), 'junction');
    } else {
      fs.symlinkSync(outside, link);
    }
    expect(containedRealPath(link, [vaultRoot])).toBe(null);
  });

  it('builds quoted prefix match expressions', () => {
    expect(buildMatchExpression('release gate')).toBe('"release" "gate"*');
    expect(buildMatchExpression('  weird"quote  ')).toBe('"weirdquote"*');
    expect(buildMatchExpression('')).toBe(null);
  });
});

describe('knowledge-index extra sources (PR2)', () => {
  it('indexes memory candidates from completion.json, one doc per candidate', () => {
    const runRoot = path.join(tmpRoot, 'run');
    const runDir = path.join(runRoot, 'run_1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'completion.json'), JSON.stringify({
      schema: 'ace.completion_result.v1',
      runId: 'run_1',
      outcome: 'done',
      memoryCandidates: [
        { claim: 'Scope vitest with --dir in this repo.', category: 'lesson', evidence: 'run_1 logs', confidence: 0.9 },
        { claim: 'We standardize on FTS5 for knowledge search.', category: 'decision' },
        { notAClaim: true },
      ],
    }));
    const source = { source: 'memory-candidate', root: runRoot, project: 'prj_42' };
    const stats = index.reindex({ sources: [source] });
    expect(stats.indexed).toBe(2);

    const hit = index.search({ query: 'vitest scope' });
    expect(hit.results.length).toBe(1);
    expect(hit.results[0].trust).toBe('working');
    expect(hit.results[0].kind).toBe('lesson');
    expect(hit.results[0].tags).toContain('lesson');
    expect(hit.results[0].path.endsWith('#0')).toBe(true);

    // unchanged file → no rework; removing the file removes both docs
    expect(index.reindex({ sources: [source] }).indexed).toBe(0);
    fs.rmSync(path.join(runDir, 'completion.json'));
    expect(index.reindex({ sources: [source] }).removed).toBe(2);
  });

  it('indexes custom-collector docs (hermes pattern) incrementally', () => {
    const docs = [{
      source: 'hermes-memory',
      path: '/virtual/state.db#mem_1',
      relPath: 'state.db#mem_1',
      project: 'ws_1',
      title: 'remembers the owner prefers dark mode',
      kind: 'reference',
      trust: 'external',
      tags: [],
      updatedAt: new Date().toISOString(),
      expiresAt: null,
      mtimeMs: 111,
      sizeBytes: 42,
      body: 'The owner prefers dark mode dashboards.',
      excerpt: 'The owner prefers dark mode dashboards.',
    }];
    const source = { source: 'hermes-memory', root: tmpRoot, format: 'custom', collect: () => docs };
    expect(index.reindex({ sources: [source] }).indexed).toBe(1);
    expect(index.reindex({ sources: [source] }).indexed).toBe(0); // same mtime/size → skip

    const hit = index.search({ query: 'dark mode dashboards' });
    expect(hit.results[0].trust).toBe('external');
    expect(hit.results[0].project).toBe('ws_1');

    // collector returning empty → docs removed (vanished source)
    expect(index.reindex({ sources: [{ ...source, collect: () => [] }] }).removed).toBe(1);
  });
});

describe('knowledge-index overview (PR7)', () => {
  it('aggregates per-agent, hermes, project and recent-activity views', () => {
    writePage('runs/2026-06/run-1.md', '---\nschema: AceOpsPage/v1\nkind: run-digest\ntrust: working\ntitle: Run one\nupdatedAt: 2026-06-10T01:00:00Z\n---\nDigest.');
    writePage('journal/2026/2026-06-10.md', '---\nschema: AceOpsPage/v1\nkind: journal\ntrust: working\ntitle: Journal 2026-06-10\nupdatedAt: 2026-06-10T02:00:00Z\n---\n- did things');
    const dumpRoot = path.join(tmpRoot, 'wiki-dump');
    fs.mkdirSync(path.join(dumpRoot, 'worker-7', '2026-06-10'), { recursive: true });
    fs.writeFileSync(path.join(dumpRoot, 'worker-7', '2026-06-10', 'dump_1.json'), JSON.stringify({
      schema: 'AceDumpRecord/v1', kind: 'memory_note', identity: 'worker-7',
      projectId: 'prj_42', title: 'A lesson', summary: 'Lesson body text.',
      capturedAt: '2026-06-10T03:00:00Z',
    }));
    index.reindex({ sources: [
      opsSource(),
      { source: 'project-dump', root: dumpRoot, project: 'prj_42' },
      { source: 'hermes-memory', root: tmpRoot, format: 'custom', collect: () => [{
        source: 'hermes-memory', path: '/virtual/state.db#mem_9', relPath: 'state.db#mem_9',
        project: 'ws_9', title: 'pref', kind: 'reference', trust: 'external', tags: [],
        updatedAt: '2026-06-10T04:00:00Z', expiresAt: null, mtimeMs: 9, sizeBytes: 9,
        body: 'owner pref', excerpt: 'owner pref',
      }] },
    ] });

    const result = index.overview();
    expect(result.agents).toEqual([{ identity: 'worker-7', project: 'prj_42', docs: 1, lastAt: '2026-06-10T03:00:00.000Z' }]);
    expect(result.hermes[0]).toMatchObject({ workspace: 'ws_9', docs: 1 });
    expect(result.recentRuns[0].title).toBe('Run one');
    expect(result.recentJournal[0].title).toBe('Journal 2026-06-10');
    expect(result.byProject.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });
});
