// loop-signature — pure deciders for the autonomy OUTER loop (the new neuron
// layered on the run-ledger spine). Two responsibilities, both deterministic:
//
//   followupSignature(followups)  -> a stable, order-independent fingerprint of
//     the gaps a cycle surfaced, so the loop can detect "no progress" (the same
//     gaps twice in a row) and stop instead of thrashing.
//
//   classifyLoopTerminal(input)   -> given a SETTLED run's evidence + the loop
//     counters, decide whether the loop CONTINUES or TERMINATES (and why):
//     converged | cap-hit | no-progress | blocked | continue.
//
// Pure module: no I/O, no clocks, no Date.now()/Math.random(). Every output is a
// deterministic function of the inputs, so the whole loop policy is unit-testable
// without a spine or a worker.

// Build-agnostic sibling import (compiled .cjs is gitignored / absent in a fresh
// worktree, so fall back to the .cts that tsx resolves). NEXT_ACTIONS is a frozen
// constant map — importing it couples us only to the spine's decision vocabulary.
let orchestrationPolicy: any;
try {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cjs');
} catch {
  orchestrationPolicy = require('../../tools/ace/src/orchestration-policy.cts');
}
const { NEXT_ACTIONS } = orchestrationPolicy;

/**
 * @typedef {import('./completion-packet').EvidenceBundle} EvidenceBundle
 */

/**
 * @typedef {('converged'|'cap-hit'|'no-progress'|'blocked'|'continue')} LoopTerminal
 */

// Normalize one followup string so cosmetically-different restatements of the
// SAME gap collapse to one token: lowercase, drop volatile run/sha/cycle
// identifiers, strip a leading action verb ("fix/address/..."), strip remaining
// punctuation, collapse whitespace.
function normalizeFollowup(text: any) {
  return String(text == null ? '' : text)
    .toLowerCase()
    // volatile identifiers: run-7, task_12, pr #9, cycle-3, sha deadbeef...
    .replace(/\b(?:run|task|pr|cycle|iteration|sha|commit)[-_ #]*[0-9a-f]+\b/g, ' ')
    // bare hex shas (>=7 chars)
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    // a leading action verb adds no meaning to the gap identity
    .replace(/^[\s\-*•·]*(?:please\s+)?(?:fix|address|handle|resolve|implement|investigate|add)\b[:\s]*/i, '')
    // any remaining punctuation -> space
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// FNV-1a 32-bit, dependency-free + deterministic. Determinism > collision-
// resistance here: a hash collision only risks a spurious no-progress stop, which
// fails SAFE (it halts the loop rather than letting it run away).
function fnv1a(str: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Order-independent, normalized fingerprint of a cycle's merged followups.
 * Empty / whitespace-only sets yield '' (no signature) — an empty signature
 * never matches a prior empty signature in the no-progress guard (see classify).
 * @param {string[]} followups
 * @returns {string}
 */
function followupSignature(followups: any) {
  const list = Array.isArray(followups) ? followups : [];
  const normalized = list.map(normalizeFollowup).filter(Boolean);
  if (!normalized.length) return '';
  const unique = Array.from(new Set(normalized)).sort();
  return fnv1a(unique.join('\n'));
}

/**
 * Decide whether the outer loop continues or terminates at a settled run.
 *
 * Precedence (first match wins):
 *   1. converged   — validator PASS + REAL computer-use evidence + no next goal.
 *                    A PASS WITHOUT computerUseEvidence can NEVER converge.
 *   2. blocked     — the spine itself parked the run for the owner (BLOCKED).
 *   3. no-progress — a non-empty followup signature repeated the prior cycle's.
 *   4. cap-hit     — this cycle reached the iteration ceiling.
 *   5. continue    — new work within budget; dispatch the next cycle.
 *
 * @param {{
 *   bundle: EvidenceBundle,
 *   decision: { next?: string } | null,
 *   nextGoal: { no_goal?: string } | object,
 *   iteration: number,
 *   maxIterations: number,
 *   signature: string,
 *   lastSignature: string | null,
 * }} input
 * @returns {{ terminal: LoopTerminal, reason: string }}
 */
function classifyLoopTerminal(input: any = {}) {
  const bundle = input && input.bundle ? input.bundle : {};
  const decision = input && input.decision ? input.decision : null;
  const nextGoal = input && input.nextGoal ? input.nextGoal : {};
  const iteration = Number(input && input.iteration) || 0;
  const maxIterations = Number(input && input.maxIterations) || 0;
  const signature = input && input.signature ? String(input.signature) : '';
  const lastSignature = input && input.lastSignature ? String(input.lastSignature) : '';

  const passed = bundle.verdict === 'pass';
  const computerUse = bundle.computerUseEvidence === true;
  const noGoal = nextGoal && typeof nextGoal.no_goal === 'string';

  // 1. Converged — the ONLY clean terminal. Computer-use evidence is MANDATORY:
  //    a PASS asserted without a real behavioral test must not end the loop.
  if (passed && computerUse && noGoal) {
    return { terminal: 'converged', reason: String(nextGoal.no_goal) };
  }

  // 2. Blocked — the spine handed the run to the owner.
  if (decision && NEXT_ACTIONS && decision.next === NEXT_ACTIONS.BLOCKED) {
    return { terminal: 'blocked', reason: 'spine decision BLOCKED — owner action required' };
  }

  // 3. No-progress — same gaps as last cycle (empty signatures never match).
  if (signature && lastSignature && signature === lastSignature) {
    return { terminal: 'no-progress', reason: `followup signature unchanged (${signature}) — halting to avoid thrash` };
  }

  // 4. Cap — don't start a cycle past the ceiling.
  if (maxIterations > 0 && iteration >= maxIterations) {
    return { terminal: 'cap-hit', reason: `iteration ${iteration} reached max ${maxIterations}` };
  }

  // 5. Continue — new work within budget.
  return { terminal: 'continue', reason: 'new work surfaced within budget' };
}

/**
 * The durable id of an outer-loop lineage. A ROOT run (autoIterate, no
 * parentRunId) IS its own lineage, keyed by its runId; each child cycle carries
 * an explicit spec.loopLineageId (= the root runId). So the lineage id of ANY
 * run is its spec.loopLineageId when present, else its own runId. This needs no
 * post-submit mint: cycle 1 stores only {autoIterate, iteration:1, maxIterations}
 * and is identified by its own runId.
 * @param {string} runId
 * @param {{ loopLineageId?: string }} spec
 * @returns {string}
 */
function lineageIdOf(runId: any, spec: any) {
  const s = spec && typeof spec === 'object' ? spec : {};
  return s.loopLineageId ? String(s.loopLineageId) : String(runId == null ? '' : runId);
}

module.exports = {
  followupSignature,
  classifyLoopTerminal,
  lineageIdOf,
  // exported for unit tests / reuse:
  normalizeFollowup,
};
