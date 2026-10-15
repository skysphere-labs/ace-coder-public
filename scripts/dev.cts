// Starts Vite, waits for it to announce its URL, then launches Electron with
// VITE_DEV_SERVER_URL set to that URL. Lets multiple worktrees run
// `npm run dev` in parallel — Vite auto-picks a free port and Electron
// connects to exactly that port.
//
// Also watches `electron/` for changes, recompiles the edited .cts to its
// sibling .cjs, and restarts the electron main process. Vite HMR handles
// the React renderer; this watcher plugs the gap for the main process so
// you don't have to Ctrl+C + `npm run dev` on every backend tweak.

const path = require('path');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const { compileElectron, compileElectronFile } = require('./compile-electron.cts');

const viteBin = path.resolve(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = require('electron');
const electronRoot = path.resolve(__dirname, '..', 'electron');
const aceCliSrcRoot = path.resolve(__dirname, '..', 'tools', 'ace', 'src');

function startVite() {
  const proc = spawn(process.execPath, [viteBin], { stdio: ['inherit', 'pipe', 'pipe'] });

  const urlPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const ansi = /\x1B\[[0-9;]*[A-Za-z]/g;
    const pipeWith = (stream: any, outStream: any) => {
      stream.on('data', (chunk: any) => {
        const text = chunk.toString();
        outStream.write(chunk);
        if (!settled) {
          const match = text.replace(ansi, '').match(/Local:\s+(https?:\/\/\S+)/);
          if (match) {
            settled = true;
            resolve(match[1].replace(/\/$/, ''));
          }
        }
      });
    };
    pipeWith(proc.stdout, process.stdout);
    pipeWith(proc.stderr, process.stderr);
    proc.on('exit', (code: any) => {
      if (!settled) {
        settled = true;
        reject(new Error(`vite exited before announcing URL (code ${code})`));
      }
    });
  });

  return { proc, urlPromise };
}

async function main() {
  // Electron loads `electron/main.cjs` (and everything it requires) as native
  // CJS — no tsx hook at runtime — so transpile every .cts to its .cjs
  // sibling before launching.
  await compileElectron();

  const { proc: vite, urlPromise } = startVite();
  let url: string;
  try {
    url = await urlPromise;
  } catch (err: any) {
    console.error('[dev]', err.message);
    process.exit(1);
  }

  const env = { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: url! };

  // Wrapped state machine: electron may exit because (a) the user quit
  // the app window, (b) our watcher killed it to spin up a replacement,
  // or (c) it crashed. `restartPending` lets the exit handler distinguish
  // (b) from (a)/(c) — only (b) suppresses the shutdown-cascade.
  let electron: any = null;
  let restartPending = false;
  let exiting = false;

  function spawnElectron() {
    const child = spawn(electronBin, ['.'], { stdio: 'inherit', env });
    child.on('exit', (code: any) => {
      if (restartPending) {
        restartPending = false;
        spawnElectron();
        return;
      }
      if (!exiting) shutdown(code ?? 0);
    });
    electron = child;
  }

  spawnElectron();

  const shutdown = (code: any) => {
    if (exiting) return;
    exiting = true;
    try { electron?.kill(); } catch {}
    try { vite.kill(); } catch {}
    try { watcher.close(); } catch {}
    try { cliWatcher.close(); } catch {}
    process.exit(code ?? 0);
  };

  vite.on('exit', (code: any) => shutdown(code ?? 0));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Debounced restart on electron/ changes. Multiple saves in quick
  // succession (e.g. editor autosave + formatter) collapse into one
  // relaunch. Ignores tests and the ace-control profiles dir — tests
  // aren't loaded in prod, and profiles JSON hot-reloads through the
  // controller's own chokidar watcher without a restart.
  const watcher = chokidar.watch(electronRoot, {
    ignored: [
      /(^|[\\/])\../, // dotfiles
      /__tests__/,
      /\.test\.(cts|ts)$/,
      /\.md$/,
      /\.cjs$/, // compiled output — don't feed our own writes back
      /[\\/]\.ace[\\/]worktrees[\\/]/,
    ],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  let restartTimer: any = null;
  const pendingFiles = new Set<string>();
  const queueRestart = (file: any) => {
    if (exiting) return;
    if (typeof file === 'string' && file.endsWith('.cts')) pendingFiles.add(file);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (exiting || !electron) return;
      // Recompile edited .cts files before restart, since electron loads
      // the compiled .cjs artifacts — not the TS source.
      try {
        await Promise.all(
          Array.from(pendingFiles).map((source) => compileElectronFile(source))
        );
      } catch (err: any) {
        process.stderr.write(`[dev] compile failed: ${err.message}\n`);
        pendingFiles.clear();
        return;
      }
      pendingFiles.clear();
      const rel = typeof file === 'string' ? path.relative(electronRoot, file) : 'unknown';
      process.stdout.write(`\n[dev] backend change: ${rel} — restarting electron main\n`);
      restartPending = true;
      try { electron.kill(); } catch {
        restartPending = false;
      }
    }, 150);
  };
  watcher.on('change', queueRestart);
  watcher.on('add', queueRestart);
  watcher.on('unlink', queueRestart);

  // The Ace CLI is a separate binary loaded outside electron, so its
  // .cts edits only need recompilation — no electron restart. Mirrors the
  // electron watcher's ignore list (tests, dotfiles, compiled .cjs output).
  const cliWatcher = chokidar.watch(aceCliSrcRoot, {
    ignored: [
      /(^|[\\/])\../,
      /__tests__/,
      /\.test\.(cts|ts)$/,
      /\.md$/,
      /\.cjs$/,
      /[\\/]\.ace[\\/]worktrees[\\/]/,
    ],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  const recompileAceCli = (file: any) => {
    if (exiting) return;
    if (typeof file !== 'string' || !file.endsWith('.cts')) return;
    compileElectronFile(file).catch((err: any) => {
      process.stderr.write(`[dev] ace CLI compile failed: ${err.message}\n`);
    });
  };
  cliWatcher.on('change', recompileAceCli);
  cliWatcher.on('add', recompileAceCli);
  cliWatcher.on('unlink', recompileAceCli);
}

main().catch((err) => {
  console.error('[dev] failed to start:', err);
  process.exit(1);
});
