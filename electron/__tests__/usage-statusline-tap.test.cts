import { test, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const tap = require('../usage-statusline-tap.cts');

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tap-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function dirs() {
  const configDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const usageDir = path.join(tmp, 'usage');
  return { configDir, usageDir };
}

test('fresh install writes tap script, settings statusLine, and backup', () => {
  const { configDir, usageDir } = dirs();
  const paths = tap.ensureStatuslineTap(configDir, usageDir);
  expect(paths).toBeTruthy();

  const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
  expect(settings.statusLine).toEqual({ type: 'command', command: paths.scriptFile });

  const script = fs.readFileSync(paths.scriptFile, 'utf8');
  expect(script).toContain(paths.cacheFile);
  expect(fs.statSync(paths.scriptFile).mode & 0o111).toBeTruthy();

  const backup = JSON.parse(fs.readFileSync(paths.backupFile, 'utf8'));
  expect(backup.statusLine).toBeNull();
});

test('idempotent: second install changes nothing', () => {
  const { configDir, usageDir } = dirs();
  const paths = tap.ensureStatuslineTap(configDir, usageDir);
  const settingsBefore = fs.readFileSync(paths.settingsFile, 'utf8');
  const scriptBefore = fs.readFileSync(paths.scriptFile, 'utf8');

  const again = tap.ensureStatuslineTap(configDir, usageDir);
  expect(again.scriptFile).toBe(paths.scriptFile);
  expect(fs.readFileSync(paths.settingsFile, 'utf8')).toBe(settingsBefore);
  expect(fs.readFileSync(paths.scriptFile, 'utf8')).toBe(scriptBefore);
});

test('a stale tap script from an older build is upgraded in place', () => {
  const { configDir, usageDir } = dirs();
  // Original user statusline so the upgrade must preserve the chain.
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: "echo 'mine'" } })
  );
  const paths = tap.ensureStatuslineTap(configDir, usageDir);
  const settingsBefore = fs.readFileSync(paths.settingsFile, 'utf8');
  const backupBefore = fs.readFileSync(paths.backupFile, 'utf8');

  // Simulate an older tap script: same file, but missing the rate_limits guard
  // that keeps an early-session payload from clobbering the last good meter.
  const stale = fs
    .readFileSync(paths.scriptFile, 'utf8')
    .split('\n')
    .filter((line) => !line.includes('rate_limits'))
    .join('\n');
  fs.writeFileSync(paths.scriptFile, stale);
  expect(stale).not.toContain('rate_limits');

  const again = tap.ensureStatuslineTap(configDir, usageDir);
  expect(again.scriptFile).toBe(paths.scriptFile);
  const upgraded = fs.readFileSync(paths.scriptFile, 'utf8');
  // The guard is back, the chained user command survives, and neither settings
  // nor the backup were touched.
  expect(upgraded).toContain('rate_limits');
  expect(upgraded).toContain("echo '\\''mine'\\''");
  expect(fs.readFileSync(paths.settingsFile, 'utf8')).toBe(settingsBefore);
  expect(fs.readFileSync(paths.backupFile, 'utf8')).toBe(backupBefore);
});

test('chains a pre-existing user statusline command and preserves other settings', () => {
  const { configDir, usageDir } = dirs();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      model: 'opus',
      statusLine: { type: 'command', command: "echo 'mine'", padding: 0 },
    })
  );

  const paths = tap.ensureStatuslineTap(configDir, usageDir);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  expect(settings.model).toBe('opus');
  expect(settings.statusLine.command).toBe(paths.scriptFile);
  expect(settings.statusLine.padding).toBe(0);

  const script = fs.readFileSync(paths.scriptFile, 'utf8');
  expect(script).toContain("echo '\\''mine'\\''");

  const backup = JSON.parse(fs.readFileSync(paths.backupFile, 'utf8'));
  expect(backup.statusLine.command).toBe("echo 'mine'");

  // Reinstall must not overwrite the backup with the tapped value.
  fs.rmSync(paths.scriptFile);
  tap.ensureStatuslineTap(configDir, usageDir);
  const backupAfter = JSON.parse(fs.readFileSync(paths.backupFile, 'utf8'));
  expect(backupAfter.statusLine.command).toBe("echo 'mine'");
  // And the regenerated script still chains the original command.
  expect(fs.readFileSync(paths.scriptFile, 'utf8')).toContain("echo '\\''mine'\\''");
});

test('refuses to rewrite an unparseable settings.json', () => {
  const { configDir, usageDir } = dirs();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{ this is not json');
  expect(tap.ensureStatuslineTap(configDir, usageDir)).toBeNull();
  expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ this is not json');
});

test('returns null when the config dir does not exist', () => {
  expect(tap.ensureStatuslineTap(path.join(tmp, 'missing'), path.join(tmp, 'usage'))).toBeNull();
});

test('tap script mirrors rate-limit payloads to the cache and chains output', () => {
  const { configDir, usageDir } = dirs();
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'cat >/dev/null; echo CHAINED' } })
  );
  const paths = tap.ensureStatuslineTap(configDir, usageDir);

  const payload = JSON.stringify({
    model: { id: 'claude-opus-4-8' },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1900000000 },
      seven_day: { used_percentage: 81.5, resets_at: 1900300000 },
    },
  });
  const out = execFileSync('/bin/sh', [paths.scriptFile], { input: payload }).toString();
  expect(out.trim()).toBe('CHAINED');

  const cached = JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8'));
  expect(cached.rate_limits.five_hour.used_percentage).toBe(42);
  // Privacy: the cache holds only the statusline payload — no credential keys.
  expect(JSON.stringify(cached)).not.toMatch(/accessToken|refreshToken/);

  // Payloads without rate_limits must not clobber the last known-good cache.
  execFileSync('/bin/sh', [paths.scriptFile], {
    input: JSON.stringify({ model: { id: 'claude-opus-4-8' } }),
  });
  const after = JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8'));
  expect(after.rate_limits.seven_day.used_percentage).toBe(81.5);
});

test('tap script writes every payload to the one cache file', () => {
  const { configDir, usageDir } = dirs();
  const paths = tap.ensureStatuslineTap(configDir, usageDir);
  const payload = (pct) =>
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: 1900000000 } } });

  execFileSync('/bin/sh', [paths.scriptFile], { input: payload(10) });
  expect(JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8')).rate_limits.five_hour.used_percentage).toBe(10);

  // Every lane runs on the machine's ambient login, so a later payload simply
  // updates the same file — no per-account fan-out.
  execFileSync('/bin/sh', [paths.scriptFile], { input: payload(55) });
  expect(JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8')).rate_limits.five_hour.used_percentage).toBe(55);
  expect(fs.readdirSync(usageDir).filter((f) => f.endsWith('.json') && f.includes('.acct-'))).toEqual([]);
});

test('removeStatuslineTap restores the original statusLine', () => {
  const { configDir, usageDir } = dirs();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } })
  );
  const paths = tap.ensureStatuslineTap(configDir, usageDir);

  tap.removeStatuslineTap(configDir, usageDir);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  expect(settings.statusLine).toEqual({ type: 'command', command: 'echo mine' });
  expect(fs.existsSync(paths.scriptFile)).toBe(false);
  expect(fs.existsSync(paths.backupFile)).toBe(false);
});
