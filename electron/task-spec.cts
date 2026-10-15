// Parses the framed `initial_prompt` that ace writes when an
// orchestrator delegates a task. Shape is defined in
// tools/ace/src/prompt.cjs. This reader is deliberately tolerant
// — a pre-delegation task may have free-form text, or no prompt at all.
//
// The parser is pure and shared between the electron IPC and the React
// worker-tab pane. Mirrored in src/lib/task-spec.ts — keep regex in sync.

const fs = require('fs');

// The ticket launcher adds this provenance marker before remote requirements.
// Untrusted ticket text must not cause the sidecar to open local files, even
// when it contains a valid GoalAgentSpec pointer or a quoted Markdown path.
const EXTERNAL_TICKET_PROMPT_MARKER = '<!-- ace:external-ticket:v1 -->';
function isExternalTicketPrompt(text: any) {
  return String(text || '').trimStart().startsWith(EXTERNAL_TICKET_PROMPT_MARKER);
}

function splitSections(text: any) {
  // Matches top-level ATX headings: `# Goal`, `# Skills to load`, etc.
  // The framed prompt only uses level-1 headings; deeper ones are body.
  const lines = String(text || '').split(/\r?\n/);
  const sections: any[] = [];
  let current: any = null;
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s: any) => ({ title: s.title, body: s.body.join('\n').trim() }));
}

function parseBullets(body: any) {
  // Splits a bullet-list body into its items. Preserves inline newlines
  // inside an item (continuation lines that don't start with `- `).
  const items = [];
  let buf: any = null;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const m = /^\s*-\s+(.*)$/.exec(raw);
    if (m) {
      if (buf) items.push(buf.trim());
      buf = m[1];
    } else if (buf != null) {
      buf += raw.trim() ? `\n${raw}` : '';
    }
  }
  if (buf) items.push(buf.trim());
  return items.filter(Boolean);
}

function parseCsv(value: any) {
  return String(value || '').split(',').map((item: any) => item.trim()).filter(Boolean);
}

function parseRoleManifest(body: any) {
  const out: any = {
    roleMode: null,
    skillPack: null,
    capabilities: [],
    taskPackSkills: [],
  };
  for (const raw of String(body || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'role') out.roleMode = value.split(/\s|\(/)[0] || null;
    else if (key === 'skillpack') out.skillPack = value || null;
    else if (key === 'capabilities') out.capabilities = parseCsv(value);
    else if (key === 'taskpackskills') out.taskPackSkills = parseCsv(value);
  }
  return out;
}

function parseInitialPrompt(text: any) {
  const raw = String(text || '').trim();
  const empty = {
    hasContent: false,
    goal: null,
    context: null,
    skills: [],
    roleMode: null,
    skillPack: null,
    capabilities: [],
    taskPackSkills: [],
    constraints: [],
    deliverables: [],
    acceptance: [],
    priorRound: null,
    escapeHatch: null,
    raw,
  };
  if (!raw) return empty;

  const sections = splitSections(raw);
  if (!sections.length) {
    // No headings — treat the whole thing as a free-form goal so pre-v1
    // or manually-kicked tasks still show something.
    return { ...empty, hasContent: true, goal: raw };
  }

  const pick = (rx: any) => sections.find((s: any) => rx.test(s.title)) ?? null;
  const goal = pick(/^goal\b/i)?.body ?? null;
  const context = pick(/^context\b/i)?.body ?? null;
  const skillsSection = pick(/^skills to load$|^skills$/i);
  const roleManifest = parseRoleManifest(pick(/^role manifest\b/i)?.body ?? '');
  const constraints = parseBullets(pick(/^constraints\b/i)?.body ?? '');
  const deliverables = parseBullets(pick(/^deliverables\b/i)?.body ?? '');
  const acceptance = parseBullets(pick(/^acceptance\b/i)?.body ?? '');
  const priorRound = pick(/^prior round\b/i)?.body ?? null;
  const escapeHatch = pick(/^escape hatch\b/i)?.body ?? null;

  // Skills are bullet-listed before a freeform path-resolution footer.
  // Stop at the first blank line so we only keep the ids.
  const skills = [];
  if (skillsSection) {
    for (const line of skillsSection.body.split(/\r?\n/)) {
      if (!line.trim()) break;
      const m = /^\s*-\s+(\S+)/.exec(line);
      if (m) skills.push(m[1].trim());
    }
  }

  return {
    hasContent: true,
    goal,
    context,
    skills,
    ...roleManifest,
    constraints,
    deliverables,
    acceptance,
    priorRound,
    escapeHatch,
    raw,
  };
}

// Goal-mode prompts are file-first pointers: the durable rubric lives in a
// GoalAgentSpec markdown file and the framed prompt only references it.
// Recognized pointer shapes (in priority order):
//   1. "Read and execute:" followed by an absolute .md path (Claude /goal)
//   2. "Complete the GoalAgentSpec at <path>." (Codex /goal)
//   3. a bare absolute path ending in GOAL_AGENT_SPEC.md anywhere in the text
function extractGoalSpecPath(text: any) {
  if (isExternalTicketPrompt(text)) return null;
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const readAndExecute = /Read and execute:\s*\n?\s*(\/[^\n\s]+\.md)\b/i.exec(raw);
  if (readAndExecute) return readAndExecute[1];
  const goalSpecAt = /GoalAgentSpec at\s+(\/[^\n\s]+\.md)\b/i.exec(raw);
  if (goalSpecAt) return goalSpecAt[1];
  const bareSpec = /(\/[^\n\s'"`]+GOAL_AGENT_SPEC\.md)\b/.exec(raw);
  if (bareSpec) return bareSpec[1];
  return null;
}

const PROMPT_MARKDOWN_MAX_SOURCES = 8;

function extractPromptMarkdownPaths(text: any) {
  if (isExternalTicketPrompt(text)) return [];
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const matches = [];
  const quotedRx = /(["'`])(\/[^"'`\r\n]*?\.md)\1/gi;
  const unquotedRx = /\/[^\s'"`<>]+?\.md(?=$|[\s'"`<>)\],.;:!?])/gi;
  for (const match of raw.matchAll(quotedRx)) {
    matches.push({ index: match.index ?? 0, path: match[2] });
  }
  for (const match of raw.matchAll(unquotedRx)) {
    matches.push({ index: match.index ?? 0, path: match[0] });
  }
  matches.sort((a, b) => a.index - b.index);

  const paths = [];
  const seen = new Set();
  for (const match of matches) {
    const sourcePath = String(match.path || '').trim();
    if (!sourcePath || sourcePath.startsWith('//')) continue;
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    paths.push(sourcePath);
    if (paths.length >= PROMPT_MARKDOWN_MAX_SOURCES) break;
  }
  return paths;
}

// 512KB is far above any real spec (they run ~5-50KB); the cap only guards
// against a pathological pointer (e.g. a prompt referencing a huge log.md)
// flooding the renderer over IPC.
const GOAL_SPEC_MAX_BYTES = 512 * 1024;

function readGoalSpecMarkdown(specPath: any) {
  const target = String(specPath || '').trim();
  if (!target || !target.endsWith('.md')) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(target, 'utf8');
    if (content.length > GOAL_SPEC_MAX_BYTES) {
      return `${content.slice(0, GOAL_SPEC_MAX_BYTES)}\n\n…(spec truncated at 512KB)`;
    }
    return content;
  } catch {
    // Spec file may live on a volume that is gone, or the run dir was cleaned
    // up. The sidecar falls back to rendering the framed prompt itself.
    return null;
  }
}

function markdownSourceName(sourcePath: any) {
  const target = String(sourcePath || '').trim();
  return target.split('/').pop() || target;
}

function readPromptMarkdownSources(text: any) {
  const sources = [];
  for (const sourcePath of extractPromptMarkdownPaths(text)) {
    const markdown = readGoalSpecMarkdown(sourcePath);
    if (markdown == null) continue;
    sources.push({
      path: sourcePath,
      name: markdownSourceName(sourcePath),
      markdown,
    });
  }
  return sources;
}

// Factory: closes over the db + statement bag + metadata cache that
// local-core.cjs already maintains. Returned fn is what the IPC handler
// calls. Shape matches the frontend contract in src/lib/ace-api.ts.
function createGetTaskSpec({ stmts, db, workspaceMetaCache }: any) {
  return function getTaskSpec({ taskId }: any = {}) {
    if (!taskId) throw new Error('getTaskSpec: taskId required');
    const task = stmts.getTaskById.get(taskId);
    if (!task) throw new Error('getTaskSpec: task not found');
    const worktree = db
      .prepare('SELECT * FROM worktrees WHERE task_id=? LIMIT 1')
      .get(taskId) || null;
    const project = stmts.getProjectById.get(task.project_id) || null;
    const branch = worktree ? worktree.branch : null;
    const baseBranch = worktree
      ? worktree.base_branch
      : project?.default_branch ?? null;

    // PR lookup: reuse the cached open-PR map the main `projectWorkspaces`
    // reader already populates. Nothing to fetch — just match by headRef.
    let prUrl = null;
    let prNumber = null;
    if (branch && workspaceMetaCache) {
      const meta = workspaceMetaCache.get(task.project_id);
      const prs = meta?.openPrs ?? [];
      const pr = prs.find((p: any) => p.headRef === branch);
      if (pr) {
        prUrl = pr.url || null;
        prNumber = pr.number || null;
      }
    }
    // Resolve trusted local prompt references fresh on every call. Both path
    // extractors refuse external-ticket prompts; their raw text remains visible.
    const goalSpecPath = extractGoalSpecPath(task.initial_prompt);
    const goalSpecMarkdown = goalSpecPath ? readGoalSpecMarkdown(goalSpecPath) : null;
    const promptMarkdownSources = readPromptMarkdownSources(task.initial_prompt);

    return {
      taskId,
      name: task.name,
      agent: task.primary_agent,
      initialPrompt: task.initial_prompt || null,
      branch,
      baseBranch,
      worktreePath: worktree ? worktree.path : null,
      archivedAt: task.archived_at || null,
      prNumber,
      prUrl,
      goalSpecPath,
      goalSpecMarkdown,
      promptMarkdownSources,
    };
  };
}

module.exports = {
  parseInitialPrompt,
  createGetTaskSpec,
  extractGoalSpecPath,
  extractPromptMarkdownPaths,
  readGoalSpecMarkdown,
  readPromptMarkdownSources,
};
