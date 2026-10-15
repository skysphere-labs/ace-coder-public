// @vitest-environment happy-dom
//
// requestId contract test — the github-login split-residue regression guard.
//
// The unification PR completes the device-flow migration to a client-minted
// requestId. This proves the REAL renderer aceApi.github wrappers serialize
// login payloads in the exact shape the REAL main-side github-core state
// machine consumes — not mocked signatures on either side. Payloads captured
// from the aceApi wrappers are fed straight into a real github-core: start must
// register the device session under the CLIENT's requestId, and the poll/cancel
// payloads must address that same session. The negative control pins the
// failure the split created — a deviceCode-shaped payload must NOT find the
// session — so a re-leak of the security-core contract is caught here.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { createGithubCore } = require('../github-core.cts');

const REQ = 'ghreq_12345678-1234-4123-8123-123456789abc';
const deviceCode = `device_${'d'.repeat(32)}`;

const sent = [];
const invoke = vi.fn((method, payload) => {
  sent.push({ method, payload });
  return Promise.resolve({ ok: true });
});

beforeEach(() => {
  sent.length = 0;
  window.aceDesktop = { invoke };
});
afterEach(() => { vi.clearAllMocks(); });

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function deviceResponse() {
  return {
    device_code: deviceCode,
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  };
}

it('renderer github-login payloads match the main-side github-core requestId contract', async () => {
  const { aceApi } = await import('../../src/lib/ace-api');

  // 1. Renderer side: drive the REAL wrappers and record the IPC method + the
  //    serialized payload each one sends to the desktop bridge.
  await aceApi.github.loginStart(REQ);
  await aceApi.github.loginPoll(REQ);
  await aceApi.github.loginCancel(REQ);

  const byMethod = Object.fromEntries(sent.map((c) => [c.method, c.payload]));
  expect(byMethod).toHaveProperty('githubLoginStart', { requestId: REQ });
  expect(byMethod).toHaveProperty('githubLoginPoll', { requestId: REQ });
  expect(byMethod).toHaveProperty('githubLoginCancel', { requestId: REQ });

  // 2. Main side: feed those captured payloads into a real github-core.
  const core = createGithubCore({
    detectGhImpl: async () => ({ installed: true, version: '2.80.0' }),
    fetchImpl: async (url) =>
      url.includes('/login/device/code') ? json(deviceResponse()) : json({ error: 'authorization_pending' }),
  });

  try {
    // start: the captured {requestId} keys the session under the CLIENT's id —
    // github-core echoes that exact requestId back, it never mints its own here.
    const started = await core.loginStart(byMethod.githubLoginStart);
    expect(started).toMatchObject({ ok: true, requestId: REQ });

    // poll: the captured {requestId} addresses THAT live session (a poll
    // promise), not the unknown-session fall-through.
    const polling = core.loginPoll(byMethod.githubLoginPoll);
    expect(typeof polling.then).toBe('function');
    polling.catch(() => {});

    // Negative control: the retired deviceCode-shaped payload must NOT resolve
    // to the session — this is exactly the split-residue failure, pinned.
    expect(core.loginPoll({ deviceCode: REQ })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown/i),
    });

    // cancel: the captured {requestId} is accepted by the same contract.
    expect(core.loginCancel(byMethod.githubLoginCancel)).toEqual({ ok: true });
  } finally {
    core.loginCancel();
  }
});
