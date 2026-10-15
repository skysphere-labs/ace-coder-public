import { test, expect } from 'vitest';

const { createGitWatcher, shouldUseFullTreeGitWatcher } = require('../git-watcher.cts');

function makeEvents() {
  const emitted = [];
  return { emit: (name, payload) => emitted.push({ name, payload }), emitted };
}

test('watcher policy lives in the module (extraction regression)', () => {
  expect(shouldUseFullTreeGitWatcher({ env: { ACE_DISABLE_GIT_WATCHER: '1' } })).toBe(false);
  expect(shouldUseFullTreeGitWatcher({ env: { ACE_ENABLE_FULL_TREE_GIT_WATCHER: '1' } })).toBe(true);
  expect(shouldUseFullTreeGitWatcher({ env: {} })).toBe(false);
});

test('attachTask with injected git ops produces NO unhandled rejections', async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(String(err && err.message));
  process.on('unhandledRejection', onRejection);
  try {
    const events = makeEvents();
    const watcher = createGitWatcher(events, () => '/tmp', {
      env: {},
      chokidarImpl: null,
      gitStatus: async () => ({ files: [] }),
      gitCurrentBranch: async () => 'main',
    });
    watcher.attachTask('task-1');
    await new Promise((r) => setTimeout(r, 50));
    watcher.detachTask?.('task-1');
    expect(rejections).toEqual([]);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('missing injected git ops fail loudly, not as a silent ReferenceError', async () => {
  const events = makeEvents();
  const watcher = createGitWatcher(events, () => '/tmp', { env: {}, chokidarImpl: null });
  expect(watcher).toBeTruthy();
  // The throwing defaults exist precisely so a forgotten injection surfaces
  // as a named error instead of `X is not defined` swallowed in async code.
  const src = require('node:fs').readFileSync(require.resolve('../git-watcher.cts'), 'utf8');
  expect(src).toContain('gitStatus dependency not injected');
  expect(src).not.toMatch(/^\s+gitStatus\(cwd\)/m);
});
