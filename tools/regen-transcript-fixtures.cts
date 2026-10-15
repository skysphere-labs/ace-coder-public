#!/usr/bin/env node
/*
 * Regenerates transcript fixtures from real CLI session files.
 *
 * Usage: node tools/regen-transcript-fixtures.cjs
 *
 * Source paths are real CLI artifacts:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   ~/.gemini/tmp/references/chats/session-*.json
 *
 * The script copies (and lightly sanitizes) these files into
 * electron/ace-control/fixtures/. Fixtures remain real session files — the
 * sanitizer only drops a verbose `base_instructions.text` field from codex
 * session_meta lines to keep file sizes manageable.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'electron', 'ace-control', 'fixtures');

function sanitizeCodexLine(line: any) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return line;
  }
  if (evt.type === 'session_meta' && evt.payload?.base_instructions?.text) {
    evt.payload.base_instructions = { text: '<redacted for fixture size>' };
  }
  // Drop the giant developer-role developer instruction line.
  if (
    evt.type === 'response_item'
    && evt.payload?.type === 'message'
    && evt.payload?.role === 'developer'
  ) {
    evt.payload.content = [{ type: 'input_text', text: '<redacted developer prompt>' }];
  }
  return JSON.stringify(evt);
}

function copyCodex(srcPath: any, destDir: any, name: any) {
  fs.mkdirSync(destDir, { recursive: true });
  const raw = fs.readFileSync(srcPath, 'utf8').split('\n').filter(Boolean);
  const out = raw.map(sanitizeCodexLine).join('\n') + '\n';
  fs.writeFileSync(path.join(destDir, 'session.jsonl'), out);
  console.log(`wrote codex/${name}/session.jsonl (${raw.length} lines)`);
}

function copyGemini(srcPath: any, destDir: any, name: any) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, path.join(destDir, 'session.json'));
  console.log(`wrote gemini/${name}/session.json`);
}

function pickSmallestCodex() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir: any) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ path: full, size: fs.statSync(full).size });
      }
    }
  }
  walk(root);
  out.sort((a, b) => a.size - b.size);
  return out.slice(0, 3).map((x) => x.path);
}

function pickSmallestGemini() {
  const root = path.join(os.homedir(), '.gemini', 'tmp', 'references', 'chats');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root)) {
    if (!ent.endsWith('.json')) continue;
    const full = path.join(root, ent);
    out.push({ path: full, size: fs.statSync(full).size });
  }
  out.sort((a, b) => a.size - b.size);
  return out.slice(0, 3).map((x) => x.path);
}

function main() {
  const codex = pickSmallestCodex();
  const gemini = pickSmallestGemini();
  if (codex[0]) copyCodex(codex[0], path.join(FIXTURE_ROOT, 'codex', 'basic-session'), 'basic-session');
  if (codex[1]) copyCodex(codex[1], path.join(FIXTURE_ROOT, 'codex', 'reasoning-session'), 'reasoning-session');
  if (codex[2]) copyCodex(codex[2], path.join(FIXTURE_ROOT, 'codex', 'tool-session'), 'tool-session');
  if (gemini[0]) copyGemini(gemini[0], path.join(FIXTURE_ROOT, 'gemini', 'basic-session'), 'basic-session');
  if (gemini[1]) copyGemini(gemini[1], path.join(FIXTURE_ROOT, 'gemini', 'thoughts-session'), 'thoughts-session');
  if (gemini[2]) copyGemini(gemini[2], path.join(FIXTURE_ROOT, 'gemini', 'tool-session'), 'tool-session');
  if (!codex.length) console.warn('no codex sessions found; run codex CLI once to populate');
  if (!gemini.length) console.warn('no gemini sessions found; run gemini CLI once to populate');
}

main();
