import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(resolve(here, 'MobileShell.tsx'), 'utf8');
const canvasSource = readFileSync(resolve(here, 'WorkspaceCanvas.tsx'), 'utf8');
const storeSource = readFileSync(resolve(here, '../store.tsx'), 'utf8');
const electronMainSource = readFileSync(resolve(here, '../../electron/main.cts'), 'utf8');

describe('mobile Teams access', () => {
  it('keeps archived Hermes out of the mobile bottom nav', () => {
    expect(shellSource).toContain("type MobileTab =");
    expect(shellSource).not.toMatch(/type MobileTab =[^;]*'hermes'/);
    expect(shellSource).not.toMatch(/id:\s*'hermes'/);
    expect(shellSource).not.toContain('Bot,');
    expect(storeSource).toContain("persisted.view === 'hermes' || persisted.view === 'teams'");
  });

  it('retires Teams as a bottom-nav tab — the embed is resident, not a destination', () => {
    expect(shellSource).toContain("type MobileTab =");
    expect(shellSource).not.toMatch(/id:\s*'teams'/);
    expect(shellSource).not.toMatch(/type MobileTab =[^;]*'teams'/);
  });

  it('renders the bottom nav as NavTab atoms with accessible section names', () => {
    expect(shellSource).toContain('<NavTab');
    expect(shellSource).toContain('label={tab.label}');
    // Dock tabs are icon-only; the section name is exposed via aria-label
    // (the styling lives in the shared NavTab atom).
    const navTabSource = readFileSync(resolve(here, 'ui/mobile/atoms/NavTab.tsx'), 'utf8');
    expect(navTabSource).toContain('aria-label={label}');
    expect(navTabSource).toContain('aria-current');
  });

  it('keeps the legacy Agents surface renderable', () => {
    expect(shellSource).toContain("view === 'hermes' ? 'Agents'");
    expect(canvasSource).toContain("if (view === 'hermes') return");
    expect(canvasSource).toContain('<AgentsScreen />');
    expect(storeSource).toContain("| 'hermes'");
  });

  it('serves Teams from the resident operator surface, not a route-scoped embed', () => {
    // The canvas still renders a placeholder; the Hermes embed now lives in a
    // shell-root resident host, so 'teams' means "show that host full canvas"
    // rather than "mount an embed". Both shells mount the SAME component, and
    // only one shell is ever mounted (App.tsx picks by viewport), so exactly
    // one HermesDesktopAppPane exists per renderer.
    expect(canvasSource).toContain("if (view === 'teams') return <div");
    // The embed is mounted once in App, above the shell swap; each shell only
    // publishes its content area as the full-canvas anchor.
    const appSource = readFileSync(resolve(here, '../App.tsx'), 'utf8');
    const desktopShellSource = readFileSync(resolve(here, 'DesktopShell.tsx'), 'utf8');
    expect(appSource).toContain('<ResidentOperatorSurface />');
    expect(shellSource).toContain('registerResidentAnchor');
    expect(desktopShellSource).toContain('registerResidentAnchor');
    expect(shellSource).not.toContain('<TeamsScreen');
    expect(desktopShellSource).not.toContain('<TeamsScreen');
    expect(storeSource).toContain("| 'teams'");
  });

  it('allows the Electron window to shrink below the mobile shell breakpoint', () => {
    expect(electronMainSource).toContain('minWidth: 390');
    expect(electronMainSource).not.toContain('minWidth: 900');
  });
});
