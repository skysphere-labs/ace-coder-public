import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../runtime/haptics';
import {
  MOBILE_ACCENTS,
  setMobileAccent,
  useMobileAccent,
} from '../../runtime/mobile-accent-registry';
import { TintControls } from '../TintPicker';
import { ActionSheet } from './ActionSheet';

// Appearance, one thumb-reach from the smart bar: swap the theme accent (the
// --m-accent* var set every mobile surface derives from) and fine-tune the
// glass tint behind the floating chrome. Opened from the composers'
// smart-bar Theme pill and from the + sheet, so restyling never requires a
// trip to Settings.
export function MobileAppearanceSheet({ onClose }: { onClose: () => void }) {
  const accentId = useMobileAccent();
  return (
    <ActionSheet title="Appearance" onClose={onClose}>
      <div className="px-2 pb-2 pt-0.5">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-foreground">Accent</span>
          <span className="text-[11px] text-[var(--m-text-tertiary)]">
            {MOBILE_ACCENTS.find((a) => a.id === accentId)?.label}
          </span>
        </div>
        {/* One quiet row of color discs — the color IS the label; the active
            name reads out in the row header above. 44px hit targets around
            28px visuals keep the row airy without shrinking the touch area. */}
        <div className="flex items-center justify-between px-1">
          {MOBILE_ACCENTS.map((a) => {
            const active = a.id === accentId;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  haptic('success');
                  setMobileAccent(a.id);
                }}
                aria-pressed={active}
                aria-label={a.label}
                className="mobile-press flex h-11 w-11 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative flex h-7 w-7 items-center justify-center rounded-full transition-shadow',
                    active
                      ? 'shadow-[0_0_0_2px_var(--m-bg),0_0_0_3.5px_currentColor]'
                      : 'shadow-none'
                  )}
                  style={{
                    color: `hsl(${a.hue} ${a.sat}% ${a.light}%)`,
                    background: `radial-gradient(circle at 32% 30%, hsl(${a.hue} ${a.sat}% ${Math.min(90, a.light + 14)}%), hsl(${a.hue} ${a.sat}% ${Math.max(22, a.light - 16)}%))`,
                  }}
                >
                  {active && <Check className="h-3.5 w-3.5 text-white/95" strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 rounded-xl border border-[var(--m-hairline)] bg-[var(--m-surface)] p-3">
          <TintControls />
        </div>
      </div>
    </ActionSheet>
  );
}
