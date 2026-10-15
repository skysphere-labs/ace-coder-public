// Hermes JSONL session normalizer.
//
// Hermes writes one JSON object per line to <HERMES_HOME>/sessions/<ts>.jsonl.
// Each record is a chat-completion-style message with optional tool_calls
// and reasoning_content. The shape is simpler than Codex (no streaming
// deltas — assistant content arrives whole per turn) so we map each line
// to one or more append/upsert ops without per-stream turn context.
//
// Tool calls live on `assistant.tool_calls[i]` with a stable `id`. The
// matching tool result is a separate record with `role: "tool"` and the
// same `tool_call_id` — we upsert by that id so the ToolWidget mounts on
// the assistant turn and updates in place when the result lands.

function parseLine(line: any) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toMsOrNull(ts: any) {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function toMs(ts: any) {
  return toMsOrNull(ts) ?? Date.now();
}

function sessionStartMs(snapshot: any) {
  const explicit = toMsOrNull(snapshot?.session_start || snapshot?.sessionStart);
  if (explicit !== null) return explicit;
  const sessionId = String(snapshot?.session_id || snapshot?.sessionId || '');
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(sessionId);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
  return 0;
}

function snapshotMessageTime(msg: any, idx: any, startedAt: any) {
  return toMsOrNull(msg?.timestamp) ?? startedAt + idx + 1;
}

function safeJsonParse(value: any) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readableText(value: any): string {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (text.startsWith('{') || text.startsWith('[')) {
      const parsed = safeJsonParse(text);
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

function hermesQuestionEntry({ callId, args, result, resultProvided, tAt, prev }: any) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const output = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const rawQuestion = output.question ?? input.question;
  const rawChoices = output.choices_offered ?? input.choices;
  const question = readableText(rawQuestion) || prev?.question || 'Hermes asked a question. Answer in the terminal.';
  const answer = readableText(output.user_response) || undefined;
  const state = resultProvided ? (answer ? 'answered' : 'dismissed') : (prev?.state || 'pending');
  const options = normalizeQuestionOptions(rawChoices);
  const malformed = !readableText(rawQuestion) || (rawChoices != null && !Array.isArray(rawChoices));
  return {
    role: 'question',
    questionId: callId,
    callId,
    source: 'hermes',
    question,
    header: readableText(input.header) || prev?.header || 'Question',
    multiSelect: false,
    options: options.length ? options : (prev?.options || []),
    state,
    ...(answer ? { answer } : {}),
    ...(malformed || prev?.fallback ? { fallback: true } : {}),
    lifecycle: state === 'pending' ? 'open' : 'finished',
    tAt: prev?.tAt || tAt,
  };
}

function isClarifyResult(value: any) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (
    Object.prototype.hasOwnProperty.call(value, 'question') ||
    Object.prototype.hasOwnProperty.call(value, 'choices_offered') ||
    Object.prototype.hasOwnProperty.call(value, 'user_response')
  );
}

function textFromContent(content: any) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && typeof b === 'object' && (b.type === 'output_text' || b.type === 'text'))
    .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function textFromCodexMessageItems(items: any) {
  if (!Array.isArray(items)) return '';
  return items
    .filter((item: any) => item?.type === 'message' && item.role === 'assistant')
    .map((item: any) => textFromContent(item.content))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function summaryTextFromCodexReasoningItems(items: any) {
  if (!Array.isArray(items)) return '';
  return items
    .filter((item: any) => item?.type === 'reasoning' && Array.isArray(item.summary))
    .flatMap((item: any) => item.summary)
    .filter((summary: any) => summary?.type === 'summary_text' && typeof summary.text === 'string')
    .map((summary: any) => summary.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reasoningTextFromValue(value: any) {
  const parsed = safeJsonParse(value);
  if (typeof parsed === 'string') return parsed.trim();
  const summary = summaryTextFromCodexReasoningItems(parsed);
  if (summary) return summary;
  if (Array.isArray(parsed)) {
    return parsed
      .map((item: any) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item?.text === 'string') return item.text.trim();
        if (typeof item?.summary === 'string') return item.summary.trim();
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.text === 'string') return parsed.text.trim();
    if (typeof parsed.summary === 'string') return parsed.summary.trim();
    if (Array.isArray(parsed.summary)) {
      return parsed.summary
        .map((item: any) => (typeof item?.text === 'string' ? item.text.trim() : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  }
  return '';
}

function assistantTextFrom(msg: any) {
  return textFromContent(msg?.content) || textFromCodexMessageItems(msg?.codex_message_items);
}

function reasoningSummaryFrom(msg: any) {
  const summary = summaryTextFromCodexReasoningItems(msg?.codex_reasoning_items);
  if (summary) return summary;
  return (
    reasoningTextFromValue(msg?.reasoning_content) ||
    reasoningTextFromValue(msg?.reasoning) ||
    reasoningTextFromValue(msg?.reasoning_details)
  );
}

function tokenUsageFrom(msg: any) {
  const total = Number(msg?.token_count ?? msg?.tokenCount ?? 0);
  return Number.isFinite(total) && total > 0 ? { total } : undefined;
}

function isCompactionSummary(text: any) {
  if (typeof text !== 'string') return false;
  return /^\s*\[CONTEXT COMPACTION/i.test(text);
}

function isSelfImprovementReviewSummaryText(text: any) {
  if (typeof text !== 'string') return false;
  return /^\s*(?:💾\s*)?Self-improvement review:\s+\S/i.test(text);
}

function isBackgroundSkillReviewText(text: any) {
  if (typeof text !== 'string') return false;
  if (isSelfImprovementReviewSummaryText(text)) return false;
  const normalized = text.toLowerCase();
  if (/\bnightly[_ -]skill[_ -]harvest\b/.test(normalized)) return true;
  if (/\bcurrent\s+hermes_home\s+under\s+review\b/.test(normalized)) return true;
  if (/\bscheduled\s+job\s+runs\s+once\s+per\s+hermes\s+home\b/.test(normalized)) return true;
  if (/\bcontained\s+harvest\s+pass\b/.test(normalized)) return true;
  if (/\bmetadata-only\s+counts\b/.test(normalized) && /\bskills?\b/.test(normalized)) return true;
  if (/\bcreation[_ -]nudge\b/.test(normalized)) return true;
  if (/\bself[_ -]improvement\s+skills?\s+updates?\s+reviews?\b/.test(normalized)) return true;
  if (/\bskills?\s+updates?\s+reviews?\s+completed\b/.test(normalized)) return true;
  const internal = /\bbackground\b|\binternal\b|\bnotify\b|\bnudge\b/.test(normalized);
  if (!internal) return false;
  if (/\bskills?[_ -](?:reviews?|updates?)\b|\bself[_ -]improvement\b/.test(normalized)) return true;
  if (/\bcurator\b/.test(normalized) && /\b(?:skill|skills|review|update|harvest)/.test(normalized)) return true;
  return false;
}

function classifyToolStatus(content: any) {
  if (typeof content !== 'string') return 'ok';
  // Hermes tool results are plain strings. There's no structured error
  // flag, so we infer: a leading "Error:"/"Traceback"/"Failed" prefix is
  // the closest signal. Default to 'ok' otherwise — same as a no-error
  // shell command.
  if (/^\s*(Error[: ]|Traceback |Failed[: ])/i.test(content)) return 'error';
  return 'ok';
}

function canonicalToolCallId(callId: any) {
  const id = String(callId || '');
  const match = /^codex_[A-Za-z0-9_.-]+_(call_[A-Za-z0-9_-]+)$/.exec(id);
  return match?.[1] || id;
}

function reviewSummaryTextFrom(record: any) {
  const kind = String(record?.type || record?.event || record?.role || '').trim();
  if (kind !== 'review.summary') return '';
  const payload = record && typeof record.payload === 'object' ? record.payload : null;
  const text =
    typeof payload?.text === 'string' ? payload.text :
    typeof record?.text === 'string' ? record.text :
    typeof record?.content === 'string' ? record.content :
    '';
  return text.trim();
}

// Maps a single Hermes JSONL record to zero or more normalize operations.
// Operations match the shape consumed by transcript/index.cts:applyOp:
//   { kind: 'append', entry }
//   { kind: 'upsert', key, build(prev) -> entry }
//   { kind: 'replace', summary }       (compaction)
//   { kind: 'warn', code }
function normalizeHermesRecord(record: any) {
  const ops: any[] = [];
  if (!record || typeof record !== 'object') return ops;
  const role = record.role;
  const tAt = toMs(record.timestamp);
  const reviewSummary = reviewSummaryTextFrom(record);

  if (reviewSummary) {
    ops.push({
      kind: 'append',
      entry: { role: 'system', subtype: 'info', text: reviewSummary, lifecycle: 'finished', tAt },
    });
    return ops;
  }

  if (String(record.type || record.event || '') === 'review.summary') return ops;

  if (role === 'user') {
    const text = typeof record.content === 'string' ? record.content : '';
    if (!text || isBackgroundSkillReviewText(text)) return ops;
    ops.push({
      kind: 'append',
      entry: { role: 'user', text, lifecycle: 'finished', tAt },
    });
    return ops;
  }

  if (role === 'assistant') {
    // Compaction: Hermes injects a synthetic assistant turn whose content
    // begins with [CONTEXT COMPACTION ...]. Surface as a replace so the
    // chat view collapses prior history into a system summary card.
    if (isCompactionSummary(record.content)) {
      ops.push({
        kind: 'replace',
        reason: 'compact',
        summary: {
          role: 'system',
          subtype: 'info',
          text: 'Hermes auto-compacted prior conversation. Prior context was summarized; reviving from compacted context.',
          lifecycle: 'finished',
          tAt,
        },
      });
      return ops;
    }

    // Background-skill-review turns suppress only the narrative/reasoning TEXT,
    // never the tool activity (handled below) — so tool calls render
    // consistently even when the surrounding prose is internal.
    const textIsBackground =
      isBackgroundSkillReviewText(record.content) ||
      isBackgroundSkillReviewText(record.reasoning_content);

    if (!textIsBackground) {
      const reasoningSummary = reasoningSummaryFrom(record);
      if (reasoningSummary && !isBackgroundSkillReviewText(reasoningSummary)) {
        ops.push({
          kind: 'append',
          entry: {
            role: 'reasoning',
            text: reasoningSummary,
            lifecycle: 'finished',
            tAt,
            tokens: tokenUsageFrom(record),
          },
        });
      }

      const content = assistantTextFrom(record);
      if (content && !isBackgroundSkillReviewText(content)) {
        ops.push({
          kind: 'append',
          entry: {
            role: 'agent',
            text: content,
            lifecycle: 'finished',
            tAt,
            tokens: tokenUsageFrom(record),
          },
        });
      }
    }

    // Tool calls always surface, even on background-skill-review turns, so the
    // overlay never silently drops tool activity.
    if (Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const rawCallId = call.id || call.call_id || null;
        if (!rawCallId) continue;
        const callId = canonicalToolCallId(rawCallId);
        const fn = call.function || {};
        const name = fn.name || call.name || 'tool';
        const args = safeJsonParse(fn.arguments);
        if (String(name).toLowerCase() === 'clarify') {
          ops.push({
            kind: 'upsert',
            key: `question:${callId}:0`,
            build: (prev: any) => hermesQuestionEntry({ callId, args, resultProvided: false, tAt, prev }),
          });
          continue;
        }
        ops.push({
          kind: 'upsert',
          key: `tool:${callId}`,
          build: () => ({
            role: 'tool',
            name,
            args,
            status: 'running',
            lifecycle: 'open',
            tAt,
            callId,
          }),
        });
      }
    }
    return ops;
  }

  if (role === 'tool') {
    const rawCallId = record.tool_call_id || record.call_id || null;
    if (!rawCallId) {
      ops.push({ kind: 'warn', code: 'hermes:tool-missing-id' });
      return ops;
    }
    const callId = canonicalToolCallId(rawCallId);
    const content = record.content;
    const parsedResult = safeJsonParse(content);
    if (String(record.tool_name || record.name || '').toLowerCase() === 'clarify' || isClarifyResult(parsedResult)) {
      ops.push({
        kind: 'upsert',
        key: `question:${callId}:0`,
        build: (prev: any) => hermesQuestionEntry({
          callId,
          args: prev,
          result: parsedResult,
          resultProvided: true,
          tAt,
          prev,
        }),
      });
      return ops;
    }
    const result = typeof content === 'string' ? content : parsedResult;
    const status = classifyToolStatus(content);
    ops.push({
      kind: 'upsert',
      key: `tool:${callId}`,
      build: (prev: any) => ({
        role: 'tool',
        name: record.tool_name || prev?.name || 'tool',
        args: prev?.args,
        result,
        status,
        lifecycle: 'finished',
        tAt: prev?.tAt || tAt,
        callId,
      }),
    });
    return ops;
  }

  if (role === 'system') {
    const text = typeof record.content === 'string' ? record.content : '';
    if (!text || isBackgroundSkillReviewText(text)) return ops;
    ops.push({
      kind: 'append',
      entry: { role: 'system', subtype: 'info', text, lifecycle: 'finished', tAt },
    });
    return ops;
  }

  ops.push({ kind: 'warn', code: `hermes:role:${role || 'unknown'}` });
  return ops;
}

// Snapshot normalizer for Ace's Hermes JSON sessions
// (<HERMES_HOME>/sessions/session_<id>.json — the file is rewritten on every
// turn, with all messages under `messages: []`). Mirrors the gemini snapshot
// pipeline: emit one stable-keyPath entry per logical chat element so the
// caller upserts in place across snapshot diffs.
//
// Tool calls land on `assistant.tool_calls[i]` with a stable id and pair
// with a separate `role: "tool"` record bearing the same tool_call_id;
// both share the `tool:${callId}` keyPath so the ToolWidget mounts on the
// assistant turn and finalises when the result lands.
function normalizeHermesSnapshot(snapshot: any) {
  const out: any[] = [];
  if (!snapshot || typeof snapshot !== 'object') return out;
  const sessionId = snapshot.session_id || snapshot.sessionId || null;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const startedAt = sessionStartMs(snapshot);

  out.push({
    keyPath: `meta:${sessionId || 'session'}`,
    entry: {
      role: 'system',
      subtype: 'session_start',
      text: sessionId ? `Hermes session ${String(sessionId).slice(0, 16)}` : 'Hermes session started',
      lifecycle: 'finished',
      tAt: startedAt,
    },
  });

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    const tAt = snapshotMessageTime(msg, idx, startedAt);
    const reviewSummary = reviewSummaryTextFrom(msg);

    if (reviewSummary) {
      out.push({
        keyPath: `review-summary:${idx}`,
        entry: { role: 'system', subtype: 'info', text: reviewSummary, lifecycle: 'finished', tAt },
      });
      continue;
    }

    if (String(msg.type || msg.event || '') === 'review.summary') continue;

    if (role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text || isBackgroundSkillReviewText(text)) continue;
      out.push({
        keyPath: `user:${idx}`,
        entry: { role: 'user', text, lifecycle: 'finished', tAt },
      });
      continue;
    }

    if (role === 'assistant') {
      if (isBackgroundSkillReviewText(msg.content) || isBackgroundSkillReviewText(msg.reasoning_content)) {
        continue;
      }

      // Compaction marker: collapse history into a system summary card.
      if (isCompactionSummary(msg.content)) {
        out.push({
          keyPath: `compaction:${idx}`,
          entry: {
            role: 'system',
            subtype: 'info',
            text: 'Hermes auto-compacted prior conversation. Prior context was summarized; reviving from compacted context.',
            lifecycle: 'finished',
            tAt,
          },
        });
        continue;
      }
      const reasoningSummary = reasoningSummaryFrom(msg);
      if (isBackgroundSkillReviewText(reasoningSummary)) continue;
      if (reasoningSummary) {
        out.push({
          keyPath: `reasoning:${idx}`,
          entry: {
            role: 'reasoning',
            text: reasoningSummary,
            lifecycle: 'finished',
            tAt,
          },
        });
      }
      const content = assistantTextFrom(msg);
      if (isBackgroundSkillReviewText(content)) continue;
      if (content) {
        out.push({
          keyPath: `agent:${idx}`,
          entry: { role: 'agent', text: content, lifecycle: 'finished', tAt },
        });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const rawCallId = call.id || call.call_id || null;
          if (!rawCallId) continue;
          const callId = canonicalToolCallId(rawCallId);
          const fn = call.function || {};
          const name = fn.name || call.name || 'tool';
          const args = safeJsonParse(fn.arguments);
          if (String(name).toLowerCase() === 'clarify') {
            out.push({
              keyPath: `question:${callId}:0`,
              entry: hermesQuestionEntry({ callId, args, resultProvided: false, tAt }),
            });
            continue;
          }
          out.push({
            keyPath: `tool:${callId}`,
            entry: {
              role: 'tool',
              name,
              args,
              status: 'running',
              lifecycle: 'open',
              tAt,
              callId,
            },
          });
        }
      }
      continue;
    }

    if (role === 'tool') {
      const rawCallId = msg.tool_call_id || msg.call_id || null;
      if (!rawCallId) {
        out.push({
          keyPath: `tool-orphan:${idx}`,
          entry: {
            role: 'system',
            subtype: 'info',
            text: 'Tool result missing tool_call_id',
            lifecycle: 'finished',
            tAt,
          },
          warn: 'hermes:tool-missing-id',
        });
        continue;
      }
      const callId = canonicalToolCallId(rawCallId);
      const content = msg.content;
      const parsedResult = safeJsonParse(content);
      const toolName = lookupToolName(messages, callId);
      if (String(toolName).toLowerCase() === 'clarify' || isClarifyResult(parsedResult)) {
        out.push({
          keyPath: `question:${callId}:0`,
          entry: hermesQuestionEntry({
            callId,
            args: lookupToolArgs(messages, callId),
            result: parsedResult,
            resultProvided: true,
            tAt,
          }),
        });
        continue;
      }
      const result = typeof content === 'string' ? content : parsedResult;
      // Snapshot mode: the tool result re-emits the same `tool:${callId}`
      // keyPath as the assistant's prior tool_call entry, so the upsert
      // flips status/result/lifecycle in place. We can't access the prior
      // entry here (normalizer is pure), so we don't try to preserve
      // `name`/`args` — the caller's upsert build receives the full new
      // entry and replaces. To avoid losing name/args, emit the merged
      // entry directly: snapshot is authoritative and the assistant's
      // tool_call entry was emitted earlier in the same pass, so the
      // caller will see the running entry first then the finalised entry
      // for the same keyPath in a single snapshot iteration.
      out.push({
        keyPath: `tool:${callId}`,
        entry: {
          role: 'tool',
          name: toolName,
          args: lookupToolArgs(messages, callId),
          result,
          status: classifyToolStatus(content),
          lifecycle: 'finished',
          tAt,
          callId,
        },
      });
      continue;
    }

    if (role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text || isBackgroundSkillReviewText(text)) continue;
      out.push({
        keyPath: `system:${idx}`,
        entry: { role: 'system', subtype: 'info', text, lifecycle: 'finished', tAt },
      });
      continue;
    }

    out.push({
      keyPath: `unknown:${idx}`,
      entry: {
        role: 'system',
        subtype: 'info',
        text: `Unmapped role: ${role || 'unknown'}`,
        lifecycle: 'finished',
        tAt,
      },
      warn: `hermes:role:${role || 'unknown'}`,
    });
  }
  return out;
}

// Walk the messages array to find the assistant tool_calls entry that
// matches `callId` and return its function name. Snapshot is authoritative
// so this is a cheap O(n) lookup per result; the caller's upsert path
// already ran on the assistant turn, but the normalizer is pure and can't
// peek at prior emitted entries.
function lookupToolName(messages: any[], callId: any) {
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      if ((c?.id || c?.call_id) === callId) return c?.function?.name || c?.name || 'tool';
    }
  }
  return 'tool';
}

function lookupToolArgs(messages: any[], callId: any) {
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      if ((c?.id || c?.call_id) === callId) return safeJsonParse(c?.function?.arguments);
    }
  }
  return undefined;
}

module.exports = {
  normalizeHermesRecord,
  normalizeHermesSnapshot,
  parseLine,
  isCompactionSummary,
  classifyToolStatus,
  isBackgroundSkillReviewText,
  isSelfImprovementReviewSummaryText,
};
