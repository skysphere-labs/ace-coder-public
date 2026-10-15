const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Shipped builds have NO built-in external data root. Activation happens only
// via options.root, ACE_DATA_ROOT / ACE_EXTERNAL_DATA_ROOT env, the
// external-data-root.json config file in userData, or the activation marker.
const DEFAULT_EXTERNAL_DATA_ROOT: string | null = null;
const ACTIVATION_MARKER = '.ace-external-data-ready.json';
const CONFIG_FILE = 'external-data-root.json';
// macOS mounts external volumes under /Volumes. A self-activating data root is
// any directory on a mounted volume that already carries an ENABLED Ace
// activation marker (written by a prior real activation). Generic + fork-safe: a
// machine that never activated a Ace SSD has no such marker, so discovery
// returns null. No owner-specific path is hardcoded (de-personalized), and it
// needs no env var or config file.
const EXTERNAL_MOUNT_PARENTS = ['/Volumes'];
const ROUTED_ENV_DIRS = {
  aceHome: '.ace',
  tmp: 'tmp',
  xdgCache: 'caches/xdg',
  npmCache: 'caches/package-managers/npm',
  pnpmStore: 'caches/package-managers/pnpm-store',
  yarnCache: 'caches/package-managers/yarn',
  bunCache: 'caches/package-managers/bun',
  pipCache: 'caches/package-managers/pip',
  uvCache: 'caches/package-managers/uv',
  cargoHome: 'caches/package-managers/cargo',
  electronCache: 'caches/electron',
  electronBuilderCache: 'caches/electron-builder',
  playwrightBrowsers: 'downloads/playwright-browsers',
  cypressCache: 'downloads/cypress',
  modelAssets: 'model-assets',
  huggingFaceHub: 'model-assets/huggingface/hub',
  torchHome: 'model-assets/torch',
  agentArtifacts: 'agent-artifacts',
};

function normalizeRoot(raw: any) {
  const value = String(raw || '').trim();
  if (!value) return null;
  return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function existsDir(filePath: any) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function writableDirOrCreatable(root: any) {
  const parent = path.dirname(root);
  if (!existsDir(root) && !existsDir(parent)) {
    return { ok: false, reason: 'parent-missing' };
  }
  try {
    fs.accessSync(existsDir(root) ? root : parent, fs.constants.W_OK);
    return { ok: true, reason: existsDir(root) ? 'root-writable' : 'parent-writable' };
  } catch {
    return { ok: false, reason: 'not-writable' };
  }
}

function readJsonIfPresent(filePath: any) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function legacyConfigPath(currentUserDataPath: any) {
  return path.join(currentUserDataPath, CONFIG_FILE);
}

function markerPath(root: any) {
  return path.join(root, ACTIVATION_MARKER);
}

function readActivationMarker(root: any) {
  return readJsonIfPresent(markerPath(root));
}

// Marker-gated self-activation: pick the first mounted candidate root that
// already carries an enabled activation marker. Requires the mount (parent dir)
// to be present and the root writable/creatable so an unplugged SSD never
// activates.
function markedRoot(candidate: any) {
  const root = normalizeRoot(candidate);
  if (!root) return null;
  if (!existsDir(path.dirname(root))) return null;
  if (!writableDirOrCreatable(root).ok) return null;
  if (readActivationMarker(root)?.enabled === true) return root;
  return null;
}

function listSubdirs(dir: any) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry: any) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Resolve a data root to self-activate when no explicit/config/default root is
// set: first any ACE_DATA_ROOT_CANDIDATES (path.delimiter-separated), then a
// generic scan of mounted external volumes for a directory (the volume itself or
// an immediate child) carrying an enabled marker. Marker-gated, so generic
// machines with no prior activation discover nothing.
function selfActivatingCandidateRoot(rawEnv: any = process.env) {
  const env = rawEnv;
  const envCandidates = String(env.ACE_DATA_ROOT_CANDIDATES || '')
    .split(path.delimiter)
    .map((value: string) => value.trim())
    .filter(Boolean);
  for (const raw of envCandidates) {
    const hit = markedRoot(raw);
    if (hit) return hit;
  }
  for (const parent of EXTERNAL_MOUNT_PARENTS) {
    if (!existsDir(parent)) continue;
    for (const volume of listSubdirs(parent)) {
      const atVolume = markedRoot(volume);
      if (atVolume) return atVolume;
      for (const child of listSubdirs(volume)) {
        const hit = markedRoot(child);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function defaultRootAvailable(defaultRoot: string | null = DEFAULT_EXTERNAL_DATA_ROOT) {
  if (!defaultRoot) return { ok: false, reason: 'no-default' };
  const mountRoot = path.dirname(defaultRoot);
  if (!existsDir(mountRoot)) return { ok: false, reason: 'mount-missing' };
  return writableDirOrCreatable(defaultRoot);
}

function resolveExternalDataRoot(options: any = {}) {
  const env = options.env || process.env;
  const currentUserDataPath = options.currentUserDataPath || '';
  const defaultRoot = normalizeRoot(options.defaultRoot || DEFAULT_EXTERNAL_DATA_ROOT);
  const disabled = env.ACE_DISABLE_EXTERNAL_DATA_ROOT === '1';
  const config = currentUserDataPath
    ? readJsonIfPresent(legacyConfigPath(currentUserDataPath))
    : null;
  const explicitRoot = normalizeRoot(
    options.root ||
      env.ACE_DATA_ROOT ||
      env.ACE_EXTERNAL_DATA_ROOT ||
      config?.root
  );
  const defaultAvailable = defaultRootAvailable(defaultRoot);
  const defaultResolvedRoot = explicitRoot || (defaultAvailable.ok ? defaultRoot : null);
  // No explicit root and no available built-in default: try marker-gated
  // self-activation so a mounted owner SSD activates with no env/config. Generic
  // machines have no such candidate and keep root === null (inactive).
  const allowCandidateDiscovery = options.allowCandidateDiscovery !== false;
  const candidate = allowCandidateDiscovery && !explicitRoot && !defaultResolvedRoot
    ? selfActivatingCandidateRoot(env)
    : null;
  const root = defaultResolvedRoot || candidate;
  const source = explicitRoot
    ? (options.root ? 'option' : env.ACE_DATA_ROOT ? 'env:ACE_DATA_ROOT' : env.ACE_EXTERNAL_DATA_ROOT ? 'env:ACE_EXTERNAL_DATA_ROOT' : 'config')
    : defaultResolvedRoot
      ? 'default'
      : candidate
        ? 'candidate'
        : null;

  if (disabled) {
    return {
      active: false,
      root: null,
      userDataPath: currentUserDataPath || null,
      source: 'disabled',
      reason: 'disabled',
      configuredRoot: explicitRoot || null,
      defaultRoot,
      defaultAvailable,
      config,
    };
  }
  if (!root) {
    return {
      active: false,
      root: null,
      userDataPath: currentUserDataPath || null,
      source: null,
      reason: defaultAvailable.reason,
      configuredRoot: explicitRoot || null,
      defaultRoot,
      defaultAvailable,
      config,
    };
  }

  const writable = writableDirOrCreatable(root);
  const marker = readActivationMarker(root);
  const envEnabled = env.ACE_USE_EXTERNAL_DATA_ROOT === '1';
  const configEnabled = config?.enabled === true;
  const markerEnabled = marker?.enabled === true;
  const explicitEnabled = Boolean(explicitRoot && (env.ACE_DATA_ROOT || env.ACE_EXTERNAL_DATA_ROOT || options.root));
  const active = writable.ok && (envEnabled || configEnabled || markerEnabled || explicitEnabled);
  return {
    active,
    root,
    userDataPath: active ? root : currentUserDataPath || null,
    source,
    // A root that was explicitly configured (option/env/config file) but is not
    // usable (mount/parent missing, unwritable) is loudly distinguishable from
    // the quiet not-activated state so the boot guard can surface it. Fallback
    // behavior is unchanged: callers still land on local userData.
    reason: active
      ? 'active'
      : writable.ok
        ? 'not-activated'
        : explicitRoot
          ? 'config-root-unavailable'
          : writable.reason,
    configuredRoot: explicitRoot || null,
    writable,
    defaultRoot,
    defaultAvailable,
    config,
    marker,
    configPath: currentUserDataPath ? legacyConfigPath(currentUserDataPath) : null,
    markerPath: markerPath(root),
  };
}

// App boot policy layered over the general resolver. Packaged production Ace
// may self-activate from the SSD marker, but an ordinary development instance
// must keep its APP_NAME-scoped userData unless the operator explicitly opts
// into external storage. Otherwise two `npm run dev` processes can silently
// converge on the production Chromium profile + ace.db and leave the installed
// app stuck on a blank renderer. Branch-proof builds are stricter: they never
// touch an external root, even when the parent shell carries an opt-in env.
function resolveExternalDataRootForApp(options: any = {}) {
  const env = options.env || process.env;
  if (options.branchProof === true) {
    return resolveExternalDataRoot({
      ...options,
      env: { ...env, ACE_DISABLE_EXTERNAL_DATA_ROOT: '1' },
      allowCandidateDiscovery: false,
    });
  }

  const explicitDevOptIn =
    env.ACE_USE_EXTERNAL_DATA_ROOT === '1' ||
    Boolean(env.ACE_DATA_ROOT) ||
    Boolean(env.ACE_EXTERNAL_DATA_ROOT);
  const allowCandidateDiscovery = options.isDev !== true || explicitDevOptIn;
  return resolveExternalDataRoot({
    ...options,
    env,
    allowCandidateDiscovery,
  });
}

function repoWorktreeKey(repoRoot: any) {
  const resolved = path.resolve(String(repoRoot || 'repo'));
  const name = path.basename(resolved).replace(/[^\w.-]/g, '_') || 'repo';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 10);
  return `${name}-${hash}`;
}

function externalWorktreeRootForRepo(repoRoot: any, userDataPath: any, options: any = {}) {
  const resolved = resolveExternalDataRoot({
    ...options,
    currentUserDataPath: userDataPath,
  });
  if (!resolved.active || !resolved.root) {
    // Inactive fallback: keep all worktrees under a single consistent
    // location keyed by repo, rather than scattering a `.ace/worktrees`
    // dir into every repo. Reuse the userDataPath passed by the caller.
    const base = userDataPath || path.join(repoRoot, '.ace');
    return path.join(base, 'worktrees', repoWorktreeKey(repoRoot));
  }
  return path.join(resolved.root, 'worktrees', repoWorktreeKey(repoRoot));
}

function externalArtifactRootForRepo(repoRoot: any, userDataPath: any, options: any = {}) {
  const resolvedRepo = path.resolve(String(repoRoot || '.'));
  const resolved = resolveExternalDataRoot({
    ...options,
    currentUserDataPath: userDataPath,
  });
  if (!resolved.active || !resolved.root) return resolvedRepo;
  return path.join(resolved.root, ROUTED_ENV_DIRS.agentArtifacts, repoWorktreeKey(resolvedRepo));
}

function externalStorageDirs(root: any) {
  const resolvedRoot = normalizeRoot(root);
  if (!resolvedRoot) return null;
  const dirs = Object.fromEntries(
    Object.entries(ROUTED_ENV_DIRS).map(([key, rel]) => [key, path.join(resolvedRoot, rel as string)])
  );
  return dirs;
}

function ensureExternalStorageDirs(root: any) {
  const dirs = externalStorageDirs(root);
  if (!dirs) return null;
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir as string, { recursive: true });
  }
  return dirs;
}

function buildExternalStorageEnv(root: any, options: any = {}) {
  const dirs = options.ensure === false ? externalStorageDirs(root) : ensureExternalStorageDirs(root);
  if (!dirs) return {};
  return {
    ACE_HOME: dirs.aceHome,
    ACE_ARTIFACT_ROOT: dirs.agentArtifacts,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CACHE_HOME: dirs.xdgCache,
    npm_config_cache: dirs.npmCache,
    NPM_CONFIG_CACHE: dirs.npmCache,
    npm_config_store_dir: dirs.pnpmStore,
    PNPM_STORE_PATH: dirs.pnpmStore,
    YARN_CACHE_FOLDER: dirs.yarnCache,
    BUN_INSTALL_CACHE_DIR: dirs.bunCache,
    PIP_CACHE_DIR: dirs.pipCache,
    UV_CACHE_DIR: dirs.uvCache,
    CARGO_HOME: dirs.cargoHome,
    ELECTRON_CACHE: dirs.electronCache,
    ELECTRON_BUILDER_CACHE: dirs.electronBuilderCache,
    PLAYWRIGHT_BROWSERS_PATH: dirs.playwrightBrowsers,
    CYPRESS_CACHE_FOLDER: dirs.cypressCache,
    HF_HOME: dirs.modelAssets,
    HUGGINGFACE_HUB_CACHE: dirs.huggingFaceHub,
    TRANSFORMERS_CACHE: dirs.huggingFaceHub,
    TORCH_HOME: dirs.torchHome,
  };
}

function externalStorageEnvForUserData(userDataPath: any, options: any = {}) {
  const resolved = resolveExternalDataRoot({
    ...options,
    currentUserDataPath: userDataPath,
  });
  if (!resolved.active || !resolved.root) return {};
  return buildExternalStorageEnv(resolved.root, options);
}

function writeActivationFiles({ root, legacyUserDataPath, sourceUserDataPath }: any) {
  const resolvedRoot = normalizeRoot(root);
  if (!resolvedRoot) throw new Error('external data root is required');
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const marker = {
    enabled: true,
    root: resolvedRoot,
    sourceUserDataPath: sourceUserDataPath || legacyUserDataPath || null,
    activatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath(resolvedRoot), JSON.stringify(marker, null, 2) + '\n');
  if (legacyUserDataPath) {
    fs.mkdirSync(legacyUserDataPath, { recursive: true });
    fs.writeFileSync(
      legacyConfigPath(legacyUserDataPath),
      JSON.stringify({ enabled: true, root: resolvedRoot }, null, 2) + '\n'
    );
  }
  return marker;
}

module.exports = {
  DEFAULT_EXTERNAL_DATA_ROOT,
  ACTIVATION_MARKER,
  CONFIG_FILE,
  defaultRootAvailable,
  selfActivatingCandidateRoot,
  resolveExternalDataRoot,
  resolveExternalDataRootForApp,
  externalWorktreeRootForRepo,
  externalArtifactRootForRepo,
  externalStorageDirs,
  ensureExternalStorageDirs,
  buildExternalStorageEnv,
  externalStorageEnvForUserData,
  repoWorktreeKey,
  writeActivationFiles,
  markerPath,
  legacyConfigPath,
};
