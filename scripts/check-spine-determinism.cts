#!/usr/bin/env tsx
/**
 * Spine determinism guard.
 *
 * The run-ledger spine is an append-only event log that must REPLAY
 * deterministically: every fact carries a caller-supplied `ts`, and the reducer
 * never reads the wall clock. Calling `Date.now()`, `Math.random()`, or an
 * argless `new Date()` at MODULE TOP-LEVEL of a run-ledger module would bake a
 * non-deterministic value into the module at import time and break replay
 * (the property every pure module documents in its header). These calls are
 * fine INSIDE function bodies (evaluated at event time with a real clock); this
 * guard only forbids them at module scope.
 *
 * Run: `npm run check:spine-determinism` (also part of `npm run guard:spine`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SPINE_DIR = join(__dirname, '..', 'electron', 'run-ledger');

function isInsideFunction(node: ts.Node): boolean {
  let p = node.parent;
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    ) {
      return true;
    }
    p = p.parent;
  }
  return false;
}

function scan(file: string, violations: string[]): void {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = file.slice(file.indexOf('electron/'));

  const flag = (node: ts.Node, what: string) => {
    if (isInsideFunction(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`${rel}:${line + 1} — ${what} at module scope`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression.getText(sf);
      const prop = node.expression.name.getText(sf);
      if (obj === 'Date' && prop === 'now') flag(node, 'Date.now()');
      if (obj === 'Math' && prop === 'random') flag(node, 'Math.random()');
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(sf) === 'Date' &&
      (!node.arguments || node.arguments.length === 0)
    ) {
      flag(node, 'new Date() (argless)');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const files = readdirSync(SPINE_DIR)
  .filter((f) => f.endsWith('.cts') && !f.endsWith('.test.cts'))
  .map((f) => join(SPINE_DIR, f));

const violations: string[] = [];
for (const f of files) scan(f, violations);

if (violations.length > 0) {
  console.error(
    'Spine determinism violations — no Date.now()/Math.random()/argless new Date() at module scope in electron/run-ledger/** (they break deterministic ledger replay):',
  );
  for (const v of violations) console.error('  ✖ ' + v);
  console.error('\nMove the clock read inside a function so it runs at event time, not import time.');
  process.exit(1);
}

console.log(`✓ Spine determinism OK — ${files.length} run-ledger modules clean (no module-scope clock/RNG).`);
