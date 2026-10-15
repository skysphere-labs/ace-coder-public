import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

// App-wide error boundary. Before this, any render-time throw (e.g. a remote
// workspace payload missing its tasks[] array) unmounted the whole React tree
// and white-screened the app — the #1 cause of the "it just crashes" reports.
// Two ways to use it:
//   - variant="view" wraps the swappable view content INSIDE the shell, so the
//     header + bottom nav survive a crash and the user can tap another tab.
//     `resetKey` (the current view) clears the error on navigation.
//   - variant="fullscreen" is the top-level backstop in App.tsx for a crash in
//     the shell chrome itself.

type Props = {
  children: ReactNode;
  /** When this value changes, a tripped boundary auto-resets (e.g. the view). */
  resetKey?: string | number;
  variant?: 'view' | 'fullscreen';
  /** Optional label shown in the fallback, e.g. the screen name. */
  label?: string;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Keep a breadcrumb in the console for diagnosis; never rethrow.
    console.error('[ace] UI crash caught by ErrorBoundary:', error, info?.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Navigating to a different view clears a previously-tripped screen so the
    // user is never stuck on the error card after moving on.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const fullscreen = this.props.variant === 'fullscreen';
    return (
      <div
        className={
          fullscreen
            ? 'flex h-[100dvh] w-full flex-col items-center justify-center bg-background px-6 text-center text-foreground'
            : 'flex h-full w-full flex-col items-center justify-center px-6 text-center text-foreground'
        }
        role="alert"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03]">
          <AlertTriangle className="h-6 w-6 text-amber-300/85" />
        </div>
        <h2 className="mt-4 text-base font-semibold">
          {this.props.label ? `${this.props.label} hit a problem` : 'This screen hit a problem'}
        </h2>
        <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
          {fullscreen
            ? 'Ace ran into an unexpected error. Reloading usually clears it.'
            : 'You can keep using the other tabs, or try this screen again.'}
        </p>
        {error.message && (
          <p className="mx-auto mt-2 max-w-xs truncate font-mono text-[10.5px] text-muted-foreground/60">
            {error.message}
          </p>
        )}
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="mobile-glass-card flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-medium text-foreground transition-colors active:bg-white/[0.06]"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex h-10 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-[13px] font-medium text-foreground transition-colors active:bg-white/[0.1]"
          >
            <RefreshCw className="h-4 w-4" />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
