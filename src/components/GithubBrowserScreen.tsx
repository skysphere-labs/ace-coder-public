import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Home,
  Loader2,
  RotateCw,
  Globe2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import {
  GITHUB_BROWSER_PARTITION,
  GITHUB_HOME,
  describeBrowserLocation,
  loadInitialGithubBrowserUrl,
  normalizeBrowserUrl,
  onGithubBrowserOpen,
  rememberBrowserUrl,
} from '../lib/github-browser';
import { Button } from './ui/button';
import { GithubGlyph } from './ui/github-glyph';

type WebviewEl = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
};

type NavigationEvent = Event & { url?: string; preventDefault?: () => void };

// A <webview> throws "The WebView must be attached to the DOM and the document
// must be fully loaded before calling any methods" from EVERY method (getURL,
// canGoBack, loadURL, reload, …) until its guest page is attached and loaded.
// Before these guards, calling one during an early navigation — e.g. opening a
// link the instant the view mounts — threw straight up through the React render
// tree and tripped the app-level fullscreen ErrorBoundary, replacing the whole
// screen with the crash card. Treat a transient "not ready" as a no-op.
function safeCall<T>(el: WebviewEl | null, fn: (el: WebviewEl) => T, fallback: T): T {
  if (!el) return fallback;
  try {
    return fn(el);
  } catch {
    return fallback;
  }
}
function safeLoadURL(el: WebviewEl | null, url: string) {
  if (!el) return;
  try {
    void el.loadURL(url).catch(() => {});
  } catch {
    /* webview not attached yet; its controlled src still carries the request */
  }
}

// Hosted at the DesktopShell level so the <webview> survives view switches:
// on first visit we mount it, then just toggle CSS visibility. Unmounting
// would destroy the webContents and force a full reload each time.
export function GithubBrowserScreen({ visible }: { visible: boolean }) {
  // Latch: once the user has visited the tab, we render the webview from here
  // on out so it survives view switches. Adjust-state-during-render pattern —
  // set once on the visible→true transition, never back.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  const webviewRef = useRef<WebviewEl | null>(null);
  const [initialSrc] = useState(loadInitialGithubBrowserUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('github.com');
  const [currentUrl, setCurrentUrl] = useState(initialSrc);
  const remote = isRemoteClient();
  const locationIdentity = describeBrowserLocation(currentUrl) ?? {
    normalizedUrl: currentUrl,
    origin: 'Unknown site',
    trustedGithub: false,
  };

  useEffect(() => {
    if (remote) return;
    if (!mounted) return;
    const el = webviewRef.current;
    if (!el) return;

    const syncNav = () => {
      setCanGoBack(safeCall(el, (w) => w.canGoBack(), false));
      setCanGoForward(safeCall(el, (w) => w.canGoForward(), false));
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    // Remember the last location so the pane returns there on the next mount.
    // The URL-derived chrome below keeps non-GitHub locations unmistakable.
    const onNavigate = (ev: Event) => {
      const anyEv = ev as unknown as { url?: string; isMainFrame?: boolean };
      if (anyEv.isMainFrame === false) return;
      const url = anyEv.url || safeCall(el, (w) => w.getURL(), '');
      if (!url || url === 'about:blank') return;
      setCurrentUrl(url);
      syncNav();
      rememberBrowserUrl(url);
    };
    const onTitle = (ev: Event) => {
      const anyEv = ev as unknown as { title?: string };
      const next = anyEv.title || safeCall(el, (w) => w.getTitle(), '') || 'github.com';
      setTitle(next);
    };
    // Follow any http(s) link in-pane so the user can navigate freely once
    // they're in the browser (github → docs → release asset, etc.). Only
    // non-web schemes (mailto:, custom protocols) hand off to the OS.
    const onWillNavigate = (ev: Event) => {
      const navEv = ev as NavigationEvent;
      const url = navEv.url;
      if (!url || url === 'about:blank') return;
      if (normalizeBrowserUrl(url)) return;
      navEv.preventDefault?.();
      void aceApi.workspaces.openExternal(url);
    };
    // target=_blank / window.open inside the pane: keep web links in-pane
    // instead of spawning a separate window; non-web schemes go to the OS.
    const onNewWindow = (ev: Event) => {
      const navEv = ev as NavigationEvent;
      navEv.preventDefault?.();
      const url = navEv.url;
      if (!url) return;
      if (normalizeBrowserUrl(url)) {
        safeLoadURL(el, url);
        return;
      }
      void aceApi.workspaces.openExternal(url);
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('will-navigate', onWillNavigate);
    el.addEventListener('new-window', onNewWindow);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('will-navigate', onWillNavigate);
      el.removeEventListener('new-window', onNewWindow);
    };
  }, [remote, mounted]);

  useEffect(() => {
    if (remote) return;
    return onGithubBrowserOpen(({ url }) => {
      // The browser screen is mounted lazily. Drive its src from this state so
      // an open request received while hidden survives the attach boundary;
      // the old imperative loadURL path could run before attachment, drop the
      // URL, or race this controlled navigation and abort one of the loads.
      setCurrentUrl(url);
    });
  }, [remote]);

  const goBack = () => {
    const el = webviewRef.current;
    if (el && canGoBack) safeCall(el, (w) => w.goBack(), undefined);
  };
  const goForward = () => {
    const el = webviewRef.current;
    if (el && canGoForward) safeCall(el, (w) => w.goForward(), undefined);
  };
  const reload = () => {
    const el = webviewRef.current;
    if (!el) return;
    if (loading) safeCall(el, (w) => w.stop(), undefined);
    else safeCall(el, (w) => w.reload(), undefined);
  };
  const goHome = () => {
    safeLoadURL(webviewRef.current, GITHUB_HOME);
  };
  const openExternal = () => {
    if (!currentUrl) return;
    void aceApi.workspaces.openExternal(currentUrl, { forceExternal: true });
  };

  if (!mounted) return null;

  if (remote) {
    return (
      <div
        className="absolute inset-0 shell-sidebar-surface flex-col items-center justify-center gap-3 text-foreground"
        style={{ display: visible ? 'flex' : 'none' }}
      >
        <p className="text-sm text-muted-foreground">
          GitHub browser is only available in the desktop app.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void aceApi.workspaces.openExternal(GITHUB_HOME)}
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          Open github.com
        </Button>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 shell-sidebar-surface flex-col"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.04] bg-white/[0.02] px-2 py-1.5 backdrop-blur-sm">
        <ChromeButton disabled={!canGoBack} onClick={goBack} title="Back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton disabled={!canGoForward} onClick={goForward} title="Forward">
          <ArrowRight className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton onClick={reload} title={loading ? 'Stop' : 'Reload'}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
        </ChromeButton>
        <ChromeButton onClick={goHome} title="github.com">
          <Home className="h-3.5 w-3.5" />
        </ChromeButton>

        <div className="mx-2 h-4 w-px bg-white/[0.06]" />

        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          title={locationIdentity.normalizedUrl}
          data-browser-origin={locationIdentity.origin}
          data-trusted-github={locationIdentity.trustedGithub ? 'true' : 'false'}
        >
          {locationIdentity.trustedGithub ? (
            <GithubGlyph className="h-3.5 w-3.5 shrink-0 text-foreground/60" />
          ) : (
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-foreground/60" />
          )}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[11.5px] font-medium text-foreground/85">
              {locationIdentity.origin}
            </span>
            <span className="truncate text-[9.5px] text-muted-foreground/70">
              {title}
            </span>
          </div>
        </div>

        <ChromeButton
          onClick={openExternal}
          title="Open in your default browser"
          disabled={!currentUrl}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </ChromeButton>
      </div>

      <div className="relative min-h-0 flex-1">
        <webview
          ref={(el) => {
            webviewRef.current = el as WebviewEl | null;
          }}
          src={currentUrl}
          partition={GITHUB_BROWSER_PARTITION}
          allowpopups
          style={{ width: '100%', height: '100%', display: 'flex' }}
        />
      </div>
    </div>
  );
}

function ChromeButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
        disabled
          ? 'opacity-25'
          : 'hover:bg-white/[0.06] hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
