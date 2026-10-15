// Fast settle windows for the whole suite — the trailer reconcile is
// settle-gated and these tests only assert outcomes, never real latency.
process.env.ACE_SM_QUIET_MS = '150';
process.env.ACE_SM_MIN_TURN_MS = '150';
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

// STORE ISOLATION — must run BEFORE the controller module is loaded. Several
// tests below build createAceController without a userDataPath; the child
// registry and follow-up store would then default to the operator's REAL
// ~/.ace/child-registry.json and ~/.ace/follow-ups.json, leaking fixture rows
// (task-fast / tsk_done / t1) into live board state. Redirect every
// home-defaulted store to a throwaway tmp dir for the whole test process.
const CONTROLLER_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-controller-home-'));
process.env.ACE_HOME = CONTROLLER_TEST_HOME;
process.env.ACE_CHILD_REGISTRY_PATH = path.join(CONTROLLER_TEST_HOME, 'child-registry.json');
process.env.ACE_FOLLOW_UP_STORE_PATH = path.join(CONTROLLER_TEST_HOME, 'follow-ups.json');

const { createAceController } = require('../index.cjs');

function makeMockStore({ catalog = [], getContextForStream = null } = {}) {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  const writes = [];
  const ensureCalls = [];
  const store = {
    onPtyData: (cb) => { ee.on('pty:data', cb); return () => ee.off('pty:data', cb); },
    onPtyOpened: (cb) => { ee.on('pty:opened', cb); return () => ee.off('pty:opened', cb); },
    onPtyExit: (cb) => { ee.on('pty:exit', cb); return () => ee.off('pty:exit', cb); },
    writeTerminalInput: async ({ streamId, data }) => {
      writes.push({ streamId, data });
      return { ok: true };
    },
    resolveStreamOwner: (id) => (id.startsWith('conversation:') ? { agent: 'claude', cwd: '/tmp' } : null),
    createConversation: () => ({ id: 'abc' }),
    ensureStreamStarted: async ({ streamId }) => {
      ensureCalls.push(streamId);
      return { ok: true };
    },
    getContextForStream: ({ streamId }) => getContextForStream?.({ streamId }) ?? ({
      streamId,
      taskId: streamId === 'conversation:worker-done' ? 'tsk_done' : 't1',
      workspaceId: 'ws1',
      branch: streamId === 'conversation:worker-done' ? 'handoff-feat' : null,
      worktreePath: streamId === 'conversation:worker-done' ? '/tmp/handoff-feat' : null,
      cwd: '/tmp',
    }),
    closeConversation: () => ({ ok: true }),
    killShellStream: () => ({ ok: true }),
    killStream: () => {},
    getState: () => ({
      version: 3,
      workspaces: [
        {
          id: 'ws1',
          tasks: [
            {
              id: 't1',
              conversations: catalog,
              worktrees: [],
            },
          ],
        },
      ],
      missions: [],
    }),
  };
  return { store, ee, writes, ensureCalls };
}

function makeMemoryTranscriptStore() {
  const links = new Map();
  const entries = new Map();
  const listFor = (streamId) => {
    if (!entries.has(streamId)) entries.set(streamId, []);
    return entries.get(streamId);
  };
  const store = {
    appendEntry(streamId, entry) {
      const list = listFor(streamId);
      const saved = {
        ...entry,
        id: list.length,
        lifecycle: entry.lifecycle || 'finished',
        tAt: entry.tAt || Date.now(),
      };
      list.push(saved);
      return saved;
    },
    replaceEntry(streamId, seq, entry) {
      const list = listFor(streamId);
      const saved = { ...entry, id: seq, lifecycle: entry.lifecycle || 'finished', tAt: entry.tAt || Date.now() };
      list[seq] = saved;
      return saved;
    },
    upsertByKey(streamId, _key, build) {
      const saved = store.appendEntry(streamId, build(null));
      return { entry: saved, created: true };
    },
    readEntries(streamId, { since = -1, limit = 10000 } = {}) {
      return listFor(streamId).filter((entry) => entry.id > since).slice(0, limit);
    },
    readLatestEntries(streamId, { limit = 20 } = {}) {
      return listFor(streamId).slice(-limit);
    },
    readEntriesBefore(streamId, { before, limit = 20 } = {}) {
      return listFor(streamId).filter((entry) => entry.id < before).slice(-limit);
    },
    hasEntriesBefore(streamId, before) {
      return listFor(streamId).some((entry) => entry.id < before);
    },
    truncateAfter(streamId, seq) {
      entries.set(streamId, listFor(streamId).filter((entry) => entry.id < seq));
    },
    clear(streamId) {
      entries.set(streamId, []);
    },
    link(streamId, row) {
      links.set(streamId, { ...row, streamId });
    },
    getLink(streamId) {
      return links.get(streamId) || null;
    },
    setByteOffset() {},
    setTurnState() {},
    unlink(streamId) {
      links.delete(streamId);
    },
    close() {},
    getNextSeq(streamId) {
      return listFor(streamId).length;
    },
  };
  return store;
}

test('controller tracks streams and drives ask through approval', async () => {
  const { store, ee, writes } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:abc';

  // First data arrives — controller registers the tab.
  ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const ls = await controller.methods.streamList();
  assert.equal(ls.streams.length, 1);
  assert.equal(ls.streams[0].agent, 'claude');
  assert.equal(ls.streams[0].state, 'awaiting-input');

  const askPromise = controller.methods.streamAsk({ streamId, prompt: 'hi', timeoutMs: 5000 });

  // Simulate the Ace after receiving the prompt: echo + busy + complete.
  await new Promise((r) => setTimeout(r, 40));
  ee.emit('pty:data', { id: streamId, chunk: '\u276f hi\r\n\u273b Thinking...\r\n' });
  await new Promise((r) => setTimeout(r, 40));
  ee.emit('pty:data', { id: streamId, chunk: 'All done!\r\n\u276f \r\n' });

  const askResult = await askPromise;
  assert.equal(askResult.ok, true);
  assert.equal(askResult.endState, 'turn-complete');

  // Paste went through in bracketed form, plus a submit key.
  assert.ok(writes.some((w) => w.data.includes('\x1b[200~hi\x1b[201~')));
  assert.ok(writes.some((w) => w.data === '\r'));

  controller.shutdown();
});

test('runBoard initializes the run-ledger harness before projecting existing events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-run-board-'));
  const ledgerDir = path.join(tmp, '.ace', 'run-ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(
    path.join(ledgerDir, 'events.ndjson'),
    [
      {
        id: 'run-existing:intent.created:1',
        runId: 'run-existing',
        ts: 1,
        type: 'intent.created',
        payload: {
          spec: {
            goal: 'Keep existing run visible after boot',
            agent: 'codex',
            scope: { workspaceId: 'ws1' },
          },
          risk: 'low',
        },
      },
      {
        id: 'run-existing:run.created:2',
        runId: 'run-existing',
        ts: 2,
        type: 'run.created',
        payload: {
          spec: {
            goal: 'Keep existing run visible after boot',
            agent: 'codex',
            scope: { workspaceId: 'ws1' },
          },
          risk: 'low',
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n'
  );

  const { store } = makeMockStore();
  const controller = createAceController({ aceStore: store, userDataPath: tmp });

  try {
    const board = controller.methods.runBoard();
    assert.equal(board.cards.length, 1);
    assert.equal(board.cards[0].id, 'run-existing');
    assert.equal(board.cards[0].stage, 'todo');
    assert.equal(board.cards[0].workspaceId, 'ws1');
    assert.deepEqual(board.columns.todo, ['run-existing']);
  } finally {
    controller.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('controller streamAsk honors explicit type delivery mode', async () => {
  const { store, ee, writes } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:type-mode';

  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 300));

    const askPromise = controller.methods.streamAsk({
      streamId,
      prompt: 'typed prompt',
      mode: 'type',
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 260));
    ee.emit('pty:data', { id: streamId, chunk: '\u276f typed prompt\r\nWorking...\r\n' });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: streamId, chunk: 'Done\r\n\u276f \r\n' });

    const askResult = await askPromise;
    assert.equal(askResult.ok, true);
    assert.ok(writes.some((w) => w.data === 'typed prompt'));
    assert.ok(!writes.some((w) => w.data.includes('\x1b[200~typed prompt\x1b[201~')));
  } finally {
    controller.shutdown();
  }
});

test('controller ignores prompt-contained trailer examples and queues only assistant DONE', async () => {
  const { store, ee } = makeMockStore();
  const originalWrite = store.writeTerminalInput;
  store.writeTerminalInput = async ({ streamId, data }) => {
    const result = await originalWrite({ streamId, data });
    if (String(data).includes('\x1b[200~')) {
      const echoed = String(data)
        .replace('\x1b[200~', '')
        .replace('\x1b[201~', '');
      ee.emit('pty:data', { id: streamId, chunk: `\u276f ${echoed}\r\n` });
      await new Promise((r) => setTimeout(r, 30));
    }
    return result;
  };
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:worker-done';
  const events = [];
  const off = controller.bus.on('worker-completion', (payload) => events.push(payload));

  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 300));

    const askPromise = controller.methods.streamAsk({
      streamId,
      prompt: [
        'Use the escape hatch examples if needed:',
        'DONE: fake prompt example',
        'BLOCKED: fake prompt example',
        'ship it',
      ].join('\n'),
      timeoutMs: 7000,
    });
    await new Promise((r) => setTimeout(r, 80));
    ee.emit('pty:data', { id: streamId, chunk: 'Working...\r\n' });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: streamId, chunk: 'DONE: shipped event handoff\r\n\u276f \r\n' });

    const askResult = await askPromise;
    assert.equal(askResult.endState, 'turn-complete');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'done');
    assert.equal(events[0].detail, 'shipped event handoff');
    assert.equal(events[0].taskId, 'tsk_done');
    assert.equal(events[0].workspaceId, 'ws1');
    assert.equal(events[0].branch, 'handoff-feat');
    assert.equal(events[0].worktreePath, '/tmp/handoff-feat');

    const inbox = await controller.methods.streamCompletionList({});
    assert.equal(inbox.completions.length, 1);
    assert.equal(inbox.completions[0].id, events[0].id);
  } finally {
    off();
    controller.shutdown();
  }
});

test('controller emits worker-completion for no-submit DONE trailers', async () => {
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:no-submit-done';
  const events = [];
  const off = controller.bus.on('worker-completion', (payload) => events.push(payload));

  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n' });
    await new Promise((r) => setTimeout(r, 30));
    // The trailer reconcile is settle-gated: each trailer needs the byte-quiet
    // window (plus the trailing re-eval follow-up tick) before it records.
    ee.emit('pty:data', { id: streamId, chunk: 'DONE: shipped without submit\r\n' });
    await new Promise((r) => setTimeout(r, 900));
    ee.emit('pty:data', { id: streamId, chunk: 'more work\r\nDONE: shipped second\r\n' });
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event: any) => [event.kind, event.detail]),
      [
        ['done', 'shipped without submit'],
        ['done', 'shipped second'],
      ]
    );
    const inbox = await controller.methods.streamCompletionList({});
    assert.equal(inbox.completions.length, 2);
  } finally {
    off();
    controller.shutdown();
  }
});

test('controller records caller sent and received communication transcript cards', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-transcript-comm-'));
  const { store, ee } = makeMockStore();
  store.resolveStreamOwner = (id) => {
    if (id === 'conversation:worker') return { agent: 'claude', cwd: '/tmp/worker' };
    if (id === 'conversation:rook') return { agent: 'hermes', cwd: '/tmp/rook' };
    return null;
  };
  const controller = createAceController({
    aceStore: store,
    userDataPath: tmp,
    transcriptStore: makeMemoryTranscriptStore(),
  });
  const sourceStreamId = 'conversation:rook';
  const targetStreamId = 'conversation:worker';

  try {
    controller.transcripts._internal.store.link(sourceStreamId, {
      agent: 'hermes',
      sessionId: 'source-session',
      sessionFile: path.join(tmp, 'source.json'),
      cwd: '/tmp/rook',
      linkedAt: Date.now(),
    });
    controller.transcripts._internal.store.link(targetStreamId, {
      agent: 'claude',
      sessionId: 'target-session',
      sessionFile: path.join(tmp, 'target.jsonl'),
      cwd: '/tmp/worker',
      linkedAt: Date.now(),
    });

    ee.emit('pty:data', { id: targetStreamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({
      streamId: targetStreamId,
      prompt: 'please deploy token=abc123',
      timeoutMs: 5000,
      caller: {
        streamId: sourceStreamId,
        identity: 'Rook',
        agent: 'hermes',
        command: 'ask',
      },
    });

    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: targetStreamId, chunk: 'Working...\r\n' });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: targetStreamId, chunk: 'DONE: ok\r\n\u276f \r\n' });

    const askResult = await askPromise;
    assert.equal(askResult.ok, true);

    const sourceEntries = controller.transcripts
      .snapshot(sourceStreamId)
      .entries.filter((entry) => entry.role === 'communication');
    const targetEntries = controller.transcripts
      .snapshot(targetStreamId)
      .entries.filter((entry) => entry.role === 'communication');

    assert.equal(sourceEntries.length, 2);
    assert.equal(sourceEntries[0].direction, 'sent');
    assert.equal(sourceEntries[0].peerAgent, 'claude');
    assert.match(sourceEntries[0].body, /token=\[REDACTED\]/);
    assert.equal(sourceEntries[0].redacted, true);
    assert.equal(sourceEntries[1].direction, 'received');
    assert.match(sourceEntries[1].body, /DONE: ok/);
    assert.equal(targetEntries.length, 1);
    assert.equal(targetEntries[0].direction, 'received');
    assert.equal(targetEntries[0].peerLabel, 'Rook');

    controller.transcripts.appendCommunication(sourceStreamId, {
      direction: 'sent',
      command: 'send',
      body: 'x'.repeat(7000),
      peer: { streamId: targetStreamId, agent: 'codex' },
    });
    const longEntry = controller.transcripts
      .snapshot(sourceStreamId)
      .entries.filter((entry) => entry.role === 'communication')
      .at(-1);
    assert.equal(longEntry.truncated, true);
    assert.match(longEntry.body, /\.\.\.\[truncated 1000 chars\]/);
  } finally {
    controller.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('controller exposes slash, ref, approve, abort', async () => {
  const { store, ee, writes } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:abc';

  ee.emit('pty:data', { id: streamId, chunk: '\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  await controller.methods.streamSlash({ streamId, command: 'clear' });
  assert.ok(writes.some((w) => w.data.includes('/clear')));

  await controller.methods.streamRef({ streamId, filePath: 'src/app.ts' });
  assert.ok(writes.some((w) => w.data.includes('@src/app.ts')));

  // Approve without a pending approval should time out at the wait step. We
  // race a short external timeout so the test doesn't block on the default
  // 15s approval wait.
  let approveSettled = false;
  const approvePromise = controller.methods
    .streamApprove({ streamId, answer: 'yes' })
    .then(() => { approveSettled = true; })
    .catch(() => { approveSettled = true; });
  await Promise.race([
    new Promise((r) => setTimeout(r, 200)),
    approvePromise,
  ]);
  assert.equal(approveSettled, false, 'approve without pending approval should block, not resolve');

  await controller.methods.streamAbort({ streamId });
  // Claude profile uses esc as the interrupt — single ctrl+c interrupts a
  // turn, but the profile is configured for esc to avoid the second ctrl+c
  // (which exits Claude entirely).
  const escAborts = writes.filter((w) => w.data === '\x1b');
  assert.ok(escAborts.length >= 1, `expected at least one esc write, got ${escAborts.length}`);

  controller.shutdown();
});

test('raw terminal /resume arms once and the picker Enter confirms the session switch', async () => {
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:raw-resume';
  ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const calls = [];
  controller.transcripts.onSlashResume = async (...args) => { calls.push(['arm', ...args]); };
  controller.transcripts.onResumeSelection = async (...args) => { calls.push(['confirm', ...args]); };

  await controller.methods.streamObserveTerminalInput({ streamId, data: '\x1b[200~/resume\x1b[201~' });
  await controller.methods.streamObserveTerminalInput({ streamId, data: '\r' });
  await controller.methods.streamObserveTerminalInput({ streamId, data: '\n' });
  assert.equal(calls.filter((row) => row[0] === 'arm').length, 1);
  assert.equal(calls.filter((row) => row[0] === 'confirm').length, 0);

  await controller.methods.streamObserveTerminalInput({ streamId, data: '\x1b[B' });
  await controller.methods.streamObserveTerminalInput({ streamId, data: '\r\n' });
  assert.equal(calls.filter((row) => row[0] === 'confirm').length, 1);

  await controller.methods.streamObserveTerminalInput({ streamId, data: '/resume 22222222-2222-4222-8222-222222222222\r' });
  await controller.methods.streamObserveTerminalInput({ streamId, data: 'later unrelated input\r' });
  await controller.methods.streamSlash({
    streamId,
    command: 'resume',
    args: ['22222222-2222-4222-8222-222222222222'],
  });
  assert.equal(calls.filter((row) => row[0] === 'arm').length, 1);
  assert.equal(calls.filter((row) => row[0] === 'confirm').length, 1);
  controller.shutdown();
});

test('raw terminal observations serialize a fast picker Enter behind asynchronous resume arming', async () => {
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:raw-resume-race';
  ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  let releaseArm: any;
  const armGate = new Promise((resolve) => { releaseArm = resolve; });
  const calls = [];
  controller.transcripts.onSlashResume = async (...args) => {
    calls.push(['arm', ...args]);
    await armGate;
    return { ok: true };
  };
  controller.transcripts.onResumeSelection = async (...args) => { calls.push(['confirm', ...args]); };

  // local-core fires observations without awaiting; the controller must still preserve arrival order.
  const writes = [
    controller.methods.streamObserveTerminalInput({ streamId, data: '/resume' }),
    controller.methods.streamObserveTerminalInput({ streamId, data: '\r' }),
    controller.methods.streamObserveTerminalInput({ streamId, data: '\r' }),
  ];
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((row) => row[0] === 'arm').length, 1);
  assert.equal(calls.filter((row) => row[0] === 'confirm').length, 0);

  releaseArm();
  await Promise.all(writes);
  assert.equal(calls.filter((row) => row[0] === 'arm').length, 1);
  assert.equal(calls.filter((row) => row[0] === 'confirm').length, 1);
  controller.shutdown();
});

test('controller accepts Hermes lane slash commands by streamId', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'hermes', cwd: '/tmp/hermes' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermes-commands';

  try {
    ee.emit('pty:data', { id: streamId, chunk: '⚕ Hermes\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    await controller.methods.streamSlash({ streamId, command: 'steer', args: ['stay', 'concise'] });
    await controller.methods.streamSlash({ streamId, command: 'new' });
    await controller.methods.streamSlash({ streamId, command: 'clear' });
    await controller.methods.streamSlash({ streamId, command: 'reset' });

    const streamWrites = writes
      .filter((w) => w.streamId === streamId)
      .map((w) => w.data)
      .join('\n');
    for (const expected of ['/steer stay concise', '/new', '/clear', '/reset']) {
      assert.ok(streamWrites.includes(expected), `expected ${expected} in Hermes stream writes`);
    }
  } finally {
    controller.shutdown();
  }
});

test('abort exposes interrupted state for busy stream without ready repaint', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'codex', cwd: '/tmp/codex' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:codex-stuck';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'OpenAI Codex\r\n\u203a \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    await controller.methods.streamSendSubmit({ streamId, text: 'review the PR' });
    ee.emit('pty:data', { id: streamId, chunk: 'Thinking...\r\ntokens used: 200000\r\nStill reviewing...\r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const before = await controller.methods.streamGetState({ streamId });
    assert.equal(before.state, 'busy');

    const abortRes = await controller.methods.streamAbort({ streamId });
    assert.equal(abortRes.ok, true);
    assert.equal(abortRes.state, 'interrupted');
    assert.ok(writes.some((w) => w.data === '\x03'), 'codex abort should send ctrl+c');

    const after = await controller.methods.streamGetState({ streamId });
    assert.equal(after.state, 'interrupted');
  } finally {
    controller.shutdown();
  }
});

test('streamSendSubmit returns promptMs telemetry for fire-and-forget dispatch', async () => {
  const { store, ee, writes } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:send-submit';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const result = await controller.methods.streamSendSubmit({ streamId, text: 'ship it' });
    assert.equal(result.ok, true);
    assert.equal(typeof result.telemetry.promptMs, 'number');
    assert.ok(result.telemetry.promptMs >= 0);
    assert.ok(writes.some((w) => w.data.includes('\x1b[200~ship it\x1b[201~')));
    assert.ok(writes.some((w) => w.data === '\r'));
  } finally {
    controller.shutdown();
  }
});

test('streamSendSubmit drops generated NaN garbage without submitting Enter', async () => {
  const { store, ee, writes } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:send-submit-garbage';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Claude Code v2\r\n\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const result = await controller.methods.streamSendSubmit({
      streamId,
      text: 'aN;NaNMaN;NaNMaN;NaNMa',
      mode: 'type',
    });

    assert.equal(result.ok, false);
    assert.deepEqual(writes.filter((w) => w.streamId === streamId), []);
  } finally {
    controller.shutdown();
  }
});

test('Hermes preflight compression exit restarts and replays the active prompt once', async () => {
  const { store, ee, writes, ensureCalls } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'hermes', cwd: '/tmp/hermes' });
  const originalEnsure = store.ensureStreamStarted;
  store.ensureStreamStarted = async (args) => {
    const result = await originalEnsure(args);
    setTimeout(() => {
      ee.emit('pty:opened', { id: args.streamId, agent: 'hermes', cwd: '/tmp/hermes' });
      ee.emit('pty:data', { id: args.streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    }, 10);
    return result;
  };
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermes-compression-replay';
  const prompt = 'survive compression and answer';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    await controller.methods.streamSendSubmit({ streamId, text: prompt });
    ee.emit('pty:data', {
      id: streamId,
      chunk: '📦 Preflight compression: ~181,835 tokens >= 180,000 threshold.\r\n🗜️ Compacting context — summarizing earlier conversation so I can continue...\r\n',
    });
    await new Promise((r) => setTimeout(r, 30));
    ee.emit('pty:exit', { id: streamId, code: 0 });

    for (let i = 0; i < 30; i++) {
      const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
      if (promptWrites.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
    assert.equal(promptWrites.length, 2, 'Hermes prompt should be sent once initially and once after compression restart');
    assert.equal(
      ensureCalls.filter((id) => id === streamId).length,
      1,
      'compression recovery should restart the same stream once'
    );
  } finally {
    controller.shutdown();
  }
});

test('Hermes ask records the active prompt for compression replay', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'hermes', cwd: '/tmp/hermes' });
  const originalEnsure = store.ensureStreamStarted;
  store.ensureStreamStarted = async (args) => {
    const result = await originalEnsure(args);
    setTimeout(() => {
      ee.emit('pty:opened', { id: args.streamId, agent: 'hermes', cwd: '/tmp/hermes' });
      ee.emit('pty:data', { id: args.streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    }, 10);
    return result;
  };
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermes-ask-compression-replay';
  const prompt = 'answer after compression';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({ streamId, prompt, timeoutMs: 1_500 });
    await new Promise((r) => setTimeout(r, 300));
    ee.emit('pty:data', {
      id: streamId,
      chunk: '📦 Preflight compression: ~181,835 tokens >= 180,000 threshold.\r\n🗜️ Compacting context — summarizing earlier conversation so I can continue...\r\n',
    });
    await new Promise((r) => setTimeout(r, 30));
    ee.emit('pty:exit', { id: streamId, code: 0 });

    for (let i = 0; i < 30; i++) {
      const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
      if (promptWrites.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await askPromise;
    const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
    assert.equal(promptWrites.length, 2, 'ask prompt should be replayed after compression restart');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /timed out/);
  } finally {
    controller.shutdown();
  }
});

test('Hermes post-compaction assistant output completes without a second user message', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'hermes', cwd: '/tmp/hermes' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermes-post-compaction-auto-response';
  const prompt = 'answer after compaction without another ping';
  try {
    ee.emit('pty:opened', { id: streamId, agent: 'hermes', cwd: '/tmp/hermes' });
    ee.emit('pty:data', { id: streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({
      streamId,
      prompt,
      timeoutMs: 8_000,
      submitRetryMs: 100,
    });
    await new Promise((r) => setTimeout(r, 300));
    ee.emit('pty:data', {
      id: streamId,
      chunk: '📦 Preflight compression: ~181,835 tokens >= 180,000 threshold.\r\n🗜️ Compacting context — summarizing earlier conversation so I can continue...\r\n',
    });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', {
      id: streamId,
      chunk: 'Continuing automatically after compaction.\r\nPOST_COMPACTION_OK\r\n❯ \r\n',
    });

    const result = await askPromise;
    await new Promise((r) => setTimeout(r, 200));
    const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
    assert.equal(promptWrites.length, 1, 'Hermes prompt should not be replayed after post-compaction output');
    assert.equal(result.ok, true);
    assert.equal(result.endState, 'turn-complete');
    assert.match(result.newOutput, /POST_COMPACTION_OK/);
  } finally {
    controller.shutdown();
  }
});

test('Hermes compression timeout returning to a fresh prompt replays the active prompt once', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'hermes', cwd: '/tmp/hermes' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermes-compression-ready-replay';
  const prompt = 'answer after compression timeout';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({ streamId, prompt, timeoutMs: 8_000 });
    await new Promise((r) => setTimeout(r, 300));
    ee.emit('pty:data', {
      id: streamId,
      chunk: '📦 Preflight compression: ~181,835 tokens >= 180,000 threshold.\r\n🗜️ Compacting context — summarizing earlier conversation so I can continue...\r\n',
    });
    await new Promise((r) => setTimeout(r, 30));
    ee.emit('pty:data', { id: streamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });

    for (let i = 0; i < 180; i++) {
      const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
      if (promptWrites.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const promptWrites = writes.filter((w) => w.streamId === streamId && w.data === prompt);
    assert.equal(promptWrites.length, 2, 'ask prompt should replay after compression returns to a fresh prompt');
    for (let i = 0; i < 40; i++) {
      const submitWrites = writes.filter((w) => w.streamId === streamId && w.data === '\r');
      if (submitWrites.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    ee.emit('pty:data', { id: streamId, chunk: 'Working after replay...\r\n' });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: streamId, chunk: '- one\r\n- two\r\n- three\r\n❯ \r\n' });

    const result = await askPromise;
    assert.equal(result.ok, true);
    assert.equal(result.endState, 'turn-complete');
  } finally {
    controller.shutdown();
  }
});

test('Hermes compression recovery follows a replacement stream with the same cwd', async () => {
  const { store, ee, writes } = makeMockStore();
  const oldStreamId = 'conversation:king-old';
  const newStreamId = 'conversation:king-new';
  const prompt = 'answer exactly KING_CHAT_OK';
  store.resolveStreamOwner = (id) => {
    if (id === oldStreamId || id === newStreamId) return { agent: 'hermes', cwd: '/tmp/king-workspace' };
    return null;
  };
  store.ensureStreamStarted = async ({ streamId }) => {
    if (streamId === oldStreamId) throw new Error('stream closed');
    return { ok: true };
  };
  const controller = createAceController({ aceStore: store });
  try {
    ee.emit('pty:data', { id: oldStreamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({ streamId: oldStreamId, prompt, timeoutMs: 8_000 });
    await new Promise((r) => setTimeout(r, 300));
    ee.emit('pty:data', {
      id: oldStreamId,
      chunk: '📦 Preflight compression: ~191,225 tokens >= 180,000 threshold.\r\n🗜️ Compacting context — summarizing earlier conversation so I can continue...\r\n',
    });
    await new Promise((r) => setTimeout(r, 30));
    ee.emit('pty:exit', { id: oldStreamId, code: 0 });

    await new Promise((r) => setTimeout(r, 30));
    ee.emit('pty:opened', { id: newStreamId, agent: 'hermes', cwd: '/tmp/king-workspace' });
    ee.emit('pty:data', { id: newStreamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });

    for (let i = 0; i < 120; i++) {
      const redirectedWrites = writes.filter((w) => w.streamId === newStreamId && w.data === prompt);
      if (redirectedWrites.length >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const redirectedWrites = writes.filter((w) => w.streamId === newStreamId && w.data === prompt);
    assert.equal(redirectedWrites.length, 1, 'Hermes prompt should replay on the replacement stream');

    await new Promise((r) => setTimeout(r, 500));
    ee.emit('pty:data', { id: newStreamId, chunk: 'Working after redirected replay...\r\n' });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: newStreamId, chunk: 'KING_CHAT_OK.\r\n❯ \r\n' });

    const result = await askPromise;
    assert.equal(result.ok, true);
    assert.equal(result.endState, 'turn-complete');
    assert.equal(result.redirectedStreamId, newStreamId);
    assert.match(result.newOutput, /KING_CHAT_OK/);
  } finally {
    controller.shutdown();
  }
});

test('ask resolves interrupted when abort cancels an in-flight turn', async () => {
  const { store, ee } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'codex', cwd: '/tmp/codex' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:codex-ask-abort';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'OpenAI Codex\r\n\u203a \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({ streamId, prompt: 'review the PR', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', { id: streamId, chunk: 'Thinking...\r\ntokens used: 200000\r\n' });
    await new Promise((r) => setTimeout(r, 40));

    await controller.methods.streamAbort({ streamId });
    const askResult = await askPromise;
    assert.equal(askResult.ok, false);
    assert.equal(askResult.endState, 'interrupted');
    assert.match(askResult.error, /interrupted/);
  } finally {
    controller.shutdown();
  }
});

test('ask resolves error for context length failure text', async () => {
  const { store, ee } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'codex', cwd: '/tmp/codex' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:codex-context-error';
  try {
    ee.emit('pty:data', { id: streamId, chunk: 'OpenAI Codex\r\n\u203a \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    const askPromise = controller.methods.streamAsk({ streamId, prompt: 'review the PR', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 40));
    ee.emit('pty:data', {
      id: streamId,
      chunk: 'Thinking...\r\ncontext_length_exceeded: model context window exhausted\r\n',
    });

    const askResult = await askPromise;
    assert.equal(askResult.ok, false);
    assert.equal(askResult.endState, 'error');
    assert.match(askResult.error, /error/);
  } finally {
    controller.shutdown();
  }
});

test('record and replay round-trip', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:rec';
  const outPath = path.join(os.tmpdir(), `ace-record-${Date.now()}.ndjson`);

  ee.emit('pty:data', { id: streamId, chunk: '\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const startRes = await controller.methods.streamRecordStart({ streamId, outPath });
  assert.equal(startRes.ok, true);

  ee.emit('pty:data', { id: streamId, chunk: 'hello world\r\n' });
  await new Promise((r) => setTimeout(r, 30));
  await controller.methods.streamRecordStop({ streamId });

  const body = fs.readFileSync(outPath, 'utf8');
  assert.ok(body.includes('hello world'), 'recording should include chunk content');

  const replay = await controller.methods.streamReplay({ recordPath: outPath, agent: 'claude' });
  assert.ok(replay.ok);
  assert.ok(replay.frames >= 1);

  fs.unlinkSync(outPath);
  controller.shutdown();
});

test('wait predicates: pattern and quiet-for', async () => {
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:wait';

  ee.emit('pty:data', { id: streamId, chunk: '\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  // pattern: becomes true once the viewport contains "marker"
  const p1 = controller.methods.streamWaitFor({
    streamId,
    predicate: { pattern: 'marker-[0-9]+' },
    timeoutMs: 2000,
  });
  setTimeout(() => ee.emit('pty:data', { id: streamId, chunk: 'prefix marker-42 suffix\r\n' }), 40);
  const r1 = await p1;
  assert.ok(r1.elapsedMs >= 0);

  // quiet-for: resolves once no data for N ms
  const start = Date.now();
  const r2 = await controller.methods.streamWaitFor({
    streamId,
    predicate: { quietForMs: 200 },
    timeoutMs: 3000,
  });
  assert.ok(Date.now() - start >= 200, 'quiet-for should wait at least the requested window');
  assert.ok(r2);

  controller.shutdown();
});

test('ace ls merges live + dormant tabs', async () => {
  const { store, ee } = makeMockStore({
    catalog: [
      { id: 'live1', agent: 'claude', title: 'Live One' },
      { id: 'dormant1', agent: 'codex', title: 'Dormant One' },
    ],
  });
  const controller = createAceController({ aceStore: store });

  // Make live1 live by emitting data
  ee.emit('pty:data', { id: 'conversation:live1', chunk: '\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const ls = await controller.methods.streamList();
  assert.equal(ls.streams.length, 2);
  const live = ls.streams.find((s) => s.streamId === 'conversation:live1');
  const dormant = ls.streams.find((s) => s.streamId === 'conversation:dormant1');
  assert.equal(live.live, true);
  assert.equal(live.state, 'awaiting-input');
  assert.equal(dormant.live, false);
  assert.equal(dormant.state, 'dormant');
  assert.equal(dormant.label, 'Dormant One');
  assert.equal(dormant.profile, 'codex');

  controller.shutdown();
});

test('ace ls labels a live identity stream ahead of stale dormant duplicates', async () => {
  const liveStreamId = 'conversation:conv-live-king';
  const { store, ee } = makeMockStore({
    catalog: [
      { id: 'conv-stale-1', agent: 'hermes', title: 'King' },
      { id: 'conv-stale-2', agent: 'hermes', title: 'King' },
    ],
    getContextForStream: ({ streamId }) => ({
      streamId,
      taskId: 'thr-king',
      workspaceId: 'prj-king',
      cwd: '/tmp/king-workspace',
      personalIdentity: 'king',
      agentLaneLabel: null,
    }),
  });
  const controller = createAceController({ aceStore: store });

  ee.emit('pty:opened', { id: liveStreamId, agent: 'hermes', cwd: '/tmp/king-workspace' });
  ee.emit('pty:data', { id: liveStreamId, chunk: 'Welcome to Hermes Agent!\r\n❯ \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const ls = await controller.methods.streamList();
  const kingRows = ls.streams.filter((s) => s.agent === 'hermes' && s.label === 'King');
  assert.deepEqual(
    kingRows.map((s) => ({ streamId: s.streamId, live: s.live, state: s.state })),
    [
      { streamId: liveStreamId, live: true, state: 'awaiting-input' },
      { streamId: 'conversation:conv-stale-1', live: false, state: 'dormant' },
      { streamId: 'conversation:conv-stale-2', live: false, state: 'dormant' },
    ]
  );

  controller.shutdown();
});

test('driving verbs auto-wake a dormant tab', async () => {
  const { store, ee, ensureCalls } = makeMockStore({
    catalog: [{ id: 'sleep', agent: 'claude', title: 'Sleeper' }],
  });
  const controller = createAceController({ aceStore: store });

  // Fire the "wake" PTY data shortly after ensureStreamStarted is called,
  // mimicking what ptyRegistry does when the process spawns.
  let pending = 0;
  const originalEnsure = store.ensureStreamStarted;
  store.ensureStreamStarted = async (args) => {
    pending++;
    setTimeout(() => {
      ee.emit('pty:data', { id: args.streamId, chunk: '\u276f \r\n' });
      pending--;
    }, 15);
    return originalEnsure(args);
  };

  const streamId = 'conversation:sleep';
  const res = await controller.methods.streamReadScreen({ streamId });
  assert.ok(res.text.length > 0, 'screen text should be populated after wake');
  assert.equal(ensureCalls.includes(streamId), true, 'ensureStreamStarted should have been called with the dormant streamId');

  // Second call is a no-op — tab is already tracked
  ensureCalls.length = 0;
  await controller.methods.streamReadScreen({ streamId });
  assert.equal(ensureCalls.length, 0, 'wake is idempotent after first success');

  assert.equal(pending, 0);
  controller.shutdown();
});

test('driving verbs wake a quiet PTY on open before first data', async () => {
  const { store, ee, ensureCalls } = makeMockStore({
    catalog: [{ id: 'quietwake', agent: 'hermes', title: 'Quiet Wake' }],
  });
  const controller = createAceController({ aceStore: store });
  const originalEnsure = store.ensureStreamStarted;
  store.ensureStreamStarted = async (args) => {
    setTimeout(() => {
      ee.emit('pty:opened', { id: args.streamId, agent: 'hermes', cwd: '/tmp/quiet-hermes' });
    }, 15);
    return originalEnsure(args);
  };

  const streamId = 'conversation:quietwake';
  try {
    const res = await controller.methods.streamReadScreen({ streamId });
    assert.ok(['booting', 'awaiting-input', 'turn-complete'].includes(res.state));
    assert.equal(typeof res.text, 'string');
    assert.equal(ensureCalls.includes(streamId), true, 'ensureStreamStarted should be called for quiet dormant stream');

    const ls = await controller.methods.streamList();
    const quiet = ls.streams.find((s) => s.streamId === streamId);
    assert.equal(quiet.live, true);
    assert.equal(quiet.agent, 'hermes');
    assert.equal(quiet.cwd, '/tmp/quiet-hermes');
  } finally {
    controller.shutdown();
  }
});

test('profiles that disable bracketed paste route through type', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => ({ agent: 'gemini', cwd: '/tmp' });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:g1';
  ee.emit('pty:data', { id: streamId, chunk: 'Type your message or @path/to/file\r\n' });
  await new Promise((r) => setTimeout(r, 30));

  await controller.methods.streamSendInput({ streamId, text: 'hi gemini', mode: 'paste' });
  const last = writes[writes.length - 1];
  assert.equal(
    last.data.includes('\x1b[200~'),
    false,
    'bracketed-paste markers must not appear when the profile disables bracketed paste'
  );
  assert.equal(last.data, 'hi gemini');
  controller.shutdown();
});

test('claude variant spawn keeps claude profile so prompt is delivered and submitted', async () => {
  const { store, ee, writes } = makeMockStore();
  store.resolveStreamOwner = () => null;
  const controller = createAceController({ aceStore: store });
  const streamId = 'variant:claude-worker';

  try {
    const spawned = await controller.methods.streamSpawnIntoVariant({
      variantId: 'claude-worker',
      agent: 'claude',
    });
    assert.equal(spawned.streamId, streamId);

    ee.emit('pty:data', {
      id: streamId,
      chunk: [
        'Claude Code v2\r\n',
        '────────────────────────────────────────────────────────\r\n',
        '\u276f Try "create a util logging.py that..."\r\n',
        '────────────────────────────────────────────────────────\r\n',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n',
      ].join(''),
    });

    await controller.methods.streamWaitFor({
      streamId,
      predicate: { awaitingInput: true },
      timeoutMs: 500,
    });
    const submitResult = await controller.methods.streamSendSubmit({
      streamId,
      text: 'ship the mission card',
      mode: 'paste',
    });

    assert.ok(submitResult.telemetry.promptMs >= 150);
    assert.ok(writes.some((w) => w.streamId === streamId && w.data.includes('\x1b[200~ship the mission card\x1b[201~')));
    assert.ok(writes.some((w) => w.streamId === streamId && w.data === '\r'));
  } finally {
    controller.shutdown();
  }
});

test('controller tracks quiet PTY opens before first data', async () => {
  const { store, ee } = makeMockStore({
    catalog: [{ id: 'quiet', agent: 'hermes', title: 'Quiet Hermes' }],
  });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:quiet';

  ee.emit('pty:opened', { id: streamId, agent: 'hermes', cwd: '/tmp/quiet-hermes' });
  await new Promise((r) => setTimeout(r, 30));

  try {
    const ls = await controller.methods.streamList();
    const quiet = ls.streams.find((s) => s.streamId === streamId);
    assert.ok(quiet, 'quiet opened stream should be listed');
    assert.equal(quiet.live, true, 'quiet opened stream should be tracked as live before data');
    assert.equal(quiet.agent, 'hermes');
    assert.equal(quiet.cwd, '/tmp/quiet-hermes');

    const state = await controller.methods.streamGetState({ streamId });
    assert.ok(['booting', 'awaiting-input', 'turn-complete'].includes(state.state));
  } finally {
    controller.shutdown();
  }
});

test('quiet Hermes open stays booting until the real prompt appears', async () => {
  const { store, ee } = makeMockStore({
    catalog: [{ id: 'hermesquiet', agent: 'hermes', title: 'Hermes Quiet' }],
  });
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:hermesquiet';

  try {
    ee.emit('pty:opened', { id: streamId, agent: 'hermes', cwd: '/tmp/hermes-quiet' });
    await new Promise((r) => setTimeout(r, 30));
    let state = await controller.methods.streamGetState({ streamId });
    assert.equal(state.state, 'booting', 'Hermes must not be ready before its prompt paints');

    ee.emit('pty:data', { id: streamId, chunk: '\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 30));
    state = await controller.methods.streamGetState({ streamId });
    assert.equal(state.state, 'awaiting-input');
  } finally {
    controller.shutdown();
  }
});

test('wake reports start failure instead of waiting for first data forever', async () => {
  const { store } = makeMockStore({
    catalog: [{ id: 'broken', agent: 'claude', title: 'Broken' }],
  });
  store.ensureStreamStarted = async () => ({ ok: false, error: 'spawn failed' });
  const controller = createAceController({ aceStore: store });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      () => controller.methods.streamReadScreen({ streamId: 'conversation:broken' }),
      /failed to start stream.*spawn failed/
    );
    assert.ok(Date.now() - startedAt < 1000, 'start failure should be reported immediately');
  } finally {
    controller.shutdown();
  }
});

test('wake throws a clear error for an unknown streamId', async () => {
  const { store } = makeMockStore();
  // Override: unknown streams return no owner.
  store.resolveStreamOwner = () => null;
  const controller = createAceController({ aceStore: store });
  await assert.rejects(
    () => controller.methods.streamReadScreen({ streamId: 'conversation:nope' }),
    /unknown stream/
  );
  controller.shutdown();
});

test('profile hot-reload rebinds tabs to refreshed patterns', async () => {
  const fs = require('fs');
  const path = require('path');
  const profilePath = path.join(__dirname, '..', 'profiles', 'claude-code.json');
  const original = fs.readFileSync(profilePath, 'utf8');
  try {
    const { store, ee } = makeMockStore();
    const controller = createAceController({ aceStore: store });
    const streamId = 'conversation:hot-reload';
    ee.emit('pty:data', { id: streamId, chunk: '\u276f \r\n' });
    await new Promise((r) => setTimeout(r, 30));

    // Rewrite the claude-code profile with a bogus ready pattern that
    // won't match anything in this viewport. After reload, the tab's
    // state machine should re-evaluate and leave `awaiting-input`.
    const parsed = JSON.parse(original);
    parsed.ready = { pattern: 'ZZZ_NEVER_MATCHES_ZZZ' };
    fs.writeFileSync(profilePath, JSON.stringify(parsed, null, 2));

    const res = await controller.methods.streamReloadProfiles();
    assert.ok(res.count >= 1);
    assert.ok(res.rebound >= 1);

    // The reloaded profile object on the tab should carry the bogus
    // pattern. (State doesn't necessarily flip — with no outstanding
    // submit and no new bytes, the machine has nothing to re-decide on.)
    const profiles = await controller.methods.streamProfiles();
    const claudeProfile = profiles.profiles.find((p) => p.id === 'claude-code');
    assert.equal(claudeProfile.ready.pattern, 'ZZZ_NEVER_MATCHES_ZZZ');
    controller.shutdown();
  } finally {
    fs.writeFileSync(profilePath, original);
  }
});

test('events fire: tab-opened, state-change, tab-ready', async () => {
  const { store, ee } = makeMockStore();
  const controller = createAceController({ aceStore: store });
  const streamId = 'conversation:abc';

  const events = [];
  controller.bus.onAny((payload) => events.push(payload));

  ee.emit('pty:data', { id: streamId, chunk: 'Claude Code\r\n\u276f \r\n' });
  await new Promise((r) => setTimeout(r, 30));

  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes('tab-opened'), `expected tab-opened, got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('tab-ready'), `expected tab-ready, got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('state-change'), `expected state-change`);

  controller.shutdown();
});
