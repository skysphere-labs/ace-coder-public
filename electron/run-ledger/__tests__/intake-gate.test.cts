// intake-gate — pins the runSubmit fail-fast contract: a rejected intake
// throws BEFORE any run is minted (the controller calls validateRunIntake
// ahead of h.submit — ordering pinned by the source guard in
// src/lib/cli-attachments.node-test.ts), and every check here mirrors a
// condition that would otherwise fail at dispatch one tick later.

const test = require('node:test');
const assert = require('node:assert/strict');

let intakeGateModule: any;
try { intakeGateModule = require('../intake-gate.cts'); }
catch { intakeGateModule = require('../intake-gate.cjs'); }
const { validateRunIntake } = intakeGateModule;

const WS = { id: 'prj-1', name: 'sandbox', path: '/repo/sandbox' };

test('intake: missing workspaceId rejects with the flag to fix', () => {
  assert.throws(
    () => validateRunIntake({ intent: { goal: 'g', acceptance: ['ok'] }, workspaceId: null, workspace: null }),
    /scope\.workspaceId required.*--workspace/,
  );
});

test('intake: unknown workspace rejects and names the doctor command', () => {
  assert.throws(
    () => validateRunIntake({ intent: { goal: 'g', acceptance: ['ok'] }, workspaceId: 'prj-nope', workspace: null }),
    /workspace prj-nope not found.*doctor workspace/,
  );
});

test('intake: empty acceptance rejects with the flag to fix', () => {
  assert.throws(
    () => validateRunIntake({ intent: { goal: 'g' }, workspaceId: 'prj-1', workspace: WS }),
    /acceptance criterion required.*--acceptance/,
  );
});

test('intake: whitespace-only and non-string acceptance entries are filtered before the check', () => {
  assert.throws(
    () => validateRunIntake({ intent: { goal: 'g', acceptance: ['   ', 42, null] }, workspaceId: 'prj-1', workspace: WS }),
    /acceptance criterion required/,
  );
});

test('intake: a dispatchable intent passes and returns the trimmed criteria', () => {
  const r = validateRunIntake({
    intent: { goal: 'g', acceptance: ['  test passes  ', 'build is green'] },
    workspaceId: 'prj-1',
    workspace: WS,
  });
  assert.deepEqual(r.acceptance, ['test passes', 'build is green']);
});

test('intake: rejection happens by throw — no side effects, nothing minted', () => {
  // Pure-function contract: the gate has no ledger/store access at all, so a
  // throw here structurally cannot have minted a run. Assert purity by shape.
  const src = require('node:fs').readFileSync(require.resolve('../intake-gate.cts'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]node:fs['"]\)|require\(['"]fs['"]\)|ledger|aceStore/);
});
