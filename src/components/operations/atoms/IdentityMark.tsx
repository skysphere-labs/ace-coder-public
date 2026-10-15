import { cn } from '../../../lib/utils';

// IdentityMark — deterministic avatar: 1–2 initials on a gradient disc whose
// colors derive from a stable hash of the name (same input → same colors,
// every render, every machine). No images, no network fetches — visual
// identity comes entirely from generated marks (visual-identity constraint).
// Agents pass `accentColor` (getAgentAccentColor) so their mark matches the
// accent used everywhere else in the app.

export type IdentityMarkSize = 'sm' | 'md';

// Six hue pairs, dark-glass friendly: saturated enough to anchor, muted
// enough to stay professional. Picked by hash, never by meaning — these are
// identity colors, not severity.
const HUE_PAIRS: Array<[string, string]> = [
  ['#0284c7', '#4f46e5'], // sky → indigo
  ['#7c3aed', '#c026d3'], // violet → fuchsia
  ['#059669', '#0d9488'], // emerald → teal
  ['#d97706', '#ea580c'], // amber → orange
  ['#e11d48', '#db2777'], // rose → pink
  ['#475569', '#334155'], // slate → slate
];

const SIZE_CLASSES: Record<IdentityMarkSize, string> = {
  sm: 'h-5 w-5 text-[9px]',
  md: 'h-7 w-7 text-[11px]',
};

// djb2 — tiny, stable, good-enough spread for 6 buckets.
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

export function IdentityMark({
  name,
  size = 'sm',
  accentColor,
  className,
}: {
  name: string;
  size?: IdentityMarkSize;
  // Override the hashed palette (e.g. agent accents via getAgentAccentColor).
  accentColor?: string;
  className?: string;
}) {
  const [from, to] = accentColor
    ? [accentColor, `color-mix(in srgb, ${accentColor} 65%, #0d1117)`]
    : HUE_PAIRS[hashString(name) % HUE_PAIRS.length];
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full',
        'font-semibold leading-none text-white/95 ring-1 ring-white/15',
        SIZE_CLASSES[size],
        className
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
