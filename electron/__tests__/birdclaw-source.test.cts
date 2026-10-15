/**
 * birdclaw-source.test.cts
 *
 * Unit tests for the READ-ONLY birdclaw social-lane adapter: config resolution,
 * happy path over an in-memory-style SQLite fixture, schema-churn tolerance
 * (alt column names), and the defensive degrades (missing file -> auth-needed;
 * missing table / missing text column -> broken). NEVER throws.
 *
 * better-sqlite3 is built for Electron's ABI and cannot load under the test
 * runner's node, so we inject a thin node:sqlite adapter presenting the tiny
 * surface birdclaw-source uses (new Database(path,opts) + prepare().all() +
 * close()). Same technique as fix3-proof for knowledge-index.
 *
 * Plain CJS (no TS annotation syntax) so vitest's .cts parse stays happy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { fetchBirdclawSocial, resolveBirdclawDbPath } = require('../birdclaw-source.cts');

// Injected better-sqlite3-shaped constructor over node:sqlite. Honors the
// readonly flag (readOnly in node:sqlite); ignores fileMustExist (the module
// already guards existsSync first).
class TestDb {
  constructor(dbPath, opts) {
    this.db = new DatabaseSync(dbPath, opts && opts.readonly ? { readOnly: true } : undefined);
  }
  prepare(sql) {
    const s = this.db.prepare(sql);
    return {
      all: (...args) => s.all(...args),
      get: (...args) => s.get(...args),
      run: (...args) => s.run(...args),
    };
  }
  close() {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'birdclaw-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Create a birdclaw-ish SQLite file with the given tweets DDL + rows, then close
// it so the module reopens it read-only.
function makeDb(name, ddl, rows) {
  const dbPath = path.join(tmp, name);
  const db = new DatabaseSync(dbPath);
  db.exec(ddl);
  for (const insert of rows) db.exec(insert);
  db.close();
  return dbPath;
}

describe('resolveBirdclawDbPath', () => {
  it('prefers an explicit dbPath', () => {
    expect(resolveBirdclawDbPath({ dbPath: '/tmp/x.db' })).toBe('/tmp/x.db');
  });

  it('reads birdclaw.dbPath from the given config file', () => {
    const cfgPath = path.join(tmp, 'ops-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ birdclaw: { dbPath: '/data/bird.db' } }));
    expect(resolveBirdclawDbPath({ configPath: cfgPath })).toBe('/data/bird.db');
  });

  it('returns null when the config is missing or has no birdclaw key', () => {
    expect(resolveBirdclawDbPath({ configPath: path.join(tmp, 'nope.json') })).toBe(null);
    const cfgPath = path.join(tmp, 'empty.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ refresh: {} }));
    expect(resolveBirdclawDbPath({ configPath: cfgPath })).toBe(null);
  });
});

describe('fetchBirdclawSocial — not configured / absent', () => {
  it('returns configured:false when nothing is configured (falls back to research agent)', () => {
    const got = fetchBirdclawSocial({ configPath: path.join(tmp, 'nope.json'), Database: TestDb });
    expect(got.configured).toBe(false);
    expect(got.items).toEqual([]);
  });

  it('configured but DB file absent -> auth-needed with a setup hint (never throws)', () => {
    const got = fetchBirdclawSocial({ dbPath: path.join(tmp, 'missing.db'), Database: TestDb });
    expect(got.configured).toBe(true);
    expect(got.status).toBe('auth-needed');
    expect(typeof got.hint).toBe('string');
    expect(got.hint.length).toBeGreaterThan(0);
    expect(got.items).toEqual([]);
  });
});

describe('fetchBirdclawSocial — happy path', () => {
  it('maps recent tweets onto the social item shape (title/summary/url/timestamp/handle)', () => {
    const dbPath = makeDb(
      'bird.db',
      'CREATE TABLE tweets (id TEXT, full_text TEXT, created_at TEXT, screen_name TEXT, url TEXT)',
      [
        "INSERT INTO tweets VALUES ('1','older tweet','2026-06-30T10:00:00.000Z','alice','https://x.com/alice/1')",
        "INSERT INTO tweets VALUES ('2','newer tweet','2026-07-01T10:00:00.000Z','@bob','https://x.com/bob/2')",
      ]
    );
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.configured).toBe(true);
    expect(got.status).toBe('ok');
    expect(got.items.length).toBe(2);
    // Newest first (created_at DESC).
    expect(got.items[0].id).toBe('birdclaw:2');
    expect(got.items[0].title).toBe('newer tweet');
    expect(got.items[0].summary).toBe('newer tweet');
    expect(got.items[0].url).toBe('https://x.com/bob/2');
    expect(got.items[0].timestamp).toBe('2026-07-01T10:00:00.000Z');
    expect(got.items[0].handle).toBe('@bob'); // already @-prefixed, kept
    expect(got.items[1].handle).toBe('@alice'); // bare handle gets an @
  });

  it('tolerates alternate column names (schema churn): text / ts / username / tweet_url', () => {
    const dbPath = makeDb(
      'bird2.db',
      'CREATE TABLE tweets (tweet_id TEXT, text TEXT, ts INTEGER, username TEXT, tweet_url TEXT)',
      ["INSERT INTO tweets VALUES ('9','epoch-seconds tweet',1751362800,'carol','https://x.com/carol/9')"]
    );
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.status).toBe('ok');
    expect(got.items.length).toBe(1);
    expect(got.items[0].title).toBe('epoch-seconds tweet');
    expect(got.items[0].handle).toBe('@carol');
    // Epoch SECONDS are coerced to ms before ISO formatting (< 1e12 heuristic).
    expect(got.items[0].timestamp).toBe(new Date(1751362800 * 1000).toISOString());
  });

  it('caps the pull at 50 items per refresh', () => {
    const rows = [];
    for (let i = 0; i < 60; i++) {
      rows.push(`INSERT INTO tweets VALUES ('${i}','tweet ${i}','2026-06-${(i % 28) + 1}T00:00:00.000Z','u${i}','')`);
    }
    const dbPath = makeDb(
      'bird3.db',
      'CREATE TABLE tweets (id TEXT, full_text TEXT, created_at TEXT, screen_name TEXT, url TEXT)',
      rows
    );
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.status).toBe('ok');
    expect(got.items.length).toBe(50);
  });

  it('skips rows with empty text', () => {
    const dbPath = makeDb(
      'bird4.db',
      'CREATE TABLE tweets (id TEXT, full_text TEXT, created_at TEXT, screen_name TEXT, url TEXT)',
      [
        "INSERT INTO tweets VALUES ('1','','2026-07-01T10:00:00.000Z','a','')",
        "INSERT INTO tweets VALUES ('2','real','2026-07-01T11:00:00.000Z','b','')",
      ]
    );
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.items.length).toBe(1);
    expect(got.items[0].title).toBe('real');
  });
});

describe('fetchBirdclawSocial — defensive degrades (broken, never throws)', () => {
  it('missing `tweets` table -> broken', () => {
    const dbPath = makeDb('no-tweets.db', 'CREATE TABLE bookmarks (id TEXT)', []);
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.configured).toBe(true);
    expect(got.status).toBe('broken');
    expect(got.error).toMatch(/tweets/i);
    expect(got.items).toEqual([]);
  });

  it('tweets table with no recognizable text column -> broken', () => {
    const dbPath = makeDb(
      'no-text.db',
      'CREATE TABLE tweets (id TEXT, created_at TEXT, screen_name TEXT)',
      []
    );
    const got = fetchBirdclawSocial({ dbPath, Database: TestDb });
    expect(got.status).toBe('broken');
    expect(got.error).toMatch(/text/i);
  });

  it('never throws even when the Database constructor throws', () => {
    // Simulate an unreadable DB: existsSync true (real file) but open throws.
    const dbPath = makeDb('exists.db', 'CREATE TABLE tweets (id TEXT, full_text TEXT)', []);
    const Boom = function () {
      throw new Error('cannot open');
    };
    const got = fetchBirdclawSocial({ dbPath, Database: Boom });
    expect(got.configured).toBe(true);
    expect(got.status).toBe('auth-needed'); // open failure treated as setup
    expect(got.items).toEqual([]);
  });
});

it('uses the selected public profile instead of ambient legacy ops config', () => {
  const previous = process.env.ACE_HOME;
  try {
    process.env.ACE_HOME = tmp;
    fs.writeFileSync(path.join(tmp, 'ops-config.json'), JSON.stringify({ birdclaw: { dbPath: '/synthetic/profile-social.db' } }));
    expect(resolveBirdclawDbPath()).toBe('/synthetic/profile-social.db');
    fs.unlinkSync(path.join(tmp, 'ops-config.json'));
    expect(resolveBirdclawDbPath()).toBe(null);
  } finally {
    if (previous === undefined) delete process.env.ACE_HOME;
    else process.env.ACE_HOME = previous;
  }
});
