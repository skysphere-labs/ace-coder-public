import { test, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('../usage-core.cts');

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-usage-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCache(rateLimits = {}) {
  const cacheFile = path.join(tmp, 'claude-cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ rate_limits: rateLimits }));
  return cacheFile;
}

function writeClaudeJson(oauthAccount = {}) {
  const claudeJsonFile = path.join(tmp, 'claude.json');
  fs.writeFileSync(claudeJsonFile, JSON.stringify({ oauthAccount }));
  return claudeJsonFile;
}

test('claude meters mirror official statusline percentages and reset times', () => {
  const cacheFile = writeCache({
    five_hour: { used_percentage: 37.5, resets_at: 2000000000 },
    seven_day: { used_percentage: 81, resets_at: 2000300000 },
  });
  const claudeJsonFile = writeClaudeJson({
    emailAddress: 'someone@example.com',
    userRateLimitTier: 'default_max_20x',
  });

  const p = core.readClaudeUsage(Date.now(), cacheFile, claudeJsonFile);
  expect(p.state).toBe('live');
  expect(p.session.percent).toBe(37.5);
  expect(p.session.resetsAt).toBe(2000000000 * 1000);
  expect(p.weekly.percent).toBe(81);
  expect(p.weekly.resetsAt).toBe(2000300000 * 1000);
  expect(p.accountLabel).toBe('someone@example.com');
  expect(p.plan).toBe('max 20x');
  // No fabricated token quotas anywhere.
  expect(p.session.tokens).toBeNull();
  expect(p.session.limit).toBeNull();
  expect(p.weekly.limit).toBeNull();
});

test('an absent window reports null percent, never a fake 0', () => {
  const cacheFile = writeCache({ five_hour: { used_percentage: 12, resets_at: 2000000000 } });
  const p = core.readClaudeUsage(Date.now(), cacheFile, path.join(tmp, 'nope.json'));
  expect(p.session.percent).toBe(12);
  expect(p.weekly.percent).toBeNull();
  expect(p.weekly.resetsAt).toBeNull();
});

test('an old snapshot is flagged stale but still shown', () => {
  const cacheFile = writeCache({ five_hour: { used_percentage: 55, resets_at: 2000000000 } });
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(cacheFile, old, old);

  const p = core.readClaudeUsage(Date.now(), cacheFile, path.join(tmp, 'nope.json'));
  expect(p.state).toBe('stale');
  expect(p.session.percent).toBe(55);
  expect(p.asOf).toBeLessThan(Date.now() - 60 * 60 * 1000);
});

test('missing cache yields unknown state with null percents (no invented quota)', () => {
  const p = core.readClaudeUsage(
    Date.now(),
    path.join(tmp, 'missing-cache.json'),
    path.join(tmp, 'missing-claude.json')
  );
  expect(p.state).toBe('unknown');
  expect(p.asOf).toBeNull();
  expect(p.session.percent).toBeNull();
  expect(p.weekly.percent).toBeNull();
  expect(p.session.limit).toBeNull();
  expect(p.accountLabel).toBeNull();
  expect(p.plan).toBeNull();
});

test('account tiers map to display-only plan badges', () => {
  expect(core.readClaudeAccount(writeClaudeJson({ userRateLimitTier: 'claude_pro' })).plan).toBe(
    'pro'
  );
  const max5 = core.readClaudeAccount(writeClaudeJson({ seatTier: 'default_max_5x' }));
  expect(max5.plan).toBe('max 5x');
  expect(
    core.readClaudeAccount(writeClaudeJson({ organizationName: 'Acme', userRateLimitTier: '' }))
      .accountLabel
  ).toBe('Acme');
});

test('codex rate limits parse from session jsonl with plan and resets', async () => {
  const root = path.join(tmp, 'sessions', '2026', '06');
  fs.mkdirSync(root, { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  const line = JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 1234 } },
      rate_limits: {
        limit_id: 'codex',
        plan_type: 'Plus',
        primary: { used_percent: 42.5, window_minutes: 300, resets_at: 2000000000 },
        secondary: { used_percent: 7, window_minutes: 10080, resets_at: 2000300000 },
      },
    },
  });
  fs.writeFileSync(path.join(root, 'rollout-1.jsonl'), line + '\n');

  const p = await core.scanCodex(Date.now(), path.join(tmp, 'sessions'));
  expect(p.state).toBe('live');
  expect(p.plan).toBe('plus');
  expect(p.session.percent).toBe(42.5);
  expect(p.session.resetsAt).toBe(2000000000 * 1000);
  expect(p.weekly.percent).toBe(7);
  expect(p.weekly.windowMinutes).toBe(10080);
  expect(p.asOf).toBe(Date.parse(ts));
});

test('codex model-scoped promo limits never overwrite the plan meters', async () => {
  const root = path.join(tmp, 'sessions', '2026', '07');
  fs.mkdirSync(root, { recursive: true });
  const planTs = new Date(Date.now() - 120_000).toISOString();
  const promoTs = new Date(Date.now() - 30_000).toISOString();
  const event = (timestamp, rate_limits) =>
    JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits } });
  // A real session: the plan meter ticks, then the LAST turn runs a promo
  // model (GPT-5.3-Codex-Spark) whose own family reports 0% — the exact
  // owner-reported shape that zeroed the strip.
  fs.writeFileSync(
    path.join(root, 'rollout-1.jsonl'),
    [
      event(planTs, {
        limit_id: 'codex',
        plan_type: 'pro',
        primary: { used_percent: 21, window_minutes: 300, resets_at: 2000000000 },
        secondary: { used_percent: 8, window_minutes: 10080, resets_at: 2000300000 },
      }),
      event(promoTs, {
        limit_id: 'codex_bengalfox',
        limit_name: 'GPT-5.3-Codex-Spark',
        primary: { used_percent: 0, window_minutes: 300, resets_at: 2000009999 },
        secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2000309999 },
        credits: { has_credits: false, unlimited: false, balance: null },
      }),
    ].join('\n') + '\n'
  );

  const p = await core.scanCodex(Date.now(), path.join(tmp, 'sessions'));
  expect(p.state).toBe('live');
  expect(p.plan).toBe('pro');
  expect(p.session.percent).toBe(21);
  expect(p.weekly.percent).toBe(8);
  // The promo turn still counts as activity, just not as the plan meter.
  expect(p.lastActivityMs).toBe(Date.parse(promoTs));
});

test('a promo-only newest session falls back to the older session for plan meters', async () => {
  const root = path.join(tmp, 'sessions', '2026', '07');
  fs.mkdirSync(root, { recursive: true });
  const event = (timestamp, rate_limits) =>
    JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits } });
  const oldTs = new Date(Date.now() - 300_000).toISOString();
  fs.writeFileSync(
    path.join(root, 'rollout-old.jsonl'),
    event(oldTs, {
      limit_id: 'codex',
      plan_type: 'pro',
      primary: { used_percent: 11, window_minutes: 300, resets_at: 2000000000 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: 2000300000 },
    }) + '\n'
  );
  const newFile = path.join(root, 'rollout-new.jsonl');
  fs.writeFileSync(
    newFile,
    event(new Date().toISOString(), {
      limit_id: 'codex_bengalfox',
      primary: { used_percent: 0, window_minutes: 300, resets_at: 2000009999 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2000309999 },
    }) + '\n'
  );
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(newFile, future, future); // newest by mtime, promo-only

  const p = await core.scanCodex(Date.now(), path.join(tmp, 'sessions'));
  expect(p.session.percent).toBe(11);
  expect(p.weekly.percent).toBe(3);
});

test('codex without rate-limit events is unknown with null percents', async () => {
  const root = path.join(tmp, 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const p = await core.scanCodex(Date.now(), root);
  expect(p.state).toBe('unknown');
  expect(p.session.percent).toBeNull();
  expect(p.weekly.percent).toBeNull();
  expect(p.asOf).toBeNull();
});

// --- the machine's own login -------------------------------------------------
// Ace runs every lane on the machine's CLI login, so a provider reports one set
// of meters, fed by the statusline tap (claude) or the session tree (codex).

const tap = require('../usage-statusline-tap.cts');

test('claude scan reports the machine login\'s meters from the statusline tap', () => {
  const configDir = path.join(tmp, 'claude-config');
  const usageDir = path.join(tmp, 'usage');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });

  fs.writeFileSync(
    tap.tapPaths(configDir, usageDir).cacheFile,
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 2000000000 } } })
  );
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'ambient@example.com', userRateLimitTier: 'claude_pro' } })
  );

  const p = core.scanClaude(Date.now(), { configDir, usageDir });
  expect(p.session.percent).toBe(10);
  expect(p.weekly.percent).toBeNull(); // the tap only carried a 5h window
  expect(p.accountLabel).toBe('ambient@example.com');
  expect(p.plan).toBe('pro');
  expect(p.state).toBe('live');
});

test('codex provider reports its meters from the session tree', async () => {
  const root = path.join(tmp, 'sessions');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'rollout-1.jsonl'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { plan_type: 'plus', primary: { used_percent: 20, window_minutes: 300, resets_at: 2000000000 } },
      },
    }) + '\n'
  );

  const p = await core.scanCodexProvider(Date.now(), { root });
  expect(p.session.percent).toBe(20);
  expect(p.plan).toBe('plus');
});

test('codex provider is absent when there is no session tree', async () => {
  const p = await core.scanCodexProvider(Date.now(), { root: path.join(tmp, 'no-such-sessions') });
  expect(p).toBeNull();
});

// The push model (source watchers + coalescing + typed publish) lives in
// usage-events.cts and is covered by usage-events.test.cts.
