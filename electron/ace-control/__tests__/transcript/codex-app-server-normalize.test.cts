const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCodexEvent } = require('../../transcript/normalize/codex.cjs');

function runOps(events, ctx = { streamId: 's1' }) {
  let entries = [];
  const keyed = new Map();
  let seq = 0;
  for (const evt of events) {
    const ops = normalizeCodexEvent(evt, ctx);
    for (const op of ops) {
      if (op.kind === 'upsert') {
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
      } else if (op.kind === 'append') {
        entries.push({ ...op.entry, id: seq++ });
      }
    }
  }
  return entries;
}

test('codex app-server response_item function_call surfaces an open tool entry', () => {
  const entries = runOps([
    {
      timestamp: '2026-05-15T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sid', cwd: '/tmp', originator: 'hermes', cli_version: '0.130.0' },
    },
    {
      timestamp: '2026-05-15T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
        call_id: 'call_abc',
      },
    },
  ]);
  const tools = entries.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 1, 'one tool entry');
  assert.equal(tools[0].name, 'exec_command');
  assert.equal(tools[0].status, 'running');
  assert.equal(tools[0].lifecycle, 'open');
  assert.equal(tools[0].callId, 'call_abc');
  assert.deepEqual(tools[0].args, { cmd: 'pwd' });
});

test('codex app-server function_call_output finalizes the same tool entry by call_id', () => {
  const entries = runOps([
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
        call_id: 'call_x',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_x',
        output: '/Users/foo\n',
      },
    },
  ]);
  const tools = entries.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 1, 'one merged tool entry');
  assert.equal(tools[0].lifecycle, 'finished');
  assert.equal(tools[0].status, 'ok');
  assert.equal(tools[0].result, '/Users/foo\n');
  assert.equal(tools[0].name, 'exec_command', 'name preserved from call');
});

test('codex app-server custom_tool_call (apply_patch) surfaces as a tool entry', () => {
  const entries = runOps([
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_p',
        input: '*** Begin Patch\n...',
        status: 'completed',
      },
    },
  ]);
  const tools = entries.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'apply_patch');
  assert.equal(tools[0].callId, 'call_p');
});

test('function_call_output with success:false JSON output marks status=error', () => {
  const entries = runOps([
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'session_search',
        arguments: '{"limit":5}',
        call_id: 'call_e',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_e',
        output: '{"error":"db malformed","success":false}',
      },
    },
  ]);
  const tools = entries.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, 'error');
});
