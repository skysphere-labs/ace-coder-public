/**
 * ops-refresh-robustness.test.cts
 *
 * FIX 2 (source robustness): a bad watchlist entry (non-http(s) feed URL, or a
 * 404 repo) marks THAT source broken with a reason and never kills the lane.
 * FIX 5 (birdclaw): when ctx.birdclaw is configured, birdclaw is the social
 * lane's provider (read-only); the research agent still covers news+vendors.
 *
 * Plain CJS (no TS annotation syntax). Uses a node:sqlite adapter for the
 * birdclaw fixture (better-sqlite3 can't load under the test runner's node).
 */

import { afterEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { runOpsRefresh } = require('../ops-refresh.cts');

const tmpDirs = [];
function makeStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-robust-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const fixedNow = new Date('2026-07-01T08:00:00.000Z');
const okFeedXml =
  '<?xml version="1.0"?><rss version="2.0"><channel><item>' +
  '<title>Real item</title><link>https://example.invalid/1</link>' +
  '<pubDate>Wed, 01 Jul 2026 06:00:00 GMT</pubDate></channel></rss>';

// node:sqlite adapter presenting the better-sqlite3 surface birdclaw-source uses.
class TestDb {
  constructor(dbPath, opts) {
    this.db = new DatabaseSync(dbPath, opts && opts.readonly ? { readOnly: true } : undefined);
  }
  prepare(sql) {
    const s = this.db.prepare(sql);
    return { all: (...a) => s.all(...a), get: (...a) => s.get(...a), run: (...a) => s.run(...a) };
  }
  close() {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

function makeBirdclawDb(dir) {
  const dbPath = path.join(dir, 'bird.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tweets (id TEXT, full_text TEXT, created_at TEXT, screen_name TEXT, url TEXT)');
  db.exec("INSERT INTO tweets VALUES ('1','hello from birdclaw','2026-07-01T06:00:00.000Z','alice','https://x.com/alice/1')");
  db.close();
  return dbPath;
}

describe('FIX 2 — invalid feed URL is broken, never kills the lane', () => {
  it('a non-http(s) feed entry is marked broken while a valid feed still pulls', async () => {
    const stateDir = makeStateDir();
    let fetchCalls = 0;
    const result = await runOpsRefresh({
      watchlists: { feeds: ['GitHub Changelog', 'https://example.invalid/ok.xml'] },
      now: () => fixedNow,
      stateDir,
      fetchImpl: async () => {
        fetchCalls++;
        return { ok: true, status: 200, text: async () => okFeedXml };
      },
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const bad = result.sources.find((s) => s.id === 'feed:GitHub Changelog');
    const good = result.sources.find((s) => s.id === 'feed:https://example.invalid/ok.xml');
    expect(bad.status).toBe('error');
    expect(bad.broken).toBe(true);
    expect(bad.error).toMatch(/http/i);
    // The bad entry never reached fetch; the good one did (lane survived).
    expect(fetchCalls).toBe(1);
    expect(good.status).toBe('ok');
  });
});

describe('FIX 2 — repo 404 is broken', () => {
  it('a 404 from gh marks the repo broken with the status code', async () => {
    const stateDir = makeStateDir();
    const result = await runOpsRefresh({
      watchlists: { repos: ['acme/dead-repo'] },
      now: () => fixedNow,
      stateDir,
      execGh: async () => {
        throw new Error('gh: Not Found (HTTP 404)');
      },
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const repo = result.sources.find((s) => s.id === 'repo:acme/dead-repo');
    expect(repo.status).toBe('error');
    expect(repo.broken).toBe(true);
    expect(repo.error).toMatch(/404/);
  });
});

describe('FIX 5 — birdclaw is the social lane provider when configured', () => {
  it('happy path: birdclaw feeds platform_accounts; research still does news/vendors', async () => {
    const stateDir = makeStateDir();
    const dbPath = makeBirdclawDb(stateDir);
    const localIntelPath = path.join(stateDir, 'ops-intel-local.json');
    let researchPrompt = '';
    const result = await runOpsRefresh({
      watchlists: { accounts: ['@ignored'], changelogs: ['acme'] },
      now: () => fixedNow,
      stateDir,
      localIntelPath,
      birdclaw: { dbPath, Database: TestDb },
      research: {
        enabled: true,
        runAgent: async ({ prompt }) => {
          researchPrompt = prompt;
          return JSON.stringify({
            sections: [
              { key: 'world_news', items: [{ title: 'news item', summary: '', url: null, timestamp: null }] },
              { key: 'vendor_updates', items: [{ title: 'vendor item', summary: '', url: null, timestamp: null }] },
            ],
          });
        },
      },
      reportFreshness: 'fresh',
    });
    const social = result.sources.find((s) => s.id === 'agent:social');
    expect(social.status).toBe('ok');
    expect(social.itemCount).toBe(1);
    // News/vendors still came from the research agent.
    expect(result.sources.find((s) => s.id === 'agent:news').status).toBe('ok');
    expect(result.sources.find((s) => s.id === 'agent:vendors').status).toBe('ok');
    // The research prompt did NOT re-request the accounts birdclaw owns.
    expect(researchPrompt).toContain('(none watched)');
    // Local intel carries the birdclaw social items.
    const local = JSON.parse(fs.readFileSync(localIntelPath, 'utf8'));
    const accounts = local.sections.find((s) => s.key === 'platform_accounts');
    expect(accounts.items[0].title).toBe('hello from birdclaw');
  });

  it('birdclaw configured but DB absent -> social auth-needed (never throws)', async () => {
    const stateDir = makeStateDir();
    const result = await runOpsRefresh({
      watchlists: { accounts: ['@x'] },
      now: () => fixedNow,
      stateDir,
      birdclaw: { dbPath: path.join(stateDir, 'missing.db'), Database: TestDb },
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const social = result.sources.find((s) => s.id === 'agent:social');
    expect(social.status).toBe('auth-needed');
  });

  it('birdclaw DB with a broken schema -> social error + broken marker', async () => {
    const stateDir = makeStateDir();
    const badDb = path.join(stateDir, 'bad.db');
    const db = new DatabaseSync(badDb);
    db.exec('CREATE TABLE not_tweets (id TEXT)');
    db.close();
    const result = await runOpsRefresh({
      watchlists: { accounts: ['@x'] },
      now: () => fixedNow,
      stateDir,
      birdclaw: { dbPath: badDb, Database: TestDb },
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const social = result.sources.find((s) => s.id === 'agent:social');
    expect(social.status).toBe('error');
    expect(social.broken).toBe(true);
  });

  it('no birdclaw config -> social keeps the research-agent path (auth-needed when research off)', async () => {
    const stateDir = makeStateDir();
    const result = await runOpsRefresh({
      watchlists: { accounts: ['@x'] },
      now: () => fixedNow,
      stateDir,
      research: { enabled: false },
      reportFreshness: 'fresh',
    });
    const social = result.sources.find((s) => s.id === 'agent:social');
    expect(social.status).toBe('auth-needed');
  });
});
