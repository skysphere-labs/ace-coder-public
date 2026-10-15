// Change risk policy — one pure place to decide validation weight.
//
// This intentionally stays conservative: unknown runtime control-plane work is
// medium and explicit safety/release/admin/browser signals are high. Risk still
// controls Clawpatch and computer-use requirements, but never auto-selects an
// independent validator; that remains an explicit owner request.

let goalValidationPolicy: any;
try {
  goalValidationPolicy = require('./goal-validation-policy.cjs');
} catch {
  goalValidationPolicy = require('./goal-validation-policy.cts');
}

const RISK_CLASSES = Object.freeze({
  TRIVIAL: 'trivial',
  SMALL: 'small',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const HIGH_RISK_PATH_RX =
  /(^|\/)(auth|security|permissions|payment|payments|billing|secrets?|migrations?|schema|database|db)(\/|$)|(^|\/)electron\/integration-gateway\.cts$|(^|\/)electron\/missions\.cts$|(^|\/)tools\/ace\/src\/(orchestration-policy|auto-validator|change-risk-policy|goal-validation-policy|pr-gate)\.cts$|(^|\/)(release|deploy|package|rebuild)(\/|$)/i;
const DOC_PATH_RX = /(^|\/)(docs?|\.ace|electron\/assets\/skills)\/|\.md$/i;
const TEST_PATH_RX = /(^|\/)(__tests__|tests?|test|spec)(\/|$)|\.(test|spec)\.(cts|ts|tsx|js|jsx|cjs|mjs)$/i;
const HELP_ONLY_RX = /\b(help text|cli help|describe output|command manifest|docs-only|documentation|no-code|smoke fixture|diagnostic only)\b/i;
const SMALL_HINT_RX = /\b(small|trivial|deterministic|targeted|parser bugfix|smoke|no-code|docs-only|help text)\b/i;
const HIGH_TEXT_RX = /\b(auth|security|secret|permission|payment|billing|database|schema|migration|release|deploy|package|rebuild|admin merge|branch policy|cross[- ]cutting|mission board|integration gateway|validator policy|cleanup|state reconciliation)\b/i;

function asArray(value: any) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: any) {
  return String(value || '').trim();
}

function compactTextParts(input: any) {
  return [
    input.taskType,
    input.taskClass,
    input.roleMode,
    input.goal,
    input.context,
    ...asArray(input.acceptance),
    ...asArray(input.deliverables),
    ...asArray(input.constraints),
  ].map((part) => String(part || '')).join('\n');
}

function countChangedFiles(input: any, changedFiles: string[]) {
  const filesChanged = Number(input.filesChanged);
  if (Number.isFinite(filesChanged) && filesChanged >= 0) return Math.floor(filesChanged);
  return changedFiles.length;
}

function countChangedLines(input: any) {
  const changedLineCount = Number(input.changedLineCount);
  if (Number.isFinite(changedLineCount) && changedLineCount >= 0) {
    return Math.floor(changedLineCount);
  }
  return null;
}

function highRiskReasons({ changedFiles, body, computerUseDecision, explicitHighRisk }: any) {
  const reasons: string[] = [];
  if (explicitHighRisk === true) reasons.push('explicit-high-risk');
  for (const file of changedFiles) {
    if (HIGH_RISK_PATH_RX.test(file)) reasons.push(`high-risk-path:${file}`);
  }
  if (HIGH_TEXT_RX.test(body)) reasons.push('high-risk-text');
  if (computerUseDecision.required) reasons.push(`computer-use:${computerUseDecision.reason}`);
  return Array.from(new Set(reasons));
}

function trivialReasons({ changedFiles, changedLineCount, body, roleMode, taskType }: any) {
  if (changedLineCount != null && changedLineCount > 50) return [];
  const files = changedFiles.length ? changedFiles : [];
  const docsOnly = files.length > 0 && files.every((file: string) => DOC_PATH_RX.test(file));
  const testsOnly = files.length > 0 && files.every((file: string) => TEST_PATH_RX.test(file));
  const noCode =
    String(roleMode || '').toLowerCase() === 'no-code' ||
    String(taskType || '').toLowerCase() === 'no-code' ||
    HELP_ONLY_RX.test(body);
  if (docsOnly) return ['docs-only'];
  if (testsOnly) return ['test-only'];
  if (noCode) return ['no-code-or-help-only'];
  return [];
}

function classifyChangeRisk(input: any = {}) {
  const changedFiles = asArray(input.changedFiles || input.changed_files)
    .map((file) => text(file))
    .filter(Boolean);
  const changedLineCount = countChangedLines(input);
  const filesChanged = countChangedFiles(input, changedFiles);
  const body = compactTextParts(input);
  const computerUseDecision = goalValidationPolicy.requiresComputerUse({
    taskClass: input.taskClass || input.task_class,
    agentClass: input.agentClass || input.agent_class,
    browserMode: input.browserMode || input.browser_mode,
    changedFiles,
    acceptance: input.acceptance || [],
    computerUseRequired: input.computerUseRequired,
  });
  const reasons: string[] = [];
  let riskClass = RISK_CLASSES.MEDIUM;

  const highReasons = highRiskReasons({
    changedFiles,
    body,
    computerUseDecision,
    explicitHighRisk: input.highRisk === true || input.high_risk === true,
  });
  if (highReasons.length) {
    riskClass = RISK_CLASSES.HIGH;
    reasons.push(...highReasons);
  } else {
    const trivial = trivialReasons({
      changedFiles,
      changedLineCount,
      body,
      roleMode: input.roleMode || input.role_mode,
      taskType: input.taskType || input.task_type,
    });
    if (trivial.length) {
      riskClass = RISK_CLASSES.TRIVIAL;
      reasons.push(...trivial);
    } else if (
      filesChanged <= 5 &&
      (changedLineCount == null || changedLineCount <= 150) &&
      SMALL_HINT_RX.test(body)
    ) {
      riskClass = RISK_CLASSES.SMALL;
      reasons.push('small-deterministic-scope');
    } else {
      reasons.push('default-medium-runtime-risk');
    }
  }

  const validationRequired =
    input.explicitValidationRequired === true ||
    input.explicit_validation_required === true;
  const independentValidatorRequired = validationRequired;
  const explicitClawpatchRequired =
    input.explicitClawpatchRequired === true || input.explicit_clawpatch_required === true;
  const clawpatchRequired =
    explicitClawpatchRequired ||
    riskClass === RISK_CLASSES.MEDIUM ||
    riskClass === RISK_CLASSES.HIGH;
  const evidenceRequired =
    riskClass === RISK_CLASSES.SMALL
      ? ['headSha', 'changedFiles', 'testEvidence']
      : validationRequired
        ? ['exactHeadValidatorPass']
        : [];

  return {
    riskClass,
    validationRequired,
    independentValidatorRequired,
    clawpatchRequired,
    computerUseRequired: computerUseDecision.required === true,
    reasons,
    evidenceRequired,
  };
}

function validationBypassEvidenceComplete(policy: any, evidence: any = {}) {
  if (!policy || policy.validationRequired === true) return false;
  const required = Array.isArray(policy.evidenceRequired) ? policy.evidenceRequired : [];
  if (required.length === 0) return true;
  const hasHead = !!text(evidence.headSha || evidence.prHeadSha || evidence.currentHeadSha);
  const changedFiles = asArray(evidence.changedFiles || evidence.changed_files).filter(Boolean);
  const commands = asArray(evidence.commands || evidence.commandLog || evidence.testEvidence).filter(Boolean);
  const hasTestEvidence = commands.length > 0 || !!text(evidence.testEvidenceSummary || evidence.validationHandoff);
  for (const key of required) {
    if (key === 'headSha' && !hasHead) return false;
    if (key === 'changedFiles' && changedFiles.length === 0) return false;
    if (key === 'testEvidence' && !hasTestEvidence) return false;
  }
  return true;
}

function buildValidationBypassEvidence(input: any = {}, policy: any = classifyChangeRisk(input)) {
  const changedFiles = asArray(input.changedFiles || input.changed_files)
    .map((file) => text(file))
    .filter(Boolean);
  return {
    schema: 'AceValidationBypass/v1',
    allowed: policy.validationRequired === false,
    riskClass: policy.riskClass,
    reason: (policy.reasons || []).join('; ') || `${policy.riskClass} change`,
    headSha: text(input.headSha || input.prHeadSha || input.currentHeadSha) || null,
    baseSha: text(input.baseSha || input.prBaseSha) || null,
    changedFiles,
    changedLineCount: countChangedLines(input),
    commands: asArray(input.commands || input.testEvidence).filter(Boolean),
    recordedAt: input.recordedAt || new Date().toISOString(),
  };
}

module.exports = {
  RISK_CLASSES,
  classifyChangeRisk,
  validationBypassEvidenceComplete,
  buildValidationBypassEvidence,
};
