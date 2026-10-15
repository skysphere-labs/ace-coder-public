const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  applyWorkspaceOrderSchema,
  reorderTasksInWorkspaceInDb,
  reorderWorkspacesInDb,
} = require('../local-core.cjs');

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      primary_agent TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('applyWorkspaceOrderSchema backfills project and task order_index by creation order', () => {
  const db = setupDb();
  db.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p2', 'Two', '/tmp/two', '2026-01-02', '2026-01-02');
  db.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p1', 'One', '/tmp/one', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run('t2', 'p1', 'thread', 'Two', 'claude', '2026-01-02', '2026-01-02');
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run('t1', 'p1', 'thread', 'One', 'claude', '2026-01-01', '2026-01-01');

  applyWorkspaceOrderSchema(db);

  assert.deepEqual(
    db.prepare('SELECT id, order_index FROM projects ORDER BY order_index ASC').all(),
    [
      { id: 'p1', order_index: 0 },
      { id: 'p2', order_index: 1 },
    ]
  );
  assert.deepEqual(
    db.prepare('SELECT id, order_index FROM tasks WHERE project_id=? ORDER BY order_index ASC').all('p1'),
    [
      { id: 't1', order_index: 0 },
      { id: 't2', order_index: 1 },
    ]
  );
});

test('reorderWorkspacesInDb persists caller-supplied workspace order', () => {
  const db = setupDb();
  applyWorkspaceOrderSchema(db);
  for (const [idx, id] of ['p1', 'p2', 'p3'].entries()) {
    db.prepare('INSERT INTO projects (id, name, path, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, `/tmp/${id}`, idx, `2026-01-0${idx + 1}`, `2026-01-0${idx + 1}`);
  }

  const result = reorderWorkspacesInDb(db, ['p3', 'p1', 'p2']);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    db.prepare('SELECT id FROM projects ORDER BY order_index ASC, created_at ASC').all().map((row) => row.id),
    ['p3', 'p1', 'p2']
  );
});

test('reorderTasksInWorkspaceInDb rejects cross-workspace task ids', () => {
  const db = setupDb();
  applyWorkspaceOrderSchema(db);
  db.prepare('INSERT INTO projects (id, name, path, order_index, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run('p1', 'One', '/tmp/one', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO projects (id, name, path, order_index, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('p2', 'Two', '/tmp/two', '2026-01-02', '2026-01-02');
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, order_index, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
    .run('t1', 'p1', 'thread', 'One', 'claude', 0, '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, order_index, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
    .run('t2', 'p2', 'thread', 'Two', 'claude', 0, '2026-01-02', '2026-01-02');

  assert.throws(
    () => reorderTasksInWorkspaceInDb(db, 'p1', ['t2', 't1']),
    /does not belong to workspace/
  );
});
