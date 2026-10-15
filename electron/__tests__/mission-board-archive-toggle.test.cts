// Regression: merged PR cleanup used to archive the backing task row from the
// mission board read path. That made completed agent tasks disappear without an
// explicit operator action, and legacy archive-disable triggers then blocked the
// manual Archive button. Board reads must leave tasks active; explicit archive
// must remain available.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const os = require('os');

const Database = require('better-sqlite3');
const { createAceStore } = require('../local-core.cjs');

function git(cwd: any, ...args: any[]) {
  return require('node:child_process')
    .execFileSync('git', args, { cwd, encoding: 'utf8' })
    .trim();
}

function bootstrapWorkspace(root: string) {
  const userDataPath = path.join(root, 'user-data');
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n', 'utf8');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  return { userDataPath, repoPath };
}

const ARCHIVE_GUARD_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS ace_disable_task_archive_guard
BEFORE UPDATE OF archived_at ON tasks
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Ace task archive disabled by operator toggle');
END;
CREATE TRIGGER IF NOT EXISTS ace_disable_mission_feature_archive_guard
BEFORE UPDATE OF archived_at ON mission_features
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Ace mission archive disabled by operator toggle');
END;
`;

test('mission board read does not auto-archive merged tasks and manual archive still works', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-archive-toggle-'));
  const { userDataPath, repoPath } = bootstrapWorkspace(root);
  const store = createAceStore(userDataPath);
  t.after(() => {
    try { store.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { id: workspaceId } = await store.importWorkspace({ workspacePath: repoPath });
  const created = store.missionCreate({
    workspaceId,
    name: 'Archive toggle mission',
    features: [{ id: 'ft_merged', name: 'Merged card', allowPaths: ['README.md'] }],
  });
  assert.ok(created.missionId, 'mission created');

  // Seed a merged-but-unarchived card, then install legacy guard triggers that
  // used to block the manual Archive button.
  const db = new Database(path.join(userDataPath, 'ace.db'));
  t.after(() => { try { db.close(); } catch {} });
  const now = new Date('2026-06-15T00:00:00.000Z').toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, kind, name, primary_agent, created_at, updated_at)
     VALUES ('tsk_merged', ?, 'task', 'Merged worker', 'claude', ?, ?)`
  ).run(workspaceId, now, now);
  db.prepare(
    `UPDATE mission_features
        SET task_id='tsk_merged', last_seen_state='pr_merged',
            pr_url='https://example.com/pr/1', completed_at=?
      WHERE id='ft_merged'`
  ).run(now);
  db.exec(ARCHIVE_GUARD_TRIGGERS);

  // Sanity: the guard really does block an archive write (proves the toggle).
  assert.throws(
    () => db.prepare(`UPDATE tasks SET archived_at=? WHERE id='tsk_merged'`).run(now),
    /archive disabled by operator toggle/,
    'guard trigger blocks archived_at writes'
  );

  // The read must not archive the backing task as a side effect.
  let board: any;
  assert.doesNotThrow(() => {
    board = store.missionBoard({ workspaceId, includeArchived: true });
  }, 'mission board read succeeds');

  const cards = (board.missions || []).flatMap((m: any) => m.cards || []);
  const card = cards.find((c: any) => c.id === 'ft_merged');
  assert.ok(card, 'merged card is still visible on the board');

  // Owner intent preserved: the task was not auto-archived.
  const archivedAt = db.prepare(`SELECT archived_at FROM tasks WHERE id='tsk_merged'`).get();
  assert.equal(archivedAt.archived_at, null, 'task remains un-archived after board read');

  const manualArchivedAt = '2026-06-15T01:00:00.000Z';
  await store.archiveTask({
    taskId: 'tsk_merged',
    prUrl: 'https://example.com/pr/1',
    mergedAt: manualArchivedAt,
  });
  const archivedTask = db
    .prepare(`SELECT archived_at, archived_pr_url FROM tasks WHERE id='tsk_merged'`)
    .get();
  assert.equal(archivedTask.archived_at, manualArchivedAt, 'manual archive writes archived_at');
  assert.equal(archivedTask.archived_pr_url, 'https://example.com/pr/1');
  const remainingLegacyTriggers = db.prepare(
    `SELECT COUNT(*) AS count
       FROM sqlite_master
      WHERE type='trigger'
        AND name IN ('ace_disable_task_archive_guard', 'ace_disable_mission_feature_archive_guard')`
  ).get();
  assert.equal(remainingLegacyTriggers.count, 0, 'manual archive removes legacy archive-disable triggers');

  // ready view (readyOnly) shares the same getMissionBoard path — also survives.
  assert.doesNotThrow(() => {
    store.missionBoard({ workspaceId, readyOnly: true });
  }, 'mission ready read also degrades quietly');
});
