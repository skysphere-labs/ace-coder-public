import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shield } from 'lucide-react';
import { aceApi, type StreamState } from '../../../lib/ace-api';
import { buildCliAttachmentSubmission } from '../../../lib/cli-attachments';
import { requestChatViewMode } from '../../../runtime/ace-chat-view-mode';
import {
  DesktopCliAttachmentButton,
  DesktopCliAttachmentTray,
} from '../DesktopCliAttachments';
import { useDesktopCliAttachments } from '../useDesktopCliAttachments';
import { ComposerShell, type ComposerShellHandle, type SlashCommand } from '../ComposerShell';
import { useComposerDraft } from '../../../runtime/composer-draft-registry';
import { timePerf } from '../../../runtime/perf-health';
import { AppearancePill } from './AppearancePill';
import { PillButton, PillDot } from './composer-pills';

// Codex's composer is the shell + profile-declared slash commands. Codex's
// PTY accepts bracketed paste fine, so we use the fused sendSubmit for
// parity with Gemini (same backend primitive, one IPC round-trip).
//
// Codex's model/approvals settings are interactive TUI pickers (no argument
// form we can drive blind), so the pills jump the user into the CLI view and
// fire the slash — the same treatment ClaudeComposer gives Claude's picker
// commands. The model readout is reconciled from the live screen: Codex
// prints "model: <name>" in its banner and /status output.
const STATUS_POLL_MS = 1500;

function parseCodexStatus(text: string): { model: string | null } {
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const matches = tail.match(/\bmodel:?\s{0,3}([A-Za-z0-9][A-Za-z0-9._/-]*)/gi);
  if (!matches || matches.length === 0) return { model: null };
  const last = /\bmodel:?\s{0,3}([A-Za-z0-9][A-Za-z0-9._/-]*)/i.exec(
    matches[matches.length - 1]
  );
  return { model: last?.[1] ?? null };
}

export function CodexComposer({
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
  const [model, setModel] = useState<string | null>(null);

  // Reconcile the model readout with whatever the live CLI reports.
  useEffect(() => {
    if (!streamId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await aceApi.streams.readScreen(streamId);
        if (cancelled || !snap?.text) return;
        const parsed = parseCodexStatus(snap.text);
        if (parsed.model) {
          setModel((prev) => (prev === parsed.model ? prev : parsed.model));
        }
      } catch {
        // readScreen can fail before the PTY is attached — try again next tick.
      }
    };
    void tick();
    const handle = window.setInterval(() => void tick(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [streamId]);

  // Codex's /model and /approvals open interactive pickers — flip to the CLI
  // view first so the user lands on the dialog they just requested.
  const openCliPicker = useCallback(
    async (command: string) => {
      requestChatViewMode(streamId, 'cli');
      try {
        await aceApi.streams.slash(streamId, command, []);
      } catch {
        // Command not declared in the profile — nothing to do.
      }
    },
    [streamId]
  );

  const submitBody = useCallback(
    async (body: string) => {
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
          agent: 'codex',
          chars: submission.text.length,
          attachmentCount: attachments.attachments.length,
          slash: submission.text.startsWith('/'),
          state,
        }
      );
    },
    [attachments, state, streamId]
  );
  const slashItems = useMemo<SlashCommand[]>(
    () => slashCommands.map((name) => ({ name })),
    [slashCommands]
  );
  const queryMentionFiles = useCallback(
    async (query: string) => {
      if (!taskId) return [];
      const r = await aceApi.workspaces.searchFiles({ taskId });
      const q = query.toLowerCase();
      return q ? r.files.filter((f) => f.toLowerCase().includes(q)) : r.files;
    },
    [taskId]
  );
  const hasApprovals = slashCommands.includes('approvals');
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
      onMentionQuery={taskId ? queryMentionFiles : undefined}
      leftControls={
        // Attach stays live while busy so Chief can steer a working agent with
        // a file/screenshot, matching send/paste/drop (and Hermes).
        <>
          <DesktopCliAttachmentButton onAddFiles={attachments.addFiles} />
          {hasApprovals && (
            <PillButton
              icon={<Shield className="h-3 w-3" />}
              label="Approvals"
              title="Approval mode — opens the Codex picker"
              onClick={() => void openCliPicker('approvals')}
            />
          )}
          <AppearancePill />
        </>
      }
      rightControls={
        <PillButton
          icon={<PillDot />}
          label={model ?? 'Model'}
          title="Model — opens the Codex picker"
          onClick={() => void openCliPicker('model')}
        />
      }
      aboveInput={
        <DesktopCliAttachmentTray
          attachments={attachments.attachments}
          blockReason={attachments.blockReason}
          onRemove={attachments.removeAttachment}
        />
      }
      onSubmit={submitBody}
      onInterrupt={() => {
        void aceApi.streams.interrupt(streamId);
      }}
    />
  );
}
