const DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD = 5;
const DEFAULT_BASE_FETCH_TIMEOUT_MS = 4000;

// Refresh remote refs before branching, but never let a slow or offline
// `git fetch` block task creation when a previously-fetched remote ref is
// already on disk. Interactive creates get at most `timeoutMs` of network
// wait; past that the fetch keeps running in the background and warms refs
// for the next task while we branch from the cached remote ref. Only when
// no cached ref exists is the fetch result required.
async function fetchRemoteWithFallback({ repoPath, remote, remoteBaseRef, gitImpl, tryGitImpl, timeoutMs }) {
  const fetchPromise = Promise.resolve()
    .then(() => gitImpl(repoPath, 'fetch', remote, '--quiet'))
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
  const ms = Number(timeoutMs) || 0;
  const outcome = ms > 0
    ? await Promise.race([
        fetchPromise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
          if (typeof timer?.unref === 'function') timer.unref();
        }),
      ])
    : await fetchPromise;
  if (outcome.ok) return;
  const cached = await tryGitImpl(repoPath, 'rev-parse', '--verify', remoteBaseRef);
  if (!cached.failed && String(cached.stdout || '').trim()) return;
  const settled = await fetchPromise;
  if (!settled.ok) throw settled.error;
}

function parseOriginHeadRef(stdout) {
  const ref = String(stdout || '').trim();
  if (!ref) return { remoteRef: null, branch: null };
  const originRef = ref.replace(/^refs\/remotes\//, '');
  const branch = originRef.replace(/^origin\//, '') || null;
  return {
    remoteRef: originRef || null,
    branch,
  };
}

function resolveEffectiveBaseBranchRow(projectRow) {
  const preferred = String(projectRow?.preferred_base_branch || '').trim();
  if (preferred) return canonicalBaseBranchName(preferred);
  const fallback = String(projectRow?.default_branch || '').trim();
  return fallback ? canonicalBaseBranchName(fallback) : 'main';
}

function validateRefPart(value, label) {
  const clean = String(value || '').trim();
  if (
    !clean ||
    clean.startsWith('/') ||
    clean.includes('\\') ||
    clean.includes(':') ||
    clean.includes('@{') ||
    clean.endsWith('.lock') ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`normalizeBaseRef: invalid ${label}`);
  }
  return clean;
}

function normalizeBaseRef(value, remote = 'origin') {
  const input = String(value || '').trim();
  if (!input) throw new Error('normalizeBaseRef: base ref required');
  const defaultRemote = validateRefPart(remote || 'origin', 'remote');

  if (input.startsWith('refs/remotes/')) {
    const rest = input.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) throw new Error('normalizeBaseRef: invalid remote ref');
    const refRemote = validateRefPart(rest.slice(0, slash), 'remote');
    const branch = validateRefPart(rest.slice(slash + 1), 'branch');
    return {
      input,
      canonical: `${refRemote}/${branch}`,
      kind: 'remote',
      remote: refRemote,
      branch,
      ref: `refs/remotes/${refRemote}/${branch}`,
      checkoutRef: `${refRemote}/${branch}`,
    };
  }

  if (input.startsWith('refs/heads/')) {
    const branch = validateRefPart(input.slice('refs/heads/'.length), 'branch');
    return {
      input,
      canonical: branch,
      kind: 'local',
      remote: null,
      branch,
      ref: `refs/heads/${branch}`,
      checkoutRef: branch,
    };
  }

  if (input.startsWith(`${defaultRemote}/`)) {
    const branch = validateRefPart(input.slice(defaultRemote.length + 1), 'branch');
    return {
      input,
      canonical: `${defaultRemote}/${branch}`,
      kind: 'remote',
      remote: defaultRemote,
      branch,
      ref: `refs/remotes/${defaultRemote}/${branch}`,
      checkoutRef: `${defaultRemote}/${branch}`,
    };
  }

  const branch = validateRefPart(input, 'branch');
  return {
    input,
    canonical: branch,
    kind: 'local',
    remote: null,
    branch,
    ref: `refs/heads/${branch}`,
    checkoutRef: branch,
  };
}

function canonicalBaseBranchName(value, remote = 'origin') {
  return normalizeBaseRef(value, remote).canonical;
}

function normalizeBaseBranchName(value, remote = 'origin') {
  return normalizeBaseRef(value || 'main', remote).branch;
}

async function resolveRemoteBaseHygiene({
  repoPath,
  baseBranch,
  remote = 'origin',
  gitImpl,
  tryGitImpl,
  skipFetch = false,
  fetchTimeoutMs = DEFAULT_BASE_FETCH_TIMEOUT_MS,
  basePolicy = 'remote',
} = {}) {
  if (!repoPath) throw new Error('resolveRemoteBaseHygiene: repoPath required');
  if (typeof gitImpl !== 'function') throw new Error('resolveRemoteBaseHygiene: git implementation required');
  if (typeof tryGitImpl !== 'function') throw new Error('resolveRemoteBaseHygiene: tryGit implementation required');
  const cleanRemote = String(remote || 'origin').trim() || 'origin';
  const normalized = normalizeBaseRef(baseBranch || 'main', cleanRemote);
  const cleanBase = normalized.branch;
  const remoteBaseRef = normalized.kind === 'remote'
    ? normalized.checkoutRef
    : `${cleanRemote}/${cleanBase}`;
  if (skipFetch !== true) {
    await fetchRemoteWithFallback({
      repoPath,
      remote: cleanRemote,
      remoteBaseRef,
      gitImpl,
      tryGitImpl,
      timeoutMs: fetchTimeoutMs,
    });
  }
  const remoteRes = await tryGitImpl(repoPath, 'rev-parse', '--verify', remoteBaseRef);
  const remoteBaseSha = remoteRes.failed ? null : String(remoteRes.stdout || '').trim();
  if (!remoteBaseSha) {
    const err: any = new Error(`remote base not found: ${remoteBaseRef}`);
    err.code = 'remote_base_unresolved';
    err.details = { baseBranch: cleanBase, remoteBaseRef };
    throw err;
  }

  const localRes = await tryGitImpl(repoPath, 'rev-parse', '--verify', `refs/heads/${cleanBase}`);
  const localBaseSha = localRes.failed ? null : String(localRes.stdout || '').trim();
  const aheadRes = localBaseSha
    ? await tryGitImpl(repoPath, 'rev-list', '--count', `${remoteBaseRef}..${cleanBase}`)
    : { failed: true, stdout: '' };
  const behindRes = localBaseSha
    ? await tryGitImpl(repoPath, 'rev-list', '--count', `${cleanBase}..${remoteBaseRef}`)
    : { failed: true, stdout: '' };
  const localAheadBy = aheadRes.failed ? 0 : (parseInt(String(aheadRes.stdout || '').trim(), 10) || 0);
  const localBehindBy = behindRes.failed ? 0 : (parseInt(String(behindRes.stdout || '').trim(), 10) || 0);
  const policy = String(basePolicy || 'remote').trim().toLowerCase();
  const useLocalBase = policy === 'local';
  const diverged = localAheadBy > 0 && localBehindBy > 0;
  const localBlocked = useLocalBase && (localAheadBy > 0 || localBehindBy > 0);
  const branchPoint = useLocalBase ? cleanBase : remoteBaseRef;
  const checkoutSha = useLocalBase ? localBaseSha : remoteBaseSha;
  return {
    baseBranch: cleanBase,
    selectedBase: branchPoint,
    selectedBaseKind: useLocalBase ? 'local' : 'remote',
    canonicalBase: normalized.canonical,
    inputKind: normalized.kind,
    remoteBaseRef,
    remoteBaseSha,
    localBaseSha,
    localAheadBy,
    localBehindBy,
    diverged,
    branchPoint,
    checkoutSha,
    basePolicy: useLocalBase ? 'local' : 'remote',
    ok: !localBlocked,
    ...(localBlocked ? { blocker: 'local_base_ahead_or_diverged' } : {}),
  };
}

function buildEffectiveBaseBranchResult({ projectId, projectRow }) {
  if (!projectId) throw new Error('getEffectiveBaseBranch: projectId required');
  if (!projectRow) throw new Error('getEffectiveBaseBranch: workspace not found');
  const rawPreferredBaseBranch = String(projectRow.preferred_base_branch || '').trim();
  const rawDefaultBranch = String(projectRow.default_branch || '').trim();
  const preferredBaseBranch = rawPreferredBaseBranch ? canonicalBaseBranchName(rawPreferredBaseBranch) : null;
  const defaultBranch = rawDefaultBranch ? canonicalBaseBranchName(rawDefaultBranch) : null;
  const effectiveBaseBranch = resolveEffectiveBaseBranchRow(projectRow);
  return {
    projectId,
    preferredBaseBranch,
    defaultBranch,
    effectiveBaseBranch,
    effectiveBase: normalizeBaseRef(effectiveBaseBranch),
  };
}

function createBaseBranchPolicyModule({
  git,
  tryGit,
  nowIso = () => new Date().toISOString(),
} = {}) {
  async function refreshProjectDefaultBranchRow({
    projectRow,
    gitImpl = git,
    tryGitImpl = tryGit,
    threshold = DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD,
    persistDefaultBranch,
    now = nowIso(),
  }) {
    if (!projectRow) throw new Error('refreshProjectDefaultBranch: workspace not found');
    if (projectRow.is_remote) {
      return {
        projectId: projectRow.id,
        refreshed: false,
        skipped: 'remote-workspace',
        defaultBranch: projectRow.default_branch ?? null,
        remoteDefaultBranch: null,
        behindBy: 0,
        threshold,
      };
    }

    if (typeof gitImpl !== 'function') {
      throw new Error('refreshProjectDefaultBranch: git implementation required');
    }
    if (typeof tryGitImpl !== 'function') {
      throw new Error('refreshProjectDefaultBranch: tryGit implementation required');
    }

    await gitImpl(projectRow.path, 'fetch', 'origin', '--quiet');
    const remoteHead = await gitImpl(projectRow.path, 'symbolic-ref', 'refs/remotes/origin/HEAD');
    const { remoteRef, branch } = parseOriginHeadRef(remoteHead.stdout);
    if (!remoteRef || !branch) {
      throw new Error('refreshProjectDefaultBranch: could not resolve origin/HEAD');
    }

    const currentBase = String(projectRow.default_branch || '').trim() || branch;
    const behindRes = await tryGitImpl(
      projectRow.path,
      'rev-list',
      '--count',
      `${currentBase}..${remoteRef}`
    );
    const behindBy = behindRes.failed
      ? threshold + 1
      : (parseInt(String(behindRes.stdout || '').trim(), 10) || 0);
    const nextDefaultBranch = behindBy > threshold ? remoteRef : currentBase;
    const refreshed = nextDefaultBranch !== currentBase;

    if (refreshed && typeof persistDefaultBranch === 'function') {
      await persistDefaultBranch({ projectRow, defaultBranch: nextDefaultBranch, now });
    }

    return {
      projectId: projectRow.id,
      refreshed,
      defaultBranch: nextDefaultBranch,
      remoteDefaultBranch: branch,
      behindBy,
      threshold,
    };
  }

  async function branchExistsOnProject({
    projectRow,
    branch,
    tryGitImpl = tryGit,
    daemonFactory,
  }) {
    const name = String(branch || '').trim();
    if (!projectRow || !name) return false;
    let normalized;
    try {
      normalized = normalizeBaseRef(name);
    } catch {
      return false;
    }
    const probes = normalized.kind === 'remote'
      ? [normalized.ref]
      : [normalized.ref, `refs/remotes/origin/${normalized.branch}`];
    if (projectRow.is_remote) {
      if (typeof daemonFactory !== 'function') {
        throw new Error('branchExistsOnProject: daemonFactory required for remote workspaces');
      }
      const daemon = daemonFactory(projectRow.ssh_host, projectRow.agent_user);
      for (const ref of probes) {
        const res = await daemon.exec({
          cmd: 'git',
          args: ['rev-parse', '--verify', ref],
          cwd: projectRow.remote_path,
        });
        if (res.code === 0) return true;
      }
      return false;
    }
    if (typeof tryGitImpl !== 'function') {
      throw new Error('branchExistsOnProject: tryGit implementation required');
    }
    for (const ref of probes) {
      const res = await tryGitImpl(projectRow.path, 'rev-parse', '--verify', ref);
      if (!res.failed) return true;
    }
    return false;
  }

  function createBaseBranchPolicyApi({
    getProjectRow,
    persistPreferredBaseBranch,
    branchExists,
    emitState = () => {},
    now = nowIso,
  }) {
    if (typeof getProjectRow !== 'function') {
      throw new Error('createBaseBranchPolicyApi: getProjectRow required');
    }
    if (typeof persistPreferredBaseBranch !== 'function') {
      throw new Error('createBaseBranchPolicyApi: persistPreferredBaseBranch required');
    }
    if (typeof branchExists !== 'function') {
      throw new Error('createBaseBranchPolicyApi: branchExists required');
    }

    function getEffectiveBaseBranch({ projectId }) {
      return buildEffectiveBaseBranchResult({
        projectId,
        projectRow: getProjectRow(projectId),
      });
    }

    async function setWorkspaceBaseBranch({ projectId, branch }) {
      if (!projectId) throw new Error('setWorkspaceBaseBranch: projectId required');
      const row = getProjectRow(projectId);
      if (!row) throw new Error('setWorkspaceBaseBranch: workspace not found');
      const nextBranch = canonicalBaseBranchName(branch || '');
      const exists = await branchExists(row, nextBranch);
      if (!exists) {
        throw new Error(`setWorkspaceBaseBranch: unknown branch "${nextBranch}"`);
      }
      persistPreferredBaseBranch({
        projectId,
        branch: nextBranch,
        updatedAt: now(),
      });
      emitState();
      return getEffectiveBaseBranch({ projectId });
    }

    function clearWorkspaceBaseBranch({ projectId }) {
      if (!projectId) throw new Error('clearWorkspaceBaseBranch: projectId required');
      const row = getProjectRow(projectId);
      if (!row) throw new Error('clearWorkspaceBaseBranch: workspace not found');
      persistPreferredBaseBranch({
        projectId,
        branch: null,
        updatedAt: now(),
      });
      emitState();
      return getEffectiveBaseBranch({ projectId });
    }

    return {
      clearWorkspaceBaseBranch,
      setWorkspaceBaseBranch,
      getEffectiveBaseBranch,
    };
  }

  return {
    branchExistsOnProject,
    buildEffectiveBaseBranchResult,
    createBaseBranchPolicyApi,
    parseOriginHeadRef,
    refreshProjectDefaultBranchRow,
    canonicalBaseBranchName,
    normalizeBaseRef,
    normalizeBaseBranchName,
    resolveRemoteBaseHygiene,
    resolveEffectiveBaseBranchRow,
  };
}

module.exports = {
  ...createBaseBranchPolicyModule(),
  createBaseBranchPolicyModule,
  DEFAULT_BASE_REFRESH_COMMIT_THRESHOLD,
  DEFAULT_BASE_FETCH_TIMEOUT_MS,
};
