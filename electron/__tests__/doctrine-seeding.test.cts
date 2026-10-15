const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAceStore,
  ensureWorktreeDoctrineFiles,
} = require('../local-core.cjs');

function makeTmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-doctrine-test-'));
}

function writeFile(filePath: any, contents: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function writeExecutable(filePath: any, contents: any) {
  writeFile(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

test('ensureWorktreeDoctrineFiles: seeds coding-worker fallback files without clobbering existing doctrine', async () => {
  const worktreePath = makeTmpWorktree();
  const warnings: any[] = [];
  try {
    const claudePath = path.join(worktreePath, 'CLAUDE.md');
    const agentsPath = path.join(worktreePath, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# repo agents\npreserve me\n');

    const result = await ensureWorktreeDoctrineFiles({
      worktreePath,
      exists: async (fullPath: any) => fs.existsSync(fullPath),
      writeFile: async (fullPath: any, content: any) => fs.writeFileSync(fullPath, content, 'utf8'),
      seedMissing: true,
      warn: (message: any) => warnings.push(message),
    });

    const claude = fs.readFileSync(claudePath, 'utf8');
    const agents = fs.readFileSync(agentsPath, 'utf8');
    assert.deepEqual(result.missing, ['CLAUDE.md']);
    assert.deepEqual(result.seeded, ['CLAUDE.md']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(warnings, []);
    assert.match(claude, /coding-worker workspace/);
    assert.match(claude, /canonical coding-worker contract/);
    assert.doesNotMatch(claude, /Rook|King|Claude Orchestrator/);
    assert.equal(agents, '# repo agents\npreserve me\n');
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('ensureWorktreeDoctrineFiles: warns when fallback seeding fails but reports the failed file', async () => {
  const worktreePath = makeTmpWorktree();
  const warnings: any[] = [];
  try {
    const result = await ensureWorktreeDoctrineFiles({
      worktreePath,
      exists: async () => false,
      writeFile: async () => {
        throw new Error('disk full');
      },
      seedMissing: true,
      warn: (message: any) => warnings.push(message),
    });

    assert.deepEqual(result.missing, ['CLAUDE.md', 'AGENTS.md']);
    assert.deepEqual(result.seeded, []);
    assert.deepEqual(result.failed, ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to seed CLAUDE\.md, AGENTS\.md/);
    assert.match(warnings[0], /task-local instructions/);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('standing non-repo Codex lane workspace repairs missing coding-worker doctrine without clobbering existing files', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-lane-doctrine-'));
  const userDataPath = path.join(root, 'user-data');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;

  const spawned: any[] = [];
  const fakePty = {
    spawn(bin: any, args: any, opts: any) {
      const proc = {
        bin,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
      spawned.push(proc);
      return proc;
    },
  };
  const store = createAceStore(userDataPath, { ptyImpl: fakePty });
  t.after(() => {
    process.env.PATH = previousPath;
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const lane = await store.createAgentLane({ agent: 'codex', label: 'Codex Controller', autoStart: true });
  const project = store.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(lane.projectId);
  const claudePath = path.join(project.path, 'CLAUDE.md');
  const agentsPath = path.join(project.path, 'AGENTS.md');
  assert.match(fs.readFileSync(agentsPath, 'utf8'), /secure, surgical coding worker/);

  fs.writeFileSync(claudePath, '# repo claude\npreserve me\n', 'utf8');
  fs.rmSync(agentsPath, { force: true });

  const restarted = await store.startOrchestrator({ workspaceId: lane.projectId, agent: 'codex' });
  const repairedAgents = fs.readFileSync(agentsPath, 'utf8');
  assert.equal(restarted.reused, true);
  assert.match(repairedAgents, /secure, surgical coding worker/);
  assert.doesNotMatch(repairedAgents, /Rook|King|Claude Orchestrator/);
  assert.equal(fs.readFileSync(claudePath, 'utf8'), '# repo claude\npreserve me\n');
  assert.ok(spawned.length >= 1);
});
