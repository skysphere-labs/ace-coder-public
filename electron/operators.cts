// operators.cts — operator-profile config layer.
//
// Shipped defaults are neutral; the owner's existing Rook/King personal agents
// persist as local config in <userDataPath>/operators.json. Persistence of the
// owner's agents is the #1 priority of this layer: the hardened migration only
// ever derives profiles from the live ace.db and the live effective
// hermes config — it never invents values.
//
// Single-writer rule: migrateOperatorsConfig() is the ONLY code path allowed
// to create or rewrite operators.json on its own initiative.
// loadOperatorsConfig() is strictly read-only so an early read can never mask
// a later-restored database.

const fs = require('fs');
const path = require('path');
const hermesHomeLib = require('./hermes-home.cts');

export type OperatorChatGerunds = {
  default: string;
  pairs: { emoji: string; verb: string }[];
};

export type OperatorChatCopy = {
  placeholder?: string;
  busyRow?: string;
  busyPlaceholder?: string;
  gerunds?: OperatorChatGerunds;
};

export type OperatorProviderKind =
  | 'builtin-personal'
  | 'native-orchestrator'
  | 'hermes-profile';

export type OperatorProfile = {
  id: string;
  label: string;
  emoji: string | null;
  agent: string;
  providerKind: OperatorProviderKind;
  isControlPlane: boolean;
  autoStart: boolean;
  sortOrder: number;
  workspaceDirName: string;
  terminalDirName: string;
  hermesHome: string | null;
  legacyAuthDirs: string[];
  memoryDbPath: string | null;
  personaPath: string | null;
  persona: string | null;
  chat: OperatorChatCopy | null;
  ownerTitle: string;
};

export type OperatorsConfig = {
  schema: 'ace.operators.v1';
  defaultOperatorId: string;
  operators: OperatorProfile[];
  migratedFrom?: string;
};

export type OperatorsLoadResult = {
  config: OperatorsConfig;
  source: 'file' | 'bak' | 'default';
};

export type OperatorsMigrateResult = {
  config: OperatorsConfig;
  source: 'existing' | 'no-db' | 'db-error' | 'fresh-v1' | 'rook-king-v1';
  wrote: boolean;
};

const OPERATORS_SCHEMA = 'ace.operators.v1';
const OPERATORS_FILE = 'operators.json';
const OPERATORS_BAK_FILE = 'operators.json.bak';

// A neutral fallback for migrated profiles with no existing persona file.
// Existing user-authored persona files are preserved by the migration below.
const LEGACY_KING_PERSONA = [
  'You are king.',
  'You are a persistent AI operator for this ACE CODER workspace.',
  'Use the user-provided project instructions and verified local records.',
  'Keep private data and credentials out of shared artifacts.',
  'Ask before destructive actions and report evidence for completed work.',
].join('\n') + '\n';

const ROOK_CHAT: OperatorChatCopy = {
  placeholder: 'Message Rook',
  busyRow: '♜ Rook is fortifying the lines…',
  busyPlaceholder: '♜ Rook is combating threats from the fortress… Esc interrupts',
  gerunds: {
    default: '♜',
    pairs: [
      { emoji: '🏰', verb: 'Fortifying' },
      { emoji: '🔭', verb: 'Surveying' },
      { emoji: '📐', verb: 'Drafting' },
      { emoji: '🛡️', verb: 'Defending' },
      { emoji: '🔍', verb: 'Tracing' },
      { emoji: '🗺️', verb: 'Sketching' },
      { emoji: '🧱', verb: 'Building' },
      { emoji: '🌀', verb: 'Reasoning' },
    ],
  },
};

const KING_CHAT: OperatorChatCopy = {
  placeholder: 'Message King',
  busyRow: '♔ King is calculating the position…',
  busyPlaceholder: '♔ King is strategizing the next move… Esc interrupts',
  gerunds: {
    default: '♔',
    pairs: [
      { emoji: '👑', verb: 'Calculating' },
      { emoji: '⚖️', verb: 'Weighing' },
      { emoji: '🧭', verb: 'Foreseeing' },
      { emoji: '🎯', verb: 'Targeting' },
      { emoji: '🎼', verb: 'Composing' },
      { emoji: '♟️', verb: 'Maneuvering' },
      { emoji: '📜', verb: 'Reconciling' },
      { emoji: '⚜️', verb: 'Strategizing' },
    ],
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function neutralOperator(): OperatorProfile {
  return {
    id: 'hermes',
    label: 'Hermes',
    emoji: null,
    agent: 'hermes',
    providerKind: 'builtin-personal',
    isControlPlane: true,
    autoStart: true,
    sortOrder: 0,
    workspaceDirName: 'personal-workspace',
    terminalDirName: 'personal-hermes',
    hermesHome: null,
    legacyAuthDirs: [],
    memoryDbPath: null,
    personaPath: null,
    persona: null,
    chat: null,
    ownerTitle: 'the owner',
  };
}

const DEFAULT_OPERATORS: OperatorProfile[] = [neutralOperator()];

function defaultOperatorsConfig(): OperatorsConfig {
  return {
    schema: OPERATORS_SCHEMA,
    defaultOperatorId: 'hermes',
    operators: [neutralOperator()],
  };
}

// Returns a list of problems; empty array means the config is valid.
function validateOperatorsConfig(value: any): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['config must be an object'];
  }
  if (value.schema !== OPERATORS_SCHEMA) {
    problems.push(`schema must be '${OPERATORS_SCHEMA}'`);
  }
  if (!Array.isArray(value.operators) || value.operators.length === 0) {
    problems.push('operators must be a non-empty array');
    return problems;
  }
  const ids = new Set<string>();
  for (const op of value.operators) {
    if (!op || typeof op !== 'object') {
      problems.push('every operator must be an object');
      continue;
    }
    if (typeof op.id !== 'string' || !op.id.trim()) {
      problems.push('every operator needs a non-empty string id');
      continue;
    }
    if (ids.has(op.id)) problems.push(`duplicate operator id '${op.id}'`);
    ids.add(op.id);
    if (typeof op.label !== 'string') problems.push(`operator '${op.id}' needs a string label`);
    if (typeof op.workspaceDirName !== 'string' || !op.workspaceDirName) {
      problems.push(`operator '${op.id}' needs a workspaceDirName`);
    }
    if (typeof op.terminalDirName !== 'string' || !op.terminalDirName) {
      problems.push(`operator '${op.id}' needs a terminalDirName`);
    }
  }
  if (typeof value.defaultOperatorId !== 'string' || !ids.has(value.defaultOperatorId)) {
    problems.push('defaultOperatorId must match an operator id');
  }
  return problems;
}

function readConfigFile(filePath: string, fsImpl: any): OperatorsConfig | null {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (validateOperatorsConfig(parsed).length > 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

// READ-ONLY. Never writes anything, so calling it early can never mask a
// later-restored ace.db from the migration.
function loadOperatorsConfig(userDataPath: string, fsImpl: any = fs): OperatorsLoadResult {
  const filePath = path.join(userDataPath, OPERATORS_FILE);
  if (!fsImpl.existsSync(filePath)) {
    return { config: defaultOperatorsConfig(), source: 'default' };
  }
  const main = readConfigFile(filePath, fsImpl);
  if (main) return { config: main, source: 'file' };
  const bak = readConfigFile(path.join(userDataPath, OPERATORS_BAK_FILE), fsImpl);
  if (bak) return { config: bak, source: 'bak' };
  return { config: defaultOperatorsConfig(), source: 'default' };
}

function saveOperatorsConfig(userDataPath: string, config: OperatorsConfig, fsImpl: any = fs) {
  const problems = validateOperatorsConfig(config);
  if (problems.length > 0) {
    throw new Error(`refusing to save invalid operators config: ${problems.join('; ')}`);
  }
  const filePath = path.join(userDataPath, OPERATORS_FILE);
  // Back up the current file first, but only when it is parseable JSON —
  // never clobber a good .bak with corrupt bytes.
  try {
    if (fsImpl.existsSync(filePath)) {
      JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      fsImpl.copyFileSync(filePath, path.join(userDataPath, OPERATORS_BAK_FILE));
    }
  } catch {
    // Current file unparseable: leave any existing .bak alone.
  }
  const tmpPath = path.join(
    userDataPath,
    `${OPERATORS_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    fsImpl.mkdirSync(userDataPath, { recursive: true });
    fsImpl.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fsImpl.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

// Lazy on purpose: better-sqlite3 is a native module and must never load at
// module import time (mirrors scripts/migrate-ace-external-data.cts).
function defaultDbOpener(dbPath: string) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true });
}

// Read the EFFECTIVE hermes-memory-store db_path for an identity project from
// <userDataPath>/hermes-home-<projectId>/config.yaml via an indentation-aware
// line scan (no YAML dependency). The live effective value may be a shared
// ace-default db — NEVER invent per-identity paths, or a migrated profile
// could cut the agent off from its memories.
function effectiveMemoryDbPath(userDataPath: string, projectId: string, fsImpl: any = fs): string | null {
  try {
    const configPath = path.join(
      hermesHomeLib.workspaceHermesHome(userDataPath, projectId),
      'config.yaml'
    );
    if (!fsImpl.existsSync(configPath)) return null;
    const lines = String(fsImpl.readFileSync(configPath, 'utf8')).split(/\r?\n/);
    let pluginIndent: number | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const indent = line.length - line.trimStart().length;
      if (pluginIndent !== null && indent <= pluginIndent) pluginIndent = null;
      if (pluginIndent === null) {
        if (/^hermes-memory-store:\s*$/.test(trimmed)) pluginIndent = indent;
        continue;
      }
      const match = trimmed.match(/^db_path:\s*(.+?)\s*$/);
      if (!match) continue;
      let value = match[1];
      if (
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (value && fsImpl.existsSync(value)) return value;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function legacyOwnerOperator(
  identity: 'rook' | 'king',
  userDataPath: string,
  projectId: string,
  fsImpl: any
): OperatorProfile {
  const shared = {
    agent: 'hermes',
    providerKind: 'builtin-personal' as const,
    isControlPlane: true,
    autoStart: true,
    hermesHome: null,
    persona: null,
    memoryDbPath: effectiveMemoryDbPath(userDataPath, projectId, fsImpl),
    ownerTitle: 'Chief',
  };
  if (identity === 'rook') {
    // Rook has NO Ace-written soul today; persona/personaPath stay null
    // and downstream code must never write any SOUL.md for it.
    return {
      ...shared,
      id: 'rook',
      label: 'Rook',
      emoji: '♜',
      sortOrder: 0,
      workspaceDirName: 'personal-workspace',
      terminalDirName: 'personal-hermes',
      legacyAuthDirs: ['hermes-home-personal-hermes'],
      personaPath: null,
      chat: clone(ROOK_CHAT),
    };
  }
  return {
    ...shared,
    id: 'king',
    label: 'King',
    emoji: '♔',
    sortOrder: 1,
    workspaceDirName: 'king-workspace',
    terminalDirName: 'king-hermes',
    legacyAuthDirs: ['hermes-home-king-hermes'],
    personaPath: path.join(userDataPath, 'operators', 'king', 'SOUL.md'),
    chat: clone(KING_CHAT),
  };
}

// THE single writer of operators.json. Hardened rules:
//  1. operators.json exists -> load and return; never rewrite.
//  2. no ace.db -> defaults in memory only, write NOTHING (retry next
//     boot; writing here would mask a later-restored db).
//  3. db open/read failure -> warn, defaults in memory, write NOTHING.
//  4. rook/king personal rows ('lane:%' identities excluded by the query)
//     -> owner config with the exact legacy values, saved once.
//  5. db present but no rook/king rows -> neutral defaults saved (fresh-v1).
function migrateOperatorsConfig(
  userDataPath: string,
  opts: { dbOpener?: (dbPath: string) => any; fsImpl?: any } = {}
): OperatorsMigrateResult {
  const fsImpl = opts.fsImpl || fs;
  if (fsImpl.existsSync(path.join(userDataPath, OPERATORS_FILE))) {
    const loaded = loadOperatorsConfig(userDataPath, fsImpl);
    return { config: loaded.config, source: 'existing', wrote: false };
  }
  const dbPath = path.join(userDataPath, 'ace.db');
  if (!fsImpl.existsSync(dbPath)) {
    return { config: defaultOperatorsConfig(), source: 'no-db', wrote: false };
  }

  let rows: { id: string; personal_identity: string }[] = [];
  let db: any = null;
  try {
    db = (opts.dbOpener || defaultDbOpener)(dbPath);
    rows = db
      .prepare(
        `SELECT id, personal_identity FROM projects
         WHERE is_personal = 1
           AND LOWER(COALESCE(personal_identity, '')) IN ('rook', 'king')`
      )
      .all();
  } catch (err: any) {
    console.warn(
      '[ace] operators migration: db read failed, retrying next boot:',
      err?.message || err
    );
    return { config: defaultOperatorsConfig(), source: 'db-error', wrote: false };
  } finally {
    try { db?.close?.(); } catch { /* best effort */ }
  }

  const projectIdByIdentity: Record<string, string> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = String(row?.personal_identity || '').trim().toLowerCase();
    // The SQL filter already excludes 'lane:%' and unknown identities; keep
    // this defensive so a fake/changed opener can never leak them in.
    if (identity !== 'rook' && identity !== 'king') continue;
    if (!(identity in projectIdByIdentity)) projectIdByIdentity[identity] = String(row.id);
  }

  if (!projectIdByIdentity.rook && !projectIdByIdentity.king) {
    const config: OperatorsConfig = { ...defaultOperatorsConfig(), migratedFrom: 'fresh-v1' };
    saveOperatorsConfig(userDataPath, config, fsImpl);
    return { config, source: 'fresh-v1', wrote: true };
  }

  const operators: OperatorProfile[] = [];
  if (projectIdByIdentity.rook) {
    operators.push(legacyOwnerOperator('rook', userDataPath, projectIdByIdentity.rook, fsImpl));
  }
  if (projectIdByIdentity.king) {
    const king = legacyOwnerOperator('king', userDataPath, projectIdByIdentity.king, fsImpl);
    operators.push(king);
    // Materialize the legacy persona exactly once; an existing SOUL.md is
    // user data and stays untouched.
    if (king.personaPath && !fsImpl.existsSync(king.personaPath)) {
      fsImpl.mkdirSync(path.dirname(king.personaPath), { recursive: true });
      fsImpl.writeFileSync(king.personaPath, LEGACY_KING_PERSONA);
    }
  }
  const config: OperatorsConfig = {
    schema: OPERATORS_SCHEMA,
    defaultOperatorId: operators[0].id,
    operators,
    migratedFrom: 'rook-king-v1',
  };
  saveOperatorsConfig(userDataPath, config, fsImpl);
  return { config, source: 'rook-king-v1', wrote: true };
}

// personaPath -> file contents (null when unreadable/missing); else the
// inline persona string; else undefined (operator has no persona at all).
function loadPersonaPrompt(
  operator: OperatorProfile | null | undefined,
  fsImpl: any = fs
): string | null | undefined {
  if (!operator) return undefined;
  if (operator.personaPath) {
    try {
      return String(fsImpl.readFileSync(operator.personaPath, 'utf8'));
    } catch {
      return null;
    }
  }
  if (typeof operator.persona === 'string' && operator.persona) return operator.persona;
  return undefined;
}

function getOperator(config: OperatorsConfig, id: string): OperatorProfile | null {
  return config.operators.find((op) => op.id === id) || null;
}

function listControlPlaneOperators(config: OperatorsConfig): OperatorProfile[] {
  return config.operators
    .filter((op) => op.isControlPlane)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// Case-insensitive match -> canonical id; unknown/empty -> defaultOperatorId.
// Agent-lane identities ('lane:...') are not operators: passed through as-is.
function normalizeOperatorId(config: OperatorsConfig, value: any): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.startsWith('lane:')) return raw;
  const lowered = raw.trim().toLowerCase();
  if (lowered) {
    for (const op of config.operators) {
      if (op.id.toLowerCase() === lowered) return op.id;
    }
  }
  return config.defaultOperatorId;
}

function operatorForProject(config: OperatorsConfig, projectRow: any): OperatorProfile | null {
  const raw = String(projectRow?.personal_identity || '').trim();
  if (!raw || raw.startsWith('lane:')) return null;
  const lowered = raw.toLowerCase();
  return config.operators.find((op) => op.id.toLowerCase() === lowered) || null;
}

// Pure: which db identities have no operator profile? (Feeds a future loud
// boot warning; 'lane:' values are not operators and are ignored.)
function checkDbConfigConsistency(identities: string[], config: OperatorsConfig): string[] {
  const known = new Set(config.operators.map((op) => op.id.toLowerCase()));
  const missing: string[] = [];
  for (const raw of Array.isArray(identities) ? identities : []) {
    const id = String(raw || '').trim().toLowerCase();
    if (!id || id.startsWith('lane:')) continue;
    if (known.has(id) || missing.includes(id)) continue;
    missing.push(id);
  }
  return missing;
}

module.exports = {
  OPERATORS_SCHEMA,
  OPERATORS_FILE,
  LEGACY_KING_PERSONA,
  DEFAULT_OPERATORS,
  defaultOperatorsConfig,
  validateOperatorsConfig,
  loadOperatorsConfig,
  saveOperatorsConfig,
  migrateOperatorsConfig,
  effectiveMemoryDbPath,
  loadPersonaPrompt,
  getOperator,
  listControlPlaneOperators,
  normalizeOperatorId,
  operatorForProject,
  checkDbConfigConsistency,
};
