import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ArrowUp, File as FileIcon, Square } from 'lucide-react';
import { dataTransferHasType, filesFromClipboard } from '../../lib/clipboard';
import { cn } from '../../lib/utils';
import { useIsMobileViewport } from '../../runtime/use-mobile-viewport';

export type ComposerShellState = 'idle' | 'busy';

export type ComposerShellHandle = {
  focus: () => void;
  setText: (text: string) => void;
  getText: () => string;
  submit: () => Promise<void>;
};

export type SlashCommand = { name: string; description?: string };

type Props = {
  state: ComposerShellState;
  canSend?: boolean;
  placeholder?: string;
  busyPlaceholder?: string;
  slashCommands?: SlashCommand[];
  onSubmit: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  allowEmptySubmit?: boolean;
  onAttachFiles?: (files: File[]) => void;
  onAttachPaths?: (paths: string[]) => void;
  leftControls?: ReactNode;
  rightControls?: ReactNode;
  aboveInput?: ReactNode;
  className?: string;
  value?: string;
  onValueChange?: (next: string) => void;
  allowBusySubmit?: boolean;
  onFocusWithin?: () => void;
  /** When provided, `@` in the input opens a file-mention palette fed by
      this query fn (mirrors the Claude composer's @-file mentions). */
  onMentionQuery?: (query: string) => Promise<string[]>;
};

// The shared chrome. Owns:
// - Rounded pill container centered at max-w-3xl
// - Autosizing textarea
// - Radix Popover-driven slash palette (focus trap + outside-click free)
// - Cmd/Ctrl+Enter submit, Enter newline, Escape → close palette or interrupt
// - Send / Interrupt swap by state
//
// Everything Claude-specific (model picker, effort, attachments, mention
// popover, context button) goes in `leftControls`/`rightControls`/`aboveInput`
// slots from the caller. Everything Codex/Gemini-specific likewise. The
// shell stays stupid on purpose.
export const ComposerShell = forwardRef<ComposerShellHandle, Props>(function ComposerShell(
  {
    state,
    canSend,
    placeholder = 'Message the agent',
    busyPlaceholder = 'Agent is working… (Esc to interrupt)',
    slashCommands,
    onSubmit,
    onInterrupt,
    allowEmptySubmit,
    onAttachFiles,
    onAttachPaths,
    leftControls,
    rightControls,
    aboveInput,
    className,
    value,
    onValueChange,
    onFocusWithin,
    onMentionQuery,
  },
  ref
) {
  const controlled = typeof value === 'string';
  const isMobile = useIsMobileViewport();
  const [internalText, setInternalText] = useState('');
  const text = controlled ? (value as string) : internalText;
  const setText = useCallback(
    (next: string) => {
      if (controlled) onValueChange?.(next);
      else setInternalText(next);
    },
    [controlled, onValueChange]
  );
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [draggingOver, setDraggingOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);

  // Lazily resolved so the imperative `submit` always calls the latest
  // memoized handler without re-declaring it before its definition below.
  const submitRef = useRef<() => Promise<void>>(async () => {});

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    setText: (s) => setText(s),
    getText: () => text,
    submit: () => submitRef.current(),
  }));

  // Slash palette query: a leading `/foo` with no space — otherwise the
  // user is typing prose after the command name.
  const slashQuery = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const firstLine = text.split('\n', 1)[0];
    if (firstLine.includes(' ')) return null;
    return firstLine.slice(1).toLowerCase();
  }, [text]);

  const matched = useMemo(() => {
    if (slashQuery === null) return [] as SlashCommand[];
    const pool = slashCommands ?? [];
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    if (!slashQuery) return sorted;
    const prefix = sorted.filter((c) => c.name.toLowerCase().startsWith(slashQuery));
    const rest = sorted.filter(
      (c) => !c.name.toLowerCase().startsWith(slashQuery) && c.name.toLowerCase().includes(slashQuery)
    );
    return [...prefix, ...rest];
  }, [slashQuery, slashCommands]);

  const shouldOpen = slashQuery !== null && matched.length > 0;
  const [prevQuery, setPrevQuery] = useState(slashQuery);
  if (prevQuery !== slashQuery) {
    setPrevQuery(slashQuery);
    setSlashOpen(shouldOpen);
    setSlashIdx(0);
  } else if (slashOpen && !shouldOpen) {
    setSlashOpen(false);
  }

  // Autosize the textarea: reset height, then pin to scrollHeight (capped).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  // @-file mention palette (only when the caller wires onMentionQuery).
  const updateText = (next: string, caret?: number) => {
    setText(next);
    if (!onMentionQuery) return;
    const pos = caret ?? next.length;
    const before = next.slice(0, pos);
    const m = /@([^\s@]*)$/.exec(before);
    if (m) {
      setMention({ start: pos - m[1].length - 1, query: m[1] });
    } else if (mention) {
      setMention(null);
    }
  };

  useEffect(() => {
    if (!onMentionQuery || !mention) return;
    let cancelled = false;
    onMentionQuery(mention.query)
      .then((files) => {
        if (cancelled) return;
        setMentionFiles(files.slice(0, 12));
        setMentionIdx(0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mention, onMentionQuery]);

  const mentionOpen = !!mention && mentionFiles.length > 0;

  const pickMention = (filePath: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + mention.query.length + 1);
    const inserted = `@${filePath} `;
    setText(before + inserted + after);
    setMention(null);
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(caret, caret);
      taRef.current?.focus();
    });
  };

  const isBusy = state === 'busy';
  // Busy doesn't gate sending — a Chief steering during a long agent turn
  // must still be able to push more text down the PTY. We keep the busy
  // *placeholder* so the user knows the agent's working, but the send
  // pathway stays open. Interrupt remains the empty-input affordance.
  const hasInput = text.trim().length > 0 || !!allowEmptySubmit;
  const effectiveCanSend = canSend ?? hasInput;
  const showInterrupt = isBusy && !hasInput;

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    if (!effectiveCanSend) return;
    const body = text.trim();
    if (!body && !allowEmptySubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    setText('');
    setSlashOpen(false);
    try {
      await onSubmit(body);
    } catch (err) {
      setText(text);
      throw err;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [allowEmptySubmit, effectiveCanSend, onSubmit, setText, text]);
  // Keep the imperative handle's submit pointing at the latest closure so a
  // programmatic send is byte-for-byte the same path as the Send button.
  submitRef.current = submit;

  const interrupt = useCallback(() => {
    onInterrupt?.();
  }, [onInterrupt]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => Math.min(i + 1, mentionFiles.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pickMention(mentionFiles[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (slashOpen && matched.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(matched.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const pick = matched[slashIdx];
        if (pick) setText('/' + pick.name + ' ');
        setSlashOpen(false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = matched[slashIdx];
        if (pick) setText('/' + pick.name + ' ');
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (slashOpen) {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      if (isBusy) {
        e.preventDefault();
        interrupt();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachFiles) return;
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    onAttachFiles(files);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const wants =
      dataTransferHasType(e.dataTransfer, 'application/x-ace-paths') ||
      dataTransferHasType(e.dataTransfer, 'Files');
    if (!wants) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDraggingOver(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    const raw = e.dataTransfer.getData('application/x-ace-paths');
    if (raw && onAttachPaths) {
      try {
        const paths = JSON.parse(raw) as string[];
        if (Array.isArray(paths) && paths.length > 0) {
          onAttachPaths(paths);
          return;
        }
      } catch {
        // fall through to files
      }
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) onAttachFiles?.(files);
  };

  return (
    <div className={cn('relative pt-2', isMobile ? 'px-2 pb-2' : 'px-4 pb-4', className)}>
      {mentionOpen && (
        <div className="absolute inset-x-4 bottom-full z-[220] mb-1">
          <div className="glass-surface mx-auto max-h-[min(50vh,360px)] max-w-3xl overflow-y-auto rounded-xl py-1">
            {mentionFiles.map((path, i) => {
              const idx = path.lastIndexOf('/');
              const dir = idx >= 0 ? path.slice(0, idx + 1) : '';
              const name = idx >= 0 ? path.slice(idx + 1) : path;
              return (
                <button
                  key={path}
                  type="button"
                  onMouseEnter={() => setMentionIdx(i)}
                  onClick={() => pickMention(path)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px]',
                    i === mentionIdx ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                  )}
                >
                  <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate text-muted-foreground/80">{dir}</span>
                  <span className="truncate text-foreground">{name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {aboveInput && <div className="mx-auto w-full max-w-3xl">{aboveInput}</div>}
      <PopoverPrimitive.Root open={slashOpen} onOpenChange={setSlashOpen}>
        <PopoverPrimitive.Anchor asChild>
          <div
            className={cn(
              'ace-composer-shell mx-auto flex max-w-3xl items-center gap-2 rounded-2xl px-3 py-2',
              draggingOver && 'ace-composer-shell-dragging'
            )}
            onFocusCapture={onFocusWithin}
            onDragOver={onDragOver}
            onDragLeave={() => setDraggingOver(false)}
            onDrop={onDrop}
          >
            {leftControls && <div className="flex shrink-0 items-center gap-1">{leftControls}</div>}
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? undefined)}
              onKeyDown={onKey}
              onPaste={onPaste}
              rows={1}
              placeholder={isBusy ? busyPlaceholder : placeholder}
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              inputMode="text"
              enterKeyHint="enter"
              className="max-h-72 min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            {rightControls && <div className="flex shrink-0 items-center gap-1">{rightControls}</div>}
            {showInterrupt ? (
              <button
                type="button"
                onClick={interrupt}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/20 text-rose-200 hover:bg-rose-500/30"
                aria-label="Interrupt"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!effectiveCanSend || submitting}
                className="ace-composer-send flex h-8 w-8 items-center justify-center rounded-full text-foreground disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </PopoverPrimitive.Anchor>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            onOpenAutoFocus={(e) => {
              // Keep focus in the textarea so the user can keep typing
              // while the palette is open — matches Claude's chat composer.
              e.preventDefault();
            }}
            className="glass-surface z-[220] max-h-[min(26rem,70vh)] w-[340px] overflow-y-auto rounded-2xl p-1 animate-in fade-in-0 zoom-in-95"
          >
            {matched.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  setText('/' + cmd.name + ' ');
                  setSlashOpen(false);
                  taRef.current?.focus();
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
                  i === slashIdx
                    ? 'bg-white/[0.08] text-foreground'
                    : 'text-foreground/85 hover:bg-white/[0.04]'
                )}
              >
                <span className="mt-0.5 font-mono text-muted-foreground">/</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{cmd.name}</div>
                  {cmd.description && (
                    <div className="truncate text-[11.5px] text-muted-foreground/80">
                      {cmd.description}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {/* Keyboard-shortcut hint is desktop-only — it wastes a line on phones
          where there's no physical Enter/Shift+Enter and the send button is
          the primary affordance. */}
      {!isMobile && (
        <div className="mx-auto mt-1.5 max-w-3xl px-1 text-[10px] text-muted-foreground/60">
          Enter send · Shift+Enter newline · / commands{onMentionQuery ? ' · @ file' : ''}
        </div>
      )}
    </div>
  );
});
