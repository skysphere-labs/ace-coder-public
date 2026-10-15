import { useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { type ProviderUsageMeter, type ProviderUsageReport } from '../lib/ace-api';
import { AGENTS, type AgentId } from '../lib/types';
import { useApp } from '../store';
import { useActiveDisplayAgent } from '../runtime/active-agent-registry';
import { useProviderUsage } from '../runtime/usage-registry';
import { ProviderUsagePopoverContent } from './ProviderUsagePopover';
import { cn } from '../lib/utils';

export function ProviderUsagePill() {
  const { activeTask } = useApp();
  const taskId = activeTask?.id ?? null;
  const activeDisplayAgent =
    (useActiveDisplayAgent(taskId) as AgentId | null) ?? (activeTask?.agent ?? null);

  // Shared event-driven usage subscription (one store across the app).
  const { report, error } = useProviderUsage();

  const displayAgent: AgentId | null =
    activeDisplayAgent ??
    (report?.providers[0]?.id as AgentId | undefined) ??
    (AGENTS[0]?.id as AgentId | undefined) ??
    null;

  if (!displayAgent) return null;

  return <AgentPill agent={displayAgent} report={report} error={error} />;
}

function AgentPill({
  agent,
  report,
  error,
}: {
  agent: AgentId;
  report: ProviderUsageReport | null;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const provider = report?.providers.find((p) => p.id === agent) ?? null;
  const session = provider?.session;
  const weekly = provider?.weekly;
  const meta = AGENTS.find((a) => a.id === agent);
  const agentName = meta?.name ?? agent;
  const agentColor = meta?.color ?? '#888';

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-usage-generated-at={report?.generatedAt ?? ''}
          className={cn(
            'group inline-flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.03] py-1 pl-2.5 pr-3 text-[11px] text-muted-foreground transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] hover:text-foreground',
            open && 'border-white/[0.14] bg-white/[0.06] text-foreground'
          )}
          title={`${agentName} usage`}
        >
          <span className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: agentColor, boxShadow: `0 0 6px ${agentColor}66` }}
            />
            <span className="font-medium text-foreground/85">{agentName}</span>
          </span>
          <MiniMeter label="5h" meter={session} />
          <MiniMeter label="wk" meter={weekly} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="glass-surface z-[120] w-[320px] rounded-xl p-0 text-foreground animate-in fade-in-0 zoom-in-95"
        >
          <ProviderUsagePopoverContent report={report} error={error} pinned={agent} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MiniMeter({
  label,
  meter,
}: {
  label: string;
  meter: ProviderUsageMeter | undefined;
}) {
  const pct =
    typeof meter?.percent === 'number' ? Math.max(0, Math.min(100, meter.percent)) : null;
  const tone =
    pct === null
      ? 'bg-white/20'
      : pct >= 90
        ? 'bg-rose-400'
        : pct >= 70
          ? 'bg-amber-400'
          : 'bg-foreground/70';
  return (
    <span className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground/65">
        {label}
      </span>
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-white/[0.08]">
        <span
          className={cn('absolute inset-y-0 left-0 transition-[width] duration-500', tone)}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className="tabular-nums text-foreground/75">
        {pct === null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
      </span>
    </span>
  );
}
