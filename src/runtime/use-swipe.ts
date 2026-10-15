import { useEffect, useRef, type RefObject } from 'react';
import { isTextEditingSurface } from '../lib/shortcut-helpers';

// Reusable mobile swipe gesture. Two layers:
//   1. PURE, DOM-free math (resolveAxis / resolveCommit) — unit-tested in
//      isolation so the angle-lock and thresholds are provably correct.
//   2. A Pointer-Events hook (useSwipe) that wires those onto an element.
//
// The cardinal rule: NEVER steal vertical scroll. We only ever preventDefault
// AFTER the gesture has locked to the horizontal axis; a vertical resolution
// bails immediately and the browser scrolls untouched.

export const SWIPE_MIN_PX = 32; // committed-distance floor — a comfortable thumb flick (~8% of a phone)
export const SWIPE_MIN_VELOCITY = 0.3; // px/ms — a natural quick flick commits below the distance floor
export const ANGLE_LOCK_DEG = 30; // engage horizontal only when |dx| clearly dominates |dy|
export const EDGE_ZONE_PX = 24; // left/right edge band for edge-back
export const DIRECTION_LOCK_PX = 10; // travel before we decide the axis (once per gesture)
export const TAP_SLOP_PX = 8; // below this total travel is a tap, never a swipe

export type Axis = 'horizontal' | 'vertical' | null;

// One-time per gesture: once |dx| or |dy| crosses DIRECTION_LOCK_PX, decide the
// axis. Horizontal only if the angle from the x-axis is within lockDeg, so a
// near-vertical drag never engages. Returns null while still undecided.
export function resolveAxis(dx: number, dy: number, lockDeg = ANGLE_LOCK_DEG): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < DIRECTION_LOCK_PX && ay < DIRECTION_LOCK_PX) return null;
  const angle = Math.atan2(ay, ax) * (180 / Math.PI); // 0° = pure horizontal
  return angle <= lockDeg ? 'horizontal' : 'vertical';
}

// Did a horizontal gesture commit? Distance OR velocity. Direction comes from
// whichever threshold tripped (distance sign when far, velocity sign on a flick).
export function resolveCommit(
  dx: number,
  vx: number,
  minPx = SWIPE_MIN_PX,
  minVel = SWIPE_MIN_VELOCITY
): 'left' | 'right' | null {
  const far = Math.abs(dx) >= minPx;
  const fast = Math.abs(vx) >= minVel;
  if (!far && !fast) return null;
  const dir = far ? dx : vx;
  return dir < 0 ? 'left' : 'right';
}

// Soft, sign-preserving resistance for follow-finger peek / over-pull at a wall.
// Linear `dx * factor` (so the peek tracks the finger proportionally), capped at
// `max` so a long drag can't run the track off-screen. Pure + monotonic →
// unit-tested in isolation.
export function rubberBand(dx: number, factor = 0.35, max = Infinity): number {
  const resisted = dx * factor;
  if (Math.abs(resisted) <= max) return resisted;
  return Math.sign(resisted) * max;
}

const SCROLL_END_SLOP = 2;

// Walk ancestors for an overflow-x scroller that still has slack to scroll. We
// block while either edge has room (direction isn't known at pointerdown), so
// the kanban / tab strips scroll first; section nav only takes over once the
// scroller is exhausted.
function hasUnexhaustedHorizontalScroll(start: Element): boolean {
  let el: Element | null = start;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.scrollWidth - el.clientWidth > SCROLL_END_SLOP) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        const maxScroll = el.scrollWidth - el.clientWidth;
        const atStart = el.scrollLeft <= SCROLL_END_SLOP;
        const atEnd = el.scrollLeft >= maxScroll - SCROLL_END_SLOP;
        if (!(atStart && atEnd)) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

// The full guard. A swipe that starts on any of these surfaces is yielded to
// that surface (terminal scroll, Monaco caret, webview, text editing, an
// unexhausted horizontal scroller).
export function isSwipeBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target;
  // Text inputs / contenteditable / Monaco / xterm — the existing predicate.
  if (isTextEditingSurface(el)) return true;
  // Terminal surface (xterm owns its own momentum touch-scroll).
  if (el.closest('.xterm, .ace-terminal-session')) return true;
  // Monaco editor chrome.
  if (el.closest('.monaco-editor, [role="application"], textarea.inputarea')) return true;
  // Embedded webview / iframe (browser pane, github overlay, Teams self-embed).
  if (el.closest('webview, iframe')) return true;
  // A horizontally-scrollable ancestor with room left.
  if (hasUnexhaustedHorizontalScroll(el)) return true;
  return false;
}

export function isTouchEnv(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains('ace-touch')) return true;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export interface UseSwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  // When set, the gesture must START within EDGE_ZONE_PX of that screen edge.
  edge?: 'left' | 'right' | null;
  threshold?: number;
  velocityThreshold?: number;
  angleLockDeg?: number;
  enabled?: boolean;
  // Override the default conflict guard (rarely needed).
  blockWhen?: (target: EventTarget | null) => boolean;
  // Follow-finger callback (drawers/pager peek). dx is signed pixels from start.
  onProgress?: (dx: number) => void;
  onCancel?: () => void;
}

// Attach the returned ref to the gesture surface. Listeners are only attached
// when enabled and on a touch environment, so desktop never pays for them.
export function useSwipe<T extends HTMLElement = HTMLElement>(
  opts: UseSwipeOptions
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const optsRef = useRef(opts);
  // Keep the latest callbacks/thresholds without re-attaching listeners. Updated
  // in an effect (not during render) so handlers always read the freshest opts.
  useEffect(() => {
    optsRef.current = opts;
  });

  const enabled = opts.enabled !== false;
  const edge = opts.edge ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !isTouchEnv()) return;

    let active = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let vx = 0;
    let axis: Axis = null;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || active) return;
      const cfg = optsRef.current;
      const guard = cfg.blockWhen ?? isSwipeBlocked;
      if (guard(e.target)) return;
      if (edge === 'left' && e.clientX > EDGE_ZONE_PX) return;
      if (edge === 'right' && e.clientX < window.innerWidth - EDGE_ZONE_PX) return;
      active = true;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = e.timeStamp;
      vx = 0;
      axis = null;
    };

    const onMove = (e: PointerEvent) => {
      if (!active || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = e.timeStamp - lastT;
      if (dt > 0) vx = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
      if (axis === null) {
        axis = resolveAxis(dx, dy, optsRef.current.angleLockDeg ?? ANGLE_LOCK_DEG);
        if (axis === 'vertical') {
          active = false; // yield to vertical scroll, never preventDefault
          return;
        }
        if (axis === 'horizontal') {
          try {
            el.setPointerCapture(pointerId);
          } catch {
            // capture is best-effort
          }
        }
      }
      if (axis === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        optsRef.current.onProgress?.(dx);
      }
    };

    const finish = (e: PointerEvent, committed: boolean) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const wasHorizontal = axis === 'horizontal';
      active = false;
      axis = null;
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      const cfg = optsRef.current;
      if (!committed || !wasHorizontal) {
        if (wasHorizontal) cfg.onCancel?.();
        return;
      }
      const dir = resolveCommit(
        dx,
        vx,
        cfg.threshold ?? SWIPE_MIN_PX,
        cfg.velocityThreshold ?? SWIPE_MIN_VELOCITY
      );
      if (dir === 'left') cfg.onSwipeLeft?.();
      else if (dir === 'right') cfg.onSwipeRight?.();
      else cfg.onCancel?.();
    };

    const onUp = (e: PointerEvent) => {
      if (!active && axis === null) return;
      finish(e, true);
    };
    const onCancel = (e: PointerEvent) => finish(e, false);

    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp, { passive: true });
    el.addEventListener('pointercancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [enabled, edge]);

  return ref;
}
