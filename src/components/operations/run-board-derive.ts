import type { RunLedgerCard } from '../../lib/types';

// Pure derive helpers for the Run Board — kept out of RunBoardPanel so the
// stage-status line, the age label, and the Archived split are unit-testable
// without rendering (house convention: pure exported helpers get vitest unit
// tests; renderer wiring gets source-text assertions).

// Done cards whose last ledger event is older than this fall out of the Done
// column into the collapsed Archived strip.
export const ARCHIVE_CUTOFF_MS = 24 * 60 * 60 * 1000;

// Split the (already project-filtered) cards into the live board vs the
// archived strip. Defensive: a done card with no usable lastTs stays on the
// board (never silently vanishes into an un-datable archive). `now` defaults
// to the wall clock inside the helper (same pattern as fmtAge) so the caller's
// render path stays free of impure reads; tests pass it explicitly.
export function splitArchived(
  cards: RunLedgerCard[],
  now: number = Date.now(),
  cutoffMs: number = ARCHIVE_CUTOFF_MS
): { active: RunLedgerCard[]; archived: RunLedgerCard[] } {
  const active: RunLedgerCard[] = [];
  const archived: RunLedgerCard[] = [];
  for (const c of cards) {
    if (
      c.stage === 'done' &&
      typeof c.lastTs === 'number' &&
      Number.isFinite(c.lastTs) &&
      now - c.lastTs > cutoffMs
    ) {
      archived.push(c);
    } else {
      active.push(c);
    }
  }
  return { active, archived };
}

// Compact relative age ("now", "12m", "3h", "2d") from the card's last ledger
// event. Null when the ts is missing or in the future (clock skew) — the card
// then just omits its age label rather than lying.
export function fmtAge(lastTs: number | null | undefined, now: number = Date.now()): string | null {
  if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return null;
  const ms = now - lastTs;
  if (ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// One-line, stage-appropriate status for the card face. The reconciler's own
// next action wins when present; otherwise fall back to what the stage means.
export function deriveCardStatus(
  card: Pick<
    RunLedgerCard,
    'stage' | 'nextAction' | 'validationStatus' | 'workerOutcome' | 'lastEventType'
  >
): string {
  if (card.nextAction) return card.nextAction;
  switch (card.stage) {
    case 'done':
      return card.validationStatus === 'MERGED' ? 'merged to main' : 'done';
    case 'blocked':
      return card.workerOutcome === 'BLOCKED' ? 'worker blocked — needs Chief' : 'blocked — needs Chief';
    case 'ready_to_review':
      return card.validationStatus
        ? `validator ${card.validationStatus.toLowerCase()}`
        : 'awaiting validator';
    case 'in_progress':
      return (card.lastEventType || '').startsWith('validator') ? 'validating' : 'worker running';
    default:
      return 'queued — waiting for dispatch';
  }
}
