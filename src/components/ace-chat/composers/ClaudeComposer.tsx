import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { ArrowUp, File as FileIcon, Shield, Square } from 'lucide-react';
import { dataTransferHasType, filesFromClipboard } from '../../../lib/clipboard';
import { cn } from '../../../lib/utils';
import { aceApi, type StreamState } from '../../../lib/ace-api';
import { buildCliAttachmentSubmission } from '../../../lib/cli-attachments';
import { requestChatViewMode } from '../../../runtime/ace-chat-view-mode';
import {
  DesktopCliAttachmentButton,
  DesktopCliAttachmentTray,
} from '../DesktopCliAttachments';
import { useDesktopCliAttachments } from '../useDesktopCliAttachments';
import { useComposerDraft } from '../../../runtime/composer-draft-registry';
import { timePerf } from '../../../runtime/perf-health';
import { useIsMobileViewport } from '../../../runtime/use-mobile-viewport';
import { AppearancePill } from './AppearancePill';
import { PillDot, PillSelect, type PillOption } from './composer-pills';

// Claude composer. Pills (model, permission) drive the live Claude Code CLI:
// - Model: `/model <name>` slash command via streamSlash.
// - Permission: cycles via Shift+Tab keystrokes through the CLI's modes.
// We poll readScreen on a short interval to keep the pills in sync with
// changes the user makes inside the CLI directly (typing /model, hitting
// Shift+Tab in the terminal, etc.).

const MODEL_CHOICES = [
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'opus', label: 'Opus' },
  { key: 'haiku', label: 'Haiku' },
] as const;

const PERMISSION_CHOICES: readonly PillOption[] = [
  { key: 'default', label: 'Ask before edits', hint: 'Prompt for every tool.' },
  { key: 'acceptEdits', label: 'Auto-accept edits', hint: 'Tools run without prompting.', tone: 'ok' },
  { key: 'plan', label: 'Plan mode', hint: 'Read-only; write a plan.', tone: 'info' },
  { key: 'bypassPermissions', label: 'Bypass permissions', hint: 'No confirmations.', tone: 'accent' },
] as const;

// Cycle order Shift+Tab walks through inside Claude Code. If the CLI's true
// cycle skips bypassPermissions (some versions only toggle the first three),
// the screen poll will correct the pill after a tick.
const PERMISSION_CYCLE: readonly string[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

const STATUS_POLL_MS = 1500;
const USER_ACTION_GRACE_MS = 2500;
const CLAUDE_PICKER_COMMANDS = new Set([
  'model',
  'agents',
  'config',
  'permissions',
  'mcp',
  'init',
  'hooks',
  'login',
  'logout',
  'release-notes',
]);

function parseClaudeStatus(text: string): {
  permissionMode: string | null;
  model: string | null;
} {
  let permissionMode: string | null = null;
  if (/bypass\s+permissions\s+on/i.test(text)) permissionMode = 'bypassPermissions';
  else if (/plan\s+mode\s+on/i.test(text)) permissionMode = 'plan';
  else if (/(?:accept|auto-accept)\s+edits?\s+on/i.test(text)) permissionMode = 'acceptEdits';
  else if (text.length > 0) permissionMode = 'default';

  // Look for the most recent model word in the screen tail. Claude prints
  // the active model in the bottom-right and in /model confirmation lines.
  let model: string | null = null;
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const matches = tail.match(/\b(opus|sonnet|haiku)\b/gi);
  if (matches && matches.length > 0) {
    model = matches[matches.length - 1].toLowerCase();
  }

  return { permissionMode, model };
}

export function ClaudeComposer({
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
  const isMobile = useIsMobileViewport();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autosizeFrameRef = useRef<number | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [mentionState, setMentionState] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const attachments = useDesktopCliAttachments({ taskId });
  const [draggingOver, setDraggingOver] = useState(false);

  const [permissionMode, setPermissionMode] = useState<string>('default');
  const [selectedModel, setSelectedModel] = useState<string>(MODEL_CHOICES[0].key);
  const lastUserActionRef = useRef(0);

  const isBusy = state === 'busy' || state === 'awaiting-approval';

  // Poll the live CLI screen and reconcile pill state with whatever the
  // Claude CLI is actually showing — so /model and Shift+Tab done inside
  // the terminal stay in lockstep with the pills.
  useEffect(() => {
    if (!streamId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await aceApi.streams.readScreen(streamId);
        if (cancelled || !snap?.text) return;
        const sinceAction = Date.now() - lastUserActionRef.current;
        if (sinceAction < USER_ACTION_GRACE_MS) return;
        const parsed = parseClaudeStatus(snap.text);
        if (parsed.permissionMode) {
          setPermissionMode((prev) =>
            prev === parsed.permissionMode ? prev : (parsed.permissionMode as string)
          );
        }
        if (parsed.model) {
          setSelectedModel((prev) => (prev === parsed.model ? prev : (parsed.model as string)));
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

  const applyModel = useCallback(
    async (next: string) => {
      lastUserActionRef.current = Date.now();
      setSelectedModel(next);
      try {
        await aceApi.streams.slash(streamId, 'model', [next]);
      } catch {
        // poll will reconcile if the slash failed.
      }
    },
    [streamId]
  );

  const applyPermissionMode = useCallback(
    async (next: string) => {
      lastUserActionRef.current = Date.now();
      const curIdx = PERMISSION_CYCLE.indexOf(
        permissionMode as typeof PERMISSION_CYCLE[number]
      );
      const nextIdx = PERMISSION_CYCLE.indexOf(next as typeof PERMISSION_CYCLE[number]);
      setPermissionMode(next);
      if (curIdx < 0 || nextIdx < 0 || curIdx === nextIdx) return;
      const delta = (nextIdx - curIdx + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length;
      if (delta === 0) return;
      try {
        await aceApi.streams.sendKeys(streamId, 'shift+tab', delta);
      } catch {
        // poll will reconcile.
      }
    },
    [permissionMode, streamId]
  );

  const autosize = useCallback(() => {
    if (autosizeFrameRef.current != null) cancelAnimationFrame(autosizeFrameRef.current);
    autosizeFrameRef.current = requestAnimationFrame(() => {
      autosizeFrameRef.current = null;
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
    });
  }, []);
  useEffect(autosize, [text, autosize]);
  useEffect(() => () => {
    if (autosizeFrameRef.current != null) cancelAnimationFrame(autosizeFrameRef.current);
  }, []);

  const slashQuery = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const firstLine = text.split('\n', 1)[0];
    if (firstLine.includes(' ')) return null;
    return firstLine.slice(1).toLowerCase();
  }, [text]);

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [] as string[];
    const sorted = [...slashCommands].sort((a, b) => a.localeCompare(b));
    if (!slashQuery) return sorted.slice(0, 50);
    const prefix = sorted.filter((c) => c.toLowerCase().startsWith(slashQuery));
    const rest = sorted.filter(
      (c) => !c.toLowerCase().startsWith(slashQuery) && c.toLowerCase().includes(slashQuery)
    );
    return [...prefix, ...rest].slice(0, 50);
  }, [slashQuery, slashCommands]);

  const slashOpen = slashQuery !== null && filteredCommands.length > 0 && !slashDismissed;
  const [prevSlashQuery, setPrevSlashQuery] = useState(slashQuery);
  if (prevSlashQuery !== slashQuery) {
    setPrevSlashQuery(slashQuery);
    if (slashDismissed) setSlashDismissed(false);
    if (slashIdx !== 0) setSlashIdx(0);
  }

  useEffect(() => {
    if (!taskId || !mentionState) return;
    let cancelled = false;
    aceApi.workspaces
      .searchFiles({ taskId })
      .then((r) => {
        if (cancelled) return;
        const q = mentionState.query.toLowerCase();
        const ranked = q
          ? r.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 12)
          : r.files.slice(0, 12);
        setMentionFiles(ranked);
        setMentionIdx(0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mentionState, taskId]);

  const updateText = (next: string, caretPos?: number) => {
    setText(next);
    const caret = caretPos ?? next.length;
    const before = next.slice(0, caret);
    const m = /@([^\s@]*)$/.exec(before);
    if (m) {
      setMentionState({ start: caret - m[1].length - 1, query: m[1] });
    } else if (mentionState) {
      setMentionState(null);
    }
  };

  const submitText = async (raw: string) => {
    const submission = buildCliAttachmentSubmission(raw, attachments.attachments);
    if (!submission.ok || !submission.text) return;
    const finalText = submission.text;
    const attachmentCount = attachments.attachments.length;
    setText('');
    attachments.clearAttachments();
    setSlashDismissed(false);
    setMentionState(null);
    await timePerf(
      'chat.send',
      async () => {
        const cmdMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/.exec(finalText);
        if (cmdMatch) {
          const [, cmd, rest] = cmdMatch;
          const args = rest ? rest.trim().split(/\s+/) : [];
          if (CLAUDE_PICKER_COMMANDS.has(cmd) && args.length === 0) {
            requestChatViewMode(streamId, 'cli');
          }
          try {
            await aceApi.streams.slash(streamId, cmd, args);
            return;
          } catch {
            // Not a profile-declared slash — send as plain text.
          }
        }
        await aceApi.streams.sendSubmit(streamId, finalText);
      },
      {
        agent: 'claude',
        chars: finalText.length,
        attachmentCount,
        slash: finalText.startsWith('/'),
        state,
      }
    );
  };

  const submit = async () => {
    await submitText(text);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    attachments.addFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    const raw = e.dataTransfer.getData('application/x-ace-paths');
    if (raw) {
      try {
        const paths = JSON.parse(raw) as string[];
        if (Array.isArray(paths) && paths.length > 0) {
          attachments.addPaths(paths);
          return;
        }
      } catch {}
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    attachments.addFiles(files);
  };

  const pickMention = (filePath: string) => {
    if (!mentionState) return;
    const before = text.slice(0, mentionState.start);
    const after = text.slice(mentionState.start + mentionState.query.length + 1);
    const inserted = `@${filePath} `;
    const next = before + inserted + after;
    const newCaret = before.length + inserted.length;
    setText(next);
    setMentionState(null);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCaret, newCaret);
      textareaRef.current?.focus();
    });
  };

  const pickSlash = (name: string) => {
    setText(`/${name} `);
    setSlashDismissed(true);
    textareaRef.current?.focus();
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.isComposing || (e.nativeEvent as KeyboardEvent).isComposing) return;

    if (mentionState && mentionFiles.length > 0) {
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
        setMentionState(null);
        return;
      }
    }

    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pickSlash(filteredCommands[slashIdx]);
        return;
      }
    }

    if (e.key === 'Escape') {
      if (slashOpen) {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (isBusy) {
        e.preventDefault();
        void aceApi.streams.interrupt(streamId);
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await submit();
      return;
    }

    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      lastUserActionRef.current = Date.now();
      const curIdx = PERMISSION_CYCLE.indexOf(
        permissionMode as typeof PERMISSION_CYCLE[number]
      );
      if (curIdx >= 0) {
        const nextId = PERMISSION_CYCLE[(curIdx + 1) % PERMISSION_CYCLE.length];
        setPermissionMode(nextId);
      }
      try {
        await aceApi.streams.sendKeys(streamId, 'shift+tab');
      } catch {
        // poll will reconcile.
      }
    }
  };

  const placeholder = isBusy
    ? placeholders.busy ?? 'Claude is working… press Esc to interrupt'
    : placeholders.default ?? 'Ask Claude anything…';

  return (
    <div className={cn('relative pt-2', isMobile ? 'px-2 pb-2' : 'px-6 pb-4')}>
      <div
        className="mx-auto w-full max-w-3xl"
        onDragOver={(e) => {
          const wants =
            dataTransferHasType(e.dataTransfer, 'application/x-ace-paths') ||
            dataTransferHasType(e.dataTransfer, 'Files');
          if (!wants) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={onDrop}
      >
        {slashOpen && filteredCommands.length > 0 && (
          <SlashPalette items={filteredCommands} activeIndex={slashIdx} onPick={pickSlash} />
        )}
        {mentionState && mentionFiles.length > 0 && (
          <MentionPalette items={mentionFiles} activeIndex={mentionIdx} onPick={pickMention} />
        )}
        <div
          className={cn(
            'ace-composer-shell rounded-2xl p-3',
            draggingOver && 'ace-composer-shell-dragging'
          )}
        >
          <DesktopCliAttachmentTray
            attachments={attachments.attachments}
            blockReason={attachments.blockReason}
            onRemove={attachments.removeAttachment}
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? undefined)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            rows={2}
            spellCheck
            autoCorrect="on"
            autoCapitalize="sentences"
            inputMode="text"
            enterKeyHint="enter"
            className="min-h-[52px] max-h-72 w-full resize-none bg-transparent text-[14px] leading-[1.5] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-1.5">
            {/* Attach stays live while busy: Chief steers a working agent by
                attaching a screenshot/file mid-turn, exactly like typing+send,
                paste, and drop already do. Gating only this button stranded the
                picker behind the busy state. Hermes never gated it. */}
            <DesktopCliAttachmentButton onAddFiles={attachments.addFiles} />
            <PillSelect
              icon={<Shield className="h-3 w-3" />}
              title="Permissions — ⇧⇥ to cycle"
              options={PERMISSION_CHOICES}
              selectedKey={permissionMode}
              onSelect={applyPermissionMode}
            />
            <AppearancePill />
            <div className="ml-auto flex items-center gap-1.5">
              <PillSelect
                icon={<PillDot />}
                title="Model"
                options={MODEL_CHOICES}
                selectedKey={selectedModel}
                onSelect={applyModel}
                align="end"
                optionIcon={<PillDot />}
              />
              {isBusy && !text.trim() && attachments.attachments.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void aceApi.streams.interrupt(streamId)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-[hsl(var(--ace-danger)/0.18)] text-[hsl(var(--ace-danger))] transition-colors hover:bg-[hsl(var(--ace-danger)/0.28)]"
                  title="Interrupt (Esc)"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={
                    (!text.trim() && attachments.attachments.length === 0) ||
                    !!attachments.blockReason
                  }
                  className="ace-composer-send flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-40"
                  title={attachments.blockReason || 'Send (Enter)'}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
        {!isMobile && (
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
            <span className="min-w-0 flex-1 truncate">
              Enter send · Shift+Enter newline · ⇧⇥ mode · @ file
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SlashPalette({
  items,
  activeIndex,
  onPick,
}: {
  items: string[];
  activeIndex: number;
  onPick: (name: string) => void;
}) {
  return (
    <div className="glass-surface absolute bottom-[calc(100%+8px)] left-6 right-6 mx-auto max-h-[min(60vh,420px)] max-w-3xl overflow-y-auto rounded-xl py-1">
      {items.map((name, i) => (
        <button
          key={name}
          type="button"
          onClick={() => onPick(name)}
          className={cn(
            'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px]',
            i === activeIndex
              ? 'bg-white/[0.08] text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <span className="shrink-0 font-mono text-[hsl(var(--ace-info)/0.9)]">/{name}</span>
        </button>
      ))}
    </div>
  );
}

function MentionPalette({
  items,
  activeIndex,
  onPick,
}: {
  items: string[];
  activeIndex: number;
  onPick: (path: string) => void;
}) {
  return (
    <div className="glass-surface absolute bottom-[calc(100%+8px)] left-6 right-6 mx-auto max-w-3xl overflow-hidden rounded-xl py-1">
      {items.map((path, i) => {
        const idx = path.lastIndexOf('/');
        const dir = idx >= 0 ? path.slice(0, idx + 1) : '';
        const name = idx >= 0 ? path.slice(idx + 1) : path;
        return (
          <button
            key={path}
            type="button"
            onClick={() => onPick(path)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px]',
              i === activeIndex ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
            )}
          >
            <FileIcon className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground/80">{dir}</span>
            <span className="text-foreground">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
