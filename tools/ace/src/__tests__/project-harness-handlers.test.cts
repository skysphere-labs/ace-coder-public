const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProjectHarnessHandlers } = require('../project-harness-handlers.cts');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-handlers-'));
  fs.mkdirSync(path.join(dir, '.ace', 'wiki'), { recursive: true });
  return dir;
}

function fakeDeps(projectDir: string, opts: any = {}) {
  return {
    fs,
    path,
    die: (err: any) => {
      const error: any = new Error(err.message || 'die');
      Object.assign(error, err);
      throw error;
    },
    normalizeText: (value: any) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()),
    repoRootFromCli: () => path.resolve(__dirname, '..', '..', '..', '..'),
    resolveProjectDirFlag: (_flags: any) => projectDir,
    aceDir: (dir: string) => path.join(dir, '.ace'),
    readJsonFile: (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    writeJsonFile: (filePath: string, value: any) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value));
    },
    validateCompletionResult: opts.validateCompletionResult || (() => ({ ok: true, errors: [] })),
  };
}

test('handleWikiUpdate writes a wiki page inside .ace/wiki', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  const result = await handlers.handleWikiUpdate({
    flags: { page: 'dashboards/current-state.md', text: 'hello ace' },
  });
  assert.ok(result.path.endsWith(path.join('.ace', 'wiki', 'dashboards', 'current-state.md')));
  assert.equal(result.appended, false);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'hello ace\n');
});

test('handleWikiUpdate rejects relative parents and absolute paths', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  await assert.rejects(
    () => handlers.handleWikiUpdate({ flags: { page: '../escape.md', text: 'x' } }),
    /--page must be a relative wiki path without/
  );
  await assert.rejects(
    () => handlers.handleWikiUpdate({ flags: { page: '/tmp/escape.md', text: 'x' } }),
    /--page must be a relative wiki path without/
  );
});

test('handleWikiUpdate --append appends without truncating prior content', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  await handlers.handleWikiUpdate({
    flags: { page: 'log.md', text: 'first line' },
  });
  const result = await handlers.handleWikiUpdate({
    flags: { page: 'log.md', text: 'second line', append: true },
  });
  assert.equal(result.appended, true);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'first line\nsecond line\n');
});

test('handleWikiUpdate operator-facing pages reject raw dormant stream inventory', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  let caught: any = null;
  try {
    await handlers.handleWikiUpdate({
      flags: {
        page: 'dashboards/current-state.md',
        text: '# current\n  dormant (3):\n    - conversation:d1 | state=dormant',
      },
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected wiki_contamination error');
  assert.equal(caught.code, 2);
  assert.equal(caught.error, 'wiki_contamination');
  assert.match(caught.message, /raw-dormant-stream/);
});

test('handleWikiUpdate operator-facing pages reject failed-probe leakage (401 / socket-not-found)', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  for (const text of [
    'fetch failed: 401 Unauthorized while reading remote',
    'socket not found at /tmp/ace.sock',
  ]) {
    let caught: any = null;
    try {
      await handlers.handleWikiUpdate({
        flags: { page: 'index.md', text },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `expected wiki_contamination error for: ${text}`);
    assert.equal(caught.error, 'wiki_contamination');
    assert.match(caught.message, /failed-probe-leak/);
  }
});

test('handleWikiUpdate diagnostic/ folder is the carve-out for raw inventory', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  const result = await handlers.handleWikiUpdate({
    flags: {
      page: 'diagnostic/raw-streams.md',
      text: 'dormant (2):\n    - conversation:d1 | state=dormant',
    },
  });
  assert.match(result.path, /diagnostic\/raw-streams\.md$/);
  const written = fs.readFileSync(result.path, 'utf8');
  assert.match(written, /dormant \(2\):/);
});

test('handleWikiUpdate --snapshot-failed writes the exact non-authoritative sentence', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  const result = await handlers.handleWikiUpdate({
    flags: {
      page: 'dashboards/current-state.md',
      'snapshot-failed': true,
      section: 'ace ls',
      command: 'ace --json ls',
      reason: 'socket not found',
      'next-live': 'ace doctor socket',
      timestamp: '2026-05-19T20:00:00.000Z',
    },
  });
  assert.equal(result.snapshotFailed, true);
  assert.equal(
    result.sentence,
    'Snapshot failed; do not infer current state from this section.'
  );
  const written = fs.readFileSync(result.path, 'utf8');
  assert.match(written, /Snapshot failed; do not infer current state from this section\./);
  assert.match(written, /source-command: ace --json ls/);
  assert.match(written, /failure-reason: socket not found/);
  assert.match(written, /next-live-command: ace doctor socket/);
  assert.match(written, /timestamp: 2026-05-19T20:00:00\.000Z/);
  assert.match(written, /status: non-authoritative/);
});

test('handleWikiUpdate --snapshot-failed --append appends without truncating prior content', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  const page = 'dashboards/current-state.md';
  await handlers.handleWikiUpdate({
    flags: { page, text: '# state\n\nLast known good content.\n' },
  });
  const result = await handlers.handleWikiUpdate({
    flags: {
      page,
      append: true,
      'snapshot-failed': true,
      section: 'gh checks',
      command: 'gh pr checks 128',
      reason: '401 unauthorized',
      'next-live': 'gh auth status',
    },
  });
  const written = fs.readFileSync(result.path, 'utf8');
  assert.match(written, /Last known good content\./);
  assert.match(written, /Snapshot failed; do not infer current state from this section\./);
});

test('handleEventEmit writes an NDJSON event under .ace', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  const result = await handlers.handleEventEmit({
    flags: { kind: 'note', payload: JSON.stringify({ kind: 'note' }) },
    positionals: ['ledger.checkpoint'],
  });
  const events = fs
    .readFileSync(path.join(projectDir, '.ace', 'events.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line: any) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ledger.checkpoint');
  assert.equal(events[0].schema, 'ace.harness_event.v1');
  assert.ok(result.event.eventId.startsWith('evt_'));
});

test('handleWikiUpdate denies canon writes for worker/validator roles', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  for (const role of ['implementer', 'reviewer', 'fixback', 'no-code']) {
    await assert.rejects(
      () => handlers.handleWikiUpdate({ flags: { page: 'lessons.md', text: 'x', role } }),
      /role_forbidden|forbidden for role/
    );
  }
  // env-carried role is honored too
  process.env.ACE_AGENT_ROLE = 'implementer';
  try {
    await assert.rejects(
      () => handlers.handleWikiUpdate({ flags: { page: 'lessons.md', text: 'x' } }),
      /forbidden for role/
    );
  } finally {
    delete process.env.ACE_AGENT_ROLE;
  }
});

test('handleWikiUpdate allows manager roles, owner terminals, and diagnostic pages for everyone', async () => {
  const projectDir = tempProject();
  const handlers = createProjectHarnessHandlers(fakeDeps(projectDir));
  // explicit manager roles
  for (const role of ['hermes', 'orchestrator', 'curator', 'chief']) {
    const result = await handlers.handleWikiUpdate({ flags: { page: `dashboards/${role}.md`, text: 'ok', role } });
    assert.ok(fs.existsSync(result.path));
  }
  // no role at all (owner terminal / manager tab)
  const bare = await handlers.handleWikiUpdate({ flags: { page: 'dashboards/bare.md', text: 'ok' } });
  assert.ok(fs.existsSync(bare.path));
  // diagnostic carve-out stays open even for workers
  const diag = await handlers.handleWikiUpdate({ flags: { page: 'diagnostic/raw.md', text: 'raw inventory', role: 'implementer' } });
  assert.ok(fs.existsSync(diag.path));
});
