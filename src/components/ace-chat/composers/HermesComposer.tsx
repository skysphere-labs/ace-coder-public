import { useCallback, useMemo, useRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { aceApi, type StreamState } from '../../../lib/ace-api';
import { buildCliAttachmentSubmission } from '../../../lib/cli-attachments';
import {
  DesktopCliAttachmentButton,
  DesktopCliAttachmentTray,
} from '../DesktopCliAttachments';
import { useDesktopCliAttachments } from '../useDesktopCliAttachments';
import { ComposerShell, type ComposerShellHandle, type SlashCommand } from '../ComposerShell';
import { MobileChatComposer } from '../MobileChatComposer';
import {
  appendOptimisticUserEntry,
  confirmOptimisticUserEntry,
  removeOptimisticUserEntry,
} from '../../../runtime/transcript-registry';
import { useComposerDraft } from '../../../runtime/composer-draft-registry';
import { useIsMobileViewport } from '../../../runtime/use-mobile-viewport';
import { timePerf } from '../../../runtime/perf-health';

const REQUIRED_HERMES_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'steer', description: 'Steer the current lane' },
  { name: 'new', description: 'Start a fresh Hermes thread' },
  { name: 'clear', description: 'Clear the current transcript' },
  { name: 'reset', description: 'Reset the current Hermes session' },
  { name: 'help', description: 'Show Hermes command help' },
  { name: 'compact', description: 'Compact the current context' },
  { name: 'model', description: 'Inspect or change the active model' },
  { name: 'status', description: 'Show current Hermes status' },
  { name: 'tools', description: 'List available tool commands' },
  { name: 'skills', description: 'List available skills' },
];

function mergeHermesSlashCommands(commands: string[]): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const command of REQUIRED_HERMES_SLASH_COMMANDS) {
    seen.add(command.name);
    out.push(command);
  }
  for (const name of commands) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}

// Hermes (and Hermes-derived personal lanes Rook/King) ride the same shell
// + attachment pipeline as Codex/Gemini. The PTY accepts bracketed paste
// and Enter-to-submit per electron/ace-control/profiles/hermes.json, so
// the fused streams.sendSubmit matches what the controller expects. Slash
// commands try the profile-declared slash route first, falling back to
// plain text when the command isn't registered.
export function HermesComposer({
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
  const isMobile = useIsMobileViewport();
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
              // Command not declared in profile - fall through to plain text.
            }
          }
          const optimisticEntryId = appendOptimisticUserEntry(streamId, submission.text);
          try {
            await aceApi.streams.sendSubmit(streamId, submission.text);
            confirmOptimisticUserEntry(streamId, optimisticEntryId);
          } catch (err) {
            removeOptimisticUserEntry(streamId, optimisticEntryId);
            throw err;
          }
          attachments.clearAttachments();
        },
        {
          agent: 'hermes',
          chars: submission.text.length,
          attachmentCount: attachments.attachments.length,
          slash: submission.text.startsWith('/'),
          state,
          mobile: isMobile,
        }
      );
    },
    [attachments, isMobile, state, streamId]
  );
  const slashItems = useMemo<SlashCommand[]>(
    () => mergeHermesSlashCommands(slashCommands),
    [slashCommands]
  );
  const isBusy = state === 'busy' || state === 'awaiting-approval';
  // Don't include `!isBusy` here: Chief must be able to steer/queue a new
  // directive while the agent is still thinking. The composer keeps its busy
  // copy so the live state is obvious, but the send pathway stays open.
  const canSend =
    !attachments.blockReason &&
    (text.trim().length > 0 || attachments.attachments.length > 0);
  // On a narrow viewport the Agents/Hermes lane swaps the desktop attach
  // popover for the native + → PlusSheet sheet, but keeps the exact same
  // submitBody (sendSubmit / slash / optimistic transcript) and the Hermes
  // slash menu — so file paste / Photo / File staging and @path submit all
  // work with mobile chrome while the Hermes pipeline is untouched. When a
  // task backs the lane the sheet also exposes its Terminal / Clean-up
  // actions. The mobile workspace-task surface stays on MobileTaskComposer
  // (AceChatPane suppresses this inline composer there).
  if (isMobile) {
    return (
      <MobileChatComposer
        shellRef={composerRef}
        agent="hermes"
        taskId={taskId ?? null}
        state={isBusy ? 'busy' : 'idle'}
        text={text}
        onValueChange={setText}
        canSend={canSend}
        allowEmptySubmit={attachments.attachments.length > 0}
        placeholder={placeholders.default ?? 'Ask Hermes anything…'}
        busyPlaceholder={placeholders.busy}
        slashCommands={slashItems}
        attachments={attachments}
        onSubmit={submitBody}
        onInterrupt={() => {
          void aceApi.streams.interrupt(streamId);
        }}
        leftExtra={
          <HermesSlashCommandMenu
            commands={slashItems}
            onPick={(command) => {
              setText(`/${command.name} `);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />
        }
      />
    );
  }
  return (
    <ComposerShell
      ref={composerRef}
      state={isBusy ? 'busy' : 'idle'}
      value={text}
      onValueChange={setText}
      canSend={canSend}
      allowEmptySubmit={attachments.attachments.length > 0}
      allowBusySubmit
      placeholder={placeholders.default ?? 'Ask Hermes anything…'}
      busyPlaceholder={placeholders.busy}
      slashCommands={slashItems}
      onAttachFiles={attachments.addFiles}
      onAttachPaths={attachments.addPaths}
      leftControls={
        <>
          <DesktopCliAttachmentButton onAddFiles={attachments.addFiles} />
          <HermesSlashCommandMenu
            commands={slashItems}
            onPick={(command) => {
              setText(`/${command.name} `);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />
        </>
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

function HermesSlashCommandMenu({
  commands,
  onPick,
}: {
  commands: SlashCommand[];
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title="Hermes commands"
          aria-label="Hermes commands"
          className="inline-flex h-8 items-center gap-1 rounded-full px-2 font-mono text-[13px] text-foreground/75 transition-colors hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
        >
          /
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          className="glass-surface z-[220] max-h-[min(26rem,70vh)] w-[340px] overflow-y-auto rounded-2xl p-1 animate-in fade-in-0 zoom-in-95"
        >
          {commands.map((command) => (
            <PopoverPrimitive.Close key={command.name} asChild>
              <button
                type="button"
                onClick={() => onPick(command)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 hover:bg-white/[0.06] hover:text-foreground"
              >
                <span className="mt-0.5 font-mono text-muted-foreground">/</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{command.name}</div>
                  {command.description && (
                    <div className="truncate text-[11.5px] text-muted-foreground/80">
                      {command.description}
                    </div>
                  )}
                </div>
              </button>
            </PopoverPrimitive.Close>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
