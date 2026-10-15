// Per-workspace HERMES_HOME management.
//
// Context: ~/.hermes (or Ace's bundled <userData>/hermes-home/) is a
// shared directory with config, auth, skills AND a SQLite state.db holding
// every session Hermes has ever run. Hermes's `--continue` flag picks the
// most-recent session from that DB with no cwd scoping. When Ace runs
// an Hermes orchestrator per workspace, they all read/write the same DB
// and `--continue` in workspace A resumes workspace B's session — the
// "AMB tab showing CF content" bug.
//
// Fix: give each workspace its own HERMES_HOME dir. state.db, sessions/,
// logs/, memories/, sandboxes/, cron/ live per-workspace. auth.json,
// config.yaml, .env, SOUL.md, skills/, bin/, vendor/ stay shared —
// symlinked from the base so the user authenticates once and ships one
// copy of skills/binaries.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Files/dirs that every workspace shares back to the base hermes-home.
// Everything NOT in this list stays per-workspace — that's the isolation
// boundary for session resume.
const SHARED_ENTRIES = [
  'auth.json',
  'config.yaml',
  '.env',
  'SOUL.md',
  'skills',
  'bin',
  'vendor',
];

const LOCAL_ONLY_DIRS = ['sessions', 'logs', 'memories', 'sandboxes', 'cron'];

function baseHermesHome(userDataPath: any) {
  return path.join(userDataPath, 'hermes-home');
}

function workspaceHermesHome(userDataPath: any, workspaceId: any) {
  const safe = String(workspaceId).replace(/[^\w.-]/g, '_');
  return path.join(userDataPath, `hermes-home-${safe}`);
}

function ensureBaseHermesHome(userDataPath: any, options: any = {}) {
  const base = baseHermesHome(userDataPath);
  fs.mkdirSync(base, { recursive: true });

  const sourceBase = options.sharedUserDataPath
    ? baseHermesHome(options.sharedUserDataPath)
    : null;
  for (const entry of SHARED_ENTRIES) {
    const dst = path.join(base, entry);
    if (fs.existsSync(dst)) continue;
    const src = sourceBase ? path.join(sourceBase, entry) : null;
    if (src && fs.existsSync(src)) {
      try {
        fs.symlinkSync(src, dst);
        continue;
      } catch {}
    }
    if (entry === 'config.yaml') {
      try {
        fs.writeFileSync(dst, 'terminal:\n  cwd: ' + os.homedir() + '\n');
      } catch {}
    }
  }
  for (const entry of LOCAL_ONLY_DIRS) {
    try { fs.mkdirSync(path.join(base, entry), { recursive: true }); } catch {}
  }
  return base;
}

// Populate a per-workspace home dir: local-only dirs plus symlinks for the
// shared entries from the base. Idempotent: re-running leaves valid links
// alone and repairs ones pointing at a stale target.
function populateWorkspaceHermesHome(base: any, wsHome: any) {
  fs.mkdirSync(wsHome, { recursive: true });
  for (const entry of LOCAL_ONLY_DIRS) {
    fs.mkdirSync(path.join(wsHome, entry), { recursive: true });
  }
  for (const entry of SHARED_ENTRIES) {
    const src = path.join(base, entry);
    const dst = path.join(wsHome, entry);
    if (!fs.existsSync(src)) continue;

    // If dst is already the right symlink, skip. If it's a wrong symlink,
    // replace it. If it's a real file/dir, leave it alone — that's user
    // data we don't own.
    try {
      const stat = fs.lstatSync(dst);
      if (stat.isSymbolicLink()) {
        if (fs.readlinkSync(dst) === src) continue;
        fs.unlinkSync(dst);
      } else {
        continue;
      }
    } catch {
      // lstat failed = dst doesn't exist; fall through.
    }
    try {
      fs.symlinkSync(src, dst);
    } catch (err: any) {
      // Non-fatal: one bad link shouldn't kill the launch.
      console.warn(`[ace] hermes-home symlink ${entry} failed:`, err.message);
    }
  }
}

// Create <userData>/hermes-home-<workspaceId>/ if missing and symlink the
// shared entries from the base. Returns the path to the per-workspace home,
// or the base path if workspaceId is missing.
function ensureHermesHomeForWorkspace(userDataPath: any, workspaceId: any) {
  const base = ensureBaseHermesHome(userDataPath);
  if (!workspaceId) return base;

  const wsHome = workspaceHermesHome(userDataPath, workspaceId);
  try {
    populateWorkspaceHermesHome(base, wsHome);
  } catch (err: any) {
    console.warn(
      `[ace] ensureHermesHomeForWorkspace(${workspaceId}) failed:`,
      err.message
    );
    return base;
  }
  return wsHome;
}

function writeOverrideFile(filePath: any, contents: any) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) fs.unlinkSync(filePath);
  } catch {}
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      try {
        if (fs.readFileSync(filePath, 'utf8') === contents) return;
      } catch {}
    }
    fs.writeFileSync(filePath, contents);
  } catch (err: any) {
    console.warn(`[ace] hermes identity override ${filePath} failed:`, err.message);
  }
}

function realPathOrSelf(filePath: any) {
  try { return fs.realpathSync(filePath); } catch { return filePath; }
}

function fileStat(filePath: any) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return stat;
  } catch {
    return null;
  }
}

function isSymlink(filePath: any) {
  try { return fs.lstatSync(filePath).isSymbolicLink(); } catch { return false; }
}

function defaultAuthCandidatePaths(userDataPath: any, identity: any, legacyAuthDirs?: any) {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.hermes', 'auth.json'),
    path.join(baseHermesHome(userDataPath), 'auth.json'),
  ];
  // Operator-profile-driven auth.json candidate dir names under userDataPath.
  // When the caller does not supply legacyAuthDirs, fall back to the historic
  // hardcoded rook/king dirs (backward compat until wave 3 removes them).
  let dirNames: any[];
  if (Array.isArray(legacyAuthDirs)) {
    dirNames = legacyAuthDirs;
  } else {
    const id = String(identity || '').trim().toLowerCase();
    dirNames = [];
    if (id === 'rook') dirNames.push('hermes-home-personal-hermes');
    if (id === 'king') dirNames.push('hermes-home-king-hermes');
  }
  let insertAt = 1;
  for (const dirName of dirNames) {
    if (typeof dirName !== 'string' || !dirName) continue;
    candidates.splice(insertAt, 0, path.join(userDataPath, dirName, 'auth.json'));
    insertAt += 1;
  }
  return candidates;
}

function ensureIdentityAuthFile(userDataPath: any, wsHome: any, options: any = {}) {
  const dst = path.join(wsHome, 'auth.json');
  if (fs.existsSync(dst) && !isSymlink(dst)) return;

  const dstStat = fileStat(dst);
  const dstReal = realPathOrSelf(dst);
  const paths = [
    ...(Array.isArray(options.authCandidatePaths) ? options.authCandidatePaths : []),
    ...(options.includeDefaultAuthCandidates === false ? [] : defaultAuthCandidatePaths(userDataPath, options.identity, options.legacyAuthDirs)),
  ];
  let best: any = null;
  for (const candidatePath of paths) {
    if (!candidatePath) continue;
    if (realPathOrSelf(candidatePath) === dstReal) continue;
    const stat = fileStat(candidatePath);
    if (!stat) continue;
    if (dstStat && stat.mtimeMs <= dstStat.mtimeMs) continue;
    if (!best || stat.mtimeMs > best.stat.mtimeMs) {
      best = { path: candidatePath, stat };
    }
  }
  if (!best) return;

  try {
    if (fs.existsSync(dst) || isSymlink(dst)) fs.unlinkSync(dst);
    fs.copyFileSync(best.path, dst);
  } catch (err: any) {
    console.warn('[ace] hermes identity auth repair failed:', err.message);
  }
}

function configWithTerminalCwd(configText: any, terminalCwd: any) {
  const cwdLine = `  cwd: ${terminalCwd}`;
  const raw = String(configText || '');
  const lines = raw.split(/\r?\n/);
  const terminalIdx = lines.findIndex((line) => /^terminal:\s*$/.test(line));
  if (terminalIdx < 0) {
    return `${raw.replace(/\s*$/, '')}\nterminal:\n${cwdLine}\n`;
  }

  let sectionEnd = lines.length;
  let cwdIdx = -1;
  for (let i = terminalIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') {
      sectionEnd = i;
      break;
    }
    if (/^\s*cwd\s*:/.test(line)) cwdIdx = i;
  }
  if (cwdIdx >= 0) lines[cwdIdx] = cwdLine;
  else lines.splice(sectionEnd, 0, cwdLine);
  return lines.join('\n').replace(/\s*$/, '\n');
}

// Inject/replace plugins['hermes-memory-store'].db_path in a config.yaml text
// via an indentation-aware line scan (no YAML dependency) — mirrors the
// reader in electron/operators.cts effectiveMemoryDbPath. Every other line,
// including auto_extract, is preserved as-is. Only call this with a real
// memoryDbPath; when the caller has none, the inherited plugin block must
// stay byte-identical (so callers skip this function entirely).
function configWithMemoryDbPath(configText: any, memoryDbPath: any) {
  const raw = String(configText || '');
  const lines = raw.split(/\r?\n/);
  let blockIndent: number | null = null;
  let blockHeaderIdx = -1;
  let pluginsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null && indent <= blockIndent) blockIndent = null;
    if (blockIndent === null) {
      if (indent === 0 && /^plugins:\s*$/.test(trimmed) && pluginsIdx < 0) pluginsIdx = i;
      if (/^hermes-memory-store:\s*$/.test(trimmed) && blockHeaderIdx < 0) {
        blockIndent = indent;
        blockHeaderIdx = i;
      }
      continue;
    }
    const keyMatch = line.match(/^(\s*db_path:\s*)/);
    if (keyMatch) {
      lines[i] = `${keyMatch[1]}${memoryDbPath}`;
      return lines.join('\n').replace(/\s*$/, '\n');
    }
  }
  if (blockHeaderIdx >= 0) {
    // Plugin block exists but carries no db_path yet: add one under the
    // header, leaving every existing line (auto_extract etc.) untouched.
    const headerLine = lines[blockHeaderIdx];
    const headerIndent = headerLine.length - headerLine.trimStart().length;
    lines.splice(blockHeaderIdx + 1, 0, `${' '.repeat(headerIndent + 2)}db_path: ${memoryDbPath}`);
    return lines.join('\n').replace(/\s*$/, '\n');
  }
  if (pluginsIdx >= 0) {
    // Top-level plugins: section exists without a hermes-memory-store block.
    lines.splice(
      pluginsIdx + 1,
      0,
      '  hermes-memory-store:',
      `    db_path: ${memoryDbPath}`,
      '    auto_extract: true'
    );
    return lines.join('\n').replace(/\s*$/, '\n');
  }
  const body = raw.replace(/\s*$/, '');
  return `${body ? `${body}\n` : ''}plugins:\n  hermes-memory-store:\n    db_path: ${memoryDbPath}\n    auto_extract: true\n`;
}

// Identity-home options (cross-unit contract with electron/operators.cts):
//   soul?: string            persona text. When undefined/null NO SOUL.md is
//                            written anywhere; the base hermes-home/SOUL.md
//                            is never written by any path in this module.
//   memoryDbPath?: string|null  when set, inject/replace the
//                            plugins['hermes-memory-store'].db_path line in
//                            the workspace config.yaml; when null/undefined
//                            the plugin block stays exactly as inherited.
//   legacyAuthDirs?: string[]   extra auth.json candidate dir names under
//                            userDataPath. Undefined keeps the legacy
//                            rook/king defaults (until wave 3).
//   terminalCwd?: string     terminal.cwd override in config.yaml.
//   hermesHomeOverride?: string|null  explicit home dir for this identity
//                            instead of <userData>/hermes-home-<projectId>.
function ensureIdentityHermesHome(userDataPath: any, workspaceId: any, options: any = {}) {
  const base = baseHermesHome(userDataPath);
  const override =
    typeof options.hermesHomeOverride === 'string' && options.hermesHomeOverride.trim()
      ? options.hermesHomeOverride
      : null;
  let wsHome: any;
  if (override) {
    ensureBaseHermesHome(userDataPath);
    try {
      populateWorkspaceHermesHome(base, override);
      wsHome = override;
    } catch (err: any) {
      console.warn(`[ace] ensureIdentityHermesHome override(${override}) failed:`, err.message);
      wsHome = ensureHermesHomeForWorkspace(userDataPath, workspaceId);
    }
  } else {
    wsHome = ensureHermesHomeForWorkspace(userDataPath, workspaceId);
  }
  if (!workspaceId && wsHome === base) return wsHome;

  ensureIdentityAuthFile(userDataPath, wsHome, options);
  // Persona invariant (#1 priority): no soul ⇒ no SOUL.md writes anywhere,
  // and the BASE SOUL.md is never a write target even on fallback paths.
  if (options.soul && wsHome !== base) {
    writeOverrideFile(path.join(wsHome, 'SOUL.md'), String(options.soul));
  }
  const memoryDbPath =
    typeof options.memoryDbPath === 'string' && options.memoryDbPath
      ? options.memoryDbPath
      : null;
  if (options.terminalCwd || memoryDbPath) {
    const baseConfigPath = path.join(base, 'config.yaml');
    let configText = '';
    if (options.terminalCwd) {
      try { fs.mkdirSync(options.terminalCwd, { recursive: true }); } catch {}
      configText = 'terminal:\n  cwd: ' + options.terminalCwd + '\n';
      try {
        if (fs.existsSync(baseConfigPath)) {
          configText = configWithTerminalCwd(fs.readFileSync(baseConfigPath, 'utf8'), options.terminalCwd);
        }
      } catch {}
    } else {
      try {
        if (fs.existsSync(baseConfigPath)) configText = fs.readFileSync(baseConfigPath, 'utf8');
      } catch {}
    }
    if (memoryDbPath) configText = configWithMemoryDbPath(configText, memoryDbPath);
    writeOverrideFile(path.join(wsHome, 'config.yaml'), configText);
  }
  return wsHome;
}

function replaceSymlinkOrSkip(src: any, dst: any, label: any) {
  if (!fs.existsSync(src)) return;
  try {
    const stat = fs.lstatSync(dst);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(dst) === src) return;
      fs.unlinkSync(dst);
    } else {
      return;
    }
  } catch {}
  try {
    fs.symlinkSync(src, dst);
  } catch (err: any) {
    console.warn(`[ace] hermes profile lane symlink ${label} failed:`, err.message);
  }
}

function linkSkillChildren(skillsDir: any, sourceSkillsDir: any) {
  let entries: any[] = [];
  try { entries = fs.readdirSync(sourceSkillsDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const src = path.join(sourceSkillsDir, entry.name);
    const dst = path.join(skillsDir, entry.name);
    replaceSymlinkOrSkip(src, dst, `skills/${entry.name}`);
  }
}

function ensureHermesProfileLaneHome(userDataPath: any, laneId: any, options: any = {}) {
  const safeLane = String(laneId || 'lane').replace(/[^\w.-]/g, '_');
  const laneHome = path.join(userDataPath, 'hermes-lanes', safeLane, 'home');
  const sourceProfileHome = options.sourceProfileHome || baseHermesHome(userDataPath);
  const base = baseHermesHome(userDataPath);
  try {
    fs.mkdirSync(laneHome, { recursive: true });
    const skillsDir = path.join(laneHome, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    for (const entry of SHARED_ENTRIES) {
      if (entry === 'config.yaml' || entry === 'skills') continue;
      replaceSymlinkOrSkip(path.join(sourceProfileHome, entry), path.join(laneHome, entry), entry);
    }

    // Merge source-profile skills with Ace's bundled baseline skills.
    // Source profile entries win; base entries fill gaps so ace-cli and
    // operator-policy skills remain available to profile-backed orchestrators.
    linkSkillChildren(skillsDir, path.join(base, 'skills'));
    linkSkillChildren(skillsDir, path.join(sourceProfileHome, 'skills'));

    const sourceConfigPath = path.join(sourceProfileHome, 'config.yaml');
    let configText = 'terminal:\n  cwd: ' + (options.terminalCwd || laneHome) + '\n';
    try {
      if (fs.existsSync(sourceConfigPath)) {
        configText = fs.readFileSync(sourceConfigPath, 'utf8');
      } else {
        const baseConfigPath = path.join(base, 'config.yaml');
        if (fs.existsSync(baseConfigPath)) configText = fs.readFileSync(baseConfigPath, 'utf8');
      }
    } catch {}
    if (options.terminalCwd) {
      try { fs.mkdirSync(options.terminalCwd, { recursive: true }); } catch {}
      configText = configWithTerminalCwd(configText, options.terminalCwd);
    }
    writeOverrideFile(path.join(laneHome, 'config.yaml'), configText);
  } catch (err: any) {
    console.warn(`[ace] ensureHermesProfileLaneHome(${laneId}) failed:`, err.message);
    return base;
  }
  return laneHome;
}

// Copy a bundled SKILL.md into <baseHome>/skills/<id>/ so every per-workspace
// Hermes (which symlinks skills/ from base) can read it. Hermes loads skills
// from $HERMES_HOME/skills/<id>/SKILL.md; without this seeding the
// orchestrator prompt's "Load <skill>" lines dangle.
// Idempotent: only writes when the source is newer or the dest is missing.
// A `.local-override` marker file in the destination skill dir means the user
// customized that skill's doctrine: never seed (or mtime-overwrite) over it.
function seedBundledSkill(userDataPath: any, skillId: any) {
  const src = path.join(__dirname, 'assets', 'skills', skillId, 'SKILL.md');
  if (!fs.existsSync(src)) return;
  const dstDir = path.join(baseHermesHome(userDataPath), 'skills', skillId);
  const dst = path.join(dstDir, 'SKILL.md');
  try {
    if (fs.existsSync(path.join(dstDir, '.local-override'))) return;
    fs.mkdirSync(dstDir, { recursive: true });
    let needsCopy = true;
    try {
      const srcStat = fs.statSync(src);
      const dstStat = fs.statSync(dst);
      needsCopy = srcStat.mtimeMs > dstStat.mtimeMs || dstStat.size !== srcStat.size;
    } catch {}
    if (needsCopy) fs.copyFileSync(src, dst);
  } catch (err: any) {
    console.warn(`[ace] seedBundledSkill(${skillId}) failed:`, err.message);
  }
}

function ensureBundledAceSkill(userDataPath: any) {
  seedBundledSkill(userDataPath, 'ace-cli');
  // v2.1 manager + research/build doctrine. Replaces the retired orchestra
  // skills (operator-policy, orchestrator-loop, lean-controller, lean-wave,
  // subagent-prompting, auto-followup) and installs the v2 skills the running
  // Hermes must read to follow its own contract.
  seedBundledSkill(userDataPath, 'ace-hermes-router');
  seedBundledSkill(userDataPath, 'ace-grill-prd');
  seedBundledSkill(userDataPath, 'ace-worker-brief-writing');
  seedBundledSkill(userDataPath, 'ace-internal-subagents');
  seedBundledSkill(userDataPath, 'ace-integration');
  seedBundledSkill(userDataPath, 'ace-validator-worker');
  seedBundledSkill(userDataPath, 'ace-rubric-first');
  // #314 consolidation: the former PR + project-management seeds collapse
  // into a single ace-github-flow.
  seedBundledSkill(userDataPath, 'ace-github-flow');
  seedBundledSkill(userDataPath, 'ace-major-prune-program');
  seedBundledSkill(userDataPath, 'ace-graceful-rebuild-relaunch');
  seedBundledSkill(userDataPath, 'ace-task-worker');
  seedBundledSkill(userDataPath, 'autoreview');
  // Goal-agent baseline: compact runtime contract + worker/validator
  // doctrine. Must be seeded so existing Hermes homes (not just newly
  // spawned child agents through ensureBaselineSkillsForAgent) can find
  // $HERMES_HOME/skills/<id>/SKILL.md after the rebase.
  seedBundledSkill(userDataPath, 'ace-runtime-contract');
  seedBundledSkill(userDataPath, 'ace-goal-worker');
  // ace-validator-worker (v2 single read-only reviewer) is seeded above;
  // the retired goal-validator spawner is no longer seeded.
  seedBundledSkill(userDataPath, 'grill-me');
  seedBundledSkill(userDataPath, 'skill-cleaner');
  seedBundledSkill(userDataPath, 'ace-agent-pack-architect');
  seedBundledSkill(userDataPath, 'ace-agent-pack-engineer');
  seedBundledSkill(userDataPath, 'ace-agent-pack-backend');
  seedBundledSkill(userDataPath, 'ace-agent-pack-ui-designer');
  seedBundledSkill(userDataPath, 'steipete-frontend-design');
  seedBundledSkill(userDataPath, 'ace-agent-pack-security');
  seedBundledSkill(userDataPath, 'ace-agent-pack-cloudflare');
  // Skysphere ticket SOP — required by every Start-in-ACE handoff
  // (bridge DEFAULT_HANDOFF_SKILLS); without this seed the launcher's
  // materialization would silently skip it as source-missing.
  seedBundledSkill(userDataPath, 'skysphere-tickets');
  // Matt Pocock pack. The engineering trio (mp-tdd, mp-diagnose, mp-handoff —
  // skills-core MP_ENGINEERING_SKILL_IDS) auto-loads for every ticket worker;
  // the planning/comms ones are seeded so they RESOLVE for both Claude and
  // Codex on every OS, but load only when a lane asks for them.
  seedBundledSkill(userDataPath, 'mp-tdd');
  seedBundledSkill(userDataPath, 'mp-diagnose');
  seedBundledSkill(userDataPath, 'mp-handoff');
  seedBundledSkill(userDataPath, 'mp-grill-with-docs');
  seedBundledSkill(userDataPath, 'mp-grill-me');
  seedBundledSkill(userDataPath, 'mp-to-prd');
  seedBundledSkill(userDataPath, 'mp-to-issues');
  seedBundledSkill(userDataPath, 'mp-caveman');
}

module.exports = {
  baseHermesHome,
  workspaceHermesHome,
  ensureBaseHermesHome,
  ensureHermesHomeForWorkspace,
  ensureIdentityHermesHome,
  ensureIdentityAuthFile,
  ensureHermesProfileLaneHome,
  configWithTerminalCwd,
  configWithMemoryDbPath,
  seedBundledSkill,
  ensureBundledAceSkill,
  SHARED_ENTRIES,
};
