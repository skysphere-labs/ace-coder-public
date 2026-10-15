/**
 * ops-todos.cts
 *
 * Self-contained, JSON-backed, fail-safe todo store for ace.ops.todo.v1.
 *
 * NO electron/store/IPC imports — only Node built-ins fs, os, path.
 * Zero hardcoded http(s) URLs or account ids.
 *
 * All exported functions are fail-safe: they never throw on I/O errors.
 * Empty/whitespace text for addTodo returns null without writing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Default file path
// ---------------------------------------------------------------------------

function homeDotfilePath(fileName: string): string {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), fileName);
}

function defaultFilePath(): string {
  return homeDotfilePath('ops-todos.json');
}

function defaultDigestPath(): string {
  return homeDotfilePath('ops-todo-digest.json');
}

// ---------------------------------------------------------------------------
// Types (plain objects only — do not import from src/)
// ---------------------------------------------------------------------------

interface OpsTodo {
  $schema: 'ace.ops.todo.v1';
  id: string;
  text: string;
  kind: 'dev' | 'life' | 'company' | 'unclassified';
  owner: string | null;
  status: 'open' | 'assigned' | 'promoted' | 'done';
  createdAt: string;
  updatedAt: string;
  promotedMissionId: string | null;
  notes: string | null;
  source: string | null;
  workspaceId: string | null;
  priority: 'low' | 'medium' | 'high' | null;
  dueAt: string | null;
  tags: string[];
}

interface AddTodoInput {
  text: string;
  kind?: 'dev' | 'life' | 'company' | 'unclassified';
  owner?: string | null;
  notes?: string | null;
  source?: string | null;
  workspaceId?: string | null;
  priority?: 'low' | 'medium' | 'high' | null;
  dueAt?: string | null;
  tags?: string[];
}

interface PatchTodoInput {
  text?: string;
  kind?: 'dev' | 'life' | 'company' | 'unclassified';
  owner?: string | null;
  status?: 'open' | 'assigned' | 'promoted' | 'done';
  promotedMissionId?: string | null;
  notes?: string | null;
  source?: string | null;
  workspaceId?: string | null;
  priority?: 'low' | 'medium' | 'high' | null;
  dueAt?: string | null;
  tags?: string[];
}

interface Opts {
  filePath?: string;
  now?: string;
}

// ace.ops.todo-digest.v1 — twice-daily auto-organized PROPOSALS over the
// open todo set. Rule-based only: grouping, outcome restatements, and next-step
// suggestions all come from deterministic rules, never from model judgment.
interface TodoDigest {
  $schema: 'ace.ops.todo-digest.v1';
  slot: 'morning' | 'night';
  generatedAt: string;
  openCount: number;
  groups: Array<{ label: string; todoIds: string[] }>;
  goals: Array<{ text: string; todoIds: string[] }>;
  suggestions: Array<{ todoId: string; text: string; suggestion: string }>;
  markdown: string;
  // Provenance. 'rules' = the deterministic synthesizeTodoDigest below (the
  // default, and the fail-closed fallback on ANY agent failure); 'agent' = a
  // headless agent refined the goals + next-step suggestions over the SAME open
  // set. Never implies auto-promotion — both paths are proposals only.
  source: 'agent' | 'rules';
}

interface DigestOpts {
  filePath?: string;
  now?: string | number;
  slot?: 'morning' | 'night';
}

// ---------------------------------------------------------------------------
// Private read/write helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a caller/persisted tags value: strings only, '#' stripped,
 * lowercased, trimmed, deduped (insertion order kept). Anything else -> [].
 */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.replace(/^#+/, '').trim().toLowerCase();
    if (tag && out.indexOf(tag) === -1) out.push(tag);
  }
  return out;
}

/**
 * Extract `#hashtag` tokens from free text: lowercased, deduped, '#' stripped.
 * The hashtags stay in the text — extraction never rewrites the note.
 */
function extractHashtags(text: string): string[] {
  const out: string[] = [];
  try {
    const matches = String(text).match(/#[a-z0-9][a-z0-9_-]*/gi) || [];
    for (const m of matches) {
      const tag = m.slice(1).toLowerCase();
      if (tag && out.indexOf(tag) === -1) out.push(tag);
    }
  } catch {
    // tag extraction is convenience-only; never block a write
  }
  return out;
}

/**
 * Normalize a persisted record to the current OpsTodo shape.
 * Older records (pre notes/source/workspaceId/priority/dueAt/tags) get
 * null defaults; missing tags normalize to [].
 */
function normalizeTodo(raw: Record<string, unknown>): OpsTodo {
  const todo = raw as unknown as OpsTodo;
  return Object.assign({}, todo, {
    notes: todo.notes !== undefined ? todo.notes : null,
    source: todo.source !== undefined ? todo.source : null,
    workspaceId: todo.workspaceId !== undefined ? todo.workspaceId : null,
    priority: todo.priority !== undefined ? todo.priority : null,
    dueAt: todo.dueAt !== undefined ? todo.dueAt : null,
    tags: normalizeTags(todo.tags),
  });
}

function readTodos(filePath: string): OpsTodo[] {
  try {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return (parsed as Record<string, unknown>[]).map(normalizeTodo);
  } catch {
    return [];
  }
}

function writeTodos(filePath: string, todos: OpsTodo[]): void {
  try {
    const dir: string = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(todos, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ops-todos] write failed:', (err as Error).message);
  }
}

function generateId(now: string): string {
  const ts: number = new Date(now).getTime();
  const rand: string = Math.random().toString(36).slice(2, 8);
  return `todo-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// listTodos
// ---------------------------------------------------------------------------

/**
 * Read all todos from the JSON file. Missing/corrupt file -> [].
 * Sorted newest-first by createdAt.
 */
function listTodos(opts?: Opts): OpsTodo[] {
  const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultFilePath();
  const todos: OpsTodo[] = readTodos(filePath);
  return todos.slice().sort((a, b) => {
    const ta: number = new Date(a.createdAt).getTime();
    const tb: number = new Date(b.createdAt).getTime();
    return tb - ta;
  });
}

// ---------------------------------------------------------------------------
// addTodo
// ---------------------------------------------------------------------------

/**
 * Create a new todo and persist it.
 * Returns null (without writing) if text is empty/whitespace.
 * Never throws.
 */
function addTodo(input: AddTodoInput, opts?: Opts): OpsTodo | null {
  try {
    const text: string = (input && input.text) ? String(input.text) : '';
    if (!text.trim()) {
      return null;
    }

    const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultFilePath();
    const now: string = (opts && opts.now) ? opts.now : new Date().toISOString();

    // Tags = explicit input tags + auto-extracted #hashtags from the text
    // (hashtags stay in the text). normalizeTags dedupes the union.
    const tags: string[] = normalizeTags(
      (Array.isArray(input.tags) ? input.tags : []).concat(extractHashtags(text))
    );

    const todo: OpsTodo = {
      $schema: 'ace.ops.todo.v1',
      id: generateId(now),
      text: text.trim(),
      kind: (input.kind ?? 'unclassified') as 'dev' | 'life' | 'company' | 'unclassified',
      owner: (input.owner !== undefined ? input.owner : null) as string | null,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      promotedMissionId: null,
      notes: (input.notes !== undefined ? input.notes : null) as string | null,
      source: (input.source !== undefined ? input.source : null) as string | null,
      workspaceId: (input.workspaceId !== undefined ? input.workspaceId : null) as string | null,
      priority: (input.priority !== undefined ? input.priority : null) as 'low' | 'medium' | 'high' | null,
      dueAt: (input.dueAt !== undefined ? input.dueAt : null) as string | null,
      tags,
    };

    const todos: OpsTodo[] = readTodos(filePath);
    todos.push(todo);
    writeTodos(filePath, todos);
    return todo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// patchTodo
// ---------------------------------------------------------------------------

/**
 * Update fields on an existing todo. Updates updatedAt.
 * Unknown id -> null. Never throws.
 */
function patchTodo(id: string, patch: PatchTodoInput, opts?: Opts): OpsTodo | null {
  try {
    const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultFilePath();
    const now: string = (opts && opts.now) ? opts.now : new Date().toISOString();

    const todos: OpsTodo[] = readTodos(filePath);
    const idx: number = todos.findIndex((t) => t.id === id);
    if (idx === -1) return null;

    const existing: OpsTodo = todos[idx];
    const updated: OpsTodo = Object.assign({}, existing, {
      text: patch.text !== undefined ? String(patch.text) : existing.text,
      kind: patch.kind !== undefined ? patch.kind : existing.kind,
      owner: patch.owner !== undefined ? patch.owner : existing.owner,
      status: patch.status !== undefined ? patch.status : existing.status,
      promotedMissionId: patch.promotedMissionId !== undefined
        ? patch.promotedMissionId
        : existing.promotedMissionId,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      source: patch.source !== undefined ? patch.source : existing.source,
      workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : existing.workspaceId,
      priority: patch.priority !== undefined ? patch.priority : existing.priority,
      dueAt: patch.dueAt !== undefined ? patch.dueAt : existing.dueAt,
      tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags,
      updatedAt: now,
    });

    todos[idx] = updated;
    writeTodos(filePath, todos);
    return updated;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// removeTodo
// ---------------------------------------------------------------------------

/**
 * Delete a todo by id. Returns true if removed, false if not found.
 * Never throws.
 */
function removeTodo(id: string, opts?: Opts): boolean {
  try {
    const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultFilePath();
    const todos: OpsTodo[] = readTodos(filePath);
    const before: number = todos.length;
    const filtered: OpsTodo[] = todos.filter((t) => t.id !== id);
    if (filtered.length === before) return false;
    writeTodos(filePath, filtered);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// synthesizeTodoDigest — PURE, rule-based "auto-organized proposals"
// ---------------------------------------------------------------------------

// Stable kind ordering + display labels for groups/markdown.
const KIND_ORDER: Array<'dev' | 'company' | 'life' | 'unclassified'> = [
  'dev',
  'company',
  'life',
  'unclassified',
];
const KIND_LABELS: Record<string, string> = {
  dev: 'Dev',
  company: 'Company',
  life: 'Life',
  unclassified: 'Loose notes',
};

// Outcome verb per kind — a deterministic restatement, NOT an AI judgment.
function goalVerb(kind: string): string {
  if (kind === 'dev') return 'Ship';
  if (kind === 'company') return 'Decide';
  return 'Resolve';
}

// Rule-based next concrete step for one todo. No model involved.
function suggestNextStep(todo: OpsTodo): string {
  if (todo.kind === 'dev') {
    return todo.workspaceId
      ? `Promote to ticket in ${todo.workspaceId}`
      : 'Pick a target project, then promote';
  }
  if (todo.kind === 'life') return 'Schedule it';
  if (todo.kind === 'company') {
    return todo.owner ? 'Assign an owner or mark assigned' : 'Assign an owner';
  }
  return 'Classify it (dev / life / company), then route it';
}

/**
 * Synthesize the twice-daily digest from a todo list. PURE — no I/O, no
 * randomness; same todos + same opts.now => same digest. Only rule-based
 * organization happens here ("auto-organized proposals"): grouping by kind +
 * dominant tag, goal restatement for high-priority / due-soon items, and a
 * deterministic next-step suggestion per todo. Never throws.
 */
function synthesizeTodoDigest(
  todos: OpsTodo[],
  opts?: { now?: string | number; slot?: 'morning' | 'night' }
): TodoDigest {
  const slot: 'morning' | 'night' = opts && opts.slot === 'night' ? 'night' : 'morning';
  const nowMs: number = (() => {
    const raw = opts && opts.now !== undefined ? opts.now : Date.now();
    const ms = new Date(raw as string | number).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  })();
  const generatedAt: string = new Date(nowMs).toISOString();

  let open: OpsTodo[] = [];
  try {
    open = (Array.isArray(todos) ? todos : [])
      .map((t) => normalizeTodo(t as unknown as Record<string, unknown>))
      .filter((t) => t.status === 'open' || t.status === 'assigned')
      // Oldest-first inside the digest so groups read in capture order.
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } catch {
    open = [];
  }

  // ── Groups: kind, then dominant tag (the todo's tag that is most frequent
  // across the open set; frequency ties break alphabetically). Untagged todos
  // group under the bare kind label.
  const tagCounts: Record<string, number> = {};
  for (const t of open) {
    for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  const dominantTag = (t: OpsTodo): string | null => {
    let best: string | null = null;
    for (const tag of t.tags.slice().sort()) {
      if (best === null || (tagCounts[tag] || 0) > (tagCounts[best] || 0)) best = tag;
    }
    return best;
  };

  const groupMap: Record<string, { label: string; todoIds: string[] }> = {};
  const groupKeys: string[] = [];
  for (const kind of KIND_ORDER) {
    const ofKind = open.filter((t) => t.kind === kind);
    // Tagged sub-groups first (alphabetical by tag), bare-kind group last.
    const taggedKeys: string[] = [];
    for (const t of ofKind) {
      // Unclassified items are ALWAYS loose notes — a tag without a kind is
      // not enough to call something a project bucket.
      const tag = kind === 'unclassified' ? null : dominantTag(t);
      const key = tag ? `${kind}#${tag}` : kind;
      if (!groupMap[key]) {
        groupMap[key] = {
          label: tag ? `${KIND_LABELS[kind]} · #${tag}` : KIND_LABELS[kind],
          todoIds: [],
        };
        if (tag) taggedKeys.push(key);
        else groupKeys.push(key);
      }
      groupMap[key].todoIds.push(t.id);
    }
    // Re-order: tagged groups (alphabetical) before the bare-kind bucket.
    for (const key of taggedKeys.sort()) {
      const i = groupKeys.indexOf(kind);
      if (i === -1) groupKeys.push(key);
      else groupKeys.splice(i, 0, key);
    }
  }
  const groups = groupKeys.map((key) => groupMap[key]);

  // ── Goals: high-priority OR due-within-48h items restated as OUTCOMES.
  const dueSoonMs = 48 * 60 * 60 * 1000;
  const isGoal = (t: OpsTodo): boolean => {
    if (t.priority === 'high') return true;
    if (!t.dueAt) return false;
    const due = new Date(t.dueAt).getTime();
    return Number.isFinite(due) && due - nowMs <= dueSoonMs;
  };
  const goals = open
    .filter(isGoal)
    .map((t) => ({ text: `${goalVerb(t.kind)}: ${t.text}`, todoIds: [t.id] }));

  // ── Per-todo next-step suggestion (rule-based; see suggestNextStep).
  const suggestions = open.map((t) => ({
    todoId: t.id,
    text: t.text,
    suggestion: suggestNextStep(t),
  }));

  // ── Markdown render — clean headings, footer states the proposals-only
  // doctrine verbatim so the wiki copy can never be mistaken for AI output.
  const byId: Record<string, OpsTodo> = {};
  for (const t of open) byId[t.id] = t;
  const dateStr = generatedAt.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Todo digest — ${slot} ${dateStr}`);
  lines.push('');
  lines.push(`${open.length} open · auto-organized proposals`);
  lines.push('');
  lines.push('## Goals');
  if (goals.length === 0) {
    lines.push('_No high-priority or due-soon items._');
  } else {
    for (const goal of goals) lines.push(`- **${goal.text}**`);
  }
  lines.push('');
  lines.push('## By project');
  const projectGroups = groups.filter((g) => g.label !== KIND_LABELS.unclassified);
  if (projectGroups.length === 0) {
    lines.push('_Nothing grouped yet — add #tags or pick a kind._');
  } else {
    for (const group of projectGroups) {
      lines.push(`### ${group.label}`);
      for (const id of group.todoIds) {
        const t = byId[id];
        if (!t) continue;
        lines.push(`- ${t.text} — next: ${suggestNextStep(t)}`);
      }
      lines.push('');
    }
    lines.pop(); // drop the trailing blank from the last group
  }
  lines.push('');
  lines.push('## Loose notes');
  const looseGroup = groups.find((g) => g.label === KIND_LABELS.unclassified);
  if (!looseGroup || looseGroup.todoIds.length === 0) {
    lines.push('_None._');
  } else {
    for (const id of looseGroup.todoIds) {
      const t = byId[id];
      if (!t) continue;
      lines.push(`- ${t.text} — next: ${suggestNextStep(t)}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('Auto-organized proposals — nothing was auto-promoted.');
  lines.push('');

  return {
    $schema: 'ace.ops.todo-digest.v1',
    slot,
    generatedAt,
    openCount: open.length,
    groups,
    goals,
    suggestions,
    markdown: lines.join('\n'),
    source: 'rules',
  };
}

// ---------------------------------------------------------------------------
// synthesizeTodoDigestWithAgent — OPTIONAL headless-agent refinement, with a
// hard-timeout and byte-for-byte-honest deterministic fallback.
// ---------------------------------------------------------------------------

// The open+assigned set the digest reasons over, oldest-first (identical to the
// selection inside synthesizeTodoDigest) so agent-returned ids line up.
function selectOpenTodos(todos: OpsTodo[]): OpsTodo[] {
  try {
    return (Array.isArray(todos) ? todos : [])
      .map((t) => normalizeTodo(t as unknown as Record<string, unknown>))
      .filter((t) => t.status === 'open' || t.status === 'assigned')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } catch {
    return [];
  }
}

// Compact instruction: hand the agent the open todos and demand ONLY strict
// JSON referencing the given ids. No web, no files — pure reasoning.
function buildTodoDigestPrompt(open: OpsTodo[], slot: 'morning' | 'night'): string {
  const compact = open.map((t) => ({
    id: t.id,
    text: t.text,
    kind: t.kind,
    priority: t.priority,
    dueAt: t.dueAt,
    workspaceId: t.workspaceId,
    tags: t.tags,
  }));
  const lines: string[] = [];
  lines.push(`Organize this short todo list into a concise ${slot} digest.`);
  lines.push('Do NOT invent tasks. Only reference the todo ids given below.');
  lines.push('');
  lines.push('Todos (JSON):');
  lines.push(JSON.stringify(compact));
  lines.push('');
  lines.push('Return ONLY this JSON object — no prose, no markdown fences:');
  lines.push(
    '{"goals":[{"text":"<one-line outcome>","todoIds":["<id>"]}],' +
      '"suggestions":[{"todoId":"<id>","suggestion":"<one concrete next step>"}]}'
  );
  lines.push(
    'At most 5 goals (highest-leverage / most time-sensitive). One suggestion per ' +
      'todo you have concrete advice for. Every string under 120 chars. Never ' +
      'reference an id that is not in the list above.'
  );
  return lines.join('\n');
}

// Best-effort JSON extraction from an agent's free-text reply: direct parse,
// then a ```json fence, then the outermost {...} slice. Returns null on failure.
function extractJsonObject(raw: unknown): any {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const tryParse = (s: string): any => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let obj = tryParse(text);
  if (obj !== undefined) return obj;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    obj = tryParse(fence[1].trim());
    if (obj !== undefined) return obj;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    obj = tryParse(text.slice(start, end + 1));
    if (obj !== undefined) return obj;
  }
  return null;
}

// Validate + sanitize the agent's reply against the real open set. Drops any
// unknown id, empty string, or malformed entry. Returns null when nothing
// usable survives (so the caller falls back to the rules digest).
function parseAgentTodoDigest(
  raw: unknown,
  open: OpsTodo[]
): { goals: Array<{ text: string; todoIds: string[] }>; suggestions: Array<{ todoId: string; text: string; suggestion: string }> } | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;

  const openIds: Record<string, OpsTodo> = {};
  for (const t of open) openIds[t.id] = t;

  const goalsIn = Array.isArray(obj.goals) ? obj.goals : [];
  const goals: Array<{ text: string; todoIds: string[] }> = [];
  for (const g of goalsIn) {
    if (!g || typeof g !== 'object') continue;
    const text = typeof g.text === 'string' ? g.text.trim() : '';
    if (!text) continue;
    const ids: string[] = [];
    const rawIds = Array.isArray(g.todoIds) ? g.todoIds : [];
    for (const id of rawIds) {
      if (typeof id === 'string' && openIds[id] && ids.indexOf(id) === -1) ids.push(id);
    }
    // Every goal must trace to a real open todo — drop themed goals the agent
    // couldn't anchor to an id (honesty: no untethered outcomes).
    if (ids.length === 0) continue;
    goals.push({ text: text.slice(0, 200), todoIds: ids });
    if (goals.length >= 6) break;
  }

  const suggIn = Array.isArray(obj.suggestions) ? obj.suggestions : [];
  const suggestions: Array<{ todoId: string; text: string; suggestion: string }> = [];
  const seen: Record<string, true> = {};
  for (const s of suggIn) {
    if (!s || typeof s !== 'object') continue;
    const todoId = typeof s.todoId === 'string' ? s.todoId : '';
    if (!openIds[todoId] || seen[todoId]) continue;
    const suggestion = typeof s.suggestion === 'string' ? s.suggestion.trim() : '';
    if (!suggestion) continue;
    seen[todoId] = true;
    suggestions.push({ todoId, text: openIds[todoId].text, suggestion: suggestion.slice(0, 200) });
  }

  if (goals.length === 0 && suggestions.length === 0) return null;
  return { goals, suggestions };
}

// Markdown for the agent path — same headings shape as the rules digest, but a
// provenance line + footer that can never be mistaken for the deterministic one.
function buildAgentTodoDigestMarkdown(
  base: TodoDigest,
  parsed: { goals: Array<{ text: string; todoIds: string[] }>; suggestions: Array<{ todoId: string; text: string; suggestion: string }> }
): string {
  const dateStr = base.generatedAt.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Todo digest — ${base.slot} ${dateStr}`);
  lines.push('');
  lines.push(`${base.openCount} open · synthesized by agent`);
  lines.push('');
  lines.push('## Goals');
  if (parsed.goals.length === 0) lines.push('_No standout goals._');
  else for (const g of parsed.goals) lines.push(`- **${g.text}**`);
  lines.push('');
  lines.push('## Next steps');
  if (parsed.suggestions.length === 0) lines.push('_None._');
  else for (const s of parsed.suggestions) lines.push(`- ${s.text} — next: ${s.suggestion}`);
  lines.push('');
  lines.push('---');
  lines.push('Synthesized by agent — proposals only; nothing was auto-promoted.');
  lines.push('');
  return lines.join('\n');
}

// Race a promise against a hard timeout so a hung agent can never wedge the
// digest. Belt-and-suspenders over any timeout the runAgent already enforces.
function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`todo digest agent timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Attempt ONE headless-agent synthesis of the twice-daily digest, falling back
 * to the deterministic synthesizeTodoDigest on ANY failure (no runAgent, empty
 * set, timeout, throw, junk output, or nothing usable). The rules digest is
 * always computed first and returned as-is when the agent path is unavailable,
 * so agent-off behavior is byte-for-byte identical to today. `runAgent` is
 * injected (never imported here) so this module stays free of electron/IPC
 * dependencies and the fallback is trivially testable.
 */
async function synthesizeTodoDigestWithAgent(
  todos: OpsTodo[],
  opts?: {
    now?: string | number;
    slot?: 'morning' | 'night';
    runAgent?: (args: { prompt: string; timeoutMs: number }) => Promise<string> | string;
    timeoutMs?: number;
  }
): Promise<TodoDigest> {
  const now = opts && opts.now !== undefined ? opts.now : Date.now();
  const slot: 'morning' | 'night' = opts && opts.slot === 'night' ? 'night' : 'morning';
  const base = synthesizeTodoDigest(todos, { now, slot }); // source: 'rules'

  const runAgent = opts && typeof opts.runAgent === 'function' ? opts.runAgent : null;
  if (!runAgent || base.openCount === 0) return base;

  const open = selectOpenTodos(todos);
  if (open.length === 0) return base;

  const capMs = (() => {
    const t = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 120000;
    return Math.max(1, Math.min(t, 120000));
  })();

  try {
    const prompt = buildTodoDigestPrompt(open, slot);
    const raw = await withHardTimeout(
      Promise.resolve().then(() => runAgent({ prompt, timeoutMs: capMs })),
      capMs
    );
    const parsed = parseAgentTodoDigest(raw, open);
    if (!parsed) return base;
    return {
      $schema: 'ace.ops.todo-digest.v1',
      slot: base.slot,
      generatedAt: base.generatedAt,
      openCount: base.openCount,
      groups: base.groups,
      goals: parsed.goals,
      suggestions: parsed.suggestions,
      markdown: buildAgentTodoDigestMarkdown(base, parsed),
      source: 'agent',
    };
  } catch {
    // Fail-closed: ANY error (throw, timeout, junk) => the deterministic digest.
    return base;
  }
}

// ---------------------------------------------------------------------------
// readTodoDigest / writeTodoDigest — latest digest only, fail-safe
// ---------------------------------------------------------------------------

/**
 * Read the latest persisted digest. Missing/corrupt/foreign-schema file -> null.
 * Never throws.
 */
function readTodoDigest(opts?: DigestOpts): TodoDigest | null {
  try {
    const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultDigestPath();
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.$schema !== 'ace.ops.todo-digest.v1') return null;
    return parsed as TodoDigest;
  } catch {
    return null;
  }
}

/**
 * Persist the latest digest (overwrites — history lives in the wiki + ndjson
 * log, not here). Returns true on success, false on any failure. Never throws.
 */
function writeTodoDigest(digest: TodoDigest, opts?: DigestOpts): boolean {
  try {
    if (!digest || digest.$schema !== 'ace.ops.todo-digest.v1') return false;
    const filePath: string = (opts && opts.filePath) ? opts.filePath : defaultDigestPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(digest, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[ops-todos] digest write failed:', (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listTodos,
  addTodo,
  patchTodo,
  removeTodo,
  extractHashtags,
  synthesizeTodoDigest,
  synthesizeTodoDigestWithAgent,
  readTodoDigest,
  writeTodoDigest,
};
