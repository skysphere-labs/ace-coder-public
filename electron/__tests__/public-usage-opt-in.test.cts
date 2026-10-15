import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../usage-core.cts');
const tap = require('../usage-statusline-tap.cts');
const { createUsageEvents } = require('../usage-events.cts');

let root = '';
let profile = '';
let fakeHome = '';
let savedEnv = {};
const instances = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-usage-opt-in-'));
  fakeHome = path.join(root, 'synthetic-home');
  profile = path.join(root, 'public-profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fixture@example.invalid' } }));
  savedEnv = { ACE_HOME: process.env.ACE_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.ACE_HOME = profile;
  delete process.env.CLAUDE_CONFIG_DIR;
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  core.invalidateUsageCache();
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  core.invalidateUsageCache();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it('fresh boot reads only its usage preference, without provider reads, tap writes, scans, or watchers', async () => {
  const ensureTap = vi.spyOn(tap, 'ensureStatuslineTap');
  const readFile = vi.spyOn(fs, 'readFileSync');
  const stat = vi.spyOn(fs, 'statSync');
  const watch = vi.spyOn(fs, 'watch');
  const scan = vi.fn();
  const events = createUsageEvents({ scan, fallbackMs: 0 });
  instances.push(events);
  const reports = [];
  events.subscribe((report) => reports.push(report));
  events.start();
  await events.pump();
  const report = await core.getProviderUsage();
  expect(report).toMatchObject({ providers: [], enabled: false, reason: 'disabled' });
  expect(reports.every((item) => item.enabled === false)).toBe(true);
  expect(scan).not.toHaveBeenCalled();
  expect(ensureTap).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
  expect(readFile.mock.calls.every(([file]) => file === path.join(profile, 'usage-settings.json'))).toBe(true);
});

it('requires a valid boolean opt-in in this profile', async () => {
  for (const content of ['{ broken', '{}', '{"enabled":false}', '{"enabled":"true"}', '{"enabled":1}']) {
    fs.writeFileSync(path.join(profile, 'usage-settings.json'), content);
    expect(core.isProviderUsageEnabled()).toBe(false);
    expect((await core.getProviderUsage()).providers).toEqual([]);
  }
  fs.mkdirSync(path.join(fakeHome, '.ace'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ace', 'usage-settings.json'), '{"enabled":true}');
  expect(core.isProviderUsageEnabled()).toBe(false);
});

it('explicit opt-in enables synthetic provider scanning, tap installation, and source watchers', async () => {
  // Reset the per-process disabled state before opting this synthetic profile in.
  await core.getProviderUsage();
  fs.writeFileSync(path.join(profile, 'usage-settings.json'), '{"enabled":true}');
  const ensureTap = vi.spyOn(tap, 'ensureStatuslineTap');
  const report = await core.getProviderUsage();
  expect(report.enabled).toBe(true);
  expect(report.providers.find((provider) => provider.id === 'claude').accountLabel).toBe('fixture@example.invalid');
  expect(ensureTap).toHaveBeenCalledOnce();
  const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  expect(settings.statusLine.command.startsWith(path.join(profile, 'usage'))).toBe(true);

  const close = vi.fn();
  const fsImpl = {
    statSync: vi.fn(() => ({ isDirectory: () => true, ino: 1 })),
    watch: vi.fn(() => ({ on() {}, close })),
  };
  const scan = vi.fn(async () => report);
  const events = createUsageEvents({ fsImpl, scan, fallbackMs: 0 });
  instances.push(events);
  events.start();
  await Promise.resolve();
  expect(fsImpl.watch).toHaveBeenCalledTimes(2);
  expect(scan).toHaveBeenCalledOnce();
  fs.writeFileSync(path.join(profile, 'usage-settings.json'), '{"enabled":false}');
  await events.pump();
  expect(close).toHaveBeenCalledTimes(2);
  expect(scan).toHaveBeenCalledOnce();
  expect((await core.getProviderUsage()).providers).toEqual([]);
});
