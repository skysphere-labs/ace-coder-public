import type { Conversation } from '../lib/types';
import { TerminalFeed } from './TerminalFeed';
import { getConversationStreamId } from '../runtime/terminal-io';
import { AceChatPane } from './ace-chat/AceChatPane';
import { isAceChatAgent } from '../runtime/ace-chat-mode-registry';
import type { PersonalAgentIdentity } from '../lib/personal-agents';

export function ConversationPane({
  conversation,
  taskId,
  fallbackStreamId,
  fallbackAgent,
  agentsChatIdentity,
  className,
}: {
  conversation: Conversation | null | undefined;
  taskId?: string | null;
  fallbackStreamId?: string | null;
  fallbackAgent?: string | null;
  agentsChatIdentity?: PersonalAgentIdentity | null;
  className?: string;
}) {
  const streamId = conversation
    ? getConversationStreamId(conversation.id)
    : fallbackStreamId ?? null;

  const agent = conversation?.agent ?? fallbackAgent ?? null;
  const canAceChat = isAceChatAgent(agent);

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="min-h-0 flex-1">
        {streamId && canAceChat ? (
          <AceChatPane
            key={agent === 'hermes' ? streamId : undefined}
            streamId={streamId}
            agent={agent}
            taskId={taskId ?? null}
            agentsChatIdentity={agentsChatIdentity ?? null}
          />
        ) : (
          <TerminalFeed streamId={streamId} />
        )}
      </div>
    </div>
  );
}
