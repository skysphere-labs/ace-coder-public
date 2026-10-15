import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { createBrowserTabStreams, clampViewport, toInputEvents } = require('../browser-stream.cts');

function fakeImage(payload, width = 780, height = 1400) {
  return {
    toJPEG: () => Buffer.from(payload),
    getSize: () => ({ width, height }),
  };
}

function installFakeElectron() {
  const created = [];

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.url = '';
      this.title = '';
      this.loading = false;
      this.destroyed = false;
      this.zoomFactors = [];
      this.inputEvents = [];
      this.insertedText = [];
      this.invalidateCount = 0;
      this.editableProbeResult = false;
      this.windowOpenHandler = null;
      this.navigationHistory = {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: vi.fn(),
        goForward: vi.fn(),
      };
    }

    isDestroyed() {
      return this.destroyed;
    }

    async loadURL(url) {
      this.url = url;
      this.title = url;
      this.emit('did-navigate');
    }

    getURL() {
      return this.url;
    }

    getTitle() {
      return this.title;
    }

    isLoading() {
      return this.loading;
    }

    setZoomFactor(f) {
      this.zoomFactors.push(f);
    }

    setAudioMuted() {}

    setFrameRate() {}

    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }

    sendInputEvent(ev) {
      this.inputEvents.push(ev);
    }

    async insertText(text) {
      this.insertedText.push(text);
    }

    async executeJavaScript() {
      return this.editableProbeResult;
    }

    invalidate() {
      this.invalidateCount++;
    }

    reload() {
      this.reloaded = true;
    }

    stop() {}
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.contentSizes = [];
      created.push(this);
    }

    setContentSize(w, h) {
      this.contentSizes.push([w, h]);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.emit('closed');
    }
  }

  const previous = require.cache[require.resolve('electron')];
  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: { BrowserWindow: FakeBrowserWindow },
  };
  const restore = () => {
    if (previous) require.cache[require.resolve('electron')] = previous;
    else delete require.cache[require.resolve('electron')];
  };
  return { created, restore };
}

function makeStore(tabs = []) {
  return {
    listScratchTabs: () => ({ tabs, activeId: null }),
    saveScratchTabs: () => ({ ok: true }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('open creates a hidden offscreen host on the shared browser partition and loads the saved URL', async () => {
  const { created, restore } = installFakeElectron();
  try {
    const events = [];
    const streams = createBrowserTabStreams({
      store: makeStore([{ id: 'br-1', kind: 'browser', url: 'https://claude.ai/oauth/x' }]),
      emit: (p) => events.push(p),
    });
    const opened = await streams.methods.browserStreamOpen({
      taskId: 't1',
      tabId: 'br-1',
      width: 390,
      height: 700,
      dpr: 2,
    });
    expect(created).toHaveLength(1);
    const win = created[0];
    expect(win.opts.show).toBe(false);
    expect(win.opts.webPreferences).toMatchObject({
      offscreen: true,
      partition: 'persist:ace-browser',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    // bitmap = css × dpr
    expect(win.opts.width).toBe(780);
    expect(win.opts.height).toBe(1400);
    expect(win.webContents.zoomFactors).toContain(2);
    expect(win.webContents.url).toBe('https://claude.ai/oauth/x');
    expect(opened).toMatchObject({ ok: true, url: 'https://claude.ai/oauth/x' });
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('paint events stream throttled deduplicated JPEG frames with metadata', async () => {
  vi.useFakeTimers();
  const { created, restore } = installFakeElectron();
  try {
    const events = [];
    const streams = createBrowserTabStreams({ store: makeStore(), emit: (p) => events.push(p) });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    const wc = created[0].webContents;
    wc.url = 'https://claude.ai/login';

    wc.emit('paint', null, null, fakeImage('frame-1'));
    const frames = () => events.filter((e) => e.image);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({
      taskId: 't1',
      tabId: 'br-1',
      seq: 1,
      url: 'https://claude.ai/login',
      width: 780,
      height: 1400,
    });
    expect(frames()[0].image.startsWith('data:image/jpeg;base64,')).toBe(true);

    // Burst: second paint inside the window is deferred; the LAST image wins.
    wc.emit('paint', null, null, fakeImage('frame-2'));
    wc.emit('paint', null, null, fakeImage('frame-3'));
    expect(frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(frames()).toHaveLength(2);
    expect(frames()[1].seq).toBe(2);

    // Identical bytes are never re-sent.
    await vi.advanceTimersByTimeAsync(500);
    wc.emit('paint', null, null, fakeImage('frame-3'));
    expect(frames()).toHaveLength(2);
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('input events map to Electron input, text inserts, and taps probe editability', async () => {
  const { created, restore } = installFakeElectron();
  try {
    const streams = createBrowserTabStreams({ store: makeStore(), emit: () => {} });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    const wc = created[0].webContents;
    wc.editableProbeResult = true;

    const result = await streams.methods.browserStreamInput({
      taskId: 't1',
      tabId: 'br-1',
      events: [
        { type: 'tap', x: 100, y: 200 },
        { type: 'text', text: 'user@example.com' },
        { type: 'key', key: 'Enter' },
      ],
    });
    expect(result).toEqual({ ok: true, editable: true });
    expect(wc.inputEvents.map((e) => e.type)).toEqual([
      'mouseMove',
      'mouseDown',
      'mouseUp',
      'keyDown',
      'char',
      'keyUp',
    ]);
    expect(wc.inputEvents[1]).toMatchObject({ x: 100, y: 200, button: 'left', clickCount: 1 });
    expect(wc.insertedText).toEqual(['user@example.com']);
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('navigate supports url, back/forward, and reload', async () => {
  const { created, restore } = installFakeElectron();
  try {
    const streams = createBrowserTabStreams({ store: makeStore(), emit: () => {} });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    const wc = created[0].webContents;

    await streams.methods.browserStreamNavigate({ taskId: 't1', tabId: 'br-1', url: 'claude.ai' });
    expect(wc.url).toBe('https://claude.ai');
    await streams.methods.browserStreamNavigate({ taskId: 't1', tabId: 'br-1', action: 'back' });
    expect(wc.navigationHistory.goBack).toHaveBeenCalled();
    await streams.methods.browserStreamNavigate({ taskId: 't1', tabId: 'br-1', action: 'reload' });
    expect(wc.reloaded).toBe(true);
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('window.open inside the page navigates in-pane instead of opening a window', async () => {
  const { created, restore } = installFakeElectron();
  try {
    const streams = createBrowserTabStreams({ store: makeStore(), emit: () => {} });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    const wc = created[0].webContents;
    const decision = wc.windowOpenHandler({ url: 'https://accounts.google.com/signin' });
    expect(decision).toEqual({ action: 'deny' });
    expect(wc.url).toBe('https://accounts.google.com/signin');
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('host survives briefly after the last viewer leaves, then is destroyed', async () => {
  vi.useFakeTimers();
  const { created, restore } = installFakeElectron();
  try {
    const streams = createBrowserTabStreams({ store: makeStore(), emit: () => {} });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' }); // 2nd viewer
    streams.methods.browserStreamClose({ taskId: 't1', tabId: 'br-1' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created[0].destroyed).toBe(false); // one viewer still attached

    streams.methods.browserStreamClose({ taskId: 't1', tabId: 'br-1' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(created[0].destroyed).toBe(false); // grace period
    await vi.advanceTimersByTimeAsync(30_000);
    expect(created[0].destroyed).toBe(true);

    // Re-subscribing after destruction builds a fresh host.
    await streams.methods.browserStreamOpen({ taskId: 't1', tabId: 'br-1' });
    expect(created).toHaveLength(2);
    streams.disposeAll();
  } finally {
    restore();
  }
});

test('input and navigate on a non-streaming tab throw instead of spawning hosts', async () => {
  const { restore } = installFakeElectron();
  try {
    const streams = createBrowserTabStreams({ store: makeStore(), emit: () => {} });
    await expect(
      streams.methods.browserStreamInput({ taskId: 't1', tabId: 'br-x', events: [] })
    ).rejects.toThrow(/not streaming/);
    await expect(
      streams.methods.browserStreamNavigate({ taskId: 't1', tabId: 'br-x', url: 'x.com' })
    ).rejects.toThrow(/not streaming/);
  } finally {
    restore();
  }
});

test('clampViewport bounds dimensions and DPR', () => {
  expect(clampViewport({ width: 5000, height: 10, dpr: 9 })).toEqual({
    width: 900,
    height: 120,
    dpr: 2,
  });
  expect(clampViewport({})).toEqual({ width: 390, height: 700, dpr: 2 });
});

test('toInputEvents maps wheel and rejects unknown types', () => {
  expect(toInputEvents({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: -120 })).toEqual([
    { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: -120, canScroll: true },
  ]);
  expect(toInputEvents({ type: 'mystery' })).toEqual([]);
});
