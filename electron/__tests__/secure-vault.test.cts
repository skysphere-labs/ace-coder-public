import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSecureVault,
  storageStatus,
  LOCAL_FILENAME,
  LOCAL_KEY_FILENAME,
  LOCAL_BACKEND,
} = require('../secure-vault.cts');

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-secure-vault-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeSafeStorage(backend = 'keychain') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`cipher:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('cipher:')) throw new Error('bad ciphertext');
      return text.slice('cipher:'.length);
    },
  };
}

// Backend selection is platform-derived, so the safeStorage-path tests pin a
// non-darwin platform explicitly — they must behave identically on macOS dev
// machines and Linux CI.
function safeStorageVault(safeStorage = fakeSafeStorage(), overrides = {}) {
  return createSecureVault({ userDataPath: tmp, safeStorage, platform: 'linux', ...overrides });
}

// A safeStorage whose every member throws: passed to darwin vaults to PROVE
// the local backend never touches safeStorage (on a real mac even the
// availability probe walks into the Keychain).
function poisonedSafeStorage() {
  const boom = () => {
    throw new Error('safeStorage must never be touched on darwin');
  };
  return {
    isEncryptionAvailable: boom,
    getSelectedStorageBackend: boom,
    encryptString: boom,
    decryptString: boom,
  };
}

test('external integration vault requires OS encryption even on macOS', () => {
  const storage = fakeSafeStorage('keychain');
  const encrypt = vi.spyOn(storage, 'encryptString');
  const vault = createSecureVault({ userDataPath: tmp, safeStorage: storage, platform: 'darwin', requireOsEncryption: true, filename: 'team-tickets-vault.json' });
  vault.setSecret('team-tickets:demo', 'synthetic-test-token');
  expect(encrypt).toHaveBeenCalledOnce();
  expect(vault.status()).toMatchObject({ available: true, backend: 'keychain' });
  expect(vault.getSecret('team-tickets:demo')).toBe('synthetic-test-token');
  expect(fs.existsSync(path.join(tmp, LOCAL_KEY_FILENAME))).toBe(false);
});

test('required OS encryption never falls back to a local key or plaintext', () => {
  for (const storage of [{ isEncryptionAvailable: () => false }, fakeSafeStorage('basic_text')]) {
    const vault = createSecureVault({ userDataPath: tmp, safeStorage: storage, platform: 'darwin', requireOsEncryption: true });
    expect(() => vault.setSecret('team-tickets:demo', 'synthetic-test-token')).toThrow();
    expect(fs.existsSync(vault.filePath)).toBe(false);
    expect(fs.existsSync(path.join(tmp, LOCAL_KEY_FILENAME))).toBe(false);
  }
});

test('encrypted vault round-trips without persisting plaintext and uses mode 0600', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  const secret = 'plane_api_1234567890abcdef1234567890abcdef';
  expect(vault.setSecret('skysphere-token:one', secret)).toEqual({ ok: true });
  expect(vault.hasSecret('skysphere-token:one')).toBe(true);
  expect(vault.getSecret('skysphere-token:one')).toBe(secret);

  const raw = fs.readFileSync(vault.filePath, 'utf8');
  expect(raw).not.toContain(secret);
  if (process.platform !== 'win32') expect(fs.statSync(vault.filePath).mode & 0o777).toBe(0o600);

  expect(vault.deleteSecret('skysphere-token:one')).toEqual({ ok: true, removed: true });
  expect(vault.getSecret('skysphere-token:one')).toBe(null);
});

test('repeated writes REPLACE the existing document (cross-platform atomic replace, not just the first write)', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  // The first setSecret creates the document; every write after that replaces an
  // EXISTING file — the path that fails on Windows if rename is used naively.
  expect(vault.setSecret('skysphere-token:one', 'plane_api_first')).toEqual({ ok: true });
  expect(vault.setSecret('skysphere-token:one', 'plane_api_second')).toEqual({ ok: true });
  expect(vault.setSecret('control-plane:refresh', 'ace_rt_third')).toEqual({ ok: true });
  expect(vault.getSecret('skysphere-token:one')).toBe('plane_api_second');
  expect(vault.getSecret('control-plane:refresh')).toBe('ace_rt_third');
});

test('recovers credentials from .bak when a write crashed after moving the old file aside', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  vault.setSecret('skysphere-token:one', 'plane_api_survivor');
  // Simulate the Windows atomicReplace crash window: the old file was moved to
  // .bak and the new file never landed → destination missing, .bak present.
  fs.renameSync(vault.filePath, `${vault.filePath}.bak`);
  expect(fs.existsSync(vault.filePath)).toBe(false);
  // A fresh handle must RECOVER the old credentials from .bak, not read the
  // missing destination as an empty vault (which would lose everything).
  const recovered = safeStorageVault(fakeSafeStorage());
  expect(recovered.getSecret('skysphere-token:one')).toBe('plane_api_survivor');
});

test('the direct-rename path retires a stale .bak so a deleted secret cannot be resurrected', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  vault.setSecret('skysphere-token:one', 'plane_api_current');
  // A leftover .bak from an earlier incomplete write. On POSIX every write takes
  // the direct rename(tmp,dest) fast path, which previously never cleared this.
  fs.writeFileSync(`${vault.filePath}.bak`, 'stale-should-never-resurrect');
  // A normal update goes through the fast path and MUST retire the stale .bak.
  vault.setSecret('skysphere-token:one', 'plane_api_updated');
  expect(fs.existsSync(`${vault.filePath}.bak`)).toBe(false);
  // Now the destination goes missing (e.g. a later delete/corruption). With the
  // stale .bak retired, recovery reads back empty — never the resurrected data.
  fs.rmSync(vault.filePath);
  const recovered = safeStorageVault(fakeSafeStorage());
  expect(recovered.getSecret('skysphere-token:one')).toBe(null);
});

test('a stale .bak does not wedge later writes on the Windows replace path', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  vault.setSecret('skysphere-token:one', 'plane_api_first');
  // A prior write whose final cleanup failed left a stale backup behind.
  fs.writeFileSync(`${vault.filePath}.bak`, 'stale-backup');

  // Simulate Windows: renaming ONTO an existing file throws EEXIST. Without the
  // leading stale-.bak clear, `rename(dest → dest.bak)` would hit the stale bak
  // and every future write would fail.
  const realRename = fs.renameSync.bind(fs);
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (fs.existsSync(to)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
    return realRename(from, to);
  });
  try {
    expect(vault.setSecret('skysphere-token:one', 'plane_api_second')).toEqual({ ok: true });
  } finally { spy.mockRestore(); }
  expect(vault.getSecret('skysphere-token:one')).toBe('plane_api_second');
});

test('safe storage fails closed when encryption is unavailable or Linux selected basic_text', () => {
  expect(storageStatus({ isEncryptionAvailable: () => false })).toMatchObject({ available: false });
  const vault = safeStorageVault(fakeSafeStorage('basic_text'));
  expect(vault.status()).toEqual({
    available: false,
    backend: 'basic_text',
    reason: 'plaintext-backend-refused',
  });
  expect(() => vault.setSecret('control-plane:refresh', 'ace_rt_value')).toThrow(/secure storage is unavailable/i);
  expect(fs.existsSync(vault.filePath)).toBe(false);
});

test('corrupt documents and ciphertext fail closed without deleting evidence', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  fs.writeFileSync(vault.filePath, '{bad json', { mode: 0o600 });
  expect(() => vault.getSecret('control-plane:refresh')).toThrow(/secure storage is corrupt/i);
  expect(fs.readFileSync(vault.filePath, 'utf8')).toBe('{bad json');

  fs.writeFileSync(vault.filePath, JSON.stringify({ version: 1, secrets: { 'control-plane:refresh': Buffer.from('not-cipher').toString('base64') } }));
  expect(() => vault.getSecret('control-plane:refresh')).toThrow(/could not be decrypted/i);
});

test('secret keys and values are bounded and control characters are rejected', () => {
  const vault = safeStorageVault(fakeSafeStorage());
  expect(() => vault.setSecret('../escape', 'value')).toThrow(/invalid.*key/i);
  expect(() => vault.setSecret('valid:key', 'line1\nline2')).toThrow(/invalid.*value/i);
  expect(() => vault.setSecret('valid:key', '')).toThrow(/invalid.*value/i);
});

// --- darwin local-file backend (keychain-free entry) ------------------------
//
// macOS must never touch safeStorage/Keychain: Ace's mac bundles are ad-hoc
// signed, so every update changes the cdhash and turns the Keychain ACL into
// a boot-time password prompt (or a SecItemCopyMatching hang). These tests
// pin the replacement backend: AES-256-GCM under a per-install 0600 key file,
// always available, zero safeStorage calls, and fail-closed on key loss or
// ciphertext tampering.

function darwinVault(safeStorage = poisonedSafeStorage()) {
  return createSecureVault({ userDataPath: tmp, safeStorage, platform: 'darwin' });
}

test('darwin uses the local-file backend and never touches safeStorage/Keychain', () => {
  const vault = darwinVault();
  expect(vault.status()).toEqual({ available: true, backend: LOCAL_BACKEND, reason: null });
  expect(vault.filePath).toBe(path.join(tmp, LOCAL_FILENAME));

  const secret = 'ace_rt_1234567890abcdef1234567890abcdef';
  expect(vault.setSecret('control-plane:refresh', secret)).toEqual({ ok: true });
  expect(vault.hasSecret('control-plane:refresh')).toBe(true);
  expect(vault.getSecret('control-plane:refresh')).toBe(secret);

  // Ciphertext at rest: neither the document nor the key file carries the
  // plaintext, and both are 0600.
  const doc = fs.readFileSync(vault.filePath, 'utf8');
  expect(doc).not.toContain(secret);
  if (process.platform !== 'win32') expect(fs.statSync(vault.filePath).mode & 0o777).toBe(0o600);
  const keyPath = path.join(tmp, LOCAL_KEY_FILENAME);
  expect(fs.readFileSync(keyPath, 'utf8')).not.toContain(secret);
  if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);

  // The session survives a relaunch: a FRESH handle (new process boot) reads
  // the same secret back with no prompt-able dependency — the auto-authorize
  // property this backend exists for.
  const relaunched = darwinVault();
  expect(relaunched.getSecret('control-plane:refresh')).toBe(secret);

  expect(vault.deleteSecret('control-plane:refresh')).toEqual({ ok: true, removed: true });
  expect(vault.getSecret('control-plane:refresh')).toBe(null);
});

test('a corrupt local key file fails closed even when a valid 64-hex prefix survives', () => {
  const vault = darwinVault();
  vault.setSecret('control-plane:refresh', 'ace_rt_prefix_target');
  const keyPath = path.join(tmp, LOCAL_KEY_FILENAME);
  // Buffer.from(raw, 'hex') silently truncates at the first invalid pair, so
  // trailing garbage after a valid 64-hex prefix must be treated as
  // corruption, not accepted — and the corrupt key must never be replaced.
  const original = fs.readFileSync(keyPath, 'utf8').trim();
  fs.writeFileSync(keyPath, `${original}ZZ-not-hex`, { mode: 0o600 });
  expect(() => vault.getSecret('control-plane:refresh')).toThrow(/could not be decrypted/i);
  expect(() => vault.setSecret('control-plane:refresh', 'ace_rt_next')).toThrow(/could not be encrypted/i);
  expect(fs.readFileSync(keyPath, 'utf8')).toBe(`${original}ZZ-not-hex`);
});

test('a lost local key fails reads closed and a re-minting write resets stale ciphertext instead of orphaning it', () => {
  const vault = darwinVault();
  vault.setSecret('control-plane:refresh', 'ace_rt_original_value');
  vault.setSecret('skysphere-token:one', 'plane_api_old_secret');
  const keyPath = path.join(tmp, LOCAL_KEY_FILENAME);
  fs.rmSync(keyPath);
  expect(() => vault.getSecret('control-plane:refresh')).toThrow(/could not be decrypted/i);
  // The failed read must not have minted a replacement key; only a WRITE creates one.
  expect(fs.existsSync(keyPath)).toBe(false);

  // A write after key loss mints a fresh key (no login lockout) but must NOT
  // leave the pre-loss ciphertext behind as undecryptable garbage under the
  // new key — that would mask the loss and mis-key on read. The document is
  // reset, so only the new entry survives and it is readable.
  vault.setSecret('control-plane:refresh', 'ace_rt_new_value');
  expect(fs.existsSync(keyPath)).toBe(true);
  expect(vault.getSecret('control-plane:refresh')).toBe('ace_rt_new_value');
  const doc = JSON.parse(fs.readFileSync(vault.filePath, 'utf8'));
  expect(Object.keys(doc.secrets)).toEqual(['control-plane:refresh']);
  expect(vault.hasSecret('skysphere-token:one')).toBe(false);
});

test('tampered local ciphertext fails closed (GCM auth)', () => {
  const vault = darwinVault();
  vault.setSecret('control-plane:refresh', 'ace_rt_tamper_target');
  const doc = JSON.parse(fs.readFileSync(vault.filePath, 'utf8'));
  const bytes = Buffer.from(doc.secrets['control-plane:refresh'], 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  doc.secrets['control-plane:refresh'] = bytes.toString('base64');
  fs.writeFileSync(vault.filePath, JSON.stringify(doc), { mode: 0o600 });
  expect(() => vault.getSecret('control-plane:refresh')).toThrow(/could not be decrypted/i);
});

test('the darwin vault leaves a legacy keychain-encrypted document untouched', () => {
  // A prior install's safeStorage-encrypted vault. The local backend cannot
  // (and must not try to) read it — reading it would require the Keychain.
  const legacyPath = path.join(tmp, 'ace-secure-vault.json');
  const legacy = JSON.stringify({
    version: 1,
    secrets: { 'control-plane:refresh': Buffer.from('keychain-ciphertext').toString('base64') },
  });
  fs.writeFileSync(legacyPath, legacy, { mode: 0o600 });

  const vault = darwinVault();
  expect(vault.hasSecret('control-plane:refresh')).toBe(false);
  vault.setSecret('control-plane:refresh', 'ace_rt_fresh_login');
  expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy);
  expect(vault.getSecret('control-plane:refresh')).toBe('ace_rt_fresh_login');
});

test('non-darwin platforms keep the safeStorage backend and filename', () => {
  const vault = createSecureVault({ userDataPath: tmp, safeStorage: fakeSafeStorage(), platform: 'win32' });
  expect(vault.status()).toEqual({ available: true, backend: 'keychain', reason: null });
  expect(vault.filePath).toBe(path.join(tmp, 'ace-secure-vault.json'));
  vault.setSecret('control-plane:refresh', 'ace_rt_windows_value');
  // Round-tripped through the injected safeStorage stub, proving DPAPI still
  // owns non-darwin encryption (the Windows login-loop fix depends on it).
  expect(vault.getSecret('control-plane:refresh')).toBe('ace_rt_windows_value');
});

test('public app retains Chromium OS-backed cookie encryption', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cts'), 'utf8');
  expect(main).not.toContain("appendSwitch('use-mock-keychain')");
});
