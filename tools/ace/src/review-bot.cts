// review-bot — pure helpers for reading the org PR review bot (the check named
// 'AI review gate', plus leftover 'validate' / "PR Validator" names) out of a
// GitHub statusCheckRollup, and for parsing its review comment into actionable
// Must-fix findings.
//
// The rollup already folds the review-bot's failing check into
// checkState='failure' (pr-gate rollupCheckState), so the merge gate is safe
// without this module. What it adds is the check BY NAME plus its findings, so
// the spine can AUTHOR A FIXBACK from the verdict instead of parking blind.
//
// Pure: string/array parsing only — no I/O, no clock. The comment format is
// org-owned and can drift, so parsing is deliberately tolerant: findings are
// OPTIONAL; the failing check alone is enough to drive a fixback.

// Check names the org review bot posts under. Kept as tolerant matchers, not
// an exact-string table, so a rename like 'validate' -> 'AI review gate'
// still resolves. Legacy PR Validator names stay matched so in-flight PRs
// keep producing fixbacks until that workflow is gone.
const REVIEW_BOT_NAME_RX = /^validate$|pr[\s_-]?validator|ai review gate/i;

/**
 * A PR check state that represents a genuine FAILURE (not merely
 * pending/success). Same semantics as electron/loops/loop-fixback.cts
 * isFailingCheckState — duplicated here because tools/ace/src is the pure
 * layer and must not import from electron/.
 */
function isFailingCheckState(checkState: any): boolean {
  const s = String(checkState == null ? '' : checkState).trim().toLowerCase();
  return (
    s === 'failure' ||
    s === 'fail' ||
    s === 'failing' ||
    s === 'error' ||
    s === 'errored' ||
    s === 'timed_out' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'action_required'
  );
}

// Normalize one rollup entry's conclusion/state/status onto the same
// success|failure|pending vocabulary pr-gate's rollupCheckState uses.
// FAIL-CLOSED vocabulary: only an explicit success token is 'success'.
// SKIPPED/NEUTRAL/STALE — and any UNKNOWN token (GitHub's conclusion enum
// grows; STARTUP_FAILURE once fell through a default-success here) — are
// 'pending', never 'success': a review that did not verifiably run and pass
// can neither pass release evidence nor terminally fail the run — the
// controller re-requests a ready-head review instead.
function normalizeEntryState(entry: any): string {
  const s = String(entry?.conclusion || entry?.state || entry?.status || '')
    .trim()
    .toUpperCase();
  if (!s) return 'pending';
  if (
    s === 'FAILURE' || s === 'FAILED' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'CANCELLED' ||
    s === 'ACTION_REQUIRED' || s === 'STARTUP_FAILURE'
  ) {
    return 'failure';
  }
  // COMPLETED is a lifecycle STATUS, not a pass conclusion. A check that
  // reports COMPLETED with a missing/empty conclusion has not verifiably
  // passed, so only explicit pass conclusions count as success — a bare
  // COMPLETED falls through to 'pending' and the controller re-requests.
  if (s === 'SUCCESS' || s === 'PASS' || s === 'PASSED' || s === 'OK') {
    return 'success';
  }
  return 'pending';
}

/**
 * Find the org review-bot's check in a `gh pr view --json statusCheckRollup`
 * array. Returns { name, state } (state: 'success'|'failure'|'pending') or
 * null when no matching check is present. The LAST matching entry wins (a
 * re-run supersedes an earlier attempt).
 */
function extractReviewBotCheck(statusCheckRollup: any): any {
  if (!Array.isArray(statusCheckRollup)) return null;
  let found: any = null;
  for (const entry of statusCheckRollup) {
    const name = String(entry?.name || entry?.context || '').trim();
    if (!name || !REVIEW_BOT_NAME_RX.test(name)) continue;
    found = { name, state: normalizeEntryState(entry) };
  }
  return found;
}

// A markdown-ish bullet line: -, *, •, or "1." lists.
const BULLET_RX = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
// A heading or bolded section label, e.g. "## Must-fix", "**Must-fix:**".
const MUST_FIX_HEADING_RX = /must[\s_-]?fix/i;
const SECTION_BREAK_RX = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/;
// The advisory score line, e.g. "3/5", "Score: 2.5 / 5".
const SCORE_RX = /\b([0-5](?:\.\d+)?)\s*\/\s*5\b/;

/**
 * Parse the review-bot's PR comment(s) into { score, mustFix } — the
 * desloppify score (x/5, null when absent) and the Must-fix bullet list
 * (empty when none found). Accepts an array of comment body strings (or
 * objects carrying .body); the LAST comment that looks like a review-bot
 * verdict wins. Never throws — an unrecognized format returns
 * { score: null, mustFix: [] } and the caller falls back to the failing
 * check alone.
 */
function parseReviewBotFindings(commentBodies: any): { score: number | null; mustFix: string[] } {
  const bodies = (Array.isArray(commentBodies) ? commentBodies : [])
    .map((c: any) => (typeof c === 'string' ? c : String(c?.body || '')))
    .filter((b: string) => b.trim());
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const body = bodies[i];
    const scoreMatch = SCORE_RX.exec(body);
    const hasMustFix = MUST_FIX_HEADING_RX.test(body);
    if (!scoreMatch && !hasMustFix) continue;

    const mustFix: string[] = [];
    if (hasMustFix) {
      const lines = body.split(/\r?\n/);
      let inSection = false;
      for (const line of lines) {
        if (!inSection) {
          if (MUST_FIX_HEADING_RX.test(line)) inSection = true;
          continue;
        }
        const bullet = BULLET_RX.exec(line);
        if (bullet) {
          mustFix.push(bullet[1]);
          continue;
        }
        // A new heading/section label ends the Must-fix block; blank lines and
        // wrapped prose between bullets are tolerated.
        if (SECTION_BREAK_RX.test(line) && !MUST_FIX_HEADING_RX.test(line)) break;
      }
    }
    return {
      score: scoreMatch ? Number(scoreMatch[1]) : null,
      mustFix,
    };
  }
  return { score: null, mustFix: [] };
}

module.exports = {
  REVIEW_BOT_NAME_RX,
  isFailingCheckState,
  extractReviewBotCheck,
  parseReviewBotFindings,
};
