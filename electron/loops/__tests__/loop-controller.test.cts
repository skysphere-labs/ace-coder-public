// loop-controller tests — classifyLoopTerminal verdict precedence + no-progress.
// node:test + node:assert/strict so it runs under BOTH vitest and node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-controller.cts');
} catch {
  mod = require('../loop-controller.cjs');
}
const { classifyLoopTerminal, classifyLoopTerminalDetailed, hasNoProgress } = mod;

// A code-kind contract with NO ceilings set (the default per PRD §7).
function contractNoCeilings(overrides: any = {}): any {
  return {
    stop: { primary: 'converged' },
    ceilings: {},
    verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
    permissions: [],
    merge: { ownerGated: true },
    ...overrides,
  };
}

// A single iteration's folded terminal facts.
function iteration(overrides: any = {}): any {
  return {
    runId: 'run-1',
    verdict: 'request-changes',
    hasEvidence: true,
    evidenceKeys: ['ev-1'],
    nextGoalNoGoal: false,
    blocked: false,
    stopState: null,
    ...overrides,
  };
}

// ---------- converged ----------

test('converged: latest iteration is validator pass + evidence + next-goal {no_goal}', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', verdict: 'request-changes', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', verdict: 'pass', hasEvidence: true, evidenceKeys: ['ev-1', 'ev-2'], nextGoalNoGoal: true }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'converged');
  const detail = classifyLoopTerminalDetailed(lineage, contractNoCeilings());
  assert.equal(detail.verdict, 'converged');
  assert.ok(detail.reason.includes('no_goal'));
});

test('NOT converged when validator passed but next-goal still has a follow-up', () => {
  const lineage = {
    iterations: [iteration({ verdict: 'pass', hasEvidence: true, evidenceKeys: ['ev-1'], nextGoalNoGoal: false })],
  };
  // first iteration, made progress, not converged -> continue
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
});

test('NOT converged when next-goal {no_goal} but evidence is missing', () => {
  const lineage = {
    iterations: [iteration({ verdict: 'pass', hasEvidence: false, evidenceKeys: ['ev-1'], nextGoalNoGoal: true })],
  };
  assert.notEqual(classifyLoopTerminal(lineage, contractNoCeilings()), 'converged');
});

// ---------- no-progress ----------

test('no-progress: latest iteration appended ZERO new evidence vs the prior union', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', verdict: 'request-changes', evidenceKeys: ['ev-1', 'ev-2'] }),
      iteration({ runId: 'run-2', verdict: 'request-changes', evidenceKeys: ['ev-1'] }), // subset of prior -> no new
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'no-progress');
  assert.equal(hasNoProgress(lineage.iterations), true);
});

test('no-progress: latest iteration produced an empty evidence set', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', evidenceKeys: [] }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'no-progress');
});

test('progress (continue): latest iteration adds a brand-new evidence signature', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', evidenceKeys: ['ev-1', 'ev-2'] }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
  assert.equal(hasNoProgress(lineage.iterations), false);
});

test('a single iteration is never no-progress (the first always brings net-new evidence)', () => {
  const lineage = { iterations: [iteration({ evidenceKeys: ['ev-1'] })] };
  assert.equal(hasNoProgress(lineage.iterations), false);
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
});

// ---------- cap-hit (SET vs UNSET) ----------

test('cap-hit: maxIterations SET and reached', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', evidenceKeys: ['ev-1', 'ev-2'] }), // still progressing
    ],
  };
  const contract = contractNoCeilings({ ceilings: { maxIterations: 2 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
  const detail = classifyLoopTerminalDetailed(lineage, contract);
  assert.equal(detail.ceiling, 'maxIterations');
});

test('cap UNSET: a progressing loop with the SAME iterations continues (no mandatory cap)', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', evidenceKeys: ['ev-1', 'ev-2'] }),
    ],
  };
  // ceilings: {} -> nothing set -> never cap-hit
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
});

test('cap-hit: maxSpendUsd SET and exceeded', () => {
  const lineage = {
    iterations: [iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] })],
    spendUsd: 12.5,
  };
  const contract = contractNoCeilings({ ceilings: { maxSpendUsd: 10 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
  assert.equal(classifyLoopTerminalDetailed(lineage, contract).ceiling, 'maxSpendUsd');
});

test('maxSpendUsd SET but under budget -> not cap-hit', () => {
  const lineage = {
    iterations: [iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] })],
    spendUsd: 4,
  };
  const contract = contractNoCeilings({ ceilings: { maxSpendUsd: 10 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'continue');
});

test('cap-hit: maxRuntimeMs SET and exceeded', () => {
  const lineage = {
    iterations: [iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] })],
    elapsedMs: 60_000,
  };
  const contract = contractNoCeilings({ ceilings: { maxRuntimeMs: 30_000 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
});

test('cap-hit: expiryIso SET and now is past it', () => {
  const lineage = {
    iterations: [iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] })],
    nowIso: '2026-06-20T12:00:00.000Z',
  };
  const contract = contractNoCeilings({ ceilings: { expiryIso: '2026-06-20T11:00:00.000Z' } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
  assert.equal(classifyLoopTerminalDetailed(lineage, contract).ceiling, 'expiryIso');
});

test('expiryIso SET but still in the future -> not cap-hit', () => {
  const lineage = {
    iterations: [iteration({ runId: 'run-1', evidenceKeys: ['ev-1'] })],
    nowIso: '2026-06-20T10:00:00.000Z',
  };
  const contract = contractNoCeilings({ ceilings: { expiryIso: '2026-06-20T11:00:00.000Z' } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'continue');
});

// ---------- blocked ----------

test('blocked: latest iteration is flagged blocked', () => {
  const lineage = { iterations: [iteration({ blocked: true })] };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'blocked');
});

test('blocked: latest iteration validator verdict is block', () => {
  const lineage = { iterations: [iteration({ verdict: 'block' })] };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'blocked');
});

test('blocked: latest iteration landed on an unsafe/owner-decision stop state', () => {
  for (const stopState of ['UNSAFE_REQUIRES_APPROVAL', 'NEEDS_OWNER_DECISION', 'BLOCKED']) {
    const lineage = { iterations: [iteration({ stopState })] };
    assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'blocked', `stopState=${stopState}`);
  }
});

test('blocked: a lineage-level block flag trumps everything (even a converged latest)', () => {
  const lineage = {
    blocked: true,
    iterations: [iteration({ verdict: 'pass', hasEvidence: true, nextGoalNoGoal: true })],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'blocked');
});

test('request-changes is NOT a block (it is the normal fixback path) -> continue when progressing', () => {
  const lineage = {
    iterations: [
      iteration({ runId: 'run-1', verdict: 'request-changes', evidenceKeys: ['ev-1'] }),
      iteration({ runId: 'run-2', verdict: 'request-changes', evidenceKeys: ['ev-1', 'ev-2'] }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
});

// ---------- precedence ----------

test('precedence: blocked beats cap-hit', () => {
  const lineage = { iterations: [iteration({ blocked: true })], spendUsd: 1000 };
  const contract = contractNoCeilings({ ceilings: { maxSpendUsd: 1 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'blocked');
});

test('precedence: cap-hit beats converged', () => {
  const lineage = {
    iterations: [iteration({ verdict: 'pass', hasEvidence: true, nextGoalNoGoal: true })],
    spendUsd: 1000,
  };
  const contract = contractNoCeilings({ ceilings: { maxSpendUsd: 1 } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
});

// ---------- edge: empty lineage ----------

test('empty lineage with no ceilings -> continue (fire the first iteration)', () => {
  assert.equal(classifyLoopTerminal({ iterations: [] }, contractNoCeilings()), 'continue');
});

test('empty lineage but expiry already passed -> cap-hit', () => {
  const lineage = { iterations: [], nowIso: '2026-06-20T12:00:00.000Z' };
  const contract = contractNoCeilings({ ceilings: { expiryIso: '2026-06-20T11:00:00.000Z' } });
  assert.equal(classifyLoopTerminal(lineage, contract), 'cap-hit');
});

test('handles a malformed lineage / contract without throwing', () => {
  assert.equal(classifyLoopTerminal(null, null), 'continue');
  assert.equal(classifyLoopTerminal(undefined, undefined), 'continue');
  assert.equal(classifyLoopTerminal({}, {}), 'continue');
});

// ---------- agentic (evidence-only) convergence — Slice 2 ----------

// An agentic contract: no validator-pass gate (PRD §1/§9 — evidence is the ship).
function agenticContract(overrides: any = {}): any {
  return {
    stop: { primary: 'converged' },
    ceilings: {},
    verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
    permissions: [],
    merge: { ownerGated: true },
    ...overrides,
  };
}

test('agentic converges on a finished worker + evidence + {no_goal} WITHOUT a validator pass', () => {
  const lineage = {
    iterations: [
      iteration({ kind: 'agentic', workerDone: true, verdict: null, hasEvidence: true, nextGoalNoGoal: true, stopState: 'DONE' }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, agenticContract()), 'converged');
});

test('agentic does NOT converge while the worker is still in-flight (workerDone false)', () => {
  const lineage = {
    iterations: [
      iteration({ kind: 'agentic', workerDone: false, verdict: null, hasEvidence: true, nextGoalNoGoal: true }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, agenticContract()), 'continue');
});

test('agentic does NOT converge without evidence even when the worker finished', () => {
  const lineage = {
    iterations: [
      iteration({ kind: 'agentic', workerDone: true, verdict: null, hasEvidence: false, evidenceKeys: [], nextGoalNoGoal: true }),
    ],
  };
  // no evidence -> not converged; first iteration made "progress" by finishing -> continue
  assert.equal(classifyLoopTerminal(lineage, agenticContract()), 'continue');
});

test('a CODE loop with a finished worker but NO validator pass still does not converge (kind gates the ship)', () => {
  const lineage = {
    iterations: [
      iteration({ kind: 'code', workerDone: true, verdict: null, hasEvidence: true, nextGoalNoGoal: true }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, contractNoCeilings()), 'continue');
});

test('agentic blocked worker is still a hard block (not a convergence)', () => {
  const lineage = {
    iterations: [
      iteration({ kind: 'agentic', workerDone: true, verdict: null, hasEvidence: true, nextGoalNoGoal: true, blocked: true, stopState: 'BLOCKED' }),
    ],
  };
  assert.equal(classifyLoopTerminal(lineage, agenticContract()), 'blocked');
});
