const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createTranscriptController } = require('../../transcript/index.cjs');

function makeController() {
  const db = new Database(':memory:');
  const controller = createTranscriptController({
    db,
    profiles: new Map(),
    bus: new EventEmitter(),
  });
  return { db, controller, store: controller._internal.store };
}

test('transcript snapshot defaults to the latest 20 entries and pages before the first id', () => {
  const { db, controller, store } = makeController();
  try {
    store.link('s1', {
      agent: 'codex',
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      linkedAt: 1,
    });
    for (let i = 0; i < 25; i++) {
      store.appendEntry('s1', {
        role: 'user',
        text: `message ${i}`,
        lifecycle: 'finished',
        tAt: i,
      });
    }

    const latest = controller.snapshot('s1', { limit: 20 });
    assert.equal(latest.entries.length, 20);
    assert.deepEqual(latest.entries.map((e: any) => e.id), Array.from({ length: 20 }, (_, i) => i + 5));
    assert.equal(latest.hasMoreBefore, true);

    const older = controller.snapshot('s1', { before: latest.entries[0].id, limit: 20 });
    assert.equal(older.entries.length, 5);
    assert.deepEqual(older.entries.map((e: any) => e.id), [0, 1, 2, 3, 4]);
    assert.equal(older.hasMoreBefore, false);

    const after = controller.snapshot('s1', { since: 22, limit: 20 });
    assert.deepEqual(after.entries.map((e: any) => e.id), [23, 24]);
  } finally {
    controller.shutdown();
    db.close();
  }
});
