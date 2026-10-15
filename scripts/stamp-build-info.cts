#!/usr/bin/env tsx
// Stamps electron/build-info.json with build metadata so the packaged app
// (and the update manifest generator) know exactly what was built.
//
// Usage:
//   npx tsx scripts/stamp-build-info.cts [--channel dev|latest] [--version 1.2.3]
//     [--git-sha <sha>] [--built-at <iso8601>] [--out <path>] [--local]
//
// Channel resolution: --channel > ACE_CHANNEL env > 'dev'.
// --local stamps a prerelease version (`<pkg.version>-dev.0`) for locally
// packaged builds, so compareSemver still ranks published `-dev.N` builds
// above them and the in-app updater keeps offering dev-channel updates.
// An explicit --version always wins over --local.
// Idempotent: identical inputs produce byte-identical output and skip the write.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

interface StampOptions {
  version?: string;
  channel?: string;
  gitSha?: string;
  builtAt?: string;
  out?: string;
  local?: boolean;
  help?: boolean;
  packageJsonPath?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

interface ResolvedStampOptions {
  version: string;
  channel: string;
  outPath: string;
}

interface BuildInfo {
  schema: 'ace.app.build-info.v1';
  version: string;
  channel: string;
  gitSha: string;
  gitShortSha: string;
  builtAt: string;
}

const DEFAULT_OUT = path.join(__dirname, '..', 'electron', 'build-info.json');
const DEFAULT_PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

function parseArgs(argv: string[]): StampOptions {
  const out: StampOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') out.version = argv[++i];
    else if (arg === '--channel') out.channel = argv[++i];
    else if (arg === '--git-sha') out.gitSha = argv[++i];
    else if (arg === '--built-at') out.builtAt = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--local') out.local = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`stamp-build-info: unknown argument '${arg}' (try --help)`);
  }
  return out;
}

function resolveGitSha(opts: StampOptions): string {
  if (opts.gitSha) return opts.gitSha;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
  }).trim();
  if (!sha) throw new Error('stamp-build-info: git rev-parse HEAD returned nothing');
  return sha;
}

// Pure core shared by buildInfo and resolveStampOptions: parsed options +
// package.json contents + env in, {version, channel, outPath} out. Never
// touches disk, git, or the clock.
function resolveStampCore(
  opts: StampOptions,
  pkg: { version?: string },
  env: Record<string, string | undefined>
): ResolvedStampOptions {
  let version = opts.version;
  if (!version) {
    version = pkg.version;
    if (!version) throw new Error('stamp-build-info: no version in package.json and no --version flag');
    // Local packages stamp a prerelease so published `<v>-dev.N` builds
    // still rank above them in compareSemver (else dev updates never offer).
    if (opts.local) version = `${version}-dev.0`;
  }
  return {
    version,
    channel: opts.channel || env.ACE_CHANNEL || 'dev',
    outPath: path.resolve(opts.out || DEFAULT_OUT),
  };
}

// Test-friendly entry point: raw argv + package.json contents + env.
function resolveStampOptions(
  argv: string[],
  pkg: { version?: string },
  env: Record<string, string | undefined> = process.env
): ResolvedStampOptions {
  return resolveStampCore(parseArgs(argv), pkg, env);
}

function buildInfo(opts: StampOptions = {}): BuildInfo {
  const env = opts.env || process.env;
  let pkg: { version?: string } = {};
  if (!opts.version) {
    const pkgPath = opts.packageJsonPath || DEFAULT_PACKAGE_JSON;
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (!pkg.version) throw new Error(`stamp-build-info: no version in ${pkgPath} and no --version flag`);
  }
  const { version, channel } = resolveStampCore(opts, pkg, env);
  const gitSha = resolveGitSha(opts);
  return {
    schema: 'ace.app.build-info.v1',
    version,
    channel,
    gitSha,
    gitShortSha: gitSha.slice(0, 7),
    builtAt: opts.builtAt || new Date().toISOString(),
  };
}

function stampBuildInfo(opts: StampOptions = {}): { path: string; info: BuildInfo; changed: boolean } {
  const info = buildInfo(opts);
  const outPath = path.resolve(opts.out || DEFAULT_OUT);
  const next = `${JSON.stringify(info, null, 2)}\n`;
  let changed = true;
  if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === next) {
    changed = false;
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, next);
  }
  return { path: outPath, info, changed };
}

function main(argv: string[] = process.argv.slice(2)): void {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.error(
      'usage: stamp-build-info [--channel dev|latest] [--version x.y.z] [--git-sha sha] [--built-at iso8601] [--out path] [--local]'
    );
    return;
  }
  const { path: outPath, info, changed } = stampBuildInfo(opts);
  console.error(
    `stamp-build-info: ${changed ? 'wrote' : 'unchanged'} ${outPath} ` +
      `version=${info.version} channel=${info.channel} gitSha=${info.gitShortSha} builtAt=${info.builtAt}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  resolveStampOptions,
  buildInfo,
  stampBuildInfo,
  main,
};
