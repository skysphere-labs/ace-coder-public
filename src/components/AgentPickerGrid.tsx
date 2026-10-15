import { useMemo } from 'react';
import { RotateCcw, Star } from 'lucide-react';
import { cn } from '../lib/utils';
import { agentMeta } from '../lib/agent-style';
import AgentLogo from './ProviderGlyph';
import {
  useAgentCatalog,
  useStarredAgents,
  toggleStarredAgent,
  type AgentCatalogScope,
} from '../runtime/agent-registry';
import type { AgentCatalogEntry } from '../lib/types';

interface AgentPickerGridProps {
  onSelect: (agent: AgentCatalogEntry) => void;
  disabled?: boolean;
  hint?: string;
  className?: string;
  scope?: AgentCatalogScope;
  onMissingSelect?: (agent: AgentCatalogEntry) => void;
  onReinstall?: (agent: AgentCatalogEntry) => void;
}

export function AgentPickerGrid({
  onSelect,
  disabled = false,
  hint,
  className,
  scope,
  onMissingSelect,
  onReinstall,
}: AgentPickerGridProps) {
  const catalog = useAgentCatalog(scope);
  const starred = useStarredAgents();

  const orderedCatalog = useMemo(() => {
    if (starred.length === 0) return catalog;
    const starSet = new Set<string>(starred);
    const byId = new Map<string, AgentCatalogEntry>(
      catalog.map((a) => [a.id, a])
    );
    const head: AgentCatalogEntry[] = [];
    for (const id of starred) {
      const entry = byId.get(id);
      if (entry) head.push(entry);
    }
    const tail = catalog.filter((a) => !starSet.has(a.id));
    return [...head, ...tail];
  }, [catalog, starred]);

  const starredSet = useMemo(() => new Set(starred), [starred]);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {hint && (
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {orderedCatalog.map((agent) => {
          const label = agentMeta[agent.id]?.label ?? agent.name;
          const unavailable = !agent.launchable;
          const cardDisabled = disabled || (unavailable && !onMissingSelect);
          const handleClick = () => {
            if (unavailable) onMissingSelect?.(agent);
            else onSelect(agent);
          };
          const showReinstall = !unavailable && !!onReinstall && !disabled;
          const isStarred = starredSet.has(agent.id);
          return (
            <div key={agent.id} className="group relative h-full">
              <button
                type="button"
                disabled={cardDisabled}
                onClick={handleClick}
                className={cn(
                  'flex h-full w-full flex-col items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 text-left transition-all',
                  'hover:-translate-y-[1px] hover:border-white/20 hover:bg-white/[0.06] hover:shadow-[0_10px_30px_hsl(0_0%_0%/0.35)]',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.03] disabled:hover:shadow-none',
                  unavailable && 'opacity-60',
                  isStarred && 'border-amber-400/30 bg-amber-400/[0.04]'
                )}
              >
                <AgentLogo agent={agent.id} className="h-8 w-8 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {label}
                  </div>
                  {unavailable && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {agent.status === 'missing'
                        ? onMissingSelect
                          ? 'Click to install'
                          : 'Not installed'
                        : 'Unavailable'}
                    </div>
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleStarredAgent(agent.id);
                }}
                className={cn(
                  'absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md transition-all focus-visible:opacity-100',
                  isStarred
                    ? 'text-amber-300 opacity-100'
                    : 'text-muted-foreground opacity-0 hover:text-amber-300 group-hover:opacity-100'
                )}
                title={isStarred ? `Unstar ${label}` : `Star ${label}`}
                aria-label={isStarred ? `Unstar ${label}` : `Star ${label}`}
                aria-pressed={isStarred}
              >
                <Star
                  className={cn('h-3.5 w-3.5', isStarred && 'fill-current')}
                />
              </button>
              {showReinstall && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReinstall(agent);
                  }}
                  className="absolute bottom-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all focus-visible:opacity-100 hover:text-sky-300 group-hover:opacity-100"
                  title={`Reinstall ${label}`}
                  aria-label={`Reinstall ${label}`}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
