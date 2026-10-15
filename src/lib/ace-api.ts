import type {
  AgentCatalogEntry,
  DetectedSkillAgent,
  McpCatalogEntry,
  McpProvider,
  McpServer,
  Mission,
  RunLedgerBoard,
  Skill,
  SkillsCatalog,
  StreamSnapshot,
  Workspace,
} from './types';
import type {
  AgentLane,
  CreateAgentLaneInput,
  HermesProfileSummary,
  OrchestratorTemplate,
} from './agent-lanes';
import type {
  AttachVariantInput,
  BroadcastCommandInput,
  CreateWorkspaceTaskInput,
  CreateWorkspaceThreadInput,
  CreateWorktreeInput,
} from './local-core';

import type { TaskSpecResult } from './task-spec';
import type { OperatorsConfig } from './operators';
import type {
  TeamTicketConnection, TeamTicketConnectionInput, TeamTicketGetInput,
  TeamTicketLaunchInput, TeamTicketPreview, TeamTicketSearchInput, TeamTicketSearchResult,
} from './team-tickets-types';
import { requestGithubBrowserOpen } from './github-browser';
import { isRemoteCredentialRejection } from './remote-response';
import { initOperatorsRegistry } from '../runtime/operators-registry';
import {
  clientTerminalScrollback,
  sanitizeComposerDraftText,
  sanitizeTerminalInputPayload,
} from '../runtime/terminal-safety';
// `rev` is the server's monotonic snapshot revision (see local-core getState);
// clients use it to drop stale snapshots that arrive out of order.
type AceState = { version: 3; rev?: number; workspaces: Workspace[]; missions: Mission[] };

function sanitizeTerminalDimensions(
  cols: unknown,
  rows: unknown
): { cols: number; rows: number } | null {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  const normalized = { cols: Math.trunc(c), rows: Math.trunc(r) };
  if (normalized.cols < 1 || normalized.rows < 1) return null;
  return normalized;
}

function sanitizeStreamTextPayload(text: string): string | null {
  const safe = sanitizeComposerDraftText(text);
  return safe.length > 0 || text.length === 0 ? safe : null;
}

// --- Loops subsystem renderer-safe types (mirror electron/loops/loop-spec.cts) ---
// Renderer-safe copies of the LoopSpec contract — the GUI consumes these via
// aceApi.loops.* and src/runtime/loops-registry.ts re-exports them. Kept in
// sync with the electron pure module by shape (no electron import in the renderer).
export type RendererLoopKind = 'code' | 'agentic' | 'system';
export type RendererLoopPermission =
  | 'merge_to_main'
  | 'deploy_prod'
  | 'spend_money'
  | 'send_external_message'
  | 'delete_or_archive_data';
export type RendererLoopStopState =
  | 'DONE'
  | 'BLOCKED'
  | 'CLEAN_NOOP'
  | 'READY_FOR_REVIEW'
  | 'NEEDS_OWNER_DECISION'
  | 'STALLED_NO_PROGRESS'
  | 'UNSAFE_REQUIRES_APPROVAL';

export interface RendererLoopSpec {
  id: string;
  name: string;
  description: string;
  useWhen: string;
  kind: RendererLoopKind;
  inputs: Record<string, unknown>;
  goalTemplate: string;
  routing: {
    agent: 'claude' | 'codex' | 'auto';
    skills: string[];
    workspace: 'loops';
    target: { repo?: string; allow: string[]; workspace?: string };
  };
  contract: {
    stop: { primary: 'converged' | 'no-progress' };
    ceilings: {
      maxIterations?: number;
      maxSpendUsd?: number;
      maxRuntimeMs?: number;
      expiryIso?: string;
    };
    verify: { requireValidatorPass: boolean; requireComputerUseEvidence: boolean };
    permissions: RendererLoopPermission[];
    merge: { ownerGated: true; tokenRef?: string };
  };
  evidence: Record<string, unknown>;
  triggers?: RendererLoopTrigger[];
  // Builtin system loops (PRD §10): seeded, locked (no delete/edit/forge), and
  // run an in-process maintenance method via systemRunRef instead of the spine.
  builtin?: boolean;
  systemRunRef?: string;
  // Human schedule hint for a system loop (e.g. 'daily 04:00', 'hourly').
  schedule?: string;
  meta: { createdAtRef?: string; version: number };
}

export interface RendererLoopTrigger {
  id?: string;
  kind: 'schedule' | 'event';
  enabled: boolean;
  everyMs?: number;
  dailyAt?: string;
  event?: string;
}

export type RendererLoopSpecDraft = Partial<RendererLoopSpec> & {
  ownerApproved?: boolean;
  [key: string]: unknown;
};

export interface RendererLoopLockOnResult {
  spec?: RendererLoopSpec;
  errors?: string[];
}

export interface RendererLoopCompileResult {
  draft: RendererLoopSpecDraft;
  notes: string[];
}

export interface RendererLoopRunResult {
  invocationId: string;
  loopId: string;
  loopLineageId: string;
  finished: boolean;
  finishReason:
    | 'converged'
    | 'no-progress'
    | 'cap-hit'
    | 'blocked'
    | 'killed'
    | 'hard-cap'
    | 'spec-not-found'
    | 'error';
  reasonDetail: string;
  latestRunOutcome: RendererLoopStopState | null;
  iterations: Array<{
    index: number;
    runId: string;
    goal: string;
    classification: string;
    reason: string;
  }>;
}

export interface RendererLoopIteration {
  index: number;
  runId?: string;
  workerOutcome: string;
  workerDone: boolean;
  validatorOutcome: string;
  validatorDone: boolean;
  computerUseEvidence: boolean;
  prExists: boolean;
  merged: boolean;
  headSha: string | null;
  fixbackAttempts: number;
  tokens: number;
  spendUsd: number;
  stopState: RendererLoopStopState | null;
  madeProgress: boolean;
  artifactPath?: string;
  reportPath?: string;
}

export interface RendererLoopLineage {
  loopId: string;
  iterations: RendererLoopIteration[];
  iterationCount: number;
  totalSpendUsd: number;
  totalTokens: number;
  lastProgressAt: number | null;
  lastEvidence: RendererLoopIteration | null;
  latestRunOutcome: RendererLoopStopState | null;
  lastArtifactPath?: string;
  lastReportPath?: string;
}

export interface RendererLoopStatusResult {
  active: string[];
  inFlight: number;
  lineage?: RendererLoopLineage;
  lineages?: Record<string, RendererLoopLineage>;
  /** For a kind==='system' loop id: the matching scheduler state (no ledger fold). */
  system?: unknown;
}

export type SystemTool = {
  id: 'git' | 'node' | 'gh';
  label: string;
  description: string;
  kind: 'required' | 'recommended';
  found: boolean;
  // `ok` is found AND meets any version floor (e.g. node >= 20). For tools
  // without a version requirement, `found === ok`.
  ok: boolean;
  version: string | null;
  installHint: string | null;
  docsUrl: string | null;
  postInstallHint?: string | null;
  warnIfBelowMajor?: number | null;
};

export type CliStatus = {
  platform: string;
  supported: boolean;
  bundledPath: string;
  bundledExists: boolean;
  installPath: string | null;
  installDir: string | null;
  onPath: boolean;
  installed: boolean;
  installedPointsToBundle: boolean;
  existingTarget: string | null;
};

export type CliInstallResult = {
  ok: boolean;
  installPath?: string;
  bundledPath?: string;
  error?: string;
  conflict?: boolean;
  existingTarget?: string;
  notInstalled?: boolean;
};

export type RefreshDefaultBranchResult = {
  projectId: string;
  refreshed: boolean;
  defaultBranch: string | null;
  remoteDefaultBranch: string | null;
  behindBy: number;
  threshold: number;
  skipped?: 'remote-workspace';
};

export type WorkspaceBaseBranchResult = {
  projectId: string;
  preferredBaseBranch: string | null;
  defaultBranch: string | null;
  effectiveBaseBranch: string;
  effectiveBase?: {
    input: string;
    canonical: string;
    kind: 'remote' | 'local';
    remote: string | null;
    branch: string;
    ref: string;
    checkoutRef: string;
  };
};

type DesktopMethod =
  | 'getState'
  | 'seedState'
  | 'perfHealth'
  | 'perfRecord'
  | 'opsStatus'
  | 'opsSignals'
  | 'opsRecommendations'
  | 'opsBrief'
  | 'opsIntel'
  | 'opsTodosList'
  | 'opsTodoCreate'
  | 'opsTodoUpdate'
  | 'opsTodoRemove'
  | 'opsTodoDigest'
  | 'opsTodoSynthesize'
  | 'opsSourcesGet'
  | 'opsSourcesUpdate'
  | 'opsRefresh'
  | 'opsSourceState'
  | 'opsWikiGraph'
  | 'opsWikiPage'
  | 'opsWikiReveal'
  | 'knowledgeSearch'
  | 'knowledgeGet'
  | 'knowledgeReindex'
  | 'knowledgeStatus'
  | 'knowledgeOverview'
  | 'knowledgeNightlyStatus'
  | 'knowledgeQuarantineList'
  | 'knowledgeQuarantineResolve'
  | 'opsBriefSchedule'
  | 'opsBriefGenerate'
  | 'runBoard'
  | 'teamTicketsList'
  | 'teamTicketsSave'
  | 'teamTicketsDelete'
  | 'teamTicketsSearch'
  | 'teamTicketsGet'
  | 'teamTicketsAgents'
  | 'teamTicketsLaunch'
  | 'loopsList'
  | 'loopsGet'
  | 'loopsCompile'
  | 'loopsLockOn'
  | 'loopsSave'
  | 'loopsRun'
  | 'loopsStop'
  | 'loopsRemove'
  | 'loopsStatus'
  | 'loopsSelect'
  | 'loopsKillAll'
  | 'pickDirectory'
  | 'openFolder'
  | 'browseLocalDir'
  | 'importWorkspace'
  | 'importRemoteWorkspace'
  | 'listRemoteHosts'
  | 'listRemoteDir'
  | 'createRemoteDir'
  | 'removeWorkspace'
  | 'initializeWorkspace'
  | 'refreshWorkspace'
  | 'projectsRefreshDefaultBranch'
  | 'projectsSetBaseBranch'
  | 'projectsGetEffectiveBaseBranch'
  | 'getWorkspaceStats'
  | 'listTrackedGithubProjects'
  | 'deleteBranch'
  | 'openExternal'
  | 'cloneWorkspace'
  | 'createTask'
  | 'createThread'
  | 'startHermesOrchestrator'
  | 'startOrchestrator'
  | 'setAlwaysOnOrchestrator'
  | 'listAgentLanes'
  | 'listHermesProfiles'
  | 'listOrchestratorTemplates'
  | 'createAgentLane'
  | 'getOrCreatePersonalWorkspace'
  | 'getOrCreatePersonalIdentityWorkspace'
  | 'deleteTask'
  | 'archiveTask'
  | 'unarchiveTask'
  | 'reorderWorkspaces'
  | 'reorderTasksInWorkspace'
  | 'setTaskAutoApprove'
  | 'getTaskSpec'
  | 'createConversation'
  | 'closeConversation'
  | 'activateConversation'
  | 'listScratchTabs'
  | 'saveScratchTabs'
  | 'browserRegisterWebview'
  | 'browserUnregisterWebview'
  | 'browserStop'
  | 'browserList'
  | 'browserOpen'
  | 'browserActivate'
  | 'browserNavigate'
  | 'browserInfo'
  | 'browserScreenshot'
  | 'browserClick'
  | 'browserType'
  | 'browserKey'
  | 'browserScroll'
  | 'browserEval'
  | 'browserCdp'
  | 'browserWaitFor'
  | 'browserElements'
  | 'browserConsole'
  | 'browserInspectRef'
  | 'browserClickRef'
  | 'browserTypeRef'
  | 'browserSkillsList'
  | 'browserSkillsRead'
  | 'browserStreamOpen'
  | 'browserStreamClose'
  | 'browserStreamInput'
  | 'browserStreamNavigate'
  | 'browserStreamResize'
  | 'listEditorOpenFiles'
  | 'saveEditorOpenFiles'
  | 'ensureWorkItemSession'
  | 'ensureVariantSession'
  | 'ensureStreamStarted'
  | 'killShellStream'
  | 'getStreamSnapshot'
  | 'getTerminalSync'
  | 'createWorktree'
  | 'deleteWorktree'
  | 'attachVariant'
  | 'removeVariant'
  | 'reorderVariants'
  | 'reorderConversations'
  | 'broadcastToVariants'
  | 'writeTerminalInput'
  | 'resizeTerminal'
  | 'pasteClipboardImage'
  | 'pasteClipboardImageRemote'
  | 'gitStatus'
  | 'gitLog'
  | 'gitShow'
  | 'gitShowFile'
  | 'gitDiffFile'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitStageAll'
  | 'gitUnstageAll'
  | 'gitCommit'
  | 'gitRevert'
  | 'gitReset'
  | 'gitPush'
  | 'gitCreatePR'
  | 'listTaskFiles'
  | 'readTaskFile'
  | 'searchFiles'
  | 'searchFileContent'
  | 'writeTaskFile'
  | 'createTaskFile'
  | 'createTaskFolder'
  | 'renameTaskPath'
  | 'deleteTaskPath'
  | 'restoreFromTrash'
  | 'revealTaskPath'
  | 'listWorkspaceFiles'
  | 'readWorkspaceFile'
  | 'writeWorkspaceFile'
  | 'createWorkspaceFile'
  | 'createWorkspaceFolder'
  | 'renameWorkspacePath'
  | 'deleteWorkspacePath'
  | 'revealWorkspacePath'
  | 'getAgentCatalog'
  | 'getSystemTools'
  | 'startInstallAgent'
  | 'cliGetStatus'
  | 'cliInstall'
  | 'cliUninstall'
  | 'operatorsList'
  | 'operatorsSave'
  | 'dataRootGet'
  | 'dataRootSet'
  | 'relaunch'
  | 'hermesDesktopStatus'
  | 'hermesDesktopSetSurface'
  | 'hermesDesktopEnsure'
  | 'hermesDesktopStop'
  | 'hermesDesktopGetActiveProfile'
  | 'hermesDesktopSetActiveProfile'
  | 'hermesDesktopHomeSessionRestore'
  | 'hermesDesktopCronHomeDeliverySync'
  | 'hermesUpdateApply'
  | 'telemetryQuery'
  | 'opsPulse'
  | 'getStarredAgents'
  | 'setAgentStarred'
  | 'remoteGetStatus'
  | 'remoteSetEnabled'
  | 'remoteSetTunnelMode'
  | 'remoteDetectTunnels'
  | 'remoteMintEnrollment'
  | 'remoteListDevices'
  | 'remoteRevokeDevice'
  | 'skillsGetCatalog'
  | 'skillsRefreshCatalog'
  | 'skillsGetDetail'
  | 'skillsSearch'
  | 'skillsInstall'
  | 'skillsUninstall'
  | 'skillsCreate'
  | 'skillsDetectedAgents'
  | 'mcpLoadAll'
  | 'mcpSaveServer'
  | 'mcpRemoveServer'
  | 'mcpGetProviders'
  | 'usageGetProviders'
  | 'streamList'
  | 'streamReadScreen'
  | 'streamGetState'
  | 'streamSendInput'
  | 'streamSendKeys'
  | 'streamSubmit'
  | 'streamSendSubmit'
  | 'streamAbort'
  | 'streamAsk'
  | 'streamSlash'
  | 'streamRef'
  | 'streamApprove'
  | 'streamInterrupt'
  | 'streamWaitFor'
  | 'streamSpawn'
  | 'streamClose'
  | 'streamRename'
  | 'streamRecordStart'
  | 'streamRecordStop'
  | 'streamReplay'
  | 'streamFollow'
  | 'streamSnapshot'
  | 'streamProfiles'
  | 'streamReloadProfiles'
  | 'streamTranscript'
  | 'githubIsAvailable'
  | 'githubRefreshAvailability'
  | 'githubListAccounts'
  | 'githubSwitchAccount'
  | 'githubLoginStart'
  | 'githubLoginPoll'
  | 'githubLoginCancel'
  | 'githubRemoveAccount'
  | 'githubListRepos'
  | 'githubListStars'
  | 'githubListTrending'
  | 'githubCloneRepo'
  | 'githubFetchContributions'
  | 'githubStarRepo'
  | 'githubUnstarRepo'
  | 'integrationPush'
  | 'integrationOpenPr'
  | 'integrationPollChecks'
  | 'integrationGate'
  | 'integrationMergePr'
  | 'integrationCleanup'
  | 'runtimeState';

export type IntegrationAction =
  | 'push'
  | 'openPr'
  | 'pollChecks'
  | 'gatePr'
  | 'mergePr'
  | 'deleteBranch'
  | 'cleanup';

export type IntegrationEnvelope = {
  ok: boolean;
  phase: 'success' | 'failure' | 'pass' | 'blocked';
  action: IntegrationAction;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  durationMs: number;
  timestamp: number;
};


export type TerminalSyncPayload = {
  streamId: string;
  state: string;
  seq: number;
  cols: number;
  rows: number;
};

export type StreamState =
  | 'booting'
  | 'awaiting-input'
  | 'busy'
  | 'awaiting-approval'
  | 'turn-complete'
  | 'interrupted'
  | 'error'
  | 'unknown';

export type StreamEntry = {
  streamId: string;
  agent: string | null;
  cwd: string | null;
  label: string | null;
  state: StreamState;
  profile: string;
  // DB linkage + liveness from the control-plane catalog (listStreams in
  // electron/ace-control/index.cts). Optional: older payloads omit them.
  taskId?: string | null;
  workspaceId?: string | null;
  live?: boolean;
};

export type StreamWaitPredicate = {
  state?: StreamState;
  turnComplete?: boolean;
  awaitingInput?: boolean;
  awaitingApproval?: boolean;
  pattern?: string;
  quietForMs?: number;
};

export type StreamEventPayload = {
  event: string;
  payload: Record<string, unknown>;
};

export type TranscriptEntryBase = { id: number; lifecycle: 'open' | 'finished'; tAt: number };
export type TranscriptToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'canceled';
export type TranscriptEntry =
  | (TranscriptEntryBase & { role: 'user'; text: string })
  | (TranscriptEntryBase & {
      role: 'agent';
      text: string;
      model?: string;
      tokens?: { input?: number; output?: number; total?: number };
      phase?: string;
    })
  | (TranscriptEntryBase & { role: 'reasoning'; text: string; subject?: string })
  | (TranscriptEntryBase & {
      role: 'communication';
      direction: 'sent' | 'received';
      command: string;
      body: string;
      peerLabel?: string;
      peerAgent?: string;
      peerStreamId?: string;
      redacted?: boolean;
      truncated?: boolean;
    })
  | (TranscriptEntryBase & {
      role: 'tool';
      name: string;
      args?: unknown;
      result?: unknown;
      status: TranscriptToolStatus;
      turnId?: string;
      callId?: string;
    })
  | (TranscriptEntryBase & {
      role: 'approval';
      prompt: string;
      context: string;
      status: 'pending' | 'approved' | 'denied';
    })
  | (TranscriptEntryBase & {
      role: 'system';
      subtype:
        | 'session_start'
        | 'session_end'
        | 'task_started'
        | 'turn_finished'
        | 'info'
        | 'error';
      text?: string;
    });

export type TranscriptSnapshot = {
  streamId: string;
  sessionId: string;
  sessionFile: string;
  agent: 'claude' | 'codex' | 'gemini' | 'hermes';
  entries: TranscriptEntry[];
  nextCursor: number;
  hasMoreBefore?: boolean;
  warnings: Array<{ code: string; error?: string; tAt: number }>;
};

export type TranscriptResetReason =
  | 'clear'
  | 'compact'
  | 'relink'
  | 'file-truncate'
  | 'alias-prune';

export type TranscriptResetPayload = {
  streamId: string;
  nextCursor: number;
  reason?: TranscriptResetReason;
};

export type TranscriptReplacePayload = {
  nextCursor: number;
  summary: TranscriptEntry;
  reason?: TranscriptResetReason;
};

export type TabChatAvailablePayload = {
  streamId: string;
  agent: string;
  sessionId: string;
  sessionFile: string;
};

export type BrowserControlStatus = {
  taskId: string;
  tabId: string;
  active: boolean;
  action?: string;
  cursor?: BrowserCursorSignal;
  stopped?: boolean;
  detached?: boolean;
  at?: string;
};

export type BrowserCursorSignal = {
  id: string;
  name: string;
  color: string;
  kind: 'click' | 'scroll' | 'type' | 'key';
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  key?: string;
};

export type BrowserUiRequest = {
  type: 'open' | 'activate' | 'navigate';
  taskId: string;
  tabId: string;
  url?: string;
  at?: string;
  source?: string;
};

// One frame/meta event from the desktop's offscreen browser host streaming a
// browser tab to this (remote) client. `image` is present on paint frames
// and absent on pure metadata updates (navigation, title).
export type BrowserStreamEvent = {
  taskId: string;
  tabId: string;
  seq: number;
  image?: string;
  width?: number;
  height?: number;
  dpr?: number;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
};

export type BrowserStreamViewport = { width: number; height: number; dpr: number };

export type BrowserStreamInputEvent =
  | { type: 'tap'; x: number; y: number; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

type DesktopBridge = {
  invoke: <T>(method: DesktopMethod, payload?: unknown) => Promise<T>;
  // Resolves a File object back to its absolute on-disk path in Electron
  // (via webUtils.getPathForFile). Returns '' for Blob-derived files (e.g.
  // clipboard images) and is undefined on non-Electron clients.
  getFilePath?: (file: File) => string;
  subscribe: (listener: (state: AceState) => void) => () => void;
  onPtyData: (listener: (payload: { id: string; chunk: string; seq?: number }) => void) => () => void;
  onPtyExit: (listener: (payload: { id: string; code: number | null }) => void) => () => void;
  onPtySync?: (listener: (payload: TerminalSyncPayload) => void) => () => void;
  sendPtySubscribe?: (streamId: string) => void;
  sendPtyUnsubscribe?: (streamId: string) => void;
  sendPtyRequestSync?: (streamId: string) => void;
  onGitChanged: (listener: (payload: { taskId: string }) => void) => () => void;
  onInstallData: (
    listener: (payload: { streamId: string; chunk: string }) => void
  ) => () => void;
  onInstallExit: (
    listener: (payload: { streamId: string; code: number | null }) => void
  ) => () => void;
  onRuntimeChanged?: (listener: (payload: RuntimeState) => void) => () => void;
  onUsageChanged?: (listener: (payload: ProviderUsageReport) => void) => () => void;
  onHermesDesktopEvent?: (listener: (payload: HermesDesktopEvent) => void) => () => void;
  onOpsIntelRefreshed?: (listener: (payload: OpsIntelRefreshedEvent) => void) => () => void;
  onOpsBriefDelivered?: (listener: (payload: OpsBriefDeliveredEvent) => void) => () => void;
  onStarredAgentsChanged: (
    listener: (payload: { starred: string[] }) => void
  ) => () => void;
  onRemoteStatusChanged?: (listener: (payload: RemoteStatus) => void) => () => void;
  onRemoteDevicesChanged?: (listener: (payload: RemoteDevice[]) => void) => () => void;
  reconnectWebSocket?: () => void;
  onStreamEvent?: (listener: (payload: StreamEventPayload) => void) => () => void;
  // Run-ledger append settle push (Electron preload only; remote clients fall
  // back to the board's 30s safety poll). Optional so a stale preload from a
  // mixed-version update never TypeErrors a newer renderer.
  onRunLedgerChanged?: (listener: (payload: { ts: number }) => void) => () => void;
  onBrowserControlStatus?: (listener: (payload: BrowserControlStatus) => void) => () => void;
  onBrowserUiRequest?: (listener: (payload: BrowserUiRequest) => void) => () => void;
  // Browser-tab streaming (remote clients only; the desktop renders real
  // <webview>s and never subscribes).
  onBrowserStreamEvent?: (listener: (payload: BrowserStreamEvent) => void) => () => void;
  sendBrowserSubscribe?: (taskId: string, tabId: string, viewport: BrowserStreamViewport) => void;
  sendBrowserUnsubscribe?: (taskId: string, tabId: string) => void;
};

export type RemoteStatus = {
  enabled: boolean;
  running: boolean;
  port: number;
  tunnelMode: 'loopback' | 'lan' | 'tailscale';
  lanHost: string | null;
  tailscaleHost: string | null;
  tailscaleHttpsReady?: boolean;
  tailscaleHttpsError?: string | null;
  primaryUrl: string;
  allowlist: string[];
  connectedClients: number;
};

export type RemoteDevice = {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
  revoked: boolean;
};

export type RemoteTunnelInfo = {
  id: 'tailscale';
  name: string;
  recommended: boolean;
  available: boolean;
  host: string | null;
  installUrl?: string;
};

export type RemoteEnrollmentPayload = {
  token: string;
  expiresAt: number;
  url: string;
  status: RemoteStatus;
};

let httpBridge: DesktopBridge | null = null;

function desktop(): DesktopBridge {
  if (typeof window === 'undefined') {
    throw new Error('Ace requires a window runtime.');
  }
  if (window.aceDesktop) return window.aceDesktop;
  if (!httpBridge) httpBridge = createHttpBridge();
  return httpBridge;
}

function invoke<T>(method: DesktopMethod, payload?: unknown) {
  return desktop().invoke<T>(method, payload);
}

function invokeTeamTickets<T>(method: DesktopMethod, payload?: unknown): Promise<T> {
  if (isRemoteClient()) return Promise.reject(new Error('Use the local desktop app to connect team boards and launch tickets.'));
  return invoke<T>(method, payload);
}

const TOKEN_STORAGE_KEY = 'ace.remoteToken';
const DEVICE_NAME_STORAGE_KEY = 'ace.remoteDeviceName';
type StateListener = (state: AceState) => void;

type BridgeListeners = {
  state: Set<StateListener>;
  ptyData: Set<(payload: { id: string; chunk: string; seq?: number }) => void>;
  ptyExit: Set<(payload: { id: string; code: number | null }) => void>;
  ptySync: Set<(payload: TerminalSyncPayload) => void>;
  gitChanged: Set<(payload: { taskId: string }) => void>;
  installData: Set<(payload: { streamId: string; chunk: string }) => void>;
  installExit: Set<(payload: { streamId: string; code: number | null }) => void>;
  starredChanged: Set<(payload: { starred: string[] }) => void>;
  hermesDesktopEvent: Set<(payload: HermesDesktopEvent) => void>;
  usageChanged: Set<(payload: ProviderUsageReport) => void>;
  streamEvent: Set<(payload: StreamEventPayload) => void>;
  browserControlStatus: Set<(payload: BrowserControlStatus) => void>;
  browserUiRequest: Set<(payload: BrowserUiRequest) => void>;
  browserStreamEvent: Set<(payload: BrowserStreamEvent) => void>;
};

function createBridgeListeners(): BridgeListeners {
  return {
    state: new Set(),
    ptyData: new Set(),
    ptyExit: new Set(),
    ptySync: new Set(),
    gitChanged: new Set(),
    installData: new Set(),
    installExit: new Set(),
    starredChanged: new Set(),
    hermesDesktopEvent: new Set(),
    usageChanged: new Set(),
    streamEvent: new Set(),
    browserControlStatus: new Set(),
    browserUiRequest: new Set(),
    browserStreamEvent: new Set(),
  };
}

export function remoteEnroll(input: {
  url: string;
  enrollmentToken: string;
  name?: string;
}): Promise<void> {
  const url = new URL('/enroll', input.url).toString();
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentToken: input.enrollmentToken,
      name: input.name || defaultDeviceName(),
    }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`enrollment failed: ${res.status}`);
    const data = (await res.json()) as { token: string; deviceId: string; name: string };
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    localStorage.setItem(DEVICE_NAME_STORAGE_KEY, data.name);
    remoteSetTokenCookie(data.token);
    httpBridge?.reconnectWebSocket?.();
  });
}

function remoteSetTokenCookie(token: string) {
  try {
    document.cookie = `${TOKEN_STORAGE_KEY}=${encodeURIComponent(token)}; max-age=34560000; path=/; SameSite=Strict`;
  } catch {}
}

function remoteClearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(DEVICE_NAME_STORAGE_KEY);
  
  try { document.cookie = `${TOKEN_STORAGE_KEY}=; max-age=0; path=/`; } catch {}
}

export function remoteGetToken(): string | null {
  
  try {
    const ls = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (ls) {
      remoteSetTokenCookie(ls);
      return ls;
    }
  } catch {}
  
  
  
  
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${TOKEN_STORAGE_KEY}=([^;]+)`)
    );
    if (match) {
      const token = decodeURIComponent(match[1]);
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
      return token;
    }
  } catch {}
  return null;
}

export function isRemoteClient(): boolean {
  return typeof window !== 'undefined' && !window.aceDesktop;
}

function defaultDeviceName(): string {
  try {
    const platform = navigator.platform || 'Browser';
    return `${platform} ${new Date().toLocaleDateString()}`;
  } catch {
    return 'Browser';
  }
}

type HttpBridge = DesktopBridge & {
  reconnectWebSocket(): void;
  sendPtySubscribe(streamId: string): void;
  sendPtyUnsubscribe(streamId: string): void;
  sendPtyRequestSync(streamId: string): void;
};

// Stream id that can never collide with a real one (real ids are prefixed
// variant:/conversation:/shell:). Subscribed on every socket open so the
// server's "no subscriptions → forward everything" fallback never applies to
// this client. Kept out of `subscribedStreams` so ensureSocketAlive still
// treats "no real streams" as the cheap fresh-connect probe.
const SENTINEL_STREAM_ID = 'sentinel:none';

function createHttpBridge(): HttpBridge {
  const listeners = createBridgeListeners();
  const origin = window.location.origin;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let healthTimer: number | null = null;
  let lastMessageAt = 0;
  const subscribedStreams = new Set<string>();
  const subscribedBrowserTabs = new Map<
    string,
    { taskId: string; tabId: string; viewport: BrowserStreamViewport }
  >();

  function connect() {
    const token = remoteGetToken();
    if (!token) return;
    try { ws?.close(); } catch {}
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    ws = new WebSocket(url, [`ace-token.${token}`]);
    ws.onopen = () => {
      // The server forwards EVERY stream's pty:data to a connection with zero
      // subscriptions (remote-server wireConnection only filters once the set
      // is non-empty). A phone parked on a non-terminal screen — Today,
      // Workspaces — would receive the combined live output of every running
      // agent as JSON frames over the tunnel, which floods the socket and
      // grinds the whole mobile app. Subscribing to a sentinel id no PTY can
      // ever match makes the set non-empty so the firehose is filtered
      // server-side from the first frame.
      wsSend({ type: 'pty:subscribe', streamId: SENTINEL_STREAM_ID });
      // Rebuild subscriptions after reconnect. The server pushes a pty:sync
      // snapshot per subscribe, so every terminal repaints with whatever
      // streamed while this client was disconnected.
      for (const streamId of subscribedStreams) {
        wsSend({ type: 'pty:subscribe', streamId });
      }
      for (const sub of subscribedBrowserTabs.values()) {
        wsSend({
          type: 'browser:subscribe',
          taskId: sub.taskId,
          tabId: sub.tabId,
          ...sub.viewport,
        });
      }
    };
    ws.onmessage = (ev) => {
      lastMessageAt = Date.now();
      try {
        const data = JSON.parse(ev.data);
        dispatch(data?.type, data?.payload);
      } catch {}
    };
    ws.onclose = () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 1500);
    };
    ws.onerror = () => {
      try { ws?.close(); } catch {}
    };
  }

  // Mobile browsers (iOS PWAs especially) suspend the page when backgrounded
  // and often leave the socket "OPEN" but dead — onclose never fires, so the
  // 1.5s reconnect loop never engages and every terminal silently freezes on
  // its pre-suspend frame. On wake, verify liveness: request fresh syncs for
  // the subscribed streams and force a reconnect if nothing answers.
  function ensureSocketAlive() {
    if (!remoteGetToken()) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connect();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) return;
    if (subscribedStreams.size === 0) {
      // No streams to probe with — a fresh socket is cheap and re-delivers
      // the state snapshot this client missed while suspended.
      connect();
      return;
    }
    const before = lastMessageAt;
    for (const streamId of subscribedStreams) {
      wsSend({ type: 'pty:requestSync', streamId });
    }
    if (healthTimer) window.clearTimeout(healthTimer);
    healthTimer = window.setTimeout(() => {
      healthTimer = null;
      if (lastMessageAt === before) connect();
    }, 2500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureSocketAlive();
  });
  window.addEventListener('online', () => ensureSocketAlive());
  window.addEventListener('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) ensureSocketAlive();
  });

  function dispatch(type: string, payload: unknown) {
    if (type === 'state') listeners.state.forEach((l) => l(payload as AceState));
    else if (type === 'pty:data') listeners.ptyData.forEach((l) => l(payload as { id: string; chunk: string; seq?: number }));
    else if (type === 'pty:exit') listeners.ptyExit.forEach((l) => l(payload as { id: string; code: number | null }));
    else if (type === 'pty:sync') listeners.ptySync.forEach((l) => l(payload as TerminalSyncPayload));
    else if (type === 'git:changed') listeners.gitChanged.forEach((l) => l(payload as { taskId: string }));
    else if (type === 'install:data') listeners.installData.forEach((l) => l(payload as { streamId: string; chunk: string }));
    else if (type === 'install:exit') listeners.installExit.forEach((l) => l(payload as { streamId: string; code: number | null }));
    else if (type === 'starred:changed') listeners.starredChanged.forEach((l) => l(payload as { starred: string[] }));
    else if (type === 'hermes-desktop:event') listeners.hermesDesktopEvent.forEach((l) => l(payload as HermesDesktopEvent));
    else if (type === 'usage:changed') listeners.usageChanged.forEach((l) => l(payload as ProviderUsageReport));
    else if (type === 'stream:event') listeners.streamEvent.forEach((l) => l(payload as StreamEventPayload));
    else if (type === 'browser:control-status') listeners.browserControlStatus.forEach((l) => l(payload as BrowserControlStatus));
    else if (type === 'browser:ui-request') listeners.browserUiRequest.forEach((l) => l(payload as BrowserUiRequest));
    else if (type === 'browser:frame') listeners.browserStreamEvent.forEach((l) => l(payload as BrowserStreamEvent));
  }

  function wsSend(msg: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  async function invokeHttp<T>(method: DesktopMethod, payload?: unknown): Promise<T> {
    const token = remoteGetToken();
    if (!token) {
      throw new Error('Ace remote client is not enrolled. Scan the QR from the desktop Settings → Remote Access panel.');
    }
    const res = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload ?? null),
    });
    // Even on non-ok, the server usually returns a JSON envelope with an error
    // message — surface that to the caller rather than a bare status code.
    let body: { ok: boolean; result?: T; error?: string } | null = null;
    try {
      body = (await res.json()) as { ok: boolean; result?: T; error?: string };
    } catch {
      // fall through
    }
    if (isRemoteCredentialRejection(res.status, body)) {
      remoteClearToken();
      throw new Error('Remote device token rejected. Re-enroll from the desktop.');
    }
    if (!res.ok) {
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    if (!body?.ok) throw new Error(body?.error || 'Remote request failed');
    return body.result as T;
  }

  
  const subscribe: DesktopBridge['subscribe'] = (listener) => {
    listeners.state.add(listener);
    if (!ws) connect();
    return () => { listeners.state.delete(listener); };
  };
  const add = <K extends keyof BridgeListeners>(key: K, fn: BridgeListeners[K] extends Set<infer U> ? U : never) => {
    (listeners[key] as Set<typeof fn>).add(fn);
    if (!ws) connect();
    return () => { (listeners[key] as Set<typeof fn>).delete(fn); };
  };

  return {
    invoke: invokeHttp,
    subscribe,
    onPtyData: (l) => add('ptyData', l),
    onPtyExit: (l) => add('ptyExit', l),
    onPtySync: (l) => add('ptySync', l),
    onGitChanged: (l) => add('gitChanged', l),
    onInstallData: (l) => add('installData', l),
    onInstallExit: (l) => add('installExit', l),
    onStarredAgentsChanged: (l) => add('starredChanged', l),
    onHermesDesktopEvent: (l) => add('hermesDesktopEvent', l),
    onUsageChanged: (l) => add('usageChanged', l),
    onStreamEvent: (l) => add('streamEvent', l),
    onBrowserControlStatus: (l) => add('browserControlStatus', l),
    onBrowserUiRequest: (l) => add('browserUiRequest', l),
    onBrowserStreamEvent: (l) => add('browserStreamEvent', l),
    sendBrowserSubscribe: (taskId: string, tabId: string, viewport: BrowserStreamViewport) => {
      subscribedBrowserTabs.set(`${taskId}\n${tabId}`, { taskId, tabId, viewport });
      wsSend({ type: 'browser:subscribe', taskId, tabId, ...viewport });
    },
    sendBrowserUnsubscribe: (taskId: string, tabId: string) => {
      subscribedBrowserTabs.delete(`${taskId}\n${tabId}`);
      wsSend({ type: 'browser:unsubscribe', taskId, tabId });
    },
    reconnectWebSocket: connect,
    // `scrollback` tells the server how many scrollback rows this client
    // actually keeps, so reattach snapshots aren't serialized (and shipped
    // over the tunnel, and re-parsed on the phone) at the server's full
    // buffer depth. Older servers ignore the extra field.
    sendPtySubscribe: (streamId: string) => {
      subscribedStreams.add(streamId);
      wsSend({ type: 'pty:subscribe', streamId, scrollback: clientTerminalScrollback() });
    },
    sendPtyUnsubscribe: (streamId: string) => {
      subscribedStreams.delete(streamId);
      wsSend({ type: 'pty:unsubscribe', streamId });
    },
    sendPtyRequestSync: (streamId: string) =>
      wsSend({ type: 'pty:requestSync', streamId, scrollback: clientTerminalScrollback() }),
  };
}

type CreateResult = { id: string };
type WorktreeCreateResult = { worktreeId: string | null; variantId: string | null };
type VariantResult = { variantId: string | null };
type SessionResult = { sessionId: string | null };
type TerminalMutationResult = { ok: boolean };

// Per-stream ordered write queue for remote clients. Each queue holds the
// not-yet-sent bytes plus the resolvers of every enqueued call; one pump loop
// per stream drains it, sending at most one HTTP request at a time so writes
// can never reorder, and coalescing whatever accumulated during the previous
// round-trip into the next single request.
type RemoteTerminalWriteQueue = {
  buffer: string;
  waiters: Array<(result: TerminalMutationResult) => void>;
  flushing: boolean;
};
const remoteTerminalWriteQueues = new Map<string, RemoteTerminalWriteQueue>();

function enqueueRemoteTerminalWrite(
  streamId: string,
  data: string
): Promise<TerminalMutationResult> {
  let queue = remoteTerminalWriteQueues.get(streamId);
  if (!queue) {
    queue = { buffer: '', waiters: [], flushing: false };
    remoteTerminalWriteQueues.set(streamId, queue);
  }
  queue.buffer += data;
  return new Promise<TerminalMutationResult>((resolve) => {
    queue.waiters.push(resolve);
    void pumpRemoteTerminalWrites(streamId, queue);
  });
}

async function pumpRemoteTerminalWrites(streamId: string, queue: RemoteTerminalWriteQueue) {
  if (queue.flushing) return;
  queue.flushing = true;
  try {
    while (queue.buffer.length > 0) {
      const data = queue.buffer;
      const waiters = queue.waiters;
      queue.buffer = '';
      queue.waiters = [];
      let result: TerminalMutationResult;
      try {
        result = await invoke<TerminalMutationResult>('writeTerminalInput', { streamId, data });
      } catch {
        // Never leave callers hanging or wedge the queue on a failed request —
        // report not-ok and keep draining whatever queued since.
        result = { ok: false };
      }
      for (const resolve of waiters) resolve(result);
    }
  } finally {
    queue.flushing = false;
  }
}
type PickDirectoryInput = {
  title?: string;
  message?: string;
  buttonLabel?: string;
  defaultPath?: string;
  createDirectory?: boolean;
};
type PickDirectoryResult = { path: string | null };
export type WorkspaceStatsFile = { path: string; bytes: number; loc: number };
export type WorkspaceStatsDirRow = { dir: string; files: number; bytes: number; loc: number };
export type WorkspaceStatsDetail = {
  totals: { files: number; bytes: number; loc: number };
  topByBytes: WorkspaceStatsFile[];
  topByLoc: WorkspaceStatsFile[];
  byDir: WorkspaceStatsDirRow[];
  skipped: { binaryExt: number; binaryNull: number };
  remote?: boolean;
};

export type TrackedGithubProject = {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string | null;
  isRemote: boolean;
  githubRepo: string;
  githubUrl: string;
  defaultBranch: string;
  wikiPath: string | null;
  wikiExists: boolean;
  activeTasks: Array<{
    id: string;
    name: string;
    branch: string;
    status: string;
    agent: string;
    prNumber?: number;
    prStatus?: string;
  }>;
  openPrs: OpenPr[];
};

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type FileChangeRow = {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
};

export type GitScope = { taskId: string } | { workspaceId: string };

export type GitStatusResult = {
  staged: FileChangeRow[];
  unstaged: FileChangeRow[];
  totals: { additions: number; deletions: number };
  branch: string | null;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  githubRepo: string | null;
};
export type GitCommit = {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  parents: string[];
};
type GitLogResult = { commits: GitCommit[] };

export type GitCommitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
export type GitCommitFileChange = {
  path: string;
  oldPath: string | null;
  status: GitCommitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};
export type GitCommitDetail = {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  subject: string;
  body: string;
  files: GitCommitFileChange[];
};
export type FsEntry = {
  name: string;
  kind: 'file' | 'dir';
  relativePath: string;
};
type ListFilesResult = { entries: FsEntry[] };

export type FileSearchScope =
  | { taskId: string; workspaceId?: never }
  | { workspaceId: string; taskId?: never };

export type ContentSearchMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type ContentSearchOptions = {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
};

export type ProviderUsageMeter = {
  tokens: number | null;
  limit: number | null;
  /** Server-reported utilization 0–100, or null when no live data exists. */
  percent: number | null;
  windowMinutes: number;
  resetsAt: number | null;
};
export type ProviderUsageState = 'live' | 'stale' | 'unknown';
export type ProviderUsage = {
  id: 'claude' | 'codex';
  name: string;
  plan: string | null;
  accountLabel: string | null;
  state: ProviderUsageState;
  /** When the rate-limit snapshot was captured (ms epoch), null if none. */
  asOf: number | null;
  session: ProviderUsageMeter;
  weekly: ProviderUsageMeter;
  lastActivityMs: number | null;
};
export type ProviderUsageReport = {
  providers: ProviderUsage[];
  generatedAt: number;
  enabled?: boolean;
  reason?: 'disabled';
};
// ---------------------------------------------------------------------------
// Operations Cockpit result types — mirror the frozen contracts
// (docs/ops/operations-cockpit-contracts.md). Field names are load-bearing.
// ---------------------------------------------------------------------------

export type OpsSeverity = 'green' | 'yellow' | 'red' | 'black';

// ace.ops.health-finding.v1 (§2)
export type OpsHealthFinding = {
  $schema: 'ace.ops.health-finding.v1';
  id: string;
  category: 'runtime' | 'fd' | 'db' | 'service' | 'ci';
  severity: OpsSeverity;
  status: 'ok' | 'degraded' | 'fail' | 'unknown' | 'skipped' | 'setup-required';
  title: string;
  message: string;
  evidence: {
    source: 'ace-cli' | 'ace-electron' | 'daily-agent';
    path: string | null;
    command: string | null;
    lastChecked: string;
    freshness: 'live' | 'fresh' | 'stale' | 'expired' | null;
    ageSeconds: number | null;
  };
  recommendedAction: string | null;
  confidence: number;
  isLive: boolean;
  details: Record<string, unknown>;
};

// ace.ops.status.v1 (§3)
export type OpsStatusResult = {
  schema: 'ace.ops.status.v1';
  timestamp: string;
  workspaceId: string | null;
  configPath: string;
  rollup: {
    severity: OpsSeverity;
    green: number;
    yellow: number;
    red: number;
    black: number;
    counts: Record<string, string>;
  };
  findings: OpsHealthFinding[];
  warnings: string[];
};

// VectorOpsSignal — derived-on-read union of wiki/raw/* + findings >= yellow (§7).
export type OpsSignal = {
  id: string;
  source: 'vector-ops' | 'ace-electron' | 'ace-cli' | 'daily-agent';
  severity: OpsSeverity;
  title: string;
  message: string;
  path: string | null;
  lastChecked: string | null;
  isLive: boolean;
};

// ace.ops.recommendation.v1 (§4). The derived list omits optional blocks
// (evidence[], candidateMissionDraft) until the daily-agent synthesis lands.
export type OpsRecommendation = {
  $schema?: 'ace.ops.recommendation.v1';
  id: string;
  decision: 'do' | 'defer' | 'ignore' | 'ask';
  title: string;
  reason: string;
  evidence?: Array<{
    source: 'ace-cli' | 'ace-electron' | 'daily-agent' | 'vector-ops';
    path: string | null;
    findingId: string | null;
    lastChecked: string;
  }>;
  /** Operator id (see src/lib/operators.ts) or the reserved 'shared'. */
  owner: string | null;
  nextAction: string;
  risk: 'low' | 'medium' | 'high';
  severity: OpsSeverity;
  confidence: number;
  candidateMissionDraft?: {
    workspaceId: string;
    name: string;
    summary: string;
    source: 'vector-ops';
    statusNote: string;
    nextAction: string;
  } | null;
};

// ---------------------------------------------------------------------------
// Ops Pulse (ace.ops.pulse.v1) — per-project signals + a ranked rule-based
// next step (electron/ops-pulse.cts). Read-only/derived; display + suggest
// only (dispatch actions are P2). Every signal block degrades independently
// via { ok, error } so one dead source never blanks a project card.
// ---------------------------------------------------------------------------

export type OpsPulseSuggestion = {
  id: string;
  score: number;
  severity: OpsSeverity;
  title: string;
  reason: string;
  action: string;
};

export type OpsPulseProject = {
  workspaceId: string;
  name: string;
  githubRepo: string | null;
  isRemote: boolean;
  health: OpsSeverity;
  git: {
    ok: boolean;
    error: string | null;
    commits: number;
    lastCommitAt: string | null;
    activeDays: number;
    daily: Array<{ day: string; commits: number }>;
  };
  prs: {
    ok: boolean;
    error: string | null;
    open: number;
    drafts: number;
    awaitingReview: number;
    ciFailing: number;
    merged: number;
    awaitingReviewNumbers: number[];
    ciFailingNumbers: number[];
    items: Array<{
      number: number;
      title: string;
      url: string | null;
      isDraft: boolean;
      reviewDecision: string | null;
      ciFailing: boolean;
      updatedAt: string | null;
    }>;
  };
  missions: {
    cards: number;
    inProgress: number;
    readyToReview: number;
    blocked: number;
    ready: number;
    staleReady: number;
    readyNames: string[];
  };
  agents: { activeTasks: number; busy: number; agents: string[] };
  telemetry: {
    ok: boolean;
    error: string | null;
    events: number;
    errors: number;
    errorRate: number;
    tokensIn: number;
    tokensOut: number;
    dispatches: number;
  };
  suggestions: OpsPulseSuggestion[];
  nextStep: OpsPulseSuggestion | null;
};

export type OpsPulseResult = {
  schema: 'ace.ops.pulse.v1';
  timestamp: string;
  days: number;
  projects: OpsPulseProject[];
  opsFindings: { yellow: number; red: number; black: number; titles: string[] };
};

// ---------------------------------------------------------------------------
// Operations Command Center v2 contracts (docs/ops/prd/ops-command-center-v2.prd.md).
// All four are additive to the frozen v1 contracts; field names are load-bearing.
// ---------------------------------------------------------------------------

// ace.ops.brief.v1 — a lens-differentiated Rook brief distilled from
// latest.json (intel) + live mission/ops state. Never fabricates freshness.
export type OpsBriefLens = 'morning' | 'midday' | 'evening';
export type OpsBrief = {
  $schema: 'ace.ops.brief.v1';
  lens: OpsBriefLens;
  generatedAt: string;
  intelAsOf: string | null;
  // 12h/24h tiers: fresh (<12h), stale (12-24h, yellow), expired (>24h, red).
  sourceFreshness: 'fresh' | 'stale' | 'expired' | 'missing';
  headline: string;
  sections: Array<{
    title: string;
    items: Array<{ text: string; url?: string | null; why?: string | null; move?: string | null }>;
  }>;
  deltaSummary: string;
  candidateCount: number;
};

// ace:ops-brief-schedule — slot schedule + last/next run status (G3).
export type OpsBriefScheduleSlot = {
  lens: string;
  hour: number;
  minute: number;
  nextRunAt: string;
  lastDeliveredAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastPath: string | null;
};
export type OpsBriefSchedule = { slots: OpsBriefScheduleSlot[]; todayPath?: string | null };

// ace.ops.todo.v1 — Chief's intake item. Dev items can promote to a Mission
// Board candidate; non-dev items stay assignable without forcing a code mission.
export type OpsTodoKind = 'dev' | 'life' | 'company' | 'unclassified';
export type OpsTodoStatus = 'open' | 'assigned' | 'promoted' | 'done';
export type OpsTodoPriority = 'low' | 'medium' | 'high';
export type OpsTodo = {
  $schema: 'ace.ops.todo.v1';
  id: string;
  text: string;
  kind: OpsTodoKind;
  owner: string | null;
  status: OpsTodoStatus;
  createdAt: string;
  updatedAt: string;
  promotedMissionId: string | null;
  // ops-v2 H3 intake fields — all nullable; legacy records normalize to null.
  notes: string | null;
  source: string | null;
  workspaceId: string | null;
  priority: OpsTodoPriority | null;
  dueAt: string | null;
  // D8: one-tap tags — explicit + auto-extracted #hashtags (lowercased,
  // deduped, '#' stripped; the hashtags stay in the text). Legacy records
  // normalize to [].
  tags: string[];
};

// ace.ops.todo-digest.v1 — twice-daily rule-based synthesis over the open
// todo set (D9). "Auto-organized proposals" ONLY: deterministic grouping,
// outcome restatements and next-step suggestions — never AI judgment, and
// nothing is auto-promoted.
export type OpsTodoDigestSlot = 'morning' | 'night';
export type OpsTodoDigest = {
  $schema: 'ace.ops.todo-digest.v1';
  slot: OpsTodoDigestSlot;
  generatedAt: string;
  openCount: number;
  groups: Array<{ label: string; todoIds: string[] }>;
  goals: Array<{ text: string; todoIds: string[] }>;
  suggestions: Array<{ todoId: string; text: string; suggestion: string }>;
  markdown: string;
  // Provenance of the goals/suggestions — 'rules' = deterministic (default and
  // fail-closed fallback), 'agent' = a headless agent refined them. Optional so
  // digests persisted before this field normalize to rule-based in the UI.
  source?: 'agent' | 'rules';
};

// ace.ops.sources.v1 — editable watchlist of what Vector Ops watches. Seed
// values are read from latest.json source fields; edits persist to local config,
// never to source code.
export type OpsSources = {
  $schema: 'ace.ops.sources.v1';
  watchlists: {
    feeds: string[];
    accounts: string[];
    repos: string[];
    changelogs: string[];
  };
  editableAt: string | null;
  fromLatestJson: boolean;
  // S3: per-source refresh state rides along (additive to the frozen v1 fields).
  refresh?: OpsSourceState;
};

// ace.ops.source-state.v1 — per-source refresh state persisted by the
// ops-refresh engine (ops-source-state.json + ops-refresh.ndjson). Honest
// states only: lastSuccess advances solely on success, never fabricated.
export type OpsSourceStatus = 'ok' | 'error' | 'auth-needed' | 'unavailable';
export interface OpsRefreshSource {
  id: string;
  class: string;
  label: string;
  status: OpsSourceStatus;
  lastAttempt: string | null;
  lastSuccess: string | null;
  error: string | null;
  itemCount: number | null;
}
export interface OpsSourceState {
  sources: OpsRefreshSource[];
  lastRunAt: string | null;
  lastTrigger: string | null;
}

// ace:ops-refresh result — one refresh run over the whole source registry.
export type OpsRefreshResult = {
  at: string | null;
  trigger: string;
  lens: string | null;
  sources: OpsRefreshSource[];
  localIntelPath?: string | null;
  error?: string;
};

// ace:ops-intel-refreshed broadcast — emitted after every refresh run.
export type OpsIntelRefreshedEvent = {
  at: string | null;
  trigger: string;
  lens: string | null;
  ok: number;
  failed: number;
};

// ace:ops-brief-delivered broadcast — emitted when a brief is delivered.
export type OpsBriefDeliveredEvent = {
  lens: OpsBriefLens;
  brief: OpsBrief;
  path: string | null;
  todayPath?: string | null;
  todayWritten?: boolean;
  todayError?: string | null;
};

// ace.ops.wiki-graph.v1 — Obsidian-style graph of ~/wiki/ace-ops.
// Edges derive from [[wikilinks]]; freshness/provenance/confidence are derived
// heuristically (no structured frontmatter exists) and labeled as such.
export type OpsWikiNode = {
  id: string;
  path: string;
  title: string;
  tags: string[];
  updatedAt: string | null;
  freshness: 'fresh' | 'stale' | 'expired' | 'unknown';
  // Knowledge-plane trust tier (frontmatter trust, else vault-path inference —
  // same rules as the knowledge index, so graph color == search tier).
  trust: 'canon' | 'working' | 'raw' | 'external';
  provenance: 'distilled' | 'raw' | 'mixed';
  confidence: number;
  confidenceBasis: 'heuristic';
  backlinks: number;
  // First ~240 chars of body, frontmatter/markdown stripped (hover summaries).
  excerpt: string;
};

// ace:ops-wiki-page — traversal-safe page read for the wiki viewer (I2).
export type OpsWikiPage =
  | {
      ok: true;
      relPath: string;
      title: string;
      content: string;
      mtime: string;
      sizeBytes: number;
      excerpt: string;
    }
  | { ok: false; error: 'invalid-args' | 'path-escape' | 'not-markdown' | 'not-found' | 'read-error' };
export type OpsWikiGraph = {
  $schema: 'ace.ops.wiki-graph.v1';
  generatedAt: string;
  root: string;
  nodes: OpsWikiNode[];
  edges: Array<{ from: string; to: string }>;
  stats: { nodeCount: number; edgeCount: number; orphanCount: number };
};

// Knowledge plane (AceMemorySearchResult/v1 family) — the unified FTS5
// index over the ops wiki, project wikis, dumps, candidates, ledgers, and
// read-only Hermes memories.
export type KnowledgeTrust = 'canon' | 'working' | 'raw' | 'external';
export type KnowledgeHit = {
  path: string;
  relPath: string;
  source: string;
  project: string | null;
  title: string;
  kind: string;
  trust: KnowledgeTrust;
  tags: string[];
  updatedAt: string | null;
  freshness: 'fresh' | 'stale' | 'expired' | 'unknown';
  decay: number;
  decayReasons: string[];
  excerpt: string;
  score: number;
};
export type KnowledgeSearchResult = {
  ok: boolean;
  schema?: string;
  query?: string;
  total?: number;
  results?: KnowledgeHit[];
  error?: string;
};
export type KnowledgeEntry = {
  ok: boolean;
  schema?: string;
  path?: string;
  sizeBytes?: number;
  mtime?: string;
  truncated?: boolean;
  body?: string;
  error?: string;
};
export type KnowledgeStatus = {
  ok: boolean;
  dbPath?: string;
  total?: number;
  byTrust?: Array<{ trust: string; n: number }>;
  bySource?: Array<{ source: string; n: number }>;
  wikiRoot?: string;
  error?: string;
};
export type KnowledgeNightlyRun = {
  schema: 'AceKnowledgeNightlyRun/v1';
  at: string;
  status: 'ok' | 'error';
  error?: string | null;
  findings?: number | null;
  proposals?: number | null;
  quarantined?: number | null;
  indexedDocs?: number | null;
  curatedProjects?: number | null;
  reportPath?: string | null;
};
export type KnowledgeNightlyStatus = {
  ok: boolean;
  state?: KnowledgeNightlyRun | null;
  history?: KnowledgeNightlyRun[];
  disabled?: boolean;
  curator?: { enabled: boolean; workspaceId: string | null; agent: string };
  error?: string;
};
export type KnowledgeOverview = {
  ok: boolean;
  total?: number;
  byTrust?: Array<{ trust: string; n: number }>;
  bySource?: Array<{ source: string; n: number }>;
  agents?: Array<{ identity: string; project: string | null; docs: number; lastAt: string | null }>;
  hermes?: Array<{ workspace: string; docs: number; lastAt: string | null }>;
  candidates?: Array<{ project: string; docs: number; lastAt: string | null }>;
  byProject?: Array<{ project: string; docs: number; lastAt: string | null }>;
  recentRuns?: Array<{ title: string; path: string; relPath: string; project: string | null; updatedAt: string | null }>;
  recentJournal?: Array<{ title: string; path: string; relPath: string; updatedAt: string | null }>;
  wikiRoot?: string;
  error?: string;
};
export type KnowledgeQuarantineItem = {
  path: string;
  sidecarPath: string;
  originalPath: string | null;
  reason: string;
  quarantinedAt: string | null;
};

// AceWikiHealth/v1 — wiki/knowledge health metrics for the Wiki tab health
// panel (single-sourced by electron/harness/knowledge-contract.summarizeWikiHealth).
export type OpsWikiHealth = {
  schema: 'AceWikiHealth/v1';
  generatedAt: string;
  severity: 'green' | 'amber' | 'black';
  healthy: boolean;
  projectsTotal: number;
  dumpOnlyCount: number;
  dumpOnlyProjects: string[];
  canonPages: number;
  dumpRecords: number;
  stalePages: number;
  sourceCoverage: number;
  rawVsCanonRatio: number | null;
  indexTotal: number | null;
  canonDocs: number;
  rawDocs: number;
  lastNightlyAt: string | null;
  lastNightlyStatus: string;
  indexFreshness: string;
  candidatesAccepted: number;
  candidatesRejected: number;
  inboxPending: number;
  flags: string[];
};

// ace.ops.intel.v1 — the FULL Vector Ops dashboard, normalized. Powers the
// Vector Ops tab so it mirrors everything the external dashboard surfaces.
export type OpsIntelItem = {
  id: string;
  title: string;
  summary: string;
  url: string | null;
  source: string | null;
  meta: string | null;
  // Structured source-provided timestamp (ISO); null when the source carried
  // none — never fabricated (R3).
  timestamp: string | null;
  isNew: boolean;
  score: number | null;
  handle: string | null;
  why: string | null;
  move: string | null;
};
export type OpsIntelSection = {
  key: string;
  title: string;
  items: OpsIntelItem[];
  // S3: per-section merge provenance + freshness/source-state (R4).
  provenance: 'intel-report' | 'live-pull' | 'agent';
  asOf: string | null;
  freshness: 'fresh' | 'stale' | 'expired';
  status: OpsSourceStatus | null;
  statusMessage: string | null;
  lastAttempt: string | null;
  lastSuccess: string | null;
};
export type OpsIntelProjectFit = {
  project: string;
  priority: string;
  fit: string;
  why: string;
  moves: string[];
  missionTemplate: string;
};
export type OpsIntelPrice = {
  id: string;
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  marketState: string | null;
};
export type OpsIntel = {
  $schema: 'ace.ops.intel.v1';
  generatedAt: string | null;
  // 12h/24h tiers: fresh (<12h), stale (12-24h, yellow), expired (>24h, red).
  sourceFreshness: 'fresh' | 'stale' | 'expired' | 'missing';
  // S3: newest per-source lastSuccess across the refresh registry, or null
  // when no refresh has ever succeeded.
  lastRefreshAt: string | null;
  executiveSummary: string;
  operatorTake: string;
  newCount: number;
  seenItemsTotal: number;
  sections: OpsIntelSection[];
  projectFit: OpsIntelProjectFit[];
  projectMoves: { facts: string[]; suggestions: string[] };
  hotAiApp: OpsIntelItem | null;
  prices: OpsIntelPrice[];
};

export type OpsQuery = { workspaceId?: string | null };

/** Summary of the boot-time external-data-root resolution (main process). */
export type DataRootSummary = {
  root: string | null;
  active: boolean;
  source: string | null;
  reason: string | null;
  configuredRoot: string | null;
};

/** Result of ace:operators-list (electron/operators.cts loadOperatorsConfig). */
export type OperatorsLoadResult = {
  config: OperatorsConfig;
  source: 'file' | 'bak' | 'default';
};

// ── Hermes Desktop surface (electron/hermes-dashboard.cts) ──────────────────

export type HermesSurface = 'lanes' | 'dashboard';

/** Contents of <userData>/hermes-surface.json; absent file = these defaults. */
export type HermesSurfaceConfig = {
  version: 1;
  defaultSurface: HermesSurface;
  workspaceOverrides: Record<string, HermesSurface>;
  dashboard: {
    host: string;
    extraArgs: string[];
    desktopAppPath: string | null;
  };
};

/** One managed dashboard sidecar. Never carries the session token or URL. */
export type HermesDashboardInfo = {
  ownerKey: string;
  home: string | null;
  kind?: 'home' | 'app';
  remotePath?: string | null;
  host: string | null;
  port: number | null;
  pid: number | null;
  status: 'starting' | 'running' | 'exited';
  startedAt: number | null;
  restarts: number;
  lastExit: { code: number; at: number } | null;
  error: string | null;
};

export type HermesDesktopStatus = {
  surface: HermesSurface;
  config: HermesSurfaceConfig;
  dashboards: HermesDashboardInfo[];
};

/**
 * ensure() is the only call that returns the dashboard URL. The served page
 * embeds the per-spawn session token, so treat the URL as secret-equivalent:
 * hand it straight to the webview and never log or persist it.
 */
export type HermesDesktopEnsureResult =
  | {
      ok: true;
      url: string;
      remotePath?: string | null;
      host: string;
      port: number;
      home: string | null;
      ownerKey: string;
      preloadPath?: string | null;
      preloadUrl?: string | null;
      desktopAppPath?: string | null;
      desktopAppVersion?: string | null;
      /**
       * 'desktop' = the packaged Hermes bundle over file:// with its preload.
       * 'web' = no bundle installed, so the sidecar serves its own web UI and
       * every desktopApp/preload field above is null. The bundle is an opt-in
       * build on Windows, so 'web' is the normal case there.
       */
      surface?: 'desktop' | 'web';
      dashboardUrl?: string | null;
      baseUrl?: string | null;
      wsUrl?: string | null;
      authMode?: 'oauth' | 'token';
      mode?: 'local' | 'remote';
      source?: 'env' | 'local' | 'settings';
    }
  | { ok: false; error: string; home?: string | null; ownerKey?: string };

export type HermesDesktopActiveProfileResult = {
  profile: string | null;
};

export type HermesDesktopSetProfileResult = {
  profile: string | null;
  changed: boolean;
};

// Canonical home-chat restore (ace:hermes-desktop-home-restore). sessionId is
// the explicit picked session id (never a resume token); script is the
// cold-start-only seed script the pane runs inside the embed frame. Both are
// null when no eligible home session exists (fresh install boots blank).
export type HermesHomeRestoreResult = {
  sessionId: string | null;
  script: string | null;
};

// Exactly-once cron → home-chat delivery sweep
// (ace:hermes-desktop-cron-home-sync).
export type HermesCronHomeSyncResult = {
  ok: boolean;
  delivered: { jobId: string; runId: string; sessionId: string }[];
  skipped: number;
  sessionId?: string;
  unsupported?: boolean;
  /** True when a sweep hit a defensive enumeration ceiling — coverage was
   *  truncated, never silently complete. */
  partial?: boolean;
  /** True when the sweep was short-circuited against a backend already known
   *  to lack the append capability. */
  suppressed?: boolean;
  reason?: string;
};

// Result of the one-button safe "Update Hermes" (ace:hermes-update-apply).
// On failure, `reason` is one of conflict/patch-guard/fetch/ff/rebuild/etc.;
// the checkout is always left in a safe, non-clobbered state.
export type HermesUpdateApplyResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  branch?: string;
  previousHead?: string;
  updatedHead?: string;
  rebuilt?: boolean;
};

// Sanitized result of the narrow Hermes sidecar restart (manager stop+ensure
// behind ace:hermes-desktop-restart) — never the embed URL or token.
export type HermesDesktopRestartResult = {
  ok: boolean;
  ownerKey: string;
  status?: string;
  pid?: number | null;
  error?: string;
};

// ── Telemetry spine (electron/telemetry.cts, ace.telemetry.v1) ──────────
// Append-only operational event log. Events are redacted at write time;
// aggregates are derived on read.
export type TelemetryEvent = {
  ts: number;
  type: string;
  project: string | null;
  agent: string | null;
  lane: string | null;
  mission: string | null;
  stream: string | null;
  source: string | null;
  severity: 'debug' | 'info' | 'warn' | 'error';
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  ok: boolean | null;
  errorClass: string | null;
  meta: Record<string, unknown> | null;
};
export type TelemetryFilters = {
  sinceMs?: number;
  untilMs?: number;
  type?: string;
  project?: string;
  agent?: string;
  lane?: string;
  mission?: string;
  stream?: string;
  source?: string;
  severity?: TelemetryEvent['severity'];
  errorClass?: string;
  ok?: boolean;
  limit?: number;
};
export type TelemetryGroupBy =
  | 'type'
  | 'project'
  | 'agent'
  | 'lane'
  | 'mission'
  | 'stream'
  | 'source'
  | 'severity'
  | 'errorClass';
export type TelemetryQueryResult = {
  schema: 'ace.telemetry.v1';
  ok: boolean;
  total: number;
  events: TelemetryEvent[];
  error: string | null;
};
export type TelemetryAggregateRow = {
  key: string;
  count: number;
  errors: number;
  avgDurationMs: number | null;
  tokensIn: number;
  tokensOut: number;
};
export type TelemetryAggregateResult = {
  schema: 'ace.telemetry.v1';
  ok: boolean;
  groupBy: TelemetryGroupBy | null;
  rows: TelemetryAggregateRow[];
  error: string | null;
};

export type PerfHealthEvent = {
  kind: 'span' | 'spinner';
  source: string;
  name: string;
  durationMs: number;
  seq: number;
  at: number;
  meta?: Record<string, unknown>;
  component?: string;
  route?: string;
  trigger?: string;
  label?: string;
  previousContent?: boolean;
};
export type PerfRecordInput = Partial<PerfHealthEvent> & {
  kind: 'span' | 'spinner';
};
export type PerfHealthResult = {
  schema: 'ace.perf-health/v1';
  ok: boolean;
  generatedAt: string;
  thresholds: { slowSpanMs: number; longSpinnerMs: number };
  capacity: number;
  retained: number;
  counts: Record<string, number>;
  slowSpans: PerfHealthEvent[];
  longSpinners: PerfHealthEvent[];
  recent: PerfHealthEvent[];
};

export type HermesDesktopEvent = {
  type: 'started' | 'restarting' | 'exited' | 'stopped' | 'error' | 'config-changed' | 'guest-renderer-gone' | 'open-link';
  ownerKey?: string;
  home?: string | null;
  kind?: 'home' | 'app';
  remotePath?: string | null;
  host?: string | null;
  port?: number | null;
  pid?: number | null;
  status?: HermesDashboardInfo['status'];
  startedAt?: number | null;
  restarts?: number;
  lastExit?: { code: number; at: number } | null;
  error?: string | null;
  url?: string;
};

export type RuntimeState = { status: 'starting' | 'ready' | 'boot-error'; reason?: string };

export const aceApi = {
  teamTickets: {
    listConnections: () => invokeTeamTickets<TeamTicketConnection[]>('teamTicketsList'),
    saveConnection: (input: TeamTicketConnectionInput) => invokeTeamTickets<TeamTicketConnection>('teamTicketsSave', input),
    deleteConnection: (id: string) => invokeTeamTickets<{ deleted: boolean }>('teamTicketsDelete', { id }),
    searchTickets: (input: TeamTicketSearchInput) => invokeTeamTickets<TeamTicketSearchResult>('teamTicketsSearch', input),
    getTicket: (input: TeamTicketGetInput) => invokeTeamTickets<TeamTicketPreview>('teamTicketsGet', input),
    getLaunchAgents: () => invokeTeamTickets<AgentCatalogEntry[]>('teamTicketsAgents'),
    launch: (input: TeamTicketLaunchInput) => invokeTeamTickets<{ taskId: string; promptDelivered: boolean }>('teamTicketsLaunch', input),
  },
  core: {
    getState: () => invoke<AceState>('getState'),
    subscribe: (listener: (state: AceState) => void) => desktop().subscribe(listener),
    onPtyData: (listener: (payload: { id: string; chunk: string; seq?: number }) => void) =>
      desktop().onPtyData(listener),
    onPtyExit: (listener: (payload: { id: string; code: number | null }) => void) =>
      desktop().onPtyExit(listener),
    onPtySync: (listener: (payload: TerminalSyncPayload) => void) => {
      const d = desktop();
      return d.onPtySync ? d.onPtySync(listener) : () => {};
    },
    sendPtySubscribe: (streamId: string) => desktop().sendPtySubscribe?.(streamId),
    sendPtyUnsubscribe: (streamId: string) => desktop().sendPtyUnsubscribe?.(streamId),
    sendPtyRequestSync: (streamId: string) => desktop().sendPtyRequestSync?.(streamId),
    onGitChanged: (listener: (payload: { taskId: string }) => void) =>
      desktop().onGitChanged(listener),
    // Run-ledger changed push — no-op unsubscribe when the bridge lacks the
    // channel (remote WS client, or an older preload), where the board's
    // existing subscriptions + safety poll still apply.
    onRunLedgerChanged: (listener: (payload: { ts: number }) => void) => {
      const d = desktop();
      return d.onRunLedgerChanged ? d.onRunLedgerChanged(listener) : () => {};
    },
  },
  perf: {
    health: () => invoke<PerfHealthResult>('perfHealth', {}),
    record: (event: PerfRecordInput) => invoke<{ ok: true }>('perfRecord', event),
  },
  ops: {
    // Live CLI/IPC probe run → ace.ops.status.v1. Reaches the SAME store
    // method the `ace ops status` CLI calls (contracts §7) — one probe impl.
    status: (query?: OpsQuery) => invoke<OpsStatusResult>('opsStatus', query ?? {}),
    // Derived-on-read union of wiki/raw/* + findings >= yellow (§7).
    signals: (query?: OpsQuery) => invoke<OpsSignal[]>('opsSignals', query ?? {}),
    // Daily-agent synthesis + ranked findings (§7).
    recommendations: (query?: OpsQuery) =>
      invoke<OpsRecommendation[]>('opsRecommendations', query ?? {}),
    // L4: per-project signals + ranked rule-based next step (Pulse panel).
    pulse: () => invoke<OpsPulseResult>('opsPulse', {}),
    // ops-v2 W1: lens-differentiated Rook brief distilled from latest.json.
    brief: (input?: { lens?: OpsBriefLens; now?: number }) =>
      invoke<OpsBrief>('opsBrief', input ?? {}),
    // ops-v2: the FULL Vector Ops dashboard (all latest.json sections).
    intel: () => invoke<OpsIntel>('opsIntel', {}),
    // ops-v2 G3/G5: slot schedule status + manual "Generate brief now".
    briefSchedule: () => invoke<OpsBriefSchedule>('opsBriefSchedule', {}),
    briefGenerate: (input?: { lens?: OpsBriefLens; now?: number }) =>
      invoke<{ delivered: boolean; skipped?: boolean; reason?: string; lens: OpsBriefLens; path?: string | null; todayPath?: string | null; todayWritten?: boolean; todayError?: string | null; brief?: OpsBrief }>(
        'opsBriefGenerate',
        input ?? {}
      ),
    // ops-v2 W6: Chief's todo intake (dev todos promote to candidates).
    todos: {
      list: () => invoke<OpsTodo[]>('opsTodosList', {}),
      create: (input: {
        text: string;
        kind?: OpsTodoKind;
        owner?: string | null;
        notes?: string | null;
        source?: string | null;
        workspaceId?: string | null;
        priority?: OpsTodoPriority | null;
        dueAt?: string | null;
        tags?: string[];
      }) => invoke<OpsTodo | null>('opsTodoCreate', input),
      update: (input: {
        id: string;
        patch: Partial<
          Pick<
            OpsTodo,
            | 'text'
            | 'kind'
            | 'owner'
            | 'status'
            | 'promotedMissionId'
            | 'notes'
            | 'source'
            | 'workspaceId'
            | 'priority'
            | 'dueAt'
            | 'tags'
          >
        >;
      }) => invoke<OpsTodo | null>('opsTodoUpdate', input),
      remove: (input: { id: string }) => invoke<boolean>('opsTodoRemove', input),
      // D9: latest twice-daily digest (null until the first synthesis runs)
      // + manual "Synthesize now". Slot defaults by local clock in the main
      // process when omitted.
      digest: () => invoke<OpsTodoDigest | null>('opsTodoDigest', {}),
      synthesize: (slot?: OpsTodoDigestSlot) =>
        invoke<OpsTodoDigest>('opsTodoSynthesize', slot ? { slot } : {}),
    },
    // ops-v2 W7: editable Sources/watchlist (latest.json defaults + local edits).
    sources: {
      get: () => invoke<OpsSources>('opsSourcesGet', {}),
      update: (input: { watchlists: OpsSources['watchlists'] }) =>
        invoke<OpsSources>('opsSourcesUpdate', input),
    },
    // S3: manual refresh of every registry source (never rejects in the main).
    refresh: (input?: { lens?: OpsBriefLens; trigger?: string }) =>
      invoke<OpsRefreshResult>('opsRefresh', input ?? {}),
    // S3: persisted per-source lastAttempt/lastSuccess state snapshot.
    sourceState: () => invoke<OpsSourceState>('opsSourceState', {}),
    // S3: push event after every refresh run (no-op off-desktop, like updates.onEvent).
    onIntelRefreshed: (listener: (payload: OpsIntelRefreshedEvent) => void) => {
      const d = desktop();
      return d.onOpsIntelRefreshed ? d.onOpsIntelRefreshed(listener) : () => {};
    },
    // S3: push event when a scheduled/manual brief is delivered.
    onBriefDelivered: (listener: (payload: OpsBriefDeliveredEvent) => void) => {
      const d = desktop();
      return d.onOpsBriefDelivered ? d.onOpsBriefDelivered(listener) : () => {};
    },
    // ops-v2 W8: Obsidian-style wiki graph (root from ACE_WIKI_ROOT or
    // ~/wiki/ace-ops — display graph.root, never hardcode).
    wikiGraph: () => invoke<OpsWikiGraph>('opsWikiGraph', {}),
    // LLM-wiki health: dump-only projects, raw-vs-canon, source coverage, last
    // nightly, index freshness (AceWikiHealth/v1). Same engine `ace wiki
    // health` uses so the Wiki tab and the CLI never split-brain.
    wikiHealth: () => invoke<OpsWikiHealth>('opsWikiHealth', {}),
    // ops-v2 I2/I9: traversal-safe page read + reveal-in-Finder.
    wikiPage: (input: { relPath: string }) => invoke<OpsWikiPage>('opsWikiPage', input),
    wikiReveal: (input: { relPath: string }) =>
      invoke<{ ok: boolean; error?: string }>('opsWikiReveal', input),
  },
  // Knowledge plane: unified FTS5 search + nightly audit + quarantine review.
  // Same engine the ace CLI uses (`ace memory search`).
  knowledge: {
    search: (input: {
      query: string;
      project?: string | null;
      tier?: string | null;
      kind?: string | null;
      tags?: string[];
      limit?: number;
      includeDecayed?: boolean;
    }) => invoke<KnowledgeSearchResult>('knowledgeSearch', input),
    get: (input: { path: string }) => invoke<KnowledgeEntry>('knowledgeGet', input),
    reindex: () => invoke<{ ok: boolean; indexed?: number; removed?: number; scanned?: number }>('knowledgeReindex', {}),
    status: () => invoke<KnowledgeStatus>('knowledgeStatus', {}),
    overview: () => invoke<KnowledgeOverview>('knowledgeOverview', {}),
    nightlyStatus: () => invoke<KnowledgeNightlyStatus>('knowledgeNightlyStatus', {}),
    quarantineList: () => invoke<{ ok: boolean; items: KnowledgeQuarantineItem[] }>('knowledgeQuarantineList', {}),
    quarantineResolve: (input: { path: string; action: 'approve' | 'reject' }) =>
      invoke<{ ok: boolean; action?: string; restoredTo?: string; movedTo?: string; error?: string }>(
        'knowledgeQuarantineResolve',
        input
      ),
  },
  missions: {
    // The mission domain was deleted in the run-ledger spine cutover. The only
    // surviving read is the LEAN, READ-ONLY run-ledger board (watcher, never a
    // gate): a pure projection over the event ledger of agent-keyed cards with
    // telemetry. Auto-refreshes through the existing state-changed / stream-event
    // subscriptions — no polling, zero agent tokens. The old create/dispatch/
    // sync/validate/gate/fixback/release/move/assign/board methods are gone;
    // re-add via spine intent when the lean board UI lands.
    runBoard: () => invoke<RunLedgerBoard>('runBoard'),
  },
  startup: {
    state: (): Promise<RuntimeState> => invoke<RuntimeState>('runtimeState', {}),
    onChanged: (listener: (payload: RuntimeState) => void) => {
      const d = desktop();
      return d.onRuntimeChanged ? d.onRuntimeChanged(listener) : () => {};
    },
  },
  // Loops subsystem (additive limb over the run-ledger spine; PRD §6). Mirrors the
  // window.ace.loops.* surface: definition reads (list/get/lockOn/save) plus
  // run control (run/stop/status/killAll). Each iteration a loop fires is a real
  // run on the SAME ledger (visible in the run board); merge stays owner-gated.
  loops: {
    list: () => invoke<RendererLoopSpec[]>('loopsList'),
    get: (input: { id: string }) => invoke<RendererLoopSpec | null>('loopsGet', input),
    compile: (input: { text: string }) =>
      invoke<RendererLoopCompileResult>('loopsCompile', input),
    lockOn: (input: { draft: RendererLoopSpecDraft }) =>
      invoke<RendererLoopLockOnResult>('loopsLockOn', input),
    save: (input: { spec: RendererLoopSpec }) => invoke<RendererLoopSpec>('loopsSave', input),
    run: (input: { loopId: string; inputs?: Record<string, unknown> }) =>
      invoke<RendererLoopRunResult>('loopsRun', input),
    stop: (input: { invocationId: string }) =>
      invoke<{ stopped: boolean }>('loopsStop', input),
    remove: (input: { id: string }) =>
      invoke<{ removed: boolean }>('loopsRemove', input),
    status: (input?: { id?: string | null }) =>
      invoke<RendererLoopStatusResult>('loopsStatus', input ?? {}),
    select: (input: { description: string }) =>
      invoke<{ loopId: string | null; score: number; ranked: Array<{ loopId: string; score: number }> }>(
        'loopsSelect',
        input,
      ),
    killAll: () => invoke<{ ok: true }>('loopsKillAll'),
  },
  agentLanes: {
    list: () => invoke<AgentLane[]>('listAgentLanes'),
    listHermesProfiles: () => invoke<HermesProfileSummary[]>('listHermesProfiles'),
    listOrchestratorTemplates: () =>
      invoke<{
        native: OrchestratorTemplate[];
        hermesProfiles: HermesProfileSummary[];
        templates: OrchestratorTemplate[];
      }>('listOrchestratorTemplates'),
    create: (input: CreateAgentLaneInput) => invoke<AgentLane>('createAgentLane', input),
  },
  workspaces: {
    pickDirectory: (input: PickDirectoryInput) =>
      invoke<PickDirectoryResult>('pickDirectory', input),
    openFolder: (folderPath: string) =>
      invoke<{ ok: boolean }>('openFolder', { path: folderPath }),
    browseLocalDir: (dirPath?: string) =>
      invoke<{
        path: string;
        home: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
        hasGit: boolean;
      }>('browseLocalDir', { dirPath }),
    importWorkspace: (workspacePath: string) =>
      invoke<CreateResult>('importWorkspace', { workspacePath }),
    importRemoteWorkspace: (
      sshHost: string,
      remotePath: string,
      options?: { agentUser?: string | null; chownInPlace?: boolean }
    ) =>
      invoke<CreateResult>('importRemoteWorkspace', {
        sshHost,
        remotePath,
        agentUser: options?.agentUser ?? null,
        chownInPlace: options?.chownInPlace ?? false,
      }),
    listRemoteHosts: () =>
      invoke<{ hosts: Array<{ alias: string; host: string; user: string | null; port: number | null }> }>('listRemoteHosts'),
    listRemoteDir: (sshHost: string, path?: string, agentUser?: string | null) =>
      invoke<{
        path: string;
        home: string;
        parent: string | null;
        hasGit: boolean;
        entries: Array<{ name: string; kind: 'dir' }>;
      }>('listRemoteDir', { sshHost, path, agentUser: agentUser ?? null }),
    createRemoteDir: (sshHost: string, path: string, agentUser?: string | null) =>
      invoke<{ ok: boolean }>('createRemoteDir', {
        sshHost,
        path,
        agentUser: agentUser ?? null,
      }),
    removeWorkspace: (workspaceId: string) =>
      invoke<void>('removeWorkspace', { workspaceId }),
    initializeWorkspace: (workspaceId: string) =>
      invoke<void>('initializeWorkspace', { workspaceId }),
    refreshWorkspace: (workspaceId: string) =>
      invoke<void>('refreshWorkspace', { workspaceId }),
    refreshDefaultBranch: (workspaceId: string) =>
      invoke<RefreshDefaultBranchResult>('projectsRefreshDefaultBranch', {
        projectId: workspaceId,
      }),
    setBaseBranch: (workspaceId: string, branch: string) =>
      invoke<WorkspaceBaseBranchResult>('projectsSetBaseBranch', {
        projectId: workspaceId,
        branch,
      }),
    clearBaseBranch: (workspaceId: string) =>
      invoke<WorkspaceBaseBranchResult>('projectsSetBaseBranch', {
        projectId: workspaceId,
        clear: true,
      }),
    getEffectiveBaseBranch: (workspaceId: string) =>
      invoke<WorkspaceBaseBranchResult>('projectsGetEffectiveBaseBranch', {
        projectId: workspaceId,
      }),
    getStats: (scope: { kind: 'task' | 'workspace'; id: string }) =>
      invoke<{ files: number; bytes: number; loc: number; remote?: boolean }>(
        'getWorkspaceStats',
        scope
      ),
    getStatsDetail: (scope: { kind: 'task' | 'workspace'; id: string }) =>
      invoke<WorkspaceStatsDetail>('getWorkspaceStatsDetail', scope),
    listTrackedGithubProjects: () =>
      invoke<{ projects: TrackedGithubProject[] }>('listTrackedGithubProjects', {}),
    deleteBranch: (
      workspaceId: string,
      branch: string,
      options?: { deleteRemote?: boolean }
    ) =>
      invoke<void>('deleteBranch', {
        workspaceId,
        branch,
        deleteRemote: options?.deleteRemote ?? false,
      }),
    openExternal: (url: string, options?: { forceExternal?: boolean }) => {
      if (!options?.forceExternal && !isRemoteClient() && requestGithubBrowserOpen(url)) {
        return Promise.resolve({ ok: true });
      }
      if (isRemoteClient()) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve({ ok: true });
      }
      return invoke<{ ok: boolean }>('openExternal', { url });
    },
    cloneWorkspace: (repoUrl: string, localPath: string) =>
      invoke<CreateResult>('cloneWorkspace', { repoUrl, localPath }),
    createTask: (workspaceId: string, input: CreateWorkspaceTaskInput) =>
      invoke<CreateResult>('createTask', { workspaceId, input }),
    createThread: (workspaceId: string, input: CreateWorkspaceThreadInput) =>
      invoke<CreateResult>('createThread', { workspaceId, input }),
    startHermesOrchestrator: (workspaceId: string) =>
      invoke<{ taskId: string; reused?: boolean }>('startHermesOrchestrator', { workspaceId }),
    startOrchestrator: (workspaceId: string, agent: 'hermes' | 'claude' | 'codex') =>
      invoke<{ taskId: string; reused?: boolean; agent: string }>('startOrchestrator', {
        workspaceId,
        agent,
      }),
    setAlwaysOnOrchestrator: (
      workspaceId: string,
      enabled: boolean,
      agent?: 'hermes' | 'claude' | 'codex'
    ) =>
      invoke<{ workspaceId: string; enabled: boolean; agent: string | null }>(
        'setAlwaysOnOrchestrator',
        { workspaceId, enabled, agent }
      ),
    getOrCreatePersonalWorkspace: () =>
      invoke<{ workspaceId: string; taskId: string; agent: 'hermes' }>(
        'getOrCreatePersonalWorkspace',
        {}
      ),
    // identity is an operator id (see src/lib/operators.ts); legacy installs
    // carry 'rook'/'king'.
    getOrCreatePersonalIdentityWorkspace: (identity: string) =>
      invoke<{ workspaceId: string; taskId: string; agent: 'hermes'; identity: string }>(
        'getOrCreatePersonalIdentityWorkspace',
        { identity }
      ),
    deleteTask: (
      taskId: string,
      options?: {
        deleteLocalBranch?: boolean;
        deleteRemoteBranch?: boolean;
        removeWorktree?: boolean;
      }
    ) =>
      invoke<void>('deleteTask', {
        taskId,
        deleteLocalBranch: options?.deleteLocalBranch ?? true,
        deleteRemoteBranch: options?.deleteRemoteBranch ?? false,
        removeWorktree: options?.removeWorktree ?? true,
      }),
    archiveTask: (taskId: string) => invoke<void>('archiveTask', { taskId }),
    unarchiveTask: (taskId: string) => invoke<void>('unarchiveTask', { taskId }),
    reorderWorkspaces: (workspaceIds: string[]) =>
      invoke<{ ok: boolean }>('reorderWorkspaces', { workspaceIds }),
    reorderTasksInWorkspace: (workspaceId: string, taskIds: string[]) =>
      invoke<{ ok: boolean }>('reorderTasksInWorkspace', { workspaceId, taskIds }),
    setTaskAutoApprove: (taskId: string, autoApproveEnabled: boolean) =>
      invoke<{ autoApproveEnabled: boolean }>('setTaskAutoApprove', {
        taskId,
        autoApproveEnabled,
      }),
    getTaskSpec: (taskId: string) => invoke<TaskSpecResult>('getTaskSpec', { taskId }),
    searchFiles: (scope: FileSearchScope) =>
      invoke<{ files: string[] }>('searchFiles', scope),
  },
  sessions: {
    openConversation: (workItemId: string, agent?: string) =>
      invoke<CreateResult>('createConversation', { workItemId, agent }),
    closeConversation: (workItemId: string, conversationId: string) =>
      invoke<void>('closeConversation', { workItemId, conversationId }),
    activateConversation: (workItemId: string, conversationId: string) =>
      invoke<void>('activateConversation', { workItemId, conversationId }),
    ensureWorkItemSession: (workItemId: string, conversationId?: string) =>
      invoke<SessionResult>('ensureWorkItemSession', { workItemId, conversationId }),
    ensureVariantSession: (variantId: string) =>
      invoke<SessionResult>('ensureVariantSession', { variantId }),
    ensureStreamStarted: (streamId: string, cols: number, rows: number) => {
      const dims = sanitizeTerminalDimensions(cols, rows);
      return dims
        ? invoke<{ ok: boolean }>('ensureStreamStarted', { streamId, ...dims })
        : Promise.resolve({ ok: false });
    },
    killShellStream: (streamId: string) =>
      invoke<{ ok: boolean }>('killShellStream', { streamId }),
    getStreamSnapshot: (streamId: string) =>
      invoke<StreamSnapshot | null>('getStreamSnapshot', { streamId }),
    getTerminalSync: (streamId: string) =>
      invoke<TerminalSyncPayload | null>('getTerminalSync', { streamId }),
    listScratchTabs: (taskId: string) =>
      invoke<{
        tabs: Array<{
          id: string;
          kind: 'browser' | 'notes';
          title: string;
          url?: string;
          favicon?: string | null;
          content?: string;
          savedPath?: string | null;
          dirty?: boolean;
        }>;
        activeId: string | null;
      }>('listScratchTabs', { taskId }),
    saveScratchTabs: (
      taskId: string,
      tabs: Array<{
        id: string;
        kind: 'browser' | 'notes';
        title: string;
        url?: string;
        favicon?: string | null;
        content?: string;
        savedPath?: string | null;
        dirty?: boolean;
      }>,
      activeId: string | null
    ) => invoke<{ ok: boolean }>('saveScratchTabs', { taskId, tabs, activeId }),
    listEditorOpenFiles: (taskId: string) =>
      invoke<{ openFiles: string[]; activeFile: string | null }>('listEditorOpenFiles', {
        taskId,
      }),
    saveEditorOpenFiles: (
      taskId: string,
      openFiles: string[],
      activeFile: string | null
    ) => invoke<{ ok: boolean }>('saveEditorOpenFiles', { taskId, openFiles, activeFile }),
  },
  browser: {
    registerWebview: (input: { taskId: string; tabId: string; webContentsId: number }) =>
      invoke<{ ok: boolean }>('browserRegisterWebview', input),
    unregisterWebview: (input: { taskId: string; tabId: string; webContentsId?: number | null }) =>
      invoke<{ ok: boolean }>('browserUnregisterWebview', input),
    stop: (taskId: string, tabId: string) =>
      invoke<{ ok: boolean }>('browserStop', { taskId, tabId }),
    list: (taskId: string) => invoke<{ tabs: unknown[] }>('browserList', { taskId }),
    open: (input: { taskId: string; url?: string; activate?: boolean }) =>
      invoke<unknown>('browserOpen', input),
    activate: (taskId: string, tabId: string) =>
      invoke<unknown>('browserActivate', { taskId, tabId }),
    navigate: (input: { taskId: string; tabId: string; url: string; waitUntil?: string; timeoutMs?: number }) =>
      invoke<unknown>('browserNavigate', input),
    info: (taskId: string, tabId: string) =>
      invoke<unknown>('browserInfo', { taskId, tabId }),
    screenshot: (input: { taskId: string; tabId: string; outPath?: string; fullPage?: boolean; annotate?: boolean }) =>
      invoke<unknown>('browserScreenshot', input),
    click: (input: { taskId: string; tabId: string; x: number; y: number; button?: string; clickCount?: number }) =>
      invoke<unknown>('browserClick', input),
    type: (input: { taskId: string; tabId: string; text: string }) =>
      invoke<unknown>('browserType', input),
    key: (input: { taskId: string; tabId: string; key: string }) =>
      invoke<unknown>('browserKey', input),
    scroll: (input: { taskId: string; tabId: string; x?: number; y?: number; deltaX?: number; deltaY?: number }) =>
      invoke<unknown>('browserScroll', input),
    eval: (input: { taskId: string; tabId: string; script: string; timeoutMs?: number }) =>
      invoke<unknown>('browserEval', input),
    cdp: (input: { taskId: string; tabId: string; method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }) =>
      invoke<unknown>('browserCdp', input),
    waitFor: (input: { taskId: string; tabId: string; until: unknown; timeoutMs?: number }) =>
      invoke<unknown>('browserWaitFor', input),
    elements: (input: { taskId: string; tabId: string; visibleOnly?: boolean; limit?: number }) =>
      invoke<unknown>('browserElements', input),
    console: (input: { taskId: string; tabId: string; level?: string; limit?: number; sinceSeq?: number }) =>
      invoke<unknown>('browserConsole', input),
    inspectRef: (input: { taskId?: string; ref: string }) =>
      invoke<unknown>('browserInspectRef', input),
    clickRef: (input: { taskId?: string; ref: string }) =>
      invoke<unknown>('browserClickRef', input),
    typeRef: (input: { taskId?: string; ref: string; text: string; clear?: boolean }) =>
      invoke<unknown>('browserTypeRef', input),
    skillsList: (host: string) =>
      invoke<unknown>('browserSkillsList', { host }),
    skillsRead: (host: string) =>
      invoke<unknown>('browserSkillsRead', { host }),
    onControlStatus: (listener: (payload: BrowserControlStatus) => void) => {
      const d = desktop();
      return d.onBrowserControlStatus ? d.onBrowserControlStatus(listener) : () => {};
    },
    onUiRequest: (listener: (payload: BrowserUiRequest) => void) => {
      const d = desktop();
      return d.onBrowserUiRequest ? d.onBrowserUiRequest(listener) : () => {};
    },
    // Streamed browser tabs (remote clients). Subscribe/unsubscribe ride the
    // WS (per-connection screencast lifecycle); input and navigation are
    // ordinary request/response methods.
    streamSubscribe: (taskId: string, tabId: string, viewport: BrowserStreamViewport) => {
      desktop().sendBrowserSubscribe?.(taskId, tabId, viewport);
    },
    streamUnsubscribe: (taskId: string, tabId: string) => {
      desktop().sendBrowserUnsubscribe?.(taskId, tabId);
    },
    onStreamEvent: (listener: (payload: BrowserStreamEvent) => void) => {
      const d = desktop();
      return d.onBrowserStreamEvent ? d.onBrowserStreamEvent(listener) : () => {};
    },
    streamInput: (input: { taskId: string; tabId: string; events: BrowserStreamInputEvent[] }) =>
      invoke<{ ok: boolean; editable?: boolean }>('browserStreamInput', input),
    streamNavigate: (input: {
      taskId: string;
      tabId: string;
      url?: string;
      action?: 'back' | 'forward' | 'reload' | 'stop';
    }) => invoke<{ ok: boolean }>('browserStreamNavigate', input),
    streamResize: (input: { taskId: string; tabId: string } & BrowserStreamViewport) =>
      invoke<{ ok: boolean }>('browserStreamResize', input),
  },
  runtime: {
    createWorktree: (workItemId: string, input: CreateWorktreeInput) =>
      invoke<WorktreeCreateResult>('createWorktree', { workItemId, input }),
    deleteWorktree: (
      worktreeId: string,
      options?: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean }
    ) =>
      invoke<void>('deleteWorktree', {
        worktreeId,
        deleteLocalBranch: options?.deleteLocalBranch ?? true,
        deleteRemoteBranch: options?.deleteRemoteBranch ?? false,
      }),
    attachVariant: (workItemId: string, input: AttachVariantInput) =>
      invoke<VariantResult>('attachVariant', { workItemId, input }),
    removeVariant: (variantId: string) =>
      invoke<void>('removeVariant', { variantId }),
    reorderVariants: (worktreeId: string, variantIds: string[]) =>
      invoke<void>('reorderVariants', { worktreeId, variantIds }),
    reorderConversations: (taskId: string, conversationIds: string[]) =>
      invoke<void>('reorderConversations', { taskId, conversationIds }),
    broadcastToVariants: (input: BroadcastCommandInput) =>
      invoke<void>('broadcastToVariants', { input }),
    writeTerminalInput: (streamId: string, data: string) => {
      const safe = sanitizeTerminalInputPayload(data);
      if (safe === null) return Promise.resolve({ ok: false } as TerminalMutationResult);
      // Remote clients carry every write as its own HTTP POST with no ordering
      // guarantee — two keystrokes in flight at once can land swapped on the
      // server, which is exactly the scrambled-words corruption seen when
      // typing into the terminal from the phone ("wokrin", "extref ly"). The
      // desktop Electron IPC path is ordered and skips the queue. Queued
      // chunks coalesce into one write per round-trip, so burst typing over a
      // slow tunnel costs one request per RTT instead of one per character.
      if (!isRemoteClient()) {
        return invoke<TerminalMutationResult>('writeTerminalInput', { streamId, data: safe });
      }
      return enqueueRemoteTerminalWrite(streamId, safe);
    },
    resizeTerminal: (streamId: string, size: { cols: number; rows: number }) => {
      const dims = sanitizeTerminalDimensions(size.cols, size.rows);
      return dims
        ? invoke<TerminalMutationResult>('resizeTerminal', { streamId, ...dims })
        : Promise.resolve({ ok: false });
    },
    pasteClipboardImage: (bytes: string | Uint8Array, ext = 'png') =>
      invoke<{ path: string | null; error?: string }>('pasteClipboardImage', { bytes, ext }),
    pasteClipboardImageRemote: (taskId: string, bytes: string | Uint8Array, ext = 'png') =>
      invoke<{ path: string | null; error?: string }>('pasteClipboardImageRemote', { taskId, bytes, ext }),
  },
  git: {
    status: (scope: GitScope) => invoke<GitStatusResult>('gitStatus', scope),
    log: (scope: GitScope, limit = 30) =>
      invoke<GitLogResult>('gitLog', { ...scope, limit }),
    show: (scope: GitScope, hash: string) =>
      invoke<GitCommitDetail | null>('gitShow', { ...scope, hash }),
    showFile: (scope: GitScope, hash: string, path: string) =>
      invoke<{ diff: string; binary: boolean }>('gitShowFile', {
        ...scope,
        hash,
        path,
      }),
    diffFile: (scope: GitScope, path: string, staged: boolean) =>
      invoke<{ diff: string; binary: boolean }>('gitDiffFile', {
        ...scope,
        path,
        staged,
      }),
    stage: (scope: GitScope, paths: string[]) =>
      invoke<{ ok: boolean }>('gitStage', { ...scope, paths }),
    unstage: (scope: GitScope, paths: string[]) =>
      invoke<{ ok: boolean }>('gitUnstage', { ...scope, paths }),
    stageAll: (scope: GitScope) =>
      invoke<{ ok: boolean }>('gitStageAll', scope),
    unstageAll: (scope: GitScope) =>
      invoke<{ ok: boolean }>('gitUnstageAll', scope),
    commit: (scope: GitScope, message: string) =>
      invoke<{ hash: string; output: string }>('gitCommit', { ...scope, message }),
    revert: (scope: GitScope, hash: string) =>
      invoke<{ output: string }>('gitRevert', { ...scope, hash }),
    reset: (scope: GitScope, hash: string) =>
      invoke<{ output: string }>('gitReset', { ...scope, hash }),
    push: (scope: GitScope) => invoke<{ output: string }>('gitPush', scope),
    createPR: (scope: GitScope, title?: string, body?: string) =>
      invoke<{ url: string }>('gitCreatePR', { ...scope, title, body }),
  },
  fs: {
    listTaskFiles: (taskId: string, relativePath = '') =>
      invoke<ListFilesResult>('listTaskFiles', { taskId, relativePath }),
    readTaskFile: (taskId: string, relativePath: string) =>
      invoke<{ content: string }>('readTaskFile', { taskId, relativePath }),
    writeTaskFile: (taskId: string, relativePath: string, content: string) =>
      invoke<{ ok: boolean }>('writeTaskFile', { taskId, relativePath, content }),
    createTaskFile: (taskId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('createTaskFile', { taskId, relativePath }),
    createTaskFolder: (taskId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('createTaskFolder', { taskId, relativePath }),
    renameTaskPath: (taskId: string, relativePath: string, newName: string) =>
      invoke<{ ok: boolean }>('renameTaskPath', { taskId, relativePath, newName }),
    deleteTaskPath: (taskId: string, relativePath: string) =>
      invoke<{ ok: boolean; trashPath?: string | null; originalPath?: string }>(
        'deleteTaskPath',
        { taskId, relativePath }
      ),
    restoreFromTrash: (trashPath: string, originalPath: string) =>
      invoke<{ ok: boolean }>('restoreFromTrash', { trashPath, originalPath }),
    revealTaskPath: (taskId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('revealTaskPath', { taskId, relativePath }),
    
    
    listWorkspaceFiles: (workspaceId: string, relativePath = '') =>
      invoke<ListFilesResult>('listWorkspaceFiles', { workspaceId, relativePath }),
    readWorkspaceFile: (workspaceId: string, relativePath: string) =>
      invoke<{ content: string }>('readWorkspaceFile', { workspaceId, relativePath }),
    writeWorkspaceFile: (workspaceId: string, relativePath: string, content: string) =>
      invoke<{ ok: boolean }>('writeWorkspaceFile', { workspaceId, relativePath, content }),
    createWorkspaceFile: (workspaceId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('createWorkspaceFile', { workspaceId, relativePath }),
    createWorkspaceFolder: (workspaceId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('createWorkspaceFolder', { workspaceId, relativePath }),
    renameWorkspacePath: (workspaceId: string, relativePath: string, newName: string) =>
      invoke<{ ok: boolean }>('renameWorkspacePath', { workspaceId, relativePath, newName }),
    deleteWorkspacePath: (workspaceId: string, relativePath: string) =>
      invoke<{ ok: boolean; trashPath?: string | null; originalPath?: string }>(
        'deleteWorkspacePath',
        { workspaceId, relativePath }
      ),
    revealWorkspacePath: (workspaceId: string, relativePath: string) =>
      invoke<{ ok: boolean }>('revealWorkspacePath', { workspaceId, relativePath }),

    searchFiles: (scope: FileSearchScope) =>
      invoke<{ files: string[] }>('searchFiles', scope),
    searchFileContent: (scope: FileSearchScope, opts: ContentSearchOptions) =>
      invoke<{ matches: ContentSearchMatch[]; truncated: boolean }>(
        'searchFileContent',
        { ...scope, ...opts }
      ),
  },
  agents: {
    getCatalog: (scope?: { sshHost?: string | null; agentUser?: string | null }) =>
      invoke<AgentCatalogEntry[]>('getAgentCatalog', scope),
    getSystemTools: () => invoke<SystemTool[]>('getSystemTools'),
    startInstall: (params: {
      agentId: string;
      sshHost?: string | null;
      agentUser?: string | null;
    }) => invoke<{ streamId: string }>('startInstallAgent', params),
    onInstallData: (
      listener: (payload: { streamId: string; chunk: string }) => void
    ) => desktop().onInstallData(listener),
    onInstallExit: (
      listener: (payload: { streamId: string; code: number | null }) => void
    ) => desktop().onInstallExit(listener),
    getStarred: () => invoke<string[]>('getStarredAgents'),
    setStarred: (agentId: string, starred: boolean) =>
      invoke<{ starred: string[] }>('setAgentStarred', { agentId, starred }),
    onStarredChanged: (listener: (payload: { starred: string[] }) => void) =>
      desktop().onStarredAgentsChanged(listener),
  },
  cli: {
    getStatus: () => invoke<CliStatus>('cliGetStatus'),
    install: (opts?: { force?: boolean }) =>
      invoke<CliInstallResult>('cliInstall', opts ?? {}),
    uninstall: () => invoke<CliInstallResult>('cliUninstall'),
  },
  operators: {
    // Read-only load of <userData>/operators.json (plus provenance source);
    // the electron migration stays the single writer that creates the file.
    list: () => invoke<OperatorsLoadResult>('operatorsList'),
    save: (config: OperatorsConfig) =>
      invoke<{ ok: boolean }>('operatorsSave', { config }),
  },
  storage: {
    getDataRoot: () => invoke<DataRootSummary>('dataRootGet'),
    setDataRoot: (root: string) =>
      invoke<{ needsRelaunch: boolean }>('dataRootSet', { root }),
    relaunch: () => invoke<void>('relaunch'),
  },
  hermesDesktop: {
    getStatus: () => invoke<HermesDesktopStatus>('hermesDesktopStatus'),
    setSurface: (surface: HermesSurface) =>
      invoke<HermesDesktopStatus>('hermesDesktopSetSurface', { surface }),
    // The result URL is secret-equivalent (token embedded in the served
    // page): hand it to the webview, never log or persist it.
    ensure: (ownerKey?: string) =>
      invoke<HermesDesktopEnsureResult>('hermesDesktopEnsure', ownerKey ? { ownerKey } : {}),
    stop: (ownerKey?: string) =>
      invoke<{ ok: boolean; stopped: boolean | number }>(
        'hermesDesktopStop',
        ownerKey ? { ownerKey } : {}
      ),
    getActiveProfile: () =>
      invoke<HermesDesktopActiveProfileResult>('hermesDesktopGetActiveProfile'),
    setActiveProfile: (profile: string | null) =>
      invoke<HermesDesktopSetProfileResult>('hermesDesktopSetActiveProfile', { profile }),
    // Canonical home-chat restore for the resident bubble: resolves the
    // operator's home session by explicit id (cron/worker/test/maintenance and
    // other-profile sessions excluded) plus a cold-start-only seed script for
    // the embed frame. Never carries the embed URL or token.
    homeSessionRestore: (profile?: string | null) =>
      invoke<HermesHomeRestoreResult>(
        'hermesDesktopHomeSessionRestore',
        profile ? { profile } : {}
      ),
    // Exactly-once cron → home-chat delivery sweep (persistent claim ledger
    // in the main process; the sidecar stays the only state.db writer).
    cronHomeDeliverySync: (profile?: string | null) =>
      invoke<HermesCronHomeSyncResult>(
        'hermesDesktopCronHomeDeliverySync',
        profile ? { profile } : {}
      ),
    // Main → renderer lifecycle pushes (ace:hermes-desktop-event).
    // No-op off-desktop.
    onEvent: (listener: (payload: HermesDesktopEvent) => void) => {
      const d = desktop();
      return d.onHermesDesktopEvent ? d.onHermesDesktopEvent(listener) : () => {};
    },
    // One-button safe "Update Hermes" — branch-aware rebase of ace/patches
    // onto upstream + patch-guard + desktop rebuild (never reset --hard, never
    // clobbers patches). Long-running; the caller shows a busy state. Local
    // (host) action only.
    applyUpdate: (opts?: { rebuild?: boolean }) =>
      invoke<HermesUpdateApplyResult>('hermesUpdateApply', opts ?? {}),
    // Narrow restart for the Operations "Agent Control" panel — manager
    // stop()+ensure() in the main process; the sanitized result never carries
    // the embed URL or token. No ownerKey restarts the always-on app sidecar.
    restart: (ownerKey?: string) =>
      invoke<HermesDesktopRestartResult>('hermesDesktopRestart', ownerKey ? { ownerKey } : {}),
  },
  // Telemetry spine — read-only query/aggregate over the append-only
  // operational event log (ace:telemetry-query). Both calls share one
  // channel; aggregate sets kind: 'aggregate'.
  telemetry: {
    query: (filters?: TelemetryFilters) =>
      invoke<TelemetryQueryResult>('telemetryQuery', filters ?? {}),
    aggregate: (groupBy: TelemetryGroupBy, filters?: TelemetryFilters) =>
      invoke<TelemetryAggregateResult>('telemetryQuery', {
        ...(filters ?? {}),
        kind: 'aggregate',
        groupBy,
      }),
  },
  remote: {
    getStatus: () => invoke<RemoteStatus | null>('remoteGetStatus'),
    setEnabled: (enabled: boolean) =>
      invoke<RemoteStatus | null>('remoteSetEnabled', { enabled }),
    setTunnelMode: (mode: RemoteStatus['tunnelMode']) =>
      invoke<RemoteStatus | null>('remoteSetTunnelMode', { mode }),
    detectTunnels: () => invoke<RemoteTunnelInfo[]>('remoteDetectTunnels'),
    mintEnrollment: () => invoke<RemoteEnrollmentPayload | null>('remoteMintEnrollment'),
    listDevices: () => invoke<RemoteDevice[]>('remoteListDevices'),
    revokeDevice: (deviceId: string) =>
      invoke<RemoteDevice[]>('remoteRevokeDevice', { deviceId }),
    onStatusChanged: (listener: (payload: RemoteStatus) => void) => {
      const d = desktop();
      return d.onRemoteStatusChanged ? d.onRemoteStatusChanged(listener) : () => {};
    },
    onDevicesChanged: (listener: (payload: RemoteDevice[]) => void) => {
      const d = desktop();
      return d.onRemoteDevicesChanged ? d.onRemoteDevicesChanged(listener) : () => {};
    },

  },
  skills: {
    getCatalog: () => invoke<SkillsCatalog>('skillsGetCatalog'),
    refreshCatalog: () => invoke<SkillsCatalog>('skillsRefreshCatalog'),
    getDetail: (skillId: string, source?: { owner: string; repo: string }) =>
      invoke<Skill | null>('skillsGetDetail', { skillId, source }),
    search: (query: string) => invoke<Skill[]>('skillsSearch', { query }),
    install: (skillId: string, source?: { owner: string; repo: string }) =>
      invoke<Skill>('skillsInstall', { skillId, source }),
    uninstall: (skillId: string) => invoke<void>('skillsUninstall', { skillId }),
    create: (name: string, description: string, content?: string) =>
      invoke<Skill>('skillsCreate', { name, description, content }),
    getDetectedAgents: () => invoke<DetectedSkillAgent[]>('skillsDetectedAgents'),
  },
  mcp: {
    loadAll: () =>
      invoke<{ installed: McpServer[]; catalog: McpCatalogEntry[] }>('mcpLoadAll'),
    saveServer: (server: McpServer) => invoke<void>('mcpSaveServer', server),
    removeServer: (serverName: string) =>
      invoke<void>('mcpRemoveServer', { serverName }),
    getProviders: () => invoke<McpProvider[]>('mcpGetProviders'),
  },
  usage: {
    getProviders: () => invoke<ProviderUsageReport>('usageGetProviders'),
    // Push subscription: fires with a full ProviderUsageReport whenever a
    // source file changes on disk (desktop IPC or remote WS). Optional on
    // older bridges — callers must keep a slow fallback refresh.
    onChanged: (listener: (report: ProviderUsageReport) => void): (() => void) =>
      desktop().onUsageChanged?.(listener) ?? (() => {}),
  },
  streams: {
    listStreams: () =>
      invoke<{ streams: StreamEntry[] }>('streamList'),
    readScreen: (streamId: string, tail?: number) =>
      invoke<{ text: string; cursor: { row: number; col: number } | null; state: StreamState }>(
        'streamReadScreen',
        { streamId, tail }
      ),
    getState: (streamId: string) =>
      invoke<{ state: StreamState }>('streamGetState', { streamId }),
    sendInput: (streamId: string, text: string, mode?: 'paste' | 'type' | 'keys') => {
      const safe = mode === 'keys' ? text : sanitizeStreamTextPayload(text);
      return safe !== null
        ? invoke<{ ok: boolean }>('streamSendInput', { streamId, text: safe, mode })
        : Promise.resolve({ ok: false });
    },
    sendKeys: (streamId: string, key: string, repeat?: number) =>
      invoke<{ ok: boolean }>('streamSendKeys', { streamId, key, repeat }),
    submit: (streamId: string) =>
      invoke<{ ok: boolean }>('streamSubmit', { streamId }),
    sendSubmit: (streamId: string, text: string) => {
      const safe = sanitizeStreamTextPayload(text);
      return safe !== null
        ? invoke<{ ok: boolean }>('streamSendSubmit', { streamId, text: safe })
        : Promise.resolve({ ok: false });
    },
    abort: (streamId: string) =>
      invoke<{ ok: boolean }>('streamAbort', { streamId }),
    ask: (
      streamId: string,
      prompt: string,
      opts?: { timeoutMs?: number; submitRetryMs?: number }
    ) =>
      invoke<{
        ok: boolean;
        elapsedMs: number;
        endState: StreamState;
        newOutput: string;
        error?: string;
      }>('streamAsk', { streamId, prompt, ...opts }),
    slash: (streamId: string, command: string, args?: string[]) =>
      invoke<{ ok: boolean }>('streamSlash', { streamId, command, args }),
    ref: (streamId: string, filePath: string) =>
      invoke<{ ok: boolean }>('streamRef', { streamId, filePath }),
    approve: (streamId: string, answer: 'yes' | 'no') =>
      invoke<{ ok: boolean; answer: 'yes' | 'no' }>('streamApprove', { streamId, answer }),
    interrupt: (streamId: string) =>
      invoke<{ ok: boolean }>('streamInterrupt', { streamId }),
    waitFor: (streamId: string, predicate: StreamWaitPredicate, timeoutMs?: number) =>
      invoke<{ state: StreamState; elapsedMs: number }>(
        'streamWaitFor',
        { streamId, predicate, timeoutMs }
      ),
    spawn: (agent: string, opts: { taskId: string; kind?: 'cli' | 'chat' }) =>
      invoke<{ streamId: string; conversationId: string }>(
        'streamSpawn',
        { agent, ...opts }
      ),
    close: (streamId: string) =>
      invoke<{ ok: boolean }>('streamClose', { streamId }),
    rename: (streamId: string, label: string | null) =>
      invoke<{ ok: boolean; label: string | null }>('streamRename', { streamId, label }),
    recordStart: (streamId: string, outPath: string) =>
      invoke<{ ok: boolean; path?: string; error?: string }>(
        'streamRecordStart',
        { streamId, outPath }
      ),
    recordStop: (streamId: string) =>
      invoke<{ ok: boolean; path?: string; error?: string }>('streamRecordStop', { streamId }),
    replay: (recordPath: string, agent?: string) =>
      invoke<{
        ok: boolean;
        frames: number;
        finalState: StreamState;
        transitions: Array<{ t: number; from: StreamState; to: StreamState }>;
      }>('streamReplay', { recordPath, agent }),
    follow: (streamId: string) =>
      invoke<{ text: string; state: StreamState }>('streamFollow', { streamId }),
    snapshot: (streamId: string) =>
      invoke<{
        ok: boolean;
        ansi: string;
        text: string;
        cursor: { row: number; col: number } | null;
        state: StreamState;
        dir: string;
      }>('streamSnapshot', { streamId }),
    profiles: () =>
      invoke<{ profiles: Array<Record<string, unknown>> }>('streamProfiles'),
    reloadProfiles: () =>
      invoke<{ count: number; rebound: number }>('streamReloadProfiles'),
    onEvent: (listener: (payload: StreamEventPayload) => void) => {
      const d = desktop();
      return d.onStreamEvent ? d.onStreamEvent(listener) : () => {};
    },
    transcript: (streamId: string, opts?: { since?: number; before?: number; limit?: number }) =>
      invoke<TranscriptSnapshot | null>('streamTranscript', { streamId, ...(opts ?? {}) }),
    onTabChatAvailable: (listener: (payload: TabChatAvailablePayload) => void) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event === 'tab-chat-available') {
          listener(p.payload as unknown as TabChatAvailablePayload);
        }
      });
    },
    onTranscriptAppend: (streamId: string, listener: (entry: TranscriptEntry) => void) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event !== 'transcript:append') return;
        const payload = p.payload as { streamId?: string; entry?: TranscriptEntry } | undefined;
        if (payload?.streamId !== streamId || !payload?.entry) return;
        listener(payload.entry);
      });
    },
    onTranscriptUpdate: (streamId: string, listener: (entry: TranscriptEntry) => void) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event !== 'transcript:update') return;
        const payload = p.payload as { streamId?: string; entry?: TranscriptEntry } | undefined;
        if (payload?.streamId !== streamId || !payload?.entry) return;
        listener(payload.entry);
      });
    },
    onTranscriptReset: (streamId: string, listener: (payload: TranscriptResetPayload) => void) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event !== 'transcript:reset') return;
        const payload = p.payload as { streamId?: string; nextCursor?: number; reason?: TranscriptResetReason } | undefined;
        if (payload?.streamId !== streamId) return;
        listener({
          streamId,
          nextCursor: payload.nextCursor ?? 0,
          reason: payload.reason,
        });
      });
    },
    onTranscriptReplace: (
      streamId: string,
      listener: (payload: TranscriptReplacePayload) => void
    ) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event !== 'transcript:replace') return;
        const payload = p.payload as
          | { streamId?: string; nextCursor?: number; summary?: TranscriptEntry; reason?: TranscriptResetReason }
          | undefined;
        if (payload?.streamId !== streamId || !payload?.summary) return;
        listener({ nextCursor: payload.nextCursor ?? 0, summary: payload.summary, reason: payload.reason });
      });
    },
    onTranscriptTruncate: (
      streamId: string,
      listener: (payload: { nextCursor: number }) => void
    ) => {
      const d = desktop();
      if (!d.onStreamEvent) return () => {};
      return d.onStreamEvent((p) => {
        if (p?.event !== 'transcript:truncate') return;
        const payload = p.payload as { streamId?: string; nextCursor?: number } | undefined;
        if (payload?.streamId !== streamId) return;
        listener({ nextCursor: payload.nextCursor ?? 0 });
      });
    },
  },
  github: {
    isAvailable: () =>
      invoke<{ installed: boolean; version?: string }>('githubIsAvailable'),
    refreshAvailability: () =>
      invoke<{ installed: boolean; version?: string }>('githubRefreshAvailability'),
    listAccounts: (opts?: { force?: boolean }) =>
      invoke<GithubAccount[]>('githubListAccounts', opts),
    switchAccount: (login: string) =>
      invoke<GithubAccount[]>('githubSwitchAccount', { login }),
    // Completed requestId device-flow contract (the unification PR owns the
    // full migration; the security-core #101 stays on origin/main's deviceCode
    // contract). github-core keys device sessions by requestId.
    loginStart: (requestId: string) =>
      invoke<
        | { ok: true; requestId: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
        | { ok: false; error: string }
      >('githubLoginStart', { requestId }),
    loginPoll: (requestId: string) =>
      invoke<{ ok: true; login: string | null } | { ok: false; error: string }>('githubLoginPoll', {
        requestId,
      }),
    loginCancel: (requestId?: string) =>
      invoke<{ ok: boolean }>('githubLoginCancel', requestId ? { requestId } : {}),
    removeAccount: (login: string) =>
      invoke<GithubAccount[]>('githubRemoveAccount', { login }),
    listRepos: () => invoke<GithubRepo[]>('githubListRepos'),
    listStars: () => invoke<GithubRepo[]>('githubListStars'),
    listTrending: (opts?: { since?: 'daily' | 'weekly' | 'monthly'; language?: string | null }) =>
      invoke<{ at: number; data: GithubTrendingRow[]; error?: string | null }>(
        'githubListTrending',
        opts
      ),
    cloneRepo: (input: { fullName?: string; cloneUrl?: string; name?: string }) =>
      invoke<CreateResult>('githubCloneRepo', input),
    fetchContributions: (opts?: { login?: string; year?: number }) =>
      invoke<GithubContributions>('githubFetchContributions', opts || {}),
    starRepo: (input: { fullName: string }) =>
      invoke<{ ok: boolean; starred: boolean }>('githubStarRepo', input),
    unstarRepo: (input: { fullName: string }) =>
      invoke<{ ok: boolean; starred: boolean }>('githubUnstarRepo', input),
  },
  integration: {
    push: (input: {
      taskId: string;
      branch?: string;
      remote?: string;
      force?: boolean;
    }) => invoke<IntegrationEnvelope>('integrationPush', input),
    openPr: (input: {
      taskId: string;
      base?: string;
      head?: string;
      title: string;
      body?: string;
      draft?: boolean;
    }) => invoke<IntegrationEnvelope>('integrationOpenPr', input),
    pollChecks: (input: {
      taskId: string;
      prNumber?: number;
      branch?: string;
    }) => invoke<IntegrationEnvelope>('integrationPollChecks', input),
    gate: (input: {
      taskId: string;
      prNumber: number;
      branch?: string;
      remote?: string;
    }) => invoke<IntegrationEnvelope>('integrationGate', input),
    mergePr: (input: {
      taskId: string;
      prNumber: number;
      method?: 'squash' | 'merge' | 'rebase';
      deleteBranch?: boolean;
      auto?: boolean;
      autoAdmin?: boolean;
      admin?: boolean;
      adminReason?: string;
      allowedPaths?: string[];
    }) => invoke<IntegrationEnvelope>('integrationMergePr', input),
    cleanup: (input: {
      taskId: string;
      branch?: string;
      remote?: string;
      includeRemote?: boolean;
    }) => invoke<IntegrationEnvelope>('integrationCleanup', input),
  },
};

// Hydrate the renderer operators registry. This runs while the front door still
// shows the login screen and the operators IPC handler is only registered
// inside bootRuntime(), so the first attempt rejects — the registry retries on
// a backoff until it succeeds.
initOperatorsRegistry(() =>
  aceApi.operators
    .list()
    .then((result) => result.config)
    .catch(() => null)
);

export type GithubContributions = {
  total: number;
  weeks: Array<{
    days: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }>;
  }>;
  year: number | null;
};

export type GithubAccount = {
  login: string;
  avatarUrl: string | null;
  isActive: boolean;
  name: string | null;
  bio: string | null;
  htmlUrl: string;
  followers: number | null;
  following: number | null;
  publicRepos: number | null;
  location: string | null;
  company: string | null;
  blog: string | null;
};

export type GithubRepo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerAvatarUrl: string | null;
  description: string | null;
  private: boolean;
  fork: boolean;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  stars: number;
  language: string | null;
  pushedAt: string;
  updatedAt: string;
  lastCommit: null;
};

export type GithubTrendingRow = {
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  stars: number | null;
  forks: number | null;
  starsGained: number | null;
  starsGainedText: string | null;
  htmlUrl: string;
  cloneUrl: string;
};

declare global {
  interface Window {
    aceDesktop?: DesktopBridge;
  }
}
