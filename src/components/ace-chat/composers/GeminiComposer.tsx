import { useMemo, useRef } from 'react';
import { aceApi, type StreamState } from '../../../lib/ace-api';
import { buildCliAttachmentSubmission } from '../../../lib/cli-attachments';
import {
  DesktopCliAttachmentButton,
  DesktopCliAttachmentTray,
} from '../DesktopCliAttachments';
import { useDesktopCliAttachments } from '../useDesktopCliAttachments';
import { ComposerShell, type ComposerShellHandle, type SlashCommand } from '../ComposerShell';
import { AppearancePill } from './AppearancePill';
import { useComposerDraft } from '../../../runtime/composer-draft-registry';
import { timePerf } from '../../../runtime/perf-health';

// Gemini's composer is identical in chrome to Codex's but routes through
// streams.sendSubmit so the controller inserts the 200ms type-commit delay that
// Gemini's Ink-based input widget requires between typed chars and Enter.
// Splitting sendInput + submit on the renderer races that delay and makes
// Enter land as a newline inside the Ink editor.
export function GeminiComposer({
  streamId,
  state,
  slashCommands,
  placeholders,
  taskId,
}: {
  streamId: string;
  state: StreamState;
  slashCommands: string[];
  placeholders: { default?: string; busy?: string };
  taskId?: string | null;
}) {
  const [text, setText] = useComposerDraft(streamId);
  const composerRef = useRef<ComposerShellHandle | null>(null);
  const attachments = useDesktopCliAttachments({ taskId });
  const slashItems = useMemo<SlashCommand[]>(
    () => slashCommands.map((name) => ({ name })),
    [slashCommands]
  );
  const isBusy = state === 'busy' || state === 'awaiting-approval';
  // Busy doesn't gate sending — let Chief queue a steering message mid-turn.
  const canSend =
    !attachments.blockReason &&
    (text.trim().length > 0 || attachments.attachments.length > 0);
  return (
    <ComposerShell
      ref={composerRef}
      state={isBusy ? 'busy' : 'idle'}
      value={text}
      onValueChange={setText}
      canSend={canSend}
      allowEmptySubmit={attachments.attachments.length > 0}
      allowBusySubmit
      placeholder={placeholders.default}
      busyPlaceholder={placeholders.busy}
      slashCommands={slashItems}
      onAttachFiles={attachments.addFiles}
      onAttachPaths={attachments.addPaths}
      leftControls={
        // Attach stays live while busy so Chief can steer a working agent with
        // a file/screenshot, matching send/paste/drop (and Hermes).
        <>
          <DesktopCliAttachmentButton onAddFiles={attachments.addFiles} />
          <AppearancePill />
        </>
      }
      aboveInput={
        <DesktopCliAttachmentTray
          attachments={attachments.attachments}
          blockReason={attachments.blockReason}
          onRemove={attachments.removeAttachment}
        />
      }
      onSubmit={async (body) => {
        const submission = buildCliAttachmentSubmission(body, attachments.attachments);
        if (!submission.ok) return;
        await timePerf(
          'chat.send',
          async () => {
            const cmdMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/.exec(submission.text);
            if (cmdMatch) {
              const [, cmd, rest] = cmdMatch;
              const args = rest ? rest.trim().split(/\s+/) : [];
              try {
                await aceApi.streams.slash(streamId, cmd, args);
                attachments.clearAttachments();
                return;
              } catch {
                // Command not declared in profile — fall through to plain text.
              }
            }
            await aceApi.streams.sendSubmit(streamId, submission.text);
            attachments.clearAttachments();
          },
          {
            agent: 'gemini',
            chars: submission.text.length,
            attachmentCount: attachments.attachments.length,
            slash: submission.text.startsWith('/'),
            state,
          }
        );
      }}
      onInterrupt={() => {
        void aceApi.streams.interrupt(streamId);
      }}
    />
  );
}
