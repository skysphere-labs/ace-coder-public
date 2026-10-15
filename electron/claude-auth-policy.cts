// Claude lanes in Ace are subscription-only. Claude Code gives API/cloud
// credentials higher precedence than an existing Pro/Max/Team/Enterprise
// OAuth login, so inherited process state must never be allowed to silently
// switch a lane to metered billing.

const { execFile } = require('child_process');

const CLAUDE_SUBSCRIPTION_BLOCKED_ENV_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CLAUDE_STARTUP_HEADER_RE =
  /(?:^|\n)[ \t]*▐▛███▜▌[ \t]+Claude Code v\d+(?:\.\d+){2,3}\b[^\n]*\n[ \t]*▝▜█████▛▘[ \t]+[^\n]*\n/i;
// ONLY "API Usage Billing" — the metered mode. The CLI also brands a valid
// first-party setup-token login "Claude API" (that is the login shape
// classifyClaudeSubscriptionAuthStatus accepts as oauth_token/firstParty, and
// the one docs/architecture/lane-auth.md keeps CLAUDE_CODE_OAUTH_TOKEN for), so
// killing on that label terminates a lane whose auth we just accepted. Every
// spawn path runs the subscription preflight before this detector ever sees a
// byte, so the label alone is not evidence of metered billing.
const CLAUDE_API_BILLING_STARTUP_RE =
  /(?:^|\n)[ \t]*▐▛███▜▌[ \t]+Claude Code v\d+(?:\.\d+){2,3}\b[^\n]*\n[ \t]*▝▜█████▛▘[ \t]+[^\n]*[·•]\s*API Usage Billing[ \t]*(?=\n|$)/i;
const DEFAULT_STARTUP_PROBE_CHARS = 8 * 1024;
const DEFAULT_STARTUP_PROBE_LINES = 16;
const CLAUDE_API_BILLING_ERROR =
  'Claude API Usage Billing blocked: a Claude subscription login is required';

const CLAUDE_API_BILLING_BLOCK_MESSAGE =
  '\x1bc\x1b[31m[ace] Stopped this Claude lane: Claude reported an API-billed startup mode. ' +
  'Ace allows Claude subscription OAuth only; API and cloud-provider credentials are removed on relaunch.\x1b[0m\r\n';

function sanitizeClaudeSubscriptionEnv(env: any) {
  if (!env || typeof env !== 'object') return env;
  for (const name of CLAUDE_SUBSCRIPTION_BLOCKED_ENV_VARS) delete env[name];
  return env;
}

// Remote lanes launch through an interactive login shell, which can re-add an
// API key from shell rc files after Ace has constructed the daemon env. Wrap
// the final command with `env -u` so the values are removed at exec time.
function wrapClaudeSubscriptionCommand(command: any, args: any[] = []) {
  const unsetArgs = CLAUDE_SUBSCRIPTION_BLOCKED_ENV_VARS.flatMap((name) => ['-u', name]);
  return {
    cmd: 'env',
    args: [...unsetArgs, String(command || 'claude'), ...(Array.isArray(args) ? args : [])],
  };
}

function stripTerminalControl(text: any) {
  return String(text ?? '').replace(ANSI_CSI_RE, '').replace(/\r\n?|\u2028/g, '\n');
}

function isClaudeApiBillingBanner(text: any) {
  return CLAUDE_API_BILLING_STARTUP_RE.test(stripTerminalControl(text));
}

// Banner output can be split across PTY chunks. Retain only the first bounded
// startup frame and require Claude's real two-line structure: the version line
// immediately followed by the model/billing line. Once either subscription or
// API mode is known, later prompts, logs, and explanatory prose are not probed.
function createClaudeStartupAuthDetector({
  maxChars = DEFAULT_STARTUP_PROBE_CHARS,
  maxLines = DEFAULT_STARTUP_PROBE_LINES,
}: any = {}) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Number(maxChars)
    : DEFAULT_STARTUP_PROBE_CHARS;
  const lineLimit = Number.isFinite(Number(maxLines)) && Number(maxLines) > 0
    ? Number(maxLines)
    : DEFAULT_STARTUP_PROBE_LINES;
  let rawStartup = '';
  let complete = false;

  return {
    push(chunk: any) {
      if (complete) return null;
      // Normalize the complete raw buffer so a CSI sequence split across PTY
      // chunks is removed once its terminating byte arrives.
      rawStartup += String(chunk ?? '');
      const startup = stripTerminalControl(rawStartup);
      const lines = startup.split('\n');
      const candidate = lines.slice(0, lineLimit).join('\n');
      if (CLAUDE_API_BILLING_STARTUP_RE.test(candidate)) {
        complete = true;
        return 'api';
      }
      if (CLAUDE_STARTUP_HEADER_RE.test(candidate)) complete = true;
      if (rawStartup.length >= limit || lines.length > lineLimit) complete = true;
      return null;
    },
    get complete() {
      return complete;
    },
  };
}

function classifyClaudeSubscriptionAuthStatus(stdout: any, { hasSetupToken = false }: any = {}) {
  let status: any;
  try {
    status = JSON.parse(String(stdout || '').replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, reason: 'auth-status-invalid' };
  }
  const authMethod = typeof status?.authMethod === 'string' ? status.authMethod : 'unknown';
  const apiProvider = typeof status?.apiProvider === 'string' ? status.apiProvider : 'unknown';
  const isSubscriptionAuth =
    authMethod === 'claude.ai' ||
    (hasSetupToken && authMethod === 'oauth_token' && apiProvider === 'firstParty');
  if (status?.loggedIn === true && isSubscriptionAuth) {
    return {
      ok: true,
      authMethod,
      subscriptionType:
        typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
    };
  }
  // Only an EXPLICIT logged-out payload earns the spawnable reason: interactive
  // callers are allowed to start on it, so a partial, empty, or schema-changed
  // body must fall through to the hard block rather than open the lane.
  if (status?.loggedIn === false && typeof status?.authMethod === 'string') {
    return { ok: false, reason: 'logged-out', authMethod };
  }
  return { ok: false, reason: 'non-subscription-auth', authMethod };
}

// The one failure state a user can resolve from inside the lane.
function isClaudeLoggedOutAuthResult(result: any) {
  return result?.ok !== true && result?.reason === 'logged-out';
}

// `claude auth status --json` reports logged out as exit 1; a kill or any other
// code is a transport failure, not an answer.
const CLAUDE_LOGGED_OUT_EXIT_CODE = 1;

function isExpectedClaudeLoggedOutExit(error: any) {
  if (!error) return true;
  if (error.killed || error.signal) return false;
  return error.code === CLAUDE_LOGGED_OUT_EXIT_CODE;
}

// Reason must carry the exit code / signal / stderr; one opaque string made
// every field report undiagnosable.
function describeClaudeAuthProbeFailure(error: any, stderr: any) {
  if (error?.killed) return 'auth-status-timeout';
  if (error?.signal) return `auth-status-killed-${String(error.signal).toLowerCase()}`;
  const code = error?.code;
  if (code === 'ENOENT') return 'auth-status-missing-cli';
  if (typeof code === 'string' && code) return `auth-status-spawn-${code.toLowerCase()}`;
  const detail = String(stderr || error?.message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const exit = Number.isInteger(code) ? `-exit-${code}` : '';
  return detail ? `auth-status-failed${exit}: ${detail}` : `auth-status-failed${exit || ''}`;
}

// Node refuses to spawn .cmd/.bat without a shell (EINVAL, CVE-2024-27980).
function claudeAuthProbeNeedsShell(bin: any, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin || ''));
}

// Inside cmd.exe double quotes every separator (& | < > ^) is literal, so the
// only path characters that can still break out are a quote, a newline, and %
// (variable expansion). Refuse those rather than try to escape them.
const CMD_UNSAFE_BIN_CHARS = /["%\r\n]/;

function claudeAuthProbeBinIsShellSafe(bin: any) {
  return !CMD_UNSAFE_BIN_CHARS.test(String(bin || ''));
}

// `shell` concatenates argv unquoted, and the default install path has spaces.
function quoteClaudeAuthProbeBin(bin: any) {
  return `"${String(bin || '')}"`;
}

// Non-PTY Claude paths can send a model request before any startup banner is
// rendered. `claude auth status --json` performs no inference and identifies a
// Claude.ai subscription login. Explicit CLAUDE_CODE_OAUTH_TOKEN credentials
// are subscription setup-tokens, reported by the CLI as first-party OAuth.
function verifyClaudeSubscriptionAuth({
  bin = 'claude',
  cwd,
  env = process.env,
  execFileImpl = execFile,
  // A cold CLI start behind on-access AV scanning routinely passes 5s.
  timeoutMs = 15000,
  platform = process.platform,
}: any = {}) {
  const hasSetupToken = Boolean(String(env?.CLAUDE_CODE_OAUTH_TOKEN || '').trim());
  const needsShell = claudeAuthProbeNeedsShell(bin, platform);
  return new Promise((resolve) => {
    const done = (result: any) => resolve(result);
    if (needsShell && !claudeAuthProbeBinIsShellSafe(bin)) {
      return done({ ok: false, reason: 'auth-status-unsafe-bin-path' });
    }
    try {
      execFileImpl(
        needsShell ? quoteClaudeAuthProbeBin(bin) : bin,
        ['auth', 'status', '--json'],
        {
          cwd,
          env,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          ...(needsShell ? { shell: true } : {}),
        },
        (error: any, stdout: any, stderr: any) => {
          const classified = classifyClaudeSubscriptionAuthStatus(stdout, { hasSetupToken });
          if (!error) return done(classified);
          // The logged-out answer arrives on exit 1 and nothing else; any other
          // failure is a transport failure whatever its stdout looks like.
          if (isExpectedClaudeLoggedOutExit(error) && isClaudeLoggedOutAuthResult(classified)) {
            return done(classified);
          }
          return done({ ok: false, reason: describeClaudeAuthProbeFailure(error, stderr) });
        }
      );
    } catch (err: any) {
      done({ ok: false, reason: describeClaudeAuthProbeFailure(err, null) });
    }
  });
}

function claudeSubscriptionAuthError(result: any) {
  // Headless callers cannot host an interactive /login; give the fix, not a code.
  if (isClaudeLoggedOutAuthResult(result)) {
    // Ace lanes run on the machine's own CLI login (no account vault to add a
    // token to), so /login in a Claude tab or a terminal is the whole recovery.
    return new Error(
      'Claude is not signed in. Open a Claude tab (or a terminal) and run /login.'
    );
  }
  const method = result?.authMethod && result.authMethod !== 'unknown'
    ? ` (${result.authMethod})`
    : '';
  return new Error(
    `Claude subscription authentication required${method}: ${result?.reason || 'verification-failed'}`
  );
}

module.exports = {
  CLAUDE_SUBSCRIPTION_BLOCKED_ENV_VARS,
  CLAUDE_API_BILLING_BLOCK_MESSAGE,
  CLAUDE_API_BILLING_ERROR,
  sanitizeClaudeSubscriptionEnv,
  wrapClaudeSubscriptionCommand,
  isClaudeApiBillingBanner,
  createClaudeStartupAuthDetector,
  classifyClaudeSubscriptionAuthStatus,
  isClaudeLoggedOutAuthResult,
  isExpectedClaudeLoggedOutExit,
  CLAUDE_LOGGED_OUT_EXIT_CODE,
  claudeAuthProbeNeedsShell,
  claudeAuthProbeBinIsShellSafe,
  describeClaudeAuthProbeFailure,
  verifyClaudeSubscriptionAuth,
  claudeSubscriptionAuthError,
};
