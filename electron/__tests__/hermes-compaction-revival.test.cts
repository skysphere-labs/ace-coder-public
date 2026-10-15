const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeHermesRecord,
  normalizeHermesSnapshot,
} = require('../ace-control/transcript/normalize/hermes.cjs');

test('Hermes compaction records carry compact reason and revival summary metadata', () => {
  const ops = normalizeHermesRecord({
    role: 'assistant',
    content: '[CONTEXT COMPACTION - REFERENCE ONLY]\nEarlier context summarized.',
    timestamp: '2026-06-25T10:00:00Z',
  });

  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'replace');
  assert.equal(ops[0].reason, 'compact');
  assert.equal(ops[0].summary.role, 'system');
  assert.equal(ops[0].summary.subtype, 'info');
  assert.match(ops[0].summary.text, /auto-compacted/);
  assert.match(ops[0].summary.text, /summarized/);
  assert.match(ops[0].summary.text, /reviving from compacted context/);
});

test('Hermes snapshot compaction entries render the same visible revival copy', () => {
  const items = normalizeHermesSnapshot({
    session_id: '20260625_100000_compact',
    messages: [
      {
        role: 'assistant',
        content: '[CONTEXT COMPACTION]\nPrior turns compacted.',
        timestamp: '2026-06-25T10:00:00Z',
      },
    ],
  });
  const compact = items.find((item) => item.keyPath === 'compaction:0');

  assert.ok(compact);
  assert.equal(compact.entry.role, 'system');
  assert.match(compact.entry.text, /Hermes auto-compacted/);
  assert.match(compact.entry.text, /reviving from compacted context/);
});

test('transcript controller forwards replace op reason to renderer payloads', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'electron/ace-control/transcript/index.cts'),
    'utf8'
  );

  assert.match(
    controller,
    /emitTranscriptReplace\(streamId, \{ streamId, nextCursor: saved\.id \+ 1, summary: saved, reason: op\.reason \|\| 'compact' \}\)/
  );
});
