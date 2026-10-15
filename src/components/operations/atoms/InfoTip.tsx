import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { cn } from '../../../lib/utils';

// A small info affordance wrapping the shared Tooltip. Relies on a single
// TooltipProvider mounted at the host operations surface root.
export function InfoTip({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded text-foreground/35 transition-colors hover:text-foreground/70',
            className
          )}
        >
          <Info className="h-3 w-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem]">{label}</TooltipContent>
    </Tooltip>
  );
}
