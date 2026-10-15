// Regression: navigating away from Teams / Hermes Desktop must not stop the
// Hermes home or backend. Only explicit restart/stop paths and the manager's
// stopAll may stop anything.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = resolve(process.cwd(), 'src/components/teams');
const appPane = readFileSync(resolve(here, 'HermesDesktopAppPane.tsx'), 'utf8');
const surface = readFileSync(resolve(here, 'ResidentOperatorSurface.tsx'), 'utf8');

// A cleanup function that stops the backend — the exact shape both unmount
// releases had before the fix.
const UNMOUNT_STOP = /return \(\) => \{\s*(?:if \(ownerKey\) )?void aceApi\.hermesDesktop\.stop/;

describe('Hermes session persistence across unmount/navigation', () => {
  it('the global app pane stops the backend only from the explicit Restart action', () => {
    expect(appPane).not.toMatch(UNMOUNT_STOP);
    expect(appPane.match(/aceApi\.hermesDesktop\.stop\(/g)).toHaveLength(1);
    expect(appPane).toContain(
      'await aceApi.hermesDesktop.stop(state.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY)'
    );
  });

  // The embed is now a RESIDENT of the shell, so the old "unmount while
  // hidden" behaviour is exactly the regression to guard against: hiding must
  // be a style change, never an unmount and never a zero-sized frame.
  it('the resident surface hides the embed without unmounting or zero-sizing it', () => {
    expect(surface).not.toContain('return null');
    expect(surface).toContain("visibility: 'hidden' as const");
    expect(surface).toContain("pointerEvents: 'none' as const");
    // display:none would zero the host border box, which zero-sizes the
    // <webview> and fires the pane's ResizeObserver effects at width 0.
    expect(surface).not.toContain("display: 'none'");
  });

  it('renders the embed unconditionally — no route guard, no key, no early return', () => {
    const mount = '<HermesDesktopAppPane onPhaseChange={setPhase} />';
    expect(surface).toContain(mount);
    // (resident-operator-surface.test.ts pins the single-mount count repo-wide.)
    // A key would let a mode change remount the frame.
    expect(surface).not.toMatch(/<HermesDesktopAppPane[^>]*\skey=/);
    // The mount must not sit behind a conditional.
    expect(surface).not.toMatch(/\{\s*\w+\s*&&\s*<HermesDesktopAppPane/);
    expect(surface).not.toMatch(/\?\s*<HermesDesktopAppPane/);
  });
});
