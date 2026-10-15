const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveNextStep } = require('../next-step.cjs');

test('deriveNextStep: completed with PR url suggests verify/merge flow', () => {
  const r = deriveNextStep({
    outcome: 'completed',
    pr: 'https://github.com/org/repo/pull/42',
  });
  assert.equal(r.category, 'verify');
  assert.match(r.next, /^verify PR/);
  assert.match(r.next, /ace integrate pr-merge/);
  assert.doesNotMatch(r.next, /--admin|gh pr merge/);
});

test('deriveNextStep: completed with PR trailer text suggests gh pr view by number', () => {
  const r = deriveNextStep({
    outcome: 'completed',
    doneText: 'Shipped the change. PR #42',
  });
  assert.equal(r.category, 'verify');
  assert.equal(r.next, 'verify PR — gh pr view 42');
});

test('deriveNextStep: completed without PR falls back to diff review guidance', () => {
  const r = deriveNextStep({
    outcome: 'completed',
    doneText: 'Shipped locally.',
  });
  assert.equal(r.category, 'done');
  assert.match(r.next, /review the worker's diff/);
});

test('deriveNextStep: blocked text is trimmed and surfaced as unblock guidance', () => {
  const r = deriveNextStep({
    outcome: 'blocked',
    blockedText: 'npm run build fails with TS7006',
  });
  assert.equal(r.category, 'unblock');
  assert.equal(r.next, 'unblock: npm run build fails with TS7006');
});

test('deriveNextStep: dispatched result points operator at state lookup', () => {
  const r = deriveNextStep({
    outcome: 'dispatched',
    streamId: 'conversation:abc',
  });
  assert.equal(r.category, 'dispatch');
  assert.match(r.next, /ace state conversation:abc/);
});

test('deriveNextStep: error result has no next step', () => {
  const r = deriveNextStep({ outcome: 'error' });
  assert.equal(r.category, null);
  assert.equal(r.next, null);
});

test('deriveNextStep: PR number regex tolerates PR# and pull url variants', () => {
  const direct = deriveNextStep({
    outcome: 'completed',
    doneText: 'All set in PR#7',
  });
  const url = deriveNextStep({
    outcome: 'completed',
    doneText: 'See https://github.com/org/repo/pull/19 for review',
  });
  assert.equal(direct.next, 'verify PR — gh pr view 7');
  assert.equal(url.next, 'verify PR — gh pr view 19');
});
