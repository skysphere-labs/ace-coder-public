import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

// IconTile — the Azure-portal-style visual anchor: a rounded tile with a soft
// tinted gradient holding one lucide glyph. Pure CSS, no images (visual-
// identity constraint: deterministic generated marks only). Tones are
// IDENTITY tints, not health — severity meaning stays with StatusPill /
// SeverityDot; violet is the one palette addition (GitHub / Intelligence).
export type IconTileTone = 'sky' | 'amber' | 'emerald' | 'violet' | 'rose' | 'neutral';
export type IconTileSize = 'sm' | 'md';

const TONE_CLASSES: Record<IconTileTone, string> = {
  sky: 'from-sky-500/15 to-sky-500/5 ring-sky-500/20 text-sky-200',
  amber: 'from-amber-500/15 to-amber-500/5 ring-amber-500/20 text-amber-200',
  emerald: 'from-emerald-500/15 to-emerald-500/5 ring-emerald-500/20 text-emerald-200',
  violet: 'from-violet-500/15 to-violet-500/5 ring-violet-500/20 text-violet-200',
  rose: 'from-rose-500/15 to-rose-500/5 ring-rose-500/20 text-rose-200',
  neutral: 'from-white/[0.08] to-white/[0.03] ring-white/[0.12] text-foreground/70',
};

const SIZE_CLASSES: Record<IconTileSize, { tile: string; icon: string }> = {
  sm: { tile: 'h-7 w-7', icon: 'h-3.5 w-3.5' },
  md: { tile: 'h-9 w-9', icon: 'h-4 w-4' },
};

export function IconTile({
  icon: Icon,
  tone = 'neutral',
  size = 'md',
  className,
}: {
  icon: LucideIcon;
  tone?: IconTileTone;
  size?: IconTileSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ring-1',
        'transition-shadow duration-150',
        SIZE_CLASSES[size].tile,
        TONE_CLASSES[tone],
        className
      )}
    >
      <Icon className={SIZE_CLASSES[size].icon} aria-hidden="true" />
    </span>
  );
}
