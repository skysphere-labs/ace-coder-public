// Goal-agent validator policy — final enforcement layer between a worker's
// DONE output and the PR/merge gate. Two responsibilities:
//
//   1. Decide whether a feature requires computer-use evidence (real
//      browser/desktop screenshots, console diagnostics, checked acceptance
//      list) before a validator can mark it PASS.
//
//   2. Parse the validator's trailer into one of the discrete outcomes
//      defined by the goal protocol and gate the next mission action on
//      that outcome.
//
// Pure, sync, no I/O — safe to call from the orchestrator, electron
// mission flow, and CLI dry-runs alike.

// Files whose modification implies user-visible UI/browser/Electron behavior
// and therefore demands computer-use validation. Ordering matters: the
// longest concrete prefixes come first so a partial match wins fast.
const UI_PATH_RX = /(^|\/)src\/components\/|(^|\/)src\/.*\.(tsx|css|scss)$|(^|\/)electron\/browser|(^|\/)electron\/.*browser|(^|\/)tools\/.*browser/i;

// Acceptance/goal text that hints at user-visible behavior. Keeping this
// list narrow on purpose — we only want signal, not every mention of
// "click" inside a CLI flag description.
const UI_KEYWORD_RX = /\b(ui|ux|browser|electron|user[- ]flow|visual|screenshot|click[- ]through|form submission|menu navigation|clipboard write)\b/i;

const KNOWN_OUTCOMES = new Set([
  'PASS',
  'FIXBACK_REQUIRED',
  'BLOCKED_SCOPE',
  'COMPUTER_USE_REQUIRED',
  'MANUAL_REQUIRED',
  'NONE',
]);

function asArray(value: any) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeKey(value: any) {
  return String(value || '').trim().toLowerCase();
}

// Returns { required, reason } so callers can both gate and explain.
// `required:true` means the validator MUST produce computer-use evidence
// before any PASS verdict is allowed to graduate to release.
const fs = require('node:fs');

function requiresComputerUse(spec: any) {
  const input = spec && typeof spec === 'object' ? spec : {};
  if (input.computerUseRequired === true) {
    return { required: true, reason: 'explicit-spec-flag' };
  }
  if (input.computerUseRequired === false) {
    return { required: false, reason: 'explicit-spec-flag-off' };
  }
  const taskClass = normalizeKey(input.taskClass || input.task_class);
  if (taskClass === 'ui_product_design') {
    return { required: true, reason: 'task-class-ui-product-design' };
  }
  const agentClass = normalizeKey(input.agentClass || input.agent_class);
  if (agentClass === 'browser-ui') {
    return { required: true, reason: 'agent-class-browser-ui' };
  }
  const browserMode = normalizeKey(input.browserMode || input.browser_mode);
  if (browserMode === 'on') {
    return { required: true, reason: 'browser-mode-on' };
  }
  const changedFiles = asArray(input.changedFiles || input.changed_files);
  for (const file of changedFiles) {
    if (UI_PATH_RX.test(String(file || ''))) {
      return { required: true, reason: `ui-path:${file}` };
    }
  }
  // Per the handoff, acceptance keywords are the canonical user-visible
  // signal. Goal/context text is intentionally NOT scanned — a backend
  // refactor that just happens to live under `electron/` should not be
  // forced through computer-use evidence on a name match alone.
  const acceptanceText = asArray(input.acceptance).map((line: any) => String(line || '')).join('\n');
  if (UI_KEYWORD_RX.test(acceptanceText)) {
    return { required: true, reason: 'acceptance-keyword' };
  }
  return { required: false, reason: 'no-ui-signal' };
}

// Validator's last meaningful line is the trailer. We accept the strict
// `VERDICT=` form from the goal-agent skill and fall back to bare
// DONE/BLOCKED when the validator didn't tag itself.
function parseValidatorOutcome(text: any) {
  const body = String(text || '');
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^BLOCKED:\s*VERDICT\s*=\s*manual[- ]required/i.test(line)) return 'MANUAL_REQUIRED';
    if (/^BLOCKED:\s*VERDICT\s*=\s*computer[- ]use[- ]required/i.test(line)) return 'COMPUTER_USE_REQUIRED';
    if (/^BLOCKED:\s*VERDICT\s*=\s*blocked[- ]scope/i.test(line)) return 'BLOCKED_SCOPE';
    if (/^BLOCKED:\s*VERDICT\s*=\s*request[- ]changes/i.test(line)) return 'FIXBACK_REQUIRED';
    if (/^DONE:\s*VERDICT\s*=\s*pass/i.test(line)) return 'PASS';
    if (/^DONE\b/i.test(line)) return 'PASS';
    if (/^BLOCKED\b/i.test(line)) return 'FIXBACK_REQUIRED';
  }
  return 'NONE';
}

// Evidence is "complete" when it proves the validator exercised the worker's
// running app, not just a random Ace browser tab. It must carry:
//  - a dev-environment start/URL/window record,
//  - a screenshot path or command log from the browser/computer-use pass, and
//  - a checkedAcceptance array.
// Every checkedAcceptance entry must pass. Any failed item means the validator
// cannot return PASS — it must request fixback or block.
function evidenceIsComplete(evidence: any) {
  if (!evidence || typeof evidence !== 'object') return false;
  const screenshots = asArray(evidence.screenshots).filter(Boolean);
  const commandLog = asArray(evidence.commandLog || evidence.command_log).filter(Boolean);
  const checkedAcceptance = asArray(
    evidence.checkedAcceptance || evidence.checked_acceptance
  ).filter((entry: any) => entry && typeof entry === 'object');
  const devEnvironment = evidence.devEnvironment || evidence.dev_environment || null;
  const hasDevEnvironment =
    !!(devEnvironment && typeof devEnvironment === 'object' && (
      devEnvironment.url ||
      devEnvironment.appWindow ||
      devEnvironment.app_window ||
      devEnvironment.command ||
      String(devEnvironment.status || '').toLowerCase() === 'pass'
    )) ||
    commandLog.some((line: any) =>
      /\bnpm run dev(?::web|:electron)?\b|VITE_DEV_SERVER_URL|Local:\s+https?:\/\/|Electron.*launched/i.test(String(line || ''))
    );
  const hasArtifact = screenshots.length > 0 || commandLog.length > 0;
  if (!hasDevEnvironment) return false;
  if (!hasArtifact) return false;
  if (checkedAcceptance.length === 0) return false;
  return checkedAcceptance.every((entry: any) => String(entry.status || '').toLowerCase() === 'pass');
}

// Single source of truth for what happens after the validator returns.
// `nextAction` is consumed by Hermes intake/router or a controller (see
// orchestration-policy.cts) to pick a concrete handler.
function evaluateValidatorVerdict(input: any = {}) {
  let outcomeRaw = String(input.outcome || '').trim().toUpperCase();
  // The reconciler folds a parsed VERDICT=request-changes record to
  // 'REQUEST-CHANGES' (validatorOutcomeFromVerdict); this policy's canonical
  // token is FIXBACK_REQUIRED. Accept both spellings, or a real validator
  // finding would be misread as "no parseable trailer" and block the run.
  if (outcomeRaw === 'REQUEST-CHANGES' || outcomeRaw === 'REQUEST_CHANGES') {
    outcomeRaw = 'FIXBACK_REQUIRED';
  }
  const outcome = KNOWN_OUTCOMES.has(outcomeRaw) ? outcomeRaw : 'NONE';
  const computerUseRequired = input.computerUseRequired === true;
  const computerUseEvidence = input.computerUseEvidence || null;
  const failures: string[] = [];
  if (outcome === 'NONE') {
    failures.push('validator returned no parseable trailer (DONE/BLOCKED with VERDICT=)');
    return { ok: false, nextAction: 'blocked', outcome, failures };
  }
  if (outcome === 'PASS') {
    if (computerUseRequired && !evidenceIsComplete(computerUseEvidence)) {
      failures.push(
        'validator returned PASS but computer-use evidence is missing or incomplete; ' +
          'a UI/browser/Electron change cannot pass on code review alone'
      );
      return { ok: false, nextAction: 'computer-use-required', outcome, failures };
    }
    return { ok: true, nextAction: 'release', outcome, failures };
  }
  if (outcome === 'FIXBACK_REQUIRED') {
    return {
      ok: false,
      nextAction: 'fixback',
      outcome,
      failures: ['validator requested fixback'],
    };
  }
  if (outcome === 'BLOCKED_SCOPE') {
    return {
      ok: false,
      nextAction: 'blocked-scope',
      outcome,
      failures: ['scope blocker — escalate to chief, no fixback'],
    };
  }
  if (outcome === 'COMPUTER_USE_REQUIRED') {
    return {
      ok: false,
      nextAction: 'computer-use-required',
      outcome,
      failures: ['validator must produce computer-use evidence before re-verdict'],
    };
  }
  // MANUAL_REQUIRED
  return {
    ok: false,
    nextAction: 'manual-required',
    outcome,
    failures: ['validator requires manual verification — no fake pass'],
  };
}

// Markdown block stitched into ValidatorGoalSpec/v1 so the validator agent
// reads it directly from disk. Always emits a block (even when not
// required) so the validator can confirm the policy decision.
function buildComputerUseSection(spec: any) {
  const decision = requiresComputerUse(spec);
  if (!decision.required) {
    return [
      '## Computer Use',
      'Required: no',
      `Reason: ${decision.reason}`,
      'Evidence must include:',
      '- (none — confirm scope and proceed with code review)',
      '',
    ].join('\n');
  }
  return [
    '## Computer Use',
    'Required: yes',
    `Reason: ${decision.reason}`,
    'Commands:',
    '- ace browser list --task <taskId>',
    '- ace browser open --task <taskId> <url>',
    '- ace browser wait --task <taskId> <tabId> --load',
    '- ace browser elements --task <taskId> <tabId>',
    '- ace browser screenshot --task <taskId> <tabId> --out evidence/ui.png --full-page',
    '- ace browser console --task <taskId> <tabId> --errors',
    'Evidence must include:',
    '- dev-environment proof: command, local URL/window, and startup result',
    '- at least one browser/computer-use screenshot path under evidence/ OR an explicit `BLOCKED: VERDICT=manual-required` blocker with steps',
    '- console/runtime diagnostics from the running dev app when browser checks apply',
    '- a checked acceptance list — each item with status pass/fail and an evidence pointer',
    'Validator cannot return DONE: VERDICT=pass without the above; default to',
    '`BLOCKED: VERDICT=computer-use-required` instead.',
    '',
  ].join('\n');
}


const BEHAVIORAL_COMPLETION_SCHEMA = 'ace.computer_use_behavioral_validation.v1';

// THE gate-side reader for computer-use evidence. The gate reads this ARTIFACT
// at a deterministic path — it never greps a `COMPUTER-USE:` text line (a
// spoofable string is not evidence). ok:false ⇒ fail-closed.
function readBehavioralCompletion({ completionJsonPath, validatedHeadSha, requiredIds }: any = {}) {
  let parsed: any = null;
  try {
    parsed = JSON.parse(fs.readFileSync(String(completionJsonPath || ''), 'utf8'));
  } catch {
    return { ok: false, reason: `completion.json missing or unreadable at ${completionJsonPath}` };
  }
  if (parsed?.schema !== BEHAVIORAL_COMPLETION_SCHEMA) {
    return { ok: false, reason: `completion.json schema must be ${BEHAVIORAL_COMPLETION_SCHEMA}` };
  }
  const sha = String(parsed.validatedHeadSha || parsed.headSha || '').trim();
  const expected = String(validatedHeadSha || '').trim();
  if (expected && (!sha || (sha !== expected && !expected.startsWith(sha) && !sha.startsWith(expected)))) {
    return { ok: false, reason: `evidence head ${sha || '(none)'} does not match validated head ${expected}` };
  }
  const verdictPass = parsed.passed === true || String(parsed.verdict || '').toUpperCase() === 'PASS';
  if (!verdictPass) return { ok: false, reason: 'completion.json is not a passing run' };
  const checked = asArray(parsed.checkedAcceptance || parsed.checked_acceptance)
    .filter((entry: any) => entry && typeof entry === 'object');
  const passingIds = new Set(
    checked
      .filter((entry: any) => String(entry.status || '').toLowerCase() === 'pass')
      .map((entry: any) => String(entry.id || entry.criterion || '').toUpperCase())
  );
  const missing = (Array.isArray(requiredIds) ? requiredIds : [])
    .map((id: any) => String(id).toUpperCase())
    .filter((id: any) => !passingIds.has(id));
  if (missing.length) {
    return { ok: false, reason: `completion.json checkedAcceptance does not cover ${missing.join(', ')}` };
  }
  // Verify-at-start regression smoke is GATE-ENFORCED for UI runs: a new
  // feature that works while a previous critical path regressed must not merge.
  if (String(parsed.artifactType || '').toUpperCase() === 'UI' && parsed.regressionSmoke?.passed !== true) {
    return { ok: false, reason: 'UI run requires regressionSmoke.passed=true (verify-at-start)' };
  }
  return { ok: true, completion: parsed, passingIds: [...passingIds] };
}

// Script-written packaged-boot proof (stronger trust class than the
// agent-written completion.json) — required for auto-chain merges.
function readBranchProof({ branchProofPath, validatedHeadSha }: any = {}) {
  let parsed: any = null;
  try {
    parsed = JSON.parse(fs.readFileSync(String(branchProofPath || ''), 'utf8'));
  } catch {
    return { ok: false, reason: `branch-proof.json missing or unreadable at ${branchProofPath}` };
  }
  if (parsed?.bootOk !== true || parsed?.socketOk !== true) {
    return { ok: false, reason: 'packaged branch build did not boot healthy (bootOk/socketOk)' };
  }
  const sha = String(parsed.sha || '').trim();
  const expected = String(validatedHeadSha || '').trim();
  if (expected && (!sha || (!expected.startsWith(sha) && !sha.startsWith(expected)))) {
    return { ok: false, reason: `branch-proof sha ${sha || '(none)'} does not match validated head ${expected}` };
  }
  return { ok: true, proof: parsed };
}

module.exports = {
  KNOWN_OUTCOMES,
  UI_PATH_RX,
  UI_KEYWORD_RX,
  requiresComputerUse,
  parseValidatorOutcome,
  evidenceIsComplete,
  evaluateValidatorVerdict,
  BEHAVIORAL_COMPLETION_SCHEMA,
  readBehavioralCompletion,
  readBranchProof,
  buildComputerUseSection,
};
