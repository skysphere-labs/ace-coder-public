import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Palette } from 'lucide-react';
import { haptic } from '../../../runtime/haptics';
import { useIsMobileViewport } from '../../../runtime/use-mobile-viewport';
import { MobileAppearanceSheet } from '../../mobile-composer/MobileAppearanceSheet';
import { PillButton } from './composer-pills';

// The smart-bar appearance entry point (mobile only — desktop reaches the
// TintPicker from the NavRail). Renders null on desktop so every composer can
// include it unconditionally in its pill row.
export function AppearancePill() {
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  if (!isMobile) return null;
  return (
    <>
      <PillButton
        icon={<Palette className="h-3 w-3" />}
        label="Theme"
        title="Appearance"
        onClick={() => {
          haptic('tick');
          setOpen(true);
        }}
      />
      <AnimatePresence>
        {open && <MobileAppearanceSheet onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}
