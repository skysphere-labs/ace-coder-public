import AgentLogo from '../../../ProviderGlyph';
import type { AgentId } from '../../../../lib/types';
import { cn } from '../../../../lib/utils';

// Agent identity chip: the provider glyph + an optional name. Wraps the shared
// ProviderGlyph so call sites stop re-picking sizes for the same mark.
export function AgentBadge({
  agent,
  name,
  className,
}: {
  agent: AgentId;
  name?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--m-text-tertiary)]',
        className
      )}
    >
      <AgentLogo agent={agent} className="h-3.5 w-3.5 shrink-0" />
      {name && <span className="truncate">{name}</span>}
    </span>
  );
}
