// verdict — THE single verdict + per-criterion scorecard parser for the
// mission-card loop. Every consumer (auto-rally, completion classification,
// the merge gate's ledger flip) parses validator output through this module;
// no other file may define a VERDICT regex.
//
// Canonical emit format (what skills instruct validators to write):
//   DONE: VERDICT=PASS on <pr-url> {"verdict":"pass","scorecard":[...]}
//   DONE: VERDICT=REQUEST-CHANGES on <pr-url> {"verdict":"request-changes",...}
//   BLOCKED: VERDICT=BLOCK — <reason>
// The single-line JSON object is the machine carrier (a trailer detail is ONE
// line — see trailers.cts listTerminalTrailers — so scorecard lines cannot
// ride as separate lines). The parser stays tolerant of the legacy
// `VERDICT: PASS` / `VERDICT PASS` shapes.
//
// Scorecard entries grade individual acceptance IDs:
//   {"id":"A1","met":true,"reason":"...","evidence":"file:line|path"}
//   met: true (MET) | false (UNMET) | 'deferred' (DEFERRED-TO-BEHAVIORAL —
//   a UI criterion owned by the computer-use tier; the gate flips it from the
//   verified completion.json, never from the diff validator's say-so).
// Plain-text `A<i>: MET|UNMET|DEFERRED-TO-BEHAVIORAL — reason` lines are also
// accepted for transcripts/PR comments.

const VERDICT_TOKEN_RX = /\bVERDICT\s*[:=]?\s*(PASS|REQUEST[-_ ]?CHANGES|REQUEST|CHANGES|BLOCK|BLOCKED|FAIL)\b/gi;
const SCORECARD_LINE_RX = /\bA(\d+)\s*:\s*(MET|UNMET|DEFERRED[-_ ]?TO[-_ ]?BEHAVIORAL)\b\s*(?:[—–-]+\s*)?([^\n]*)/gi;

function normalizeVerdictToken(token: any) {
  const tok = String(token || '').toUpperCase().replace(/[-_ ]/g, '');
  if (tok === 'PASS') return 'pass';
  if (tok === 'BLOCK' || tok === 'BLOCKED' || tok === 'FAIL') return 'block';
  if (tok === 'REQUESTCHANGES' || tok === 'REQUEST' || tok === 'CHANGES') return 'request-changes';
  return null;
}

// Parse a verdict from free text. The LAST occurrence wins (trailer-anchored):
// a validator quoting the protocol mid-transcript ("emit VERDICT: PASS when…")
// must not register as its actual verdict — the real verdict is the trailer,
// which is always last.
function parseVerdictText(text: any): 'pass' | 'request-changes' | 'block' | null {
  const body = String(text || '');
  let last: string | null = null;
  let match;
  VERDICT_TOKEN_RX.lastIndex = 0;
  while ((match = VERDICT_TOKEN_RX.exec(body)) !== null) {
    const normalized = normalizeVerdictToken(match[1]);
    if (normalized) last = normalized;
  }
  return last as any;
}

// Extract a single-line JSON object embedded in trailer detail text
// (the ValidationFailurePacket / scorecard carrier).
function parseJsonObject(text: any) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeScorecardEntry(entry: any) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || entry.criterion || '').trim().toUpperCase();
  if (!/^A\d+$/.test(id)) return null;
  let met: boolean | 'deferred';
  if (entry.met === true || /^met$/i.test(String(entry.met || entry.status || ''))) met = true;
  else if (/^deferred/i.test(String(entry.met || entry.status || ''))) met = 'deferred';
  else met = false;
  return {
    id,
    met,
    reason: String(entry.reason || entry.detail || '').trim() || null,
    evidence: entry.evidence != null ? String(entry.evidence).trim() || null : null,
  };
}

// Parse the per-criterion scorecard from validator output. Prefers the
// embedded JSON object's `scorecard` array; falls back to plain
// `A<i>: MET|UNMET|DEFERRED-TO-BEHAVIORAL — reason` lines. Returns [] when
// neither is present.
function parseCriterionScorecard(text: any) {
  const body = String(text || '');
  const object = parseJsonObject(body);
  if (object && Array.isArray(object.scorecard)) {
    const entries = object.scorecard.map(normalizeScorecardEntry).filter(Boolean);
    if (entries.length) return entries;
  }
  const byId = new Map();
  let match;
  SCORECARD_LINE_RX.lastIndex = 0;
  while ((match = SCORECARD_LINE_RX.exec(body)) !== null) {
    const id = `A${match[1]}`;
    const tok = String(match[2] || '').toUpperCase();
    const met = tok === 'MET' ? true : tok === 'UNMET' ? false : 'deferred';
    // last occurrence per id wins (re-grades supersede)
    byId.set(id, { id, met, reason: String(match[3] || '').trim() || null, evidence: null });
  }
  return Array.from(byId.values());
}

// Auto-rally-shaped record parser: takes a completion record, returns
// { verdict, packetInput, detail, scorecard } or null when the record does
// not carry a verdict. packetInput is the embedded JSON object (the
// ValidationFailurePacket and/or scorecard carrier).
function parseValidatorRecordVerdict(record: any = {}) {
  const detail = String(record.detail || record.trailer?.detail || '').trim();
  if (!detail) return null;
  const object = parseJsonObject(detail);
  const verdict = normalizeVerdictToken(object?.verdict) || parseVerdictText(detail);
  if (verdict !== 'pass' && verdict !== 'request-changes' && verdict !== 'block') return null;
  return { verdict, packetInput: object, detail, scorecard: parseCriterionScorecard(detail) };
}

// Cheap predicate used by the completion pipeline to keep validator verdicts
// out of the implementer mission-sync path.
function isValidatorVerdictText(text: any) {
  return parseVerdictText(text) !== null;
}

module.exports = {
  parseVerdictText,
  parseCriterionScorecard,
  parseValidatorRecordVerdict,
  isValidatorVerdictText,
  parseJsonObject,
};
