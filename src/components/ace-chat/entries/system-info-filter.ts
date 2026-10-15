export function isSelfImprovementReviewSummaryText(text: string) {
  return /^\s*(?:💾\s*)?Self-improvement review:\s+\S/i.test(text);
}

export function isVisibleSystemInfoText(text: string) {
  if (isSelfImprovementReviewSummaryText(text)) return true;
  const normalized = text.toLowerCase();
  if (/\bcreation[_ -]nudge\b/.test(normalized)) return false;
  if (/\bself[_ -]improvement\s+skills?\s+updates?\s+reviews?\b/.test(normalized)) return false;
  if (/\bskills?\s+updates?\s+reviews?\s+completed\b/.test(normalized)) return false;
  const internal = /\bbackground\b|\binternal\b|\bnotify\b|\bnudge\b/.test(normalized);
  if (!internal) return true;
  if (/\bskills?[_ -](?:reviews?|updates?)\b|\bself[_ -]improvement\b/.test(normalized)) return false;
  if (/\bcurator\b/.test(normalized) && /\b(?:skill|skills|review|update|harvest)/.test(normalized)) return false;
  return true;
}
