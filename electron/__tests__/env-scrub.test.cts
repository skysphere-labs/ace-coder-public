import { test, expect } from 'vitest';

const { SCRUBBED_AGENT_ENV_VARS, scrubInheritedAgentEnv } = require('../env-scrub.cts');

test('scrubs every agent-context var and reports what it removed', () => {
  const env = {};
  for (const key of SCRUBBED_AGENT_ENV_VARS) env[key] = `inherited-${key}`;
  env.PATH = '/usr/bin';
  const scrubbed = scrubInheritedAgentEnv(env);
  expect([...scrubbed].sort()).toEqual([...SCRUBBED_AGENT_ENV_VARS].sort());
  for (const key of SCRUBBED_AGENT_ENV_VARS) expect(env[key]).toBeUndefined();
  expect(env.PATH).toBe('/usr/bin');
});

test('preserves legitimate boot-time overrides', () => {
  const env = {
    ACE_SOCK: '/tmp/parent.sock',
    CLAUDE_CODE_CHILD_SESSION: '1',
    ACE_DATA_ROOT: '/Volumes/Example/Data',
    ACE_EXTERNAL_DATA_ROOT: '/Volumes/Example/Data',
    ACE_USE_EXTERNAL_DATA_ROOT: '1',
    ACE_UPDATE_BASE_URL: 'https://updates.example.com',
    ACE_UPDATE_ACCESS_CLIENT_ID: 'cid',
    ACE_UPDATE_ACCESS_CLIENT_SECRET: 'csec',
    ACE_DATA_ROOT_FALLBACK: '1',
  };
  const scrubbed = scrubInheritedAgentEnv(env);
  expect(scrubbed).toEqual(['ACE_SOCK', 'CLAUDE_CODE_CHILD_SESSION']);
  expect(env.ACE_DATA_ROOT).toBe('/Volumes/Example/Data');
  expect(env.ACE_EXTERNAL_DATA_ROOT).toBe('/Volumes/Example/Data');
  expect(env.ACE_USE_EXTERNAL_DATA_ROOT).toBe('1');
  expect(env.ACE_UPDATE_BASE_URL).toBe('https://updates.example.com');
  expect(env.ACE_UPDATE_ACCESS_CLIENT_ID).toBe('cid');
  expect(env.ACE_UPDATE_ACCESS_CLIENT_SECRET).toBe('csec');
  // Fail-safe-only flag stays inheritable: it can only suppress agent
  // auto-start, and sandboxed test boots set it externally on purpose.
  expect(env.ACE_DATA_ROOT_FALLBACK).toBe('1');
});

test('no-op on a clean environment', () => {
  const env = { HOME: '/Users/example' };
  expect(scrubInheritedAgentEnv(env)).toEqual([]);
  expect(env.HOME).toBe('/Users/example');
});
