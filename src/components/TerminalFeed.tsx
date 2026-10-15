import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { dataTransferHasType, pathsFromDataTransfer } from '../lib/clipboard';
import { cn } from '../lib/utils';
import {
  acquireSession,
  acquireWebglRenderer,
  focusTerminal,
  observeTerminalScrolledUp,
  openSessionIfNeeded,
  pasteToTerminal,
  alignTerminalDimensions,
  proposeDimensions,
  proposeMobileDimensions,
  refreshTerminalLayout,
  resumeParkedStream,
  scrollTerminalToBottom,
  subscribePtyStream,
  syncPty,
  unsubscribePtyStream,
  useTerminalSessionStatus,
} from '../runtime/terminal-registry';
import { sanitizeTerminalDimensions } from '../runtime/terminal-safety';
import { MOBILE_MEDIA_QUERY } from '../runtime/use-mobile-viewport';

export function TerminalFeed({
  streamId,
  className,
  interactive = true,
  active = true,
}: {
  streamId: string | null;
  className?: string;
  interactive?: boolean;
  active?: boolean;
}) {
  const status = useTerminalSessionStatus(streamId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Whether the viewport is parked above the live tail. Touch clients keep
  // their scroll position while the agent streams (no erase-in-display snap),
  // so they need a one-tap way back down — the "jump to live" chip below.
  const [scrolledUp, setScrolledUp] = useState(false);

  const focusActiveTerminal = () => {
    if (!streamId || !interactive) return;
    focusTerminal(streamId);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !streamId || !active) return;

    const session = acquireSession(streamId);
    container.appendChild(session.wrapper);
    openSessionIfNeeded(session);
    session.attached = true;
    acquireWebglRenderer(session);
    // Catch up on output held while parked (parked terminals don't parse):
    // one write, or a snapshot resync if the buffer overflowed.
    resumeParkedStream(streamId);

    // Re-attaching an already-spawned stream (tab switch back) re-subscribes on
    // remote clients and pulls a fresh snapshot — the park cleanup below
    // unsubscribed it. A first-ever mount is spawned + subscribed by syncPty
    // (ptySpawned is still false here until then), so this doesn't double up.
    if (session.ptySpawned) subscribePtyStream(streamId);

    session.terminal.options.disableStdin = !interactive;
    session.terminal.options.cursorBlink = interactive;

    let pendingFitFrame: number | null = null;
    let disposed = false;
    let retriesLeft = 0;

    const doFit = () => {
      pendingFitFrame = null;
      if (disposed) return;
      if (container.clientWidth <= 0 || container.clientHeight <= 0) {
        // Layout not committed yet (tab just mounted, flex chain still
        // settling). Retry up to 8 frames (~130ms) — the ResizeObserver
        // below handles anything slower than that.
        if (retriesLeft > 0) {
          retriesLeft -= 1;
          pendingFitFrame = requestAnimationFrame(doFit);
        }
        return;
      }
      retriesLeft = 8;
      // Server is the sole resize authority — syncPty sends the desired
      // dims and the server replies with a sync snapshot that atomically
      // resizes + writes canonical state.
      // Phones get the fixed-column "desktop view" fit: the column count is
      // pinned and the font scales to the width, so keyboard/URL-bar/rotation
      // jitter never horizontally reflows (and corrupts) a full-screen TUI.
      const mobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
      const dims = mobile
        ? proposeMobileDimensions(streamId, container.clientWidth)
        : proposeDimensions(streamId);
      if (!dims) return;
      // A transient layout collapse (keyboard animation, pane mid-mount) can
      // propose degenerate dims; resizing the PTY to them shreds the TUI and
      // the real fit follows on the next ResizeObserver tick anyway.
      const safeDims = sanitizeTerminalDimensions(dims.cols, dims.rows, 20, 4);
      if (!safeDims) return;
      syncPty(streamId, safeDims.cols, safeDims.rows);
      // Realign the local xterm if a degenerate fit ever collapsed it while
      // hidden — the server may skip the snapshot when its dims are unchanged.
      alignTerminalDimensions(streamId, safeDims.cols, safeDims.rows);
    };

    const scheduleFit = () => {
      if (pendingFitFrame !== null) cancelAnimationFrame(pendingFitFrame);
      retriesLeft = 8;
      pendingFitFrame = requestAnimationFrame(doFit);
    };

    // Viewport churn — the soft keyboard sliding in, the mobile URL bar
    // showing/hiding, rotation — fires the ResizeObserver on nearly every
    // animation frame for ~250ms. Re-fitting per frame resizes the PTY over and
    // over mid-animation: on a full-screen TUI each shrink scrolls the top out
    // of view (the reported "CLI slides up") and floods the server resize path.
    // Settle first — coalesce the burst and fit once the container size has held
    // steady for a beat — so exactly one resize lands, at the final geometry.
    let settleTimer: number | null = null;
    const scheduleFitSettled = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        scheduleFit();
      }, 140);
    };

    let pendingRefreshFrame: number | null = requestAnimationFrame(() => {
      pendingRefreshFrame = requestAnimationFrame(() => {
        pendingRefreshFrame = null;
        if (disposed) return;
        refreshTerminalLayout(streamId);
        scheduleFit();
      });
    });

    // Initial fit — on first mount this also triggers ensureStreamStarted
    // which spawns the PTY with the correct dimensions.
    scheduleFit();

    const observer = new ResizeObserver(scheduleFitSettled);
    observer.observe(container);
    window.addEventListener('resize', scheduleFitSettled);

    const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fontsReady && typeof fontsReady.ready?.then === 'function') {
      fontsReady.ready.then(() => scheduleFit()).catch(() => {});
    }

    return () => {
      disposed = true;
      if (pendingFitFrame !== null) cancelAnimationFrame(pendingFitFrame);
      if (pendingRefreshFrame !== null) cancelAnimationFrame(pendingRefreshFrame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener('resize', scheduleFitSettled);
      // Only surrender the wrapper back to the hidden host if it's actually
      // still inside our container. Another TerminalFeed (e.g. the bottom
      // drawer mounting while the pane-grid's is still unmounting) may have
      // already adopted it during a mode switch — in that case, don't rip
      // it out from under them.
      if (session.wrapper.parentElement === container) {
        session.attached = false;
        // Parked sessions KEEP their WebGL context: within the pool's budget
        // a warm context makes switching back instant (rebuilding one is
        // slow on phone GPUs), and the pool retires the LRU holder itself
        // when a new acquire needs the slot (see terminal-webgl-pool.ts).
        // Drop the remote subscription while parked so the socket stops
        // carrying this stream's frames and the next wake-time resync doesn't
        // replay its full scrollback. Re-attach re-subscribes above.
        unsubscribePtyStream(streamId);
        const host = document.querySelector<HTMLDivElement>(
          '[data-ace-terminal-host="true"]'
        );
        if (host) host.appendChild(session.wrapper);
      }
    };
  }, [streamId, interactive, active]);

  // Runs after the attach effect above (declaration order), so the session
  // exists by the time we observe it. The observer fires once on subscribe,
  // clearing any stale value from a previous stream; the render below also
  // gates the chip on `active`.
  useEffect(() => {
    if (!streamId || !active) return;
    return observeTerminalScrolledUp(streamId, setScrolledUp);
  }, [streamId, active]);

  return (
    <div
      className={cn('terminal-surface relative h-full min-w-0 w-full overflow-hidden', className)}
      data-stream-status={status}
      onMouseDown={focusActiveTerminal}
      onClick={focusActiveTerminal}
      onDragOver={(e) => {
        if (!streamId) return;
        if (
          dataTransferHasType(e.dataTransfer, 'application/x-ace-paths') ||
          dataTransferHasType(e.dataTransfer, 'Files')
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (!streamId) return;
        if (
          !dataTransferHasType(e.dataTransfer, 'application/x-ace-paths') &&
          !dataTransferHasType(e.dataTransfer, 'Files')
        ) {
          return;
        }
        e.preventDefault();
        const paths = pathsFromDataTransfer(e.dataTransfer);
        if (paths.length === 0) return;
        const text = paths.map((p) => `@${p}`).join(' ') + ' ';
        void pasteToTerminal(streamId, { text });
        focusTerminal(streamId);
      }}
    >
      <div ref={containerRef} className="terminal-host h-full min-w-0 w-full overflow-hidden" />
      {active && scrolledUp && (
        <button
          type="button"
          aria-label="Jump to latest output"
          onMouseDown={(e) => {
            // Don't let the surface's focus handlers run — popping the soft
            // keyboard over a scroll correction reads as a misfire.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (streamId) scrollTerminalToBottom(streamId);
          }}
          className="terminal-jump-live absolute bottom-3 right-3 z-10 flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Live
        </button>
      )}
    </div>
  );
}
