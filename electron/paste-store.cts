const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const PASTES_SUBDIR = 'ace-pastes';
// Pastes older than this are swept on startup. Any Ace session that still
// has a reference after a day is either stale or already copied elsewhere.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pastesDir(baseTempDir: any) {
  return path.join(baseTempDir || os.tmpdir(), PASTES_SUBDIR);
}

function sanitizeExt(extHint: any) {
  if (typeof extHint !== 'string') return 'png';
  return /^[a-z0-9]{1,6}$/i.test(extHint) ? extHint.toLowerCase() : 'png';
}

function coerceBuffer(bytes: any) {
  if (!bytes) return null;
  if (Buffer.isBuffer(bytes)) return bytes;
  if (Array.isArray(bytes) || bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (typeof bytes === 'string') return Buffer.from(bytes, 'base64');
  // JSON-serialized Uint8Array arrives as a plain object with numeric keys
  // (e.g. {"0":1,"1":2}). Without this branch the HTTP/PWA bridge silently
  // turned every attachment write into an empty buffer.
  if (typeof bytes === 'object') {
    const keys = Object.keys(bytes);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const arr = new Uint8Array(keys.length);
      for (const k of keys) arr[Number(k)] = bytes[k];
      return Buffer.from(arr);
    }
  }
  return null;
}

async function writePasteImage({ bytes, ext, baseTempDir }: any) {
  const buf = coerceBuffer(bytes);
  if (!buf) return { path: null, error: 'attachment bytes were unreadable' };
  if (buf.length === 0) return { path: null, error: 'attachment was empty' };
  const dir = pastesDir(baseTempDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const safeExt = sanitizeExt(ext);
  // UUID instead of timestamp: sub-ms pastes can't collide and the filename
  // carries no information a reader shouldn't already have.
  const file = path.join(dir, `paste-${randomUUID()}.${safeExt}`);
  await fs.promises.writeFile(file, buf);
  return { path: file };
}

// Called at startup from main.cjs. Non-blocking, best-effort: a failure here
// just means we skip the sweep this launch.
function sweepOldPastes(baseTempDir: any) {
  const dir = pastesDir(baseTempDir);
  fs.promises
    .readdir(dir)
    .then(async (entries: any) => {
      const cutoff = Date.now() - MAX_AGE_MS;
      await Promise.all(
        entries.map(async (name: any) => {
          const full = path.join(dir, name);
          try {
            const stat = await fs.promises.stat(full);
            if (stat.mtimeMs < cutoff) {
              await fs.promises.unlink(full);
            }
          } catch {
            // File vanished or isn't ours — skip.
          }
        })
      );
    })
    .catch(() => {
      // Directory doesn't exist yet — nothing to sweep.
    });
}

module.exports = {
  writePasteImage,
  sweepOldPastes,
  pastesDir,
  coerceBuffer,
};
