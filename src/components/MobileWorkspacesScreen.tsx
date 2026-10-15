import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive, ChevronDown, ChevronRight, FolderInput, FolderOpen, FolderPlus, GitBranch,
  Layers, MessageSquare, MoreHorizontal, Wand2, Zap,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';
import { useCoreSelector } from '../runtime/core-registry';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useBodyScrollLock } from '../runtime/use-body-scroll-lock';
import {
  UNGROUPED_ID,
  applyAutoSuggestions,
  assignWorkspace,
  createFolder,
  deleteFolder,
  folderForWorkspace,
  isCollapsed,
  listFolders,
  reconcile,
  renameFolder,
  setCollapsed,
  useWorkspaceFolders,
  type WorkspaceFolder,
} from '../runtime/workspace-folders-registry';
import { SWIPE_MIN_PX, SWIPE_MIN_VELOCITY } from '../runtime/use-swipe';
import { MobileWorkspaceSheet } from './MobileWorkspaceSheet';
import {
  ChangeStat, IconWell, MobileEmptyState, MobilePill, PrTag, SectionLabel, SheetHeader, StatusDot,
} from './ui/mobile';
import type { MobileStatus } from './ui/mobile';
import type { Task, Workspace } from '../lib/types';

export function MobileWorkspacesScreen() {
  const workspaces = useCoreSelector((s) => s.workspaces.filter((w) => !w.isPersonal));
  // Subscribe so folder edits re-render; the snapshot itself is read via the
  // sorted helpers below.
  useWorkspaceFolders();

  // Keep folder memberships honest as workspaces come and go (orphan cleanup +
  // empty auto-folder prune). Keyed on the id set so it only runs on real change.
  const liveKey = useMemo(() => workspaces.map((w) => w.id).sort().join(','), [workspaces]);
  useEffect(() => {
    reconcile(liveKey ? liveKey.split(',') : []);
  }, [liveKey]);

  const byId = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const userFolders = listFolders();
  const grouped = new Set<string>();
  for (const f of userFolders) for (const id of f.workspaceIds) grouped.add(id);
  const ungrouped = workspaces.filter((w) => !grouped.has(w.id));

  const [moveTarget, setMoveTarget] = useState<Workspace | null>(null);

  const onNewFolder = () => {
    const name = window.prompt('Folder name');
    if (name && name.trim()) createFolder(name.trim());
  };

  return (
    <div className="shell-sidebar-surface h-full min-h-0 overflow-y-auto">
      <div
        className="mx-auto w-full max-w-2xl px-4 pt-4"
        style={{ paddingBottom: 'max(6rem, calc(env(safe-area-inset-bottom) + 5rem))' }}
      >
        <div className="mb-2 flex items-center justify-between px-1">
          <SectionLabel count={workspaces.length}>Workspaces</SectionLabel>
          <div className="flex items-center gap-1">
            <MobilePill
              className="h-9 w-9"
              onClick={() => applyAutoSuggestions(workspaces)}
              aria-label="Auto-group by repo"
              title="Auto-group by repo"
            >
              <Wand2 className="h-4 w-4" />
            </MobilePill>
            <MobilePill
              className="h-9 w-9"
              onClick={onNewFolder}
              aria-label="New folder"
              title="New folder"
            >
              <FolderPlus className="h-4 w-4" />
            </MobilePill>
          </div>
        </div>

        {workspaces.length === 0 ? (
          <MobileEmptyState
            icon={<Layers className="h-4 w-4" />}
            label="No workspaces yet"
            hint="Open one from Today or clone a repo to get started."
          />
        ) : (
          <div className="flex flex-col gap-6">
            {userFolders.map((f) => (
              <FolderSection
                key={f.id}
                folder={f}
                workspaces={f.workspaceIds.map((id) => byId.get(id)).filter((w): w is Workspace => !!w)}
                onMove={setMoveTarget}
              />
            ))}
            {ungrouped.length > 0 && (
              <FolderSection
                key={UNGROUPED_ID}
                folder={{
                  id: UNGROUPED_ID,
                  name: 'Ungrouped',
                  collapsed: isCollapsed(UNGROUPED_ID),
                  workspaceIds: [],
                  order: Number.MAX_SAFE_INTEGER,
                }}
                workspaces={ungrouped}
                virtual
                onMove={setMoveTarget}
              />
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {moveTarget && (
          <MoveToFolderSheet
            key={`move-${moveTarget.id}`}
            workspace={moveTarget}
            folders={userFolders}
            onClose={() => setMoveTarget(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function FolderSection({
  folder,
  workspaces,
  virtual,
  onMove,
}: {
  folder: WorkspaceFolder;
  workspaces: Workspace[];
  virtual?: boolean;
  onMove: (w: Workspace) => void;
}) {
  const collapsed = folder.collapsed;
  return (
    // MACHINED PANEL segregation: each folder is ONE clearly bounded group — a
    // recessed SUNKEN WELL (.m-group-header: warm m-bg-sunken + inner top
    // shadow) that walls the whole folder off, with the collapse header along
    // its top lip and its RAISED workspace card-boxes sitting INSIDE it. With
    // gap-6 between wells (set by the parent), the owner's "folders bleed
    // together" complaint is gone — a folder reads unmistakably as its own
    // distinct container, not flush rows.
    <section className="m-group-header flex flex-col overflow-hidden p-2">
      <FolderHeader folder={folder} count={workspaces.length} virtual={virtual} />
      {!collapsed && (
        <div className="mt-2 flex flex-col gap-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150">
          {workspaces.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} onMove={onMove} />
          ))}
        </div>
      )}
    </section>
  );
}

function FolderHeader({
  folder,
  count,
  virtual,
}: {
  folder: WorkspaceFolder;
  count: number;
  virtual?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    // The header sits on the well's top lip (the well itself supplies the
    // recess), so it's a plain band here — not a second nested sunken layer.
    <div className="flex items-center gap-1 px-1">
      <button
        type="button"
        onClick={() => setCollapsed(folder.id, !folder.collapsed)}
        aria-expanded={!folder.collapsed}
        className="mobile-press flex min-h-11 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--m-text-tertiary)] transition-transform duration-150',
            !folder.collapsed && 'rotate-90'
          )}
        />
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--m-text-secondary)]">
          {folder.name}
        </span>
        <span className="mono-data text-[12.5px] text-[var(--m-text-tertiary)]">
          {String(count).padStart(2, '0')}
        </span>
      </button>
      {!virtual && (
        <div className="relative">
          <MobilePill className="h-8 w-8" onClick={() => setMenuOpen((v) => !v)} aria-label="Folder actions">
            <MoreHorizontal className="h-4 w-4" />
          </MobilePill>
          {menuOpen && (
            <>
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-[40] cursor-default"
              />
              <div className="absolute right-0 top-9 z-[41] w-40 overflow-hidden rounded-xl border border-[var(--m-hairline)] bg-[var(--m-surface)] p-1 shadow-[var(--m-sheet-shadow)]">
                <MenuItem
                  onClick={() => {
                    const next = window.prompt('Rename folder', folder.name);
                    if (next && next.trim()) renameFolder(folder.id, next.trim());
                    setMenuOpen(false);
                  }}
                >
                  Rename
                </MenuItem>
                <MenuItem
                  danger
                  onClick={() => {
                    deleteFolder(folder.id);
                    setMenuOpen(false);
                  }}
                >
                  Delete folder
                </MenuItem>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors active:bg-[var(--m-surface-press)]',
        danger ? 'text-[var(--m-error)]' : 'text-[var(--m-text)]'
      )}
    >
      {children}
    </button>
  );
}

function MoveToFolderSheet({
  workspace,
  folders,
  onClose,
}: {
  workspace: Workspace;
  folders: WorkspaceFolder[];
  onClose: () => void;
}) {
  useMobileBackHandler(true, onClose);
  useBodyScrollLock();
  const current = folderForWorkspace(workspace.id);

  return (
    <>
      <motion.div
        key="move-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        onClick={onClose}
        className="fixed inset-0 z-[79] bg-[var(--m-scrim)]"
      />
      <motion.div
        // Drag-down-to-dismiss, reusing the slide-up entry spring on release.
        drag="y"
        dragDirectionLock
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.9 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > SWIPE_MIN_PX || info.velocity.y > SWIPE_MIN_VELOCITY * 1000) onClose();
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
        className="mobile-drawer-surface fixed inset-x-0 bottom-0 z-[80] flex max-h-[70vh] flex-col rounded-t-3xl"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 14px)' }}
      >
        <SheetHeader title="Move to folder" />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          <MoveRow
            label="Ungrouped"
            active={!current}
            onClick={() => {
              assignWorkspace(workspace.id, null);
              onClose();
            }}
          />
          {folders.map((f) => (
            <MoveRow
              key={f.id}
              label={f.name}
              active={current === f.id}
              onClick={() => {
                assignWorkspace(workspace.id, f.id);
                onClose();
              }}
            />
          ))}
          <MoveRow
            label="New folder…"
            onClick={() => {
              const name = window.prompt('Folder name');
              if (name && name.trim()) {
                const id = createFolder(name.trim());
                assignWorkspace(workspace.id, id);
              }
              onClose();
            }}
          />
        </div>
      </motion.div>
    </>
  );
}

function MoveRow({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mobile-press flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] transition-colors active:bg-[var(--m-surface-press)]',
        active ? 'text-[var(--m-text)]' : 'text-[var(--m-text-secondary)]'
      )}
    >
      <FolderOpen className="h-4 w-4 shrink-0 text-[var(--m-text-tertiary)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <span className="text-[12.5px] text-[var(--m-text-tertiary)]">Current</span>}
    </button>
  );
}

function WorkspaceCard({
  workspace: w,
  onMove,
}: {
  workspace: Workspace;
  onMove: (w: Workspace) => void;
}) {
  const { openWorkspace, openTask, activeWorkspace, setPendingChatKind } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Remote workspace payloads don't always include the task arrays; default
  // them so a missing array can't throw during render (a white-screen cause).
  const tasks = w.tasks ?? [];
  const archivedTasks = w.archivedTasks ?? [];
  const activeCount = tasks.length;
  const archivedCount = archivedTasks.length;
  const isActive = activeWorkspace?.id === w.id;
  const canCreateTask = w.isInitialized !== false;

  const startNewChat = (kind: 'thread' | 'task') => {
    setPendingChatKind(kind);
    openWorkspace(w.id, 'new-chat');
  };

  return (
    // Each workspace is its own RAISED card-box (Soft Warm Depth) so it reads as
    // a distinct, bounded object inside its folder group — not a flush row.
    <section className="m-raised relative overflow-hidden rounded-2xl px-1.5 py-1">
      {/* Active workspace = a 2px amber left-rail (the only amber in the list). */}
      {isActive && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 z-[1] w-0.5 bg-[var(--m-accent)]" />
      )}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="mobile-press flex w-full items-center gap-3 rounded-xl py-3 pl-1.5 pr-1 text-left transition-colors active:bg-[var(--m-surface-press)]"
      >
        <IconWell size="sm">
          <FolderOpen className="h-4 w-4" />
        </IconWell>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold text-[var(--m-text)]">{w.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-[var(--m-text-tertiary)]">
            <span>
              {activeCount} {activeCount === 1 ? 'thread' : 'threads'}
              {archivedCount > 0 && <> · {archivedCount} archived</>}
            </span>
            {w.githubRepo && <span className="mono-data truncate">· {w.githubRepo}</span>}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--m-text-tertiary)]" />
      </button>

      <div className="flex items-center gap-2 px-1 pb-1">
        <MobileCreateButton icon={MessageSquare} label="New thread" onClick={() => startNewChat('thread')} />
        {canCreateTask && (
          <MobileCreateButton icon={GitBranch} label="New task" primary onClick={() => startNewChat('task')} />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMove(w);
          }}
          aria-label="Move to folder"
          className="m-raised-btn mobile-press flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
        >
          <FolderInput className="h-4 w-4" />
        </button>
      </div>

      <AnimatePresence>
        {sheetOpen && (
          <MobileWorkspaceSheet
            key={`card-sheet-${w.id}`}
            workspace={w}
            onClose={() => setSheetOpen(false)}
          />
        )}
      </AnimatePresence>

      {activeCount > 0 && (
        // Dense task rows stay NEAR-FLAT inside the raised card (depth groups,
        // it doesn't repeat per row → no clutter); a hairline rules them off.
        <div className="border-t border-[var(--m-hairline)] px-0.5 pb-1.5 pt-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onClick={() => openTask(w.id, t.id)} />
          ))}
        </div>
      )}

      {archivedCount > 0 && (
        <div className="pb-2 pt-0.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] font-medium text-[var(--m-text-tertiary)] transition-colors active:bg-[var(--m-surface-press)]"
          >
            <Archive className="h-3.5 w-3.5" />
            <span className="flex-1">Archived · {archivedCount}</span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', showArchived ? 'rotate-0' : '-rotate-90')}
            />
          </button>
          {showArchived && (
            <div className="mt-0.5">
              {archivedTasks.map((t) => (
                <TaskRow key={t.id} task={t} archived onClick={() => openTask(w.id, t.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MobileCreateButton({
  icon: Icon,
  label,
  onClick,
  primary,
}: {
  icon: typeof FolderOpen;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  // `primary` = the one amber raised-fill button per card (New task); the rest
  // are neutral raised pills. Both press DOWN (Soft Warm Depth).
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mobile-press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium',
        primary ? 'm-accent-btn' : 'm-raised-btn'
      )}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function TaskRow({
  task,
  archived,
  onClick,
}: {
  task: Task;
  archived?: boolean;
  onClick: () => void;
}) {
  const TypeIcon = task.type === 'thread' ? MessageSquare : Zap;
  const status: MobileStatus =
    task.status === 'busy' ? 'busy'
    : task.status === 'done' ? 'done'
    : task.status === 'error' ? 'error'
    : 'idle';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors active:bg-[var(--m-surface-press)]',
        archived && 'opacity-70'
      )}
    >
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--m-hairline)] bg-[var(--m-surface)]">
        <TypeIcon className="h-3.5 w-3.5 text-[var(--m-text-secondary)]" />
        <StatusDot status={status} className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] text-[var(--m-text)]">{task.name}</p>
        <div className="mono-data mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--m-text-tertiary)]">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{task.branch}</span>
          <ChangeStat additions={task.additions} deletions={task.deletions} className="shrink-0" />
          {task.prNumber != null && <PrTag number={task.prNumber} className="shrink-0" />}
        </div>
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--m-text-tertiary)]" />
    </button>
  );
}
