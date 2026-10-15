import { expect, test } from 'vitest';

const {
  shouldAutoStartAlwaysOnOrchestrator,
} = require('../orchestrator-policy.cts');

test('always-on policy skips Claude repo workspace orchestrators', () => {
  expect(
    shouldAutoStartAlwaysOnOrchestrator({
      always_on_agent: 'claude',
      is_personal: 0,
    })
  ).toBe(false);
  expect(
    shouldAutoStartAlwaysOnOrchestrator({
      always_on_agent: 'claude',
      is_personal: 1,
    })
  ).toBe(false);
});

test('always-on policy keeps Hermes personal and repo lanes eligible', () => {
  expect(
    shouldAutoStartAlwaysOnOrchestrator({
      always_on_agent: 'hermes',
      is_personal: 0,
    })
  ).toBe(true);
  expect(
    shouldAutoStartAlwaysOnOrchestrator({
      always_on_agent: 'hermes',
      is_personal: 1,
    })
  ).toBe(true);
  expect(
    shouldAutoStartAlwaysOnOrchestrator({
      always_on_agent: null,
      is_personal: 0,
    })
  ).toBe(true);
});
