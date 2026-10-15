const VALID_STATES = new Set([
  'booting',
  'awaiting-input',
  'busy',
  'awaiting-approval',
  'turn-complete',
  'interrupted',
  'error',
  'unknown',
]);

function compilePattern(spec: any) {
  if (!spec) return null;
  const src = typeof spec === 'string' ? spec : spec.pattern;
  if (!src) return null;
  return new RegExp(src, 'm');
}

function compileProfile(raw: any) {
  return {
    ...raw,
    _rx: {
      ready: compilePattern(raw.ready),
      busy: compilePattern(raw.busy),
      approval: compilePattern(raw.approval),
      error: compilePattern(raw.error),
      turnComplete: compilePattern(raw.turnComplete) || compilePattern(raw.ready),
    },
  };
}

const CLAUDE_CODE_PROMPT_READY_FALLBACK =
  /(?:^|\n)[ \t\u00a0]*(?:│[ \t\u00a0]*)?[❯>](?:(?:[ \t\u00a0]*▌?[ \t\u00a0]*)|(?:[ \t\u00a0]+▌?[ \t\u00a0]*Try "[^"\n]*"[ \t\u00a0]*))(?:│[ \t\u00a0]*)?(?=\n|$)/m;
const CLAUDE_CODE_BUSY_FOOTER_FALLBACK = /\besc to interrupt\b|esc\s*\(interrupt\)/i;
// A worker that emits a final DONE:/BLOCKED: trailer is logically done
// even when the ready-cursor regex never matched (boot-time race,
// terminal repaint, profile mismatch). Reconciliation parses the
// ANSI-STRIPPED raw byte ring with the chrome-tolerant loose parser:
// TUI renderers (claude code) repaint the screen, so the trailer
// survives only in the raw output bytes — never reliably in the
// rendered scrollback.
const { listTerminalTrailersLooseStripped, listTrailers, stripAnsi } = require('../../tools/ace/src/trailers.cjs');

function isClaudeCodeProfile(profile: any) {
  return profile?.id === 'claude-code';
}

function hasClaudeCodeBusyFooter(profile: any, viewport: any) {
  return isClaudeCodeProfile(profile) && CLAUDE_CODE_BUSY_FOOTER_FALLBACK.test(viewport || '');
}

function isClaudeCodePromptReadyFallback(profile: any, viewport: any) {
  if (!isClaudeCodeProfile(profile)) return false;
  if (!viewport || hasClaudeCodeBusyFooter(profile, viewport)) return false;
  return CLAUDE_CODE_PROMPT_READY_FALLBACK.test(viewport);
}

function createStateMachine({ screen, emit, settle }: any) {
  const machines = new Map();
  // Settle-window overrides exist for tests only; production uses defaults.
  const MIN_TURN_DURATION_MS = Math.max(0, Number(settle?.minTurnMs ?? process.env.ACE_SM_MIN_TURN_MS ?? 2500));
  const POST_ACTIVITY_QUIET_MS = Math.max(0, Number(settle?.quietMs ?? process.env.ACE_SM_QUIET_MS ?? 2500));

  // The trailer-observation text domain: the ANSI-stripped raw ring.
  function trailerRingText(streamId: any) {
    if (typeof screen.strippedRing === 'function') return screen.strippedRing(streamId);
    if (typeof screen.rawRing === 'function') return stripAnsi(screen.rawRing(streamId));
    return '';
  }

  // Echo suppression is occurrence-sensitive and region-bounded: a matching
  // trailer is echo only while (a) the stream is inside the echo region and
  // (b) its occurrence count does not exceed the prompt's own count — the
  // extra occurrence is the worker's verbatim reply and must complete.
  function trailerKeyOf(t: any) {
    return `${t.kind} ${t.detail || ''}`;
  }

  function isEchoOfSubmittedPrompt(m: any, trailer: any, sinceBaseline: any) {
    if (!m.submittedTrailerCounts || !m.submittedTrailerCounts.size || !trailer) return false;
    const since = String(sinceBaseline || '');
    if (since.length > (m.submittedEchoWindowChars || 0)) return false;
    const key = trailerKeyOf(trailer);
    const promptCount = m.submittedTrailerCounts.get(key) || 0;
    if (!promptCount) return false;
    const seenCount = listTrailers(since).filter((t: any) => trailerKeyOf(t) === key).length;
    return seenCount <= promptCount;
  }

  // Bytes since the baseline, ROLLOVER-SAFE: the ring is bounded, so after
  // enough appends the baseline is no longer a prefix. Re-anchor on the
  // baseline's tail before falling back to the whole ring — otherwise an
  // already-consumed trailer still inside the ring would reconcile again.
  const BASELINE_ANCHOR_CHARS = 1024;
  function sinceBaselineOf(baseline: any, ringNow: any) {
    const base = String(baseline || '');
    const ring = String(ringNow || '');
    if (!base) return ring;
    if (ring.startsWith(base)) return ring.slice(base.length);
    const anchor = base.slice(-BASELINE_ANCHOR_CHARS);
    if (anchor) {
      const idx = ring.lastIndexOf(anchor);
      if (idx >= 0) return ring.slice(idx + anchor.length);
    }
    return ring;
  }

  function pendingRawTrailer(m: any, streamId: any, readyMatch: any) {
    const sinceBaseline = sinceBaselineOf(m.trailerBaselineStripped, trailerRingText(streamId));
    const initialReadyScrollback = m.submittedAt === 0 && !m.readySeenSinceSpawn && readyMatch;
    const found = initialReadyScrollback ? [] : listTerminalTrailersLooseStripped(sinceBaseline);
    if (!found.length) return null;
    const candidate = found[found.length - 1];
    return isEchoOfSubmittedPrompt(m, candidate, sinceBaseline) ? null : candidate;
  }

  function ensure(streamId: any, profile: any) {
    let m = machines.get(streamId);
    if (m) return m;
    m = {
      streamId,
      profile,
      state: 'booting',
      readySeenSinceSpawn: false,
      submittedAt: 0,
      sawBusySinceSubmit: false,
      interruptedAt: 0,
      interruptedActivitySeq: 0,
      interruptedRawRing: '',
      trailerBaselineStripped: trailerRingText(streamId),
      trailerReconcilePaused: false,
      lastCompletionReason: null,
      lastReconciledTrailer: null,
      lastChangeAt: Date.now(),
      lastApprovalText: '',
      exited: false,
    };
    machines.set(streamId, m);
    return m;
  }

  function get(streamId: any) {
    return machines.get(streamId) || null;
  }

  function setProfile(streamId: any, profile: any) {
    const m = ensure(streamId, profile);
    m.profile = profile;
  }

  function markSubmit(streamId: any, submittedText: any = '') {
    const m = machines.get(streamId);
    if (!m) return;
    m.submittedAt = Date.now();
    m.sawBusySinceSubmit = false;
    m.interruptedAt = 0;
    m.interruptedActivitySeq = 0;
    m.interruptedRawRing = '';
    // Snapshot the raw byte stream at submit time. Stale-trailer
    // reconciliation only considers output written AFTER this snapshot,
    // so a previous turn's DONE: still in scrollback cannot terminate
    // the new turn before the worker emits its own trailer.
    m.submittedRawRing = typeof screen.rawRing === 'function' ? screen.rawRing(streamId) : '';
    m.trailerBaselineStripped = trailerRingText(streamId);
    m.lastCompletionReason = null;
    m.lastReconciledTrailer = null;
    // Trailer-shaped prompt lines: their pty echo must not reconcile. The
    // echo region is bounded by the prompt size (x2 + margin for rendering).
    const submitted = stripAnsi(submittedText);
    m.submittedTrailerCounts = new Map();
    for (const t of listTrailers(submitted)) {
      const key = trailerKeyOf(t);
      m.submittedTrailerCounts.set(key, (m.submittedTrailerCounts.get(key) || 0) + 1);
    }
    m.submittedEchoWindowChars = submitted.length * 2 + 2048;
    m.approvalAnswered = false;
    if (m.state === 'turn-complete' || m.state === 'interrupted') {
      transitionTo(m, 'awaiting-input');
    }
  }

  // Called by `ace approve` right after y/n + enter is sent. Latches off
  // approval pattern matching so busy/ready signals take over without
  // waiting for the old prompt text to scroll out of the viewport.
  function markApprovalAnswered(streamId: any) {
    const m = machines.get(streamId);
    if (!m) return;
    m.approvalAnswered = true;
  }

  function markExit(streamId: any, code: any) {
    const m = machines.get(streamId);
    if (!m) return;
    m.exited = true;
    transitionTo(m, 'error', { reason: 'exit', code });
  }

  function markInterrupted(streamId: any, reason: any = 'interrupt') {
    const m = machines.get(streamId);
    if (!m || m.exited) return;
    const interruptible = m.state === 'booting' || m.state === 'busy' || m.state === 'awaiting-approval';
    m.submittedAt = 0;
    m.sawBusySinceSubmit = false;
    m.approvalAnswered = true;
    m.interruptedAt = Date.now();
    m.interruptedActivitySeq = typeof screen.activitySeq === 'function' ? screen.activitySeq(streamId) : 0;
    m.interruptedRawRing = typeof screen.rawRing === 'function' ? screen.rawRing(streamId) : '';
    if (interruptible) {
      transitionTo(m, 'interrupted', { reason });
    }
  }

  function dispose(streamId: any) {
    machines.delete(streamId);
  }

  function transitionTo(m: any, next: any, extra?: any) {
    if (!VALID_STATES.has(next)) return;
    if (m.state === next) return;
    const prev = m.state;
    m.state = next;
    m.lastChangeAt = Date.now();
    if (next === 'awaiting-approval') {
      m.lastApprovalText = extractApprovalPrompt(m);
    }
    if (emit) emit('state-change', { streamId: m.streamId, from: prev, to: next, ...(extra || {}) });
    if (next === 'awaiting-approval' && emit) {
      emit('approval-requested', { streamId: m.streamId, prompt: m.lastApprovalText });
    }
    if (prev === 'booting' && next !== 'booting') {
      // Advance the trailer baseline past boot output — UNLESS it holds an
      // unobserved trailer (fast worker or adoption replay): that completion
      // would be lost.
      const ringNow = trailerRingText(m.streamId);
      const since = sinceBaselineOf(m.trailerBaselineStripped, ringNow);
      if (!listTerminalTrailersLooseStripped(since).length) {
        m.trailerBaselineStripped = ringNow;
      }
      if (emit) emit('tab-ready', { streamId: m.streamId });
    }
  }

  function extractApprovalPrompt(m: any) {
    const rx = m.profile?._rx?.approval;
    if (!rx) return '';
    const txt = screen.scrollback(m.streamId, 60);
    const hit = rx.exec(txt);
    if (!hit) return '';
    const lines = txt.split('\n');
    const before = txt.slice(0, hit.index).split('\n').length - 1;
    const start = Math.max(0, before - 2);
    const end = Math.min(lines.length, before + 6);
    return lines.slice(start, end).join('\n').trim();
  }

  function evaluate(streamId: any) {
    const m = machines.get(streamId);
    if (!m || m.exited) return;
    const rx = m.profile?._rx;
    if (!rx) return;

    if (rx.error && rx.error.test(screen.scrollback(streamId, 200))) {
      transitionTo(m, 'error');
      return;
    }

    const viewport = screen.text(streamId);
    const readyMatch =
      (rx.ready && rx.ready.test(viewport) && !hasClaudeCodeBusyFooter(m.profile, viewport)) ||
      isClaudeCodePromptReadyFallback(m.profile, viewport);

    const QUIET_MS = 500;
    const now = Date.now();
    const lastActivityMs = screen.lastActivityMs(streamId);

    // Stale terminal-trailer reconciliation: a worker that printed a final
    // DONE:/BLOCKED: line is logically done even if the ready cursor regex
    // never matched. Only bytes since the last emitted-trailer/submit
    // baseline count, only settled streams qualify (quiet + post-submit
    // grace), and a prompt-echo trailer never does.
    const reconcileSettled =
      now - lastActivityMs >= POST_ACTIVITY_QUIET_MS &&
      (m.submittedAt === 0 || now - m.submittedAt >= MIN_TURN_DURATION_MS);
    if (!m.trailerReconcilePaused && reconcileSettled) {
      const reconciled = pendingRawTrailer(m, streamId, readyMatch);
      if (reconciled) {
        if (!m.readySeenSinceSpawn) m.readySeenSinceSpawn = true;
        m.lastCompletionReason = 'trailer-reconciled';
        // The parsed trailer, for the completion observer's raw-ring fallback.
        m.lastReconciledTrailer = reconciled;
        transitionTo(m, 'turn-complete', { reason: 'trailer-reconciled' });
        m.submittedAt = 0;
        m.sawBusySinceSubmit = false;
        m.submittedRawRing = '';
        return;
      }
    }

    // Byte-activity is the source of truth for "busy". Pattern matching
    // against the viewport alone is unreliable: every Ace we target
    // keeps the prompt line visible while working, and stale busy text
    // from earlier in a session lingers in the viewport long after the
    // turn that produced it is over. "Bytes flowing during an open
    // turn" captures the real thing without depending on fragile
    // cosmetic markers.
    //
    // MIN_TURN_DURATION_MS is a grace window after submit during which
    // we never declare turn-complete, even if the prompt regex matches
    // and bytes go quiet. This prevents premature firing for agents
    // that delegate to a remote LLM (like Hermes) where the input echo
    // can finish typing before the model has produced its first token.
    // The user-visible prompt cursor (e.g. `❯ ▌`) stays on screen the
    // whole time, so the ready pattern matches and would otherwise
    // race us into turn-complete before the worker streams a single
    // character.
    const approvalMatch = !m.approvalAnswered && rx.approval && rx.approval.test(viewport);
    const interrupted = m.state === 'interrupted';
    const activitySeq = typeof screen.activitySeq === 'function' ? screen.activitySeq(streamId) : 0;
    const activityAfterInterrupt =
      m.interruptedAt > 0 &&
      (lastActivityMs > m.interruptedAt || activitySeq > (m.interruptedActivitySeq || 0));
    const rawRing = typeof screen.rawRing === 'function' ? screen.rawRing(streamId) : '';
    const outputAfterInterrupt =
      m.interruptedRawRing && rawRing.startsWith(m.interruptedRawRing)
        ? rawRing.slice(m.interruptedRawRing.length)
        : rawRing;
    const readyAfterInterrupt = interrupted && activityAfterInterrupt && rx.ready && rx.ready.test(outputAfterInterrupt);
    const lastActivityAgoMs = now - lastActivityMs;
    const byteActive = lastActivityAgoMs < QUIET_MS;
    const inGracePeriod =
      m.submittedAt > 0 &&
      ((now - m.submittedAt) < MIN_TURN_DURATION_MS ||
        lastActivityAgoMs < POST_ACTIVITY_QUIET_MS);

    let hit = null;
    if (m.submittedAt > 0 && byteActive) hit = 'busy';
    else if (approvalMatch) hit = 'awaiting-approval';
    else if (readyMatch && (!interrupted || !activityAfterInterrupt || readyAfterInterrupt)) hit = 'ready';

    if (interrupted && !activityAfterInterrupt) return;
    if (interrupted && activityAfterInterrupt && !hit) {
      transitionTo(m, 'busy', { reason: 'post-interrupt-output' });
      return;
    }

    if (hit === 'busy') {
      // With no outstanding submit, a busy marker is cosmetic (post-turn
      // animation redraw, resize re-render). Only a real user submit
      // opens a new busy window.
      if (m.submittedAt === 0) return;
      m.sawBusySinceSubmit = true;
      transitionTo(m, 'busy');
      return;
    }
    if (hit === 'awaiting-approval') {
      transitionTo(m, 'awaiting-approval');
      return;
    }
    if (hit === 'ready') {
      if (!m.readySeenSinceSpawn) m.readySeenSinceSpawn = true;
      // Within the grace window after submit, the prompt cursor visible
      // on screen may just be the echo of the input we typed, not a
      // real turn-complete. Hold whatever state we were in (typically
      // busy once any byte has flowed) until either the worker actually
      // streams or the grace period elapses. Without this, agents that
      // delegate to a slow LLM (Hermes) fire turn-complete before the
      // first token arrives.
      if (inGracePeriod && m.submittedAt > 0) {
        return;
      }
      if (m.submittedAt > 0 && m.sawBusySinceSubmit) {
        transitionTo(m, 'turn-complete');
        // Close the turn window. Anything busy-like after this is
        // cosmetic until the next markSubmit.
        m.submittedAt = 0;
        m.sawBusySinceSubmit = false;
      } else if (m.state !== 'turn-complete') {
        // Stay in turn-complete across idle re-renders; `markSubmit` is the
        // only thing that flips us back to busy for the next turn.
        transitionTo(m, 'awaiting-input');
      }
      return;
    }

    if (!m.readySeenSinceSpawn) {
      transitionTo(m, 'booting');
      return;
    }
    // Quiet gap between tool calls mid-turn — stay busy, not idle. This is
    // the state-contract invariant that callers rely on.
    if (m.submittedAt > 0 && m.sawBusySinceSubmit) {
      transitionTo(m, 'busy');
    }
  }

  return {
    ensure,
    get,
    setProfile,
    markSubmit,
    markApprovalAnswered,
    markExit,
    markInterrupted,
    setTrailerReconcilePaused: (streamId: any, paused: any) => {
      const m = machines.get(streamId);
      if (!m) return;
      m.trailerReconcilePaused = !!paused;
      if (!paused) {
        m.trailerBaselineStripped = trailerRingText(streamId);
        m.lastReconciledTrailer = null;
      }
    },
    markTrailerEmitted: (streamId: any) => {
      const m = machines.get(streamId);
      if (!m) return;
      m.trailerBaselineStripped = trailerRingText(streamId);
      m.lastCompletionReason = null;
      m.lastReconciledTrailer = null;
    },
    // Echo keys still fully explainable as prompt echo (region-bounded and
    // occurrence-sensitive) — the single source all completion sinks filter by.
    echoTrailerKeysFor: (streamId: any) => {
      const m = machines.get(streamId);
      if (!m || !m.submittedTrailerCounts || !m.submittedTrailerCounts.size) return [];
      const since = sinceBaselineOf(m.trailerBaselineStripped, trailerRingText(streamId));
      if (since.length > (m.submittedEchoWindowChars || 0)) return [];
      const seenCounts = new Map();
      for (const t of listTrailers(since)) {
        const key = trailerKeyOf(t);
        seenCounts.set(key, (seenCounts.get(key) || 0) + 1);
      }
      const keys: any[] = [];
      for (const [key, promptCount] of m.submittedTrailerCounts) {
        if ((seenCounts.get(key) || 0) <= promptCount) keys.push(key);
      }
      return keys;
    },
    // Non-mutating probe: is a non-echo raw-ring trailer awaiting reconcile?
    hasPendingRawTrailer: (streamId: any) => {
      const m = machines.get(streamId);
      if (!m || m.exited || m.trailerReconcilePaused) return false;
      return Boolean(m.lastReconciledTrailer || pendingRawTrailer(m, streamId, false));
    },
    dispose,
    evaluate,
    streamIds: () => Array.from(machines.keys()),
  };
}

module.exports = { createStateMachine, compileProfile, VALID_STATES };
