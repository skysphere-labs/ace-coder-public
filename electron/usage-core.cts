

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const statuslineTap = require('./usage-statusline-tap.cts');

const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Rate-limit snapshots only update while a session is running, so an aging
// snapshot is still honest data — it just gets flagged as stale instead of
// being silently presented as current.
const CLAUDE_STALE_AFTER_MS = 30 * 60 * 1000;
const CODEX_STALE_AFTER_MS = 60 * 60 * 1000;

function homeJoin(...parts: any[]) {
  return path.join(os.homedir(), ...parts);
}

function safeStat(p: any) {
  try { return fs.statSync(p); } catch { return null; }
}

function readJsonFile(p: any) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function isProviderUsageEnabled() {
  const profile = process.env.ACE_HOME || homeJoin('.ace-coder');
  return readJsonFile(path.join(profile, 'usage-settings.json'))?.enabled === true;
}

function disabledProviderUsage() {
  return { providers: [], generatedAt: Date.now(), enabled: false, reason: 'disabled' };
}

function listJsonlRecursive(root: any, out: any, weeklyCutoffMs: any) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listJsonlRecursive(full, out, weeklyCutoffMs);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const st = safeStat(full);
      if (!st) continue;
      if (st.mtimeMs < weeklyCutoffMs) continue;
      out.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
}

async function streamLines(filePath: any, onLine: any) {
  return new Promise<void>((resolve) => {
    let stream: any;
    try { stream = fs.createReadStream(filePath, { encoding: 'utf8' }); }
    catch { resolve(); return; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line: any) => {
      try { onLine(line); } catch {  }
    });
    rl.on('close', resolve);
    rl.on('error', () => resolve());
    stream.on('error', () => { try { rl.close(); } catch {} });
  });
}

// --- Claude ----------------------------------------------------------------
// Official rate-limit percentages mirrored from the Claude Code statusline
// JSON by the statusline tap (usage-statusline-tap.cts). Anthropic does not
// publish token quotas for Pro/Max plans and changes limits without notice,
// so there is no quota guessing here: when the tap has no data the meters
// report null/unknown instead of inventing percentages.

// Account label and plan badge come from the (config-dir-scoped) .claude.json
// oauthAccount block — display-only, never used to derive limits.
function readClaudeAccount(claudeJsonFile: any) {
  const acct = readJsonFile(claudeJsonFile)?.oauthAccount;
  if (!acct) return { accountLabel: null, plan: null };
  const accountLabel = acct.emailAddress || acct.organizationName || null;
  const tier = String(
    acct.userRateLimitTier || acct.organizationRateLimitTier || acct.seatTier || ''
  ).toLowerCase();
  let plan = null;
  if (tier.includes('max')) plan = tier.includes('20') ? 'max 20x' : tier.includes('5') ? 'max 5x' : 'max';
  else if (tier.includes('pro')) plan = 'pro';
  else if (tier.includes('free')) plan = 'free';
  return { accountLabel, plan };
}

function meterFromStatuslineWindow(win: any, windowMinutes: any) {
  const percent = Number(win?.used_percentage);
  if (!Number.isFinite(percent)) return emptyMeter(windowMinutes);
  const resets = Number(win?.resets_at);
  return {
    tokens: null,
    limit: null,
    percent: clampPercent(percent),
    windowMinutes,
    resetsAt: Number.isFinite(resets) && resets > 0 ? resets * 1000 : null,
  };
}

// The statusline tap is the sole source of Claude's meter: one writer, one
// file, whose mtime is the reading's age. It only moves while a lane is driving
// the CLI, so an idle machine reports 'stale' rather than inventing numbers.
function readClaudeUsage(now: any, cacheFile: any, claudeJsonFile: any) {
  const st = safeStat(cacheFile);
  const raw = st ? readJsonFile(cacheFile)?.rate_limits : null;
  // A payload with neither window is no meter at all; a partial one is still
  // honest data about the window it does carry, and the display shows only that.
  const limits = raw && (raw.five_hour || raw.seven_day) ? raw : null;
  const hasData = !!limits;
  const asOf = limits ? st.mtimeMs : null;
  const { accountLabel, plan } = readClaudeAccount(claudeJsonFile);
  return {
    id: 'claude',
    name: 'Claude Code',
    plan,
    accountLabel,
    state: !hasData ? 'unknown' : now - asOf > CLAUDE_STALE_AFTER_MS ? 'stale' : 'live',
    asOf,
    session: hasData ? meterFromStatuslineWindow(limits.five_hour, 300) : emptyMeter(300),
    weekly: hasData ? meterFromStatuslineWindow(limits.seven_day, 10080) : emptyMeter(10080),
    lastActivityMs: asOf,
  };
}

function scanClaude(now: any, opts: any = {}) {
  const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || homeJoin('.claude');
  if (!safeStat(configDir)?.isDirectory()) return null;
  // .claude.json lives inside CLAUDE_CONFIG_DIR when that is set; the default
  // install keeps it at ~/.claude.json.
  const claudeJsonFile =
    opts.claudeJsonFile ||
    (process.env.CLAUDE_CONFIG_DIR || opts.configDir
      ? path.join(configDir, '.claude.json')
      : homeJoin('.claude.json'));

  return readClaudeUsage(
    now,
    statuslineTap.tapPaths(configDir, opts.usageDir).cacheFile,
    claudeJsonFile
  );
}

// --- Codex -----------------------------------------------------------------
// Codex CLI writes server-reported rate limits into its session JSONL
// (event_msg/token_count payloads): used_percent, window_minutes, resets_at
// and plan_type. The freshest event wins.

async function scanCodex(now: any, root: any = homeJoin('.codex', 'sessions')) {
  if (!safeStat(root)?.isDirectory()) return null;

  const weeklyCutoff = now - WEEKLY_WINDOW_MS;
  const files: any[] = [];
  listJsonlRecursive(root, files, weeklyCutoff);
  files.sort((a: any, b: any) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) {
    return {
      id: 'codex',
      name: 'Codex',
      plan: null,
      accountLabel: null,
      state: 'unknown',
      asOf: null,
      session: emptyMeter(300),
      weekly: emptyMeter(10080),
      lastActivityMs: null,
    };
  }

  let freshest: any = null;
  let freshestTs = 0;
  let lastActivity = 0;

  outer: for (const file of files) {
    await streamLines(file.path, (line: any) => {
      if (!line.includes('"type":"event_msg"')) return;
      if (!line.includes('"token_count"')) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj?.type !== 'event_msg') return;
      const payload = obj.payload;
      if (!payload || payload.type !== 'token_count') return;
      const ts = Date.parse(obj.timestamp || '');
      if (!Number.isNaN(ts) && ts > lastActivity) lastActivity = ts;
      const limits = payload.rate_limits;
      // Codex emits several limit FAMILIES per session: the plan meters
      // (limit_id 'codex'; absent entirely on older CLIs) and model-scoped
      // promo meters (e.g. limit_id 'codex_bengalfox' — GPT-5.3-Codex-Spark,
      // which reports its own 0% windows). Only the plan family drives the
      // subscription meters: a promo turn landing last in the session must
      // never overwrite the plan's real utilization.
      if (limits?.limit_id != null && limits.limit_id !== 'codex') return;
      if (limits && (limits.primary || limits.secondary)) {
        if (!Number.isNaN(ts) && ts > freshestTs) {
          freshestTs = ts;
          freshest = limits;
        }
      }
    });


    if (freshest) break outer;
  }

  const planRaw = freshest?.plan_type ? String(freshest.plan_type).toLowerCase() : null;
  const session = meterFromCodexLimit(freshest?.primary, 300);
  const weekly = meterFromCodexLimit(freshest?.secondary, 10080);

  return {
    id: 'codex',
    name: 'Codex',
    plan: planRaw,
    accountLabel: null,
    state: !freshest ? 'unknown' : now - freshestTs > CODEX_STALE_AFTER_MS ? 'stale' : 'live',
    asOf: freshest ? freshestTs : null,
    session,
    weekly,
    lastActivityMs: lastActivity || null,
  };
}

async function scanCodexProvider(now: any, opts: any = {}) {
  // Preserve the historical contract: no sessions dir means no codex row at all.
  return scanCodex(now, opts.root ?? homeJoin('.codex', 'sessions'));
}

function meterFromCodexLimit(limit: any, fallbackMinutes: any) {
  if (!limit) return emptyMeter(fallbackMinutes);
  const used = Number(limit.used_percent);
  // A limit block without a readable percentage is no data, not 0%.
  if (!Number.isFinite(used)) return emptyMeter(fallbackMinutes);
  const windowMinutes = Number(limit.window_minutes) || fallbackMinutes;
  const resetsAt = Number(limit.resets_at);
  return {
    tokens: null,
    limit: null,
    percent: clampPercent(used),
    windowMinutes,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null,
  };
}

function emptyMeter(windowMinutes: any) {
  return { tokens: null, limit: null, percent: null, windowMinutes, resetsAt: null };
}

function clampPercent(value: any) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 10) / 10;
}

// The Codex scan walks the ~/.codex/sessions JSONL tree, so a cold call can
// take a couple of seconds. The popover re-requests on every open; cache
// results briefly so repeat opens feel instant. 30s TTL is short enough that
// in-flight turn updates still show within a normal click-inspect cadence.
const USAGE_CACHE_TTL_MS = 30_000;
let usageCache: any = null; // { result, expiresAt }
let usageInFlight: any = null;
let tapEnsured = false;

async function getProviderUsage() {
  // Usage collection can read provider account metadata/session logs and install
  // a Claude statusline hook. Keep it separate from provider authentication and
  // require an explicit setting in this app profile before any of those actions.
  if (!isProviderUsageEnabled()) {
    usageCache = null;
    tapEnsured = false;
    return disabledProviderUsage();
  }
  // Lazily (re)install the statusline tap once per process so the Claude
  // cache file starts/keeps filling. Non-fatal: the meter degrades to the
  // explicit unknown state when the tap cannot be installed.
  if (!tapEnsured) {
    tapEnsured = true;
    try { statuslineTap.ensureStatuslineTap(); } catch {  }
  }
  const now = Date.now();
  if (usageCache && usageCache.expiresAt > now) return usageCache.result;
  if (usageInFlight) return usageInFlight;
  usageInFlight = (async () => {
    const t = Date.now();
    const results = await Promise.all([scanClaude(t), scanCodexProvider(t)]);
    const result = { providers: results.filter(Boolean), generatedAt: t, enabled: true };
    usageCache = { result, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
    return result;
  })();
  try {
    return await usageInFlight;
  } finally {
    usageInFlight = null;
  }
}

function invalidateUsageCache() {
  usageCache = null;
}

// The push model lives in usage-events.cts: source watchers over the tap dir
// AND the Codex session tree invalidate this cache and publish the fresh
// report to every window and remote client.

module.exports = {
  getProviderUsage,
  isProviderUsageEnabled,
  disabledProviderUsage,
  invalidateUsageCache,
  // exported for tests
  readClaudeUsage,
  readClaudeAccount,
  scanClaude,
  scanCodex,
  scanCodexProvider,
};
