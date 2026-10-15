import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// LaneDeckBody is pure props; the module-level imports need the app bridge
// stubbed the same way ledger-usage-subscriptions.render.test.tsx does
// (effects never run in a static render, so no timers or subscriptions leak).
// TerminalFeed is replaced with a marker div: what the deck must guarantee is
// WHICH tiles mount a terminal (live streams only — mounting spawns the PTY)
// and with which streamId, not xterm internals.
vi.mock('./TerminalFeed', () => ({
  TerminalFeed: ({ streamId }: { streamId: string | null }) => (
    <div data-testid="terminal-feed" data-stream={streamId ?? ''} />
  ),
}));
vi.mock('../lib/ace-api', () => ({
  aceApi: {
    streams: { listStreams: async () => ({ streams: [] }), onEvent: () => () => {} },
  },
}));
vi.mock('../store', () => ({
  useApp: () => ({ openTask: () => {}, toggleLaneDeck: () => {} }),
}));

import { LaneDeckBody } from './LaneDeckScreen';
import { buildLaneTiles } from '../lib/lane-deck-model';
import { DECK_FIXTURE_LINKS, DECK_FIXTURE_TASKS } from './lane-deck-fixtures';

const TILES = buildLaneTiles(DECK_FIXTURE_TASKS, DECK_FIXTURE_LINKS, () => false);
const noop = () => {};

function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

const ALL_LIVE = Object.fromEntries(
  TILES.map((t) => [t.streamId, { streamId: t.streamId, state: 'busy', live: true }])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any;

describe('LaneDeckBody — rendering contract', () => {
  it('renders bands top-to-bottom: Claude, other agents, Codex', () => {
    const html = render(
      <LaneDeckBody
        workspaceName="acme"
        tiles={TILES}
        liveById={ALL_LIVE}
        onExpand={noop}
        onExit={noop}
      />
    );
    const claudeAt = html.indexOf('Claude · 1 lane');
    const otherAt = html.indexOf('Other agents · 1 lane');
    const codexAt = html.indexOf('Codex · 2 lanes');
    expect(claudeAt).toBeGreaterThan(-1);
    expect(otherAt).toBeGreaterThan(claudeAt);
    expect(codexAt).toBeGreaterThan(otherAt);
  });

  it('mounts a terminal for live streams only; dormant lanes get a placeholder', () => {
    const oneLive = {
      'variant:v-claude': { streamId: 'variant:v-claude', state: 'busy', live: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const html = render(
      <LaneDeckBody
        workspaceName="acme"
        tiles={TILES}
        liveById={oneLive}
        onExpand={noop}
        onExit={noop}
      />
    );
    expect(html).toContain('data-stream="variant:v-claude"');
    expect(html).not.toContain('data-stream="variant:v-codex"');
    // The three dormant lanes each render the do-not-spawn placeholder.
    expect(html.match(/Not running — open the lane to start it/g)).toHaveLength(3);
    expect(html).toContain('1/4 live');
  });

  it('labels validator lanes with the lane they validate', () => {
    const html = render(
      <LaneDeckBody
        workspaceName="acme"
        tiles={TILES}
        liveById={ALL_LIVE}
        onExpand={noop}
        onExit={noop}
      />
    );
    expect(html).toContain('validates · claude worker');
  });

  it('sizes bands so tile heights match: flex-basis absorbs header+gap overhead, flex-grow carries rows', () => {
    const html = render(
      <LaneDeckBody
        workspaceName="acme"
        tiles={TILES}
        liveById={ALL_LIVE}
        onExpand={noop}
        onExit={noop}
      />
    );
    // Single-row bands (claude, other, codex-with-2-tiles all fit one row):
    // grow 1, basis 16px header + 1×6px gap = 22px.
    expect(html).toContain('flex-grow:1');
    expect(html).toContain('flex-basis:22px');
    // No band section may set min-h-0 — that would let a short viewport
    // collapse a band under its rows and overlap the next band instead of
    // scrolling. (The rows keep their 150px floor; the section's natural
    // min-height is what makes the deck container scroll.)
    expect(html).not.toMatch(/<section[^>]*min-h-0/);
  });

  it('shows the spinner until the first liveness snapshot, and an empty state without lanes', () => {
    const loading = render(
      <LaneDeckBody
        workspaceName="acme"
        tiles={TILES}
        liveById={null}
        onExpand={noop}
        onExit={noop}
      />
    );
    expect(loading).not.toContain('data-testid="terminal-feed"');
    const empty = render(
      <LaneDeckBody workspaceName="acme" tiles={[]} liveById={{}} onExpand={noop} onExit={noop} />
    );
    expect(empty).toContain('No lanes in this workspace yet');
  });
});
