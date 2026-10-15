export type AgentId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'gemini'
  | 'qwen'
  | 'droid'
  | 'amp'
  | 'opencode'
  | 'hermes'
  | 'copilot'
  | 'charm'
  | 'auggie'
  | 'goose'
  | 'kimi'
  | 'kilocode'
  | 'kiro'
  | 'rovo'
  | 'cline'
  | 'continue'
  | 'codebuff'
  | 'mistral'
  | 'pi'
  | 'autohand'
  | 'forge';

export const AGENTS = [
  { id: 'claude', name: 'Claude', color: '#D97757' },
  { id: 'codex', name: 'Codex', color: '#10A37F' },
  { id: 'cursor', name: 'Cursor', color: '#00B4D8' },
  { id: 'gemini', name: 'Gemini', color: '#4285F4' },
  { id: 'qwen', name: 'Qwen', color: '#9333EA' },
  { id: 'droid', name: 'Droid', color: '#06B6D4' },
  { id: 'amp', name: 'Amp', color: '#FF6B35' },
  { id: 'opencode', name: 'OpenCode', color: '#14B8A6' },
  { id: 'hermes', name: 'Hermes', color: '#0EA5E9' },
  { id: 'copilot', name: 'Copilot', color: '#6E40C9' },
  { id: 'charm', name: 'Charm', color: '#EC4899' },
  { id: 'auggie', name: 'Auggie', color: '#84CC16' },
  { id: 'goose', name: 'Goose', color: '#22C55E' },
  { id: 'kimi', name: 'Kimi', color: '#F472B6' },
  { id: 'kilocode', name: 'Kilocode', color: '#FB923C' },
  { id: 'kiro', name: 'Kiro', color: '#F59E0B' },
  { id: 'rovo', name: 'Rovo', color: '#0052CC' },
  { id: 'cline', name: 'Cline', color: '#818CF8' },
  { id: 'continue', name: 'Continue', color: '#64748B' },
  { id: 'codebuff', name: 'Codebuff', color: '#A855F7' },
  { id: 'mistral', name: 'Mistral', color: '#FF7000' },
  { id: 'pi', name: 'Pi', color: '#059669' },
  { id: 'autohand', name: 'Autohand', color: '#D946EF' },
  { id: 'forge', name: 'Forge', color: '#EF4444' },
] as const;

export type OpenPr = {
  number: number;
  title: string;
  headRef: string;
  author: string;
  additions: number;
  deletions: number;
  isDraft?: boolean;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  checksStatus?: 'success' | 'pending' | 'failure';
  url?: string;
};

export type CleanupBranch = {
  branch: string;
  hasLocal: boolean;
  hasRemote: boolean;
  remote?: string;
  isDefaultBranch?: boolean;
  isCurrentBranch?: boolean;
  taskNames?: string[];
};

export type Workspace = {
  id: string;
  name: string;
  path: string;
  isRemote: boolean;
  sshHost: string | null;
  sshUser: string | null;
  remotePath: string | null;
  agentUser: string | null;
  defaultBranch: string;
  tasks: Task[];
  archivedTasks: Task[];
  githubRepo?: string | null;
  alwaysOnOrchestrator?: boolean;
  alwaysOnAgent?: 'hermes' | 'claude' | 'codex' | null;
  isPersonal?: boolean;
  /**
   * Operator id (see src/lib/operators.ts). Legacy owner installs carry
   * 'rook'/'king'; always populated post-migration for personal workspaces.
   */
  personalIdentity?: string | null;
  branches?: string[];
  openPrs?: OpenPr[];
  cleanupBranches?: CleanupBranch[];
  isInitialized?: boolean;
};

export type Task = {
  id: string;
  name: string;
  branch: string;
  type: 'task' | 'thread';
  // 'preparing' = the worktree checkout is running off the createTask response
  // path; 'error' with prepError set = that checkout failed (delete or retry).
  status: 'idle' | 'busy' | 'done' | 'error' | 'preparing';
  // Git failure message when status === 'error' from a failed worktree setup.
  prepError?: string | null;
  agent: AgentId;
  agents?: AgentId[];
  isMultiAgent?: boolean;
  isPinned?: boolean;
  unread?: boolean;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  prNumber?: number;
  prStatus?: 'open' | 'merged' | 'closed' | 'draft';
  initialPrompt?: string;
  conversations?: Conversation[];
  worktrees?: WorktreeGroup[];
  context?: TaskContext;
  fileChanges?: FileChange[];
  autoApproveEnabled?: boolean;
  agentInstalled?: boolean;
  installError?: string | null;
};

export type WorktreeGroup = {
  worktreeId: string;
  displayName: string;
  branch: string;
  path: string;
  variants: Variant[];
};

export type Variant = {
  id: string;
  name: string;
  agent: AgentId;
  branch: string;
  worktreeId: string;
  busy?: boolean;
  isReviewMode?: boolean;
  kind?: 'cli' | 'chat';
};

export type TaskContext = {
  linearIssue?: { identifier: string; title: string; url: string; state?: string };
  githubIssue?: { number: number; title: string; url: string };
  jiraIssue?: { key: string; summary: string; url: string };
  unsentComments?: number;
};

export type Conversation = {
  id: string;
  title: string;
  agent: AgentId;
  kind: 'cli' | 'chat';
  isMain: boolean;
  isActive: boolean;
};

export type FileChange = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
};

export type MissionAgent = 'claude' | 'codex';
/**
 * Operator id (see src/lib/operators.ts) of who created/acted on a mission.
 * Reserved values: 'chief' (the human owner) and 'system' (automation).
 */
export type MissionIdentity = string;
/**
 * Operator id (see src/lib/operators.ts) that owns a mission.
 * Reserved value: 'shared' (co-owned across operators).
 */
export type MissionOwnerIdentity = string;
/** Operator id (see src/lib/operators.ts) of the mission's active controller. */
export type MissionControllerIdentity = string;

export type MissionStatus =
  | 'planning'
  | 'awaiting_clarification'
  | 'awaiting_brief_review'
  | 'awaiting_approval'
  | 'ready'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed';

export type MissionFeatureStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MissionFeatureDispatchStatus =
  | 'ready'
  | 'blocked_by_dependencies'
  | 'not_dispatchable';

export type MissionBoardCardStage =
  | 'todo'
  | 'in_progress'
  | 'ready_to_review'
  | 'done';

export type MissionAssertionStatus = 'pending' | 'passed' | 'failed' | 'blocked';

export type MissionValidatorStatus = 'pending' | 'running' | 'passed' | 'failed';

export type MissionMilestone = {
  id: string;
  name: string;
  description?: string;
  scrutinyStatus: MissionValidatorStatus;
  userTestingStatus: MissionValidatorStatus;
  sealed: boolean;
};

export type MissionFeature = {
  id: string;
  milestoneId: string;
  name: string;
  description?: string;
  skillName: string;
  roleMode?: string;
  roleLabel?: string;
  skillPack?: string;
  capabilities?: string[];
  taskPackSkills?: string[];
  omittedTaskPackSkillCount?: number;
  manifest?: TaskManifest;
  status: MissionFeatureStatus;
  dispatchReady?: boolean;
  dispatchStatus?: MissionFeatureDispatchStatus;
  parentFeatureIds?: string[];
  dependencyFeatureIds?: string[];
  blockedByFeatureIds?: string[];
  branch?: string;
  startedAt?: string;
  completedAt?: string;
  fulfillsAssertions: string[];
  changedFiles?: number;
  workerAgent?: MissionAgent;
  taskId?: string;
  streamId?: string;
  worktreeId?: string;
  worktreePath?: string;
  prUrl?: string;
  prNumber?: number;
  prHeadRef?: string;
  prBaseRef?: string;
  prHeadSha?: string;
  prBaseSha?: string;
  spawnedByIdentity?: MissionIdentity;
  spawnedByStreamId?: string;
  validationStatus?: string;
  validatorAgent?: MissionAgent;
  validatorTaskId?: string;
  validatorStreamId?: string;
  validatorWorktreeId?: string;
  validatorWorktreePath?: string;
  validatorBranch?: string;
  validatorSpawnedByIdentity?: MissionIdentity;
  validatorSpawnedByStreamId?: string;
  validationStartedAt?: string;
  validationCompletedAt?: string;
  validationHandoff?: string;
  gateStatus?: string;
  gateDetail?: string;
  fixbackAttempts?: number;
  validationFailurePacket?: unknown;
  validationAttempts?: unknown[];
  lastSeenState?: string;
  archivedAt?: string;
};

export type TaskManifest = {
  roleMode?: string;
  roleLabel?: string;
  skillPack?: string;
  capabilities?: string[];
  taskPackSkills?: string[];
  omittedTaskPackSkillCount?: number;
};

export type MissionAssertion = {
  id: string;
  text: string;
  status: MissionAssertionStatus;
  fulfilledByFeatureId?: string;
  evidence?: string;
};

export type MissionArtifact = {
  name: string;
  description: string;
  size: string;
  updatedAt: string;
  required: boolean;
  exists: boolean;
};

export const MISSION_EVENT_TYPES = {
  CREATED: 'created',
  PLAN_PROPOSED: 'plan_proposed',
  PLAN_APPROVED: 'plan_approved',
  WORKER_STARTED: 'feature_started',
  WORKER_DISPATCHED: 'feature_dispatched',
  WORKER_COMPLETED: 'feature_completed',
  WORKER_FAILED: 'feature_failed',
  WORKER_ARCHIVED: 'feature_archived',
  VALIDATOR_DISPATCHED: 'validator_dispatched',
  VALIDATOR_PASSED: 'validator_passed',
  VALIDATOR_FAILED: 'validator_failed',
  VALIDATION_RERUN: 'validation_rerun',
  PR_LINKED: 'pr_linked',
  PR_GATE_READY: 'pr_gate_ready',
  PR_GATE_BLOCKED: 'pr_gate_blocked',
  FIXBACK_RECORDED: 'fixback_recorded',
  FIXBACK_BLOCKED: 'fixback_blocked',
  BUDGET_WARNING: 'budget_warning',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  RELEASE_GATE_PASSED: 'release_gate_passed',
  RELEASE_GATE_BLOCKED: 'release_gate_blocked',
  MILESTONE_SEALED: 'milestone_sealed',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  NOTE: 'note',
} as const;

export type MissionEventType =
  typeof MISSION_EVENT_TYPES[keyof typeof MISSION_EVENT_TYPES];

export type MissionEvent = {
  id: string;
  at: string;
  type: MissionEventType;
  message: string;
  actor?: string;
  featureId?: string;
};

export type MissionClarificationOption = {
  id: string;
  label: string;
  detail?: string;
};

export type MissionClarification = {
  id: string;
  question: string;
  rationale?: string;
  options: MissionClarificationOption[];
  recommendedOptionId?: string;
  answerOptionId?: string;
  customAnswer?: string;
  answered: boolean;
};

export type MissionSizeClass = 'small' | 'medium' | 'large' | 'epic';

export type MissionBaselineMetrics = {
  loc?: number;
  files?: number;
  language?: string;
  framework?: string;
  key_findings?: string[];
  [key: string]: unknown;
};

export type Mission = {
  id: string;
  name: string;
  workspaceId: string;
  status: MissionStatus;
  summary: string;
  orchestratorAgent: MissionAgent;
  workerAgent: MissionAgent;
  validatorAgent: MissionAgent;
  missionDir: string;
  integrationBranch: string;
  currentMilestoneId?: string;
  currentFeatureId?: string;
  createdByIdentity: MissionIdentity;
  ownerIdentity: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity;
  createdByWorkspaceId?: string;
  createdByTaskId?: string;
  createdByStreamId?: string;
  sourceContextSummary?: string;
  sourceFiles?: string[];
  statusNote?: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
  milestones: MissionMilestone[];
  features: MissionFeature[];
  assertions: MissionAssertion[];
  artifacts: MissionArtifact[];
  events: MissionEvent[];
  clarifications: MissionClarification[];
  investigation?: string;
  originalBrief?: string;
  polishedBrief?: string;
  sizeClass?: MissionSizeClass;
  realismScore?: number;
  estimatedTokens?: number;
  estimatedMinutesMin?: number;
  estimatedMinutesMax?: number;
  baselineMetrics?: MissionBaselineMetrics;
};

// Derived stream actionability labels surfaced on a Mission Board card.
// Source of truth: electron/ace-control/derived-actionability.cts. The
// renderer treats `blocking: true` as a "needs operator now" highlight and
// `diagnostic: true` as a soft warning hidden inside the details drawer.
export type MissionCardActionabilityLabel =
  | 'awaiting-chief'
  | 'awaiting-worker'
  | 'stale-awaiting-input'
  | 'interrupted'
  | 'clean-ready'
  | 'task-complete-unvalidated'
  | 'diagnostic-dormant'
  | 'blocked-approval'
  | 'active-working'
  | 'no-standing-orchestrator-expected'
  | 'required-orchestrator-missing';

export type MissionCardDerivedActionability = {
  label: MissionCardActionabilityLabel;
  reason?: string;
  blocking?: boolean;
  diagnostic?: boolean;
};

export type MissionBoardCard = {
  id: string;
  missionId: string;
  workspaceId: string;
  workspaceName?: string;
  milestoneId?: string;
  name: string;
  description?: string;
  status: MissionFeatureStatus;
  // Derived classification from the stream state machine. Cards prefer this
  // over the raw `lastSeenState` when surfacing next-action, blocked reason,
  // or stale/diagnostic warnings.
  derivedActionability?: MissionCardDerivedActionability;
  missionOwnerIdentity?: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity;
  missionControllerIdentity?: MissionControllerIdentity;
  missionStatusNote?: string;
  missionNextAction?: string;
  roleMode?: string;
  roleLabel?: string;
  skillPack?: string;
  capabilities?: string[];
  taskPackSkills?: string[];
  omittedTaskPackSkillCount?: number;
  manifest?: TaskManifest;
  boardStage: MissionBoardCardStage;
  cardStage: MissionBoardCardStage;
  assignee?: string;
  assigneeLabel?: string;
  activeIdentity?: string;
  workingLabel?: string;
  dispatchReady: boolean;
  dispatchStatus: MissionFeatureDispatchStatus | string;
  parentFeatureIds: string[];
  dependencyFeatureIds: string[];
  blockedByFeatureIds: string[];
  taskId?: string;
  streamId?: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  startedAt?: string;
  completedAt?: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: 'open' | 'draft' | 'merged' | string;
  prMergedAt?: string;
  prTitle?: string;
  prHeadRef?: string;
  prBaseRef?: string;
  prHeadSha?: string;
  prBaseSha?: string;
  prChecksStatus?: 'success' | 'pending' | 'failure' | string;
  prReviewDecision?: string;
  prAuthor?: string;
  workerAgent?: string;
  spawnedByIdentity?: string;
  spawnedByStreamId?: string;
  validationStatus?: string;
  validatorAgent?: string;
  validatorTaskId?: string;
  validatorStreamId?: string;
  validatorWorktreeId?: string;
  validatorWorktreePath?: string;
  validatorBranch?: string;
  validatorSpawnedByIdentity?: string;
  validatorSpawnedByStreamId?: string;
  validationStartedAt?: string;
  validationCompletedAt?: string;
  validationHandoff?: string;
  gateStatus?: string;
  gateDetail?: string;
  fixbackAttempts?: number;
  validationFailurePacket?: unknown;
  validationAttempts?: unknown[];
  blockerEvidence?: string;
  lastSeenState?: string;
  // Board automation: explicit stale taxonomy persisted on the feature row.
  // Set by the background sweep (orphaned/dormant) or restart recovery
  // (interrupted); cleared when lifecycle activity resumes.
  staleReason?: 'orphaned' | 'dormant' | 'interrupted';
  staleAt?: string;
  latestEvent?: MissionEvent;
  eventCount?: number;
  archived?: boolean;
  archivedAt?: string;
};

export type MissionBoardMission = {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  name: string;
  status: MissionStatus;
  createdByIdentity?: MissionIdentity;
  ownerIdentity?: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity;
  createdByWorkspaceId?: string;
  createdByTaskId?: string;
  createdByStreamId?: string;
  sourceContextSummary?: string;
  sourceFiles?: string[];
  statusNote?: string;
  nextAction?: string;
  currentFeatureId?: string;
  // P2b: milestone metadata for the wave-dispatch picker (cards reference
  // these by milestoneId).
  milestones?: MissionMilestone[];
  counts: {
    cards: number;
    ready: number;
    blocked: number;
    todo?: number;
    inProgress?: number;
    readyToReview?: number;
    done?: number;
    activeWorkers?: number;
    validators?: number;
    blockedCards?: number;
    mergeReady?: number;
    active?: number;
    archived?: number;
  };
  cards: MissionBoardCard[];
};

export type MissionBoardWorkspace = {
  id: string;
  workspaceId: string;
  name: string;
  workspaceName?: string;
  counts: {
    missions: number;
    cards: number;
    ready: number;
    blocked: number;
    blockedCards?: number;
    mergeReady?: number;
    activeWorkers?: number;
    validators?: number;
    todo?: number;
    inProgress?: number;
    readyToReview?: number;
    done?: number;
    active?: number;
    archived?: number;
  };
  missions: MissionBoardMission[];
};

export type MissionBoardResult = {
  filters: {
    workspaceId: string | null;
    missionId: string | null;
    readyOnly: boolean;
    includeArchived?: boolean;
  };
  totals: {
    missions: number;
    cards: number;
    ready: number;
    blocked: number;
    todo?: number;
    inProgress?: number;
    readyToReview?: number;
    done?: number;
    activeWorkers?: number;
    validators?: number;
    blockedCards?: number;
    mergeReady?: number;
    active?: number;
    archived?: number;
  };
  workspaces?: MissionBoardWorkspace[];
  missions: MissionBoardMission[];
};

// The LEAN, READ-ONLY run-ledger board (watcher, never a gate). A pure
// projection over the event ledger: agent-keyed cards carrying telemetry the
// agent wrote on finish. Distinct from the rich MissionBoardResult — this is the
// view-only board the watcher folds for free (zero agent tokens).
// The expanded ticket body is folded from the same reconcile that produces the
// card. It deliberately omits raw per-event history so a large ledger does not
// become a large IPC payload on every board refresh.
export type RunLedgerCardDetail = {
  description: string | null;
  context: string | null;
  acceptance: string[];
  constraints: string[];
  risk: string | null;
  worker: {
    taskId: string | null;
    streamId: string | null;
    branch: string | null;
    worktreePath: string | null;
    outcome: string | null;
  };
  validator: {
    taskId: string | null;
    streamId: string | null;
    outcome: string | null;
    computerUseRequired: boolean;
    evidence: string | null;
  };
  pr: {
    number: number | null;
    url: string | null;
    state: string | null;
    mergeable: string | null;
    checkState: string | null;
    changedFiles: string[];
  };
  merge: { merged: boolean; sha: string | null; cleanedUp: boolean };
  decision: { next: string | null; reason: string | null };
  // Capped lifecycle transition trail (types only, newest last, ≤30 entries)
  // for the ticket drawer — never the raw per-event ledger.
  history: { type: string; ts: number | null }[];
  gate: { ok: boolean; reason: string | null } | null;
  autoship: {
    enabled: boolean;
    status: string | null;
    autoMergeAllowed: boolean;
    autoBuildAllowed: boolean;
    requiresOwnerApproval: boolean;
    reason: string | null;
  } | null;
};

export type RunLedgerCard = {
  id: string;
  key: string;
  agentId: string | null;
  name: string;
  missionId: string | null;
  workspaceId: string | null;
  stage: 'todo' | 'in_progress' | 'ready_to_review' | 'done' | 'blocked';
  assignee: string | null;
  branch: string | null;
  prUrl: string | null;
  prStatus: string | null;
  currentHeadSha: string | null;
  validatedHeadSha: string | null;
  skysphereRef: string | null;
  skysphere: {
    connectionId: string;
    origin: string;
    workspaceSlug: string;
    workspaceId: string;
    projectId: string;
    issueId: string;
    ticketKey: string;
  } | null;
  workerOutcome: string | null;
  validationStatus: string | null;
  blocked: boolean;
  nextAction: string | null;
  autoshipStatus: string | null;
  autoshipReason: string | null;
  telemetry: {
    agent: string | null;
    rubric: string | null;
    score: number | null;
    commands: number;
    durationMs: number;
    tokens: number;
    reports: number;
  } | null;
  lastEventType: string | null;
  // ts of the last ledger event for the run — drives the card age label and
  // the Archived (done > 24h) split. Null when the ledger event carried no ts.
  lastTs: number | null;
  // Autonomy OUTER-loop lineage (null when the run isn't part of a loop).
  loop: {
    lineageId: string;
    iteration: number;
    maxIterations: number;
    parentRunId: string | null;
    terminal: string | null;
    gaps: number | null;
    computerUseEvidence: boolean | null;
  } | null;
  detail: RunLedgerCardDetail;
};

export type RunLedgerBoard = {
  columns: Record<'todo' | 'in_progress' | 'ready_to_review' | 'done' | 'blocked', string[]>;
  cards: RunLedgerCard[];
  counts: {
    todo: number;
    inProgress: number;
    readyToReview: number;
    done: number;
    blocked: number;
    total: number;
  };
  followUps?: FollowUpDigest;
};

export type FollowUpDigest = {
  $schema: 'ace.follow-up-digest.v1';
  generatedAt: number;
  pendingCount: number;
  text: string;
  items: FollowUpDigestItem[];
};

export type FollowUpDigestItem = {
  id: string;
  workspaceId: string | null;
  runId: string | null;
  taskId: string | null;
  streamId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  state: string;
  nextAction: string | null;
  owner: string | null;
  evidenceLink: string | null;
  stopCondition: string | null;
  summary: string | null;
  ownerActionPacket?: {
    ownerCanDo: string;
    managerTracks: string;
    nextDecisionGate: string;
    terminalCondition: string | null;
  } | null;
  nextCheckAt: number | null;
  updatedAt: number | null;
};

export type MissionCreateResult = {
  missionId: string;
  workspaceId: string;
  status: MissionStatus;
  featureIds: string[];
  createdByIdentity?: MissionIdentity;
  ownerIdentity?: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity | null;
  board?: MissionBoardResult;
};

export type MissionArchiveResult = {
  dryRun: boolean;
  olderThanDays: number;
  cutoff: string;
  archivedCount: number;
  candidateCount: number;
  archived: Array<{
    missionId: string;
    featureId: string;
    workspaceId: string;
    name: string;
    completedAt: string;
    archivedAt?: string | null;
  }>;
};

export type MissionDispatchResult = {
  featureId: string;
  missionId: string;
  workspaceId: string;
  taskId: string;
  streamId: string;
  worktreeId?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  workerAgent?: string | null;
  roleMode?: string;
  skillPack?: string;
  capabilities?: string[];
  taskPackSkills?: string[];
  dispatchStatus: string;
};

export type MissionSyncResult = {
  featureId: string;
  missionId: string;
  workspaceId?: string;
  streamId: string | null;
  synced: boolean;
  outcome: 'done' | 'blocked' | 'none' | string;
  detail?: string | null;
  status?: MissionFeatureStatus;
};

export type MissionValidateResult = {
  featureId: string;
  missionId: string;
  workspaceId: string;
  validatorTaskId: string;
  validatorStreamId: string;
  validatorWorktreeId?: string | null;
  validatorWorktreePath?: string | null;
  validatorBranch?: string | null;
  validatorAgent?: string | null;
  validatorSpawnedByIdentity?: string | null;
  validatorSpawnedByStreamId?: string | null;
  activeControllerIdentity?: string | null;
  validationStatus: string;
  gateStatus: string;
  validationAttempts?: unknown[];
};

export type MissionGateResult = {
  featureId: string;
  missionId: string;
  workspaceId?: string;
  validatorStreamId: string | null;
  synced: boolean;
  outcome: 'done' | 'blocked' | 'none' | string;
  detail?: string | null;
  activeControllerIdentity?: string | null;
  validatorAgent?: string | null;
  validatorSpawnedByIdentity?: string | null;
  validatorSpawnedByStreamId?: string | null;
  validationHandoff?: string | null;
  validationStatus?: string;
  gateStatus?: string;
  gateDetail?: string | null;
  blockerEvidence?: string | null;
};

export type SkillSource = 'openai' | 'anthropic' | 'ace' | 'trailofbits' | 'local' | 'skills-sh';
export type SkillProvenance = 'bundled' | 'external' | 'reference-only';
export type SkillAgentCompatibility = 'shared' | 'claude-only' | 'codex-only';

export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  'allowed-tools'?: string;
};

export type Skill = {
  id: string;
  displayName: string;
  description: string;
  source: SkillSource;
  frontmatter?: SkillFrontmatter;
  iconUrl?: string;
  brandColor?: string;
  sourceUrl?: string;
  bundledPath?: string;
  provenance?: SkillProvenance;
  agentCompatibility?: SkillAgentCompatibility;
  kind?: string;
  defaultPrompt?: string;
  owner?: string;
  repo?: string;
  installs?: number;
  installed: boolean;
  localPath?: string;
  skillMdContent?: string;
};

export type SkillsCatalog = {
  version: number;
  lastUpdated: string;
  skills: Skill[];
};

export type DetectedSkillAgent = {
  id: string;
  name: string;
  configDir: string;
  installed: boolean;
};

export type McpTransport = 'stdio' | 'http';

export type McpServer = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  providers: string[];
};

export type McpCatalogEntry = {
  key: string;
  name: string;
  description: string;
  docsUrl: string;
  defaultConfig: Record<string, unknown>;
  credentialKeys: Array<{ key: string; required: boolean }>;
  capability?: 'browser-automation';
  enabledByDefault?: boolean;
};

export type McpProvider = {
  id: string;
  name: string;
  installed: boolean;
  supportsHttp: boolean;
};

export type AgentCatalogEntry = {
  id: AgentId;
  name: string;
  label: string;
  installCommand: string | null;
  docUrl: string | null;
  status: 'available' | 'missing' | 'unsupported';
  launchable: boolean;
  executable: string | null;
  reason: string | null;
  installWarning?: {
    title: string;
    body: string;
    confirmLabel: string;
    recommendation?: string;
  } | null;
};

export type StreamSnapshot = {
  id: string;
  agent: AgentId;
  status: 'running' | 'idle' | 'exited' | 'error';
  chunks: string[];
};
