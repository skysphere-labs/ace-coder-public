/**
 * ops-status.test.cts
 *
 * Unit tests for the service-probe honesty contract in ops-status.cts
 * (GoalAgentSpec F1/F2/F3):
 *   - missing/empty ops-config.json -> honest yellow 'service.unconfigured'
 *     (status 'setup-required'), never a green skip;
 *   - missing config never probes implicit operator services;
 *   - configured endpoints record latencyMs + url on success and failure and
 *     honor severityOnFail.
 *
 * HTTP layer is stubbed via the `httpGet` ctx seam (no real network I/O).
 * Tests run only the `service` probe so runtime/fd/db/ci logic stays untouched.
 *
 * Runs via: npx vitest run electron/__tests__/ops-status.test.cts
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  runOpsStatus,
  __resetServiceProbeCache,
} = require('../ops-status.cts');

// The service probe now caches LIVE results per endpoint for a min interval
// (pinger closure). These cases reuse endpoint ids within one wall-clock second
// with different stubbed responses, so clear the throttle cache between them.
beforeEach(() => {
  __resetServiceProbeCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @type {string[]} */
const createdPaths = [];

/**
 * @param {string} suffix
 * @returns {string}
 */
function tmpConfigPath(suffix) {
  const p = path.join(os.tmpdir(), `ops-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}.json`);
  createdPaths.push(p);
  return p;
}

/**
 * @param {any} config
 * @returns {string}
 */
function writeConfig(config) {
  const p = tmpConfigPath('config');
  fs.writeFileSync(p, JSON.stringify(config), 'utf8');
  return p;
}

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

// httpGet-shaped stubs. Each records its calls so tests can assert which URLs
// were actually probed.
/**
 * @param {{ ok: boolean, status: number | null, error: string | null }} result
 */
function stubHttp(result) {
  /** @type {Array<{ url: string, timeoutMs: number }>} */
  const calls = [];
  const get = async (url, timeoutMs) => {
    calls.push({ url, timeoutMs });
    return { ...result };
  };
  return { get, calls };
}

/**
 * @param {any} payload
 * @param {string} id
 * @returns {any}
 */
function findById(payload, id) {
  return payload.findings.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// F1: missing config -> honest setup-required finding, rollup never green
// ---------------------------------------------------------------------------

describe('service probe with missing ops-config.json', () => {
  it('emits service.unconfigured (yellow, setup-required) naming the config path', async () => {
    const missingPath = tmpConfigPath('missing'); // never written
    const http = stubHttp({ ok: false, status: null, error: 'connection refused' });
    const payload = await runOpsStatus({ probes: 'service', configPath: missingPath, httpGet: http.get });

    const finding = findById(payload, 'service.unconfigured');
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('yellow');
    expect(finding.status).toBe('setup-required');
    expect(finding.title).toBe('Service monitoring not configured');
    expect(finding.message).toContain(missingPath);
    expect(finding.recommendedAction).toContain(missingPath);
    expect(finding.details.configMissing).toBe(true);
    expect(finding.details.configPath).toBe(missingPath);
  });

  it('does not probe any service until endpoints are explicitly configured', async () => {
    const missingPath = tmpConfigPath('missing');
    const http = stubHttp({ ok: true, status: 200, error: null });
    const payload = await runOpsStatus({ probes: 'service', configPath: missingPath, httpGet: http.get });
    expect(http.calls).toHaveLength(0);
    expect(payload.findings.filter((f) => f.category === 'service')).toHaveLength(1);
    expect(payload.rollup.severity).toBe('yellow');
  });

  it('rollup is not green when config is missing', async () => {
    const missingPath = tmpConfigPath('missing');
    const http = stubHttp({ ok: false, status: null, error: 'connection refused' });
    const payload = await runOpsStatus({ probes: 'service', configPath: missingPath, httpGet: http.get });
    expect(payload.rollup.severity).not.toBe('green');
    expect(payload.rollup.severity).toBe('yellow');
  });
});

// ---------------------------------------------------------------------------
// F1: config exists but has zero endpoints -> same honest finding, no defaults
// ---------------------------------------------------------------------------

describe('service probe with empty-endpoints config', () => {
  it('emits service.unconfigured and does not probe shipped defaults', async () => {
    const configPath = writeConfig({ schema: 'ace.ops-config.v1', enabled: true, endpoints: [] });
    const http = stubHttp({ ok: false, status: null, error: 'connection refused' });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.unconfigured');
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('yellow');
    expect(finding.status).toBe('setup-required');
    expect(finding.details.configMissing).toBe(false);

    // An explicit empty endpoints list means the user opted out of the
    // shipped defaults; only the unconfigured finding appears.
    const serviceFindings = payload.findings.filter((f) => f.category === 'service');
    expect(serviceFindings).toHaveLength(1);
    expect(http.calls).toHaveLength(0);

    expect(payload.rollup.severity).not.toBe('green');
  });
});

// ---------------------------------------------------------------------------
// F2: configured endpoints — latency recorded, severityOnFail honored
// ---------------------------------------------------------------------------

describe('service probe with configured endpoints', () => {
  it('reports green with latencyMs + url on success', async () => {
    const url = 'http://127.0.0.1:4242/health';
    const configPath = writeConfig({ endpoints: [{ id: 'myapi', url, timeoutMs: 1500 }] });
    const http = stubHttp({ ok: true, status: 200, error: null });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.myapi');
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('green');
    expect(finding.status).toBe('ok');
    expect(typeof finding.details.latencyMs).toBe('number');
    expect(finding.details.url).toBe(url);
    expect(finding.message).toMatch(/in \d+ms/);
    expect(http.calls).toEqual([{ url, timeoutMs: 1500 }]);
    expect(payload.rollup.severity).toBe('green');
  });

  it('honors severityOnFail and still records latencyMs + url on failure', async () => {
    const url = 'http://127.0.0.1:4242/health';
    const configPath = writeConfig({ endpoints: [{ id: 'myapi', url, severityOnFail: 'yellow' }] });
    const http = stubHttp({ ok: false, status: 503, error: 'service unavailable' });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.myapi');
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('yellow');
    expect(finding.status).toBe('fail');
    expect(typeof finding.details.latencyMs).toBe('number');
    expect(finding.details.url).toBe(url);
    expect(finding.details.error).toBe('service unavailable');
    expect(payload.rollup.severity).toBe('yellow');
  });

  it('defaults severityOnFail to red', async () => {
    const url = 'http://127.0.0.1:4242/health';
    const configPath = writeConfig({ endpoints: [{ id: 'myapi', url }] });
    const http = stubHttp({ ok: false, status: null, error: 'timeout' });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.myapi');
    expect(finding.severity).toBe('red');
    expect(typeof finding.details.latencyMs).toBe('number');
    expect(payload.rollup.severity).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// A1/A3: a DNS-resolution failure on a planned endpoint is a distinct,
// honest "not resolving (DNS)" state — tagged details.dnsUnresolved + a
// planned-aware action — not confused with an application failure. Severity
// stays whatever the owner configured (yellow for a planned endpoint).
// ---------------------------------------------------------------------------

describe('service probe DNS-unresolved (planned endpoint) classification', () => {
  it('tags dnsUnresolved + planned action and keeps the configured severity', async () => {
    const url = 'https://planned.example.test/';
    const configPath = writeConfig({
      endpoints: [{ id: 'planned-endpoint', url, expectStatus: 200, severityOnFail: 'yellow' }],
    });
    const http = stubHttp({
      ok: false,
      status: null,
      error: 'getaddrinfo ENOTFOUND planned.example.test',
    });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.planned-endpoint');
    expect(finding).toBeTruthy();
    // Planned/yellow, never escalated to a hard app failure color.
    expect(finding.severity).toBe('yellow');
    expect(finding.status).toBe('fail');
    expect(finding.details.dnsUnresolved).toBe(true);
    expect(finding.title).toContain('not resolving (DNS)');
    expect(finding.message).toMatch(/does not resolve/i);
    expect(finding.recommendedAction).toMatch(/DNS/);
    expect(finding.recommendedAction).not.toContain('service health');
    // Expected/observed status survive for the row to surface.
    expect(finding.details.expectStatus).toBe(200);
    expect(finding.details.status).toBeNull();
  });

  it('does NOT tag dnsUnresolved for an ordinary HTTP failure', async () => {
    const url = 'http://127.0.0.1:4242/health';
    const configPath = writeConfig({ endpoints: [{ id: 'myapi', url, severityOnFail: 'red' }] });
    const http = stubHttp({ ok: false, status: 503, error: 'service unavailable' });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.myapi');
    expect(finding.details.dnsUnresolved).toBe(false);
    expect(finding.title).toContain('unhealthy');
    expect(finding.recommendedAction).toContain('service health');
  });

  it('flags an expected non-2xx (302 Access gate) as redirectExpected + green', async () => {
    const url = 'https://gate.example.test/api/status';
    const configPath = writeConfig({
      endpoints: [{ id: 'access-gate', url, expectStatus: 302, severityOnFail: 'yellow' }],
    });
    const http = stubHttp({ ok: false, status: 302, error: null });
    const payload = await runOpsStatus({ probes: 'service', configPath, httpGet: http.get });

    const finding = findById(payload, 'service.access-gate');
    // 302 === expectStatus -> healthy green, NOT a broken service.
    expect(finding.severity).toBe('green');
    expect(finding.status).toBe('ok');
    expect(finding.details.redirectExpected).toBe(true);
    expect(finding.details.status).toBe(302);
    expect(finding.details.expectStatus).toBe(302);
  });
});

it('reads only the selected public profile config by default', () => {
  const previous = process.env.ACE_HOME;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-public-ops-'));
  const config = path.join(profile, 'ops-config.json');
  try {
    process.env.ACE_HOME = profile;
    fs.writeFileSync(config, JSON.stringify({ endpoints: [{ id: 'explicit', url: 'https://service.example.test/health' }] }));
    const loaded = require('../ops-status.cts').loadOpsConfig(null, []);
    expect(loaded.resolvedPath).toBe(config);
    expect(loaded.endpoints).toEqual([{ id: 'explicit', url: 'https://service.example.test/health' }]);
  } finally {
    if (previous === undefined) delete process.env.ACE_HOME;
    else process.env.ACE_HOME = previous;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
