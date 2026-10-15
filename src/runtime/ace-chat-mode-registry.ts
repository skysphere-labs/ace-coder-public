import { useCallback, useSyncExternalStore } from 'react';
import { readDefaultViewMode } from './ace-chat-preferences';

export type AceChatAgent = 'claude' | 'codex' | 'gemini' | 'hermes';
export type AceChatMode = 'cli' | 'chat';

const MODE_STORAGE_PREFIX = 'ace:ace-chat-mode:';

const modes = new Map<string, AceChatMode>();
const listeners = new Map<string, Set<() => void>>();

export function isAceChatAgent(value: string | null | undefined): value is AceChatAgent {
  // Chat rendering is a Hermes-only surface. Coding agents (claude/codex/gemini)
  // always get the raw CLI terminal — the chat overlay re-parsed every terminal
  // chunk into transcript entries per lane, background work Ace sheds for speed.
  // Owner decision 2026-07-03; supersedes PRD D5's chat-default.
  return value === 'hermes';
}

function modeKeyFor(agent: AceChatAgent, scopeKey?: string | null): string {
  return scopeKey ? `${agent}:${scopeKey}` : agent;
}

function readStoredMode(key: string): AceChatMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${MODE_STORAGE_PREFIX}${key}`);
    if (raw === 'cli' || raw === 'chat') return raw;
  } catch {
    // localStorage is convenience-only.
  }
  return null;
}

function writeStoredMode(key: string, mode: AceChatMode) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${MODE_STORAGE_PREFIX}${key}`, mode);
  } catch {
    // Persistence is convenience-only.
  }
}

function defaultModeFor(_agent: AceChatAgent): AceChatMode {
  // Every agent follows the global preference (cli unless the user opted into
  // chat). Only Hermes panes ever consult this — isAceChatAgent gates the
  // coding agents to the raw terminal before any mode lookup happens.
  return readDefaultViewMode();
}

function getMode(agent: AceChatAgent, scopeKey?: string | null): AceChatMode {
  const key = modeKeyFor(agent, scopeKey);
  const existing = modes.get(key);
  if (existing) return existing;
  const mode = readStoredMode(key) ?? defaultModeFor(agent);
  modes.set(key, mode);
  return mode;
}

function subscribe(agent: AceChatAgent, scopeKey: string | null | undefined, fn: () => void): () => void {
  const key = modeKeyFor(agent, scopeKey);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}

export function getAceChatMode(agent: AceChatAgent, scopeKey?: string | null): AceChatMode {
  return getMode(agent, scopeKey);
}

export function setAceChatMode(agent: AceChatAgent, mode: AceChatMode, scopeKey?: string | null) {
  const key = modeKeyFor(agent, scopeKey);
  modes.set(key, mode);
  writeStoredMode(key, mode);
  const set = listeners.get(key);
  if (set) for (const fn of set) fn();
}

export function useAceChatMode(
  agent: AceChatAgent | null,
  scopeKey?: string | null
): [AceChatMode, (next: AceChatMode) => void] {
  const mode = useSyncExternalStore(
    (fn) => (agent ? subscribe(agent, scopeKey, fn) : () => {}),
    () => (agent ? getMode(agent, scopeKey) : 'cli'),
    () => 'cli'
  );
  const setMode = useCallback((next: AceChatMode) => {
    if (agent) setAceChatMode(agent, next, scopeKey);
  }, [agent, scopeKey]);
  return [mode, setMode];
}
