// Ops Pulse — per-project signals aggregator + rule-based next-step suggestion
// engine for the Operations → Pulse panel (ace:ops-pulse).
//
// Read-only/derived (contracts §7): each non-personal workspace gets REAL
// signals from the merged telemetry spine (telemetry.cts query/aggregate),
// the Mission Board, cached workspace task/PR state, system health
// findings, and fresh 30-day git/gh activity probed in the workspace itself
// (git log --since / gh pr list). No daemon, no cache, no writes — every call
// recomputes from live sources, and every signal degrades independently to
// { ok:false, error } so one dead source never blanks a project card.
//
// Suggestions are rule-based and DISPLAY-ONLY (dispatch actions are P2): each
// rule emits { id, score, severity, title, reason, action }; the ranked list
// is sorted by score and the top entry is the card's next step.
//
// Everything is factory-injected (exec runner, clock, source getters) so the
// shapers and ranking rules unit-test pure.

const { execFile } = require('child_process');

const OPS_PULSE_SCHEMA = 'ace.ops.pulse.v1';
const PULSE_DAYS = 30;
// No commits AND nothing in flight for this long → "idle, spawn" suggestion.
const IDLE_DAYS = 7;
// Dispatch-ready cards untouched for this long count as stale.
const STALE_READY_DAYS = 3;
// Telemetry error-spike rule: at least this many events AND this error rate.
const MIN_ERROR_EVENTS = 5;
const ERROR_RATE_THRESHOLD = 0.25;
const GH_PR_LIMIT = 50;
const GH_PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,updatedAt,mergedAt,statusCheckRollup';
const DAY_MS = 86_400_000;

// Run a command and resolve { code, stdout, stderr, error } — never rejects
// (same contract as ops-status.cts execCapture; ENOENT degrades the signal).
function execCapture(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error: any }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: any) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFile(
        cmd,
        args,
        { timeout: opts.timeout || 10_000, cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024 },
        (error: any, stdout: any, stderr: any) => {
          done({
            code: error && typeof error.code === 'number' ? error.code : error ? null : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: error || null,
          });
        },
      );
    } catch (err: any) {
      done({ code: null, stdout: '', stderr: '', error: err });
    }
  });
}

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseMs(value: any) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// ── Pure shapers (unit-tested) ───────────────────────────────────────────────

// `git log --since=<days>.days --pretty=%cI` stdout → 30-day activity:
// commit count, last commit, active days, and a zero-filled per-day series.
function buildGitActivity(stdout: any, opts: any = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : PULSE_DAYS;
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const byDay = new Map<string, number>();
  let commits = 0;
  let lastCommitMs: number | null = null;
  for (const line of String(stdout || '').split('\n')) {
    const ms = parseMs(line.trim());
    if (ms == null) continue;
    commits += 1;
    if (lastCommitMs == null || ms > lastCommitMs) lastCommitMs = ms;
    const day = dayKey(ms);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const daily: any[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayKey(nowMs - i * DAY_MS);
    daily.push({ day, commits: byDay.get(day) || 0 });
  }
  return {
    ok: true,
    error: null as string | null,
    commits,
    lastCommitAt: lastCommitMs == null ? null : new Date(lastCommitMs).toISOString(),
    activeDays: byDay.size,
    daily,
  };
}

function prCiFailing(pr: any) {
  const rollup = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  return rollup.some(
    (ctx: any) => ctx?.conclusion === 'FAILURE' || ctx?.state === 'FAILURE' || ctx?.state === 'ERROR'
  );
}

// `gh pr list --state all --json …` rows → open/review/CI/merged-in-window
// counts plus the open items the card lists. Pure; window is `days` back.
function shapePrSignals(rows: any[], opts: any = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : PULSE_DAYS;
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const cutoffMs = nowMs - days * DAY_MS;
  const out = {
    ok: true,
    error: null as string | null,
    open: 0,
    drafts: 0,
    awaitingReview: 0,
    ciFailing: 0,
    merged: 0,
    awaitingReviewNumbers: [] as number[],
    ciFailingNumbers: [] as number[],
    items: [] as any[],
  };
  for (const pr of Array.isArray(rows) ? rows : []) {
    const state = String(pr?.state || '').toUpperCase();
    if (state === 'MERGED') {
      const mergedMs = parseMs(pr?.mergedAt);
      if (mergedMs != null && mergedMs >= cutoffMs) out.merged += 1;
      continue;
    }
    if (state !== 'OPEN') continue;
    out.open += 1;
    const failing = prCiFailing(pr);
    if (failing) {
      out.ciFailing += 1;
      out.ciFailingNumbers.push(Number(pr?.number) || 0);
    }
    if (pr?.isDraft) {
      out.drafts += 1;
    } else if (pr?.reviewDecision !== 'APPROVED') {
      // REVIEW_REQUIRED, CHANGES_REQUESTED, or unset — a human still owes a pass.
      out.awaitingReview += 1;
      out.awaitingReviewNumbers.push(Number(pr?.number) || 0);
    }
    out.items.push({
      number: Number(pr?.number) || 0,
      title: String(pr?.title || ''),
      url: pr?.url || null,
      isDraft: !!pr?.isDraft,
      reviewDecision: pr?.reviewDecision || null,
      ciFailing: failing,
      updatedAt: pr?.updatedAt || null,
    });
  }
  out.items = out.items.slice(0, 10);
  return out;
}

// Cached workspace.openPrs (gh pr list unavailable) → the same row shape
// shapePrSignals consumes. checksStatus:'failure' maps to a FAILURE rollup.
function cachedPrRows(openPrs: any[]) {
  return (Array.isArray(openPrs) ? openPrs : []).map((pr: any) => ({
    number: pr?.number,
    title: pr?.title,
    url: pr?.url || null,
    state: 'OPEN',
    isDraft: !!pr?.isDraft,
    reviewDecision: pr?.reviewDecision || null,
    updatedAt: null,
    mergedAt: null,
    statusCheckRollup: pr?.checksStatus === 'failure' ? [{ conclusion: 'FAILURE' }] : [],
  }));
}

function cardTimestampMs(card: any) {
  return (
    parseMs(card?.latestEvent?.createdAt) ??
    parseMs(card?.staleAt) ??
    parseMs(card?.startedAt) ??
    parseMs(card?.completedAt)
  );
}

// Mission Board cards for one workspace → stage/blocker/staleness counts.
function shapeMissionSignals(cards: any[], opts: any = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const staleCutoffMs = nowMs - STALE_READY_DAYS * DAY_MS;
  const active = (Array.isArray(cards) ? cards : []).filter((card: any) => !card?.archived);
  const ready = active.filter((card: any) => card?.dispatchReady === true);
  const staleReady = ready.filter((card: any) => {
    const ts = cardTimestampMs(card);
    return ts != null && ts < staleCutoffMs;
  });
  return {
    cards: active.length,
    inProgress: active.filter((card: any) => card?.cardStage === 'in_progress').length,
    readyToReview: active.filter((card: any) => card?.cardStage === 'ready_to_review').length,
    blocked: active.filter(
      (card: any) =>
        card?.dispatchStatus === 'blocked_by_dependencies' ||
        card?.gateStatus === 'blocked' ||
        card?.validationStatus === 'validation_failed'
    ).length,
    ready: ready.length,
    staleReady: staleReady.length,
    readyNames: ready.slice(0, 3).map((card: any) => String(card?.name || card?.id || '')),
  };
}

// telemetryQuery({kind:'aggregate', groupBy:'type', project, sinceMs}) result →
// the card's effectiveness rollup. agg.ok false degrades to ok:false.
function shapeTelemetrySignals(agg: any) {
  const base = {
    ok: false,
    error: null as string | null,
    events: 0,
    errors: 0,
    errorRate: 0,
    tokensIn: 0,
    tokensOut: 0,
    dispatches: 0,
  };
  if (!agg || agg.ok !== true || !Array.isArray(agg.rows)) {
    return { ...base, error: agg?.error || 'telemetry unavailable' };
  }
  const out = { ...base, ok: true };
  for (const row of agg.rows) {
    out.events += Number(row?.count) || 0;
    out.errors += Number(row?.errors) || 0;
    out.tokensIn += Number(row?.tokensIn) || 0;
    out.tokensOut += Number(row?.tokensOut) || 0;
    if (row?.key === 'task.dispatch') out.dispatches += Number(row?.count) || 0;
  }
  out.errorRate = out.events > 0 ? out.errors / out.events : 0;
  return out;
}

// ── Ranking rules ────────────────────────────────────────────────────────────
//
// Each rule fires independently; the list sorts by score desc and the top
// entry is the project's next step. Scores are spaced so a new rule can slot
// between existing ones without renumbering.

function rankSuggestions(signals: any, opts: any = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const { git = {}, prs = {}, missions = {}, agents = {}, telemetry = {} } = signals || {};
  const out: any[] = [];

  if (prs.ciFailing > 0) {
    out.push({
      id: 'fix-ci',
      score: 100,
      severity: 'red',
      title: `Fix failing CI on ${plural(prs.ciFailing, 'open PR')}`,
      reason: `PR${prs.ciFailing === 1 ? '' : 's'} #${(prs.ciFailingNumbers || []).join(', #')} ${prs.ciFailing === 1 ? 'has' : 'have'} failing checks.`,
      action: 'Open the failing checks and dispatch a fixback on the PR branch.',
    });
  }
  if (missions.blocked > 0) {
    out.push({
      id: 'unblock-cards',
      score: 90,
      severity: 'red',
      title: `Unblock ${plural(missions.blocked, 'mission card')}`,
      reason: 'Cards are blocked by dependencies, a failed validation, or a blocked gate.',
      action: 'Resolve the blocker (dependency, validation failure, or gate) and re-dispatch.',
    });
  }
  if (prs.awaitingReview > 0) {
    out.push({
      id: 'review-prs',
      score: 80,
      severity: 'yellow',
      title: `Review ${plural(prs.awaitingReview, 'open PR')}`,
      reason: `PR${prs.awaitingReview === 1 ? '' : 's'} #${(prs.awaitingReviewNumbers || []).join(', #')} ${prs.awaitingReview === 1 ? 'is' : 'are'} awaiting review.`,
      action: 'Review and merge, or request changes so the worker can fix back.',
    });
  }
  if (missions.staleReady > 0) {
    out.push({
      id: 'dispatch-stale-ready',
      score: 70,
      severity: 'yellow',
      title: `Dispatch ${plural(missions.staleReady, 'stale ready card')}`,
      reason: `Dispatch-ready cards have sat untouched for over ${STALE_READY_DAYS} days.`,
      action: 'Dispatch from the Mission Board, or archive cards that no longer matter.',
    });
  }
  if (telemetry.ok && telemetry.events >= MIN_ERROR_EVENTS && telemetry.errorRate >= ERROR_RATE_THRESHOLD) {
    out.push({
      id: 'investigate-errors',
      score: 65,
      severity: 'yellow',
      title: 'Investigate agent errors',
      reason: `${telemetry.errors} of ${telemetry.events} telemetry events in the last ${PULSE_DAYS} days failed (${Math.round(telemetry.errorRate * 100)}%).`,
      action: 'Query the telemetry log for this project and fix the dominant error class.',
    });
  }
  if (missions.ready - missions.staleReady > 0) {
    const fresh = missions.ready - missions.staleReady;
    out.push({
      id: 'dispatch-ready',
      score: 55,
      severity: 'green',
      title: `Dispatch ${plural(fresh, 'ready card')}`,
      reason: `Ready on the board: ${(missions.readyNames || []).filter(Boolean).join(', ') || 'see Mission Board'}.`,
      action: 'Dispatch the next ready card from the Mission Board.',
    });
  }
  const lastCommitMs = parseMs(git.lastCommitAt);
  const idleDays = lastCommitMs == null ? null : Math.floor((nowMs - lastCommitMs) / DAY_MS);
  if (prs.drafts > 0 && (idleDays == null || idleDays >= STALE_READY_DAYS)) {
    out.push({
      id: 'finish-drafts',
      score: 50,
      severity: 'yellow',
      title: `Finish ${plural(prs.drafts, 'draft PR')}`,
      reason: 'Draft PRs are open with no recent commits behind them.',
      action: 'Mark ready for review, or close drafts that are abandoned.',
    });
  }
  if (
    git.ok &&
    (idleDays == null || idleDays >= IDLE_DAYS) &&
    !prs.open &&
    !missions.inProgress &&
    !(agents.activeTasks > 0)
  ) {
    out.push({
      id: 'spawn-idle',
      score: 45,
      severity: 'yellow',
      title: idleDays == null ? 'No activity in 30 days — spawn an agent' : `Idle ${idleDays} days — spawn an agent`,
      reason: 'No commits, open PRs, active cards, or running tasks.',
      action: 'Pick the next milestone and spawn a worker, or archive the project.',
    });
  }
  out.push({
    id: 'steady',
    score: 10,
    severity: 'green',
    title: 'On track — keep shipping',
    reason: `${plural(git.commits || 0, 'commit')} and ${plural(prs.merged || 0, 'merged PR')} in the last ${PULSE_DAYS} days; nothing needs attention.`,
    action: 'Continue current work.',
  });

  return out.sort((a, b) => b.score - a.score);
}

// Worst-of severity across fired (non-fallback) suggestions.
function healthFromSuggestions(suggestions: any[]) {
  let health = 'green';
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (s?.id === 'steady') continue;
    if (s?.severity === 'red') return 'red';
    if (s?.severity === 'yellow') health = 'yellow';
  }
  return health;
}

// ── Collectors ───────────────────────────────────────────────────────────────

async function collectGitActivity(workspace: any, deps: any) {
  const { exec, nowMs, days } = deps;
  const cwd = !workspace.isRemote && typeof workspace.path === 'string' ? workspace.path : null;
  if (!cwd) {
    return { ...buildGitActivity('', { nowMs, days }), ok: false, error: 'no local worktree' };
  }
  const log = await exec('git', ['log', `--since=${days}.days`, '--pretty=%cI'], { cwd });
  if (log.error) {
    return {
      ...buildGitActivity('', { nowMs, days }),
      ok: false,
      error: log.stderr.trim().split('\n')[0] || log.error.message || 'git log failed',
    };
  }
  const activity = buildGitActivity(log.stdout, { nowMs, days });
  if (activity.lastCommitAt == null) {
    // Nothing in the window — fetch the last commit overall so idle-days is real.
    const last = await exec('git', ['log', '-1', '--pretty=%cI'], { cwd });
    const ms = parseMs(last.stdout.trim().split('\n')[0]);
    if (ms != null) activity.lastCommitAt = new Date(ms).toISOString();
  }
  return activity;
}

async function collectPrSignals(workspace: any, deps: any) {
  const { exec, nowMs, days } = deps;
  const repo = typeof workspace.githubRepo === 'string' ? workspace.githubRepo.trim() : '';
  if (repo) {
    const gh = await exec(
      'gh',
      ['pr', 'list', '--repo', repo, '--state', 'all', '-L', String(GH_PR_LIMIT), '--json', GH_PR_FIELDS],
      { timeout: 15_000 },
    );
    if (!gh.error) {
      try {
        return shapePrSignals(JSON.parse(gh.stdout || '[]'), { nowMs, days });
      } catch {
        // fall through to the cached rows below
      }
    }
  }
  // gh unavailable / no repo → cached open-PR state (real, just less fresh;
  // merged-in-window stays 0 because the cache only tracks open PRs).
  const shaped = shapePrSignals(cachedPrRows(workspace.openPrs), { nowMs, days });
  return { ...shaped, error: repo ? 'gh pr list failed; using cached open PRs' : 'no github repo; using cached open PRs' };
}

function shapeAgentSignals(workspace: any) {
  const tasks = (Array.isArray(workspace.tasks) ? workspace.tasks : []).filter(
    (task: any) => task?.status !== 'done'
  );
  return {
    activeTasks: tasks.length,
    busy: tasks.filter((task: any) => task?.status === 'busy').length,
    agents: Array.from(new Set(tasks.map((task: any) => String(task?.agent || '')).filter(Boolean))),
  };
}

async function collectProjectPulse(workspace: any, cards: any[], deps: any) {
  const { exec, nowMs, days, telemetryQuery } = deps;
  const [git, prs] = await Promise.all([
    collectGitActivity(workspace, deps),
    collectPrSignals(workspace, deps),
  ]);
  const missions = shapeMissionSignals(cards, { nowMs });
  const agents = shapeAgentSignals(workspace);
  let telemetry;
  try {
    telemetry = shapeTelemetrySignals(
      telemetryQuery({
        kind: 'aggregate',
        groupBy: 'type',
        project: workspace.id,
        sinceMs: nowMs - days * DAY_MS,
      })
    );
  } catch (err: any) {
    telemetry = shapeTelemetrySignals({ ok: false, error: err?.message || 'telemetry query failed' });
  }
  const signals = { git, prs, missions, agents, telemetry };
  const suggestions = rankSuggestions(signals, { nowMs });
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    githubRepo: workspace.githubRepo || null,
    isRemote: !!workspace.isRemote,
    health: healthFromSuggestions(suggestions),
    ...signals,
    suggestions,
    nextStep: suggestions[0] || null,
  };
}

// System ops-status findings → a compact degraded-only rollup (per-project CI
// state already comes from gh; findings stay system-scoped here).
function shapeFindingsSummary(findings: any[]) {
  const rows = (Array.isArray(findings) ? findings : []).filter(
    (finding: any) => finding?.severity === 'yellow' || finding?.severity === 'red' || finding?.severity === 'black'
  );
  return {
    yellow: rows.filter((f: any) => f.severity === 'yellow').length,
    red: rows.filter((f: any) => f.severity === 'red').length,
    black: rows.filter((f: any) => f.severity === 'black').length,
    titles: rows.slice(0, 3).map((f: any) => String(f?.title || f?.id || '')),
  };
}

async function collectOpsPulse(deps: any = {}) {
  const {
    listWorkspaces = () => [],
    getMissionBoard = () => ({ missions: [] }),
    telemetryQuery = () => null,
    getFindings = null,
    exec = execCapture,
    now = () => Date.now(),
    days = PULSE_DAYS,
  } = deps;
  const nowMs = now();

  let workspaces: any[] = [];
  try {
    workspaces = (listWorkspaces() || []).filter((w: any) => w && !w.isPersonal);
  } catch {
    workspaces = [];
  }

  const cardsByWorkspace = new Map<string, any[]>();
  try {
    const board = getMissionBoard() || {};
    for (const mission of Array.isArray(board.missions) ? board.missions : []) {
      const list = cardsByWorkspace.get(mission.workspaceId) ?? [];
      list.push(...(Array.isArray(mission.cards) ? mission.cards : []));
      cardsByWorkspace.set(mission.workspaceId, list);
    }
  } catch {
    // Board unavailable → mission signals degrade to zeros per project.
  }

  const projectDeps = { exec, nowMs, days, telemetryQuery };
  const [projects, findings] = await Promise.all([
    Promise.all(
      workspaces.map((workspace: any) =>
        collectProjectPulse(workspace, cardsByWorkspace.get(workspace.id) ?? [], projectDeps)
      )
    ),
    typeof getFindings === 'function'
      ? Promise.resolve()
          .then(() => getFindings())
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    schema: OPS_PULSE_SCHEMA,
    timestamp: new Date(nowMs).toISOString(),
    days,
    projects,
    opsFindings: shapeFindingsSummary(findings as any[]),
  };
}

module.exports = {
  OPS_PULSE_SCHEMA,
  PULSE_DAYS,
  IDLE_DAYS,
  STALE_READY_DAYS,
  buildGitActivity,
  shapePrSignals,
  cachedPrRows,
  shapeMissionSignals,
  shapeTelemetrySignals,
  rankSuggestions,
  healthFromSuggestions,
  shapeFindingsSummary,
  collectProjectPulse,
  collectOpsPulse,
};
