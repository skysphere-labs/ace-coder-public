import { cn } from '../../../lib/utils';

// Shared freshness chip — promoted from the inline FreshnessChip in BriefPanel.
// Colour per contract: fresh → emerald, stale (12–24h old) → amber, expired
// (>24h old) → rose, missing → zinc. emerald/rose/amber are reserved signal
// colours; this chip is one of the only sanctioned sites (the other being
// price deltas). 'expired' is accepted ahead of the backend union extension
// (fresh|stale|expired|missing).
export function IntelFreshnessChip({
  freshness,
  intelAsOf,
}: {
  freshness: 'fresh' | 'stale' | 'expired' | 'missing';
  intelAsOf: string | null;
}) {
  const label =
    freshness === 'fresh'
      ? 'fresh'
      : freshness === 'stale'
      ? '12–24h old'
      : freshness === 'expired'
      ? '>24h old'
      : 'missing';
  const asOf = intelAsOf
    ? new Date(intelAsOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        freshness === 'fresh'
          ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200'
          : freshness === 'stale'
          ? 'border-amber-500/30 bg-amber-500/[0.08] text-amber-200'
          : freshness === 'expired'
          ? 'border-rose-500/30 bg-rose-500/[0.08] text-rose-200'
          : 'border-zinc-500/30 bg-zinc-500/[0.08] text-zinc-300'
      )}
    >
      intel {label} · as-of {asOf}
    </span>
  );
}
