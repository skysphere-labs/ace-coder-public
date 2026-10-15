function toMs(ts: any) {
  if (!ts) return Date.now();
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

function textFromContent(content: any) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

const TOOL_STATUS: any = {
  success: 'ok',
  ok: 'ok',
  error: 'error',
  failed: 'error',
  timeout: 'error',
  denied: 'denied',
  canceled: 'canceled',
  cancelled: 'canceled',
  running: 'running',
  pending: 'running',
};

function mapToolStatus(raw: any) {
  if (!raw) return 'ok';
  const k = String(raw).toLowerCase();
  return TOOL_STATUS[k] || 'ok';
}

// Given a gemini session snapshot, produce the full ordered list of
// TranscriptEntry-shaped items. We diff against the previous emission in the
// caller — normalizer is pure.
function normalizeGeminiSnapshot(snapshot: any) {
  const out: any[] = [];
  if (!snapshot || typeof snapshot !== 'object') return out;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const startedAt = toMs(snapshot.startTime);
  out.push({
    keyPath: `meta:${snapshot.sessionId}`,
    entry: {
      role: 'system',
      subtype: 'session_start',
      text: snapshot.sessionId ? `Gemini session ${snapshot.sessionId.slice(0, 8)}` : 'Gemini session started',
      lifecycle: 'finished',
      tAt: startedAt,
    },
  });
  for (const msg of messages) {
    emitMessageEntries(msg, out);
  }
  return out;
}

function emitMessageEntries(msg: any, out: any) {
  if (!msg || typeof msg !== 'object') return;
  const tAt = toMs(msg.timestamp);
  const id = msg.id || `${msg.type}-${tAt}`;

  if (msg.type === 'user') {
    const text = textFromContent(msg.content);
    if (!text) return;
    out.push({
      keyPath: `user:${id}`,
      entry: { role: 'user', text, lifecycle: 'finished', tAt },
    });
    return;
  }

  if (msg.type === 'gemini') {
    const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts : [];
    for (let i = 0; i < thoughts.length; i++) {
      const t = thoughts[i];
      out.push({
        keyPath: `thought:${id}:${i}`,
        entry: {
          role: 'reasoning',
          text: String(t?.description || ''),
          subject: t?.subject ? String(t.subject) : undefined,
          lifecycle: 'finished',
          tAt: toMs(t?.timestamp) || tAt,
        },
      });
    }
    const text = textFromContent(msg.content);
    if (text) {
      out.push({
        keyPath: `agent:${id}`,
        entry: {
          role: 'agent',
          text,
          lifecycle: 'finished',
          tAt,
          model: msg.model || undefined,
          tokens: msg.tokens || undefined,
        },
      });
    }
    const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    for (const tc of toolCalls) {
      emitToolCall(tc, id, out, tAt);
    }
    return;
  }

  if (msg.type === 'tool_call' || msg.type === 'tool') {
    emitToolCall(msg, id, out, tAt);
    return;
  }

  if (msg.type === 'info' || msg.type === 'system') {
    const text = textFromContent(msg.content);
    if (text) {
      out.push({
        keyPath: `system:${id}`,
        entry: { role: 'system', subtype: 'info', text, lifecycle: 'finished', tAt },
      });
    }
    return;
  }

  if (msg.type === 'error') {
    out.push({
      keyPath: `error:${id}`,
      entry: {
        role: 'system',
        subtype: 'error',
        text: textFromContent(msg.content) || 'Gemini error',
        lifecycle: 'finished',
        tAt,
      },
    });
    return;
  }

  out.push({
    keyPath: `unknown:${id}`,
    entry: {
      role: 'system',
      subtype: 'info',
      text: `Unmapped event: ${msg.type}`,
      lifecycle: 'finished',
      tAt,
    },
    warn: `gemini:${msg.type || 'unknown'}`,
  });
}

function emitToolCall(tc: any, parentId: any, out: any, parentTs: any) {
  if (!tc || typeof tc !== 'object') return;
  const callId = tc.id || `${parentId}:${tc.name || 'tool'}`;
  const status = mapToolStatus(tc.status || (tc.result && (tc.result.error ? 'error' : 'ok')));
  const lifecycle = tc.status === 'pending' || tc.status === 'running' ? 'open' : 'finished';
  out.push({
    keyPath: `tool:${callId}`,
    entry: {
      role: 'tool',
      name: String(tc.name || 'tool'),
      args: tc.args || tc.arguments || undefined,
      result: flattenResult(tc.result) ?? tc.resultDisplay ?? undefined,
      status,
      lifecycle,
      tAt: toMs(tc.timestamp) || parentTs,
      callId,
    },
  });
}

function flattenResult(result: any) {
  if (!result) return undefined;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts = [];
    for (const r of result) {
      if (r?.functionResponse?.response) {
        const resp = r.functionResponse.response;
        if (typeof resp === 'string') parts.push(resp);
        else if (resp.output) parts.push(String(resp.output));
        else if (resp.error) parts.push(String(resp.error));
        else parts.push(JSON.stringify(resp));
      } else if (typeof r === 'string') {
        parts.push(r);
      } else if (r?.text) {
        parts.push(String(r.text));
      }
    }
    return parts.join('\n').slice(0, 4000);
  }
  return undefined;
}

module.exports = { normalizeGeminiSnapshot };
