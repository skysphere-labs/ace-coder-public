import { useEffect, useMemo, useState } from 'react';
import { Globe, StickyNote, TerminalSquare, Loader2 } from 'lucide-react';
import { setActiveDisplayAgent } from '../runtime/active-agent-registry';
import { setFocusedVariant } from '../runtime/focused-variant-registry';
import { aceApi } from '../lib/ace-api';
import { getAgentAccentColor, getTerminalBackground } from '../lib/agent-style';
import AgentLogo from './ProviderGlyph';
import { FileIcon } from './FileIcon';
import PaneGrid from './multi-agent/PaneGrid';
import { TabIcon } from './multi-agent/TabIcon';
import { AgentRuntimeBanner } from './AgentRuntimeBanner';
import { TaskLinkBadges } from './TaskLinkBadges';
import { ConversationPane } from './ConversationPane';
import { EditorPane } from './EditorPane';
import { TerminalPanel } from './TerminalPanel';
import { TerminalBottomDrawer } from './TerminalBottomDrawer';
import { NewItemPicker } from './NewItemPicker';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useNewTabHandler } from '../runtime/mobile-new-tab-bus';
import { useIsMobileViewport } from '../runtime/use-mobile-viewport';
import { BrowserPane } from './BrowserPane';
import { NotesPane } from './NotesPane';
import {
  closeScratchTab,
  hydrateScratchTabs,
  openBrowserTab,
  openNotesTab,
  useScratchTabs,
} from '../runtime/scratch-tabs-registry';
import { useApp } from '../store';
import {
  closeConversation,
  createConversation,
  setActiveConversation,
  useTaskSessions,
} from '../runtime/session-registry';
import { getConversationStreamId, getTaskStreamId } from '../runtime/terminal-io';
import {
  closeFile,
  hydrateEditorOpenFiles,
  useEditorState,
} from '../runtime/editor-registry';
import {
  closeTerminal,
  useTerminalState,
} from '../runtime/terminal-mode';
import {
  closeTab,
  focusPane as focusPaneFn,
  moveTabToPane,
  openRef,
  selectTab,
  splitColumn,
  splitRow,
  syncAvailableTabs,
  usePaneLayout,
  type PaneTab,
  type TabRef,
} from '../runtime/pane-layout-registry';
import type { TabPresentation } from './multi-agent/PaneTabStrip';
import type { ContextMenuItem } from './FileContextMenu';

export function SessionScreen() {
  const { activeTask, activeWorkspace } = useApp();
  const activeTaskId = activeTask?.id ?? null;
  const sessionRecord = useTaskSessions(activeTaskId);
  const fallbackStreamId = activeTaskId ? getTaskStreamId(activeTaskId) : null;
  const [addingAgent, setAddingAgent] = useState(false);
  useMobileBackHandler(addingAgent, () => setAddingAgent(false));
  useNewTabHandler(() => setAddingAgent(true));
  const isMobile = useIsMobileViewport();

  const agent = activeTask?.agent ?? 'claude';
  const isAgentInstalled = activeTask?.agentInstalled !== false;
  const cliStartError = activeTask?.installError;
  const conversations = useMemo(
    () => sessionRecord?.conversations ?? [],
    [sessionRecord?.conversations]
  );

  const editorState = useEditorState(activeTaskId);
  const { open: termOpen, mode: termMode } = useTerminalState(activeTaskId);
  const scratchState = useScratchTabs(activeTaskId);

  const [hydratedTaskId, setHydratedTaskId] = useState<string | null>(null);
  const hydrated = !!activeTaskId && hydratedTaskId === activeTaskId;
  useEffect(() => {
    if (!activeTaskId) return;
    let cancelled = false;
    void Promise.all([
      hydrateScratchTabs(activeTaskId),
      hydrateEditorOpenFiles(activeTaskId),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHydratedTaskId(activeTaskId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTaskId]);

  const availableRefs = useMemo<TabRef[]>(() => {
    const refs: TabRef[] = [];
    for (const c of conversations) refs.push({ kind: 'conversation', conversationId: c.id });
    for (const f of editorState.openFiles) refs.push({ kind: 'file', path: f.path });
    if (termOpen && termMode === 'tab') refs.push({ kind: 'terminal' });
    for (const s of scratchState.tabs) refs.push({ kind: 'scratch', tabId: s.id });
    return refs;
  }, [conversations, editorState.openFiles, termOpen, termMode, scratchState.tabs]);

  useEffect(() => {
    if (!activeTaskId) return;
    syncAvailableTabs(activeTaskId, availableRefs, { prune: hydrated });
  }, [activeTaskId, availableRefs, hydrated]);

  const layout = usePaneLayout(activeTaskId);

  const focusedPane = useMemo(() => {
    for (const col of layout.columns) {
      const pane = col.panes.find((p) => p.id === layout.focusedPaneId);
      if (pane) return pane;
    }
    return null;
  }, [layout]);
  const focusedTab = useMemo(
    () => focusedPane?.tabs.find((t) => t.id === focusedPane.activeTabId) ?? null,
    [focusedPane]
  );
  const focusedRef = focusedTab?.ref ?? null;

  const focusedConversation = useMemo(() => {
    if (focusedRef?.kind !== 'conversation') return null;
    return conversations.find((c) => c.id === focusedRef.conversationId) ?? null;
  }, [focusedRef, conversations]);

  useEffect(() => {
    if (!activeTaskId || !focusedConversation) return;
    setActiveDisplayAgent(activeTaskId, focusedConversation.agent);
  }, [activeTaskId, focusedConversation]);

  useEffect(() => {
    if (!activeTaskId) return;
    if (!focusedConversation) {
      setFocusedVariant(activeTaskId, null);
      return;
    }
    setFocusedVariant(activeTaskId, {
      scopeId: focusedConversation.id,
      agent: focusedConversation.agent,
      streamId: getConversationStreamId(focusedConversation.id),
    });
  }, [activeTaskId, focusedConversation]);
  useEffect(() => () => {
    if (activeTaskId) setFocusedVariant(activeTaskId, null);
  }, [activeTaskId]);

  // Keep the core active-conversation flag on the conversation the user is
  // looking at. Tab selection only updates the pane layout, so without this
  // sync, clicking a non-active conversation (e.g. while another one is busy
  // streaming) left is_active on the old conversation — and every surface
  // that renders the active conversation (AgentLaneScreen lanes, task-level
  // stream routing via getTaskStreamId) stayed stuck on the busy one.
  const focusedConversationId = focusedConversation?.id ?? null;
  const activeConversationId = sessionRecord?.activeConversationId ?? null;
  useEffect(() => {
    if (!activeTaskId || !focusedConversationId) return;
    if (focusedConversationId === activeConversationId) return;
    setActiveConversation(activeTaskId, focusedConversationId).catch(() => {
      // Activation is best-effort UI/core sync; the pane already switched.
    });
  }, [activeTaskId, focusedConversationId, activeConversationId]);

  if (!activeTask) return null;
  const taskId = activeTask.id;

  const busyByConversationId: Record<string, boolean> = {};
  for (const c of conversations) {
    busyByConversationId[c.id] = c.isMain && activeTask.status === 'busy';
  }

  const resolveTab = (tab: PaneTab): TabPresentation => {
    const ref = tab.ref;
    switch (ref.kind) {
      case 'conversation': {
        const conv = conversations.find((c) => c.id === ref.conversationId);
        if (!conv) {
          return { icon: <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />, label: 'Chat gone' };
        }
        return {
          icon: <AgentLogo agent={conv.agent} className="h-3.5 w-3.5" />,
          label: conv.title || 'Chat',
          accent: getAgentAccentColor(conv.agent),
          isBusy: busyByConversationId[conv.id] === true,
        };
      }
      case 'file': {
        const filename = ref.path.split('/').pop() ?? ref.path;
        return {
          icon: <FileIcon path={filename} className="h-3.5 w-3.5" />,
          label: filename,
          title: ref.path,
          isDirty: editorState.dirty.has(ref.path),
        };
      }
      case 'promptMarkdown': {
        const filename = ref.path.split('/').pop() ?? ref.path;
        return {
          icon: <FileIcon path={filename} className="h-3.5 w-3.5" />,
          label: filename,
          title: ref.path,
        };
      }
      case 'terminal':
        return { icon: <TerminalSquare className="h-3.5 w-3.5" />, label: 'Terminal' };
      case 'scratch': {
        const meta = scratchState.tabs.find((t) => t.id === ref.tabId);
        if (!meta) return { icon: <Globe className="h-3.5 w-3.5" />, label: 'Tab gone' };
        const Icon = meta.kind === 'browser' ? Globe : StickyNote;
        const label = meta.title?.trim() || (meta.kind === 'browser' ? 'New tab' : 'Untitled');
        const icon = meta.kind === 'browser' && meta.loading
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <TabIcon tab={meta} fallback={Icon} isActive />;
        return { icon, label, isDirty: meta.kind === 'notes' && meta.dirty };
      }
      case 'variant':
        return { icon: <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />, label: 'Variant' };
      // Spec sidecar tabs are a worker-task (ParallelTaskScreen) concept;
      // sessions never add them, this arm only keeps the switch exhaustive.
      case 'spec':
        return { icon: <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />, label: 'Spec' };
    }
  };

  const renderTab = (ref: TabRef) => {
    switch (ref.kind) {
      case 'conversation': {
        const conv = conversations.find((c) => c.id === ref.conversationId);
        if (!conv) return <PaneEmpty message="Chat is gone." />;
        return <ConversationPane conversation={conv} taskId={taskId} fallbackStreamId={fallbackStreamId} />;
      }
      case 'file':
        return <EditorPane taskId={taskId} path={ref.path} />;
      case 'promptMarkdown':
        return <PaneEmpty message="Prompt Markdown tabs not used here." />;
      case 'terminal':
        return <TerminalPanel workItemId={taskId} />;
      case 'scratch': {
        const meta = scratchState.tabs.find((t) => t.id === ref.tabId);
        if (!meta) return <PaneEmpty message="Tab is gone." />;
        if (meta.kind === 'browser') return <BrowserPane taskId={taskId} tabId={meta.id} />;
        return <NotesPane taskId={taskId} tabId={meta.id} />;
      }
      case 'variant':
        return <PaneEmpty message="Variants not used here." />;
      case 'spec':
        return <PaneEmpty message="Spec tabs not used here." />;
    }
  };

  const closeAllChats = () => {
    for (const c of conversations) void closeConversation(taskId, c.id);
  };
  const closeAllFiles = () => {
    for (const f of editorState.openFiles) closeFile(taskId, f.path);
  };
  const closeAllBrowsers = () => {
    for (const s of scratchState.tabs) {
      if (s.kind === 'browser') closeScratchTab(taskId, s.id);
    }
  };

  const browserCount = scratchState.tabs.filter((t) => t.kind === 'browser').length;

  const resolveTabContextMenu = (tab: PaneTab, paneId: string): ContextMenuItem[] => [
    { kind: 'item', label: 'Close', onSelect: () => closeTabRef(paneId, tab.id) },
    { kind: 'separator' },
    {
      kind: 'item',
      label: `Close all agents${conversations.length ? ` (${conversations.length})` : ''}`,
      onSelect: closeAllChats,
      disabled: conversations.length === 0,
    },
    {
      kind: 'item',
      label: `Close all files${editorState.openFiles.length ? ` (${editorState.openFiles.length})` : ''}`,
      onSelect: closeAllFiles,
      disabled: editorState.openFiles.length === 0,
    },
    {
      kind: 'item',
      label: `Close all browsers${browserCount ? ` (${browserCount})` : ''}`,
      onSelect: closeAllBrowsers,
      disabled: browserCount === 0,
    },
  ];

  const closeTabRef = (paneId: string, tabId: string) => {
    const pane = layout.columns.flatMap((c) => c.panes).find((p) => p.id === paneId);
    const tab = pane?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    switch (tab.ref.kind) {
      case 'conversation':
        void closeConversation(taskId, tab.ref.conversationId);
        break;
      case 'file':
        closeFile(taskId, tab.ref.path);
        break;
      case 'promptMarkdown':
        break;
      case 'terminal':
        closeTerminal(taskId);
        break;
      case 'scratch':
        closeScratchTab(taskId, tab.ref.tabId);
        break;
      case 'variant':
      case 'spec':
        break;
    }
    closeTab(taskId, paneId, tabId);
  };

  const trailingNode = <TaskLinkBadges context={activeTask.context} />;

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: getTerminalBackground() }}>
      {isAgentInstalled === false && (
        <div className="border-b border-border/30 px-3 py-1">
          <AgentRuntimeBanner agent={agent} mode="missing" />
        </div>
      )}
      {cliStartError && (
        <div className="border-b border-border/30 px-3 py-1">
          <AgentRuntimeBanner agent={agent} mode="start_failed" details={cliStartError} />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="relative min-h-0 flex-1">
          {(() => {
            const pickerNode = (
              <NewItemPicker
                agentTitle="New chat"
                agentDescription="Pick an agent for a new chat tab"
                scope={
                  activeWorkspace?.isRemote
                    ? {
                        sshHost: activeWorkspace.sshHost,
                        agentUser: activeWorkspace.agentUser,
                      }
                    : undefined
                }
                autoApproveEnabled={!!activeTask.autoApproveEnabled}
                onAutoApproveChange={async (next) => {
                  await aceApi.workspaces.setTaskAutoApprove(taskId, next);
                }}
                onSelectAgent={async (picked) => {
                  const result = await createConversation(taskId, picked.id);
                  setAddingAgent(false);
                  if (result?.id) {
                    openRef(taskId, { kind: 'conversation', conversationId: result.id });
                  }
                }}
                onSelectBrowser={() => {
                  const tabId = openBrowserTab(taskId);
                  setAddingAgent(false);
                  openRef(taskId, { kind: 'scratch', tabId });
                }}
                onSelectNotes={() => {
                  const tabId = openNotesTab(taskId);
                  setAddingAgent(false);
                  openRef(taskId, { kind: 'scratch', tabId });
                }}
              />
            );
            const showPicker = addingAgent || layout.columns.length === 0;
            if (isMobile) {
              if (showPicker) return pickerNode;
              if (focusedTab) {
                return (
                  <div className="h-full w-full">
                    {renderTab(focusedTab.ref)}
                  </div>
                );
              }
              return (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <p className="text-xs text-muted-foreground/70">No tab open.</p>
                </div>
              );
            }
            if (showPicker) {
              return <PickerLayout trailing={trailingNode}>{pickerNode}</PickerLayout>;
            }
            return (
              <PaneGrid
                layout={layout}
                renderTab={renderTab}
                resolveTab={resolveTab}
                onSelectTab={(paneId, tabId) => selectTab(taskId, paneId, tabId)}
                onCloseTab={closeTabRef}
                onFocusPane={(paneId) => focusPaneFn(taskId, paneId)}
                onSplitColumn={(payload, side) => splitColumn(taskId, payload, side)}
                onSplitRow={(payload, targetPaneId, side) => splitRow(taskId, payload, targetPaneId, side)}
                onMoveTab={(payload, targetPaneId) => moveTabToPane(taskId, payload, targetPaneId)}
                onAddTab={(paneId) => {
                  focusPaneFn(taskId, paneId);
                  setAddingAgent(true);
                }}
                resolveTabContextMenu={resolveTabContextMenu}
                firstPaneTrailing={trailingNode}
              />
            );
          })()}
        </div>
        {termOpen && termMode === 'bottom' && (
          <TerminalBottomDrawer workItemId={taskId} />
        )}
      </div>
    </div>
  );
}

function PaneEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-xs text-muted-foreground/70">{message}</p>
    </div>
  );
}

function PickerLayout({
  trailing,
  children,
}: {
  trailing: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border/30">
        <div className="flex-1" />
        {trailing && (
          <div className="flex shrink-0 items-center gap-1 border-l border-border/30 px-1.5">
            {trailing}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
