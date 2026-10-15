// loop-cli tests — the PURE helpers behind the `ace loop` command group
// (parse --input, the exit-code contract, renderers) plus the command-registry
// wiring. node:test + node:assert/strict, requiring the .cts SOURCE first so it
// validates live edits under the tsx runner (the .cjs is a lagging build artifact).

const test = require('node:test');
const assert = require('node:assert/strict');

let loopCli;
try {
  loopCli = require('../loop-cli.cts');
} catch {
  loopCli = require('../loop-cli.cjs');
}
const {
  parseInputPairs,
  loopRunExitCode,
  isTerminalFinishReason,
  renderLoopList,
  renderLoopShow,
  renderForge,
  renderLoopRun,
  renderLoopStatus,
} = loopCli;

let commandsMod;
try {
  commandsMod = require('../commands.cts');
} catch {
  commandsMod = require('../commands.cjs');
}
const { getCommand, COMMANDS } = commandsMod;

// ---------------------------------------------------------------------------
// parseInputPairs
// ---------------------------------------------------------------------------

test('parseInputPairs splits key=value pairs on the FIRST = and keeps later =', () => {
  assert.deepEqual(parseInputPairs(['feature=settings panel', 'k=v=w']), {
    feature: 'settings panel',
    k: 'v=w',
  });
});

test('parseInputPairs maps a bare key to true and skips blanks / non-strings', () => {
  assert.deepEqual(parseInputPairs(['flagOnly', '', '  ', 42, null, 'a=1']), { flagOnly: true, a: '1' });
});

test('parseInputPairs on a non-array is an empty object', () => {
  assert.deepEqual(parseInputPairs(undefined), {});
  assert.deepEqual(parseInputPairs('a=1'), {});
});

// ---------------------------------------------------------------------------
// loopRunExitCode + isTerminalFinishReason
// ---------------------------------------------------------------------------

test('loopRunExitCode honors the WS-F contract: 0 converged, 2 no-progress/cap-hit, 3 blocked', () => {
  assert.equal(loopRunExitCode('converged'), 0);
  assert.equal(loopRunExitCode('system'), 0);
  assert.equal(loopRunExitCode('no-progress'), 2);
  assert.equal(loopRunExitCode('cap-hit'), 2);
  assert.equal(loopRunExitCode('hard-cap'), 2);
  assert.equal(loopRunExitCode('killed'), 2);
  assert.equal(loopRunExitCode('blocked'), 3);
  // Anything unforeseen is a safe non-zero (spec-not-found / error are handled by
  // the CLI as die() BEFORE this is consulted).
  assert.equal(loopRunExitCode('whatever'), 2);
});

test('isTerminalFinishReason recognizes the loop-host terminals only', () => {
  for (const r of ['converged', 'no-progress', 'cap-hit', 'blocked', 'hard-cap', 'killed', 'spec-not-found', 'system', 'error']) {
    assert.equal(isTerminalFinishReason(r), true, `${r} should be terminal`);
  }
  assert.equal(isTerminalFinishReason('continue'), false);
  assert.equal(isTerminalFinishReason('running'), false);
});

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

test('renderLoopList prints a header + one row per loop with builtin/triggers columns', () => {
  const out = renderLoopList([
    { id: 'loop-ci-harden', kind: 'code', name: 'CI Harden', builtin: false, triggers: [] },
    { id: 'sys-ops-brief', kind: 'system', name: 'Ops Brief', builtin: true, triggers: [{ kind: 'schedule', enabled: true }] },
  ]);
  assert.match(out, /ID\s+KIND\s+NAME\s+BUILTIN\s+TRIGGERS/);
  assert.match(out, /loop-ci-harden/);
  assert.match(out, /sys-ops-brief/);
  assert.match(out, /1 \(schedule\)/);
  assert.equal(renderLoopList([]), 'No loops in the catalog.');
});

test('renderLoopShow surfaces the contract (stop / verify / permissions / owner-gated merge)', () => {
  const out = renderLoopShow({
    id: 'loop-validate-park',
    name: 'Validate & Park',
    kind: 'code',
    description: 'builder→validator',
    useWhen: 'when building',
    goalTemplate: 'iteration {{iteration}}',
    routing: { agent: 'auto', skills: ['ace-agent-pack-engineer'], workspace: 'loops', target: { repo: '.', allow: ['**'] } },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
  });
  assert.match(out, /loop-validate-park/);
  assert.match(out, /stop:\s+converged/);
  assert.match(out, /validatorPass=true/);
  assert.match(out, /permissions: \(none\)/);
  assert.match(out, /ownerGated=true.*parks/);
  assert.match(out, /ceilings:\s+\(unset\)/);
});

test('renderForge shows OK/FAILED validation and the saved id', () => {
  const okSaved = renderForge(
    { draft: { id: 'x', name: 'X', kind: 'agentic' }, notes: ['inferred agentic'] },
    { spec: { id: 'x' } },
    { id: 'x' },
  );
  assert.match(okSaved, /Validation: OK/);
  assert.match(okSaved, /Saved to the catalog as 'x'/);

  const failed = renderForge({ draft: { name: 'Y' }, notes: [] }, { errors: ['missing required field: goalTemplate'] });
  assert.match(failed, /Validation: FAILED/);
  assert.match(failed, /missing required field: goalTemplate/);
});

test('renderLoopRun lists iteration transitions in watch mode and always a final line', () => {
  const result = {
    finishReason: 'converged',
    reasonDetail: 'validator passed',
    latestRunOutcome: 'READY_FOR_REVIEW',
    iterations: [
      { index: 0, runId: 'run-1', classification: 'continue', reason: 'building' },
      { index: 1, runId: 'run-2', classification: 'converged', reason: 'passed' },
    ],
  };
  const watched = renderLoopRun(result, { watch: true });
  assert.match(watched, /\[0\] run-1 continue/);
  assert.match(watched, /\[1\] run-2 converged/);
  assert.match(watched, /converged: validator passed \(outcome: READY_FOR_REVIEW\) \[2 iteration\(s\)\]/);

  const compact = renderLoopRun(result, { watch: false });
  assert.equal(/run-1/.test(compact), false, 'compact mode omits per-iteration lines');
  assert.match(compact, /converged/);
});

test('renderLoopStatus prints gauges plus per-loop lineage summaries', () => {
  const single = renderLoopStatus(
    { active: ['loopinv-a-1'], inFlight: 1, lineage: { loopId: 'a', iterationCount: 3, lastProgressAt: 2, latestRunOutcome: 'DONE', totalTokens: 42 } },
    'a',
  );
  assert.match(single, /active: 1\s+inFlight: 1/);
  assert.match(single, /a: iterations=3 lastProgressAt=2 outcome=DONE tokens=42/);

  const many = renderLoopStatus({ active: [], inFlight: 0, lineages: { a: { iterationCount: 1 }, b: { iterationCount: 2 } } });
  assert.match(many, /lineages:/);
  assert.match(many, /a: iterations=1/);
  assert.match(many, /b: iterations=2/);
});

// ---------------------------------------------------------------------------
// command registry wiring
// ---------------------------------------------------------------------------

test('all six loop commands are registered with special: handlers', () => {
  const expected: Record<string, string> = {
    'loop list': 'special:loopList',
    'loop show': 'special:loopShow',
    'loop forge': 'special:loopForge',
    'loop run': 'special:loopRun',
    'loop status': 'special:loopStatus',
    'loop stop': 'special:loopStop',
  };
  for (const [cli, ipcMethod] of Object.entries(expected)) {
    const cmd = getCommand(cli);
    assert.ok(cmd, `${cli} not registered`);
    assert.equal(cmd.ipcMethod, ipcMethod, `${cli} wrong ipcMethod`);
  }
});

test('loop run exposes --input (repeated) + --watch and documents its exit contract', () => {
  const cmd = getCommand('loop run');
  const input = cmd.flags.find((f) => f.name === '--input');
  assert.ok(input, 'loop run must expose --input');
  assert.equal(input.type, 'string-repeated');
  assert.ok(cmd.flags.some((f) => f.name === '--watch'), 'loop run must expose --watch');
  assert.equal(cmd.positionals[0].name, 'id');
  assert.equal(cmd.positionals[0].required, true);
  assert.match(cmd.description, /Exit 0 ONLY when the loop CONVERGED/i);
});

test('loop forge exposes --save and takes a required description positional', () => {
  const cmd = getCommand('loop forge');
  assert.ok(cmd.flags.some((f) => f.name === '--save'));
  assert.equal(cmd.positionals[0].name, 'description');
  assert.equal(cmd.positionals[0].required, true);
});

test('loop status positional is optional; loop show/stop are required', () => {
  assert.equal(getCommand('loop status').positionals[0].required, false);
  assert.equal(getCommand('loop show').positionals[0].required, true);
  assert.equal(getCommand('loop stop').positionals[0].required, true);
});

test('the loop command group is grouped together in the registry', () => {
  const loopCommands = COMMANDS.filter((c) => c.cli.startsWith('loop ')).map((c) => c.cli);
  assert.deepEqual(loopCommands, ['loop list', 'loop show', 'loop forge', 'loop run', 'loop status', 'loop stop']);
});
