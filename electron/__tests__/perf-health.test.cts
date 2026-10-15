import test from 'node:test';
import assert from 'node:assert/strict';

const perfHealth = require('../perf-health.cts');

test('perf-health records spans and long spinners without leaking sensitive metadata', () => {
  perfHealth.resetForTests();

  perfHealth.recordSpan({
    source: 'main',
    name: 'core.getState',
    durationMs: 245,
    meta: {
      workspaces: 15,
      token: 'secret-token-value',
      route: 'teams',
    },
  });
  perfHealth.recordSpinner({
    source: 'renderer',
    component: 'teams.hermes.frame',
    route: 'teams',
    trigger: 'webview-load',
    label: 'Starting Hermes...',
    previousContent: true,
    durationMs: 820,
    meta: {
      url: 'http://127.0.0.1:1234/secret',
      phase: 'live',
    },
  });

  const report = perfHealth.health();
  assert.equal(report.schema, 'ace.perf-health/v1');
  assert.equal(report.slowSpans.length, 1);
  assert.equal(report.longSpinners.length, 1);
  assert.equal(report.slowSpans[0].meta.token, '[redacted]');
  assert.equal(report.longSpinners[0].meta.url, '[redacted]');
  assert.equal(report.longSpinners[0].previousContent, true);
});
