import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RotateCw,
  Search,
  Shield,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi } from '../lib/ace-api';
import type { BrowserStreamEvent, BrowserStreamInputEvent } from '../lib/ace-api';
import { updateScratchTab } from '../runtime/scratch-tabs-registry';
import type { ScratchTab } from '../runtime/scratch-tabs-registry';
import claudeLogo from '../assets/images/claude.png';
import chatgptLogo from '../assets/images/openai.svg';
import githubLogo from '../assets/images/brands/github.svg';
import googleLogo from '../assets/images/brands/google.svg';
import youtubeLogo from '../assets/images/brands/youtube.svg';
import gmailLogo from '../assets/images/brands/gmail.svg';
import linearLogo from '../assets/images/brands/linear.svg';
import figmaLogo from '../assets/images/brands/figma.svg';
import notionLogo from '../assets/images/brands/notion.svg';
import perplexityLogo from '../assets/images/brands/perplexity.svg';
import xLogo from '../assets/images/brands/x.svg';
import vercelLogo from '../assets/images/brands/vercel.svg';

// Remote clients get a REAL interactive browser: the page runs in a hidden
// offscreen window on the desktop (same persist:ace-browser partition as the
// desktop panes, so logins are shared and localhost OAuth callbacks work),
// JPEG frames stream here over the remote WS, and taps/keys/scrolls are
// forwarded back. Everything — /login flows, sign-out, cookies — happens
// inside Ace, independent of any external browser. Safari hand-off remains
// as an explicit escape hatch in the toolbar.

const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 700;
const WHEEL_FLUSH_MS = 80;
const RESIZE_DEBOUNCE_MS = 300;

type QuickLink = { label: string; url: string; icon: string; invert?: boolean };

const QUICK_LINKS: QuickLink[] = [
  { label: 'Claude',     url: 'https://claude.ai',         icon: claudeLogo },
  { label: 'ChatGPT',    url: 'https://chat.openai.com',   icon: chatgptLogo, invert: true },
  { label: 'GitHub',     url: 'https://github.com',        icon: githubLogo,  invert: true },
  { label: 'Google',     url: 'https://www.google.com',    icon: googleLogo },
  { label: 'YouTube',    url: 'https://www.youtube.com',   icon: youtubeLogo },
  { label: 'Gmail',      url: 'https://mail.google.com',   icon: gmailLogo },
  { label: 'Linear',     url: 'https://linear.app',        icon: linearLogo,  invert: true },
  { label: 'Figma',      url: 'https://www.figma.com',     icon: figmaLogo },
  { label: 'Notion',     url: 'https://www.notion.so',     icon: notionLogo,  invert: true },
  { label: 'Perplexity', url: 'https://www.perplexity.ai', icon: perplexityLogo },
  { label: 'X',          url: 'https://x.com',             icon: xLogo,       invert: true },
  { label: 'Vercel',     url: 'https://vercel.com',        icon: vercelLogo,  invert: true },
];

type Props = {
  taskId: string;
  tabId: string;
  tab: ScratchTab & { kind: 'browser' };
};

export function MobileBrowserPane({ taskId, tabId, tab }: Props) {
  if (!tab.url) {
    return (
      <StartScreen
        onGo={(url) => {
          updateScratchTab(taskId, tabId, { url, loading: true });
        }}
      />
    );
  }
  return <StreamView taskId={taskId} tabId={tabId} tab={tab} />;
}

function viewportFor(el: HTMLElement | null) {
  const rect = el?.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return {
    width: Math.max(120, Math.round(rect?.width || 390)),
    height: Math.max(120, Math.round(rect?.height || 700)),
    dpr,
  };
}

function StreamView({ taskId, tabId, tab }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keyboardRef = useRef<HTMLInputElement | null>(null);
  const [frame, setFrame] = useState<{ image: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const frameSizeRef = useRef<{ width: number; height: number } | null>(null);
  const navigatedRef = useRef(false);
  const initialUrlRef = useRef(tab.url || '');

  const currentUrl = tab.url || '';
  const isLoading = !!tab.loading && !error;
  const inputUrl = draftUrl ?? currentUrl;
  const isSecure = currentUrl.startsWith('https://');

  // Subscribe while mounted; the server keeps the offscreen host alive for a
  // grace period after unsubscribe so quick tab switches don't reload pages.
  useEffect(() => {
    const viewport = viewportFor(containerRef.current);
    aceApi.browser.streamSubscribe(taskId, tabId, viewport);
    return () => {
      aceApi.browser.streamUnsubscribe(taskId, tabId);
    };
  }, [taskId, tabId, retryToken]);

  useEffect(() => {
    return aceApi.browser.onStreamEvent((evt: BrowserStreamEvent) => {
      if (evt.taskId !== taskId || evt.tabId !== tabId) return;
      if (evt.error) {
        setError(evt.error);
        return;
      }
      setError(null);
      if (evt.image) {
        frameSizeRef.current = { width: evt.width || 0, height: evt.height || 0 };
        setFrame({ image: evt.image, width: evt.width || 0, height: evt.height || 0 });
      }
      // A fresh host starts blank while the persisted tab URL may still be
      // debounce-saving — drive the first navigation from the client.
      if (
        !navigatedRef.current &&
        (!evt.url || evt.url === 'about:blank') &&
        initialUrlRef.current
      ) {
        navigatedRef.current = true;
        void aceApi.browser
          .streamNavigate({ taskId, tabId, url: initialUrlRef.current })
          .catch(() => {});
        return;
      }
      if (evt.url && evt.url !== 'about:blank') {
        navigatedRef.current = true;
        updateScratchTab(taskId, tabId, {
          url: evt.url,
          title: evt.title || evt.url,
          loading: !!evt.loading,
          canGoBack: !!evt.canGoBack,
          canGoForward: !!evt.canGoForward,
        });
      }
    });
  }, [taskId, tabId]);

  // Keep the host viewport matched to this pane.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void aceApi.browser
          .streamResize({ taskId, tabId, ...viewportFor(containerRef.current) })
          .catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [taskId, tabId]);

  const sendInput = useCallback(
    (events: BrowserStreamInputEvent[]) =>
      aceApi.browser.streamInput({ taskId, tabId, events }).catch(() => ({ ok: false })),
    [taskId, tabId]
  );

  const navigate = (raw: string) => {
    const target = normalizeUrl(raw);
    if (!target) return;
    setDraftUrl(null);
    updateScratchTab(taskId, tabId, { url: target, loading: true });
    navigatedRef.current = true;
    void aceApi.browser.streamNavigate({ taskId, tabId, url: target }).catch(() => {});
  };

  const navAction = (action: 'back' | 'forward' | 'reload' | 'stop') => {
    void aceApi.browser.streamNavigate({ taskId, tabId, action }).catch(() => {});
  };

  return (
    <div className="flex h-full w-full flex-col bg-black/40">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-white/[0.03] px-2 py-1.5">
        <ToolbarButton disabled={!tab.canGoBack} onClick={() => navAction('back')} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          disabled={!tab.canGoForward}
          onClick={() => navAction('forward')}
          title="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => navAction(isLoading ? 'stop' : 'reload')}
          title={isLoading ? 'Stop' : 'Reload'}
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
        </ToolbarButton>
        <form
          className="relative flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(inputUrl);
          }}
        >
          <span className="pointer-events-none absolute left-2.5 flex items-center text-muted-foreground/60">
            {isSecure ? <Shield className="h-3 w-3" /> : <Search className="h-3 w-3" />}
          </span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={inputUrl}
            onFocus={(e) => {
              setDraftUrl(currentUrl);
              e.currentTarget.select();
            }}
            onBlur={() => setDraftUrl(null)}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="Search or enter URL"
            className="h-8 w-full min-w-0 rounded-full border border-white/[0.06] bg-white/[0.04] pl-7 pr-3 text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:border-white/15 focus:bg-white/[0.06] focus:outline-none"
          />
        </form>
        <ToolbarButton
          onClick={() => window.open(currentUrl, '_blank', 'noopener,noreferrer')}
          title="Open in your phone's browser instead"
          disabled={!currentUrl}
        >
          <ExternalLink className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-200">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            className="rounded-full border border-rose-300/30 px-2 py-0.5 text-rose-100"
            onClick={() => {
              setError(null);
              setRetryToken((t) => t + 1);
            }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-rose-200/70"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        {frame ? (
          <StreamSurface
            frame={frame}
            frameSizeRef={frameSizeRef}
            keyboardRef={keyboardRef}
            sendInput={sendInput}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-[12px]">Connecting to your desktop browser…</span>
          </div>
        )}
        {/* Invisible input that raises the phone keyboard; keystrokes are
            forwarded to the page focused in the desktop-side host. */}
        <input
          ref={keyboardRef}
          type="text"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute h-px w-px opacity-0"
          style={{ left: 0, bottom: 0 }}
          onChange={(e) => {
            const text = e.target.value;
            if (!text) return;
            e.target.value = '';
            void sendInput([{ type: 'text', text }]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void sendInput([{ type: 'key', key: 'Enter' }]);
            } else if (e.key === 'Backspace' && !e.currentTarget.value) {
              void sendInput([{ type: 'key', key: 'Backspace' }]);
            }
          }}
        />
      </div>
    </div>
  );
}

function StreamSurface({
  frame,
  frameSizeRef,
  keyboardRef,
  sendInput,
}: {
  frame: { image: string; width: number; height: number };
  frameSizeRef: React.MutableRefObject<{ width: number; height: number } | null>;
  keyboardRef: React.MutableRefObject<HTMLInputElement | null>;
  sendInput: (events: BrowserStreamInputEvent[]) => Promise<{ ok: boolean; editable?: boolean }>;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startedAt: number;
    panning: boolean;
    pendingDx: number;
    pendingDy: number;
    flushTimer: number | null;
  } | null>(null);

  // Map a client point inside the surface to frame-bitmap coordinates (which
  // are the host window's input space).
  const toFrameCoords = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const size = frameSizeRef.current;
    if (!rect || !size || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * size.width),
      y: Math.round(((clientY - rect.top) / rect.height) * size.height),
      scaleX: size.width / rect.width,
      scaleY: size.height / rect.height,
    };
  };

  const flushWheel = () => {
    const g = gestureRef.current;
    if (!g) return;
    g.flushTimer = null;
    if (!g.pendingDx && !g.pendingDy) return;
    const point = toFrameCoords(g.startX, g.startY);
    if (!point) return;
    // Natural scrolling: content follows the finger.
    const events: BrowserStreamInputEvent[] = [
      {
        type: 'wheel',
        x: point.x,
        y: point.y,
        deltaX: Math.round(-g.pendingDx * point.scaleX),
        deltaY: Math.round(-g.pendingDy * point.scaleY),
      },
    ];
    g.pendingDx = 0;
    g.pendingDy = 0;
    void sendInput(events);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (gestureRef.current) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startedAt: Date.now(),
      panning: false,
      pendingDx: 0,
      pendingDy: 0,
      flushTimer: null,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.lastX;
    const dy = e.clientY - g.lastY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    if (
      !g.panning &&
      Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP_PX
    ) {
      g.panning = true;
    }
    if (!g.panning) return;
    g.pendingDx += dx;
    g.pendingDy += dy;
    if (g.flushTimer === null) {
      g.flushTimer = window.setTimeout(flushWheel, WHEEL_FLUSH_MS);
    }
  };

  const endGesture = (e: React.PointerEvent, cancelled: boolean) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.flushTimer !== null) window.clearTimeout(g.flushTimer);
    flushWheel();
    gestureRef.current = null;
    if (cancelled || g.panning) return;
    if (Date.now() - g.startedAt > TAP_MAX_MS) return;
    const point = toFrameCoords(g.startX, g.startY);
    if (!point) return;
    // Focus the hidden input inside the user gesture so iOS is willing to
    // raise the keyboard, then drop focus if the tap didn't land on a text
    // field in the remote page.
    keyboardRef.current?.focus({ preventScroll: true });
    void sendInput([{ type: 'tap', x: point.x, y: point.y }]).then((result) => {
      if (!result?.editable) keyboardRef.current?.blur();
    });
  };

  return (
    <div
      ref={surfaceRef}
      className="absolute inset-0"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endGesture(e, false)}
      onPointerCancel={(e) => endGesture(e, true)}
    >
      <img
        src={frame.image}
        alt=""
        draggable={false}
        className="h-full w-full select-none"
        style={{ objectFit: 'fill' }}
      />
    </div>
  );
}

const ToolbarButton = ({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-white/[0.08]',
      disabled && 'opacity-25'
    )}
  >
    {children}
  </button>
);

function StartScreen({ onGo }: { onGo: (url: string) => void }) {
  const [draft, setDraft] = useState('');

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setDraft('');
    onGo(url);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-5 pt-6 pb-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
          className="relative"
        >
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
            <Search className="h-4 w-4" />
          </span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search or enter URL"
            className="h-12 w-full rounded-full border border-white/[0.08] bg-white/[0.04] pl-11 pr-4 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:border-white/20 focus:bg-white/[0.06] focus:outline-none"
          />
        </form>
        <p className="mt-2 px-2 text-[11px] text-muted-foreground/60">
          Pages open right here, streamed from your desktop — logins persist
          inside Ace.
        </p>
      </div>

      <div className="px-5 pb-8">
        <div className="mb-3 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
          Quick links
        </div>
        <div className="grid grid-cols-4 gap-3 landscape:grid-cols-6">
          {QUICK_LINKS.map((s) => (
            <button
              key={s.url}
              type="button"
              onClick={() => go(s.url)}
              className="group flex flex-col items-center gap-1.5 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-2 py-3 text-[11px] font-medium text-muted-foreground transition-colors active:bg-white/[0.06]"
              title={s.url.replace(/^https?:\/\//, '')}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.04]">
                <img
                  src={s.icon}
                  alt=""
                  draggable={false}
                  className={cn(
                    'h-5 w-5 object-contain',
                    s.invert && 'brightness-0 invert'
                  )}
                />
              </div>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^about:/.test(trimmed)) return trimmed;
  const looksLikeHost =
    /^[^\s/]+\.[^\s/]+/.test(trimmed) && !/\s/.test(trimmed);
  if (looksLikeHost) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
