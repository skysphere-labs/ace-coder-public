const fs = require('fs');
const os = require('os');
const path = require('path');

function getBundledCliPath(app: any, name = 'ace') {
  if (app.isPackaged) {
    const resourcesPath = app.resourcesPath || process.resourcesPath;
    return path.join(
      resourcesPath,
      'app.asar.unpacked',
      'tools',
      'ace',
      'bin',
      name
    );
  }
  return path.join(app.getAppPath(), 'tools', 'ace', 'bin', name);
}

function getInstallPath(name = 'ace') {
  if (process.platform === 'win32') return null;
  return path.join(os.homedir(), '.local', 'bin', name);
}

function pathEntries() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

function ensureExecutable(filePath: string | null | undefined) {
  if (!filePath) return false;
  try {
    fs.chmodSync(filePath, 0o755);
    return true;
  } catch {
    return false;
  }
}

function getCliStatus(app: any) {
  const bundledPath = getBundledCliPath(app);
  const installPath = getInstallPath();
  const legacyBundledPath = getBundledCliPath(app, 'ace');
  const legacyInstallPath = getInstallPath('ace');
  const supported = process.platform !== 'win32';
  const bundledExists = (() => {
    try { return fs.existsSync(bundledPath); } catch { return false; }
  })();

  let installed = false;
  let installedPointsToBundle = false;
  let existingTarget: any = null;
  if (supported && installPath) {
    try {
      const linkStat = fs.lstatSync(installPath);
      if (linkStat.isSymbolicLink()) {
        const target = fs.readlinkSync(installPath);
        existingTarget = path.isAbsolute(target)
          ? target
          : path.resolve(path.dirname(installPath), target);
        installed = true;
        installedPointsToBundle = existingTarget === bundledPath;
      } else if (linkStat.isFile()) {
        installed = true;
        existingTarget = installPath;
        installedPointsToBundle = false;
      }
    } catch {
      // Not installed.
    }
  }

  // Does the user's (electron's) PATH include the install directory? If not,
  // installing a symlink there won't make `ace` resolvable from their
  // shell without a PATH update. enhanceShellPath() already adds ~/.local/bin
  // for our process; this check is a proxy for whether the user's shell
  // inherits it too.
  const installDir = installPath ? path.dirname(installPath) : null;
  const onPath = installDir ? pathEntries().includes(installDir) : false;

  return {
    platform: process.platform,
    supported,
    bundledPath,
    bundledExists,
    installPath,
    legacyBundledPath,
    legacyInstallPath,
    installDir,
    onPath,
    installed,
    installedPointsToBundle,
    existingTarget,
  };
}

function installCli(app: any, opts: any = {}) {
  const status = getCliStatus(app);
  if (!status.supported) {
    return { ok: false, error: 'Unsupported platform (Windows install not implemented yet).' };
  }
  if (!status.bundledExists) {
    return {
      ok: false,
      error: `Bundled CLI not found at ${status.bundledPath}. In dev, run from the repo root; in production, reinstall Ace.`,
    };
  }
  if (status.installed && !status.installedPointsToBundle && !opts.force) {
    return {
      ok: false,
      conflict: true,
      existingTarget: status.existingTarget,
      error: `${status.installPath} already exists and does not point to this Ace. Pass { force: true } to overwrite.`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(status.installPath), { recursive: true });
    try { fs.rmSync(status.installPath, { force: true }); } catch {}
    fs.symlinkSync(status.bundledPath, status.installPath);
    ensureExecutable(status.bundledPath);
    if (status.legacyBundledPath && status.legacyInstallPath && fs.existsSync(status.legacyBundledPath)) {
      try {
        fs.rmSync(status.legacyInstallPath, { force: true });
        fs.symlinkSync(status.legacyBundledPath, status.legacyInstallPath);
        ensureExecutable(status.legacyBundledPath);
      } catch {}
    }
    return {
      ok: true,
      installPath: status.installPath,
      bundledPath: status.bundledPath,
      legacyInstallPath: status.legacyInstallPath,
      legacyBundledPath: status.legacyBundledPath,
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// Re-point the ~/.local/bin/ace symlink at the CURRENT bundle's CLI. After
// an in-place update the bundle path can change (or the link can dangle), so on
// boot we rewrite the symlink to follow the running bundle. Reuses the same
// status resolution (getCliStatus) and symlink-writing path as installCli, so
// the legacy alias and chmod are handled identically. Idempotent + non-fatal:
// only acts when a bundled CLI exists and the install slot is either ours or
// absent; never overwrites a third-party link the user put there.
function repointAceCli(app: any, opts: any = {}) {
  try {
    const status = getCliStatus(app);
    if (!status.supported) return { ok: false, reason: 'unsupported-platform' };
    if (!status.bundledExists) return { ok: false, reason: 'bundled-cli-missing' };
    // Already pointing at this bundle — nothing to do.
    if (status.installed && status.installedPointsToBundle) {
      ensureExecutable(status.bundledPath);
      if (status.legacyBundledPath && fs.existsSync(status.legacyBundledPath)) {
        ensureExecutable(status.legacyBundledPath);
      }
      return { ok: true, target: status.bundledPath };
    }
    // A real (non-symlink) file or a link to a DIFFERENT Ace: leave it be,
    // matching installCli's no-force conflict behavior.
    if (status.installed && !status.installedPointsToBundle) {
      return { ok: false, reason: 'foreign-install', target: status.existingTarget };
    }
    // Not installed yet, or a dangling/stale symlink we own: (re)write it via
    // the shared install path so the legacy alias + chmod stay consistent.
    const result = installCli(app, { force: true });
    if (result && result.ok) return { ok: true, target: result.bundledPath };
    return { ok: false, reason: (result && result.error) || 'install-failed' };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

function uninstallCli(app: any) {
  const status = getCliStatus(app);
  if (!status.supported) return { ok: false, error: 'unsupported platform' };
  if (!status.installed) return { ok: true, notInstalled: true };
  if (!status.installedPointsToBundle) {
    return {
      ok: false,
      error: `${status.installPath} does not point to this Ace. Remove it manually.`,
      existingTarget: status.existingTarget,
    };
  }
  try {
    fs.rmSync(status.installPath, { force: true });
    if (status.legacyInstallPath) fs.rmSync(status.legacyInstallPath, { force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = { getCliStatus, installCli, uninstallCli, repointAceCli };
