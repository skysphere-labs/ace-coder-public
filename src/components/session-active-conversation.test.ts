// Regression: clicking a non-active Hermes conversation while another one is
// busy must switch the view to the clicked conversation (msn-6ffb6349 A1).
// Two halves, both required:
//   1. the pane layout switches to the clicked tab unconditionally (it has no
//      notion of "busy", so a streaming conversation can never block it), and
//   2. SessionScreen mirrors the focused conversation into the core
//      active-conversation flag, which is what AgentLaneScreen lanes and
//      task-level stream routing (getTaskStreamId) render/route by. Before
//      the fix, tab select updated only the layout, so every isActive
//      consumer stayed stuck on the busy conversation.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openRef,
  selectTab,
  syncAvailableTabs,
  type TabRef,
} from '../runtime/pane-layout-registry';

const componentsDir = resolve(process.cwd(), 'src/components');
const sessionScreen = readFileSync(resolve(componentsDir, 'SessionScreen.tsx'), 'utf8');
const parallelTaskScreen = readFileSync(resolve(componentsDir, 'ParallelTaskScreen.tsx'), 'utf8');
const laneScreen = readFileSync(resolve(componentsDir, 'agents/AgentLaneScreen.tsx'), 'utf8');

const REFS: TabRef[] = [
  { kind: 'conversation', conversationId: 'conv-busy' },
  { kind: 'conversation', conversationId: 'conv-idle' },
];

function activeRef(taskId: string) {
  const layout = syncAvailableTabs(taskId, REFS);
  const pane = layout.columns[0].panes[0];
  return pane.tabs.find((t) => t.id === pane.activeTabId)?.ref;
}

describe('Hermes conversation switching while another conversation is busy', () => {
  it('selectTab switches the focused pane to the clicked conversation tab', () => {
    const taskId = 'task-switch-while-busy';
    const layout = syncAvailableTabs(taskId, REFS);
    const pane = layout.columns[0].panes[0];
    expect(pane.tabs).toHaveLength(2);
    // The first (busy) conversation starts as the active tab.
    expect(activeRef(taskId)).toEqual(REFS[0]);

    // Click the idle conversation: the layout must switch — nothing in the
    // layout registry consults busy state, so a streaming conversation can
    // never pin the selection.
    const idleTab = pane.tabs.find(
      (t) => t.ref.kind === 'conversation' && t.ref.conversationId === 'conv-idle'
    )!;
    selectTab(taskId, pane.id, idleTab.id);
    expect(activeRef(taskId)).toEqual(REFS[1]);
  });

  it('openRef (mobile tab switcher path) also activates the clicked conversation', () => {
    const taskId = 'task-openref-while-busy';
    syncAvailableTabs(taskId, REFS);
    openRef(taskId, REFS[1]);
    expect(activeRef(taskId)).toEqual(REFS[1]);
    openRef(taskId, REFS[0]);
    expect(activeRef(taskId)).toEqual(REFS[0]);
  });

  it('SessionScreen mirrors the focused conversation into the core active flag', () => {
    // The missing link before the fix: selectTab never touched
    // setActiveConversation, so is_active stayed on the busy conversation.
    expect(sessionScreen).toContain('setActiveConversation(activeTaskId, focusedConversationId)');
    expect(sessionScreen).toContain('if (focusedConversationId === activeConversationId) return;');
  });

  it('AgentLaneScreen renders the active conversation, so it follows the click', () => {
    expect(laneScreen).toContain('conversations.find((c) => c.isActive)');
  });

  it('ParallelTaskScreen exposes existing task conversations as selectable tabs on mobile', () => {
    expect(parallelTaskScreen).toContain("import { useTaskSessions } from '../runtime/session-registry';");
    expect(parallelTaskScreen).toContain('const sessionRecord = useTaskSessions(task.id);');
    expect(parallelTaskScreen).toContain("for (const c of conversations) refs.push({ kind: 'conversation', conversationId: c.id });");
    expect(parallelTaskScreen).toContain('getConversationStreamId(focusedConversation.id)');
    expect(parallelTaskScreen).toContain('<ConversationPane conversation={conv} taskId={task.id} />');
  });
});

// Regression (ft-08d2a768): clicking an EXISTING session/tab must select and
// reuse it — never route into the create-new-conversation path. The selection
// layer (pane-layout-registry) is pure local state with no API access, and
// the only create call site in the session surface is the explicit New-chat
// picker.
describe('existing-session clicks reuse, never create', () => {
  it('openRef on an already-open conversation activates the existing tab without duplicating it', () => {
    const taskId = 'task-reuse-existing';
    const layout = syncAvailableTabs(taskId, REFS);
    expect(layout.columns[0].panes[0].tabs).toHaveLength(2);

    openRef(taskId, REFS[1]);
    const after = syncAvailableTabs(taskId, REFS);
    const pane = after.columns[0].panes[0];
    expect(pane.tabs).toHaveLength(2);
    expect(activeRef(taskId)).toEqual(REFS[1]);
  });

  it('the selection layer cannot create sessions: pane-layout-registry has no API access', () => {
    const registry = readFileSync(
      resolve(process.cwd(), 'src/runtime/pane-layout-registry.ts'),
      'utf8'
    );
    expect(registry).not.toContain('aceApi');
    expect(registry).not.toContain('createConversation');
    expect(registry).not.toContain('openConversation');
  });

  it('MobileTabSwitcher opens existing tabs via openRef and never calls the create path', () => {
    const switcher = readFileSync(resolve(componentsDir, 'MobileTabSwitcher.tsx'), 'utf8');
    expect(switcher).toContain('openRef(taskId, ref)');
    expect(switcher).not.toContain('createConversation');
  });

  it('SessionScreen reaches createConversation only from the explicit New-chat picker', () => {
    // Exactly one create call site, and it lives in the NewItemPicker's
    // onSelectAgent callback — tab clicks route through selectTab/openRef.
    const createCalls = sessionScreen.match(/createConversation\(/g) ?? [];
    expect(createCalls).toHaveLength(1);
    expect(sessionScreen).toContain('onSelectTab={(paneId, tabId) => selectTab(taskId, paneId, tabId)}');
  });
});
