import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getAceChatMode,
  isAceChatAgent,
  setAceChatMode,
} from './ace-chat-mode-registry';

// Chat rendering is a Hermes-only surface (owner decision 2026-07-03, supersedes
// PRD D5). Coding agents always render the raw CLI terminal; the mode registry
// still scopes any explicit choice per tab + per agent (modeKeyFor).
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'ace-chat-mode-registry.ts'), 'utf8');

describe('chat overlay is hermes-only', () => {
  it('gates the chat pane to hermes', () => {
    expect(isAceChatAgent('hermes')).toBe(true);
    expect(isAceChatAgent('claude')).toBe(false);
    expect(isAceChatAgent('codex')).toBe(false);
    expect(isAceChatAgent('gemini')).toBe(false);
  });
  it('defaults every agent to the global cli preference', () => {
    expect(getAceChatMode('claude', 'tab-a')).toBe('cli');
    expect(getAceChatMode('codex', 'tab-a')).toBe('cli');
    expect(getAceChatMode('gemini', 'tab-a')).toBe('cli');
    expect(getAceChatMode('hermes', 'tab-a')).toBe('cli');
  });
  it('persists an explicit per-agent/per-tab override without leaking scopes', () => {
    setAceChatMode('hermes', 'chat', 'tab-b');
    expect(getAceChatMode('hermes', 'tab-b')).toBe('chat');
    // a different tab for the same agent keeps the cli default
    expect(getAceChatMode('hermes', 'tab-c')).toBe('cli');
  });
  it('source: no hardcoded chat default remains', () => {
    expect(source).not.toMatch(/return 'chat'/);
  });
});
