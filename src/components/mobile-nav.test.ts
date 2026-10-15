import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Stage 2 IA — the Home tab is retired in favour of a Today dashboard landing.
// 'home' stays a valid View for the desktop shell; only the mobile entry points
// move to 'today'. Source-assertion style, matching the rest of the mobile suite.
const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(resolve(here, 'MobileShell.tsx'), 'utf8');
const store = readFileSync(resolve(here, '../store.tsx'), 'utf8');
const canvas = readFileSync(resolve(here, 'WorkspaceCanvas.tsx'), 'utf8');

describe('mobile IA — Today landing, Home tab removed', () => {
  it('drops Home from the bottom nav and adds Today as the first tab', () => {
    expect(shell).toContain("type MobileTab = 'today'");
    expect(shell).not.toMatch(/id:\s*'home'/);
    expect(shell).toMatch(/id:\s*'today',\s*icon:\s*LayoutDashboard,\s*label:\s*'Today'/);
    // Public tabs, in order, with Today first.
    expect(shell).toMatch(
      /TAB_ITEMS[\s\S]*?'today'[\s\S]*?'workspaces'[\s\S]*?'loops'[\s\S]*?'settings'/
    );
    // The rendered tab list and the pager order both derive from the SAME
    // role-filtered list (Admin is org-admin-only), so they can never disagree.
    expect(shell).toContain('const tabItems = TAB_ITEMS');
    expect(shell).toContain('tabItems.map((tab) => tab.id)');
  });

  it('routes the Today tab press to the today view', () => {
    expect(shell).toMatch(/tab\.id === 'today'[\s\S]*?setView\('today'\)/);
  });

  it('cold-starts mobile on Today while desktop keeps home', () => {
    expect(store).toContain("isMobileViewport() ? 'today' : 'home'");
    expect(store).toContain("| 'today'");
  });

  it('keeps home a valid View but redirects stale mobile home state', () => {
    expect(store).toContain("if (persisted.view === 'home' && isMobileViewport()) return 'today'");
    expect(store).toContain("| 'home'");
  });

  it('routes the Today view and stale mobile Home state to the Today dashboard in the canvas', () => {
    expect(shell).toContain('<WorkspaceCanvas mobile />');
    expect(canvas).toContain('export function WorkspaceCanvas({ mobile = false }');
    expect(canvas).toContain("if (view === 'today') return");
    expect(canvas).toContain("if (mobile && view === 'home') return");
    expect(canvas).toContain('<TodayDashboard />');
    expect(canvas).toContain("if (view === 'home' || !activeWorkspace) return <WelcomeScreen />");
  });

  it('re-routes mobile back/finish targets off home', () => {
    expect(shell).toContain("setView('today')");
    const setup = readFileSync(resolve(here, 'SetupScreen.tsx'), 'utf8');
    expect(setup).toContain('landingView()');
  });
});
