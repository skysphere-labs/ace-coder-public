import { cn } from '../../../lib/utils';
import { SEVERITY_DOT, SEVERITY_TEXT, type Severity } from '../severity';

// A solid severity dot. Color comes ONLY from severity.ts. The `black` halo is
// carried by the optional ring so even the dot is never color-only — callers
// always pair it with a glyph + label elsewhere in the surface.
export function SeverityDot({
  severity,
  size = 'sm',
  className,
}: {
  severity: Severity;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const sizeClass = size === 'xs' ? 'h-1.5 w-1.5' : size === 'md' ? 'h-3 w-3' : 'h-2 w-2';
  return (
    <span
      aria-label={SEVERITY_TEXT[severity]}
      title={SEVERITY_TEXT[severity]}
      className={cn(
        'inline-block shrink-0 rounded-full',
        sizeClass,
        SEVERITY_DOT[severity],
        severity === 'black' && 'ring-2 ring-rose-500/40',
        className
      )}
    />
  );
}
