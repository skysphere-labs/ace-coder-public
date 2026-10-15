import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildOrchestratorPrompt } = require('../orchestrator-prompt.cts');

let tmpRoot = '';

// A workspace whose derived wiki (`<path>/.ace/wiki`) does not exist, so the
// baseline prompt has no auto-injected content.
function baseInput() {
  return {
    agent: 'claude',
    workspaceId: 'ws_1',
    workspaceName: 'alpha',
    workspacePath: path.join(tmpRoot, 'empty-workspace'),
    githubRepo: 'owner/alpha',
    defaultBranch: 'main',
    isRemote: false,
  };
}

function writeNextActions(wsPath, body) {
  const file = path.join(wsPath, '.ace', 'wiki', '00_index', 'NEXT_ACTIONS.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-rehydrate-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('orchestrator prompt rehydration injection', () => {
  it('injects NEXT_ACTIONS body + knowledge hits when both are available', () => {
    const wsPath = path.join(tmpRoot, 'proj');
    writeNextActions(wsPath, [
      '---',
      'title: Next actions',
      'updatedAt: 2026-07-01T00:00:00Z',
      '---',
      '',
      '- Land the run-ledger dispatch fix',
      '- Rebuild + release after owner gate',
    ].join('\n'));

    const knowledgeSearch = () => ({
      results: [
        { trust: 'canon', title: 'Release gate lesson', excerpt: 'Always verify the release gate before merge.' },
        { trust: 'raw', title: 'Dump note', excerpt: 'a raw dump snippet' },
      ],
    });

    const text = buildOrchestratorPrompt({
      ...baseInput(),
      workspacePath: wsPath,
      goal: 'fix the release gate',
      knowledgeSearch,
    });

    expect(text).toContain('Rehydration context (auto-injected from the wiki + knowledge index; advisory):');
    expect(text).toContain('Wiki NEXT_ACTIONS (project `00_index/NEXT_ACTIONS.md`):');
    expect(text).toContain('Land the run-ledger dispatch fix');
    // frontmatter is stripped from the injected NEXT_ACTIONS body
    expect(text).not.toContain('updatedAt: 2026-07-01T00:00:00Z');
    expect(text).toContain('Relevant knowledge for "fix the release gate"');
    expect(text).toContain('[canon] Release gate lesson — Always verify the release gate before merge.');
    expect(text).toContain('[raw] Dump note — a raw dump snippet');
    // the pre-injection lines are all preserved
    expect(text).toContain('Knowledge: rehydrate from the wiki nightly report');
    expect(text).toContain('Fresh session only:');
    expect(text).toContain('After context compression, resume the preserved active task');
  });

  it('is byte-identical to baseline when the index throws and no wiki exists', () => {
    const baseline = buildOrchestratorPrompt(baseInput());
    const withFailingIndex = buildOrchestratorPrompt({
      ...baseInput(),
      goal: 'anything',
      wikiPath: path.join(tmpRoot, 'nonexistent-wiki'),
      knowledgeSearch: () => { throw new Error('index unavailable'); },
    });
    expect(withFailingIndex).toBe(baseline);
  });

  it('is byte-identical to baseline when the index returns no hits and there is no NEXT_ACTIONS', () => {
    const baseline = buildOrchestratorPrompt(baseInput());
    const withEmptyIndex = buildOrchestratorPrompt({
      ...baseInput(),
      goal: 'anything',
      knowledgeSearch: () => ({ results: [] }),
    });
    expect(withEmptyIndex).toBe(baseline);
  });

  it('hard-caps the injected block and truncates an oversized NEXT_ACTIONS', () => {
    const wsPath = path.join(tmpRoot, 'big');
    writeNextActions(wsPath, `# huge\n${'x'.repeat(6000)}`);
    const text = buildOrchestratorPrompt({ ...baseInput(), workspacePath: wsPath });

    const marker = 'Rehydration context (auto-injected from the wiki + knowledge index; advisory):';
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const startNow = text.indexOf('\n\nFresh session only:', start);
    const injected = text.slice(start, startNow === -1 ? undefined : startNow);
    expect(injected.length).toBeLessThanOrEqual(2000);
    expect(injected).toContain('…'); // truncated
  });
});
