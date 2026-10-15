/**
 * ops-brief-research-config.test.cts
 *
 * FIX 1 — scheduled briefs may spawn the research agent, config-driven via
 * the selected profile's refresh.research.scheduled (default FALSE), read at each
 * brief tick. Covers readResearchScheduled defaults + the scheduler threading
 * the flag through deliverOpsBrief when a configPath is supplied.
 *
 * Plain CJS (no TS annotation syntax).
 */

import { afterEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readResearchScheduled, scheduleOpsBriefs } = require('../ops-brief-scheduler.cts');

const tmpDirs = [];
function writeConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-brief-cfg-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'ops-config.json');
  if (obj !== undefined) fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('readResearchScheduled — default FALSE, config-driven', () => {
  it('defaults FALSE when the config file is missing', () => {
    expect(readResearchScheduled(path.join(os.tmpdir(), 'definitely-missing-ops-config.json'))).toBe(false);
  });

  it('FALSE when config exists but has no refresh.research.scheduled key', () => {
    expect(readResearchScheduled(writeConfig({ refresh: { research: {} } }))).toBe(false);
  });

  it('FALSE when explicitly set to false', () => {
    expect(readResearchScheduled(writeConfig({ refresh: { research: { scheduled: false } } }))).toBe(false);
  });

  it('TRUE when explicitly set to true', () => {
    expect(readResearchScheduled(writeConfig({ refresh: { research: { scheduled: true } } }))).toBe(true);
  });

  it('rejects truthy values that are not an explicit boolean opt-in', () => {
    for (const scheduled of ['true', 1, {}, []]) {
      expect(readResearchScheduled(writeConfig({ refresh: { research: { scheduled } } }))).toBe(false);
    }
  });

  it('defaults FALSE on corrupt config (fail-safe)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-brief-cfg-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'ops-config.json');
    fs.writeFileSync(p, '{ not valid json');
    expect(readResearchScheduled(p)).toBe(false);
  });
});

describe('scheduleOpsBriefs — reads the flag from configPath at tick time', () => {
  function runOnce(configPath) {
    const timeouts = [];
    const deliverCalls = [];
    const store = { deliverOpsBrief: (arg) => deliverCalls.push(arg) };
    scheduleOpsBriefs({
      getStore: () => store,
      subscriptions: [],
      now: () => new Date(2026, 5, 4, 10, 0, 0, 0),
      configPath, // FIX 1: no injected fn -> the real reader uses this path
      schedule: [{ hour: 7, minute: 30, lens: 'morning' }],
      setTimeout: (fn) => {
        const t = { fn };
        timeouts.push(t);
        return t;
      },
      clearTimeout: () => {},
      setInterval: () => ({}),
      clearInterval: () => {},
      logger: { error: () => {} },
    });
    // Fire the outer tick, then the inner zero-delay tick.
    timeouts[0].fn();
    for (const t of timeouts.slice(1)) t.fn();
    return deliverCalls;
  }

  it('passes allowResearchAgent:false when config disables scheduled research', async () => {
    const calls = runOnce(writeConfig({ refresh: { research: { scheduled: false } } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].allowResearchAgent).toBe(false);
  });

  it('passes allowResearchAgent:false by default (config present, key absent)', async () => {
    const calls = runOnce(writeConfig({ briefs: {} }));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].allowResearchAgent).toBe(false);
  });

  it('passes allowResearchAgent:true after explicit opt-in', async () => {
    const calls = runOnce(writeConfig({ refresh: { research: { scheduled: true } } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].allowResearchAgent).toBe(true);
  });
});

it('reads scheduled research preferences from the selected public profile', () => {
  const previous = process.env.ACE_HOME;
  const config = writeConfig({ refresh: { research: { scheduled: false } } });
  try {
    process.env.ACE_HOME = path.dirname(config);
    expect(readResearchScheduled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.ACE_HOME;
    else process.env.ACE_HOME = previous;
  }
});
