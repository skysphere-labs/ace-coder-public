// Operations Cockpit health probes — ace.ops.status.v1.
//
// This module is the SINGLE source of probe logic for the Operations Cockpit.
// It runs inside the Electron runtime and is exposed as the `opsStatus` store
// method (see electron/local-core.cts). Both the `ace ops status` CLI
// command (via the local socket bridge) and the renderer (via an ipcMain
// handler) call this exact code — there is no duplicated probe logic.
//
// Frozen interface: docs/ops/operations-cockpit-contracts.md.
// Severity taxonomy (§1), HealthFinding (§2), status payload (§3), and config
// (§5) field names are load-bearing and must match the contract verbatim.
//
// Hard guardrails honored here:
//   - No hardcoded personal URLs / account ids. Endpoints come from the user's
//     ops-config.json inside the selected ACE_HOME profile; the
//     remote /healthz check fires only when ACE_URL is set.
//   - Read-only: probes observe, they never dispatch/merge/deploy/spawn.
//   - Fail-safe: a missing/unparseable config yields empty endpoints + a
//     warning, never a throw. lsof/gh absent degrade to unknown/yellow with
//     confidence < 1, never a throw.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
// pr-gate.cjs is a compiled CLI artifact that may be absent in dev/test
// checkouts (only the .cts source is tracked). Resolve it lazily and fail-safe
// so loading this module never throws — the CI-drift probe degrades to its
// existing yellow/unknown path instead.
let prGateModule: any = null;
function prGate() {
  if (prGateModule) return prGateModule;
  try {
    prGateModule = require('../tools/ace/src/pr-gate.cjs');
  } catch {
    prGateModule = {
      parseGhJson: (_raw: any, fallback: any) => fallback,
      rollupCheckState: () => 'unknown',
    };
  }
  return prGateModule;
}

const STATUS_SCHEMA = 'ace.ops.status.v1';
const FINDING_SCHEMA = 'ace.ops.health-finding.v1';
const CONFIG_SCHEMA = 'ace.ops-config.v1';

const ALL_PROBES = ['runtime', 'fd', 'db', 'service', 'ci'];

// §5 default thresholds. These mirror ops-config.example.json and are the
// fallback when no config (or no `thresholds` block) is present.
const DEFAULT_THRESHOLDS = {
  fdRatioWarning: 0.7,
  fdRatioCritical: 0.9,
  dbSizeWarnMb: 500,
  dbSizeCritMb: 1000,
  walSizeWarnMb: 200,
  walSizeCritMb: 500,
  snapshotFreshSeconds: 21600,
  snapshotStaleSeconds: 86400,
};

// ---------------------------------------------------------------------------
// Service-probe throttle (pinger closure).
//
// The renderer re-reads ops-status on every core/git/stream event (debounced),
// so opening the Operations tab on a busy workspace could otherwise fire a
// live HTTP probe of every configured endpoint several times a second. To keep
// the cockpit honest WITHOUT hammering endpoints, each endpoint's LIVE probe
// result is cached and reused for a minimum interval; within that window the
// cached finding is returned unchanged, so its evidence.lastChecked still
// reflects the REAL probe time (never a fabricated "now"). The daily snapshot
// path can pass forceRefresh:true to bypass the cache. There is NO timer here —
// the cache is passive and only advances when a caller actually probes.
const SERVICE_PROBE_MIN_INTERVAL_MS = 60_000;
const serviceProbeCache = new Map<string, { finding: any; probedAtMs: number }>();

// Resolve a millisecond clock from the various `now` shapes callers pass
// (number, Date, ISO string, or a () => now thunk used by the snapshot path).
function resolveNowMs(now: any): number {
  try {
    if (typeof now === 'function') return new Date(now()).getTime();
    if (typeof now === 'number') return now;
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'string' && now) return new Date(now).getTime();
  } catch {
    /* fall through to the wall clock */
  }
  return Date.now();
}

// Return a cached finding when the same endpoint was probed within the min
// interval; otherwise run `probe()` live and cache its result. forceRefresh
// (the daily snapshot) always re-probes. No network call is made on a cache hit.
async function cachedServiceProbe(
  key: string,
  nowMs: number,
  forceRefresh: boolean,
  probe: () => Promise<any>,
): Promise<any> {
  if (!forceRefresh) {
    const hit = serviceProbeCache.get(key);
    if (hit && nowMs - hit.probedAtMs < SERVICE_PROBE_MIN_INTERVAL_MS) {
      return hit.finding;
    }
  }
  const finding = await probe();
  serviceProbeCache.set(key, { finding, probedAtMs: nowMs });
  return finding;
}

// Test seam: reset the throttle cache between cases so module-level state does
// not leak across tests.
function __resetServiceProbeCache(): void {
  serviceProbeCache.clear();
}

// ---------------------------------------------------------------------------
// §1 Severity taxonomy
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { green: 0, yellow: 1, red: 2, black: 3 };

// fromHealth() floor: ok→green, degraded→yellow, fail→red. A probe may escalate
// ABOVE this floor (never below) by passing a severity directly to the finding.
function fromHealth(status: string): 'green' | 'yellow' | 'red' {
  switch (status) {
    case 'ok':
      return 'green';
    case 'degraded':
      return 'yellow';
    case 'fail':
      return 'red';
    default:
      // unknown / skipped have no health floor; callers set severity explicitly.
      return 'yellow';
  }
}

// rollupSeverity() = worst-of across findings, rank green<yellow<red<black.
function rollupSeverity(severities: string[]): 'green' | 'yellow' | 'red' | 'black' {
  let worst = 'green';
  for (const sev of severities) {
    if ((SEVERITY_RANK as any)[sev] > (SEVERITY_RANK as any)[worst]) worst = sev;
  }
  return worst as any;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowIso(now?: number): string {
  return new Date(now == null ? Date.now() : now).toISOString();
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeProbes(probes: any): string[] {
  if (!probes) return [...ALL_PROBES];
  const list = Array.isArray(probes)
    ? probes
    : String(probes).split(',');
  const cleaned = list
    .map((p: any) => String(p || '').trim().toLowerCase())
    .filter((p: string) => ALL_PROBES.includes(p));
  return cleaned.length ? Array.from(new Set(cleaned)) : [...ALL_PROBES];
}

function toMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

// Normalize a git SHA the way the CLI's runtimeExpectation does, so drift
// comparison matches control-plane status semantics.
function normalizeSha(value: any): string | null {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : text;
}

// Build one HealthFinding (§2). `severity` is REQUIRED and may sit above the
// fromHealth floor; callers pass it explicitly so escalation is always visible.
function makeFinding(input: {
  id: string;
  category: 'runtime' | 'fd' | 'db' | 'service' | 'ci';
  severity: 'green' | 'yellow' | 'red' | 'black';
  status: 'ok' | 'degraded' | 'fail' | 'unknown' | 'skipped' | 'setup-required';
  title: string;
  message: string;
  source?: 'ace-cli' | 'ace-electron' | 'daily-agent';
  evidencePath?: string | null;
  command?: string | null;
  freshness?: 'live' | 'fresh' | 'stale' | 'expired' | null;
  ageSeconds?: number | null;
  recommendedAction?: string | null;
  confidence?: number;
  isLive?: boolean;
  details?: Record<string, any>;
  lastChecked?: string;
}): any {
  return {
    $schema: FINDING_SCHEMA,
    id: input.id,
    category: input.category,
    severity: input.severity,
    status: input.status,
    title: input.title,
    message: input.message,
    evidence: {
      source: input.source || 'ace-electron',
      path: input.evidencePath ?? null,
      command: input.command ?? null,
      lastChecked: input.lastChecked || nowIso(),
      freshness: input.freshness ?? 'live',
      ageSeconds: input.ageSeconds ?? null,
    },
    recommendedAction: input.recommendedAction ?? null,
    confidence: input.confidence == null ? 1 : input.confidence,
    isLive: input.isLive == null ? true : input.isLive,
    details: input.details || {},
  };
}

// ---------------------------------------------------------------------------
// §5 Config loading — fail-safe, never throws.
// ---------------------------------------------------------------------------

function defaultConfigPath(): string {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-config.json');
}

function loadOpsConfig(configPath: string | null, warnings: string[]): {
  resolvedPath: string;
  endpoints: any[];
  thresholds: typeof DEFAULT_THRESHOLDS;
  enabled: boolean;
  configMissing: boolean;
} {
  const resolvedPath = configPath ? expandHome(configPath) : defaultConfigPath();
  const fallback = {
    resolvedPath,
    endpoints: [] as any[],
    thresholds: { ...DEFAULT_THRESHOLDS },
    enabled: true,
    configMissing: false,
  };
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    warnings.push(`ops-config not found at ${resolvedPath}; using defaults (no endpoints configured)`);
    return { ...fallback, configMissing: true };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    warnings.push(`ops-config unparseable at ${resolvedPath}: ${err?.message || err}; using defaults`);
    return fallback;
  }
  const endpoints = Array.isArray(parsed?.endpoints) ? parsed.endpoints : [];
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(parsed?.thresholds && typeof parsed.thresholds === 'object' ? parsed.thresholds : {}) };
  return {
    resolvedPath,
    endpoints,
    thresholds,
    enabled: parsed?.enabled !== false,
    configMissing: false,
  };
}

// ---------------------------------------------------------------------------
// Runtime probe helpers
// ---------------------------------------------------------------------------

// Connect to the local control socket and round-trip a `ping`. Resolves with
// { reachable, roundTripMs, error }. Never throws.
function socketRoundTrip(sockPath: string, timeoutMs = 2000): Promise<{ reachable: boolean; roundTripMs: number | null; error: string | null }> {
  return new Promise((resolve) => {
    if (!sockPath) {
      resolve({ reachable: false, roundTripMs: null, error: 'no socket path' });
      return;
    }
    const started = Date.now();
    let settled = false;
    const socket = net.createConnection(sockPath);
    let buf = '';
    const done = (result: { reachable: boolean; roundTripMs: number | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners(); socket.destroy(); } catch {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ reachable: false, roundTripMs: null, error: 'timeout' }));
    socket.once('connect', () => {
      try {
        socket.write(JSON.stringify({ id: 'ops-ping', method: 'ping' }) + '\n');
      } catch (err: any) {
        done({ reachable: false, roundTripMs: null, error: err?.message || 'write failed' });
      }
    });
    socket.on('data', (chunk: any) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        // The bridge may emit events before our response; ignore those and
        // wait for the matching id.
        if (msg && msg.id === 'ops-ping') {
          done({ reachable: msg.ok === true, roundTripMs: Date.now() - started, error: msg.ok === true ? null : 'ping not ok' });
          return;
        }
      }
    });
    socket.once('error', (err: any) => done({ reachable: false, roundTripMs: null, error: err?.message || 'socket error' }));
  });
}

// GET a URL (http or https) and resolve with { ok, status, error }. Used by the
// runtime /healthz check and the service-ping probe. Never throws.
function httpGet(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: boolean; status: number | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let lib: any;
    try {
      lib = url.startsWith('https:') ? https : http;
    } catch {
      done({ ok: false, status: null, error: 'invalid url' });
      return;
    }
    let req: any;
    try {
      req = lib.get(url, (res: any) => {
        const status = res.statusCode || null;
        // Drain so the socket can be reused/closed promptly.
        res.resume();
        done({ ok: !!status && status >= 200 && status < 400, status, error: null });
      });
    } catch (err: any) {
      done({ ok: false, status: null, error: err?.message || 'request failed' });
      return;
    }
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch {}
      done({ ok: false, status: null, error: 'timeout' });
    });
    req.once('error', (err: any) => done({ ok: false, status: null, error: err?.message || 'request error' }));
  });
}

// Run a command and resolve with { code, stdout, stderr, error }. ENOENT (the
// binary is absent) surfaces as error.code === 'ENOENT' so callers can degrade
// to unknown/yellow instead of throwing. Never rejects.
function execCapture(
  cmd: string,
  args: string[],
  opts: { timeout?: number; shell?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error: any }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { code: number | null; stdout: string; stderr: string; error: any }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFile(
        cmd,
        args,
        { timeout: opts.timeout || 5000, maxBuffer: 8 * 1024 * 1024, shell: opts.shell || false },
        (error: any, stdout: any, stderr: any) => {
          done({
            code: error && typeof error.code === 'number' ? error.code : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: error || null,
          });
        },
      );
    } catch (err: any) {
      done({ code: null, stdout: '', stderr: '', error: err });
    }
  });
}

// ---------------------------------------------------------------------------
// Probes (runtime + db real in PR-2; fd + service + ci-stub real in PR-3)
// ---------------------------------------------------------------------------

async function probeRuntime(ctx: any): Promise<any[]> {
  const findings: any[] = [];
  const command = 'ace --json ops status --probes runtime';

  // 1. Daemon socket reachability + round-trip. Socket dead -> red.
  const sockPath = ctx.socketPath || null;
  const ping = await socketRoundTrip(sockPath);
  if (ping.reachable) {
    findings.push(
      makeFinding({
        id: 'runtime.socket',
        category: 'runtime',
        severity: 'green',
        status: 'ok',
        title: 'Daemon socket reachable',
        message: `Control socket round-trip ${ping.roundTripMs ?? '?'}ms (green).`,
        command,
        details: { socketPath: sockPath, roundTripMs: ping.roundTripMs },
      }),
    );
  } else {
    findings.push(
      makeFinding({
        id: 'runtime.socket',
        category: 'runtime',
        severity: 'red',
        status: 'fail',
        title: 'Daemon socket unreachable',
        message: `Control socket did not respond (${ping.error || 'unreachable'}) (red).`,
        command,
        recommendedAction: 'Confirm the Ace desktop app is running and the local control socket is up.',
        details: { socketPath: sockPath, error: ping.error },
      }),
    );
  }

  // 2. Build-hash drift. Reuses the CLI-supplied version payload + the
  // expected SHA. Drift-only (socket alive but SHA mismatch) -> yellow.
  const version = ctx.version || null;
  const expected = normalizeSha(ctx.expectedRuntimeSha);
  if (expected && version) {
    const actual = normalizeSha(version.gitSha);
    const current = Boolean(actual && actual.startsWith(expected));
    if (current) {
      findings.push(
        makeFinding({
          id: 'runtime.drift',
          category: 'runtime',
          severity: 'green',
          status: 'ok',
          title: 'Runtime build current',
          message: `Runtime SHA ${actual?.slice(0, 12)} matches expected ${expected.slice(0, 12)} (green).`,
          command,
          details: { expectedSha: expected, actualSha: actual, source: version.gitSource || null },
        }),
      );
    } else {
      findings.push(
        makeFinding({
          id: 'runtime.drift',
          category: 'runtime',
          severity: 'yellow',
          status: 'degraded',
          title: 'Runtime build drift',
          message: `Runtime SHA ${actual ? actual.slice(0, 12) : 'unknown'} does not match expected ${expected.slice(0, 12)} (yellow).`,
          command,
          recommendedAction: 'Rebuild and relaunch the desktop app to match the expected source SHA.',
          details: { expectedSha: expected, actualSha: actual, source: version.gitSource || null },
        }),
      );
    }
  }

  // 3. Remote /healthz — ONLY when ACE_URL is set. No hardcoded URLs.
  const remoteUrl = String(process.env.ACE_URL || '').trim();
  if (remoteUrl) {
    const healthUrl = `${remoteUrl.replace(/\/+$/, '')}/healthz`;
    const res = await httpGet(healthUrl);
    if (res.ok) {
      findings.push(
        makeFinding({
          id: 'runtime.healthz',
          category: 'runtime',
          severity: 'green',
          status: 'ok',
          title: 'Remote /healthz ok',
          message: `Remote /healthz returned ${res.status} (green).`,
          command,
          details: { status: res.status },
        }),
      );
    } else {
      findings.push(
        makeFinding({
          id: 'runtime.healthz',
          category: 'runtime',
          severity: 'red',
          status: 'fail',
          title: 'Remote /healthz failed',
          message: `Remote /healthz ${res.status ?? 'no response'}${res.error ? ` (${res.error})` : ''} (red).`,
          command,
          recommendedAction: 'Check the remote Ace endpoint configured via ACE_URL.',
          details: { status: res.status, error: res.error },
        }),
      );
    }
  }

  return findings;
}

async function probeFd(ctx: any): Promise<any[]> {
  const command = 'ace --json ops status --probes fd';
  const thresholds = ctx.thresholds || DEFAULT_THRESHOLDS;

  // macOS has no /proc; count open FDs via `lsof -p <pid>`. If lsof is absent
  // (ENOENT) we degrade to unknown/yellow/confidence 0.3 and never throw.
  const lsof = await execCapture('lsof', ['-p', String(process.pid)]);
  if (lsof.error && lsof.error.code === 'ENOENT') {
    return [
      makeFinding({
        id: 'fd.process',
        category: 'fd',
        severity: 'yellow',
        status: 'unknown',
        title: 'FD probe unavailable',
        message: 'lsof not found; cannot count open file descriptors (yellow, low confidence).',
        command,
        confidence: 0.3,
        recommendedAction: 'Install lsof to enable file-descriptor monitoring on this host.',
      }),
    ];
  }

  // lsof prints a header line plus one line per open fd; subtract the header.
  const lines = lsof.stdout.split('\n').filter((l: string) => l.trim().length > 0);
  const openCount = Math.max(0, lines.length - 1);

  // Soft FD limit via `ulimit -n` (run through a shell). Unbounded/unknown
  // limits degrade the confidence but still report the raw count.
  const ulimit = await execCapture('sh', ['-c', 'ulimit -n'], { shell: false });
  const limitRaw = ulimit.stdout.trim();
  const limit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : null;

  if (!limit || limit <= 0) {
    return [
      makeFinding({
        id: 'fd.process',
        category: 'fd',
        severity: 'green',
        status: 'ok',
        title: 'FD count (no ratio)',
        message: `${openCount} open FDs; FD limit unknown so no ratio computed (green, low confidence).`,
        command,
        confidence: 0.5,
        details: { openCount, limit: limitRaw === 'unlimited' ? 'unlimited' : null },
      }),
    ];
  }

  const ratio = openCount / limit;
  let severity: 'green' | 'yellow' | 'red' = 'green';
  let status: 'ok' | 'degraded' | 'fail' = 'ok';
  if (ratio >= thresholds.fdRatioCritical) {
    severity = 'red';
    status = 'fail';
  } else if (ratio >= thresholds.fdRatioWarning) {
    severity = 'yellow';
    status = 'degraded';
  }
  return [
    makeFinding({
      id: 'fd.process',
      category: 'fd',
      severity,
      status,
      title: 'Open file descriptors',
      message: `FD ${Math.round(ratio * 100)}% (${openCount}/${limit}) (warn >=${Math.round(thresholds.fdRatioWarning * 100)}%, crit >=${Math.round(thresholds.fdRatioCritical * 100)}%) (${severity}).`,
      command,
      recommendedAction: severity === 'green' ? null : 'Investigate fd leaks; a runaway probe/terminal can exhaust the soft limit.',
      details: { openCount, limit, ratio: Number(ratio.toFixed(3)), warnRatio: thresholds.fdRatioWarning, critRatio: thresholds.fdRatioCritical },
    }),
  ];
}

// Severity from a measured size against warn/crit MB thresholds.
function sizeSeverity(mb: number, warnMb: number, critMb: number): { severity: 'green' | 'yellow' | 'red'; status: 'ok' | 'degraded' | 'fail' } {
  if (mb >= critMb) return { severity: 'red', status: 'fail' };
  if (mb >= warnMb) return { severity: 'yellow', status: 'degraded' };
  return { severity: 'green', status: 'ok' };
}

async function probeDb(ctx: any): Promise<any[]> {
  const findings: any[] = [];
  const command = 'ace --json ops status --probes db';
  const userDataPath = ctx.userDataPath || null;
  if (!userDataPath) {
    findings.push(
      makeFinding({
        id: 'db.size.ace',
        category: 'db',
        severity: 'yellow',
        status: 'unknown',
        title: 'DB path unresolved',
        message: 'No data root available to locate ace.db (yellow).',
        command,
        confidence: 0.3,
      }),
    );
    return findings;
  }

  const thresholds = ctx.thresholds || DEFAULT_THRESHOLDS;
  const dbPath = path.join(userDataPath, 'ace.db');
  const walPath = `${dbPath}-wal`;

  // Main DB file. Missing DB is a real problem (the app has never booted here)
  // -> red; otherwise size against db thresholds.
  let dbStat: any = null;
  try {
    dbStat = fs.statSync(dbPath);
  } catch {
    dbStat = null;
  }
  if (!dbStat) {
    findings.push(
      makeFinding({
        id: 'db.size.ace',
        category: 'db',
        severity: 'red',
        status: 'fail',
        title: 'ace.db missing',
        message: `ace.db not found at ${dbPath} (red).`,
        command,
        evidencePath: dbPath,
        recommendedAction: 'Confirm the Ace data root; the database has not been initialized at this path.',
        details: { dbPath },
      }),
    );
  } else {
    const mb = toMb(dbStat.size);
    const sev = sizeSeverity(mb, thresholds.dbSizeWarnMb, thresholds.dbSizeCritMb);
    findings.push(
      makeFinding({
        id: 'db.size.ace',
        category: 'db',
        severity: sev.severity,
        status: sev.status,
        title: 'ace.db size',
        message: `ace.db ${mb.toFixed(1)}MB (warn >=${thresholds.dbSizeWarnMb}MB, crit >=${thresholds.dbSizeCritMb}MB) (${sev.severity}).`,
        command,
        evidencePath: dbPath,
        recommendedAction: sev.severity === 'green' ? null : 'Investigate database growth; consider VACUUM or archiving old data.',
        details: { dbPath, sizeMb: Number(mb.toFixed(2)), warnMb: thresholds.dbSizeWarnMb, critMb: thresholds.dbSizeCritMb },
      }),
    );
  }

  // WAL file. Absent WAL is normal (checkpointed) -> green; oversize -> yellow/red.
  let walStat: any = null;
  try {
    walStat = fs.statSync(walPath);
  } catch {
    walStat = null;
  }
  if (!walStat) {
    findings.push(
      makeFinding({
        id: 'db.wal.ace',
        category: 'db',
        severity: 'green',
        status: 'ok',
        title: 'ace.db WAL checkpointed',
        message: 'No WAL file present (checkpointed) (green).',
        command,
        details: { walPath },
      }),
    );
  } else {
    const mb = toMb(walStat.size);
    const sev = sizeSeverity(mb, thresholds.walSizeWarnMb, thresholds.walSizeCritMb);
    findings.push(
      makeFinding({
        id: 'db.wal.ace',
        category: 'db',
        severity: sev.severity,
        status: sev.status,
        title: 'ace.db WAL size',
        message: `WAL ${mb.toFixed(1)}MB (warn >=${thresholds.walSizeWarnMb}MB, crit >=${thresholds.walSizeCritMb}MB) (${sev.severity}).`,
        command,
        evidencePath: walPath,
        recommendedAction: sev.severity === 'green' ? null : 'WAL is large; ensure the runtime is checkpointing (a stuck writer can bloat the WAL).',
        details: { walPath, sizeMb: Number(mb.toFixed(2)), warnMb: thresholds.walSizeWarnMb, critMb: thresholds.walSizeCritMb },
      }),
    );
  }

  return findings;
}

async function probeService(ctx: any): Promise<any[]> {
  const command = 'ace --json ops status --probes service';
  const endpoints = Array.isArray(ctx.endpoints) ? ctx.endpoints : [];
  // Test seam: callers (vitest) may inject an httpGet-shaped function so probes
  // run without real network I/O. Production always uses the module's httpGet.
  const get: typeof httpGet = typeof ctx.httpGet === 'function' ? ctx.httpGet : httpGet;
  // Pinger closure: throttle live HTTP probes per endpoint (see cachedServiceProbe).
  const nowMs = resolveNowMs(ctx.now);
  const forceRefresh = ctx.forceRefresh === true;

  // No endpoints configured (config missing or endpoints empty) -> an HONEST
  // yellow setup-required finding, never a green skip. The rollup therefore
  // goes at least yellow — no green-by-omission.
  if (endpoints.length === 0) {
    const configPath = ctx.resolvedPath || defaultConfigPath();
    // Dev checkouts ship an example config; mention it only when present.
    let examplePath: string | null = path.join(__dirname, '..', 'tools', 'ace', 'ops-config.example.json');
    try {
      if (!fs.existsSync(examplePath)) examplePath = null;
    } catch {
      examplePath = null;
    }
    const configMissing = ctx.configMissing === true;
    const findings: any[] = [
      makeFinding({
        id: 'service.unconfigured',
        category: 'service',
        severity: 'yellow',
        status: 'setup-required',
        title: 'Service monitoring not configured',
        message: `Service monitoring is not configured: ops-config.json ${configMissing ? 'is missing' : 'has no endpoints'} at ${configPath} (yellow).`,
        command,
        recommendedAction: `Create ${configPath} with an endpoints[] list to enable service monitoring${examplePath ? ` (see ${examplePath} for a starting point)` : ''}.`,
        details: { configPath, configMissing, examplePath },
      }),
    ];
    return findings;
  }

  // One finding per endpoint id (service.<id>), probed in parallel. Empty url
  // -> skipped, never failed. No URL/domain is ever read from source.
  const findings = await Promise.all(
    endpoints.map(async (ep: any) => {
      const id = String(ep?.id || 'unknown');
      const findingId = `service.${id}`;
      const url = String(ep?.url || '').trim();
      const timeoutMs = Number(ep?.timeoutMs) > 0 ? Number(ep.timeoutMs) : 5000;
      const severityOnFail = ['green', 'yellow', 'red', 'black'].includes(ep?.severityOnFail) ? ep.severityOnFail : 'red';
      const expectStatus = Number(ep?.expectStatus) > 0 ? Number(ep.expectStatus) : null;

      if (!url) {
        return makeFinding({
          id: findingId,
          category: 'service',
          severity: 'green',
          status: 'skipped',
          title: `${id} not configured`,
          message: `Endpoint '${id}' has an empty url; skipped (not failed).`,
          command,
          details: { endpointId: id },
        });
      }

      if (!/^https?:\/\//i.test(url)) {
        return makeFinding({
          id: findingId,
          category: 'service',
          severity: 'yellow',
          status: 'unknown',
          title: `${id} bad url`,
          message: `Endpoint '${id}' url is not http(s); skipped (yellow).`,
          command,
          confidence: 0.5,
          details: { endpointId: id },
        });
      }

      // Live HTTP probe — throttled per endpoint so a burst of renderer
      // refreshes reuses the last result within the min interval.
      return cachedServiceProbe(`service:${findingId}:${url}`, nowMs, forceRefresh, async () => {
      const started = Date.now();
      const res = await get(url, timeoutMs);
      const latencyMs = Date.now() - started;
      const statusOk = expectStatus ? res.status === expectStatus : res.ok;
      // An expected non-2xx (e.g. a configured 302 redirect) is a
      // healthy, by-design redirect — flagged so the cockpit can label it
      // "redirect expected" instead of looking like a broken service.
      const redirectExpected = !!expectStatus && expectStatus >= 300 && expectStatus < 400;
      if (statusOk) {
        return makeFinding({
          id: findingId,
          category: 'service',
          severity: 'green',
          status: 'ok',
          title: `${id} reachable`,
          message: `Endpoint '${id}' returned ${res.status}${expectStatus ? ` (expected ${expectStatus})` : ''} in ${latencyMs}ms (green).`,
          command,
          details: { endpointId: id, status: res.status, expectStatus, url, latencyMs, redirectExpected, dnsUnresolved: false },
        });
      }
      // A DNS-resolution failure (the host does not resolve) is a DISTINCT,
      // honest state from an application failure: the endpoint may simply be
      // planned / not yet provisioned. We tag it so the cockpit frames it as
      // "planned / action-needed", never confused with a service that is down.
      // The signal is the resolver error itself (provider-agnostic) — never the
      // endpoint id, so no naming convention is hardcoded.
      const dnsUnresolved = !!res.error && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(res.error);
      if (dnsUnresolved) {
        return makeFinding({
          id: findingId,
          category: 'service',
          severity: severityOnFail,
          status: 'fail',
          title: `${id} not resolving (DNS)`,
          message: `Endpoint '${id}' host does not resolve via DNS (${res.error}) after ${latencyMs}ms; not reachable yet (${severityOnFail}).`,
          command,
          recommendedAction:
            'Host does not resolve via DNS. If this endpoint is planned/not yet provisioned, set up its DNS (e.g. a DNS record) before it can pass; otherwise verify the hostname.',
          details: { endpointId: id, status: res.status, expectStatus, error: res.error, url, latencyMs, redirectExpected, dnsUnresolved: true },
        });
      }
      return makeFinding({
        id: findingId,
        category: 'service',
        severity: severityOnFail,
        status: 'fail',
        title: `${id} unhealthy`,
        message: `Endpoint '${id}' ${res.status ?? 'no response'}${expectStatus ? ` (expected ${expectStatus})` : ''}${res.error ? ` (${res.error})` : ''} after ${latencyMs}ms (${severityOnFail}).`,
        command,
        recommendedAction: `Check the '${id}' service health.`,
        details: { endpointId: id, status: res.status, expectStatus, error: res.error, url, latencyMs, redirectExpected, dnsUnresolved: false },
      });
      });
    }),
  );

  return findings;
}

async function probeCiDrift(ctx: any): Promise<any[]> {
  const command = 'ace --json ops status --probes ci --workspace <id>';
  const workspaceId = ctx.workspaceId ? String(ctx.workspaceId) : null;

  // System-wide (no workspace) -> skipped/yellow-free stub. This is the v1
  // "wired as a skipped stub" contract; deeper CI rollup lands in v1.1.
  if (!workspaceId) {
    return [
      makeFinding({
        id: 'ci.drift',
        category: 'ci',
        severity: 'green',
        status: 'skipped',
        title: 'CI drift skipped (no workspace)',
        message: 'CI/PR-drift requires --workspace; skipped for system-wide probe.',
        command,
        recommendedAction: 'Pass --workspace <id> to include CI/PR-drift.',
        confidence: 0,
      }),
    ];
  }

  // With a workspace, attempt a gh PR rollup. gh absent (ENOENT) -> yellow,
  // low confidence, never throws.
  const repoRoot = ctx.repoRoot ? String(ctx.repoRoot) : null;
  const args = ['pr', 'list', '--json', 'number,statusCheckRollup', '--limit', '30'];
  const gh = await execCapture('gh', repoRoot ? ['-R', repoRoot, ...args] : args, { timeout: 8000 });
  if (gh.error && gh.error.code === 'ENOENT') {
    return [
      makeFinding({
        id: 'ci.drift',
        category: 'ci',
        severity: 'yellow',
        status: 'unknown',
        title: 'CI drift probe unavailable',
        message: 'gh CLI not found; cannot read PR check rollups (yellow, low confidence).',
        command,
        confidence: 0.3,
        recommendedAction: 'Install and authenticate the GitHub CLI (gh) to enable CI/PR-drift.',
      }),
    ];
  }
  if (gh.error) {
    return [
      makeFinding({
        id: 'ci.drift',
        category: 'ci',
        severity: 'yellow',
        status: 'unknown',
        title: 'CI drift probe error',
        message: `gh pr list failed (${gh.stderr.trim().split('\n')[0] || gh.error.message || 'error'}) (yellow, low confidence).`,
        command,
        confidence: 0.3,
      }),
    ];
  }

  let pulls: any[] = [];
  try {
    pulls = prGate().parseGhJson(gh.stdout, []);
  } catch {
    pulls = [];
  }
  if (!Array.isArray(pulls)) pulls = [];

  let failures = 0;
  let pending = 0;
  for (const pr of pulls) {
    const state = prGate().rollupCheckState(pr?.statusCheckRollup);
    if (state === 'failure') failures += 1;
    else if (state === 'pending') pending += 1;
  }

  if (failures > 0) {
    return [
      makeFinding({
        id: 'ci.drift',
        category: 'ci',
        severity: 'red',
        status: 'fail',
        title: 'PR checks failing',
        message: `${failures} open PR(s) with failing checks${pending ? `, ${pending} pending` : ''} (red).`,
        command,
        recommendedAction: 'Open the failing PRs and address red checks before merge.',
        details: { failures, pending, total: pulls.length },
      }),
    ];
  }
  if (pending > 0) {
    return [
      makeFinding({
        id: 'ci.drift',
        category: 'ci',
        severity: 'yellow',
        status: 'degraded',
        title: 'PR checks pending',
        message: `${pending} open PR(s) with checks still pending (yellow).`,
        command,
        details: { failures: 0, pending, total: pulls.length },
      }),
    ];
  }
  return [
    makeFinding({
      id: 'ci.drift',
      category: 'ci',
      severity: 'green',
      status: 'ok',
      title: 'PR checks clean',
      message: `${pulls.length} open PR(s); no failing or pending checks (green).`,
      command,
      details: { failures: 0, pending: 0, total: pulls.length },
    }),
  ];
}

const PROBE_DISPATCH: Record<string, (ctx: any) => Promise<any[]>> = {
  runtime: probeRuntime,
  fd: probeFd,
  db: probeDb,
  service: probeService,
  ci: probeCiDrift,
};

// Category → severity rollup. `skipped`/`unknown` findings do not own a
// rollup color of their own; the per-category roll uses worst-of severity but
// the `counts` map records `skipped` when every finding in a category is
// skipped so the UI can distinguish "skipped" from "green".
function categorySeverity(findings: any[]): string {
  if (!findings.length) return 'skipped';
  const allSkipped = findings.every((f) => f.status === 'skipped');
  if (allSkipped) return 'skipped';
  return rollupSeverity(findings.map((f) => f.severity));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function runOpsStatus(ctx: any = {}): Promise<any> {
  const warnings: string[] = [];
  const workspaceId = ctx.workspaceId ? String(ctx.workspaceId) : null;
  const requested = normalizeProbes(ctx.probes);
  const cfgLoaded = loadOpsConfig(ctx.configPath || null, warnings);
  const timestamp = nowIso(ctx.now);

  const cfg = {
    ...cfgLoaded,
    workspaceId,
    expectedRuntimeSha: ctx.expectedRuntimeSha || null,
    // Optional version payload the CLI may pass through for drift detection.
    version: ctx.version || null,
    // Data root the store injects; db probe resolves ace.db relative to it.
    userDataPath: ctx.userDataPath || null,
    socketPath: ctx.socketPath || null,
    now: ctx.now,
    // Test seam (see probeService): optional injected HTTP getter.
    httpGet: typeof ctx.httpGet === 'function' ? ctx.httpGet : null,
    // Pinger closure: the daily snapshot path may set forceRefresh:true to
    // bypass the per-endpoint LIVE-probe throttle. Live renderer reads leave
    // this false so a burst of refreshes reuses the cached probe result.
    forceRefresh: ctx.forceRefresh === true,
  };

  const findings: any[] = [];
  const counts: Record<string, string> = {};

  for (const probe of requested) {
    const fn = PROBE_DISPATCH[probe];
    if (!fn) continue;
    let probeFindings: any[] = [];
    try {
      probeFindings = await fn(cfg);
    } catch (err: any) {
      // Probes must never throw. If one does despite its own guards, capture
      // it as a yellow finding and keep going so one bad probe cannot blank
      // the cockpit.
      warnings.push(`probe ${probe} threw: ${err?.message || err}`);
      probeFindings = [
        makeFinding({
          id: `${probe}.error`,
          category: probe as any,
          severity: 'yellow',
          status: 'unknown',
          title: `${probe} probe error`,
          message: `Probe ${probe} could not complete: ${err?.message || err}`,
          confidence: 0.3,
        }),
      ];
    }
    findings.push(...probeFindings);
    counts[probe] = categorySeverity(probeFindings);
  }

  // Rollup counts and worst-of severity (skipped/unknown do not count toward
  // the severity tallies but the worst-of still governs rollup.severity).
  const tally = { green: 0, yellow: 0, red: 0, black: 0 };
  for (const f of findings) {
    if ((tally as any)[f.severity] != null) (tally as any)[f.severity] += 1;
  }
  const severity = rollupSeverity(findings.map((f) => f.severity));

  return {
    schema: STATUS_SCHEMA,
    timestamp,
    workspaceId,
    configPath: cfgLoaded.resolvedPath,
    rollup: {
      severity,
      green: tally.green,
      yellow: tally.yellow,
      red: tally.red,
      black: tally.black,
      counts,
    },
    findings,
    warnings,
  };
}

module.exports = {
  runOpsStatus,
  fromHealth,
  rollupSeverity,
  loadOpsConfig,
  normalizeProbes,
  makeFinding,
  probeService,
  __resetServiceProbeCache,
  SERVICE_PROBE_MIN_INTERVAL_MS,
  STATUS_SCHEMA,
  FINDING_SCHEMA,
  CONFIG_SCHEMA,
  DEFAULT_THRESHOLDS,
  ALL_PROBES,
  toMb,
};
