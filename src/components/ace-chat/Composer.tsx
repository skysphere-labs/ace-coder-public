import type { StreamState } from '../../lib/ace-api';
import { ClaudeComposer } from './composers/ClaudeComposer';
import { CodexComposer } from './composers/CodexComposer';
import { GeminiComposer } from './composers/GeminiComposer';
import { HermesComposer } from './composers/HermesComposer';

export type SmartComposerAgent = 'claude' | 'codex' | 'gemini' | 'hermes';

// Dispatcher. Per-agent composers live under ./composers/ and each sit on
// the shared ComposerShell (./ComposerShell.tsx). Claude uses its own
// bespoke composer (model/permission/effort pills) preserved from the
// pre-SDK-removal design — currently placeholder, wired to `streams.sendSubmit`.
// Hermes (and the Rook/King personal identity lanes) shares Codex/Gemini's
// shape: shell + attachments + streams.sendSubmit, profile-declared slash.
export function Composer({
  streamId,
  agent,
  state,
  slashCommands,
  placeholders,
  taskId,
}: {
  streamId: string;
  agent: SmartComposerAgent;
  state: StreamState;
  slashCommands: string[];
  placeholders: { default?: string; busy?: string };
  taskId?: string | null;
}) {
  switch (agent) {
    case 'claude':
      return (
        <ClaudeComposer
          streamId={streamId}
          state={state}
          slashCommands={slashCommands}
          placeholders={placeholders}
          taskId={taskId}
        />
      );
    case 'codex':
      return (
        <CodexComposer
          streamId={streamId}
          state={state}
          slashCommands={slashCommands}
          placeholders={placeholders}
          taskId={taskId}
        />
      );
    case 'gemini':
      return (
        <GeminiComposer
          streamId={streamId}
          state={state}
          slashCommands={slashCommands}
          placeholders={placeholders}
          taskId={taskId}
        />
      );
    case 'hermes':
      return (
        <HermesComposer
          streamId={streamId}
          state={state}
          slashCommands={slashCommands}
          placeholders={placeholders}
          taskId={taskId}
        />
      );
    default: {
      const _never: never = agent;
      void _never;
      return null;
    }
  }
}
