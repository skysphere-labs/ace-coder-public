function normalizeEnvText(value: any) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function makeEnforcementError(error: any, message: any, details: any = {}) {
  const err = new Error(message);
  err.code = 2;
  err.error = error;
  err.details = details;
  return err;
}

function makeScopeViolation(message: any, details: any = {}) {
  return makeEnforcementError('scope_violation', message, details);
}

function makeInstanceMismatch(message: any, details: any = {}) {
  return makeEnforcementError('instance_mismatch', message, details);
}

function ctxFromEnv(env: any = process.env) {
  const personalIdentity = normalizeEnvText(env.ACE_PERSONAL_IDENTITY);
  return {
    workspaceId: normalizeEnvText(env.ACE_WORKSPACE_ID),
    taskId: normalizeEnvText(env.ACE_TASK_ID),
    streamId: normalizeEnvText(env.ACE_STREAM_ID),
    agent: normalizeEnvText(env.ACE_AGENT),
    personalIdentity,
    isControlPlaneCaller: isControlPlaneIdentity(personalIdentity),
    callerInstanceTag:
      normalizeEnvText(env.ACE_CALLER_INSTANCE_TAG) ||
      normalizeEnvText(env.ACE_USER_DATA_TAG) ||
      null,
  };
}

function isControlPlaneIdentity(identity: any) {
  const key = String(identity || '').trim().toLowerCase();
  return key === 'rook' || key === 'king';
}

function resolveActiveInstanceTag({ env = process.env }: any = {}) {
  const explicitTag = normalizeEnvText(env.ACE_USER_DATA_TAG);
  if (explicitTag) return explicitTag;

  const sockPath = normalizeEnvText(env.ACE_SOCK);
  if (!sockPath) return null;

  const unixMatch = /ace\.([^/\\]+)\.sock$/i.exec(sockPath);
  if (unixMatch) return unixMatch[1];

  const winMatch = /ace-([^/\\]+)$/i.exec(sockPath);
  if (winMatch) return winMatch[1];

  return null;
}

function enforceCallerWorkspace({
  callerWorkspace,
  targetWorkspace,
  commandLabel,
  callerInstanceTag,
  activeInstanceTag,
  callerControlPlane,
  callerIdentity,
}: any) {
  if (!callerWorkspace || !targetWorkspace) return;
  if (callerInstanceTag && activeInstanceTag && callerInstanceTag !== activeInstanceTag) {
    throw makeInstanceMismatch(
      `ace cannot target workspace ${targetWorkspace} in instance '${activeInstanceTag}' from a shell whose ACE_WORKSPACE_ID='${callerWorkspace}' belongs to instance '${callerInstanceTag}'. Unset ACE_WORKSPACE_ID or run this from the matching shell.`,
      {
        callerWorkspace,
        targetWorkspace,
        callerInstanceTag,
        activeInstanceTag,
        command: commandLabel,
      }
    );
  }
  if (callerControlPlane) return;
  if (callerWorkspace !== targetWorkspace) {
    throw makeScopeViolation(
      `${commandLabel} cannot target workspace ${targetWorkspace} from caller workspace ${callerWorkspace}`,
      { callerWorkspace, targetWorkspace, callerIdentity, command: commandLabel }
    );
  }
}

function enforceNoSelfSpawn({ callerTask, targetTask, commandLabel }: any) {
  if (!callerTask || !targetTask) return;
  if (callerTask === targetTask) {
    throw makeScopeViolation(
      `${commandLabel} cannot spawn into your own task ${callerTask}`,
      { callerTask, targetTask, command: commandLabel }
    );
  }
}

function enforceNoSelfStream({ callerStream, targetStream, commandLabel }: any) {
  if (!callerStream || !targetStream) return;
  if (callerStream === targetStream) {
    throw makeScopeViolation(
      `${commandLabel} cannot target your own stream ${callerStream}`,
      { callerStream, targetStream, command: commandLabel }
    );
  }
}

function enforceDelegation({ workspaceId, taskId, streamId, commandLabel, env = process.env }: any) {
  const ctx = ctxFromEnv(env);
  const activeInstanceTag = resolveActiveInstanceTag({ env });
  enforceCallerWorkspace({
    callerWorkspace: ctx.workspaceId,
    targetWorkspace: workspaceId,
    commandLabel,
    callerInstanceTag: ctx.callerInstanceTag,
    activeInstanceTag,
    callerControlPlane: ctx.isControlPlaneCaller,
    callerIdentity: ctx.personalIdentity,
  });
  enforceNoSelfSpawn({ callerTask: ctx.taskId, targetTask: taskId, commandLabel });
  enforceNoSelfStream({ callerStream: ctx.streamId, targetStream: streamId, commandLabel });
}

function applyEnforcement(command: any, parsed: any, env: any = process.env) {
  if (!command?.cli) return;
  const flags = parsed?.flags || {};
  let workspaceId = null;
  let taskId = null;
  let streamId = null;

  switch (command.cli) {
    case 'task run':
    case 'task chat':
      workspaceId = flags.workspace || null;
      taskId = flags.task || null;
      streamId = flags.stream || null;
      break;
    case 'spawn':
      taskId = flags.task || null;
      break;
    case 'spawn-adhoc':
      workspaceId = flags.workspace || null;
      break;
    default:
      return;
  }

  enforceDelegation({ workspaceId, taskId, streamId, commandLabel: command.cli, env });
}

const UNHEALTHY_STREAM_STATES = new Set(['closed', 'dormant', 'error', 'exited', 'killed', 'interrupted']);

function normalizeReuseText(value: any) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function isHealthyStream(row: any) {
  if (row?.live === false) return false;
  const state = String(row?.state || '').trim().toLowerCase();
  return !UNHEALTHY_STREAM_STATES.has(state);
}

function findRelatedHealthyStream(streams: any, target: any = {}) {
  const agent = normalizeReuseText(target.agent);
  const taskId = normalizeReuseText(target.taskId);
  const workspaceId = normalizeReuseText(target.workspaceId);
  const label = normalizeReuseText(target.label);
  if (!agent) return null;
  for (const row of Array.isArray(streams) ? streams : []) {
    if (!row?.streamId || !isHealthyStream(row)) continue;
    if (normalizeReuseText(row.agent) !== agent) continue;
    if (taskId && normalizeReuseText(row.taskId) === taskId) {
      return { ...row, reuseReason: 'same-task-agent' };
    }
    if (
      workspaceId &&
      label &&
      normalizeReuseText(row.workspaceId) === workspaceId &&
      normalizeReuseText(row.label) === label
    ) {
      return { ...row, reuseReason: 'same-workspace-label-agent' };
    }
  }
  return null;
}

// Role enforcement — see the ace-github-flow skill
//
// A spec's `role` field declares what the worker is allowed to do. The Hermes
// lane runs as `role: 'viewer'` — read-only orchestration that delegates
// every write-side action to a child. assertViewerRole guards the verbs that
// would mutate shared state outside the integration gateway (push, PR create,
// forks). Validated merge is now a controller-owned integration action.

const FORBIDDEN_VIEWER_VERBS = new Set([
  'push',
  'pr-create',
  'fork',
]);

function forbiddenRoleMessage(role: any, verb: any) {
  return `enforcement: role='${role}' cannot perform '${verb}' — delegate to an editor child via task run --new-task`;
}

function prRefFromText(value: any) {
  const text = String(value || '').trim();
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\/pull\/(\d+)/i);
  if (urlMatch) return { url: urlMatch[0], number: Number(urlMatch[1]) };
  const hashMatch = text.match(/(?:^|[\s(])#(\d+)(?:$|[\s),.;:])/);
  if (hashMatch) return { url: null, number: Number(hashMatch[1]) };
  const pullMatch = text.match(/\/pull\/(\d+)/i);
  if (pullMatch) return { url: text, number: Number(pullMatch[1]) };
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? { url: null, number } : null;
}

function assertRoleVerb(role: any, verb: any) {
  const v = String(verb || '').trim().toLowerCase();
  if (role === 'viewer' && FORBIDDEN_VIEWER_VERBS.has(v)) {
    throw new Error(forbiddenRoleMessage('viewer', v));
  }
}

function assertViewerRole(role: any, verb: any) {
  assertRoleVerb(role, verb);
}

module.exports = {
  ctxFromEnv,
  isControlPlaneIdentity,
  resolveActiveInstanceTag,
  enforceCallerWorkspace,
  enforceNoSelfSpawn,
  enforceNoSelfStream,
  enforceDelegation,
  applyEnforcement,
  assertRoleVerb,
  assertViewerRole,
  FORBIDDEN_VIEWER_VERBS,
  prRefFromText,
  findRelatedHealthyStream,
  isHealthyStream,
};
