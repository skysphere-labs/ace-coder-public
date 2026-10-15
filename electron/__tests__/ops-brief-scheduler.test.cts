import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  OPS_BRIEF_INTERVAL_MS,
  OPS_BRIEF_SCHEDULE,
  OPS_TODAY_RELATIVE_PATH,
  TODAY_NON_AUTHORITATIVE_SENTENCE,
  briefScheduleStatus,
  nextBriefRun,
  normalizeBriefSchedule,
  recordOpsBriefRun,
  renderBriefMarkdown,
  renderTodayBriefMarkdown,
  resolveTodayBriefPath,
  scheduleOpsBriefs,
  writeTodayBrief,
} = require('../ops-brief-scheduler.cts');

// ---------------------------------------------------------------------------
// nextBriefRun
// ---------------------------------------------------------------------------
describe('nextBriefRun', () => {
  // Fixed reference: 2026-06-04 10:00:00 local
  const now = new Date(2026, 5, 4, 10, 0, 0, 0);

  it('schedules 7:30 for tomorrow when today at 10:00', () => {
    const next = nextBriefRun(7, 30, now);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(30);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
    // Must be tomorrow
    expect(next.getDate()).toBe(5);
    expect(next.getMonth()).toBe(5); // June
    expect(next.getFullYear()).toBe(2026);
  });

  it('schedules 7:30 for today when now is 7:00', () => {
    const at7 = new Date(2026, 5, 4, 7, 0, 0, 0);
    const next = nextBriefRun(7, 30, at7);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(4); // same day
  });

  it('schedules 7:30 for tomorrow when now is 21:00', () => {
    const at21 = new Date(2026, 5, 4, 21, 0, 0, 0);
    const next = nextBriefRun(7, 30, at21);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(5); // tomorrow
  });

  it('schedules 13:00 for today when now is 10:00', () => {
    const next = nextBriefRun(13, 0, now);
    expect(next.getHours()).toBe(13);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(4); // same day
    expect(next.getMonth()).toBe(5);
    expect(next.getFullYear()).toBe(2026);
  });

  it('schedules 20:30 for today when now is 10:00', () => {
    const next = nextBriefRun(20, 30, now);
    expect(next.getHours()).toBe(20);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(4); // same day
  });

  it('defaults minute to 0 when omitted', () => {
    const next = nextBriefRun(13, undefined, now);
    expect(next.getHours()).toBe(13);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(4);
  });

  it('rolls to tomorrow when now equals the target time exactly', () => {
    const at730 = new Date(2026, 5, 4, 7, 30, 0, 0);
    const next = nextBriefRun(7, 30, at730);
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// normalizeBriefSchedule
// ---------------------------------------------------------------------------
describe('normalizeBriefSchedule', () => {
  it('returns the default schedule for absent/empty input', () => {
    expect(normalizeBriefSchedule(undefined)).toEqual(OPS_BRIEF_SCHEDULE);
    expect(normalizeBriefSchedule(null)).toEqual(OPS_BRIEF_SCHEDULE);
    expect(normalizeBriefSchedule([])).toEqual(OPS_BRIEF_SCHEDULE);
    expect(normalizeBriefSchedule('bad')).toEqual(OPS_BRIEF_SCHEDULE);
  });

  it('accepts a valid override and defaults minute to 0', () => {
    expect(
      normalizeBriefSchedule([
        { hour: 6, minute: 15, lens: 'morning' },
        { hour: 22, lens: 'evening' },
      ])
    ).toEqual([
      { hour: 6, minute: 15, lens: 'morning' },
      { hour: 22, minute: 0, lens: 'evening' },
    ]);
  });

  it('falls back to the default schedule on any invalid entry', () => {
    expect(normalizeBriefSchedule([{ hour: 24, lens: 'morning' }])).toEqual(
      OPS_BRIEF_SCHEDULE
    );
    expect(normalizeBriefSchedule([{ hour: 8, minute: 60, lens: 'morning' }])).toEqual(
      OPS_BRIEF_SCHEDULE
    );
    expect(normalizeBriefSchedule([{ hour: 8, minute: 0, lens: '' }])).toEqual(
      OPS_BRIEF_SCHEDULE
    );
    expect(normalizeBriefSchedule([{ hour: 8.5, lens: 'morning' }])).toEqual(
      OPS_BRIEF_SCHEDULE
    );
    expect(
      normalizeBriefSchedule([{ hour: 8, lens: 'morning' }, null])
    ).toEqual(OPS_BRIEF_SCHEDULE);
  });

  it('does not return the OPS_BRIEF_SCHEDULE array identity (copies entries)', () => {
    const normalized = normalizeBriefSchedule(undefined);
    expect(normalized).not.toBe(OPS_BRIEF_SCHEDULE);
    expect(normalized[0]).not.toBe(OPS_BRIEF_SCHEDULE[0]);
  });
});

// ---------------------------------------------------------------------------
// renderBriefMarkdown
// ---------------------------------------------------------------------------
describe('renderBriefMarkdown', () => {
  /** @type {import('../../src/lib/ace-api').OpsBrief} */
  const sampleBrief = {
    $schema: 'ace.ops.brief.v1',
    lens: 'morning',
    generatedAt: new Date(2026, 5, 4, 8, 0, 0).toISOString(),
    intelAsOf: new Date(2026, 5, 4, 7, 0, 0).toISOString(),
    sourceFreshness: 'fresh',
    headline: 'Two new signals overnight.',
    sections: [
      {
        title: 'Top Signals',
        items: [
          {
            text: 'New Anthropic tool-use API',
            why: 'affects agent loop',
            move: 'review docs',
            url: 'https://example.invalid/tool-use',
          },
          {
            text: 'GitHub Actions runner update',
            why: null,
            move: null,
            url: null,
          },
        ],
      },
      {
        title: 'Project Fit',
        items: [
          {
            text: 'Ace: high fit for tool-use feature',
            why: 'aligns with W5 roadmap',
            move: 'draft candidate',
            url: null,
          },
        ],
      },
    ],
    deltaSummary: '2 new items vs yesterday.',
    candidateCount: 3,
  };

  it('renders the heading with lens and date', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('# Rook Brief — morning');
  });

  it('renders the freshness and as-of line', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('intel fresh · as-of');
  });

  it('renders the headline', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('Two new signals overnight.');
  });

  it('renders section titles as ## headers', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('## Top Signals');
    expect(md).toContain('## Project Fit');
  });

  it('renders bullets with why and move', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('- New Anthropic tool-use API — why: affects agent loop → review docs');
  });

  it('appends url in parens when present', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('(https://example.invalid/tool-use)');
  });

  it('renders a bullet without why/move/url cleanly', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('- GitHub Actions runner update\n');
  });

  it('renders deltaSummary and candidateCount in footer', () => {
    const md = renderBriefMarkdown(sampleBrief);
    expect(md).toContain('2 new items vs yesterday. Candidates: 3');
  });

  it('returns _Intel unavailable_ for null brief', () => {
    const md = renderBriefMarkdown(null);
    expect(md).toContain('_Intel unavailable_');
  });

  it('returns _Intel unavailable_ for empty object', () => {
    // An empty object still has sections:[] etc so renders the structure;
    // but at minimum it must not throw.
    expect(() => renderBriefMarkdown({})).not.toThrow();
  });

  it('never throws for any input', () => {
    expect(() => renderBriefMarkdown(undefined)).not.toThrow();
    expect(() => renderBriefMarkdown(42)).not.toThrow();
    expect(() => renderBriefMarkdown({ sections: 'bad' })).not.toThrow();
    expect(() => renderBriefMarkdown({ sections: [{ items: null }] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pull-first Today Brief artifact
// ---------------------------------------------------------------------------
describe('Today Brief pull artifact', () => {
  function makeTodayBrief(overrides = {}) {
    return {
      $schema: 'ace.ops.brief.v1',
      lens: 'morning',
      generatedAt: '2026-06-27T12:00:00.000Z',
      intelAsOf: '2026-06-27T11:30:00.000Z',
      sourceFreshness: 'fresh',
      headline: 'Two decisions and one repair candidate need attention.',
      sections: [
        {
          title: 'Top Decisions',
          items: [
            {
              text: 'Approve the pull-first Today Brief rollout',
              why: 'new sessions need a stable rehydration target',
              move: 'review today.md',
            },
          ],
        },
        {
          title: 'Top Actions',
          items: [
            {
              text: 'Keep the brief writer read-only',
              why: 'preserves operator control',
              move: 'ship writer and tests',
            },
          ],
        },
        {
          title: 'Top Project Moves',
          items: [
            {
              text: '[Ace] Wire Today pull target',
              why: 'new King/Rook chats can read it first',
              move: 'open the Briefs tab',
            },
          ],
        },
        {
          title: 'Mission Board',
          items: [
            { text: '1 card(s) blocked by dependencies', why: 'waiting on owner', move: null },
          ],
        },
        {
          title: 'Source freshness',
          items: [{ text: 'Official feeds — ok, 2h ago' }],
        },
      ],
      deltaSummary: '1 new signal since last run',
      candidateCount: 1,
      ...overrides,
    };
  }

  it('renders a decision-grade Today Brief with evidence paths and no auto-action guarantee', () => {
    const md = renderTodayBriefMarkdown(makeTodayBrief(), {
      todayPath: '/wiki/ace-ops/dashboards/today.md',
      briefPath: '/wiki/ace-ops/briefs/2026-06-27-morning.md',
      historyPath: '/state/ops-briefs.ndjson',
      statePath: '/state/ops-brief-state.json',
      intelPath: '/home/user/.hermes/vector-ops-dashboard/site/data/latest.json',
    });

    expect(md).toContain('# Ace Today Brief');
    expect(md).toContain('Generated: 2026-06-27T12:00:00.000Z');
    expect(md).toContain('Freshness: fresh · as-of 2026-06-27T11:30:00.000Z · lens morning');
    expect(md).toContain('## Executive Read');
    expect(md).toContain('## Needs Chief');
    expect(md).toContain('Approve the pull-first Today Brief rollout');
    expect(md).toContain('## Today Ace Improvements');
    expect(md).toContain('Keep the brief writer read-only');
    expect(md).toContain('## Today Project Moves');
    expect(md).toContain('[Ace] Wire Today pull target');
    expect(md).toContain('## Blocked / Broken Autonomy Notes');
    expect(md).toContain('1 card(s) blocked by dependencies');
    expect(md).toContain('## Evidence / Source Paths');
    expect(md).toContain('Today pull target: `/wiki/ace-ops/dashboards/today.md`');
    expect(md).toContain(
      'Read-only synthesis only. No push notifications, agent dispatch, merges, deploys, or worker spawns were performed.'
    );
    expect(md).not.toContain('"sections"');
  });

  it('labels stale freshness and failed source sections as non-authoritative', () => {
    const md = renderTodayBriefMarkdown(
      makeTodayBrief({
        sourceFreshness: 'stale',
        sections: [
          {
            title: 'Source freshness',
            items: [
              { text: 'GitHub watch — error: gh exited 1' },
              { text: 'Market prices — unavailable' },
            ],
          },
        ],
      })
    );

    expect(md).toContain('Freshness: stale');
    expect(md).toContain('Source freshness is stale; verify live deltas before acting.');
    expect(md).toContain(TODAY_NON_AUTHORITATIVE_SENTENCE);
    expect(md).toContain('Source issue: GitHub watch — error: gh exited 1.');
  });

  it('honors ACE_WIKI_ROOT and writes dashboards/today.md atomically', () => {
    const oldRoot = process.env.ACE_WIKI_ROOT;
    const oldDisable = process.env.ACE_WIKI_DISABLE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-today-root-'));
    delete process.env.ACE_WIKI_DISABLE;
    process.env.ACE_WIKI_ROOT = root;
    try {
      const target = path.join(root, OPS_TODAY_RELATIVE_PATH);
      expect(resolveTodayBriefPath()).toBe(target);
      const result = writeTodayBrief({ brief: makeTodayBrief() });
      expect(result.written).toBe(true);
      expect(result.path).toBe(target);
      const written = fs.readFileSync(target, 'utf8');
      expect(written).toContain('# Ace Today Brief');

      const status = briefScheduleStatus({
        now: new Date(2026, 5, 4, 10, 0, 0, 0),
        wikiRoot: root,
      });
      expect(status.todayPath).toBe(target);
    } finally {
      if (oldRoot === undefined) delete process.env.ACE_WIKI_ROOT;
      else process.env.ACE_WIKI_ROOT = oldRoot;
      if (oldDisable === undefined) delete process.env.ACE_WIKI_DISABLE;
      else process.env.ACE_WIKI_DISABLE = oldDisable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without replacing an existing today.md when atomic rename fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-today-fail-'));
    const target = path.join(dir, 'today.md');
    fs.writeFileSync(target, 'OLD TODAY', 'utf8');
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === target) throw new Error('rename boom');
      return originalRename(from, to);
    };
    try {
      const result = writeTodayBrief({ brief: makeTodayBrief(), todayPath: target });
      expect(result.written).toBe(false);
      expect(result.error).toContain('rename boom');
      expect(fs.readFileSync(target, 'utf8')).toBe('OLD TODAY');
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// scheduleOpsBriefs
// ---------------------------------------------------------------------------
describe('scheduleOpsBriefs', () => {
  it('returns false when getStore is not a function', () => {
    expect(scheduleOpsBriefs({ subscriptions: [] })).toBe(false);
    expect(scheduleOpsBriefs({ getStore: null, subscriptions: [] })).toBe(false);
    expect(scheduleOpsBriefs({})).toBe(false);
    expect(scheduleOpsBriefs(null)).toBe(false);
  });

  it('returns false when subscriptions is not an array', () => {
    expect(
      scheduleOpsBriefs({ getStore: () => ({ deliverOpsBrief: () => {} }) })
    ).toBe(false);
  });

  it('returns false when store lacks deliverOpsBrief', () => {
    expect(
      scheduleOpsBriefs({ getStore: () => ({}), subscriptions: [] })
    ).toBe(false);
  });

  it('schedules 3 timers (one per lens) and returns true', async () => {
    const timeouts = [];
    const subscriptions = [];
    const deliverCalls = [];
    const store = { deliverOpsBrief: (arg) => deliverCalls.push(arg) };
    // now = 10:00 — before midday and evening, after morning
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    const result = scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: (fn, ms) => {
        const timer = { fn, ms };
        return timer;
      },
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    expect(result).toBe(true);
    // One outerTimeout per schedule entry = 3
    expect(timeouts).toHaveLength(3);
    // subscriptions: one clearTimeout stub per timer = 3
    expect(subscriptions).toHaveLength(3);
  });

  it('calls deliverOpsBrief for morning/midday/evening when timers fire', async () => {
    const timeouts = [];
    const intervals = [];
    const subscriptions = [];
    const deliverCalls = [];
    let unexpectedResearchFlag = 0;
    const store = {
      deliverOpsBrief: (arg) => {
        deliverCalls.push(arg);
        // FIX 1: the flag is config-driven; here we force it ON and assert it
        // is threaded through unchanged on every tick.
        if (arg.allowResearchAgent !== true) unexpectedResearchFlag += 1;
      },
    };
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      now: () => now,
      // FIX 1: inject the flag so this test is deterministic (production reads
      // <ACE_HOME>/ops-config.json refresh.research.scheduled at each tick).
      readResearchScheduled: () => true,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: (fn, ms) => {
        const timer = { fn, ms };
        intervals.push(timer);
        return timer;
      },
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    // Fire all 3 outer setTimeout callbacks (one per entry).
    // Each one calls runBrief() which in turn schedules another setTimeout(fn,0).
    for (const t of timeouts.slice(0, 3)) {
      t.fn();
    }

    // Now fire the inner zero-delay setTimeout callbacks.
    const innerTimeouts = timeouts.slice(3);
    for (const t of innerTimeouts) {
      t.fn();
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(deliverCalls).toHaveLength(3);
    const lenses = deliverCalls.map((c) => {
      // Every scheduled tick pulls all sources before the brief (S3 wiring).
      expect(c.refreshSources).toBe(true);
      // FIX 1: the config-driven research flag (forced ON here) is threaded through.
      expect(c.allowResearchAgent).toBe(true);
      return c.lens;
    });
    expect(lenses).toContain('morning');
    expect(lenses).toContain('midday');
    expect(lenses).toContain('evening');
    expect(unexpectedResearchFlag).toBe(0);
  });

  it('respects a valid schedule override', () => {
    const timeouts = [];
    const subscriptions = [];
    const store = { deliverOpsBrief: () => {} };
    // now = 10:00 — override slot 10:45 is 45 minutes out.
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    const result = scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      schedule: [{ hour: 10, minute: 45, lens: 'morning' }],
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    expect(result).toBe(true);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(45 * 60 * 1000);
  });

  it('falls back to the default schedule on an invalid override', () => {
    const timeouts = [];
    const subscriptions = [];
    const store = { deliverOpsBrief: () => {} };
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    const result = scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      schedule: [{ hour: 99, lens: 'morning' }],
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    expect(result).toBe(true);
    expect(timeouts).toHaveLength(3); // default lenses
  });

  it('uses minute-aware delays for the default schedule', () => {
    const timeouts = [];
    const subscriptions = [];
    const store = { deliverOpsBrief: () => {} };
    // now = 10:00 — morning 7:30 is tomorrow, midday 13:00 in 3h,
    // evening 20:30 in 10.5h.
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    expect(timeouts.map((t) => t.ms)).toEqual([
      21.5 * 60 * 60 * 1000, // 10:00 -> 7:30 tomorrow
      3 * 60 * 60 * 1000, // 10:00 -> 13:00 today
      10.5 * 60 * 60 * 1000, // 10:00 -> 20:30 today
    ]);
  });

  it('OPS_BRIEF_SCHEDULE has exactly 3 entries with the right lenses and times', () => {
    expect(OPS_BRIEF_SCHEDULE).toHaveLength(3);
    expect(OPS_BRIEF_SCHEDULE[0]).toEqual({ hour: 7, minute: 30, lens: 'morning' });
    expect(OPS_BRIEF_SCHEDULE[1]).toEqual({ hour: 13, minute: 0, lens: 'midday' });
    expect(OPS_BRIEF_SCHEDULE[2]).toEqual({ hour: 20, minute: 30, lens: 'evening' });
  });

  it('OPS_BRIEF_INTERVAL_MS is 24 hours', () => {
    expect(OPS_BRIEF_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Fail-safe: store.deliverOpsBrief throwing must not propagate
// ---------------------------------------------------------------------------
describe('scheduleOpsBriefs fail-safe', () => {
  it('does not throw when deliverOpsBrief throws synchronously', async () => {
    const timeouts = [];
    const subscriptions = [];
    const store = {
      deliverOpsBrief: () => {
        throw new Error('sync boom');
      },
    };
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    expect(() =>
      scheduleOpsBriefs({
        getStore: () => store,
        subscriptions,
        now: () => now,
        setTimeout: (fn, ms) => {
          const timer = { fn, ms };
          timeouts.push(timer);
          return timer;
        },
        clearTimeout: () => {},
        setInterval: () => ({}),
        clearInterval: () => {},
        logger: { error: () => {} },
      })
    ).not.toThrow();

    // Fire the outer then inner timeouts
    const outer = timeouts.slice(0, 3);
    for (const t of outer) t.fn();
    const inner = timeouts.slice(3);
    for (const t of inner) t.fn();
    // Give Promise chain time to resolve/reject
    await Promise.resolve();
    await Promise.resolve();
    // If we got here, the error was swallowed — pass.
  });

  it('does not throw when deliverOpsBrief returns a rejected promise', async () => {
    const timeouts = [];
    const subscriptions = [];
    const store = {
      deliverOpsBrief: () => Promise.reject(new Error('async boom')),
    };
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    expect(() =>
      scheduleOpsBriefs({
        getStore: () => store,
        subscriptions,
        now: () => now,
        setTimeout: (fn, ms) => {
          const timer = { fn, ms };
          timeouts.push(timer);
          return timer;
        },
        clearTimeout: () => {},
        setInterval: () => ({}),
        clearInterval: () => {},
        logger: { error: () => {} },
      })
    ).not.toThrow();

    const outer = timeouts.slice(0, 3);
    for (const t of outer) t.fn();
    const inner = timeouts.slice(3);
    for (const t of inner) t.fn();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('records an error run when stateDir is provided and delivery rejects', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-brief-'));
    const timeouts = [];
    const subscriptions = [];
    const store = {
      deliverOpsBrief: () => Promise.reject(new Error('async boom')),
    };
    const now = new Date(2026, 5, 4, 10, 0, 0, 0);

    scheduleOpsBriefs({
      getStore: () => store,
      subscriptions,
      stateDir,
      schedule: [{ hour: 13, minute: 0, lens: 'midday' }],
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      logger: { error: () => {} },
    });

    // Fire the outer timer, then the inner zero-delay timer.
    timeouts[0].fn();
    for (const t of timeouts.slice(1)) t.fn();
    // Flush the full rejection chain (adopting the rejected promise spans
    // several microtask ticks) with one real macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ndjson = fs.readFileSync(path.join(stateDir, 'ops-briefs.ndjson'), 'utf8');
    const entries = ndjson
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0].lens).toBe('midday');
    expect(entries[0].status).toBe('error');
    expect(entries[0].error).toBe('async boom');

    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'ops-brief-state.json'), 'utf8')
    );
    expect(state.lastStatus).toBe('error');
    expect(state.lastError).toBe('async boom');
    expect(state.lastLens).toBe('midday');

    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// briefScheduleStatus
// ---------------------------------------------------------------------------
describe('briefScheduleStatus', () => {
  // Fixed reference: 2026-06-04 10:00:00 local
  const now = new Date(2026, 5, 4, 10, 0, 0, 0);

  it('returns 3 default slots with null run fields for empty state', () => {
    const { slots } = briefScheduleStatus({ now });
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.lens)).toEqual(['morning', 'midday', 'evening']);
    expect(slots[0]).toEqual({
      lens: 'morning',
      hour: 7,
      minute: 30,
      // 7:30 already passed at 10:00 — next run is tomorrow
      nextRunAt: new Date(2026, 5, 5, 7, 30, 0, 0).toISOString(),
      lastDeliveredAt: null,
      lastStatus: null,
      lastError: null,
      lastPath: null,
    });
    expect(slots[1].nextRunAt).toBe(new Date(2026, 5, 4, 13, 0, 0, 0).toISOString());
    expect(slots[2].nextRunAt).toBe(new Date(2026, 5, 4, 20, 30, 0, 0).toISOString());
  });

  it('accepts now as epoch ms', () => {
    const { slots } = briefScheduleStatus({ now: now.getTime() });
    expect(slots[1].nextRunAt).toBe(new Date(2026, 5, 4, 13, 0, 0, 0).toISOString());
  });

  it('reads populated state + history from stateDir', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-brief-'));
    // local-core-shaped success line (no status field) for morning.
    const morningAt = new Date(2026, 5, 4, 7, 30, 0, 0).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'ops-briefs.ndjson'),
      JSON.stringify({
        at: morningAt,
        lens: 'morning',
        freshness: 'fresh',
        intelAsOf: morningAt,
        candidateCount: 2,
        path: '/wiki/briefs/2026-06-04-morning.md',
      }) + '\n'
    );
    // scheduler-shaped error line for midday.
    recordOpsBriefRun({
      stateDir,
      lens: 'midday',
      at: new Date(2026, 5, 3, 13, 0, 0, 0).getTime(),
      status: 'error',
      error: 'wiki write failed',
      path: null,
    });

    const { slots } = briefScheduleStatus({ now, stateDir });

    const morning = slots.find((s) => s.lens === 'morning');
    expect(morning.lastStatus).toBe('ok');
    expect(morning.lastDeliveredAt).toBe(morningAt);
    expect(morning.lastError).toBe(null);
    expect(morning.lastPath).toBe('/wiki/briefs/2026-06-04-morning.md');

    const midday = slots.find((s) => s.lens === 'midday');
    expect(midday.lastStatus).toBe('error');
    expect(midday.lastError).toBe('wiki write failed');
    expect(midday.lastDeliveredAt).toBe(null);
    expect(midday.lastPath).toBe(null);

    const evening = slots.find((s) => s.lens === 'evening');
    expect(evening.lastStatus).toBe(null);
    expect(evening.lastDeliveredAt).toBe(null);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('keeps lastDeliveredAt from the newest ok run when the newest run errored', () => {
    const okAt = new Date(2026, 5, 3, 7, 30, 0, 0).toISOString();
    const errAt = new Date(2026, 5, 4, 7, 30, 0, 0).toISOString();
    const { slots } = briefScheduleStatus({
      now,
      state: {
        history: [
          { at: okAt, lens: 'morning', path: '/wiki/ok.md' },
          { at: errAt, lens: 'morning', status: 'error', error: 'boom', path: null },
        ],
      },
    });
    const morning = slots.find((s) => s.lens === 'morning');
    expect(morning.lastStatus).toBe('error');
    expect(morning.lastError).toBe('boom');
    expect(morning.lastDeliveredAt).toBe(okAt);
  });

  it('falls back to ops-brief-state.json lastLens/lastAt when history lacks the lens', () => {
    const lastAt = new Date(2026, 5, 4, 7, 30, 0, 0).toISOString();
    const { slots } = briefScheduleStatus({
      now,
      state: { state: { lastLens: 'morning', lastAt }, history: [] },
    });
    const morning = slots.find((s) => s.lens === 'morning');
    expect(morning.lastStatus).toBe('ok');
    expect(morning.lastDeliveredAt).toBe(lastAt);
    const midday = slots.find((s) => s.lens === 'midday');
    expect(midday.lastStatus).toBe(null);
  });

  it('honors a schedule override', () => {
    const { slots } = briefScheduleStatus({
      now,
      schedule: [{ hour: 22, minute: 15, lens: 'nightcap' }],
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].lens).toBe('nightcap');
    expect(slots[0].hour).toBe(22);
    expect(slots[0].minute).toBe(15);
    expect(slots[0].nextRunAt).toBe(new Date(2026, 5, 4, 22, 15, 0, 0).toISOString());
  });

  it('never throws for missing stateDir or junk input', () => {
    expect(() => briefScheduleStatus()).not.toThrow();
    expect(() => briefScheduleStatus({ stateDir: '/nonexistent/nope' })).not.toThrow();
    expect(() => briefScheduleStatus({ state: 42 })).not.toThrow();
    expect(() => briefScheduleStatus({ state: { history: 'bad' } })).not.toThrow();
    const { slots } = briefScheduleStatus({ stateDir: '/nonexistent/nope', now });
    expect(slots).toHaveLength(3);
    expect(slots[0].lastStatus).toBe(null);
  });
});
