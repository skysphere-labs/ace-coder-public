import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLaneTiles,
  computeBandRows,
  groupBands,
  isLiveEntry,
  resolveLaneDeckToggle,
  splitRows,
} from '../lib/lane-deck-model';
import { DECK_FIXTURE_LINKS, DECK_FIXTURE_TASKS } from './lane-deck-fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

describe('lane deck — band row math (even and odd counts)', () => {
  it('deals tiles into rows as evenly as possible, never leaving a hole', () => {
    expect(computeBandRows(0)).toEqual([]);
    expect(computeBandRows(1)).toEqual([1]);
    expect(computeBandRows(2)).toEqual([2]);
    expect(computeBandRows(3)).toEqual([2, 1]);
    expect(computeBandRows(4)).toEqual([2, 2]);
    expect(computeBandRows(5)).toEqual([3, 2]);
    expect(computeBandRows(6)).toEqual([3, 3]);
    expect(computeBandRows(7)).toEqual([3, 2, 2]);
    expect(computeBandRows(9)).toEqual([3, 3, 3]);
    expect(computeBandRows(10)).toEqual([4, 3, 3]);
    expect(computeBandRows(13)).toEqual([4, 3, 3, 3]);
  });

  it('always accounts for every tile and keeps rows within one tile of each other', () => {
    for (let n = 1; n <= 40; n++) {
      const rows = computeBandRows(n);
      expect(rows.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
    }
  });

  it('splitRows preserves order across rows', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e'];
    expect(splitRows(tiles)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });
});

describe('lane deck — stream liveness boundary', () => {
  it('only catalog entries not explicitly dead count as live', () => {
    // Missing entry = stream not in the control-plane catalog: mounting a
    // terminal would spawn the CLI, so the tile must stay dormant.
    expect(isLiveEntry(undefined)).toBe(false);
    expect(isLiveEntry(null)).toBe(false);
    expect(isLiveEntry({ live: false })).toBe(false);
    expect(isLiveEntry({ live: true })).toBe(true);
    // Older payloads omit `live`; presence of the entry counts as live.
    expect(isLiveEntry({})).toBe(true);
  });
});

describe('lane deck — toggle lifecycle', () => {
  it('enters the deck from a task view without dropping the task', () => {
    expect(
      resolveLaneDeckToggle(
        { view: 'workspace', activeWorkspaceId: 'ws1', activeTaskId: 't1' },
        'ws1'
      )
    ).toEqual({ nextView: 'lane-deck', clearActiveTask: false });
  });

  it('exits back to the kept task, or new-chat when none is selected', () => {
    expect(
      resolveLaneDeckToggle(
        { view: 'lane-deck', activeWorkspaceId: 'ws1', activeTaskId: 't1' },
        'ws1'
      )
    ).toEqual({ nextView: 'workspace', clearActiveTask: false });
    expect(
      resolveLaneDeckToggle(
        { view: 'lane-deck', activeWorkspaceId: 'ws1', activeTaskId: null },
        'ws1'
      )
    ).toEqual({ nextView: 'new-chat', clearActiveTask: false });
  });

  it('switching the deck to another workspace stays in the deck and drops the foreign task', () => {
    expect(
      resolveLaneDeckToggle(
        { view: 'lane-deck', activeWorkspaceId: 'ws1', activeTaskId: 't1' },
        'ws2'
      )
    ).toEqual({ nextView: 'lane-deck', clearActiveTask: true });
    expect(
      resolveLaneDeckToggle(
        { view: 'new-chat', activeWorkspaceId: 'ws1', activeTaskId: 't1' },
        'ws2'
      )
    ).toEqual({ nextView: 'lane-deck', clearActiveTask: true });
  });
});

const noChat = () => false;

describe('lane deck — tiles and bands', () => {
  it('builds one tile per CLI variant/conversation, skipping chat panes', () => {
    const tiles = buildLaneTiles(DECK_FIXTURE_TASKS, DECK_FIXTURE_LINKS, noChat);
    expect(tiles.map((t) => t.streamId)).toEqual([
      'variant:v-codex',
      'variant:v-claude',
      'variant:v-val',
      'conversation:c1',
    ]);
  });

  it('labels a validator lane with the lane it validates', () => {
    const tiles = buildLaneTiles(DECK_FIXTURE_TASKS, DECK_FIXTURE_LINKS, noChat);
    const validator = tiles.find((t) => t.taskId === 't-validator');
    expect(validator?.validatorFor).toBe('claude worker');
    const worker = tiles.find((t) => t.taskId === 't-claude');
    expect(worker?.validatorFor).toBeNull();
  });

  it('falls back to the mission feature name when the target task is gone', () => {
    const tiles = buildLaneTiles(
      DECK_FIXTURE_TASKS,
      [{ validatorTaskId: 't-validator', targetTaskId: 't-deleted', featureName: 'feature y' }],
      noChat
    );
    expect(tiles.find((t) => t.taskId === 't-validator')?.validatorFor).toBe('feature y');
  });

  it('groups claude on top, codex at the bottom, everything else between', () => {
    const bands = groupBands(buildLaneTiles(DECK_FIXTURE_TASKS, DECK_FIXTURE_LINKS, noChat));
    expect(bands.map((b) => b.id)).toEqual(['claude', 'other', 'codex']);
    expect(bands[0].tiles.map((t) => t.streamId)).toEqual(['variant:v-claude']);
    expect(bands[1].tiles.map((t) => t.streamId)).toEqual(['conversation:c1']);
    // Codex band keeps workspace task order: worker lane before validator lane.
    expect(bands[2].tiles.map((t) => t.streamId)).toEqual(['variant:v-codex', 'variant:v-val']);
  });

  it('also drops variants/conversations whose agent the app treats as chat-only', () => {
    const tiles = buildLaneTiles(DECK_FIXTURE_TASKS, DECK_FIXTURE_LINKS, (agent) => agent === 'gemini');
    expect(tiles.some((t) => t.streamId === 'conversation:c1')).toBe(false);
  });
});

describe('lane deck — structural wiring', () => {
  const store = read('../store.tsx');
  const canvas = read('WorkspaceCanvas.tsx');
  const terminalIo = read('../runtime/terminal-io.ts');

  it("registers 'lane-deck' as a persisted view", () => {
    expect(store).toContain("| 'lane-deck'");
    expect(store).toMatch(/PERSISTED_VIEWS[\s\S]*?'lane-deck'/);
  });

  it('routes the deck view from the canvas before the active task', () => {
    // The deck must win over the active task: it keeps the task selected on
    // purpose (so exit restores it), which would otherwise render the single
    // task screen instead of the deck.
    expect(canvas).toMatch(/view === 'lane-deck'[\s\S]*?LaneDeckScreen/);
    expect(canvas.indexOf("view === 'lane-deck'")).toBeLessThan(canvas.indexOf('if (activeTask)'));
  });

  it('keeps the model stream-id formats in sync with terminal-io', () => {
    // lane-deck-model builds stream ids literally (it must stay import-free of
    // runtime registries); these assertions fail if terminal-io ever changes
    // its formats out from under it.
    expect(terminalIo).toContain('`variant:${variantId}`');
    expect(terminalIo).toContain('`conversation:${conversationId}`');
  });
});
