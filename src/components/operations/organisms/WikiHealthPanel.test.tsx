import { describe, expect, it } from 'vitest';
import { deriveWikiHealthView } from './WikiHealthPanel';

describe('deriveWikiHealthView', () => {
  it('returns null without metrics (falls back to ops-status warnings)', () => {
    expect(deriveWikiHealthView(undefined)).toBeNull();
    expect(deriveWikiHealthView(null)).toBeNull();
  });

  it('maps a healthy summary to a green severity and labelled rows', () => {
    const view = deriveWikiHealthView({
      severity: 'green',
      dumpOnlyProjects: [],
      canonPages: 12,
      rawVsCanonRatio: 0.5,
      sourceCoverage: 1,
      stalePages: 0,
      inboxPending: 0,
      lastNightlyAt: '2026-06-14T03:30:00Z',
      indexFreshness: 'fresh',
      flags: [],
    });
    expect(view).not.toBeNull();
    expect(view!.severity).toBe('green');
    const byLabel = Object.fromEntries(view!.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Dump-only projects']).toBe('0');
    expect(byLabel['Canon pages']).toBe('12');
    expect(byLabel['Source coverage']).toBe('100%');
    expect(byLabel['Last nightly']).toBe('2026-06-14');
  });

  it('maps amber severity and surfaces the dump-only flag', () => {
    const view = deriveWikiHealthView({
      severity: 'amber',
      dumpOnlyProjects: ['prj_a', 'prj_b'],
      canonPages: 3,
      rawVsCanonRatio: null,
      flags: ['dump-only projects (no canon): prj_a, prj_b'],
    });
    expect(view!.severity).toBe('yellow'); // amber → StatusPill 'yellow'
    const byLabel = Object.fromEntries(view!.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Dump-only projects']).toBe('2');
    expect(byLabel['Raw : canon']).toBe('—'); // null ratio renders as a dash
    expect(view!.flags[0]).toMatch(/dump-only/);
  });

  it('maps a black (failed-write) severity', () => {
    const view = deriveWikiHealthView({ severity: 'black', flags: ['last nightly curator run errored'] });
    expect(view!.severity).toBe('black');
  });
});
