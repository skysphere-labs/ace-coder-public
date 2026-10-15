const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ACCEPTANCE_LEDGER_SCHEMA,
  ensureAcceptanceLedger,
  readAcceptanceLedger,
  flipEntry,
  countFailingInScope,
  behavioralIds,
  ledgerPathFor,
} = require('../acceptance-ledger.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ledger-'));
}

const INPUT = {
  missionId: 'msn_1',
  featureId: 'ft_1',
  acceptance: [
    'CLI command exits 0 and prints the new field',
    'A2: Board card shows the awaiting_owner_ship state',
    'Unit tests pass',
  ],
  behavioral: [
    { id: 'A1', artifactType: 'CLI', steps: ['run ace mission board'], expected: 'exit 0, field present', evidence: 'stdout' },
    { id: 'A2', artifactType: 'UI', steps: ['open board', 'locate card'], expected: 'state chip visible', evidence: 'screenshot' },
  ],
};

test('ensureAcceptanceLedger: all entries start failing; behavioral plans matched by A-ID', () => {
  const rootDir = tempRoot();
  const { ledgerPath, ledger, created } = ensureAcceptanceLedger({ rootDir, ...INPUT });
  assert.equal(created, true);
  assert.equal(ledgerPath, ledgerPathFor({ rootDir, missionId: 'msn_1', featureId: 'ft_1' }));
  assert.equal(ledger.schema, ACCEPTANCE_LEDGER_SCHEMA);
  assert.equal(ledger.entries.length, 3);
  assert.ok(ledger.entries.every((e: any) => e.status === 'failing'));
  assert.deepEqual(ledger.entries.map((e: any) => [e.id, e.artifactType]), [
    ['A1', 'CLI'],
    ['A2', 'UI'],
    ['A3', 'code'],
  ]);
  assert.deepEqual(ledger.entries[1].steps, ['open board', 'locate card']);
  // Explicit A-ID prefix in the criterion text is stripped into the id.
  assert.equal(ledger.entries[1].text, 'Board card shows the awaiting_owner_ship state');
});

test('ensureAcceptanceLedger: idempotent — re-ensure never resets flipped entries', () => {
  const rootDir = tempRoot();
  const { ledgerPath } = ensureAcceptanceLedger({ rootDir, ...INPUT });
  flipEntry(ledgerPath, 'A1', { evidence: 'stdout capture at run/1.log', flippedBy: 'tsk_validator' });
  const again = ensureAcceptanceLedger({ rootDir, ...INPUT });
  assert.equal(again.created, false);
  assert.equal(again.ledger.entries[0].status, 'passing');
});

test('flipEntry: refuses without evidence (no unsupported PASS)', () => {
  const rootDir = tempRoot();
  const { ledgerPath } = ensureAcceptanceLedger({ rootDir, ...INPUT });
  assert.throws(() => flipEntry(ledgerPath, 'A1', {}), /evidence required/);
  assert.throws(() => flipEntry(ledgerPath, 'A9', { evidence: 'x' }), /no entry A9/);
});

test('countFailingInScope: gate input — zero only when everything in scope passed', () => {
  const rootDir = tempRoot();
  const { ledgerPath } = ensureAcceptanceLedger({ rootDir, ...INPUT });
  let ledger = readAcceptanceLedger(ledgerPath);
  assert.equal(countFailingInScope(ledger), 3);
  flipEntry(ledgerPath, 'A1', { evidence: 'stdout', flippedBy: 'v' });
  flipEntry(ledgerPath, 'A3', { evidence: 'test output', flippedBy: 'v' });
  ledger = readAcceptanceLedger(ledgerPath);
  assert.equal(countFailingInScope(ledger), 1);
  assert.equal(countFailingInScope(ledger, ['A1', 'A3']), 0);
  // Unreadable/absent ledger fails CLOSED (Infinity failing).
  assert.equal(countFailingInScope(null), Number.POSITIVE_INFINITY);
});

test('behavioralIds: UI/CLI/API entries only', () => {
  const rootDir = tempRoot();
  const { ledger } = ensureAcceptanceLedger({ rootDir, ...INPUT });
  assert.deepEqual(behavioralIds(ledger), ['A1', 'A2']);
});
