// Two-stream ping-pong relay.
//
// Given two existing streams A and B, alternate: read the last turn output
// from A, feed it to B as a prompt, wait for B's turn-complete, reverse.
// Stops when either side emits the DONE/BLOCKED trailer, a `stopOn` regex
// matches, or maxRounds is reached.
//
// Use cases: a reviewer↔implementer pair (Hermes reviews Codex's diff,
// Codex iterates), a teacher↔learner pair, any symmetric two-agent loop.
// For single-worker ping-pong (Hermes drives one worker over multiple
// rounds), runTask in orchestrator.cjs already does the job — relay.cjs
// is only for the two-stream case.

const { parseTrailer } = require('./prompt.cjs');
const { askOnce } = require('./orchestrator.cjs');

const DEFAULT_ROUND_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_MAX_ROUNDS = 8; // 4 full ping-pong cycles

function normalizeMaxRounds(value: any) {
  if (value === 0) return Infinity;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_ROUNDS;
}

function compileStopOn(stopOn: any) {
  if (!stopOn) return null;
  if (stopOn instanceof RegExp) return stopOn;
  try {
    return new RegExp(String(stopOn), 'm');
  } catch {
    throw new Error(`relay: invalid stopOn regex: ${stopOn}`);
  }
}

async function readLastTurn(client: any, streamId: any) {
  // streamFollow returns the diff since last call — perfect for "what did
  // the agent say since I last looked." The first call on a fresh stream
  // may return a large block; callers should prime with streamFollow once
  // before starting the relay if they want just the next turn.
  const r = await client.invoke('streamFollow', { streamId });
  return r?.text || '';
}

async function relay(client: any, options: any) {
  const {
    fromStreamId,
    toStreamId,
    maxRounds = DEFAULT_MAX_ROUNDS,
    stopOn = null,
    roundTimeoutMs = DEFAULT_ROUND_TIMEOUT,
    mode = 'type',
    transform = null,
    caller,
    // Optional seed — if provided, sent to `toStreamId` as the opening
    // message instead of pulling `fromStreamId`'s current buffer.
    seed = null,
  } = options || {};

  if (!fromStreamId) throw new Error('relay: fromStreamId required');
  if (!toStreamId) throw new Error('relay: toStreamId required');
  if (fromStreamId === toStreamId) {
    throw new Error('relay: fromStreamId and toStreamId must differ');
  }

  const stopRx = compileStopOn(stopOn);
  const totalRounds = normalizeMaxRounds(maxRounds);
  const rounds = [];
  let source = fromStreamId;
  let target = toStreamId;
  let stopReason = 'max-rounds';

  // Prime streamFollow on both streams so the first diff call returns the next
  // turn, not the entire buffer. Without this, a bug in the seeded path
  // caused the post-swap source (originally the target) to return empty on
  // its first follow — relay stopped with stopReason="empty-turn" after one
  // round even though the agent actually replied. We also keep the reply
  // from askOnce and prefer that over the next follow call; follow stays as
  // a belt-and-suspenders fallback if askOnce didn't capture newOutput.
  for (const sid of [source, target]) {
    try { await client.invoke('streamFollow', { streamId: sid }); } catch {}
  }

  let lastReply = null;
  for (let i = 0; i < totalRounds; i++) {
    let payload;
    if (i === 0 && seed) {
      payload = String(seed);
    } else if (lastReply) {
      payload = lastReply;
    } else {
      payload = await readLastTurn(client, source);
    }
    if (typeof transform === 'function') {
      payload = transform({ text: payload, fromStreamId: source, toStreamId: target, round: i });
    }

    const trimmed = String(payload || '').trim();
    if (!trimmed) {
      stopReason = 'empty-turn';
      break;
    }

    const askResult = await askOnce(client, {
      streamId: target,
      prompt: trimmed,
      timeoutMs: roundTimeoutMs,
      mode,
      caller,
      command: 'relay',
    });
    const newOutput = askResult?.newOutput || '';
    const trailer = parseTrailer(newOutput);
    lastReply = newOutput;

    rounds.push({
      index: i,
      from: source,
      to: target,
      endState: askResult?.endState || null,
      elapsedMs: askResult?.elapsedMs || null,
      outcome: trailer.outcome,
      detail: trailer.detail,
      inputChars: trimmed.length,
      outputChars: newOutput.length,
    });

    if (!askResult || askResult.ok === false) {
      stopReason = 'error';
      break;
    }
    if (trailer.outcome === 'done') { stopReason = 'done'; break; }
    if (trailer.outcome === 'blocked') { stopReason = 'blocked'; break; }
    if (stopRx && stopRx.test(newOutput)) { stopReason = 'stop-on-match'; break; }
    if (askResult.endState === 'awaiting-approval') {
      stopReason = 'awaiting-approval';
      break;
    }

    // Swap for the next round.
    const swap = source;
    source = target;
    target = swap;
  }

  return {
    rounds: rounds.length,
    roundDetails: rounds,
    stopReason,
    lastSource: source,
    lastTarget: target,
  };
}

module.exports = { relay };
