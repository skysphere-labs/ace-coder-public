

const fs = require('fs');
const path = require('path');
const os = require('os');
// Bound on how long an auth teardown waits for the detached pty-host daemon to
// confirm kills before closing the host socket, so a hung daemon can't stall sign-out.
const DETACHED_KILL_CONFIRM_TIMEOUT_MS = Number(process.env.ACE_DETACHED_KILL_CONFIRM_MS) >= 0
  ? Number(process.env.ACE_DETACHED_KILL_CONFIRM_MS)
  : 2000;

// Fail-closed detached-agent teardown for an AUTH shutdown: best-effort graceful kill of
// the registered streams (bounded), then force-terminate the host PROCESS (a socket close
// won't — the daemon outlives client disconnects). PID-REUSE SAFE: a raw pid can be reused
// after the daemon exits, so PREFER a retained ChildProcess handle; for an adopted pid,
// identity-verify (signal-0 liveness + a start-time/argv signature captured at adopt time)
// before EVERY signal and SKIP any we can't confirm still targets our daemon. Deps injected.
// Returns 'terminated' | 'terminated-graceful' (SIGKILL skipped) | 'no-host'.
async function terminateDetachedHost(opts: {
  pendingKills: Array<Promise<any>>;
  hostPid: number | null;
  timeoutMs: number;
  kill?: (pid: number, signal: string) => void;
  sleep?: (ms: number) => Promise<void>;
  childHandle?: { kill: (signal?: string) => void } | null;
  verifyIdentity?: (pid: number) => boolean;
  logger?: { warn?: (...a: any[]) => void };
}): Promise<'terminated' | 'terminated-graceful' | 'no-host'> {
  const kill = opts.kill ?? ((pid: number, signal: string) => process.kill(pid, signal as any));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const logger = opts.logger ?? console;
  if (opts.pendingKills && opts.pendingKills.length) {
    // Graceful pre-kill of the REGISTERED streams, bounded (a rejected/never-
    // settling ack can't hold up teardown — the host kill below is the guarantee).
    await Promise.race([
      Promise.allSettled(opts.pendingKills),
      sleep(opts.timeoutMs),
    ]);
  }
  // Prefer the retained ChildProcess handle — immune to PID reuse.
  if (opts.childHandle && typeof opts.childHandle.kill === 'function') {
    try { opts.childHandle.kill('SIGTERM'); } catch {}
    await sleep(300);
    try { opts.childHandle.kill('SIGKILL'); } catch {}
    return 'terminated';
  }
  if (!(Number.isInteger(opts.hostPid) && (opts.hostPid as number) > 0)) return 'no-host';
  const pid = opts.hostPid as number;
  // A missing verifier means the caller vouches for the pid (unit tests / trusted path).
  const stillOurs = () => (typeof opts.verifyIdentity === 'function' ? Boolean(opts.verifyIdentity(pid)) : true);
  if (!stillOurs()) {
    logger.warn?.(`[ace] detached host pid ${pid} is not our daemon (exited/reused) — no signal sent`);
    return 'no-host';
  }
  try { kill(pid, 'SIGTERM'); } catch {}
  await sleep(300);
  // Re-verify before escalating: SIGTERM may have made it exit, and the pid may now be
  // reused — skip the SIGKILL rather than blind-kill a stranger.
  if (!stillOurs()) {
    logger.warn?.(`[ace] detached host pid ${pid} gone after SIGTERM — skipping SIGKILL (no blind-kill)`);
    return 'terminated-graceful';
  }
  try { kill(pid, 'SIGKILL'); } catch {}
  return 'terminated';
}

// Discover a survivor detached-host PID for an AUTH teardown WITHOUT spawning. Uses the
// pty-host's survivor-only connectExisting() — NEVER ensureConnected(), whose uncancelled
// spawn+retry could connect-or-SPAWN a daemon that outlives sign-out if it finishes after
// teardown moved on. Bounded + awaited so nothing trails the teardown. Returns a positive
// pid or null (no survivor / timed out → nothing to kill). Deps injected.
async function discoverSurvivorHostPid(
  ptyHost: any,
  timeoutMs: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<number | null> {
  let pid = typeof ptyHost?.hostPid === 'function' ? ptyHost.hostPid() : null;
  if (typeof pid === 'number' && pid > 0) return pid;
  if (ptyHost && typeof ptyHost.connectExisting === 'function') {
    const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try { await Promise.race([ptyHost.connectExisting(), wait(timeoutMs)]); } catch {}
    pid = typeof ptyHost.hostPid === 'function' ? ptyHost.hostPid() : null;
  }
  return typeof pid === 'number' && pid > 0 ? pid : null;
}

// Boot-time fail-closed teardown of a PRIOR session's preserved detached host for
// when the heavy runtime never boots: a normal quit leaves host-backed agents in
// the pty-host, and if the account is then revoked while Ace is closed the next
// launch is DENIED with no store/ptyHost ever constructed. Connects to the SURVIVOR
// daemon only (never spawns) and force-terminates it by PID via terminateDetachedHost.
// No survivor ⇒ 'no-host'. Deps injected. Returns 'terminated' | 'terminated-graceful' | 'no-host'.
async function terminatePreservedDetachedHost(opts: {
  userDataPath: string;
  timeoutMs?: number;
  logger?: any;
  createClient?: (o: any) => any;
  kill?: (pid: number, signal: string) => void;
  sleep?: (ms: number) => Promise<void>;
  makeIdentityGuard?: (pid: number) => (checkPid: number) => boolean;
}): Promise<'terminated' | 'terminated-graceful' | 'no-host'> {
  // NOT gated on detachedAgentStreamsEnabled(): this only ever connects to an
  // ALREADY-RUNNING daemon and never spawns one. Skipping it when detached mode
  // is off left a preserved survivor — including a pre-upgrade one still running
  // the credential gateway and its listener — alive through a confirmed denial,
  // the one path where no store exists to sweep it.
  const logger = opts.logger ?? console;
  const createClient = opts.createClient ?? ((o: any) => ptyHostLib.createPtyHostClient(o));
  let client: any = null;
  try {
    client = createClient({ userDataPath: opts.userDataPath });
    const streams = typeof client.connectExisting === 'function' ? await client.connectExisting() : null;
    if (streams === null) return 'no-host';
    const pid = typeof client.hostPid === 'function' ? client.hostPid() : null;
    // Adopt-time identity capture: connectExisting() just completed a hello, so the
    // survivor is live NOW — snapshot its start-time/argv signature and re-verify before
    // each signal so a post-SIGTERM pid reuse is never blind-killed.
    const makeGuard = opts.makeIdentityGuard ?? ((p: number) => makeHostIdentityGuard(p));
    const verifyIdentity = typeof pid === 'number' ? makeGuard(pid) : undefined;
    // pendingKills is empty: nothing was adopted/registered this launch, so the
    // host-PID kill is the whole guarantee (mirrors the zero-registered-kills case).
    return await terminateDetachedHost({
      pendingKills: [],
      hostPid: typeof pid === 'number' ? pid : null,
      timeoutMs: opts.timeoutMs ?? DETACHED_KILL_CONFIRM_TIMEOUT_MS,
      kill: opts.kill,
      sleep: opts.sleep,
      verifyIdentity,
      logger: opts.logger,
    });
  } catch (err: any) {
    logger.warn?.('[ace] preserved detached-host teardown failed:', err?.message || err);
    return 'no-host';
  } finally {
    try { client?.close?.(); } catch {}
  }
}
// Tolerant: unit tests and headless CI load this module without a working
// electron binary. The sole consumer (shell.trashItem) already falls back to
// rmSync inside its own try/catch when shell is unavailable.
let shell: any = null;
try {
  ({ shell } = require('electron'));
} catch { /* non-electron host */ }
const { execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { randomUUID, randomBytes, createHmac } = require('crypto');
const Database = require('better-sqlite3');
const { SshDaemonManager, listSshHosts } = require('./ssh-daemon.cjs');
const { coerceBuffer: coerceAttachmentBytes } = require('./paste-store.cjs');
const {
  PROVIDERS,
  PREREQUISITES,
  getProvider,
  getAllAgentIds,
  applyResumeArgs,
  resolveSessionFile,
  findNewestSessionIdInCwd,
  sessionFileState,
  decideSessionRebind,
} = require('./agent-providers.cjs');
const skillsCore = require('./skills-core.cjs');
const mcpCore = require('./mcp-core.cjs');
const hermesHome = require('./hermes-home.cjs');
const operatorsLib = require('./operators.cts');
const {
  createHermesDashboardManager,
  resolveHermesDesktopApp,
  loadSurfaceConfig: loadHermesSurfaceConfig,
} = require('./hermes-dashboard.cts');
const { createHomeChatController } = require('./hermes-home-chat.cts');
const hermesUpdate = require('./hermes-update.cts');
const hermesPaths = require('./hermes-paths.cts');
const opsPulseLib = require('./ops-pulse.cts');
const telemetryLib = require('./telemetry.cts');
const claudeAuthPolicy = require('./claude-auth-policy.cts');
const usageCoreLib = require('./usage-core.cts');
const perfHealth = require('./perf-health.cts');
const { createCoalescer } = require('./coalesce.cts');
const ptyHostLib = require('./pty-host.cts');
// One implementation of the pid-reuse guard, defined beside the daemon it guards.
const { makeHostIdentityGuard } = ptyHostLib;
const externalDataRoot = require('./external-data-root.cjs');
const { socketPath: aceSocketPath } = require('./ace-control/socket-bridge.cjs');
const {
  MISSION_EVENT_TYPES,
  ensureMissionSchema,
  projectMissions,
  projectMissionBoard,
  setMissionIdentityConfig,
} = require('./mission-domain-stub.cjs');
const { createIntegrationGateway } = require('./integration-gateway.cjs');
const { createIntegrationContextImporter } = require('./integration-context-import.cjs');
const {
  normalizeValidationFailurePacket,
} = require('../tools/ace/src/validation-artifacts.cjs');
const {
  FIXBACK_RETRY_MAX_ATTEMPTS,
  parseGhJson,
} = require('../tools/ace/src/pr-gate.cjs');
const { createGetTaskSpec } = require('./task-spec.cjs');
const {
  buildWakeBriefPayload,
  formatWakeBrief,
  buildHermesWakePrompt: composeHermesWakePrompt,
  shouldDeliverAutoWakePrompt,
} = require('./wake-brief.cjs');
const {
  buildOrchestratorPrompt: composeOrchestratorPrompt,
} = require('./orchestrator-prompt.cjs');
const { buildTaskPromptEnvelope, parseTrailer: parseMissionTrailer } = require('../tools/ace/src/prompt.cjs');
const { launchIntentSkillIds } = require('../tools/ace/src/skill-loader.cjs');
// buildLaunchIntent is the SINGLE source of truth for the full launch intent
// (provider/reasoningEffort/cliArgs/ultraCode/workflowMode/effortCommand/
// preludeCommands/guidance/skillIds). The Mission Board path delegates to it so
// it carries the SAME ultracode/dynamic-workflow prelude as the CLI path —
// previously buildScopedLaunchIntent only carried provider/reasoningEffort/
// skillIds and silently dropped the rest. tools/ace never requires electron,
// so this import is acyclic.
const {
  buildLaunchIntent,
  codexAppParityRequested,
  CODEX_APP_PARITY_PROFILE,
} = require('../tools/ace/src/orchestrator.cjs');
const toolContract = require('../tools/ace/src/tool-contract.cjs');
const changeRiskPolicy = require('../tools/ace/src/change-risk-policy.cjs');
const goalLedger = require('../tools/ace/src/goal-ledger.cjs');
const acceptanceLedger = require('../tools/ace/src/acceptance-ledger.cjs');
const goalValidationPolicy = require('../tools/ace/src/goal-validation-policy.cjs');
const orchestrationPolicy = require('../tools/ace/src/orchestration-policy.cjs');
// pr-autopilot ships from the mission-board lane and is not present on every
// branch. Keep the require non-fatal with inert fallbacks so a missing module
// can never crash app boot (regression: a merged build without it hard-crashed
// at local-core load time).
let prAutopilotPolicy: any;
try {
  prAutopilotPolicy = require('../tools/ace/src/pr-autopilot.cjs');
} catch {
  prAutopilotPolicy = {
    deriveCardAutopilot: (card: any) => (card ? card.autopilot ?? null : null),
    summarizeMergeEnvelope: (env: any) => ({ ok: !!(env && env.ok), result: (env && env.result) || null }),
  };
}
const wikiUpdater = require('./wiki-updater.cjs');
const { runOpsStatus } = require('./ops-status.cjs');
const vectorOpsAdapter = require('./vector-ops-adapter.cjs');

function resolveClaudeProcessSessionId({ expectedSessionId, cwd, configDir }: any, deps: any = {}) {
  if (!expectedSessionId || !cwd) return null;
  const listProcesses = deps.listProcesses || (() => execFileSync(
    'ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  ));
  const readFile = deps.readFile || ((file: string) => fs.readFileSync(file, 'utf8'));
  const escaped = String(expectedSessionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sessionFlag = new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${escaped}(?:\\s|$)`);
  const matches = String(listProcesses() || '')
    .split(/\r?\n/)
    .map((line: string) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match: any) => {
      if (!match) return false;
      const executable = String(match[2]).trim().split(/\s+/, 1)[0];
      return path.basename(executable) === 'claude' && sessionFlag.test(match[2]);
    });
  if (matches.length !== 1) return null;
  const pid = Number(matches[0][1]);
  try {
    const root = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const row = JSON.parse(readFile(path.join(root, 'sessions', `${pid}.json`)));
    if (Number(row?.pid) !== pid || path.resolve(String(row?.cwd || '')) !== path.resolve(String(cwd))) return null;
    const sessionId = String(row?.sessionId || '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
      ? sessionId
      : null;
  } catch {
    return null;
  }
}

let opsRefresh: any;
try {
  opsRefresh = require('./ops-refresh.cjs');
} catch {
  opsRefresh = require('./ops-refresh.cts');
}
let agentCliDriver: any;
try {
  agentCliDriver = require('./agent-cli-driver.cjs');
} catch {
  agentCliDriver = require('./agent-cli-driver.cts');
}
const opsBriefScheduler = require('./ops-brief-scheduler.cjs');
const opsTodos = require('./ops-todos.cjs');
const opsSources = require('./ops-sources.cjs');
const wikiGraphIndexer = require('./wiki-graph-indexer.cjs');
const knowledgeIndexModule = require('./knowledge-index.cjs');
// Project wiki curator (role packs + dump intake) — same cross-package layout
// the CLI relies on in the packaged app (tools/ace ships beside electron/).
const projectWikiCurator = require('../tools/ace/src/project-wiki-curator.cjs');
const hermesMemoryReader = require('./hermes-memory-reader.cjs');
const knowledgeAudit = require('./knowledge-audit.cjs');
const knowledgeNightlyScheduler = require('./knowledge-nightly-scheduler.cjs');
const knowledgeEvalModule = require('./knowledge-eval.cjs');
const {
  deriveStreamLabelForTask,
  deriveTaskSlug,
  deriveTaskTitle,
  slugifyTitle,
} = require('./task-title.cts');
// Dump-only-no-canon fix: enumerate curation targets by dumps-OR-wiki so the
// nightly loop bootstraps canon for projects that only have wiki-dump/ (see
// electron/wiki-bootstrap.cts + docs/architecture/ace-llm-wiki-memory-root-cause.md).
const wikiBootstrap = require('./wiki-bootstrap.cjs');
// Wiki/knowledge health (AceWikiHealth/v1) for the Wiki tab health panel.
const wikiHealthModule = require('./wiki-health.cjs');
const { readNightlyState } = require('./knowledge-nightly-scheduler.cjs');
const {
  shouldAutoStartAlwaysOnOrchestrator,
} = require('./orchestrator-policy.cjs');
const agentLanes = require('./agent-lanes.cjs');
const hermesProfiles = require('./hermes-profiles.cjs');
const {
  DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD,
  createBaseBranchPolicyModule,
  resolveRemoteBaseHygiene,
} = require('./core/base-branch-policy.cts');

// Extracted seams (ARCHITECTURE.md strangler roadmap): PATH enhancement and
// the git watcher live in their own modules; local-core re-exports
// createGitWatcher for existing consumers. enhanceShellPath() keeps its
// original module-load boot point.
const { enhanceShellPath } = require('./shell-path.cts');
const { createGitWatcher, shouldUseFullTreeGitWatcher } = require('./git-watcher.cts');
enhanceShellPath();

function missionDeliveryMode(input) {
  const mode = String(input?.mode || 'paste').trim().toLowerCase();
  if (mode === 'paste' || mode === 'type') return mode;
  throw new Error(`mission dispatch mode must be paste or type, got ${mode}`);
}

function extractMissionPrUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s),;]+\/pull\/\d+/i);
  return match ? match[0] : null;
}

function extractMissionPrNumber(value) {
  const text = String(value || '').trim();
  const fromUrl = text.match(/\/pull\/([1-9]\d*)/);
  if (fromUrl) return Number(fromUrl[1]);
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanMissionString(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function cleanMissionStringList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((item) => cleanMissionString(item)).filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('[ace] node-pty unavailable:', err.message);
}



const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const HERMES_WAKE_BRIEF_COOLDOWN_MS = 60_000;
const ALWAYS_ON_ORCHESTRATOR_WATCHDOG_INTERVAL_MS = 5 * 60_000;

const hermesWakeBriefSentAt = new Map();

function slugify(name) {
  return slugifyTitle(name);
}

// Map a task's `taskType` (from the delegation spec or task-kind field) to
// the short kebab tag we suffix branch names with. Closed vocabulary — any
// unknown/missing value falls back to 'update' so branches still get a
// meaningful tail (never `<slug>-undefined`).
const TASK_TYPE_TAG_MAP = {
  'feature-impl': 'feat',
  feat: 'feat',
  feature: 'feat',
  'bug-fix': 'bug',
  bug: 'bug',
  bugfix: 'bug',
  ui: 'ui',
  refactor: 'refactor',
  'code-review': 'review',
  review: 'review',
  'github-steward': 'ops',
  ops: 'ops',
  update: 'update',
};

function resolveTaskTypeTag(taskType) {
  const key = String(taskType || '').trim().toLowerCase();
  if (!key) return 'update';
  return TASK_TYPE_TAG_MAP[key] || 'update';
}

function createAlwaysOnOrchestratorWatchdog({
  rehydrate,
  pollIntervalMs = ALWAYS_ON_ORCHESTRATOR_WATCHDOG_INTERVAL_MS,
  logger = console,
  onTick = null,
}: any = {}) {
  if (typeof rehydrate !== 'function') {
    throw new Error('createAlwaysOnOrchestratorWatchdog: rehydrate function required');
  }

  let running = false;
  let timer: any = null;
  let latestSnapshot: any = null;

  async function tickOnce() {
    const tickAt = Date.now();
    try {
      const result = await rehydrate();
      latestSnapshot = {
        tickAt,
        intervalMs: pollIntervalMs,
        ok: true,
        result,
      };
    } catch (err: any) {
      latestSnapshot = {
        tickAt,
        intervalMs: pollIntervalMs,
        ok: false,
        error: err && err.message ? err.message : String(err),
      };
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[ace] always-on orchestrator watchdog tick failed:', latestSnapshot.error);
      }
    }

    if (typeof onTick === 'function') {
      try {
        onTick(latestSnapshot);
      } catch (err: any) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[ace] always-on orchestrator watchdog onTick failed:', err && err.message ? err.message : err);
        }
      }
    }
    return latestSnapshot;
  }

  function scheduleNext() {
    if (!running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      tickOnce().finally(() => {
        scheduleNext();
      });
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    tickOnce().finally(() => {
      scheduleNext();
    });
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function snapshot() {
    return latestSnapshot;
  }

  return { start, stop, tickOnce, snapshot };
}

async function createDelegatedTaskWithDeps({
  workspaceId,
  agent,
  goal,
  label,
  prompt,
  taskType,
  refreshBase,
  refreshProjectDefaultBranchImpl,
  getEffectiveBaseBranchImpl,
  createTaskImpl,
  getTaskArtifactsImpl,
  now = () => new Date(),
}) {
  if (!workspaceId) throw new Error('createDelegatedTask: workspaceId required');
  if (!agent) throw new Error('createDelegatedTask: agent required');
  const baseRefreshMode = normalizeRefreshBaseMode(refreshBase);
  if (baseRefreshMode !== 'false') {
    await refreshProjectDefaultBranchImpl({
      projectId: workspaceId,
      mode: baseRefreshMode,
      ...(baseRefreshMode === 'force' ? { threshold: 0 } : {}),
    });
  }
  const { effectiveBaseBranch } = getEffectiveBaseBranchImpl({ projectId: workspaceId });
  const name = deriveTaskTitle({
    label,
    goal,
    prompt,
    agent,
    fallback: `delegated:${agent}:${now().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
  });
  const { id: taskId } = await createTaskImpl({
    workspaceId,
    input: {
      name,
      agent,
      prompt: prompt || null,
      autoApproveEnabled: true,
      useWorktree: true,
      baseBranch: effectiveBaseBranch,
      skipWorktreeFetch: true,
      taskType: taskType || null,
      delegated: true,
    },
  });
  const { worktree, variant } = await getTaskArtifactsImpl(taskId);
  const baseHygiene = worktree ? {
    baseBranch: worktree.base_branch ?? null,
    selectedBase: worktree.branch_point ?? worktree.remote_base_ref ?? worktree.base_branch ?? null,
    selectedBaseKind: worktree.remote_base_ref ? 'remote' : 'local',
    remoteBaseRef: worktree.remote_base_ref ?? null,
    remoteBaseSha: worktree.base_sha ?? null,
    localBaseSha: worktree.local_base_sha ?? null,
    localAheadBy: Number(worktree.local_ahead_by || 0),
    localBehindBy: Number(worktree.local_behind_by || 0),
    diverged: Number(worktree.local_ahead_by || 0) > 0 && Number(worktree.local_behind_by || 0) > 0,
    branchPoint: worktree.branch_point ?? worktree.remote_base_ref ?? worktree.base_branch ?? null,
    ok: true,
  } : null;
  telemetryLib.telemetryEmit({
    type: 'task.dispatch',
    project: workspaceId,
    agent,
    source: 'delegated-task',
    ok: true,
    meta: {
      taskId,
      taskType: taskType || null,
      branch: worktree ? worktree.branch : null,
    },
  });
  return {
    taskId,
    name,
    worktreeId: worktree ? worktree.id : null,
    worktreePath: worktree ? worktree.path : null,
    branch: worktree ? worktree.branch : null,
    baseBranch: worktree ? worktree.base_branch : null,
    baseHygiene,
    baseRefreshMode,
    variantId: variant ? variant.id : null,
  };
}

// Pure: given a candidate `<slug>-<tag>` base and a pair of async existence
// predicates, pick the first free branch name. Tries `base`, then `base-2`,
// `base-3`, … up to `maxTries`. Throws if every candidate collides. Shared
// by createWorktreeForTask (local + remote) and exercised directly by tests.
async function computeFreeBranchName({ baseCandidate, refExists, pathExists, worktreeJoin, maxTries = 20 }) {
  let branch = baseCandidate;
  let worktreePath = worktreeJoin(branch);
  for (let i = 2; i <= maxTries + 1; i++) {
    const [hasRef, hasDir] = await Promise.all([refExists(branch), pathExists(worktreePath)]);
    if (!hasRef && !hasDir) return { branch, worktreePath };
    if (i > maxTries) {
      throw new Error(
        `createWorktreeForTask: could not find a free branch name after ${maxTries} tries (last tried: ${branch}). Delete old worktrees or rename the task.`
      );
    }
    branch = `${baseCandidate}-${i}`;
    worktreePath = worktreeJoin(branch);
  }
  // Unreachable — the loop always returns or throws.
  throw new Error('computeFreeBranchName: unreachable');
}

const EXPECTED_DOCTRINE_FILES = Object.freeze(['CLAUDE.md', 'AGENTS.md']);
const DOCTRINE_DOC_PATH = 'docs/auto-loaded-doctrine.md';

function minimalDoctrineFileContent(name) {
  if (name === 'CLAUDE.md') {
    return [
      '# CLAUDE.md',
      '',
      'Ace seeded this minimal Claude Code overlay because this Ace-owned coding-worker workspace did not include repo-provided Claude doctrine.',
      '',
      '- Read `AGENTS.md` first when present; it is the canonical coding-worker contract.',
      '- Use Claude for implementation planning, review judgment, UI/product judgment, and debugging inside the current task scope.',
      '- Do not coordinate external Ace agents unless the owner explicitly grants that responsibility.',
      '- Missing repo doctrine is not a blocker by itself; continue from the task prompt, GoalAgentSpec, allowed paths, and bundled skills.',
      '',
    ].join('\n');
  }
  return [
    '# AGENTS.md',
    '',
    'Ace seeded this minimal fallback because this Ace-owned coding-worker workspace did not include repo-provided agent doctrine.',
    '',
    '- You are a secure, surgical coding worker.',
    '- Follow the task prompt, GoalAgentSpec, allowed paths, and bundled skills.',
    '- Keep changes scoped, protect secrets/PII, avoid destructive commands without approval, and verify before DONE.',
    '- Missing repo doctrine is not a blocker by itself; continue with task-local instructions.',
    '',
  ].join('\n');
}

async function ensureWorktreeDoctrineFiles({
  worktreePath,
  exists,
  writeFile,
  seedMissing = false,
  warn = console.warn,
}) {
  const missing = [];
  const seeded = [];
  const failed = [];
  for (const name of EXPECTED_DOCTRINE_FILES) {
    const fullPath = path.join(worktreePath, name);
    if (await exists(fullPath)) continue;
    missing.push(name);
    if (!seedMissing || typeof writeFile !== 'function') continue;
    try {
      await writeFile(fullPath, minimalDoctrineFileContent(name));
      seeded.push(name);
    } catch (err) {
      failed.push({ name, error: err });
    }
  }
  if (failed.length > 0) {
    warn(
      `[ace] worktree doctrine preflight: failed to seed ${failed.map((entry) => entry.name).join(', ')} in ${worktreePath}. ` +
      `Workers can continue with task-local instructions; see ${DOCTRINE_DOC_PATH}.`
    );
  } else if (missing.length > 0 && !seedMissing) {
    warn(
      `[ace] worktree doctrine preflight: missing ${missing.join(', ')} in ${worktreePath}. ` +
      `Workers can continue with task-local instructions; see ${DOCTRINE_DOC_PATH}.`
    );
  }
  return { missing, seeded, failed: failed.map((entry) => entry.name) };
}

async function warnIfDoctrineFilesMissing(opts) {
  const result = await ensureWorktreeDoctrineFiles({ ...opts, seedMissing: false });
  return result.missing;
}

function isAceOwnedNonRepoProject(project) {
  return !!(
    project &&
    project.is_personal &&
    !project.is_remote &&
    project.path &&
    !project.github_repo &&
    !project.githubRepo
  );
}

async function ensureAceOwnedWorkspaceDoctrine(project, { warn = console.warn } = {}) {
  if (!isAceOwnedNonRepoProject(project)) {
    return { skipped: true, missing: [], seeded: [], failed: [] };
  }
  fs.mkdirSync(project.path, { recursive: true });
  const result = await ensureWorktreeDoctrineFiles({
    worktreePath: project.path,
    exists: async (fullPath) => fs.existsSync(fullPath),
    writeFile: async (fullPath, content) => fs.writeFileSync(fullPath, content, 'utf8'),
    seedMissing: true,
    warn,
  });
  return { skipped: false, ...result };
}

function normalizeControlPlaneIdentity(name) {
  const key = String(name || '').trim().toLowerCase();
  if (key === 'rook' || key === 'king' || key === 'hermes') return key;
  return null;
}

function resolvePersonalIdentity(project) {
  if (!project?.is_personal) return null;
  return normalizeControlPlaneIdentity(project?.personal_identity) ||
    normalizeControlPlaneIdentity(project?.name);
}

function shouldSuppressPersonalHermesAutoPrompt({ agentId, project, streamId } = {}) {
  if (String(agentId || '').toLowerCase() !== 'hermes') return false;
  if (!streamId) return false;
  const identity = resolvePersonalIdentity(project);
  return identity === 'rook' || identity === 'king';
}

function shouldInjectPersonalHermesWakeBrief({ agentId, project, streamId } = {}) {
  // Rook/King personal Hermes lanes still auto-launch, but wake/resume prompt
  // delivery must be user-triggered. Keep the helper as the legacy boundary
  // for older callers/tests while making auto-injection opt-out by default.
  if (shouldSuppressPersonalHermesAutoPrompt({ agentId, project, streamId })) return false;
  return false;
}

function hasExistingHermesWakeBrief(screenText = '') {
  const text = String(screenText || '');
  if (/\b(?:Rook|King) wake-up: (?:post the brief below verbatim|use the brief below to rehydrate)\b/i.test(text)) return true;
  if (/Ace Agents are up\s+—\s+Rook and King are the standing operator lanes/i.test(text)) return true;
  return false;
}

const ACE_EXCLUDE_MARKER = '# ace-auto-ignore';
const ACE_EXCLUDE_PATTERNS = ['.ace/', '.claude/', '.codex/', '.cursor/'];
function ensureLocalExclude(projectPath) {
  if (!projectPath) return;
  const gitDir = path.join(projectPath, '.git');
  if (!fs.existsSync(gitDir)) return;
  const infoDir = path.join(gitDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  let content = '';
  try {
    content = fs.readFileSync(excludePath, 'utf8');
  } catch {
    try {
      fs.mkdirSync(infoDir, { recursive: true });
    } catch {
      return;
    }
  }
  if (content.includes(ACE_EXCLUDE_MARKER)) return;
  const block =
    (content.length > 0 && !content.endsWith('\n') ? '\n' : '') +
    '\n' +
    ACE_EXCLUDE_MARKER +
    '\n' +
    ACE_EXCLUDE_PATTERNS.join('\n') +
    '\n';
  try {
    fs.appendFileSync(excludePath, block);
  } catch {}
}

function execFileP(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 30 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

async function git(cwd, ...args) {
  return execFileP('git', args, { cwd });
}

async function tryGit(cwd, ...args) {
  try {
    return await git(cwd, ...args);
  } catch (err) {
    return { stdout: '', stderr: err.stderr || err.message, failed: true };
  }
}

const {
  branchExistsOnProject,
  buildEffectiveBaseBranchResult,
  createBaseBranchPolicyApi,
  parseOriginHeadRef,
  refreshProjectDefaultBranchRow,
  resolveEffectiveBaseBranchRow,
} = createBaseBranchPolicyModule({ git, tryGit, nowIso });

function which(bin, searchPath = process.env.PATH || '') {
  const dirs = String(searchPath || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function localCliSearchPath(...leading) {
  // hermesCliSearchDirs is platform-aware: `~/.local/bin` + `venv/bin` on
  // POSIX (identical to the previous hardcoded list), `venv\Scripts` under
  // %LOCALAPPDATA%\hermes on Windows — where the old paths never existed, so
  // an installed hermes was invisible unless it was already on PATH.
  return [
    ...leading,
    ...hermesPaths.hermesCliSearchDirs(),
    process.env.PATH || '',
  ].filter(Boolean).join(path.delimiter);
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

function listOpenNumericFds() {
  try {
    return new Set(
      fs.readdirSync('/dev/fd')
        .map((entry) => Number(entry))
        .filter((fd) => Number.isInteger(fd) && fd > 2)
    );
  } catch {
    return new Set();
  }
}

function closeNewFileDescriptors(before, { listOpenFds = listOpenNumericFds, closeFd = fs.closeSync } = {}) {
  if (!before || typeof before.has !== 'function') return 0;
  let closed = 0;
  let after;
  try {
    after = listOpenFds();
  } catch {
    return 0;
  }
  for (const fd of after) {
    if (!Number.isInteger(fd) || fd <= 2 || before.has(fd)) continue;
    try {
      closeFd(fd);
      closed += 1;
    } catch {}
  }
  return closed;
}

function localDirectoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

const EMPTY_MCP_CONFIG_JSON = '{"mcpServers":{}}';
const CODEX_EMPTY_MCP_OVERRIDE = 'mcp_servers={}';
const CODEX_PLUGIN_OFF_OVERRIDES = [
  'features.plugins=false',
  'features.apps=false',
  'plugins."computer-use@openai-bundled".enabled=false',
  'plugins."browser@openai-bundled".enabled=false',
  'plugins."chrome@openai-bundled".enabled=false',
  'plugins."template-creator@openai-primary-runtime".enabled=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.in_app_browser=false',
  'features.enable_mcp_apps=false',
];
const CODEX_APP_PARITY_REQUIRED_FEATURES = Object.freeze([
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'enable_mcp_apps',
]);
const codexAppParitySupportCache = new Map();
const CODEX_SANITIZED_CONFIG = `# Managed by Ace for default Codex worker lanes.
# Do not add MCP servers or browser/computer-use plugins here; use MCP/global opt-in for those lanes.
mcp_servers = {}

[features]
plugins = false
apps = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
enable_mcp_apps = false
`;
const CODEX_SAFE_TOP_LEVEL_CONFIG_KEYS = new Set([
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_verbosity',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
  'model_context_window',
  'model_auto_compact_token_limit',
  'model_auto_compact_token_limit_scope',
]);
const CODEX_HOME_COPY_FILES = ['auth.json', 'installation_id', 'models_cache.json', 'version.json', 'AGENTS.md'];
const CODEX_HOME_LINK_DIRS = ['sessions', 'archived_sessions', 'attachments'];
const REFRESH_BASE_MODES = new Set(['false', 'auto', 'force']);
const AGENT_SPAWN_ENV_EXACT_BLOCKLIST = new Set([
  '__CFBundleIdentifier',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_CODE_CHILD_SESSION',
]);
const AGENT_SPAWN_ENV_PREFIX_BLOCKLIST = ['CODEX_', 'ACE_'];

function sanitizeAgentSpawnEnv(baseEnv = process.env, agent = null) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (
      AGENT_SPAWN_ENV_EXACT_BLOCKLIST.has(key) ||
      AGENT_SPAWN_ENV_PREFIX_BLOCKLIST.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  if (agent === 'claude') claudeAuthPolicy.sanitizeClaudeSubscriptionEnv(env);
  return env;
}

function hashRemoteToken(token, serverSecret) {
  return createHmac('sha256', String(serverSecret || '')).update(String(token || '')).digest('hex');
}

function agentCliTokenPath(userDataPath) {
  return path.join(userDataPath, '.ace-agent-cli-token.json');
}

function readAgentCliToken(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentCliTokenPath(userDataPath), 'utf8'));
    return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

function writeAgentCliToken(userDataPath, token) {
  const filePath = agentCliTokenPath(userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ token, purpose: 'local-agent-ace-cli', createdAt: nowIso() }, null, 2) + '\n',
    { mode: 0o600 }
  );
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function ensureAgentCliRemoteToken({ userDataPath, getRemoteSettings, findRemoteDeviceByHash, registerRemoteDevice }) {
  const settings = getRemoteSettings();
  if (!settings?.enabled || !settings.serverSecret) return null;

  const existingToken = readAgentCliToken(userDataPath);
  if (existingToken) {
    const existingDevice = findRemoteDeviceByHash(hashRemoteToken(existingToken, settings.serverSecret));
    if (existingDevice && !existingDevice.revoked) return existingToken;
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashRemoteToken(token, settings.serverSecret);
  registerRemoteDevice({ name: 'Ace local agent CLI transport', tokenHash });
  writeAgentCliToken(userDataPath, token);
  return token;
}

function localAgentAceTransportEnv(deps) {
  const settings = deps.getRemoteSettings();
  const env = {
    ACE_SOCK: aceSocketPath(deps.userDataPath),
  };
  const token = ensureAgentCliRemoteToken({ ...deps, getRemoteSettings: () => settings });
  if (token) {
    env.ACE_URL = `http://127.0.0.1:${settings.port || 9419}`;
    env.ACE_TOKEN = token;
  }
  return env;
}

function normalizeRefreshBaseMode(value) {
  const mode = String(value == null ? 'false' : value).trim().toLowerCase();
  return REFRESH_BASE_MODES.has(mode) ? mode : 'false';
}

// Interactive-vs-worker lane predicate. The MCP/plugin/connector strip isolates
// DELEGATED WORKERS; owner-opened interactive tabs must stay full-capability.
// Worker-ness lives ENTIRELY in the launchIntent's explicit delegation marker
// (buildLaunchIntent stamps delegated:true on every worker intent it mints) — it
// is the ONE signal, so it is the ONE thing every spawn/respawn/restart persists
// and re-reads. `provider` is deliberately NOT sniffed: it names an agent, not
// lane ownership. No spawn site passes a top-level opts marker, so none is read
// here; the separate headless path (agent-cli-driver.cts) strips unconditionally
// and never reaches this predicate.
function laneIsInteractiveLane(opts = {}) {
  const li = opts.launchIntent;
  if (li && typeof li === 'object') {
    if (li.delegated === true || li.worker === true || li.headless === true) return false;
  }
  return true;
}

// A respawn (resume retry / restart) re-enters the spawn path with a THIN intent, which
// would reclassify a worker INTERACTIVE and reopen its strip. Re-derive from the
// lane's retained intent and carry ONLY the classification fields (delegated,
// and an explicit enableMcp opt-in) — never resumePrompt (injected separately)
// or effort/skills, which the thin respawn intentionally drops.
function respawnLaunchIntentFor(originalLaunchIntent, extra = {}) {
  const intent = { ...(extra || {}) };
  if (!laneIsInteractiveLane({ launchIntent: originalLaunchIntent })) {
    intent.delegated = true;
    if (originalLaunchIntent && originalLaunchIntent.enableMcp === true) {
      intent.enableMcp = true;
    }
  }
  return intent;
}

// The minimal worker-classifying intent persisted so classification survives an
// app restart ({delegated:true}[+enableMcp] for a worker, null for interactive).
// Same shape a respawn produces, so re-deriving from it stays stable.
function laneWorkerClassificationIntent(launchIntent) {
  if (laneIsInteractiveLane({ launchIntent })) return null;
  return respawnLaunchIntentFor(launchIntent);
}

// Explicit non-NULL marker persisted in agent_resume_state.launch_intent for a
// known INTERACTIVE lane, so a NULL column value can only mean a pre-migration
// legacy row (which fails closed to a worker). Not valid JSON, so it can never
// collide with a persisted worker intent.
const RESUME_STATE_INTERACTIVE_MARKER = 'interactive';

function shouldUseGlobalCodexMcp(opts = {}) {
  // Worker spawns default to MCP-off to avoid global Codex config startup
  // noise. Operators can opt back in for MCP/browser tasks with this env, and
  // interactive owner-opened lanes get full capability by default.
  if (codexAppParityRequested(opts.launchIntent || opts)) return true;
  if (opts.enableMcp === true) return true;
  if (opts.launchIntent && typeof opts.launchIntent === 'object' && opts.launchIntent.enableMcp === true) return true;
  if (process.env.ACE_ENABLE_CODEX_MCP === '1') return true;
  return laneIsInteractiveLane(opts);
}

// Claude has no synthesized sanitized home; the strip is purely the
// `--strict-mcp-config --mcp-config <empty>` pair pushed onto the CLI args.
// `--strict-mcp-config` makes Claude ignore ~/.claude.json, project .mcp.json,
// AND the claude.ai connectors — so dropping it (not swapping in a real
// --mcp-config file) is MANDATORY for connectors to load. Mirrors the Codex
// predicate: interactive lanes and explicit opt-ins get full capability;
// delegated worker spawns keep the strip.
function shouldUseClaudeMcp(opts = {}) {
  if (opts.enableMcp === true) return true;
  if (opts.launchIntent && typeof opts.launchIntent === 'object' && opts.launchIntent.enableMcp === true) return true;
  if (process.env.ACE_ENABLE_CLAUDE_MCP === '1') return true;
  return laneIsInteractiveLane(opts);
}

function applyCodexMcpOffDefault(args, opts = {}) {
  if (shouldUseGlobalCodexMcp(opts)) return args;
  for (let i = CODEX_PLUGIN_OFF_OVERRIDES.length - 1; i >= 0; i -= 1) {
    args.unshift('-c', CODEX_PLUGIN_OFF_OVERRIDES[i]);
  }
  args.unshift('-c', CODEX_EMPTY_MCP_OVERRIDE);
  return args;
}

function codexProbe(bin, args) {
  try {
    return {
      ok: true,
      text: execFileSync(bin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        maxBuffer: 512 * 1024,
      }),
    };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    const stdout = err?.stdout ? String(err.stdout).trim() : '';
    return { ok: false, text: stdout || stderr || String(err?.message || err) };
  }
}

function assertCodexAppParitySupported(bin) {
  const key = String(bin || '');
  const cached = codexAppParitySupportCache.get(key);
  if (cached === true) return;
  if (cached instanceof Error) throw cached;

  const gaps = [];
  const help = codexProbe(bin, ['--help']);
  if (!help.ok || !/\bapp-server\b/.test(help.text) || !/\bplugin\b/.test(help.text) || !/\bfeatures\b/.test(help.text)) {
    gaps.push('codex --help does not expose app-server/plugin/features');
  }
  const appServer = codexProbe(bin, ['app-server', '--help']);
  if (!appServer.ok || !/--listen\b/.test(appServer.text)) {
    gaps.push('codex app-server --help does not expose --listen');
  }
  const plugin = codexProbe(bin, ['plugin', '--help']);
  if (!plugin.ok || !/\bplugin/i.test(plugin.text)) {
    gaps.push('codex plugin --help is unavailable');
  }
  const features = codexProbe(bin, ['features', 'list']);
  for (const feature of CODEX_APP_PARITY_REQUIRED_FEATURES) {
    const rx = new RegExp(`^${feature}\\s+`, 'm');
    if (!features.ok || !rx.test(features.text)) gaps.push(`codex feature missing: ${feature}`);
  }

  if (gaps.length) {
    const err = new Error(`Codex app-parity runtime unavailable: ${gaps.join('; ')}`);
    codexAppParitySupportCache.set(key, err);
    throw err;
  }
  codexAppParitySupportCache.set(key, true);
}

function codexSourceHome(baseEnv = process.env) {
  const configured = String(baseEnv?.CODEX_HOME || '').trim();
  return configured ? configured : path.join(os.homedir(), '.codex');
}

function aceCodexHomePath(baseEnv = process.env) {
  const override = String(baseEnv?.ACE_CODEX_HOME || process.env.ACE_CODEX_HOME || '').trim();
  if (override) return override;
  const rootOverride = String(baseEnv?.ACE_DATA_ROOT || process.env.ACE_DATA_ROOT || '').trim();
  if (rootOverride) return path.join(rootOverride, 'codex-home');
  const profileHome = String(baseEnv?.ACE_HOME || process.env.ACE_HOME || '').trim();
  return path.join(profileHome || path.join(os.homedir(), '.ace-coder'), 'codex-home');
}

function safeTopLevelCodexConfig(sourceConfigPath) {
  let raw = '';
  try { raw = fs.readFileSync(sourceConfigPath, 'utf8'); } catch { return ''; }
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) break;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!match || !CODEX_SAFE_TOP_LEVEL_CONFIG_KEYS.has(match[1])) continue;
    kept.push(line);
  }
  return kept.length ? `${kept.join('\n')}\n\n` : '';
}

function copyFileIfPresent(src, dest) {
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (err) {
    console.warn('[ace] failed to copy Codex home file:', path.basename(src), err?.message || err);
  }
}

function linkDirIfPresent(src, dest) {
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory() || fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest, 'dir');
  } catch (err) {
    console.warn('[ace] failed to link Codex home dir:', path.basename(src), err?.message || err);
  }
}

function ensureAceCodexHome(baseEnv = process.env) {
  const sourceHome = codexSourceHome(baseEnv);
  const targetHome = aceCodexHomePath(baseEnv);
  fs.mkdirSync(targetHome, { recursive: true });
  const safeTopLevel = safeTopLevelCodexConfig(path.join(sourceHome, 'config.toml'));
  fs.writeFileSync(path.join(targetHome, 'config.toml'), `${safeTopLevel}${CODEX_SANITIZED_CONFIG}`, 'utf8');
  for (const name of CODEX_HOME_COPY_FILES) copyFileIfPresent(path.join(sourceHome, name), path.join(targetHome, name));
  for (const name of CODEX_HOME_LINK_DIRS) linkDirIfPresent(path.join(sourceHome, name), path.join(targetHome, name));
  return targetHome;
}

function codexDefaultWorkerEnv(agent, opts = {}, baseEnv = process.env) {
  if (agent !== 'codex') return {};
  if (codexAppParityRequested(opts.launchIntent || opts)) {
    return {
      CODEX_HOME: codexSourceHome(baseEnv),
      ACE_CODEX_RUNTIME_PROFILE: CODEX_APP_PARITY_PROFILE,
      ACE_CODEX_APP_PARITY: '1',
    };
  }
  if (shouldUseGlobalCodexMcp(opts)) return {};
  return { CODEX_HOME: ensureAceCodexHome(baseEnv) };
}

const CLAUDE_AGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_AGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function normalizeAgentReasoningEffort(value, agent) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return null;
  const valid = agent === 'claude' ? CLAUDE_AGENT_EFFORTS : CODEX_AGENT_EFFORTS;
  if (valid.has(effort)) return effort;
  throw new Error(`${agent} reasoning effort "${effort}" is not supported by the Ace launcher`);
}

function buildScopedLaunchIntent(agent, effort, telemetry) {
  const reasoningEffort = normalizeAgentReasoningEffort(effort, agent);
  const skillIds = launchIntentSkillIds(telemetry || {});
  // Preserve the "nothing to carry → undefined" contract so the
  // `if (launchIntent)` attach guards are unchanged when there is no effort and
  // no skills.
  if (!reasoningEffort && skillIds.length === 0) return undefined;
  // Delegate to the orchestrator's builder for the FULL intent — ultraCode /
  // workflowMode='dynamic-workflow' / effortCommand / preludeCommands / guidance
  // / cliArgs — so a max-effort lane dispatched from the Mission Board gets the
  // SAME ultracode/dynamic-workflow prelude as the CLI path (it previously
  // dropped all of these). buildLaunchIntent recomputes skillIds identically.
  const full = buildLaunchIntent(agent, {
    ...(telemetry || {}),
    effort: reasoningEffort || (telemetry && telemetry.effort) || '',
  });
  if (full && typeof full === 'object') return full;
  // Fallback for providers buildLaunchIntent does not model.
  const intent: any = { provider: agent };
  if (reasoningEffort) intent.reasoningEffort = reasoningEffort;
  if (skillIds.length) intent.skillIds = skillIds;
  return intent;
}

function applyCodexReasoningEffort(args, opts = {}) {
  const launchIntent = opts.launchIntent && typeof opts.launchIntent === 'object'
    ? opts.launchIntent
    : {};
  const effort = normalizeAgentReasoningEffort(
    opts.reasoningEffort || opts.effort || launchIntent.reasoningEffort || launchIntent.effort,
    'codex'
  );
  if (effort) args.unshift('-c', `model_reasoning_effort="${effort}"`);
  return args;
}

function applyCodexConfigOverrides(args, opts = {}) {
  const launchIntent = opts.launchIntent && typeof opts.launchIntent === 'object'
    ? opts.launchIntent
    : {};
  const overrides = Array.isArray(launchIntent.codexConfigOverrides)
    ? launchIntent.codexConfigOverrides
      .map((override) => String(override || '').trim())
      .filter(Boolean)
      .filter((override) => !/^model_reasoning_effort\s*=/.test(override))
    : [];
  for (let i = overrides.length - 1; i >= 0; i -= 1) {
    if (args.includes(overrides[i])) continue;
    args.unshift('-c', overrides[i]);
  }
  return args;
}

// Claude Code's "fullscreen" renderer draws on the alternate screen and owns its
// own virtualised scrollback, which it expects the terminal to drive through
// DECSET 1007 (alternate scroll). Real terminals implement that; xterm.js does
// not, so inside an Ace pane a fullscreen lane cannot be scrolled at all — and
// every frame repaints the whole viewport, which has to cross the pty-host
// socket, the main process and the renderer's parser for each visible lane.
// Lanes therefore pin the classic main-screen renderer. `--settings` is a
// highest-precedence settings SOURCE that merges over the user's settings.json,
// so this overrides `tui` alone and leaves model/effort/permissions untouched;
// a real terminal keeps whatever renderer the owner configured.
const CLAUDE_LANE_SETTINGS_JSON = JSON.stringify({ tui: 'default' });

function applyClaudeLaneRenderer(args) {
  if (!args.includes('--settings')) args.push('--settings', CLAUDE_LANE_SETTINGS_JSON);
  return args;
}

function applyClaudeReasoningEffort(args, opts = {}) {
  const launchIntent = opts.launchIntent && typeof opts.launchIntent === 'object'
    ? opts.launchIntent
    : {};
  const effort = normalizeAgentReasoningEffort(
    opts.reasoningEffort || opts.effort || launchIntent.reasoningEffort || launchIntent.effort,
    'claude'
  );
  if (effort && !args.includes('--effort')) args.push('--effort', effort);
  return args;
}

function ensureClaudeEmptyMcpConfigPath() {
  const dir = path.join(os.tmpdir(), 'ace');
  const file = path.join(dir, 'claude-empty-mcp.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== EMPTY_MCP_CONFIG_JSON) {
      fs.writeFileSync(file, EMPTY_MCP_CONFIG_JSON);
    }
  } catch {}
  return file;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_remote INTEGER NOT NULL DEFAULT 0,
  ssh_host TEXT,
  ssh_user TEXT,
  remote_path TEXT,
  agent_user TEXT,
  original_owner TEXT,
  default_branch TEXT,
  preferred_base_branch TEXT,
  github_repo TEXT,
  personal_identity TEXT,
  initialized INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('task','thread')),
  name TEXT NOT NULL,
  primary_agent TEXT NOT NULL,
  is_multi_agent INTEGER NOT NULL DEFAULT 0,
  initial_prompt TEXT,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  archived_pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_archived_idx ON tasks(archived_at);

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  remote_base_ref TEXT,
  base_sha TEXT,
  local_base_sha TEXT,
  local_ahead_by INTEGER NOT NULL DEFAULT 0,
  local_behind_by INTEGER NOT NULL DEFAULT 0,
  branch_point TEXT,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS worktrees_task_idx ON worktrees(task_id);

CREATE TABLE IF NOT EXISTS integration_context_imports (
  audit_id TEXT NOT NULL UNIQUE,
  request_id TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL UNIQUE,
  canonical_payload_json TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES projects(id),
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  push_url TEXT NOT NULL,
  allowed_paths_json TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  worktree_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, branch)
);
CREATE TRIGGER IF NOT EXISTS integration_context_imports_no_update
BEFORE UPDATE ON integration_context_imports BEGIN
  SELECT RAISE(ABORT, 'integration context audit is immutable');
END;
CREATE TRIGGER IF NOT EXISTS integration_context_imports_no_delete
BEFORE DELETE ON integration_context_imports BEGIN
  SELECT RAISE(ABORT, 'integration context audit is immutable');
END;

CREATE TABLE IF NOT EXISTS integration_context_import_projections (
  audit_id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  branch TEXT NOT NULL,
  review_mode INTEGER NOT NULL DEFAULT 0,
  review_prompt TEXT,
  session_id TEXT,
  kind TEXT NOT NULL DEFAULT 'cli',
  attached_at TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS variants_worktree_idx ON variants(worktree_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cli',
  is_main INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  last_auto_wake_prompt_hash TEXT,
  last_auto_wake_prompt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_task_idx ON conversations(task_id);

CREATE TABLE IF NOT EXISTS starred_agents (
  agent_id TEXT PRIMARY KEY,
  starred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL DEFAULT 9419,
  tunnel_mode TEXT NOT NULL DEFAULT 'lan',
  server_secret TEXT NOT NULL,
  cloudflare_domain TEXT,
  cloudflare_tunnel_id TEXT,
  cloudflare_tunnel_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS remote_devices_hash_idx ON remote_devices(token_hash);

CREATE TABLE IF NOT EXISTS scratch_tabs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser','notes')),
  title TEXT NOT NULL,
  url TEXT,
  favicon TEXT,
  content TEXT,
  saved_path TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scratch_tabs_task_idx ON scratch_tabs(task_id);

CREATE TABLE IF NOT EXISTS editor_open_files (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (task_id, path)
);
CREATE INDEX IF NOT EXISTS editor_open_files_task_idx ON editor_open_files(task_id);

-- Streams that were running when the app last shut down. Rows are written on
-- agent stream start and removed on real PTY exit / explicit kill — never on
-- app shutdown — so boot knows which agent tabs to bring back automatically.
CREATE TABLE IF NOT EXISTS agent_resume_state (
  stream_id TEXT PRIMARY KEY,
  cols INTEGER,
  rows INTEGER,
  updated_at TEXT
);
-- Append-only per-stream session-binding history. Two jobs: (1) it is the
-- source for the "rebind to this tab's OWN prior session" precedence — the fix
-- for lanes that used to cross-attach to a sibling's newest-in-cwd transcript;
-- (2) it is the audit trail that makes the next cross-attach incident
-- diagnosable (every rebind/fresh-mint/transient-keep records a row with a
-- reason). Rows are never updated, only inserted.
CREATE TABLE IF NOT EXISTS stream_session_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  provider TEXT,
  cwd TEXT,
  session_id TEXT,
  reason TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS stream_session_history_stream_idx
  ON stream_session_history(stream_id, cwd, created_at);
`;

function applyWorkspaceOrderSchema(db) {
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
  const needsProjectBackfill = !projectCols.includes('order_index');
  if (needsProjectBackfill) {
    db.exec(`ALTER TABLE projects ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0`);
    const projectRows = db.prepare(`SELECT id FROM projects ORDER BY created_at ASC`).all();
    const projectOrderStmt = db.prepare(`UPDATE projects SET order_index=? WHERE id=?`);
    projectRows.forEach((row, index) => projectOrderStmt.run(index, row.id));
  }

  const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  const needsTaskBackfill = !taskCols.includes('order_index');
  if (needsTaskBackfill) {
    db.exec(`ALTER TABLE tasks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0`);
    const projectIds = db.prepare(`SELECT DISTINCT project_id FROM tasks`).all().map((row) => row.project_id);
    const taskRowsStmt = db.prepare(
      `SELECT id FROM tasks WHERE project_id=? AND archived_at IS NULL ORDER BY created_at ASC`
    );
    const taskOrderStmt = db.prepare(`UPDATE tasks SET order_index=? WHERE id=?`);
    for (const projectId of projectIds) {
      const rows = taskRowsStmt.all(projectId);
      rows.forEach((row, index) => taskOrderStmt.run(index, row.id));
    }
  }
}

function reorderWorkspacesInDb(db, workspaceIds) {
  if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return { ok: false };
  const existing = new Set(db.prepare(`SELECT id FROM projects`).all().map((row) => row.id));
  for (const id of workspaceIds) {
    if (!existing.has(id)) throw new Error(`workspace "${id}" does not exist`);
  }
  const tx = db.transaction((ids) => {
    const stmt = db.prepare(`UPDATE projects SET order_index=? WHERE id=?`);
    ids.forEach((id, index) => stmt.run(index, id));
  });
  tx(workspaceIds);
  return { ok: true };
}

function reorderTasksInWorkspaceInDb(db, workspaceId, taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { ok: false };
  const ownedRows = db
    .prepare(`SELECT id FROM tasks WHERE project_id=? AND archived_at IS NULL`)
    .all(workspaceId);
  const owned = new Set(ownedRows.map((row) => row.id));
  for (const id of taskIds) {
    if (!owned.has(id)) {
      throw new Error(`task "${id}" does not belong to workspace "${workspaceId}"`);
    }
  }
  const tx = db.transaction((ids) => {
    const stmt = db.prepare(`UPDATE tasks SET order_index=? WHERE id=?`);
    ids.forEach((id, index) => stmt.run(index, id));
  });
  tx(taskIds);
  return { ok: true };
}

function openDatabase(userDataPath, operatorsConfig: any, DatabaseCtor: any = Database) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'ace.db');
  // DatabaseCtor is injectable (testHooks.Database) so tests can boot the real
  // store against a driver that loads in plain Node — the packaged
  // better-sqlite3 is built for the Electron ABI and won't load under the test
  // runner.
  const db = new DatabaseCtor(dbPath);
  // Stop the Electron main thread from blocking on synchronous better-sqlite3 (the
  // measured cause of typing/CLI/stream jank and the Hermes webview "hang on
  // return"). busy_timeout makes a reader WAIT for a concurrent CLI/sidecar/worker
  // writer instead of erroring; the cache/mmap/checkpoint/synchronous tuning cuts
  // per-query page I/O, which dominates when the DB lives on an external volume.
  db.pragma('busy_timeout = 5000');
  // stream_session_history predates the session-rebind feature (#93) on some
  // installs with an INCOMPATIBLE shape (agent/recorded_at instead of
  // provider/cwd/created_at). CREATE TABLE IF NOT EXISTS below is a no-op
  // against it, so SCHEMA's index and every later prepare that names `provider`
  // throw at store construction — a hard BOOT CRASH on real data a fresh-DB test
  // suite never sees. Migrate IN PLACE (before SCHEMA, so its index over
  // cwd/created_at can build): add the missing columns and back-fill them from
  // the old ones, so every historical audit row is preserved and usable — never
  // dropped. Idempotent: a table already carrying `provider`, or absent, is
  // untouched.
  try {
    const info = db.prepare(`PRAGMA table_info(stream_session_history)`).all();
    const cols = new Set(info.map((c: any) => c.name));
    // Migrate only a table that exists AND is missing a required column. Each
    // column is checked INDEPENDENTLY (not gated on `provider` alone), and the
    // whole thing runs in ONE transaction: a crash mid-migration rolls back
    // completely, so the next boot re-runs from a clean state — there is no
    // partial shape (e.g. provider added but not cwd) that would skip the gate
    // and wedge boot forever.
    if (info.length && (!cols.has('provider') || !cols.has('cwd') || !cols.has('created_at'))) {
      db.exec('BEGIN');
      try {
        if (!cols.has('provider')) db.exec(`ALTER TABLE stream_session_history ADD COLUMN provider TEXT`);
        if (!cols.has('cwd')) db.exec(`ALTER TABLE stream_session_history ADD COLUMN cwd TEXT`);
        if (!cols.has('created_at')) db.exec(`ALTER TABLE stream_session_history ADD COLUMN created_at TEXT`);
        // Back-fill the new columns from the pre-#93 ones so old rows survive
        // with their data intact (agent named the provider; recorded_at was the
        // timestamp; cwd was never recorded → stays null).
        if (cols.has('agent')) db.exec(`UPDATE stream_session_history SET provider = agent WHERE provider IS NULL`);
        if (cols.has('recorded_at')) db.exec(`UPDATE stream_session_history SET created_at = recorded_at WHERE created_at IS NULL`);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw e;
      }
    }
  } catch (err: any) {
    // Surface (don't silently swallow) — a genuine migration failure would
    // otherwise resurface as a confusing downstream prepare/index crash.
    console.error('[ace] stream_session_history migration failed:', err?.message || err);
  }
  db.exec(SCHEMA);
  const contextImportCols = db
    .prepare(`PRAGMA table_info(integration_context_imports)`)
    .all()
    .map((c) => c.name);
  if (!contextImportCols.includes('push_url')) {
    // Preserve pre-release immutable rows; imported push fails closed until new attestation supplies the URL.
    db.exec(`ALTER TABLE integration_context_imports ADD COLUMN push_url TEXT`);
  }
  db.pragma('synchronous = NORMAL'); // safe with WAL (set by SCHEMA); fewer fsyncs
  db.pragma('cache_size = -16000'); // ~16MB page cache (negative value = KiB)
  db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  db.pragma('wal_autocheckpoint = 1000'); // keep the WAL file bounded
  agentLanes.applyAgentLaneSchema(db);
  applyWorkspaceOrderSchema(db);
  ensureMissionSchema(db, { preserveAuxiliaryTables: true });
  dropLegacyArchiveDisableTriggers(db);



  const cols = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
  if (!cols.includes('ssh_host')) {
    db.exec(`ALTER TABLE projects ADD COLUMN ssh_host TEXT`);
  }
  if (!cols.includes('remote_path')) {
    db.exec(`ALTER TABLE projects ADD COLUMN remote_path TEXT`);
  }
  if (!cols.includes('agent_user')) {
    db.exec(`ALTER TABLE projects ADD COLUMN agent_user TEXT`);
  }
  if (!cols.includes('original_owner')) {
    db.exec(`ALTER TABLE projects ADD COLUMN original_owner TEXT`);
  }
  if (!cols.includes('ssh_user')) {
    db.exec(`ALTER TABLE projects ADD COLUMN ssh_user TEXT`);
  }
  if (!cols.includes('preferred_base_branch')) {
    db.exec(`ALTER TABLE projects ADD COLUMN preferred_base_branch TEXT`);
  }
  if (!cols.includes('always_on_orchestrator')) {
    db.exec(`ALTER TABLE projects ADD COLUMN always_on_orchestrator INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('always_on_agent')) {
    db.exec(`ALTER TABLE projects ADD COLUMN always_on_agent TEXT`);
  }
  if (!cols.includes('is_personal')) {
    db.exec(`ALTER TABLE projects ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('personal_identity')) {
    db.exec(`ALTER TABLE projects ADD COLUMN personal_identity TEXT`);
  }
  db.prepare(
    `UPDATE projects
     SET personal_identity = ?
     WHERE is_personal = 1
       AND (personal_identity IS NULL OR personal_identity = '')`
  ).run(operatorsConfig.defaultOperatorId);


  const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  if (!taskCols.includes('pinned')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!taskCols.includes('task_type')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
  }
  if (!taskCols.includes('archived_pr_url')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN archived_pr_url TEXT`);
  }

  const worktreeCols = db.prepare(`PRAGMA table_info(worktrees)`).all().map((c) => c.name);
  if (!worktreeCols.includes('remote_base_ref')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN remote_base_ref TEXT`);
  }
  if (!worktreeCols.includes('base_sha')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN base_sha TEXT`);
  }
  if (!worktreeCols.includes('local_base_sha')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN local_base_sha TEXT`);
  }
  if (!worktreeCols.includes('local_ahead_by')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN local_ahead_by INTEGER NOT NULL DEFAULT 0`);
  }
  if (!worktreeCols.includes('local_behind_by')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN local_behind_by INTEGER NOT NULL DEFAULT 0`);
  }
  if (!worktreeCols.includes('branch_point')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN branch_point TEXT`);
  }

  const variantCols = db.prepare(`PRAGMA table_info(variants)`).all().map((c) => c.name);
  if (!variantCols.includes('session_id')) {
    db.exec(`ALTER TABLE variants ADD COLUMN session_id TEXT`);
  }
  if (!variantCols.includes('kind')) {
    db.exec(`ALTER TABLE variants ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli'`);
  }
  if (!variantCols.includes('chat_prefs')) {
    db.exec(`ALTER TABLE variants ADD COLUMN chat_prefs TEXT`);
  }
  if (!variantCols.includes('order_index')) {
    db.exec(`ALTER TABLE variants ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0`);
    const worktreeIds = db
      .prepare(`SELECT DISTINCT worktree_id FROM variants`)
      .all()
      .map((r) => r.worktree_id);
    const backfillStmt = db.prepare(`UPDATE variants SET order_index=? WHERE id=?`);
    const readStmt = db.prepare(
      `SELECT id FROM variants WHERE worktree_id=? ORDER BY attached_at ASC`
    );
    for (const wtId of worktreeIds) {
      const rows = readStmt.all(wtId);
      rows.forEach((row, idx) => backfillStmt.run(idx, row.id));
    }
  }
  const conversationCols = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all()
    .map((c) => c.name);
  if (!conversationCols.includes('session_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN session_id TEXT`);
  }
  if (!conversationCols.includes('kind')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli'`);
  }
  if (!conversationCols.includes('chat_prefs')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN chat_prefs TEXT`);
  }
  if (!conversationCols.includes('last_auto_wake_prompt_hash')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_auto_wake_prompt_hash TEXT`);
  }
  if (!conversationCols.includes('last_auto_wake_prompt_at')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_auto_wake_prompt_at TEXT`);
  }

  // Force operator workspaces/conversations back to their configured labels
  // (byte-identical to the old hardcoded Rook/King renames for the owner).
  const renameOperatorProject = db.prepare(
    `UPDATE projects
     SET name = ?
     WHERE is_personal = 1
       AND LOWER(COALESCE(personal_identity, '')) = ?
       AND name != ?`
  );
  const renameOperatorConversations = db.prepare(
    `UPDATE conversations
     SET title = ?
     WHERE agent = ?
       AND is_main = 1
       AND task_id IN (
         SELECT t.id
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE p.is_personal = 1
           AND LOWER(COALESCE(p.personal_identity, '')) = ?
       )`
  );
  for (const op of operatorsLib.listControlPlaneOperators(operatorsConfig)) {
    const identityKey = op.id.toLowerCase();
    renameOperatorProject.run(op.label, identityKey, op.label);
    renameOperatorConversations.run(op.label, op.agent || 'hermes', identityKey);
  }


  const remoteSettingsCols = db
    .prepare(`PRAGMA table_info(remote_settings)`)
    .all()
    .map((c) => c.name);
  if (remoteSettingsCols.length && !remoteSettingsCols.includes('tunnel_mode')) {
    db.exec(`ALTER TABLE remote_settings ADD COLUMN tunnel_mode TEXT NOT NULL DEFAULT 'lan'`);
  }
  if (remoteSettingsCols.length && !remoteSettingsCols.includes('cloudflare_domain')) {
    db.exec(`ALTER TABLE remote_settings ADD COLUMN cloudflare_domain TEXT`);
  }
  if (remoteSettingsCols.length && !remoteSettingsCols.includes('cloudflare_tunnel_id')) {
    db.exec(`ALTER TABLE remote_settings ADD COLUMN cloudflare_tunnel_id TEXT`);
  }
  if (remoteSettingsCols.length && !remoteSettingsCols.includes('cloudflare_tunnel_name')) {
    db.exec(`ALTER TABLE remote_settings ADD COLUMN cloudflare_tunnel_name TEXT`);
  }

  const scratchTabCols = db
    .prepare(`PRAGMA table_info(scratch_tabs)`)
    .all()
    .map((c) => c.name);
  if (scratchTabCols.length && !scratchTabCols.includes('favicon')) {
    db.exec(`ALTER TABLE scratch_tabs ADD COLUMN favicon TEXT`);
  }

  // Persist each running agent lane's worker/interactive capability
  // classification (a minimal JSON launch intent, or NULL for interactive) so a
  // lane brought back after an app restart — adopted from the pty-host OR
  // relaunched with --resume — keeps its MCP/plugin/connector strip instead of
  // being reclassified interactive from a bare stream.
  const agentResumeCols = db
    .prepare(`PRAGMA table_info(agent_resume_state)`)
    .all()
    .map((c) => c.name);
  if (agentResumeCols.length && !agentResumeCols.includes('launch_intent')) {
    db.exec(`ALTER TABLE agent_resume_state ADD COLUMN launch_intent TEXT`);
  }

  const existing = db.prepare('SELECT id FROM remote_settings WHERE id=1').get();
  if (!existing) {
    db.prepare(
      `INSERT INTO remote_settings (id, enabled, port, tunnel_mode, server_secret, created_at)
       VALUES (1, 0, 9419, 'lan', ?, ?)`
    ).run(randomUUID().replace(/-/g, ''), new Date().toISOString());
  }
  return db;
}

async function readProjectGitInfo(projectPath) {
  const info = {
    isGitRepo: false,
    remote: null,
    branch: null,
    baseRef: null,
    githubRepo: null,
  };
  try {
    await git(projectPath, 'rev-parse', '--is-inside-work-tree');
    info.isGitRepo = true;
  } catch {
    return info;
  }
  const remote = await tryGit(projectPath, 'remote', 'get-url', 'origin');
  if (!remote.failed && remote.stdout.trim()) {
    info.remote = remote.stdout.trim();
    const m = info.remote.match(/github\.com[:/]([^/]+\/[^./]+?)(\.git)?$/);
    if (m) info.githubRepo = m[1];
  }
  const branch = await tryGit(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.failed) info.branch = branch.stdout.trim() || null;
  const base = await tryGit(
    projectPath,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD'
  );
  if (!base.failed && base.stdout.trim()) {
    info.baseRef = base.stdout.trim().replace(/^origin\//, '');
  } else if (info.branch) {
    info.baseRef = info.branch;
  }
  return info;
}

async function initRepo(projectPath) {
  await git(projectPath, 'init');
}

async function listBranches(projectPath) {
  const out = await tryGit(
    projectPath,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/'
  );
  if (out.failed) return [];
  return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function deriveChecksStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  let hasPending = false;
  for (const entry of rollup) {
    const status = String(entry?.status || '').toUpperCase();
    const conclusion = String(entry?.conclusion || '').toUpperCase();
    if (conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') {
      return 'failure';
    }
    if (!conclusion || status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING') {
      hasPending = true;
    }
  }
  return hasPending ? 'pending' : 'success';
}

async function listOpenPrs(projectPath) {
  if (!which('gh')) return [];
  try {
    const { stdout } = await execFileP(
      'gh',
      [
        'pr', 'list',
        '--state', 'open',
        '--limit', '50',
        '--json',
        'number,title,headRefName,baseRefName,headRefOid,mergeable,author,additions,deletions,isDraft,reviewDecision,statusCheckRollup,url',
      ],
      { cwd: projectPath, timeout: 15000 }
    );
    const raw = JSON.parse(stdout || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((pr) => ({
      number: Number(pr.number) || 0,
      title: String(pr.title || ''),
      headRef: String(pr.headRefName || ''),
      baseRef: String(pr.baseRefName || '') || undefined,
      headSha: String(pr.headRefOid || '') || undefined,
      mergeable: pr.mergeable || undefined,
      author: String(pr.author?.login || pr.author?.name || ''),
      additions: Number(pr.additions || 0),
      deletions: Number(pr.deletions || 0),
      isDraft: !!pr.isDraft,
      reviewDecision: pr.reviewDecision || undefined,
      checksStatus: deriveChecksStatus(pr.statusCheckRollup),
      url: String(pr.url || ''),
    }));
  } catch {
    return [];
  }
}

async function listCleanupBranches(projectPath, { currentBranch, defaultBranch, taskBranches }) {
  const [local, remote] = await Promise.all([
    tryGit(
      projectPath,
      'for-each-ref',
      '--format=%(refname:short)|%(upstream:short)',
      'refs/heads/'
    ),
    tryGit(
      projectPath,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin/'
    ),
  ]);

  const localEntries = local.failed
    ? []
    : local.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [branch, upstream] = line.split('|');
          return { branch, upstream: upstream || null };
        });

  const remoteSet = new Set();
  if (!remote.failed) {
    for (const line of remote.stdout.split('\n')) {
      const name = line.trim();
      if (!name || name === 'origin/HEAD') continue;
      remoteSet.add(name.replace(/^origin\//, ''));
    }
  }

  const byBranch = new Map();
  for (const { branch } of localEntries) {
    byBranch.set(branch, {
      branch,
      hasLocal: true,
      hasRemote: remoteSet.has(branch),
      remote: remoteSet.has(branch) ? 'origin' : undefined,
      isDefaultBranch: branch === defaultBranch,
      isCurrentBranch: branch === currentBranch,
      taskNames: taskBranches.get(branch),
    });
  }
  for (const branch of remoteSet) {
    if (byBranch.has(branch)) continue;
    byBranch.set(branch, {
      branch,
      hasLocal: false,
      hasRemote: true,
      remote: 'origin',
      isDefaultBranch: branch === defaultBranch,
      isCurrentBranch: false,
      taskNames: taskBranches.get(branch),
    });
  }

  return Array.from(byBranch.values()).sort((a, b) => a.branch.localeCompare(b.branch));
}

async function deleteGitBranch(projectPath, branchName, { deleteRemote = false } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    throw new Error('branch name required');
  }


  const local = await tryGit(projectPath, 'branch', '-D', branchName);
  if (local.failed && !/not found/i.test(local.stderr || '')) {
    throw new Error(local.stderr || `git branch -D ${branchName} failed`);
  }
  if (deleteRemote) {
    const pushResult = await tryGit(projectPath, 'push', 'origin', '--delete', branchName);
    if (pushResult.failed) {
      throw new Error(pushResult.stderr || `git push origin --delete ${branchName} failed`);
    }
  }
}

function codeToStatus(code) {
  if (code === '?' || code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'M' || code === 'T') return 'modified';
  if (code === 'U' || code === 'C') return 'modified';
  return 'modified';
}

function parseNumstat(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;

    const rawPath = parts.slice(2).join('\t');
    const renameMatch = rawPath.match(/^(?:.+) => (.+)$/);
    const p = renameMatch ? renameMatch[1] : rawPath;
    map.set(p, { additions, deletions });
  }
  return map;
}

const HIDDEN_CHANGE_PREFIXES = [
  '.ace/',
  '.claude/',
  '.codex/',
  '.cursor/',
];
function isHiddenChangePath(p) {
  if (!p) return false;
  const normalized = p.endsWith('/') ? p : p;
  for (const prefix of HIDDEN_CHANGE_PREFIXES) {
    if (normalized === prefix || normalized === prefix.slice(0, -1)) return true;
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

const MAX_LOC_SCAN_BYTES = 5 * 1024 * 1024;
function countFileLines(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return 0;
    if (stat.size === 0) return 0;
    if (stat.size > MAX_LOC_SCAN_BYTES) return 0;
    const buf = fs.readFileSync(absPath);
    const sniffLen = Math.min(buf.length, 8192);
    for (let i = 0; i < sniffLen; i++) {
      if (buf[i] === 0) return 0;
    }
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) count++;
    }
    if (buf[buf.length - 1] !== 10) count++;
    return count;
  } catch {
    return 0;
  }
}

async function gitStatus(taskPath) {
  const [statusOut, untrackedOut, unstagedNumstat, stagedNumstat] = await Promise.all([
    tryGit(taskPath, 'status', '--porcelain=v1', '-z'),






    tryGit(taskPath, 'ls-files', '--others', '--exclude-standard', '-z'),
    tryGit(taskPath, 'diff', '--numstat'),
    tryGit(taskPath, 'diff', '--cached', '--numstat'),
  ]);
  if (statusOut.failed) {
    return { staged: [], unstaged: [], totals: { additions: 0, deletions: 0 } };
  }

  const staged = [];
  const unstaged = [];
  const tokens = statusOut.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const indexCode = entry[0];
    const worktreeCode = entry[1];
    const p = entry.slice(3);

    if (indexCode === 'R' || worktreeCode === 'R') {
      i++;
    }
    if (isHiddenChangePath(p)) continue;
    if (indexCode !== ' ' && indexCode !== '?') {
      staged.push({ path: p, status: codeToStatus(indexCode), additions: 0, deletions: 0 });
    }


    if (worktreeCode === '?') continue;
    if (worktreeCode !== ' ') {
      unstaged.push({ path: p, status: codeToStatus(worktreeCode), additions: 0, deletions: 0 });
    }
  }

  const unstagedCounts = unstagedNumstat.failed
    ? new Map()
    : parseNumstat(unstagedNumstat.stdout);
  const stagedCounts = stagedNumstat.failed
    ? new Map()
    : parseNumstat(stagedNumstat.stdout);

  for (const file of unstaged) {
    const counts = unstagedCounts.get(file.path);
    if (counts) {
      file.additions = counts.additions;
      file.deletions = counts.deletions;
    }
  }
  for (const file of staged) {
    const counts = stagedCounts.get(file.path);
    if (counts) {
      file.additions = counts.additions;
      file.deletions = counts.deletions;
    }
  }





  const MAX_UNTRACKED_SCAN = 500;
  if (!untrackedOut.failed) {
    const untracked = untrackedOut.stdout
      .split('\0')
      .filter((rel) => rel && !isHiddenChangePath(rel));
    for (let i = 0; i < untracked.length; i++) {
      const rel = untracked[i];
      const additions =
        i < MAX_UNTRACKED_SCAN ? countFileLines(path.join(taskPath, rel)) : 0;
      unstaged.push({ path: rel, status: 'added', additions, deletions: 0 });
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of [...staged, ...unstaged]) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }

  return {
    staged,
    unstaged,
    totals: { additions: totalAdditions, deletions: totalDeletions },
  };
}

async function gitLog(taskPath, limit) {
  const capped = Math.max(1, Math.min(200, limit | 0 || 30));
  const out = await tryGit(
    taskPath,
    'log',
    `--max-count=${capped}`,
    '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s'
  );
  if (out.failed) return [];
  return out.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, shortHash, author, email, date, parents, message] = line.split('\x00');
      return {
        hash,
        shortHash,
        author,
        email: email || '',
        date,
        message,
        parents: (parents || '').split(' ').filter(Boolean),
      };
    });
}

async function gitDiffFile(projectPath, relPath, staged) {
  if (!relPath) return { diff: '', binary: false };
  const args = staged
    ? ['diff', '--cached', '--no-color', '--', relPath]
    : ['diff', '--no-color', '--', relPath];
  const out = await tryGit(projectPath, ...args);
  if (!out.failed && out.stdout.length > 0) {
    return { diff: out.stdout, binary: /\bBinary files\b/.test(out.stdout) };
  }


  if (!staged) {
    try {
      const abs = resolveInsideRoot(projectPath, relPath);
      if (!abs || !fs.existsSync(abs)) return { diff: '', binary: false };
      const stat = fs.statSync(abs);
      if (stat.size > 2 * 1024 * 1024) return { diff: '', binary: true };
      const bytes = fs.readFileSync(abs);

      const sample = bytes.slice(0, Math.min(bytes.length, 8192));
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) return { diff: '', binary: true };
      }
      const text = bytes.toString('utf8');
      const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
      const header =
        `diff --git a/${relPath} b/${relPath}\n` +
        `new file mode 100644\n` +
        `--- /dev/null\n` +
        `+++ b/${relPath}\n` +
        `@@ -0,0 +1,${lines.length} @@\n`;
      const body = lines.map((l) => `+${l}`).join('\n');
      return { diff: header + body + (lines.length > 0 ? '\n' : ''), binary: false };
    } catch {
      return { diff: '', binary: false };
    }
  }
  return { diff: '', binary: false };
}

function resolveInsideRoot(rootPath, relativePath) {
  if (!rootPath) return null;
  const safeRel = path.normalize(String(relativePath ?? ''));
  const absolute = path.resolve(rootPath, safeRel);
  const root = path.resolve(rootPath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

function listDirectoryEntries(rootPath, relativePath) {
  const target = resolveInsideRoot(rootPath, relativePath || '.');
  if (!target) return [];
  let raw;
  try {
    raw = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return [];
  }
  const safeRel = path.normalize(String(relativePath ?? '') || '.');
  const entries = [];
  for (const entry of raw) {
    const isDir = entry.isDirectory();
    entries.push({
      name: entry.name,
      kind: isDir ? 'dir' : 'file',
      relativePath: path.posix.join(
        safeRel === '.' ? '' : safeRel.split(path.sep).join('/'),
        entry.name
      ),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}

const MAX_READ_FILE_BYTES = 16 * 1024 * 1024;
function readFileInside(rootPath, relativePath) {
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_READ_FILE_BYTES) throw new Error('file too large');
  const buf = fs.readFileSync(absolute);
  const sniffLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) throw new Error('binary file');
  }
  return buf.toString('utf8');
}

function writeFileInside(rootPath, relativePath, content) {
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, String(content ?? ''), 'utf8');
}

function createFileInside(rootPath, relativePath) {
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');
  if (fs.existsSync(absolute)) throw new Error('path already exists');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, '', 'utf8');
}

function createFolderInside(rootPath, relativePath) {
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');
  if (fs.existsSync(absolute)) throw new Error('path already exists');
  fs.mkdirSync(absolute, { recursive: true });
}

function renamePathInside(rootPath, relativePath, newName) {
  if (!newName || /[\/\\]/.test(newName)) throw new Error('invalid new name');
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');
  const parent = path.dirname(absolute);
  const nextAbsolute = path.join(parent, newName);
  if (!nextAbsolute.startsWith(path.resolve(rootPath))) throw new Error('invalid path');
  if (fs.existsSync(nextAbsolute)) throw new Error('destination already exists');
  fs.renameSync(absolute, nextAbsolute);
}

function deletePathInside(rootPath, relativePath, trashDir) {
  const absolute = resolveInsideRoot(rootPath, relativePath);
  if (!absolute) throw new Error('invalid path');

  if (absolute === path.resolve(rootPath)) throw new Error('cannot delete root');
  if (!fs.existsSync(absolute)) return { trashPath: null, originalPath: absolute };
  if (!trashDir) {
    fs.rmSync(absolute, { recursive: true, force: true });
    return { trashPath: null, originalPath: absolute };
  }
  fs.mkdirSync(trashDir, { recursive: true });
  const trashPath = path.join(trashDir, `${Date.now()}-${randomUUID()}-${path.basename(absolute)}`);
  // Copy into our backup cache first so undo has something to restore from.
  fs.cpSync(absolute, trashPath, { recursive: true });
  // Then move the original into the OS trash. Fall back to rmSync if the OS
  // refuses (headless CI, unsupported fs, etc.) — the backup cache still lets
  // the user undo regardless.
  let trashed = false;
  try {
    const p = shell.trashItem(absolute);
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        if (fs.existsSync(absolute)) fs.rmSync(absolute, { recursive: true, force: true });
      });
      trashed = true;
    }
  } catch {}
  if (!trashed && fs.existsSync(absolute)) {
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  return { trashPath, originalPath: absolute };
}

function restoreFromTrashInside(trashDir, trashPath, originalPath) {
  if (!trashPath || !originalPath) throw new Error('missing paths');
  const resolvedTrash = path.resolve(trashPath);
  const resolvedDir = path.resolve(trashDir);
  if (!resolvedTrash.startsWith(resolvedDir + path.sep) && resolvedTrash !== resolvedDir) {
    throw new Error('invalid trash path');
  }
  if (!fs.existsSync(resolvedTrash)) throw new Error('trash entry missing');
  if (fs.existsSync(originalPath)) throw new Error('destination already exists');
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  try {
    fs.renameSync(resolvedTrash, originalPath);
  } catch {
    fs.cpSync(resolvedTrash, originalPath, { recursive: true });
    fs.rmSync(resolvedTrash, { recursive: true, force: true });
  }
  return { ok: true };
}

async function addWorktree(projectPath, branchName, worktreePath, baseBranch, opts = {}) {
  const gitImpl = opts.gitImpl || git;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (opts.skipFetch !== true) {
    await gitImpl(projectPath, 'fetch', '--all', '--quiet').catch(() => {});
  }
  await gitImpl(projectPath, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch);
}

async function removeWorktreeWithBranch(projectPath, worktreePath, branch, opts) {
  const {
    deleteLocalBranch = true,
    deleteRemoteBranch = false,
    removeWorktree = true,
  } = opts ?? {};
  if (removeWorktree) {
    await tryGit(projectPath, 'worktree', 'remove', '--force', worktreePath);
    try {
      if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {}
    if (deleteLocalBranch && branch) {
      await tryGit(projectPath, 'branch', '-D', branch);
    }
    if (deleteRemoteBranch && branch) {
      await tryGit(projectPath, 'push', 'origin', '--delete', branch);
    }
  } else {




    if (deleteRemoteBranch && branch) {
      await tryGit(projectPath, 'push', 'origin', '--delete', branch);
    }
  }
}

async function gitStageFiles(taskPath, paths) {
  if (!paths || paths.length === 0) return;

  await git(taskPath, 'add', '--', ...paths);
}

async function gitUnstageFiles(taskPath, paths) {
  if (!paths || paths.length === 0) return;

  await tryGit(taskPath, 'restore', '--staged', '--', ...paths);
}

async function gitStageAll(taskPath) {
  await git(taskPath, 'add', '-A');
}

async function gitUnstageAll(taskPath) {

  await tryGit(taskPath, 'reset');
}

async function gitCommit(taskPath, message) {
  const out = await git(taskPath, 'commit', '-m', message);
  const hash = await tryGit(taskPath, 'rev-parse', 'HEAD');
  return { hash: hash.stdout.trim(), output: out.stdout };
}

async function gitCurrentBranch(taskPath) {
  const out = await tryGit(taskPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (out.failed) return null;
  return out.stdout.trim() || null;
}

async function gitRevert(taskPath, commitHash) {

  const out = await git(taskPath, 'revert', '--no-edit', commitHash);
  return { output: out.stdout };
}

async function gitResetHard(taskPath, commitHash) {
  const out = await git(taskPath, 'reset', '--hard', commitHash);
  return { output: out.stdout };
}

async function gitAheadBehind(taskPath) {


  const out = await tryGit(
    taskPath,
    'rev-list',
    '--left-right',
    '--count',
    '@{upstream}...HEAD'
  );
  if (out.failed) return { ahead: 0, behind: 0, hasUpstream: false };
  const parts = out.stdout.trim().split(/\s+/);
  const behind = parseInt(parts[0], 10) || 0;
  const ahead = parseInt(parts[1], 10) || 0;
  return { ahead, behind, hasUpstream: true };
}

async function gitPush(taskPath) {
  const branch = (await git(taskPath, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  try {
    const out = await git(taskPath, 'push');
    return { output: out.stdout };
  } catch (err) {
    if (/no upstream/i.test(err.stderr || '')) {
      const out = await git(taskPath, 'push', '--set-upstream', 'origin', branch);
      return { output: out.stdout };
    }
    throw err;
  }
}

async function createGithubPR(taskPath, title, body) {
  const gh = which('gh');
  if (!gh) throw new Error('GitHub CLI (gh) not installed.');
  await gitPush(taskPath);
  const args = ['pr', 'create', '--fill'];
  if (title) args.push('--title', title);
  if (body) args.push('--body', body);
  const out = await execFileP(gh, args, { cwd: taskPath });
  return { url: out.stdout.trim() };
}

// `platform` describes the machine the command will RUN on, which is not
// always this one: the same helper serves local detection and remote/SSH
// detection against Linux hosts. It therefore defaults to posix, and only
// detectLocalAgents() passes process.platform — otherwise a Windows operator
// installing to a remote Linux box would be handed PowerShell.
function providerToEntry(provider, { launchable, executable, reason, platform = 'posix' }) {
  const installCommand =
    (platform === 'win32' ? provider.installCommandWindows : null) ?? provider.installCommand ?? null;
  return {
    id: provider.id,
    name: provider.name,
    label: provider.name,
    installCommand,
    docUrl: provider.docUrl ?? null,
    status: launchable ? 'available' : 'missing',
    launchable,
    executable: executable ?? null,
    reason: reason ?? null,
    installWarning: provider.installWarning ?? null,
  };
}

function detectLocalAgents() {
  const out = {};
  for (const provider of PROVIDERS) {
    if (!provider.cli) continue;
    const bin = which(provider.cli, localCliSearchPath());
    out[provider.id] = providerToEntry(provider, {
      launchable: !!bin,
      executable: bin,
      reason: bin ? null : `${provider.cli} not found on PATH`,
      platform: process.platform,
    });
  }
  for (const provider of PROVIDERS) {
    if (provider.cli) continue;
    const backing = Array.isArray(provider.backingAgents) ? provider.backingAgents : [];
    const available = backing.filter((id) => out[id]?.launchable);
    const launchable = available.length > 0;
    out[provider.id] = providerToEntry(provider, {
      launchable,
      executable: null,
      reason: launchable
        ? null
        : `Install ${backing.join(' or ') || 'a backing agent'} to use ${provider.name}`,
      platform: process.platform,
    });
  }
  return out;
}

// Every Hermes lane on this machine runs from ONE editable checkout at
// ~/.hermes/hermes-agent. When `hermes update` pulls new code, RUNNING
// processes keep old code in memory but lazily import new modules from disk,
// which guarantees TypeError crashes on the next tool call. We fingerprint
// the on-disk code (git HEAD sha; binary mtime as a fallback) at spawn time
// and on every always-on watchdog tick so stale streams can be restarted.
function computeHermesCodeFingerprint({ hermesAgentDir, binPath }: any = {}) {
  const agentDir = hermesAgentDir || hermesPaths.hermesAgentDir();
  try {
    const head = fs.readFileSync(path.join(agentDir, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refRel = head.slice('ref: '.length).trim();
      if (refRel) {
        const sha = fs
          .readFileSync(path.join(agentDir, '.git', ...refRel.split('/')), 'utf8')
          .trim();
        if (sha) return sha;
      }
    } else if (head) {
      // Detached HEAD stores the sha directly.
      return head;
    }
  } catch {
    /* fall through to the binary-mtime fallback */
  }
  // Fallback (non-git installs, packed refs): mtime of the realpath of the
  // resolved hermes binary still changes whenever the install is replaced.
  try {
    const bin = binPath || resolveHermesBinaryPath();
    if (!bin) return null;
    return `mtime:${fs.statSync(fs.realpathSync(bin)).mtimeMs}`;
  } catch {
    return null;
  }
}

function resolveHermesBinaryPath() {
  const bin = which('hermes', localCliSearchPath());
  if (bin) return bin;
  for (const candidate of hermesPaths.hermesCliCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// Cached wrapper so per-spawn reads and 5-minute watchdog ticks stay cheap.
const HERMES_CODE_FINGERPRINT_TTL_MS = 30_000;
let hermesCodeFingerprintCache: any = { value: null, readAt: 0 };

function hermesCodeFingerprint() {
  const now = Date.now();
  if (hermesCodeFingerprintCache.readAt && now - hermesCodeFingerprintCache.readAt < HERMES_CODE_FINGERPRINT_TTL_MS) {
    return hermesCodeFingerprintCache.value;
  }
  const value = computeHermesCodeFingerprint();
  hermesCodeFingerprintCache = { value, readAt: now };
  return value;
}

// Drift decision logic for one watchdog tick, with collaborators injected so
// the policy is unit-testable (same pattern as createAlwaysOnOrchestratorWatchdog).
// For every RUNNING local Hermes stream whose spawn-time fingerprint differs
// from the current on-disk fingerprint (both non-null): restart resumable
// streams via the injected kill/restart plumbing, and banner-only streams
// without a resumable session. A stream is handled at most once per
// fingerprint value, even when the restart attempt fails.
function runHermesStaleCodeCheck({
  streams,
  currentFingerprint,
  isResumableStream,
  claimRestart,
  emitBanner,
  killStream,
  restartStream,
  logger = console,
}: any) {
  const summary = { stale: 0, restarted: 0, notified: 0 };
  if (!currentFingerprint) return summary;
  const shortFp = (fp) => String(fp).slice(0, 12);
  for (const [streamId, stream] of streams) {
    if (!stream || stream.status !== 'running') continue;
    if (String(stream.agent || '').toLowerCase() !== 'hermes') continue;
    const recorded = stream.hermesCodeFingerprint;
    if (!recorded || recorded === currentFingerprint) continue;
    if (stream.staleHermesCodeHandledFingerprint === currentFingerprint) continue;
    // Mark before acting so one fingerprint change never restarts (or
    // re-banners) the same stream twice.
    stream.staleHermesCodeHandledFingerprint = currentFingerprint;
    summary.stale += 1;
    let resumable = false;
    try {
      resumable = !!isResumableStream(streamId);
    } catch {}
    if (!resumable) {
      emitBanner(
        streamId,
        `\x1b[33m[ace] Hermes agent code changed on disk (${shortFp(recorded)} → ${shortFp(currentFingerprint)}). This tab has no resumable session — restart it manually to load the new code.\x1b[0m\r\n`
      );
      summary.notified += 1;
      continue;
    }
    if (claimRestart && !claimRestart(streamId)) {
      emitBanner(
        streamId,
        '\x1b[31m[ace] Hermes agent code changed on disk, but this tab restarted repeatedly; restart it manually to load the new code.\x1b[0m\r\n'
      );
      summary.notified += 1;
      continue;
    }
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `[ace] Hermes code updated on disk (${shortFp(recorded)} → ${shortFp(currentFingerprint)}); restarting stale stream ${streamId}`
      );
    }
    emitBanner(
      streamId,
      `\x1b[33m[ace] Hermes agent code updated on disk (${shortFp(recorded)} → ${shortFp(currentFingerprint)}); restarting this tab to load the new code…\x1b[0m\r\n`
    );
    const dims = { cols: stream.cols || 120, rows: stream.rows || 40 };
    killStream(streamId);
    restartStream(streamId, dims);
    summary.restarted += 1;
  }
  return summary;
}

function buildAgentCommand(agentId, opts = {}) {
  const provider = getProvider(agentId);
  if (!provider || !provider.cli) return null;
  let bin = which(provider.cli, opts.lookupPath || process.env.PATH || '');
  if (!bin && agentId === 'hermes') {
    for (const candidate of hermesPaths.hermesCliCandidates()) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        bin = candidate;
        break;
      } catch {}
    }
  }
  if (!bin) return null;
  const args = applyResumeArgs(
    provider,
    provider.defaultArgs ?? [],
    opts.resumeMode ?? 'fresh',
    opts.freshSessionId,
    opts.storedSessionId
  );
  // `alwaysAutoApprove` providers (Hermes) always run with permission bypass
  // inside Ace workspaces, regardless of the task's auto_approve column.
  const autoApprove = opts.autoApprove || !!provider.alwaysAutoApprove;
  if (agentId === 'claude') {
    if (!shouldUseClaudeMcp(opts)) {
      const emptyMcpConfig = ensureClaudeEmptyMcpConfigPath();
      if (!args.includes('--strict-mcp-config')) args.push('--strict-mcp-config');
      if (!args.includes('--mcp-config')) args.push('--mcp-config', emptyMcpConfig);
    }
    applyClaudeReasoningEffort(args, opts);
    applyClaudeLaneRenderer(args);
  } else if (agentId === 'codex') {
    if (codexAppParityRequested(opts.launchIntent || opts)) assertCodexAppParitySupported(bin);
    applyCodexReasoningEffort(args, opts);
    applyCodexConfigOverrides(args, opts);
    applyCodexMcpOffDefault(args, opts);
  }
  if (autoApprove && provider.autoApproveFlag) {
    args.push(provider.autoApproveFlag);
  }
  return { bin, args };
}

function buildRemoteAgentCommand(agentId, opts = {}) {
  const provider = getProvider(agentId);
  if (provider && provider.cli) {
    const args = applyResumeArgs(
      provider,
      provider.defaultArgs ?? [],
      opts.resumeMode ?? 'fresh',
      opts.freshSessionId,
      opts.storedSessionId
    );
    const autoApprove = opts.autoApprove || !!provider.alwaysAutoApprove;
    if (agentId === 'claude') {
      if (!shouldUseClaudeMcp(opts)) {
        const emptyMcpConfig = ensureClaudeEmptyMcpConfigPath();
        if (!args.includes('--strict-mcp-config')) args.push('--strict-mcp-config');
        if (!args.includes('--mcp-config')) args.push('--mcp-config', emptyMcpConfig);
      }
      applyClaudeReasoningEffort(args, opts);
      applyClaudeLaneRenderer(args);
    } else if (agentId === 'codex') {
      applyCodexReasoningEffort(args, opts);
      applyCodexConfigOverrides(args, opts);
      applyCodexMcpOffDefault(args, opts);
    }
    if (autoApprove && provider.autoApproveFlag) {
      // The Claude CLI refuses --dangerously-skip-permissions when running as
      // root; the new --permission-mode=auto path is the supported way to get
      // auto-approval as root. Switch flags when we know we're root, and let
      // the existing fast-exit retry handle older CLIs that don't recognize
      // either flag.
      if (agentId === 'claude' && opts.runAsRoot) {
        args.push('--permission-mode', 'auto');
      } else {
        args.push(provider.autoApproveFlag);
      }
    }
    if (agentId === 'claude') {
      return claudeAuthPolicy.wrapClaudeSubscriptionCommand(provider.cli, args);
    }
    return { cmd: provider.cli, args };
  }
  return { cmd: '', args: [] };
}

const HERMES_CHAT_BOTTOM_PIN_ENV = 'HERMES_CHAT_BOTTOM_PIN';
const AGENT_TERMINAL_COLOR_ENV = {
  COLORTERM: 'truecolor',
  CLICOLOR_FORCE: '1',
  FORCE_COLOR: '3',
};
const HERMES_TERMINAL_ONLY_ENV = {
  [HERMES_CHAT_BOTTOM_PIN_ENV]: '0',
  HERMES_TERMINAL_THEME: 'dark',
};
const HERMES_TERMINAL_FORCED_ENV = {
  ...HERMES_TERMINAL_ONLY_ENV,
  ...AGENT_TERMINAL_COLOR_ENV,
};

function hermesTerminalBottomPinEnv(agent) {
  return agent === 'hermes' ? { ...HERMES_TERMINAL_FORCED_ENV } : {};
}

function shouldForceAgentTerminalColor(agent) {
  return typeof agent === 'string' && agent.length > 0 && agent !== 'shell';
}

function agentTerminalForcedEnv(agent) {
  if (!shouldForceAgentTerminalColor(agent)) return {};
  return {
    ...AGENT_TERMINAL_COLOR_ENV,
    ...(agent === 'hermes' ? HERMES_TERMINAL_ONLY_ENV : {}),
  };
}

function agentTerminalForcedEnvEntries(agent, entries = []) {
  if (!shouldForceAgentTerminalColor(agent)) return entries;
  const out = [
    ...entries,
    'ACE_UNSET_NO_COLOR=1',
    'COLORTERM=truecolor',
    'CLICOLOR_FORCE=1',
    'FORCE_COLOR=3',
  ];
  if (agent === 'hermes') {
    out.push(`${HERMES_CHAT_BOTTOM_PIN_ENV}=0`, 'HERMES_TERMINAL_THEME=dark');
  }
  return out;
}

function hermesTerminalBottomPinEnvEntries(agent, entries = []) {
  return agent === 'hermes'
    ? [
        ...entries,
        'ACE_UNSET_NO_COLOR=1',
        `${HERMES_CHAT_BOTTOM_PIN_ENV}=0`,
        'HERMES_TERMINAL_THEME=dark',
        'COLORTERM=truecolor',
        'CLICOLOR_FORCE=1',
        'FORCE_COLOR=3',
      ]
    : entries;
}

// PTY stream mirrors + source-side batching live in their own module so the
// batching contract is unit-testable outside the monolith (see
// electron/pty-stream-states.cts).
const { createStreamStateManager } = require('./pty-stream-states.cts');

// Agents whose tab PTYs may live in the detached pty-host so they survive app
// quits/restarts. Hermes stays in-process (HERMES_HOME claim arbitration and
// the always-on watchdog already manage its lifecycle), shells stay in-process
// (nothing to resume).
const DETACHABLE_AGENTS = new Set(['claude', 'codex']);

function detachedAgentStreamsEnabled() {
  return process.env.ACE_DETACHED_AGENTS !== '0';
}

function autoResumeAgentStreamsEnabled() {
  return process.env.ACE_AUTO_RESUME_AGENTS !== '0';
}

function createPtyRegistry(emitter, streamStates, { onExitIntercept, isHermesHomeClaimed, ptyHost, isLaneBlockedByLegacyHost }: any = {}, testHooks = {}) {

  const streams = new Map();
  const pendingStarts = new Map();
  const cancelledStarts = new Set();
  const ptyImpl = testHooks.ptyImpl || pty;
  const verifyClaudeSubscriptionAuth =
    testHooks.verifyClaudeSubscriptionAuth || claudeAuthPolicy.verifyClaudeSubscriptionAuth;
  const listOpenFds = testHooks.listOpenFds || listOpenNumericFds;
  const closeFd = testHooks.closeFd || fs.closeSync;

  function currentStream(id, sourceStream = null) {
    const stream = streams.get(id);
    if (!stream) return null;
    // node-pty may deliver a final data/exit callback after Ace has killed
    // a stream and immediately reopened the same streamId. Never let callbacks
    // from the old PTY mutate or close the replacement tab.
    if (sourceStream && stream !== sourceStream) return null;
    return stream;
  }

  function emitData(id, data, sourceStream = null) {
    const stream = currentStream(id, sourceStream);
    if (!stream) return;
    stream.lastDataAt = Date.now();
    // Every claude lane runs on the machine's ambient subscription login, so the
    // API-billing detector always applies: an "API Usage Billing" banner means a
    // credential leaked into the lane env and the lane must not keep running.
    if (stream.agent === 'claude' && !stream.claudeApiBillingBlocked) {
      stream.claudeStartupAuthDetector ||= claudeAuthPolicy.createClaudeStartupAuthDetector();
      if (stream.claudeStartupAuthDetector.push(data) === 'api') {
        stream.claudeApiBillingBlocked = true;
        try {
          streamStates.pump(
            id,
            claudeAuthPolicy.CLAUDE_API_BILLING_BLOCK_MESSAGE,
            ({ seq, rewritten }) => emitter.emit('pty:data', { id, chunk: rewritten, seq })
          );
        } finally {
          try { stream.pty?.kill(); } catch {}
        }
        return;
      }
    }
    streamStates.pump(id, data, ({ seq, rewritten }) => {
      emitter.emit('pty:data', { id, chunk: rewritten, seq });
    });
  }

  function emitExit(id, code, sourceStream = null) {
    const stream = currentStream(id, sourceStream);
    if (!stream) return;
    stream.status = 'exited';
    // Telemetry records every real PTY exit, including ones an
    // onExitIntercept below swallows (e.g. auto-restart): the process exit
    // happened either way.
    telemetryLib.telemetryEmit({
      type: 'agent.exit',
      agent: stream.agent,
      stream: id,
      source: 'pty-registry',
      ok: code === 0,
      errorClass: code === 0 ? null : `exit-${code}`,
      durationMs: Number.isFinite(stream.startedAt) ? Date.now() - stream.startedAt : null,
      meta: { ownerKind: stream.ownerKind, ownerId: stream.ownerId, code },
    });




    if (typeof onExitIntercept === 'function') {
      try {
        if (onExitIntercept(id, code, stream) === true) return;
      } catch (err) {
        console.error('[ace] onExitIntercept failed:', err);
      }
    }
    emitter.emit('pty:exit', { id, code });
  }

  function getStream(id) {
    return streams.get(id) ?? null;
  }

  async function ensureStreamOnce({
    streamId,
    agent,
    cwd,
    ownerKind,
    ownerId,
    cols,
    rows,
    autoApprove,
    resumeMode,
    freshSessionId,
    storedSessionId,
    launchIntent,
    extraEnv,
  }) {
    streamStates.ensureState(streamId, cols, rows);
    const existing = streams.get(streamId);
    if (existing && existing.status !== 'exited') {
      if (typeof cols === 'number' && typeof rows === 'number') {
        try {
          existing.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
          streamStates.resize(streamId, cols, rows);
        } catch {}
      }
      return existing;
    }
    // This lane's ORIGINAL CLI is still running inside an outdated pty-host we
    // could not retire (see pty-host.cts). Spawning here would put a second
    // agent on the same session and transcript, so refuse until the survivor is
    // gone — the restore pass skips these too.
    if (isLaneBlockedByLegacyHost?.(streamId)) {
      return recordLaunchFailure(new Error(
        'This agent is still running inside a pty-host left over from a previous version of Ace. '
        + 'Quit Ace, make sure no "ace-pty-host" process is left running, then reopen it.'
      ));
    }
    if (!ptyImpl) throw new Error('node-pty unavailable');
    const shellPath = defaultShell();
    const env = {
      ...sanitizeAgentSpawnEnv(process.env),
      TERM: 'xterm-256color',
      ...(extraEnv || {}),
      ...agentTerminalForcedEnv(agent),
    };
    if (agent === 'claude') claudeAuthPolicy.sanitizeClaudeSubscriptionEnv(env);
    Object.assign(env, codexDefaultWorkerEnv(agent, { launchIntent }, process.env));
    if (shouldForceAgentTerminalColor(agent)) {
      delete env.NO_COLOR;
    }
    let hermesHomePath = agent === 'hermes' && env.HERMES_HOME ? path.resolve(String(env.HERMES_HOME)) : null;
    if (hermesHomePath) {
      try { hermesHomePath = fs.realpathSync.native(hermesHomePath); } catch { /* not yet created */ }
    }
    // A RUNNING Hermes Desktop dashboard owns its HERMES_HOME exclusively —
    // refuse the PTY writer instead of racing it for state.db. Keyed on live
    // claims only (never the stored surface preference), so with no dashboard
    // running this is a no-op and every lane path behaves exactly as before.
    if (hermesHomePath && typeof isHermesHomeClaimed === 'function' && isHermesHomeClaimed(hermesHomePath)) {
      return recordLaunchFailure(new Error(
        'This Hermes home is driven by the Hermes Desktop surface — close it in Teams or switch back to Terminal lanes in Settings.'
      ));
    }
    if (hermesHomePath) {
      for (const [otherId, other] of streams.entries()) {
        if (otherId === streamId || other.status === 'exited') continue;
        if (other.agent !== 'hermes' || other.hermesHomePath !== hermesHomePath) continue;
        emitter.emit('pty:data', {
          id: otherId,
          chunk: '\x1b[33m[ace] Closing duplicate Hermes writer for this HERMES_HOME.\x1b[0m\r\n',
        });
        try { other.pty?.kill(); } catch {}
        streams.delete(otherId);
        streamStates.remove(otherId);
        emitter.emit('pty:exit', { id: otherId, code: 0 });
      }
    }
    const spawnCols = Math.max(2, (cols | 0) || 100);
    const spawnRows = Math.max(1, (rows | 0) || 28);
    // The mirror may be REUSED from a previous lifecycle of this stream id
    // (ensureState above never resizes an existing one) — bring it to the
    // dims the fresh PTY is about to spawn AT. A mirror even two rows short
    // clamps the TUI's absolute-positioned footer ONTO the composer row,
    // after which ready detection, the lane state machine, and auto-resume
    // readiness misread the lane for its whole lifetime. Done here — not in
    // ensureState — so the running-stream resize path above keeps its
    // pty-first ordering (a failed pty resize must not leave the mirror
    // resized ahead of it).
    streamStates.resize(streamId, spawnCols, spawnRows);

    function recordLaunchFailure(err) {
      console.error(`[ace] pty spawn failed for ${agent} in ${cwd}:`, err);
      const failed = {
        id: streamId,
        pty: null,
        agent,
        cwd,
        chunks: [],
        status: 'exited',
        ownerKind,
        ownerId,
        error: err && err.message ? err.message : String(err || 'unknown launch error'),
      };
      streams.set(streamId, failed);
      setImmediate(() => {
        emitter.emit('pty:data', {
          id: streamId,
          chunk: `\x1b[31mFailed to launch ${agent}: ${err.message}\x1b[0m\r\n`,
        });
        emitter.emit('pty:exit', { id: streamId, code: -1 });
      });
      return failed;
    }

    if (!cwd || !localDirectoryExists(cwd)) {
      return recordLaunchFailure(new Error(`working directory missing: ${cwd || '(empty)'}`));
    }

    const cmd = buildAgentCommand(agent, {
      autoApprove,
      resumeMode,
      freshSessionId,
      storedSessionId,
      launchIntent,
      lookupPath: env.PATH,
    });
    if (agent === 'claude' && cmd) {
      let auth;
      try {
        auth = await verifyClaudeSubscriptionAuth({ bin: cmd.bin, cwd, env });
      } catch (err) {
        auth = { ok: false, reason: claudeAuthPolicy.describeClaudeAuthProbeFailure(err, null) };
      }
      if (cancelledStarts.has(streamId)) {
        return { id: streamId, pty: null, agent, cwd, status: 'exited', error: 'launch cancelled' };
      }
      // `/login` runs inside this lane's PTY, so a signed-out CLI must spawn or
      // the user has no route to sign in. API billing stays blocked by the env
      // scrub and the startup-banner detector below.
      if (!auth?.ok && claudeAuthPolicy.isClaudeLoggedOutAuthResult(auth)) {
        console.warn('[ace] claude lane starting signed out; the CLI will prompt for /login');
      } else if (!auth?.ok) {
        console.warn(`[ace] claude lane blocked: ${auth?.reason || 'verification-failed'}`);
        return recordLaunchFailure(claudeAuthPolicy.claudeSubscriptionAuthError(auth));
      }
    }
    // Route claude/codex agent tabs through the detached pty-host when it is
    // up, so the agent process survives an app quit/restart and gets adopted
    // back on the next boot. Anything else (shells, hermes, host down) keeps
    // the in-process node-pty path.
    const useDetachedHost = !!(
      cmd &&
      ptyHost &&
      detachedAgentStreamsEnabled() &&
      ptyHost.isConnected() &&
      ownerKind !== 'shell' &&
      DETACHABLE_AGENTS.has(String(agent || '').toLowerCase())
    );
    let proc;
    const fdsBeforeSpawn = listOpenFds();
    try {
      if (cmd && useDetachedHost) {
        proc = ptyHost.spawnStream({
          id: streamId,
          bin: cmd.bin,
          args: cmd.args,
          cwd,
          env,
          cols: spawnCols,
          rows: spawnRows,
          agent,
        });
      } else if (cmd) {
        proc = ptyImpl.spawn(cmd.bin, cmd.args, {
          name: 'xterm-256color',
          cols: spawnCols,
          rows: spawnRows,
          cwd,
          env,
        });
      } else if (ownerKind === 'shell') {
        proc = ptyImpl.spawn(shellPath, [], {
          name: 'xterm-256color',
          cols: spawnCols,
          rows: spawnRows,
          cwd,
          env,
        });
      } else {
        throw new Error(`agent CLI not found for ${agent}`);
      }
    } catch (err) {
      const closed = closeNewFileDescriptors(fdsBeforeSpawn, { listOpenFds, closeFd });
      if (closed > 0) {
        console.warn(`[ace] closed ${closed} leaked file descriptor(s) after failed PTY spawn`);
      }
      return recordLaunchFailure(err);
    }
    const stream = {
      id: streamId,
      pty: proc,
      agent,
      cwd,
      chunks: [],
      status: 'running',
      ownerKind,
      ownerId,
      hermesHomePath,
      // Snapshot of the on-disk hermes code at spawn time; the always-on
      // watchdog compares it against the current fingerprint to catch
      // `hermes update` landing under a running process.
      hermesCodeFingerprint: agent === 'hermes' ? hermesCodeFingerprint() : null,
      startedAt: Date.now(),
      resumeMode: resumeMode ?? 'fresh',
      cols: spawnCols,
      rows: spawnRows,
      detached: useDetachedHost,
      // Retain the spawn intent so a respawn re-derives this lane's
      // classification from it, not from the thin respawn shape.
      launchIntent: launchIntent ?? null,
    };
    streams.set(streamId, stream);
    // node-pty runs these callbacks on its native ThreadSafeFunction. If a
    // handler throws (e.g. a transient "database connection is not open" while
    // recording PTY output, or a downstream pty:data/pty:exit listener), the
    // exception escapes into node-pty's C++ callback, becomes an uncaught
    // ThrowAsJavaScriptException, and aborts the whole process (SIGABRT). A PTY
    // handler failure must never take down the app — log it and keep running.
    proc.onData((data) => {
      try {
        emitData(streamId, data, stream);
      } catch (err) {
        console.error('[ace] pty onData handler failed (suppressed to keep app alive):', err);
      }
    });
    proc.onExit(({ exitCode }) => {
      try {
        emitExit(streamId, exitCode, stream);
      } catch (err) {
        console.error('[ace] pty onExit handler failed (suppressed to keep app alive):', err);
      }
    });
    emitter.emit('pty:opened', { id: streamId, agent, cwd });
    telemetryLib.telemetryEmit({
      type: 'agent.spawn',
      agent,
      stream: streamId,
      source: 'pty-registry',
      ok: true,
      meta: { ownerKind, ownerId, resumeMode: stream.resumeMode },
    });
    return stream;
  }

  function ensureStream(opts: any) {
    const streamId = opts?.streamId;
    const pending = pendingStarts.get(streamId);
    if (pending) return pending;
    cancelledStarts.delete(streamId);
    const start = ensureStreamOnce(opts);
    const tracked = start.finally(() => {
      if (pendingStarts.get(streamId) === tracked) {
        pendingStarts.delete(streamId);
        cancelledStarts.delete(streamId);
      }
    });
    pendingStarts.set(streamId, tracked);
    return tracked;
  }

  // Re-register a stream that survived an app restart inside the detached
  // pty-host. The handle is pty-shaped (write/resize/kill/onData/onExit); its
  // queued attach replay flushes through emitData as soon as onData is wired,
  // rebuilding the headless terminal state for the renderer snapshot.
  function adoptStream({ streamId, agent, cwd, ownerKind, ownerId, handle, cols, rows, launchIntent }: any) {
    streamStates.ensureState(streamId, cols, rows);
    const stream: any = {
      id: streamId,
      pty: handle,
      agent,
      cwd,
      chunks: [],
      status: 'running',
      ownerKind,
      ownerId,
      hermesHomePath: null,
      hermesCodeFingerprint: null,
      startedAt: Date.now(),
      resumeMode: 'adopted',
      cols: Math.max(2, (cols | 0) || 100),
      rows: Math.max(1, (rows | 0) || 28),
      detached: true,
      // Restore the persisted classification so a later respawn of this adopted
      // lane keeps its strip instead of reclassifying from a bare stream.
      launchIntent: launchIntent ?? null,
    };
    streams.set(streamId, stream);
    // Nothing is injected into an adopted lane: its TUI is already mid-render
    // and stray bytes corrupt a cursor-positioned screen. It was written at
    // its original spawn.
    handle.onData((data: any) => {
      try {
        emitData(streamId, data, stream);
      } catch (err) {
        console.error('[ace] adopted pty onData handler failed (suppressed):', err);
      }
    });
    handle.onExit(({ exitCode }: any) => {
      try {
        emitExit(streamId, exitCode, stream);
      } catch (err) {
        console.error('[ace] adopted pty onExit handler failed (suppressed):', err);
      }
    });
    emitter.emit('pty:opened', { id: streamId, agent, cwd });
    telemetryLib.telemetryEmit({
      type: 'agent.spawn',
      agent,
      stream: streamId,
      source: 'pty-host-adopt',
      ok: true,
      meta: { ownerKind, ownerId, resumeMode: 'adopted' },
    });
    return stream;
  }

  function writeStream(streamId, data) {
    const s = streams.get(streamId);
    if (!s || s.status === 'exited') return false;
    // Opens the limit/auth sniffer gate: a resumed CLI replays its transcript
    // (which may contain an old limit or 401 banner) before anyone types, so
    // banners are only trusted once the lane has received real input.
    s.sawInputSinceSpawn = true;
    s.pty.write(data);
    return true;
  }

  function resizeStream(streamId, cols, rows) {
    const s = streams.get(streamId);
    if (!s || s.status === 'exited') return false;
    try {
      s.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
      streamStates.resize(streamId, cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  function killStream(streamId) {
    if (pendingStarts.has(streamId)) cancelledStarts.add(streamId);
    const s = streams.get(streamId);
    if (!s) return undefined;
    let killed;
    try {
      // Detached (pty-host) handles return the in-flight kill request; local
      // node-pty handles return undefined. Return the promise (if any) so an
      // auth teardown can await daemon-confirmed termination.
      killed = s.pty.kill();
    } catch {}
    streams.delete(streamId);
    streamStates.remove(streamId);
    return killed && typeof killed.then === 'function' ? killed : undefined;
  }

  function snapshot(streamId) {
    const s = streams.get(streamId);
    if (!s) return null;
    return { id: s.id, agent: s.agent, status: s.status, chunks: [] };
  }

  function syncSnapshot(streamId) {
    return streamStates.sync(streamId);
  }

  // preserveDetached: app-shutdown mode — host-backed agent streams keep
  // running inside the detached pty-host (that's the whole point); only drop
  // our in-process references. Everything else is killed as before.
  function killAll({ preserveDetached = false } = {}) {
    const pendingKills = [];
    for (const id of pendingStarts.keys()) cancelledStarts.add(id);
    for (const [id, s] of Array.from(streams.entries())) {
      if (preserveDetached && s.detached && s.status !== 'exited') {
        streams.delete(id);
        streamStates.remove(id);
        continue;
      }
      const pending = killStream(id);
      if (pending) pendingKills.push(pending);
    }
    // The kill requests still in flight (detached daemon round-trips). An auth
    // teardown awaits these before closing the host so the kills can't be dropped.
    return pendingKills;
  }

  return {
    ensureStream,
    adoptStream,
    writeStream,
    resizeStream,
    killStream,
    snapshot,
    syncSnapshot,
    killAll,
    streams,
    getStream,
  };
}


const GIT_WATCHER_BUILTIN_IGNORES = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'out/',
  'target/',
  'coverage/',
  '.turbo/',
  '.cache/',
  '.venv/',
  'venv/',
  '.pnpm-store/',
  '.ace/',
  '.DS_Store',
  '*.log',
];

const GIT_WATCHER_SLOW_INIT_MS = 5_000;

function shouldAttachStartupGitWatchers({ activeLocalTaskCount: _activeLocalTaskCount = 0, env = process.env } = {}) {
  if (env?.ACE_DISABLE_GIT_WATCHER === '1') return false;
  // Attach bounded git-state pollers by default so task totals still refresh
  // without fanning out full recursive file watchers across every worktree.
  return true;
}



// 5s: remote totals are advisory UI freshness; 3s woke the main thread for
// sqlite+ssh work on every attached remote task with no visible benefit.
const REMOTE_POLL_INTERVAL_MS = 5000;

function createRemoteGitPoller(events, resolveRemoteTaskInfo, daemonFor) {

  const entries = new Map();

  async function pollOnce(taskId) {
    const entry = entries.get(taskId);
    if (!entry || entry.inflight) return;
    entry.inflight = true;
    const gen = ++entry.generation;
    try {
      const daemon = daemonFor(entry.sshHost, entry.agentUser);




      // Sum lines across untracked files instead of just counting them so the
      // sidebar +/- matches the local poller (which adds each untracked
      // file's LOC). `cat | wc -l` collapses everything into a single total.
      const script =
        'git diff --shortstat 2>/dev/null;' +
        ' echo "---";' +
        ' git diff --cached --shortstat 2>/dev/null;' +
        ' echo "---";' +
        ' git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 cat 2>/dev/null | wc -l';
      const res = await daemon.exec({
        cmd: 'sh',
        args: ['-c', script],
        cwd: entry.cwd,
      });
      if (gen !== entry.generation) return;
      if (res.code !== 0) return;
      const parts = res.stdout.split('---');
      const unstagedStat = parseShortstat(parts[0] || '');
      const stagedStat = parseShortstat(parts[1] || '');
      const untrackedAdditions = parseInt((parts[2] || '').trim(), 10) || 0;
      const totals = {
        additions: unstagedStat.additions + stagedStat.additions + untrackedAdditions,
        deletions: unstagedStat.deletions + stagedStat.deletions,
      };
      const prev = entry.totals;
      if (prev.additions !== totals.additions || prev.deletions !== totals.deletions) {
        entry.totals = totals;
        events.emit('git:changed', { taskId });
        events.emit('state:invalidate');
      }
    } catch {

    } finally {
      if (entries.has(taskId)) entries.get(taskId).inflight = false;
    }
  }

  function attachTask(taskId) {
    if (entries.has(taskId)) return;
    const info = resolveRemoteTaskInfo(taskId);
    if (!info) return;
    const entry = {
      sshHost: info.sshHost,
      agentUser: info.agentUser ?? null,
      cwd: info.cwd,
      totals: { additions: 0, deletions: 0 },
      timer: null,
      inflight: false,
      generation: 0,
    };
    entries.set(taskId, entry);

    void pollOnce(taskId);
    entry.timer = setInterval(() => pollOnce(taskId), REMOTE_POLL_INTERVAL_MS);
  }

  function detachTask(taskId) {
    const entry = entries.get(taskId);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    entries.delete(taskId);
  }

  function getTaskTotals(taskId) {
    const entry = entries.get(taskId);
    return entry ? entry.totals : null;
  }

  function refreshNow(taskId) {
    if (entries.has(taskId)) void pollOnce(taskId);
  }

  function shutdown() {
    for (const entry of entries.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    entries.clear();
  }

  return { attachTask, detachTask, getTaskTotals, refreshNow, shutdown };
}

function parseShortstat(text) {
  const out = { additions: 0, deletions: 0 };
  if (!text) return out;
  const addMatch = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const delMatch = /(\d+)\s+deletions?\(-\)/.exec(text);
  if (addMatch) out.additions = parseInt(addMatch[1], 10) || 0;
  if (delMatch) out.deletions = parseInt(delMatch[1], 10) || 0;
  return out;
}

function projectWorkspaces(db, getTaskTotals, metaCache, prepFor) {
  const projectRows = db.prepare('SELECT * FROM projects ORDER BY order_index ASC, created_at ASC').all();
  const taskRows = db.prepare(
    `SELECT * FROM tasks WHERE archived_at IS NULL ORDER BY pinned DESC, order_index ASC, created_at ASC`
  ).all();
  const archivedRows = db.prepare(
    `SELECT * FROM tasks WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`
  ).all();
  const worktreeRows = db.prepare('SELECT * FROM worktrees ORDER BY created_at ASC').all();
  const variantRows = db.prepare(
    'SELECT * FROM variants ORDER BY order_index ASC, attached_at ASC'
  ).all();
  const conversationRows = db.prepare(
    'SELECT * FROM conversations ORDER BY display_order ASC, created_at ASC'
  ).all();

  const worktreesByTask = new Map();
  for (const row of worktreeRows) {
    const list = worktreesByTask.get(row.task_id) ?? [];
    list.push(row);
    worktreesByTask.set(row.task_id, list);
  }
  const variantsByWorktree = new Map();
  for (const row of variantRows) {
    const list = variantsByWorktree.get(row.worktree_id) ?? [];
    list.push(row);
    variantsByWorktree.set(row.worktree_id, list);
  }
  const conversationsByTask = new Map();
  for (const row of conversationRows) {
    const list = conversationsByTask.get(row.task_id) ?? [];
    list.push(row);
    conversationsByTask.set(row.task_id, list);
  }

  function projectTask(row) {
    // Worktree checkout for a freshly-created task runs off the createTask
    // response path; while it runs (or if it failed) the task carries a
    // transient prep marker so the renderer can show a preparing/error state
    // instead of an empty task. Absent marker = normal.
    const prep = prepFor ? prepFor(row.id) : null;
    const worktreeRowsForTask = worktreesByTask.get(row.id) ?? [];
    const worktrees = worktreeRowsForTask.map((wt) => ({
      worktreeId: wt.id,
      displayName: wt.display_name,
      branch: wt.branch,
      path: wt.path,
      variants: (variantsByWorktree.get(wt.id) ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        agent: v.agent,
        branch: v.branch,
        worktreeId: v.worktree_id,
        busy: false,
        isReviewMode: !!v.review_mode,
        kind: v.kind === 'chat' ? 'chat' : 'cli',
      })),
    }));
    const convs = (conversationsByTask.get(row.id) ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      agent: c.agent,
      kind: c.kind === 'chat' ? 'chat' : 'cli',
      isMain: !!c.is_main,
      isActive: !!c.is_active,
    }));
    const agents = Array.from(
      new Set([
        row.primary_agent,
        ...worktrees.flatMap((w) => w.variants.map((v) => v.agent)),
      ])
    );
    const totals = getTaskTotals ? getTaskTotals(row.id) : { additions: 0, deletions: 0 };
    return {
      id: row.id,
      name: row.name,
      branch: worktrees[0]?.branch ?? '',
      type: row.kind,
      status: prep?.state === 'preparing' ? 'preparing' : prep?.state === 'error' ? 'error' : 'idle',
      prepError: prep?.state === 'error' ? (prep.error ?? null) : null,
      agent: row.primary_agent,
      agents,
      isMultiAgent: !!row.is_multi_agent,
      updatedAt: row.updated_at,
      initialPrompt: row.initial_prompt ?? undefined,
      autoApproveEnabled: !!row.auto_approve,
      archivedAt: row.archived_at ?? null,
      archivedPrUrl: row.archived_pr_url ?? null,
      conversations: convs,
      worktrees,
      fileChanges: [],
      additions: totals.additions,
      deletions: totals.deletions,
    };
  }

  const tasksByProject = new Map();
  for (const t of taskRows) {
    const list = tasksByProject.get(t.project_id) ?? [];
    list.push(projectTask(t));
    tasksByProject.set(t.project_id, list);
  }
  const archivedByProject = new Map();
  for (const t of archivedRows) {
    const list = archivedByProject.get(t.project_id) ?? [];
    list.push(projectTask(t));
    archivedByProject.set(t.project_id, list);
  }

  return projectRows.map((p) => {
    const meta = metaCache?.get(p.id);
    const openPrs = meta?.openPrs ?? [];
    // Build a branch → PR map so task rows can surface their PR badge
    // without the renderer having to re-scan openPrs for every task.
    const prByBranch = new Map();
    for (const pr of openPrs) {
      if (pr.headRef) prByBranch.set(pr.headRef, pr);
    }
    const attachPr = (task) => {
      const branches = [task.branch, ...(task.worktrees ?? []).map((w) => w.branch)].filter(Boolean);
      for (const b of branches) {
        const pr = prByBranch.get(b);
        if (pr) return { ...task, prNumber: pr.number, prStatus: pr.isDraft ? 'draft' : 'open' };
      }
      return task;
    };
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      isRemote: !!p.is_remote,
      sshHost: p.ssh_host ?? null,
      sshUser: p.ssh_user ?? null,
      remotePath: p.remote_path ?? null,
      agentUser: p.agent_user ?? null,
      defaultBranch: p.default_branch ?? 'main',
      isInitialized: !!p.initialized,
      githubRepo: p.github_repo ?? null,
      alwaysOnOrchestrator: !!p.always_on_orchestrator,
      alwaysOnAgent: p.always_on_agent ?? null,
      isPersonal: !!p.is_personal,
      personalIdentity: p.personal_identity ?? null,
      branches: meta?.branches ?? [],
      openPrs,
      cleanupBranches: meta?.cleanupBranches ?? [],
      tasks: (tasksByProject.get(p.id) ?? []).map(attachPr),
      archivedTasks: (archivedByProject.get(p.id) ?? []).map(attachPr),
    };
  });
}

function projectWorkspaceSummaries(db, metaCache) {
  const started = perfHealth.nowMs();
  const projectRows = db.prepare('SELECT * FROM projects ORDER BY order_index ASC, created_at ASC').all();
  const taskRows = db.prepare(
    `SELECT id, project_id, kind, name, primary_agent, is_multi_agent, updated_at
       FROM tasks
      WHERE archived_at IS NULL
      ORDER BY pinned DESC, order_index ASC, created_at ASC`
  ).all();
  const branchRows = db.prepare(
    `SELECT task_id, branch
       FROM worktrees
      WHERE branch IS NOT NULL AND branch != ''
      ORDER BY created_at ASC`
  ).all();

  const firstBranchByTask = new Map();
  for (const row of branchRows) {
    if (!firstBranchByTask.has(row.task_id)) firstBranchByTask.set(row.task_id, row.branch);
  }

  const tasksByProject = new Map();
  for (const row of taskRows) {
    const task = {
      id: row.id,
      name: row.name,
      branch: firstBranchByTask.get(row.id) ?? '',
      type: row.kind,
      status: 'idle',
      agent: row.primary_agent,
      agents: row.primary_agent ? [row.primary_agent] : [],
      isMultiAgent: !!row.is_multi_agent,
      updatedAt: row.updated_at,
      conversations: [],
      worktrees: [],
      fileChanges: [],
      additions: 0,
      deletions: 0,
    };
    const list = tasksByProject.get(row.project_id) ?? [];
    list.push(task);
    tasksByProject.set(row.project_id, list);
  }

  const workspaces = projectRows.map((p) => {
    const meta = metaCache?.get(p.id);
    const openPrs = meta?.openPrs ?? [];
    const prByBranch = new Map();
    for (const pr of openPrs) {
      if (pr.headRef) prByBranch.set(pr.headRef, pr);
    }
    const attachPr = (task) => {
      const pr = task.branch ? prByBranch.get(task.branch) : null;
      return pr ? { ...task, prNumber: pr.number, prStatus: pr.isDraft ? 'draft' : 'open' } : task;
    };
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      isRemote: !!p.is_remote,
      sshHost: p.ssh_host ?? null,
      sshUser: p.ssh_user ?? null,
      remotePath: p.remote_path ?? null,
      agentUser: p.agent_user ?? null,
      defaultBranch: p.default_branch ?? 'main',
      isInitialized: !!p.initialized,
      githubRepo: p.github_repo ?? null,
      alwaysOnOrchestrator: !!p.always_on_orchestrator,
      alwaysOnAgent: p.always_on_agent ?? null,
      isPersonal: !!p.is_personal,
      personalIdentity: p.personal_identity ?? null,
      branches: meta?.branches ?? [],
      openPrs,
      cleanupBranches: meta?.cleanupBranches ?? [],
      tasks: (tasksByProject.get(p.id) ?? []).map(attachPr),
      archivedTasks: [],
    };
  });
  perfHealth.recordSpan({
    source: 'main',
    name: 'core.workspaceSummaries',
    durationMs: perfHealth.nowMs() - started,
    meta: {
      workspaces: workspaces.length,
      tasks: taskRows.length,
      branches: branchRows.length,
    },
  });
  return workspaces;
}

function archiveTaskRow({ db, getTaskById, taskId, prUrl = null, mergedAt, now = nowIso }) {
  const task = typeof getTaskById === 'function' ? getTaskById(taskId) : null;
  if (!task) throw new Error('task not found');
  const archivedAt = typeof mergedAt === 'string' && mergedAt ? mergedAt : now();
  db.prepare(
    'UPDATE tasks SET archived_at = ?, archived_pr_url = ?, updated_at = ? WHERE id = ?'
  ).run(archivedAt, prUrl, archivedAt, taskId);
  return { archivedAt, prUrl };
}

const LEGACY_ARCHIVE_DISABLE_TRIGGERS = [
  'ace_disable_task_archive_guard',
  'ace_disable_mission_feature_archive_guard',
];

function dropLegacyArchiveDisableTriggers(db) {
  for (const trigger of LEGACY_ARCHIVE_DISABLE_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

function warnIfDelegationMissingInitialPrompt({ row, delegated = false, warn = console.warn }) {
  const prompt = row?.initial_prompt;
  if (typeof prompt === 'string' && prompt.trim().length > 0) return false;
  const autoApprove = row?.auto_approve === 1 || row?.auto_approve === true;
  const name = String(row?.name || '');
  const delegatedName = /^(adhoc|delegated|spec):/i.test(name);
  const looksDelegated =
    delegated ||
    (row?.kind === 'thread' && autoApprove && delegatedName) ||
    delegatedName;
  if (!looksDelegated) return false;
  warn(
    `[ace] delegation missing initial_prompt: taskId=${row?.id || 'unknown'} agent=${row?.primary_agent || 'unknown'} kind=${row?.kind || 'unknown'}`
  );
  return true;
}

// Resolve a clone destination to an absolute path.
// Relative paths land under ~/Documents/GitHub (macOS/Windows) or ~/GitHub (Linux),
// mirroring the convention in github-core. Traversal segments are rejected.
function resolveClonePath(localPath: string, _cloneRoot?: string): string {
  const root = _cloneRoot ?? (
    (process.platform === 'win32' || process.platform === 'darwin')
      ? path.join(os.homedir(), 'Documents', 'GitHub')
      : path.join(os.homedir(), 'GitHub')
  );
  if (path.isAbsolute(localPath)) {
    return path.normalize(localPath);
  }
  const normalized = path.normalize(localPath);
  // Reject any relative path that would escape the clone root via traversal.
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new Error(
      `Clone destination "${localPath}" escapes the clone root — use an absolute path instead`
    );
  }
  return path.join(root, normalized);
}

function appendProjectLifecycleEvent(repoRoot, event) {
  if (!repoRoot) return;
  try {
    const eventPath = path.join(repoRoot, '.ace', 'events.ndjson');
    fs.mkdirSync(path.dirname(eventPath), { recursive: true });
    fs.appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  } catch {}
}

function createAceStore(userDataPath, testHooks = {}) {
  // Single writer of <userDataPath>/operators.json: migrate (idempotent;
  // aborts safely on an unreadable db) BEFORE opening ace.db so the
  // identity seed + forced renames below run with config-driven values. The
  // loaded config is held for the store's lifetime.
  const operatorsConfig = operatorsLib.migrateOperatorsConfig(userDataPath).config;
  // Mission identity sets (owner/controller normalization, projection
  // fallbacks) flow from the loaded operators config, not module defaults.
  setMissionIdentityConfig({
    controlPlaneIds: operatorsLib
      .listControlPlaneOperators(operatorsConfig)
      .map((op: any) => op.id),
    defaultOperatorId: operatorsConfig.defaultOperatorId,
  });
  const db = openDatabase(userDataPath, operatorsConfig, testHooks.Database);
  // L0 telemetry spine (electron/telemetry.cts): append-only operational
  // event log on the active data root. Init is additive — telemetryEmit()
  // stays a silent no-op anywhere the store was never created (CLI, tests).
  telemetryLib.initTelemetry({ userDataPath });
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const agentCliDriverForStore = (testHooks as any).agentCliDriver || agentCliDriver;
  const opsSourcesForStore = (testHooks as any).opsSources || opsSources;
  const readOpsRefreshConfigForStore =
    (testHooks as any).readOpsRefreshConfig || readOpsRefreshConfig;
  const readTodoDigestConfigForStore =
    (testHooks as any).readTodoDigestConfig || readTodoDigestConfig;
  const runOpsStatusForStore = (testHooks as any).runOpsStatus || runOpsStatus;

  // Boot consistency: every personal identity in the db must have an operator
  // profile; anything missing is a loud, greppable warning (never fatal).
  try {
    const dbIdentities = db
      .prepare(`SELECT DISTINCT personal_identity FROM projects WHERE is_personal = 1`)
      .all()
      .map((row: any) => row.personal_identity);
    const missing = operatorsLib.checkDbConfigConsistency(dbIdentities, operatorsConfig);
    if (missing.length > 0) {
      console.warn(`[ace] operators-config missing identities: ${missing.join(', ')}`);
    }
  } catch (err) {
    console.warn(
      '[ace] operators-config consistency check failed:',
      err && err.message ? err.message : err
    );
  }

  const ensureHermesHomeForWorkspace = (workspaceId) =>
    hermesHome.ensureHermesHomeForWorkspace(userDataPath, workspaceId);

  // Operator profiles (the owner's Rook/King; neutral Hermes on fresh
  // installs) come from operatorsConfig — loaded once above via the
  // single-writer migration. 'lane:' identities are NOT operators and flow
  // through normalizeOperatorId untouched, so they can never resolve to an
  // operator profile here.
  function requireOperator(identity: any) {
    const id = operatorsLib.normalizeOperatorId(operatorsConfig, identity);
    const op = operatorsLib.getOperator(operatorsConfig, id);
    if (!op) throw new Error(`unknown operator identity: ${id}`);
    return op;
  }

  function personalIdentityAuthCandidatePaths(currentProjectId) {
    try {
      const ids = operatorsLib
        .listControlPlaneOperators(operatorsConfig)
        .map((op: any) => op.id.toLowerCase());
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT id FROM projects
           WHERE is_personal = 1
             AND id != ?
             AND LOWER(COALESCE(personal_identity, '')) IN (${placeholders})`
        )
        .all(currentProjectId, ...ids)
        .map((row) => path.join(hermesHome.workspaceHermesHome(userDataPath, row.id), 'auth.json'));
    } catch {
      return [];
    }
  }

  function ensureHermesHomeForProject(project) {
    if (!project?.id) return hermesHome.baseHermesHome(userDataPath);
    const op = project.is_personal
      ? operatorsLib.operatorForProject(operatorsConfig, project)
      : null;
    if (op) {
      // Cross-unit contract with hermes-home's ensureIdentityHermesHome:
      // - soul: persona text; undefined/null means NO SOUL.md override is
      //   written (persona-null operators like Rook — never fabricate one).
      // - memoryDbPath / legacyAuthDirs / hermesHomeOverride are consumed by
      //   the updated hermes-home; extra opts are harmless on the older one.
      // - identity is kept transitionally so the pre-contract hermes-home
      //   still resolves its legacy rook/king auth candidates.
      const soul = operatorsLib.loadPersonaPrompt(op);
      return hermesHome.ensureIdentityHermesHome(userDataPath, project.id, {
        identity: op.id,
        authCandidatePaths: personalIdentityAuthCandidatePaths(project.id),
        ...(soul ? { soul } : {}),
        memoryDbPath: op.memoryDbPath ?? null,
        legacyAuthDirs: Array.isArray(op.legacyAuthDirs) ? op.legacyAuthDirs : [],
        terminalCwd: path.join(userDataPath, op.terminalDirName),
        hermesHomeOverride: op.hermesHome ?? null,
      });
    }
    return ensureHermesHomeForWorkspace(project.id);
  }

  // Cheap launch-time evidence for whether a Hermes home has meaningful
  // dashboard history. Do not open state.db here: these files can be 1GB+ and
  // synchronous SQLite probes block Electron's first renderer paint.
  function hermesHomeStateDbSize(home) {
    if (!home) return null;
    const dbPath = path.join(home, 'state.db');
    try {
      const stat = fs.statSync(dbPath);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  function hasHermesHomeStateDbEvidence(size) {
    return typeof size === 'number' && size > 32768;
  }

  function parseJsonObject(raw) {
    if (!raw || typeof raw !== 'string') return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function looksLikeHermesProviderIdentity(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value.trim());
  }

  function hermesSessionResumeProblem(home, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || sid === 'seen' || sid === 'live') return 'non-concrete-session-id';
    const stateDb = path.join(home, 'state.db');
    try {
      if (!fs.statSync(stateDb).isFile()) return null;
    } catch {
      return null;
    }
    let hdb = null;
    try {
      hdb = new Database(stateDb, { readonly: true, fileMustExist: true });
      // Hermes CLI/gateway processes write this db concurrently; without a
      // busy_timeout a held write lock surfaces as SQLITE_BUSY instead of a
      // short wait, and the conversation fails to load.
      hdb.pragma('busy_timeout = 5000');
      const row = hdb
        .prepare('SELECT id, model, model_config, billing_provider, billing_base_url FROM sessions WHERE id = ?')
        .get(sid);
      if (!row) return 'missing-session-row';
      const modelConfig = parseJsonObject(row.model_config);
      const model = String(row.model || modelConfig.model || '').trim();
      if (!model) return 'missing-model';
      const explicitProvider = String(modelConfig.provider || '').trim();
      const billingProvider = String(modelConfig.billing_provider || row.billing_provider || '').trim();
      const provider = explicitProvider || billingProvider;
      if (!provider) return 'missing-provider';
      if (!looksLikeHermesProviderIdentity(provider)) return 'malformed-provider';
      return null;
    } catch {
      return null;
    } finally {
      try { hdb?.close(); } catch {}
    }
  }

  function hermesSessionActivityScore(value) {
    if (value == null || value === '') return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function resolveHermesCompressionTip(home, sessionId) {
    let current = String(sessionId || '').trim();
    if (!current || current === 'seen' || current === 'live') return current || sessionId;
    const stateDb = path.join(home, 'state.db');
    try {
      if (!fs.statSync(stateDb).isFile()) return current;
    } catch {
      return current;
    }
    let hdb = null;
    try {
      hdb = new Database(stateDb, { readonly: true, fileMustExist: true });
      hdb.pragma('busy_timeout = 5000'); // concurrent Hermes writers; see above
      const seen = new Set();
      for (let depth = 0; depth < 100; depth += 1) {
        if (seen.has(current)) return current;
        seen.add(current);
        const parent = hdb
          .prepare('SELECT id, end_reason FROM sessions WHERE id = ?')
          .get(current);
        if (!parent || parent.end_reason !== 'compression') return current;
        const children = hdb
          .prepare(
            `SELECT child.id,
                    child.source,
                    child.model_config,
                    child.started_at,
                    child.ended_at,
                    child.end_reason,
                    COALESCE(
                      (SELECT MAX(messages.timestamp) FROM messages WHERE messages.session_id = child.id),
                      child.started_at
                    ) AS activity_at
               FROM sessions child
              WHERE child.parent_session_id = ?`
          )
          .all(current)
          .filter((child) => {
            if (!child?.id || child.id === current) return false;
            if (String(child.source || '').toLowerCase() === 'tool') return false;
            const config = parseJsonObject(child.model_config);
            return config._branched_from == null && config._delegate_from == null;
          })
          .sort((a, b) => {
            const rank = (row) => row.end_reason === 'compression' ? 0 : (row.ended_at == null ? 1 : 2);
            const rankDelta = rank(a) - rank(b);
            if (rankDelta !== 0) return rankDelta;
            const activityDelta = hermesSessionActivityScore(b.activity_at) - hermesSessionActivityScore(a.activity_at);
            if (activityDelta !== 0) return activityDelta;
            const startedDelta = hermesSessionActivityScore(b.started_at) - hermesSessionActivityScore(a.started_at);
            if (startedDelta !== 0) return startedDelta;
            return String(b.id).localeCompare(String(a.id));
          });
        if (!children.length) return current;
        current = String(children[0].id);
      }
      return current;
    } catch {
      return current;
    } finally {
      try { hdb?.close(); } catch {}
    }
  }

  function repairHermesStoredSessionIds() {
    const cleared = [];
    const cache = new Map();
    const homeForProject = (projectId) => {
      if (cache.has(projectId)) return cache.get(projectId);
      const project = stmts.getProjectById.get(projectId);
      const home = ensureHermesHomeForProject(project);
      cache.set(projectId, home);
      return home;
    };
    const conversationRows = db
      .prepare(
        `SELECT conversations.id, conversations.session_id, tasks.project_id
         FROM conversations
         JOIN tasks ON tasks.id = conversations.task_id
         WHERE conversations.agent = 'hermes'
           AND conversations.session_id IS NOT NULL`
      )
      .all();
    for (const row of conversationRows) {
      const home = homeForProject(row.project_id);
      const problem = hermesSessionResumeProblem(home, row.session_id);
      if (!problem) continue;
      stmts.setConversationSessionId.run(null, row.id);
      cleared.push(`conversation:${row.id}:${problem}`);
    }

    const variantRows = db
      .prepare(
        `SELECT variants.id, variants.session_id, worktrees.project_id
         FROM variants
         JOIN worktrees ON worktrees.id = variants.worktree_id
         WHERE variants.agent = 'hermes'
           AND variants.session_id IS NOT NULL`
      )
      .all();
    for (const row of variantRows) {
      const home = homeForProject(row.project_id);
      const problem = hermesSessionResumeProblem(home, row.session_id);
      if (!problem) continue;
      stmts.setVariantSessionId.run(null, row.id);
      cleared.push(`variant:${row.id}:${problem}`);
    }

    if (cleared.length) {
      console.log(
        `[ace] hermes resume repair: cleared ${cleared.length} invalid stored Hermes session id(s): ${cleared.slice(0, 8).join(', ')}${cleared.length > 8 ? ', ...' : ''}`
      );
    }
    return cleared.length;
  }

  // Generic profile→home resolver injected into the Hermes Desktop manager
  // (see electron/hermes-dashboard.cts resolveProfileHome). The embedded
  // Profiles chat connects by profile NAME; for a builtin-personal operator
  // the backend must open that identity's real per-identity home (the
  // project-row-derived hermes-home-prj-<id>, or an explicit
  // OperatorProfile.hermesHome override) — NOT the empty $HERMES_HOME/
  // profiles/<name>/ re-root the CLI's `--profile` flag would create.
  // Resolution does NOT require hermesHome to be set in operators.json: the
  // project row already names the home, and gating on the config field meant
  // a config edit could silently dump an identity back into the empty
  // re-root. Returns the resolved home, or null whenever the profile is not
  // an exact builtin-personal operator id, or no per-identity home is
  // derivable (no project row and no explicit hermesHome) — every null keeps
  // the manager's legacy `--profile` behavior byte-identical. Nothing here is
  // identity-specific: it reads operators.json + ace.db only.
  function resolveOperatorProfileHome(profileName) {
    const raw = typeof profileName === 'string' ? profileName.trim() : '';
    if (!raw) return null;
    if (raw.startsWith('lane:')) return null;
    const rawLower = raw.toLowerCase();
    const id = operatorsLib.normalizeOperatorId(operatorsConfig, raw);
    let op = null;
    let project = null;
    // normalizeOperatorId falls back to defaultOperatorId for UNKNOWN names —
    // and the default operator can itself be builtin-personal. An ad-hoc
    // Hermes profile ('alice') must never resolve into the default identity's
    // home (a second process on that identity's state.db). If operators.json
    // is stale/missing, an exact ace.db personal_identity row is still
    // authoritative for migrated personal lanes such as King/Rook.
    if (id.toLowerCase() === rawLower) {
      op = operatorsLib.getOperator(operatorsConfig, id);
      // Only builtin-personal operators re-route to a per-identity home;
      // everyone else keeps the `--profile` re-root path unchanged.
      if (op && op.providerKind !== 'builtin-personal') return null;
    }
    try {
      project = db
        .prepare(
          `SELECT * FROM projects
           WHERE is_personal = 1
             AND LOWER(COALESCE(personal_identity, '')) = ?
           ORDER BY id LIMIT 1`
        )
        .get(rawLower);
    } catch {
      project = null;
    }
    if (!op && !project) return null;
    const explicitHome =
      typeof op?.hermesHome === 'string' && op.hermesHome.trim() ? op.hermesHome.trim() : null;
    // Without a project row there is no derivable per-identity home; only an
    // explicit OperatorProfile.hermesHome may still re-route (the legacy
    // configured shape). This keeps fresh identities — and any spawn that
    // races a transient db error — on the byte-identical `--profile` path
    // instead of minting a hermes-home-<opId> directory that would silently
    // diverge from the hermes-home-prj-<id> the project row later derives.
    if (!project && !explicitHome) return null;
    // Probe with the PURE candidate path first: resolution must not create
    // directories or copy auth.json into a home the fall-through below will
    // never use. ensureHermesHomeForProject (which mkdirs + links + writes
    // config) runs only when we actually route there.
    const candidateHome =
      explicitHome || hermesHome.workspaceHermesHome(userDataPath, project.id);
    // Fail-closed non-empty invariant: never strand the owner's chats by
    // routing to an empty per-identity home while the `--profile` re-root
    // holds the real sessions. The re-root the legacy path WOULD have used is
    // $HERMES_HOME/profiles/<name>, where $HERMES_HOME is the resolved global
    // ~/.hermes (matches the manager's globalHermesHome default).
    // Platform-aware (matches the manager's globalHermesHome default):
    // %LOCALAPPDATA%\hermes on Windows, ~/.hermes on POSIX.
    const globalHome = hermesPaths.globalHermesHome();
    const profileId = op?.id || rawLower;
    const rerootHome = path.join(globalHome, 'profiles', profileId);
    const resolvedSize = hermesHomeStateDbSize(candidateHome);
    const rerootSize = hermesHomeStateDbSize(rerootHome);
    if (!hasHermesHomeStateDbEvidence(resolvedSize) && hasHermesHomeStateDbEvidence(rerootSize)) {
      // The per-identity home holds no dashboard-visible sessions but the
      // `--profile` re-root does — that re-root is where the owner's real
      // chats live. Fall through to the legacy `--profile` path (return null)
      // so the embedded Profiles surface opens the populated state.db instead
      // of an empty home. Metadata-only; we never delete or copy anything.
      console.warn(
        `[ace] hermes profile '${profileId}': per-identity home ${candidateHome} has no usable state.db but the --profile re-root ${rerootHome} does. Falling through to the --profile re-root so the populated chats render.`
      );
      return null;
    } else if (!hasHermesHomeStateDbEvidence(resolvedSize)) {
      console.warn(
        `[ace] hermes profile '${profileId}': per-identity home ${candidateHome} has no recorded dashboard sessions yet (state.db missing/empty). Using it instead of an empty --profile re-root.`
      );
    }
    // Routing decided: NOW materialize the home (mkdir, shared symlinks,
    // auth.json, SOUL.md, config.yaml with the identity's memory db). The
    // synthetic row keeps the explicit-home shape working without a project
    // row, exactly as before.
    return project
      ? ensureHermesHomeForProject(project)
      : ensureHermesHomeForProject({ id: profileId, personal_identity: profileId, is_personal: 1 });
  }

  function ensureHermesHomeForOwner({ project, lane, cwd }) {
    if (lane?.providerKind === 'hermes-profile' && lane.profileHome) {
      return hermesHome.ensureHermesProfileLaneHome(userDataPath, lane.id, {
        sourceProfileHome: lane.profileHome,
        terminalCwd: cwd || (project?.is_remote ? project?.remote_path : project?.path),
      });
    }
    return ensureHermesHomeForProject(project);
  }

  // Seed the bundled ace-cli skill into <baseHome>/skills/ once at boot
  // — every per-workspace HERMES_HOME symlinks skills/ from base, so this
  // single copy reaches every Hermes lane across every workspace.
  hermesHome.ensureBundledAceSkill(userDataPath);

  // One-time migration: when per-workspace HERMES_HOME shipped, every
  // stored Hermes session_id in ace.db became stale (the new
  // workspace state.db has no record of it → `--continue` would exit
  // non-zero → "Resume failed; clearing session and starting fresh"
  // banner on the first relaunch of every Hermes tab). Proactively clear
  // those stored ids once so the first launch is silent. Gated by a
  // marker file so we never run twice.
  try {
    const marker = path.join(userDataPath, '.hermes-home-migrated-v1');
    if (!fs.existsSync(marker)) {
      const cleared = db
        .prepare(
          `UPDATE conversations SET session_id = NULL
             WHERE session_id IS NOT NULL
               AND task_id IN (SELECT id FROM tasks WHERE primary_agent = 'hermes')`
        )
        .run();
      const variantsCleared = db
        .prepare(
          `UPDATE variants SET session_id = NULL
             WHERE session_id IS NOT NULL
               AND agent = 'hermes'`
        )
        .run();
      fs.writeFileSync(
        marker,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            conversationsCleared: cleared.changes,
            variantsCleared: variantsCleared.changes,
          },
          null,
          2
        )
      );
      if (cleared.changes || variantsCleared.changes) {
        console.log(
          `[ace] hermes-home migration: cleared ${cleared.changes} conversation + ${variantsCleared.changes} variant session ids (stale after per-workspace HERMES_HOME shipped)`
        );
      }
    }
  } catch (err) {
    console.warn('[ace] hermes-home migration failed:', err.message);
  }

  // One-time repair: old builds persisted the synthetic Hermes `seen` token for
  // Rook/King. In modern Hermes that maps to `--continue`, which resumes the
  // newest session in the identity's state.db, including background maintenance
  // sessions. Keep persistence exact: no generic latest-session token for Hermes.
  try {
    const marker = path.join(userDataPath, '.hermes-seen-cleared-v2');
    if (!fs.existsSync(marker)) {
      const cleared = db
        .prepare(
          `UPDATE conversations SET session_id = NULL
             WHERE agent = 'hermes'
               AND session_id = 'seen'`
        )
        .run();
      const variantsCleared = db
        .prepare(
          `UPDATE variants SET session_id = NULL
             WHERE agent = 'hermes'
               AND session_id = 'seen'`
        )
        .run();
      fs.writeFileSync(
        marker,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            conversationsCleared: cleared.changes,
            variantsCleared: variantsCleared.changes,
          },
          null,
          2
        )
      );
      if (cleared.changes || variantsCleared.changes) {
        console.log(
          `[ace] hermes resume repair: cleared ${cleared.changes} conversation + ${variantsCleared.changes} variant generic Hermes resume token(s)`
        );
      }
    }
  } catch (err) {
    console.warn('[ace] hermes resume repair failed:', err.message);
  }

  const streamStates = createStreamStateManager();

  // Hermes Desktop dashboard sidecar manager (electron/hermes-dashboard.cts).
  // Dormant until something calls hermesDesktopEnsure: with no running
  // dashboard there are no per-home claims and every PTY path behaves exactly
  // as before. Claims key ONLY on a live dashboard process — never on the
  // stored surface preference — so always-on Rook/King auto-start keeps
  // working until a dashboard actually owns their specific home.
  const hermesDashboards = createHermesDashboardManager({
    userDataPath,
    // Same Ace CLI transport contract as the PTY lane spawns (the extraEnv
    // block in the PTY start path): pin the main-process socket and, when
    // remote access is enabled, the auth-backed loopback HTTP transport.
    // baseEnv below is sanitizeAgentSpawnEnv-scrubbed (strips ACE_*), so
    // this is the only way embedded operator agents get a working `ace`
    // CLI — their exec sandbox denies AF_UNIX, leaving ACE_URL +
    // ACE_TOKEN as the usable transport. ACE_HOME re-injection keeps
    // the CLI's child registry on the external SSD when that root is active.
    aceTransportEnv: () => {
      const userDataTag = path.basename(userDataPath || 'Ace');
      const externalStorageEnv = externalDataRoot.externalStorageEnvForUserData(userDataPath);
      return {
        ACE_CALLER_INSTANCE_TAG: userDataTag,
        ACE_USER_DATA_TAG: userDataTag,
        ...localAgentAceTransportEnv({
          userDataPath,
          getRemoteSettings,
          findRemoteDeviceByHash,
          registerRemoteDevice,
        }),
        ...externalStorageEnv,
        ...(!externalStorageEnv.ACE_HOME && process.env.ACE_HOME
          ? { ACE_HOME: process.env.ACE_HOME }
          : {}),
      };
    },
    ensureHermesHome: (ownerKey: any) => {
      const project = stmts.getProjectById.get(String(ownerKey || ''));
      if (!project) throw new Error(`unknown workspace for hermes dashboard: ${ownerKey}`);
      if (project.is_remote) throw new Error('the Hermes Desktop surface is local-only');
      return ensureHermesHomeForProject(project);
    },
    // Generic profile→home routing for the embedded Profiles chat: maps a
    // profile NAME to its operator's configured per-identity home so the
    // backend opens the REAL state.db instead of an empty `--profile` re-root.
    // Returns null for every profile without a configured home (legacy path).
    resolveProfileHome: (profile: any) => resolveOperatorProfileHome(profile),
    whichHermes: resolveHermesBinaryPath,
    hermesCodeFingerprint,
    baseEnv: () => sanitizeAgentSpawnEnv(process.env),
    emit: (payload: any) => events.emit('hermes-desktop:event', payload),
    spawnImpl: (testHooks as any).hermesDashboardSpawnImpl,
    // Stop-then-claim: when a dashboard claims a home, kill any live hermes
    // PTY already writing it (mirrors the registry's duplicate-writer sweep).
    // `home` arrives realpath-normalized from the manager; normalize each
    // stream's hermesHomePath the same way so symlinked spellings (~/.hermes
    // on the SSD) still match. ptyRegistry is declared below — this callback
    // only runs on IPC ensure() calls, long after boot wiring completes.
    stopHermesPtyForHome: (home: any) => {
      let stopped = 0;
      for (const [otherId, other] of ptyRegistry.streams.entries()) {
        if (other.status === 'exited' || other.agent !== 'hermes') continue;
        if (!other.hermesHomePath) continue;
        let resolved = path.resolve(String(other.hermesHomePath));
        try { resolved = fs.realpathSync.native(resolved); } catch { /* not yet created */ }
        if (resolved !== home) continue;
        events.emit('pty:data', {
          id: otherId,
          chunk: '\x1b[33m[ace] Lane paused — the Hermes Desktop surface owns this home. Restart the lane from the Agents tab after closing it.\x1b[0m\r\n',
        });
        ptyRegistry.killStream(otherId);
        events.emit('pty:exit', { id: otherId, code: 0 });
        stopped += 1;
      }
      return stopped;
    },
  });

  // Canonical home-chat policy for the resident operator bubble
  // (electron/hermes-home-chat.cts): explicit-id home restore after the
  // partition-hygiene clear wipes the SPA's remembered session, plus the
  // exactly-once cron → home-chat delivery relay. All sidecar access rides
  // appConnection() — the sidecar stays the only state.db writer; the
  // delivery ledger lives under Ace's own userData, never inside a
  // HERMES_HOME.
  const hermesHomeChat = createHomeChatController({
    connection: (profile: any) => hermesDashboards.appConnection(profile),
    ledgerPath: path.join(userDataPath, 'hermes-desktop-sidecar', 'cron-home-delivery.json'),
  });

  // With detached mode OFF there is no host client to ask, so the survivor
  // sweep's own result is the only record of which lanes a legacy host held.
  // Restoration awaits it: relaunching a lane still alive in an unretired host
  // would put a second agent on its transcript, and a lane the sweep DID kill
  // needs the same interruption notice a detached retirement gives.
  let legacyHostSweep: Promise<any> | null = null;
  // True when the sweep could not determine whether a legacy host survives. No
  // lane may start or resume on that evidence — a later launch settles it.
  let legacySweepUnknown = false;
  // Lanes the detached-off sweep dealt with. Its client is discarded as soon as
  // it finishes, so its findings are latched here the moment it resolves.
  const sweptRetiredIds = new Set<string>();
  const sweptBlockedIds = new Set<string>();
  // Retiring an outdated pty-host kills its CLIs; only a lane with a CONCRETE
  // persisted session id comes back (planResume turns a codex 'seen' sentinel
  // into a fresh session, which would lose the transcript). Shared by BOTH host
  // clients below — the detached one and the survivor-sweep one — because either
  // can be the path that retires a legacy daemon.
  const isLaneResumable = (streamId: any) => {
    try {
      const owner = resolveStreamOwner(streamId);
      if (!owner) return true; // not a lane we own; nothing of ours to lose
      const sid = owner.sessionId;
      if (!sid || sid === 'seen' || sid === 'live') return false;
      // A concrete id is not enough: planResume also requires the CLI's session
      // file to be THERE, and treats a definitively absent one as stale — which
      // would start a fresh session and lose the live lane's work. Remote lanes
      // authenticate and resume on their own host, so the local file test does
      // not apply to them.
      if (owner.project?.is_remote) return true;
      const provider = getProvider(owner.agent);
      const file = provider ? resolveSessionFile(provider, owner.cwd, sid) : null;
      if (!file) {
        // Mirror planResume exactly: a provider that REQUIRES a session file and
        // whose file we cannot even resolve (a Codex rollout under a custom
        // CODEX_HOME, say) does not plain-resume — planResume rebinds or starts
        // fresh, so killing the live CLI could abandon its real transcript.
        // Only a token-style CLI, which needs no path, keeps the id-only answer.
        return !provider?.resume?.requiresSessionFile;
      }
      // Only a DEFINITIVE absence disqualifies it: 'unknown' is the external
      // volume racing the check, and planResume resumes on that too.
      return sessionFileState(file) !== 'absent';
    } catch {
      // Unverified is NOT resumable: answering "yes" here is how a live lane
      // gets killed with no transcript to come back to.
      return false;
    }
  };

  let handleLocalStreamExit = null;
  // Narrow test seam: lets a test drive the REAL sweep/latch branches below with
  // a stub client, instead of injecting testHooks.ptyHost — which selects the
  // detached branch and would leave the detached-off sweep untested.
  const makePtyHostClient = (opts: any) =>
    typeof (testHooks as any).ptyHostClientFactory === 'function'
      ? (testHooks as any).ptyHostClientFactory(opts)
      : ptyHostLib.createPtyHostClient(opts);
  // Detached PTY host: claude/codex agent tabs spawn inside a small external
  // process that outlives the app, so a quit/restart/crash no longer kills
  // in-flight agents — boot adopts them back (restoreAgentStreams below).
  let ptyHost: any = null;
  if ((testHooks as any).ptyHost) {
    ptyHost = (testHooks as any).ptyHost;
  } else if (detachedAgentStreamsEnabled() && !(testHooks as any).ptyImpl) {
    try {
      ptyHost = makePtyHostClient({ userDataPath, isLaneResumable });
    } catch (err) {
      console.warn('[ace] pty-host client unavailable:', err?.message || err);
    }
  } else if (!(testHooks as any).ptyImpl || (testHooks as any).ptyHostClientFactory) {
    // (A fake ptyImpl normally means a unit test that wants no host at all; an
    // injected client factory is the exception — it exists to drive this branch.)
    // Detached mode is OFF, so this launch keeps no host client. A daemon
    // PRESERVED by an earlier launch does not exit while it holds stream
    // records, though — and if it predates this build it is still running the
    // code we replaced, credential gateway and TCP listener included. Connect
    // once, purely to retire it, then drop the client.
    const sweepOnce = async () => {
      let retirer: any = null;
      try {
        // Same resumability rule as the detached client: this sweep can retire a
        // legacy host too, so it must not destroy a lane Ace cannot bring back.
        retirer = makePtyHostClient({ userDataPath, isLaneResumable });
        // Survivor-only: never spawns a daemon this launch does not want. A
        // current host is left alone; an outdated one is killed outright.
        return await retirer.retireOutdatedSurvivor();
      } finally {
        try { retirer?.close(); } catch {}
      }
    };
    legacyHostSweep = (async () => {
      try {
        const result = await sweepOnce();
        if (result.outcome === 'retired') console.log('[ace] retired an outdated pty-host left by a previous version');
        else if (result.outcome === 'blocked') console.warn('[ace] an outdated pty-host survives and could not be retired');
        else if (result.outcome === 'kept' && result.blocked.length) {
          console.warn(
            `[ace] ${result.blocked.length} lane(s) are running in a pty-host this launch does not adopt (detached mode off); not relaunching them`
          );
        }
        return result;
      } catch (err: any) {
        console.warn('[ace] outdated pty-host sweep failed; retrying once:', err?.message || err);
        try {
          // A second look answers the only question that matters cheaply: is a
          // daemon there at all? 'none' turns "unknown" into proven absence.
          return await sweepOnce();
        } catch (err2: any) {
          console.warn('[ace] outdated pty-host sweep failed again:', err2?.message || err2);
          // We genuinely cannot tell whether a legacy host is holding lanes.
          // Fail closed: nothing starts or resumes until a launch can tell.
          return { outcome: 'unknown', retired: [], blocked: [] };
        }
      }
    })();
    // Latch on RESOLVE, not at the delayed restore: the renderer can ask for a
    // lane long before that pass runs, and a guard reading an empty set then
    // would spawn beside a survivor (or skip an interrupted lane's notice).
    legacyHostSweep
      .then((swept: any) => {
        for (const id of swept?.retired || []) sweptRetiredIds.add(id);
        for (const id of swept?.blocked || []) sweptBlockedIds.add(id);
        legacySweepUnknown = swept?.outcome === 'unknown';
      })
      .catch(() => { legacySweepUnknown = true; });
  }
  const ptyRegistry = createPtyRegistry(events, streamStates, {
    onExitIntercept: (id, code, stream) =>
      handleLocalStreamExit ? handleLocalStreamExit(id, code, stream) : false,
    isHermesHomeClaimed: (home: any) => hermesDashboards.isHomeClaimed(home),
    ptyHost,
    // A lane still alive inside an outdated pty-host we could not retire: the
    // spawn path must refuse it, or it puts a second agent on a live transcript.
    isLaneBlockedByLegacyHost: (streamId: any) => blockedLaneIds().has(streamId),
  }, {
    ptyImpl: testHooks.ptyImpl,
    verifyClaudeSubscriptionAuth: testHooks.verifyClaudeSubscriptionAuth,
  });
  const localAgents = detectLocalAgents();

  // agent_resume_state tracks which local claude/codex agent tabs are running
  // RIGHT NOW. Rows are removed on a real PTY exit or explicit kill, but never
  // on app shutdown — so after a restart the surviving rows are exactly the
  // agents to bring back (adopt from the pty-host, or relaunch with --resume).
  const resumeStateStmts = {
    upsert: db.prepare(
      `INSERT INTO agent_resume_state (stream_id, cols, rows, launch_intent, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET cols=excluded.cols, rows=excluded.rows, launch_intent=excluded.launch_intent, updated_at=excluded.updated_at`
    ),
    remove: db.prepare('DELETE FROM agent_resume_state WHERE stream_id=?'),
    get: db.prepare('SELECT * FROM agent_resume_state WHERE stream_id=?'),
    list: db.prepare('SELECT * FROM agent_resume_state ORDER BY updated_at ASC'),
    // Audit + own-history feed (see stream_session_history in SCHEMA).
    recordHistory: db.prepare(
      `INSERT INTO stream_session_history (stream_id, provider, cwd, session_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    // The distinct session ids THIS stream bound in THIS cwd, newest first.
    // `cwd IS ?` is NULL-safe so a null cwd still matches its own rows.
    ownHistory: db.prepare(
      `SELECT session_id, MAX(created_at) AS ts FROM stream_session_history
       WHERE stream_id=? AND cwd IS ? AND session_id IS NOT NULL AND session_id != 'seen'
       GROUP BY session_id ORDER BY ts DESC`
    ),
  };

  // The launch intent restored for `streamId` from agent_resume_state, driving
  // its capability classification after a restart. `null` (interactive, full
  // capability) is returned ONLY for the two states that positively prove the
  // lane was interactive: a missing row, or the exact interactive sentinel.
  // EVERYTHING ELSE fails closed to a worker (keeps the strip) — the security
  // property is worker isolation, so an unreadable row, malformed/nonconforming
  // persisted value, or a NULL (pre-migration legacy) row must never restore a
  // worker with full MCP/plugin/connector capability:
  //   - the interactive sentinel                     -> null
  //   - no row at all                                 -> null
  //   - a persisted worker intent (JSON w/ delegated) -> that intent
  //   - NULL launch_intent (legacy pre-migration row) -> { delegated: true }
  //   - malformed JSON / a read failure / any JSON that does not classify as a
  //     worker                                        -> { delegated: true }
  // A legacy/failed-closed interactive lane regains full capability on its next
  // fresh spawn (a new intent is minted), one respawn away.
  function restoredLaneClassification(streamId: any) {
    let row: any;
    try {
      row = resumeStateStmts.get.get(streamId);
    } catch {
      // Can't read the row -> can't prove it was interactive -> fail closed.
      return { delegated: true };
    }
    if (!row) return null;
    const raw = row.launch_intent;
    if (raw === RESUME_STATE_INTERACTIVE_MARKER) return null;
    if (raw == null) return { delegated: true };
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { delegated: true };
    }
    // Only a value that still classifies as a worker is trusted; a conforming
    // persisted intent always carries the delegated marker, so anything that
    // reads as interactive is nonconforming and fails closed.
    return laneIsInteractiveLane({ launchIntent: parsed }) ? { delegated: true } : parsed;
  }

  function recordAgentResumeState(streamId: any, cols: any, rows: any) {
    try {
      // Snapshot the lane's capability classification from its retained spawn
      // intent so it survives the restart (see laneWorkerClassificationIntent).
      // Interactive lanes persist an EXPLICIT marker, never NULL, so that a NULL
      // column value unambiguously means a pre-migration legacy row.
      const cls = laneWorkerClassificationIntent(ptyRegistry.getStream(streamId)?.launchIntent);
      const launchIntentValue = cls ? JSON.stringify(cls) : RESUME_STATE_INTERACTIVE_MARKER;
      resumeStateStmts.upsert.run(streamId, cols | 0, rows | 0, launchIntentValue, new Date().toISOString());
    } catch {}
  }

  function clearAgentResumeState(streamId: any) {
    try {
      resumeStateStmts.remove.run(streamId);
    } catch {}
  }

  // A real PTY exit means there is nothing to bring back at the next boot.
  // (Shutdown tears streams down without emitting pty:exit, so rows survive.)
  events.on('pty:exit', ({ id }: any) => clearAgentResumeState(id));

  const persistentHermesRestartState = new Map();

  function persistentHermesRestartClaim(streamId) {
    const now = Date.now();
    const current = persistentHermesRestartState.get(streamId);
    const state = current && now - current.windowStartedAt < 60_000
      ? current
      : { windowStartedAt: now, count: 0 };
    if (state.count >= 3) return null;
    state.count += 1;
    persistentHermesRestartState.set(streamId, state);
    return { attempt: state.count };
  }

  function isPersistentHermesStream(streamId) {
    const owner = resolveStreamOwner(streamId);
    if (!owner || owner.kind === 'shell') return false;
    if (String(owner.agent || '').toLowerCase() !== 'hermes') return false;
    if (owner.agentLane?.autoStart) return true;
    if (owner.kind !== 'conversation') return false;
    const conv = db.prepare('SELECT task_id FROM conversations WHERE id=?').get(owner.id);
    const task = conv ? stmts.getTaskById.get(conv.task_id) : null;
    const project = owner.project || (task ? stmts.getProjectById.get(task.project_id) : null);
    if (!task || !project) return false;
    if (!isOrchestratorTaskRow(task)) return false;
    if (!project.always_on_orchestrator) return false;
    const alwaysOnAgent = String(project.always_on_agent || 'hermes').toLowerCase();
    return alwaysOnAgent === 'hermes';
  }

  function maybeRelaunchPersistentHermesStream(streamId, code, stream) {
    if (code === 0) return false;
    if (!isPersistentHermesStream(streamId)) return false;
    const claim = persistentHermesRestartClaim(streamId);
    if (!claim) {
      events.emit('pty:data', {
        id: streamId,
        chunk:
          '\x1b[31m[ace] Persistent Hermes lane exited repeatedly; leaving it stopped to avoid a restart loop.\x1b[0m\r\n',
      });
      return false;
    }
    const dims = {
      cols: stream?.cols || 120,
      rows: stream?.rows || 40,
    };
    events.emit('pty:data', {
      id: streamId,
      chunk: `\x1b[33m[ace] Persistent Hermes lane exited; relaunching (attempt ${claim.attempt}/3)…\x1b[0m\r\n`,
    });
    setTimeout(() => {
      void ensureStreamStarted({ streamId, cols: dims.cols, rows: dims.rows }).catch((err) => {
        events.emit('pty:data', {
          id: streamId,
          chunk: `\x1b[31m[ace] Persistent Hermes relaunch failed: ${err.message}\x1b[0m\r\n`,
        });
        events.emit('pty:exit', { id: streamId, code: -1 });
      });
    }, 1000);
    return true;
  }

  function maybeRelaunchPersistentRemoteHermesStream(streamId, code, existing) {
    if (code === 0) return false;
    if (!isPersistentHermesStream(streamId)) return false;
    const claim = persistentHermesRestartClaim(streamId);
    if (!claim) {
      events.emit('pty:data', {
        id: streamId,
        chunk:
          '\x1b[31m[ace] Persistent remote Hermes lane exited repeatedly; leaving it stopped to avoid a restart loop.\x1b[0m\r\n',
      });
      return false;
    }
    const dims = {
      cols: existing?.cols || 120,
      rows: existing?.rows || 40,
    };
    events.emit('pty:data', {
      id: streamId,
      chunk: `\x1b[33m[ace] Persistent remote Hermes lane exited; relaunching (attempt ${claim.attempt}/3)…\x1b[0m\r\n`,
    });
    setTimeout(() => {
      relaunchRemoteStream(streamId, dims, { dropAutoApprove: false, dropResume: false, launchIntent: existing?.launchIntent }).catch((err) => {
        events.emit('pty:data', {
          id: streamId,
          chunk: `\x1b[31m[ace] Persistent remote Hermes relaunch failed: ${err.message}\x1b[0m\r\n`,
        });
        events.emit('pty:exit', { id: streamId, code: -1 });
      });
    }, 1000);
    return true;
  }


  const remoteAgentCache = new Map();
  const sshDaemons = testHooks.sshDaemons || new SshDaemonManager();







  const remoteStreams = new Map();
  const daemonPtyToStream = new Map();

  function daemonPtyKey(host, agentUser, ptyId) {
    return `${host}::${agentUser || 'root'}::${ptyId}`;
  }

  function attachDaemonEvents(host, agentUser, daemon) {
    if (daemon._aceWired) return;
    daemon._aceWired = true;
    daemon.on('pty.data', ({ id, data }) => {
      const streamId = daemonPtyToStream.get(daemonPtyKey(host, agentUser, id));
      if (!streamId) return;
      const chunk = Buffer.from(data || '', 'base64').toString('utf8');
      const existing = remoteStreams.get(streamId);
      if (existing?.agent === 'claude' && !existing.claudeApiBillingBlocked) {
        existing.claudeStartupAuthDetector ||= claudeAuthPolicy.createClaudeStartupAuthDetector();
        if (existing.claudeStartupAuthDetector.push(chunk) === 'api') {
          existing.claudeApiBillingBlocked = true;
          streamStates.pump(
            streamId,
            claudeAuthPolicy.CLAUDE_API_BILLING_BLOCK_MESSAGE,
            ({ seq, rewritten }) => events.emit('pty:data', { id: streamId, chunk: rewritten, seq })
          );
          try { daemon.killPty(id); } catch {}
          return;
        }
      }
      streamStates.pump(streamId, chunk, ({ seq, rewritten }) => {
        events.emit('pty:data', { id: streamId, chunk: rewritten, seq });
      });
    });
    daemon.on('pty.exit', ({ id, code }) => {
      const key = daemonPtyKey(host, agentUser, id);
      const streamId = daemonPtyToStream.get(key);
      if (!streamId) return;
      const existing = remoteStreams.get(streamId);
      daemonPtyToStream.delete(key);
      remoteStreams.delete(streamId);

      if (existing?.claudeApiBillingBlocked) {
        events.emit('pty:exit', { id: streamId, code });
        return;
      }











      const fastExit =
        existing &&
        Date.now() - existing.startedAt < 6000 &&
        (code === null || code !== 0);
      if (fastExit && existing.retryable) {
        const dims = { cols: existing.cols, rows: existing.rows };
        events.emit('pty:data', {
          id: streamId,
          chunk:
            '\x1b[33m[ace] Claude refused the auto-approve flag; retrying without it…\x1b[0m\r\n',
        });
        setImmediate(() => {
          relaunchRemoteStream(streamId, dims, { dropAutoApprove: true, dropResume: false, launchIntent: existing.launchIntent }).catch((err) => {
            events.emit('pty:data', {
              id: streamId,
              chunk: `\x1b[31m[ace] retry failed: ${err.message}\x1b[0m\r\n`,
            });
            events.emit('pty:exit', { id: streamId, code: -1 });
          });
        });
        return;
      }
      if (fastExit && existing.resumeMode === 'resume') {
        const dims = { cols: existing.cols, rows: existing.rows };
        events.emit('pty:data', {
          id: streamId,
          chunk:
            '\x1b[33m[ace] Resume failed; clearing session and starting fresh…\x1b[0m\r\n',
        });
        setImmediate(() => {
          relaunchRemoteStream(streamId, dims, { dropAutoApprove: false, dropResume: true, launchIntent: existing.launchIntent }).catch((err) => {
            events.emit('pty:data', {
              id: streamId,
              chunk: `\x1b[31m[ace] fresh relaunch failed: ${err.message}\x1b[0m\r\n`,
            });
            events.emit('pty:exit', { id: streamId, code: -1 });
          });
        });
        return;
      }
      if (maybeRelaunchPersistentRemoteHermesStream(streamId, code, existing)) return;
      events.emit('pty:exit', { id: streamId, code });
    });
    daemon.on('closed', () => {



      const prefix = `${host}::${agentUser || 'root'}::`;
      for (const [key, streamId] of Array.from(daemonPtyToStream.entries())) {
        if (key.startsWith(prefix)) {
          daemonPtyToStream.delete(key);
          remoteStreams.delete(streamId);
          streamStates.remove(streamId);
          events.emit('pty:exit', { id: streamId, code: -1 });
        }
      }
    });
  }

  function daemonFor(host, agentUser = null) {
    const d = sshDaemons.get(host, agentUser);
    attachDaemonEvents(host, agentUser, d);
    return d;
  }

  async function verifyRemoteClaudeSubscriptionAuth(daemon: any, cwd: any, env: any) {
    // A remote setup token commonly comes from the remote login shell rather
    // than Ace's env array. Probe presence without printing the token so the
    // shared classifier can distinguish supported first-party OAuth from API
    // console auth using the same contract as local launches.
    const setupTokenProbe = await daemon.exec({
      cmd: 'sh',
      args: ['-c', 'test -n "${CLAUDE_CODE_OAUTH_TOKEN:-}"'],
      cwd,
      env,
      loginShell: true,
      timeoutMs: 5000,
    });
    const authCommand = claudeAuthPolicy.wrapClaudeSubscriptionCommand(
      getProvider('claude')?.cli || 'claude',
      ['auth', 'status', '--json']
    );
    const probe = await daemon.exec({
      cmd: authCommand.cmd,
      args: authCommand.args,
      cwd,
      env,
      loginShell: true,
      timeoutMs: 15000,
    });
    // Logged out is exit 1 and nothing else; any other nonzero exit proves
    // nothing about auth and must not authorize.
    const classified = claudeAuthPolicy.classifyClaudeSubscriptionAuthStatus(probe?.stdout, {
      hasSetupToken: setupTokenProbe?.code === 0,
    });
    const acceptsLoggedOut =
      probe?.code === claudeAuthPolicy.CLAUDE_LOGGED_OUT_EXIT_CODE &&
      claudeAuthPolicy.isClaudeLoggedOutAuthResult(classified);
    const auth = probe?.code === 0 || acceptsLoggedOut
      ? classified
      : {
          ok: false,
          reason: claudeAuthPolicy.describeClaudeAuthProbeFailure(
            { code: probe?.code },
            probe?.stderr
          ),
        };
    // Both callers gate an interactive startPty — same rule as a local lane.
    if (!auth?.ok && claudeAuthPolicy.isClaudeLoggedOutAuthResult(auth)) {
      console.warn('[ace] remote claude lane starting signed out; the CLI will prompt for /login');
      return auth;
    }
    if (!auth?.ok) throw claudeAuthPolicy.claudeSubscriptionAuthError(auth);
    return auth;
  }



  function resolveTaskCwdForWatcher(taskId) {
    const wt = db.prepare('SELECT * FROM worktrees WHERE task_id=?').get(taskId);
    if (wt) return wt.path;
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) return null;
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id);
    return project?.path ?? null;
  }
  const gitWatcher = createGitWatcher(events, resolveTaskCwdForWatcher, { gitStatus, gitCurrentBranch });




  function resolveRemoteTaskInfo(taskId) {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) return null;
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id);
    if (!project || !project.is_remote || !project.ssh_host) return null;
    const wt = db.prepare('SELECT * FROM worktrees WHERE task_id=? LIMIT 1').get(taskId);
    const cwd = wt ? wt.path : project.remote_path;
    if (!cwd) return null;
    return {
      sshHost: project.ssh_host,
      agentUser: project.agent_user ?? null,
      cwd,
    };
  }

  const remoteGitPoller = createRemoteGitPoller(
    events,
    resolveRemoteTaskInfo,
    (host, agentUser) => daemonFor(host, agentUser)
  );



  // Coalesce the high-frequency state:invalidate storm. Git-index watchers fire
  // on every commit/stage and the remote poller every few seconds; each emitState()
  // rebuilds the FULL ~4000-row snapshot (incl. the append-only mission_events log)
  // synchronously on the main thread and broadcasts it to every renderer + WS
  // client. Un-throttled, a busy workspace fires this several times a second,
  // wedging the event loop (the measured lag + Hermes-webview-hang cause). This is
  // a leading+trailing throttle: an isolated invalidate emits immediately; a burst
  // collapses to at most one extra trailing emit per window, and the final state is
  // always delivered. Direct emitState() calls after user mutations stay immediate.
  const STATE_INVALIDATE_COALESCE_MS = 500;
  let stateInvalidateDirty = false;
  let stateInvalidateTimer: any = null;
  const flushStateInvalidate = () => {
    if (!stateInvalidateDirty) {
      stateInvalidateTimer = null;
      return;
    }
    stateInvalidateDirty = false;
    try {
      emitState();
    } catch {}
    stateInvalidateTimer = setTimeout(flushStateInvalidate, STATE_INVALIDATE_COALESCE_MS);
  };
  events.on('state:invalidate', () => {
    perfHealth.recordSpan({
      source: 'main',
      name: 'core.stateInvalidate',
      durationMs: 0,
      meta: { coalesced: !!stateInvalidateTimer },
    });
    if (stateInvalidateTimer) {
      stateInvalidateDirty = true;
      return;
    }
    try {
      emitState();
    } catch {}
    stateInvalidateTimer = setTimeout(flushStateInvalidate, STATE_INVALIDATE_COALESCE_MS);
  });

  const stmts = {
    insertProject: db.prepare(
      `INSERT INTO projects (id, name, path, is_remote, ssh_host, ssh_user, remote_path, agent_user, original_owner, default_branch, github_repo, initialized, order_index, created_at, updated_at)
       VALUES (@id, @name, @path, @is_remote, @ssh_host, @ssh_user, @remote_path, @agent_user, @original_owner, @default_branch, @github_repo, @initialized, COALESCE((SELECT MAX(order_index) + 1 FROM projects), 0), @created_at, @updated_at)`
    ),
    updateProject: db.prepare(
      `UPDATE projects SET name=@name, default_branch=@default_branch, github_repo=@github_repo, initialized=@initialized, updated_at=@updated_at WHERE id=@id`
    ),
    updateProjectDefaultBranch: db.prepare(
      `UPDATE projects SET default_branch=@default_branch, updated_at=@updated_at WHERE id=@id`
    ),
    updateProjectPreferredBaseBranch: db.prepare(
      `UPDATE projects SET preferred_base_branch=@preferred_base_branch, updated_at=@updated_at WHERE id=@id`
    ),
    deleteProject: db.prepare('DELETE FROM projects WHERE id=?'),
    getProjectByPath: db.prepare('SELECT * FROM projects WHERE path=?'),
    getProjectById: db.prepare('SELECT * FROM projects WHERE id=?'),

    insertTask: db.prepare(
      `INSERT INTO tasks (id, project_id, kind, name, primary_agent, is_multi_agent, initial_prompt, auto_approve, task_type, order_index, archived_at, created_at, updated_at)
       VALUES (@id, @project_id, @kind, @name, @primary_agent, @is_multi_agent, @initial_prompt, @auto_approve, @task_type, COALESCE((SELECT MAX(order_index) + 1 FROM tasks WHERE project_id=@project_id AND archived_at IS NULL), 0), NULL, @created_at, @updated_at)`
    ),
    updateTaskMultiAgent: db.prepare(
      `UPDATE tasks SET is_multi_agent=1, updated_at=@updated_at WHERE id=@id`
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id=?'),
    getTaskById: db.prepare('SELECT * FROM tasks WHERE id=?'),

    insertWorktree: db.prepare(
      `INSERT INTO worktrees (id, task_id, project_id, display_name, branch, base_branch, remote_base_ref, base_sha, local_base_sha, local_ahead_by, local_behind_by, branch_point, path, created_at)
       VALUES (@id, @task_id, @project_id, @display_name, @branch, @base_branch, @remote_base_ref, @base_sha, @local_base_sha, @local_ahead_by, @local_behind_by, @branch_point, @path, @created_at)`
    ),
    deleteWorktree: db.prepare('DELETE FROM worktrees WHERE id=?'),
    getWorktreeById: db.prepare('SELECT * FROM worktrees WHERE id=?'),
    getWorktreesByTask: db.prepare('SELECT * FROM worktrees WHERE task_id=?'),

    insertVariant: db.prepare(
      `INSERT INTO variants (id, worktree_id, task_id, name, agent, branch, review_mode, review_prompt, attached_at, order_index)
       VALUES (@id, @worktree_id, @task_id, @name, @agent, @branch, @review_mode, @review_prompt, @attached_at, @order_index)`
    ),
    deleteVariant: db.prepare('DELETE FROM variants WHERE id=?'),
    getVariantsByWorktree: db.prepare(
      'SELECT * FROM variants WHERE worktree_id=? ORDER BY order_index ASC, attached_at ASC'
    ),
    getVariantById: db.prepare('SELECT * FROM variants WHERE id=?'),
    setVariantSessionId: db.prepare('UPDATE variants SET session_id=? WHERE id=?'),
    setVariantOrderIndex: db.prepare('UPDATE variants SET order_index=? WHERE id=?'),
    setConversationOrderIndex: db.prepare(
      'UPDATE conversations SET display_order=? WHERE id=?'
    ),

    insertConversation: db.prepare(
      `INSERT INTO conversations (id, task_id, title, agent, kind, is_main, is_active, display_order, created_at, updated_at)
       VALUES (@id, @task_id, @title, @agent, @kind, @is_main, @is_active, @display_order, @created_at, @updated_at)`
    ),
    deactivateConversations: db.prepare(
      'UPDATE conversations SET is_active=0 WHERE task_id=?'
    ),
    activateConversation: db.prepare(
      'UPDATE conversations SET is_active=1, updated_at=? WHERE id=?'
    ),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id=?'),
    getConversationsByTask: db.prepare(
      'SELECT * FROM conversations WHERE task_id=? ORDER BY display_order ASC'
    ),
    countConversations: db.prepare(
      'SELECT COUNT(*) as n FROM conversations WHERE task_id=?'
    ),
    setConversationSessionId: db.prepare(
      'UPDATE conversations SET session_id=? WHERE id=?'
    ),
  };

  // Stored-session repair walks EVERY Hermes state.db (1GB-class files) with
  // synchronous sqlite opens. Running it inline here blocked the main thread
  // before the first window paint — the single largest boot cost. Defer it
  // past window load; a session id repaired a few seconds late only matters
  // the first time that conversation is resumed, and resume re-checks anyway.
  const hermesRepairTimer = setTimeout(() => {
    try {
      repairHermesStoredSessionIds();
    } catch (err) {
      console.warn('[ace] hermes stored-session repair failed:', err.message);
    }
  }, 3000);
  if (typeof hermesRepairTimer.unref === 'function') hermesRepairTimer.unref();



  const workspaceMetaCache = new Map();
  let workspaceMetaRefreshRun: Promise<void> | null = null;
  // Must OUTLIVE the 500ms state:invalidate coalesce window — at 250ms the
  // cache expired between coalesced emits and every emit rebuilt the ~4000-row
  // snapshot from scratch.
  const STATE_SNAPSHOT_CACHE_MS = 600;
  let cachedStateSnapshot: any = null;
  let cachedStateBuiltAt = 0;
  // Monotonic snapshot revision. Remote clients receive state over two
  // unordered transports (WS broadcasts + HTTP getState responses over the
  // tunnel), so a slow in-flight response can land AFTER a newer broadcast
  // and silently roll the client back — e.g. a just-created task vanishing
  // and bouncing the phone back to the spawn screen. Every rebuild gets a
  // strictly increasing rev (Date.now()-seeded so restarts stay monotonic
  // too) and clients drop snapshots older than the last one they applied.
  let stateRev = Date.now();

  // Tasks whose worktree checkout is running (or has failed) off the createTask
  // response path. taskId -> { state: 'preparing' | 'error', error?: string }.
  // Ephemeral by design: a mid-checkout restart clears it, leaving a
  // worktree-less task that serializes as 'idle' and is deletable — never a
  // persisted forever-'preparing' zombie. projectWorkspaces reads it via the
  // injected prepFor getter to stamp task.status/prepError.
  const taskPrep = new Map();

  function getState(options: any = {}) {
    const now = perfHealth.nowMs();
    const allowCache = options?.allowCache !== false;
    if (
      allowCache &&
      cachedStateSnapshot &&
      now - cachedStateBuiltAt <= STATE_SNAPSHOT_CACHE_MS
    ) {
      perfHealth.recordSpan({
        source: 'main',
        name: 'core.getState',
        durationMs: 0,
        meta: {
          cacheHit: true,
          ageMs: now - cachedStateBuiltAt,
          workspaces: cachedStateSnapshot.workspaces?.length || 0,
          missions: cachedStateSnapshot.missions?.length || 0,
        },
      });
      return cachedStateSnapshot;
    }

    const started = now;
    stateRev = Math.max(stateRev + 1, Date.now());
    const state = {
      version: 3,
      rev: stateRev,
      workspaces: projectWorkspaces(
        db,
        (taskId) => remoteGitPoller.getTaskTotals(taskId) ?? gitWatcher.getTaskTotals(taskId),
        workspaceMetaCache,
        (taskId) => taskPrep.get(taskId) ?? null,
      ),
      missions: projectMissions(db),
    };
    cachedStateSnapshot = state;
    cachedStateBuiltAt = perfHealth.nowMs();
    perfHealth.recordSpan({
      source: 'main',
      name: 'core.getState',
      durationMs: cachedStateBuiltAt - started,
      meta: {
        cacheHit: false,
        workspaces: state.workspaces.length,
        missions: state.missions.length,
        tasks: state.workspaces.reduce((n: number, w: any) => n + (w.tasks?.length || 0), 0),
        archivedTasks: state.workspaces.reduce((n: number, w: any) => n + (w.archivedTasks?.length || 0), 0),
      },
    });
    return state;
  }

  function listTrackedGithubProjects() {
    const workspaces = projectWorkspaceSummaries(db, workspaceMetaCache) || [];
    const projects = workspaces
      .filter((workspace) => workspace.githubRepo && !workspace.isPersonal)
      .map((workspace) => {
        const wikiPath = workspace.isRemote || !workspace.path
          ? null
          : path.join(workspace.path, '.ace', 'wiki', 'index.md');
        const activeTasks = (workspace.tasks || [])
          .filter((task) => task.status !== 'done')
          .map((task) => ({
            id: task.id,
            name: task.name,
            branch: task.branch,
            status: task.status,
            agent: task.agent,
            prNumber: task.prNumber,
            prStatus: task.prStatus,
          }));
        return {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspacePath: workspace.isRemote
            ? (workspace.remotePath || workspace.path || null)
            : (workspace.path || null),
          isRemote: !!workspace.isRemote,
          githubRepo: workspace.githubRepo,
          githubUrl: `https://github.com/${workspace.githubRepo}`,
          defaultBranch: workspace.defaultBranch || 'main',
          wikiPath,
          wikiExists: wikiPath ? fs.existsSync(wikiPath) : false,
          activeTasks,
          openPrs: workspace.openPrs || [],
        };
      })
      .sort((a, b) => a.githubRepo.localeCompare(b.githubRepo));
    return { projects };
  }

  const GH_PR_VIEW_FIELDS = 'number,url,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,baseRefOid,mergeable,statusCheckRollup,reviewDecision,isDraft';

  // gh can emit ANSI-wrapped JSON when it detects a TTY-ish environment (the
  // E2E proof caught exactly this: 'pr refresh failed: Unexpected token \x1b').
  // Suppress color AND parse tolerantly via pr-gate's parseGhJson.
  const GH_PLAIN_ENV = { GH_FORCE_TTY: '0', NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' };

  function ghPrViewJson(projectDir, ref) {
    const out = execFileSync('gh', ['pr', 'view', String(ref), '--json', GH_PR_VIEW_FIELDS], {
      cwd: projectDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...GH_PLAIN_ENV },
    });
    return parseGhJson(String(out || '{}'), {});
  }

  function normalizeGithubPrSeenState(pr) {
    const state = cleanMissionString(pr?.state)?.toUpperCase();
    if (state === 'MERGED' || pr?.mergedAt) return 'pr_merged';
    if (state === 'CLOSED') return 'pr_closed';
    if (pr?.isDraft === true) return 'pr_draft';
    if (state === 'OPEN') return 'pr_open';
    return null;
  }

  function applyMissionPrRefresh(mission, feature, pr) {
    const seenState = normalizeGithubPrSeenState(pr);
    const mergeCommit = pr?.mergeCommit?.oid || pr?.mergeCommit?.sha || pr?.mergeCommit || null;
    const gateDetail = [
      `pr refresh: ${seenState || pr?.state || 'unknown'}`,
      pr?.headRefOid ? `head=${pr.headRefOid}` : '',
      mergeCommit ? `merge=${mergeCommit}` : '',
    ].filter(Boolean).join(' ');
    db.prepare(
      `UPDATE mission_features
       SET pr_url=COALESCE(@pr_url, pr_url),
           pr_number=COALESCE(@pr_number, pr_number),
           pr_head_ref=COALESCE(@pr_head_ref, pr_head_ref),
           pr_base_ref=COALESCE(@pr_base_ref, pr_base_ref),
           pr_head_sha=COALESCE(@pr_head_sha, pr_head_sha),
           pr_base_sha=COALESCE(@pr_base_sha, pr_base_sha),
           last_seen_state=COALESCE(@last_seen_state, last_seen_state),
           gate_detail=COALESCE(@gate_detail, gate_detail)
       WHERE id=@id`
    ).run({
      id: feature.id,
      pr_url: cleanMissionString(pr?.url),
      pr_number: pr?.number != null ? Number(pr.number) : null,
      pr_head_ref: cleanMissionString(pr?.headRefName),
      pr_base_ref: cleanMissionString(pr?.baseRefName),
      pr_head_sha: cleanMissionString(pr?.headRefOid),
      pr_base_sha: cleanMissionString(pr?.baseRefOid),
      last_seen_state: seenState,
      gate_detail: gateDetail.slice(0, 4000),
    });
    return {
      ok: true,
      refreshed: true,
      missionId: mission.id,
      featureId: feature.id,
      pr: {
        number: pr?.number != null ? Number(pr.number) : null,
        url: pr?.url || null,
        state: pr?.state || null,
        mergedAt: pr?.mergedAt || null,
        mergeCommit,
        headRefOid: pr?.headRefOid || null,
        headRefName: pr?.headRefName || null,
        baseRefName: pr?.baseRefName || null,
        baseRefOid: pr?.baseRefOid || null,
        mergeable: pr?.mergeable || null,
        reviewDecision: pr?.reviewDecision || null,
        isDraft: pr?.isDraft === true,
        checksStatus: deriveChecksStatus(pr?.statusCheckRollup) || null,
      },
    };
  }

  function applyMissionPrRefreshFailure(mission, feature, err) {
    const message = err?.stderr?.toString?.() || err?.message || String(err);
    try {
      db.prepare(
        `UPDATE mission_features
         SET gate_detail=@gate_detail
         WHERE id=@id`
      ).run({
        id: feature.id,
        gate_detail: `pr refresh failed: ${String(message).slice(0, 3500)}`,
      });
    } catch {}
    return {
      ok: false,
      refreshed: false,
      missionId: mission.id,
      featureId: feature.id,
      staleStateWarning: true,
      error: String(message),
    };
  }

  function missionPrRefreshRef(input, feature) {
    return cleanMissionString(input.prNumber || feature.prNumber || extractMissionPrNumber(feature.prUrl) || input.prUrl || feature.prUrl);
  }

  function missionRefreshPrState(input = {}) {
    const { mission, feature } = findMissionFeature(input);
    const prRef = missionPrRefreshRef(input, feature);
    if (!prRef) {
      return { ok: false, refreshed: false, reason: 'no-linked-pr', missionId: mission.id, featureId: feature.id };
    }
    const projectDir = projectDirForMissionWorkspace(mission.workspaceId);
    try {
      return applyMissionPrRefresh(mission, feature, ghPrViewJson(projectDir, prRef));
    } catch (err) {
      return applyMissionPrRefreshFailure(mission, feature, err);
    }
  }

  function linkedPrRefreshCandidates(filters = {}) {
    const candidates = [];
    const filterWorkspaceId = cleanMissionString(filters.workspaceId || filters.projectId);
    const filterMissionId = cleanMissionString(filters.missionId);
    // activeOnly skips archived/terminal cards so background refresh never
    // re-polls gh for PRs that already reached pr_merged/pr_closed.
    const activeOnly = filters.activeOnly === true;
    // >= 0, not > 0 — an explicit 0 means "no refreshes", never unlimited.
    const maxRefreshes = Number.isFinite(Number(filters.maxRefreshes)) && Number(filters.maxRefreshes) >= 0
      ? Number(filters.maxRefreshes)
      : Infinity;
    for (const mission of projectMissions(db)) {
      if (filterWorkspaceId && mission.workspaceId !== filterWorkspaceId) continue;
      if (filterMissionId && mission.id !== filterMissionId) continue;
      for (const feature of mission.features || []) {
        if (!feature.prUrl && !feature.prNumber) continue;
        if (activeOnly && (
          feature.archivedAt ||
          feature.lastSeenState === 'pr_merged' ||
          feature.lastSeenState === 'pr_closed' ||
          feature.lastSeenState === 'archived' ||
          feature.cleanupEvidence
        )) continue;
        if (candidates.length >= maxRefreshes) return candidates;
        candidates.push({
          workspaceId: mission.workspaceId,
          missionId: mission.id,
          featureId: feature.id,
        });
      }
    }
    return candidates;
  }

  function refreshLinkedMissionPrStates(filters = {}) {
    return linkedPrRefreshCandidates(filters).map((candidate) => missionRefreshPrState(candidate));
  }

  function getMissionBoard(filters = {}) {
    if ((filters as any)?.refreshLinkedPrStates === true || (filters as any)?.refreshPrStates === true) {
      refreshLinkedMissionPrStates(filters);
    }
    cleanupMergedMissionCards();
    cleanupSupersededMissionCards(filters);
    const openPrsByWorkspace = {};
    const workspaceNamesById = {};
    const archivedTasksById = {};
    for (const [workspaceId, meta] of workspaceMetaCache.entries()) {
      openPrsByWorkspace[workspaceId] = meta?.openPrs ?? [];
    }
    try {
      const rows = db.prepare('SELECT id, name FROM projects').all();
      for (const row of rows) {
        if (row?.id && row?.name) workspaceNamesById[row.id] = row.name;
      }
    } catch {}
    const taskBranchesById = {};
    try {
      const rows = db
        .prepare('SELECT task_id, branch FROM worktrees WHERE branch IS NOT NULL')
        .all();
      for (const row of rows) {
        if (!row.task_id || !row.branch) continue;
        const list = taskBranchesById[row.task_id] ?? [];
        if (!list.includes(row.branch)) list.push(row.branch);
        taskBranchesById[row.task_id] = list;
      }
    } catch {}
    try {
      const rows = db
        .prepare('SELECT id, archived_at, archived_pr_url FROM tasks WHERE archived_pr_url IS NOT NULL')
        .all();
      for (const row of rows) {
        if (!row.id || !row.archived_pr_url) continue;
        archivedTasksById[row.id] = {
          archivedAt: row.archived_at || null,
          archivedPrUrl: row.archived_pr_url,
        };
      }
    } catch {}
    return projectMissionBoard(projectMissions(db), {
      ...filters,
      openPrsByWorkspace,
      workspaceNamesById,
      taskBranchesById,
      archivedTasksById,
    });
  }

  function cleanupSupersededMissionCards(filters = {}) {
    let board;
    try {
      board = projectMissionBoard(projectMissions(db), {
        ...filters,
        includeArchived: true,
      });
    } catch {
      return;
    }
    const rows = [];
    for (const mission of board.missions || []) {
      for (const card of mission.cards || []) {
        if (card.superseded && !card.archivedAt) {
          rows.push({
            missionId: card.missionId,
            featureId: card.id,
            name: card.name,
          });
        }
      }
    }
    if (!rows.length) return;

    const archivedAt = nowIso();
    const archiveFeature = db.prepare(
      `UPDATE mission_features
          SET archived_at=@archived_at,
              last_seen_state='superseded'
        WHERE id=@id AND archived_at IS NULL`
    );
    const tx = db.transaction((items) => {
      for (const row of items) {
        archiveFeature.run({ id: row.featureId, archived_at: archivedAt });
        recordMissionBoardEvent(
          row.missionId,
          MISSION_EVENT_TYPES.WORKER_ARCHIVED,
          `Archived superseded card ${row.featureId}`,
          'system',
          row.featureId
        );
      }
    });
    // Archiving superseded cards is a best-effort side-effect of the (read-only)
    // board path. If the operator disabled archival — a DB guard trigger that
    // RAISE(ABORT)s on archived_at writes, or a ACE_DISABLE_*_ARCHIVE toggle
    // — the write is blocked; that must never break mission board/ready/next
    // reads, so degrade quietly and leave the superseded cards in place.
    try {
      tx(rows);
    } catch {
      /* archival disabled by operator; reads continue unaffected */
    }
  }

  function cleanupMergedMissionCards() {
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT f.id AS feature_id,
                  f.mission_id,
                  f.name,
                  f.task_id,
                  f.pr_url,
                  f.completed_at,
                  f.validation_completed_at
             FROM mission_features f
             JOIN tasks t ON t.id = f.task_id
            WHERE f.task_id IS NOT NULL
              AND f.last_seen_state = 'pr_merged'
              AND (
                f.status != 'completed'
                OR f.completed_at IS NULL
                OR f.validation_status IS NULL
                OR f.gate_status IS NULL
              )`
        )
        .all();
    } catch {
      return;
    }
    if (!rows.length) return;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const completedAt = row.validation_completed_at || row.completed_at || nowIso();
        db.prepare(
          `UPDATE mission_features
              SET status = 'completed',
                  completed_at = COALESCE(completed_at, @completed_at),
                  validation_status = COALESCE(validation_status, 'validation_passed'),
                  gate_status = COALESCE(gate_status, 'merge_ready')
            WHERE id = @feature_id`
        ).run({ feature_id: row.feature_id, completed_at: completedAt });
      }
    });
    try {
      tx();
    } catch {
      return;
    }
    for (const row of rows) {
      try {
        recordMissionBoardEvent(
          row.mission_id,
          MISSION_EVENT_TYPES.NOTE,
          `${row.name || row.feature_id}: marked merged task ${row.task_id} complete`,
          'system',
          row.feature_id
        );
      } catch {}
    }
  }

  function projectDirForMissionWorkspace(workspaceId) {
    const id = String(workspaceId || '').trim();
    if (!id) return null;
    try {
      const row = stmts.getProjectById.get(id);
      return row?.path || null;
    } catch {
      return null;
    }
  }

  const nextMissionEventPosition = db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM mission_events WHERE mission_id=?'
  );
  const insertMissionEvent = db.prepare(
    `INSERT INTO mission_events (id, mission_id, feature_id, position, at, type, message, actor, payload_json)
     VALUES (@id, @mission_id, @feature_id, @position, @at, @type, @message, @actor, @payload_json)`
  );

  function missionProjectContext(missionId) {
    try {
      const row = db.prepare(
        `SELECT m.project_id AS workspace_id,
                p.path AS repo_root
           FROM missions m
           LEFT JOIN projects p ON p.id = m.project_id
          WHERE m.id=?`
      ).get(missionId);
      return {
        workspaceId: row?.workspace_id || null,
        repoRoot: row?.repo_root || null,
      };
    } catch {
      return { workspaceId: null, repoRoot: null };
    }
  }

  const lifecycleProjectionInsert = db.prepare(
    `INSERT OR IGNORE INTO integration_context_import_projections
     (audit_id, event_json, delivered_at) VALUES (?, ?, NULL)`,
  );
  const lifecycleProjectionGet = db.prepare(
    'SELECT event_json, delivered_at FROM integration_context_import_projections WHERE audit_id = ?',
  );
  const lifecycleProjectionDelivered = db.prepare(
    `UPDATE integration_context_import_projections SET delivered_at = ?
      WHERE audit_id = ? AND delivered_at IS NULL`,
  );
  const lifecycleEventsMaxBytes = 4 * 1024 * 1024;

  function descriptorCapabilityPath(stats) {
    if (process.platform !== 'darwin') throw new Error('lifecycle projection capabilities require macOS');
    return `/.vol/${stats.dev}/${stats.ino}`;
  }

  function sameLifecycleFileStats(actual, expected) {
    return actual.isFile()
      && actual.nlink === 1n
      && actual.dev === expected.dev
      && actual.ino === expected.ino
      && actual.mode === expected.mode
      && actual.size === expected.size
      && actual.mtimeNs === expected.mtimeNs
      && actual.ctimeNs === expected.ctimeNs;
  }

  function readExactLifecycleContent(fd, size) {
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < content.length) {
      const read = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (read <= 0) throw new Error('lifecycle projection log changed while reading');
      offset += read;
    }
    return content;
  }

  function readLifecycleEvents(fd, initialStats, intendedLine, delivered) {
    if (!initialStats.isFile()
      || initialStats.nlink !== 1n
      || initialStats.size > BigInt(lifecycleEventsMaxBytes)) {
      throw new Error('lifecycle projection log is not a bounded regular file');
    }
    const content = readExactLifecycleContent(fd, Number(initialStats.size));
    const finalStats = fs.fstatSync(fd, { bigint: true });
    if (!sameLifecycleFileStats(finalStats, initialStats)) {
      throw new Error('lifecycle projection log changed while reading');
    }
    let completeLength = content.length;
    let tail = Buffer.alloc(0);
    if (content.length > 0 && content[content.length - 1] !== 0x0a) {
      completeLength = content.lastIndexOf(0x0a) + 1;
      tail = content.subarray(completeLength);
      const recoverable = !delivered
        && tail.length > 0
        && tail.length < intendedLine.length
        && tail.equals(intendedLine.subarray(0, tail.length));
      if (!recoverable) throw new Error('lifecycle projection log is truncated');
    }
    const completeContent = content.subarray(0, completeLength);
    const records = completeContent.toString('utf8').split('\n').filter(Boolean).map((raw) => {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.eventId !== 'string') {
        throw new Error('lifecycle projection log is malformed');
      }
      return { event: parsed, line: Buffer.from(`${raw}\n`, 'utf8') };
    });
    return { content: completeContent, records, stats: finalStats, tail };
  }

  function requireLifecyclePathIdentity(candidate, flags, expectedStats, exactFile = false) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(candidate, flags);
      const actualStats = exactFile
        ? fs.fstatSync(fd, { bigint: true })
        : fs.fstatSync(fd);
      if ((exactFile && !sameLifecycleFileStats(actualStats, expectedStats))
        || (!exactFile && (String(actualStats.dev) !== String(expectedStats.dev)
          || String(actualStats.ino) !== String(expectedStats.ino)))) {
        throw new Error('lifecycle projection path identity changed');
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  function fsyncLifecycleEvent(fd) {
    if (typeof (testHooks as any).contextImportLifecycleFsync === 'function') {
      return (testHooks as any).contextImportLifecycleFsync(fd);
    }
    return fs.fsyncSync(fd);
  }

  function appendLifecycleFile(repoCapability, event, delivered) {
    if (!/^\/\.vol\/\d+\/\d+$/.test(String(repoCapability || ''))) {
      throw new Error('pinned lifecycle projection repository is required');
    }
    const acePath = `${repoCapability}/.ace`;
    try {
      fs.mkdirSync(acePath, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let aceFd: number | null = null;
    let eventsFd: number | null = null;
    try {
      aceFd = fs.openSync(
        acePath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      const aceStats = fs.fstatSync(aceFd);
      if (!aceStats.isDirectory()) throw new Error('lifecycle projection directory is invalid');
      const aceCapability = descriptorCapabilityPath(aceStats);
      const eventPath = `${aceCapability}/events.ndjson`;
      const createFlag = delivered ? 0 : fs.constants.O_CREAT;
      const openFlags = fs.constants.O_RDWR
        | fs.constants.O_APPEND
        | fs.constants.O_NONBLOCK
        | fs.constants.O_NOFOLLOW
        | createFlag;
      if (typeof (testHooks as any).contextImportLifecycleEventsOpen === 'function') {
        (testHooks as any).contextImportLifecycleEventsOpen(openFlags);
      }
      eventsFd = fs.openSync(
        eventPath,
        openFlags,
        0o600,
      );
      const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      if (line.length > lifecycleEventsMaxBytes) throw new Error('lifecycle projection event is oversized');
      const initialEventsStats = fs.fstatSync(eventsFd, { bigint: true });
      const lifecycleSnapshot = readLifecycleEvents(eventsFd, initialEventsStats, line, delivered);
      if (typeof (testHooks as any).contextImportLifecycleAfterRead === 'function') {
        (testHooks as any).contextImportLifecycleAfterRead({ eventPath, eventsFd });
      }
      const matchingRecords = lifecycleSnapshot.records
        .filter((entry) => entry.event.eventId === event.eventId);
      if (matchingRecords.some((entry) => !entry.line.equals(line))) {
        throw new Error('lifecycle projection event identity conflict');
      }
      const matches = matchingRecords.length;
      if (matches > 1 || (delivered && matches !== 1)) {
        throw new Error('lifecycle projection event count is invalid');
      }
      if (lifecycleSnapshot.tail.length > 0 && matches !== 0) {
        throw new Error('lifecycle projection recovery is ambiguous');
      }
      if (matches === 0) {
        const beforeWrite = fs.fstatSync(eventsFd, { bigint: true });
        if (!sameLifecycleFileStats(beforeWrite, lifecycleSnapshot.stats)
          || BigInt(lifecycleSnapshot.content.length + line.length) > BigInt(lifecycleEventsMaxBytes)) {
          throw new Error('lifecycle projection log exceeds its bound');
        }
        if (lifecycleSnapshot.tail.length > 0) {
          requireLifecyclePathIdentity(
            eventPath,
            fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
            beforeWrite,
            true,
          );
          fs.ftruncateSync(eventsFd, lifecycleSnapshot.content.length);
          fs.fsyncSync(eventsFd);
          const truncatedStats = fs.fstatSync(eventsFd, { bigint: true });
          if (!truncatedStats.isFile()
            || truncatedStats.nlink !== 1n
            || truncatedStats.dev !== beforeWrite.dev
            || truncatedStats.ino !== beforeWrite.ino
            || truncatedStats.mode !== beforeWrite.mode
            || truncatedStats.size !== BigInt(lifecycleSnapshot.content.length)) {
            throw new Error('lifecycle projection recovery identity changed');
          }
        }
        let written = 0;
        while (written < line.length) {
          const count = typeof (testHooks as any).contextImportLifecycleWrite === 'function'
            ? (testHooks as any).contextImportLifecycleWrite(
              eventsFd,
              line,
              written,
              line.length - written,
              null,
            )
            : fs.writeSync(eventsFd, line, written, line.length - written, null);
          if (count <= 0) throw new Error('lifecycle projection append failed');
          written += count;
        }
        fsyncLifecycleEvent(eventsFd);
        const syncedStats = fs.fstatSync(eventsFd, { bigint: true });
        const expectedContent = Buffer.concat([lifecycleSnapshot.content, line]);
        if (!syncedStats.isFile()
          || syncedStats.nlink !== 1n
          || syncedStats.dev !== beforeWrite.dev
          || syncedStats.ino !== beforeWrite.ino
          || syncedStats.mode !== beforeWrite.mode
          || syncedStats.size !== BigInt(expectedContent.length)) {
          throw new Error('lifecycle projection append identity changed');
        }
        if (typeof (testHooks as any).contextImportLifecycleAfterFsync === 'function') {
          (testHooks as any).contextImportLifecycleAfterFsync({
            eventPath,
            eventsFd,
            line,
            offset: lifecycleSnapshot.content.length,
          });
        }
        const stablePostStats = fs.fstatSync(eventsFd, { bigint: true });
        const stablePostContent = readExactLifecycleContent(eventsFd, expectedContent.length);
        const verifiedPostStats = fs.fstatSync(eventsFd, { bigint: true });
        if (!sameLifecycleFileStats(stablePostStats, syncedStats)
          || !sameLifecycleFileStats(verifiedPostStats, stablePostStats)
          || !stablePostContent.equals(expectedContent)) {
          throw new Error('lifecycle projection append verification failed');
        }
        requireLifecyclePathIdentity(
          eventPath,
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
          stablePostStats,
          true,
        );
      }
      if (matches === 1) {
        if (!delivered) fsyncLifecycleEvent(eventsFd);
        const syncedStats = fs.fstatSync(eventsFd, { bigint: true });
        const syncedContent = readExactLifecycleContent(
          eventsFd,
          lifecycleSnapshot.content.length,
        );
        const verifiedStats = fs.fstatSync(eventsFd, { bigint: true });
        if (!sameLifecycleFileStats(syncedStats, lifecycleSnapshot.stats)
          || !sameLifecycleFileStats(verifiedStats, syncedStats)
          || !syncedContent.equals(lifecycleSnapshot.content)) {
          throw new Error('lifecycle projection delivery verification failed');
        }
        requireLifecyclePathIdentity(
          eventPath,
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
          syncedStats,
          true,
        );
      }
      requireLifecyclePathIdentity(
        acePath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        aceStats,
      );
    } finally {
      if (eventsFd !== null) fs.closeSync(eventsFd);
      if (aceFd !== null) fs.closeSync(aceFd);
    }
  }

  const deliverLifecycleProjection = db.transaction((event, projectionContext) => {
    const eventJson = JSON.stringify(event);
    lifecycleProjectionInsert.run(event.eventId, eventJson);
    const projection = lifecycleProjectionGet.get(event.eventId);
    if (!projection || projection.event_json !== eventJson) {
      throw new Error('lifecycle projection event identity conflict');
    }
    if (!projection.delivered_at
      && typeof (testHooks as any).contextImportProjectionBeforeAppend === 'function') {
      (testHooks as any).contextImportProjectionBeforeAppend(event);
    }
    appendLifecycleFile(
      projectionContext?.repoCapability,
      event,
      Boolean(projection.delivered_at),
    );
    if (!projection.delivered_at) {
      lifecycleProjectionDelivered.run(nowIso(), event.eventId);
    }
  });
  const deliverLifecycleProjectionImmediate = typeof deliverLifecycleProjection.immediate === 'function'
    ? (...args: any[]) => deliverLifecycleProjection.immediate(...args)
    : deliverLifecycleProjection;

  function appendImportedContextLifecycleProjection(event, projectionContext) {
    deliverLifecycleProjectionImmediate(event, projectionContext);
  }

  const integrationContextImporter = createIntegrationContextImporter({
    ...((testHooks as any).contextImportDeps || {}),
    db,
    newId,
    now: nowIso,
    appendLifecycle: (event: any, projectionContext: any) =>
      appendImportedContextLifecycleProjection(event, projectionContext),
  });

  function integrationContextImport(input: any) {
    return integrationContextImporter.importContext(input);
  }

  function compactWikiLifecycleLine(event) {
    const clean = (value, max = 240) => String(value ?? '')
      .replace(/[\u0000-\u001f]/g, ' ')
      .slice(0, max);
    const ids = [
      event?.missionId ? `mission=${clean(event.missionId, 80)}` : '',
      event?.featureId ? `feature=${clean(event.featureId, 80)}` : '',
    ].filter(Boolean).join(' ');
    return `- [${clean(event?.at || nowIso(), 80)}] ${clean(event?.type || 'note', 80)}${event?.actor ? ` (${clean(event.actor, 80)})` : ''}${ids ? ` ${ids}` : ''} - ${clean(event?.summary || event?.message || '')}`;
  }

  function appendWikiLifecycleLogFallback(event) {
    if (wikiUpdater.isDisabled()) return;
    try {
      const explicit = process.env.ACE_WIKI_LOG_PATH;
      const root = opsWikiRoot();
      const logPath = explicit && String(explicit).trim()
        ? path.resolve(String(explicit).trim())
        : path.join(root, 'log.md');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${compactWikiLifecycleLine(event)}\n`);
    } catch {}
  }

  function missionLifecyclePayload({
    id,
    at,
    missionId,
    featureId,
    type,
    message,
    actor,
    payload,
  }) {
    const ctx = missionProjectContext(missionId);
    const extra = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      schema: 'ace.event.v1',
      eventId: id,
      type,
      at,
      actor: actor || 'system',
      workspaceId: ctx.workspaceId,
      repoRoot: ctx.repoRoot,
      missionId,
      featureId: featureId || null,
      taskId: extra.taskId || null,
      streamId: extra.streamId || null,
      branch: extra.branch || null,
      summary: String(message ?? ''),
      evidence: Array.isArray(extra.evidence) ? extra.evidence : [],
      ...extra,
    };
  }

  function recordMissionLifecycleEvent(missionId, type, message, actor = null, featureId = null, payload = null) {
    const id = newId('mev');
    const at = nowIso();
    const eventPayload = missionLifecyclePayload({
      id,
      at,
      missionId,
      featureId,
      type,
      message,
      actor,
      payload,
    });
    insertMissionEvent.run({
      id,
      mission_id: missionId,
      feature_id: featureId ? String(featureId) : null,
      position: nextMissionEventPosition.get(missionId).next,
      at,
      type,
      message,
      actor,
      payload_json: JSON.stringify(eventPayload),
    });
    appendProjectLifecycleEvent(eventPayload.repoRoot, eventPayload);
    try {
      const logWrite = wikiUpdater.appendMissionEventLine(eventPayload);
      if (logWrite?.written !== true) appendWikiLifecycleLogFallback(eventPayload);
    } catch {
      appendWikiLifecycleLogFallback(eventPayload);
    }
    maybeUpdateWikiForMission(missionId);
  }

  function recordMissionBoardEvent(missionId, type, message, actor = null, featureId = null, payload = null) {
    return recordMissionLifecycleEvent(missionId, type, message, actor, featureId, payload);
  }

  function maybeUpdateWikiForMission(missionId) {
    if (wikiUpdater.isDisabled()) return;
    try {
	      const missions = projectMissions(db);
	      const mission = missions.find((m) => m.id === missionId);
      if (!mission) return;
      const events = (mission.events || []).slice(-12);
      wikiUpdater.updateMissionSection({
        missionId: mission.id,
        missionName: mission.name,
        workspaceId: mission.workspaceId,
        status: mission.status,
        nextAction: mission.nextAction,
        events,
      });
	      const board = projectMissionBoard(missions, { workspaceId: mission.workspaceId });
      const nextActions = [];
      for (const boardMission of board.missions || []) {
        for (const card of boardMission.cards || []) {
          const next = card.nextAllowedAction || card.missionNextAction || null;
          if (next) nextActions.push({ featureId: card.id, next, reason: card.name });
        }
      }
      wikiUpdater.updateMissionBoardSnapshot({ board, nextActions, health: 'healthy' });
    } catch (err) {
      // fail-closed: wiki errors must never bubble into runtime
    }
  }

  // Operations Cockpit snapshot + signals (PR-5). Evidence-only, read-only.
  // None of these methods dispatch, merge, deploy, or spawn — they observe the
  // SAME probes the live CLI/IPC path runs and distill them into the wiki under
  // the truth contract (docs/ops/ace-wiki-truth-contract.md §6).
  const OPS_SEVERITY_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2, black: 3 };

  function opsProbesDir() {
    // External-data-root aware: userDataPath is already the resolved data root
    // (~/.ace or the SSD mirror). Raw ndjson evidence lands beside it and
    // NEVER reaches current-state.md.
    return path.join(userDataPath, 'probes');
  }

  // Use an explicitly selected vault or the public profile's own wiki.
  // Never discover legacy home or external-drive vaults on a fresh profile.
  // All readers and writers resolve through this path.
  function opsWikiRoot() {
    const override = process.env.ACE_WIKI_ROOT;
    if (override && override.trim()) return path.resolve(override.trim());
    return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki');
  }

  // Pin the resolved root into the env (when not explicitly overridden) so
  // wiki-updater.cts — which resolves env at call time — writes to the same
  // vault this store reads from.
  try {
    if (!process.env.ACE_WIKI_ROOT) process.env.ACE_WIKI_ROOT = opsWikiRoot();
  } catch { /* env pin is best-effort */ }

  // -------------------------------------------------------------------------
  // Knowledge plane: unified FTS5 search over the ops wiki, project wikis and
  // dump intake. knowledge.db is REBUILDABLE AND DISPOSABLE — never user data.
  // -------------------------------------------------------------------------

  function knowledgeDbPath() {
    const override = process.env.ACE_KNOWLEDGE_DB;
    if (override && override.trim()) return path.resolve(override.trim());
    return path.join(userDataPath, 'knowledge.db');
  }

  let knowledgeIndexInstance: any = null;
  function knowledgeIndex() {
    if (!knowledgeIndexInstance) {
      knowledgeIndexInstance = knowledgeIndexModule.createKnowledgeIndex({
        Database,
        dbPath: knowledgeDbPath(),
      });
    }
    return knowledgeIndexInstance;
  }

  /**
   * Every indexable source: ops wiki, each registered project's wiki/dumps/
   * memory candidates/goal ledgers, and READ-ONLY Hermes memories.
   */
  function knowledgeSources() {
    const sources: any[] = [{ source: 'ops-wiki', root: opsWikiRoot(), project: null }];
    let projectRows: any[] = [];
    try {
      projectRows = db.prepare('SELECT id, path FROM projects').all();
    } catch {
      projectRows = [];
    }
    for (const row of projectRows) {
      if (!row?.path || typeof row.path !== 'string') continue;
      const wikiRoot = path.join(row.path, '.ace', 'wiki');
      const dumpRoot = path.join(row.path, '.ace', 'wiki-dump');
      const runRoot = path.join(row.path, '.ace', 'run');
      try {
        if (fs.existsSync(wikiRoot)) {
          sources.push({ source: 'project-wiki', root: wikiRoot, project: row.id, defaultTrust: 'canon' });
        }
        if (fs.existsSync(dumpRoot)) {
          sources.push({ source: 'project-dump', root: dumpRoot, project: row.id });
        }
        if (fs.existsSync(runRoot)) {
          sources.push({ source: 'memory-candidate', root: runRoot, project: row.id });
        }
        // Goal ledgers live under the (possibly external) artifact root.
        const artifactRoot = externalDataRoot.externalArtifactRootForRepo(row.path, userDataPath);
        const ledgerRoot = path.join(artifactRoot, '.agent', 'runs');
        if (fs.existsSync(ledgerRoot)) {
          sources.push({
            source: 'goal-ledger',
            root: ledgerRoot,
            project: row.id,
            defaultTrust: 'working',
            defaultKind: 'run-digest',
          });
        }
      } catch { /* unreadable project dir → skip */ }
    }
    // Hermes memories: read-only custom collector (trust='external').
    sources.push({
      source: 'hermes-memory',
      root: userDataPath,
      project: null,
      format: 'custom',
      collect: () => hermesMemoryReader.collectHermesMemoryDocs({ userDataPath, Database }),
    });
    return sources;
  }

  /**
   * Roots that path-based knowledge reads must stay inside. Custom-collector
   * sources are excluded (their root is userData — far too broad); Hermes
   * memories/ dirs are added explicitly as READ-ONLY targets instead.
   */
  function knowledgeRoots() {
    const roots = knowledgeSources()
      .filter((source: any) => source.format !== 'custom')
      .map((source: any) => source.root);
    try {
      for (const hermesRoot of hermesMemoryReader.hermesMemoryRoots(userDataPath)) {
        roots.push(path.join(hermesRoot.root, 'memories'));
      }
    } catch { /* hermes roots are optional */ }
    return roots;
  }

  function knowledgeReindex() {
    try {
      const stats = knowledgeIndex().reindex({ sources: knowledgeSources() });
      return { ok: true, dbPath: knowledgeDbPath(), ...stats };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  let knowledgeIndexedOnce = false;
  function knowledgeSearch(p: any = {}) {
    try {
      if (!knowledgeIndexedOnce) {
        // Lazy first index so search works without waiting for a schedule.
        knowledgeReindex();
        knowledgeIndexedOnce = true;
      }
      const result = knowledgeIndex().search({
        query: p?.query,
        project: p?.project,
        tier: p?.tier,
        kind: p?.kind,
        tags: Array.isArray(p?.tags) ? p.tags : p?.tag ? [p.tag] : [],
        limit: p?.limit,
        includeDecayed: p?.includeDecayed === true,
      });
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  const KNOWLEDGE_ENTRY_MAX_BYTES = 16 * 1024;
  function knowledgeGet(p: any = {}) {
    const candidate = String(p?.path || p?.id || '').trim();
    if (!candidate) return { ok: false, error: 'path required' };
    const real = knowledgeIndexModule.containedRealPath(candidate, knowledgeRoots());
    if (!real) return { ok: false, error: 'path_outside_roots' };
    try {
      const stat = fs.statSync(real);
      const raw = fs.readFileSync(real, 'utf8');
      const truncated = raw.length > KNOWLEDGE_ENTRY_MAX_BYTES;
      return {
        ok: true,
        schema: 'AceMemoryEntry/v1',
        path: real,
        sizeBytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        truncated,
        body: truncated ? raw.slice(0, KNOWLEDGE_ENTRY_MAX_BYTES) : raw,
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function knowledgeStatus() {
    try {
      return { ok: true, ...knowledgeIndex().describe(), wikiRoot: opsWikiRoot() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** Organized per-agent / per-project overview for the Knowledge tab. */
  function knowledgeOverview() {
    try {
      if (!knowledgeIndexedOnce) {
        knowledgeReindex();
        knowledgeIndexedOnce = true;
      }
      return { ok: true, ...knowledgeIndex().overview(), wikiRoot: opsWikiRoot() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /**
   * Optional nightly LLM knowledge-curator (owner-approved, proposals-only).
   * Config-gated via <ACE_HOME>/ops-config.json:
   *   { "knowledgeCurator": { "enabled": true, "workspaceId": "prj_x", "agent": "claude" } }
   * plus ACE_KNOWLEDGE_CURATOR_DISABLE=1 as a hard off-switch. The agent
   * is a no-code lane that reads the audit report + proposals + quarantine
   * and emits consolidation/promotion PROPOSALS through `ace wiki dump` /
   * `ace memory remember` — every canon write gate still applies, so a
   * hallucinating curator cannot touch canon.
   */
  function readKnowledgeCuratorConfig() {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json'), 'utf8')
      );
      const curator = cfg?.knowledgeCurator || {};
      const workspaceId = typeof curator.workspaceId === 'string' ? curator.workspaceId.trim() : '';
      return {
        enabled: curator.enabled === true && workspaceId.length > 0,
        workspaceId: workspaceId || null,
        agent: curator.agent === 'codex' ? 'codex' : 'claude',
      };
    } catch {
      return { enabled: false, workspaceId: null, agent: 'claude' };
    }
  }

  function maybeDispatchKnowledgeCurator({ reportPath }: any = {}) {
    if (process.env.ACE_KNOWLEDGE_CURATOR_DISABLE === '1') {
      return { dispatched: false, reason: 'env-disabled' };
    }
    const config = readKnowledgeCuratorConfig();
    if (!config.enabled) return { dispatched: false, reason: 'not-configured' };
    if (!publicApi || typeof publicApi.streamSpawnAdhoc !== 'function') {
      return { dispatched: false, reason: 'spawn-unavailable' };
    }
    const proposalsPath = String(reportPath || '').replace(/\.md$/, '.proposals.json');
    const prompt = [
      'Nightly knowledge curator (no-code lane). Read first: the ace-memory skill,',
      `the audit report at ${reportPath}, its proposals sidecar at ${proposalsPath},`,
      'and any quarantine sidecars it names.',
      'Task: consolidate duplicate lessons, resolve contradiction pairs, and recommend promotions/retirements.',
      'Output PROPOSALS ONLY: `ace memory remember "<claim>" --category decision|lesson` or `ace wiki dump --kind operator_note` per proposal.',
      'Hard rules: never run `ace wiki update`; never edit files; never delete anything; cite the audit finding each proposal addresses.',
      'End with exactly DONE: <count of proposals> or BLOCKED: <reason>.',
    ].join('\n');
    try {
      const spawned = publicApi.streamSpawnAdhoc({
        agent: config.agent,
        workspaceId: config.workspaceId,
        label: 'knowledge-curator (nightly)',
        kind: 'cli',
        prompt,
        mode: 'paste',
      });
      return { dispatched: true, workspaceId: config.workspaceId, agent: config.agent, streamId: spawned?.streamId || null };
    } catch (err: any) {
      return { dispatched: false, reason: String(err?.message || err) };
    }
  }

  /**
   * Deterministic memory eval (fixture corpus, minutes): retrieval R@5 +
   * decay assertions across lookup / cross-project / temporal /
   * knowledge-update / abstention. Report lands in <wiki>/logs/eval/.
   */
  function knowledgeEval() {
    const report = knowledgeEvalModule.runKnowledgeEval({ Database });
    let reportPath: string | null = null;
    try {
      const dir = path.join(opsWikiRoot(), 'logs', 'eval');
      fs.mkdirSync(dir, { recursive: true });
      reportPath = path.join(dir, `${new Date().toISOString().slice(0, 10)}-memory-eval.md`);
      const tmp = `${reportPath}.tmp`;
      fs.writeFileSync(tmp, knowledgeEvalModule.renderEvalReport(report));
      fs.renameSync(tmp, reportPath);
    } catch { /* report write is best-effort */ }
    return { ...report, reportPath };
  }

  /** Nightly run state + recent history for the Knowledge tab. */
  function knowledgeNightlyStatus() {
    try {
      return {
        ok: true,
        state: knowledgeNightlyScheduler.readNightlyState(userDataPath),
        history: knowledgeNightlyScheduler.readNightlyHistory(userDataPath, 14),
        disabled: process.env.ACE_KNOWLEDGE_NIGHTLY_DISABLE === '1',
        curator: readKnowledgeCuratorConfig(),
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** Quarantined ops-wiki items (moved by the nightly audit, never deleted). */
  function knowledgeQuarantineList() {
    const root = opsWikiRoot();
    const quarantineRoot = path.join(root, 'quarantine');
    const items: any[] = [];
    const walk = (dir: string) => {
      let entries: any[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'rejected' && entry.name !== 'resolved') walk(full);
        } else if (entry.name.endsWith('.quarantine.json')) {
          try {
            const sidecar = JSON.parse(fs.readFileSync(full, 'utf8'));
            const quarantinedFile = full.replace(/\.quarantine\.json$/, '');
            if (!fs.existsSync(quarantinedFile)) continue;
            items.push({
              path: quarantinedFile,
              sidecarPath: full,
              originalPath: sidecar.originalPath || null,
              reason: sidecar.reason || 'unknown',
              quarantinedAt: sidecar.quarantinedAt || null,
            });
          } catch { /* unreadable sidecar → skip */ }
        }
      }
    };
    walk(quarantineRoot);
    items.sort((a, b) => String(b.quarantinedAt || '').localeCompare(String(a.quarantinedAt || '')));
    return { ok: true, items };
  }

  /**
   * Resolve one quarantined item (rename-only in knowledge-audit.cts —
   * approve restores, reject moves to rejected/; nothing is ever deleted).
   */
  function knowledgeQuarantineResolve(p: any = {}) {
    const result = knowledgeAudit.resolveQuarantineItem({
      wikiRoot: opsWikiRoot(),
      itemPath: p?.path,
      action: p?.action,
    });
    if (result?.ok) {
      try { knowledgeReindex(); } catch { /* next cycle */ }
    }
    return result;
  }

  /**
   * The autonomous nightly knowledge loop (scheduler-driven; also callable
   * on demand). Deterministic core — the optional LLM curator rides behind
   * it, proposals-only. Order: reindex → audit ops wiki + project wikis →
   * apply decay to the index → quarantine raw-tier offenders (move, never
   * delete) → per-project curation (the previously CLI-only `wiki nightly`)
   * → rotation (archive, never delete) → report → optional curator dispatch.
   */
  function knowledgeNightly(p: any = {}) {
    try {
      const nowMs = Date.now();
      const generatedAt = new Date(nowMs).toISOString();
      const wikiRoot = opsWikiRoot();

      const index = knowledgeReindex();

      // Audit every vault: the ops wiki plus each project wiki.
      const vaults: any[] = [];
      const opsAudit = knowledgeAudit.auditVault({ root: wikiRoot, label: 'ops-wiki', now: nowMs });
      vaults.push(opsAudit);
      const projectVaults = knowledgeSources().filter((source: any) => source.source === 'project-wiki');
      for (const source of projectVaults) {
        vaults.push(knowledgeAudit.auditVault({ root: source.root, label: `project:${source.project}`, now: nowMs }));
      }

      // Decay: recomputed from current findings. Healthy pages recover.
      let decayed = 0;
      try {
        const engine = knowledgeIndex();
        const flagged = new Set<string>();
        for (const vault of vaults) {
          for (const [docPath, assignment] of Object.entries(vault.decayByPath)) {
            engine.setDecay(docPath, (assignment as any).decay, (assignment as any).reasons);
            flagged.add(docPath);
            decayed += 1;
          }
        }
        // Recovery: any doc currently decayed in the index but no longer
        // flagged returns to 1.0.
        engine.resetDecayExcept(Array.from(flagged));
      } catch { /* decay application is best-effort */ }

      // Quarantine raw-tier offenders (ops wiki only in v1 — project raw
      // intake already quarantines at dump-ingest).
      const quarantined = knowledgeAudit.applyQuarantine({
        root: wikiRoot,
        candidates: opsAudit.quarantineCandidates,
        now: nowMs,
      });

      // Per-project curation: promote validated dumps into canon, rebuild
      // packs + MOC indexes, audit (project-wiki-curator owns all of it).
      //
      // Enumerate by dumps-OR-wiki (NOT just existing project-wiki sources): a
      // dump-only project (wiki-dump/ but no wiki/) was previously skipped here,
      // so its canon never bootstrapped. wiki-bootstrap.curateAllProjects
      // bootstraps the OKF skeleton + curates each dump-or-wiki project.
      const curation: any[] = [];
      let projectRowsForCuration: any[] = [];
      try {
        projectRowsForCuration = db.prepare('SELECT id, path FROM projects').all();
      } catch { projectRowsForCuration = []; }
      try {
        const curated = wikiBootstrap.curateAllProjects({ projects: projectRowsForCuration });
        for (const entry of curated.results || []) {
          curation.push({
            project: entry.project,
            dumpOnlyBefore: entry.dumpOnlyBefore === true,
            reportPath: entry.result?.curation?.reportPath || null,
            ok: entry.ok !== false,
            ...(entry.ok === false ? { error: entry.error } : {}),
          });
        }
      } catch (err: any) {
        curation.push({ project: null, ok: false, error: String(err?.message || err) });
      }

      const rotation = knowledgeAudit.rotateKnowledgeArtifacts({ wikiRoot, stateDir: userDataPath, now: nowMs });

      // Report (atomic temp+rename, like every wiki write).
      const reportDir = path.join(wikiRoot, 'logs', 'audit');
      const reportPath = path.join(reportDir, `${generatedAt.slice(0, 10)}-knowledge-audit.md`);
      try {
        fs.mkdirSync(reportDir, { recursive: true });
        const report = knowledgeAudit.renderAuditReport({
          generatedAt, vaults, rotation, quarantined, curation, indexStats: index,
        });
        const tmp = `${reportPath}.tmp`;
        fs.writeFileSync(tmp, report);
        fs.renameSync(tmp, reportPath);
        const proposalsSidecar = vaults.flatMap((vault: any) => vault.proposals).concat(rotation.proposals || []);
        fs.writeFileSync(`${reportPath.replace(/\.md$/, '')}.proposals.json`, `${JSON.stringify(proposalsSidecar, null, 2)}\n`);
      } catch { /* report write is best-effort */ }

      // Refresh the index so quarantine moves/rotation are reflected.
      try { knowledgeIndex().reindex({ sources: knowledgeSources() }); } catch { /* next cycle catches up */ }

      // Optional LLM curator — proposals only, behind every canon write gate.
      let curator: any = { dispatched: false, reason: 'skipped' };
      try { curator = maybeDispatchKnowledgeCurator({ reportPath }); } catch { /* curator is optional */ }

      return {
        ok: true,
        generatedAt,
        curator,
        index,
        findings: vaults.reduce((sum: number, vault: any) => sum + vault.findings.length, 0),
        proposals: vaults.reduce((sum: number, vault: any) => sum + vault.proposals.length, 0) + (rotation.proposals?.length || 0),
        decayed,
        quarantined: quarantined.length,
        curatedProjects: curation.length,
        reportPath,
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function opsWikiRawDir() {
    return path.join(opsWikiRoot(), 'raw');
  }

  function opsDateStamp(now?: Date) {
    const d = now instanceof Date ? now : new Date();
    return d.toISOString().slice(0, 10);
  }

  function writeOpsRawEvidence(status: any, now: Date) {
    // Raw probe ndjson → <ACE_HOME>/probes/<YYYY-MM-DD>.ndjson. Append-only so
    // multiple runs in a day are preserved as evidence. Fail-closed: a write
    // error never aborts the distilled-section write.
    const dir = opsProbesDir();
    const target = path.join(dir, `${opsDateStamp(now)}.ndjson`);
    fs.mkdirSync(dir, { recursive: true });
    const findings = Array.isArray(status?.findings) ? status.findings : [];
    const lines = findings
      .map((finding: any) => JSON.stringify({ at: status?.timestamp, finding }))
      .join('\n');
    fs.appendFileSync(target, lines ? `${lines}\n` : '');
    return target;
  }

  async function opsStatusSnapshot(input: { now?: string | number | Date; probes?: string[]; configPath?: string; workspaceId?: string } = {}) {
    const now = input.now ? new Date(String(input.now)) : new Date();
    const recheckCommand = 'ace --json ops status';
    let status = null;
    try {
      // READ-ONLY probe run. isLive:false marks every finding as a snapshot so
      // the UI never conflates a stored snapshot with a live "all clear".
      status = await runOpsStatus({
        ...(input.probes ? { probes: input.probes } : {}),
        ...(input.configPath ? { configPath: input.configPath } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        userDataPath,
        socketPath: aceSocketPath(userDataPath),
        now: () => now,
      });
    } catch (err) {
      // Probe failed → exact sentinel via recordFailedProbe. Fail-closed; a
      // wiki write failure is the only black finding and must never throw.
      wikiUpdater.recordFailedProbe({
        id: 'ops-status',
        sectionTitle: 'Operations status',
        source: 'ace-electron',
        reason: err?.message || String(err),
        command: recheckCommand,
        ts: now.toISOString(),
      });
      return { ok: false, reason: err?.message || String(err) };
    }

    let evidencePath = null;
    try {
      evidencePath = writeOpsRawEvidence(status, now);
    } catch {
      // Raw evidence is best-effort; never block the distilled wiki write.
    }

    const findings = (Array.isArray(status?.findings) ? status.findings : []).map(
      (finding: any) => ({ ...finding, isLive: false, source: 'ace-electron' })
    );

    wikiUpdater.updateOpsStatusSection({
      rollup: status?.rollup || {},
      findings,
      isLive: false,
      ts: now.toISOString(),
    });
    wikiUpdater.updateOpsDailySection({
      recommendations: deriveOpsRecommendations(findings),
      ts: now.toISOString(),
    });

    return {
      ok: true,
      isLive: false,
      source: 'ace-electron',
      severity: status?.rollup?.severity || null,
      evidencePath,
      findingCount: findings.length,
    };
  }

  function readOpsRawSignals() {
    // Derived-on-read (Option A): parse distilled vector-ops signal files under
    // wiki/ace-ops/raw/*.json. No table, no migration. Fail-closed per file
    // so one malformed file cannot blank the inbox.
    const dir = opsWikiRawDir();
    const signals: any[] = [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return signals;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.signals)
          ? parsed.signals
          : parsed
            ? [parsed]
            : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        signals.push({
          id: String(row.id || `${name}:${signals.length}`),
          source: 'vector-ops',
          severity: typeof row.severity === 'string' ? row.severity : 'yellow',
          title: String(row.title || row.id || 'Vector Ops signal'),
          message: typeof row.message === 'string' ? row.message : '',
          path: path.join(dir, name),
          lastChecked: typeof row.lastChecked === 'string' ? row.lastChecked : null,
          isLive: false,
        });
      }
    }
    return signals;
  }

  async function streamOperationsSignals(input: { workspaceId?: string } = {}) {
    // Union of parsed vector-ops raw signals with live ops-status findings of
    // severity >= yellow. Read-only synthesis (contracts §7).
    const signals = readOpsRawSignals();
    // Vector Ops daily intel (latest.json) — fail-safe, never throws (ops-v2 W1).
    try {
      const loaded = vectorOpsAdapter.loadLatestReport();
      for (const s of vectorOpsAdapter.synthesizeSignals(loaded.report, { intelAsOf: loaded.intelAsOf })) {
        signals.push(s);
      }
    } catch {
      // Vector Ops intel is best-effort; raw + live findings still surface.
    }
    try {
      const status = await runOpsStatus({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        userDataPath,
        socketPath: aceSocketPath(userDataPath),
      });
      for (const finding of Array.isArray(status?.findings) ? status.findings : []) {
        const rank = OPS_SEVERITY_RANK[finding?.severity];
        if (rank == null || rank < OPS_SEVERITY_RANK.yellow) continue;
        signals.push({
          id: `finding:${finding.id}`,
          source: 'ace-electron',
          severity: finding.severity,
          title: finding.title || finding.id,
          message: finding.message || '',
          path: finding?.evidence?.path || null,
          lastChecked: finding?.evidence?.lastChecked || status?.timestamp || null,
          isLive: finding.isLive !== false,
        });
      }
    } catch {
      // Live findings are best-effort; raw signals alone still surface.
    }
    return signals;
  }

  function deriveOpsRecommendations(findings: any[]) {
    // Minimal derived list: ranked findings >= yellow become candidate
    // recommendations. NEVER auto-created into missions — the only state-
    // creating path is DO -> confirm modal -> human confirm.
    const rows = (Array.isArray(findings) ? findings : [])
      .filter((finding) => {
        const rank = OPS_SEVERITY_RANK[finding?.severity];
        return rank != null && rank >= OPS_SEVERITY_RANK.yellow;
      })
      .sort(
        (a, b) =>
          (OPS_SEVERITY_RANK[b?.severity] || 0) - (OPS_SEVERITY_RANK[a?.severity] || 0)
      );
    return rows.map((finding) => ({
      id: `rec:${finding.id}`,
      decision: 'ask',
      title: finding.title || finding.id,
      reason: finding.message || '',
      severity: finding.severity,
      owner: null,
      nextAction: finding.recommendedAction || '',
      risk: finding.severity === 'red' || finding.severity === 'black' ? 'high' : 'medium',
      confidence: typeof finding.confidence === 'number' ? finding.confidence : 0,
    }));
  }

  async function streamOperationsRecommendations(input: { workspaceId?: string } = {}) {
    // Read-only derived list: health-degraded findings (ranked) UNION Vector Ops
    // daily intel synthesis from latest.json (ops-v2 W1). NEVER auto-creates a
    // mission — the only state-creating path is DO -> confirm modal -> Chief.
    const out: any[] = [];
    try {
      const status = await runOpsStatus({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        userDataPath,
        socketPath: aceSocketPath(userDataPath),
      });
      out.push(...deriveOpsRecommendations(status?.findings));
    } catch {
      // health findings best-effort
    }
    try {
      const loaded = vectorOpsAdapter.loadLatestReport();
      out.push(...vectorOpsAdapter.synthesizeRecommendations(loaded.report, { intelAsOf: loaded.intelAsOf }));
    } catch {
      // Vector Ops intel best-effort
    }
    return out;
  }

  // ops-v2 G7: enrich a synthesized intel brief with live ops sections — Top
  // Decisions / Top Actions (from ranked recommendations), Mission Board
  // (blocked/stale missions + worker/validator summary), and Service Health
  // when a fresh probe result is provided. Cheap db reads only otherwise.
  // Best-effort everywhere: the intel brief must stand alone on any failure.
  function appendOpsBriefOpsSections(
    brief: any,
    opts: { report: any; now: number; status?: any | null }
  ) {
    try {
      brief.sections = Array.isArray(brief.sections) ? brief.sections : [];
      let recs: any[] = [];
      try {
        recs = vectorOpsAdapter.synthesizeRecommendations(opts.report) ?? [];
      } catch {
        recs = [];
      }
      const decisions = recs.filter((r: any) => r?.decision === 'ask').slice(0, 3);
      if (decisions.length) {
        brief.sections.push({
          title: 'Top Decisions',
          items: decisions.map((r: any) => ({
            text: r.title,
            why: r.reason ?? null,
            move: r.nextAction ?? null,
            url: null,
          })),
        });
      }
      const actions = recs.filter((r: any) => r?.nextAction).slice(0, 5);
      if (actions.length) {
        brief.sections.push({
          title: 'Top Actions',
          items: actions.map((r: any) => ({
            text: r.nextAction,
            why: r.title ?? null,
            move: null,
            url: null,
          })),
        });
      }
      try {
        const missions = projectMissions(db) ?? [];
        const features = missions.flatMap((m: any) =>
          Array.isArray(m.features) ? m.features : []
        );
        const blocked = features.filter(
          (f: any) => f?.dispatchStatus === 'blocked_by_dependencies'
        );
        const staleCutoff = opts.now - 48 * 60 * 60 * 1000;
        const stale = missions.filter((m: any) => {
          if (!m || m.status === 'completed' || m.status === 'archived') return false;
          const at = Date.parse(m.updatedAt ?? m.updated_at ?? '');
          return Number.isFinite(at) && at < staleCutoff;
        });
        const activeWorkers = features.filter(
          (f: any) => f?.streamId && f.status === 'in_progress'
        );
        const validating = features.filter(
          (f: any) =>
            f?.validatorStreamId &&
            f.validationStatus &&
            f.validationStatus !== 'passed' &&
            f.validationStatus !== 'failed'
        );
        brief.sections.push({
          title: 'Mission Board',
          items: [
            {
              text: `${missions.length} mission(s) · ${features.length} card(s) on the board`,
              why: null,
              move: null,
              url: null,
            },
            {
              text: `${blocked.length} card(s) blocked by dependencies`,
              why: blocked.length
                ? blocked.slice(0, 3).map((f: any) => f.name).join(' · ')
                : null,
              move: null,
              url: null,
            },
            {
              text: `${stale.length} mission(s) stale >48h`,
              why: stale.length
                ? stale.slice(0, 3).map((m: any) => m.name).join(' · ')
                : null,
              move: stale.length ? 'Review on the Ops tab Kanban.' : null,
              url: null,
            },
            {
              text: `${activeWorkers.length} active worker(s) · ${validating.length} validation(s) in flight`,
              why: null,
              move: null,
              url: null,
            },
          ],
        });
      } catch {
        // mission read best-effort
      }
      const status = opts.status ?? null;
      if (status && Array.isArray(status.findings)) {
        const notable = status.findings.filter(
          (f: any) =>
            f && (f.severity === 'yellow' || f.severity === 'red' || f.severity === 'black')
        );
        brief.sections.push({
          title: 'Service Health',
          items: notable.length
            ? notable.slice(0, 6).map((f: any) => ({
                text: `${f.title}: ${f.message}`,
                why: null,
                move: f.recommendedAction ?? null,
                url: null,
              }))
            : [
                {
                  text: `All probes green (rollup ${status?.rollup?.severity ?? 'green'}).`,
                  why: null,
                  move: null,
                  url: null,
                },
              ],
        });
      }
    } catch {
      // enrichment is best-effort — the intel brief stands alone
    }
    return brief;
  }

  // ops-v2 W1: lens-differentiated Rook brief distilled from latest.json, plus
  // live Mission Board / decisions / actions sections (G7). Service-health
  // probes are NOT run here (this backs every Operations bootstrap) — only the
  // scheduled/manual deliverOpsBrief path probes. Fail-safe — never throws,
  // never fakes freshness.
  async function streamOperationsBrief(input: { lens?: 'morning' | 'midday' | 'evening'; now?: number } = {}) {
    const lens = input.lens === 'midday' || input.lens === 'evening' ? input.lens : 'morning';
    const now = typeof input.now === 'number' ? input.now : Date.now();
    const sourceState = opsSourceState();
    // Locally pulled intel rides along so the brief can fall back honestly
    // when the external report goes stale (>24h) instead of freezing.
    const localIntel = vectorOpsAdapter.loadLocalIntel({
      path: path.join(userDataPath, opsRefresh.LOCAL_INTEL_FILE),
    }).local;
    try {
      const loaded = vectorOpsAdapter.loadLatestReport({ now });
      const brief = vectorOpsAdapter.synthesizeBrief(loaded.report, lens, {
        now,
        sourceFreshness: loaded.freshness,
        intelAsOf: loaded.intelAsOf,
        sourceState,
        localIntel,
      });
      return appendOpsBriefOpsSections(brief, { report: loaded.report, now });
    } catch {
      const brief = vectorOpsAdapter.synthesizeBrief(null, lens, {
        now,
        sourceFreshness: 'missing',
        intelAsOf: null,
        sourceState,
        localIntel,
      });
      return appendOpsBriefOpsSections(brief, { report: null, now });
    }
  }

  // ops-v2: the FULL Vector Ops dashboard intel (all latest.json sections).
  // Fail-safe — never throws; missing intel returns an empty-but-valid payload.
  // S3: locally pulled intel + per-source state ride along so the merge layer
  // labels per-section provenance/freshness honestly.
  // Judged intel is cached per underlying report (key = asOf + section item
  // counts) so the optional judgment agent spawns at most once per report
  // update — never per view/mount. The cached value is the in-flight promise,
  // which also dedups concurrent callers.
  let judgedIntelCache: { key: string; promise: Promise<any> } | null = null;

  async function streamOperationsIntel() {
    const now = Date.now();
    const localIntel = vectorOpsAdapter.loadLocalIntel({
      path: path.join(userDataPath, opsRefresh.LOCAL_INTEL_FILE),
    }).local;
    const sourceState = opsSourceState();
    let intel: any;
    try {
      const loaded = vectorOpsAdapter.loadLatestReport();
      intel = vectorOpsAdapter.synthesizeIntel(loaded.report, {
        prices: loaded.prices,
        intelAsOf: loaded.intelAsOf,
        sourceFreshness: loaded.freshness,
        localIntel,
        sourceState,
        now,
      });
    } catch {
      intel = vectorOpsAdapter.synthesizeIntel(null, { prices: [], localIntel, sourceState, now });
    }

    // Optional judgment pass (dedup/relevance/authored next-actions) —
    // config-gated, fail-closed to the verbatim intel on any failure.
    let cfg;
    try {
      cfg = readOpsRefreshConfigForStore();
    } catch {
      return intel;
    }
    if (!cfg.research.enabled || !cfg.research.judge) return intel;
    const sections: any[] = Array.isArray(intel?.sections) ? intel.sections : [];
    if (sections.every((s: any) => !Array.isArray(s?.items) || s.items.length === 0)) return intel;
    const key = `${intel?.intelAsOf ?? 'none'}#${sections
      .map((s: any) => (Array.isArray(s?.items) ? s.items.length : 0))
      .join(',')}`;
    if (judgedIntelCache && judgedIntelCache.key === key) return judgedIntelCache.promise;

    // Pure-reasoning judge: no tools at all (the intel is in the prompt), a
    // throwaway scratch cwd, and judgeIntel's own ≤120s hard cap.
    const judgeRunAgent = async ({ prompt, timeoutMs }: { prompt: string; timeoutMs: number }) => {
      let scratchCwd = os.tmpdir();
      try {
        scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-intel-judge-'));
      } catch {
        // fall back to the system temp root if mkdtemp fails
      }
      try {
        const res = await agentCliDriverForStore.runAgentPrompt({
          agent: cfg.research.agent,
          bin: cfg.research.agent,
          cwd: scratchCwd,
          prompt,
          timeoutMs,
          allowedTools: [],
          ...(cfg.research.effort ? { reasoningEffort: cfg.research.effort } : {}),
        });
        return res.output;
      } finally {
        if (scratchCwd !== os.tmpdir()) {
          try {
            fs.rmSync(scratchCwd, { recursive: true, force: true });
          } catch {
            // scratch cleanup is best-effort
          }
        }
      }
    };
    const promise = vectorOpsAdapter.judgeIntel(intel, { runAgent: judgeRunAgent }).catch(() => intel);
    judgedIntelCache = { key, promise };
    return promise;
  }

  // ops-v2: operator manual Kanban move. Sets board_column_override on the feature
  // so deriveMissionCardStage honors the drag. toColumn 'auto'/empty clears it
  // (back to lifecycle-derived). Pure state move — NEVER dispatches/spawns.
  const OPS_BOARD_COLUMNS = ['todo', 'in_progress', 'ready_to_review', 'done'];

  // ops-v2 W5 brief delivery helpers. Distilled briefs land in the wiki briefs
  // dir; raw is never touched. quietWhenNoChange comes from <ACE_HOME>/ops-config.json
  // (default off — Chief's cadence wins). State + delivered log live under userData.
  function opsBriefsDir() {
    // Resolves through opsWikiRoot() so an external-SSD vault keeps briefs
    // beside the rest of the wiki — never a split-brain.
    return path.join(opsWikiRoot(), 'briefs');
  }
  function opsTodayBriefPath() {
    return path.join(opsWikiRoot(), 'dashboards', 'today.md');
  }
  // D9: todo digests land beside the briefs — same wiki, sibling 'todos' dir.
  function opsTodoDigestsDir() {
    return path.join(opsWikiRoot(), 'todos');
  }
  function readOpsBriefConfig() {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json'), 'utf8')
      );
      return {
        quietWhenNoChange: cfg?.briefs?.quietWhenNoChange === true,
        // Optional slot override (briefs.schedule: [{hour, minute?, lens}]).
        // normalizeBriefSchedule falls back to the 7:30/13:00/20:30 defaults.
        schedule: opsBriefScheduler.normalizeBriefSchedule(cfg?.briefs?.schedule),
      };
    } catch {
      return { quietWhenNoChange: false, schedule: opsBriefScheduler.normalizeBriefSchedule(null) };
    }
  }
  // S3: refresh-engine config (<ACE_HOME>/ops-config.json `refresh` key).
  // Fail-safe defaults like readOpsBriefConfig — junk config never blocks a run.
  function readOpsRefreshConfig() {
    let refresh: any = {};
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json'), 'utf8')
      );
      if (cfg?.refresh && typeof cfg.refresh === 'object') refresh = cfg.refresh;
    } catch {
      // defaults below
    }
    const research = refresh?.research && typeof refresh.research === 'object' ? refresh.research : {};
    return {
      research: {
        enabled: research?.enabled !== false,
        // Judgment pass over synthesized intel (dedup/relevance/authored
        // next-actions). Master-gated by `enabled`; spawns are additionally
        // capped by the per-report cache in streamOperationsIntel.
        judge: research?.judge !== false,
        agent: research?.agent === 'codex' ? 'codex' : 'claude',
        effort: typeof research?.effort === 'string' && research.effort ? research.effort : null,
        timeoutMs: typeof research?.timeoutMs === 'number' ? research.timeoutMs : 300000,
      },
      fetchTimeoutMs: typeof refresh?.fetchTimeoutMs === 'number' ? refresh.fetchTimeoutMs : 10000,
    };
  }

  // Todo-digest agent config (<ACE_HOME>/ops-config.json `todoDigest.agent` key).
  // OFF by default so the twice-daily digest stays byte-for-byte deterministic
  // until the owner opts in — the agent leg is a fail-closed refinement, never a
  // behavior change no one asked for. Fail-safe defaults like the readers above:
  // junk config never blocks a digest. Hard-capped at 120s regardless of config.
  function readTodoDigestConfig() {
    let td: any = {};
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json'), 'utf8')
      );
      if (cfg?.todoDigest && typeof cfg.todoDigest === 'object') td = cfg.todoDigest;
    } catch {
      // defaults below
    }
    const agentCfg = td?.agent && typeof td.agent === 'object' ? td.agent : {};
    const timeoutMs = typeof agentCfg?.timeoutMs === 'number' ? agentCfg.timeoutMs : 120000;
    return {
      agent: {
        // Opt-in only: absent/false => deterministic, exactly like today.
        enabled: agentCfg?.enabled === true,
        agent: agentCfg?.agent === 'codex' ? 'codex' : 'claude',
        effort: typeof agentCfg?.effort === 'string' && agentCfg.effort ? agentCfg.effort : null,
        timeoutMs: Math.max(1, Math.min(timeoutMs, 120000)),
      },
    };
  }

  // S3: pull every Sources-registry source (native feeds/repos + the headless
  // research-agent leg) and persist per-source state under userData. NEVER
  // rejects — a failed run returns an honest empty-sources shape so callers
  // (scheduler ticks, IPC, boot catch-up) always survive.
  let opsRefreshInFlight: Promise<any> | null = null;
  async function opsRefreshSources(input: { lens?: string; trigger?: string; allowResearchAgent?: boolean } = {}) {
    // Single in-flight guard: manual (IPC), scheduled (brief tick) and boot
    // catch-up all reach this against one userDataPath. Overlapping calls would
    // double-spawn the paid research agent and race the state/intel writes, so
    // a second caller awaits the run already in progress instead.
    if (opsRefreshInFlight) return opsRefreshInFlight;
    opsRefreshInFlight = runOpsRefreshSourcesOnce(input).finally(() => {
      opsRefreshInFlight = null;
    });
    return opsRefreshInFlight;
  }

  async function runOpsRefreshSourcesOnce(input: { lens?: string; trigger?: string; allowResearchAgent?: boolean }) {
    const trigger = input.trigger || 'manual';
    const lens = input.lens;
    const researchAllowed =
      trigger === 'manual' ? input.allowResearchAgent !== false : input.allowResearchAgent === true;
    const probeStartedMs = Date.now();
    try {
      const cfg = readOpsRefreshConfigForStore();
      let report: any = null;
      let reportFreshness: 'fresh' | 'stale' | 'expired' | 'missing' = 'missing';
      try {
        const loaded = vectorOpsAdapter.loadLatestReport();
        report = loaded.report;
        reportFreshness = loaded.freshness;
      } catch {
        // honest 'missing' freshness below
      }
      // Same derive+merge flow as opsSourcesGet — one watchlist truth.
      const merged = opsSourcesForStore.mergeSources(
        opsSourcesForStore.deriveWatchlists(report),
        opsSourcesForStore.loadLocalSources()
      );
      const runAgent = cfg.research.enabled && researchAllowed
        ? async ({ prompt, timeoutMs }: { prompt: string; timeoutMs: number }) => {
            // Least privilege: the research leg only needs to read the web and
            // synthesize JSON, so it runs in a throwaway scratch cwd (never the
            // user's home) with a web-only tool allowlist — even though the
            // launcher passes --dangerously-skip-permissions, the allowlist
            // removes Bash/Write/Edit/Read from an unattended scheduled agent.
            let scratchCwd = os.tmpdir();
            try {
              scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-research-'));
            } catch {
              // fall back to the system temp root if mkdtemp fails
            }
            try {
              const res = await agentCliDriverForStore.runAgentPrompt({
                agent: cfg.research.agent,
                bin: cfg.research.agent,
                cwd: scratchCwd,
                prompt,
                timeoutMs,
                allowedTools: ['WebSearch', 'WebFetch'],
                ...(cfg.research.effort ? { reasoningEffort: cfg.research.effort } : {}),
              });
              return res.output;
            } finally {
              if (scratchCwd !== os.tmpdir()) {
                try {
                  fs.rmSync(scratchCwd, { recursive: true, force: true });
                } catch {
                  // scratch cleanup is best-effort
                }
              }
            }
          }
        : undefined;
      const result = await opsRefresh.runOpsRefresh({
        watchlists: merged.watchlists,
        stateDir: userDataPath,
        trigger,
        lens,
        fetchTimeoutMs: cfg.fetchTimeoutMs,
        // birdclaw is preferred for the social lane when the owner configured
        // a DB path (the adapter self-reads <ACE_HOME>/ops-config.json birdclaw.*
        // and degrades to the research path when absent).
        birdclaw: {},
        research: {
          enabled: cfg.research.enabled && researchAllowed,
          runAgent,
          timeoutMs: cfg.research.timeoutMs,
        },
        reportFreshness,
        logger: console,
      });
      const okSources = result.sources.filter((s: any) => s.status === 'ok').length;
      const failedSources = result.sources.filter((s: any) => s.status === 'error').length;
      events.emit('ops:intel-refreshed', {
        at: result.at,
        trigger: result.trigger,
        lens: result.lens ?? null,
        ok: okSources,
        failed: failedSources,
      });
      telemetryLib.telemetryEmit({
        type: 'ops.refresh',
        source: trigger,
        lane: lens ?? null,
        ok: failedSources === 0,
        durationMs: Date.now() - probeStartedMs,
        meta: { okSources, failedSources },
      });
      return result;
    } catch (err: any) {
      try {
        console.error('[ace] ops source refresh failed:', err?.message ?? err);
      } catch {
        // logging best-effort
      }
      telemetryLib.telemetryEmit({
        type: 'ops.refresh',
        source: trigger,
        lane: lens ?? null,
        ok: false,
        severity: 'error',
        errorClass: err?.name || 'Error',
        durationMs: Date.now() - probeStartedMs,
      });
      return { at: null, trigger, lens: lens ?? null, sources: [], error: err?.message ?? String(err) };
    }
  }

  // S3: persisted per-source refresh state snapshot (pure read, never throws).
  function opsSourceState() {
    return opsRefresh.refreshStatus({ stateDir: userDataPath });
  }
  function readOpsBriefState() {
    try {
      return JSON.parse(fs.readFileSync(path.join(userDataPath, 'ops-brief-state.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  function writeOpsBriefState(next: any) {
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(
        path.join(userDataPath, 'ops-brief-state.json'),
        JSON.stringify(next, null, 2)
      );
    } catch {
      // state persistence is convenience-only; never throw.
    }
  }

  // Generate + deliver one lens-differentiated brief. Called by the in-process
  // ops-brief scheduler (08/13/18). Fail-closed: a wiki/IO failure logs a
  // sentinel and the runtime survives (rubric R7). NEVER dispatches/spawns.
  async function deliverOpsBrief(input: { lens?: 'morning' | 'midday' | 'evening'; now?: number; refreshSources?: boolean; allowResearchAgent?: boolean } = {}) {
    const lens = input.lens === 'midday' || input.lens === 'evening' ? input.lens : 'morning';
    const now = typeof input.now === 'number' ? input.now : Date.now();

    // S3: scheduled ticks pull all sources first. opsRefreshSources never
    // rejects, but a refresh failure must never block brief generation anyway.
    if (input.refreshSources === true) {
      try {
        await opsRefreshSources({
          lens,
          trigger: 'scheduled',
          allowResearchAgent: input.allowResearchAgent === true,
        });
      } catch {
        // brief still generates from existing data
      }
    }
    const sourceState = opsSourceState();

    let report: any = null;
    let freshness: 'fresh' | 'stale' | 'expired' | 'missing' = 'missing';
    let intelAsOf: string | null = null;
    let intelPath: string | null = null;
    try {
      const loaded = vectorOpsAdapter.loadLatestReport({ now });
      report = loaded.report;
      freshness = loaded.freshness;
      intelAsOf = loaded.intelAsOf;
      intelPath = loaded.path;
    } catch {
      // honest fallback below
    }

    // Locally pulled intel lets the delivered brief fall back honestly when
    // the external report is stale instead of freezing on old data.
    const briefLocalIntel = vectorOpsAdapter.loadLocalIntel({
      path: path.join(userDataPath, opsRefresh.LOCAL_INTEL_FILE),
    }).local;
    let brief: any;
    try {
      brief = vectorOpsAdapter.synthesizeBrief(report, lens, { now, sourceFreshness: freshness, intelAsOf, sourceState, localIntel: briefLocalIntel });
    } catch {
      brief = vectorOpsAdapter.synthesizeBrief(null, lens, { now, sourceFreshness: 'missing', intelAsOf: null, sourceState, localIntel: briefLocalIntel });
    }

    // Live ops delta (best-effort): every delivered brief gets the full G7
    // section set — decisions/actions, Mission Board, and probe-backed
    // Service Health (one probe run is fine on the 2-3x/day cadence).
    let missionCount = 0;
    try {
      const missions = projectMissions(db);
      missionCount = Array.isArray(missions) ? missions.length : 0;
    } catch {
      // mission read best-effort
    }
    let probeStatus: any = null;
    try {
      probeStatus = await runOpsStatusForStore({
        userDataPath,
        socketPath: aceSocketPath(userDataPath),
      });
    } catch {
      probeStatus = null;
    }
    appendOpsBriefOpsSections(brief, { report, now, status: probeStatus });

    // quietWhenNoChange (default off): skip only when no new intel AND no mission change.
    const cfg = readOpsBriefConfig();
    const prev = readOpsBriefState();
    const newCount = report && typeof report.new_count === 'number' ? report.new_count : 0;
    const todayPath = opsTodayBriefPath();
    const historyPath = path.join(userDataPath, 'ops-briefs.ndjson');
    const statePath = path.join(userDataPath, 'ops-brief-state.json');
    const writeToday = (briefPath: string | null) => {
      const result = opsBriefScheduler.writeTodayBrief({
        brief,
        todayPath,
        briefPath,
        historyPath,
        statePath,
        intelPath,
      });
      if (!result?.written && result?.error) {
        try {
          console.error('[ace] today brief write failed (fail-closed):', result.error);
        } catch {
          // logging best-effort
        }
      }
      return {
        path: result?.disabled ? null : result?.path ?? todayPath,
        written: result?.written === true,
        error: result?.error ?? null,
      };
    };
    if (cfg.quietWhenNoChange && prev && prev.intelAsOf === intelAsOf && prev.missionCount === missionCount) {
      const todayResult = writeToday(null);
      return {
        delivered: false,
        skipped: true,
        reason: 'no-change',
        lens,
        todayPath: todayResult.path,
        todayWritten: todayResult.written,
        todayError: todayResult.error,
      };
    }

    // Distilled write to the wiki briefs dir — fail-closed (R7).
    let writtenPath: string | null = null;
    try {
      const md = opsBriefScheduler.renderBriefMarkdown(brief);
      const dir = opsBriefsDir();
      fs.mkdirSync(dir, { recursive: true });
      const dateStr = new Date(now).toISOString().slice(0, 10);
      writtenPath = path.join(dir, `${dateStr}-${lens}.md`);
      fs.writeFileSync(writtenPath, md, 'utf8');
    } catch (err: any) {
      try {
        console.error('[ace] ops brief write failed (fail-closed):', err?.message ?? err);
      } catch {
        // logging best-effort
      }
      writtenPath = null;
    }
    const todayResult = writeToday(writtenPath);

    // Delivered log (best-effort) for history + Operations mirror.
    try {
      const logPath = historyPath;
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          at: new Date(now).toISOString(),
          lens,
          freshness,
          intelAsOf,
          candidateCount: brief?.candidateCount ?? 0,
          path: writtenPath,
          todayPath: todayResult.path,
          todayWritten: todayResult.written,
          todayError: todayResult.error,
        }) + '\n'
      );
    } catch {
      // log best-effort
    }

    writeOpsBriefState({
      intelAsOf,
      missionCount,
      newCount,
      lastLens: lens,
      lastAt: new Date(now).toISOString(),
      lastTodayPath: todayResult.path,
      lastTodayWritten: todayResult.written,
      lastTodayError: todayResult.error,
    });
    try {
      events.emit('ops:brief-delivered', {
        lens,
        brief,
        path: writtenPath,
        todayPath: todayResult.path,
        todayWritten: todayResult.written,
        todayError: todayResult.error,
      });
    } catch {
      // event best-effort
    }
    return {
      delivered: true,
      lens,
      path: writtenPath,
      todayPath: todayResult.path,
      todayWritten: todayResult.written,
      todayError: todayResult.error,
      brief,
    };
  }

  // D8/D9: generate + deliver one twice-daily todo digest (morning/night).
  // Default is rule-based "auto-organized proposals" — synthesizeTodoDigest is
  // pure and never claims AI judgment; nothing is auto-promoted. When the owner
  // opts in (<ACE_HOME>/ops-config.json todoDigest.agent.enabled), the synthesize
  // path FIRST attempts one headless agent refinement (mirroring the ops-refresh
  // research-agent runner: throwaway scratch cwd, least-privilege tool allowlist,
  // hard ≤120s timeout) and falls back to the identical deterministic digest on
  // ANY failure. digest.source records which path produced it. Mirrors the
  // deliverOpsBrief delivery shape: latest-json store write + wiki markdown
  // (sibling 'todos' dir) + ndjson log under userData. Fail-safe throughout —
  // a wiki/IO failure never blocks the digest from returning.
  async function deliverTodoDigest(input: { slot?: 'morning' | 'night'; now?: number } = {}) {
    const slot: 'morning' | 'night' = input.slot === 'night' ? 'night' : 'morning';
    const now = typeof input.now === 'number' ? input.now : Date.now();

    let todos: any[] = [];
    try {
      todos = opsTodos.listTodos();
    } catch {
      todos = [];
    }

    // Opt-in headless-agent refinement (config-gated, default OFF). The runAgent
    // leg only needs to read the prompt and emit JSON, so it runs in a throwaway
    // scratch cwd with a Read-only tool allowlist — even though the launcher
    // passes --dangerously-skip-permissions, the allowlist removes Bash/Write/
    // Edit from this unattended agent. Any failure below is caught inside
    // synthesizeTodoDigestWithAgent, which returns the deterministic digest.
    let runAgent:
      | ((args: { prompt: string; timeoutMs: number }) => Promise<string>)
      | undefined;
    let agentTimeoutMs = 120000;
    try {
      const tdCfg = readTodoDigestConfigForStore();
      if (tdCfg.agent.enabled) {
        agentTimeoutMs = tdCfg.agent.timeoutMs;
        runAgent = async ({ prompt, timeoutMs }: { prompt: string; timeoutMs: number }) => {
          let scratchCwd = os.tmpdir();
          try {
            scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-todo-digest-'));
          } catch {
            // fall back to the system temp root if mkdtemp fails
          }
          try {
            const res = await agentCliDriverForStore.runAgentPrompt({
              agent: tdCfg.agent.agent,
              bin: tdCfg.agent.agent,
              cwd: scratchCwd,
              prompt,
              timeoutMs,
              allowedTools: ['Read'],
              ...(tdCfg.agent.effort ? { reasoningEffort: tdCfg.agent.effort } : {}),
            });
            return res.output;
          } finally {
            if (scratchCwd !== os.tmpdir()) {
              try {
                fs.rmSync(scratchCwd, { recursive: true, force: true });
              } catch {
                // scratch cleanup is best-effort
              }
            }
          }
        };
      }
    } catch {
      // config read / runner setup failure => deterministic path (runAgent stays undefined)
      runAgent = undefined;
    }

    const digest = await opsTodos.synthesizeTodoDigestWithAgent(todos, {
      slot,
      now,
      runAgent,
      timeoutMs: agentTimeoutMs,
    });

    // Latest digest for the Todo panel (read via opsTodoDigest).
    opsTodos.writeTodoDigest(digest);

    // Wiki copy next to the briefs — <date>-<slot>.md (fail-safe).
    let writtenPath: string | null = null;
    try {
      const dir = opsTodoDigestsDir();
      fs.mkdirSync(dir, { recursive: true });
      const dateStr = new Date(now).toISOString().slice(0, 10);
      writtenPath = path.join(dir, `${dateStr}-${slot}.md`);
      fs.writeFileSync(writtenPath, digest.markdown, 'utf8');
    } catch (err: any) {
      try {
        console.error('[ace] todo digest wiki write failed:', err?.message ?? err);
      } catch {
        // logging best-effort
      }
      writtenPath = null;
    }

    // Delivered log (best-effort) for history + scheduler health surfaces.
    try {
      const logPath = path.join(userDataPath, 'ops-todo-digests.ndjson');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          at: new Date(now).toISOString(),
          slot,
          openCount: digest?.openCount ?? 0,
          source: digest?.source ?? 'rules',
          path: writtenPath,
        }) + '\n'
      );
    } catch {
      // log best-effort
    }

    return digest;
  }

  function findMissionFeature(input = {}) {
    const featureId = String(input.featureId || '').trim();
    if (!featureId) throw new Error('featureId required');
    for (const mission of projectMissions(db)) {
      if (input.missionId && mission.id !== input.missionId) continue;
      if (input.workspaceId && mission.workspaceId !== input.workspaceId) continue;
      const feature = (mission.features || []).find((row) => row.id === featureId);
      if (feature) return { mission, feature };
    }
    throw new Error('mission feature not found');
  }

  function findMissionFeatureByTask(taskId) {
    const cleanTaskId = cleanMissionString(taskId);
    if (!cleanTaskId) return null;
    for (const mission of projectMissions(db)) {
      const feature = (mission.features || []).find((row) =>
        row.taskId === cleanTaskId || row.validatorTaskId === cleanTaskId || row.releaseTaskId === cleanTaskId
      );
      if (feature) {
        const role = feature.releaseTaskId === cleanTaskId
          ? 'release'
          : feature.validatorTaskId === cleanTaskId
            ? 'validator'
            : 'worker';
        return { mission, feature, role };
      }
    }
    return null;
  }

  function parseMissionJson(text, fallback = null) {
    try {
      return JSON.parse(String(text || ''));
    } catch {
      return fallback;
    }
  }

  function projectEventRows(repoRoot) {
    if (!repoRoot) return [];
    const eventPath = path.join(repoRoot, '.ace', 'events.ndjson');
    try {
      return fs.readFileSync(eventPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => parseMissionJson(line, null))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function streamIdFromTask(taskId, role) {
    const cleanTaskId = cleanMissionString(taskId);
    if (!cleanTaskId) return null;
    try {
      if (role === 'validator') {
        const conv = db
          .prepare(`SELECT id FROM conversations WHERE task_id=? ORDER BY created_at DESC LIMIT 1`)
          .get(cleanTaskId);
        if (conv?.id) return `conversation:${conv.id}`;
      }
      const variant = db
        .prepare(`SELECT id FROM variants WHERE task_id=? ORDER BY attached_at DESC LIMIT 1`)
        .get(cleanTaskId);
      if (variant?.id) return `variant:${variant.id}`;
      const conv = db
        .prepare(`SELECT id FROM conversations WHERE task_id=? ORDER BY created_at DESC LIMIT 1`)
        .get(cleanTaskId);
      if (conv?.id) return `conversation:${conv.id}`;
    } catch {}
    return null;
  }

  function taskIdFromStreamId(streamId) {
    const text = cleanMissionString(streamId);
    if (!text) return null;
    const match = /^(variant|conversation):(.+)$/.exec(text);
    if (!match) return null;
    try {
      if (match[1] === 'variant') {
        const row = db.prepare(`SELECT task_id FROM variants WHERE id=?`).get(match[2]);
        return row?.task_id || null;
      }
      const row = db.prepare(`SELECT task_id FROM conversations WHERE id=?`).get(match[2]);
      return row?.task_id || null;
    } catch {
      return null;
    }
  }

  function taskAttachmentContext(taskId) {
    const cleanTaskId = cleanMissionString(taskId);
    if (!cleanTaskId) return {};
    try {
      const wt = stmts.getWorktreesByTask.all(cleanTaskId)[0] || null;
      return {
        worktreeId: wt?.id || null,
        worktreePath: wt?.path || null,
        branch: wt?.branch || null,
      };
    } catch {
      return {};
    }
  }

  function missionFeatureValidationForGate(feature) {
    if (!feature) {
      return {
        self: null,
        independent: null,
        fixback: null,
        required: false,
        highRisk: false,
        chiefOverride: false,
      };
    }
    const bypass = latestValidationBypass(feature);
    const latestAttempt = latestValidationAttempt(feature);
    const attemptHead = cleanMissionString(latestAttempt?.validatedHeadSha);
    const featureHead = cleanMissionString(feature.prHeadSha);
    const prBacked = !!(feature.prUrl || feature.prNumber || feature.prHeadRef || feature.prHeadSha);
    const exactHeadCurrent = prBacked
      ? !!attemptHead && !!featureHead && attemptHead === featureHead
      : (!attemptHead || !featureHead || attemptHead === featureHead);
    const passed =
      (feature.validationStatus === 'validation_passed' && exactHeadCurrent) ||
      feature.validationStatus === 'validation_bypassed';
    const failed = feature.validationStatus === 'validation_failed';
    const attempts = Number(feature.fixbackAttempts || 0);
    return {
      self: passed ? 'PASS' : failed ? 'FAIL' : null,
      independent: feature.validationStatus === 'validation_passed' && exactHeadCurrent && !bypass ? 'PASS' : null,
      headSha: attemptHead,
      fixback: passed || attempts <= 0
        ? null
        : attempts >= FIXBACK_RETRY_MAX_ATTEMPTS
          ? 'blocked'
          : 'open',
      required: !bypass,
      highRisk: false,
      chiefOverride: false,
      fixbackAttempts: attempts,
      validationBypass: bypass,
    };
  }

  function missionGateAllowedPaths(mission, feature) {
    const seen = new Set();
    const paths = [];
    for (const value of [
      ...(Array.isArray(feature?.allowPaths) ? feature.allowPaths : []),
      ...(Array.isArray(feature?.sourceFiles) ? feature.sourceFiles : []),
      ...(Array.isArray(mission?.sourceFiles) ? mission.sourceFiles : []),
    ]) {
      const clean = String(value || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      paths.push(clean);
    }
    return paths;
  }

  function missionFeatureGateEvidence(mission, feature) {
    if (!mission || !feature) return null;
    return {
      missionId: mission.id,
      workspaceId: mission.workspaceId,
      featureId: feature.id,
      featureName: feature.name,
      taskId: feature.taskId || null,
      streamId: feature.streamId || null,
      branch: feature.branch || feature.prHeadRef || null,
      prNumber: feature.prNumber || extractMissionPrNumber(feature.prUrl),
      prUrl: feature.prUrl || null,
      prHeadRef: feature.prHeadRef || null,
      prBaseRef: feature.prBaseRef || null,
      prHeadSha: feature.prHeadSha || null,
      prBaseSha: feature.prBaseSha || null,
      baseBranch: feature.baseBranch || feature.prBaseRef || mission.integrationBranch || 'main',
      remoteBaseRef: feature.remoteBaseRef || null,
      baseSha: feature.prBaseSha || feature.baseSha || null,
      baseHygiene: feature.baseHygiene || null,
      allowPaths: missionGateAllowedPaths(mission, feature),
      validationStatus: feature.validationStatus || null,
      gateStatus: feature.gateStatus || null,
      validationHandoff: feature.validationHandoff || null,
      gateDetail: feature.gateDetail || null,
      fixbackAttempts: feature.fixbackAttempts || 0,
      validationFailurePacket: feature.validationFailurePacket || null,
    };
  }

  function normalizeValidationAttempts(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  }

  function latestValidationBypass(feature) {
    const attempts = normalizeValidationAttempts(feature?.validationAttempts);
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const attempt = attempts[i];
      if (attempt?.schema === 'AceValidationBypass/v1' || attempt?.validationBypass === true) {
        if (attempt.allowed !== false) return attempt;
      }
    }
    return null;
  }

  function latestValidationAttempt(feature) {
    const attempts = normalizeValidationAttempts(feature?.validationAttempts);
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const attempt = attempts[i];
      if (attempt?.schema === 'AceValidationBypass/v1') continue;
      return attempt;
    }
    return null;
  }

  function exactHeadPassAttempt(feature, headSha) {
    const cleanHead = cleanMissionString(headSha);
    const attempts = normalizeValidationAttempts(feature?.validationAttempts);
    return attempts.find((attempt) => {
      const status = cleanMissionString(attempt.status)?.toLowerCase();
      const verdict = cleanMissionString(attempt.verdict)?.toLowerCase();
      const attemptHead = cleanMissionString(attempt.validatedHeadSha || attempt.headSha || attempt.prHeadSha);
      return (status === 'passed' || verdict === 'pass') && cleanHead && attemptHead === cleanHead;
    }) || null;
  }

  function updateTaskWorktreeBaseEvidence({ taskId, baseRef, baseSha }: any = {}) {
    const cleanTaskId = cleanMissionString(taskId);
    const cleanBaseRef = cleanMissionString(baseRef);
    const cleanBaseSha = cleanMissionString(baseSha);
    if (!cleanTaskId || (!cleanBaseRef && !cleanBaseSha)) return;
    db.prepare(
      `UPDATE worktrees
       SET base_branch=COALESCE(@base_branch, base_branch),
           base_sha=COALESCE(@base_sha, base_sha)
       WHERE task_id=@task_id`
    ).run({
      task_id: cleanTaskId,
      base_branch: cleanBaseRef,
      base_sha: cleanBaseSha,
    });
  }

  function cleanPrePrReasonCode(value: any, label: string) {
    const raw = typeof value === 'object' && value && !Array.isArray(value)
      ? value.code
      : value;
    const code = String(raw || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw new Error(`${label}: reason code must be lowercase snake_case`);
    }
    return code;
  }





  async function refreshWorkspaceMeta(workspaceId) {
    const row = stmts.getProjectById.get(workspaceId);
    if (!row) return;
    if (row.is_remote) {
      workspaceMetaCache.set(workspaceId, { openPrs: [], cleanupBranches: [], branches: [] });
      return;
    }
    const taskBranches = new Map();
    try {
      const rows = db
        .prepare(
          `SELECT wt.branch as branch, t.name as name
           FROM worktrees wt
           JOIN tasks t ON t.id = wt.task_id
           WHERE wt.project_id = ? AND t.archived_at IS NULL`
        )
        .all(workspaceId);
      for (const r of rows) {
        if (!r.branch) continue;
        const list = taskBranches.get(r.branch) ?? [];
        list.push(r.name);
        taskBranches.set(r.branch, list);
      }
    } catch {

    }

    const info = await readProjectGitInfo(row.path);
    const [openPrs, cleanupBranches, branches] = await Promise.all([
      listOpenPrs(row.path),
      listCleanupBranches(row.path, {
        currentBranch: info.branch,
        defaultBranch: info.baseRef ?? row.default_branch ?? null,
        taskBranches,
      }),
      listBranches(row.path),
    ]);
    workspaceMetaCache.set(workspaceId, { openPrs, cleanupBranches, branches });
  }

  async function refreshAllWorkspaceMeta() {
    let rows = [];
    try {
      rows = db
        .prepare('SELECT id FROM projects WHERE is_remote=0 ORDER BY order_index ASC, created_at ASC')
        .all();
    } catch {
      rows = [];
    }
    let refreshedAny = false;
    for (const r of rows) {
      try {
        await refreshWorkspaceMeta(r.id);
        refreshedAny = true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Collapse the per-project fan-out into a single snapshot build + broadcast:
    // on startup with N projects this replaces N full getState() rebuilds with one.
    if (refreshedAny) emitState();
  }

  function startWorkspaceMetaRefresh() {
    if (workspaceMetaRefreshRun) return workspaceMetaRefreshRun;
    workspaceMetaRefreshRun = refreshAllWorkspaceMeta().finally(() => {
      workspaceMetaRefreshRun = null;
    });
    return workspaceMetaRefreshRun;
  }

  // Raw emit: rebuild + broadcast synchronously. Reach for emitState() (the
  // coalesced wrapper below) everywhere; emitStateNow exists for the trailing
  // flush and for tests.
  function emitStateNow() {
    const state = getState({ allowCache: false });
    const started = perfHealth.nowMs();
    events.emit('state', state);
    perfHealth.recordSpan({
      source: 'main',
      name: 'core.broadcastState',
      durationMs: perfHealth.nowMs() - started,
      meta: {
        workspaces: state.workspaces?.length || 0,
        missions: state.missions?.length || 0,
      },
    });
  }

  // Direct emitState() after a user mutation used to rebuild + broadcast the
  // full snapshot synchronously, per call — 41 call sites, so a burst (archive
  // sweep, multi-task git op) wedged the main thread. Leading+trailing:
  // an isolated mutation still emits immediately; bursts collapse to one
  // trailing emit carrying the final state. state:invalidate keeps its own
  // wider 500ms window upstream of this.
  const EMIT_STATE_COALESCE_MS = 100;
  const emitStateCoalescer = createCoalescer(emitStateNow, EMIT_STATE_COALESCE_MS, {
    onError: (err: any) => console.warn('[ace] trailing state emit failed:', err?.message || err),
  });
  function emitState() {
    emitStateCoalescer.call();
  }





  function browseLocalDir({ dirPath } = {}) {
    const target = dirPath
      ? path.resolve(dirPath)
      : os.homedir();
    const home = os.homedir();
    let entries = [];
    try {
      const raw = fs.readdirSync(target, { withFileTypes: true });
      entries = raw
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch {

    }
    const parent = target !== '/' ? path.dirname(target) : null;
    const hasGit = fs.existsSync(path.join(target, '.git'));
    return { path: target, home, parent, entries, hasGit };
  }

  async function importWorkspace({ workspacePath }) {
    if (!workspacePath) throw new Error('workspacePath required');
    const absolute = path.resolve(workspacePath);
    if (!fs.existsSync(absolute)) throw new Error(`Path not found: ${absolute}`);
    const existing = stmts.getProjectByPath.get(absolute);
    if (existing) return { id: existing.id };
    const info = await readProjectGitInfo(absolute);
    const now = nowIso();
    const id = newId('prj');
    stmts.insertProject.run({
      id,
      name: path.basename(absolute),
      path: absolute,
      is_remote: 0,
      ssh_host: null,
      ssh_user: null,
      remote_path: null,
      agent_user: null,
      original_owner: null,
      default_branch: info.baseRef ?? info.branch ?? 'main',
      github_repo: info.githubRepo,
      initialized: info.isGitRepo ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    ensureLocalExclude(absolute);
    emitState();


    void refreshWorkspaceMeta(id).then(() => emitState()).catch(() => {});
    return { id };
  }

  // Resolve the visible Loops workspace dir under the ACTIVE data root (the external
  // SSD when active — never hardcode /Volumes/...; resolveExternalDataRoot decides),
  // else userData. The system loops' CONTROL workspace lives here as a real projects
  // row so the Workspaces sidebar can show it under a separate 'System' group.
  function loopWorkspaceDir() {
    let root = userDataPath;
    try {
      const resolved = externalDataRoot.resolveExternalDataRoot({ currentUserDataPath: userDataPath });
      if (resolved && resolved.active && typeof resolved.root === 'string' && resolved.root) {
        root = resolved.root;
      }
    } catch {
      root = userDataPath;
    }
    return path.join(root, 'workspaces', 'loops');
  }

  // Materialize (idempotently) the Loops workspace row. Marked for the renderer's
  // 'System' sidebar group two ways: (1) the durable on-disk path convention
  // (<root>/workspaces/loops — the registry keys the System group off this suffix),
  // and (2) an explicit `group:'System'` field in the return contract the renderer
  // slice consumes. Fail-safe: returns { error } rather than throwing, so a boot/
  // lazy call can never crash the store.
  async function ensureLoopWorkspace() {
    try {
      const workspacePath = loopWorkspaceDir();
      fs.mkdirSync(workspacePath, { recursive: true });
      const res = await importWorkspace({ workspacePath });
      return { id: res && res.id ? res.id : null, path: workspacePath, group: 'System' };
    } catch (err: any) {
      return { error: String(err?.message || err), group: 'System' };
    }
  }




  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
  }





  function resolveSshUserFromConfig(host) {
    return new Promise((resolve) => {
      execFile('ssh', ['-G', host], { encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        for (const line of stdout.split('\n')) {
          const m = /^user\s+(.+)$/i.exec(line.trim());
          if (m) return resolve(m[1].trim() || null);
        }
        resolve(null);
      });
    });
  }




  const CHOWN_DENYLIST = new Set([
    '/', '/etc', '/usr', '/var', '/srv', '/home', '/root', '/opt',
    '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev',
    '/tmp', '/run', '/boot', '/mnt', '/media',
  ]);






  async function performChownInPlace({ sshHost, remotePath, agentUser }) {


    const rootDaemon = daemonFor(sshHost, null);
    await rootDaemon.ensureReady();
    const stat = await rootDaemon.fsStat(remotePath);
    if (!stat.exists) {
      throw new Error(`Path does not exist on remote: ${remotePath}`);
    }
    const listing = await rootDaemon.fsList(remotePath);
    const resolved = listing.path;
    if (CHOWN_DENYLIST.has(resolved)) {
      throw new Error(
        `Refusing to chown ${resolved} — pick a subdirectory instead.`
      );
    }

    let originalOwner = null;
    const statCmd = await rootDaemon.exec({
      cmd: 'sh',
      args: ['-c', `stat -c '%U:%G' ${shellQuote(resolved)} 2>/dev/null || stat -f '%Su:%Sg' ${shellQuote(resolved)}`],
    });
    if (statCmd.code === 0) {
      originalOwner = statCmd.stdout.trim() || null;
    }


    const script = [
      `(getent passwd ${agentUser} >/dev/null 2>&1 || useradd -m -s /bin/bash ${agentUser})`,
      `(getent group ${agentUser} | grep -qw root || usermod -aG ${agentUser} root)`,
      `chown -R ${agentUser}:${agentUser} ${shellQuote(resolved)}`,
      `chmod -R g+rwX ${shellQuote(resolved)}`,



      `su ${agentUser} -s /bin/bash -c "git config --global --get-all safe.directory 2>/dev/null | grep -qx '\\*' || git config --global --add safe.directory '*'"`,
    ].join(' && ');
    const run = await rootDaemon.exec({
      cmd: 'sh',
      args: ['-c', script],
    });
    if (run.code !== 0) {
      throw new Error(
        `chown-in-place failed: ${run.stderr.trim() || run.stdout.trim() || 'unknown error'}`
      );
    }
    return originalOwner;
  }

  async function importRemoteWorkspace({ sshHost, remotePath, agentUser = null, chownInPlace = false }) {
    if (!sshHost || !remotePath) {
      throw new Error('sshHost and remotePath are required');
    }





    const resolvedSshUser = await resolveSshUserFromConfig(sshHost);







    let originalOwner = null;
    if (chownInPlace) {
      if (!agentUser) throw new Error('chownInPlace requires an agentUser');
      originalOwner = await performChownInPlace({
        sshHost,
        remotePath,
        agentUser,
      });
    }

    const daemon = daemonFor(sshHost, agentUser);
    await daemon.ensureReady();


    const stat = await daemon.fsStat(remotePath);
    if (!stat.exists) {
      throw new Error(`Path does not exist on remote: ${remotePath}`);
    }
    if (stat.kind !== 'dir') {
      throw new Error(`Remote path is not a directory: ${remotePath}`);
    }
    const listing = await daemon.fsList(remotePath);
    const resolvedPath = listing.path;




    let isGitRepo = false;
    let defaultBranch = 'main';
    const topLevel = await daemon.exec({
      cmd: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: resolvedPath,
    });
    if (topLevel.code === 0) {
      isGitRepo = true;
      const branchRes = await daemon.exec({
        cmd: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        cwd: resolvedPath,
      });
      if (branchRes.code === 0) {
        const b = branchRes.stdout.trim();
        if (b) defaultBranch = b;
      }
    }

    const displayName = path.posix.basename(resolvedPath);
    const synthetic = `ssh://${sshHost}${resolvedPath}`;
    const existing = stmts.getProjectByPath.get(synthetic);
    if (existing) {
      emitState();
      return { id: existing.id };
    }
    const id = newId('prj');
    const now = nowIso();
    stmts.insertProject.run({
      id,
      name: displayName,
      path: synthetic,
      is_remote: 1,
      ssh_host: sshHost,
      ssh_user: resolvedSshUser,
      remote_path: resolvedPath,
      agent_user: agentUser,
      original_owner: originalOwner,
      default_branch: defaultBranch,
      github_repo: null,
      initialized: isGitRepo ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    emitState();
    return { id };
  }

  async function listRemoteDir({ sshHost, path: remotePath, agentUser = null }) {
    if (!sshHost) throw new Error('sshHost required');
    const daemon = daemonFor(sshHost, agentUser);
    const listing = await daemon.fsList(remotePath || '~');
    const entries = (listing.entries || [])
      .filter((entry) => entry.kind === 'dir')
      .map((entry) => ({ name: entry.name, kind: 'dir' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path: listing.path,
      home: listing.home,
      parent: listing.parent || null,
      hasGit: !!listing.has_git,
      entries,
    };
  }





  async function createRemoteDir({ sshHost, path: remotePath, agentUser = null }) {
    if (!sshHost || !remotePath) {
      throw new Error('sshHost and path are required');
    }
    const daemon = daemonFor(sshHost, agentUser);
    await daemon.ensureReady();
    await daemon.fsMkdir(remotePath, true);
    return { ok: true };
  }

  async function removeWorkspace({ workspaceId }) {
    const tasks = db.prepare('SELECT * FROM tasks WHERE project_id=?').all(workspaceId);
    for (const t of tasks) await hardDeleteTask(t, { deleteLocalBranch: false });
    stmts.deleteProject.run(workspaceId);
    emitState();
  }

  async function initializeWorkspace({ workspaceId }) {
    const row = stmts.getProjectById.get(workspaceId);
    if (!row) throw new Error('workspace not found');
    if (row.is_remote) {
      const daemon = daemonFor(row.ssh_host, row.agent_user);
      const init = await daemon.exec({
        cmd: 'git',
        args: ['init'],
        cwd: row.remote_path,
      });
      if (init.code !== 0) {
        throw new Error(init.stderr.trim() || 'git init failed');
      }
      const branchRes = await daemon.exec({
        cmd: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        cwd: row.remote_path,
      });
      const defaultBranch = branchRes.code === 0
        ? (branchRes.stdout.trim() || row.default_branch || 'main')
        : (row.default_branch || 'main');
      stmts.updateProject.run({
        id: row.id,
        name: row.name,
        default_branch: defaultBranch,
        github_repo: row.github_repo,
        initialized: 1,
        updated_at: nowIso(),
      });
      emitState();
      return;
    }
    await initRepo(row.path);
    const info = await readProjectGitInfo(row.path);
    stmts.updateProject.run({
      id: row.id,
      name: row.name,
      default_branch: info.baseRef ?? info.branch ?? row.default_branch ?? 'main',
      github_repo: info.githubRepo ?? row.github_repo,
      initialized: 1,
      updated_at: nowIso(),
    });
    ensureLocalExclude(row.path);
    emitState();
  }

  async function refreshWorkspace({ workspaceId }) {
    const row = stmts.getProjectById.get(workspaceId);
    if (!row) throw new Error('workspace not found');
    const info = await readProjectGitInfo(row.path);
    stmts.updateProject.run({
      id: row.id,
      name: row.name,
      default_branch: info.baseRef ?? info.branch ?? row.default_branch ?? 'main',
      github_repo: info.githubRepo ?? row.github_repo,
      initialized: info.isGitRepo ? 1 : row.initialized,
      updated_at: nowIso(),
    });
    await refreshWorkspaceMeta(workspaceId);
    emitState();
  }

  async function refreshProjectDefaultBranch({ projectId, threshold }) {
    if (!projectId) throw new Error('refreshProjectDefaultBranch: projectId required');
    const row = stmts.getProjectById.get(projectId);
    const result = await refreshProjectDefaultBranchRow({
      projectRow: row,
      ...(threshold != null ? { threshold } : {}),
      persistDefaultBranch: ({ projectRow, defaultBranch, now }) => {
        stmts.updateProjectDefaultBranch.run({
          id: projectRow.id,
          default_branch: defaultBranch,
          updated_at: now,
        });
      },
    });
    if (result.refreshed) {
      await refreshWorkspaceMeta(projectId);
      emitState();
    }
    return result;
  }

  async function setWorkspaceBaseBranch({ projectId, branch, clear, unset }) {
    const api = createBaseBranchPolicyApi({
      getProjectRow: (id) => stmts.getProjectById.get(id),
      persistPreferredBaseBranch: ({ projectId: id, branch: nextBranch, updatedAt }) => {
        stmts.updateProjectPreferredBaseBranch.run({
          id,
          preferred_base_branch: nextBranch,
          updated_at: updatedAt,
        });
      },
      branchExists: (projectRow, nextBranch) => branchExistsOnProject({
        projectRow,
        branch: nextBranch,
        daemonFactory: daemonFor,
      }),
      emitState,
      now: nowIso,
    });
    if (clear === true || unset === true) {
      return api.clearWorkspaceBaseBranch({ projectId });
    }
    return api.setWorkspaceBaseBranch({ projectId, branch });
  }

  function getEffectiveBaseBranch({ projectId }) {
    return createBaseBranchPolicyApi({
      getProjectRow: (id) => stmts.getProjectById.get(id),
      persistPreferredBaseBranch: ({ projectId: id, branch: nextBranch, updatedAt }) => {
        stmts.updateProjectPreferredBaseBranch.run({
          id,
          preferred_base_branch: nextBranch,
          updated_at: updatedAt,
        });
      },
      branchExists: (projectRow, nextBranch) => branchExistsOnProject({
        projectRow,
        branch: nextBranch,
        daemonFactory: daemonFor,
      }),
      emitState,
      now: nowIso,
    }).getEffectiveBaseBranch({ projectId });
  }

  // Directories we always skip when walking a non-git workspace: they're
  // either VCS metadata or build output / dependency caches that nobody
  // thinks of as "source" when eyeballing the stats bar.
  const STATS_WALK_SKIP_DIRS = new Set([
    '.git', '.hg', '.svn', 'node_modules', '.next', 'dist', 'build', 'out',
    'target', 'coverage', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
    '.pnpm', '.yarn', 'Library', 'release', 'Applications',
  ]);
  // Hard bounds for the non-git stats walk. A project rooted at the user's
  // HOME directory (real case: general chat threads live on a home-dir
  // project) used to sweep the entire disk — npm cache, app-bundle backups,
  // GGUF models — and read every file's contents into memory on every pane
  // mount. Stats are cosmetic; bound them hard.
  const MAX_STATS_WALK_FILES = 20_000;
  const MAX_STATS_WALK_DEPTH = 12;
  /** Files larger than this are skipped, never read. */
  const MAX_STATS_FILE_BYTES = 2 * 1024 * 1024;

  // Extensions we treat as binary/asset and exclude from stats. A PNG counted
  // as "lines" via its random 0x0A bytes is just noise; a committed native
  // binary shouldn't inflate the "code size" reading.
  const STATS_BINARY_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'icns', 'tiff', 'tif',
    'pdf', 'psd', 'ai', 'eps',
    'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
    'wasm', 'exe', 'dll', 'dylib', 'so', 'a', 'o', 'class', 'jar', 'pyc',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'mp3', 'mp4', 'm4a', 'wav', 'flac', 'ogg', 'mov', 'avi', 'mkv', 'webm',
    'sqlite', 'db',
    'asar', 'gguf', 'bin', 'node', 'pak', 'dat', 'dmg', 'iso', 'img', 'pack', 'idx',
  ]);

  function hasBinaryExt(absPath) {
    const base = path.basename(absPath);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return false;
    return STATS_BINARY_EXTS.has(base.slice(dot + 1).toLowerCase());
  }

  function looksBinaryByContent(data) {
    const len = Math.min(data.length, 8192);
    for (let i = 0; i < len; i++) if (data[i] === 0x00) return true;
    return false;
  }

  async function walkNonGitFiles(rootPath) {
    const files = [];
    async function visit(dir, depth) {
      if (files.length >= MAX_STATS_WALK_FILES || depth > MAX_STATS_WALK_DEPTH) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_STATS_WALK_FILES) return;
        if (entry.isDirectory()) {
          // Dot-directories are caches/config (.npm, .node-llama-cpp, .Trash…),
          // never "source files" for the stats bar.
          if (entry.name.startsWith('.')) continue;
          if (STATS_WALK_SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.endsWith('Backups') || entry.name.endsWith('.app')) continue;
          // Electron's asar-aware fs reports .asar archives as directories —
          // never descend into them.
          if (entry.name.endsWith('.asar')) continue;
          await visit(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
    await visit(rootPath, 0);
    return files;
  }

  function resolveStatsTarget({ kind, id }) {
    if (kind === 'task') {
      const task = stmts.getTaskById.get(id);
      if (!task) throw new Error('task not found');
      const project = stmts.getProjectById.get(task.project_id);
      if (!project) throw new Error('workspace not found');
      const remote = !!project.is_remote;
      let targetPath;
      if (task.kind === 'task') {
        const wt = stmts.getWorktreesByTask.all(id)[0];
        targetPath = wt ? wt.path : project.path;
      } else {
        targetPath = project.path;
      }
      return { targetPath, remote };
    }
    const row = stmts.getProjectById.get(id);
    if (!row) throw new Error('workspace not found');
    return { targetPath: row.path, remote: !!row.is_remote };
  }

  async function listStatsFiles(targetPath) {
    try {
      const { stdout } = await git(targetPath, 'ls-files', '-z');
      return stdout
        .split('\0')
        .filter(Boolean)
        .map((rel) => path.join(targetPath, rel));
    } catch {
      // Not a git repo (or git failed) — walk the directory directly.
      return walkNonGitFiles(targetPath);
    }
  }

  // Reads files in parallel with a concurrency cap and invokes onText for
  // each text file. Binary files (extension or null-byte sniff) are skipped.
  // Returns counts of skipped files for diagnostics.
  async function readTextFilesParallel(absFiles, onText) {
    let skippedExt = 0;
    let skippedNull = 0;
    const CONCURRENCY = 8;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const sniff = Buffer.alloc(8192);
        const chunk = Buffer.alloc(64 * 1024);
        while (true) {
          const i = cursor++;
          if (i >= absFiles.length) return;
          const abs = absFiles[i];
          if (hasBinaryExt(abs)) { skippedExt++; continue; }
          let fh;
          try {
            fh = await fs.promises.open(abs, 'r');
            const { size } = await fh.stat();
            if (size > MAX_STATS_FILE_BYTES) { skippedExt++; continue; }
            // Sniff the head BEFORE reading the whole file — the old order
            // buffered entire binaries (npm tarballs, asars) just to discard
            // them, which is what melted RAM on huge trees.
            const head = await fh.read(sniff, 0, Math.min(8192, size), 0);
            if (looksBinaryByContent(sniff.subarray(0, head.bytesRead))) { skippedNull++; continue; }
            let loc = 0;
            let pos = 0;
            while (pos < size) {
              const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
              if (bytesRead <= 0) break;
              for (let j = 0; j < bytesRead; j++) {
                if (chunk[j] === 0x0a) loc++;
              }
              pos += bytesRead;
            }
            onText(abs, size, loc);
          } catch {
          } finally {
            try { await fh?.close(); } catch {}
          }
        }
      })
    );
    return { skippedExt, skippedNull };
  }

  // Returns aggregate stats for text/code files in a workspace or task
  // worktree: file count, total content bytes, total lines. Binary files
  // (by extension or null-byte sniff of the first 8KB) are excluded from
  // all three counts so images and native binaries don't dominate the
  // numbers. Remote workspaces are unsupported for now (no SSH fanout).
  // Coalesce concurrent stats requests and cache briefly: every pane mount
  // fires getStats, and overlapping full-tree sweeps used to stack 5-10 deep.
  const statsInFlight = new Map();
  const statsCache = new Map();
  const STATS_CACHE_TTL_MS = 60_000;

  function cachedStats(key, compute) {
    const hit = statsCache.get(key);
    if (hit && Date.now() - hit.at < STATS_CACHE_TTL_MS) return Promise.resolve(hit.value);
    const pending = statsInFlight.get(key);
    if (pending) return pending;
    const job = Promise.resolve()
      .then(compute)
      .then((value) => {
        statsCache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => { statsInFlight.delete(key); });
    statsInFlight.set(key, job);
    return job;
  }

  function getWorkspaceStats({ kind, id }) {
    return cachedStats(`stats:${kind}:${id}`, () => computeWorkspaceStats({ kind, id }));
  }

  async function computeWorkspaceStats({ kind, id }) {
    const { targetPath, remote } = resolveStatsTarget({ kind, id });
    if (remote) return { files: 0, bytes: 0, loc: 0, remote: true };
    if (!targetPath) return { files: 0, bytes: 0, loc: 0 };
    const absFiles = await listStatsFiles(targetPath);
    let files = 0;
    let bytes = 0;
    let loc = 0;
    await readTextFilesParallel(absFiles, (_abs, fb, fl) => {
      files++;
      bytes += fb;
      loc += fl;
    });
    return { files, bytes, loc };
  }

  // Extended stats: same totals as getWorkspaceStats, plus per-file and
  // per-top-level-directory breakdowns so a UI can show "biggest offenders".
  function getWorkspaceStatsDetail({ kind, id }) {
    return cachedStats(`detail:${kind}:${id}`, () => computeWorkspaceStatsDetail({ kind, id }));
  }

  async function computeWorkspaceStatsDetail({ kind, id }) {
    const { targetPath, remote } = resolveStatsTarget({ kind, id });
    const empty = {
      totals: { files: 0, bytes: 0, loc: 0 },
      topByBytes: [],
      topByLoc: [],
      byDir: [],
      skipped: { binaryExt: 0, binaryNull: 0 },
    };
    if (remote) return { ...empty, remote: true };
    if (!targetPath) return empty;

    const absFiles = await listStatsFiles(targetPath);
    const perFile = [];
    const byDir = new Map();
    const { skippedExt, skippedNull } = await readTextFilesParallel(absFiles, (abs, fb, fl) => {
      const rel = path.relative(targetPath, abs);
      perFile.push({ path: rel, bytes: fb, loc: fl });
      const seg = rel.split(path.sep)[0] || rel;
      const dir = rel.includes(path.sep) ? seg : '(root)';
      const row = byDir.get(dir) ?? { dir, files: 0, bytes: 0, loc: 0 };
      row.files++;
      row.bytes += fb;
      row.loc += fl;
      byDir.set(dir, row);
    });

    const totals = perFile.reduce(
      (acc, f) => {
        acc.files++;
        acc.bytes += f.bytes;
        acc.loc += f.loc;
        return acc;
      },
      { files: 0, bytes: 0, loc: 0 }
    );

    const TOP_N = 10;
    const topByBytes = [...perFile].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_N);
    const topByLoc = [...perFile].sort((a, b) => b.loc - a.loc).slice(0, TOP_N);
    const byDirSorted = [...byDir.values()].sort((a, b) => b.bytes - a.bytes);

    return {
      totals,
      topByBytes,
      topByLoc,
      byDir: byDirSorted,
      skipped: { binaryExt: skippedExt, binaryNull: skippedNull },
    };
  }

  async function deleteBranch({ workspaceId, branch, deleteRemote }) {
    const row = stmts.getProjectById.get(workspaceId);
    if (!row) throw new Error('workspace not found');
    if (row.is_remote) throw new Error('branch delete not supported on remote workspaces yet');
    await deleteGitBranch(row.path, branch, { deleteRemote: !!deleteRemote });
    await refreshWorkspaceMeta(workspaceId);
    emitState();
  }

  async function cloneWorkspace({ repoUrl, localPath }) {
    if (!repoUrl || !localPath) throw new Error('repoUrl and localPath required');
    const resolvedPath = resolveClonePath(localPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    await execFileP('git', ['clone', repoUrl, resolvedPath]);
    return importWorkspace({ workspacePath: resolvedPath });
  }


  // Runs a task's worktree checkout OFF the createTask response path. On
  // success it clears the prep marker, attaches the git watcher, and emits so
  // the freshly-materialized variant reaches the renderer (which then attaches
  // the terminal). On failure it parks the task in an 'error' prep state — the
  // row is kept so the failure is visible and recoverable (delete or retry)
  // rather than a silently vanished create. createWorktreeForTask throws before
  // inserting worktree/variant rows, so a failure leaves nothing partial.
  function beginTaskWorktreePrep({ projectRow, taskRow, baseBranch, agent, skipFetch }) {
    taskPrep.set(taskRow.id, { state: 'preparing' });
    emitState();
    void (async () => {
      try {
        await createWorktreeForTask({ projectRow, taskRow, baseBranch, agent, skipFetch });
        taskPrep.delete(taskRow.id);
        if (projectRow.is_remote) remoteGitPoller.attachTask(taskRow.id);
        else gitWatcher.attachTask(taskRow.id);
        emitState();
      } catch (err) {
        taskPrep.set(taskRow.id, {
          state: 'error',
          error: err && err.message ? String(err.message) : 'worktree setup failed',
        });
        emitState();
      }
    })();
  }

  async function createTask({ workspaceId, input }) {
    const project = stmts.getProjectById.get(workspaceId);
    if (!project) throw new Error('workspace not found');
    const now = nowIso();
    const id = newId('tsk');
    const taskType = input.taskType ? String(input.taskType).trim().toLowerCase() || null : null;
    const taskRow = {
      id,
      project_id: workspaceId,
      kind: 'task',
      name: input.name,
      primary_agent: input.agent,
      is_multi_agent: 0,
      initial_prompt: input.prompt ?? null,
      auto_approve: input.autoApproveEnabled ? 1 : 0,
      task_type: taskType,
      created_at: now,
      updated_at: now,
    };
    warnIfDelegationMissingInitialPrompt({ row: taskRow, delegated: input.delegated === true });
    stmts.insertTask.run(taskRow);
    const wantWorktree = input.useWorktree !== false;
    // Delegated/programmatic creates (orchestrator, Hermes) read the worktree +
    // variant synchronously right after createTask returns (see
    // createDelegatedTaskWithDeps), so they must keep the checkout on the
    // awaited path. Interactive creates — a person tapping "Create" on desktop
    // or mobile — don't; they return immediately with the task marked
    // 'preparing' and run the heavy `git worktree add` in the background,
    // unblocking the "Creating…" spinner. Old renderers that ignore 'preparing'
    // just see the task a beat early; the attach path is gated because no
    // variant exists until the checkout lands, and the task flips to ready or
    // 'error' via a state emit.
    if (wantWorktree && input.delegated !== true) {
      beginTaskWorktreePrep({
        projectRow: project,
        taskRow: { id, name: input.name, task_type: taskType },
        baseBranch: input.baseBranch || project.default_branch || 'main',
        agent: input.agent,
        skipFetch: input.skipWorktreeFetch === true,
      });
      return { id };
    }
    if (wantWorktree) {
      try {
        await createWorktreeForTask({
          projectRow: project,
          taskRow: { id, name: input.name, task_type: taskType },
          baseBranch: input.baseBranch || project.default_branch || 'main',
          agent: input.agent,
          skipFetch: input.skipWorktreeFetch === true,
        });
      } catch (err) {
        // Delegated checkout failed: roll the task row back so a broken
        // delegation doesn't strand an orphan (interactive creates keep the
        // row and surface 'error' instead — the caller there is a human).
        try {
          db.prepare('DELETE FROM variants WHERE task_id=?').run(id);
          db.prepare('DELETE FROM worktrees WHERE task_id=?').run(id);
          stmts.deleteTask.run(id);
        } catch {}
        throw err;
      }
    }
    if (project.is_remote) remoteGitPoller.attachTask(id);
    else gitWatcher.attachTask(id);
    emitState();
    return { id };
  }

  async function createThread({ workspaceId, input }) {
    const project = stmts.getProjectById.get(workspaceId);
    if (!project) throw new Error('workspace not found');
    const now = nowIso();
    const id = newId('thr');
    const conversationId = newId('conv');
    const taskRow = {
      id,
      project_id: workspaceId,
      kind: 'thread',
      name: input.name,
      primary_agent: input.agent,
      is_multi_agent: 0,
      initial_prompt: input.prompt ?? null,
      auto_approve: input.autoApproveEnabled ? 1 : 0,
      task_type: null,
      created_at: now,
      updated_at: now,
    };
    warnIfDelegationMissingInitialPrompt({ row: taskRow, delegated: input.delegated === true });
    stmts.insertTask.run(taskRow);
    stmts.insertConversation.run({
      id: conversationId,
      task_id: id,
      title: 'Main',
      agent: input.agent,
      kind: input.kind === 'chat' ? 'chat' : 'cli',
      is_main: 1,
      is_active: 1,
      display_order: 0,
      created_at: now,
      updated_at: now,
    });
    if (project.is_remote) remoteGitPoller.attachTask(id);
    else gitWatcher.attachTask(id);
    emitState();
    return { id, conversationId };
  }

  // Programmatic thread spawn used by ace-control's streamSpawnAdhoc IPC.
  // A thin alias over createThread that auto-generates a name, defaults
  // auto-approve on (adhoc workers are scripted by an orchestrator — a
  // human can't reliably click through approvals), and returns the
  // fully-resolved streamId so the caller can drive the PTY immediately.
  async function createAdhocThread({ workspaceId, agent, label, kind, prompt }) {
    if (!workspaceId) throw new Error('createAdhocThread: workspaceId required');
    if (!agent) throw new Error('createAdhocThread: agent required');
    const name = label && String(label).trim()
      ? String(label).trim()
      : `adhoc:${agent}:${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const { id: taskId, conversationId } = await createThread({
      workspaceId,
      input: {
        name,
        agent,
        prompt: prompt || null,
        autoApproveEnabled: true,
        delegated: true,
        kind: kind === 'chat' ? 'chat' : 'cli',
      },
    });
    const streamId = `conversation:${conversationId}`;
    return { taskId, conversationId, streamId };
  }

  // Delegation path used by Hermes intake or a controller when spawning a
  // worker to do real feature work. Creates a full task (kind='task')
  // with its own git worktree + branch, then a main conversation inside
  // it so the caller can drive the PTY via conversation:<id>. This is the
  // "correct" delegation — the child lands in an isolated worktree so its
  // commits don't collide with the controller's or a sibling's.
  //
  // Name is derived from an explicit label or a concise goal title so the
  // auto-generated branch (`<slug>-<type>`) is readable in `git log`.
  // Auto-approve is forced on because a scripted sub-agent can't reliably click
  // through human approval prompts. `taskType` flows through to branch naming
  // (see createWorktreeForTask / resolveTaskTypeTag).
  async function createDelegatedTask({ workspaceId, agent, goal, label, prompt, taskType, refreshBase }) {
    return createDelegatedTaskWithDeps({
      workspaceId,
      agent,
      goal,
      label,
      prompt,
      taskType,
      refreshBase,
      refreshProjectDefaultBranchImpl: refreshProjectDefaultBranch,
      getEffectiveBaseBranchImpl: getEffectiveBaseBranch,
      createTaskImpl: createTask,
      getTaskArtifactsImpl: async (taskId) => {
        const worktree = stmts.getWorktreesByTask.all(taskId)[0] || null;
        const variant = worktree ? (stmts.getVariantsByWorktree.all(worktree.id)[0] || null) : null;
        return { worktree, variant };
      },
      now: () => new Date(),
    });
  }

  function shouldInjectHermesWakeBrief({ agentId, project, streamId }) {
    // Wake briefs are auto-wake prompts too — same owner doctrine, same
    // opt-in gate (ACE_AUTO_WAKE_PROMPTS=1). See autoWakePromptsEnabled().
    if (process.env.ACE_AUTO_WAKE_PROMPTS !== '1') return false;
    if (shouldSuppressPersonalHermesAutoPrompt({ agentId, project, streamId })) return false;
    if (!shouldInjectPersonalHermesWakeBrief({ agentId, project, streamId })) return false;
    const last = hermesWakeBriefSentAt.get(streamId) || 0;
    const now = Date.now();
    if (now - last < HERMES_WAKE_BRIEF_COOLDOWN_MS) return false;
    hermesWakeBriefSentAt.set(streamId, now);
    return true;
  }

  function recordHermesWakePromptFingerprint({ conversationId, promptHash, at = nowIso() }) {
    if (!conversationId || !promptHash) return;
    db.prepare(
      `UPDATE conversations
       SET last_auto_wake_prompt_hash = ?,
           last_auto_wake_prompt_at = ?
       WHERE id = ?`
    ).run(promptHash, at, conversationId);
  }

  // Wake brief is pre-rendered in-process from live stream state + the
  // workspace catalog. Hermes only has to post the brief verbatim; no jq,
  // no shell choreography, no tmp files. See electron/wake-brief.cts.
  // Operator/owner labels come from the loaded operators config so the wake
  // copy is config-driven (the migrated owner config renders the legacy
  // copy byte-identically).
  function wakeLabelOptions(identity: any) {
    const op = operatorsLib.getOperator(
      operatorsConfig,
      operatorsLib.normalizeOperatorId(operatorsConfig, identity)
    );
    return {
      operatorLabel: op?.label,
      controlPlaneLabels: operatorsLib
        .listControlPlaneOperators(operatorsConfig)
        .map((entry: any) => entry.label),
      ownerTitle: op?.ownerTitle,
    };
  }

  async function buildHermesWakePrompt({ identity = operatorsConfig.defaultOperatorId } = {}) {
    let streams = [];
    try {
      if (publicApi && typeof publicApi.streamList === 'function') {
        const res = await publicApi.streamList();
        streams = Array.isArray(res?.streams) ? res.streams : [];
      }
    } catch (err) {
      console.warn('[hermes-wake] listStreams failed:', err && err.message ? err.message : err);
    }
    const workspaces = projectWorkspaceSummaries(db, workspaceMetaCache) || [];
    const payload = buildWakeBriefPayload({ streams, workspaces });
    const labelOpts = wakeLabelOptions(identity);
    const briefText = formatWakeBrief(payload, labelOpts);
    return composeHermesWakePrompt({ briefText, identity, ...labelOpts });
  }

  async function waitForStreamAutodeliveryWindow({ streamId, tag, timeoutMs = 15_000 }) {
    if (!publicApi || typeof publicApi.onStreamBus !== 'function') return streamId;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { if (unsub) unsub(); } catch {}
        clearTimeout(timer);
        resolve(streamId);
      };
      const timer = setTimeout(() => {
        console.warn(`${tag} no tab-opened event within ${timeoutMs}ms; falling back to direct delivery`);
        finish();
      }, timeoutMs);
      const unsub = publicApi.onStreamBus('tab-opened', (payload) => {
        if (payload && payload.streamId === streamId) finish();
      });
    });
  }

  async function deliverPromptToReadyStream({
    streamId,
    text,
    tag,
    waitForTabOpen = false,
    requireStable = false,
  }) {
    if (!publicApi || typeof publicApi.streamWaitFor !== 'function') {
      console.error(`${tag} stream methods not yet attached; skipping prompt delivery`);
      return;
    }
    if (waitForTabOpen) {
      await waitForStreamAutodeliveryWindow({ streamId, tag });
    }
    await publicApi.streamWaitFor({
      streamId,
      predicate: { awaitingInput: true },
      timeoutMs: 60_000,
    });
    // Stability re-check: when the caller asks for it (wake-brief auto
    // delivery) verify the stream is *actually* idle right before we type.
    // The state machine can flip to awaiting-input/turn-complete on a
    // brief mid-turn quiet window and then return to busy as more bytes
    // arrive — without this the wake brief can stomp into the middle of a
    // King/Rook turn that's still streaming. Cheap belt-and-braces.
    if (requireStable && typeof publicApi.streamGetState === 'function') {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const snapshot = await publicApi.streamGetState({ streamId });
        const state = snapshot && snapshot.state;
        if (state === 'busy' || state === 'awaiting-approval' || state === 'booting') {
          throw new Error(`stream not idle (state=${state}); skipping wake brief delivery`);
        }
      } catch (err) {
        if (err && err.message && /skipping wake brief/i.test(err.message)) throw err;
        // streamGetState itself failed — best effort, continue to delivery.
      }
    }
    await publicApi.streamSendInput({ streamId, text, mode: 'type' });
    await new Promise((r) => setTimeout(r, 300));
    await publicApi.streamSubmit({ streamId });
  }

  const buildOrchestratorPrompt = composeOrchestratorPrompt;

  function workspaceAbbr(name) {
    const cleaned = String(name || '').replace(/[^A-Za-z0-9\s\-_/]/g, ' ');
    const parts = cleaned.split(/[\s\-_/]+/).filter(Boolean);
    if (parts.length === 0) return 'WS';
    if (parts.length > 1) {
      return parts.slice(0, 4).map((p) => p[0]).join('').toUpperCase();
    }
    return parts[0].slice(0, 3).toUpperCase();
  }

  const ORCHESTRATOR_AGENTS = new Set(
    getAllAgentIds().filter((agentId) => {
      const provider = getProvider(agentId);
      return Boolean(provider?.cli);
    })
  );

  // Workspaces get one controller per agent kind. Claude is the default
  // manual/recovery controller; Hermes remains explicit for intake/personal
  // lanes. Same protocol (ace-cli skill + relay + task run), same env,
  // same per-workspace scope. Task names encode the agent so dedupe doesn't
  // collapse cross-agent controllers together.
  function providerDisplayName(agent) {
    const agentId = String(agent || '').toLowerCase();
    if (agentId === 'claude') return 'Claude';
    const provider = getProvider(agentId);
    if (provider?.name) return provider.name.replace(/\s+Code$/i, '');
    return agentId
      .split(/[^a-z0-9]+/i)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Agent';
  }

  function orchestratorTaskNamePrefix(agent) {
    return `${providerDisplayName(agent)} Orchestrator`;
  }

  function isOrchestratorTaskRow(task) {
    if (!task || task.kind !== 'thread') return false;
    const agentId = String(task.primary_agent || '').toLowerCase();
    if (!ORCHESTRATOR_AGENTS.has(agentId)) return false;
    const namePrefix = orchestratorTaskNamePrefix(agentId);
    return task.name === namePrefix || String(task.name || '').startsWith(`${namePrefix} — `);
  }

  async function startOrchestrator({ workspaceId, agent = 'claude' } = {}) {
    const agentId = String(agent || 'claude').toLowerCase();
    if (!ORCHESTRATOR_AGENTS.has(agentId)) {
      throw new Error(
        `orchestrator agent must be one of ${Array.from(ORCHESTRATOR_AGENTS).join(', ')}`
      );
    }
    const project = stmts.getProjectById.get(workspaceId);
    if (!project) throw new Error('workspace not found');
    await ensureAceOwnedWorkspaceDoctrine(project);

    // Dedupe per (workspace, agent) — reuse any live orchestrator of the same
    // kind, including legacy Hermes task-name aliases, instead of piling them
    // up. Different agents coexist.
    const namePrefix = orchestratorTaskNamePrefix(agentId);
    const existing = agentLanes.findMainOrchestratorTaskForProject(db, workspaceId, agentId);
    if (existing) {
      const archived = agentLanes.archiveDuplicateOrchestratorTasks(db, {
        projectId: workspaceId,
        agent: agentId,
        keepTaskId: existing.id,
      });
      if (archived.archived) {
        console.log(
          `[ace] archived ${archived.archived} duplicate ${agentId} orchestrator task(s) for workspace ${workspaceId}`
        );
      }
      db.prepare('UPDATE tasks SET pinned = 1 WHERE id = ?').run(existing.id);
      const conv = db
        .prepare(
          `SELECT id, last_auto_wake_prompt_hash, last_auto_wake_prompt_at
           FROM conversations
           WHERE task_id = ? AND is_main = 1
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(existing.id);
      const streamId = conv?.id ? `conversation:${conv.id}` : null;
      if (streamId) {
        try {
          await ensureStreamStarted({ streamId, cols: 120, rows: 40 });
        } catch (err) {
          console.warn(`[ace] ensure existing orchestrator stream failed for ${existing.id}:`, err && err.message ? err.message : err);
        }
        const identity = resolvePersonalIdentity(project) || operatorsConfig.defaultOperatorId;
        let existingWakeBrief = false;
        if (publicApi && typeof publicApi.streamReadScreen === 'function') {
          try {
            const screen = await publicApi.streamReadScreen({ streamId, tail: 160 });
            existingWakeBrief = hasExistingHermesWakeBrief(screen?.text || '');
          } catch (err) {
            console.warn(`[ace] wake brief screen check failed for ${existing.id}:`, err && err.message ? err.message : err);
          }
        }
        if (!existingWakeBrief && shouldInjectHermesWakeBrief({ agentId, project, streamId })) {
          const tag = `[${agentId}-orchestrator ${existing.id}]`;
          void (async () => {
            try {
              const text = await buildHermesWakePrompt({ identity });
              const nowMs = Date.now();
              const wakeDecision = shouldDeliverAutoWakePrompt({
                promptText: text,
                lastPromptHash: conv.last_auto_wake_prompt_hash,
                lastPromptAt: conv.last_auto_wake_prompt_at,
                nowMs,
              });
              if (!wakeDecision.deliver) {
                recordHermesWakePromptFingerprint({
                  conversationId: conv.id,
                  promptHash: wakeDecision.promptHash,
                  at: new Date(nowMs).toISOString(),
                });
                return;
              }
              await deliverPromptToReadyStream({
                streamId,
                text,
                tag,
                waitForTabOpen: true,
                requireStable: true,
              });
              recordHermesWakePromptFingerprint({
                conversationId: conv.id,
                promptHash: wakeDecision.promptHash,
              });
            } catch (err) {
              const msg = err && err.message ? err.message : String(err);
              if (/skipping wake brief|write failed for stream|unknown stream|request .* timed out/i.test(msg)) {
                console.warn(`${tag} wake brief skipped:`, msg);
              } else {
                console.error(`${tag} wake brief delivery failed:`, msg);
              }
            }
          })();
        }
      }
      emitState();
      return { taskId: existing.id, reused: true, agent: agentId };
    }

    const prompt = buildOrchestratorPrompt({
      agent: agentId,
      workspaceId,
      workspaceName: project.name,
      workspacePath: project.is_remote ? project.remote_path : project.path,
      githubRepo: project.github_repo || null,
      defaultBranch: project.default_branch || null,
      isRemote: !!project.is_remote,
      // Rehydration block: the builder is fail-open, so a broken index can
      // never block an orchestrator start.
      knowledgeSearch: (p: any) => knowledgeIndex().search(p),
    });

    const abbr = workspaceAbbr(project.name);
    const taskName = `${namePrefix} — ${abbr}`;

    const { id: taskId } = await createThread({
      workspaceId,
      input: {
        name: taskName,
        agent: agentId,
        prompt,
        // Orchestrators always need permission bypass — they delegate and
        // relay across children, none of which should pause for approvals.
        autoApproveEnabled: true,
      },
    });
    agentLanes.archiveDuplicateOrchestratorTasks(db, {
      projectId: workspaceId,
      agent: agentId,
      keepTaskId: taskId,
    });
    db.prepare('UPDATE tasks SET pinned = 1 WHERE id = ?').run(taskId);
    emitState();

    const conv = db
      .prepare(
        `SELECT id FROM conversations WHERE task_id = ? AND is_main = 1 ORDER BY created_at DESC LIMIT 1`
      )
      .get(taskId);
    const expectedStreamId = conv ? `conversation:${conv.id}` : null;

    void (async () => {
      if (!publicApi || typeof publicApi.onStreamBus !== 'function') {
        console.error(`[${agentId}-orchestrator] stream methods not yet attached; skipping auto-deliver`);
        return;
      }
      if (!expectedStreamId) {
        console.error(`[${agentId}-orchestrator] could not resolve conversation id for new thread`);
        return;
      }
      if (shouldSuppressPersonalHermesAutoPrompt({ agentId, project, streamId: expectedStreamId })) return;
      const tag = `[${agentId}-orchestrator ${taskId}]`;
      const streamId = await new Promise((resolve) => {
        // If the stream is somehow already tracked (rare: same-process
        // reentrancy), short-circuit. Otherwise subscribe to tab-opened.
        const timeout = setTimeout(() => {
          if (unsub) unsub();
          console.error(tag, 'no tab-opened event within 180s; user may not have opened the task');
          resolve(null);
        }, 180_000);
        const unsub = publicApi.onStreamBus('tab-opened', (payload) => {
          if (payload && payload.streamId === expectedStreamId) {
            clearTimeout(timeout);
            unsub();
            resolve(expectedStreamId);
          }
        });
      });
      if (!streamId) return;
      console.log(tag, 'stream opened', streamId, '— waiting for awaiting-input');
      try {
        // Use `type` mode so the full prompt text is visible in Hermes'
        // transcript instead of collapsing to "[Pasted text: N lines]".
        // The user wants to see exactly what the orchestrator was asked.
        await deliverPromptToReadyStream({ streamId, text: prompt, tag });
        console.log(tag, 'prompt delivered');
      } catch (err) {
        console.error(tag, 'prompt delivery failed:', err && err.message);
      }
    })();

    return { taskId, agent: agentId };
  }

  // Backwards-compat alias for the existing Hermes-only button IPC. New
  // callers should use startOrchestrator({ workspaceId, agent }).
  async function startHermesOrchestrator({ workspaceId }) {
    return startOrchestrator({ workspaceId, agent: 'hermes' });
  }

  // Persist per-workspace "always-on orchestrator" intent. When enabled, boot
  // auto-spawns the picked orchestrator agent via startOrchestrator (which is
  // idempotent — existing orchestrator threads are reused, not duplicated).
  function setAlwaysOnOrchestrator({ workspaceId, enabled, agent } = {}) {
    if (!workspaceId) throw new Error('workspaceId required');
    const project = stmts.getProjectById.get(workspaceId);
    if (!project) throw new Error('workspace not found');
    const agentId = enabled ? String(agent || 'hermes').toLowerCase() : null;
    if (enabled && !ORCHESTRATOR_AGENTS.has(agentId)) {
      throw new Error(
        `orchestrator agent must be one of ${Array.from(ORCHESTRATOR_AGENTS).join(', ')}`
      );
    }
    if (enabled && agentId === 'claude') {
      throw new Error('Claude is available as an explicit specialist worker, not an always-on workspace orchestrator');
    }
    db.prepare(
      `UPDATE projects SET always_on_orchestrator = ?, always_on_agent = ?, updated_at = ? WHERE id = ?`
    ).run(enabled ? 1 : 0, agentId, new Date().toISOString(), workspaceId);
    emitState();
    return { workspaceId, enabled: !!enabled, agent: agentId };
  }

  function findPersonalIdentityProject(identity) {
    const op = requireOperator(identity);
    const exact = db
      .prepare(
        `SELECT * FROM projects
         WHERE is_personal = 1 AND personal_identity = ?
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(op.id);
    if (exact) return exact;

    if (op.id === operatorsConfig.defaultOperatorId) {
      return db
        .prepare(
          `SELECT * FROM projects
           WHERE is_personal = 1
             AND (personal_identity IS NULL OR personal_identity = '' OR name = 'Rook' OR name = 'Hermes')
           ORDER BY created_at ASC LIMIT 1`
        )
        .get();
    }

    return db
      .prepare(
        `SELECT * FROM projects
         WHERE is_personal = 1 AND name = ?
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(op.label);
  }

  // Resolve (or lazily provision) a private operator workspace (the owner's
  // Rook/King). Operator workspaces are hidden from normal workspaces,
  // always-on, and backed by separate per-workspace HERMES_HOME dirs so
  // their sessions do not collide. Accepts any configured operator id.
  async function getOrCreatePersonalIdentityWorkspace({ identity }: any = {}) {
    const op = requireOperator(identity);
    const id = op.id;
    const existing = findPersonalIdentityProject(id);
    if (existing) {
      if (existing.personal_identity !== id || !existing.is_personal) {
        db.prepare(
          `UPDATE projects SET is_personal = 1, personal_identity = ?, updated_at = ? WHERE id = ?`
        ).run(id, nowIso(), existing.id);
      }
      const fresh = stmts.getProjectById.get(existing.id) || { ...existing, personal_identity: id, is_personal: 1 };
      return ensurePersonalAlwaysOn(fresh, id);
    }

    if (id === operatorsConfig.defaultOperatorId) {
      // Migrate the prior "Hermes HQ" workspace if the user created one
      // manually before this feature existed — promote it instead of
      // stranding a near-identical sibling. Default operator only.
      const legacy = db
        .prepare(
          `SELECT * FROM projects
           WHERE always_on_orchestrator = 1
             AND (always_on_agent = 'hermes' OR always_on_agent IS NULL)
             AND name LIKE 'Hermes HQ%'
           ORDER BY created_at ASC LIMIT 1`
        )
        .get();
      if (legacy) {
        db.prepare(
          `UPDATE projects SET is_personal = 1, personal_identity = ?, updated_at = ? WHERE id = ?`
        ).run(id, nowIso(), legacy.id);
        const fresh = stmts.getProjectById.get(legacy.id) || { ...legacy, is_personal: 1, personal_identity: id };
        return ensurePersonalAlwaysOn(fresh, id);
      }
    }

    const dir = path.join(userDataPath, op.workspaceDirName);
    fs.mkdirSync(dir, { recursive: true });
    const now = nowIso();
    const projectId = newId('prj');
    stmts.insertProject.run({
      id: projectId,
      name: op.label,
      path: dir,
      is_remote: 0,
      ssh_host: null,
      ssh_user: null,
      remote_path: null,
      agent_user: null,
      original_owner: null,
      default_branch: 'main',
      github_repo: null,
      initialized: 0,
      created_at: now,
      updated_at: now,
    });
    db.prepare(
      `UPDATE projects
       SET is_personal = 1,
           personal_identity = ?,
           always_on_orchestrator = 1,
           always_on_agent = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(id, op.agent || 'hermes', now, projectId);
    const fresh = stmts.getProjectById.get(projectId);
    emitState();
    return ensurePersonalAlwaysOn(fresh, id);
  }

  async function getOrCreatePersonalWorkspace() {
    return getOrCreatePersonalIdentityWorkspace({});
  }

  async function ensurePersonalAlwaysOn(project, identity: any) {
    const op = requireOperator(identity ?? project?.personal_identity);
    const id = op.id;
    const opAgent = op.agent || 'hermes';
    ensureHermesHomeForProject({ ...project, personal_identity: id, is_personal: 1 });
    const needsFlagUpdate =
      !project.always_on_orchestrator ||
      project.always_on_agent !== opAgent ||
      project.personal_identity !== id ||
      !project.is_personal;
    if (needsFlagUpdate) {
      db.prepare(
        `UPDATE projects
         SET is_personal = 1,
             personal_identity = ?,
             always_on_orchestrator = 1,
             always_on_agent = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(id, opAgent, nowIso(), project.id);
      emitState();
    }
    const result = await startOrchestrator({
      workspaceId: project.id,
      agent: opAgent,
    });
    const now = nowIso();
    db.prepare(
      `UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND name != ?`
    ).run(op.label, now, project.id, op.label);
    if (result.taskId) {
      agentLanes.upsertPersonalAgentLane(db, {
        operator: op,
        projectId: project.id,
        taskId: result.taskId,
      });
      agentLanes.archiveDuplicateOrchestratorTasks(db, {
        projectId: project.id,
        agent: opAgent,
        keepTaskId: result.taskId,
      });
      db.prepare(
        `UPDATE conversations
         SET title = ?, updated_at = ?
         WHERE task_id = ? AND agent = ? AND is_main = 1`
      ).run(op.label, now, result.taskId, opAgent);
    }
    emitState();
    return {
      workspaceId: project.id,
      taskId: result.taskId,
      agent: opAgent,
      identity: id,
    };
  }

  function seedAgentLanes() {
    return { inserted: 0, updated: 0 };
  }

  function listAgentLanes() {
    return agentLanes.listAgentLanesFromDb(db);
  }

  function listHermesProfiles() {
    const fresh = detectLocalAgents();
    const hermesLaunchable = !!fresh.hermes?.launchable;
    const aceUserDataPaths = hermesProfiles.aceUserDataCandidatePaths(userDataPath);
    return hermesProfiles.listHermesProfilesFromHome(os.homedir(), {
      hermesLaunchable,
      aceUserDataPaths,
    });
  }

  function listOrchestratorTemplates() {
    const fresh = detectLocalAgents();
    for (const id of Object.keys(fresh)) localAgents[id] = fresh[id];
    const native = ['hermes', 'claude', 'codex'].map((agentId) => {
      const entry = localAgents[agentId] || null;
      return {
        id: `native:${agentId}`,
        label: agentId === 'claude' ? 'Claude Code controller' : agentId === 'codex' ? 'Codex controller' : 'Hermes intake lane',
        description:
          agentId === 'claude'
            ? 'Claude Code lane loaded with the Ace controller ruleset.'
            : agentId === 'codex'
              ? 'Codex lane loaded with the Ace controller ruleset.'
              : 'Ace-managed Hermes intake lane with isolated runtime state.',
        agent: agentId,
        providerKind: 'native-orchestrator',
        profileId: null,
        profileHome: null,
        launchable: !!entry?.launchable,
        reason: entry?.reason ?? null,
      };
    });
    const profileTemplates = listHermesProfiles()
      .filter((profile) => profile.id !== 'default')
      .map((profile) => ({
        id: `hermes-profile:${profile.id}`,
        label: profile.label,
        description: profile.source === 'ace-session'
          ? 'Ace persistent Hermes session profile; new lane uses isolated session state.'
          : 'Hermes profile-backed lane with Ace-isolated session state.',
        agent: 'hermes',
        providerKind: 'hermes-profile',
        profileId: profile.id,
        profileHome: profile.homePath,
        source: profile.source ?? null,
        aceUserDataPath: profile.aceUserDataPath ?? null,
        projectId: profile.projectId ?? null,
        taskId: profile.taskId ?? null,
        conversationId: profile.conversationId ?? null,
        modelProvider: profile.modelProvider,
        modelName: profile.modelName,
        terminalCwd: profile.terminalCwd,
        launchable: profile.launchable,
        reason: profile.launchable ? null : 'hermes not found on PATH',
      }));
    return { native, hermesProfiles: listHermesProfiles(), templates: [...native, ...profileTemplates] };
  }

  async function createAgentLane(input = {}) {
    const agentId = String(input.agent || 'hermes').trim().toLowerCase();
    if (!ORCHESTRATOR_AGENTS.has(agentId)) {
      throw new Error(`agent lane must use one of ${Array.from(ORCHESTRATOR_AGENTS).join(', ')}`);
    }
    const providerKind = agentLanes.normalizeAgentLaneProviderKind(input.providerKind || input.provider_kind);
    if (providerKind === 'hermes-profile' && agentId !== 'hermes') {
      throw new Error('Hermes profile lanes must use the hermes agent');
    }
    const templateLabel =
      providerKind === 'hermes-profile'
        ? agentLanes.humanizeProfileId(input.profileId || input.profile_id || 'Hermes')
        : agentId === 'claude'
          ? 'Claude Controller'
          : agentId === 'codex'
            ? 'Codex Controller'
            : 'Hermes Intake Lane';
    const label = agentLanes.normalizeAgentLaneLabel(input.label, templateLabel);
    const laneId = newId('lane');
    const workspaceDir = agentLanes.ensureUniqueDir(agentLanes.laneWorkspaceDir(userDataPath, label));
    fs.mkdirSync(workspaceDir, { recursive: true });

    const now = nowIso();
    const projectId = newId('prj');
    stmts.insertProject.run({
      id: projectId,
      name: label,
      path: workspaceDir,
      is_remote: 0,
      ssh_host: null,
      ssh_user: null,
      remote_path: null,
      agent_user: null,
      original_owner: null,
      default_branch: 'main',
      github_repo: null,
      initialized: 0,
      created_at: now,
      updated_at: now,
    });
    db.prepare(
      `UPDATE projects SET is_personal = 1, personal_identity = ?, updated_at = ? WHERE id = ?`
    ).run(`lane:${laneId}`, now, projectId);

    const started = await startOrchestrator({ workspaceId: projectId, agent: agentId });
    if (!started?.taskId) throw new Error('agent lane orchestrator task was not created');
    const lane = agentLanes.insertAgentLane(db, {
      id: laneId,
      label,
      agent: agentId,
      providerKind,
      profileId: input.profileId ?? input.profile_id ?? null,
      profileHome: input.profileHome ?? input.profile_home ?? null,
      projectId,
      taskId: started.taskId,
      autoStart: input.autoStart !== false,
      isBuiltin: false,
      metadata: {
        createdFrom: providerKind,
      },
      createdAt: now,
      updatedAt: now,
    });

    const conversationId = lane.mainConversationId || agentLanes.pickMainConversation(db, lane.taskId);
    if (conversationId) {
      try {
        await ensureStreamStarted({ streamId: `conversation:${conversationId}`, cols: 120, rows: 40 });
      } catch (err) {
        console.warn(`[ace] created lane ${lane.id} but stream start failed:`, err && err.message ? err.message : err);
      }
    }
    emitState();
    return agentLanes.getAgentLaneById(db, lane.id);
  }

  // Nudge injected once into an agent lane that resumes a prior session on
  // startup so the agent picks its last conversation back up instead of
  // reattaching and idling. Per-lane override via metadata.autoResumePrompt;
  // the nudge only fires when planResume actually resumed (resumeMode ===
  // 'resume'), so brand-new lanes are unaffected.
  // Owner doctrine: automatic wake prompts are OPT-IN. A blanket "continue
  // where you left off" nudge into every auto-started lane costs one full
  // agent turn per lane per app restart (each lane re-reads wiki/board) —
  // pure token burn when nothing changed. Lanes still ATTACH silently
  // (session continuity is free); a lane only gets a wake prompt when it
  // explicitly opts in via metadata.autoResumePrompt, or globally via
  // ACE_AUTO_WAKE_PROMPTS=1.
  function autoWakePromptsEnabled() {
    return process.env.ACE_AUTO_WAKE_PROMPTS === '1';
  }

  const DEFAULT_AUTO_RESUME_PROMPT =
    'Ace restarted and resumed this conversation. Re-read your current state ' +
    '(wiki / Mission Board / the open task) and continue where you left off.';

  function isBuiltinPersonalHermesAgentLane(lane) {
    if (!lane || String(lane.agent || '').toLowerCase() !== 'hermes') return false;
    return lane.providerKind === 'builtin-personal';
  }

  // #1-priority guard: when the configured external data root is unavailable
  // and the user chose "Continue with local data", main.cts sets
  // ACE_DATA_ROOT_FALLBACK=1 before createAceStore. Stale local
  // Rook/King rows must never auto-start agents on such a fallback boot.
  function isDataRootFallbackBoot() {
    return process.env.ACE_DATA_ROOT_FALLBACK === '1';
  }

  async function autoStartAgentLanes() {
    if (isDataRootFallbackBoot()) {
      console.warn(
        '[ace] ACE_DATA_ROOT_FALLBACK=1 — skipping agent-lane auto-start: stale local Rook/King rows must never auto-start agents on a fallback boot'
      );
      return { started: 0 };
    }
    const lanes = agentLanes.listAgentLanesFromDb(db).filter((lane) => lane.autoStart);
    let started = 0;
    for (const lane of lanes) {
      const conversationId = lane.mainConversationId || agentLanes.pickMainConversation(db, lane.taskId);
      if (!conversationId) continue;
      const suppressResumePrompt = isBuiltinPersonalHermesAgentLane(lane);
      const override = suppressResumePrompt ? null : lane.metadata?.autoResumePrompt;
      // Attach silently by default; prompt only on explicit per-lane opt-in
      // (metadata.autoResumePrompt) or the global ACE_AUTO_WAKE_PROMPTS=1.
      const resumePrompt = suppressResumePrompt
        ? null
        : typeof override === 'string' && override.trim()
          ? override.trim()
          : autoWakePromptsEnabled()
            ? DEFAULT_AUTO_RESUME_PROMPT
            : null;
      try {
        await ensureStreamStarted({
          streamId: `conversation:${conversationId}`,
          cols: 120,
          rows: 40,
          ...(resumePrompt ? { launchIntent: { resumePrompt } } : {}),
        });
        started += 1;
      } catch (err) {
        console.warn(`[ace] auto-start agent lane "${lane.label}" (${lane.id}) failed:`, err && err.message ? err.message : err);
      }
    }
    return { started };
  }

  async function autoStartAllOrchestrators() {
    const alwaysOn = await autoStartAlwaysOnOrchestrators();
    const lanes = await autoStartAgentLanes();
    return { alwaysOnStarted: alwaysOn.started, laneStarted: lanes.started };
  }

  // Called once from main.cjs after the Ace controller is attached. Walks
  // eligible workspaces flagged `always_on_orchestrator=1` and spawns (or
  // reuses) their pinned orchestrator. Claude rows are skipped, not migrated.
  // Errors are logged, never thrown — one workspace failing must not block the
  // rest of boot.
  async function autoStartAlwaysOnOrchestrators() {
    if (isDataRootFallbackBoot()) {
      console.warn(
        '[ace] ACE_DATA_ROOT_FALLBACK=1 — skipping always-on orchestrator auto-start: stale local Rook/King rows must never auto-start agents on a fallback boot'
      );
      return { started: 0 };
    }
    const rows = db
      .prepare(
        `SELECT id, name, always_on_agent, is_personal FROM projects WHERE always_on_orchestrator = 1`
      )
      .all();
    const eligibleRows = rows.filter(shouldAutoStartAlwaysOnOrchestrator);
    for (const row of eligibleRows) {
      const agent = String(row.always_on_agent || 'hermes').toLowerCase();
      try {
        await startOrchestrator({ workspaceId: row.id, agent });
      } catch (err) {
        console.warn(
          `[ace] auto-start orchestrator failed for workspace "${row.name}" (${row.id}):`,
          err && err.message
        );
      }
    }
    return { started: eligibleRows.length };
  }

  // Watchdog-tick companion to autoStartAllOrchestrators: restart RUNNING
  // local Hermes streams whose code on disk changed since they spawned
  // (`hermes update` under a live process = guaranteed TypeError on the next
  // lazy import). Resumable streams are killed and re-ensured so planResume
  // picks the stored session back up; streams without a resumable session
  // only get a banner advising a manual restart.
  function restartStaleHermesStreams() {
    return runHermesStaleCodeCheck({
      streams: ptyRegistry.streams,
      currentFingerprint: hermesCodeFingerprint(),
      isResumableStream: (streamId) => {
        if (isPersistentHermesStream(streamId)) return true;
        const owner = resolveStreamOwner(streamId);
        return !!(owner && owner.kind !== 'shell' && owner.sessionId);
      },
      claimRestart: persistentHermesRestartClaim,
      emitBanner: (streamId, chunk) => events.emit('pty:data', { id: streamId, chunk }),
      killStream: killStreamEverywhere,
      restartStream: (streamId, dims) => {
        setTimeout(() => {
          void ensureStreamStarted({ streamId, cols: dims.cols, rows: dims.rows }).catch((err) => {
            events.emit('pty:data', {
              id: streamId,
              chunk: `\x1b[31m[ace] Hermes restart after code update failed: ${err.message}\x1b[0m\r\n`,
            });
            events.emit('pty:exit', { id: streamId, code: -1 });
          });
        }, 1000);
      },
      logger: console,
    });
  }

  let alwaysOnOrchestratorWatchdog: any = null;

  function startAlwaysOnOrchestratorWatchdog({ pollIntervalMs }: any = {}) {
    if (!alwaysOnOrchestratorWatchdog) {
      alwaysOnOrchestratorWatchdog = createAlwaysOnOrchestratorWatchdog({
        rehydrate: async () => {
          const result = await autoStartAllOrchestrators();
          let staleHermes = null;
          try {
            staleHermes = restartStaleHermesStreams();
          } catch (err: any) {
            console.warn(
              '[ace] stale Hermes code check failed:',
              err && err.message ? err.message : err
            );
          }
          return { ...result, staleHermes };
        },
        pollIntervalMs: pollIntervalMs || ALWAYS_ON_ORCHESTRATOR_WATCHDOG_INTERVAL_MS,
        logger: console,
      });
    }
    alwaysOnOrchestratorWatchdog.start();
    return {
      intervalMs: pollIntervalMs || ALWAYS_ON_ORCHESTRATOR_WATCHDOG_INTERVAL_MS,
      snapshot: alwaysOnOrchestratorWatchdog.snapshot(),
    };
  }

  async function createWorktreeForTask({ projectRow, taskRow, baseBranch, agent, skipFetch = false }) {
    // Branch naming is `<slug>-<type>` with a numeric `-2`, `-3` … tail on
    // collision. Closed type vocabulary (see TASK_TYPE_TAG_MAP); missing
    // task_type falls back to `update`. We cap the slug at 40 chars so the
    // tail fits comfortably under common ref-length limits.
    const slug = deriveTaskSlug(taskRow.name, { maxLength: 40 });
    const tag = resolveTaskTypeTag(taskRow.task_type);
    // Avoid `smoke-ui-ui` when the orchestrator already followed the
    // `<slug>-<type>` label convention — if the slug already ends with
    // the tag (on a kebab boundary), don't re-append.
    const baseCandidate = slug === tag || slug.endsWith(`-${tag}`)
      ? slug
      : `${slug}-${tag}`;

    const repoRoot = projectRow.is_remote ? projectRow.remote_path : projectRow.path;
    const joinFn = projectRow.is_remote ? path.posix.join : path.join;
    const worktreeRoot = projectRow.is_remote
      ? joinFn(repoRoot, '.ace', 'worktrees')
      : externalDataRoot.externalWorktreeRootForRepo(repoRoot, userDataPath);
    const remoteBaseBranch = baseBranch || projectRow.default_branch || 'main';
    const baseHygiene = projectRow.is_remote
      ? await (async () => {
          const daemon = daemonFor(projectRow.ssh_host, projectRow.agent_user);
          const gitImpl = async (_cwd, ...args) => {
            const res = await daemon.exec({ cmd: 'git', args, cwd: repoRoot });
            if (res.code !== 0) {
              const err: any = new Error(res.stderr || res.stdout || `git ${args.join(' ')} failed`);
              err.stderr = res.stderr;
              err.stdout = res.stdout;
              throw err;
            }
            return { stdout: res.stdout || '', stderr: res.stderr || '' };
          };
          const tryGitImpl = async (_cwd, ...args) => {
            try {
              return await gitImpl(_cwd, ...args);
            } catch (err) {
              return { stdout: err.stdout || '', stderr: err.stderr || err.message, failed: true };
            }
          };
          return resolveRemoteBaseHygiene({
            repoPath: repoRoot,
            baseBranch: remoteBaseBranch,
            gitImpl,
            tryGitImpl,
            skipFetch,
          });
        })()
      : await resolveRemoteBaseHygiene({
          repoPath: repoRoot,
          baseBranch: remoteBaseBranch,
          gitImpl: git,
          tryGitImpl: tryGit,
          skipFetch,
        });
    if (baseHygiene.ok !== true) {
      const err: any = new Error(`createWorktreeForTask: base hygiene blocked (${baseHygiene.blocker || 'unknown'})`);
      err.code = baseHygiene.blocker || 'base_hygiene_blocked';
      err.details = baseHygiene;
      throw err;
    }

    // Collision check: try the base candidate first, then `-2`, `-3`, up to
    // `-20`. We reject if either the ref already exists or the worktree dir
    // is on disk. Remote workspaces share the same logic via daemon.exec.
    const refExists = async (candidate) => {
      if (projectRow.is_remote) {
        const daemon = daemonFor(projectRow.ssh_host, projectRow.agent_user);
        const res = await daemon.exec({
          cmd: 'git',
          args: ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`],
          cwd: repoRoot,
        });
        return res.code === 0;
      }
      const res = await tryGit(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${candidate}`);
      return !res.failed;
    };
    const pathExists = async (p) => {
      if (projectRow.is_remote) {
        const daemon = daemonFor(projectRow.ssh_host, projectRow.agent_user);
        // `test -e` exits 0 when the path exists. Any non-zero (including
        // 1 for "doesn't exist") is treated as not-present.
        const res = await daemon.exec({ cmd: 'test', args: ['-e', p], cwd: repoRoot });
        return res.code === 0;
      }
      return fs.existsSync(p);
    };

    const { branch, worktreePath } = await computeFreeBranchName({
      baseCandidate,
      refExists,
      pathExists,
      worktreeJoin: (name) => joinFn(worktreeRoot, name),
      maxTries: 20,
    });

    if (projectRow.is_remote) {
      const daemon = daemonFor(projectRow.ssh_host, projectRow.agent_user);
      await daemon.fsMkdir(worktreeRoot, true);
      const res = await daemon.exec({
        cmd: 'git',
        args: ['worktree', 'add', '-b', branch, worktreePath, baseHygiene.checkoutSha || baseHygiene.branchPoint],
        cwd: repoRoot,
      });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || 'remote worktree add failed');
      }
    } else {
      await addWorktree(repoRoot, branch, worktreePath, baseHygiene.checkoutSha || baseHygiene.branchPoint, { skipFetch: true });
    }
    if (projectRow.is_remote) {
      const daemon = daemonFor(projectRow.ssh_host, projectRow.agent_user);
      await ensureWorktreeDoctrineFiles({
        worktreePath,
        exists: async (fullPath) => {
          const res = await daemon.exec({ cmd: 'test', args: ['-e', fullPath], cwd: worktreePath });
          return res.code === 0;
        },
        writeFile: async (fullPath, content) => daemon.fsWrite(fullPath, content),
        seedMissing: true,
      });
    } else {
      await ensureWorktreeDoctrineFiles({
        worktreePath,
        exists: async (fullPath) => fs.existsSync(fullPath),
        writeFile: async (fullPath, content) => fs.writeFileSync(fullPath, content, 'utf8'),
        seedMissing: true,
      });
    }
    const worktreeId = newId('wt');
    const now = nowIso();
    stmts.insertWorktree.run({
      id: worktreeId,
      task_id: taskRow.id,
      project_id: projectRow.id,
      display_name: slug,
      branch,
      base_branch: baseHygiene.baseBranch,
      remote_base_ref: baseHygiene.remoteBaseRef,
      base_sha: baseHygiene.remoteBaseSha,
      local_base_sha: baseHygiene.localBaseSha,
      local_ahead_by: baseHygiene.localAheadBy,
      local_behind_by: baseHygiene.localBehindBy,
      branch_point: baseHygiene.branchPoint,
      path: worktreePath,
      created_at: now,
    });
    const variantId = newId('var');
    stmts.insertVariant.run({
      id: variantId,
      worktree_id: worktreeId,
      task_id: taskRow.id,
      name: deriveStreamLabelForTask({ taskName: taskRow.name, agent }) || agent,
      agent,
      branch,
      review_mode: 0,
      review_prompt: null,
      attached_at: now,
      order_index: stmts.getVariantsByWorktree.all(worktreeId).length,
    });



    return { worktreeId, variantId, baseHygiene };
  }

  // Parse `git diff --numstat` output into {files, added, deleted, paths}.
  // Lines are "<added>\t<deleted>\t<path>"; binary files show "-\t-\t<path>".
  function parseNumstat(stdout) {
    const out = { files: 0, added: 0, deleted: 0, paths: [] };
    const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\t/);
      if (parts.length < 3) continue;
      const [a, d, ...rest] = parts;
      const addN = a === '-' ? 0 : parseInt(a, 10) || 0;
      const delN = d === '-' ? 0 : parseInt(d, 10) || 0;
      out.files += 1;
      out.added += addN;
      out.deleted += delN;
      out.paths.push(rest.join('\t'));
    }
    return out;
  }

  // Ace-side verification that a delegated task has produced real changes
  // in its worktree. Runs three diffs: committed (base..HEAD), staged, and
  // unstaged. Returns a structured verdict the orchestrator uses to gate DONE
  // acceptance. Remote-aware via daemonFor, same as createWorktreeForTask.
  async function verifyTaskProgress({ taskId } = {}) {
    if (!taskId) throw new Error('verifyTaskProgress: taskId required');
    const task = stmts.getTaskById.get(taskId);
    if (!task) throw new Error('verifyTaskProgress: task not found');
    const wt = stmts.getWorktreesByTask.all(taskId)[0];
    if (!wt) {
      return {
        hasChanges: false,
        hasWorktree: false,
        reason: 'no worktree attached to this task',
        filesChanged: 0,
        linesAdded: 0,
        linesDeleted: 0,
        changedPaths: [],
        baseBranch: null,
        branch: null,
        worktreePath: null,
      };
    }
    const project = stmts.getProjectById.get(task.project_id);
    const base = wt.base_sha || wt.remote_base_ref || wt.branch_point || wt.base_branch || project?.default_branch || 'main';

    const diffs = [
      ['committed', ['diff', '--numstat', `${base}..HEAD`]],
      ['staged', ['diff', '--numstat', '--cached']],
      ['unstaged', ['diff', '--numstat']],
    ];
    const agg = { files: 0, added: 0, deleted: 0, paths: new Set() };
    if (project && project.is_remote) {
      const daemon = daemonFor(project.ssh_host, project.agent_user);
      for (const [, args] of diffs) {
        const res = await daemon.exec({ cmd: 'git', args, cwd: wt.path });
        if (res.code === 0) {
          const p = parseNumstat(res.stdout);
          agg.files += p.files;
          agg.added += p.added;
          agg.deleted += p.deleted;
          for (const path of p.paths) agg.paths.add(path);
        }
      }
    } else {
      for (const [, args] of diffs) {
        const res = await tryGit(wt.path, ...args);
        if (!res.failed) {
          const p = parseNumstat(res.stdout);
          agg.files += p.files;
          agg.added += p.added;
          agg.deleted += p.deleted;
          for (const path of p.paths) agg.paths.add(path);
        }
      }
    }
    return {
      hasChanges: agg.files > 0 || agg.added > 0 || agg.deleted > 0,
      hasWorktree: true,
      filesChanged: agg.files,
      linesAdded: agg.added,
      linesDeleted: agg.deleted,
      changedPaths: Array.from(agg.paths),
      baseBranch: wt.base_branch || base,
      baseSha: wt.base_sha || null,
      remoteBaseRef: wt.remote_base_ref || null,
      diffBase: base,
      branch: wt.branch,
      worktreePath: wt.path,
    };
  }

  async function createWorktree({ workItemId, input }) {
    const task = stmts.getTaskById.get(workItemId);
    if (!task) throw new Error('task not found');
    const project = stmts.getProjectById.get(task.project_id);
    if (!project) throw new Error('workspace not found');
    const existingCount = stmts.getWorktreesByTask.all(workItemId).length;
    // Zero existing worktrees means this is the FIRST worktree for the task —
    // i.e. a retry of a create whose async checkout failed (multi-agent "add
    // agent" always runs against a task that already has one). Route retries
    // through the same async prep so they return fast and re-drive the
    // preparing→ready/error banner instead of blocking on the checkout.
    if (existingCount === 0) {
      beginTaskWorktreePrep({
        projectRow: project,
        taskRow: { id: workItemId, name: input.name || task.name, task_type: task.task_type },
        baseBranch: input.branch || project.default_branch || 'main',
        agent: input.agent || task.primary_agent,
      });
      return { preparing: true };
    }
    const { worktreeId, variantId, baseHygiene } = await createWorktreeForTask({
      projectRow: project,
      taskRow: { id: workItemId, name: input.name },
      baseBranch: input.branch || project.default_branch || 'main',
      agent: input.agent,
    });
    if (existingCount >= 1) {
      stmts.updateTaskMultiAgent.run({ id: workItemId, updated_at: nowIso() });
    }
    emitState();
    return { worktreeId, variantId, baseHygiene };
  }

  async function deleteWorktree({ worktreeId, deleteLocalBranch = true, deleteRemoteBranch = false }) {
    const wt = stmts.getWorktreeById.get(worktreeId);
    if (!wt) return;
    const project = stmts.getProjectById.get(wt.project_id);
    const variants = stmts.getVariantsByWorktree.all(worktreeId);
    for (const v of variants) {
      const streamId = `variant:${v.id}`;
      const remote = remoteStreams.get(streamId);
      if (remote) {
        try {
          daemonFor(remote.host, remote.agentUser).killPty(remote.daemonPtyId);
        } catch {}
        daemonPtyToStream.delete(daemonPtyKey(remote.host, remote.agentUser, remote.daemonPtyId));
        remoteStreams.delete(streamId);
        streamStates.remove(streamId);
      } else {
        ptyRegistry.killStream(streamId);
      }
    }
    if (project) {
      if (project.is_remote) {
        const daemon = daemonFor(project.ssh_host, project.agent_user);
        await daemon.exec({
          cmd: 'git',
          args: ['worktree', 'remove', '--force', wt.path],
          cwd: project.remote_path,
        });
        if (deleteLocalBranch) {
          await daemon.exec({
            cmd: 'git',
            args: ['branch', '-D', wt.branch],
            cwd: project.remote_path,
          });
        }
        if (deleteRemoteBranch) {
          await daemon.exec({
            cmd: 'git',
            args: ['push', 'origin', '--delete', wt.branch],
            cwd: project.remote_path,
          });
        }
      } else {
        await removeWorktreeWithBranch(project.path, wt.path, wt.branch, {
          deleteLocalBranch,
          deleteRemoteBranch,
        });
      }
    }
    stmts.deleteWorktree.run(worktreeId);
    emitState();
  }

  async function removeVariant({ variantId }) {
    const variant = stmts.getVariantById.get(variantId);
    if (!variant) return;
    ptyRegistry.killStream(`variant:${variantId}`);
    stmts.deleteVariant.run(variantId);

    const siblings = stmts.getVariantsByWorktree.all(variant.worktree_id);
    if (siblings.length === 0) {

    }
    emitState();
  }

  function reorderVariants({ worktreeId, variantIds }) {
    if (!Array.isArray(variantIds) || variantIds.length === 0) return;
    const siblings = stmts.getVariantsByWorktree.all(worktreeId);
    const siblingIds = new Set(siblings.map((v) => v.id));
    const ordered = variantIds.filter((id) => siblingIds.has(id));
    for (const v of siblings) {
      if (!ordered.includes(v.id)) ordered.push(v.id);
    }
    const tx = db.transaction(() => {
      ordered.forEach((id, idx) => stmts.setVariantOrderIndex.run(idx, id));
    });
    tx();
    emitState();
  }

  function reorderConversations({ taskId, conversationIds }) {
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) return;
    const siblings = stmts.getConversationsByTask.all(taskId);
    const siblingIds = new Set(siblings.map((c) => c.id));
    const ordered = conversationIds.filter((id) => siblingIds.has(id));
    for (const c of siblings) {
      if (!ordered.includes(c.id)) ordered.push(c.id);
    }
    const tx = db.transaction(() => {
      ordered.forEach((id, idx) => stmts.setConversationOrderIndex.run(idx, id));
    });
    tx();
    emitState();
  }

  function reorderWorkspaces({ workspaceIds }) {
    const result = reorderWorkspacesInDb(db, workspaceIds);
    emitState();
    return result;
  }

  function reorderTasksInWorkspace({ workspaceId, taskIds }) {
    const result = reorderTasksInWorkspaceInDb(db, workspaceId, taskIds);
    emitState();
    return result;
  }

  async function attachVariant({ workItemId, input }) {
    const wt = stmts.getWorktreeById.get(input.worktreeId);
    if (!wt) throw new Error('worktree not found');
    const variantId = newId('var');
    const now = nowIso();
    stmts.insertVariant.run({
      id: variantId,
      worktree_id: wt.id,
      task_id: workItemId,
      name: input.agent,
      agent: input.agent,
      branch: wt.branch,
      review_mode: input.reviewMode ? 1 : 0,
      review_prompt: input.reviewPrompt ?? null,
      attached_at: now,
      order_index: stmts.getVariantsByWorktree.all(wt.id).length,
    });
    stmts.updateTaskMultiAgent.run({ id: workItemId, updated_at: now });

    emitState();
    return { variantId };
  }

  function killStreamEverywhere(streamId) {
    clearAgentResumeState(streamId);
    const remote = remoteStreams.get(streamId);
    if (remote) {
      try {
        daemonFor(remote.host, remote.agentUser).killPty(remote.daemonPtyId);
      } catch {}
      daemonPtyToStream.delete(daemonPtyKey(remote.host, remote.agentUser, remote.daemonPtyId));
      remoteStreams.delete(streamId);
      streamStates.remove(streamId);
      return;
    }
    ptyRegistry.killStream(streamId);
  }

  async function hardDeleteTask(taskRow, opts) {
    const removeWorktree = opts.removeWorktree ?? true;
    const deleteLocalBranch = opts.deleteLocalBranch ?? true;
    const deleteRemoteBranch = opts.deleteRemoteBranch ?? false;
    const worktrees = stmts.getWorktreesByTask.all(taskRow.id);
    const project = stmts.getProjectById.get(taskRow.project_id);
    for (const wt of worktrees) {
      const variants = stmts.getVariantsByWorktree.all(wt.id);
      for (const v of variants) killStreamEverywhere(`variant:${v.id}`);
      if (project) {
        if (project.is_remote) {
          const daemon = daemonFor(project.ssh_host, project.agent_user);
          if (removeWorktree) {
            await daemon.exec({
              cmd: 'git',
              args: ['worktree', 'remove', '--force', wt.path],
              cwd: project.remote_path,
            });
            if (deleteLocalBranch) {
              await daemon.exec({
                cmd: 'git',
                args: ['branch', '-D', wt.branch],
                cwd: project.remote_path,
              });
            }
          }
          if (deleteRemoteBranch) {
            await daemon.exec({
              cmd: 'git',
              args: ['push', 'origin', '--delete', wt.branch],
              cwd: project.remote_path,
            });
          }
        } else {
          await removeWorktreeWithBranch(project.path, wt.path, wt.branch, {
            deleteLocalBranch,
            deleteRemoteBranch,
            removeWorktree,
          });
        }
      }
    }
    const convs = stmts.getConversationsByTask.all(taskRow.id);
    for (const c of convs) killStreamEverywhere(`conversation:${c.id}`);
    // Kill every shell tab belonging to this task — the primary stream
    // (`shell:taskId`) plus any additional terminal tabs (`shell:taskId:N`).
    const shellBase = `shell:${taskRow.id}`;
    const shellIds = new Set([shellBase]);
    for (const id of ptyRegistry.streams.keys()) {
      if (id === shellBase || id.startsWith(`${shellBase}:`)) shellIds.add(id);
    }
    for (const id of remoteStreams.keys()) {
      if (id === shellBase || id.startsWith(`${shellBase}:`)) shellIds.add(id);
    }
    for (const id of shellIds) killStreamEverywhere(id);
    stmts.deleteTask.run(taskRow.id);
  }

  async function deleteTask({
    taskId,
    deleteLocalBranch = true,
    deleteRemoteBranch = false,
    removeWorktree = true,
  }) {
    const task = stmts.getTaskById.get(taskId);
    if (!task) return;
    gitWatcher.detachTask(taskId);
    remoteGitPoller.detachTask(taskId);
    await hardDeleteTask(task, { deleteLocalBranch, deleteRemoteBranch, removeWorktree });
    emitState();
  }

  async function archiveTask({ taskId, prUrl = null, mergedAt } = {}) {
    dropLegacyArchiveDisableTriggers(db);
    archiveTaskRow({
      db,
      getTaskById: (id) => stmts.getTaskById.get(id),
      taskId,
      prUrl,
      mergedAt,
    });


    gitWatcher.detachTask(taskId);
    remoteGitPoller.detachTask(taskId);
    emitState();
  }

  async function unarchiveTask({ taskId }) {
    const task = stmts.getTaskById.get(taskId);
    if (!task) throw new Error('task not found');
    db.prepare(
      'UPDATE tasks SET archived_at = NULL, archived_pr_url = NULL, updated_at = ? WHERE id = ?'
    ).run(nowIso(), taskId);
    const project = stmts.getProjectById.get(task.project_id);
    if (project) {
      if (project.is_remote) remoteGitPoller.attachTask(taskId);
      else gitWatcher.attachTask(taskId);
    }
    emitState();
  }







  function setTaskAutoApprove({ taskId, autoApproveEnabled }) {
    const task = stmts.getTaskById.get(taskId);
    if (!task) throw new Error('task not found');
    db.prepare(
      'UPDATE tasks SET auto_approve = ?, updated_at = ? WHERE id = ?'
    ).run(autoApproveEnabled ? 1 : 0, nowIso(), taskId);
    emitState();
    return { autoApproveEnabled: !!autoApproveEnabled };
  }

  const getTaskSpec = createGetTaskSpec({ stmts, db, workspaceMetaCache });


  function createConversation({ workItemId, agent, kind }) {
    const task = stmts.getTaskById.get(workItemId);
    if (!task) throw new Error('task not found');
    const count = stmts.countConversations.get(workItemId).n;
    const id = newId('conv');
    const now = nowIso();
    const effectiveAgent = agent ?? task.primary_agent;
    const effectiveKind = kind === 'chat' || kind === 'cli' ? kind : 'cli';
    stmts.deactivateConversations.run(workItemId);
    stmts.insertConversation.run({
      id,
      task_id: workItemId,
      title: `Chat ${count + 1}`,
      agent: effectiveAgent,
      kind: effectiveKind,
      is_main: 0,
      is_active: 1,
      display_order: count,
      created_at: now,
      updated_at: now,
    });
    emitState();
    return { id };
  }

  function closeConversation({ workItemId, conversationId }) {
    ptyRegistry.killStream(`conversation:${conversationId}`);
    stmts.deleteConversation.run(conversationId);
    try {
      events.emit('conversation:closed', { conversationId, workItemId });
    } catch {}

    const remaining = stmts.getConversationsByTask.all(workItemId);
    if (remaining.length > 0) {
      stmts.deactivateConversations.run(workItemId);
      stmts.activateConversation.run(nowIso(), remaining[0].id);
    }
    emitState();
  }

  function activateConversation({ workItemId, conversationId }) {
    stmts.deactivateConversations.run(workItemId);
    stmts.activateConversation.run(nowIso(), conversationId);
    emitState();
  }

  const scratchTabSelect = db.prepare(
    `SELECT id, kind, title, url, favicon, content, saved_path, dirty, order_index, is_active
     FROM scratch_tabs WHERE task_id=? ORDER BY order_index ASC`
  );
  const scratchTabDeleteAll = db.prepare('DELETE FROM scratch_tabs WHERE task_id=?');
  const scratchTabInsert = db.prepare(
    `INSERT INTO scratch_tabs (id, task_id, kind, title, url, favicon, content, saved_path, dirty, order_index, is_active, created_at, updated_at)
     VALUES (@id, @task_id, @kind, @title, @url, @favicon, @content, @saved_path, @dirty, @order_index, @is_active, @created_at, @updated_at)`
  );
  const saveScratchTabsTx = db.transaction(({ taskId, tabs, activeId }) => {
    scratchTabDeleteAll.run(taskId);
    const now = nowIso();
    for (let i = 0; i < tabs.length; i += 1) {
      const t = tabs[i] || {};
      if (!t.id || !t.kind) continue;
      scratchTabInsert.run({
        id: String(t.id),
        task_id: taskId,
        kind: t.kind === 'notes' ? 'notes' : 'browser',
        title: String(t.title || ''),
        url: t.url == null ? null : String(t.url),
        favicon: t.favicon == null ? null : String(t.favicon),
        content: t.content == null ? null : String(t.content),
        saved_path: t.savedPath == null ? null : String(t.savedPath),
        dirty: t.dirty ? 1 : 0,
        order_index: i,
        is_active: t.id === activeId ? 1 : 0,
        created_at: now,
        updated_at: now,
      });
    }
  });

  function listScratchTabs({ taskId }) {
    const rows = scratchTabSelect.all(taskId);
    const tabs = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      url: r.url || undefined,
      favicon: r.favicon || null,
      content: r.content == null ? undefined : r.content,
      savedPath: r.saved_path,
      dirty: !!r.dirty,
    }));
    const activeRow = rows.find((r) => r.is_active === 1);
    return { tabs, activeId: activeRow ? activeRow.id : null };
  }

  function saveScratchTabs({ taskId, tabs, activeId }) {
    if (!taskId) return { ok: false };
    const row = stmts.getTaskById.get(taskId);
    if (!row) return { ok: false };
    saveScratchTabsTx({ taskId, tabs: Array.isArray(tabs) ? tabs : [], activeId: activeId || null });
    return { ok: true };
  }

  const editorFileSelect = db.prepare(
    `SELECT path, order_index, is_active
     FROM editor_open_files WHERE task_id=? ORDER BY order_index ASC`
  );
  const editorFileDeleteAll = db.prepare('DELETE FROM editor_open_files WHERE task_id=?');
  const editorFileInsert = db.prepare(
    `INSERT INTO editor_open_files (task_id, path, order_index, is_active, opened_at)
     VALUES (@task_id, @path, @order_index, @is_active, @opened_at)`
  );
  const saveEditorFilesTx = db.transaction(({ taskId, openFiles, activeFile }) => {
    editorFileDeleteAll.run(taskId);
    const now = nowIso();
    for (let i = 0; i < openFiles.length; i += 1) {
      const p = openFiles[i];
      if (!p || typeof p !== 'string') continue;
      editorFileInsert.run({
        task_id: taskId,
        path: p,
        order_index: i,
        is_active: p === activeFile ? 1 : 0,
        opened_at: now,
      });
    }
  });

  function listEditorOpenFiles({ taskId }) {
    const rows = editorFileSelect.all(taskId);
    const openFiles = rows.map((r) => r.path);
    const activeRow = rows.find((r) => r.is_active === 1);
    return { openFiles, activeFile: activeRow ? activeRow.path : null };
  }

  function saveEditorOpenFiles({ taskId, openFiles, activeFile }) {
    if (!taskId) return { ok: false };
    const row = stmts.getTaskById.get(taskId);
    if (!row) return { ok: false };
    saveEditorFilesTx({
      taskId,
      openFiles: Array.isArray(openFiles) ? openFiles : [],
      activeFile: activeFile || null,
    });
    return { ok: true };
  }

  function ensureWorkItemSession() {
    return { sessionId: null };
  }
  function ensureVariantSession() {
    return { sessionId: null };
  }




  function resolveStreamOwner(streamId) {
    const match = /^(variant|conversation|shell):(.+)$/.exec(String(streamId ?? ''));
    if (!match) return null;
    const [, kind, rawId] = match;
    // Shell streams may carry a trailing `:N` ordinal for the 2nd/3rd/...
    // terminal tab within a task (e.g. `shell:abc123:2`). Each ordinal gets
    // its own PTY, but they all resolve to the same task owner.
    const id = kind === 'shell' ? rawId.replace(/:\d+$/, '') : rawId;
    if (kind === 'variant') {
      const variant = stmts.getVariantById.get(id);
      if (!variant) return null;
      const wt = stmts.getWorktreeById.get(variant.worktree_id);
      if (!wt) return null;
      const project = stmts.getProjectById.get(wt.project_id);
      if (!project) return null;
      const task = stmts.getTaskById.get(variant.task_id);
      const autoApprove = !!(task && task.auto_approve);
      return {
        kind,
        id,
        agent: variant.agent,
        cwd: wt.path,
        project,
        autoApprove,
        sessionId: variant.session_id ?? null,
      };
    }
    if (kind === 'conversation') {
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
      if (!conv) return null;
      const task = stmts.getTaskById.get(conv.task_id);
      if (!task) return null;
      const project = stmts.getProjectById.get(task.project_id);
      if (!project) return null;
      let cwd;
      if (task.kind === 'task') {
        const wt = stmts.getWorktreesByTask.all(conv.task_id)[0];
        cwd = wt ? wt.path : project.path;
      } else {
        cwd = project.is_remote ? project.remote_path : project.path;
      }
      const autoApprove = !!task.auto_approve;
      const lane = agentLanes.getAgentLaneByTaskId(db, task.id);
      return {
        kind,
        id,
        agent: conv.agent,
        cwd,
        project,
        autoApprove,
        sessionId: conv.session_id ?? null,
        agentLane: lane,
      };
    }

    const task = stmts.getTaskById.get(id);
    if (!task) return null;
    const project = stmts.getProjectById.get(task.project_id);
    if (!project) return null;
    let cwd;
    if (task.kind === 'task') {
      const wt = stmts.getWorktreesByTask.all(id)[0];
      cwd = wt ? wt.path : (project.is_remote ? project.remote_path : project.path);
    } else {
      cwd = project.is_remote ? project.remote_path : project.path;
    }
    return { kind, id, agent: 'shell', cwd, project, autoApprove: false, sessionId: null };
  }

  function resolveConversationCwd(conversationId) {
    const owner = resolveStreamOwner(`conversation:${conversationId}`);
    return owner ? owner.cwd : null;
  }

  // Structured context for a running (or about-to-run) agent stream: workspace,
  // task, worktree, branch, repo root. Used (a) to inject ACE_* env vars
  // into every spawned PTY so agents boot knowing where they are, and (b) to
  // power `ace context` so any agent can read its own context on
  // demand. Returns null for unknown streamIds.
  function getContextForStream({ streamId } = {}) {
    const sid = String(streamId || '');
    if (!sid) return null;
    const owner = resolveStreamOwner(sid);
    if (!owner) return null;
    const { kind, id, agent, cwd, project, sessionId, agentLane } = owner;
    const out = {
      streamId: sid,
      kind,
      id,
      agent,
      cwd,
      workspaceId: project?.id ?? null,
      workspaceName: project?.name ?? null,
      repoRoot: project?.is_remote ? (project.remote_path ?? null) : (project?.path ?? null),
      isRemote: !!project?.is_remote,
      defaultBranch: project?.default_branch ?? null,
      githubRepo: project?.github_repo ?? null,
      githubProjectIndexCommand: 'ace github tracked-projects --json',
      isPersonal: !!project?.is_personal,
      personalIdentity: resolvePersonalIdentity(project),
      agentLaneId: agentLane?.id ?? null,
      agentLaneLabel: agentLane?.label ?? null,
      agentLaneProfileId: agentLane?.profileId ?? null,
      sessionId: sessionId ?? null,
      taskId: null,
      conversationId: null,
      parentTaskId: null,
      rootTaskId: null,
      isRootGoalAgent: null,
      isInternalSubagent: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      remoteBaseRef: null,
      baseSha: null,
      baseHygiene: null,
    };
    if (kind === 'variant') {
      const variant = stmts.getVariantById.get(id);
      if (variant) {
        out.taskId = variant.task_id;
        const wt = stmts.getWorktreeById.get(variant.worktree_id);
        if (wt) {
          out.worktreePath = wt.path;
          out.branch = wt.branch;
          out.baseBranch = wt.base_branch;
          out.remoteBaseRef = wt.remote_base_ref ?? null;
          out.baseSha = wt.base_sha ?? null;
          out.baseHygiene = {
            baseBranch: wt.base_branch ?? null,
            remoteBaseRef: wt.remote_base_ref ?? null,
            remoteBaseSha: wt.base_sha ?? null,
            localBaseSha: wt.local_base_sha ?? null,
            localAheadBy: Number(wt.local_ahead_by || 0),
            localBehindBy: Number(wt.local_behind_by || 0),
            branchPoint: wt.branch_point ?? null,
            ok: true,
          };
        }
      }
    } else if (kind === 'conversation') {
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
      if (conv) {
        out.conversationId = conv.id;
        out.taskId = conv.task_id;
        const task = stmts.getTaskById.get(conv.task_id);
        if (task && task.kind === 'task') {
          const wt = stmts.getWorktreesByTask.all(conv.task_id)[0];
          if (wt) {
            out.worktreePath = wt.path;
            out.branch = wt.branch;
            out.baseBranch = wt.base_branch;
            out.remoteBaseRef = wt.remote_base_ref ?? null;
            out.baseSha = wt.base_sha ?? null;
            out.baseHygiene = {
              baseBranch: wt.base_branch ?? null,
              remoteBaseRef: wt.remote_base_ref ?? null,
              remoteBaseSha: wt.base_sha ?? null,
              localBaseSha: wt.local_base_sha ?? null,
              localAheadBy: Number(wt.local_ahead_by || 0),
              localBehindBy: Number(wt.local_behind_by || 0),
              branchPoint: wt.branch_point ?? null,
              ok: true,
            };
          }
        }
      }
    } else if (kind === 'shell' || kind === 'task') {
      const task = stmts.getTaskById.get(id);
      if (task) {
        out.taskId = task.id;
        if (task.kind === 'task') {
          const wt = stmts.getWorktreesByTask.all(id)[0];
          if (wt) {
            out.worktreePath = wt.path;
            out.branch = wt.branch;
            out.baseBranch = wt.base_branch;
            out.remoteBaseRef = wt.remote_base_ref ?? null;
            out.baseSha = wt.base_sha ?? null;
            out.baseHygiene = {
              baseBranch: wt.base_branch ?? null,
              remoteBaseRef: wt.remote_base_ref ?? null,
              remoteBaseSha: wt.base_sha ?? null,
              localBaseSha: wt.local_base_sha ?? null,
              localAheadBy: Number(wt.local_ahead_by || 0),
              localBehindBy: Number(wt.local_behind_by || 0),
              branchPoint: wt.branch_point ?? null,
              ok: true,
            };
          }
        }
      }
    }
    if (out.taskId || sid) {
      try {
        const feature = db.prepare(
          `SELECT mission_features.*, missions.workspace_id
           FROM mission_features
           JOIN missions ON missions.id = mission_features.mission_id
           WHERE mission_features.task_id = ?
              OR mission_features.stream_id = ?
              OR mission_features.validator_task_id = ?
              OR mission_features.validator_stream_id = ?
           ORDER BY mission_features.position ASC
           LIMIT 1`
        ).get(out.taskId || '', sid, out.taskId || '', sid);
        if (feature) {
          const validatorActive = feature.validator_task_id === out.taskId || feature.validator_stream_id === sid;
          out.missionId = feature.mission_id ?? null;
          out.waveId = feature.milestone_id ?? null;
          out.laneId = feature.id ?? null;
          out.role = validatorActive ? 'viewer' : (feature.role_mode || null);
          if (validatorActive) {
            out.roleMode = 'reviewer';
            out.taskType = 'validator';
            out.agentClass = 'validator';
          }
          out.targetTaskId = feature.task_id ?? null;
          out.validatorTaskId = feature.validator_task_id ?? null;
          out.rootTaskId = feature.task_id ?? null;
          out.parentTaskId = null;
          out.isRootGoalAgent = !validatorActive && !!feature.task_id && feature.task_id === out.taskId;
          out.isInternalSubagent = false;
          out.prNumber = feature.pr_number ?? null;
          out.prUrl = feature.pr_url ?? null;
          out.expectedLaneIds = db.prepare(
            `SELECT id
             FROM mission_features
             WHERE mission_id = ? AND milestone_id = ?
             ORDER BY position ASC`
          ).all(feature.mission_id, feature.milestone_id).map((row) => row.id);
        }
      } catch {}
    }
    return out;
  }

  function contextToEnvVars(ctx) {
    if (!ctx) return {};
    const env = {};
    if (ctx.streamId) env.ACE_STREAM_ID = String(ctx.streamId);
    if (ctx.workspaceId) env.ACE_WORKSPACE_ID = String(ctx.workspaceId);
    if (ctx.workspaceName) env.ACE_WORKSPACE_NAME = String(ctx.workspaceName);
    if (ctx.taskId) env.ACE_TASK_ID = String(ctx.taskId);
    if (ctx.rootTaskId) env.ACE_ROOT_TASK_ID = String(ctx.rootTaskId);
    if (ctx.parentTaskId) env.ACE_PARENT_TASK_ID = String(ctx.parentTaskId);
    if (ctx.isRootGoalAgent != null) env.ACE_IS_ROOT_GOAL_AGENT = ctx.isRootGoalAgent ? '1' : '0';
    if (ctx.isInternalSubagent != null) env.ACE_IS_INTERNAL_SUBAGENT = ctx.isInternalSubagent ? '1' : '0';
    if (ctx.conversationId) env.ACE_CONVERSATION_ID = String(ctx.conversationId);
    if (ctx.agent) env.ACE_AGENT = String(ctx.agent);
    if (ctx.worktreePath) env.ACE_WORKTREE_PATH = String(ctx.worktreePath);
    if (ctx.branch) env.ACE_BRANCH = String(ctx.branch);
    if (ctx.baseBranch) env.ACE_BASE_BRANCH = String(ctx.baseBranch);
    if (ctx.remoteBaseRef) env.ACE_REMOTE_BASE_REF = String(ctx.remoteBaseRef);
    if (ctx.baseSha) env.ACE_BASE_SHA = String(ctx.baseSha);
    if (ctx.repoRoot) env.ACE_REPO_ROOT = String(ctx.repoRoot);
    if (ctx.defaultBranch) env.ACE_DEFAULT_BRANCH = String(ctx.defaultBranch);
    if (ctx.githubRepo) env.ACE_GITHUB_REPO = String(ctx.githubRepo);
    if (ctx.githubProjectIndexCommand) {
      env.ACE_GITHUB_PROJECT_INDEX = String(ctx.githubProjectIndexCommand);
    }
    if (ctx.isPersonal) env.ACE_IS_PERSONAL = '1';
    if (ctx.personalIdentity) env.ACE_PERSONAL_IDENTITY = String(ctx.personalIdentity);
    if (ctx.agentLaneId) env.ACE_AGENT_LANE_ID = String(ctx.agentLaneId);
    if (ctx.agentLaneLabel) env.ACE_AGENT_LANE_LABEL = String(ctx.agentLaneLabel);
    if (ctx.agentLaneProfileId) env.ACE_AGENT_LANE_PROFILE_ID = String(ctx.agentLaneProfileId);
    if (ctx.isRemote) env.ACE_IS_REMOTE = '1';
    // Knowledge plane: role (gates canon writes — see handleWikiUpdate) and
    // the compact role pack path, when the project wiki carries one. Both are
    // in env-scrub's inherited-context scrub list.
    const knowledgeRole = ctx.roleMode || ctx.role || null;
    if (knowledgeRole) env.ACE_AGENT_ROLE = String(knowledgeRole);
    if (ctx.repoRoot && knowledgeRole) {
      try {
        const packRole = String(knowledgeRole) === 'reviewer' ? 'validator' : 'worker';
        const packPath = path.join(String(ctx.repoRoot), '.ace', 'wiki', '00_index', `agent-pack-${packRole}.json`);
        if (fs.existsSync(packPath)) env.ACE_KNOWLEDGE_PACK = packPath;
      } catch { /* pack pointer is best-effort */ }
    }
    return env;
  }

  function getConversationAutoApprove(conversationId) {
    const owner = resolveStreamOwner(`conversation:${conversationId}`);
    return !!(owner && owner.autoApprove);
  }

  function resolveAgentBinary(cliId) {
    if (cliId === 'claude') return which('claude');
    if (cliId === 'codex') return which('codex');
    return null;
  }



  function writeSessionIdForStream(streamId, sessionId, reason = 'bind') {
    const match = /^(variant|conversation|shell):(.+)$/.exec(String(streamId ?? ''));
    if (!match) return;
    const [, kind, id] = match;
    if (kind === 'variant') {
      stmts.setVariantSessionId.run(sessionId, id);
    } else if (kind === 'conversation') {
      stmts.setConversationSessionId.run(sessionId, id);
    }
    // A concrete session id is now durably in the DB: (1) release any in-memory
    // reservation held for it (the DB read in `taken` covers it from here on),
    // and (2) append a binding row so the next rebind can prefer this stream's
    // OWN history and so the audit trail is complete. 'seen'/null carry no
    // resumable id, so they neither reserve nor belong in the history feed.
    if (sessionId && sessionId !== 'seen') {
      releaseSessionReservation(sessionId);
      recordSessionHistory({ streamId, sessionId, reason });
    }
  }

  // Block interactive /resume from claiming a session owned by another live lane.
  function canBindSessionIdForStream(streamId, sessionId) {
    if (!streamId || !sessionId) return false;
    try {
      const rows = db.prepare(
        `SELECT 'conversation:' || c.id AS stream_id
           FROM conversations c
           JOIN agent_resume_state a ON a.stream_id = 'conversation:' || c.id
          WHERE c.session_id = ?
         UNION ALL
         SELECT 'variant:' || v.id AS stream_id
           FROM variants v
           JOIN agent_resume_state a ON a.stream_id = 'variant:' || v.id
          WHERE v.session_id = ?`
      ).all(sessionId, sessionId);
      return rows.every((row) => row.stream_id === streamId);
    } catch {
      return false;
    }
  }

  function resolveLiveClaudeSessionIdForStream(streamId) {
    const owner = resolveStreamOwner(streamId);
    const stream = ptyRegistry.getStream(streamId);
    if (!owner || stream?.agent !== 'claude' || stream?.status !== 'running') return null;
    return resolveClaudeProcessSessionId({ expectedSessionId: owner.sessionId, cwd: owner.cwd });
  }







  // Reservations bridge the choose->persist gap during a MASS respawn. A stale
  // lane's rebind picks a session, but persist only lands after an `await` in
  // ensureStreamStarted; a SECOND concurrent planResume that reads `taken` from
  // the DB before that persist would otherwise pick the SAME newest-in-cwd
  // session and clobber it. planRebindOrFresh reserves its chosen id here so the
  // other lane's `taken` already excludes it. Entries self-expire so a spawn
  // that dies before persisting can't wedge an id as permanently "taken".
  const sessionReservations = new Map(); // sessionId -> expiresAtMs
  const SESSION_RESERVATION_TTL_MS = 30_000;
  function reservedSessionIds() {
    const now = Date.now();
    const live = new Set();
    for (const [sid, exp] of sessionReservations) {
      if (exp > now) live.add(sid);
      else sessionReservations.delete(sid);
    }
    return live;
  }
  function reserveSessionId(sid) {
    if (sid) sessionReservations.set(sid, Date.now() + SESSION_RESERVATION_TTL_MS);
  }
  function releaseSessionReservation(sid) {
    if (sid) sessionReservations.delete(sid);
  }

  // Tiny synchronous backoff for the transient-stat retry. planResume runs on
  // the hot spawn path and must stay sync, so this parks the thread for a few ms
  // via Atomics.wait (main process only; harmless no-op where SAB is absent).
  function syncBackoffMs(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
    } catch {
      /* SharedArrayBuffer unavailable — skip the delay, still retry */
    }
  }

  // Append a binding/decision row to stream_session_history. Best-effort: the
  // audit trail must never break a spawn. Resolves provider/cwd from the live
  // owner so callers only pass the streamId + the id + why.
  function recordSessionHistory({ streamId, sessionId, cwd, reason }) {
    try {
      const owner = resolveStreamOwner(streamId);
      const provider = owner ? (getProvider(owner.agent)?.id ?? owner.agent ?? null) : null;
      resumeStateStmts.recordHistory.run(
        String(streamId ?? ''),
        provider,
        cwd ?? owner?.cwd ?? null,
        sessionId ?? null,
        reason ?? null,
        new Date().toISOString()
      );
    } catch {
      /* audit trail is best-effort */
    }
  }

  // The sessions THIS stream previously bound in THIS cwd, newest first, each
  // tagged with whether its file still exists on disk. A transient/unknown stat
  // counts as "exists" (same asymmetry as planResume: resuming our OWN id is
  // safe; only a definitive absence disqualifies it).
  function ownHistorySessionsForStream({ streamId, provider, cwd }) {
    if (!streamId) return [];
    let rows: any[] = [];
    try {
      rows = resumeStateStmts.ownHistory.all(String(streamId), cwd ?? null);
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const r of rows) {
      const sid = r?.session_id;
      if (!sid || sid === 'seen') continue;
      const file = resolveSessionFile(provider, cwd, sid);
      const exists = file ? sessionFileState(file) !== 'absent' : false;
      out.push({ sessionId: sid, exists });
    }
    return out;
  }

  // Any count >= this reads as AMBIGUOUS at the gate (prefer fresh over
  // rebind-by-newest). Used as the fail-CLOSED value: when the cwd can't be
  // established or the read throws, we must NOT let a lane grab newest-in-cwd.
  const AMBIGUOUS_TAB_COUNT = 2;

  // How many LIVE claude tabs share this cwd. Drives the ambiguity gate: a
  // single tab owns "newest in cwd" unambiguously; with siblings the newest is
  // probably a sibling's and we prefer fresh. Counted from agent_resume_state
  // (the live-tab registry), NOT from a non-null session_id — a tab's session
  // is momentarily cleared to null mid-respawn, and counting only non-null tabs
  // let a concurrently-planning sibling read the shared cwd as unambiguous and
  // grab the just-cleared tab's orphan (the cross-attach this fix exists to
  // stop). A live row counts whether or not its session is currently bound.
  // Fails CLOSED: no cwd or a read error returns AMBIGUOUS_TAB_COUNT.
  function claudeTabCountForCwd(cwd) {
    if (!cwd) return AMBIGUOUS_TAB_COUNT;
    try {
      let count = 0;
      for (const r of db.prepare('SELECT stream_id FROM agent_resume_state').all()) {
        const o = resolveStreamOwner(r.stream_id);
        if (o && o.agent === 'claude' && o.cwd === cwd) count += 1;
      }
      return count;
    } catch {
      return AMBIGUOUS_TAB_COUNT;
    }
  }

  function planResume({ agent, sessionId, cwd, isRemote, streamId }) {
    const provider = getProvider(agent);
    const resume = provider?.resume;
    if (!resume) {
      return { resumeMode: 'fresh', freshSessionId: null, storedSessionId: null, willPersist: null, staleSessionId: null, reason: 'no-resume' };
    }
    if (sessionId) {
      // A stored `seen` sentinel means the CLI spawned but we never captured
      // its concrete session id. Hermes: never fall through to `--continue`
      // (could attach a background session). Codex: never fall through to
      // `resume --last` — with several codex tabs that resumes the globally
      // newest rollout, i.e. a DIFFERENT tab's session. Start fresh instead;
      // the transcript linker captures the real rollout id within seconds of
      // spawn, so a healthy tab never stays on the sentinel for long.
      if (sessionId === 'seen' && (agent === 'hermes' || agent === 'codex')) {
        const fresh = planFresh(resume, { persistTokenSentinel: agent !== 'hermes' });
        return { ...fresh, staleSessionId: sessionId, reason: 'fresh-seen-sentinel' };
      }
      // Only resume if the CLI's concrete session file actually exists on disk.
      // Ace persists those ids eagerly at spawn (Claude mints the file later,
      // on first user message) — closing a tab early leaves a stale id in our
      // DB that blows up `--resume` on reopen, which the fast-exit fallback
      // surfaces as "Resume failed; clearing session and starting fresh…".
      // Treat missing concrete files as fresh and ask the caller to clear the
      // stale id. Token-style CLIs (Codex `resume --last`, etc.) use the
      // synthetic `seen` sentinel because there is no concrete session id to
      // persist. Hermes is excluded: `--continue` resumes the newest state.db
      // session, which can be a background job rather than the visible tab.
      if (!isRemote && sessionId !== 'seen') {
        const file = resolveSessionFile(provider, cwd, sessionId);
        if (file) {
          // Only a DEFINITIVE absence (ENOENT) may fall through to a rebind. A
          // transient stat failure on the external SSD (EIO/ENOTCONN/timeout —
          // "the external volume raced the check") used to read as "missing" and
          // trigger a rebind that STOLE another tab's session. Retry a couple of
          // times, then, if still ambiguous, RESUME the stored id anyway: a wrong
          // "resume nonexistent" self-heals via the fast-exit fallback, whereas a
          // wrong rebind is unrecoverable — the asymmetry favors resume.
          let state = sessionFileState(file);
          for (let i = 0; state === 'unknown' && i < 2; i += 1) {
            syncBackoffMs(15);
            state = sessionFileState(file);
          }
          if (state === 'absent') {
            return planRebindOrFresh({ provider, resume, agent, cwd, staleSessionId: sessionId, streamId });
          }
          if (state === 'unknown') {
            // Kept the stored id through an unresolved SSD blip — leave a
            // breadcrumb so a mistaken keep is diagnosable after the fact.
            recordSessionHistory({ streamId, sessionId, cwd, reason: 'transient-error-kept-stored' });
          }
        } else if (resume.requiresSessionFile) {
          return planRebindOrFresh({ provider, resume, agent, cwd, staleSessionId: sessionId, streamId });
        }
      }
      return { resumeMode: 'resume', freshSessionId: null, storedSessionId: sessionId, willPersist: null, staleSessionId: null, reason: 'resume' };
    }

    const fresh = planFresh(resume, { persistTokenSentinel: agent !== 'hermes' });
    return { ...fresh, staleSessionId: null, reason: 'fresh-new-tab' };
  }

  // A recorded session id that no longer resolves to a file is NOT license to
  // mint a fresh session: the CLI usually has real history for this cwd (the
  // recorded id was a phantom, a rename/migration moved the slug dir, or the
  // external volume raced the check). Minting fresh here is what orphaned
  // lanes from their transcripts — the "lane changed streams" bug. Rebind to
  // the newest non-empty session the CLI actually wrote for this cwd, and
  // persist that id so the DB self-heals. Only stale-id lanes rebind — a
  // null session id means a brand-new tab, which must always start fresh.
  function planRebindOrFresh({ provider, resume, agent, cwd, staleSessionId, streamId }) {
    // Sessions bound to any lane — or reserved by a concurrent respawn (see
    // sessionReservations) — are off-limits (minus the stale one being
    // replaced). Project-root tabs share a cwd and must not cross-attach.
    const taken = new Set();
    try {
      const rows = db
        .prepare(
          'SELECT session_id AS sid FROM conversations WHERE session_id IS NOT NULL ' +
            'UNION SELECT session_id FROM variants WHERE session_id IS NOT NULL'
        )
        .all();
      for (const row of rows) {
        if (row.sid && row.sid !== staleSessionId) taken.add(row.sid);
      }
    } catch {
      /* rebind guard is best-effort; planFresh below stays the fallback */
    }
    for (const sid of reservedSessionIds()) {
      if (sid !== staleSessionId) taken.add(sid);
    }

    // Precedence (decideSessionRebind): OWN history > newest-in-cwd-if-unambiguous
    // > fresh. findNewestSessionIdInCwd already excludes `taken`, so the newest
    // candidate is never one currently bound/reserved elsewhere; the ambiguity
    // gate then guards against grabbing an ORPHAN file that morally belongs to a
    // sibling tab that has not resumed yet.
    const ownHistory = ownHistorySessionsForStream({ streamId, provider, cwd });
    const newestInCwd = findNewestSessionIdInCwd(provider, cwd, taken);
    const claudeTabCount = agent === 'claude' ? claudeTabCountForCwd(cwd) : 0;
    const decision = decideSessionRebind({ ownHistory, taken, newestInCwd, claudeTabCount, staleSessionId });

    if (decision.mode === 'resume' && decision.sessionId && decision.sessionId !== staleSessionId) {
      // Reserve immediately so a concurrent planResume can't pick the same id
      // before our persist lands (released in writeSessionIdForStream / on TTL).
      reserveSessionId(decision.sessionId);
      return {
        resumeMode: 'resume',
        freshSessionId: null,
        storedSessionId: decision.sessionId,
        willPersist: decision.sessionId,
        staleSessionId: null,
        reason: decision.reason,
      };
    }
    // No safe own/unambiguous match — mint fresh rather than steal a sibling.
    const fresh = planFresh(resume, { persistTokenSentinel: agent !== 'hermes' });
    return { ...fresh, staleSessionId, reason: decision.reason };
  }

  function findTaskConversationResumeSessionId({ taskId, agent, cwd, isRemote }) {
    if (!taskId || !agent) return null;
    const provider = getProvider(agent);
    if (!provider?.resume) return null;
    const rows = db
      .prepare('SELECT session_id FROM conversations WHERE task_id = ? AND agent = ? AND session_id IS NOT NULL ORDER BY created_at DESC')
      .all(taskId, agent);
    for (const row of rows) {
      const sid = row?.session_id;
      if (!sid || sid === 'seen') continue;
      if (isRemote) return sid;
      if (!cwd) continue;
      const file = resolveSessionFile(provider, cwd, sid);
      if (!file) continue;
      try {
        if (fs.statSync(file).isFile()) return sid;
      } catch {}
    }
    return null;
  }

  function planFresh(resume, { persistTokenSentinel = true } = {}) {
    if (resume.style === 'flag' && resume.sessionIdFlag) {
      const uuid = randomUUID();
      return {
        resumeMode: 'fresh',
        freshSessionId: uuid,
        storedSessionId: null,
        willPersist: uuid,
      };
    }
    return {
      resumeMode: 'fresh',
      freshSessionId: null,
      storedSessionId: null,
      willPersist: persistTokenSentinel ? 'seen' : null,
    };
  }








  // True when the remote agent will execute as root — either no `agent_user`
  // is set (sshDaemons defaults to root) and the SSH connection user is
  // unspecified or 'root'. Used both to pick the right Claude auto-approve
  // flag and as the gate for the legacy retry-without-auto-approve fallback.
  function isRunningAsRoot(project) {
    if (!project?.is_remote) return false;
    if (project.agent_user) return false;
    if (project.ssh_user && project.ssh_user !== 'root') return false;
    return true;
  }

  function isClaudeAutoApproveRetryable({ agent, autoApprove, project }) {
    if (agent !== 'claude' || !autoApprove) return false;
    return isRunningAsRoot(project);
  }

  async function relaunchRemoteStream(streamId, dims, { dropAutoApprove, dropResume, launchIntent: originalLaunchIntent }) {
    const owner = resolveStreamOwner(streamId);
    if (!owner) throw new Error('owner missing');
    // The remote stream entry is deleted on pty.exit before this relaunch runs,
    // so the ORIGINAL launch intent is threaded in by the caller. Re-derive the
    // worker/interactive classification so a remote worker relaunch keeps the
    // MCP strip instead of being reclassified interactive.
    const relaunchIntent = respawnLaunchIntentFor(originalLaunchIntent);
    const { agent, cwd, project, kind, sessionId } = owner;
    const agentUser = project.agent_user ?? null;
    const daemon = daemonFor(project.ssh_host, agentUser);




    if (dropResume && kind !== 'shell') {
      writeSessionIdForStream(streamId, null);
    }
    const plan =
      kind === 'shell' || dropResume
        ? { resumeMode: 'fresh', freshSessionId: null, storedSessionId: null, willPersist: null, staleSessionId: null }
        : planResume({
            agent,
            sessionId,
            cwd,
            isRemote: !!project?.is_remote,
            streamId,
          });
    if (plan.staleSessionId && kind !== 'shell') {
      writeSessionIdForStream(streamId, null);
    }
    const cmdSpec = buildRemoteAgentCommand(agent, {
      autoApprove: dropAutoApprove ? false : !!owner.autoApprove,
      runAsRoot: isRunningAsRoot(project),
      resumeMode: plan.resumeMode,
      freshSessionId: plan.freshSessionId,
      storedSessionId: plan.storedSessionId,
      launchIntent: relaunchIntent,
    });





    const remoteEnv = agentTerminalForcedEnvEntries(agent, ['TERM=xterm-256color']);
    if (agent === 'claude') await verifyRemoteClaudeSubscriptionAuth(daemon, cwd, remoteEnv);
    events.emit('pty:data', { id: streamId, chunk: '\x1bc' });
    const result = await daemon.startPty({
      cmd: cmdSpec.cmd,
      args: cmdSpec.args,
      cols: dims?.cols ?? 100,
      rows: dims?.rows ?? 28,
      cwd,
      env: remoteEnv,
    });
    remoteStreams.set(streamId, {
      host: project.ssh_host,
      agentUser,
      agent,
      daemonPtyId: result.id,
      startedAt: Date.now(),
      retryable: false,
      cols: dims?.cols ?? 100,
      rows: dims?.rows ?? 28,
      resumeMode: plan.resumeMode,
      // Carry the derived classification so a chained relaunch stays consistent.
      launchIntent: relaunchIntent,
    });
    daemonPtyToStream.set(
      daemonPtyKey(project.ssh_host, agentUser, result.id),
      streamId
    );
    if (plan.willPersist) {
      writeSessionIdForStream(streamId, plan.willPersist, plan.reason);
    }
  }








  handleLocalStreamExit = (streamId, code, stream) => {
    if (!stream) return false;
    // The subscription-only auth guard owns this exit. Never reinterpret the
    // deliberate kill as a stale-session failure and auto-relaunch it.
    if (stream.claudeApiBillingBlocked) {
      events.emit('pty:exit', { id: streamId, code });
      return true;
    }
    const startedAt = stream.startedAt ?? 0;
    const fastExit = Date.now() - startedAt < 6000 && (code === null || code !== 0);
    if (fastExit && stream.resumeMode === 'resume') {
      const dims = { cols: stream.cols, rows: stream.rows };
      const owner = resolveStreamOwner(streamId);
      if (!owner || owner.kind === 'shell') return false;
      writeSessionIdForStream(streamId, null);
      events.emit('pty:data', { id: streamId, chunk: '\x1bc' });
      events.emit('pty:data', {
        id: streamId,
        chunk:
          '\x1b[33m[ace] Resume failed; clearing session and starting fresh…\x1b[0m\r\n',
      });
      // A resume-failed fresh restart must keep this lane's worker/interactive
      // classification: a delegated worker restarting bare would be reclassified
      // interactive and regain MCP/connectors (mirrors the remote relaunch fix).
      const relaunchIntent = respawnLaunchIntentFor(stream.launchIntent);
      setImmediate(() => {
        ptyRegistry.streams.delete(streamId);
        void ensureStreamStarted({ streamId, cols: dims.cols, rows: dims.rows, launchIntent: relaunchIntent });
      });
      return true;
    }
    if (maybeRelaunchPersistentHermesStream(streamId, code, stream)) return true;
    return false;
  };

  // Kills a `shell:*` PTY without deleting anything from the DB. Used when the
  // user closes a secondary terminal tab — we don't want to leak the PTY, but
  // there's no owning row to clean up.
  function killShellStream({ streamId } = {}) {
    if (typeof streamId !== 'string' || !streamId.startsWith('shell:')) {
      return { ok: false };
    }
    killStreamEverywhere(streamId);
    return { ok: true };
  }

  // One-shot guard so a resumed lane is nudged to continue at most once per app
  // session, even if ensureStreamStarted runs again for the same stream.
  const resumeNudgedStreams = new Set();
  function injectResumeContinuation({ streamId, plan, launchIntent, started }) {
    try {
      const prompt = launchIntent?.resumePrompt;
      if (!prompt || typeof prompt !== 'string') return;
      if (plan?.resumeMode !== 'resume') return;
      if (!started || started.status !== 'running') return;
      if (resumeNudgedStreams.has(streamId)) return;
      resumeNudgedStreams.add(streamId);
      // Let the resumed CLI repaint its restored transcript before we type, then
      // send the prompt and a separate Enter so TUIs that debounce paste+submit
      // still register it. Best-effort: a failed nudge must never disrupt boot.
      setTimeout(() => {
        try { writeTerminalInput({ streamId, data: prompt }); } catch {}
        setTimeout(() => {
          try { writeTerminalInput({ streamId, data: '\r' }); } catch {}
        }, 300);
      }, 1500);
    } catch {
      /* never let a resume nudge disrupt stream startup */
    }
  }

  // Kill foreign CLI processes already holding a claude session id we are
  // about to resume. They exist when a previous app generation (different
  // pty-host, or a crashed boot) left detached agents running: unadoptable,
  // attached to no UI, and still appending to the same transcript file our
  // new process will write — which interleaves two agents into one session
  // and makes lanes appear to "change streams". SIGTERM, best-effort.
  function reapForeignSessionHolders(sessionId: any) {
    const sid = String(sessionId || '');
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return;
    let psOut = '';
    try {
      psOut = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return;
    }
    for (const line of psOut.split('\n')) {
      if (!line.includes(sid)) continue;
      if (!/\bclaude\b/.test(line)) continue;
      if (!line.includes(`--resume ${sid}`) && !line.includes(`--session-id ${sid}`)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0], 10);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        console.warn(`[ace] reaped foreign agent pid ${pid} holding session ${sid}`);
      } catch {
        /* already gone or not ours to kill */
      }
    }
  }

  async function ensureStreamStarted({ streamId, cols, rows, launchIntent }) {
    const owner = resolveStreamOwner(streamId);
    if (!owner) return { ok: false };
    const { agent, cwd, kind, id, project, autoApprove, sessionId, agentLane } = owner;
    // A missing cwd means the worktree/volume is unavailable (external SSD
    // not mounted yet, dir moved). Spawning would land the CLI in a fallback
    // dir and bind the lane to the WRONG project slug — defer instead, and
    // let the caller know not to treat this as a dead session.
    if (kind !== 'shell' && !project?.is_remote && cwd) {
      let cwdExists = false;
      try { cwdExists = fs.statSync(cwd).isDirectory(); } catch {}
      if (!cwdExists) {
        return { ok: false, deferred: true, error: `cwd unavailable: ${cwd}` };
      }
    }

    // The renderer/watchdog can ask for a lane before the delayed boot restore
    // has adopted PTYs that survived in the detached host. Planning first can
    // mutate the stored session id, then spawnStream silently reattaches to the
    // DIFFERENT session already running in the host. Adopt (or reuse) first so
    // the live process remains the session authority and resume state is not
    // rewritten underneath it.
    const adopted = await adoptDetachedAgentSurvivor({ streamId, owner });
    if (adopted) return { ok: true, adopted: adopted.adopted };

    // Adoption came back empty — but that can mean the lane is alive inside an
    // outdated pty-host we could not retire, which we refuse to serve. Bail out
    // HERE, before session planning: the resume path calls
    // reapForeignSessionHolders, which would SIGTERM the very legacy CLI this
    // guard exists to protect, and only then report the lane as blocked.
    // Settle the detached-off sweep BEFORE the guard and before any session
    // planning: planning reaps foreign session holders, which would kill the
    // very legacy CLI this refuses to duplicate.
    if (legacyHostSweep) { try { await legacyHostSweep; } catch { /* latched as unknown */ } }
    if (legacySweepUnknown || blockedLaneIds().has(streamId)) {
      return {
        ok: false,
        blockedByLegacyHost: true,
        error:
          'This agent is still running inside a pty-host left over from a previous version of Ace. '
          + 'Quit Ace, make sure no "ace-pty-host" process is left running, then reopen it.',
      };
    }

    let resumeSessionId = sessionId;
    if (kind === 'variant') {
      const variant = stmts.getVariantById.get(id);
      const fallbackSessionId = findTaskConversationResumeSessionId({
        taskId: variant?.task_id ?? null,
        agent,
        cwd,
        isRemote: !!project?.is_remote,
      });
      if (fallbackSessionId && fallbackSessionId !== resumeSessionId) {
        resumeSessionId = fallbackSessionId;
        writeSessionIdForStream(streamId, fallbackSessionId);
      }
    }
    const localHermesHomePath = agent === 'hermes' && project?.id && !project?.is_remote
      ? ensureHermesHomeForOwner({ project, lane: agentLane, cwd })
      : null;
    if (kind !== 'shell' && localHermesHomePath && resumeSessionId) {
      const compressionTipSessionId = resolveHermesCompressionTip(localHermesHomePath, resumeSessionId);
      if (compressionTipSessionId && compressionTipSessionId !== resumeSessionId) {
        resumeSessionId = compressionTipSessionId;
        writeSessionIdForStream(streamId, compressionTipSessionId);
      }
    }

    const plan =
      kind === 'shell'
        ? { resumeMode: 'fresh', freshSessionId: null, storedSessionId: null, willPersist: null, staleSessionId: null }
        : planResume({
            agent,
            sessionId: resumeSessionId,
            cwd,
            isRemote: !!project?.is_remote,
            streamId,
          });
    if (plan.staleSessionId && kind !== 'shell') {
      writeSessionIdForStream(streamId, null);
    }

    if (project.is_remote) {
      const agentUser = project.agent_user ?? null;

      streamStates.ensureState(streamId, cols, rows);
      const existing = remoteStreams.get(streamId);
      if (existing) {
        existing.cols = cols;
        existing.rows = rows;
        try {
          daemonFor(existing.host, existing.agentUser).resizePty(existing.daemonPtyId, cols, rows);
          streamStates.resize(streamId, cols, rows);
        } catch {}
        return { ok: true };
      }
      try {
        const daemon = daemonFor(project.ssh_host, agentUser);
        const cmdSpec = buildRemoteAgentCommand(agent, {
          autoApprove,
          runAsRoot: isRunningAsRoot(project),
          resumeMode: plan.resumeMode,
          freshSessionId: plan.freshSessionId,
          storedSessionId: plan.storedSessionId,
          launchIntent,
        });
        // Remote Hermes: scope HERMES_HOME per-workspace so `--continue`
        // doesn't collide with sessions from other remote orchestrators on
        // the same host. The daemon env is a string array ("K=V" entries).
        const remoteEnv = agentTerminalForcedEnvEntries(agent, ['TERM=xterm-256color']);
        // Ensure remote agents can find user-installed binaries (e.g.
        // `ace`) on the remote host without depending on the
        // remote user's shell rc.
        if (agent === 'hermes' && project?.id) {
          const safe = String(project.id).replace(/[^\w.-]/g, '_');
          remoteEnv.push(`HERMES_HOME=$HOME/.ace/hermes-home-${safe}`);
          remoteEnv.push(`PATH=$HOME/.ace/hermes-home-${safe}/bin:$HOME/.local/bin:$PATH`);
        } else {
          remoteEnv.push('PATH=$HOME/.local/bin:$PATH');
        }
        for (const [k, v] of Object.entries(contextToEnvVars(getContextForStream({ streamId })))) {
          remoteEnv.push(`${k}=${v}`);
        }
        if (agent === 'claude') await verifyRemoteClaudeSubscriptionAuth(daemon, cwd, remoteEnv);
        const result = await daemon.startPty({
          cmd: cmdSpec.cmd,
          args: cmdSpec.args,
          cols,
          rows,
          cwd,
          env: remoteEnv,
        });
        remoteStreams.set(streamId, {
          host: project.ssh_host,
          agentUser,
          agent,
          daemonPtyId: result.id,
          startedAt: Date.now(),
          retryable: isClaudeAutoApproveRetryable({ agent, autoApprove, project }),
          cols,
          rows,
          resumeMode: plan.resumeMode,
          // Retain the spawn launch intent so a fast-exit/resume relaunch can
          // preserve this remote lane's worker/interactive classification.
          launchIntent: launchIntent ?? null,
        });
        daemonPtyToStream.set(daemonPtyKey(project.ssh_host, agentUser, result.id), streamId);
        if (plan.willPersist) {
          writeSessionIdForStream(streamId, plan.willPersist, plan.reason);
        }
        return { ok: true };
      } catch (err) {
        console.error('[ace] remote pty start failed:', err);
        events.emit('pty:data', {
          id: streamId,
          chunk: `\x1b[31mRemote agent start failed: ${err.message}\x1b[0m\r\n`,
        });
        events.emit('pty:exit', { id: streamId, code: -1 });
        return { ok: false };
      }
    }

    // Per-workspace Hermes home so each Hermes lane resumes its OWN latest
    // session, not the globally-latest across all workspaces. See
    // ensureHermesHomeForProject() for the layout (state.db isolated,
    // auth/config/skills shared; King overrides SOUL/config cwd).
    // Also ensure ~/.local/bin is on PATH for every spawned PTY so agents
    // installed by Hermes profiles are discoverable even when Electron is
    // launched from Finder/launchd with a minimal PATH.
    const hermesCliDirs = hermesPaths.hermesCliSearchDirs();
    const hermesHomePath = localHermesHomePath;
    const pathParts = hermesHomePath
      ? [path.join(hermesHomePath, 'bin'), ...hermesCliDirs, process.env.PATH || '']
      : [...hermesCliDirs, process.env.PATH || ''];
    // path.delimiter, not ':' — a hardcoded colon builds a single unparseable
    // PATH entry on Windows, where the separator is ';'.
    const augmentedPath = pathParts.filter(Boolean).join(path.delimiter);
    const ctxEnv = contextToEnvVars(getContextForStream({ streamId }));
    const userDataTag = path.basename(userDataPath || 'Ace');
    const aceTransportEnv = localAgentAceTransportEnv({
      userDataPath,
      getRemoteSettings,
      findRemoteDeviceByHash,
      registerRemoteDevice,
    });
    const externalStorageEnv = externalDataRoot.externalStorageEnvForUserData(userDataPath);
    const extraEnv = {
      PATH: augmentedPath,
      ACE_CALLER_INSTANCE_TAG: userDataTag,
      ACE_USER_DATA_TAG: userDataTag,
      // Pin the main-process socket and, when remote access is enabled, prefer
      // the auth-backed loopback HTTP transport for sandboxed agent tools.
      ...aceTransportEnv,
      // When the external SSD data root is active, the main process sets
      // ACE_HOME so the spawned `ace` CLI lands its child-registry on
      // the SSD. It is the CLI (a spawned child), not this process, that writes
      // the registry, so re-inject it past the ACE_* sanitizer.
      ...externalStorageEnv,
      ...(!externalStorageEnv.ACE_HOME && process.env.ACE_HOME ? { ACE_HOME: process.env.ACE_HOME } : {}),
      ...(hermesHomePath ? { HERMES_HOME: hermesHomePath } : {}),
      ...ctxEnv,
      ...hermesTerminalBottomPinEnv(agent),
    };

    // Materialise the baseline skill pack into the agent's per-agent skills
    // dir (~/.claude/skills/<id>, ~/.codex/skills/<id>, ...) so the child
    // picks them up via its native skill loader — independent of whatever the
    // orchestrator prompt mentions. Non-fatal on failure.
    if (kind !== 'shell') {
      try {
        let isOrchestrator = false;
        if (kind === 'conversation') {
          const conv = db.prepare('SELECT task_id FROM conversations WHERE id=?').get(id);
          const task = conv ? stmts.getTaskById.get(conv.task_id) : null;
          isOrchestrator = isOrchestratorTaskRow(task);
        }
        await skillsCore.ensureBaselineSkillsForAgent(agent, userDataPath, {
          isOrchestrator,
          extraSkillIds: Array.isArray(launchIntent?.skillIds) ? launchIntent.skillIds : [],
        });
      } catch (err) {
        console.warn(
          `[ace] ensureBaselineSkillsForAgent(${agent}) failed:`,
          err && err.message ? err.message : err
        );
      }

      // Materialise per-worktree custom-agent doctrine into the worktree so the
      // worker boots with baked-in role doctrine + driver keywords: Claude ->
      // .claude/agents/<role>.md, Codex -> .codex/agents/<role>.toml + an
      // AGENTS.md managed block (never clobbers the repo's own files). Role is
      // resolved from the worker's agent-pack skill. Non-fatal.
      try {
        if (cwd && (agent === 'claude' || agent === 'codex')) {
          const customAgents = require('../tools/ace/src/custom-agents.cjs');
          const role = customAgents.roleFromSkillIds(launchIntent?.skillIds);
          if (role) customAgents.generateAgentDoctrine(cwd, role, agent);
        }
      } catch (err) {
        console.warn(
          `[ace] custom-agent doctrine generation failed:`,
          err && err.message ? err.message : err
        );
      }
    }

    // Only when we are actually about to spawn (no live stream of our own):
    // reaping while our own healthy process serves this lane would kill it.
    if (agent === 'claude' && kind !== 'shell') {
      const existingLive = ptyRegistry.getStream(streamId);
      const resumeTarget = plan.storedSessionId || plan.freshSessionId;
      if (resumeTarget && (!existingLive || existingLive.status !== 'running')) {
        reapForeignSessionHolders(resumeTarget);
      }
    }

    try {
      const started = await ptyRegistry.ensureStream({
        streamId,
        agent,
        cwd,
        ownerKind: kind,
        ownerId: id,
        cols,
        rows,
        autoApprove,
        resumeMode: plan.resumeMode,
        freshSessionId: plan.freshSessionId,
        storedSessionId: plan.storedSessionId,
        launchIntent,
        extraEnv,
      });
      if (!started || started.status === 'exited') {
        return { ok: false, error: started?.error || `failed to launch ${agent}` };
      }
      if (plan.willPersist) {
        writeSessionIdForStream(streamId, plan.willPersist, plan.reason);
      }
      if (kind !== 'shell' && DETACHABLE_AGENTS.has(String(agent || '').toLowerCase())) {
        recordAgentResumeState(streamId, cols, rows);
      }
      injectResumeContinuation({ streamId, plan, launchIntent, started });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  const AGENT_AUTO_RESUME_PROMPT =
    '[ace] The Ace app restarted and this session was resumed automatically. ' +
    'If you were in the middle of a task, continue it from where you left off. ' +
    'If you were idle or waiting for input, briefly confirm you are standing by and wait.';

  function ownerTaskArchived(owner: any) {
    try {
      let taskId = null;
      if (owner.kind === 'conversation') {
        taskId = db.prepare('SELECT task_id FROM conversations WHERE id=?').get(owner.id)?.task_id ?? null;
      } else if (owner.kind === 'variant') {
        taskId = stmts.getVariantById.get(owner.id)?.task_id ?? null;
      }
      if (!taskId) return false;
      const task = stmts.getTaskById.get(taskId);
      return !!(task && task.archived_at);
    } catch {
      return false;
    }
  }

  // Local claude/codex conversation/variant tabs only: shells have nothing to
  // resume, hermes manages its own lifecycle (always-on watchdog, --continue
  // semantics), and remote agents live in the remote daemon's lifecycle.
  function isAutoResumableOwner(owner: any) {
    if (!owner || owner.kind === 'shell') return false;
    if (owner.project?.is_remote) return false;
    if (!DETACHABLE_AGENTS.has(String(owner.agent || '').toLowerCase())) return false;
    if (ownerTaskArchived(owner)) return false;
    return true;
  }

  const detachedAgentAdoptions = new Map();
  async function adoptDetachedAgentSurvivor({ streamId, owner, survivor = null }: any) {
    if (!ptyHost || !isAutoResumableOwner(owner)) return null;
    const existing = ptyRegistry.getStream(streamId);
    if (existing?.status === 'running') return { stream: existing, adopted: false };
    const pending = detachedAgentAdoptions.get(streamId);
    if (pending) return pending;

    const adoption = (async () => {
      let candidate = survivor;
      if (!candidate) {
        const survivors = (await ptyHost.ensureConnected()) || [];
        candidate = survivors.find((item: any) => item?.id === streamId) || null;
      }
      if (!candidate || candidate.status !== 'running') return null;

      // Another caller may have completed adoption while ensureConnected was
      // in flight. Reuse it instead of double-wiring the same detached handle.
      const live = ptyRegistry.getStream(streamId);
      if (live?.status === 'running') return { stream: live, adopted: false };

      const cols = candidate.cols || 120;
      const rows = candidate.rows || 40;
      const attached = await ptyHost.adoptStream(streamId);
      if (attached?.status && attached.status !== 'running') return null;
      const stream = ptyRegistry.adoptStream({
        streamId,
        agent: owner.agent,
        cwd: owner.cwd,
        ownerKind: owner.kind,
        ownerId: owner.id,
        handle: attached.handle,
        cols,
        rows,
        launchIntent: restoredLaneClassification(streamId),
      });
      recordAgentResumeState(streamId, cols, rows);
      return { stream, adopted: true };
    })();
    detachedAgentAdoptions.set(streamId, adoption);
    try {
      return await adoption;
    } finally {
      if (detachedAgentAdoptions.get(streamId) === adoption) detachedAgentAdoptions.delete(streamId);
    }
  }

  // Boot-time restore, called once from main.cts after the controller is up:
  // 1) adopt agent PTYs still alive inside the detached pty-host (the app
  //    quit/restarted but the agents never stopped working);
  // 2) for previously-running agents that did NOT survive (machine reboot,
  //    pty-host gone, detached mode disabled), relaunch their tabs into the
  //    same CLI session (--resume) and nudge them to continue.
  // Lanes whose CLI died with an OUTDATED pty-host we had to retire (a survivor
  // of a previous app generation still running the code it was started with —
  // see pty-host.cts). They come back with --resume so the transcript is intact,
  // but the turn they were mid-way through does not restart on its own unless
  // wake prompts are opted in (ACE_AUTO_WAKE_PROMPTS=1, deliberately off by
  // default). Say so in the lane rather than leaving an unexplained idle
  // composer. Keyed off pty:opened, not the restore pass, because the renderer
  // can relaunch a lane first — whichever path wins, the notice lands once.
  const pendingRetirementNotices = new Set<string>();
  function drainRetirementNotices() {
    for (const id of sweptRetiredIds) pendingRetirementNotices.add(id);
    sweptRetiredIds.clear();
    if (typeof ptyHost?.takeRetiredStreamIds !== 'function') return;
    for (const id of ptyHost.takeRetiredStreamIds()) pendingRetirementNotices.add(id);
  }
  // Every lane we must not relaunch, from whichever path found it.
  function blockedLaneIds(): Set<string> {
    const ids = new Set<string>(sweptBlockedIds);
    if (typeof ptyHost?.blockedSurvivorStreamIds === 'function') {
      for (const id of ptyHost.blockedSurvivorStreamIds()) ids.add(id);
    }
    return ids;
  }
  events.on('pty:opened', ({ id }: any) => {
    drainRetirementNotices();
    if (!pendingRetirementNotices.delete(id)) return;
    const chunk =
      '\x1b[2m[ace] This lane was restarted onto an updated pty-host and resumed from its transcript.' +
      (autoWakePromptsEnabled() ? '' : ' If it was mid-task, send \u201ccontinue\u201d.') +
      '\x1b[0m\r\n';
    // Through the state pump, not a bare pty:data: a lane auto-restored before
    // its terminal is acquired has no renderer session to receive the event, and
    // a bare emit never enters the mirror, so it would be missing from the sync
    // snapshot too — the owner would never see why the lane is parked.
    try {
      streamStates.pump(id, chunk, ({ seq, rewritten }: any) =>
        events.emit('pty:data', { id, chunk: rewritten, seq })
      );
    } catch {
      events.emit('pty:data', { id, chunk });
    }
  });

  let restoreAgentStreamsPromise: any = null;
  function restoreAgentStreams(options: any = {}) {
    if (!restoreAgentStreamsPromise) {
      restoreAgentStreamsPromise = (async () => {
        const relaunchMissing = options?.relaunchMissing !== false && autoResumeAgentStreamsEnabled();
        const summary = { adopted: 0, relaunched: 0, skipped: 0 };
        if (ptyHost) {
          try {
            const survivors = (await ptyHost.ensureConnected()) || [];
            for (const s of survivors) {
              try {
                const owner = resolveStreamOwner(s.id);
                if (!owner || !isAutoResumableOwner(owner)) {
                  await ptyHost.killStream(s.id);
                  clearAgentResumeState(s.id);
                  summary.skipped += 1;
                  continue;
                }
                if (s.status !== 'running') {
                  // Exited while the app was away — drop the host record and
                  // let the relaunch pass below resume the session instead.
                  await ptyHost.release(s.id);
                  continue;
                }
                const adopted = await adoptDetachedAgentSurvivor({ streamId: s.id, owner, survivor: s });
                if (adopted?.adopted) summary.adopted += 1;
              } catch (err) {
                console.warn('[ace] failed to adopt pty-host stream', s?.id, err?.message || err);
              }
            }
          } catch (err) {
            console.warn('[ace] pty-host adoption failed:', err?.message || err);
          }
        }
        // With detached mode off the sweep is the ONLY source of this, and it
        // is asynchronous — settle it before deciding what is "missing" (it
        // latches its own findings on resolve).
        if (legacyHostSweep) { try { await legacyHostSweep; } catch { /* latched as unknown */ } }
        if (legacySweepUnknown) {
          console.warn('[ace] not resuming any lane: could not determine whether an older pty-host survives');
          return summary;
        }
        drainRetirementNotices();
        // Lanes locked inside an outdated pty-host we could NOT retire are still
        // running their original CLI. ensureConnected reports no survivors in
        // that case (it refuses to serve the old host), so without this they
        // would look "missing" and be relaunched — a second agent appending to
        // the same transcript as the live one. Skip them entirely; they come
        // back on a later launch once the survivor is gone.
        const blockedSurvivors = blockedLaneIds();
        if (blockedSurvivors.size) {
          console.warn(
            `[ace] ${blockedSurvivors.size} lane(s) are held by an outdated pty-host that could not be retired; not relaunching them`
          );
        }
        if (relaunchMissing) {
          let rows: any[] = [];
          try {
            rows = resumeStateStmts.list.all();
          } catch {}
          for (const row of rows) {
            const streamId = row.stream_id;
            try {
              if (blockedSurvivors.has(streamId)) { summary.skipped += 1; continue; }
              const live = ptyRegistry.getStream(streamId);
              if (live && live.status === 'running') continue;
              const owner = resolveStreamOwner(streamId);
              if (!owner || !isAutoResumableOwner(owner) || !owner.sessionId) {
                clearAgentResumeState(streamId);
                summary.skipped += 1;
                continue;
              }
              // Carry the lane's persisted worker/interactive classification into
              // the relaunch so a resumed WORKER keeps its MCP strip (a bare
              // relaunch would reclassify it interactive). Wake prompts remain
              // opt-in (owner doctrine): silent resume unless ACE_AUTO_WAKE_PROMPTS=1.
              const restoredCls = restoredLaneClassification(streamId);
              const wakePrompt = autoWakePromptsEnabled()
                ? { resumePrompt: AGENT_AUTO_RESUME_PROMPT }
                : null;
              const relaunchIntent = (restoredCls || wakePrompt)
                ? { ...(restoredCls || {}), ...(wakePrompt || {}) }
                : null;
              const res = await ensureStreamStarted({
                streamId,
                cols: row.cols || 120,
                rows: row.rows || 40,
                ...(relaunchIntent ? { launchIntent: relaunchIntent } : {}),
              });
              if (res && res.ok) summary.relaunched += 1;
              // A deferred spawn (cwd on a not-yet-mounted volume) keeps its
              // resume state — clearing it here would permanently drop the
              // lane just because the external SSD raced app launch.
              else if (!res?.deferred) clearAgentResumeState(streamId);
              // Stagger relaunches so a dozen agents don't slam the CPU at once.
              await delay(400);
            } catch (err) {
              console.warn('[ace] auto-resume failed for', streamId, err?.message || err);
            }
          }
        }
        if (summary.adopted || summary.relaunched || summary.skipped) {
          console.log(
            `[ace] agent streams restored: ${summary.adopted} adopted, ${summary.relaunched} resumed, ${summary.skipped} skipped`
          );
        }
        return summary;
      })();
    }
    return restoreAgentStreamsPromise;
  }

  function writeTerminalInput({ streamId, data }) {
    // Let ace-control observe raw xterm input without ever blocking the PTY write.
    try {
      const observed = publicApi.streamObserveTerminalInput?.({ streamId, data });
      if (observed && typeof observed.catch === 'function') observed.catch(() => {});
    } catch { /* observation must never block terminal input */ }
    const remote = remoteStreams.get(streamId);
    if (remote) {
      try {
        daemonFor(remote.host, remote.agentUser).writePty(remote.daemonPtyId, data);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
    return { ok: ptyRegistry.writeStream(streamId, data) };
  }

  function resizeTerminal({ streamId, cols, rows }) {
    const remote = remoteStreams.get(streamId);
    if (remote) {
      try {
        daemonFor(remote.host, remote.agentUser).resizePty(remote.daemonPtyId, cols, rows);
        streamStates.resize(streamId, cols, rows);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
    return { ok: ptyRegistry.resizeStream(streamId, cols, rows) };
  }

  function getStreamSnapshot({ streamId }) {
    return ptyRegistry.snapshot(streamId);
  }

  function getTerminalSync({ streamId, scrollback }) {
    return streamStates.sync(streamId, { scrollback });
  }

  function broadcastToVariants({ input }) {
    const message = input.message ?? '';
    for (const variantId of input.variantIds ?? []) {
      ptyRegistry.writeStream(`variant:${variantId}`, message + '\n');
    }
    return {};
  }



  function resolveTaskCwd(taskId) {
    const wt = stmts.getWorktreesByTask.all(taskId)[0];
    if (wt) return wt.path;
    const task = stmts.getTaskById.get(taskId);
    if (!task) return null;
    const project = stmts.getProjectById.get(task.project_id);
    if (!project) return null;
    return project.is_remote ? project.remote_path : project.path;
  }




  function taskContext(taskId) {
    const task = stmts.getTaskById.get(taskId);
    if (!task) return null;
    const project = stmts.getProjectById.get(task.project_id);
    if (!project) return null;
    const cwd = resolveTaskCwd(taskId);
    if (!cwd) return null;
    const context = { cwd, project, task };
    if (project.is_remote) {
      context.daemon = daemonFor(project.ssh_host, project.agent_user);
    }
    return context;
  }






  function scopeContext(payload) {
    if (payload && payload.taskId) return taskContext(payload.taskId);
    if (payload && payload.workspaceId) {
      const project = stmts.getProjectById.get(payload.workspaceId);
      if (!project) return null;
      const cwd = project.is_remote ? project.remote_path : project.path;
      if (!cwd) return null;
      const ctx = { cwd, project, task: null };
      if (project.is_remote) {
        ctx.daemon = daemonFor(project.ssh_host, project.agent_user);
      }
      return ctx;
    }
    return null;
  }

  async function runRemoteGit(daemon, cwd, args) {
    return daemon.exec({ cmd: 'git', args, cwd });
  }




  async function remoteGitStatus(daemon, cwd) {
    const [statusRes, unstagedRes, stagedRes, branchRes, aheadBehindRes] = await Promise.all([
      // --untracked-files=all expands untracked directories into individual
      // file entries, matching VS Code's SCM view and the local gitStatus
      // path (which fills in untracked files via a separate `git ls-files
      // --others` call). Without it, `?? some-folder/` shows up as a single
      // row over a remote daemon project.
      runRemoteGit(daemon, cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runRemoteGit(daemon, cwd, ['diff', '--numstat']),
      runRemoteGit(daemon, cwd, ['diff', '--cached', '--numstat']),
      runRemoteGit(daemon, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runRemoteGit(daemon, cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    ]);
    if (statusRes.code !== 0) {
      return {
        staged: [],
        unstaged: [],
        totals: { additions: 0, deletions: 0 },
        branch: null,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
      };
    }
    const staged = [];
    const unstaged = [];
    const tokens = statusRes.stdout.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry) continue;
      const indexCode = entry[0];
      const worktreeCode = entry[1];
      const p = entry.slice(3);
      if (indexCode === 'R' || worktreeCode === 'R') i++;
      if (isHiddenChangePath(p)) continue;
      if (indexCode !== ' ' && indexCode !== '?') {
        staged.push({ path: p, status: codeToStatus(indexCode), additions: 0, deletions: 0 });
      }
      if (worktreeCode === '?') {
        unstaged.push({ path: p, status: 'added', additions: 0, deletions: 0 });
        continue;
      }
      if (worktreeCode !== ' ') {
        unstaged.push({ path: p, status: codeToStatus(worktreeCode), additions: 0, deletions: 0 });
      }
    }
    const applyNumstat = (list, raw) => {
      if (raw.code !== 0) return;
      const counts = parseNumstat(raw.stdout);
      for (const file of list) {
        const c = counts.get(file.path);
        if (c) {
          file.additions = c.additions;
          file.deletions = c.deletions;
        }
      }
    };
    applyNumstat(unstaged, unstagedRes);
    applyNumstat(staged, stagedRes);
    let totalAdd = 0, totalDel = 0;
    for (const f of [...staged, ...unstaged]) {
      totalAdd += f.additions;
      totalDel += f.deletions;
    }
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
    let ahead = 0, behind = 0, hasUpstream = false;
    if (aheadBehindRes.code === 0) {
      const parts = aheadBehindRes.stdout.trim().split(/\s+/);
      if (parts.length === 2) {
        ahead = Number(parts[0]) || 0;
        behind = Number(parts[1]) || 0;
        hasUpstream = true;
      }
    }
    return {
      staged,
      unstaged,
      totals: { additions: totalAdd, deletions: totalDel },
      branch,
      ahead,
      behind,
      hasUpstream,
    };
  }

  async function remoteGitLog(daemon, cwd, limit) {
    const capped = Math.max(1, Math.min(200, (limit | 0) || 30));
    const res = await runRemoteGit(daemon, cwd, [
      'log',
      `-${capped}`,
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s',
      '--date=iso-strict',
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, email, date, parents, message] = line.split('\x1f');
        return {
          hash,
          shortHash,
          author,
          email: email || '',
          date,
          message,
          parents: (parents || '').split(' ').filter(Boolean),
        };
      });
  }


  async function getGitStatus(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) {
      return {
        staged: [],
        unstaged: [],
        totals: { additions: 0, deletions: 0 },
        branch: null,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        githubRepo: null,
      };
    }
    const githubRepo = ctx.project.github_repo ?? null;
    if (ctx.project.is_remote) {
      const r = await remoteGitStatus(ctx.daemon, ctx.cwd);
      return { ...r, githubRepo };
    }
    const [status, branch, upstream] = await Promise.all([
      gitStatus(ctx.cwd),
      gitCurrentBranch(ctx.cwd),
      gitAheadBehind(ctx.cwd),
    ]);
    return {
      ...status,
      branch,
      ahead: upstream.ahead,
      behind: upstream.behind,
      hasUpstream: upstream.hasUpstream,
      githubRepo,
    };
  }

  async function getTaskGitLog(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { commits: [] };
    const limit = payload?.limit;
    if (ctx.project.is_remote) {
      return { commits: await remoteGitLog(ctx.daemon, ctx.cwd, limit) };
    }
    return { commits: await gitLog(ctx.cwd, limit) };
  }

  function parseNameStatusZ(stdout) {
    const parts = (stdout || '').split('\0');
    const out = [];
    let i = 0;
    while (i < parts.length) {
      const status = parts[i++];
      if (!status) continue;
      const letter = status[0];
      if (letter === 'R' || letter === 'C') {
        const oldPath = parts[i++];
        const newPath = parts[i++];
        if (newPath) out.push({ status: letter, path: newPath, oldPath });
      } else {
        const p = parts[i++];
        if (p) out.push({ status: letter, path: p });
      }
    }
    return out;
  }

  function parseNumstatZ(stdout) {
    const parts = (stdout || '').split('\0');
    const out = new Map();
    let i = 0;
    while (i < parts.length) {
      const head = parts[i++];
      if (!head) continue;
      const m = /^([-\d]+)\t([-\d]+)\t(.*)$/.exec(head);
      if (!m) continue;
      const [, a, d, rest] = m;
      const binary = a === '-';
      const additions = binary ? 0 : parseInt(a, 10) || 0;
      const deletions = binary ? 0 : parseInt(d, 10) || 0;
      if (rest === '') {
        const oldPath = parts[i++];
        const newPath = parts[i++];
        if (newPath) out.set(newPath, { additions, deletions, binary });
      } else {
        out.set(rest, { additions, deletions, binary });
      }
    }
    return out;
  }

  async function getCommitDetail(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return null;
    const hash = typeof payload?.hash === 'string' ? payload.hash : '';
    if (!hash) return null;
    const [meta, names, nums] = await Promise.all([
      runGitForScope(ctx, [
        'show',
        '--no-patch',
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b',
        hash,
      ]),
      runGitForScope(ctx, ['show', '--format=', '--name-status', '-z', hash]),
      runGitForScope(ctx, ['show', '--format=', '--numstat', '-z', hash]),
    ]);
    if (meta.code !== 0) return null;
    const [mHash, shortHash, author, email, date, parents, subject, ...rest] =
      meta.stdout.split('\x1f');
    const body = rest.join('\x1f').replace(/\n$/, '');
    const nameList = parseNameStatusZ(names.stdout);
    const numMap = parseNumstatZ(nums.stdout);
    const files = nameList.map((entry) => {
      const stat = numMap.get(entry.path);
      return {
        path: entry.path,
        oldPath: entry.oldPath || null,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
      };
    });
    return {
      hash: mHash || hash,
      shortHash: shortHash || hash.slice(0, 7),
      author: author || '',
      email: email || '',
      date: date || '',
      parents: (parents || '').split(' ').filter(Boolean),
      subject: subject || '',
      body,
      files,
    };
  }

  async function getCommitFileDiff(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { diff: '', binary: false };
    const hash = typeof payload?.hash === 'string' ? payload.hash : '';
    const filePath = typeof payload?.path === 'string' ? payload.path : '';
    if (!hash || !filePath) return { diff: '', binary: false };
    const res = await runGitForScope(ctx, [
      'show',
      '--no-color',
      `--format=`,
      hash,
      '--',
      filePath,
    ]);
    if (res.code !== 0) return { diff: '', binary: false };
    const stdout = res.stdout || '';
    return { diff: stdout, binary: /\bBinary files\b/.test(stdout) };
  }

  async function getFileDiff(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { diff: '', binary: false };
    const { path: filePath, staged } = payload || {};
    if (!filePath) return { diff: '', binary: false };
    if (ctx.project.is_remote) {
      const args = staged
        ? ['diff', '--cached', '--no-color', '--', filePath]
        : ['diff', '--no-color', '--', filePath];
      const res = await runRemoteGit(ctx.daemon, ctx.cwd, args);
      if (res.code === 0 && (res.stdout || '').length > 0) {
        return { diff: res.stdout, binary: /\bBinary files\b/.test(res.stdout) };
      }
      // Untracked / new files have no git history — `git diff` returns empty.
      // Mirror the local fallback: fetch the file via the daemon and render
      // every line as `+`. Skip for staged since staged untracked files have
      // an index entry git diff --cached can already see.
      if (!staged) {
        try {
          const abs = path.posix.join(ctx.cwd, filePath);
          const bytes = await ctx.daemon.fsRead(abs);
          if (!bytes || bytes.length === 0) return { diff: '', binary: false };
          if (bytes.length > 2 * 1024 * 1024) return { diff: '', binary: true };
          const sample = bytes.slice(0, Math.min(bytes.length, 8192));
          for (let i = 0; i < sample.length; i++) {
            if (sample[i] === 0) return { diff: '', binary: true };
          }
          const text = bytes.toString('utf8');
          const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
          const header =
            `diff --git a/${filePath} b/${filePath}\n` +
            `new file mode 100644\n` +
            `--- /dev/null\n` +
            `+++ b/${filePath}\n` +
            `@@ -0,0 +1,${lines.length} @@\n`;
          const body = lines.map((l) => `+${l}`).join('\n');
          return { diff: header + body + (lines.length > 0 ? '\n' : ''), binary: false };
        } catch {
          return { diff: '', binary: false };
        }
      }
      return { diff: '', binary: false };
    }
    return gitDiffFile(ctx.cwd, filePath, !!staged);
  }

  async function listTaskFiles(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { entries: [] };
    const relativePath = payload?.relativePath ?? '';
    if (ctx.project.is_remote) {
      const target = relativePath
        ? path.posix.join(ctx.cwd, relativePath)
        : ctx.cwd;
      const list = await ctx.daemon.fsList(target);
      const entries = (list.entries || []).map((e) => ({
        name: e.name,
        kind: e.kind,
        relativePath: relativePath
          ? path.posix.join(relativePath, e.name)
          : e.name,
      }));



      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      return { entries };
    }
    return { entries: listDirectoryEntries(ctx.cwd, relativePath) };
  }

  async function readTaskFile(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath } = payload;
    if (ctx.project.is_remote) {
      const bytes = await ctx.daemon.fsRead(path.posix.join(ctx.cwd, relativePath));
      return { content: bytes.toString('utf8') };
    }
    return { content: readFileInside(ctx.cwd, relativePath) };
  }

  async function runGitForScope(ctx, args) {
    if (ctx.project.is_remote) {
      const res = await ctx.daemon.exec({ cmd: 'git', args, cwd: ctx.cwd });
      return { code: res.code | 0, stdout: res.stdout || '', stderr: res.stderr || '' };
    }
    try {
      const res = await execFileP('git', args, { cwd: ctx.cwd, maxBuffer: 64 * 1024 * 1024 });
      return { code: 0, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
      };
    }
  }

  async function searchFiles(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { files: [] };
    const res = await runGitForScope(ctx, [
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
    ]);
    if (res.code !== 0) return { files: [] };
    const files = res.stdout.split('\0').filter(Boolean);
    return { files };
  }

  async function searchFileContent(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) return { matches: [], truncated: false };
    const query = typeof payload?.query === 'string' ? payload.query : '';
    if (!query) return { matches: [], truncated: false };
    const regex = !!payload?.regex;
    const caseSensitive = !!payload?.caseSensitive;
    const wholeWord = !!payload?.wholeWord;
    const cap = Math.max(1, Math.min(2000, (payload?.maxResults | 0) || 500));
    const args = [
      'grep',
      '-I',
      '-n',
      '--column',
      '--untracked',
      '--no-color',
      '-z',
    ];
    if (!caseSensitive) args.push('-i');
    if (wholeWord) args.push('-w');
    args.push(regex ? '-E' : '-F');
    args.push('-e', query);
    const res = await runGitForScope(ctx, args);
    if (res.code !== 0 && res.code !== 1) return { matches: [], truncated: false };
    if (res.code === 1) return { matches: [], truncated: false };
    const matches = [];
    let truncated = false;
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split('\0');
      if (parts.length < 4) continue;
      const filePath = parts[0];
      const lineNum = parseInt(parts[1], 10);
      const column = parseInt(parts[2], 10);
      const preview = parts.slice(3).join('\0');
      if (!filePath || !Number.isFinite(lineNum)) continue;
      matches.push({
        path: filePath,
        line: lineNum,
        column: Number.isFinite(column) ? column : 1,
        preview: preview.length > 500 ? preview.slice(0, 500) : preview,
      });
      if (matches.length >= cap) {
        truncated = true;
        break;
      }
    }
    return { matches, truncated };
  }




  function touchRemoteTotals(taskId) {
    if (taskId) remoteGitPoller.refreshNow(taskId);
  }

  async function writeTaskFile(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath, content } = payload;
    if (ctx.project.is_remote) {
      await ctx.daemon.fsWrite(path.posix.join(ctx.cwd, relativePath), content);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    writeFileInside(ctx.cwd, relativePath, content);
    return { ok: true };
  }

  async function createTaskFile(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath } = payload;
    if (ctx.project.is_remote) {
      await ctx.daemon.fsWrite(path.posix.join(ctx.cwd, relativePath), '');
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    createFileInside(ctx.cwd, relativePath);
    return { ok: true };
  }

  async function createTaskFolder(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath } = payload;
    if (ctx.project.is_remote) {
      await ctx.daemon.fsMkdir(path.posix.join(ctx.cwd, relativePath), true);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    createFolderInside(ctx.cwd, relativePath);
    return { ok: true };
  }

  async function renameTaskPath(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath, newName } = payload;
    if (ctx.project.is_remote) {
      const from = path.posix.join(ctx.cwd, relativePath);
      const parent = path.posix.dirname(relativePath);
      const to = path.posix.join(
        ctx.cwd,
        parent && parent !== '.' ? path.posix.join(parent, newName) : newName
      );
      await ctx.daemon.fsRename(from, to);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    renamePathInside(ctx.cwd, relativePath, newName);
    return { ok: true };
  }

  async function deleteTaskPath(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath } = payload;
    if (ctx.project.is_remote) {
      await ctx.daemon.fsRemove(path.posix.join(ctx.cwd, relativePath), true);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    const result = deletePathInside(ctx.cwd, relativePath, getTrashDir());
    return { ok: true, trashPath: result.trashPath, originalPath: result.originalPath };
  }

  function getTrashDir() {
    return path.join(userDataPath, 'ace-trash');
  }

  function restoreFromTrash(payload) {
    const { trashPath, originalPath } = payload || {};
    return restoreFromTrashInside(getTrashDir(), trashPath, originalPath);
  }

  async function revealTaskPath(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { relativePath } = payload;
    if (ctx.project.is_remote) {
      throw new Error('Reveal in Finder is not supported for remote workspaces');
    }
    const absolute = resolveInsideRoot(ctx.cwd, relativePath);
    if (!absolute) throw new Error('invalid path');
    return { absolute };
  }

  async function stageFiles(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const paths = payload?.paths;
    if (ctx.project.is_remote) {
      if (!paths?.length) return { ok: true };
      await runRemoteGit(ctx.daemon, ctx.cwd, ['add', '--', ...paths]);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    await gitStageFiles(ctx.cwd, paths ?? []);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return { ok: true };
  }

  async function unstageFiles(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const paths = payload?.paths;
    if (ctx.project.is_remote) {
      if (!paths?.length) return { ok: true };
      await runRemoteGit(ctx.daemon, ctx.cwd, ['restore', '--staged', '--', ...paths]);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    await gitUnstageFiles(ctx.cwd, paths ?? []);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return { ok: true };
  }

  async function stageAll(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    if (ctx.project.is_remote) {
      await runRemoteGit(ctx.daemon, ctx.cwd, ['add', '-A']);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    await gitStageAll(ctx.cwd);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return { ok: true };
  }

  async function unstageAll(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    if (ctx.project.is_remote) {
      await runRemoteGit(ctx.daemon, ctx.cwd, ['restore', '--staged', '.']);
      touchRemoteTotals(payload.taskId);
      return { ok: true };
    }
    await gitUnstageAll(ctx.cwd);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return { ok: true };
  }

  async function commitChanges(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const message = payload?.message;
    if (ctx.project.is_remote) {
      const res = await runRemoteGit(ctx.daemon, ctx.cwd, ['commit', '-m', message]);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'commit failed');
      const hashRes = await runRemoteGit(ctx.daemon, ctx.cwd, ['rev-parse', 'HEAD']);
      touchRemoteTotals(payload.taskId);
      return { hash: hashRes.stdout.trim(), output: res.stdout };
    }
    const result = await gitCommit(ctx.cwd, message);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return result;
  }

  async function revertCommit(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const hash = payload?.hash;
    if (ctx.project.is_remote) {
      const res = await runRemoteGit(ctx.daemon, ctx.cwd, ['revert', '--no-edit', hash]);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'revert failed');
      touchRemoteTotals(payload.taskId);
      return { output: res.stdout };
    }
    const result = await gitRevert(ctx.cwd, hash);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return result;
  }

  async function resetToCommit(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const hash = payload?.hash;
    if (ctx.project.is_remote) {
      const res = await runRemoteGit(ctx.daemon, ctx.cwd, ['reset', '--hard', hash]);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'reset failed');
      touchRemoteTotals(payload.taskId);
      return { output: res.stdout };
    }
    const result = await gitResetHard(ctx.cwd, hash);
    await gitWatcher.touchLocalTotals(ctx.cwd);
    return result;
  }

  async function pushChanges(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    if (ctx.project.is_remote) {
      const res = await runRemoteGit(ctx.daemon, ctx.cwd, ['push']);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'push failed');
      return { output: res.stdout + res.stderr };
    }
    return gitPush(ctx.cwd);
  }

  async function createPR(payload) {
    const ctx = scopeContext(payload);
    if (!ctx) throw new Error('no working directory for scope');
    const { title, body } = payload || {};
    if (ctx.project.is_remote) {
      const args = ['pr', 'create'];
      if (title) args.push('--title', title);
      if (body) args.push('--body', body);
      if (!title) args.push('--fill');
      const res = await ctx.daemon.exec({ cmd: 'gh', args, cwd: ctx.cwd });
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'gh pr create failed');
      const url = res.stdout.trim().split('\n').pop() ?? '';
      return { url };
    }
    return createGithubPR(ctx.cwd, title, body);
  }


  function remoteCacheKey(host, agentUser) {
    return `${host}::${agentUser || 'root'}`;
  }






  function getStarredAgents() {
    return db
      .prepare('SELECT agent_id FROM starred_agents ORDER BY starred_at ASC')
      .all()
      .map((r) => r.agent_id);
  }

  function setAgentStarred({ agentId, starred }) {
    if (!agentId) throw new Error('agentId is required');
    if (starred) {
      db.prepare(
        'INSERT OR IGNORE INTO starred_agents (agent_id, starred_at) VALUES (?, ?)'
      ).run(agentId, nowIso());
    } else {
      db.prepare('DELETE FROM starred_agents WHERE agent_id = ?').run(agentId);
    }
    const next = getStarredAgents();
    events.emit('agents:starred-changed', { starred: next });
    return { starred: next };
  }

  async function detectRemoteAgents(sshHost, agentUser) {
    const daemon = daemonFor(sshHost, agentUser);
    await daemon.ensureReady();








    const header = 'export PATH="$HOME/.local/bin:$PATH"; ';
    const script =
      header +
      PROVIDERS.filter((p) => p.cli)
        .map((p) => {
          const bin = p.cli.replace(/'/g, "'\\''");
          return `printf '%s|%s\\n' '${p.id}' "$(command -v '${bin}' 2>/dev/null || true)"`;
        })
        .join('; ');



    const res = await daemon.exec({
      cmd: 'sh',
      args: ['-c', script],
      loginShell: true,
    });
    const found = new Map();
    for (const line of (res.stdout || '').split('\n')) {
      const idx = line.indexOf('|');
      if (idx === -1) continue;
      const id = line.slice(0, idx).trim();
      const pathStr = line.slice(idx + 1).trim();
      if (id) found.set(id, pathStr);
    }
    const out = {};
    for (const provider of PROVIDERS) {
      if (!provider.cli) continue;
      const resolvedPath = found.get(provider.id) || '';
      const launchable = !!resolvedPath;
      out[provider.id] = providerToEntry(provider, {
        launchable,
        executable: launchable ? resolvedPath : null,
        reason: launchable ? null : `${provider.cli} not found on remote PATH`,
      });
    }
    for (const provider of PROVIDERS) {
      if (provider.cli) continue;
      const backing = Array.isArray(provider.backingAgents) ? provider.backingAgents : [];
      const available = backing.filter((id) => out[id]?.launchable);
      const launchable = available.length > 0;
      out[provider.id] = providerToEntry(provider, {
        launchable,
        executable: null,
        reason: launchable
          ? null
          : `Install ${backing.join(' or ') || 'a backing agent'} on the remote host`,
      });
    }
    return out;
  }

  // Probes a single CLI binary on the local machine: presence on PATH plus the
  // first line of `<bin> --version` if it exists. Used by the setup screen to
  // tell users at a glance whether git/node/gh/etc. are ready. Best-effort:
  // any failure in the version probe just leaves `version: null`.
  function probeSystemTool(bin, versionArgs = ['--version']) {
    const executable = which(bin);
    if (!executable) return { found: false, version: null, executable: null };
    let version = null;
    try {
      const out = execFileSync(executable, versionArgs, {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const firstLine = String(out || '').split('\n', 1)[0].trim();
      if (firstLine) version = firstLine;
    } catch {}
    return { found: true, version, executable };
  }

  // Returns the list of system tools the setup screen cares about. Order is
  // significant — the screen renders them in this order and groups by `kind`
  // so "required" comes before "recommended".
  async function getSystemTools() {
    const node = probeSystemTool('node', ['--version']);
    const nodeMajor = node.version ? parseInt(node.version.replace(/^v/, ''), 10) : 0;
    const nodeOk = node.found && nodeMajor >= 20;
    const git = probeSystemTool('git');
    const gh = probeSystemTool('gh', ['--version']);
    const platform = process.platform; // 'darwin' | 'linux' | 'win32'
    const brewHint = (pkg) => `brew install ${pkg}`;
    const aptHint = (pkg) => `sudo apt install ${pkg}`;
    const installHintFor = (pkg) =>
      platform === 'darwin' ? brewHint(pkg) : platform === 'linux' ? aptHint(pkg) : null;
    return [
      {
        id: 'git',
        label: 'Git',
        description: 'Source control. Required for every workspace.',
        kind: 'required',
        found: git.found,
        ok: git.found,
        version: git.version,
        installHint: git.found ? null : installHintFor('git'),
        docsUrl: 'https://git-scm.com/downloads',
      },
      {
        id: 'node',
        label: 'Node.js 20+',
        description: 'Runtime for installing the Claude Code, Codex, and Gemini CLIs via npm.',
        kind: 'required',
        found: node.found,
        ok: nodeOk,
        version: node.version,
        installHint:
          nodeOk
            ? null
            : platform === 'darwin' || platform === 'linux'
              ? 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install --lts'
              : null,
        docsUrl: 'https://nodejs.org/en/download',
        warnIfBelowMajor: !nodeOk && node.found ? 20 : null,
      },
      {
        id: 'gh',
        label: 'GitHub CLI',
        description: 'Optional but needed to list and create pull requests from inside Ace.',
        kind: 'recommended',
        found: gh.found,
        ok: gh.found,
        version: gh.version,
        installHint: gh.found ? null : installHintFor('gh'),
        docsUrl: 'https://cli.github.com/',
        postInstallHint: gh.found ? null : 'After install, run: gh auth login',
      },
    ];
  }

  async function getAgentCatalog(scope) {
    if (scope && scope.sshHost) {
      const key = remoteCacheKey(scope.sshHost, scope.agentUser || null);
      const cached = remoteAgentCache.get(key);
      if (cached && Date.now() - cached.at < 30_000) {
        return Object.values(cached.entries);
      }
      try {
        const entries = await detectRemoteAgents(
          scope.sshHost,
          scope.agentUser || null
        );
        remoteAgentCache.set(key, { entries, at: Date.now() });
        return Object.values(entries);
      } catch (err) {
        console.error('[ace] remote agent detect failed:', err.message);


        const fallback = {};
        for (const provider of PROVIDERS) {
          fallback[provider.id] = providerToEntry(provider, {
            launchable: false,
            executable: null,
            reason: `detection failed: ${err.message}`,
          });
        }
        return Object.values(fallback);
      }
    }
    const fresh = detectLocalAgents();
    for (const id of Object.keys(fresh)) localAgents[id] = fresh[id];
    return Object.values(localAgents);
  }



















  const INSTALL_PREP = [
    'set -e',
    'stty -echo 2>/dev/null || true',
    'cd "$HOME"',
    'mkdir -p "$HOME/.local/bin"',
    'if [ -w "$HOME" ] && ! grep -qs "\\.local/bin" "$HOME/.bashrc"; then',
    '  printf \'\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> "$HOME/.bashrc"',
    'fi',
    'export PATH="$HOME/.local/bin:$PATH"',
    'export npm_config_prefix="$HOME/.local"',
  ].join('\n');





  function cleanInstallOutput(text) {
    if (!text) return text;
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter(
        (line) =>
          !/cannot set terminal process group.*Inappropriate ioctl/.test(line) &&
          !/no job control in this shell/.test(line) &&
          !/^Script (?:started|done)/.test(line) &&
          !/^n\s*$/.test(line)
      )
      .join('\n');
  }






  function buildInstallScript(provider) {
    const header = INSTALL_PREP;
    const prereqLines = [];
    for (const id of provider.prerequisites ?? []) {
      const pre = PREREQUISITES[id];
      if (!pre) continue;
      const probe = pre.probe.replace(/'/g, "'\\''");
      const label = pre.label.replace(/'/g, "'\\''");
      const install = pre.install;





      if (pre.minMajor && pre.versionCmd) {
        prereqLines.push(
          `__ver="$(${pre.versionCmd} || true)"`,
          `if command -v '${probe}' >/dev/null 2>&1 && [ -n "$__ver" ] && [ "$__ver" -ge ${pre.minMajor} ] 2>/dev/null; then`,
          `  printf '✓ ${label} already installed (v%s)\\n' "$__ver"`,
          `else`,
          `  if command -v '${probe}' >/dev/null 2>&1; then`,
          `    printf '→ ${label} too old (have %s, need >=${pre.minMajor}), upgrading…\\n' "\${__ver:-?}"`,
          `  else`,
          `    printf '\\n→ installing prerequisite: ${label}\\n'`,
          `  fi`,
          `  ${install}`,




          `  unset npm_config_prefix`,
          `  __ver="$(${pre.versionCmd} || true)"`,
          `  if ! command -v '${probe}' >/dev/null 2>&1 || ! { [ -n "$__ver" ] && [ "$__ver" -ge ${pre.minMajor} ] 2>/dev/null; }; then`,
          `    printf '\\n[error] failed to provision ${label}\\n' 1>&2`,
          `    exit 1`,
          `  fi`,
          `fi`
        );
      } else {
        prereqLines.push(
          `if ! command -v '${probe}' >/dev/null 2>&1; then`,
          `  printf '\\n\\n→ installing prerequisite: ${label}\\n'`,
          `  ${install}`,
          `  if ! command -v '${probe}' >/dev/null 2>&1; then`,
          `    printf '\\n[error] failed to provision ${label}\\n' 1>&2`,
          `    exit 1`,
          `  fi`,
          `else`,
          `  printf '✓ ${label} already installed\\n'`,
          `fi`
        );
      }
    }
    return [
      header,
      ...prereqLines,
      `printf '\\n→ installing ${provider.name}\\n'`,
      provider.installCommand,
    ].join('\n');
  }

























  function wrapScriptForTty(scriptText) {
    const b64 = Buffer.from(scriptText, 'utf8').toString('base64');
    return [
      `TMP="$(mktemp /tmp/ace-install.XXXXXX)"`,
      `trap 'rm -f "$TMP"' EXIT`,
      `printf '%s' '${b64}' | base64 -d > "$TMP"`,
      `yes n | head -n 64 | script -qec "bash '$TMP'" /dev/null`,
    ].join(' && ');
  }















  async function ensureHelperSudo(sshHost, agentUser) {
    if (!sshHost || !agentUser) return;
    const rootDaemon = daemonFor(sshHost, null);
    await rootDaemon.ensureReady();
    const user = agentUser.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!user) return;
    const sudoersPath = `/etc/sudoers.d/ace-${user}`;
    const script = [
      'set -e',
      'if [ "$(id -u)" -ne 0 ]; then',
      '  echo "[warn] cannot configure passwordless sudo (ssh user is not root)" 1>&2',
      '  exit 0',
      'fi',
      `if [ -f ${sudoersPath} ]; then`,
      `  exit 0`,
      'fi',
      `TMP="$(mktemp)"`,
      `printf '%s ALL=(ALL) NOPASSWD: ALL\\n' ${user} > "$TMP"`,
      `chmod 0440 "$TMP"`,
      `if command -v visudo >/dev/null 2>&1 && ! visudo -cf "$TMP" >/dev/null 2>&1; then`,
      `  rm -f "$TMP"`,
      `  echo "[error] sudoers file for ${user} failed validation" 1>&2`,
      `  exit 1`,
      `fi`,
      `mv "$TMP" ${sudoersPath}`,
      `echo "✓ passwordless sudo configured for ${user}"`,
    ].join('\n');
    try {
      return await rootDaemon.exec({
        cmd: 'sh',
        args: ['-c', script],
        loginShell: false,
      });
    } catch (err) {
      return { code: -1, stdout: '', stderr: `ensureHelperSudo failed: ${err.message}` };
    }
  }








  async function installRemoteSystemPackages(sshHost, packages) {
    if (!packages || packages.length === 0) return { code: 0, stdout: '', stderr: '' };
    const rootDaemon = daemonFor(sshHost, null);
    await rootDaemon.ensureReady();
    const pkgs = packages.map((p) => p.replace(/[^a-zA-Z0-9._+-]/g, '')).join(' ');
    const script = [
      'set -e',
      'SUDO=""',
      'if [ "$(id -u)" -ne 0 ]; then',
      '  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then',
      '    SUDO="sudo -n"',
      '  else',
      `    echo "[warn] cannot install system packages (${pkgs}) — need root or passwordless sudo" 1>&2`,
      '    exit 0',
      '  fi',
      'fi',
      'export DEBIAN_FRONTEND=noninteractive',
      'export NEEDRESTART_MODE=a',
      `echo "→ installing system packages: ${pkgs}"`,
      'if command -v apt-get >/dev/null 2>&1; then',
      `  $SUDO apt-get update -qq && $SUDO apt-get install -y -q ${pkgs}`,
      'elif command -v dnf >/dev/null 2>&1; then',
      `  $SUDO dnf install -y -q ${pkgs}`,
      'elif command -v yum >/dev/null 2>&1; then',
      `  $SUDO yum install -y -q ${pkgs}`,
      'elif command -v pacman >/dev/null 2>&1; then',
      `  $SUDO pacman -S --noconfirm --needed ${pkgs}`,
      'elif command -v apk >/dev/null 2>&1; then',
      `  $SUDO apk add --no-progress ${pkgs}`,
      'else',
      `  echo "[warn] no known package manager found — please install ${pkgs} manually" 1>&2`,
      '  exit 0',
      'fi',
    ].join('\n');
    return rootDaemon.exec({
      cmd: 'sh',
      args: ['-c', script],
      loginShell: false,
      timeoutMs: 10 * 60 * 1000,
    });
  }







  function cleanChunk(text) {
    if (!text) return text;
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalised
      .split('\n')
      .filter(
        (line) =>
          !/^n\s*$/.test(line) &&
          !/^Script (?:started|done)/.test(line) &&
          !/cannot set terminal process group.*Inappropriate ioctl/.test(line) &&
          !/no job control in this shell/.test(line)
      )
      .join('\n');
  }













  async function startInstallAgent({ agentId, sshHost, agentUser }) {
    const provider = getProvider(agentId);
    if (!provider) throw new Error(`unknown agent: ${agentId}`);
    if (!provider.installCommand)
      throw new Error(`${provider.name} has no install command configured`);
    const streamId = `install-${randomUUID().slice(0, 8)}`;







    if (!sshHost && process.platform === 'win32') {
      setImmediate(() => {
        events.emit('install:data', {
          streamId,
          chunk:
            `Automated install on native Windows isn't supported yet.\n` +
            `Copy the command above and run it in Windows Terminal (PowerShell or WSL).\n` +
            `Remote (SSH) installs to Linux hosts continue to work from Windows.\n`,
        });
        events.emit('install:exit', { streamId, code: -1 });
      });
      return { streamId };
    }

    const wrapped = buildInstallScript(provider);

    const emit = (chunk) => {
      events.emit('install:data', { streamId, chunk: cleanChunk(chunk) });
    };
    const finish = (code) => {
      events.emit('install:exit', { streamId, code });
    };







    const runSystemPrefix = async () => {
      if (!sshHost) return;
      if (agentUser) {
        try {
          const su = await ensureHelperSudo(sshHost, agentUser);
          if (su?.stdout) emit(su.stdout);
          if (su?.stderr) emit(su.stderr);
        } catch (err) {
          emit(`[warn] sudo setup failed: ${err.message}\n`);
        }
      }
      if (!provider.systemPackages || provider.systemPackages.length === 0) return;
      try {
        const sys = await installRemoteSystemPackages(
          sshHost,
          provider.systemPackages
        );
        if (sys.stdout) emit(sys.stdout);
        if (sys.stderr) emit(sys.stderr);
      } catch (err) {
        emit(`[warn] system package install failed: ${err.message}\n`);
      }
    };



    (async () => {
      try {
        await runSystemPrefix();
        if (sshHost) {
          await runRemoteInstallPty({ streamId, sshHost, agentUser, wrapped, emit, finish });
        } else {
          runLocalInstallPty({ streamId, wrapped, emit, finish });
        }
      } catch (err) {
        emit(`[error] ${err.message}\n`);
        finish(-1);
      }
    })();

    return { streamId };
  }

  async function runRemoteInstallPty({ sshHost, agentUser, wrapped, emit, finish }) {
    const daemon = daemonFor(sshHost, agentUser || null);
    await daemon.ensureReady();




    const runner = wrapScriptForTty(wrapped);
    const result = await daemon.startPty({
      cmd: 'sh',
      args: ['-c', runner],
      cols: 120,
      rows: 30,
      cwd: null,
      env: ['TERM=xterm-256color'],
    });
    const ptyId = result.id;
    const onData = ({ id, data }) => {
      if (id !== ptyId) return;
      const chunk = Buffer.from(data || '', 'base64').toString('utf8');
      emit(chunk);
    };
    const onExit = ({ id, code }) => {
      if (id !== ptyId) return;
      daemon.off('pty.data', onData);
      daemon.off('pty.exit', onExit);
      remoteAgentCache.delete(remoteCacheKey(sshHost, agentUser || null));
      finish(code ?? -1);
    };
    daemon.on('pty.data', onData);
    daemon.on('pty.exit', onExit);
  }

  function runLocalInstallPty({ wrapped, emit, finish }) {
    if (!pty) {


      const shellPath = defaultShell();
      const { spawn } = require('child_process');
      const child = spawn(shellPath, ['-lc', wrapped], { env: process.env });
      child.stdout.on('data', (d) => emit(d.toString()));
      child.stderr.on('data', (d) => emit(d.toString()));
      child.on('close', (code) => {
        const fresh = detectLocalAgents();
        for (const id of Object.keys(fresh)) localAgents[id] = fresh[id];
        finish(code ?? -1);
      });
      child.on('error', (err) => {
        emit(`[error] ${err.message}\n`);
        finish(-1);
      });
      return;
    }
    const shellPath = defaultShell();
    const env = { ...process.env, TERM: 'xterm-256color' };



    const proc = pty.spawn(shellPath, ['-lc', wrapped], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: os.homedir(),
      env,
    });
    // Same node-pty threadsafe-callback hazard as the main registry: never let
    // a handler throw back into node-pty (it would abort the process).
    proc.onData((chunk) => {
      try {
        emit(chunk);
      } catch (err) {
        console.error('[ace] local-agent pty onData failed (suppressed):', err);
      }
    });
    proc.onExit(({ exitCode }) => {
      try {
        const fresh = detectLocalAgents();
        for (const id of Object.keys(fresh)) localAgents[id] = fresh[id];
        finish(exitCode ?? -1);
      } catch (err) {
        console.error('[ace] local-agent pty onExit failed (suppressed):', err);
        try { finish(-1); } catch {}
      }
    });
  }











  for (const row of db.prepare('SELECT path, is_remote FROM projects').all()) {
    if (!row.is_remote) ensureLocalExclude(row.path);
  }
  const startupWatcherRows = db
    .prepare(
      `SELECT t.id, p.is_remote FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.archived_at IS NULL`
    )
    .all();
  const attachLocalStartupGitWatchers = shouldAttachStartupGitWatchers();
  for (const row of startupWatcherRows) {
    if (row.is_remote) remoteGitPoller.attachTask(row.id);
    else if (attachLocalStartupGitWatchers) gitWatcher.attachTask(row.id);
  }






  const warmTargets = db
    .prepare(
      `SELECT DISTINCT ssh_host, agent_user FROM projects
       WHERE is_remote = 1 AND ssh_host IS NOT NULL`
    )
    .all();
  for (const { ssh_host, agent_user } of warmTargets) {
    sshDaemons.warm(ssh_host, agent_user);
  }

  // killDetached (default false) is set only on a fail-closed AUTH teardown: a
  // signed-out user retains NO agents, so even host-backed detached PTYs are killed
  // (awaiting bounded daemon-confirmed kills before the host socket closes). A normal
  // quit keeps them — their agent_resume_state rows survive for next-boot adoption.
  function shutdown({ killDetached = false } = {}) {
    if (alwaysOnOrchestratorWatchdog) {
      alwaysOnOrchestratorWatchdog.stop();
      alwaysOnOrchestratorWatchdog = null;
    }
    try { hermesDashboards.stopAll(); } catch {}
    const pendingKills = ptyRegistry.killAll({ preserveDetached: !killDetached }) || [];
    gitWatcher.shutdown();
    remoteGitPoller.shutdown();
    sshDaemons.closeAll();
    try { knowledgeIndexInstance?.close(); } catch {}
    try {
      db.close();
    } catch {}
    const closeHost = () => { try { ptyHost?.close(); } catch {} };
    // Auth teardown ALWAYS terminates the host by PID — even with zero registered
    // kills, since the registry may miss unregistered survivors (partial adoption).
    if (killDetached) {
      return (async () => {
        // hostPid is learned LAZILY; discover a survivor's real PID via a bounded,
        // SURVIVOR-ONLY connect (never ensureConnected/spawn — a lingering spawn could
        // outlive sign-out). Awaited, so nothing trails the teardown.
        const pid = await discoverSurvivorHostPid(ptyHost, DETACHED_KILL_CONFIRM_TIMEOUT_MS);
        // Prefer the retained ChildProcess handle if THIS session spawned the daemon
        // (immune to pid reuse); otherwise identity-verify the adopted pid before each
        // signal so a post-SIGTERM reuse is never blind-killed.
        const childHandle = typeof ptyHost?.spawnedChildHandle === 'function' ? ptyHost.spawnedChildHandle() : null;
        await terminateDetachedHost({
          pendingKills,
          hostPid: typeof pid === 'number' ? pid : null,
          timeoutMs: DETACHED_KILL_CONFIRM_TIMEOUT_MS,
          childHandle,
          verifyIdentity: typeof pid === 'number' ? makeHostIdentityGuard(pid) : undefined,
        });
        closeHost();
      })();
    }
    closeHost();
    return Promise.resolve();
  }




  async function listRemoteHosts() {
    return { hosts: await listSshHosts() };
  }

  function getTaskIntegrationContext(taskId) {
    const task = stmts.getTaskById.get(taskId);
    if (!task) return null;
    const wt = stmts.getWorktreesByTask.all(taskId)[0] || null;
    const cwd = resolveTaskCwd(taskId);
    if (!cwd) return null;
    const project = stmts.getProjectById.get(task.project_id);
    const repoCwd = project ? (project.is_remote ? project.remote_path : project.path) : cwd;
    return {
      taskId,
      projectId: task.project_id,
      cwd,
      repoCwd,
      branch: wt ? wt.branch : null,
      baseBranch: wt ? wt.base_branch : null,
      worktreePath: wt ? wt.path : null,
    };
  }

  function integrationForTask(taskId) {
    if (!taskId) throw new Error('taskId is required');
    const ctx = getTaskIntegrationContext(taskId);
    if (!ctx) throw new Error(`no integration context for task ${taskId}`);
    const gatewayFactory = (testHooks as any).createIntegrationGateway || createIntegrationGateway;
    const gw = gatewayFactory({
      cwd: ctx.cwd,
      repoCwd: ctx.repoCwd,
      logger: console,
      archiveTaskImpl: (input) => archiveTask(input),
    });
    gw.on('integration', (envelope) => {
      events.emit('integration:event', { taskId, envelope });
    });
    return { gw, ctx };
  }

  async function integrationPush({ taskId, branch, remote, force } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    const imported = db.prepare(
      'SELECT push_url FROM integration_context_imports WHERE task_id = ?',
    ).get(taskId);
    if (imported && (typeof imported.push_url !== 'string'
      || imported.push_url.length === 0
      || /[\u0000-\u001f\u007f]/.test(imported.push_url))) {
      const error: any = new Error('imported integration context lacks immutable push URL evidence');
      error.code = 'imported_push_evidence_missing';
      throw error;
    }
    return gw.push({
      branch: branch || ctx.branch,
      remote,
      force,
      ...(imported ? { importedPushUrl: imported.push_url } : {}),
    });
  }

  async function integrationOpenPr({ taskId, base, head, title, body, draft, remote, allowedPaths } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    const linked = findMissionFeatureByTask(taskId);
    const feature = linked ? missionFeatureGateEvidence(linked.mission, linked.feature) : null;
    const scopedAllowedPaths = Array.isArray(allowedPaths) && allowedPaths.length > 0
      ? allowedPaths
      : feature?.allowPaths || [];
    const result = await gw.openPr({
      base: base || ctx.baseBranch || 'main',
      head: head || ctx.branch,
      title,
      body,
      draft,
      remote,
      allowedPaths: scopedAllowedPaths,
      expectedBaseSha: feature?.prBaseSha || feature?.baseSha || null,
    });
    const preflight = result?.result?.preflight || null;
    if (linked && result?.ok === true && preflight?.remoteBaseSha) {
      const detail = preflight.baseRefresh?.refreshed
        ? `pr-open base evidence refreshed: ${preflight.baseRefresh.previousBaseSha} -> ${preflight.remoteBaseSha}`
        : `pr-open base evidence verified: ${preflight.remoteBaseSha}`;
      db.prepare(
        `UPDATE mission_features
         SET pr_head_ref=COALESCE(@pr_head_ref, pr_head_ref),
             pr_base_ref=COALESCE(@pr_base_ref, pr_base_ref),
             pr_head_sha=COALESCE(@pr_head_sha, pr_head_sha),
             pr_base_sha=COALESCE(@pr_base_sha, pr_base_sha),
             gate_detail=@gate_detail,
             last_seen_state=@last_seen_state
         WHERE id=@id`
      ).run({
        id: linked.feature.id,
        pr_head_ref: cleanMissionString(head || ctx.branch),
        pr_base_ref: cleanMissionString(preflight.baseBranch || base || ctx.baseBranch || 'main'),
        pr_head_sha: cleanMissionString(preflight.headSha),
        pr_base_sha: cleanMissionString(preflight.remoteBaseSha),
        gate_detail: detail.slice(0, 4000),
        last_seen_state: preflight.baseRefresh?.refreshed ? 'pre_pr_base_refreshed' : 'pr_open_preflight_passed',
      });
      updateTaskWorktreeBaseEvidence({
        taskId,
        baseRef: preflight.baseBranch || base || ctx.baseBranch || 'main',
        baseSha: preflight.remoteBaseSha,
      });
      result.result.missionBaseEvidence = {
        missionId: linked.mission.id,
        featureId: linked.feature.id,
        baseRef: preflight.baseBranch || base || ctx.baseBranch || 'main',
        baseSha: preflight.remoteBaseSha,
        headSha: preflight.headSha || null,
        refreshed: preflight.baseRefresh?.refreshed === true,
      };
      recordMissionBoardEvent(
        linked.mission.id,
        MISSION_EVENT_TYPES.NOTE,
        detail,
        linked.feature.workerAgent ?? null,
        linked.feature.id
      );
    }
    if (ctx.projectId) {
      const refresh = (testHooks as any).refreshWorkspaceMeta || refreshWorkspaceMeta;
      await refresh(ctx.projectId);
      emitState();
    }
    return result;
  }

  async function integrationPollChecks({ taskId, prNumber, branch } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    return gw.pollChecks({ prNumber, branch: branch || ctx.branch });
  }

  // Ready-head review request surface (contractual review closure): mark the
  // task's draft PR ready so the review-bot's ready_for_review trigger fires,
  // and post the /codex review request comment. Both are thin gateway passes —
  // idempotency (once per exact head) lives in the spine's review.requested
  // ledger event.
  async function integrationReadyPr({ taskId, prNumber } = {}) {
    const { gw } = integrationForTask(taskId);
    return gw.readyPr({ prNumber });
  }

  async function integrationRequestReview({ taskId, prNumber, body } = {}) {
    const { gw } = integrationForTask(taskId);
    return gw.requestReview({ prNumber, body });
  }

  async function integrationGate({ taskId, prNumber, branch, remote, allowedPaths, clawpatchEnforced } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    const linked = findMissionFeatureByTask(taskId);
    const feature = linked ? missionFeatureGateEvidence(linked.mission, linked.feature) : null;
    const validation = missionFeatureValidationForGate(linked?.feature || null);
    const scopedAllowedPaths = Array.isArray(allowedPaths) && allowedPaths.length > 0
      ? allowedPaths
      : feature?.allowPaths || [];
    const gate = {
      expectedBaseBranch: ctx.baseBranch || 'main',
      validation,
      validationRequired: validation.required === true,
      expectedPrHeadRef: feature?.prHeadRef || null,
      expectedPrBaseRef: feature?.prBaseRef || null,
      expectedPrHeadSha: feature?.prHeadSha || null,
      allowedPaths: scopedAllowedPaths,
      expectedPrBaseSha: feature?.prBaseSha || feature?.baseSha || null,
      clawpatchEnforced: clawpatchEnforced === true,
    };
    return gw.gatePr({
      prNumber,
      taskId,
      branch: branch || ctx.branch,
      worktreePath: ctx.worktreePath,
      remote,
      gate,
      feature,
    });
  }

  async function integrationMergePr({
    taskId,
    prNumber,
    method,
    deleteBranch,
    auto,
    autoAdmin,
    admin,
    adminReason,
    branch,
    worktreePath,
    prUrl,
    mergedAt,
    gate,
    allowedPaths,
  } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    const linked = findMissionFeatureByTask(taskId);
    const feature = linked ? missionFeatureGateEvidence(linked.mission, linked.feature) : null;
    const validation = missionFeatureValidationForGate(linked?.feature || null);
    const scopedAllowedPaths = Array.isArray(allowedPaths) && allowedPaths.length > 0
      ? allowedPaths
      : Array.isArray(gate?.allowedPaths) && gate.allowedPaths.length > 0
        ? gate.allowedPaths
        : feature?.allowPaths || [];
    const mergeGate = {
      ...(gate && typeof gate === 'object' ? gate : {}),
      ...(ctx.baseBranch && !(gate && typeof gate === 'object' && gate.expectedBaseBranch)
        ? { expectedBaseBranch: ctx.baseBranch }
        : {}),
      ...(linked ? {
        validation,
        validationRequired: true,
        expectedPrHeadRef: feature?.prHeadRef || null,
        expectedPrBaseRef: feature?.prBaseRef || null,
        expectedPrHeadSha: feature?.prHeadSha || null,
        expectedPrBaseSha: feature?.prBaseSha || feature?.baseSha || null,
      } : {}),
      allowedPaths: scopedAllowedPaths,
    };
    return gw.mergePr({
      prNumber,
      method,
      deleteBranch,
      auto,
      autoAdmin,
      admin,
      adminReason,
      taskId,
      branch: branch || ctx.branch,
      worktreePath: worktreePath || ctx.worktreePath,
      prUrl,
      mergedAt,
      gate: mergeGate,
      feature,
      // P7: thread the mission identity into the squash commit body so
      // release.yml can post RELEASE_PUBLISHED/FAILED back to the right card
      // (and skip silently for non-mission pushes).
      missionRef: linked ? { missionId: linked.mission.id, featureId: linked.feature.id } : null,
    });
  }

  async function integrationCleanup({
    taskId,
    branch,
    worktreePath,
    remote,
    includeRemote,
    deleteLocalBranch,
    removeWorktree,
    dryRun,
    prState,
    mergedSha,
  } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    const env = await gw.cleanup({
      branch: branch || ctx.branch,
      worktreePath: worktreePath || ctx.worktreePath,
      remote,
      includeRemote,
      deleteLocalBranch,
      removeWorktree,
      baseBranch: ctx.baseBranch,
      prState,
      mergedSha,
      dryRun,
    });
    return env;
  }

  async function integrationPostMergeCleanup({
    taskId,
    branch,
    worktreePath,
    remote,
    prUrl,
    mergedAt,
    mergedSha,
  } = {}) {
    const { gw, ctx } = integrationForTask(taskId);
    return gw.postMergeCleanup({
      taskId,
      branch: branch || ctx.branch,
      worktreePath: worktreePath || ctx.worktreePath,
      remote,
      prUrl,
      mergedAt,
      mergedSha,
      baseBranch: ctx.baseBranch,
      prState: 'MERGED',
    });
  }




  const remoteStmts = {
    getSettings: db.prepare('SELECT * FROM remote_settings WHERE id=1'),
    setEnabled: db.prepare('UPDATE remote_settings SET enabled=? WHERE id=1'),
    setPort: db.prepare('UPDATE remote_settings SET port=? WHERE id=1'),
    setTunnelMode: db.prepare('UPDATE remote_settings SET tunnel_mode=? WHERE id=1'),
    setCloudflareConfig: db.prepare(
      `UPDATE remote_settings
       SET cloudflare_domain=?, cloudflare_tunnel_id=?, cloudflare_tunnel_name=?
       WHERE id=1`
    ),
    insertDevice: db.prepare(
      `INSERT INTO remote_devices (id, name, token_hash, created_at, last_seen, revoked)
       VALUES (?, ?, ?, ?, NULL, 0)`
    ),
    findByHash: db.prepare('SELECT * FROM remote_devices WHERE token_hash=?'),
    touchDevice: db.prepare('UPDATE remote_devices SET last_seen=? WHERE id=?'),
    listDevices: db.prepare('SELECT * FROM remote_devices ORDER BY created_at DESC'),
    revokeDevice: db.prepare('UPDATE remote_devices SET revoked=1 WHERE id=?'),
    deleteDevice: db.prepare('DELETE FROM remote_devices WHERE id=?'),
  };

  function getRemoteSettings() {
    const row = remoteStmts.getSettings.get();
    return {
      enabled: !!row?.enabled,
      port: row?.port || 9419,
      tunnelMode: row?.tunnel_mode || 'lan',
      serverSecret: row?.server_secret || '',
      cloudflareDomain: row?.cloudflare_domain || null,
      cloudflareTunnelId: row?.cloudflare_tunnel_id || null,
      cloudflareTunnelName: row?.cloudflare_tunnel_name || null,
    };
  }

  function setRemoteEnabled(enabled) {
    remoteStmts.setEnabled.run(enabled ? 1 : 0);
    events.emit('remote:settings-changed', getRemoteSettings());
    return getRemoteSettings();
  }

  function setRemoteTunnelMode(mode) {
    const allowed = new Set(['loopback', 'lan', 'tailscale', 'cloudflared']);
    if (!allowed.has(mode)) throw new Error(`unknown tunnel mode: ${mode}`);
    remoteStmts.setTunnelMode.run(mode);
    events.emit('remote:settings-changed', getRemoteSettings());
    return getRemoteSettings();
  }

  function setRemoteCloudflareConfig({ domain, tunnelId, tunnelName }) {
    remoteStmts.setCloudflareConfig.run(domain || null, tunnelId || null, tunnelName || null);
    events.emit('remote:settings-changed', getRemoteSettings());
    return getRemoteSettings();
  }

  function findRemoteDeviceByHash(hash) {
    const row = remoteStmts.findByHash.get(hash);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      revoked: !!row.revoked,
    };
  }

  function touchRemoteDevice(id) {
    remoteStmts.touchDevice.run(new Date().toISOString(), id);
  }

  function registerRemoteDevice({ name, tokenHash }) {
    const id = newId('dev');
    const now = new Date().toISOString();
    remoteStmts.insertDevice.run(id, name || 'Unnamed device', tokenHash, now);
    events.emit('remote:devices-changed', listRemoteDevices());
    return { id, name, tokenHash, createdAt: now };
  }

  function listRemoteDevices() {
    return remoteStmts.listDevices.all().map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      revoked: !!row.revoked,
    }));
  }

  function revokeRemoteDevice({ deviceId }) {
    remoteStmts.revokeDevice.run(deviceId);
    events.emit('remote:devices-changed', listRemoteDevices());
    return listRemoteDevices();
  }

  async function pasteClipboardImageRemote({ taskId, bytes, ext }) {
    const ctx = taskContext(taskId);
    if (!ctx || !ctx.project.is_remote) {
      throw new Error('task is not on a remote workspace');
    }
    const safeExt = /^[a-z0-9]{1,6}$/i.test(String(ext || '')) ? String(ext).toLowerCase() : 'png';
    // The HTTP/PWA bridge JSON-encodes Uint8Array as a plain numeric-keyed
    // object — share coerceBuffer with the local-paste path so both runtimes
    // accept the same {base64 | Uint8Array | array | numeric-object} shapes.
    const buf = coerceAttachmentBytes(bytes);
    if (!buf) return { path: null, error: 'attachment bytes were unreadable' };
    if (buf.length === 0) return { path: null, error: 'attachment was empty' };
    // ensureReady() inside the daemon's RPC methods resolves `~` in
    // pastesDir to an absolute path on first connect, so whatever we read
    // here is either already absolute (agentUser mode) or has been rewritten
    // to absolute by _spawnAndVerify. Either way, no shell-expansion needed.
    await ctx.daemon.ensureReady();
    const pastesDir = ctx.daemon.pastesDir || '~/.ace-pastes';
    const remotePath = `${pastesDir}/paste-${randomUUID()}.${safeExt}`;
    await ctx.daemon.fsMkdir(pastesDir, true);
    await ctx.daemon.fsWrite(remotePath, buf);
    return { path: remotePath };
  }

  const publicApi = {

    events,
    onState: (listener) => {
      events.on('state', listener);
      return () => events.off('state', listener);
    },
    onPtyData: (listener) => {
      events.on('pty:data', listener);
      return () => events.off('pty:data', listener);
    },
    onPtyOpened: (listener) => {
      events.on('pty:opened', listener);
      return () => events.off('pty:opened', listener);
    },
    onPtyExit: (listener) => {
      events.on('pty:exit', listener);
      return () => events.off('pty:exit', listener);
    },
    onGitChanged: (listener) => {
      events.on('git:changed', listener);
      return () => events.off('git:changed', listener);
    },
    onInstallData: (listener) => {
      events.on('install:data', listener);
      return () => events.off('install:data', listener);
    },
    onInstallExit: (listener) => {
      events.on('install:exit', listener);
      return () => events.off('install:exit', listener);
    },
    onStarredAgentsChanged: (listener) => {
      events.on('agents:starred-changed', listener);
      return () => events.off('agents:starred-changed', listener);
    },
    onRemoteSettingsChanged: (listener) => {
      events.on('remote:settings-changed', listener);
      return () => events.off('remote:settings-changed', listener);
    },
    onRemoteDevicesChanged: (listener) => {
      events.on('remote:devices-changed', listener);
      return () => events.off('remote:devices-changed', listener);
    },
    onConversationClosed: (listener) => {
      events.on('conversation:closed', listener);
      return () => events.off('conversation:closed', listener);
    },
    onIntegrationEvent: (listener) => {
      events.on('integration:event', listener);
      return () => events.off('integration:event', listener);
    },
    onOpsIntelRefreshed: (listener: any) => {
      events.on('ops:intel-refreshed', listener);
      return () => events.off('ops:intel-refreshed', listener);
    },
    onOpsBriefDelivered: (listener: any) => {
      events.on('ops:brief-delivered', listener);
      return () => events.off('ops:brief-delivered', listener);
    },
    onHermesDesktopEvent: (listener: any) => {
      events.on('hermes-desktop:event', listener);
      return () => events.off('hermes-desktop:event', listener);
    },

    // Browser surface events. Emitters are called by the browser controller,
    // the login-url watcher, and the browser-stream module (all wired in
    // main.cts); listeners feed the desktop IPC broadcast AND the remote
    // server's per-connection forwarders, so phone clients see the same
    // open-tab requests and stream frames the desktop renderer does.
    onBrowserUiRequest: (listener: any) => {
      events.on('browser:ui-request', listener);
      return () => events.off('browser:ui-request', listener);
    },
    onBrowserControlStatus: (listener: any) => {
      events.on('browser:control-status', listener);
      return () => events.off('browser:control-status', listener);
    },
    onBrowserStreamEvent: (listener: any) => {
      events.on('browser:stream-event', listener);
      return () => events.off('browser:stream-event', listener);
    },
    emitBrowserUiRequest: (payload: any) => events.emit('browser:ui-request', payload),
    emitBrowserControlStatus: (payload: any) => events.emit('browser:control-status', payload),
    emitBrowserStreamEvent: (payload: any) => events.emit('browser:stream-event', payload),

    getState,
    seedState: () => getState(),
    startWorkspaceMetaRefresh,
    perfHealth: () => perfHealth.health(),
    perfRecord: (p: any = {}) => {
      perfHealth.record(p || {});
      return { ok: true };
    },
    // Operations Cockpit health probe (ace.ops.status.v1). The SAME probe
    // logic backs both the `ace ops status` CLI command (via the socket
    // bridge) and the renderer (via an ipcMain handler) — there is no
    // duplicated probe code. `userDataPath`/`socketPath` are injected so the
    // db + runtime probes resolve paths without re-deriving the data root.
    opsStatus: (p = {}) =>
      runOpsStatus({
        ...p,
        userDataPath,
        socketPath: aceSocketPath(userDataPath),
      }),
    // Evidence-only daily snapshot (also invoked by scheduleOpsStatusSnapshot).
    opsStatusSnapshot: (p = {}) => opsStatusSnapshot(p),
    // Derived-on-read signals inbox + recommendations (no table, no migration).
    streamOperationsSignals: (p = {}) => streamOperationsSignals(p),
    streamOperationsRecommendations: (p = {}) => streamOperationsRecommendations(p),
    // ops-v2 W1: on-demand intel brief (scheduler injects live delta in W5).
    streamOperationsBrief: (p = {}) => streamOperationsBrief(p),
    // ops-v2: full Vector Ops dashboard intel (all sections).
    streamOperationsIntel: () => streamOperationsIntel(),
    // ops-v2 W5: generate + deliver a lens brief (called by the brief scheduler).
    deliverOpsBrief: (p = {}) => deliverOpsBrief(p),
    // ops-v2 G3/G5: schedule status surface + manual "Generate brief now".
    opsBriefSchedule: () =>
      opsBriefScheduler.briefScheduleStatus({
        now: Date.now(),
        stateDir: userDataPath,
        schedule: readOpsBriefConfig().schedule,
        todayPath: opsTodayBriefPath(),
      }),
    opsBriefGenerate: (p: any = {}) => deliverOpsBrief(p || {}),
    // Effective slot override for the scheduler arm (main.cts) — already
    // normalized (invalid config falls back to 7:30/13:00/20:30 defaults).
    opsBriefScheduleOverride: () => readOpsBriefConfig().schedule,
    // ops-v2 W6: Chief's todo intake (JSON-backed, fail-safe). Dev todos promote
    // to Mission Board candidates; non-dev stay assignable.
    opsTodosList: () => opsTodos.listTodos(),
    opsTodoCreate: (p: any = {}) => opsTodos.addTodo(p || {}),
    opsTodoUpdate: (p: any = {}) => opsTodos.patchTodo(p?.id, p?.patch || {}),
    opsTodoRemove: (p: any = {}) => opsTodos.removeTodo(p?.id),
    // D8/D9: latest twice-daily digest (rule-based proposals) + manual
    // "Synthesize now". Slot defaults by local clock: before 14:00 → morning.
    opsTodoDigest: () => opsTodos.readTodoDigest(),
    opsTodoSynthesize: (p: any = {}) =>
      deliverTodoDigest({
        slot: p?.slot || (new Date().getHours() < 14 ? 'morning' : 'night'),
        now: Date.now(),
      }),
    // Scheduler entry point (main.cts todo-digest timers) — like deliverOpsBrief.
    deliverTodoDigest: (p: any = {}) => deliverTodoDigest(p || {}),
    // ops-v2 W7: editable Sources/watchlist (latest.json defaults + local edits;
    // never writes to source code).
    opsSourcesGet: () => {
      let report: any = null;
      try {
        report = vectorOpsAdapter.loadLatestReport().report;
      } catch {
        report = null;
      }
      const derived = opsSources.deriveWatchlists(report);
      const local = opsSources.loadLocalSources();
      // S3: per-source refresh state rides along (additive to v1 fields).
      return { ...opsSources.mergeSources(derived, local), refresh: opsSourceState() };
    },
    // S3: manual/scheduled source refresh (all registry sources) + persisted
    // per-source lastAttempt/lastSuccess state snapshot.
    opsRefreshSources: (p: any = {}) => opsRefreshSources(p || {}),
    opsSourceState: () => opsSourceState(),
    opsSourcesUpdate: (p: any = {}) => opsSources.saveLocalSources(p?.watchlists || {}),
    // ops-v2 W8: Obsidian-style wiki graph. Root resolves through opsWikiRoot()
    // (ACE_WIKI_ROOT override honored) so graph/page/raw never split-brain.
    opsWikiGraph: () => wikiGraphIndexer.buildWikiGraph({ root: opsWikiRoot() }),
    // LLM-wiki health (AceWikiHealth/v1): per-project dump-only/canon/source
    // metrics + index counts + last nightly. Same engine `ace wiki health`
    // uses, so the Wiki tab and the CLI never split-brain.
    opsWikiHealth: () => {
      let rows: any[] = [];
      try { rows = db.prepare('SELECT id, path FROM projects').all(); } catch { rows = []; }
      let index: any = null;
      try { index = knowledgeIndex().describe(); } catch { index = null; }
      let nightly: any = null;
      try { const st = readNightlyState(userDataPath); if (st && st.at) nightly = { at: st.at, status: st.status || 'ok' }; } catch { nightly = null; }
      return wikiHealthModule.buildWikiHealth({
        projectDirs: rows.filter((r) => r?.path).map((r) => ({ id: r.id, path: r.path })),
        index,
        nightly,
      });
    },
    // ops-v2 I2: traversal-safe page reader for the wiki viewer + hovers.
    opsWikiPage: (p: any = {}) =>
      wikiGraphIndexer.readWikiPage({ root: opsWikiRoot(), relPath: p?.relPath }),
    // Resolved wiki root (display + reveal-in-Finder path resolution).
    opsWikiRootPath: () => ({ root: opsWikiRoot() }),
    // Knowledge plane: unified FTS5 search across the ops wiki, project wikis
    // and dump intake. Socket-callable, so `ace memory search|get` hit the
    // same engine the UI uses.
    knowledgeSearch: (p: any = {}) => knowledgeSearch(p),
    knowledgeGet: (p: any = {}) => knowledgeGet(p),
    knowledgeReindex: () => knowledgeReindex(),
    knowledgeStatus: () => knowledgeStatus(),
    knowledgeOverview: () => knowledgeOverview(),
    knowledgeNightly: (p: any = {}) => knowledgeNightly(p),
    knowledgeNightlyStatus: () => knowledgeNightlyStatus(),
    knowledgeQuarantineList: () => knowledgeQuarantineList(),
    knowledgeQuarantineResolve: (p: any = {}) => knowledgeQuarantineResolve(p),
    knowledgeEval: () => knowledgeEval(),

    // Materialize the visible Loops workspace row (PRD §10 §4): a real projects row
    // at <root>/workspaces/loops so the Workspaces sidebar can group it under a
    // separate 'System' group. Idempotent (importWorkspace returns the existing id).
    // Resolved against the external SSD data root when active (never hardcoded), else
    // userData. Returns { id } | { error } — fail-safe so a boot call never throws.
    ensureLoopWorkspace,

    importWorkspace,
    importRemoteWorkspace,
    listRemoteHosts,
    listRemoteDir,
    createRemoteDir,
    removeWorkspace,
    initializeWorkspace,
    browseLocalDir,
    refreshWorkspace,
    refreshProjectDefaultBranch,
    setWorkspaceBaseBranch,
    getEffectiveBaseBranch,
    deleteBranch,
    cloneWorkspace,
    getWorkspaceStats,
    getWorkspaceStatsDetail,
    listTrackedGithubProjects,

    createTask,
    createThread,
    createAdhocThread,
    createDelegatedTask,
    verifyTaskProgress,
    startHermesOrchestrator,
    startOrchestrator,
    setAlwaysOnOrchestrator: (p) => setAlwaysOnOrchestrator(p),
    listAgentLanes,
    listHermesProfiles,
    listOrchestratorTemplates,
    createAgentLane,
    autoStartAlwaysOnOrchestrators,
    autoStartAgentLanes,
    autoStartAllOrchestrators,
    startAlwaysOnOrchestratorWatchdog,
    getOrCreatePersonalWorkspace,
    getOrCreatePersonalIdentityWorkspace,
    deleteTask,
    archiveTask,
    unarchiveTask,
    setTaskAutoApprove,
    getTaskSpec,

    createConversation,
    closeConversation,
    activateConversation,

    resolveStreamOwner,
    getContextForStream,
    writeSessionIdForStream,
    canBindSessionIdForStream,
    resolveLiveClaudeSessionIdForStream,
    killStream: (streamId) => ptyRegistry.killStream(streamId),
    // Test-only seam (default OFF): the restart/resume wiring lives in closures
    // internal to createAceStore, so tests that must drive the ACTUAL production
    // functions — not a recomposition — reach them here.
    ...((testHooks as any).exposeInternals === true ? {
      _internals: {
        handleLocalStreamExit,
        restoreAgentStreams,
        restoredLaneClassification,
        getStream: (streamId: any) => ptyRegistry.getStream(streamId),
        laneLaunchIntent: (streamId: any) => ptyRegistry.getStream(streamId)?.launchIntent ?? null,
        // Session-resume decision seam — drive the REAL planner (SSD-transient
        // handling, own-history rebind, cross-attach guard, reservations) in
        // tests instead of recomposing it.
        planResume,
      },
    } : {}),

    listScratchTabs,
    saveScratchTabs,
    listEditorOpenFiles,
    saveEditorOpenFiles,

    getDb: () => db,
    resolveOperatorProfileHome,
    resolveConversationCwd,
    getConversationAutoApprove,
    resolveAgentBinary,

    ensureWorkItemSession,
    ensureVariantSession,
    ensureStreamStarted,
    restoreAgentStreams,
    killShellStream,

    createWorktree,
    deleteWorktree,
    attachVariant,
    removeVariant,
    reorderWorkspaces,
    reorderTasksInWorkspace,
    reorderVariants,
    reorderConversations,
    broadcastToVariants,

    writeTerminalInput,
    resizeTerminal,
    getStreamSnapshot,
    getTerminalSync,

    getGitStatus,
    getTaskGitLog,
    getCommitDetail,
    getCommitFileDiff,
    getFileDiff,
    listTaskFiles,
    readTaskFile,
    searchFiles,
    searchFileContent,
    writeTaskFile,
    createTaskFile,
    createTaskFolder,
    renameTaskPath,
    deleteTaskPath,
    restoreFromTrash,
    revealTaskPath,
    stageFiles,
    unstageFiles,
    stageAll,
    unstageAll,
    commitChanges,
    revertCommit,
    resetToCommit,
    pushChanges,
    createPR,

    integrationPush,
    integrationContextImport,
    integrationOpenPr,
    integrationReadyPr,
    integrationRequestReview,
    integrationPollChecks,
    integrationGate,
    integrationMergePr,
    integrationCleanup,
    integrationPostMergeCleanup,

    resolveTaskCwd,
    getProjectById: (id) => stmts.getProjectById.get(id),
    getTaskIntegrationContext,

    projectsSetBaseBranch: (p) => setWorkspaceBaseBranch(p),
    projectsGetEffectiveBaseBranch: (p) => getEffectiveBaseBranch(p),

    pasteClipboardImageRemote,

    getAgentCatalog,
    getSystemTools,
    startInstallAgent,
    getStarredAgents,
    setAgentStarred,

    getRemoteSettings,
    setRemoteEnabled,
    setRemoteTunnelMode,
    setRemoteCloudflareConfig,
    findRemoteDeviceByHash,
    touchRemoteDevice,
    registerRemoteDevice,
    listRemoteDevices,
    revokeRemoteDevice,

    getSkillsCatalog: () => skillsCore.getCatalogIndex(),
    refreshSkillsCatalog: () => skillsCore.refreshCatalog(),
    getSkillDetail: (p) => skillsCore.getSkillDetail(p.skillId, p.source),
    searchSkillsSh: (p) => skillsCore.searchSkillsSh(p.query),
    installSkill: (p) => skillsCore.installSkill(p),
    uninstallSkill: (p) => skillsCore.uninstallSkill(p),
    createSkill: (p) => skillsCore.createSkill(p),
    getDetectedSkillAgents: () => skillsCore.getDetectedAgents(),

    loadMcp: () => mcpCore.loadAll(),
    saveMcpServer: (p) => mcpCore.saveServer(p),
    removeMcpServer: (p) => mcpCore.removeServer(p),
    getMcpProviders: () => mcpCore.getProviders(),

    // Hermes Desktop surface (electron/hermes-dashboard.cts). Dormant: with
    // no running dashboard these are pure reads/no-ops; the ensure() result
    // URL is secret-equivalent (the served page embeds the session token) and
    // goes only to the requesting caller — never into status() or events.
    hermesDesktopStatus: () => hermesDashboards.status(),
    hermesDesktopSetSurface: (p: any) => hermesDashboards.setSurface(p?.surface),
    hermesDesktopEnsure: (p: any) => hermesDashboards.ensure({ ownerKey: p?.ownerKey }),
    hermesDesktopStop: (p: any) =>
      p?.ownerKey ? hermesDashboards.stop({ ownerKey: p.ownerKey }) : hermesDashboards.stopAll(),
	    hermesDesktopProxyTarget: () => hermesDashboards.proxyTarget(),
    hermesDesktopAppConnection: (p: any = {}) => hermesDashboards.appConnection(p?.profile),
    hermesDesktopTouchAppProfile: (p: any = {}) => hermesDashboards.touchAppProfile(p?.profile),
    hermesDesktopGetActiveProfile: () => hermesDashboards.readActiveDesktopProfile(),
    hermesDesktopSetActiveProfile: (p: any = {}) => hermesDashboards.setAppProfile(p?.profile),
    // Canonical home-chat restore + cron home delivery (hermes-home-chat.cts).
    // Both resolve the active profile through appConnection, so callers pass
    // nothing; results carry no token or URL — the seed script holds only the
    // picked session id.
    hermesDesktopHomeSessionRestore: (p: any = {}) =>
      hermesHomeChat.restoreHomeSession({ profile: p?.profile ?? null }),
    hermesDesktopCronHomeDeliverySync: (p: any = {}) =>
      hermesHomeChat.syncCronHomeDelivery({ profile: p?.profile ?? null }),

    // One-button "Update Hermes": runs the fork's own `hermes update` CLI
    // against the ~/.hermes/hermes-agent checkout — it pulls the fork branch
    // (auto-stashing/restoring local edits), reinstalls deps, and rebuilds the
    // web UI + desktop app, then the fingerprint watchdog restarts the sidecar
    // on the new code. See electron/hermes-update.cts. Long-running (the
    // rebuild takes minutes).
    hermesUpdateApply: (p: any = {}) => {
      const hermesHomeDir = hermesPaths.globalHermesHome();
      const agentDir = hermesPaths.hermesAgentDir(hermesHomeDir);
      // The packaged app launches from Finder/launchd with a minimal PATH; the
      // hermes CLI's rebuild step shells out to node/npm/git, so prepend the
      // same bin dirs we add for every hermes spawn. GIT_TERMINAL_PROMPT=0 so a
      // credential-less fetch fails fast instead of hanging on a prompt.
      const augmentedPath = [
        ...hermesPaths.hermesCliSearchDirs({ home: hermesHomeDir }),
        process.env.PATH || '',
      ].filter(Boolean).join(path.delimiter);
      const childEnv = {
        ...process.env,
        PATH: augmentedPath,
        HERMES_HOME: hermesHomeDir,
        GIT_TERMINAL_PROMPT: '0',
      };
      const { spawn } = require('child_process');
      const exec = (cmd: string, args: string[], opts: any = {}) =>
        new Promise((resolve) => {
          let stdout = '';
          let stderr = '';
          let child: any;
          try {
            child = spawn(cmd, args, { cwd: opts.cwd || agentDir, env: childEnv });
          } catch (err: any) {
            resolve({ code: 1, stdout: '', stderr: String(err?.message || err) });
            return;
          }
          child.stdout?.on?.('data', (d: any) => { stdout += String(d); });
          child.stderr?.on?.('data', (d: any) => { stderr += String(d); });
          child.on?.('error', (err: any) => resolve({ code: 1, stdout, stderr: stderr + String(err?.message || err) }));
          child.on?.('close', (code: any) => resolve({ code: code ?? 1, stdout, stderr }));
        });
      const hermesBin = resolveHermesBinaryPath() || 'hermes';
      return hermesUpdate.runNativeHermesUpdate({
        exec,
        cwd: agentDir,
        hermesBin,
        onLog: (line: any) => {
          try { console.log('[ace] hermes-update:', line); } catch {}
        },
      });
    },
    // Narrow restart for the Operations "Agent Control" panel: routes through
    // the manager's existing stop()+ensure() (never a raw kill) and returns
    // only the sanitized { ok, ownerKey, status, pid } shape — never the
    // embed URL or token.
    hermesDesktopRestart: (p: any = {}) => hermesDashboards.restart({ ownerKey: p?.ownerKey }),

    // Telemetry spine read surface (electron/telemetry.cts) — read-only
    // query/aggregate over the append-only operational event log. Events are
    // redacted at write time, so nothing here can leak a secret; the payload
    // never carries db or ndjson paths.
    telemetryQuery: (p: any = {}) => telemetryLib.telemetryQuery(p),

    // Ops Pulse (electron/ops-pulse.cts) — per-project signals + ranked
    // rule-based next-step suggestions for the Operations "Pulse" panel.
    // Read-only/derived: workspace state + Mission Board + telemetry
    // aggregates + system findings + fresh git/gh probes.
    opsPulse: () =>
      opsPulseLib.collectOpsPulse({
        listWorkspaces: () => projectWorkspaceSummaries(db, workspaceMetaCache) || [],
        getMissionBoard: () => getMissionBoard({}),
        telemetryQuery: (q: any) => telemetryLib.telemetryQuery(q),
        getFindings: async () => {
          const status = await runOpsStatus({
            userDataPath,
            socketPath: aceSocketPath(userDataPath),
          });
          return Array.isArray(status?.findings) ? status.findings : [];
        },
      }),

    shutdown,
  };
  return publicApi;
}

module.exports = {
  appendProjectLifecycleEvent,
  branchExistsOnProject,
  buildEffectiveBaseBranchResult,
  createBaseBranchPolicyApi,
  createAceStore,
  terminateDetachedHost,
  terminatePreservedDetachedHost,
  makeHostIdentityGuard,
  discoverSurvivorHostPid,
  createPtyRegistry,
  createDelegatedTaskWithDeps,
  deriveStreamLabelForTask,
  deriveTaskSlug,
  deriveTaskTitle,
  addWorktree,
  slugify,
  resolveEffectiveBaseBranchRow,
  resolveTaskTypeTag,
  TASK_TYPE_TAG_MAP,
  computeFreeBranchName,
  ensureWorktreeDoctrineFiles,
  warnIfDoctrineFilesMissing,
  ensureAceOwnedWorkspaceDoctrine,
  isAceOwnedNonRepoProject,
  parseOriginHeadRef,
  normalizeControlPlaneIdentity,
  resolvePersonalIdentity,
  createGitWatcher,
  shouldAttachStartupGitWatchers,
  shouldUseFullTreeGitWatcher,
  hermesTerminalBottomPinEnv,
  hermesTerminalBottomPinEnvEntries,
  agentTerminalForcedEnvEntries,
  sanitizeAgentSpawnEnv,
  ensureAceCodexHome,
  codexDefaultWorkerEnv,
  laneIsInteractiveLane,
  respawnLaunchIntentFor,
  laneWorkerClassificationIntent,
  buildRemoteAgentCommand,
  shouldUseClaudeMcp,
  shouldUseGlobalCodexMcp,
  shouldSuppressPersonalHermesAutoPrompt,
  shouldInjectPersonalHermesWakeBrief,
  hasExistingHermesWakeBrief,
  createAlwaysOnOrchestratorWatchdog,
  computeHermesCodeFingerprint,
  runHermesStaleCodeCheck,
  shouldAutoStartAlwaysOnOrchestrator,
  applyWorkspaceOrderSchema,
  reorderWorkspacesInDb,
  reorderTasksInWorkspaceInDb,
  refreshProjectDefaultBranchRow,
  DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD,
  ALWAYS_ON_ORCHESTRATOR_WATCHDOG_INTERVAL_MS,
  archiveTaskRow,
  resolveClaudeProcessSessionId,
  warnIfDelegationMissingInitialPrompt,
  resolveClonePath,
};
