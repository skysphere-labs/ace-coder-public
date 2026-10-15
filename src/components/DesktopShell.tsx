import { Suspense, lazy, useState, useRef, useEffect, useMemo } from 'react';
import { useApp } from '../store';
import { WindowBar } from './WindowBar';
import { NavRail } from './NavRail';
import { WorkspaceRail } from './WorkspaceRail';
import { LedgerStrip } from './LedgerStrip';
import { ActivityPane } from './ActivityPane';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { GithubBrowserScreen } from './GithubBrowserScreen';
import { registerResidentAnchor } from '../runtime/resident-operator-registry';
import { QuickLauncher } from './QuickLauncher';
import { CloneWorkspaceDialog } from './CloneWorkspaceDialog';
import { AddGithubAccountDialog } from './AddGithubAccountDialog';
import { Spinner } from './ui/spinner';
import {
  getTerminalState,
  toggleTerminal,
} from '../runtime/terminal-mode';
import {
  NAV_RAIL_COLLAPSED_WIDTH,
  NAV_RAIL_EXPANDED_WIDTH,
  useNavRailPinned,
} from '../runtime/nav-rail-registry';

const ChangeReviewPane = lazy(() =>
  import('./ChangeReviewPane').then((module) => ({ default: module.ChangeReviewPane }))
);

export function DesktopShell() {
  const {
    view, setView, leftSidebarOpen, rightSidebarOpen, toggleLeftSidebar, toggleRightSidebar,
    showDiffViewer, activeTaskId,
  } = useApp();
  const showRightSidebar = rightSidebarOpen && view === 'workspace' && !!activeTaskId;
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(360);
  const draggingRef = useRef<'left' | 'right' | null>(null);
  // Publishes the full-canvas anchor; the surface itself is mounted in App.
  const canvasAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    registerResidentAnchor(canvasAnchorRef.current);
    return () => registerResidentAnchor(null);
  }, []);

  // The NavRail is a fixed strip left of the resizable Workspace Panel; the
  // panel's 180–420 width clamp is measured from the Rail's right edge. When the
  // rail is pinned open it takes real layout width, so the clamp origin is the
  // live rail width (read via ref so the move listener never re-registers).
  const railPinned = useNavRailPinned();
  const railWidthRef = useRef(NAV_RAIL_COLLAPSED_WIDTH);
  useEffect(() => {
    railWidthRef.current = railPinned ? NAV_RAIL_EXPANDED_WIDTH : NAV_RAIL_COLLAPSED_WIDTH;
  }, [railPinned]);

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < 1100 && rightSidebarOpen && view === 'workspace' && !!activeTaskId) toggleRightSidebar();
      if (w < 900 && leftSidebarOpen) toggleLeftSidebar();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [leftSidebarOpen, rightSidebarOpen, toggleLeftSidebar, toggleRightSidebar, view, activeTaskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== '`') return;
      if (!activeTaskId) return;
      e.preventDefault();
      const { open, mode } = getTerminalState(activeTaskId);
      if (!open && mode === 'right' && !rightSidebarOpen) toggleRightSidebar();
      toggleTerminal(activeTaskId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTaskId, rightSidebarOpen, toggleRightSidebar]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current === 'left') {
        setLeftWidth(Math.max(180, Math.min(420, e.clientX - railWidthRef.current)));
      } else if (draggingRef.current === 'right') {
        setRightWidth(Math.max(240, Math.min(640, window.innerWidth - e.clientX)));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = (which: 'left' | 'right') => () => {
    draggingRef.current = which;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const isElectron = 'aceDesktop' in window;
  const safeAreaStyle = useMemo(
    () =>
      isElectron
        ? undefined
        : {
            paddingTop: 'env(safe-area-inset-top)',
            paddingLeft: 'env(safe-area-inset-left)',
            paddingRight: 'env(safe-area-inset-right)',
          },
    [isElectron]
  );

  return (
    <div
      className="shell-workspace-root flex h-[100dvh] w-full flex-col overflow-hidden text-foreground"
      style={safeAreaStyle}
    >
      <WindowBar />

      <div className="shell-stage relative flex min-h-0 flex-1 gap-0 px-2 pb-2">
        {/* The icon Rail is always present (fixed width, outside the resize
            clamp) so switching global sections never depends on the Workspace
            Panel being open. */}
        <NavRail />

        {leftSidebarOpen && (
          <>
            <aside
              className="flex shrink-0 flex-col overflow-hidden"
              style={{ width: leftWidth }}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.05] bg-[hsl(var(--ace-surface)/0.5)] backdrop-blur-2xl">
                <WorkspaceRail />
              </div>
            </aside>
            <div
              onMouseDown={startDrag('left')}
              className="group relative w-2 shrink-0 cursor-col-resize"
              aria-label="Resize sidebar"
            >
              <div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/[0.04] transition-colors group-hover:bg-white/20" />
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>
          </>
        )}

        <main
          className="shell-main-card relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[hsl(var(--ace-surface)/0.5)] p-1 pb-0 shadow-raise-lg"
        >
          <div ref={canvasAnchorRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl">
            {showDiffViewer ? (
              <Suspense fallback={<ShellLoader />}>
                <ChangeReviewPane key={activeTaskId ?? 'changes'} />
              </Suspense>
            ) : (
              <WorkspaceCanvas />
            )}
            <GithubBrowserScreen visible={view === 'github-browser' && !showDiffViewer} />
            {/* No Hermes embed here — 'teams' now means "show the resident
                host full canvas" (mounted in App). */}
          </div>
        </main>

        {showRightSidebar && (
          <>
            <div
              onMouseDown={startDrag('right')}
              className="group relative w-2 shrink-0 cursor-col-resize"
              aria-label="Resize panel"
            >
              <div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/[0.04] transition-colors group-hover:bg-white/20" />
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>
            <aside
              className="flex shrink-0 flex-col overflow-hidden"
              style={{ width: rightWidth }}
            >
              <ActivityPane />
            </aside>
          </>
        )}
      </div>

      {/* Global status "flight deck" — full-width, below the stage. */}
      <LedgerStrip />

      <QuickLauncher />
      <CloneWorkspaceDialog />
      <AddGithubAccountDialog />
    </div>
  );
}

function ShellLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="lg" className="text-muted-foreground" />
    </div>
  );
}
