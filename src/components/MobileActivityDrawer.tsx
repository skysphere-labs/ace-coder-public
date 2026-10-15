import { motion } from 'framer-motion';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useBodyScrollLock } from '../runtime/use-body-scroll-lock';
import { SWIPE_MIN_PX, SWIPE_MIN_VELOCITY } from '../runtime/use-swipe';
import { ActivityPane } from './ActivityPane';
import { SheetHeader } from './ui/mobile';

export function MobileActivityDrawer({ onClose }: { onClose: () => void }) {
  useMobileBackHandler(true, onClose);
  useBodyScrollLock();

  return (
    <>
      {/* Backdrop — taps close the drawer; the slide-in motion below stays on
          top of this layer. Without a backdrop the user could only escape via
          the back chevron in the header. */}
      <motion.div
        key="activity-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        onClick={onClose}
        className="fixed inset-0 z-[79] bg-black/35"
      />
      <motion.div
        // Drag-right-to-dismiss: dragDirectionLock gives angle-lock for free
        // (vertical scroll inside the pane wins), and releasing past the
        // threshold runs onClose → the SAME exit spring plays in reverse.
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0, right: 0.9 }}
        onDragEnd={(_, info) => {
          if (info.offset.x > SWIPE_MIN_PX || info.velocity.x > SWIPE_MIN_VELOCITY * 1000) onClose();
        }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
        className="mobile-drawer-surface inset-0 z-[80] flex flex-col text-foreground shadow-[-12px_0_40px_hsl(0_0%_0%/0.45)]"
        style={{
          position: 'fixed',
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <SheetHeader title="Activity" onBack={onClose} />

        <div className="min-h-0 flex-1 overflow-hidden">
          <ActivityPane />
        </div>
      </motion.div>
    </>
  );
}
