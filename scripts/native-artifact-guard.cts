const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function defaultAppPath() {
  const root = repoRoot();
  const candidates = [
    ...(process.platform === 'win32' ? [path.join(root, 'release', 'win-unpacked')] : []),
    path.join(root, 'release', 'mac-arm64', 'ACE CODER.app'),
    path.join(root, 'release', 'mac', 'ACE CODER.app'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function electronBinary() {
  const root = repoRoot();
  if (process.platform === 'darwin') {
    return path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  if (process.platform === 'win32') {
    return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  }
  return path.join(root, 'node_modules', 'electron', 'dist', 'electron');
}

function fail(message: string): never {
  console.error(`native-artifact-guard: ${message}`);
  process.exit(1);
}

const appPath = path.resolve(process.argv[2] || defaultAppPath());
const resourcesDir = process.platform === 'darwin'
  ? path.join(appPath, 'Contents', 'Resources')
  : path.join(appPath, 'resources');
const asarNodeModules = path.join(resourcesDir, 'app.asar', 'node_modules');
const unpackedNodeModules = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
const checks = [
  {
    name: 'better-sqlite3',
    requirePath: path.join(asarNodeModules, 'better-sqlite3'),
    nativePath: path.join(unpackedNodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  },
  {
    name: 'node-pty',
    requirePath: path.join(asarNodeModules, 'node-pty'),
    nativePath: path.join(unpackedNodeModules, 'node-pty', 'build', 'Release', 'pty.node'),
  },
];

if (!fs.existsSync(appPath)) fail(`app bundle missing: ${appPath}`);
if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))) fail(`app.asar missing under ${resourcesDir}`);
const electron = electronBinary();
if (!fs.existsSync(electron)) fail(`Electron binary missing: ${electron}`);

for (const check of checks) {
  if (!fs.existsSync(check.nativePath)) fail(`${check.name} native module missing: ${check.nativePath}`);
}

const probe = `
const checks = ${JSON.stringify(checks.map(({ name, requirePath }) => ({ name, requirePath })))};
for (const check of checks) {
  const loaded = require(check.requirePath);
  if (check.name === 'better-sqlite3') {
    const db = new loaded(':memory:');
    db.pragma('user_version');
    db.close();
  }
  process.stdout.write(check.name + ':ok\\n');
}
process.stdout.write('modules:' + process.versions.modules + '\\n');
`;
const result = spawnSync(electron, ['-e', probe], {
  cwd: repoRoot(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  fail(`Electron failed to load packaged native modules from ${appPath}`);
}

const output = `${result.stdout || ''}${result.stderr || ''}`;
for (const check of checks) {
  if (!output.includes(`${check.name}:ok`)) fail(`${check.name} probe did not report ok`);
}
console.log(`native-artifact-guard: OK ${appPath}`);
