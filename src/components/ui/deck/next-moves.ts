import type { OpsTodo, OpsTodoPriority } from '../../../lib/ace-api';
import type { RunLedgerBoard, Workspace } from '../../../lib/types';
import { parseDue } from './due';

// Honest per-project "next move" derivation for the Home deck. The ONLY sources
// are real run-ledger state (follow-ups + todo/in_progress card next actions)
// and open OpsTodos tagged to the workspace — never a fabricated item. Projects
// with no real item are omitted entirely (no-mock rule). Ranked priority →
// dueAt → updatedAt and capped to 3 per project. Pure + framework-free so the
// ranking is unit-testable without a render.

export type NextItem = {
  key: string;
  text: string;
  priorityRank: number; // 0 high · 1 medium · 2 low · 3 none
  dueMs: number; // Infinity when no due date (sorts last)
  updatedMs: number; // -Infinity when unknown (sorts last)
};

export function priorityRank(p: OpsTodoPriority | null): number {
  if (p === 'high') return 0;
  if (p === 'medium') return 1;
  if (p === 'low') return 2;
  return 3;
}

export function dueToMs(dueAt: string | null): number {
  if (!dueAt) return Infinity;
  const d = parseDue(dueAt);
  return d ? d.getTime() : Infinity;
}

export function compareNextItems(a: NextItem, b: NextItem): number {
  if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
  if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
  return b.updatedMs - a.updatedMs;
}

export function deriveNextMoves(
  board: RunLedgerBoard | null,
  workspaces: Workspace[],
  openTodos: OpsTodo[]
): Array<{ ws: Workspace; items: NextItem[] }> {
  const followUps = board?.followUps?.items ?? [];
  const cards = board?.cards ?? [];
  const out: Array<{ ws: Workspace; items: NextItem[] }> = [];
  for (const ws of workspaces) {
    const items: NextItem[] = [];
    for (const f of followUps) {
      if (f.workspaceId !== ws.id) continue;
      const text = (f.nextAction || f.summary || '').trim();
      if (!text) continue;
      items.push({
        key: `fu-${f.id}`,
        text,
        priorityRank: 3,
        dueMs: Infinity,
        updatedMs: typeof f.updatedAt === 'number' ? f.updatedAt : -Infinity,
      });
    }
    for (const c of cards) {
      if (c.workspaceId !== ws.id) continue;
      if (c.stage !== 'todo' && c.stage !== 'in_progress') continue;
      const text = (c.nextAction || '').trim();
      if (!text) continue;
      items.push({ key: `card-${c.id}`, text, priorityRank: 3, dueMs: Infinity, updatedMs: -Infinity });
    }
    for (const t of openTodos) {
      if (t.workspaceId !== ws.id) continue;
      items.push({
        key: `todo-${t.id}`,
        text: t.text,
        priorityRank: priorityRank(t.priority),
        dueMs: dueToMs(t.dueAt),
        updatedMs: t.updatedAt ? new Date(t.updatedAt).getTime() : -Infinity,
      });
    }
    if (items.length === 0) continue;
    items.sort(compareNextItems);
    out.push({ ws, items: items.slice(0, 3) });
  }
  return out;
}
