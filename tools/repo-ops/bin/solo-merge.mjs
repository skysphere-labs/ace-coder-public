#!/usr/bin/env node
// solo-merge — the "easy, auto-resolving merge to main" for Solo-mode repos.
// Rebases <branch> onto the freshest main with git rerere reusing previously
// recorded conflict resolutions automatically, then fast-forwards main. New
// conflict classes are resolved once (by you) and remembered for next time.
//
// Usage:
//   node tools/repo-ops/bin/solo-merge.mjs [<branch>] [--remote origin] [--base main] [--no-ff-only] [--dir <path>]
//
// Exit 0 = merged. Exit 3 = genuine conflict that rerere could not auto-resolve
// (resolve the listed files, `git add` them, re-run — the resolution is then
// remembered). Doctrine: ace-github-flow (Solo flow).
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const out = { remote: 'origin', base: 'main', ffOnly: true, maxRetries: 3 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') out.remote = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--no-ff-only') out.ffOnly = false;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--max-retries') out.maxRetries = Number(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else pos.push(a);
  }
  out.branch = pos[0];
  return out;
}

function isPushRejection(error) {
  const text = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`;
  return /non-fast-forward|fetch first|rejected|failed to push some refs/i.test(text);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: solo-merge [<branch>] [--remote origin] [--base main] [--no-ff-only] [--dir <path>] [--max-retries 3]');
    process.exit(0);
  }
  const cwd = path.resolve(args.dir || process.cwd());
  const git = (gitArgs, opts = {}) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const gitQuiet = (gitArgs) => { try { return git(gitArgs); } catch (e) { return e; } };
  const maxRetries = Number.isFinite(args.maxRetries) && args.maxRetries > 0 ? Math.floor(args.maxRetries) : 3;

  const branch = args.branch || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch === args.base) { console.error(`solo-merge: refusing to merge ${args.base} into itself; pass a feature branch`); process.exit(1); }

  // Ensure rerere is on for this repo (idempotent).
  try { git(['config', 'rerere.enabled', 'true']); git(['config', 'rerere.autoUpdate', 'true']); } catch {}

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    console.log(`[solo-merge] attempt ${attempt}/${maxRetries}: fetching ${args.remote}…`);
    git(['fetch', args.remote, '--prune', '--quiet']);

    console.log(`[solo-merge] rebasing ${branch} onto ${args.remote}/${args.base} (rerere auto-resolve)…`);
    git(['checkout', branch]);
    const rebase = gitQuiet(['rebase', `${args.remote}/${args.base}`]);
    if (rebase instanceof Error) {
      // rerere may have staged resolutions already; try to continue once.
      const status = git(['status', '--porcelain']);
      const unresolved = status.split('\n').filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l)).map((l) => l.slice(3));
      if (unresolved.length === 0) {
        console.log('[solo-merge] rerere resolved all conflicts — continuing rebase…');
        try { git(['-c', 'core.editor=true', 'rebase', '--continue']); }
        catch (e) { console.error('[solo-merge] rebase --continue failed:', String(e.stderr || e.message)); process.exit(3); }
      } else {
        console.error('[solo-merge] unresolved conflicts (resolve, `git add`, then re-run — rerere will remember):');
        for (const f of unresolved) console.error('   ', f);
        process.exit(3);
      }
    }

    console.log(`[solo-merge] fast-forwarding ${args.base}…`);
    git(['checkout', args.base]);
    git(['reset', '--hard', `${args.remote}/${args.base}`]);
    git(['merge', args.ffOnly ? '--ff-only' : '--no-edit', branch]);
    console.log(`[solo-merge] pushing ${args.base}…`);
    const push = gitQuiet(['push', args.remote, args.base]);
    if (!(push instanceof Error)) {
      console.log(`[solo-merge] ✓ ${branch} merged into ${args.base} and pushed.`);
      return;
    }
    if (!isPushRejection(push) || attempt === maxRetries) {
      console.error(`[solo-merge] push rejected after ${attempt}/${maxRetries} attempt(s):`, String(push.stderr || push.message));
      process.exit(3);
    }
    console.error('[solo-merge] push rejected because base moved; retrying after fetch/rebase…');
  }
}

main();
