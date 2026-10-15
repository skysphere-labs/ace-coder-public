// Integration test for the Hermes snapshot update flow.
//
// Acceptance: a synthetic Hermes session_*.json gets rewritten with a fresh
// assistant turn (tool_calls) and a paired role=tool result; the live
// snapshot pipeline must create the matching role=tool transcript entries
// AFTER the initial load — without losing the entries that landed during
// boot.
//
// We exercise the real `gemini-json` tail (Hermes shares it via
// `transcript.kind: "json-rewrite"`) plus the real `normalizeHermesSnapshot`,
// then funnel the items through an in-memory upsert mirror of
// `transcript/store.cts`'s `upsertByKey` so we don't drag better-sqlite3 into
// node-test land. The mirror matches the controller's `applyOp(upsert)` path:
// first emission of a key creates an entry, subsequent emissions of the same
// key replace it in place.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createGeminiJsonTail } = require('../../transcript/tails/gemini-json.cts');
const { normalizeHermesSnapshot } = require('../../transcript/normalize/hermes.cts');

// Drive a snapshot through the same upsert/append shape applyOp uses.
function applySnapshot(prev, snapshot) {
  const items = normalizeHermesSnapshot(snapshot);
  const appended = [];
  const updated = [];
  for (const it of items) {
    const existing = prev.keyToId.get(it.keyPath);
    if (existing !== undefined) {
      const idx = prev.entries.findIndex((e) => e.id === existing);
      if (idx >= 0) {
        const next = { ...it.entry, id: existing };
        prev.entries[idx] = next;
        updated.push(next);
      }
    } else {
      const id = prev.nextId++;
      prev.keyToId.set(it.keyPath, id);
      const entry = { ...it.entry, id };
      prev.entries.push(entry);
      appended.push(entry);
    }
  }
  return { entries: prev.entries.slice(), appended, updated };
}

function newStore() {
  return { entries: [], keyToId: new Map(), nextId: 0 };
}

let dir;
let sessionFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cap-hermes-snap-'));
  sessionFile = join(dir, 'session_20260506_010101_abcdef.json');
});

afterEach(async () => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test('hermes snapshot update creates new tool entries after initial load', async () => {
  // Initial state: one user turn, one assistant turn with a single skill_view
  // tool_call, and the matching tool result. Mirrors a freshly-booted Hermes
  // session before any further activity.
  const initial = {
    session_id: '20260506_010101_abcdef',
    session_start: '2026-05-06T01:01:01Z',
    messages: [
      { role: 'user', content: 'Online?', timestamp: '2026-05-06T01:01:02Z' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_skill_init',
            type: 'function',
            function: { name: 'skill_view', arguments: '{"name":"ace-orchestrator-loop"}' },
          },
        ],
        timestamp: '2026-05-06T01:01:03Z',
      },
      {
        role: 'tool',
        tool_call_id: 'call_skill_init',
        content: 'skill content here',
        timestamp: '2026-05-06T01:01:04Z',
      },
    ],
  };
  await writeFile(sessionFile, JSON.stringify(initial));

  const snapshots = [];
  const tail = createGeminiJsonTail({
    filePath: sessionFile,
    onSnapshot: (snap) => snapshots.push(snap),
    onWarning: () => {},
    debounceMs: 20,
  });
  await tail.start();
  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(1), { timeout: 1000 });

  const store = newStore();
  const initialAck = applySnapshot(store, snapshots[snapshots.length - 1]);

  // Initial load must produce a tool entry for the skill_view call. The
  // running emission collapses with the finished one onto the same key, last
  // write wins.
  const initialTool = initialAck.entries.find(
    (e) => e.role === 'tool' && e.callId === 'call_skill_init'
  );
  expect(initialTool).toBeDefined();
  expect(initialTool.name).toBe('skill_view');
  expect(initialTool.status).toBe('ok');
  expect(initialTool.lifecycle).toBe('finished');
  expect(initialTool.result).toBe('skill content here');

  // Update: a fresh assistant turn with NEW tool_calls (terminal +
  // ace), reasoning, plus the matching tool results.
  const updated = {
    ...initial,
    last_updated: '2026-05-06T01:02:30Z',
    messages: [
      ...initial.messages,
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Inspect repo state.',
        tool_calls: [
          {
            id: 'call_terminal',
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"ls"}' },
          },
          {
            id: 'call_tui_ls',
            type: 'function',
            function: { name: 'ace_bin_ls', arguments: '{}' },
          },
        ],
        timestamp: '2026-05-06T01:02:00Z',
      },
      {
        role: 'tool',
        tool_call_id: 'call_terminal',
        content: 'README.md\nsrc',
        timestamp: '2026-05-06T01:02:10Z',
      },
      {
        role: 'tool',
        tool_call_id: 'call_tui_ls',
        content: 'Error: ace not on PATH',
        timestamp: '2026-05-06T01:02:20Z',
      },
      {
        role: 'assistant',
        content: 'Listed; ace missing.',
        timestamp: '2026-05-06T01:02:25Z',
      },
    ],
  };
  // Force a real mtime bump — same-millisecond rewrites are skipped by the
  // tail's stat-based dedupe.
  await new Promise((r) => setTimeout(r, 50));
  await writeFile(sessionFile, JSON.stringify(updated));

  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(2), { timeout: 1500 });
  const updatedAck = applySnapshot(store, snapshots[snapshots.length - 1]);

  // Original user entry stays unique and the original tool entry stays at
  // its original id (upsert in place).
  const userEntries = store.entries.filter((e) => e.role === 'user');
  expect(userEntries.length).toBe(1);
  const persistedInitTool = store.entries.find(
    (e) => e.role === 'tool' && e.callId === 'call_skill_init'
  );
  expect(persistedInitTool).toBeDefined();
  expect(persistedInitTool.id).toBe(initialTool.id);

  // New tool entries land. Final state must be `finished` even though the
  // running entry was emitted earlier in the same snapshot pass.
  const terminalTool = store.entries.find(
    (e) => e.role === 'tool' && e.callId === 'call_terminal'
  );
  expect(terminalTool).toBeDefined();
  expect(terminalTool.name).toBe('terminal');
  expect(terminalTool.status).toBe('ok');
  expect(terminalTool.lifecycle).toBe('finished');
  expect(terminalTool.result).toBe('README.md\nsrc');

  const streamTool = store.entries.find(
    (e) => e.role === 'tool' && e.callId === 'call_tui_ls'
  );
  expect(streamTool).toBeDefined();
  expect(streamTool.status).toBe('error');

  // Reasoning + agent text from the new assistant turns are present so the
  // renderer can show them alongside the tool widgets.
  const reasoningEntries = store.entries.filter((e) => e.role === 'reasoning');
  expect(reasoningEntries.length).toBe(1);
  expect(reasoningEntries[0].text).toBe('Inspect repo state.');
  const agentEntries = store.entries.filter((e) => e.role === 'agent');
  expect(agentEntries.map((e) => e.text)).toContain('Listed; ace missing.');

  // The updated pass must report new entries via `appended` — that's what
  // the controller broadcasts as `transcript:append`, which is how the chat
  // overlay learns about live tool activity after initial load.
  const appendedRoles = updatedAck.appended.map((e) => e.role).sort();
  expect(appendedRoles).toEqual(['agent', 'reasoning', 'tool', 'tool'].sort());

  tail.close();
});

test('hermes snapshot derives stable per-index timestamps when messages omit timestamp', () => {
  // Hermes's session JSON gets rewritten on every turn; older messages often
  // lack a `timestamp` field. The previous toMs() fallback stamped Date.now()
  // on each rewrite, so dedupe keys / reconciliation windows that lean on
  // tAt drifted forward each tick. Verify the normalizer now uses a stable
  // per-index offset anchored to session_start so the tAt for a given
  // message stays identical across rewrites.
  const snapshot = {
    session_id: 'stable-ts',
    session_start: '2026-05-06T05:00:00Z',
    messages: [
      { role: 'user', content: 'first turn' }, // no timestamp
      { role: 'assistant', content: 'first reply' }, // no timestamp
      { role: 'user', content: 'second turn', timestamp: '2026-05-06T05:01:00Z' },
    ],
  };
  const startedAt = Date.parse('2026-05-06T05:00:00Z');

  const a = normalizeHermesSnapshot(snapshot);
  const b = normalizeHermesSnapshot(snapshot);
  // Two passes over identical input must produce identical timestamps.
  expect(a.map((it) => it.entry.tAt)).toEqual(b.map((it) => it.entry.tAt));

  const userEntry = a.find((it) => it.keyPath === 'user:0');
  const agentEntry = a.find((it) => it.keyPath === 'agent:1');
  const userWithTs = a.find((it) => it.keyPath === 'user:2');
  expect(userEntry).toBeDefined();
  expect(userEntry.entry.tAt).toBe(startedAt + 1);
  expect(agentEntry.entry.tAt).toBe(startedAt + 2);
  expect(userWithTs.entry.tAt).toBe(Date.parse('2026-05-06T05:01:00Z'));

  // Sanity: the timestamps must not have drifted into "now" territory.
  expect(userEntry.entry.tAt).toBeLessThan(Date.now() - 1000);
});

test('hermes snapshot maps function and script calls to tool activity entries', () => {
  const store = newStore();
  applySnapshot(store, {
    session_id: 'function-script',
    session_start: '2026-05-06T04:00:00Z',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_script',
            call_id: 'call_script',
            response_item_id: 'resp_script',
            type: 'function',
            function: {
              name: 'execute_code',
              arguments: '{"language":"python","code":"print(123)"}',
            },
            timestamp: '2026-05-06T04:00:01Z',
          },
          {
            id: 'call_proc',
            call_id: 'call_proc',
            response_item_id: 'resp_proc',
            type: 'function',
            function: {
              name: 'process',
              arguments: '{"action":"poll","session_id":"proc_123"}',
            },
            timestamp: '2026-05-06T04:00:02Z',
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_script',
        content: '123',
        timestamp: '2026-05-06T04:00:03Z',
      },
      {
        role: 'tool',
        tool_call_id: 'call_proc',
        content: 'Error: process not found',
        timestamp: '2026-05-06T04:00:04Z',
      },
    ],
  });

  const script = store.entries.find((e) => e.role === 'tool' && e.callId === 'call_script');
  expect(script).toMatchObject({
    role: 'tool',
    name: 'execute_code',
    args: { language: 'python', code: 'print(123)' },
    result: '123',
    status: 'ok',
    lifecycle: 'finished',
  });

  const proc = store.entries.find((e) => e.role === 'tool' && e.callId === 'call_proc');
  expect(proc).toMatchObject({
    role: 'tool',
    name: 'process',
    args: { action: 'poll', session_id: 'proc_123' },
    result: 'Error: process not found',
    status: 'error',
    lifecycle: 'finished',
  });
});

test('hermes snapshot tail picks up rewrites via periodic poll when fs.watch is dead', async () => {
  // Live drift bug: macOS fs.watch on the session file can silently stop
  // firing after an atomic-rename style rewrite. Without periodic stat
  // resync, the chat overlay strands on the boot snapshot. Simulate the
  // dead-watcher condition by disabling fs.watch and verify the poll path
  // still surfaces a fresh write.
  const initial = {
    session_id: 'poll',
    session_start: '2026-05-06T03:00:00Z',
    messages: [{ role: 'user', content: 'hi', timestamp: '2026-05-06T03:00:01Z' }],
  };
  await writeFile(sessionFile, JSON.stringify(initial));

  const snapshots = [];
  const tail = createGeminiJsonTail({
    filePath: sessionFile,
    onSnapshot: (snap) => snapshots.push(snap),
    onWarning: () => {},
    debounceMs: 20,
    pollIntervalMs: 100,
    watch: false,
  });
  await tail.start();
  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(1), { timeout: 1000 });

  // Disable fs.watch so any subsequent file event is missed; only the
  // periodic poll can surface the next rewrite.

  await new Promise((r) => setTimeout(r, 50));
  const updated = {
    ...initial,
    last_updated: '2026-05-06T03:00:30Z',
    messages: [
      ...initial.messages,
      {
        role: 'assistant',
        content: 'pong',
        tool_calls: [
          { id: 'call_p', type: 'function', function: { name: 'terminal', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_p', content: 'ok' },
    ],
  };
  await writeFile(sessionFile, JSON.stringify(updated));

  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
  const latest = snapshots[snapshots.length - 1];
  expect(latest.messages.length).toBe(3);
  expect(latest.messages[1].tool_calls[0].id).toBe('call_p');

  tail.close();
});

test('hermes snapshot keeps tool result final state across redundant rewrites', async () => {
  // Hermes occasionally rewrites the file with no message change (e.g. a
  // last_updated heartbeat). The pipeline must NOT regress a finished tool
  // entry back to running just because the snapshot re-emits the running
  // entry first within the same pass.
  const base = {
    session_id: 'redundant',
    session_start: '2026-05-06T02:00:00Z',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_x', content: '/tmp' },
    ],
  };
  await writeFile(sessionFile, JSON.stringify(base));

  const snapshots = [];
  const tail = createGeminiJsonTail({
    filePath: sessionFile,
    onSnapshot: (snap) => snapshots.push(snap),
    onWarning: () => {},
    debounceMs: 20,
  });
  await tail.start();
  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(1), { timeout: 1000 });

  const store = newStore();
  applySnapshot(store, snapshots[snapshots.length - 1]);
  const before = store.entries.find((e) => e.callId === 'call_x');
  expect(before?.lifecycle).toBe('finished');

  await new Promise((r) => setTimeout(r, 50));
  await writeFile(sessionFile, JSON.stringify({ ...base, last_updated: '2026-05-06T02:00:30Z' }));
  await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(2), { timeout: 1500 });
  applySnapshot(store, snapshots[snapshots.length - 1]);
  const after = store.entries.find((e) => e.callId === 'call_x');
  expect(after?.lifecycle).toBe('finished');
  expect(after?.status).toBe('ok');
  expect(after?.id).toBe(before.id);

  tail.close();
});
