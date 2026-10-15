const { performance } = require('perf_hooks');

const SCHEMA = 'ace.perf-health/v1';
const DEFAULT_MAX_EVENTS = 800;
const SLOW_SPAN_MS = 200;
const LONG_SPINNER_MS = 500;
const MAX_META_KEYS = 12;
const MAX_TEXT = 160;

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const maxEvents = intFromEnv('ACE_PERF_HEALTH_MAX_EVENTS', DEFAULT_MAX_EVENTS, 100, 5000);
const events: any[] = [];
let nextSeq = 1;

function nowMs() {
  return performance.now();
}

function cleanText(value: any, fallback = 'unknown') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return raw
    .replace(/(token|secret|password|authorization|bearer)[^,\s]*/gi, '$1:[redacted]')
    .slice(0, MAX_TEXT);
}

function cleanNumber(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function safeMeta(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: any = {};
  for (const key of Object.keys(input).slice(0, MAX_META_KEYS)) {
    if (/token|secret|password|authorization|cookie|url|path|prompt|text|content/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    const value = input[key];
    if (value == null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = cleanNumber(value);
    else if (typeof value === 'string') out[key] = cleanText(value, '');
    else out[key] = '[object]';
  }
  return out;
}

function push(event: any) {
  events.push({
    ...event,
    seq: nextSeq++,
    at: Date.now(),
  });
  while (events.length > maxEvents) events.shift();
}

function recordSpan(input: any = {}) {
  const durationMs = cleanNumber(input.durationMs);
  if (durationMs == null) return null;
  const event = {
    kind: 'span',
    source: cleanText(input.source, 'main'),
    name: cleanText(input.name),
    durationMs,
    meta: safeMeta(input.meta),
  };
  push(event);
  return event;
}

function recordSpinner(input: any = {}) {
  const durationMs = cleanNumber(input.durationMs);
  if (durationMs == null) return null;
  const event = {
    kind: 'spinner',
    source: cleanText(input.source, 'renderer'),
    name: cleanText(input.name || input.component),
    component: cleanText(input.component || input.name),
    route: cleanText(input.route, 'unknown'),
    trigger: cleanText(input.trigger, 'unknown'),
    label: cleanText(input.label, ''),
    previousContent: input.previousContent === true,
    durationMs,
    meta: safeMeta(input.meta),
  };
  push(event);
  return event;
}

function record(input: any = {}) {
  return input.kind === 'spinner' ? recordSpinner(input) : recordSpan(input);
}

function timeSync(name: string, fn: Function, meta: any = {}, source = 'main') {
  const started = nowMs();
  try {
    return fn();
  } finally {
    recordSpan({ source, name, durationMs: nowMs() - started, meta });
  }
}

async function timeAsync(name: string, fn: Function, meta: any = {}, source = 'main') {
  const started = nowMs();
  try {
    return await fn();
  } finally {
    recordSpan({ source, name, durationMs: nowMs() - started, meta });
  }
}

function countByName(list: any[]) {
  const counts: any = {};
  for (const event of list) {
    const key = event.kind === 'spinner'
      ? `${event.kind}:${event.component}`
      : `${event.kind}:${event.name}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function health() {
  const recent = events.slice(-200);
  const slowSpans = recent.filter((e) => e.kind === 'span' && e.durationMs >= SLOW_SPAN_MS);
  const longSpinners = recent.filter((e) => e.kind === 'spinner' && e.durationMs >= LONG_SPINNER_MS);
  return {
    schema: SCHEMA,
    ok: true,
    generatedAt: new Date().toISOString(),
    thresholds: {
      slowSpanMs: SLOW_SPAN_MS,
      longSpinnerMs: LONG_SPINNER_MS,
    },
    capacity: maxEvents,
    retained: events.length,
    counts: countByName(recent),
    slowSpans,
    longSpinners,
    recent,
  };
}

function resetForTests() {
  events.splice(0, events.length);
  nextSeq = 1;
}

module.exports = {
  SCHEMA,
  health,
  nowMs,
  record,
  recordSpan,
  recordSpinner,
  resetForTests,
  timeAsync,
  timeSync,
};
