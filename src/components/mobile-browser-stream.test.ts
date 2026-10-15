import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const pane = readFileSync(resolve(root, 'src/components/MobileBrowserPane.tsx'), 'utf8');
const browserPane = readFileSync(resolve(root, 'src/components/BrowserPane.tsx'), 'utf8');
const aceApi = readFileSync(resolve(root, 'src/lib/ace-api.ts'), 'utf8');
const remoteServer = readFileSync(resolve(root, 'electron/remote-server.cts'), 'utf8');
const main = readFileSync(resolve(root, 'electron/main.cts'), 'utf8');
const preload = readFileSync(resolve(root, 'electron/preload.cts'), 'utf8');
const localCore = readFileSync(resolve(root, 'electron/local-core.cts'), 'utf8');
const scratchRegistry = readFileSync(resolve(root, 'src/runtime/scratch-tabs-registry.ts'), 'utf8');

describe('mobile streamed browser pane', () => {
  it('is an interactive stream, not a Safari hand-off launcher', () => {
    expect(pane).toContain('aceApi.browser.streamSubscribe(taskId, tabId, viewport)');
    expect(pane).toContain('aceApi.browser.streamUnsubscribe(taskId, tabId)');
    expect(pane).toContain('aceApi.browser.onStreamEvent');
    expect(pane).not.toContain('Open in Safari');
    expect(pane).not.toContain('hand off to Safari');
  });

  it('forwards taps, scroll, text, and special keys to the desktop host', () => {
    expect(pane).toContain("{ type: 'tap', x: point.x, y: point.y }");
    expect(pane).toContain("type: 'wheel'");
    expect(pane).toContain("{ type: 'text', text }");
    expect(pane).toContain("{ type: 'key', key: 'Enter' }");
    expect(pane).toContain("{ type: 'key', key: 'Backspace' }");
    // Natural scrolling: content follows the finger.
    expect(pane).toContain('-g.pendingDy * point.scaleY');
  });

  it('raises the phone keyboard inside the tap gesture and drops it for non-editable taps', () => {
    expect(pane).toContain('keyboardRef.current?.focus({ preventScroll: true })');
    expect(pane).toContain('if (!result?.editable) keyboardRef.current?.blur()');
  });

  it('persists navigation state back into the scratch tab', () => {
    expect(pane).toContain('updateScratchTab(taskId, tabId, {');
    expect(pane).toContain('canGoBack: !!evt.canGoBack');
  });

  it('keeps the host viewport in sync with the pane size', () => {
    expect(pane).toContain('new ResizeObserver');
    expect(pane).toContain('streamResize');
  });

  it('remains the remote branch of BrowserPane', () => {
    expect(browserPane).toContain('if (isRemoteClient())');
    expect(browserPane).toContain('<MobileBrowserPane taskId={taskId} tabId={tabId} tab={tab} />');
  });
});

describe('browser stream transport', () => {
  it('client bridge dispatches browser:frame and resubscribes after reconnect', () => {
    expect(aceApi).toContain("else if (type === 'browser:frame')");
    expect(aceApi).toContain('const subscribedBrowserTabs = new Map');
    expect(aceApi).toContain("wsSend({ type: 'browser:subscribe', taskId, tabId, ...viewport })");
    expect(aceApi).toContain("wsSend({ type: 'browser:unsubscribe', taskId, tabId })");
  });

  it('remote server scopes frames to subscribed connections and releases refs on close', () => {
    expect(remoteServer).toContain("msg.type === 'browser:subscribe'");
    expect(remoteServer).toContain("msg.type === 'browser:unsubscribe'");
    expect(remoteServer).toContain('browserSubs.has(browserSubKey(payload?.taskId, payload?.tabId))');
    expect(remoteServer).toContain('for (const sub of browserSubs.values())');
    expect(remoteServer).toContain('aceStore.browserStreamClose?.({ taskId: sub.taskId, tabId: sub.tabId })');
  });

  it('remote server forwards browser ui-requests so phones receive login tabs', () => {
    expect(remoteServer).toContain("send('browser:ui-request', payload)");
  });

  it('main process hosts the stream module and login watcher on the store event spine', () => {
    expect(main).toContain("require('./browser-stream.cjs')");
    expect(main).toContain("require('./login-url-watcher.cjs')");
    expect(main).toContain('aceStore.emitBrowserStreamEvent(payload)');
    expect(main).toContain('loginWatcher.handlePtyData(payload)');
    expect(main).toContain("'ace:browser-stream-open': 'browserStreamOpen'");
    expect(preload).toContain("browserStreamOpen: 'ace:browser-stream-open'");
    expect(localCore).toContain("events.on('browser:stream-event', listener)");
  });

  it('login-driven ui-requests reuse the existing scratch tab open/activate flow', () => {
    expect(scratchRegistry).toContain('aceApi.browser.onUiRequest');
    expect(scratchRegistry).toContain("openRef(payload.taskId, { kind: 'scratch', tabId: payload.tabId })");
  });
});
