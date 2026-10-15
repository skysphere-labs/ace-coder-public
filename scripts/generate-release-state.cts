#!/usr/bin/env tsx
// Writes the per-channel release-state artifact (ace.release-state.v1).
//
// The release workflows upload `<channel>/release-state.json` (no-store) at
// three points: `publishing` after the version is stamped (before artifacts
// upload), `ready` after the post-publish live-feed probe, and `failed` from
// an `if: failure()` step. The in-app updater reads it as an ADVISORY
// freshness signal — it only informs the Updates UI CTA and never relaxes the
// signed-manifest / sha512 install authorization.
//
// Usage:
//   npx tsx scripts/generate-release-state.cts --channel dev|latest \
//     --state publishing|ready|failed --version <v> [--git-sha <sha>] \
//     [--run-id <id>] [--run-url <url>] [--started-at <iso8601>] --out <path>
//
// Idempotent within a run: `--started-at` carries the train start across the
// publishing/ready/failed writes so consumers can age the train.

const fs = require('fs');
const path = require('path');

const RELEASE_STATE_SCHEMA = 'ace.release-state.v1';
const RELEASE_TRAIN_STATES = ['publishing', 'ready', 'failed'] as const;
const RELEASE_CHANNELS = ['dev', 'latest'] as const;

interface ReleaseStateOptions {
  channel?: string;
  state?: string;
  version?: string;
  gitSha?: string;
  runId?: string;
  runUrl?: string;
  startedAt?: string;
  updatedAt?: string;
  out?: string;
  help?: boolean;
}

interface ReleaseStateFile {
  schema: 'ace.release-state.v1';
  channel: string;
  state: string;
  version: string;
  gitSha: string | null;
  runId: string | null;
  runUrl: string | null;
  startedAt: string;
  updatedAt: string;
}

function parseArgs(argv: string[]): ReleaseStateOptions {
  const out: ReleaseStateOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--channel') out.channel = argv[++i];
    else if (arg === '--state') out.state = argv[++i];
    else if (arg === '--version') out.version = argv[++i];
    else if (arg === '--git-sha') out.gitSha = argv[++i];
    else if (arg === '--run-id') out.runId = argv[++i];
    else if (arg === '--run-url') out.runUrl = argv[++i];
    else if (arg === '--started-at') out.startedAt = argv[++i];
    else if (arg === '--updated-at') out.updatedAt = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`generate-release-state: unknown argument '${arg}' (try --help)`);
  }
  return out;
}

function clean(value: string | undefined): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

// Pure builder: options in, validated artifact out. Never touches disk or env.
function buildReleaseState(opts: ReleaseStateOptions = {}): ReleaseStateFile {
  const channel = clean(opts.channel);
  if (!channel || !(RELEASE_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`generate-release-state: --channel must be one of ${RELEASE_CHANNELS.join('|')}`);
  }
  const state = clean(opts.state);
  if (!state || !(RELEASE_TRAIN_STATES as readonly string[]).includes(state)) {
    throw new Error(`generate-release-state: --state must be one of ${RELEASE_TRAIN_STATES.join('|')}`);
  }
  // A failed train may abort before the version stamp; tolerate it there only.
  const version = clean(opts.version);
  if (!version && state !== 'failed') {
    throw new Error('generate-release-state: --version is required for publishing/ready states');
  }
  const updatedAt = clean(opts.updatedAt) ?? new Date().toISOString();
  return {
    schema: RELEASE_STATE_SCHEMA,
    channel,
    state,
    version: version ?? 'unknown',
    gitSha: clean(opts.gitSha),
    runId: clean(opts.runId),
    runUrl: clean(opts.runUrl),
    startedAt: clean(opts.startedAt) ?? updatedAt,
    updatedAt,
  };
}

function writeReleaseState(opts: ReleaseStateOptions = {}): { path: string; state: ReleaseStateFile } {
  const state = buildReleaseState(opts);
  const outPath = clean(opts.out);
  if (!outPath) throw new Error('generate-release-state: --out is required');
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`);
  return { path: resolved, state };
}

function main(argv: string[] = process.argv.slice(2)): void {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.error(
      'usage: generate-release-state --channel dev|latest --state publishing|ready|failed ' +
        '--version <v> [--git-sha sha] [--run-id id] [--run-url url] [--started-at iso8601] --out <path>'
    );
    return;
  }
  const { path: outPath, state } = writeReleaseState(opts);
  console.error(
    `generate-release-state: wrote ${outPath} channel=${state.channel} state=${state.state} version=${state.version}`
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
  RELEASE_STATE_SCHEMA,
  parseArgs,
  buildReleaseState,
  writeReleaseState,
  main,
};
