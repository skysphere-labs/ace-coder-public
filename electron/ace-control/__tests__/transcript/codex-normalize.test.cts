import { test } from 'vitest';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const { normalizeCodexEvent } = require('../../transcript/normalize/codex.cjs');

function loadFixture(name) {
  const p = path.join(__dirname, '..', '..', 'fixtures', 'codex', name, 'session.jsonl');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function runOps(events) {
  // Mini in-memory replayer mirroring store.upsertByKey + applyOp semantics.
  let entries = [];
  let keyed = new Map();
  const warnings = [];
  let seq = 0;
  const replaced = [];
  for (const evt of events) {
    const ops = normalizeCodexEvent(evt, { streamId: 's1' });
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
        entries = [];
        keyed = new Map();
        const saved = { ...op.summary, id: seq++ };
        entries.push(saved);
        replaced.push(saved);
      } else if (op.kind === 'warn') {
        warnings.push(op.code);
      }
    }
  }
  return { entries, warnings, replaced };
}

test('codex basic-session normalizes session_meta + turn marker', () => {
  const events = loadFixture('basic-session');
  const { entries } = runOps(events);
  assert.ok(entries.length >= 2, `expected some entries, got ${entries.length}`);
  // First entry must be session_start.
  const first = entries[0];
  assert.equal(first.role, 'system');
  assert.equal(first.subtype, 'session_start');
  // Ids are monotonic.
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i].id > entries[i - 1].id, 'ids monotonic');
  }
});

test('codex reasoning-session captures at least one turn marker', () => {
  const events = loadFixture('reasoning-session');
  const { entries } = runOps(events);
  const hasTaskStarted = entries.some((e) => e.role === 'system' && e.subtype === 'task_started');
  assert.ok(hasTaskStarted, 'expected a task_started system entry');
});

test('codex tool-session: tool events produce tool entries with statuses', () => {
  const events = loadFixture('tool-session');
  const { entries, warnings } = runOps(events);
  // We don't assert a specific count because real sessions vary, but the
  // sequence must be well-formed: any tool entry that resolved must carry
  // status != running.
  const toolEntries = entries.filter((e) => e.role === 'tool');
  for (const t of toolEntries) {
    if (t.lifecycle === 'finished') {
      assert.ok(['ok', 'error', 'denied', 'canceled'].includes(t.status), `bad status ${t.status}`);
    } else {
      assert.equal(t.status, 'running');
    }
  }
  // Warnings are allowed but should be capped at the known allowed kinds.
  for (const w of warnings) {
    assert.match(w, /^codex:/);
  }
});

test('codex agent_message_delta + agent_message finalizes one entry', () => {
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/tmp' } },
    { timestamp: '2024-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2024-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message_delta', turn_id: 't1', delta: 'Hello ' } },
    { timestamp: '2024-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message_delta', turn_id: 't1', delta: 'world' } },
    { timestamp: '2024-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Hello world', phase: 'final_answer', turn_id: 't1' } },
    { timestamp: '2024-01-01T00:00:05Z', type: 'event_msg', payload: { type: 'turn_finished' } },
  ];
  const { entries } = runOps(events);
  const agent = entries.filter((e) => e.role === 'agent');
  assert.equal(agent.length, 1, 'delta + final agent_message should collapse to one entry');
  assert.equal(agent[0].text, 'Hello world');
  assert.equal(agent[0].lifecycle, 'finished');
});

test('codex: multiple agent_messages in one turn land at their own positions', () => {
  // Codex can emit commentary agent_messages during a turn followed by tool
  // calls and a final agent_message. Each agent_message is its own entry at
  // the time it happened — the later one must NOT overwrite the earlier one
  // in place.
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/tmp' } },
    { timestamp: '2024-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { timestamp: '2024-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'delete random.txt' } },
    { timestamp: '2024-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'tool_call', call_id: 'c1', tool_name: 'exec', command: ['pwd'] } },
    { timestamp: '2024-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'tool_result', call_id: 'c1', status: 'success' } },
    { timestamp: '2024-01-01T00:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Deleted it.', phase: 'final_answer' } },
    { timestamp: '2024-01-01T00:00:06Z', type: 'event_msg', payload: { type: 'turn_finished' } },
  ];
  const { entries } = runOps(events);
  const sequence = entries.map((e) => e.role);
  // Expected order: system, system (task_started), user, tool, agent.
  const userIdx = entries.findIndex((e) => e.role === 'user');
  const toolIdx = entries.findIndex((e) => e.role === 'tool');
  const agentIdx = entries.findIndex((e) => e.role === 'agent');
  assert.ok(userIdx < toolIdx, `user (${userIdx}) must come before tool (${toolIdx})`);
  assert.ok(toolIdx < agentIdx, `tool (${toolIdx}) must come before agent (${agentIdx})`);
  void sequence;
});

test('codex agent_message entries from two turns do not collide', () => {
  // Codex's agent_message events don't carry turn_id. The normalizer keys off
  // the turn_id from task_started instead; without that, two consecutive
  // replies would upsert the same entry and the second would overwrite the
  // first — reading back as out-of-order history.
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/tmp' } },
    { timestamp: '2024-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { timestamp: '2024-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    { timestamp: '2024-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Hello!' } },
    { timestamp: '2024-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'turn_finished' } },
    { timestamp: '2024-01-01T00:00:05Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'T2' } },
    { timestamp: '2024-01-01T00:00:06Z', type: 'event_msg', payload: { type: 'user_message', message: 'create a file' } },
    { timestamp: '2024-01-01T00:00:07Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Created it.' } },
    { timestamp: '2024-01-01T00:00:08Z', type: 'event_msg', payload: { type: 'turn_finished' } },
  ];
  const { entries } = runOps(events);
  const agent = entries.filter((e) => e.role === 'agent');
  assert.equal(agent.length, 2, 'each turn should produce its own agent entry');
  assert.equal(agent[0].text, 'Hello!');
  assert.equal(agent[1].text, 'Created it.');
  // Order check: the "Created it." entry must come AFTER the second user
  // message in the full timeline, not before it.
  const orderedRoles = entries.map((e) => e.role);
  const userIndexes = entries.map((e, i) => (e.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const agentIndexes = entries.map((e, i) => (e.role === 'agent' ? i : -1)).filter((i) => i >= 0);
  assert.ok(userIndexes[0] < agentIndexes[0], 'first user < first agent');
  assert.ok(userIndexes[1] < agentIndexes[1], 'second user < second agent');
  assert.ok(agentIndexes[0] < userIndexes[1], 'first agent reply comes before second user message');
  void orderedRoles;
});

test('codex response_item does not double-emit when event_msg is present', () => {
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/tmp' } },
    {
      timestamp: '2024-01-01T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi there.' }],
      },
    },
    {
      timestamp: '2024-01-01T00:00:02Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Hi there.', phase: 'final_answer', turn_id: 'tA' },
    },
  ];
  const { entries } = runOps(events);
  const agent = entries.filter((e) => e.role === 'agent' && e.text === 'Hi there.');
  assert.equal(agent.length, 1, 'response_item + event_msg must collapse to a single entry');
});

test('codex response_item reasoning emits visible safe reasoning entries', () => {
  const events = [
    {
      timestamp: '2024-01-01T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Checked the live stream.' }],
        encrypted_content: 'private-ciphertext',
      },
    },
    {
      timestamp: '2024-01-01T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_2',
        summary: [],
        encrypted_content: 'private-ciphertext',
      },
    },
  ];
  const { entries } = runOps(events);
  const reasoning = entries.filter((e) => e.role === 'reasoning');
  assert.equal(reasoning.length, 2);
  assert.equal(reasoning[0].text, 'Checked the live stream.');
  assert.match(reasoning[1].text, /private reasoning/i);
  assert.doesNotMatch(JSON.stringify(entries), /private-ciphertext/);
});

test('codex modern tool search and MCP tool end normalize into tool entries', () => {
  const events = [
    {
      timestamp: '2024-01-01T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_call',
        call_id: 'call_search',
        status: 'completed',
        arguments: { query: 'browser automation', limit: 8 },
      },
    },
    {
      timestamp: '2024-01-01T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_output',
        call_id: 'call_search',
        status: 'completed',
        tools: [{ name: 'browser.open' }],
      },
    },
    {
      timestamp: '2024-01-01T00:00:03Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'list_apps',
        namespace: 'mcp__computer_use__',
        arguments: '{}',
        call_id: 'call_mcp',
      },
    },
    {
      timestamp: '2024-01-01T00:00:04Z',
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'call_mcp',
        invocation: { server: 'computer-use', tool: 'list_apps', arguments: {} },
        result: { Ok: { content: [{ type: 'text', text: 'Ace.app' }] } },
      },
    },
  ];
  const { entries, warnings } = runOps(events);
  assert.deepEqual(warnings, []);
  const tools = entries.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'tool_search');
  assert.equal(tools[0].status, 'ok');
  assert.deepEqual(tools[0].args, { query: 'browser automation', limit: 8 });
  assert.deepEqual(tools[0].result, [{ name: 'browser.open' }]);
  assert.equal(tools[0].tAt, Date.parse('2024-01-01T00:00:01Z'), 'tool_search preserves start time');
  assert.equal(tools[1].name, 'list_apps');
  assert.equal(tools[1].result, 'Ace.app');
  assert.equal(tools[1].tAt, Date.parse('2024-01-01T00:00:03Z'), 'MCP tool preserves start time');
});

test('codex turn_aborted becomes a persisted system entry instead of a warning', () => {
  const { entries, warnings } = runOps([
    {
      timestamp: '2024-01-01T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', reason: 'interrupted by user' },
    },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'system');
  assert.equal(entries[0].text, 'interrupted by user');
});

test('codex /compact emits replace op that clears history + inserts summary', () => {
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/' } },
    { timestamp: '2024-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2024-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    { timestamp: '2024-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Hello.' } },
    { timestamp: '2024-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'compact_started' } },
    {
      timestamp: '2024-01-01T00:00:05Z',
      type: 'event_msg',
      payload: { type: 'compact_finished', summary: 'Prior turn: greeted user.' },
    },
    { timestamp: '2024-01-01T00:00:06Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
    { timestamp: '2024-01-01T00:00:07Z', type: 'event_msg', payload: { type: 'user_message', message: 'continue' } },
  ];
  const { entries, replaced } = runOps(events);
  // compact_started must NOT emit a replace (would flicker). Only
  // compact_finished drives the single wipe + summary insertion.
  assert.equal(replaced.length, 1, `expected exactly one replace, got ${replaced.length}`);
  // After the final compact_finished, the transcript contains the summary
  // and any entries emitted AFTER it (task_started + user_message).
  const summary = entries.find((e) => e.role === 'system' && /compacted|Prior turn/i.test(e.text || ''));
  assert.ok(summary, 'summary entry should be present');
  const user = entries.find((e) => e.role === 'user' && e.text === 'continue');
  assert.ok(user, 'post-compact user entry should be preserved');
  assert.ok(user.id > summary.id, 'post-compact events should come after the summary');
  // The pre-compact "Hello." agent message must NOT be in the final state.
  assert.ok(!entries.some((e) => e.role === 'agent' && e.text === 'Hello.'), 'pre-compact history should be wiped');
});

test('codex approval roundtrip: request → response flips status', () => {
  const events = [
    { timestamp: '2024-01-01T00:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/' } },
    {
      timestamp: '2024-01-01T00:00:01Z',
      type: 'event_msg',
      payload: {
        type: 'approval_request',
        request_id: 'req-1',
        reason: 'Run rm -rf /tmp/x',
        command: ['rm', '-rf', '/tmp/x'],
      },
    },
    {
      timestamp: '2024-01-01T00:00:02Z',
      type: 'event_msg',
      payload: { type: 'approval_response', request_id: 'req-1', approved: true },
    },
  ];
  const { entries } = runOps(events);
  const ap = entries.find((e) => e.role === 'approval');
  assert.ok(ap, 'expected an approval entry');
  assert.equal(ap.status, 'approved');
  assert.equal(ap.lifecycle, 'finished');
});
