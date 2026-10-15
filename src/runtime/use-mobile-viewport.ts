import { useEffect, useState } from 'react';

// Any phone, either orientation. The second clause catches landscape phones
// (iPhone 15 Pro landscape is 852×393) which would otherwise fail the raw
// `max-width: 768px` test and fall through to the desktop shell. Short
// viewport + touch pointer is a reliable "phone in landscape" fingerprint
// without swallowing iPad landscape (1024×768) into the mobile path.
export const MOBILE_MEDIA_QUERY =
  '(max-width: 768px), (pointer: coarse) and (max-height: 500px)';

// Soft-keyboard inset in px. Mobile browsers overlay the keyboard on the
// layout viewport — 100dvh does NOT shrink — so a bottom-anchored composer
// ends up underneath it and the browser "fixes" that by scrolling the page,
// leaving a dead gap between the content and the keyboard. Tracking
// visualViewport lets the shell shrink to the truly visible area so the
// terminal and composer pack tightly above the keyboard instead.
export function useMobileKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const raw = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop)
      );
      // Below ~32px is URL-bar/safe-area jitter, not a keyboard.
      const keyboard = raw > 32 ? raw : 0;
      setInset(keyboard);
      // Defeat the browser's scroll-focused-input-into-view: with the shell
      // shrunk to the visible area, any residual page scroll only re-creates
      // the gap this hook exists to remove.
      if (keyboard > 0 && (window.scrollY !== 0 || viewport.offsetTop !== 0)) {
        window.scrollTo(0, 0);
      }
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('focusin', update);
    window.addEventListener('focusout', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('focusin', update);
      window.removeEventListener('focusout', update);
    };
  }, []);
  return inset;
}

export function useIsMobileViewport(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  });
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

// Non-hook viewport check for imperative call sites (event handlers, store).
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

// The shell's landing view: the mobile Home tab is retired in favour of the
// Today dashboard, so phones land on 'today' while desktop keeps 'home'. Used
// by the dual-shell back/cancel/finish handlers so neither shell regresses.
export function landingView(): 'today' | 'home' {
  return isMobileViewport() ? 'today' : 'home';
}
