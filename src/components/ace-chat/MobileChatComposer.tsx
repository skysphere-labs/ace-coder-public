import {
  useCallback,
  useId,
  useState,
  type ChangeEvent,
  type Ref,
  type ReactNode,
} from 'react';
import { AnimatePresence } from 'framer-motion';
import { Plus } from 'lucide-react';
import type { AgentId } from '../../lib/types';
import { PRUNE_PROMPT } from '../../lib/prune-prompt';
import { openRef } from '../../runtime/pane-layout-registry';
import {
  setTerminalMode,
  toggleTerminal,
  useTerminalState,
} from '../../runtime/terminal-mode';
import { MobileAppearanceSheet } from '../mobile-composer/MobileAppearanceSheet';
import { PlusSheet } from '../mobile-composer/PlusSheet';
import { AppearancePill } from './composers/AppearancePill';
import {
  ComposerShell,
  type ComposerShellHandle,
  type ComposerShellState,
  type SlashCommand,
} from './ComposerShell';
import { DesktopCliAttachmentTray } from './DesktopCliAttachments';
import type { useDesktopCliAttachments } from './useDesktopCliAttachments';

type AttachmentsApi = ReturnType<typeof useDesktopCliAttachments>;

type SheetId = 'plus' | 'appearance' | null;

// Mobile chat composer for the Agents/Hermes lane — the surface that is NOT
// covered by MobileTaskComposer (which only renders inside a workspace task).
// It rides the shared ComposerShell so the slash palette, paste→attach,
// Enter-send and busy/interrupt behaviour are byte-identical to the desktop
// chat composer; the only mobile-specific swap is replacing the desktop attach
// popover with a native `+` → PlusSheet bottom sheet. The send path (sendSubmit
// / slash / optimistic transcript) is owned by the caller and handed in via
// `onSubmit`, so nothing about the agent pipeline changes — even the
// Clean-up-codebase action routes the pruning prompt back through that same
// `onSubmit`. When a `taskId` backs the lane the sheet also exposes the
// task-backed Terminal / Clean-up actions; without one it shows just the Photo
// / File pickers.
export function MobileChatComposer({
  shellRef,
  agent,
  taskId,
  state,
  text,
  onValueChange,
  canSend,
  allowEmptySubmit,
  placeholder,
  busyPlaceholder,
  slashCommands,
  attachments,
  onSubmit,
  onInterrupt,
  leftExtra,
}: {
  shellRef?: Ref<ComposerShellHandle>;
  agent: AgentId | null;
  taskId?: string | null;
  state: ComposerShellState;
  text: string;
  onValueChange: (next: string) => void;
  canSend: boolean;
  allowEmptySubmit: boolean;
  placeholder?: string;
  busyPlaceholder?: string;
  slashCommands: SlashCommand[];
  attachments: AttachmentsApi;
  onSubmit: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  leftExtra?: ReactNode;
}) {
  const [sheet, setSheet] = useState<SheetId>(null);
  const baseId = useId();
  const imageInputId = `mobile-chat-attach-image-${baseId}`;
  const fileInputId = `mobile-chat-attach-file-${baseId}`;
  const terminalState = useTerminalState(taskId ?? null);

  const onAttachInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (!input.files) return;
    attachments.addFiles(Array.from(input.files));
    input.value = '';
    setSheet(null);
  };

  // Terminal opens the task's shared terminal tab — the same registry pattern
  // MobileTaskComposer uses (mode→tab, ensure open, focus the ref). Only wired
  // when a task backs the lane.
  const onOpenTerminal = useCallback(() => {
    setSheet(null);
    if (!taskId) return;
    if (terminalState.mode !== 'tab') setTerminalMode(taskId, 'tab');
    if (!terminalState.open) toggleTerminal(taskId);
    openRef(taskId, { kind: 'terminal' });
  }, [taskId, terminalState.mode, terminalState.open]);

  // Clean-up sends the existing pruning prompt through the caller's submit path
  // (sendSubmit / optimistic transcript), so it behaves exactly like a typed
  // message rather than a raw terminal paste.
  const onCleanupCodebase = useCallback(() => {
    setSheet(null);
    void onSubmit(PRUNE_PROMPT);
  }, [onSubmit]);

  return (
    <>
      {/* Inputs live in the composer so PlusSheet's Photo / File labels can
          target them via htmlFor — sr-only keeps the OS picker reachable on
          iOS Safari (display:none would block it). */}
      <input
        id={imageInputId}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onAttachInputChange}
      />
      <input
        id={fileInputId}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onAttachInputChange}
      />
      <ComposerShell
        ref={shellRef}
        state={state}
        value={text}
        onValueChange={onValueChange}
        canSend={canSend}
        allowEmptySubmit={allowEmptySubmit}
        allowBusySubmit
        placeholder={placeholder}
        busyPlaceholder={busyPlaceholder}
        slashCommands={slashCommands}
        onAttachFiles={attachments.addFiles}
        onAttachPaths={attachments.addPaths}
        leftControls={
          <>
            <button
              type="button"
              aria-label="Attach"
              onClick={() => setSheet('plus')}
              className="flex h-11 w-11 items-center justify-center rounded-full text-foreground/85 transition-colors active:bg-white/[0.08]"
            >
              <Plus className="h-5 w-5" strokeWidth={2} />
            </button>
            {leftExtra}
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
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
      />
      <AnimatePresence>
        {sheet === 'plus' && (
          <PlusSheet
            key="plus"
            agent={agent}
            onClose={() => setSheet(null)}
            // Photo / File render as <label htmlFor> targeting the composer-
            // mounted inputs above, so the OS picker opens straight from the
            // user tap. Terminal / Clean-up appear only when a task backs the
            // lane (otherwise there is nothing for them to act on).
            imageInputId={imageInputId}
            fileInputId={fileInputId}
            onOpenTerminal={taskId ? onOpenTerminal : undefined}
            onCleanupCodebase={taskId ? onCleanupCodebase : undefined}
            onOpenAppearance={() => setSheet('appearance')}
          />
        )}
        {sheet === 'appearance' && (
          <MobileAppearanceSheet key="appearance" onClose={() => setSheet(null)} />
        )}
      </AnimatePresence>
    </>
  );
}
