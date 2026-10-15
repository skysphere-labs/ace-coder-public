import { describe, expect, it } from 'vitest';
import {
  accentVars,
  DEFAULT_ACCENT_ID,
  getAccent,
  MOBILE_ACCENTS,
} from './mobile-accent-registry';

// Pure-function coverage for the swappable mobile accent. The DOM apply path
// is touch-gated (no-op under node), so these tests exercise the var math the
// appearance sheet relies on.

describe('mobile accent registry', () => {
  it('defaults to the company indigo (hue 233, the Indigo Spade turned up)', () => {
    expect(DEFAULT_ACCENT_ID).toBe('indigo');
    const indigo = getAccent(DEFAULT_ACCENT_ID);
    expect(indigo.hue).toBe(233);
    // The registry's indigo must agree with the index.css defaults so
    // applying it is a visual no-op.
    expect(accentVars(indigo)['--m-accent']).toBe('hsl(233 82% 66%)');
    expect(accentVars(indigo)['--m-status-busy']).toBe('233 82% 66%');
  });

  it('knocks glyphs out in dark ink only on the light accents', () => {
    expect(accentVars(getAccent('indigo'))['--m-accent-ink']).toContain('98%');
    expect(accentVars(getAccent('ember'))['--m-accent-ink']).toContain('10%');
    expect(accentVars(getAccent('cyan'))['--m-accent-ink']).toContain('10%');
  });

  it('keeps the retired Ember amber available as a preset', () => {
    const ember = getAccent('ember');
    expect(ember.hue).toBe(33);
  });

  it('falls back to the default for unknown ids', () => {
    expect(getAccent('does-not-exist').id).toBe(DEFAULT_ACCENT_ID);
  });

  it('writes the complete var set every consumer derives from', () => {
    for (const accent of MOBILE_ACCENTS) {
      const vars = accentVars(accent);
      for (const key of [
        '--m-accent',
        '--m-accent-ink',
        '--m-accent-quiet',
        '--m-accent-glow',
        '--m-ring-active',
        '--m-status-busy',
        '--m-accent-fill',
        '--m-accent-raise',
      ]) {
        expect(vars[key], `${accent.id} ${key}`).toBeTruthy();
      }
      // StatusDot composes hsl(var(--m-status-busy)) from bare parts.
      expect(vars['--m-status-busy']).toMatch(/^\d+ \d+% \d+%$/);
      // The fill gradient never exceeds valid HSL ranges.
      expect(vars['--m-accent-fill']).not.toMatch(/(\d{3,})%/);
    }
  });

  it('pairs every accent with a glass tint hue', () => {
    for (const accent of MOBILE_ACCENTS) {
      expect(accent.tintHue).toBeGreaterThanOrEqual(0);
      expect(accent.tintHue).toBeLessThanOrEqual(360);
      expect(accent.tintSat).toBeGreaterThan(0);
    }
  });
});
