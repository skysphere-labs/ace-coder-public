import { test, expect } from 'vitest';

const { resolveRemoteBaseHygiene, DEFAULT_BASE_FETCH_TIMEOUT_MS } = require('../core/base-branch-policy.cts');

const REMOTE_SHA = 'a'.repeat(40);

// Fake git plumbing: `fetchBehavior` controls the fetch call; rev-parse of
// origin/main resolves to REMOTE_SHA when `cachedRefAvailable()` is true.
function makeGitFakes({ fetchBehavior, cachedRefAvailable = () => true }) {
  const calls = [];
  const gitImpl = async (_cwd, ...args) => {
    calls.push(args);
    if (args[0] === 'fetch') return fetchBehavior();
    throw new Error(`unexpected gitImpl call: ${args.join(' ')}`);
  };
  const tryGitImpl = async (_cwd, ...args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
      return cachedRefAvailable()
        ? { stdout: REMOTE_SHA, stderr: '' }
        : { stdout: '', stderr: 'unknown revision', failed: true };
    }
    // No local branch, no ahead/behind counts.
    return { stdout: '', stderr: 'not found', failed: true };
  };
  return { calls, gitImpl, tryGitImpl };
}

test('exports a bounded default fetch timeout', () => {
  expect(DEFAULT_BASE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  expect(DEFAULT_BASE_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
});

test('fast fetch keeps the normal path', async () => {
  const fakes = makeGitFakes({ fetchBehavior: async () => ({ stdout: '', stderr: '' }) });
  const hygiene = await resolveRemoteBaseHygiene({
    repoPath: '/repo',
    baseBranch: 'main',
    gitImpl: fakes.gitImpl,
    tryGitImpl: fakes.tryGitImpl,
  });
  expect(hygiene.remoteBaseSha).toBe(REMOTE_SHA);
  expect(fakes.calls.filter((c) => c[0] === 'fetch')).toHaveLength(1);
});

test('slow fetch falls back to the cached remote ref instead of blocking', async () => {
  // Fetch never settles within the test — task creation must not wait on it.
  const fakes = makeGitFakes({ fetchBehavior: () => new Promise(() => {}) });
  const started = Date.now();
  const hygiene = await resolveRemoteBaseHygiene({
    repoPath: '/repo',
    baseBranch: 'main',
    gitImpl: fakes.gitImpl,
    tryGitImpl: fakes.tryGitImpl,
    fetchTimeoutMs: 25,
  });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(hygiene.remoteBaseSha).toBe(REMOTE_SHA);
  expect(hygiene.branchPoint).toBe('origin/main');
});

test('failed fetch still resolves when a cached remote ref exists', async () => {
  const fakes = makeGitFakes({
    fetchBehavior: async () => {
      throw new Error('could not resolve host');
    },
  });
  const hygiene = await resolveRemoteBaseHygiene({
    repoPath: '/repo',
    baseBranch: 'main',
    gitImpl: fakes.gitImpl,
    tryGitImpl: fakes.tryGitImpl,
    fetchTimeoutMs: 25,
  });
  expect(hygiene.remoteBaseSha).toBe(REMOTE_SHA);
});

test('failed fetch with no cached remote ref rejects with the fetch error', async () => {
  const fakes = makeGitFakes({
    fetchBehavior: async () => {
      throw new Error('could not resolve host');
    },
    cachedRefAvailable: () => false,
  });
  await expect(
    resolveRemoteBaseHygiene({
      repoPath: '/repo',
      baseBranch: 'main',
      gitImpl: fakes.gitImpl,
      tryGitImpl: fakes.tryGitImpl,
      fetchTimeoutMs: 25,
    })
  ).rejects.toThrow('could not resolve host');
});

test('timed-out fetch with no cached remote ref waits for the fetch to land', async () => {
  let fetched = false;
  const fakes = makeGitFakes({
    fetchBehavior: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          fetched = true;
          resolve({ stdout: '', stderr: '' });
        }, 60);
      }),
    cachedRefAvailable: () => fetched,
  });
  const hygiene = await resolveRemoteBaseHygiene({
    repoPath: '/repo',
    baseBranch: 'main',
    gitImpl: fakes.gitImpl,
    tryGitImpl: fakes.tryGitImpl,
    fetchTimeoutMs: 10,
  });
  expect(fetched).toBe(true);
  expect(hygiene.remoteBaseSha).toBe(REMOTE_SHA);
});
