const test = require('node:test');
const assert = require('node:assert/strict');

// The knowledge contract is shared by the electron app AND the standalone CLI;
// these pure helpers (explain shaping, health summary, sensitivity/confidence
// normalisation) are tested here from the CLI side.
const {
  explainFromResults,
  summarizeWikiHealth,
  normalizeConfidence,
  normalizeSensitivity,
  isAutoPromotableSensitivity,
  isRetrievableSensitivity,
} = require('../../../../electron/harness/knowledge-contract.cts');

// --- explainFromResults (A5.1 / A5.2 / A5.3) -------------------------------

test('explain prefers canon over raw and cites the canon page sources (A5.1/A5.2)', () => {
  const results = [
    { path: '/p/raw.json', relPath: 'raw.json', trust: 'raw', title: 'raw note', excerpt: 'raw', score: 0.9 },
    { path: '/p/canon.md', relPath: 'projects/x.md', trust: 'canon', title: 'X', excerpt: 'the canon answer', score: 0.5 },
  ];
  const out = explainFromResults({ query: 'q', results, citationsByPath: { '/p/canon.md': ['evt_abc', 'evt_def'] } });
  assert.equal(out.rawFallback, false);
  assert.equal(out.label, 'canon');
  assert.equal(out.source.trust, 'canon');
  assert.deepEqual(out.citations, ['evt_abc', 'evt_def']);
});

test('explain labels a raw fallback when no canon hit exists (A5.1)', () => {
  const out = explainFromResults({ query: 'q', results: [{ path: '/p/raw.json', relPath: 'raw.json', trust: 'raw', excerpt: 'raw', score: 0.9 }] });
  assert.equal(out.rawFallback, true);
  assert.match(out.label, /raw-fallback/);
});

test('explain never returns forbidden-sensitivity results (A5.3)', () => {
  const results = [
    { path: '/p/secret.md', relPath: 'secret.md', trust: 'canon', sensitivity: 'forbidden', excerpt: 'secret', score: 0.9 },
    { path: '/p/ok.md', relPath: 'ok.md', trust: 'canon', sensitivity: 'public', excerpt: 'public answer', score: 0.4 },
  ];
  const out = explainFromResults({ query: 'q', results });
  assert.equal(out.source.path, '/p/ok.md');
  assert.equal(out.totalCount, 1);
  assert.ok(!out.alternatives.some((a) => a.path === '/p/secret.md'));
});

test('explain reports no-match cleanly', () => {
  const out = explainFromResults({ query: 'q', results: [] });
  assert.equal(out.found, false);
  assert.equal(out.label, 'no-match');
  assert.deepEqual(out.citations, []);
});

// --- summarizeWikiHealth (A6.1 / A6.3) -------------------------------------

test('health flags dump-only projects and computes raw-vs-canon (A6.3)', () => {
  const out = summarizeWikiHealth({
    now: Date.parse('2026-06-14T12:00:00Z'),
    projects: [
      { id: 'prj_a', dumpOnly: true, canonPages: 0, dumpRecords: 3 },
      { id: 'prj_b', dumpOnly: false, canonPages: 5, pagesWithSources: 5, dumpRecords: 2 },
    ],
    nightly: { at: '2026-06-14T03:30:00Z', status: 'ok' },
  });
  assert.deepEqual(out.dumpOnlyProjects, ['prj_a']);
  assert.equal(out.severity, 'amber');
  assert.equal(out.rawVsCanonRatio, 1); // (3+2) raw / 5 canon
  assert.ok(out.flags.some((f) => /dump-only/.test(f)));
});

test('health is green when everything is fresh, sourced and inbox is empty', () => {
  const out = summarizeWikiHealth({
    now: Date.parse('2026-06-14T12:00:00Z'),
    projects: [{ id: 'prj_b', dumpOnly: false, canonPages: 4, pagesWithSources: 4, dumpRecords: 1 }],
    nightly: { at: '2026-06-14T03:30:00Z', status: 'ok' },
  });
  assert.equal(out.severity, 'green');
  assert.equal(out.healthy, true);
  assert.deepEqual(out.flags, []);
});

test('health is black when the last nightly errored', () => {
  const out = summarizeWikiHealth({ projects: [], nightly: { at: '2026-06-14T03:30:00Z', status: 'error' } });
  assert.equal(out.severity, 'black');
});

test('health surfaces a never-run nightly and zero-canon raw', () => {
  const out = summarizeWikiHealth({ projects: [{ id: 'p', dumpOnly: true, canonPages: 0, dumpRecords: 2 }] });
  assert.equal(out.lastNightlyStatus, 'never');
  assert.equal(out.rawVsCanonRatio, null); // raw with zero canon — the dangerous shape
  assert.ok(out.flags.some((f) => /never run/.test(f)));
});

// --- normalisation helpers -------------------------------------------------

test('normalizeConfidence maps labels and clamps numbers', () => {
  assert.equal(normalizeConfidence('high'), 0.9);
  assert.equal(normalizeConfidence('medium'), 0.6);
  assert.equal(normalizeConfidence(1.5), 1);
  assert.equal(normalizeConfidence('0.42'), 0.42);
  assert.equal(normalizeConfidence(undefined), 0.5);
});

test('sensitivity helpers gate promotion and retrieval', () => {
  assert.equal(normalizeSensitivity('weird'), 'internal');
  assert.equal(isAutoPromotableSensitivity('public'), true);
  assert.equal(isAutoPromotableSensitivity('internal'), true);
  assert.equal(isAutoPromotableSensitivity('restricted'), false);
  assert.equal(isAutoPromotableSensitivity('forbidden'), false);
  assert.equal(isRetrievableSensitivity('restricted'), true);
  assert.equal(isRetrievableSensitivity('forbidden'), false);
});
