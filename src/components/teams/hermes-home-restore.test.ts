// Negative guards + IPC surface pins for the home restore. Behavioral proof
// lives in hermes-home-restore.render.test.tsx (real pane, real events).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pane = readFileSync(
  resolve(process.cwd(), 'src/components/teams/HermesDesktopAppPane.tsx'),
  'utf8'
);
const aceApi = readFileSync(resolve(process.cwd(), 'src/lib/ace-api.ts'), 'utf8');
const preload = readFileSync(resolve(process.cwd(), 'electron/preload.cts'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'electron/main.cts'), 'utf8');

describe('canonical home-chat restore wiring', () => {
  it('restore can never clear SPA session memory or force-route to blank', () => {
    expect(pane).not.toContain("removeItem('hermes.desktop.lastSessionId");
    expect(pane).not.toContain("window.location.hash = '/'");
    expect(pane).not.toContain("url.hash = '/'");
  });

  it('no unbounded delivery polling: the only interval is the bounded live-frame sweep', () => {
    const intervalAt = pane.indexOf('}, CRON_HOME_SYNC_INTERVAL_MS);');
    expect(intervalAt).toBeGreaterThan(-1);
    expect(pane.slice(intervalAt, intervalAt + 200)).toContain('return () => window.clearInterval(timer);');
  });

  it('the renderer API and IPC surface are wired end to end', () => {
    expect(aceApi).toContain("'hermesDesktopHomeSessionRestore'");
    expect(aceApi).toContain("'hermesDesktopCronHomeDeliverySync'");
    expect(preload).toContain("hermesDesktopHomeSessionRestore: 'ace:hermes-desktop-home-restore'");
    expect(preload).toContain("hermesDesktopCronHomeDeliverySync: 'ace:hermes-desktop-cron-home-sync'");
    expect(main).toContain("ipcMain.handle('ace:hermes-desktop-home-restore'");
    expect(main).toContain("ipcMain.handle('ace:hermes-desktop-cron-home-sync'");
  });
});
