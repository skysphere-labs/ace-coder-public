/**
 * ops-todos-agent-digest.test.cts
 *
 * Unit tests for synthesizeTodoDigestWithAgent — the OPTIONAL headless-agent
 * refinement of the twice-daily todo digest, and (critically) its fail-closed
 * fallback to the deterministic synthesizeTodoDigest on ANY agent failure.
 *
 * Pure JS-compatible (JSDoc types only, no TS annotation syntax). Uses vitest.
 */

import { describe, it, expect } from 'vitest';

const {
  synthesizeTodoDigest,
  synthesizeTodoDigestWithAgent,
} = require('../ops-todos.cts');

const NOW = '2026-06-12T08:00:00.000Z';

// Three open todos with stable ids so agent-returned ids can be validated.
function fixture() {
  const base = {
    $schema: 'ace.ops.todo.v1',
    owner: null,
    promotedMissionId: null,
    notes: null,
    source: null,
    workspaceId: null,
    priority: null,
    dueAt: null,
    tags: [],
  };
  return [
    { ...base, id: 't1', text: 'Ship tag filters', kind: 'dev', status: 'open', priority: 'high', createdAt: '2026-06-10T08:00:00.000Z', updatedAt: '2026-06-10T08:00:00.000Z' },
    { ...base, id: 't2', text: 'Fix updater retry', kind: 'dev', status: 'assigned', createdAt: '2026-06-10T09:00:00.000Z', updatedAt: '2026-06-10T09:00:00.000Z' },
    { ...base, id: 't3', text: 'Book dentist', kind: 'life', status: 'open', createdAt: '2026-06-10T10:00:00.000Z', updatedAt: '2026-06-10T10:00:00.000Z' },
  ];
}

describe('synthesizeTodoDigestWithAgent — provenance + agent path', () => {
  it('returns the deterministic digest with source "rules" when no runAgent is given', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning' });
    expect(got.source).toBe('rules');
    expect(got).toEqual(rules);
  });

  it('uses the agent goals/suggestions and stamps source "agent" on valid JSON', async () => {
    const runAgent = async () =>
      JSON.stringify({
        goals: [
          { text: 'Land the filters', todoIds: ['t1'] },
          { text: 'untethered goal', todoIds: ['zzz'] }, // unknown id -> dropped entirely
        ],
        suggestions: [
          { todoId: 't2', suggestion: 'reproduce the failing retry' },
          { todoId: 'nope', suggestion: 'ignored — not a real id' },
        ],
      });
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning', runAgent });
    expect(got.source).toBe('agent');
    expect(got.goals).toEqual([{ text: 'Land the filters', todoIds: ['t1'] }]);
    expect(got.suggestions).toEqual([
      { todoId: 't2', text: 'Fix updater retry', suggestion: 'reproduce the failing retry' },
    ]);
    // Groups/openCount stay the deterministic projection over the SAME open set.
    expect(got.openCount).toBe(3);
    expect(got.markdown).toContain('synthesized by agent');
  });

  it('parses JSON wrapped in prose or a ```json fence', async () => {
    const runAgent = async () =>
      'Here is your digest:\n```json\n{"goals":[{"text":"Ship it","todoIds":["t1"]}],"suggestions":[]}\n```\nDone.';
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'night', runAgent });
    expect(got.source).toBe('agent');
    expect(got.goals).toEqual([{ text: 'Ship it', todoIds: ['t1'] }]);
  });
});

describe('synthesizeTodoDigestWithAgent — fail-closed fallback', () => {
  it('falls back to the identical deterministic digest when the agent runner THROWS', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const runAgent = async () => {
      throw new Error('agent unavailable');
    };
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning', runAgent });
    expect(got.source).toBe('rules');
    expect(got).toEqual(rules); // byte-for-byte identical to agent-off behavior
  });

  it('falls back when the agent runner throws synchronously', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const runAgent = () => {
      throw new Error('spawn failed');
    };
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning', runAgent });
    expect(got).toEqual(rules);
  });

  it('falls back (hard timeout) when the agent runner hangs', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const runAgent = () => new Promise(() => {}); // never resolves
    const got = await synthesizeTodoDigestWithAgent(fixture(), {
      now: NOW,
      slot: 'morning',
      runAgent,
      timeoutMs: 25,
    });
    expect(got.source).toBe('rules');
    expect(got).toEqual(rules);
  });

  it('falls back on non-JSON junk output', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const runAgent = async () => 'sorry, I could not do that';
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning', runAgent });
    expect(got).toEqual(rules);
  });

  it('falls back when the agent references only unknown ids and no suggestions', async () => {
    const rules = synthesizeTodoDigest(fixture(), { now: NOW, slot: 'morning' });
    const runAgent = async () =>
      JSON.stringify({ goals: [{ text: 'x', todoIds: ['nope'] }], suggestions: [] });
    const got = await synthesizeTodoDigestWithAgent(fixture(), { now: NOW, slot: 'morning', runAgent });
    expect(got).toEqual(rules);
  });

  it('does NOT invoke the agent for an empty open set', async () => {
    let called = false;
    const runAgent = async () => {
      called = true;
      return '{}';
    };
    const got = await synthesizeTodoDigestWithAgent([], { now: NOW, slot: 'morning', runAgent });
    expect(called).toBe(false);
    expect(got.source).toBe('rules');
    expect(got.openCount).toBe(0);
  });
});
