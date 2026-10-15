import { cn } from '../../../lib/utils';

// A tabular-mono +adds/−dels churn run. Renders nothing when there is no churn
// so empty rows stay clean.
export function MonoStat({
  additions,
  deletions,
  className,
}: {
  additions?: number | null;
  deletions?: number | null;
  className?: string;
}) {
  const add = additions ?? 0;
  const del = deletions ?? 0;
  if (add === 0 && del === 0) return null;
  return (
    <span className={cn('mono-data inline-flex shrink-0 items-center gap-1 text-[11px]', className)}>
      {add > 0 && <span className="text-emerald-400/80">+{add}</span>}
      {del > 0 && <span className="text-red-400/80">-{del}</span>}
    </span>
  );
}
