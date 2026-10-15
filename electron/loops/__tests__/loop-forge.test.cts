// loop-forge tests — deterministic NL → LoopSpec draft compilation (PRD §5/§9).
// node:test + node:assert/strict so it runs under the repo's .cts runner.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-forge.cts');
} catch {
  mod = require('../loop-forge.cjs');
}
const { compileFromNL } = mod;

let specMod: any;
try {
  specMod = require('../loop-spec.cts');
} catch {
  specMod = require('../loop-spec.cjs');
}
const { lockOnLoopSpec } = specMod;

// ── kind inference ────────────────────────────────────────────────────────────

test('a CI/fix intent with a repo path compiles to a CODE loop with the repo extracted', () => {
  const { draft, notes } = compileFromNL(
    'Harden CI until Spine Guard is green. Fix the workflows in /Users/me/Projects/app, allow .github/**',
  );
  assert.equal(draft.kind, 'code');
  assert.equal(draft.routing.target.repo, '/Users/me/Projects/app');
  assert.ok(draft.routing.target.allow.includes('.github/**'));
  assert.equal(draft.contract.verify.requireValidatorPass, true);
  assert.ok(notes.some((n: string) => /kind → code/.test(n)));
});

test('a report/digest intent with no repo compiles to an AGENTIC loop with an evidence criterion', () => {
  const { draft } = compileFromNL('Produce a daily intel digest with at least 3 sourced findings');
  assert.equal(draft.kind, 'agentic');
  assert.equal(draft.routing.target.repo, undefined);
  assert.equal(draft.contract.verify.requireValidatorPass, false);
  assert.ok(typeof draft.evidence.criteria === 'string' && draft.evidence.criteria.length > 0);
});

test('ambiguous intent with neither code nor agentic cues defaults to the safe agentic kind', () => {
  const { draft } = compileFromNL('Keep an eye on the thing every so often');
  assert.equal(draft.kind, 'agentic');
});

// ── agent (router) inference ──────────────────────────────────────────────────

test('a refactor/migrate intent routes to codex; a design/review intent routes to claude', () => {
  assert.equal(compileFromNL('refactor the backend api and migrate the pipeline').draft.routing.agent, 'codex');
  assert.equal(compileFromNL('review and investigate the architecture design').draft.routing.agent, 'claude');
});

test('an injected pickAgent override wins over the default router', () => {
  const { draft } = compileFromNL('refactor the backend', { pickAgent: () => 'claude' });
  assert.equal(draft.routing.agent, 'claude');
});

// ── name / repo / allow extraction ────────────────────────────────────────────

test('derives a Title-Case name from the first line', () => {
  const { draft } = compileFromNL('keep the docs site fresh\nmore detail here');
  assert.equal(draft.name, 'Keep The Docs Site Fresh');
});

test('extracts multiple allow globs and the first absolute repo path', () => {
  const { draft } = compileFromNL('implement changes in /srv/repo touching src/** and lib/** only');
  assert.equal(draft.kind, 'code');
  assert.equal(draft.routing.target.repo, '/srv/repo');
  assert.deepEqual(draft.routing.target.allow, ['src/**', 'lib/**']);
});

// ── robustness ────────────────────────────────────────────────────────────────

test('empty / nullish input yields a safe, non-throwing draft', () => {
  for (const v of ['', '   ', null, undefined]) {
    const { draft } = compileFromNL(v as any);
    assert.ok(draft && typeof draft === 'object');
    assert.ok(draft.routing && draft.contract);
    assert.equal(draft.routing.workspace, 'loops');
  }
});

// ── round-trip: a compiled draft locks on ─────────────────────────────────────

test('a compiled AGENTIC draft locks on (compile → validate + bind round-trip)', () => {
  const { draft } = compileFromNL('Produce a weekly research brief summarizing key findings');
  const locked = lockOnLoopSpec(draft, { now: () => 1000 });
  assert.equal(locked.locked, true, locked.reason);
  assert.equal(locked.spec.kind, 'agentic');
  assert.ok(locked.spec.id);
});

test('a compiled CODE draft with a repo + allow locks on', () => {
  const { draft } = compileFromNL('Fix flaky tests in /Users/me/Projects/app, allow tests/**');
  const locked = lockOnLoopSpec(draft, { now: () => 1000 });
  assert.equal(locked.locked, true, locked.reason);
  assert.equal(locked.spec.kind, 'code');
  assert.equal(locked.spec.routing.target.repo, '/Users/me/Projects/app');
});

// ── selectLoopForIntent (manager seam, PRD §9 Slice 3) ────────────────────────

const { selectLoopForIntent } = mod;

function savedLoop(id: string, useWhen: string, name = id, description = ''): any {
  return { id, name, useWhen, description };
}

test('selectLoopForIntent picks the loop whose useWhen best overlaps the intent', () => {
  const loops = [
    savedLoop('ci-green', 'CI is flaky and the spine guard keeps failing'),
    savedLoop('intel-digest', 'produce a daily intel digest of findings'),
    savedLoop('docs-fresh', 'keep the documentation site fresh'),
  ];
  const res = selectLoopForIntent('the intel digest of findings is stale, produce a fresh one', loops);
  assert.ok(res.match);
  assert.equal(res.match.loopId, 'intel-digest');
  // ranked is sorted high → low
  assert.equal(res.ranked[0].loopId, 'intel-digest');
  assert.ok(res.ranked[0].score >= res.ranked[1].score);
});

test('selectLoopForIntent returns null match when nothing clears the threshold', () => {
  const loops = [savedLoop('ci-green', 'harden CI until spine guard green')];
  const res = selectLoopForIntent('completely unrelated kitchen recipe banana', loops);
  assert.equal(res.match, null);
  assert.ok(Array.isArray(res.ranked));
});

test('selectLoopForIntent is deterministic + safe on empty inputs', () => {
  assert.deepEqual(selectLoopForIntent('', []).match, null);
  assert.deepEqual(selectLoopForIntent('anything', null).ranked, []);
});
