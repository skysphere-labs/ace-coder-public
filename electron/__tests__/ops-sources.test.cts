/**
 * ops-sources.test.cts
 *
 * Unit tests for ops-sources.cts (Sources/watchlist store, W7).
 * Pure module — no electron/store/IPC imports.
 *
 * Runs via: npx vitest run electron/__tests__/ops-sources.test.cts
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  deriveWatchlists,
  loadLocalSources,
  saveLocalSources,
  mergeSources,
} = require('../ops-sources.cts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @type {string[]} */
const createdPaths = [];

/**
 * @param {string} suffix
 * @returns {string}
 */
function tmpFilePath(suffix) {
  const p = path.join(os.tmpdir(), `ops-sources-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}.json`);
  createdPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Report fixture with 2 accounts, 2 feeds, 2 repos, 2 changelogs (+ duplicates). */
function makeFixtureReport() {
  return {
    platform_accounts: [
      { handle: '@anthropic', name: 'Anthropic' },
      { handle: '@openai', name: 'OpenAI' },
      { handle: '@anthropic', name: 'Anthropic duplicate' }, // duplicate
    ],
    official_feeds: [
      { feed: 'blog.anthropic.com/rss' },
      { feed: 'openai.com/blog/rss' },
      { feed: 'blog.anthropic.com/rss' }, // duplicate
    ],
    github_watch: [
      { repo: 'anthropics/anthropic-sdk-python' },
      { repo: 'openai/openai-node' },
      { repo: 'anthropics/anthropic-sdk-python' }, // duplicate
    ],
    platform_changelogs: [
      { vendor: 'Anthropic', product: 'Claude' },
      { vendor: 'OpenAI', product: 'GPT' },
      { vendor: 'Anthropic', product: 'Claude' }, // duplicate
    ],
  };
}

// ---------------------------------------------------------------------------
// deriveWatchlists
// ---------------------------------------------------------------------------

describe('deriveWatchlists', () => {
  it('extracts and deduplicates accounts, feeds, repos, changelogs from fixture report', () => {
    const report = makeFixtureReport();
    const result = deriveWatchlists(report);

    expect(result.accounts).toEqual(['@anthropic', '@openai']);
    expect(result.feeds).toEqual(['blog.anthropic.com/rss', 'openai.com/blog/rss']);
    expect(result.repos).toEqual(['anthropics/anthropic-sdk-python', 'openai/openai-node']);
    expect(result.changelogs).toEqual(['Anthropic Claude', 'OpenAI GPT']);
  });

  it('falls back to .name then .label when .handle is missing', () => {
    const report = {
      platform_accounts: [
        { name: 'FallbackName' },
        { label: 'FallbackLabel' },
      ],
      official_feeds: [],
      github_watch: [],
      platform_changelogs: [],
    };
    const result = deriveWatchlists(report);
    expect(result.accounts).toEqual(['FallbackName', 'FallbackLabel']);
  });

  it('uses just vendor when product is missing for changelogs', () => {
    const report = {
      platform_accounts: [],
      official_feeds: [],
      github_watch: [],
      platform_changelogs: [
        { vendor: 'Anthropic' }, // no product
        { vendor: 'OpenAI', product: 'GPT' },
      ],
    };
    const result = deriveWatchlists(report);
    expect(result.changelogs).toEqual(['Anthropic', 'OpenAI GPT']);
  });

  it('returns all empty arrays when report is null', () => {
    const result = deriveWatchlists(null);
    expect(result).toEqual({ feeds: [], accounts: [], repos: [], changelogs: [] });
  });

  it('returns all empty arrays when report is undefined', () => {
    const result = deriveWatchlists(undefined);
    expect(result).toEqual({ feeds: [], accounts: [], repos: [], changelogs: [] });
  });

  it('returns all empty arrays when all source fields are missing', () => {
    const result = deriveWatchlists({});
    expect(result).toEqual({ feeds: [], accounts: [], repos: [], changelogs: [] });
  });

  it('does not throw on malformed entries within arrays', () => {
    const report = {
      platform_accounts: [null, undefined, { handle: 'valid' }, 42],
      official_feeds: [null, { feed: 'valid-feed' }, undefined],
      github_watch: [{ repo: 'valid/repo' }, null],
      platform_changelogs: [null, { vendor: 'Vendor' }],
    };
    expect(() => deriveWatchlists(report)).not.toThrow();
    const result = deriveWatchlists(report);
    expect(result.accounts).toContain('valid');
    expect(result.feeds).toContain('valid-feed');
    expect(result.repos).toContain('valid/repo');
    expect(result.changelogs).toContain('Vendor');
  });
});

// ---------------------------------------------------------------------------
// loadLocalSources
// ---------------------------------------------------------------------------

describe('loadLocalSources', () => {
  it('returns empty shape when file does not exist (no throw)', () => {
    const result = loadLocalSources({ filePath: '/no/such/file/ops-sources.json' });
    expect(result).toEqual({
      watchlists: { feeds: [], accounts: [], repos: [], changelogs: [] },
      editableAt: null,
    });
  });

  it('returns empty shape when file contains corrupt JSON (no throw)', () => {
    const p = tmpFilePath('corrupt');
    fs.writeFileSync(p, '{ this is not valid json !!!', 'utf-8');
    const result = loadLocalSources({ filePath: p });
    expect(result).toEqual({
      watchlists: { feeds: [], accounts: [], repos: [], changelogs: [] },
      editableAt: null,
    });
  });

  it('returns empty shape when file contains non-object JSON (no throw)', () => {
    const p = tmpFilePath('scalar');
    fs.writeFileSync(p, '"just a string"', 'utf-8');
    const result = loadLocalSources({ filePath: p });
    expect(result).toEqual({
      watchlists: { feeds: [], accounts: [], repos: [], changelogs: [] },
      editableAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// saveLocalSources + loadLocalSources round-trip
// ---------------------------------------------------------------------------

describe('saveLocalSources', () => {
  it('writes editableAt and persists watchlists that loadLocalSources can read back', () => {
    const p = tmpFilePath('roundtrip');
    const now = '2026-06-04T12:00:00.000Z';

    const watchlists = {
      feeds: ['feed-a', 'feed-b'],
      accounts: ['@acct1'],
      repos: ['org/repo'],
      changelogs: ['Vendor Product'],
    };

    const saved = saveLocalSources(watchlists, { filePath: p, now });

    expect(saved.watchlists).toEqual(watchlists);
    expect(saved.editableAt).toBe(now);

    // Read back
    const loaded = loadLocalSources({ filePath: p });
    expect(loaded.watchlists).toEqual(watchlists);
    expect(loaded.editableAt).toBe(now);
  });

  it('uses current ISO timestamp when opts.now is not provided', () => {
    const p = tmpFilePath('timestamp');
    const before = new Date().toISOString();
    const saved = saveLocalSources(emptyWatchlistsHelper(), { filePath: p });
    const after = new Date().toISOString();

    expect(saved.editableAt >= before).toBe(true);
    expect(saved.editableAt <= after).toBe(true);
  });

  it('returns the attempted payload even if a write error occurs (fail-closed)', () => {
    // Try to write to a path that cannot be created (root-owned path)
    const watchlists = emptyWatchlistsHelper();
    const now = '2026-06-04T12:00:00.000Z';

    // This may or may not succeed on the current OS, but must not throw
    expect(() =>
      saveLocalSources(watchlists, {
        filePath: '/root/no-permission/ops-sources.json',
        now,
      })
    ).not.toThrow();

    const result = saveLocalSources(watchlists, {
      filePath: '/root/no-permission/ops-sources.json',
      now,
    });
    expect(result.watchlists).toEqual(watchlists);
    expect(result.editableAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// mergeSources
// ---------------------------------------------------------------------------

describe('mergeSources', () => {
  it('unions derived and local entries, derived first then local-only, deduped', () => {
    const derived = {
      feeds: ['feed-derived-1', 'feed-shared'],
      accounts: ['@derived'],
      repos: ['derived/repo'],
      changelogs: ['DerivedVendor'],
    };
    const local = {
      watchlists: {
        feeds: ['feed-shared', 'feed-local-only'], // feed-shared is duplicate
        accounts: ['@local-only'],
        repos: ['derived/repo', 'local/repo'], // derived/repo is duplicate
        changelogs: ['LocalVendor'],
      },
      editableAt: '2026-06-04T10:00:00.000Z',
    };

    const result = mergeSources(derived, local);

    expect(result.$schema).toBe('ace.ops.sources.v1');
    // derived first, local-only appended, no duplicates
    expect(result.watchlists.feeds).toEqual(['feed-derived-1', 'feed-shared', 'feed-local-only']);
    expect(result.watchlists.accounts).toEqual(['@derived', '@local-only']);
    expect(result.watchlists.repos).toEqual(['derived/repo', 'local/repo']);
    expect(result.watchlists.changelogs).toEqual(['DerivedVendor', 'LocalVendor']);
    expect(result.editableAt).toBe('2026-06-04T10:00:00.000Z');
    expect(result.fromLatestJson).toBe(true);
  });

  it('fromLatestJson is true when derived has any entries', () => {
    const derived = { feeds: ['feed-a'], accounts: [], repos: [], changelogs: [] };
    const local = { watchlists: emptyWatchlistsHelper(), editableAt: null };
    const result = mergeSources(derived, local);
    expect(result.fromLatestJson).toBe(true);
  });

  it('fromLatestJson is false when derived is empty across all lists', () => {
    const derived = emptyWatchlistsHelper();
    const local = {
      watchlists: { feeds: ['local-feed'], accounts: [], repos: [], changelogs: [] },
      editableAt: null,
    };
    const result = mergeSources(derived, local);
    expect(result.fromLatestJson).toBe(false);
    // local entry still present
    expect(result.watchlists.feeds).toEqual(['local-feed']);
  });

  it('editableAt comes from local.editableAt (null when local has none)', () => {
    const result = mergeSources(emptyWatchlistsHelper(), {
      watchlists: emptyWatchlistsHelper(),
      editableAt: null,
    });
    expect(result.editableAt).toBeNull();
  });

  it('handles null/undefined derived and local gracefully (no throw)', () => {
    expect(() => mergeSources(null, null)).not.toThrow();
    const result = mergeSources(null, null);
    expect(result.$schema).toBe('ace.ops.sources.v1');
    expect(result.watchlists).toEqual({ feeds: [], accounts: [], repos: [], changelogs: [] });
  });
});

// ---------------------------------------------------------------------------
// Private helper (test-local only)
// ---------------------------------------------------------------------------

/** @returns {{ feeds: string[], accounts: string[], repos: string[], changelogs: string[] }} */
function emptyWatchlistsHelper() {
  return { feeds: [], accounts: [], repos: [], changelogs: [] };
}
