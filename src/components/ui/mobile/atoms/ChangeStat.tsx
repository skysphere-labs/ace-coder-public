import { cn } from '../../../../lib/utils';

// The `+adds / -dels` pair shown on task and diff rows. Slate Ledger: rendered
// in the tabular `.mono-data` voice with desaturated add/del tokens so churn
// reads like a build-log column and never out-shouts the amber accent. Renders
// nothing when there is no churn, so rows stay clean.
export function ChangeStat({
  additions,
  deletions,
  className,
}: {
  additions?: number;
  deletions?: number;
  className?: string;
}) {
  if (!additions && !deletions) return null;
  return (
    <span className={cn('mono-data flex items-center gap-1.5 text-[12.5px]', className)}>
      {additions ? <span className="text-[var(--m-add)]">+{additions}</span> : null}
      {deletions ? <span className="text-[var(--m-del)]">-{deletions}</span> : null}
    </span>
  );
}
