import { useEffect, useMemo, useState } from 'react';
import { haptic } from '../runtime/haptics';
import { Command, CornerDownLeft, Globe, ScrollText, StickyNote, TerminalSquare, Loader2 } from 'lucide-react';
import { setActiveDisplayAgent } from '../runtime/active-agent-registry';
import { setFocusedVariant } from '../runtime/focused-variant-registry';
import { aceApi } from '../lib/ace-api';
import { getAgentAccentColor, getTerminalBackground } from '../lib/agent-style';
import AgentLogo from './ProviderGlyph';
import { FileIcon } from './FileIcon';
import WorktreeSelector from './multi-agent/WorktreeSelector';
import { cn } from '../lib/utils';
import PaneGrid from './multi-agent/PaneGrid';
import { TabIcon } from './multi-agent/TabIcon';
import { VariantChatPane } from './multi-agent/VariantChatPane';
import { ConversationPane } from './ConversationPane';
import { TerminalFeed } from './TerminalFeed';
import BroadcastPanel from './multi-agent/BroadcastPanel';
import CreateWorktreeDialog from './multi-agent/CreateWorktreeDialog';
import { AgentRuntimeBanner } from './AgentRuntimeBanner';
import { TaskLinkBadges } from './TaskLinkBadges';
import { TaskSpecPane } from './TaskSpecPane';
import { EditorPane } from './EditorPane';
import { TerminalPanel } from './TerminalPanel';
import { TerminalBottomDrawer } from './TerminalBottomDrawer';
import { NewItemPicker } from './NewItemPicker';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useNewTabHandler } from '../runtime/mobile-new-tab-bus';
import { useIsMobileViewport } from '../runtime/use-mobile-viewport';
import { useSwipe } from '../runtime/use-swipe';
import { GestureDots } from './ui/mobile';
import { BrowserPane } from './BrowserPane';
import { NotesPane } from './NotesPane';
import { PromptMarkdownSourcePane, SpecSidecarPane } from './multi-agent/SpecSidecarPane';
import {
  fetchTaskSpec,
  getPromptMarkdownSources,
  hasSpecSidecarContent,
  useTaskSpec,
} from './multi-agent/spec-sidecar';
import {
  closeScratchTab,
  hydrateScratchTabs,
  openBrowserTab,
  openNotesTab,
  useScratchTabs,
} from '../runtime/scratch-tabs-registry';
import type { Task, Variant, AgentId, WorktreeGroup } from '../lib/types';
import { useApp } from '../store';
import {
  attachTaskVariant,
  broadcastTaskCommand,
  createTaskWorktree,
  deleteTaskWorktree,
  removeTaskVariant,
} from '../runtime/workspace-registry';
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
import {
  getConversationStreamId,
  getVariantStreamId,
} from '../runtime/terminal-registry';
import { isAceChatAgent } from '../runtime/ace-chat-mode-registry';
import { useTaskSessions } from '../runtime/session-registry';
import type { TabPresentation } from './multi-agent/PaneTabStrip';
import type { ContextMenuItem } from './FileContextMenu';

interface ParallelTaskScreenProps {
  task: Task;
}

export function ParallelTaskScreen({ task }: ParallelTaskScreenProps) {
  const { activeWorkspace } = useApp();

  const worktreeGroups: WorktreeGroup[] = useMemo(() => task.worktrees ?? [], [task.worktrees]);
  const [activeWorktreeId, setActiveWorktreeId] = useState(worktreeGroups[0]?.worktreeId ?? '');
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  useMobileBackHandler(addingAgent, () => setAddingAgent(false));
  useNewTabHandler(() => setAddingAgent(true));
  const isMobile = useIsMobileViewport();
  const [addWorktreeOpen, setAddWorktreeOpen] = useState(false);
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<string[]>([]);
  const editorState = useEditorState(task.id);
  const { open: termOpen, mode: termMode } = useTerminalState(task.id);
  const scratchState = useScratchTabs(task.id);
  const [hydratedTaskId, setHydratedTaskId] = useState<string | null>(null);
  const hydrated = hydratedTaskId === task.id;

  useEffect(() => {
    let cancelled = false;
    // fetchTaskSpec joins the hydration barrier so a persisted spec tab is
    // not pruned (and re-appended elsewhere) before the spec has resolved.
    void Promise.all([
      hydrateScratchTabs(task.id),
      hydrateEditorOpenFiles(task.id),
      fetchTaskSpec(task.id).catch(() => undefined),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHydratedTaskId(task.id);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const resolvedWorktreeId =
    worktreeGroups.some((group) => group.worktreeId === activeWorktreeId)
      ? activeWorktreeId
      : worktreeGroups[0]?.worktreeId ?? '';
  const activeWorktree = useMemo(
    () => worktreeGroups.find((g) => g.worktreeId === resolvedWorktreeId) ?? worktreeGroups[0],
    [worktreeGroups, resolvedWorktreeId]
  );
  const variants = useMemo(() => activeWorktree?.variants ?? [], [activeWorktree]);
  const allVariants = useMemo(() => worktreeGroups.flatMap((g) => g.variants), [worktreeGroups]);
  const sessionRecord = useTaskSessions(task.id);
  const conversations = useMemo(
    () => sessionRecord?.conversations ?? [],
    [sessionRecord?.conversations]
  );

  // Prompt-referenced Markdown files get filename tabs beside the worker tab.
  // The generic spec/rubric tab is manual-only; the pinned TaskSpecPane remains
  // the default spec inspection surface.
  const taskSpec = useTaskSpec(task.id);
  const promptMarkdownSources = useMemo(() => getPromptMarkdownSources(taskSpec), [taskSpec]);
  const specAvailable = hasSpecSidecarContent(taskSpec);

  // Build the set of refs that should be present in the layout. Order matters
  // for newly-added ones — they'll be appended to the focused pane in this
  // order on first sight. Prompt source refs sit right after variants so a
  // fresh worker task opens as worker tab + adjacent source docs.
  const availableRefs = useMemo<TabRef[]>(() => {
    const refs: TabRef[] = [];
    for (const v of variants) refs.push({ kind: 'variant', variantId: v.id });
    for (const source of promptMarkdownSources) refs.push({ kind: 'promptMarkdown', path: source.path });
    for (const c of conversations) refs.push({ kind: 'conversation', conversationId: c.id });
    for (const f of editorState.openFiles) refs.push({ kind: 'file', path: f.path });
    if (termOpen && termMode === 'tab') refs.push({ kind: 'terminal' });
    for (const s of scratchState.tabs) refs.push({ kind: 'scratch', tabId: s.id });
    return refs;
  }, [variants, promptMarkdownSources, conversations, editorState.openFiles, termOpen, termMode, scratchState.tabs]);

  useEffect(() => {
    syncAvailableTabs(task.id, availableRefs, {
      prune: hydrated,
      preserveRefs: specAvailable ? [{ kind: 'spec' }] : [],
    });
  }, [task.id, availableRefs, hydrated, specAvailable]);

  const layout = usePaneLayout(task.id);

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

  // Mobile task-tab paging: a full-width horizontal swipe steps the focused
  // pane's tabs (clamped, no wrap). isSwipeBlocked still yields to the terminal /
  // Monaco / webview body and to the scrollable tab strip, so paging only takes
  // over where nothing else wants the gesture.
  const taskTabCount = focusedPane?.tabs.length ?? 0;
  const taskTabIndex = focusedPane
    ? focusedPane.tabs.findIndex((t) => t.id === focusedPane.activeTabId)
    : -1;
  const stepFocusedTab = (dir: -1 | 1) => {
    if (!focusedPane) return;
    const next = focusedPane.tabs[taskTabIndex + dir];
    if (next) {
      haptic('tick');
      selectTab(task.id, focusedPane.id, next.id); // clamp at the ends, no wrap
    }
  };
  const taskTabSwipeRef = useSwipe<HTMLDivElement>({
    enabled: isMobile && taskTabCount > 1,
    onSwipeLeft: () => stepFocusedTab(1), // finger left → next tab
    onSwipeRight: () => stepFocusedTab(-1), // finger right → previous tab
  });

  const focusedVariant: Variant | null = useMemo(() => {
    if (focusedRef?.kind !== 'variant') return null;
    return allVariants.find((v) => v.id === focusedRef.variantId) ?? null;
  }, [focusedRef, allVariants]);

  const focusedConversation = useMemo(() => {
    if (focusedRef?.kind !== 'conversation') return null;
    return conversations.find((c) => c.id === focusedRef.conversationId) ?? null;
  }, [focusedRef, conversations]);

  const focusedChat = useMemo(() => {
    if (focusedVariant) {
      const streamId = getVariantStreamId(focusedVariant.id);
      return {
        scopeId: streamId,
        agent: focusedVariant.agent,
        streamId,
      };
    }
    if (focusedConversation) {
      return {
        scopeId: focusedConversation.id,
        agent: focusedConversation.agent,
        streamId: getConversationStreamId(focusedConversation.id),
      };
    }
    return null;
  }, [focusedConversation, focusedVariant]);

  useEffect(() => {
    if (focusedChat) setActiveDisplayAgent(task.id, focusedChat.agent);
  }, [task.id, focusedChat]);

  useEffect(() => {
    setFocusedVariant(task.id, focusedChat);
  }, [task.id, focusedChat]);
  useEffect(() => () => setFocusedVariant(task.id, null), [task.id]);

  const toggleWorktreeSelection = (id: string) => {
    setSelectedWorktreeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  async function confirmDeleteWorktrees(names: string[]): Promise<
    { deleteRemote: boolean } | null
  > {
    const count = names.length;
    if (count === 0) return null;
    const subject =
      count === 1 ? `worktree "${names[0]}"` : `${count} worktrees`;
    const ok = window.confirm(
      `Delete ${subject}?\n\nThis removes the worktree${count === 1 ? '' : 's'} and local branch${count === 1 ? '' : 'es'}.`
    );
    if (!ok) return null;
    const deleteRemote = window.confirm(
      `Also delete the remote branch${count === 1 ? '' : 'es'} on origin?`
    );
    return { deleteRemote };
  }

  const resolveTab = (tab: PaneTab): TabPresentation => {
    const ref = tab.ref;
    switch (ref.kind) {
      case 'variant': {
        const variant = allVariants.find((v) => v.id === ref.variantId);
        if (!variant) {
          return { icon: <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />, label: 'Agent gone' };
        }
        return {
          icon: <AgentLogo agent={variant.agent} className="h-3.5 w-3.5" />,
          label: variant.name,
          accent: getAgentAccentColor(variant.agent),
          isBusy: variant.busy,
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
        const source = promptMarkdownSources.find((item) => item.path === ref.path);
        const filename = source?.name ?? ref.path.split('/').pop() ?? ref.path;
        return {
          icon: <FileIcon path={filename} className="h-3.5 w-3.5" />,
          label: filename,
          title: ref.path,
        };
      }
      case 'terminal':
        return { icon: <TerminalSquare className="h-3.5 w-3.5" />, label: 'Terminal' };
      case 'spec':
        return {
          icon: <ScrollText className="h-3.5 w-3.5" />,
          label: 'Spec',
          title: 'Task spec & rubric',
        };
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
      case 'conversation': {
        const conv = conversations.find((c) => c.id === ref.conversationId);
        if (!conv) {
          return { icon: <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />, label: 'Chat gone' };
        }
        return {
          icon: <AgentLogo agent={conv.agent} className="h-3.5 w-3.5" />,
          label: conv.title || 'Chat',
          accent: getAgentAccentColor(conv.agent),
          isBusy: conv.isMain && task.status === 'busy',
        };
      }
    }
  };

  const renderTab = (ref: TabRef, _paneId: string, isFocused: boolean) => {
    switch (ref.kind) {
      case 'variant': {
        const variant = allVariants.find((v) => v.id === ref.variantId);
        if (!variant) return <PaneEmpty message="This agent is gone." />;
        return <VariantPaneBody variant={variant} taskId={task.id} interactive={isFocused} />;
      }
      case 'file':
        return <EditorPane taskId={task.id} path={ref.path} />;
      case 'promptMarkdown':
        return <PromptMarkdownSourcePane taskId={task.id} path={ref.path} />;
      case 'terminal':
        return <TerminalPanel workItemId={task.id} />;
      case 'spec':
        return <SpecSidecarPane taskId={task.id} />;
      case 'scratch': {
        const meta = scratchState.tabs.find((t) => t.id === ref.tabId);
        if (!meta) return <PaneEmpty message="Tab is gone." />;
        if (meta.kind === 'browser') return <BrowserPane taskId={task.id} tabId={meta.id} />;
        return <NotesPane taskId={task.id} tabId={meta.id} />;
      }
      case 'conversation': {
        const conv = conversations.find((c) => c.id === ref.conversationId);
        if (!conv) return <PaneEmpty message="Chat is gone." />;
        return <ConversationPane conversation={conv} taskId={task.id} />;
      }
    }
  };

  const closeAllVariants = () => {
    for (const v of allVariants) void removeTaskVariant(v.id);
  };
  const closeAllFiles = () => {
    for (const f of editorState.openFiles) closeFile(task.id, f.path);
  };
  const closeAllBrowsers = () => {
    for (const s of scratchState.tabs) {
      if (s.kind === 'browser') closeScratchTab(task.id, s.id);
    }
  };

  const browserCount = scratchState.tabs.filter((t) => t.kind === 'browser').length;

  const resolveTabContextMenu = (tab: PaneTab, paneId: string): ContextMenuItem[] => [
    { kind: 'item', label: 'Close', onSelect: () => closeTabRef(paneId, tab.id) },
    { kind: 'separator' },
    {
      kind: 'item',
      label: `Close all agents${allVariants.length ? ` (${allVariants.length})` : ''}`,
      onSelect: closeAllVariants,
      disabled: allVariants.length === 0,
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
    // Closing the tab also closes the underlying resource so it disappears
    // from the global list. The next sync will reconcile.
    switch (tab.ref.kind) {
      case 'variant':
        void removeTaskVariant(tab.ref.variantId);
        break;
      case 'file':
        closeFile(task.id, tab.ref.path);
        break;
      case 'promptMarkdown':
        break;
      case 'terminal':
        closeTerminal(task.id);
        break;
      case 'spec':
        break;
      case 'scratch':
        closeScratchTab(task.id, tab.ref.tabId);
        break;
      case 'conversation':
        break;
    }
    closeTab(task.id, paneId, tabId);
  };

  const handleDeleteWorktree = async (worktreeId: string) => {
    const wt = worktreeGroups.find((g) => g.worktreeId === worktreeId);
    const confirmed = await confirmDeleteWorktrees([wt?.displayName ?? 'worktree']);
    if (!confirmed) return;
    try {
      await deleteTaskWorktree(worktreeId, {
        deleteLocalBranch: true,
        deleteRemoteBranch: confirmed.deleteRemote,
      });
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setSelectedWorktreeIds((current) => current.filter((id) => id !== worktreeId));
  };

  const handleDeleteSelectedWorktrees = async () => {
    const targetIds = [...selectedWorktreeIds];
    if (targetIds.length === 0) return;
    const names = targetIds.map(
      (id) => worktreeGroups.find((g) => g.worktreeId === id)?.displayName ?? 'worktree'
    );
    const confirmed = await confirmDeleteWorktrees(names);
    if (!confirmed) return;
    try {
      await Promise.all(
        targetIds.map((worktreeId) =>
          deleteTaskWorktree(worktreeId, {
            deleteLocalBranch: true,
            deleteRemoteBranch: confirmed.deleteRemote,
          })
        )
      );
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setSelectedWorktreeIds([]);
  };

  const leadingNode = worktreeGroups.length > 0 ? (
    <WorktreeSelector
      worktreeGroups={worktreeGroups}
      activeWorktreeId={resolvedWorktreeId}
      onWorktreeSelect={(id) => setActiveWorktreeId(id)}
      onAddWorktree={() => setAddWorktreeOpen(true)}
      onDeleteWorktree={handleDeleteWorktree}
      selectedWorktreeIds={selectedWorktreeIds}
      onToggleWorktreeSelection={toggleWorktreeSelection}
      onSelectAllDeletableWorktrees={() => {
        setSelectedWorktreeIds(
          worktreeGroups.filter((g) => g.worktreeId !== activeWorktreeId).map((g) => g.worktreeId)
        );
      }}
      onDeleteSelectedWorktrees={handleDeleteSelectedWorktrees}
      onClearWorktreeSelection={() => setSelectedWorktreeIds([])}
    />
  ) : null;

  const trailingNode = (
    <>
      <TaskLinkBadges context={task.context} />
      <button
        type="button"
        onClick={() => setCommandBarOpen(true)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground'
        )}
        title="Broadcast to all agents (⌘↵)"
      >
        <Command className="h-3 w-3" />
        <CornerDownLeft className="h-3 w-3" />
      </button>
    </>
  );

  return (
    <div className="relative flex h-full flex-col" style={{ backgroundColor: getTerminalBackground() }}>
      <TaskSpecPane
        taskId={task.id}
        onOpenSpecTab={
          specAvailable
            ? () => {
                openRef(task.id, { kind: 'spec' });
              }
            : undefined
        }
      />
      {task.agentInstalled === false && focusedVariant && (
        <div className="border-b border-border/30 px-3 py-1">
          <AgentRuntimeBanner agent={focusedVariant.agent} mode="missing" />
        </div>
      )}

      {task.installError && focusedVariant && (
        <div className="border-b border-border/30 px-3 py-1">
          <AgentRuntimeBanner
            agent={focusedVariant.agent}
            mode="start_failed"
            details={task.installError}
          />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          {(() => {
            const pickerNode = (
              <NewItemPicker
                agentTitle="Add an agent"
                agentDescription={`Pick an agent to add to ${activeWorktree?.displayName ?? 'this worktree'}`}
                scope={
                  activeWorkspace?.isRemote
                    ? {
                        sshHost: activeWorkspace.sshHost,
                        agentUser: activeWorkspace.agentUser,
                      }
                    : undefined
                }
                autoApproveEnabled={!!task.autoApproveEnabled}
                onAutoApproveChange={async (next) => {
                  await aceApi.workspaces.setTaskAutoApprove(task.id, next);
                }}
                onSelectAgent={async (agent) => {
                  if (!activeWorktree) return;
                  const { variantId } = await attachTaskVariant(task.id, {
                    worktreeId: activeWorktree.worktreeId,
                    agent: agent.id as AgentId,
                    reviewMode: false,
                  });
                  setAddingAgent(false);
                  if (variantId) openRef(task.id, { kind: 'variant', variantId });
                }}
                onSelectBrowser={() => {
                  const tabId = openBrowserTab(task.id);
                  setAddingAgent(false);
                  openRef(task.id, { kind: 'scratch', tabId });
                }}
                onSelectNotes={() => {
                  const tabId = openNotesTab(task.id);
                  setAddingAgent(false);
                  openRef(task.id, { kind: 'scratch', tabId });
                }}
              />
            );
            const showPicker = addingAgent || layout.columns.length === 0;
            if (isMobile) {
              // Mobile: no pane chrome. Tab-management happens on the tab
              // switcher page. We just render the focused tab's body full
              // height below the shell's back-button header.
              if (showPicker) return pickerNode;
              if (focusedTab) {
                return (
                  <div ref={taskTabSwipeRef} className="flex h-full w-full flex-col">
                    <div className="min-h-0 flex-1">
                      {renderTab(focusedTab.ref, focusedPane!.id, true)}
                    </div>
                    {/* In-task tab position rail — slides with the swipe so the
                        gesture and the indicator always agree. */}
                    <GestureDots
                      count={taskTabCount}
                      index={taskTabIndex}
                      layoutId="m-task-tabs"
                      className="shrink-0"
                    />
                  </div>
                );
              }
              return <PaneEmpty message="No tab open." />;
            }
            if (showPicker) {
              return (
                <PickerLayout leading={leadingNode} trailing={trailingNode}>
                  {pickerNode}
                </PickerLayout>
              );
            }
            return (
              <PaneGrid
                layout={layout}
                renderTab={renderTab}
                resolveTab={resolveTab}
                onSelectTab={(paneId, tabId) => selectTab(task.id, paneId, tabId)}
                onCloseTab={closeTabRef}
                onFocusPane={(paneId) => focusPaneFn(task.id, paneId)}
                onSplitColumn={(payload, side) => splitColumn(task.id, payload, side)}
                onSplitRow={(payload, targetPaneId, side) => splitRow(task.id, payload, targetPaneId, side)}
                onMoveTab={(payload, targetPaneId) => moveTabToPane(task.id, payload, targetPaneId)}
                onAddTab={(paneId) => {
                  focusPaneFn(task.id, paneId);
                  setAddingAgent(true);
                }}
                resolveTabContextMenu={resolveTabContextMenu}
                firstPaneLeading={leadingNode}
                firstPaneTrailing={trailingNode}
              />
            );
          })()}
        </div>
        {termOpen && termMode === 'bottom' && (
          <TerminalBottomDrawer workItemId={task.id} />
        )}
      </div>

      <BroadcastPanel
        isOpen={commandBarOpen}
        onClose={() => setCommandBarOpen(false)}
        onSubmit={(message, targetIds) => {
          void broadcastTaskCommand(task.id, targetIds, message);
        }}
        variants={allVariants}
      />

      <CreateWorktreeDialog
        isOpen={addWorktreeOpen}
        onClose={() => setAddWorktreeOpen(false)}
        onAdd={async (data) => {
          const result = await createTaskWorktree(task.id, {
            name: data.name,
            agent: data.agent as Task['agent'],
            branch: data.branch,
            reviewMode: data.reviewMode,
          });
          if (result.worktreeId) {
            setActiveWorktreeId(result.worktreeId);
          }
        }}
        defaultBranch={activeWorkspace?.defaultBranch ?? 'main'}
        existingNames={worktreeGroups.map((g) => g.displayName)}
      />
    </div>
  );
}

function VariantPaneBody({
  variant,
  taskId,
  interactive,
}: {
  variant: Variant;
  taskId: string;
  interactive: boolean;
}) {
  const streamId = getVariantStreamId(variant.id);
  if (isAceChatAgent(variant.agent)) {
    return <VariantChatPane variant={variant} streamId={streamId} taskId={taskId} />;
  }
  return <TerminalFeed streamId={streamId} interactive={interactive} />;
}

function PaneEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-xs text-muted-foreground/70">{message}</p>
    </div>
  );
}

// Wraps a NewItemPicker so the worktree dropdown + broadcast button still
// sit in the slim bar above. Used both when the user explicitly hits + and
// when the layout has no panes left.
function PickerLayout({
  leading,
  trailing,
  children,
}: {
  leading: React.ReactNode;
  trailing: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border/30">
        {leading && (
          <div className="flex shrink-0 items-center gap-1 border-r border-border/30 pl-1.5 pr-2">
            {leading}
          </div>
        )}
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
