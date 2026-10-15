

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeAuthPolicy = require('./claude-auth-policy.cts');
const { socketPath: aceSocketPath } = (() => {
  try {
    return require('./ace-control/socket-bridge.cjs');
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND' || !String(err?.message || '').includes('socket-bridge.cjs')) {
      throw err;
    }
    return require('./ace-control/socket-bridge.cts');
  }
})();

// Resolve the CLI socket path computed in the main process so any `ace`
// invocation made by the spawned headless agent connects to the same socket
// the host bound — independent of a differing TMPDIR. sanitizeAgentSpawnEnv
// strips ACE_*; re-injecting ACE_SOCK after the sanitized base is the
// only way it survives into the child.
function resolveAceSockForSpawn() {
  if (process.env.ACE_SOCK) return process.env.ACE_SOCK;
  const tag = process.env.ACE_USER_DATA_TAG;
  if (!tag) return null;
  try {
    return aceSocketPath(tag);
  } catch {
    return null;
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const EMPTY_MCP_CONFIG_JSON = '{"mcpServers":{}}';
const CODEX_EMPTY_MCP_OVERRIDE = 'mcp_servers={}';
const CODEX_PLUGIN_OFF_OVERRIDES = [
  'features.plugins=false',
  'features.apps=false',
  'plugins."computer-use@openai-bundled".enabled=false',
  'plugins."browser@openai-bundled".enabled=false',
  'plugins."chrome@openai-bundled".enabled=false',
  'plugins."template-creator@openai-primary-runtime".enabled=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.in_app_browser=false',
  'features.enable_mcp_apps=false',
];
const CLAUDE_AGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_AGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

// Upstream Claude Code (CLI) can return a 400 of the form
//   "messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
//    latest assistant message cannot be modified"
// when it rebuilds conversation history mid-run (compaction/retry) and mutates
// immutable thinking blocks before re-sending to the Anthropic API. This is a
// Claude Code bug, NOT a Ace bug — Ace only spawns the CLI and never
// builds the messages array. Detect the signature to (a) retry once with a
// fresh single-shot invocation and (b) surface an honest error.
const THINKING_BLOCK_400_RE =
  /(thinking|redacted_thinking)\b[^]*?cannot be modified/i;

function isThinkingBlock400(text: any) {
  return typeof text === 'string' && THINKING_BLOCK_400_RE.test(text);
}
const AGENT_SPAWN_ENV_EXACT_BLOCKLIST = new Set([
  '__CFBundleIdentifier',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_CODE_CHILD_SESSION',
]);
const AGENT_SPAWN_ENV_PREFIX_BLOCKLIST = ['CODEX_', 'ACE_'];

function sanitizeAgentSpawnEnv(baseEnv: any = process.env, agent: any = null) {
  const out = { ...(baseEnv || {}) };
  for (const key of Object.keys(out)) {
    if (
      AGENT_SPAWN_ENV_EXACT_BLOCKLIST.has(key) ||
      AGENT_SPAWN_ENV_PREFIX_BLOCKLIST.some((prefix) => key.startsWith(prefix))
    ) {
      delete out[key];
    }
  }
  if (agent === 'claude') claudeAuthPolicy.sanitizeClaudeSubscriptionEnv(out);
  return out;
}

function ensureEmptyMcpConfigPath() {
  const dir = path.join(os.tmpdir(), 'ace');
  const file = path.join(dir, 'claude-empty-mcp.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== EMPTY_MCP_CONFIG_JSON) {
      fs.writeFileSync(file, EMPTY_MCP_CONFIG_JSON);
    }
  } catch {}
  return file;
}

function normalizeAgentReasoningEffort(value: any, agent: any) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return null;
  const valid = agent === 'claude' ? CLAUDE_AGENT_EFFORTS : CODEX_AGENT_EFFORTS;
  if (valid.has(effort)) return effort;
  throw new Error(`${agent} reasoning effort "${effort}" is not supported by the Ace launcher`);
}

function shouldUseGlobalCodexMcp(opts: any = {}) {
  if (opts.enableMcp === true) return true;
  if (opts.launchIntent && typeof opts.launchIntent === 'object' && opts.launchIntent.enableMcp === true) return true;
  return process.env.ACE_ENABLE_CODEX_MCP === '1';
}

function buildArgs(agent: any, prompt: any, opts: any = {}) {
  if (agent === 'claude') {
    const emptyMcpConfig = ensureEmptyMcpConfigPath();
    const args = [
      '-p',
      '--strict-mcp-config',
      '--mcp-config', emptyMcpConfig,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      prompt,
    ];
    const effort = normalizeAgentReasoningEffort(opts.reasoningEffort || opts.effort, agent);
    if (effort) args.splice(args.length - 1, 0, '--effort', effort);
    // Optional least-privilege tool allowlist (e.g. the unattended ops research
    // leg restricts itself to web read). Claude Code accepts a single
    // space-separated value. Without this, --dangerously-skip-permissions
    // leaves the full Bash/Write/Edit surface available.
    if (Array.isArray(opts.allowedTools) && opts.allowedTools.length > 0) {
      args.splice(args.length - 1, 0, '--allowedTools', opts.allowedTools.join(' '));
    }
    return args;
  }
  if (agent === 'codex') {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--json',
      prompt,
    ];
    const effort = normalizeAgentReasoningEffort(opts.reasoningEffort || opts.effort, agent);
    if (effort) {
      args.unshift('-c', `model_reasoning_effort="${effort}"`);
    }
    if (!shouldUseGlobalCodexMcp(opts)) {
      for (let i = CODEX_PLUGIN_OFF_OVERRIDES.length - 1; i >= 0; i -= 1) {
        args.unshift('-c', CODEX_PLUGIN_OFF_OVERRIDES[i]);
      }
      args.unshift('-c', CODEX_EMPTY_MCP_OVERRIDE);
    }
    return args;
  }
  throw new Error(`unsupported agent for headless mode: ${agent}`);
}

function renderEvent(agent: any, event: any) {
  if (agent === 'claude') {
    if (event.type === 'system' && event.subtype === 'init') {
      return '▸ session ready';
    }
    if (event.type === 'assistant' && event.message?.content) {
      const parts = [];
      for (const c of event.message.content) {
        if (c.type === 'text' && c.text) {
          parts.push(c.text);
        } else if (c.type === 'tool_use') {
          const summary = summarizeToolInput(c.input);
          parts.push(`▸ ${c.name}(${summary})`);
        } else if (c.type === 'thinking') {
          parts.push('▸ thinking…');
        }
      }
      return parts.join('\n');
    }
    if (event.type === 'user' && event.message?.content) {
      const parts = [];
      for (const c of event.message.content) {
        if (c.type === 'tool_result') {
          const text =
            typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
              ? c.content.map((x: any) => x.text || '').join('')
              : '';
          const oneLine = text.replace(/\s+/g, ' ').slice(0, 240);
          parts.push(`  ↪ ${oneLine}${text.length > 240 ? '…' : ''}`);
        }
      }
      return parts.join('\n');
    }
    if (event.type === 'result' && event.subtype === 'success') {
      return `\n▸ done in ${event.duration_ms}ms across ${event.num_turns} turns`;
    }
    if (event.type === 'result' && event.subtype !== 'success') {
      return `\n▸ failed: ${event.subtype || 'unknown'}`;
    }
    return null;
  }
  if (agent === 'codex') {
    if (event.type === 'thread.started') return '▸ session ready';
    if (event.type === 'turn.started') return '▸ turn started';
    if (event.type === 'item.completed' && event.item) {
      const it = event.item;
      if (it.type === 'agent_message') return it.text || '';
      if (it.type === 'command_execution') {
        const cmd = (it.command || '').replace(/\s+/g, ' ').slice(0, 200);
        return `▸ exec: ${cmd}`;
      }
      if (it.type === 'reasoning') return '▸ reasoning…';
      if (it.type === 'file_change') {
        const summary = (it.summary || it.path || '').slice(0, 200);
        return `▸ file change: ${summary}`;
      }
      return `▸ ${it.type}`;
    }
    if (event.type === 'turn.completed') {
      const u = event.usage || {};
      return `\n▸ done (${u.output_tokens || 0} output / ${u.input_tokens || 0} input tokens)`;
    }
    if (event.type === 'turn.failed') {
      return `\n▸ failed: ${event.error || 'unknown'}`;
    }
    return null;
  }
  return null;
}

function summarizeToolInput(input: any) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.file_path === 'string') return input.file_path.split('/').slice(-2).join('/');
  if (typeof input.path === 'string') return input.path.split('/').slice(-2).join('/');
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.command === 'string') return input.command.slice(0, 80);
  if (typeof input.query === 'string') return input.query.slice(0, 80);
  return JSON.stringify(input).slice(0, 80);
}

function extractText(agent: any, event: any) {
  if (!event || typeof event !== 'object') return null;
  const out = [];
  if (agent === 'claude') {
    if (event.type === 'assistant' && event.message?.content) {
      for (const c of event.message.content) {
        if (c?.type === 'text' && typeof c.text === 'string') out.push(c.text);
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      out.push(event.result);
    }
  }
  if (agent === 'codex') {
    if (event.type === 'item.completed' && event.item) {
      const it = event.item;

      if (typeof it.text === 'string' && it.text) out.push(it.text);


      if (typeof it.message === 'string' && it.message) out.push(it.message);
      if (typeof it.content === 'string' && it.content) out.push(it.content);
    }
  }
  return out.length ? out.join('\n') : null;
}

async function runAgentPromptOnce({
  agent,
  bin,
  cwd,
  prompt,
  env,
  reasoningEffort,
  effort,
  allowedTools,
  signal,
  onProgress,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  verifySubscriptionAuth = claudeAuthPolicy.verifyClaudeSubscriptionAuth,
}: any) {
  const args = buildArgs(agent, prompt, { reasoningEffort, effort, allowedTools });
  const aceSock = resolveAceSockForSpawn();
  const childEnv = {
    ...sanitizeAgentSpawnEnv(process.env),
    ...(aceSock ? { ACE_SOCK: aceSock } : {}),
    // Re-inject the instance tag past the ACE_* sanitizer (mirrors the
    // PTY path) so the spawned CLI's socket fallback + enforcement attribute
    // to the right Ace instance rather than defaulting to "Ace".
    ...(process.env.ACE_USER_DATA_TAG
      ? { ACE_USER_DATA_TAG: process.env.ACE_USER_DATA_TAG }
      : {}),
    ...(process.env.ACE_HOME ? { ACE_HOME: process.env.ACE_HOME } : {}),
    ...(process.env.ACE_ARTIFACT_ROOT ? { ACE_ARTIFACT_ROOT: process.env.ACE_ARTIFACT_ROOT } : {}),
    ...(env || {}),
  };
  if (agent === 'claude') {
    // Sanitize once at the final boundary so caller-supplied env cannot
    // reintroduce API or cloud-provider credentials.
    claudeAuthPolicy.sanitizeClaudeSubscriptionEnv(childEnv);
    let auth;
    try {
      auth = await verifySubscriptionAuth({ bin, cwd, env: childEnv });
    } catch (err) {
      auth = { ok: false, reason: claudeAuthPolicy.describeClaudeAuthProbeFailure(err, null) };
    }
    if (!auth?.ok) throw claudeAuthPolicy.claudeSubscriptionAuthError(auth);
  }

  return new Promise((resolve, reject) => {
    let child: any;
    try {
      child = spawnImpl(bin, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      reject(new Error(`failed to spawn ${agent}: ${err.message}`));
      return;
    }

    let stderr = '';
    let lineBuffer = '';
    let liveView = '';


    let collectedText = '';
    let settled = false;
    let timer: any = null;
    const stdoutAuthDetector = agent === 'claude'
      ? claudeAuthPolicy.createClaudeStartupAuthDetector()
      : null;
    const stderrAuthDetector = agent === 'claude'
      ? claudeAuthPolicy.createClaudeStartupAuthDetector()
      : null;

    function settleResolve(value: any) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    function settleReject(err: any) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      reject(err);
    }

    function processLine(line: any) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {



        liveView += trimmed + '\n';
        if (typeof onProgress === 'function') {
          try {
            onProgress(liveView);
          } catch {}
        }
        return;
      }
      const rendered = renderEvent(agent, event);
      if (rendered != null) {
        liveView += rendered + '\n';
        if (typeof onProgress === 'function') {
          try {
            onProgress(liveView);
          } catch {}
        }
      }
      const text = extractText(agent, event);
      if (text != null) {
        collectedText += text + '\n';
      }
    }

    child.stdout.on('data', (chunk: any) => {
      if (stdoutAuthDetector?.push(chunk) === 'api') {
        settleReject(new Error(claudeAuthPolicy.CLAUDE_API_BILLING_ERROR));
        return;
      }
      lineBuffer += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, nlIdx);
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk: any) => {
      if (stderrAuthDetector?.push(chunk) === 'api') {
        settleReject(new Error(claudeAuthPolicy.CLAUDE_API_BILLING_ERROR));
        return;
      }
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: any) => {
      settleReject(new Error(`${agent} spawn error: ${err.message}`));
    });

    child.on('exit', (code: any, sig: any) => {

      if (lineBuffer) {
        processLine(lineBuffer);
        lineBuffer = '';
      }
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        settleReject(new Error(`${agent} aborted`));
        return;
      }
      if (code !== 0) {
        const tail = stderr ? `: ${stderr.slice(-500).trim()}` : '';
        settleReject(new Error(`${agent} exited with code ${code}${tail}`));
        return;
      }




      const output = collectedText || liveView;
      settleResolve({ output, stderr, liveView, collectedText });
    });

    if (signal) {
      if (signal.aborted) {
        settleReject(new Error(`${agent} aborted`));
      } else {
        signal.addEventListener('abort', () => {
          try {
            child.kill('SIGTERM');
          } catch {}
        });
      }
    }

    timer = setTimeout(() => {
      settleReject(new Error(`${agent} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// Wrapper around runAgentPromptOnce that recovers from the upstream Claude Code
// thinking-block 400 (see THINKING_BLOCK_400_RE). On detection for a claude run
// we retry once with a fresh single-shot invocation; if it still fails we throw
// a classified, honest error rather than a bare "exited with code 1".
async function runAgentPrompt(opts: any) {
  try {
    return await runAgentPromptOnce(opts);
  } catch (err: any) {
    const msg = (err && err.message) || '';
    if (
      opts &&
      opts.agent === 'claude' &&
      !opts._retriedThinkingBlock &&
      isThinkingBlock400(msg)
    ) {
      if (typeof opts.onProgress === 'function') {
        try {
          opts.onProgress('▸ recovering from upstream thinking-block 400 (fresh retry)…\n');
        } catch {}
      }
      return await runAgentPromptOnce({ ...opts, _retriedThinkingBlock: true });
    }
    if (isThinkingBlock400(msg)) {
      throw new Error(
        'claude hit an upstream thinking-block 400: the Claude Code CLI cannot re-send ' +
          'modified `thinking`/`redacted_thinking` blocks after history reconstruction. ' +
          'This is a Claude Code bug, not Ace — start a fresh session (no --resume) or ' +
          'upgrade the CLI when an upstream fix ships. Original: ' +
          msg,
      );
    }
    throw err;
  }
}

function parseHandoff(output: any) {
  if (!output) return null;
  const match = output.match(/<<<ACE_HANDOFF\s*([\s\S]*?)\s*ACE_HANDOFF>>>/);
  if (!match) return null;
  const raw = match[1].replace(/\r/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {}


  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

module.exports = { runAgentPrompt, parseHandoff, buildArgs, sanitizeAgentSpawnEnv, resolveAceSockForSpawn };
