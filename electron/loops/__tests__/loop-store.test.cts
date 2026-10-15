// loop-store tests — single-file JSON catalog persistence with an in-memory
// fake fs (PRD §5/§8, OD3). node:test + node:assert/strict so it runs under
// BOTH vitest and node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let mod: any;
try {
  mod = require('../loop-store.cts');
} catch {
  mod = require('../loop-store.cjs');
}
const { createLoopStore } = mod;

// A complete, valid code-kind LoopSpec (post-lock shape — has a normalized id +
// meta.version). The store only ever holds runnable specs.
function validSpec(overrides: any = {}): any {
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
    meta: { version: 1 },
    ...overrides,
  };
}

// In-memory fake fs mirroring the LoopStoreFs seam: a Map<path, contents>.
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  let writes = 0;
  return {
    files,
    get writes() {
      return writes;
    },
    deps: {
      catalogPath: '/data/loops/catalog.json',
      readFile: (p: string) => (files.has(p) ? files.get(p)! : null),
      writeFile: (p: string, c: string) => {
        writes += 1;
        files.set(p, c);
      },
    },
  };
}

test('createLoopStore throws without injected readFile/writeFile', () => {
  assert.throws(() => createLoopStore({} as any), /readFile.*writeFile/);
  assert.throws(() => createLoopStore({ readFile: () => null } as any), /readFile.*writeFile/);
});

test('list() returns empty on an absent catalog file', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  assert.deepEqual(store.list(), []);
});

test('save() validates then persists; get() reads it back', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  const saved = store.save(validSpec());
  assert.equal(saved.id, 'ci-green-loop');
  assert.equal(fs.writes, 1);
  // persisted to the injected catalog path
  assert.ok(fs.files.has('/data/loops/catalog.json'));
  const got = store.get('ci-green-loop');
  assert.ok(got);
  assert.equal(got.name, 'CI Green Loop');
});

test('save() refuses an invalid spec (fail-closed) and does not write', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  const bad = validSpec();
  delete bad.goalTemplate;
  assert.throws(() => store.save(bad), /invalid LoopSpec/);
  assert.equal(fs.writes, 0);
  assert.deepEqual(store.list(), []);
});

test('save() upserts by id (overwrites the same id, no duplicate entry)', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec({ description: 'first' }));
  store.save(validSpec({ description: 'second' }));
  const all = store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].description, 'second');
});

test('list() returns multiple specs ordered by id', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec({ id: 'zeta-loop', name: 'Zeta' }));
  store.save(validSpec({ id: 'alpha-loop', name: 'Alpha' }));
  store.save(validSpec({ id: 'mid-loop', name: 'Mid' }));
  const ids = store.list().map((s: any) => s.id);
  assert.deepEqual(ids, ['alpha-loop', 'mid-loop', 'zeta-loop']);
});

test('get() returns null for an unknown or invalid id', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec());
  assert.equal(store.get('nope'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(undefined as any), null);
});

test('remove() deletes an entry and reports true; false when absent', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec());
  assert.equal(store.remove('ci-green-loop'), true);
  assert.equal(store.get('ci-green-loop'), null);
  assert.deepEqual(store.list(), []);
  // removing again (now absent) is a no-op false
  assert.equal(store.remove('ci-green-loop'), false);
});

test('remove() with an empty/invalid id is a no-op false', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  assert.equal(store.remove(''), false);
  assert.equal(store.remove(undefined as any), false);
});

test('read is fail-closed: a corrupt catalog file yields an empty list (never throws)', () => {
  const fs = fakeFs({ '/data/loops/catalog.json': '{ this is not json' });
  const store = createLoopStore(fs.deps);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('anything'), null);
});

test('read is fail-closed: an invalid spec entry is skipped, valid siblings survive', () => {
  // hand-craft a catalog with one good + one structurally-invalid entry
  const good = validSpec({ id: 'good-loop', name: 'Good' });
  const bad = validSpec({ id: 'bad-loop', name: 'Bad' });
  delete bad.contract.verify; // makes it invalid
  const catalog = JSON.stringify({ loops: { 'good-loop': good, 'bad-loop': bad } });
  const fs = fakeFs({ '/data/loops/catalog.json': catalog });
  const store = createLoopStore(fs.deps);
  const ids = store.list().map((s: any) => s.id);
  assert.deepEqual(ids, ['good-loop']);
  assert.ok(store.get('good-loop'));
  assert.equal(store.get('bad-loop'), null);
});

test('accepts a bare { [id]: spec } document shape (no loops wrapper)', () => {
  const good = validSpec({ id: 'bare-loop', name: 'Bare' });
  const catalog = JSON.stringify({ 'bare-loop': good });
  const fs = fakeFs({ '/data/loops/catalog.json': catalog });
  const store = createLoopStore(fs.deps);
  const got = store.get('bare-loop');
  assert.ok(got);
  assert.equal(got.name, 'Bare');
});

test('persists under the wrapped { loops: {...} } shape', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec());
  const written = fs.files.get('/data/loops/catalog.json')!;
  const doc = JSON.parse(written);
  assert.ok(doc.loops);
  assert.ok(doc.loops['ci-green-loop']);
});

test('defaults the catalog path when none is injected', () => {
  const files = new Map<string, string>();
  const store = createLoopStore({
    readFile: (p: string) => (files.has(p) ? files.get(p)! : null),
    writeFile: (p: string, c: string) => {
      files.set(p, c);
    },
  } as any);
  store.save(validSpec());
  assert.ok(files.has('loops/catalog.json'));
});

test('reads through fresh: an external catalog edit is reflected without a re-create', () => {
  const fs = fakeFs();
  const store = createLoopStore(fs.deps);
  store.save(validSpec({ id: 'a-loop', name: 'A' }));
  // simulate an external writer adding a second loop directly to the file
  const doc = JSON.parse(fs.files.get('/data/loops/catalog.json')!);
  doc.loops['b-loop'] = validSpec({ id: 'b-loop', name: 'B' });
  fs.files.set('/data/loops/catalog.json', JSON.stringify(doc));
  const ids = store.list().map((s: any) => s.id);
  assert.deepEqual(ids, ['a-loop', 'b-loop']);
});
