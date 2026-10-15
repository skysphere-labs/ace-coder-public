// review-bot.test — pins the pure review-bot check extraction + findings
// parsing. The comment format is org-owned and can drift, so the contract is
// TOLERANT: findings are optional; a failing check with an unparseable comment
// still returns { score: null, mustFix: [] } (never throws).

const test = require('node:test');
const assert = require('node:assert/strict');

let reviewBotModule: any;
try { reviewBotModule = require('../review-bot.cjs'); } catch { reviewBotModule = require('../review-bot.cts'); }
const {
  extractReviewBotCheck,
  parseReviewBotFindings,
  isFailingCheckState,
} = reviewBotModule;

test('extractReviewBotCheck finds the org check by name in a statusCheckRollup', () => {
  const rollup = [
    { __typename: 'CheckRun', name: 'fast', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'heavy', status: 'IN_PROGRESS', conclusion: '' },
  ];
  const check = extractReviewBotCheck(rollup);
  assert.equal(check.name, 'validate');
  assert.equal(check.state, 'failure');
});

test('extractReviewBotCheck matches "PR Validator" naming and StatusContext entries; last run wins', () => {
  const rollup = [
    { __typename: 'StatusContext', context: 'PR Validator', state: 'FAILURE' },
    { __typename: 'StatusContext', context: 'PR Validator', state: 'SUCCESS' },
  ];
  const check = extractReviewBotCheck(rollup);
  assert.equal(check.name, 'PR Validator');
  assert.equal(check.state, 'success', 'a re-run supersedes the earlier attempt');
});

test('extractReviewBotCheck matches the live Reviewbot check name', () => {
  const check = extractReviewBotCheck([
    { __typename: 'CheckRun', name: 'AI review gate', status: 'COMPLETED', conclusion: 'FAILURE' },
  ]);
  assert.equal(check.name, 'AI review gate');
  assert.equal(check.state, 'failure');
});

test('extractReviewBotCheck returns null when no review-bot check is present (or rollup missing)', () => {
  assert.equal(extractReviewBotCheck([{ name: 'fast', conclusion: 'SUCCESS' }]), null);
  assert.equal(extractReviewBotCheck(null), null);
  assert.equal(extractReviewBotCheck(undefined), null);
});

test('extractReviewBotCheck normalizes pending states', () => {
  const check = extractReviewBotCheck([{ name: 'validate', status: 'IN_PROGRESS' }]);
  assert.equal(check.state, 'pending');
});

test('a COMPLETED review-bot check with no conclusion is pending, not success', () => {
  // COMPLETED is a lifecycle status, not a pass conclusion; a missing/empty
  // conclusion must not satisfy review evidence.
  assert.equal(extractReviewBotCheck([{ name: 'validate', status: 'COMPLETED', conclusion: null }]).state, 'pending');
  assert.equal(extractReviewBotCheck([{ name: 'validate', status: 'COMPLETED', conclusion: '' }]).state, 'pending');
  assert.equal(extractReviewBotCheck([{ name: 'validate', status: 'COMPLETED', conclusion: 'SUCCESS' }]).state, 'success');
});

test('parseReviewBotFindings extracts the /5 score and the Must-fix bullets', () => {
  const body = [
    '## PR Validator',
    '',
    'Score: **2/5**',
    '',
    '### Must-fix',
    '- Handle the empty changed-files list in the gate',
    '- The new flag is dropped by parseSpec',
    '',
    '### Nice-to-have',
    '- Rename the helper',
  ].join('\n');
  const findings = parseReviewBotFindings([body]);
  assert.equal(findings.score, 2);
  assert.deepEqual(findings.mustFix, [
    'Handle the empty changed-files list in the gate',
    'The new flag is dropped by parseSpec',
  ]);
});

test('parseReviewBotFindings: the LAST verdict-looking comment wins and object bodies are accepted', () => {
  const findings = parseReviewBotFindings([
    { body: 'Score: 1/5\n\nMust-fix:\n- old finding' },
    { body: 'just a human comment' },
    { body: 'Score: 4.5/5\n\nMust-fix:\n* only this one' },
  ]);
  assert.equal(findings.score, 4.5);
  assert.deepEqual(findings.mustFix, ['only this one']);
});

test('parseReviewBotFindings is tolerant: unrecognized/missing comments yield empty findings, never a throw', () => {
  assert.deepEqual(parseReviewBotFindings([]), { score: null, mustFix: [] });
  assert.deepEqual(parseReviewBotFindings(null), { score: null, mustFix: [] });
  assert.deepEqual(parseReviewBotFindings(['LGTM!']), { score: null, mustFix: [] });
});

test('isFailingCheckState: failure-family states only (pending/success are not failures)', () => {
  for (const s of ['failure', 'FAILURE', 'error', 'timed_out', 'cancelled', 'action_required']) {
    assert.equal(isFailingCheckState(s), true, `${s} is failing`);
  }
  for (const s of ['success', 'pending', '', null, undefined]) {
    assert.equal(isFailingCheckState(s), false, `${String(s)} is not failing`);
  }
});

test('extractReviewBotCheck: SKIPPED/NEUTRAL/STALE conclusions are pending — a review that did not run is never success evidence', () => {
  for (const conclusion of ['SKIPPED', 'NEUTRAL', 'STALE', 'skipped']) {
    const check = extractReviewBotCheck([{ name: 'validate', conclusion }]);
    assert.ok(check, `${conclusion} check is still surfaced`);
    assert.equal(check.state, 'pending', `${conclusion} normalizes to pending (non-terminal)`);
    assert.equal(isFailingCheckState(check.state), false, `${conclusion} is not a failure either`);
  }
});

test('extractReviewBotCheck: STARTUP_FAILURE is a failure, and UNKNOWN conclusions are pending — never default-success', () => {
  assert.equal(extractReviewBotCheck([{ name: 'validate', conclusion: 'STARTUP_FAILURE' }]).state, 'failure');
  assert.equal(extractReviewBotCheck([{ name: 'validate', conclusion: 'SOME_FUTURE_TOKEN' }]).state, 'pending');
  assert.equal(extractReviewBotCheck([{ name: 'validate', conclusion: 'SUCCESS' }]).state, 'success');
});
