const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { buildArgs, runAgentPrompt, sanitizeAgentSpawnEnv } = require('../agent-cli-driver.cts');

function fakeAgentChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test('agent-cli-driver: Claude and Codex default to MCP-off launch args', () => {
  const previous = process.env.ACE_ENABLE_CODEX_MCP;
  delete process.env.ACE_ENABLE_CODEX_MCP;
  try {
    const claudeArgs = buildArgs('claude', 'hello');
    assert.ok(claudeArgs.includes('--strict-mcp-config'));
    const mcpConfigIndex = claudeArgs.indexOf('--mcp-config');
    assert.ok(mcpConfigIndex >= 0, 'Claude args should include --mcp-config');
    const mcpConfigPath = claudeArgs[mcpConfigIndex + 1];
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')), { mcpServers: {} });

    const mediumClaudeArgs = buildArgs('claude', 'hello', { reasoningEffort: 'medium' });
    assert.equal(mediumClaudeArgs.includes('--effort'), true);
    assert.equal(mediumClaudeArgs[mediumClaudeArgs.indexOf('--effort') + 1], 'medium');

    const maxClaudeArgs = buildArgs('claude', 'hello', { reasoningEffort: 'max' });
    assert.equal(maxClaudeArgs.includes('--effort'), true);
    assert.equal(maxClaudeArgs[maxClaudeArgs.indexOf('--effort') + 1], 'max');

    const codexArgs = buildArgs('codex', 'hello');
    assert.deepEqual(codexArgs.slice(0, 2), ['-c', 'mcp_servers={}']);
    assert.ok(codexArgs.includes('plugins."computer-use@openai-bundled".enabled=false'));
    assert.ok(codexArgs.includes('plugins."browser@openai-bundled".enabled=false'));
    assert.ok(codexArgs.includes('features.computer_use=false'));

    const mediumCodexArgs = buildArgs('codex', 'hello', { reasoningEffort: 'medium' });
    assert.equal(mediumCodexArgs[0], '-c');
    assert.equal(mediumCodexArgs[1], 'mcp_servers={}');
    assert.ok(mediumCodexArgs.includes('model_reasoning_effort="medium"'));

    const xhighCodexArgs = buildArgs('codex', 'hello', { reasoningEffort: 'xhigh' });
    assert.equal(xhighCodexArgs[0], '-c');
    assert.equal(xhighCodexArgs[1], 'mcp_servers={}');
    assert.ok(xhighCodexArgs.includes('model_reasoning_effort="xhigh"'));

    assert.throws(
      () => buildArgs('codex', 'hello', { reasoningEffort: 'max' }),
      /codex reasoning effort "max" is not supported/
    );

    const launchIntentMcpArgs = buildArgs('codex', 'hello', { launchIntent: { enableMcp: true } });
    assert.equal(launchIntentMcpArgs.includes('mcp_servers={}'), false);
    assert.equal(launchIntentMcpArgs.some((arg) => /computer-use@openai-bundled/.test(arg)), false);

    process.env.ACE_ENABLE_CODEX_MCP = '1';
    const optedInCodexArgs = buildArgs('codex', 'hello');
    assert.equal(optedInCodexArgs.includes('mcp_servers={}'), false);
    assert.equal(optedInCodexArgs.some((arg) => /computer-use@openai-bundled/.test(arg)), false);
  } finally {
    if (previous == null) delete process.env.ACE_ENABLE_CODEX_MCP;
    else process.env.ACE_ENABLE_CODEX_MCP = previous;
  }
});

test('agent-cli-driver: Claude allowedTools restricts the unattended tool surface', () => {
  // Default (no allowlist) keeps today's behavior.
  const open = buildArgs('claude', 'hello');
  assert.equal(open.includes('--allowedTools'), false);

  // The ops research leg passes a web-only allowlist as a single space-joined
  // value, spliced before the positional prompt.
  const restricted = buildArgs('claude', 'do research', {
    allowedTools: ['WebSearch', 'WebFetch'],
  });
  const idx = restricted.indexOf('--allowedTools');
  assert.ok(idx >= 0, 'restricted args should include --allowedTools');
  assert.equal(restricted[idx + 1], 'WebSearch WebFetch');
  assert.equal(restricted[restricted.length - 1], 'do research');

  // Empty/absent allowlist is a no-op.
  assert.equal(buildArgs('claude', 'hi', { allowedTools: [] }).includes('--allowedTools'), false);
});

test('agent-cli-driver: spawned agents do not inherit Codex or stale Ace session env', () => {
  assert.deepEqual(
    sanitizeAgentSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      CODEX_CI: '1',
      CODEX_THREAD_ID: 'old-thread',
      CLAUDE_CODE_CHILD_SESSION: '1',
      ACE_STREAM_ID: 'conversation:stale',
      ACE_TASK_ID: 'tsk-stale',
      __CFBundleIdentifier: 'com.ace.app',
      ELECTRON_RUN_AS_NODE: '1',
    }),
    {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
    }
  );

  assert.deepEqual(
    sanitizeAgentSpawnEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'metered',
      ANTHROPIC_AUTH_TOKEN: 'gateway',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
    }, 'claude'),
    {
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
    }
  );
});

test('agent-cli-driver: Claude headless prompt fails closed before inference without subscription auth', async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runAgentPrompt({
      agent: 'claude',
      bin: 'claude',
      cwd: process.cwd(),
      prompt: 'do not send this',
      verifySubscriptionAuth: async () => ({
        ok: false,
        reason: 'non-subscription-auth',
        authMethod: 'console',
      }),
      spawnImpl: () => {
        spawnCalls += 1;
        return fakeAgentChild();
      },
    }),
    /Claude subscription authentication required \(console\)/
  );
  assert.equal(spawnCalls, 0);
});

test('agent-cli-driver: Claude headless prompt stops on the exact API billing startup banner', async () => {
  let child;
  const run = runAgentPrompt({
    agent: 'claude',
    bin: 'claude',
    cwd: process.cwd(),
    prompt: 'hello',
    verifySubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    spawnImpl: () => {
      child = fakeAgentChild();
      setImmediate(() => {
        child.stdout.write(' ▐▛███▜▌   Claude Code v2.1.206\r\n▝▜█████▛▘  Fable 5 · AP');
        child.stdout.write('I Usage Billing\r\n');
      });
      return child;
    },
  });

  await assert.rejects(run, /Claude API Usage Billing blocked/);
  assert.equal(child.killed, true);
});

test('agent-cli-driver: Claude headless prompt ignores explanatory API billing text', async () => {
  const run = runAgentPrompt({
    agent: 'claude',
    bin: 'claude',
    cwd: process.cwd(),
    prompt: 'hello',
    verifySubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    spawnImpl: () => {
      const child = fakeAgentChild();
      setImmediate(() => {
        child.stderr.write('log: the phrase API Usage Billing is documented here\n');
        child.stdout.write(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'API Usage Billing is only explanatory text.' }] },
        }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\n');
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  const result = await run;
  assert.match(result.output, /explanatory text/);
  assert.match(result.output, /done/);
});
