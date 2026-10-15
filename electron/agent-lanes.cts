const fs = require('fs');
const path = require('path');

const AGENT_LANE_PROVIDER_KINDS = new Set([
  'builtin-personal',
  'native-orchestrator',
  'hermes-profile',
]);

const AGENT_LANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_lanes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  agent TEXT NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'native-orchestrator',
  profile_id TEXT,
  profile_home TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  auto_start INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_lanes_sort_idx ON agent_lanes(sort_order, created_at);
CREATE INDEX IF NOT EXISTS agent_lanes_task_idx ON agent_lanes(task_id);
CREATE INDEX IF NOT EXISTS agent_lanes_project_idx ON agent_lanes(project_id);
`;

function nowIso() {
  return new Date().toISOString();
}

function safeString(value: any, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeAgentLaneLabel(value: any, fallback = 'Agent') {
  return safeString(value, fallback).slice(0, 80);
}

function normalizeAgentLaneProviderKind(value: any) {
  const kind = String(value || '').trim().toLowerCase();
  return AGENT_LANE_PROVIDER_KINDS.has(kind) ? kind : 'native-orchestrator';
}

function humanizeProfileId(id: any) {
  const raw = String(id || '').trim();
  if (!raw) return 'Hermes';
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

// Operator-driven lane identity (operator profiles come from
// electron/operators.cts). For migrated owner profiles the outputs are
// byte-identical to the legacy hardcoded mapping — proven by the
// byte-identity tests in electron/__tests__/agent-lanes.test.cts.
function laneIdForOperator(operator: any) {
  const id = safeString(operator && operator.id, 'hermes').toLowerCase();
  return `lane-${id}`;
}

function operatorLaneLabel(operator: any) {
  return normalizeAgentLaneLabel(
    operator && operator.label,
    humanizeProfileId(operator && operator.id)
  );
}

function applyAgentLaneSchema(db: any) {
  db.exec(AGENT_LANE_SCHEMA);
  const cols = db.prepare(`PRAGMA table_info(agent_lanes)`).all().map((c: any) => c.name);
  const addColumn = (name: any, sql: any) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE agent_lanes ADD COLUMN ${sql}`);
  };
  addColumn('profile_id', 'profile_id TEXT');
  addColumn('profile_home', 'profile_home TEXT');
  addColumn('sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
  addColumn('auto_start', 'auto_start INTEGER NOT NULL DEFAULT 1');
  addColumn('is_builtin', 'is_builtin INTEGER NOT NULL DEFAULT 0');
  addColumn('metadata_json', 'metadata_json TEXT');
  addColumn('archived_at', 'archived_at TEXT');
}

function pickMainConversation(db: any, taskId: any) {
  if (!taskId) return null;
  return db
    .prepare(
      `SELECT id FROM conversations
       WHERE task_id = ?
       ORDER BY is_main DESC, display_order ASC, created_at ASC
       LIMIT 1`
    )
    .get(taskId)?.id ?? null;
}

function orchestratorTaskNamePrefixes(agent: any) {
  const agentId = String(agent || 'hermes').toLowerCase();
  if (agentId === 'claude') return ['Claude Orchestrator'];
  if (agentId === 'codex') return ['Codex Orchestrator'];
  if (agentId === 'hermes') return ['Hermes Agent Orchestrator', 'Hermes Orchestrator'];
  return [`${agentId.charAt(0).toUpperCase()}${agentId.slice(1)} Orchestrator`];
}

function matchesOrchestratorTaskName(name: any, prefixes: any) {
  const value = String(name || '');
  return prefixes.some((prefix: any) => value === prefix || value.startsWith(`${prefix} — `));
}

function findOrchestratorTasksForProject(db: any, projectId: any, agent = 'hermes') {
  if (!projectId) return null;
  const agentId = String(agent || 'hermes').toLowerCase();
  const prefixes = orchestratorTaskNamePrefixes(agentId);
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE project_id = ?
         AND kind = 'thread'
         AND primary_agent = ?
         AND archived_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(projectId, agentId);
  return rows
    .filter((row: any) => matchesOrchestratorTaskName(row.name, prefixes))
    .sort((a: any, b: any) => {
      const ai = prefixes.findIndex((prefix: any) => matchesOrchestratorTaskName(a.name, [prefix]));
      const bi = prefixes.findIndex((prefix: any) => matchesOrchestratorTaskName(b.name, [prefix]));
      if (ai !== bi) return ai - bi;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
}

function findMainOrchestratorTaskForProject(db: any, projectId: any, agent = 'hermes') {
  return findOrchestratorTasksForProject(db, projectId, agent)?.[0] ?? null;
}

function archiveDuplicateOrchestratorTasks(db: any, { projectId, agent = 'hermes', keepTaskId, now }: any = {}) {
  if (!projectId || !keepTaskId) return { archived: 0 };
  const at = now || nowIso();
  const tasks = findOrchestratorTasksForProject(db, projectId, agent) || [];
  let archived = 0;
  const stmt = db.prepare(
    `UPDATE tasks
     SET archived_at = ?, updated_at = ?
     WHERE id = ?
       AND archived_at IS NULL`
  );
  for (const task of tasks) {
    if (task.id === keepTaskId) continue;
    const result = stmt.run(at, at, task.id);
    archived += result.changes || 0;
  }
  return { archived };
}

function mapAgentLaneRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    agent: row.agent,
    providerKind: row.provider_kind,
    profileId: row.profile_id ?? null,
    profileHome: row.profile_home ?? null,
    projectId: row.project_id,
    taskId: row.task_id,
    mainConversationId: row.main_conversation_id ?? row.mainConversationId ?? null,
    sortOrder: Number(row.sort_order ?? 0),
    autoStart: !!row.auto_start,
    isBuiltin: !!row.is_builtin,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMetadata(value: any) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function listAgentLanesFromDb(db: any) {
  return db
    .prepare(
      `SELECT al.*,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.task_id = al.task_id
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS main_conversation_id
       FROM agent_lanes al
       WHERE al.archived_at IS NULL
       ORDER BY al.sort_order ASC, al.created_at ASC`
    )
    .all()
    .map(mapAgentLaneRow);
}

function getAgentLaneByTaskId(db: any, taskId: any) {
  if (!taskId) return null;
  const row = db
    .prepare(
      `SELECT al.*,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.task_id = al.task_id
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS main_conversation_id
       FROM agent_lanes al
       WHERE al.task_id = ? AND al.archived_at IS NULL
       LIMIT 1`
    )
    .get(taskId);
  return mapAgentLaneRow(row);
}

function getAgentLaneById(db: any, laneId: any) {
  if (!laneId) return null;
  const row = db
    .prepare(
      `SELECT al.*,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.task_id = al.task_id
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS main_conversation_id
       FROM agent_lanes al
       WHERE al.id = ? AND al.archived_at IS NULL
       LIMIT 1`
    )
    .get(laneId);
  return mapAgentLaneRow(row);
}

function nextSortOrder(db: any) {
  const row = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM agent_lanes`).get();
  return Number(row?.next ?? 0);
}

function insertAgentLane(db: any, input: any) {
  const now = input.now || nowIso();
  const row = {
    id: input.id,
    label: normalizeAgentLaneLabel(input.label, 'Agent'),
    agent: String(input.agent || 'hermes').toLowerCase(),
    provider_kind: normalizeAgentLaneProviderKind(input.providerKind || input.provider_kind),
    profile_id: input.profileId ?? input.profile_id ?? null,
    profile_home: input.profileHome ?? input.profile_home ?? null,
    project_id: input.projectId ?? input.project_id,
    task_id: input.taskId ?? input.task_id,
    sort_order: Number.isFinite(input.sortOrder) ? input.sortOrder : nextSortOrder(db),
    auto_start: input.autoStart === false || input.auto_start === 0 ? 0 : 1,
    is_builtin: input.isBuiltin || input.is_builtin ? 1 : 0,
    metadata_json: input.metadataJson ?? input.metadata_json ?? (input.metadata ? JSON.stringify(input.metadata) : null),
    archived_at: null,
    created_at: input.createdAt || input.created_at || now,
    updated_at: input.updatedAt || input.updated_at || now,
  };
  db.prepare(
    `INSERT INTO agent_lanes (
      id, label, agent, provider_kind, profile_id, profile_home, project_id, task_id,
      sort_order, auto_start, is_builtin, metadata_json, archived_at, created_at, updated_at
    ) VALUES (
      @id, @label, @agent, @provider_kind, @profile_id, @profile_home, @project_id, @task_id,
      @sort_order, @auto_start, @is_builtin, @metadata_json, @archived_at, @created_at, @updated_at
    )`
  ).run(row);
  return getAgentLaneById(db, row.id);
}

function updateAgentLaneRefs(db: any, laneId: any, updates: any) {
  const current = db.prepare(`SELECT * FROM agent_lanes WHERE id = ?`).get(laneId);
  if (!current) return null;
  const next = {
    label: normalizeAgentLaneLabel(updates.label ?? current.label, current.label),
    agent: String(updates.agent ?? current.agent).toLowerCase(),
    provider_kind: normalizeAgentLaneProviderKind(updates.providerKind ?? updates.provider_kind ?? current.provider_kind),
    profile_id: updates.profileId ?? updates.profile_id ?? current.profile_id ?? null,
    profile_home: updates.profileHome ?? updates.profile_home ?? current.profile_home ?? null,
    project_id: updates.projectId ?? updates.project_id ?? current.project_id,
    task_id: updates.taskId ?? updates.task_id ?? current.task_id,
    sort_order: Number.isFinite(updates.sortOrder) ? updates.sortOrder : current.sort_order,
    auto_start: updates.autoStart === false || updates.auto_start === 0 ? 0 : (current.auto_start ? 1 : 0),
    is_builtin: updates.isBuiltin || updates.is_builtin || current.is_builtin ? 1 : 0,
    metadata_json: updates.metadataJson ?? updates.metadata_json ?? current.metadata_json ?? null,
    updated_at: updates.updatedAt || updates.updated_at || nowIso(),
    id: laneId,
  };
  db.prepare(
    `UPDATE agent_lanes
     SET label = @label,
         agent = @agent,
         provider_kind = @provider_kind,
         profile_id = @profile_id,
         profile_home = @profile_home,
         project_id = @project_id,
         task_id = @task_id,
         sort_order = @sort_order,
         auto_start = @auto_start,
         is_builtin = @is_builtin,
         metadata_json = @metadata_json,
         updated_at = @updated_at
     WHERE id = @id`
  ).run(next);
  return getAgentLaneById(db, laneId);
}

// Normalize an operator profile (electron/operators.cts shape) into the
// fields lane seeding needs. Default agent stays 'hermes'.
function laneOperatorFields(operator: any, fallbackSortOrder = 0) {
  return {
    id: safeString(operator && operator.id, 'hermes'),
    label: operatorLaneLabel(operator),
    agent: String((operator && operator.agent) || 'hermes').toLowerCase(),
    sortOrder: Number.isFinite(operator && operator.sortOrder)
      ? operator.sortOrder
      : fallbackSortOrder,
  };
}

// Operators driving the builtin lane seed. Lane identity flows exclusively
// from the operator profiles passed by the caller; no operators -> no seed.
function normalizeSeedOperators(operators: any) {
  const list = Array.isArray(operators) ? operators : [];
  return list
    .filter((op: any) => op && safeString(op.id))
    .map((op: any, index: number) => laneOperatorFields(op, index))
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder);
}

function seedBuiltinPersonalAgentLanes(db: any, operators?: any) {
  applyAgentLaneSchema(db);
  const ops = normalizeSeedOperators(operators);
  if (!ops.length) return { inserted: 0, updated: 0 };
  const projects = db
    .prepare(
      `SELECT * FROM projects
       WHERE is_personal = 1
       ORDER BY created_at ASC`
    )
    .all();

  let inserted = 0;
  let updated = 0;
  for (const op of ops) {
    const opIdLower = op.id.toLowerCase();
    for (const project of projects) {
      const identity = String(project.personal_identity || '').trim().toLowerCase();
      if (identity !== opIdLower) continue;
      const task = findMainOrchestratorTaskForProject(db, project.id, op.agent);
      if (!task) continue;
      const laneId = laneIdForOperator(op);
      const label = op.label;
      const now = nowIso();
      const sortOrder = op.sortOrder;
      const existing = db.prepare(`SELECT * FROM agent_lanes WHERE id = ?`).get(laneId);
      if (!existing) {
        insertAgentLane(db, {
          id: laneId,
          label,
          agent: op.agent,
          providerKind: 'builtin-personal',
          projectId: project.id,
          taskId: task.id,
          sortOrder,
          autoStart: true,
          isBuiltin: true,
          // metadata key personalIdentity is KEPT (operator id as value) for
          // DB compatibility with pre-operator builds.
          metadata: { personalIdentity: op.id },
          createdAt: now,
          updatedAt: now,
        });
        inserted += 1;
        continue;
      }
      const needsUpdate =
        existing.label !== label ||
        existing.agent !== op.agent ||
        existing.provider_kind !== 'builtin-personal' ||
        existing.project_id !== project.id ||
        existing.task_id !== task.id ||
        Number(existing.sort_order) !== sortOrder ||
        !existing.auto_start ||
        !existing.is_builtin ||
        existing.archived_at;
      if (needsUpdate) {
        updateAgentLaneRefs(db, laneId, {
          label,
          agent: op.agent,
          providerKind: 'builtin-personal',
          projectId: project.id,
          taskId: task.id,
          sortOrder,
          autoStart: true,
          isBuiltin: true,
          metadataJson: JSON.stringify({ personalIdentity: op.id }),
          archived_at: null,
          updatedAt: now,
        });
        db.prepare(`UPDATE agent_lanes SET archived_at = NULL WHERE id = ?`).run(laneId);
        updated += 1;
      }
    }
  }
  return { inserted, updated };
}

function upsertPersonalAgentLane(db: any, { operator, projectId, taskId, now }: any = {}) {
  applyAgentLaneSchema(db);
  if (!operator || !safeString(operator.id)) return null;
  const op = laneOperatorFields(operator);
  if (!projectId || !taskId) return null;
  const laneId = laneIdForOperator(op);
  const label = op.label;
  const at = now || nowIso();
  const sortOrder = op.sortOrder;
  const existing = db.prepare(`SELECT * FROM agent_lanes WHERE id = ?`).get(laneId);
  if (!existing) {
    return insertAgentLane(db, {
      id: laneId,
      label,
      agent: op.agent,
      providerKind: 'builtin-personal',
      projectId,
      taskId,
      sortOrder,
      autoStart: true,
      isBuiltin: true,
      metadata: { personalIdentity: op.id },
      createdAt: at,
      updatedAt: at,
    });
  }
  db.prepare(`UPDATE agent_lanes SET archived_at = NULL WHERE id = ?`).run(laneId);
  const lane = updateAgentLaneRefs(db, laneId, {
    label,
    agent: op.agent,
    providerKind: 'builtin-personal',
    projectId,
    taskId,
    sortOrder,
    autoStart: true,
    isBuiltin: true,
    metadataJson: JSON.stringify({ personalIdentity: op.id }),
    updatedAt: at,
  });
  return lane;
}

function laneWorkspaceDir(userDataPath: any, label: any) {
  const slug = String(label || 'agent')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
  return path.join(userDataPath, 'agent-lanes', `${slug}-workspace`);
}

function ensureUniqueDir(baseDir: any) {
  if (!fs.existsSync(baseDir)) return baseDir;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseDir}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${baseDir}-${Date.now()}`;
}

module.exports = {
  AGENT_LANE_SCHEMA,
  AGENT_LANE_PROVIDER_KINDS,
  applyAgentLaneSchema,
  archiveDuplicateOrchestratorTasks,
  findMainOrchestratorTaskForProject,
  findOrchestratorTasksForProject,
  getAgentLaneById,
  getAgentLaneByTaskId,
  humanizeProfileId,
  insertAgentLane,
  laneIdForOperator,
  laneWorkspaceDir,
  operatorLaneLabel,
  ensureUniqueDir,
  listAgentLanesFromDb,
  mapAgentLaneRow,
  nextSortOrder,
  normalizeAgentLaneLabel,
  normalizeAgentLaneProviderKind,
  pickMainConversation,
  seedBuiltinPersonalAgentLanes,
  updateAgentLaneRefs,
  upsertPersonalAgentLane,
};
