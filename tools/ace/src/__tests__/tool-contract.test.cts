const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  auditToolUse,
  commandMatchesGroup,
  dependencyLayers,
  manifestFor,
  readToolUseEvents,
  requiresClawpatchValidation,
  validateBatchInput,
  writeToolBatchResult,
  writeToolUseEvent,
} = require('../tool-contract.cts');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-tool-contract-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  return dir;
}

test('tool manifest returns compact required and allowed commands', () => {
  const manifest = manifestFor({ role: 'orchestrator', phase: 'start', compact: true });
  assert.equal(manifest.schema, 'ace.tool_contract.v1');
  assert.equal(manifest.role, 'orchestrator');
  assert.equal(manifest.phase, 'start');
  assert.ok(manifest.required.includes('run board|run list'));
  assert.equal(manifest.required.includes('mission board|mission ready'), false);
  assert.ok(manifest.allowed.includes('tool heartbeat'));
  assert.ok(manifest.allowed.includes('run board'));
  assert.ok(manifest.allowed.includes('validation clawpatch'));
});

test('heartbeat writes one compact NDJSON event', () => {
  const projectDir = tempProject();
  const result = writeToolUseEvent({
    projectDir,
    command: 'tool heartbeat',
    role: 'orchestrator',
    phase: 'start',
    workspaceId: 'prj_42',
    ok: true,
    durationMs: 3,
    prompt: 'must not be logged',
  });
  assert.equal(result.written, true);
  const { events } = readToolUseEvents({ projectDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, 'ace.tool_use.v1');
  assert.equal(events[0].command, 'tool heartbeat');
  assert.equal(events[0].role, 'orchestrator');
  assert.equal(events[0].workspaceId, 'prj_42');
  assert.equal('prompt' in events[0], false);
});

test('audit detects missing required orchestrator events', () => {
  const projectDir = tempProject();
  writeToolUseEvent({ projectDir, command: 'tool heartbeat', role: 'orchestrator', phase: 'start' });
  writeToolUseEvent({ projectDir, command: 'tool manifest', role: 'orchestrator', phase: 'start' });
  writeToolUseEvent({ projectDir, command: 'context' });
  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missingRequiredEvents, ['run board|run list', 'ls|watch|screen|state']);
  assert.ok(audit.driftWarnings.some((line: string) => /run ledger/.test(line)));
});

test('audit passes after heartbeat, manifest, context, run board, and ls', () => {
  const projectDir = tempProject();
  for (const event of [
    { command: 'tool heartbeat', role: 'orchestrator', phase: 'start' },
    { command: 'tool manifest', role: 'orchestrator', phase: 'start' },
    { command: 'context' },
    { command: 'run board' },
    { command: 'ls' },
  ]) {
    writeToolUseEvent({ projectDir, ...event });
  }
  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequiredEvents, []);
});

test('batch result is compact and audit recognizes child command proof', () => {
  const projectDir = tempProject();
  const write = writeToolBatchResult({
    projectDir,
    role: 'orchestrator',
    phase: 'start',
    workspaceId: 'prj_42',
    parallel: true,
    maxConcurrency: 4,
    durationMs: 25,
    results: [
      { id: 'heartbeat', command: 'tool heartbeat', ok: true, durationMs: 1, summary: 'heartbeat recorded', payload: 'ignored' },
      { id: 'manifest', command: 'tool manifest', ok: true, durationMs: 1, summary: 'manifest returned' },
      { id: 'context', command: 'context', ok: true, durationMs: 2, summary: 'context resolved' },
      { id: 'board', command: 'run board', ok: true, durationMs: 3, summary: 'run board read' },
      { id: 'streams', command: 'ls', ok: true, durationMs: 4, summary: 'streams listed' },
    ],
  });
  assert.equal(write.written, true);
  const { events } = readToolUseEvents({ projectDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, 'ace.tool_batch_result.v1');
  assert.equal(events[0].results[0].payload, undefined);

  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start', workspaceId: 'prj_42' });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequiredEvents, []);
  assert.ok(audit.commandsSeen.includes('tool heartbeat'));
  assert.ok(audit.commandsSeen.includes('run board'));
});

test('dependency layers order independent calls before dependent calls', () => {
  const layers = dependencyLayers({
    schema: 'ace.tool_batch.v1',
    role: 'orchestrator',
    phase: 'start',
    calls: [
      { id: 'heartbeat', command: 'tool heartbeat' },
      { id: 'manifest', command: 'tool manifest' },
      { id: 'board', command: 'run board' },
    ],
    dependencies: [{ before: 'heartbeat', after: 'board' }, { id: 'board', dependsOn: ['manifest'] }],
  });
  assert.deepEqual(layers.map((layer: any) => layer.map((call: any) => call.id).sort()), [
    ['heartbeat', 'manifest'],
    ['board'],
  ]);
});

test('batch validation blocks unsafe default mutation commands', () => {
  const validation = validateBatchInput({
    schema: 'ace.tool_batch.v1',
    role: 'orchestrator',
    phase: 'gate',
    calls: [
      { id: 'merge', command: 'integrate pr-merge', args: { task: 'task_1' } },
    ],
  }, { throwOnError: false });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error: string) => /unsafe command/.test(error) || /unallowed command/.test(error)));
});

test('failed child commands do not satisfy audit proof', () => {
  const projectDir = tempProject();
  writeToolBatchResult({
    projectDir,
    role: 'orchestrator',
    phase: 'start',
    results: [
      { id: 'heartbeat', command: 'tool heartbeat', ok: true, summary: 'heartbeat recorded' },
      { id: 'manifest', command: 'tool manifest', ok: true, summary: 'manifest returned' },
      { id: 'context', command: 'context', ok: false, isError: true, summary: 'context failed' },
      { id: 'board', command: 'run board', ok: true, summary: 'run board read' },
      { id: 'streams', command: 'ls', ok: true, summary: 'streams listed' },
    ],
  });
  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequiredEvents.includes('context'));
});

test('OR-groups work correctly', () => {
  assert.equal(commandMatchesGroup('mission ready', 'mission board|mission ready'), true);
  assert.equal(commandMatchesGroup('run list', 'run board|run list'), true);
  assert.equal(commandMatchesGroup('mission ready', 'run board|run list'), false);
  assert.equal(commandMatchesGroup('state conversation:abc', 'ls|watch|screen|state'), true);
  assert.equal(commandMatchesGroup('mission sync', 'mission validate|task validate'), false);
});

test('gate audit accepts passing Clawpatch validation proof', () => {
  const projectDir = tempProject();
  writeToolUseEvent({
    projectDir,
    command: 'validation clawpatch',
    role: 'orchestrator',
    phase: 'gate',
    ok: true,
  });

  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'gate' });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequiredEvents, []);
});

test('gate audit recognizes validation proof recorded during validate phase', () => {
  const projectDir = tempProject();
  writeToolUseEvent({
    projectDir,
    command: 'validation clawpatch',
    role: 'orchestrator',
    phase: 'validate',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    ok: true,
  });

  const audit = auditToolUse({
    projectDir,
    role: 'orchestrator',
    phase: 'gate',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequiredEvents, []);
  assert.deepEqual(audit.commandsSeen, ['validation clawpatch']);
});

test('gate audit recognizes validation artifact proof recorded during validator finish', () => {
  const projectDir = tempProject();
  writeToolUseEvent({
    projectDir,
    command: 'validation artifact',
    role: 'orchestrator',
    phase: 'finish',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    ok: true,
  });

  const audit = auditToolUse({
    projectDir,
    role: 'orchestrator',
    phase: 'gate',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequiredEvents, []);
  assert.deepEqual(audit.commandsSeen, ['validation artifact']);
});

test('Clawpatch policy is optional by default and required for explicit/high-risk work', () => {
  assert.equal(requiresClawpatchValidation({ waveId: 'wave-1' }), false);
  assert.equal(requiresClawpatchValidation({ sizeClass: 'medium' }), false);
  assert.equal(requiresClawpatchValidation({ riskLevel: 'medium' }), true);
  assert.equal(requiresClawpatchValidation({ validationRequired: true }), false);
  assert.equal(requiresClawpatchValidation({ required: true }), true);
  assert.equal(requiresClawpatchValidation({ highRisk: true }), true);
  assert.equal(requiresClawpatchValidation({ capabilities: ['security-review'] }), true);
  assert.equal(requiresClawpatchValidation({ taskClass: 'review_validate' }), false);
  assert.equal(
    requiresClawpatchValidation({ sizeClass: 'small', taskType: 'bug-fix', validationRequired: false }),
    false
  );
});

test('run-scoped audit accepts only events from the same run id', () => {
  const projectDir = tempProject();
  for (const event of [
    { command: 'tool heartbeat', role: 'orchestrator', phase: 'start', runId: 'run-old' },
    { command: 'tool manifest', role: 'orchestrator', phase: 'start', runId: 'run-old' },
    { command: 'context', role: 'orchestrator', phase: 'start', runId: 'run-old' },
    { command: 'run board', role: 'orchestrator', phase: 'start', runId: 'run-old' },
    { command: 'ls', role: 'orchestrator', phase: 'start', runId: 'run-old' },
  ]) {
    writeToolUseEvent({ projectDir, ...event });
  }
  // Without runId, the historic events are enough.
  const looseAudit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(looseAudit.ok, true);

  // With runId set, the same historic events do NOT satisfy the new run.
  const scopedAudit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start', runId: 'run-new' });
  assert.equal(scopedAudit.ok, false);
  assert.deepEqual(scopedAudit.missingRequiredEvents, ['tool heartbeat', 'tool manifest', 'context', 'run board|run list', 'ls|watch|screen|state']);

  // Once we seed proof under the new run id, the scoped audit passes.
  for (const event of [
    { command: 'tool heartbeat', role: 'orchestrator', phase: 'start', runId: 'run-new' },
    { command: 'tool manifest', role: 'orchestrator', phase: 'start', runId: 'run-new' },
    { command: 'context', role: 'orchestrator', phase: 'start', runId: 'run-new' },
    { command: 'run board', role: 'orchestrator', phase: 'start', runId: 'run-new' },
    { command: 'ls', role: 'orchestrator', phase: 'start', runId: 'run-new' },
  ]) {
    writeToolUseEvent({ projectDir, ...event });
  }
  const passed = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start', runId: 'run-new' });
  assert.equal(passed.ok, true);
  assert.equal(passed.runId, 'run-new');
});

test('tool audit cannot satisfy its own required proof from a fresh self-emitted event', () => {
  const projectDir = tempProject();
  // Pretend a previous audit wrote an audit event to the ledger.
  writeToolUseEvent({
    projectDir,
    command: 'tool audit',
    role: 'orchestrator',
    phase: 'start',
    ok: true,
  });
  // It must not count as proof of any required event.
  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequiredEvents.length > 0);
});

test('run-scoped audit respects --window-ms / --since', () => {
  const projectDir = tempProject();
  const oldAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const event of [
    { command: 'tool heartbeat', role: 'orchestrator', phase: 'start', at: oldAt, runId: 'run-window' },
    { command: 'tool manifest', role: 'orchestrator', phase: 'start', at: oldAt, runId: 'run-window' },
    { command: 'context', role: 'orchestrator', phase: 'start', at: oldAt, runId: 'run-window' },
    { command: 'run board', role: 'orchestrator', phase: 'start', at: oldAt, runId: 'run-window' },
    { command: 'ls', role: 'orchestrator', phase: 'start', at: oldAt, runId: 'run-window' },
  ]) {
    writeToolUseEvent({ projectDir, ...event });
  }
  const within = auditToolUse({ projectDir, role: 'orchestrator', phase: 'start' });
  assert.equal(within.ok, true);

  const windowed = auditToolUse({
    projectDir,
    role: 'orchestrator',
    phase: 'start',
    windowMs: 5 * 60 * 1000,
  });
  assert.equal(windowed.ok, false);

  const sinceCheck = auditToolUse({
    projectDir,
    role: 'orchestrator',
    phase: 'start',
    since: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  assert.equal(sinceCheck.ok, false);
});

test('missing Clawpatch when required causes audit failure and event satisfies it', () => {
  const projectDir = tempProject();
  writeToolUseEvent({ projectDir, command: 'mission sync' });
  let audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'validate', clawpatchRequired: true });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missingRequiredEvents, ['validation clawpatch']);

  writeToolUseEvent({ projectDir, command: 'validation clawpatch' });
  audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'validate', clawpatchRequired: true });
  assert.equal(audit.ok, true);
});

test('sync proof no longer requires a prior mission sync event', () => {
  // Defect 5: mission sync used to self-require a prior mission sync event,
  // which is circular. The proof group is now the observability set that
  // any orchestrator can run cheaply before invoking sync.
  const manifest = manifestFor({ role: 'orchestrator', phase: 'sync', compact: true });
  assert.equal(manifest.required.length, 1);
  const group = String(manifest.required[0]);
  assert.equal(group.includes('mission sync'), false);
  assert.ok(group.includes('screen'));
  assert.ok(group.includes('state'));
  assert.ok(group.includes('task result'));
  assert.ok(group.includes('run list'));
  assert.ok(group.includes('mission next'));
});

test('sync audit is satisfied by any one of screen/state/task result/run list/mission next', () => {
  for (const proofCommand of ['screen', 'state', 'task result', 'run list', 'mission next']) {
    const projectDir = tempProject();
    writeToolUseEvent({
      projectDir,
      command: proofCommand,
      role: 'orchestrator',
      phase: 'sync',
      ok: true,
    });
    const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'sync' });
    assert.equal(audit.ok, true, `${proofCommand} must satisfy sync audit`);
    assert.deepEqual(audit.missingRequiredEvents, []);
  }
});

test('sync audit is not satisfied by a fresh mission sync alone (no circular self-proof)', () => {
  const projectDir = tempProject();
  writeToolUseEvent({
    projectDir,
    command: 'mission sync',
    role: 'orchestrator',
    phase: 'sync',
    ok: true,
  });
  const audit = auditToolUse({ projectDir, role: 'orchestrator', phase: 'sync' });
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequiredEvents[0].includes('screen'));
});

test('run-scoped sync audit accepts scoped screen + mission next from the same run', () => {
  const projectDir = tempProject();
  // Old (different run) events do not count.
  writeToolUseEvent({
    projectDir,
    command: 'screen',
    role: 'orchestrator',
    phase: 'sync',
    runId: 'run-old',
    ok: true,
  });
  const stale = auditToolUse({ projectDir, role: 'orchestrator', phase: 'sync', runId: 'run-new' });
  assert.equal(stale.ok, false);

  // Same-run scoped proof satisfies it.
  writeToolUseEvent({
    projectDir,
    command: 'screen',
    role: 'orchestrator',
    phase: 'sync',
    runId: 'run-new',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    streamId: 'variant:var_42',
    ok: true,
  });
  writeToolUseEvent({
    projectDir,
    command: 'mission next',
    role: 'orchestrator',
    phase: 'sync',
    runId: 'run-new',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
    ok: true,
  });
  const passed = auditToolUse({
    projectDir,
    role: 'orchestrator',
    phase: 'sync',
    runId: 'run-new',
    workspaceId: 'prj_42',
    missionId: 'msn_42',
  });
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.missingRequiredEvents, []);
});
