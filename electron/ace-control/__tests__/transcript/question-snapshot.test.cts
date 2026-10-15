const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createTranscriptController } = require('../../transcript/index.cjs');

test('transcript snapshot serves typed question entries unchanged', () => {
  const db = new Database(':memory:');
  const controller = createTranscriptController({
    db,
    profiles: new Map(),
    bus: new EventEmitter(),
  });
  const store = controller._internal.store;
  try {
    store.link('question-stream', {
      agent: 'claude',
      sessionId: 'question-session',
      sessionFile: '/tmp/question-session.jsonl',
      linkedAt: 1,
    });
    store.appendEntry('question-stream', {
      role: 'question',
      questionId: 'toolu_question:0',
      callId: 'toolu_question',
      source: 'claude',
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Blue', description: 'calm' }],
      state: 'answered',
      answer: 'Blue',
      lifecycle: 'finished',
      tAt: 10,
    });

    const snapshot = controller.snapshot('question-stream');
    assert.deepEqual(snapshot.entries, [{
      id: 0,
      role: 'question',
      questionId: 'toolu_question:0',
      callId: 'toolu_question',
      source: 'claude',
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Blue', description: 'calm' }],
      state: 'answered',
      answer: 'Blue',
      lifecycle: 'finished',
      tAt: 10,
    }]);
  } finally {
    controller.shutdown();
    db.close();
  }
});
