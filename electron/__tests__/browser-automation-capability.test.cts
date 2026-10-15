import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';

const { getCatalog } = require('../mcp-core.cts');
const {
  createBrowserController,
  normalizeBrowserUrl,
  parseBrowserRef,
  keyEvent,
} = require('../browser-control.cts');

function catalogEntry(key) {
  return getCatalog().find((entry) => entry.key === key);
}

test('Playwright MCP is an explicit browser automation capability with no credentials', () => {
  const playwright = catalogEntry('playwright');

  expect(playwright).toBeTruthy();
  expect(playwright.capability).toBe('browser-automation');
  expect(playwright.enabledByDefault).toBe(false);
  expect(playwright.defaultConfig).toEqual({
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  });
  expect(playwright.defaultConfig.env).toBeUndefined();
  expect(playwright.defaultConfig.headers).toBeUndefined();
  expect(playwright.credentialKeys).toEqual([]);
});

test('Ace browser MCP is explicit opt-in and has no credentials', () => {
  const aceBrowser = catalogEntry('ace_browser');

  expect(aceBrowser).toBeTruthy();
  expect(aceBrowser.capability).toBe('browser-automation');
  expect(aceBrowser.enabledByDefault).toBe(false);
  expect(aceBrowser.defaultConfig).toEqual({
    command: 'ace',
    args: ['mcp-browser'],
  });
  expect(aceBrowser.defaultConfig.env).toBeUndefined();
  expect(aceBrowser.defaultConfig.headers).toBeUndefined();
  expect(aceBrowser.credentialKeys).toEqual([]);
});

test('Ace core MCP is default control-plane capability for orchestrators only', () => {
  const aceCore = catalogEntry('ace_core');

  expect(aceCore).toBeTruthy();
  expect(aceCore.capability).toBe('ace-control-plane');
  expect(aceCore.enabledByDefault).toBe(true);
  expect(aceCore.enabledFor).toBe('orchestrators');
  expect(aceCore.defaultConfig).toEqual({
    command: 'ace',
    args: ['mcp-core'],
  });
  expect(aceCore.credentialKeys).toEqual([]);
});

test('browser controller normalizes URLs without profile or credential state', () => {
  expect(normalizeBrowserUrl('example.com')).toBe('https://example.com');
  expect(normalizeBrowserUrl('https://example.com/a')).toBe('https://example.com/a');
  expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
  expect(normalizeBrowserUrl('search terms')).toBe(
    'https://www.google.com/search?q=search%20terms'
  );
});

test('browser-ref parser keeps quoted fields and task scope intact', () => {
  const parsed = parseBrowserRef(
    '[browser-ref task=tsk_1 tab=br-1 tag=button text="Save changes" css="main button:nth-child(2)" at=50%,20%]'
  );

  expect(parsed).toEqual({
    task: 'tsk_1',
    tab: 'br-1',
    tag: 'button',
    text: 'Save changes',
    css: 'main button:nth-child(2)',
    at: '50%,20%',
  });
  expect(() => parseBrowserRef('not a ref')).toThrow(/invalid browser-ref/);
});

test('browser key events preserve modifiers for shortcuts', () => {
  expect(keyEvent('Meta+A')).toMatchObject({
    key: 'A',
    code: 'KeyA',
    modifiers: 4,
  });
  expect(keyEvent('Enter')).toMatchObject({
    key: 'Enter',
    code: 'Enter',
  });
});

test('browser open creates an attached fallback window when the UI pane is not rendered', async () => {
  const tabs = [];
  const allWindows = [];
  let nextWebContentsId = 1;
  const webContentsById = new Map();

  class FakeWebContents extends EventEmitter {
    id = nextWebContentsId++;
    url = '';
    title = 'New tab';
    loading = false;
    debugger = {
      isAttached: () => false,
      attach: () => {},
      sendCommand: async () => ({}),
      on: () => {},
      off: () => {},
    };
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
    };

    constructor() {
      super();
      webContentsById.set(this.id, this);
    }

    isDestroyed() {
      return false;
    }

    async loadURL(url) {
      this.url = url;
      this.title = url.startsWith('data:') ? 'Ace browser smoke' : url;
      this.loading = false;
      this.emit('did-stop-loading');
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
  }

  class FakeBrowserWindow extends EventEmitter {
    webContents = new FakeWebContents();

    constructor() {
      super();
      allWindows.push(this);
    }

    static getFocusedWindow() {
      return allWindows[0] || {};
    }

    static getAllWindows() {
      return allWindows;
    }
  }

  const previousElectron = require.cache[require.resolve('electron')];
  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: {
      BrowserWindow: FakeBrowserWindow,
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      webContents: { fromId: (id) => webContentsById.get(id) || null },
    },
  };

  try {
    const controller = createBrowserController({
      attachFallbackDelayMs: 0,
      userDataPath: '/tmp/ace-browser-test',
      emit: () => {},
      store: {
        listScratchTabs: () => ({ tabs, activeId: null }),
        saveScratchTabs: ({ tabs: nextTabs }) => {
          tabs.splice(0, tabs.length, ...nextTabs);
          return { ok: true };
        },
      },
    });

    const opened = await controller.methods.browserOpen({
      taskId: 'tsk-browser',
      url: 'data:text/html,<button>Run</button>',
    });

    expect(opened).toMatchObject({ id: expect.stringMatching(/^br-/), attached: true });
    const listed = controller.methods.browserList({ taskId: 'tsk-browser' });
    expect(listed.tabs[0]).toMatchObject({ attached: true, title: 'Ace browser smoke' });
  } finally {
    if (previousElectron) require.cache[require.resolve('electron')] = previousElectron;
    else delete require.cache[require.resolve('electron')];
  }
});
