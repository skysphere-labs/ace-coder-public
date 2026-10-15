const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runTask,
  runChat,
  ensureStream,
  buildLaunchIntent,
  codexAppParityRequested,
} = require('../orchestrator.cjs');

function taskSpec(patch: any = {}) {
  return {
    goal: 'test goal',
    baseBranch: 'main',
    role: 'editor',
    scope: { workspaceId: 'ws_1' },
    acceptance: ['Worker emits a DONE or BLOCKED trailer.'],
    ...patch,
  };
}

function mockClient(responses: any) {
  const calls: any[] = [];
  // responses: map from method name to array (consumed in order) or function
  const queues = new Map();
  for (const [k, v] of Object.entries(responses || {})) {
    queues.set(k, Array.isArray(v) ? [...v] : v);
  }
  return {
    calls,
    invoke: async (method: any, params: any, clientTimeoutMs: any) => {
      calls.push({ method, params, clientTimeoutMs });
      const entry = queues.get(method);
      if (typeof entry === 'function') return entry(params);
      if (Array.isArray(entry) && entry.length) return entry.shift();
      throw new Error(`mockClient: no response queued for ${method}`);
    },
    close: () => {},
  };
}

test('ensureStream: attaches to explicit streamId without spawning', async () => {
  const client = mockClient({});
  const r = await ensureStream(client, { streamId: 'conversation:abc', agent: 'claude' });
  assert.equal(r.streamId, 'conversation:abc');
  assert.equal(r.created, false);
  assert.equal(client.calls.length, 0);
});

test('ensureStream: spawns via streamSpawn when taskId given', async () => {
  const client = mockClient({
    streamSpawn: [{ streamId: 'conversation:xyz', conversationId: 'xyz' }],
  });
  const r = await ensureStream(client, { agent: 'claude', taskId: 'tsk_1' });
  assert.equal(r.streamId, 'conversation:xyz');
  assert.equal(r.created, true);
  assert.equal(client.calls[0].method, 'streamSpawn');
  assert.deepEqual(client.calls[0].params, { agent: 'claude', taskId: 'tsk_1', kind: 'cli' });
});

test('ensureStream: spawns via streamSpawnAdhoc when workspaceId given', async () => {
  const client = mockClient({
    streamSpawnAdhoc: [{ streamId: 'conversation:adh', conversationId: 'adh', taskId: 'thr_1' }],
  });
  const r = await ensureStream(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    label: 'test',
  });
  assert.equal(r.streamId, 'conversation:adh');
  assert.equal(r.taskId, 'thr_1');
  assert.equal(client.calls[0].method, 'streamSpawnAdhoc');
  assert.equal(client.calls[0].params.label, 'test');
});

test('ensureStream: errors when nothing is given', async () => {
  const client = mockClient({});
  await assert.rejects(() => ensureStream(client, { agent: 'claude' }), /streamId, taskId, workspaceId/);
});

test('buildLaunchIntent: Claude max is passed through and Codex xhigh is unchanged', () => {
  const claudeMax = buildLaunchIntent('claude', { effort: 'max' });
  assert.equal(claudeMax.provider, 'claude');
  assert.equal(claudeMax.reasoningEffort, 'max');
  assert.deepEqual(claudeMax.cliArgs, ['--effort', 'max']);
  assert.equal(claudeMax.ultraCode, true);
  assert.equal(claudeMax.workflowMode, 'dynamic-workflow');
  assert.equal(claudeMax.effortCommand, '/effort ultracode');
  assert.deepEqual(claudeMax.preludeCommands, ['/effort ultracode']);
  assert.match(claudeMax.guidance, /xhigh remains extra-high reasoning only/);
  assert.deepEqual(claudeMax.skillIds, []);
  assert.deepEqual(claudeMax.warnings, []);
  assert.deepEqual(
    buildLaunchIntent('codex', { effort: 'xhigh' }).codexConfigOverrides,
    ['model_reasoning_effort="xhigh"']
  );
  const codexMax = buildLaunchIntent('codex', { effort: 'max' });
  assert.equal(codexMax.blocked, true);
  assert.equal(codexMax.reasoningEffort, null);
  assert.deepEqual(codexMax.codexConfigOverrides, []);
  assert.match(codexMax.warnings.join('\n'), /Codex reasoning effort "max" is not supported/);
});

test('buildLaunchIntent: Codex app-parity capability-only request requires audit reason', () => {
  const intent = buildLaunchIntent('codex', {
    effort: 'xhigh',
    capabilities: ['computer-use'],
  });
  assert.equal(intent.provider, 'codex');
  assert.equal(intent.blocked, true);
  assert.equal(intent.effectiveToolMode, 'off');
  assert.equal(intent.codexRuntimeProfile, undefined);
  assert.equal(intent.appParityAuditReason, null);
  assert.ok(!intent.codexConfigOverrides.includes('features.computer_use=true'));
  assert.match(intent.warnings.join('\n'), /app-parity runtime requires toolOverrideReason/);
});

test('buildLaunchIntent: Codex app-parity enables app/plugin/computer-use surfaces with audit reason', () => {
  const intent = buildLaunchIntent('codex', {
    effort: 'xhigh',
    codexRuntimeProfile: 'app-parity',
    toolMode: 'on',
    browserMode: 'on',
    capabilities: ['computer-use'],
    toolOverrideReason: 'operator requested app-parity computer-use validation',
  });
  assert.equal(intent.provider, 'codex');
  assert.equal(intent.codexRuntimeProfile, 'app-parity');
  assert.equal(intent.requestedCodexRuntimeProfile, 'app-parity');
  assert.equal(intent.appParityAuditReason, 'operator requested app-parity computer-use validation');
  assert.equal(intent.toolOverrideReason, 'operator requested app-parity computer-use validation');
  assert.equal(codexAppParityRequested(intent), true);
  assert.equal(intent.enableMcp, true);
  assert.equal(intent.effectiveToolMode, 'app-parity');
  assert.deepEqual(intent.warnings, []);
  assert.ok(intent.codexConfigOverrides.includes('features.apps=true'));
  assert.ok(intent.codexConfigOverrides.includes('features.plugins=true'));
  assert.ok(intent.codexConfigOverrides.includes('features.computer_use=true'));
  assert.ok(intent.readinessChecks.some((check: string) => /app-server/.test(check)));
});

test('buildLaunchIntent: explicit ultraCode flag enters UltraCode at xhigh (spine Claude workers)', () => {
  // Owner policy: every spine Claude worker runs at xhigh AND in UltraCode —
  // the `/effort ultracode` prelude is orthogonal to the --effort reasoning flag.
  const ultra = buildLaunchIntent('claude', { effort: 'xhigh', ultraCode: true });
  assert.equal(ultra.reasoningEffort, 'xhigh');
  assert.deepEqual(ultra.cliArgs, ['--effort', 'xhigh']);
  assert.equal(ultra.ultraCode, true);
  assert.equal(ultra.workflowMode, 'dynamic-workflow');
  assert.equal(ultra.effortCommand, '/effort ultracode');
  assert.deepEqual(ultra.preludeCommands, ['/effort ultracode']);
  // Without the flag, plain xhigh stays reasoning-only (no prelude).
  const plain = buildLaunchIntent('claude', { effort: 'xhigh' });
  assert.equal(plain.ultraCode, false);
  assert.equal(plain.effortCommand, null);
  assert.equal(plain.workflowMode, null);
});

test('runTask: spine Claude worker types /effort ultracode, then /goal IS the fire-and-forget delivery', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{ taskId: 'tsk_sky', variantId: 'var_sky', worktreePath: '/tmp/wt', branch: 'ace/sky', baseBranch: 'origin/main' }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_sky', variantId: 'var_sky' }],
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 }, // ultracode prelude pre-wait
      { state: 'awaiting-input', elapsedMs: 1 }, // ultracode prelude post-submit
      { state: 'awaiting-input', elapsedMs: 1 }, // fire-and-forget delivery wait
    ],
    // Both go through streamSendSubmit, TYPED so Claude's slash parser fires.
    // Claude's /goal auto-starts the worker, so it IS the whole delivery — there
    // is NO separate framed brief (the worker would already be busy).
    streamSendSubmit: [
      { ok: true, telemetry: { promptMs: 1 } }, // /effort ultracode
      { ok: true, telemetry: { promptMs: 2 } }, // /goal <rich objective> (the delivery)
    ],
  });
  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({ goal: 'Build the site', goalMode: 'on', ultraCode: true, deliverables: ['Open a PR and report its URL'] }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'dispatched');
  assert.equal(r.telemetry.launchIntent.ultraCode, true);
  assert.equal(r.telemetry.effort, 'xhigh');
  // Telemetry proves the full launch mode from ONE submission: xhigh reasoning,
  // the UltraCode prelude, and active goal mode delivered via the rich /goal.
  assert.equal(r.telemetry.launchIntent.reasoningEffort, 'xhigh');
  assert.equal(r.telemetry.launchIntent.effortCommand, '/effort ultracode');
  assert.deepEqual(r.goalMode, { mode: 'on', injected: true, deliveredVia: 'goal-command' });
  // Fire-and-forget linkage stays visible: task, stream, worktree, branch.
  assert.equal(r.taskId, 'tsk_sky');
  assert.equal(r.streamId, 'variant:var_sky');
  assert.equal(r.worktreePath, '/tmp/wt');
  assert.equal(r.branch, 'ace/sky');
  const sends = client.calls.filter((c) => c.method === 'streamSendSubmit');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].params.text, '/effort ultracode');
  assert.equal(sends[0].params.mode, 'type'); // typed so the slash parser fires
  // The delivery is the rich /goal objective (NOT a framed brief), also typed.
  // ORDER is the regression: the UltraCode prelude must land BEFORE /goal —
  // /goal auto-starts the worker, so a late /effort would never execute.
  assert.match(sends[1].params.text, /^\/goal Complete Build the site/);
  assert.equal(sends[1].params.mode, 'type');
  assert.match(sends[1].params.text, /Deliver: Open a PR/); // rich /goal carries the deliverable
});

test('runTask: Claude worker booting into awaiting-approval is approved, then receives its prompt', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{ taskId: 'tsk_ap', variantId: 'var_ap', worktreePath: '/tmp/wt', branch: 'ace/ap', baseBranch: 'origin/main' }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_ap', variantId: 'var_ap' }],
    streamWaitFor: [
      { state: 'awaiting-approval', elapsedMs: 1 }, // boot approval gate (clear pre-wait)
      { state: 'awaiting-input', elapsedMs: 1 },     // cleared → ready (clear re-wait)
      { state: 'awaiting-input', elapsedMs: 1 },     // ultracode post-submit
      { state: 'awaiting-input', elapsedMs: 1 },     // fire-and-forget delivery wait
    ],
    streamApprove: [{ ok: true, answer: 'yes' }],
    streamSendSubmit: [
      { ok: true, telemetry: { promptMs: 1 } }, // /effort ultracode
      { ok: true, telemetry: { promptMs: 1 } }, // framed brief
    ],
  });
  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({ goal: 'fire', ultraCode: true }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'dispatched');
  // The boot approval gate was cleared instead of hanging the dispatch.
  const approvals = client.calls.filter((c) => c.method === 'streamApprove');
  assert.equal(approvals.length, 1);
  // The ultracode prelude + framed brief still went out.
  const sends = client.calls.filter((c) => c.method === 'streamSendSubmit');
  assert.equal(sends[0].params.text, '/effort ultracode');
  assert.equal(sends.length, 2);
});

test('runTask: Claude max types /effort ultracode before file-first /goal prompt', async () => {
  const client = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 1 } }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    streamId: 'conversation:claude-max',
    spec: taskSpec({
      goal: 'Implement GoalAgentSpec',
      goalMode: 'on',
      workerSpecPath: '/work/.ace/goals/m/f/GOAL_AGENT_SPEC.md',
      goalLedgerPath: '/work/.agent/runs/m-f',
      effort: 'max',
      effortOverrideReason: 'Mission lane explicitly requires Claude UltraCode.',
    }),
    requireChanges: false,
  });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(client.calls.map((c) => c.method), [
    'streamWaitFor',
    'streamSendSubmit',
    'streamWaitFor',
    'streamAsk',
  ]);
  assert.equal(client.calls[1].params.text, '/effort ultracode');
  assert.equal(client.calls[1].params.mode, 'type'); // typed so Claude's slash parser fires
  assert.match(client.calls[3].params.prompt, /^\/goal\nRead and execute:\n\/work\/\.ace\/goals\/m\/f\/GOAL_AGENT_SPEC\.md/m);
  assert.equal(r.telemetry.launchIntent.ultraCode, true);
  assert.equal(r.telemetry.launchIntent.effortCommand, '/effort ultracode');
});

test('runTask: single round DONE short-circuits', async () => {
  const client = mockClient({
    streamAsk: [
      {
        ok: true,
        endState: 'turn-complete',
        elapsedMs: 1234,
        newOutput: 'I did the thing.\nDONE: shipped',
      },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'test goal' }),
    maxRounds: 3,
  });
  assert.equal(r.schema, 'AceTaskRunResult/v1');
  assert.equal(r.version, 1);
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'shipped');
  assert.equal(r.rounds, 1);
  assert.match(r.lastAssistantText, /DONE: shipped/);
  assert.equal(r.telemetry.schema, 'AceTaskRunTelemetry/v1');
  assert.equal(r.telemetry.version, 1);
  assert.equal(r.telemetry.provider, 'codex');
  assert.ok(r.telemetry.renderedPromptChars > 0);
  assert.equal(r.telemetry.skillCount, 5);
  assert.equal(r.telemetry.skillPack, 'generic');
  assert.equal(r.telemetry.taskType, 'generic');
  assert.equal(r.telemetry.driver, 'codex');
  assert.equal(r.telemetry.roleMode, 'implementer');
  assert.equal(r.telemetry.mcpMode, 'off');
  assert.equal(r.telemetry.baseRefreshMode, 'false');
  assert.equal(r.telemetry.readyMs, null);
  assert.equal(r.telemetry.promptMs, null);
  assert.equal(r.telemetry.firstOutputMs, 1234);
  assert.equal(r.roundDetails[0].renderedPromptChars, r.telemetry.renderedPromptChars);
});

test('runTask: rejects non-canonical specs before dispatch', async () => {
  const client = mockClient({});
  await assert.rejects(
    () => runTask(client, {
      streamId: 'conversation:a',
      spec: { goal: 'missing canonical fields' },
    }),
    /runTask: invalid TaskSpec.*baseBranch required/
  );
  assert.equal(client.calls.length, 0);
});

test('runTask: Codex-style long newOutput with mid-stream DONE resolves to done (not max-rounds)', async () => {
  // Simulates the fixed screen.diff() returning scrollback, not a viewport
  // slice: >40 lines of reasoning/tool output with DONE buried mid-stream and
  // a "> " ready prompt at the tail. parseTrailer must still find DONE.
  const preLines = [];
  for (let i = 0; i < 25; i++) preLines.push(`thinking step ${i}: exploring options...`);
  const postLines = [];
  for (let i = 0; i < 50; i++) postLines.push(`tokens used: ${i}`);
  const longNewOutput = [
    ...preLines,
    'DONE: no-code codex dev smoke passed',
    ...postLines,
    '> ',
  ].join('\n');

  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 999, newOutput: longNewOutput }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:codex-long',
    spec: taskSpec({ goal: 'codex smoke' }),
    maxRounds: 3,
    requireChanges: false,
  });
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'no-code codex dev smoke passed');
  assert.equal(r.rounds, 1);
});

test('runTask: goalMode=on queues /goal for Codex after stream readiness', async () => {
  const client = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:codex',
    spec: taskSpec({ goal: 'Use goal mode', goalMode: 'on' }),
    requireChanges: false,
  });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(client.calls.map((c) => c.method), [
    'streamWaitFor',
    'streamSendInput',
    'streamSubmit',
    'streamWaitFor',
    'streamAsk',
  ]);
  assert.deepEqual(client.calls[0].params, {
    streamId: 'conversation:codex',
    predicate: { awaitingInput: true },
    timeoutMs: 30000,
  });
  assert.match(client.calls[1].params.text, /^\/goal Complete Use goal mode/);
  assert.match(client.calls[1].params.text, /Done when: Worker emits a DONE or BLOCKED trailer\./);
  assert.match(client.calls[1].params.text, /BLOCKED on unsafe scope, missing guidance, or exhausted budget\./);
  assert.match(client.calls[1].params.text, /Budget: max rounds 3, verify rounds 3\./);
  assert.equal(client.calls[1].params.mode, 'paste');
});

test('runTask: Codex /goal includes ledger pointer when goalLedgerPath is set', async () => {
  const client = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:codex',
    spec: taskSpec({
      goal: 'Ledger-coupled goal',
      goalMode: 'on',
      goalLedgerPath: '/repo/.agent/runs/msn-1-feat-1-ledger-coupled-goal',
    }),
    requireChanges: false,
  });
  const sent = client.calls.find((c) => c.method === 'streamSendInput');
  assert.ok(sent);
  assert.match(sent.params.text, /Maintain the ledger at \/repo\/\.agent\/runs\/msn-1-feat-1-ledger-coupled-goal/);
  assert.match(sent.params.text, /keep implementation-notes\.html current at checkpoints/);
});

test('runTask: explicit waitTimeoutMs overrides Codex goal readiness cap', async () => {
  const client = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:codex',
    spec: taskSpec({ goal: 'Use goal mode', goalMode: 'on' }),
    requireChanges: false,
    waitTimeoutMs: 45_000,
  });
  const waitCalls = client.calls.filter((c) => c.method === 'streamWaitFor');
  assert.equal(waitCalls.length, 2);
  assert.equal(waitCalls[0].params.timeoutMs, 45_000);
  assert.equal(waitCalls[1].params.timeoutMs, 45_000);
});

test('runTask: goalMode=off never queues /goal for Codex', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:codex',
    spec: taskSpec({ goal: 'Large but disabled', goalMode: 'off', sizeClass: 'large' }),
    requireChanges: false,
  });
  assert.deepEqual(client.calls.map((c) => c.method), ['streamAsk']);
});

test('runTask: goalMode=auto queues /goal for Codex code work, including small tasks', async () => {
  const codexMedium = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(codexMedium, {
    agent: 'codex',
    streamId: 'conversation:codex-medium',
    spec: taskSpec({ goal: 'Medium codex task', sizeClass: 'medium' }),
    requireChanges: false,
  });
  assert.ok(codexMedium.calls.some((c) => c.method === 'streamSendInput' && /^\/goal Complete Medium codex task/.test(c.params.text)));

  const codexSmall = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(codexSmall, {
    agent: 'codex',
    streamId: 'conversation:codex-small',
    spec: taskSpec({ goal: 'Small codex task', sizeClass: 'small', taskClass: 'code_change' }),
    requireChanges: false,
  });
  assert.ok(codexSmall.calls.some((c) => c.method === 'streamSendInput' && /^\/goal Complete Small codex task/.test(c.params.text)));

  const codexSmallReview = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(codexSmallReview, {
    agent: 'codex',
    streamId: 'conversation:codex-small-review',
    spec: taskSpec({ goal: 'Small review task', sizeClass: 'small', roleMode: 'reviewer' }),
    requireChanges: false,
  });
  assert.deepEqual(codexSmallReview.calls.map((c) => c.method), ['streamAsk']);

  const claudeMedium = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(claudeMedium, {
    agent: 'claude',
    streamId: 'conversation:claude-medium',
    spec: taskSpec({ goal: 'Medium claude task', sizeClass: 'medium' }),
    requireChanges: false,
  });
  assert.deepEqual(claudeMedium.calls.map((c) => c.method), ['streamAsk']);
});

test('runTask: loops up to maxRounds when no trailer, returns max-rounds', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 100, newOutput: 'progress 1' },
      { ok: true, endState: 'turn-complete', elapsedMs: 100, newOutput: 'progress 2' },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'slow goal' }),
    maxRounds: 2,
  });
  assert.equal(r.rounds, 2);
  assert.equal(r.outcome, 'max-rounds');
  // Second prompt should contain the first round's output summary.
  assert.equal(client.calls.length, 2);
});

test('runTask: maxRounds=0 keeps looping until a trailer', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 100, newOutput: 'progress 1' },
      { ok: true, endState: 'turn-complete', elapsedMs: 100, newOutput: 'progress 2' },
      { ok: true, endState: 'turn-complete', elapsedMs: 100, newOutput: 'DONE: overnight complete' },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'slow goal' }),
    maxRounds: 0,
  });
  assert.equal(r.rounds, 3);
  assert.equal(r.outcome, 'done');
  assert.equal(r.detail, 'overnight complete');
});

test('runTask: BLOCKED stops the loop', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 10, newOutput: 'BLOCKED: no creds' },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'x' }),
    maxRounds: 5,
  });
  assert.equal(r.schema, 'AceTaskRunResult/v1');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.detail, 'no creds');
  assert.equal(r.rounds, 1);
  assert.equal(r.telemetry.provider, 'codex');
  assert.equal(r.telemetry.roleMode, 'implementer');
  assert.equal(r.telemetry.taskType, 'generic');
  assert.equal(r.telemetry.skillPack, 'generic');
  assert.equal(typeof r.telemetry.renderedPromptChars, 'number');
  assert.equal(r.telemetry.skillCount, 5);
  assert.equal(r.telemetry.mcpMode, 'off');
  assert.equal(r.telemetry.baseRefreshMode, 'false');
});

test('runTask: awaiting-approval halts so caller can decide policy', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'awaiting-approval', elapsedMs: 1, newOutput: 'need approval' }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'x' }),
    maxRounds: 3,
  });
  assert.equal(r.outcome, 'awaiting-approval');
});

test('runTask: goalMode=on queues /goal even when fireAndForget=true', async () => {
  // Mission dispatch/wave/validate use fireAndForget=true. Previously
  // fireAndForget short-circuited every queue path, so Codex's native
  // /goal setup was skipped — workers received a TaskSpec but no /goal.
  // With goalMode='on' the queue must still happen (then the framed
  // prompt is delivered fire-and-forget).
  const client = mockClient({
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 }, // queueGoalMode pre-wait
      { state: 'awaiting-input', elapsedMs: 1 }, // queueGoalMode post-submit
      { state: 'awaiting-input', elapsedMs: 1 }, // fireAndForget pre-wait
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 5 } }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:goal-fire',
    taskId: 'tsk_goal_fire',
    spec: taskSpec({
      goal: 'fire with goal',
      goalMode: 'on',
      workerSpecPath: '/work/.ace/goals/m/f/GOAL_AGENT_SPEC.md',
      goalLedgerPath: '/work/.agent/runs/m-f',
    }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'dispatched');
  // The fire-and-forget result now carries the goalMode proof too — telemetry
  // must show goal mode active without any manager follow-up commands.
  assert.deepEqual(r.goalMode, { mode: 'on', injected: true });
  // /goal must have been queued via streamSendInput before the fire-and-forget send.
  const sendInputs = client.calls.filter((c) => c.method === 'streamSendInput');
  assert.equal(sendInputs.length, 1, 'goal queue should run once');
  assert.match(sendInputs[0].params.text, /^\/goal /);
  assert.match(
    sendInputs[0].params.text,
    /GoalAgentSpec at \/work\/\.ace\/goals\/m\/f\/GOAL_AGENT_SPEC\.md/
  );
  // streamSendSubmit (the fire-and-forget delivery) follows the /goal queue.
  const sendSubmits = client.calls.filter((c) => c.method === 'streamSendSubmit');
  assert.equal(sendSubmits.length, 1);
});

test('runTask: Codex xhigh goal launch keeps xhigh config and spec unbounded budget', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_xhigh_goal',
      variantId: 'var_xhigh_goal',
      worktreeId: 'wt_xhigh_goal',
      worktreePath: '/tmp/wt-xhigh',
      branch: 'ace/xhigh-goal',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_xhigh_goal', variantId: 'var_xhigh_goal' }],
    streamWaitFor: [
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
      { state: 'awaiting-input', elapsedMs: 1 },
    ],
    streamSendInput: [{ ok: true }],
    streamSubmit: [{ ok: true }],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 5 } }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Keep Codex xhigh launch config',
      goalMode: 'on',
      effort: 'xhigh',
      effortOverrideReason: 'Chief requested extra-high Codex reasoning.',
      maxRounds: 0,
      maxVerifyRounds: 0,
    }),
    fireAndForget: true,
  });

  assert.equal(r.outcome, 'dispatched');
  assert.equal(r.telemetry.effort, 'xhigh');
  assert.deepEqual(r.telemetry.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);
  const spawnCall = client.calls.find((c) => c.method === 'streamSpawnIntoVariant');
  assert.deepEqual(spawnCall.params.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);
  const goalCall = client.calls.find((c) => c.method === 'streamSendInput');
  assert.match(goalCall.params.text, /^\/goal /);
  assert.match(goalCall.params.text, /unbounded rounds allowed until terminal result/);
  assert.match(goalCall.params.text, /verify rounds 0/);
  assert.doesNotMatch(goalCall.params.text, /max rounds 3/);
});

test('runTask: fireAndForget waits for awaiting-input, then uses atomic send-submit and returns immediately', async () => {
  const client = mockClient({
    streamWaitFor: [{ state: 'awaiting-input', elapsedMs: 12 }],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 17 } }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:a',
    taskId: 'tsk_fire',
    spec: taskSpec({ goal: 'fire' }),
    fireAndForget: true,
  });
  assert.equal(r.schema, 'AceTaskRunResult/v1');
  assert.equal(r.version, 1);
  assert.equal(r.outcome, 'dispatched');
  assert.equal(r.fireAndForget, true);
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, [
    'streamWaitFor',
    'streamSendSubmit',
  ]);
  assert.deepEqual(client.calls[0].params, {
    streamId: 'conversation:a',
    predicate: { awaitingInput: true },
    timeoutMs: 30000,
  });
  assert.ok(client.calls[1].params.text.includes('# Goal'));
  assert.equal(client.calls[1].params.mode, 'paste');
  assert.equal(r.telemetry.provider, 'codex');
  assert.equal(r.telemetry.roleMode, 'implementer');
  assert.equal(r.telemetry.taskType, 'generic');
  assert.equal(r.telemetry.skillPack, 'generic');
  assert.equal(typeof r.telemetry.renderedPromptChars, 'number');
  assert.equal(r.telemetry.skillCount, 5);
  assert.equal(r.telemetry.streamId, 'conversation:a');
  assert.equal(r.telemetry.taskId, 'tsk_fire');
  assert.equal(r.telemetry.mcpMode, 'off');
  assert.equal(r.telemetry.baseRefreshMode, 'false');
  assert.equal(r.telemetry.readyMs, 12);
  assert.equal(r.telemetry.promptMs, 17);
  assert.equal(r.telemetry.firstOutputMs, null);
  assert.equal(r.telemetry.timings.readyMs, 12);
});

test('runTask: explicit waitTimeoutMs overrides fire-and-forget readiness cap', async () => {
  const client = mockClient({
    streamWaitFor: [{ state: 'awaiting-input', elapsedMs: 12 }],
    streamSendSubmit: [{ ok: true }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'fire' }),
    fireAndForget: true,
    waitTimeoutMs: 45_000,
  });
  assert.equal(r.outcome, 'dispatched');
  assert.equal(client.calls[0].method, 'streamWaitFor');
  assert.equal(client.calls[0].params.timeoutMs, 45_000);
});

test('runTask: fireAndForget does not run post-submit retry/probe sleeps on the hot path', async () => {
  const client = mockClient({
    streamWaitFor: [{ state: 'awaiting-input', elapsedMs: 1 }],
    streamSendSubmit: [{ ok: true }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'fire' }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'dispatched');
  assert.deepEqual(client.calls.map((c) => c.method), ['streamWaitFor', 'streamSendSubmit']);
});

test('runTask: refreshBase mode flows into new-task creation and telemetry', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_refresh',
      variantId: 'var_refresh',
      worktreePath: '/tmp/wt',
      branch: 'ace/refresh',
      baseBranch: 'origin/main',
      baseRefreshMode: 'force',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_refresh', variantId: 'var_refresh' }],
    streamWaitFor: [{ state: 'awaiting-input', elapsedMs: 2 }],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 3 } }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({ goal: 'fire' }),
    fireAndForget: true,
    refreshBase: 'force',
  });
  assert.equal(r.outcome, 'dispatched');
  assert.equal(client.calls[0].method, 'streamCreateDelegatedTask');
  assert.equal(client.calls[0].params.refreshBase, 'force');
  assert.equal(r.telemetry.provider, 'claude');
  // Final enforcement: Claude default = xhigh (Claude Max).
  assert.equal(r.telemetry.effort, 'xhigh');
  assert.deepEqual(r.telemetry.launchIntent.cliArgs, ['--effort', 'xhigh']);
  assert.equal(r.telemetry.mcpMode, 'off');
  assert.equal(r.telemetry.baseRefreshMode, 'force');
  assert.equal(r.telemetry.taskId, 'tsk_refresh');
  assert.deepEqual(client.calls[1].params.launchIntent.cliArgs, ['--effort', 'xhigh']);
});

test('runTask: fireAndForget surfaces boot error when child never reaches awaiting-input', async () => {
  const client = mockClient({
    streamWaitFor: () => { throw new Error('wait timed out after 30000ms (state=error)'); },
    streamGetState: [{ state: 'error' }],
    streamReadScreen: [{ text: 'cloudflare invalid_grant' }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'fire' }),
    fireAndForget: true,
  });
  assert.equal(r.schema, 'AceTaskRunResult/v1');
  assert.equal(r.outcome, 'error');
  assert.match(r.detail, /fire-and-forget delivery failed before ready/);
  assert.match(r.detail, /state=error/);
  assert.match(r.lastAssistantText, /invalid_grant/);
  assert.equal(r.telemetry.provider, 'codex');
  assert.equal(r.telemetry.roleMode, 'implementer');
  assert.equal(r.telemetry.taskType, 'generic');
  assert.equal(r.telemetry.skillPack, 'generic');
  assert.equal(typeof r.telemetry.renderedPromptChars, 'number');
  assert.equal(r.telemetry.skillCount, 5);
  assert.equal(r.telemetry.mcpMode, 'off');
  assert.equal(r.telemetry.baseRefreshMode, 'false');
  assert.equal(r.telemetry.readyMs, null);
  assert.equal(r.telemetry.promptMs, null);
  assert.equal(r.telemetry.firstOutputMs, null);
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ['streamWaitFor', 'streamGetState', 'streamReadScreen']);
});

test('runTask: fireAndForget falls back to send/submit when stale booting still shows Claude prompt', async () => {
  const claudeReadyScreen = [
    ' ▐▛███▜▌   Claude Code v2.1.132',
    '▝▜█████▛▘  Opus 4.7 (1M context) with high effort · Claude Max',
    '  ▘▘ ▝▝    ~/Projects/Ace',
    '',
    '────────────────────────────────────────────────────────',
    '❯ Try "create a util logging.py that..."',
    '────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  const client = mockClient({
    streamWaitFor: () => { throw new Error('wait timed out after 30000ms (state=booting)'); },
    streamGetState: [{ state: 'booting' }],
    streamReadScreen: [{ text: claudeReadyScreen }],
    streamSendSubmit: [{ ok: true, telemetry: { promptMs: 22 } }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    streamId: 'conversation:claude-stale',
    taskId: 'tsk_stale',
    spec: taskSpec({ goal: 'deliver despite stale booting' }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'dispatched');
  assert.equal(r.fireAndForget, true);
  assert.equal(r.readyFallback, 'visible-prompt-stale-booting');
  assert.match(r.detail, /stale-booting/);
  const methods = client.calls.map((c: any) => c.method);
  assert.deepEqual(methods, ['streamWaitFor', 'streamGetState', 'streamReadScreen', 'streamSendSubmit']);
  const sendCall = client.calls.find((c: any) => c.method === 'streamSendSubmit');
  assert.ok(sendCall.params.text.includes('# Goal'));
  assert.equal(sendCall.params.mode, 'paste');
});

test('runTask: fireAndForget keeps error path when stale booting screen has busy footer', async () => {
  const busyScreen = [
    '✻ Thinking…',
    '❯',
    '  esc to interrupt',
  ].join('\n');
  const client = mockClient({
    streamWaitFor: () => { throw new Error('wait timed out after 30000ms (state=booting)'); },
    streamGetState: [{ state: 'booting' }],
    streamReadScreen: [{ text: busyScreen }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    streamId: 'conversation:claude-busy',
    taskId: 'tsk_busy',
    spec: taskSpec({ goal: 'do not fallback while busy' }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'error');
  assert.match(r.detail, /fire-and-forget delivery failed before ready/);
  const methods = client.calls.map((c: any) => c.method);
  assert.deepEqual(methods, ['streamWaitFor', 'streamGetState', 'streamReadScreen']);
});

test('runTask: fireAndForget stale-booting fallback only triggers for Claude', async () => {
  const claudeReadyScreen = '❯ Try "anything"\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  const client = mockClient({
    streamWaitFor: () => { throw new Error('wait timed out after 30000ms (state=booting)'); },
    streamGetState: [{ state: 'booting' }],
    streamReadScreen: [{ text: claudeReadyScreen }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    streamId: 'conversation:codex-stale',
    taskId: 'tsk_stale_codex',
    spec: taskSpec({ goal: 'no fallback for codex' }),
    fireAndForget: true,
  });
  assert.equal(r.outcome, 'error');
  const methods = client.calls.map((c: any) => c.method);
  assert.deepEqual(methods, ['streamWaitFor', 'streamGetState', 'streamReadScreen']);
});

test('runTask: passes client-side deadline that outlives the server timeout', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  const serverTimeout = 10 * 60 * 1000;
  await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'anything' }),
    waitTimeoutMs: serverTimeout,
  });
  const askCall = client.calls.find((c) => c.method === 'streamAsk');
  assert.ok(askCall, 'expected streamAsk to be invoked');
  assert.equal(askCall.params.timeoutMs, serverTimeout);
  assert.ok(typeof askCall.clientTimeoutMs === 'number' && askCall.clientTimeoutMs > serverTimeout);
});

test('runTask: passes --mode through normal streamAsk delivery', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  await runTask(client, {
    streamId: 'conversation:a',
    spec: taskSpec({ goal: 'anything' }),
    mode: 'paste',
  });
  const askCall = client.calls.find((c) => c.method === 'streamAsk');
  assert.ok(askCall, 'expected streamAsk to be invoked');
  assert.equal(askCall.params.mode, 'paste');
});

test('runTask: spawn-adhoc path invokes streamSpawnAdhoc before streamAsk', async () => {
  const client = mockClient({
    streamSpawnAdhoc: [{ streamId: 'conversation:new', conversationId: 'new', taskId: 'thr_new' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    spec: taskSpec({ goal: 'x' }),
  });
  assert.equal(r.outcome, 'done');
  assert.equal(r.streamId, 'conversation:new');
  assert.equal(r.taskId, 'thr_new');
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ['streamSpawnAdhoc', 'streamAsk']);
  assert.match(client.calls[0].params.initialPrompt, /^# Goal\nx/m);
  assert.equal(client.calls[0].params.prompt, undefined);
});

test('runChat: executes a script of steps', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'hi back' },
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: finished' },
    ],
  });
  const r = await runChat(client, {
    streamId: 'conversation:a',
    script: [
      { text: 'hello' },
      { text: 'wrap it up', stopOn: 'done' },
    ],
  });
  assert.equal(r.turns.length, 2);
  assert.match(r.turns[0].newOutput, /hi back/);
  assert.match(r.turns[1].newOutput, /DONE: finished/);
});

test('ensureStream: newTask targets variant stream when variantId is returned', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_new',
      variantId: 'var_new',
      worktreePath: '/tmp/wt',
      branch: 'ace/add-hello-xxx',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_new', variantId: 'var_new' }],
  });
  const r = await ensureStream(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    goal: 'Add hello',
    label: 'test',
  });
  assert.equal(r.streamId, 'variant:var_new');
  assert.equal(r.taskId, 'tsk_new');
  assert.equal(r.worktreePath, '/tmp/wt');
  assert.equal(r.branch, 'ace/add-hello-xxx');
  assert.equal(r.baseRefreshMode, 'false');
  assert.equal(client.calls[0].params.refreshBase, 'false');
  assert.deepEqual(client.calls.map((c) => c.method), [
    'streamCreateDelegatedTask',
    'streamSpawnIntoVariant',
  ]);
  assert.equal(client.calls[1].params.agent, 'claude');
});

test('ensureStream: newTask uses variant worktree even when chat kind is requested', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_chat_validator',
      variantId: 'var_validator',
      worktreePath: '/tmp/wt',
      branch: 'ace/validate-x',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_validator', variantId: 'var_validator' }],
  });
  const r = await ensureStream(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    newTask: true,
    kind: 'chat',
    goal: 'Validate mission output',
    label: 'validator',
    taskType: 'validator',
  });
  assert.equal(r.streamId, 'variant:var_validator');
  assert.equal(r.taskId, 'tsk_chat_validator');
  assert.deepEqual(client.calls.map((c) => c.method), [
    'streamCreateDelegatedTask',
    'streamSpawnIntoVariant',
  ]);
  assert.equal(client.calls[1].params.agent, 'codex');
});

test('ensureStream: GoalAgent newTask refuses chat fallback when variant is missing', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_missing_variant',
      worktreePath: '/tmp/wt',
      branch: 'ace/validate-x',
      baseBranch: 'main',
    }],
  });
  await assert.rejects(
    () => ensureStream(client, {
      agent: 'codex',
      workspaceId: 'ws_1',
      newTask: true,
      kind: 'mission-board',
      goal: 'Validate mission output',
      label: 'validator',
      taskType: 'validator',
    }),
    /worktree-backed GoalAgent spawn requires/
  );
  assert.deepEqual(client.calls.map((c) => c.method), ['streamCreateDelegatedTask']);
});

test('ensureStream: newTask falls back to streamSpawn when variantId is missing', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_new',
      worktreePath: '/tmp/wt',
      branch: 'ace/add-hello-xxx',
      baseBranch: 'main',
    }],
    streamSpawn: [{ streamId: 'conversation:new', conversationId: 'cv_new' }],
  });
  const r = await ensureStream(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    goal: 'Add hello',
    label: 'test',
  });
  assert.equal(r.streamId, 'conversation:new');
  assert.equal(r.taskId, 'tsk_new');
  assert.deepEqual(client.calls.map((c) => c.method), [
    'streamCreateDelegatedTask',
    'streamSpawn',
  ]);
});

test('runTask: newTask delegation persists framed prompt for codex (TaskSpecPane source)', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_codex',
      variantId: 'var_codex',
      worktreePath: '/tmp/wt',
      branch: 'ace/codex-x',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_codex' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
    streamVerifyTaskProgress: [{ hasChanges: true, hasWorktree: true, baseBranch: 'main', branch: 'ace/codex-x', worktreePath: '/tmp/wt' }],
  });
  await runTask(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Make the codex tab visible',
      constraints: ['driver-agnostic'],
      deliverables: ['src/foo.ts: tweak'],
      acceptance: ['npm run lint passes'],
      goalMode: 'off',
    }),
  });
  const createCall = client.calls.find((c: any) => c.method === 'streamCreateDelegatedTask');
  assert.ok(createCall, 'streamCreateDelegatedTask must be invoked');
  const p = createCall.params.prompt;
  assert.ok(typeof p === 'string' && p.length > 0, 'prompt must be a non-empty string');
  assert.match(p, /^# Goal\nMake the codex tab visible/m);
  assert.match(p, /# Constraints\n- driver-agnostic/);
  assert.match(p, /# Deliverables\n- src\/foo\.ts: tweak/);
  assert.match(p, /# Acceptance\n- npm run lint passes/);
  const spawnCall = client.calls.find((c: any) => c.method === 'streamSpawnIntoVariant');
  assert.deepEqual(spawnCall.params.launchIntent.codexConfigOverrides, ['model_reasoning_effort="xhigh"']);
});

test('runTask: Codex app-parity profile reaches the actual stream launch intent', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_codex_app_parity',
      variantId: 'var_codex_app_parity',
      worktreePath: '/tmp/wt',
      branch: 'ace/codex-app-parity',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_codex_app_parity' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
    streamVerifyTaskProgress: [{ hasChanges: true, hasWorktree: true, baseBranch: 'main', branch: 'ace/codex-app-parity', worktreePath: '/tmp/wt' }],
  });
  await runTask(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Validate the app-parity runtime',
      codexRuntimeProfile: 'app-parity',
      toolOverrideReason: 'operator requested Codex app-parity runtime validation',
      goalMode: 'off',
    }),
  });
  const spawnCall = client.calls.find((c: any) => c.method === 'streamSpawnIntoVariant');
  assert.equal(spawnCall.params.launchIntent.codexRuntimeProfile, 'app-parity');
  assert.equal(spawnCall.params.launchIntent.appParityAuditReason, 'operator requested Codex app-parity runtime validation');
  assert.ok(spawnCall.params.launchIntent.codexConfigOverrides.includes('features.computer_use=true'));
});

test('runTask: newTask delegation surfaces worktreePath/branch in result', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [{
      taskId: 'tsk_new',
      variantId: 'var_new',
      worktreePath: '/tmp/wt',
      branch: 'ace/x',
      baseBranch: 'main',
    }],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_new', variantId: 'var_new' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
    streamVerifyTaskProgress: [{ hasChanges: true, hasWorktree: true, filesChanged: 1, linesAdded: 3, linesDeleted: 0, changedPaths: ['README.md'], baseBranch: 'main', branch: 'ace/x', worktreePath: '/tmp/wt' }],
  });
  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({ goal: 'Add something to README.md', deliverables: ['README.md updated'] }),
  });
  assert.equal(r.outcome, 'done');
  assert.equal(r.streamId, 'variant:var_new');
  assert.equal(r.worktreePath, '/tmp/wt');
  assert.equal(r.branch, 'ace/x');
  assert.equal(r.verify.hasChanges, true);
});

test('runTask: DONE with empty diff loops once then returns done-unverified', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'wrote a plan.\nDONE: planned' },
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'still just planning.\nDONE: still planned' },
    ],
    streamVerifyTaskProgress: [
      { hasChanges: false, hasWorktree: true, filesChanged: 0, linesAdded: 0, linesDeleted: 0, changedPaths: [], baseBranch: 'main' },
      { hasChanges: false, hasWorktree: true, filesChanged: 0, linesAdded: 0, linesDeleted: 0, changedPaths: [], baseBranch: 'main' },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_1',
    spec: taskSpec({ goal: 'Add hello to README.md', deliverables: ['README.md changed'], goalMode: 'off' }),
    requireChanges: true,
    maxVerifyRounds: 1,
    maxRounds: 1,
  });
  assert.equal(r.outcome, 'done-unverified');
  assert.equal(r.verifyRounds, 2);
  // Second ask prompt must include verifyFeedback.
  assert.ok(client.calls[2]);
  assert.match(client.calls[2].params.prompt, /Verification feedback/);
});

test('runTask: requireChanges=false skips verify even on DONE', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: explained' }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_1',
    spec: taskSpec({ goal: 'Explain the architecture' }),
    requireChanges: false,
  });
  assert.equal(r.outcome, 'done');
  // streamVerifyTaskProgress must NOT have been called.
  assert.ok(!client.calls.some((c) => c.method === 'streamVerifyTaskProgress'));
});

test('runTask: no-code role mode skips change verification for new task worktrees', async () => {
  const client = mockClient({
    streamCreateDelegatedTask: [
      { taskId: 'tsk_no_code', variantId: 'var_no_code', worktreePath: '/tmp/wt', branch: 'ace/no-code', baseBranch: 'main' },
    ],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_no_code', variantId: 'var_no_code' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: planned' }],
  });
  const r = await runTask(client, {
    agent: 'codex',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Plan the next rollout',
      role: 'viewer',
      roleMode: 'no-code',
      taskType: 'no-code',
      requireChanges: false,
    }),
  });
  assert.equal(r.outcome, 'done');
  assert.ok(!client.calls.some((c) => c.method === 'streamVerifyTaskProgress'));
  const ask = client.calls.find((c) => c.method === 'streamAsk');
  assert.match(ask.params.prompt, /no-code: produce analysis or planning output only/);
  assert.doesNotMatch(ask.params.prompt, /Verification feedback|edit\/create files/);
});

test('runTask: no-code role mode does not run post-DONE integration', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: planned' }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_no_code',
    spec: taskSpec({
      goal: 'Plan the rollout',
      roleMode: 'no-code',
      taskType: 'no-code',
      integrate: true,
      skills: ['ace-github-flow'],
    }),
  });
  assert.equal(r.outcome, 'done');
  assert.ok(!client.calls.some((c) => c.method.startsWith('integration')));
});

test('runTask: BLOCKED is not reverified', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'BLOCKED: missing X' }],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_1',
    spec: taskSpec({ goal: 'Do code thing', deliverables: ['src/foo.ts created'], goalMode: 'off' }),
    requireChanges: true,
  });
  assert.equal(r.outcome, 'blocked');
  assert.ok(!client.calls.some((c) => c.method === 'streamVerifyTaskProgress'));
});

test('runTask: "DONE: no-code <reason>" is accepted even when requireChanges=true', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'I only planned.\nDONE: drafted' },
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'Re-emitting.\nDONE: no-code research task, no files needed' },
    ],
    streamVerifyTaskProgress: [
      { hasChanges: false, hasWorktree: true, filesChanged: 0, linesAdded: 0, linesDeleted: 0, changedPaths: [], baseBranch: 'main' },
    ],
  });
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_1',
    spec: taskSpec({ goal: 'Research X', deliverables: ['a research summary'] }),
    requireChanges: true,
    maxVerifyRounds: 3,
  });
  assert.equal(r.outcome, 'done');
});

test('runTask: spec.integrate=true triggers push+openPr after DONE and updates registry', async () => {
  const prUrl = 'https://github.com/owner/repo/pull/77';
  const client = mockClient({
    streamCreateDelegatedTask: [
      { taskId: 'tsk_int', variantId: 'var_int', worktreePath: '/tmp/wt', branch: 'ace/int-x', baseBranch: 'main' },
    ],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_int', variantId: 'var_int' }],
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'wrote it.\nDONE: shipped' },
    ],
    streamVerifyTaskProgress: [
      { hasChanges: true, hasWorktree: true, filesChanged: 1, linesAdded: 3, linesDeleted: 0, changedPaths: ['README.md'], baseBranch: 'main' },
    ],
    integrationPush: [
      {
        ok: true,
        phase: 'success',
        action: 'push',
        params: { branch: 'ace/int-x' },
        result: { code: 0, attempts: 1, stdout: '', stderr: '' },
      },
    ],
    integrationOpenPr: [
      {
        ok: true,
        phase: 'success',
        action: 'openPr',
        params: {},
        result: { code: 0, attempts: 1, stdout: `${prUrl}\n`, stderr: '' },
      },
    ],
  });
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();

  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Add hello route',
      integrate: true,
      skills: ['ace-github-flow'],
      deliverables: ['src/route.ts'],
    }),
    childRegistry,
  });

  assert.equal(r.outcome, 'done');
  assert.equal(r.prNumber, 77);
  assert.equal(r.prUrl, prUrl);

  const methods = client.calls.map((c) => c.method);
  assert.ok(methods.includes('integrationPush'), 'expected integrationPush');
  assert.ok(methods.includes('integrationOpenPr'), 'expected integrationOpenPr');
  const pushCall = client.calls.find((c) => c.method === 'integrationPush');
  assert.equal(pushCall.params.taskId, 'tsk_int');
  assert.equal(pushCall.params.branch, 'ace/int-x');
  const prCall = client.calls.find((c) => c.method === 'integrationOpenPr');
  assert.equal(prCall.params.taskId, 'tsk_int');
  // Default is NON-draft: the merge gate hard-fails draft PRs and nothing in
  // the loop un-drafts, so the loop's PRs must open ready-for-merge.
  assert.equal(prCall.params.draft, false);

  const row = childRegistry.get('tsk_int');
  assert.equal(row.prNumber, 77);
  assert.equal(row.prUrl, prUrl);
  assert.equal(row.prState, 'open');
  assert.equal(row.branch, 'ace/int-x');
});

test('runTask: spec.integrate=true skips push+openPr when outcome is not done', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'BLOCKED: nope' }],
  });
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_block',
    spec: taskSpec({ goal: 'x', integrate: true, skills: ['ace-github-flow'] }),
    childRegistry,
  });
  assert.equal(r.outcome, 'blocked');
  const methods = client.calls.map((c) => c.method);
  assert.ok(!methods.includes('integrationPush'));
  assert.ok(!methods.includes('integrationOpenPr'));
  assert.equal(childRegistry.get('tsk_block'), null);
});

test('runTask: spec.integrate absent → no integration calls even on DONE', async () => {
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: ok' }],
  });
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_noint',
    spec: taskSpec({ goal: 'x' }),
    requireChanges: false,
    childRegistry,
  });
  assert.equal(r.outcome, 'done');
  const methods = client.calls.map((c) => c.method);
  assert.ok(!methods.includes('integrationPush'));
  assert.equal(r.prNumber, undefined);
  assert.equal(r.prUrl, undefined);
});

test('runTask: spec.integrate={merge:true} drives push → openPr → mergePr → postMergeCleanup in order', async () => {
  const prUrl = 'https://github.com/owner/repo/pull/91';
  const baseBranch = process.env.ACE_BASE_BRANCH || 'dev';
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  const client = mockClient({
    streamCreateDelegatedTask: [
      { taskId: 'tsk_auto', variantId: 'var_auto', worktreePath: '/tmp/wt', branch: 'ace/auto-x', baseBranch },
    ],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_auto', variantId: 'var_auto' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'shipped it.\nDONE: ok' }],
    streamVerifyTaskProgress: [
      { hasChanges: true, hasWorktree: true, filesChanged: 1, linesAdded: 3, linesDeleted: 0, changedPaths: ['README.md'], baseBranch: 'main' },
    ],
    integrationPush: [
      { ok: true, phase: 'success', action: 'push', params: {}, result: { code: 0, attempts: 1, stdout: '', stderr: '' } },
    ],
    integrationOpenPr: () => {
      childRegistry.updatePrState('tsk_auto', {
        baseBranch,
        checkState: 'success',
        mergeable: 'MERGEABLE',
        validation: { self: 'PASS', independent: null, fixback: null, highRisk: false },
      });
      return { ok: true, phase: 'success', action: 'openPr', params: {}, result: { code: 0, attempts: 1, stdout: `${prUrl}\n`, stderr: '' } };
    },
    integrationMergePr: [
      { ok: true, phase: 'success', action: 'mergePr', params: {}, result: { code: 0, attempts: 1, stdout: 'merged', stderr: '' } },
    ],
    integrationPostMergeCleanup: [
      { ok: true, archiveTask: { ok: true }, deleteRemoteBranch: { ok: true }, cleanup: { ok: true } },
    ],
  });

  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Auto-integrate this one',
      integrate: { merge: true },
      skills: ['ace-github-flow'],
      deliverables: ['README.md'],
    }),
    childRegistry,
  });

  assert.equal(r.outcome, 'done');
  const integrationMethods = client.calls
    .map((c: any) => c.method)
    .filter((m: any) => m.startsWith('integration'));
  assert.deepEqual(integrationMethods, [
    'integrationPush',
    'integrationOpenPr',
    'integrationMergePr',
    'integrationPostMergeCleanup',
  ]);
  const row = childRegistry.get('tsk_auto');
  assert.equal(row.prState, 'merged');
});

test('runTask: spec.integrate={merge:true} denies auto-merge when validation/check gates fail', async () => {
  const prUrl = 'https://github.com/owner/repo/pull/92';
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  const client = mockClient({
    streamCreateDelegatedTask: [
      { taskId: 'tsk_gate', variantId: 'var_gate', worktreePath: '/tmp/wt', branch: 'ace/gate-x', baseBranch: 'dev' },
    ],
    streamSpawnIntoVariant: [{ streamId: 'variant:var_gate', variantId: 'var_gate' }],
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'done\nDONE: ok' }],
    streamVerifyTaskProgress: [
      { hasChanges: true, hasWorktree: true, filesChanged: 1, linesAdded: 3, linesDeleted: 0, changedPaths: ['README.md'], baseBranch: 'dev' },
    ],
    integrationPush: [
      { ok: true, phase: 'success', action: 'push', params: {}, result: { code: 0, attempts: 1, stdout: '', stderr: '' } },
    ],
    integrationOpenPr: [
      { ok: true, phase: 'success', action: 'openPr', params: {}, result: { code: 0, attempts: 1, stdout: `${prUrl}\n`, stderr: '' } },
    ],
  });

  const r = await runTask(client, {
    agent: 'claude',
    workspaceId: 'ws_1',
    newTask: true,
    spec: taskSpec({
      goal: 'Auto-integrate this one',
      baseBranch: 'dev',
      integrate: { merge: true },
      skills: ['ace-github-flow'],
      deliverables: ['README.md'],
    }),
    childRegistry,
  });

  assert.equal(r.outcome, 'done');
  assert.match(r.detail, /integration mergePr blocked by gate/);
  const methods = client.calls.map((c: any) => c.method);
  assert.ok(!methods.includes('integrationMergePr'));
  const row = childRegistry.get('tsk_gate');
  assert.equal(row.prState, 'merge-blocked');
  assert.ok(row.mergeGate);
  assert.ok(row.mergeGate.failures.some((failure: any) => failure.code === 'checks_not_green'));
  assert.ok(!row.mergeGate.failures.some((failure: any) => failure.code === 'validation_missing'));
});

test('runTask: low-risk merge defaults to controller self-review without spawned validator', async () => {
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  childRegistry.register({
    taskId: 'tsk_low_risk',
    workspaceId: 'ws_1',
    branch: 'ace/low-risk',
    baseBranch: 'dev',
    worktreePath: '/tmp/wt-low-risk',
  });
  childRegistry.updatePrState('tsk_low_risk', {
    prNumber: 17,
    prState: 'open',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: null, independent: null, fixback: null, highRisk: false },
  });
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: reviewed by controller' }],
    integrationMergePr: [
      {
        ok: true,
        phase: 'success',
        action: 'mergePr',
        params: { prNumber: 17 },
        result: { code: 0, attempts: 1, stdout: 'merged', stderr: '' },
      },
    ],
    integrationPostMergeCleanup: [
      { ok: true, phase: 'success', action: 'cleanup', params: {}, result: { code: 0, stdout: '', stderr: '' } },
    ],
  });

  const r = await runTask(client, {
    agent: 'claude',
    streamId: 'conversation:low-risk',
    taskId: 'tsk_low_risk',
    workspaceId: 'ws_1',
    spec: taskSpec({
      goal: 'Merge low-risk bugfix',
      baseBranch: 'dev',
      integrate: { push: false, openPr: false, merge: { prNumber: 17 } },
      skills: ['ace-github-flow'],
    }),
    childRegistry,
  });

  assert.equal(r.outcome, 'done');
  assert.deepEqual(client.calls.map((c: any) => c.method), [
    'streamAsk',
    'integrationMergePr',
    'integrationPostMergeCleanup',
  ]);
  const mergeCall = client.calls.find((c: any) => c.method === 'integrationMergePr');
  assert.equal(mergeCall.params.gate.validationRequired, false);
  const row = childRegistry.get('tsk_low_risk');
  assert.equal(row.prState, 'merged');
});

test('runTask: merge success falls back to integrationPostMergeCleanup when merge result omits it', async () => {
  const { createChildRegistry } = require('../child-registry.cjs');
  const childRegistry = createChildRegistry();
  childRegistry.register({
    taskId: 'tsk_merge',
    workspaceId: 'ws_1',
    branch: 'ace/merge-x',
    baseBranch: 'dev',
    worktreePath: '/tmp/wt-merge',
  });
  childRegistry.updatePrState('tsk_merge', {
    prNumber: 17,
    prState: 'open',
    checkState: 'success',
    mergeable: 'MERGEABLE',
    validation: { self: 'PASS', independent: null, fixback: null, highRisk: false },
  });
  const client = mockClient({
    streamAsk: [{ ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: merged' }],
    integrationMergePr: [
      {
        ok: true,
        phase: 'success',
        action: 'mergePr',
        params: { prNumber: 17 },
        result: { code: 0, attempts: 1, stdout: 'merged', stderr: '' },
      },
    ],
    integrationPostMergeCleanup: [
      {
        ok: true,
        archiveTask: { ok: true },
        deleteRemoteBranch: { ok: true },
        cleanup: { ok: true },
      },
    ],
  });

  const r = await runTask(client, {
    streamId: 'conversation:a',
    taskId: 'tsk_merge',
    spec: taskSpec({
      goal: 'Merge the existing PR',
      integrate: {
        push: false,
        openPr: false,
        merge: { prNumber: 17, method: 'squash' },
      },
      skills: ['ace-github-flow'],
    }),
    requireChanges: false,
    childRegistry,
  });

  assert.equal(r.outcome, 'done');
  const methods = client.calls.map((c) => c.method);
  assert.ok(methods.includes('integrationMergePr'));
  assert.ok(methods.includes('integrationPostMergeCleanup'));
});

test('runChat: stops early when stopOn:done matches', async () => {
  const client = mockClient({
    streamAsk: [
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'DONE: early' },
      { ok: true, endState: 'turn-complete', elapsedMs: 1, newOutput: 'should not be reached' },
    ],
  });
  const r = await runChat(client, {
    streamId: 'conversation:a',
    script: [
      { text: 'go', stopOn: 'done' },
      { text: 'more' },
    ],
  });
  assert.equal(r.turns.length, 1);
});

test('buildLaunchIntent: codexModel pins the CLI model ahead of the effort override (codex only)', () => {
  const intent = buildLaunchIntent('codex', { effort: 'high', codexModel: 'gpt-5.6-sol' });
  assert.deepEqual(intent.codexConfigOverrides, [
    'model="gpt-5.6-sol"',
    'model_reasoning_effort="high"',
  ]);
  // No pin ⇒ overrides are unchanged (the user's config.toml model applies).
  assert.deepEqual(
    buildLaunchIntent('codex', { effort: 'high' }).codexConfigOverrides,
    ['model_reasoning_effort="high"'],
  );
  // Claude has no codex config channel — the pin must not leak across drivers.
  const claude = buildLaunchIntent('claude', { effort: 'xhigh', codexModel: 'gpt-5.6-sol' });
  assert.equal(claude.provider, 'claude');
  assert.equal('codexConfigOverrides' in claude, false);
});
