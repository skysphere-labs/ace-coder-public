// Small encrypted secret vault for ACE-owned integration credentials.
//
// Ciphertext is stored in userData. On Windows and Linux encryption is
// delegated to Electron safeStorage (DPAPI, or a supported Linux secret
// store — Linux's `basic_text` backend is deliberately rejected).
//
// macOS is DIFFERENT by owner decision (2026-08-06): Ace's mac bundles are
// ad-hoc signed (build/mac-adhoc-sign.cjs), so every update changes the
// cdhash, invalidates the Keychain ACL behind safeStorage, and turns entry
// into a Keychain password prompt — or a hard hang inside a synchronous
// SecItemCopyMatching on the main thread. On darwin the vault therefore
// NEVER touches safeStorage/Keychain: secrets are AES-256-GCM encrypted with
// a per-install random key stored in a 0600 file beside the ciphertext.
// That is machine-local obfuscation plus file permissions, NOT OS-grade
// at-rest protection — accepted deliberately so entry needs no Keychain and
// the account session auto-restores. The blast radius is bounded upstream:
// the stored control-plane refresh token is single-use rotating with
// server-side reuse containment, and seat revocation is enforced by the
// control plane regardless of what this file holds.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VAULT_VERSION = 1;
const DEFAULT_FILENAME = 'ace-secure-vault.json';
// The darwin local-file backend uses its OWN document + key file. Legacy
// Keychain-encrypted documents stay untouched on disk (they cannot be read
// without the Keychain, which this backend exists to avoid).
const LOCAL_FILENAME = 'ace-local-vault.json';
const LOCAL_KEY_FILENAME = 'ace-local-vault.key';
const LOCAL_BACKEND = 'local-file';
const LOCAL_KEY_BYTES = 32;
const LOCAL_IV_BYTES = 12;
const LOCAL_TAG_BYTES = 16;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function vaultError(code: string, message: string) {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

function storageStatus(safeStorage: any) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    return { available: false, backend: null, reason: 'safe-storage-unavailable' };
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { available: false, backend: null, reason: 'encryption-unavailable' };
    }
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
      ? String(safeStorage.getSelectedStorageBackend() || '') || null
      : null;
    if (backend === 'basic_text') {
      return { available: false, backend, reason: 'plaintext-backend-refused' };
    }
    return { available: true, backend, reason: null };
  } catch {
    return { available: false, backend: null, reason: 'safe-storage-probe-failed' };
  }
}

function emptyDocument() {
  return { version: VAULT_VERSION, secrets: {} as Record<string, string> };
}

function readDocument(filePath: string) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      // Crash-window recovery: an atomicReplace that died on Windows after
      // moving the old file aside leaves the destination missing but its .bak
      // intact. Recover the old credentials from it rather than reading the
      // missing file as an empty vault (which would silently drop everything).
      try {
        raw = fs.readFileSync(`${filePath}.bak`, 'utf8');
      } catch (bakError: any) {
        if (bakError?.code === 'ENOENT') return emptyDocument();
        throw vaultError('VAULT_READ_FAILED', 'ACE secure storage could not be read');
      }
    } else {
      throw vaultError('VAULT_READ_FAILED', 'ACE secure storage could not be read');
    }
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== VAULT_VERSION || !parsed.secrets || typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets)) {
      throw new Error('invalid document');
    }
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.secrets)) {
      if (!KEY_RE.test(key) || typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error('invalid entry');
      }
      secrets[key] = value;
    }
    return { version: VAULT_VERSION, secrets };
  } catch {
    throw vaultError('VAULT_CORRUPT', 'ACE secure storage is corrupt; credentials were not read');
  }
}

// fs.rename is atomic on POSIX but rejects an existing destination on Windows
// (EPERM/EEXIST). There we can't overwrite in one call, so we keep the old file
// RECOVERABLE the whole time: move it aside to .bak, put the new file in place,
// then drop the backup. A crash at any step leaves either the intact old file
// or the .bak (readDocument recovers from it) — never a missing destination.
function atomicReplace(tmp: string, dest: string) {
  const bak = `${dest}.bak`;
  try {
    fs.renameSync(tmp, dest);
    // dest is now the current file, so ANY existing .bak is stale — retire it,
    // or a later missing/corrupt dest would resurrect old (deleted) secrets from
    // it. The direct rename never created a backup, so nothing to preserve.
    try { fs.rmSync(bak, { force: true }); } catch { /* cleared on the next write */ }
    return;
  } catch (err: any) {
    if (!err || (err.code !== 'EPERM' && err.code !== 'EEXIST' && err.code !== 'EACCES')) throw err;
  }
  // Clear any stale .bak first: a prior write whose final cleanup failed can
  // leave one behind, and on Windows `rename(dest → bak)` onto an existing file
  // throws EEXIST — permanently wedging every later write. The stale .bak is old
  // data and dest is the current file here, so removing it is safe.
  fs.rmSync(bak, { force: true });
  fs.renameSync(dest, bak);
  try {
    fs.renameSync(tmp, dest);
  } catch (err: any) {
    // New file didn't land — restore the old one so nothing is lost.
    try { fs.renameSync(bak, dest); } catch { /* .bak remains for read-side recovery */ }
    throw err;
  }
  // Best-effort: a leftover .bak is cleared by the next write's leading rm above.
  try { fs.rmSync(bak, { force: true }); } catch { /* cleared on the next write */ }
}

function writeDocument(filePath: string, document: any) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    atomicReplace(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    throw vaultError('VAULT_WRITE_FAILED', 'ACE secure storage could not be updated');
  }
}

function validKey(key: any) {
  return typeof key === 'string' && KEY_RE.test(key);
}

// The darwin cipher: AES-256-GCM under a lazily-created per-install key file.
// Value layout is base64(iv | tag | ciphertext), which satisfies the existing
// document entry regex. A missing key file fails decryption closed
// (SECRET_DECRYPT_FAILED) and reads never mint a key. The key is created only
// on write; a write that must mint while stale ciphertext remains resets the
// document (see setSecret) so a fresh key never silently orphans unreadable
// entries.
function createLocalKeyCipher(keyPath: string) {
  function readKey(create: boolean): Buffer | null {
    try {
      const raw = fs.readFileSync(keyPath, 'utf8').trim();
      // Strict whole-file validation: Buffer.from(raw, 'hex') silently stops
      // at the first invalid pair, so a 64-hex prefix with trailing garbage
      // would otherwise pass the length check. Any deviation is corruption.
      if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('bad key format');
      return Buffer.from(raw, 'hex');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw vaultError('VAULT_KEY_UNREADABLE', 'The ACE local vault key could not be read');
      }
    }
    if (!create) return null;
    const key = crypto.randomBytes(LOCAL_KEY_BYTES);
    // mode applies only when this call CREATES the directory. userData almost
    // always exists (and may be a shared external data root), so the vault
    // deliberately does not chmod it — protection is the 0600 files, matching
    // the pre-existing document path below.
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const tmp = `${keyPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      atomicReplace(tmp, keyPath);
      try { fs.chmodSync(keyPath, 0o600); } catch {}
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      throw vaultError('VAULT_KEY_WRITE_FAILED', 'The ACE local vault key could not be created');
    }
    return key;
  }
  return {
    status() {
      return { available: true, backend: LOCAL_BACKEND, reason: null };
    },
    // True only when the key file is ENOENT — a write would MINT a fresh key.
    // An existing-but-unreadable key is not "missing" (readKey throws instead).
    keyMissing(): boolean {
      try {
        fs.statSync(keyPath);
        return false;
      } catch (error: any) {
        return error?.code === 'ENOENT';
      }
    },
    encryptString(secret: string): Buffer {
      const key = readKey(true) as Buffer;
      const iv = crypto.randomBytes(LOCAL_IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(encrypted: Buffer): string {
      const key = readKey(false);
      if (key === null || encrypted.length <= LOCAL_IV_BYTES + LOCAL_TAG_BYTES) {
        throw new Error('undecryptable');
      }
      const iv = encrypted.subarray(0, LOCAL_IV_BYTES);
      const tag = encrypted.subarray(LOCAL_IV_BYTES, LOCAL_IV_BYTES + LOCAL_TAG_BYTES);
      const body = encrypted.subarray(LOCAL_IV_BYTES + LOCAL_TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function createSecureVault({ userDataPath, safeStorage, filename, platform = process.platform, requireOsEncryption = false }: any) {
  if (!userDataPath || typeof userDataPath !== 'string') {
    throw new Error('createSecureVault: userDataPath required');
  }
  // Keychain-free entry: darwin selects the local-file cipher unconditionally
  // and must never call INTO safeStorage — even isEncryptionAvailable() walks
  // into the Keychain to provision the encryption key.
  // New external-service credentials can require OS encryption on every
  // platform. They must never inherit the legacy macOS local-key fallback.
  const localBackend = platform === 'darwin' && !requireOsEncryption;
  const filePath = path.join(userDataPath, filename ?? (localBackend ? LOCAL_FILENAME : DEFAULT_FILENAME));
  const localCipher = localBackend
    ? createLocalKeyCipher(path.join(userDataPath, LOCAL_KEY_FILENAME))
    : null;

  function status() {
    if (localCipher) return localCipher.status();
    return storageStatus(safeStorage);
  }

  function requireAvailable() {
    const current = status();
    if (!current.available) {
      throw vaultError(
        'SECURE_STORAGE_UNAVAILABLE',
        `ACE secure storage is unavailable (${current.reason || 'unknown'})`
      );
    }
    return current;
  }

  function getSecret(key: any) {
    requireAvailable();
    if (!validKey(key)) throw vaultError('INVALID_SECRET_KEY', 'Invalid ACE secure-storage key');
    const document = readDocument(filePath);
    const encoded = document.secrets[key];
    if (!encoded) return null;
    try {
      const encrypted = Buffer.from(encoded, 'base64');
      if (encrypted.length === 0) throw new Error('empty ciphertext');
      const value = localCipher
        ? localCipher.decryptString(encrypted)
        : safeStorage.decryptString(encrypted);
      if (typeof value !== 'string' || value.length === 0) throw new Error('empty secret');
      return value;
    } catch {
      throw vaultError('SECRET_DECRYPT_FAILED', 'An ACE credential could not be decrypted');
    }
  }

  function hasSecret(key: any) {
    requireAvailable();
    if (!validKey(key)) return false;
    return Boolean(readDocument(filePath).secrets[key]);
  }

  function setSecret(key: any, secret: any) {
    requireAvailable();
    if (!validKey(key)) throw vaultError('INVALID_SECRET_KEY', 'Invalid ACE secure-storage key');
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 64 * 1024 || /[\0\r\n]/.test(secret)) {
      throw vaultError('INVALID_SECRET', 'Invalid ACE credential value');
    }
    const document = readDocument(filePath);
    // The darwin key was lost while ciphertext remained: those entries are
    // permanently undecryptable. Minting a fresh key would leave them as
    // garbage that masks the loss (and reads mis-key), so reset to a clean
    // document. The dropped entries were already unrecoverable; the new key
    // and the vault stay consistent, and the write still succeeds (no login
    // lockout). Existing entries under a present key are untouched.
    if (localCipher && localCipher.keyMissing() && Object.keys(document.secrets).length > 0) {
      document.secrets = {};
    }
    let encrypted: Buffer;
    try {
      encrypted = localCipher ? localCipher.encryptString(secret) : safeStorage.encryptString(secret);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('empty ciphertext');
    } catch {
      throw vaultError('SECRET_ENCRYPT_FAILED', 'An ACE credential could not be encrypted');
    }
    document.secrets[key] = encrypted.toString('base64');
    writeDocument(filePath, document);
    return { ok: true };
  }

  function deleteSecret(key: any) {
    requireAvailable();
    if (!validKey(key)) throw vaultError('INVALID_SECRET_KEY', 'Invalid ACE secure-storage key');
    const document = readDocument(filePath);
    if (!document.secrets[key]) return { ok: true, removed: false };
    delete document.secrets[key];
    writeDocument(filePath, document);
    return { ok: true, removed: true };
  }

  return { filePath, status, getSecret, hasSecret, setSecret, deleteSecret };
}

module.exports = {
  VAULT_VERSION,
  DEFAULT_FILENAME,
  LOCAL_FILENAME,
  LOCAL_KEY_FILENAME,
  LOCAL_BACKEND,
  storageStatus,
  createSecureVault,
};
