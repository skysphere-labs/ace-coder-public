import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// NOTE: never import better-sqlite3 (native module, not built in CI worktrees).
// All db access goes through an injected fake dbOpener.
const operators = require('../operators.cts');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-operators-'));
}

function fakeDbOpener(rows = ownerRows(), calls = { opened: 0, closed: 0 }) {
  return () => {
    calls.opened += 1;
    return {
      prepare: () => ({ all: () => rows }),
      close: () => {
        calls.closed += 1;
      },
    };
  };
}

function touch(filePath = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fixture');
}

// Inferred-type helper: keeps test callbacks type-clean without TS syntax
// (vitest parses entry .cts test files as plain JS).
function idsOf(ops = [{ id: '' }]) {
  return ops.map((op) => op.id);
}

const ROOK_PROJECT_ID = 'prj-c9804012';
const KING_PROJECT_ID = 'prj-2b81ec58';

function ownerRows() {
  return [
    { id: ROOK_PROJECT_ID, personal_identity: 'rook' },
    { id: KING_PROJECT_ID, personal_identity: 'king' },
    // The real SQL filter excludes lane rows; the builder must also exclude
    // them defensively when a fake/changed opener leaks one through.
    { id: 'prj-lane', personal_identity: 'lane:lane-abc' },
  ];
}

test('golden migration: rook/king persist exactly, lane rows excluded, rerun is a byte-identical no-op', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));

  // Rook's live effective memory db: config.yaml in the identity project home
  // pointing at a file that exists.
  const memDb = path.join(userData, 'rook-memory_store.db');
  fs.writeFileSync(memDb, 'mem fixture');
  const rookHome = path.join(userData, `hermes-home-${ROOK_PROJECT_ID}`);
  fs.mkdirSync(rookHome, { recursive: true });
  fs.writeFileSync(
    path.join(rookHome, 'config.yaml'),
    ['plugins:', '  hermes-memory-store:', `    db_path: ${memDb}`, '    auto_extract: true', ''].join('\n')
  );

  const calls = { opened: 0, closed: 0 };
  const result = operators.migrateOperatorsConfig(userData, { dbOpener: fakeDbOpener(ownerRows(), calls) });
  expect(result.source).toBe('rook-king-v1');
  expect(result.wrote).toBe(true);
  expect(calls.opened).toBe(1);
  expect(calls.closed).toBe(1);

  const filePath = path.join(userData, 'operators.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(parsed.schema).toBe('ace.operators.v1');
  expect(parsed.defaultOperatorId).toBe('rook');
  expect(parsed.migratedFrom).toBe('rook-king-v1');
  expect(idsOf(parsed.operators)).toEqual(['rook', 'king']);

  const rook = parsed.operators[0];
  expect(rook.label).toBe('Rook');
  expect(rook.emoji).toBe('♜');
  expect(rook.agent).toBe('hermes');
  expect(rook.providerKind).toBe('builtin-personal');
  expect(rook.isControlPlane).toBe(true);
  expect(rook.autoStart).toBe(true);
  expect(rook.sortOrder).toBe(0);
  expect(rook.workspaceDirName).toBe('personal-workspace');
  expect(rook.terminalDirName).toBe('personal-hermes');
  expect(rook.legacyAuthDirs).toEqual(['hermes-home-personal-hermes']);
  expect(rook.hermesHome).toBe(null);
  expect(rook.memoryDbPath).toBe(memDb);
  // Rook has NO Ace-written soul today; downstream code must never
  // write a SOUL.md for it.
  expect(rook.persona).toBe(null);
  expect(rook.personaPath).toBe(null);
  expect(rook.ownerTitle).toBe('Chief');
  expect(rook.chat.placeholder).toBe('Message Rook');
  expect(rook.chat.busyRow).toBe('♜ Rook is fortifying the lines…');
  expect(rook.chat.busyPlaceholder).toBe('♜ Rook is combating threats from the fortress… Esc interrupts');
  expect(rook.chat.gerunds).toEqual({
    default: '♜',
    pairs: [
      { emoji: '🏰', verb: 'Fortifying' },
      { emoji: '🔭', verb: 'Surveying' },
      { emoji: '📐', verb: 'Drafting' },
      { emoji: '🛡️', verb: 'Defending' },
      { emoji: '🔍', verb: 'Tracing' },
      { emoji: '🗺️', verb: 'Sketching' },
      { emoji: '🧱', verb: 'Building' },
      { emoji: '🌀', verb: 'Reasoning' },
    ],
  });

  const king = parsed.operators[1];
  expect(king.label).toBe('King');
  expect(king.emoji).toBe('♔');
  expect(king.agent).toBe('hermes');
  expect(king.providerKind).toBe('builtin-personal');
  expect(king.sortOrder).toBe(1);
  expect(king.workspaceDirName).toBe('king-workspace');
  expect(king.terminalDirName).toBe('king-hermes');
  expect(king.legacyAuthDirs).toEqual(['hermes-home-king-hermes']);
  expect(king.memoryDbPath).toBe(null); // no king config.yaml fixture
  expect(king.persona).toBe(null);
  expect(king.ownerTitle).toBe('Chief');
  expect(king.chat.placeholder).toBe('Message King');
  expect(king.chat.busyRow).toBe('♔ King is calculating the position…');
  expect(king.chat.busyPlaceholder).toBe('♔ King is strategizing the next move… Esc interrupts');
  expect(king.chat.gerunds).toEqual({
    default: '♔',
    pairs: [
      { emoji: '👑', verb: 'Calculating' },
      { emoji: '⚖️', verb: 'Weighing' },
      { emoji: '🧭', verb: 'Foreseeing' },
      { emoji: '🎯', verb: 'Targeting' },
      { emoji: '🎼', verb: 'Composing' },
      { emoji: '♟️', verb: 'Maneuvering' },
      { emoji: '📜', verb: 'Reconciling' },
      { emoji: '⚜️', verb: 'Strategizing' },
    ],
  });

  // King's legacy persona is materialized exactly once at personaPath.
  expect(king.personaPath).toBe(path.join(userData, 'operators', 'king', 'SOUL.md'));
  expect(fs.readFileSync(king.personaPath, 'utf8')).toBe(operators.LEGACY_KING_PERSONA);
  expect(operators.LEGACY_KING_PERSONA.startsWith('You are king.\n')).toBe(true);
  expect(operators.LEGACY_KING_PERSONA).toContain('ACE CODER workspace');
  expect(operators.LEGACY_KING_PERSONA).not.toMatch(/\/Users\/|SkyGems|SkyStudio|DPIIT/);
  expect(operators.LEGACY_KING_PERSONA.endsWith('\n')).toBe(true);
  expect(operators.loadPersonaPrompt(king)).toBe(operators.LEGACY_KING_PERSONA);

  // No lane operator ever appears.
  expect(idsOf(parsed.operators).some((id) => id.startsWith('lane:'))).toBe(false);
  expect(idsOf(parsed.operators)).not.toContain('prj-lane');

  // Re-run: existing file wins; nothing is rewritten and the db is not opened.
  const bytesBefore = fs.readFileSync(filePath);
  const soulBefore = fs.readFileSync(king.personaPath);
  const again = operators.migrateOperatorsConfig(userData, {
    dbOpener: () => {
      throw new Error('db must not be opened when operators.json exists');
    },
  });
  expect(again.source).toBe('existing');
  expect(again.wrote).toBe(false);
  expect(again.config.defaultOperatorId).toBe('rook');
  expect(fs.readFileSync(filePath).equals(bytesBefore)).toBe(true);
  expect(fs.readFileSync(king.personaPath).equals(soulBefore)).toBe(true);
});

test('migration leaves a pre-existing king SOUL.md untouched', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));
  const soulPath = path.join(userData, 'operators', 'king', 'SOUL.md');
  fs.mkdirSync(path.dirname(soulPath), { recursive: true });
  fs.writeFileSync(soulPath, 'custom soul written by the owner\n');

  const result = operators.migrateOperatorsConfig(userData, {
    dbOpener: fakeDbOpener([{ id: KING_PROJECT_ID, personal_identity: 'king' }]),
  });
  expect(result.source).toBe('rook-king-v1');
  // Only king found -> king is the default operator.
  expect(result.config.defaultOperatorId).toBe('king');
  expect(fs.readFileSync(soulPath, 'utf8')).toBe('custom soul written by the owner\n');
});

test('abort: db open failure returns defaults in memory and writes nothing', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));
  const result = operators.migrateOperatorsConfig(userData, {
    dbOpener: () => {
      throw new Error('database is locked');
    },
  });
  expect(result.source).toBe('db-error');
  expect(result.wrote).toBe(false);
  expect(idsOf(result.config.operators)).toEqual(['hermes']);
  expect(fs.existsSync(path.join(userData, 'operators.json'))).toBe(false);
});

test('mask-prevention: loadOperatorsConfig never writes; a later migrate still sees the db', () => {
  const userData = tmpUserData();
  const loaded = operators.loadOperatorsConfig(userData);
  expect(loaded.source).toBe('default');
  expect(loaded.config.defaultOperatorId).toBe('hermes');
  // READ-ONLY: the directory is still completely empty.
  expect(fs.readdirSync(userData)).toEqual([]);

  touch(path.join(userData, 'ace.db'));
  const result = operators.migrateOperatorsConfig(userData, {
    dbOpener: fakeDbOpener([{ id: ROOK_PROJECT_ID, personal_identity: 'rook' }]),
  });
  expect(result.source).toBe('rook-king-v1');
  const parsed = JSON.parse(fs.readFileSync(path.join(userData, 'operators.json'), 'utf8'));
  expect(parsed.defaultOperatorId).toBe('rook');
  expect(idsOf(parsed.operators)).toEqual(['rook']);
});

test('no-db: migrate returns defaults in memory and writes nothing (retry next boot)', () => {
  const userData = tmpUserData();
  const result = operators.migrateOperatorsConfig(userData, {
    dbOpener: () => {
      throw new Error('db opener must not run without ace.db');
    },
  });
  expect(result.source).toBe('no-db');
  expect(result.wrote).toBe(false);
  expect(idsOf(result.config.operators)).toEqual(['hermes']);
  expect(fs.readdirSync(userData)).toEqual([]);
});

test('fresh install with a real db but no rook/king rows saves neutral defaults (fresh-v1)', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));
  const result = operators.migrateOperatorsConfig(userData, { dbOpener: fakeDbOpener([]) });
  expect(result.source).toBe('fresh-v1');
  expect(result.wrote).toBe(true);

  const parsed = JSON.parse(fs.readFileSync(path.join(userData, 'operators.json'), 'utf8'));
  expect(parsed.schema).toBe('ace.operators.v1');
  expect(parsed.migratedFrom).toBe('fresh-v1');
  expect(parsed.defaultOperatorId).toBe('hermes');
  expect(parsed.operators).toHaveLength(1);
  const neutral = parsed.operators[0];
  expect(neutral.id).toBe('hermes');
  expect(neutral.label).toBe('Hermes');
  expect(neutral.emoji).toBe(null);
  expect(neutral.workspaceDirName).toBe('personal-workspace');
  expect(neutral.terminalDirName).toBe('personal-hermes');
  expect(neutral.legacyAuthDirs).toEqual([]);
  expect(neutral.persona).toBe(null);
  expect(neutral.personaPath).toBe(null);
  expect(neutral.chat).toBe(null);
  expect(neutral.ownerTitle).toBe('the owner');
});

test('corruption recovery: truncated operators.json falls back to .bak', () => {
  const userData = tmpUserData();
  const v1 = operators.defaultOperatorsConfig();
  operators.saveOperatorsConfig(userData, v1);
  const v2 = operators.defaultOperatorsConfig();
  v2.operators[0].sortOrder = 7;
  operators.saveOperatorsConfig(userData, v2); // copies v1 to .bak first

  fs.writeFileSync(path.join(userData, 'operators.json'), '{ "schema": "ace.operators.v1", trunc');
  const loaded = operators.loadOperatorsConfig(userData);
  expect(loaded.source).toBe('bak');
  expect(loaded.config.operators[0].sortOrder).toBe(0); // v1 contents, not v2
});

test('atomic save: no *.tmp leftovers and .bak equals the previous version bytes', () => {
  const userData = tmpUserData();
  const v1 = operators.defaultOperatorsConfig();
  operators.saveOperatorsConfig(userData, v1);
  const v1Bytes = fs.readFileSync(path.join(userData, 'operators.json'));

  const v2 = operators.defaultOperatorsConfig();
  v2.operators[0].label = 'Hermes Two';
  operators.saveOperatorsConfig(userData, v2);

  const entries = fs.readdirSync(userData);
  expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(fs.readFileSync(path.join(userData, 'operators.json.bak')).equals(v1Bytes)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(userData, 'operators.json'), 'utf8')).operators[0].label).toBe(
    'Hermes Two'
  );
});

test('saveOperatorsConfig refuses invalid configs', () => {
  const userData = tmpUserData();
  expect(() =>
    operators.saveOperatorsConfig(userData, { schema: 'ace.operators.v1', defaultOperatorId: 'x', operators: [] })
  ).toThrow(/invalid operators config/);
  expect(fs.existsSync(path.join(userData, 'operators.json'))).toBe(false);
});

test('effective db_path: missing file, missing line, or out-of-block line all yield null', () => {
  const userData = tmpUserData();
  const home = path.join(userData, 'hermes-home-prj-x');
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.yaml');

  // db_path points at a file that does not exist -> null (never invent paths).
  fs.writeFileSync(
    configPath,
    'plugins:\n  hermes-memory-store:\n    db_path: /nonexistent/ace-test/memory_store.db\n    auto_extract: true\n'
  );
  expect(operators.effectiveMemoryDbPath(userData, 'prj-x')).toBe(null);

  // Plugin block present but no db_path line -> null.
  fs.writeFileSync(configPath, 'plugins:\n  hermes-memory-store:\n    auto_extract: true\nterminal:\n  cwd: /tmp\n');
  expect(operators.effectiveMemoryDbPath(userData, 'prj-x')).toBe(null);

  // db_path OUTSIDE the plugin block (indent <= plugin key) must not match,
  // even though the path exists.
  fs.writeFileSync(configPath, `plugins:\n  hermes-memory-store:\n    auto_extract: true\ndb_path: ${userData}\n`);
  expect(operators.effectiveMemoryDbPath(userData, 'prj-x')).toBe(null);

  // No config.yaml at all -> null.
  expect(operators.effectiveMemoryDbPath(userData, 'prj-missing')).toBe(null);

  // Sanity: the happy path still resolves (quoted value form included).
  const memDb = path.join(userData, 'memory_store.db');
  fs.writeFileSync(memDb, 'mem');
  fs.writeFileSync(configPath, `plugins:\n  hermes-memory-store:\n    db_path: "${memDb}"\n    auto_extract: true\n`);
  expect(operators.effectiveMemoryDbPath(userData, 'prj-x')).toBe(memDb);
});

test('migrated rook memoryDbPath is null when the configured db file is missing', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));
  const rookHome = path.join(userData, `hermes-home-${ROOK_PROJECT_ID}`);
  fs.mkdirSync(rookHome, { recursive: true });
  fs.writeFileSync(
    path.join(rookHome, 'config.yaml'),
    'plugins:\n  hermes-memory-store:\n    db_path: /nonexistent/ace-test/memory_store.db\n'
  );
  const result = operators.migrateOperatorsConfig(userData, {
    dbOpener: fakeDbOpener([{ id: ROOK_PROJECT_ID, personal_identity: 'rook' }]),
  });
  expect(result.source).toBe('rook-king-v1');
  expect(result.config.operators[0].memoryDbPath).toBe(null);
});

test('loadPersonaPrompt: personaPath wins, persona string fallback, undefined otherwise', () => {
  const userData = tmpUserData();
  const personaPath = path.join(userData, 'SOUL.md');
  fs.writeFileSync(personaPath, 'soul text\n');
  const base = operators.defaultOperatorsConfig().operators[0];
  expect(operators.loadPersonaPrompt({ ...base, personaPath })).toBe('soul text\n');
  expect(operators.loadPersonaPrompt({ ...base, personaPath: path.join(userData, 'missing.md') })).toBe(null);
  expect(operators.loadPersonaPrompt({ ...base, persona: 'inline persona' })).toBe('inline persona');
  expect(operators.loadPersonaPrompt(base)).toBe(undefined);
  expect(operators.loadPersonaPrompt(null)).toBe(undefined);
});

test('normalizeOperatorId matrix, lane passthrough, consistency check, operatorForProject', () => {
  const userData = tmpUserData();
  touch(path.join(userData, 'ace.db'));
  const { config } = operators.migrateOperatorsConfig(userData, {
    dbOpener: fakeDbOpener([
      { id: ROOK_PROJECT_ID, personal_identity: 'rook' },
      { id: KING_PROJECT_ID, personal_identity: 'king' },
    ]),
  });

  expect(operators.normalizeOperatorId(config, 'rook')).toBe('rook');
  expect(operators.normalizeOperatorId(config, 'ROOK')).toBe('rook');
  expect(operators.normalizeOperatorId(config, 'King')).toBe('king');
  expect(operators.normalizeOperatorId(config, '  king  ')).toBe('king');
  // Lane identities are not operators: passed through untouched.
  expect(operators.normalizeOperatorId(config, 'lane:lane-abc')).toBe('lane:lane-abc');
  expect(operators.normalizeOperatorId(config, 'lane:UPPER')).toBe('lane:UPPER');
  // Unknown/empty -> defaultOperatorId.
  expect(operators.normalizeOperatorId(config, 'zzz')).toBe('rook');
  expect(operators.normalizeOperatorId(config, '')).toBe('rook');
  expect(operators.normalizeOperatorId(config, undefined)).toBe('rook');
  expect(operators.normalizeOperatorId(config, null)).toBe('rook');

  expect(operators.checkDbConfigConsistency(['rook', 'queen', 'lane:x', '', 'QUEEN'], config)).toEqual(['queen']);
  expect(operators.checkDbConfigConsistency(['rook', 'king'], config)).toEqual([]);

  expect(operators.operatorForProject(config, { personal_identity: 'lane:lane-abc' })).toBe(null);
  expect(operators.operatorForProject(config, { personal_identity: 'KING' })?.id).toBe('king');
  expect(operators.operatorForProject(config, { personal_identity: '' })).toBe(null);
  expect(operators.operatorForProject(config, null)).toBe(null);

  expect(operators.getOperator(config, 'rook')?.label).toBe('Rook');
  expect(operators.getOperator(config, 'nope')).toBe(null);
  expect(idsOf(operators.listControlPlaneOperators(config))).toEqual(['rook', 'king']);
});
