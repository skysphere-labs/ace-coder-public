import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createPtyRegistry } = require('../local-core.cts');

// The lane spawn contract after the credential gateway was removed: a lane is
// the machine's own CLI on the machine's own login, pinned to the renderer that
// actually works inside an xterm.js pane. Lives here rather than in
// local-core.test.cts because that file is not in any npm test script — the
// packaged better-sqlite3 is Electron-ABI and 34 of its cases die on
// ERR_DLOPEN_FAILED in a plain node runner — so a test placed there would gate
// nothing. Everything below drives the REAL createPtyRegistry.

function capturingPtyImpl() {
  const spawned = [];
  return {
    spawned,
    ptyImpl: {
      spawn(bin, args, opts) {
        const proc = { bin, args, opts, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
        spawned.push(proc);
        return proc;
      },
    },
  };
}

const noopStates = {
  ensureState() {},
  writeData(_id, d) { return { seq: 1, rewritten: d }; },
  resize() {}, remove() {}, sync() { return { text: '' }; }, pump() {},
};

describe('claude lane spawn contract', () => {
  let binDir;
  let restoreEnv;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lane-bin-'));
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    const prev = { c: process.env.ACE_ENABLE_CLAUDE_MCP, x: process.env.ACE_ENABLE_CODEX_MCP };
    delete process.env.ACE_ENABLE_CLAUDE_MCP;
    delete process.env.ACE_ENABLE_CODEX_MCP;
    restoreEnv = () => {
      if (prev.c == null) delete process.env.ACE_ENABLE_CLAUDE_MCP; else process.env.ACE_ENABLE_CLAUDE_MCP = prev.c;
      if (prev.x == null) delete process.env.ACE_ENABLE_CODEX_MCP; else process.env.ACE_ENABLE_CODEX_MCP = prev.x;
    };
  });
  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
  });

  function laneRegistry(opts = {}) {
    const { spawned, ptyImpl } = capturingPtyImpl();
    const registry = createPtyRegistry(new EventEmitter(), noopStates, opts, {
      ptyImpl,
      verifyClaudeSubscriptionAuth: async () => ({ ok: true, authMethod: 'claude.ai' }),
    });
    const extraEnv = { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` };
    const spawn = (streamId) =>
      registry.ensureStream({
        streamId, agent: 'claude', cwd: '/tmp', ownerKind: 'conversation', ownerId: 'c1',
        cols: 80, rows: 24, extraEnv,
      });
    return { spawned, spawn };
  }

  it('runs on ambient auth — no gateway base URL, no injected credential', async () => {
    const { spawned, spawn } = laneRegistry();
    await spawn('conversation:amb');
    const env = spawned[0]?.opts?.env || {};
    // A lane talks to the API exactly like a terminal `claude`. A base URL would
    // route it back through a local proxy; any auth var outranks the keychain
    // claude.ai login, flipping billing AND disabling claude.ai connectors.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.ACE_PROVIDER_ACCOUNT).toBeUndefined();
  });

  it('pins the classic TUI renderer, overriding only `tui`', async () => {
    const { spawned, spawn } = laneRegistry();
    await spawn('conversation:tui');
    const args = spawned[0]?.args || [];
    const at = args.indexOf('--settings');
    expect(at).toBeGreaterThan(-1);
    // Claude Code's fullscreen renderer owns its own scrollback and expects the
    // terminal to drive it through DECSET 1007, which xterm.js does not
    // implement — a fullscreen lane cannot be scrolled inside an Ace pane.
    // `--settings` is a settings SOURCE that merges, so this overrides `tui`
    // alone and leaves model/effort/permissions to the owner's settings.json.
    expect(JSON.parse(args[at + 1])).toEqual({ tui: 'default' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('refuses a lane still running inside an un-retired legacy pty-host', async () => {
    // Its original CLI is alive in a pre-upgrade daemon we could not retire.
    // Spawning here would put a second agent on the same session and transcript.
    const blocked = new Set(['conversation:stuck']);
    const { spawned, spawn } = laneRegistry({
      isLaneBlockedByLegacyHost: (id) => blocked.has(id),
    });

    const refused = await spawn('conversation:stuck');
    expect(spawned).toHaveLength(0);
    expect(refused.status).toBe('exited');
    expect(String(refused.error)).toMatch(/pty-host left over from a previous version/i);

    // Every other lane still starts normally.
    await spawn('conversation:fine');
    expect(spawned).toHaveLength(1);
  });
});
