// acceptance-ledger — the machine-readable per-feature acceptance ledger
// (Anthropic initializer pattern: every entry starts "failing"; only a
// validator flips an entry, WITH evidence; the merge gate requires zero
// failing entries in scope). Lives beside the GoalAgentSpec:
//   .ace/goals/<missionId>/<featureId>/acceptance.json
// One canonical schema id; doctrine quotes it from here.

const fs = require('node:fs');
const path = require('node:path');

const ACCEPTANCE_LEDGER_SCHEMA = 'ace.acceptance-ledger/v1';
const VALID_ARTIFACT_TYPES = new Set(['UI', 'CLI', 'API', 'code']);

function ledgerDir(input: any = {}) {
  const rootDir = String(input.rootDir || '').trim();
  const missionId = String(input.missionId || '').trim();
  const featureId = String(input.featureId || '').trim();
  if (!rootDir || !missionId || !featureId) {
    throw new Error('acceptance-ledger: rootDir, missionId, featureId required');
  }
  return path.join(rootDir, '.ace', 'goals', missionId, featureId);
}

function ledgerPathFor(input: any = {}) {
  return path.join(ledgerDir(input), 'acceptance.json');
}

function normalizeArtifactType(value: any) {
  const t = String(value || '').trim();
  if (VALID_ARTIFACT_TYPES.has(t)) return t;
  const upper = t.toUpperCase();
  if (VALID_ARTIFACT_TYPES.has(upper)) return upper;
  return 'code';
}

// Build ledger entries from the spec's acceptance list + the (optional)
// Behavioral Test Plan authored at PRD time. behavioral entries are matched
// to acceptance criteria by A-ID (`{ id: 'A2', artifactType, steps, expected,
// evidence }`); criteria without a behavioral block default to artifactType
// 'code' (graded from the diff by the validator).
function buildLedgerEntries({ acceptance, behavioral }: any = {}) {
  const list = Array.isArray(acceptance) ? acceptance : [];
  const plans = new Map();
  for (const plan of Array.isArray(behavioral) ? behavioral : []) {
    const id = String(plan?.id || plan?.criterion || '').trim().toUpperCase();
    if (/^A\d+$/.test(id)) plans.set(id, plan);
  }
  return list.map((text: any, index: number) => {
    // Stable A-IDs: A1..An in list order; an explicit `A<i>:` prefix in the
    // criterion text wins so PRD-authored IDs survive reordering.
    const raw = String(text || '').trim();
    const prefixed = raw.match(/^(A\d+)\s*[:.\-—]\s*(.*)$/i);
    const id = prefixed ? prefixed[1].toUpperCase() : `A${index + 1}`;
    const criterion = prefixed ? prefixed[2].trim() : raw;
    const plan = plans.get(id) || null;
    return {
      id,
      text: criterion,
      artifactType: normalizeArtifactType(plan?.artifactType),
      steps: Array.isArray(plan?.steps) ? plan.steps.map((s: any) => String(s)) : [],
      expected: plan?.expected != null ? String(plan.expected) : null,
      evidenceType: plan?.evidence != null ? String(plan.evidence) : null,
      status: 'failing',
      evidence: null,
      flippedBy: null,
      flippedAt: null,
    };
  });
}

// Idempotent: writes the ledger only when absent (a re-dispatch must not reset
// flipped entries). Returns { ledgerPath, ledger, created }.
function ensureAcceptanceLedger(input: any = {}) {
  const file = ledgerPathFor(input);
  const existing = readAcceptanceLedger(file);
  if (existing) return { ledgerPath: file, ledger: existing, created: false };
  const ledger = {
    schema: ACCEPTANCE_LEDGER_SCHEMA,
    missionId: String(input.missionId),
    featureId: String(input.featureId),
    createdAt: new Date().toISOString(),
    entries: buildLedgerEntries(input),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return { ledgerPath: file, ledger, created: true };
}

function readAcceptanceLedger(file: any) {
  try {
    const parsed = JSON.parse(fs.readFileSync(String(file || ''), 'utf8'));
    if (parsed?.schema !== ACCEPTANCE_LEDGER_SCHEMA || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Flip one entry to passing. EVIDENCE IS REQUIRED — a flip without an evidence
// pointer is exactly the unsupported-PASS this ledger exists to prevent.
function flipEntry(file: any, id: any, { evidence, flippedBy }: any = {}) {
  const cleanId = String(id || '').trim().toUpperCase();
  const cleanEvidence = evidence == null ? '' : String(typeof evidence === 'object' ? JSON.stringify(evidence) : evidence).trim();
  if (!cleanEvidence) throw new Error(`acceptance-ledger.flipEntry(${cleanId}): evidence required`);
  const ledger = readAcceptanceLedger(file);
  if (!ledger) throw new Error(`acceptance-ledger.flipEntry: no ledger at ${file}`);
  const entry = ledger.entries.find((e: any) => e.id === cleanId);
  if (!entry) throw new Error(`acceptance-ledger.flipEntry: no entry ${cleanId}`);
  entry.status = 'passing';
  entry.evidence = cleanEvidence;
  entry.flippedBy = flippedBy != null ? String(flippedBy) : null;
  entry.flippedAt = new Date().toISOString();
  fs.writeFileSync(String(file), `${JSON.stringify(ledger, null, 2)}\n`);
  return entry;
}

// Zero-failing gate input. `ids` narrows scope (e.g. one lane of a wave);
// omitted = every entry.
function countFailingInScope(ledger: any, ids: any = null) {
  if (!ledger || !Array.isArray(ledger.entries)) return Number.POSITIVE_INFINITY;
  const scope = ids ? new Set(ids.map((x: any) => String(x).toUpperCase())) : null;
  return ledger.entries.filter((e: any) =>
    e.status !== 'passing' && (!scope || scope.has(String(e.id).toUpperCase()))
  ).length;
}

// Behavioral A-IDs in the ledger (UI/CLI/API artifact types) — the set the
// computer-use tier must cover in its completion.json checkedAcceptance.
function behavioralIds(ledger: any) {
  if (!ledger || !Array.isArray(ledger.entries)) return [];
  return ledger.entries
    .filter((e: any) => e.artifactType === 'UI' || e.artifactType === 'CLI' || e.artifactType === 'API')
    .map((e: any) => e.id);
}

module.exports = {
  ACCEPTANCE_LEDGER_SCHEMA,
  ledgerPathFor,
  buildLedgerEntries,
  ensureAcceptanceLedger,
  readAcceptanceLedger,
  flipEntry,
  countFailingInScope,
  behavioralIds,
};
