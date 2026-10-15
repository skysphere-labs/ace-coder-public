const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCodexJsonlTail } = require('../../transcript/tails/codex-jsonl.cjs');
const { createGeminiJsonTail } = require('../../transcript/tails/gemini-json.cjs');

async function tmpFile(contents = '') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cap-tail-'));
  const p = path.join(dir, 'session.data');
  await fsp.writeFile(p, contents);
  return p;
}

test('codex jsonl tail streams lines and tracks offset', async () => {
  const p = await tmpFile(
    JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n'
  );
  const events = [];
  const tail = createCodexJsonlTail({
    filePath: p,
    onEvent: (e) => events.push(e),
    onWarning: () => {},
  });
  await tail.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 2);
  const offset = tail.getOffset();
  assert.ok(offset > 0);
  // Append another line and assert the watcher picks it up.
  fs.appendFileSync(p, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_finished' } }) + '\n');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(events.length, 3);
  tail.close();
});

test('gemini json tail re-reads on file rewrite', async () => {
  const p = await tmpFile(JSON.stringify({ sessionId: 'a', messages: [] }));
  const snaps = [];
  const tail = createGeminiJsonTail({
    filePath: p,
    onSnapshot: (s) => snaps.push(s),
    onWarning: () => {},
    debounceMs: 20,
  });
  await tail.start();
  await new Promise((r) => setTimeout(r, 100));
  // Rewrite with new content.
  await fsp.writeFile(p, JSON.stringify({ sessionId: 'a', messages: [{ id: '1', type: 'user', content: [{ text: 'hi' }] }] }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(snaps.length >= 2, `expected >=2 snapshots, got ${snaps.length}`);
  const last = snaps[snaps.length - 1];
  assert.equal(last.messages.length, 1);
  tail.close();
});
