// autoship-token — resolve the owner-auth token for the auto-ship / loop-ship
// lane WITHOUT a shell environment, so the PACKAGED app (which does not inherit
// the shell's ACE_OWNER_AUTH_TOKEN) can still let the owner-approved loop-ship
// merge to main.
//
// Precedence (first non-empty wins):
//   1. process.env.ACE_OWNER_AUTH_TOKEN   — the historical source (dev shells / CI).
//   2. ops-config `autoship.token`        — the operator's LOCAL settings file
//      (ACE_HOME/ops-config.json, or ~/.ace-coder/ops-config.json). Its presence
//      IS the owner's standing authorization for the ship lane.
//
// SECRET DISCIPLINE: this module only ever RETURNS the token to an in-process
// caller. It never logs it, never prints it, and never writes it anywhere. Callers
// must reference the token by NAME (a tokenRef) in any persisted spec/catalog and
// resolve it here at runtime — the raw value must never touch the ledger, the
// loops catalog, or a log line.

const fs = require('fs');
const os = require('os');
const path = require('path');

function opsConfigPath(home: string = os.homedir()): string {
  const configured = String(process.env.ACE_HOME || '').trim();
  return path.join(configured || path.join(home, '.ace-coder'), 'ops-config.json');
}

/**
 * Read `autoship.token` from the operator's local ops-config
 * (ACE_HOME/ops-config.json, or ~/.ace-coder/ops-config.json).
 * Returns '' when no file exists, the file is unparseable, or the field is
 * absent/blank. Never throws.
 */
function readAutoshipTokenFromConfig(home: string = os.homedir()): string {
  try {
    const raw = fs.readFileSync(opsConfigPath(home), 'utf8');
    const cfg = JSON.parse(raw);
    const autoship = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.autoship : null;
    const token = autoship && typeof autoship === 'object' && !Array.isArray(autoship) ? autoship.token : undefined;
    if (typeof token === 'string' && token.trim()) return token.trim();
  } catch {
    /* missing / unparseable → fail-closed '' */
  }
  return '';
}

/**
 * Resolve the owner-auth token: env first, then the ops-config `autoship.token`.
 * Returns '' when neither is configured (fail-closed — no token ⇒ no auto-merge).
 */
function resolveOwnerAuthToken(): string {
  const env = String(process.env.ACE_OWNER_AUTH_TOKEN || '').trim();
  if (env) return env;
  return readAutoshipTokenFromConfig();
}

module.exports = {
  resolveOwnerAuthToken,
  readAutoshipTokenFromConfig,
};
