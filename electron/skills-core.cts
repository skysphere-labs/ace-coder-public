

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');

const hermesHome = require('./hermes-home.cjs');

const HOME = os.homedir();
const SKILLS_ROOT = path.join(HOME, '.agentskills');
const META_DIR = path.join(SKILLS_ROOT, '.ace');
const CATALOG_CACHE = path.join(META_DIR, 'catalog-index.json');
const CATALOG_VERSION = 3;
const BUNDLED_CATALOG_PATH = path.join(__dirname, 'skills-catalog.json');

// True when a path lives under the OS tmp root or a per-run sandbox store
// home (a `user-data` path segment — every sandbox store boots against
// <run-root>/user-data). The global skill brains must never be symlinked at
// such a source: the sandbox is reaped when its run ends and the dangling
// links break skill loading in every subsequent lane. Deliberately narrow —
// a durable data root that merely contains a `tmp` directory name somewhere
// is NOT classified as ephemeral.
function isEphemeralSkillSource(sourcePath: any) {
  const raw = String(sourcePath || '');
  const variants = new Set([raw]);
  try { variants.add(fs.realpathSync(raw)); } catch {}
  // Compare against both the raw and resolved tmp root: on macOS os.tmpdir()
  // is /var/folders/... while realpath yields /private/var/..., and the
  // input path may exist in either spelling (or not exist at all yet).
  const tmpRoots = new Set([os.tmpdir()]);
  try { tmpRoots.add(fs.realpathSync(os.tmpdir())); } catch {}
  for (const candidate of variants) {
    for (const tmpRoot of tmpRoots) {
      if (candidate === tmpRoot || candidate.startsWith(tmpRoot + path.sep)) return true;
    }
    if (candidate.split(path.sep).includes('user-data')) return true;
  }
  return false;
}

// Worker baseline: the compact runtime contract first, then the goal-worker
// contract. Ace v2 adds the self-contained worker
// pair — ace-internal-subagents (fan out INTERNALLY via Task tool /
// dynamic-workflow + worktree isolation, never external Ace agents) and
// ace-integration (every worker auto-validates + auto-merges its own PR via
// integration-gateway). Heavier review skills still load lazily via task pack.
const WORKER_BASELINE_SKILL_IDS = Object.freeze([
  'ace-runtime-contract',
  'ace-goal-worker',
  'ace-internal-subagents',
  'ace-integration',
]);

// Validator baseline mirrors the worker shape but loads the validator
// contract instead of the worker contract. Surfaced for orchestrators that
// dispatch validator lanes; not yet wired into ensureBaselineSkillsForAgent
// — that still distinguishes orchestrator vs worker only — but exported so
// the manifest layer and tests can introspect it.
const VALIDATOR_BASELINE_SKILL_IDS = Object.freeze([
  'ace-runtime-contract',
  'ace-validator-worker',
  'autoreview',
]);

// Orchestrator baseline (Hermes): runtime contract + CLI + the v2 lean router +
// project-management. ace-hermes-router replaces the retired
// ace-orchestrator-loop — Hermes is a single manager/router/prompt-enhancer
// that never spawns an orchestra. Heavier doctrine (rubric-first, etc.) stays
// available as opt-in references rather than always-on baseline.
const ORCHESTRATOR_BASELINE_SKILL_IDS = Object.freeze([
  'ace-runtime-contract',
  'ace-cli',
  'ace-hermes-router',
  'ace-github-flow',
]);

// Canonical universal Matt Pocock ENGINEERING subset (catalog ids, verbatim):
// auto-loaded for every dispatched build worker alongside the worker baseline.
// The remaining bundled mp-* skills (mp-grill-with-docs, mp-grill-me,
// mp-to-prd, mp-to-issues — planning; mp-caveman — comms mode) are seeded and
// resolvable for every agent/OS but are NOT universal auto-loads.
const MP_ENGINEERING_SKILL_IDS = Object.freeze([
  'mp-tdd',
  'mp-diagnose',
  'mp-handoff',
]);

// Packaged-availability check against the BUNDLED source of truth
// (electron/assets/skills/<id>/SKILL.md — the same tree hermes-home seeds
// from). Returns the ids that would be SILENTLY SKIPPED by materialization;
// gates that require a skill set call this and fail visibly instead.
function missingBundledSkillSources(skillIds: any) {
  const ids = Array.isArray(skillIds) ? skillIds : [];
  return ids
    .map((id: any) => String(id || '').trim())
    .filter(Boolean)
    .filter((id: any) => !fs.existsSync(path.join(__dirname, 'assets', 'skills', id, 'SKILL.md')));
}

// deprecated: prefer workerBaseline/orchestratorBaseline.
const BASELINE_SKILL_IDS = WORKER_BASELINE_SKILL_IDS;
const BASELINE_SYNC_CACHE_TTL_MS = 30_000;
const baselineSyncCache = new Map();

function baselineSyncKey(agentId: any, userDataPath: any, isOrchestrator: any, skillIds: any[] = []) {
  return [
    String(agentId || ''),
    path.resolve(String(userDataPath || '')),
    isOrchestrator ? 'orchestrator' : 'worker',
    skillIds.map((id: any) => String(id || '').trim()).filter(Boolean).sort().join(','),
  ].join('\0');
}

async function baselineCacheStillValid({ target, sourceBase, skillIds }: any) {
  for (const skillId of skillIds || []) {
    const src = path.join(sourceBase, skillId);
    const dst = target.skillDir(skillId);
    if (!fs.existsSync(src)) return false;
    try {
      const lst = await fsp.lstat(dst);
      if (lst.isSymbolicLink()) {
        const existing = await fsp.readlink(dst);
        const resolved = path.isAbsolute(existing)
          ? existing
          : path.resolve(path.dirname(dst), existing);
        if (resolved !== src) return false;
      } else if (!lst.isDirectory() || !fs.existsSync(path.join(dst, 'SKILL.md'))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function shouldLogBaselineSyncTelemetry(opts: any) {
  return opts?.telemetry === true || process.env.ACE_SKILL_SYNC_TELEMETRY === '1';
}

function logBaselineSyncTelemetry(result: any, opts: any) {
  if (!shouldLogBaselineSyncTelemetry(opts)) return;
  console.error(
    [
      '[ace] baseline skill sync',
      `agent=${result.agentId}`,
      `mode=${result.isOrchestrator ? 'orchestrator' : 'worker'}`,
      `cache=${result.cache}`,
      `durationMs=${result.durationMs}`,
      `linked=${result.linked}`,
      `alreadyCurrent=${result.alreadyCurrent}`,
      `skipped=${result.skippedIncompatible}`,
      `missing=${result.missing}`,
      `failed=${result.failed}`,
    ].join(' ')
  );
}

function normalizeSkillIdList(values: any) {
  const seen = new Set();
  const out = [];
  const input = Array.isArray(values) ? values : [];
  for (const value of input) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Claude-only plugin pack. Opt-in via env var ACE_ENABLE_CLAUDE_PLUGINS=1.
// These are NOT skills — they are Claude Code plugins (hooks + MCP) installed
// out-of-band via `npx <pkg> install`. We never bundle their source and never
// auto-install. When the env is set AND agent === 'claude', we log a single
// reminder. Codex and other drivers ignore this list under any env state.
const CLAUDE_PLUGIN_IDS = Object.freeze([
  { id: 'claude-mem', installCmd: 'npx claude-mem install' },
]);

function maybeLogClaudePlugins(agentId: any) {
  if (process.env.ACE_ENABLE_CLAUDE_PLUGINS !== '1') return;
  if (agentId !== 'claude') return;
  for (const plugin of CLAUDE_PLUGIN_IDS) {
    console.log(
      `[ace] claude-plugin enabled: ${plugin.id} — run \`${plugin.installCmd}\` manually to activate`
    );
  }
}

const AGENT_TARGETS = [
  {
    id: 'claude',
    name: 'Claude Code',
    configDir: path.join(HOME, '.claude'),
    // Modern Claude Code reads skills from ~/.claude/skills/<id>/SKILL.md
    // (not ~/.claude/commands/<id>, which is the legacy slash-command path).
    skillDir: (id: any) => path.join(HOME, '.claude', 'skills', id),
  },
  {
    id: 'codex',
    name: 'Codex',
    configDir: path.join(HOME, '.codex'),
    skillDir: (id: any) => path.join(HOME, '.codex', 'skills', id),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configDir: path.join(HOME, '.cursor'),
    skillDir: (id: any) => path.join(HOME, '.cursor', 'skills', id),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    configDir: path.join(HOME, '.gemini'),
    skillDir: (id: any) => path.join(HOME, '.gemini', 'skills', id),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    configDir: path.join(HOME, '.config', 'opencode'),
    skillDir: (id: any) => path.join(HOME, '.config', 'opencode', 'skills', id),
  },
  {
    id: 'amp',
    name: 'Amp',
    configDir: path.join(HOME, '.amp'),
    skillDir: (id: any) => path.join(HOME, '.amp', 'skills', id),
  },
  {
    id: 'droid',
    name: 'Droid',
    configDir: path.join(HOME, '.droid'),
    skillDir: (id: any) => path.join(HOME, '.droid', 'skills', id),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    configDir: path.join(HOME, '.copilot'),
    skillDir: (id: any) => path.join(HOME, '.copilot', 'skills', id),
  },
  {
    id: 'qwen',
    name: 'Qwen',
    configDir: path.join(HOME, '.qwen'),
    skillDir: (id: any) => path.join(HOME, '.qwen', 'skills', id),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    configDir: path.join(HOME, '.hermes'),
    skillDir: (id: any) => path.join(HOME, '.hermes', 'skills', id),
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    configDir: path.join(HOME, '.roo'),
    skillDir: (id: any) => path.join(HOME, '.roo', 'skills', id),
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    configDir: path.join(HOME, '.vibe'),
    skillDir: (id: any) => path.join(HOME, '.vibe', 'skills', id),
  },
  {
    id: 'pi',
    name: 'Pi',
    configDir: path.join(HOME, '.pi', 'agent'),
    skillDir: (id: any) => path.join(HOME, '.pi', 'agent', 'skills', id),
  },
];

const SCAN_DIRS = [
  SKILLS_ROOT,
  ...Array.from(new Set(AGENT_TARGETS.map((t: any) => path.dirname(t.skillDir('_'))))),
  path.join(HOME, '.claude', 'skills'),
  path.join(HOME, '.agent', 'skills'),
  path.join(HOME, '.agents', 'skills'),
];

function isValidSkillName(name: any) {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/.test(name) && !name.includes('--');
}

function titleCase(kebab: any) {
  return kebab
    .split('-')
    .map((w: any) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function parseFrontmatter(content: any) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: { name: '', description: '' }, body: content };
  const fm: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    const dq = value.startsWith('"') && value.endsWith('"');
    const sq = value.startsWith("'") && value.endsWith("'");
    if (dq) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (sq) value = value.slice(1, -1).replace(/''/g, "'");
    if (key) fm[key] = value;
  }
  return {
    frontmatter: {
      name: fm.name || '',
      description: fm.description || '',
      license: fm.license,
      compatibility: fm.compatibility,
      'allowed-tools': fm['allowed-tools'],
    },
    body: match[2],
  };
}

function escapeYaml(s: any) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function generateSkillMd(name: any, description: any, body?: any) {
  const content = (body && body.trim()) || `# ${name}\n\n${description}\n`;
  return `---\nname: "${escapeYaml(name)}"\ndescription: "${escapeYaml(description)}"\n---\n\n${content}\n`;
}

function dedupeById(skills: any) {
  const seen = new Set();
  const out = [];
  for (const s of skills) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

function httpsGet(url: any, redirects: any = 0): Promise<any> {
  return new Promise((resolve: any, reject: any) => {
    if (redirects > 5) return reject(new Error(`too many redirects: ${url}`));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'ace-skills', Accept: 'application/vnd.github.v3+json' } },
      (res: any) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (loc) return httpsGet(new URL(loc, url).href, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.on('data', (c: any) => (data += c));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
  });
}

function parseOpenAiYaml(content: any) {
  const out: Record<string, any> = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^\s+(\w+):\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function ensureRoot() {
  await fsp.mkdir(META_DIR, { recursive: true });
}

let catalogCache: any = null;

function loadBundled() {
  try {
    delete require.cache[require.resolve(BUNDLED_CATALOG_PATH)];
    return require(BUNDLED_CATALOG_PATH);
  } catch {
    return { version: CATALOG_VERSION, lastUpdated: new Date().toISOString(), skills: [] };
  }
}

async function getCatalogIndex() {
  if (catalogCache) return mergeInstalled(catalogCache);

  try {
    const raw = await fsp.readFile(CATALOG_CACHE, 'utf8');
    const cached = JSON.parse(raw);
    if (cached && cached.version >= CATALOG_VERSION) {
      catalogCache = cached;
      return mergeInstalled(cached);
    }
  } catch {

  }
  catalogCache = loadBundled();
  return mergeInstalled(catalogCache);
}

async function refreshCatalog() {
  try {
    const results = await Promise.allSettled([fetchOpenAi(), fetchAnthropic()]);
    const skills = [];
    for (const r of results) if (r.status === 'fulfilled') skills.push(...r.value);
    if (skills.length === 0) return getCatalogIndex();

    const catalog = {
      version: CATALOG_VERSION,
      lastUpdated: new Date().toISOString(),
      skills: dedupeById(skills),
    };
    catalogCache = catalog;
    await ensureRoot();
    await fsp.writeFile(CATALOG_CACHE, JSON.stringify(catalog, null, 2));
    return mergeInstalled(catalog);
  } catch (err) {
    console.error('[ace] skills refresh failed:', err.message);
    return getCatalogIndex();
  }
}

async function mergeInstalled(catalog: any) {
  const installed = await getInstalledSkills();
  const installedMap = new Map(installed.map((s: any) => [s.id, s]));
  const merged = dedupeById(catalog.skills).map((s: any) => {
    const local = installedMap.get(s.id);
    if (local) {
      installedMap.delete(s.id);
      return { ...s, installed: true, localPath: local.localPath };
    }
    return { ...s, installed: false };
  });
  for (const local of installedMap.values()) merged.push(local);
  return { ...catalog, skills: merged };
}

async function getInstalledSkills() {
  const seen = new Set();
  const skills = [];
  for (const dir of SCAN_DIRS) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (seen.has(entry.name)) continue;

      let skillDir = path.join(dir, entry.name);
      try {
        const real = await fsp.realpath(skillDir);
        const stat = await fsp.stat(real);
        if (!stat.isDirectory()) continue;
        skillDir = real;
      } catch {
        continue;
      }

      const mdPath = path.join(skillDir, 'SKILL.md');
      try {
        const content = await fsp.readFile(mdPath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        seen.add(entry.name);
        skills.push({
          id: entry.name,
          displayName: frontmatter.name || titleCase(entry.name),
          description: frontmatter.description || '',
          source: 'local',
          frontmatter,
          installed: true,
          localPath: skillDir,
        });
      } catch {

      }
    }
  }
  return skills;
}

async function getDetectedAgents() {
  const out = [];
  for (const t of AGENT_TARGETS) {
    let installed = false;
    try {
      await fsp.access(t.configDir);
      installed = true;
    } catch {

    }
    out.push({ id: t.id, name: t.name, configDir: t.configDir, installed });
  }
  return out;
}

async function getSkillDetail(skillId: any, source: any) {
  const catalog = await getCatalogIndex();
  let skill = catalog.skills.find((s: any) => s.id === skillId) ?? null;
  if (!skill && source && source.owner) {
    skill = skillFromSource(skillId, source);
  }
  if (!skill) return null;

  if (skill.installed && skill.localPath) {
    try {
      const content = await fsp.readFile(path.join(skill.localPath, 'SKILL.md'), 'utf8');
      return { ...skill, skillMdContent: content };
    } catch {
      return skill;
    }
  }

  try {
    const content = await fetchSkillMd(skill);
    const { frontmatter: fm } = parseFrontmatter(content);
    return {
      ...skill,
      skillMdContent: content,
      description: skill.description || fm.description || '',
      displayName: skill.displayName || fm.name || titleCase(skill.id),
    };
  } catch {
    return skill;
  }
}

function skillFromSource(id: any, source: any) {
  return {
    id,
    displayName: titleCase(id),
    description: '',
    source: 'skills-sh',
    iconUrl: source.owner ? `https://github.com/${source.owner}.png?size=80` : undefined,
    frontmatter: { name: id, description: '' },
    installed: false,
    owner: source.owner,
    repo: source.repo,
    brandColor: '#171717',
  };
}

function knownSkillMdUrl(skill: any) {
  if (!skill.sourceUrl) return null;
  const m = skill.sourceUrl.match(/github\.com\/([^/]+\/[^/]+)\/tree\/main\/(.+)/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/main/${m[2]}/SKILL.md` : null;
}

async function fetchSkillMd(skill: any) {
  const fast = knownSkillMdUrl(skill);
  if (fast) return httpsGet(fast);
  if (!skill.owner || !skill.repo) throw new Error(`no source for skill "${skill.id}"`);

  const raw = (p: any) => `https://raw.githubusercontent.com/${skill.owner}/${skill.repo}/main/${p}`;





  let paths;
  try {
    const tree = JSON.parse(
      await httpsGet(
        `https://api.github.com/repos/${skill.owner}/${skill.repo}/git/trees/main?recursive=1`
      )
    );
    paths = tree.tree
      .filter((n: any) => n.type === 'blob' && n.path.endsWith('SKILL.md'))
      .map((n: any) => n.path);
  } catch {

    const guesses = [
      `skills/${skill.id}/SKILL.md`,
      'SKILL.md',
      `${skill.id}/SKILL.md`,
      `.claude/skills/${skill.id}/SKILL.md`,
    ];
    for (const g of guesses) {
      try {
        return await httpsGet(raw(g));
      } catch {

      }
    }
    throw new Error(`SKILL.md not found for "${skill.id}"`);
  }

  if (paths.length === 0) throw new Error(`no SKILL.md in ${skill.owner}/${skill.repo}`);
  if (paths.length === 1) return httpsGet(raw(paths[0]));

  const byDir = paths.find((p: any) => {
    const parts = p.split('/');
    return parts.length >= 2 && parts[parts.length - 2] === skill.id;
  });
  if (byDir) return httpsGet(raw(byDir));

  for (const p of paths) {
    try {
      const content = await httpsGet(raw(p));
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter.name === skill.id) return content;
    } catch {

    }
  }
  return httpsGet(raw(paths[0]));
}

async function fetchOpenAi() {
  const base = 'https://api.github.com/repos/openai/skills/contents/skills';
  const rawBase = 'https://raw.githubusercontent.com/openai/skills/main/skills';
  const [curatedRaw, systemRaw] = await Promise.all([
    httpsGet(`${base}/.curated`),
    httpsGet(`${base}/.system`).catch(() => '[]'),
  ]);
  const entries = [
    ...JSON.parse(curatedRaw).map((e: any) => ({ ...e, cat: '.curated' })),
    ...JSON.parse(systemRaw).map((e: any) => ({ ...e, cat: '.system' })),
  ].filter((e: any) => e.type === 'dir');

  return Promise.all(
    entries.map(async (entry: any) => {
      const fallback = titleCase(entry.name);
      let displayName = fallback;
      let description = '';
      let iconUrl;
      let brandColor;
      let defaultPrompt;
      try {
        const yaml = parseOpenAiYaml(
          await httpsGet(`${rawBase}/${entry.cat}/${entry.name}/agents/openai.yaml`)
        );
        displayName = yaml.display_name || fallback;
        description = yaml.short_description || '';
        defaultPrompt = yaml.default_prompt;
        brandColor = yaml.brand_color;
        const icon = yaml.icon_small || yaml.icon_large;
        if (icon) iconUrl = `${rawBase}/${entry.cat}/${entry.name}/${icon.replace(/^\.\//, '')}`;
      } catch {

      }
      if (!description) {
        try {
          const md = await httpsGet(`${rawBase}/${entry.cat}/${entry.name}/SKILL.md`);
          description = parseFrontmatter(md).frontmatter.description || '';
        } catch {

        }
      }
      if (!description) description = entry.name.replace(/-/g, ' ');
      return {
        id: entry.name,
        displayName,
        description,
        source: 'openai',
        sourceUrl: entry.html_url,
        iconUrl,
        brandColor: brandColor || '#10a37f',
        defaultPrompt,
        frontmatter: { name: entry.name, description },
        installed: false,
      };
    })
  );
}

async function fetchAnthropic() {
  const url = 'https://api.github.com/repos/anthropics/skills/contents/skills';
  const rawBase = 'https://raw.githubusercontent.com/anthropics/skills/main/skills';
  const entries = JSON.parse(await httpsGet(url)).filter((e: any) => e.type === 'dir');
  const out = [];
  for (const entry of entries) {
    let description = '';
    try {
      const md = await httpsGet(`${rawBase}/${entry.name}/SKILL.md`);
      description = parseFrontmatter(md).frontmatter.description || '';
    } catch {

    }
    if (!description) description = entry.name.replace(/-/g, ' ');
    out.push({
      id: entry.name,
      displayName: titleCase(entry.name),
      description,
      source: 'anthropic',
      sourceUrl: entry.html_url,
      brandColor: '#d4a574',
      frontmatter: { name: entry.name, description },
      installed: false,
    });
  }
  return out;
}

async function searchSkillsSh(query: any) {
  if (!query || query.trim().length < 2) return [];
  const data = JSON.parse(
    await httpsGet(`https://skills.sh/api/search?q=${encodeURIComponent(query.trim())}`)
  );
  if (!data || !Array.isArray(data.skills)) return [];

  const installed = await getInstalledSkills();
  const installedIds = new Set(installed.map((s: any) => s.id));
  return data.skills
    .filter((s: any) => s.skillId && s.source)
    .map((s: any) => {
      const slash = s.source.indexOf('/');
      const owner = slash > 0 ? s.source.slice(0, slash) : s.source;
      const repo = slash > 0 ? s.source.slice(slash + 1) : '';
      const local = installed.find((i: any) => i.id === s.skillId);
      return {
        id: s.skillId,
        displayName: titleCase(s.skillId),
        description: '',
        source: 'skills-sh',
        brandColor: '#171717',
        iconUrl: owner ? `https://github.com/${owner}.png?size=80` : undefined,
        frontmatter: { name: s.skillId, description: '' },
        installed: installedIds.has(s.skillId),
        localPath: local && local.localPath,
        owner,
        repo,
        installs: s.installs,
      };
    });
}

// Materialise the baseline skill pack into the per-agent skills dir so the
// child's native skill loader (Claude Code, Codex, ...) picks them up without
// relying on the orchestrator prompt.
//
// Source: <userData>/hermes-home/skills/<id> — seeded by
// hermesHome.ensureBundledAceSkill(). If that hasn't run yet (first boot),
// we call it now. If an individual source dir is still missing after that, we
// log a warning and skip that one — non-fatal.
//
// Target: AGENT_TARGETS.find(t => t.id === agentId).skillDir(<id>). Unknown
// agent ids (e.g. the bash fallback or an agent we don't ship a target for)
// log and no-op.
//
// Idempotent: if the dst is already a symlink pointing at the right source,
// we leave it. Otherwise replace. Falls back to copy if symlink fails.
async function ensureBaselineSkillsForAgent(agentId: any, userDataPath: any, opts: any = {}) {
  if (!agentId) return;
  const startedAt = Date.now();
  const target = AGENT_TARGETS.find((t: any) => t.id === agentId);
  if (!target) {
    console.warn(`[ace] unknown agent for skill sync: ${agentId}`);
    return;
  }
  if (!userDataPath) {
    console.warn(`[ace] skill sync for ${agentId}: missing userDataPath`);
    return;
  }

  maybeLogClaudePlugins(agentId);

  const isOrchestrator = !!opts?.isOrchestrator;
  const baselineSkillIds = isOrchestrator
    ? ORCHESTRATOR_BASELINE_SKILL_IDS
    : WORKER_BASELINE_SKILL_IDS;
  const skillIdsToSync = normalizeSkillIdList([
    ...baselineSkillIds,
    ...normalizeSkillIdList(opts?.extraSkillIds),
  ]);
  const sourceBase = path.join(hermesHome.baseHermesHome(userDataPath), 'skills');
  const cacheKey = baselineSyncKey(agentId, userDataPath, isOrchestrator, skillIdsToSync);
  const cached = opts?.catalog ? null : baselineSyncCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.at <= BASELINE_SYNC_CACHE_TTL_MS &&
    await baselineCacheStillValid({ target, sourceBase, skillIds: cached.skillIds })
  ) {
    const result = {
      ...cached.result,
      cache: 'hit',
      durationMs: Date.now() - startedAt,
      linked: 0,
      alreadyCurrent: cached.skillIds.length,
      missing: 0,
      failed: 0,
    };
    logBaselineSyncTelemetry(result, opts);
    return result;
  }

  // Ensure the bundled sources are materialised under
  // <userData>/hermes-home/skills/. Cheap + idempotent; safe to call every spawn.
  try {
    hermesHome.ensureBaseHermesHome(userDataPath, {
      sharedUserDataPath: process.env.ACE_SHARED_USER_DATA_PATH,
    });
    hermesHome.ensureBundledAceSkill(userDataPath);
  } catch (err) {
    console.warn(
      `[ace] ensureBundledAceSkill failed before sync to ${agentId}:`,
      err && err.message ? err.message : err
    );
  }

  const catalog = opts?.catalog || loadBundled();
  const catalogById = new Map((catalog.skills || []).map((skill: any) => [skill.id, skill]));

  // Sandbox/test home: its own hermes-home skills are materialised above
  // (lanes inside the sandbox read those), but a DURABLE global skill brain
  // must not be re-linked at a directory that dies with this run. When the
  // brain itself is ephemeral (tests redirect HOME to a tmp dir), linking is
  // harmless and stays allowed. Runs after catalog load so a missing/corrupt
  // bundled catalog still surfaces in sandbox lanes.
  if (isEphemeralSkillSource(sourceBase) && !isEphemeralSkillSource(target.configDir)) {
    const result = {
      agentId,
      target: target.name,
      isOrchestrator,
      cache: 'skip',
      skippedEphemeralSource: true,
      durationMs: Date.now() - startedAt,
      linked: 0,
      alreadyCurrent: 0,
      skippedIncompatible: 0,
      missing: 0,
      failed: 0,
      syncedSkillIds: [],
    };
    console.warn(
      `[ace] baseline skill sync for ${agentId} skipped: ${sourceBase} is a sandbox/test home; global skill brains stay untouched`
    );
    logBaselineSyncTelemetry(result, opts);
    return result;
  }
  const warnedCompat = new Set();
  const stats = {
    linked: 0,
    alreadyCurrent: 0,
    skippedIncompatible: 0,
    missing: 0,
    failed: 0,
  };
  const syncedSkillIds = [];

  for (const skillId of skillIdsToSync) {
    const catalogEntry = catalogById.get(skillId) || {};
    const agentCompatibility = String(catalogEntry.agentCompatibility || 'shared').trim();
    const incompatible =
      (agentCompatibility === 'claude-only' && agentId !== 'claude') ||
      (agentCompatibility === 'codex-only' && agentId !== 'codex');
    if (incompatible) {
      const warningKey = `${skillId}:${agentCompatibility}:${agentId}`;
      if (!warnedCompat.has(warningKey)) {
        warnedCompat.add(warningKey);
        console.warn(
          `[ace] baseline skill ${skillId} is ${agentCompatibility}; skipping sync to ${target.name}`
        );
      }
      stats.skippedIncompatible += 1;
      continue;
    }

    const src = path.join(sourceBase, skillId);
    const dst = target.skillDir(skillId);
    try {
      if (!fs.existsSync(src)) {
        console.warn(
          `[ace] baseline skill source missing, skipping: ${src} → ${dst}`
        );
        stats.missing += 1;
        continue;
      }
      syncedSkillIds.push(skillId);
      await fsp.mkdir(path.dirname(dst), { recursive: true });

      // Already correct? Leave it.
      try {
        const lst = await fsp.lstat(dst);
        if (lst.isSymbolicLink()) {
          const existing = await fsp.readlink(dst);
          const resolved = path.isAbsolute(existing)
            ? existing
            : path.resolve(path.dirname(dst), existing);
          if (resolved === src) {
            stats.alreadyCurrent += 1;
            continue;
          }
        }
        // Wrong symlink, or a real file/dir — remove so we can replace.
        await fsp.rm(dst, { recursive: true, force: true });
      } catch {
        // lstat failed = dst doesn't exist; fall through to create.
      }

      try {
        await fsp.symlink(src, dst, 'junction');
        stats.linked += 1;
      } catch (symErr) {
        // Fall back to copy on filesystems that refuse symlinks.
        try {
          await fsp.cp(src, dst, { recursive: true });
          stats.linked += 1;
        } catch (cpErr) {
          stats.failed += 1;
          console.warn(
            `[ace] baseline skill sync ${skillId} → ${target.name} failed (symlink: ${symErr.message}; copy: ${cpErr.message})`
          );
        }
      }
    } catch (err) {
      stats.failed += 1;
      console.warn(
        `[ace] baseline skill sync ${skillId} → ${target.name} failed:`,
        err && err.message ? err.message : err
      );
    }
  }
  const result = {
    agentId,
    target: target.name,
    isOrchestrator,
    cache: 'miss',
    durationMs: Date.now() - startedAt,
    ...stats,
    syncedSkillIds,
  };
  if (!opts?.catalog && stats.missing === 0 && stats.failed === 0) {
    baselineSyncCache.set(cacheKey, {
      at: Date.now(),
      skillIds: syncedSkillIds.slice(),
      result,
    });
  }
  logBaselineSyncTelemetry(result, opts);
  return result;
}

async function syncToAgents(skillId: any) {
  const src = path.join(SKILLS_ROOT, skillId);
  for (const t of AGENT_TARGETS) {
    try {
      await fsp.access(t.configDir);
    } catch {
      continue;
    }
    const dst = t.skillDir(skillId);
    try {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      try {
        const stat = await fsp.lstat(dst);
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          await fsp.rm(dst, { recursive: true, force: true });
        }
      } catch {

      }
      await fsp.symlink(src, dst, 'junction');
    } catch (err) {
      console.warn(`[ace] sync skill "${skillId}" → ${t.name} failed:`, err.message);
    }
  }
}

async function unsyncFromAgents(skillId: any) {
  for (const t of AGENT_TARGETS) {
    const dst = t.skillDir(skillId);
    try {
      const stat = await fsp.lstat(dst);
      if (!stat.isSymbolicLink()) continue;
      const link = await fsp.readlink(dst);
      const resolved = path.resolve(path.dirname(dst), link);
      if (resolved.startsWith(SKILLS_ROOT)) await fsp.unlink(dst);
    } catch {

    }
  }
}

async function installSkill({ skillId, source }: any) {
  if (!isValidSkillName(skillId)) throw new Error(`invalid skill id "${skillId}"`);

  await ensureRoot();
  const catalog = await getCatalogIndex();
  let skill = catalog.skills.find((s: any) => s.id === skillId) ?? null;
  if (!skill && source && source.owner) skill = skillFromSource(skillId, source);
  if (!skill) throw new Error(`skill "${skillId}" not found`);
  if (skill.installed) throw new Error(`skill "${skillId}" already installed`);

  const target = path.join(SKILLS_ROOT, skillId);
  const tmp = `${target}.tmp-${Date.now()}`;
  try {
    await fsp.mkdir(tmp, { recursive: true });
    let content;
    try {
      content = await fetchSkillMd(skill);
    } catch {
      content = generateSkillMd(skill.displayName, skill.description);
    }
    await fsp.writeFile(path.join(tmp, 'SKILL.md'), content);
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(tmp, target);
    await syncToAgents(skillId);
    catalogCache = null;
    return { ...skill, installed: true, localPath: target, skillMdContent: content };
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function uninstallSkill({ skillId }: any) {
  if (!isValidSkillName(skillId)) throw new Error(`invalid skill id "${skillId}"`);
  await unsyncFromAgents(skillId);
  await fsp.rm(path.join(SKILLS_ROOT, skillId), { recursive: true, force: true });
  catalogCache = null;
}

async function createSkill({ name, description, content }: any) {
  if (!isValidSkillName(name)) {
    throw new Error('invalid skill name — lowercase letters, digits, hyphens (1-64 chars)');
  }
  await ensureRoot();
  const target = path.join(SKILLS_ROOT, name);
  try {
    await fsp.access(target);
    throw new Error(`skill "${name}" already exists`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  await fsp.mkdir(target, { recursive: true });
  const md = generateSkillMd(name, description || '', content && content.trim());
  await fsp.writeFile(path.join(target, 'SKILL.md'), md);
  await syncToAgents(name);
  catalogCache = null;
  const { frontmatter } = parseFrontmatter(md);
  return {
    id: name,
    displayName: frontmatter.name || name,
    description: frontmatter.description || description || '',
    source: 'local',
    frontmatter,
    installed: true,
    localPath: target,
    skillMdContent: md,
  };
}

module.exports = {
  getCatalogIndex,
  refreshCatalog,
  getInstalledSkills,
  getDetectedAgents,
  getSkillDetail,
  searchSkillsSh,
  installSkill,
  uninstallSkill,
  createSkill,
  ensureBaselineSkillsForAgent,
  isEphemeralSkillSource,
  maybeLogClaudePlugins,
  BASELINE_SKILL_IDS,
  WORKER_BASELINE_SKILL_IDS,
  MP_ENGINEERING_SKILL_IDS,
  missingBundledSkillSources,
  VALIDATOR_BASELINE_SKILL_IDS,
  ORCHESTRATOR_BASELINE_SKILL_IDS,
  CLAUDE_PLUGIN_IDS,
  AGENT_TARGETS,
};
