const DONE_OUTCOMES = new Set(['completed', 'done', 'done-unverified']);
const PR_NUMBER_RX = /(?:\bpr\s*#\s*|\bpull\/)(\d+)\b/i;
const BLOCKED_MAX = 140;

function parsePrNumber(text: any) {
  const match = String(text || '').match(PR_NUMBER_RX);
  return match ? Number(match[1]) : null;
}

function trimBlocked(text: any) {
  const normalized = String(text || '')
    .replace(/\r?\n+/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= BLOCKED_MAX) return normalized;
  return normalized.slice(0, BLOCKED_MAX - 3).trimEnd() + '...';
}

function deriveNextStep(result: any) {
  const outcome = String(result?.outcome || '');
  const pr = result?.pr || result?.prUrl || null;
  const doneText = result?.doneText || result?.detail || '';
  const blockedText = trimBlocked(result?.blockedText || result?.detail || '');

  if (DONE_OUTCOMES.has(outcome) && pr) {
    return {
      next: `verify PR — gh pr view ${pr}; merge only through ace integrate pr-merge after required reviews/checks pass`,
      category: 'verify',
    };
  }

  if (DONE_OUTCOMES.has(outcome)) {
    const prNumber = parsePrNumber(doneText);
    if (prNumber != null) {
      return {
        next: `verify PR — gh pr view ${prNumber}`,
        category: 'verify',
      };
    }
    return {
      next: "review the worker's diff; if good, no action — otherwise spawn a follow-up task",
      category: 'done',
    };
  }

  if (outcome === 'blocked' && blockedText) {
    return {
      next: `unblock: ${blockedText}`,
      category: 'unblock',
    };
  }

  if (outcome === 'dispatched') {
    return {
      next: `worker dispatched — check \`ace state ${result?.streamId || '<streamId>'}\` when you want status`,
      category: 'dispatch',
    };
  }

  return { next: null, category: null };
}

module.exports = { deriveNextStep };
