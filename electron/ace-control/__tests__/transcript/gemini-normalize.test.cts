const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeGeminiSnapshot } = require('../../transcript/normalize/gemini.cjs');

function loadFixture(name) {
  const p = path.join(__dirname, '..', '..', 'fixtures', 'gemini', name, 'session.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('gemini basic-session emits session_start + ordered user/agent entries', () => {
  const snap = loadFixture('basic-session');
  const items = normalizeGeminiSnapshot(snap);
  assert.ok(items.length > 0);
  assert.equal(items[0].entry.role, 'system');
  assert.equal(items[0].entry.subtype, 'session_start');
  // Subsequent items must have stable keyPath values so upsert is idempotent.
  const keys = items.map((i) => i.keyPath);
  assert.equal(new Set(keys).size, keys.length, 'keyPath collisions would break idempotent upsert');
});

test('gemini thoughts-session: gemini messages expose reasoning entries', () => {
  const snap = loadFixture('thoughts-session');
  const items = normalizeGeminiSnapshot(snap);
  const hasReasoning = items.some((i) => i.entry.role === 'reasoning');
  assert.ok(hasReasoning, 'expected at least one reasoning entry for a thoughts-bearing session');
});

test('gemini tool-session: tool calls normalize with statuses and display results', () => {
  const snap = loadFixture('tool-session');
  const items = normalizeGeminiSnapshot(snap);
  const tools = items.filter((i) => i.entry.role === 'tool');
  assert.ok(tools.length > 0, 'expected at least one tool entry in a tool-session fixture');
  for (const t of tools) {
    assert.ok(['ok', 'error', 'denied', 'canceled', 'running'].includes(t.entry.status));
    assert.equal(typeof t.entry.name, 'string');
  }
});

test('gemini snapshot diff: second pass with same data is stable (idempotent keyPaths)', () => {
  const snap = loadFixture('basic-session');
  const a = normalizeGeminiSnapshot(snap);
  const b = normalizeGeminiSnapshot(snap);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].keyPath, b[i].keyPath);
  }
});
