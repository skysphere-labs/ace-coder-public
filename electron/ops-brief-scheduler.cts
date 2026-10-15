const fs = require('fs');
const os = require('os');
const path = require('path');

const OPS_BRIEF_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Three lens-differentiated brief times (overridable via the `schedule` option
// on scheduleOpsBriefs — the caller passes the profile's ops-config.json values in).
// The ONE config value this module reads itself is refresh.research.scheduled
// (readResearchScheduled below), read at each brief tick so the flag can change
// without a restart.
// Fixed local defaults: 07:30 morning, 13:00 midday, 20:30 evening.
const OPS_BRIEF_SCHEDULE: Array<{ hour: number; minute: number; lens: string }> = [
  { hour: 7, minute: 30, lens: 'morning' },
  { hour: 13, minute: 0, lens: 'midday' },
  { hour: 20, minute: 30, lens: 'evening' },
];

// Run-state persistence file names (relative to a caller-supplied stateDir,
// normally Electron's userDataPath — the same files local-core writes).
const OPS_BRIEF_STATE_FILE = 'ops-brief-state.json';
const OPS_BRIEF_HISTORY_FILE = 'ops-briefs.ndjson';
const OPS_TODAY_RELATIVE_PATH = path.join('dashboards', 'today.md');
const TODAY_NON_AUTHORITATIVE_SENTENCE =
  'Snapshot failed; do not infer current state from this section.';
const TODAY_MAX_ITEMS = 8;
const TODAY_MAX_LINE_LENGTH = 240;

// Validates a caller-supplied schedule override. Each entry needs an integer
// hour 0-23, an optional integer minute 0-59 (default 0), and a non-empty
// lens string. Any invalid entry rejects the whole override — bad config must
// never silently drop a lens — and falls back to the default schedule.
function normalizeBriefSchedule(
  raw: any
): Array<{ hour: number; minute: number; lens: string }> {
  const fallback = () => OPS_BRIEF_SCHEDULE.map((entry) => ({ ...entry }));
  if (!Array.isArray(raw) || raw.length === 0) return fallback();
  const normalized: Array<{ hour: number; minute: number; lens: string }> = [];
  for (const entry of raw) {
    const hour = entry?.hour;
    const minute = entry?.minute ?? 0;
    const lens = entry?.lens;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback();
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return fallback();
    if (typeof lens !== 'string' || lens.length === 0) return fallback();
    normalized.push({ hour, minute, lens });
  }
  return normalized;
}

// Scheduled briefs may spawn a paid research agent only after explicit opt-in.
// Read refresh.research.scheduled from the selected profile at each tick.
// Missing, corrupt, or non-boolean settings keep research disabled.
function readResearchScheduled(configPath?: string): boolean {
  try {
    const p =
      typeof configPath === 'string' && configPath
        ? configPath
        : path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return cfg?.refresh?.research?.scheduled === true;
  } catch {
    return false;
  }
}

// Returns the next Date for a daily brief at `hour:minute` (local clock) after
// `now`. If today's slot has already passed (or is exactly now), schedules for
// tomorrow.
function nextBriefRun(hour: number, minute: number = 0, now: Date = new Date()): Date {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

// Reads ops-brief-state.json from `stateDir`. Missing/corrupt file -> {}.
function readBriefRunState(stateDir: string): any {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(stateDir, OPS_BRIEF_STATE_FILE), 'utf8')
    );
  } catch {
    return {};
  }
}

// Reads ops-briefs.ndjson from `stateDir` as an array of run entries
// (oldest first). Malformed lines are skipped; missing file -> [].
function readBriefRunHistory(stateDir: string): any[] {
  try {
    const lines = fs
      .readFileSync(path.join(stateDir, OPS_BRIEF_HISTORY_FILE), 'utf8')
      .split('\n');
    const entries: any[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function cleanTodayLine(value: any, max: number = TODAY_MAX_LINE_LENGTH): string {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function resolveTodayBriefPath(input: any = {}): string {
  if (typeof input?.todayPath === 'string' && input.todayPath.trim()) {
    return path.resolve(input.todayPath.trim());
  }
  const root =
    typeof input?.wikiRoot === 'string' && input.wikiRoot.trim()
      ? input.wikiRoot.trim()
      : typeof process.env.ACE_WIKI_ROOT === 'string' && process.env.ACE_WIKI_ROOT.trim()
        ? process.env.ACE_WIKI_ROOT.trim()
        : path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki');
  return path.join(path.resolve(root), OPS_TODAY_RELATIVE_PATH);
}

function todayItemLine(item: any): string | null {
  const text = cleanTodayLine(item?.text ?? '');
  if (!text) return null;
  const parts = [text];
  if (item?.why) parts.push(`why: ${cleanTodayLine(item.why, 120)}`);
  if (item?.move) parts.push(`move: ${cleanTodayLine(item.move, 120)}`);
  if (item?.url) parts.push(`source: ${cleanTodayLine(item.url, 180)}`);
  return `- ${parts.join(' — ')}`;
}

function itemsForSection(brief: any, titles: string[]): string[] {
  const wanted = new Set(titles.map((title) => title.toLowerCase()));
  const sections = Array.isArray(brief?.sections) ? brief.sections : [];
  const out: string[] = [];
  for (const section of sections) {
    const title = String(section?.title ?? '').toLowerCase();
    if (!wanted.has(title)) continue;
    const items = Array.isArray(section?.items) ? section.items : [];
    for (const item of items) {
      const line = todayItemLine(item);
      if (line) out.push(line);
      if (out.length >= TODAY_MAX_ITEMS) return out;
    }
  }
  return out;
}

function sourceFreshnessItems(brief: any): string[] {
  const sections = Array.isArray(brief?.sections) ? brief.sections : [];
  const section = sections.find(
    (entry: any) => String(entry?.title ?? '').toLowerCase() === 'source freshness'
  );
  const items = Array.isArray(section?.items) ? section.items : [];
  return items
    .map((item: any) => cleanTodayLine(item?.text ?? ''))
    .filter(Boolean)
    .slice(0, TODAY_MAX_ITEMS);
}

function todayBlockedNotes(brief: any): string[] {
  const notes: string[] = [];
  const freshness = String(brief?.sourceFreshness ?? 'unknown');
  if (freshness === 'stale') {
    notes.push('- Source freshness is stale; verify live deltas before acting.');
  } else if (freshness === 'expired' || freshness === 'missing') {
    notes.push(`- Source snapshot is ${freshness}; ${TODAY_NON_AUTHORITATIVE_SENTENCE}`);
    notes.push('- _This section is non-authoritative until live deltas are checked._');
  }

  for (const item of sourceFreshnessItems(brief)) {
    if (/\b(error|unavailable|auth[- ]needed|missing|expired|untracked)\b/i.test(item)) {
      notes.push(`- Source issue: ${item}. ${TODAY_NON_AUTHORITATIVE_SENTENCE}`);
    }
  }

  for (const line of itemsForSection(brief, ['Mission Board'])) {
    if (/\b(blocked|stale|in flight)\b/i.test(line) && !/^- 0\b/.test(line)) {
      notes.push(line);
    }
  }

  for (const line of itemsForSection(brief, ['Service Health'])) {
    if (!/all probes green/i.test(line)) notes.push(line);
  }

  return notes.slice(0, TODAY_MAX_ITEMS);
}

function evidenceLines(input: any = {}): string[] {
  const entries: Array<[string, any]> = [
    ['Today pull target', input.todayPath],
    ['Lens brief artifact', input.briefPath],
    ['Brief history', input.historyPath],
    ['Brief state', input.statePath],
    ['Intel latest report', input.intelPath],
  ];
  if (input.sourcePaths && typeof input.sourcePaths === 'object') {
    for (const [label, value] of Object.entries(input.sourcePaths)) {
      entries.push([String(label), value]);
    }
  }
  const seen = new Set<string>();
  return entries
    .map(([label, value]) => {
      if (typeof value !== 'string' || !value.trim()) return null;
      const key = `${label}:${value}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return `- ${cleanTodayLine(label, 80)}: \`${cleanTodayLine(value, 220)}\``;
    })
    .filter(Boolean) as string[];
}

function renderTodayBriefMarkdown(brief: any, input: any = {}): string {
  try {
    const generatedAt = brief?.generatedAt
      ? new Date(brief.generatedAt).toISOString()
      : new Date(input?.now ?? Date.now()).toISOString();
    const lens = cleanTodayLine(brief?.lens ?? 'unknown', 40);
    const freshness = cleanTodayLine(brief?.sourceFreshness ?? 'unknown', 40);
    const intelAsOf = brief?.intelAsOf ? new Date(brief.intelAsOf).toISOString() : 'unknown';
    const headline = cleanTodayLine(brief?.headline || 'No headline available.');
    const sourceItems = sourceFreshnessItems(brief);
    const needsChief = itemsForSection(brief, ['Top Decisions']);
    const improvements = itemsForSection(brief, ['Top Actions', 'Service Health']);
    const moves = itemsForSection(brief, [
      'Top Project Moves',
      'Suggested Tickets',
      'New Signals',
      'Intel Signals',
    ]);
    const blockers = todayBlockedNotes(brief);
    const evidence = evidenceLines(input);
    const lines: string[] = [
      '# Ace Today Brief',
      '',
      `Generated: ${generatedAt}`,
      `Freshness: ${freshness} · as-of ${intelAsOf} · lens ${lens}`,
      '',
      '## Executive Read',
      '',
      headline,
      '',
      '## Needs Chief',
      '',
      ...(needsChief.length ? needsChief : ['_No Chief decision requested in this brief._']),
      '',
      '## Today Ace Improvements',
      '',
      ...(improvements.length ? improvements : ['_No Ace improvement candidates surfaced in this brief._']),
      '',
      '## Today Project Moves',
      '',
      ...(moves.length ? moves : ['_No project moves or candidate moves surfaced in this brief._']),
      '',
      '## Blocked / Broken Autonomy Notes',
      '',
      ...(blockers.length ? blockers : ['_No blockers surfaced here. Verify live deltas before acting._']),
      '',
      '## Source Freshness',
      '',
      ...(sourceItems.length ? sourceItems.map((item) => `- ${item}`) : ['- Source pull state unavailable.']),
      '',
      '## Evidence / Source Paths',
      '',
      ...(evidence.length ? evidence : ['- Source paths unavailable; verify live before acting.']),
      '',
      '## No Auto Action',
      '',
      'Read-only synthesis only. No push notifications, agent dispatch, merges, deploys, or worker spawns were performed.',
      '',
    ];
    return lines.join('\n');
  } catch {
    return [
      '# Ace Today Brief',
      '',
      `Generated: ${new Date(input?.now ?? Date.now()).toISOString()}`,
      `Freshness: missing · as-of unknown · lens unknown`,
      '',
      '## Executive Read',
      '',
      '_Today brief unavailable._',
      '',
      '## Blocked / Broken Autonomy Notes',
      '',
      `- ${TODAY_NON_AUTHORITATIVE_SENTENCE}`,
      '- _This section is non-authoritative._',
      '',
    ].join('\n');
  }
}

function atomicWrite(target: string, contents: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, target);
}

function writeTodayBrief(input: any = {}) {
  if (process.env.ACE_WIKI_DISABLE === '1') {
    return { written: false, disabled: true, path: null };
  }
  let target: string | null = null;
  try {
    target = resolveTodayBriefPath(input);
    const md = renderTodayBriefMarkdown(input.brief, { ...input, todayPath: target });
    atomicWrite(target, md);
    return { written: true, path: target };
  } catch (err: any) {
    return { written: false, path: target, error: err?.message ?? String(err) };
  }
}

// Records one brief run outcome into the ndjson history + state json under
// `stateDir`. Adds error capture the success path (local-core's
// deliverOpsBrief) does not write: { at, lens, status, error, path }.
// Best-effort — never throws. Returns false when stateDir is unusable.
function recordOpsBriefRun(input: any = {}): boolean {
  const stateDir = input?.stateDir;
  if (typeof stateDir !== 'string' || stateDir.length === 0) return false;
  const at = new Date(
    typeof input?.at === 'number' || typeof input?.at === 'string' ? input.at : Date.now()
  ).toISOString();
  const lens = typeof input?.lens === 'string' && input.lens ? input.lens : 'unknown';
  const status: 'ok' | 'error' = input?.status === 'error' ? 'error' : 'ok';
  const error =
    typeof input?.error === 'string' && input.error.length > 0 ? input.error : null;
  const writtenPath = typeof input?.path === 'string' && input.path ? input.path : null;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, OPS_BRIEF_HISTORY_FILE),
      JSON.stringify({ at, lens, status, error, path: writtenPath }) + '\n'
    );
  } catch {
    // history persistence is convenience-only; never throw.
  }
  try {
    const prev = readBriefRunState(stateDir);
    fs.writeFileSync(
      path.join(stateDir, OPS_BRIEF_STATE_FILE),
      JSON.stringify(
        { ...prev, lastLens: lens, lastAt: at, lastStatus: status, lastError: error },
        null,
        2
      )
    );
  } catch {
    // state persistence is convenience-only; never throw.
  }
  return true;
}

// Pure status snapshot of the brief schedule — safe to wire directly as an
// IPC read handler. NEVER throws; missing/corrupt state yields null fields.
//
// input:
//   now      — Date | epoch ms (default: new Date())
//   stateDir — directory holding ops-brief-state.json + ops-briefs.ndjson
//   state    — preloaded { state?: object, history?: any[] } (wins over stateDir)
//   schedule — optional schedule override (same shape as scheduleOpsBriefs)
//
// Returns { slots: [{ lens, hour, minute, nextRunAt, lastDeliveredAt,
//                     lastStatus: 'ok'|'error'|null, lastError, lastPath }] }.
// History entries without a `status` field (local-core success lines) count
// as 'ok'. lastDeliveredAt is the newest ok run for the lens; the other
// last* fields reflect the newest run of any status.
function briefScheduleStatus(input: any = {}): { slots: any[]; todayPath: string | null } {
  const nowRaw = input?.now;
  const now =
    nowRaw instanceof Date
      ? nowRaw
      : typeof nowRaw === 'number'
        ? new Date(nowRaw)
        : new Date();
  const schedule = normalizeBriefSchedule(input?.schedule);

  let stateJson: any = {};
  let history: any[] = [];
  if (input?.state && typeof input.state === 'object') {
    stateJson =
      input.state.state && typeof input.state.state === 'object' ? input.state.state : {};
    history = Array.isArray(input.state.history) ? input.state.history : [];
  } else if (typeof input?.stateDir === 'string' && input.stateDir.length > 0) {
    stateJson = readBriefRunState(input.stateDir);
    history = readBriefRunHistory(input.stateDir);
  }

  const slots = schedule.map((entry) => {
    const { hour, minute, lens } = entry;
    let last: any = null;
    let lastOk: any = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const run = history[i];
      if (!run || run.lens !== lens) continue;
      if (!last) last = run;
      if (run.status !== 'error') {
        lastOk = run;
        break;
      }
    }
    let lastDeliveredAt: string | null = lastOk?.at ?? null;
    let lastStatus: 'ok' | 'error' | null = last
      ? last.status === 'error'
        ? 'error'
        : 'ok'
      : null;
    let lastError: string | null = last?.error ?? null;
    const lastPath: string | null = last?.path ?? null;
    // Fallback for state written before ndjson history existed for this lens.
    if (!last && stateJson?.lastLens === lens && stateJson?.lastAt) {
      lastStatus = stateJson.lastStatus === 'error' ? 'error' : 'ok';
      lastError = stateJson.lastError ?? null;
      if (lastStatus === 'ok') lastDeliveredAt = stateJson.lastAt;
    }
    return {
      lens,
      hour,
      minute,
      nextRunAt: nextBriefRun(hour, minute, now).toISOString(),
      lastDeliveredAt,
      lastStatus,
      lastError,
      lastPath,
    };
  });

  let todayPath: string | null = null;
  try {
    todayPath = process.env.ACE_WIKI_DISABLE === '1' ? null : resolveTodayBriefPath(input);
  } catch {
    todayPath = null;
  }

  return { slots, todayPath };
}

// Pure markdown renderer for a ace.ops.brief.v1 object.
// Returns a markdown string. NEVER throws — a null/missing brief returns a
// minimal sentinel body. No http(s) literals.
function renderBriefMarkdown(brief: any): string {
  try {
    if (!brief || typeof brief !== 'object') {
      return '_Intel unavailable_\n';
    }

    const lens: string = brief.lens ?? 'unknown';
    const generatedAt: string = brief.generatedAt
      ? new Date(brief.generatedAt).toDateString()
      : 'unknown';
    const intelAsOf: string | null = brief.intelAsOf ?? null;
    const freshness: string = brief.sourceFreshness ?? 'unknown';
    const headline: string = brief.headline ?? '';
    const sections: any[] = Array.isArray(brief.sections) ? brief.sections : [];
    const deltaSummary: string = brief.deltaSummary ?? '';
    const candidateCount: number =
      typeof brief.candidateCount === 'number' ? brief.candidateCount : 0;

    const lines: string[] = [];

    lines.push(`# Rook Brief — ${lens} (${generatedAt})`);
    lines.push('');
    lines.push(`intel ${freshness} · as-of ${intelAsOf ?? 'unknown'}`);
    lines.push('');

    if (headline) {
      lines.push(headline);
      lines.push('');
    }

    for (const section of sections) {
      const title: string = section?.title ?? '(untitled)';
      lines.push(`## ${title}`);
      const items: any[] = Array.isArray(section?.items) ? section.items : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const text: string = item.text ?? '';
        let bullet = `- ${text}`;
        if (item.why) bullet += ` — why: ${item.why}`;
        if (item.move) bullet += ` → ${item.move}`;
        if (item.url) bullet += ` (${item.url})`;
        lines.push(bullet);
      }
      lines.push('');
    }

    lines.push(`${deltaSummary} Candidates: ${candidateCount}`);

    return lines.join('\n');
  } catch {
    return '_Intel unavailable_\n';
  }
}

// Schedules in-process daily timers — one per lens in the schedule.
// For each schedule entry, sets a setTimeout to the next run, then a setInterval
// for every 24h thereafter. Each tick passes refreshSources: true so the store
// pulls all registry sources before generating the brief. Failures inside the
// brief callback are swallowed so the runtime always survives.
//
// options:
//   getStore    — () => store (required; store must have deliverOpsBrief)
//   subscriptions — [] (required; cleanup fns pushed here)
//   schedule    — optional [{ hour, minute?, lens }] override (default:
//                 OPS_BRIEF_SCHEDULE; invalid overrides fall back to default)
//   stateDir    — optional dir; when set, delivery failures are recorded via
//                 recordOpsBriefRun (success runs are logged by deliverOpsBrief)
//   setTimeout / clearTimeout / setInterval / clearInterval — injectable (default globals)
//   now         — () => Date (injectable, default: () => new Date())
//   logger      — { error: fn } (default: console)
//
// Returns false when the store contract is unmet; true otherwise.
function scheduleOpsBriefs(options: any): boolean {
  const getStore = options?.getStore;
  const subscriptions = options?.subscriptions;
  if (typeof getStore !== 'function' || !Array.isArray(subscriptions)) return false;

  const store = getStore();
  if (!store || typeof store.deliverOpsBrief !== 'function') return false;

  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const setIntervalImpl = options.setInterval ?? setInterval;
  const clearIntervalImpl = options.clearInterval ?? clearInterval;
  const now: () => Date = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  const schedule = normalizeBriefSchedule(options.schedule);
  const stateDir: string | null =
    typeof options.stateDir === 'string' && options.stateDir.length > 0
      ? options.stateDir
      : null;
  // FIX 1: injectable so tests can force the flag; production reads config at
  // each tick. options.configPath lets a caller redirect the config file.
  const researchScheduled: () => boolean =
    typeof options.readResearchScheduled === 'function'
      ? options.readResearchScheduled
      : () => readResearchScheduled(options.configPath);

  for (const entry of schedule) {
    const { hour, minute, lens } = entry;

    const runBrief = () => {
      setTimeoutImpl(() => {
        Promise.resolve()
          .then(() =>
            getStore().deliverOpsBrief({
              lens,
              now: now().getTime(),
              refreshSources: true,
              // Config-driven opt-in (default FALSE), read at this tick.
              allowResearchAgent: researchScheduled(),
            })
          )
          .catch((err: any) => {
            logger.error('[ace] ops brief delivery failed:', err);
            if (stateDir) {
              recordOpsBriefRun({
                stateDir,
                lens,
                at: now().getTime(),
                status: 'error',
                error: err?.message ?? String(err),
                path: null,
              });
            }
          });
      }, 0);
    };

    const current = now();
    const next = nextBriefRun(hour, minute, current);
    const firstTimer = setTimeoutImpl(() => {
      runBrief();
      const dailyTimer = setIntervalImpl(runBrief, OPS_BRIEF_INTERVAL_MS);
      subscriptions.push(() => clearIntervalImpl(dailyTimer));
    }, next.getTime() - current.getTime());
    subscriptions.push(() => clearTimeoutImpl(firstTimer));
  }

  return true;
}

module.exports = {
  OPS_BRIEF_INTERVAL_MS,
  OPS_BRIEF_SCHEDULE,
  OPS_TODAY_RELATIVE_PATH,
  TODAY_NON_AUTHORITATIVE_SENTENCE,
  briefScheduleStatus,
  nextBriefRun,
  normalizeBriefSchedule,
  readResearchScheduled,
  recordOpsBriefRun,
  renderBriefMarkdown,
  renderTodayBriefMarkdown,
  resolveTodayBriefPath,
  scheduleOpsBriefs,
  writeTodayBrief,
};
