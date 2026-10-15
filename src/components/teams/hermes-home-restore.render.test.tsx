// @vitest-environment happy-dom
//
// Integration proof for the shipped restore wiring: mounting the REAL
// HermesDesktopAppPane and firing the webview's load event must invoke the
// main-process home restore, execute the returned seed script in the frame,
// and trigger the cron delivery sweep — behavior, not source strings.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;

const SEED_SCRIPT = "(() => 'SEED-SCRIPT-MARKER')()";

const hermesDesktop = {
  ensure: vi.fn(async () => ({
    ok: true,
    url: 'file:///bundle/dist/index.html#/',
    preloadUrl: 'file:///bundle/electron/preload.cjs',
    surface: 'desktop',
    ownerKey: 'hermes-desktop-app',
  })),
  getActiveProfile: vi.fn(async () => ({ profile: null })),
  homeSessionRestore: vi.fn(async () => ({ sessionId: 'sess-home', script: SEED_SCRIPT })),
  cronHomeDeliverySync: vi.fn(async () => ({ ok: true, delivered: [], skipped: 0 })),
  stop: vi.fn(async () => ({ ok: true, stopped: true })),
  setActiveProfile: vi.fn(async () => ({ profile: null, changed: false })),
  onEvent: vi.fn(() => () => {}),
};

vi.mock('../../lib/ace-api', () => ({
  aceApi: { hermesDesktop },
  isRemoteClient: () => false,
}));
vi.mock('../../lib/github-browser', () => ({ requestBrowserOpen: vi.fn() }));
vi.mock('../../runtime/perf-health', () => ({
  recordPerf: vi.fn(),
  perfNow: () => 0,
  useSpinnerPerf: () => {},
}));
vi.mock('../../runtime/operators-registry', () => ({
  useOperators: () => ({
    schema: 'ace.operators.v1',
    defaultOperatorId: 'hermes',
    operators: [],
  }),
}));

const { HermesDesktopAppPane } = await import('./HermesDesktopAppPane');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// Wire the fake guest page onto the rendered <webview>: the latch probe reads
// un-latched, the seed script records its execution.
function armWebview() {
  const webview = container.querySelector('webview') as
    | (HTMLElement & { executeJavaScript?: (script: string) => Promise<unknown> })
    | null;
  if (!webview) return null;
  const executed: string[] = [];
  webview.executeJavaScript = vi.fn(async (script: string) => {
    executed.push(script);
    if (script.includes('__aceHomeRestoreRan')) return false; // fresh document
    return { restored: true };
  });
  return { webview, executed };
}

// Mount the pane and let the deferred boot (setTimeout(0) → ensure) settle.
async function mountLivePane() {
  await act(async () => {
    root.render(<HermesDesktopAppPane />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

it('bubble (re)open → webview load fires the home restore, seed script, and cron sweep', async () => {
  await mountLivePane();
  // ensure() resolved → the pane is live and the real <webview> is mounted.
  expect(hermesDesktop.ensure).toHaveBeenCalled();
  const armed = armWebview();
  expect(armed).not.toBeNull();

  // The document finishes loading — exactly what a bubble reopen after a
  // sidecar respawn produces.
  await act(async () => {
    armed!.webview.dispatchEvent(new Event('did-finish-load'));
    await Promise.resolve();
  });

  expect(hermesDesktop.homeSessionRestore).toHaveBeenCalled();
  expect(armed!.executed.some((s) => s.includes('__aceHomeRestoreRan'))).toBe(true);
  expect(armed!.executed).toContain(SEED_SCRIPT);
  expect(hermesDesktop.cronHomeDeliverySync).toHaveBeenCalled();
});

it('a reloaded (fresh) document restores again — the guard is per document, not per URL', async () => {
  await mountLivePane();
  const armed = armWebview();
  await act(async () => {
    armed!.webview.dispatchEvent(new Event('did-finish-load'));
    await Promise.resolve();
  });
  const callsAfterFirst = hermesDesktop.homeSessionRestore.mock.calls.length;
  expect(callsAfterFirst).toBeGreaterThan(0);

  // Same URL, new document (in-place reload): did-start-loading advances the
  // load generation, then the fresh document finishes — the guard must treat
  // it as a new document and restore again.
  await act(async () => {
    armed!.webview.dispatchEvent(new Event('did-start-loading'));
    armed!.webview.dispatchEvent(new Event('did-finish-load'));
    await Promise.resolve();
  });
  expect(hermesDesktop.homeSessionRestore.mock.calls.length).toBeGreaterThan(callsAfterFirst);
});

it('a latched document (restore already ran) never re-invokes the main-process restore', async () => {
  await mountLivePane();
  const webview = container.querySelector('webview') as
    | (HTMLElement & { executeJavaScript?: (script: string) => Promise<unknown> })
    | null;
  webview!.executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes('__aceHomeRestoreRan')) return true; // already ran
    return undefined;
  });
  await act(async () => {
    webview!.dispatchEvent(new Event('did-finish-load'));
    await Promise.resolve();
  });
  expect(hermesDesktop.homeSessionRestore).not.toHaveBeenCalled();
});
