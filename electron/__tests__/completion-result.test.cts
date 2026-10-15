import { expect, test } from 'vitest';

const { markFeatureCheck, validateCompletionResult } = require('../harness/completion-result.cts');

const validResult = {
  schema: 'ace.completion_result.v1',
  runId: 'run_1',
  taskId: 'tsk_1',
  handoffId: 'hof_1',
  outcome: 'done',
  summary: 'Created scaffold.',
  filesChanged: ['.ace-template/FEATURES.json'],
  commits: [],
  testsRun: [{ command: 'npm run lint', status: 'pass' }],
  acceptanceEvidence: [{ criterion: 'FEATURES.json parses', status: 'pass', evidence: 'project-scaffold test' }],
  risks: [],
  memoryCandidates: [],
};

test('validateCompletionResult accepts a complete result', () => {
  expect(validateCompletionResult(validResult)).toEqual({ ok: true, errors: [] });
});

test('validateCompletionResult rejects invalid and evidence-free results', () => {
  expect(validateCompletionResult(null).ok).toBe(false);
  const missingEvidence = { ...validResult, acceptanceEvidence: [] };
  const outcome = validateCompletionResult(missingEvidence);
  expect(outcome.ok).toBe(false);
  expect(outcome.errors).toContain('acceptanceEvidence must contain at least one item');
});

test('validateCompletionResult enforces passing tests and evidence for done results', () => {
  const noPassingTest = { ...validResult, testsRun: [{ command: 'npm test', status: 'not-run' }] };
  expect(validateCompletionResult(noPassingTest).errors).toContain('done outcome requires at least one passing test');

  const unknownEvidence = {
    ...validResult,
    acceptanceEvidence: [{ criterion: 'accepted by evaluator', status: 'unknown', evidence: 'pending' }],
  };
  expect(validateCompletionResult(unknownEvidence).errors).toContain('done outcome requires all acceptanceEvidence statuses to be pass');
});

test('markFeatureCheck allows evaluator role and blocks non-evaluator pass marks', () => {
  const feature = {
    id: 'project.harness.initialized',
    wave: 0,
    category: 'harness',
    priority: 1,
    description: 'Harness files exist.',
    steps: ['Run init.sh'],
    passes: false,
  };
  const marked = markFeatureCheck(feature, {
    evaluatorRole: 'evaluator',
    runId: 'run_1',
    evidence: 'completion-result test',
  });
  expect(marked.passes).toBe(true);
  expect(marked.lastRunId).toBe('run_1');
  expect(() =>
    markFeatureCheck(feature, {
      evaluatorRole: 'builder',
      runId: 'run_1',
      evidence: 'builder claim',
    })
  ).toThrow(/only evaluator role/);
});
