// Verifies a packaged Ace binary is really the architecture its manifest
// claims — checksums and signatures only prove the bytes are the ones we
// signed, not that they can run.
//
// The main executable is not enough: a cross-built package can carry a correct
// launcher next to a foreign-arch native module or helper, which launches and
// then dies the first time that module loads. So `.app` bundles are scanned in
// full. Header parsing is shared with the updater (electron/macho-arch.cts) so
// release-time and install-time validation cannot drift.

const fs = require('node:fs');
const path = require('node:path');
const { binaryArchs, ArchReadError } = require('../electron/macho-arch.cts');

type Arch = 'arm64' | 'x64';

const PRODUCT_NAME = 'Ace';

// Bundle subtrees that hold loadable code.
const SCAN_DIRS = [
  path.join('Contents', 'MacOS'),
  path.join('Contents', 'Frameworks'),
  path.join('Contents', 'Resources', 'app.asar.unpacked'),
];

class ArchVerifyError extends Error {}

function fail(message: string): never {
  throw new ArchVerifyError(message);
}

/**
 * Native packages ship prebuilt binaries for every platform they support and
 * pick one at runtime by arch, so an arm64 prebuild sitting inside an x64 app
 * is expected and inert. Only paths naming a DIFFERENT arch are skipped; a
 * binary on the loadable path is never excused.
 */
function isForeignArchPath(relPath: string, expected: Arch): boolean {
  const foreign = expected === 'x64' ? /(^|[-_.])(arm64|aarch64)([-_.]|$)/ : /(^|[-_.])(x64|x86_64|ia32)([-_.]|$)/;
  return relPath.split(path.sep).some((segment: string) => foreign.test(segment));
}

function walkFiles(root: string, out: string[] = []): string[] {
  let entries: any[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    // Symlinks inside .framework bundles alias files already walked.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** CFBundleExecutable — the bundle's declared entry point, not a guess. */
function bundleExecutableName(appPath: string): string | null {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return null;
  const match = fs
    .readFileSync(plist, 'utf8')
    .match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

/**
 * Resolves the main executable deterministically. Directory enumeration order
 * must never decide what gets verified — a helper binary passing the check
 * would hide a wrong-arch main binary.
 */
function mainExecutable(appPath: string): string {
  if (fs.statSync(appPath).isFile()) return appPath;
  if (appPath.endsWith('.app')) {
    const name = bundleExecutableName(appPath);
    if (!name) fail(`no CFBundleExecutable in ${path.join(appPath, 'Contents', 'Info.plist')}`);
    const exe = path.join(appPath, 'Contents', 'MacOS', name);
    if (!fs.existsSync(exe)) fail(`CFBundleExecutable '${name}' not found at ${exe}`);
    return exe;
  }
  // win-unpacked: the launcher shares the product name; uninstallers and
  // helpers must never be picked in its place.
  const exes = fs.readdirSync(appPath).filter((f: string) => f.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) fail(`no .exe found in ${appPath}`);
  const named = exes.find((f: string) => f === `${PRODUCT_NAME}.exe`);
  if (named) return path.join(appPath, named);
  if (exes.length === 1) return path.join(appPath, exes[0]);
  fail(`ambiguous executable in ${appPath} (${exes.join(', ')}); expected ${PRODUCT_NAME}.exe`);
}

/**
 * Every Mach-O in the bundle's loadable subtrees that does NOT contain
 * `expected`. Non-Mach-O files (scripts, assets) yield no verdict and are
 * skipped rather than failed.
 */
function foreignArchBinaries(appPath: string, expected: Arch): Array<{ file: string; archs: string[] }> {
  const offenders: Array<{ file: string; archs: string[] }> = [];
  for (const sub of SCAN_DIRS) {
    for (const file of walkFiles(path.join(appPath, sub))) {
      const rel = path.relative(appPath, file);
      if (isForeignArchPath(rel, expected)) continue;
      let archs: string[];
      try {
        archs = binaryArchs(file);
      } catch (error: any) {
        // A malformed fat wrapper is a real defect, not an unreadable asset.
        if (error instanceof ArchReadError && /fat slice/.test(String(error.message))) {
          offenders.push({ file: rel, archs: [`unreadable: ${error.message}`] });
        }
        continue;
      }
      if (archs.length > 0 && !archs.includes(expected)) offenders.push({ file: rel, archs });
    }
  }
  return offenders;
}

/** Throws ArchVerifyError unless `appPath` really is `expected`. */
function verifyArtifactArch(
  appPath: string,
  expected: string,
  opts: { deep?: boolean } = {},
): { exePath: string; archs: Arch[]; scanned: boolean } {
  if (expected !== 'arm64' && expected !== 'x64') fail(`unsupported expected arch '${expected}'`);
  if (!fs.existsSync(appPath)) fail(`app not found at ${appPath}`);
  const exePath = mainExecutable(appPath);
  let archs: Arch[];
  try {
    archs = binaryArchs(exePath);
  } catch (error: any) {
    fail(error && error.message ? error.message : String(error));
  }
  if (archs.length === 0) fail(`could not determine the architecture of ${exePath}`);
  // A universal binary satisfies the claim only if it CONTAINS the arch; a thin
  // binary must match exactly. Either way a wrong-arch package fails here.
  if (!archs.includes(expected as Arch)) {
    fail(`${exePath} is ${archs.join('+')} but the release claims ${expected}`);
  }
  const deep = opts.deep !== false && appPath.endsWith('.app');
  if (deep) {
    const offenders = foreignArchBinaries(appPath, expected as Arch);
    if (offenders.length > 0) {
      const lines = offenders.map((o) => `  ${o.file}: ${o.archs.join('+')}`).join('\n');
      fail(`release claims ${expected} but these bundled binaries do not provide it:\n${lines}`);
    }
  }
  return { exePath, archs, scanned: deep };
}

module.exports = {
  verifyArtifactArch,
  foreignArchBinaries,
  isForeignArchPath,
  mainExecutable,
  binaryArchs,
  ArchVerifyError,
};

function parseArgs(argv: string[]) {
  const out: { app?: string; expect?: string; manifest?: string; deep?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--expect') out.expect = argv[++i];
    else if (argv[i] === '--manifest') out.manifest = argv[++i];
    else if (argv[i] === '--no-deep') out.deep = false;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app) {
    fail('usage: verify-artifact-arch --app <path> [--expect <arch>] [--manifest <file>] [--no-deep]');
  }
  let expected = args.expect;
  if (args.manifest) {
    const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    if (expected && expected !== manifest.arch) {
      fail(`--expect ${expected} contradicts manifest arch ${manifest.arch}`);
    }
    expected = manifest.arch;
  }
  if (!expected) fail('no expected arch (pass --expect or --manifest)');
  const { exePath, archs, scanned } = verifyArtifactArch(args.app, expected, { deep: args.deep });
  console.log(
    `verify-artifact-arch: OK — ${path.basename(exePath)} is ${archs.join('+')}, claimed ${expected}` +
      (scanned ? ' (bundle scanned: no foreign-arch binaries)' : ''),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error: any) {
    console.error(`verify-artifact-arch: ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}
