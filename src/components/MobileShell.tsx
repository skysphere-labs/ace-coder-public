import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { haptic } from '../runtime/haptics';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Files, Layers, LayoutDashboard, LayoutGrid, MoreHorizontal, Repeat, Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp, type View } from '../store';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { consumeMobileBack } from '../runtime/mobile-back-stack';
import { rubberBand, useSwipe } from '../runtime/use-swipe';
import { useMobileKeyboardInset } from '../runtime/use-mobile-viewport';
import { useFocusedVariant } from '../runtime/focused-variant-registry';
import { MobileTabSwitcher } from './MobileTabSwitcher';
import { MobileActivityDrawer } from './MobileActivityDrawer';
import { MobileTaskComposer } from './MobileTaskComposer';
import { MobileWorkspaceSheet } from './MobileWorkspaceSheet';
import { ErrorBoundary } from './ErrorBoundary';
import { GithubBrowserScreen } from './GithubBrowserScreen';
import { registerResidentAnchor } from '../runtime/resident-operator-registry';
import { GestureDots, NavTab } from './ui/mobile';
import { QuickLauncher } from './QuickLauncher';
import { CloneWorkspaceDialog } from './CloneWorkspaceDialog';
import { AddGithubAccountDialog } from './AddGithubAccountDialog';
import { Spinner } from './ui/spinner';
import AgentLogo from './ProviderGlyph';
import { AGENTS } from '../lib/types';

const ChangeReviewPane = lazy(() =>
  import('./ChangeReviewPane').then((module) => ({ default: module.ChangeReviewPane }))
);

type MobileTab = 'today' | 'workspaces' | 'loops' | 'settings';

const TAB_ITEMS: { id: MobileTab; icon: LucideIcon; label: string }[] = [
  // The Home tab is retired: Today is the landing surface. The archived
  // Agents/Hermes view stays reachable through command surfaces.
  { id: 'today', icon: LayoutDashboard, label: 'Today' },
  { id: 'workspaces', icon: Layers, label: 'Workspaces' },
  // Teams retired: the embed is resident, reachable from the launcher on every tab.
  // Loops is a first-class top-level section before Settings.
  { id: 'loops', icon: Repeat, label: 'Loops' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

// The left→right order the section pager swipes through is derived from the
// tab list inside MobileShell (it mirrors TAB_ITEMS by id).

// Promoted Operations surfaces reached as drill-ins from the Today dashboard
// (not bottom-nav pills). They render via WorkspaceCanvas and pop back to Today.
const OPS_DRILL_IN_VIEWS: View[] = ['board', 'todos', 'intel', 'monitor', 'knowledge'];
const OPS_DRILL_IN_TITLES: Partial<Record<View, string>> = {
  board: 'Board',
  todos: 'Todos',
  intel: 'Intel',
  monitor: 'Monitor',
  knowledge: 'Knowledge',
};

export function MobileShell() {
  const {
    view, setView,
    activeWorkspace, activeTask,
    showDiffViewer, setShowDiffViewer,
  } = useApp();

  const tabItems = TAB_ITEMS;
  const sectionOrder: MobileTab[] = tabItems.map((tab) => tab.id);

  // Tracks which tab the user last tapped, so `view === 'workspace'` (which
  // can be reached from either Home or Workspaces) highlights the correct pill
  // and routes the back button to the right parent.
  const [lastTab, setLastTab] = useState<MobileTab>('today');
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const keyboardInset = useMobileKeyboardInset();

  const activeTabId: MobileTab =
    view === 'today' ? 'today'
    : view === 'loops' ? 'loops'
    : view === 'workspaces' ? 'workspaces'
    : view === 'settings' || view === 'plugins' || view === 'remote' ? 'settings'
    : view === 'home' ? 'today'
    // Promoted Operations surfaces are Today drill-ins → keep the Today pill lit.
    : OPS_DRILL_IN_VIEWS.includes(view) ? 'today'
    : lastTab;

  const handleTabPress = (tab: typeof TAB_ITEMS[number]) => {
    haptic('tick');
    setLastTab(tab.id);
    if (tab.id === 'today') {
      setView('today');
      return;
    }
    if (tab.id === 'workspaces') {
      setView('workspaces');
      return;
    }
    if (tab.id === 'loops') {
      setView('loops');
      return;
    }
    if (tab.id === 'settings') setView('settings');
  };

  const handleBack = () => {
    // Let in-screen overlays (e.g. the "New tab" picker inside a task) close
    // themselves first before we do any view-level navigation.
    if (consumeMobileBack()) return;
    if (showDiffViewer) {
      setShowDiffViewer(false);
      return;
    }
    if (view === 'plugins' || view === 'remote') {
      setView('settings');
      return;
    }
    if (OPS_DRILL_IN_VIEWS.includes(view)) {
      setView('today');
      return;
    }
    if (view === 'workspace' || view === 'new-chat') {
      if (activeTabId === 'workspaces') {
        setView('workspaces');
        return;
      }
      setView('today');
    }
  };

  const title =
    showDiffViewer ? 'Changes'
    : view === 'plugins' ? 'Plugins'
    : view === 'remote' ? 'Remote'
    : view === 'hermes' ? 'Agents'
    : view === 'loops' ? 'Loops'
    : OPS_DRILL_IN_VIEWS.includes(view) ? (OPS_DRILL_IN_TITLES[view] ?? '')
    : view === 'workspaces' ? 'Workspaces'
    : view === 'settings' ? 'Settings'
    : view === 'github-browser' ? 'GitHub'
    // Only show the workspace/task name inside a workspace view. On 'home'
    // a stale activeWorkspace would otherwise leak its name into the header.
    : view === 'workspace' ? (activeTask?.name || activeWorkspace?.name || '')
    : view === 'new-chat' ? (activeWorkspace?.name || 'New chat')
    : '';

  const showBack =
    showDiffViewer ||
    view === 'plugins' ||
    view === 'remote' ||
    view === 'workspace' ||
    view === 'new-chat' ||
    OPS_DRILL_IN_VIEWS.includes(view);

  const showTabSwitcher = tabSwitcherOpen && !!activeTask && view === 'workspace';

  // ── Slate Ledger gesture model ──────────────────────────────────────────
  // Three non-colliding swipe verbs, all inheriting isSwipeBlocked (so a
  // terminal / Monaco / webview / unexhausted horizontal scroller always wins,
  // and a near-vertical drag always scrolls):
  //   • section views        → swipe L/R pages the five sections (follow-finger
  //                             peek + a 1px amber seam at the leading edge)
  //   • a back screen WITHOUT inner tabs (new-chat / plugins / remote / diff)
  //                          → swipe-LEFT dismisses it — the owner's ask, "back
  //                            buttons should swipe off when I swipe left"
  //   • any back screen      → an iOS left-edge drag-right also pops it
  // A task screen (workspace + activeTask) owns full-width L/R for its OWN tab
  // paging (ParallelTaskScreen), so the full-width back-swipe is suppressed
  // there while edge-back still works. The section pager and the full-width
  // back-swipe are never both armed on one screen (a screen is a section XOR a
  // drill-in), so a single gesture can never trigger two verbs.
  const trackRef = useRef<HTMLDivElement>(null);
  const seamRef = useRef<HTMLDivElement>(null);
  const taskHasTabs = view === 'workspace' && !!activeTask;
  const sectionPagerEnabled =
    !showDiffViewer &&
    (view === 'today' || view === 'workspaces' ||
      view === 'loops' || view === 'settings');
  // Full-width swipe-left-to-dismiss for back screens that don't page tabs.
  const backSwipeEnabled = showBack && !taskHasTabs;

  const resetPager = () => {
    const t = trackRef.current;
    if (t) {
      t.style.transition = '';
      t.style.transform = '';
    }
    if (seamRef.current) seamRef.current.style.opacity = '0';
  };
  // Follow-finger peek + the amber seam, written straight to the DOM during the
  // drag (no React state → no per-move re-render).
  const onPagerProgress = (dx: number) => {
    const t = trackRef.current;
    if (t) {
      t.style.transition = 'none';
      // Resisted, capped follow-finger peek (never runs the track off-screen).
      t.style.transform = `translate3d(${rubberBand(dx, 0.22, 64)}px,0,0)`;
    }
    const s = seamRef.current;
    if (s) {
      s.style.opacity = String(Math.min(1, Math.abs(dx) / 120));
      s.style.left = dx < 0 ? 'auto' : '0';
      s.style.right = dx < 0 ? '0' : 'auto';
    }
  };
  const goSection = (dir: -1 | 1) => {
    const i = sectionOrder.indexOf(activeTabId);
    const nextId = sectionOrder[i + dir];
    if (!nextId) return; // clamp at the ends, no wrap
    const tab = tabItems.find((t) => t.id === nextId);
    if (tab) handleTabPress(tab);
  };
  const backDismiss = () => {
    // Mirror the hardware-back contract: overlays close first, then nav.
    haptic('tick');
    if (!consumeMobileBack()) handleBack();
  };
  // One content-surface gesture: pages sections on a section view, or swipes a
  // tab-less back screen off on a left flick. Mutually exclusive by view.
  const sectionSwipeRef = useSwipe<HTMLDivElement>({
    enabled: sectionPagerEnabled || backSwipeEnabled,
    onSwipeLeft: () => {
      resetPager();
      if (sectionPagerEnabled) goSection(1); // finger left → next section
      else if (backSwipeEnabled) backDismiss(); // finger left → swipe the screen off
    },
    onSwipeRight: () => {
      resetPager();
      if (sectionPagerEnabled) goSection(-1); // finger right → previous section
    },
    onProgress: onPagerProgress,
    onCancel: resetPager,
  });
  const edgeBackRef = useSwipe<HTMLDivElement>({
    edge: 'left',
    enabled: showBack,
    onSwipeRight: () => {
      resetPager();
      haptic('tick');
      if (!consumeMobileBack()) handleBack();
    },
    onProgress: onPagerProgress,
    onCancel: resetPager,
  });

  // Publishes the full-canvas anchor; the surface itself is mounted in App.
  useEffect(() => {
    registerResidentAnchor(sectionSwipeRef.current);
    return () => registerResidentAnchor(null);
  }, [sectionSwipeRef]);

  return (
    <div
      ref={edgeBackRef}
      className="shell-workspace-root flex h-[100dvh] w-full flex-col overflow-hidden text-foreground"
      style={{
        // The soft keyboard overlays 100dvh instead of shrinking it; subtract
        // its inset so the composer sits directly above the keyboard and the
        // terminal refits its rows to the space that's actually visible. The
        // keyboard also covers the home-indicator strip, so the bottom
        // safe-area pad would be a dead gap while it's open.
        height: keyboardInset > 0 ? `calc(100dvh - ${keyboardInset}px)` : undefined,
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: keyboardInset > 0 ? 0 : 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Keep the task content mounted when the switcher is open so in-screen
          state (e.g. ParallelTaskScreen's `addingAgent`) survives the
          switcher's `+` action. Hidden via display:none, not unmounted. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', showTabSwitcher && 'hidden')}>
        <header
          className={cn(
            'relative z-[2] flex h-14 shrink-0 items-center gap-2 px-3 landscape:h-11 landscape:px-4',
            // Section views get the dot-rail as their affordance; drill-in views
            // get a quiet rule under the bar to separate it from the content.
            !sectionPagerEnabled && 'border-b border-[var(--m-hairline)]'
          )}
        >
          {showBack ? (
            <button
              type="button"
              onClick={handleBack}
              className="mobile-header-pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors active:text-foreground"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <div className="w-11 shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 flex-col items-center leading-tight">
            <h1 className="max-w-full truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--m-text)]">
              {title}
            </h1>
            {view === 'workspace' && activeTask && (
              <HeaderAgentBadge taskId={activeTask.id} />
            )}
          </div>
          {view === 'workspace' ? (
            <button
              type="button"
              onClick={() => setActivityOpen(true)}
              aria-label="Files, changes, history"
              className="mobile-header-pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors active:text-foreground"
            >
              <Files className="h-5 w-5" />
            </button>
          ) : view === 'new-chat' && activeWorkspace ? (
            <button
              type="button"
              onClick={() => setWorkspaceSheetOpen(true)}
              aria-label="Workspace menu"
              className="mobile-header-pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors active:text-foreground"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          ) : (
            <div className="w-11 shrink-0" />
          )}
        </header>

        {/* Always-on section position rail (SLIPSTREAM graft): five dots with a
            gliding amber capsule on section views, so a swipe and the indicator
            always agree on "where am I". */}
        {sectionPagerEnabled && (
          <GestureDots
            count={sectionOrder.length}
            index={sectionOrder.indexOf(activeTabId)}
            layoutId="m-section-dots"
            className="shrink-0"
          />
        )}
        <div ref={sectionSwipeRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* The follow-finger pager track holds only the canvas, so the swipe
              peek translates the view without tearing down the persistent
              webview overlays (GitHub) mounted as its siblings below. */}
          <div ref={trackRef} className="m-pager-track flex min-h-0 flex-1 flex-col">
            {/* A render crash in any view (e.g. a malformed remote payload) is
                contained here so the header + bottom nav keep working and the
                user can tap another tab; `resetKey={view}` clears it on nav. */}
            <ErrorBoundary variant="view" resetKey={view} label={title || undefined}>
              <WorkspaceCanvas mobile />
            </ErrorBoundary>
          </div>
          {/* 1px amber seam at the dragged edge; its opacity is driven inline
              from the live drag distance during a swipe. */}
          <div ref={seamRef} aria-hidden="true" className="m-swipe-seam" />
          {/* Mirror DesktopShell: render the github browser as a persistent
              overlay so the <webview> survives view switches. On remote
              clients the screen renders a "Open github.com" fallback. */}
          <GithubBrowserScreen visible={view === 'github-browser'} />
          {/* No Hermes embed here — it is mounted in App, above the shell swap. */}

          {/* Mobile diff viewer overlay — desktop renders this in-place; on
              mobile it's a full-screen layer with its own close affordance. */}
          {showDiffViewer && (
            <div className="absolute inset-0 z-[60] flex flex-col bg-background">
              <Suspense fallback={<MobileLoader />}>
                <ChangeReviewPane key={activeTask?.id ?? 'changes'} />
              </Suspense>
            </div>
          )}
        </div>

        {activeTask && view === 'workspace' ? (
          <div className="shrink-0 px-3 pb-2 pt-1">
            <TaskBottomBar
              taskId={activeTask.id}
              onTabsClick={() => setTabSwitcherOpen(true)}
            />
          </div>
        ) : (
          // Floating glass dock: the wrapper detaches it from the screen
          // edges (the ground stays visible around it) and the
          // `.mobile-nav-pill` touch styling turns it into a crisp blurred
          // pane. Icon-only tabs; NavTab's fixed-size tonal circle (shared
          // layoutId) is the single active indicator, gliding in lock-step
          // with the swipe pager and the dot rail under the header.
          <div className="shrink-0 px-5 pb-2.5 pt-1.5">
            <nav className="mobile-nav-pill mx-auto flex w-full max-w-[368px] items-center px-2 py-1 landscape:max-w-md">
              {tabItems.map((tab) => (
                <NavTab
                  key={tab.id}
                  icon={tab.icon}
                  label={tab.label}
                  active={activeTabId === tab.id}
                  onClick={() => handleTabPress(tab)}
                />
              ))}
            </nav>
          </div>
        )}
      </div>

      {showTabSwitcher && (
        <MobileTabSwitcher onClose={() => setTabSwitcherOpen(false)} />
      )}

      <AnimatePresence>
        {activityOpen && (
          <MobileActivityDrawer
            key="activity"
            onClose={() => setActivityOpen(false)}
          />
        )}
        {workspaceSheetOpen && activeWorkspace && (
          <MobileWorkspaceSheet
            key={`ws-sheet-${activeWorkspace.id}`}
            workspace={activeWorkspace}
            onClose={() => setWorkspaceSheetOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Mirror DesktopShell: these dialogs/launchers fire from anywhere via
          the store, so they must be mounted at the shell root on mobile too —
          without these mounts, the trigger sets a flag that no UI consumes. */}
      <QuickLauncher />
      <CloneWorkspaceDialog />
      <AddGithubAccountDialog />
    </div>
  );
}

function MobileLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="lg" className="text-muted-foreground" />
    </div>
  );
}

// Bottom bar inside a task. For chat/terminal surfaces we render the full
// composer; for browser/notes/file tabs the composer is meaningless, so we
// drop in a minimal row that still lets the user swap tabs.
function TaskBottomBar({
  taskId,
  onTabsClick,
}: {
  taskId: string;
  onTabsClick: () => void;
}) {
  const focused = useFocusedVariant(taskId);
  if (focused) {
    return <MobileTaskComposer taskId={taskId} onTabsClick={onTabsClick} />;
  }
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onTabsClick}
        aria-label="Tabs"
        className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--m-text-tertiary)] transition-colors active:text-[var(--m-text)]"
      >
        <LayoutGrid className="h-[20px] w-[20px]" strokeWidth={1.8} />
      </button>
    </div>
  );
}

// Sub-header line showing the focused variant's agent logo + name so the
// user always sees which agent the composer / view toggle is targeting.
function HeaderAgentBadge({ taskId }: { taskId: string }) {
  const focused = useFocusedVariant(taskId);
  if (!focused) return null;
  const meta = AGENTS.find((a) => a.id === focused.agent);
  const name = meta?.name ?? focused.agent;
  return (
    <div className="mt-0.5 flex max-w-full items-center gap-1.5 text-[10.5px] text-[var(--m-text-tertiary)]">
      <AgentLogo agent={focused.agent} className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </div>
  );
}
