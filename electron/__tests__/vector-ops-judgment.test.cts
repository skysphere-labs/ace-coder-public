/**
 * vector-ops-judgment.test.cts
 *
 * FIX 3 — freshness fallback + provenance:
 *   - synthesizeBrief falls back to locally pulled intel when the external
 *     report is expired/missing, and stamps brief.provenance
 *     (external | merged | local | missing).
 *   - synthesizeIntel stamps a top-level provenance from the section merge.
 *
 * FIX 4 — judgeIntel: the OPTIONAL headless-agent judgment pass. Happy path
 *   (authored why/move/nextAction + relevance-filter + dedup + judged:true) and,
 *   critically, fail-closed to the verbatim payload (judged:false) on no runner,
 *   throw, hang, and junk output. Mirrors ops-todos' fail-closed patterns.
 *
 * Plain CJS (no TS annotation syntax).
 */

import { describe, it, expect } from 'vitest';

const {
  synthesizeBrief,
  synthesizeIntel,
  judgeIntel,
} = require('../vector-ops-adapter.cts');

const NOW = Date.parse('2026-07-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// A minimal external report with a top signal + one project fit.
function report(generatedAt) {
  return {
    generated_at: generatedAt,
    executive_summary: 'exec',
    new_count: 1,
    top_signals: [{ title: 'External signal', is_new: true, why: 'w', move: 'm', url: null }],
    project_fit: [{ project: 'Proj', priority: 'P1', fit: 'High', why: 'fits', moves: ['ship it'] }],
  };
}

// Locally pulled intel (ace.ops.intel-local.v1) — a fresh official_feeds pull.
function localIntel(fetchedAt) {
  return {
    $schema: 'ace.ops.intel-local.v1',
    generatedAt: fetchedAt,
    sections: [
      {
        key: 'official_feeds',
        title: 'Official feeds',
        provenance: 'native',
        fetchedAt,
        items: [
          { id: 'lf1', title: 'Local feed item', summary: 'from a live pull', url: 'https://example.invalid/lf1', timestamp: fetchedAt },
        ],
      },
    ],
  };
}

describe('FIX 3 — synthesizeBrief freshness fallback + provenance', () => {
  it('fresh external report: provenance external, no Local intel section', () => {
    const brief = synthesizeBrief(report('2026-07-01T11:00:00.000Z'), 'morning', {
      now: NOW,
      sourceFreshness: 'fresh',
      intelAsOf: '2026-07-01T11:00:00.000Z',
      localIntel: localIntel('2026-07-01T11:30:00.000Z'),
    });
    expect(brief.provenance).toBe('external');
    expect(brief.sections.find((s) => s.title === 'Local intel (live pull)')).toBeUndefined();
  });

  it('expired external report + local intel: provenance merged, Local intel section present', () => {
    const brief = synthesizeBrief(report('2026-06-29T11:00:00.000Z'), 'morning', {
      now: NOW,
      sourceFreshness: 'expired',
      intelAsOf: '2026-06-29T11:00:00.000Z',
      localIntel: localIntel('2026-07-01T06:00:00.000Z'),
    });
    expect(brief.provenance).toBe('merged');
    const local = brief.sections.find((s) => s.title === 'Local intel (live pull)');
    expect(local).toBeDefined();
    expect(local.items[0].text).toBe('Local feed item');
  });

  it('no external report + local intel: provenance local, headline names the fallback', () => {
    const brief = synthesizeBrief(null, 'morning', {
      now: NOW,
      sourceFreshness: 'missing',
      intelAsOf: null,
      localIntel: localIntel('2026-07-01T06:00:00.000Z'),
    });
    expect(brief.provenance).toBe('local');
    expect(brief.headline).toMatch(/locally pulled/i);
    expect(brief.sections.find((s) => s.title === 'Local intel (live pull)')).toBeDefined();
  });

  it('no external report + no local: provenance missing, headline Intel unavailable', () => {
    const brief = synthesizeBrief(null, 'morning', { now: NOW, sourceFreshness: 'missing', intelAsOf: null });
    expect(brief.provenance).toBe('missing');
    expect(brief.headline).toBe('Intel unavailable');
    expect(brief.sections).toEqual([]);
  });
});

describe('FIX 3 — synthesizeIntel top-level provenance', () => {
  it('report only -> external', () => {
    const intel = synthesizeIntel(report('2026-07-01T11:00:00.000Z'), { now: NOW, sourceFreshness: 'fresh' });
    expect(intel.provenance).toBe('external');
  });

  it('report + fresher local section -> merged', () => {
    const intel = synthesizeIntel(report('2026-06-29T11:00:00.000Z'), {
      now: NOW,
      localIntel: localIntel('2026-07-01T06:00:00.000Z'),
    });
    expect(intel.provenance).toBe('merged');
  });

  it('no report + local -> local', () => {
    const intel = synthesizeIntel(null, { now: NOW, localIntel: localIntel('2026-07-01T06:00:00.000Z') });
    expect(intel.provenance).toBe('local');
  });

  it('no report + no local -> missing', () => {
    const intel = synthesizeIntel(null, { now: NOW });
    expect(intel.provenance).toBe('missing');
  });
});

// ── FIX 4 — judgeIntel ──────────────────────────────────────────────────────

// Minimal intel payload with two items in one section (judgeIntel only reads
// sections[].items[].{id,title,summary,url,why,move}).
function intelPayload() {
  return {
    $schema: 'ace.ops.intel.v1',
    sections: [
      {
        key: 'top_signals',
        title: 'Top Signals',
        items: [
          { id: 'a', title: 'Signal A', summary: 'about A', url: 'https://x.invalid/a', why: 'old-why', move: 'old-move' },
          { id: 'b', title: 'Signal B', summary: 'about B', url: 'https://x.invalid/b', why: null, move: null },
        ],
      },
    ],
  };
}

describe('FIX 4 — judgeIntel verbatim baseline (no runner)', () => {
  it('stamps judged:false on every item and top-level when no runAgent', async () => {
    const out = await judgeIntel(intelPayload(), {});
    expect(out.judged).toBe(false);
    expect(out.sections[0].items.length).toBe(2);
    expect(out.sections[0].items.every((it) => it.judged === false)).toBe(true);
    // Verbatim: original why/move untouched.
    expect(out.sections[0].items[0].why).toBe('old-why');
  });
});

describe('FIX 4 — judgeIntel happy path', () => {
  it('authors why/move/nextAction, applies the relevance filter, stamps judged:true', async () => {
    const runAgent = async () =>
      JSON.stringify({
        items: [
          { id: 'a', keep: true, why: 'why it matters', move: 'do the thing', nextAction: 'open PR' },
          { id: 'b', keep: false },
        ],
      });
    const out = await judgeIntel(intelPayload(), { runAgent });
    expect(out.judged).toBe(true);
    // b was relevance-filtered out; a was re-authored.
    expect(out.sections[0].items.length).toBe(1);
    const a = out.sections[0].items[0];
    expect(a.id).toBe('a');
    expect(a.judged).toBe(true);
    expect(a.why).toBe('why it matters');
    expect(a.move).toBe('do the thing');
    expect(a.nextAction).toBe('open PR');
  });

  it('dedups items sharing a url on the judged path', async () => {
    const payload = {
      sections: [
        {
          key: 'top_signals',
          title: 'Top Signals',
          items: [
            { id: 'x', title: 'X', summary: '', url: 'https://dup.invalid/1', why: null, move: null },
            { id: 'y', title: 'Y', summary: '', url: 'https://dup.invalid/1', why: null, move: null },
            { id: 'z', title: 'Z', summary: '', url: 'https://uniq.invalid/2', why: null, move: null },
          ],
        },
      ],
    };
    const runAgent = async () =>
      JSON.stringify({ items: [{ id: 'x', keep: true }, { id: 'z', keep: true }] });
    const out = await judgeIntel(payload, { runAgent });
    const ids = out.sections[0].items.map((it) => it.id);
    expect(ids).toEqual(['x', 'z']); // y dropped as a url duplicate of x
  });
});

describe('FIX 4 — judgeIntel fail-closed (verbatim on any failure)', () => {
  function assertVerbatim(out) {
    expect(out.judged).toBe(false);
    expect(out.sections[0].items.length).toBe(2);
    expect(out.sections[0].items.every((it) => it.judged === false)).toBe(true);
    expect(out.sections[0].items[0].why).toBe('old-why');
  }

  it('runner THROWS -> verbatim', async () => {
    const out = await judgeIntel(intelPayload(), {
      runAgent: async () => {
        throw new Error('agent down');
      },
    });
    assertVerbatim(out);
  });

  it('runner throws synchronously -> verbatim', async () => {
    const out = await judgeIntel(intelPayload(), {
      runAgent: () => {
        throw new Error('spawn failed');
      },
    });
    assertVerbatim(out);
  });

  it('runner HANGS (hard timeout) -> verbatim', async () => {
    const out = await judgeIntel(intelPayload(), {
      runAgent: () => new Promise(() => {}),
      timeoutMs: 25,
    });
    assertVerbatim(out);
  });

  it('runner returns junk -> verbatim', async () => {
    const out = await judgeIntel(intelPayload(), { runAgent: async () => 'sorry, cannot help' });
    assertVerbatim(out);
  });

  it('runner returns valid JSON referencing only unknown ids -> verbatim', async () => {
    const out = await judgeIntel(intelPayload(), {
      runAgent: async () => JSON.stringify({ items: [{ id: 'zzz', keep: true, why: 'x' }] }),
    });
    assertVerbatim(out);
  });
});
