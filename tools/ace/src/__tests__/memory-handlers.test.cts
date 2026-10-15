const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryHandlers } = require('../memory-handlers.cts');

function makeHandlers() {
  const { handleMemoryRemember } = createMemoryHandlers({
    die: (payload) => {
      const err = new Error(payload.message || payload.error);
      err.payload = payload;
      throw err;
    },
    normalizeText: (value) => String(value == null ? '' : value).trim(),
    resolveProjectDirFlag: (flags) => flags.projectDir || process.cwd(),
  });
  return handleMemoryRemember;
}

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-handlers-'));
}

test('memory remember writes an untrusted dump record, never canon', async () => {
  const projectDir = tmpProjectDir();
  const handleMemoryRemember = makeHandlers();
  const result = await handleMemoryRemember({
    positionals: ['Scope vitest runs with --dir in this repo.'],
    flags: { category: 'lesson', projectId: 'prj_42', projectDir, tag: ['lesson'] },
  });

  assert.equal(result.schema, 'AceMemoryRememberResult/v1');
  assert.equal(result.quarantined, false);
  assert.ok(result.path.includes(path.join('.ace', 'wiki-dump')));
  assert.equal(result.record.kind, 'memory_note');
  assert.equal(result.record.category, 'lesson');
  assert.deepEqual(result.record.tags, ['lesson']);
  assert.equal(result.record.trust, 'self_report');

  // canon untouched
  assert.equal(fs.existsSync(path.join(projectDir, '.ace', 'wiki')), false);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('memory remember quarantines planted secrets via the curator gate', async () => {
  const projectDir = tmpProjectDir();
  const handleMemoryRemember = makeHandlers();
  const result = await handleMemoryRemember({
    positionals: ['Use this token: abcdef1234567890XYZ for the API'],
    flags: { category: 'fact', projectId: 'prj_42', projectDir },
  });
  assert.equal(result.redacted, true);
  assert.ok(!JSON.stringify(result.record).includes('abcdef1234567890XYZ'));
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('memory remember maps decision/todo categories onto curator fields', async () => {
  const projectDir = tmpProjectDir();
  const handleMemoryRemember = makeHandlers();
  const decision = await handleMemoryRemember({
    positionals: ['We standardize on FTS5 BM25 for knowledge search.'],
    flags: { category: 'decision', projectId: 'prj_42', projectDir },
  });
  assert.deepEqual(decision.record.decisions, ['We standardize on FTS5 BM25 for knowledge search.']);

  const todo = await handleMemoryRemember({
    positionals: ['Wire the Knowledge tab quarantine panel.'],
    flags: { category: 'todo', projectId: 'prj_42', projectDir },
  });
  assert.deepEqual(todo.record.proposedNextActions, ['Wire the Knowledge tab quarantine panel.']);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('memory remember validates inputs', async () => {
  const projectDir = tmpProjectDir();
  const handleMemoryRemember = makeHandlers();

  await assert.rejects(
    () => handleMemoryRemember({ positionals: [], flags: { category: 'lesson', projectId: 'p', projectDir } }),
    /claim text is required/,
  );
  await assert.rejects(
    () => handleMemoryRemember({ positionals: ['x'], flags: { category: 'opinion', projectId: 'p', projectDir } }),
    /--category must be one of/,
  );
  const prevProject = process.env.ACE_PROJECT_ID;
  const prevWorkspace = process.env.ACE_WORKSPACE_ID;
  delete process.env.ACE_PROJECT_ID;
  delete process.env.ACE_WORKSPACE_ID;
  await assert.rejects(
    () => handleMemoryRemember({ positionals: ['x'], flags: { category: 'fact', projectDir } }),
    /--project-id is required/,
  );
  if (prevProject !== undefined) process.env.ACE_PROJECT_ID = prevProject;
  if (prevWorkspace !== undefined) process.env.ACE_WORKSPACE_ID = prevWorkspace;
  await assert.rejects(
    () => handleMemoryRemember({ positionals: ['y'.repeat(2001)], flags: { category: 'fact', projectId: 'p', projectDir } }),
    /claim too long/,
  );
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('memory remember uses ACE_PROJECT_ID and ACE_AGENT_IDENTITY env defaults', async () => {
  const projectDir = tmpProjectDir();
  const handleMemoryRemember = makeHandlers();
  const prevProject = process.env.ACE_PROJECT_ID;
  const prevIdentity = process.env.ACE_AGENT_IDENTITY;
  process.env.ACE_PROJECT_ID = 'prj_env';
  process.env.ACE_AGENT_IDENTITY = 'worker-7';
  try {
    const result = await handleMemoryRemember({
      positionals: ['Env defaults work.'],
      flags: { category: 'fact', projectDir },
    });
    assert.equal(result.record.projectId, 'prj_env');
    assert.equal(result.record.identity, 'worker-7');
  } finally {
    if (prevProject !== undefined) process.env.ACE_PROJECT_ID = prevProject;
    else delete process.env.ACE_PROJECT_ID;
    if (prevIdentity !== undefined) process.env.ACE_AGENT_IDENTITY = prevIdentity;
    else delete process.env.ACE_AGENT_IDENTITY;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
