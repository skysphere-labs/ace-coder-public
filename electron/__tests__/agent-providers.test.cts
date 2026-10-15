const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyResumeArgs, getProvider, resolveSessionFile } = require('../agent-providers.cts');

test('Hermes concrete session resume uses exact --resume argument', () => {
  const hermes = getProvider('hermes');

  assert.deepEqual(
    applyResumeArgs(hermes, [], 'resume', null, '20260509_120000_abcd12'),
    ['--resume', '20260509_120000_abcd12']
  );
});

test('Hermes seen sentinel resume falls back to latest-only --continue', () => {
  const hermes = getProvider('hermes');

  assert.deepEqual(
    applyResumeArgs(hermes, [], 'resume', null, 'seen'),
    ['--continue']
  );
});

test('Hermes invalid stored session id falls back to latest-only --continue', () => {
  const hermes = getProvider('hermes');

  assert.deepEqual(
    applyResumeArgs(hermes, [], 'resume', null, 'not-a-hermes-session-id'),
    ['--continue']
  );
});

test('Codex concrete session resume uses exact session id', () => {
  const codex = getProvider('codex');
  const sessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';

  assert.deepEqual(
    applyResumeArgs(codex, [], 'resume', null, sessionId),
    ['resume', sessionId]
  );
});

test('Codex seen sentinel keeps latest-only fallback', () => {
  const codex = getProvider('codex');

  assert.deepEqual(
    applyResumeArgs(codex, [], 'resume', null, 'seen'),
    ['resume', '--last']
  );
});

test('Codex session locator verifies session id and cwd', (t: any) => {
  const oldHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-home-'));
  t.after(() => {
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;

  const sessionId = '019e5262-9cb2-7770-bcfa-397791c6c4f2';
  const cwd = path.join(home, 'workspace');
  const filePath = path.join(
    home,
    '.codex',
    'sessions',
    '2026',
    '05',
    '22',
    `rollout-2026-05-22T21-10-54-${sessionId}.jsonl`
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    }) + '\n',
    'utf8'
  );

  const codex = getProvider('codex');
  assert.equal(resolveSessionFile(codex, cwd, sessionId), filePath);
  assert.equal(resolveSessionFile(codex, path.join(home, 'other-workspace'), sessionId), null);
});

test('Hermes installs remain user-managed and never replace a checkout with a private fork', () => {
  const hermes = getProvider('hermes');
  assert.equal(hermes.installCommand, null);
  assert.equal(hermes.installCommandWindows, null);
  assert.match(hermes.installWarning.body, /compatible build/);
});
