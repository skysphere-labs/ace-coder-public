import { useEffect } from 'react';

// Refcounted body scroll lock so multiple sheets/drawers can coexist without
// fighting over document.body.style.overflow. Restores the pre-lock value when
// the last consumer unlocks.
let lockCount = 0;
let priorOverflow = '';

function lock() {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) {
    priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function unlock() {
  if (typeof document === 'undefined') return;
  if (lockCount <= 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = priorOverflow;
  }
}

export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    lock();
    return () => unlock();
  }, [active]);
}
