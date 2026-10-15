import type { ReactNode } from 'react';
import { cn } from '../../../../lib/utils';

// A rounded square that holds one glyph — the visual anchor inside list rows and
// cards. Token-driven surface/hairline (no raw translucent-white at call sites).
// `tone='accent'` is the amber-quiet variant reserved for the single primary
// action and the empty-state glyph; the ops layer's IconTile is its
// severity-tinted cousin.
export type IconWellSize = 'sm' | 'md' | 'lg';
export type IconWellTone = 'default' | 'accent';

const SIZES: Record<IconWellSize, string> = {
  sm: 'h-8 w-8 rounded-lg',
  md: 'h-10 w-10 rounded-xl',
  lg: 'h-14 w-14 rounded-2xl',
};

// Soft Warm Depth: the well is a small raised chip (surface step + top
// edge-light + a faint warm cast), so it reads as a tactile object sitting on
// the card rather than a flat tinted square. The accent variant keeps the amber
// well but adds the same top edge-light so it matches the raised language.
const TONES: Record<IconWellTone, string> = {
  default:
    'border border-[var(--m-hairline)] bg-[var(--m-surface-strong)] text-[var(--m-text-secondary)] shadow-[inset_0_1px_0_var(--m-edge-light),0_1px_2px_hsl(30_12%_1%/0.4)]',
  accent:
    'border border-transparent bg-[var(--m-accent-quiet)] text-[var(--m-accent)] shadow-[inset_0_1px_0_hsl(45_100%_80%/0.22),0_1px_2px_hsl(30_12%_1%/0.4)]',
};

export function IconWell({
  children,
  size = 'md',
  tone = 'default',
  className,
}: {
  children: ReactNode;
  size?: IconWellSize;
  tone?: IconWellTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center', SIZES[size], TONES[tone], className)}
    >
      {children}
    </span>
  );
}
