import { ChevronRight } from 'lucide-react';
import AgentLogo from '../../ProviderGlyph';
import type { AgentId } from '../../../lib/types';
import { LedgerRow } from './LedgerRow';
import { LiveDot } from './LiveDot';
import { MonoStat } from './MonoStat';

// One running agent — ember dot, provider glyph, task name, workspace · branch
// (mono), churn, chevron. Opens the task.
export function FleetRow({
  name,
  agent,
  workspace,
  branch,
  additions,
  deletions,
  onOpen,
}: {
  name: string;
  agent: AgentId;
  workspace: string;
  branch?: string | null;
  additions?: number | null;
  deletions?: number | null;
  onOpen: () => void;
}) {
  return (
    <LedgerRow onClick={onOpen}>
      <LiveDot />
      <AgentLogo agent={agent} className="h-4 w-4" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{name}</span>
      <span className="mono-data hidden min-w-0 max-w-[42%] truncate text-[11px] text-foreground/45 sm:inline">
        {workspace}
        {branch ? ` · ${branch}` : ''}
      </span>
      <MonoStat additions={additions} deletions={deletions} />
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/30" />
    </LedgerRow>
  );
}
