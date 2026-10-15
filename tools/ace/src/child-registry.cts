// child-registry — bookkeeping for every editor child the orchestrator has
// spawned, keyed by taskId. Survives across CLI invocations via a JSON file
// so `ace supervise` can list rows the previous `task run --integrate`
// left behind. Pass { db } to inject an alternate backing store (the tests
// use an in-memory Map; Ace itself may wire SQLite later).
//
// Row shape:
//   { taskId, streamId?, branch, worktreePath, prNumber?, prUrl?, prState?,
//     prChecks?, waveId?, laneId?, laneStatus?, lastTrailer?,
//     parentTaskId?, rootTaskId?, isRootGoalAgent?, isInternalSubagent?,
//     updatedAt }

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultStorePath() {
  if (process.env.ACE_CHILD_REGISTRY_PATH) {
    return process.env.ACE_CHILD_REGISTRY_PATH;
  }
  const home =
    process.env.ACE_HOME ||
    path.join(os.homedir(), '.ace-coder');
  return path.join(home, 'child-registry.json');
}

function createMemoryDb() {
  const store = new Map();
  return {
    get(id: any) {
      return store.get(id) || null;
    },
    set(id: any, row: any) {
      store.set(id, row);
    },
    delete(id: any) {
      store.delete(id);
    },
    all() {
      return Array.from(store.values());
    },
  };
}

function createFileDb(filePath: any) {
  function readAll() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  function writeAll(obj: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  }
  return {
    get(id: any) {
      return readAll()[id] || null;
    },
    set(id: any, row: any) {
      const all = readAll();
      all[id] = row;
      writeAll(all);
    },
    delete(id: any) {
      const all = readAll();
      delete all[id];
      writeAll(all);
    },
    all() {
      return Object.values(readAll());
    },
  };
}

function cleanString(value: any) {
  const text = String(value ?? '').trim();
  return text || null;
}

function explicitTrue(value: any) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function explicitFalse(value: any) {
  return value === false || value === 'false' || value === 0 || value === '0';
}

function lineageFrom(input: any = {}, existing: any = {}) {
  const taskId = cleanString(input.taskId ?? existing.taskId);
  const parentTaskId = cleanString(
    input.parentTaskId ??
      input.parent_task_id ??
      existing.parentTaskId ??
      existing.parent_task_id
  );
  const requestedRootTaskId = cleanString(
    input.rootTaskId ??
      input.root_task_id ??
      existing.rootTaskId ??
      existing.root_task_id
  );
  const rootTaskId = requestedRootTaskId || parentTaskId || taskId;
  const internalExplicit =
    explicitTrue(input.isInternalSubagent) ||
    explicitTrue(input.is_internal_subagent) ||
    explicitTrue(input.internalSubagent) ||
    explicitTrue(existing.isInternalSubagent) ||
    explicitTrue(existing.is_internal_subagent);
  const rootExplicit =
    explicitTrue(input.isRootGoalAgent) ||
    explicitTrue(input.is_root_goal_agent) ||
    explicitTrue(existing.isRootGoalAgent) ||
    explicitTrue(existing.is_root_goal_agent);
  const rootDenied =
    explicitFalse(input.isRootGoalAgent) ||
    explicitFalse(input.is_root_goal_agent);
  const isInternalSubagent = !!(
    internalExplicit ||
    parentTaskId ||
    (taskId && rootTaskId && taskId !== rootTaskId && !rootExplicit)
  );
  const isRootGoalAgent = !rootDenied && !isInternalSubagent && (rootExplicit || !parentTaskId);
  return {
    parentTaskId,
    rootTaskId,
    isRootGoalAgent,
    isInternalSubagent,
  };
}

function isInternalSubagentCompletion(value: any = {}) {
  return lineageFrom(value).isInternalSubagent === true;
}

function isRootGoalAgentRow(value: any = {}) {
  return lineageFrom(value).isRootGoalAgent === true;
}

function createChildRegistry({ db }: any = {}) {
  const store = db || createMemoryDb();

  function register({ taskId, streamId, branch, worktreePath, workspaceId, baseBranch, remoteBaseRef, baseSha, baseHygiene, allowedPaths, validation, waveId, laneId, parentTaskId, rootTaskId, isRootGoalAgent, isInternalSubagent, parallelTeams }: any = {}) {
    if (!taskId) throw new Error('child-registry.register: taskId required');
    const existing = store.get(taskId) || {};
    const lineage = lineageFrom(
      { taskId, parentTaskId, rootTaskId, isRootGoalAgent, isInternalSubagent },
      existing
    );
    const row = {
      ...existing,
      taskId,
      streamId: streamId ?? existing.streamId ?? null,
      workspaceId: workspaceId ?? existing.workspaceId ?? null,
      branch: branch ?? existing.branch ?? null,
      baseBranch: baseBranch ?? existing.baseBranch ?? null,
      remoteBaseRef: remoteBaseRef ?? baseHygiene?.remoteBaseRef ?? existing.remoteBaseRef ?? null,
      baseSha: baseSha ?? baseHygiene?.remoteBaseSha ?? existing.baseSha ?? null,
      baseHygiene: baseHygiene ?? existing.baseHygiene ?? null,
      allowedPaths: Array.isArray(allowedPaths) ? allowedPaths : (existing.allowedPaths ?? []),
      worktreePath: worktreePath ?? existing.worktreePath ?? null,
      waveId: waveId ?? existing.waveId ?? null,
      laneId: laneId ?? existing.laneId ?? null,
      // Explicit parallel-wave marker ("group"): the shared wave validator
      // keys on this via isExplicitParallelWave.
      parallelTeams: parallelTeams === true ? true : existing.parallelTeams ?? null,
      parentTaskId: lineage.parentTaskId,
      rootTaskId: lineage.rootTaskId,
      isRootGoalAgent: lineage.isRootGoalAgent,
      isInternalSubagent: lineage.isInternalSubagent,
      prNumber: existing.prNumber ?? null,
      prUrl: existing.prUrl ?? null,
      prState: existing.prState ?? null,
      prChecks: existing.prChecks ?? null,
      lastTrailer: existing.lastTrailer ?? null,
      validation: validation ?? existing.validation ?? {
        self: null,
        independent: null,
        fixback: null,
        required: false,
        highRisk: false,
        chiefOverride: false,
      },
      updatedAt: Date.now(),
    };
    store.set(taskId, row);
    return row;
  }

  function recordWorkerCompletion(completion: any = {}) {
    const taskId = completion.taskId;
    if (!taskId) throw new Error('child-registry.recordWorkerCompletion: taskId required');
    register({
      taskId,
      streamId: completion.streamId ?? null,
      workspaceId: completion.workspaceId ?? null,
      branch: completion.branch ?? null,
      baseBranch: completion.baseBranch ?? null,
      remoteBaseRef: completion.remoteBaseRef ?? null,
      baseSha: completion.baseSha ?? null,
      baseHygiene: completion.baseHygiene ?? null,
      allowedPaths: completion.allowedPaths ?? null,
      worktreePath: completion.worktreePath ?? null,
      waveId: completion.waveId ?? null,
      laneId: completion.laneId ?? null,
      parentTaskId: completion.parentTaskId ?? completion.parent_task_id ?? null,
      rootTaskId: completion.rootTaskId ?? completion.root_task_id ?? null,
      isRootGoalAgent: completion.isRootGoalAgent ?? completion.is_root_goal_agent,
      isInternalSubagent: completion.isInternalSubagent ?? completion.is_internal_subagent,
    });
    const patch: any = {
      streamId: completion.streamId ?? null,
      lastTrailer: completion.detail || null,
      laneStatus: completion.outcome || completion.kind || null,
      terminalAt: completion.timestamp || Date.now(),
    };
    const lineage = lineageFrom(completion, { taskId });
    patch.parentTaskId = lineage.parentTaskId;
    patch.rootTaskId = lineage.rootTaskId;
    patch.isRootGoalAgent = lineage.isRootGoalAgent;
    patch.isInternalSubagent = lineage.isInternalSubagent;
    if (completion.prNumber != null) patch.prNumber = completion.prNumber;
    if (completion.prUrl != null) patch.prUrl = completion.prUrl;
    if (completion.waveId != null) patch.waveId = completion.waveId;
    if (completion.laneId != null) patch.laneId = completion.laneId;
    return updatePrState(taskId, patch);
  }

  function recordChildCompletion(completion: any = {}) {
    return recordWorkerCompletion({
      ...completion,
      isInternalSubagent: true,
    });
  }

  function updatePrState(taskId: any, patch: any = {}) {
    if (!taskId) throw new Error('child-registry.updatePrState: taskId required');
    const existing = store.get(taskId);
    if (!existing) {
      throw new Error(`child-registry.updatePrState: no row for taskId ${taskId}`);
    }
    const next = { ...existing, ...patch, taskId, updatedAt: Date.now() };
    store.set(taskId, next);
    return next;
  }

  function get(taskId: any) {
    if (!taskId) return null;
    return store.get(taskId);
  }

  function list() {
    return store.all();
  }

  function remove(taskId: any) {
    if (!taskId) return;
    store.delete(taskId);
  }

  return { register, recordWorkerCompletion, recordChildCompletion, updatePrState, get, list, remove };
}

module.exports = {
  createChildRegistry,
  createMemoryDb,
  createFileDb,
  defaultStorePath,
  isInternalSubagentCompletion,
  isRootGoalAgentRow,
  lineageFrom,
};
