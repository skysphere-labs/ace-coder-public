import { GitPullRequest } from 'lucide-react';
import { cn } from '../../../../lib/utils';

// A compact `#123` pull-request marker, colored by state, in the tabular
// `.mono-data` voice. One home for the PR status→color mapping that was inlined
// on workspace/task rows. Merged uses a muted lilac so it never competes with
// the amber "live" accent.
const TONE: Record<string, string> = {
  open: 'text-[var(--m-add)]',
  merged: 'text-[var(--m-pr-merged)]',
  closed: 'text-[var(--m-del)]',
  draft: 'text-[var(--m-text-tertiary)]',
};

export function PrTag({
  number,
  status,
  className,
}: {
  number: number;
  status?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'mono-data flex items-center gap-1 text-[12.5px] font-medium',
        TONE[status ?? 'open'] ?? 'text-[var(--m-text-secondary)]',
        className
      )}
    >
      <GitPullRequest className="h-3 w-3" />#{number}
    </span>
  );
}
