import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every branch here is exercised with an INJECTED platform/arch/env so the
// win32 and linux layouts are covered from a macOS dev box and macOS CI. The
// separator stays the host's (the module uses `path`, which is native on the
// real target), so these assert path STRUCTURE — which is exactly what was
// wrong: a `.hermes` home and a `Hermes.app` segment that exist on macOS only.
const hermesPaths = require('../hermes-paths.cts');

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\Sample\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' };

function win(extra = {}) {
  return { platform: 'win32', arch: 'x64', env: { ...WIN_ENV, ...extra }, homedir: 'C:\\Users\\Sample' };
}

function mac(extra = {}) {
  return { platform: 'darwin', arch: 'arm64', env: {}, homedir: '/Users/sample', ...extra };
}

// ── global home ────────────────────────────────────────────────────────────

test('posix home stays ~/.hermes', () => {
  expect(hermesPaths.globalHermesHome(mac())).toBe(path.join('/Users/sample', '.hermes'));
  expect(
    hermesPaths.globalHermesHome({ platform: 'linux', arch: 'x64', env: {}, homedir: '/home/sample' })
  ).toBe(path.join('/home/sample', '.hermes'));
});

test('windows home is %LOCALAPPDATA%\\hermes, not ~/.hermes', () => {
  // The regression: the app searched C:\Users\X\.hermes while install.ps1 had
  // put everything in %LOCALAPPDATA%\hermes, so nothing ever resolved.
  const home = hermesPaths.globalHermesHome(win());
  expect(home).toBe(path.join(WIN_ENV.LOCALAPPDATA, 'hermes'));
  expect(home).not.toContain('.hermes');
});

test('windows home falls back under the profile when LOCALAPPDATA is unset', () => {
  const home = hermesPaths.globalHermesHome({
    platform: 'win32',
    arch: 'x64',
    env: {},
    homedir: 'C:\\Users\\Sample',
  });
  expect(home).toBe(path.join('C:\\Users\\Sample', 'AppData', 'Local', 'hermes'));
});

test('HERMES_HOME wins when it exists and is ignored when it does not', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-env-'));
  expect(hermesPaths.globalHermesHome({ ...mac(), env: { HERMES_HOME: real } })).toBe(
    fs.realpathSync.native(real)
  );

  // A stale env var must not shadow a working install.
  const missing = path.join(real, 'does-not-exist');
  expect(hermesPaths.globalHermesHome({ ...mac(), env: { HERMES_HOME: missing } })).toBe(
    path.join('/Users/sample', '.hermes')
  );
});

test('an injected home overrides every default', () => {
  const opts = { ...win(), home: 'D:\\elsewhere\\hermes' };
  expect(hermesPaths.globalHermesHome(opts)).toBe('D:\\elsewhere\\hermes');
  expect(hermesPaths.hermesAgentDir('', opts)).toBe(path.join('D:\\elsewhere\\hermes', 'hermes-agent'));
});

// ── CLI discovery ──────────────────────────────────────────────────────────

test('posix CLI search dirs are unchanged from the previous hardcoded list', () => {
  expect(hermesPaths.hermesCliSearchDirs(mac())).toEqual([
    path.join('/Users/sample', '.local', 'bin'),
    path.join('/Users/sample', '.hermes', 'hermes-agent', 'venv', 'bin'),
  ]);
  expect(hermesPaths.hermesCliCandidates(mac())).toEqual([
    path.join('/Users/sample', '.local', 'bin', 'hermes'),
    path.join('/Users/sample', '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
  ]);
});

test('windows CLI lives in venv\\Scripts with an executable suffix', () => {
  const scripts = path.join(WIN_ENV.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts');
  expect(hermesPaths.hermesCliSearchDirs(win())).toEqual([scripts]);
  expect(hermesPaths.hermesCliCandidates(win())).toEqual([
    path.join(scripts, 'hermes.exe'),
    path.join(scripts, 'hermes.cmd'),
  ]);
  // `~/.local/bin` has no Windows equivalent; probing it was pure noise.
  expect(hermesPaths.hermesCliSearchDirs(win()).join('|')).not.toContain('.local');
});

// ── desktop bundle roots ───────────────────────────────────────────────────

test('macOS keeps the .app bundle roots it already used', () => {
  const roots = hermesPaths.hermesDesktopAppRoots(mac());
  const release = path.join('/Users/sample', '.hermes', 'hermes-agent', 'apps', 'desktop', 'release');
  expect(roots[0]).toBe(path.join(release, 'mac-arm64', 'Hermes.app'));
  expect(roots).toContain('/Applications/Hermes.app');
});

test('Intel macOS looks in electron-builder\'s real x64 dir, `mac`', () => {
  // getArchSuffix() returns "" for the default arch, so an x64 build lands in
  // `mac` — the old hardcoded `mac-x64` matched nothing on an Intel machine.
  const roots = hermesPaths.hermesDesktopAppRoots({ ...mac(), arch: 'x64' });
  const release = path.join('/Users/sample', '.hermes', 'hermes-agent', 'apps', 'desktop', 'release');
  expect(roots).toContain(path.join(release, 'mac', 'Hermes.app'));
  expect(roots).toContain(path.join(release, 'mac-x64', 'Hermes.app'));
});

test('windows app root is the unpacked dir itself, with NO Hermes.app segment', () => {
  // The core bug: electron-builder only wraps macOS builds in a .app bundle.
  // win-unpacked/ IS the app root and holds resources/app.asar directly.
  const roots = hermesPaths.hermesDesktopAppRoots(win());
  const release = path.join(WIN_ENV.LOCALAPPDATA, 'hermes', 'hermes-agent', 'apps', 'desktop', 'release');
  expect(roots[0]).toBe(path.join(release, 'win-unpacked'));
  for (const root of roots) expect(root).not.toContain('Hermes.app');
  expect(roots).toContain(path.join(WIN_ENV.LOCALAPPDATA, 'Programs', 'Hermes'));
  expect(roots).toContain(path.join(WIN_ENV.PROGRAMFILES, 'Hermes'));
});

test('windows arm64 uses the arch-suffixed unpacked dir', () => {
  const roots = hermesPaths.hermesDesktopAppRoots({ ...win(), arch: 'arm64' });
  expect(roots[0]).toContain(path.join('release', 'win-arm64-unpacked'));
});

test('linux app root is the unpacked dir itself', () => {
  const roots = hermesPaths.hermesDesktopAppRoots({
    platform: 'linux',
    arch: 'x64',
    env: {},
    homedir: '/home/sample',
  });
  expect(roots[0]).toBe(
    path.join('/home/sample', '.hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'linux-unpacked')
  );
  for (const root of roots) expect(root).not.toContain('Hermes.app');
  expect(roots).toContain('/opt/Hermes');
});

test('desktop roots never repeat a candidate', () => {
  for (const opts of [mac(), { ...mac(), arch: 'x64' }, win(), { ...win(), arch: 'arm64' }]) {
    const roots = hermesPaths.hermesDesktopAppRoots(opts);
    expect(new Set(roots).size).toBe(roots.length);
  }
});

// ── Windows install command contract ───────────────────────────────────────

test('the Windows install command works from a fresh, empty home', () => {
  const { PROVIDERS } = require('../agent-providers.cts');
  const hermes = PROVIDERS.find((entry) => entry.id === 'hermes');
  const cmd = hermes.installCommandWindows;
  expect(cmd).toBeTruthy();

  // Creates the Hermes home before cloning into it. (git clone does create
  // missing parents, verified directly; this is belt-and-braces so a fresh
  // %LOCALAPPDATA%\hermes can never be the reason an install fails.)
  const mkdirAt = cmd.indexOf('New-Item -ItemType Directory -Force -Path $h');
  const cloneAt = cmd.indexOf('git clone --branch ace/patches');
  expect(mkdirAt).toBeGreaterThan(-1);
  expect(mkdirAt).toBeLessThan(cloneAt);

  // Honors HERMES_HOME, else %LOCALAPPDATA%\hermes.
  expect(cmd).toContain('if ($env:HERMES_HOME) { $env:HERMES_HOME }');
  expect(cmd).toContain('"$env:LOCALAPPDATA\\hermes"');
  // Fails loudly rather than falling through to install upstream Hermes.
  expect(cmd).toContain('throw "git clone failed');
  // Repoints an existing checkout at the fork, or install.ps1 fetches
  // ace/patches from NousResearch where the branch does not exist.
  expect(cmd).toContain('git -C $d remote add origin $fork');
  // The POSIX form stays bash for SSH installs to Linux hosts.
  expect(hermes.installCommand).toContain('curl -fsSL');
  expect(hermes.installCommand).not.toContain('New-Item');
});
