import { useCallback, useState } from 'react';
import {
  Home,
  FolderOpen, FolderClosed, FolderSymlink,
  Plus, ChevronRight, ChevronsUp,
  FolderPlus,
  Archive, RotateCcw, Trash2,
  GitBranch, LayoutGrid, MessageSquare, Pin,
  MoreHorizontal, Repeat,
} from 'lucide-react';
import { WorkspaceMenu } from './WorkspaceMenu';
import { cn, formatRelativeTime } from '../lib/utils';
import { Spinner } from './ui/spinner';
import { PrBadge } from './ui/badge';
import { useApp } from '../store';

import type { Task } from '../lib/types';
import {
  archiveWorkspaceTask,
  deleteWorkspaceTask,
  unarchiveWorkspaceTask,
  useWorkspaceCatalog,
  reorderWorkspaceList,
  reorderTasksInWorkspaceList,
} from '../runtime/workspace-registry';
import { markTaskRead, useTaskActivity } from '../runtime/task-activity-registry';
import { DeleteTaskDialog, type DeleteTaskOptions } from './DeleteTaskDialog';

const ROW_BASE =
  'group flex w-full min-w-0 items-center gap-2 rounded-md px-2 h-7 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

// The loop workspace materializes at <root>/workspaces/loops (the path suffix is
// the durable, root-agnostic marker — the root is the SSD when active, else
// userData, so we never hardcode a volume). Anything ending in /workspaces/loops
// is a System-group workspace.
function isLoopWorkspace(workspacePath: string | null | undefined): boolean {
  if (!workspacePath) return false;
  const normalized = workspacePath.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  return normalized.endsWith('/workspaces/loops') || normalized === 'workspaces/loops';
}

export function WorkspaceRail() {
  const {
    view, setView,
    activeWorkspaceId, activeTaskId,
    openWorkspace, openTask, toggleLaneDeck,
  } = useApp();
  const allWorkspaces = useWorkspaceCatalog();

  // System group (PRD §10 / GRILLED DESIGN #4): the loop workspace materializes
  // at <root>/workspaces/loops and is rendered in its OWN 'System' group so it
  // never mixes with dev workspaces. It is a builtin maintenance surface, so it
  // stays OUT of the drag-reorder list (which keys off this array's order).
  const systemWorkspaces = allWorkspaces.filter((w) => isLoopWorkspace(w.path));
  const workspaces = allWorkspaces.filter((w) => !isLoopWorkspace(w.path));

  const [workspaceOpenMap, setWorkspaceOpenMap] = useState<Record<string, boolean>>(
    Object.fromEntries(allWorkspaces.map((workspace) => [workspace.id, true]))
  );
  const [showArchivedFor, setShowArchivedFor] = useState<Set<string>>(new Set());
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);

  type DragSource =
    | { kind: 'workspace'; id: string }
    | { kind: 'task'; id: string; workspaceId: string };
  type DropTarget =
    | { kind: 'workspace'; index: number }
    | { kind: 'task'; workspaceId: string; index: number };

  const [drag, setDrag] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const computeIndex = useCallback((event: React.DragEvent, baseIndex: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    return event.clientY < midpoint ? baseIndex : baseIndex + 1;
  }, []);

  const setDropTargetIfChanged = useCallback((next: DropTarget) => {
    setDropTarget((prev) => {
      if (
        prev &&
        prev.kind === next.kind &&
        prev.index === next.index &&
        (prev.kind !== 'task' || prev.workspaceId === (next as { workspaceId?: string }).workspaceId)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const reorderArray = (ids: string[], from: number, to: number) => {
    const next = ids.slice();
    const [moved] = next.splice(from, 1);
    const adjusted = to > from ? to - 1 : to;
    next.splice(adjusted, 0, moved);
    return next;
  };

  const handleDropOnWorkspaces = useCallback(
    (event: React.DragEvent, targetIndex: number) => {
      event.preventDefault();
      if (!drag || drag.kind !== 'workspace') return;
      const ids = workspaces.map((workspace) => workspace.id);
      const fromIndex = ids.indexOf(drag.id);
      if (fromIndex < 0) return;
      const next = reorderArray(ids, fromIndex, targetIndex);
      if (next.join('|') === ids.join('|')) {
        setDrag(null);
        setDropTarget(null);
        return;
      }
      void reorderWorkspaceList(next).catch((err) => {
        window.alert(`Reorder failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      });
      setDrag(null);
      setDropTarget(null);
    },
    [drag, setDrag, setDropTarget, workspaces]
  );

  const handleDropOnTasks = useCallback(
    (event: React.DragEvent, workspaceId: string, taskIds: string[], targetIndex: number) => {
      event.preventDefault();
      if (!drag || drag.kind !== 'task' || drag.workspaceId !== workspaceId) return;
      const fromIndex = taskIds.indexOf(drag.id);
      if (fromIndex < 0) return;
      const next = reorderArray(taskIds, fromIndex, targetIndex);
      if (next.join('|') === taskIds.join('|')) {
        setDrag(null);
        setDropTarget(null);
        return;
      }
      void reorderTasksInWorkspaceList(workspaceId, next).catch((err) => {
        window.alert(`Reorder failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      });
      setDrag(null);
      setDropTarget(null);
    },
    [drag, setDrag, setDropTarget]
  );

  const clearDrag = useCallback(() => {
    setDrag(null);
    setDropTarget(null);
  }, [setDrag, setDropTarget]);

  const handleArchive = async (task: Task) => {
    try {
      await archiveWorkspaceTask(task.id);
    } catch (err) {
      window.alert(
        `Archive failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  };

  const handleUnarchive = async (task: Task) => {
    try {
      await unarchiveWorkspaceTask(task.id);
    } catch (err) {
      window.alert(
        `Unarchive failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  };

  const handleDeleteRequest = async (task: Task) => {
    if (task.type === 'thread') {
      try {
        await deleteWorkspaceTask(task.id, {
          deleteLocalBranch: false,
          deleteRemoteBranch: false,
          removeWorktree: false,
        });
      } catch (err) {
        window.alert(
          `Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`
        );
      }
      return;
    }
    setDeletingTask(task);
  };

  const confirmDelete = async (options: DeleteTaskOptions) => {
    if (!deletingTask) return;
    await deleteWorkspaceTask(deletingTask.id, options);
    setDeletingTask(null);
  };

  const collapseAll = () => {
    setWorkspaceOpenMap(Object.fromEntries(workspaces.map((workspace) => [workspace.id, false])));
  };

  const toggleWorkspace = (id: string) => {
    setWorkspaceOpenMap((prev) => ({ ...prev, [id]: prev[id] === false }));
  };

  const toggleArchived = (id: string) => {
    setShowArchivedFor((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-2">
        {/* System group — builtin maintenance workspaces (the loop workspace),
            kept separate from dev workspaces and not reorderable. */}
        {systemWorkspaces.length > 0 && (
          <div className="mb-3 flex flex-col gap-0.5">
            <SectionHeader label="System" />
            {systemWorkspaces.map((workspace) => {
              const isActive =
                activeWorkspaceId === workspace.id &&
                !activeTaskId &&
                (view === 'workspace' || view === 'new-chat');
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => openWorkspace(workspace.id, 'new-chat')}
                  title="Built-in loop workspace — where system maintenance loops run"
                  className={cn(
                    ROW_BASE,
                    'text-foreground/75 hover:bg-white/[0.04] hover:text-foreground',
                    isActive && 'sidebar-active-indicator bg-white/[0.06] text-foreground'
                  )}
                >
                  <Repeat
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isActive ? 'text-sky-300/90' : 'text-sky-300/55'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{workspace.name}</span>
                </button>
              );
            })}
          </div>
        )}

        <SectionHeader
          label="Workspaces"
          actions={
            <>
              <HeaderButton
                icon={ChevronsUp}
                title="Collapse all workspaces"
                onClick={collapseAll}
              />
              <HeaderButton
                icon={FolderPlus}
                title="Add a workspace"
                onClick={() => setView('home')}
              />
            </>
          }
        />

        <div
          className="flex flex-1 flex-col gap-0.5"
          onDragOver={(e) => {
            if (drag?.kind !== 'workspace') return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTargetIfChanged({ kind: 'workspace', index: workspaces.length });
          }}
          onDrop={(e) => {
            if (drag?.kind !== 'workspace') return;
            handleDropOnWorkspaces(e, workspaces.length);
          }}
        >
          {workspaces.map((workspace, workspaceIndex) => {
            const isOpen = workspaceOpenMap[workspace.id] !== false;
            const isDeckActive = view === 'lane-deck' && activeWorkspaceId === workspace.id;
            const isWorkspaceActive =
              (activeWorkspaceId === workspace.id &&
                !activeTaskId &&
                (view === 'workspace' || view === 'new-chat')) ||
              isDeckActive;
            const taskIds = workspace.tasks.map((task) => task.id);
            const isDraggingThisWorkspace = drag?.kind === 'workspace' && drag.id === workspace.id;
            const showWorkspaceDropAbove =
              drag?.kind === 'workspace' &&
              dropTarget?.kind === 'workspace' &&
              dropTarget.index === workspaceIndex &&
              drag.id !== workspace.id;
            const showWorkspaceDropBelow =
              drag?.kind === 'workspace' &&
              dropTarget?.kind === 'workspace' &&
              dropTarget.index === workspaceIndex + 1 &&
              workspaceIndex === workspaces.length - 1 &&
              drag.id !== workspace.id;

            return (
              <div key={workspace.id} className="relative min-w-0">
                {showWorkspaceDropAbove && <DropIndicator position="top" />}
                {showWorkspaceDropBelow && <DropIndicator position="bottom" />}
                <div
                  draggable
                  onDragStart={(e) => {
                    setDrag({ kind: 'workspace', id: workspace.id });
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', workspace.id);
                  }}
                  onDragEnd={clearDrag}
                  onDragOver={(e) => {
                    if (drag?.kind !== 'workspace' || drag.id === workspace.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTargetIfChanged({
                      kind: 'workspace',
                      index: computeIndex(e, workspaceIndex),
                    });
                  }}
                  onDrop={(e) => {
                    if (drag?.kind !== 'workspace') return;
                    e.stopPropagation();
                    handleDropOnWorkspaces(e, computeIndex(e, workspaceIndex));
                  }}
                  className={cn(
                    ROW_BASE,
                    'text-foreground/75 hover:bg-white/[0.04] hover:text-foreground',
                    isWorkspaceActive && 'sidebar-active-indicator bg-white/[0.06] text-foreground',
                    isDraggingThisWorkspace && 'opacity-40'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleWorkspace(workspace.id)}
                    title={workspace.isRemote ? `Connected over SSH · ${workspace.sshHost ?? ''}` : undefined}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded outline-none"
                  >
                    {workspace.isRemote ? (
                      <FolderSymlink className="h-3.5 w-3.5 text-sky-300/70" />
                    ) : isOpen ? (
                      <FolderOpen className="h-3.5 w-3.5 text-foreground/55" />
                    ) : (
                      <FolderClosed className="h-3.5 w-3.5 text-foreground/55" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      // Name click OPENS the workspace (folder icon toggles);
                      // also expand it so the panel reflects what opened.
                      setWorkspaceOpenMap((prev) => ({ ...prev, [workspace.id]: true }));
                      openWorkspace(workspace.id, 'new-chat');
                    }}
                    className="min-w-0 flex-1 truncate bg-transparent text-left"
                  >
                    <span className="block truncate">{workspace.name}</span>
                  </button>

                  <div
                    className={cn(
                      'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 has-[[data-state=open]]:opacity-100',
                      // Keep the cluster visible while this workspace's deck is
                      // on, so the lit toggle reads as "you are here".
                      isDeckActive && 'opacity-100'
                    )}
                  >
                    <InlineIconButton
                      icon={LayoutGrid}
                      title={
                        isDeckActive
                          ? 'Exit Lane Deck'
                          : 'Lane Deck — every lane in one view'
                      }
                      active={isDeckActive}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLaneDeck(workspace.id);
                      }}
                    />
                    <WorkspaceMenu workspace={workspace} align="start">
                      <button
                        type="button"
                        onClick={(e) => e.stopPropagation()}
                        title="Workspace menu"
                        aria-label="Workspace menu"
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                      >
                        <MoreHorizontal className="h-3 w-3" />
                      </button>
                    </WorkspaceMenu>
                    <InlineIconButton
                      icon={Plus}
                      title="New chat in this workspace"
                      onClick={(e) => {
                        e.stopPropagation();
                        openWorkspace(workspace.id, 'new-chat');
                      }}
                    />
                  </div>
                </div>

                {isOpen && (
                  <div
                    className="ml-2.5 mt-0.5 flex flex-col gap-0.5 border-l border-white/[0.05] pl-2"
                    onDragOver={(e) => {
                      if (drag?.kind !== 'task' || drag.workspaceId !== workspace.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropTargetIfChanged({
                        kind: 'task',
                        workspaceId: workspace.id,
                        index: workspace.tasks.length,
                      });
                    }}
                    onDrop={(e) => {
                      if (drag?.kind !== 'task' || drag.workspaceId !== workspace.id) return;
                      handleDropOnTasks(e, workspace.id, taskIds, workspace.tasks.length);
                    }}
                  >
                    {workspace.tasks.length === 0 && (
                      <button
                        type="button"
                        onClick={() => openWorkspace(workspace.id, 'new-chat')}
                        className="rounded px-1.5 py-1 text-left text-[12px] text-foreground/35 transition-colors hover:bg-white/[0.04] hover:text-foreground/70"
                      >
                        No chats yet — start one
                      </button>
                    )}
                    {workspace.tasks.map((task, taskIndex) => {
                      const isDraggingThis = drag?.kind === 'task' && drag.id === task.id;
                      const isCrossWorkspace = drag?.kind === 'task' && drag.workspaceId !== workspace.id;
                      const showDropAbove =
                        drag?.kind === 'task' &&
                        drag.workspaceId === workspace.id &&
                        dropTarget?.kind === 'task' &&
                        dropTarget.workspaceId === workspace.id &&
                        dropTarget.index === taskIndex &&
                        drag.id !== task.id;
                      const showDropBelow =
                        drag?.kind === 'task' &&
                        drag.workspaceId === workspace.id &&
                        dropTarget?.kind === 'task' &&
                        dropTarget.workspaceId === workspace.id &&
                        dropTarget.index === taskIndex + 1 &&
                        taskIndex === workspace.tasks.length - 1 &&
                        drag.id !== task.id;
                      return (
                        <div
                          key={task.id}
                          draggable
                          onDragStart={(e) => {
                            setDrag({ kind: 'task', id: task.id, workspaceId: workspace.id });
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', task.id);
                            e.stopPropagation();
                          }}
                          onDragEnd={clearDrag}
                          onDragOver={(e) => {
                            if (
                              drag?.kind !== 'task' ||
                              drag.workspaceId !== workspace.id ||
                              drag.id === task.id
                            ) {
                              if (isCrossWorkspace) e.dataTransfer.dropEffect = 'none';
                              return;
                            }
                            e.preventDefault();
                            e.stopPropagation();
                            e.dataTransfer.dropEffect = 'move';
                            setDropTargetIfChanged({
                              kind: 'task',
                              workspaceId: workspace.id,
                              index: computeIndex(e, taskIndex),
                            });
                          }}
                          onDrop={(e) => {
                            if (drag?.kind !== 'task' || drag.workspaceId !== workspace.id) return;
                            e.stopPropagation();
                            handleDropOnTasks(e, workspace.id, taskIds, computeIndex(e, taskIndex));
                          }}
                          className={cn('relative', isDraggingThis && 'opacity-40')}
                        >
                          {showDropAbove && <DropIndicator position="top" />}
                          {showDropBelow && <DropIndicator position="bottom" />}
                          <TaskRow
                            task={task}
                            isActive={activeTaskId === task.id}
                            onSelect={() => openTask(workspace.id, task.id)}
                            onArchive={() => handleArchive(task)}
                            onDelete={() => handleDeleteRequest(task)}
                          />
                        </div>
                      );
                    })}

                    {workspace.archivedTasks.length > 0 && (
                      <div className="mt-0.5">
                        <button
                          onClick={() => toggleArchived(workspace.id)}
                          className={cn(
                            ROW_BASE,
                            'text-foreground/45 hover:bg-white/[0.03] hover:text-foreground/70'
                          )}
                        >
                          <ChevronRight
                            className={cn(
                              'h-3 w-3 shrink-0 transition-transform',
                              showArchivedFor.has(workspace.id) && 'rotate-90'
                            )}
                          />
                          <span className="truncate text-[12px]">
                            Archived ({workspace.archivedTasks.length})
                          </span>
                        </button>
                        {showArchivedFor.has(workspace.id) && (
                          <div className="ml-2 flex flex-col gap-0.5 border-l border-white/[0.05] pl-2">
                            {workspace.archivedTasks.map((archivedTask) => (
                              <div
                                key={archivedTask.id}
                                className={cn(ROW_BASE, 'text-foreground/55 hover:bg-white/[0.03]')}
                              >
                                {archivedTask.type === 'task' ? (
                                  <GitBranch className="h-3 w-3 shrink-0 text-foreground/40" />
                                ) : (
                                  <MessageSquare className="h-3 w-3 shrink-0 text-foreground/40" />
                                )}
                                <span className="min-w-0 flex-1 truncate text-[12px]">{archivedTask.name}</span>
                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                  <InlineIconButton
                                    icon={RotateCcw}
                                    title="Restore"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleUnarchive(archivedTask);
                                    }}
                                  />
                                  <InlineIconButton
                                    icon={Trash2}
                                    title={archivedTask.type === 'thread' ? 'Delete thread' : 'Delete task…'}
                                    danger
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDeleteRequest(archivedTask);
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <DeleteTaskDialog
        task={deletingTask}
        onCancel={() => setDeletingTask(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function SectionHeader({ label, actions }: { label: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-1 flex h-6 items-center justify-between px-2">
      <span className="select-none text-[10px] font-semibold uppercase tracking-wider text-foreground/35">
        {label}
      </span>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}

function HeaderButton({
  icon: Icon,
  title,
  onClick,
}: {
  icon: typeof Home;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-foreground/30 transition-colors hover:bg-white/[0.05] hover:text-foreground/80"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

function DropIndicator({ position }: { position: 'top' | 'bottom' }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-0 right-0 z-10 h-0.5 rounded-full bg-[hsl(var(--ace-accent))] shadow-[0_0_6px_hsl(var(--ace-accent)/0.7)]',
        position === 'top' ? '-top-px' : '-bottom-px'
      )}
    />
  );
}

function InlineIconButton({
  icon: Icon,
  title,
  onClick,
  danger,
  active,
}: {
  icon: typeof Home;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
        danger
          ? 'text-foreground/45 hover:bg-rose-500/10 hover:text-rose-300'
          : active
            ? 'text-[hsl(var(--ace-accent))] hover:bg-white/[0.06]'
            : 'text-foreground/45 hover:bg-white/[0.06] hover:text-foreground'
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

function TaskRow({
  task, isActive, onSelect, onArchive, onDelete,
}: {
  task: Task;
  isActive: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const compact = formatRelativeTime(task.updatedAt, true);
  const hasChanges = (task.additions ?? 0) > 0 || (task.deletions ?? 0) > 0;
  const activity = useTaskActivity(task.id);
  const indicator: 'busy' | 'unread' | null = activity.busy
    ? 'busy'
    : activity.unread && !isActive
      ? 'unread'
      : null;

  const handleSelect = () => {
    if (activity.unread) markTaskRead(task.id);
    onSelect();
  };

  return (
    <div
      onClick={handleSelect}
      className={cn(
        ROW_BASE,
        'cursor-pointer text-foreground/75 hover:bg-white/[0.04] hover:text-foreground',
        isActive && 'sidebar-active-indicator bg-white/[0.07] text-foreground'
      )}
    >
      {task.isPinned && <Pin className="h-3 w-3 shrink-0 text-foreground/40" />}
      {task.type === 'task' ? (
        <GitBranch className="h-3 w-3 shrink-0 text-emerald-300/70" />
      ) : (
        <MessageSquare className="h-3 w-3 shrink-0 text-foreground/45" />
      )}
      <span className="min-w-0 flex-1 truncate">{task.name}</span>

      <div className="relative flex min-w-[2.5rem] shrink-0 items-center justify-end">
        <div className="flex items-center gap-1.5 transition-opacity group-hover:opacity-0">
          {task.prNumber ? (
            <PrBadge prNumber={task.prNumber} status={task.prStatus} size="xs" asButton={false} />
          ) : indicator === 'busy' ? (
            <Spinner size="sm" className="h-3 w-3 text-[hsl(var(--ace-accent))]" />
          ) : indicator === 'unread' ? (
            <span
              className="mr-1 block h-1.5 w-1.5 rounded-full bg-sky-300 ring-2 ring-sky-500/40"
              aria-label="Agent finished"
              title="Agent finished — click to open"
            />
          ) : (
            <>
              {hasChanges && (
                <div className="inline-flex items-center gap-1 text-[11px] font-medium">
                  {(task.additions ?? 0) > 0 && (
                    <span className="text-emerald-400/80">+{task.additions}</span>
                  )}
                  {(task.deletions ?? 0) > 0 && (
                    <span className="text-red-400/80">-{task.deletions}</span>
                  )}
                </div>
              )}
              {compact && (
                <span className="text-[11px] text-foreground/40">{compact}</span>
              )}
            </>
          )}
        </div>
        <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <InlineIconButton
            icon={Archive}
            title="Archive"
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
          />
          <InlineIconButton
            icon={Trash2}
            title={task.type === 'thread' ? 'Delete thread' : 'Delete task…'}
            danger
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          />
        </div>
      </div>
    </div>
  );
}
