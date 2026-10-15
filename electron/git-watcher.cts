// git-watcher — per-task git index/HEAD watcher feeding state invalidation.
//
// Watches .git metadata (fs.watchFile poll; full-tree chokidar watchers are
// opt-in and expensive) and emits git:changed / state:invalidate. Extracted
// from local-core per the ARCHITECTURE.md strangler roadmap: self-contained
// event source with injected deps (events emitter, resolveTaskCwd, env,
// chokidarImpl) — local-core re-exports it so existing consumers and tests
// keep their import path.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let chokidar = null;
try {
  chokidar = require('chokidar');
} catch (err) {
  console.error('[ace] chokidar unavailable:', err.message);
}


let ignoreFactory = null;
try {
  ignoreFactory = require('ignore');
} catch (err) {
  console.error('[ace] ignore package unavailable:', err.message);
}

function shouldUseFullTreeGitWatcher({ env = process.env } = {}) {
  if (env?.ACE_DISABLE_GIT_WATCHER === '1') return false;
  return (
    env?.ACE_ENABLE_FULL_TREE_GIT_WATCHER === '1' ||
    env?.ACE_ENABLE_STARTUP_GIT_WATCHER === '1'
  );
}

function createGitWatcher(
  events,
  resolveTaskCwd,
  { env = process.env, chokidarImpl = chokidar, gitStatus = null, gitCurrentBranch = null } = {}
) {
  // Injected by local-core (the owner of the git CLI wrappers) — a require
  // here would be a cycle. Fail LOUDLY at construction when a caller that
  // needs totals forgot them; the original extraction bug hid exactly this
  // as an async ReferenceError that no test or boot probe surfaced.
  const readGitStatus = gitStatus || (async () => { throw new Error('git-watcher: gitStatus dependency not injected'); });
  const readGitBranch = gitCurrentBranch || (async () => { throw new Error('git-watcher: gitCurrentBranch dependency not injected'); });

  const entries = new Map();

  function gitRevParse(cwd, ...args) {
    try {
      return execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }

  function getGitStateWatchPaths(cwd) {
    const paths = new Set();
    const add = (absPath) => {
      const normalized = String(absPath || '').trim();
      if (!normalized) return;
      paths.add(normalized);
    };

    add(gitRevParse(cwd, '--git-path', 'HEAD'));
    add(gitRevParse(cwd, '--git-path', 'index'));
    add(gitRevParse(cwd, '--git-path', 'packed-refs'));
    add(gitRevParse(cwd, '--git-path', 'logs/HEAD'));

    const headRef = gitRevParse(cwd, '--symbolic-full-name', 'HEAD');
    if (headRef && headRef !== 'HEAD') {
      add(gitRevParse(cwd, '--git-path', headRef));
      add(gitRevParse(cwd, '--git-path', `logs/${headRef}`));
    }

    const upstreamRef = gitRevParse(cwd, '--symbolic-full-name', '@{upstream}');
    if (upstreamRef) {
      add(gitRevParse(cwd, '--git-path', upstreamRef));
      add(gitRevParse(cwd, '--git-path', `logs/${upstreamRef}`));
    }

    return paths;
  }

  function unwatchGitStatePath(entry, absPath) {
    if (!entry?.gitStatePollers?.has(absPath)) return;
    try { fs.unwatchFile(absPath); } catch {}
    entry.gitStatePollers.delete(absPath);
  }

  function reconcileGitStatePollers(cwd) {
    const entry = entries.get(cwd);
    if (!entry) return;

    const nextPaths = getGitStateWatchPaths(cwd);
    for (const absPath of nextPaths) {
      if (entry.gitStatePollers.has(absPath)) continue;
      try {
        fs.watchFile(absPath, { interval: 1000, persistent: true }, (cur, prev) => {
          if (
            cur.mtimeMs !== prev.mtimeMs ||
            cur.size !== prev.size ||
            cur.ino !== prev.ino ||
            cur.nlink !== prev.nlink
          ) {
            schedule(cwd);
          }
        });
        entry.gitStatePollers.add(absPath);
      } catch {}
    }

    for (const absPath of [...entry.gitStatePollers]) {
      if (!nextPaths.has(absPath)) {
        unwatchGitStatePath(entry, absPath);
      }
    }
  }

  function buildIgnoreMatcher(cwd) {
    if (!ignoreFactory) {

      return { ignores: () => false };
    }
    const ig = ignoreFactory();
    ig.add(GIT_WATCHER_BUILTIN_IGNORES);

    const candidates = [
      path.join(cwd, '.gitignore'),
      path.join(cwd, '.git', 'info', 'exclude'),
    ];
    for (const file of candidates) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw) ig.add(raw);
      } catch {

      }
    }
    return ig;
  }

  function ignoredPath(matcher, cwd, absPath) {
    let rel = path.relative(cwd, absPath);
    if (!rel || rel === '.') return false;
    if (rel.startsWith('..')) return false;
    rel = rel.replace(/\\/g, '/');


    if (rel === '.git/index' || rel === '.git/HEAD') return false;
    if (rel === '.git' || rel.startsWith('.git/')) return true;

    try {
      return matcher.ignores(rel);
    } catch {
      return false;
    }
  }

  async function refreshEntry(cwd) {
    const entry = entries.get(cwd);
    if (!entry) return;
    try {
      const [status, branch] = await Promise.all([
        readGitStatus(cwd),
        readGitBranch(cwd),
      ]);
      entry.totals = status.totals;
      entry.branch = branch;
      reconcileGitStatePollers(cwd);
      for (const taskId of entry.taskIds) {
        events.emit('git:changed', { taskId });
      }
      events.emit('state:invalidate');
    } catch (err) {
      console.error('[ace] git watcher refresh failed:', err.message);
    }
  }

  function schedule(cwd) {
    const entry = entries.get(cwd);
    if (!entry) return;
    if (entry.pending) clearTimeout(entry.pending);
    entry.pending = setTimeout(() => {
      entry.pending = null;
      void refreshEntry(cwd);
    }, 250);
  }

  // Called from git mutation handlers (stage/commit/reset/etc.) to push fresh
  // totals to the UI immediately rather than waiting on the watcher tick.
  // Returns a promise so callers can await the state broadcast.
  function touchLocalTotals(cwd) {
    if (!cwd) return Promise.resolve();
    if (!entries.has(cwd)) return Promise.resolve();
    return refreshEntry(cwd);
  }

  function attachTask(taskId) {
    if (env?.ACE_DISABLE_GIT_WATCHER === '1') return;
    const cwd = resolveTaskCwd(taskId);
    if (!cwd) return;
    let entry = entries.get(cwd);
    if (!entry) {
      const useFullTreeWatcher = shouldUseFullTreeGitWatcher({ env });
      const matcher = useFullTreeWatcher ? buildIgnoreMatcher(cwd) : null;
      const startedAt = Date.now();
      let watcher = null;
      // Full-worktree chokidar watchers are expensive across many Ace
      // worktrees, so require an explicit env opt-in for recursive watching.
      if (useFullTreeWatcher && chokidarImpl) {
        try {
          watcher = chokidarImpl.watch(cwd, {
            ignored: (absPath) => ignoredPath(matcher, cwd, absPath),
            ignoreInitial: true,
            persistent: true,
            followSymlinks: false,
            awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
            depth: 20,
          });
        } catch (err) {
          console.error('[ace] failed to start git watcher:', err.message);
          watcher = null;
        }
      }
      entry = {
        watcher,
        taskIds: new Set(),
        totals: { additions: 0, deletions: 0 },
        branch: null,
        pending: null,
        gitStatePollers: new Set(),
      };
      entries.set(cwd, entry);
      const onChange = () => schedule(cwd);
      if (watcher) {
        watcher.on('add', onChange);
        watcher.on('change', onChange);
        watcher.on('unlink', onChange);
        watcher.on('addDir', onChange);
        watcher.on('unlinkDir', onChange);
        watcher.on('error', (err) => console.error('[ace] git watcher error:', err.message));
        watcher.on('ready', () => {
          const elapsed = Date.now() - startedAt;
          if (elapsed > GIT_WATCHER_SLOW_INIT_MS) {
            const watchedDirs = Object.keys(watcher.getWatched?.() ?? {}).length;
            console.warn(
              `[ace] Slow git watcher init: ${cwd} took ${elapsed}ms ` +
              `(${watchedDirs} directories). Add large untracked paths to .gitignore, ` +
              `or unset ACE_ENABLE_FULL_TREE_GIT_WATCHER to disable full-tree file watching.`
            );
          }
        });
      }

      reconcileGitStatePollers(cwd);
      void refreshEntry(cwd);
    }
    entry.taskIds.add(taskId);
  }

  function detachTask(taskId) {
    const cwd = resolveTaskCwd(taskId);
    if (!cwd) return;
    const entry = entries.get(cwd);
    if (!entry) return;
    entry.taskIds.delete(taskId);
    if (entry.taskIds.size === 0) {
      if (entry.pending) clearTimeout(entry.pending);
      for (const abs of [...(entry.gitStatePollers || [])]) {
        unwatchGitStatePath(entry, abs);
      }
      try { entry.watcher?.close(); } catch {}
      entries.delete(cwd);
    }
  }

  function getTaskTotals(taskId) {
    const cwd = resolveTaskCwd(taskId);
    if (!cwd) return { additions: 0, deletions: 0 };
    const entry = entries.get(cwd);
    return entry ? entry.totals : { additions: 0, deletions: 0 };
  }

  function shutdown() {
    for (const [, entry] of entries) {
      if (entry.pending) clearTimeout(entry.pending);
      for (const abs of [...(entry.gitStatePollers || [])]) {
        unwatchGitStatePath(entry, abs);
      }
      try { entry.watcher?.close(); } catch {}
    }
    entries.clear();
  }

  return { attachTask, detachTask, getTaskTotals, touchLocalTotals, shutdown };
}

module.exports = { createGitWatcher, shouldUseFullTreeGitWatcher };
