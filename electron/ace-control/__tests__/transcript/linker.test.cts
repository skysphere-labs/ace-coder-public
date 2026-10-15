const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLinker, matchGlob, rootFromGlob, rootsFromGlob, sha256 } = require('../../transcript/linker.cjs');
const { normalizeHermesSnapshot } = require('../../transcript/normalize/hermes.cjs');

function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cap-link-'));
}

function entriesFromHermesSession(filePath) {
  const entries = [];
  const keyToIndex = new Map();
  for (const it of normalizeHermesSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')))) {
    const existing = keyToIndex.get(it.keyPath);
    if (existing !== undefined) entries[existing] = it.entry;
    else {
      keyToIndex.set(it.keyPath, entries.length);
      entries.push(it.entry);
    }
  }
  return entries;
}

test('matchGlob handles ~, **, and single-star segments', () => {
  const glob = '~/foo/*/bar-*.jsonl';
  const home = require('os').homedir();
  assert.equal(matchGlob(glob, path.join(home, 'foo', 'x', 'bar-1.jsonl')), true);
  assert.equal(matchGlob(glob, path.join(home, 'foo', 'x', 'y', 'bar-1.jsonl')), false);
});

test('rootFromGlob strips wildcard-bearing segments', () => {
  const root = rootFromGlob('~/.codex/sessions/*/*/*/rollout-*.jsonl');
  assert.ok(root.endsWith('.codex/sessions'));
});

test('rootsFromGlob bounds Hermes homes to concrete sessions dirs', async () => {
  const dir = await tmpDir();
  const homeA = path.join(dir, 'hermes-home-prj-a', 'sessions');
  const homeB = path.join(dir, 'hermes-home-prj-b', 'sessions');
  const chromiumNoise = path.join(dir, 'Local Storage', 'leveldb');
  await fsp.mkdir(homeA, { recursive: true });
  await fsp.mkdir(homeB, { recursive: true });
  await fsp.mkdir(chromiumNoise, { recursive: true });

  const roots = await rootsFromGlob(path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'));

  assert.deepEqual(roots.sort(), [homeA, homeB].sort());
  assert.equal(roots.includes(dir), false, 'must not scan/watch the whole userData root');
});

test('linker routes gemini files by projectHash across concurrent tabs', async () => {
  const dir = await tmpDir();
  const chatsDir = path.join(dir, 'gemini', 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  const profile = {
    detect: { agent: 'gemini' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(chatsDir, 'session-*.json'),
      matchByCwdField: null,
      projectHashField: 'projectHash',
    },
  };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked.push(p); },
  });
  // Two tabs, different cwds → different hashes.
  const cwdA = '/tmp/workspace-A-' + Date.now();
  const cwdB = '/tmp/workspace-B-' + Date.now();
  await linker.pending('sA', { agent: 'gemini', cwd: cwdA, spawnedAt: Date.now() });
  await linker.pending('sB', { agent: 'gemini', cwd: cwdB, spawnedAt: Date.now() });
  // Write file B FIRST — it should go to sB, not sA.
  const hashA = sha256(path.resolve(cwdA));
  const hashB = sha256(path.resolve(cwdB));
  const fileB = path.join(chatsDir, `session-B-${Date.now()}.json`);
  await fsp.writeFile(fileB, JSON.stringify({ sessionId: 'ss-B', projectHash: hashB, messages: [] }));
  await new Promise((r) => setTimeout(r, 150));
  await linker._registerAgent('gemini');
  const fileA = path.join(chatsDir, `session-A-${Date.now() + 1}.json`);
  await fsp.writeFile(fileA, JSON.stringify({ sessionId: 'ss-A', projectHash: hashA, messages: [] }));
  await new Promise((r) => setTimeout(r, 150));
  await linker._registerAgent('gemini');
  const linkA = linked.find((l) => l.streamId === 'sA');
  const linkB = linked.find((l) => l.streamId === 'sB');
  assert.ok(linkA, 'sA should have been linked');
  assert.ok(linkB, 'sB should have been linked');
  assert.equal(linkA.sessionFile, fileA, 'sA must link to file A (matching hash)');
  assert.equal(linkB.sessionFile, fileB, 'sB must link to file B (matching hash)');
  linker.shutdown();
});

test('linker honours per-profile linkWindowMs for slow-booting Hermes lanes', async () => {
  // Hermes/Rook lanes can take longer than the default 60s before their
  // first session_*.json appears (boot + skill load + watch-for-input).
  // The profile opts into a longer window via transcript.linkWindowMs.
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-x', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      linkWindowMs: 600_000,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  // Backdate spawnedAt by 2 minutes — past the default 60s expiry window.
  await linker.pending('hs-slow', { agent: 'hermes', cwd: null, spawnedAt: Date.now() - 120_000 });
  const sessionId = '20260505_165042_39061e';
  const filePath = path.join(sessionsDir, `session_${sessionId}.json`);
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      session_id: sessionId,
      session_start: new Date().toISOString(),
      messages: [{ role: 'user', content: 'hi' }],
    })
  );
  await new Promise((r) => setTimeout(r, 200));
  // Re-pending forces onAgentWatchTick. Keep the same backdated spawnedAt
  // so the window check is the thing under test.
  await linker.pending('hs-slow', { agent: 'hermes', cwd: null, spawnedAt: Date.now() - 120_000 });
  assert.ok(linked, 'expected onLink to fire despite >60s pending age');
  assert.equal(linked.streamId, 'hs-slow');
  assert.equal(linked.sessionId, sessionId);
  linker.shutdown();
});

test('linker still expires pending tabs at default 60s when no linkWindowMs override', async () => {
  // Regression guard for codex/gemini and any profile that doesn't opt
  // into a longer window: a 2-minute-old pending tab must be dropped on
  // the next watch tick.
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'codex', 'sessions', '2024', '01', '01');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'codex' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'codex', 'sessions', '*/*/*/rollout-*.jsonl'),
      matchByCwdField: 'payload.cwd',
    },
  };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked.push(p); },
  });
  await linker.pending('s-stale', {
    agent: 'codex',
    cwd: '/my/task/cwd',
    spawnedAt: Date.now() - 120_000,
  });
  // Write a matching file AFTER the window has passed; this should NOT link
  // because the pending tab gets dropped before it's evaluated.
  const filePath = path.join(sessionsDir, 'rollout-stale.jsonl');
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { id: 'sess-stale', cwd: '/my/task/cwd' },
    }) + '\n'
  );
  await new Promise((r) => setTimeout(r, 200));
  // Force the watch tick by re-pending another stream; this triggers
  // onAgentWatchTick which iterates the existing pending set and expires
  // s-stale before evaluating any match.
  await linker.pending('s-other', {
    agent: 'codex',
    cwd: '/different/cwd',
    spawnedAt: Date.now(),
  });
  assert.equal(
    linked.find((l) => l.streamId === 's-stale'),
    undefined,
    'stale pending tab must not link under default window'
  );
  linker.shutdown();
});

test('linker resumes existing Hermes session_*.json after restart when opted in', async () => {
  // After a renderer reload, Rook/King's session_*.json already exists on
  // disk with an mtime predating the new tab registration. The default
  // codex/gemini guard rejects pre-existing files; Hermes opts in via
  // `allowExistingSessionFiles: true` so the live session resumes instead
  // of disappearing forever.
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-x', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      allowExistingSessionFiles: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  // Write the file FIRST, then back-date its mtime so it's clearly older
  // than the about-to-be-registered tab.
  const sessionId = '20260505_165042_39061e';
  const filePath = path.join(sessionsDir, `session_${sessionId}.json`);
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      session_id: sessionId,
      session_start: new Date(Date.now() - 5 * 60_000).toISOString(),
      messages: [{ role: 'user', content: 'pre-existing turn' }],
    })
  );
  const oldMtime = (Date.now() - 5 * 60_000) / 1000;
  await fsp.utimes(filePath, oldMtime, oldMtime);
  // NOW register the tab — its spawnedAt is fresh, so the default mtime
  // guard would reject. The opt-in must override that.
  await linker.pending('hs-resume', { agent: 'hermes', cwd: null, spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  // Re-pending forces onAgentWatchTick deterministically.
  await linker.pending('hs-resume', { agent: 'hermes', cwd: null, spawnedAt: Date.now() });
  assert.ok(linked, 'expected onLink to fire for pre-existing hermes session');
  assert.equal(linked.streamId, 'hs-resume');
  assert.equal(linked.sessionId, sessionId);
  assert.equal(linked.sessionFile, filePath);
  linker.shutdown();
});

test('linker picks the active pre-existing Hermes session in the same workspace home', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-c9804012', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  const staleId = '20260419_103052_d751f2';
  const currentId = '20260505_190443_6e3d7f';
  const staleFile = path.join(sessionsDir, `session_${staleId}.json`);
  const currentFile = path.join(sessionsDir, `session_${currentId}.json`);
  await fsp.writeFile(
    currentFile,
    JSON.stringify({
      session_id: currentId,
      session_start: '2026-05-05T19:04:43Z',
      last_updated: '2026-05-05T19:04:43Z',
      messages: [{ role: 'user', content: 'current request' }],
    })
  );
  await fsp.writeFile(
    staleFile,
    JSON.stringify({
      session_id: staleId,
      session_start: '2026-04-19T10:30:52Z',
      last_updated: '2026-04-19T10:30:52Z',
      messages: [{ role: 'user', content: 'old text' }],
    })
  );
  const now = Date.now() / 1000;
  await fsp.utimes(staleFile, now - 120, now - 120);
  await fsp.utimes(currentFile, now - 60, now - 60);
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-c9804012', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-c9804012', spawnedAt: Date.now() });
  assert.ok(linked, 'expected onLink to fire for pre-existing hermes sessions');
  assert.equal(linked.sessionId, currentId);
  assert.equal(linked.sessionFile, currentFile);
  linker.shutdown();
});

test('linker picks the active King Hermes session in its workspace home', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-2b81ec58', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  const staleId = '20260430_182515_249166';
  const currentId = '20260505_190443_fe26dd';
  const staleFile = path.join(sessionsDir, `session_${staleId}.json`);
  const currentFile = path.join(sessionsDir, `session_${currentId}.json`);
  await fsp.writeFile(
    currentFile,
    JSON.stringify({
      session_id: currentId,
      session_start: '2026-05-05T19:04:43Z',
      last_updated: '2026-05-05T19:04:43Z',
      messages: [{ role: 'user', content: 'You have the same problem too...' }],
    })
  );
  await fsp.writeFile(
    staleFile,
    JSON.stringify({
      session_id: staleId,
      session_start: '2026-04-30T18:25:15Z',
      last_updated: '2026-04-30T18:25:15Z',
      messages: [{ role: 'user', content: 'stale King text' }],
    })
  );
  const now = Date.now() / 1000;
  await fsp.utimes(staleFile, now - 120, now - 120);
  await fsp.utimes(currentFile, now - 60, now - 60);
  await linker.pending('king', { agent: 'hermes', workspaceId: 'prj-2b81ec58', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('king', { agent: 'hermes', workspaceId: 'prj-2b81ec58', spawnedAt: Date.now() });
  assert.ok(linked, 'expected onLink to fire for pre-existing king hermes sessions');
  assert.equal(linked.sessionId, currentId);
  assert.equal(linked.sessionFile, currentFile);
  linker.shutdown();
});

test('linker prefers Hermes activity recency over session id recency', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-resume', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  const resumedId = '20260419_103052_d751f2';
  const abandonedId = '20260505_190443_6e3d7f';
  const resumedFile = path.join(sessionsDir, `session_${resumedId}.json`);
  const abandonedFile = path.join(sessionsDir, `session_${abandonedId}.json`);
  await fsp.writeFile(
    resumedFile,
    JSON.stringify({
      session_id: resumedId,
      session_start: '2026-04-19T10:30:52Z',
      lastUpdated: '2026-05-06T12:00:00Z',
      messages: [{ role: 'user', content: 'resumed current session' }],
    })
  );
  await fsp.writeFile(
    abandonedFile,
    JSON.stringify({
      session_id: abandonedId,
      session_start: '2026-05-05T19:04:43Z',
      lastUpdated: '2026-05-05T19:04:43Z',
      messages: [{ role: 'user', content: 'abandoned newer session' }],
    })
  );
  const now = Date.now() / 1000;
  // Make mtime point at the abandoned file so this test specifically proves
  // the JSON-prefix lastUpdated metadata wins over file/session recency.
  await fsp.utimes(abandonedFile, now - 60, now - 60);
  await fsp.utimes(resumedFile, now - 120, now - 120);
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-resume', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-resume', spawnedAt: Date.now() });
  assert.ok(linked, 'expected onLink to fire for pre-existing hermes sessions');
  assert.equal(linked.sessionId, resumedId);
  assert.equal(linked.sessionFile, resumedFile);
  linker.shutdown();
});

test('linker uses Hermes file mtime when activity timestamp is missing', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-mtime', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  const resumedId = '20260419_103052_d751f2';
  const abandonedId = '20260505_190443_6e3d7f';
  const resumedFile = path.join(sessionsDir, `session_${resumedId}.json`);
  const abandonedFile = path.join(sessionsDir, `session_${abandonedId}.json`);
  await fsp.writeFile(
    resumedFile,
    JSON.stringify({
      session_id: resumedId,
      session_start: '2026-04-19T10:30:52Z',
      messages: [{ role: 'user', content: 'mtime current session' }],
    })
  );
  await fsp.writeFile(
    abandonedFile,
    JSON.stringify({
      session_id: abandonedId,
      session_start: '2026-05-05T19:04:43Z',
      messages: [{ role: 'user', content: 'mtime abandoned session' }],
    })
  );
  const now = Date.now() / 1000;
  await fsp.utimes(abandonedFile, now - 120, now - 120);
  await fsp.utimes(resumedFile, now - 60, now - 60);
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-mtime', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-mtime', spawnedAt: Date.now() });
  assert.ok(linked, 'expected onLink to fire for pre-existing hermes sessions');
  assert.equal(linked.sessionId, resumedId);
  assert.equal(linked.sessionFile, resumedFile);
  linker.shutdown();
});

test('linker relinks the current Hermes json-rewrite file for same-file catch-up', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-catchup', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const streamId = 'conversation:conv-catchup';
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  let currentFile = null;
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    isCurrentLink: (candidateStreamId, filePath) => candidateStreamId === streamId && currentFile === filePath,
    onLink: (p) => {
      linked.push(p);
      currentFile = p.sessionFile;
    },
  });
  const sessionId = '20260508_151041_ce1735';
  const sessionFile = path.join(sessionsDir, `session_${sessionId}.json`);
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({
      session_id: sessionId,
      session_start: '2026-05-08T15:10:41Z',
      last_updated: '2026-05-08T15:11:00Z',
      messages: [{ role: 'user', content: 'initial' }],
    })
  );

  await linker.pending(streamId, { agent: 'hermes', workspaceId: 'prj-catchup', spawnedAt: Date.now() });
  assert.equal(linked.length, 1, 'initial link should claim the session file');
  assert.equal(linked[0].sessionFile, sessionFile);

  await new Promise((r) => setTimeout(r, 50));
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({
      session_id: sessionId,
      session_start: '2026-05-08T15:10:41Z',
      last_updated: '2026-05-08T15:39:00Z',
      messages: [
        { role: 'user', content: 'initial' },
        { role: 'assistant', content: 'caught up' },
      ],
    })
  );
  await linker.pending(streamId, {
    agent: 'hermes',
    workspaceId: 'prj-catchup',
    spawnedAt: Date.now(),
    linked: true,
  });

  assert.equal(linked.length, 2, 'same-file relink should fire so the controller can resync');
  assert.equal(linked[1].streamId, streamId);
  assert.equal(linked[1].sessionId, sessionId);
  assert.equal(linked[1].sessionFile, sessionFile);
  linker.shutdown();
});

test('linker rotates resumed Hermes stream from stale link to newer session with tool activity', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-c9804012', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const streamId = 'conversation:conv-a613af35';
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      linkWindowMs: 100,
      allowExistingSessionFiles: true,
    },
  };
  let currentFile = null;
  let entries = [];
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    isCurrentLink: (candidateStreamId, filePath) => candidateStreamId === streamId && currentFile === filePath,
    onLink: (p) => {
      linked.push(p);
      currentFile = p.sessionFile;
      entries = entriesFromHermesSession(p.sessionFile);
    },
  });
  const staleId = '20260506_165156_9b6dd1';
  const currentId = '20260506_173053_a6cedc';
  const staleFile = path.join(sessionsDir, `session_${staleId}.json`);
  const currentSessionFile = path.join(sessionsDir, `session_${currentId}.json`);
  await fsp.writeFile(
    staleFile,
    JSON.stringify({
      session_id: staleId,
      session_start: '2026-05-06T16:51:56Z',
      last_updated: '2026-05-06T16:55:00Z',
      messages: [{ role: 'assistant', content: 'Old merge/status text.' }],
    })
  );
  await linker.pending(streamId, {
    agent: 'hermes',
    workspaceId: 'prj-c9804012',
    spawnedAt: Date.now(),
  });
  assert.equal(linked.length, 1, 'initial resumed stream should link the old persisted session');
  assert.equal(linked[0].sessionFile, staleFile);

  await new Promise((r) => setTimeout(r, 150));
  await fsp.writeFile(
    currentSessionFile,
    JSON.stringify({
      session_id: currentId,
      session_start: '2026-05-06T17:30:53Z',
      last_updated: '2026-05-06T17:41:00Z',
      messages: [
        { role: 'user', content: 'Plan the TRELLIS work.', timestamp: '2026-05-06T17:31:00Z' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'TRELLIS planning: inspect active mission graph.',
          tool_calls: [
            {
              id: 'call_terminal',
              type: 'function',
              function: { name: 'terminal', arguments: '{"command":"ace screen conversation:conv-a613af35"}' },
            },
            {
              id: 'call_script',
              type: 'function',
              function: { name: 'execute_code', arguments: '{"language":"python","code":"print(\\"trellis\\")"}' },
            },
          ],
          timestamp: '2026-05-06T17:40:00Z',
        },
        {
          role: 'tool',
          tool_call_id: 'call_terminal',
          content: 'TRELLIS planning rows',
          timestamp: '2026-05-06T17:40:10Z',
        },
        {
          role: 'tool',
          tool_call_id: 'call_script',
          content: 'trellis',
          timestamp: '2026-05-06T17:40:15Z',
        },
        {
          role: 'assistant',
          content: 'TRELLIS plan updated.',
          timestamp: '2026-05-06T17:41:00Z',
        },
      ],
    })
  );

  await linker.pending('conversation:tickle-other', {
    agent: 'hermes',
    workspaceId: 'prj-other',
    spawnedAt: Date.now(),
  });
  assert.equal(linked.length, 2, 'linked stream must stay pending and claim the newer session');
  assert.equal(linked[1].streamId, streamId);
  assert.equal(linked[1].sessionId, currentId);
  assert.equal(linked[1].sessionFile, currentSessionFile);
  assert.equal(currentFile, currentSessionFile);

  const reasoning = entries.find((e) => e.role === 'reasoning');
  assert.equal(reasoning?.text, 'TRELLIS planning: inspect active mission graph.');
  const terminal = entries.find((e) => e.role === 'tool' && e.callId === 'call_terminal');
  assert.equal(terminal?.name, 'terminal');
  assert.equal(terminal?.result, 'TRELLIS planning rows');
  const script = entries.find((e) => e.role === 'tool' && e.callId === 'call_script');
  assert.equal(script?.name, 'execute_code');
  assert.equal(script?.result, 'trellis');
  assert.ok(entries.some((e) => e.role === 'agent' && e.text === 'TRELLIS plan updated.'));
  linker.shutdown();
});

test('linker without allowExistingSessionFiles still rejects pre-existing files', async () => {
  // Regression guard: codex/gemini must keep cross-linking protection so
  // a fresh tab never claims a stale session file from a previous run.
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'codex', 'sessions', '2024', '01', '01');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'codex' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'codex', 'sessions', '*/*/*/rollout-*.jsonl'),
      matchByCwdField: 'payload.cwd',
    },
  };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked.push(p); },
  });
  const filePath = path.join(sessionsDir, 'rollout-pre-existing.jsonl');
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { id: 'sess-old', cwd: '/my/task/cwd' },
    }) + '\n'
  );
  // Back-date the mtime well before the tab is registered.
  const oldMtime = (Date.now() - 5 * 60_000) / 1000;
  await fsp.utimes(filePath, oldMtime, oldMtime);
  await linker.pending('s-fresh', {
    agent: 'codex',
    cwd: '/my/task/cwd',
    spawnedAt: Date.now(),
  });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('s-fresh', {
    agent: 'codex',
    cwd: '/my/task/cwd',
    spawnedAt: Date.now(),
  });
  assert.equal(linked.length, 0, 'codex must not link a pre-existing stale session');
  linker.shutdown();
});

test('linker routes Hermes streams to their own hermes-home-<workspaceId> file', async () => {
  // Two pending Hermes streams (different workspaces) and two
  // pre-existing session files in their respective HERMES_HOME dirs. The
  // matchByWorkspaceHome discriminator must route each to its own file
  // regardless of file order on disk.
  const dir = await tmpDir();
  const homeA = path.join(dir, 'hermes-home-prj-a', 'sessions');
  const homeB = path.join(dir, 'hermes-home-prj-b', 'sessions');
  await fsp.mkdir(homeA, { recursive: true });
  await fsp.mkdir(homeB, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked.push(p); },
  });
  // Write file B FIRST so a workspace-blind first-pending-first-served
  // implementation would mis-route it to stream A.
  const sessIdB = '20260505_165438_0253d4';
  const fileB = path.join(homeB, `session_${sessIdB}.json`);
  await fsp.writeFile(
    fileB,
    JSON.stringify({ session_id: sessIdB, messages: [{ role: 'user', content: 'b' }] })
  );
  const sessIdA = '20260505_165042_39061e';
  const fileA = path.join(homeA, `session_${sessIdA}.json`);
  await fsp.writeFile(
    fileA,
    JSON.stringify({ session_id: sessIdA, messages: [{ role: 'user', content: 'a' }] })
  );
  // Register both streams. Both are fresh (mtime <= spawnedAt is fine
  // because allowExistingSessionFiles is true).
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-a', spawnedAt: Date.now() });
  await linker.pending('king', { agent: 'hermes', workspaceId: 'prj-b', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  // Force a deterministic rescan after the writes.
  await linker.pending('rook', { agent: 'hermes', workspaceId: 'prj-a', spawnedAt: Date.now() });
  await linker.pending('king', { agent: 'hermes', workspaceId: 'prj-b', spawnedAt: Date.now() });
  const linkRook = linked.find((l) => l.streamId === 'rook');
  const linkKing = linked.find((l) => l.streamId === 'king');
  assert.ok(linkRook, 'rook must link');
  assert.ok(linkKing, 'king must link');
  assert.equal(linkRook.sessionFile, fileA, 'rook must link to prj-a file');
  assert.equal(linkKing.sessionFile, fileB, 'king must link to prj-b file');
  linker.shutdown();
});

test('linker refuses to link Hermes when workspaceId is missing or wrong', async () => {
  // matchByWorkspaceHome with no workspaceId on the tab: do nothing.
  // matchByWorkspaceHome with a wrong workspaceId: do nothing.
  const dir = await tmpDir();
  const homeA = path.join(dir, 'hermes-home-prj-a', 'sessions');
  await fsp.mkdir(homeA, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
      matchByWorkspaceHome: true,
      allowExistingSessionFiles: true,
    },
  };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked.push(p); },
  });
  const sessId = '20260505_170000_aaaaaa';
  const filePath = path.join(homeA, `session_${sessId}.json`);
  await fsp.writeFile(
    filePath,
    JSON.stringify({ session_id: sessId, messages: [{ role: 'user', content: 'x' }] })
  );
  // Stream with no workspaceId — must NOT cross-link to prj-a.
  await linker.pending('hs-blind', { agent: 'hermes', workspaceId: null, spawnedAt: Date.now() });
  // Stream with a different workspaceId — must NOT cross-link either.
  await linker.pending('hs-other', { agent: 'hermes', workspaceId: 'prj-z', spawnedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  await linker.pending('hs-blind', { agent: 'hermes', workspaceId: null, spawnedAt: Date.now() });
  await linker.pending('hs-other', { agent: 'hermes', workspaceId: 'prj-z', spawnedAt: Date.now() });
  assert.equal(linked.length, 0, 'no link should fire when workspaceId is missing or wrong');
  linker.shutdown();
});

test('linker links a Ace Hermes session_*.json and reads session_id', async () => {
  // Ace-launched Hermes writes one JSON file per session under
  // <HERMES_HOME>/sessions/session_<id>.json with top-level `session_id`
  // (snake_case) and a `messages: []` array. The linker's json-rewrite
  // path must accept session_id as well as sessionId.
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'hermes-home-prj-x', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'hermes' },
    transcript: {
      kind: 'json-rewrite',
      sessionGlob: path.join(dir, 'hermes-home*', 'sessions', 'session_*.json'),
      matchByCwdField: null,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  await linker.pending('hs1', { agent: 'hermes', cwd: null, spawnedAt: Date.now() });
  const sessionId = '20260505_165042_39061e';
  const filePath = path.join(sessionsDir, `session_${sessionId}.json`);
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      session_id: sessionId,
      model: 'gpt-5.5',
      platform: 'cli',
      session_start: new Date().toISOString(),
      message_count: 1,
      messages: [{ role: 'user', content: 'hi', timestamp: new Date().toISOString() }],
    })
  );
  await new Promise((r) => setTimeout(r, 300));
  // Deterministic retick: re-pending re-runs onAgentWatchTick (the dir
  // scan + per-stream match). Backdate spawnedAt so the freshly-written
  // file's mtime still satisfies `stat.mtimeMs >= tab.spawnedAt - 1000`.
  await linker.pending('hs1', { agent: 'hermes', cwd: null, spawnedAt: Date.now() - 1000 });
  assert.ok(linked, 'expected onLink to fire for hermes session_*.json');
  assert.equal(linked.streamId, 'hs1');
  assert.equal(linked.agent, 'hermes');
  assert.equal(linked.sessionFile, filePath);
  assert.equal(linked.sessionId, sessionId, 'sessionId must come from session_id field');
  linker.shutdown();
});

test('linker links a codex session within the 60s window', async () => {
  const dir = await tmpDir();
  const sessionsDir = path.join(dir, 'codex', 'sessions', '2024', '01', '01');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const profile = {
    detect: { agent: 'codex' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'codex', 'sessions', '*/*/*/rollout-*.jsonl'),
      matchByCwdField: 'payload.cwd',
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    onLink: (p) => { linked = p; },
  });
  await linker.pending('s1', { agent: 'codex', cwd: '/my/task/cwd', spawnedAt: Date.now() });
  // Write the session file AFTER pending.
  const filePath = path.join(sessionsDir, 'rollout-2024-01-01T00-00-00-abc.jsonl');
  const meta = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { id: 'sess-123', cwd: '/my/task/cwd' },
  }) + '\n';
  await fsp.writeFile(filePath, meta);
  // Allow the watcher tick to fire.
  await new Promise((r) => setTimeout(r, 300));
  // Deterministic retick: re-pending forces onAgentWatchTick to scan the
  // dir and re-evaluate every pending stream. _registerAgent would short-
  // circuit on existing state and skip the scan entirely.
  await linker.pending('s1', { agent: 'codex', cwd: '/my/task/cwd', spawnedAt: Date.now() - 1000 });
  assert.ok(linked, 'expected onLink to fire');
  assert.equal(linked.sessionId, 'sess-123');
  linker.shutdown();
});

test('matchBySessionId claims exactly the file named after the expected id', async () => {
  // Claude: Ace mints the session uuid at spawn and the CLI writes
  // ~/.claude/projects/<cwd>/<uuid>.jsonl. Two same-cwd tabs must each claim
  // their OWN file regardless of write order.
  const dir = await tmpDir();
  const projDir = path.join(dir, 'projects', '-tmp-ws');
  await fsp.mkdir(projDir, { recursive: true });
  const profile = {
    detect: { agent: 'claude' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'projects', '*', '*.jsonl'),
      sessionIdFrom: 'filename',
      matchBySessionId: true,
      linkWindowMs: 600_000,
    },
  };
  const expected = { sA: 'uuid-aaaa', sB: 'uuid-bbbb' };
  const linked = [];
  const linker = createLinker({
    profiles: [profile],
    resolveExpectedSessionId: (streamId) => expected[streamId] || null,
    onLink: (p) => { linked.push(p); },
  });
  await linker.pending('sA', { agent: 'claude', cwd: '/tmp/ws', spawnedAt: Date.now() });
  await linker.pending('sB', { agent: 'claude', cwd: '/tmp/ws', spawnedAt: Date.now() });
  // Write B's file FIRST — first-pending-first-served must NOT give it to sA.
  await fsp.writeFile(path.join(projDir, 'uuid-bbbb.jsonl'), '{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 150));
  await linker._registerAgent('claude');
  await fsp.writeFile(path.join(projDir, 'uuid-aaaa.jsonl'), '{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 150));
  await linker._registerAgent('claude');
  const linkA = linked.find((l) => l.streamId === 'sA');
  const linkB = linked.find((l) => l.streamId === 'sB');
  assert.ok(linkA, 'sA should link');
  assert.ok(linkB, 'sB should link');
  assert.equal(linkA.sessionId, 'uuid-aaaa');
  assert.equal(linkB.sessionId, 'uuid-bbbb');
  linker.shutdown();
});

test('matchBySessionId never claims a file when the expected id is unknown', async () => {
  const dir = await tmpDir();
  const projDir = path.join(dir, 'projects', '-tmp-ws');
  await fsp.mkdir(projDir, { recursive: true });
  const profile = {
    detect: { agent: 'claude' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'projects', '*', '*.jsonl'),
      sessionIdFrom: 'filename',
      matchBySessionId: true,
    },
  };
  let linked = null;
  const linker = createLinker({
    profiles: [profile],
    resolveExpectedSessionId: () => null,
    onLink: (p) => { linked = p; },
  });
  await linker.pending('sX', { agent: 'claude', cwd: '/tmp/ws', spawnedAt: Date.now() });
  await fsp.writeFile(path.join(projDir, 'uuid-cccc.jsonl'), '{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 150));
  await linker._registerAgent('claude');
  assert.equal(linked, null, 'must stay dark rather than cross-link');
  linker.shutdown();
});

test('confirmed Claude /resume links the selected session without relaxing normal exact-id matching', async () => {
  const dir = await tmpDir();
  const projectDir = path.join(dir, 'claude', 'projects', '-tmp-workspace');
  const otherProjectDir = path.join(dir, 'claude', 'projects', '-tmp-other');
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(otherProjectDir, { recursive: true });
  const currentSessionId = '11111111-1111-4111-8111-111111111111';
  const selectedSessionId = '22222222-2222-4222-8222-222222222222';
  const otherSessionId = '33333333-3333-4333-8333-333333333333';
  const concurrentSessionId = '44444444-4444-4444-8444-444444444444';
  const currentFile = path.join(projectDir, `${currentSessionId}.jsonl`);
  const selectedFile = path.join(projectDir, `${selectedSessionId}.jsonl`);
  const otherFile = path.join(otherProjectDir, `${otherSessionId}.jsonl`);
  const concurrentFile = path.join(projectDir, `${concurrentSessionId}.jsonl`);
  for (const filePath of [currentFile, selectedFile, otherFile, concurrentFile]) {
    await fsp.writeFile(filePath, '{"type":"summary"}\n');
    const old = (Date.now() - 60_000) / 1000;
    await fsp.utimes(filePath, old, old);
  }
  const profile = {
    detect: { agent: 'claude' },
    transcript: {
      kind: 'jsonl-append',
      sessionGlob: path.join(dir, 'claude', 'projects', '*', '*.jsonl'),
      sessionIdFrom: 'filename',
      matchBySessionId: true,
      linkWindowMs: 60_000,
    },
  };
  const linked = [];
  let liveSessionId = currentSessionId;
  const linker = createLinker({
    profiles: [profile],
    resolveExpectedSessionId: () => currentSessionId,
    resolveSelectedSessionId: () => liveSessionId,
    // Reproduce owner A with a missing link where /resume touches A before selected B.
    isCurrentLink: () => false,
    canSwitchSession: (_streamId, sessionId) => sessionId !== otherSessionId,
    onLink: (row) => linked.push(row),
  });

  const armedAt = Date.now();
  await linker.pending('conversation:claude-resume', {
    agent: 'claude',
    cwd: '/tmp/workspace',
    spawnedAt: armedAt,
    linked: true,
    allowSessionSwitch: true,
    sessionDir: projectDir,
    deferInitialMatch: true,
  });

  // Reject other projects and do not claim a selected file before picker Enter.
  await fsp.utimes(currentFile, Date.now() / 1000, Date.now() / 1000);
  await fsp.utimes(otherFile, Date.now() / 1000, Date.now() / 1000);
  assert.deepEqual(linked, []);

  await linker.confirmSessionSwitch('conversation:claude-resume');
  assert.deepEqual(linked, [], 'the old expected id must not consume the armed picker match');

  await fsp.utimes(concurrentFile, Date.now() / 1000, Date.now() / 1000);
  liveSessionId = selectedSessionId;
  await linker.confirmSessionSwitch('conversation:claude-resume');
  const deadline = Date.now() + 2000;
  while (linked.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(linked.length, 1);
  assert.equal(linked[0].streamId, 'conversation:claude-resume');
  assert.equal(linked[0].sessionId, selectedSessionId);
  assert.equal(linked[0].sessionFile, selectedFile);
  assert.equal(linked[0].sessionSwitch, true);
  linker.shutdown();
});
