// "Update Hermes" for the embedded Hermes agent + desktop app. Lives in Ace
// (not the fork) so the update LOGIC survives Ace updates while the patch
// series lives in the fork checkout (~/.hermes/hermes-agent, branch
// `ace/patches`, symlinked onto the external SSD).
//
// We deliberately do NOT reimplement git here. The fork ships its own
// `hermes update` CLI which already does the right, safe thing for the owner's
// checkout: it pulls the configured branch, auto-stashes/restores local source
// edits (updates.non_interactive_local_changes = "stash"), reinstalls deps,
// rebuilds the web UI (_build_web_ui) AND the desktop app (`hermes desktop
// --build-only`, only when one is already installed), then restarts the
// gateway. Ace's hermesCodeFingerprint watchdog restarts the embed sidecar
// on the new code. One command covers agent + desktop — they are the same repo.
//
// The only gap we fill: the CLI's branch-aware update fetches/compares against
// the `origin` remote (hardcoded — `git fetch origin <branch>`), but the
// checkout is created with `fork` + `upstream` remotes and NO `origin`, so the
// stock command dies with "fatal: 'origin' does not appear to be a git
// repository". We idempotently add an `origin` mirroring the owner's `fork`
// (the real update source) before invoking the CLI.
//
// All git/CLI side effects go through an injected `exec`, so this is fully
// unit-testable without a real checkout. `exec(cmd, args, { cwd })` resolves
// { code, stdout, stderr }.

const PATCH_BRANCH = 'ace/patches';

// A fork/patched branch — the default the embed tracks.
function isPatchBranch(branch: any) {
  const b = String(branch || '').trim();
  return b === PATCH_BRANCH || b.startsWith('ace/');
}

// Compare two dotted versions ("0.16.0" vs "0.15.1"). Returns 1/0/-1. Retained
// for the desktop/agent version-skew check below.
function compareSemver(a: any, b: any) {
  const pa = String(a || '0').split('.').map((n: any) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n: any) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// True when the built desktop app bundle is older than the agent (the skew that
// makes the embedded SPA call endpoints the backend lacks, or vice-versa).
function desktopBundleStale(agentVersion: any, desktopVersion: any) {
  if (!agentVersion || !desktopVersion) return false;
  return compareSemver(desktopVersion, agentVersion) < 0;
}

function makeGit(exec: any, cwd: any) {
  return async (args: any) => {
    const res = await exec('git', args, { cwd });
    return { code: res?.code ?? 1, out: String(res?.stdout || '').trim(), err: String(res?.stderr || '') };
  };
}

// Ensure the `origin` remote the hermes CLI expects exists. The checkout has
// `fork` + `upstream` but no `origin`; `hermes update --branch <x>` does
// `git fetch origin <x>`. We mirror `origin` onto the `fork` URL (the owner's
// fork — the real update source). Idempotent: a no-op when origin already
// resolves.
async function ensureOriginRemote(opts: any = {}) {
  const exec = opts.exec;
  const cwd = opts.cwd;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (typeof exec !== 'function') throw new Error('ensureOriginRemote requires an exec function');
  const git = makeGit(exec, cwd);

  const existing = await git(['remote', 'get-url', 'origin']);
  if (existing.code === 0 && existing.out) {
    return { ok: true, origin: existing.out, created: false };
  }
  // Prefer mirroring `fork` (the owner's publish/update source); fall back to
  // `upstream` only if there is no fork remote at all.
  const fork = await git(['remote', 'get-url', 'fork']);
  let url = fork.code === 0 ? fork.out : '';
  if (!url) {
    const upstream = await git(['remote', 'get-url', 'upstream']);
    url = upstream.code === 0 ? upstream.out : '';
  }
  if (!url) {
    return {
      ok: false,
      reason: 'no-source-remote',
      message: "Could not find a 'fork' or 'upstream' remote to point 'origin' at; the Hermes checkout looks misconfigured.",
    };
  }
  const add = await git(['remote', 'add', 'origin', url]);
  if (add.code !== 0) {
    return { ok: false, reason: 'origin-add', message: "Failed to add the 'origin' remote the updater needs.", stderr: add.err };
  }
  log(`Linked 'origin' → ${url} for the updater.`);
  return { ok: true, origin: url, created: true };
}

// Parse `hermes update --check` stdout into a behind-count.
//   "⚕ Update available: N commits behind origin/<branch>." → behind N
//   "✓ Already up to date."                                  → behind 0
//   anything else (✗ error, empty)                           → behind null (unknown)
function parseUpdateCheck(stdout: any) {
  const text = String(stdout || '');
  const m = text.match(/Update available:\s*(\d+)\s+commit/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return { behind: Number.isFinite(n) ? n : null };
  }
  if (/Already up to date/i.test(text)) return { behind: 0 };
  return { behind: null };
}

// Non-mutating "is an update available?" — ensures origin, then runs
// `hermes update --check --branch <branch>` and parses the count. Never throws;
// `ok:false` / `behind:null` means the check itself failed (offline, missing
// remote, CLI error) and the caller should treat it as "unknown" (no toast).
async function checkNativeHermesUpdate(opts: any = {}) {
  const exec = opts.exec;
  const cwd = opts.cwd;
  const hermesBin = opts.hermesBin || 'hermes';
  const branch = opts.branch || PATCH_BRANCH;
  const ref = `origin/${branch}`;
  if (typeof exec !== 'function') throw new Error('checkNativeHermesUpdate requires an exec function');

  const origin = await ensureOriginRemote({ exec, cwd });
  if (!origin.ok) {
    return { ok: false, ref, behind: null, fetchedAt: null, reason: origin.reason, message: origin.message };
  }

  const res = await exec(hermesBin, ['update', '--check', '--branch', branch], { cwd });
  const code = res?.code ?? 1;
  const stdout = String(res?.stdout || '');
  const stderr = String(res?.stderr || '');
  const parsed = parseUpdateCheck(stdout);
  const errored = code !== 0 || (parsed.behind == null && /✗/.test(stdout + stderr));
  if (errored && parsed.behind == null) {
    const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return { ok: false, ref, behind: null, fetchedAt: null, reason: 'check-failed', message: tail || 'hermes update --check failed.' };
  }
  return { ok: true, ref, behind: parsed.behind, fetchedAt: opts.nowIso || null };
}

// Apply the update by running the fork's own `hermes update`. Ensures origin,
// then `hermes update --yes --branch <branch>`. The CLI handles stash/pull/
// restore + dependency reinstall + web/desktop rebuild + gateway restart.
// Returns { ok, reason?, message?, branch }.
async function runNativeHermesUpdate(opts: any = {}) {
  const exec = opts.exec;
  const cwd = opts.cwd;
  const hermesBin = opts.hermesBin || 'hermes';
  const branch = opts.branch || PATCH_BRANCH;
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (typeof exec !== 'function') throw new Error('runNativeHermesUpdate requires an exec function');

  const origin = await ensureOriginRemote({ exec, cwd, onLog: log });
  if (!origin.ok) {
    return { ok: false, reason: origin.reason, message: origin.message, stderr: String(origin.stderr || '') };
  }

  log(`Running hermes update (branch ${branch}) — pulling the fork, reinstalling deps, and rebuilding the web + desktop app. This can take a few minutes…`);
  const res = await exec(hermesBin, ['update', '--yes', '--branch', branch], { cwd });
  const code = res?.code ?? 1;
  const stdout = String(res?.stdout || '');
  const stderr = String(res?.stderr || '');
  if (code !== 0) {
    const tail = (stderr || stdout).trim().split('\n').slice(-6).join('\n').slice(0, 800);
    return {
      ok: false,
      reason: 'update-failed',
      message: `Hermes update failed.${tail ? `\n${tail}` : ' Your checkout is unchanged.'}`,
      stderr: tail,
    };
  }
  log('Hermes update complete.');
  return { ok: true, branch };
}

module.exports = {
  PATCH_BRANCH,
  isPatchBranch,
  compareSemver,
  desktopBundleStale,
  ensureOriginRemote,
  parseUpdateCheck,
  checkNativeHermesUpdate,
  runNativeHermesUpdate,
};
