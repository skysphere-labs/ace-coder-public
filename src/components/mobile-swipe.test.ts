import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Stage 3 — the aggressive swipe system. Source assertions that each surface is
// wired to the shared useSwipe hook and that the safety properties hold (the
// pure math is unit-tested in src/runtime/use-swipe.test.ts).
const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(resolve(here, 'MobileShell.tsx'), 'utf8');
const drawer = readFileSync(resolve(here, 'MobileActivityDrawer.tsx'), 'utf8');
const wsScreen = readFileSync(resolve(here, 'MobileWorkspacesScreen.tsx'), 'utf8');
const navTab = readFileSync(resolve(here, 'ui/mobile/atoms/NavTab.tsx'), 'utf8');
const hermes = readFileSync(resolve(here, 'teams/HermesDesktopAppPane.tsx'), 'utf8');

describe('mobile swipe gestures', () => {
  it('section pager swipes the sections via the existing nav logic', () => {
    expect(shell).toContain('useSwipe');
    // The pager order derives from the role-filtered tab list (Admin is
    // org-admin-only), so a swipe can never page onto a hidden tab.
    expect(shell).toContain('const sectionOrder: MobileTab[] = tabItems.map((tab) => tab.id)');
    expect(shell).toContain('goSection');
    expect(shell).toContain('handleTabPress(tab)'); // reuses nav, so the pill stays in sync
  });

  it('clamps at the ends instead of wrapping', () => {
    expect(shell).not.toContain('% sectionOrder.length');
    expect(shell).toContain('clamp at the ends, no wrap');
  });

  it('keeps the shared sliding nav pill (layoutId) intact', () => {
    expect(navTab).toContain('layoutId="mobile-tab-pill"');
  });

  it('edge-back consumes overlays first, then navigates', () => {
    expect(shell).toContain("edge: 'left'");
    expect(shell).toMatch(/consumeMobileBack\(\)[\s\S]*?handleBack\(\)/);
  });

  it('never arms the section pager and edge-back at the same time', () => {
    expect(shell).toContain('sectionPagerEnabled');
    expect(shell).toContain('enabled: showBack');
  });

  it('dismisses drawers/sheets by drag, reusing the existing slide transition', () => {
    expect(drawer).toContain('drag="x"');
    expect(drawer).toContain('dragDirectionLock');
    expect(drawer).toContain("exit={{ x: '100%' }}");
    expect(wsScreen).toContain('drag="y"');
    expect(wsScreen).toContain('dragDirectionLock');
  });

  it('closes the Teams sidebar on an outside tap without restarting Hermes', () => {
    expect(hermes).toContain('__aceSidebarOutsideTap');
    expect(hermes).toContain('pointerdown');
    // Re-dispatches the SAME toggle event — no restart, no profile-switch script.
    expect(hermes).toContain("detail: { id: 'chat-sidebar' }");
    // A tap inside the drawer is ignored.
    expect(hermes).toContain('contains(e.target)');
  });

  it('closes Teams right-side drawers on an outside tap', () => {
    expect(hermes).toContain('__aceRightDrawerOutsideTap');
    expect(hermes).toContain("const drawerIds = ['preview', 'review', 'file-browser'];");
    expect(hermes).toContain("drawer.getAttribute('data-pane-hover-reveal') === 'open'");
    expect(hermes).toContain('armMobileRightDrawerOutsideTap');
    expect(hermes).toContain('closeMobileRightDrawer(drawer)');
  });

  it('pins the Teams sessions drawer to the left edge on mobile', () => {
    expect(hermes).toContain('[data-pane-id="chat-sidebar"]');
    expect(hermes).toContain('position: fixed !important;');
    expect(hermes).toContain('right: auto !important;');
  });
});
