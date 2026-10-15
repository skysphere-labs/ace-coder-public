// loop-templates tests — the built-in editable code-kind loop templates (WS-F).
// Every template must pass validateLoopSpec, be kind:'code' + editable (builtin
// false), request ZERO owner-approval permissions, and NEVER set ownerApproved.
// Also proves loops-service seeds them idempotently without clobbering an operator
// edit. node:test + node:assert/strict for the repo's .cts runner.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let templatesMod;
try {
  templatesMod = require('../loop-templates.cts');
} catch {
  templatesMod = require('../loop-templates.cjs');
}
const { CODE_LOOP_TEMPLATES, SHIP_LOOP_TEMPLATE, ALL_LOOP_TEMPLATES } = templatesMod;

let specMod;
try {
  specMod = require('../loop-spec.cts');
} catch {
  specMod = require('../loop-spec.cjs');
}
const { validateLoopSpec, OWNER_APPROVAL_PERMISSIONS } = specMod;

let svcMod;
try {
  svcMod = require('../loops-service.cts');
} catch {
  svcMod = require('../loops-service.cjs');
}
const { createLoopsService } = svcMod;

const EXPECTED_IDS = ['loop-validate-park', 'loop-ci-harden', 'loop-docs-sweep', 'loop-dep-triage'];

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => (files.has(p) ? (files.get(p)) : null),
    writeFile: (p, c) => {
      files.set(p, c);
    },
  };
}

// A minimal valid kind:'system' builtin — used only to TRIGGER the constructor's
// builtin-seeding gate (which then also seeds the code templates).
function oneSystemBuiltin() {
  return [
    {
      id: 'sys-probe',
      name: 'sys-probe',
      description: 'probe',
      useWhen: 'probe',
      kind: 'system',
      inputs: {},
      goalTemplate: 'probe',
      routing: { agent: 'auto', skills: [], workspace: 'loops', target: { allow: [] } },
      contract: {
        stop: { primary: 'converged' },
        ceilings: {},
        verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
        permissions: [],
        merge: { ownerGated: true },
      },
      evidence: {},
      builtin: true,
      systemRunRef: 'sys-probe',
      meta: { version: 1 },
    },
  ];
}

test('exactly the 4 expected code templates ship, all kind:code + editable', () => {
  assert.equal(CODE_LOOP_TEMPLATES.length, 4);
  assert.deepEqual(
    CODE_LOOP_TEMPLATES.map((t) => t.id).sort(),
    EXPECTED_IDS.slice().sort(),
  );
  for (const t of CODE_LOOP_TEMPLATES) {
    assert.equal(t.kind, 'code', `${t.id} must be kind:code`);
    assert.equal(t.builtin, false, `${t.id} must be editable (builtin:false)`);
  }
});

test('every template passes validateLoopSpec', () => {
  for (const t of CODE_LOOP_TEMPLATES) {
    const res = validateLoopSpec(t);
    assert.equal(res.ok, true, `${t.id} failed validation: ${(res.errors || []).join('; ')}`);
  }
});

test('no template requests an owner-approval permission, sets ownerApproved, or carries a merge token', () => {
  const json = JSON.stringify(CODE_LOOP_TEMPLATES);
  assert.equal(/"ownerApproved"/.test(json), false, 'no template may set ownerApproved');
  for (const t of CODE_LOOP_TEMPLATES) {
    const perms = (t.contract && t.contract.permissions) || [];
    for (const p of perms) {
      assert.equal(OWNER_APPROVAL_PERMISSIONS.has(p), false, `${t.id} requests owner-approval permission ${p}`);
    }
    assert.equal(t.contract.merge.ownerGated, true, `${t.id} merge must stay owner-gated`);
    assert.equal(t.contract.merge.tokenRef, undefined, `${t.id} must NOT carry an auto-merge token (it parks)`);
  }
});

test('each template carries an honest useWhen + a parameterizable goalTemplate', () => {
  for (const t of CODE_LOOP_TEMPLATES) {
    assert.ok(typeof t.useWhen === 'string' && t.useWhen.trim().length > 20, `${t.id} needs a real useWhen`);
    assert.match(t.goalTemplate, /\{\{iteration\}\}/, `${t.id} goalTemplate should reference {{iteration}}`);
  }
});

test('loops-service seeds the code templates AND loop-ship when system builtins are provided', () => {
  const fs = memFs();
  const svc = createLoopsService({
    harness: null,
    driveRun: () => {},
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    builtins: oneSystemBuiltin(),
  });
  const ids = svc.listLoops().map((s) => s.id);
  for (const id of EXPECTED_IDS) assert.ok(ids.includes(id), `expected template ${id} to be seeded`);
  assert.ok(ids.includes('loop-ship'), 'expected loop-ship to be seeded');
});

// ---------------------------------------------------------------------------
// loop-ship — the ONE owner-approved auto-merge ship loop (separate export so the
// four parking templates keep their zero-owner-approval / no-token invariants).
// ---------------------------------------------------------------------------

test('ALL_LOOP_TEMPLATES = the 4 parking starters + loop-ship', () => {
  assert.equal(ALL_LOOP_TEMPLATES.length, CODE_LOOP_TEMPLATES.length + 1);
  assert.equal(SHIP_LOOP_TEMPLATE.id, 'loop-ship');
  assert.ok(ALL_LOOP_TEMPLATES.some((t) => t.id === 'loop-ship'));
  // loop-ship is NOT one of the four parking starters.
  assert.equal(CODE_LOOP_TEMPLATES.some((t) => t.id === 'loop-ship'), false);
});

test('loop-ship passes validateLoopSpec WITH its owner ack (merge_to_main)', () => {
  const res = validateLoopSpec(SHIP_LOOP_TEMPLATE);
  assert.equal(res.ok, true, `loop-ship failed validation: ${(res.errors || []).join('; ')}`);
});

test('loop-ship without ownerApproved fails closed (UNSAFE_REQUIRES_APPROVAL)', () => {
  const withoutAck = { ...SHIP_LOOP_TEMPLATE, ownerApproved: false };
  const res = validateLoopSpec(withoutAck);
  assert.equal(res.ok, false);
  assert.ok(
    (res.errors || []).some((e) => /UNSAFE_REQUIRES_APPROVAL/.test(e)),
    `expected UNSAFE_REQUIRES_APPROVAL, got: ${(res.errors || []).join('; ')}`,
  );
});

test('loop-ship is a code loop that requests merge_to_main, carries a NAMED token ref, and requires computer-use', () => {
  assert.equal(SHIP_LOOP_TEMPLATE.kind, 'code');
  assert.equal(SHIP_LOOP_TEMPLATE.builtin, false);
  assert.equal(SHIP_LOOP_TEMPLATE.ownerApproved, true);
  assert.deepEqual(SHIP_LOOP_TEMPLATE.contract.permissions, ['merge_to_main']);
  assert.equal(SHIP_LOOP_TEMPLATE.contract.merge.ownerGated, true);
  // tokenRef is a NAME only — never the secret itself.
  assert.equal(SHIP_LOOP_TEMPLATE.contract.merge.tokenRef, 'autoship');
  assert.equal(SHIP_LOOP_TEMPLATE.contract.verify.requireValidatorPass, true);
  assert.equal(SHIP_LOOP_TEMPLATE.contract.verify.requireComputerUseEvidence, true);
  // Sane ceiling so an unshippable goal stops.
  assert.ok(Number(SHIP_LOOP_TEMPLATE.contract.ceilings.maxIterations) > 0);
  // The template ships only the token NAME (tokenRef); it must carry NO literal
  // token field on the merge contract or at the top level (the secret is resolved
  // at runtime, never persisted). Prose may still NAME the env var / config source.
  assert.equal((SHIP_LOOP_TEMPLATE.contract.merge as any).ownerAuthToken, undefined);
  assert.equal((SHIP_LOOP_TEMPLATE.contract.merge as any).token, undefined);
  assert.equal((SHIP_LOOP_TEMPLATE as any).ownerAuthToken, undefined);
});

test('a bare loops-service (no builtins) does NOT auto-seed templates', () => {
  const svc = createLoopsService({
    harness: null,
    driveRun: () => {},
    fs: memFs(),
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
  });
  assert.deepEqual(svc.listLoops(), []);
});

test('re-seeding is idempotent and never clobbers an operator edit', () => {
  const fs = memFs();
  const first = createLoopsService({
    harness: null,
    driveRun: () => {},
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    builtins: oneSystemBuiltin(),
  });
  // Operator edits a template's name.
  const edited = { ...first.getLoop('loop-docs-sweep'), name: 'My Custom Docs Sweep' };
  first.saveLoop(edited);

  // A fresh service over the SAME catalog re-runs seeding; the edit must survive.
  const second = createLoopsService({
    harness: null,
    driveRun: () => {},
    fs,
    catalogPath: '/userData/loops/catalog.json',
    now: () => 1000,
    builtins: oneSystemBuiltin(),
  });
  assert.equal(second.getLoop('loop-docs-sweep').name, 'My Custom Docs Sweep');
  // Still exactly one entry per template id (no duplicates from re-seeding).
  const docsSweeps = second.listLoops().filter((s) => s.id === 'loop-docs-sweep');
  assert.equal(docsSweeps.length, 1);
});
