// Tests for the opt-in Claude plugin log hook in skills-core.
//
// claude-mem (and any future Claude-only plugin) is logged ONLY when:
//   - process.env.ACE_ENABLE_CLAUDE_PLUGINS === '1', AND
//   - agentId === 'claude'.
//
// Codex (and any non-Claude driver) must never see the plugin log under any
// env state — claude-mem is a Claude Code plugin (hooks + MCP), not a
// cross-driver skill.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-claude-plugin-home-'));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;

for (const key of Object.keys(require.cache)) {
  if (key.includes('/electron/skills-core.cjs') || key.includes('/electron/hermes-home.cjs')) {
    delete require.cache[key];
  }
}

const skillsCore = require('../skills-core.cjs');
const { CLAUDE_PLUGIN_IDS, maybeLogClaudePlugins } = skillsCore;
const skillsCatalog = require('../skills-catalog.json');

function captureLogs(fn: any) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((a: any) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function withEnv(env: Record<string, string | undefined>, fn: () => any) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k] as string;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k] as string;
    }
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } finally {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('claude-mem is classified as a claude-only plugin in the catalog', () => {
  const entry = skillsCatalog.skills.find((s: any) => s.id === 'claude-mem');
  assert.ok(entry, 'claude-mem catalog entry should exist');
  assert.equal(entry.provenance, 'external');
  assert.equal(entry.agentCompatibility, 'claude-only');
  assert.equal(entry.kind, 'plugin');
  // We never bundle claude-mem source.
  assert.equal(
    entry.bundledPath,
    undefined,
    'claude-mem must not have a bundledPath — source is fetched via npx, never vendored'
  );
  // The install verb should be discoverable from the entry.
  assert.match(entry.description + ' ' + (entry.defaultPrompt || ''), /npx claude-mem install/);
});

test('session-memory-notes is a shared bundled skill (cross-driver)', () => {
  const entry = skillsCatalog.skills.find((s: any) => s.id === 'session-memory-notes');
  assert.ok(entry, 'session-memory-notes catalog entry should exist');
  assert.equal(entry.provenance, 'bundled');
  assert.equal(entry.agentCompatibility, 'shared');
  assert.equal(entry.kind, 'skill');
  assert.equal(entry.bundledPath, 'assets/skills/session-memory-notes/SKILL.md');
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', entry.bundledPath)),
    'session-memory-notes SKILL.md should exist on disk'
  );
});

test('CLAUDE_PLUGIN_IDS pack lists claude-mem with the manual install command', () => {
  assert.ok(Array.isArray(CLAUDE_PLUGIN_IDS) || CLAUDE_PLUGIN_IDS instanceof Array);
  const claudeMem = CLAUDE_PLUGIN_IDS.find((p: any) => p.id === 'claude-mem');
  assert.ok(claudeMem, 'claude-mem should be in the plugin pack');
  assert.equal(claudeMem.installCmd, 'npx claude-mem install');
});

test('env=0 (unset): no plugin log, regardless of agent', () => {
  withEnv({ ACE_ENABLE_CLAUDE_PLUGINS: undefined }, () => {
    const claudeLines = captureLogs(() => maybeLogClaudePlugins('claude'));
    const codexLines = captureLogs(() => maybeLogClaudePlugins('codex'));
    assert.deepEqual(claudeLines, []);
    assert.deepEqual(codexLines, []);
  });
});

test('env=1 + agent=claude: emits exactly one claude-plugin log line for claude-mem', () => {
  withEnv({ ACE_ENABLE_CLAUDE_PLUGINS: '1' }, () => {
    const lines = captureLogs(() => maybeLogClaudePlugins('claude'));
    const matches = lines.filter((l) => l.includes('[ace] claude-plugin enabled: claude-mem'));
    assert.equal(matches.length, 1, `expected exactly one claude-mem log; got: ${JSON.stringify(lines)}`);
    assert.match(matches[0], /npx claude-mem install/);
  });
});

test('env=1 + agent=codex: NO plugin log (Codex must not receive Claude-only plugins)', () => {
  withEnv({ ACE_ENABLE_CLAUDE_PLUGINS: '1' }, () => {
    const lines = captureLogs(() => maybeLogClaudePlugins('codex'));
    assert.deepEqual(lines, [], `Codex must never see plugin logs; got: ${JSON.stringify(lines)}`);
  });
});

test('env=1 + other non-claude agents: NO plugin log', () => {
  withEnv({ ACE_ENABLE_CLAUDE_PLUGINS: '1' }, () => {
    for (const agent of ['gemini', 'cursor', 'opencode', 'hermes', 'amp', 'droid']) {
      const lines = captureLogs(() => maybeLogClaudePlugins(agent));
      assert.deepEqual(lines, [], `${agent} must not receive Claude-only plugin logs`);
    }
  });
});

test('env=other-truthy values are NOT treated as enabled — strict "1" only', () => {
  for (const v of ['0', 'true', 'yes', '']) {
    withEnv({ ACE_ENABLE_CLAUDE_PLUGINS: v }, () => {
      const lines = captureLogs(() => maybeLogClaudePlugins('claude'));
      assert.deepEqual(lines, [], `value "${v}" should not enable plugin logs`);
    });
  }
});
