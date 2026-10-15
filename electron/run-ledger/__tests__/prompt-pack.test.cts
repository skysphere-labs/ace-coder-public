// prompt-pack.test — the LEAN prompt assembler stays lean. Asserts: ordered
// sections present, skillIds echoed as `skill:` POINTERS not pasted bodies, the
// driver keyword pack differs claude vs codex, a normal runspec stays compact
// (< ~4000 chars), and the DONE/BLOCKED contract line is present.
//
// Pure module; no mocks. Run with:
//   node --test --require tsx/cjs electron/run-ledger/__tests__/prompt-pack.test.cts

const test = require('node:test');
const assert = require('node:assert/strict');

// Build-agnostic sibling import: compiled .cjs is gitignored and may be absent
// in a fresh worktree, so fall back to the .cts that tsx resolves.
let promptPack: any;
try {
  promptPack = require('../prompt-pack.cjs');
} catch {
  promptPack = require('../prompt-pack.cts');
}
const {
  PROMPT_PACK_SECTIONS,
  DONE_BLOCKED_CONTRACT,
  buildWorkerPrompt,
  estimatePromptChars,
  pickDriver,
} = promptPack;

const NORMAL_RUNSPEC = {
  goal: 'Wrap getMissionBoard archive UPDATE in a try/catch so reads survive the operator archive-disable toggle',
  mode: 'build',
  acceptance: [
    { id: 'A1', text: 'mission board read returns rows when the archive guard trigger is tripped' },
    { id: 'A2', text: 'ready/next reads no longer surface "archive disabled by operator toggle"' },
  ],
  boundaries: {
    allowedPaths: ['electron/pty-host.cts', 'electron/__tests__/pty-host.test.cts'],
    neverTouch: ['src/components/operations/**'],
  },
  halt: { maxIterations: 6, tokenCap: 120000 },
  skillIds: ['ace-task-worker', 'ace-prompt-enhancer'],
};

test('PROMPT_PACK_SECTIONS is the frozen ordered spine', () => {
  assert.deepEqual(PROMPT_PACK_SECTIONS, [
    'objective', 'context', 'outputContract', 'boundaries', 'acceptance', 'halt', 'skills', 'driverPack',
  ]);
  assert.ok(Object.isFrozen(PROMPT_PACK_SECTIONS));
});

test('all sections render in order for a runspec that carries context', () => {
  // context renders only when a richer brain supplies it (goal launch); include
  // it here so every section is exercised in order.
  const { prompt } = buildWorkerPrompt({ ...NORMAL_RUNSPEC, context: 'Hermes intake brief', constraints: ['stay surgical'] });
  const headings = {
    objective: '# Objective',
    context: '# Context',
    outputContract: '# Output contract',
    boundaries: '# Boundaries',
    acceptance: '# Acceptance',
    halt: '# Halt',
    skills: '# Skills',
    driverPack: '# Driver pack',
  };
  let prev = -1;
  for (const key of PROMPT_PACK_SECTIONS) {
    const idx = prompt.indexOf(headings[key as keyof typeof headings]);
    assert.ok(idx >= 0, `section ${key} present`);
    assert.ok(idx > prev, `section ${key} appears after the previous section`);
    prev = idx;
  }
});

test('context is OMITTED by default (a lean run submit stays minimal)', () => {
  const { prompt } = buildWorkerPrompt(NORMAL_RUNSPEC); // no context field
  assert.ok(!prompt.includes('# Context'), 'no context section when none supplied');
});

test('context + constraints render losslessly when a richer brain supplies them', () => {
  const { prompt } = buildWorkerPrompt({
    ...NORMAL_RUNSPEC,
    context: 'Research, grill the owner, write a PRD, then implement.',
    constraints: ['internal sub-agents only', 'cap fan-out at 3-5'],
  });
  assert.ok(prompt.includes('# Context'), 'context section present');
  assert.ok(prompt.includes('Research, grill the owner'), 'brief carried verbatim');
  assert.ok(prompt.includes('- internal sub-agents only'), 'constraints carried as bullets');
});

test('DONE/BLOCKED contract line is present', () => {
  const { prompt } = buildWorkerPrompt(NORMAL_RUNSPEC);
  assert.ok(prompt.includes('DONE:'), 'DONE: present');
  assert.ok(prompt.includes('BLOCKED:'), 'BLOCKED: present');
  assert.ok(prompt.includes(DONE_BLOCKED_CONTRACT), 'full contract line embedded verbatim');
});

test('skillIds are echoed as skill: POINTERS, never bodies', () => {
  const { prompt, skillIds } = buildWorkerPrompt(NORMAL_RUNSPEC);
  assert.deepEqual(skillIds, ['ace-task-worker', 'ace-prompt-enhancer']);
  assert.ok(prompt.includes('skill:ace-task-worker'), 'pointer rendered');
  assert.ok(prompt.includes('skill:ace-prompt-enhancer'), 'pointer rendered');
  // POINTER not BODY: no SKILL.md frontmatter / doctrine prose leaks in.
  assert.ok(!/^---\s*$/m.test(prompt), 'no skill frontmatter pasted');
  assert.ok(!/description:/i.test(prompt), 'no skill body fields pasted');
});

test('an already-prefixed skill id is not double-prefixed', () => {
  const { prompt, skillIds } = buildWorkerPrompt({ ...NORMAL_RUNSPEC, skillIds: ['skill:ace-task-worker'] });
  assert.deepEqual(skillIds, ['ace-task-worker']);
  assert.ok(prompt.includes('skill:ace-task-worker'));
  assert.ok(!prompt.includes('skill:skill:'), 'no skill:skill: double prefix');
});

test('driver pack differs claude vs codex', () => {
  const claude = buildWorkerPrompt({ ...NORMAL_RUNSPEC, driver: 'claude' });
  const codex = buildWorkerPrompt({ ...NORMAL_RUNSPEC, driver: 'codex' });
  assert.equal(claude.driver, 'claude');
  assert.equal(codex.driver, 'codex');
  assert.ok(claude.prompt.includes('# Driver pack (claude)'));
  assert.ok(codex.prompt.includes('# Driver pack (codex)'));
  // The packs are genuinely different content.
  const claudePack = claude.prompt.split('# Driver pack')[1];
  const codexPack = codex.prompt.split('# Driver pack')[1];
  assert.notEqual(claudePack, codexPack);
  assert.ok(codexPack.includes('/goal'), 'codex pack nudges /goal');
  assert.ok(claudePack.includes('/effort'), 'claude pack nudges /effort');
});

test('driver heuristic: review/ambiguity -> claude, deterministic -> codex, default claude', () => {
  assert.equal(pickDriver({ goal: 'review the PR diff against acceptance', mode: 'validation' }), 'claude');
  assert.equal(pickDriver({ goal: 'plan the architecture for the new ledger' }), 'claude');
  assert.equal(pickDriver({ goal: 'mechanical rename of the legacy api across the backend' }), 'codex');
  assert.equal(pickDriver({ goal: 'do the thing' }), 'claude');
  // explicit driver wins over the heuristic.
  assert.equal(pickDriver({ goal: 'mechanical refactor', driver: 'claude' }), 'claude');
});

test('a normal runspec stays compact (< ~4000 chars)', () => {
  const { chars } = buildWorkerPrompt(NORMAL_RUNSPEC);
  assert.ok(chars > 0);
  assert.ok(chars < 4000, `expected compact prompt, got ${chars} chars`);
  assert.equal(estimatePromptChars(NORMAL_RUNSPEC), chars, 'estimate matches built length');
});

test('acceptance renders A0 in-scope guard plus each A-ID as a checklist', () => {
  const { prompt } = buildWorkerPrompt(NORMAL_RUNSPEC);
  assert.ok(prompt.includes('- [ ] A0:'), 'A0 in-scope guarantee present');
  assert.ok(prompt.includes('- [ ] A1:'));
  assert.ok(prompt.includes('- [ ] A2:'));
});

test('degenerate runspec still produces a valid trailer-bearing prompt', () => {
  const { prompt, skillIds, driver, chars } = buildWorkerPrompt({});
  assert.equal(driver, 'claude');
  assert.deepEqual(skillIds, []);
  assert.ok(chars > 0);
  assert.ok(prompt.includes('DONE:') && prompt.includes('BLOCKED:'));
  // No Skills section when there are no skill pointers.
  assert.ok(!prompt.includes('# Skills'), 'skills section omitted when empty');
});
