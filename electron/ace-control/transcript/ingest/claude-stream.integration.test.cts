// @ts-nocheck — plain-JS node:test fixture (run via `node --import tsx --test`).
// node:test integration for protocol-native Claude (PRD Lane 2).
//
// Drives the REAL transcript controller `attachClaudeStream` path with a fake
// stream-json client, then replays the REAL captured spike events
// (.ace/scratch/cli-chat-spike/spike2-events.jsonl) through the client's
// onEvent. Asserts the controller folds them via normalizeClaudeEvent ->
// applyOp -> the transcript bus exactly like the codex tail.
//
// Run (worktree, no build):
//   node --import tsx --test electron/ace-control/transcript/ingest/claude-stream.integration.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { createTranscriptController } = require('../index.cts');
const { createClaudeStreamClient } = require('./claude.cts');

const SPIKE_JSONL = path.join(__dirname, '..', '__fixtures__', 'claude-stream-events.jsonl');

function makeMemStore() {
  const links = new Map();
  const entries = new Map();
  const keyToId = new Map();
  let nextId = 1;
  const arr = (sid) => {
    let a = entries.get(sid);
    if (!a) { a = []; entries.set(sid, a); }
    return a;
  };
  return {
    link: (sid, l) => links.set(sid, { streamId: sid, ...l }),
    getLink: (sid) => links.get(sid) || null,
    unlink: (sid) => links.delete(sid),
    appendEntry: (sid, entry) => {
      const e = { ...entry, id: nextId++ };
      arr(sid).push(e);
      return e;
    },
    upsertByKey: (sid, key, build) => {
      const k = `${sid} ${key}`;
      const a = arr(sid);
      if (keyToId.has(k)) {
        const id = keyToId.get(k);
        const idx = a.findIndex((e) => e.id === id);
        const e = { ...build(a[idx]), id };
        a[idx] = e;
        return { created: false, entry: e };
      }
      const e = { ...build(undefined), id: nextId++ };
      keyToId.set(k, e.id);
      a.push(e);
      return { created: true, entry: e };
    },
    clear: (sid) => {
      entries.set(sid, []);
      for (const kk of [...keyToId.keys()]) if (kk.startsWith(`${sid} `)) keyToId.delete(kk);
    },
    setByteOffset: () => {},
    setTurnState: () => {},
    readLatestEntries: (sid) => arr(sid),
    readEntries: () => [],
    readEntriesBefore: () => [],
    hasEntriesBefore: () => false,
    truncateAfter: () => {},
    unlinkSessionFileAliases: () => [],
    close: () => {},
  };
}

function setup() {
  const events = [];
  const bus = {
    emit: (event, payload) => events.push({ event, payload }),
    emitAny: () => {},
  };
  let captured = null;
  const calls = [];
  const fakeFactory = (opts) => {
    captured = opts;
    return {
      start: () => calls.push('start'),
      close: () => calls.push('close'),
      sendUserMessage: (t) => { calls.push(`send:${t}`); return true; },
      respondToApproval: (id, d) => { calls.push(`approve:${id}:${d.behavior}`); return true; },
      interrupt: () => { calls.push('interrupt'); return true; },
      setPermissionMode: (m) => { calls.push(`perm:${m}`); return true; },
    };
  };
  const controller = createTranscriptController({
    userDataPath: '/tmp/ace-test',
    bus,
    profiles: new Map(),
    store: makeMemStore(),
    createClaudeClient: fakeFactory,
  });
  return { controller, events, getCaptured: () => captured, calls };
}

function entriesFrom(events) {
  return events
    .filter((e) => e.event === 'transcript:append' || e.event === 'transcript:update')
    .map((e) => e.payload && e.payload.entry)
    .filter(Boolean);
}

function makeClaudeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdinWrites = [];
  child.stdin.write = (chunk) => {
    child.stdinWrites.push(String(chunk));
    return true;
  };
  child.killed = false;
  child.killSignal = null;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };
  return child;
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('attachClaudeStream starts the client, links the stream, announces availability', () => {
  const { controller, events, getCaptured, calls } = setup();
  controller.attachClaudeStream('s1', { cwd: '/tmp/ws', permissionMode: 'default' });
  assert.ok(getCaptured(), 'client factory was called');
  assert.ok(calls.includes('start'), 'client.start() called');
  assert.equal(controller.isClaudeStreamActive('s1'), true);
  const avail = events.find((e) => e.event === 'tab-chat-available');
  assert.ok(avail && avail.payload.agent === 'claude', 'emits tab-chat-available for claude');
});

test('folds real stream-json deltas into one agent message + a tool entry', () => {
  const { controller, events, getCaptured } = setup();
  controller.attachClaudeStream('s1', { cwd: '/tmp/ws' });
  const onEvent = getCaptured().onEvent;
  for (const line of fs.readFileSync(SPIKE_JSONL, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.dir === 'out') onEvent(rec.obj);
  }
  const entries = entriesFrom(events);
  const agent = entries.filter((e) => e.role === 'agent');
  assert.ok(
    agent.some((e) => typeof e.text === 'string' && e.text.includes('function add')),
    'token deltas accumulate into an agent message carrying the code block',
  );
  assert.ok(entries.some((e) => e.role === 'tool'), 'the Write tool_use surfaces a tool entry');
  assert.ok(agent.some((e) => e.lifecycle === 'finished'), 'an agent entry settles to finished');
});

test('surfaces a can_use_tool request as a pending approval entry (A5)', () => {
  const { controller, events, getCaptured } = setup();
  controller.attachClaudeStream('s1', {});
  getCaptured().onEvent({
    type: 'control_request',
    request_id: 'perm-req-1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } },
  });
  const approval = entriesFrom(events).find((e) => e.role === 'approval');
  assert.ok(approval, 'approval entry created');
  assert.equal(approval.status, 'pending');
});

test('routes user / approve / interrupt / set-permission-mode commands to the client', () => {
  const { controller, calls } = setup();
  controller.attachClaudeStream('s1', {});
  controller.claudeSendUserMessage('s1', 'hello');
  controller.claudeRespondToApproval('s1', 'perm-req-1', { behavior: 'deny', message: 'no' });
  controller.claudeInterrupt('s1');
  controller.claudeSetPermissionMode('s1', 'plan');
  assert.ok(calls.includes('send:hello'));
  assert.ok(calls.includes('approve:perm-req-1:deny'));
  assert.ok(calls.includes('interrupt'));
  assert.ok(calls.includes('perm:plan'));
});

test('detach closes the client and clears the active flag', () => {
  const { controller, calls } = setup();
  controller.attachClaudeStream('s1', {});
  controller.detachClaudeStream('s1');
  assert.ok(calls.includes('close'));
  assert.equal(controller.isClaudeStreamActive('s1'), false);
});

test('stream client fails closed before spawning when Claude is not on subscription auth', async () => {
  const warnings = [];
  const exits = [];
  let spawnCalls = 0;
  const client = createClaudeStreamClient({
    verifySubscriptionAuth: async () => ({
      ok: false,
      reason: 'non-subscription-auth',
      authMethod: 'console',
    }),
    spawnImpl: () => {
      spawnCalls += 1;
      return makeClaudeProcess();
    },
    onWarning: (warning) => warnings.push(warning),
    onExit: (info) => exits.push(info),
  });

  client.start();
  assert.equal(client.sendUserMessage('must not be sent'), true, 'writes queue behind auth verification');
  await nextImmediate();

  assert.equal(spawnCalls, 0);
  assert.equal(warnings.at(-1).code, 'claude:subscription-auth-required');
  assert.match(exits.at(-1).error, /subscription authentication required \(console\)/);
});

test('stream client stops on the exact API billing startup banner', async () => {
  const warnings = [];
  const exits = [];
  const child = makeClaudeProcess();
  const client = createClaudeStreamClient({
    verifySubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    spawnImpl: () => child,
    onWarning: (warning) => warnings.push(warning),
    onExit: (info) => exits.push(info),
  });

  client.start();
  client.sendUserMessage('queued until verified');
  await nextImmediate();
  assert.equal(child.stdinWrites.length, 2, 'init is written before the queued user message');

  child.stdout.write(' ▐▛███▜▌   Claude Code v2.1.206\r\n▝▜█████▛▘  Fable 5 · AP');
  child.stdout.write('I Usage Billing\r\n');

  assert.equal(child.killed, true);
  assert.equal(child.killSignal, 'SIGTERM');
  assert.equal(warnings.at(-1).code, 'claude:api-billing-blocked');
  assert.match(exits.at(-1).error, /Claude API Usage Billing blocked/);
});

test('stream client ignores explanatory API billing text', async () => {
  const warnings = [];
  const child = makeClaudeProcess();
  const client = createClaudeStreamClient({
    verifySubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    spawnImpl: () => child,
    onWarning: (warning) => warnings.push(warning),
  });

  client.start();
  await nextImmediate();
  child.stderr.write('log: API Usage Billing appears in documentation\n');
  child.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'The prompt says API Usage Billing.' }] },
  }) + '\n');

  assert.equal(child.killed, false);
  assert.equal(warnings.some((warning) => warning.code === 'claude:api-billing-blocked'), false);
  client.close();
});
