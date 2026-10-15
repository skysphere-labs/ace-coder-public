// @vitest-environment happy-dom
//
// Behavioural contract for the resident operator surface. The embed is stubbed
// with a mount counter so "never remounts" is asserted, not assumed.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;

// One module-level counter: every mount of the embed increments it.
const paneMounts = { count: 0 };
vi.mock('./HermesDesktopAppPane', () => ({
  HermesDesktopAppPane: () => {
    useEffect(() => {
      paneMounts.count += 1;
    }, []);
    return <div data-stub-pane />;
  },
}));

const store = { view: 'home', showDiffViewer: false, setView: vi.fn() };
vi.mock('../../store', () => ({ useApp: () => store }));

const viewport = { compact: false };
vi.mock('../../runtime/use-mobile-viewport', () => ({
  useIsMobileViewport: () => viewport.compact,
  landingView: () => (viewport.compact ? 'today' : 'home'),
}));

vi.mock('../../runtime/operators-registry', () => ({
  useOperators: () => ({
    schema: 'ace.operators.v1',
    defaultOperatorId: 'aurora',
    operators: [
      {
        id: 'aurora', label: 'Aurora', emoji: '✦', agent: 'hermes', providerKind: 'builtin-personal',
        isControlPlane: true, autoStart: false, sortOrder: 0, workspaceDirName: 'w', terminalDirName: 't',
        chat: { placeholder: '', busyRow: '', gerunds: [] }, ownerTitle: 'Owner',
      },
    ],
  }),
}));

const { ResidentOperatorSurface } = await import('./ResidentOperatorSurface');
const {
  registerResidentAnchor,
  setResidentOperatorMode,
  __resetResidentOperatorForTests,
} = await import('../../runtime/resident-operator-registry');

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(<ResidentOperatorSurface />);
  });
}
const host = () => container.querySelector('[data-resident-operator-host]') as HTMLElement;
const launcher = () => container.querySelector('[data-resident-operator-launcher]') as HTMLButtonElement | null;
const byLabel = (prefix: string) =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    (b.getAttribute('aria-label') || '').startsWith(prefix)
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  paneMounts.count = 0;
  store.view = 'home';
  store.showDiffViewer = false;
  store.setView = vi.fn();
  viewport.compact = false;
  __resetResidentOperatorForTests();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetResidentOperatorForTests();
});

it('mounts the embed exactly once and never remounts it across mode, route, or breakpoint changes', () => {
  render();
  expect(paneMounts.count).toBe(1);
  expect(host().getAttribute('data-mode')).toBe('collapsed');

  act(() => setResidentOperatorMode('popup'));
  expect(host().getAttribute('data-mode')).toBe('popup');
  act(() => setResidentOperatorMode('full'));
  expect(host().getAttribute('data-mode')).toBe('full');

  for (const view of ['settings', 'workspace', 'github-browser', 'home']) {
    act(() => {
      store.view = view;
      root.render(<ResidentOperatorSurface />);
    });
  }
  // Crossing the mobile breakpoint is the case that used to swap whole shells.
  act(() => {
    viewport.compact = true;
    root.render(<ResidentOperatorSurface />);
  });
  act(() => {
    viewport.compact = false;
    root.render(<ResidentOperatorSurface />);
  });

  expect(paneMounts.count).toBe(1);
  expect(container.querySelectorAll('[data-stub-pane]')).toHaveLength(1);
});

it('expand, restore and minimize move only host mode — never the router', () => {
  store.view = 'monitor';
  render();

  act(() => launcher()!.click());
  expect(host().getAttribute('data-mode')).toBe('popup');

  act(() => byLabel('Expand ')!.click());
  expect(host().getAttribute('data-mode')).toBe('full');

  act(() => byLabel('Restore ')!.click());
  expect(host().getAttribute('data-mode')).toBe('popup');

  act(() => byLabel('Minimize ')!.click());
  expect(host().getAttribute('data-mode')).toBe('collapsed');

  // The active ACE route is untouched throughout — Teams is retired.
  expect(store.setView).not.toHaveBeenCalled();
  expect(store.view).toBe('monitor');
});

it('keeps the chosen mode across route changes', () => {
  render();
  act(() => setResidentOperatorMode('full'));
  for (const view of ['settings', 'workspace', 'monitor']) {
    act(() => {
      store.view = view;
      root.render(<ResidentOperatorSurface />);
    });
    expect(host().getAttribute('data-mode')).toBe('full');
  }
  expect(paneMounts.count).toBe(1);
});

it('yields full canvas to the diff viewer so Change Review stays reachable', () => {
  act(() => setResidentOperatorMode('full'));
  store.showDiffViewer = true;
  render();
  expect(host().getAttribute('data-mode')).toBe('popup');

  act(() => {
    store.showDiffViewer = false;
    root.render(<ResidentOperatorSurface />);
  });
  expect(host().getAttribute('data-mode')).toBe('full');
});

it('fills the registered anchor rect in full canvas and the corner box otherwise', () => {
  const anchor = document.createElement('div');
  anchor.getBoundingClientRect = () => ({ top: 40, left: 120, width: 800, height: 600 }) as DOMRect;
  document.body.appendChild(anchor);

  act(() => setResidentOperatorMode('full'));
  render();
  act(() => registerResidentAnchor(anchor));

  expect(host().style.position).toBe('fixed');
  expect(host().style.top).toBe('40px');
  expect(host().style.left).toBe('120px');
  expect(host().style.width).toBe('800px');
  expect(host().style.height).toBe('600px');

  act(() => setResidentOperatorMode('popup'));
  // Corner box: the anchor geometry is dropped entirely. (The bottom/right
  // offsets are calc(... env(...)) which happy-dom's CSSOM discards, so the
  // absence of the anchor rect is what this can assert.)
  expect(host().style.position).toBe('fixed');
  expect(host().style.top).toBe('');
  expect(host().style.left).toBe('');
  anchor.remove();
});

it('hides collapsed mode inertly without unmounting or zero-sizing it', () => {
  render();
  const h = host();
  expect(h.style.visibility).toBe('hidden');
  expect(h.style.pointerEvents).toBe('none');
  expect(h.style.display).not.toBe('none');
  expect(h.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelectorAll('[data-stub-pane]')).toHaveLength(1);
});

it('moves focus into the host on open and back to the launcher on minimize', () => {
  render();
  act(() => launcher()!.click());
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Expand /);

  act(() => byLabel('Minimize ')!.click());
  expect(document.activeElement).toBe(launcher());
});

it('opening the popup never touches ACE navigation', () => {
  render();
  act(() => launcher()!.click());
  expect(store.setView).not.toHaveBeenCalled();
  expect(host().getAttribute('data-mode')).toBe('popup');
});

it('renders the configured operator identity, not a hardcoded name', () => {
  render();
  expect(launcher()!.getAttribute('aria-label')).toContain('Aurora');
  expect(container.textContent).toContain('✦');
});
