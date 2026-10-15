import { cn } from '../../../lib/utils';
import { CountBadge } from '../atoms/CountBadge';
import { Eyebrow } from '../atoms/Eyebrow';

export type JumpEntry = { key: string; label: string; count: number; newCount: number };
export type JumpGroup = { eyebrow: string; entries: JumpEntry[] };

// The badge swaps meaning under the New filter (total → new count), so it gets
// a sky tint + tooltip instead of silently changing what the number means.
function entryTitle(entry: JumpEntry, newOnly: boolean): string {
  return newOnly ? `${entry.newCount} new items` : `${entry.count} items`;
}

const NEW_BADGE_CLASS = 'border-sky-500/25 bg-sky-500/[0.15] text-sky-200';

// The scannability spine. Desktop: a sticky vertical table-of-contents with
// per-section count badges + an active-anchor highlight (sky text + 2px sky
// left bar). Below lg the parent renders the horizontal chip-rail variant
// instead (same anchors). sky is the active accent + the new-dot; everything
// else is greyscale.
export function SectionJumpNav({
  groups,
  activeKey,
  newOnly,
}: {
  groups: JumpGroup[];
  activeKey: string | null;
  newOnly: boolean;
}) {
  return (
    <nav
      aria-label="Vector Ops sections"
      className="sticky top-0 hidden w-52 shrink-0 self-start lg:block"
    >
      <div className="flex flex-col gap-0.5 py-1">
        {groups.map((group) => (
          <div key={group.eyebrow}>
            <Eyebrow className="block px-2 pt-2 pb-0.5">{group.eyebrow}</Eyebrow>
            {group.entries.map((entry) => {
              const active = entry.key === activeKey;
              const badgeValue = newOnly ? entry.newCount : entry.count;
              return (
                <a
                  key={entry.key}
                  href={`#vo-${entry.key}`}
                  title={entryTitle(entry, newOnly)}
                  className={cn(
                    'group flex items-center justify-between gap-2 rounded-md border-l-2 px-2 py-1 text-[13px] transition-colors',
                    active
                      ? 'border-sky-400 bg-sky-500/[0.12] text-sky-200'
                      : 'border-transparent text-foreground/70 hover:bg-white/[0.03] hover:text-foreground'
                  )}
                >
                  <span className="truncate">{entry.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {newOnly && entry.newCount > 0 && (
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
                    )}
                    <CountBadge count={badgeValue} className={cn(newOnly && NEW_BADGE_CLASS)} />
                  </span>
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

// Horizontal chip-rail anchor variant for below lg so narrow widths stay
// navigable.
export function SectionJumpRail({
  groups,
  activeKey,
  newOnly,
}: {
  groups: JumpGroup[];
  activeKey: string | null;
  newOnly: boolean;
}) {
  const entries = groups.flatMap((g) => g.entries);
  return (
    <div className="flex gap-1.5 overflow-x-auto lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {entries.map((entry) => {
        const active = entry.key === activeKey;
        const badgeValue = newOnly ? entry.newCount : entry.count;
        return (
          <a
            key={entry.key}
            href={`#vo-${entry.key}`}
            title={entryTitle(entry, newOnly)}
            className={cn(
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors',
              active
                ? 'border-sky-500/30 bg-sky-500/[0.12] text-sky-200'
                : 'border-white/[0.06] bg-white/[0.02] text-foreground/70 hover:text-foreground'
            )}
          >
            <span>{entry.label}</span>
            {newOnly && entry.newCount > 0 && (
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
            )}
            <CountBadge count={badgeValue} className={cn(newOnly && NEW_BADGE_CLASS)} />
          </a>
        );
      })}
    </div>
  );
}
