import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The legacy kingSoul() seed moved out of local-core.cts into the operator
// profile layer: electron/operators.cts now holds the verbatim persona as
// LEGACY_KING_PERSONA (materialized once per owner machine into
// <userDataPath>/operators/king/SOUL.md by migrateOperatorsConfig). This test
// pins the persona's key invariants — the operator visibility/reporting
// contract — so a rewrite cannot silently drop them.
const { LEGACY_KING_PERSONA } = require('../operators.cts');

test('LEGACY_KING_PERSONA keeps the king identity seed', () => {
  expect(LEGACY_KING_PERSONA.startsWith('You are king.')).toBe(true);
  expect(LEGACY_KING_PERSONA).toMatch(/start with exactly: "I'm king\."/);
});

test('LEGACY_KING_PERSONA persists the operator visibility contract', () => {
  expect(LEGACY_KING_PERSONA).toMatch(/Communication and visibility:/);
  expect(LEGACY_KING_PERSONA).toMatch(
    /At the start of non-trivial work, give a compact intent\/checkpoint line/
  );
  expect(LEGACY_KING_PERSONA).toMatch(
    /During long work, report only actionable transitions/
  );
  expect(LEGACY_KING_PERSONA).toMatch(/Do not stream routine polling noise/);
  expect(LEGACY_KING_PERSONA).toMatch(
    /leave concise visible checkpoints with task\/stream\/PR ids/
  );
  expect(LEGACY_KING_PERSONA).toMatch(
    /Final reports should separate confirmed facts, evidence checked, risks\/blockers, and next action/
  );
  expect(LEGACY_KING_PERSONA).toMatch(
    /Keep this visibility standard consistent with Rook/
  );
});

test('local-core no longer defines kingSoul() — operators.cts is the single source', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'local-core.cts'),
    'utf8'
  );
  expect(source.includes('function kingSoul(')).toBe(false);
  expect(source.includes('You are king.')).toBe(false);
});
