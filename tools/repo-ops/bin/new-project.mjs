#!/usr/bin/env node
// new-project — scaffold a best-practice Cloudflare-stack repo in Enterprise or
// Solo mode. Renders tools/repo-ops/templates/{base,<mode>} into a target dir,
// substitutes tokens, enables git rerere, and writes .ace/repo.json.
//
// Usage:
//   node tools/repo-ops/bin/new-project.mjs --name my-app --mode enterprise|solo \
//        [--dir <path>] [--owner <gh-handle>] [--no-git]
//
// Doctrine: electron/assets/skills/ace-github-flow/SKILL.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(__dirname, '..', 'templates');

function parseArgs(argv) {
  const out = { mode: 'solo', git: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--owner') out.owner = argv[++i];
    else if (a === '--no-git') out.git = false;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function die(msg) {
  console.error(`new-project: ${msg}`);
  process.exit(1);
}

function tokens(name, owner) {
  const compatDate = new Date().toISOString().slice(0, 10);
  return {
    '{{project_name}}': name,
    '{{owner}}': owner,
    '{{compat_date}}': compatDate,
  };
}

function render(content, map) {
  let out = content;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

// Files are rendered as text unless clearly binary (none in our templates).
function copyTree(srcDir, dstDir, map) {
  if (!fs.existsSync(srcDir)) return [];
  const written = [];
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    // template filenames may be tokenized too (e.g. dot-prefixed)
    const dst = path.join(dstDir, render(entry.name, map).replace(/^dot__/, '.'));
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      written.push(...copyTree(src, dst, map));
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, render(fs.readFileSync(src, 'utf8'), map));
      written.push(path.relative(dstDir, dst));
    }
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.name) {
    console.log('Usage: new-project --name <name> --mode enterprise|solo [--dir <path>] [--owner <gh-handle>] [--no-git]');
    process.exit(args.help ? 0 : 1);
  }
  if (!['enterprise', 'solo'].includes(args.mode)) die(`--mode must be enterprise|solo (got ${args.mode})`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) die('--name must be kebab-case (a-z, 0-9, -)');

  let owner = args.owner;
  if (!owner) {
    try { owner = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || 'OWNER'; }
    catch { owner = 'OWNER'; }
  }
  owner = owner.replace(/^@/, '');

  const dir = path.resolve(args.dir || path.join(process.cwd(), args.name));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`target dir not empty: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });

  const map = tokens(args.name, owner);
  const base = copyTree(path.join(TEMPLATES, 'base'), dir, map);
  const overlay = copyTree(path.join(TEMPLATES, args.mode), dir, map);

  // repo descriptor consumed by ace-github-flow doctrine + bootstrap
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.ace', 'repo.json'),
    JSON.stringify({ name: args.name, mode: args.mode, owner, stack: 'cloudflare-workers-hono-d1', createdBy: 'ace-github-flow/new-project' }, null, 2) + '\n',
  );

  if (args.git) {
    const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: dir, stdio: 'pipe' });
    try {
      run('git', ['init', '-q', '-b', 'main']);
      run('git', ['config', 'rerere.enabled', 'true']);          // auto conflict-resolution memory
      run('git', ['config', 'rerere.autoUpdate', 'true']);
      run('git', ['add', '-A']);
      run('git', ['commit', '-q', '-m', `chore: scaffold ${args.name} (${args.mode}) via ace-github-flow`]);
    } catch (e) {
      console.warn(`new-project: git init step warned: ${String(e.message || e).split('\n')[0]}`);
    }
  }

  const fileCount = new Set([...base, ...overlay]).size + 1;
  console.log(JSON.stringify({
    ok: true,
    name: args.name,
    mode: args.mode,
    owner,
    dir,
    files: fileCount,
    next: [
      `cd ${dir}`,
      'pnpm install',
      'pnpm run dev   # local Worker on http://localhost:8787',
      `node ${path.join(__dirname, 'gh-bootstrap.mjs')} --repo <owner>/${args.name} --mode ${args.mode}`,
    ],
  }, null, 2));
}

main();
