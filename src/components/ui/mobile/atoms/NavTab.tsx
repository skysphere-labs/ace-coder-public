import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../../lib/utils';

// One dock tab (Indigo Ledger): a bare glyph — no button chrome, no label,
// no secondary indicators. Exactly ONE thing marks the active section: a
// fixed-size SOLID accent disc (shared `layoutId="mobile-tab-pill"`) with
// the glyph knocked out in ink, gliding between tabs in lock-step with the
// swipe pager. Solid, not tonal — on obsidian a translucent wash reads as a
// smudge; the filled disc reads as the one powered-on element. Fixed-size
// matters too: a stretched capsule is a blob, a 40px circle is machined.
// The section name lives in aria-label and in the header title above.
export function NavTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'mobile-press relative flex min-h-[52px] min-w-0 flex-1 items-center justify-center rounded-full landscape:min-h-[44px]',
        active
          ? 'text-[var(--m-accent-ink)]'
          : 'text-[var(--m-text-tertiary)] active:text-[var(--m-text-secondary)]'
      )}
    >
      {/* inset-0 + m-auto centers without transforms — framer's layout
          animation owns `transform`, so translate-centering would be
          clobbered mid-glide. */}
      {active && (
        <motion.span
          layoutId="mobile-tab-pill"
          className="absolute inset-0 m-auto h-10 w-10 rounded-full bg-[var(--m-accent)] shadow-[var(--m-accent-raise)]"
          transition={{ type: 'spring', stiffness: 460, damping: 36 }}
        />
      )}
      <Icon
        className="relative z-[1] h-[21px] w-[21px] shrink-0"
        strokeWidth={active ? 2 : 1.7}
      />
    </button>
  );
}
