// Frontend mirror of electron/task-spec.cjs#parseInitialPrompt.
// The initial_prompt column stores the framed markdown that
// tools/ace/src/prompt.cjs writes at delegation time. Parsing
// here turns it into the goal / skills / acceptance fields the
// worker-tab spec pane renders. Keep regex in sync with the CJS copy.

export type ParsedTaskSpec = {
  hasContent: boolean;
  goal: string | null;
  context: string | null;
  skills: string[];
  roleMode: string | null;
  skillPack: string | null;
  capabilities: string[];
  taskPackSkills: string[];
  constraints: string[];
  deliverables: string[];
  acceptance: string[];
  priorRound: string | null;
  escapeHatch: string | null;
  raw: string;
};

export type PromptMarkdownSource = {
  path: string;
  name: string;
  markdown: string;
};

export type TaskSpecResult = {
  taskId: string;
  name: string;
  agent: string;
  initialPrompt: string | null;
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  archivedAt: string | null;
  prNumber: number | null;
  prUrl: string | null;
  // GoalAgentSpec resolution (electron/task-spec.cts#extractGoalSpecPath):
  // when the framed prompt points at a spec file, its path + markdown body
  // arrive here so manual spec views can render the full rubric.
  goalSpecPath?: string | null;
  goalSpecMarkdown?: string | null;
  // Readable absolute .md files mentioned in initialPrompt, rendered as
  // read-only filename tabs beside worker tabs.
  promptMarkdownSources?: PromptMarkdownSource[];
};

type Section = { title: string; body: string };

function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() });
      current = { title: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() });
  return sections;
}

function parseBullets(body: string): string[] {
  const items: string[] = [];
  let buf: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const m = /^\s*-\s+(.*)$/.exec(raw);
    if (m) {
      if (buf !== null) items.push(buf.trim());
      buf = m[1];
    } else if (buf !== null) {
      buf += raw.trim() ? `\n${raw}` : '';
    }
  }
  if (buf !== null) items.push(buf.trim());
  return items.filter(Boolean);
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseRoleManifest(body: string) {
  const out = {
    roleMode: null as string | null,
    skillPack: null as string | null,
    capabilities: [] as string[],
    taskPackSkills: [] as string[],
  };
  for (const raw of body.split(/\r?\n/)) {
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

export function parseInitialPrompt(text: string | null | undefined): ParsedTaskSpec {
  const raw = (text ?? '').trim();
  const empty: ParsedTaskSpec = {
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
  if (!sections.length) return { ...empty, hasContent: true, goal: raw };

  const pick = (rx: RegExp) => sections.find((s) => rx.test(s.title)) ?? null;
  const skillsSection = pick(/^skills to load$|^skills$/i);
  const skills: string[] = [];
  if (skillsSection) {
    for (const line of skillsSection.body.split(/\r?\n/)) {
      if (!line.trim()) break;
      const m = /^\s*-\s+(\S+)/.exec(line);
      if (m) skills.push(m[1].trim());
    }
  }
  const roleManifest = parseRoleManifest(pick(/^role manifest\b/i)?.body ?? '');
  return {
    hasContent: true,
    goal: pick(/^goal\b/i)?.body ?? null,
    context: pick(/^context\b/i)?.body ?? null,
    skills,
    ...roleManifest,
    constraints: parseBullets(pick(/^constraints\b/i)?.body ?? ''),
    deliverables: parseBullets(pick(/^deliverables\b/i)?.body ?? ''),
    acceptance: parseBullets(pick(/^acceptance\b/i)?.body ?? ''),
    priorRound: pick(/^prior round\b/i)?.body ?? null,
    escapeHatch: pick(/^escape hatch\b/i)?.body ?? null,
    raw,
  };
}
