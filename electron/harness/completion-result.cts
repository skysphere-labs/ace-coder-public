const COMPLETION_SCHEMA = 'ace.completion_result.v1';

const VALID_OUTCOMES = new Set([
  'done',
  'blocked',
  'awaiting-approval',
  'max-rounds',
  'done-unverified',
  'error',
]);

const REQUIRED_ARRAY_FIELDS = ['filesChanged', 'commits', 'testsRun', 'acceptanceEvidence', 'risks', 'memoryCandidates'];
const ALLOWED_FIELDS = new Set([
  'schema', 'runId', 'taskId', 'handoffId', 'outcome', 'summary',
  ...REQUIRED_ARRAY_FIELDS, 'nextSuggestedTask',
]);

function nonEmptyString(value: any) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(result: any, field: any, errors: any, { nonEmpty = false }: any = {}) {
  if (!Array.isArray(result[field])) return;
  result[field].forEach((item: any, index: any) => {
    if (typeof item !== 'string') errors.push(`${field}[${index}] must be a string`);
    else if (nonEmpty && item.trim().length === 0) errors.push(`${field}[${index}] must be non-empty`);
  });
}

function validateTestsRun(result: any, errors: any) {
  if (!Array.isArray(result.testsRun)) return;
  result.testsRun.forEach((item: any, index: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`testsRun[${index}] must be an object`);
      return;
    }
    if (!nonEmptyString(item.command)) errors.push(`testsRun[${index}].command required`);
    if (!['pass', 'fail', 'not-run'].includes(item.status)) errors.push(`testsRun[${index}].status invalid`);
    if (item.outputDigest != null && typeof item.outputDigest !== 'string') {
      errors.push(`testsRun[${index}].outputDigest must be a string`);
    }
  });
}

function validateAcceptanceEvidence(result: any, errors: any) {
  if (!Array.isArray(result.acceptanceEvidence)) return;
  if (result.acceptanceEvidence.length === 0) {
    errors.push('acceptanceEvidence must contain at least one item');
  }
  result.acceptanceEvidence.forEach((item: any, index: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`acceptanceEvidence[${index}] must be an object`);
      return;
    }
    if (!nonEmptyString(item.criterion)) errors.push(`acceptanceEvidence[${index}].criterion required`);
    if (!['pass', 'fail', 'unknown'].includes(item.status)) errors.push(`acceptanceEvidence[${index}].status invalid`);
    if (!nonEmptyString(item.evidence)) errors.push(`acceptanceEvidence[${index}].evidence required`);
  });
}

function validateDoneResult(result: any, errors: any) {
  if (result.outcome !== 'done') return;
  if (Array.isArray(result.testsRun) && !result.testsRun.some((item: any) => item?.status === 'pass')) {
    errors.push('done outcome requires at least one passing test');
  }
  if (Array.isArray(result.acceptanceEvidence) && result.acceptanceEvidence.some((item: any) => item?.status !== 'pass')) {
    errors.push('done outcome requires all acceptanceEvidence statuses to be pass');
  }
}

function validateCompletionResult(result: any) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, errors: ['completion result object required'] };
  }
  if (result.schema !== COMPLETION_SCHEMA) errors.push(`schema must be ${COMPLETION_SCHEMA}`);
  for (const field of ['runId', 'taskId', 'handoffId', 'summary']) {
    if (!nonEmptyString(result[field])) errors.push(`${field} must be a non-empty string`);
  }
  for (const key of Object.keys(result)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push(`unknown field: ${key}`);
  }
  if (!VALID_OUTCOMES.has(result.outcome)) errors.push('outcome is invalid');
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(result[field])) errors.push(`${field} must be an array`);
  }
  validateStringArray(result, 'filesChanged', errors, { nonEmpty: true });
  validateStringArray(result, 'commits', errors, { nonEmpty: true });
  validateStringArray(result, 'risks', errors);
  validateTestsRun(result, errors);
  validateAcceptanceEvidence(result, errors);
  validateDoneResult(result, errors);
  return { ok: errors.length === 0, errors };
}

function markFeatureCheck(feature: any, { evaluatorRole, runId, evidence }: any) {
  if (evaluatorRole !== 'evaluator') {
    throw new Error('only evaluator role can mark a feature passing');
  }
  if (!nonEmptyString(runId)) throw new Error('runId required');
  if (!nonEmptyString(evidence)) throw new Error('evidence required');
  return {
    ...feature,
    passes: true,
    lastRunId: runId,
    evidence,
  };
}

module.exports = {
  COMPLETION_SCHEMA,
  validateCompletionResult,
  markFeatureCheck,
};
