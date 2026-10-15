#!/usr/bin/env node
/*
 * Smoke test: spawn real `codex` CLI, wait for it to write a session file,
 * feed it a known prompt, and assert the V2 adapter extracts the expected
 * transcript entries. Skips cleanly if codex isn't installed.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeCodexEvent } = require('../electron/ace-control/transcript/normalize/codex.cjs');

function which(cmd: any) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim();
}

function createSandboxHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-codex-smoke-'));
  fs.mkdirSync(path.join(root, '.codex', 'sessions'), { recursive: true });
  return root;
}

async function main() {
  if (!which('codex')) {
    console.log('SKIP: codex CLI not installed (install it to run this smoke test)');
    process.exit(0);
  }

  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    console.log('SKIP: Codex network access is disabled in this sandbox');
    process.exit(0);
  }

  const runEnv = { ...process.env };
  if (process.env.CODEX_SMOKE_HOME) {
    runEnv.HOME = path.resolve(process.env.CODEX_SMOKE_HOME);
    fs.mkdirSync(path.join(runEnv.HOME, '.codex', 'sessions'), { recursive: true });
  } else if (process.env.CODEX_SANDBOX) {
    runEnv.HOME = createSandboxHome();
  }

  const sessionDir = path.join(runEnv.HOME || os.homedir(), '.codex', 'sessions');
  const seen = new Set();
  function snapshotFiles() {
    const out = new Set();
    function walk(dir: any) {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.jsonl')) out.add(full);
      }
    }
    walk(sessionDir);
    return out;
  }
  for (const f of snapshotFiles()) seen.add(f);

  const prompt = `ace-v2 smoke @ ${Date.now()}`;
  console.log(`[smoke] prompting codex: ${prompt}`);
  const proc = spawn('codex', ['exec', '--skip-git-repo-check', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: runEnv,
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });

  const exitCode = await new Promise((resolve) => proc.on('exit', resolve));
  if (exitCode !== 0) {
    console.error(`[smoke] codex exited non-zero (${exitCode})`);
    if (stdout.trim()) console.error('[smoke] stdout:\n', stdout.slice(-1200));
    if (stderr.trim()) console.error('[smoke] stderr:\n', stderr.slice(-1200));
    process.exit(1);
  }

  // Find the new session file.
  const after = snapshotFiles();
  const fresh = [...after].find((f) => !seen.has(f));
  if (!fresh) {
    console.error('[smoke] no new codex session file written under', sessionDir);
    process.exit(1);
  }
  console.log('[smoke] session file:', fresh);

  const lines = fs.readFileSync(fresh, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  const warnings = [];
  const keyed = new Map();
  let seq = 0;
  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    const ops = normalizeCodexEvent(evt, { streamId: 's' });
    for (const op of ops) {
      if (op.kind === 'append') entries.push({ ...op.entry, id: seq++ });
      else if (op.kind === 'upsert') {
        if (keyed.has(op.key)) {
          const id = keyed.get(op.key);
          const idx = entries.findIndex((e) => e.id === id);
          if (idx >= 0) {
            const next = op.build(entries[idx]);
            if (next) entries[idx] = { ...next, id };
          }
        } else {
          const entry = op.build(null);
          if (!entry) continue;
          const id = seq++;
          keyed.set(op.key, id);
          entries.push({ ...entry, id });
        }
      } else if (op.kind === 'warn') warnings.push(op.code);
    }
  }

  const userEntry = entries.find((e) => e.role === 'user' && e.text && e.text.includes('ace-v2 smoke'));
  const agentEntry = entries.find((e) => e.role === 'agent' && e.text);
  if (!userEntry) {
    console.error('[smoke] no user entry matching our prompt was extracted');
    process.exit(1);
  }
  if (!agentEntry) {
    console.error('[smoke] no agent reply entry was extracted');
    process.exit(1);
  }
  console.log(`[smoke] OK  user=${!!userEntry} agent=${!!agentEntry} warnings=${warnings.length}`);
  if (warnings.length) {
    console.log('[smoke] warnings (first 5):', warnings.slice(0, 5));
  }
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
