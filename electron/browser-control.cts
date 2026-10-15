const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_HOME = 'https://www.google.com';
const DEFAULT_WAIT_MS = 10000;
const UI_ATTACH_GRACE_MS = 1500;
const CURSOR_DEFAULT = { id: 'codex', name: 'Codex', color: '#0095A1' };
const CURSOR_SPEED_MULTIPLIER = 1.45;
const CURSOR_BASE_DURATION_MS = 1280;
const CURSOR_FIRST_ACTION_DELAY_MS = 950;
const CURSOR_CLICK_HOLD_MS = 120;
const CURSOR_SCROLL_DWELL_MS = 350;
const CURSOR_TYPE_PREP_MS = 520;
const CURSOR_KEY_PREP_MS = 420;
const CONTROL_METHODS = new Set([
  'browserOpen',
  'browserActivate',
  'browserNavigate',
  'browserScreenshot',
  'browserClick',
  'browserType',
  'browserKey',
  'browserScroll',
  'browserEval',
  'browserCdp',
  'browserWaitFor',
  'browserElements',
  'browserConsole',
  'browserInspectRef',
  'browserClickRef',
  'browserTypeRef',
]);
const DIAGNOSTIC_LIMIT = 200;
const ACTION_DIAGNOSTIC_DELAY_MS = 200;

function normalizeBrowserUrl(raw: any) {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_HOME;
  if (/^(https?:|file:|about:|data:)/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function parseBrowserRef(ref: string) {
  const text = String(ref || '').trim();
  const m = /^\[browser-ref\s+([\s\S]+)\]$/.exec(text);
  if (!m) throw new Error('invalid browser-ref');
  const body = m[1];
  const out: Record<string, string> = {};
  const rx = /([a-zA-Z0-9_-]+)=("(?:\\.|[^"])*"|[^\s\]]+)/g;
  let match;
  while ((match = rx.exec(body))) {
    const raw = match[2];
    if (raw.startsWith('"')) {
      try {
        out[match[1]] = JSON.parse(raw);
      } catch {
        out[match[1]] = raw.slice(1, -1);
      }
    } else {
      out[match[1]] = raw;
    }
  }
  return out;
}

function createBrowserController({ store, userDataPath, emit, attachFallbackDelayMs = UI_ATTACH_GRACE_MS }: any) {
  if (!store) throw new Error('browser-control: store required');
  const { BrowserWindow, dialog, webContents } = require('electron');
  const live = new Map<string, any>();
  const permissions = new Map<string, 'allow' | 'deny'>();
  const diagnostics = new Map<string, any[]>();
  const cursorPositions = new Map<string, { x: number; y: number }>();
  const skillsRoot = path.join(userDataPath, 'browser-skills');
  let diagnosticSeq = 0;

  function key(taskId: string, tabId: string) {
    return `${taskId}:${tabId}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function uid(prefix: string) {
    return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
  }

  function normalizeUrl(raw: any) {
    return normalizeBrowserUrl(raw);
  }

  function browserTabs(taskId: string) {
    const result = store.listScratchTabs({ taskId }) || { tabs: [], activeId: null };
    const tabs = Array.isArray(result.tabs) ? result.tabs : [];
    return {
      tabs: tabs.filter((t: any) => t && t.kind === 'browser'),
      allTabs: tabs,
      activeId: result.activeId || null,
    };
  }

  function saveTabs(taskId: string, allTabs: any[], activeId: string | null) {
    return store.saveScratchTabs({ taskId, tabs: allTabs, activeId });
  }

  function findSaved(taskId: string, tabId: string) {
    const state = browserTabs(taskId);
    const tab = state.tabs.find((t: any) => t.id === tabId) || null;
    return { ...state, tab };
  }

  function assertTask(taskId: any) {
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('browser command requires --task or ACE_TASK_ID');
    }
    return taskId;
  }

  function assertOwned(taskId: any, tabId: any) {
    const resolvedTaskId = assertTask(taskId);
    if (!tabId || typeof tabId !== 'string') throw new Error('browser tab id required');
    const state = findSaved(resolvedTaskId, tabId);
    const liveEntry = live.get(key(resolvedTaskId, tabId)) || null;
    if (!state.tab && !liveEntry) {
      throw new Error(`browser tab ${tabId} is not in task ${resolvedTaskId}`);
    }
    return { taskId: resolvedTaskId, tabId, tab: state.tab, liveEntry, state };
  }

  function getLive(taskId: string, tabId: string) {
    const owned = assertOwned(taskId, tabId);
    const entry = owned.liveEntry;
    if (!entry || !entry.webContents || entry.webContents.isDestroyed()) {
      throw new Error(
        `browser tab ${tabId} is not attached; activate it first\nnext: ace browser activate ${tabId} --task ${taskId}`
      );
    }
    return { ...owned, entry, wc: entry.webContents };
  }

  function updateLiveFromWc(entry: any) {
    const wc = entry.webContents;
    if (!wc || wc.isDestroyed()) return entry;
    const navigationHistory = wc.navigationHistory;
    entry.lastUrl = wc.getURL() || entry.lastUrl || '';
    entry.lastTitle = wc.getTitle() || entry.lastTitle || 'Untitled';
    entry.loading = wc.isLoading();
    entry.canGoBack = navigationHistory?.canGoBack?.() ?? false;
    entry.canGoForward = navigationHistory?.canGoForward?.() ?? false;
    return entry;
  }

  function attachCleanup(entry: any) {
    const wc = entry.webContents;
    const remove = () => {
      cleanupEntry(entry);
      const current = live.get(key(entry.taskId, entry.tabId));
      if (current && current.webContentsId === entry.webContentsId) {
        live.delete(key(entry.taskId, entry.tabId));
        emit?.('browser-control-status', {
          taskId: entry.taskId,
          tabId: entry.tabId,
          active: false,
          detached: true,
        });
      }
    };
    wc.once('destroyed', remove);
    wc.once('render-process-gone', remove);
    if (entry.window && typeof entry.window.once === 'function') {
      entry.window.once('closed', remove);
    }
  }

  function cleanupEntry(entry: any) {
    if (!entry || !Array.isArray(entry.cleanup)) return;
    while (entry.cleanup.length) {
      try {
        entry.cleanup.pop()();
      } catch {}
    }
  }

  function normalizeLevel(level: any) {
    if (typeof level === 'number') {
      if (level >= 3) return 'error';
      if (level === 2) return 'warning';
      if (level === 1) return 'info';
      return 'debug';
    }
    const raw = String(level || '').toLowerCase();
    if (raw === 'warn') return 'warning';
    if (raw === 'warning' || raw === 'error' || raw === 'info' || raw === 'debug') return raw;
    if (raw === 'log') return 'info';
    return 'info';
  }

  function diagnosticKey(taskId: string, tabId: string) {
    return key(taskId, tabId);
  }

  function recordDiagnostic(taskId: string, tabId: string, input: any) {
    const k = diagnosticKey(taskId, tabId);
    const entry = live.get(k);
    const item = {
      seq: ++diagnosticSeq,
      ts: nowIso(),
      taskId,
      tabId,
      level: normalizeLevel(input.level),
      source: String(input.source || 'browser'),
      text: String(input.text || '').slice(0, 2000),
      url: input.url || entry?.lastUrl || null,
      line: typeof input.line === 'number' ? input.line : null,
      column: typeof input.column === 'number' ? input.column : null,
    };
    const list = diagnostics.get(k) || [];
    list.push(item);
    if (list.length > DIAGNOSTIC_LIMIT) list.splice(0, list.length - DIAGNOSTIC_LIMIT);
    diagnostics.set(k, list);
    return item;
  }

  function diagnosticSnapshot(taskId: string, tabId: string, options: any = {}) {
    const level = String(options.level || 'all').toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const sinceSeq = Number(options.sinceSeq || 0);
    let events = (diagnostics.get(diagnosticKey(taskId, tabId)) || []).filter(
      (event) => event.seq > sinceSeq
    );
    if (level === 'error' || level === 'errors') {
      events = events.filter((event) => event.level === 'error');
    } else if (level === 'warning' || level === 'warn' || level === 'warnings') {
      events = events.filter((event) => event.level === 'warning');
    } else if (level === 'problem' || level === 'problems') {
      events = events.filter((event) => event.level === 'error' || event.level === 'warning');
    }
    return {
      lastSeq: diagnosticSeq,
      events: events.slice(-limit),
    };
  }

  function diagnosticSummary(taskId: string, tabId: string, sinceSeq: number) {
    const events = diagnosticSnapshot(taskId, tabId, {
      sinceSeq,
      level: 'problems',
      limit: 5,
    }).events;
    const newErrors = events.filter((event: any) => event.level === 'error').length;
    const newWarnings = events.filter((event: any) => event.level === 'warning').length;
    if (!newErrors && !newWarnings) return null;
    return {
      newErrors,
      newWarnings,
      events,
      hint: `ace browser console ${tabId} --task ${taskId} --level problems`,
    };
  }

  function attachDiagnosticSummary(result: any, summary: any) {
    if (!summary) return result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...result, console: summary };
    }
    return { value: result, console: summary };
  }

  function cdpValueText(arg: any) {
    if (!arg) return '';
    if (arg.value != null) return String(arg.value);
    if (arg.description) return String(arg.description);
    if (arg.preview?.description) return String(arg.preview.description);
    return '';
  }

  function exceptionText(details: any) {
    if (!details) return 'Uncaught exception';
    const exception = details.exception;
    return (
      exception?.description ||
      exception?.value ||
      details.text ||
      'Uncaught exception'
    );
  }

  async function enableDiagnostics(entry: any) {
    if (!entry || entry.diagnosticsAttached) return;
    entry.diagnosticsAttached = true;
    entry.cleanup = entry.cleanup || [];
    const wc = entry.webContents;
    const onConsole = (details: any) => {
      recordDiagnostic(entry.taskId, entry.tabId, {
        level: details?.level,
        source: 'console',
        text: details?.message,
        url: details?.sourceId || null,
        line: typeof details?.lineNumber === 'number' ? details.lineNumber : null,
      });
    };
    wc.on('console-message', onConsole);
    entry.cleanup.push(() => wc.off('console-message', onConsole));

    const onDebuggerMessage = (_event: any, method: string, params: any) => {
      if (method === 'Runtime.consoleAPICalled') {
        recordDiagnostic(entry.taskId, entry.tabId, {
          level: params?.type,
          source: 'runtime',
          text: (params?.args || []).map(cdpValueText).filter(Boolean).join(' '),
          url: params?.stackTrace?.callFrames?.[0]?.url || null,
          line: params?.stackTrace?.callFrames?.[0]?.lineNumber,
          column: params?.stackTrace?.callFrames?.[0]?.columnNumber,
        });
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params?.exceptionDetails || {};
        recordDiagnostic(entry.taskId, entry.tabId, {
          level: 'error',
          source: 'exception',
          text: exceptionText(details),
          url: details.url || null,
          line: details.lineNumber,
          column: details.columnNumber,
        });
      } else if (method === 'Log.entryAdded') {
        const log = params?.entry || {};
        recordDiagnostic(entry.taskId, entry.tabId, {
          level: log.level,
          source: log.source || 'log',
          text: log.text,
          url: log.url || null,
          line: log.lineNumber,
        });
      } else if (method === 'Network.loadingFailed' && !params?.canceled) {
        recordDiagnostic(entry.taskId, entry.tabId, {
          level: 'error',
          source: 'network',
          text: `${params?.type || 'resource'} failed: ${params?.errorText || 'unknown error'}`,
        });
      }
    };
    wc.debugger.on('message', onDebuggerMessage);
    entry.cleanup.push(() => wc.debugger.off('message', onDebuggerMessage));

    try {
      await cdp(wc, 'Runtime.enable', {}, undefined, entry);
      await cdp(wc, 'Log.enable', {}, undefined, entry);
      await cdp(wc, 'Network.enable', {}, undefined, entry);
    } catch (err) {
      recordDiagnostic(entry.taskId, entry.tabId, {
        level: 'warning',
        source: 'ace',
        text: `browser diagnostics unavailable: ${err?.message || err}`,
      });
    }
  }

  async function ensurePermission(taskId: string, action: string) {
    if (!CONTROL_METHODS.has(action)) return;
    const existing = permissions.get(taskId);
    if (existing === 'allow') return;
    if (existing === 'deny') throw new Error(`browser control denied for task ${taskId}`);
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    if (!win) throw new Error('browser control requires Ace desktop to grant permission');
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Allow for this task', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      title: 'Allow browser control?',
      message: 'Allow this agent to control browser tabs in this task?',
      detail:
        'Actions include navigation, clicking, typing, screenshots, page inspection, JavaScript, and raw CDP commands.',
    });
    if (result.response === 0) {
      permissions.set(taskId, 'allow');
      return;
    }
    permissions.set(taskId, 'deny');
    throw new Error(`browser control denied for task ${taskId}`);
  }

  async function withControl(taskId: string, tabId: string, action: string, fn: any) {
    await ensurePermission(taskId, action);
    const startSeq = diagnosticSeq;
    emit?.('browser-control-status', { taskId, tabId, active: true, action, at: nowIso() });
    try {
      const result = await fn();
      await sleep(ACTION_DIAGNOSTIC_DELAY_MS);
      return attachDiagnosticSummary(result, diagnosticSummary(taskId, tabId, startSeq));
    } finally {
      emit?.('browser-control-status', { taskId, tabId, active: false, action, at: nowIso() });
    }
  }

  function emitCursor(taskId: string, tabId: string, action: string, cursor: any) {
    emit?.('browser-control-status', {
      taskId,
      tabId,
      active: true,
      action,
      at: nowIso(),
      cursor: {
        ...CURSOR_DEFAULT,
        ...cursor,
      },
    });
  }

  function cursorTransitDuration(distance: number) {
    const base = CURSOR_BASE_DURATION_MS / CURSOR_SPEED_MULTIPLIER;
    const factor = Math.max(0.55, Math.min(1.8, distance / 520));
    return Math.max(420, base * factor);
  }

  function cursorApproachDelay(taskId: string, tabId: string, point: { x: number; y: number }) {
    const k = key(taskId, tabId);
    const previous = cursorPositions.get(k);
    cursorPositions.set(k, point);
    if (!previous) return CURSOR_FIRST_ACTION_DELAY_MS;
    return cursorTransitDuration(Math.hypot(point.x - previous.x, point.y - previous.y));
  }

  async function focusedPoint(wc: any) {
    const point = await wc.executeJavaScript(
      `(() => {
        const el = document.activeElement;
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r && Number.isFinite(r.left) && Number.isFinite(r.top) && r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + Math.min(r.width - 4, Math.max(4, r.width / 2))), y: Math.round(r.top + Math.min(r.height - 4, Math.max(4, r.height / 2))) };
        }
        return null;
      })()`,
      false
    ).catch(() => null);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
    const size = await viewport(wc).catch(() => ({ width: 1000, height: 800 }));
    return {
      x: Math.round((size.width || 1000) / 2),
      y: Math.round((size.height || 800) / 2),
    };
  }

  function tabRow(taskId: string, tab: any, activeId: string | null) {
    const entry = live.get(key(taskId, tab.id));
    if (entry) updateLiveFromWc(entry);
    return {
      id: tab.id,
      taskId,
      title: entry?.lastTitle || tab.title || 'New tab',
      url: entry?.lastUrl || tab.url || '',
      favicon: tab.favicon || null,
      active: tab.id === activeId,
      attached: !!entry && !entry.webContents.isDestroyed(),
      loading: !!entry?.loading,
      canGoBack: !!entry?.canGoBack,
      canGoForward: !!entry?.canGoForward,
    };
  }

  function requestUi(payload: any) {
    emit?.('browser-ui-request', { ...payload, at: nowIso() });
  }

  async function cdp(wc: any, method: string, params: any = {}, sessionId?: string, entry?: any) {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (entry) entry.debuggerAttached = true;
    return wc.debugger.sendCommand(method, params || {}, sessionId);
  }

  async function waitForLoad(wc: any, timeoutMs = DEFAULT_WAIT_MS, alreadyLoadedOk = true) {
    if (alreadyLoadedOk && !wc.isLoading()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for page load after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        clearTimeout(timer);
        wc.off('did-stop-loading', done);
        wc.off('did-fail-load', done);
      };
      wc.once('did-stop-loading', done);
      wc.once('did-fail-load', done);
    });
  }

  async function waitForDomReady(wc: any, timeoutMs = DEFAULT_WAIT_MS) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for DOMContentLoaded after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        clearTimeout(timer);
        wc.off('dom-ready', done);
      };
      wc.once('dom-ready', done);
    });
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForLive(taskId: string, tabId: string, timeoutMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const entry = live.get(key(taskId, tabId));
      if (entry && entry.webContents && !entry.webContents.isDestroyed()) return entry;
      if (timeoutMs <= 0) break;
      await sleep(50);
    }
    return null;
  }

  async function ensureLiveBrowserWindow(taskId: string, tabId: string, url: string) {
    const existing = live.get(key(taskId, tabId));
    if (existing && existing.webContents && !existing.webContents.isDestroyed()) return existing;
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title: 'Ace Browser',
      show: true,
      webPreferences: {
        partition: 'persist:ace-browser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = win.webContents;
    const entry = updateLiveFromWc({
      taskId,
      tabId,
      webContentsId: wc.id,
      webContents: wc,
      window: win,
      attachedAt: nowIso(),
      lastUrl: url || DEFAULT_HOME,
    });
    live.set(key(taskId, tabId), entry);
    attachCleanup(entry);
    void enableDiagnostics(entry);
    if (url) {
      try {
        await wc.loadURL(url);
      } catch (err) {
        recordDiagnostic(taskId, tabId, {
          level: 'error',
          source: 'ace',
          text: `browser window failed to load ${url}: ${err?.message || err}`,
        });
      }
    }
    updateLiveFromWc(entry);
    return entry;
  }

  function jsonSafe(value: any) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  async function viewport(wc: any) {
    const result = await wc.executeJavaScript(
      `({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 })`,
      false
    );
    return result || { width: 0, height: 0, deviceScaleFactor: 1 };
  }

  function parseRef(ref: string) {
    return parseBrowserRef(ref);
  }

  function jsString(value: any) {
    return JSON.stringify(String(value ?? ''));
  }

  function inspectRefScript(parsed: any) {
    return `
(() => {
  const parsed = ${JSON.stringify(parsed)};
  const esc = (s) => {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\\w-]/g, '\\\\$&');
  };
  const wantedText = parsed.text || '';
  const wantedHref = parsed.href || '';
  const wantedTag = (parsed.tag || '').toLowerCase();
  const wantedIn = (parsed.in || '').toLowerCase();
  const wantedAt = parsed.at || '';
  const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const rectFor = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const landmarkFor = (el) => {
    const strong = new Set(['HEADER','MAIN','FOOTER','NAV','ASIDE','FORM','DIALOG','SECTION','ARTICLE']);
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const role = node.getAttribute('role');
      if (role) return role.toLowerCase();
      if (strong.has(node.tagName)) return node.tagName.toLowerCase();
      node = node.parentElement;
    }
    return null;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const serialize = (el, score = 0) => {
    const link = el.closest('a[href]');
    const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
    return {
      score,
      tag: el.tagName.toLowerCase(),
      text,
      href: el.getAttribute('href') || (link ? link.href : null),
      selector: el.id ? '#' + esc(el.id) : null,
      rect: rectFor(el),
      visible: visible(el),
      landmark: landmarkFor(el),
    };
  };
  const matches = (el) => {
    let score = 0;
    const tag = el.tagName.toLowerCase();
    const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
    const href = el.getAttribute('href') || (el.closest('a[href]') ? el.closest('a[href]').href : '');
    const landmark = landmarkFor(el) || '';
    if (wantedTag && tag === wantedTag) score += 2;
    if (wantedText && text === wantedText) score += 6;
    else if (wantedText && text.includes(wantedText)) score += 3;
    if (wantedHref && href && String(href).includes(wantedHref)) score += 5;
    if (wantedIn && landmark === wantedIn) score += 2;
    if (wantedAt) {
      const [px, py] = wantedAt.split(',').map((part) => Number(part.replace('%','')));
      const r = el.getBoundingClientRect();
      const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth, 1);
      const docH = Math.max(document.documentElement.scrollHeight, 1);
      const ex = ((r.left + window.scrollX + r.width / 2) / docW) * 100;
      const ey = ((r.top + window.scrollY + r.height / 2) / docH) * 100;
      const dist = Math.abs(ex - px) + Math.abs(ey - py);
      if (Number.isFinite(dist)) score += Math.max(0, 4 - dist / 8);
    }
    return score;
  };
  let primary = null;
  if (parsed.css) {
    try { primary = document.querySelector(parsed.css); } catch {}
  }
  if (primary) {
    primary.scrollIntoView({ block: 'center', inline: 'center' });
    const item = serialize(primary, matches(primary));
    const textMismatch = wantedText && !item.text.includes(wantedText);
    const hrefMismatch = wantedHref && (!item.href || !String(item.href).includes(wantedHref));
    const landmarkMismatch = wantedIn && item.landmark !== wantedIn;
    if (!textMismatch && !hrefMismatch && !landmarkMismatch) {
      return { found: true, element: { ...item, score: 100 }, candidates: [] };
    }
  }
  const selector = wantedTag || 'a,button,input,textarea,select,[role],[aria-label],[tabindex]';
  const all = Array.from(document.querySelectorAll(selector));
  const candidates = all
    .map((el) => serialize(el, matches(el)))
    .filter((item) => item.score > 0 && item.visible)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  return { found: candidates.length === 1, element: candidates.length === 1 ? candidates[0] : null, candidates };
})()
`;
  }

  function elementsScript({ visibleOnly = true, limit = 80 }: any) {
    return `
(() => {
  const limit = ${Math.max(1, Math.min(200, Number(limit) || 80))};
  const visibleOnly = ${visibleOnly ? 'true' : 'false'};
  const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const esc = (s) => {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\\w-]/g, '\\\\$&');
  };
  const selectorFor = (el) => {
    if (el.id) return '#' + esc(el.id);
    for (const attr of ['data-testid','data-test','data-cy','name','aria-label','title']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const sel = el.tagName.toLowerCase() + '[' + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
    }
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) part += ':nth-child(' + (Array.from(parent.children).indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight && r.left <= window.innerWidth && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const roleFor = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading' }[el.tagName]) || null;
  const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[aria-label],[tabindex],h1,h2,h3,h4,h5,h6'));
  const out = [];
  for (const el of nodes) {
    if (visibleOnly && !isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const link = el.closest('a[href]');
    out.push({
      index: out.length + 1,
      tag: el.tagName.toLowerCase(),
      role: roleFor(el),
      text: normalize(el.innerText || el.textContent || el.value || '').slice(0, 160),
      ariaLabel: el.getAttribute('aria-label'),
      href: el.getAttribute('href') || (link ? link.href : null),
      selector: selectorFor(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    });
    if (out.length >= limit) break;
  }
  return out;
})()
`;
  }

  function sanitizeHost(host: any) {
    const raw = String(host || '').trim().toLowerCase();
    if (!raw) throw new Error('host required');
    let parsed = raw;
    try {
      parsed = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {}
    if (!/^[a-z0-9.-]+$/.test(parsed)) throw new Error(`invalid host: ${host}`);
    return parsed;
  }

  function skillDir(host: any) {
    return path.join(skillsRoot, sanitizeHost(host));
  }

  function safeSkillFiles(host: any) {
    const dir = skillDir(host);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry: any) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry: any) => path.join(dir, entry.name));
  }

  const methods = {
    browserRegisterWebview({ taskId, tabId, webContentsId }: any) {
      assertTask(taskId);
      if (!tabId || typeof tabId !== 'string') return { ok: false, error: 'tabId required' };
      const wc = webContents.fromId(Number(webContentsId));
      if (!wc || wc.isDestroyed()) return { ok: false, error: `webContents ${webContentsId} not found` };
      const existing = live.get(key(taskId, tabId));
      if (existing && existing.webContentsId !== Number(webContentsId)) cleanupEntry(existing);
      const entry = updateLiveFromWc({
        taskId,
        tabId,
        webContentsId: Number(webContentsId),
        webContents: wc,
        attachedAt: nowIso(),
      });
      live.set(key(taskId, tabId), entry);
      attachCleanup(entry);
      void enableDiagnostics(entry);
      return { ok: true, taskId, tabId, webContentsId: entry.webContentsId };
    },

    browserUnregisterWebview({ taskId, tabId, webContentsId }: any) {
      if (!taskId || !tabId) return { ok: true };
      const k = key(String(taskId), String(tabId));
      const entry = live.get(k);
      if (!entry || webContentsId == null || Number(webContentsId) === entry.webContentsId) {
        cleanupEntry(entry);
        live.delete(k);
      }
      return { ok: true };
    },

    browserStop({ taskId, tabId }: any) {
      const { wc } = getLive(taskId, tabId);
      try { wc.stop(); } catch {}
      emit?.('browser-control-status', { taskId, tabId, active: false, stopped: true, at: nowIso() });
      return { ok: true };
    },

    browserList({ taskId }: any) {
      assertTask(taskId);
      const state = browserTabs(taskId);
      return { tabs: state.tabs.map((tab: any) => tabRow(taskId, tab, state.activeId)) };
    },

    async browserOpen({ taskId, url, activate = true }: any) {
      assertTask(taskId);
      await ensurePermission(taskId, 'browserOpen');
      const state = browserTabs(taskId);
      const id = uid('br');
      const target = normalizeUrl(url || '');
      const tab = { id, kind: 'browser', title: 'New tab', url: target };
      const saved = saveTabs(taskId, [...state.allTabs, tab], activate === false ? state.activeId : id);
      if (!saved?.ok) throw new Error(`task not found: ${taskId}`);
      if (activate !== false) {
        requestUi({ type: 'open', taskId, tabId: id, url: target });
        const entry =
          (await waitForLive(taskId, id, attachFallbackDelayMs)) ||
          (await ensureLiveBrowserWindow(taskId, id, target));
        return { id, taskId, url: entry.lastUrl || target, active: true, attached: true };
      }
      return { id, taskId, url: target, active: false, attached: false };
    },

    async browserActivate({ taskId, tabId }: any) {
      const owned = assertOwned(taskId, tabId);
      await ensurePermission(owned.taskId, 'browserActivate');
      const saved = saveTabs(owned.taskId, owned.state.allTabs, tabId);
      if (!saved?.ok) throw new Error(`task not found: ${owned.taskId}`);
      requestUi({ type: 'activate', taskId: owned.taskId, tabId });
      const entry =
        owned.liveEntry ||
        (await waitForLive(owned.taskId, tabId, attachFallbackDelayMs)) ||
        (await ensureLiveBrowserWindow(owned.taskId, tabId, owned.tab?.url || DEFAULT_HOME));
      return { ok: true, id: tabId, attached: !!entry };
    },

    async browserNavigate({ taskId, tabId, url, waitUntil = 'load', timeoutMs = DEFAULT_WAIT_MS }: any) {
      const target = normalizeUrl(url);
      const owned = assertOwned(taskId, tabId);
      const tabs = owned.state.allTabs.map((t: any) =>
        t.id === tabId ? { ...t, url: target, title: t.title || target } : t
      );
      const saved = saveTabs(owned.taskId, tabs, tabId);
      if (!saved?.ok) throw new Error(`task not found: ${owned.taskId}`);
      requestUi({ type: 'navigate', taskId: owned.taskId, tabId, url: target });
      if (!owned.liveEntry) {
        const attached =
          (await waitForLive(owned.taskId, tabId, attachFallbackDelayMs)) ||
          (await ensureLiveBrowserWindow(owned.taskId, tabId, target));
        updateLiveFromWc(attached);
        return {
          ok: true,
          id: tabId,
          url: attached.lastUrl || target,
          title: attached.lastTitle || '',
          loading: attached.loading,
          attached: true,
        };
      }
      return withControl(owned.taskId, tabId, 'browserNavigate', async () => {
        const { wc, entry } = getLive(owned.taskId, tabId);
        const waitPromise =
          waitUntil === 'domcontentloaded'
            ? waitForDomReady(wc, timeoutMs)
            : waitUntil === 'none'
              ? Promise.resolve(null)
              : waitForLoad(wc, timeoutMs, false);
        await wc.loadURL(target);
        await waitPromise;
        updateLiveFromWc(entry);
        return { ok: true, id: tabId, url: entry.lastUrl, title: entry.lastTitle, loading: entry.loading, attached: true };
      });
    },

    async browserInfo({ taskId, tabId }: any) {
      const owned = assertOwned(taskId, tabId);
      if (!owned.liveEntry) {
        return {
          id: tabId,
          taskId: owned.taskId,
          attached: false,
          title: owned.tab?.title || 'New tab',
          url: owned.tab?.url || '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        };
      }
      updateLiveFromWc(owned.liveEntry);
      const bounds = await viewport(owned.liveEntry.webContents).catch(() => null);
      return {
        id: tabId,
        taskId: owned.taskId,
        attached: true,
        title: owned.liveEntry.lastTitle,
        url: owned.liveEntry.lastUrl,
        loading: owned.liveEntry.loading,
        canGoBack: owned.liveEntry.canGoBack,
        canGoForward: owned.liveEntry.canGoForward,
        bounds,
      };
    },

    async browserScreenshot({ taskId, tabId, outPath, fullPage = false, annotate = false }: any) {
      const { wc, entry } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserScreenshot', async () => {
        let buffer;
        if (fullPage) {
          const result = await cdp(wc, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            fromSurface: true,
          });
          buffer = Buffer.from(result.data, 'base64');
        } else {
          const image = await wc.capturePage();
          buffer = image.toPNG();
        }
        const target =
          outPath ||
          path.join(os.tmpdir(), `ace-browser-${taskId}-${tabId}-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        const size = await viewport(wc).catch(() => ({ width: 0, height: 0 }));
        updateLiveFromWc(entry);
        const response: any = {
          path: target,
          width: Math.round(size.width || 0),
          height: Math.round(size.height || 0),
          url: entry.lastUrl,
          title: entry.lastTitle,
        };
        if (annotate) {
          const elements = await wc.executeJavaScript(elementsScript({ visibleOnly: true, limit: 80 }), false).catch(() => []);
          const annotationsPath = target.replace(/\.png$/i, '') + '.elements.json';
          fs.writeFileSync(annotationsPath, JSON.stringify({ elements }, null, 2));
          response.annotationsPath = annotationsPath;
          response.elements = elements;
        }
        return response;
      });
    },

    async browserClick({ taskId, tabId, x, y, button = 'left', clickCount = 1 }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserClick', async () => {
        if (x == null || y == null) throw new Error('browser click requires numeric x and y');
        const px = Number(x);
        const py = Number(y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('browser click requires numeric --x and --y');
        const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
        const target = { x: px, y: py };
        const approachDelay = cursorApproachDelay(taskId, tabId, target);
        emitCursor(taskId, tabId, 'browserClick', {
          kind: 'click',
          x: px,
          y: py,
          button: btn,
          clickCount: Number(clickCount) || 1,
        });
        await sleep(approachDelay);
        await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
        await sleep(CURSOR_CLICK_HOLD_MS);
        await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: btn, clickCount: Number(clickCount) || 1 });
        await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: btn, clickCount: Number(clickCount) || 1 });
        return { ok: true };
      });
    },

    async browserType({ taskId, tabId, text }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserType', async () => {
        const target = await focusedPoint(wc);
        emitCursor(taskId, tabId, 'browserType', {
          kind: 'type',
          x: target.x,
          y: target.y,
          text: String(text ?? ''),
        });
        await sleep(cursorApproachDelay(taskId, tabId, target) + CURSOR_TYPE_PREP_MS);
        await cdp(wc, 'Input.insertText', { text: String(text ?? '') });
        return { ok: true };
      });
    },

    async browserKey({ taskId, tabId, key: rawKey }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserKey', async () => {
        const key = String(rawKey || '');
        const event = keyEvent(key);
        const target = await focusedPoint(wc);
        emitCursor(taskId, tabId, 'browserKey', {
          kind: 'key',
          x: target.x,
          y: target.y,
          key,
        });
        await sleep(cursorApproachDelay(taskId, tabId, target) + CURSOR_KEY_PREP_MS);
        await cdp(wc, 'Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
        await cdp(wc, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
        return { ok: true };
      });
    },

    async browserScroll({ taskId, tabId, x, y, deltaX = 0, deltaY = 600 }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserScroll', async () => {
        const size = await viewport(wc).catch(() => ({ width: 1000, height: 800 }));
        const px = Number.isFinite(Number(x)) ? Number(x) : Math.round((size.width || 1000) / 2);
        const py = Number.isFinite(Number(y)) ? Number(y) : Math.round((size.height || 800) / 2);
        const target = { x: px, y: py };
        emitCursor(taskId, tabId, 'browserScroll', {
          kind: 'scroll',
          x: px,
          y: py,
          deltaX: Number(deltaX) || 0,
          deltaY: Number(deltaY) || 0,
        });
        await sleep(cursorApproachDelay(taskId, tabId, target));
        await cdp(wc, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: px,
          y: py,
          deltaX: Number(deltaX) || 0,
          deltaY: Number(deltaY) || 0,
        });
        await sleep(CURSOR_SCROLL_DWELL_MS);
        return { ok: true };
      });
    },

    async browserEval({ taskId, tabId, script }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserEval', async () => {
        const value = await wc.executeJavaScript(String(script || ''), true);
        return { value: jsonSafe(value) };
      });
    },

    async browserCdp({ taskId, tabId, method, params, sessionId }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserCdp', async () => {
        if (!method || typeof method !== 'string') throw new Error('CDP method required');
        const result = await cdp(wc, method, params || {}, sessionId);
        return { result: jsonSafe(result) };
      });
    },

    async browserWaitFor({ taskId, tabId, until, timeoutMs = DEFAULT_WAIT_MS }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserWaitFor', async () => {
        const start = Date.now();
        if (until?.kind === 'load') {
          await waitForLoad(wc, timeoutMs);
          return { ok: true, elapsedMs: Date.now() - start };
        }
        while (Date.now() - start < timeoutMs) {
          if (until?.kind === 'url') {
            const rx = new RegExp(String(until.pattern || ''));
            if (rx.test(wc.getURL() || '')) return { ok: true, elapsedMs: Date.now() - start };
          } else if (until?.kind === 'text') {
            const found = await wc.executeJavaScript(`document.body && document.body.innerText.includes(${jsString(until.text)})`, false).catch(() => false);
            if (found) return { ok: true, elapsedMs: Date.now() - start };
          } else if (until?.kind === 'selector') {
            const found = await wc.executeJavaScript(`!!document.querySelector(${jsString(until.selector)})`, false).catch(() => false);
            if (found) return { ok: true, elapsedMs: Date.now() - start };
          } else {
            throw new Error('browser wait requires load, url, text, or selector condition');
          }
          await sleep(200);
        }
        throw new Error(`timed out waiting for browser condition after ${timeoutMs}ms`);
      });
    },

    async browserElements({ taskId, tabId, visibleOnly = true, limit = 80 }: any) {
      const { wc } = getLive(taskId, tabId);
      return withControl(taskId, tabId, 'browserElements', async () => {
        const elements = await wc.executeJavaScript(elementsScript({ visibleOnly, limit }), false);
        return { elements: jsonSafe(elements) };
      });
    },

    async browserConsole({ taskId, tabId, level = 'all', limit = 50, sinceSeq = 0 }: any) {
      const owned = assertOwned(taskId, tabId);
      await ensurePermission(owned.taskId, 'browserConsole');
      const snapshot = diagnosticSnapshot(owned.taskId, tabId, { level, limit, sinceSeq });
      return {
        taskId: owned.taskId,
        tabId,
        level,
        ...snapshot,
      };
    },

    async browserInspectRef({ taskId, ref }: any) {
      const parsed = parseRef(ref);
      if (taskId && parsed.task && taskId !== parsed.task) {
        throw new Error(`browser-ref task ${parsed.task} does not match requested task ${taskId}`);
      }
      const resolvedTaskId = parsed.task || taskId;
      const tabId = parsed.tab;
      if (!tabId) throw new Error('browser-ref is missing tab=<browserTabId>');
      const { wc } = getLive(resolvedTaskId, tabId);
      return withControl(resolvedTaskId, tabId, 'browserInspectRef', async () => {
        const inspected = await wc.executeJavaScript(inspectRefScript(parsed), true);
        return {
          taskId: resolvedTaskId,
          tabId,
          found: !!inspected?.found,
          element: inspected?.element || null,
          candidates: inspected?.candidates || [],
        };
      });
    },

    async browserClickRef({ taskId, ref }: any) {
      const inspected = await methods.browserInspectRef({ taskId, ref });
      const candidates = inspected.candidates || [];
      const element = inspected.element || (candidates.length === 1 ? candidates[0] : null);
      if (!element) return { ok: false, found: false, candidates };
      if (candidates.length > 1 && !inspected.found) {
        return { ok: false, found: false, error: 'browser-ref is ambiguous', candidates };
      }
      const x = element.rect.x + element.rect.width / 2;
      const y = element.rect.y + element.rect.height / 2;
      const clickResult = await methods.browserClick({ taskId: inspected.taskId, tabId: inspected.tabId, x, y });
      const info = await methods.browserInfo({ taskId: inspected.taskId, tabId: inspected.tabId });
      return { ok: true, element, info, console: clickResult.console };
    },

    async browserTypeRef({ taskId, ref, text, clear = false }: any) {
      const inspected = await methods.browserInspectRef({ taskId, ref });
      const candidates = inspected.candidates || [];
      const element = inspected.element || (candidates.length === 1 ? candidates[0] : null);
      if (!element) return { ok: false, found: false, candidates };
      if (candidates.length > 1 && !inspected.found) {
        return { ok: false, found: false, error: 'browser-ref is ambiguous', candidates };
      }
      const x = element.rect.x + element.rect.width / 2;
      const y = element.rect.y + element.rect.height / 2;
      const clickResult = await methods.browserClick({ taskId: inspected.taskId, tabId: inspected.tabId, x, y });
      let keyResult: any = null;
      if (clear) {
        keyResult = await methods.browserKey({ taskId: inspected.taskId, tabId: inspected.tabId, key: process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A' });
      }
      const typeResult = await methods.browserType({ taskId: inspected.taskId, tabId: inspected.tabId, text });
      return { ok: true, element, console: typeResult.console || keyResult?.console || clickResult.console };
    },

    browserSkillsList({ host }: any) {
      const safeHost = sanitizeHost(host);
      return {
        host: safeHost,
        files: safeSkillFiles(safeHost).map((file: string) => ({
          name: path.basename(file),
          path: file,
        })),
      };
    },

    browserSkillsRead({ host }: any) {
      const safeHost = sanitizeHost(host);
      const files = safeSkillFiles(safeHost);
      return {
        host: safeHost,
        skills: files.map((file: string) => ({
          name: path.basename(file),
          path: file,
          content: fs.readFileSync(file, 'utf8'),
        })),
      };
    },
  };

  return { methods };
}

function keyEvent(raw: string) {
  const map: Record<string, any> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  };
  const combo = raw.split('+').map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  let key = combo[combo.length - 1] || raw;
  for (const part of combo.slice(0, -1)) {
    if (/^meta|cmd|command$/i.test(part)) modifiers |= 4;
    else if (/^ctrl|control$/i.test(part)) modifiers |= 2;
    else if (/^alt|option$/i.test(part)) modifiers |= 1;
    else if (/^shift$/i.test(part)) modifiers |= 8;
  }
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return {
      key: modifiers ? upper : key,
      code: `Key${upper}`,
      text: modifiers ? '' : key,
      unmodifiedText: key,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      nativeVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
    };
  }
  return { ...(map[key] || map.Enter), modifiers };
}

module.exports = { createBrowserController, normalizeBrowserUrl, parseBrowserRef, keyEvent };
