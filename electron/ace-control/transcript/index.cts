const fs = require('fs');
const path = require('path');
const { createTranscriptStore } = require('./store.cjs');
const { createLinker } = require('./linker.cjs');
const { createCodexJsonlTail } = require('./tails/codex-jsonl.cjs');
const { createGeminiJsonTail } = require('./tails/gemini-json.cjs');
const {
  normalizeCodexEvent,
  serializeTurnContext,
  restoreTurnContext,
  resetTurnContext,
} = require('./normalize/codex.cjs');
const {
  normalizeClaudeEvent,
  serializeTurnContext: serializeClaudeTurnContext,
  restoreTurnContext: restoreClaudeTurnContext,
  resetTurnContext: resetClaudeTurnContext,
} = require('./normalize/claude.cjs');
const { createClaudeStreamClient } = require('./ingest/claude.cjs');
const { normalizeGeminiSnapshot } = require('./normalize/gemini.cjs');
const { normalizeHermesSnapshot } = require('./normalize/hermes.cjs');

const MAX_WARNINGS_PER_STREAM = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_COMMUNICATION_BODY_CHARS = 6000;
const DESTRUCTIVE_RESET_REASONS = new Set(['clear', 'file-truncate']);

function pageLimit(limit: any) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), 100);
}

function workspaceIdFromHermesSessionFile(filePath: any) {
  const m = /(?:^|[/\\])hermes-home-([^/\\]+)(?:[/\\]|$)/.exec(String(filePath || ''));
  return m?.[1] || null;
}

// Given a sessionFile path (which may be either the legacy JSON file under
// hermes-home/sessions/ or the modern state.db itself), return the state.db
// path if one is present, else null. Modern Hermes only writes state.db; the
// JSON fallback covers older installs.
function pickHermesStateDb(sessionFile: any) {
  const s = String(sessionFile || '');
  if (!s) return null;
  if (s.endsWith('state.db')) return fs.existsSync(s) ? s : null;
  const m = /^(.*?[/\\]hermes-home-[^/\\]+)(?:[/\\]|$)/.exec(s);
  if (!m) return null;
  const dbPath = path.join(m[1], 'state.db');
  return fs.existsSync(dbPath) ? dbPath : null;
}

function cleanText(value: any) {
  const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return text || null;
}

function sanitizeCommunicationBody(value: any) {
  let body = cleanText(value) || '';
  let redacted = false;
  const replace = (rx: any, build: any) => {
    body = body.replace(rx, (...args: any[]) => {
      redacted = true;
      return build(...args);
    });
  };
  replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, (_m: any, prefix: any) => `${prefix}[REDACTED]`);
  replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, (_m: any, prefix: any) => `${prefix}[REDACTED]`);
  replace(
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*)(['"]?)[^\s'"]+/gi,
    (_m: any, prefix: any, quote: any) => `${prefix}${quote}[REDACTED]`
  );
  replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s]+/gi, (_m: any, prefix: any) => `${prefix}[REDACTED]`);

  let truncated = false;
  if (body.length > MAX_COMMUNICATION_BODY_CHARS) {
    const omitted = body.length - MAX_COMMUNICATION_BODY_CHARS;
    body = `${body.slice(0, MAX_COMMUNICATION_BODY_CHARS)}\n...[truncated ${omitted} chars]`;
    truncated = true;
  }
  return { body, redacted, truncated };
}

function createLazyTranscriptStore({ userDataPath, db, injectedStore }: any = {}) {
  if (injectedStore) return injectedStore;
  let store: any = null;
  let unavailableLogged = false;
  const getStore = () => {
    if (store) return store;
    try {
      store = createTranscriptStore({ userDataPath, db });
      return store;
    } catch (err: any) {
      if (!unavailableLogged) {
        unavailableLogged = true;
        console.warn('[ace-control] transcript storage unavailable:', err?.message || err);
      }
      return null;
    }
  };
  const call = (method: string, fallback: any) => (...args: any[]) => {
    const realStore = getStore();
    if (!realStore || typeof realStore[method] !== 'function') {
      return typeof fallback === 'function' ? fallback(...args) : fallback;
    }
    return realStore[method](...args);
  };
  return {
    appendEntry: call('appendEntry', null),
    replaceEntry: call('replaceEntry', null),
    upsertByKey: call('upsertByKey', null),
    readEntries: call('readEntries', []),
    readLatestEntries: call('readLatestEntries', []),
    readEntriesBefore: call('readEntriesBefore', []),
    hasEntriesBefore: call('hasEntriesBefore', false),
    truncateAfter: call('truncateAfter', undefined),
    clear: call('clear', undefined),
    link: call('link', undefined),
    rebindSession: call('rebindSession', () => { throw new Error('transcript rebind unavailable'); }),
    getLink: call('getLink', null),
    setByteOffset: call('setByteOffset', undefined),
    setTurnState: call('setTurnState', undefined),
    unlink: call('unlink', undefined),
    unlinkSessionFileAliases: call('unlinkSessionFileAliases', []),
    getNextSeq: call('getNextSeq', 0),
    close: () => {
      try { store?.close?.(); } catch {}
      store = null;
    },
  };
}

function createTranscriptController({
  userDataPath,
  bus,
  profiles,
  db,
  store: injectedStore,
  onSessionLinked,
  shouldPruneTranscriptAlias,
  // (streamId, agent) -> the CLI session id Ace expects for this stream
  // (owner row's session_id). Used by profiles with matchBySessionId (claude)
  // so the linker claims exactly the file named after the id we minted.
  resolveExpectedSessionId,
  // (streamId, agent) -> { sessionId, sessionFile, cwd } for a session Ace
  // already knows how to resume. This restores a missing transcript DB link
  // immediately after restart instead of waiting for the old file to change.
  resolveExpectedSessionFile,
  resolveResumeSessionDir,
  // (streamId, sessionId) -> whether another live lane does not own this /resume target.
  canSwitchSession,
  resolveSelectedSessionId,
  onResumeSwitchSettled,
  // Injectable for tests: the persistent Claude stream-json client factory
  // (electron/ace-control/transcript/ingest/claude.cts). Tests replay
  // captured spike events through a fake instead of spawning the real binary.
  createClaudeClient = createClaudeStreamClient,
}: any) {
  const store = createLazyTranscriptStore({ userDataPath, db, injectedStore });
  const tails = new Map();
  // Protocol-native Claude (PRD Lane 2): persistent stream-json clients keyed by
  // streamId. Unlike file-tailed agents, Claude has no on-disk session feed —
  // the live client IS the source of truth, folded through normalizeClaudeEvent
  // into the same applyOp ops the codex tail uses.
  const claudeClients = new Map<string, any>();
  const warnings = new Map();
  const resumeSwitches = new Map<string, any>();
  // workspaceId per stream; populated by linkPending so resetStream's
  // re-enqueue can carry the workspace discriminator forward without
  // requiring a DB schema migration on the link store.
  const streamWorkspaceIds = new Map();

  const linker = createLinker({
    profiles: profiles ? Array.from(profiles.values()) : [],
    resolveExpectedSessionId,
    canSwitchSession,
    resolveSelectedSessionId,
    isCurrentLink: (streamId: any, filePath: any) => {
      const link = store.getLink(streamId);
      return !!link && link.sessionFile === filePath;
    },
    onLink: ({ streamId, agent, sessionId, sessionFile, cwd, byteOffset, sessionSwitch }: any) => {
      const sqlitePath = agent === 'hermes' ? pickHermesStateDb(sessionFile) : null;
      const linkedSessionFile = sqlitePath || sessionFile;
      const linkedSessionId = sqlitePath ? 'live' : sessionId;
      const linkedByteOffset = sqlitePath ? 0 : byteOffset;
      const existing = store.getLink(streamId);
      const persistence = persistLinkedSession({
        streamId,
        agent,
        sessionId: linkedSessionId,
        sessionFile: linkedSessionFile,
        cwd,
        sessionSwitch,
      });
      if (sessionSwitch === true && !persistence.ok) return false;
      if (sessionSwitch === true) {
        const tail = tails.get(streamId);
        if (tail) {
          try { tail.close(); } catch {}
          tails.delete(streamId);
        }
        try {
          store.rebindSession(streamId, {
            agent,
            sessionId: linkedSessionId,
            sessionFile: linkedSessionFile,
            cwd,
            byteOffset: linkedByteOffset,
            linkedAt: Date.now(),
          });
        } catch (err: any) {
          try { persistence.rollback?.(); } catch (rollbackErr: any) {
            pushWarning(streamId, { code: 'session-link:rollback', error: rollbackErr.message });
          }
          pushWarning(streamId, { code: 'session-link:rebind', error: err.message });
          if (existing) startTail(streamId).catch(() => {});
          return false;
        }
        warnings.delete(streamId);
        resetTurnContext(streamId);
        resetClaudeTurnContext(streamId);
        emitTranscriptReset(streamId, 'clear');
        emit('tab-chat-available', { streamId, agent, sessionId: linkedSessionId, sessionFile: linkedSessionFile });
        startTail(streamId).catch((err: any) => {
          pushWarning(streamId, { code: 'tail:start', error: err.message });
        });
        clearResumeSwitch(streamId, 'linked');
        return true;
      }
      if (existing && existing.sessionFile === linkedSessionFile) {
        emit('tab-chat-available', { streamId, agent, sessionId: linkedSessionId, sessionFile: linkedSessionFile });
        return true;
      }
      if (existing) {
        // Codex/Gemini /clear rotate to a new file; the new link lands below.
        resetStream(streamId, 'clear', { reenqueue: false });
      }
      store.link(streamId, {
        agent,
        sessionId: linkedSessionId,
        sessionFile: linkedSessionFile,
        cwd,
        byteOffset: linkedByteOffset,
        linkedAt: Date.now(),
      });
      emit('tab-chat-available', { streamId, agent, sessionId: linkedSessionId, sessionFile: linkedSessionFile });
      startTail(streamId).catch((err: any) => {
        pushWarning(streamId, { code: 'tail:start', error: err.message });
      });
      return true;
    },
    onWarning: (w: any) => {
      if (bus) bus.emit?.('transcript:linker-warning', w);
    },
  });

  function emit(event: any, payload: any) {
    if (!bus) return;
    if (typeof bus.emit === 'function') bus.emit(event, payload);
    if (typeof bus.emitAny === 'function') bus.emitAny({ event, payload });
  }

  function emitTranscriptReset(streamId: any, reason: any, extra: any = {}) {
    dropPendingTranscriptUpdates(streamId);
    const payload = { streamId, nextCursor: 0, ...extra, reason };
    emit(`transcript:reset:${streamId}`, payload);
    emit('transcript:reset', payload);
  }

  function emitTranscriptReplace(streamId: any, payload: any) {
    dropPendingTranscriptUpdates(streamId);
    emit(`transcript:replace:${streamId}`, payload);
    emit('transcript:replace', payload);
  }

  // Token-delta coalescer. Claude's --include-partial-messages tail applies
  // one upsert op per streamed token; broadcasting each one floods IPC + the
  // remote WebSocket and forces a renderer store commit per token — the chat
  // view's main choppiness source. Upserts emit the FULL entry, so only the
  // latest state per entry matters within a window: batch on a
  // leading+trailing window (same shape as the 16ms PTY pump) and emit one
  // update per entry per flush. Appends/replaces/resets stay synchronous;
  // pending updates are dropped on reset/replace so a wiped entry can't get
  // a late echo.
  const UPDATE_COALESCE_MS = 33;
  const pendingTranscriptUpdates = new Map(); // streamId -> Map<entryId, entry>
  const transcriptFlushTimers = new Map(); // streamId -> Timeout
  const lastTranscriptFlushAt = new Map(); // streamId -> ms epoch

  function flushTranscriptUpdates(streamId: any) {
    const pending = pendingTranscriptUpdates.get(streamId);
    pendingTranscriptUpdates.delete(streamId);
    if (!pending || pending.size === 0) return;
    lastTranscriptFlushAt.set(streamId, Date.now());
    for (const entry of pending.values()) {
      emit(`transcript:update:${streamId}`, entry);
      emit('transcript:update', { streamId, entry });
    }
  }

  function scheduleTranscriptUpdate(streamId: any, entry: any) {
    let pending = pendingTranscriptUpdates.get(streamId);
    if (!pending) {
      pending = new Map();
      pendingTranscriptUpdates.set(streamId, pending);
    }
    pending.set(entry.id, entry);
    // Only mid-stream token deltas ride the window. A settling update
    // (finished / interrupted / approval status flip) flushes synchronously
    // so end-of-turn and approval UX never lag behind the stream.
    if (entry.lifecycle !== 'open') {
      const timer = transcriptFlushTimers.get(streamId);
      if (timer) {
        clearTimeout(timer);
        transcriptFlushTimers.delete(streamId);
      }
      flushTranscriptUpdates(streamId);
      return;
    }
    if (transcriptFlushTimers.has(streamId)) return;
    const since = Date.now() - (lastTranscriptFlushAt.get(streamId) || 0);
    if (since >= UPDATE_COALESCE_MS) {
      flushTranscriptUpdates(streamId);
      return;
    }
    const timer = setTimeout(() => {
      transcriptFlushTimers.delete(streamId);
      flushTranscriptUpdates(streamId);
    }, UPDATE_COALESCE_MS - since);
    if (typeof timer.unref === 'function') timer.unref();
    transcriptFlushTimers.set(streamId, timer);
  }

  function dropPendingTranscriptUpdates(streamId: any) {
    pendingTranscriptUpdates.delete(streamId);
    const timer = transcriptFlushTimers.get(streamId);
    if (timer) {
      clearTimeout(timer);
      transcriptFlushTimers.delete(streamId);
    }
  }

  function pushWarning(streamId: any, warning: any) {
    const arr = warnings.get(streamId) || [];
    if (arr.length < MAX_WARNINGS_PER_STREAM) {
      arr.push({ ...warning, tAt: Date.now() });
      warnings.set(streamId, arr);
    }
  }

  function clearResumeSwitch(streamId: any, reason: any = null) {
    const pending = resumeSwitches.get(streamId);
    if (pending?.timer) clearTimeout(pending.timer);
    if (pending?.probeTimer) clearTimeout(pending.probeTimer);
    resumeSwitches.delete(streamId);
    if (pending && reason && typeof onResumeSwitchSettled === 'function') {
      try { onResumeSwitchSettled({ streamId, reason }); } catch {}
    }
  }

  async function restoreNormalPending(streamId: any, reason: any = 'fallback') {
    const pending = resumeSwitches.get(streamId);
    clearResumeSwitch(streamId, reason);
    linker.cancel(streamId);
    if (!pending) return;
    await linker.pending(streamId, {
      agent: pending.agent,
      cwd: pending.cwd,
      spawnedAt: Date.now(),
      linked: !!store.getLink(streamId),
    });
  }

  function scheduleResumeFallback(streamId: any, delayMs: any) {
    const pending = resumeSwitches.get(streamId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      restoreNormalPending(streamId, 'timeout').catch((err: any) => {
        pushWarning(streamId, { code: 'session-link:resume-fallback', error: err.message });
      });
    }, delayMs);
    if (typeof pending.timer.unref === 'function') pending.timer.unref();
  }

  function scheduleResumeProbe(streamId: any) {
    const pending = resumeSwitches.get(streamId);
    if (!pending || pending.probeTimer) return;
    pending.probeTimer = setTimeout(async () => {
      pending.probeTimer = null;
      try {
        await linker.confirmSessionSwitch(streamId);
      } catch (err: any) {
        pushWarning(streamId, { code: 'session-link:resume-probe', error: err.message });
      }
      if (resumeSwitches.has(streamId) && linker.isSessionSwitchArmed(streamId)) {
        scheduleResumeProbe(streamId);
      }
    }, 50);
    if (typeof pending.probeTimer.unref === 'function') pending.probeTimer.unref();
  }

  function persistLinkedSession({ streamId, agent, sessionId, sessionFile, cwd, sessionSwitch }: any) {
    const shouldPersist = ['hermes', 'codex'].includes(agent) || (agent === 'claude' && sessionSwitch === true);
    if (!shouldPersist || !sessionId || typeof onSessionLinked !== 'function') return { ok: true, rollback: null };
    if (sessionId === 'seen' || sessionId === 'live') return { ok: true, rollback: null };
    try {
      const rollback = onSessionLinked({ streamId, agent, sessionId, sessionFile, cwd });
      return { ok: true, rollback: typeof rollback === 'function' ? rollback : null };
    } catch (err: any) {
      pushWarning(streamId, { code: 'session-link:persist', error: err.message });
      return { ok: false, rollback: null };
    }
  }

  async function linkHermesStateDb(streamId: string, { dbPath, cwd, linkedAt, followLive = true }: any) {
    void followLive;
    const existing = store.getLink(streamId);
    const pruneAliases = () => {
      const aliases = store.unlinkSessionFileAliases?.(dbPath, streamId, {
        shouldUnlink: (aliasStreamId: string, alias: any) => {
          if (typeof shouldPruneTranscriptAlias !== 'function') return true;
          return shouldPruneTranscriptAlias({
            aliasStreamId,
            streamId,
            agent: alias?.agent || 'hermes',
            sessionFile: dbPath,
          }) !== false;
        },
      }) || [];
      for (const aliasStreamId of aliases) {
        const aliasTail = tails.get(aliasStreamId);
        if (aliasTail) {
          try { aliasTail.close(); } catch {}
          tails.delete(aliasStreamId);
        }
        linker.cancel(aliasStreamId);
        warnings.delete(aliasStreamId);
        resetTurnContext(aliasStreamId);
        emitTranscriptReset(aliasStreamId, 'alias-prune');
      }
      return aliases;
    };
    if (existing?.sessionFile === dbPath) {
      store.link(streamId, {
        ...existing,
        agent: 'hermes',
        sessionId: 'live',
        sessionFile: dbPath,
        cwd: cwd || existing.cwd || null,
        byteOffset: existing.byteOffset || 0,
        linkedAt: linkedAt || existing.linkedAt || Date.now(),
      });
      pruneAliases();
      emit('tab-chat-available', { streamId, agent: 'hermes', sessionId: 'live', sessionFile: dbPath });
      return false;
    }
    const tail = tails.get(streamId);
    if (tail) {
      try { tail.close(); } catch {}
      tails.delete(streamId);
    }
    store.link(streamId, {
      agent: 'hermes',
      sessionId: 'live',
      sessionFile: dbPath,
      cwd: cwd || existing?.cwd || null,
      byteOffset: 0,
      linkedAt: linkedAt || Date.now(),
    });
    pruneAliases();
    emitTranscriptReset(streamId, 'relink');
    emit('tab-chat-available', { streamId, agent: 'hermes', sessionId: 'live', sessionFile: dbPath });
    return true;
  }

  function snapshot(streamId: any, { since, before, limit }: any = {}) {
    const link = store.getLink(streamId);
    if (!link) return null;
    const pageSize = pageLimit(limit);
    const entries =
      typeof before === 'number'
        ? store.readEntriesBefore(streamId, { before, limit: pageSize })
        : typeof since === 'number'
          ? store.readEntries(streamId, { since, limit: pageSize })
          : store.readLatestEntries(streamId, { limit: pageSize });
    const firstId = entries.length ? entries[0].id : null;
    return {
      streamId,
      sessionId: link.sessionId,
      sessionFile: link.sessionFile,
      agent: link.agent,
      entries,
      nextCursor: entries.length ? entries[entries.length - 1].id + 1 : (typeof since === 'number' ? since + 1 : 0),
      hasMoreBefore: firstId !== null ? store.hasEntriesBefore(streamId, firstId) : false,
      warnings: warnings.get(streamId) || [],
    };
  }

  function applyOp(streamId: any, op: any) {
    if (op.kind === 'append') {
      const saved = store.appendEntry(streamId, op.entry);
      emit(`transcript:append:${streamId}`, saved);
      emit('transcript:append', { streamId, entry: saved });
      return saved;
    }
    if (op.kind === 'upsert') {
      const result = store.upsertByKey(streamId, op.key, op.build);
      if (!result) return null;
      if (result.created) {
        emit(`transcript:append:${streamId}`, result.entry);
        emit('transcript:append', { streamId, entry: result.entry });
      } else {
        scheduleTranscriptUpdate(streamId, result.entry);
      }
      return result.entry;
    }
    if (op.kind === 'replace') {
      // /compact semantics: wipe local state, insert the summary entry,
      // broadcast transcript:replace. The renderer drops its entries and
      // renders whatever the snapshot returns (which is just this summary
      // + anything that lands after).
      store.clear(streamId);
      resetTurnContext(streamId);
      const saved = store.appendEntry(streamId, op.summary);
      emitTranscriptReplace(streamId, { streamId, nextCursor: saved.id + 1, summary: saved, reason: op.reason || 'compact' });
      return saved;
    }
    if (op.kind === 'warn') {
      pushWarning(streamId, { code: op.code });
      return null;
    }
    return null;
  }

  function resetStream(streamId: any, reason: any = 'clear', options: any = {}) {
    const tail = tails.get(streamId);
    const link = store.getLink(streamId);
    if (tail) {
      try { tail.close(); } catch {}
      tails.delete(streamId);
    }
    const destructive = DESTRUCTIVE_RESET_REASONS.has(reason);
    if (destructive) {
      store.clear(streamId);
      store.unlink(streamId);
      warnings.delete(streamId);
      resetTurnContext(streamId);
      resetClaudeTurnContext(streamId);
    }
    emitTranscriptReset(streamId, reason);
    // Re-enqueue with the linker so the next session file that appears
    // (e.g. codex writing a fresh rollout-*.jsonl after a terminal-driven
    // /clear, or gemini rewriting its chat JSON) gets claimed. Without this
    // the Chat toggle would vanish on `transcript:reset` (renderer flips
    // `available: false`) and never re-appear until the tab is recreated.
    if (destructive && options.reenqueue !== false && link?.agent) {
      const workspaceId = streamWorkspaceIds.get(streamId) || workspaceIdFromHermesSessionFile(link.sessionFile);
      if (workspaceId) streamWorkspaceIds.set(streamId, workspaceId);
      linker
        .pending(streamId, {
          agent: link.agent,
          cwd: link.cwd || null,
          workspaceId: workspaceId || null,
          spawnedAt: Date.now(),
          linked: link.agent === 'hermes',
        })
        .catch(() => { /* linker degraded; surface via warnings on next match */ });
    }
  }

  function truncateStream(streamId: any, nextCursor: any) {
    store.truncateAfter(streamId, nextCursor);
    emit(`transcript:truncate:${streamId}`, { streamId, nextCursor, reason: 'file-truncate' });
    emit('transcript:truncate', { streamId, nextCursor, reason: 'file-truncate' });
  }

  function appendCommunication(streamId: any, input: any = {}) {
    if (!streamId || !store.getLink(streamId)) return null;
    const direction = input.direction === 'received' ? 'received' : 'sent';
    const command = cleanText(input.command) || 'message';
    const { body, redacted, truncated } = sanitizeCommunicationBody(input.body);
    if (!body) return null;
    const saved = store.appendEntry(streamId, {
      role: 'communication',
      direction,
      command,
      body,
      peerLabel: cleanText(input.peer?.label || input.peerLabel) || undefined,
      peerAgent: cleanText(input.peer?.agent || input.peerAgent) || undefined,
      peerStreamId: cleanText(input.peer?.streamId || input.peerStreamId) || undefined,
      redacted: redacted || undefined,
      truncated: truncated || undefined,
      lifecycle: 'finished',
      tAt: Date.now(),
    });
    emit(`transcript:append:${streamId}`, saved);
    emit('transcript:append', { streamId, entry: saved });
    return saved;
  }

  async function startTail(streamId: any) {
    if (tails.has(streamId)) return;
    const link = store.getLink(streamId);
    if (!link) return;
    if (link.agent === 'claude') {
      if (String(link.sessionFile || '').startsWith('claude-stream://')) {
        // Protocol-native live link (attachClaudeStream) — no file to tail;
        // the live client feeds entries directly.
        return;
      }
      // File-tailed Claude: same pipeline as codex, reading the CLI's own
      // ~/.claude/projects/<cwd>/<sessionId>.jsonl session file. Restore the
      // per-stream turn context so a mid-turn restart keeps folding deltas
      // into the right entries instead of colliding with pre-restart ones.
      if (link.turnState) restoreClaudeTurnContext(streamId, link.turnState);
      const tail = createCodexJsonlTail({
        filePath: link.sessionFile,
        byteOffset: link.byteOffset || 0,
        onEvent: (event: any) => {
          const ops = normalizeClaudeEvent(event, { streamId, source: 'session-file' });
          for (const op of ops) applyOp(streamId, op);
          store.setByteOffset(streamId, tail.getOffset());
          const serialized = serializeClaudeTurnContext(streamId);
          if (serialized) store.setTurnState(streamId, serialized);
        },
        onWarning: (w: any) => {
          if (w.code === 'codex:truncated') {
            resetStream(streamId, 'file-truncate');
          } else {
            pushWarning(streamId, w);
          }
        },
      });
      tails.set(streamId, tail);
      await tail.start();
      return;
    }
    if (link.agent === 'codex') {
      // Rehydrate the normalizer's per-stream turn context so mid-turn
      // restarts don't lose the active turn_id (which agent_message events
      // don't carry themselves). Without this, events read after a restart
      // land under a default key and could collide with pre-restart entries.
      if (link.turnState) restoreTurnContext(streamId, link.turnState);
      const tail = createCodexJsonlTail({
        filePath: link.sessionFile,
        byteOffset: link.byteOffset || 0,
        onEvent: (event: any) => {
          const ops = normalizeCodexEvent(event, { streamId });
          for (const op of ops) applyOp(streamId, op);
          store.setByteOffset(streamId, tail.getOffset());
          const serialized = serializeTurnContext(streamId);
          if (serialized) store.setTurnState(streamId, serialized);
        },
          onWarning: (w: any) => {
            if (w.code === 'codex:truncated') {
              // File truncated under us — treat as reset.
              resetStream(streamId, 'file-truncate');
            } else {
              pushWarning(streamId, w);
            }
          },
      });
      tails.set(streamId, tail);
      await tail.start();
      return;
    }
    if (link.agent === 'hermes') {
      // Modern Hermes state.db live polling was retired from the Electron
      // main process; the Hermes terminal mirror is the live surface. Keep
      // the legacy json-rewrite fallback only for older Hermes installs.
      if (pickHermesStateDb(link.sessionFile)) return;
      let lastKeys = new Set();
      const tail = createGeminiJsonTail({
        filePath: link.sessionFile,
        pollIntervalMs: 500,
        onSnapshot: (snap: any) => {
          const items = normalizeHermesSnapshot(snap);
          const currentKeys = new Set();
          let shrunk = false;
          if (lastKeys.size > items.length) shrunk = true;
          for (const it of items) currentKeys.add(it.keyPath);
          if (shrunk) {
            let missing = false;
            for (const k of lastKeys) if (!currentKeys.has(k)) { missing = true; break; }
            if (missing) {
              store.clear(streamId);
              emitTranscriptReset(streamId, 'file-truncate');
              lastKeys = new Set();
            }
          }
          for (const it of items) {
            if (it.warn) pushWarning(streamId, { code: it.warn });
            applyOp(streamId, {
              kind: 'upsert',
              key: it.keyPath,
              build: () => it.entry,
            });
          }
          lastKeys = currentKeys;
        },
        onWarning: (w: any) => pushWarning(streamId, w),
      });
      tails.set(streamId, tail);
      await tail.start();
      return;
    }
    if (link.agent === 'gemini') {
      let lastKeys = new Set();
      const tail = createGeminiJsonTail({
        filePath: link.sessionFile,
        onSnapshot: (snap: any) => {
          const items = normalizeGeminiSnapshot(snap);
          const currentKeys = new Set();
          // Gemini can shrink — detect and reset when it does.
          let shrunk = false;
          if (lastKeys.size > items.length) shrunk = true;
          for (const it of items) {
            currentKeys.add(it.keyPath);
          }
          if (shrunk) {
            // Conservative: if any previously-seen key is missing from the
            // new snapshot, treat as a full reset.
            let missing = false;
            for (const k of lastKeys) if (!currentKeys.has(k)) { missing = true; break; }
            if (missing) {
              store.clear(streamId);
              emitTranscriptReset(streamId, 'file-truncate');
              lastKeys = new Set();
            }
          }
          for (const it of items) {
            if (it.warn) pushWarning(streamId, { code: it.warn });
            applyOp(streamId, {
              kind: 'upsert',
              key: it.keyPath,
              build: () => it.entry,
            });
          }
          lastKeys = currentKeys;
        },
        onWarning: (w: any) => pushWarning(streamId, w),
      });
      tails.set(streamId, tail);
      await tail.start();
      return;
    }
  }

  // --- Protocol-native Claude (PRD Lane 2) -------------------------------
  // attachClaudeStream spawns/keeps a persistent stream-json client and folds
  // its events into the transcript bus. The renderer drives it through the
  // claude* command methods (send / approve / interrupt / set-permission-mode),
  // never by mutating the projection (PRD D6).

  function attachClaudeStream(streamId: any, opts: any = {}) {
    if (claudeClients.has(streamId)) return claudeClients.get(streamId);
    const cwd = opts.cwd || null;
    // Synthetic link so snapshot() + chat-availability work for a live feed
    // that has no session file on disk.
    const sessionFile = `claude-stream://${streamId}`;
    store.link(streamId, {
      agent: 'claude',
      sessionId: 'live',
      sessionFile,
      cwd,
      byteOffset: 0,
      linkedAt: Date.now(),
    });
    resetClaudeTurnContext(streamId);
    const client = createClaudeClient({
      cwd: cwd || process.cwd(),
      permissionMode: opts.permissionMode || 'default',
      effort: opts.effort,
      env: opts.env,
      onEvent: (raw: any) => {
        try {
          const ops = normalizeClaudeEvent(raw, { streamId });
          for (const op of ops) applyOp(streamId, op);
        } catch (err: any) {
          pushWarning(streamId, { code: 'claude:normalize', error: err?.message });
        }
      },
      onWarning: (w: any) => pushWarning(streamId, w),
      onExit: (info: any) => {
        if (info && info.stderr) {
          applyOp(streamId, {
            kind: 'append',
            entry: {
              role: 'system',
              subtype: 'error',
              text: `Claude session ended: ${String(info.stderr).slice(0, 500)}`,
              lifecycle: 'finished',
              tAt: Date.now(),
            },
          });
        }
        claudeClients.delete(streamId);
      },
    });
    claudeClients.set(streamId, client);
    emit('tab-chat-available', { streamId, agent: 'claude', sessionId: 'live', sessionFile });
    try {
      client.start();
    } catch (err: any) {
      pushWarning(streamId, { code: 'claude:start', error: err?.message });
    }
    return client;
  }

  function detachClaudeStream(streamId: any) {
    const client = claudeClients.get(streamId);
    if (client) {
      try { client.close(); } catch {}
      claudeClients.delete(streamId);
    }
    resetClaudeTurnContext(streamId);
  }

  function claudeSendUserMessage(streamId: any, text: any) {
    const client = claudeClients.get(streamId);
    return client ? client.sendUserMessage(text) : false;
  }
  function claudeRespondToApproval(streamId: any, requestId: any, decision: any) {
    const client = claudeClients.get(streamId);
    return client ? client.respondToApproval(requestId, decision) : false;
  }
  function claudeInterrupt(streamId: any) {
    const client = claudeClients.get(streamId);
    return client ? client.interrupt() : false;
  }
  function claudeSetPermissionMode(streamId: any, mode: any) {
    const client = claudeClients.get(streamId);
    return client ? client.setPermissionMode(mode) : false;
  }
  function isClaudeStreamActive(streamId: any) {
    return claudeClients.has(streamId);
  }

  async function linkPending(streamId: any, { agent, cwd, workspaceId, spawnedAt }: any) {
    if (workspaceId) streamWorkspaceIds.set(streamId, workspaceId);
    // Hermes fast-path: modern Hermes writes messages into <HERMES_HOME>/state.db,
    // not the legacy hermes-home/sessions/*.json files. If the per-workspace DB
    // exists, synthesize a link immediately and skip the legacy file linker.
    let existingLink = store.getLink(streamId);
    if (agent === 'hermes' && workspaceId && userDataPath) {
      const dbPath = path.join(userDataPath, `hermes-home-${workspaceId}`, 'state.db');
      if (fs.existsSync(dbPath)) {
        await linkHermesStateDb(streamId, { dbPath, cwd, linkedAt: spawnedAt || Date.now(), followLive: true });
        return { ok: true };
      }
    }
    // A persisted Claude transcript link is only valid for the session the
    // live lane is actually running. A prior child-session launch can leave
    // the old link behind while the owner row points at a newly minted
    // --session-id. Advertising that old file makes Chat look available but
    // shows the wrong conversation until the new file is written. Detach it
    // now; the exact-id matcher below will relink as soon as Claude creates
    // the current session file.
    if (agent === 'claude' && existingLink && typeof resolveExpectedSessionId === 'function') {
      const expectedSessionId = resolveExpectedSessionId(streamId, agent);
      if (
        expectedSessionId &&
        expectedSessionId !== 'seen' &&
        expectedSessionId !== 'live' &&
        String(existingLink.sessionId) !== String(expectedSessionId)
      ) {
        resetStream(streamId, 'clear', { reenqueue: false });
        existingLink = null;
      }
    }
    if (!existingLink && typeof resolveExpectedSessionFile === 'function') {
      try {
        const expected = resolveExpectedSessionFile(streamId, agent);
        if (expected?.sessionId && expected?.sessionFile && fs.statSync(expected.sessionFile).isFile()) {
          linker.linkExisting(streamId, {
            agent,
            sessionId: expected.sessionId,
            sessionFile: expected.sessionFile,
            cwd: expected.cwd || cwd || null,
            byteOffset: 0,
          });
          existingLink = store.getLink(streamId);
        }
      } catch {
        // Missing/unreadable expected files stay pending for the normal live
        // watcher; a later provider write can still establish the link.
      }
    }
    // Resume tailing any persisted link — the on-disk transcript survives
    // restarts and should keep flowing to the chat view.
    if (existingLink) {
      await startTail(streamId);
    }
    // ALWAYS keep the stream in the linker's pending queue for its lifetime.
    // Without this, a PTY that respawns under the same streamId would write
    // a new session file that we'd never claim — the chat view would keep
    // showing the stale transcript. `isCurrentLink` (in the linker) prevents
    // us from re-claiming the file we're already tailing, so re-enqueuing is
    // cheap and idempotent.
    return linker.pending(streamId, {
      agent,
      cwd,
      workspaceId: workspaceId || null,
      spawnedAt: spawnedAt || Date.now(),
      linked: !!existingLink,
    });
  }

  function cancelPending(streamId: any) {
    linker.cancel(streamId);
  }

  // Called when the user runs a session-clearing slash command ('/clear').
  // Codex and Gemini each write a NEW session file in response. We can't
  // pre-emptively drop the existing transcript (the terminal's /clear might
  // fail silently) — instead we re-enqueue the tab with a fresh spawn time
  // and let the linker claim whatever session file appears next. When that
  // match fires, `onLink` above detects the filename change and calls
  // `resetStream`, which drops local entries and emits transcript:reset.
  async function onSlashClear(streamId: any, { agent, cwd }: any) {
    if (!agent || (agent !== 'codex' && agent !== 'gemini')) return;
    linker.cancel(streamId);
    await linker.pending(streamId, { agent, cwd: cwd || null, spawnedAt: Date.now() });
  }

  // Claude changes sessions in-process, so arm narrowly and wait for picker Enter before relinking.
  async function onSlashResume(streamId: any, { agent, cwd }: any) {
    if (agent !== 'claude') return { ok: false, reason: 'unsupported-agent' };
    const sessionDir = typeof resolveResumeSessionDir === 'function'
      ? resolveResumeSessionDir(streamId, agent)
      : null;
    if (!sessionDir) return { ok: false, reason: 'missing-session-path' };
    linker.cancel(streamId);
    clearResumeSwitch(streamId);
    resumeSwitches.set(streamId, { agent, cwd: cwd || null, timer: null, probeTimer: null });
    scheduleResumeFallback(streamId, 5 * 60_000);
    return linker.pending(streamId, {
      agent,
      cwd: cwd || null,
      spawnedAt: Date.now(),
      linked: !!store.getLink(streamId),
      allowSessionSwitch: true,
      sessionDir,
      deferInitialMatch: true,
    });
  }

  async function onResumeSelection(streamId: any) {
    const result = await linker.confirmSessionSwitch(streamId);
    if (result?.ok) {
      scheduleResumeFallback(streamId, 10_000);
      scheduleResumeProbe(streamId);
    }
    return result;
  }

  async function cancelResumeSelection(streamId: any) {
    if (!linker.isSessionSwitchArmed(streamId)) return;
    await restoreNormalPending(streamId, 'cancelled');
  }

  async function shutdownStream(streamId: any) {
    const tail = tails.get(streamId);
    if (tail) {
      try { tail.close(); } catch {}
      tails.delete(streamId);
    }
    detachClaudeStream(streamId);
    linker.cancel(streamId);
  }

  function shutdown() {
    for (const tail of tails.values()) {
      try { tail.close(); } catch {}
    }
    tails.clear();
    for (const client of claudeClients.values()) {
      try { client.close(); } catch {}
    }
    claudeClients.clear();
    for (const pending of resumeSwitches.values()) {
      if (pending?.timer) clearTimeout(pending.timer);
      if (pending?.probeTimer) clearTimeout(pending.probeTimer);
    }
    resumeSwitches.clear();
    linker.shutdown();
    try { store.close(); } catch {}
  }

  return {
    snapshot,
    linkPending,
    cancelPending,
    onSlashClear,
    onSlashResume,
    onResumeSelection,
    cancelResumeSelection,
    shutdownStream,
    resetStream,
    truncateStream,
    appendCommunication,
    shutdown,
    // Protocol-native Claude (PRD Lane 2)
    attachClaudeStream,
    detachClaudeStream,
    claudeSendUserMessage,
    claudeRespondToApproval,
    claudeInterrupt,
    claudeSetPermissionMode,
    isClaudeStreamActive,
    _internal: { store, tails, warnings, claudeClients },
  };
}

function createNoopController(_bus: any) {
  void _bus;
  return {
    snapshot: () => null,
    linkPending: () => Promise.resolve({ ok: false, reason: 'transcript-disabled' }),
    cancelPending: () => {},
    onSlashClear: () => Promise.resolve(),
    onSlashResume: () => Promise.resolve({ ok: false, reason: 'transcript-disabled' }),
    onResumeSelection: () => Promise.resolve({ ok: false, reason: 'transcript-disabled' }),
    cancelResumeSelection: () => {},
    shutdownStream: () => Promise.resolve(),
    resetStream: () => {},
    truncateStream: () => {},
    appendCommunication: () => null,
    shutdown: () => {},
    attachClaudeStream: () => null,
    detachClaudeStream: () => {},
    claudeSendUserMessage: () => false,
    claudeRespondToApproval: () => false,
    claudeInterrupt: () => false,
    claudeSetPermissionMode: () => false,
    isClaudeStreamActive: () => false,
    _internal: { store: null, tails: new Map(), warnings: new Map(), claudeClients: new Map() },
  };
}

module.exports = { createTranscriptController };
