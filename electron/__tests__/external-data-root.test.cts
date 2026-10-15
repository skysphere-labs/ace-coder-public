import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  ACTIVATION_MARKER,
  defaultRootAvailable,
  resolveExternalDataRoot,
  resolveExternalDataRootForApp,
  selfActivatingCandidateRoot,
  buildExternalStorageEnv,
  externalArtifactRootForRepo,
  externalWorktreeRootForRepo,
  repoWorktreeKey,
  writeActivationFiles,
} = require('../external-data-root.cts');
const { ensureBaseHermesHome } = require('../hermes-home.cts');
const migration = require('../../scripts/migrate-ace-external-data.cts');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ace-${name}-`));
}

// On the owner's machine a real canonical SSD data root may be mounted with an
// enabled .ace-external-data-ready.json marker, which legitimately
// self-activates. Detect that once so the fork-safe negative assertions only
// run on machines where no canonical owner root self-activates (generic/CI).
const CANONICAL_SELF_ACTIVATES = selfActivatingCandidateRoot({}) !== null;

test('default external root is only active when explicitly enabled', () => {
  const root = path.join(tmpRoot('external-default'), 'AceData');
  const source = path.join(tmpRoot('user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });

  const inactive = resolveExternalDataRoot({
    currentUserDataPath: source,
    defaultRoot: root,
    env: {},
  });
  expect(inactive.root).toBe(root);
  expect(inactive.active).toBe(false);
  expect(inactive.reason).toBe('not-activated');

  const active = resolveExternalDataRoot({
    currentUserDataPath: source,
    defaultRoot: root,
    env: { ACE_USE_EXTERNAL_DATA_ROOT: '1' },
  });
  expect(active.active).toBe(true);
  expect(active.userDataPath).toBe(root);
});

test('default external root is unavailable when its mount parent is missing', () => {
  const parent = path.join(tmpRoot('missing-parent'), 'missing');
  const root = path.join(parent, 'AceData');
  const resolved = resolveExternalDataRoot({
    currentUserDataPath: tmpRoot('user-data'),
    defaultRoot: root,
    env: { ACE_USE_EXTERNAL_DATA_ROOT: '1' },
  });
  if (CANONICAL_SELF_ACTIVATES) {
    // A live owner SSD self-activates as the canonical fallthrough once the
    // (missing-parent) default is unavailable; only assert it is not the
    // missing default that activated.
    expect(resolved.root).not.toBe(root);
    return;
  }
  expect(resolved.active).toBe(false);
  expect(resolved.root).toBe(null);
  expect(resolved.reason).toBe('mount-missing');
});

test('activation files enable the external root on the next launch', () => {
  const source = tmpRoot('legacy-user-data');
  const root = path.join(tmpRoot('external-ready'), 'AceData');
  writeActivationFiles({ root, legacyUserDataPath: source, sourceUserDataPath: source });

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: {},
  });
  expect(resolved.active).toBe(true);
  expect(resolved.userDataPath).toBe(root);
});

test('shipped builds have no built-in default root and resolve without throwing', () => {
  const source = path.join(tmpRoot('null-default-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });

  const resolved = resolveExternalDataRoot({ currentUserDataPath: source, env: {} });
  // The built-in default is always null/unavailable; these hold on every machine.
  expect(resolved.configuredRoot).toBe(null);
  expect(resolved.defaultRoot).toBe(null);
  expect(resolved.defaultAvailable).toEqual({ ok: false, reason: 'no-default' });
  expect(defaultRootAvailable(null)).toEqual({ ok: false, reason: 'no-default' });
  expect(defaultRootAvailable()).toEqual({ ok: false, reason: 'no-default' });

  if (!CANONICAL_SELF_ACTIVATES) {
    // Generic/CI machines: with no env, config, default, or candidate the
    // resolver stays inactive and falls back to local userData.
    expect(resolved.active).toBe(false);
    expect(resolved.root).toBe(null);
    expect(resolved.reason).toBe('no-default');
    expect(resolved.userDataPath).toBe(source);
  }
});

test('configured env root that is unavailable reports config-root-unavailable', () => {
  const source = path.join(tmpRoot('env-unavailable-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const missing = path.join(tmpRoot('env-unavailable-parent'), 'missing', 'AceData');

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT: missing },
  });
  expect(resolved.active).toBe(false);
  expect(resolved.reason).toBe('config-root-unavailable');
  expect(resolved.configuredRoot).toBe(missing);
  expect(resolved.source).toBe('env:ACE_DATA_ROOT');
  expect(resolved.writable.reason).toBe('parent-missing');
  // Fallback behavior is unchanged: local userData still wins.
  expect(resolved.userDataPath).toBe(source);
});

test('config-file root that is unavailable reports config-root-unavailable', () => {
  const source = path.join(tmpRoot('config-unavailable-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const missing = path.join(tmpRoot('config-unavailable-parent'), 'missing', 'AceData');
  fs.writeFileSync(
    path.join(source, 'external-data-root.json'),
    JSON.stringify({ enabled: true, root: missing }, null, 2) + '\n'
  );

  const resolved = resolveExternalDataRoot({ currentUserDataPath: source, env: {} });
  expect(resolved.active).toBe(false);
  expect(resolved.reason).toBe('config-root-unavailable');
  expect(resolved.configuredRoot).toBe(missing);
  expect(resolved.source).toBe('config');
  expect(resolved.writable.reason).toBe('parent-missing');
  expect(resolved.userDataPath).toBe(source);
});

test('env-provided root still activates without a built-in default', () => {
  const source = path.join(tmpRoot('env-active-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const root = path.join(tmpRoot('env-active-external'), 'AceData');

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT: root },
  });
  expect(resolved.active).toBe(true);
  expect(resolved.userDataPath).toBe(root);
  expect(resolved.source).toBe('env:ACE_DATA_ROOT');
  expect(resolved.configuredRoot).toBe(root);
});

test('marker file still activates a resolvable root without the legacy config file', () => {
  const source = path.join(tmpRoot('marker-only-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const root = path.join(tmpRoot('marker-only-external'), 'AceData');
  // Marker only -- no legacy external-data-root.json in userData.
  writeActivationFiles({ root, sourceUserDataPath: source });

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    defaultRoot: root,
    env: {},
  });
  expect(resolved.active).toBe(true);
  expect(resolved.userDataPath).toBe(root);
  expect(resolved.source).toBe('default');
});

test('candidate root with an enabled marker self-activates without env or config', () => {
  const source = path.join(tmpRoot('candidate-active-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const candidate = path.join(tmpRoot('candidate-active-external'), 'AceData');
  // Marker only on the candidate -- no env var, no legacy config, no defaultRoot.
  writeActivationFiles({ root: candidate, sourceUserDataPath: source });

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT_CANDIDATES: candidate },
  });
  expect(resolved.active).toBe(true);
  expect(resolved.source).toBe('candidate');
  expect(resolved.root).toBe(candidate);
  expect(resolved.userDataPath).toBe(candidate);
});

test('development app boot does not auto-claim a production marker candidate', () => {
  const source = path.join(tmpRoot('dev-candidate-isolation-user-data'), 'Ace-Dev');
  fs.mkdirSync(source, { recursive: true });
  const candidate = path.join(tmpRoot('dev-candidate-isolation-external'), 'AceData');
  writeActivationFiles({ root: candidate, sourceUserDataPath: source });

  const resolved = resolveExternalDataRootForApp({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT_CANDIDATES: candidate },
    isDev: true,
    branchProof: false,
  });

  expect(resolved.active).toBe(false);
  expect(resolved.root).toBe(null);
  expect(resolved.userDataPath).toBe(source);
});

test('development app boot can explicitly opt into a marked external candidate', () => {
  const source = path.join(tmpRoot('dev-candidate-opt-in-user-data'), 'Ace-Dev');
  fs.mkdirSync(source, { recursive: true });
  const candidate = path.join(tmpRoot('dev-candidate-opt-in-external'), 'AceData');
  writeActivationFiles({ root: candidate, sourceUserDataPath: source });

  const resolved = resolveExternalDataRootForApp({
    currentUserDataPath: source,
    env: {
      ACE_DATA_ROOT_CANDIDATES: candidate,
      ACE_USE_EXTERNAL_DATA_ROOT: '1',
    },
    isDev: true,
    branchProof: false,
  });

  expect(resolved.active).toBe(true);
  expect(resolved.source).toBe('candidate');
  expect(resolved.root).toBe(candidate);
});

test('branch-proof app boot always stays isolated from external data roots', () => {
  const source = path.join(tmpRoot('branch-proof-isolation-user-data'), 'Ace-BranchProof');
  fs.mkdirSync(source, { recursive: true });
  const explicitRoot = path.join(tmpRoot('branch-proof-isolation-external'), 'AceData');

  const resolved = resolveExternalDataRootForApp({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT: explicitRoot, ACE_USE_EXTERNAL_DATA_ROOT: '1' },
    isDev: false,
    branchProof: true,
  });

  expect(resolved.active).toBe(false);
  expect(resolved.root).toBe(null);
  expect(resolved.reason).toBe('disabled');
  expect(resolved.userDataPath).toBe(source);
});

test('candidate root without a marker stays inactive', () => {
  const source = path.join(tmpRoot('candidate-nomarker-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  // Candidate dir exists and is writable, but carries no activation marker.
  const candidate = path.join(tmpRoot('candidate-nomarker-external'), 'AceData');
  fs.mkdirSync(candidate, { recursive: true });

  if (CANONICAL_SELF_ACTIVATES) {
    // A live owner SSD self-activates as the canonical fallthrough; the only
    // guarantee here is that the unmarked candidate is NOT what activated.
    expect(selfActivatingCandidateRoot({ ACE_DATA_ROOT_CANDIDATES: candidate })).not.toBe(
      candidate
    );
    return;
  }
  expect(selfActivatingCandidateRoot({ ACE_DATA_ROOT_CANDIDATES: candidate })).toBe(null);

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT_CANDIDATES: candidate },
  });
  expect(resolved.active).toBe(false);
  expect(resolved.root).toBe(null);
  expect(resolved.source).toBe(null);
  expect(resolved.userDataPath).toBe(source);
});

// ZERO-LEGACY-POINTER GUARD: self-activation must only ever honor the Ace
// marker. A legacy ace-coder-era marker (.ace-coder-external-data-ready.json)
// left behind on an old volume must never re-root a build that lost its
// userData config pin — otherwise the app silently reactivates onto the
// retired data root. If legacy-marker reads are ever added back to the
// resolver, they must stay out of the self-activation scan for this test to
// keep passing.
test('legacy ace-coder marker never self-activates a candidate root', () => {
  const candidate = path.join(tmpRoot('legacy-marker-external'), 'LegacyData');
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(
    path.join(candidate, '.ace-coder-external-data-ready.json'),
    JSON.stringify({ enabled: true, root: candidate }, null, 2) + '\n'
  );

  if (CANONICAL_SELF_ACTIVATES) {
    // A live owner SSD legitimately self-activates as the fallthrough; the
    // guarantee under test is that the legacy-marked candidate is NOT it.
    expect(selfActivatingCandidateRoot({ ACE_DATA_ROOT_CANDIDATES: candidate })).not.toBe(
      candidate
    );
  } else {
    expect(selfActivatingCandidateRoot({ ACE_DATA_ROOT_CANDIDATES: candidate })).toBe(null);
  }

  // The identical root with the real Ace marker self-activates, proving the
  // negative above hinges on the marker name and nothing else.
  writeActivationFiles({ root: candidate });
  expect(selfActivatingCandidateRoot({ ACE_DATA_ROOT_CANDIDATES: candidate })).toBe(candidate);
});

test('activation marker filename is pinned to the ace name', () => {
  expect(ACTIVATION_MARKER).toBe('.ace-external-data-ready.json');
});

test('explicit env root still wins over a self-activating candidate', () => {
  const source = path.join(tmpRoot('candidate-vs-env-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const candidate = path.join(tmpRoot('candidate-vs-env-candidate'), 'AceData');
  writeActivationFiles({ root: candidate, sourceUserDataPath: source });
  const envRoot = path.join(tmpRoot('candidate-vs-env-explicit'), 'AceData');

  const resolved = resolveExternalDataRoot({
    currentUserDataPath: source,
    env: { ACE_DATA_ROOT: envRoot, ACE_DATA_ROOT_CANDIDATES: candidate },
  });
  expect(resolved.active).toBe(true);
  expect(resolved.source).toBe('env:ACE_DATA_ROOT');
  expect(resolved.root).toBe(envRoot);
  expect(resolved.userDataPath).toBe(envRoot);
});

test('no candidate present keeps the resolver inactive (fork-safe)', () => {
  const source = path.join(tmpRoot('candidate-none-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });

  if (CANONICAL_SELF_ACTIVATES) {
    // Live owner SSD: canonical self-activation is the intended behavior here,
    // so the strict fork-safe inactive assertions only run on generic machines.
    return;
  }
  expect(selfActivatingCandidateRoot({})).toBe(null);

  const resolved = resolveExternalDataRoot({ currentUserDataPath: source, env: {} });
  expect(resolved.active).toBe(false);
  expect(resolved.root).toBe(null);
  expect(resolved.source).toBe(null);
});

test('external worktree root is stable and outside the repository when active', () => {
  const source = tmpRoot('legacy-user-data');
  const root = path.join(tmpRoot('external-worktrees'), 'AceData');
  const repo = path.join(tmpRoot('repo-parent'), 'Ace');
  fs.mkdirSync(repo, { recursive: true });

  const worktreeRoot = externalWorktreeRootForRepo(repo, source, {
    root,
    env: { ACE_EXTERNAL_DATA_ROOT: root },
  });
  expect(worktreeRoot).toBe(path.join(root, 'worktrees', repoWorktreeKey(repo)));
  expect(worktreeRoot.startsWith(path.join(repo, '.ace'))).toBe(false);
});

test('external artifact root for a repo is stable and outside the repository when active', () => {
  const source = tmpRoot('artifact-user-data');
  const root = path.join(tmpRoot('external-artifacts'), 'AceData');
  const repo = path.join(tmpRoot('artifact-repo-parent'), 'Ace');
  fs.mkdirSync(repo, { recursive: true });

  const artifactRoot = externalArtifactRootForRepo(repo, source, {
    root,
    env: { ACE_EXTERNAL_DATA_ROOT: root },
  });
  expect(artifactRoot).toBe(path.join(root, 'agent-artifacts', repoWorktreeKey(repo)));
  expect(artifactRoot.startsWith(path.join(repo, '.ace'))).toBe(false);
});

test('external artifact root falls back to the repository when inactive', () => {
  const source = path.join(tmpRoot('inactive-artifact-user-data'), 'Ace');
  const repo = path.join(tmpRoot('inactive-artifact-repo-parent'), 'Ace');
  const root = path.join(tmpRoot('inactive-artifact-external'), 'AceData');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  const artifactRoot = externalArtifactRootForRepo(repo, source, {
    defaultRoot: root,
    env: {},
  });
  expect(artifactRoot).toBe(path.resolve(repo));
});

test('external storage env routes cache download model temp and artifact dirs', () => {
  const root = path.join(tmpRoot('storage-env'), 'AceData');
  const env = buildExternalStorageEnv(root);
  expect(env.ACE_HOME).toBe(path.join(root, '.ace'));
  expect(env.ACE_ARTIFACT_ROOT).toBe(path.join(root, 'agent-artifacts'));
  expect(env.TMPDIR).toBe(path.join(root, 'tmp'));
  expect(env.npm_config_cache).toBe(path.join(root, 'caches', 'package-managers', 'npm'));
  expect(env.PNPM_STORE_PATH).toBe(path.join(root, 'caches', 'package-managers', 'pnpm-store'));
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(path.join(root, 'downloads', 'playwright-browsers'));
  expect(env.HF_HOME).toBe(path.join(root, 'model-assets'));
  expect(env.HUGGINGFACE_HUB_CACHE).toBe(path.join(root, 'model-assets', 'huggingface', 'hub'));
  expect(fs.statSync(env.ACE_ARTIFACT_ROOT).isDirectory()).toBe(true);
  expect(fs.statSync(env.PLAYWRIGHT_BROWSERS_PATH).isDirectory()).toBe(true);
});

test('external worktree root falls back to a single userData location when inactive', () => {
  const source = path.join(tmpRoot('inactive-user-data'), 'Ace');
  fs.mkdirSync(source, { recursive: true });
  const root = path.join(tmpRoot('inactive-external'), 'AceData');
  const repo = path.join(tmpRoot('inactive-repo-parent'), 'Ace');
  fs.mkdirSync(repo, { recursive: true });

  // External root resolves but is NOT activated -> inactive fallback.
  const worktreeRoot = externalWorktreeRootForRepo(repo, source, {
    defaultRoot: root,
    env: {},
  });
  expect(worktreeRoot).toBe(path.join(source, 'worktrees', repoWorktreeKey(repo)));
  // No longer scattered into the repo's own .ace/worktrees dir.
  expect(worktreeRoot.startsWith(path.join(repo, '.ace'))).toBe(false);
});

test('migration plan is dry-run by default and does not schedule deletes or relaunches', () => {
  const source = tmpRoot('migration-source');
  const dest = path.join(tmpRoot('migration-dest'), 'AceData');

  const plan = migration.buildPlan({ source, dest });
  expect(plan.mode).toBe('dry-run');
  expect(plan.operations.copyUserData).toBe(false);
  expect(plan.operations.deleteLocalData).toBe(false);
  expect(plan.operations.restartOrRelaunch).toBe(false);
  expect(fs.existsSync(dest)).toBe(false);
});

test('migration inventory includes sqlite integrity checks', () => {
  const source = tmpRoot('migration-integrity-source');
  const dest = path.join(tmpRoot('migration-integrity-dest'), 'AceData');
  const dbPath = path.join(source, 'ace.db');
  fs.writeFileSync(dbPath, 'sqlite fixture path only');
  const checked = [];

  const plan = migration.buildPlan({
    source,
    dest,
    legacyMemoryRoot: path.join(source, 'missing-memory'),
    sqliteIntegrity: (filePath) => {
      checked.push(filePath);
      return { path: filePath, ok: true, result: 'ok' };
    },
  });
  expect(plan.inventory.aceDb).toBe(dbPath);
  expect(checked).toContain(dbPath);
  expect(plan.integrity.some((row) => row.path === dbPath && row.ok && row.result === 'ok')).toBe(true);
  expect(plan.operations.sqliteIntegrity).toBe(true);
});

test('migration discovery is uncapped for checksums, sqlite inventory, and active handles', () => {
  const source = tmpRoot('migration-uncapped-source');
  const dest = path.join(tmpRoot('migration-uncapped-dest'), 'AceData');
  const sessions = path.join(source, 'hermes-home', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 525; i += 1) {
    fs.writeFileSync(path.join(sessions, `session-${i}.json`), '{}');
  }
  const dbPath = path.join(sessions, 'memory_store.db');
  fs.writeFileSync(dbPath, 'sqlite fixture path only');
  const checked = [];

  const plan = migration.buildPlan({
    source,
    dest,
    legacyMemoryRoot: path.join(source, 'missing-memory'),
    sqliteIntegrity: (filePath) => {
      checked.push(filePath);
      return { path: filePath, ok: true, result: 'ok' };
    },
    // Stub the real `lsof` here: over this 526-path sensitive set it is a
    // blocking spawnSync whose system-wide fd enumeration is unbounded under
    // self-hosted runner load (seen at 33s), which cannot be interrupted by the
    // 5s test timeout and caused this test to flake. This test asserts uncapped
    // DISCOVERY, not active-handle detection (covered by the dedicated lsof
    // tests below), so the real spawn is incidental here.
    lsofOpenFiles: () => ({ ok: true, open: [] }),
  });

  expect(plan.sensitivePaths).toContain(dbPath);
  expect(checked).toContain(dbPath);
  expect(migration.listFilesUnder(source).length).toBe(526);
});

test('nested agent lane hermes homes are included in active-handle sensitive paths', () => {
  const source = tmpRoot('migration-lane-home-source');
  const dest = path.join(tmpRoot('migration-lane-home-dest'), 'AceData');
  const laneHome = path.join(source, 'hermes-lanes', 'lane-abc', 'home');
  const stateDb = path.join(laneHome, 'state.db');
  const sessionFile = path.join(laneHome, 'sessions', 'session.jsonl');
  const memoryFile = path.join(laneHome, 'memories', 'memory.json');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(stateDb, 'lane state fixture');
  fs.writeFileSync(sessionFile, 'lane session fixture');
  fs.writeFileSync(memoryFile, 'lane memory fixture');

  const fd = fs.openSync(stateDb, 'r');
  try {
    const plan = migration.buildPlan({
      source,
      dest,
      apply: true,
      legacyMemoryRoot: path.join(source, 'missing-memory'),
      sqliteIntegrity: (filePath) => ({ path: filePath, ok: true, result: 'ok' }),
    });
    const realStateDb = fs.realpathSync(stateDb);

    expect(plan.inventory.hermesHomes).toContain(laneHome);
    expect(plan.sensitivePaths).toContain(stateDb);
    expect(plan.sensitivePaths).toContain(sessionFile);
    expect(plan.sensitivePaths).toContain(memoryFile);
    expect(plan.active.ok).toBe(true);
    expect(plan.active.open.some((row) => fs.realpathSync(row.path) === realStateDb)).toBe(true);
    expect(() => migration.applyPlan(plan, { confirmStopped: true })).toThrow(/active Ace files are open/);
    expect(fs.existsSync(dest)).toBe(false);
  } finally {
    fs.closeSync(fd);
  }
});

test('top-level workspace hermes homes are included in active-handle sensitive paths', () => {
  const source = tmpRoot('migration-workspace-home-source');
  const dest = path.join(tmpRoot('migration-workspace-home-dest'), 'AceData');
  const workspaceHome = path.join(source, 'hermes-home-prj-test');
  const stateDb = path.join(workspaceHome, 'state.db');
  const sessionFile = path.join(workspaceHome, 'sessions', 'session.jsonl');
  const memoryFile = path.join(workspaceHome, 'memories', 'memory.json');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(stateDb, 'workspace state fixture');
  fs.writeFileSync(sessionFile, 'workspace session fixture');
  fs.writeFileSync(memoryFile, 'workspace memory fixture');

  const fd = fs.openSync(stateDb, 'r');
  try {
    const plan = migration.buildPlan({
      source,
      dest,
      apply: true,
      legacyMemoryRoot: path.join(source, 'missing-memory'),
      sqliteIntegrity: (filePath) => ({ path: filePath, ok: true, result: 'ok' }),
    });
    const realStateDb = fs.realpathSync(stateDb);

    expect(plan.inventory.hermesHomes).toContain(workspaceHome);
    expect(plan.sensitivePaths).toContain(stateDb);
    expect(plan.sensitivePaths).toContain(sessionFile);
    expect(plan.sensitivePaths).toContain(memoryFile);
    expect(plan.active.ok).toBe(true);
    expect(plan.active.open.some((row) => fs.realpathSync(row.path) === realStateDb)).toBe(true);
    expect(() => migration.applyPlan(plan, { confirmStopped: true })).toThrow(/active Ace files are open/);
    expect(fs.existsSync(dest)).toBe(false);
  } finally {
    fs.closeSync(fd);
  }
});

test('unsafe apply refuses without stopped-app confirmation', () => {
  const source = tmpRoot('migration-apply-source');
  const dest = path.join(tmpRoot('migration-apply-dest'), 'AceData');
  const plan = migration.buildPlan({ source, dest, legacyMemoryRoot: path.join(source, 'missing-memory') });
  expect(() => migration.applyPlan(plan, {})).toThrow(/confirm-stopped/);
});

test('apply fails closed when sensitive traversal exceeds the safety cap', () => {
  const source = tmpRoot('migration-truncated-source');
  const dest = path.join(tmpRoot('migration-truncated-dest'), 'AceData');
  const sessions = path.join(source, 'hermes-home', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'one.jsonl'), 'one');
  fs.writeFileSync(path.join(sessions, 'two.jsonl'), 'two');

  const plan = migration.buildPlan({
    source,
    dest,
    apply: true,
    legacyMemoryRoot: path.join(source, 'missing-memory'),
    traversalLimits: { sensitivePaths: 1 },
  });

  expect(plan.safetyEvidence.complete).toBe(false);
  expect(plan.safetyEvidence.issues.some((issue) => issue.type === 'truncated')).toBe(true);
  expect(() => migration.applyPlan(plan, { confirmStopped: true })).toThrow(/incomplete migration safety evidence/);
  expect(fs.existsSync(dest)).toBe(false);
});

test('apply fails closed when traversal encounters an unreadable subtree', () => {
  const source = tmpRoot('migration-unreadable-source');
  const dest = path.join(tmpRoot('migration-unreadable-dest'), 'AceData');
  const sessions = path.join(source, 'hermes-home', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'session.jsonl'), 'session');
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = ((target, options) => {
    if (path.resolve(String(target)) === path.resolve(sessions)) {
      throw new Error('blocked traversal fixture');
    }
    return originalReaddirSync.call(fs, target, options);
  });

  try {
    const plan = migration.buildPlan({
      source,
      dest,
      apply: true,
      legacyMemoryRoot: path.join(source, 'missing-memory'),
    });
    expect(plan.safetyEvidence.complete).toBe(false);
    expect(plan.safetyEvidence.issues.some((issue) => issue.type === 'unreadable')).toBe(true);
    expect(() => migration.applyPlan(plan, { confirmStopped: true })).toThrow(/incomplete migration safety evidence/);
    expect(fs.existsSync(dest)).toBe(false);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test('checksum manifest refuses to claim coverage when source traversal is partial', () => {
  const source = tmpRoot('migration-partial-manifest-source');
  const dest = path.join(tmpRoot('migration-partial-manifest-dest'), 'AceData');
  fs.writeFileSync(path.join(source, 'one.txt'), 'one');
  fs.writeFileSync(path.join(source, 'two.txt'), 'two');

  expect(() => migration.copyUserData(source, dest, { checksumLimit: 1 })).toThrow(/checksum discovery incomplete/);
  const parent = path.dirname(dest);
  const manifestPaths = migration
    .listFilesUnderWithEvidence(parent)
    .files.filter((filePath) => path.basename(filePath) === '.ace-migration-checksums.json');
  expect(manifestPaths).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
});

test('open file handles are visible to preflight lsof check', () => {
  const root = tmpRoot('migration-open-handle');
  const filePath = path.join(root, 'state.db');
  fs.writeFileSync(filePath, 'not sqlite');
  const fd = fs.openSync(filePath, 'r');
  try {
    const active = migration.lsofOpenFiles([filePath]);
    const realFilePath = fs.realpathSync(filePath);
    expect(active.ok).toBe(true);
    expect(active.open.some((row) => fs.realpathSync(row.path) === realFilePath)).toBe(true);
  } finally {
    fs.closeSync(fd);
  }
});

test('lsof spawn errors fail closed and apply refuses', () => {
  const source = tmpRoot('migration-lsof-error-source');
  const dest = path.join(tmpRoot('migration-lsof-error-dest'), 'AceData');
  const dbPath = path.join(source, 'ace.db');
  fs.writeFileSync(dbPath, 'not sqlite');
  const active = migration.lsofOpenFiles([dbPath], {
    spawnSync: () => ({ error: Object.assign(new Error('argument list too long'), { code: 'E2BIG' }) }),
  });
  const plan = migration.buildPlan({
    source,
    dest,
    apply: true,
    legacyMemoryRoot: path.join(source, 'missing-memory'),
    sqliteIntegrity: (filePath) => ({ path: filePath, ok: true, result: 'ok' }),
    lsofOpenFiles: () => active,
  });

  expect(active.ok).toBe(false);
  expect(plan.active.ok).toBe(false);
  expect(active.error).toBe('lsof-spawn-failed');
  expect(active.code).toBe('E2BIG');
  expect(() => migration.applyPlan(plan, { confirmStopped: true })).toThrow(/cannot prove Ace is stopped/);
  expect(fs.existsSync(dest)).toBe(false);
});

test('lsof active checks chunk large path lists into bounded calls', () => {
  const calls = [];
  const paths = Array.from({ length: 7 }, (_, i) => `/tmp/ace-sensitive-${i}.db`);
  const ok = migration.lsofOpenFiles(paths, {
    chunkSize: 3,
    spawnSync: (_cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: '' };
    },
  });
  expect(ok.ok).toBe(true);
  expect(ok.chunks).toBe(3);
  expect(calls).toHaveLength(3);
  expect(calls.every((args) => args.slice(0, 3).join(' ') === '-F pn --')).toBe(true);
  expect(calls.every((args) => args.length <= 6)).toBe(true);
});

test('temp resume hermes base is repaired with shared entries but local state stays local', () => {
  const sharedUserData = tmpRoot('shared-hermes');
  const tempUserData = tmpRoot('temp-hermes');
  const sharedBase = path.join(sharedUserData, 'hermes-home');
  fs.mkdirSync(path.join(sharedBase, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(sharedBase, 'auth.json'), '{}');
  fs.writeFileSync(path.join(sharedBase, 'config.yaml'), 'terminal:\n  cwd: /shared\n');

  const repaired = ensureBaseHermesHome(tempUserData, { sharedUserDataPath: sharedUserData });
  expect(fs.lstatSync(path.join(repaired, 'auth.json')).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(path.join(repaired, 'config.yaml')).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(repaired, 'sessions'))).toBe(true);
  expect(fs.lstatSync(path.join(repaired, 'sessions')).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(repaired, 'state.db'))).toBe(false);
});

// --- control-socket reachability for headless agents (completes PR #317) ---
// The PTY stream path pins ACE_SOCK per stream; headless agents spawned via
// agent-cli-driver instead resolve the socket from process.env. If the main
// process does not pin ACE_SOCK / ACE_USER_DATA_TAG on its own env,
// resolveAceSockForSpawn() returns null and the spawned `ace` CLI
// re-derives a socket path from its own TMPDIR -> SOCKET_UNREACHABLE
// ("rook/king not connected").
const { resolveAceSockForSpawn } = require('../agent-cli-driver.cts');
const { socketPath: aceSocketPath } = require('../ace-control/socket-bridge.cts');

function withAceSockEnv(next, fn) {
  const keys = ['ACE_SOCK', 'ACE_USER_DATA_TAG'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      if (next[k] === undefined) delete process.env[k];
      else process.env[k] = next[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('resolveAceSockForSpawn prefers an explicit ACE_SOCK', () => {
  withAceSockEnv({ ACE_SOCK: '/tmp/explicit.sock', ACE_USER_DATA_TAG: 'Ignored' }, () => {
    expect(resolveAceSockForSpawn()).toBe('/tmp/explicit.sock');
  });
});

test('resolveAceSockForSpawn derives the socket from ACE_USER_DATA_TAG', () => {
  withAceSockEnv({ ACE_SOCK: undefined, ACE_USER_DATA_TAG: 'Ace' }, () => {
    expect(resolveAceSockForSpawn()).toBe(aceSocketPath('Ace'));
  });
});

test('resolveAceSockForSpawn returns null when the env has no socket coordinates', () => {
  withAceSockEnv({ ACE_SOCK: undefined, ACE_USER_DATA_TAG: undefined }, () => {
    expect(resolveAceSockForSpawn()).toBeNull();
  });
});

test('main.cts pins ACE_SOCK + ACE_USER_DATA_TAG on its own env after userData is final', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../main.cts'), 'utf8');
  // The socketPath helper must be imported so the headless socket can be derived.
  expect(mainSource).toMatch(/socketPath:\s*aceSocketPath\s*}\s*=\s*require\(['"]\.\/ace-control\/socket-bridge\.cjs['"]\)/);
  // Both coordinates must be assigned from the resolved userData path.
  expect(mainSource).toMatch(/process\.env\.ACE_USER_DATA_TAG\s*=\s*path\.basename\(/);
  expect(mainSource).toMatch(/process\.env\.ACE_SOCK\s*=\s*aceSocketPath\(/);
});

test('main.cts resolves every app data-root probe through the dev-isolation policy', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../main.cts'), 'utf8');
  expect(mainSource).toMatch(/resolveExternalDataRootForApp/);
  expect(mainSource).not.toMatch(/\bresolveExternalDataRoot\s*\(/);
  expect(mainSource.match(/resolveAppExternalDataRoot\s*\(/g)?.length).toBeGreaterThanOrEqual(3);
});
