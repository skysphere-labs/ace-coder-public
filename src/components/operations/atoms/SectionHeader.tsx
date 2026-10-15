import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { IconTile, type IconTileTone } from './IconTile';

// Header row for an organism panel: optional icon + title, optional severity
// pill (or any node) on the leading edge, and optional trailing actions/meta.
// The icon renders inside an IconTile — `tone` is the panel's IDENTITY tint
// (group color), never health; severity stays with StatusPill / SeverityDot.
export function SectionHeader({
  title,
  icon,
  tone = 'neutral',
  leading,
  actions,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  tone?: IconTileTone;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && <IconTile icon={icon} size="sm" tone={tone} />}
        <h3 className="truncate text-[13px] font-semibold text-foreground">{title}</h3>
        {leading}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
