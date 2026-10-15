// telemetry.test — proves the agent-written / watcher-folded telemetry model:
// an agent appends telemetry (rubric/commands/duration/its own token spend)
// when it finishes; the reconciler folds it into state (never into a decision);
// the lean board card surfaces it and is keyed by the working agent — and the
// watcher spends ZERO tokens doing any of this (it is a pure JS fold).
const test = require('node:test');
const assert = require('node:assert');

const { createMemoryEventLog } = require('../event-ledger.cts');
const { reconcile } = require('../reconciler.cts');
const { projectLeanBoard } = require('../board-projection.cts');
const { fromCompletion, autoTelemetryFor } = require('../from-completion.cts');

function telemetry(agent: string, over: any = {}) {
  return {
    agent,
    rubric: 'goal-agent-spec-v2',
    score: 0.92,
    commands: ['npm run build', 'npm test'],
    durationMs: 84000,
    tokens: 152000,
    notes: 'all green',
    ...over,
  };
}

test('worker.completed telemetry folds into state.telemetry (totals + latest), not into the decision', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-x', type: 'run.created', payload: { spec: { goal: 'Add a toggle', driver: 'rook' } } });
  log.append({
    runId: 'feat-x',
    type: 'worker.completed',
    payload: { outcome: 'DONE', currentHeadSha: 's1', telemetry: telemetry('rook') },
  });

  const { state, decision } = reconcile('feat-x', log);
  assert.equal(state.telemetry.totals.runs, 1);
  // Invariant: mergeTelemetry pushes one entry per increment of totals.runs.
  assert.equal(state.telemetry.entries.length, state.telemetry.totals.runs);
  assert.equal(state.telemetry.totals.commands, 2);
  assert.equal(state.telemetry.totals.tokens, 152000);
  assert.equal(state.telemetry.totals.durationMs, 84000);
  assert.equal(state.telemetry.latest.agent, 'rook');
  assert.equal(state.telemetry.latest.score, 0.92);
  // Telemetry must NOT alter the spine's next-action (worker done, no validator).
  assert.equal(decision.next, 'gate');
});

test('a standalone worker.telemetry event folds (rides payload.telemetry OR the bare payload)', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-y', type: 'run.created', payload: { spec: { goal: 'Build API' } } });
  // wrapped form
  log.append({ runId: 'feat-y', type: 'worker.telemetry', payload: { telemetry: telemetry('codex', { tokens: 1000 }) } });
  // bare form (payload IS the telemetry)
  log.append({ runId: 'feat-y', type: 'worker.telemetry', payload: telemetry('codex', { tokens: 500, commands: ['npm run lint'] }) });

  const { state } = reconcile('feat-y', log);
  assert.equal(state.telemetry.totals.runs, 2);
  assert.equal(state.telemetry.totals.tokens, 1500);
  assert.equal(state.telemetry.totals.commands, 3); // 2 + 1
});

test('the lean board card is keyed by the working agent and carries the telemetry summary', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-z', type: 'run.created', payload: { spec: { goal: 'Ship it', missionId: 'm1', driver: 'rook' } } });
  log.append({
    runId: 'feat-z',
    type: 'worker.completed',
    payload: { outcome: 'DONE', currentHeadSha: 's2', telemetry: telemetry('rook') },
  });

  const board = projectLeanBoard(log);
  const card = board.cards.find((c: any) => c.id === 'feat-z');
  assert.ok(card, 'card present');
  assert.equal(card.agentId, 'rook');
  assert.equal(card.key, 'rook/feat-z'); // agent-keyed display id
  assert.ok(card.telemetry, 'telemetry attached');
  assert.equal(card.telemetry.agent, 'rook');
  assert.equal(card.telemetry.rubric, 'goal-agent-spec-v2');
  assert.equal(card.telemetry.score, 0.92);
  assert.equal(card.telemetry.commands, 2);
  assert.equal(card.telemetry.tokens, 152000);
});

test('a card with no telemetry has telemetry:null and falls back to the spec driver for its key', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'feat-q', type: 'run.created', payload: { spec: { goal: 'No telem', driver: 'king' } } });

  const board = projectLeanBoard(log);
  const card = board.cards.find((c: any) => c.id === 'feat-q');
  assert.equal(card.telemetry, null);
  assert.equal(card.agentId, 'king');
  assert.equal(card.key, 'king/feat-q');
});

test('fromCompletion carries the agent + telemetry through into the worker.completed event', () => {
  const event = fromCompletion({
    featureId: 'feat-map',
    kind: 'done',
    detail: 'DONE: shipped',
    headSha: 'abc',
    agent: 'rook',
    telemetry: telemetry('rook'),
  });
  assert.equal(event.type, 'worker.completed');
  assert.equal(event.payload.agent, 'rook');
  assert.ok(event.payload.telemetry, 'telemetry mapped through');
  assert.equal(event.payload.telemetry.tokens, 152000);
});

test('fromCompletion back-fills the agent onto telemetry that omitted it', () => {
  const event = fromCompletion({
    featureId: 'feat-bf',
    kind: 'done',
    detail: 'DONE',
    agent: 'codex',
    telemetry: { rubric: 'r', commands: [], durationMs: 1, tokens: 2 }, // no agent field
  });
  assert.equal(event.payload.telemetry.agent, 'codex');
});

// --- AUTO-COLLECTION (zero agent cooperation) -------------------------------
// Nothing in production writes record.telemetry, so the Ring-2 observer
// synthesizes the descriptive facts the spine already knows: the agent codename
// and durationMs = completion ts − the run's dispatch.linked ts.

test('autoTelemetryFor computes agent + durationMs from the dispatch link — no agent involvement', () => {
  const linkedTs = 1_000_000;
  const completionTs = 1_084_000;
  const runEvents = [
    { runId: 'run-a', type: 'run.created', ts: linkedTs - 500, payload: {} },
    { runId: 'run-a', type: 'worker.dispatched', ts: linkedTs - 100, payload: {} },
    { runId: 'run-a', type: 'worker.dispatch.linked', ts: linkedTs, payload: { taskId: 'tsk-a' } },
  ];
  const auto = autoTelemetryFor({ taskId: 'tsk-a', kind: 'done', agent: 'codex', timestamp: completionTs }, runEvents);
  assert.ok(auto, 'telemetry synthesized');
  assert.equal(auto.agent, 'codex');
  assert.equal(auto.durationMs, completionTs - linkedTs);
  assert.equal(auto.notes, 'auto-collected:spine');
});

test('autoTelemetryFor never overrides agent-written telemetry', () => {
  const auto = autoTelemetryFor(
    { taskId: 'tsk-a', agent: 'codex', timestamp: 5, telemetry: { tokens: 9 } },
    [{ runId: 'r', type: 'worker.dispatch.linked', ts: 1, payload: {} }],
  );
  assert.equal(auto, null, 'agent-written telemetry wins');
});

test('autoTelemetryFor without a linked ts still carries the agent (durationMs 0), and returns null when nothing is computable', () => {
  const agentOnly = autoTelemetryFor({ taskId: 'tsk-b', agent: 'claude', timestamp: 10 }, []);
  assert.ok(agentOnly);
  assert.equal(agentOnly.agent, 'claude');
  assert.equal(agentOnly.durationMs, 0);
  assert.equal(autoTelemetryFor({ taskId: 'tsk-c', timestamp: 10 }, []), null, 'no agent, no duration => nothing to synthesize');
});

test('synthesized telemetry folds through fromCompletion -> reconciler -> board card like any telemetry', () => {
  const log = createMemoryEventLog();
  log.append({ runId: 'run-auto', type: 'run.created', ts: 100, payload: { spec: { goal: 'auto-collect me' } } });
  log.append({ runId: 'run-auto', type: 'worker.dispatched', ts: 150, payload: {} });
  log.append({ runId: 'run-auto', type: 'worker.dispatch.linked', ts: 200, payload: { taskId: 'tsk-auto', streamId: 'str-auto' } });

  const record: any = { taskId: 'tsk-auto', kind: 'done', detail: 'DONE: shipped', agent: 'codex', timestamp: 90_200 };
  const auto = autoTelemetryFor(record, log.readRun('run-auto'));
  record.telemetry = auto;
  const evt = fromCompletion(record, 'run-auto');
  log.append({ ...evt, ts: 90_200 });

  const board = projectLeanBoard(log);
  const card = board.cards.find((c: any) => c.id === 'run-auto');
  assert.equal(card.telemetry.agent, 'codex');
  assert.equal(card.telemetry.durationMs, 90_000);
  assert.equal(card.agentId, 'codex', 'the card is keyed by the auto-collected agent');
});
