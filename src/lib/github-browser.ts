export const GITHUB_HOME = 'https://github.com/';
export const GITHUB_BROWSER_PARTITION = 'persist:ace-browser';
export const GITHUB_BROWSER_STORAGE_KEY = 'ace:github-browser:last-url';
export const GITHUB_BROWSER_OPEN_EVENT = 'ace:github-browser-open';

export type GithubBrowserOpenDetail = {
  url: string;
};

export type BrowserLocationIdentity = {
  normalizedUrl: string;
  origin: string;
  trustedGithub: boolean;
};

// Any http/https URL, normalized. Once the user is inside the browser pane we
// let them follow ANY link (a github README out to docs, a release asset, etc.)
// and navigate freely — the pane behaves like a real browser, not a github-only
// frame. Used for in-pane navigation and for persisting the last location.
export function normalizeBrowserUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeGithubUrl(url: string): string | null {
  const normalized = normalizeBrowserUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isGithubUrl(url: string): boolean {
  return normalizeGithubUrl(url) !== null;
}

// The pane can intentionally host general web links opened by Hermes, but its
// chrome must never let an arbitrary page masquerade as GitHub. This identity
// is derived from the URL rather than the page-controlled title. Only a
// credential-free, standard-port HTTPS github.com origin receives GitHub
// branding; every other page is shown with generic browser chrome and its
// complete origin (scheme, hostname, and port).
export function describeBrowserLocation(url: string): BrowserLocationIdentity | null {
  const normalizedUrl = normalizeBrowserUrl(url);
  if (!normalizedUrl) return null;
  try {
    const parsed = new URL(normalizedUrl);
    const githubHost = parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com');
    const trustedGithub = githubHost && parsed.protocol === 'https:' &&
      !parsed.username && !parsed.password && !parsed.port;
    return {
      normalizedUrl,
      origin: parsed.origin,
      trustedGithub,
    };
  } catch {
    return null;
  }
}

// Restore wherever the pane was last. General web locations receive generic
// chrome with a visible origin; they are never presented as GitHub pages.
export function loadInitialGithubBrowserUrl(): string {
  if (typeof window === 'undefined') return GITHUB_HOME;
  try {
    const stored = window.localStorage.getItem(GITHUB_BROWSER_STORAGE_KEY);
    return stored ? normalizeBrowserUrl(stored) ?? GITHUB_HOME : GITHUB_HOME;
  } catch {
    return GITHUB_HOME;
  }
}

// Persist ANY http(s) location the pane lands on, so reopening returns there.
export function rememberBrowserUrl(url: string): string | null {
  const normalized = normalizeBrowserUrl(url);
  if (!normalized || typeof window === 'undefined') return normalized;
  try {
    window.localStorage.setItem(GITHUB_BROWSER_STORAGE_KEY, normalized);
  } catch {
    /* storage unavailable - best-effort persistence */
  }
  return normalized;
}

// Github-only variant kept for the routing path: only github links are allowed
// to open the pane from elsewhere in the app (see requestGithubBrowserOpen).
export function rememberGithubBrowserUrl(url: string): string | null {
  const normalized = normalizeGithubUrl(url);
  if (!normalized || typeof window === 'undefined') return normalized;
  try {
    window.localStorage.setItem(GITHUB_BROWSER_STORAGE_KEY, normalized);
  } catch {
    /* storage unavailable - best-effort persistence */
  }
  return normalized;
}

export function requestGithubBrowserOpen(url: string): boolean {
  if (typeof window === 'undefined') return false;
  const normalized = rememberGithubBrowserUrl(url);
  if (!normalized) return false;
  dispatchBrowserOpen(normalized);
  return true;
}

function dispatchBrowserOpen(normalized: string): void {
  window.dispatchEvent(
    new CustomEvent<GithubBrowserOpenDetail>(GITHUB_BROWSER_OPEN_EVENT, {
      detail: { url: normalized },
    })
  );
}

// Explicit in-app browser route for trusted product surfaces such as the
// embedded Hermes renderer. General app openExternal calls remain GitHub-only
// so OAuth/docs links still reach the user's system browser by default.
export function requestBrowserOpen(url: string): boolean {
  if (typeof window === 'undefined') return false;
  const normalized = rememberBrowserUrl(url);
  if (!normalized) return false;
  dispatchBrowserOpen(normalized);
  return true;
}

export function onGithubBrowserOpen(
  listener: (detail: GithubBrowserOpenDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<GithubBrowserOpenDetail>).detail;
    if (!detail?.url) return;
    const normalized = normalizeBrowserUrl(detail.url);
    if (!normalized) return;
    listener({ url: normalized });
  };
  window.addEventListener(GITHUB_BROWSER_OPEN_EVENT, handler);
  return () => window.removeEventListener(GITHUB_BROWSER_OPEN_EVENT, handler);
}
