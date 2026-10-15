const TITLE_MAX_WORDS = 10;
const TITLE_MAX_CHARS = 72;
const DEFAULT_SLUG_MAX = 40;

const GENERIC_LABELS = new Set([
  'agent',
  'worker',
  'task',
  'goal',
  'mission board',
  'claude',
  'claude code',
  'claude worker',
  'claude task',
  'codex',
  'codex cli',
  'codex worker',
  'codex task',
]);

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'to', 'use', 'using', 'with', 'without',
]);

function compactLine(value: any) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedKey(value: any) {
  return compactLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyTitle(value: any) {
  return normalizedKey(value).replace(/\s+/g, '-') || 'item';
}

function isGenericTaskLabel(label: any, agent: any = null) {
  const key = normalizedKey(label);
  if (!key) return true;
  if (GENERIC_LABELS.has(key)) return true;
  const agentKey = normalizedKey(agent);
  if (!agentKey) return false;
  return key === agentKey
    || key === `${agentKey} worker`
    || key === `${agentKey} task`
    || key === `${agentKey} agent`;
}

function explicitTaskLabel(label: any, agent: any = null) {
  const text = compactLine(label);
  if (!text || isGenericTaskLabel(text, agent)) return null;
  return text;
}

function stripBoilerplateSections(text: string) {
  const marker = text.search(/\b(?:done when|budget|max rounds|verify rounds|must-pass acceptance|acceptance|non-goals|constraints|verification|completion)\b\s*:/i);
  return marker >= 0 ? text.slice(0, marker) : text;
}

function stripPromptControlNoise(value: any) {
  let text = stripBoilerplateSections(String(value ?? ''));
  text = text
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/`{1,3}/g, ' ')
    .replace(/^#+\s*/gm, ' ')
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/gi, ' ')
    .replace(/\bDONE\/BLOCKED\b/g, ' ')
    .replace(/(?:^|\s)\/goal\b/gi, ' ')
    .replace(/\b(?:ultracode|xhigh|dynamic\s+workflows?|goal-mode|bias-to-action|multi_tool_use\.parallel)\b/gi, ' ')
    .replace(/(^|[^A-Za-z0-9])(?:~|\/)[^\s,;:()]+/g, '$1 ')
    .replace(/\b[A-Za-z]:\\[^\s,;:()]+/g, ' ')
    .replace(/\b(?:[\w.-]+\/)+[\w.-]+\.(?:md|json|ya?ml|txt|ts|tsx|cts|js|jsx|mjs|cjs|py|go|rs|sh)\b/g, ' ')
    .replace(/\b[\w.-]+\.(?:md|json|ya?ml|txt|ts|tsx|cts|js|jsx|mjs|cjs|py|go|rs|sh)\b/g, ' ')
    .replace(/(^|\s)\.(?:md|json|ya?ml|txt|ts|tsx|cts|js|jsx|mjs|cjs|py|go|rs|sh)\b/gi, '$1 ')
    .replace(/\bread\s+and\s+execute\b[:\s-]*/gi, ' ')
    .replace(/\bread\s+(?:the\s+)?(?:brief|file|spec|task|goal)\b[:\s-]*/gi, ' ')
    .replace(/\bcomplete\s+\/?\s*goal\b[:\s-]*/gi, ' ')
    .replace(/\bcontinue\s+working\s+toward\b[:\s-]*/gi, ' ');
  return compactLine(text);
}

function stripLeadingControlWords(value: string) {
  let text = value;
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(/^(?:goal|objective|task|brief|context|owner intent|read brief|read file|read spec)\s*[:\-]\s*/i, '');
    if (next === text) break;
    text = next;
  }
  return text;
}

function cleanCandidate(value: string) {
  return compactLine(
    stripLeadingControlWords(value)
      .replace(/["'()[\]{}<>]/g, ' ')
      .replace(/[/:]+/g, ' ')
      .replace(/[,&]+/g, ' ')
      .replace(/\s+-\s+/g, ' ')
  );
}

function meaningfulWords(value: string) {
  return (normalizedKey(value).match(/[a-z0-9]+/g) || [])
    .filter((word: string) => word.length > 1 && !TITLE_STOP_WORDS.has(word));
}

function isNoiseCandidate(value: string) {
  const key = normalizedKey(value);
  if (!key) return true;
  if (/^(read|execute|brief|file|spec|goal|objective|task|done|blocked|budget)$/.test(key)) return true;
  if (/^read\b/.test(key)) return true;
  return meaningfulWords(value).length < 2;
}

function limitTitle(value: string, maxWords = TITLE_MAX_WORDS, maxChars = TITLE_MAX_CHARS) {
  const words = compactLine(value).split(/\s+/).filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  while (out.length > maxChars && out.includes(' ')) {
    out = out.replace(/\s+\S+$/, '');
  }
  if (!out) out = words.join(' ').slice(0, maxChars).trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}

function deriveGeneratedTaskTitle(value: any, opts: any = {}) {
  const cleaned = stripPromptControlNoise(value);
  if (!cleaned) return null;
  const candidates = cleaned.split(/(?:[.!?]+|\s+-{2,}\s+|;)+/);
  for (const raw of candidates) {
    const candidate = cleanCandidate(raw);
    if (isNoiseCandidate(candidate)) continue;
    return limitTitle(candidate, opts.maxWords || TITLE_MAX_WORDS, opts.maxChars || TITLE_MAX_CHARS);
  }
  const fallback = cleanCandidate(cleaned);
  return isNoiseCandidate(fallback)
    ? null
    : limitTitle(fallback, opts.maxWords || TITLE_MAX_WORDS, opts.maxChars || TITLE_MAX_CHARS);
}

function deriveTaskTitle(input: any = {}) {
  const explicit = explicitTaskLabel(input.label, input.agent);
  if (explicit) return explicit;
  return deriveGeneratedTaskTitle(input.goal)
    || deriveGeneratedTaskTitle(input.prompt)
    || compactLine(input.fallback)
    || null;
}

function deriveTaskSlug(title: any, opts: any = {}) {
  const maxLength = Math.max(8, Number(opts.maxLength || DEFAULT_SLUG_MAX));
  const slug = slugifyTitle(title);
  if (slug.length <= maxLength) return slug;
  const sliced = slug.slice(0, maxLength).replace(/-+$/, '');
  return sliced.replace(/-[^-]*$/, '') || sliced || 'item';
}

function deriveStreamLabelForTask(input: any = {}) {
  const taskName = compactLine(input.taskName);
  if (taskName && !isGenericTaskLabel(taskName, input.agent)) return taskName;
  return deriveTaskTitle(input) || taskName || compactLine(input.agent) || null;
}

module.exports = {
  compactLine,
  deriveGeneratedTaskTitle,
  deriveTaskSlug,
  deriveTaskTitle,
  deriveStreamLabelForTask,
  explicitTaskLabel,
  isGenericTaskLabel,
  slugifyTitle,
};
