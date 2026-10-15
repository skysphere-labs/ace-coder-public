// @vitest-environment happy-dom
//
// Behavioral lifecycle test for TerminalFeed's attach/park wiring: a real
// React mount/unmount drives the effect, and the registry mock records what
// the component actually did — no source-text assertions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeSession = {
  attached: boolean;
  ptySpawned: boolean;
  wrapper: HTMLDivElement;
  terminal: { options: Record<string, unknown> };
};

const reg = {
  session: null as FakeSession | null,
  acquireSession: vi.fn(),
  acquireWebglRenderer: vi.fn(),
  resumeParkedStream: vi.fn(),
  subscribePtyStream: vi.fn(),
  unsubscribePtyStream: vi.fn(),
  openSessionIfNeeded: vi.fn(),
};

vi.mock('../runtime/terminal-registry', () => ({
  acquireSession: (id: string) => reg.acquireSession(id) ?? reg.session,
  acquireWebglRenderer: (s: unknown) => reg.acquireWebglRenderer(s),
  focusTerminal: () => {},
  observeTerminalScrolledUp: () => () => {},
  openSessionIfNeeded: (s: unknown) => reg.openSessionIfNeeded(s),
  pasteToTerminal: () => Promise.resolve(),
  alignTerminalDimensions: () => {},
  proposeDimensions: () => ({ cols: 80, rows: 24 }),
  proposeMobileDimensions: () => ({ cols: 80, rows: 24 }),
  refreshTerminalLayout: () => {},
  resumeParkedStream: (id: string) => reg.resumeParkedStream(id),
  scrollTerminalToBottom: () => {},
  subscribePtyStream: (id: string) => reg.subscribePtyStream(id),
  syncPty: () => {},
  unsubscribePtyStream: (id: string) => reg.unsubscribePtyStream(id),
  useTerminalSessionStatus: () => 'running',
}));

import { TerminalFeed } from './TerminalFeed';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeSession(): FakeSession {
  return {
    attached: false,
    ptySpawned: true,
    wrapper: document.createElement('div'),
    terminal: { options: {} },
  };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.setAttribute('data-ace-terminal-host', 'true');
  document.body.appendChild(host);
  reg.session = makeSession();
  for (const fn of [
    reg.acquireSession,
    reg.acquireWebglRenderer,
    reg.resumeParkedStream,
    reg.subscribePtyStream,
    reg.unsubscribePtyStream,
    reg.openSessionIfNeeded,
  ]) fn.mockReset();
});

describe('TerminalFeed lifecycle', () => {
  it('mount attaches, opens, takes the GPU renderer, catches up parked output, and re-subscribes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<TerminalFeed streamId="shell:t1" />);
    });

    const s = reg.session!;
    expect(reg.acquireSession).toHaveBeenCalledWith('shell:t1');
    expect(s.attached).toBe(true);
    expect(reg.openSessionIfNeeded).toHaveBeenCalledWith(s);
    expect(reg.acquireWebglRenderer).toHaveBeenCalledWith(s);
    expect(reg.resumeParkedStream).toHaveBeenCalledWith('shell:t1');
    // Catch-up must run on an ATTACHED session with a live renderer.
    expect(reg.acquireWebglRenderer.mock.invocationCallOrder[0]).toBeLessThan(
      reg.resumeParkedStream.mock.invocationCallOrder[0]
    );
    // Already-spawned stream re-subscribes (remote clients pull a snapshot).
    expect(reg.subscribePtyStream).toHaveBeenCalledWith('shell:t1');
    // The session's wrapper was adopted into the component's container.
    expect(container.contains(s.wrapper)).toBe(true);

    act(() => root.unmount());
  });

  it('unmount parks: detaches, drops the subscription, keeps the GPU context, returns the wrapper to the host', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<TerminalFeed streamId="shell:t2" />);
    });
    const s = reg.session!;
    expect(s.attached).toBe(true);

    act(() => root.unmount());
    expect(s.attached).toBe(false);
    expect(reg.unsubscribePtyStream).toHaveBeenCalledWith('shell:t2');
    // Warm parking: the context is NOT torn down on park (the pool retires
    // LRU holders itself); only one acquire happened, on mount.
    expect(reg.acquireWebglRenderer).toHaveBeenCalledTimes(1);
    // The wrapper survives, parked in the hidden host for instant re-attach.
    const host = document.querySelector('[data-ace-terminal-host="true"]')!;
    expect(host.contains(s.wrapper)).toBe(true);
  });

  it('a first-ever mount (PTY not spawned yet) does not double-subscribe', () => {
    reg.session = { ...makeSession(), ptySpawned: false };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<TerminalFeed streamId="shell:t3" />);
    });
    expect(reg.subscribePtyStream).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
