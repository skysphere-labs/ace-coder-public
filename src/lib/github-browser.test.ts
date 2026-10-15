import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_BROWSER_OPEN_EVENT,
  GITHUB_BROWSER_STORAGE_KEY,
  GITHUB_HOME,
  describeBrowserLocation,
  loadInitialGithubBrowserUrl,
  normalizeGithubUrl,
  onGithubBrowserOpen,
  requestBrowserOpen,
  requestGithubBrowserOpen,
} from './github-browser';

describe('github-browser routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes only GitHub http(s) URLs', () => {
    expect(normalizeGithubUrl('http://github.com/openai/codex')).toBe('https://github.com/openai/codex');
    expect(normalizeGithubUrl('https://gist.github.com/user/abc')).toBe('https://gist.github.com/user/abc');
    expect(normalizeGithubUrl('mailto:security@github.com')).toBeNull();
    expect(normalizeGithubUrl('https://example.com/github.com')).toBeNull();
    expect(normalizeGithubUrl('https://user@github.com/openai/codex')).toBeNull();
    expect(normalizeGithubUrl('https://github.com:444/openai/codex')).toBeNull();
  });

  it('derives trustworthy browser chrome from the full origin, never the page title', () => {
    expect(describeBrowserLocation('https://github.com/openai/codex?tab=readme')).toEqual({
      normalizedUrl: 'https://github.com/openai/codex?tab=readme',
      origin: 'https://github.com',
      trustedGithub: true,
    });
    expect(describeBrowserLocation('https://gist.github.com/user/abc')).toMatchObject({
      origin: 'https://gist.github.com',
      trustedGithub: true,
    });
    expect(describeBrowserLocation('https://github.com.example.test/login')).toMatchObject({
      origin: 'https://github.com.example.test',
      trustedGithub: false,
    });
    expect(describeBrowserLocation('http://github.com/login')).toMatchObject({
      origin: 'http://github.com',
      trustedGithub: false,
    });
    expect(describeBrowserLocation('https://example.com/github.com')).toMatchObject({
      origin: 'https://example.com',
      trustedGithub: false,
    });
  });

  it('restores the last visited location (any site), falling back to github.com', () => {
    const storage = installWindow();

    expect(loadInitialGithubBrowserUrl()).toBe(GITHUB_HOME);
    // The pane is a real browser now: a non-github last location is restored so
    // the user returns where they left off across view switches / restarts.
    storage.set(GITHUB_BROWSER_STORAGE_KEY, 'https://example.com/');
    expect(loadInitialGithubBrowserUrl()).toBe('https://example.com/');
    storage.set(GITHUB_BROWSER_STORAGE_KEY, 'https://github.com/notifications');
    expect(loadInitialGithubBrowserUrl()).toBe('https://github.com/notifications');
    // Non-web junk still falls back to the github home.
    storage.set(GITHUB_BROWSER_STORAGE_KEY, 'not-a-url');
    expect(loadInitialGithubBrowserUrl()).toBe(GITHUB_HOME);
  });

  it('stores and dispatches in-app GitHub browser open requests', () => {
    const storage = installWindow();
    const seen: string[] = [];
    const unsubscribe = onGithubBrowserOpen(({ url }) => seen.push(url));

    expect(requestGithubBrowserOpen('http://github.com/example-org/example-project/pulls')).toBe(true);
    expect(storage.get(GITHUB_BROWSER_STORAGE_KEY)).toBe('https://github.com/example-org/example-project/pulls');
    expect(seen).toEqual(['https://github.com/example-org/example-project/pulls']);

    unsubscribe();
    expect(requestGithubBrowserOpen('https://example.com/')).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('accepts any safe web URL when Hermes explicitly targets the in-app browser', () => {
    const storage = installWindow();
    const seen: string[] = [];
    const unsubscribe = onGithubBrowserOpen(({ url }) => seen.push(url));

    expect(requestBrowserOpen('http://example.com/demo')).toBe(true);
    expect(storage.get(GITHUB_BROWSER_STORAGE_KEY)).toBe('http://example.com/demo');
    expect(seen).toEqual(['http://example.com/demo']);
    expect(requestBrowserOpen('file:///tmp/demo.html')).toBe(false);
    expect(requestBrowserOpen('javascript:alert(1)')).toBe(false);

    unsubscribe();
  });
});

function installWindow() {
  const storage = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    },
  };

  class FakeCustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init: { detail: T }) {
      super(type);
      this.detail = init.detail;
    }
  }

  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('CustomEvent', FakeCustomEvent);
  expect(GITHUB_BROWSER_OPEN_EVENT).toBe('ace:github-browser-open');
  return storage;
}
