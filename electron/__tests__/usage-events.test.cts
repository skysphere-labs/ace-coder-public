import { test, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { createUsageEvents, defaultWatchTargets } = require('../usage-events.cts');

let tmp = '';
let instances = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-usage-events-'));
});
afterEach(() => {
  for (const inst of instances.splice(0)) {
    try { inst.stop(); } catch { /* already stopped */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

function makeEvents(overrides = {}) {
  const calls = { invalidate: 0, scan: 0 };
  const reports = [];
  const events = createUsageEvents({
    isEnabled: () => true,
    debounceMs: 40,
    fallbackMs: 0, // no fallback timer in tests unless a test opts in
    invalidate: () => { calls.invalidate += 1; },
    scan: async () => {
      calls.scan += 1;
      return { providers: [], generatedAt: calls.scan };
    },
    ...overrides,
  });
  instances.push(events);
  return { events, calls, reports };
}

test('source file change invalidates the cache and publishes one typed report', async () => {
  const claudeDir = path.join(tmp, 'usage');
  fs.mkdirSync(claudeDir, { recursive: true });
  const { events, calls, reports } = makeEvents({
    targets: [
      { id: 'claude-tap', dir: claudeDir, recursive: false, match: (n) => n.endsWith('.json') },
    ],
  });
  events.subscribe((report) => reports.push(report));
  events.start();
  await waitFor(() => reports.length === 1); // initial pump

  fs.writeFileSync(path.join(claudeDir, 'claude-abc.json'), '{}');
  await waitFor(() => reports.length >= 2);
  expect(calls.invalidate).toBeGreaterThanOrEqual(2);
  expect(reports[1].generatedAt).toBe(calls.scan);
});

test('a burst of writes coalesces into a single rescan', async () => {
  const dir = path.join(tmp, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const { events, calls, reports } = makeEvents({
    targets: [{ id: 'codex', dir, recursive: false, match: (n) => n.endsWith('.jsonl') }],
  });
  events.subscribe((r) => reports.push(r));
  events.start();
  await waitFor(() => reports.length === 1);

  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(dir, 'rollout-1.jsonl'), `line-${i}\n`, { flag: 'a' });
  }
  await sleep(300);
  // 1 initial + 1 coalesced burst scan (never 10).
  expect(calls.scan).toBeLessThanOrEqual(3);
  expect(reports.length).toBeLessThanOrEqual(3);
  expect(reports.length).toBeGreaterThanOrEqual(2);
});

test('non-matching filenames are ignored', async () => {
  const dir = path.join(tmp, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  const { events, calls } = makeEvents({
    targets: [{ id: 'claude-tap', dir, recursive: false, match: (n) => /^claude-.*\.json$/.test(n) }],
  });
  events.start();
  await waitFor(() => calls.scan === 1);

  fs.writeFileSync(path.join(dir, 'statusline-tap-x.sh'), '#!/bin/sh\n');
  await sleep(200);
  expect(calls.scan).toBe(1); // no rescan for a non-source write
});

test('overlapping scans serialize: writes during a scan trigger exactly one follow-up', async () => {
  const dir = path.join(tmp, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  let resolveScan = null;
  const calls = { scan: 0 };
  const reports = [];
  const events = createUsageEvents({
    isEnabled: () => true,
    debounceMs: 10,
    fallbackMs: 0,
    invalidate: () => {},
    scan: () => {
      calls.scan += 1;
      if (calls.scan === 2) {
        // Block the second scan so the pump is provably mid-flight.
        return new Promise((resolve) => { resolveScan = resolve; });
      }
      return Promise.resolve({ providers: [], generatedAt: calls.scan });
    },
    targets: [{ id: 't', dir, recursive: false, match: () => true }],
  });
  instances.push(events);
  events.subscribe((r) => reports.push(r));
  events.start();
  await waitFor(() => reports.length === 1);

  fs.writeFileSync(path.join(dir, 'a.json'), '1');
  await waitFor(() => calls.scan === 2 && resolveScan !== null);
  // Scan 2 is in flight; new bursts mark dirty rather than interleaving.
  events.schedule();
  await sleep(30);
  events.schedule();
  await sleep(30);
  expect(calls.scan).toBe(2);
  resolveScan({ providers: [], generatedAt: 2 });
  await waitFor(() => calls.scan === 3); // exactly one follow-up for the dirty window
  await sleep(100);
  expect(calls.scan).toBe(3);
});

test('missing directory arms later and a deleted directory re-arms without leaking watchers', async () => {
  const dir = path.join(tmp, 'not-yet');
  const { events, calls } = makeEvents({
    targets: [{ id: 'late', dir, recursive: false, match: () => true }],
    fallbackMs: 60, // fast fallback tick doubles as the re-arm loop
  });
  events.start();
  expect(events._watcherCount()).toBe(0);

  fs.mkdirSync(dir, { recursive: true });
  await waitFor(() => events._watcherCount() === 1);

  fs.writeFileSync(path.join(dir, 'x.json'), '{}');
  await waitFor(() => calls.scan >= 2);

  fs.rmSync(dir, { recursive: true, force: true });
  await waitFor(() => events._watcherCount() === 0);

  fs.mkdirSync(dir, { recursive: true });
  await waitFor(() => events._watcherCount() === 1);
});

test('stop tears down watchers and timers so no further scans fire', async () => {
  const dir = path.join(tmp, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  const { events, calls } = makeEvents({
    targets: [{ id: 't', dir, recursive: false, match: () => true }],
    fallbackMs: 50,
  });
  events.start();
  await waitFor(() => calls.scan >= 1);
  events.stop();
  const scans = calls.scan;
  expect(events._watcherCount()).toBe(0);
  fs.writeFileSync(path.join(dir, 'x.json'), '{}');
  await sleep(200);
  expect(calls.scan).toBe(scans);
});

test('a scan in flight when stop() lands neither emits nor runs the dirty follow-up', async () => {
  let resolveScan;
  let scans = 0;
  const events = createUsageEvents({
    isEnabled: () => true,
    targets: [],
    debounceMs: 1,
    fallbackMs: 0,
    invalidate: () => {},
    scan: () => {
      scans += 1;
      return new Promise((resolve) => { resolveScan = resolve; });
    },
  });
  instances.push(events);
  const reports = [];
  events.subscribe((r) => reports.push(r));
  events.start(); // initial pump; the scan hangs until we resolve it
  await waitFor(() => scans === 1);
  void events.pump(); // burst mid-scan -> dirty follow-up queued
  events.stop();
  resolveScan({ providers: [], generatedAt: 1 });
  await sleep(50);
  expect(reports.length).toBe(0); // nothing broadcast after teardown
  expect(scans).toBe(1); // the dirty follow-up never ran
});

test('default watch targets cover the claude tap dir and codex sessions tree', () => {
  const targets = defaultWatchTargets();
  const ids = targets.map((t) => t.id).sort();
  expect(ids).toEqual(['claude-tap', 'codex-sessions']);
  const claude = targets.find((t) => t.id === 'claude-tap');
  const codex = targets.find((t) => t.id === 'codex-sessions');
  expect(claude.match('claude-abc123.json')).toBe(true);
  expect(claude.match('statusline-tap-abc.sh')).toBe(false);
  expect(claude.recursive).toBe(false);
  expect(codex.match('rollout-2026.jsonl')).toBe(true);
  expect(codex.match('meta.json')).toBe(false);
  expect(codex.recursive).toBe(true);
});

test('a throwing subscriber never breaks other sinks', async () => {
  const dir = path.join(tmp, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  const { events } = makeEvents({
    targets: [{ id: 't', dir, recursive: false, match: () => true }],
  });
  const seen = [];
  events.subscribe(() => { throw new Error('bad sink'); });
  events.subscribe((r) => seen.push(r));
  events.start();
  await waitFor(() => seen.length === 1);
  expect(seen[0].providers).toEqual([]);
});
