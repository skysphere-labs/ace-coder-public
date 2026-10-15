import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  MousePointer2,
  RotateCw,
  Search,
  Shield,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import type { BrowserControlStatus } from '../lib/ace-api';
import { GITHUB_BROWSER_PARTITION } from '../lib/github-browser';
import { MobileBrowserPane } from './MobileBrowserPane';
import { BrowserAgentCursor } from './BrowserAgentCursor';
import {
  updateScratchTab,
  useScratchTabs,
} from '../runtime/scratch-tabs-registry';
import { useCoreSelector } from '../runtime/core-registry';
import {
  getConversationStreamId,
  getVariantStreamId,
  pasteToTerminal,
} from '../runtime/terminal-registry';
import { openRef } from '../runtime/pane-layout-registry';
import type { AgentId } from '../lib/types';
import {
  PICKER_CANCEL_SCRIPT,
  PICKER_SCRIPT,
  formatElementReference,
  type PickedElement,
} from '../lib/browser-element-picker';
import AgentLogo from './ProviderGlyph';
import { getAgentAccentColor } from '../lib/agent-style';
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

const DEFAULT_HOME = 'https://www.google.com';

type WebviewEl = HTMLElement & {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};

interface BrowserPaneProps {
  taskId: string;
  tabId: string;
}

export function BrowserPane({ taskId, tabId }: BrowserPaneProps) {
  const state = useScratchTabs(taskId);
  const tab = state.tabs.find((t) => t.id === tabId && t.kind === 'browser');
  const webviewRef = useRef<WebviewEl | null>(null);
  const [initialSrc] = useState(() => tab?.url || 'about:blank');
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<BrowserControlStatus | null>(null);
  const [picking, setPicking] = useState(false);
  const [pendingElement, setPendingElement] = useState<PickedElement | null>(null);
  const targets = useAgentTargets(taskId);

  const currentUrl = tab?.url || '';
  const isLoading = !!tab?.loading;
  const canGoBack = !!tab?.canGoBack;
  const canGoForward = !!tab?.canGoForward;
  const inputUrl = draftUrl ?? currentUrl;

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    let registeredWebContentsId: number | null = null;

    const registerWebview = () => {
      let webContentsId: number | null = null;
      try {
        webContentsId = el.getWebContentsId();
      } catch {
        webContentsId = null;
      }
      if (!webContentsId || registeredWebContentsId === webContentsId) return;
      registeredWebContentsId = webContentsId;
      void aceApi.browser
        .registerWebview({ taskId, tabId, webContentsId })
        .catch((err) => console.warn('[ace] browser webview registration failed', err));
    };
    const onDidStart = () => {
      registerWebview();
      updateScratchTab(taskId, tabId, { loading: true });
      setError(null);
    };
    const onDidStop = () => {
      registerWebview();
      updateScratchTab(taskId, tabId, {
        loading: false,
        canGoBack: el.canGoBack(),
        canGoForward: el.canGoForward(),
      });
    };
    const onNavigate = (ev: Event) => {
      const anyEv = ev as unknown as { url?: string; isMainFrame?: boolean };
      if (anyEv.isMainFrame === false) return;
      const url = anyEv.url || el.getURL();
      if (!url || url === 'about:blank') return;
      updateScratchTab(taskId, tabId, {
        url,
        canGoBack: el.canGoBack(),
        canGoForward: el.canGoForward(),
      });
    };
    const onTitle = (ev: Event) => {
      const anyEv = ev as unknown as { title?: string };
      const title = anyEv.title || el.getTitle() || 'Untitled';
      updateScratchTab(taskId, tabId, { title });
    };
    const onFavicon = (ev: Event) => {
      const anyEv = ev as unknown as { favicons?: string[] };
      const favicon = anyEv.favicons?.[0] || null;
      updateScratchTab(taskId, tabId, { favicon });
    };
    const onNavigated = () => {
      updateScratchTab(taskId, tabId, { favicon: null });
    };
    const onFail = (ev: Event) => {
      const anyEv = ev as unknown as {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
        validatedURL?: string;
      };
      if (anyEv.isMainFrame === false) return;
      if (anyEv.errorCode === -3) return;
      setError(anyEv.errorDescription || 'Failed to load page');
      updateScratchTab(taskId, tabId, { loading: false });
    };

    el.addEventListener('did-start-loading', onDidStart);
    el.addEventListener('did-stop-loading', onDidStop);
    el.addEventListener('dom-ready', registerWebview);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate', onNavigated);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('page-favicon-updated', onFavicon);
    el.addEventListener('did-fail-load', onFail);
    window.setTimeout(registerWebview, 0);
    return () => {
      el.removeEventListener('did-start-loading', onDidStart);
      el.removeEventListener('did-stop-loading', onDidStop);
      el.removeEventListener('dom-ready', registerWebview);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate', onNavigated);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('page-favicon-updated', onFavicon);
      el.removeEventListener('did-fail-load', onFail);
      void aceApi.browser
        .unregisterWebview({ taskId, tabId, webContentsId: registeredWebContentsId })
        .catch(() => {});
    };
  }, [taskId, tabId]);

  useEffect(() => {
    return aceApi.browser.onControlStatus((payload) => {
      if (payload.taskId !== taskId || payload.tabId !== tabId) return;
      setControlStatus(payload);
    });
  }, [taskId, tabId]);

  const navigate = (raw: string) => {
    const target = normalizeUrl(raw);
    if (!target) return;
    setDraftUrl(null);
    setError(null);
    updateScratchTab(taskId, tabId, { url: target, loading: true });
    const el = webviewRef.current;
    if (!el) return;
    try {
      el.loadURL(target).catch(() => {});
    } catch {
      /* webview not yet attached — initialSrc will pick it up */
    }
  };

  const onSubmitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  const goBack = () => {
    const el = webviewRef.current;
    if (el && canGoBack) el.goBack();
  };
  const goForward = () => {
    const el = webviewRef.current;
    if (el && canGoForward) el.goForward();
  };
  const reload = () => {
    const el = webviewRef.current;
    if (!el) return;
    if (isLoading) el.stop();
    else el.reload();
  };
  const openExternal = () => {
    if (!currentUrl) return;
    void aceApi.workspaces.openExternal(currentUrl);
  };

  const togglePicker = () => {
    const el = webviewRef.current;
    if (!el) return;
    if (pendingElement) {
      setPendingElement(null);
      return;
    }
    if (picking) {
      void el.executeJavaScript(PICKER_CANCEL_SCRIPT).catch(() => {});
      return;
    }
    setPicking(true);
    el.executeJavaScript(PICKER_SCRIPT, true)
      .then((result) => {
        if (result && typeof result === 'object') {
          setPendingElement(result as PickedElement);
        }
      })
      .catch(() => {})
      .finally(() => setPicking(false));
  };

  const sendReferenceTo = (streamId: string) => {
    if (!pendingElement) return;
    const text = formatElementReference(pendingElement, { taskId, tabId });
    void pasteToTerminal(streamId, { text });
    setPendingElement(null);
    openRef(taskId, { kind: 'scratch', tabId });
  };

  if (!tab) return null;

  if (isRemoteClient()) {
    // Remote clients (mobile PWA + remote browser tabs) cannot embed a
    // <webview>, so the page is hosted in a hidden offscreen window on the
    // desktop (same persist:ace-browser partition — shared logins, working
    // localhost OAuth callbacks) and streamed here as an interactive pane.
    // Subscription-scoped and change-driven: frames only flow while a remote
    // viewer has this tab open.
    return <MobileBrowserPane taskId={taskId} tabId={tabId} tab={tab} />;
  }

  const showStart = !currentUrl;
  const isSecure = currentUrl.startsWith('https://');

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.04] bg-white/[0.02] px-2 py-1.5 backdrop-blur-sm">
        <ChromeButton disabled={!canGoBack} onClick={goBack} title="Back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton disabled={!canGoForward} onClick={goForward} title="Forward">
          <ArrowRight className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton onClick={reload} title={isLoading ? 'Stop' : 'Reload'}>
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
        </ChromeButton>

        <form
          onSubmit={onSubmitUrl}
          className="relative flex min-w-0 flex-1 items-center"
        >
          <span className="pointer-events-none absolute left-2.5 flex items-center text-muted-foreground/60">
            {isSecure ? (
              <Shield className="h-3 w-3" />
            ) : (
              <Search className="h-3 w-3" />
            )}
          </span>
          <input
            type="text"
            value={inputUrl}
            onFocus={(e) => {
              setDraftUrl(currentUrl);
              e.currentTarget.select();
            }}
            onBlur={() => setDraftUrl(null)}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraftUrl(null);
                e.currentTarget.blur();
              }
            }}
            placeholder="Search or enter a URL"
            spellCheck={false}
            className="h-7 w-full min-w-0 rounded-full border border-white/[0.06] bg-white/[0.04] pl-7 pr-3 text-[11.5px] text-foreground transition-colors placeholder:text-muted-foreground/50 hover:bg-white/[0.05] focus:border-white/15 focus:bg-white/[0.06] focus:outline-none"
          />
        </form>

        <Popover.Root
          open={!!pendingElement}
          onOpenChange={(open) => {
            if (!open) setPendingElement(null);
          }}
        >
          <Popover.Trigger asChild>
            <ChromeButton
              onClick={togglePicker}
              title={
                pendingElement
                  ? 'Pick an agent to reference this element'
                  : picking
                    ? 'Click an element in the page (Esc to cancel)'
                    : 'Pick an element to reference'
              }
              disabled={!currentUrl}
              active={picking || !!pendingElement}
            >
              <MousePointer2 className="h-3.5 w-3.5" />
            </ChromeButton>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-[100] w-64 rounded-lg border border-white/10 bg-neutral-900/95 p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur-md"
            >
              <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
                Send reference to
              </div>
              {pendingElement && (
                <div className="px-2 pb-1.5 text-[11px] text-muted-foreground/80">
                  <span className="font-medium text-foreground/90">
                    {pendingElement.tag}
                    {pendingElement.id ? `#${pendingElement.id}` : ''}
                  </span>
                  {pendingElement.text && (
                    <span className="ml-1 opacity-70">
                      - {truncate(pendingElement.text, 40)}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {targets.length === 0 && (
                  <div className="px-2 py-3 text-[11.5px] text-muted-foreground">
                    No open agents in this task.
                  </div>
                )}
                {targets.map((t) => (
                  <button
                    key={t.streamId}
                    type="button"
                    onClick={() => sendReferenceTo(t.streamId)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-white/[0.06]"
                  >
                    <AgentLogo agent={t.agent} className="h-3.5 w-3.5" />
                    <span
                      className="truncate"
                      style={{ color: getAgentAccentColor(t.agent) }}
                    >
                      {t.title}
                    </span>
                  </button>
                ))}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <ChromeButton
          onClick={openExternal}
          title="Open in your default browser"
          disabled={!currentUrl}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </ChromeButton>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-200">
          <span className="flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-rose-200/70 hover:bg-rose-500/20 hover:text-rose-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {showStart && <StartScreen onGo={navigate} />}
        <webview
          ref={(el) => {
            webviewRef.current = el as WebviewEl | null;
          }}
          src={initialSrc}
          partition={GITHUB_BROWSER_PARTITION}
          allowpopups
          style={{
            display: showStart ? 'none' : 'flex',
            width: '100%',
            height: '100%',
          }}
        />
        <BrowserAgentCursor signal={controlStatus?.cursor ?? null} />
      </div>
    </div>
  );
}

const ChromeButton = React.forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    active?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function ChromeButton({ children, onClick, disabled, title, active, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...rest}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-blue-500/20 text-blue-200 hover:bg-blue-500/25'
          : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
        disabled && 'opacity-25'
      )}
    >
      {children}
    </button>
  );
});

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

type AgentTarget = {
  streamId: string;
  agent: AgentId;
  title: string;
};

function useAgentTargets(taskId: string): AgentTarget[] {
  return useCoreSelector<AgentTarget[]>((snapshot) => {
    for (const workspace of snapshot.workspaces) {
      const task = [...workspace.tasks, ...workspace.archivedTasks].find(
        (t) => t.id === taskId
      );
      if (!task) continue;
      const targets: AgentTarget[] = [];
      for (const c of task.conversations ?? []) {
        targets.push({
          streamId: getConversationStreamId(c.id),
          agent: c.agent,
          title: c.title || c.agent,
        });
      }
      for (const wt of task.worktrees ?? []) {
        for (const v of wt.variants) {
          targets.push({
            streamId: getVariantStreamId(v.id),
            agent: v.agent,
            title: v.name || v.agent,
          });
        }
      }
      return targets;
    }
    return [];
  });
}

const QUICK_LINKS: { label: string; url: string; icon: string; invert?: boolean }[] = [
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

function StartScreen({ onGo }: { onGo: (url: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="absolute inset-0 overflow-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(700px 360px at 50% -10%, hsl(210 80% 60% / 0.10), transparent 60%), radial-gradient(500px 280px at 80% 110%, hsl(280 70% 60% / 0.08), transparent 60%)',
        }}
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center gap-10 px-6 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-foreground shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
            <Search className="h-6 w-6" />
          </div>
          <h2 className="mt-3 font-display text-[28px] font-semibold tracking-tight text-foreground">
            Where to?
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            Logged-in sessions persist inside Ace.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onGo(value || DEFAULT_HOME);
          }}
          className="group relative w-full"
        >
          <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground/70">
            <Search className="h-5 w-5" />
          </span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search the web or type a URL"
            spellCheck={false}
            className="h-14 w-full rounded-full border border-white/[0.08] bg-white/[0.035] pl-14 pr-24 text-[15px] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_12px_40px_rgba(0,0,0,0.35)] placeholder:text-muted-foreground/45 transition-all focus:border-white/20 focus:bg-white/[0.06] focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10px] font-medium tracking-wider text-muted-foreground/70">
            Enter
          </kbd>
        </form>

        <div className="w-full">
          <div className="mb-3 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
            Quick links
          </div>
          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6">
            {QUICK_LINKS.map((s) => (
              <button
                key={s.url}
                type="button"
                onClick={() => onGo(s.url)}
                className="group relative flex flex-col items-center gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-2 py-3 text-[11px] text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-foreground"
                title={s.url.replace(/^https?:\/\//, '')}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_4px_14px_rgba(0,0,0,0.25)]">
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
                <span className="text-[11px] font-medium">{s.label}</span>
              </button>
            ))}
          </div>
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
