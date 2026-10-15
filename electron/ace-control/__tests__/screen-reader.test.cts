const test = require('node:test');
const assert = require('node:assert/strict');

const { createScreenReader } = require('../screen-reader.cjs');

async function writeAndFlush(screen: any, streamId: string, chunk: string) {
  screen.write(streamId, chunk);
  await screen.flush(streamId);
}

test('diff() captures DONE that scrolled past the viewport', async () => {
  const screen = createScreenReader();
  const streamId = 'test:codex-long-turn';
  screen.ensure(streamId);

  // Prime lastText with the starting "ready" prompt so the next diff() compares
  // against that baseline (mirrors how ask() calls diff() before/after a turn).
  await writeAndFlush(screen, streamId, '> \r\n');
  screen.diff(streamId);

  // Simulate a Codex-style turn: lots of reasoning/tool output, a DONE line
  // roughly mid-stream, and a trailing ready prompt. DEFAULT_ROWS is 40, so
  // printing ~60 lines guarantees the DONE scrolls out of the viewport.
  const preLines = [];
  for (let i = 0; i < 20; i++) preLines.push(`thinking step ${i}: exploring options...`);
  await writeAndFlush(screen, streamId, preLines.join('\r\n') + '\r\n');
  await writeAndFlush(screen, streamId, 'DONE: no-code codex dev smoke passed\r\n');
  // Pad with MORE than DEFAULT_ROWS(40) lines after DONE so the viewport-only
  // text() path would miss it. We use 60 tail lines to be comfortably beyond
  // the 40-row viewport window.
  const postLines = [];
  for (let i = 0; i < 60; i++) postLines.push(`tokens used: ${i}`);
  await writeAndFlush(screen, streamId, postLines.join('\r\n') + '\r\n');
  await writeAndFlush(screen, streamId, '> \r\n');

  const delta = screen.diff(streamId);
  assert.ok(
    delta.includes('DONE: no-code codex dev smoke passed'),
    `diff() must include the DONE line even after it scrolled out of the viewport; got: ${delta.slice(-400)}`
  );

  // Caching: a second diff() with no further writes should be empty.
  const emptyDelta = screen.diff(streamId);
  assert.equal(emptyDelta, '', `expected empty diff on idempotent call, got: ${JSON.stringify(emptyDelta)}`);
});

test('diff() still captures DONE for short turns where it stayed in the viewport', async () => {
  const screen = createScreenReader();
  const streamId = 'test:claude-short-turn';
  screen.ensure(streamId);

  await writeAndFlush(screen, streamId, '> \r\n');
  screen.diff(streamId);

  // Claude-code-style short turn: a handful of lines, DONE, then ready prompt.
  await writeAndFlush(screen, streamId, 'Reading file...\r\nEditing file...\r\nAll tests pass.\r\n');
  await writeAndFlush(screen, streamId, 'DONE: shipped\r\n');
  await writeAndFlush(screen, streamId, '> \r\n');

  const delta = screen.diff(streamId);
  assert.ok(delta.includes('DONE: shipped'), `short-turn diff must include DONE; got: ${delta}`);
});
