import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useTaskRecord, useWorkspaceRecord } from './runtime/workspace-registry';
import { setCurrentTask } from './runtime/task-activity-registry';
import { clearUndo, redo, undo } from './runtime/undo-registry';
import { isRedoShortcut, isTextEditingSurface, isUndoShortcut } from './lib/shortcut-helpers';
import { MOBILE_MEDIA_QUERY } from './runtime/use-mobile-viewport';
import { onGithubBrowserOpen } from './lib/github-browser';
import { resolveLaneDeckToggle } from './lib/lane-deck-model';
import { recordPerf } from './runtime/perf-health';
import { aceApi, isRemoteClient } from './lib/ace-api';

export type View =
  | 'home'
  | 'today'
  | 'workspace'
  | 'workspaces'
  | 'lane-deck'
  | 'new-chat'
  | 'new-remote'
  | 'plugins'
  | 'github'
  | 'tickets'
  | 'github-browser'
  | 'remote'
  | 'hermes'
  | 'teams'
  | 'loops'
  | 'board'
  | 'todos'
  | 'intel'
  | 'monitor'
  | 'knowledge'
  | 'settings'
  | 'setup';

// Persist the top-level navigation slot across reloads so PWA users land
// back where they left off instead of the home screen. Only the three
// navigation keys are saved — transient UI state (modals, sidebars) isn't.
const NAV_STORAGE_KEY = 'ace:nav-v1';
// Setup completion flag — once set we don't auto-open the setup screen on
// boot. The screen is still reachable from Settings → Setup at any time.
const SETUP_DONE_KEY = 'ace:setup-v1';
const PERSISTED_VIEWS: ReadonlySet<View> = new Set<View>([
  'home',
  'today',
  'workspace',
  'workspaces',
  'lane-deck',
  'plugins',
  'github',
  'tickets',
  'github-browser',
  'remote',
  'hermes',
  'teams',
  'loops',
  'board',
  'todos',
  'intel',
  'monitor',
  'knowledge',
  'settings',
  'setup',
]);

function isSetupCompleted(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SETUP_DONE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markSetupCompleted() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETUP_DONE_KEY, '1');
  } catch {}
}

function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

function perfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function afterNextPaint(callback: () => void) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return () => {};
  }
  let inner = 0;
  const outer = window.requestAnimationFrame(() => {
    inner = window.requestAnimationFrame(callback);
  });
  return () => {
    window.cancelAnimationFrame(outer);
    if (inner) window.cancelAnimationFrame(inner);
  };
}

// Pick the initial view. New installs (no persisted nav, no setup flag) land
// on Setup. Existing users — anyone with prior nav state — auto-pass since
// the flag would never have been set for them but they obviously got Ace
// running already; we mark their setup as completed inline so subsequent
// boots don't second-guess. Post-setup, mobile cold-starts land on the Today
// dashboard; desktop stays on home (the desktop shell has no Today surface).
function pickInitialView(persisted: PersistedNav | null): View {
  // The Teams/Hermes surface can immediately open multi-GB Hermes state
  // databases. Keep cold launch light; users can still open Teams normally.
  if (persisted?.view) {
    if (persisted.view === 'hermes' || persisted.view === 'teams') {
      return isMobileViewport() ? 'today' : 'home';
    }
    // The mobile Home tab is retired in favour of Today; redirect stale
    // persisted state so phone users never land on the dropped tab. 'home'
    // stays a valid view for the desktop shell, which is untouched.
    if (persisted.view === 'home' && isMobileViewport()) return 'today';
    // The Lane Deck is a desktop surface — a phone cold-starting into a wall
    // of tiled terminals is unusable. Desktop restores the deck as persisted.
    if (persisted.view === 'lane-deck' && isMobileViewport()) return 'today';
    return persisted.view;
  }
  if (!isSetupCompleted()) return 'setup';
  return isMobileViewport() ? 'today' : 'home';
}

type PersistedNav = {
  view: View;
  activeWorkspaceId: string | null;
  activeTaskId: string | null;
};

function loadPersistedNav(): PersistedNav | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedNav>;
    const view = PERSISTED_VIEWS.has(parsed.view as View)
      ? (parsed.view as View)
      : 'home';
    return {
      view,
      activeWorkspaceId:
        typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null,
      activeTaskId: typeof parsed.activeTaskId === 'string' ? parsed.activeTaskId : null,
    };
  } catch {
    return null;
  }
}

function savePersistedNav(nav: PersistedNav) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(nav));
  } catch {
    // Quota/Safari private mode — persistence is a nice-to-have, not critical.
  }
}

type AppState = {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  activeWorkspaceId: string | null;
  activeWorkspace: ReturnType<typeof useWorkspaceRecord>;
  activeTaskId: string | null;
  activeTask: ReturnType<typeof useTaskRecord>;
  // The raw selected task id, kept even while the task record is missing from
  // the synced snapshot (activeTaskId above is null in that window). Set with
  // a timestamp by openTask so the canvas can show an "opening" grace screen
  // for a just-created task instead of bouncing back to the spawn screen
  // while state catches up over the tunnel.
  pendingActiveTaskId: string | null;
  activeTaskOpenedAt: number | null;
  openWorkspace: (workspaceId: string, view?: View) => void;
  openTask: (workspaceId: string, taskId: string) => void;
  // Per-workspace Lane Deck toggle: opens the all-lanes grid for the given
  // workspace, or — when that workspace's deck is already showing — returns
  // to where the user was (the active task's single view, else new-chat).
  // The active task is deliberately kept while the deck is open.
  toggleLaneDeck: (workspaceId: string) => void;
  pendingChatKind: 'thread' | 'task' | null;
  setPendingChatKind: Dispatch<SetStateAction<'thread' | 'task' | null>>;
  leftSidebarOpen: boolean;
  toggleLeftSidebar: () => void;
  rightSidebarOpen: boolean;
  toggleRightSidebar: () => void;
  showDiffViewer: boolean;
  setShowDiffViewer: Dispatch<SetStateAction<boolean>>;
  showCommandPalette: boolean;
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>;
  showCloneWorkspaceModal: boolean;
  setShowCloneWorkspaceModal: Dispatch<SetStateAction<boolean>>;
  showAddGithubAccountDialog: boolean;
  setShowAddGithubAccountDialog: Dispatch<SetStateAction<boolean>>;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const routeChangeRef = useRef<{ from: View; to: View; startedAt: number } | null>(null);
  const [view, setViewRaw] = useState<View>(() => pickInitialView(loadPersistedNav()));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => loadPersistedNav()?.activeWorkspaceId ?? null
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    () => loadPersistedNav()?.activeTaskId ?? null
  );

  // If the user has prior nav state but we never wrote a setup flag (i.e.
  // they're on a build where setup didn't exist), backfill the flag so we
  // never push them to setup later.
  useEffect(() => {
    if (loadPersistedNav() && !isSetupCompleted()) markSetupCompleted();
  }, []);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCloneWorkspaceModal, setShowCloneWorkspaceModal] = useState(false);
  const [showAddGithubAccountDialog, setShowAddGithubAccountDialog] = useState(false);
  const [pendingChatKind, setPendingChatKind] = useState<'thread' | 'task' | null>(null);

  const setView = useCallback<Dispatch<SetStateAction<View>>>((next) => {
    setViewRaw((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved !== current) {
        routeChangeRef.current = { from: current, to: resolved, startedAt: perfNow() };
      }
      return resolved;
    });
  }, []);

  const workspaceRecord = useWorkspaceRecord(activeWorkspaceId);
  const activeWorkspace = workspaceRecord ?? null;
  const activeWorkspaceKey = activeWorkspace?.id ?? null;
  const taskRecord = useTaskRecord(activeWorkspaceKey, activeTaskId);
  const activeTask = taskRecord ?? null;
  const resolvedActiveTaskId = activeTask?.id ?? null;

  // Keep the task-activity registry in sync with which task the user is
  // currently looking at, so (a) it clears any unread pip on that task, and
  // (b) future busy→idle transitions on the focused task don't add one.
  useEffect(() => {
    setCurrentTask(resolvedActiveTaskId);
  }, [resolvedActiveTaskId]);

  useEffect(() => {
    clearUndo();
  }, [activeWorkspaceKey]);

  useEffect(() => {
    return onGithubBrowserOpen(() => {
      setShowDiffViewer(false);
      setView('github-browser');
    });
  }, [setView]);


  useEffect(() => {
    const pending = routeChangeRef.current;
    if (!pending || pending.to !== view) return;
    return afterNextPaint(() => {
      const current = routeChangeRef.current;
      if (!current || current.to !== view) return;
      recordPerf({
        kind: 'span',
        name: 'route.switch',
        durationMs: perfNow() - current.startedAt,
        meta: { from: current.from, to: current.to },
      });
      routeChangeRef.current = null;
    });
  }, [view]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isUndo = isUndoShortcut(e);
      const isRedo = isRedoShortcut(e);
      if (!isUndo && !isRedo) return;
      if (isTextEditingSurface(document.activeElement)) return;
      e.preventDefault();
      if (isUndo) void undo();
      else void redo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Persist the nav slot so relaunching the PWA (or reloading the tab)
  // restores the user's last workspace/task instead of dropping them on home.
  useEffect(() => {
    if (!PERSISTED_VIEWS.has(view)) return;
    savePersistedNav({ view, activeWorkspaceId, activeTaskId });
  }, [view, activeWorkspaceId, activeTaskId]);

  const toggleLeftSidebar = useCallback(() => setLeftSidebarOpen((value) => !value), []);
  const toggleRightSidebar = useCallback(() => setRightSidebarOpen((value) => !value), []);

  const openWorkspace = useCallback((workspaceId: string, nextView: View = 'new-chat') => {
    setActiveWorkspaceId(workspaceId);
    setActiveTaskId(null);
    setShowDiffViewer(false);
    setView(nextView);
  }, [setView]);

  // When the user last explicitly opened a task (vs. nav restored from
  // localStorage on boot). Drives the "opening" grace window: a boot-restored
  // id that no longer exists should fall through to new-chat immediately, but
  // a just-opened task deserves a beat for state to catch up.
  const [activeTaskOpenedAt, setActiveTaskOpenedAt] = useState<number | null>(null);

  const openTask = useCallback((workspaceId: string, taskId: string) => {
    setActiveWorkspaceId(workspaceId);
    setActiveTaskId(taskId);
    setActiveTaskOpenedAt(Date.now());
    setView('workspace');
  }, [setView]);

  const toggleLaneDeck = useCallback((workspaceId: string) => {
    // The enter/exit/switch-workspace contract lives in resolveLaneDeckToggle
    // (pure, unit-tested); this callback just applies it.
    const next = resolveLaneDeckToggle({ view, activeWorkspaceId, activeTaskId }, workspaceId);
    if (next.nextView !== 'lane-deck') {
      setView(next.nextView);
      return;
    }
    if (next.clearActiveTask) setActiveTaskId(null);
    setActiveWorkspaceId(workspaceId);
    setShowDiffViewer(false);
    setView('lane-deck');
  }, [view, activeWorkspaceId, activeTaskId, setView]);

  const value = useMemo(
    () => ({
      view,
      setView,
      activeWorkspaceId: activeWorkspaceKey,
      activeWorkspace,
      activeTaskId: resolvedActiveTaskId,
      activeTask,
      pendingActiveTaskId: activeTaskId,
      activeTaskOpenedAt,
      openWorkspace,
      openTask,
      toggleLaneDeck,
      leftSidebarOpen,
      toggleLeftSidebar,
      rightSidebarOpen,
      toggleRightSidebar,
      showDiffViewer,
      setShowDiffViewer,
      showCommandPalette,
      setShowCommandPalette,
      showCloneWorkspaceModal,
      setShowCloneWorkspaceModal,
      showAddGithubAccountDialog,
      setShowAddGithubAccountDialog,
      pendingChatKind,
      setPendingChatKind,
    }),
    [
      view,
      activeWorkspaceKey,
      activeWorkspace,
      resolvedActiveTaskId,
      activeTask,
      activeTaskId,
      activeTaskOpenedAt,
      openWorkspace,
      openTask,
      toggleLaneDeck,
      setView,
      leftSidebarOpen,
      toggleLeftSidebar,
      rightSidebarOpen,
      toggleRightSidebar,
      showDiffViewer,
      showCommandPalette,
      showCloneWorkspaceModal,
      showAddGithubAccountDialog,
      pendingChatKind,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be inside AppProvider');
  }
  return context;
}
