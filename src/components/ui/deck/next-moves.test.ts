import { describe, it, expect } from 'vitest';
import { deriveNextMoves, priorityRank, type NextItem } from './next-moves';
import type { OpsTodo } from '../../../lib/ace-api';
import type { RunLedgerBoard, Workspace } from '../../../lib/types';

// Minimal fixtures — only the fields deriveNextMoves reads matter; cast the rest.
function ws(id: string, name: string): Workspace {
  return { id, name, tasks: [] } as unknown as Workspace;
}

function todo(partial: Partial<OpsTodo> & { id: string; workspaceId: string | null }): OpsTodo {
  return {
    $schema: 'ace.ops.todo.v1',
    text: partial.text ?? partial.id,
    kind: 'dev',
    owner: null,
    status: 'open',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    promotedMissionId: null,
    notes: null,
    source: null,
    priority: null,
    dueAt: null,
    tags: [],
    ...partial,
  } as OpsTodo;
}

function board(over: Partial<RunLedgerBoard>): RunLedgerBoard {
  return {
    columns: { todo: [], in_progress: [], ready_to_review: [], done: [], blocked: [] },
    cards: [],
    counts: { todo: 0, inProgress: 0, readyToReview: 0, done: 0, blocked: 0, total: 0 },
    ...over,
  } as unknown as RunLedgerBoard;
}

describe('priorityRank', () => {
  it('orders high < medium < low < none', () => {
    expect(priorityRank('high')).toBeLessThan(priorityRank('medium'));
    expect(priorityRank('medium')).toBeLessThan(priorityRank('low'));
    expect(priorityRank('low')).toBeLessThan(priorityRank(null));
  });
});

describe('deriveNextMoves — honest sourcing', () => {
  it('omits projects with no real item (no fabricated rows)', () => {
    const out = deriveNextMoves(board({}), [ws('w1', 'Alpha'), ws('w2', 'Beta')], []);
    expect(out).toEqual([]);
  });

  it('includes only the workspace an item is tagged to', () => {
    const todos = [todo({ id: 't1', workspaceId: 'w1', text: 'do alpha thing' })];
    const out = deriveNextMoves(board({}), [ws('w1', 'Alpha'), ws('w2', 'Beta')], todos);
    expect(out).toHaveLength(1);
    expect(out[0].ws.id).toBe('w1');
    expect(out[0].items.map((i: NextItem) => i.text)).toEqual(['do alpha thing']);
  });

  it('unions run-ledger follow-ups, todo/in_progress card next actions, and open todos', () => {
    const b = {
      columns: { todo: [], in_progress: [], ready_to_review: [], done: [], blocked: [] },
      counts: { todo: 0, inProgress: 0, readyToReview: 0, done: 0, blocked: 0, total: 0 },
      cards: [
        { id: 'c1', workspaceId: 'w1', stage: 'in_progress', nextAction: 'review the PR' },
        { id: 'c2', workspaceId: 'w1', stage: 'done', nextAction: 'should be excluded' },
        { id: 'c3', workspaceId: 'w1', stage: 'todo', nextAction: null }, // no action -> skipped
      ],
      followUps: {
        $schema: 'ace.follow-up-digest.v1',
        generatedAt: 0,
        pendingCount: 1,
        text: '',
        items: [{ id: 'f1', workspaceId: 'w1', nextAction: 'ship follow-up', updatedAt: 100 }],
      },
    } as unknown as RunLedgerBoard;
    const todos = [todo({ id: 't1', workspaceId: 'w1', text: 'open todo item' })];
    const out = deriveNextMoves(b, [ws('w1', 'Alpha')], todos);
    const texts = out[0].items.map((i: NextItem) => i.text);
    expect(texts).toContain('ship follow-up');
    expect(texts).toContain('review the PR');
    expect(texts).toContain('open todo item');
    expect(texts).not.toContain('should be excluded');
  });

  it('ranks high-priority todos ahead and caps each project at 3', () => {
    const todos = [
      todo({ id: 'lo', workspaceId: 'w1', text: 'low', priority: 'low' }),
      todo({ id: 'hi', workspaceId: 'w1', text: 'high', priority: 'high' }),
      todo({ id: 'md', workspaceId: 'w1', text: 'medium', priority: 'medium' }),
      todo({ id: 'no', workspaceId: 'w1', text: 'none', priority: null }),
    ];
    const out = deriveNextMoves(board({}), [ws('w1', 'Alpha')], todos);
    expect(out[0].items).toHaveLength(3);
    expect(out[0].items[0].text).toBe('high');
    expect(out[0].items[1].text).toBe('medium');
    expect(out[0].items[2].text).toBe('low');
  });

  it('breaks priority ties by earlier due date', () => {
    const todos = [
      todo({ id: 'later', workspaceId: 'w1', text: 'later', priority: 'high', dueAt: '2026-07-10' }),
      todo({ id: 'sooner', workspaceId: 'w1', text: 'sooner', priority: 'high', dueAt: '2026-06-15' }),
    ];
    const out = deriveNextMoves(board({}), [ws('w1', 'Alpha')], todos);
    expect(out[0].items[0].text).toBe('sooner');
  });
});
