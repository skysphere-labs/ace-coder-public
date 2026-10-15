const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
// Require the .cts SOURCE first (the .cjs is a build artifact that lags edits under
// the tsx test runner); fall back to the compiled .cjs when only that is present.
let commandsMod: any;
try {
  commandsMod = require('../commands.cts');
} catch {
  commandsMod = require('../commands.cjs');
}
const { COMMANDS, EXIT_CODES, getCommand, allCommands } = commandsMod;
const pkg = require('../../package.json');

// Hard-coded list — if someone deletes or renames a command, this test
// catches the regression with a clear failure pointing at the missing slug.
const EXPECTED_CLI_NAMES = [
  'ls',
  'screen',
  'state',
  'ask',
  'send',
  'keys',
  'submit',
  'composer clear',
  'abort',
  'wait',
  'slash',
  'ref',
  'approve',
  'interrupt',
  'spawn',
  'spawn-adhoc',
  'orchestrator start',
  'workspace create',
  'workspace base-branch',
  'doctor workspace',
  'control-plane status',
  'ops status',
  'perf health',
  'github tracked-projects',
  'close',
  'rename',
  'record',
  'record-stop',
  'replay',
  'follow',
  'snapshot',
  'watch',
  'completion list',
  'completion ack',
  'profiles',
  'reload',
  'browser',
  'mcp-browser',
  'mcp-core',
  'goal launch',
  'task run',
  'task chat',
  'relay',
  'context',
  'run board',
  'run submit',
  'run loop',
  'run archive',
  'run closeout',
  'run followup',
  'loop list',
  'loop show',
  'loop forge',
  'loop run',
  'loop status',
  'loop stop',
  'smoke fast-lifecycle',
  'integrate context-import',
  'integrate push',
  'integrate pr-open',
  'integrate gate',
  'integrate pr-merge',
  'integrate cleanup',
  'supervise',
  'project init-harness',
  'task result',
  'task validate',
  'feature list',
  'wave list',
  'run list',
  'feature mark',
  'memory candidates',
  'memory search',
  'memory get',
  'memory remember',
  'memory reindex',
  'memory eval',
  'knowledge migrate',
  'memory explain',
  'memory status',
  'wiki update',
  'wiki dump',
  'wiki candidates',
  'wiki generate',
  'wiki nightly',
  'wiki pack',
  'wiki audit',
  'wiki backfill',
  'wiki writeback',
  'wiki curate-events',
  'wiki inbox',
  'wiki promote',
  'wiki health',
  'event emit',
  'tool manifest',
  'tool heartbeat',
  'tool audit',
  'tool batch',
  'validation clawpatch',
  'version',
  'describe',
];

test('allCommands() returns at least 25 entries', () => {
  const all = allCommands();
  assert.ok(all.length >= 25, `expected >=25 commands, got ${all.length}`);
});

test('every command has a non-empty description', () => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.description, 'string', `${c.cli}: description not a string`);
    assert.ok(c.description.length > 0, `${c.cli}: empty description`);
  }
});

test('every command has at minimum exit codes 0 and 2', () => {
  for (const c of COMMANDS) {
    assert.equal(c.exitCodes[0], 'ok', `${c.cli}: missing exit code 0`);
    assert.equal(c.exitCodes[2], 'arg-error', `${c.cli}: missing exit code 2`);
  }
});

test('describe command exists and points at special:describe', () => {
  const d = getCommand('describe');
  assert.ok(d, 'describe command not registered');
  assert.equal(d.ipcMethod, 'special:describe');
});

test('package exposes ace as the only CLI binary', () => {
  assert.equal(pkg.name, 'ace');
  assert.equal(pkg.bin.ace, './bin/ace');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['ace']);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'bin', 'ace')));
});

test('no command carries an mcpName field — MCP layer was ripped', () => {
  for (const c of COMMANDS) {
    assert.equal(
      'mcpName' in c,
      false,
      `${c.cli}: mcpName must not be present (MCP path is gone)`
    );
  }
});

test('snapshot: command count and cli names match expected list', () => {
  const actual = COMMANDS.map((c: any) => c.cli);
  assert.deepEqual(actual, EXPECTED_CLI_NAMES, 'command set drifted');
  assert.equal(COMMANDS.length, EXPECTED_CLI_NAMES.length);
});

test('run-ledger commands are registered', () => {
  const runCommands = COMMANDS
    .filter((c: any) => c.cli.startsWith('run '))
    .map((c: any) => c.cli);
  assert.deepEqual(runCommands, ['run board', 'run submit', 'run loop', 'run archive', 'run closeout', 'run followup', 'run list']);
  assert.equal(getCommand('run board')?.ipcMethod, 'runBoard');
  assert.equal(getCommand('run submit')?.ipcMethod, 'runSubmit');
  assert.equal(getCommand('run loop')?.ipcMethod, 'runLoopStop');
  assert.equal(getCommand('run archive')?.ipcMethod, 'runArchive');
  assert.equal(getCommand('run closeout')?.ipcMethod, 'special:runCloseout');
  assert.equal(getCommand('run followup')?.ipcMethod, 'special:runFollowup');
});

test('run archive is registered with its selectors and safe-preview flag', () => {
  const cmd = getCommand('run archive');
  assert.ok(cmd, 'run archive command not registered');
  assert.equal(cmd.ipcMethod, 'runArchive');
  for (const name of ['--run', '--terminal', '--older-than', '--dry-run']) {
    assert.ok(cmd.flags.some((flag: any) => flag.name === name), `${name} flag missing`);
  }
  assert.equal(cmd.flags.find((flag: any) => flag.name === '--run')?.type, 'string-repeated');
  assert.match(cmd.description, /events-archive\.ndjson/);
  assert.match(cmd.description, /dead/i);
  for (const field of ['archived', 'remaining', 'runIds', 'byReason']) {
    assert.ok(cmd.outputShape.properties[field], `${field} output field missing`);
  }
});

test('run closeout documents dry-run and gateway-mediated mutations', () => {
  const cmd = getCommand('run closeout');
  assert.ok(cmd, 'run closeout command not registered');
  assert.match(cmd.description, /exact-head validation/i);
  assert.match(cmd.description, /CI watch/i);
  assert.match(cmd.description, /read-only integration gate/i);
  assert.match(cmd.description, /Defaults to no merge/i);
  assert.ok(cmd.flags.some((flag: any) => flag.name === '--dry-run'));
  assert.ok(cmd.flags.some((flag: any) => flag.name === '--merge'));
  assert.ok(cmd.flags.some((flag: any) => flag.name === '--owner-token'));
});

test('run followup documents stable JSON lifecycle packet and gateway-only automation', () => {
  const cmd = getCommand('run followup');
  assert.ok(cmd, 'run followup command not registered');
  assert.match(cmd.description, /worker DONE\/BLOCKED/i);
  assert.match(cmd.description, /integration gateway/i);
  assert.match(cmd.description, /merge-or-park fail-closed/i);
  for (const name of ['--run', '--task', '--pr', '--auto', '--watch', '--interval-ms', '--allow-path']) {
    assert.ok(cmd.flags.some((flag: any) => flag.name === name), `${name} flag missing`);
  }
  for (const field of ['status', 'runId', 'taskId', 'streamId', 'validator', 'pr', 'evidence', 'nextAction', 'safeNextCommand']) {
    assert.ok(cmd.outputShape.properties[field], `${field} output field missing`);
  }
});

test('perf health exposes the read-only performance report command', () => {
  const cmd = getCommand('perf health');
  assert.ok(cmd, 'perf health command not registered');
  assert.equal(cmd.ipcMethod, 'perfHealth');
  assert.equal(cmd.flags.length, 0);
  assert.match(cmd.description, /ace\.perf-health\/v1/);
});

test('browser command group is registered as task-scoped browser control', () => {
  const browser = getCommand('browser');
  assert.ok(browser, 'browser command not registered');
  assert.equal(browser.ipcMethod, 'special:browser');
  assert.ok(browser.flags.some((f: any) => f.name === '--task' && f.required === false));
  assert.ok(browser.description.includes('task-scoped'));

  const mcpBrowser = getCommand('mcp-browser');
  assert.ok(mcpBrowser, 'mcp-browser command not registered');
  assert.equal(mcpBrowser.ipcMethod, 'special:mcpBrowser');
});

test('integrate pr-merge documents task-matched PR adoption', () => {
  const cmd = getCommand('integrate pr-merge');
  assert.ok(cmd, 'integrate pr-merge command not registered');
  assert.match(cmd.description, /adopt an untracked PR/i);
  assert.match(cmd.description, /head\/base match the task branch\/base/i);
});

test('integrate pr-merge documents Ace-managed auto merge', () => {
  const cmd = getCommand('integrate pr-merge');
  assert.ok(cmd, 'integrate pr-merge command not registered');
  const autoFlag = cmd.flags.find((flag: any) => flag.name === '--auto');
  assert.ok(autoFlag, '--auto flag must be documented');
  assert.match(autoFlag.description, /wait for checks/i);
  assert.match(autoFlag.description, /conflicts/i);
  assert.match(autoFlag.description, /admin merge/i);
  assert.match(autoFlag.description, /verify MERGED\/base evidence/i);
  assert.match(cmd.outputShape.description, /phase=pending/i);
  assert.match(cmd.outputShape.description, /mergeVerification evidence/i);
});

test('integrate gate documents read-only no-mutation evidence', () => {
  const cmd = getCommand('integrate gate');
  assert.ok(cmd, 'integrate gate command not registered');
  assert.equal(cmd.ipcMethod, 'integrationGate');
  assert.match(cmd.description, /Read-only PR integration gate/i);
  assert.match(cmd.description, /without merging or cleanup/i);
});

test('integrate context-import requires every identity flag and no defaults', () => {
  const cmd = getCommand('integrate context-import');
  assert.ok(cmd, 'integrate context-import command not registered');
  assert.equal(cmd.ipcMethod, 'integrationContextImport');
  const required = cmd.flags
    .filter((flag: any) => flag.required)
    .map((flag: any) => flag.name);
  assert.deepEqual(required, [
    '--workspace',
    '--repo',
    '--worktree',
    '--branch',
    '--head-sha',
    '--base-branch',
    '--base-sha',
    '--allow-path',
    '--request-id',
  ]);
  assert.equal(cmd.flags.find((flag: any) => flag.name === '--allow-path').type, 'string-repeated');
  assert.equal(cmd.flags.find((flag: any) => flag.name === '--preview').default, undefined);
  assert.equal(cmd.flags.find((flag: any) => flag.name === '--apply').default, undefined);
});

test('integrate pr-open, gate, and pr-merge expose repeated allowed path flags', () => {
  for (const cli of ['integrate pr-open', 'integrate gate', 'integrate pr-merge']) {
    const cmd = getCommand(cli);
    assert.ok(cmd, `${cli} command not registered`);
    const allowPath = cmd.flags.find((flag: any) => flag.name === '--allow-path');
    assert.ok(allowPath, `${cli} must expose --allow-path`);
    assert.equal(allowPath.type, 'string-repeated');
  }
});

test('run submit exposes repeated acceptance and allowed path flags', () => {
  const cmd = getCommand('run submit');
  assert.ok(cmd, 'run submit command not registered');
  const allow = cmd.flags.find((flag: any) => flag.name === '--allow');
  assert.ok(allow, 'run submit must expose --allow');
  assert.equal(allow.type, 'string-repeated');
  const acceptance = cmd.flags.find((flag: any) => flag.name === '--acceptance');
  assert.ok(acceptance, 'run submit must expose --acceptance');
  assert.equal(acceptance.type, 'string-repeated');
});

test('workspace base-branch exposes remote-base set and clear flags', () => {
  const cmd = getCommand('workspace base-branch');
  assert.ok(cmd, 'workspace base-branch command not registered');
  const flagNames = cmd.flags.map((flag: any) => flag.name);
  assert.ok(flagNames.includes('--set'));
  assert.ok(flagNames.includes('--clear'));
  assert.ok(flagNames.includes('--unset'));
  assert.match(cmd.examples.map((example: any) => example.cmd).join('\n'), /--set origin\/main/);
});

test('EXIT_CODES is the canonical map and includes 0..5 plus 6 and 7', () => {
  for (const code of [0, 2, 3, 4, 5, 6, 7]) {
    assert.equal(typeof EXIT_CODES[code], 'string', `EXIT_CODES missing ${code}`);
  }
});

test('every flag has a name and a known type', () => {
  const okTypes = new Set(['string', 'number', 'boolean', 'string-repeated']);
  for (const c of COMMANDS) {
    for (const f of c.flags || []) {
      assert.ok(typeof f.name === 'string' && f.name.startsWith('-'), `${c.cli}: flag name shape`);
      assert.ok(okTypes.has(f.type), `${c.cli} ${f.name}: unknown type ${f.type}`);
      assert.ok('required' in f, `${c.cli} ${f.name}: missing required field`);
    }
  }
});

test('every command has at least one example', () => {
  for (const c of COMMANDS) {
    assert.ok(Array.isArray(c.examples) && c.examples.length >= 1, `${c.cli}: needs an example`);
    for (const ex of c.examples) {
      assert.ok(ex.cmd && typeof ex.cmd === 'string', `${c.cli}: example missing cmd`);
    }
  }
});

test('getCommand returns null for unknown cli', () => {
  assert.equal(getCommand('does-not-exist'), null);
});
