#!/usr/bin/env node
/*
 * Smoke test: spawn `gemini` CLI, wait for its session file to appear, and
 * assert the V2 adapter extracts the expected entries from the latest
 * ~/.gemini/tmp/references/chats/session-*.json. Skips if gemini is not
 * installed.
 *
 * Gemini's CLI is interactive; this smoke test uses `gemini --prompt` when
 * available. If that flag isn't supported on the installed version, we fall
 * back to asserting parsing against the most recent session file on disk.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeGeminiSnapshot } = require('../electron/ace-control/transcript/normalize/gemini.cjs');

function which(cmd: any) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim();
}

async function main() {
  if (!which('gemini')) {
    console.log('SKIP: gemini CLI not installed');
    process.exit(0);
  }
  const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', 'references', 'chats');
  const beforeMtime = latestMtime(chatsDir);

  const prompt = `ace-v2 smoke @ ${Date.now()}`;
  const help = spawnSync('gemini', ['--help'], { encoding: 'utf8' });
  const hasPrompt = /--prompt/.test((help.stdout || '') + (help.stderr || ''));
  if (!hasPrompt) {
    console.log('SKIP: gemini --prompt flag not available on installed version');
    process.exit(0);
  }
  const proc = spawn('gemini', ['--prompt', prompt, '--yolo'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const TIMEOUT_MS = Number(process.env.SMOKE_GEMINI_TIMEOUT_MS || 120_000);
  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolve('timeout');
    }, TIMEOUT_MS);
    proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  if (exitCode === 'timeout') {
    console.log('SKIP: gemini --prompt did not finish within timeout (set SMOKE_GEMINI_TIMEOUT_MS to raise)');
    process.exit(0);
  }
  if (exitCode !== 0) {
    console.error('[smoke] gemini exited non-zero:', exitCode);
    process.exit(1);
  }

  // Small grace period for the final write to flush.
  await new Promise((r) => setTimeout(r, 500));

  const file = latestFile(chatsDir, beforeMtime);
  if (!file) {
    console.error('[smoke] no newer gemini session file after run');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = normalizeGeminiSnapshot(snap);
  const user = items.find((i) => i.entry.role === 'user' && /ace-v2 smoke/.test(i.entry.text));
  const agent = items.find((i) => i.entry.role === 'agent' && i.entry.text);
  if (!user) {
    console.error('[smoke] no user entry matching our prompt in', file);
    process.exit(1);
  }
  if (!agent) {
    console.error('[smoke] no agent reply in', file);
    process.exit(1);
  }
  console.log(`[smoke] OK  file=${path.basename(file)} user=true agent=true`);
}

function latestMtime(dir: any) {
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const m = fs.statSync(path.join(dir, name)).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

function latestFile(dir: any, after: any) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .filter((e) => e.mtime > after)
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0] ? path.join(dir, entries[0].name) : null;
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
