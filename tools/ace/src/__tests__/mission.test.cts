const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMANDS, getCommand } = require('../commands.cjs');

const ARCHIVED_MISSION_COMMANDS = [
  'mission ls',
  'mission get',
  'mission validators-list',
  'mission validators-add',
  'mission validators-set-verdict',
  'mission validators-remove',
  'mission attachments-list',
  'mission attachments-add',
  'mission attachments-remove',
  'mission pr-links-list',
  'mission pr-links-add',
  'mission pr-links-set-status',
];

test('native mission board commands are registered', () => {
  assert.deepEqual(
    COMMANDS.filter((c: any) => c.cli.startsWith('mission ')).map((c: any) => c.cli),
    ['mission create', 'mission record-release', 'mission approve-ship', 'mission set-auto-chain', 'mission board', 'mission archive', 'mission ready', 'mission checkpoint', 'mission resume', 'mission dispatch', 'mission wave-dispatch', 'mission sync', 'mission validate', 'mission link-pr', 'mission fixback', 'mission gate', 'mission next', 'mission record-cleanup', 'mission attach-validator', 'mission release-gate']
  );
  assert.equal(getCommand('mission create')?.ipcMethod, 'missionCreate');
  assert.equal(getCommand('mission board')?.ipcMethod, 'missionBoard');
  assert.equal(getCommand('mission archive')?.ipcMethod, 'missionArchive');
  assert.equal(getCommand('mission ready')?.ipcMethod, 'missionBoard');
  assert.equal(getCommand('mission checkpoint')?.ipcMethod, 'missionCheckpoint');
  assert.equal(getCommand('mission resume')?.ipcMethod, 'missionResume');
  assert.equal(getCommand('mission dispatch')?.ipcMethod, 'special:missionDispatch');
  assert.equal(getCommand('mission wave-dispatch')?.ipcMethod, 'special:missionWaveDispatch');
  assert.ok(getCommand('mission wave-dispatch')?.flags.some((f: any) => f.name === '--explicit-wave'));
  assert.equal(getCommand('mission sync')?.ipcMethod, 'special:missionSync');
  assert.equal(getCommand('mission validate')?.ipcMethod, 'special:missionValidate');
  assert.equal(getCommand('mission link-pr')?.ipcMethod, 'missionLinkPr');
  assert.equal(getCommand('mission fixback')?.ipcMethod, 'missionFixback');
  assert.equal(getCommand('mission gate')?.ipcMethod, 'special:missionGate');
  assert.equal(getCommand('mission next')?.ipcMethod, 'missionNextAction');
  assert.equal(getCommand('mission record-cleanup')?.ipcMethod, 'missionRecordCleanup');
  assert.equal(getCommand('mission attach-validator')?.ipcMethod, 'missionAttachValidatorEvidence');
  assert.equal(getCommand('mission release-gate')?.ipcMethod, 'missionReleaseGate');
  const validateFlags = getCommand('mission validate')?.flags.map((f: any) => f.name) || [];
  assert.ok(validateFlags.includes('--agent'));
  assert.ok(validateFlags.includes('--head'));
  assert.ok(validateFlags.includes('--base-sha'));
  assert.ok(validateFlags.includes('--replace-stale-validator'));
  for (const cli of ARCHIVED_MISSION_COMMANDS) {
    assert.equal(getCommand(cli), null, `${cli} should be archived`);
  }
});

test('validation clawpatch exposes bounded report semantics', () => {
  const cmd = getCommand('validation clawpatch');
  assert.ok(cmd, 'validation clawpatch must be registered');
  const flagNames = cmd.flags.map((f: any) => f.name);
  assert.ok(flagNames.includes('--report'));
  assert.ok(flagNames.includes('--timeout-ms'));
  assert.ok(flagNames.includes('--workspace'));
  assert.ok(flagNames.includes('--required'));
  assert.ok(flagNames.includes('--risk-class'));
  assert.ok(flagNames.includes('--no-code'));
});

test('fast lifecycle smoke and composer clear commands are registered', () => {
  assert.equal(getCommand('smoke fast-lifecycle')?.ipcMethod, 'special:smokeFastLifecycle');
  assert.equal(getCommand('composer clear')?.ipcMethod, 'streamClearComposer');
});

test('integrate pr-merge exposes policy-aware merge modes', () => {
  const cmd = getCommand('integrate pr-merge');
  const flagNames = cmd.flags.map((f: any) => f.name);
  assert.ok(flagNames.includes('--auto'));
  assert.ok(flagNames.includes('--admin'));
  assert.ok(flagNames.includes('--admin-reason'));
});

test('kanban materialize command is registered with conflict exits and surface', () => {
  const cmd = getCommand('kanban materialize');
  const obsoleteKanbanRead = ['ace-kanban', 'read'].join(' ');
  assert.ok(cmd, 'kanban materialize must be registered');
  assert.equal(cmd.ipcMethod, 'special:kanbanMaterialize');
  assert.equal(cmd.exitCodes['7'], 'conflict');
  const flagNames = cmd.flags.map((f: any) => f.name);
  assert.ok(flagNames.includes('--workspace'));
  assert.ok(flagNames.includes('--input'));
  assert.ok(flagNames.includes('--json-text'));
  assert.equal(cmd.outputShape.properties.source.type, 'string');
  assert.ok(cmd.outputShape.properties.kanbanTaskId);
  assert.ok(
    cmd.examples.some((example: any) => example.cmd.includes('ace-kanban show --json')),
    'kanban materialize examples must match current ace-kanban show command'
  );
  assert.equal(
    cmd.examples.some((example: any) => example.cmd.includes(obsoleteKanbanRead)),
    false,
    'kanban materialize examples must not reference the removed read command'
  );
});
