// Stream-id resolution + PTY-input helpers with NO xterm dependency.
//
// Split out of terminal-registry so the eager app graph — store →
// workspace-registry, both shells, the mobile composer, WindowBar,
// ActivityPane — can compute stream ids and push PTY input WITHOUT dragging
// the ~580KB xterm chunk into the boot bundle. xterm only loads when a
// terminal surface actually renders (terminal-registry, behind lazy screens).
// terminal-registry re-exports every symbol here so terminal-rendering
// consumers and existing tests keep their import path unchanged.
import { aceApi } from '../lib/ace-api';
import { getCoreSnapshot } from './core-registry';
import {
  sanitizeComposerDraftText,
  sanitizeTerminalInputPayload,
} from './terminal-safety';

export function getTaskStreamId(taskId: string | null): string | null {
  if (!taskId) return null;
  const snapshot = getCoreSnapshot();
  for (const workspace of snapshot.workspaces) {
    const task = [...workspace.tasks, ...workspace.archivedTasks].find(
      (t) => t.id === taskId
    );
    if (!task) continue;

    // Real code tasks run through worktree-backed variants. Those variants are
    // the live streams the user expects to talk to after reopen/restart. Some
    // tasks also retain a conversation row (often dormant) for bookkeeping, but
    // preferring it here routes input to the wrong place and can make the UI
    // look empty/read-only. Threads still use conversations.
    if (task.type === 'task') {
      const firstVariant = task.worktrees?.[0]?.variants?.[0];
      if (firstVariant) return `variant:${firstVariant.id}`;
    }

    const convs = task.conversations ?? [];
    const active = convs.find((c) => c.isActive) ?? convs[0];
    if (active) return `conversation:${active.id}`;

    const firstVariant = task.worktrees?.[0]?.variants?.[0];
    if (firstVariant) return `variant:${firstVariant.id}`;
    return null;
  }
  return null;
}

export function getVariantStreamId(variantId: string): string {
  return `variant:${variantId}`;
}

export function getConversationStreamId(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function writeTerminalInput(streamId: string, data: string) {
  const safe = sanitizeTerminalInputPayload(data);
  return safe === null
    ? Promise.resolve({ ok: false })
    : aceApi.runtime.writeTerminalInput(streamId, safe);
}

// Bracketed paste escapes. Modern terminal apps (bash ≥4.4, zsh, Claude Code, Codex,
// vim, fzf) switch to paste-handling mode between these markers: no
// auto-indent, multi-line preserved atomically, and paste-specific hooks
// fire (e.g. Claude Code's image-path detector). terminal apps without bracketed
// paste support parse them as an unknown CSI and ignore them.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Characters that force single-quoting when a path is pasted literally into
// a shell-ish prompt. Spaces are the common case on Windows (%USERPROFILE%
// often contains spaces); the rest are shell metacharacters.
const PATH_NEEDS_QUOTE = /[\s'"`$&;<>|*?()[\]{}\\]/;

function formatPathForPaste(p: string): string {
  // terminal apps and POSIX shells universally understand forward slashes; Windows
  // CLIs like pwsh and git-bash also accept them. Normalizing avoids every
  // downstream parser having to deal with backslash escaping.
  const fwd = p.replace(/\\/g, '/');
  if (!PATH_NEEDS_QUOTE.test(fwd)) return fwd;
  // POSIX single-quote escape: close the quote, insert an escaped quote,
  // reopen. Safe inside bracketed paste too — the shell's readline sees
  // the whole thing as one pasted token.
  return `'${fwd.replace(/'/g, `'\\''`)}'`;
}

// Unified entry point for every programmatic paste into a PTY. Wraps the
// payload in bracketed paste so the Ace treats it atomically (no per-line
// submit, no auto-indent corruption). Handles mixed image+text clipboards.
export async function pasteToTerminal(
  streamId: string,
  content: { text?: string; imagePath?: string }
): Promise<void> {
  const parts: string[] = [];
  if (content.imagePath) parts.push(formatPathForPaste(content.imagePath));
  const text = content.text ? sanitizeComposerDraftText(content.text) : '';
  if (text) parts.push(text);
  if (parts.length === 0) return;
  const body = parts.join(' ');
  await aceApi.runtime.writeTerminalInput(
    streamId,
    `${PASTE_START}${body}${PASTE_END}`
  );
}

export function pasteAndSubmit(streamId: string, text: string): void {
  void pasteToTerminal(streamId, { text }).then(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = aceApi.core.onPtyData(({ id }) => {
      if (id !== streamId) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        unsub();
        void aceApi.runtime.writeTerminalInput(streamId, '\r');
      }, 200);
    });
  });
}
