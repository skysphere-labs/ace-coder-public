import { TooltipProvider } from './components/ui/tooltip';
import { AppProvider } from './store';
import { MobileShell } from './components/MobileShell';
import { ResidentOperatorSurface } from './components/teams/ResidentOperatorSurface';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UndoToast } from './components/UndoToast';
import { useIsMobileViewport } from './runtime/use-mobile-viewport';
import { RemoteEnrollScreen } from './components/RemoteEnrollScreen';
import { Spinner } from './components/ui/spinner';
import { useCoreBootstrap } from './runtime/core-registry';
import { useSpinnerPerf } from './runtime/perf-health';
import { aceApi, isRemoteClient, remoteGetToken } from './lib/ace-api';
import type { RuntimeState } from './lib/ace-api';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

// The desktop shell statically pulls the full terminal stack (ActivityPane →
// TerminalPanel → xterm, ~580KB). Because App mounts whichever shell the
// viewport calls for, a static import would drag that whole subtree — and its
// modulepreload — into the boot bundle a phone never uses. Lazy-loading it
// keeps xterm out of the mobile entry; desktop pays a one-frame Suspense on
// first mount instead. MobileShell stays eager so the phone needs no extra
// round trip for its shell.
const DesktopShell = lazy(() =>
  import('./components/DesktopShell').then((m) => ({ default: m.DesktopShell }))
);

export default function App() {
  const mobile = useIsMobileViewport();
  const remote = isRemoteClient();
  const [needsEnrollment, setNeedsEnrollment] = useState(() => {
    if (!remote) return false;
    if (hasEnrollmentFragment()) return true;
    return !remoteGetToken();
  });
  useEffect(() => {
    if (!remote) return;
    const check = () => setNeedsEnrollment(hasEnrollmentFragment() || !remoteGetToken());
    window.addEventListener('storage', check);
    window.addEventListener('hashchange', check);
    return () => {
      window.removeEventListener('storage', check);
      window.removeEventListener('hashchange', check);
    };
  }, [remote]);

  if (needsEnrollment) {
    return (
      <TooltipProvider delayDuration={300}>
        <RemoteEnrollScreen onEnrolled={() => setNeedsEnrollment(false)} />
      </TooltipProvider>
    );
  }

  // Desktop waits for local startup. Remote clients retain device enrollment.
  if (!remote) {
    return (
      <DesktopRuntime>
        <Bootstrapped mobile={mobile} />
      </DesktopRuntime>
    );
  }

  return <Bootstrapped mobile={mobile} />;
}

// A readiness gate, independent of accounts and network access.
function DesktopRuntime({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ status: 'starting' });
  const retry = useCallback(() => {
    setState({ status: 'starting' });
    void aceApi.startup.state().then(setState).catch(() => {
      setState({ status: 'boot-error', reason: 'The local runtime could not be reached.' });
    });
  }, []);
  useEffect(() => {
    let alive = true;
    const apply = (next: RuntimeState) => { if (alive) setState(next); };
    const off = aceApi.startup.onChanged(apply);
    void aceApi.startup.state().then(apply).catch(() => {
      apply({ status: 'boot-error', reason: 'The local runtime could not be reached.' });
    });
    return () => { alive = false; off(); };
  }, []);
  if (state.status === 'ready') return <>{children}</>;
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-[100dvh] items-center justify-center bg-background px-6 text-center text-foreground">
        {state.status === 'starting' ? <Spinner size="lg" className="text-muted-foreground" /> : (
          <div className="max-w-md space-y-3">
            <h1 className="text-lg font-semibold">ACE CODER could not start.</h1>
            <p className="text-sm text-muted-foreground">{state.reason}</p>
            <button type="button" className="rounded-md border px-4 py-2" onClick={retry}>Retry startup</button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function Bootstrapped({ mobile }: { mobile: boolean }) {
  const { status, error } = useCoreBootstrap();
  useSpinnerPerf({
    active: status === 'loading',
    component: 'app.bootstrap',
    label: 'Ace bootstrap',
    route: 'app',
    trigger: 'core.getState',
    previousContent: false,
  });

  if (status === 'loading') {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-[100dvh] items-center justify-center bg-background text-foreground">
          <Spinner size="lg" className="text-muted-foreground" />
        </div>
      </TooltipProvider>
    );
  }

  if (status === 'error') {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-[100dvh] items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="max-w-md space-y-2">
            <h1 className="text-lg font-semibold tracking-tight">Ace failed to load local data.</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  const Shell = mobile ? MobileShell : DesktopShell;
  return (
    <TooltipProvider delayDuration={300}>
      <AppProvider>
        {/* Top-level backstop: a crash in the shell chrome itself (outside the
            per-view boundary in MobileShell) shows a recoverable reload screen
            instead of a blank white page. */}
        <ErrorBoundary variant="fullscreen">
          {/* DesktopShell is lazy, so a Suspense boundary is required for its
              first mount; MobileShell resolves synchronously and never suspends
              here. */}
          <Suspense
            fallback={
              <div className="flex h-[100dvh] items-center justify-center bg-background text-foreground">
                <Spinner size="lg" className="text-muted-foreground" />
              </div>
            }
          >
            <Shell />
          </Suspense>
        </ErrorBoundary>
        {/* Above the shell swap: crossing the mobile breakpoint must not
            remount the Hermes webview. Its own boundary — it sits outside the
            shell's, and no resetKey, which would remount the embed. */}
        <ErrorBoundary variant="view">
          <ResidentOperatorSurface />
        </ErrorBoundary>
        <UndoToast />
      </AppProvider>
    </TooltipProvider>
  );
}

function hasEnrollmentFragment(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  if (!hash || hash.length <= 1) return false;
  return new URLSearchParams(hash.replace(/^#/, '')).has('enroll');
}
