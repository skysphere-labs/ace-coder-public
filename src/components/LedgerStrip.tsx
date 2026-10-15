import { useEffect, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useApp } from '../store';
import {
  aceApi,
  type ProviderUsage,
  type ProviderUsageMeter,
} from '../lib/ace-api';
import type { RunLedgerBoard } from '../lib/types';
import { useBusyTaskIds } from '../runtime/task-activity-registry';
import { useProviderUsage } from '../runtime/usage-registry';
import { ProviderSubscriptionsContent } from './ProviderUsagePopover';
import { cn } from '../lib/utils';
import { LiveDot } from './ui/deck/LiveDot';

// The Ledger Strip — a full-width "flight deck" status bar along the bottom of
// the shell. One row of tabular-mono cells separated by hairlines, calm by
// default (tertiary text) and only lighting amber for live / attention. Every
// value comes from data the renderer already has: no new IPC.
export function LedgerStrip() {
  const { setView, activeWorkspace, activeTask } = useApp();
  const busy = useBusyTaskIds();
  const running = busy.size;

  // Runs — re-read the pure, zero-token run-ledger projection on core / git
  // events (the RunBoardPanel pattern), debounced, with a slow poll safety net.
  const [board, setBoard] = useState<RunLedgerBoard | null>(null);
  useEffect(() => {
    let alive = true;
    let debounce: number | null = null;
    const reload = () =>
      aceApi.missions
        .runBoard()
        .then((b) => { if (alive) setBoard(b); })
        .catch(() => { /* board optional — strip degrades to no runs */ });
    const schedule = () => {
      if (debounce != null) return;
      debounce = window.setTimeout(() => { debounce = null; reload(); }, 350);
    };
    reload();
    const offState = aceApi.core.subscribe(() => schedule());
    const offGit = aceApi.core.onGitChanged(() => schedule());
    const poll = window.setInterval(reload, 6000);
    return () => {
      alive = false;
      try { offState?.(); } catch { /* noop */ }
      try { offGit?.(); } catch { /* noop */ }
      if (debounce != null) window.clearTimeout(debounce);
      window.clearInterval(poll);
    };
  }, []);

  // Usage — one glanceable cell PER provider from the shared event-driven
  // subscription (same store as ProviderUsagePill), each showing that
  // provider's meters and opening its usage popover.
  const { report } = useProviderUsage();

  const [clock, setClock] = useState(() => fmtClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setClock(fmtClock(new Date())), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const counts = board?.counts;

  return (
    <div className="flex h-6 shrink-0 items-center divide-x divide-white/[0.06] overflow-hidden px-2 text-[11px] text-foreground/45">
      {/* Fleet */}
      <Cell>
        <LiveDot live={running > 0} />
        <span className="mono-data text-foreground/60">{running}</span>
        <span>running</span>
      </Cell>

      {/* Runs — whole cell routes to the run-ledger Board; amber for attention. */}
      {counts && counts.total > 0 && (
        <Cell onClick={() => setView('board')} title="Open Board">
          <span className="mono-data text-foreground/60">{counts.inProgress}</span>
          <span>in progress</span>
          {counts.readyToReview > 0 && (
            <>
              <span className="mono-data text-[hsl(var(--ace-accent))]">{counts.readyToReview}</span>
              <span className="text-[hsl(var(--ace-accent))]">review</span>
            </>
          )}
          {counts.blocked > 0 && (
            <>
              <span className="mono-data text-rose-300/90">{counts.blocked}</span>
              <span className="text-rose-300/90">blocked</span>
            </>
          )}
        </Cell>
      )}

      {/* Context — repo · branch when in a workspace. */}
      {activeWorkspace && (
        <Cell>
          <span className="mono-data max-w-[220px] truncate text-foreground/55">
            {activeWorkspace.githubRepo ?? activeWorkspace.name}
            {activeTask?.branch ? ` · ${activeTask.branch}` : ''}
          </span>
        </Cell>
      )}

      {/* Usage — one cell per provider so both are glanceable at once.
          data-usage-generated-at makes push freshness observable to runtime
          QA (percent text alone can be identical between snapshots). Each
          cell opens its provider's usage popover. */}
      {(report?.providers ?? []).map((p) => (
        <ProviderUsageCell key={p.id} provider={p} now={report?.generatedAt ?? 0} />
      ))}

      {/* Build / clock — right-aligned, quiet. */}
      <div className="ml-auto flex h-full items-center gap-2 pl-3 text-[hsl(var(--ace-text-3))]">
        <span className="mono-data">{clock}</span>
      </div>
    </div>
  );
}

// One provider's glanceable meters plus its usage popover.
function ProviderUsageCell({
  provider,
  now,
}: {
  provider: ProviderUsage;
  now: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title={`${provider.name} subscriptions & usage`}
          className={cn(
            'flex h-full items-center gap-1.5 px-3 transition-colors hover:text-foreground/75',
            open && 'text-foreground/75'
          )}
        >
          <span
            data-usage-generated-at={now || ''}
            className="uppercase tracking-wider text-foreground/35"
          >
            {provider.name}
          </span>
          <Meter label="5h" meter={provider.session} />
          <Meter label="wk" meter={provider.weekly} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="glass-surface z-[120] w-[320px] rounded-xl p-0 text-foreground animate-in fade-in-0 zoom-in-95"
        >
          <ProviderSubscriptionsContent provider={provider} now={now} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Cell({
  onClick,
  title,
  children,
}: {
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const cls = 'flex h-full items-center gap-1.5 px-3';
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cn(cls, 'transition-colors hover:text-foreground/75')}>
        {children}
      </button>
    );
  }
  return <div className={cls}>{children}</div>;
}

function Meter({ label, meter }: { label: string; meter?: ProviderUsageMeter }) {
  const pct = typeof meter?.percent === 'number' ? Math.max(0, Math.min(100, meter.percent)) : null;
  const tone =
    pct === null ? 'bg-white/20' : pct >= 90 ? 'bg-rose-400' : pct >= 70 ? 'bg-amber-400' : 'bg-foreground/60';
  return (
    <span className="flex items-center gap-1">
      <span className="uppercase tracking-wider text-foreground/35">{label}</span>
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-white/[0.08]">
        <span className={cn('absolute inset-y-0 left-0', tone)} style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="mono-data text-foreground/70">{pct === null ? '—' : `${pct.toFixed(0)}%`}</span>
    </span>
  );
}
