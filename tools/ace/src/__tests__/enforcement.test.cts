const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ctxFromEnv,
  resolveActiveInstanceTag,
  enforceCallerWorkspace,
  enforceNoSelfSpawn,
  enforceNoSelfStream,
  enforceDelegation,
  applyEnforcement,
  assertViewerRole,
  FORBIDDEN_VIEWER_VERBS,
  isControlPlaneIdentity,
  findRelatedHealthyStream,
} = require('../enforcement.cjs');

test('enforceCallerWorkspace: matching tags and workspace pass', () => {
  assert.doesNotThrow(() => {
    enforceCallerWorkspace({
      callerWorkspace: 'prj-a',
      targetWorkspace: 'prj-a',
      callerInstanceTag: 'Ace',
      activeInstanceTag: 'Ace',
      commandLabel: 'task run',
    });
  });
});

test('enforceCallerWorkspace: mismatched tags reject with instance_mismatch', () => {
  let err;
  assert.throws(() => {
    try {
      enforceCallerWorkspace({
        callerWorkspace: 'prj-a',
        targetWorkspace: 'prj-b',
        callerInstanceTag: 'Ace',
        activeInstanceTag: 'Ace-Ace',
        commandLabel: 'task run',
      });
    } catch (thrown) {
      err = thrown;
      throw thrown;
    }
  });
  assert.equal(err.error, 'instance_mismatch');
  assert.match(err.message, /instance 'Ace-Ace'/);
});

test('enforceCallerWorkspace: missing caller tag and defined active tag passes', () => {
  assert.doesNotThrow(() => {
    enforceCallerWorkspace({
      callerWorkspace: 'prj-a',
      targetWorkspace: 'prj-a',
      callerInstanceTag: null,
      activeInstanceTag: 'Ace-Ace',
      commandLabel: 'task run',
    });
  });
});

test('enforceCallerWorkspace: both tags null passes', () => {
  assert.doesNotThrow(() => {
    enforceCallerWorkspace({
      callerWorkspace: 'prj-a',
      targetWorkspace: 'prj-a',
      callerInstanceTag: null,
      activeInstanceTag: null,
      commandLabel: 'task run',
    });
  });
});

test('enforceCallerWorkspace: same tag and workspace mismatch keeps scope_violation', () => {
  let err;
  assert.throws(() => {
    try {
      enforceCallerWorkspace({
        callerWorkspace: 'prj-a',
        targetWorkspace: 'prj-b',
        callerInstanceTag: 'Ace',
        activeInstanceTag: 'Ace',
        commandLabel: 'task run',
      });
    } catch (thrown) {
      err = thrown;
      throw thrown;
    }
  });
  assert.equal(err.error, 'scope_violation');
  assert.match(err.message, /cannot target workspace prj-b/);
});

test('enforceCallerWorkspace: rook/king control-plane callers can target another workspace', () => {
  assert.doesNotThrow(() => {
    enforceCallerWorkspace({
      callerWorkspace: 'prj-personal',
      targetWorkspace: 'prj-target',
      callerInstanceTag: 'Ace',
      activeInstanceTag: 'Ace',
      callerControlPlane: true,
      callerIdentity: 'rook',
      commandLabel: 'task run',
    });
  });
});

test('ctxFromEnv: prefers stable caller tag when present', () => {
  const ctx = ctxFromEnv({
    ACE_WORKSPACE_ID: 'prj-a',
    ACE_CALLER_INSTANCE_TAG: 'Ace',
    ACE_USER_DATA_TAG: 'Ace-Ace',
    ACE_PERSONAL_IDENTITY: 'rook',
  });
  assert.equal(ctx.workspaceId, 'prj-a');
  assert.equal(ctx.callerInstanceTag, 'Ace');
  assert.equal(ctx.personalIdentity, 'rook');
  assert.equal(ctx.isControlPlaneCaller, true);
});

test('isControlPlaneIdentity: only rook/king are Ace control-plane callers', () => {
  assert.equal(isControlPlaneIdentity('rook'), true);
  assert.equal(isControlPlaneIdentity('King'), true);
  assert.equal(isControlPlaneIdentity('hermes'), false);
  assert.equal(isControlPlaneIdentity('claude'), false);
});

test('resolveActiveInstanceTag: parses explicit tag first, then socket path', () => {
  assert.equal(resolveActiveInstanceTag({ env: { ACE_USER_DATA_TAG: 'Ace-Dev' } }), 'Ace-Dev');
  assert.equal(
    resolveActiveInstanceTag({ env: { ACE_SOCK: '/tmp/ace.Ace-Alt.sock' } }),
    'Ace-Alt'
  );
  assert.equal(
    resolveActiveInstanceTag({ env: { ACE_SOCK: '\\\\.\\pipe\\ace-Ace-Win' } }),
    'Ace-Win'
  );
});

test('enforceNoSelfSpawn: allows other task', () => {
  assert.doesNotThrow(() => {
    enforceNoSelfSpawn({ callerTask: 'tsk-a', targetTask: 'tsk-b', commandLabel: 'spawn' });
  });
});

test('enforceNoSelfSpawn: rejects own task', () => {
  assert.throws(
    () => enforceNoSelfSpawn({ callerTask: 'tsk-a', targetTask: 'tsk-a', commandLabel: 'spawn' }),
    /own task tsk-a/
  );
});

test('enforceNoSelfStream: rejects own stream', () => {
  assert.throws(
    () => enforceNoSelfStream({ callerStream: 'conversation:abc', targetStream: 'conversation:abc', commandLabel: 'task chat' }),
    /own stream conversation:abc/
  );
});

test('enforceDelegation: reads active context from env by default', () => {
  assert.throws(
    () => enforceDelegation({ workspaceId: 'prj-other', commandLabel: 'task run', env: { ACE_WORKSPACE_ID: 'prj-mine' } }),
    /prj-other/
  );
});

test('applyEnforcement: no-op for unrelated commands', () => {
  assert.doesNotThrow(() => {
    applyEnforcement({ cli: 'ls' }, { flags: {} }, { ACE_WORKSPACE_ID: 'prj-a' });
  });
});

test('applyEnforcement: task chat checks stream/task/workspace from flags', () => {
  assert.throws(
    () => applyEnforcement(
      { cli: 'task chat' },
      { flags: { workspace: 'prj-b', task: 'tsk-b', stream: 'conversation:b' } },
      { ACE_WORKSPACE_ID: 'prj-a', ACE_TASK_ID: 'tsk-a', ACE_STREAM_ID: 'conversation:a' }
    ),
    /cannot target workspace prj-b/
  );
});

test('assertViewerRole: viewer is rejected on every forbidden verb', () => {
  for (const verb of FORBIDDEN_VIEWER_VERBS) {
    assert.throws(
      () => assertViewerRole('viewer', verb),
      new RegExp(`role='viewer' cannot perform '${verb}'`),
      `expected viewer to be blocked from '${verb}'`
    );
  }
});

test('assertViewerRole: viewer rejected regardless of verb casing/whitespace', () => {
  assert.throws(() => assertViewerRole('viewer', 'PUSH'), /cannot perform 'push'/);
  assert.throws(() => assertViewerRole('viewer', '  pr-create  '), /cannot perform 'pr-create'/);
});

test('assertViewerRole: viewer is allowed on benign verbs', () => {
  assert.doesNotThrow(() => assertViewerRole('viewer', 'read'));
  assert.doesNotThrow(() => assertViewerRole('viewer', 'ls'));
  assert.doesNotThrow(() => assertViewerRole('viewer', 'pr-view'));
});

test('assertViewerRole: editor is allowed on every verb', () => {
  for (const verb of FORBIDDEN_VIEWER_VERBS) {
    assert.doesNotThrow(() => assertViewerRole('editor', verb));
  }
});

test('assertViewerRole: unknown role is treated as non-viewer (no-op)', () => {
  assert.doesNotThrow(() => assertViewerRole('admin', 'push'));
  assert.doesNotThrow(() => assertViewerRole(undefined, 'push'));
});

test('assertViewerRole: pr-merge is allowed for validated controller integration', () => {
  assert.ok(!FORBIDDEN_VIEWER_VERBS.has('pr-merge'), 'pr-merge is handled by the integration gateway, not the viewer verb guard');
  assert.ok(!FORBIDDEN_VIEWER_VERBS.has('merge'), 'merge is handled by the integration gateway, not the viewer verb guard');
  assert.doesNotThrow(() => assertViewerRole('viewer', 'pr-merge'));
  assert.doesNotThrow(() => assertViewerRole('viewer', 'merge'));
});

test('findRelatedHealthyStream: recommends same task/agent reuse', () => {
  const match = findRelatedHealthyStream(
    [
      { streamId: 'conversation:old', agent: 'codex', taskId: 'tsk_1', state: 'awaiting-input' },
      { streamId: 'conversation:bad', agent: 'codex', taskId: 'tsk_1', state: 'error' },
    ],
    { agent: 'codex', taskId: 'tsk_1' }
  );
  assert.equal(match.streamId, 'conversation:old');
  assert.equal(match.reuseReason, 'same-task-agent');
});

test('findRelatedHealthyStream: ignores stale non-live identity duplicates', () => {
  const match = findRelatedHealthyStream(
    [
      { streamId: 'conversation:stale-king', agent: 'hermes', workspaceId: 'prj_king', label: 'King', state: 'dormant', live: false },
      { streamId: 'conversation:live-king', agent: 'hermes', workspaceId: 'prj_king', label: 'King', state: 'awaiting-input', live: true },
    ],
    { agent: 'hermes', workspaceId: 'prj_king', label: 'King' }
  );
  assert.equal(match.streamId, 'conversation:live-king');
  assert.equal(match.reuseReason, 'same-workspace-label-agent');
});

test('findRelatedHealthyStream: ignores unrelated labels and unhealthy streams', () => {
  const match = findRelatedHealthyStream(
    [
      { streamId: 'conversation:dirty', agent: 'codex', workspaceId: 'prj_1', label: 'fix-ci', state: 'closed' },
      { streamId: 'conversation:other', agent: 'codex', workspaceId: 'prj_1', label: 'docs', state: 'awaiting-input' },
    ],
    { agent: 'codex', workspaceId: 'prj_1', label: 'fix-ci' }
  );
  assert.equal(match, null);
});

test('runTask spec-driven integrate path is not gated by assertViewerRole (orchestrator never imports it)', () => {
  // The sanctioned autonomous-integration lane is the runTask → integrationMergePr
  // IPC chain. Controller-owned merges flow through the integration gateway and
  // its mergeability/check/fixback guards, not through the generic viewer verb
  // blocker. That keeps Rook/King able to validate and merge subagent PRs.
  //
  // Functional assertion: the orchestrator module does not import assertViewerRole
  // or FORBIDDEN_VIEWER_VERBS at all, so the runTask integrate dispatcher cannot be
  // gated on viewer role. If someone wires assertViewerRole into that path, this
  // test will fail and force a conscious decision.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'orchestrator.cjs'),
    'utf8'
  );
  assert.ok(
    !source.includes('assertViewerRole'),
    'orchestrator.cjs must not invoke assertViewerRole on the integrate path'
  );
  assert.ok(
    !source.includes('FORBIDDEN_VIEWER_VERBS'),
    'orchestrator.cjs must not gate integration on FORBIDDEN_VIEWER_VERBS'
  );
});
