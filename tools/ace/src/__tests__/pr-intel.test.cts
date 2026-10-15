const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeHighRisk,
  holdGateOnUnknownChanges,
  rollupPrCheckState,
} = require('../pr-intel.cjs');

test('computeHighRisk: high-risk paths classify HIGH, benign paths do not', () => {
  assert.equal(computeHighRisk(['electron/auth/login.ts']), true);
  assert.equal(computeHighRisk(['db/migrations/0001_init.sql']), true);
  assert.equal(computeHighRisk(['docs/readme.md', 'src/util/format.ts']), false);
  // Degrades safely on empty/unknown input.
  assert.equal(computeHighRisk([]), false);
  assert.equal(computeHighRisk(null), false);
});

test('rollupPrCheckState: success only when all checks conclude OK; failure/pending otherwise', () => {
  assert.equal(rollupPrCheckState(null), null);
  assert.equal(rollupPrCheckState([]), null);
  assert.equal(rollupPrCheckState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'success');
  assert.equal(rollupPrCheckState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'success');
  assert.equal(rollupPrCheckState([{ status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failure');
  assert.equal(rollupPrCheckState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(rollupPrCheckState([{ status: 'QUEUED' }]), 'pending');
});

test('holdGateOnUnknownChanges: fail-closed when auto-merge on + changed files unknown', () => {
  const okGate = { ok: true, failures: [] };
  const held = holdGateOnUnknownChanges(okGate, { autoMerge: true, changedFiles: null });
  assert.equal(held.ok, false);
  assert.equal(held.failures[0].code, 'automerge_changed_files_unknown');
  // Known lists (empty or populated) pass through untouched.
  assert.deepEqual(holdGateOnUnknownChanges(okGate, { autoMerge: true, changedFiles: [] }), okGate);
  assert.deepEqual(holdGateOnUnknownChanges(okGate, { autoMerge: true, changedFiles: ['a.ts'] }), okGate);
  // Auto-merge off: never held.
  assert.deepEqual(holdGateOnUnknownChanges(okGate, { autoMerge: false, changedFiles: null }), okGate);
  // Appends to existing failures rather than replacing them.
  const failing = { ok: false, failures: [{ code: 'checks_not_green' }] };
  const both = holdGateOnUnknownChanges(failing, { autoMerge: true, changedFiles: null });
  assert.equal(both.failures.length, 2);
});
