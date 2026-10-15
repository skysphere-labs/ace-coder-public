import { expect, test } from 'vitest';

const { decide } = require('../../scripts/safe-prune-worktrees.cts');

const HOUR = 60 * 60 * 1000;

function baseFacts(over = {}) {
  return {
    path: '/tmp/wt-x',
    branch: 'feature/x',
    registered: true,
    clean: true,
    noStash: true,
    mergedIntoBase: true,
    pr: { state: 'MERGED', number: 1, url: 'https://example/pr/1' },
    mtimeMs: Date.now() - 48 * HOUR,
    recentThresholdMs: 24 * HOUR,
    hasLock: false,
    isCwd: false,
    ghEnabled: true,
    activeCheckOk: true,
    activeStream: null,
    ...over,
  };
}

test('happy path: clean + merged + old + no PR conflicts → delete', () => {
  const d = decide(baseFacts());
  expect(d.action).toBe('delete');
});

test('dirty worktree is skipped with reason=dirty', () => {
  const d = decide(baseFacts({ clean: false }));
  expect(d).toEqual({ action: 'skip', reason: 'dirty' });
});

test('stash entries skip with reason=stash', () => {
  const d = decide(baseFacts({ noStash: false }));
  expect(d).toEqual({ action: 'skip', reason: 'stash' });
});

test('open PR is never deleted even when branch looks merged', () => {
  const d = decide(
    baseFacts({ pr: { state: 'OPEN', number: 42, url: 'u' }, mergedIntoBase: true }),
  );
  expect(d.action).toBe('skip');
  expect(d.reason).toBe('open-pr');
});

test('unmerged branch is skipped when PR state is not MERGED', () => {
  const d = decide(
    baseFacts({ mergedIntoBase: false, pr: { state: 'CLOSED', number: 1, url: 'u' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'unmerged' });
});

test('no PR + not merged into base → pr-unknown-no-merge-evidence (NEVER delete)', () => {
  const d = decide(
    baseFacts({ mergedIntoBase: false, pr: { state: 'NONE' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'pr-unknown-no-merge-evidence' });
});

test('--no-gh + no merge-base evidence → pr-unknown-no-merge-evidence', () => {
  const d = decide(
    baseFacts({ mergedIntoBase: false, ghEnabled: false, pr: { state: 'UNKNOWN' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'pr-unknown-no-merge-evidence' });
});

test('recent activity (mtime newer than threshold) → recent-activity', () => {
  const d = decide(
    baseFacts({ mtimeMs: Date.now() - 1 * HOUR, recentThresholdMs: 24 * HOUR }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'recent-activity' });
});

test('cwd inside worktree blocks deletion regardless of all other facts', () => {
  const d = decide(baseFacts({ isCwd: true, clean: true, mergedIntoBase: true }));
  expect(d).toMatchObject({ action: 'skip', reason: 'active-cwd' });
});

test('orphan with no branch is skipped (do not delete a detached/unknown ref)', () => {
  const d = decide(baseFacts({ branch: null }));
  expect(d).toMatchObject({ action: 'skip', reason: 'orphan-no-branch' });
});

test('not registered with git → skipped, not blindly rm-rfd', () => {
  const d = decide(baseFacts({ registered: false }));
  expect(d).toMatchObject({ action: 'skip', reason: 'not-registered' });
});

test('index.lock present → skipped (likely an in-flight git op)', () => {
  const d = decide(baseFacts({ hasLock: true }));
  expect(d).toMatchObject({ action: 'skip', reason: 'lock-file-present' });
});

test('PR merged is enough on its own when branch is missing local merge ancestry', () => {
  const d = decide(
    baseFacts({ mergedIntoBase: false, pr: { state: 'MERGED', number: 7, url: 'u' } }),
  );
  expect(d.action).toBe('delete');
});

// --- active-stream guard (PR #153 fixback) ---
//
// Ace streams in non-terminal states must block deletion regardless of
// how clean / merged / old the worktree looks. The guard also fails closed
// when the active-stream registry cannot be queried at all.

test('busy active stream blocks deletion even on clean+merged+old worktree', () => {
  const d = decide(
    baseFacts({
      activeStream: { live: true, state: 'busy', streamId: 'variant:var-abc', agent: 'claude' },
    }),
  );
  expect(d.action).toBe('skip');
  expect(d.reason).toBe('active-stream');
  expect(d.detail).toContain('busy');
});

test('booting stream → skip active-stream', () => {
  const d = decide(
    baseFacts({ activeStream: { live: true, state: 'booting', streamId: 'v', agent: 'codex' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('awaiting-input stream → skip active-stream', () => {
  const d = decide(
    baseFacts({ activeStream: { live: true, state: 'awaiting-input', streamId: 'v' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('awaiting-approval stream → skip active-stream', () => {
  const d = decide(
    baseFacts({ activeStream: { live: true, state: 'awaiting-approval', streamId: 'v' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('interrupted stream is treated non-terminal → skip active-stream', () => {
  const d = decide(
    baseFacts({ activeStream: { live: true, state: 'interrupted', streamId: 'v' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('error stream is treated non-terminal → skip active-stream', () => {
  const d = decide(baseFacts({ activeStream: { live: true, state: 'error', streamId: 'v' } }));
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('turn-complete with live=true is still non-terminal → skip', () => {
  const d = decide(
    baseFacts({ activeStream: { live: true, state: 'turn-complete', streamId: 'v' } }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-stream' });
});

test('dormant stream does NOT block deletion', () => {
  const d = decide(
    baseFacts({ activeStream: { live: false, state: 'dormant', streamId: 'v' } }),
  );
  expect(d.action).toBe('delete');
});

test('live=false on a busy state does NOT block (no PTY behind it)', () => {
  // Defensive shape — real ace won't emit busy+live:false but the
  // guard must key on `live`, not on the state name alone.
  const d = decide(baseFacts({ activeStream: { live: false, state: 'busy', streamId: 'v' } }));
  expect(d.action).toBe('delete');
});

test('activeCheckOk=false (registry query failed) → fail-closed skip', () => {
  const d = decide(baseFacts({ activeCheckOk: false, activeStream: null }));
  expect(d).toMatchObject({ action: 'skip', reason: 'active-check-unavailable' });
});

test('activeCheckOk=false fails closed even when --no-gh and PR merged', () => {
  // Operator opted out of gh AND the registry query failed: still skip.
  const d = decide(
    baseFacts({
      activeCheckOk: false,
      activeStream: null,
      ghEnabled: false,
      pr: { state: 'UNKNOWN' },
    }),
  );
  expect(d).toMatchObject({ action: 'skip', reason: 'active-check-unavailable' });
});

test('--no-active-check override: activeCheckOk=true + null stream → delete proceeds', () => {
  // When the operator passes --no-active-check the collector sets
  // activeCheckOk=true and activeStream=null on every facts row. The guard
  // must not block deletion in that branch — it has been explicitly waived.
  const d = decide(baseFacts({ activeCheckOk: true, activeStream: null }));
  expect(d.action).toBe('delete');
});

test('active-stream wins over open-PR ordering — both skips, but active first', () => {
  // Determinism check: the active-stream guard runs before the open-PR check.
  const d = decide(
    baseFacts({
      activeStream: { live: true, state: 'busy', streamId: 'v', agent: 'claude' },
      pr: { state: 'OPEN', number: 9, url: 'u' },
    }),
  );
  expect(d.reason).toBe('active-stream');
});
