import { useEffect, useSyncExternalStore } from 'react';
// xterm's stylesheet rides with this module (NOT the eager entry) so the
// 570KB xterm chunk stays off the boot path; vite injects the CSS when the
// first terminal surface loads this chunk.
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import type { TerminalSyncPayload } from '../lib/ace-api';
import { getTerminalThemeOverride, isTouchOrRemoteClient } from '../lib/agent-style';
import { writeClipboard } from '../lib/clipboard';
import { getCoreSnapshot } from './core-registry';
import {
  MOBILE_TERMINAL_COLS,
  mobileTerminalFontSize,
} from './terminal-mobile-fit';
import {
  clientTerminalScrollback,
  sanitizeTerminalDimensions,
  sanitizeTerminalInputPayload,
} from './terminal-safety';
import { createWebglPool } from './terminal-webgl-pool';
// xterm-free stream-id + PTY-input helpers. Kept in a sibling module so the
// eager boot graph can import them without pulling xterm; re-exported here so
// terminal-rendering consumers and tests keep the existing import path.
import {
  createParkedBuffer,
  drainParked,
  pushParked,
  recoverFromOverflow,
  snapshotDecision,
} from './terminal-parked-buffer';
import type { ParkedBuffer } from './terminal-parked-buffer';
import {
  getTaskStreamId,
  getVariantStreamId,
  getConversationStreamId,
  writeTerminalInput,
  pasteToTerminal,
  pasteAndSubmit,
} from './terminal-io';
export {
  getTaskStreamId,
  getVariantStreamId,
  getConversationStreamId,
  writeTerminalInput,
  pasteToTerminal,
  pasteAndSubmit,
};

type SessionStatus = 'running' | 'exited';

type TerminalSession = {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  wrapper: HTMLDivElement;
  webglAddon: WebglAddon | null;
  status: SessionStatus;
  attached: boolean;
  opened: boolean;
  ptySpawned: boolean;
  lastPtyCols: number;
  lastPtyRows: number;
  resizeXTimer: number | null;
  latestResizeX: number;
  lastSeq: number;
  syncing: boolean;
  pendingSyncChunks: Array<{ chunk: string; seq?: number }>;
  parked: ParkedBuffer;
};

const sessions = new Map<string, TerminalSession>();
const statusListeners = new Map<string, Set<() => void>>();
let host: HTMLDivElement | null = null;
let hydrated = false;

function focusTerminalInput(wrapper: HTMLDivElement, terminal: Terminal) {
  const textarea = wrapper.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  if (textarea) {
    try {
      textarea.focus({ preventScroll: true });
    } catch {
      try {
        textarea.focus();
      } catch {}
    }
  }
  try {
    terminal.focus();
  } catch {}
}


function ensureHost(): HTMLDivElement {
  if (host) return host;
  const el = document.createElement('div');
  el.setAttribute('data-ace-terminal-host', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0px',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '-1',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  host = el;
  return el;
}

const BASE_THEME = {
  foreground: '#f9fafb',
  cursor: '#f9fafb',
  black: '#111111',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#67e8f9',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f9fafb',
};

const FALLBACK_FONTS = 'Menlo, Monaco, "Courier New", monospace';

// Touch/remote clients (phone PWA, remote browser) used to be forced onto
// xterm's DOM renderer, which repaints whole rows per 16ms PTY frame on
// exactly the hardware least able to afford it — the single biggest source of
// mobile CLI streaming lag. They render WebGL like desktop (with the
// try/catch + context-loss DOM fallback below); their opaque surface color
// comes from getTerminalThemeOverride (touch-aware in agent-style).

let lastOpenedLinkUri = '';
let lastOpenedLinkAt = 0;

function openTerminalLink(event: MouseEvent | undefined, uri: string) {
  // Web links only — OSC 8 lets a CLI attach arbitrary schemes to text, and
  // shelling out to anything but a browser from terminal output is a footgun.
  if (!/^https?:\/\//i.test(uri)) return;
  event?.preventDefault();
  // Touch taps route here twice: once from the touch handler, once from the
  // browser's synthesized click through the web-links addon. One tab, not two.
  const now = Date.now();
  if (uri === lastOpenedLinkUri && now - lastOpenedLinkAt < 800) return;
  lastOpenedLinkUri = uri;
  lastOpenedLinkAt = now;
  void aceApi.workspaces.openExternal(uri, { forceExternal: true }).catch(() => {
    try {
      window.open(uri, '_blank', 'noopener,noreferrer');
    } catch {}
  });
}

// URL shape the tap-to-open path recognizes in buffer text. Mirrors the
// WebLinksAddon's matcher closely enough for CLI output; trailing prose
// punctuation is stripped after the match.
const TAP_URL_RE = /https?:\/\/[^\s"'`<>]+/gi;
const TAP_URL_TRAILING = /[.,;:!?)\]}"'`]+$/;

// Resolve the URL under a touch point. xterm's linkifier only activates on
// real mouse hover+click, which touch taps don't reliably synthesize (and our
// touch-scroll handler owns the gesture anyway), so we do the lookup by hand:
// map the tap to a buffer cell, join the wrapped-line run around it, and test
// URL matches against the tapped offset.
function findLinkAtCoords(
  terminal: Terminal,
  wrapper: HTMLElement,
  clientX: number,
  clientY: number
): string | null {
  const screen = wrapper.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (
    clientX < rect.left ||
    clientX >= rect.right ||
    clientY < rect.top ||
    clientY >= rect.bottom
  ) {
    return null;
  }
  const col = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows);
  const buffer = terminal.buffer.active;
  const absRow = buffer.viewportY + row;
  if (!buffer.getLine(absRow)) return null;

  // Wrapped lines are full-width by definition, so joining un-trimmed line
  // text keeps `row * cols + col` a valid offset into the joined string.
  let startRow = absRow;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow -= 1;
  let endRow = absRow;
  while (buffer.getLine(endRow + 1)?.isWrapped) endRow += 1;
  let joined = '';
  for (let r = startRow; r <= endRow; r += 1) {
    joined += buffer.getLine(r)?.translateToString(false) ?? '';
  }
  const tappedIdx = (absRow - startRow) * terminal.cols + col;

  TAP_URL_RE.lastIndex = 0;
  for (let m = TAP_URL_RE.exec(joined); m; m = TAP_URL_RE.exec(joined)) {
    const uri = m[0].replace(TAP_URL_TRAILING, '');
    const start = m.index;
    const end = start + uri.length;
    if (tappedIdx >= start && tappedIdx < end) return uri;
    if (start > tappedIdx) break;
  }
  return null;
}

function createSession(streamId: string): TerminalSession {
  const terminal = new Terminal({
    cols: 100,
    rows: 28,
    // Touch 1500 / desktop 5000 — the same value the client advertises in
    // pty:subscribe / pty:requestSync so server snapshots are serialized at
    // the depth this xterm will actually keep (see terminal-safety).
    scrollback: clientTerminalScrollback(),
    fontSize: 13,
    fontFamily: FALLBACK_FONTS,
    // xterm default line-height. 1.2 made every row ~20% taller, leaving the
    // Hermes/Rook/King CLI streaming output looking spaced-out and pushing
    // the bottom cursor row partly under the composer gradient.
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorBlink: true,
    // Every theme background is opaque by design now — desktop charcoal (see
    // TERMINAL_BG) and touch graphite alike — so both renderers take their
    // opaque fast paths on every client.
    allowTransparency: false,
    allowProposedApi: true,
    scrollOnUserInput: false,
    // VS Code enables this so a full clear (\x1b[2J) snaps the viewport to the
    // bottom. But agent TUIs (Claude Code) emit erase-in-display on EVERY
    // streaming repaint, so it yanks a reader who scrolled up back to the
    // bottom several times a second — the owner's "can't scroll up while the
    // agent is working" complaint, first on the phone and then on desktop
    // (which had kept VS Code's snap and read as unresponsive scrolling).
    // Nobody snaps now; the "jump to live" chip is the way back down.
    scrollOnEraseInDisplay: false,
    // OSC 8 hyperlinks (Claude/Codex emit them for docs + PR links). The
    // WebLinksAddon below only linkifies plain-text URLs; without this,
    // escape-sequence hyperlinks render as dead text.
    linkHandler: {
      activate: (event, text) => openTerminalLink(event, text),
    },
    theme: {
      ...BASE_THEME,
      // Surface + palette-black blend, per shell: desktop warm charcoal,
      // touch/remote indigo graphite (see agent-style).
      ...getTerminalThemeOverride(),
    },
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === 'c' && !event.shiftKey) {
      if (terminal.hasSelection()) {
        const sel = terminal.getSelection();
        void writeClipboard(sel);
        terminal.clearSelection();
        event.preventDefault();
        return false;
      }
      return true;
    }
    return true;
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon(openTerminalLink));

  const wrapper = document.createElement('div');
  wrapper.className = 'ace-terminal-session h-full w-full';
  Object.assign(wrapper.style, {
    width: '100%',
    height: '100%',
    display: 'block',
  } as Partial<CSSStyleDeclaration>);
  ensureHost().appendChild(wrapper);

  const session: TerminalSession = {
    id: streamId,
    terminal,
    fitAddon,
    webglAddon: null,
    wrapper,
    status: 'running',
    attached: false,
    opened: false,
    ptySpawned: false,
    lastPtyCols: 0,
    lastPtyRows: 0,
    resizeXTimer: null,
    latestResizeX: 0,
    lastSeq: 0,
    syncing: false,
    pendingSyncChunks: [],
    parked: createParkedBuffer(),
  };
  sessions.set(streamId, session);

  terminal.onData((data) => {
    if (!session.attached) return;
    const safe = sanitizeTerminalInputPayload(data);
    if (safe === null) return;
    void aceApi.runtime.writeTerminalInput(streamId, safe);
  });

  wrapper.addEventListener(
    'paste',
    (event) => {
      if (!session.attached) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const items = clipboard.items ? Array.from(clipboard.items) : [];
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      // Pure text: let xterm handle it (it applies bracketed paste on its own
      // when the PTY has enabled ?2004h). We only intercept when there's an
      // image, because xterm has no native image support.
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      const accompanyingText = clipboard.getData('text/plain') || '';
      void handleImagePaste(session, streamId, file, imageItem.type, accompanyingText);
    },
    true
  );

  attachTouchScroll(wrapper, terminal);

  return session;
}

async function handleImagePaste(
  session: TerminalSession,
  streamId: string,
  file: File,
  mime: string,
  accompanyingText: string
): Promise<void> {
  const ext = mimeToExt(mime);
  const { remote, taskId } = resolveStreamRemote(streamId);
  try {
    if (file.size === 0) {
      showPasteNotice(session.wrapper, 'Image paste was empty', 'error');
      return;
    }
    // Match useDesktopCliAttachments: pass base64 so the bytes survive both
    // Electron IPC and the HTTP/PWA JSON bridge.
    const base64 = await fileToBase64(file);
    if (!base64) {
      showPasteNotice(session.wrapper, 'Image paste was empty', 'error');
      return;
    }
    const result =
      remote && taskId
        ? await aceApi.runtime.pasteClipboardImageRemote(taskId, base64, ext)
        : await aceApi.runtime.pasteClipboardImage(base64, ext);
    if (!result?.path) {
      showPasteNotice(session.wrapper, result?.error || 'Image paste failed', 'error');
      return;
    }
    await pasteToTerminal(streamId, {
      imagePath: result.path,
      text: accompanyingText,
    });
    showPasteNotice(session.wrapper, basename(result.path), 'ok');
  } catch (err) {
    console.error('[ace] image paste failed:', err);
    const msg = err instanceof Error ? err.message : 'Image paste failed';
    showPasteNotice(session.wrapper, msg, 'error');
  }
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

// xterm.js has no touch handlers (confirmed by grepping its source). Its
// viewport uses VS Code's custom SmoothScrollableElement which only listens
// to wheel events. On mobile/iPad, touch-drag inside the terminal does
// nothing — the user's only option is to grab the scrollbar. This attaches
// touch listeners that convert finger drag to terminal.scrollLines() calls.
function attachTouchScroll(wrapper: HTMLDivElement, terminal: Terminal) {
  if (typeof window === 'undefined') return;
  const isTouchEnv =
    document.documentElement.classList.contains('ace-touch') ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  if (!isTouchEnv) return;

  // Pixels of finger movement per line of scroll. Lower = faster scroll.
  // Cell height is typically ~16-22px; 10px makes a swipe feel 2x faster
  // than 1:1 which matches native iOS inertial scrolling.
  const PX_PER_LINE = 10;
  const MOMENTUM_DECAY = 0.97;
  const MOMENTUM_STOP = 0.3;
  // Cap flick velocity (px per 16ms frame): dt is clamped to 1ms, so a
  // slow-device event burst can compute an absurd spike that launches the
  // scrollback. 90 is faster than any real flick.
  const MAX_VELOCITY = 90;

  let startX = 0;
  let startY = 0;
  let accumulated = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let momentumFrame: number | null = null;
  let active = false;

  function cancelMomentum() {
    if (momentumFrame !== null) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
    }
  }

  function momentumStep() {
    momentumFrame = null;
    if (Math.abs(velocity) < MOMENTUM_STOP) return;
    accumulated += -velocity;
    const lines = Math.trunc(accumulated / PX_PER_LINE);
    if (lines !== 0) {
      try { terminal.scrollLines(lines); } catch {}
      accumulated -= lines * PX_PER_LINE;
    }
    velocity *= MOMENTUM_DECAY;
    momentumFrame = requestAnimationFrame(momentumStep);
  }

  wrapper.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      cancelMomentum();
      active = true;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      lastY = startY;
      lastTime = performance.now();
      velocity = 0;
      accumulated = 0;
    },
    { passive: true }
  );

  wrapper.addEventListener(
    'touchmove',
    (event) => {
      if (!active || event.touches.length !== 1) return;
      if (event.cancelable) event.preventDefault();
      const y = event.touches[0].clientY;
      const dy = y - lastY;
      const now = performance.now();
      const dt = Math.max(1, now - lastTime);
      velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dy / (dt / 16)));
      lastY = y;
      lastTime = now;
      accumulated += -dy;
      const lines = Math.trunc(accumulated / PX_PER_LINE);
      if (lines !== 0) {
        try { terminal.scrollLines(lines); } catch {}
        accumulated -= lines * PX_PER_LINE;
      }
    },
    { passive: false }
  );

  const end = () => {
    if (!active) return;
    active = false;
    const total = Math.abs(lastY - startY);
    if (total <= 10) {
      // A tap. If it landed on a URL, open it on this device (the phone's
      // own browser tab for remote clients) instead of focusing the input —
      // popping the keyboard over a navigation reads as a misfire.
      const link = findLinkAtCoords(terminal, wrapper, startX, startY);
      if (link) {
        openTerminalLink(undefined, link);
        return;
      }
      focusTerminalInput(wrapper, terminal);
      return;
    }
    if (total > 10 && Math.abs(velocity) > 1) {
      momentumFrame = requestAnimationFrame(momentumStep);
    }
  };
  wrapper.addEventListener('touchend', end, { passive: true });
  wrapper.addEventListener('touchcancel', end, { passive: true });
}

function mimeToExt(mime: string): string {
  const sub = mime.split('/')[1] ?? 'png';
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub.replace(/[^a-z0-9]/gi, '') || 'png';
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = data.indexOf(',');
      resolve(comma >= 0 ? data.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function resolveStreamRemote(streamId: string): {
  remote: boolean;
  taskId: string | null;
} {
  const match = /^(variant|conversation|shell):(.+)$/.exec(streamId);
  if (!match) return { remote: false, taskId: null };
  const [, kind, id] = match;
  const snapshot = getCoreSnapshot();
  for (const ws of snapshot.workspaces) {
    const tasks = [...ws.tasks, ...ws.archivedTasks];
    for (const task of tasks) {
      if (kind === 'shell' && task.id === id) {
        return { remote: ws.isRemote, taskId: task.id };
      }
      if (kind === 'conversation') {
        const conv = (task.conversations ?? []).find((c) => c.id === id);
        if (conv) return { remote: ws.isRemote, taskId: task.id };
      }
      if (kind === 'variant') {
        for (const wt of task.worktrees ?? []) {
          const variant = wt.variants.find((v) => v.id === id);
          if (variant) return { remote: ws.isRemote, taskId: task.id };
        }
      }
    }
  }
  return { remote: false, taskId: null };
}

export function openSessionIfNeeded(session: TerminalSession) {
  if (session.opened) return;
  session.opened = true;
  session.terminal.open(session.wrapper);
}

// Every terminal takes the WebGL fast path; the DOM renderer is only the
// over-budget / init-failure / context-loss fallback. Pool rationale and
// eviction rules live in terminal-webgl-pool.ts. Parked sessions keep their
// context warm (instant re-attach); the pool retires LRU holders itself.
// Budget per client: desktop Chromium caps ~16 live contexts per renderer;
// iOS Safari (phone PWA) caps far lower and sheds under memory pressure —
// it shows one pane at a time, so 4 warm contexts cover it.
function webglSessionBudget(): number {
  return isTouchOrRemoteClient() ? 4 : 12;
}
const MAX_WEBGL_SESSIONS = webglSessionBudget();

const webglPool = createWebglPool<TerminalSession>(MAX_WEBGL_SESSIONS, {
  create: (session) => attachWebglAddon(session),
  destroy: (session) => detachWebglAddon(session),
});

export function acquireWebglRenderer(session: TerminalSession) {
  // The addon needs xterm's screen element; loading before open() throws.
  if (!session.opened) return;
  webglPool.acquire(session);
}

// Retire a session's GPU renderer — on park (TerminalFeed cleanup), budget
// eviction, or teardown. Idempotent.
export function releaseWebglRenderer(session: TerminalSession) {
  webglPool.release(session);
}

function attachWebglAddon(session: TerminalSession): boolean {
  // No addon is live here, so ANY canvas in the wrapper is an orphan from a
  // dead one (a dispose that threw mid-teardown, an OS-evicted context whose
  // canvas stayed). An orphan sits frozen on its last frame ABOVE the DOM
  // renderer's live rows — seen on the phone as "two screens", half the
  // terminal scrolling while the other half stands still. Sweep before
  // creating the replacement.
  removeWrapperCanvases(session);
  let created: WebglAddon | null = null;
  try {
    const webgl = new WebglAddon();
    created = webgl;
    webgl.onContextLoss(() => {
      webgl.dispose();
      // Only the session's CURRENT addon may vacate the slot and schedule a
      // rearm. A deliberately retired addon (budget eviction / park) firing
      // late must not touch a successor or re-enter the pool — release nulls
      // webglAddon synchronously, so this check is timing-independent.
      if (session.webglAddon !== webgl) return;
      session.webglAddon = null;
      webglPool.forget(session);
      const rearm = () => {
        if (session.opened && session.attached && !session.webglAddon) {
          acquireWebglRenderer(session);
        }
      };
      // Phones drop GL contexts aggressively (backgrounding, memory
      // pressure) and every second on the DOM-renderer fallback is the slow
      // path — re-arm fast there, and immediately when the tab becomes
      // visible again (the moment the context is likely restorable). Desktop
      // context loss is rarer and usually driver trouble; keep the long
      // back-off so we don't thrash a broken GPU.
      setTimeout(rearm, isTouchOrRemoteClient() ? 5000 : 30000);
      if (typeof document !== 'undefined') {
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            document.removeEventListener('visibilitychange', onVisible);
            rearm();
          }
        };
        document.addEventListener('visibilitychange', onVisible);
      }
    });
    session.terminal.loadAddon(webgl);
    session.webglAddon = webgl;
    // Full repaint so the swapped-in renderer owns every visible row and no
    // output written during the swap is missed.
    if (session.terminal.rows > 0) {
      session.terminal.refresh(0, session.terminal.rows - 1);
    }
    return true;
  } catch {
    session.webglAddon = null;
    // If loadAddon succeeded before the throw, the addon holds a LIVE
    // context that the pool never tracked — dispose + force-lose it here or
    // a failed attach defeats the budget. Safe pre-activation too (Disposable
    // no-op).
    if (created) disposeAndLoseWebgl(session, created);
    return false;
  }
}

function detachWebglAddon(session: TerminalSession) {
  const addon = session.webglAddon;
  if (!addon) return;
  session.webglAddon = null;
  disposeAndLoseWebgl(session, addon);
  // Repaint so the DOM renderer owns every visible row and the WebGL
  // canvas's last frame can't linger under it (the doubled-lines artifact).
  try {
    if (session.terminal.rows > 0) {
      session.terminal.refresh(0, session.terminal.rows - 1);
    }
  } catch {}
}

function disposeAndLoseWebgl(session: TerminalSession, addon: WebglAddon) {
  // Capture the addon's canvases before dispose detaches them: dispose only
  // removes the canvas from the DOM, and until GC the context still counts
  // against the browser's cap — force-lose it so the slot frees immediately.
  const canvases = Array.from(
    session.wrapper.querySelectorAll<HTMLCanvasElement>('canvas')
  );
  try { addon.dispose(); } catch {}
  for (const canvas of canvases) {
    forceLoseWebglContext(canvas);
    // dispose normally detaches its canvases; if it threw mid-teardown one
    // can survive in the DOM, frozen on its last frame above the DOM
    // renderer's rows (the phone's half-scrolling "two screens" glitch).
    // Removal is unconditional and idempotent.
    try { canvas.remove(); } catch {}
  }
}

function removeWrapperCanvases(session: TerminalSession) {
  for (const canvas of Array.from(
    session.wrapper.querySelectorAll<HTMLCanvasElement>('canvas')
  )) {
    forceLoseWebglContext(canvas);
    try { canvas.remove(); } catch {}
  }
}

function forceLoseWebglContext(canvas: HTMLCanvasElement) {
  // Existing-context lookup only: a canvas already holding a context of a
  // different kind (the addon's 2D layers) returns null here rather than
  // minting a new one. webgl fallback covers a future addon downgrade from
  // webgl2.
  try {
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {}
}

function appendChunk(streamId: string, chunk: string, seq?: number) {
  const session = sessions.get(streamId);
  if (!session) return;
  if (session.syncing) {
    // Dropping live chunks while a sync snapshot replays loses escape
    // sequences mid-frame and corrupts the TUI; hold them and flush after
    // the replay, where the seq check dedupes anything the snapshot covered.
    session.pendingSyncChunks.push({ chunk, seq });
    return;
  }
  if (typeof seq === 'number' && seq > 0 && seq <= session.lastSeq) return;
  if (typeof seq === 'number') session.lastSeq = seq;
  if (!session.attached && session.opened) {
    // Parked terminals don't parse (see terminal-parked-buffer.ts);
    // resumeParkedStream catches up on re-attach.
    pushParked(session.parked, chunk, PARKED_BUFFER_CAP_UNITS);
    return;
  }
  session.terminal.write(chunk);
}

// UTF-16 code units (~800KB) — dozens of full scrollbacks of CLI output.
const PARKED_BUFFER_CAP_UNITS = 400 * 1024;

/**
 * Re-attach catch-up: replay everything buffered while the terminal was
 * parked; past the cap, pull the server's authoritative snapshot instead.
 * Desktop runs recoverFromOverflow's ordering contract (see
 * terminal-parked-buffer.ts) with the snapshot applied in FORCE mode — the
 * screen is known-incomplete, so the stale/identical guards must not
 * reject it.
 */
export function resumeParkedStream(streamId: string) {
  const session = sessions.get(streamId);
  if (!session) return;
  const { text, needsResync } = drainParked(session.parked);
  if (needsResync) {
    if (isRemoteClient()) {
      // No request/response pairing on the socket (and stranding
      // syncing=true on a dropped snapshot would freeze the pane). Reset
      // lastSeq instead: no seq comparison against a holed screen is
      // meaningful, and the reset guarantees the arriving pty:sync can
      // never be rejected as stale/identical. Socket FIFO keeps ordering.
      session.lastSeq = 0;
      aceApi.core.sendPtyRequestSync?.(streamId);
      return;
    }
    // The stream can be killed + reopened (a NEW session object under this
    // streamId) mid-fetch; completion paths only touch the session that
    // requested the recovery. Re-parking mid-fetch is fine — the snapshot
    // applies once, then output holds in the parked buffer again.
    const owner = session;
    const ownsStream = () => sessions.get(streamId) === owner;
    void recoverFromOverflow({
      beginQueue: () => {
        owner.syncing = true;
      },
      fetchSnapshot: () => aceApi.sessions.getTerminalSync(streamId),
      // Older-than-rendered snapshots get one refetch; a persistently older
      // one means the server's seq space reset — see recoverFromOverflow.
      isStale: (payload) => payload.seq > 0 && payload.seq < owner.lastSeq,
      applySnapshot: (payload) => {
        if (!ownsStream()) return;
        applySyncState(streamId, payload.state, payload.seq, payload.cols, payload.rows, {
          force: true,
        });
      },
      finishWithoutSnapshot: () => {
        // No server state for this stream — flush whatever queued during
        // the attempt and resume live writes; never strand syncing=true.
        if (!ownsStream()) return;
        owner.syncing = false;
        flushPendingSyncChunks(owner);
      },
    });
    return;
  }
  if (text !== null) session.terminal.write(text);
}

function flushPendingSyncChunks(session: TerminalSession) {
  const pending = session.pendingSyncChunks;
  session.pendingSyncChunks = [];
  for (const p of pending) {
    if (typeof p.seq === 'number' && p.seq > 0 && p.seq <= session.lastSeq) continue;
    if (typeof p.seq === 'number') session.lastSeq = p.seq;
    session.terminal.write(p.chunk);
  }
}

function applySyncState(
  streamId: string,
  state: string,
  seq: number,
  cols: number,
  rows: number,
  opts: { force?: boolean } = {},
) {
  const session = sessions.get(streamId);
  if (!session) return;
  // Ordinary snapshots drop when stale and skip when seq-identical to what's
  // already rendered (the phone's wake-time resync storm — see
  // terminal-parked-buffer.snapshotDecision). FORCED snapshots (overflow
  // recovery) bypass both: the screen is known to be missing output, so seq
  // equality no longer implies content equality.
  const decision = snapshotDecision(seq, session.lastSeq, {
    force: opts.force,
    opened: session.opened,
    syncing: session.syncing,
  });
  if (decision === 'stale') return;
  if (decision === 'identical') {
    // Only re-assert dims if the viewport changed while we were away (e.g.
    // rotated in the background) — the server-authoritative resize path
    // still fixes that without the full clear()+reset()+replay.
    if (
      session.attached &&
      session.ptySpawned &&
      session.lastPtyCols > 0 &&
      session.lastPtyRows > 0 &&
      (cols !== session.lastPtyCols || rows !== session.lastPtyRows)
    ) {
      resizeBoth(streamId, session, session.lastPtyCols, session.lastPtyRows);
    }
    return;
  }
  // A reader parked in the scrollback shouldn't be yanked to the live tail
  // just because a resync replayed the buffer (reconnect / visibility wake
  // with new output — iOS fires these constantly). Capture how far above the
  // tail they were and restore that offset after the replay. Content may have
  // shifted by whatever streamed in the meantime, but staying "roughly where
  // I was reading" beats a hard snap to the bottom.
  let restoreFromBottom = 0;
  try {
    const buffer = session.terminal.buffer.active;
    if (buffer.viewportY < buffer.baseY) {
      restoreFromBottom = buffer.baseY - buffer.viewportY;
    }
  } catch {}
  // When resumeParkedStream pre-opened the queue (overflow recovery), keep
  // what it captured — those chunks arrived AFTER the snapshot was requested
  // and replay the difference below (seq-deduped). Entering fresh, any
  // leftovers predate this snapshot and are superseded by it.
  if (!session.syncing) session.pendingSyncChunks = [];
  session.syncing = true;
  // The snapshot supersedes anything held while parked.
  drainParked(session.parked);
  session.terminal.clear();
  session.terminal.reset();
  if (cols > 0 && rows > 0) {
    try { session.terminal.resize(cols, rows); } catch {}
  }
  session.terminal.write(state, () => {
    session.lastSeq = seq;
    session.syncing = false;
    flushPendingSyncChunks(session);
    if (restoreFromBottom > 0) {
      // scrollLines clamps at the top if the replayed buffer is shorter.
      try { session.terminal.scrollLines(-restoreFromBottom); } catch {}
    }
    // The snapshot arrives at the SERVER's current dims. When this client
    // wants different ones (phone vs desktop pane), re-assert through the
    // server-authoritative resize path — otherwise the view is stuck showing
    // a clipped slice of a wider frame, with no ResizeObserver event left to
    // correct it (the container itself never changed size).
    if (
      session.attached &&
      session.ptySpawned &&
      session.lastPtyCols > 0 &&
      session.lastPtyRows > 0 &&
      (cols !== session.lastPtyCols || rows !== session.lastPtyRows)
    ) {
      resizeBoth(streamId, session, session.lastPtyCols, session.lastPtyRows);
    }
  });
}

function notifyStatus(id: string) {
  const set = statusListeners.get(id);
  if (!set) return;
  for (const fn of set) fn();
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  aceApi.core.onPtyData(({ id, chunk, seq }) => appendChunk(id, chunk, seq));
  aceApi.core.onPtyExit(({ id }) => {
    const session = sessions.get(id);
    if (session) {
      session.status = 'exited';
      notifyStatus(id);
    }
  });
  aceApi.core.onPtySync?.((payload: TerminalSyncPayload) => {
    applySyncState(
      payload.streamId,
      payload.state,
      payload.seq,
      payload.cols,
      payload.rows,
    );
  });
}

export function acquireSession(streamId: string): TerminalSession {
  hydrateOnce();
  let session = sessions.get(streamId);
  if (!session) session = createSession(streamId);
  return session;
}

/**
 * Tear down a terminal session entirely (xterm + DOM + cached state). Used
 * when the backend PTY for this stream is being killed so the next time the
 * TerminalFeed mounts for this streamId, it starts clean — a fresh xterm,
 * which calls ensureStreamStarted → new PTY spawn.
 */
export function destroyTerminalSession(streamId: string) {
  const session = sessions.get(streamId);
  if (!session) return;
  // terminal.dispose() takes the addon with it, but the LRU entry must go
  // through releaseWebglRenderer or the pool would hold a dead session.
  releaseWebglRenderer(session);
  try {
    session.terminal.dispose();
  } catch {}
  try {
    session.wrapper.remove();
  } catch {}
  sessions.delete(streamId);
  statusListeners.get(streamId)?.forEach((fn) => fn());
}

export function proposeDimensions(streamId: string): { cols: number; rows: number } | null {
  const session = sessions.get(streamId);
  if (!session) return null;
  try {
    const dims = session.fitAddon.proposeDimensions();
    return dims ? sanitizeTerminalDimensions(dims.cols, dims.rows) : null;
  } catch {
    return null;
  }
}

// Monospace advance width per 1px of font size for the terminal font stack,
// measured once via canvas. Metrics scale linearly, so this one ratio sizes
// every candidate font.
let monoCharWidthRatio: number | null = null;
function getMonoCharWidthRatio(): number {
  if (monoCharWidthRatio !== null) return monoCharWidthRatio;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `100px ${FALLBACK_FONTS}`;
      const w = ctx.measureText('M').width;
      if (w > 0) {
        monoCharWidthRatio = w / 100;
        return monoCharWidthRatio;
      }
    }
  } catch {}
  monoCharWidthRatio = 0.6;
  return monoCharWidthRatio;
}

/**
 * Mobile "desktop view" fit: pin the column count and fit the font size to
 * the container width, so viewport jitter (keyboard, URL bar, rotation) can
 * never horizontally reflow the PTY. Rows still track the container height —
 * vertical resizes are cheap and don't corrupt full-screen TUIs.
 */
export function proposeMobileDimensions(
  streamId: string,
  containerWidth: number
): { cols: number; rows: number } | null {
  const session = sessions.get(streamId);
  if (!session) return null;
  // Quantize the measured width to an 8px grid before fitting the font.
  // Sub-8px width jitter (URL-bar/keyboard animation, scrollbar appearance)
  // can otherwise straddle a font-size boundary and flip it back and forth —
  // each flip is a full glyph-atlas rebuild + repaint mid-animation.
  const quantizedWidth = Math.floor(containerWidth / 8) * 8;
  const fontSize = mobileTerminalFontSize(quantizedWidth, getMonoCharWidthRatio());
  if (session.terminal.options.fontSize !== fontSize) {
    session.terminal.options.fontSize = fontSize;
  }
  let rows = 0;
  try {
    rows = session.fitAddon.proposeDimensions()?.rows ?? 0;
  } catch {}
  return sanitizeTerminalDimensions(MOBILE_TERMINAL_COLS, rows);
}

export function refreshTerminalLayout(streamId: string) {
  const session = sessions.get(streamId);
  if (!session) return;
  try {
    // NEVER raw-fit into a collapsed container: a hidden tab / mid-layout
    // mount proposes ~2x1, fit() applies it directly to the local xterm, and
    // because the server dims never changed no sync snapshot arrives to
    // restore it — the terminal stays shrunken until the next real resize.
    // Only fit when the proposal clears the same 20x4 floor the sync path uses.
    const dims = session.fitAddon.proposeDimensions();
    if (dims && sanitizeTerminalDimensions(dims.cols, dims.rows, 20, 4)) {
      session.fitAddon.fit();
    }
  } catch {}
  try {
    if (session.terminal.rows > 0) {
      session.terminal.refresh(0, session.terminal.rows - 1);
    }
  } catch {}
}

/**
 * Self-heal: if the LOCAL xterm ever deviates from the sane dims the fit path
 * computed (e.g. a degenerate fit slipped through while the pane was hidden,
 * and the server skipped the sync snapshot because its dims never changed),
 * resize the local instance back. Server stays the resize authority — this
 * only realigns the view with what the server already has.
 */
export function alignTerminalDimensions(streamId: string, cols: number, rows: number) {
  const session = sessions.get(streamId);
  if (!session || session.syncing) return;
  const dims = sanitizeTerminalDimensions(cols, rows, 20, 4);
  if (!dims) return;
  if (session.terminal.cols === dims.cols && session.terminal.rows === dims.rows) return;
  try {
    session.terminal.resize(dims.cols, dims.rows);
  } catch {}
}

// VS Code's TerminalResizeDebouncer pattern (terminalResizeDebouncer.ts):
// - Small buffer (normal.length < 200): resize both immediately.
// - Larger buffer: Y resizes both immediately (cheap — no reflow), X is
//   debounced 100ms because horizontal reflow is expensive.
// Callbacks mirror VS Code's _resizeBothCallback/_resizeXCallback/
// _resizeYCallback which always resize xterm+PTY together, never xterm alone.

const START_DEBOUNCING_THRESHOLD = 200;
const DEBOUNCE_X_MS = 100;

function resizeBoth(streamId: string, session: TerminalSession, cols: number, rows: number) {
  const dims = sanitizeTerminalDimensions(cols, rows);
  if (!dims) return;
  try { session.terminal.resize(dims.cols, dims.rows); } catch {}
  session.lastPtyCols = dims.cols;
  session.lastPtyRows = dims.rows;
  void aceApi.runtime.resizeTerminal(streamId, dims);
}

function resizeY(streamId: string, session: TerminalSession, rows: number) {
  const dims = sanitizeTerminalDimensions(session.terminal.cols, rows);
  if (!dims) return;
  try { session.terminal.resize(dims.cols, dims.rows); } catch {}
  session.lastPtyRows = dims.rows;
  void aceApi.runtime.resizeTerminal(streamId, dims);
}

function resizeX(streamId: string, session: TerminalSession, cols: number) {
  const dims = sanitizeTerminalDimensions(cols, session.terminal.rows);
  if (!dims) return;
  try { session.terminal.resize(dims.cols, dims.rows); } catch {}
  session.lastPtyCols = dims.cols;
  void aceApi.runtime.resizeTerminal(streamId, dims);
}

export function syncPty(streamId: string, cols: number, rows: number) {
  const session = sessions.get(streamId);
  if (!session) return;
  const dims = sanitizeTerminalDimensions(cols, rows);
  if (!dims) return;
  if (!session.ptySpawned) {
    session.ptySpawned = true;
    session.lastPtyCols = dims.cols;
    session.lastPtyRows = dims.rows;
    try { session.terminal.resize(dims.cols, dims.rows); } catch {}
    if (isRemoteClient()) aceApi.core.sendPtySubscribe?.(streamId);
    void aceApi.sessions.ensureStreamStarted(streamId, dims.cols, dims.rows).then(() => {
      if (isRemoteClient()) aceApi.core.sendPtyRequestSync?.(streamId);
    });
    return;
  }
  if (dims.cols === session.lastPtyCols && dims.rows === session.lastPtyRows) return;

  session.latestResizeX = dims.cols;

  const bufferLength = session.terminal.buffer.normal.length;
  if (bufferLength < START_DEBOUNCING_THRESHOLD) {
    if (session.resizeXTimer !== null) {
      window.clearTimeout(session.resizeXTimer);
      session.resizeXTimer = null;
    }
    resizeBoth(streamId, session, dims.cols, dims.rows);
    return;
  }

  // Large buffer: Y immediate, X debounced.
  if (dims.rows !== session.lastPtyRows) {
    resizeY(streamId, session, dims.rows);
  }
  if (dims.cols !== session.lastPtyCols) {
    if (session.resizeXTimer !== null) window.clearTimeout(session.resizeXTimer);
    session.resizeXTimer = window.setTimeout(() => {
      session.resizeXTimer = null;
      resizeX(streamId, session, session.latestResizeX);
    }, DEBOUNCE_X_MS);
  }
}

// Remote clients (phone PWA / remote browser) subscribe per ATTACHED terminal,
// not per stream-ever-opened. Without this the socket accumulated every stream
// in its subscription set for the whole session and never dropped one, so each
// foreground/unlock/reconnect fired a pty:requestSync for ALL of them — and
// every sync serializes the stream's full scrollback on the server and replays
// it with clear()+reset()+write() on the phone. That "thundering herd" of
// full-buffer replays is the wake-time freeze. Subscribing only what's on
// screen (and pulling a fresh snapshot on re-attach) keeps that to the one
// stream the user is looking at, and — composing with the client's sentinel
// subscription that keeps the server set non-empty — a parked phone drops to
// the sentinel alone and stops receiving any stream's frames while hidden.
// Desktop (Electron IPC) has no per-stream subscription model, so these no-op
// there via isRemoteClient + optional chaining.
export function subscribePtyStream(streamId: string) {
  if (!isRemoteClient()) return;
  // The server's pty:subscribe handler already serializes and pushes one
  // sync snapshot, which covers anything missed while parked+unsubscribed —
  // do NOT also sendPtyRequestSync here, or every re-attach makes the server
  // serialize (and the tunnel carry) the full snapshot twice. The explicit
  // requestSync in syncPty stays: there the subscribe fires before the PTY
  // exists (no state to snapshot), so the post-spawn requestSync is the one
  // that actually delivers.
  aceApi.core.sendPtySubscribe?.(streamId);
}

export function unsubscribePtyStream(streamId: string) {
  if (!isRemoteClient()) return;
  aceApi.core.sendPtyUnsubscribe?.(streamId);
}

export function useTerminalSessionStatus(streamId: string | null): SessionStatus {
  useEffect(() => {
    hydrateOnce();
  }, []);

  const subscribe = (listener: () => void) => {
    if (!streamId) return () => {};
    let set = statusListeners.get(streamId);
    if (!set) {
      set = new Set();
      statusListeners.set(streamId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  };

  const getSnapshot = (): SessionStatus => {
    if (!streamId) return 'running';
    return sessions.get(streamId)?.status ?? 'running';
  };

  return useSyncExternalStore(subscribe, getSnapshot, () => 'running');
}

export function focusTerminal(streamId: string) {
  const session = acquireSession(streamId);
  // Clicking into a pane promotes it back to the GPU renderer if the budget
  // above ever bumped it to the DOM fallback while it sat unfocused.
  acquireWebglRenderer(session);
  focusTerminalInput(session.wrapper, session.terminal);
}

export function scrollTerminalToBottom(streamId: string) {
  const session = sessions.get(streamId);
  if (!session) return;
  try {
    session.terminal.scrollToBottom();
  } catch {}
}

/**
 * Subscribe to whether the terminal viewport is scrolled away from the live
 * tail. Fires `listener(scrolledUp)` on every transition (and once on
 * subscribe with the current value). Backs the mobile "jump to live" chip.
 */
export function observeTerminalScrolledUp(
  streamId: string,
  listener: (scrolledUp: boolean) => void
): () => void {
  const session = sessions.get(streamId);
  if (!session) {
    listener(false);
    return () => {};
  }
  const terminal = session.terminal;
  let last: boolean | null = null;
  const compute = () => {
    let scrolledUp = false;
    try {
      const buffer = terminal.buffer.active;
      scrolledUp = buffer.viewportY < buffer.baseY;
    } catch {}
    if (scrolledUp === last) return;
    last = scrolledUp;
    listener(scrolledUp);
  };
  // onScroll covers user scrolling; onWriteParsed covers the tail growing
  // underneath a parked viewport (which changes baseY without a scroll).
  const scrollSub = terminal.onScroll(compute);
  const writeSub = terminal.onWriteParsed(compute);
  compute();
  return () => {
    try { scrollSub.dispose(); } catch {}
    try { writeSub.dispose(); } catch {}
  };
}

// Transient feedback chip anchored to the terminal wrapper. Fades after
// 2.4s. Purely presentational — no store, no React — so it can be fired
// from the paste event handler without a render.
function showPasteNotice(
  wrapper: HTMLDivElement,
  message: string,
  kind: 'ok' | 'error'
): void {
  const existing = wrapper.querySelector<HTMLDivElement>('[data-ace-paste-notice]');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.setAttribute('data-ace-paste-notice', kind);
  el.textContent = kind === 'ok' ? `Pasted ${message}` : message;
  Object.assign(el.style, {
    position: 'absolute',
    top: '8px',
    right: '12px',
    padding: '4px 10px',
    borderRadius: '9999px',
    fontSize: '11px',
    fontFamily: 'system-ui, sans-serif',
    fontWeight: '500',
    letterSpacing: '0.01em',
    background: kind === 'ok' ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.2)',
    color: kind === 'ok' ? '#a7f3d0' : '#fecaca',
    border:
      kind === 'ok'
        ? '1px solid rgba(16,185,129,0.35)'
        : '1px solid rgba(239,68,68,0.4)',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'none',
    zIndex: '50',
    transition: 'opacity 200ms ease',
    opacity: '0',
  } as Partial<CSSStyleDeclaration>);
  const prevPosition = wrapper.style.position;
  if (!prevPosition) wrapper.style.position = 'relative';
  wrapper.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 2400);
}
