// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
import { expect, test } from 'vitest';

const { readActiveLogin } = require('../github-core.cts');

const installed = { detectGhImpl: async () => ({ installed: true, version: '2.80.0' }) };

function gh(overrides) {
  return { stdout: '', stderr: '', code: 0, spawned: true, ...overrides };
}

const LOGGED_IN = [
  'github.com',
  '  ✓ Logged in to github.com account octodev (keyring)',
  '  - Active account: true',
  '  - Git operations protocol: https',
].join('\n');

test('readActiveLogin: a clean exit is authoritative and returns the active login', async () => {
  const result = await readActiveLogin({ ...installed, runGhImpl: async () => gh({ stdout: LOGGED_IN, code: 0 }) });
  expect(result).toEqual({ determined: true, login: 'octodev' });
});

test('readActiveLogin: a positively-confirmed logout clears identity (determined, login null)', async () => {
  const result = await readActiveLogin({
    ...installed,
    runGhImpl: async () => gh({ stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login', code: 1 }),
  });
  expect(result).toEqual({ determined: true, login: null });
});

test('readActiveLogin: a TRANSIENT nonzero exit is undetermined so the caller preserves last-known-good', async () => {
  // Network/keyring/config blip: nonzero exit, no parseable account, and NOT the
  // logged-out message. This must NOT read as a confirmed logout.
  const result = await readActiveLogin({
    ...installed,
    runGhImpl: async () => gh({ stderr: 'error connecting to api.github.com: dial tcp: lookup failed', code: 1 }),
  });
  expect(result).toEqual({ determined: false, login: null });
});

test('readActiveLogin: a nonzero exit that still lists the account is authoritative', async () => {
  const result = await readActiveLogin({
    ...installed,
    runGhImpl: async () => gh({ stdout: LOGGED_IN, stderr: 'warning: token scopes may be insufficient', code: 1 }),
  });
  expect(result).toEqual({ determined: true, login: 'octodev' });
});

test('readActiveLogin: a spawn failure is undetermined (never clears identity)', async () => {
  const result = await readActiveLogin({ ...installed, runGhImpl: async () => ({ spawned: false }) });
  expect(result).toEqual({ determined: false, login: null });
});
