const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const SNAPSHOT_DIR = path.join(os.tmpdir(), 'ace-snapshots');
const MAX_FILES = 50;
const MAX_AGE_MS = 60 * 60 * 1000;

async function ensureDir() {
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
}

// Sweep on every snapshot — keep at most MAX_FILES of any single kind, and
// drop everything older than MAX_AGE_MS regardless. Cheap and bounded; no
// long-lived background timer.
async function sweep() {
  let entries;
  try { entries = await fsp.readdir(SNAPSHOT_DIR); } catch { return; }
  const stats = await Promise.all(entries.map(async (name: any) => {
    try {
      const stat = await fsp.stat(path.join(SNAPSHOT_DIR, name));
      return { name, mtimeMs: stat.mtimeMs };
    } catch { return null; }
  }));
  const cutoff = Date.now() - MAX_AGE_MS;
  const sorted = stats.filter(Boolean).sort((a: any, b: any) => b.mtimeMs - a.mtimeMs);
  for (let i = 0; i < sorted.length; i++) {
    const tooOld = sorted[i].mtimeMs < cutoff;
    const overflow = i >= MAX_FILES;
    if (tooOld || overflow) {
      await fsp.unlink(path.join(SNAPSHOT_DIR, sorted[i].name)).catch(() => {});
    }
  }
}

async function writeSnapshot({ streamId, ansi, text }: any) {
  await ensureDir();
  await sweep();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = String(streamId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const tag = `${stamp}_${slug}_${randomUUID().slice(0, 8)}`;
  const ansiPath = path.join(SNAPSHOT_DIR, `${tag}.ansi`);
  const textPath = path.join(SNAPSHOT_DIR, `${tag}.txt`);
  await fsp.writeFile(ansiPath, ansi || '', 'utf8');
  await fsp.writeFile(textPath, text || '', 'utf8');
  return { ansi: ansiPath, text: textPath };
}

module.exports = { writeSnapshot, SNAPSHOT_DIR };
