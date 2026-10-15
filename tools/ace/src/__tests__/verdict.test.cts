const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVerdictText,
  parseCriterionScorecard,
  parseValidatorRecordVerdict,
  isValidatorVerdictText,
} = require('../verdict.cjs');

test('verdict: tolerant of colon/equals/bare forms', () => {
  assert.equal(parseVerdictText('VERDICT: PASS'), 'pass');
  assert.equal(parseVerdictText('VERDICT=request-changes'), 'request-changes');
  assert.equal(parseVerdictText('VERDICT PASS'), 'pass');
  assert.equal(parseVerdictText('DONE: VERDICT=BLOCK — cannot validate'), 'block');
  assert.equal(parseVerdictText('no verdict here'), null);
});

test('verdict: LAST occurrence wins — quoted protocol does not parse as the verdict', () => {
  const transcript = [
    'Per the skill, I must end with VERDICT: PASS or VERDICT: REQUEST-CHANGES.',
    'A1 failed: the button does not render.',
    'DONE: VERDICT=REQUEST-CHANGES on https://github.com/x/y/pull/1',
  ].join('\n');
  assert.equal(parseVerdictText(transcript), 'request-changes');
});

test('verdict: quoted-protocol-only text still parses (tolerant), last token rules', () => {
  const text = 'emit VERDICT: PASS when done... actual outcome: VERDICT=BLOCK';
  assert.equal(parseVerdictText(text), 'block');
});

test('scorecard: plain A-lines with MET/UNMET/DEFERRED', () => {
  const text = [
    'A1: MET — command exits 0, output matches (tools/ace/src/index.cts:12)',
    'A2: UNMET — flag missing from help output',
    'A3: DEFERRED-TO-BEHAVIORAL — UI criterion, computer-use tier owns it',
  ].join('\n');
  const entries = parseCriterionScorecard(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e: any) => [e.id, e.met]), [
    ['A1', true],
    ['A2', false],
    ['A3', 'deferred'],
  ]);
  assert.match(entries[0].reason, /exits 0/);
});

test('scorecard: embedded single-line JSON wins over A-lines', () => {
  const detail =
    'VERDICT=pass on https://github.com/x/y/pull/2 ' +
    '{"verdict":"pass","scorecard":[{"id":"A1","met":true,"evidence":"out.log"},{"id":"A2","met":"deferred"}]}';
  const entries = parseCriterionScorecard(detail);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'A1');
  assert.equal(entries[0].met, true);
  assert.equal(entries[0].evidence, 'out.log');
  assert.equal(entries[1].met, 'deferred');
});

test('scorecard: re-graded A-line — last occurrence per id wins', () => {
  const text = 'A1: UNMET — first try\nA1: MET — fixed and re-checked';
  const entries = parseCriterionScorecard(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].met, true);
});

test('record verdict: auto-rally shape with packetInput and scorecard', () => {
  const record = {
    detail:
      'VERDICT=request-changes {"verdict":"request-changes","taskId":"t1","scorecard":[{"id":"A1","met":false,"reason":"broken"}]}',
  };
  const parsed = parseValidatorRecordVerdict(record);
  assert.equal(parsed.verdict, 'request-changes');
  assert.equal(parsed.packetInput.taskId, 't1');
  assert.equal(parsed.scorecard.length, 1);
  assert.equal(parsed.scorecard[0].met, false);
});

test('record verdict: null when no verdict present', () => {
  assert.equal(parseValidatorRecordVerdict({ detail: 'DONE: shipped the feature' }), null);
  assert.equal(parseValidatorRecordVerdict({}), null);
});

test('record verdict: JSON object verdict beats text token', () => {
  const record = { detail: 'VERDICT mentioned in prose: PASS {"verdict":"block"}' };
  const parsed = parseValidatorRecordVerdict(record);
  assert.equal(parsed.verdict, 'block');
});

test('isValidatorVerdictText: predicate', () => {
  assert.equal(isValidatorVerdictText('DONE: VERDICT=pass on pr'), true);
  assert.equal(isValidatorVerdictText('DONE: implemented the thing'), false);
});
