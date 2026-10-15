// Transpile electron/**/*.cts → electron/**/*.cjs (and the Ace CLI
// sources under tools/ace/src/) in place.
//
// Electron's "main" field must resolve to native CJS, so this script turns
// every TypeScript source in electron/ into a sibling .cjs that Node/Electron
// can load directly — no runtime tsx hook, no esbuild spawning from inside
// app.asar. The Ace CLI bin uses the same trick so the packaged
// binary at tools/ace/bin/ace can `require('../src/index.cjs')`
// without a runtime tsx dependency (devDependencies are pruned from the DMG).
//
// Each file is compiled in isolation (bundle: false conceptually —
// see packages: 'external') so __dirname still points at the original source
// directory at runtime, which the electron code relies on for locating
// assets/, bin/, profiles/, etc.
//
// Cross-file requires like `require('./local-core.cts')` are rewritten to
// `require('./local-core.cjs')` during the build so the compiled output
// resolves against the generated .cjs siblings.

import { build, type BuildOptions, type Plugin } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'electron');
const aceCliSrcDir = path.join(root, 'tools', 'ace', 'src');
const aceCliBuildInfoPath = path.join(aceCliSrcDir, 'build-info.json');

const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist', 'bin', 'assets']);

function findCtsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findCtsFiles(full, out);
    } else if (entry.name.endsWith('.cts') && !entry.name.endsWith('.test.cts')) {
      out.push(full);
    }
  }
  return out;
}

// Rewrites every relative import/require path so `.cts` → `.cjs` and marks
// them external. With packages: 'external', this preserves per-file
// __dirname semantics while still letting esbuild traverse and validate
// the import graph.
const rewriteLocalCts: Plugin = {
  name: 'rewrite-local-cts',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => ({
      path: args.path.replace(/\.cts$/, '.cjs'),
      external: true,
    }));
  },
};

function buildOptions(entry: string): BuildOptions {
  return {
    entryPoints: [entry],
    outfile: entry.replace(/\.cts$/, '.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    sourcemap: 'inline',
    logLevel: 'warning',
    plugins: [rewriteLocalCts],
  };
}

function currentGitSha(): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function writeAceCliBuildInfo(): void {
  const gitSha = currentGitSha();
  fs.writeFileSync(aceCliBuildInfoPath, JSON.stringify({
    schema: 'ace.cli.build-info.v1',
    gitSha,
    gitShortSha: gitSha ? gitSha.slice(0, 12) : null,
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');
}

export async function compileElectron(): Promise<void> {
  writeAceCliBuildInfo();
  const files = [...findCtsFiles(electronDir), ...findCtsFiles(aceCliSrcDir)];
  await Promise.all(files.map((entry) => build(buildOptions(entry))));
}

export async function compileElectronFile(source: string): Promise<void> {
  if (!source.endsWith('.cts') || source.endsWith('.test.cts')) return;
  await build(buildOptions(source));
}

if (require.main === module) {
  compileElectron()
    .then(() => {
      process.stdout.write('[ace] compiled electron + Ace CLI (*.cts → *.cjs)\n');
    })
    .catch((err) => {
      process.stderr.write(`[ace] compile-electron failed: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
