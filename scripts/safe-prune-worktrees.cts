// Safe prune for historical Ace worker worktrees.
//
// Default mode is dry-run: enumerate every directory under
// `<repo>/.ace/worktrees/` and the active external SSD worktree bucket,
// gather safety facts (dirty/stash/PR/merge state/recent activity), classify
// each as DELETE or SKIP with a reason, and print a JSON summary. With
// `--apply`, only entries classified DELETE are removed via `git worktree
// remove --force`. Branches are kept by default; pass `--delete-branches` to
// also drop the local branch ref.
//
// Run from anywhere — the repo root is auto-detected. Or pass `--root <path>`.
//
// Usage:
//   tsx scripts/safe-prune-worktrees.cts                  # dry-run, repo root
//   tsx scripts/safe-prune-worktrees.cts --apply          # delete eligible
//   tsx scripts/safe-prune-worktrees.cts --no-gh          # skip PR lookups
//   tsx scripts/safe-prune-worktrees.cts --max-age-hours 1
//   tsx scripts/safe-prune-worktrees.cts --json-only      # quiet + JSON only
//
// See docs/ops/safe-prune-worktrees.md for the operator playbook.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  resolveExternalDataRoot,
  repoWorktreeKey,
} = require('../electron/external-data-root.cts');

// Ace stream states. The taxonomy is from `ace state --help`:
//   booting | awaiting-input | busy | turn-complete | awaiting-approval |
//   interrupted | error | dormant
// Anything other than `dormant` (with `live: true`) is a non-terminal stream
// — there's a real PTY behind it that could be writing to the worktree.
const TERMINAL_STREAM_STATES = new Set(['dormant']);

// Pure: given collected facts, decide whether the worktree is safe to delete.
// Conservative: every "skip" reason short-circuits before any merge evidence
// can override it. Never returns delete unless at least one positive merge
// signal holds (local merge ancestry into origin/main OR a MERGED PR), and
// no Ace stream is currently live in this worktree.
//
// Facts shape:
// {
//   path: string, branch: string|null, registered: boolean,
//   clean: boolean, noStash: boolean, mergedIntoBase: boolean,
//   pr: { state: 'OPEN'|'MERGED'|'CLOSED'|'NONE'|'UNKNOWN', number?, url? },
//   mtimeMs: number, recentThresholdMs: number,
//   hasLock: boolean, isCwd: boolean, ghEnabled: boolean,
//   activeCheckOk: boolean,
//   activeStream: { live: boolean, state: string, streamId?: string, agent?: string } | null,
// }
function decide(facts) {
  if (facts.isCwd) return { action: 'skip', reason: 'active-cwd' };
  if (!facts.registered) return { action: 'skip', reason: 'not-registered' };
  if (facts.hasLock) return { action: 'skip', reason: 'lock-file-present' };
  if (!facts.clean) return { action: 'skip', reason: 'dirty' };
  if (!facts.noStash) return { action: 'skip', reason: 'stash' };
  if (!facts.branch) return { action: 'skip', reason: 'orphan-no-branch' };

  // Active-stream guard. Must come before any positive deletion path. If we
  // could not query Ace's stream registry at all (ace missing /
  // failed / non-JSON output), skip conservatively. The only way past this is
  // an explicit `--no-active-check` from the operator (sets activeCheckOk=true
  // and activeStream=null on every facts row).
  if (!facts.activeCheckOk) {
    return { action: 'skip', reason: 'active-check-unavailable' };
  }
  if (facts.activeStream && facts.activeStream.live && !TERMINAL_STREAM_STATES.has(facts.activeStream.state)) {
    return {
      action: 'skip',
      reason: 'active-stream',
      detail:
        (facts.activeStream.agent ? facts.activeStream.agent + ' ' : '') +
        facts.activeStream.state +
        (facts.activeStream.streamId ? ' (' + facts.activeStream.streamId + ')' : ''),
    };
  }

  if (facts.pr && facts.pr.state === 'OPEN') {
    return {
      action: 'skip',
      reason: 'open-pr',
      detail: facts.pr.url || (facts.pr.number ? '#' + facts.pr.number : undefined),
    };
  }
  const recent = Date.now() - facts.mtimeMs < facts.recentThresholdMs;
  if (recent) return { action: 'skip', reason: 'recent-activity' };

  const prMerged = facts.pr && facts.pr.state === 'MERGED';
  if (!facts.mergedIntoBase && !prMerged) {
    if (!facts.ghEnabled || !facts.pr || facts.pr.state === 'UNKNOWN' || facts.pr.state === 'NONE') {
      return { action: 'skip', reason: 'pr-unknown-no-merge-evidence' };
    }
    return { action: 'skip', reason: 'unmerged' };
  }
  return { action: 'delete' };
}

// ----- I/O helpers below this line -----

function parseArgs(argv) {
  const out = {
    apply: false,
    noGh: false,
    noActiveCheck: false,
    jsonOnly: false,
    maxAgeHours: 24,
    deleteBranches: false,
    root: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--no-gh') out.noGh = true;
    else if (a === '--no-active-check') out.noActiveCheck = true;
    else if (a === '--json-only') out.jsonOnly = true;
    else if (a === '--delete-branches') out.deleteBranches = true;
    else if (a === '--root') out.root = argv[++i] || null;
    else if (a === '--max-age-hours') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v >= 0) out.maxAgeHours = v;
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit();
    } else {
      console.error('unknown arg: ' + a);
      process.exit(2);
    }
  }
  return out;
}

function printHelpAndExit() {
  process.stdout.write(
    [
      'safe-prune-worktrees — dry-run by default; --apply to delete.',
      '',
      'Flags:',
      '  --apply              actually remove eligible worktrees',
      '  --no-gh              skip GitHub PR lookups (offline mode)',
      '  --no-active-check    skip the live ace stream check (explicit',
      '                       offline override; ONLY use when you know no',
      '                       Ace streams are running)',
      '  --max-age-hours N    require mtime older than N hours (default 24)',
      '  --delete-branches    also delete the local branch (git branch -D)',
      '  --root <path>        repo root (default: auto-detected)',
      '  --json-only          suppress human banner; emit JSON only',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

function findRepoRoot(start) {
  // From any worktree, `git rev-parse --git-common-dir` returns the main
  // repo's .git path. The main checkout is its parent. This handles the case
  // where the script runs from inside a Ace worker worktree (whose
  // .ace/worktrees/ does not exist) and still finds the canonical
  // `.ace/worktrees/` directory under the main checkout.
  const r = spawnSync('git', ['-C', start, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error('not inside a git repo: ' + start);
  }
  let commonDir = (r.stdout || '').trim();
  if (!commonDir) throw new Error('git rev-parse --git-common-dir returned empty');
  if (!path.isAbsolute(commonDir)) commonDir = path.resolve(start, commonDir);
  return path.dirname(commonDir);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo].concat(args), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function tryGit(repo, args) {
  const r = spawnSync('git', ['-C', repo].concat(args), { encoding: 'utf8' });
  if (r.status === 0) return { ok: true, out: (r.stdout || '').toString() };
  return { ok: false, out: ((r.stdout || '') + (r.stderr || '')).toString() };
}

function listRegisteredWorktrees(repo) {
  const raw = git(repo, ['worktree', 'list', '--porcelain']);
  const out = [];
  let curPath = null;
  let curBranch = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (curPath) out.push({ path: curPath, branch: curBranch });
      curPath = line.slice('worktree '.length).trim();
      curBranch = null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      curBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === '' && curPath) {
      out.push({ path: curPath, branch: curBranch });
      curPath = null;
      curBranch = null;
    }
  }
  if (curPath) out.push({ path: curPath, branch: curBranch });
  return out;
}

function dirMtimeMs(p) {
  // Largest mtime among the directory itself and its immediate children. Cheap
  // and good enough as a "recent activity" sniff — full recursion is wasteful
  // and a real worktree's HEAD/index changes show up at the top level anyway.
  let max = 0;
  try {
    max = fs.statSync(p).mtimeMs;
    for (const name of fs.readdirSync(p)) {
      try {
        const m = fs.statSync(path.join(p, name)).mtimeMs;
        if (m > max) max = m;
      } catch {
        // ignore unreadable child
      }
    }
  } catch {
    // ignore unreadable dir
  }
  return max;
}

function ghPrState(repo, branch) {
  const r = spawnSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number,url,mergedAt', '--limit', '5'],
    { cwd: repo, encoding: 'utf8' },
  );
  if (r.status !== 0) return { state: 'UNKNOWN' };
  let parsed;
  try {
    parsed = JSON.parse((r.stdout || '').toString());
  } catch {
    return { state: 'UNKNOWN' };
  }
  if (!parsed || parsed.length === 0) return { state: 'NONE' };
  const open = parsed.find((p) => (p.state || '').toUpperCase() === 'OPEN');
  if (open) return { state: 'OPEN', number: open.number, url: open.url };
  const merged = parsed.find((p) => (p.state || '').toUpperCase() === 'MERGED' || p.mergedAt);
  if (merged) return { state: 'MERGED', number: merged.number, url: merged.url };
  const closed = parsed[0];
  return {
    state: (closed.state || 'CLOSED').toUpperCase(),
    number: closed.number,
    url: closed.url,
  };
}

function stashListForBranch(repo, branch) {
  const r = tryGit(repo, ['stash', 'list', '--format=%gs']);
  if (!r.ok) return { ok: false, out: '' };
  const lines = r.out.split('\n').filter(Boolean);
  // Stash subject format examples:
  //   "On <branch>: <user message>"
  //   "WIP on <branch>: <sha> <commit subject>"
  const re = new RegExp('(^On |^WIP on )' + branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':');
  const matches = lines.filter((line) => re.test(line));
  return { ok: true, out: matches.join('\n') };
}

function isMergedIntoBase(repo, branch, base) {
  return tryGit(repo, ['merge-base', '--is-ancestor', branch, base]).ok;
}

// Query `ace ls --json` and build a map from canonical worktree path
// to the most-active stream living in it. "Most active" = any live, non-dormant
// stream beats any other; otherwise the first stream we see wins.
//
// Returns { ok: false } when ace is missing, exits non-zero, or
// returns un-parseable / unexpectedly-shaped output. Callers must treat
// `ok: false` as "I cannot tell whether anything is running" — that maps to
// the conservative `active-check-unavailable` skip in decide().
function collectActiveStreams() {
  const r = spawnSync('ace', ['ls', '--json'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.error?.message || 'ace ls failed').toString().trim() };
  }
  let parsed;
  try {
    parsed = JSON.parse((r.stdout || '').toString());
  } catch (e) {
    return { ok: false, reason: 'ace ls returned non-JSON' };
  }
  const streams = parsed && parsed.data && Array.isArray(parsed.data.streams) ? parsed.data.streams : null;
  if (!streams) return { ok: false, reason: 'ace ls JSON missing data.streams' };

  const byCwd = new Map();
  for (const s of streams) {
    if (!s || typeof s.cwd !== 'string' || !s.cwd) continue;
    const key = path.resolve(s.cwd);
    const incoming = {
      live: !!s.live,
      state: String(s.state || ''),
      streamId: s.streamId || undefined,
      agent: s.agent || undefined,
      taskId: s.taskId || undefined,
    };
    const existing = byCwd.get(key);
    if (!existing) {
      byCwd.set(key, incoming);
      continue;
    }
    // Prefer a live, non-dormant entry over anything else.
    const incomingActive = incoming.live && !TERMINAL_STREAM_STATES.has(incoming.state);
    const existingActive = existing.live && !TERMINAL_STREAM_STATES.has(existing.state);
    if (incomingActive && !existingActive) byCwd.set(key, incoming);
  }
  return { ok: true, byCwd };
}

function fetchBase(repo) {
  // Refresh origin/main before any merge-base check so stale local main does
  // not bless a worktree as merged when the actual integration lives on the remote.
  tryGit(repo, ['fetch', 'origin', 'main', '--quiet']);
  return 'origin/main';
}

function discoverWorktreesDirs(repo) {
  const legacyDir = path.join(repo, '.ace', 'worktrees');
  const dirs = [legacyDir];
  const currentUserDataPath =
    process.env.ACE_HOME ||
    process.env.ACE_USER_DATA_PATH ||
    path.join(repo, '.ace');
  const resolved = resolveExternalDataRoot({ currentUserDataPath });
  if (resolved.active && resolved.root) {
    dirs.push(path.join(resolved.root, 'worktrees', repoWorktreeKey(repo)));
  }
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startRoot = args.root ? path.resolve(args.root) : process.cwd();
  const repo = findRepoRoot(startRoot);
  const worktreesDirs = discoverWorktreesDirs(repo);
  const recentThresholdMs = args.maxAgeHours * 60 * 60 * 1000;

  const existingWorktreesDirs = worktreesDirs.filter((dir) => fs.existsSync(dir));
  if (!existingWorktreesDirs.length) {
    const empty = {
      repo,
      worktreesDir: worktreesDirs[0],
      worktreesDirs,
      apply: args.apply,
      candidates: [],
      summary: { total: 0, deletable: 0, skipped: 0, deleted: 0 },
    };
    process.stdout.write(JSON.stringify(empty, null, 2) + '\n');
    return;
  }

  const base = fetchBase(repo);
  const registered = listRegisteredWorktrees(repo);
  const registeredByPath = new Map(registered.map((r) => [path.resolve(r.path), r]));

  // Gather active-stream state once for the whole run.
  let activeCheckOk = true;
  let activeByCwd = new Map();
  let activeCheckError = null;
  if (args.noActiveCheck) {
    activeCheckOk = true; // operator explicitly opted out
  } else {
    const res = collectActiveStreams();
    if (res.ok) {
      activeByCwd = res.byCwd;
    } else {
      activeCheckOk = false;
      activeCheckError = res.reason || 'unknown';
    }
  }

  const dirEntries = existingWorktreesDirs.flatMap((worktreesDir) =>
    fs
      .readdirSync(worktreesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(worktreesDir, e.name))
  );

  const cwdResolved = path.resolve(process.cwd());

  const reports = [];
  for (const wtPath of dirEntries) {
    const reg = registeredByPath.get(path.resolve(wtPath));
    const branch = (reg && reg.branch) || null;
    const resolved = path.resolve(wtPath);
    const isCwd = cwdResolved === resolved || cwdResolved.startsWith(resolved + path.sep);

    const status = reg ? tryGit(wtPath, ['status', '--porcelain']) : { ok: false, out: '' };
    // `git stash list` is repo-global; filter by parsing "On <branch>:" or
    // "WIP on <branch>:" prefixes from the message line. Passing the branch as
    // a pathspec via `-- <branch>` does not work — it filters by file path,
    // not branch name.
    const stash = branch ? stashListForBranch(repo, branch) : { ok: true, out: '' };
    const hasLock = fs.existsSync(path.join(wtPath, '.git', 'index.lock'));
    const mtimeMs = dirMtimeMs(wtPath);

    let mergedIntoBase = false;
    if (branch) mergedIntoBase = isMergedIntoBase(repo, branch, base);

    let pr = { state: 'UNKNOWN' };
    if (branch && !args.noGh) pr = ghPrState(repo, branch);

    const activeStream = activeByCwd.get(path.resolve(wtPath)) || null;

    const facts = {
      path: wtPath,
      branch,
      registered: !!reg,
      clean: status.ok && status.out.trim() === '',
      noStash: stash.ok && stash.out.trim() === '',
      mergedIntoBase,
      pr,
      mtimeMs,
      recentThresholdMs,
      hasLock,
      isCwd,
      ghEnabled: !args.noGh,
      activeCheckOk,
      activeStream,
    };

    const decision = decide(facts);
    const exposed = Object.assign({}, facts);
    delete exposed.recentThresholdMs;
    delete exposed.ghEnabled;
    delete exposed.activeCheckOk;
    reports.push({ path: wtPath, branch, decision, facts: exposed });
  }

  let deleted = 0;
  if (args.apply) {
    for (const r of reports) {
      if (r.decision.action !== 'delete') continue;
      const rm = tryGit(repo, ['worktree', 'remove', '--force', r.path]);
      if (!rm.ok) {
        // Defensive: don't rm -rf a path git did not own. Just leave it and
        // surface the failure in the summary.
        r.applyError = rm.out.trim();
        continue;
      }
      if (args.deleteBranches && r.branch) {
        tryGit(repo, ['branch', '-D', r.branch]);
      }
      r.applied = true;
      deleted++;
    }
    tryGit(repo, ['worktree', 'prune']);
  }

  const summary = {
    repo,
    worktreesDir: worktreesDirs[0],
    worktreesDirs,
    apply: args.apply,
    base,
    recentThresholdHours: args.maxAgeHours,
    ghEnabled: !args.noGh,
    activeCheck: {
      enabled: !args.noActiveCheck,
      ok: activeCheckOk,
      error: activeCheckError,
      streamCount: activeByCwd.size,
    },
    candidates: reports,
    summary: {
      total: reports.length,
      deletable: reports.filter((r) => r.decision.action === 'delete').length,
      skipped: reports.filter((r) => r.decision.action === 'skip').length,
      deleted,
    },
  };

  if (!args.jsonOnly && !args.apply) {
    process.stderr.write(
      'safe-prune-worktrees: dry-run (use --apply to delete). ' +
        summary.summary.deletable +
        ' eligible / ' +
        summary.summary.total +
        ' total\n',
    );
  } else if (!args.jsonOnly && args.apply) {
    process.stderr.write(
      'safe-prune-worktrees: apply mode. deleted=' +
        summary.summary.deleted +
        ' skipped=' +
        summary.summary.skipped +
        '\n',
    );
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err && err.stack) || String(err));
    process.exit(1);
  });
}

module.exports = { decide };
