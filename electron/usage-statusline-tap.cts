// Statusline tap: Claude Code's statusline feature pipes a JSON payload to a
// user-configured shell command on every update, and for Claude.ai
// subscribers that payload carries server-reported rate limits
// (rate_limits.five_hour / seven_day with used_percentage and resets_at).
// This module installs a tiny wrapper script as the statusline command that
// mirrors those payloads into the selected profile's usage directory so the meter can read
// official percentages instead of guessing quotas. Any pre-existing user
// statusline command is chained so its display is preserved. The payload
// contains no credentials.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function usageDataDir() {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'usage');
}

// One cache file per Claude config dir, so multiple accounts (via
// CLAUDE_CONFIG_DIR profiles) never collide.
function tapPaths(configDir: any = claudeConfigDir(), usageDir: any = usageDataDir()) {
  const hash = crypto.createHash('sha256').update(String(configDir)).digest('hex').slice(0, 12);
  return {
    configDir,
    usageDir,
    cacheFile: path.join(usageDir, `claude-${hash}.json`),
    scriptFile: path.join(usageDir, `statusline-tap-${hash}.sh`),
    backupFile: path.join(usageDir, `statusline-backup-${hash}.json`),
    settingsFile: path.join(configDir, 'settings.json'),
  };
}

function shellSingleQuote(value: any) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildTapScript(cacheFile: any, userCommand: any) {
  const lines = [
    '#!/bin/sh',
    '# Ace usage tap (auto-generated; safe to delete).',
    '# Mirrors the Claude Code statusline JSON so the Ace usage meter can',
    '# show official rate-limit percentages. Contains no credentials.',
    'umask 077',
    'input=$(cat)',
    '# Only payloads that carry rate_limits are cached, so an early-session',
    '# payload never overwrites the last known-good limits.',
    'case "$input" in',
    "  *'\"rate_limits\"'*)",
    `    cache=${shellSingleQuote(cacheFile)}`,
    '    mkdir -p "$(dirname "$cache")" 2>/dev/null',
    '    tmp="$cache.tmp.$$"',
    `    printf '%s' "$input" > "$tmp" 2>/dev/null && mv -f "$tmp" "$cache" 2>/dev/null`,
    '    ;;',
    'esac',
  ];
  if (userCommand) {
    lines.push('# Chain the statusline command that was configured before the tap.');
    lines.push(`printf '%s' "$input" | /bin/sh -c ${shellSingleQuote(userCommand)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function readJsonFile(p: any) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Idempotent. Returns the tap paths on success, null when there is nothing to
// install into (no Claude config dir) or the settings file cannot be safely
// rewritten.
function ensureStatuslineTap(configDir: any = claudeConfigDir(), usageDir: any = usageDataDir()) {
  const paths = tapPaths(configDir, usageDir);
  let configStat;
  try { configStat = fs.statSync(paths.configDir); } catch { return null; }
  if (!configStat.isDirectory()) return null;

  let settings: any = {};
  if (fs.existsSync(paths.settingsFile)) {
    settings = readJsonFile(paths.settingsFile);
    // Never rewrite a settings file we could not parse — that would clobber
    // the user's configuration.
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  }

  const current = settings.statusLine;
  const alreadyTapped =
    !!current && current.type === 'command' && current.command === paths.scriptFile;
  if (alreadyTapped && fs.existsSync(paths.scriptFile)) {
    // Upgrade path: a tap installed by an older build can predate the current
    // generator (e.g. the rate_limits guard that keeps an early-session payload
    // from clobbering the last known-good meter). Rewrite the script in place
    // when its content drifts; the chained user command is the backed-up
    // pre-tap value.
    const prev = readJsonFile(paths.backupFile)?.statusLine;
    const chained =
      prev?.type === 'command' && typeof prev.command === 'string' ? prev.command : null;
    const desired = buildTapScript(paths.cacheFile, chained);
    let onDisk = null;
    try { onDisk = fs.readFileSync(paths.scriptFile, 'utf8'); } catch { /* unreadable -> rewrite */ }
    if (onDisk !== desired) {
      fs.writeFileSync(paths.scriptFile, desired);
      fs.chmodSync(paths.scriptFile, 0o755);
    }
    return paths;
  }

  fs.mkdirSync(paths.usageDir, { recursive: true });

  // The user command to chain: the live settings value on first install, or
  // the backed-up original when the tap script went missing.
  let userCommand = null;
  if (!alreadyTapped && current?.type === 'command' && typeof current.command === 'string') {
    userCommand = current.command;
  } else if (alreadyTapped) {
    const prev = readJsonFile(paths.backupFile)?.statusLine;
    if (prev?.type === 'command' && typeof prev.command === 'string') userCommand = prev.command;
  }

  // Back up the original statusLine once; never overwrite an existing backup,
  // it holds the true pre-tap value used for restore.
  if (!fs.existsSync(paths.backupFile)) {
    fs.writeFileSync(
      paths.backupFile,
      JSON.stringify({ configDir: paths.configDir, statusLine: current ?? null }, null, 2) + '\n'
    );
  }

  fs.writeFileSync(paths.scriptFile, buildTapScript(paths.cacheFile, userCommand));
  fs.chmodSync(paths.scriptFile, 0o755);

  if (!alreadyTapped) {
    settings.statusLine = {
      ...(current && typeof current === 'object' ? current : {}),
      type: 'command',
      command: paths.scriptFile,
    };
    fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  return paths;
}

// Restores the pre-tap statusLine setting and removes the tap script/backup.
// The cache file is left behind; it is harmless display data.
function removeStatuslineTap(configDir: any = claudeConfigDir(), usageDir: any = usageDataDir()) {
  const paths = tapPaths(configDir, usageDir);
  const settings = readJsonFile(paths.settingsFile);
  if (settings && settings.statusLine?.command === paths.scriptFile) {
    const original = readJsonFile(paths.backupFile)?.statusLine;
    if (original) settings.statusLine = original;
    else delete settings.statusLine;
    fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  for (const p of [paths.scriptFile, paths.backupFile]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

module.exports = {
  tapPaths,
  buildTapScript,
  ensureStatuslineTap,
  removeStatuslineTap,
};
