import { expect, test } from 'vitest';

const {
  isPatchBranch,
  compareSemver,
  desktopBundleStale,
  ensureOriginRemote,
  parseUpdateCheck,
  checkNativeHermesUpdate,
  runNativeHermesUpdate,
} = require('../hermes-update.cts');

// ── pure helpers ────────────────────────────────────────────────────────────

test('isPatchBranch recognizes the fork patch branch', () => {
  expect(isPatchBranch('ace/patches')).toBe(true);
  expect(isPatchBranch('ace/anything')).toBe(true);
  expect(isPatchBranch('main')).toBe(false);
  expect(isPatchBranch('')).toBe(false);
});

test('compareSemver + desktopBundleStale detect the desktop/agent version skew', () => {
  expect(compareSemver('0.16.0', '0.15.1')).toBe(1);
  expect(compareSemver('0.15.1', '0.16.0')).toBe(-1);
  expect(compareSemver('0.16.0', '0.16.0')).toBe(0);
  expect(desktopBundleStale('0.16.0', '0.15.1')).toBe(true);
  expect(desktopBundleStale('0.16.0', '0.16.0')).toBe(false);
});

test('parseUpdateCheck reads the CLI output into a behind-count', () => {
  expect(parseUpdateCheck('⚕ Update available: 5 commits behind origin/ace/patches.').behind).toBe(5);
  expect(parseUpdateCheck('⚕ Update available: 1 commit behind origin/ace/patches.').behind).toBe(1);
  expect(parseUpdateCheck('✓ Already up to date.').behind).toBe(0);
  expect(parseUpdateCheck("✗ Failed to fetch.\n  fatal: 'origin' does not appear...").behind).toBe(null);
  expect(parseUpdateCheck('').behind).toBe(null);
});

// ── scripted exec helpers ───────────────────────────────────────────────────

function makeExec(script = {}) {
  const calls = [];
  // script maps a matcher key → { code, stdout, stderr } or a function. Key is
  // the first one/two argv tokens (e.g. "git remote", "git remote get-url",
  // or the resolved hermes binary "hermes update").
  const exec = async (cmd, args = [], _opts = {}) => {
    calls.push({ cmd, args: [...args], opts: _opts });
    const key1 = cmd;
    const key2 = `${cmd} ${args[0] || ''}`.trim();
    const key3 = `${cmd} ${args[0] || ''} ${args[1] || ''}`.trim();
    const hit = script[key3] ?? script[key2] ?? script[key1];
    if (typeof hit === 'function') return hit({ cmd, args });
    return { code: 0, stdout: '', stderr: '', ...(hit || {}) };
  };
  return { exec, calls };
}

// ── ensureOriginRemote ──────────────────────────────────────────────────────

test('ensureOriginRemote is a no-op when origin already exists', async () => {
  const { exec, calls } = makeExec({
    'git remote get-url': ({ args }) =>
      args[2] === 'origin'
        ? { code: 0, stdout: 'https://github.com/example-user/hermes-agent.git\n' }
        : { code: 0, stdout: '' },
  });
  const res = await ensureOriginRemote({ exec, cwd: '/repo' });
  expect(res.ok).toBe(true);
  expect(res.created).toBe(false);
  expect(calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(false);
});

test('ensureOriginRemote mirrors the fork URL onto a missing origin', async () => {
  const FORK = 'https://github.com/example-user/hermes-agent.git';
  const { exec, calls } = makeExec({
    'git remote get-url': ({ args }) => {
      if (args[2] === 'origin') return { code: 1, stderr: "error: No such remote 'origin'" };
      if (args[2] === 'fork') return { code: 0, stdout: `${FORK}\n` };
      return { code: 1 };
    },
  });
  const res = await ensureOriginRemote({ exec, cwd: '/repo' });
  expect(res.ok).toBe(true);
  expect(res.created).toBe(true);
  expect(res.origin).toBe(FORK);
  const add = calls.find((c) => c.args[0] === 'remote' && c.args[1] === 'add');
  expect(add).toBeTruthy();
  expect(add.args).toEqual(['remote', 'add', 'origin', FORK]);
});

test('ensureOriginRemote fails clearly when there is no fork/upstream to mirror', async () => {
  const { exec } = makeExec({ 'git remote get-url': { code: 1, stderr: 'no remote' } });
  const res = await ensureOriginRemote({ exec, cwd: '/repo' });
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('no-source-remote');
});

// ── checkNativeHermesUpdate ─────────────────────────────────────────────────

test('checkNativeHermesUpdate reports an available update from the CLI', async () => {
  const { exec, calls } = makeExec({
    'git remote get-url': ({ args }) =>
      args[2] === 'origin' ? { code: 0, stdout: 'origin-url\n' } : { code: 0, stdout: '' },
    hermes: { code: 0, stdout: '⚕ Update available: 3 commits behind origin/ace/patches.\n' },
  });
  const res = await checkNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(true);
  expect(res.behind).toBe(3);
  const cli = calls.find((c) => c.cmd === 'hermes');
  expect(cli.args).toEqual(['update', '--check', '--branch', 'ace/patches']);
});

test('checkNativeHermesUpdate reports up-to-date as behind 0', async () => {
  const { exec } = makeExec({
    'git remote get-url': ({ args }) =>
      args[2] === 'origin' ? { code: 0, stdout: 'origin-url\n' } : { code: 0, stdout: '' },
    hermes: { code: 0, stdout: '✓ Already up to date.\n' },
  });
  const res = await checkNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(true);
  expect(res.behind).toBe(0);
});

test('checkNativeHermesUpdate surfaces a failed check as unknown (behind null)', async () => {
  const { exec } = makeExec({
    'git remote get-url': ({ args }) =>
      args[2] === 'origin' ? { code: 0, stdout: 'origin-url\n' } : { code: 0, stdout: '' },
    hermes: { code: 1, stdout: "✗ Failed to fetch.\n  fatal: could not read from remote\n" },
  });
  const res = await checkNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(false);
  expect(res.behind).toBe(null);
});

// ── runNativeHermesUpdate ───────────────────────────────────────────────────

test('runNativeHermesUpdate ensures origin then runs `hermes update --yes --branch`', async () => {
  const FORK = 'https://github.com/example-user/hermes-agent.git';
  const { exec, calls } = makeExec({
    'git remote get-url': ({ args }) => {
      if (args[2] === 'origin') return { code: 1, stderr: 'no origin' };
      if (args[2] === 'fork') return { code: 0, stdout: `${FORK}\n` };
      return { code: 1 };
    },
    hermes: { code: 0, stdout: '✓ Update complete!\n' },
  });
  const res = await runNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(true);
  // origin was linked first, then the CLI ran with the right argv.
  expect(calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(true);
  const cli = calls.find((c) => c.cmd === 'hermes');
  expect(cli.args).toEqual(['update', '--yes', '--branch', 'ace/patches']);
});

test('runNativeHermesUpdate surfaces a CLI failure with the output tail (checkout unchanged)', async () => {
  const { exec } = makeExec({
    'git remote get-url': ({ args }) =>
      args[2] === 'origin' ? { code: 0, stdout: 'origin-url\n' } : { code: 0, stdout: '' },
    hermes: { code: 1, stdout: 'pulling...\n', stderr: 'npm ERR! build blew up' },
  });
  const res = await runNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('update-failed');
  expect(res.message).toContain('npm ERR!');
});

test('runNativeHermesUpdate refuses to run the CLI when origin cannot be linked', async () => {
  const { exec, calls } = makeExec({ 'git remote get-url': { code: 1, stderr: 'no remote' } });
  const res = await runNativeHermesUpdate({ exec, cwd: '/repo', hermesBin: 'hermes' });
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('no-source-remote');
  expect(calls.some((c) => c.cmd === 'hermes')).toBe(false);
});
