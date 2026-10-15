// hermes-paths — the ONE place that knows where a Hermes install lives.
//
// Layouts come from the Hermes installers (scripts/install.sh, install.ps1) and
// electron-builder's output naming; see the PR body for the full derivation.
// Everything is injectable so the win32/linux branches are testable from macOS.

const fs = require('fs');
const os = require('os');
const path = require('path');

type PathDeps = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  homedir?: string;
  fsImpl?: any;
  // Pre-resolved home from a caller that owns its own resolver.
  home?: string;
};

function deps(options: PathDeps = {}) {
  return {
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    env: options.env || process.env,
    homedir: options.homedir || os.homedir(),
    fsImpl: options.fsImpl || fs,
  };
}

function isDirectory(fsImpl: any, target: string) {
  try {
    return fsImpl.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Resolve symlinks: ~/.hermes may link into an external data root.
function realpathOrSelf(fsImpl: any, target: string) {
  try {
    return fsImpl.realpathSync?.native?.(target) || fsImpl.realpathSync?.(target) || target;
  } catch {
    return target;
  }
}

// $HERMES_HOME wins only when it exists, so a stale value cannot shadow a real
// install. Default: %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere.
function globalHermesHome(options: PathDeps = {}) {
  const { platform, env, homedir, fsImpl } = deps(options);
  const injected = String(options.home || '').trim();
  if (injected) return injected;
  const configured = String(env.HERMES_HOME || '').trim();
  if (configured && isDirectory(fsImpl, configured)) {
    return realpathOrSelf(fsImpl, configured);
  }
  const fallback =
    platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'hermes')
      : path.join(homedir, '.hermes');
  return realpathOrSelf(fsImpl, fallback);
}

/** The hermes-agent checkout inside a Hermes home. */
function hermesAgentDir(home: string = '', options: PathDeps = {}) {
  return path.join(String(home || globalHermesHome(options)), 'hermes-agent');
}

/** Where the agent venv puts its executables. */
function hermesVenvBinDir(home: string = '', options: PathDeps = {}) {
  const { platform } = deps(options);
  return path.join(hermesAgentDir(home, options), 'venv', platform === 'win32' ? 'Scripts' : 'bin');
}

// `~/.local/bin` is POSIX-only; Windows has no equivalent.
function hermesCliSearchDirs(options: PathDeps = {}) {
  const { platform, homedir } = deps(options);
  const home = globalHermesHome(options);
  const dirs = [];
  if (platform !== 'win32') dirs.push(path.join(homedir, '.local', 'bin'));
  dirs.push(hermesVenvBinDir(home, options));
  return dirs;
}

// Probed when a PATH lookup misses. Windows venv launcher is hermes.exe.
function hermesCliCandidates(options: PathDeps = {}) {
  const { platform } = deps(options);
  const names = platform === 'win32' ? ['hermes.exe', 'hermes.cmd'] : ['hermes'];
  const candidates = [];
  for (const dir of hermesCliSearchDirs(options)) {
    for (const name of names) candidates.push(path.join(dir, name));
  }
  return candidates;
}

// electron-builder naming: archSuffix is EMPTY for the default arch (x64), so
// Intel mac is `mac`, not `mac-x64`; non-mac gets a `-unpacked` suffix.
function releaseDirNames(platform: NodeJS.Platform, arch: string) {
  const key = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
  const suffix = platform === 'darwin' ? '' : '-unpacked';
  const names = [`${key}${arch === 'x64' ? '' : `-${arch}`}${suffix}`];
  // Also probe the explicit `-x64` form, which some builds emit.
  if (arch === 'x64') names.push(`${key}-x64${suffix}`);
  return names;
}

// A "root" holds the Electron resources: the `.app` bundle on macOS, the
// unpacked dir ITSELF elsewhere — only macOS wraps builds in a bundle. Kept
// separate from installed roots because callers interleave a configured path.
function hermesDesktopSourceRoots(options: PathDeps = {}) {
  const { platform, arch } = deps(options);
  const releaseRoot = path.join(hermesAgentDir(globalHermesHome(options), options), 'apps', 'desktop', 'release');
  return [
    ...new Set(
      releaseDirNames(platform, arch).map((name) =>
        platform === 'darwin' ? path.join(releaseRoot, name, 'Hermes.app') : path.join(releaseRoot, name)
      )
    ),
  ];
}

/** Separately INSTALLED builds (from the signed installers), not source builds. */
function hermesDesktopInstalledRoots(options: PathDeps = {}) {
  const { platform, env } = deps(options);
  if (platform === 'darwin') return ['/Applications/Hermes.app'];
  if (platform !== 'win32') return ['/opt/Hermes'];
  const roots = [];
  const localAppData = env.LOCALAPPDATA || '';
  if (localAppData) roots.push(path.join(localAppData, 'Programs', 'Hermes'));
  // These differ only in casing on Windows; deduped below.
  for (const key of ['PROGRAMFILES', 'ProgramFiles', 'ProgramW6432']) {
    const dir = env[key];
    if (dir) roots.push(path.join(dir, 'Hermes'));
  }
  return [...new Set(roots)];
}

/** Every candidate root, source builds first. */
function hermesDesktopAppRoots(options: PathDeps = {}) {
  return [...new Set([...hermesDesktopSourceRoots(options), ...hermesDesktopInstalledRoots(options)])];
}

module.exports = {
  globalHermesHome,
  hermesAgentDir,
  hermesVenvBinDir,
  hermesCliSearchDirs,
  hermesCliCandidates,
  hermesDesktopSourceRoots,
  hermesDesktopInstalledRoots,
  hermesDesktopAppRoots,
};
