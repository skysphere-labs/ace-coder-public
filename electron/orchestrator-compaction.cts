const DEFAULT_THRESHOLD = 5;
const STREAM_SQL =
  'SELECT id FROM conversations WHERE task_id=? AND is_main=1 ORDER BY created_at DESC LIMIT 1';
const { checkpointTaskResumePacket } = require('./mission-domain-stub.cjs');
const RESUME_PROMPT_MAX_CHARS = 8_000;

function resolveThreshold(input: any) {
  const envValue = Number.parseInt(process.env.ACE_COMPACT_AFTER || '', 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  if (Number.isFinite(input) && input > 0) return input;
  return DEFAULT_THRESHOLD;
}

function renderResumePrompt(packet: any) {
  const compactPacket = packet && typeof packet === 'object' ? packet : {};
  const body = JSON.stringify(compactPacket, null, 2);
  const prompt = [
    'Compaction complete.',
    'ACE_RESUME_PACKET v1 follows. Treat it as the only resume source until live rechecks pass.',
    body,
    '',
    'Reload contract:',
    '- Re-read the bundled skill `ace-hermes-router` (in your cwd at `.claude/skills/` or equivalent) before your next step.',
    `- Primary plan doc: ${compactPacket.primaryPlanDoc || '(missing)'}`,
    `- Current gate: ${compactPacket.currentGate || 'blocked'}`,
    `- Forbidden actions: ${(compactPacket.forbiddenActions || []).join('; ') || 'do not act until state is rechecked'}`,
    '- Run live recheck commands before reporting or acting:',
    ...((compactPacket.liveRecheckCommands || []).map((cmd: any) => `  - ${cmd}`)),
    `- Next action: ${compactPacket.nextAction || 'BLOCKED: missing resume state'}`,
    'Continue only from durable Mission/GitHub/runtime state.',
  ].join('\n');
  if (prompt.length <= RESUME_PROMPT_MAX_CHARS) return prompt;
  return [
    prompt.slice(0, RESUME_PROMPT_MAX_CHARS - 160),
    '',
    `[resume prompt capped at ${RESUME_PROMPT_MAX_CHARS} chars; read ${compactPacket.primaryPlanDoc || 'the mission artifact'} for full context]`,
  ].join('\n');
}

function createCompactionController({
  aceStore,
  db,
  streamApi,
  threshold,
  logger = console,
  resumeCheckpoint = checkpointTaskResumePacket,
}: any) {
  const counts = new Map<any, number>();
  const inFlight = new Set<any>();
  const limit = resolveThreshold(threshold);

  function log(level: any, message: any, err?: any) {
    const fn = logger && typeof logger[level] === 'function' ? logger[level] : logger?.log;
    if (typeof fn === 'function') fn.call(logger, message, err);
  }

  function isCleanupEvent(change: any) {
    return change?.event === 'cleaned' || (change?.from === 'integrate' && change?.to === 'cleanup');
  }

  function resolveStreamId(taskId: any) {
    const row = db.prepare(STREAM_SQL).get(taskId);
    return row?.id ? `conversation:${row.id}` : null;
  }

  async function maybeCompact(taskId: any) {
    const streamId = resolveStreamId(taskId);
    if (!streamId) {
      log('warn', `[orchestrator-compaction] no main conversation for task ${taskId}`);
      return;
    }
    const state = (await streamApi.getState({ streamId }))?.state || 'unknown';
    if (state !== 'awaiting-input' && state !== 'turn-complete') {
      log('warn', `[orchestrator-compaction] compaction deferred: state=${state}`);
      return;
    }
    let resume;
    try {
      resume = await Promise.resolve(resumeCheckpoint(db, { taskId }));
    } catch (err) {
      log('warn', `[orchestrator-compaction] compaction deferred: resume packet failed for ${taskId}`, err);
      return;
    }
    const reloadPrompt = renderResumePrompt(resume?.packet || resume);
    await streamApi.sendInput({ streamId, text: '/compact', mode: 'type' });
    await streamApi.submit({ streamId });
    await streamApi.waitFor({ streamId, predicate: { turnComplete: true }, timeoutMs: 300_000 });
    await streamApi.sendInput({ streamId, text: reloadPrompt, mode: 'type' });
    await streamApi.submit({ streamId });
    counts.set(taskId, 0);
  }

  async function handle(change: any) {
    const taskId = typeof change?.taskId === 'string' ? change.taskId : null;
    if (!taskId || !isCleanupEvent(change) || inFlight.has(taskId)) return;
    counts.set(taskId, (counts.get(taskId) || 0) + 1);
    if ((counts.get(taskId) || 0) < limit) return;
    inFlight.add(taskId);
    try {
      await maybeCompact(taskId);
    } catch (err) {
      log('error', `[orchestrator-compaction] compaction failed for ${taskId}`, err);
    } finally {
      inFlight.delete(taskId);
    }
  }

  function start() {
    const listener = (change: any) => {
      Promise.resolve().then(() => handle(change)).catch((err) => {
        log('error', '[orchestrator-compaction] unhandled event failure', err);
      });
    };
    const unsub = aceStore.on('orchestrator-runtime:state-change', listener);
    if (typeof unsub === 'function') return unsub;
    return () => {
      if (typeof aceStore.off === 'function') aceStore.off('orchestrator-runtime:state-change', listener);
      else if (typeof aceStore.removeListener === 'function') aceStore.removeListener('orchestrator-runtime:state-change', listener);
    };
  }

  return { start };
}

module.exports = {
  createCompactionController,
  renderResumePrompt,
};
