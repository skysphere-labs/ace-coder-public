import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { cn } from '../../../lib/utils';

// C2 jargon containment: THE one sanctioned way to show a machine identifier
// (UUID, SHA, branch, stream id) outside the EvidenceDrawer. Renders a masked
// mono token (`8f3e…2a4c`), full value in the tooltip, copies on click. Long
// IDs never spill into level-1 layouts again.

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function Identifier({
  value,
  label,
  className,
}: {
  value: string;
  // Optional human prefix shown before the masked token ("mission", "branch").
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the tooltip still exposes the full value.
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${label ? `${label} ` : ''}${value}`}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5',
            'text-xs text-foreground/70 transition-colors duration-150 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50',
            className
          )}
        >
          {label && <span className="font-medium">{label}</span>}
          <span className="truncate font-mono tabular-nums">{mask(value)}</span>
          {copied ? (
            <Check className="h-3 w-3 shrink-0 text-emerald-300" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3 shrink-0 text-foreground/40" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[24rem] break-all font-mono text-xs">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
