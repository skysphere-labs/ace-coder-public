const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cleanupMod: any;
try {
  cleanupMod = require('../workspace-cleanup-loop.cts');
} catch {
  cleanupMod = require('../workspace-cleanup-loop.cjs');
}
let serviceMod: any;
try {
  serviceMod = require('../loops-service.cts');
} catch {
  serviceMod = require('../loops-service.cjs');
}

const {
  WORKSPACE_CLEANUP_LOOP_ID,
  runWorkspaceCleanupLoop,
  readWorkspaceCleanupLineage,
} = cleanupMod;
const { createLoopsService } = serviceMod;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-cleanup-'));
}

function fakeHarness() {
  return {
    submit() {
      throw new Error('system cleanup loop must not submit run-ledger work');
    },
    kernel: { reconcile: () => ({ state: null }) },
    ledger: { readAll: () => [] },
  };
}

function memFs() {
  const files = new Map<string, string>();
  return {
    readFile: (p: string) => (files.has(p) ? files.get(p)! : null),
    writeFile: (p: string, c: string) => {
      files.set(p, c);
    },
  };
}

function shellFor(repoRoot: string, calls: any[]) {
  return (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    const joined = [cmd, ...args].join(' ');
    if (joined === 'git rev-parse --show-toplevel') return { code: 0, stdout: `${repoRoot}\n`, stderr: '' };
    if (joined === 'git remote get-url origin') return { code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
    if (joined === 'git status --porcelain=v1 -z') return { code: 0, stdout: ' M src/a.ts\0?? scratch.txt\0', stderr: '' };
    if (joined === 'git diff --binary') return { code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n', stderr: '' };
    if (joined === 'du -sk -- scratch.txt') return { code: 0, stdout: '4\tscratch.txt\n', stderr: '' };
    if (joined === 'git worktree list --porcelain') {
      return {
        code: 0,
        stdout: [
          `worktree ${repoRoot}`,
          'HEAD abc',
          'branch refs/heads/main',
          '',
          `worktree ${path.join(repoRoot, 'missing-worktree')}`,
          'HEAD def',
          'prunable gitdir file points to non-existent location',
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    if (joined === 'git worktree prune --verbose') return { code: 0, stdout: '', stderr: 'pruned missing-worktree\n' };
    if (joined.startsWith('gh pr list')) {
      return {
        code: 0,
        stdout: JSON.stringify([
          { number: 506, title: 'Open owner decision', state: 'OPEN', url: 'https://github.com/owner/repo/pull/506' },
          { number: 12, title: 'Merged cleanup', state: 'MERGED', mergedAt: '2026-06-22T00:00:00Z', url: 'https://github.com/owner/repo/pull/12' },
        ]),
        stderr: '',
      };
    }
    if (joined.startsWith('gh run list')) return { code: 0, stdout: JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success' }]), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${joined}` };
  };
}

test('workspace cleanup safe mode writes artifacts and prunes only missing worktree records', async () => {
  const userDataPath = tmpDir();
  const repoRoot = tmpDir();
  const calls: string[] = [];
  const result = await runWorkspaceCleanupLoop(
    { workspaceId: 'prj-test', mode: 'safe' },
    {
      userDataPath,
      now: () => '2026-06-22T04:13:33.000Z',
      listWorkspaces: () => [{ id: 'prj-test', name: 'Test Repo', path: repoRoot, githubRepo: 'owner/repo', tasks: [] }],
      listStreams: () => ({ streams: [{ streamId: 'conversation:1', workspaceId: 'prj-test', state: 'dormant', live: false }] }),
      runBoard: () => ({ cards: [{ id: 'card-1', workspaceId: 'prj-test', title: 'needs owner' }] }),
      shell: shellFor(repoRoot, calls),
    },
  );

  assert.equal(result.loopId, WORKSPACE_CLEANUP_LOOP_ID);
  assert.equal(result.latestRunOutcome, 'NEEDS_OWNER_DECISION');
  assert.ok(calls.includes('git worktree prune --verbose'));

  const artifactDir = result.artifactDir;
  assert.ok(fs.existsSync(path.join(artifactDir, 'streams.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'run-board.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'github.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'git-status.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'worktrees.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'classifications.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'action-plan.json')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'dirty-tracked.patch')));
  assert.ok(fs.existsSync(path.join(artifactDir, 'report.md')));

  const untracked = JSON.parse(fs.readFileSync(path.join(artifactDir, 'untracked-manifest.json'), 'utf8'));
  assert.deepEqual(untracked, [{ path: 'scratch.txt', sizeBytes: 4096, measured: true }]);

  const plan = JSON.parse(fs.readFileSync(path.join(artifactDir, 'action-plan.json'), 'utf8'));
  assert.equal(plan.safeActions[0].action, 'git worktree prune');
  assert.equal(plan.safeActions[0].status, 'done');
  assert.ok(plan.ownerDecisions.some((row: any) => row.number === 506));

  const lineage = readWorkspaceCleanupLineage({ userDataPath });
  assert.equal(lineage.loopId, WORKSPACE_CLEANUP_LOOP_ID);
  assert.equal(lineage.lastArtifactPath, artifactDir);
});

test('destructive cleanup requests are owner-gated without acknowledgement', async () => {
  const userDataPath = tmpDir();
  const repoRoot = tmpDir();
  const calls: string[] = [];
  const result = await runWorkspaceCleanupLoop(
    { workspaceId: 'prj-test', mode: 'destructive', resetDirtyRoot: true },
    {
      userDataPath,
      now: () => '2026-06-22T04:13:33.000Z',
      listWorkspaces: () => [{ id: 'prj-test', name: 'Test Repo', path: repoRoot, githubRepo: 'owner/repo', tasks: [] }],
      listStreams: () => ({ streams: [] }),
      runBoard: () => ({ cards: [] }),
      shell: shellFor(repoRoot, calls),
    },
  );

  assert.equal(result.latestRunOutcome, 'NEEDS_OWNER_DECISION');
  assert.ok(!calls.some((call) => call.includes('reset --hard')));
  assert.ok(!calls.some((call) => call.includes('clean -fd')));
  const plan = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'action-plan.json'), 'utf8'));
  assert.ok(plan.ownerDecisions.some((row: any) => row.type === 'owner-gate'));
});

test('loops service exposes and runs the built-in cleanup catalog entry', async () => {
  const userDataPath = tmpDir();
  const repoRoot = tmpDir();
  const calls: string[] = [];
  const svc = createLoopsService({
    harness: fakeHarness(),
    driveRun: () => {},
    fs: memFs(),
    catalogPath: '/loops/catalog.json',
    now: () => 1000,
    workspaceCleanup: {
      userDataPath,
      now: () => '2026-06-22T04:13:33.000Z',
      listWorkspaces: () => [{ id: 'prj-test', name: 'Test Repo', path: repoRoot, githubRepo: 'owner/repo', tasks: [] }],
      listStreams: () => ({ streams: [] }),
      runBoard: () => ({ cards: [] }),
      shell: shellFor(repoRoot, calls),
    },
  });

  assert.ok(svc.listLoops().some((loop: any) => loop.id === WORKSPACE_CLEANUP_LOOP_ID));
  assert.equal(svc.getLoop(WORKSPACE_CLEANUP_LOOP_ID).name, 'Workspace Cleanup Reconcile');
  const result = await svc.runLoop(WORKSPACE_CLEANUP_LOOP_ID, { workspaceId: 'prj-test', mode: 'dry-run' });
  assert.equal(result.loopId, WORKSPACE_CLEANUP_LOOP_ID);
  assert.ok(result.reportPath.endsWith('report.md'));
  const status = svc.loopStatus(WORKSPACE_CLEANUP_LOOP_ID);
  assert.equal(status.lineage.loopId, WORKSPACE_CLEANUP_LOOP_ID);
});
