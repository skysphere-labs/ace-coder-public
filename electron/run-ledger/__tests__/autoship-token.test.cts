// autoship-token tests — owner-auth token resolution precedence (env > ops-config
// > absent) + the ownerAuthorizedBypass tokenRef / literal / fail-closed paths.
// Runs under test:spine (electron/run-ledger/__tests__/*.test.cts, node --test).
//
// No real secrets: a throwaway token string in a temp HOME. HOME is redirected so
// os.homedir() resolves the fixture ops-config (libuv's uv_os_homedir honors $HOME).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tokenMod: any;
try {
  tokenMod = require('../../../tools/ace/src/autoship-token.cts');
} catch {
  tokenMod = require('../../../tools/ace/src/autoship-token.cjs');
}
const { resolveOwnerAuthToken, readAutoshipTokenFromConfig } = tokenMod;

let policyMod: any;
try {
  policyMod = require('../../../tools/ace/src/automerge-policy.cts');
} catch {
  policyMod = require('../../../tools/ace/src/automerge-policy.cjs');
}
const { ownerAuthorizedBypass } = policyMod;

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedEnvToken: string | undefined;
let savedAceHome: string | undefined;
let tmpHome = '';

beforeEach(() => {
  savedAceHome = process.env.ACE_HOME;
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedEnvToken = process.env.ACE_OWNER_AUTH_TOKEN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-autoship-home-'));
  process.env.ACE_HOME = path.join(tmpHome, '.ace-coder');
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.ACE_OWNER_AUTH_TOKEN;
});

afterEach(() => {
  if (savedAceHome === undefined) delete process.env.ACE_HOME;
  else process.env.ACE_HOME = savedAceHome;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedEnvToken === undefined) delete process.env.ACE_OWNER_AUTH_TOKEN;
  else process.env.ACE_OWNER_AUTH_TOKEN = savedEnvToken;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writeOpsConfig(dir: string, cfg: any): void {
  const aceDir = path.join(tmpHome, dir);
  fs.mkdirSync(aceDir, { recursive: true });
  fs.writeFileSync(path.join(aceDir, 'ops-config.json'), JSON.stringify(cfg));
}

test('absent env + absent config resolves to empty (fail-closed)', () => {
  assert.equal(resolveOwnerAuthToken(), '');
  assert.equal(readAutoshipTokenFromConfig(), '');
});

test('env ACE_OWNER_AUTH_TOKEN wins', () => {
  process.env.ACE_OWNER_AUTH_TOKEN = 'env-token-xyz';
  writeOpsConfig('.ace-coder', { autoship: { token: 'config-token-abc' } });
  assert.equal(resolveOwnerAuthToken(), 'env-token-xyz');
});

test('falls back to ops-config autoship.token when env is unset', () => {
  writeOpsConfig('.ace-coder', { autoship: { token: 'config-token-abc' } });
  assert.equal(resolveOwnerAuthToken(), 'config-token-abc');
});

test('private installation config is never inherited or copied', () => {
  writeOpsConfig('.ace', { autoship: { token: 'private-fixture-token' } });
  assert.equal(resolveOwnerAuthToken(), '');
  assert.equal(fs.existsSync(path.join(tmpHome, '.ace-coder', 'ops-config.json')), false);
});

test('only the explicitly selected public profile is read', () => {
  writeOpsConfig('.ace', { autoship: { token: 'private-fixture-token' } });
  writeOpsConfig('.ace-coder', { autoship: { token: 'public-fixture-token' } });
  assert.equal(resolveOwnerAuthToken(), 'public-fixture-token');
});

test('unparseable / missing autoship.token resolves empty (never throws)', () => {
  const aceDir = path.join(tmpHome, '.ace-coder');
  fs.mkdirSync(aceDir, { recursive: true });
  fs.writeFileSync(path.join(aceDir, 'ops-config.json'), '{ not json');
  assert.equal(resolveOwnerAuthToken(), '');
  writeOpsConfig('.ace-coder', { exampleService: { apiToken: 'x' } });
  assert.equal(resolveOwnerAuthToken(), '');
});

test('ownerAuthorizedBypass fail-closes when NO token is configured', () => {
  // Even a spec that names a tokenRef cannot authorize without a configured token.
  assert.equal(ownerAuthorizedBypass({ merge: { tokenRef: 'autoship' } }), false);
  assert.equal(ownerAuthorizedBypass({ ownerAuthToken: 'anything' }), false);
});

test('ownerAuthorizedBypass authorizes a resolvable tokenRef (loop-ship path)', () => {
  writeOpsConfig('.ace-coder', { autoship: { token: 'config-token-abc' } });
  assert.equal(ownerAuthorizedBypass({ merge: { ownerGated: true, tokenRef: 'autoship' } }), true);
  // A run WITHOUT a tokenRef and without a matching literal token still parks.
  assert.equal(ownerAuthorizedBypass({}), false);
  assert.equal(ownerAuthorizedBypass({ ownerAuthToken: 'wrong' }), false);
});

test('ownerAuthorizedBypass still honors the literal --owner-token match path', () => {
  process.env.ACE_OWNER_AUTH_TOKEN = 'secret-1';
  assert.equal(ownerAuthorizedBypass({ ownerAuthToken: 'secret-1' }), true);
  assert.equal(ownerAuthorizedBypass({ autoChain: { ownerAuthToken: 'secret-1' } }), true);
  assert.equal(ownerAuthorizedBypass({ ownerAuthToken: 'secret-2' }), false);
});
