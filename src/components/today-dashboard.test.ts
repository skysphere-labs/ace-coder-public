import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const today = readFileSync(resolve(here, 'TodayDashboard.tsx'), 'utf8');

describe('Today dashboard', () => {
  it('reads live workspace/task data, never mock rows', () => {
    expect(today).toContain('useCoreSelector');
    expect(today).toContain('useBusyTaskIds'); // "running" derived from live PTY activity
  });

  it('has active-agents and recent sections that degrade to real empty states', () => {
    expect(today).toContain('Active');
    expect(today).toContain('Recent');
    expect(today).toContain('MobileEmptyState'); // empty != fake
  });

  // A1/A4 regression guard: Today must render the MINIMAL todo surface, never the
  // dense Operations <TodosPanel/> directly. This fails the moment Today reverts
  // to embedding the full panel.
  it('renders the minimal Today todo surface, not the dense Operations TodosPanel', () => {
    expect(today).toContain("import { TodayTodos } from './TodayTodos'");
    expect(today).toContain('<TodayTodos />');
    expect(today).not.toContain('TodosPanel');
    expect(today).not.toContain('New task');
    expect(today).not.toContain("startNew('task')");
  });

  it('keeps secondary quick actions wired to real navigation/store actions', () => {
    expect(today).toContain('New chat');
    expect(today).toContain('setPendingChatKind');
    expect(today).toContain("setView('teams')");
    // The retired Operations hub link is replaced by the promoted-surface grid.
    expect(today).not.toContain("setView('operations')");
    expect(today).toContain("setView('board')");
    expect(today).toContain("setView('sky')");
  });

  it('is composed from the shared mobile atoms', () => {
    expect(today).toContain("from './ui/mobile'");
    expect(today).toContain('MobileListRow');
    expect(today).toContain('IconWell');
  });
});
