import { Clock } from 'lucide-react';
import { cn, formatRelativeTime } from '../../../lib/utils';

export type Freshness = 'live' | 'fresh' | 'stale' | 'expired' | null;

// Relative-time label for a probe/snapshot timestamp. `live` renders a green
// LIVE marker; `stale`/`expired` tint amber so the user never trusts a stale
// snapshot as current state (contracts §2 isLive/freshness semantics).
export function FreshnessLabel({
  timestamp,
  freshness,
  prefix,
  className,
}: {
  timestamp?: string | null;
  freshness?: Freshness;
  prefix?: string;
  className?: string;
}) {
  const isLive = freshness === 'live';
  const isStale = freshness === 'stale' || freshness === 'expired';
  const rel = timestamp ? formatRelativeTime(timestamp) : '';
  const text = isLive ? 'live' : rel || 'unknown';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        isLive ? 'text-emerald-400' : isStale ? 'text-amber-400' : 'text-foreground/60',
        className
      )}
      title={timestamp ?? undefined}
    >
      {isLive ? (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-live-pulse"
          aria-hidden="true"
        />
      ) : (
        <Clock className="h-3 w-3" aria-hidden="true" />
      )}
      {prefix ? `${prefix} ` : ''}
      {text}
      {isStale ? ' (stale)' : ''}
    </span>
  );
}
