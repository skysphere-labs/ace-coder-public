// Ace-native Goal Ledger — small, deterministic, dependency-free helper for
// the agent-owned `.agent/runs/<runId>/` memory that sits beside each Mission
// Board feature card. The ledger is per-feature attached memory, not a parallel
// task table. Mission Board remains the active work authority; the ledger
// records the worker's evolving state so the control-plane operator lanes can
// rehydrate without noisy wake briefs.

const fs = require('fs');
const path = require('path');

const GOAL_LEDGER_VERSION = 'ace.goal_ledger.v1';
const VALID_STATUSES = Object.freeze([
  'started',
  'in_progress',
  'checkpoint',
  'blocked',
  'awaiting_validation',
  'validated',
  'failed',
  'done',
]);
const VALID_PHASES = Object.freeze([
  'plan',
  'dispatch',
  'implement',
  'verify',
  'fixback',
  'handoff',
  'archive',
]);

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: any, max = 40) {
  const base = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'feature';
  return base.length <= max ? base : base.slice(0, max).replace(/-+$/g, '') || base.slice(0, max);
}

function safeIdSegment(value: any) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || null;
}

function defaultRunId({ missionId, featureId, title }: any) {
  const parts = [safeIdSegment(missionId), safeIdSegment(featureId), slugify(title)]
    .filter(Boolean);
  if (!parts.length) parts.push(slugify(`run-${Date.now()}`));
  return parts.join('-');
}

function resolveLedgerDir(rootDir: any, runId: any) {
  const root = path.resolve(String(rootDir || '.'));
  return path.join(root, '.agent', 'runs', runId);
}

function ensureDirSync(dir: any) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFileOrEmpty(filePath: any) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJsonOrEmpty(filePath: any) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bulletList(items: any) {
  return (Array.isArray(items) ? items : [])
    .map((line: any) => String(line || '').trim())
    .filter(Boolean)
    .map((line: any) => `- ${line}`)
    .join('\n');
}

function escapeHtml(value: any) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildGoalMd({
  title,
  objective,
  missionId,
  featureId,
  startedAt,
  ledgerPath,
  acceptance,
  goalMode,
  escapeHatch,
  parentGoalId,
}: any) {
  const acceptanceText = bulletList(acceptance) || '- (TBD — populate from TaskSpec.acceptance)';
  const trimmedHatch = String(escapeHatch || '').trim() ||
    'End with exactly one of: `DONE: <one-line summary>` or `BLOCKED: <one-line reason>`.';
  const coupling = goalMode && goalMode !== 'off'
    ? `Goal mode is ${goalMode}. Codex \`/goal\` is the durable spec for this run; keep the ledger in sync at every checkpoint.`
    : 'Goal mode is off for this run; the ledger still records checkpoints for rehydration.';
  const lines = [
    `# GOAL — ${String(title || 'Untitled goal').trim()}`,
    '',
    `Schema: ${GOAL_LEDGER_VERSION}`,
    `Mission: ${missionId || '(none)'} `,
    `Feature: ${featureId || '(none)'} `,
    parentGoalId ? `Parent goal: ${parentGoalId} ` : '',
    `Started: ${startedAt} `,
    `Ledger: ${ledgerPath} `,
    '',
    '## Objective',
    String(objective || title || '').trim() || '(TBD)',
    '',
    '## Acceptance',
    acceptanceText,
    '',
    '## Goal-mode coupling',
    coupling,
    '',
    '## Escape hatch',
    trimmedHatch,
    '',
  ];
  return lines.filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function buildImplementationNotesHtml({
  title,
  objective,
  missionId,
  featureId,
  startedAt,
  ledgerPath,
  acceptance,
  protectedPaths,
  progressEvents,
  status,
  phase,
  blockers,
  nextAction,
  lastValidation,
  decisions,
  tradeoffs,
  validation,
  evidence,
  nextGoalCandidates,
}: any) {
  const safe = escapeHtml;
  const protectedItems = (protectedPaths || []).map((p: any) => `<li><code>${safe(p)}</code></li>`).join('');
  const acceptanceItems = (acceptance || []).map((line: any) => `<li>${safe(line)}</li>`).join('');
  const decisionsItems = (decisions || []).map((line: any) => `<li>${safe(line)}</li>`).join('');
  const tradeoffsItems = (tradeoffs || []).map((line: any) => `<li>${safe(line)}</li>`).join('');
  const evidenceItems = (evidence || []).map((line: any) => `<li>${safe(line)}</li>`).join('');
  const candidateItems = (nextGoalCandidates || []).map((line: any) => `<li>${safe(line)}</li>`).join('');
  const progressJson = JSON.stringify(progressEvents || [], null, 2);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>Implementation notes — ${safe(title || 'Goal Ledger')}</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1f2933}',
    'h1,h2,h3{line-height:1.2}',
    'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f7fa;border-radius:4px;padding:0.1rem 0.3rem}',
    'pre{padding:0.75rem 1rem;overflow:auto}',
    'section{margin-block:1.5rem}',
    '.meta{color:#52606d}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Implementation notes — ${safe(title || 'Goal Ledger')}</h1>`,
    '<section id="resume-here">',
    '<h2>Resume Here</h2>',
    '<p class="meta">Read this first when re-entering the lane. Trust the latest checkpoint, not the wake brief.</p>',
    `<p><strong>Status:</strong> ${safe(status || 'started')}</p>`,
    `<p><strong>Phase:</strong> ${safe(phase || 'plan')}</p>`,
    `<p><strong>Next exact action:</strong> ${safe(nextAction || '(TBD)')}</p>`,
    `<p><strong>Last validation:</strong> ${safe(lastValidation || '(none recorded)')}</p>`,
    `<p><strong>Blockers:</strong> ${safe(blockers || 'none')}</p>`,
    '</section>',
    '<section>',
    '<h2>Run metadata</h2>',
    '<ul>',
    `<li>Mission: <code>${safe(missionId || '(none)')}</code></li>`,
    `<li>Feature: <code>${safe(featureId || '(none)')}</code></li>`,
    `<li>Started: <code>${safe(startedAt)}</code></li>`,
    `<li>Ledger: <code>${safe(ledgerPath)}</code></li>`,
    '</ul>',
    '</section>',
    '<section>',
    '<h2>Objective</h2>',
    `<p>${safe(objective || title || '(TBD)')}</p>`,
    '</section>',
    '<section>',
    '<h2>Acceptance</h2>',
    acceptanceItems ? `<ul>${acceptanceItems}</ul>` : '<p>(TBD — populate from TaskSpec.acceptance)</p>',
    '</section>',
    '<section>',
    '<h2>Protected paths</h2>',
    protectedItems ? `<ul>${protectedItems}</ul>` : '<p>(none recorded — do not assume safety; ask if unsure)</p>',
    '</section>',
    '<section>',
    '<h2>Decisions</h2>',
    decisionsItems ? `<ul>${decisionsItems}</ul>` : '<p>(none recorded)</p>',
    '</section>',
    '<section>',
    '<h2>Tradeoffs</h2>',
    tradeoffsItems ? `<ul>${tradeoffsItems}</ul>` : '<p>(none recorded)</p>',
    '</section>',
    '<section>',
    '<h2>Validation</h2>',
    `<p>${safe(validation || '(no validation command/result recorded yet)')}</p>`,
    '</section>',
    '<section>',
    '<h2>Evidence</h2>',
    evidenceItems ? `<ul>${evidenceItems}</ul>` : '<p>(none recorded — store bulky logs under <code>evidence/</code>)</p>',
    '</section>',
    '<section>',
    '<h2>Next goal candidates</h2>',
    candidateItems ? `<ul>${candidateItems}</ul>` : '<p>(none recorded)</p>',
    '</section>',
    '<section id="progress-events">',
    '<h2>Progress events</h2>',
    `<pre><code data-schema="${GOAL_LEDGER_VERSION}.progress">${safe(progressJson)}</code></pre>`,
    '</section>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function indexLine(runId: any, ledgerDir: any, title: any, startedAt: any, status: any) {
  const cleanTitle = String(title || 'untitled').trim().replace(/\s+/g, ' ');
  return `- [${runId}](${path.relative(path.dirname(path.dirname(ledgerDir)), ledgerDir)}/GOAL.md) — ${cleanTitle} (started ${startedAt}, ${status})`;
}

function upsertGoalsIndex({ rootDir, runId, ledgerDir, title, startedAt, status }: any) {
  const goalsPath = path.join(path.resolve(String(rootDir || '.')), '.agent', 'GOALS.md');
  ensureDirSync(path.dirname(goalsPath));
  const header = `# Ace Goal Ledger index\n\nRuns are stored under \`.agent/runs/<runId>/\` — open the GOAL.md for entry context and implementation-notes.html for live state.\n\n## Active runs\n`;
  const current = readFileOrEmpty(goalsPath);
  const next = indexLine(runId, ledgerDir, title, startedAt, status || 'started');
  const tag = `<!-- run:${runId} -->`;
  if (current && current.includes(tag)) {
    const replaced = current.replace(
      new RegExp(`<!-- run:${runId} -->[\\s\\S]*?<!-- /run:${runId} -->`),
      `${tag}\n${next}\n<!-- /run:${runId} -->`
    );
    fs.writeFileSync(goalsPath, replaced);
    return goalsPath;
  }
  const body = current && current.trim() ? current.trimEnd() + '\n' : header;
  fs.writeFileSync(goalsPath, `${body}${tag}\n${next}\n<!-- /run:${runId} -->\n`);
  return goalsPath;
}

function ensureGoalLedger(input: any = {}) {
  const rootDir = String(input.rootDir || '.').trim() || '.';
  if (!input.missionId && !input.featureId && !input.title) {
    throw new Error('ensureGoalLedger: provide at least one of {missionId, featureId, title}');
  }
  const runId = input.runId
    ? String(input.runId).trim()
    : defaultRunId({ missionId: input.missionId, featureId: input.featureId, title: input.title });
  const ledgerDir = resolveLedgerDir(rootDir, runId);
  const evidenceDir = path.join(ledgerDir, 'evidence');
  ensureDirSync(evidenceDir);

  const startedAt = input.startedAt || nowIso();
  const ledgerPath = ledgerDir;
  const goalPath = path.join(ledgerDir, 'GOAL.md');
  const notesPath = path.join(ledgerDir, 'implementation-notes.html');
  const eventsPath = path.join(ledgerDir, 'progress.ndjson');

  const goalAlready = fs.existsSync(goalPath);
  if (!goalAlready) {
    fs.writeFileSync(
      goalPath,
      buildGoalMd({
        title: input.title || input.objective || runId,
        objective: input.objective,
        missionId: input.missionId,
        featureId: input.featureId,
        startedAt,
        ledgerPath,
        acceptance: input.acceptance,
        goalMode: input.goalMode,
        escapeHatch: input.escapeHatch,
        parentGoalId: input.parentGoalId,
      })
    );
  }

  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(
      notesPath,
      buildImplementationNotesHtml({
        title: input.title || input.objective || runId,
        objective: input.objective,
        missionId: input.missionId,
        featureId: input.featureId,
        startedAt,
        ledgerPath,
        acceptance: input.acceptance,
        protectedPaths: input.protectedPaths,
        progressEvents: [],
        status: 'started',
        phase: 'plan',
        blockers: 'none',
        nextAction: input.nextAction || '(TBD)',
        lastValidation: '(none recorded)',
        decisions: input.decisions,
        tradeoffs: input.tradeoffs,
        validation: '(no validation command/result recorded yet)',
        evidence: input.evidence,
        nextGoalCandidates: input.nextGoalCandidates,
      })
    );
  }

  if (!fs.existsSync(eventsPath)) {
    fs.writeFileSync(eventsPath, '');
  }

  upsertGoalsIndex({
    rootDir,
    runId,
    ledgerDir,
    title: input.title || input.objective || runId,
    startedAt,
    status: 'started',
  });

  return {
    runId,
    ledgerPath,
    goalPath,
    notesPath,
    eventsPath,
    evidenceDir,
    startedAt,
    created: !goalAlready,
  };
}

function readProgressEvents(eventsPath: any) {
  const raw = readFileOrEmpty(eventsPath);
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).map((line: any) => {
    try {
      return line.trim() ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function refreshImplementationNotes({
  notesPath,
  ledgerPath,
  events,
  missionId,
  featureId,
  startedAt,
  title,
  objective,
  acceptance,
  protectedPaths,
}: any) {
  const last = events.length ? events[events.length - 1] : null;
  const html = buildImplementationNotesHtml({
    title,
    objective,
    missionId,
    featureId,
    startedAt,
    ledgerPath,
    acceptance,
    protectedPaths,
    progressEvents: events,
    status: last?.status || 'started',
    phase: last?.phase || 'plan',
    blockers: last?.blockers || (last?.status === 'blocked' ? last?.summary : 'none'),
    nextAction: last?.nextAction || last?.summary || '(TBD)',
    lastValidation: last?.lastValidation || (last?.evidence?.find?.((e: any) => /validation/i.test(String(e))) || '(none recorded)'),
    decisions: last?.decisions,
    tradeoffs: last?.tradeoffs,
    validation: last?.validation || '(no validation command/result recorded yet)',
    evidence: last?.evidence,
    nextGoalCandidates: last?.nextGoalCandidates,
  });
  fs.writeFileSync(notesPath, html);
}

function appendGoalLedgerEvent(input: any = {}) {
  const ledgerPath = String(input.ledgerPath || '').trim();
  if (!ledgerPath) throw new Error('appendGoalLedgerEvent: ledgerPath required');
  if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isDirectory()) {
    throw new Error(`appendGoalLedgerEvent: ledger directory missing: ${ledgerPath}`);
  }
  const status = String(input.status || 'checkpoint').trim().toLowerCase();
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`appendGoalLedgerEvent: status must be one of ${VALID_STATUSES.join('|')}`);
  }
  const phase = input.phase != null ? String(input.phase).trim().toLowerCase() : null;
  if (phase && !VALID_PHASES.includes(phase)) {
    throw new Error(`appendGoalLedgerEvent: phase must be one of ${VALID_PHASES.join('|')}`);
  }
  const eventsPath = path.join(ledgerPath, 'progress.ndjson');
  const event = {
    schema: `${GOAL_LEDGER_VERSION}.progress`,
    at: input.at || nowIso(),
    status,
    phase,
    actor: input.actor ? String(input.actor) : null,
    summary: input.summary ? String(input.summary).slice(0, 600) : null,
    evidence: Array.isArray(input.evidence)
      ? input.evidence.map((line: any) => String(line).slice(0, 280))
      : input.evidence
        ? [String(input.evidence).slice(0, 280)]
        : [],
    blockers: input.blockers ? String(input.blockers).slice(0, 280) : null,
    nextAction: input.nextAction ? String(input.nextAction).slice(0, 280) : null,
    validation: input.validation ? String(input.validation).slice(0, 280) : null,
    lastValidation: input.lastValidation ? String(input.lastValidation).slice(0, 280) : null,
    decisions: Array.isArray(input.decisions) ? input.decisions.map((line: any) => String(line).slice(0, 280)) : [],
    tradeoffs: Array.isArray(input.tradeoffs) ? input.tradeoffs.map((line: any) => String(line).slice(0, 280)) : [],
    nextGoalCandidates: Array.isArray(input.nextGoalCandidates)
      ? input.nextGoalCandidates.map((line: any) => String(line).slice(0, 280))
      : [],
  };
  ensureDirSync(ledgerPath);
  fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');

  if (input.refreshNotes !== false) {
    const notesPath = path.join(ledgerPath, 'implementation-notes.html');
    const events = readProgressEvents(eventsPath);
    refreshImplementationNotes({
      notesPath,
      ledgerPath,
      events,
      missionId: input.missionId,
      featureId: input.featureId,
      startedAt: input.startedAt || (events[0]?.at) || nowIso(),
      title: input.title,
      objective: input.objective,
      acceptance: input.acceptance,
      protectedPaths: input.protectedPaths,
    });
  }

  return { written: true, event, eventsPath };
}

function buildGoalLedgerPointer({ ledgerPath, runId, missionId, featureId }: any = {}) {
  const dir = String(ledgerPath || '').trim();
  if (!dir) throw new Error('buildGoalLedgerPointer: ledgerPath required');
  return {
    schema: `${GOAL_LEDGER_VERSION}.pointer`,
    runId: runId ? String(runId) : path.basename(dir),
    ledgerPath: dir,
    goalPath: path.join(dir, 'GOAL.md'),
    notesPath: path.join(dir, 'implementation-notes.html'),
    eventsPath: path.join(dir, 'progress.ndjson'),
    evidenceDir: path.join(dir, 'evidence'),
    missionId: missionId ? String(missionId) : null,
    featureId: featureId ? String(featureId) : null,
  };
}

function readGoalLedger({ ledgerPath }: any = {}) {
  const dir = String(ledgerPath || '').trim();
  if (!dir || !fs.existsSync(dir)) return null;
  const eventsPath = path.join(dir, 'progress.ndjson');
  return {
    pointer: buildGoalLedgerPointer({ ledgerPath: dir }),
    goalMd: readFileOrEmpty(path.join(dir, 'GOAL.md')),
    events: readProgressEvents(eventsPath),
  };
}

module.exports = {
  GOAL_LEDGER_VERSION,
  VALID_STATUSES,
  VALID_PHASES,
  ensureGoalLedger,
  appendGoalLedgerEvent,
  buildGoalLedgerPointer,
  readGoalLedger,
  defaultRunId,
  slugify,
};
