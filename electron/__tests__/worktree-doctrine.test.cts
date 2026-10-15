const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { warnIfDoctrineFilesMissing } = require('../local-core.cjs');

function makeTmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-doctrine-test-'));
}

test('warnIfDoctrineFilesMissing: both files present logs nothing', async () => {
  const worktreePath = makeTmpWorktree();
  const warnings: any[] = [];
  try {
    fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), '# claude\n');
    fs.writeFileSync(path.join(worktreePath, 'AGENTS.md'), '# agents\n');

    const missing = await warnIfDoctrineFilesMissing({
      worktreePath,
      exists: async (fullPath: any) => fs.existsSync(fullPath),
      warn: (message: any) => warnings.push(message),
    });

    assert.deepEqual(missing, []);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('warnIfDoctrineFilesMissing: neither file present logs one warning', async () => {
  const worktreePath = makeTmpWorktree();
  const warnings: any[] = [];
  try {
    const missing = await warnIfDoctrineFilesMissing({
      worktreePath,
      exists: async (fullPath: any) => fs.existsSync(fullPath),
      warn: (message: any) => warnings.push(message),
    });

    assert.deepEqual(missing, ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /CLAUDE\.md/);
    assert.match(warnings[0], /AGENTS\.md/);
    assert.match(warnings[0], /docs\/auto-loaded-doctrine\.md/);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('warnIfDoctrineFilesMissing: one present logs the missing filename once', async () => {
  const worktreePath = makeTmpWorktree();
  const warnings: any[] = [];
  try {
    fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), '# claude\n');

    const missing = await warnIfDoctrineFilesMissing({
      worktreePath,
      exists: async (fullPath: any) => fs.existsSync(fullPath),
      warn: (message: any) => warnings.push(message),
    });

    assert.deepEqual(missing, ['AGENTS.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /AGENTS\.md/);
    assert.doesNotMatch(warnings[0], /missing CLAUDE\.md/);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});
