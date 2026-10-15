import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveAttention } from './attention';

// Operations guards after the hub was retired: the pure attention-strip
// derivation (still used by the promoted Board surface) and the promoted-screen
// wiring. Source-text assertions follow the house idiom — renderer wiring is
// verified against source rather than by booting Electron.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

describe('Board attention strip (deriveAttention)', () => {
  it('returns nothing when nothing needs the operator', () => {
    expect(deriveAttention({ severity: 'green', blocked: 0, readyToReview: 0, liveAgents: 0 })).toEqual(
      []
    );
    // unknown / not-yet-loaded slices also render nothing.
    expect(
      deriveAttention({ severity: null, blocked: null, readyToReview: null, liveAgents: null })
    ).toEqual([]);
  });

  it('does NOT surface live agents on their own (ambient, not an alert)', () => {
    expect(
      deriveAttention({ severity: 'green', blocked: 0, readyToReview: 0, liveAgents: 3 })
    ).toEqual([]);
  });

  it('surfaces a non-green rollup severity as a Monitor-targeting chip', () => {
    const chips = deriveAttention({ severity: 'red', blocked: 0, readyToReview: 0, liveAgents: 0 });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ key: 'severity', targetTab: 'monitoring', tone: 'rose' });
  });

  it('surfaces blocked and ready-to-review run counts', () => {
    const chips = deriveAttention({ severity: 'green', blocked: 2, readyToReview: 1, liveAgents: 0 });
    expect(chips.map((c) => c.key)).toEqual(['blocked', 'review']);
    expect(chips.find((c) => c.key === 'blocked')?.label).toBe('2 blocked');
    expect(chips.find((c) => c.key === 'review')?.label).toBe('1 to review');
    // Board-local counts don't navigate anywhere.
    expect(chips.every((c) => c.targetTab === undefined)).toBe(true);
  });

  it('rides the live-agent chip along ONLY when the strip is already active', () => {
    const chips = deriveAttention({ severity: 'yellow', blocked: 0, readyToReview: 0, liveAgents: 1 });
    expect(chips.map((c) => c.key)).toContain('agents');
    expect(chips.find((c) => c.key === 'agents')?.label).toBe('1 agent live');
  });

  it('orders chips severity → blocked → review → agents', () => {
    const chips = deriveAttention({ severity: 'black', blocked: 1, readyToReview: 2, liveAgents: 4 });
    expect(chips.map((c) => c.key)).toEqual(['severity', 'blocked', 'review', 'agents']);
    expect(chips.find((c) => c.key === 'agents')?.label).toBe('4 agents live');
  });
});

describe('collapsed wiki graph lazy gate (no fetch until expanded)', () => {
  const knowledgeScreen = read('OpsScreens.tsx');
  const wikiGraph = read('organisms/WikiGraphPanel.tsx');

  it('mounts WikiGraphPanel only when the collapsed section is expanded', () => {
    expect(knowledgeScreen).toContain('function CollapsedWikiGraph');
    // The Knowledge screen renders the collapsed wrapper, never the panel directly.
    expect(knowledgeScreen).toContain('<CollapsedWikiGraph />');
    // Inside the wrapper the panel is behind `graphOpen && (`, so no wikiGraph
    // fetch / SVG render happens until the operator expands it.
    const body = knowledgeScreen.slice(knowledgeScreen.indexOf('function CollapsedWikiGraph'));
    expect(body).toMatch(/\{graphOpen && \([\s\S]*?<WikiGraphPanel \/>/);
    expect(body).toContain('useState(false)');
  });

  it('WikiGraphPanel still self-fetches its graph on mount (why the gate matters)', () => {
    expect(wikiGraph).toContain('.wikiGraph()');
  });
});

describe('promoted-surface declutter (no retired panels)', () => {
  const opsScreens = read('OpsScreens.tsx');

  it('no longer imports or renders the retired panels', () => {
    for (const gone of [
      'ServiceLanding',
      'KnowledgeAgentsPanel',
      'KnowledgeNightlyPanel',
      'AgentActivityPanel',
      'AgentControlPanel',
    ]) {
      expect(opsScreens).not.toContain(gone);
    }
  });

  it('mounts the merged AgentsPanel in Monitor and drops the "Watching:" line', () => {
    expect(opsScreens).toContain('<AgentsPanel />');
    expect(opsScreens).not.toContain('Watching: runtime');
  });
});

describe('Todos stub-button removal', () => {
  const todos = read('organisms/TodosPanel.tsx');
  it('no longer renders the disabled Create ticket / Spawn now stubs', () => {
    expect(todos).not.toContain('Create ticket');
    expect(todos).not.toContain('Spawn now');
    expect(todos).not.toContain('Retired in the run-ledger spine cutover');
  });
});
