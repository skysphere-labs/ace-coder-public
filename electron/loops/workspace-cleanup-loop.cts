// Built-in Workspace Cleanup / Reconciliation Loop.
//
// This is a system loop, not a worker/validator code loop: it performs a safe,
// read-heavy reconciliation against one target workspace and writes durable
// artifacts under <userData>/loops/workspace-cleanup/. Destructive cleanup stays
// owner-gated; safe mode only preserves evidence and may prune missing worktree
// records.

import type { LoopSpec, StopState } from './loop-spec.cts';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

export const WORKSPACE_CLEANUP_LOOP_ID = 'workspace-cleanup-reconcile';

export const WORKSPACE_CLEANUP_LOOP_SPEC: LoopSpec = {
  id: WORKSPACE_CLEANUP_LOOP_ID,
  name: 'Workspace Cleanup Reconcile',
  description: 'Snapshot, classify, and safely reconcile cleanup noise for any selected workspace.',
  useWhen: 'A workspace needs safe cleanup, stale stream triage, worktree prune evidence, or owner cleanup decisions separated from active work.',
  kind: 'agentic',
  inputs: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      workspaceName: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string' },
      mode: { type: 'string', enum: ['dry-run', 'safe', 'destructive'], default: 'safe' },
      ownerApproved: { type: 'boolean', default: false },
    },
  },
  goalTemplate: 'Run workspace cleanup reconciliation for {{workspaceId}}{{workspaceName}}{{repo}} in safe mode and write artifacts/report.',
  routing: {
    agent: 'auto',
    skills: ['ace-runtime-contract', 'ace-task-worker'],
    workspace: 'loops',
    target: { allow: [] },
  },
  contract: {
    stop: { primary: 'converged' },
    ceilings: {},
    verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
    permissions: [],
    merge: { ownerGated: true },
  },
  evidence: {
    type: 'object',
    properties: {
      artifactDir: { type: 'string' },
      reportPath: { type: 'string' },
      actionPlanPath: { type: 'string' },
    },
    required: ['artifactDir', 'reportPath', 'actionPlanPath'],
  },
  meta: { version: 1 },
};

export interface WorkspaceCleanupShellResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface WorkspaceCleanupDeps {
  userDataPath: string;
  now?: () => number | string;
  listWorkspaces?: () => any[] | Promise<any[]>;
  listStreams?: () => any | Promise<any>;
  runBoard?: () => any | Promise<any>;
  closeStream?: (stream: any) => any | Promise<any>;
  shell?: (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => WorkspaceCleanupShellResult;
}

function isNonEmptyString(value: any): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanSegment(value: any): string {
  const text = String(value == null ? 'workspace' : value).trim();
  return text.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function isoStamp(now: any): string {
  const value = typeof now === 'function' ? now() : Date.now();
  const date = typeof value === 'string' ? new Date(value) : new Date(Number(value));
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return valid.toISOString();
}

function artifactStamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, '').slice(0, 14);
}

function defaultShell(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): WorkspaceCleanupShellResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    code: typeof res.status === 'number' ? res.status : res.error ? 1 : 0,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || res.error?.message || ''),
    timedOut: !!res.error && String(res.error.message || '').includes('ETIMEDOUT'),
  };
}

function writeJson(filePath: string, value: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function parseJson(text: string, fallback: any): any {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function githubRepoFromRemote(remote: string): string | null {
  const text = String(remote || '').trim();
  const match = text.match(/github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?$/);
  return match ? match[1] : null;
}

function normalizeWorkspaces(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.workspaces)) return value.workspaces;
  return [];
}

function resolveWorkspace(inputs: any, workspaces: any[]): any {
  const workspaceId = String(inputs?.workspaceId || '').trim();
  const workspaceName = String(inputs?.workspaceName || '').trim().toLowerCase();
  const repo = String(inputs?.repo || '').trim().toLowerCase();
  const targetPath = String(inputs?.path || inputs?.workspacePath || '').trim();
  const candidates = normalizeWorkspaces(workspaces);
  const found = candidates.find((workspace) => {
    if (workspaceId && workspace.id === workspaceId) return true;
    if (workspaceName && String(workspace.name || '').toLowerCase() === workspaceName) return true;
    if (repo && String(workspace.githubRepo || '').toLowerCase() === repo) return true;
    if (targetPath && (workspace.path === targetPath || workspace.remotePath === targetPath)) return true;
    return false;
  });
  if (found) return found;
  if (targetPath || repo || workspaceId || workspaceName) {
    return {
      id: workspaceId || repo || workspaceName || cleanSegment(targetPath),
      name: workspaceName || repo || path.basename(targetPath) || workspaceId || 'Workspace',
      path: targetPath || null,
      remotePath: null,
      githubRepo: repo || null,
      isRemote: false,
      tasks: [],
    };
  }
  throw new Error('workspace-cleanup: target workspace required (workspaceId, workspaceName, repo, or path)');
}

function parseStatusPorcelain(raw: string): any[] {
  const parts = String(raw || '').split('\0').filter(Boolean);
  const entries: any[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    const code = rec.slice(0, 2);
    const filePath = rec.slice(3);
    const entry: any = { code, path: filePath };
    if (code.includes('R') || code.includes('C')) {
      entry.originalPath = parts[i + 1] || null;
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function parseWorktrees(raw: string): any[] {
  const blocks = String(raw || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const item: any = { raw: block };
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ');
      if (key === 'worktree') item.path = rest.join(' ');
      else if (key === 'HEAD') item.head = rest.join(' ');
      else if (key === 'branch') item.branch = rest.join(' ');
      else if (key === 'detached') item.detached = true;
      else if (key === 'prunable') item.prunable = rest.join(' ') || true;
    }
    item.pathExists = item.path ? fs.existsSync(item.path) : false;
    item.missingPathPrunable = !!item.prunable && item.path && !item.pathExists;
    return item;
  });
}

function collectUntrackedSizes(root: string, entries: any[], shell: WorkspaceCleanupDeps['shell']): any[] {
  const run = shell || defaultShell;
  const untracked = entries.filter((entry) => entry.code === '??').slice(0, 250);
  return untracked.map((entry) => {
    const res = run('du', ['-sk', '--', entry.path], { cwd: root, timeoutMs: 5_000 });
    const kb = res.code === 0 ? Number(String(res.stdout).trim().split(/\s+/)[0]) : 0;
    return {
      path: entry.path,
      sizeBytes: Number.isFinite(kb) ? kb * 1024 : 0,
      measured: res.code === 0,
    };
  });
}

function filterWorkspaceRunBoard(board: any, workspace: any): any {
  const needles = [workspace?.id, workspace?.name, workspace?.githubRepo, workspace?.path]
    .filter(isNonEmptyString)
    .map((v: any) => String(v));
  if (!needles.length) return { cards: [] };
  const cards: any[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const haystack = JSON.stringify(value);
    if ((value.id || value.runId || value.taskId) && needles.some((needle) => haystack.includes(needle))) {
      cards.push(value);
      return;
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(board);
  return { cards };
}

function classify(input: any): any {
  const buckets: Record<string, any[]> = {
    activeKeep: [],
    mergedArchiveCandidate: [],
    closedSuperseded: [],
    blockedStale: [],
    dirtyPreserveFirst: [],
    ownerDecisionRequired: [],
  };

  for (const stream of input.streams) {
    const state = String(stream.state || '').toLowerCase();
    if (stream.live || ['busy', 'awaiting-input', 'turn-complete'].includes(state)) {
      buckets.activeKeep.push({ type: 'stream', streamId: stream.streamId, state: stream.state, reason: 'live or recently actionable stream' });
    } else if (state === 'awaiting-approval') {
      buckets.ownerDecisionRequired.push({ type: 'stream', streamId: stream.streamId, state: stream.state, reason: 'approval gate requires owner decision' });
    } else if (state === 'interrupted' || state === 'error') {
      buckets.blockedStale.push({ type: 'stream', streamId: stream.streamId, state: stream.state, reason: 'interrupted/error stream needs review before cleanup' });
    } else {
      buckets.blockedStale.push({ type: 'stream', streamId: stream.streamId, state: stream.state, reason: 'dormant stream without merged/closed proof' });
    }
  }

  for (const pr of input.pullRequests) {
    const state = String(pr.state || '').toUpperCase();
    if (state === 'MERGED' || pr.mergedAt) {
      buckets.mergedArchiveCandidate.push({ type: 'pr', number: pr.number, url: pr.url, reason: 'merged PR' });
    } else if (state === 'CLOSED' || pr.closedAt) {
      buckets.closedSuperseded.push({ type: 'pr', number: pr.number, url: pr.url, reason: 'closed PR' });
    } else {
      buckets.ownerDecisionRequired.push({ type: 'pr', number: pr.number, url: pr.url, title: pr.title, reason: 'open PR must be handled separately from cleanup noise' });
    }
  }

  if (input.git.trackedDirty.length || input.git.untracked.length) {
    buckets.dirtyPreserveFirst.push({
      type: 'git-root',
      trackedDirty: input.git.trackedDirty.length,
      untracked: input.git.untracked.length,
      patchPath: input.git.patchPath,
      untrackedManifestPath: input.git.untrackedManifestPath,
      reason: 'dirty root must be preserved before reset/delete recommendations',
    });
  }

  for (const wt of input.worktrees) {
    if (wt.missingPathPrunable) {
      buckets.closedSuperseded.push({ type: 'worktree-record', path: wt.path, reason: 'prunable record points to a missing path' });
    } else if (wt.pathExists) {
      buckets.ownerDecisionRequired.push({ type: 'worktree-directory', path: wt.path, branch: wt.branch, reason: 'real worktree directory deletion is owner-gated' });
    }
  }

  for (const card of input.runCards) {
    buckets.ownerDecisionRequired.push({ type: 'run-card', id: card.id || card.runId || card.taskId || null, reason: 'run-ledger card archive is owner-gated' });
  }

  return buckets;
}

function renderReport(data: any): string {
  const lines: string[] = [];
  lines.push(`# Workspace Cleanup Reconciliation: ${data.workspace.name || data.workspace.id}`);
  lines.push('');
  lines.push(`- Workspace: ${data.workspace.id || 'unknown'} (${data.workspace.path || data.workspace.remotePath || 'no local path'})`);
  lines.push(`- Mode: ${data.mode}`);
  lines.push(`- Artifact directory: ${data.artifactDir}`);
  lines.push(`- Report generated: ${data.startedAt}`);
  lines.push('');
  lines.push('## Artifacts');
  for (const [key, value] of Object.entries(data.artifacts)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## Classification');
  for (const [bucket, items] of Object.entries(data.classifications) as any) {
    lines.push(`- ${bucket}: ${items.length}`);
  }
  lines.push('');
  lines.push('## Safe Actions');
  if (!data.actionPlan.safeActions.length) lines.push('- none');
  for (const action of data.actionPlan.safeActions) lines.push(`- ${action.status}: ${action.action} (${action.reason})`);
  lines.push('');
  lines.push('## Owner Decisions');
  if (!data.actionPlan.ownerDecisions.length) lines.push('- none');
  for (const decision of data.actionPlan.ownerDecisions) {
    const label = decision.url ? `${decision.type} ${decision.url}` : decision.path ? `${decision.type} ${decision.path}` : decision.type;
    lines.push(`- ${label}: ${decision.reason}`);
  }
  lines.push('');
  lines.push('## Guardrails');
  lines.push('- Real worktree directory deletion requires explicit owner approval.');
  lines.push('- Dirty root reset/clean requires explicit owner approval after patch and untracked manifests are reviewed.');
  lines.push('- PR close/merge and run-card archive are owner-gated.');
  lines.push('- Credentials, runtime data, Hermes memories, and active operator lanes are never touched by this loop.');
  return `${lines.join('\n')}\n`;
}

function builtInRunResult(run: any): any {
  const outcome: StopState = run.actionPlan.ownerDecisions.length ? 'NEEDS_OWNER_DECISION' : 'DONE';
  return {
    invocationId: `system-${WORKSPACE_CLEANUP_LOOP_ID}-${path.basename(run.artifactDir)}`,
    loopId: WORKSPACE_CLEANUP_LOOP_ID,
    loopLineageId: `system-${WORKSPACE_CLEANUP_LOOP_ID}`,
    finished: true,
    finishReason: 'converged',
    reasonDetail: run.reportPath,
    latestRunOutcome: outcome,
    artifactDir: run.artifactDir,
    reportPath: run.reportPath,
    iterations: [
      {
        index: 0,
        runId: run.artifactDir,
        goal: `Workspace cleanup reconciliation for ${run.workspace.id || run.workspace.name}`,
        classification: outcome === 'DONE' ? 'terminal' : 'needs-owner-decision',
        reason: run.reportPath,
        artifactDir: run.artifactDir,
        reportPath: run.reportPath,
      },
    ],
  };
}

export async function runWorkspaceCleanupLoop(inputs: any = {}, deps: WorkspaceCleanupDeps): Promise<any> {
  if (!deps || !isNonEmptyString(deps.userDataPath)) {
    throw new Error('workspace-cleanup: userDataPath required');
  }
  const shell = deps.shell || defaultShell;
  const startedAt = isoStamp(deps.now);
  const workspaces = normalizeWorkspaces(deps.listWorkspaces ? await deps.listWorkspaces() : []);
  const workspace = resolveWorkspace(inputs, workspaces);
  const workspacePath = workspace.isRemote ? workspace.remotePath : workspace.path;
  const mode = inputs?.mode === 'dry-run' || inputs?.mode === 'destructive' ? inputs.mode : 'safe';
  const ownerApproved = inputs?.ownerApproved === true || inputs?.ownerAcknowledgement === 'WORKSPACE_CLEANUP_DESTRUCTIVE_OK';
  const artifactDir = path.join(
    deps.userDataPath,
    'loops',
    'workspace-cleanup',
    `${artifactStamp(startedAt)}-${cleanSegment(workspace.id || workspace.name || workspace.githubRepo || workspacePath)}`,
  );
  fs.mkdirSync(artifactDir, { recursive: true });

  const streamsPayload = deps.listStreams ? await deps.listStreams() : { streams: [] };
  const allStreams = Array.isArray(streamsPayload?.streams) ? streamsPayload.streams : Array.isArray(streamsPayload) ? streamsPayload : [];
  const streams = allStreams.filter((stream: any) => !workspace.id || stream.workspaceId === workspace.id);

  const board = deps.runBoard ? await deps.runBoard() : null;
  const runBoard = filterWorkspaceRunBoard(board, workspace);

  const git: any = {
    root: null,
    remote: null,
    githubRepo: workspace.githubRepo || null,
    status: [],
    trackedDirty: [],
    untracked: [],
    patchPath: null,
    untrackedManifestPath: path.join(artifactDir, 'untracked-manifest.json'),
    commandErrors: [],
  };
  let worktrees: any[] = [];
  let pullRequests: any[] = [];
  let workflowRuns: any[] = [];

  if (isNonEmptyString(workspacePath) && !workspace.isRemote) {
    const rootRes = shell('git', ['rev-parse', '--show-toplevel'], { cwd: workspacePath, timeoutMs: 10_000 });
    if (rootRes.code === 0 && isNonEmptyString(rootRes.stdout)) git.root = rootRes.stdout.trim();
    else git.commandErrors.push({ command: 'git rev-parse --show-toplevel', stderr: rootRes.stderr, code: rootRes.code });
    const root = git.root || workspacePath;

    const remoteRes = shell('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 10_000 });
    if (remoteRes.code === 0) {
      git.remote = remoteRes.stdout.trim();
      git.githubRepo = git.githubRepo || githubRepoFromRemote(git.remote);
    }

    const statusRes = shell('git', ['status', '--porcelain=v1', '-z'], { cwd: root, timeoutMs: 10_000 });
    if (statusRes.code === 0) {
      git.status = parseStatusPorcelain(statusRes.stdout);
      git.trackedDirty = git.status.filter((entry: any) => entry.code !== '??');
      git.untracked = git.status.filter((entry: any) => entry.code === '??');
    } else {
      git.commandErrors.push({ command: 'git status --porcelain=v1 -z', stderr: statusRes.stderr, code: statusRes.code });
    }

    if (git.trackedDirty.length) {
      const diffRes = shell('git', ['diff', '--binary'], { cwd: root, timeoutMs: 20_000 });
      git.patchPath = path.join(artifactDir, 'dirty-tracked.patch');
      writeText(git.patchPath, diffRes.stdout || '');
    }
    writeJson(git.untrackedManifestPath, collectUntrackedSizes(root, git.status, shell));

    const worktreeRes = shell('git', ['worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: 10_000 });
    if (worktreeRes.code === 0) worktrees = parseWorktrees(worktreeRes.stdout);
    else git.commandErrors.push({ command: 'git worktree list --porcelain', stderr: worktreeRes.stderr, code: worktreeRes.code });

    if (git.githubRepo) {
      const prRes = shell('gh', ['pr', 'list', '--repo', git.githubRepo, '--state', 'all', '--limit', '50', '--json', 'number,title,state,isDraft,baseRefName,headRefName,mergedAt,closedAt,url,statusCheckRollup'], { cwd: root, timeoutMs: 20_000 });
      if (prRes.code === 0) pullRequests = parseJson(prRes.stdout, []);
      else pullRequests = [{ error: prRes.stderr || prRes.stdout || 'gh pr list failed', command: 'gh pr list', code: prRes.code }];
      const runsRes = shell('gh', ['run', 'list', '--repo', git.githubRepo, '--limit', '20', '--json', 'databaseId,status,conclusion,workflowName,headBranch,headSha,url,createdAt,updatedAt'], { cwd: root, timeoutMs: 20_000 });
      if (runsRes.code === 0) workflowRuns = parseJson(runsRes.stdout, []);
      else workflowRuns = [{ error: runsRes.stderr || runsRes.stdout || 'gh run list failed', command: 'gh run list', code: runsRes.code }];
    }
  } else {
    git.commandErrors.push({ command: 'local git snapshot', stderr: 'workspace has no local path or is remote', code: 1 });
  }

  const classifications = classify({ streams, pullRequests, git, worktrees, runCards: runBoard.cards || [] });
  const actionPlan: any = {
    mode,
    ownerApproved,
    safeActions: [],
    ownerDecisions: [],
  };

  const prunableMissing = worktrees.filter((wt) => wt.missingPathPrunable);
  if (prunableMissing.length) {
    if (mode === 'safe' && git.root) {
      const prune = shell('git', ['worktree', 'prune', '--verbose'], { cwd: git.root, timeoutMs: 20_000 });
      actionPlan.safeActions.push({ action: 'git worktree prune', status: prune.code === 0 ? 'done' : 'failed', reason: `${prunableMissing.length} missing prunable worktree record(s)`, stderr: prune.stderr });
    } else {
      actionPlan.safeActions.push({ action: 'git worktree prune', status: 'planned', reason: `${prunableMissing.length} missing prunable worktree record(s)` });
    }
  }

  for (const decision of classifications.ownerDecisionRequired) actionPlan.ownerDecisions.push(decision);
  for (const decision of classifications.dirtyPreserveFirst) actionPlan.ownerDecisions.push(decision);
  const destructiveRequests = ['deleteWorktreeDirs', 'resetDirtyRoot', 'closePullRequests', 'archiveRunCards', 'touchRuntimeData']
    .filter((key) => inputs?.[key] === true);
  if ((mode === 'destructive' || destructiveRequests.length) && !ownerApproved) {
    actionPlan.ownerDecisions.push({
      type: 'owner-gate',
      requested: destructiveRequests,
      reason: 'destructive cleanup requires ownerAcknowledgement=WORKSPACE_CLEANUP_DESTRUCTIVE_OK',
    });
  }

  const artifacts = {
    inputs: path.join(artifactDir, 'inputs.json'),
    streams: path.join(artifactDir, 'streams.json'),
    runBoard: path.join(artifactDir, 'run-board.json'),
    github: path.join(artifactDir, 'github.json'),
    gitStatus: path.join(artifactDir, 'git-status.json'),
    worktrees: path.join(artifactDir, 'worktrees.json'),
    classifications: path.join(artifactDir, 'classifications.json'),
    actionPlan: path.join(artifactDir, 'action-plan.json'),
    report: path.join(artifactDir, 'report.md'),
  };

  writeJson(artifacts.inputs, { inputs, resolvedWorkspace: workspace, mode, ownerApproved });
  writeJson(artifacts.streams, { streams });
  writeJson(artifacts.runBoard, runBoard);
  writeJson(artifacts.github, { pullRequests, workflowRuns });
  writeJson(artifacts.gitStatus, git);
  writeJson(artifacts.worktrees, { worktrees });
  writeJson(artifacts.classifications, classifications);
  writeJson(artifacts.actionPlan, actionPlan);

  const reportData = {
    startedAt,
    mode,
    workspace,
    artifactDir,
    reportPath: artifacts.report,
    artifacts,
    classifications,
    actionPlan,
  };
  writeText(artifacts.report, renderReport(reportData));
  writeJson(path.join(artifactDir, 'summary.json'), reportData);
  writeJson(path.join(path.dirname(artifactDir), 'latest.json'), reportData);

  return builtInRunResult(reportData);
}

export function readWorkspaceCleanupLineage(deps: WorkspaceCleanupDeps): any | null {
  if (!deps || !isNonEmptyString(deps.userDataPath)) return null;
  const latestPath = path.join(deps.userDataPath, 'loops', 'workspace-cleanup', 'latest.json');
  if (!fs.existsSync(latestPath)) return null;
  const latest = parseJson(fs.readFileSync(latestPath, 'utf8'), null);
  if (!latest) return null;
  const outcome: StopState = latest.actionPlan?.ownerDecisions?.length ? 'NEEDS_OWNER_DECISION' : 'DONE';
  const iter = {
    index: 0,
    runId: latest.artifactDir,
    workerOutcome: 'DONE',
    workerDone: true,
    validatorOutcome: 'NONE',
    validatorDone: false,
    computerUseEvidence: false,
    prExists: false,
    merged: false,
    headSha: null,
    fixbackAttempts: 0,
    tokens: 0,
    spendUsd: 0,
    stopState: outcome,
    madeProgress: true,
    artifactPath: latest.artifactDir,
    reportPath: latest.reportPath,
  };
  return {
    loopId: WORKSPACE_CLEANUP_LOOP_ID,
    iterations: [iter],
    iterationCount: 1,
    totalSpendUsd: 0,
    totalTokens: 0,
    lastProgressAt: 0,
    lastEvidence: iter,
    latestRunOutcome: outcome,
    lastArtifactPath: latest.artifactDir,
    lastReportPath: latest.reportPath,
  };
}

module.exports = {
  WORKSPACE_CLEANUP_LOOP_ID,
  WORKSPACE_CLEANUP_LOOP_SPEC,
  runWorkspaceCleanupLoop,
  readWorkspaceCleanupLineage,
};
