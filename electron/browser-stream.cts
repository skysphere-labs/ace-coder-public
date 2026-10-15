// browser-stream — remote-controlled browser hosts for phone/PWA clients.
//
// Desktop Ace renders browser scratch tabs as real <webview>s, but a remote
// client is a plain web page: it cannot embed a webview, and the OAuth
// callbacks agent CLIs use (localhost on the desktop) only complete on the
// desktop machine. So when a remote client views a browser tab, the page is
// hosted here in a hidden OFFSCREEN BrowserWindow on the SAME
// persist:ace-browser partition as the desktop panes (cookies/logins are
// shared), JPEG frames stream to the phone over the remote WS, and
// taps/keys/scrolls come back as input events. Offscreen rendering keeps
// painting when the desktop app is minimized, occluded, or its display is
// asleep — exactly the situations a phone-only session is in.
//
// Frames are change-driven (OSR `paint` events), throttled, and skipped when
// byte-identical, and a host only exists while at least one remote viewer is
// subscribed (plus a short grace period) — this must never become a standing
// per-tab render loop.

const { normalizeBrowserUrl } = require('./browser-control.cts');

const PARTITION = 'persist:ace-browser';
const DEFAULT_VIEW = { width: 390, height: 700, dpr: 2 };
const MIN_DIM = 120;
const MAX_DIM = 1800;
const MAX_DPR = 2;
const FRAME_MIN_INTERVAL_MS = 120;
const FRAME_RATE = 10;
const IDLE_DESTROY_MS = 30_000;
const JPEG_QUALITY = 62;

function clampViewport(input: any = {}) {
  const dpr = Math.min(MAX_DPR, Math.max(1, Number(input.dpr) || DEFAULT_VIEW.dpr));
  const clamp = (v: any, fallback: number) => {
    const n = Math.round(Number(v) || fallback);
    return Math.min(MAX_DIM, Math.max(MIN_DIM, n));
  };
  let width = clamp(input.width, DEFAULT_VIEW.width);
  let height = clamp(input.height, DEFAULT_VIEW.height);
  // The painted bitmap is css × dpr — keep it inside MAX_DIM too.
  if (width * dpr > MAX_DIM) width = Math.floor(MAX_DIM / dpr);
  if (height * dpr > MAX_DIM) height = Math.floor(MAX_DIM / dpr);
  return { width, height, dpr };
}

// Translate a client input event into Electron sendInputEvent payloads.
// Coordinates arrive in frame-bitmap pixel space, which equals the host
// window's DIP space (css × dpr) — no conversion needed here.
function toInputEvents(ev: any) {
  const x = Math.round(Number(ev.x) || 0);
  const y = Math.round(Number(ev.y) || 0);
  if (ev.type === 'tap') {
    const base = { x, y, button: 'left', clickCount: Number(ev.clickCount) || 1 };
    return [
      { type: 'mouseMove', x, y },
      { type: 'mouseDown', ...base },
      { type: 'mouseUp', ...base },
    ];
  }
  if (ev.type === 'wheel') {
    return [
      {
        type: 'mouseWheel',
        x,
        y,
        deltaX: Math.round(Number(ev.deltaX) || 0),
        deltaY: Math.round(Number(ev.deltaY) || 0),
        canScroll: true,
      },
    ];
  }
  if (ev.type === 'key') {
    const keyCode = String(ev.key || '');
    if (!keyCode) return [];
    const events: any[] = [{ type: 'keyDown', keyCode }];
    if (keyCode === 'Enter' || keyCode === 'Return') {
      events.push({ type: 'char', keyCode: '\u000d' });
    }
    events.push({ type: 'keyUp', keyCode });
    return events;
  }
  return [];
}

const EDITABLE_PROBE = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !['button','checkbox','radio','submit','reset','file','image','range','color'].includes(type);
})()`;

function createBrowserTabStreams({ store, emit }: any) {
  if (!store) throw new Error('browser-stream: store required');
  const { BrowserWindow } = require('electron');
  const hosts = new Map();

  function key(taskId: string, tabId: string) {
    return `${taskId}\n${tabId}`;
  }

  function savedTabUrl(taskId: string, tabId: string) {
    try {
      const saved = store.listScratchTabs({ taskId }) || { tabs: [] };
      const tab = (saved.tabs || []).find((t: any) => t && t.id === tabId);
      return tab?.url || '';
    } catch {
      return '';
    }
  }

  function metaFields(host: any) {
    const wc = host.wc;
    if (!wc || wc.isDestroyed()) {
      return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    }
    const nav = wc.navigationHistory;
    return {
      url: wc.getURL() || '',
      title: wc.getTitle() || '',
      loading: !!wc.isLoading(),
      canGoBack: nav?.canGoBack?.() ?? false,
      canGoForward: nav?.canGoForward?.() ?? false,
    };
  }

  function emitEvent(host: any, extra: any = {}) {
    try {
      emit?.({
        taskId: host.taskId,
        tabId: host.tabId,
        seq: host.seq,
        dpr: host.viewport.dpr,
        ...metaFields(host),
        ...extra,
      });
    } catch {}
  }

  function emitFrame(host: any, image: any) {
    let jpeg;
    try {
      jpeg = image.toJPEG(JPEG_QUALITY);
    } catch {
      return;
    }
    if (!jpeg || !jpeg.length) return;
    if (host.lastJpeg && jpeg.equals(host.lastJpeg)) return;
    host.lastJpeg = jpeg;
    host.seq++;
    const size = image.getSize();
    emitEvent(host, {
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: size.width,
      height: size.height,
    });
  }

  // Leading+trailing throttle: the first paint after idle emits immediately,
  // a paint burst collapses to one frame per window with the LAST image.
  function queueFrame(host: any, image: any) {
    if (host.disposed) return;
    const now = Date.now();
    if (!host.frameTimer && now - host.lastFrameAt >= FRAME_MIN_INTERVAL_MS) {
      host.lastFrameAt = now;
      emitFrame(host, image);
      return;
    }
    host.pendingImage = image;
    if (host.frameTimer) return;
    host.frameTimer = setTimeout(() => {
      host.frameTimer = null;
      const pending = host.pendingImage;
      host.pendingImage = null;
      if (pending && !host.disposed) {
        host.lastFrameAt = Date.now();
        emitFrame(host, pending);
      }
    }, Math.max(10, FRAME_MIN_INTERVAL_MS - (now - host.lastFrameAt)));
  }

  function repaint(host: any) {
    try {
      host.wc.invalidate();
    } catch {}
  }

  function assertIds(taskId: any, tabId: any) {
    if (!taskId || typeof taskId !== 'string') throw new Error('browser stream requires taskId');
    if (!tabId || typeof tabId !== 'string') throw new Error('browser stream requires tabId');
  }

  function getHost(taskId: any, tabId: any) {
    assertIds(taskId, tabId);
    const host = hosts.get(key(taskId, tabId));
    if (!host || host.disposed || !host.wc || host.wc.isDestroyed()) {
      throw new Error(`browser tab ${tabId} is not streaming; subscribe first`);
    }
    return host;
  }

  function disposeHost(host: any) {
    if (host.disposed) return;
    host.disposed = true;
    if (host.frameTimer) clearTimeout(host.frameTimer);
    if (host.destroyTimer) clearTimeout(host.destroyTimer);
    host.frameTimer = null;
    host.destroyTimer = null;
    host.pendingImage = null;
    host.lastJpeg = null;
    const current = hosts.get(key(host.taskId, host.tabId));
    if (current === host) hosts.delete(key(host.taskId, host.tabId));
    try {
      if (host.win && !host.win.isDestroyed()) host.win.destroy();
    } catch {}
  }

  function scheduleDestroy(host: any) {
    if (host.destroyTimer || host.disposed) return;
    host.destroyTimer = setTimeout(() => {
      host.destroyTimer = null;
      if (host.refs <= 0) disposeHost(host);
    }, IDLE_DESTROY_MS);
    if (typeof host.destroyTimer.unref === 'function') host.destroyTimer.unref();
  }

  function applyViewport(host: any, viewport: any) {
    host.viewport = viewport;
    const pxW = Math.round(viewport.width * viewport.dpr);
    const pxH = Math.round(viewport.height * viewport.dpr);
    try {
      host.win.setContentSize(pxW, pxH);
    } catch {}
    // Zoom maps DIPs→CSS px: the page lays out at `width` CSS px while the
    // bitmap stays width×dpr — crisp text on high-DPR phones. Chromium
    // persists zoom per-origin, so re-assert after navigations.
    try {
      host.wc.setZoomFactor(viewport.dpr);
    } catch {}
    host.lastJpeg = null;
    repaint(host);
  }

  function ensureHost(taskId: string, tabId: string, viewport: any, initialUrl?: string) {
    const existing = hosts.get(key(taskId, tabId));
    if (existing && !existing.disposed && existing.wc && !existing.wc.isDestroyed()) {
      return existing;
    }
    const pxW = Math.round(viewport.width * viewport.dpr);
    const pxH = Math.round(viewport.height * viewport.dpr);
    const win = new BrowserWindow({
      width: pxW,
      height: pxH,
      show: false,
      title: 'Ace Browser (remote)',
      webPreferences: {
        offscreen: true,
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    const host: any = {
      taskId,
      tabId,
      win,
      wc,
      refs: 0,
      seq: 0,
      viewport,
      lastJpeg: null,
      lastFrameAt: 0,
      pendingImage: null,
      frameTimer: null,
      destroyTimer: null,
      disposed: false,
    };
    hosts.set(key(taskId, tabId), host);

    try {
      wc.setAudioMuted(true);
    } catch {}
    try {
      wc.setFrameRate(FRAME_RATE);
    } catch {}
    wc.on('paint', (_event: any, _dirty: any, image: any) => queueFrame(host, image));
    const onMeta = () => {
      if (host.disposed) return;
      try {
        wc.setZoomFactor(host.viewport.dpr);
      } catch {}
      emitEvent(host);
    };
    wc.on('did-start-loading', onMeta);
    wc.on('did-stop-loading', onMeta);
    wc.on('did-navigate', onMeta);
    wc.on('did-navigate-in-page', onMeta);
    wc.on('page-title-updated', onMeta);
    // OAuth providers open SSO steps via window.open — keep them in-pane,
    // same policy as the desktop browser webview.
    wc.setWindowOpenHandler(({ url }: any) => {
      if (/^https?:/i.test(String(url || ''))) {
        try {
          wc.loadURL(url);
        } catch {}
      }
      return { action: 'deny' };
    });
    wc.once('render-process-gone', () => disposeHost(host));
    win.once('closed', () => disposeHost(host));

    try {
      wc.setZoomFactor(viewport.dpr);
    } catch {}
    const target = initialUrl || savedTabUrl(taskId, tabId);
    if (target) {
      Promise.resolve(wc.loadURL(normalizeBrowserUrl(target))).catch(() => {});
    }
    return host;
  }

  const methods = {
    async browserStreamOpen({ taskId, tabId, width, height, dpr, url }: any) {
      assertIds(taskId, tabId);
      const viewport = clampViewport({ width, height, dpr });
      const host = ensureHost(taskId, tabId, viewport, url);
      host.refs++;
      if (host.destroyTimer) {
        clearTimeout(host.destroyTimer);
        host.destroyTimer = null;
      }
      if (
        host.viewport.width !== viewport.width ||
        host.viewport.height !== viewport.height ||
        host.viewport.dpr !== viewport.dpr
      ) {
        applyViewport(host, viewport);
      } else {
        // New viewer: force a paint so it gets a frame even on a static page.
        host.lastJpeg = null;
        repaint(host);
      }
      return { ok: true, seq: host.seq, dpr: host.viewport.dpr, ...metaFields(host) };
    },

    browserStreamClose({ taskId, tabId }: any) {
      assertIds(taskId, tabId);
      const host = hosts.get(key(taskId, tabId));
      if (!host || host.disposed) return { ok: true };
      host.refs = Math.max(0, host.refs - 1);
      if (host.refs === 0) scheduleDestroy(host);
      return { ok: true };
    },

    async browserStreamNavigate({ taskId, tabId, url, action }: any) {
      const host = getHost(taskId, tabId);
      const wc = host.wc;
      if (action === 'back') wc.navigationHistory?.goBack?.();
      else if (action === 'forward') wc.navigationHistory?.goForward?.();
      else if (action === 'reload') wc.reload();
      else if (action === 'stop') wc.stop();
      else if (url) {
        await Promise.resolve(wc.loadURL(normalizeBrowserUrl(url))).catch(() => {});
      } else {
        throw new Error('browser stream navigate requires url or action');
      }
      repaint(host);
      return { ok: true, ...metaFields(host) };
    },

    async browserStreamInput({ taskId, tabId, events }: any) {
      const host = getHost(taskId, tabId);
      const wc = host.wc;
      const list = Array.isArray(events) ? events : [];
      let probeEditable = false;
      for (const ev of list) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'text') {
          const text = String(ev.text ?? '');
          if (text) await wc.insertText(text).catch(() => {});
          continue;
        }
        if (ev.type === 'tap') probeEditable = true;
        for (const input of toInputEvents(ev)) {
          try {
            wc.sendInputEvent(input);
          } catch {}
        }
      }
      repaint(host);
      // After a tap, tell the client whether a text field took focus so the
      // phone can raise its keyboard without an extra user step.
      let editable = false;
      if (probeEditable) {
        editable = await wc
          .executeJavaScript(EDITABLE_PROBE, false)
          .then((v: any) => !!v)
          .catch(() => false);
      }
      return { ok: true, editable };
    },

    browserStreamResize({ taskId, tabId, width, height, dpr }: any) {
      const host = getHost(taskId, tabId);
      const viewport = clampViewport({ width, height, dpr });
      if (
        host.viewport.width !== viewport.width ||
        host.viewport.height !== viewport.height ||
        host.viewport.dpr !== viewport.dpr
      ) {
        applyViewport(host, viewport);
      }
      return { ok: true };
    },
  };

  function disposeAll() {
    for (const host of [...hosts.values()]) disposeHost(host);
  }

  return { methods, disposeAll, _hosts: hosts };
}

module.exports = { createBrowserTabStreams, clampViewport, toInputEvents };
