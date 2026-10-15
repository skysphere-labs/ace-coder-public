import { ChevronRight, GitBranch, MessageSquare } from 'lucide-react';
import { formatRelativeTime } from '../../../lib/utils';
import { LedgerRow } from './LedgerRow';
import { MonoStat } from './MonoStat';

// A recently-touched task/thread — type glyph, name, workspace · branch (mono),
// relative time, churn, chevron. Opens the task.
export function RecentRow({
  kind,
  name,
  workspace,
  branch,
  updatedAt,
  additions,
  deletions,
  onOpen,
}: {
  kind: 'task' | 'thread';
  name: string;
  workspace: string;
  branch?: string | null;
  updatedAt?: string;
  additions?: number | null;
  deletions?: number | null;
  onOpen: () => void;
}) {
  const compact = formatRelativeTime(updatedAt, true);
  return (
    <LedgerRow onClick={onOpen}>
      {kind === 'task' ? (
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-emerald-300/70" />
      ) : (
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">{name}</span>
      <span className="mono-data hidden min-w-0 max-w-[42%] truncate text-[11px] text-foreground/45 sm:inline">
        {workspace}
        {branch ? ` · ${branch}` : ''}
      </span>
      {compact && <span className="mono-data shrink-0 text-[11px] text-foreground/40">{compact}</span>}
      <MonoStat additions={additions} deletions={deletions} />
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/30" />
    </LedgerRow>
  );
}
