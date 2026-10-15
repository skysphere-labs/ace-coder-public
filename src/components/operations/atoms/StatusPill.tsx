import { Badge } from '../../ui/badge';
import { cn } from '../../../lib/utils';
import {
  SEVERITY_BADGE,
  SEVERITY_BORDER,
  SEVERITY_ICON,
  SEVERITY_TEXT,
  type Severity,
} from '../severity';

// StatusPill wraps the shared Badge atom and always pairs color + glyph + label
// (colorblind-safe, contracts §1). `black` reuses the muted Badge variant and
// layers the reserved rose halo from SEVERITY_BORDER. `size` defaults to 'sm'
// (Badge's own text-xs); 'lg' steps up to 13px for headline placements.
export function StatusPill({
  severity,
  label,
  size = 'sm',
  className,
}: {
  severity: Severity;
  label?: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const Icon = SEVERITY_ICON[severity];
  const text = label ?? SEVERITY_TEXT[severity];
  return (
    <Badge
      variant={SEVERITY_BADGE[severity]}
      className={cn(
        'gap-1 tabular-nums',
        size === 'lg' && 'px-2.5 py-1 text-[13px]',
        severity === 'black' && SEVERITY_BORDER.black,
        className
      )}
    >
      <Icon className={size === 'lg' ? 'h-3.5 w-3.5' : 'h-3 w-3'} aria-hidden="true" />
      <span>{text}</span>
    </Badge>
  );
}
