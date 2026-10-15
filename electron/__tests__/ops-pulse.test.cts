// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
// Ops Pulse — pure shaper + ranking-rule tests (electron/ops-pulse.cts).
// Everything here is pure: fixed nowMs, no exec, no db.

import { describe, expect, it } from 'vitest';

const pulse = require('../ops-pulse.cts');

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const DAY = 86_400_000;

const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

function signals(overrides = {}) {
  return {
    git: { ok: true, error: null, commits: 12, lastCommitAt: iso(1), activeDays: 6, daily: [], ...overrides.git },
    prs: {
      ok: true,
      error: null,
      open: 0,
      drafts: 0,
      awaitingReview: 0,
      ciFailing: 0,
      merged: 2,
      awaitingReviewNumbers: [],
      ciFailingNumbers: [],
      items: [],
      ...overrides.prs,
    },
    missions: {
      cards: 0,
      inProgress: 0,
      readyToReview: 0,
      blocked: 0,
      ready: 0,
      staleReady: 0,
      readyNames: [],
      ...overrides.missions,
    },
    agents: { activeTasks: 0, busy: 0, agents: [], ...overrides.agents },
    telemetry: {
      ok: true,
      error: null,
      events: 0,
      errors: 0,
      errorRate: 0,
      tokensIn: 0,
      tokensOut: 0,
      dispatches: 0,
      ...overrides.telemetry,
    },
  };
}

describe('rankSuggestions', () => {
  it('always ends with the steady fallback and returns score-descending order', () => {
    const ranked = pulse.rankSuggestions(signals(), { nowMs: NOW });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[ranked.length - 1].id).toBe('steady');
    const scores = ranked.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('ranks failing CI above awaiting review above ready dispatch', () => {
    const ranked = pulse.rankSuggestions(
      signals({
        prs: { open: 3, ciFailing: 1, ciFailingNumbers: [410], awaitingReview: 2, awaitingReviewNumbers: [411, 412] },
        missions: { cards: 2, ready: 1, readyNames: ['ship-it'] },
      }),
      { nowMs: NOW }
    );
    expect(ranked.map((s) => s.id).slice(0, 3)).toEqual(['fix-ci', 'review-prs', 'dispatch-ready']);
    expect(ranked[0].severity).toBe('red');
    expect(ranked[0].reason).toContain('#410');
  });

  it('ranks blocked cards above review and marks them red', () => {
    const ranked = pulse.rankSuggestions(
      signals({
        prs: { open: 1, awaitingReview: 1, awaitingReviewNumbers: [7] },
        missions: { cards: 3, blocked: 2 },
      }),
      { nowMs: NOW }
    );
    expect(ranked[0].id).toBe('unblock-cards');
    expect(ranked[0].severity).toBe('red');
    expect(ranked[1].id).toBe('review-prs');
  });

  it('flags stale ready cards above fresh ready cards', () => {
    const ranked = pulse.rankSuggestions(
      signals({ missions: { cards: 4, ready: 3, staleReady: 2, readyNames: ['a', 'b', 'c'] } }),
      { nowMs: NOW }
    );
    expect(ranked[0].id).toBe('dispatch-stale-ready');
    expect(ranked[1].id).toBe('dispatch-ready');
    expect(ranked[1].title).toContain('1 ready card');
  });

  it('fires the telemetry error rule only past both thresholds', () => {
    const hot = pulse.rankSuggestions(
      signals({ telemetry: { events: 20, errors: 8, errorRate: 0.4 } }),
      { nowMs: NOW }
    );
    expect(hot[0].id).toBe('investigate-errors');
    const fewEvents = pulse.rankSuggestions(
      signals({ telemetry: { events: 4, errors: 4, errorRate: 1 } }),
      { nowMs: NOW }
    );
    expect(fewEvents.map((s) => s.id)).not.toContain('investigate-errors');
    const lowRate = pulse.rankSuggestions(
      signals({ telemetry: { events: 100, errors: 5, errorRate: 0.05 } }),
      { nowMs: NOW }
    );
    expect(lowRate.map((s) => s.id)).not.toContain('investigate-errors');
  });

  it('suggests spawning on an idle project and stays quiet on an active one', () => {
    const idle = pulse.rankSuggestions(
      signals({ git: { commits: 0, lastCommitAt: iso(12), activeDays: 0 } }),
      { nowMs: NOW }
    );
    expect(idle[0].id).toBe('spawn-idle');
    expect(idle[0].title).toContain('12 days');
    const active = pulse.rankSuggestions(
      signals({ git: { commits: 0, lastCommitAt: iso(12) }, agents: { activeTasks: 1 } }),
      { nowMs: NOW }
    );
    expect(active.map((s) => s.id)).not.toContain('spawn-idle');
  });

  it('falls back to steady/green when nothing fires', () => {
    const ranked = pulse.rankSuggestions(signals(), { nowMs: NOW });
    expect(ranked[0].id).toBe('steady');
    expect(ranked[0].severity).toBe('green');
    expect(pulse.healthFromSuggestions(ranked)).toBe('green');
  });
});

describe('healthFromSuggestions', () => {
  it('rolls worst-of severity ignoring the steady fallback', () => {
    expect(
      pulse.healthFromSuggestions([
        { id: 'review-prs', severity: 'yellow' },
        { id: 'steady', severity: 'green' },
      ])
    ).toBe('yellow');
    expect(
      pulse.healthFromSuggestions([
        { id: 'fix-ci', severity: 'red' },
        { id: 'review-prs', severity: 'yellow' },
      ])
    ).toBe('red');
  });
});

describe('buildGitActivity', () => {
  it('buckets commit timestamps into a zero-filled 30-day series', () => {
    const stdout = [iso(0), iso(0), iso(2), iso(40), 'garbage', ''].join('\n');
    const git = pulse.buildGitActivity(stdout, { nowMs: NOW });
    expect(git.ok).toBe(true);
    // The 40-days-ago line still parses (caller's --since bounds the window);
    // garbage lines are dropped.
    expect(git.commits).toBe(4);
    expect(git.lastCommitAt).toBe(iso(0));
    expect(git.daily).toHaveLength(30);
    expect(git.daily[29].commits).toBe(2);
    expect(git.daily[27].commits).toBe(1);
  });
});

describe('shapePrSignals', () => {
  it('counts open/draft/review/CI buckets and 30-day merges', () => {
    const rows = [
      { number: 1, state: 'OPEN', isDraft: false, reviewDecision: null, statusCheckRollup: [{ conclusion: 'FAILURE' }] },
      { number: 2, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [] },
      { number: 3, state: 'OPEN', isDraft: true, statusCheckRollup: [] },
      { number: 4, state: 'MERGED', mergedAt: iso(5) },
      { number: 5, state: 'MERGED', mergedAt: iso(45) },
      { number: 6, state: 'CLOSED' },
    ];
    const prs = pulse.shapePrSignals(rows, { nowMs: NOW });
    expect(prs.open).toBe(3);
    expect(prs.drafts).toBe(1);
    expect(prs.awaitingReview).toBe(1);
    expect(prs.awaitingReviewNumbers).toEqual([1]);
    expect(prs.ciFailing).toBe(1);
    expect(prs.ciFailingNumbers).toEqual([1]);
    expect(prs.merged).toBe(1);
    expect(prs.items).toHaveLength(3);
  });

  it('maps cached workspace openPrs (checksStatus) onto the same shape', () => {
    const rows = pulse.cachedPrRows([
      { number: 9, title: 't', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', checksStatus: 'failure' },
    ]);
    const prs = pulse.shapePrSignals(rows, { nowMs: NOW });
    expect(prs.open).toBe(1);
    expect(prs.ciFailing).toBe(1);
    expect(prs.awaitingReview).toBe(1);
  });
});

describe('shapeMissionSignals', () => {
  it('counts stages, blockers, and stale ready cards', () => {
    const cards = [
      { cardStage: 'in_progress', dispatchStatus: 'not_dispatchable' },
      { cardStage: 'ready_to_review' },
      { dispatchStatus: 'blocked_by_dependencies' },
      { gateStatus: 'blocked' },
      { dispatchReady: true, latestEvent: { createdAt: iso(5) }, name: 'old-card' },
      { dispatchReady: true, latestEvent: { createdAt: iso(1) }, name: 'fresh-card' },
      { dispatchReady: true, name: 'no-timestamp' },
      { archived: true, dispatchReady: true },
    ];
    const missions = pulse.shapeMissionSignals(cards, { nowMs: NOW });
    expect(missions.cards).toBe(7);
    expect(missions.inProgress).toBe(1);
    expect(missions.readyToReview).toBe(1);
    expect(missions.blocked).toBe(2);
    expect(missions.ready).toBe(3);
    // Only the dated 5-day-old card is stale; unknown timestamps never count.
    expect(missions.staleReady).toBe(1);
  });
});

describe('shapeTelemetrySignals', () => {
  it('sums aggregate rows into the effectiveness rollup', () => {
    const tel = pulse.shapeTelemetrySignals({
      ok: true,
      rows: [
        { key: 'task.dispatch', count: 4, errors: 1, tokensIn: 100, tokensOut: 50 },
        { key: 'agent.exit', count: 6, errors: 2, tokensIn: 0, tokensOut: 0 },
      ],
    });
    expect(tel.ok).toBe(true);
    expect(tel.events).toBe(10);
    expect(tel.errors).toBe(3);
    expect(tel.errorRate).toBeCloseTo(0.3);
    expect(tel.tokensIn).toBe(100);
    expect(tel.dispatches).toBe(4);
  });

  it('degrades to ok:false with the upstream error', () => {
    const tel = pulse.shapeTelemetrySignals({ ok: false, error: 'telemetry db unavailable' });
    expect(tel.ok).toBe(false);
    expect(tel.error).toBe('telemetry db unavailable');
  });
});

describe('collectOpsPulse', () => {
  it('builds one card per non-personal workspace with real ranked output', async () => {
    const exec = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'log' && args[1]?.startsWith('--since')) {
        return { code: 0, stdout: `${iso(1)}\n${iso(3)}\n`, stderr: '', error: null };
      }
      if (cmd === 'gh') {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 21, title: 'fix', state: 'OPEN', isDraft: false, reviewDecision: null, statusCheckRollup: [] },
          ]),
          stderr: '',
          error: null,
        };
      }
      return { code: 0, stdout: '', stderr: '', error: null };
    };
    const result = await pulse.collectOpsPulse({
      listWorkspaces: () => [
        { id: 'w1', name: 'Ace', path: '/tmp/w1', isRemote: false, githubRepo: 'org/repo', tasks: [], openPrs: [] },
        { id: 'personal', name: 'Personal', isPersonal: true },
      ],
      getMissionBoard: () => ({
        missions: [{ workspaceId: 'w1', cards: [{ dispatchReady: true, latestEvent: { createdAt: iso(10) }, name: 'card-a' }] }],
      }),
      telemetryQuery: () => ({ ok: true, rows: [{ key: 'task.dispatch', count: 2, errors: 0 }] }),
      exec,
      now: () => NOW,
    });
    expect(result.schema).toBe('ace.ops.pulse.v1');
    expect(result.projects).toHaveLength(1);
    const project = result.projects[0];
    expect(project.workspaceId).toBe('w1');
    expect(project.git.commits).toBe(2);
    expect(project.prs.open).toBe(1);
    expect(project.missions.staleReady).toBe(1);
    expect(project.telemetry.events).toBe(2);
    // Open PR awaiting review outranks the stale ready card.
    expect(project.nextStep.id).toBe('review-prs');
    expect(project.health).toBe('yellow');
  });

  it('degrades per-signal when git/gh/telemetry all fail', async () => {
    const exec = async () => ({ code: null, stdout: '', stderr: 'boom', error: new Error('boom') });
    const result = await pulse.collectOpsPulse({
      listWorkspaces: () => [
        { id: 'w1', name: 'p', path: '/tmp/none', isRemote: false, githubRepo: 'org/repo', tasks: [], openPrs: [] },
      ],
      getMissionBoard: () => {
        throw new Error('board down');
      },
      telemetryQuery: () => ({ ok: false, error: 'telemetry not initialized' }),
      exec,
      now: () => NOW,
    });
    const project = result.projects[0];
    expect(project.git.ok).toBe(false);
    expect(project.prs.error).toContain('cached');
    expect(project.telemetry.ok).toBe(false);
    expect(project.nextStep).toBeTruthy();
  });
});
