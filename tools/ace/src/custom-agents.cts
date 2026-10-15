// Custom-agent doctrine generator. Materializes the NATIVE files the CLIs read
// so a specialized agent boots with baked-in role doctrine + engineering skills
// + driver precision keywords, instead of rediscovering everything each run:
//   - Claude: .claude/agents/<role>.md   (frontmatter + system-prompt body)
//   - Codex : .codex/agents/<role>.toml  (developer_instructions) + a delimited
//             managed block appended to AGENTS.md (never clobbers existing files)
//
// Role doctrine is referenced by skill id (never inlined); driver precision
// keywords come from driver-packs.cts.
// Seeded from the existing ace-agent-pack-* skills.

const fs = require('fs');
const path = require('path');
const { CLAUDE_DRIVER_PACK, CODEX_DRIVER_PACK } = require('./driver-packs.cjs');

const MANAGED_BEGIN = '<!-- ace:managed:agents:begin -->';
const MANAGED_END = '<!-- ace:managed:agents:end -->';

// Each custom agent: a role identity + a curated skill pack (referenced, not
// inlined) + a one-paragraph contract. The agent-pack skill carries the domain
// contract alongside the shared runtime baseline.
const CUSTOM_AGENTS: Record<string, any> = {
  engineer: {
    description: 'General code implementation, fixes, and tests. Use for scoped feature/bug work.',
    skills: ['ace-agent-pack-engineer', 'ace-task-worker'],
    contract: 'You are a coding engineer. Read the local scaffold and nearby code before editing. Keep changes surgical and scoped. Prefer existing helpers and test style. Verify behaviour with the smallest check and report evidence.',
  },
  backend: {
    description: 'Backend, API, data, IPC, CLI, and persistence work. Use for contract-bearing server changes.',
    skills: ['ace-agent-pack-backend', 'ace-task-worker'],
    contract: 'You are a backend engineer. Identify the contract first (API shape, schema, event). Preserve caller behaviour unless the brief changes it. Add focused tests around contract + failure paths. Never hide backend failures behind frontend fallbacks.',
  },
  'ui-designer': {
    description: 'Frontend, UX, product surface, layout, and interaction. Use for user-facing UI work.',
    skills: ['ace-agent-pack-ui-designer', 'steipete-frontend-design', 'ace-task-worker'],
    contract: 'You are a UI/product engineer. Build the real workflow first, not a marketing shell. Preserve backend wiring. Match the design-system conventions. Verify on desktop and mobile.',
  },
  security: {
    description: 'Auth, secrets, permissions, sandboxing, and supply-chain review. Use for security-sensitive work.',
    skills: ['ace-agent-pack-security', 'trailofbits-security-review', 'ace-task-worker'],
    contract: 'You are a security reviewer. Threat-model first, inspect sensitive paths, and prefer concrete exploit paths over generic advice. Never print secrets. Separate findings by severity and confidence.',
  },
  architect: {
    description: 'Architecture, system design, and cross-module planning. Use before large or cross-cutting change.',
    skills: ['ace-agent-pack-architect', 'ace-rubric-first', 'ace-task-worker'],
    contract: 'You are an architect. Start from current repo evidence. Name invariants and the files that hold them. Choose the smallest design that keeps implementation obvious. Split by ownership boundaries.',
  },
  reviewer: {
    description: 'Read-only PR/diff review against the PRD outcomes. Use to validate a worker PR.',
    skills: ['ace-validator-worker', 'autoreview'],
    contract: 'You are a single read-only reviewer. Grade the diff against the PRD outcomes; never edit code. Emit exactly one verdict: PASS or REQUEST-CHANGES with file-scoped reasons.',
  },
  'research-grill': {
    description: 'Research + grill the owner + write a PRD, then implement via internal sub-agents. Use for BIG tasks.',
    skills: ['ace-grill-prd', 'ace-hermes-router', 'mp-grill-with-docs', 'mp-to-prd', 'ace-rubric-first'],
    contract: 'You are a research+grill+PRD agent. Grill the owner until ambiguity is gone, research the blast radius, write a PRD (goal, non-goals, outcome-level done, allowed-paths), then implement via internal sub-agents only. No orchestra.',
  },
};

function driverPackFor(driver: any) {
  return String(driver).toLowerCase() === 'codex' ? CODEX_DRIVER_PACK : CLAUDE_DRIVER_PACK;
}

// Resolve a custom-agent role from a worker's resolved skill ids (the
// agent-pack skill is the role signal). Returns null when no role applies.
function roleFromSkillIds(skillIds: any) {
  const ids = Array.isArray(skillIds) ? skillIds.map((s: any) => String(s)) : [];
  if (ids.includes('ace-grill-prd')) return 'research-grill';
  if (ids.includes('ace-validator-worker')) return 'reviewer';
  for (const id of ids) {
    const m = /^ace-agent-pack-(.+)$/.exec(id);
    if (m && CUSTOM_AGENTS[m[1]]) return m[1];
  }
  return null;
}

function listCustomAgents() {
  return Object.keys(CUSTOM_AGENTS);
}

function getCustomAgent(role: any) {
  return CUSTOM_AGENTS[String(role || '').trim().toLowerCase()] || null;
}

// Build the Claude `.claude/agents/<role>.md` content (YAML frontmatter + body).
function claudeAgentFile(role: any, def: any, opts: any = {}) {
  const model = opts.model || 'claude-opus-4-8';
  const front = [
    '---',
    `name: ${role}`,
    `description: ${def.description}`,
    `model: ${model}`,
    `skills: [${def.skills.join(', ')}]`,
    '---',
    '',
  ].join('\n');
  const body = [
    `# ${role}`,
    '',
    def.contract,
    '',
    '## Load these skills (reference, do not inline)',
    ...def.skills.map((s: any) => `- ${s}`),
    '',
    '## Driver precision',
    driverPackFor('claude'),
    '',
    '## Done',
    'Express done as observable outcomes; you choose and write your own tests. End with `DONE: <summary>` or `BLOCKED: <reason>`.',
    '',
  ].join('\n');
  return front + body;
}

// Build the Codex `.codex/agents/<role>.toml` content.
function codexAgentFile(role: any, def: any, opts: any = {}) {
  const effort = opts.effort || 'xhigh';
  const instructions = [
    def.contract,
    '',
    'Load these skills (reference, do not inline): ' + def.skills.join(', ') + '.',
    '',
    driverPackFor('codex'),
    '',
    'Express done as observable outcomes; you choose and write your own tests. End with DONE: <summary> or BLOCKED: <reason>.',
  ].join('\n');
  // TOML with a multi-line basic string for developer_instructions.
  const esc = instructions.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return [
    `name = "${role}"`,
    `description = "${def.description.replace(/"/g, '\\"')}"`,
    `model_reasoning_effort = "${effort}"`,
    'developer_instructions = """',
    esc,
    '"""',
    '',
  ].join('\n');
}

function upsertManagedBlock(filePath: any, block: any) {
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch {}
  const managed = `${MANAGED_BEGIN}\n${block}\n${MANAGED_END}`;
  const re = new RegExp(`${MANAGED_BEGIN}[\\s\\S]*?${MANAGED_END}`);
  let next;
  if (re.test(existing)) {
    next = existing.replace(re, managed);
  } else {
    next = (existing ? existing.replace(/\s*$/, '\n\n') : '') + managed + '\n';
  }
  fs.writeFileSync(filePath, next);
}

// Materialize the native doctrine files for `role` + `driver` into `worktreeDir`.
// Never clobbers the user's existing CLAUDE.md/AGENTS.md — Codex doctrine rides
// in a delimited managed block.
function generateAgentDoctrine(worktreeDir: any, role: any, driver: any, opts: any = {}) {
  const def = getCustomAgent(role);
  if (!def) return { ok: false, reason: `unknown custom agent: ${role}` };
  const written: string[] = [];
  const d = String(driver || 'claude').toLowerCase();
  if (d === 'claude') {
    const dir = path.join(worktreeDir, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${role}.md`);
    fs.writeFileSync(f, claudeAgentFile(role, def, opts));
    written.push(f);
  } else if (d === 'codex') {
    const dir = path.join(worktreeDir, '.codex', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${role}.toml`);
    fs.writeFileSync(f, codexAgentFile(role, def, opts));
    written.push(f);
    // Codex reads AGENTS.md for durable doctrine — append a managed block.
    const agentsMd = path.join(worktreeDir, 'AGENTS.md');
    upsertManagedBlock(agentsMd, [
      `## Ace agent: ${role}`,
      def.contract,
      `Skills: ${def.skills.join(', ')}.`,
    ].join('\n'));
    written.push(agentsMd);
  }
  return { ok: true, role, driver: d, written };
}

module.exports = {
  CUSTOM_AGENTS,
  listCustomAgents,
  getCustomAgent,
  roleFromSkillIds,
  claudeAgentFile,
  codexAgentFile,
  generateAgentDoctrine,
  MANAGED_BEGIN,
  MANAGED_END,
};
