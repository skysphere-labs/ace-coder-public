import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Stage 1 — the shared mobile atomic layer. Like the rest of the mobile suite
// (mobile-teams-access.test.ts), these assert on source: the atoms exist, are
// token-driven (no raw `white/[0.0x]` leaking into the kit), are exported from
// the barrel, and the first adopters consume them instead of re-rolling chrome.
const here = dirname(fileURLToPath(import.meta.url));
const atom = (name: string) => readFileSync(resolve(here, 'atoms', `${name}.tsx`), 'utf8');
const barrel = readFileSync(resolve(here, 'index.ts'), 'utf8');
const indexCss = readFileSync(resolve(here, '../../../index.css'), 'utf8');

const ATOMS = [
  'MobilePressable', 'MobilePill', 'GlassCard', 'IconWell', 'SheetHeader',
  'SectionLabel', 'MobileEmptyState', 'Divider', 'StatusDot', 'ChangeStat',
  'PrTag', 'AgentBadge', 'NavTab', 'MobileListRow',
];

describe('mobile atomic layer', () => {
  it('exports every atom from the barrel', () => {
    for (const name of ATOMS) {
      expect(barrel).toContain(`./atoms/${name}`);
    }
  });

  it('declares each atom as a named export', () => {
    for (const name of ATOMS) {
      expect(atom(name)).toMatch(new RegExp(`export (const|function) ${name}\\b`));
    }
  });

  it('is token-driven — atoms never hardcode raw white/[0.0x] surfaces', () => {
    // The whole point of the layer: surfaces/hairlines come from --m-* tokens,
    // not the `white/[0.0x]` literals that were copy-pasted across mobile.
    for (const name of ATOMS) {
      expect(atom(name)).not.toMatch(/white\/\[0\.0/);
    }
  });

  it('wires the surface atoms to the --m-* tokens', () => {
    expect(atom('IconWell')).toContain('var(--m-hairline)');
    expect(atom('IconWell')).toContain('var(--m-surface-strong)');
    expect(atom('Divider')).toContain('var(--m-hairline)');
    expect(atom('MobileEmptyState')).toContain('var(--m-hairline)');
    expect(atom('StatusDot')).toContain('hsl(var(--m-status-busy))');
  });

  it('defines the --m-* tokens in index.css :root', () => {
    for (const token of ['--m-surface', '--m-surface-strong', '--m-hairline', '--m-ring-active',
      '--m-status-busy', '--m-status-done', '--m-status-error']) {
      expect(indexCss).toContain(`${token}:`);
    }
  });

  it('keeps the chrome atoms wrapping the existing .mobile-* classes', () => {
    // Behavior-identical: the atoms compose the same CSS the bolted-on markup used.
    expect(atom('MobilePill')).toContain('mobile-header-pill');
    expect(atom('MobilePill')).toContain('rounded-full');
    expect(atom('MobilePressable')).toContain('mobile-press');
    expect(atom('GlassCard')).toContain('mobile-glass-card');
  });

  it('preserves the shared sliding nav pill in the NavTab atom', () => {
    const navTab = atom('NavTab');
    expect(navTab).toContain('layoutId="mobile-tab-pill"');
    expect(navTab).toContain('aria-current');
    // Icon-only dock tab: the section name is exposed to AT, not painted.
    expect(navTab).toContain('aria-label={label}');
  });

  it('is adopted by the first mobile surfaces (proves the kit is real, not dead code)', () => {
    const drawer = readFileSync(resolve(here, '../../MobileActivityDrawer.tsx'), 'utf8');
    expect(drawer).toContain("from './ui/mobile'");
    expect(drawer).toContain('<SheetHeader');
    // The hand-rolled 56px header it replaced is gone.
    expect(drawer).not.toContain('mobile-header-pill flex h-11 w-11');

    const switcher = readFileSync(resolve(here, '../../MobileTabSwitcher.tsx'), 'utf8');
    expect(switcher).toContain("from './ui/mobile'");
    expect(switcher).toContain('<MobilePill');
  });
});
