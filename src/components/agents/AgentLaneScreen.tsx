import { useCoreSelector } from '../../runtime/core-registry';
import type { AgentLane } from '../../lib/agent-lanes';
import type { OperatorsConfig } from '../../lib/operators';
import type { Task, Workspace } from '../../lib/types';
import { normalizePersonalAgentIdentity } from '../../lib/personal-agents';
import { useOperators } from '../../runtime/operators-registry';
import { ConversationPane } from '../ConversationPane';
import AgentLogo from '../ProviderGlyph';

function findLaneTask(workspaces: Workspace[], lane: AgentLane): { workspace: Workspace; task: Task } | null {
  for (const workspace of workspaces) {
    if (workspace.id !== lane.projectId) continue;
    const task = workspace.tasks.find((candidate) => candidate.id === lane.taskId);
    if (task) return { workspace, task };
  }
  for (const workspace of workspaces) {
    const task = workspace.tasks.find((candidate) => candidate.id === lane.taskId);
    if (task) return { workspace, task };
  }
  return null;
}

// Chat identity for a personal lane: its personal-identity metadata validated
// against the operator registry (null when absent or not a personal lane).
function agentsChatIdentityFor(lane: AgentLane, config: OperatorsConfig) {
  if (lane.providerKind !== 'builtin-personal') return null;
  return normalizePersonalAgentIdentity(lane.metadata?.personalIdentity ?? null, config);
}

export function AgentLaneScreen({ lane }: { lane: AgentLane }) {
  const laneTask = useCoreSelector((s) => findLaneTask(s.workspaces, lane));
  const operators = useOperators();
  const fallbackStreamId = lane.mainConversationId ? `conversation:${lane.mainConversationId}` : null;
  const agentsChatIdentity = agentsChatIdentityFor(lane, operators);

  if (!laneTask) {
    if (fallbackStreamId) {
      return (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <ConversationPane
              conversation={null}
              taskId={lane.taskId}
              fallbackStreamId={fallbackStreamId}
              fallbackAgent={lane.agent}
              agentsChatIdentity={agentsChatIdentity}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-foreground/60">
        <AgentLogo agent={lane.agent} className="h-8 w-8 opacity-70" />
        <div className="text-base font-medium text-foreground">Preparing {lane.label}</div>
        <p className="max-w-md">
          This persistent orchestrator lane exists, but its task is still loading. It will appear here as soon as Ace refreshes state.
        </p>
      </div>
    );
  }

  const conversations = laneTask.task.conversations ?? [];
  const activeConversation = conversations.find((c) => c.isActive) ?? conversations[0] ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <ConversationPane
          conversation={activeConversation}
          taskId={lane.taskId}
          fallbackStreamId={fallbackStreamId}
          fallbackAgent={lane.agent}
          agentsChatIdentity={agentsChatIdentity}
        />
      </div>
    </div>
  );
}
