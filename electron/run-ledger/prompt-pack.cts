// prompt-pack — the LEAN orchestration prompt pattern. Assemble a compact
// worker/validator/orchestrator prompt from a RunSpec: objective + output
// contract + boundaries + halt + acceptance A-IDs + skill-id POINTERS + a
// minimal driver keyword pack.
//
// This is the deliberate ANTI-goal-agent-spec. tools/ace/src/goal-agent-
// spec.cts is a ~999-line markdown embedder that inlines whole doctrine bodies
// (rubric contracts, behavioral-plan prose, checkmark sections). That bloat
// burns the worker's attention budget. Here we POINT at skills (skill:<id>)
// and emit only trigger keywords — the runtime/worker materializes the rest.
// Doctrine for this pattern lives in:
//   - skill:ace-prompt-enhancer  (objective/output/boundaries shape)
//   - skill:claude-codex-specialty-router  (driver pick + keyword packs)
// We do NOT copy those bodies in; we reference them.
//
// Pure module: no I/O, no clocks, no Date.now()/Math.random(). The prompt is a
// deterministic function of (runspec, opts), so it is trivially testable.

// Frozen ordered section keys — the spine of every assembled prompt.
const PROMPT_PACK_SECTIONS = Object.freeze([
  'objective',
  'context',
  'outputContract',
  'boundaries',
  'acceptance',
  'halt',
  'skills',
  'driverPack',
]);

// The DONE:/BLOCKED: trailer contract every Ace worker must honor. Parsed
// downstream by tools/ace/src/verdict.cts; keep this string stable.
const DONE_BLOCKED_CONTRACT =
  'End with exactly one trailer: `DONE: <one-line result>` or `BLOCKED: <one-line reason>`.';

// Minimal driver keyword packs — POINTERS, not doctrine. A few trigger words
// each, modeled on claude-codex-specialty-router. The runtime injects the full
// pack from tools/ace/src/driver-packs.cts; this is the compact in-prompt
// nudge only. Keep these short on purpose.
const DRIVER_PACKS = Object.freeze({
  claude: Object.freeze(['/effort xhigh', 'plan-first', 'hold-ambiguity', 'judgment', 'surgical']),
  codex: Object.freeze(['/goal', 'bias-to-action', 'apply_patch', 'deterministic', 'multi_tool_use.parallel']),
});

// Driver heuristic mirroring claude-codex-specialty-router doctrine: planning /
// ambiguity / review / design / user-visible → claude (judgment); deterministic
// / refactor / migration / high-volume → codex (throughput). Tie-break is
// ambiguity → claude, so codex only wins when it matches and claude does not.
const CLAUDE_KEYWORDS = Object.freeze([
  'plan', 'design', 'architect', 'ambig', 'unclear', 'review', 'debug',
  'root cause', 'investigate', 'orchestrat', 'ui', 'ux', 'product', 'research', 'prd',
]);
const CODEX_KEYWORDS = Object.freeze([
  'refactor', 'rename', 'migrat', 'implement', 'backend', 'api', 'pipeline',
  'scaffold', 'high-volume', 'mechanical', 'bulk', 'codegen', 'deterministic',
]);

function cleanLines(items: any) {
  return (Array.isArray(items) ? items : [])
    .map((line: any) => String(line == null ? '' : line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function compactLine(value: any, maxChars = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

// Pick the driver by task shape. runspec.driver wins if it's a known engine;
// otherwise classify goal+mode text. Default claude (router tie-break).
function pickDriver(runspec: any = {}) {
  const explicit = String(runspec && runspec.driver || '').toLowerCase().trim();
  if (explicit === 'claude' || explicit === 'codex') return explicit;
  const text = `${String(runspec.goal || '')} ${String(runspec.mode || '')}`.toLowerCase();
  if (text.includes('valid') || text.includes('review')) return 'claude';
  const codexHit = CODEX_KEYWORDS.some((kw) => text.includes(kw));
  const claudeHit = CLAUDE_KEYWORDS.some((kw) => text.includes(kw));
  if (codexHit && !claudeHit) return 'codex';
  return 'claude';
}

// Acceptance A-IDs as a checklist. Accepts {id,text} rows; falls back to a
// stable A<n> id when a row omits its own id. A0 is the in-scope guarantee.
function acceptanceChecklist(acceptance: any) {
  const rows = Array.isArray(acceptance) ? acceptance : [];
  const lines = ['- [ ] A0: no out-of-scope change (stay inside allowed paths)'];
  rows.forEach((row: any, i: number) => {
    const text = compactLine(row && row.text != null ? row.text : row, 200);
    if (!text) return;
    const id = String(row && row.id || '').trim() || `A${i + 1}`;
    lines.push(`- [ ] ${id}: ${text}`);
  });
  return lines.join('\n');
}

// Optional CONTEXT carried by a richer brain (e.g. goal launch's Hermes intake
// brief + orchestration constraints). Empty for a lean `run submit`, so the
// prompt stays minimal by default. Newlines preserved (brief structure matters);
// bounded so a runaway brief can't blow the attention budget.
function contextBlock(context: any, constraints: any) {
  const ctx = String(context == null ? '' : context).trim();
  const rules = cleanLines(constraints);
  const parts = [];
  if (ctx) parts.push(ctx.length > 2000 ? `${ctx.slice(0, 1999).trim()}…` : ctx);
  if (rules.length) parts.push(rules.map((rule: string) => `- ${rule}`).join('\n'));
  return parts.join('\n');
}

function boundariesBlock(boundaries: any = {}) {
  const allowed = cleanLines(boundaries.allowedPaths);
  const never = cleanLines(boundaries.neverTouch);
  const parts = [];
  parts.push(`allowed paths: ${allowed.length ? allowed.join(', ') : '(unspecified — confirm before writing)'}`);
  if (never.length) parts.push(`never touch: ${never.join(', ')}`);
  return parts.join('\n');
}

function haltBlock(halt: any = {}) {
  const parts = [];
  const maxIterations = Number(halt.maxIterations);
  if (Number.isFinite(maxIterations) && maxIterations > 0) {
    parts.push(`stop after ${maxIterations} iteration(s) without progress and emit BLOCKED:`);
  }
  const tokenCap = Number(halt.tokenCap);
  if (Number.isFinite(tokenCap) && tokenCap > 0) {
    parts.push(`token cap ${tokenCap}: wrap up and emit a trailer before exceeding it`);
  }
  if (!parts.length) parts.push('halt on a clear blocker; do not loop or guess — emit BLOCKED:');
  return parts.map((line) => `- ${line}`).join('\n');
}

// Skill POINTERS only — never bodies. Each id is rendered as `skill:<id>` so the
// worker loads it JIT. Strips any leading `skill:` a caller already added.
function skillPointers(skillIds: any) {
  const ids = cleanLines(skillIds).map((id: string) => id.replace(/^skill:/i, ''));
  if (!ids.length) return { ids, line: '' };
  const line = `Load skills (pointers, not pasted bodies): ${ids.map((id: string) => `skill:${id}`).join(', ')}`;
  return { ids, line };
}

/**
 * Assemble a compact worker/validator/orchestrator prompt from a RunSpec.
 * Returns { prompt, skillIds, driver, chars }.
 *
 * @param {Object} runspec  goal, mode, acceptance[{id,text}], boundaries
 *   {allowedPaths, neverTouch?}, halt {maxIterations?, tokenCap?}, skillIds[],
 *   driver?
 * @param {Object} [opts]   reserved for future tuning; unused today (lean).
 */
function buildWorkerPrompt(runspec: any = {}, opts: any = {}) {
  const goal = compactLine(runspec.goal, 280) || '(no goal supplied)';
  const mode = String(runspec.mode || 'build').replace(/\s+/g, ' ').trim() || 'build';
  const driver = pickDriver(runspec);
  const { ids: skillIds, line: skillsLine } = skillPointers(runspec.skillIds);
  const pack = DRIVER_PACKS[driver as 'claude' | 'codex'] || DRIVER_PACKS.claude;

  const contextText = contextBlock(runspec.context, runspec.constraints);
  const sections: Record<string, string> = {
    objective: `# Objective (${mode})\n${goal}`,
    context: contextText ? `# Context\n${contextText}` : '',
    outputContract: `# Output contract\n${DONE_BLOCKED_CONTRACT}`,
    boundaries: `# Boundaries\n${boundariesBlock(runspec.boundaries)}`,
    acceptance: `# Acceptance (self-check each A-ID)\n${acceptanceChecklist(runspec.acceptance)}`,
    halt: `# Halt\n${haltBlock(runspec.halt)}`,
    skills: skillsLine ? `# Skills\n${skillsLine}` : '',
    driverPack: `# Driver pack (${driver})\n${pack.join(' · ')}`,
  };

  const prompt = PROMPT_PACK_SECTIONS
    .map((key) => sections[key])
    .filter(Boolean)
    .join('\n\n');

  return { prompt, skillIds, driver, chars: prompt.length };
}

/**
 * Char-count estimate for a runspec without retaining the prompt string. Used by
 * callers budgeting context before dispatch.
 */
function estimatePromptChars(runspec: any = {}, opts: any = {}) {
  return buildWorkerPrompt(runspec, opts).chars;
}

module.exports = {
  PROMPT_PACK_SECTIONS,
  DONE_BLOCKED_CONTRACT,
  buildWorkerPrompt,
  estimatePromptChars,
  pickDriver,
};
