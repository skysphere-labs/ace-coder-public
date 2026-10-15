#!/usr/bin/env tsx
// Verifies that a packaged Ace zip carries electron/build-info.json inside
// Contents/Resources/app.asar, and that it matches release metadata when given.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');

type UpdateChannel = 'dev' | 'latest';

interface BuildInfo {
  schema: 'ace.app.build-info.v1';
  version: string;
  channel: UpdateChannel;
  gitSha: string;
  gitShortSha: string;
  builtAt: string;
}

interface UpdateManifest {
  schema: 'ace.update-manifest.v1';
  version: string;
  channel: UpdateChannel;
  gitSha: string;
  builtAt: string;
}

interface CliArgs {
  zip?: string;
  manifest?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--zip') out.zip = argv[++i];
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`update-artifact-guard: unknown argument '${arg}' (try --help)`);
  }
  return out;
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateBuildInfo(info: any): BuildInfo {
  if (!info || typeof info !== 'object') {
    throw new Error('update-artifact-guard: build-info.json is empty or not an object');
  }
  if (info.schema !== 'ace.app.build-info.v1') {
    throw new Error(`update-artifact-guard: unexpected build-info schema '${String(info.schema)}'`);
  }
  if (typeof info.version !== 'string' || info.version === '') {
    throw new Error('update-artifact-guard: build-info version is missing');
  }
  if (info.channel !== 'dev' && info.channel !== 'latest') {
    throw new Error(`update-artifact-guard: build-info channel '${String(info.channel)}' is invalid`);
  }
  if (typeof info.gitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(info.gitSha)) {
    throw new Error('update-artifact-guard: build-info gitSha must be a 40-character SHA');
  }
  if (
    typeof info.gitShortSha !== 'string' ||
    info.gitShortSha === '' ||
    !info.gitSha.startsWith(info.gitShortSha)
  ) {
    throw new Error('update-artifact-guard: build-info gitShortSha must match gitSha');
  }
  if (!isIsoTimestamp(info.builtAt)) {
    throw new Error('update-artifact-guard: build-info builtAt must be an ISO timestamp');
  }
  return info as BuildInfo;
}

function validateManifest(manifest: any): UpdateManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('update-artifact-guard: manifest is empty or not an object');
  }
  if (manifest.schema !== 'ace.update-manifest.v1') {
    throw new Error(`update-artifact-guard: unexpected manifest schema '${String(manifest.schema)}'`);
  }
  if (manifest.channel !== 'dev' && manifest.channel !== 'latest') {
    throw new Error(`update-artifact-guard: manifest channel '${String(manifest.channel)}' is invalid`);
  }
  for (const field of ['version', 'gitSha', 'builtAt']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      throw new Error(`update-artifact-guard: manifest ${field} is missing`);
    }
  }
  return manifest as UpdateManifest;
}

function compareBuildInfoToManifest(info: BuildInfo, manifest: UpdateManifest): void {
  const checks: Array<[keyof BuildInfo, keyof UpdateManifest]> = [
    ['version', 'version'],
    ['channel', 'channel'],
    ['gitSha', 'gitSha'],
    ['builtAt', 'builtAt'],
  ];
  for (const [infoField, manifestField] of checks) {
    if (info[infoField] !== manifest[manifestField]) {
      throw new Error(
        `update-artifact-guard: packaged build-info ${infoField} does not match manifest ${manifestField}`,
      );
    }
  }
}

function findAppBundle(root: string): string {
  const found: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.app')) {
        found.push(full);
      } else {
        walk(full);
      }
    }
  }
  walk(root);
  if (found.length !== 1) {
    throw new Error(`update-artifact-guard: expected exactly one .app bundle in zip, found ${found.length}`);
  }
  return found[0];
}

function readBuildInfoFromAsar(asarPath: string): BuildInfo {
  if (!fs.existsSync(asarPath)) {
    throw new Error('update-artifact-guard: packaged app is missing Contents/Resources/app.asar');
  }
  let raw: Buffer;
  try {
    raw = asar.extractFile(asarPath, 'electron/build-info.json');
  } catch {
    throw new Error('update-artifact-guard: app.asar is missing electron/build-info.json');
  }
  return validateBuildInfo(JSON.parse(raw.toString('utf8')));
}

function assertBundledAceCli(appPath: string): void {
  const relativePath = path.join(
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'tools',
    'ace',
    'bin',
    'ace',
  );
  const cliPath = path.join(appPath, relativePath);
  let stat: import('fs').Stats;
  try {
    stat = fs.statSync(cliPath);
  } catch {
    throw new Error(`update-artifact-guard: packaged app is missing ${relativePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`update-artifact-guard: packaged ${relativePath} is not a file`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`update-artifact-guard: packaged ${relativePath} is not executable`);
  }
}

function verifyUpdateArtifact(opts: { zip: string; manifest?: string }): BuildInfo {
  const zipPath = path.resolve(opts.zip);
  if (!fs.existsSync(zipPath)) throw new Error(`update-artifact-guard: zip not found at ${zipPath}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-update-artifact-'));
  try {
    execFileSync('unzip', ['-q', zipPath, '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    const appPath = findAppBundle(tmp);
    assertBundledAceCli(appPath);
    const info = readBuildInfoFromAsar(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
    if (opts.manifest) {
      const manifest = validateManifest(JSON.parse(fs.readFileSync(opts.manifest, 'utf8')));
      compareBuildInfoToManifest(info, manifest);
    }
    return info;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const USAGE = 'usage: update-artifact-guard --zip <Ace-*.zip> [--manifest release/manifest.json]';

function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return;
  }
  if (!args.zip) throw new Error(`update-artifact-guard: --zip is required\n${USAGE}`);
  const info = verifyUpdateArtifact({ zip: args.zip, manifest: args.manifest });
  console.error(
    `update-artifact-guard: verified packaged build-info v${info.version} ` +
      `channel=${info.channel} gitSha=${info.gitShortSha}`,
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
  validateBuildInfo,
  validateManifest,
  compareBuildInfoToManifest,
  readBuildInfoFromAsar,
  assertBundledAceCli,
  verifyUpdateArtifact,
  main,
};
