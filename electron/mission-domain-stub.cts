/**
 * mission-domain-stub.cts — strangler-fig compatibility shim for the retired
 * mission domain.
 *
 * The mission system (the former electron/missions.cts, ~5446 LOC) is deleted in
 * the spine-kernel cutover. The run-ledger spine (electron/run-ledger/*) is the
 * autonomy loop now: an append-only event ledger reconciled into one canonical
 * state and projected into a READ-ONLY board (never a gate). The mission board
 * UI, its 12 IPC handles, and its renderer API are already gone.
 *
 * Two consumers still `require('./missions.cjs')` for a handful of names —
 * electron/local-core.cts (a few reachable readers plus a body of now-inert
 * mission methods whose IPC entry points are removed) and
 * electron/orchestrator-compaction.cts (one resume-packet hook). This module
 * keeps those names resolvable so boot stays green while the inert method
 * bodies await their follow-up excision. It is intentionally tiny.
 *
 * REAL (not inert), because reachable code still calls them:
 *   - ensureMissionSchema — still creates the (now permanently empty) mission_*
 *     tables at DB bootstrap, so any residual raw read inside a not-yet-deleted
 *     mission method returns empty rows rather than crashing on a missing table.
 *   - MISSION_EVENT_TYPES — the real frozen enum, so event-type lookups resolve
 *     to strings instead of undefined.
 *   - projectMissions / projectMissionBoard — readers reached via getState() and
 *     getMissionBoard(); return empty so the board and state projections stay
 *     valid and the integration/ops consumers see "no missions".
 *   - setMissionIdentityConfig — a no-op; mission identity normalization has no
 *     missions to normalize.
 *   - checkpointTaskResumePacket — the orchestrator-compaction resume hook. For
 *     a task with no mission (now every task) the original returned
 *     { persisted: false }; this preserves that exact behavior, so compaction
 *     keeps working, just without a mission resume artifact.
 *
 * INERT (fail-closed throw), because their only callers are mission mutation
 * methods whose IPC handles are removed — they must never run, and if one ever
 * is reached we want a loud, honest error, not a silently half-completed mission
 * operation.
 */

// ---------------------------------------------------------------------------
// Empty-table schema (verbatim from the retired missions.cts) so residual raw
// reads in the inert method bodies hit a real, empty table.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  original_brief TEXT,
  polished_brief TEXT,
  status TEXT NOT NULL,
  mission_dir TEXT NOT NULL,
  orchestrator_agent TEXT NOT NULL,
  worker_agent TEXT NOT NULL,
  validator_agent TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  current_milestone_id TEXT,
  current_feature_id TEXT,
  control_task_id TEXT,
  last_investigation TEXT,
  size_class TEXT,
  realism_score REAL,
  estimated_tokens INTEGER,
  estimated_minutes_min INTEGER,
  estimated_minutes_max INTEGER,
  baseline_metrics TEXT,
  created_by_identity TEXT NOT NULL DEFAULT 'system',
  owner_identity TEXT NOT NULL DEFAULT 'system',
  active_controller_identity TEXT,
  created_by_workspace_id TEXT,
  created_by_task_id TEXT,
  created_by_stream_id TEXT,
  source_context_summary TEXT,
  source_files_json TEXT NOT NULL DEFAULT '[]',
  status_note TEXT,
  next_action TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  completed_at TEXT,
  paused_at TEXT
);
CREATE INDEX IF NOT EXISTS missions_project_idx ON missions(project_id);

CREATE TABLE IF NOT EXISTS mission_milestones (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  scrutiny_status TEXT NOT NULL DEFAULT 'pending',
  user_testing_status TEXT NOT NULL DEFAULT 'pending',
  sealed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mission_milestones_mission_idx ON mission_milestones(mission_id);

CREATE TABLE IF NOT EXISTS mission_features (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  skill_name TEXT NOT NULL DEFAULT 'general',
  role_mode TEXT,
  skill_pack TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  task_pack_skills_json TEXT NOT NULL DEFAULT '[]',
  allow_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  branch TEXT,
  fulfills_assertions TEXT NOT NULL DEFAULT '[]',
  worker_agent TEXT,
  task_id TEXT,
  stream_id TEXT,
  worktree_id TEXT,
  worktree_path TEXT,
  base_branch TEXT,
  remote_base_ref TEXT,
  base_sha TEXT,
  base_hygiene_json TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_head_ref TEXT,
  pr_base_ref TEXT,
  pr_head_sha TEXT,
  pr_base_sha TEXT,
  spawned_by_identity TEXT,
  spawned_by_stream_id TEXT,
  validation_status TEXT,
  validator_agent TEXT,
  validator_task_id TEXT,
  validator_stream_id TEXT,
  validator_worktree_id TEXT,
  validator_worktree_path TEXT,
  validator_branch TEXT,
  validator_spawned_by_identity TEXT,
  validator_spawned_by_stream_id TEXT,
  validation_started_at TEXT,
  validation_completed_at TEXT,
  validation_handoff TEXT,
  gate_status TEXT,
  gate_detail TEXT,
  fixback_attempts INTEGER NOT NULL DEFAULT 0,
  validation_failure_packet_json TEXT,
  validation_attempts_json TEXT NOT NULL DEFAULT '[]',
  last_seen_state TEXT,
  archived_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_handoff TEXT,
  goal_ledger_path TEXT,
  goal_mode TEXT,
  validation_mode TEXT,
  computer_use_required INTEGER NOT NULL DEFAULT 0,
  computer_use_evidence_json TEXT,
  release_goal_spec_path TEXT,
  release_goal_ledger_path TEXT,
  next_allowed_action TEXT,
  cleanup_evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS mission_features_mission_idx ON mission_features(mission_id);

CREATE TABLE IF NOT EXISTS mission_feature_dependencies (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL REFERENCES mission_features(id) ON DELETE CASCADE,
  depends_on_feature_id TEXT NOT NULL REFERENCES mission_features(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, depends_on_feature_id)
);
CREATE INDEX IF NOT EXISTS mission_feature_dependencies_mission_idx
  ON mission_feature_dependencies(mission_id);
CREATE INDEX IF NOT EXISTS mission_feature_dependencies_parent_idx
  ON mission_feature_dependencies(depends_on_feature_id);

CREATE TABLE IF NOT EXISTS mission_assertions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  artifact_type TEXT,
  problem_claim TEXT,
  target TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  expected TEXT,
  evidence_required TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  fulfilled_by_feature_id TEXT,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS mission_assertions_mission_idx ON mission_assertions(mission_id);

CREATE TABLE IF NOT EXISTS mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  feature_id TEXT REFERENCES mission_features(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS mission_events_mission_idx ON mission_events(mission_id);
CREATE INDEX IF NOT EXISTS mission_events_feature_idx ON mission_events(feature_id);

CREATE TABLE IF NOT EXISTS mission_clarifications (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  rationale TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  recommended_option_id TEXT,
  answer_option_id TEXT,
  custom_answer TEXT,
  answered INTEGER NOT NULL DEFAULT 0,
  asked_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS mission_clarifications_mission_idx
  ON mission_clarifications(mission_id);

DROP TABLE IF EXISTS mission_validators;
DROP TABLE IF EXISTS mission_attachments;
DROP TABLE IF EXISTS mission_snapshots;

CREATE TABLE IF NOT EXISTS mission_validators (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  validator_stream_id TEXT,
  validator_agent TEXT,
  verdict TEXT CHECK (verdict IN ('PENDING','PASS','FAIL')),
  report_pr_comment_url TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS mission_validators_mission_idx
  ON mission_validators(mission_id);

CREATE TABLE IF NOT EXISTS mission_pr_links (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  pr_number INTEGER,
  pr_url TEXT,
  branch TEXT,
  head_sha TEXT,
  last_check_status TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS mission_pr_links_mission_idx
  ON mission_pr_links(mission_id);

CREATE TABLE IF NOT EXISTS mission_attachments (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  kind TEXT CHECK (kind IN ('file','image','path-ref')),
  uri TEXT,
  original_name TEXT,
  size_bytes INTEGER,
  added_by TEXT,
  added_at INTEGER
);
CREATE INDEX IF NOT EXISTS mission_attachments_mission_idx
  ON mission_attachments(mission_id);
`;

const NON_DESTRUCTIVE_SCHEMA = SCHEMA.replace(
  `DROP TABLE IF EXISTS mission_validators;
DROP TABLE IF EXISTS mission_attachments;
DROP TABLE IF EXISTS mission_snapshots;

`,
  ''
);

function ensureMissionSchema(db: any, options: any = {}) {
  db.exec(options.preserveAuxiliaryTables ? NON_DESTRUCTIVE_SCHEMA : SCHEMA);
  const add = (cols: any, name: any, ddl: any) => {
    if (!cols.includes(name)) db.exec(ddl);
  };
  const missionCols = db.prepare(`PRAGMA table_info(missions)`).all().map((c: any) => c.name);
  add(missionCols, 'last_investigation', `ALTER TABLE missions ADD COLUMN last_investigation TEXT`);
  add(missionCols, 'auto_chain', `ALTER TABLE missions ADD COLUMN auto_chain INTEGER NOT NULL DEFAULT 0`);
  add(missionCols, 'original_brief', `ALTER TABLE missions ADD COLUMN original_brief TEXT`);
  add(missionCols, 'polished_brief', `ALTER TABLE missions ADD COLUMN polished_brief TEXT`);
  add(missionCols, 'size_class', `ALTER TABLE missions ADD COLUMN size_class TEXT`);
  add(missionCols, 'realism_score', `ALTER TABLE missions ADD COLUMN realism_score REAL`);
  add(missionCols, 'estimated_tokens', `ALTER TABLE missions ADD COLUMN estimated_tokens INTEGER`);
  add(missionCols, 'estimated_minutes_min', `ALTER TABLE missions ADD COLUMN estimated_minutes_min INTEGER`);
  add(missionCols, 'estimated_minutes_max', `ALTER TABLE missions ADD COLUMN estimated_minutes_max INTEGER`);
  add(missionCols, 'baseline_metrics', `ALTER TABLE missions ADD COLUMN baseline_metrics TEXT`);
  add(missionCols, 'created_by_identity', `ALTER TABLE missions ADD COLUMN created_by_identity TEXT NOT NULL DEFAULT 'system'`);
  add(missionCols, 'owner_identity', `ALTER TABLE missions ADD COLUMN owner_identity TEXT NOT NULL DEFAULT 'system'`);
  add(missionCols, 'active_controller_identity', `ALTER TABLE missions ADD COLUMN active_controller_identity TEXT`);
  add(missionCols, 'created_by_workspace_id', `ALTER TABLE missions ADD COLUMN created_by_workspace_id TEXT`);
  add(missionCols, 'created_by_task_id', `ALTER TABLE missions ADD COLUMN created_by_task_id TEXT`);
  add(missionCols, 'created_by_stream_id', `ALTER TABLE missions ADD COLUMN created_by_stream_id TEXT`);
  add(missionCols, 'source_context_summary', `ALTER TABLE missions ADD COLUMN source_context_summary TEXT`);
  add(missionCols, 'source_files_json', `ALTER TABLE missions ADD COLUMN source_files_json TEXT NOT NULL DEFAULT '[]'`);
  add(missionCols, 'status_note', `ALTER TABLE missions ADD COLUMN status_note TEXT`);
  add(missionCols, 'next_action', `ALTER TABLE missions ADD COLUMN next_action TEXT`);
  add(missionCols, 'source', `ALTER TABLE missions ADD COLUMN source TEXT`);
  add(missionCols, 'kanban_task_id', `ALTER TABLE missions ADD COLUMN kanban_task_id TEXT`);
  const featureCols = db.prepare(`PRAGMA table_info(mission_features)`).all().map((c: any) => c.name);
  add(featureCols, 'role_mode', `ALTER TABLE mission_features ADD COLUMN role_mode TEXT`);
  add(featureCols, 'skill_pack', `ALTER TABLE mission_features ADD COLUMN skill_pack TEXT`);
  add(featureCols, 'capabilities_json', `ALTER TABLE mission_features ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'`);
  add(featureCols, 'task_pack_skills_json', `ALTER TABLE mission_features ADD COLUMN task_pack_skills_json TEXT NOT NULL DEFAULT '[]'`);
  add(featureCols, 'allow_paths_json', `ALTER TABLE mission_features ADD COLUMN allow_paths_json TEXT NOT NULL DEFAULT '[]'`);
  add(featureCols, 'task_id', `ALTER TABLE mission_features ADD COLUMN task_id TEXT`);
  add(featureCols, 'stream_id', `ALTER TABLE mission_features ADD COLUMN stream_id TEXT`);
  add(featureCols, 'worktree_id', `ALTER TABLE mission_features ADD COLUMN worktree_id TEXT`);
  add(featureCols, 'worktree_path', `ALTER TABLE mission_features ADD COLUMN worktree_path TEXT`);
  add(featureCols, 'base_branch', `ALTER TABLE mission_features ADD COLUMN base_branch TEXT`);
  add(featureCols, 'remote_base_ref', `ALTER TABLE mission_features ADD COLUMN remote_base_ref TEXT`);
  add(featureCols, 'base_sha', `ALTER TABLE mission_features ADD COLUMN base_sha TEXT`);
  add(featureCols, 'base_hygiene_json', `ALTER TABLE mission_features ADD COLUMN base_hygiene_json TEXT`);
  add(featureCols, 'pr_url', `ALTER TABLE mission_features ADD COLUMN pr_url TEXT`);
  add(featureCols, 'pr_number', `ALTER TABLE mission_features ADD COLUMN pr_number INTEGER`);
  add(featureCols, 'pr_head_ref', `ALTER TABLE mission_features ADD COLUMN pr_head_ref TEXT`);
  add(featureCols, 'pr_base_ref', `ALTER TABLE mission_features ADD COLUMN pr_base_ref TEXT`);
  add(featureCols, 'pr_head_sha', `ALTER TABLE mission_features ADD COLUMN pr_head_sha TEXT`);
  add(featureCols, 'pr_base_sha', `ALTER TABLE mission_features ADD COLUMN pr_base_sha TEXT`);
  add(featureCols, 'spawned_by_identity', `ALTER TABLE mission_features ADD COLUMN spawned_by_identity TEXT`);
  add(featureCols, 'spawned_by_stream_id', `ALTER TABLE mission_features ADD COLUMN spawned_by_stream_id TEXT`);
  add(featureCols, 'validation_status', `ALTER TABLE mission_features ADD COLUMN validation_status TEXT`);
  add(featureCols, 'validator_agent', `ALTER TABLE mission_features ADD COLUMN validator_agent TEXT`);
  add(featureCols, 'board_column_override', `ALTER TABLE mission_features ADD COLUMN board_column_override TEXT`);
  add(featureCols, 'validator_task_id', `ALTER TABLE mission_features ADD COLUMN validator_task_id TEXT`);
  add(featureCols, 'validator_stream_id', `ALTER TABLE mission_features ADD COLUMN validator_stream_id TEXT`);
  add(featureCols, 'validator_worktree_id', `ALTER TABLE mission_features ADD COLUMN validator_worktree_id TEXT`);
  add(featureCols, 'validator_worktree_path', `ALTER TABLE mission_features ADD COLUMN validator_worktree_path TEXT`);
  add(featureCols, 'validator_branch', `ALTER TABLE mission_features ADD COLUMN validator_branch TEXT`);
  add(featureCols, 'validator_spawned_by_identity', `ALTER TABLE mission_features ADD COLUMN validator_spawned_by_identity TEXT`);
  add(featureCols, 'validator_spawned_by_stream_id', `ALTER TABLE mission_features ADD COLUMN validator_spawned_by_stream_id TEXT`);
  add(featureCols, 'validation_started_at', `ALTER TABLE mission_features ADD COLUMN validation_started_at TEXT`);
  add(featureCols, 'validation_completed_at', `ALTER TABLE mission_features ADD COLUMN validation_completed_at TEXT`);
  add(featureCols, 'validation_handoff', `ALTER TABLE mission_features ADD COLUMN validation_handoff TEXT`);
  add(featureCols, 'gate_status', `ALTER TABLE mission_features ADD COLUMN gate_status TEXT`);
  add(featureCols, 'gate_detail', `ALTER TABLE mission_features ADD COLUMN gate_detail TEXT`);
  add(featureCols, 'fixback_attempts', `ALTER TABLE mission_features ADD COLUMN fixback_attempts INTEGER NOT NULL DEFAULT 0`);
  add(featureCols, 'validation_failure_packet_json', `ALTER TABLE mission_features ADD COLUMN validation_failure_packet_json TEXT`);
  add(featureCols, 'validation_attempts_json', `ALTER TABLE mission_features ADD COLUMN validation_attempts_json TEXT NOT NULL DEFAULT '[]'`);
  add(featureCols, 'last_seen_state', `ALTER TABLE mission_features ADD COLUMN last_seen_state TEXT`);
  add(featureCols, 'archived_at', `ALTER TABLE mission_features ADD COLUMN archived_at TEXT`);
  add(featureCols, 'goal_ledger_path', `ALTER TABLE mission_features ADD COLUMN goal_ledger_path TEXT`);
  add(featureCols, 'goal_mode', `ALTER TABLE mission_features ADD COLUMN goal_mode TEXT`);
  add(featureCols, 'validation_mode', `ALTER TABLE mission_features ADD COLUMN validation_mode TEXT`);
  add(featureCols, 'computer_use_required', `ALTER TABLE mission_features ADD COLUMN computer_use_required INTEGER NOT NULL DEFAULT 0`);
  add(featureCols, 'computer_use_evidence_json', `ALTER TABLE mission_features ADD COLUMN computer_use_evidence_json TEXT`);
  add(featureCols, 'release_goal_spec_path', `ALTER TABLE mission_features ADD COLUMN release_goal_spec_path TEXT`);
  add(featureCols, 'release_goal_ledger_path', `ALTER TABLE mission_features ADD COLUMN release_goal_ledger_path TEXT`);
  add(featureCols, 'release_task_id', `ALTER TABLE mission_features ADD COLUMN release_task_id TEXT`);
  add(featureCols, 'release_stream_id', `ALTER TABLE mission_features ADD COLUMN release_stream_id TEXT`);
  add(featureCols, 'next_allowed_action', `ALTER TABLE mission_features ADD COLUMN next_allowed_action TEXT`);
  add(featureCols, 'cleanup_evidence_json', `ALTER TABLE mission_features ADD COLUMN cleanup_evidence_json TEXT`);
  add(featureCols, 'stale_reason', `ALTER TABLE mission_features ADD COLUMN stale_reason TEXT`);
  add(featureCols, 'stale_at', `ALTER TABLE mission_features ADD COLUMN stale_at TEXT`);
  const assertionCols = db.prepare(`PRAGMA table_info(mission_assertions)`).all().map((c: any) => c.name);
  add(assertionCols, 'artifact_type', `ALTER TABLE mission_assertions ADD COLUMN artifact_type TEXT`);
  add(assertionCols, 'problem_claim', `ALTER TABLE mission_assertions ADD COLUMN problem_claim TEXT`);
  add(assertionCols, 'target', `ALTER TABLE mission_assertions ADD COLUMN target TEXT`);
  add(assertionCols, 'steps_json', `ALTER TABLE mission_assertions ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'`);
  add(assertionCols, 'expected', `ALTER TABLE mission_assertions ADD COLUMN expected TEXT`);
  add(assertionCols, 'evidence_required', `ALTER TABLE mission_assertions ADD COLUMN evidence_required TEXT`);
  add(assertionCols, 'owner', `ALTER TABLE mission_assertions ADD COLUMN owner TEXT`);
  const eventCols = db.prepare(`PRAGMA table_info(mission_events)`).all().map((c: any) => c.name);
  add(eventCols, 'feature_id', `ALTER TABLE mission_events ADD COLUMN feature_id TEXT`);
  add(eventCols, 'payload_json', `ALTER TABLE mission_events ADD COLUMN payload_json TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_events_feature_idx ON mission_events(feature_id)`);
}

// ---------------------------------------------------------------------------
// Real frozen enum (verbatim) — referenced by the inert method bodies.
// ---------------------------------------------------------------------------

const MISSION_EVENT_TYPES = Object.freeze({
  CREATED: 'created',
  PLAN_PROPOSED: 'plan_proposed',
  PLAN_APPROVED: 'plan_approved',
  WORKER_STARTED: 'feature_started',
  WORKER_DISPATCHED: 'feature_dispatched',
  WORKER_STREAM_ATTACHED: 'worker.stream.attached',
  WORKER_STREAM_RECOVERED: 'worker.stream.recovered',
  CHILD_COMPLETION_RECORDED: 'child_completion_recorded',
  WORKER_COMPLETED: 'feature_completed',
  WORKER_FAILED: 'feature_failed',
  WORKER_ARCHIVED: 'feature_archived',
  WAVE_DISPATCHED: 'wave_dispatched',
  VALIDATOR_DISPATCHED: 'validator_dispatched',
  VALIDATOR_STREAM_ATTACHED: 'validator.stream.attached',
  VALIDATOR_STREAM_RECOVERED: 'validator.stream.recovered',
  VALIDATOR_PASSED: 'validator_passed',
  VALIDATOR_FAILED: 'validator_failed',
  VALIDATION_RERUN: 'validation_rerun',
  PR_LINKED: 'pr_linked',
  PR_GATE_READY: 'pr_gate_ready',
  PR_GATE_BLOCKED: 'pr_gate_blocked',
  FIXBACK_RECORDED: 'fixback_recorded',
  FIXBACK_BLOCKED: 'fixback_blocked',
  BUDGET_WARNING: 'budget_warning',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  RELEASE_GATE_PASSED: 'release_gate_passed',
  RELEASE_GATE_BLOCKED: 'release_gate_blocked',
  RELEASE_DISPATCHED: 'release_dispatched',
  RELEASE_COMPLETED: 'release_completed',
  RELEASE_BLOCKED: 'release_blocked',
  RELEASE_PUBLISHED: 'release_published',
  RELEASE_FAILED: 'release_failed',
  MILESTONE_SEALED: 'milestone_sealed',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  NOTE: 'note',
  GOAL_LEDGER_CREATED: 'goal_ledger_created',
  GOAL_LEDGER_CHECKPOINT: 'goal_ledger_checkpoint',
});

// ---------------------------------------------------------------------------
// Inert readers — reachable via getState()/getMissionBoard(); always empty.
// ---------------------------------------------------------------------------

function projectMissions(_db?: any): any[] {
  return [];
}

function projectMissionBoard(_missions?: any, _options?: any) {
  return { missions: [], columns: [], cards: [], lanes: [], generatedAt: null };
}

// Mission identity normalization has no missions to normalize.
function setMissionIdentityConfig(_config?: any) {}

// Orchestrator-compaction resume hook. For a task with no mission (now every
// task) the retired implementation returned { persisted: false }; preserve it
// so compaction keeps running without a mission resume artifact.
function checkpointTaskResumePacket(_db?: any, _input?: any) {
  return { packet: null, artifactPath: null, persisted: false };
}

module.exports = {
  MISSION_EVENT_TYPES,
  ensureMissionSchema,
  projectMissions,
  projectMissionBoard,
  setMissionIdentityConfig,
  checkpointTaskResumePacket,
};
