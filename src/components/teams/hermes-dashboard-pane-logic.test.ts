import { expect, test } from 'vitest';

import {
  HERMES_DESKTOP_APP_PARTITION,
  HERMES_RESUME_SCRIPT,
  isAbortedLoadError,
  isOutsideHermesRemotePath,
  isRecursiveAceEmbed,
  isRetryableLoadError,
  SELF_EMBED_NOTICE,
  WEBVIEW_MAX_RETRIES,
} from './hermes-dashboard-pane-logic';

// ---------------------------------------------------------------------------
// Partition — must satisfy the will-attach-webview hardening prefix so it
// never gets silently rewritten to the shared GitHub-browser partition.
// ---------------------------------------------------------------------------

test('dashboard partition keeps the hardening prefix and is hermes-isolated', () => {
  expect(HERMES_DESKTOP_APP_PARTITION.startsWith('persist:ace-browser')).toBe(true);
  expect(HERMES_DESKTOP_APP_PARTITION).not.toBe('persist:ace-browser');
  expect(HERMES_DESKTOP_APP_PARTITION).toContain('hermes-desktop-app');
});

test('resume script touches the active Hermes backend and dispatches wake events', async () => {
  const events: string[] = [];
  const touchedProfiles: unknown[] = [];
  class FakeEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  class FakePageTransitionEvent extends FakeEvent {
    persisted: boolean;
    constructor(type: string, init: { persisted?: boolean } = {}) {
      super(type);
      this.persisted = Boolean(init.persisted);
    }
  }
  const fakeWindow = {
    hermesDesktop: {
      profile: { get: () => Promise.resolve({ profile: 'test-profile' }) },
      touchBackend: (profile: unknown) => {
        touchedProfiles.push(profile);
        return Promise.resolve({ ok: true, touched: true });
      },
    },
    dispatchEvent: (event: { type: string }) => {
      events.push(`window:${event.type}`);
      return true;
    },
  };
  const fakeDocument = {
    dispatchEvent: (event: { type: string }) => {
      events.push(`document:${event.type}`);
      return true;
    },
  };

  const run = new Function('window', 'document', 'Event', 'PageTransitionEvent', `return (${HERMES_RESUME_SCRIPT});`);
  expect(run(fakeWindow, fakeDocument, FakeEvent, FakePageTransitionEvent)).toBe(true);
  await Promise.resolve();
  await Promise.resolve();

  expect(touchedProfiles).toEqual(['test-profile']);
  expect(events).toEqual([
    'window:online',
    'window:focus',
    'document:visibilitychange',
    'window:pageshow',
  ]);
});

// ---------------------------------------------------------------------------
// Webview load-error classification — the dashboard binds a beat after spawn,
// so a connection-refused first load must retry, not surface as an error.
// ---------------------------------------------------------------------------

test('connection-style failures are retryable; a 404-style failure is not', () => {
  expect(isRetryableLoadError(-102)).toBe(true); // ERR_CONNECTION_REFUSED
  expect(isRetryableLoadError(-7)).toBe(true); // ERR_TIMED_OUT
  expect(isRetryableLoadError(-105)).toBe(false); // ERR_NAME_NOT_RESOLVED
  expect(isRetryableLoadError(-300)).toBe(false); // ERR_INVALID_URL
});

test('aborted navigations are neither retried nor surfaced', () => {
  expect(isAbortedLoadError(-3)).toBe(true);
  expect(isAbortedLoadError(-102)).toBe(false);
});

test('retry budget is bounded so a dead server eventually surfaces', () => {
  expect(WEBVIEW_MAX_RETRIES).toBeGreaterThan(0);
  expect(WEBVIEW_MAX_RETRIES).toBeLessThanOrEqual(20);
});

// ---------------------------------------------------------------------------
// Self-embed recursion guard — when a service worker or proxy fault serves the
// Ace bundle back into Ace's own Hermes embed frame, the app must not
// boot the full shell (the stacked-Teams-headers mobile bug).
// ---------------------------------------------------------------------------

test('top-level documents are never treated as self-embeds', () => {
  const win = { location: { origin: 'https://ace.example' } } as { self?: unknown; top?: unknown };
  win.self = win;
  win.top = win;
  expect(isRecursiveAceEmbed(win as never)).toBe(false);
});

test('a same-origin parent means Ace was served into its own embed frame', () => {
  const win = {
    self: {},
    top: { location: { origin: 'https://ace.example' } },
    location: { origin: 'https://ace.example' },
  };
  expect(isRecursiveAceEmbed(win)).toBe(true);
});

test('a cross-origin or unreadable parent is not a self-embed', () => {
  const crossOrigin = {
    self: {},
    top: { location: { origin: 'https://other.example' } },
    location: { origin: 'https://ace.example' },
  };
  expect(isRecursiveAceEmbed(crossOrigin)).toBe(false);
  const blocked = {
    self: {},
    top: {
      get location(): { origin: string } {
        throw new Error('cross-origin');
      },
    },
    location: { origin: 'https://ace.example' },
  };
  expect(isRecursiveAceEmbed(blocked)).toBe(false);
});

test('self-embed notice tells the user what happened and how to recover', () => {
  expect(SELF_EMBED_NOTICE).toContain('Hermes dashboard');
  expect(SELF_EMBED_NOTICE).toContain('reopen Teams');
});

// ---------------------------------------------------------------------------
// Remote health-check escape detection — a proxied redirect that lands outside
// /hermes-desktop reaches the SPA fallback, i.e. Ace itself; embedding
// that response recurses.
// ---------------------------------------------------------------------------

test('responses that stay under /hermes-desktop are embeddable', () => {
  const origin = 'https://ace.example';
  expect(isOutsideHermesRemotePath('https://ace.example/hermes-desktop/', origin)).toBe(false);
  expect(isOutsideHermesRemotePath('https://ace.example/hermes-desktop', origin)).toBe(false);
  expect(isOutsideHermesRemotePath('https://ace.example/hermes-desktop/ui/', origin)).toBe(false);
  // Response.url may be empty on some engines — fall back to trusting status.
  expect(isOutsideHermesRemotePath('', origin)).toBe(false);
});

test('responses that escaped the proxy prefix are refused', () => {
  const origin = 'https://ace.example';
  expect(isOutsideHermesRemotePath('https://ace.example/', origin)).toBe(true);
  expect(isOutsideHermesRemotePath('https://ace.example/index.html', origin)).toBe(true);
  expect(isOutsideHermesRemotePath('https://ace.example/hermes-desktopX/', origin)).toBe(true);
});
