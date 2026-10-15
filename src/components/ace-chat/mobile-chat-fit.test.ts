import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// R2 — Hermes/agent chat + window panes must fit a narrow mobile viewport:
// no horizontal overflow, no duplicated toggle, no clipped composer. These
// assertions lock the structural invariants that keep the panes inside the
// viewport (this repo verifies renderer layout by asserting on source).
const here = dirname(fileURLToPath(import.meta.url));
const paneSource = readFileSync(resolve(here, 'AceChatPane.tsx'), 'utf8');
const shellSource = readFileSync(resolve(here, 'ComposerShell.tsx'), 'utf8');
const agentsSource = readFileSync(resolve(here, '../AgentsScreen.tsx'), 'utf8');
const agentLaneSource = readFileSync(resolve(here, '../agents/AgentLaneScreen.tsx'), 'utf8');

describe('mobile chat pane fit', () => {
  it('keeps the chat pane width-constrained (no horizontal overflow)', () => {
    // Root grid must clamp width and clip overflow so long terminal/markdown
    // content can never push the pane wider than the mobile viewport.
    expect(paneSource).toMatch(/grid h-full min-h-0 min-w-0 overflow-hidden/);
  });

  it('drops the duplicate in-pane toggle when the mobile composer owns it', () => {
    // Inside a workspace task on mobile, MobileTaskComposer renders the CLI/chat
    // toggle; the in-pane header would duplicate it and steal vertical space.
    expect(paneSource).toContain(
      "const mobileComposerCoversPane = isMobile && view === 'workspace'"
    );
    expect(paneSource).toContain('{!mobileComposerCoversPane && (');
    expect(paneSource).toContain('className="relative min-h-0 min-w-0 overflow-hidden"');
  });

  it('keeps the inline composer slot from forcing overflow', () => {
    expect(paneSource).toContain('ace-composer-slot min-w-0 shrink-0');
  });

  it('hands agent lanes an explicit full-height pane under mobile shell', () => {
    expect(agentsSource).toContain('<AgentLaneScreen key={activeLane.id} lane={activeLane} />');
    expect(agentLaneSource).toContain('className="flex h-full min-h-0 min-w-0 flex-col"');
  });

  it('does not spend agent lane height on an Operations link-out footer', () => {
    expect(agentLaneSource).not.toContain('MissionBoardLinkOut');
    expect(agentLaneSource).not.toContain('Mission Board moved to Operations');
  });
});

describe('mobile composer fit', () => {
  it('is viewport-aware', () => {
    expect(shellSource).toContain(
      "import { useIsMobileViewport } from '../../runtime/use-mobile-viewport'"
    );
    expect(shellSource).toContain('const isMobile = useIsMobileViewport();');
  });

  it('tightens padding on mobile and hides the desktop keyboard hint', () => {
    expect(shellSource).toContain("isMobile ? 'px-2 pb-2' : 'px-4 pb-4'");
    expect(shellSource).toMatch(/\{!isMobile && \([\s\S]*?Enter send · Shift\+Enter newline/);
  });

  it('lets the textarea shrink so dense controls never force overflow', () => {
    // flex-1 alone keeps min-width:auto; min-w-0 is what allows the input to
    // shrink past content width when several shrink-0 controls share the row.
    expect(shellSource).toMatch(/min-w-0 flex-1 resize-none/);
  });
});
