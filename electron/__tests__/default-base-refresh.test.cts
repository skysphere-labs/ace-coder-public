const test = require('node:test');
const assert = require('node:assert/strict');

const {
  refreshProjectDefaultBranchRow,
  DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD,
} = require('../local-core.cjs');

function makeGitMocks(script: any) {
  const calls: any[] = [];
  const queue = script.slice();

  async function run(cwd: any, ...args: any[]) {
    calls.push({ cwd, args });
    const next = queue.shift();
    if (!next) return { stdout: '', stderr: '' };
    if (next.throw) {
      const err = Object.assign(new Error(next.stderr || 'mock git error'), next.throw);
      err.stderr = next.stderr || '';
      err.stdout = next.stdout || '';
      throw err;
    }
    return {
      stdout: next.stdout || '',
      stderr: next.stderr || '',
      failed: !!next.failed,
    };
  }

  return {
    calls,
    gitImpl: run,
    tryGitImpl: run,
  };
}

test('refreshProjectDefaultBranchRow: refreshes to origin/<default> when behind threshold', async () => {
  const { calls, gitImpl, tryGitImpl } = makeGitMocks([
    { stdout: '' },
    { stdout: 'refs/remotes/origin/main\n' },
    { stdout: String(DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD + 1) + '\n' },
  ]);
  const persisted: any[] = [];
  const result = await refreshProjectDefaultBranchRow({
    projectRow: {
      id: 'prj-1',
      path: '/repo',
      is_remote: 0,
      default_branch: 'main',
    },
    gitImpl,
    tryGitImpl,
    persistDefaultBranch: (payload: any) => persisted.push(payload),
    now: '2026-04-20T12:00:00.000Z',
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.defaultBranch, 'origin/main');
  assert.equal(result.remoteDefaultBranch, 'main');
  assert.equal(result.behindBy, DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD + 1);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    projectRow: {
      id: 'prj-1',
      path: '/repo',
      is_remote: 0,
      default_branch: 'main',
    },
    defaultBranch: 'origin/main',
    now: '2026-04-20T12:00:00.000Z',
  });
  assert.deepEqual(
    calls.map((entry) => entry.args),
    [
      ['fetch', 'origin', '--quiet'],
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      ['rev-list', '--count', 'main..origin/main'],
    ]
  );
});

test('refreshProjectDefaultBranchRow: no-ops when behind count stays within threshold', async () => {
  const { calls, gitImpl, tryGitImpl } = makeGitMocks([
    { stdout: '' },
    { stdout: 'refs/remotes/origin/main\n' },
    { stdout: String(DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD) + '\n' },
  ]);
  let persisted = 0;
  const result = await refreshProjectDefaultBranchRow({
    projectRow: {
      id: 'prj-2',
      path: '/repo',
      is_remote: 0,
      default_branch: 'main',
    },
    gitImpl,
    tryGitImpl,
    persistDefaultBranch: () => {
      persisted += 1;
    },
  });

  assert.equal(result.refreshed, false);
  assert.equal(result.defaultBranch, 'main');
  assert.equal(result.remoteDefaultBranch, 'main');
  assert.equal(result.behindBy, DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD);
  assert.equal(persisted, 0);
  assert.equal(calls.length, 3);
});

test('refreshProjectDefaultBranchRow: threshold=0 force-refreshes on any stale base', async () => {
  const { gitImpl, tryGitImpl } = makeGitMocks([
    { stdout: '' },
    { stdout: 'refs/remotes/origin/main\n' },
    { stdout: '1\n' },
  ]);
  let persisted = 0;
  const result = await refreshProjectDefaultBranchRow({
    projectRow: {
      id: 'prj-3',
      path: '/repo',
      is_remote: 0,
      default_branch: 'main',
    },
    gitImpl,
    tryGitImpl,
    threshold: 0,
    persistDefaultBranch: () => {
      persisted += 1;
    },
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.defaultBranch, 'origin/main');
  assert.equal(result.behindBy, 1);
  assert.equal(persisted, 1);
});
