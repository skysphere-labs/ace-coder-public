// Lazy-load better-sqlite3: it's a native module compiled for Electron.
// Controller unit tests run under plain node and don't need transcript
// storage, so importing at the top level would break them. Load on first
// real use via `openStore`.
let Database: any = null;
function loadDatabase() {
  if (Database) return Database;
  Database = require('better-sqlite3');
  return Database;
}
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tui_transcript_entries (
  stream_id   TEXT NOT NULL,
  entry_seq   INTEGER NOT NULL,
  role        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  lifecycle   TEXT NOT NULL,
  t_at        INTEGER NOT NULL,
  PRIMARY KEY (stream_id, entry_seq)
);
CREATE INDEX IF NOT EXISTS idx_transcript_stream
  ON tui_transcript_entries (stream_id, entry_seq DESC);

CREATE TABLE IF NOT EXISTS tui_transcript_links (
  stream_id     TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  session_file  TEXT NOT NULL,
  cwd           TEXT,
  linked_at     INTEGER NOT NULL,
  byte_offset   INTEGER DEFAULT 0,
  turn_state    TEXT
);

CREATE TABLE IF NOT EXISTS tui_transcript_keys (
  stream_id     TEXT NOT NULL,
  key           TEXT NOT NULL,
  entry_seq     INTEGER NOT NULL,
  PRIMARY KEY (stream_id, key)
);
`;

function openStore(userDataPath: any) {
  const Db = loadDatabase();
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'ace-transcripts.db');
  const db = new Db(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Idempotent migration: the initial shipped schema omitted turn_state.
  // Add it if the existing DB predates the normalizer-state persistence.
  try {
    const cols = db.prepare('PRAGMA table_info(tui_transcript_links)').all().map((c: any) => c.name);
    if (!cols.includes('turn_state')) {
      db.exec('ALTER TABLE tui_transcript_links ADD COLUMN turn_state TEXT');
    }
  } catch { /* ignore */ }
  return db;
}

function createTranscriptStore({ userDataPath, db: injectedDb }: any = {}) {
  const db = injectedDb || openStore(userDataPath || process.cwd());
  if (injectedDb) db.exec(SCHEMA);

  const insertEntry = db.prepare(`
    INSERT INTO tui_transcript_entries (stream_id, entry_seq, role, payload, lifecycle, t_at)
    VALUES (@stream_id, @entry_seq, @role, @payload, @lifecycle, @t_at)
  `);
  const updateEntry = db.prepare(`
    UPDATE tui_transcript_entries
       SET role=@role, payload=@payload, lifecycle=@lifecycle, t_at=@t_at
     WHERE stream_id=@stream_id AND entry_seq=@entry_seq
  `);
  const selectMaxSeq = db.prepare(`
    SELECT COALESCE(MAX(entry_seq), -1) AS max_seq
      FROM tui_transcript_entries
     WHERE stream_id = ?
  `);
  const selectEntries = db.prepare(`
    SELECT entry_seq, role, payload, lifecycle, t_at
      FROM tui_transcript_entries
     WHERE stream_id = ?
       AND entry_seq > ?
     ORDER BY entry_seq ASC
     LIMIT ?
  `);
  const selectLatestEntries = db.prepare(`
    SELECT entry_seq, role, payload, lifecycle, t_at
      FROM tui_transcript_entries
     WHERE stream_id = ?
     ORDER BY entry_seq DESC
     LIMIT ?
  `);
  const selectEntriesBefore = db.prepare(`
    SELECT entry_seq, role, payload, lifecycle, t_at
      FROM tui_transcript_entries
     WHERE stream_id = ?
       AND entry_seq < ?
     ORDER BY entry_seq DESC
     LIMIT ?
  `);
  const selectHasEntryBefore = db.prepare(`
    SELECT 1 AS has_entry
      FROM tui_transcript_entries
     WHERE stream_id = ?
       AND entry_seq < ?
     LIMIT 1
  `);
  const deleteEntriesAfter = db.prepare(`
    DELETE FROM tui_transcript_entries
     WHERE stream_id = ? AND entry_seq >= ?
  `);
  const deleteAllEntries = db.prepare(`
    DELETE FROM tui_transcript_entries WHERE stream_id = ?
  `);
  const insertLink = db.prepare(`
    INSERT OR REPLACE INTO tui_transcript_links
      (stream_id, agent, session_id, session_file, cwd, linked_at, byte_offset, turn_state)
    VALUES (@stream_id, @agent, @session_id, @session_file, @cwd, @linked_at, @byte_offset, @turn_state)
  `);
  const selectLink = db.prepare(`
    SELECT stream_id, agent, session_id, session_file, cwd, linked_at, byte_offset, turn_state
      FROM tui_transcript_links
     WHERE stream_id = ?
  `);
  const updateOffset = db.prepare(`
    UPDATE tui_transcript_links SET byte_offset=? WHERE stream_id=?
  `);
  const updateTurnState = db.prepare(`
    UPDATE tui_transcript_links SET turn_state=? WHERE stream_id=?
  `);
  const deleteLink = db.prepare(`
    DELETE FROM tui_transcript_links WHERE stream_id = ?
  `);
  const selectLinksBySessionFile = db.prepare(`
    SELECT stream_id, agent, session_id, session_file, cwd, linked_at, byte_offset, turn_state
      FROM tui_transcript_links
     WHERE session_file = ?
       AND stream_id != ?
  `);
  const deleteKeysAfter = db.prepare(`
    DELETE FROM tui_transcript_keys
     WHERE stream_id = ? AND entry_seq >= ?
  `);
  const deleteAllKeys = db.prepare(`
    DELETE FROM tui_transcript_keys WHERE stream_id = ?
  `);
  const selectKey = db.prepare(`
    SELECT entry_seq FROM tui_transcript_keys WHERE stream_id=? AND key=?
  `);
  const insertKey = db.prepare(`
    INSERT OR REPLACE INTO tui_transcript_keys (stream_id, key, entry_seq) VALUES (?, ?, ?)
  `);

  function getNextSeq(streamId: any) {
    const row = selectMaxSeq.get(streamId);
    return (row?.max_seq ?? -1) + 1;
  }

  function appendEntry(streamId: any, entry: any) {
    const seq = getNextSeq(streamId);
    const { id: _id, ...rest } = entry;
    void _id;
    insertEntry.run({
      stream_id: streamId,
      entry_seq: seq,
      role: entry.role,
      payload: JSON.stringify(rest),
      lifecycle: entry.lifecycle || 'finished',
      t_at: entry.tAt || Date.now(),
    });
    return { ...entry, id: seq };
  }

  function replaceEntry(streamId: any, seq: any, entry: any) {
    const { id: _id, ...rest } = entry;
    void _id;
    updateEntry.run({
      stream_id: streamId,
      entry_seq: seq,
      role: entry.role,
      payload: JSON.stringify(rest),
      lifecycle: entry.lifecycle || 'finished',
      t_at: entry.tAt || Date.now(),
    });
    return { ...entry, id: seq };
  }

  function upsertByKey(streamId: any, key: any, build: any) {
    const existing = selectKey.get(streamId, key);
    if (existing) {
      const row = db
        .prepare(
          `SELECT entry_seq, role, payload, lifecycle, t_at
             FROM tui_transcript_entries
            WHERE stream_id=? AND entry_seq=?`
        )
        .get(streamId, existing.entry_seq);
      const prev = row ? rowToEntry(row) : null;
      const entry = build(prev);
      if (!entry) return null;
      const saved = replaceEntry(streamId, existing.entry_seq, entry);
      return { entry: saved, created: false };
    }
    const entry = build(null);
    if (!entry) return null;
    const saved = appendEntry(streamId, entry);
    insertKey.run(streamId, key, saved.id);
    return { entry: saved, created: true };
  }

  function rowToEntry(row: any) {
    const payload = JSON.parse(row.payload);
    return { ...payload, id: row.entry_seq, role: row.role, lifecycle: row.lifecycle, tAt: row.t_at };
  }

  function readEntries(streamId: any, { since = -1, limit = 10000 }: any = {}) {
    const rows = selectEntries.all(streamId, since, limit);
    return rows.map(rowToEntry);
  }

  function readLatestEntries(streamId: any, { limit = 20 }: any = {}) {
    const rows = selectLatestEntries.all(streamId, limit);
    return rows.reverse().map(rowToEntry);
  }

  function readEntriesBefore(streamId: any, { before, limit = 20 }: any = {}) {
    const rows = selectEntriesBefore.all(streamId, before, limit);
    return rows.reverse().map(rowToEntry);
  }

  function hasEntriesBefore(streamId: any, before: any) {
    return !!selectHasEntryBefore.get(streamId, before);
  }

  function truncateAfter(streamId: any, seq: any) {
    deleteEntriesAfter.run(streamId, seq);
    deleteKeysAfter.run(streamId, seq);
  }

  function clear(streamId: any) {
    deleteAllEntries.run(streamId);
    deleteAllKeys.run(streamId);
  }

  function link(streamId: any, row: any) {
    if (row.agent === 'codex') {
      deleteLink.run(streamId);
      return;
    }
    insertLink.run({
      stream_id: streamId,
      agent: row.agent,
      session_id: row.sessionId,
      session_file: row.sessionFile,
      cwd: row.cwd || null,
      linked_at: row.linkedAt || Date.now(),
      byte_offset: row.byteOffset || 0,
      turn_state: row.turnState || null,
    });
  }

  const rebindSessionTransaction = db.transaction((streamId: any, row: any) => {
    deleteAllEntries.run(streamId);
    deleteAllKeys.run(streamId);
    insertLink.run({
      stream_id: streamId,
      agent: row.agent,
      session_id: row.sessionId,
      session_file: row.sessionFile,
      cwd: row.cwd || null,
      linked_at: row.linkedAt || Date.now(),
      byte_offset: row.byteOffset || 0,
      turn_state: row.turnState || null,
    });
  });

  function rebindSession(streamId: any, row: any) {
    rebindSessionTransaction(streamId, row);
  }

  function getLink(streamId: any) {
    const row = selectLink.get(streamId);
    if (!row) return null;
    if (row.agent === 'codex') return null;
    return {
      streamId: row.stream_id,
      agent: row.agent,
      sessionId: row.session_id,
      sessionFile: row.session_file,
      cwd: row.cwd,
      linkedAt: row.linked_at,
      byteOffset: row.byte_offset || 0,
      turnState: row.turn_state || null,
    };
  }

  function setByteOffset(streamId: any, offset: any) {
    updateOffset.run(offset, streamId);
  }

  function setTurnState(streamId: any, turnState: any) {
    updateTurnState.run(turnState || null, streamId);
  }

  function unlink(streamId: any) {
    deleteLink.run(streamId);
  }

  function unlinkSessionFileAliases(sessionFile: any, keepStreamId: any, options: any = {}) {
    const aliases = selectLinksBySessionFile.all(sessionFile, keepStreamId);
    const removed = [];
    for (const alias of aliases) {
      if (typeof options.shouldUnlink === 'function' && !options.shouldUnlink(alias.stream_id, alias)) {
        continue;
      }
      unlink(alias.stream_id);
      removed.push(alias.stream_id);
    }
    return removed;
  }

  function close() {
    if (!injectedDb) db.close();
  }

  return {
    appendEntry,
    replaceEntry,
    upsertByKey,
    readEntries,
    readLatestEntries,
    readEntriesBefore,
    hasEntriesBefore,
    truncateAfter,
    clear,
    link,
    rebindSession,
    getLink,
    setByteOffset,
    setTurnState,
    unlink,
    unlinkSessionFileAliases,
    close,
    getNextSeq,
    _db: db,
  };
}

module.exports = { createTranscriptStore, openStore };
