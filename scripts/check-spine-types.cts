#!/usr/bin/env tsx
/**
 * Spine typecheck gate.
 *
 * `npm run build` uses esbuild, which STRIPS types — so a type regression in
 * the spine compiles green and ships. The wider electron project also carries a
 * large pre-existing type-error baseline, so a blanket `tsc` gate is not
 * actionable. But `electron/run-ledger/**` (the Ring-0 kernel + reconciler +
 * projection — the nervous system) is currently 100% type-clean. This gate runs
 * the full electron typecheck and fails IFF any error is attributed to a
 * run-ledger file, keeping that surface at zero type errors without drowning in
 * unrelated baseline noise.
 *
 * Run: `npm run typecheck:spine` (also part of `npm run guard:spine`).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(__dirname, '..');

const res = spawnSync(
  'npx',
  ['tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.electron.json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
);

const output = `${res.stdout || ''}${res.stderr || ''}`;
// Match tsc error lines whose file path is under electron/run-ledger/.
const offenderRe = /(^|[\s/])electron\/run-ledger\/[^\s(]+\([0-9]+,[0-9]+\): error TS/;
const offenders = output.split('\n').filter((line) => offenderRe.test(line));

if (offenders.length > 0) {
  console.error(
    `✖ ${offenders.length} type error(s) in electron/run-ledger/** — the spine kernel must stay type-clean (esbuild does not typecheck):`,
  );
  for (const line of offenders) console.error('  ' + line.trim());
  process.exit(1);
}

console.log('✓ electron/run-ledger/** is type-clean (0 errors against the electron typecheck).');
