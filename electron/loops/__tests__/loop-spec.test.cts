// loop-spec tests — fail-closed validation + deterministic lock-on.
// node:test + node:assert/strict so it runs under BOTH vitest and node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-spec.cts');
} catch {
  mod = require('../loop-spec.cjs');
}
const { validateLoopSpec, lockOnLoopSpec, OWNER_APPROVAL_PERMISSIONS } = mod;

// A complete, valid code-kind draft. Helper so each test tweaks one thing.
function validCodeDraft(overrides: any = {}): any {
  return {
    id: 'ci-green-loop',
    name: 'CI Green Loop',
    description: 'Harden CI until Spine Guard is green 3x straight.',
    useWhen: 'CI is flaky and needs to be hardened to repeated green.',
    kind: 'code',
    inputs: { type: 'object', properties: {} },
    goalTemplate: 'Make Spine Guard green; prior evidence: {{evidence}}',
    routing: {
      agent: 'auto',
      skills: ['ace-task-worker'],
      workspace: 'loops',
      target: { repo: '/repo/path', allow: ['electron/**'] },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: { type: 'object', properties: {} },
    meta: { version: 0 },
    ...overrides,
  };
}

test('OWNER_APPROVAL_PERMISSIONS contains the PRD §7 set and is frozen', () => {
  for (const p of [
    'merge_to_main',
    'deploy_prod',
    'spend_money',
    'send_external_message',
    'delete_or_archive_data',
  ]) {
    assert.ok(OWNER_APPROVAL_PERMISSIONS.has(p), `expected ${p} in OWNER_APPROVAL_PERMISSIONS`);
  }
  assert.equal(OWNER_APPROVAL_PERMISSIONS.size, 5);
  assert.ok(Object.isFrozen(OWNER_APPROVAL_PERMISSIONS));
});

test('validateLoopSpec accepts a complete valid code draft', () => {
  const res = validateLoopSpec(validCodeDraft());
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.ok(res.spec);
  assert.equal(res.spec.id, 'ci-green-loop');
});

test('validateLoopSpec accepts a valid agentic draft without repo/allow requirement', () => {
  const draft = validCodeDraft({
    kind: 'agentic',
    routing: {
      agent: 'claude',
      skills: [],
      workspace: 'loops',
      target: { allow: [] }, // agentic: no repo, empty allow is fine
    },
  });
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

// Each required scalar field, individually missing, must reject.
for (const field of ['id', 'name', 'description', 'useWhen', 'kind', 'goalTemplate']) {
  test(`validateLoopSpec rejects missing required field: ${field}`, () => {
    const draft = validCodeDraft();
    delete draft[field];
    const res = validateLoopSpec(draft);
    assert.equal(res.ok, false);
    assert.equal(res.spec, undefined);
    assert.ok(
      res.errors.some((e: string) => e.includes(field)),
      `expected an error mentioning ${field}, got ${JSON.stringify(res.errors)}`,
    );
  });
}

test('validateLoopSpec rejects an invalid kind', () => {
  const res = validateLoopSpec(validCodeDraft({ kind: 'workflow' }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('invalid kind')));
});

test('validateLoopSpec rejects an invalid routing.agent', () => {
  const draft = validCodeDraft();
  draft.routing.agent = 'gemini';
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('routing.agent')));
});

test('validateLoopSpec rejects non-loops workspace', () => {
  const draft = validCodeDraft();
  draft.routing.workspace = 'project-x';
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('workspace')));
});

test('validateLoopSpec rejects code-kind without routing.target.repo', () => {
  const draft = validCodeDraft();
  delete draft.routing.target.repo;
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('routing.target.repo')));
});

test('validateLoopSpec rejects code-kind with empty routing.target.allow', () => {
  const draft = validCodeDraft();
  draft.routing.target.allow = [];
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('allow')));
});

test('validateLoopSpec rejects missing contract.verify', () => {
  const draft = validCodeDraft();
  delete draft.contract.verify;
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => e.includes('contract.verify')));
});

test('validateLoopSpec rejects an owner-approval permission without ack (UNSAFE_REQUIRES_APPROVAL)', () => {
  const draft = validCodeDraft();
  draft.contract.permissions = ['merge_to_main'];
  // no ownerApproved
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e: string) => e.includes('UNSAFE_REQUIRES_APPROVAL') && e.includes('merge_to_main')),
    JSON.stringify(res.errors),
  );
});

test('validateLoopSpec accepts an owner-approval permission WITH explicit owner ack', () => {
  const draft = validCodeDraft();
  draft.contract.permissions = ['merge_to_main', 'spend_money'];
  draft.ownerApproved = true;
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('validateLoopSpec allows a non-owner-approval permission without ack', () => {
  const draft = validCodeDraft();
  // an arbitrary autonomous capability not in the owner-approval set
  draft.contract.permissions = ['read_repo'];
  const res = validateLoopSpec(draft);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('lockOnLoopSpec locks a valid draft, normalizes id, stamps version=1 + createdAtRef via injected now', () => {
  const draft = validCodeDraft({ id: undefined, name: 'My Cool Loop!!' });
  const res = lockOnLoopSpec(draft, { now: () => 'TS-FIXED' });
  assert.equal(res.locked, true, res.reason);
  assert.ok(res.spec);
  assert.equal(res.spec.id, 'my-cool-loop'); // normalized kebab from name
  assert.equal(res.spec.meta.version, 1);
  assert.equal(res.spec.meta.createdAtRef, 'TS-FIXED');
});

test('lockOnLoopSpec increments meta.version on re-lock', () => {
  const draft = validCodeDraft({ meta: { version: 3, createdAtRef: 'orig' } });
  const res = lockOnLoopSpec(draft, { now: () => 'NEW' });
  assert.equal(res.locked, true, res.reason);
  assert.equal(res.spec.meta.version, 4);
  // existing createdAtRef preserved (not overwritten by now)
  assert.equal(res.spec.meta.createdAtRef, 'orig');
});

test('lockOnLoopSpec is deterministic (no top-level clock) — omitting now leaves createdAtRef unset', () => {
  const draft = validCodeDraft({ meta: { version: 0 } });
  const res = lockOnLoopSpec(draft);
  assert.equal(res.locked, true, res.reason);
  assert.equal(res.spec.meta.version, 1);
  assert.equal(res.spec.meta.createdAtRef, undefined);
});

test('lockOnLoopSpec fails closed on an incomplete draft and reports the reason', () => {
  const draft = validCodeDraft();
  delete draft.goalTemplate;
  const res = lockOnLoopSpec(draft);
  assert.equal(res.locked, false);
  assert.equal(res.spec, undefined);
  assert.ok(typeof res.reason === 'string' && res.reason.includes('goalTemplate'));
});

test('lockOnLoopSpec fails closed on an unsafe (owner-approval, no ack) draft', () => {
  const draft = validCodeDraft();
  draft.contract.permissions = ['deploy_prod'];
  const res = lockOnLoopSpec(draft, { now: () => 't' });
  assert.equal(res.locked, false);
  assert.ok(res.reason.includes('UNSAFE_REQUIRES_APPROVAL'));
});

test('lockOnLoopSpec honors an injected idFromName normalizer', () => {
  const draft = validCodeDraft({ id: undefined, name: 'Whatever' });
  const res = lockOnLoopSpec(draft, { idFromName: () => 'fixed-id' });
  assert.equal(res.locked, true, res.reason);
  assert.equal(res.spec.id, 'fixed-id');
});

// ── triggers validation (PRD §9 Slice 3) ──────────────────────────────────────

test('a valid interval trigger passes; absent triggers is fine', () => {
  assert.equal(validateLoopSpec(validCodeDraft()).ok, true); // no triggers
  const ok = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'schedule', enabled: true, everyMs: 3_600_000 }] }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('a valid daily + a valid event trigger pass', () => {
  const ok = validateLoopSpec(
    validCodeDraft({
      triggers: [
        { kind: 'schedule', enabled: true, dailyAt: '07:00' },
        { kind: 'event', enabled: false, event: 'intel.refresh' },
      ],
    }),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('a schedule trigger below the everyMs floor fails closed', () => {
  const bad = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'schedule', enabled: true, everyMs: 1000 }] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e: string) => /everyMs must be >=/.test(e)));
});

test('a schedule trigger with neither everyMs nor dailyAt fails closed', () => {
  const bad = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'schedule', enabled: true }] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e: string) => /requires everyMs/.test(e)));
});

test('a malformed dailyAt and an empty event name fail closed', () => {
  const badDaily = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'schedule', enabled: true, dailyAt: '25:99' }] }));
  assert.equal(badDaily.ok, false);
  const badEvent = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'event', enabled: true, event: '' }] }));
  assert.equal(badEvent.ok, false);
  assert.ok(badEvent.errors.some((e: string) => /event requires a non-empty/.test(e)));
});

test('an invalid trigger kind fails closed', () => {
  const bad = validateLoopSpec(validCodeDraft({ triggers: [{ kind: 'webhook', enabled: true }] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e: string) => /kind must be/.test(e)));
});

test('a compiled-then-locked spec keeps its triggers through bind', () => {
  const locked = lockOnLoopSpec(
    validCodeDraft({ id: undefined, meta: undefined, triggers: [{ kind: 'schedule', enabled: true, everyMs: 3_600_000 }] }),
    { now: () => 1000 },
  );
  assert.equal(locked.locked, true, locked.reason);
  assert.equal(locked.spec.triggers.length, 1);
  assert.equal(locked.spec.triggers[0].everyMs, 3_600_000);
});

// ── cross-workspace target (PRD §9 Slice 4) ───────────────────────────────────

test('a code loop with an explicit target.workspace validates', () => {
  const ok = validateLoopSpec(
    validCodeDraft({ routing: { agent: 'codex', skills: [], workspace: 'loops', target: { repo: '/x', allow: ['**'], workspace: 'project-x' } } }),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('an agentic loop may target another workspace (no repo required)', () => {
  const ok = validateLoopSpec(
    validCodeDraft({
      kind: 'agentic',
      routing: { agent: 'claude', skills: [], workspace: 'loops', target: { allow: [], workspace: 'project-y' } },
      contract: { stop: { primary: 'converged' }, ceilings: {}, verify: { requireValidatorPass: false, requireComputerUseEvidence: false }, permissions: [], merge: { ownerGated: true } },
    }),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('a non-string target.workspace fails closed', () => {
  const bad = validateLoopSpec(
    validCodeDraft({ routing: { agent: 'codex', skills: [], workspace: 'loops', target: { repo: '/x', allow: ['**'], workspace: 123 } } }),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e: string) => /target\.workspace must be a non-empty string/.test(e)));
});

test('absent target.workspace is fine (defaults to loops at runtime)', () => {
  assert.equal(validateLoopSpec(validCodeDraft()).ok, true);
});
