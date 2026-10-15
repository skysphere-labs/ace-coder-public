import { describe, it, expect, beforeEach } from 'vitest';

const {
  HERMES_DESKTOP_EMBED_SHIM_SCRIPT,
  injectHermesDesktopEmbedShim,
} = require('../hermes-desktop-embed-shim.cts');

describe('injectHermesDesktopEmbedShim', () => {
  it('inserts the shim as the first script inside <head>', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="/assets/app.js"></script></head><body></body></html>';
    const out = injectHermesDesktopEmbedShim(html);
    const shimAt = out.indexOf('data-ace-hermes-embed-shim');
    const headAt = out.indexOf('<head>');
    const firstAssetAt = out.indexOf('/assets/app.js');
    expect(shimAt).toBeGreaterThan(headAt);
    expect(shimAt).toBeLessThan(firstAssetAt);
  });

  it('handles <head> tags with attributes', () => {
    const out = injectHermesDesktopEmbedShim('<html><head data-x="1"><title>t</title></head></html>');
    expect(out.indexOf('data-ace-hermes-embed-shim')).toBeLessThan(out.indexOf('<title>'));
  });

  it('falls back to <html> and then to prepending when no head exists', () => {
    const noHead = injectHermesDesktopEmbedShim('<html><body>x</body></html>');
    expect(noHead.indexOf('data-ace-hermes-embed-shim')).toBeLessThan(noHead.indexOf('<body>'));
    const bare = injectHermesDesktopEmbedShim('plain text');
    expect(bare.startsWith('<script data-ace-hermes-embed-shim')).toBe(true);
  });

  it('is idempotent', () => {
    const once = injectHermesDesktopEmbedShim('<html><head></head></html>');
    expect(injectHermesDesktopEmbedShim(once)).toBe(once);
  });
});

describe('HERMES_DESKTOP_EMBED_SHIM_SCRIPT runtime behavior', () => {
  let win;

  const runShim = () => {
    // The script is shipped into a foreign page; evaluate it against a stub
    // window the same way the browser would (bare identifiers resolve to
    // window properties via the param list).
    const fn = new Function(
      'window',
      'location',
      'navigator',
      HERMES_DESKTOP_EMBED_SHIM_SCRIPT.replace(/^\(\(\) => \{/, '').replace(/\}\)\(\);?$/, '')
    );
    fn(win, win.location, win.navigator);
  };

  beforeEach(() => {
    win = {
      location: { protocol: 'https:', host: 'ace.example.com', origin: 'https://ace.example.com' },
      document: { cookie: '' },
      navigator: {},
      __HERMES_SESSION_TOKEN__: undefined,
    };
  });

  it('never clobbers a real preload bridge', () => {
    const real = { api: () => {} };
    win.hermesDesktop = real;
    runShim();
    expect(win.hermesDesktop).toBe(real);
  });

  it('installs a bridge whose default connection points at the same-origin proxy', async () => {
    runShim();
    // Token is injected by the sidecar bootstrap AFTER the shim runs; the
    // shim must pick it up lazily.
    win.__HERMES_SESSION_TOKEN__ = 'tok-123';
    const conn = await win.hermesDesktop.getConnection();
    expect(conn.baseUrl).toBe('https://ace.example.com/hermes-desktop');
    expect(conn.wsUrl).toBe('wss://ace.example.com/hermes-desktop/api/ws?token=tok-123');
    expect(conn.token).toBe('tok-123');
    expect(conn.mode).toBe('local');
    expect(conn.profile).toBe(undefined);
    expect(await win.hermesDesktop.getGatewayWsUrl()).toBe(conn.wsUrl);
  });

  it('routes a named profile connection to the one app sidecar with the profile token', async () => {
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            result: {
              baseUrl: 'http://127.0.0.1:51234',
              token: 'profile-token',
              profile: 'profile-a',
            },
          }),
      };
    };
    runShim();
    const conn = await win.hermesDesktop.getConnection('ace-session:profile-a');
    expect(calls[0].url).toBe('/api/hermesDesktopAppConnection');
    expect(calls[0].init.headers.authorization).toBe('Bearer cap-token');
    expect(JSON.parse(calls[0].init.body)).toEqual({ profile: 'profile-a' });
    // Single-sidecar: the base /hermes-desktop proxy (the one app sidecar), no
    // per-profile (/__profile/) sub-proxy — but still the profile's session token.
    expect(conn.baseUrl).toBe('https://ace.example.com/hermes-desktop');
    expect(conn.wsUrl).toBe(
      'wss://ace.example.com/hermes-desktop/api/ws?token=profile-token'
    );
    expect(conn.token).toBe('profile-token');
    expect(conn.profile).toBe('profile-a');
  });

  it('api() aliases the operator id to the backend profile (alpha -> default) on profile-scoped paths', async () => {
    // ft-08d2a768: an identity-home sidecar serves only 'default'; without the
    // alias the SPA's ?profile=alpha 404s "Profile 'alpha' does not exist".
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith('/api/hermesDesktopAppConnection')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              result: { token: 'alpha-token', profile: 'alpha', backendProfile: 'default' },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"sessions":[]}' };
    };
    runShim();
    globalThis.fetch = win.fetch;
    try {
      const result = await win.hermesDesktop.api({
        path: '/api/profiles/sessions?limit=50&profile=alpha&order=recent',
        profile: 'alpha',
      });
      expect(result).toEqual({ sessions: [] });
      const apiCall = calls.find((c) => String(c.url).includes('/api/profiles/sessions'));
      expect(apiCall).toBeTruthy();
      expect(String(apiCall.url)).toContain('profile=default');
      expect(String(apiCall.url)).not.toContain('profile=alpha');
      // Single-sidecar: routed through the base /hermes-desktop proxy (the one app
      // sidecar), no per-profile sub-proxy.
      expect(String(apiCall.url)).toContain('/hermes-desktop/api/profiles/sessions');
      expect(String(apiCall.url)).not.toContain('/__profile/');
    } finally {
      delete globalThis.fetch;
    }
  });

  it('api() aliases PATH-style profile segments (alpha/soul -> default/soul)', async () => {
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith('/api/hermesDesktopAppConnection')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ ok: true, result: { token: 'alpha-token', profile: 'alpha', backendProfile: 'default' } }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"soul":"x"}' };
    };
    runShim();
    globalThis.fetch = win.fetch;
    try {
      await win.hermesDesktop.api({ path: '/api/profiles/alpha/soul', profile: 'alpha' });
      const call = calls.find((c) => String(c.url).includes('/api/profiles/'));
      expect(String(call.url)).toContain('/api/profiles/default/soul');
      expect(String(call.url)).not.toContain('/api/profiles/alpha/');
    } finally {
      delete globalThis.fetch;
    }
  });

  it('api() aliases ?profile=<op> even when request.profile is omitted (the real SPA session-list call)', async () => {
    // hermes.ts listAllProfileSessions bakes &profile=<op> into the URL and calls
    // api({path}) with NO request.profile, so connection() lands on the global
    // (no-profile) branch. The shim must still resolve the active sidecar's
    // backendProfile so <op>→'default' fires; otherwise an identity-home sidecar
    // 404s "Profile '<op>' does not exist" and latches the boot overlay (mobile).
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.__HERMES_SESSION_TOKEN__ = 'tok-x';
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith('/api/hermesDesktopAppConnection')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, result: { backendProfile: 'default' } }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"sessions":[]}' };
    };
    win.fetch = fetchImpl;
    runShim();
    globalThis.fetch = fetchImpl;
    try {
      const result = await win.hermesDesktop.api({
        path: '/api/profiles/sessions?limit=50&order=recent&profile=alpha',
      });
      expect(result).toEqual({ sessions: [] });
      const apiCall = calls.find((c) => String(c.url).includes('/api/profiles/sessions'));
      expect(apiCall).toBeTruthy();
      expect(String(apiCall.url)).toContain('profile=default');
      expect(String(apiCall.url)).not.toContain('profile=alpha');
      // No request.profile → routed through the global sidecar, not a __profile proxy.
      expect(String(apiCall.url)).toContain('/hermes-desktop/api/profiles/sessions');
    } finally {
      delete globalThis.fetch;
    }
  });

  it('api() never rewrites the reserved /api/profiles/active endpoint', async () => {
    // /api/profiles/active returns the current profile; rewriting the 'active'
    // segment to /api/profiles/default 404s "No such API endpoint".
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    const fetchImpl = async (url) => {
      calls.push({ url });
      if (String(url).endsWith('/api/hermesDesktopAppConnection')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, result: { backendProfile: 'default' } }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"active":"default"}' };
    };
    win.fetch = fetchImpl;
    runShim();
    globalThis.fetch = fetchImpl;
    try {
      await win.hermesDesktop.api({ path: '/api/profiles/active' });
      const call = calls.find((c) => String(c.url).includes('/api/profiles/'));
      expect(String(call.url)).toContain('/api/profiles/active');
      expect(String(call.url)).not.toContain('/api/profiles/default');
    } finally {
      delete globalThis.fetch;
    }
  });

  it('api() re-tags session rows with the active operator id so the list is not filtered out', async () => {
    // An identity-home sidecar serves 'default'; the request profile is aliased
    // <op>->default to resolve, but the SPA scopes its session list to the active
    // operator. Without re-tagging the response, the 'default'-tagged rows are
    // filtered out and the sidebar shows no history (mobile-only — the desktop
    // bridge re-tags for free). The session-list call omits request.profile, so
    // the operator id is resolved from the active connection.
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.__HERMES_SESSION_TOKEN__ = 'tok-x';
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/api/hermesDesktopAppConnection')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, result: { backendProfile: 'default', profile: 'alpha' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessions: [{ id: 's1', profile: 'default' }, { id: 's2' }], total: 2 }),
      };
    };
    win.fetch = fetchImpl;
    runShim();
    globalThis.fetch = fetchImpl;
    try {
      const result = await win.hermesDesktop.api({
        path: '/api/profiles/sessions?limit=50&order=recent&profile=all',
      });
      // Both rows (the 'default'-tagged one and the untagged one) are tagged to
      // the operator; an already-named profile would be left alone.
      expect(result.sessions.map((s) => s.profile)).toEqual(['alpha', 'alpha']);
      expect(result.profile_totals.alpha).toBe(2);
    } finally {
      delete globalThis.fetch;
    }
  });

  it('reports a ready boot phase so the failure overlay never shows', async () => {
    runShim();
    const boot = await win.hermesDesktop.getBootProgress();
    expect(boot.phase).toBe('backend.ready');
    expect(boot.error).toBe(null);
    const bootstrap = await win.hermesDesktop.getBootstrapState();
    expect(bootstrap.active).toBe(false);
    expect(bootstrap.error).toBe(null);
  });

  it('api() sends a bearer-token JSON fetch against the proxy and rejects non-/api paths', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    win.fetch = fetchImpl;
    runShim();
    win.__HERMES_SESSION_TOKEN__ = 'tok-9';
    // The shim body references bare `fetch`; rebind through window for the test.
    const api = win.hermesDesktop.api;
    globalThis.fetch = fetchImpl;
    try {
      const result = await api({ path: '/api/status', method: 'POST', body: { a: 1 } });
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe('https://ace.example.com/hermes-desktop/api/status');
      expect(calls[0].init.headers.authorization).toBe('Bearer tok-9');
      expect(calls[0].init.headers['content-type']).toBe('application/json');
      expect(calls[0].init.body).toBe('{"a":1}');
      await expect(api({ path: '/etc/passwd' })).rejects.toThrow(/must start with \/api\//);
    } finally {
      delete globalThis.fetch;
    }
  });

  it('profile.set uses the Ace profile manager instead of returning a fake null profile', async () => {
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.setTimeout = (fn) => {
      fn();
      return 1;
    };
    win.location.href = 'https://ace.example.com/hermes-desktop/#/chat';
    win.location.assign = (url) => calls.push({ assigned: url });
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { profile: 'profile-b', changed: true } }),
      };
    };
    runShim();
    const result = await win.hermesDesktop.profile.set('profile-b');
    expect(result).toEqual({ profile: 'profile-b', changed: true });
    expect(calls[0].url).toBe('/api/hermesDesktopSetActiveProfile');
    expect(JSON.parse(calls[0].init.body)).toEqual({ profile: 'profile-b' });
    expect(calls[1].assigned).toContain('aceProfile=profile-b');
  });

  // ft-08d2a768: the boot GET /api/profiles/sessions can race the sidecar's
  // route mount (transient 404) or the proxy warm-up (503); the SPA latches the
  // un-retried "Hermes couldn't start" overlay on a single failure, so the shim
  // retries idempotent GETs through the boot window.
  function scriptedFetch(outcomes) {
    let i = 0;
    const calls = { count: 0 };
    const fn = async () => {
      calls.count += 1;
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (o.throw) throw new Error('network down');
      return { ok: o.status === 200, status: o.status, text: async () => o.body ?? '' };
    };
    return { fn, calls };
  }

  async function withInstantTimers(run) {
    const realSetTimeout = globalThis.setTimeout;
    // Run the scheduled callback immediately so backoff sleeps add no wall time.
    globalThis.setTimeout = (cb) => { cb(); return 0; };
    try {
      return await run();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  it('api() retries a transient boot 404/503 on GET until it succeeds', async () => {
    const { fn, calls } = scriptedFetch([
      { status: 404 },
      { status: 503 },
      { status: 200, body: '{"sessions":[]}' },
    ]);
    win.fetch = fn;
    runShim();
    win.__HERMES_SESSION_TOKEN__ = 'tok-r';
    globalThis.fetch = fn;
    try {
      const result = await withInstantTimers(() =>
        win.hermesDesktop.api({ path: '/api/profiles/sessions' })
      );
      expect(result).toEqual({ sessions: [] });
      expect(calls.count).toBe(3);
    } finally {
      delete globalThis.fetch;
    }
  });

  it('api() bounds a persistent boot 404 GET and never retries a mutation', async () => {
    const persistent = scriptedFetch([{ status: 404 }]);
    win.fetch = persistent.fn;
    runShim();
    win.__HERMES_SESSION_TOKEN__ = 'tok-r';
    globalThis.fetch = persistent.fn;
    try {
      await withInstantTimers(async () => {
        await expect(win.hermesDesktop.api({ path: '/api/profiles/sessions' })).rejects.toThrow(/HTTP 404/);
      });
      expect(persistent.calls.count).toBeGreaterThan(1);
      expect(persistent.calls.count).toBeLessThanOrEqual(6);

      const mutation = scriptedFetch([{ status: 404 }, { status: 200, body: '{}' }]);
      win.fetch = mutation.fn;
      globalThis.fetch = mutation.fn;
      await withInstantTimers(async () => {
        await expect(
          win.hermesDesktop.api({ path: '/api/sessions', method: 'POST', body: { a: 1 } })
        ).rejects.toThrow(/HTTP 404/);
      });
      expect(mutation.calls.count).toBe(1);
    } finally {
      delete globalThis.fetch;
    }
  });

  it('resolves browser File attachments through the mobile shim file bridge', async () => {
    class StubFileReader {
      result = null;
      error = null;
      onload = null;
      onerror = null;

      readAsDataURL(file) {
        file.text().then(
          (text) => {
            this.result = `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(text).toString('base64')}`;
            this.onload?.();
          },
          (err) => {
            this.error = err;
            this.onerror?.();
          }
        );
      }

      readAsText(file) {
        file.text().then(
          (text) => {
            this.result = text;
            this.onload?.();
          },
          (err) => {
            this.error = err;
            this.onerror?.();
          }
        );
      }
    }

    win.FileReader = StubFileReader;
    runShim();
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const target = win.hermesDesktop.getPathForFile(file);

    expect(target.startsWith('ace-mobile-file://')).toBe(true);
    await expect(win.hermesDesktop.readFileDataUrl(target)).resolves.toBe('data:text/plain;base64,aGVsbG8=');
    await expect(win.hermesDesktop.readFileText(target)).resolves.toMatchObject({
      binary: false,
      byteSize: 5,
      language: 'text',
      mimeType: 'text/plain',
      path: target,
      text: 'hello',
      truncated: false,
    });
  });

  it('persists mobile image buffers through the Ace paste-file bridge', async () => {
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { path: '/tmp/ace-paste/paste.png' } }),
      };
    };
    runShim();

    const path = await win.hermesDesktop.saveImageBuffer({
      data: 'data:image/png;base64,aGVsbG8=',
      ext: '.png',
    });

    expect(path).toBe('/tmp/ace-paste/paste.png');
    expect(calls[0].url).toBe('/api/pasteClipboardImage');
    expect(calls[0].init.headers.authorization).toBe('Bearer cap-token');
    expect(JSON.parse(calls[0].init.body)).toEqual({ bytes: 'aGVsbG8=', ext: 'png' });
  });

  it('persists Hermes Desktop positional image buffers through the Ace paste-file bridge', async () => {
    const calls = [];
    win.document.cookie = 'ace.remoteToken=cap-token';
    win.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ ok: true, result: { path: `/tmp/ace-paste/paste-${calls.length}.png` } }),
      };
    };
    runShim();

    const uint8Path = await win.hermesDesktop.saveImageBuffer(new Uint8Array([1, 2, 3]), '.PNG');
    const arrayBufferPath = await win.hermesDesktop.saveImageBuffer(
      new Uint8Array([4, 5, 6]).buffer,
      'jpeg'
    );

    expect(uint8Path).toBe('/tmp/ace-paste/paste-1.png');
    expect(arrayBufferPath).toBe('/tmp/ace-paste/paste-2.png');
    expect(calls.map((call) => call.url)).toEqual(['/api/pasteClipboardImage', '/api/pasteClipboardImage']);
    expect(JSON.parse(calls[0].init.body)).toEqual({ bytes: 'AQID', ext: 'png' });
    expect(JSON.parse(calls[1].init.body)).toEqual({ bytes: 'BAUG', ext: 'jpeg' });
  });

  it('desktop-only capabilities degrade to benign failures, not crashes', async () => {
    runShim();
    expect(await win.hermesDesktop.selectPaths()).toEqual([]);
    expect(await win.hermesDesktop.notify()).toBe(false);
    expect(await win.hermesDesktop.gitRoot()).toBe(null);
    expect(await win.hermesDesktop.sanitizeWorkspaceCwd('/tmp/project')).toEqual({
      cwd: '/tmp/project',
      sanitized: false,
    });
    expect(win.hermesDesktop.getPathForFile()).toBe('');
    await expect(win.hermesDesktop.readFileText()).rejects.toThrow(/Mobile file is not available/);
    await expect(win.hermesDesktop.terminal.start()).rejects.toThrow(/unavailable in the mobile embed/);
    expect(await win.hermesDesktop.terminal.write()).toBe(false);
    const unsubscribe = win.hermesDesktop.onBootProgress(() => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
