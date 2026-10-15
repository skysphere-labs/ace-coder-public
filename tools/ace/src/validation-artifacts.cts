const VALID_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const REASON_CODE_RX = /^[a-z][a-z0-9_]*$/;

function parseObject(input: any, label: string) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err: any) {
      throw new Error(`${label}: invalid JSON (${err.message})`);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}: object required`);
  }
  return raw;
}

function cleanString(value: any, label: string, required = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error(`${label}: non-empty string required`);
  return text || null;
}

function normalizeStatus(value: any, label: string) {
  const status = String(value || '').trim().toUpperCase();
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`${label}: status must be PASS, FAIL, or BLOCKED`);
  }
  return status;
}

function statusFromVerdict(raw: any, label: string) {
  if (raw.status != null) return normalizeStatus(raw.status, label);
  const verdict = String(raw.verdict || '').trim().toLowerCase();
  if (verdict === 'request-changes') return 'FAIL';
  if (verdict === 'block') return 'BLOCKED';
  throw new Error(`${label}: status or verdict required`);
}

function verdictFromStatus(status: string) {
  if (status === 'FAIL') return 'request-changes';
  if (status === 'BLOCKED') return 'block';
  return 'pass';
}

function normalizeRound(value: any, label: string) {
  const round = Number(value);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`${label}: round must be a positive integer`);
  }
  return round;
}

function prNumberFromUrl(prUrl: string | null) {
  const match = prUrl ? prUrl.match(/\/pull\/([1-9]\d*)(?:\b|$)/) : null;
  return match ? Number(match[1]) : null;
}

function normalizePrNumber(value: any, prUrl: string | null, label: string) {
  if (value == null || value === '') return prNumberFromUrl(prUrl);
  const prNumber = Number(value);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`${label}: prNumber must be a positive integer`);
  }
  return prNumber;
}

function normalizeStringList(value: any, label: string) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((item: any, index: number) => {
    const text = String(item || '').trim();
    if (!text) throw new Error(`${label}[${index}]: non-empty string required`);
    return text;
  });
}

function normalizeFindingList(value: any, label: string) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: findings must be an array`);
  return value.map((item: any, index: number) => {
    const raw = parseObject(item, `${label}[${index}]`);
    return {
      criterion: cleanString(raw.criterion, `${label}[${index}].criterion`, true),
      status: cleanString(raw.status, `${label}[${index}].status`, true),
      evidence: cleanString(raw.evidence, `${label}[${index}].evidence`, true),
      fix: cleanString(raw.fix, `${label}[${index}].fix`, true),
    };
  });
}

function normalizeReasonCode(value: any, label: string) {
  const code = String(value || '').trim().toLowerCase();
  if (!REASON_CODE_RX.test(code)) {
    throw new Error(`${label}: reason code must be lowercase snake_case`);
  }
  return code;
}

function normalizeBlockerReasons(value: any, status: string, label: string) {
  const raw = value == null ? [] : value;
  if (!Array.isArray(raw)) throw new Error(`${label}: blockerReasons must be an array`);

  const seen = new Set();
  const reasons = [];
  for (const [index, item] of raw.entries()) {
    const objectItem = item && typeof item === 'object' && !Array.isArray(item);
    const code = normalizeReasonCode(objectItem ? item.code : item, `${label}[${index}].code`);
    if (seen.has(code)) continue;
    seen.add(code);
    reasons.push({
      code,
      message: objectItem ? cleanString(item.message ?? item.reason ?? item.detail, `${label}[${index}].message`) : null,
    });
  }

  if (status === 'BLOCKED' && reasons.length === 0) {
    throw new Error(`${label}: BLOCKED artifacts require at least one blocker reason code`);
  }
  return reasons;
}

function normalizeBoolean(value: any, label: string) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new Error(`${label}: boolean required`);
  return value;
}

function normalizeBase(raw: any, status: string, label: string) {
  const prUrl = cleanString(raw.prUrl ?? raw.pr ?? raw.pullRequestUrl, `${label}.prUrl`, true);
  return {
    status,
    round: normalizeRound(raw.round ?? raw.roundNumber, `${label}.round`),
    taskId: cleanString(raw.taskId ?? raw.task_id ?? raw.workerTaskId, `${label}.taskId`, true),
    streamId: cleanString(raw.streamId ?? raw.stream_id ?? raw.workerStreamId, `${label}.streamId`),
    worktreePath: cleanString(raw.worktreePath ?? raw.worktree_path, `${label}.worktreePath`),
    missionId: cleanString(raw.missionId ?? raw.mission_id, `${label}.missionId`),
    featureId: cleanString(raw.featureId ?? raw.feature_id, `${label}.featureId`),
    waveId: cleanString(raw.waveId ?? raw.wave_id, `${label}.waveId`),
    laneId: cleanString(raw.laneId ?? raw.lane_id, `${label}.laneId`),
    prUrl,
    prNumber: normalizePrNumber(raw.prNumber ?? raw.pr_number, prUrl, `${label}.prNumber`),
    branch: cleanString(raw.branch ?? raw.headBranch ?? raw.headRefName, `${label}.branch`, true),
    baseBranch: cleanString(raw.baseBranch ?? raw.base_branch ?? raw.baseRefName, `${label}.baseBranch`),
    blockerReasons: normalizeBlockerReasons(
      raw.blockerReasons ?? raw.blocker_reasons ?? raw.reasons ?? raw.reasonCodes,
      status,
      `${label}.blockerReasons`
    ),
    evidence: normalizeStringList(raw.evidence, `${label}.evidence`),
  };
}

function normalizeValidationResult(input: any) {
  const raw = parseObject(input, 'ValidationResult');
  const status = normalizeStatus(raw.status, 'ValidationResult.status');
  return {
    schema: 'ValidationResult/v1',
    ...normalizeBase(raw, status, 'ValidationResult'),
    summary: cleanString(raw.summary, 'ValidationResult.summary'),
  };
}

function normalizeValidationFailurePacket(input: any) {
  const raw = parseObject(input, 'ValidationFailurePacket');
  const status = statusFromVerdict(raw, 'ValidationFailurePacket');
  if (status === 'PASS') {
    throw new Error('ValidationFailurePacket: status must be FAIL or BLOCKED');
  }
  return {
    schema: 'ValidationFailurePacket/v1',
    verdict: verdictFromStatus(status),
    ...normalizeBase(raw, status, 'ValidationFailurePacket'),
    failingChecks: normalizeStringList(raw.failingChecks ?? raw.failing_checks, 'ValidationFailurePacket.failingChecks'),
    failingFiles: normalizeStringList(raw.failingFiles ?? raw.failing_files, 'ValidationFailurePacket.failingFiles'),
    expected: cleanString(raw.expected ?? raw.expectedBehavior, 'ValidationFailurePacket.expected'),
    actual: cleanString(raw.actual ?? raw.actualBehavior, 'ValidationFailurePacket.actual'),
    rootCause: cleanString(raw.rootCause ?? raw.root_cause, 'ValidationFailurePacket.rootCause'),
    reproduction: normalizeStringList(
      raw.reproduction ?? raw.reproductionCommands ?? raw.reproduction_commands,
      'ValidationFailurePacket.reproduction'
    ),
    findings: normalizeFindingList(raw.findings, 'ValidationFailurePacket.findings'),
    rerunGate: raw.rerunGate != null ? normalizeBoolean(raw.rerunGate, 'ValidationFailurePacket.rerunGate') : false,
    implementerFamily: cleanString(raw.implementerFamily ?? raw.implementer_family, 'ValidationFailurePacket.implementerFamily'),
    validatorFamily: cleanString(raw.validatorFamily ?? raw.validator_family, 'ValidationFailurePacket.validatorFamily'),
  };
}

function normalizeRetry(raw: any, round: number) {
  const retry = raw?.retry && typeof raw.retry === 'object' && !Array.isArray(raw.retry) ? raw.retry : {};
  const attempts = Number(retry.attempts ?? raw.attempts ?? round - 1);
  const maxAttempts = Number(retry.maxAttempts ?? raw.maxAttempts ?? 3);
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error('FixbackPacket.retry.attempts: non-negative integer required');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('FixbackPacket.retry.maxAttempts: positive integer required');
  }
  const remaining = Math.max(0, maxAttempts - attempts);
  return {
    attempts,
    maxAttempts,
    remaining,
    exhausted: remaining === 0,
  };
}

function normalizeFixbackPacket(input: any) {
  const raw = parseObject(input, 'FixbackPacket');
  const failure = normalizeValidationFailurePacket(raw.validationFailure ?? raw.failure ?? raw.validation_failure);
  const base = normalizeBase(
    {
      ...failure,
      ...raw,
      blockerReasons: raw.blockerReasons ?? raw.blocker_reasons ?? raw.reasons ?? raw.reasonCodes ?? failure.blockerReasons,
    },
    failure.status,
    'FixbackPacket'
  );
  return {
    schema: 'FixbackPacket/v1',
    action: cleanString(raw.action, 'FixbackPacket.action') || 'delegate-fixback',
    ...base,
    validationFailure: failure,
    retry: normalizeRetry(raw, base.round),
  };
}

function normalizeLaneVerdict(input: any, index: number) {
  const raw = parseObject(input, `WaveVerdict.laneVerdicts[${index}]`);
  const status = normalizeStatus(raw.status, `WaveVerdict.laneVerdicts[${index}].status`);
  const prUrl = cleanString(raw.prUrl ?? raw.pr ?? raw.pullRequestUrl, `WaveVerdict.laneVerdicts[${index}].prUrl`);
  const blockerReasons = normalizeBlockerReasons(
    raw.blockerReasons ?? raw.blocker_reasons ?? raw.reasons ?? raw.reasonCodes,
    status,
    `WaveVerdict.laneVerdicts[${index}].blockerReasons`
  );
  return {
    laneId: cleanString(raw.laneId ?? raw.lane_id, `WaveVerdict.laneVerdicts[${index}].laneId`, true),
    featureId: cleanString(raw.featureId ?? raw.feature_id, `WaveVerdict.laneVerdicts[${index}].featureId`),
    status,
    taskId: cleanString(raw.taskId ?? raw.task_id ?? raw.workerTaskId, `WaveVerdict.laneVerdicts[${index}].taskId`),
    streamId: cleanString(raw.streamId ?? raw.stream_id ?? raw.workerStreamId, `WaveVerdict.laneVerdicts[${index}].streamId`),
    worktreePath: cleanString(raw.worktreePath ?? raw.worktree_path, `WaveVerdict.laneVerdicts[${index}].worktreePath`),
    prUrl,
    prNumber: normalizePrNumber(raw.prNumber ?? raw.pr_number, prUrl, `WaveVerdict.laneVerdicts[${index}].prNumber`),
    branch: cleanString(raw.branch ?? raw.headBranch ?? raw.headRefName, `WaveVerdict.laneVerdicts[${index}].branch`),
    baseBranch: cleanString(raw.baseBranch ?? raw.base_branch ?? raw.baseRefName, `WaveVerdict.laneVerdicts[${index}].baseBranch`),
    blockerReasons,
    evidence: normalizeStringList(raw.evidence, `WaveVerdict.laneVerdicts[${index}].evidence`),
    failingChecks: normalizeStringList(raw.failingChecks ?? raw.failing_checks, `WaveVerdict.laneVerdicts[${index}].failingChecks`),
    failingFiles: normalizeStringList(raw.failingFiles ?? raw.failing_files, `WaveVerdict.laneVerdicts[${index}].failingFiles`),
    expected: cleanString(raw.expected ?? raw.expectedBehavior, `WaveVerdict.laneVerdicts[${index}].expected`),
    actual: cleanString(raw.actual ?? raw.actualBehavior, `WaveVerdict.laneVerdicts[${index}].actual`),
    rootCause: cleanString(raw.rootCause ?? raw.root_cause, `WaveVerdict.laneVerdicts[${index}].rootCause`),
    reproduction: normalizeStringList(
      raw.reproduction ?? raw.reproductionCommands ?? raw.reproduction_commands,
      `WaveVerdict.laneVerdicts[${index}].reproduction`
    ),
  };
}

function normalizeLaneVerdicts(value: any) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('WaveVerdict.laneVerdicts: non-empty array required');
  }
  return value.map((lane: any, index: number) => normalizeLaneVerdict(lane, index));
}

function createLaneFixbackPacket(lane: any, raw: any, round: number) {
  if (lane.status !== 'FAIL') return null;
  if (!lane.taskId || !lane.prUrl || !lane.branch) return null;
  return normalizeFixbackPacket({
    action: 'delegate-fixback',
    round,
    taskId: lane.taskId,
    streamId: lane.streamId,
    worktreePath: lane.worktreePath,
    waveId: raw.waveId ?? raw.wave_id,
    laneId: lane.laneId,
    prUrl: lane.prUrl,
    prNumber: lane.prNumber,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    blockerReasons: lane.blockerReasons.length ? lane.blockerReasons : ['validation_failed'],
    validationFailure: {
      round,
      taskId: lane.taskId,
      streamId: lane.streamId,
      worktreePath: lane.worktreePath,
      waveId: raw.waveId ?? raw.wave_id,
      laneId: lane.laneId,
      prUrl: lane.prUrl,
      prNumber: lane.prNumber,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      status: 'FAIL',
      blockerReasons: lane.blockerReasons.length ? lane.blockerReasons : ['validation_failed'],
      evidence: lane.evidence,
      failingChecks: lane.failingChecks,
      failingFiles: lane.failingFiles,
      expected: lane.expected,
      actual: lane.actual,
      rootCause: lane.rootCause,
      reproduction: lane.reproduction,
    },
    retry: raw.retry,
  });
}

function normalizeWaveFixbackPackets(raw: any, laneVerdicts: any[], round: number) {
  const packets = raw.fixbackPackets ?? raw.fixback_packets;
  if (packets != null) {
    if (!Array.isArray(packets)) throw new Error('WaveVerdict.fixbackPackets: array required');
    return packets.map((packet: any) => normalizeFixbackPacket(packet));
  }
  return laneVerdicts
    .map((lane: any) => createLaneFixbackPacket(lane, raw, round))
    .filter(Boolean);
}

function normalizeWaveVerdict(input: any) {
  const raw = parseObject(input, 'WaveVerdict');
  const status = normalizeStatus(raw.status, 'WaveVerdict.status');
  const laneVerdicts = normalizeLaneVerdicts(raw.laneVerdicts ?? raw.lane_verdicts);
  const round = normalizeRound(raw.round ?? raw.roundNumber ?? 1, 'WaveVerdict.round');
  const failingLanes = laneVerdicts.filter((lane: any) => lane.status !== 'PASS');
  const blockerReasons = normalizeBlockerReasons(
    raw.blockerReasons ?? raw.blocker_reasons ?? raw.reasons ?? raw.reasonCodes,
    status,
    'WaveVerdict.blockerReasons'
  );
  const fixbackPackets = normalizeWaveFixbackPackets(raw, laneVerdicts, round);

  return {
    schema: 'WaveVerdict/v1',
    status,
    round,
    missionId: cleanString(raw.missionId ?? raw.mission_id, 'WaveVerdict.missionId', true),
    waveId: cleanString(raw.waveId ?? raw.wave_id, 'WaveVerdict.waveId', true),
    validatorTaskId: cleanString(raw.validatorTaskId ?? raw.validator_task_id, 'WaveVerdict.validatorTaskId'),
    validatorStreamId: cleanString(raw.validatorStreamId ?? raw.validator_stream_id, 'WaveVerdict.validatorStreamId'),
    laneVerdicts,
    evidence: normalizeStringList(raw.evidence, 'WaveVerdict.evidence'),
    failingLanes,
    fixbackPackets,
    mergeAllowed: raw.mergeAllowed != null ? normalizeBoolean(raw.mergeAllowed, 'WaveVerdict.mergeAllowed') : status === 'PASS',
    blockerReasons,
  };
}

function createWaveVerdict(input: any) {
  return normalizeWaveVerdict(input);
}

function normalizeMergeResult(input: any) {
  const raw = parseObject(input, 'MergeResult');
  const status = normalizeStatus(raw.status, 'MergeResult.status');
  return {
    schema: 'MergeResult/v1',
    ...normalizeBase(raw, status, 'MergeResult'),
    mergeCommit: cleanString(raw.mergeCommit ?? raw.merge_commit, 'MergeResult.mergeCommit'),
    method: cleanString(raw.method ?? raw.mergeMethod ?? raw.merge_method, 'MergeResult.method'),
  };
}

function normalizeCleanupResult(input: any) {
  const raw = parseObject(input, 'CleanupResult');
  const status = normalizeStatus(raw.status, 'CleanupResult.status');
  return {
    schema: 'CleanupResult/v1',
    ...normalizeBase(raw, status, 'CleanupResult'),
    deletedRemoteBranch: normalizeBoolean(
      raw.deletedRemoteBranch ?? raw.deleted_remote_branch,
      'CleanupResult.deletedRemoteBranch'
    ),
    removedWorktree: normalizeBoolean(raw.removedWorktree ?? raw.removed_worktree, 'CleanupResult.removedWorktree'),
    worktreePath: cleanString(raw.worktreePath ?? raw.worktree_path, 'CleanupResult.worktreePath'),
  };
}

function isValidationResult(input: any) {
  try {
    normalizeValidationResult(input);
    return true;
  } catch (_err) {
    return false;
  }
}

function isValidationFailurePacket(input: any) {
  try {
    normalizeValidationFailurePacket(input);
    return true;
  } catch (_err) {
    return false;
  }
}

function isFixbackPacket(input: any) {
  try {
    normalizeFixbackPacket(input);
    return true;
  } catch (_err) {
    return false;
  }
}

function isWaveVerdict(input: any) {
  try {
    normalizeWaveVerdict(input);
    return true;
  } catch (_err) {
    return false;
  }
}

function isMergeResult(input: any) {
  try {
    normalizeMergeResult(input);
    return true;
  } catch (_err) {
    return false;
  }
}

function isCleanupResult(input: any) {
  try {
    normalizeCleanupResult(input);
    return true;
  } catch (_err) {
    return false;
  }
}

module.exports = {
  normalizeValidationResult,
  isValidationResult,
  normalizeValidationFailurePacket,
  isValidationFailurePacket,
  normalizeFixbackPacket,
  isFixbackPacket,
  normalizeWaveVerdict,
  createWaveVerdict,
  isWaveVerdict,
  normalizeMergeResult,
  isMergeResult,
  normalizeCleanupResult,
  isCleanupResult,
};
