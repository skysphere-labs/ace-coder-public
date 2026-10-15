// Structural invariants only — behaviour lives in the render test. These guard
// the things a render test cannot see: how many mount sites exist repo-wide,
// and where the surface sits relative to the shell swap.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetResidentOperatorForTests,
  getResidentOperatorMode,
  resolveResidentMode,
  setResidentOperatorMode,
} from '../../runtime/resident-operator-registry';

const root = process.cwd();
const teams = resolve(root, 'src/components/teams');

// The surface documents the invariants it implements, so its prose names the
// things these guards forbid. Structural checks run against code only.
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const surface = strip(readFileSync(resolve(teams, 'ResidentOperatorSurface.tsx'), 'utf8'));
const app = strip(readFileSync(resolve(root, 'src/App.tsx'), 'utf8'));
const desktopShell = strip(readFileSync(resolve(root, 'src/components/DesktopShell.tsx'), 'utf8'));
const mobileShell = strip(readFileSync(resolve(root, 'src/components/MobileShell.tsx'), 'utf8'));
const registry = strip(readFileSync(resolve(root, 'src/runtime/resident-operator-registry.ts'), 'utf8'));

function allTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) allTsx(full, out);
    else if (e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('resident operator mode', () => {
  beforeEach(() => __resetResidentOperatorForTests());

  it('is host state, not navigation — every mode passes through unchanged', () => {
    for (const mode of ['collapsed', 'popup', 'full'] as const) {
      expect(resolveResidentMode({ mode })).toBe(mode);
    }
  });

  it('lets the diff viewer outrank full canvas so Change Review stays reachable', () => {
    expect(resolveResidentMode({ mode: 'full', showDiffViewer: true })).toBe('popup');
    // Only full canvas yields; the corner box never covers anything.
    expect(resolveResidentMode({ mode: 'popup', showDiffViewer: true })).toBe('popup');
    expect(resolveResidentMode({ mode: 'collapsed', showDiffViewer: true })).toBe('collapsed');
  });

  it('defaults to collapsed and persists the chosen mode', () => {
    expect(getResidentOperatorMode()).toBe('collapsed');
    setResidentOperatorMode('full');
    expect(getResidentOperatorMode()).toBe('full');
    setResidentOperatorMode('popup');
    expect(getResidentOperatorMode()).toBe('popup');
  });

  it('persists ONLY presentation — never conversation, session, or backend state', () => {
    expect(registry).toContain("const STORAGE_KEY = 'ace:resident-operator-v1'");
    expect(registry).toContain('type ResidentOperatorState = { mode: ResidentOperatorMode }');
    for (const leak of ['sessionId', 'ownerKey', 'url', 'partition', 'hermesDesktop']) {
      expect(registry).not.toContain(leak);
    }
  });

  it('migrates the v1 { open } shape so an existing install keeps its preference', () => {
    expect(registry).toContain("if (typeof parsed?.open === 'boolean')");
  });
});

describe('exactly one embed, above the shell swap', () => {
  it('is the only place in src/ that mounts the Hermes Desktop pane', () => {
    // Test files may render the pane under test; the pin is production-only.
    const mounts = allTsx(resolve(root, 'src'))
      .filter((f) => !/\.test\.tsx$/.test(f))
      .filter((f) => /<HermesDesktopAppPane[\s/>]/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(root.length + 1));
    expect(mounts).toEqual(['src/components/teams/ResidentOperatorSurface.tsx']);
  });

  it('mounts the pane unkeyed and unconditional', () => {
    expect(surface.match(/<HermesDesktopAppPane/g)).toHaveLength(1);
    expect(surface).not.toMatch(/<HermesDesktopAppPane[^>]*\skey=/);
    expect(surface).not.toMatch(/\{\s*[\w.]+\s*&&\s*<HermesDesktopAppPane/);
    expect(surface).not.toMatch(/\?\s*<HermesDesktopAppPane/);
    // A portal remounts its subtree when the container changes.
    expect(surface).not.toContain('createPortal');
    expect(surface).not.toContain('return null');
  });

  it('is mounted in App, outside the shell that the breakpoint swaps', () => {
    expect(app).toContain('<ResidentOperatorSurface />');
    // Must not be inside the swapped shell element.
    expect(app).not.toMatch(/<Shell>[\s\S]*<ResidentOperatorSurface/);
    expect(desktopShell).not.toContain('<ResidentOperatorSurface');
    expect(mobileShell).not.toContain('<ResidentOperatorSurface');
  });

  it('is fault-contained by its own boundary, and that boundary cannot remount it', () => {
    // Sitting outside the shell also puts it outside the shell's boundary, so a
    // crash here would otherwise take the whole renderer down.
    const mount = app.indexOf('<ResidentOperatorSurface />');
    const wrapper = app.slice(app.lastIndexOf('<ErrorBoundary', mount), mount);
    expect(wrapper).toMatch(/<ErrorBoundary[^>]*>\s*$/);
    // A resetKey would remount the embed on every change of that key.
    expect(wrapper).not.toContain('resetKey');
  });

  it('has retired the route-conditional owner; shells only publish an anchor', () => {
    expect(existsSync(resolve(teams, 'TeamsScreen.tsx'))).toBe(false);
    expect(desktopShell).not.toContain('TeamsScreen');
    expect(mobileShell).not.toContain('TeamsScreen');
    expect(desktopShell).toContain('registerResidentAnchor');
    expect(mobileShell).toContain('registerResidentAnchor');
  });
});

describe('no lifecycle or identity coupling', () => {
  it('touches no Hermes backend lifecycle, partition, or owner key', () => {
    for (const forbidden of [
      'hermesDesktop.ensure',
      'hermesDesktop.stop',
      'hermesDesktop.restart',
      'HERMES_DESKTOP_APP_PARTITION',
      'HERMES_DESKTOP_APP_OWNER_KEY',
      'partition',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('never touches the router at all — presentation is host state', () => {
    expect(surface).not.toContain('setActiveWorkspaceId');
    expect(surface).not.toContain('setActiveTaskId');
    expect(surface).not.toContain('setShowDiffViewer');
    // Teams is retired; full canvas is a mode, so no navigation is involved.
    expect(surface).not.toContain('setView');
    expect(surface).not.toContain("'teams'");
  });

  it('has retired the Teams tab from both shells', () => {
    const nav = strip(readFileSync(resolve(root, 'src/components/navigation-items.ts'), 'utf8'));
    expect(nav).not.toContain("id: 'teams'");
    expect(mobileShell).not.toContain("id: 'teams'");
  });

  it('takes identity from config with a neutral shipped fallback', () => {
    expect(surface).toContain('useOperators()');
    expect(surface).toContain('DEFAULT_OPERATORS');
    // Hardcoded agent names are caught repo-wide by
    // scripts/check-depersonalization.cts; restating the pattern here would
    // itself be a hit.
    expect(surface).not.toMatch(/\?\?\s*'[A-Z]/);
  });

  it('handles Escape on the host only, never on window', () => {
    expect(surface).toContain('onKeyDown={onKeyDown}');
    expect(surface).not.toContain("window.addEventListener('keydown'");
    expect(surface).not.toContain("document.addEventListener('keydown'");
  });

  it('gates every transition and animation behind motion-safe', () => {
    const motion = surface.match(/\b(?:transition|animate)-[\w[\]-]+/g) ?? [];
    expect(motion.length).toBeGreaterThan(0);
    for (const token of motion) {
      const at = surface.indexOf(token);
      expect(surface.slice(Math.max(0, at - 12), at)).toContain('motion-safe:');
    }
  });

  it('accounts for safe-area insets on all sides it anchors to', () => {
    expect(surface).toContain('env(safe-area-inset-right)');
    expect(surface).toContain('env(safe-area-inset-left)');
    expect(surface).toContain('env(safe-area-inset-bottom)');
  });
});
