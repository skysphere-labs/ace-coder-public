import type { AgentId } from './types';

export type AgentLaneProviderKind =
  | 'builtin-personal'
  | 'native-orchestrator'
  | 'hermes-profile';

export type AgentLane = {
  id: string;
  label: string;
  agent: AgentId | string;
  providerKind: AgentLaneProviderKind;
  profileId?: string | null;
  profileHome?: string | null;
  projectId: string;
  taskId: string;
  mainConversationId?: string | null;
  sortOrder: number;
  autoStart: boolean;
  isBuiltin: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type HermesProfileSummary = {
  id: string;
  label: string;
  homePath: string;
  configPath: string;
  modelProvider: string | null;
  modelName: string | null;
  terminalCwd: string | null;
  launchable: boolean;
  source?: 'hermes-home' | 'hermes-profile' | 'ace-session' | string | null;
  aceUserDataPath?: string | null;
  providerKind?: string | null;
  laneId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
};

export type OrchestratorTemplate = {
  id: string;
  label: string;
  description: string;
  agent: 'hermes' | 'claude' | 'codex';
  providerKind: AgentLaneProviderKind;
  profileId?: string | null;
  profileHome?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  terminalCwd?: string | null;
  launchable: boolean;
  reason?: string | null;
  source?: string | null;
  aceUserDataPath?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
};

export type CreateAgentLaneInput = {
  label?: string;
  agent: 'hermes' | 'claude' | 'codex';
  providerKind: AgentLaneProviderKind;
  profileId?: string | null;
  profileHome?: string | null;
  autoStart?: boolean;
};

export function sortAgentLanes<T extends Pick<AgentLane, 'sortOrder' | 'createdAt' | 'label'>>(lanes: T[]): T[] {
  return [...lanes].sort((a, b) => {
    if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    const byCreated = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    if (byCreated !== 0) return byCreated;
    return String(a.label ?? '').localeCompare(String(b.label ?? ''));
  });
}

export function chooseActiveAgentLane<T extends AgentLane>(lanes: T[], storedId?: string | null): T | null {
  const sorted = sortAgentLanes(lanes);
  if (storedId) {
    const found = sorted.find((lane) => lane.id === storedId);
    if (found) return found;
  }
  return sorted[0] ?? null;
}

export function defaultLabelForTemplate(template: OrchestratorTemplate): string {
  if (template.providerKind === 'hermes-profile' && template.profileId && template.profileId !== 'default') {
    return template.label;
  }
  return template.label || `${template.agent} orchestrator`;
}
