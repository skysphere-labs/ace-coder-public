const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const {
  branchExistsOnProject,
  addWorktree,
  createBaseBranchPolicyApi,
  createDelegatedTaskWithDeps,
} = require('../local-core.cjs');
const {
  normalizeBaseRef,
  resolveRemoteBaseHygiene,
} = require('../core/base-branch-policy.cjs');

function git(cwd: any, ...args: any[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(filePath: any, contents: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

async function gitImpl(cwd: any, ...args: any[]) {
  return { stdout: git(cwd, ...args), stderr: '' };
}

async function tryGitImpl(cwd: any, ...args: any[]) {
  try {
    return await gitImpl(cwd, ...args);
  } catch (err) {
    return {
      stdout: err?.stdout ? String(err.stdout) : '',
      stderr: err?.stderr ? String(err.stderr) : err?.message || String(err),
      failed: true,
    };
  }
}

function createFixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-base-branch-'));
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'origin.git');

  fs.mkdirSync(repoPath, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remotePath);
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, 'config', 'user.name', 'Ace Test');
  git(repoPath, 'config', 'user.email', 'ace@example.com');

  writeFile(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  git(repoPath, 'remote', 'set-head', 'origin', '-a');

  git(repoPath, 'checkout', '-b', 'dev');
  writeFile(path.join(repoPath, 'dev.txt'), 'dev\n');
  git(repoPath, 'add', 'dev.txt');
  git(repoPath, 'commit', '-m', 'add dev');
  git(repoPath, 'push', '-u', 'origin', 'dev');
  git(repoPath, 'checkout', 'main');

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    repoPath,
    projectRow: {
      id: 'prj-1',
      path: repoPath,
      is_remote: 0,
      default_branch: 'main',
      preferred_base_branch: null,
    },
  };
}

function createPolicy(projectRow: any) {
  const rows = new Map([[projectRow.id, projectRow]]);
  let emitted = 0;
  const policy = createBaseBranchPolicyApi({
    getProjectRow: (projectId: any) => rows.get(projectId) || null,
    persistPreferredBaseBranch: ({ projectId, branch }: any) => {
      rows.get(projectId).preferred_base_branch = branch;
    },
    branchExists: (row: any, branch: any) => branchExistsOnProject({ projectRow: row, branch }),
    emitState: () => {
      emitted += 1;
    },
    now: () => '2026-04-20T12:00:00.000Z',
  });
  return { policy, rows, get emitted() { return emitted; } };
}

test('setWorkspaceBaseBranch + getEffectiveBaseBranch roundtrip persists preferred_base_branch', async (t: any) => {
  const { projectRow } = createFixture(t);
  const state = createPolicy(projectRow);

  const setResult = await state.policy.setWorkspaceBaseBranch({
    projectId: projectRow.id,
    branch: 'dev',
  });
  assert.equal(setResult.projectId, projectRow.id);
  assert.equal(setResult.preferredBaseBranch, 'dev');
  assert.equal(setResult.effectiveBaseBranch, 'dev');
  assert.equal(projectRow.preferred_base_branch, 'dev');
  assert.equal(state.emitted, 1);

  const getResult = state.policy.getEffectiveBaseBranch({ projectId: projectRow.id });
  assert.equal(getResult.preferredBaseBranch, 'dev');
  assert.equal(getResult.defaultBranch, 'main');
  assert.equal(getResult.effectiveBaseBranch, 'dev');
});

test('setWorkspaceBaseBranch rejects unknown branches', async (t: any) => {
  const { projectRow } = createFixture(t);
  const state = createPolicy(projectRow);

  await assert.rejects(
    () => state.policy.setWorkspaceBaseBranch({
      projectId: projectRow.id,
      branch: 'missing-branch',
    }),
    /unknown branch "missing-branch"/
  );
});

test('normalizeBaseRef canonicalizes local and remote base refs', () => {
  assert.deepEqual(normalizeBaseRef('main'), {
    input: 'main',
    canonical: 'main',
    kind: 'local',
    remote: null,
    branch: 'main',
    ref: 'refs/heads/main',
    checkoutRef: 'main',
  });
  assert.deepEqual(normalizeBaseRef('origin/main'), {
    input: 'origin/main',
    canonical: 'origin/main',
    kind: 'remote',
    remote: 'origin',
    branch: 'main',
    ref: 'refs/remotes/origin/main',
    checkoutRef: 'origin/main',
  });
  assert.equal(normalizeBaseRef('refs/remotes/origin/main').canonical, 'origin/main');
  assert.equal(normalizeBaseRef('refs/heads/main').canonical, 'main');

  for (const bad of ['', '/tmp/main', '../main', 'refs/heads/../main']) {
    assert.throws(() => normalizeBaseRef(bad), /normalizeBaseRef/);
  }
});

test('branchExistsOnProject accepts canonical local and remote refs without origin/origin probes', async (t: any) => {
  const { projectRow } = createFixture(t);
  assert.equal(await branchExistsOnProject({ projectRow, branch: 'main' }), true);
  assert.equal(await branchExistsOnProject({ projectRow, branch: 'origin/main' }), true);
  assert.equal(await branchExistsOnProject({ projectRow, branch: 'refs/remotes/origin/main' }), true);
  assert.equal(await branchExistsOnProject({ projectRow, branch: '/tmp/main' }), false);
  assert.equal(await branchExistsOnProject({ projectRow, branch: '../main' }), false);

  const calls: any[] = [];
  const exists = await branchExistsOnProject({
    projectRow,
    branch: 'origin/main',
    tryGitImpl: async (_cwd: any, ...args: any[]) => {
      calls.push(args);
      return args.includes('refs/remotes/origin/main')
        ? { stdout: 'sha\n', stderr: '' }
        : { stdout: '', stderr: 'missing', failed: true };
    },
  });
  assert.equal(exists, true);
  assert.deepEqual(calls, [['rev-parse', '--verify', 'refs/remotes/origin/main']]);
  assert.equal(calls.some((args) => args.join(' ').includes('origin/origin/main')), false);
});

test('setWorkspaceBaseBranch persists canonical origin/main and clear removes the preference', async (t: any) => {
  const { projectRow } = createFixture(t);
  const state = createPolicy(projectRow);

  const setResult = await state.policy.setWorkspaceBaseBranch({
    projectId: projectRow.id,
    branch: 'refs/remotes/origin/main',
  });
  assert.equal(setResult.preferredBaseBranch, 'origin/main');
  assert.equal(setResult.effectiveBaseBranch, 'origin/main');
  assert.equal(setResult.effectiveBase.kind, 'remote');
  assert.equal(projectRow.preferred_base_branch, 'origin/main');

  const clearResult = state.policy.clearWorkspaceBaseBranch({ projectId: projectRow.id });
  assert.equal(clearResult.preferredBaseBranch, null);
  assert.equal(clearResult.effectiveBaseBranch, 'main');
  assert.equal(projectRow.preferred_base_branch, null);
});

test('getEffectiveBaseBranch falls back preferred -> default_branch -> main', () => {
  const projectRow = {
    id: 'prj-fallback',
    path: '/tmp/fallback',
    is_remote: 0,
    default_branch: 'main',
    preferred_base_branch: 'dev',
  };
  const state = createPolicy(projectRow);

  let result = state.policy.getEffectiveBaseBranch({ projectId: projectRow.id });
  assert.equal(result.effectiveBaseBranch, 'dev');

  projectRow.preferred_base_branch = null;
  projectRow.default_branch = 'release';
  result = state.policy.getEffectiveBaseBranch({ projectId: projectRow.id });
  assert.equal(result.preferredBaseBranch, null);
  assert.equal(result.effectiveBaseBranch, 'release');

  projectRow.default_branch = null;
  result = state.policy.getEffectiveBaseBranch({ projectId: projectRow.id });
  assert.equal(result.defaultBranch, null);
  assert.equal(result.effectiveBaseBranch, 'main');
});

test('createDelegatedTask honors preferred base branch and still creates a short-lived task branch', async () => {
  const createTaskCalls: any[] = [];
  const refreshCalls: any[] = [];
  const delegated = await createDelegatedTaskWithDeps({
    workspaceId: 'prj-1',
    agent: 'codex',
    goal: 'Ship branch policy update',
    label: 'branch-policy-feat',
    refreshProjectDefaultBranchImpl: async (params: any) => {
      refreshCalls.push(params);
    },
    getEffectiveBaseBranchImpl: ({ projectId }: any) => {
      assert.equal(projectId, 'prj-1');
      return {
        projectId,
        preferredBaseBranch: 'dev',
        defaultBranch: 'main',
        effectiveBaseBranch: 'dev',
      };
    },
    createTaskImpl: async ({ workspaceId, input }: any) => {
      createTaskCalls.push({ workspaceId, input });
      return { id: 'tsk-1' };
    },
    getTaskArtifactsImpl: async (taskId: any) => {
      assert.equal(taskId, 'tsk-1');
      return {
        worktree: {
          path: '/tmp/wt/branch-policy-feat-update',
          branch: 'branch-policy-feat-update',
          base_branch: 'dev',
        },
        variant: { id: 'var-1' },
      };
    },
    now: () => new Date('2026-04-20T12:00:00.000Z'),
  });

  assert.equal(createTaskCalls.length, 1);
  assert.deepEqual(refreshCalls, []);
  assert.equal(createTaskCalls[0].workspaceId, 'prj-1');
  assert.equal(createTaskCalls[0].input.baseBranch, 'dev');
  assert.equal(createTaskCalls[0].input.skipWorktreeFetch, true);
  assert.equal(delegated.baseBranch, 'dev');
  assert.equal(delegated.baseRefreshMode, 'false');
  assert.equal(delegated.branch, 'branch-policy-feat-update');
  assert.notEqual(delegated.branch, delegated.baseBranch);
  assert.equal(delegated.variantId, 'var-1');
});

test('createDelegatedTask refreshBase=force explicitly refreshes before base resolution', async () => {
  const refreshCalls: any[] = [];
  const delegated = await createDelegatedTaskWithDeps({
    workspaceId: 'prj-1',
    agent: 'codex',
    goal: 'Ship branch policy update',
    label: 'branch-policy-feat',
    refreshBase: 'force',
    refreshProjectDefaultBranchImpl: async (params: any) => {
      refreshCalls.push(params);
    },
    getEffectiveBaseBranchImpl: ({ projectId }: any) => {
      assert.equal(projectId, 'prj-1');
      return {
        projectId,
        preferredBaseBranch: null,
        defaultBranch: 'origin/main',
        effectiveBaseBranch: 'origin/main',
      };
    },
    createTaskImpl: async () => ({ id: 'tsk-1' }),
    getTaskArtifactsImpl: async () => ({
      worktree: {
        path: '/tmp/wt/branch-policy-feat-update',
        branch: 'branch-policy-feat-update',
        base_branch: 'origin/main',
      },
      variant: { id: 'var-1' },
    }),
  });

  assert.deepEqual(refreshCalls, [{ projectId: 'prj-1', mode: 'force', threshold: 0 }]);
  assert.equal(delegated.baseBranch, 'origin/main');
  assert.equal(delegated.baseRefreshMode, 'force');
});

test('addWorktree: skipFetch avoids a second fetch before worktree add', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-add-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: any[] = [];

  await addWorktree(
    '/repo',
    'worker-update',
    path.join(root, 'worktrees', 'worker-update'),
    'origin/main',
    {
      skipFetch: true,
      gitImpl: async (_cwd: any, ...args: any[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      },
    }
  );

  assert.deepEqual(calls, [
    ['worktree', 'add', '-b', 'worker-update', path.join(root, 'worktrees', 'worker-update'), 'origin/main'],
  ]);
});

test('resolveRemoteBaseHygiene uses remote base when local main has unpushed commits', async (t: any) => {
  const { repoPath } = createFixture(t);
  const root = path.dirname(repoPath);
  const originMain = git(repoPath, 'rev-parse', 'origin/main');

  writeFile(path.join(repoPath, 'local-only.txt'), 'unpushed\n');
  git(repoPath, 'add', 'local-only.txt');
  git(repoPath, 'commit', '-m', 'local only');
  const localMain = git(repoPath, 'rev-parse', 'main');
  assert.notEqual(localMain, originMain);

  const hygiene = await resolveRemoteBaseHygiene({
    repoPath,
    baseBranch: 'main',
    gitImpl,
    tryGitImpl,
    skipFetch: true,
  });

  assert.equal(hygiene.baseBranch, 'main');
  assert.equal(hygiene.remoteBaseRef, 'origin/main');
  assert.equal(hygiene.remoteBaseSha, originMain);
  assert.equal(hygiene.localBaseSha, localMain);
  assert.equal(hygiene.localAheadBy, 1);
  assert.equal(hygiene.branchPoint, 'origin/main');
  assert.equal(hygiene.checkoutSha, originMain);
  assert.equal(hygiene.selectedBase, 'origin/main');
  assert.equal(hygiene.selectedBaseKind, 'remote');

  const worktreePath = path.join(root, 'worker-from-remote');
  await addWorktree(repoPath, 'worker-from-remote-base', worktreePath, hygiene.checkoutSha, { skipFetch: true });

  assert.equal(fs.existsSync(path.join(worktreePath, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(worktreePath, 'local-only.txt')), false);
  assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), originMain);
});

test('resolveRemoteBaseHygiene rejects unresolved remote bases', async (t: any) => {
  const { repoPath } = createFixture(t);

  await assert.rejects(
    () => resolveRemoteBaseHygiene({
      repoPath,
      baseBranch: 'missing',
      gitImpl,
      tryGitImpl,
      skipFetch: true,
    }),
    (err: any) => {
      assert.equal(err.code, 'remote_base_unresolved');
      assert.equal(err.details.remoteBaseRef, 'origin/missing');
      return true;
    }
  );
});
