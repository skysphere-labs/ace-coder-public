// @ts-nocheck — plain-JS node:test fixture (run via `node --import tsx --test`).
// node:test for normalize/claude.cts — runs against the REAL captured spike
// events (spike2-events.jsonl) plus synthetic permission frames whose shape is
// taken verbatim from spike3-summary.json (canUseToolSample).
//
// Run (worktree, no build) e.g.:
//   node --import tsx --test electron/ace-control/transcript/normalize/claude.normalize.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizeClaudeEvent, resetTurnContext } = require('./claude.cts');

const SPIKE_JSONL = path.join(__dirname, '..', '__fixtures__', 'claude-stream-events.jsonl');
const QUESTION_JSONL = path.join(__dirname, '..', '__fixtures__', 'claude-session-askuserquestion.jsonl');
const MALFORMED_QUESTION_JSONL = path.join(__dirname, '..', '__fixtures__', 'claude-session-askuserquestion.malformed.jsonl');

function loadJsonl(file: string, { skipInvalid = false } = {}) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line: string) => line.trim())
    .flatMap((line: string) => {
      try {
        return [JSON.parse(line)];
      } catch (error) {
        if (skipInvalid) return [];
        throw error;
      }
    });
}

// Load only the `dir:'out'` objects (events the CLI emitted to us).
function loadSpikeOutEvents() {
  return fs
    .readFileSync(SPIKE_JSONL, 'utf8')
    .split('\n')
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l))
    .filter((rec: any) => rec.dir === 'out' && rec.obj)
    .map((rec: any) => rec.obj);
}

// Mini in-memory replayer mirroring store.upsertByKey + index.cts.applyOp.
function runOps(events: any[], streamId = 's1') {
  resetTurnContext(streamId);
  let entries: any[] = [];
  const keyed = new Map();
  const warnings: string[] = [];
  let seq = 0;
  for (const evt of events) {
    const ops = normalizeClaudeEvent(evt, { streamId });
    for (const op of ops) {
      if (op.kind === 'append') {
        entries.push({ ...op.entry, id: seq++ });
      } else if (op.kind === 'upsert') {
        if (keyed.has(op.key)) {
          const id = keyed.get(op.key);
          const idx = entries.findIndex((e) => e.id === id);
          if (idx >= 0) {
            const next = op.build(entries[idx]);
            if (next) entries[idx] = { ...next, id };
          }
        } else {
          const entry = op.build(null);
          if (!entry) continue;
          const id = seq++;
          keyed.set(op.key, id);
          entries.push({ ...entry, id });
        }
      } else if (op.kind === 'replace') {
        entries = [{ ...op.summary, id: seq++ }];
        keyed.clear();
      } else if (op.kind === 'warn') {
        warnings.push(op.code);
      }
    }
  }
  return { entries, warnings };
}

test('text_deltas accumulate into ONE agent entry ending finished', () => {
  const { entries } = runOps(loadSpikeOutEvents());
  const agents = entries.filter((e) => e.role === 'agent');
  // The two turns in the fixture each produce exactly one agent text entry.
  assert.ok(agents.length >= 1, `expected >=1 agent entry, got ${agents.length}`);
  // Turn 1's note + js block must be ONE entry built from multiple deltas.
  const noteEntry = agents.find((e) => /function add\(a, b\)/.test(e.text || ''));
  assert.ok(noteEntry, 'expected the accumulated js-block agent entry');
  assert.ok(/short note/.test(noteEntry.text), 'agent text accumulated from multiple deltas');
  assert.equal(noteEntry.lifecycle, 'finished', 'settled assistant flips lifecycle to finished');
});

test('a tool_use (Write) produces a role:tool entry with parsed args', () => {
  const { entries } = runOps(loadSpikeOutEvents());
  const tools = entries.filter((e) => e.role === 'tool');
  assert.ok(tools.length >= 1, `expected a tool entry, got ${tools.length}`);
  const write = tools.find((t) => t.name === 'Write');
  assert.ok(write, 'expected a Write tool entry');
  // input_json_delta fragments must reassemble + parse into the real args.
  assert.equal(write.args?.content, 'hello', 'tool args parsed from input_json_delta');
  assert.ok(/spike-probe\.txt$/.test(write.args?.file_path || ''), 'file_path reassembled');
  assert.equal(write.callId, 'toolu_01CpzzSqxeibyGdN3A2YcEYV', 'callId from content_block_start id');
});

test('the partial-stream and settled assistant do NOT duplicate the agent entry', () => {
  const { entries } = runOps(loadSpikeOutEvents());
  // Turn 1 emitted text_deltas (stream) AND a settled assistant with the same
  // text. They must collapse to a single entry, not two.
  const turn1Texts = entries.filter(
    (e) => e.role === 'agent' && /function add\(a, b\)/.test(e.text || ''),
  );
  assert.equal(turn1Texts.length, 1, 'stream + settled assistant fold into one entry');
});

test('turn boundaries do not collide across turns', () => {
  const { entries } = runOps(loadSpikeOutEvents());
  // result events are turn boundaries -> system entries.
  const finishes = entries.filter((e) => e.role === 'system' && e.subtype === 'turn_finished');
  assert.ok(finishes.length >= 2, `expected >=2 turn_finished, got ${finishes.length}`);
  // Two distinct turns each kept their own agent entry (turn1 has the js block,
  // turn2 has the permission-awaiting note). Index 0 collision would merge them.
  const agents = entries.filter((e) => e.role === 'agent');
  const turn2 = agents.find((e) => /awaiting your permission/.test(e.text || ''));
  assert.ok(turn2, 'turn 2 agent text present as its own entry');
});

test('system/init appends session_start with model', () => {
  // Synthetic clean init (the captured init events carry the operator's
  // slash-command list + paths, scrubbed out of the committed fixture).
  const { entries } = runOps([{ type: 'system', subtype: 'init', model: 'claude-opus-4-8[1m]' }]);
  const start = entries.find((e) => e.role === 'system' && e.subtype === 'session_start');
  assert.ok(start, 'expected a session_start entry');
  assert.ok(/claude-opus-4-8/.test(start.text || ''), 'session_start carries the model');
});

test('can_use_tool produces a pending approval; __approval_resolved resolves it', () => {
  // Shape taken verbatim from spike3-summary.json canUseToolSample.
  const canUse = {
    type: 'control_request',
    request_id: '5dface7c-5c3c-4d1b-b701-56d27d0a8a92',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      display_name: 'Write',
      input: { file_path: '/private/tmp/claude-spike-ws/probe2.txt', content: 'hi' },
      description: 'probe2.txt',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      tool_use_id: 'toolu_014v6SakENNyYpxT4Pnz2qex',
    },
  };
  let { entries } = runOps([canUse], 'approval-stream');
  let approval = entries.find((e) => e.role === 'approval');
  assert.ok(approval, 'can_use_tool produced an approval entry');
  assert.equal(approval.status, 'pending', 'approval starts pending');
  assert.equal(approval.lifecycle, 'open', 'pending approval is open');
  assert.ok(/Write/.test(approval.prompt), 'prompt names the tool');

  // Resolve it (deny).
  const resolved = {
    type: '__approval_resolved',
    request_id: '5dface7c-5c3c-4d1b-b701-56d27d0a8a92',
    approved: false,
  };
  ({ entries } = runOps([canUse, resolved], 'approval-stream'));
  approval = entries.find((e) => e.role === 'approval');
  assert.equal(approval.status, 'denied', 'denied resolution applied');
  assert.equal(approval.lifecycle, 'finished', 'resolved approval is finished');
  // Allow path.
  ({ entries } = runOps([canUse, { ...resolved, approved: true }], 'approval-stream-2'));
  approval = entries.find((e) => e.role === 'approval');
  assert.equal(approval.status, 'approved', 'allow resolution applied');
});

test('tool_result on a user message resolves a tool entry to finished + error', () => {
  // Mirrors spike2 line 31: a permission-blocked Write returned a tool_result.
  const events = [
    { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'Write', input: {} } },
    },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt","content":"hi"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'denied by hook', is_error: true, tool_use_id: 'toolu_x' }] },
    },
  ];
  const { entries } = runOps(events, 'tr-stream');
  const tool = entries.find((e) => e.role === 'tool');
  assert.ok(tool, 'tool entry exists');
  assert.equal(tool.status, 'error', 'is_error tool_result -> error status');
  assert.equal(tool.lifecycle, 'finished', 'tool_result finalizes the tool');
  assert.equal(tool.result, 'denied by hook', 'result text captured');
  // Exactly one tool entry (start + stop + result fold onto the same callId).
  assert.equal(entries.filter((e) => e.role === 'tool').length, 1, 'no tool duplication');
});

test('empty deltas are ignored and unknown types warn', () => {
  const events = [
    { type: 'stream_event', event: { type: 'message_start', message: {} } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'totally_unknown_top_level' },
    { type: 'stream_event', event: { type: 'mystery_inner_frame' } },
  ];
  const { entries, warnings } = runOps(events, 'edge-stream');
  // Empty text_delta produced no agent entry.
  assert.equal(entries.filter((e) => e.role === 'agent').length, 0, 'empty deltas produce no entry');
  assert.ok(warnings.includes('claude:totally_unknown_top_level'), 'unknown top-level warns');
  assert.ok(warnings.includes('claude:stream_event:mystery_inner_frame'), 'unknown inner frame warns');
});

test('thinking_delta accumulates into one reasoning entry', () => {
  const events = [
    { type: 'stream_event', event: { type: 'message_start', message: {} } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ];
  const { entries } = runOps(events, 'think-stream');
  const reasoning = entries.filter((e) => e.role === 'reasoning');
  assert.equal(reasoning.length, 1, 'one reasoning entry');
  assert.equal(reasoning[0].text, 'Let me consider.', 'thinking deltas accumulated');
  assert.equal(reasoning[0].lifecycle, 'finished', 'reasoning finalized on stop');
});

// --- File-tailed sessions (~/.claude/projects/<cwd>/<sessionId>.jsonl) -----
// The file tail passes ctx.source='session-file'; settled messages arrive
// WITHOUT stream_event frames, one content block per jsonl line.

function runFileOps(events: any[], streamId = 'sf1') {
  resetTurnContext(streamId);
  let entries: any[] = [];
  const keyed = new Map();
  const warnings: string[] = [];
  let seq = 0;
  for (const evt of events) {
    for (const op of normalizeClaudeEvent(evt, { streamId, source: 'session-file' })) {
      if (op.kind === 'append') {
        entries.push({ ...op.entry, id: seq++ });
      } else if (op.kind === 'upsert') {
        if (keyed.has(op.key)) {
          const id = keyed.get(op.key);
          const idx = entries.findIndex((e) => e.id === id);
          if (idx >= 0) {
            const next = op.build(entries[idx]);
            if (next) entries[idx] = { ...next, id };
          }
        } else {
          const entry = op.build(null);
          if (!entry) continue;
          const id = seq++;
          keyed.set(op.key, id);
          entries.push({ ...entry, id });
        }
      } else if (op.kind === 'warn') {
        warnings.push(op.code);
      }
    }
  }
  return { entries, warnings };
}

test('file tail: settled assistant messages with new ids start new turns (no fold-over)', () => {
  const { entries } = runFileOps([
    { type: 'user', message: { role: 'user', content: 'first question' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'answer one' }] } },
    { type: 'user', message: { role: 'user', content: 'second question' } },
    { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'answer two' }] } },
  ]);
  const agents = entries.filter((e) => e.role === 'agent');
  assert.equal(agents.length, 2, 'each assistant message id gets its own agent entry');
  assert.equal(agents[0].text, 'answer one');
  assert.equal(agents[1].text, 'answer two');
  const users = entries.filter((e) => e.role === 'user');
  assert.deepEqual(users.map((u) => u.text), ['first question', 'second question']);
});

test('file tail: same-id assistant lines fold into one turn; tool_result resolves the tool', () => {
  const { entries } = runFileOps([
    { type: 'assistant', message: { id: 'msg_9', content: [{ type: 'text', text: 'running a tool' }] } },
    { type: 'assistant', message: { id: 'msg_9', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt' }] } },
  ]);
  assert.equal(entries.filter((e) => e.role === 'agent').length, 1);
  const tool = entries.find((e) => e.role === 'tool');
  assert.ok(tool, 'tool entry exists');
  assert.equal(tool.status, 'ok');
  assert.equal(tool.result, 'file.txt');
  assert.equal(entries.filter((e) => e.role === 'user').length, 0, 'tool_result lines are not user text');
});

test('T8: AskUserQuestion fixture preserves choices and resolves option 2 on the same entry', () => {
  const { entries } = runFileOps(loadJsonl(QUESTION_JSONL), 'question-t8');
  const question = entries.find((entry) => entry.callId === 'toolu_01UbfvmC9u2T2yCiZknCiuD4');
  assert.ok(question, 'single-select question entry exists');
  assert.equal(question.role, 'question');
  assert.equal(question.questionId, 'toolu_01UbfvmC9u2T2yCiZknCiuD4:0');
  assert.equal(question.question, 'Which accent color should the dashboard use?');
  assert.equal(question.header, 'Color');
  assert.equal(question.multiSelect, false);
  assert.deepEqual(question.options, [
    { label: 'Red', description: 'warm, high energy' },
    { label: 'Blue', description: 'calm, corporate' },
    { label: 'Green', description: 'fresh, natural' },
  ]);
  assert.equal(question.state, 'answered');
  assert.equal(question.answer, 'Blue');
  assert.equal(question.lifecycle, 'finished');
  assert.equal(entries.filter((entry) => entry.callId === question.callId).length, 1, 'answer updates the pending entry in place');
  assert.equal(entries.some((entry) => entry.role === 'tool' && entry.name === 'AskUserQuestion'), false);
});

test('T9: AskUserQuestion fixture preserves multi-select choices and combined answer', () => {
  const { entries } = runFileOps(loadJsonl(QUESTION_JSONL), 'question-t9');
  const question = entries.find((entry) => entry.callId === 'toolu_018maJpZWT88LdSfe2mv9GMX');
  assert.ok(question, 'multi-select question entry exists');
  assert.equal(question.role, 'question');
  assert.equal(question.question, 'Which toppings should the pizza have?');
  assert.equal(question.header, 'Toppings');
  assert.equal(question.multiSelect, true);
  assert.deepEqual(question.options.map((option) => option.label), ['Cheese', 'Mushrooms', 'Olives']);
  assert.equal(question.state, 'answered');
  assert.equal(question.answer, 'Cheese, Olives');
  assert.equal(entries.filter((entry) => entry.callId === question.callId).length, 1, 'multi-select answer keeps request linkage');
});

test('malformed AskUserQuestion fixture produces readable, non-JSON fallback entries', () => {
  const events = loadJsonl(MALFORMED_QUESTION_JSONL, { skipInvalid: true });
  const { entries } = runFileOps(events, 'question-malformed');
  const questions = entries.filter((entry) => entry.role === 'question');
  assert.equal(events.length, 5, 'five schema-malformed records remain parseable; the truncated line is skipped by the tail');
  assert.equal(questions.length, 5);
  for (const question of questions) {
    assert.ok(question.question.trim(), 'fallback question is never blank');
    assert.doesNotMatch(question.question, /^[\[{]/, 'fallback question is not raw JSON');
    assert.ok(question.header.trim(), 'fallback header is never blank');
    for (const option of question.options) {
      assert.ok(option.label.trim(), 'fallback option is readable');
      assert.doesNotMatch(option.label, /^[\[{]/, 'fallback option is not raw JSON');
    }
  }
  assert.equal(questions[0].question, 'Claude asked a question. Answer in the terminal.');
  assert.equal(questions[1].question, 'Which accent color should the dashboard use?');
});

test('file tail: meta/bookkeeping lines are silent; isMeta user lines skipped', () => {
  const { entries, warnings } = runFileOps([
    { type: 'last-prompt', lastPrompt: 'x', sessionId: 's' },
    { type: 'ai-title', aiTitle: 'T', sessionId: 's' },
    { type: 'summary', summary: 'S' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: injected' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  ]);
  assert.equal(entries.length, 0);
  assert.deepEqual(warnings, []);
});

test('live client path still ignores plain user text (outbox echoes it)', () => {
  resetTurnContext('live1');
  const ops = normalizeClaudeEvent(
    { type: 'user', message: { role: 'user', content: 'typed live' } },
    { streamId: 'live1' }
  );
  assert.deepEqual(ops, []);
});
