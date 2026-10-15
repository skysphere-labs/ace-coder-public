import { useMobileKeyboardInset } from '../runtime/use-mobile-viewport';
import { haptic } from '../runtime/haptics';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CornerDownLeft,
  Keyboard,
  LayoutGrid,
  Plus,
} from 'lucide-react';
import { filesFromClipboard } from '../lib/clipboard';
import { cn } from '../lib/utils';
import {
  useFocusedVariant,
  type FocusedChat,
} from '../runtime/focused-variant-registry';
import {
  pasteAndSubmit,
  pasteToTerminal,
  writeTerminalInput,
} from '../runtime/terminal-io';
import { setTerminalMode, toggleTerminal, useTerminalState } from '../runtime/terminal-mode';
import { openRef } from '../runtime/pane-layout-registry';
import { useCoreSelector } from '../runtime/core-registry';
import { useChatAvailable } from '../runtime/transcript-registry';
import { isAceChatAgent, useAceChatMode } from '../runtime/ace-chat-mode-registry';
import { useComposerDraft } from '../runtime/composer-draft-registry';
import { PRUNE_PROMPT } from '../lib/prune-prompt';
import { buildCliAttachmentSubmission } from '../lib/cli-attachments';
import { dedupeComposedValue, shouldCommitComposerInput } from './mobile-composer/composition';
import { MobileAppearanceSheet } from './mobile-composer/MobileAppearanceSheet';
import { PlusSheet } from './mobile-composer/PlusSheet';
import { TerminalKeyBar } from './mobile-composer/TerminalKeyBar';
import { DesktopCliAttachmentTray } from './ace-chat/DesktopCliAttachments';
import { useDesktopCliAttachments } from './ace-chat/useDesktopCliAttachments';
import { ViewToggle } from './ace-chat/ViewToggle';

type Props = {
  taskId: string;
  onTabsClick: () => void;
};

// Mobile composer — terminal-only. Writes to the focused variant/conversation
// PTY stream via bracketed paste + CR. The SDK-backed chat mode that this
// composer used to carry was removed along with the Claude SDK.
export function MobileTaskComposer({ taskId, onTabsClick }: Props) {
  const focused = useFocusedVariant(taskId);
  return (
    <ComposerBar
      key={focused?.scopeId ?? 'none'}
      taskId={taskId}
      focused={focused}
      onTabsClick={onTabsClick}
    />
  );
}

type ComposerBarProps = {
  taskId: string;
  focused: FocusedChat | null;
  onTabsClick: () => void;
};

type SheetId = 'plus' | 'appearance' | null;

function ComposerBar({ taskId, focused, onTabsClick }: ComposerBarProps) {
  const terminalState = useTerminalState(taskId);
  const chatAgent = focused && isAceChatAgent(focused.agent) ? focused.agent : null;
  const chatAvailable = useChatAvailable(chatAgent ? focused?.streamId ?? null : null);
  const isRemoteWorkspace = useCoreSelector((snap) => {
    for (const ws of snap.workspaces) {
      const all = [...ws.tasks, ...ws.archivedTasks];
      if (all.some((t) => t.id === taskId)) return ws.isRemote === true;
    }
    return false;
  });
  const chatModeScopeKey = focused?.streamId ?? null;
  const [chatMode, setChatMode] = useAceChatMode(chatAgent, chatModeScopeKey);
  // Draft text persists across navigation/unmount, keyed by the focused stream,
  // so typed-but-unsent text survives a view switch and restores on return
  // (an empty key — no focused stream — is ephemeral). Sending clears it.
  const [text, setText] = useComposerDraft(focused?.streamId ?? '');
  const [sheet, setSheet] = useState<SheetId>(null);
  const [keyBarOpen, setKeyBarOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const autosizeFrameRef = useRef<number | null>(null);
  const submittingRef = useRef(false);

  const attachments = useDesktopCliAttachments({ taskId });
  const baseId = useId();
  const imageInputId = `mobile-attach-image-${baseId}`;
  const fileInputId = `mobile-attach-file-${baseId}`;

  const hasAttachments = attachments.attachments.length > 0;
  // Terminal mode: empty send is still meaningful (fires bare Return), so the
  // button stays live whenever a stream is focused. With staged attachments,
  // sending always carries the @paths even if the textarea is empty.
  const canSend = !!focused;
  const showChatToggle = !!chatAgent && chatAvailable && !isRemoteWorkspace;

  const autosize = useCallback(() => {
    if (autosizeFrameRef.current != null) cancelAnimationFrame(autosizeFrameRef.current);
    autosizeFrameRef.current = requestAnimationFrame(() => {
      autosizeFrameRef.current = null;
      const el = textareaRef.current;
      if (!el) return;
      const isLandscape =
        typeof window !== 'undefined' &&
        window.matchMedia('(orientation: landscape)').matches;
      const cap = isLandscape ? 88 : 160;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    });
  }, []);
  useEffect(autosize, [text, autosize]);
  // Re-run autosize when the soft keyboard opens/closes: the visual viewport
  // change can land while a pending autosize frame measured the old layout.
  const keyboardInset = useMobileKeyboardInset();
  useEffect(autosize, [keyboardInset, autosize]);
  useEffect(() => () => {
    if (autosizeFrameRef.current != null) cancelAnimationFrame(autosizeFrameRef.current);
  }, []);

  const submit = useCallback(async () => {
    if (!focused) return;
    // Re-entrancy guard: a staged @path travels on the awaited pasteToTerminal
    // call, which is a network round-trip on a remote workspace, and the Send
    // button never disables. Without this, a second tap during that round-trip
    // re-enters submit() with the still-staged attachment and pastes the same
    // @path again — the CLI then renders [Image #1] twice. Held for the whole
    // send and reset in finally so a failed paste can't wedge the composer.
    if (submittingRef.current) return;
    // Build the @paths-prefixed payload up front so a staged attachment can
    // travel with whatever text the user typed (or with no text at all).
    // Block silently while uploads are still in flight or failed — the tray
    // already surfaces the reason inline.
    const submission = buildCliAttachmentSubmission(text, attachments.attachments);
    if (!submission.ok) return;
    submittingRef.current = true;
    try {
      const payload = submission.text;
      // Wrap in bracketed paste so multi-line text stays atomic — terminal apps see one
      // paste event instead of a line submit per newline — then send CR. With
      // no draft and no attachments, this acts like a bare Return (common for
      // Ace prompts).
      if (payload) {
        await pasteToTerminal(focused.streamId, { text: payload });
        setText('');
        if (hasAttachments) attachments.clearAttachments();
      }
      writeTerminalInput(focused.streamId, '\r');
      haptic('tick');
    } finally {
      submittingRef.current = false;
    }
  }, [attachments, focused, hasAttachments, text, setText]);

  const onTextareaPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    attachments.addFiles(files);
  };

  const onAttachInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (!input.files) return;
    attachments.addFiles(Array.from(input.files));
    input.value = '';
    setSheet(null);
  };

  const onTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    // Commit every input EXCEPT the intermediate states of an active IME
    // composition. Gating on the browser's authoritative isComposing flag
    // (not a manually-held ref) means an autocorrect / keyboard-suggestion
    // commit — which fires no compositionend — always reaches state, so the
    // visible textarea can never wedge. See shouldCommitComposerInput.
    if (!shouldCommitComposerInput((e.nativeEvent as InputEvent).isComposing)) return;
    setText(e.target.value);
  };

  const onCompositionStart = () => {
    composingRef.current = true;
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const final = e.currentTarget.value;
    const fixed = dedupeComposedValue(final, e.data);
    // Mutate the DOM value too so a trailing change event can't re-introduce
    // the stripped duplicate.
    if (fixed !== final) e.currentTarget.value = fixed;
    setText(fixed);
    autosize();
  };

  const onInput = () => {
    if (composingRef.current) autosize();
  };

  const onOpenTerminal = useCallback(() => {
    setSheet(null);
    if (terminalState.mode !== 'tab') setTerminalMode(taskId, 'tab');
    if (!terminalState.open) toggleTerminal(taskId);
    if (taskId) openRef(taskId, { kind: 'terminal' });
  }, [taskId, terminalState.mode, terminalState.open]);

  const onCleanupCodebase = useCallback(() => {
    setSheet(null);
    if (!focused) return;
    pasteAndSubmit(focused.streamId, PRUNE_PROMPT);
  }, [focused]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.isComposing || (e.nativeEvent as KeyboardEvent).isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const placeholder = !focused ? 'Open a tab to start…' : 'Send to terminal…';

  return (
    <>
      <AnimatePresence initial={false}>
        {showChatToggle && (
          <motion.div
            key="mobile-chat-toggle"
            initial={{ height: 0, opacity: 0, marginBottom: 0 }}
            animate={{ height: 'auto', opacity: 1, marginBottom: 6 }}
            exit={{ height: 0, opacity: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="flex justify-center overflow-hidden"
          >
            <ViewToggle
              kind={chatMode}
              onChange={setChatMode}
              showLabels
              className="mobile-composer-pill border-white/[0.07] bg-transparent"
            />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {focused && keyBarOpen && (
          <motion.div
            key="ace-keybar"
            initial={{ height: 0, opacity: 0, marginBottom: 0 }}
            animate={{ height: 'auto', opacity: 1, marginBottom: 6 }}
            exit={{ height: 0, opacity: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <TerminalKeyBar streamId={focused.streamId} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {(hasAttachments || attachments.blockReason) && (
          <motion.div
            key="mobile-attach-tray"
            initial={{ height: 0, opacity: 0, marginBottom: 0 }}
            animate={{ height: 'auto', opacity: 1, marginBottom: 6 }}
            exit={{ height: 0, opacity: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden px-2"
          >
            <DesktopCliAttachmentTray
              attachments={attachments.attachments}
              blockReason={attachments.blockReason}
              onRemove={attachments.removeAttachment}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Inputs are mounted in the composer itself so PlusSheet labels can
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
      <div className="relative flex items-center gap-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="mobile-composer-pill flex min-w-0 flex-1 items-end gap-1 rounded-[22px] p-1.5"
        >
          {/* Secondary controls are bare glyphs — no filled-circle chrome.
              The one filled element in the field is the send action. */}
          <button
            type="button"
            aria-label="Attach"
            onClick={() => {
              haptic('tick');
              setSheet('plus');
            }}
            disabled={!focused}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--m-text-tertiary)] transition-colors active:text-[var(--m-text)] disabled:opacity-40"
          >
            <Plus className="h-[21px] w-[21px]" strokeWidth={1.9} />
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={onTextareaChange}
              onKeyDown={onKeyDown}
              onPaste={onTextareaPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onInput={onInput}
              placeholder={placeholder}
              rows={1}
              disabled={!focused}
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              inputMode="text"
              enterKeyHint="send"
              className="max-h-[160px] min-h-[40px] w-full resize-none bg-transparent px-1 text-[15px] leading-[1.45] text-foreground caret-[var(--m-accent)] placeholder:text-[var(--m-text-tertiary)] outline-none disabled:opacity-50 landscape:max-h-[88px]"
            />
          </div>
          <button
            type="button"
            aria-label={keyBarOpen ? 'Hide keys' : 'Show keys'}
            aria-pressed={keyBarOpen}
            onClick={() => {
              haptic('tick');
              setKeyBarOpen((v) => !v);
            }}
            disabled={!focused}
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
              keyBarOpen
                ? 'text-[var(--m-accent)]'
                : 'text-[var(--m-text-tertiary)] active:text-[var(--m-text)]'
            )}
          >
            <Keyboard className="h-[20px] w-[20px]" strokeWidth={1.9} />
          </button>
          {/* 44px hit target around a 36px visual — a full-bleed 44px filled
              circle reads heavy next to bare glyphs; the inset disc reads
              precise (the iMessage-send proportion). */}
          <button
            type="submit"
            aria-label="Return"
            disabled={!focused || !canSend}
            className="flex h-11 w-11 shrink-0 items-center justify-center"
          >
            <span
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
                canSend ? 'm-accent-btn' : 'text-foreground/40'
              )}
            >
              <CornerDownLeft className="h-[17px] w-[17px]" strokeWidth={2.25} />
            </span>
          </button>
        </form>
        <button
          type="button"
          aria-label="Tabs"
          onClick={() => {
            haptic('tick');
            onTabsClick();
          }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--m-text-tertiary)] transition-colors active:text-[var(--m-text)]"
        >
          <LayoutGrid className="h-[20px] w-[20px]" strokeWidth={1.8} />
        </button>
      </div>

      <AnimatePresence>
        {sheet === 'plus' && (
          <PlusSheet
            key="plus"
            agent={focused?.agent ?? null}
            onClose={() => setSheet(null)}
            // The Photo / File rows are rendered as <label htmlFor> targeting
            // the composer-mounted file inputs above, so the OS picker opens
            // directly from the user tap. Keep the sheet mounted until
            // onChange receives the selected files; closing during the label
            // click can cancel picker activation on mobile Safari.
            imageInputId={imageInputId}
            fileInputId={fileInputId}
            onOpenTerminal={onOpenTerminal}
            onCleanupCodebase={onCleanupCodebase}
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
