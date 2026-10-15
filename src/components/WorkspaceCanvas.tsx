import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../store';
import { WelcomeScreen } from './WelcomeScreen';
import { TaskPreparingScreen } from './TaskPreparingScreen';
import { Spinner } from './ui/spinner';

const SessionScreen = lazy(() =>
  import('./SessionScreen').then((module) => ({ default: module.SessionScreen }))
);
const ParallelTaskScreen = lazy(() =>
  import('./ParallelTaskScreen').then((module) => ({ default: module.ParallelTaskScreen }))
);
const PreferencesScreen = lazy(() =>
  import('./PreferencesScreen').then((module) => ({ default: module.PreferencesScreen }))
);
const PluginsScreen = lazy(() =>
  import('./PluginsScreen').then((module) => ({ default: module.PluginsScreen }))
);
const GithubScreen = lazy(() =>
  import('./GithubScreen').then((module) => ({ default: module.GithubScreen }))
);
const RemoteScreen = lazy(() =>
  import('./RemoteScreen').then((module) => ({ default: module.RemoteScreen }))
);
const NewChatScreen = lazy(() =>
  import('./NewChatScreen').then((module) => ({ default: module.NewChatScreen }))
);
const RemoteWorkspaceScreen = lazy(() =>
  import('./RemoteWorkspaceScreen').then((module) => ({ default: module.RemoteWorkspaceScreen }))
);
const MobileWorkspacesScreen = lazy(() =>
  import('./MobileWorkspacesScreen').then((module) => ({ default: module.MobileWorkspacesScreen }))
);
const TodayDashboard = lazy(() =>
  import('./TodayDashboard').then((module) => ({ default: module.TodayDashboard }))
);
const SetupScreen = lazy(() =>
  import('./SetupScreen').then((module) => ({ default: module.SetupScreen }))
);
const AgentsScreen = lazy(() =>
  import('./AgentsScreen').then((module) => ({ default: module.AgentsScreen }))
);
// Promoted Operations surfaces — the retired hub's kept features, each its own
// top-level screen but sharing one lazy chunk (./operations/OpsScreens).
const BoardScreen = lazy(() =>
  import('./operations/OpsScreens').then((module) => ({ default: module.BoardScreen }))
);
const TodosScreen = lazy(() =>
  import('./operations/OpsScreens').then((module) => ({ default: module.TodosScreen }))
);
const MonitorScreen = lazy(() =>
  import('./operations/OpsScreens').then((module) => ({ default: module.MonitorScreen }))
);
const IntelScreen = lazy(() =>
  import('./operations/OpsScreens').then((module) => ({ default: module.IntelScreen }))
);
const KnowledgeScreen = lazy(() =>
  import('./operations/OpsScreens').then((module) => ({ default: module.KnowledgeScreen }))
);
// Loops is now a first-class top-level section (moved out of Operations). It
// reuses the existing self-contained three-pane Loops console unchanged.
const LoopsScreen = lazy(() =>
  import('./operations/loops').then((module) => ({ default: module.LoopsTab }))
);
const LaneDeckScreen = lazy(() =>
  import('./LaneDeckScreen').then((module) => ({ default: module.LaneDeckScreen }))
);
export function WorkspaceCanvas({ mobile = false }: { mobile?: boolean } = {}) {
  const {
    view, activeWorkspace, activeTask, pendingActiveTaskId, activeTaskOpenedAt,
  } = useApp();

  if (view === 'setup') return <CanvasLoader><SetupScreen /></CanvasLoader>;
  if (view === 'settings') return <CanvasLoader><PreferencesScreen /></CanvasLoader>;
  if (view === 'plugins') return <CanvasLoader><PluginsScreen /></CanvasLoader>;
  if (view === 'github') return <CanvasLoader><GithubScreen /></CanvasLoader>;
  // 'github-browser' is rendered as a persistent overlay from DesktopShell so
  // the <webview> survives view switches without reloading.
  if (view === 'github-browser') return <div className="h-full w-full" />;
  if (view === 'remote') return <CanvasLoader><RemoteScreen /></CanvasLoader>;
  if (view === 'today') return <CanvasLoader><TodayDashboard /></CanvasLoader>;
  if (mobile && view === 'home') return <CanvasLoader><TodayDashboard /></CanvasLoader>;
  if (view === 'workspaces') return <CanvasLoader><MobileWorkspacesScreen /></CanvasLoader>;
  if (view === 'hermes') return <CanvasLoader><AgentsScreen /></CanvasLoader>;
  // 'teams' is rendered as a persistent overlay from the shells (same pattern
  // as github-browser) so the Hermes embed survives view switches without
  // killing the session running inside it.
  if (view === 'teams') return <div className="h-full w-full" />;
  if (view === 'loops') return <CanvasLoader><LoopsScreen /></CanvasLoader>;

  if (view === 'board') return <CanvasLoader><BoardScreen /></CanvasLoader>;
  if (view === 'todos') return <CanvasLoader><TodosScreen /></CanvasLoader>;
  if (view === 'intel') return <CanvasLoader><IntelScreen /></CanvasLoader>;
  if (view === 'monitor') return <CanvasLoader><MonitorScreen /></CanvasLoader>;
  if (view === 'knowledge') return <CanvasLoader><KnowledgeScreen /></CanvasLoader>;
  if (view === 'new-chat') return <CanvasLoader><NewChatScreen /></CanvasLoader>;
  if (view === 'new-remote') return <CanvasLoader><RemoteWorkspaceScreen /></CanvasLoader>;
  if (view === 'home' || !activeWorkspace) return <WelcomeScreen />;

  // Lane Deck wins over the active task — the deck keeps the task selected so
  // toggling back restores it, but while it's on we show every lane at once.
  if (view === 'lane-deck') {
    return (
      <CanvasLoader>
        <LaneDeckScreen key={activeWorkspace.id} workspace={activeWorkspace} />
      </CanvasLoader>
    );
  }

  if (activeTask) {
    if (activeTask.type === 'task') {
      // Worktree still materializing off the createTask path (or its checkout
      // failed): show the preparing/error interstitial instead of an empty
      // task. Once the worktree lands the task flips to 'idle', its variant
      // appears, and the real screen mounts here — auto-attaching the terminal.
      if (activeTask.status === 'preparing' || activeTask.status === 'error') {
        return <TaskPreparingScreen key={activeTask.id} task={activeTask} />;
      }
      return (
        <CanvasLoader>
          <ParallelTaskScreen key={activeTask.id} task={activeTask} />
        </CanvasLoader>
      );
    }
    return (
      <CanvasLoader>
        <SessionScreen key={activeTask.id} />
      </CanvasLoader>
    );
  }

  // A task was just opened but its record hasn't landed in the synced
  // snapshot yet (remote clients: the createTask response can beat the state
  // broadcast over the tunnel). Falling straight through to new-chat here is
  // the "spawned a task and got bounced back to the spawn screen" glitch —
  // hold a quiet opening screen for a grace window instead. A stale id with
  // no recent open (boot-restored nav pointing at a deleted task) skips the
  // grace and lands on new-chat immediately.
  if (pendingActiveTaskId && activeTaskOpenedAt !== null) {
    return (
      <OpeningTaskScreen
        key={pendingActiveTaskId}
        openedAt={activeTaskOpenedAt}
        fallback={
          <CanvasLoader>
            <NewChatScreen key={activeWorkspace.id} />
          </CanvasLoader>
        }
      />
    );
  }

  // Workspace selected but no task: land on new-chat. The dedicated workspace
  // page was removed; all workspace-level controls live in the sidebar's
  // workspace menu (threads/tasks list, PRs, branches, actions).
  return (
    <CanvasLoader>
      <NewChatScreen key={activeWorkspace.id} />
    </CanvasLoader>
  );
}

// How long a just-opened task may stay missing from the snapshot before we
// conclude it's genuinely gone and fall back to the spawn screen. Remote
// state normally catches up within a broadcast (~100ms) or the getState
// fallback (~1.5s + transfer); 10s covers a congested tunnel with margin.
const TASK_OPEN_GRACE_MS = 10_000;

function OpeningTaskScreen({
  openedAt,
  fallback,
}: {
  openedAt: number;
  fallback: ReactNode;
}) {
  const remaining = TASK_OPEN_GRACE_MS - (Date.now() - openedAt);
  const [expired, setExpired] = useState(remaining <= 0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
    // remaining is derived from openedAt; the key on this component resets
    // state when the pending task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedAt]);
  if (expired) return <>{fallback}</>;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Spinner size="lg" className="text-muted-foreground" />
      <p className="text-xs text-muted-foreground/70">Opening task…</p>
    </div>
  );
}

function CanvasLoader({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner size="lg" className="text-muted-foreground" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
