const fs = require('fs');
const os = require('os');
const path = require('path');

function stripYamlValue(value: any) {
  return String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim() || null;
}

function parseHermesConfigSummary(configText: any) {
  const out: { modelProvider: string | null; modelName: string | null; terminalCwd: string | null } = {
    modelProvider: null,
    modelName: null,
    terminalCwd: null,
  };
  let section = null;
  for (const rawLine of String(configText || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;
    const top = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(noComment);
    if (top && !/^\s/.test(noComment)) {
      section = top[1];
      continue;
    }
    const nested = /^\s+(\w[\w-]*)\s*:\s*(.*)$/.exec(noComment);
    if (!nested) continue;
    const key = nested[1];
    const value = stripYamlValue(nested[2]);
    if (!value) continue;
    if (section === 'model' && (key === 'provider' || key === 'vendor')) out.modelProvider = value;
    if (section === 'model' && (key === 'default' || key === 'name' || key === 'model')) out.modelName = value;
    if (section === 'terminal' && key === 'cwd') out.terminalCwd = value;
  }
  return out;
}

function humanizeProfileId(id: any) {
  const raw = String(id || '').trim();
  if (!raw) return 'Hermes';
  if (raw === 'default') return 'Hermes Default';
  return raw
    .replace(/^ace-session:/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function profileCard({ id, label, homePath, configPath, launchable, ...extra }: any) {
  let text = '';
  try {
    if (configPath && fs.existsSync(configPath)) text = fs.readFileSync(configPath, 'utf8');
  } catch {
    text = '';
  }
  const summary = parseHermesConfigSummary(text);
  return {
    id,
    label: label || humanizeProfileId(id),
    homePath,
    configPath,
    modelProvider: summary.modelProvider,
    modelName: summary.modelName,
    terminalCwd: summary.terminalCwd,
    launchable: !!launchable,
    ...extra,
  };
}

function tryLoadDatabase() {
  try {
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

function safeLower(value: any) {
  return String(value || '').trim().toLowerCase();
}

function dedupeById(profiles: any) {
  const seen = new Set();
  const out = [];
  for (const profile of profiles) {
    if (!profile?.id || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

function aceUserDataCandidatePaths(currentUserDataPath: any) {
  const candidates: string[] = [];
  const add = (value: any) => {
    const dir = String(value || '').trim();
    if (!dir || candidates.includes(dir)) return;
    candidates.push(dir);
  };
  if (currentUserDataPath) {
    const parent = path.dirname(currentUserDataPath);
    const stable = path.join(parent, 'Ace');
    if (path.resolve(stable) !== path.resolve(currentUserDataPath)) add(stable);
  }
  return candidates.filter((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
}

// Current hardcoded owner identities, kept as the fallback so configs (or
// installs) lacking these operators behave exactly like today.
function legacyAceSessionOperators() {
  return [
    { id: 'rook', label: 'Rook', sortOrder: 0 },
    { id: 'king', label: 'King', sortOrder: 1 },
  ];
}

// READ-ONLY view of <userDataPath>/operators.json (electron/operators.cts).
// Never triggers the operators migration or any write — this function may be
// pointed at OTHER installs' userData directories. Config operators come
// first (by their sortOrder); the legacy rook/king entries are appended as
// fallback when the config lacks them.
function aceSessionOperators(userDataPath: any) {
  const ops: { id: string; label: string | null; sortOrder: number }[] = [];
  try {
    const operatorsLib = require('./operators.cts');
    const loaded = operatorsLib.loadOperatorsConfig(userDataPath);
    for (const op of loaded?.config?.operators || []) {
      const id = safeLower(op?.id);
      if (!id || ops.some((existing) => existing.id === id)) continue;
      ops.push({
        id,
        label: String(op?.label || '').trim() || null,
        sortOrder: Number.isFinite(op?.sortOrder) ? op.sortOrder : ops.length,
      });
    }
  } catch {
    // Unreadable/invalid config: the legacy fallback below keeps today's
    // behavior for owner-shaped databases.
  }
  for (const fallback of legacyAceSessionOperators()) {
    if (!ops.some((existing) => existing.id === fallback.id)) ops.push(fallback);
  }
  return ops;
}

function readRowsFromAgentLanes(db: any) {
  try {
    return db.prepare(
      `SELECT l.id AS lane_id,
              l.label AS lane_label,
              l.provider_kind,
              l.profile_id,
              l.profile_home,
              l.sort_order,
              p.id AS project_id,
              p.name AS project_name,
              p.path AS project_path,
              p.personal_identity,
              t.id AS task_id,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.task_id = t.id AND LOWER(c.agent) = 'hermes'
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS conversation_id,
              (
                SELECT c.title
                FROM conversations c
                WHERE c.task_id = t.id AND LOWER(c.agent) = 'hermes'
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS conversation_title
       FROM agent_lanes l
       JOIN projects p ON p.id = l.project_id
       JOIN tasks t ON t.id = l.task_id
       WHERE l.archived_at IS NULL
         AND LOWER(l.agent) = 'hermes'
       ORDER BY l.sort_order ASC, l.created_at ASC`
    ).all();
  } catch {
    return [];
  }
}

function readRowsFromPersonalProjects(db: any, operators: any) {
  const ids = (Array.isArray(operators) ? operators : []).map((op: any) => String(op.id));
  if (!ids.length) return [];
  // Identity filter + sort rank are driven by the operator config. For the
  // legacy rook/king fallback this expands to the exact historical SQL:
  // IN ('rook', 'king') with CASE rook->0, king->1, ELSE 50.
  const idPlaceholders = ids.map(() => '?').join(', ');
  const rankCase = ids.map(() => 'WHEN ? THEN ?').join(' ');
  const rankParams: any[] = [];
  for (const op of operators) {
    rankParams.push(String(op.id), Number.isFinite(op.sortOrder) ? op.sortOrder : 50);
  }
  try {
    return db.prepare(
      `SELECT NULL AS lane_id,
              COALESCE(NULLIF(p.name, ''), p.personal_identity, 'Hermes') AS lane_label,
              'builtin-personal' AS provider_kind,
              NULL AS profile_id,
              NULL AS profile_home,
              CASE LOWER(COALESCE(p.personal_identity, '')) ${rankCase} ELSE 50 END AS sort_order,
              p.id AS project_id,
              p.name AS project_name,
              p.path AS project_path,
              p.personal_identity,
              t.id AS task_id,
              (
                SELECT c.id
                FROM conversations c
                WHERE c.task_id = t.id AND LOWER(c.agent) = 'hermes'
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS conversation_id,
              (
                SELECT c.title
                FROM conversations c
                WHERE c.task_id = t.id AND LOWER(c.agent) = 'hermes'
                ORDER BY c.is_main DESC, c.display_order ASC, c.created_at ASC
                LIMIT 1
              ) AS conversation_title
       FROM projects p
       JOIN tasks t ON t.project_id = p.id
       WHERE p.is_personal = 1
         AND LOWER(COALESCE(p.personal_identity, '')) IN (${idPlaceholders})
         AND t.archived_at IS NULL
         AND LOWER(t.primary_agent) = 'hermes'
       ORDER BY sort_order ASC, t.created_at ASC`
    ).all(...rankParams, ...ids);
  } catch {
    return [];
  }
}

function homeForAceSession(row: any, userDataPath: any) {
  const explicit = String(row.profile_home || '').trim();
  if (explicit) return explicit;
  const projectHome = path.join(userDataPath, `hermes-home-${row.project_id}`);
  try {
    if (fs.existsSync(projectHome)) return projectHome;
  } catch {}
  return path.join(userDataPath, 'hermes-home');
}

function idForAceSession(row: any, operatorsById: any) {
  const identity = safeLower(row.personal_identity);
  if (identity && operatorsById?.has?.(identity)) return `ace-session:${identity}`;
  const source = row.lane_id || row.conversation_id || row.task_id || row.project_id;
  return `ace-session:${String(source || 'hermes').replace(/[^\w.-]+/g, '-')}`;
}

function labelForAceSession(row: any, operatorsById: any) {
  const identity = safeLower(row.personal_identity);
  const operator = identity ? operatorsById?.get?.(identity) : null;
  if (operator && operator.label) return operator.label;
  return String(row.lane_label || row.conversation_title || row.project_name || 'Hermes Session').trim();
}

function listAceSessionProfilesFromUserData(userDataPath: any, options: any = {}) {
  const dbPath = path.join(userDataPath || '', 'ace.db');
  if (!userDataPath || !fs.existsSync(dbPath)) return [];
  const Database = tryLoadDatabase();
  if (!Database) return [];
  const operators = aceSessionOperators(userDataPath);
  const operatorsById = new Map(operators.map((op) => [op.id, op]));
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = readRowsFromAgentLanes(db);
    const fallbackRows = rows.length ? [] : readRowsFromPersonalProjects(db, operators);
    return [...rows, ...fallbackRows]
      .filter((row) => row && row.task_id)
      .map((row) => {
        const homePath = homeForAceSession(row, userDataPath);
        const configPath = path.join(homePath, 'config.yaml');
        return profileCard({
          id: idForAceSession(row, operatorsById),
          label: labelForAceSession(row, operatorsById),
          homePath,
          configPath,
          launchable: !!options.hermesLaunchable,
          source: 'ace-session',
          aceUserDataPath: userDataPath,
          providerKind: row.provider_kind || 'builtin-personal',
          laneId: row.lane_id ?? null,
          projectId: row.project_id ?? null,
          taskId: row.task_id ?? null,
          conversationId: row.conversation_id ?? null,
        });
      });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function listHermesProfilesFromHome(homeDir = os.homedir(), options: any = {}) {
  const hermesRoot = path.join(homeDir, '.hermes');
  const launchable = !!options.hermesLaunchable;
  const profiles = [];
  const defaultConfig = path.join(hermesRoot, 'config.yaml');
  try {
    if (fs.existsSync(defaultConfig)) {
      profiles.push(profileCard({
        id: 'default',
        label: 'Hermes Default',
        homePath: hermesRoot,
        configPath: defaultConfig,
        launchable,
        source: 'hermes-home',
      }));
    }
  } catch {}

  const profilesRoot = path.join(hermesRoot, 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const homePath = path.join(profilesRoot, entry.name);
    const configPath = path.join(homePath, 'config.yaml');
    try {
      if (!fs.existsSync(configPath)) continue;
      profiles.push(profileCard({
        id: entry.name,
        label: undefined,
        homePath,
        configPath,
        launchable,
        source: 'hermes-profile',
      }));
    } catch {
      // Malformed/inaccessible profile dirs should not break the Add dialog.
    }
  }

  const aceUserDataPaths = Array.isArray(options.aceUserDataPaths)
    ? options.aceUserDataPaths
    : [];
  for (const userDataPath of aceUserDataPaths) {
    profiles.push(...listAceSessionProfilesFromUserData(userDataPath, { hermesLaunchable: launchable }));
  }

  return dedupeById(profiles);
}

module.exports = {
  aceSessionOperators,
  aceUserDataCandidatePaths,
  humanizeProfileId,
  listAceSessionProfilesFromUserData,
  listHermesProfilesFromHome,
  parseHermesConfigSummary,
};
