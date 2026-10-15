/**
 * vector-ops-adapter.test.cts
 *
 * Unit tests for the Vector Ops adapter (pure module, no electron/IPC).
 * Covers: T1 happy path, T2 missing file, T3 freshness tiers
 * (fresh <12h, stale 12-24h, expired >24h), edge malformed JSON,
 * Suggested Tickets brief section (G7), and R2 (no literal http(s)://
 * URLs in adapter source).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  loadLatestReport,
  loadLocalIntel,
  synthesizeRecommendations,
  synthesizeSignals,
  synthesizeBrief,
  synthesizeIntel,
  slugify,
  computeFreshness,
} = require('../vector-ops-adapter.cts');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDir = os.tmpdir();
/** @type {string[]} */
const createdFiles = [];

/**
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function writeTmpFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf-8');
  createdFiles.push(p);
  return p;
}

function makeReport(overrides = {}) {
  const now = new Date().toISOString();
  return {
    report: {
      generated_at: now,
      executive_summary: 'Daily intel summary',
      operator_take: 'Operator notes here',
      new_count: 3,
      project_fit: [
        {
          project: 'Ace',
          priority: 'P0',
          fit: 'High',
          why: 'Core product alignment',
          moves: ['Add agent lane to mission board', 'Split official updates'],
          mission_template: 'Source link + capability + surface',
        },
        {
          project: 'Hermes',
          priority: 'P1',
          fit: 'Med',
          why: 'Data pipeline improvements',
          moves: ['Optimize ingestion pipeline'],
          mission_template: '',
        },
      ],
      top_signals: [
        {
          category: 'GitHub',
          title: 'Test Signal Alpha',
          summary: 'A relevant signal about agent tooling',
          url: 'no-url',
          why: 'Relevant to Ace lanes',
          move: 'Evaluate and prototype',
          is_new: true,
          first_seen: '2026-06-04T08:00:00.000Z',
          source: 'GitHub Trending',
          source_label: 'GitHub Trending',
          score: 400,
        },
        {
          category: 'AI',
          title: 'Test Signal Beta',
          summary: 'Another test signal',
          url: 'no-url-2',
          why: 'Broader AI context',
          move: 'Track and brief',
          is_new: false,
          first_seen: '2026-06-03T08:00:00.000Z',
          source: 'HackerNews',
          source_label: 'HackerNews',
          score: 200,
        },
      ],
      vendor_updates: [],
      platform_changelogs: [],
      ...overrides,
    },
  };
}

afterEach(() => {
  for (const p of createdFiles.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore cleanup errors
    }
  }
});

// ---------------------------------------------------------------------------
// T1 — happy path
// ---------------------------------------------------------------------------

describe('T1 happy path', () => {
  it('loadLatestReport returns freshness=fresh for a recent report', () => {
    const now = Date.now();
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    const fixturePath = writeTmpFixture('vops-t1.json', JSON.stringify(fixture));

    const result = loadLatestReport({ path: fixturePath, now });

    expect(result.freshness).toBe('fresh');
    expect(result.report).not.toBeNull();
    expect(result.intelAsOf).toBe(fixture.report.generated_at);
    expect(result.path).toBe(fixturePath);
  });

  it('synthesizeRecommendations returns length=2 (one per project_fit), each with candidateMissionDraft', () => {
    const now = Date.now();
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;

    const recs = synthesizeRecommendations(report, { intelAsOf: report.generated_at });

    expect(recs.length).toBe(2);

    for (const rec of recs) {
      expect(rec.id).toMatch(/^rec:vops:/);
      expect(rec.decision).toBe('ask');
      expect(rec.owner).toBe('rook');
      expect(rec.severity).toBe('yellow');
      expect(typeof rec.confidence).toBe('number');
      expect(rec.candidateMissionDraft).toBeDefined();
      expect(rec.candidateMissionDraft).not.toBeNull();
      expect(rec.candidateMissionDraft.source).toBe('vector-ops');
      expect(rec.candidateMissionDraft.statusNote).toMatch(/CANDIDATE/);
      expect(rec.candidateMissionDraft.workspaceId).toBe('');
    }

    // P0 / High => risk high, confidence 0.8
    const aceRec = recs.find((r) => r.id.includes('ace'));
    expect(aceRec).toBeDefined();
    expect(aceRec.risk).toBe('high');
    expect(aceRec.confidence).toBe(0.8);

    // P1 / Med => risk medium, confidence 0.6
    const hermesRec = recs.find((r) => r.id.includes('hermes'));
    expect(hermesRec).toBeDefined();
    expect(hermesRec.risk).toBe('medium');
    expect(hermesRec.confidence).toBe(0.6);
  });

  it('synthesizeSignals returns length=2', () => {
    const now = Date.now();
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;

    const signals = synthesizeSignals(report, { intelAsOf: report.generated_at });

    expect(signals.length).toBe(2);
    for (const sig of signals) {
      expect(sig.id).toMatch(/^vops:/);
      expect(sig.source).toBe('vector-ops');
      expect(sig.severity).toBe('yellow');
      expect(sig.isLive).toBe(false);
      expect(typeof sig.title).toBe('string');
      expect(typeof sig.message).toBe('string');
    }
  });

  it('synthesizeBrief morning has non-empty sections, correct $schema, and candidateCount=2', () => {
    const now = Date.now();
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;

    const brief = synthesizeBrief(report, 'morning', {
      now,
      sourceFreshness: 'fresh',
      intelAsOf: report.generated_at,
    });

    expect(brief.$schema).toBe('ace.ops.brief.v1');
    expect(brief.lens).toBe('morning');
    expect(brief.sections.length).toBeGreaterThan(0);
    expect(brief.candidateCount).toBe(2);
    expect(brief.sourceFreshness).toBe('fresh');
    expect(brief.headline).toBeTruthy();
    expect(brief.intelAsOf).toBe(report.generated_at);
    expect(typeof brief.generatedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T2 — missing file
// ---------------------------------------------------------------------------

describe('T2 missing file', () => {
  it('loadLatestReport returns freshness=missing and report=null without throwing', () => {
    const result = loadLatestReport({ path: '/no/such/file.json' });

    expect(result.freshness).toBe('missing');
    expect(result.report).toBeNull();
    expect(result.intelAsOf).toBeNull();
  });

  it('synthesizeRecommendations returns [] when report is null', () => {
    expect(synthesizeRecommendations(null)).toEqual([]);
  });

  it('synthesizeSignals returns [] when report is null', () => {
    expect(synthesizeSignals(null)).toEqual([]);
  });

  it('synthesizeBrief returns valid brief with empty sections and sourceFreshness=missing when report is null', () => {
    const now = Date.now();
    const brief = synthesizeBrief(null, 'morning', {
      now,
      sourceFreshness: 'missing',
      intelAsOf: null,
    });

    expect(brief.$schema).toBe('ace.ops.brief.v1');
    expect(brief.sections).toEqual([]);
    expect(brief.sourceFreshness).toBe('missing');
    expect(brief.headline).toBe('Intel unavailable');
    expect(brief.candidateCount).toBe(0);
    expect(brief.deltaSummary).toBe('intel unavailable');
  });
});

// ---------------------------------------------------------------------------
// T3 — freshness tiers: <12h fresh, 12-24h stale, >24h expired
// ---------------------------------------------------------------------------

describe('T3 freshness tiers', () => {
  /**
   * @param {number} ageHours
   * @param {string} name
   */
  function loadWithAge(ageHours, name) {
    const now = Date.now();
    const generatedAt = new Date(now - ageHours * 60 * 60 * 1000).toISOString();
    const fixture = makeReport();
    fixture.report.generated_at = generatedAt;
    const fixturePath = writeTmpFixture(name, JSON.stringify(fixture));
    return { result: loadLatestReport({ path: fixturePath, now }), generatedAt };
  }

  it('returns freshness=fresh for a report generated 11h ago', () => {
    const { result } = loadWithAge(11, 'vops-t3-11h.json');
    expect(result.freshness).toBe('fresh');
    expect(result.report).not.toBeNull();
  });

  it('returns freshness=stale for a report generated 13h ago', () => {
    const { result } = loadWithAge(13, 'vops-t3-13h.json');
    expect(result.freshness).toBe('stale');
    expect(result.report).not.toBeNull();
  });

  it('returns freshness=expired for a report generated 25h ago and threads it into the brief', () => {
    const { result } = loadWithAge(25, 'vops-t3-25h.json');
    expect(result.freshness).toBe('expired');
    expect(result.report).not.toBeNull();

    const brief = synthesizeBrief(result.report, 'morning', {
      now: Date.now(),
      sourceFreshness: result.freshness,
      intelAsOf: result.intelAsOf,
    });
    expect(brief.sourceFreshness).toBe('expired');

    const intel = synthesizeIntel(result.report, {
      intelAsOf: result.intelAsOf,
      sourceFreshness: result.freshness,
    });
    expect(intel.sourceFreshness).toBe('expired');
  });

  it('returns freshness=expired for a report generated 48h ago, still returns data', () => {
    const { result, generatedAt } = loadWithAge(48, 'vops-t3.json');

    expect(result.freshness).toBe('expired');
    expect(result.report).not.toBeNull();
    expect(result.intelAsOf).toBe(generatedAt);

    // Expired but still produces recs and signals
    const recs = synthesizeRecommendations(result.report, { intelAsOf: result.intelAsOf });
    expect(recs.length).toBe(2);

    const signals = synthesizeSignals(result.report, { intelAsOf: result.intelAsOf });
    expect(signals.length).toBe(2);
  });

  it('computeFreshness maps unparseable/absent timestamps to expired, never fresh', () => {
    const now = Date.now();
    expect(computeFreshness('not-a-date', now)).toBe('expired');
    expect(computeFreshness(null, now)).toBe('expired');
    expect(computeFreshness(new Date(now - 60 * 1000).toISOString(), now)).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// G7 — Suggested Tickets brief section
// ---------------------------------------------------------------------------

describe('G7 suggested tickets brief section', () => {
  it('every lens includes a Suggested Tickets section built from recommendations', () => {
    const now = Date.now();
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;
    const recs = synthesizeRecommendations(report, { intelAsOf: report.generated_at });

    for (const lens of ['morning', 'midday', 'evening']) {
      const brief = synthesizeBrief(report, lens, {
        now,
        sourceFreshness: 'fresh',
        intelAsOf: report.generated_at,
      });

      const tickets = brief.sections.find((s) => s.title === 'Suggested Tickets');
      expect(tickets).toBeDefined();
      expect(tickets.items.length).toBe(recs.length);
      for (let i = 0; i < tickets.items.length; i++) {
        expect(tickets.items[i].text).toBe(recs[i].title);
        expect(tickets.items[i].why).toBe(recs[i].reason);
        expect(tickets.items[i].move).toBe(recs[i].nextAction);
      }
    }
  });

  it('caps Suggested Tickets at 5 items', () => {
    const now = Date.now();
    const fixture = makeReport({
      project_fit: Array.from({ length: 7 }, (_, i) => ({
        project: `Project ${i}`,
        priority: 'P1',
        fit: 'Med',
        why: `reason ${i}`,
        moves: [`move ${i}`],
        mission_template: '',
      })),
    });
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;

    expect(synthesizeRecommendations(report).length).toBe(7);

    const brief = synthesizeBrief(report, 'morning', {
      now,
      sourceFreshness: 'fresh',
      intelAsOf: report.generated_at,
    });
    const tickets = brief.sections.find((s) => s.title === 'Suggested Tickets');
    expect(tickets).toBeDefined();
    expect(tickets.items.length).toBe(5);
  });

  it('omits Suggested Tickets when there are no recommendations', () => {
    const now = Date.now();
    const fixture = makeReport({ project_fit: [], vendor_updates: [], platform_changelogs: [] });
    fixture.report.generated_at = new Date(now).toISOString();
    const { report } = fixture;

    const brief = synthesizeBrief(report, 'morning', {
      now,
      sourceFreshness: 'fresh',
      intelAsOf: report.generated_at,
    });
    const tickets = brief.sections.find((s) => s.title === 'Suggested Tickets');
    expect(tickets).toBeUndefined();
    expect(brief.candidateCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: malformed JSON
// ---------------------------------------------------------------------------

describe('edge: malformed JSON', () => {
  it('returns freshness=missing without throwing for a file with invalid JSON', () => {
    const fixturePath = writeTmpFixture('vops-malformed.json', '{ this is not valid json !!!');

    const result = loadLatestReport({ path: fixturePath });

    expect(result.freshness).toBe('missing');
    expect(result.report).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R2: no literal http(s):// in adapter source
// ---------------------------------------------------------------------------

describe('R2: no hardcoded URLs in adapter source', () => {
  it('the adapter source file contains no http:// or https:// literals', () => {
    const adapterPath = path.resolve(__dirname, '../vector-ops-adapter.cts');
    const source = fs.readFileSync(adapterPath, 'utf-8');
    const matches = source.match(/https?:\/\//g);
    expect(matches).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W4 — candidate provenance invariants (the promote path in CandidatesPanel
// relies on these being true for every candidate).
// ---------------------------------------------------------------------------

describe('candidate draft invariants (W4)', () => {
  const report = {
    generated_at: new Date().toISOString(),
    project_fit: [
      { project: 'Ace', priority: 'P0', fit: 'High', why: 'core input', moves: ['ship it'], mission_template: 'tmpl' },
      { project: 'SkyGems', priority: 'P2', fit: 'Low', why: 'maybe', moves: [], mission_template: '' },
    ],
    vendor_updates: [{ vendor: 'Anthropic', title: 'New model', summary: 'big', is_new: true }],
    platform_changelogs: [{ vendor: 'OpenAI', product: 'Codex', title: 'CLI', summary: 'update', is_new: true }],
  };

  it('every candidate draft has source vector-ops and a non-empty name', () => {
    const recs = synthesizeRecommendations(report);
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      expect(rec.candidateMissionDraft).toBeTruthy();
      expect(rec.candidateMissionDraft.source).toBe('vector-ops');
      expect(typeof rec.candidateMissionDraft.name).toBe('string');
      expect(rec.candidateMissionDraft.name.length).toBeGreaterThan(0);
      expect(rec.candidateMissionDraft.statusNote).toMatch(/CANDIDATE/);
    }
  });

  it('produces stable, unique recommendation ids', () => {
    const recs = synthesizeRecommendations(report);
    const ids = recs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // stable across runs
    const again = synthesizeRecommendations(report).map((r) => r.id);
    expect(again).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// synthesizeIntel — the full dashboard payload
// ---------------------------------------------------------------------------

describe('synthesizeIntel', () => {
  const report = {
    generated_at: new Date().toISOString(),
    executive_summary: 'lead signal',
    operator_take: 'do the thing',
    new_count: 7,
    seen_items_total: 100,
    top_signals: [{ title: 'Sig A', summary: 's', url: 'x', is_new: true, source_label: 'GitHub' }],
    vendor_updates: [{ title: 'V1', summary: 'v', is_new: false }],
    world_news: [{ title: 'W1', summary: 'w' }, { title: 'W2', summary: 'w2' }],
    project_fit: [{ project: 'Ace', priority: 'P0', fit: 'High', why: 'core', moves: ['ship'], mission_template: 't' }],
    project_moves: { facts: ['f1'], suggestions: ['s1', 's2'] },
    hot_ai_app: { app: 'CoolApp', summary: 'hot', url: 'u' },
  };
  const prices = [{ symbol: 'SPY', name: 'S&P', price: 754.24, change: -5.33, change_pct: -0.7, market_state: '2026-06-03' }];

  it('normalizes every populated section', () => {
    const intel = synthesizeIntel(report, { prices, sourceFreshness: 'fresh' });
    expect(intel.$schema).toBe('ace.ops.intel.v1');
    expect(intel.sourceFreshness).toBe('fresh');
    expect(intel.newCount).toBe(7);
    expect(intel.executiveSummary).toBe('lead signal');
    const keys = intel.sections.map((s) => s.key);
    expect(keys).toContain('top_signals');
    expect(keys).toContain('vendor_updates');
    expect(keys).toContain('world_news');
    const ts = intel.sections.find((s) => s.key === 'top_signals');
    expect(ts.items[0].title).toBe('Sig A');
    expect(ts.items[0].isNew).toBe(true);
    expect(intel.projectFit[0].project).toBe('Ace');
    expect(intel.projectMoves.suggestions.length).toBe(2);
    expect(intel.hotAiApp.title).toBe('CoolApp');
    expect(intel.prices[0].symbol).toBe('SPY');
  });

  it('omits empty sections', () => {
    const intel = synthesizeIntel(report, { prices: [] });
    expect(intel.sections.every((s) => s.items.length > 0)).toBe(true);
  });

  it('null report -> empty-but-valid payload, no throw', () => {
    const intel = synthesizeIntel(null, { prices: [] });
    expect(intel.$schema).toBe('ace.ops.intel.v1');
    expect(intel.sections.length).toBe(0);
    expect(intel.sourceFreshness).toBe('missing');
    expect(intel.executiveSummary).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Slugify helper
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces non-alnum with dashes', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });
  it('trims leading and trailing dashes', () => {
    expect(slugify('  --test--  ')).toBe('test');
  });
  it('caps at 40 chars', () => {
    const long = 'a'.repeat(50);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Structured item timestamps (R3 — from source data or null, never fabricated)
// ---------------------------------------------------------------------------

describe('structured item timestamps', () => {
  const now = Date.parse('2026-06-05T12:00:00.000Z');

  it('uses published_at as an ISO timestamp and keeps legacy meta untouched', () => {
    const report = {
      generated_at: new Date(now).toISOString(),
      official_feeds: [{ title: 'Feed A', summary: 's', published_at: '2026-06-04T08:00:00.000Z' }],
    };
    const intel = synthesizeIntel(report, { now });
    const section = intel.sections.find((s) => s.key === 'official_feeds');
    expect(section.items[0].timestamp).toBe('2026-06-04T08:00:00.000Z');
    expect(section.items[0].meta).toBe('2026-06-04T08:00:00.000Z');
  });

  it('falls back through published / pushed_at / first_seen', () => {
    const report = {
      generated_at: new Date(now).toISOString(),
      world_news: [{ title: 'News A', summary: 'w', published: '2026-06-04T01:00:00.000Z' }],
      github_watch: [{ repo: 'org/x', pushed_at: '2026-06-03T00:00:00.000Z' }],
      top_signals: [{ title: 'Sig', summary: 's', first_seen: '2026-06-02T00:00:00.000Z' }],
    };
    const intel = synthesizeIntel(report, { now });
    expect(intel.sections.find((s) => s.key === 'world_news').items[0].timestamp).toBe(
      '2026-06-04T01:00:00.000Z'
    );
    expect(intel.sections.find((s) => s.key === 'github_watch').items[0].timestamp).toBe(
      '2026-06-03T00:00:00.000Z'
    );
    expect(intel.sections.find((s) => s.key === 'top_signals').items[0].timestamp).toBe(
      '2026-06-02T00:00:00.000Z'
    );
  });

  it('absent or unparseable timestamps -> null, never fabricated', () => {
    const report = {
      generated_at: new Date(now).toISOString(),
      world_news: [{ title: 'No time', summary: 'a' }, { title: 'Bad time', summary: 'b', published_at: 'not-a-date' }],
    };
    const intel = synthesizeIntel(report, { now });
    const items = intel.sections.find((s) => s.key === 'world_news').items;
    expect(items[0].timestamp).toBeNull();
    expect(items[1].timestamp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadLocalIntel — ace.ops.intel-local.v1
// ---------------------------------------------------------------------------

describe('loadLocalIntel', () => {
  function makeLocal(overrides = {}) {
    return {
      $schema: 'ace.ops.intel-local.v1',
      generatedAt: '2026-06-05T10:00:00.000Z',
      sections: [
        {
          key: 'official_feeds',
          title: 'Official Feeds',
          provenance: 'live-pull',
          fetchedAt: '2026-06-05T10:00:00.000Z',
          items: [
            {
              id: 'feed:a:0',
              title: 'Local feed item',
              summary: 'ls',
              url: null,
              timestamp: '2026-06-05T09:30:00.000Z',
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('happy path: parses a valid local-intel file', () => {
    const p = writeTmpFixture('vops-local-ok.json', JSON.stringify(makeLocal()));
    const result = loadLocalIntel({ path: p });
    expect(result.path).toBe(p);
    expect(result.local).not.toBeNull();
    expect(result.local.sections[0].key).toBe('official_feeds');
  });

  it('missing opts.path -> { local: null, path: null }', () => {
    expect(loadLocalIntel()).toEqual({ local: null, path: null });
    expect(loadLocalIntel({})).toEqual({ local: null, path: null });
  });

  it('corrupt JSON -> local null, path preserved, no throw', () => {
    const p = writeTmpFixture('vops-local-corrupt.json', '{ nope');
    expect(loadLocalIntel({ path: p })).toEqual({ local: null, path: p });
  });

  it('wrong $schema -> local null', () => {
    const p = writeTmpFixture(
      'vops-local-schema.json',
      JSON.stringify({ $schema: 'other.v1', sections: [] })
    );
    expect(loadLocalIntel({ path: p }).local).toBeNull();
  });

  it('nonexistent file -> local null', () => {
    expect(loadLocalIntel({ path: '/no/such/local-intel.json' }).local).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// synthesizeIntel — local merge, per-section provenance/asOf/freshness (R4)
// ---------------------------------------------------------------------------

describe('synthesizeIntel local merge + per-section freshness', () => {
  const now = Date.parse('2026-06-05T12:00:00.000Z');
  const hoursAgo = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

  /**
   * @param {string} key
   * @param {string} title
   * @param {string} fetchedAt
   * @param {any[]} items
   */
  function localSection(key, title, fetchedAt, items) {
    return { key, title, provenance: 'live-pull', fetchedAt, items };
  }

  it('newer local section wins: items, provenance live-pull, asOf = fetchedAt', () => {
    const report = {
      generated_at: hoursAgo(6),
      official_feeds: [{ title: 'Report feed', summary: 'r', published_at: hoursAgo(7) }],
    };
    const localIntel = {
      $schema: 'ace.ops.intel-local.v1',
      generatedAt: hoursAgo(1),
      sections: [
        localSection('official_feeds', 'Official Feeds', hoursAgo(1), [
          { id: 'feed:a:0', title: 'Live feed', summary: 'l', url: null, timestamp: hoursAgo(2) },
        ]),
      ],
    };
    const intel = synthesizeIntel(report, { now, localIntel });
    const sec = intel.sections.find((s) => s.key === 'official_feeds');
    expect(sec.items.length).toBe(1);
    expect(sec.items[0].title).toBe('Live feed');
    expect(sec.items[0].timestamp).toBe(hoursAgo(2));
    expect(sec.provenance).toBe('live-pull');
    expect(sec.asOf).toBe(hoursAgo(1));
    expect(sec.freshness).toBe('fresh');
  });

  it('agent-leg sections carry provenance agent', () => {
    const report = { generated_at: hoursAgo(6) };
    const localIntel = {
      $schema: 'ace.ops.intel-local.v1',
      sections: [
        localSection('platform_accounts', 'Social / X', hoursAgo(1), [
          { id: 'x:0', title: 'Post', summary: 'p', url: null, timestamp: null, handle: '@someone' },
        ]),
      ],
    };
    const intel = synthesizeIntel(report, { now, localIntel });
    const sec = intel.sections.find((s) => s.key === 'platform_accounts');
    expect(sec.provenance).toBe('agent');
    expect(sec.items[0].handle).toBe('@someone');
    expect(sec.items[0].timestamp).toBeNull();
  });

  it('report wins when the local section is older', () => {
    const report = {
      generated_at: hoursAgo(1),
      official_feeds: [{ title: 'Report feed', summary: 'r' }],
    };
    const localIntel = {
      $schema: 'ace.ops.intel-local.v1',
      sections: [
        localSection('official_feeds', 'Official Feeds', hoursAgo(5), [
          { id: 'feed:a:0', title: 'Old live feed', summary: 'l', url: null, timestamp: null },
        ]),
      ],
    };
    const intel = synthesizeIntel(report, { now, localIntel });
    const sec = intel.sections.find((s) => s.key === 'official_feeds');
    expect(sec.items[0].title).toBe('Report feed');
    expect(sec.provenance).toBe('intel-report');
    expect(sec.asOf).toBe(report.generated_at);
  });

  it('local sections are used when the report is missing entirely', () => {
    const localIntel = {
      $schema: 'ace.ops.intel-local.v1',
      sections: [
        localSection('github_watch', 'GitHub Watch', hoursAgo(2), [
          { id: 'repo:org/x:0', title: 'org/x release', summary: 'rel', url: null, timestamp: hoursAgo(3) },
        ]),
      ],
    };
    const intel = synthesizeIntel(null, { now, localIntel });
    const sec = intel.sections.find((s) => s.key === 'github_watch');
    expect(sec).toBeDefined();
    expect(sec.provenance).toBe('live-pull');
    expect(sec.asOf).toBe(hoursAgo(2));
    expect(sec.items[0].title).toBe('org/x release');
  });

  it('per-section freshness tiers follow asOf, not the whole report', () => {
    const report = {
      generated_at: hoursAgo(25),
      top_signals: [{ title: 'Old signal', summary: 's' }],
    };
    const localIntel = {
      $schema: 'ace.ops.intel-local.v1',
      sections: [
        localSection('official_feeds', 'Official Feeds', hoursAgo(13), [
          { id: 'feed:a:0', title: 'Stale feed', summary: 'l', url: null, timestamp: null },
        ]),
      ],
    };
    const intel = synthesizeIntel(report, { now, localIntel });
    expect(intel.sections.find((s) => s.key === 'top_signals').freshness).toBe('expired');
    expect(intel.sections.find((s) => s.key === 'official_feeds').freshness).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// synthesizeIntel — sourceState mapping (R2/R4 honesty)
// ---------------------------------------------------------------------------

describe('synthesizeIntel sourceState mapping', () => {
  const now = Date.parse('2026-06-05T12:00:00.000Z');
  const hoursAgo = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

  it('non-ok empty sections are emitted with status (auth-needed stays visible)', () => {
    const report = { generated_at: hoursAgo(1), top_signals: [{ title: 'Sig', summary: 's' }] };
    const sourceState = {
      sources: [
        {
          id: 'agent:social',
          class: 'accounts',
          status: 'auth-needed',
          lastAttempt: hoursAgo(0),
          lastSuccess: null,
          error: 'agent leg disabled',
          itemCount: 0,
          label: 'Social / X',
        },
      ],
    };
    const intel = synthesizeIntel(report, { now, sourceState });
    const sec = intel.sections.find((s) => s.key === 'platform_accounts');
    expect(sec).toBeDefined();
    expect(sec.items).toEqual([]);
    expect(sec.status).toBe('auth-needed');
    expect(sec.statusMessage).toBe('agent leg disabled');
    expect(sec.lastAttempt).toBe(hoursAgo(0));
    expect(sec.lastSuccess).toBeNull();
    // Honest freshness: an empty section must NOT borrow the report's recent
    // generated_at and show a fabricated 'fresh' chip — with no own-pull
    // success its as-of is null and freshness degrades to 'expired'.
    expect(sec.asOf).toBeNull();
    expect(sec.freshness).toBe('expired');
  });

  it('empty errored section with a prior success reads from that lastSuccess, not the report', () => {
    const report = { generated_at: hoursAgo(1) }; // recent report, but feeds no items here
    const sourceState = {
      sources: [
        {
          id: 'agent:news',
          class: 'news',
          status: 'error',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(40), // last real data was >24h ago
          error: 'research agent timed out',
          itemCount: 0,
          label: 'World news',
        },
      ],
    };
    const intel = synthesizeIntel(report, { now, sourceState });
    const sec = intel.sections.find((s) => s.key === 'world_news');
    expect(sec).toBeDefined();
    expect(sec.items).toEqual([]);
    expect(sec.asOf).toBe(hoursAgo(40));
    expect(sec.freshness).toBe('expired'); // from lastSuccess, not the 1h-old report
  });

  it('empty + ok sections keep the filtered-out behavior', () => {
    const report = { generated_at: hoursAgo(1), top_signals: [{ title: 'Sig', summary: 's' }] };
    const sourceState = {
      sources: [
        {
          id: 'agent:news',
          class: 'news',
          status: 'ok',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(0),
          error: null,
          itemCount: 0,
          label: 'World news',
        },
      ],
    };
    const intel = synthesizeIntel(report, { now, sourceState });
    expect(intel.sections.find((s) => s.key === 'world_news')).toBeUndefined();
  });

  it('feed:* aggregate: worst status wins, lastSuccess is the newest', () => {
    const report = { generated_at: hoursAgo(1), official_feeds: [{ title: 'F', summary: 's' }] };
    const sourceState = {
      sources: [
        {
          id: 'feed:one',
          class: 'feeds',
          status: 'ok',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(0),
          error: null,
          itemCount: 4,
          label: 'Feed One',
        },
        {
          id: 'feed:two',
          class: 'feeds',
          status: 'error',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(9),
          error: 'HTTP 500',
          itemCount: 0,
          label: 'Feed Two',
        },
      ],
    };
    const intel = synthesizeIntel(report, { now, sourceState });
    const sec = intel.sections.find((s) => s.key === 'official_feeds');
    expect(sec.status).toBe('error');
    expect(sec.statusMessage).toBe('HTTP 500');
    expect(sec.lastSuccess).toBe(hoursAgo(0));
  });

  it('report:finance maps to a prices section when non-ok', () => {
    const report = { generated_at: hoursAgo(1), top_signals: [{ title: 'Sig', summary: 's' }] };
    const sourceState = {
      sources: [
        {
          id: 'report:finance',
          class: 'finance',
          status: 'unavailable',
          lastAttempt: hoursAgo(0),
          lastSuccess: null,
          error: null,
          itemCount: 0,
          label: 'Market prices',
        },
      ],
    };
    const intel = synthesizeIntel(report, { now, sourceState });
    const sec = intel.sections.find((s) => s.key === 'prices');
    expect(sec).toBeDefined();
    expect(sec.items).toEqual([]);
    expect(sec.status).toBe('unavailable');
  });

  it('lastRefreshAt is the newest lastSuccess across sources, null when untracked', () => {
    const report = { generated_at: hoursAgo(1) };
    const sourceState = {
      sources: [
        {
          id: 'feed:one',
          class: 'feeds',
          status: 'ok',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(2),
          error: null,
          itemCount: 1,
          label: 'Feed One',
        },
        {
          id: 'agent:news',
          class: 'news',
          status: 'ok',
          lastAttempt: hoursAgo(0),
          lastSuccess: hoursAgo(1),
          error: null,
          itemCount: 2,
          label: 'World news',
        },
      ],
    };
    expect(synthesizeIntel(report, { now, sourceState }).lastRefreshAt).toBe(hoursAgo(1));
    expect(synthesizeIntel(report, { now }).lastRefreshAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// synthesizeBrief — Source freshness section (R6)
// ---------------------------------------------------------------------------

describe('synthesizeBrief Source freshness section', () => {
  const now = Date.parse('2026-06-05T12:00:00.000Z');
  const hoursAgo = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

  /**
   * @param {any} sourceState
   */
  function makeBrief(sourceState) {
    const fixture = makeReport();
    fixture.report.generated_at = new Date(now).toISOString();
    return synthesizeBrief(fixture.report, 'morning', {
      now,
      sourceFreshness: 'fresh',
      intelAsOf: fixture.report.generated_at,
      sourceState,
    });
  }

  it('renders ok / error / unavailable lines per source class, as the last section', () => {
    const brief = makeBrief({
      sources: [
        {
          id: 'agent:social',
          class: 'accounts',
          status: 'ok',
          lastAttempt: hoursAgo(2),
          lastSuccess: hoursAgo(2),
          error: null,
          itemCount: 5,
          label: 'Social / X',
        },
        {
          id: 'repo:org/x',
          class: 'repos',
          status: 'error',
          lastAttempt: hoursAgo(1),
          lastSuccess: hoursAgo(20),
          error: 'gh exited 1',
          itemCount: 0,
          label: 'org/x',
        },
        {
          id: 'report:finance',
          class: 'finance',
          status: 'unavailable',
          lastAttempt: hoursAgo(1),
          lastSuccess: null,
          error: null,
          itemCount: 0,
          label: 'Market prices',
        },
      ],
    });
    const section = brief.sections[brief.sections.length - 1];
    expect(section.title).toBe('Source freshness');
    const texts = section.items.map((i) => i.text);
    expect(texts).toContain('Social / X — ok, 2h ago');
    expect(texts).toContain('GitHub watch — error: gh exited 1');
    expect(texts).toContain('Market prices — unavailable');
  });

  it('null sourceState -> single honest untracked line', () => {
    const brief = makeBrief(null);
    const section = brief.sections.find((s) => s.title === 'Source freshness');
    expect(section).toBeDefined();
    expect(section.items).toEqual([{ text: 'Source pull state untracked' }]);
  });
});

// ---------------------------------------------------------------------------
// synthesizeBrief — Intel Signals score ordering (R6)
// ---------------------------------------------------------------------------

describe('midday/evening Intel Signals score ordering', () => {
  it('sorts by score desc (missing score -> 0) before the top-5 cut', () => {
    const now = Date.parse('2026-06-05T12:00:00.000Z');
    const fixture = makeReport({
      top_signals: [
        { title: 'Low', summary: 's', score: 10 },
        { title: 'NoScore', summary: 's' },
        { title: 'High', summary: 's', score: 900 },
        { title: 'Mid1', summary: 's', score: 500 },
        { title: 'Mid2', summary: 's', score: 400 },
        { title: 'Mid3', summary: 's', score: 300 },
      ],
    });
    fixture.report.generated_at = new Date(now).toISOString();
    for (const lens of ['midday', 'evening']) {
      const brief = synthesizeBrief(fixture.report, lens, {
        now,
        sourceFreshness: 'fresh',
        intelAsOf: fixture.report.generated_at,
      });
      const signals = brief.sections.find((s) => s.title === 'Intel Signals');
      expect(signals.items.map((i) => i.text)).toEqual(['High', 'Mid1', 'Mid2', 'Mid3', 'Low']);
    }
  });
});
