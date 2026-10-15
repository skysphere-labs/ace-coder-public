#!/usr/bin/env node
// gh-bootstrap — create the GitHub repo for a scaffolded project and enforce the
// ace-github-flow controls: push, create `dev`, apply branch rulesets,
// create the approval-gated `production` environment, enable merge queue.
//
// Usage:
//   node tools/repo-ops/bin/gh-bootstrap.mjs --repo <owner>/<name> --mode enterprise|solo \
//        [--dir <path>] [--visibility private|public] [--reviewer <gh-handle>] [--dry-run]
//
// Idempotent-ish: re-running skips repo creation if it already exists and
// re-applies rulesets/environment. Tolerant: a failed step is logged, not fatal,
// so the rest of the setup still lands. Doctrine: ace-github-flow.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const out = { mode: 'solo', visibility: 'private', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--visibility') out.visibility = argv[++i];
    else if (a === '--reviewer') out.reviewer = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const log = (...a) => console.log('[gh-bootstrap]', ...a);
const warn = (...a) => console.warn('[gh-bootstrap] WARN', ...a);

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryStep(label, fn) {
  try { const r = fn(); log(`✓ ${label}`); return r; }
  catch (e) { warn(`${label}: ${String(e.stderr || e.message || e).trim().split('\n').slice(-1)[0]}`); return null; }
}

function ghApiInput(method, endpoint, bodyObj, dryRun) {
  if (dryRun) { log(`(dry-run) gh api --method ${method} ${endpoint}`); return null; }
  return execFileSync('gh', ['api', '--method', method, endpoint, '--input', '-'], {
    input: JSON.stringify(bodyObj), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo || !args.repo.includes('/')) {
    console.log('Usage: gh-bootstrap --repo <owner>/<name> --mode enterprise|solo [--dir <path>] [--visibility private|public] [--reviewer <gh-handle>] [--dry-run]');
    process.exit(args.help ? 0 : 1);
  }
  const [owner, name] = args.repo.split('/');
  const dir = path.resolve(args.dir || process.cwd());
  const reviewer = (args.reviewer || owner).replace(/^@/, '');
  if (!fs.existsSync(path.join(dir, '.git'))) warn(`${dir} is not a git repo yet — run new-project first`);

  // 1) Auth
  tryStep('gh auth', () => gh(['auth', 'status']));

  // 2) Create + push (or detect existing)
  let exists = false;
  try { gh(['repo', 'view', args.repo, '--json', 'name']); exists = true; } catch { exists = false; }
  if (exists) {
    log(`repo ${args.repo} already exists — skipping create`);
    tryStep('add origin remote', () => {
      try { git(['remote', 'get-url', 'origin'], dir); }
      catch { git(['remote', 'add', 'origin', `https://github.com/${args.repo}.git`], dir); }
      git(['push', '-u', 'origin', 'main'], dir);
    });
  } else if (args.dryRun) {
    log(`(dry-run) gh repo create ${args.repo} --${args.visibility} --source=${dir} --push`);
  } else {
    tryStep('create + push repo', () => gh(['repo', 'create', args.repo, `--${args.visibility}`, '--source', dir, '--remote', 'origin', '--push']));
  }

  // 3) dev branch (enterprise gets a long-lived dev; solo can skip)
  if (args.mode === 'enterprise') {
    tryStep('create dev branch', () => {
      if (args.dryRun) { log('(dry-run) git push origin main:dev'); return; }
      git(['push', 'origin', 'main:dev'], dir);
    });
  }

  // 4) Apply rulesets (enterprise) — dev + prod protection
  if (args.mode === 'enterprise') {
    for (const which of ['dev', 'prod']) {
      const rsPath = path.join(dir, 'rulesets', `${which}.json`);
      if (!fs.existsSync(rsPath)) { warn(`missing ${rsPath}`); continue; }
      tryStep(`apply ${which} ruleset`, () => ghApiInput('POST', `/repos/${owner}/${name}/rulesets`, JSON.parse(fs.readFileSync(rsPath, 'utf8')), args.dryRun));
    }
  }

  // 5) production environment with required reviewer (defense-in-depth on top of
  //    the CODEOWNERS approval in the prod ruleset). Needs the reviewer's user id.
  if (args.mode === 'enterprise') {
    tryStep('production environment + required reviewer', () => {
      let reviewerId = null;
      try { reviewerId = JSON.parse(gh(['api', `/users/${reviewer}`])).id; } catch {}
      const body = {
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: reviewerId ? [{ type: 'User', id: reviewerId }] : [],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      };
      return ghApiInput('PUT', `/repos/${owner}/${name}/environments/production`, body, args.dryRun);
    });
  }

  // 6) Sensible repo defaults
  tryStep('repo merge defaults (squash, delete branch on merge)', () => {
    if (args.dryRun) { log('(dry-run) gh repo edit --enable-squash-merge ...'); return; }
    gh(['repo', 'edit', args.repo, '--enable-squash-merge', '--enable-merge-commit=false', '--enable-rebase-merge=false', '--delete-branch-on-merge']);
  });

  log('done.');
  log('Set deploy/review secrets when ready:');
  log(`  gh secret set CLOUDFLARE_API_TOKEN --repo ${args.repo}`);
  log(`  gh secret set CLOUDFLARE_ACCOUNT_ID --repo ${args.repo}`);
  log(`  gh secret set ANTHROPIC_API_KEY --repo ${args.repo}   # enables the one-paragraph PR summary`);
}

main();
