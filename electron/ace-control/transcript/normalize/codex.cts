function textFromContent(content: any) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && typeof b === 'object' && (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text'))
    .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseLine(line: any) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toMs(ts: any) {
  if (!ts) return Date.now();
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

// Codex's `agent_message` / `agent_message_delta` events don't consistently
// carry a turn_id, so we can't key upserts off the event itself. `task_started`
// does carry turn_id — track it per stream and use that as the sticky key for
// streaming/final agent and reasoning entries. Without this, successive turns
// would collide on the same key and later replies overwrite earlier ones in
// place, making the chat view read out of order.
const turnContexts = new Map();

function ensureCtx(streamId: any) {
  let ctx = turnContexts.get(streamId);
  if (!ctx) {
    ctx = { currentTurnId: null, turnSeq: 0, messageSeqs: {} };
    turnContexts.set(streamId, ctx);
  }
  if (!ctx.messageSeqs) ctx.messageSeqs = {};
  return ctx;
}

// Sticky key for the CURRENTLY-OPEN message slot of a given kind
// ('agent-stream', 'reasoning-stream'). Deltas append into it; the final
// event finalizes it. `closeMessageSlot` rolls the per-turn counter so the
// next message on the same turn gets its own entry at its own arrival
// position instead of stomping the previous one.
function getMessageKey(streamId: any, kind: any) {
  const ctx = ensureCtx(streamId);
  const turnId = ctx.currentTurnId || 'x';
  const msgSeq = ctx.messageSeqs[kind] || 0;
  return `${kind}:${turnId}:${ctx.turnSeq}:${msgSeq}`;
}

function closeMessageSlot(streamId: any, kind: any) {
  const ctx = ensureCtx(streamId);
  ctx.messageSeqs[kind] = (ctx.messageSeqs[kind] || 0) + 1;
}

function advanceTurn(streamId: any, turnId: any) {
  const ctx = ensureCtx(streamId);
  ctx.currentTurnId = turnId || ctx.currentTurnId || null;
  ctx.turnSeq += 1;
  ctx.messageSeqs = {};
  ctx.sawEventReasoning = false;
}

function resetTurnContext(streamId: any) {
  turnContexts.delete(streamId);
}

function serializeTurnContext(streamId: any) {
  const ctx = turnContexts.get(streamId);
  if (!ctx) return null;
  try {
    return JSON.stringify({
      currentTurnId: ctx.currentTurnId || null,
      turnSeq: ctx.turnSeq || 0,
      messageSeqs: ctx.messageSeqs || {},
    });
  } catch {
    return null;
  }
}

function restoreTurnContext(streamId: any, serialized: any) {
  if (!serialized) return;
  try {
    const parsed = JSON.parse(serialized);
    turnContexts.set(streamId, {
      currentTurnId: parsed.currentTurnId || null,
      turnSeq: parsed.turnSeq | 0,
      messageSeqs: parsed.messageSeqs && typeof parsed.messageSeqs === 'object' ? parsed.messageSeqs : {},
    });
  } catch { /* ignore */ }
}

const TOOL_STATUS: any = {
  success: 'ok',
  completed: 'ok',
  error: 'error',
  failed: 'error',
  timeout: 'error',
  denied: 'denied',
  canceled: 'canceled',
  cancelled: 'canceled',
  running: 'running',
};

// Maps a single Codex JSONL event to zero or more normalize operations.
// Returns ops of shape:
//   { kind: 'append', entry }
//   { kind: 'upsert', key, build(prev) -> entry }
//   { kind: 'reset' }
//   { kind: 'warn', code }
function normalizeCodexEvent(event: any, ctx: any = {}) {
  const ops: any[] = [];
  if (!event || typeof event !== 'object') return ops;
  const { type, timestamp, payload } = event;
  const tAt = toMs(timestamp);
  const streamId = ctx.streamId || 'default';
  if (!payload || typeof payload !== 'object') return ops;

  if (type === 'session_meta') {
    resetTurnContext(streamId);
    // Cleared sessions start a fresh file, so session_meta always implies a
    // clean slate for this link. Emit a system marker and let the caller
    // decide whether to reset by file identity — we still append because a
    // resume on the same file simply re-reads from offset 0.
    ops.push({
      kind: 'append',
      entry: {
        role: 'system',
        subtype: 'session_start',
        text: payload.cli_version ? `Codex ${payload.cli_version}` : 'Codex session started',
        lifecycle: 'finished',
        tAt,
      },
    });
    return ops;
  }

  if (type === 'response_item') {
    const inner = payload as any;
    const itemType = inner?.type;
    if (itemType === 'reasoning') {
      // Direct-Codex path: event_msg is the canonical reasoning channel. If it
      // already surfaced reasoning this turn, skip the response_item duplicate
      // (often just encrypted_content with no summary -> "Private reasoning").
      if (ensureCtx(streamId).sawEventReasoning) return ops;
      const text = reasoningTextFromResponseItem(inner);
      if (!text) return ops;
      ops.push({
        kind: 'upsert',
        key: `reasoning-item:${inner.id || tAt}`,
        build: () => ({
          role: 'reasoning',
          text,
          subject: inner.encrypted_content && !reasoningSummaryText(inner) ? 'Private reasoning' : undefined,
          lifecycle: 'finished',
          tAt,
        }),
      });
      return ops;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = inner.call_id || inner.id || null;
      if (!callId) return ops;
      const name = inner.name || 'tool';
      const args = parseToolArgs(inner.arguments ?? inner.input);
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev) => ({
          role: 'tool',
          name: prev?.name || name,
          args: prev?.args ?? args,
          result: prev?.result,
          status: prev?.status === 'ok' || prev?.status === 'error' ? prev.status : 'running',
          lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
      return ops;
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = inner.call_id || inner.id || null;
      if (!callId) return ops;
      const rawOutput = inner.output ?? inner.result ?? inner.content ?? '';
      const status = inferToolStatus(inner, rawOutput);
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev) => ({
          role: 'tool',
          name: prev?.name || inner.name || 'tool',
          args: prev?.args,
          result: typeof rawOutput === 'string' ? rawOutput : safeStringify(rawOutput),
          status,
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
      return ops;
    }
    if (itemType === 'tool_search_call') {
      const callId = inner.call_id || inner.id || null;
      if (!callId) return ops;
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev) => ({
          role: 'tool',
          name: prev?.name || 'tool_search',
          args: prev?.args ?? inner.arguments,
          result: prev?.result,
          status: prev?.status === 'ok' || prev?.status === 'error' ? prev.status : 'running',
          lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
      return ops;
    }
    if (itemType === 'tool_search_output') {
      const callId = inner.call_id || inner.id || null;
      if (!callId) return ops;
      const status = inferToolStatus(inner, inner.tools ?? inner.output ?? inner.result);
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev) => ({
          role: 'tool',
          name: prev?.name || 'tool_search',
          args: prev?.args,
          result: inner.tools ?? inner.output ?? inner.result,
          status,
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
      return ops;
    }
    return ops;
  }

  // Known top-level event kinds that don't shape the transcript itself:
  // `turn_context` (per-turn model/effort metadata), `compacted_item` (the
  // compacted-history placeholder codex writes on /compact). Surface nothing
  // rather than warning.
  if (type === 'turn_context' || type === 'compacted_item' || type === 'compacted') {
    return ops;
  }
  if (type !== 'event_msg') {
    ops.push({ kind: 'warn', code: `codex:${type}` });
    return ops;
  }

  const inner = payload;
  const kind = inner.type;
  switch (kind) {
    case 'task_started': {
      // Advance to a new turn BEFORE emitting anything so agent/reasoning
      // entries that follow use a fresh sticky key and don't collide with
      // the previous turn's entries.
      advanceTurn(streamId, inner.turn_id);
      ops.push({
        kind: 'append',
        entry: {
          role: 'system',
          subtype: 'task_started',
          text: inner.collaboration_mode_kind
            ? `Turn started (${inner.collaboration_mode_kind})`
            : 'Turn started',
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }
    case 'turn_finished':
    case 'task_complete':
    case 'agent_finished': {
      ops.push({
        kind: 'append',
        entry: { role: 'system', subtype: 'turn_finished', lifecycle: 'finished', tAt },
      });
      return ops;
    }
    case 'turn_aborted': {
      ops.push({
        kind: 'append',
        entry: {
          role: 'system',
          subtype: 'info',
          text: inner.reason || inner.message || 'Turn aborted.',
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }
    case 'user_message': {
      const text = typeof inner.message === 'string'
        ? inner.message
        : typeof inner.text === 'string'
        ? inner.text
        : '';
      if (!text) return ops;
      ops.push({
        kind: 'append',
        entry: { role: 'user', text, lifecycle: 'finished', tAt },
      });
      return ops;
    }
    case 'agent_message': {
      const text = typeof inner.message === 'string' ? inner.message : '';
      if (!text) return ops;
      // Finalizes the current agent message slot (whether built up from
      // deltas or emitted whole). Then CLOSE the slot so any subsequent
      // agent_message this turn starts a fresh entry at its own arrival
      // position, not at the earlier one's id.
      const key = getMessageKey(streamId, 'agent-stream');
      ops.push({
        kind: 'upsert',
        key,
        build: () => ({
          role: 'agent',
          text,
          lifecycle: 'finished',
          tAt,
          phase: inner.phase || undefined,
        }),
      });
      closeMessageSlot(streamId, 'agent-stream');
      return ops;
    }
    case 'agent_message_delta': {
      const text = typeof inner.delta === 'string' ? inner.delta : '';
      if (!text) return ops;
      const key = getMessageKey(streamId, 'agent-stream');
      ops.push({
        kind: 'upsert',
        key,
        build: (prev: any) => ({
          role: 'agent',
          text: (prev?.text || '') + text,
          lifecycle: 'open',
          tAt,
        }),
      });
      return ops;
    }
    case 'agent_reasoning':
    case 'reasoning': {
      const text = typeof inner.text === 'string' ? inner.text : '';
      if (!text) return ops;
      ensureCtx(streamId).sawEventReasoning = true;
      const key = getMessageKey(streamId, 'reasoning-stream');
      ops.push({
        kind: 'upsert',
        key,
        build: () => ({
          role: 'reasoning',
          text,
          subject: inner.title || undefined,
          lifecycle: 'finished',
          tAt,
        }),
      });
      closeMessageSlot(streamId, 'reasoning-stream');
      return ops;
    }
    case 'agent_reasoning_delta': {
      const text = typeof inner.delta === 'string' ? inner.delta : '';
      if (!text) return ops;
      ensureCtx(streamId).sawEventReasoning = true;
      const key = getMessageKey(streamId, 'reasoning-stream');
      ops.push({
        kind: 'upsert',
        key,
        build: (prev: any) => ({
          role: 'reasoning',
          text: (prev?.text || '') + text,
          lifecycle: 'open',
          tAt,
        }),
      });
      return ops;
    }
    case 'tool_call':
    case 'tool_started':
    case 'exec_command_begin':
    case 'patch_apply_begin': {
      const call = extractCall(inner);
      const key = `tool:${call.callId || ((inner.turn_id || ensureCtx(streamId).currentTurnId || 'x') + ':' + call.name)}`;
      ops.push({
        kind: 'upsert',
        key,
        build: () => ({
          role: 'tool',
          name: call.name,
          args: call.args,
          status: 'running',
          lifecycle: 'open',
          tAt,
          turnId: inner.turn_id || undefined,
          callId: call.callId || undefined,
        }),
      });
      return ops;
    }
    case 'tool_result':
    case 'tool_finished':
    case 'tool_call_result':
    case 'exec_command_end':
    case 'patch_apply_end':
    case 'mcp_tool_call_end': {
      const call = extractCall(inner);
      const key = `tool:${call.callId || ((inner.turn_id || ensureCtx(streamId).currentTurnId || 'x') + ':' + call.name)}`;
      const status = TOOL_STATUS[String(inner.status || inner.result_kind || '').toLowerCase()]
        || (inner.is_error || inner.error || inner.result?.Err || inner.result?.err ? 'error' : 'ok');
      ops.push({
        kind: 'upsert',
        key,
        build: (prev: any) => ({
          role: 'tool',
          name: prev?.name || call.name || 'tool',
          args: prev?.args ?? call.args,
          result: call.result ?? prev?.result,
          status,
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
          turnId: inner.turn_id || prev?.turnId,
          callId: call.callId || prev?.callId,
        }),
      });
      return ops;
    }
    case 'approval_request':
    case 'exec_approval_request':
    case 'patch_approval_request':
    case 'request_approval': {
      const key = `approval:${inner.request_id || inner.approval_id || tAt}`;
      ops.push({
        kind: 'upsert',
        key,
        build: () => ({
          role: 'approval',
          prompt: inner.reason || inner.prompt || 'Approval requested',
          context: summarizeApproval(inner),
          status: 'pending',
          lifecycle: 'open',
          tAt,
        }),
      });
      return ops;
    }
    case 'approval_response':
    case 'exec_approval_response': {
      const key = `approval:${inner.request_id || inner.approval_id || tAt}`;
      ops.push({
        kind: 'upsert',
        key,
        build: (prev: any) => ({
          role: 'approval',
          prompt: prev?.prompt || 'Approval',
          context: prev?.context || '',
          status: inner.approved === false ? 'denied' : 'approved',
          lifecycle: 'finished',
          tAt,
        }),
      });
      return ops;
    }
    case 'token_count':
    case 'rate_limits':
      // Metered signals — not transcript-shaped.
      return ops;
    case 'error':
    case 'stream_error': {
      ops.push({
        kind: 'append',
        entry: {
          role: 'system',
          subtype: 'error',
          text: inner.message || 'Codex error',
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }
    case 'notification': {
      return ops;
    }
    case 'session_configured':
    case 'turn_context':
    case 'turn_diff':
      // Metadata the chat view doesn't render.
      return ops;
    case 'compact_started': {
      // Intentionally a no-op for transcript content. Emitting a placeholder
      // replace here would wipe history immediately and then wipe it again
      // when compact_finished arrives with the real summary — one flicker.
      // The PTY state plane already signals "work in progress" via the
      // busy indicator, so there's nothing the user loses by waiting for
      // compact_finished to drive the replace.
      return ops;
    }
    case 'compact_finished': {
      const text = typeof inner.summary === 'string' && inner.summary.trim()
        ? inner.summary
        : typeof inner.message === 'string' && inner.message.trim()
        ? inner.message
        : 'Prior conversation compacted.';
      ops.push({
        kind: 'replace',
        summary: {
          role: 'system',
          subtype: 'info',
          text,
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }
    case 'context_compacted': {
      ops.push({
        kind: 'replace',
        summary: {
          role: 'system',
          subtype: 'info',
          text: 'Prior conversation compacted.',
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }
    default: {
      ops.push({ kind: 'warn', code: `codex:event_msg:${kind || 'unknown'}` });
      return ops;
    }
  }
}

function summarizeApproval(inner: any) {
  if (inner.command) {
    const cmd = Array.isArray(inner.command) ? inner.command.join(' ') : String(inner.command);
    return `$ ${cmd}`;
  }
  if (inner.path || inner.file_path) return `file: ${inner.path || inner.file_path}`;
  if (inner.action) return String(inner.action);
  return '';
}

function extractCall(inner: any) {
  const name =
    inner.invocation?.tool ||
    inner.tool_name ||
    inner.name ||
    (inner.command ? 'exec' : inner.patch ? 'apply_patch' : 'tool');
  const callId = inner.call_id || inner.tool_call_id || inner.id || null;
  const args =
    inner.invocation?.arguments ||
    inner.arguments ||
    inner.args ||
    inner.input ||
    (inner.command ? { command: inner.command } : undefined);
  const result =
    flattenMcpResult(inner.result) ||
    inner.output ||
    inner.result ||
    inner.stdout ||
    inner.patch_output ||
    undefined;
  return { name, callId, args, result };
}

function reasoningSummaryText(inner: any) {
  if (!Array.isArray(inner?.summary)) return '';
  return inner.summary
    .filter((s: any) => s && typeof s === 'object' && typeof s.text === 'string')
    .map((s: any) => s.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reasoningTextFromResponseItem(inner: any) {
  const summary = reasoningSummaryText(inner);
  if (summary) return summary;
  const content = textFromContent(inner?.content);
  if (content) return content;
  if (typeof inner?.text === 'string' && inner.text.trim()) return inner.text.trim();
  if (typeof inner?.encrypted_content === 'string' && inner.encrypted_content) {
    return 'Codex recorded private reasoning for this step; no summary was emitted.';
  }
  return '';
}

function flattenMcpResult(result: any) {
  if (!result || typeof result !== 'object') return undefined;
  const ok = result.Ok ?? result.ok;
  const err = result.Err ?? result.err ?? result.error;
  const content = ok?.content ?? result.content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (!part || typeof part !== 'object') return typeof part === 'string' ? part : '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return safeStringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'string') return content;
  if (err) return typeof err === 'string' ? err : safeStringify(err);
  return undefined;
}

function parseToolArgs(raw: any) {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function inferToolStatus(inner: any, output: any) {
  if (typeof inner?.status === 'string') {
    const s = inner.status.toLowerCase();
    if (s in TOOL_STATUS) return TOOL_STATUS[s];
  }
  if (inner?.is_error === true || inner?.error) return 'error';
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && parsed.success === false) return 'error';
      if (parsed && parsed.error) return 'error';
    } catch {
      /* not JSON, treat as plain text success */
    }
  }
  return 'ok';
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  normalizeCodexEvent,
  parseLine,
  serializeTurnContext,
  restoreTurnContext,
  resetTurnContext,
};
