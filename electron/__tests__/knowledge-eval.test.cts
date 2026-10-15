import { describe, expect, it } from 'vitest';

const Database = require('better-sqlite3');
const { runKnowledgeEval } = require('../knowledge-eval.cts');

describe('knowledge eval', () => {
  it('passes every category against a healthy index', () => {
    const report = runKnowledgeEval({ Database });
    const failures = (report.categories || []).flatMap((category) => category.failures);
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.categories.map((category) => category.name)).toEqual([
      'lookup', 'cross-project', 'temporal', 'knowledge-update', 'abstention',
    ]);
  });

  it('FAILS when trust weighting is sabotaged (regression detection)', () => {
    // Invert ranking: worst score first. A working eval must notice.
    const report = runKnowledgeEval({
      Database,
      searchOverride: (index, params) => {
        const result = index.search({ ...params, includeDecayed: params.includeDecayed });
        return { ...result, results: [...(result.results || [])].reverse() };
      },
    });
    expect(report.ok).toBe(false);
  });

  it('FAILS when the decay filter is disabled (poisoned content surfaces)', () => {
    const report = runKnowledgeEval({
      Database,
      searchOverride: (index, params) => index.search({ ...params, includeDecayed: true }),
    });
    const abstention = report.categories.find((category) => category.name === 'abstention');
    expect(abstention.ok).toBe(false);
  });
});
