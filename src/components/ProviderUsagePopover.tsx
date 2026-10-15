import { Gauge } from 'lucide-react';
import type {
  ProviderUsage,
  ProviderUsageMeter,
  ProviderUsageReport,
} from '../lib/ace-api';
import { AGENTS } from '../lib/types';
import { Spinner } from './ui/spinner';

// Popover body shared by every usage trigger (task-bar pill, LedgerStrip
// meters). `pinned` floats that provider to the top.
export function ProviderUsagePopoverContent({
  report,
  error,
  pinned = null,
}: {
  report: ProviderUsageReport | null;
  error: string | null;
  pinned?: string | null;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
            Provider Usage
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {report?.enabled === false ? 'Collection is off' : 'Read locally · enabled in this profile'}
          </div>
        </div>
        {!report && !error && <Spinner className="h-3 w-3 text-muted-foreground" />}
      </div>

      <div className="max-h-[360px] overflow-y-auto p-2">
        {error && <PopoverError message={error} />}
        {!error && report?.enabled === false && <PopoverDisabled />}
        {!error && report && report.enabled !== false && report.providers.length === 0 && <PopoverEmpty />}
        {!error && report && report.enabled !== false &&
          sortProviders(report.providers, pinned).map((p) => (
            <ProviderRow key={p.id} provider={p} now={report.generatedAt} />
          ))}
      </div>
    </>
  );
}

function sortProviders(providers: ProviderUsage[], pinned: string | null) {
  if (!pinned) return providers;
  const idx = providers.findIndex((p) => p.id === pinned);
  if (idx <= 0) return providers;
  const next = [...providers];
  const [head] = next.splice(idx, 1);
  next.unshift(head);
  return next;
}

// Single-provider popover body: the meters for the machine's CLI login.
export function ProviderSubscriptionsContent({
  provider,
  now,
}: {
  provider: ProviderUsage;
  now: number;
}) {
  return (
    <div className="p-2">
      <ProviderRow provider={provider} now={now} />
    </div>
  );
}

export function ProviderRow({
  provider,
  now,
}: {
  provider: ProviderUsage;
  now: number;
}) {
  const agent = AGENTS.find((a) => a.id === provider.id);
  const color = agent?.color ?? '#888';
  const lastActivity = provider.lastActivityMs
    ? formatRelative(provider.lastActivityMs, now)
    : null;

  return (
    <div className="rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}66` }}
        />
        <span className="flex-1 truncate text-[13px] font-medium text-foreground">
          {provider.name}
        </span>
        {provider.plan && (
          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            {provider.plan}
          </span>
        )}
      </div>
      {provider.accountLabel && (
        <div className="-mt-1.5 mb-2 truncate pl-4 text-[10px] text-muted-foreground/70">
          {provider.accountLabel}
        </div>
      )}

      {provider.state === 'unknown' ? (
        <div className="text-[10px] leading-snug text-muted-foreground">
          No live usage data yet — run a {provider.name} session and the official rate limits
          will appear here.
        </div>
      ) : (
        <>
          <Meter label="5h session" meter={provider.session} now={now} />
          <div className="h-1.5" />
          <Meter label="Weekly" meter={provider.weekly} now={now} />

          {provider.state === 'stale' && provider.asOf ? (
            <div className="mt-2 text-[10px] text-amber-300/80">
              As of {formatRelative(provider.asOf, now)} — updates while a session is running
            </div>
          ) : (
            lastActivity && (
              <div className="mt-2 text-[10px] text-muted-foreground/70">
                Last activity {lastActivity}
              </div>
            )
          )}
        </>
      )}

    </div>
  );
}

function Meter({ label, meter, now }: { label: string; meter: ProviderUsageMeter; now: number }) {
  const pct =
    typeof meter.percent === 'number' ? Math.max(0, Math.min(100, meter.percent)) : null;
  const tone =
    pct === null
      ? 'bg-white/20'
      : pct >= 90
        ? 'bg-rose-400'
        : pct >= 70
          ? 'bg-amber-400'
          : 'bg-foreground/70';
  const reset = meter.resetsAt ? formatCountdown(meter.resetsAt - now) : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-foreground/85">
          {pct === null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
        </span>
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`absolute inset-y-0 left-0 ${tone} transition-[width] duration-500`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      {reset && (
        <div className="mt-1 text-right text-[10px] text-muted-foreground/70">
          resets in {reset}
        </div>
      )}
    </div>
  );
}

export function PopoverEmpty() {
  return (
    <div className="px-4 py-8 text-center">
      <Gauge className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
      <div className="text-[12px] text-foreground/80">No usage detected</div>
      <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
        Use Claude Code or Codex CLI on this machine and your usage will appear here.
      </div>
    </div>
  );
}

function PopoverDisabled() {
  return (
    <div className="px-4 py-6 text-center">
      <Gauge className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
      <div className="text-[12px] text-foreground/80">Usage collection is disabled</div>
      <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
        Agent login still works. To enable local account and usage reads, follow
        the setup guide in docs/operations/provider-usage.md, then restart ACE CODER.
      </div>
    </div>
  );
}

export function PopoverError({ message }: { message: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <div className="text-[12px] text-foreground/80">Couldn't read usage</div>
      <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{message}</div>
    </div>
  );
}

function formatCountdown(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
