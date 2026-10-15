import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentId } from '../../../lib/types';
import { Button } from '../button';

// One honest "next move" for a project — the item text plus a [Start agent ▾]
// popover that spawns 1–3 agents against it. Presentational: the caller passes
// the launchable agent list and does the actual createWorkspaceTask + openTask
// in onStart. Nothing here invents work — the row only renders items the deck
// derived from real run-ledger / todo state.
export function NextMoveRow({
  text,
  agents,
  onStart,
}: {
  text: string;
  agents: Array<{ id: AgentId; name: string }>;
  onStart: (agent: AgentId, count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // '' means "follow the catalog default" — the effective agent is derived so
  // the selection stays valid as the catalog resolves, without state syncing.
  const [chosenAgent, setChosenAgent] = useState<AgentId | ''>('');
  const [count, setCount] = useState(1);
  const ref = useRef<HTMLDivElement>(null);

  const agent: AgentId | '' = chosenAgent || agents[0]?.id || '';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const canStart = Boolean(agent) && agents.length > 0;

  return (
    <div className="ledger-row flex items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">{text}</span>
      <div className="relative shrink-0" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={agents.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[11px] text-foreground/70 transition-colors hover:border-white/[0.12] hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Start agent
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
        {open && (
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-white/[0.08] bg-[hsl(var(--ace-surface))] p-2.5 shadow-raise">
            <label className="mb-1 block text-[10.5px] uppercase tracking-wide text-foreground/40">
              Agent
            </label>
            <select
              value={agent}
              onChange={(e) => setChosenAgent(e.target.value as AgentId)}
              className="mb-2 w-full rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[12px] text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <label className="mb-1 block text-[10.5px] uppercase tracking-wide text-foreground/40">
              Count
            </label>
            <div className="mb-2.5 flex gap-1">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={
                    'mono-data flex-1 rounded-md border px-2 py-1 text-[12px] transition-colors ' +
                    (count === n
                      ? 'border-[hsl(var(--ace-accent)/0.6)] text-[hsl(var(--ace-accent))]'
                      : 'border-white/[0.06] text-foreground/55 hover:border-white/[0.12]')
                  }
                >
                  {n}
                </button>
              ))}
            </div>
            <Button
              variant="accent"
              size="sm"
              className="w-full"
              disabled={!canStart}
              onClick={() => {
                if (!canStart) return;
                onStart(agent as AgentId, count);
                setOpen(false);
              }}
            >
              Start {count > 1 ? `${count} agents` : 'agent'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
