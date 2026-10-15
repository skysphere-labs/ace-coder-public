import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANGLE_LOCK_DEG,
  DIRECTION_LOCK_PX,
  EDGE_ZONE_PX,
  SWIPE_MIN_PX,
  SWIPE_MIN_VELOCITY,
  resolveAxis,
  resolveCommit,
  rubberBand,
} from './use-swipe';

// The pure math is DOM-free, so these are real behavioural tests (the repo runs
// vitest under node, no jsdom). The DOM-coupled guard/hook are covered by source
// assertions below, matching the house style.

describe('resolveAxis (angle lock — never steal vertical scroll)', () => {
  it('is undecided below the direction-lock threshold', () => {
    expect(resolveAxis(4, 3)).toBeNull();
  });
  it('locks horizontal when dx clearly dominates dy', () => {
    expect(resolveAxis(40, 5)).toBe('horizontal'); // ~7°
  });
  it('locks vertical for a steep drag', () => {
    expect(resolveAxis(20, 40)).toBe('vertical'); // ~63°
  });
  it('treats the exact angle-lock boundary as horizontal', () => {
    const dy = 20;
    const dx = dy / Math.tan((ANGLE_LOCK_DEG * Math.PI) / 180); // exactly 30°
    expect(resolveAxis(dx, dy)).toBe('horizontal');
  });
  it('a 45° diagonal resolves vertical (strictly horizontal-dominant only)', () => {
    expect(resolveAxis(30, 30)).toBe('vertical');
  });
});

describe('resolveCommit (distance OR velocity)', () => {
  it('does not commit below both thresholds', () => {
    expect(resolveCommit(20, 0.1)).toBeNull();
  });
  it('commits left when the finger travels far left', () => {
    expect(resolveCommit(-SWIPE_MIN_PX, 0)).toBe('left');
  });
  it('commits right when the finger travels far right', () => {
    expect(resolveCommit(SWIPE_MIN_PX, 0)).toBe('right');
  });
  it('commits a fast flick despite short distance, using velocity sign', () => {
    expect(resolveCommit(-12, -SWIPE_MIN_VELOCITY)).toBe('left');
  });
});

describe('rubberBand (follow-finger peek / wall over-pull resistance)', () => {
  it('resists linearly by the factor', () => {
    expect(rubberBand(120, 0.35)).toBe(42);
  });
  it('passes zero through unchanged', () => {
    expect(rubberBand(0)).toBe(0);
  });
  it('preserves sign', () => {
    expect(rubberBand(-100, 0.5)).toBe(-50);
  });
  it('caps the magnitude so the track never runs off-screen', () => {
    expect(rubberBand(1000, 0.22, 64)).toBe(64);
    expect(rubberBand(-1000, 0.22, 64)).toBe(-64);
  });
  it('is monotonic (non-decreasing) across the input range', () => {
    let prev = -Infinity;
    for (let dx = -200; dx <= 200; dx += 10) {
      const v = rubberBand(dx, 0.22, 64);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('constants stay in sane ranges (catch accidental retuning)', () => {
  it('threshold bounds', () => {
    expect(SWIPE_MIN_PX).toBeGreaterThanOrEqual(24); // light thumb flick, but above TAP_SLOP_PX
    expect(SWIPE_MIN_VELOCITY).toBeGreaterThan(0);
    expect(ANGLE_LOCK_DEG).toBeLessThanOrEqual(35);
    expect(EDGE_ZONE_PX).toBeGreaterThan(0);
    expect(DIRECTION_LOCK_PX).toBeGreaterThan(0);
  });
});

describe('isSwipeBlocked / useSwipe wiring (source assertions)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, 'use-swipe.ts'), 'utf8');

  it('reuses the existing text-editing guard rather than reimplementing it', () => {
    expect(src).toContain("from '../lib/shortcut-helpers'");
    expect(src).toContain('isTextEditingSurface(el)');
  });
  it('guards every conflict zone', () => {
    expect(src).toContain('.xterm, .ace-terminal-session');
    expect(src).toContain('.monaco-editor');
    expect(src).toContain('role="application"');
    expect(src).toContain("closest('webview, iframe')");
    expect(src).toContain('hasUnexhaustedHorizontalScroll');
  });
  it('uses Pointer Events and only preventDefault after the horizontal lock', () => {
    expect(src).toMatch(/pointerdown/);
    expect(src).toMatch(/pointermove/);
    expect(src).toMatch(/pointercancel/);
    expect(src).toContain('setPointerCapture');
    // The preventDefault CALL sits inside the `axis === 'horizontal'` branch.
    const horizIdx = src.indexOf("axis === 'horizontal'");
    const pdIdx = src.indexOf('e.preventDefault()');
    expect(horizIdx).toBeGreaterThan(-1);
    expect(pdIdx).toBeGreaterThan(horizIdx);
  });
  it('only attaches listeners on a touch environment', () => {
    expect(src).toContain('isTouchEnv()');
  });
});
