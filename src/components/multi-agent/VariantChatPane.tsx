import type { Variant } from '../../lib/types';
import { TerminalFeed } from '../TerminalFeed';
import { AceChatPane } from '../ace-chat/AceChatPane';
import { isAceChatAgent } from '../../runtime/ace-chat-mode-registry';

// Wraps a task variant pane. Routes claude/codex/gemini/hermes through
// AceChatPane (terminal + smart composer toolbar + optional transcript
// chat view); all other agents render the terminal directly.
export function VariantChatPane({
  variant,
  taskId,
  streamId,
}: {
  variant: Variant;
  taskId: string | null;
  streamId: string;
}) {
  const canAceChat = isAceChatAgent(variant.agent);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {canAceChat ? (
          <AceChatPane
            key={variant.agent === 'hermes' ? streamId : undefined}
            streamId={streamId}
            agent={variant.agent}
            taskId={taskId ?? null}
          />
        ) : (
          <TerminalFeed streamId={streamId} />
        )}
      </div>
    </div>
  );
}
