import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// R5/R6/R7 — source-text assertions (house idiom, see
// src/components/mobile-operations-access.test.ts): renderer freshness wiring
// is verified by asserting on component source rather than booting Electron.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const vectorOpsSource = read('organisms/VectorOpsPanel.tsx');
const itemRowSource = read('molecules/IntelItemRow.tsx');
const sectionCardSource = read('molecules/IntelSectionCard.tsx');
const sourcesPanelSource = read('organisms/SourcesPanel.tsx');
const briefsTabSource = read('organisms/BriefsTab.tsx');

describe('Intel tab scroll + refresh wiring (R5)', () => {
  it('VectorOpsPanel owns a scroll root instead of relying on the viewport', () => {
    expect(vectorOpsSource).toContain('overflow-y-auto');
    expect(vectorOpsSource).toContain('embedded ?');
    expect(vectorOpsSource).toContain('overflow-visible');
    expect(vectorOpsSource).toContain('scrollRef');
  });

  it('re-roots the IntersectionObserver to the panel scroller (never the viewport)', () => {
    expect(vectorOpsSource).toContain('root: scrollRef.current');
    expect(vectorOpsSource).not.toContain('root: null');
  });

  it('exposes a manual Refresh that calls ops.refresh and refetches intel', () => {
    expect(vectorOpsSource).toContain('aceApi.ops.refresh(');
    expect(vectorOpsSource).toContain('refreshing');
    expect(vectorOpsSource).toContain('setReloadNonce');
  });

  it('subscribes to scheduled-refresh pushes and shows the last pull stamp', () => {
    expect(vectorOpsSource).toContain('onIntelRefreshed');
    expect(vectorOpsSource).toContain('lastRefreshAt');
  });
});

describe('per-item and per-section honesty (R3/R4)', () => {
  it('IntelItemRow renders the structured timestamp as a relative age with ISO tooltip', () => {
    // item.timestamp is consumed via destructuring (`{ ..., timestamp, ... } = item`).
    expect(itemRowSource).toMatch(/\{[^}]*\btimestamp\b[^}]*\}\s*=\s*item/);
    expect(itemRowSource).toContain('formatRelativeTime');
    expect(itemRowSource).toMatch(/title=\{timestamp/);
  });

  it('IntelSectionCard shows provenance + freshness and an honest degrade row', () => {
    expect(sectionCardSource).toContain('provenance');
    expect(sectionCardSource).toContain('statusMessage');
    expect(sectionCardSource).toContain('IntelFreshnessChip');
    expect(sectionCardSource).toContain("'auth-needed'");
  });
});

describe('SourcesPanel real per-entry refresh state (R5)', () => {
  it('maps watchlist entries to refresh-engine source ids', () => {
    expect(sourcesPanelSource).toContain('feed:');
    expect(sourcesPanelSource).toContain('repo:');
    expect(sourcesPanelSource).toContain("'agent:social'");
    expect(sourcesPanelSource).toContain("'agent:vendors'");
  });

  it('renders per-entry status + last-success age and the registry-wide last pull', () => {
    expect(sourcesPanelSource).toContain('lastSuccess');
    expect(sourcesPanelSource).toContain('lastRunAt');
    expect(sourcesPanelSource).toContain('lastTrigger');
    expect(sourcesPanelSource).not.toContain("Fetch status isn't tracked yet");
  });
});

describe('BriefsTab source strip + delivery push (R6)', () => {
  it('loads the per-class source strip from ops.sourceState', () => {
    expect(briefsTabSource).toContain('aceApi.ops.sourceState()');
    expect(briefsTabSource).toContain('summarizeByClass');
  });

  it('reacts to brief-delivered and intel-refreshed broadcasts', () => {
    expect(briefsTabSource).toContain('onBriefDelivered');
    expect(briefsTabSource).toContain('onIntelRefreshed');
  });
});
