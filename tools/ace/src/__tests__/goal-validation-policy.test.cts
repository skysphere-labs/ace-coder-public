const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requiresComputerUse,
  parseValidatorOutcome,
  evidenceIsComplete,
  evaluateValidatorVerdict,
  buildComputerUseSection,
  KNOWN_OUTCOMES,
} = require('../goal-validation-policy.cts');

// ---------------------------------------------------------------------------
// requiresComputerUse
// ---------------------------------------------------------------------------

test('requiresComputerUse: explicit computerUseRequired:true wins', () => {
  const d = requiresComputerUse({ computerUseRequired: true });
  assert.equal(d.required, true);
  assert.equal(d.reason, 'explicit-spec-flag');
});

test('requiresComputerUse: explicit computerUseRequired:false wins (no UI heuristics)', () => {
  const d = requiresComputerUse({
    computerUseRequired: false,
    taskClass: 'ui_product_design',
  });
  assert.equal(d.required, false);
  assert.equal(d.reason, 'explicit-spec-flag-off');
});

test('requiresComputerUse: taskClass=ui_product_design forces required', () => {
  const d = requiresComputerUse({ taskClass: 'ui_product_design' });
  assert.equal(d.required, true);
  assert.equal(d.reason, 'task-class-ui-product-design');
});

test('requiresComputerUse: agentClass=browser-ui forces required', () => {
  const d = requiresComputerUse({ agentClass: 'browser-ui' });
  assert.equal(d.required, true);
  assert.equal(d.reason, 'agent-class-browser-ui');
});

test('requiresComputerUse: browserMode:on forces required', () => {
  const d = requiresComputerUse({ browserMode: 'on' });
  assert.equal(d.required, true);
  assert.equal(d.reason, 'browser-mode-on');
});

test('requiresComputerUse: changed file under src/components/ forces required', () => {
  const d = requiresComputerUse({ changedFiles: ['src/components/Header.tsx'] });
  assert.equal(d.required, true);
  assert.match(d.reason, /^ui-path:/);
});

test('requiresComputerUse: changed file under electron/browser* forces required', () => {
  const d = requiresComputerUse({ changedFiles: ['electron/browser-session.cts'] });
  assert.equal(d.required, true);
  assert.match(d.reason, /^ui-path:/);
});

test('requiresComputerUse: acceptance keyword (screenshot/click-through/menu navigation) forces required', () => {
  assert.equal(
    requiresComputerUse({ acceptance: ['Screenshot of new settings menu matches mock'] }).required,
    true
  );
  assert.equal(
    requiresComputerUse({ acceptance: ['Menu navigation opens the settings panel'] }).required,
    true
  );
});

test('requiresComputerUse: plain backend spec is not required', () => {
  const d = requiresComputerUse({
    goal: 'Refactor electron/local-core ledger writer.',
    acceptance: ['npm test passes', 'no extra deps'],
    changedFiles: ['electron/local-core.cts'],
  });
  assert.equal(d.required, false);
  assert.equal(d.reason, 'no-ui-signal');
});

test('requiresComputerUse: null/undefined input is safe', () => {
  assert.equal(requiresComputerUse(null).required, false);
  assert.equal(requiresComputerUse(undefined).required, false);
});

// ---------------------------------------------------------------------------
// parseValidatorOutcome
// ---------------------------------------------------------------------------

test('parseValidatorOutcome: explicit DONE: VERDICT=pass → PASS', () => {
  assert.equal(parseValidatorOutcome('lots of text\nDONE: VERDICT=pass evidence at ...'), 'PASS');
});

test('parseValidatorOutcome: explicit BLOCKED: VERDICT=request-changes → FIXBACK_REQUIRED', () => {
  assert.equal(
    parseValidatorOutcome('BLOCKED: VERDICT=request-changes lint fails on Foo.tsx'),
    'FIXBACK_REQUIRED'
  );
});

test('parseValidatorOutcome: BLOCKED: VERDICT=blocked-scope → BLOCKED_SCOPE', () => {
  assert.equal(
    parseValidatorOutcome('BLOCKED: VERDICT=blocked-scope acceptance moved off-scope'),
    'BLOCKED_SCOPE'
  );
});

test('parseValidatorOutcome: BLOCKED: VERDICT=computer-use-required → COMPUTER_USE_REQUIRED', () => {
  assert.equal(
    parseValidatorOutcome('BLOCKED: VERDICT=computer-use-required no screenshot in evidence/'),
    'COMPUTER_USE_REQUIRED'
  );
});

test('parseValidatorOutcome: BLOCKED: VERDICT=manual-required → MANUAL_REQUIRED', () => {
  assert.equal(
    parseValidatorOutcome('BLOCKED: VERDICT=manual-required CI cannot reach the embedded device'),
    'MANUAL_REQUIRED'
  );
});

test('parseValidatorOutcome: bare DONE/BLOCKED fall back to PASS/FIXBACK_REQUIRED', () => {
  assert.equal(parseValidatorOutcome('DONE: shipped'), 'PASS');
  assert.equal(parseValidatorOutcome('BLOCKED: missing input'), 'FIXBACK_REQUIRED');
});

test('parseValidatorOutcome: no trailer → NONE', () => {
  assert.equal(parseValidatorOutcome('just chatter, no trailer'), 'NONE');
  assert.equal(parseValidatorOutcome(''), 'NONE');
});

test('parseValidatorOutcome: trailing whitespace/blank lines ignored', () => {
  assert.equal(parseValidatorOutcome('DONE: VERDICT=pass yes\n\n   \n'), 'PASS');
});

// ---------------------------------------------------------------------------
// evidenceIsComplete
// ---------------------------------------------------------------------------

test('evidenceIsComplete: requires dev environment, screenshot/commandLog, and all-pass checked acceptance', () => {
  assert.equal(evidenceIsComplete(null), false);
  assert.equal(evidenceIsComplete({}), false);
  assert.equal(
    evidenceIsComplete({ screenshots: ['evidence/ui.png'] }),
    false,
    'screenshot alone is not enough'
  );
  assert.equal(
    evidenceIsComplete({ checkedAcceptance: [{ item: 'x', status: 'pass', evidence: 'log' }] }),
    false,
    'checked-only without artifact is not enough'
  );
  assert.equal(
    evidenceIsComplete({
      devEnvironment: { command: 'npm run dev', url: 'http://localhost:5173', status: 'pass' },
      screenshots: ['evidence/ui.png'],
      checkedAcceptance: [{ item: 'x', status: 'pass', evidence: 'log' }],
    }),
    true
  );
  assert.equal(
    evidenceIsComplete({
      commandLog: ['npm run dev -> Local: http://localhost:5173', 'npm run smoke pass'],
      checkedAcceptance: [{ item: 'x', status: 'pass' }],
    }),
    true
  );
  assert.equal(
    evidenceIsComplete({
      screenshots: ['evidence/ui.png'],
      checkedAcceptance: [{ item: 'x', status: 'pass', evidence: 'log' }],
    }),
    false,
    'screenshot + acceptance without dev-environment proof is not enough'
  );
});

test('evidenceIsComplete: a single failed acceptance item blocks pass', () => {
  assert.equal(
    evidenceIsComplete({
      devEnvironment: { command: 'npm run dev', url: 'http://localhost:5173', status: 'pass' },
      screenshots: ['evidence/ui.png'],
      checkedAcceptance: [
        { item: 'a', status: 'pass' },
        { item: 'b', status: 'fail' },
      ],
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// evaluateValidatorVerdict
// ---------------------------------------------------------------------------

test('evaluateValidatorVerdict: PASS with no computer-use requirement → release', () => {
  const r = evaluateValidatorVerdict({ outcome: 'PASS' });
  assert.equal(r.ok, true);
  assert.equal(r.nextAction, 'release');
  assert.deepEqual(r.failures, []);
});

test('evaluateValidatorVerdict: PASS but computer-use required without evidence → computer-use-required', () => {
  const r = evaluateValidatorVerdict({
    outcome: 'PASS',
    computerUseRequired: true,
    computerUseEvidence: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'computer-use-required');
  assert.match(r.failures[0], /computer-use evidence is missing or incomplete/);
});

test('evaluateValidatorVerdict: PASS with complete evidence → release', () => {
  const r = evaluateValidatorVerdict({
    outcome: 'PASS',
    computerUseRequired: true,
    computerUseEvidence: {
      devEnvironment: { command: 'npm run dev', url: 'http://localhost:5173', status: 'pass' },
      screenshots: ['evidence/ui.png'],
      checkedAcceptance: [{ item: 'menu opens', status: 'pass', evidence: 'screenshot' }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.nextAction, 'release');
});

test('evaluateValidatorVerdict: FIXBACK_REQUIRED → fixback', () => {
  const r = evaluateValidatorVerdict({ outcome: 'FIXBACK_REQUIRED' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'fixback');
});

test('evaluateValidatorVerdict: BLOCKED_SCOPE → blocked-scope, no fixback', () => {
  const r = evaluateValidatorVerdict({ outcome: 'BLOCKED_SCOPE' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'blocked-scope');
});

test('evaluateValidatorVerdict: COMPUTER_USE_REQUIRED → computer-use-required', () => {
  const r = evaluateValidatorVerdict({ outcome: 'COMPUTER_USE_REQUIRED' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'computer-use-required');
});

test('evaluateValidatorVerdict: MANUAL_REQUIRED → manual-required', () => {
  const r = evaluateValidatorVerdict({ outcome: 'MANUAL_REQUIRED' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'manual-required');
});

test('evaluateValidatorVerdict: NONE → blocked', () => {
  const r = evaluateValidatorVerdict({ outcome: 'NONE' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'blocked');
  assert.match(r.failures[0], /no parseable trailer/);
});

test('evaluateValidatorVerdict: unknown outcome → blocked', () => {
  const r = evaluateValidatorVerdict({ outcome: 'UNKNOWN' });
  assert.equal(r.ok, false);
  assert.equal(r.nextAction, 'blocked');
});

// ---------------------------------------------------------------------------
// buildComputerUseSection
// ---------------------------------------------------------------------------

test('buildComputerUseSection: emits required:yes block for UI spec', () => {
  const md = buildComputerUseSection({ taskClass: 'ui_product_design' });
  assert.match(md, /## Computer Use/);
  assert.match(md, /Required: yes/);
  assert.match(md, /ace browser screenshot/);
  assert.match(md, /computer-use-required/);
});

test('buildComputerUseSection: emits required:no block for backend spec', () => {
  const md = buildComputerUseSection({
    goal: 'Refactor ledger',
    changedFiles: ['electron/local-core.cts'],
  });
  assert.match(md, /Required: no/);
  assert.doesNotMatch(md, /ace browser screenshot/);
});

test('KNOWN_OUTCOMES: pinned contract', () => {
  for (const outcome of [
    'PASS',
    'FIXBACK_REQUIRED',
    'BLOCKED_SCOPE',
    'COMPUTER_USE_REQUIRED',
    'MANUAL_REQUIRED',
    'NONE',
  ]) {
    assert.ok(KNOWN_OUTCOMES.has(outcome), `${outcome} must be a known outcome`);
  }
});

// ── A7: gate-side evidence-artifact readers (never grep a text line) ─────────
const fsA7 = require('node:fs');
const osA7 = require('node:os');
const pathA7 = require('node:path');
const {
  readBehavioralCompletion,
  readBranchProof,
  BEHAVIORAL_COMPLETION_SCHEMA,
} = require('../goal-validation-policy.cjs');

function writeTmpJson(name: string, value: any) {
  const dir = fsA7.mkdtempSync(pathA7.join(osA7.tmpdir(), 'ace-evidence-'));
  const file = pathA7.join(dir, name);
  fsA7.writeFileSync(file, JSON.stringify(value));
  return file;
}

const GOOD_COMPLETION = {
  schema: BEHAVIORAL_COMPLETION_SCHEMA,
  artifactType: 'UI',
  validatedHeadSha: 'abc123abc123',
  passed: true,
  regressionSmoke: { passed: true, notes: 'boot + overlay ok' },
  checkedAcceptance: [
    { id: 'A1', status: 'pass', evidence: 'screenshots/after.png' },
    { id: 'A2', status: 'pass', evidence: 'stdout.log' },
  ],
};

test('readBehavioralCompletion: verified bundle passes; missing file fails closed', () => {
  const file = writeTmpJson('completion.json', GOOD_COMPLETION);
  const ok = readBehavioralCompletion({ completionJsonPath: file, validatedHeadSha: 'abc123abc123', requiredIds: ['A1', 'A2'] });
  assert.equal(ok.ok, true);
  const missing = readBehavioralCompletion({ completionJsonPath: '/nope/completion.json', validatedHeadSha: 'abc', requiredIds: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /missing or unreadable/);
});

test('readBehavioralCompletion: stale head, uncovered ids, failing run, missing UI smoke all fail closed', () => {
  const stale = writeTmpJson('completion.json', { ...GOOD_COMPLETION, validatedHeadSha: 'def456def456' });
  assert.match(readBehavioralCompletion({ completionJsonPath: stale, validatedHeadSha: 'abc123abc123', requiredIds: ['A1'] }).reason, /does not match validated head/);
  const uncovered = writeTmpJson('completion.json', GOOD_COMPLETION);
  assert.match(readBehavioralCompletion({ completionJsonPath: uncovered, validatedHeadSha: 'abc123abc123', requiredIds: ['A1', 'A3'] }).reason, /does not cover A3/);
  const failing = writeTmpJson('completion.json', { ...GOOD_COMPLETION, passed: false, verdict: 'FAIL' });
  assert.match(readBehavioralCompletion({ completionJsonPath: failing, validatedHeadSha: 'abc123abc123', requiredIds: [] }).reason, /not a passing run/);
  const noSmoke = writeTmpJson('completion.json', { ...GOOD_COMPLETION, regressionSmoke: { passed: false } });
  assert.match(readBehavioralCompletion({ completionJsonPath: noSmoke, validatedHeadSha: 'abc123abc123', requiredIds: ['A1'] }).reason, /regressionSmoke/);
  const wrongSchema = writeTmpJson('completion.json', { ...GOOD_COMPLETION, schema: 'something.else/v1' });
  assert.match(readBehavioralCompletion({ completionJsonPath: wrongSchema, validatedHeadSha: 'abc123abc123', requiredIds: [] }).reason, /schema/);
});

test('readBranchProof: healthy packaged boot at the validated head passes; everything else fails closed', () => {
  const good = writeTmpJson('branch-proof.json', { sha: 'abc123a', bootOk: true, socketOk: true, at: 'now' });
  assert.equal(readBranchProof({ branchProofPath: good, validatedHeadSha: 'abc123abc123' }).ok, true);
  const badBoot = writeTmpJson('branch-proof.json', { sha: 'abc123a', bootOk: false, socketOk: true });
  assert.match(readBranchProof({ branchProofPath: badBoot, validatedHeadSha: 'abc123abc123' }).reason, /did not boot healthy/);
  const wrongSha = writeTmpJson('branch-proof.json', { sha: 'fff999f', bootOk: true, socketOk: true });
  assert.match(readBranchProof({ branchProofPath: wrongSha, validatedHeadSha: 'abc123abc123' }).reason, /does not match validated head/);
  assert.match(readBranchProof({ branchProofPath: '/nope/branch-proof.json', validatedHeadSha: 'x' }).reason, /missing or unreadable/);
});
