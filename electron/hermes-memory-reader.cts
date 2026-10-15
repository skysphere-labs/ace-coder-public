// hermes-memory-reader.cts — STRICTLY READ-ONLY access to Hermes memories so
// the knowledge index can surface them to every agent at trust='external'.
//
// Hermes owns its memory system (per-workspace hermes-home with memories/ and
// state.db; see hermes-home.cts). Ace must never write there:
//   - This module exports READ functions only.
//   - state.db is opened with { readonly: true, fileMustExist: true } and
//     closed immediately; SQLITE_BUSY or schema mismatch → skipped silently.
//   - Every write path in the knowledge plane rejects hermes-home targets.
//
// Constraints mirror knowledge-index.cts: Node built-ins only, Database
// constructor injected, fail-safe (never throws).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { secretHits } = require('./harness/knowledge-contract.cts');

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_BODY_CHARS = 20_000;
const MAX_DB_ROWS = 500;
const EXCERPT_LENGTH = 240;

function listSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statSafe(filePath: string): any | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

/** Every hermes-home root that may carry memories, with its workspace id. */
function hermesMemoryRoots(userDataPath: any, homeDir?: any): Array<{ root: string; workspace: string | null }> {
  const roots: Array<{ root: string; workspace: string | null }> = [];
  const userData = typeof userDataPath === 'string' && userDataPath.trim() ? userDataPath : null;
  if (userData) {
    for (const name of listSafe(userData)) {
      if (name === 'hermes-home') roots.push({ root: path.join(userData, name), workspace: null });
      else if (name.startsWith('hermes-home-')) {
        roots.push({ root: path.join(userData, name), workspace: name.slice('hermes-home-'.length) || null });
      }
    }
  }
  // Shared provider memories require an explicit source selection. A fresh
  // app profile must never index the ambient user's private Hermes history.
  if (typeof homeDir === 'string' && homeDir.trim()) {
    const homeHermes = path.join(homeDir, '.hermes');
    try {
      if (fs.statSync(homeHermes).isDirectory()) roots.push({ root: homeHermes, workspace: null });
    } catch { /* configured source is absent */ }
  }
  return roots;
}

function excerptOf(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH);
}

function docFromMemoryFile(root: any, absPath: string): any | null {
  const stat = statSafe(absPath);
  if (!stat || stat.size > MAX_FILE_BYTES) return null;
  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  if (secretHits(content).length > 0) return null;
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(absPath, '.md');
  return {
    source: 'hermes-memory',
    path: absPath,
    relPath: path.relative(root.root, absPath).split(path.sep).join('/'),
    project: root.workspace,
    title: title.slice(0, 300),
    kind: 'reference',
    trust: 'external',
    tags: [],
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    expiresAt: null,
    mtimeMs: Math.floor(stat.mtimeMs),
    sizeBytes: stat.size,
    body: content.slice(0, MAX_BODY_CHARS),
    excerpt: excerptOf(content),
  };
}

/** Pick the first text-ish field from an unknown memories-table row. */
function rowText(row: any): string {
  for (const key of ['content', 'text', 'memory', 'value', 'body', 'summary']) {
    if (typeof row?.[key] === 'string' && row[key].trim()) return row[key];
  }
  return '';
}

function rowTimestamp(row: any): string | null {
  for (const key of ['updated_at', 'updatedAt', 'created_at', 'createdAt', 'timestamp', 'at']) {
    const value = row?.[key];
    if (value == null) continue;
    const parsed = typeof value === 'number' ? value : Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString();
  }
  return null;
}

function docsFromStateDb(root: any, Database: any): any[] {
  const dbPath = path.join(root.root, 'state.db');
  const dbStat = statSafe(dbPath);
  if (!dbStat || typeof Database !== 'function') return [];
  let probe: any = null;
  const docs: any[] = [];
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    if (!hasTable) return [];
    const rows = probe.prepare(`SELECT * FROM memories LIMIT ${MAX_DB_ROWS}`).all();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const text = rowText(row);
      if (!text || secretHits(text).length > 0) continue;
      const id = row.id != null ? String(row.id) : String(i);
      const updatedAt = rowTimestamp(row) || new Date(dbStat.mtimeMs).toISOString();
      docs.push({
        source: 'hermes-memory',
        path: `${dbPath}#mem_${id}`,
        relPath: `state.db#mem_${id}`,
        project: root.workspace,
        title: excerptOf(text).slice(0, 80) || `hermes memory ${id}`,
        kind: 'reference',
        trust: 'external',
        tags: [],
        updatedAt,
        expiresAt: null,
        // Row-level mtimes are unknowable; key incremental updates off the
        // db file's mtime so a changed state.db re-indexes its rows.
        mtimeMs: Math.floor(dbStat.mtimeMs),
        sizeBytes: text.length,
        body: text.slice(0, MAX_BODY_CHARS),
        excerpt: excerptOf(text),
      });
    }
  } catch {
    return docs;
  } finally {
    try { probe?.close(); } catch { /* already closed */ }
  }
  return docs;
}

/**
 * Collect every Hermes memory as an indexable doc (READ-ONLY).
 * Sources: <hermes-home>/memories/*.md + state.db `memories` table, for the
 * base home, every per-workspace home, and an explicitly selected shared home.
 */
function collectHermesMemoryDocs({ userDataPath, Database, homeDir }: any = {}): any[] {
  const docs: any[] = [];
  for (const root of hermesMemoryRoots(userDataPath, homeDir)) {
    const memoriesDir = path.join(root.root, 'memories');
    for (const name of listSafe(memoriesDir)) {
      if (!name.endsWith('.md')) continue;
      const doc = docFromMemoryFile(root, path.join(memoriesDir, name));
      if (doc) docs.push(doc);
    }
    docs.push(...docsFromStateDb(root, Database));
  }
  return docs;
}

/** True when a path points inside any hermes-home (write paths must refuse). */
function isHermesPath(candidate: any, userDataPath: any): boolean {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const resolved = path.resolve(candidate);
  // Preserve the write barrier for private provider storage without indexing it.
  const sharedRoot = path.resolve(os.homedir(), '.hermes');
  if (resolved === sharedRoot || resolved.startsWith(sharedRoot + path.sep)) return true;
  for (const root of hermesMemoryRoots(userDataPath)) {
    const rootResolved = path.resolve(root.root);
    if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) return true;
  }
  return false;
}

module.exports = { collectHermesMemoryDocs, hermesMemoryRoots, isHermesPath };
