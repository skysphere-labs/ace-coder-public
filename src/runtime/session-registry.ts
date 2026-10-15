import { aceApi } from '../lib/ace-api';
import type { Conversation } from '../lib/types';
import { runWithCoreStateRefresh, useCoreSelector } from './core-registry';

type SessionRecord = {
  conversations: Conversation[];
  activeConversationId: string | null;
};

export function useTaskSessions(taskId: string | null): SessionRecord | null {
  return useCoreSelector((snapshot) => {
    if (!taskId) return null;
    for (const workspace of snapshot.workspaces) {
      const task = [...workspace.tasks, ...workspace.archivedTasks].find(
        (t) => t.id === taskId
      );
      if (!task) continue;
      const conversations = task.conversations ?? [];
      const active = conversations.find((c) => c.isActive) ?? conversations[0] ?? null;
      return {
        conversations,
        activeConversationId: active?.id ?? null,
      };
    }
    return null;
  });
}

export async function createConversation(taskId: string, agent?: string) {
  const result = await runWithCoreStateRefresh(() =>
    aceApi.sessions.openConversation(taskId, agent)
  );
  return result;
}

export async function closeConversation(taskId: string, conversationId: string) {
  await runWithCoreStateRefresh(() =>
    aceApi.sessions.closeConversation(taskId, conversationId)
  );
}

export async function setActiveConversation(taskId: string, conversationId: string) {
  await runWithCoreStateRefresh(() =>
    aceApi.sessions.activateConversation(taskId, conversationId)
  );
}
