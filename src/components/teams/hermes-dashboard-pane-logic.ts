// Shared Hermes Desktop embed constants and guards.

export const HERMES_DESKTOP_APP_PARTITION = 'persist:ace-browser-hermes-desktop-app';
export const HERMES_DESKTOP_APP_OWNER_KEY = 'hermes-desktop-app';
export const HERMES_DESKTOP_REMOTE_PATH = '/hermes-desktop/';
export const HERMES_RESUME_SCRIPT = `
  (() => {
    try {
      const bridge = window.hermesDesktop;
      Promise.resolve(bridge?.profile?.get?.())
        .then((active) => bridge?.touchBackend?.(active && active.profile ? active.profile : undefined))
        .catch(() => {});
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      try {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      } catch {
        window.dispatchEvent(new Event('pageshow'));
      }
      return true;
    } catch (error) {
      return false;
    }
  })()
`;

// hermes dashboard binds uvicorn a beat after spawn, so the first webview load
// can hit ERR_CONNECTION_REFUSED; the pane retries the load this many times,
// spaced WEBVIEW_RETRY_DELAY_MS apart, before surfacing a real failure.
export const WEBVIEW_MAX_RETRIES = 12;
export const WEBVIEW_RETRY_DELAY_MS = 1000;

export const STARTING_RETRY_COPY = 'Waiting for the Hermes dashboard to come online…';

// did-fail-load fires for many reasons; only transient connection errors (the
// server still warming up) warrant a silent reload retry. -3 is ERR_ABORTED
// (a superseded navigation), which we also ignore rather than surface.
const RETRYABLE_LOAD_ERRORS = new Set([
  -102, // ERR_CONNECTION_REFUSED — uvicorn not bound yet
  -106, // ERR_INTERNET_DISCONNECTED
  -109, // ERR_ADDRESS_UNREACHABLE
  -7, // ERR_TIMED_OUT
  -2, // ERR_FAILED (generic transient)
]);

export function isRetryableLoadError(errorCode: number): boolean {
  return RETRYABLE_LOAD_ERRORS.has(errorCode);
}

/** ERR_ABORTED — a navigation replaced by another; never an error to show. */
export function isAbortedLoadError(errorCode: number): boolean {
  return errorCode === -3;
}

// Shown instead of the app shell when the Ace bundle finds itself inside
// a same-origin iframe of itself (a service worker or proxy fault answered a
// /hermes-desktop navigation with the Ace SPA). Booting the shell there
// recurses: stacked Teams headers/navs on mobile.
export const SELF_EMBED_NOTICE =
  'The Hermes dashboard isn’t reachable right now — this frame received the Ace app instead. Close and reopen Teams to retry.';

/**
 * True when this document is the Ace SPA running inside a same-origin
 * iframe — which only happens when Ace's own Hermes embed was served the
 * Ace bundle back (the recursion seed). A cross-origin parent (origin
 * access throws) is not self-embedding.
 */
export function isRecursiveAceEmbed(
  win: { self?: unknown; top?: { location?: { origin?: string } } | null; location?: { origin?: string } } = globalThis as never
): boolean {
  try {
    if (!win.top || win.self === win.top) return false;
    const topOrigin = win.top.location?.origin;
    return Boolean(topOrigin) && topOrigin === win.location?.origin;
  } catch {
    return false;
  }
}

/**
 * Remote health-check guard: the pane only embeds what the /hermes-desktop
 * proxy itself serves. A response whose final URL escaped that prefix (an
 * upstream redirect followed out to the SPA fallback) would put the Ace
 * app — not Hermes — in the iframe and recurse.
 */
export function isOutsideHermesRemotePath(finalUrl: string, origin: string): boolean {
  if (!finalUrl) return false; // some engines leave Response.url empty — trust the status instead
  try {
    const prefix = HERMES_DESKTOP_REMOTE_PATH.replace(/\/$/, '');
    const pathname = new URL(finalUrl, origin).pathname;
    return pathname !== prefix && !pathname.startsWith(`${prefix}/`);
  } catch {
    return true;
  }
}

/**
 * The operator profile the cron→home delivery sweep must target. A successful
 * in-frame profile switch (SPA rail click) updates the scraped active tab but
 * NOT the embed URL, so the live active profile wins over the URL; the URL's
 * aceProfile param is only the fallback before the first profile sync lands.
 *
 * The scraped rail label and the aceProfile param are DISPLAY names ('Vector'),
 * but the sidecar keys sessions, pins, and delivery scope by the lower-cased
 * profile id ('vector'). This returns the canonical (trimmed, lower-cased) id so
 * restore/sync bind the same profile the sidecar serves — forwarding a mixed-case
 * display name verbatim would, after an in-frame switch, make them bind a
 * different (or the default) profile.
 */
export function resolveActiveEmbedProfile(
  profiles: ReadonlyArray<{ name?: string | null; active?: boolean }>,
  url: string | null,
  origin = 'http://localhost'
): string | null {
  const canonical = (value: string | null | undefined) => {
    const id = String(value ?? '').trim().toLowerCase();
    return id || null;
  };
  const active = canonical(profiles.find((p) => p?.active)?.name);
  if (active) return active;
  if (!url) return null;
  try {
    return canonical(new URL(url, origin).searchParams.get('aceProfile'));
  } catch {
    return null;
  }
}

/**
 * A bound home-restore result is stale — must not seed the live frame — when the
 * document live at bind time is gone. Any one signal condemns it:
 *  - generation: per-document counter (bumped on did-start-loading) — the ONLY
 *    signal that catches a same-URL reload (identical url/profile/frameLoaded).
 *  - profile: an in-frame rail switch moves the profile without rewriting the url.
 *  - url: in-frame SPA nav that changes the embed url without a document load.
 *  - frameLoaded: the frame is mid-load or torn down.
 */
export function homeRestoreResultIsStale(bound: {
  generationAtStart: number;
  urlAtStart: string;
  profileAtStart: string | null;
  generationNow: number;
  urlNow: string;
  profileNow: string | null;
  frameLoaded: boolean;
}): boolean {
  return (
    !bound.frameLoaded ||
    bound.generationNow !== bound.generationAtStart ||
    bound.urlNow !== bound.urlAtStart ||
    bound.profileNow !== bound.profileAtStart
  );
}
