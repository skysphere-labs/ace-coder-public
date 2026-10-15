import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const reader = require('../hermes-memory-reader.cts');

let userDataPath = '';

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-reader-'));
});

afterEach(() => {
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

function makeHome(name, withDb = false) {
  const home = path.join(userDataPath, name);
  fs.mkdirSync(path.join(home, 'memories'), { recursive: true });
  if (withDb) {
    const db = new Database(path.join(home, 'state.db'));
    db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, created_at TEXT)');
    db.prepare('INSERT INTO memories (content, created_at) VALUES (?, ?)')
      .run('Owner prefers concise mission summaries.', new Date().toISOString());
    db.prepare('INSERT INTO memories (content, created_at) VALUES (?, ?)')
      .run('token: abcdef1234567890XYZ should never surface', new Date().toISOString());
    db.close();
  }
  return home;
}

describe('hermes-memory-reader', () => {
  it('exports read functions only — no write surface exists', () => {
    expect(Object.keys(reader).sort()).toEqual(['collectHermesMemoryDocs', 'hermesMemoryRoots', 'isHermesPath']);
    for (const fn of Object.values(reader)) expect(typeof fn).toBe('function');
  });

  it('collects memories from base and per-workspace homes at trust=external', () => {
    const base = makeHome('hermes-home');
    fs.writeFileSync(path.join(base, 'memories', 'note.md'), '# Note\nThe owner ships on Fridays.');
    const ws = makeHome('hermes-home-ws_42', true);
    fs.writeFileSync(path.join(ws, 'memories', 'pref.md'), '# Pref\nDark dashboards preferred.');

    const docs = reader.collectHermesMemoryDocs({ userDataPath, Database, homeDir: userDataPath });
    expect(docs.length).toBe(3); // 2 md files + 1 clean db row (secret row excluded)
    expect(docs.every((doc) => doc.trust === 'external')).toBe(true);
    expect(docs.every((doc) => doc.source === 'hermes-memory')).toBe(true);
    const wsDocs = docs.filter((doc) => doc.project === 'ws_42');
    expect(wsDocs.length).toBe(2);
    expect(JSON.stringify(docs)).not.toContain('abcdef1234567890XYZ');
  });

  it('reads state.db readonly — a locked/garbage db is skipped, never thrown', () => {
    const home = makeHome('hermes-home-broken');
    fs.writeFileSync(path.join(home, 'state.db'), 'this is not sqlite');
    expect(() => reader.collectHermesMemoryDocs({ userDataPath, Database, homeDir: userDataPath })).not.toThrow();
  });

  it('never mutates hermes files while collecting', () => {
    const base = makeHome('hermes-home', true);
    fs.writeFileSync(path.join(base, 'memories', 'note.md'), '# Note\nimmutable');
    const before = fs.statSync(path.join(base, 'state.db')).mtimeMs;
    reader.collectHermesMemoryDocs({ userDataPath, Database, homeDir: userDataPath });
    expect(fs.statSync(path.join(base, 'state.db')).mtimeMs).toBe(before);
  });

  it('isHermesPath flags hermes-home and ~/.hermes targets', () => {
    const base = makeHome('hermes-home');
    expect(reader.isHermesPath(path.join(base, 'memories', 'x.md'), userDataPath)).toBe(true);
    expect(reader.isHermesPath(path.join(userDataPath, 'elsewhere', 'x.md'), userDataPath)).toBe(false);
    expect(reader.isHermesPath('', userDataPath)).toBe(false);
  });
});
