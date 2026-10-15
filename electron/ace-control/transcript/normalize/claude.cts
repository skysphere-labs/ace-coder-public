// Pure fold of Claude Code `stream-json` events -> transcript ops.
//
// Mirrors normalize/codex.cts: a per-stream turn context supplies sticky keys
// so deltas accumulate into one entry and successive turns don't collide. The
// op shapes are IDENTICAL to codex.cts so index.cts.applyOp can consume both
// without branching:
//   { kind: 'append', entry }
//   { kind: 'upsert', key, build(prev) -> entry }
//   { kind: 'replace', summary }
//   { kind: 'warn', code }
//
// Claude is protocol-native (PRD §12 gate GREEN): the CLI emits both a partial
// `stream_event` stream (with `--include-partial-messages`) AND a settled
// top-level `assistant` message for the same content. We key both by
// turn + content-block index so the settled message UPSERTS the open
// streamed entry to `finished` instead of duplicating it.

function toMs(ts: any) {
  if (!ts) return Date.now();
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// `tool_result.content` can be a string or an array of content blocks
// ([{type:'text',text}, ...]); flatten to a readable string.
function textFromToolResultContent(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part == null) return '';
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && typeof part.text === 'string') return part.text;
        return safeStringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return safeStringify(content);
}

function parseJsonMaybe(raw: any) {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function readableText(value: any): string {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (text.startsWith('{') || text.startsWith('[')) {
      const parsed = parseJsonMaybe(text);
      if (parsed !== text) return readableText(parsed?.question || parsed?.text || parsed?.message);
      return '';
    }
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeQuestionOptions(value: any) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option: any) => {
    if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') {
      const label = readableText(option);
      return label ? [{ label }] : [];
    }
    if (!option || typeof option !== 'object') return [];
    const label = readableText(option.label || option.description || option.text || option.title);
    if (!label) return [];
    const description = readableText(option.description);
    return [{ label, ...(description && description !== label ? { description } : {}) }];
  });
}

function claudeQuestionSpecs(input: any) {
  const questions = input && typeof input === 'object' && Array.isArray(input.questions)
    ? input.questions
    : (typeof input?.questions === 'string' ? [{ question: input.questions }] : []);
  const raw = questions.length ? questions : [{}];
  return raw.map((value: any, index: number) => {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const question = readableText(item.question) || 'Claude asked a question. Answer in the terminal.';
    const options = normalizeQuestionOptions(item.options);
    const malformed = !readableText(item.question) ||
      !Array.isArray(input?.questions) ||
      (item.options != null && !Array.isArray(item.options)) ||
      typeof item.multiSelect !== 'boolean';
    return {
      index,
      question,
      header: readableText(item.header) || 'Question',
      multiSelect: item.multiSelect === true,
      options,
      malformed,
    };
  });
}

function questionAnswer(value: any) {
  if (Array.isArray(value)) {
    const answers = value.map(readableText).filter(Boolean);
    return answers.length ? answers.join(', ') : undefined;
  }
  return readableText(value) || undefined;
}

function claudeQuestionEntry({ callId, spec, state, answer, tAt, prev }: any) {
  const nextState = state || prev?.state || 'pending';
  const questionId = `${callId}:${spec.index}`;
  return {
    role: 'question',
    questionId,
    callId,
    source: 'claude',
    question: spec.question || prev?.question || 'Claude asked a question. Answer in the terminal.',
    header: spec.header || prev?.header || 'Question',
    multiSelect: typeof spec.multiSelect === 'boolean' ? spec.multiSelect : (prev?.multiSelect === true),
    options: spec.options?.length ? spec.options : (prev?.options || []),
    state: nextState,
    ...(answer ? { answer } : (prev?.answer ? { answer: prev.answer } : {})),
    ...(spec.malformed || prev?.fallback ? { fallback: true } : {}),
    lifecycle: nextState === 'pending' ? 'open' : 'finished',
    tAt: prev?.tAt || tAt,
  };
}

function summarizeToolForApproval(toolName: any, input: any) {
  const name = toolName || 'tool';
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return `${name}: ${input.command}`;
    if (typeof input.file_path === 'string') return `${name}: ${input.file_path}`;
    if (typeof input.path === 'string') return `${name}: ${input.path}`;
    if (typeof input.url === 'string') return `${name}: ${input.url}`;
    if (typeof input.pattern === 'string') return `${name}: ${input.pattern}`;
  }
  return String(name);
}

// Per-stream turn + content-block bookkeeping. A turn begins on `message_start`;
// content blocks are keyed by their stream `index` within that turn. The
// settled `assistant`/`user` messages reuse the same turn + array-position key
// so they fold into the streamed entries rather than duplicating them.
const turnContexts = new Map();

function ensureCtx(streamId: any) {
  let ctx = turnContexts.get(streamId);
  if (!ctx) {
    ctx = {
      turnSeq: 0,
      // content-block index -> { type, callId, name }
      blocks: {},
      questionCalls: {},
    };
    turnContexts.set(streamId, ctx);
  }
  if (!ctx.blocks) ctx.blocks = {};
  if (!ctx.questionCalls) ctx.questionCalls = {};
  return ctx;
}

function advanceTurn(streamId: any) {
  const ctx = ensureCtx(streamId);
  ctx.turnSeq += 1;
  ctx.blocks = {};
}

// Sticky key for a streamed content block of a given kind at a content index.
function blockKey(streamId: any, kind: any, index: any) {
  const ctx = ensureCtx(streamId);
  const idx = typeof index === 'number' ? index : 0;
  return `${kind}:${ctx.turnSeq}:${idx}`;
}

function resetTurnContext(streamId: any) {
  turnContexts.delete(streamId);
}

function serializeTurnContext(streamId: any) {
  const ctx = turnContexts.get(streamId);
  if (!ctx) return null;
  try {
    return JSON.stringify({
      turnSeq: ctx.turnSeq || 0,
      blocks: ctx.blocks || {},
      questionCalls: ctx.questionCalls || {},
      lastMessageId: ctx.lastMessageId || null,
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
      turnSeq: parsed.turnSeq | 0,
      blocks: parsed.blocks && typeof parsed.blocks === 'object' ? parsed.blocks : {},
      questionCalls: parsed.questionCalls && typeof parsed.questionCalls === 'object' ? parsed.questionCalls : {},
      lastMessageId: typeof parsed.lastMessageId === 'string' ? parsed.lastMessageId : null,
    });
  } catch { /* ignore */ }
}

function pushClaudeQuestionOps(ops: any[], streamId: any, callId: any, input: any, tAt: any) {
  const specs = claudeQuestionSpecs(input);
  ensureCtx(streamId).questionCalls[callId] = specs.length;
  for (const spec of specs) {
    ops.push({
      kind: 'upsert',
      key: `question:${callId}:${spec.index}`,
      build: (prev: any) => claudeQuestionEntry({ callId, spec, tAt, prev }),
    });
  }
}

function pushClaudeQuestionResultOps(ops: any[], event: any, streamId: any, block: any, tAt: any) {
  const callId = block.tool_use_id;
  if (!callId) return false;
  const ctx = ensureCtx(streamId);
  const result = event?.toolUseResult;
  const resultQuestions = result && typeof result === 'object' && Array.isArray(result.questions)
    ? result.questions
    : [];
  const knownCount = Number(ctx.questionCalls[callId] || 0);
  if (!knownCount && !resultQuestions.length) return false;
  const specs = resultQuestions.length
    ? claudeQuestionSpecs({ questions: resultQuestions })
    : Array.from({ length: Math.max(knownCount, 1) }, (_unused, index) => ({
        index,
        question: '',
        header: '',
        options: [],
        malformed: false,
      }));
  const answers = result && typeof result === 'object' && result.answers && typeof result.answers === 'object'
    ? result.answers
    : {};
  const onlyAnswer = Object.keys(answers).length === 1 ? questionAnswer(Object.values(answers)[0]) : undefined;
  for (const spec of specs) {
    const answer = questionAnswer(answers[spec.question]) || (specs.length === 1 ? onlyAnswer : undefined);
    const dismissed = block.is_error === true || !!event.toolDenialKind || result === 'User rejected tool use';
    const state = answer ? 'answered' : (dismissed || resultQuestions.length ? 'dismissed' : 'answered');
    ops.push({
      kind: 'upsert',
      key: `question:${callId}:${spec.index}`,
      build: (prev: any) => claudeQuestionEntry({ callId, spec, state, answer, tAt, prev }),
    });
  }
  delete ctx.questionCalls[callId];
  return true;
}

const TOOL_RESULT_STATUS: any = {
  success: 'ok',
  ok: 'ok',
  error: 'error',
  denied: 'denied',
  canceled: 'canceled',
  cancelled: 'canceled',
};

// Maps one Claude stream-json event to zero or more normalize ops.
function normalizeClaudeEvent(event: any, ctx: any = {}): any[] {
  const ops: any[] = [];
  if (!event || typeof event !== 'object') return ops;
  const streamId = ctx.streamId || 'default';
  const type = event.type;
  const tAt = toMs(event.timestamp);
  // 'session-file' when folding the CLI's own ~/.claude/projects jsonl (the
  // terminal-driven file tail); absent for the live stream-json client.
  const fromFile = ctx.source === 'session-file';

  switch (type) {
    case 'system':
      return handleSystem(event, streamId, tAt, ops);
    case 'stream_event':
      return handleStreamEvent(event, streamId, tAt, ops);
    case 'assistant':
      return handleAssistant(event, streamId, tAt, ops);
    case 'user':
      return handleUser(event, streamId, tAt, ops, fromFile);
    case 'result':
      return handleResult(event, streamId, tAt, ops);
    case 'control_request':
      return handleControlRequest(event, streamId, tAt, ops);
    case '__approval_resolved':
      return handleApprovalResolved(event, streamId, tAt, ops);
    // Metered / protocol-ack signals that don't shape the transcript.
    case 'rate_limit_event':
    case 'control_response':
      return ops;
    // Claude project-file bookkeeping lines — not transcript-shaped.
    case 'summary':
    case 'last-prompt':
    case 'ai-title':
    case 'file-history-snapshot':
    case 'queued-prompt':
      return ops;
    default:
      ops.push({ kind: 'warn', code: `claude:${type || 'unknown'}` });
      return ops;
  }
}

function handleSystem(event: any, streamId: any, tAt: any, ops: any[]) {
  if (event.subtype === 'init') {
    const model = typeof event.model === 'string' ? event.model : '';
    ops.push({
      kind: 'append',
      entry: {
        role: 'system',
        subtype: 'session_start',
        text: model ? `Claude session started (${model})` : 'Claude session started',
        lifecycle: 'finished',
        tAt,
      },
    });
    return ops;
  }
  // `system/status` (requesting/…) and other system subtypes are not
  // transcript-shaped; surface nothing rather than warning.
  return ops;
}

function handleStreamEvent(event: any, streamId: any, tAt: any, ops: any[]) {
  const inner = event.event;
  if (!inner || typeof inner !== 'object') return ops;
  const kind = inner.type;
  const ctxState = ensureCtx(streamId);

  switch (kind) {
    case 'message_start': {
      // New assistant turn — roll the turn counter BEFORE any block opens so
      // this turn's entries get fresh sticky keys. Remember the message id so
      // the settled `assistant` echo of the SAME message doesn't advance the
      // turn again (which would orphan the streamed entries).
      advanceTurn(streamId);
      ensureCtx(streamId).lastMessageId = inner?.message?.id || null;
      return ops;
    }
    case 'content_block_start': {
      const index = inner.index;
      const block = inner.content_block || {};
      if (block.type === 'tool_use') {
        const callId = block.id || `${ctxState.turnSeq}:${index}`;
        const isQuestion = block.name === 'AskUserQuestion';
        ctxState.blocks[index] = {
          type: isQuestion ? 'question' : 'tool_use',
          callId,
          name: block.name || 'tool',
          input: block.input,
          json: '',
        };
        if (isQuestion) return ops;
        // Seed input from the start frame if present (sometimes whole), else {}.
        const seededArgs =
          block.input && typeof block.input === 'object' && Object.keys(block.input).length
            ? block.input
            : undefined;
        ops.push({
          kind: 'upsert',
          key: `tool:${callId}`,
          build: (prev: any) => ({
            role: 'tool',
            name: prev?.name || block.name || 'tool',
            args: prev?.args ?? seededArgs,
            result: prev?.result,
            status: prev?.status === 'ok' || prev?.status === 'error' || prev?.status === 'denied' ? prev.status : 'running',
            lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
            tAt: prev?.tAt || tAt,
            callId,
          }),
        });
      } else if (block.type === 'thinking') {
        ctxState.blocks[index] = { type: 'thinking' };
      } else {
        // text (or anything else) accumulates as an agent message.
        ctxState.blocks[index] = { type: 'text' };
      }
      return ops;
    }
    case 'content_block_delta': {
      const index = inner.index;
      const delta = inner.delta || {};
      const slot = ctxState.blocks[index] || (ctxState.blocks[index] = { type: 'text' });
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) return ops;
        ops.push({
          kind: 'upsert',
          key: blockKey(streamId, 'agent', index),
          build: (prev: any) => ({
            role: 'agent',
            text: (prev?.text || '') + text,
            lifecycle: 'open',
            tAt: prev?.tAt || tAt,
          }),
        });
      } else if (delta.type === 'thinking_delta') {
        const text = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (!text) return ops;
        ops.push({
          kind: 'upsert',
          key: blockKey(streamId, 'reasoning', index),
          build: (prev: any) => ({
            role: 'reasoning',
            text: (prev?.text || '') + text,
            lifecycle: 'open',
            tAt: prev?.tAt || tAt,
          }),
        });
      } else if (delta.type === 'input_json_delta') {
        // Accumulate tool-call args as a raw JSON string by content index;
        // parse + finalize on content_block_stop.
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (slot.type === 'tool_use' || slot.type === 'question') slot.json = (slot.json || '') + partial;
      }
      // signature_delta and other deltas don't shape the transcript.
      return ops;
    }
    case 'content_block_stop': {
      const index = inner.index;
      const slot = ctxState.blocks[index];
      if (!slot) return ops;
      if (slot.type === 'text') {
        // Finalize the open agent entry (if any deltas arrived).
        ops.push({
          kind: 'upsert',
          key: blockKey(streamId, 'agent', index),
          build: (prev: any) => (prev
            ? { ...prev, role: 'agent', lifecycle: 'finished', tAt: prev.tAt || tAt }
            : null),
        });
      } else if (slot.type === 'thinking') {
        ops.push({
          kind: 'upsert',
          key: blockKey(streamId, 'reasoning', index),
          build: (prev: any) => (prev
            ? { ...prev, role: 'reasoning', lifecycle: 'finished', tAt: prev.tAt || tAt }
            : null),
        });
      } else if (slot.type === 'question') {
        const input = parseJsonMaybe(slot.json) ?? slot.input ?? {};
        pushClaudeQuestionOps(ops, streamId, slot.callId, input, tAt);
      } else if (slot.type === 'tool_use') {
        const args = parseJsonMaybe(slot.json) ?? {};
        ops.push({
          kind: 'upsert',
          key: `tool:${slot.callId}`,
          build: (prev: any) => ({
            role: 'tool',
            name: prev?.name || slot.name || 'tool',
            args: prev?.args && Object.keys(prev.args || {}).length ? prev.args : args,
            result: prev?.result,
            // tool_use is dispatched, not resolved — a tool_result (user
            // message) will flip status/lifecycle. Keep running/open here.
            status: prev?.status === 'ok' || prev?.status === 'error' || prev?.status === 'denied' ? prev.status : 'running',
            lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
            tAt: prev?.tAt || tAt,
            callId: slot.callId,
          }),
        });
      }
      return ops;
    }
    case 'message_delta':
    case 'message_stop':
      // Turn winding down; the top-level `result` event is the turn boundary.
      return ops;
    default:
      // Unknown inner stream frame — warn so we notice protocol drift.
      ops.push({ kind: 'warn', code: `claude:stream_event:${kind || 'unknown'}` });
      return ops;
  }
}

// Top-level settled assistant message (arrives ALONGSIDE the partial stream).
// Fold each content block into the SAME per-turn + per-index key so it upserts
// the open streamed entry to `finished` rather than duplicating it.
function handleAssistant(event: any, streamId: any, tAt: any, ops: any[]) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return ops;
  // File-tailed sessions have no message_start frames: a settled assistant
  // message with a NEW message id begins a new turn, so roll the counter here
  // or every turn's text would fold into the same `agent:0:0` key. Lines of
  // the same turn (one content block per jsonl line) share the id, and the
  // live path already advanced on message_start with this id — neither
  // double-advances.
  const ctx = ensureCtx(streamId);
  const messageId = event?.message?.id || null;
  if (messageId && messageId !== ctx.lastMessageId) {
    advanceTurn(streamId);
    ensureCtx(streamId).lastMessageId = messageId;
  }
  content.forEach((block: any, index: number) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      ops.push({
        kind: 'upsert',
        key: blockKey(streamId, 'agent', index),
        build: (prev: any) => ({
          role: 'agent',
          text: text || prev?.text || '',
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
        }),
      });
    } else if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      ops.push({
        kind: 'upsert',
        key: blockKey(streamId, 'reasoning', index),
        build: (prev: any) => ({
          role: 'reasoning',
          text: text || prev?.text || '',
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
        }),
      });
    } else if (block.type === 'tool_use') {
      const callId = block.id || `${ensureCtx(streamId).turnSeq}:${index}`;
      if (block.name === 'AskUserQuestion') {
        pushClaudeQuestionOps(ops, streamId, callId, block.input, tAt);
        return;
      }
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev: any) => ({
          role: 'tool',
          name: prev?.name || block.name || 'tool',
          args: block.input && typeof block.input === 'object' ? block.input : prev?.args,
          result: prev?.result,
          status: prev?.status === 'ok' || prev?.status === 'error' || prev?.status === 'denied' ? prev.status : 'running',
          lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
    }
  });
  return ops;
}

// Top-level `user` message: tool_result blocks resolve their matching tool
// entry; replayed user-echo turns (isReplay) and real user turns are otherwise
// ignored here (the local outbox/UI already shows what the user typed, mirroring
// codex which surfaces user text only from event_msg).
function handleUser(event: any, streamId: any, tAt: any, ops: any[], fromFile: any = false) {
  const content = event?.message?.content;
  // File tail only: surface what the user typed into the terminal — there is
  // no outbox echo on this path (the live client's UI shows its own outbox,
  // so emitting there would duplicate). Skip synthetic/meta records and
  // command envelopes the CLI writes on the user's behalf.
  if (fromFile && !event.isMeta && !event.isCompactSummary) {
    const text = (typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block: any) => block.text)
            .join('\n')
        : ''
    ).trim();
    if (text && !text.startsWith('<')) {
      ops.push({ kind: 'append', entry: { role: 'user', text, lifecycle: 'finished', tAt } });
    }
  }
  if (!Array.isArray(content)) return ops;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      const callId = block.tool_use_id;
      if (!callId) continue;
      if (pushClaudeQuestionResultOps(ops, event, streamId, block, tAt)) continue;
      const resultText = textFromToolResultContent(block.content);
      const status = block.is_error
        ? 'error'
        : (TOOL_RESULT_STATUS[String(block.status || '').toLowerCase()] || 'ok');
      ops.push({
        kind: 'upsert',
        key: `tool:${callId}`,
        build: (prev: any) => ({
          role: 'tool',
          name: prev?.name || 'tool',
          args: prev?.args,
          result: resultText || prev?.result,
          status,
          lifecycle: 'finished',
          tAt: prev?.tAt || tAt,
          callId,
        }),
      });
    }
  }
  return ops;
}

// One `result` per turn = the turn boundary. success -> turn_finished;
// error_* -> error.
function handleResult(event: any, streamId: any, tAt: any, ops: any[]) {
  const subtype = String(event.subtype || '');
  const isError = event.is_error === true || /^error/.test(subtype);
  if (isError) {
    ops.push({
      kind: 'append',
      entry: {
        role: 'system',
        subtype: 'error',
        text: typeof event.result === 'string' && event.result.trim()
          ? event.result
          : (event.api_error_status ? String(event.api_error_status) : `Claude error (${subtype || 'unknown'})`),
        lifecycle: 'finished',
        tAt,
      },
    });
  } else {
    ops.push({
      kind: 'append',
      entry: { role: 'system', subtype: 'turn_finished', lifecycle: 'finished', tAt },
    });
  }
  return ops;
}

// `control_request{subtype:'can_use_tool'}` -> a pending approval entry keyed by
// request_id. The live client surfaces this via onEvent; the resolution arrives
// as a synthesized `__approval_resolved` event.
function handleControlRequest(event: any, streamId: any, tAt: any, ops: any[]) {
  const request = event.request;
  if (!request || request.subtype !== 'can_use_tool') return ops;
  const requestId = event.request_id;
  if (!requestId) return ops;
  const toolName = request.display_name || request.tool_name || 'tool';
  ops.push({
    kind: 'upsert',
    key: `approval:${requestId}`,
    build: (prev: any) => ({
      role: 'approval',
      prompt: prev?.prompt || `Allow ${toolName}?`,
      context: prev?.context || request.description || summarizeToolForApproval(toolName, request.input),
      status: prev?.status === 'approved' || prev?.status === 'denied' ? prev.status : 'pending',
      lifecycle: prev?.lifecycle === 'finished' ? 'finished' : 'open',
      tAt: prev?.tAt || tAt,
    }),
  });
  return ops;
}

// Synthesized by the ingest client when it answers a permission ask:
//   { type:'__approval_resolved', request_id, approved }
function handleApprovalResolved(event: any, streamId: any, tAt: any, ops: any[]) {
  const requestId = event.request_id;
  if (!requestId) return ops;
  ops.push({
    kind: 'upsert',
    key: `approval:${requestId}`,
    build: (prev: any) => ({
      role: 'approval',
      prompt: prev?.prompt || 'Approval',
      context: prev?.context || '',
      status: event.approved === false ? 'denied' : 'approved',
      lifecycle: 'finished',
      tAt: prev?.tAt || tAt,
    }),
  });
  return ops;
}

module.exports = {
  normalizeClaudeEvent,
  serializeTurnContext,
  restoreTurnContext,
  resetTurnContext,
};
