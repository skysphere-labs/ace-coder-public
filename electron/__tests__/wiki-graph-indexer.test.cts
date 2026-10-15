/**
 * wiki-graph-indexer.test.cts
 *
 * Unit tests for wiki-graph-indexer (pure module, no electron/IPC).
 *
 * Test matrix:
 *   T1 — deterministic fixture (3-node vault, known edges, backlinks, confidence)
 *   T2 — missing root → empty graph, no throw
 *   T3 — raw/ provenance
 *   T4 — deterministic vault schema smoke
 *   T5 — readWikiPage happy path (+ node excerpt metadata)
 *   T6 — readWikiPage rejects traversal / absolute-path / symlink escapes
 *   T7 — readWikiPage rejects non-markdown files
 *   T8 — readWikiPage missing file → { ok:false }
 *   T9 — excerpt strips frontmatter + markdown syntax
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { buildWikiGraph, readWikiPage } = require('../wiki-graph-indexer.cts');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory tree for deterministic tests.
 * Returns the tmp root path.
 *
 * @param {Record<string, string>} files  - map of relative path → file content
 * @returns {string}
 */
function makeTmpVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-graph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

/**
 * Recursively remove a temp directory.
 * @param {string} dir
 */
function rmTmpVault(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// T1 — deterministic fixture
// ---------------------------------------------------------------------------

describe('T1: deterministic fixture (3 nodes, 2 edges)', () => {
  /** @type {string} */
  let tmpRoot;

  it('builds correct graph', () => {
    // Fixtures
    //   a.md  → links to [[b]]
    //   b.md  → links to [[sub/c]]
    //   sub/c.md → no outgoing links
    tmpRoot = makeTmpVault({
      'a.md':     '# A\n\n[[b]]\n',
      'b.md':     '# B\n\n[[sub/c]]\n',
      'sub/c.md': '# C\n',
    });

    try {
      // Use a fixed "now" in the past so freshness is deterministic based on
      // the mtime set by mkdtempSync (which is roughly Date.now()).
      // We pass now = Date.now() which means all files are 'fresh'.
      const graph = buildWikiGraph({ root: tmpRoot, now: Date.now() });

      // Basic shape
      expect(graph.$schema).toBe('ace.ops.wiki-graph.v1');
      expect(typeof graph.generatedAt).toBe('string');
      expect(graph.root).toBe(tmpRoot);

      // nodeCount
      expect(graph.stats.nodeCount).toBe(3);

      // edgeCount: a→b and b→sub/c
      expect(graph.stats.edgeCount).toBe(2);

      // All nodes present
      const ids = graph.nodes.map((n) => n.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('sub/c');

      // path field includes .md
      const nodeA = graph.nodes.find((n) => n.id === 'a');
      expect(nodeA).toBeDefined();
      expect(nodeA.path).toBe('a.md');

      const nodeB = graph.nodes.find((n) => n.id === 'b');
      const nodeC = graph.nodes.find((n) => n.id === 'sub/c');

      // title extracted from # heading
      expect(nodeA.title).toBe('A');
      expect(nodeB.title).toBe('B');
      expect(nodeC.title).toBe('C');

      // edges
      const hasEdge = (from, to) =>
        graph.edges.some((e) => e.from === from && e.to === to);
      expect(hasEdge('a', 'b')).toBe(true);
      expect(hasEdge('b', 'sub/c')).toBe(true);

      // backlinks
      expect(nodeB.backlinks).toBe(1);   // a → b
      expect(nodeC.backlinks).toBe(1);   // b → sub/c
      expect(nodeA.backlinks).toBe(0);   // nobody links to a

      // Every node: confidenceBasis is always 'heuristic'
      for (const node of graph.nodes) {
        expect(node.confidenceBasis).toBe('heuristic');
        expect(node.confidence).toBeGreaterThanOrEqual(0);
        expect(node.confidence).toBeLessThanOrEqual(1);
      }
    } finally {
      rmTmpVault(tmpRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — missing root → empty graph, no throw
// ---------------------------------------------------------------------------

describe('T2: missing root produces empty graph without throwing', () => {
  it('returns empty graph for a non-existent root', () => {
    const graph = buildWikiGraph({ root: '/no/such/path/wiki-graph-test-abc' });

    expect(graph.$schema).toBe('ace.ops.wiki-graph.v1');
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats.nodeCount).toBe(0);
    expect(graph.stats.edgeCount).toBe(0);
    expect(graph.stats.orphanCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T3 — raw/ provenance
// ---------------------------------------------------------------------------

describe('T3: raw/ provenance', () => {
  /** @type {string} */
  let tmpRoot;

  it('file under raw/ has provenance raw; file outside has provenance distilled', () => {
    tmpRoot = makeTmpVault({
      'raw/x.md':      '# X raw\n',
      'concepts/y.md': '# Y distilled\n',
    });

    try {
      const graph = buildWikiGraph({ root: tmpRoot, now: Date.now() });

      const rawNode = graph.nodes.find((n) => n.id === 'raw/x');
      expect(rawNode).toBeDefined();
      expect(rawNode.provenance).toBe('raw');

      const distilledNode = graph.nodes.find((n) => n.id === 'concepts/y');
      expect(distilledNode).toBeDefined();
      expect(distilledNode.provenance).toBe('distilled');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — deterministic vault schema smoke
// ---------------------------------------------------------------------------

describe('T4: vault schema smoke', () => {
  it('checks graph schema without reading a developer vault', () => {
    const vaultPath = makeTmpVault({
      'start.md': '# Start\nSee [[topic]].',
      'topic.md': '# Topic\nA synthetic note.',
    });
    try {
      const graph = buildWikiGraph({ root: vaultPath, now: Date.now() });
      expect(graph.stats.nodeCount).toBe(2);
      expect(graph.stats.edgeCount).toBe(1);
      for (const node of graph.nodes) {
        expect(node.confidenceBasis).toBe('heuristic');
        expect(node.confidence).toBeGreaterThanOrEqual(0);
        expect(node.confidence).toBeLessThanOrEqual(1);
        expect(['fresh', 'stale', 'expired', 'unknown']).toContain(node.freshness);
        expect(['distilled', 'raw', 'mixed']).toContain(node.provenance);
      }
    } finally {
      rmTmpVault(vaultPath);
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — readWikiPage happy path (+ node excerpt metadata)
// ---------------------------------------------------------------------------

describe('T5: readWikiPage happy path', () => {
  it('reads a page and returns title, content, mtime, sizeBytes, excerpt', () => {
    const tmpRoot = makeTmpVault({
      'page.md':
        '---\ntags: ace\nstatus: draft\n---\n# Hello Page\n\nThis is **bold** text with a [[target|alias]] and a [md link](https://example.com) inside.\n',
      'sub/nested.md': '# Nested\n\nNested body.\n',
    });

    try {
      const result = readWikiPage({ root: tmpRoot, relPath: 'page.md' });

      expect(result.ok).toBe(true);
      expect(result.relPath).toBe('page.md');
      expect(result.title).toBe('Hello Page');
      // content is raw — frontmatter preserved
      expect(result.content).toContain('---');
      expect(result.content).toContain('tags: ace');
      // mtime is a parseable ISO string
      expect(typeof result.mtime).toBe('string');
      expect(Number.isNaN(Date.parse(result.mtime))).toBe(false);
      // sizeBytes matches actual file size
      expect(result.sizeBytes).toBe(
        fs.statSync(path.join(tmpRoot, 'page.md')).size,
      );
      // excerpt: frontmatter + markdown syntax stripped
      expect(result.excerpt).toContain('Hello Page');
      expect(result.excerpt).toContain('bold');
      expect(result.excerpt).toContain('alias');
      expect(result.excerpt).toContain('md link');
      expect(result.excerpt).not.toContain('tags: ace');
      expect(result.excerpt).not.toContain('**');
      expect(result.excerpt).not.toContain('[[');
      expect(result.excerpt.length).toBeLessThanOrEqual(240);

      // nested subdirectory pages resolve too
      const nested = readWikiPage({ root: tmpRoot, relPath: 'sub/nested.md' });
      expect(nested.ok).toBe(true);
      expect(nested.relPath).toBe('sub/nested.md');
      expect(nested.title).toBe('Nested');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });

  it('graph nodes carry an excerpt for hover summaries', () => {
    const tmpRoot = makeTmpVault({
      'a.md': '---\ntags: ace\n---\n# A\n\nBody of a.\n',
    });

    try {
      const graph = buildWikiGraph({ root: tmpRoot, now: Date.now() });
      let nodeA;
      for (const node of graph.nodes) {
        if (node.id === 'a') nodeA = node;
      }
      expect(nodeA).toBeDefined();
      expect(typeof nodeA.excerpt).toBe('string');
      expect(nodeA.excerpt).toContain('Body of a.');
      expect(nodeA.excerpt).not.toContain('tags: ace');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — readWikiPage rejects escapes
// ---------------------------------------------------------------------------

describe('T6: readWikiPage rejects traversal / absolute / symlink escapes', () => {
  it('rejects ../ traversal', () => {
    const tmpRoot = makeTmpVault({ 'a.md': '# A\n' });
    try {
      const r1 = readWikiPage({ root: tmpRoot, relPath: '../../../etc/passwd' });
      expect(r1.ok).toBe(false);
      expect(r1.error).toBe('path-escape');

      const r2 = readWikiPage({ root: tmpRoot, relPath: '../escape.md' });
      expect(r2.ok).toBe(false);
      expect(r2.error).toBe('path-escape');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });

  it('rejects absolute paths', () => {
    const tmpRoot = makeTmpVault({ 'a.md': '# A\n' });
    try {
      const r1 = readWikiPage({ root: tmpRoot, relPath: '/etc/passwd' });
      expect(r1.ok).toBe(false);
      expect(r1.error).toBe('path-escape');

      // Even an absolute path that ends in .md is rejected
      const r2 = readWikiPage({
        root: tmpRoot,
        relPath: path.join(tmpRoot, 'a.md'),
      });
      expect(r2.ok).toBe(false);
      expect(r2.error).toBe('path-escape');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });

  it('rejects a symlink inside the vault pointing outside it', () => {
    const tmpRoot = makeTmpVault({ 'a.md': '# A\n' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-graph-outside-'));
    try {
      const secret = path.join(outside, 'secret.md');
      fs.writeFileSync(secret, '# Secret\n', 'utf-8');
      // Windows junctions exercise the same realpath escape check without
      // requiring the developer-mode privilege needed for file symlinks.
      const relPath = process.platform === 'win32' ? 'link/secret.md' : 'link.md';
      if (process.platform === 'win32') {
        fs.symlinkSync(outside, path.join(tmpRoot, 'link'), 'junction');
      } else {
        fs.symlinkSync(secret, path.join(tmpRoot, 'link.md'));
      }

      const r = readWikiPage({ root: tmpRoot, relPath });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('path-escape');
    } finally {
      rmTmpVault(tmpRoot);
      rmTmpVault(outside);
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — readWikiPage rejects non-markdown files
// ---------------------------------------------------------------------------

describe('T7: readWikiPage rejects non-markdown files', () => {
  it('returns not-markdown for a .txt file inside the vault', () => {
    const tmpRoot = makeTmpVault({ 'a.md': '# A\n' });
    try {
      fs.writeFileSync(path.join(tmpRoot, 'notes.txt'), 'plain text', 'utf-8');
      const r = readWikiPage({ root: tmpRoot, relPath: 'notes.txt' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-markdown');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// T8 — readWikiPage missing file
// ---------------------------------------------------------------------------

describe('T8: readWikiPage missing file', () => {
  it('returns { ok:false, error:not-found } without throwing', () => {
    const tmpRoot = makeTmpVault({ 'a.md': '# A\n' });
    try {
      const r = readWikiPage({ root: tmpRoot, relPath: 'nope.md' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-found');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });

  it('returns invalid-args for missing/empty relPath', () => {
    const r1 = readWikiPage({ root: '/tmp' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('invalid-args');

    const r2 = readWikiPage({ root: '/tmp', relPath: '   ' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('invalid-args');
  });
});

// ---------------------------------------------------------------------------
// T9 — excerpt strips frontmatter + markdown syntax
// ---------------------------------------------------------------------------

describe('T9: excerpt strips frontmatter and markdown syntax', () => {
  it('strips frontmatter, headings, emphasis, links, code, lists', () => {
    const tmpRoot = makeTmpVault({
      'rich.md': [
        '---',
        'tags: ace, project',
        'owner: someone',
        '---',
        '# Rich Title',
        '',
        '> A quoted line.',
        '',
        '- item one',
        '- item *two*',
        '',
        '```bash',
        'echo secret-code-block',
        '```',
        '',
        'Final `inline` paragraph with [a link](https://example.com).',
        '',
      ].join('\n'),
    });

    try {
      const r = readWikiPage({ root: tmpRoot, relPath: 'rich.md' });
      expect(r.ok).toBe(true);

      // Frontmatter gone
      expect(r.excerpt).not.toContain('tags:');
      expect(r.excerpt).not.toContain('owner:');
      expect(r.excerpt).not.toContain('---');

      // Markdown markers gone, text retained
      expect(r.excerpt).toContain('Rich Title');
      expect(r.excerpt).toContain('A quoted line.');
      expect(r.excerpt).toContain('item two');
      expect(r.excerpt).toContain('inline');
      expect(r.excerpt).toContain('a link');
      expect(r.excerpt).not.toContain('#');
      expect(r.excerpt).not.toContain('*');
      expect(r.excerpt).not.toContain('`');
      expect(r.excerpt).not.toContain('](');
      // Fenced code block content excluded
      expect(r.excerpt).not.toContain('secret-code-block');

      // Capped at ~240 chars
      expect(r.excerpt.length).toBeLessThanOrEqual(240);
    } finally {
      rmTmpVault(tmpRoot);
    }
  });

  it('handles a file with no frontmatter unchanged', () => {
    const tmpRoot = makeTmpVault({
      'plain.md': '# Plain\n\nJust a body, no frontmatter.\n',
    });
    try {
      const r = readWikiPage({ root: tmpRoot, relPath: 'plain.md' });
      expect(r.ok).toBe(true);
      expect(r.excerpt).toContain('Just a body, no frontmatter.');
    } finally {
      rmTmpVault(tmpRoot);
    }
  });
});
