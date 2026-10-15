// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// NOTE: never import better-sqlite3 (native module, not built in CI
// worktrees). The store takes an injected opener, so tests run against
// node:sqlite's DatabaseSync — same prepare().run()/get()/all() surface the
// runtime better-sqlite3 opener provides.
import { DatabaseSync } from 'node:sqlite';

const telemetry = require('../telemetry.cts');

const NOW = Date.parse('2026-06-09T12:00:00.000Z');
const DAY_MS = 86_400_000;

function tmpDir(prefix = 'ace-telemetry-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sqliteOpen(dbPath) {
  return new DatabaseSync(dbPath);
}

function makeStore(overrides = {}) {
  const dir = overrides.dir || tmpDir();
  const store = telemetry.createTelemetryStore({
    dir,
    openDb: sqliteOpen,
    now: () => NOW,
    ...overrides,
  });
  return { dir, store };
}

// ── redactSecrets ────────────────────────────────────────────────────────────

test('redactSecrets strips token literals, auth headers, cred URLs, and key=value secrets', () => {
  const cases = [
    ['push with ghp_abcdefghijklmnopqrstuvwx123456 done', 'ghp_abcdefghijklmnopqrstuvwx123456'],
    ['pat github_pat_11ABCDEFG0123456789abcdefghij', 'github_pat_11ABCDEFG0123456789abcdefghij'],
    ['key sk-ant-api03-veryverysecretkey1234', 'sk-ant-api03-veryverysecretkey1234'],
    ['slack xoxb-1234567890-abcdefghijk', 'xoxb-1234567890-abcdefghijk'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['header Authorization: Bearer abc.def-ghi_jkl123', 'abc.def-ghi_jkl123'],
    ['clone https://oauth2:s3cretpass@github.com/x/y.git', 's3cretpass'],
    ['hit https://api.example.com/v1?access_token=topsecret123&x=1', 'topsecret123'],
    ['env ACE_TOKEN=deadbeefcafe in shell', 'deadbeefcafe'],
    // Lowercase / value-position carriers (fixback for PR #433 review).
    ['login with password=hunter2 failed', 'hunter2'],
    ['set aws_secret_access_key=wJalrXUtnFEMIK7MDENG', 'wJalrXUtnFEMIK7MDENG'],
    ['ran tool --password=swordfish99 --retry', 'swordfish99'],
    // Lone-userinfo URL: the whole userinfo is credential-equivalent.
    ['fetch https://LONEUSERINFOSECRET@internal.host/path', 'LONEUSERINFOSECRET'],
    // Dashed compound assignment names (fixback round 2 for PR #433).
    ['ran tool --api-key=apikeyleak123 now', 'apikeyleak123'],
    ['ran tool --access-key=accesskeyleak456', 'accesskeyleak456'],
    ['ran tool --private-key=privkeyleak789', 'privkeyleak789'],
  ];
  for (const [input, secret] of cases) {
    const out = telemetry.redactSecrets(input);
    expect(out, `input: ${input}`).not.toContain(secret);
    expect(out).toContain('[redacted]');
  }
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  expect(telemetry.redactSecrets(`cert ${key} end`)).not.toContain('MIIEow');
  // Plain operational text passes through untouched.
  expect(telemetry.redactSecrets('agent alpha exited 0 in 1200ms')).toBe(
    'agent alpha exited 0 in 1200ms'
  );
});

// ── normalizeEvent (the typed tagged schema) ─────────────────────────────────

test('normalizeEvent applies schema defaults and drops malformed events', () => {
  const event = telemetry.normalizeEvent({ type: 'agent.exit', ok: false, durationMs: 12.7 }, NOW);
  expect(event).toMatchObject({
    ts: NOW,
    type: 'agent.exit',
    project: null,
    agent: null,
    lane: null,
    mission: null,
    stream: null,
    source: null,
    severity: 'info',
    durationMs: 13,
    tokensIn: null,
    tokensOut: null,
    ok: false,
    errorClass: null,
    meta: null,
  });
  expect(telemetry.normalizeEvent({ ok: true }, NOW)).toBeNull();
  expect(telemetry.normalizeEvent({ type: '   ' }, NOW)).toBeNull();
  expect(telemetry.normalizeEvent({ type: 'x', severity: 'fatal' }, NOW).severity).toBe('info');
  expect(telemetry.normalizeEvent({ type: 'x', ok: 'yes' }, NOW).ok).toBeNull();
  expect(telemetry.normalizeEvent({ type: 'x', durationMs: -5 }, NOW).durationMs).toBeNull();
});

test('normalizeEvent bounds meta: secret keys, depth, key count, serialized size', () => {
  const big = telemetry.normalizeEvent(
    {
      type: 'x',
      meta: {
        apiToken: 'super-secret-value',
        okText: 'fine',
        nested: { deep: { deeper: 'dropped' }, kept: 1 },
        list: [1, 2, 3],
      },
    },
    NOW
  );
  const meta = JSON.parse(big.meta);
  expect(meta.apiToken).toBe('[redacted]');
  expect(meta.okText).toBe('fine');

  // access-key family in every casing convention is credential-shaped: the
  // VALUE is blanked even when it has no recognizable token shape.
  const accessKeys = telemetry.normalizeEvent(
    {
      type: 'x',
      meta: {
        accessKey: 'plain-shaped-aws-secret-1',
        'access-key': 'plain-shaped-aws-secret-2',
        ACCESS_KEY: 'plain-shaped-aws-secret-3',
        accesskey: 'plain-shaped-aws-secret-4',
      },
    },
    NOW
  );
  expect(accessKeys.meta).not.toContain('plain-shaped-aws-secret');
  for (const value of Object.values(JSON.parse(accessKeys.meta))) {
    expect(value).toBe('[redacted]');
  }
  expect(meta.nested.kept).toBe(1);
  expect(meta.nested.deep).toBeUndefined();
  expect(meta.list).toBeUndefined();

  const oversized = telemetry.normalizeEvent(
    { type: 'x', meta: { a: 'y'.repeat(500), b: 'y'.repeat(500), c: 'y'.repeat(500), d: 'y'.repeat(500), e: 'y'.repeat(500) } },
    NOW
  );
  expect(JSON.parse(oversized.meta)).toEqual({ truncated: true });
});

test('boundMeta sanitizes key NAMES: embedded tokens redacted, over-long keys clamped', () => {
  const token = 'ghp_keynameleak0123456789abcdefgh';
  // Accidental key/value swap and a URL-with-token used as a key.
  const event = telemetry.normalizeEvent(
    {
      type: 'x',
      meta: {
        [token]: true,
        [`https://${token}@github.com/x/y.git`]: 'clone target',
        ['k'.repeat(300)]: 'long-key value',
        plain: 'kept',
      },
    },
    NOW
  );
  expect(event.meta).not.toContain(token);
  const meta = JSON.parse(event.meta);
  expect(meta.plain).toBe('kept');
  const keys = Object.keys(meta);
  expect(keys.some((k) => k.includes('[redacted]'))).toBe(true);
  // Over-long keys are clamped to the key-length bound.
  expect(keys.every((k) => k.length <= 100)).toBe(true);
  expect(meta['k'.repeat(100)]).toBe('long-key value');
});

// ── emit + query roundtrip ───────────────────────────────────────────────────

test('emit persists events to sqlite and day-keyed ndjson; query reads them back', () => {
  const { dir, store } = makeStore();
  expect(
    store.emit({
      type: 'agent.exit',
      agent: 'alpha',
      stream: 's1',
      project: 'ws1',
      ok: false,
      errorClass: 'exit-1',
      durationMs: 1200,
      meta: { code: 1 },
    })
  ).toBe(true);
  expect(store.emit({ type: 'agent.spawn', agent: 'beta', stream: 's2', ok: true })).toBe(true);
  // Malformed events are dropped, never thrown.
  expect(store.emit({ agent: 'no-type' })).toBe(false);
  expect(store.emit(null)).toBe(false);

  const all = store.query({ sinceMs: NOW - DAY_MS });
  expect(all.ok).toBe(true);
  expect(all.total).toBe(2);
  expect(all.events).toHaveLength(2);

  const exits = store.query({ type: 'agent.exit' });
  expect(exits.total).toBe(1);
  expect(exits.events[0]).toMatchObject({
    type: 'agent.exit',
    agent: 'alpha',
    stream: 's1',
    project: 'ws1',
    ok: false,
    errorClass: 'exit-1',
    durationMs: 1200,
    meta: { code: 1 },
  });
  expect(store.query({ ok: true }).total).toBe(1);
  expect(store.query({ agent: 'nobody' }).total).toBe(0);
  expect(store.query({ limit: 1 }).events).toHaveLength(1);
  expect(store.query({ limit: 1 }).total).toBe(2);

  const ndjsonPath = path.join(dir, `events-${new Date(NOW).toISOString().slice(0, 10)}.ndjson`);
  const lines = fs.readFileSync(ndjsonPath, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).type).toBe('agent.exit');
});

test('redaction proof: secrets in tags and meta never reach sqlite or ndjson on disk', () => {
  const { dir, store } = makeStore();
  const secrets = [
    'ghp_leakleakleakleakleak12345678',
    'supersecretpassword99',
    'xoxb-9999999999-leakyleaky',
    'lowercasehunter2',
    'wJalrXUtnFEMIK7MDENGleak',
    'cliflagswordfish',
    'loneuserinfoleakvalue',
    'dashedapikeyleak',
  ];
  store.emit({
    type: 'task.dispatch',
    agent: `worker Bearer ${secrets[0]}`,
    errorClass: `clone failed for https://user:${secrets[1]}@github.com/x/y.git`,
    meta: {
      authToken: secrets[2],
      note: `retry with ?api_key=${secrets[1]}&page=2`,
      // Lowercase / value-position carriers + a secret embedded in a key name.
      loginLog: `password=${secrets[3]} rejected`,
      awsEnv: `aws_secret_access_key=${secrets[4]}`,
      cliArgs: `--password=${secrets[5]} --retry`,
      remote: `https://${secrets[6]}@internal.host/repo.git`,
      toolArgs: `--api-key=${secrets[7]} --verbose`,
      [`key-${secrets[0]}`]: 'value for a token-bearing key',
    },
  });
  store.close();
  // Scan every byte the store wrote (db + wal/shm + ndjson): no secret may
  // survive anywhere on disk.
  for (const name of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, name), 'latin1');
    for (const secret of secrets) {
      expect(raw, `${name} must not contain ${secret}`).not.toContain(secret);
    }
  }
  // And nothing leaks back out of the read surface either.
  const { store: reread } = makeStore({ dir });
  const dump = JSON.stringify(reread.query({}));
  for (const secret of secrets) expect(dump).not.toContain(secret);
  expect(dump).toContain('[redacted]');
});

// ── retention / rotation ─────────────────────────────────────────────────────

test('retention sweep deletes sqlite rows and ndjson day files older than the window', () => {
  let clock = NOW;
  const dir = tmpDir();
  const store = telemetry.createTelemetryStore({ dir, openDb: sqliteOpen, now: () => clock });
  store.emit({ type: 'old.event' });
  const oldFile = path.join(dir, `events-${new Date(NOW).toISOString().slice(0, 10)}.ndjson`);
  expect(fs.existsSync(oldFile)).toBe(true);

  clock = NOW + 100 * DAY_MS; // jump past the 90-day window
  store.emit({ type: 'fresh.event' });

  const events = store.query({ sinceMs: 0 });
  expect(events.total).toBe(1);
  expect(events.events[0].type).toBe('fresh.event');
  expect(fs.existsSync(oldFile)).toBe(false);
  const freshFile = path.join(dir, `events-${new Date(clock).toISOString().slice(0, 10)}.ndjson`);
  expect(fs.existsSync(freshFile)).toBe(true);
});

// ── aggregate ────────────────────────────────────────────────────────────────

test('aggregate derives per-dimension counts, error totals, durations, and token sums on read', () => {
  const { store } = makeStore();
  store.emit({ type: 'agent.exit', agent: 'alpha', ok: true, durationMs: 100, tokensIn: 10, tokensOut: 5 });
  store.emit({ type: 'agent.exit', agent: 'alpha', ok: false, durationMs: 300, errorClass: 'exit-1' });
  store.emit({ type: 'agent.exit', agent: 'beta', severity: 'error' });
  store.emit({ type: 'ops.refresh', ok: true });

  const byType = store.aggregate({ groupBy: 'type' });
  expect(byType.ok).toBe(true);
  expect(byType.rows[0]).toMatchObject({ key: 'agent.exit', count: 3, errors: 2 });
  expect(byType.rows.find((r) => r.key === 'ops.refresh')).toMatchObject({ count: 1, errors: 0 });

  const byAgent = store.aggregate({ groupBy: 'agent' });
  const alphaRow = byAgent.rows.find((r) => r.key === 'alpha');
  expect(alphaRow).toMatchObject({ count: 2, errors: 1, avgDurationMs: 200, tokensIn: 10, tokensOut: 5 });

  // Dimension allowlist: caller input never reaches SQL.
  const bad = store.aggregate({ groupBy: 'ts; DROP TABLE telemetry_events' });
  expect(bad.ok).toBe(false);
  expect(bad.error).toContain('unknown groupBy');
  expect(store.query({}).total).toBe(4);
});

// ── module singleton (the additive emit() wiring surface) ────────────────────

test('telemetryEmit is a silent no-op before init and live after initTelemetry', () => {
  expect(telemetry.telemetryEmit({ type: 'x' })).toBe(false);
  expect(telemetry.telemetryQuery({}).ok).toBe(false);

  const dir = tmpDir();
  telemetry.initTelemetry({ dir, openDb: sqliteOpen, now: () => NOW });
  expect(telemetry.telemetryEmit({ type: 'mission.transition', mission: 'msn-1' })).toBe(true);

  const result = telemetry.telemetryQuery({ type: 'mission.transition' });
  expect(result.ok).toBe(true);
  expect(result.events[0].mission).toBe('msn-1');

  const agg = telemetry.telemetryQuery({ kind: 'aggregate', groupBy: 'mission' });
  expect(agg.ok).toBe(true);
  expect(agg.rows[0]).toMatchObject({ key: 'msn-1', count: 1 });

  // Reset the singleton so later test files never inherit a live store.
  telemetry.getTelemetryStore().close();
  telemetry.initTelemetry({});
  expect(telemetry.telemetryEmit({ type: 'x' })).toBe(false);
});

test('store degrades without throwing when the db opener fails', () => {
  const dir = tmpDir();
  const store = telemetry.createTelemetryStore({
    dir,
    openDb: () => {
      throw new Error('native module missing');
    },
    now: () => NOW,
  });
  // ndjson sink still accepts the event; query reports the db error honestly.
  expect(store.emit({ type: 'x' })).toBe(true);
  expect(fs.readdirSync(dir).some((f) => f.endsWith('.ndjson'))).toBe(true);
  const result = store.query({});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('native module missing');
});
