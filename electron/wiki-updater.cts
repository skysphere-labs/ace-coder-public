// Clean wiki auto-update for Ace state transitions.
//
// Writes atomic, timestamped, source-attributed sections into
// the selected profile's wiki dashboard so agents can rehydrate
// from the wiki instead of noisy wake briefs. The wiki is a clean rehydration
// spine — not a transcript wall, not a raw dormant stream dump, not a place
// for failed-probe noise.
//
// Hard rules (see docs/ops/ace-wiki-truth-contract.md):
//   - Atomic write: temp file + rename, single file per call.
//   - Bounded output: capped events per section, capped line lengths.
//   - Source-attributed: every section names its writer and timestamp.
//   - Fail-closed: errors swallowed; nothing is mutated on failure.
//   - Failed probes use the exact wording:
//       `Snapshot failed; do not infer current state from this section.`

const fs = require('fs');
const os = require('os');
const path = require('path');

const WIKI_RELATIVE_PATH = path.join('wiki', 'dashboards', 'current-state.md');
const WIKI_ROOT_RELATIVE_PATH = path.join('wiki');
const WIKI_DAILY_RELATIVE_PATH = path.join('wiki', 'dashboards', 'progressor-daily.md');
const { WIKI_FAILED_SNAPSHOT_SENTENCE: FAILED_PROBE_SENTINEL } = require('./harness/knowledge-contract.cts');
const MAX_SECTION_EVENTS = 12;
const MAX_RECENT_LOG_LINES = 24;
const MAX_LINE_LENGTH = 240;
const SOURCE_TAG = 'ace-electron';

function isDisabled() {
  return process.env.ACE_WIKI_DISABLE === '1';
}

function wikiRootPath() {
  const override = process.env.ACE_WIKI_ROOT;
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki');
}

function wikiPath() {
  const override = process.env.ACE_WIKI_PATH;
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  // Derived from the root so a ACE_WIKI_ROOT override (e.g. external SSD)
  // moves the dashboards with it — never a split-brain wiki.
  return path.join(wikiRootPath(), 'dashboards', 'current-state.md');
}

function wikiLogPath() {
  const override = process.env.ACE_WIKI_LOG_PATH;
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(wikiRootPath(), 'log.md');
}

function wikiDailyPath() {
  const override = process.env.ACE_WIKI_DAILY_PATH;
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(wikiRootPath(), 'dashboards', 'progressor-daily.md');
}

function truncate(line: any, max: number = MAX_LINE_LENGTH) {
  const text = String(line == null ? '' : line).replace(/[\u0000-\u001f]/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function sanitizeEventLine(event: any) {
  const at = event?.at ? String(event.at) : new Date().toISOString();
  const type = event?.type ? String(event.type) : 'note';
  const actor = event?.actor ? String(event.actor) : '';
  const message = truncate(event?.message || '');
  const ids = [
    event?.missionId ? `mission=${truncate(event.missionId, 80)}` : '',
    event?.featureId ? `feature=${truncate(event.featureId, 80)}` : '',
  ].filter(Boolean).join(' ');
  return `- [${at}] ${type}${actor ? ` (${actor})` : ''}${ids ? ` ${ids}` : ''} — ${message}`;
}

function sectionMarkerStart(key: any) {
  return `<!-- ace:section:start id=${key} -->`;
}

function sectionMarkerEnd(key: any) {
  return `<!-- ace:section:end id=${key} -->`;
}

function ensureHeader(current: string) {
  if (current && current.trim()) return current.endsWith('\n') ? current : `${current}\n`;
  return [
    '# Ace current state',
    '',
    'Auto-updated by Ace at state transitions. **Failed probes are non-authoritative.**',
    'Live checks (ace, git, gh, transcripts) are deltas on top of this file.',
    '',
    `Source: ${SOURCE_TAG}  ·  Format: Ace mission state snapshots.`,
    '',
  ].join('\n');
}

function readCurrent(target: string) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

function atomicWrite(target: string, contents: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

function replaceOrAppendSection(current: string, key: string, body: string) {
  const start = sectionMarkerStart(key);
  const end = sectionMarkerEnd(key);
  const block = `${start}\n${body.trim()}\n${end}`;
  if (current.includes(start) && current.includes(end)) {
    const startIdx = current.indexOf(start);
    const endIdx = current.indexOf(end);
    if (endIdx > startIdx) {
      return current.slice(0, startIdx) + block + current.slice(endIdx + end.length);
    }
  }
  const prefix = current.endsWith('\n') || !current ? current : `${current}\n`;
  return `${prefix}${prefix.endsWith('\n\n') ? '' : '\n'}${block}\n`;
}

function buildMissionSection({
  missionId,
  missionName,
  status,
  events,
  nextAction,
  ts,
  workspaceId,
}: any) {
  const cleanEvents = (Array.isArray(events) ? events : [])
    .slice(-MAX_SECTION_EVENTS)
    .map(sanitizeEventLine);
  const lines = [
    `## Mission ${missionId}`,
    '',
    `**Name:** ${truncate(missionName || '(unnamed)')}`,
    `**Status:** ${truncate(status || 'unknown')}`,
    workspaceId ? `**Workspace:** ${truncate(workspaceId)}` : '',
    nextAction ? `**Next action:** ${truncate(nextAction)}` : '',
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    '',
    cleanEvents.length ? '### Recent events' : '',
    cleanEvents.length ? cleanEvents.join('\n') : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildToolAuditSection({ outcome, missionId, runId, phase, missingEvents, ts }: any) {
  const lines = [
    '## Mission tool audit',
    '',
    `**Mission:** ${truncate(missionId || '(none)')}`,
    `**Phase:** ${truncate(phase || '(none)')}`,
    runId ? `**Run:** ${truncate(runId)}` : '',
    `**Outcome:** ${outcome === true ? 'pass' : outcome === false ? 'fail' : 'unknown'}`,
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    '',
  ];
  if (outcome === false && Array.isArray(missingEvents) && missingEvents.length) {
    lines.push('### Missing required proof');
    for (const item of missingEvents.slice(0, MAX_SECTION_EVENTS)) {
      lines.push(`- ${truncate(item)}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

function buildMissionBoardSnapshot({ board, nextActions, health, ts }: any) {
  const totals = board?.totals || {};
  const lines = [
    '## Mission Board summary',
    '',
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    health ? `**Updater health:** ${truncate(health)}` : '**Updater health:** healthy',
    '',
    `- Missions: ${Number(totals.missions || 0)}`,
    `- Cards: ${Number(totals.cards || 0)} active=${Number(totals.active || 0)} archived=${Number(totals.archived || 0)}`,
    `- Ready: ${Number(totals.ready || 0)} in_progress=${Number(totals.inProgress || 0)} review=${Number(totals.readyToReview || 0)} done=${Number(totals.done || 0)}`,
    `- Blocked: ${Number(totals.blockedCards || totals.blocked || 0)} merge_ready=${Number(totals.mergeReady || 0)}`,
    '',
  ];
  const actions = Array.isArray(nextActions) ? nextActions.filter(Boolean).slice(0, MAX_SECTION_EVENTS) : [];
  if (actions.length) {
    lines.push('### mission next');
    for (const action of actions) {
      const featureId = action.featureId || action.id || '';
      const next = action.next || action.nextAction || 'unknown';
      const reason = action.reason ? `: ${action.reason}` : '';
      lines.push(`- ${truncate(featureId, 80)} -> ${truncate(next, 80)}${truncate(reason, 140)}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

function severityLabel(severity: any) {
  const value = String(severity || '').toLowerCase();
  if (value === 'green' || value === 'yellow' || value === 'red' || value === 'black') return value;
  return 'unknown';
}

// Distilled ops-status rollup + bounded findings for current-state.md. The raw
// probe ndjson is written elsewhere (<ACE_HOME>/probes/); only the distilled
// summary reaches the rehydration spine (contracts §6). Each finding line is
// truncated to MAX_LINE_LENGTH (240) and at most MAX_SECTION_EVENTS (12) are
// written — the same bounds the base contract enforces everywhere.
function buildOpsStatusSnapshot({ rollup, findings, isLive, ts }: any) {
  const counts = rollup?.counts || {};
  const lines = [
    '## Operations status',
    '',
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    `**Mode:** ${isLive ? 'live' : 'snapshot'}`,
    `**Rollup:** ${severityLabel(rollup?.severity)} (green=${Number(rollup?.green || 0)} yellow=${Number(rollup?.yellow || 0)} red=${Number(rollup?.red || 0)} black=${Number(rollup?.black || 0)})`,
    '',
  ];
  const categoryLine = Object.entries(counts)
    .map(([cat, sev]) => `${truncate(cat, 24)}=${severityLabel(sev)}`)
    .join(' ');
  if (categoryLine) {
    lines.push(`**Categories:** ${truncate(categoryLine)}`);
    lines.push('');
  }
  const rows = (Array.isArray(findings) ? findings : []).slice(0, MAX_SECTION_EVENTS);
  if (rows.length) {
    lines.push('### Findings');
    for (const finding of rows) {
      const sev = severityLabel(finding?.severity);
      const title = truncate(finding?.title || finding?.id || 'finding', 80);
      const action = finding?.recommendedAction
        ? ` -> ${finding.recommendedAction}`
        : '';
      lines.push(truncate(`- [${sev}] ${title}${action}`));
    }
  } else {
    lines.push('_No findings reported._');
  }
  return lines.filter(Boolean).join('\n');
}

// Distilled daily recommendations for dashboards/progressor-daily. Candidates
// only — nothing here is dispatch-ready, and nothing is ever auto-created.
function buildOpsDailySnapshot({ recommendations, ts }: any) {
  const lines = [
    '## Operations daily',
    '',
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    '',
  ];
  const rows = (Array.isArray(recommendations) ? recommendations : []).slice(0, MAX_SECTION_EVENTS);
  if (rows.length) {
    lines.push('### Candidates');
    for (const rec of rows) {
      const sev = severityLabel(rec?.severity);
      const title = truncate(rec?.title || rec?.id || 'candidate', 80);
      const reason = rec?.reason ? `: ${truncate(rec.reason, 140)}` : '';
      lines.push(truncate(`- [${sev}] ${title}${reason} (CANDIDATE — awaiting Chief approval)`));
    }
  } else {
    lines.push('_No daily candidates. This is not an all-clear; verify live._');
  }
  return lines.filter(Boolean).join('\n');
}

function buildRecentMissionEventSection({ lines, ts }: any) {
  return [
    '## Mission lifecycle log',
    '',
    `**Updated:** ${ts}`,
    `**Source:** ${SOURCE_TAG}`,
    '',
    ...(Array.isArray(lines) && lines.length ? lines : ['- No lifecycle events recorded yet.']),
  ].join('\n');
}

function buildFailedProbeSection({ sectionTitle, source, reason, command, ts }: any) {
  return [
    `## ${sectionTitle || 'Failed probe'}`,
    '',
    `**Source:** ${truncate(source || SOURCE_TAG)}`,
    `**Updated:** ${ts}`,
    `**Reason:** ${truncate(reason || 'unknown failure')}`,
    command ? `**Next live command:** \`${truncate(command, 360)}\`` : '',
    '',
    FAILED_PROBE_SENTINEL,
    '',
    '_This section is non-authoritative._',
  ].filter(Boolean).join('\n');
}

function safelyUpdate(target: string, mutator: (current: string) => string) {
  try {
    const current = ensureHeader(readCurrent(target));
    const next = mutator(current);
    if (typeof next !== 'string' || next === current) return { written: false, path: target };
    atomicWrite(target, next);
    return { written: true, path: target };
  } catch (err: any) {
    return { written: false, path: target, error: err?.message || String(err) };
  }
}

function updateMissionSection(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const missionId = String(input.missionId || '').trim();
  if (!missionId) return { written: false, path: null, error: 'missionId required' };
  const target = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  const ts = input.ts || new Date().toISOString();
  const body = buildMissionSection({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, `mission:${missionId}`, body)
  );
}

function updateToolAuditSection(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  const ts = input.ts || new Date().toISOString();
  const key = `audit:${input.missionId || 'global'}:${input.phase || 'any'}`;
  const body = buildToolAuditSection({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, key, body)
  );
}

function recordFailedProbe(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  const ts = input.ts || new Date().toISOString();
  const key = `failed-probe:${input.id || input.sectionTitle || 'snapshot'}`;
  const body = buildFailedProbeSection({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, key, body)
  );
}

// Daily activity journal: every mission event also lands in a dated page
// (journal/YYYY/YYYY-MM-DD.md, Obsidian daily-notes convention). Bounded per
// day, sanitized like every other event line, fail-closed.
const MAX_JOURNAL_LINES_PER_DAY = 500;
const JOURNAL_TRUNCATED_SENTINEL = '- …journal truncated for today (cap reached); see log.md for the full stream.';

function wikiJournalPath(at?: any) {
  const override = process.env.ACE_WIKI_JOURNAL_DIR;
  const baseDir = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(wikiRootPath(), 'journal');
  const iso = (at && !Number.isNaN(Date.parse(String(at))) ? new Date(Date.parse(String(at))) : new Date()).toISOString();
  return path.join(baseDir, iso.slice(0, 4), `${iso.slice(0, 10)}.md`);
}

function journalHeader(day: string) {
  return [
    '---',
    'schema: AceOpsPage/v1',
    'kind: journal',
    `title: Journal ${day}`,
    'status: active',
    'trust: working',
    `updatedAt: ${day}T00:00:00Z`,
    'tags: [ace, daily]',
    `sources: [${SOURCE_TAG}]`,
    '---',
    '',
    `# ${day}`,
    '',
  ].join('\n');
}

function appendDailyJournalLine(event: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = wikiJournalPath(event?.at);
  try {
    const line = sanitizeEventLine(event);
    const current = readCurrent(target);
    if (!current) {
      atomicWrite(target, `${journalHeader(path.basename(target, '.md'))}${line}\n`);
      return { written: true, path: target, line };
    }
    if (current.includes(JOURNAL_TRUNCATED_SENTINEL)) return { written: false, path: target, capped: true };
    const lineCount = current.split('\n').filter((entry: any) => entry.startsWith('- ')).length;
    const addition = lineCount >= MAX_JOURNAL_LINES_PER_DAY ? JOURNAL_TRUNCATED_SENTINEL : line;
    fs.appendFileSync(target, `${addition}\n`);
    return { written: true, path: target, line: addition, capped: addition === JOURNAL_TRUNCATED_SENTINEL };
  } catch (err: any) {
    return { written: false, path: target, error: err?.message || String(err) };
  }
}

// Distilled run digest: one page per completed run under runs/YYYY-MM/.
// Links its raw evidence via sources: — distilled pages never replace
// verbatim records, they point at them.
function writeRunDigest(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const runId = truncate(String(input.runId || '').trim() || `run-${Date.now()}`, 120).replace(/[^\w.-]/g, '_');
  const at = input.at && !Number.isNaN(Date.parse(String(input.at))) ? new Date(Date.parse(String(input.at))) : new Date();
  const iso = at.toISOString();
  const target = path.join(wikiRootPath(), 'runs', iso.slice(0, 7), `${runId}.md`);
  try {
    const sources = [
      input.goalLedgerPath ? String(input.goalLedgerPath) : '',
      input.completionPath ? String(input.completionPath) : '',
      SOURCE_TAG,
    ].filter(Boolean);
    const lines = [
      '---',
      'schema: AceOpsPage/v1',
      'kind: run-digest',
      `title: ${truncate(input.title || runId, 120)}`,
      `status: ${input.outcome === 'done' ? 'done' : 'active'}`,
      'trust: working',
      `updatedAt: ${iso}`,
      `project: ${truncate(input.workspaceId || '', 80) || 'null'}`,
      'tags: [ace, wiki]',
      `sources: [${sources.map((source) => JSON.stringify(source)).join(', ')}]`,
      '---',
      '',
      `# ${truncate(input.title || runId, 120)}`,
      '',
      `- outcome: ${truncate(input.outcome || 'unknown', 60)}`,
      input.missionId ? `- mission: ${truncate(input.missionId, 80)}` : '',
      input.featureId ? `- feature: ${truncate(input.featureId, 80)}` : '',
      input.agent ? `- agent: ${truncate(input.agent, 60)}` : '',
      input.summary ? `- summary: ${truncate(input.summary)}` : '',
      input.prUrl ? `- pr: ${truncate(input.prUrl, 160)}` : '',
      '',
      '_Distilled digest — raw evidence lives at the linked sources._',
      '',
    ].filter((line) => line !== '');
    atomicWrite(target, `${lines.join('\n')}\n`);
    return { written: true, path: target };
  } catch (err: any) {
    return { written: false, path: target, error: err?.message || String(err) };
  }
}

function appendMissionEventLine(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const event = input.event || input;
  const line = sanitizeEventLine(event);
  const logTarget = input.logPath ? path.resolve(input.logPath) : wikiLogPath();
  const currentTarget = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  try {
    fs.mkdirSync(path.dirname(logTarget), { recursive: true });
    fs.appendFileSync(logTarget, `${line}\n`);
  } catch (err: any) {
    return { written: false, path: logTarget, error: err?.message || String(err) };
  }
  // Daily journal ride-along: same sanitized line, dated page, fail-closed.
  try { appendDailyJournalLine(event); } catch {}
  try {
    const lines = fs
      .readFileSync(logTarget, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_RECENT_LOG_LINES);
    const ts = event?.at || new Date().toISOString();
    safelyUpdate(currentTarget, (current) =>
      replaceOrAppendSection(
        current,
        'mission-lifecycle-log',
        buildRecentMissionEventSection({ lines, ts })
      )
    );
  } catch {}
  return { written: true, path: logTarget, line };
}

function updateMissionBoardSnapshot(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  const ts = input.ts || new Date().toISOString();
  const body = buildMissionBoardSnapshot({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, 'mission-board-summary', body)
  );
}

// Distilled ops-status section → current-state.md. Fail-closed: on any I/O
// error nothing is mutated and the caller never throws. The raw probe evidence
// is the snapshot caller's responsibility (<ACE_HOME>/probes/), never here.
function updateOpsStatusSection(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = input.wikiPath ? path.resolve(input.wikiPath) : wikiPath();
  const ts = input.ts || new Date().toISOString();
  const body = buildOpsStatusSnapshot({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, 'ops-status', body)
  );
}

// Distilled daily recommendations → dashboards/progressor-daily. Same bounds,
// same fail-closed guarantee. Candidates only; never dispatch-ready.
function updateOpsDailySection(input: any = {}) {
  if (isDisabled()) return { written: false, disabled: true, path: null };
  const target = input.dailyPath
    ? path.resolve(input.dailyPath)
    : input.wikiPath
      ? path.resolve(input.wikiPath)
      : wikiDailyPath();
  const ts = input.ts || new Date().toISOString();
  const body = buildOpsDailySnapshot({ ...input, ts });
  return safelyUpdate(target, (current) =>
    replaceOrAppendSection(current, 'ops-daily', body)
  );
}

module.exports = {
  FAILED_PROBE_SENTINEL,
  WIKI_RELATIVE_PATH,
  WIKI_ROOT_RELATIVE_PATH,
  WIKI_DAILY_RELATIVE_PATH,
  appendMissionEventLine,
  appendDailyJournalLine,
  writeRunDigest,
  wikiJournalPath,
  isDisabled,
  wikiPath,
  wikiLogPath,
  wikiDailyPath,
  updateMissionSection,
  updateMissionBoardSnapshot,
  updateOpsStatusSection,
  updateOpsDailySection,
  updateToolAuditSection,
  recordFailedProbe,
};
