const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channels: any = {
  getState: 'ace:get-state',
  seedState: 'ace:seed-state',
  perfHealth: 'ace:perf-health',
  perfRecord: 'ace:perf-record',
  opsStatus: 'ace:ops-status',
  opsSignals: 'ace:ops-signals',
  opsRecommendations: 'ace:ops-recommendations',
  opsBrief: 'ace:ops-brief',
  opsIntel: 'ace:ops-intel',
  opsTodosList: 'ace:ops-todos-list',
  opsTodoCreate: 'ace:ops-todo-create',
  opsTodoUpdate: 'ace:ops-todo-update',
  opsTodoRemove: 'ace:ops-todo-remove',
  opsTodoDigest: 'ace:ops-todo-digest',
  opsTodoSynthesize: 'ace:ops-todo-synthesize',
  opsSourcesGet: 'ace:ops-sources-get',
  opsSourcesUpdate: 'ace:ops-sources-update',
  opsRefresh: 'ace:ops-refresh',
  opsSourceState: 'ace:ops-source-state',
  opsWikiGraph: 'ace:ops-wiki-graph',
  opsWikiHealth: 'ace:ops-wiki-health',
  opsWikiPage: 'ace:ops-wiki-page',
  opsWikiReveal: 'ace:ops-wiki-reveal',
  knowledgeSearch: 'ace:knowledge-search',
  knowledgeGet: 'ace:knowledge-get',
  knowledgeReindex: 'ace:knowledge-reindex',
  knowledgeStatus: 'ace:knowledge-status',
  knowledgeOverview: 'ace:knowledge-overview',
  knowledgeNightlyStatus: 'ace:knowledge-nightly-status',
  knowledgeQuarantineList: 'ace:knowledge-quarantine-list',
  knowledgeQuarantineResolve: 'ace:knowledge-quarantine-resolve',
  opsBriefSchedule: 'ace:ops-brief-schedule',
  opsBriefGenerate: 'ace:ops-brief-generate',
  // The mission-* channels were deleted in the mission-domain excision; only the
  // lean READ-ONLY run-ledger board read survives.
  runBoard: 'ace:run-board',
  runSubmit: 'ace:run-submit',
  runtimeState: 'ace:runtime-state',
  // Loops subsystem (additive limb over the run-ledger spine; PRD §6). The generic
  // aceDesktop.invoke(method, payload) below resolves these channels — no
  // per-method bridge function is needed.
  loopsList: 'ace:loops-list',
  loopsGet: 'ace:loops-get',
  loopsCompile: 'ace:loops-compile',
  loopsLockOn: 'ace:loops-lockon',
  loopsSave: 'ace:loops-save',
  loopsRun: 'ace:loops-run',
  loopsStop: 'ace:loops-stop',
  loopsRemove: 'ace:loops-remove',
  loopsStatus: 'ace:loops-status',
  loopsSelect: 'ace:loops-select',
  loopsKillAll: 'ace:loops-kill-all',
  pickDirectory: 'ace:pick-directory',
  openFolder: 'ace:open-folder',

  browseLocalDir: 'ace:browse-local-dir',
  importWorkspace: 'ace:import-workspace',
  importRemoteWorkspace: 'ace:import-remote-workspace',
  listRemoteHosts: 'ace:list-remote-hosts',
  listRemoteDir: 'ace:list-remote-dir',
  createRemoteDir: 'ace:create-remote-dir',
  removeWorkspace: 'ace:remove-workspace',
  initializeWorkspace: 'ace:initialize-workspace',
  refreshWorkspace: 'ace:refresh-workspace',
  projectsRefreshDefaultBranch: 'ace:projects-refresh-default-branch',
  projectsSetBaseBranch: 'ace:projects-set-base-branch',
  projectsGetEffectiveBaseBranch: 'ace:projects-get-effective-base-branch',
  getWorkspaceStats: 'ace:workspace-stats',
  getWorkspaceStatsDetail: 'ace:workspace-stats-detail',
  listTrackedGithubProjects: 'ace:list-tracked-github-projects',
  deleteBranch: 'ace:delete-branch',
  openExternal: 'ace:open-external',
  cloneWorkspace: 'ace:clone-workspace',

  createTask: 'ace:create-task',
  createThread: 'ace:create-thread',
  startHermesOrchestrator: 'ace:start-hermes-orchestrator',
  startOrchestrator: 'ace:start-orchestrator',
  setAlwaysOnOrchestrator: 'ace:set-always-on-orchestrator',
  listAgentLanes: 'ace:list-agent-lanes',
  listHermesProfiles: 'ace:list-hermes-profiles',
  listOrchestratorTemplates: 'ace:list-orchestrator-templates',
  createAgentLane: 'ace:create-agent-lane',
  getOrCreatePersonalWorkspace: 'ace:get-or-create-personal-workspace',
  getOrCreatePersonalIdentityWorkspace: 'ace:get-or-create-personal-identity-workspace',
  deleteTask: 'ace:delete-task',
  archiveTask: 'ace:archive-task',
  unarchiveTask: 'ace:unarchive-task',
  reorderWorkspaces: 'ace:reorder-workspaces',
  reorderTasksInWorkspace: 'ace:reorder-tasks-in-workspace',
  setTaskAutoApprove: 'ace:set-task-auto-approve',
  getTaskSpec: 'ace:get-task-spec',

  createConversation: 'ace:create-conversation',
  closeConversation: 'ace:close-conversation',
  activateConversation: 'ace:activate-conversation',
  listScratchTabs: 'ace:list-scratch-tabs',
  saveScratchTabs: 'ace:save-scratch-tabs',
  browserRegisterWebview: 'ace:browser-register-webview',
  browserUnregisterWebview: 'ace:browser-unregister-webview',
  browserStop: 'ace:browser-stop',
  browserList: 'ace:browser-list',
  browserOpen: 'ace:browser-open',
  browserActivate: 'ace:browser-activate',
  browserNavigate: 'ace:browser-navigate',
  browserInfo: 'ace:browser-info',
  browserScreenshot: 'ace:browser-screenshot',
  browserClick: 'ace:browser-click',
  browserType: 'ace:browser-type',
  browserKey: 'ace:browser-key',
  browserScroll: 'ace:browser-scroll',
  browserEval: 'ace:browser-eval',
  browserCdp: 'ace:browser-cdp',
  browserWaitFor: 'ace:browser-wait-for',
  browserElements: 'ace:browser-elements',
  browserConsole: 'ace:browser-console',
  browserInspectRef: 'ace:browser-inspect-ref',
  browserClickRef: 'ace:browser-click-ref',
  browserTypeRef: 'ace:browser-type-ref',
  browserSkillsList: 'ace:browser-skills-list',
  browserSkillsRead: 'ace:browser-skills-read',
  browserStreamOpen: 'ace:browser-stream-open',
  browserStreamClose: 'ace:browser-stream-close',
  browserStreamInput: 'ace:browser-stream-input',
  browserStreamNavigate: 'ace:browser-stream-navigate',
  browserStreamResize: 'ace:browser-stream-resize',
  listEditorOpenFiles: 'ace:list-editor-open-files',
  saveEditorOpenFiles: 'ace:save-editor-open-files',

  ensureWorkItemSession: 'ace:ensure-work-item-session',
  ensureVariantSession: 'ace:ensure-variant-session',
  ensureStreamStarted: 'ace:ensure-stream-started',
  killShellStream: 'ace:kill-shell-stream',
  getStreamSnapshot: 'ace:get-stream-snapshot',
  getTerminalSync: 'ace:get-terminal-sync',

  createWorktree: 'ace:create-worktree',
  deleteWorktree: 'ace:delete-worktree',
  attachVariant: 'ace:attach-variant',
  removeVariant: 'ace:remove-variant',
  reorderVariants: 'ace:reorder-variants',
  reorderConversations: 'ace:reorder-conversations',
  broadcastToVariants: 'ace:broadcast-to-variants',

  writeTerminalInput: 'ace:write-terminal-input',
  resizeTerminal: 'ace:resize-terminal',
  pasteClipboardImage: 'ace:paste-clipboard-image',
  pasteClipboardImageRemote: 'ace:paste-clipboard-image-remote',

  gitStatus: 'ace:git-status',
  gitLog: 'ace:git-log',
  gitShow: 'ace:git-show',
  gitShowFile: 'ace:git-show-file',
  gitDiffFile: 'ace:git-diff-file',
  gitStage: 'ace:git-stage',
  gitUnstage: 'ace:git-unstage',
  gitStageAll: 'ace:git-stage-all',
  gitUnstageAll: 'ace:git-unstage-all',
  gitCommit: 'ace:git-commit',
  gitRevert: 'ace:git-revert',
  gitReset: 'ace:git-reset',
  gitPush: 'ace:git-push',
  gitCreatePR: 'ace:git-create-pr',

  listTaskFiles: 'ace:list-task-files',
  readTaskFile: 'ace:read-task-file',
  searchFiles: 'ace:search-files',
  searchFileContent: 'ace:search-file-content',
  writeTaskFile: 'ace:write-task-file',
  createTaskFile: 'ace:create-task-file',
  createTaskFolder: 'ace:create-task-folder',
  renameTaskPath: 'ace:rename-task-path',
  deleteTaskPath: 'ace:delete-task-path',
  restoreFromTrash: 'ace:restore-from-trash',
  revealTaskPath: 'ace:reveal-task-path',


  listWorkspaceFiles: 'ace:list-task-files',
  readWorkspaceFile: 'ace:read-task-file',
  writeWorkspaceFile: 'ace:write-task-file',
  createWorkspaceFile: 'ace:create-task-file',
  createWorkspaceFolder: 'ace:create-task-folder',
  renameWorkspacePath: 'ace:rename-task-path',
  deleteWorkspacePath: 'ace:delete-task-path',
  revealWorkspacePath: 'ace:reveal-task-path',

  getAgentCatalog: 'ace:get-agent-catalog',
  getSystemTools: 'ace:get-system-tools',
  startInstallAgent: 'ace:start-install-agent',
  cliGetStatus: 'ace:cli-get-status',
  cliInstall: 'ace:cli-install',
  cliUninstall: 'ace:cli-uninstall',


  operatorsList: 'ace:operators-list',
  operatorsSave: 'ace:operators-save',
  dataRootGet: 'ace:data-root-get',
  dataRootSet: 'ace:data-root-set',
  relaunch: 'ace:relaunch',

  hermesDesktopStatus: 'ace:hermes-desktop-status',
  hermesDesktopSetSurface: 'ace:hermes-desktop-set-surface',
  hermesDesktopEnsure: 'ace:hermes-desktop-ensure',
  hermesDesktopStop: 'ace:hermes-desktop-stop',
  hermesDesktopGetActiveProfile: 'ace:hermes-desktop-profile-get',
  hermesDesktopSetActiveProfile: 'ace:hermes-desktop-profile-set',
  hermesDesktopHomeSessionRestore: 'ace:hermes-desktop-home-restore',
  hermesDesktopCronHomeDeliverySync: 'ace:hermes-desktop-cron-home-sync',
  hermesUpdateApply: 'ace:hermes-update-apply',
  hermesDesktopRestart: 'ace:hermes-desktop-restart',
  telemetryQuery: 'ace:telemetry-query',
  opsPulse: 'ace:ops-pulse',

  getStarredAgents: 'ace:get-starred-agents',
  setAgentStarred: 'ace:set-agent-starred',
  skillsGetCatalog: 'ace:skills-get-catalog',
  skillsRefreshCatalog: 'ace:skills-refresh-catalog',
  skillsGetDetail: 'ace:skills-get-detail',
  skillsSearch: 'ace:skills-search',
  skillsInstall: 'ace:skills-install',
  skillsUninstall: 'ace:skills-uninstall',
  skillsCreate: 'ace:skills-create',
  skillsDetectedAgents: 'ace:skills-detected-agents',

  mcpLoadAll: 'ace:mcp-load-all',
  mcpSaveServer: 'ace:mcp-save-server',
  mcpRemoveServer: 'ace:mcp-remove-server',
  mcpGetProviders: 'ace:mcp-get-providers',
  usageGetProviders: 'ace:usage-get-providers',

  remoteGetStatus: 'ace:remote-get-status',
  remoteSetEnabled: 'ace:remote-set-enabled',
  remoteSetTunnelMode: 'ace:remote-set-tunnel-mode',
  remoteDetectTunnels: 'ace:remote-detect-tunnels',
  remoteMintEnrollment: 'ace:remote-mint-enrollment',
  remoteListDevices: 'ace:remote-list-devices',
  remoteRevokeDevice: 'ace:remote-revoke-device',

  streamList: 'ace:stream-list-streams',
  streamReadScreen: 'ace:stream-read-screen',
  streamGetState: 'ace:stream-get-state',
  streamSendInput: 'ace:stream-send-input',
  streamSendKeys: 'ace:stream-send-keys',
  streamSubmit: 'ace:stream-submit',
  streamSendSubmit: 'ace:stream-send-submit',
  streamAbort: 'ace:stream-abort',
  streamAsk: 'ace:stream-ask',
  streamSlash: 'ace:stream-slash',
  streamRef: 'ace:stream-ref',
  streamApprove: 'ace:stream-approve',
  streamInterrupt: 'ace:stream-interrupt',
  streamWaitFor: 'ace:stream-wait-for',
  streamSpawn: 'ace:stream-spawn',
  streamClose: 'ace:stream-close',
  streamRename: 'ace:stream-rename',
  streamRecordStart: 'ace:stream-record-start',
  streamRecordStop: 'ace:stream-record-stop',
  streamReplay: 'ace:stream-replay',
  streamFollow: 'ace:stream-follow',
  streamSnapshot: 'ace:stream-snapshot',
  streamProfiles: 'ace:stream-profiles',
  streamReloadProfiles: 'ace:stream-reload-profiles',
  streamTranscript: 'ace:stream-transcript',

  githubIsAvailable: 'ace:github-is-available',
  githubRefreshAvailability: 'ace:github-refresh-availability',
  githubListAccounts: 'ace:github-list-accounts',
  githubSwitchAccount: 'ace:github-switch-account',
  githubLoginStart: 'ace:github-login-start',
  githubLoginPoll: 'ace:github-login-poll',
  githubLoginCancel: 'ace:github-login-cancel',
  githubRemoveAccount: 'ace:github-remove-account',
  githubListRepos: 'ace:github-list-repos',
  githubListStars: 'ace:github-list-stars',
  githubListTrending: 'ace:github-list-trending',
  githubCloneRepo: 'ace:github-clone-repo',
  githubFetchContributions: 'ace:github-fetch-contributions',
  githubStarRepo: 'ace:github-star-repo',
  githubUnstarRepo: 'ace:github-unstar-repo',

  integrationPush: 'ace:integration-push',
  integrationOpenPr: 'ace:integration-open-pr',
  integrationReadyPr: 'ace:integration-ready-pr',
  integrationRequestReview: 'ace:integration-request-review',
  integrationPollChecks: 'ace:integration-poll-checks',
  integrationGate: 'ace:integration-gate',
  integrationMergePr: 'ace:integration-merge-pr',
  integrationCleanup: 'ace:integration-cleanup',
};

contextBridge.exposeInMainWorld('aceDesktop', {
  invoke(method: any, payload: any) {
    const channel = channels[method];
    if (!channel) return Promise.reject(new Error(`Unknown Ace method: ${method}`));
    return ipcRenderer.invoke(channel, payload);
  },
  // Electron ≥32 removed the legacy File.path property. webUtils.getPathForFile
  // is the replacement for resolving a drag-dropped or <input type="file">
  // file back to its on-disk absolute path. Returns '' if the file was
  // created from a Blob (paste) and never existed on disk.
  getFilePath(file: any) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  subscribe(listener: any) {
    const h = (_e: any, state: any) => listener(state);
    ipcRenderer.on('ace:state-changed', h);
    return () => ipcRenderer.removeListener('ace:state-changed', h);
  },
  onPtyData(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:pty-data', h);
    return () => ipcRenderer.removeListener('ace:pty-data', h);
  },
  onPtyExit(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:pty-exit', h);
    return () => ipcRenderer.removeListener('ace:pty-exit', h);
  },
  onGitChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:git-changed', h);
    return () => ipcRenderer.removeListener('ace:git-changed', h);
  },
  onInstallData(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:install-data', h);
    return () => ipcRenderer.removeListener('ace:install-data', h);
  },
  onInstallExit(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:install-exit', h);
    return () => ipcRenderer.removeListener('ace:install-exit', h);
  },
  // Main reports local runtime readiness and startup failures.
  onRuntimeChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:runtime-changed', h);
    return () => ipcRenderer.removeListener('ace:runtime-changed', h);
  },
  onUsageChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:usage-changed', h);
    return () => ipcRenderer.removeListener('ace:usage-changed', h);
  },
  onHermesDesktopEvent(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:hermes-desktop-event', h);
    return () => ipcRenderer.removeListener('ace:hermes-desktop-event', h);
  },
  onOpsIntelRefreshed(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:ops-intel-refreshed', h);
    return () => ipcRenderer.removeListener('ace:ops-intel-refreshed', h);
  },
  onOpsBriefDelivered(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:ops-brief-delivered', h);
    return () => ipcRenderer.removeListener('ace:ops-brief-delivered', h);
  },
  onStarredAgentsChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:starred-agents-changed', h);
    return () => ipcRenderer.removeListener('ace:starred-agents-changed', h);
  },
  onRemoteStatusChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:remote-status-changed', h);
    return () => ipcRenderer.removeListener('ace:remote-status-changed', h);
  },
  onRemoteDevicesChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:remote-devices-changed', h);
    return () => ipcRenderer.removeListener('ace:remote-devices-changed', h);
  },
  onStreamEvent(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:stream-event', h);
    return () => ipcRenderer.removeListener('ace:stream-event', h);
  },
  onRunLedgerChanged(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:run-ledger-changed', h);
    return () => ipcRenderer.removeListener('ace:run-ledger-changed', h);
  },
  onBrowserControlStatus(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:browser-control-status', h);
    return () => ipcRenderer.removeListener('ace:browser-control-status', h);
  },
  onBrowserUiRequest(listener: any) {
    const h = (_e: any, payload: any) => listener(payload);
    ipcRenderer.on('ace:browser-ui-request', h);
    return () => ipcRenderer.removeListener('ace:browser-ui-request', h);
  },
});
