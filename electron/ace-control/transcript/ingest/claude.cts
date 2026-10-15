// Persistent bidirectional Claude Code `stream-json` client.
//
// Spawns the canonical Lane-0 recipe (proven in docs/ops/spike/) and keeps the
// process alive across many turns. stdout is newline-delimited JSON; each parsed
// event is handed to `onEvent` raw (index.cts normalizes via normalize/claude).
// Control round-trips (init, permission answers, interrupt, set-permission-mode)
// are written to stdin as control_request/control_response frames.
//
// Reuses the agent-cli-driver env hygiene so the spawned CLI attributes to the
// right Ace instance (ACE_SOCK reinjection past the ACE_* sanitizer)
// and runs with an empty MCP config.

const { spawn } = require('child_process');

const driver = (() => {
  try {
    return require('../../../agent-cli-driver.cjs');
  } catch (err: any) {
    if (err?.code !== 'MODULE_NOT_FOUND' || !String(err?.message || '').includes('agent-cli-driver')) {
      throw err;
    }
    return require('../../../agent-cli-driver.cts');
  }
})();
const claudeAuthPolicy = require('../../../claude-auth-policy.cts');

const emptyMcp = (() => {
  // ensureEmptyMcpConfigPath is not exported; replicate the empty-config write
  // through the driver's sanitizer path by lazily building one here.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.tmpdir(), 'ace');
  const file = path.join(dir, 'claude-empty-mcp.json');
  const EMPTY = '{"mcpServers":{}}';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== EMPTY) {
      fs.writeFileSync(file, EMPTY);
    }
  } catch { /* fall through; CLI will error visibly if unreadable */ }
  return file;
})();

const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizePermissionMode(mode: any): string {
  const m = String(mode || '').trim();
  return VALID_PERMISSION_MODES.has(m) ? m : 'default';
}

function buildSpawnArgs(permissionMode: string, effort: any): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--replay-user-messages',
    '--verbose',
    '--permission-mode', permissionMode,
    '--permission-prompt-tool', 'stdio',
    '--strict-mcp-config',
    '--mcp-config', emptyMcp,
  ];
  const e = String(effort || '').trim().toLowerCase();
  if (e && VALID_EFFORTS.has(e)) args.push('--effort', e);
  return args;
}

function createClaudeStreamClient(opts: any = {}) {
  const bin = opts.bin || 'claude';
  const cwd = opts.cwd || process.cwd();
  const spawnImpl = opts.spawnImpl || spawn;
  const verifySubscriptionAuth =
    opts.verifySubscriptionAuth || claudeAuthPolicy.verifyClaudeSubscriptionAuth;
  let permissionMode = normalizePermissionMode(opts.permissionMode);
  const effort = opts.effort;
  const extraEnv = opts.env || {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : () => {};
  const onExit = typeof opts.onExit === 'function' ? opts.onExit : () => {};

  let child: any = null;
  let started = false;
  let closed = false;
  let authPending = false;
  let exitNotified = false;
  let apiBillingBlocked = false;
  let stdoutBuf = '';
  let stderrTail = '';
  let intSeq = 0;
  let permSeq = 0;
  // Track open permission requests so respondToApproval can validate the id.
  const pendingApprovals = new Set<string>();
  const pendingWrites: any[] = [];
  const stdoutAuthDetector = claudeAuthPolicy.createClaudeStartupAuthDetector();
  const stderrAuthDetector = claudeAuthPolicy.createClaudeStartupAuthDetector();

  function emitWarning(code: string, error?: any) {
    try {
      onWarning({ code, error: error == null ? undefined : String(error?.message || error) });
    } catch { /* never let a warning callback break ingest */ }
  }

  function notifyExit(info: any) {
    if (exitNotified) return;
    exitNotified = true;
    try { onExit(info); } catch { /* ignore */ }
  }

  function writeStdin(obj: any) {
    if (!child && started && authPending && !closed) {
      pendingWrites.push(obj);
      return true;
    }
    if (!child || !child.stdin || child.stdin.destroyed) {
      emitWarning('claude:stdin-unavailable');
      return false;
    }
    try {
      child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err: any) {
      emitWarning('claude:stdin-write', err);
      return false;
    }
  }

  function dispatchEvent(raw: any) {
    try {
      onEvent(raw);
    } catch (err: any) {
      emitWarning('claude:onEvent', err);
    }
  }

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch (err: any) {
      emitWarning('claude:parse', err);
      return;
    }
    // Surface permission asks so an approval entry appears, and remember the
    // id so respondToApproval can answer it.
    if (obj && obj.type === 'control_request' && obj.request && obj.request.subtype === 'can_use_tool' && obj.request_id) {
      pendingApprovals.add(obj.request_id);
    }
    dispatchEvent(obj);
  }

  function onStdout(chunk: Buffer | string) {
    if (stdoutAuthDetector.push(chunk) === 'api') {
      blockApiBilling();
      return;
    }
    stdoutBuf += chunk.toString();
    let nl = stdoutBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
      nl = stdoutBuf.indexOf('\n');
    }
  }

  function onStderr(chunk: Buffer | string) {
    if (stderrAuthDetector.push(chunk) === 'api') {
      blockApiBilling();
      return;
    }
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-4000);
  }

  function failSubscriptionAuth(result: any) {
    authPending = false;
    if (closed) return;
    closed = true;
    pendingWrites.length = 0;
    const error = claudeAuthPolicy.claudeSubscriptionAuthError(result);
    emitWarning('claude:subscription-auth-required', error);
    notifyExit({ code: null, signal: null, error: error.message, stderr: error.message });
  }

  function blockApiBilling() {
    if (apiBillingBlocked) return;
    apiBillingBlocked = true;
    closed = true;
    pendingWrites.length = 0;
    const error = new Error(claudeAuthPolicy.CLAUDE_API_BILLING_ERROR);
    emitWarning('claude:api-billing-blocked', error);
    try { child?.kill('SIGTERM'); } catch {}
    notifyExit({ code: null, signal: 'SIGTERM', error: error.message, stderr: error.message });
  }

  function spawnClient(env: any, args: string[]) {
    if (closed) return;
    try {
      child = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      emitWarning('claude:spawn', err);
      closed = true;
      notifyExit({ code: null, signal: null, error: String(err?.message || err) });
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', (err: any) => emitWarning('claude:proc', err));
    child.on('exit', (code: any, signal: any) => {
      closed = true;
      // Flush any trailing buffered line.
      if (!apiBillingBlocked && stdoutBuf.trim()) {
        handleLine(stdoutBuf);
        stdoutBuf = '';
      }
      const nonzero = typeof code === 'number' && code !== 0;
      notifyExit({ code, signal, stderr: nonzero ? stderrTail.trim() : undefined });
    });

    // Init handshake — must be sent once before turns flow.
    writeStdin({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {} } });
    for (const frame of pendingWrites.splice(0)) writeStdin(frame);
  }

  function start() {
    if (started) return;
    started = true;
    const aceSock = (() => {
      try {
        return driver.resolveAceSockForSpawn();
      } catch {
        return null;
      }
    })();
    const env = {
      ...driver.sanitizeAgentSpawnEnv(process.env),
      ...(aceSock ? { ACE_SOCK: aceSock } : {}),
      ...(process.env.ACE_USER_DATA_TAG ? { ACE_USER_DATA_TAG: process.env.ACE_USER_DATA_TAG } : {}),
      ...(process.env.ACE_HOME ? { ACE_HOME: process.env.ACE_HOME } : {}),
      ...(process.env.ACE_ARTIFACT_ROOT ? { ACE_ARTIFACT_ROOT: process.env.ACE_ARTIFACT_ROOT } : {}),
      ...extraEnv,
    };
    // Sanitize once after extraEnv is merged so overrides cannot restore API auth.
    claudeAuthPolicy.sanitizeClaudeSubscriptionEnv(env);
    const args = buildSpawnArgs(permissionMode, effort);
    authPending = true;
    Promise.resolve()
      .then(() => verifySubscriptionAuth({ bin, cwd, env }))
      .then((result: any) => {
        authPending = false;
        if (closed) return;
        if (!result?.ok) {
          failSubscriptionAuth(result);
          return;
        }
        spawnClient(env, args);
      })
      .catch((err: any) =>
        failSubscriptionAuth({
          ok: false,
          reason: claudeAuthPolicy.describeClaudeAuthProbeFailure(err, null),
        })
      );
  }

  function sendUserMessage(text: any) {
    if (closed) {
      emitWarning('claude:send-after-close');
      return false;
    }
    return writeStdin({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: String(text == null ? '' : text) }] },
    });
  }

  function respondToApproval(requestId: any, decision: any = {}) {
    if (!requestId) {
      emitWarning('claude:approval-missing-id');
      return false;
    }
    const behavior = decision.behavior === 'allow' ? 'allow' : 'deny';
    const response: any = { behavior };
    if (behavior === 'allow' && decision.updatedInput && typeof decision.updatedInput === 'object') {
      response.updatedInput = decision.updatedInput;
    }
    if (behavior === 'deny' && typeof decision.message === 'string') {
      response.message = decision.message;
    }
    const ok = writeStdin({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    pendingApprovals.delete(requestId);
    // Synthesize the resolution so the approval entry flips to approved/denied
    // even though the CLI doesn't echo our decision as a discrete event.
    dispatchEvent({ type: '__approval_resolved', request_id: requestId, approved: behavior === 'allow' });
    return ok;
  }

  function interrupt() {
    intSeq += 1;
    return writeStdin({ type: 'control_request', request_id: `int-${intSeq}`, request: { subtype: 'interrupt' } });
  }

  function setPermissionMode(mode: any) {
    const next = normalizePermissionMode(mode);
    permissionMode = next;
    permSeq += 1;
    return writeStdin({
      type: 'control_request',
      request_id: `perm-${permSeq}`,
      request: { subtype: 'set_permission_mode', mode: next },
    });
  }

  function close() {
    if (closed && !child) return;
    closed = true;
    authPending = false;
    pendingWrites.length = 0;
    if (!child) return;
    try { child.stdin?.end(); } catch {}
    try { child.stdout?.removeListener('data', onStdout); } catch {}
    try { child.stderr?.removeListener('data', onStderr); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    // Hard-stop if it lingers.
    const c = child;
    setTimeout(() => {
      try { if (c && !c.killed) c.kill('SIGKILL'); } catch {}
    }, 2000).unref?.();
  }

  return {
    start,
    sendUserMessage,
    respondToApproval,
    interrupt,
    setPermissionMode,
    close,
  };
}

module.exports = { createClaudeStreamClient };
