const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_USE_SCHEMA = 'ace.tool_use.v1';
const TOOL_AUDIT_SCHEMA = 'ace.tool_audit.v1';
const TOOL_CONTRACT_SCHEMA = 'ace.tool_contract.v1';
const TOOL_BATCH_SCHEMA = 'ace.tool_batch.v1';
const TOOL_BATCH_RESULT_SCHEMA = 'ace.tool_batch_result.v1';
const CLAWPATCH_SCHEMA = 'ace.clawpatch_validation.v1';

const ROLES = Object.freeze(['orchestrator', 'worker', 'validator', 'fixback', 'memory', 'prune']);
const PHASES = Object.freeze(['start', 'plan', 'dispatch', 'sync', 'validate', 'gate', 'fixback', 'memory', 'prune', 'finish']);

const REQUIRED_EVENTS: any = Object.freeze({
  'orchestrator.start': [
    'tool heartbeat',
    'tool manifest',
    'context',
    'run board|run list',
    'ls|watch|screen|state',
  ],
  'orchestrator.plan': ['mission board|mission ready', 'context'],
  'orchestrator.dispatch': ['mission board|mission ready'],
  'orchestrator.sync': ['screen|state|task result|run list|mission next'],
  'orchestrator.validate': ['mission sync|task result|run list'],
  'orchestrator.gate': ['mission validate|task validate|validation artifact|validation clawpatch'],
  'orchestrator.fixback': ['mission fixback|event emit'],
  'validator.start': ['tool heartbeat', 'context', 'task result|mission board|integrate gate|gh pr view|git diff'],
  'validator.finish': ['validation artifact|mission gate|task validate'],
  'fixback.start': ['tool heartbeat', 'mission fixback|task run'],
  'memory.start': ['memory candidates', 'wiki update|memory promotion record'],
  'prune.start': ['tool heartbeat', 'stats|inventory|rg|find', 'tests|rollback evidence'],
});

const ALLOWED_COMMANDS = Object.freeze([
  'context',
  'describe',
  'control-plane status',
  'ls',
  'watch',
  'screen',
  'state',
  'task run',
  'task result',
  'task validate',
  'run board',
  'run list',
  'feature mark',
  'mission create',
  'mission board',
  'mission ready',
  'mission dispatch',
  'mission wave-dispatch',
  'mission sync',
  'mission validate',
  'mission gate',
  'mission fixback',
  'integrate gate',
  'tool heartbeat',
  'tool manifest',
  'tool audit',
  'tool batch',
  'validation clawpatch',
]);

const BATCH_SAFE_COMMANDS = new Set([
  'context',
  'describe',
  'ls',
  'screen',
  'state',
  'task result',
  'run board',
  'run list',
  'feature list',
  'wave list',
  'mission board',
  'mission ready',
  'integrate gate',
  'tool heartbeat',
  'tool manifest',
  'tool audit',
]);

const BATCH_MUTATING_COMMANDS = new Set([
  'task run',
  'mission create',
  'mission dispatch',
  'mission wave-dispatch',
  'mission sync',
  'mission validate',
  'mission gate',
  'mission fixback',
  'feature mark',
]);

const BATCH_MUTATION_PHASES = new Set(['dispatch', 'sync', 'validate', 'gate', 'fixback']);

const HIGH_RISK_CAPABILITIES = new Set([
  'native-team',
  'wave',
  'merge-gate',
  'security-review',
  'release',
  'deploy',
  'prune',
  'cross-cutting',
]);

const LONG_SIZE_CLASSES = new Set(['medium', 'large', 'epic', 'xlarge']);
const SMALL_SIZE_CLASSES = new Set(['', 'tiny', 'small']);
const SMALL_FAST_TASK_TYPES = new Set(['bug', 'bug-fix', 'bugfix', 'fixback', 'feature-impl']);

function normalize(value: any) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function compactCommand(value: any) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function requiredKey(role: any, phase: any) {
  const r = normalize(role);
  const p = normalize(phase);
  return r && p ? `${r}.${p}` : '';
}

function manifestFor({ role, phase, compact = true }: any = {}) {
  const key = requiredKey(role, phase);
  const required = key ? (REQUIRED_EVENTS[key] || []) : [];
  return {
    schema: TOOL_CONTRACT_SCHEMA,
    role: normalize(role) || null,
    phase: normalize(phase) || null,
    required,
    allowed: compact ? ALLOWED_COMMANDS.slice() : ALLOWED_COMMANDS.slice(),
  };
}

function commandMatchesGroup(command: any, group: any) {
  const seen = normalize(command);
  if (!seen) return false;
  return String(group || '')
    .split('|')
    .map((part) => normalize(part))
    .filter(Boolean)
    .some((part) => seen === part || seen.startsWith(`${part} `));
}

function appendNdjson(filePath: any, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
}

function hasAceDir(dir: any) {
  try {
    if (!!dir && fs.statSync(path.join(dir, '.ace')).isDirectory()) return true;
  } catch {}
  return false;
}

function resolveLedgerPath({ projectDir, cwd = process.cwd(), env = process.env, createExplicit = true }: any = {}) {
  const explicit = projectDir ? path.resolve(projectDir) : null;
  if (explicit) {
    const ace = path.join(explicit, '.ace');
    if (createExplicit) fs.mkdirSync(ace, { recursive: true });
    return path.join(ace, 'tool-usage.ndjson');
  }

  const candidates = [
    cwd,
    env.ACE_REPO_ROOT,
    env.ACE_WORKTREE_PATH,
  ].filter(Boolean).map((candidate: any) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (hasAceDir(candidate)) {
      const ledgerDir = path.join(candidate, '.ace');
      return path.join(ledgerDir, 'tool-usage.ndjson');
    }
  }

  const tag = normalize(env.ACE_USER_DATA_TAG).replace(/[^a-z0-9_-]+/g, '-') || 'default';
  const fallbackDir = path.join(os.tmpdir(), 'ace-tool-ledger', tag);
  fs.mkdirSync(fallbackDir, { recursive: true });
  return path.join(fallbackDir, 'tool-usage.ndjson');
}

function sanitizeEvent(input: any = {}) {
  return {
    schema: TOOL_USE_SCHEMA,
    at: input.at || new Date().toISOString(),
    command: compactCommand(input.command),
    role: normalize(input.role) || null,
    phase: normalize(input.phase) || null,
    workspaceId: input.workspaceId || null,
    missionId: input.missionId || null,
    taskId: input.taskId || null,
    streamId: input.streamId || null,
    runId: input.runId ? String(input.runId).slice(0, 120) : null,
    ok: input.ok !== false,
    error: input.error ? String(input.error).slice(0, 500) : null,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
  };
}

function sanitizeBatchResult(input: any = {}) {
  const results = Array.isArray(input.results) ? input.results : [];
  return {
    schema: TOOL_BATCH_RESULT_SCHEMA,
    at: input.at || new Date().toISOString(),
    command: 'tool batch',
    role: normalize(input.role) || null,
    phase: normalize(input.phase) || null,
    workspaceId: input.workspaceId || null,
    missionId: input.missionId || null,
    taskId: input.taskId || null,
    streamId: input.streamId || null,
    runId: input.runId ? String(input.runId).slice(0, 120) : null,
    ok: input.ok !== false && results.every((result: any) => result?.ok !== false),
    parallel: input.parallel === true,
    maxConcurrency: Number.isFinite(input.maxConcurrency) ? Math.max(1, Math.round(input.maxConcurrency)) : null,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
    results: results.map((result: any) => ({
      id: String(result?.id || '').slice(0, 120),
      command: compactCommand(result?.command),
      runId: input.runId ? String(input.runId).slice(0, 120) : null,
      ok: result?.ok !== false,
      isError: result?.isError === true,
      durationMs: Number.isFinite(result?.durationMs) ? Math.max(0, Math.round(result.durationMs)) : null,
      summary: result?.summary ? String(result.summary).slice(0, 500) : null,
      error: result?.error ? String(result.error).slice(0, 500) : null,
    })),
  };
}

function writeToolUseEvent(input: any = {}) {
  if (process.env.ACE_TOOL_LEDGER_DISABLE === '1') {
    return { written: false, disabled: true, path: null, event: sanitizeEvent(input) };
  }
  const ledgerPath = input.ledgerPath || resolveLedgerPath({ projectDir: input.projectDir, cwd: input.cwd, env: input.env || process.env });
  const event = sanitizeEvent(input);
  if (!event.command) return { written: false, path: ledgerPath, event, warning: 'missing command' };
  appendNdjson(ledgerPath, event);
  return { written: true, path: ledgerPath, event };
}

function writeToolBatchResult(input: any = {}) {
  if (process.env.ACE_TOOL_LEDGER_DISABLE === '1') {
    return { written: false, disabled: true, path: null, event: sanitizeBatchResult(input) };
  }
  const ledgerPath = input.ledgerPath || resolveLedgerPath({ projectDir: input.projectDir, cwd: input.cwd, env: input.env || process.env });
  const event = sanitizeBatchResult(input);
  if (!event.results.length) return { written: false, path: ledgerPath, event, warning: 'missing results' };
  appendNdjson(ledgerPath, event);
  return { written: true, path: ledgerPath, event };
}

function readToolUseEvents({ ledgerPath, projectDir, cwd = process.cwd(), env = process.env }: any = {}) {
  const filePath = ledgerPath || resolveLedgerPath({ projectDir, cwd, env, createExplicit: false });
  if (!filePath || !fs.existsSync(filePath)) return { path: filePath, events: [] };
  const events = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && (parsed.schema === TOOL_USE_SCHEMA || parsed.schema === TOOL_BATCH_RESULT_SCHEMA)) events.push(parsed);
    } catch {
      // Corrupt lines are ignored; audit reports missing proof rather than crashing.
    }
  }
  return { path: filePath, events };
}

function eventCommands(event: any) {
  if (event?.schema === TOOL_BATCH_RESULT_SCHEMA) {
    return (Array.isArray(event.results) ? event.results : [])
      .filter((result: any) => result?.ok !== false)
      .map((result: any) => compactCommand(result?.command))
      .filter(Boolean);
  }
  const command = compactCommand(event?.command);
  return command ? [command] : [];
}

function isValidationProofCommand(command: any) {
  return commandMatchesGroup(command, 'validation artifact|validation clawpatch');
}

function eventTimestamp(event: any) {
  const at = event && event.at;
  if (!at) return null;
  const ms = Date.parse(String(at));
  return Number.isFinite(ms) ? ms : null;
}

function matchesAuditFilter(event: any, filter: any) {
  if (filter.role && event.role && normalize(event.role) !== normalize(filter.role)) return false;
  if (filter.phase && event.phase && normalize(event.phase) !== normalize(filter.phase)) {
    const phase = normalize(filter.phase);
    const eventPhase = normalize(event.phase);
    const validationProof = eventCommands(event).some(isValidationProofCommand);
    if (!(validationProof && phase === 'gate' && (eventPhase === 'validate' || eventPhase === 'finish'))) return false;
  }
  if (filter.workspaceId && event.workspaceId && event.workspaceId !== filter.workspaceId) return false;
  if (filter.missionId && event.missionId && event.missionId !== filter.missionId) return false;
  if (filter.taskId && event.taskId && event.taskId !== filter.taskId) return false;
  if (filter.streamId && event.streamId && event.streamId !== filter.streamId) return false;
  if (filter.runId) {
    // run-scoped audit: ONLY same-run events qualify. Historical events
    // and events without a run id cannot satisfy a scoped audit.
    if (!event.runId || event.runId !== filter.runId) return false;
  }
  if (filter.sinceMs != null) {
    const ts = eventTimestamp(event);
    if (ts == null || ts < filter.sinceMs) return false;
  }
  return true;
}

function resolveSinceMs(input: any) {
  if (input.sinceMs != null && Number.isFinite(input.sinceMs)) return Number(input.sinceMs);
  if (input.since) {
    const parsed = Date.parse(String(input.since));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (input.windowMs != null && Number.isFinite(input.windowMs) && Number(input.windowMs) > 0) {
    return Date.now() - Number(input.windowMs);
  }
  return null;
}

function auditToolUse(input: any = {}) {
  const role = normalize(input.role);
  const phase = normalize(input.phase);
  const runId = input.runId ? String(input.runId).trim() : null;
  const sinceMs = resolveSinceMs(input);
  const { path: ledgerPath, events } = input.events
    ? { path: input.ledgerPath || null, events: input.events }
    : readToolUseEvents(input);
  // Drop self-audit events from the proof pool. `tool audit` writing itself
  // before the audit runs would let a fresh audit satisfy the same audit's
  // own required-event check; that's the same kind of stale-evidence leak
  // run-scoping is designed to close.
  const proofPool = events.filter((event: any) => {
    const commands = eventCommands(event);
    return !commands.some((command: any) => commandMatchesGroup(command, 'tool audit'));
  });
  const relevant = proofPool.filter((event: any) => matchesAuditFilter(event, {
    role,
    phase,
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    taskId: input.taskId,
    streamId: input.streamId,
    runId,
    sinceMs,
  }));
  const required = REQUIRED_EVENTS[requiredKey(role, phase)] ? REQUIRED_EVENTS[requiredKey(role, phase)].slice() : [];
  if (input.clawpatchRequired === true && (phase === 'validate' || phase === 'gate' || phase === 'finish')) {
    required.push('validation clawpatch');
  }
  const commandsSeen = Array.from(new Set(relevant.flatMap((event: any) => eventCommands(event))));
  // A batch result carries per-child ok flags and eventCommands() already
  // drops failed children, so the outer ok (false when ANY child failed)
  // must not void the surviving children's proof — otherwise one failed
  // optional read silently locks the orchestrator out of dispatch.
  const eventCarriesProof = (event: any) =>
    event?.schema === TOOL_BATCH_RESULT_SCHEMA || event?.ok !== false;
  const missingRequiredEvents = required.filter((group: any) => !relevant.some((event: any) => eventCarriesProof(event) && eventCommands(event).some((command: any) => commandMatchesGroup(command, group))));
  const lastToolAt = relevant.length ? relevant.map((event: any) => event.at).sort().slice(-1)[0] : null;
  const driftWarnings = [];
  if (role === 'orchestrator' && phase === 'start' && missingRequiredEvents.includes('run board|run list')) {
    driftWarnings.push('orchestrator has not inspected run ledger before dispatch');
  }
  if (input.clawpatchRequired === true && missingRequiredEvents.includes('validation clawpatch')) {
    driftWarnings.push('Clawpatch validation required for long/wave work but no validation clawpatch event was recorded');
  }
  return {
    ok: missingRequiredEvents.length === 0,
    schema: TOOL_AUDIT_SCHEMA,
    role: role || null,
    phase: phase || null,
    runId,
    sinceMs,
    ledgerPath,
    missingRequiredEvents,
    lastToolAt,
    commandsSeen,
    driftWarnings,
  };
}

function asList(value: any) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeBatchInput(input: any = {}) {
  const calls = Array.isArray(input.calls) ? input.calls : [];
  return {
    schema: input.schema || TOOL_BATCH_SCHEMA,
    role: normalize(input.role) || null,
    phase: normalize(input.phase) || null,
    workspaceId: input.workspaceId || input.workspace || null,
    missionId: input.missionId || input.mission || null,
    taskId: input.taskId || input.task || null,
    streamId: input.streamId || input.stream || null,
    runId: input.runId || input.run || null,
    calls: calls.map((call: any, index: number) => ({
      id: String(call?.id || `call_${index + 1}`),
      command: compactCommand(call?.command),
      args: call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {},
      dependsOn: asList(call?.dependsOn || call?.after).map(String).filter(Boolean),
    })),
    dependencies: Array.isArray(input.dependencies) ? input.dependencies : [],
  };
}

function isUnsafeBatchCommand(command: any) {
  const normalized = normalize(command);
  if (!normalized) return true;
  if (/\b(merge|cleanup|delete|reset|force-push|install|rebuild|relaunch)\b/.test(normalized)) return true;
  if (normalized === 'validation clawpatch fix' || normalized.startsWith('validation clawpatch fix ')) return true;
  if (normalized === 'clawpatch fix' || normalized.startsWith('clawpatch fix ')) return true;
  return false;
}

function commandTargetKey(call: any) {
  const args = call?.args || {};
  return args.worktree || args.workspace || args.workspaceId || args.mission || args.missionId || args.task || args.taskId || null;
}

function validateBatchInput(input: any = {}, options: any = {}) {
  const batch = normalizeBatchInput(input);
  const errors = [];
  if (batch.schema !== TOOL_BATCH_SCHEMA) errors.push(`schema must be ${TOOL_BATCH_SCHEMA}`);
  if (!batch.calls.length) errors.push('calls must contain at least one call');

  const ids = new Set();
  for (const call of batch.calls) {
    if (!call.id) errors.push('call id is required');
    if (ids.has(call.id)) errors.push(`duplicate call id: ${call.id}`);
    ids.add(call.id);
    if (!call.command) {
      errors.push(`call ${call.id} is missing command`);
      continue;
    }
    const commandName = normalize(call.command);
    if (!ALLOWED_COMMANDS.includes(commandName)) errors.push(`call ${call.id} uses unallowed command: ${call.command}`);
    if (isUnsafeBatchCommand(commandName)) errors.push(`call ${call.id} uses unsafe command for batching: ${call.command}`);
    if (BATCH_MUTATING_COMMANDS.has(commandName)) {
      const phase = normalize(batch.phase);
      if (!BATCH_MUTATION_PHASES.has(phase)) {
        errors.push(`call ${call.id} mutates state but phase ${phase || '(none)'} does not permit batched mutation`);
      }
      if (!commandTargetKey(call)) {
        errors.push(`call ${call.id} mutates state but has no task, mission, workspace, or worktree target`);
      }
    } else if (!BATCH_SAFE_COMMANDS.has(commandName)) {
      errors.push(`call ${call.id} is not safe for default batching: ${call.command}`);
    }
  }

  const mutatingTargets = new Set();
  for (const call of batch.calls) {
    const commandName = normalize(call.command);
    if (!BATCH_MUTATING_COMMANDS.has(commandName)) continue;
    const key = commandTargetKey(call);
    if (!key) continue;
    if (mutatingTargets.has(key)) errors.push(`multiple mutating calls target ${key}; batch mutations must use separate targets`);
    mutatingTargets.add(key);
  }

  try {
    dependencyLayers(batch);
  } catch (err) {
    errors.push(err?.message || String(err));
  }

  if (errors.length && options.throwOnError !== false) {
    const err: any = new Error(errors.join('; '));
    err.code = 'invalid_batch';
    err.errors = errors;
    throw err;
  }
  return { ok: errors.length === 0, errors, batch };
}

function dependencyLayers(input: any = {}) {
  const batch = input.calls ? normalizeBatchInput(input) : input;
  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const byId = new Map(calls.map((call: any) => [call.id, call]));
  const deps = new Map(calls.map((call: any) => [call.id, new Set(call.dependsOn || [])]));

  for (const item of batch.dependencies || []) {
    if (Array.isArray(item) && item.length >= 2) {
      const [before, after] = item.map(String);
      if (!deps.has(after)) throw new Error(`dependency references unknown call: ${after}`);
      deps.get(after).add(before);
      continue;
    }
    if (item && typeof item === 'object') {
      const id = String(item.id || item.call || item.after || '');
      const dependsOn = item.dependsOn || item.depends_on || item.before || item.requires;
      if (item.before && item.after && !item.dependsOn && !item.requires) {
        const before = String(item.before);
        const after = String(item.after);
        if (!deps.has(after)) throw new Error(`dependency references unknown call: ${after}`);
        deps.get(after).add(before);
        continue;
      }
      if (!id) throw new Error('dependency is missing call id');
      if (!deps.has(id)) throw new Error(`dependency references unknown call: ${id}`);
      for (const dep of asList(dependsOn).map(String).filter(Boolean)) deps.get(id).add(dep);
      continue;
    }
    throw new Error('dependency must be an object or [before, after] tuple');
  }

  for (const [id, callDeps] of deps.entries()) {
    for (const dep of callDeps) {
      if (!byId.has(dep)) throw new Error(`call ${id} depends on unknown call: ${dep}`);
      if (dep === id) throw new Error(`call ${id} depends on itself`);
    }
  }

  const layers = [];
  const done = new Set();
  while (done.size < calls.length) {
    const layer = calls.filter((call: any) => !done.has(call.id) && Array.from(deps.get(call.id) || []).every((dep) => done.has(dep)));
    if (!layer.length) throw new Error('dependency cycle detected');
    layers.push(layer);
    for (const call of layer) done.add(call.id);
  }
  return layers;
}

function topLevelDir(filePath: any) {
  const text = String(filePath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const first = text.split('/').filter(Boolean)[0];
  return first || null;
}

function hasAcceptanceRiskClaim(input: any) {
  const text = asList(input.acceptance).join('\n').toLowerCase();
  return /\b(build|deploy|security|customer-impact|customer impact|data loss|release)\b/.test(text);
}

function requiresClawpatchValidation(input: any = {}) {
  const sizeClass = normalize(input.sizeClass ?? input.size_class);
  const taskClass = normalize(input.taskClass ?? input.task_class).replace(/-/g, '_');
  const taskType = normalize(input.taskType ?? input.task_type).replace(/-/g, '_');
  const nativeTeamMode = normalize(input.nativeTeamMode ?? input.native_team_mode);
  const roleMode = normalize(input.roleMode ?? input.role_mode);
  const risk = normalize(input.risk);
  const riskLevel = normalize(input.riskLevel ?? input.risk_level);
  const capabilities = asList(input.capabilities).map(normalize);
  const changedTopLevels = Array.from(new Set(asList(input.changedPaths || input.changed_files).map(topLevelDir).filter(Boolean)));
  const laneCount = Number(input.laneCount ?? input.lanesAttached ?? input.lanes?.length ?? 0);

  if (input.explicitlyRequested === true || input.clawpatch === true || input.requireClawpatch === true || input.required === true || input.clawpatchRequired === true || input.clawpatch_required === true) return true;
  if (taskType === 'validator_merger' || taskType === 'github_merger') return true;
  if (input.highRisk === true || input.high_risk === true) return true;
  if (risk === 'medium' || risk === 'high' || risk === 'critical' || riskLevel === 'medium' || riskLevel === 'high' || riskLevel === 'critical') return true;
  if (capabilities.some((cap: any) => HIGH_RISK_CAPABILITIES.has(cap))) return true;
  if ((input.waveId || input.wave || input.missionWaveDispatch === true || laneCount > 1) && (risk === 'high' || riskLevel === 'high')) return true;
  if ((nativeTeamMode === 'on' || nativeTeamMode === 'optional') && roleMode !== 'reviewer' && roleMode !== 'no-code' && (risk === 'high' || riskLevel === 'high')) return true;
  if (LONG_SIZE_CLASSES.has(sizeClass) && (risk === 'high' || riskLevel === 'high')) return true;
  if ((taskClass === 'review_validate' || taskClass === 'pr_merge_cleanup') && (risk === 'high' || riskLevel === 'high')) return true;
  if (changedTopLevels.length > 1 && (risk === 'high' || riskLevel === 'high')) return true;
  if (hasAcceptanceRiskClaim(input)) return true;

  const smallFast =
    SMALL_SIZE_CLASSES.has(sizeClass) &&
    (!taskType || SMALL_FAST_TASK_TYPES.has(taskType.replace(/_/g, '-')) || SMALL_FAST_TASK_TYPES.has(taskType)) &&
    !input.waveId &&
    input.validationRequired !== true &&
    input.highRisk !== true &&
    !capabilities.some((cap: any) => HIGH_RISK_CAPABILITIES.has(cap));
  return !smallFast && false;
}

module.exports = {
  ALLOWED_COMMANDS,
  CLAWPATCH_SCHEMA,
  PHASES,
  REQUIRED_EVENTS,
  ROLES,
  TOOL_AUDIT_SCHEMA,
  TOOL_BATCH_RESULT_SCHEMA,
  TOOL_BATCH_SCHEMA,
  TOOL_CONTRACT_SCHEMA,
  TOOL_USE_SCHEMA,
  auditToolUse,
  commandMatchesGroup,
  dependencyLayers,
  isUnsafeBatchCommand,
  manifestFor,
  normalizeBatchInput,
  readToolUseEvents,
  requiresClawpatchValidation,
  resolveLedgerPath,
  sanitizeBatchResult,
  sanitizeEvent,
  validateBatchInput,
  writeToolBatchResult,
  writeToolUseEvent,
};
