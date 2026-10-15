// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
import { test } from 'vitest';
import assert from 'node:assert/strict';

const Database = require('better-sqlite3');

const {
  applyAgentLaneSchema,
  archiveDuplicateOrchestratorTasks,
  findMainOrchestratorTaskForProject,
  laneIdForOperator,
  operatorLaneLabel,
  seedBuiltinPersonalAgentLanes,
  listAgentLanesFromDb,
  normalizeAgentLaneLabel,
  upsertPersonalAgentLane,
} = require('../agent-lanes.cts');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      is_personal INTEGER NOT NULL DEFAULT 0,
      personal_identity TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      primary_agent TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  applyAgentLaneSchema(db);
  return db;
}

function insertPersonalLaneFixture(db, identity, opts = {}) {
  const label = identity === 'king' ? 'King' : 'Rook';
  const projectId = opts.projectId || `prj-${identity}`;
  const taskId = opts.taskId || `thr-${identity}`;
  const conversationId = opts.conversationId || `conv-${identity}`;
  const now = opts.createdAt || '2026-05-02T00:00:00.000Z';
  db.prepare(
    `INSERT INTO projects (id, name, path, is_personal, personal_identity, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(projectId, opts.projectName || label, `/tmp/${projectId}`, identity, now, now);
  db.prepare(
    `INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at, updated_at)
     VALUES (?, ?, 'thread', ?, 'hermes', NULL, ?, ?)`
  ).run(taskId, projectId, opts.taskName || 'Hermes Orchestrator', now, now);
  db.prepare(
    `INSERT INTO conversations (id, task_id, title, agent, is_main, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'hermes', 1, 0, ?, ?)`
  ).run(conversationId, taskId, label, now, now);
  return { projectId, taskId, conversationId };
}

function insertTaskWithConversation(db, projectId, opts) {
  const now = opts.createdAt || '2026-05-02T00:00:00.000Z';
  db.prepare(
    `INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at, updated_at)
     VALUES (?, ?, 'thread', ?, 'hermes', NULL, ?, ?)`
  ).run(opts.taskId, projectId, opts.taskName, now, now);
  db.prepare(
    `INSERT INTO conversations (id, task_id, title, agent, is_main, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'hermes', 1, 0, ?, ?)`
  ).run(opts.conversationId, opts.taskId, opts.title || 'Rook', now, now);
}

// Owner-shaped operator profiles as produced by the operators.cts migration
// (only the fields lane seeding consumes).
const OWNER_ROOK_OPERATOR = { id: 'rook', label: 'Rook', agent: 'hermes', sortOrder: 0 };
const OWNER_KING_OPERATOR = { id: 'king', label: 'King', agent: 'hermes', sortOrder: 1 };

function laneSnapshot(db) {
  return listAgentLanesFromDb(db).map((lane) => ({
    id: lane.id,
    label: lane.label,
    agent: lane.agent,
    providerKind: lane.providerKind,
    projectId: lane.projectId,
    taskId: lane.taskId,
    sortOrder: lane.sortOrder,
    isBuiltin: lane.isBuiltin,
    metadata: lane.metadata,
  }));
}

test('normalizeAgentLaneLabel trims labels and falls back safely', () => {
  assert.equal(normalizeAgentLaneLabel('  Vector PM  ', 'Fallback'), 'Vector PM');
  assert.equal(normalizeAgentLaneLabel('', 'Fallback'), 'Fallback');
  assert.equal(normalizeAgentLaneLabel(null, 'Fallback'), 'Fallback');
});

test('migrated owner operator profiles produce byte-identical lane ids and labels', () => {
  // CRITICAL rollback/persistence guarantee: the operator-driven functions
  // must yield exactly the ids/labels the legacy hardcoded mapping produced
  // for the owner's migrated profiles, so existing agent_lanes rows keep
  // resolving after the legacy wrappers were removed.
  assert.equal(laneIdForOperator(OWNER_ROOK_OPERATOR), 'lane-rook');
  assert.equal(laneIdForOperator(OWNER_KING_OPERATOR), 'lane-king');
  assert.equal(operatorLaneLabel(OWNER_ROOK_OPERATOR), 'Rook');
  assert.equal(operatorLaneLabel(OWNER_KING_OPERATOR), 'King');
});

test('custom operator profiles drive lane id and label from the config', () => {
  const atlas = { id: 'atlas', label: 'Atlas', agent: 'hermes', sortOrder: 3 };
  assert.equal(laneIdForOperator(atlas), 'lane-atlas');
  assert.equal(operatorLaneLabel(atlas), 'Atlas');
  // Label falls back to a humanized id when the config omits it.
  assert.equal(operatorLaneLabel({ id: 'night-watch' }), 'Night Watch');
});

test('seedBuiltinPersonalAgentLanes: fresh DB with no personal projects starts with zero lanes', () => {
  const db = createDb();
  const result = seedBuiltinPersonalAgentLanes(db);
  assert.deepEqual(result, { inserted: 0, updated: 0 });
  assert.deepEqual(listAgentLanesFromDb(db), []);
});

test('listAgentLanesFromDb does not create hardcoded personal lanes from projects', () => {
  const db = createDb();
  insertPersonalLaneFixture(db, 'rook');
  insertPersonalLaneFixture(db, 'king');

  assert.deepEqual(listAgentLanesFromDb(db), []);
});

test('upsertPersonalAgentLane persists only the invoked operator', () => {
  const db = createDb();
  const king = insertPersonalLaneFixture(db, 'king');

  const lane = upsertPersonalAgentLane(db, {
    operator: OWNER_KING_OPERATOR,
    projectId: king.projectId,
    taskId: king.taskId,
    now: '2026-05-18T00:00:00.000Z',
  });
  const lanes = listAgentLanesFromDb(db);

  assert.equal(lane.id, 'lane-king');
  assert.deepEqual(lanes.map((item) => item.id), ['lane-king']);
  assert.equal(lanes[0].projectId, king.projectId);
  assert.equal(lanes[0].taskId, king.taskId);
});

test('upsertPersonalAgentLane requires an operator object (legacy identity arg removed)', () => {
  const db = createDb();
  const king = insertPersonalLaneFixture(db, 'king');

  const lane = upsertPersonalAgentLane(db, {
    identity: 'king',
    projectId: king.projectId,
    taskId: king.taskId,
    now: '2026-05-18T00:00:00.000Z',
  });

  assert.equal(lane, null);
  assert.deepEqual(listAgentLanesFromDb(db), []);
});

test('upsertPersonalAgentLane: migrated owner operator writes the exact legacy row', () => {
  // ROLLBACK-COMPAT: the operator-driven call writes the same row the legacy
  // identity call wrote, so old and new builds agree on the owner's lanes.
  const operatorDb = createDb();
  const now = '2026-05-18T00:00:00.000Z';
  const operatorKing = insertPersonalLaneFixture(operatorDb, 'king');

  upsertPersonalAgentLane(operatorDb, {
    operator: OWNER_KING_OPERATOR,
    projectId: operatorKing.projectId,
    taskId: operatorKing.taskId,
    now,
  });

  assert.deepEqual(laneSnapshot(operatorDb), [
    {
      id: 'lane-king',
      label: 'King',
      agent: 'hermes',
      providerKind: 'builtin-personal',
      projectId: operatorKing.projectId,
      taskId: operatorKing.taskId,
      sortOrder: 1,
      isBuiltin: true,
      metadata: { personalIdentity: 'king' },
    },
  ]);
});

test('upsertPersonalAgentLane accepts a custom operator profile', () => {
  const db = createDb();
  const fixture = insertPersonalLaneFixture(db, 'atlas');

  const lane = upsertPersonalAgentLane(db, {
    operator: { id: 'atlas', label: 'Atlas', sortOrder: 5 },
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    now: '2026-05-18T00:00:00.000Z',
  });

  assert.equal(lane.id, 'lane-atlas');
  assert.equal(lane.label, 'Atlas');
  assert.equal(lane.agent, 'hermes');
  assert.equal(lane.sortOrder, 5);
  assert.deepEqual(lane.metadata, { personalIdentity: 'atlas' });
});

test('seedBuiltinPersonalAgentLanes: migrates existing Rook and King without duplicating projects/tasks', () => {
  const db = createDb();
  const rook = insertPersonalLaneFixture(db, 'rook');
  const king = insertPersonalLaneFixture(db, 'king');
  const ownerOperators = [OWNER_ROOK_OPERATOR, OWNER_KING_OPERATOR];

  const first = seedBuiltinPersonalAgentLanes(db, ownerOperators);
  const second = seedBuiltinPersonalAgentLanes(db, ownerOperators);
  const lanes = listAgentLanesFromDb(db);

  assert.deepEqual(first, { inserted: 2, updated: 0 });
  assert.deepEqual(second, { inserted: 0, updated: 0 });
  assert.deepEqual(lanes.map((lane) => lane.id), ['lane-rook', 'lane-king']);
  assert.deepEqual(
    lanes.map((lane) => ({
      id: lane.id,
      label: lane.label,
      agent: lane.agent,
      providerKind: lane.providerKind,
      projectId: lane.projectId,
      taskId: lane.taskId,
      mainConversationId: lane.mainConversationId,
      isBuiltin: lane.isBuiltin,
    })),
    [
      {
        id: 'lane-rook',
        label: 'Rook',
        agent: 'hermes',
        providerKind: 'builtin-personal',
        projectId: rook.projectId,
        taskId: rook.taskId,
        mainConversationId: rook.conversationId,
        isBuiltin: true,
      },
      {
        id: 'lane-king',
        label: 'King',
        agent: 'hermes',
        providerKind: 'builtin-personal',
        projectId: king.projectId,
        taskId: king.taskId,
        mainConversationId: king.conversationId,
        isBuiltin: true,
      },
    ]
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
});

test('seedBuiltinPersonalAgentLanes: owner operator profiles seed byte-identical lanes to the legacy default', () => {
  // ROLLBACK-COMPAT: seeding from the migrated owner operators.json profiles
  // must produce exactly the rows the legacy hardcoded seed produced, so the
  // owner's existing lane-rook/lane-king rows survive the legacy removal.
  const operatorDb = createDb();
  insertPersonalLaneFixture(operatorDb, 'rook');
  insertPersonalLaneFixture(operatorDb, 'king');

  const operatorResult = seedBuiltinPersonalAgentLanes(operatorDb, [
    OWNER_ROOK_OPERATOR,
    OWNER_KING_OPERATOR,
  ]);

  assert.deepEqual(operatorResult, { inserted: 2, updated: 0 });
  assert.deepEqual(
    laneSnapshot(operatorDb).map((lane) => ({
      id: lane.id,
      label: lane.label,
      metadata: lane.metadata,
      sortOrder: lane.sortOrder,
    })),
    [
      { id: 'lane-rook', label: 'Rook', metadata: { personalIdentity: 'rook' }, sortOrder: 0 },
      { id: 'lane-king', label: 'King', metadata: { personalIdentity: 'king' }, sortOrder: 1 },
    ]
  );
});

test('seedBuiltinPersonalAgentLanes: no operators means nothing is seeded (legacy default removed)', () => {
  const db = createDb();
  insertPersonalLaneFixture(db, 'rook');
  insertPersonalLaneFixture(db, 'king');

  const result = seedBuiltinPersonalAgentLanes(db);

  assert.deepEqual(result, { inserted: 0, updated: 0 });
  assert.deepEqual(listAgentLanesFromDb(db), []);
});

test('seedBuiltinPersonalAgentLanes: custom operators drive identity matching, labels, and sort order', () => {
  const db = createDb();
  insertPersonalLaneFixture(db, 'atlas');
  insertPersonalLaneFixture(db, 'rook');

  const result = seedBuiltinPersonalAgentLanes(db, [
    { id: 'atlas', label: 'Atlas', sortOrder: 0 },
    { id: 'rook', label: 'Rook', sortOrder: 1 },
  ]);

  assert.deepEqual(result, { inserted: 2, updated: 0 });
  assert.deepEqual(
    laneSnapshot(db).map((lane) => ({
      id: lane.id,
      label: lane.label,
      sortOrder: lane.sortOrder,
      metadata: lane.metadata,
    })),
    [
      { id: 'lane-atlas', label: 'Atlas', sortOrder: 0, metadata: { personalIdentity: 'atlas' } },
      { id: 'lane-rook', label: 'Rook', sortOrder: 1, metadata: { personalIdentity: 'rook' } },
    ]
  );
});

test('seedBuiltinPersonalAgentLanes: prefers current Hermes Agent orchestrator over legacy rows', () => {
  const db = createDb();
  const rook = insertPersonalLaneFixture(db, 'rook', {
    taskId: 'thr-legacy',
    conversationId: 'conv-legacy',
    taskName: 'Hermes Orchestrator — HER',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertTaskWithConversation(db, rook.projectId, {
    taskId: 'thr-current',
    conversationId: 'conv-current',
    taskName: 'Hermes Agent Orchestrator — ROO',
    title: 'Rook',
    createdAt: '2026-05-17T00:00:00.000Z',
  });

  seedBuiltinPersonalAgentLanes(db, [OWNER_ROOK_OPERATOR]);
  const lanes = listAgentLanesFromDb(db);

  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].id, 'lane-rook');
  assert.equal(lanes[0].taskId, 'thr-current');
  assert.equal(lanes[0].mainConversationId, 'conv-current');
});

test('archiveDuplicateOrchestratorTasks keeps the canonical Hermes Agent task and archives legacy aliases', () => {
  const db = createDb();
  const rook = insertPersonalLaneFixture(db, 'rook', {
    taskId: 'thr-legacy',
    conversationId: 'conv-legacy',
    taskName: 'Hermes Orchestrator — HER',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertTaskWithConversation(db, rook.projectId, {
    taskId: 'thr-current',
    conversationId: 'conv-current',
    taskName: 'Hermes Agent Orchestrator — ROO',
    title: 'Rook',
    createdAt: '2026-05-17T00:00:00.000Z',
  });

  const main = findMainOrchestratorTaskForProject(db, rook.projectId, 'hermes');
  const result = archiveDuplicateOrchestratorTasks(db, {
    projectId: rook.projectId,
    agent: 'hermes',
    keepTaskId: main.id,
    now: '2026-05-18T00:00:00.000Z',
  });

  assert.equal(main.id, 'thr-current');
  assert.deepEqual(result, { archived: 1 });
  assert.equal(db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get('thr-current').archived_at, null);
  assert.equal(
    db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get('thr-legacy').archived_at,
    '2026-05-18T00:00:00.000Z'
  );
});
