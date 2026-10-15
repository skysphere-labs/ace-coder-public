import { afterEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LOCAL_INTEL_FILE,
  OPS_REFRESH_HISTORY_FILE,
  OPS_REFRESH_STATE_FILE,
  buildResearchPrompt,
  deriveSourceRegistry,
  mostRecentPastSlot,
  parseFeedXml,
  parseResearchOutput,
  refreshStatus,
  runOpsRefresh,
  scheduleOpsSourceCatchUp,
} = require('../ops-refresh.cts');

// ---------------------------------------------------------------------------
// tmpdir fixtures (cleaned in afterEach per house idiom)
// ---------------------------------------------------------------------------
const tmpDirs = [];
function makeStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-refresh-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// Fixed reference clock (UTC ISO keeps assertions stable).
const fixedNow = new Date('2026-06-05T08:00:00.000Z');
const fixedNowIso = fixedNow.toISOString();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First &amp; foremost</title>
      <link>https://example.invalid/posts/1</link>
      <guid>https://example.invalid/posts/1</guid>
      <pubDate>Wed, 03 Jun 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello &lt;world&gt; &quot;quoted&quot; &#39;apos&#39;</p>]]></description>
    </item>
    <item>
      <title>No date item</title>
      <link>https://example.invalid/posts/2</link>
      <description>Plain text</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <id>tag:example,2026:entry-1</id>
    <title>Atom entry one</title>
    <link rel="self" href="https://example.invalid/self/1"/>
    <link rel="alternate" href="https://example.invalid/atom/1"/>
    <published>2026-06-02T08:30:00Z</published>
    <summary>Atom summary text</summary>
  </entry>
  <entry>
    <id>tag:example,2026:entry-2</id>
    <title>Atom entry two</title>
    <link href="https://example.invalid/atom/2"/>
    <updated>2026-06-01T10:00:00Z</updated>
  </entry>
</feed>`;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('exports the contract file names', () => {
    expect(OPS_REFRESH_STATE_FILE).toBe('ops-source-state.json');
    expect(OPS_REFRESH_HISTORY_FILE).toBe('ops-refresh.ndjson');
    expect(LOCAL_INTEL_FILE).toBe('ops-intel-local.json');
  });
});

// ---------------------------------------------------------------------------
// deriveSourceRegistry
// ---------------------------------------------------------------------------
describe('deriveSourceRegistry', () => {
  it('derives per-feed/per-repo sources plus the four aggregates', () => {
    const registry = deriveSourceRegistry({
      feeds: ['https://a.invalid/rss', 'https://b.invalid/atom'],
      accounts: ['@x', '@y'],
      repos: ['octo/repo'],
      changelogs: ['VendorOne', 'VendorTwo'],
    });
    const ids = registry.map((s) => s.id);
    expect(ids).toEqual([
      'feed:https://a.invalid/rss',
      'feed:https://b.invalid/atom',
      'repo:octo/repo',
      'agent:social',
      'agent:vendors',
      'agent:news',
      'report:finance',
    ]);

    const feed = registry[0];
    expect(feed.class).toBe('feeds');
    expect(feed.target).toBe('https://a.invalid/rss');

    const repo = registry.find((s) => s.id === 'repo:octo/repo');
    expect(repo.class).toBe('repos');
    expect(repo.target).toBe('octo/repo');

    const social = registry.find((s) => s.id === 'agent:social');
    expect(social.class).toBe('accounts');
    expect(social.label).toBe('Social / X (research agent)');
    expect(social.target).toEqual(['@x', '@y']);

    const vendors = registry.find((s) => s.id === 'agent:vendors');
    expect(vendors.class).toBe('changelogs');
    expect(vendors.target).toEqual(['VendorOne', 'VendorTwo']);

    const news = registry.find((s) => s.id === 'agent:news');
    expect(news.class).toBe('news');
    expect(news.label).toBe('World news (research agent)');
    expect(news.target).toEqual([]);

    const finance = registry.find((s) => s.id === 'report:finance');
    expect(finance.class).toBe('finance');
    expect(finance.label).toBe('Market prices (intel report)');
    expect(finance.target).toEqual([]);
  });

  it('always includes the aggregate sources even for empty/junk watchlists', () => {
    for (const input of [{}, null, undefined, 42, { feeds: 'bad' }]) {
      const ids = deriveSourceRegistry(input).map((s) => s.id);
      expect(ids).toEqual(['agent:social', 'agent:vendors', 'agent:news', 'report:finance']);
    }
  });

  it('dedupes repeated feed urls so registry ids stay unique', () => {
    const registry = deriveSourceRegistry({
      feeds: ['https://a.invalid/rss', 'https://a.invalid/rss'],
    });
    expect(registry.filter((s) => s.class === 'feeds')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseFeedXml
// ---------------------------------------------------------------------------
describe('parseFeedXml', () => {
  it('parses RSS 2.0 items with entity decoding and tag stripping', () => {
    const items = parseFeedXml(RSS_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('First & foremost');
    expect(items[0].url).toBe('https://example.invalid/posts/1');
    expect(items[0].id).toBe('https://example.invalid/posts/1');
    expect(items[0].timestamp).toBe('2026-06-03T12:00:00.000Z');
    expect(items[0].summary).toBe('Hello <world> "quoted" \'apos\'');
  });

  it('returns null timestamps for dateless items — never the current time', () => {
    const items = parseFeedXml(RSS_FIXTURE);
    expect(items[1].title).toBe('No date item');
    expect(items[1].timestamp).toBe(null);
  });

  it('returns null timestamp for an unparseable date', () => {
    const xml =
      '<rss><channel><item><title>T</title><pubDate>not a date</pubDate></item></channel></rss>';
    expect(parseFeedXml(xml)[0].timestamp).toBe(null);
  });

  it('parses Atom entries preferring the rel="alternate" link href', () => {
    const items = parseFeedXml(ATOM_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Atom entry one');
    expect(items[0].url).toBe('https://example.invalid/atom/1');
    expect(items[0].id).toBe('tag:example,2026:entry-1');
    expect(items[0].timestamp).toBe('2026-06-02T08:30:00.000Z');
    expect(items[0].summary).toBe('Atom summary text');
    // Entry two: first href link + <updated> fallback.
    expect(items[1].url).toBe('https://example.invalid/atom/2');
    expect(items[1].timestamp).toBe('2026-06-01T10:00:00.000Z');
  });

  it('caps output at 20 items per feed', () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `<item><title>Item ${i}</title><link>https://example.invalid/p/${i}</link></item>`
    ).join('');
    expect(parseFeedXml(`<rss version="2.0"><channel>${many}</channel></rss>`)).toHaveLength(20);
  });

  it('truncates long summaries to ~280 chars', () => {
    const xml = `<rss><channel><item><title>T</title><description>${'a'.repeat(400)}</description></item></channel></rss>`;
    const summary = parseFeedXml(xml)[0].summary;
    expect(summary.length).toBeLessThanOrEqual(280);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('returns [] for malformed or non-XML input', () => {
    expect(parseFeedXml('<<<garbage')).toEqual([]);
    expect(parseFeedXml('plain text, no feed here')).toEqual([]);
    expect(parseFeedXml('')).toEqual([]);
    expect(parseFeedXml(null)).toEqual([]);
    expect(parseFeedXml(undefined)).toEqual([]);
    expect(parseFeedXml(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildResearchPrompt
// ---------------------------------------------------------------------------
describe('buildResearchPrompt', () => {
  it('includes handles, vendors, section keys, and the JSON-only instruction', () => {
    const prompt = buildResearchPrompt({
      accounts: ['@alpha', '@beta'],
      vendors: ['VendorOne', 'VendorTwo'],
      nowIso: fixedNowIso,
    });
    expect(prompt).toContain('@alpha');
    expect(prompt).toContain('@beta');
    expect(prompt).toContain('VendorOne');
    expect(prompt).toContain('VendorTwo');
    expect(prompt).toContain(fixedNowIso);
    expect(prompt).toContain('platform_accounts');
    expect(prompt).toContain('world_news');
    expect(prompt).toContain('vendor_updates');
    expect(prompt).toContain('ONLY a single JSON object');
    expect(prompt).toContain('NEVER invent');
    expect(prompt).toContain('null');
  });

  it('never throws on junk input', () => {
    expect(() => buildResearchPrompt()).not.toThrow();
    expect(() => buildResearchPrompt(null)).not.toThrow();
    expect(typeof buildResearchPrompt({ accounts: 42, vendors: null })).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// parseResearchOutput
// ---------------------------------------------------------------------------
describe('parseResearchOutput', () => {
  const goodJson = JSON.stringify({
    sections: [
      {
        key: 'world_news',
        items: [
          {
            title: 'Big model release',
            summary: 'A summary',
            url: 'https://example.invalid/news/1',
            timestamp: '2026-06-05T06:00:00Z',
          },
        ],
      },
    ],
  });

  it('parses fenced JSON', () => {
    const out = parseResearchOutput('```json\n' + goodJson + '\n```');
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].key).toBe('world_news');
    expect(out.sections[0].items[0].title).toBe('Big model release');
  });

  it('parses JSON surrounded by dirty prefix/suffix prose', () => {
    const out = parseResearchOutput('Sure! Here is what I found:\n' + goodJson + '\nHope that helps.');
    expect(out.sections[0].items).toHaveLength(1);
  });

  it('drops malformed items and coerces fields', () => {
    const out = parseResearchOutput(
      JSON.stringify({
        sections: [
          {
            key: 'platform_accounts',
            items: [
              42,
              { summary: 'no title' },
              { title: 'Good post', url: 7, timestamp: 12345, handle: '@a' },
            ],
          },
        ],
      })
    );
    expect(out.sections[0].items).toEqual([
      { title: 'Good post', summary: '', url: null, timestamp: null, handle: '@a' },
    ]);
  });

  it('drops sections with disallowed keys', () => {
    const out = parseResearchOutput(
      JSON.stringify({ sections: [{ key: 'bogus', items: [{ title: 'X' }] }] })
    );
    expect(out).toEqual({ sections: [] });
  });

  it('returns null for garbage or shape mismatches', () => {
    expect(parseResearchOutput('no json here at all')).toBe(null);
    expect(parseResearchOutput('{"sections":"bad"}')).toBe(null);
    expect(parseResearchOutput('{not json}')).toBe(null);
    expect(parseResearchOutput('')).toBe(null);
    expect(parseResearchOutput(null)).toBe(null);
    expect(parseResearchOutput(42)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// runOpsRefresh
// ---------------------------------------------------------------------------
describe('runOpsRefresh', () => {
  const feedUrl = 'https://example.invalid/feed.xml';
  const watchlists = {
    feeds: [feedUrl],
    accounts: ['@alpha'],
    repos: ['octo/repo'],
    changelogs: ['VendorOne'],
  };
  const okFetch = async () => ({ ok: true, status: 200, text: async () => RSS_FIXTURE });
  const okExecGh = async () =>
    JSON.stringify([
      {
        name: 'v1.2.3',
        tag_name: 'v1.2.3',
        html_url: 'https://example.invalid/rel/1',
        published_at: '2026-06-04T12:00:00Z',
      },
    ]);
  const okRunAgent = async () =>
    JSON.stringify({
      sections: [
        {
          key: 'platform_accounts',
          items: [
            {
              title: 'Post',
              summary: 's',
              url: 'https://example.invalid/x/1',
              timestamp: '2026-06-05T07:00:00Z',
              handle: '@alpha',
            },
          ],
        },
        { key: 'world_news', items: [{ title: 'News', summary: 'n', url: null, timestamp: null }] },
        { key: 'vendor_updates', items: [] },
      ],
    });

  it('happy path: persists state, history, and local intel with provenance', async () => {
    const stateDir = makeStateDir();
    const localIntelPath = path.join(stateDir, LOCAL_INTEL_FILE);
    const fetchCalls = [];
    const result = await runOpsRefresh({
      watchlists,
      stateDir,
      localIntelPath,
      trigger: 'manual',
      lens: 'morning',
      now: () => fixedNow,
      fetchImpl: async (url, opts) => {
        fetchCalls.push({ url, opts });
        return okFetch();
      },
      execGh: okExecGh,
      research: { enabled: true, runAgent: okRunAgent },
      reportFreshness: 'fresh',
    });

    expect(result.at).toBe(fixedNowIso);
    expect(result.trigger).toBe('manual');
    expect(result.lens).toBe('morning');
    expect(result.localIntelPath).toBe(localIntelPath);
    expect(result.sources).toHaveLength(6);
    expect(fetchCalls).toEqual([{ url: feedUrl, opts: { timeoutMs: 10000 } }]);

    // -- state file --
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, OPS_REFRESH_STATE_FILE), 'utf8'));
    expect(state.$schema).toBe('ace.ops.source-state.v1');
    expect(state.updatedAt).toBe(fixedNowIso);
    const feed = state.sources[`feed:${feedUrl}`];
    expect(feed.status).toBe('ok');
    expect(feed.lastAttempt).toBe(fixedNowIso);
    expect(feed.lastSuccess).toBe(fixedNowIso);
    expect(feed.itemCount).toBe(2);
    expect(feed.error).toBe(null);
    const repo = state.sources['repo:octo/repo'];
    expect(repo.status).toBe('ok');
    expect(repo.itemCount).toBe(1);
    expect(state.sources['agent:social'].status).toBe('ok');
    expect(state.sources['agent:social'].itemCount).toBe(1);
    expect(state.sources['agent:news'].status).toBe('ok');
    // empty items array from the agent is still a success
    expect(state.sources['agent:vendors'].status).toBe('ok');
    expect(state.sources['agent:vendors'].itemCount).toBe(0);
    // finance: ok from report freshness, but no fabricated success time
    expect(state.sources['report:finance'].status).toBe('ok');
    expect(state.sources['report:finance'].lastSuccess).toBe(null);

    // -- history line --
    const lines = fs
      .readFileSync(path.join(stateDir, OPS_REFRESH_HISTORY_FILE), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const run = JSON.parse(lines[0]);
    expect(run.at).toBe(fixedNowIso);
    expect(run.trigger).toBe('manual');
    expect(run.lens).toBe('morning');
    expect(run.ok).toBe(6);
    expect(run.failed).toBe(0);
    expect(run.sources).toHaveLength(6);
    expect(run.sources[0]).toEqual({ id: `feed:${feedUrl}`, status: 'ok' });

    // -- local intel file --
    const intel = JSON.parse(fs.readFileSync(localIntelPath, 'utf8'));
    expect(intel.$schema).toBe('ace.ops.intel-local.v1');
    expect(intel.generatedAt).toBe(fixedNowIso);
    expect(intel.sections.map((s) => s.key)).toEqual([
      'official_feeds',
      'github_watch',
      'platform_accounts',
      'world_news',
      'vendor_updates',
    ]);
    const feedsSection = intel.sections[0];
    expect(feedsSection.provenance).toBe('native');
    expect(feedsSection.fetchedAt).toBe(fixedNowIso);
    // newest first, null timestamps last
    expect(feedsSection.items.map((i) => i.title)).toEqual(['First & foremost', 'No date item']);
    expect(feedsSection.items[1].timestamp).toBe(null);
    const github = intel.sections[1];
    expect(github.provenance).toBe('native');
    expect(github.items).toEqual([
      {
        title: 'v1.2.3',
        summary: '',
        url: 'https://example.invalid/rel/1',
        timestamp: '2026-06-04T12:00:00Z',
      },
    ]);
    const social = intel.sections[2];
    expect(social.provenance).toBe('agent');
    expect(social.items[0].handle).toBe('@alpha');
    expect(intel.sections[4].items).toEqual([]);
  });

  it('defaults localIntelPath to stateDir/LOCAL_INTEL_FILE and accepts empty 200 feeds', async () => {
    const stateDir = makeStateDir();
    const result = await runOpsRefresh({
      watchlists: { feeds: ['https://example.invalid/empty.xml'] },
      stateDir,
      now: () => fixedNow,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '<rss version="2.0"><channel><title>Empty</title></channel></rss>',
      }),
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    expect(result.localIntelPath).toBe(path.join(stateDir, LOCAL_INTEL_FILE));
    const feed = result.sources.find((s) => s.id === 'feed:https://example.invalid/empty.xml');
    // 0 items with HTTP 200 is still ok
    expect(feed.status).toBe('ok');
    expect(feed.itemCount).toBe(0);
  });

  it('feed failure: error status, preserved lastSuccess, preserved local section', async () => {
    const stateDir = makeStateDir();
    const localIntelPath = path.join(stateDir, LOCAL_INTEL_FILE);
    const feedId = `feed:${feedUrl}`;
    const priorIso = '2026-06-04T07:30:00.000Z';

    // Pre-seed prior state + previously written local intel.
    fs.writeFileSync(
      path.join(stateDir, OPS_REFRESH_STATE_FILE),
      JSON.stringify({
        $schema: 'ace.ops.source-state.v1',
        updatedAt: priorIso,
        sources: {
          [feedId]: {
            id: feedId,
            class: 'feeds',
            label: feedUrl,
            status: 'ok',
            lastAttempt: priorIso,
            lastSuccess: priorIso,
            error: null,
            itemCount: 2,
          },
        },
      })
    );
    const priorSection = {
      key: 'official_feeds',
      title: 'Official feeds',
      provenance: 'native',
      fetchedAt: priorIso,
      items: [
        {
          id: 'old',
          title: 'Old post',
          summary: '',
          url: 'https://example.invalid/old',
          timestamp: priorIso,
        },
      ],
    };
    fs.writeFileSync(
      localIntelPath,
      JSON.stringify({
        $schema: 'ace.ops.intel-local.v1',
        generatedAt: priorIso,
        sections: [priorSection],
      })
    );

    const result = await runOpsRefresh({
      watchlists: { feeds: [feedUrl] },
      stateDir,
      localIntelPath,
      trigger: 'scheduled',
      now: () => fixedNow,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'server error body' }),
      research: { enabled: false },
    });

    const feed = result.sources.find((s) => s.id === feedId);
    expect(feed.status).toBe('error');
    expect(feed.error).toBe('HTTP 500');
    expect(feed.error).not.toContain('server error body'); // no body dumps
    expect(feed.lastAttempt).toBe(fixedNowIso); // failures still advance lastAttempt
    expect(feed.lastSuccess).toBe(priorIso); // ...but never lastSuccess

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, OPS_REFRESH_STATE_FILE), 'utf8'));
    expect(state.sources[feedId].lastSuccess).toBe(priorIso);
    expect(state.sources[feedId].status).toBe('error');

    // stale-but-real beats gone: prior section is preserved verbatim.
    const intel = JSON.parse(fs.readFileSync(localIntelPath, 'utf8'));
    expect(intel.generatedAt).toBe(fixedNowIso);
    const feedsSection = intel.sections.find((s) => s.key === 'official_feeds');
    expect(feedsSection).toEqual(priorSection);

    // research disabled: social is auth-needed, news/vendors unavailable.
    expect(result.sources.find((s) => s.id === 'agent:social').status).toBe('auth-needed');
    expect(result.sources.find((s) => s.id === 'agent:news').status).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'agent:vendors').status).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'agent:news').error).toContain(
      'research agent disabled (ops-config refresh.research.enabled)'
    );
    // no reportFreshness -> finance unavailable
    const finance = result.sources.find((s) => s.id === 'report:finance');
    expect(finance.status).toBe('unavailable');
    expect(finance.error).toContain('missing');

    // history records the failure count
    const run = JSON.parse(
      fs.readFileSync(path.join(stateDir, OPS_REFRESH_HISTORY_FILE), 'utf8').trim()
    );
    expect(run.failed).toBe(1);
  });

  it('prunes sources dropped from the watchlist instead of leaving ghosts', async () => {
    const stateDir = makeStateDir();
    const goneId = 'feed:https://example.invalid/removed.xml';
    // Pre-seed a state file holding a source that is no longer watched.
    fs.writeFileSync(
      path.join(stateDir, OPS_REFRESH_STATE_FILE),
      JSON.stringify({
        $schema: 'ace.ops.source-state.v1',
        updatedAt: '2026-06-04T07:30:00.000Z',
        sources: {
          [goneId]: {
            id: goneId,
            class: 'feeds',
            label: 'removed',
            status: 'ok',
            lastAttempt: '2026-06-04T07:30:00.000Z',
            lastSuccess: '2026-06-04T07:30:00.000Z',
            error: null,
            itemCount: 2,
          },
        },
      })
    );

    await runOpsRefresh({
      watchlists: { feeds: [feedUrl] }, // goneId is NOT in this watchlist
      stateDir,
      now: () => fixedNow,
      fetchImpl: okFetch,
      research: { enabled: false },
    });

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, OPS_REFRESH_STATE_FILE), 'utf8'));
    expect(state.sources[goneId]).toBeUndefined(); // ghost pruned
    expect(state.sources[`feed:${feedUrl}`]).toBeDefined(); // current source kept
  });

  it('marks repos unavailable when the gh CLI is missing (ENOENT)', async () => {
    const result = await runOpsRefresh({
      watchlists: { repos: ['octo/repo'] },
      stateDir: makeStateDir(),
      now: () => fixedNow,
      fetchImpl: okFetch,
      execGh: async () => {
        const err = new Error('spawn gh ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      research: { enabled: false },
    });
    const repo = result.sources.find((s) => s.id === 'repo:octo/repo');
    expect(repo.status).toBe('unavailable');
    expect(repo.error).toBe('GitHub CLI not installed');
  });

  it('marks repos error on non-ENOENT, non-404 gh failures (verbatim message, not broken)', async () => {
    // 404s are reclassified as `broken` (FIX 2); a 500 is a plain transient error.
    const result = await runOpsRefresh({
      watchlists: { repos: ['octo/repo'] },
      stateDir: makeStateDir(),
      now: () => fixedNow,
      execGh: async () => {
        throw new Error('gh: HTTP 500 Internal Server Error');
      },
      research: { enabled: false },
    });
    const repo = result.sources.find((s) => s.id === 'repo:octo/repo');
    expect(repo.status).toBe('error');
    expect(repo.error).toBe('gh: HTTP 500 Internal Server Error');
    expect(repo.broken).toBe(false);
  });

  it('marks all agent sources error when the agent returns garbage', async () => {
    const result = await runOpsRefresh({
      watchlists,
      stateDir: makeStateDir(),
      now: () => fixedNow,
      fetchImpl: okFetch,
      execGh: okExecGh,
      research: { enabled: true, runAgent: async () => 'definitely not json' },
      reportFreshness: 'fresh',
    });
    for (const id of ['agent:social', 'agent:news', 'agent:vendors']) {
      const src = result.sources.find((s) => s.id === id);
      expect(src.status).toBe('error');
      expect(src.error).toBe('research agent output was not parseable JSON');
    }
  });

  it('marks agent sources missing from the output as error per section key', async () => {
    const result = await runOpsRefresh({
      watchlists,
      stateDir: makeStateDir(),
      now: () => fixedNow,
      fetchImpl: okFetch,
      execGh: okExecGh,
      research: {
        enabled: true,
        runAgent: async () => JSON.stringify({ sections: [{ key: 'world_news', items: [] }] }),
      },
      reportFreshness: 'fresh',
    });
    expect(result.sources.find((s) => s.id === 'agent:news').status).toBe('ok');
    const social = result.sources.find((s) => s.id === 'agent:social');
    expect(social.status).toBe('error');
    expect(social.error).toBe('research agent returned no platform_accounts section');
    const vendors = result.sources.find((s) => s.id === 'agent:vendors');
    expect(vendors.status).toBe('error');
    expect(vendors.error).toBe('research agent returned no vendor_updates section');
  });

  it('marks agent sources unavailable when enabled but no runner is wired', async () => {
    const result = await runOpsRefresh({
      watchlists,
      stateDir: makeStateDir(),
      now: () => fixedNow,
      fetchImpl: okFetch,
      execGh: okExecGh,
      research: { enabled: true },
      reportFreshness: 'fresh',
    });
    for (const id of ['agent:social', 'agent:news', 'agent:vendors']) {
      expect(result.sources.find((s) => s.id === id).status).toBe('unavailable');
    }
  });

  it('derives the finance source state from reportFreshness', async () => {
    const base = {
      watchlists: {},
      now: () => fixedNow,
      research: { enabled: false },
    };
    const fresh = await runOpsRefresh({ ...base, reportFreshness: 'fresh' });
    expect(fresh.sources.find((s) => s.id === 'report:finance').status).toBe('ok');
    expect(fresh.sources.find((s) => s.id === 'report:finance').lastSuccess).toBe(null);

    const stale = await runOpsRefresh({ ...base, reportFreshness: 'stale' });
    expect(stale.sources.find((s) => s.id === 'report:finance').status).toBe('ok');

    const expired = await runOpsRefresh({ ...base, reportFreshness: 'expired' });
    const expiredFin = expired.sources.find((s) => s.id === 'report:finance');
    expect(expiredFin.status).toBe('unavailable');
    expect(expiredFin.error).toContain('expired');

    const missing = await runOpsRefresh({ ...base, reportFreshness: 'missing' });
    expect(missing.sources.find((s) => s.id === 'report:finance').status).toBe('unavailable');
  });

  it('never throws, even with no ctx at all', async () => {
    const result = await runOpsRefresh({ research: { enabled: false } });
    expect(result.trigger).toBe('scheduled');
    expect(Array.isArray(result.sources)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------
describe('refreshStatus', () => {
  it('returns the empty snapshot for a missing dir and never throws', () => {
    const empty = { sources: [], lastRunAt: null, lastTrigger: null };
    expect(refreshStatus({ stateDir: path.join(os.tmpdir(), 'ace-nope-does-not-exist') })).toEqual(empty);
    expect(refreshStatus({})).toEqual(empty);
    expect(refreshStatus()).toEqual(empty);
    expect(() => refreshStatus({ stateDir: 42 })).not.toThrow();
  });

  it('returns sources sorted by class then id plus the last run info', async () => {
    const stateDir = makeStateDir();
    await runOpsRefresh({
      watchlists: { feeds: ['https://example.invalid/feed.xml'], repos: ['octo/repo'] },
      stateDir,
      trigger: 'manual',
      lens: 'midday',
      now: () => fixedNow,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => RSS_FIXTURE }),
      execGh: async () => '[]',
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const status = refreshStatus({ stateDir });
    expect(status.lastRunAt).toBe(fixedNowIso);
    expect(status.lastTrigger).toBe('manual');
    expect(status.sources.map((s) => s.class)).toEqual([
      'accounts',
      'changelogs',
      'feeds',
      'finance',
      'news',
      'repos',
    ]);
  });

  it('handles a corrupt state file', () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, OPS_REFRESH_STATE_FILE), '{not json');
    expect(refreshStatus({ stateDir })).toEqual({
      sources: [],
      lastRunAt: null,
      lastTrigger: null,
    });
  });
});

// ---------------------------------------------------------------------------
// mostRecentPastSlot
// ---------------------------------------------------------------------------
describe('mostRecentPastSlot', () => {
  const trio = [
    { hour: 7, minute: 30, lens: 'morning' },
    { hour: 13, minute: 0, lens: 'midday' },
    { hour: 20, minute: 30, lens: 'evening' },
  ];

  it("wraps to yesterday's evening slot before the first slot of the day", () => {
    const now = new Date(2026, 5, 5, 6, 0, 0, 0);
    const slot = mostRecentPastSlot(trio, now);
    expect(slot.getDate()).toBe(4);
    expect(slot.getHours()).toBe(20);
    expect(slot.getMinutes()).toBe(30);
  });

  it("picks today's 13:00 slot at 14:00", () => {
    const slot = mostRecentPastSlot(trio, new Date(2026, 5, 5, 14, 0, 0, 0));
    expect(slot.getDate()).toBe(5);
    expect(slot.getHours()).toBe(13);
    expect(slot.getMinutes()).toBe(0);
  });

  it('treats a slot exactly at now as at-or-before', () => {
    const slot = mostRecentPastSlot(trio, new Date(2026, 5, 5, 13, 0, 0, 0));
    expect(slot.getDate()).toBe(5);
    expect(slot.getHours()).toBe(13);
  });

  it('returns null for empty or invalid schedules', () => {
    const now = new Date(2026, 5, 5, 14, 0, 0, 0);
    expect(mostRecentPastSlot([], now)).toBe(null);
    expect(mostRecentPastSlot(null, now)).toBe(null);
    expect(mostRecentPastSlot('bad', now)).toBe(null);
    expect(mostRecentPastSlot([{ hour: 99, lens: 'x' }], now)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// scheduleOpsSourceCatchUp
// ---------------------------------------------------------------------------
describe('scheduleOpsSourceCatchUp', () => {
  function injectedTimers() {
    const timeouts = [];
    return {
      timeouts,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
    };
  }

  it('returns false when the contract is unmet', () => {
    expect(scheduleOpsSourceCatchUp({})).toBe(false);
    expect(scheduleOpsSourceCatchUp(null)).toBe(false);
    expect(scheduleOpsSourceCatchUp({ subscriptions: [] })).toBe(false);
    expect(scheduleOpsSourceCatchUp({ getStore: () => ({}) })).toBe(false);
  });

  it('arms a delayed catch-up when no refresh has ever run', async () => {
    const stateDir = makeStateDir();
    const timers = injectedTimers();
    const subscriptions = [];
    const calls = [];
    const store = {
      opsRefreshSources: (input) => {
        calls.push(input);
        return Promise.resolve({});
      },
    };
    const now = new Date(2026, 5, 5, 14, 0, 0, 0); // after the 13:00 slot

    const armed = scheduleOpsSourceCatchUp({
      getStore: () => store,
      subscriptions,
      stateDir,
      now: () => now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: () => {} },
    });

    expect(armed).toBe(true);
    expect(timers.timeouts).toHaveLength(1);
    expect(timers.timeouts[0].ms).toBe(30000); // default delay
    expect(subscriptions).toHaveLength(1);

    timers.timeouts[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ trigger: 'catch-up', allowResearchAgent: false }]);
  });

  it('arms when the last run predates the most recent past slot', () => {
    const stateDir = makeStateDir();
    // last run at 07:00 — before today's 13:00 slot
    fs.appendFileSync(
      path.join(stateDir, OPS_REFRESH_HISTORY_FILE),
      JSON.stringify({
        at: new Date(2026, 5, 5, 7, 0, 0, 0).toISOString(),
        trigger: 'scheduled',
        lens: null,
        ok: 1,
        failed: 0,
        sources: [],
      }) + '\n'
    );
    const timers = injectedTimers();
    const armed = scheduleOpsSourceCatchUp({
      getStore: () => ({ opsRefreshSources: () => Promise.resolve({}) }),
      subscriptions: [],
      stateDir,
      delayMs: 5,
      now: () => new Date(2026, 5, 5, 14, 0, 0, 0),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: () => {} },
    });
    expect(armed).toBe(true);
    expect(timers.timeouts[0].ms).toBe(5);
  });

  it('does NOT arm when the last run is after the most recent past slot', () => {
    const stateDir = makeStateDir();
    // last run at 13:30 — after today's 13:00 slot
    fs.appendFileSync(
      path.join(stateDir, OPS_REFRESH_HISTORY_FILE),
      JSON.stringify({
        at: new Date(2026, 5, 5, 13, 30, 0, 0).toISOString(),
        trigger: 'scheduled',
        lens: null,
        ok: 1,
        failed: 0,
        sources: [],
      }) + '\n'
    );
    const timers = injectedTimers();
    const subscriptions = [];
    const armed = scheduleOpsSourceCatchUp({
      getStore: () => ({ opsRefreshSources: () => Promise.resolve({}) }),
      subscriptions,
      stateDir,
      now: () => new Date(2026, 5, 5, 14, 0, 0, 0),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: () => {} },
    });
    expect(armed).toBe(false);
    expect(timers.timeouts).toHaveLength(0);
    expect(subscriptions).toHaveLength(0);
  });

  it('arms when the most recent run covered the slot but FAILED every source', () => {
    const stateDir = makeStateDir();
    // A scheduled run at 13:30 ran but pulled nothing (ok:0) — the 13:00 slot
    // is NOT covered, so a boot catch-up must still arm.
    fs.appendFileSync(
      path.join(stateDir, OPS_REFRESH_HISTORY_FILE),
      JSON.stringify({
        at: new Date(2026, 5, 5, 13, 30, 0, 0).toISOString(),
        trigger: 'scheduled',
        lens: null,
        ok: 0,
        failed: 3,
        sources: [],
      }) + '\n'
    );
    const timers = injectedTimers();
    const armed = scheduleOpsSourceCatchUp({
      getStore: () => ({ opsRefreshSources: () => Promise.resolve({}) }),
      subscriptions: [],
      stateDir,
      delayMs: 5,
      now: () => new Date(2026, 5, 5, 14, 0, 0, 0),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: () => {} },
    });
    expect(armed).toBe(true);
  });

  it('swallows and logs catch-up refresh rejections', async () => {
    const stateDir = makeStateDir();
    const timers = injectedTimers();
    const errors = [];
    scheduleOpsSourceCatchUp({
      getStore: () => ({ opsRefreshSources: () => Promise.reject(new Error('boom')) }),
      subscriptions: [],
      stateDir,
      now: () => new Date(2026, 5, 5, 14, 0, 0, 0),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: (...args) => errors.push(args) },
    });
    timers.timeouts[0].fn();
    // flush the rejection chain with one real macrotask
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });

  it('honors a caller-supplied schedule override', () => {
    const stateDir = makeStateDir();
    const timers = injectedTimers();
    // Single 09:00 slot; a SUCCESSFUL run at 10:00 covers it -> no catch-up.
    fs.appendFileSync(
      path.join(stateDir, OPS_REFRESH_HISTORY_FILE),
      JSON.stringify({ at: new Date(2026, 5, 5, 10, 0, 0, 0).toISOString(), trigger: 'manual', ok: 1 }) +
        '\n'
    );
    const armed = scheduleOpsSourceCatchUp({
      getStore: () => ({ opsRefreshSources: () => Promise.resolve({}) }),
      subscriptions: [],
      stateDir,
      schedule: [{ hour: 9, minute: 0, lens: 'morning' }],
      now: () => new Date(2026, 5, 5, 11, 0, 0, 0),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { error: () => {} },
    });
    expect(armed).toBe(false);
  });
});
