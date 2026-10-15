// shell-path — PATH enhancement for the packaged app.
//
// A packaged .app launches with launchd's minimal PATH; agents and git need
// the user's real shell PATH plus the common tool bins. Extracted from
// local-core per the ARCHITECTURE.md strangler roadmap: pure environment
// logic with zero store coupling. enhanceShellPath() is invoked by local-core
// at module load (same boot point as before the extraction).

const path = require('path');
const { execFileSync } = require('child_process');

function commonBinPaths() {
  if (process.platform === 'win32') return [];
  const home = process.env.HOME || '';
  const paths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  if (home) {
    paths.push(
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.deno', 'bin'),
      path.join(home, '.volta', 'bin')
    );
    try {
      const nvmBase = path.join(home, '.nvm', 'versions', 'node');
      const versions = fs.readdirSync(nvmBase).sort().reverse();
      for (const v of versions) paths.push(path.join(nvmBase, v, 'bin'));
    } catch {}
  }
  return paths;
}

function mergePaths(primary, extras) {
  const seen = new Set();
  const out = [];
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const p of (primary || '').split(path.delimiter).filter(Boolean)) push(p);
  for (const p of extras) push(p);
  return out.join(path.delimiter);
}

function enhanceShellPath() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/zsh';
  let shellPath = null;
  for (const flags of [['-lic'], ['-c']]) {
    try {
      const output = execFileSync(
        shell,
        [...flags, 'echo __ACE_PATH__${PATH}__ACE_PATH__'],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const match = output.match(/__ACE_PATH__(.*?)__ACE_PATH__/);
      const resolved = match && match[1] && match[1].trim();
      if (resolved) { shellPath = resolved; break; }
    } catch {}
  }
  process.env.PATH = mergePaths(shellPath || process.env.PATH, commonBinPaths());
}


module.exports = { commonBinPaths, mergePaths, enhanceShellPath };
