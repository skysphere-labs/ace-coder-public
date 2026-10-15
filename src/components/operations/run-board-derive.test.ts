import { describe, expect, it } from 'vitest';
import type { RunLedgerCard } from '../../lib/types';
import { ARCHIVE_CUTOFF_MS, deriveCardStatus, fmtAge, splitArchived } from './run-board-derive';

// Unit tests for the Run Board's pure derive helpers (house convention:
// exported pure helpers get real unit tests; the renderer wiring around them
// is covered by run-board-layout.test.ts source-text assertions).

const HOUR = 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

function card(over: Partial<RunLedgerCard>): RunLedgerCard {
  return {
    id: 'run-1',
    stage: 'done',
    nextAction: null,
    validationStatus: null,
    workerOutcome: null,
    lastEventType: null,
    lastTs: null,
    ...over,
  } as RunLedgerCard;
}

describe('splitArchived (done > 24h fall out of the columns)', () => {
  it('archives done cards older than the cutoff and keeps fresh ones on the board', () => {
    const fresh = card({ id: 'fresh', stage: 'done', lastTs: NOW - 2 * HOUR });
    const stale = card({ id: 'stale', stage: 'done', lastTs: NOW - 25 * HOUR });
    const { active, archived } = splitArchived([fresh, stale], NOW);
    expect(active.map((c) => c.id)).toEqual(['fresh']);
    expect(archived.map((c) => c.id)).toEqual(['stale']);
  });

  it('never archives non-done stages, however old', () => {
    const oldBlocked = card({ id: 'b', stage: 'blocked', lastTs: NOW - 100 * HOUR });
    const oldActive = card({ id: 'a', stage: 'in_progress', lastTs: NOW - 100 * HOUR });
    const { active, archived } = splitArchived([oldBlocked, oldActive], NOW);
    expect(archived).toEqual([]);
    expect(active).toHaveLength(2);
  });

  it('is defensive: a done card with no usable lastTs stays on the board (section hides when nothing qualifies)', () => {
    const noTs = card({ id: 'nots', stage: 'done', lastTs: null });
    const nan = card({ id: 'nan', stage: 'done', lastTs: Number.NaN });
    const { active, archived } = splitArchived([noTs, nan], NOW);
    expect(archived).toEqual([]);
    expect(active).toHaveLength(2);
  });

  it('uses a 24h default cutoff and honors an explicit one', () => {
    expect(ARCHIVE_CUTOFF_MS).toBe(24 * HOUR);
    const c = card({ id: 'c', stage: 'done', lastTs: NOW - 2 * HOUR });
    expect(splitArchived([c], NOW, HOUR).archived.map((x) => x.id)).toEqual(['c']);
  });
});

describe('fmtAge (compact relative age for the card face)', () => {
  it('formats minutes, hours, and days compactly', () => {
    expect(fmtAge(NOW - 20_000, NOW)).toBe('now');
    expect(fmtAge(NOW - 12 * 60_000, NOW)).toBe('12m');
    expect(fmtAge(NOW - 3 * HOUR, NOW)).toBe('3h');
    expect(fmtAge(NOW - 72 * HOUR, NOW)).toBe('3d');
  });

  it('returns null for missing or future timestamps instead of lying', () => {
    expect(fmtAge(null, NOW)).toBeNull();
    expect(fmtAge(undefined, NOW)).toBeNull();
    expect(fmtAge(Number.NaN, NOW)).toBeNull();
    expect(fmtAge(NOW + HOUR, NOW)).toBeNull();
  });
});

describe('deriveCardStatus (stage-appropriate one-liner, always present)', () => {
  it('prefers the reconciler nextAction when present', () => {
    expect(deriveCardStatus(card({ stage: 'in_progress', nextAction: 'sync_worker' }))).toBe('sync_worker');
  });

  it('falls back to what the stage means', () => {
    expect(deriveCardStatus(card({ stage: 'todo' }))).toBe('queued — waiting for dispatch');
    expect(deriveCardStatus(card({ stage: 'in_progress' }))).toBe('worker running');
    expect(deriveCardStatus(card({ stage: 'in_progress', lastEventType: 'validator.dispatched' }))).toBe('validating');
    expect(deriveCardStatus(card({ stage: 'ready_to_review' }))).toBe('awaiting validator');
    expect(deriveCardStatus(card({ stage: 'ready_to_review', validationStatus: 'PASS' }))).toBe('validator pass');
    expect(deriveCardStatus(card({ stage: 'done', validationStatus: 'MERGED' }))).toBe('merged to main');
    expect(deriveCardStatus(card({ stage: 'done' }))).toBe('done');
    expect(deriveCardStatus(card({ stage: 'blocked' }))).toBe('blocked — needs Chief');
    expect(deriveCardStatus(card({ stage: 'blocked', workerOutcome: 'BLOCKED' }))).toBe('worker blocked — needs Chief');
  });
});
