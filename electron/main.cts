const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createRuntimeBoot } = require('./runtime-boot.cjs');
const { createRemoteServer, detectTunnels } = require('./remote-server.cjs');
const { getProviderUsage } = require('./usage-core.cjs');
const { writePasteImage, sweepOldPastes } = require('./paste-store.cjs');
const { createAceController } = require('./ace-control/index.cjs');
const { createSocketBridge, socketPath: aceSocketPath } = require('./ace-control/socket-bridge.cjs');
const { createCompactionController } = require('./orchestrator-compaction.cjs');
const { createBrowserController } = require('./browser-control.cjs');
const cliInstaller = require('./cli-installer.cjs');
const { createGithubCore } = require('./github-core.cjs');
const {
  scheduleOpsStatusSnapshot: scheduleOpsStatusSnapshotDaily,
} = require('./mission-archive-scheduler.cjs');
const {
  scheduleOpsBriefs: scheduleOpsBriefsDaily,
  nextBriefRun: nextDailySlotRun,
  OPS_BRIEF_INTERVAL_MS: DAILY_INTERVAL_MS,
} = require('./ops-brief-scheduler.cjs');
const { scheduleKnowledgeNightly: scheduleKnowledgeNightlyDaily } = require('./knowledge-nightly-scheduler.cjs');
const { scheduleOpsSourceCatchUp } = require('./ops-refresh.cjs');
const {
  buildExternalStorageEnv,
  resolveExternalDataRootForApp,
  writeActivationFiles,
} = require('./external-data-root.cjs');
const { scrubInheritedAgentEnv } = require('./env-scrub.cjs');
const {
  isTrustedHermesDesktopWebview,
  isTrustedHermesDesktopResource,
  sendHermesDesktopOpenLink,
  isLoopbackHttpUrl,
  resolveIsMainFrame,
  shouldDivertHermesGuestNavigation,
  HERMES_DESKTOP_APP_PARTITION,
} = require('./hermes-dashboard.cts');
const { registerHermesDesktopBridge } = require('./hermes-desktop-bridge.cts');
const perfHealth = require('./perf-health.cts');

// A Ace launched from inside another Ace's agent shell inherits the
// parent's ACE_SOCK/URL/TOKEN + stream/workspace context — which would
// wire this instance's control plane to the parent. Scrub BEFORE any env-
// dependent boot logic (external-root resolution, socket pinning) runs.
// User-facing overrides (ACE_DATA_ROOT, ACE_UPDATE_*) are preserved;
// see electron/env-scrub.cts.
const scrubbedInheritedEnv = scrubInheritedAgentEnv();
if (scrubbedInheritedEnv.length) {
  console.warn(`[ace] scrubbed inherited agent env from a parent Ace instance: ${scrubbedInheritedEnv.join(', ')}`);
}

// macOS automatic termination ("Termination by the system" / TAL, driven by
// loginwindow) can quit Ace within ~10s of launch: while the renderer is
// still painting its first frame, AppKit reports "no windows open yet", marks
// the app auto-terminable and loginwindow sends a Quit AppleEvent — so the app
// vanishes before its window is usable. Ace is an always-on agent dashboard
// and must not be killed this way. ACE_BOOT_AT anchors a boot window during
// which the before-quit handler (below) blocks system-initiated termination;
// real user quits after boot and the relaunch script's pkill fallback are
// unaffected. Pair with NSSupportsAutomaticTermination=false in the Info.plist.
const ACE_BOOT_AT = Date.now();
const ACE_BOOT_TERMINATION_GUARD_MS = 120000;

const isDev = !app.isPackaged;
function isWebUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function devSuffix() {
  const base = path.basename(process.cwd() || '');
  if (!base || base === 'ace') return 'Dev';
  return base;
}
// ACE_BRANCH_PROOF=1: a packaged-from-branch boot probe (scripts/
// package-branch.sh). Strictly additive — isolated app name + userData + its
// own socket, and the external data root is NOT activated, so the probe can
// never touch the live app's data. Unset ⇒ behavior unchanged.
const BRANCH_PROOF = process.env.ACE_BRANCH_PROOF === '1';
const APP_NAME = BRANCH_PROOF ? 'ACE CODER-BranchProof' : isDev ? `ACE CODER-${devSuffix()}` : 'ACE CODER';
app.setName(APP_NAME);
// Public builds always use a distinct profile, including packaged installs.
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

// The LOCAL (pre-redirect) userData path. The external-data-root config file
// lives here even when the app runs from an external root, so activation
// writes from the storage settings must keep targeting this path.
const localUserDataPath = app.getPath('userData');
// Only the public profile's explicit Storage setting can activate an external root.
// Never discover or inherit a private installation's data root or control files.
for (const key of ['ACE_DATA_ROOT', 'ACE_EXTERNAL_DATA_ROOT', 'ACE_USE_EXTERNAL_DATA_ROOT',
  'ACE_DATA_ROOT_CANDIDATES', 'ACE_HOME', 'ACE_CHILD_REGISTRY_PATH', 'ACE_FOLLOW_UP_STORE_PATH',
  'ACE_WIKI_ROOT', 'ACE_WIKI_PATH', 'ACE_WIKI_LOG_PATH', 'ACE_WIKI_DAILY_PATH',
  'ACE_WIKI_JOURNAL_DIR', 'ACE_KNOWLEDGE_DB', 'ACE_CODEX_HOME', 'ACE_SHARED_USER_DATA_PATH']) {
  delete process.env[key];
}
process.env.ACE_HOME = path.join(localUserDataPath, '.ace');
const resolveAppExternalDataRoot = () => {
  const configured = fs.existsSync(path.join(localUserDataPath, 'external-data-root.json'));
  return resolveExternalDataRootForApp({
    currentUserDataPath: localUserDataPath,
    env: { ...process.env, ACE_DISABLE_EXTERNAL_DATA_ROOT: configured ? '0' : '1' },
    isDev: true,
    branchProof: BRANCH_PROOF,
  });
};
let externalDataRoot = resolveAppExternalDataRoot();

// Applies an ACTIVE resolution: redirects userData/temp/ACE_HOME onto the
// external root. Shared by the normal boot path and the boot guard's Retry.
function applyExternalDataRootActivation(resolved: any) {
  app.setPath('userData', resolved.userDataPath);
  console.log(`[ace] external data root active: ${resolved.userDataPath}`);
  const externalStorageEnv = buildExternalStorageEnv(resolved.root);
  Object.assign(process.env, externalStorageEnv);
  // Route Ace-owned temp (paste images, sweeps) onto the SSD so transient
  // image data does not land on the system volume. Guarded by `active`, so
  // behavior is unchanged when the external root is inactive.
  try {
    const externalTempDir = externalStorageEnv.TMPDIR || path.join(resolved.root, 'tmp');
    fs.mkdirSync(externalTempDir, { recursive: true });
    app.setPath('temp', externalTempDir);
  } catch (err: any) {
    console.warn(`[ace] could not set external temp dir: ${err && err.message ? err.message : err}`);
  }
  // Route the child-registry (ACE_HOME/.ace) onto the SSD before any
  // CLI/agents spawn. Guarded by `active` -> unchanged when inactive.
  process.env.ACE_HOME = externalStorageEnv.ACE_HOME || path.join(resolved.root, '.ace');
}

// Mid-session "external root went away" state. Set FAIL-CLOSED when the active
// external mount disappears so downstream writers can pause; cleared when it
// comes back. Only meaningful while the watchdog is armed (SSD active).
let externalDataRootPaused = false;

// Lightweight mid-session watchdog. Every ~30s re-resolve the external root and
// confirm it is still ACTIVE (resolveExternalDataRoot runs writableDirOrCreatable
// internally, so `active` already reflects a live, writable mount) and still the
// SAME root we booted on. On loss -> FAIL CLOSED: pause external writes + signal
// the renderer. On return -> clear + signal recovery. Never crashes. Only armed
// when the SSD root is active at boot.
let externalRootWatchdogTimer: any = null;
function startExternalRootWatchdog() {
  if (externalRootWatchdogTimer) return;
  const bootRoot = externalDataRoot.root;
  if (!bootRoot) return;
  externalRootWatchdogTimer = setInterval(() => {
    let live = false;
    try {
      const probe = resolveAppExternalDataRoot();
      live = !!(probe.active && probe.root === bootRoot);
    } catch {
      live = false;
    }
    if (!live && !externalDataRootPaused) {
      externalDataRootPaused = true;
      try { console.warn('[ace] external data root lost mid-session; pausing external writes (fail-closed)'); } catch {}
      broadcast('ace:data-root-lost', { root: bootRoot, paused: true });
    } else if (live && externalDataRootPaused) {
      externalDataRootPaused = false;
      try { console.log('[ace] external data root recovered; resuming'); } catch {}
      broadcast('ace:data-root-lost', { root: bootRoot, paused: false, recovered: true });
    }
  }, 30000);
  // Don't keep the event loop (or quit) alive just for the watchdog.
  if (externalRootWatchdogTimer && typeof externalRootWatchdogTimer.unref === 'function') {
    externalRootWatchdogTimer.unref();
  }
}

if (BRANCH_PROOF) {
  console.log('[ace] branch-proof boot: external data root skipped (isolated probe)');
} else if (externalDataRoot.active && externalDataRoot.userDataPath) {
  applyExternalDataRootActivation(externalDataRoot);
} else if (
  process.env.ACE_USE_EXTERNAL_DATA_ROOT === '1' ||
  process.env.ACE_DATA_ROOT ||
  process.env.ACE_EXTERNAL_DATA_ROOT
) {
  console.warn(`[ace] external data root unavailable; using local userData (${externalDataRoot.reason})`);
}

// Pin the control-socket coordinates on THIS process's own env, now that the
// userData path is final (post dev-suffix + external-root redirect). The PTY
// stream path (local-core) already injects ACE_SOCK / ACE_USER_DATA_TAG
// per stream, so interactive agent tabs connect. But headless agents spawned
// via agent-cli-driver resolve the socket from process.env
// (resolveAceSockForSpawn): without these, neither var is set, it returns
// null, no ACE_SOCK is injected, and the spawned CLI re-derives a socket
// path from its own TMPDIR — the exact `SOCKET_UNREACHABLE` ("personal agents
// not connected") that #317 set out to kill. Set both to the same values the
// PTY path uses so every spawn route — PTY and headless — reaches one socket.
// A function because the boot guard's Retry can re-point userData after this
// first pin.
let pinnedChildRegistryPath: string | null = null;
let pinnedFollowUpStorePath: string | null = null;

function pinControlSocketEnv() {
  const finalUserDataPath = app.getPath('userData');
  process.env.ACE_USER_DATA_TAG = path.basename(finalUserDataPath);
  process.env.ACE_SOCK = aceSocketPath(finalUserDataPath);
  // Pin the userData PATH for env-defaulted readers (the pty-host's staging
  // root and log, among others). Unconditional like TAG/SOCK above: this
  // instance's identity must never be inherited from a parent instance.
  process.env.ACE_USER_DATA_PATH = finalUserDataPath;
  // Pin the child-registry to THIS instance's userData so the controller,
  // every spawned agent, and their ace CLIs read/write one registry.
  // The home-scoped default (~/.ace/child-registry.json) made two
  // instances contend and let app vs CLI diverge, which silently broke the
  // auto-validator's wave join. An explicit pre-set env still wins; our own
  // earlier pin re-points when the boot guard's Retry moves userData.
  const current = process.env.ACE_CHILD_REGISTRY_PATH;
  if (!current || current === pinnedChildRegistryPath) {
    pinnedChildRegistryPath = path.join(finalUserDataPath, 'child-registry.json');
    process.env.ACE_CHILD_REGISTRY_PATH = pinnedChildRegistryPath;
  }
  // Pin the follow-up store next to the child-registry (same reasoning: one
  // instance, one store; the home default ~/.ace/follow-ups.json let two
  // instances contend and let CLI-side supervise runs diverge from the app's
  // board Follow-ups row). Same re-pin logic; an explicit pre-set env wins.
  const currentFollowUps = process.env.ACE_FOLLOW_UP_STORE_PATH;
  if (!currentFollowUps || currentFollowUps === pinnedFollowUpStorePath) {
    pinnedFollowUpStorePath = path.join(finalUserDataPath, 'follow-ups.json');
    process.env.ACE_FOLLOW_UP_STORE_PATH = pinnedFollowUpStorePath;
  }
}
pinControlSocketEnv();
const { createAceStore } = require('./local-core.cjs');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.icns');
let aceStore: any = null;
let githubCore: any = null;
let remoteServer: any = null;
let runtimeBooted = false;
let runtimeState: any = { status: 'starting' };
let bootRuntime: (() => Promise<any>) | null = null;
let startingRuntime: Promise<any> | null = null;
const runtimeIpcChannels = new Set<string>();
let aceController: any = null;
let aceSocketBridge: any = null;
let powerSaveBlockerId: any = null;
const subscriptions: any[] = [];

function scheduleOpsStatusSnapshot() {
  scheduleOpsStatusSnapshotDaily({
    getStore: () => aceStore,
    subscriptions,
    logger: console,
  });
}

// Knowledge plane: 03:30 nightly reindex + audit + decay + per-project wiki
// curation + rotation. Deterministic only; opt-out via
// ACE_KNOWLEDGE_NIGHTLY_DISABLE=1. Clear of the 04:00 archive and 06:00
// snapshot timers.
function scheduleKnowledgeNightlyLoop() {
  scheduleKnowledgeNightlyDaily({
    getStore: () => aceStore,
    subscriptions,
    logger: console,
    stateDir: app.getPath('userData'),
  });
}

// ops-v2 W5/G2: in-process daily Rook briefs at 7:30/13:00/20:30 by default
// (override via ops-config.json briefs.schedule). stateDir lets the scheduler
// record delivery failures for the Briefs tab status strip. No OS cron, no
// relaunch — re-arms on launch like the other ops timers.
function scheduleOpsBriefs() {
  let schedule: any = null;
  try {
    schedule = aceStore.opsBriefScheduleOverride();
  } catch {
    schedule = null;
  }
  scheduleOpsBriefsDaily({
    getStore: () => aceStore,
    subscriptions,
    logger: console,
    schedule,
    stateDir: app.getPath('userData'),
  });
  // S3: boot catch-up — one source refresh ~30s after launch when the newest
  // run predates the most recent past slot (slots missed while the app was
  // closed are otherwise skipped forever). Same schedule override; null falls
  // back to the 07:30/13:00/20:30 trio inside the engine.
  scheduleOpsSourceCatchUp({
    getStore: () => aceStore,
    subscriptions,
    schedule,
    stateDir: app.getPath('userData'),
    logger: console,
  });
}

// D8/D9: twice-daily todo digests (07:00 morning / 21:00 night), copying the
// ops-brief timer pattern — setTimeout to the next slot, then a 24h
// setInterval, cleanup fns pushed to `subscriptions`, delivery failures
// swallowed so the runtime always survives. Rule-based proposals by default;
// deliverTodoDigest spawns nothing unless the owner opts into the headless
// agent leg (~/.ace/ops-config.json todoDigest.agent.enabled).
const TODO_DIGEST_SCHEDULE: Array<{ hour: number; slot: 'morning' | 'night' }> = [
  { hour: 7, slot: 'morning' },
  { hour: 21, slot: 'night' },
];

function scheduleTodoDigests() {
  for (const entry of TODO_DIGEST_SCHEDULE) {
    const { hour, slot } = entry;

    const runDigest = () => {
      setTimeout(() => {
        Promise.resolve()
          .then(() => aceStore.deliverTodoDigest({ slot, now: Date.now() }))
          .catch((err: any) => {
            console.error('[ace] todo digest delivery failed:', err);
          });
      }, 0);
    };

    const current = new Date();
    const next = nextDailySlotRun(hour, 0, current);
    const firstTimer = setTimeout(() => {
      runDigest();
      const dailyTimer = setInterval(runDigest, DAILY_INTERVAL_MS);
      subscriptions.push(() => clearInterval(dailyTimer));
    }, next.getTime() - current.getTime());
    subscriptions.push(() => clearTimeout(firstTimer));
  }
}

function broadcast(channel: any, payload: any) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function focusAceWindow() {
  if (!app.isReady()) return;
  let win = BrowserWindow.getAllWindows().find((candidate: any) => !candidate.isDestroyed());
  if (!win) {
    win = createWindow({ deferLoad: true });
    loadWindow(win);
  }
  try { if (win.isMinimized()) win.restore(); } catch {}
  try { win.show(); } catch {}
  try { win.focus(); } catch {}
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => focusAceWindow());

// Shows a minimal edit menu (cut/copy/paste/select all) on right-click in any
// text field or over a non-empty selection. Electron ships no default menu —
// without this, right-clicking a textarea or highlighted text does nothing.
function attachEditContextMenu(wc: any) {
  wc.on('context-menu', (_event: any, params: any) => {
    const { isEditable, selectionText, editFlags } = params;
    const hasSelection = typeof selectionText === 'string' && selectionText.trim().length > 0;
    if (!isEditable && !hasSelection) return;
    const template: any[] = [];
    if (isEditable || hasSelection) {
      template.push({ role: 'cut', enabled: isEditable && !!editFlags?.canCut });
      template.push({ role: 'copy', enabled: !!editFlags?.canCopy });
      template.push({ role: 'paste', enabled: isEditable && !!editFlags?.canPaste });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll', enabled: !!editFlags?.canSelectAll });
    }
    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) menu.popup({ window: win });
  });
}

// BOOT GUARD (#1 priority — owner-agent persistence). When an external data
// root is explicitly configured but unavailable at boot (volume unmounted,
// parent missing, unwritable), the stale LOCAL userData may still hold old
// copies of the owner's personal agents. Booting straight into that fallback
// would point agents at the wrong homes/memory and rewrite local state. Block
// BEFORE any store/db init: Retry re-resolves after the owner reconnects the
// volume, Quit exits cleanly, and "Continue with local data" proceeds with
// ACE_DATA_ROOT_FALLBACK=1 so local-core's always-on orchestrator
// auto-start no-ops for this session.
function runDataRootBootGuard(): 'proceed' | 'quit' {
  while (!externalDataRoot.active && externalDataRoot.reason === 'config-root-unavailable') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Ace data root unavailable',
      message: 'Your configured data location is unavailable',
      detail:
        `Ace is configured to keep its data at:\n${externalDataRoot.configuredRoot || '(unknown)'}\n\n` +
        'That location is not reachable right now. Connect or mount it, then choose Retry. ' +
        '"Continue with local data" starts Ace on the local fallback WITHOUT your configured ' +
        'agents and data; always-on agents will not auto-start this session to protect their state.',
      buttons: ['Retry', 'Quit', 'Continue with local data'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 1) {
      app.exit(0);
      return 'quit';
    }
    if (choice === 2) {
      process.env.ACE_DATA_ROOT_FALLBACK = '1';
      console.warn(
        '[ace] configured data root unavailable; continuing on LOCAL userData with ' +
          'ACE_DATA_ROOT_FALLBACK=1 (always-on orchestrators stay down this session)'
      );
      return 'proceed';
    }
    // Retry: re-resolve, and on success apply the exact same activation path
    // the normal boot uses (userData redirect + storage env + socket pin).
    externalDataRoot = resolveAppExternalDataRoot();
    if (externalDataRoot.active && externalDataRoot.userDataPath) {
      applyExternalDataRootActivation(externalDataRoot);
      repairHermesSymlinkForRoot(externalDataRoot.root);
      pinControlSocketEnv();
    }
  }
  return 'proceed';
}

function buildAppMenu() {
  const template: any[] = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  template.push({ role: 'viewMenu' });
  template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerHandlers() {
  const s = aceStore;
  const handle = (channel: string, listener: any) => {
    ipcMain.handle(channel, listener);
    runtimeIpcChannels.add(channel);
  };

  handle('ace:get-state', () => s.getState());
  handle('ace:seed-state', () => s.seedState());
  handle('ace:perf-health', () => s.perfHealth());
  handle('ace:perf-record', (_e: any, p: any) => s.perfRecord(p || {}));
  handle('hermes:deep-link-ready', () => ({ ok: true }));
  // Operations Cockpit live probe. Renderer reaches the SAME `opsStatus` store
  // method the `ace ops status` CLI calls via the socket bridge — one probe
  // implementation, no duplication (docs/ops/operations-cockpit-contracts.md §7).
  handle('ace:ops-status', (_e: any, p: any) => s.opsStatus(p || {}));
  // Derived-on-read signals inbox (Option A): union of distilled vector-ops
  // signal files under wiki/raw/* with current ops-status findings >= yellow.
  // No table, no migration — read-only synthesis (contracts §7).
  handle('ace:ops-signals', (_e: any, p: any) => s.streamOperationsSignals(p || {}));
  // Recommendations are a read-only derived list for now ([] until the
  // daily-agent synthesis lands); the renderer expects the method to exist.
  handle('ace:ops-recommendations', (_e: any, p: any) =>
    s.streamOperationsRecommendations(p || {})
  );
  // ops-v2 W1: lens-differentiated Rook brief distilled from latest.json.
  handle('ace:ops-brief', (_e: any, p: any) => s.streamOperationsBrief(p || {}));
  // ops-v2 G3/G5: slot schedule + last/next run status; manual generate-now.
  handle('ace:ops-brief-schedule', () => s.opsBriefSchedule());
  handle('ace:ops-brief-generate', (_e: any, p: any) => s.opsBriefGenerate(p || {}));
  // ops-v2: full Vector Ops dashboard intel.
  handle('ace:ops-intel', () => s.streamOperationsIntel());
  // ops-v2 W6: Chief's todo intake.
  handle('ace:ops-todos-list', () => s.opsTodosList());
  handle('ace:ops-todo-create', (_e: any, p: any) => s.opsTodoCreate(p || {}));
  handle('ace:ops-todo-update', (_e: any, p: any) => s.opsTodoUpdate(p || {}));
  handle('ace:ops-todo-remove', (_e: any, p: any) => s.opsTodoRemove(p || {}));
  // D8/D9: latest todo digest (rule-based proposals) + manual synthesize-now.
  handle('ace:ops-todo-digest', () => s.opsTodoDigest());
  handle('ace:ops-todo-synthesize', (_e: any, p: any) => s.opsTodoSynthesize(p || {}));
  // ops-v2 W7/W8: sources watchlist + wiki graph.
  handle('ace:ops-sources-get', () => s.opsSourcesGet());
  handle('ace:ops-sources-update', (_e: any, p: any) => s.opsSourcesUpdate(p || {}));
  // S3: manual source refresh (all registry sources; never rejects).
  handle('ace:ops-refresh', (_e: any, p: any) => s.opsRefreshSources(p || {}));
  // S3: persisted per-source lastAttempt/lastSuccess state snapshot.
  handle('ace:ops-source-state', () => s.opsSourceState());
  handle('ace:ops-wiki-graph', () => s.opsWikiGraph());
  // LLM-wiki health metrics for the Wiki tab health panel.
  handle('ace:ops-wiki-health', () => s.opsWikiHealth());
  // Read-only Cloudflare inventory (Monitor tab). Config-gated on a local
  // token; on-demand only, in-main cache ≥5min per resource, 15min circuit
  // breaker after 3 failed cycles. No scheduler — the renderer drives it.
  // ops-v2 I2: traversal-safe page read for the wiki viewer + node hovers.
  handle('ace:ops-wiki-page', (_e: any, p: any) => s.opsWikiPage(p || {}));
  // ops-v2 I9: reveal a wiki page in Finder. The store's page reader validates
  // root containment first — only an ok result ever reaches the shell.
  handle('ace:ops-wiki-reveal', (_e: any, p: any) => {
    const page = s.opsWikiPage(p || {});
    if (!page || page.ok !== true) return { ok: false, error: page?.error ?? 'not-found' };
    const { root } = s.opsWikiRootPath();
    shell.showItemInFolder(path.join(root, page.relPath));
    return { ok: true };
  });
  // Knowledge plane: unified FTS5 search + read-only entry fetch. The store
  // validates payloads and path containment; reindex is idempotent.
  handle('ace:knowledge-search', (_e: any, p: any) => s.knowledgeSearch(p || {}));
  handle('ace:knowledge-get', (_e: any, p: any) => s.knowledgeGet(p || {}));
  handle('ace:knowledge-reindex', () => s.knowledgeReindex());
  handle('ace:knowledge-status', () => s.knowledgeStatus());
  handle('ace:knowledge-overview', () => s.knowledgeOverview());
  handle('ace:knowledge-nightly-status', () => s.knowledgeNightlyStatus());
  handle('ace:knowledge-quarantine-list', () => s.knowledgeQuarantineList());
  // Resolve = rename only (approve restores, reject moves to rejected/) —
  // the handler contains no unlink calls; nothing is ever deleted.
  handle('ace:knowledge-quarantine-resolve', (_e: any, p: any) => s.knowledgeQuarantineResolve(p || {}));
  // Lean, READ-ONLY run-ledger board (watcher, never a gate). Pure projection
  // over the ledger; auto-refreshes via the existing state-changed/stream pushes.
  // The mission-* IPC handles (create/board/archive/dispatch/sync/validate/gate/
  // link-pr/fixback/release-gate/move/assign) were deleted in the mission-domain
  // excision; only this read survives.
  handle('ace:run-board', (_e: any, p: any) => s.runBoard(p));
  // Spine intake: submit a run-ledger intent. The autonomy loop and real
  // Ring-1 effects are LIVE by default (ACE_RUN_LEDGER=0 is the master kill
  // switch); merge_to_main stays fail-closed behind the owner token.
  handle('ace:run-submit', (_e: any, p: any) => s.runSubmit(p));
  // Loops subsystem (additive limb over the SAME run-ledger spine; PRD §6). Each
  // handler delegates to the loops-service methods merged onto aceStore=s in
  // ace-control. Definition reads (list/get/lockon/save) work even when the
  // spine is disabled; run-touching handlers (run/status) fail-closed throw
  // 'run-ledger spine disabled' from the service when ACE_RUN_LEDGER=0.
  handle('ace:loops-list', () => s.loopsList());
  handle('ace:loops-get', (_e: any, p: any) => s.loopsGet(p || {}));
  handle('ace:loops-compile', (_e: any, p: any) => s.loopsCompile(p || {}));
  handle('ace:loops-lockon', (_e: any, p: any) => s.loopsLockOn(p || {}));
  handle('ace:loops-save', (_e: any, p: any) => s.loopsSave(p || {}));
  handle('ace:loops-run', (_e: any, p: any) => s.loopsRun(p || {}));
  handle('ace:loops-stop', (_e: any, p: any) => s.loopsStop(p || {}));
  handle('ace:loops-remove', (_e: any, p: any) => s.loopsRemove(p || {}));
  handle('ace:loops-status', (_e: any, p: any) => s.loopsStatus(p || {}));
  handle('ace:loops-select', (_e: any, p: any) => s.loopsSelect(p || {}));
  handle('ace:loops-kill-all', () => s.loopsKillAll());
  handle('ace:open-folder', async (_e: any, payload: any) => {
    const folderPath = payload?.path;
    if (!folderPath || typeof folderPath !== 'string') return { ok: false };
    // Security: this handler is reachable with untrusted, agent-emitted paths
    // (e.g. a chat markdown link). shell.openPath LAUNCHES app bundles and
    // EXECUTES scripts, so resolve symlinks to the REAL target (realpathSync
    // defeats a symlink whose own name hides a bundle/script target) and only
    // openPath a PLAIN directory — i.e. one with no extension. Every launchable
    // macOS bundle (.app/.workflow/.scptd/...) carries an extension, so the
    // no-extension rule is a safe allowlist rather than a fragile denylist.
    // Reveal everything else (files, bundles, executables) in Finder so a
    // malicious link can never run code on a single click.
    let real: string;
    let stat: any;
    try {
      real = fs.realpathSync(path.resolve(folderPath));
      stat = fs.statSync(real);
    } catch {
      return { ok: false };
    }
    if (stat.isDirectory() && path.extname(real) === '') {
      const err = await shell.openPath(real);
      return { ok: err === '' };
    }
    shell.showItemInFolder(real);
    return { ok: true };
  });
  handle('ace:pick-directory', async (_e: any, payload: any) => {
    const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const result = await dialog.showOpenDialog(target, {
      title: payload?.title || 'Select Workspace',
      message: payload?.message,
      buttonLabel: payload?.buttonLabel,
      defaultPath: payload?.defaultPath,
      properties: payload?.createDirectory
        ? ['openDirectory', 'createDirectory']
        : ['openDirectory'],
    });
    return { path: result.canceled ? null : result.filePaths[0] ?? null };
  });


  handle('ace:browse-local-dir', (_e: any, p: any) => s.browseLocalDir(p));
  handle('ace:import-workspace', (_e: any, p: any) => s.importWorkspace(p));
  handle('ace:import-remote-workspace', (_e: any, p: any) => s.importRemoteWorkspace(p));
  handle('ace:list-remote-hosts', () => s.listRemoteHosts());
  handle('ace:list-remote-dir', (_e: any, p: any) => s.listRemoteDir(p));
  handle('ace:create-remote-dir', (_e: any, p: any) => s.createRemoteDir(p));
  handle('ace:remove-workspace', (_e: any, p: any) => s.removeWorkspace(p));
  handle('ace:initialize-workspace', (_e: any, p: any) => s.initializeWorkspace(p));
  handle('ace:refresh-workspace', (_e: any, p: any) => s.refreshWorkspace(p));
  handle('ace:projects-refresh-default-branch', (_e: any, p: any) => s.refreshProjectDefaultBranch(p));
  handle('ace:projects-set-base-branch', (_e: any, p: any) => s.projectsSetBaseBranch(p));
  handle('ace:projects-get-effective-base-branch', (_e: any, p: any) => s.projectsGetEffectiveBaseBranch(p));
  handle('ace:workspace-stats', (_e: any, p: any) => s.getWorkspaceStats(p));
  handle('ace:workspace-stats-detail', (_e: any, p: any) => s.getWorkspaceStatsDetail(p));
  handle('ace:list-tracked-github-projects', () => s.listTrackedGithubProjects());
  handle('ace:delete-branch', (_e: any, p: any) => s.deleteBranch(p));
  handle('ace:clone-workspace', (_e: any, p: any) => s.cloneWorkspace(p));
  handle('ace:open-external', async (_e: any, p: any) => {
    const url = typeof p === 'string' ? p : p?.url;
    if (typeof url !== 'string' || !url) return { ok: false };
    // Security: only hand http(s)/mailto URLs to the OS opener. Blocks file:,
    // custom-scheme, and other potentially dangerous handlers reaching this
    // handler from untrusted (agent-emitted) input.
    if (!/^(?:https?|mailto):/i.test(url)) return { ok: false };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });


  handle('ace:create-task', (_e: any, p: any) => s.createTask(p));
  handle('ace:create-thread', (_e: any, p: any) => s.createThread(p));
  handle('ace:start-hermes-orchestrator', (_e: any, p: any) => s.startHermesOrchestrator(p));
  handle('ace:start-orchestrator', (_e: any, p: any) => s.startOrchestrator(p));
  handle('ace:set-always-on-orchestrator', (_e: any, p: any) => s.setAlwaysOnOrchestrator(p));
  handle('ace:list-agent-lanes', () => s.listAgentLanes());
  handle('ace:list-hermes-profiles', () => s.listHermesProfiles());
  handle('ace:list-orchestrator-templates', () => s.listOrchestratorTemplates());
  handle('ace:create-agent-lane', (_e: any, p: any) => s.createAgentLane(p));
  handle('ace:get-or-create-personal-workspace', () => s.getOrCreatePersonalWorkspace());
  handle('ace:get-or-create-personal-identity-workspace', (_e: any, p: any) => s.getOrCreatePersonalIdentityWorkspace(p));
  handle('ace:delete-task', (_e: any, p: any) => s.deleteTask(p));
  handle('ace:archive-task', (_e: any, p: any) => s.archiveTask(p));
  handle('ace:unarchive-task', (_e: any, p: any) => s.unarchiveTask(p));
  handle('ace:reorder-workspaces', (_e: any, p: any) => s.reorderWorkspaces(p));
  handle('ace:reorder-tasks-in-workspace', (_e: any, p: any) => s.reorderTasksInWorkspace(p));
  handle('ace:set-task-auto-approve', (_e: any, p: any) => s.setTaskAutoApprove(p));
  handle('ace:get-task-spec', (_e: any, p: any) => s.getTaskSpec(p));


  handle('ace:create-conversation', (_e: any, p: any) => s.createConversation(p));
  handle('ace:close-conversation', (_e: any, p: any) => s.closeConversation(p));
  handle('ace:activate-conversation', (_e: any, p: any) => s.activateConversation(p));

  handle('ace:list-scratch-tabs', (_e: any, p: any) => s.listScratchTabs(p));
  handle('ace:save-scratch-tabs', (_e: any, p: any) => s.saveScratchTabs(p));
  const browserChannels: any = {
    'ace:browser-register-webview': 'browserRegisterWebview',
    'ace:browser-unregister-webview': 'browserUnregisterWebview',
    'ace:browser-stop': 'browserStop',
    'ace:browser-list': 'browserList',
    'ace:browser-open': 'browserOpen',
    'ace:browser-activate': 'browserActivate',
    'ace:browser-navigate': 'browserNavigate',
    'ace:browser-info': 'browserInfo',
    'ace:browser-screenshot': 'browserScreenshot',
    'ace:browser-click': 'browserClick',
    'ace:browser-type': 'browserType',
    'ace:browser-key': 'browserKey',
    'ace:browser-scroll': 'browserScroll',
    'ace:browser-eval': 'browserEval',
    'ace:browser-cdp': 'browserCdp',
    'ace:browser-wait-for': 'browserWaitFor',
    'ace:browser-elements': 'browserElements',
    'ace:browser-console': 'browserConsole',
    'ace:browser-inspect-ref': 'browserInspectRef',
    'ace:browser-click-ref': 'browserClickRef',
    'ace:browser-type-ref': 'browserTypeRef',
    'ace:browser-skills-list': 'browserSkillsList',
    'ace:browser-skills-read': 'browserSkillsRead',
    'ace:browser-stream-open': 'browserStreamOpen',
    'ace:browser-stream-close': 'browserStreamClose',
    'ace:browser-stream-input': 'browserStreamInput',
    'ace:browser-stream-navigate': 'browserStreamNavigate',
    'ace:browser-stream-resize': 'browserStreamResize',
  };
  for (const [channel, method] of Object.entries(browserChannels)) {
    handle(channel, (_e: any, p: any) => s[method as any](p));
  }
  handle('ace:list-editor-open-files', (_e: any, p: any) => s.listEditorOpenFiles(p));
  handle('ace:save-editor-open-files', (_e: any, p: any) => s.saveEditorOpenFiles(p));


  handle('ace:ensure-work-item-session', (_e: any, p: any) => s.ensureWorkItemSession(p));
  handle('ace:ensure-variant-session', (_e: any, p: any) => s.ensureVariantSession(p));
  handle('ace:ensure-stream-started', (_e: any, p: any) => s.ensureStreamStarted(p));
  handle('ace:kill-shell-stream', (_e: any, p: any) => s.killShellStream(p));
  handle('ace:get-stream-snapshot', (_e: any, p: any) => s.getStreamSnapshot(p));
  handle('ace:get-terminal-sync', (_e: any, p: any) => s.getTerminalSync(p));


  handle('ace:create-worktree', (_e: any, p: any) => s.createWorktree(p));
  handle('ace:delete-worktree', (_e: any, p: any) => s.deleteWorktree(p));
  handle('ace:attach-variant', (_e: any, p: any) => s.attachVariant(p));
  handle('ace:remove-variant', (_e: any, p: any) => s.removeVariant(p));
  handle('ace:reorder-variants', (_e: any, p: any) => s.reorderVariants(p));
  handle('ace:reorder-conversations', (_e: any, p: any) => s.reorderConversations(p));
  handle('ace:broadcast-to-variants', (_e: any, p: any) => s.broadcastToVariants(p));


  handle('ace:write-terminal-input', (_e: any, p: any) => s.writeTerminalInput(p));
  handle('ace:resize-terminal', (_e: any, p: any) => s.resizeTerminal(p));






  handle('ace:paste-clipboard-image-remote', async (_e: any, p: any) =>
    s.pasteClipboardImageRemote(p)
  );
  handle('ace:paste-clipboard-image', async (_e: any, payload: any) => {
    try {
      return await writePasteImage({
        bytes: payload?.bytes,
        ext: payload?.ext,
        baseTempDir: app.getPath('temp'),
      });
    } catch (err: any) {
      console.error('[ace] paste write failed:', err);
      return { path: null, error: err?.message || 'paste write failed' };
    }
  });
  handle('ace:git-status', (_e: any, p: any) => s.getGitStatus(p));
  handle('ace:git-log', (_e: any, p: any) => s.getTaskGitLog(p));
  handle('ace:git-show', (_e: any, p: any) => s.getCommitDetail(p));
  handle('ace:git-show-file', (_e: any, p: any) => s.getCommitFileDiff(p));
  handle('ace:git-diff-file', (_e: any, p: any) => s.getFileDiff(p));
  handle('ace:git-stage', (_e: any, p: any) => s.stageFiles(p));
  handle('ace:git-unstage', (_e: any, p: any) => s.unstageFiles(p));
  handle('ace:git-stage-all', (_e: any, p: any) => s.stageAll(p));
  handle('ace:git-unstage-all', (_e: any, p: any) => s.unstageAll(p));
  handle('ace:git-commit', (_e: any, p: any) => s.commitChanges(p));
  handle('ace:git-revert', (_e: any, p: any) => s.revertCommit(p));
  handle('ace:git-reset', (_e: any, p: any) => s.resetToCommit(p));
  handle('ace:git-push', (_e: any, p: any) => s.pushChanges(p));
  handle('ace:git-create-pr', (_e: any, p: any) => s.createPR(p));


  handle('ace:list-task-files', (_e: any, p: any) => s.listTaskFiles(p));
  handle('ace:read-task-file', (_e: any, p: any) => s.readTaskFile(p));
  handle('ace:search-files', (_e: any, p: any) => s.searchFiles(p));
  handle('ace:search-file-content', (_e: any, p: any) => s.searchFileContent(p));
  handle('ace:write-task-file', (_e: any, p: any) => s.writeTaskFile(p));
  handle('ace:create-task-file', (_e: any, p: any) => s.createTaskFile(p));
  handle('ace:create-task-folder', (_e: any, p: any) => s.createTaskFolder(p));
  handle('ace:rename-task-path', (_e: any, p: any) => s.renameTaskPath(p));
  handle('ace:delete-task-path', (_e: any, p: any) => s.deleteTaskPath(p));
  handle('ace:restore-from-trash', (_e: any, p: any) => s.restoreFromTrash(p));
  handle('ace:reveal-task-path', async (_e: any, p: any) => {
    const { absolute } = await s.revealTaskPath(p);
    shell.showItemInFolder(absolute);
    return { ok: true };
  });


  handle('ace:get-agent-catalog', (_e: any, scope: any) => s.getAgentCatalog(scope));
  handle('ace:get-system-tools', () => s.getSystemTools());
  handle('ace:start-install-agent', (_e: any, p: any) => s.startInstallAgent(p));

  handle('ace:cli-get-status', () => cliInstaller.getCliStatus(app));
  handle('ace:cli-install', (_e: any, p: any) => cliInstaller.installCli(app, p || {}));
  handle('ace:cli-uninstall', () => cliInstaller.uninstallCli(app));

  // ── Operator profiles + data root (Settings → Agents / Storage) ─────────
  // READ-ONLY list: loadOperatorsConfig never writes, so this can never mask
  // a later-restored database — migrateOperatorsConfig stays the single
  // writer that may create operators.json on its own initiative.
  handle('ace:operators-list', () => {
    const operators = require('./operators.cts');
    return operators.loadOperatorsConfig(app.getPath('userData'));
  });
  handle('ace:operators-save', (_e: any, p: any) => {
    const operators = require('./operators.cts');
    // Throws on invalid configs; the rejection surfaces to the renderer.
    operators.saveOperatorsConfig(app.getPath('userData'), p?.config);
    return { ok: true };
  });
  // Summary of the BOOT-TIME resolution (post boot-guard). Re-resolving from
  // the current userData would be wrong once the external root is active: the
  // legacy config file lives in the local userData, not in the root itself.
  handle('ace:data-root-get', () => ({
    root: externalDataRoot.root ?? null,
    active: !!externalDataRoot.active,
    source: externalDataRoot.source ?? null,
    reason: externalDataRoot.reason ?? null,
    configuredRoot: externalDataRoot.configuredRoot ?? null,
  }));
  handle('ace:data-root-set', (_e: any, p: any) => {
    const root = typeof p?.root === 'string' ? p.root.trim() : '';
    if (!root) throw new Error('data root path is required');
    // Writes the activation marker into the new root and the legacy config
    // into the LOCAL userData (where boot resolution reads it). Never moves
    // data and never re-points the running session.
    writeActivationFiles({
      root,
      legacyUserDataPath: localUserDataPath,
      sourceUserDataPath: app.getPath('userData'),
    });
    return { needsRelaunch: true };
  });
  handle('ace:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // ── Hermes Desktop surface (electron/hermes-dashboard.cts) ──────────────
  // Lifecycle pushes mirror onto 'ace:hermes-desktop-event' via
  // registerBroadcasts. The ensure() result carries the dashboard URL — the
  // served page embeds the session token, so it goes only to the requesting
  // renderer and never into status payloads or logs.
  handle('ace:hermes-desktop-status', () => s.hermesDesktopStatus());
  handle('ace:hermes-desktop-set-surface', (_e: any, p: any) =>
    s.hermesDesktopSetSurface(p)
  );
  handle('ace:hermes-desktop-ensure', (_e: any, p: any) => s.hermesDesktopEnsure(p));
  handle('ace:hermes-desktop-stop', (_e: any, p: any) => s.hermesDesktopStop(p));
  handle('ace:hermes-desktop-profile-get', () =>
    s.hermesDesktopGetActiveProfile()
  );
  handle('ace:hermes-desktop-profile-set', (_e: any, p: any) =>
    s.hermesDesktopSetActiveProfile(p)
  );
  // Canonical home-chat restore for the resident bubble + exactly-once cron →
  // home-chat delivery (electron/hermes-home-chat.cts). Results carry the
  // picked session id and seed script only — never the embed URL or token.
  handle('ace:hermes-desktop-home-restore', (_e: any, p: any) =>
    s.hermesDesktopHomeSessionRestore(p || {})
  );
  handle('ace:hermes-desktop-cron-home-sync', (_e: any, p: any) =>
    s.hermesDesktopCronHomeDeliverySync(p || {})
  );
  // One-button "Update Hermes": safe branch-aware rebase + patch-guard + rebuild
  // (electron/hermes-update.cts). Long-running; renderer shows a busy state.
  handle('ace:hermes-update-apply', (_e: any, p: any) => s.hermesUpdateApply(p || {}));
  // Operations → Agents panels: narrow sidecar restart (manager stop+ensure,
  // sanitized result — never the embed URL/token).
  handle('ace:hermes-desktop-restart', (_e: any, p: any) =>
    s.hermesDesktopRestart(p)
  );
  // Telemetry spine (electron/telemetry.cts): read-only query/aggregate over
  // the append-only operational event log. Events are redacted at write time.
  handle('ace:telemetry-query', (_e: any, p: any) => s.telemetryQuery(p || {}));
  // Ops Pulse (electron/ops-pulse.cts): read-only per-project signals + ranked
  // next-step suggestions for the Operations "Pulse" panel.
  handle('ace:ops-pulse', () => s.opsPulse());
  registerHermesDesktopBridge({
    ipcMain,
    app,
    store: s,
    trustOptions: { userDataPath: app.getPath('userData') },
  });
  handle('ace:get-starred-agents', () => s.getStarredAgents());
  handle('ace:set-agent-starred', (_e: any, p: any) => s.setAgentStarred(p));


  handle('ace:skills-get-catalog', () => s.getSkillsCatalog());
  handle('ace:skills-refresh-catalog', () => s.refreshSkillsCatalog());
  handle('ace:skills-get-detail', (_e: any, p: any) => s.getSkillDetail(p));
  handle('ace:skills-search', (_e: any, p: any) => s.searchSkillsSh(p));
  handle('ace:skills-install', (_e: any, p: any) => s.installSkill(p));
  handle('ace:skills-uninstall', (_e: any, p: any) => s.uninstallSkill(p));
  handle('ace:skills-create', (_e: any, p: any) => s.createSkill(p));
  handle('ace:skills-detected-agents', () => s.getDetectedSkillAgents());


  handle('ace:mcp-load-all', () => s.loadMcp());
  handle('ace:mcp-save-server', (_e: any, p: any) => s.saveMcpServer(p));
  handle('ace:mcp-remove-server', (_e: any, p: any) => s.removeMcpServer(p));
  handle('ace:mcp-get-providers', () => s.getMcpProviders());


  handle('ace:usage-get-providers', () => getProviderUsage());
  // The usage push feed (ace:usage-changed) is wired through usage-events in
  // the whenReady block — source watchers over the statusline tap dir AND the
  // Codex session tree, coalesced, with the full report as payload.

  handle('ace:remote-get-status', () => {
    if (!remoteServer) return null;
    return remoteServer.getStatus();
  });
  handle('ace:remote-set-enabled', async (_e: any, p: any) => {
    if (!remoteServer) return null;
    return remoteServer.setEnabled(!!p?.enabled);
  });
  handle('ace:remote-set-tunnel-mode', async (_e: any, p: any) => {
    if (!remoteServer) return null;
    return remoteServer.setTunnelMode(p?.mode);
  });
  handle('ace:remote-detect-tunnels', () => detectTunnels());
  handle('ace:remote-mint-enrollment', () => {
    if (!remoteServer) return null;
    const { token, expiresAt } = remoteServer.mintEnrollment();
    const status = remoteServer.getStatus();
    return {
      token,
      expiresAt,
      url: status.primaryUrl,
      status,
    };
  });
  handle('ace:remote-list-devices', () => s.listRemoteDevices());
  handle('ace:remote-revoke-device', (_e: any, p: any) =>
    s.revokeRemoteDevice({ deviceId: p?.deviceId })
  );

  const streamChannels: any = {
    'ace:stream-list-streams': 'streamList',
    'ace:stream-read-screen': 'streamReadScreen',
    'ace:stream-get-state': 'streamGetState',
    'ace:stream-send-input': 'streamSendInput',
    'ace:stream-send-keys': 'streamSendKeys',
    'ace:stream-submit': 'streamSubmit',
    'ace:stream-send-submit': 'streamSendSubmit',
    'ace:stream-abort': 'streamAbort',
    'ace:stream-ask': 'streamAsk',
    'ace:stream-slash': 'streamSlash',
    'ace:stream-ref': 'streamRef',
    'ace:stream-approve': 'streamApprove',
    'ace:stream-interrupt': 'streamInterrupt',
    'ace:stream-wait-for': 'streamWaitFor',
    'ace:stream-spawn': 'streamSpawn',
    'ace:stream-close': 'streamClose',
    'ace:stream-rename': 'streamRename',
    'ace:stream-record-start': 'streamRecordStart',
    'ace:stream-record-stop': 'streamRecordStop',
    'ace:stream-replay': 'streamReplay',
    'ace:stream-follow': 'streamFollow',
    'ace:stream-snapshot': 'streamSnapshot',
    'ace:stream-profiles': 'streamProfiles',
    'ace:stream-reload-profiles': 'streamReloadProfiles',
    'ace:stream-transcript': 'streamTranscript',
  };
  for (const [channel, method] of Object.entries(streamChannels)) {
    handle(channel, (_e: any, p: any) => s[method as any](p));
  }

  // ── GitHub tab ─────────────────────────────────────────────────────────
  handle('ace:github-is-available', () => githubCore.isAvailable());
  handle('ace:github-refresh-availability', () => githubCore.refreshAvailability());
  handle('ace:github-list-accounts', (_e: any, p: any) => githubCore.listAccounts(p || {}));
  handle('ace:github-switch-account', (_e: any, p: any) => githubCore.switchAccount(p));
  handle('ace:github-login-start', (_e: any, p: any) => githubCore.loginStart(p || {}));
  handle('ace:github-login-poll', (_e: any, p: any) => githubCore.loginPoll(p || {}));
  handle('ace:github-login-cancel', (_e: any, p: any) => githubCore.loginCancel(p || {}));
  handle('ace:github-remove-account', (_e: any, p: any) => githubCore.removeAccount(p));
  handle('ace:github-list-repos', () => githubCore.listRepos());
  handle('ace:github-list-stars', () => githubCore.listStars());
  handle('ace:github-list-trending', (_e: any, p: any) => githubCore.listTrending(p || {}));
  handle('ace:github-clone-repo', (_e: any, p: any) => githubCore.cloneRepo(p));
  handle('ace:github-fetch-contributions', (_e: any, p: any) => githubCore.fetchContributions(p || {}));
  handle('ace:github-star-repo', (_e: any, p: any) => githubCore.starRepo(p));
  handle('ace:github-unstar-repo', (_e: any, p: any) => githubCore.unstarRepo(p));

  // ── Integration gateway (push / PR / checks / merge / cleanup) ─────────
  handle('ace:integration-push', (_e: any, p: any) => s.integrationPush(p));
  handle('ace:integration-open-pr', (_e: any, p: any) => s.integrationOpenPr(p));
  handle('ace:integration-ready-pr', (_e: any, p: any) => s.integrationReadyPr(p));
  handle('ace:integration-request-review', (_e: any, p: any) => s.integrationRequestReview(p));
  handle('ace:integration-poll-checks', (_e: any, p: any) => s.integrationPollChecks(p));
  handle('ace:integration-gate', (_e: any, p: any) => s.integrationGate(p));
  handle('ace:integration-merge-pr', (_e: any, p: any) => s.integrationMergePr(p));
  handle('ace:integration-cleanup', (_e: any, p: any) => s.integrationCleanup(p));
}

function registerBroadcasts() {
  subscriptions.push(
    aceStore.onState((state: any) => broadcast('ace:state-changed', state))
  );
  subscriptions.push(
    aceStore.onPtyData((payload: any) => broadcast('ace:pty-data', payload))
  );
  subscriptions.push(
    aceStore.onPtyExit((payload: any) => broadcast('ace:pty-exit', payload))
  );
  subscriptions.push(
    aceStore.onGitChanged((payload: any) => broadcast('ace:git-changed', payload))
  );
  subscriptions.push(
    aceStore.onInstallData((payload: any) => broadcast('ace:install-data', payload))
  );
  subscriptions.push(
    aceStore.onInstallExit((payload: any) => broadcast('ace:install-exit', payload))
  );
  subscriptions.push(
    aceStore.onStarredAgentsChanged((payload: any) =>
      broadcast('ace:starred-agents-changed', payload)
    )
  );
  subscriptions.push(
    aceStore.onRemoteSettingsChanged((payload: any) =>
      broadcast('ace:remote-settings-changed', payload)
    )
  );
  subscriptions.push(
    aceStore.onRemoteDevicesChanged((payload: any) =>
      broadcast('ace:remote-devices-changed', payload)
    )
  );
  subscriptions.push(
    aceStore.onIntegrationEvent((payload: any) =>
      broadcast('ace:integration-event', payload)
    )
  );
  subscriptions.push(
    aceStore.onOpsIntelRefreshed((payload: any) =>
      broadcast('ace:ops-intel-refreshed', payload)
    )
  );
  subscriptions.push(
    aceStore.onOpsBriefDelivered((payload: any) =>
      broadcast('ace:ops-brief-delivered', payload)
    )
  );
  subscriptions.push(
    aceStore.onHermesDesktopEvent((payload: any) => {
      broadcast('ace:hermes-desktop-event', payload);
      // Token hygiene: Hermes webviews render inside these dedicated
      // partitions (must keep the will-attach-webview 'persist:ace-browser'
      // prefix). When Hermes stops, clear the stopped origin's storage so
      // nothing the token-bearing SPA cached outlives the claim. Origin-scoped
      // so a second still-running dashboard in the same partition is untouched;
      // full-partition clear as fallback.
      // 'restarting' is included because a crash→auto-restart rebinds a FRESH
      // port: the event still carries the OLD host/port (emitted before the
      // restart reallocates), so this clear is the only chance to drop the
      // dead origin's storage.
      if (payload?.type === 'stopped' || payload?.type === 'exited' || payload?.type === 'restarting') {
        for (const partition of [
          'persist:ace-browser-hermes',
          'persist:ace-browser-hermes-desktop-app',
        ]) {
          try {
            const part = session.fromPartition(partition);
            const host = typeof payload.host === 'string' && payload.host.length > 0
              ? (payload.host.includes(':') ? `[${payload.host}]` : payload.host)
              : null;
            const origin = host && payload.port ? `http://${host}:${payload.port}` : null;
            void part
              .clearStorageData(origin ? { origin } : undefined)
              .catch(() => { /* best-effort hygiene */ });
          } catch {
            /* best-effort hygiene */
          }
        }
      }
    })
  );
  if (aceController) {
    subscriptions.push(
      aceController.bus.onAny((payload: any) => broadcast('ace:stream-event', payload))
    );
    // Run-ledger append settle → board live-refresh push. Lets the read-only
    // Run Board re-read the lean projection immediately (e.g. an external
    // `ace run submit` that touches neither the app store nor a pty stream)
    // instead of waiting for its 30s safety poll.
    subscriptions.push(
      aceController.onRunLedgerChanged((payload: any) =>
        broadcast('ace:run-ledger-changed', payload)
      )
    );
  }
}

function wireRemoteServerEvents() {
  if (!remoteServer) return;
  const server = remoteServer;
  const notify = () => {
    const status = server.getStatus();
    broadcast('ace:remote-status-changed', status);
    updatePowerSaveBlocker(status);
  };
  server.events.on('client-connect', notify);
  server.events.on('client-disconnect', notify);
  server.events.on('tunnel-changed', notify);
  server.events.on('started', notify);
  server.events.on('stopped', notify);

}

function updatePowerSaveBlocker(status: any) {
  const wantBlock = Boolean(status && status.running && status.connectedClients > 0);
  if (wantBlock && powerSaveBlockerId == null) {
    try {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch {}
  } else if (!wantBlock && powerSaveBlockerId != null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {}
    powerSaveBlockerId = null;
  }
}

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number' &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number'
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function writeWindowState(state: any) {
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf8');
  } catch (err) {
    console.error('[ace] failed to persist window bounds:', err);
  }
}

function writeRendererDiagnostic(event: string, data?: any) {
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    const payload = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    fs.appendFileSync(
      path.join(logDir, 'renderer-diagnostics.log'),
      `[${new Date().toISOString()}] ${event}${payload}\n`,
      'utf8',
    );
  } catch (err) {
    try { console.warn('[ace] renderer diagnostic write failed:', err); } catch {}
  }
}

function boundsWithinDisplays(bounds: any) {
  const displays = screen.getAllDisplays();
  return displays.some((d: any) => {
    const a = d.workArea;
    const rx = Math.max(bounds.x, a.x);
    const ry = Math.max(bounds.y, a.y);
    const rr = Math.min(bounds.x + bounds.width, a.x + a.width);
    const rb = Math.min(bounds.y + bounds.height, a.y + a.height);
    const overlap = Math.max(0, rr - rx) * Math.max(0, rb - ry);
    return overlap > 100 * 100;
  });
}

function loadWindow(win: any) {
  if (!win || win.isDestroyed?.()) return;
  const currentUrl = win.webContents.getURL();
  if (currentUrl && currentUrl !== 'about:blank') return;
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function createWindow(options: { deferLoad?: boolean } = {}) {
  const isMac = process.platform === 'darwin';
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const defaultWidth = Math.min(2200, Math.max(1400, Math.round(workArea.width * 0.94)));
  const defaultHeight = Math.min(1200, Math.max(800, Math.round(workArea.height * 0.88)));

  const saved = readWindowState();
  const useSaved = saved && boundsWithinDisplays(saved);
  const width = useSaved ? saved.width : defaultWidth;
  const height = useSaved ? saved.height : defaultHeight;

  const win = new BrowserWindow({
    width,
    height,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: 390,
    minHeight: 560,
    center: !useSaved,
    title: 'ACE CODER',
    icon: ICON_PATH,
    transparent: isMac,
    backgroundColor: isMac ? '#00000000' : '#0f0f10',
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: 'active',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 12 },
    // On macOS, a click on an inactive window normally only activates it
    // without being delivered to the web contents — so the user has to
    // click twice to actually focus a terminal / button after returning
    // from another app. Accept the first click so one tap both focuses
    // the window and hits whatever was clicked.
    acceptFirstMouse: true,
    // Show immediately so macOS has a real foreground window even if first paint
    // or later main-process startup work is slow.
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (useSaved && saved.maximized) win.maximize();

  let persistTimer: any = null;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (win.isDestroyed()) return;
      const maximized = win.isMaximized();
      const bounds = maximized ? (saved || { x: 0, y: 0, width, height }) : win.getBounds();
      writeWindowState({ ...bounds, maximized });
    }, 400);
  };
  win.on('resize', schedulePersist);
  win.on('move', schedulePersist);
  win.on('maximize', schedulePersist);
  win.on('unmaximize', schedulePersist);
  win.on('close', () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? (saved || { x: 0, y: 0, width, height }) : win.getBounds();
    writeWindowState({ ...bounds, maximized });
  });

  let hasShown = false;
  const showWindow = () => {
    if (hasShown || win.isDestroyed()) return;
    hasShown = true;
    win.show();
  };
  win.once('ready-to-show', showWindow);
  win.webContents.once('did-finish-load', showWindow);
  const showFallbackTimer = setTimeout(showWindow, 8000);
  if (typeof showFallbackTimer.unref === 'function') showFallbackTimer.unref();

  win.webContents.on('did-start-loading', () => {
    writeRendererDiagnostic('did-start-loading', { url: win.webContents.getURL() });
  });
  win.webContents.on('did-fail-load', (_event: any, errorCode: any, errorDescription: any, validatedURL: any, isMainFrame: any) => {
    writeRendererDiagnostic('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  win.webContents.on('render-process-gone', (_event: any, details: any) => {
    writeRendererDiagnostic('render-process-gone', details);
  });
  win.webContents.on('console-message', (_event: any, level: any, message: any, line: any, sourceId: any) => {
    writeRendererDiagnostic('console-message', { level, message, line, sourceId });
  });
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    writeRendererDiagnostic('did-finish-load', { url });
    win.webContents.executeJavaScript(`
      (() => {
        const root = document.getElementById('root');
        const bodyStyle = window.getComputedStyle(document.body);
        const htmlStyle = window.getComputedStyle(document.documentElement);
        return {
          href: location.href,
          readyState: document.readyState,
          title: document.title,
          bodyChildCount: document.body.children.length,
          bodyText: document.body.innerText.slice(0, 1000),
          rootChildCount: root ? root.children.length : null,
          rootText: root ? root.innerText.slice(0, 1000) : null,
          bodyBackground: bodyStyle.backgroundColor,
          htmlBackground: htmlStyle.backgroundColor,
          bodyDisplay: bodyStyle.display,
          scripts: Array.from(document.scripts).map((script) => script.src || '<inline>').slice(-10),
          stylesheets: Array.from(document.styleSheets).map((sheet) => sheet.href || '<inline>').slice(0, 20),
        };
      })()
    `, true)
      .then((snapshot: any) => writeRendererDiagnostic('dom-snapshot', snapshot))
      .catch((err: any) => writeRendererDiagnostic('dom-snapshot-failed', {
        message: err?.message || String(err),
        stack: err?.stack,
      }));
  });

  attachEditContextMenu(win.webContents);
  win.webContents.setWindowOpenHandler(({ url }: any) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (_event: any, webPreferences: any, params: any) => {
    const trustedHermesDesktop = isTrustedHermesDesktopWebview(params, webPreferences, {
      userDataPath: app.getPath('userData'),
    });
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!trustedHermesDesktop) {
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
    }
    if (!params.partition || !String(params.partition).startsWith('persist:ace-browser')) {
      params.partition = 'persist:ace-browser';
    }
  });
  win.webContents.on('did-attach-webview', (_event: any, wc: any) => {
    let hardenedHermesGuest = false;
    // session.fromPartition returns the same object for the same string.
    const isHermesDesktopPartition = () => {
      try {
        return wc.session === session.fromPartition(HERMES_DESKTOP_APP_PARTITION);
      } catch {
        return false;
      }
    };
    // Deliberately BROADER than the preload trust check: with no bundle the
    // guest is loopback http, not the packaged file:// index. Grants no extra
    // privilege — the preload stays gated on the trusted index above.
    const isHermesGuest = () => {
      if (hardenedHermesGuest) return true;
      let currentUrl = '';
      try { currentUrl = wc.getURL(); } catch {}
      if (
        isTrustedHermesDesktopResource(currentUrl, 'index', {
          userDataPath: app.getPath('userData'),
        })
      ) {
        return true;
      }
      return isHermesDesktopPartition() && isLoopbackHttpUrl(currentUrl);
    };
    const routeHermesWebLink = (url: any) =>
      sendHermesDesktopOpenLink(win.webContents, url);
    const guestUrl = () => {
      try { return wc.getURL(); } catch { return ''; }
    };
    // Decision lives in shouldDivertHermesGuestNavigation so it is unit-testable
    // against Electron's real argument shapes.
    const divert = (event: any, url: any, isMainFrame: any) =>
      shouldDivertHermesGuestNavigation({
        url,
        guestUrl: guestUrl(),
        isMainFrame: resolveIsMainFrame(event, isMainFrame),
      });
    wc.setWindowOpenHandler(({ url }: any) => {
      // Same reasoning as the will-navigate branch below: handle our own scheme
      // in-process rather than bouncing it through the OS and back.
      if (typeof url === 'string' && url.startsWith('ace://')) {
        acceptAceDeepLink(url);
        return { action: 'deny' };
      }
      // Keep any web link the user opens from inside the browser pane in-pane
      // (target=_blank, window.open) so it stays a real, navigable browser;
      // non-web schemes (mailto:, etc.) hand off to the OS default handler.
      if (isWebUrl(url)) {
        // Hermes is a chat surface, not a browser. Route its links into Ace's
        // real browser pane; loading here would replace the entire Hermes SPA
        // and strand the active conversation.
        if (isHermesGuest()) {
          if (!routeHermesWebLink(url)) shell.openExternal(url);
          return { action: 'deny' };
        }
        wc.loadURL(url).catch(() => {});
        return { action: 'deny' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });
    {
      // Always harden the trusted Hermes desktop guest (identified by its
      // committed file:// index URL) — the embed is the only path, no opt-out.
      // Generic browser/github webviews are left untouched.
      const hardenIfHermesGuest = () => {
        if (hardenedHermesGuest) return;
        let url = '';
        try { url = wc.getURL(); } catch {}
        // Same widened test as isHermesGuest, or the bundle-less surface never
        // gets render-process-gone wired and a crash has no recovery.
        const trustedIndex = isTrustedHermesDesktopResource(url, 'index', {
          userDataPath: app.getPath('userData'),
        });
        if (!trustedIndex && !(isHermesDesktopPartition() && isLoopbackHttpUrl(url))) return;
        hardenedHermesGuest = true;
        try { wc.setBackgroundThrottling(false); } catch {}
        // A renderer crash is distinct from the backend exit the pane already
        // handles; signal the host so it can remount the guest via React state
        // (never an imperative loadURL, which would strand state.url).
        wc.on('render-process-gone', (_e: any, details: any) => {
          if (details?.reason === 'clean-exit') return;
          try {
            win.webContents.send('ace:hermes-desktop-event', {
              type: 'guest-renderer-gone',
              reason: details?.reason ?? 'crashed',
            });
          } catch {}
        });
      };
      wc.on('did-navigate', hardenIfHermesGuest);
      wc.on('did-finish-load', hardenIfHermesGuest);
      hardenIfHermesGuest();
      wc.on('will-navigate', (event: any, url: any, _isInPlace: any, isMainFrame: any) => {
        if (!isHermesGuest() || !isWebUrl(url)) return;
        if (!divert(event, url, isMainFrame)) return;
        try { event.preventDefault(); } catch {}
        if (!routeHermesWebLink(url)) shell.openExternal(url);
      });
      // Server redirects never fire will-navigate, so the cross-origin guard
      // above cannot see them. Inert for the packaged file:// guest.
      wc.on('will-redirect', (event: any, url: any, _isInPlace: any, isMainFrame: any) => {
        if (!isHermesGuest() || !isWebUrl(url)) return;
        if (!divert(event, url, isMainFrame)) return;
        try { event.preventDefault(); } catch {}
        if (!routeHermesWebLink(url)) shell.openExternal(url);
      });
    }
  });

  if (!options.deferLoad) loadWindow(win);
  return win;
}

// Account-free startup still waits for the local runtime and reports real failures.
async function ensureRuntimeReady() {
  if (runtimeBooted) return runtimeState;
  if (startingRuntime) return startingRuntime;
  const run = (async () => {
    runtimeState = { status: 'starting' };
    broadcast('ace:runtime-changed', runtimeState);
    const result = await bootRuntime?.();
    runtimeState = result?.ok ? { status: 'ready' } : {
      status: 'boot-error', reason: result?.reason || 'Local runtime is unavailable.',
    };
    broadcast('ace:runtime-changed', runtimeState);
    return runtimeState;
  })();
  startingRuntime = run;
  try { return await run; }
  finally { if (startingRuntime === run) startingRuntime = null; }
}

app.whenReady().then(async () => {
  // Must run BEFORE createAceStore: a configured-but-unavailable data
  // root has to be resolved (or explicitly fallen back from) before any
  // store/db init can touch the local fallback.
  if (runDataRootBootGuard() === 'quit') return;

  // Arm the mid-session mount-liveness watchdog ONLY when the SSD root is
  // active. Inactive/local-fallback boots never arm it, so generic builds are
  // unaffected. `broadcast` is defined by now (whenReady runs post module load).
  if (externalDataRoot.active && externalDataRoot.root) {
    startExternalRootWatchdog();
  }

  if (process.platform === 'darwin' && app.dock) {
    try {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {}
  }
  buildAppMenu();

  const mainWindow = createWindow({ deferLoad: true });

  // The runtime boots locally without an account or network authority.
  bootRuntime = async () => {
    if (runtimeBooted) return { ok: true, status: 'ready', alreadyBooted: true };

    const deferredBootTasks: Array<() => void> = [];
    let deferredBootStarted = false;
    const startDeferredBootTasks = () => {
      if (deferredBootStarted) return;
      deferredBootStarted = true;
      setTimeout(() => {
        for (const task of deferredBootTasks) {
          try { task(); } catch (err) { console.warn('[ace] deferred boot task failed:', err); }
        }
      }, 500);
    };
    const armDeferredBootAfterWindow = (win: any) => {
      if (!win || win.isDestroyed?.()) { startDeferredBootTasks(); return; }
      // A retry can finish after the first load event; start immediately then.
      let loading = true;
      try { loading = Boolean(win.webContents.isLoading?.()); } catch { loading = true; }
      if (!loading) { startDeferredBootTasks(); return; }
      win.webContents.once('did-finish-load', startDeferredBootTasks);
      const fallback = setTimeout(startDeferredBootTasks, 60000);
      if (typeof fallback.unref === 'function') fallback.unref();
    };

    // The heavy-runtime construction, lifted into an ordered, DI-testable seam
    // (electron/runtime-boot.cts). Non-fatal subsystems keep their OWN try/catch — a
    // missing browser/usage limb must not brick boot; the FATAL steps (store,
    // github core) throw, and the seam holds boot honestly (never sets runtimeBooted).
    const constructors = [
      { name: 'ace-store', run: () => {
        // FATAL: the store IS the runtime. A throw here holds boot honestly.
        aceStore = createAceStore(app.getPath('userData'));
      } },
      { name: 'ace-controller', run: () => {
        try {
          aceController = createAceController({ aceStore, userDataPath: app.getPath('userData') });
          Object.assign(aceStore, aceController.methods);
          aceSocketBridge = createSocketBridge({
            aceStore,
            aceController,
            userDataPath: app.getPath('userData'),
          });
          aceSocketBridge.start()
            .catch((err: any) => {
              console.error('[ace] socket bridge failed to start:', err?.message || err);
            });
          aceStore._orchestratorCompactionStop = createCompactionController({
            aceStore: {
              on: (event: any, listener: any) => {
                aceStore.events.on(event, listener);
                return () => aceStore.events.off(event, listener);
              },
            },
            db: aceStore.getDb(),
            streamApi: {
              sendInput: (args: any) => aceStore.streamSendInput(args),
              submit: (args: any) => aceStore.streamSubmit(args),
              getState: (args: any) => aceStore.streamGetState(args),
              waitFor: (args: any) => aceStore.streamWaitFor(args),
            },
            logger: console,
          }).start();
          deferredBootTasks.push(() => {
            // Ace surface is now attached to publicApi. The watchdog immediately
            // rehydrates always-on orchestrators, then periodically re-runs the same
            // idempotent start/reuse path so missing or stopped PTYs come back.
            aceStore.startAlwaysOnOrchestratorWatchdog();
          });
          deferredBootTasks.push(() => {
            // Bring back the claude/codex agent tabs that were running before the
            // restart: adopt PTYs that survived inside the detached pty-host, and
            // relaunch sessions that did not survive (full quit, reboot) via their
            // recorded CLI session ids (--resume). Deferred off the launch path
            // because replay can touch large Hermes state.db files.
            setTimeout(() => {
              aceStore?.restoreAgentStreams?.({ relaunchMissing: true }).catch((err: any) => {
                console.warn('[ace] agent stream restore failed:', err?.message || err);
              });
            }, 1500);
          });
        } catch (err) {
          console.error('[ace] Ace controller unavailable:', err);
        }
      } },
      { name: 'browser-controller', run: () => {
        try {
          const browserController = createBrowserController({
            store: aceStore,
            userDataPath: app.getPath('userData'),
            // Route through the store's event surface so both the desktop windows
            // (broadcast below) and remote clients (remote-server forwarders) see events.
            emit: (type: string, payload: any) => {
              if (type === 'browser-ui-request') aceStore.emitBrowserUiRequest(payload);
              else aceStore.emitBrowserControlStatus(payload);
            },
          });
          Object.assign(aceStore, browserController.methods);
          aceStore.onBrowserUiRequest((payload: any) => broadcast('ace:browser-ui-request', payload));
          aceStore.onBrowserControlStatus((payload: any) => broadcast('ace:browser-control-status', payload));
        } catch (err) {
          console.error('[ace] browser controller unavailable:', err);
        }
      } },
      { name: 'browser-streams', run: () => {
        try {
          // Offscreen browser hosts that stream browser tabs to remote/mobile clients
          // (frames flow only over the remote WS, never desktop IPC — the desktop
          // renders real <webview>s instead).
          const { createBrowserTabStreams } = require('./browser-stream.cjs');
          const browserStreams = createBrowserTabStreams({
            store: aceStore,
            emit: (payload: any) => aceStore.emitBrowserStreamEvent(payload),
          });
          Object.assign(aceStore, browserStreams.methods);
          subscriptions.push(() => browserStreams.disposeAll());
        } catch (err) {
          console.error('[ace] browser stream host unavailable:', err);
        }
      } },
      { name: 'usage-events', run: () => {
        try {
          // Event-driven usage meters: watch the official usage sources (Claude
          // statusline tap cache, Codex session JSONL) and push one typed report to
          // every window on change; deferred initial pump walks the Codex session tree.
          const usageEvents = require('./usage-events.cjs');
          subscriptions.push(usageEvents.subscribeUsageChanged((report: any) => broadcast('ace:usage-changed', report)));
          subscriptions.push(() => usageEvents.stopUsageEvents());
          deferredBootTasks.push(() => usageEvents.startUsageEvents());
        } catch (err) {
          console.error('[ace] usage events unavailable:', err);
        }
      } },
      { name: 'login-watcher', run: () => {
        try {
          // Watch agent terminals for printed OAuth/sign-in URLs (claude /login, codex
          // login, gh device flow …) and open them in an in-app browser tab in the
          // owning task — the only login path that works from a phone.
          const { createLoginUrlWatcher } = require('./login-url-watcher.cjs');
          const loginWatcher = createLoginUrlWatcher({
            store: aceStore,
            emitUiRequest: (payload: any) => aceStore.emitBrowserUiRequest(payload),
          });
          aceStore.onPtyData((payload: any) => loginWatcher.handlePtyData(payload));
          aceStore.onPtyExit((payload: any) => loginWatcher.reset(payload?.id));
        } catch (err) {
          console.error('[ace] login url watcher unavailable:', err);
        }
      } },
      { name: 'github-core', run: () => {
        // Generic GitHub integration remains independent of local startup.
        githubCore = createGithubCore({ store: aceStore });
      } },
      { name: 'deferred-tasks', run: () => {
        deferredBootTasks.push(() => {
          aceStore?.startWorkspaceMetaRefresh?.();
        });
        deferredBootTasks.push(() => sweepOldPastes(app.getPath('temp')));
        deferredBootTasks.push(() => scheduleOpsStatusSnapshot());
        deferredBootTasks.push(() => scheduleOpsBriefs());
        deferredBootTasks.push(() => scheduleTodoDigests());
        deferredBootTasks.push(() => scheduleKnowledgeNightlyLoop());
      } },
      { name: 'remote-server', run: () => {
        try {
          remoteServer = createRemoteServer({
            aceStore,
            aceController,
            githubCore,
            userDataPath: app.getPath('userData'),
            devProxyUrl: isDev ? (process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173') : null,
          });
          wireRemoteServerEvents();
          deferredBootTasks.push(() => {
            const settings = aceStore.getRemoteSettings();
            if (settings.enabled || process.env.ACE_REMOTE_DEV === '1') {
              if (process.env.ACE_REMOTE_DEV === '1' && !settings.enabled) {
                aceStore.setRemoteEnabled(true);
              }
              remoteServer.start().catch((err: any) => {
                console.error('[ace] remote server failed to start:', err);
              });
            }
          });
        } catch (err) {
          console.error('[ace] remote server unavailable:', err);
        }
      } },
    ];

    // Best-effort teardown of whatever partial construction happened before a fatal
    // failure — a runtime that failed to boot must not leak half-built subsystems.
    const teardownPartial = async () => {
      try { aceSocketBridge?.stop?.(); aceSocketBridge?.close?.(); } catch {}
      try { await remoteServer?.stop?.(); remoteServer?.close?.(); } catch {}
      try { await aceController?.shutdown?.(); } catch {}
      while (subscriptions.length) { try { await subscriptions.pop()(); } catch {} }
      for (const channel of runtimeIpcChannels) ipcMain.removeHandler(channel);
      runtimeIpcChannels.clear();
      try { await aceStore?.shutdown?.({ killDetached: false }); } catch {}
      aceStore = null;
      aceController = null;
      aceSocketBridge = null;
      remoteServer = null;
      githubCore = null;
    };

    const runtimeBoot = createRuntimeBoot({
      constructors,
      // IPC registration is the LAST step (renderer→main handlers + broadcast wiring).
      // Nothing constructed above invokes these at build time.
      registerIpc: () => { registerHandlers(); registerBroadcasts(); },
      broadcast,
      teardownPartial,
    });
    const bootResult = await runtimeBoot.boot();
    runtimeBooted = bootResult.ok;
    if (bootResult.ok) armDeferredBootAfterWindow(mainWindow);
    return bootResult;
  }; // end bootRuntime

  ipcMain.handle('ace:runtime-state', () => ensureRuntimeReady());
  loadWindow(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow({ deferLoad: true });
      loadWindow(win);
    }
  });

  await ensureRuntimeReady();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event: any) => {
  // Keep the app alive while the first window is still loading.
  if (Date.now() - ACE_BOOT_AT < ACE_BOOT_TERMINATION_GUARD_MS) {
    try { event.preventDefault(); } catch {}
    return;
  }
  while (subscriptions.length) {
    try {
      subscriptions.pop()();
    } catch {}
  }
  if (powerSaveBlockerId != null) {
    try { powerSaveBlocker.stop(powerSaveBlockerId); } catch {}
    powerSaveBlockerId = null;
  }
  if (remoteServer) {
    try { await remoteServer.stop(); } catch {}
    remoteServer = null;
  }
  if (aceSocketBridge) {
    try { aceSocketBridge.stop(); } catch {}
    aceSocketBridge = null;
  }
  if (aceController) {
    try { aceController.shutdown(); } catch {}
    aceController = null;
  }
  if (aceStore) aceStore.shutdown();
});
