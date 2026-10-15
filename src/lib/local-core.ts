import type {
  AgentId,
  MissionControllerIdentity,
  MissionAgent,
  MissionIdentity,
  MissionOwnerIdentity,
} from './types';

export type CreateWorkspaceTaskInput = {
  name: string;
  agent: AgentId;
  prompt?: string;
  autoApproveEnabled?: boolean;
  useWorktree?: boolean;
};

export type CreateWorkspaceThreadInput = {
  name: string;
  agent: AgentId;
  prompt?: string;
  autoApproveEnabled?: boolean;
};

export type CreateMissionInput = {
  name: string;
  workspaceId: string;
  summary: string;
  orchestratorAgent: MissionAgent;
  workerAgent: MissionAgent;
  validatorAgent: MissionAgent;
  createdByIdentity?: MissionIdentity;
  ownerIdentity?: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity;
  createdByTaskId?: string;
  createdByStreamId?: string;
  sourceContextSummary?: string;
  sourceFiles?: string[];
  statusNote?: string;
  nextAction?: string;
};

export type UpdateMissionContextInput = {
  missionId: string;
  ownerIdentity: MissionOwnerIdentity;
  activeControllerIdentity?: MissionControllerIdentity | null;
  sourceContextSummary?: string;
  sourceFiles?: string[];
  statusNote?: string;
  nextAction?: string;
};

export type CreateWorktreeInput = {
  name: string;
  agent: AgentId;
  branch: string;
  reviewMode: boolean;
};

export type AttachVariantInput = {
  worktreeId: string;
  agent: AgentId;
  reviewMode: boolean;
  reviewPrompt?: string;
};

export type BroadcastCommandInput = {
  workItemId: string;
  variantIds: string[];
  message: string;
};

export type MissionSearchResult = {
  missionId: string;
  section: 'mission' | 'feature' | 'milestone' | 'assertion' | 'artifact' | 'event' | 'run' | 'evidence';
  title: string;
  excerpt: string;
  at?: string;
};
