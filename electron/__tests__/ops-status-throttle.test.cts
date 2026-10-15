/**
 * ops-status-throttle.test.cts
 *
 * Pinger closure: the service probe must reuse a cached LIVE result per
 * endpoint for a minimum interval so a burst of renderer refreshes cannot
 * hammer configured endpoints. The daily-snapshot path (forceRefresh:true)
 * bypasses the cache. HTTP is stubbed via the httpGet ctx seam (no real I/O).
 *
 * Runs via: npx vitest run electron/__tests__/ops-status-throttle.test.cts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  runOpsStatus,
  __resetServiceProbeCache,
  SERVICE_PROBE_MIN_INTERVAL_MS,
} = require('../ops-status.cts');

/** @type {string[]} */
const createdPaths = [];

function writeConfig(config) {
  const p = path.join(
    os.tmpdir(),
    `ops-throttle-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(p, JSON.stringify(config), 'utf8');
  createdPaths.push(p);
  return p;
}

// A counting httpGet stub — always a healthy 200, records invocation count.
function countingGet() {
  const calls = { count: 0 };
  const get = () => {
    calls.count += 1;
    return Promise.resolve({ ok: true, status: 200, error: null });
  };
  return { get, calls };
}

const CONFIG = { endpoints: [{ id: 'probe-a', url: 'http://127.0.0.1:65500/health' }] };

beforeEach(() => {
  __resetServiceProbeCache();
});

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe('service probe throttle (pinger closure)', () => {
  it('probes an endpoint once for two status reads within the min interval', async () => {
    const configPath = writeConfig(CONFIG);
    const { get, calls } = countingGet();

    await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1000 });
    await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1500 });

    expect(calls.count).toBe(1);
  });

  it('re-probes once the min interval has elapsed', async () => {
    const configPath = writeConfig(CONFIG);
    const { get, calls } = countingGet();

    await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1000 });
    await runOpsStatus({
      probes: ['service'],
      configPath,
      httpGet: get,
      now: 1000 + SERVICE_PROBE_MIN_INTERVAL_MS + 1,
    });

    expect(calls.count).toBe(2);
  });

  it('forceRefresh bypasses the cache (daily snapshot path)', async () => {
    const configPath = writeConfig(CONFIG);
    const { get, calls } = countingGet();

    await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1000 });
    await runOpsStatus({
      probes: ['service'],
      configPath,
      httpGet: get,
      now: 1500,
      forceRefresh: true,
    });

    expect(calls.count).toBe(2);
  });

  it('returns the cached finding unchanged on a hit (honest lastChecked)', async () => {
    const configPath = writeConfig(CONFIG);
    const { get } = countingGet();

    const first = await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1000 });
    const second = await runOpsStatus({ probes: ['service'], configPath, httpGet: get, now: 1500 });

    const firstFinding = first.findings.find((f) => f.id === 'service.probe-a');
    const secondFinding = second.findings.find((f) => f.id === 'service.probe-a');
    expect(firstFinding).toBeTruthy();
    // Same object identity → the cached probe time is preserved, not re-stamped.
    expect(secondFinding.evidence.lastChecked).toBe(firstFinding.evidence.lastChecked);
  });
});
