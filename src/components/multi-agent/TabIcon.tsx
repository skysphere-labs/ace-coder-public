import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ScratchTab } from '../../runtime/scratch-tabs-registry';

export function TabIcon({
  tab,
  fallback: Fallback,
  isActive,
}: {
  tab: ScratchTab;
  fallback: LucideIcon;
  isActive: boolean;
}) {
  const src = tab.kind === 'browser' ? faviconFor(tab) : null;
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  const className = cn(
    'h-3.5 w-3.5 shrink-0 transition-opacity',
    isActive ? 'opacity-100' : 'opacity-70 group-hover:opacity-90'
  );

  if (src && brokenSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => setBrokenSrc(src)}
        className={cn(className, 'rounded-[2px] object-contain')}
      />
    );
  }
  return <Fallback className={className} />;
}

function faviconFor(tab: ScratchTab): string | null {
  if (tab.favicon) return tab.favicon;
  if (!tab.url) return null;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
      u.hostname
    )}&sz=32`;
  } catch {
    return null;
  }
}
