const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHermesRecord,
  normalizeHermesSnapshot,
  isCompactionSummary,
  classifyToolStatus,
  isBackgroundSkillReviewText,
  isSelfImprovementReviewSummaryText,
} = require('../../transcript/normalize/hermes.cjs');

// Mini in-memory replayer mirroring store.upsertByKey + applyOp semantics.
function runOps(records) {
  let entries = [];
  let keyed = new Map();
  const warnings = [];
  const replaced = [];
  let seq = 0;
  for (const rec of records) {
    const ops = normalizeHermesRecord(rec);
    for (const op of ops) {
      if (op.kind === 'append') {
        entries.push({ ...op.entry, id: seq++ });
      } else if (op.kind === 'upsert') {
        if (keyed.has(op.key)) {
          const id = keyed.get(op.key);
          const idx = entries.findIndex((e) => e.id === id);
          if (idx >= 0) {
            const prev = entries[idx];
            const next = op.build(prev);
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

test('hermes user message becomes user entry', () => {
  const ops = normalizeHermesRecord({ role: 'user', content: 'Online?' });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'append');
  assert.equal(ops[0].entry.role, 'user');
  assert.equal(ops[0].entry.text, 'Online?');
});

test('hermes assistant content becomes agent entry', () => {
  const ops = normalizeHermesRecord({
    role: 'assistant',
    content: 'Online, Chief.',
    timestamp: '2026-05-03T14:20:21.000Z',
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].entry.role, 'agent');
  assert.equal(ops[0].entry.lifecycle, 'finished');
});

test('hermes assistant with tool_calls upserts tool entries by call id', () => {
  const records = [
    {
      role: 'assistant',
      content: 'Running shell.',
      timestamp: 1000,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":"ls"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_abc',
      content: 'README.md\nsrc',
      timestamp: 5000,
    },
  ];
  const { entries } = runOps(records);
  // Expect: assistant content + one tool entry (running -> ok)
  assert.equal(entries.length, 2);
  const tool = entries.find((e) => e.role === 'tool');
  assert.ok(tool);
  assert.equal(tool.name, 'terminal');
  assert.deepEqual(tool.args, { command: 'ls' });
  assert.equal(tool.status, 'ok');
  assert.equal(tool.lifecycle, 'finished');
  assert.equal(tool.result, 'README.md\nsrc');
  assert.equal(tool.callId, 'call_abc');
  assert.equal(tool.tAt, 1000);
});

test('hermes clarify preserves choices and resolves the answer on the same question entry', () => {
  const records = [
    {
      role: 'assistant',
      timestamp: 1000,
      tool_calls: [
        {
          id: 'call_clarify',
          type: 'function',
          function: {
            name: 'clarify',
            arguments: '{"question":"Which deployment target?","choices":["Staging","Production"]}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_clarify',
      content: JSON.stringify({
        question: 'Which deployment target?',
        choices_offered: ['Staging', 'Production'],
        user_response: 'Production',
      }),
      timestamp: 5000,
    },
  ];
  const { entries } = runOps(records);
  assert.equal(entries.length, 1, 'clarify result updates its pending question instead of adding a tool row');
  const question = entries[0];
  assert.equal(question.role, 'question');
  assert.equal(question.questionId, 'call_clarify');
  assert.equal(question.callId, 'call_clarify');
  assert.equal(question.source, 'hermes');
  assert.equal(question.question, 'Which deployment target?');
  assert.equal(question.header, 'Question');
  assert.equal(question.multiSelect, false);
  assert.deepEqual(question.options, [{ label: 'Staging' }, { label: 'Production' }]);
  assert.equal(question.state, 'answered');
  assert.equal(question.answer, 'Production');
  assert.equal(question.lifecycle, 'finished');
  assert.equal(question.tAt, 1000);
});

test('hermes snapshot maps clarify calls and results to a typed question entry', () => {
  const items = normalizeHermesSnapshot({
    session_id: 'clarify-session',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_snapshot_clarify',
            function: {
              name: 'clarify',
              arguments: '{"question":"Pick a layout","choices":["Tight","Loose"]}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_snapshot_clarify',
        content: '{"question":"Pick a layout","choices_offered":["Tight","Loose"],"user_response":"Loose"}',
      },
    ],
  });
  const questions = items.filter((item) => item.keyPath === 'question:call_snapshot_clarify:0');
  assert.equal(questions.length, 2, 'pending and answered emissions share the stable snapshot key');
  assert.equal(questions[0].entry.state, 'pending');
  assert.equal(questions[1].entry.state, 'answered');
  assert.equal(questions[1].entry.answer, 'Loose');
  assert.deepEqual(questions[1].entry.options, [{ label: 'Tight' }, { label: 'Loose' }]);
  assert.equal(items.some((item) => item.keyPath === 'tool:call_snapshot_clarify'), false);
});

test('malformed hermes clarify input becomes readable safe text', () => {
  const ops = normalizeHermesRecord({
    role: 'assistant',
    tool_calls: [
      {
        id: 'call_bad_clarify',
        function: { name: 'clarify', arguments: '{"question":{"raw":"json"},"choices":"Red, Blue"}' },
      },
    ],
  });
  const question = ops[0].build(null);
  assert.equal(question.role, 'question');
  assert.equal(question.question, 'Hermes asked a question. Answer in the terminal.');
  assert.equal(question.header, 'Question');
  assert.deepEqual(question.options, []);
  assert.equal(question.fallback, true);
  assert.doesNotMatch(question.question, /^[\[{]/);
});

test('hermes codex app-server tool ids canonicalize to Codex call ids', () => {
  const records = [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'codex_exec_call_xyz',
          type: 'function',
          function: { name: 'exec_command', arguments: '{"command":"pwd"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'codex_exec_call_xyz',
      content: '/tmp\n',
    },
  ];
  const ops = records.flatMap((record) => normalizeHermesRecord(record));
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, 'upsert');
  assert.equal(ops[1].kind, 'upsert');
  assert.equal(ops[0].key, 'tool:call_xyz');
  assert.equal(ops[1].key, 'tool:call_xyz');
  assert.equal(ops[0].build(null).callId, 'call_xyz');
  assert.equal(ops[1].build({ name: 'exec_command' }).callId, 'call_xyz');
});

test('hermes assistant with reasoning_content emits reasoning entry', () => {
  const ops = normalizeHermesRecord({
    role: 'assistant',
    content: 'Done.',
    reasoning_content: 'Decided to call terminal because…',
  });
  // One reasoning + one agent.
  assert.equal(ops.length, 2);
  assert.equal(ops[0].entry.role, 'reasoning');
  assert.equal(ops[1].entry.role, 'agent');
});

test('hermes assistant surfaces provider reasoning summary and message items', () => {
  const ops = normalizeHermesRecord({
    role: 'assistant',
    content: '',
    codex_reasoning_items: [
      {
        type: 'reasoning',
        encrypted_content: 'private',
        summary: [{ type: 'summary_text', text: 'Checked the dispatch status.' }],
      },
    ],
    codex_message_items: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Dispatch is still running.' }],
      },
    ],
  });
  assert.equal(ops.length, 2);
  assert.equal(ops[0].entry.role, 'reasoning');
  assert.equal(ops[0].entry.text, 'Checked the dispatch status.');
  assert.equal(ops[1].entry.role, 'agent');
  assert.equal(ops[1].entry.text, 'Dispatch is still running.');
  assert.doesNotMatch(JSON.stringify(ops), /private/);
});

test('hermes suppresses background skill review records from chat transcript', () => {
  const records = [
    { role: 'system', content: 'background skill review notify: nightly curator checked installed skills' },
    { role: 'assistant', content: 'creation_nudge: run self-improvement skill update review' },
    { role: 'assistant', reasoning_content: 'background review of skill updates', content: '' },
    { role: 'assistant', content: 'self-improvement skill update review completed' },
    { role: 'assistant', content: 'skill update review completed' },
    { role: 'user', content: 'Current HERMES_HOME under review: /tmp/hermes-home-prj-test. This scheduled job runs once per Hermes home.' },
    { role: 'assistant', content: 'I will run this as a contained harvest pass with skills metadata-only counts.' },
    { role: 'assistant', content: 'NIGHTLY_SKILL_HARVEST: PASS\nskills_changed:\n- none' },
    { role: 'assistant', content: 'We should improve the project skills and update the docs.' },
    { role: 'assistant', content: 'Visible operator status stays in chat.' },
  ];

  const { entries } = runOps(records);
  assert.deepEqual(entries.map((e) => e.text), [
    'We should improve the project skills and update the docs.',
    'Visible operator status stays in chat.',
  ]);
  assert.equal(isBackgroundSkillReviewText('curator skill-update review'), false);
  assert.equal(isBackgroundSkillReviewText('background curator skill-update notify'), true);
});

test('hermes surfaces self-improvement review.summary events as system info', () => {
  const text = "💾 Self-improvement review: Skill 'ace-task-worker' patched";
  const ops = normalizeHermesRecord({
    type: 'review.summary',
    payload: { text },
    timestamp: '2026-05-03T14:20:21.000Z',
  });

  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'append');
  assert.equal(ops[0].entry.role, 'system');
  assert.equal(ops[0].entry.subtype, 'info');
  assert.equal(ops[0].entry.text, text);
  assert.equal(isSelfImprovementReviewSummaryText(text), true);
  assert.equal(isBackgroundSkillReviewText(text), false);
});

test('hermes snapshot surfaces self-improvement review.summary events', () => {
  const text = 'Self-improvement review: skill update review completed';
  const items = normalizeHermesSnapshot({
    session_id: '20260505_165042_39061e',
    session_start: '2026-05-05T16:50:42Z',
    messages: [{ type: 'review.summary', payload: { text }, timestamp: '2026-05-05T16:50:43Z' }],
  });

  assert.equal(items.length, 2);
  assert.equal(items[1].keyPath, 'review-summary:0');
  assert.equal(items[1].entry.role, 'system');
  assert.equal(items[1].entry.subtype, 'info');
  assert.equal(items[1].entry.text, text);
  assert.equal(isBackgroundSkillReviewText(text), false);
});

test('hermes preserves normal prose mentioning skills and self-improvement', () => {
  const records = [
    { role: 'system', content: 'Skill updates are available for this workspace.' },
    { role: 'assistant', content: 'A self-improvement pass could make the skill docs clearer.' },
  ];

  const { entries } = runOps(records);
  assert.deepEqual(entries.map((e) => e.text), [
    'Skill updates are available for this workspace.',
    'A self-improvement pass could make the skill docs clearer.',
  ]);
});

test('hermes compaction record replaces history with system summary', () => {
  const records = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    {
      role: 'assistant',
      content:
        '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.\nA lot more text follows here.',
    },
    { role: 'user', content: 'after compaction' },
  ];
  const { entries, replaced } = runOps(records);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].role, 'system');
  // After replace, only summary + the trailing user record survive.
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'system');
  assert.equal(entries[1].role, 'user');
});

test('hermes tool record without tool_call_id surfaces a warning', () => {
  const ops = normalizeHermesRecord({ role: 'tool', content: 'orphan' });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'warn');
  assert.match(ops[0].code, /tool-missing-id/);
});

test('hermes tool error content classifies as error status', () => {
  assert.equal(classifyToolStatus('Error: command not found'), 'error');
  assert.equal(classifyToolStatus('Traceback (most recent call last):'), 'error');
  assert.equal(classifyToolStatus('ok'), 'ok');
  assert.equal(classifyToolStatus(''), 'ok');
});

test('isCompactionSummary detects bracketed marker', () => {
  assert.equal(isCompactionSummary('[CONTEXT COMPACTION — REFERENCE ONLY] foo'), true);
  assert.equal(isCompactionSummary('  [CONTEXT COMPACTION] x'), true);
  assert.equal(isCompactionSummary('plain text'), false);
});

test('hermes unknown role surfaces a warning op', () => {
  const ops = normalizeHermesRecord({ role: 'random', content: 'x' });
  assert.equal(ops[0].kind, 'warn');
  assert.match(ops[0].code, /random/);
});

test('hermes empty assistant record yields no entries', () => {
  const ops = normalizeHermesRecord({ role: 'assistant', content: '' });
  assert.deepEqual(ops, []);
});

// --- Ace's actual on-disk shape: session_<id>.json (json-rewrite). ---

test('normalizeHermesSnapshot maps user/assistant/tool messages to entries', () => {
  const items = normalizeHermesSnapshot({
    session_id: '20260505_165042_39061e',
    session_start: '2026-05-05T16:50:42Z',
    messages: [
      { role: 'user', content: 'Online?', timestamp: '2026-05-05T16:50:43Z' },
      {
        role: 'assistant',
        content: 'Online, Chief.',
        reasoning_content: 'Greet the user.',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: 'README.md\nsrc' },
    ],
  });
  // Expect: meta, user, reasoning, agent, tool (running), tool (finished).
  // The two tool entries share the same keyPath so the controller's upsert
  // collapses them in storage; the normalizer is pure and emits both.
  const byKey = new Map();
  for (const it of items) byKey.set(it.keyPath, it);
  assert.ok(byKey.has('meta:20260505_165042_39061e'));
  assert.ok(byKey.has('user:0'));
  assert.equal(byKey.get('user:0').entry.role, 'user');
  assert.ok(byKey.has('reasoning:1'));
  assert.equal(byKey.get('reasoning:1').entry.role, 'reasoning');
  assert.ok(byKey.has('agent:1'));
  assert.equal(byKey.get('agent:1').entry.role, 'agent');
  // Both tool emissions land on the same keyPath; the FINAL one in `items`
  // is what the upsert ultimately stores (status=ok, lifecycle=finished,
  // result populated, name+args reconstructed via lookup).
  const toolItems = items.filter((it) => it.keyPath === 'tool:call_abc');
  assert.equal(toolItems.length, 2);
  const finalTool = toolItems[toolItems.length - 1].entry;
  assert.equal(finalTool.role, 'tool');
  assert.equal(finalTool.name, 'terminal');
  assert.deepEqual(finalTool.args, { command: 'ls' });
  assert.equal(finalTool.status, 'ok');
  assert.equal(finalTool.lifecycle, 'finished');
  assert.equal(finalTool.result, 'README.md\nsrc');
});

test('normalizeHermesSnapshot tool result classifies error content', () => {
  const items = normalizeHermesSnapshot({
    session_id: 's1',
    messages: [
      {
        role: 'assistant',
        content: 'try it',
        tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'Error: command not found' },
    ],
  });
  const finalTool = items.filter((it) => it.keyPath === 'tool:c1').pop().entry;
  assert.equal(finalTool.status, 'error');
});

test('normalizeHermesSnapshot maps provider summary, dispatch, and subprocess tools', () => {
  const items = normalizeHermesSnapshot({
    session_id: 'activity',
    messages: [
      {
        role: 'assistant',
        content: '',
        codex_reasoning_items: [
          {
            type: 'reasoning',
            encrypted_content: 'private',
            summary: [{ type: 'summary_text', text: 'Prepared worker dispatch.' }],
          },
        ],
        codex_message_items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Dispatching worker.' }],
          },
        ],
        tool_calls: [
          {
            id: 'call_dispatch',
            function: { name: 'terminal', arguments: '{"command":"ace mission dispatch --feature ft_42"}' },
          },
          {
            id: 'call_process',
            function: { name: 'process', arguments: '{"action":"poll","session_id":"proc_123"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_dispatch', content: 'dispatched worker stream' },
      { role: 'tool', tool_call_id: 'call_process', content: 'still running' },
    ],
  });
  const byKey = new Map();
  for (const it of items) byKey.set(it.keyPath, it);
  assert.equal(byKey.get('reasoning:0').entry.text, 'Prepared worker dispatch.');
  assert.equal(byKey.get('agent:0').entry.text, 'Dispatching worker.');
  assert.doesNotMatch(JSON.stringify(items), /private/);
  assert.equal(byKey.get('tool:call_dispatch').entry.name, 'terminal');
  assert.deepEqual(byKey.get('tool:call_dispatch').entry.args, {
    command: 'ace mission dispatch --feature ft_42',
  });
  assert.equal(byKey.get('tool:call_process').entry.name, 'process');
  assert.deepEqual(byKey.get('tool:call_process').entry.args, {
    action: 'poll',
    session_id: 'proc_123',
  });
});

test('normalizeHermesSnapshot hides background skill-review text without removing tool records', () => {
  const items = normalizeHermesSnapshot({
    session_id: 'skill-review',
    messages: [
      { role: 'system', content: 'background skill-review notify: curator found update candidates' },
      { role: 'assistant', content: 'self-improvement skill update review completed' },
      { role: 'assistant', content: 'A self-improvement pass could make the skill docs clearer.' },
      {
        role: 'assistant',
        content: 'Harvesting skill metadata.',
        tool_calls: [{ id: 'harvest_1', function: { name: 'terminal', arguments: '{"command":"skill-harvest --nightly"}' } }],
      },
      { role: 'tool', tool_call_id: 'harvest_1', content: 'harvest complete' },
    ],
  });

  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /skill-review notify/);
  assert.doesNotMatch(serialized, /self-improvement skill update review completed/);
  assert.match(serialized, /A self-improvement pass could make the skill docs clearer\./);
  const toolItems = items.filter((it) => it.keyPath === 'tool:harvest_1');
  assert.equal(toolItems.length, 2);
  assert.equal(toolItems[toolItems.length - 1].entry.result, 'harvest complete');
});

test('normalizeHermesSnapshot handles empty messages array', () => {
  const items = normalizeHermesSnapshot({ session_id: 'x', messages: [] });
  // Just the meta entry.
  assert.equal(items.length, 1);
  assert.equal(items[0].entry.role, 'system');
});

test('normalizeHermesSnapshot rejects non-object input', () => {
  assert.deepEqual(normalizeHermesSnapshot(null), []);
  assert.deepEqual(normalizeHermesSnapshot('foo'), []);
});
