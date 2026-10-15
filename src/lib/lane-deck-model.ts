import type { Conversation, Task, Variant } from './types';

// Pure model for the Lane Deck (the per-workspace "every lane at once" grid):
// tile derivation, band grouping, row math, stream liveness, and the toggle
// transition. Kept free of runtime-registry imports so every contract here is
// unit-testable in node; the screen injects the chat-agent predicate and the
// stream-id formats mirror src/runtime/terminal-io.ts (asserted by
// lane-deck.test.ts so drift fails loudly instead of silently mis-wiring).

export type LaneTile = {
  key: string;
  streamId: string;
  agent: string;
  taskId: string;
  label: string;
  branch: string | null;
  /** Display name of the lane this validator lane is validating, if any. */
  validatorFor: string | null;
};

export type LaneBandId = 'claude' | 'other' | 'codex';

export type LaneBand = {
  id: LaneBandId;
  label: string;
  tiles: LaneTile[];
};

export type ValidatorLink = {
  validatorTaskId: string;
  targetTaskId: string | null;
  featureName: string;
};

// Column count per band, chosen so tiles stay terminal-shaped (wider than
// tall). Rows are derived from this, then tiles are dealt into rows as evenly
// as possible so an odd count stretches the short row instead of leaving a
// hole (5 → 3+2, 7 → 3+2+2).
export function computeBandColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function computeBandRows(count: number): number[] {
  if (count <= 0) return [];
  const rows = Math.ceil(count / computeBandColumns(count));
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => (i < extra ? base + 1 : base));
}

export function splitRows<T>(tiles: T[]): T[][] {
  const out: T[][] = [];
  let cursor = 0;
  for (const rowCount of computeBandRows(tiles.length)) {
    out.push(tiles.slice(cursor, cursor + rowCount));
    cursor += rowCount;
  }
  return out;
}

// A lane may only mount a terminal when its stream already exists in the
// control-plane catalog — mounting spawns the PTY, and the deck must never
// mass-start CLIs just to display them. `live` is optional on older payloads;
// absence of the field (but presence of the entry) counts as live.
export function isLiveEntry(entry: { live?: boolean } | null | undefined): boolean {
  return !!entry && entry.live !== false;
}

// The deck toggle's state transition, extracted so the contract is testable
// without mounting the store. Same workspace + deck already showing → exit to
// where the user was (their task's single view if one is still selected, else
// new-chat). Anything else → enter the deck; the active task is kept unless
// the deck is switching to a different workspace (a task restored against the
// wrong workspace would dead-end the exit path).
export function resolveLaneDeckToggle(
  state: { view: string; activeWorkspaceId: string | null; activeTaskId: string | null },
  workspaceId: string
): { nextView: 'lane-deck' | 'workspace' | 'new-chat'; clearActiveTask: boolean } {
  if (state.view === 'lane-deck' && state.activeWorkspaceId === workspaceId) {
    return {
      nextView: state.activeTaskId ? 'workspace' : 'new-chat',
      clearActiveTask: false,
    };
  }
  return {
    nextView: 'lane-deck',
    clearActiveTask: state.activeWorkspaceId !== workspaceId,
  };
}

function isCliVariant(variant: Variant, isChatAgent: (agent: string) => boolean): boolean {
  return variant.kind !== 'chat' && !isChatAgent(variant.agent);
}

function isCliConversation(
  conversation: Conversation,
  isChatAgent: (agent: string) => boolean
): boolean {
  return conversation.kind === 'cli' && !isChatAgent(conversation.agent);
}

export function buildLaneTiles(
  tasks: Task[],
  validatorLinks: ValidatorLink[],
  isChatAgent: (agent: string) => boolean
): LaneTile[] {
  const taskNameById = new Map(tasks.map((task) => [task.id, task.name]));
  const validatorFor = new Map<string, string>();
  for (const link of validatorLinks) {
    const target =
      (link.targetTaskId && taskNameById.get(link.targetTaskId)) || link.featureName;
    if (target && !validatorFor.has(link.validatorTaskId)) {
      validatorFor.set(link.validatorTaskId, target);
    }
  }

  const tiles: LaneTile[] = [];
  for (const task of tasks) {
    if (task.type === 'task') {
      const cliVariants = (task.worktrees ?? [])
        .flatMap((group) => group.variants)
        .filter((variant) => isCliVariant(variant, isChatAgent));
      for (const variant of cliVariants) {
        tiles.push({
          key: `variant:${variant.id}`,
          streamId: `variant:${variant.id}`,
          agent: variant.agent,
          taskId: task.id,
          label: cliVariants.length > 1 ? `${task.name} · ${variant.name}` : task.name,
          branch: variant.branch || task.branch || null,
          validatorFor: validatorFor.get(task.id) ?? null,
        });
      }
    } else {
      const cliConversations = (task.conversations ?? []).filter((conversation) =>
        isCliConversation(conversation, isChatAgent)
      );
      for (const conversation of cliConversations) {
        tiles.push({
          key: `conversation:${conversation.id}`,
          streamId: `conversation:${conversation.id}`,
          agent: conversation.agent,
          taskId: task.id,
          label:
            cliConversations.length > 1
              ? `${task.name} · ${conversation.title || 'CLI'}`
              : task.name,
          branch: null,
          validatorFor: validatorFor.get(task.id) ?? null,
        });
      }
    }
  }
  return tiles;
}

// Fixed vertical order: every Claude lane in the top band, every Codex lane in
// the bottom band, anything else (hermes, gemini, …) in between. Within a
// band, tiles keep the workspace's task order — no reshuffling between opens.
export function groupBands(tiles: LaneTile[]): LaneBand[] {
  const claude = tiles.filter((tile) => tile.agent === 'claude');
  const codex = tiles.filter((tile) => tile.agent === 'codex');
  const other = tiles.filter((tile) => tile.agent !== 'claude' && tile.agent !== 'codex');
  const bands: LaneBand[] = [];
  if (claude.length > 0) bands.push({ id: 'claude', label: 'Claude', tiles: claude });
  if (other.length > 0) bands.push({ id: 'other', label: 'Other agents', tiles: other });
  if (codex.length > 0) bands.push({ id: 'codex', label: 'Codex', tiles: codex });
  return bands;
}
