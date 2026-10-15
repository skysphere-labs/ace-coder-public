import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { useApp } from '../store';
import { aceApi } from '../lib/ace-api';
import { refreshAccounts } from '../runtime/github-registry';
import { Button } from './ui/button';

type LoginSession = {
  requestId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
};

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; session: LoginSession; copied: boolean; remaining: number }
  | { kind: 'success'; login: string | null; refreshWarning?: string }
  | { kind: 'error'; message: string };

export function AddGithubAccountDialog() {
  const { showAddGithubAccountDialog } = useApp();
  if (!showAddGithubAccountDialog) return null;
  return <AddGithubAccountDialogInner />;
}

function AddGithubAccountDialogInner() {
  const { setShowAddGithubAccountDialog } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  // Latest session — used by cleanup to cancel the backend poll loop.
  const sessionRef = useRef<LoginSession | null>(null);
  const pendingRequestRef = useRef<string | null>(null);
  // Generation counter: bumps on each begin() so stale poll resolutions
  // (from a StrictMode double-mount or a retry) can be discarded.
  const genRef = useRef(0);

  const run = useCallback(
    async (gen: number) => {
      const requestId = `ghreq_${crypto.randomUUID()}`;
      pendingRequestRef.current = requestId;
      let stage: 'start' | 'poll' | 'refresh' = 'start';
      let authorizedLogin: string | null | undefined;
      try {
        const start = await aceApi.github.loginStart(requestId);
        if (gen !== genRef.current) {
          void aceApi.github.loginCancel(requestId);
          return;
        }
        if (!start.ok) {
          if (pendingRequestRef.current === requestId) pendingRequestRef.current = null;
          setPhase({
            kind: 'error',
            message: start.error === 'cancelled' ? 'GitHub authorization was cancelled.' : start.error,
          });
          return;
        }
        const session: LoginSession = {
          requestId: start.requestId,
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          interval: start.interval,
          expiresAt: Date.now() + start.expiresIn * 1000,
        };
        pendingRequestRef.current = session.requestId;
        sessionRef.current = session;
        setPhase({
          kind: 'waiting',
          session,
          copied: false,
          remaining: start.expiresIn,
        });

        stage = 'poll';
        const result = await aceApi.github.loginPoll(session.requestId);
        if (gen !== genRef.current) return;
        if (pendingRequestRef.current === session.requestId) pendingRequestRef.current = null;
        sessionRef.current = null;
        if (!result.ok) {
          setPhase({
            kind: 'error',
            message: result.error === 'cancelled' ? 'GitHub authorization was cancelled.' : result.error,
          });
          return;
        }

        // The credential is already committed to gh at this point. A renderer
        // refresh failure must not present a retry-auth action that could add
        // the same account twice; report success with a distinct recovery hint.
        authorizedLogin = result.login;
        stage = 'refresh';
        const refreshed = await refreshAccounts();
        if (!refreshed) throw new Error('account refresh failed');
        if (gen !== genRef.current) return;
        setPhase({ kind: 'success', login: authorizedLogin });
        window.setTimeout(() => {
          if (gen === genRef.current) setShowAddGithubAccountDialog(false);
        }, 1200);
      } catch {
        if (gen !== genRef.current) return;
        const activeRequest = sessionRef.current?.requestId || pendingRequestRef.current;
        sessionRef.current = null;
        pendingRequestRef.current = null;
        if (stage !== 'refresh' && activeRequest) {
          void aceApi.github.loginCancel(activeRequest);
        }
        if (authorizedLogin !== undefined) {
          setPhase({
            kind: 'success',
            login: authorizedLogin,
            refreshWarning: 'The account was added, but ACE could not refresh the account list. Close this dialog and use Refresh Accounts.',
          });
          return;
        }
        setPhase({
          kind: 'error',
          message: stage === 'start'
            ? 'ACE could not start GitHub authorization. Check your connection and try again.'
            : 'ACE lost the GitHub authorization session. Please try again.',
        });
      }
    },
    [setShowAddGithubAccountDialog]
  );

  const retry = useCallback(() => {
    const activeRequest = pendingRequestRef.current;
    pendingRequestRef.current = null;
    sessionRef.current = null;
    if (activeRequest) void aceApi.github.loginCancel(activeRequest);
    setPhase({ kind: 'starting' });
    const gen = ++genRef.current;
    void run(gen);
  }, [run]);

  // Start on mount. Generation counter lets a StrictMode double-mount (or a
  // manual retry) discard any older pending poll resolutions.
  useEffect(() => {
    const gen = ++genRef.current;
    void run(gen);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      genRef.current++;
      const requestId = sessionRef.current?.requestId || pendingRequestRef.current;
      sessionRef.current = null;
      pendingRequestRef.current = null;
      if (requestId) void aceApi.github.loginCancel(requestId);
    };
  }, [run]);

  // Countdown timer while waiting.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const handle = window.setInterval(() => {
      setPhase((current) => {
        if (current.kind !== 'waiting') return current;
        const remaining = Math.max(0, Math.round((current.session.expiresAt - Date.now()) / 1000));
        if (remaining === current.remaining) return current;
        return { ...current, remaining };
      });
    }, 1000);
    return () => window.clearInterval(handle);
  }, [phase.kind]);

  const close = useCallback(() => setShowAddGithubAccountDialog(false), [setShowAddGithubAccountDialog]);

  const openBrowser = useCallback((url: string) => {
    void aceApi.workspaces.openExternal(url);
  }, []);

  const copyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setPhase((current) =>
        current.kind === 'waiting' ? { ...current, copied: true } : current
      );
      window.setTimeout(() => {
        setPhase((current) =>
          current.kind === 'waiting' ? { ...current, copied: false } : current
        );
      }, 1500);
    } catch {
      // Clipboard denial is non-fatal — user can select + copy manually.
    }
  }, []);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="glass-overlay fixed inset-0 z-[100] flex items-center justify-center"
        onClick={close}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="glass-surface flex w-full max-w-md flex-col overflow-hidden rounded-2xl"
        >
          <div className="flex shrink-0 items-center justify-between px-6 pr-4 pt-5">
            <h2 className="font-display text-lg font-semibold">Add GitHub account</h2>
            <Button variant="ghost" size="icon-sm" onClick={close}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="px-6 pb-6 pt-2">
            {phase.kind === 'starting' && <StartingView />}
            {phase.kind === 'waiting' && (
              <WaitingView
                session={phase.session}
                copied={phase.copied}
                remaining={phase.remaining}
                onCopy={copyCode}
                onOpen={openBrowser}
              />
            )}
            {phase.kind === 'success' && (
              <SuccessView
                login={phase.login}
                refreshWarning={phase.refreshWarning}
                onClose={close}
              />
            )}
            {phase.kind === 'error' && (
              <ErrorView message={phase.message} onRetry={retry} onClose={close} />
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function StartingView() {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>Requesting device code from GitHub…</span>
    </div>
  );
}

function WaitingView({
  session,
  copied,
  remaining,
  onCopy,
  onOpen,
}: {
  session: LoginSession;
  copied: boolean;
  remaining: number;
  onCopy: (code: string) => void;
  onOpen: (url: string) => void;
}) {
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Enter this code on GitHub to finish signing in. The code expires in{' '}
        <span className="tabular-nums text-foreground">{minutes}:{seconds}</span>.
      </p>

      <button
        type="button"
        onClick={() => onCopy(session.userCode)}
        className="group flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-4 py-3 transition hover:border-white/20"
      >
        <span className="font-mono text-xl font-semibold tracking-[0.3em] text-foreground">
          {session.userCode}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground group-hover:text-foreground">
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </span>
      </button>

      <Button onClick={() => onOpen(session.verificationUri)} className="w-full">
        <ExternalLink className="mr-2 h-4 w-4" />
        Open GitHub to authorize
      </Button>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Waiting for you to authorize in your browser…</span>
      </div>
    </div>
  );
}

function SuccessView({
  login,
  refreshWarning,
  onClose,
}: {
  login: string | null;
  refreshWarning?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 py-4 text-sm">
      <div className="flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-400" />
        <span>
          {login ? <>Signed in as <span className="font-medium">{login}</span>.</> : 'Account added.'}
        </span>
      </div>
      {refreshWarning && (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-amber-100">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{refreshWarning}</span>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </div>
  );
}

function ErrorView({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-words">{message}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}
