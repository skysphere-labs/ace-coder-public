import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  Activity, BookOpen,  Gauge, KanbanSquare, Layers, ListTodo, MessageSquare, Radar, Users, Zap,
} from 'lucide-react';
import { useApp } from '../store';
import { useCoreSelector } from '../runtime/core-registry';
import { useBusyTaskIds } from '../runtime/task-activity-registry';
import { TodayTodos } from './TodayTodos';
import {
  AgentBadge,
  ChangeStat,
  GlassCard,
  IconWell,
  MobileEmptyState,
  MobileListRow,
  MobilePressable,
  SectionLabel,
} from './ui/mobile';
import { MobileWorkspacePickerSheet } from './MobileWorkspacePickerSheet';
import type { LucideIcon } from 'lucide-react';
import type { Task, Workspace } from '../lib/types';

// The mobile landing surface (replaces the Home tab). Slate Ledger editorial
// IA: a confident greeting band, the Operations todo intake, then ruled
// "Active" / "Recent" lists — what's running now and what you touched
// recently, all from the shared mobile atoms.
// Empty ≠ fake: every section degrades to a MobileEmptyState rather than
// inventing rows.
type TaskRef = { task: Task; ws: Workspace };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Winding down';
}

export function TodayDashboard() {
  const { openTask, openWorkspace, setPendingChatKind, setView } = useApp();
  const workspaces = useCoreSelector((s) => s.workspaces.filter((w) => !w.isPersonal));
  // The real "agent running" signal is synthesized from live PTY activity (the
  // backend task.status is always 'idle'), so read the busy set, not status.
  const busyTaskIds = useBusyTaskIds();
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [pendingChatKindLocal, setPendingChatKindLocal] = useState<'thread' | null>(null);

  const allTasks = useMemo<TaskRef[]>(() => {
    const rows: TaskRef[] = [];
    for (const ws of workspaces) for (const t of ws.tasks ?? []) rows.push({ task: t, ws });
    return rows;
  }, [workspaces]);

  const active = useMemo(() => allTasks.filter((r) => busyTaskIds.has(r.task.id)), [allTasks, busyTaskIds]);
  const recent = useMemo(
    () =>
      allTasks
        .slice()
        .sort((a, b) => (b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? ''))
        .slice(0, 6),
    [allTasks]
  );

  // "New chat" needs a workspace target. Auto-pick ONLY when there is
  // exactly one; with several, let the owner CHOOSE via the picker sheet rather
  // than silently dropping them into one project; with none, go to Workspaces.
  const startNew = (kind: 'thread') => {
    if (workspaces.length === 1) {
      setPendingChatKind(kind);
      openWorkspace(workspaces[0].id, 'new-chat');
    } else if (workspaces.length > 1) {
      setPendingChatKindLocal(kind);
      setShowWorkspacePicker(true);
    } else {
      setView('workspaces');
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div
        className="mx-auto w-full max-w-2xl px-5 pt-5"
        style={{ paddingBottom: 'max(6rem, calc(env(safe-area-inset-bottom) + 5rem))' }}
      >
        {/* Greeting band — type carries the authority, not a card. */}
        <h1
          className="text-[30px] leading-[1.08] tracking-[-0.022em] text-[var(--m-text)]"
          style={{ fontWeight: 680 }}
        >
          {greeting()}
        </h1>
        <p className="mt-1 text-[14px] text-[var(--m-text-secondary)]">
          {active.length > 0
            ? `${active.length} agent${active.length === 1 ? '' : 's'} running`
            : 'No agents running right now'}
        </p>

        <div className="mt-6">
          <TodayTodos />
        </div>

        {/* Secondary actions: tactile raised pills (press down), not flat links. */}
        <div className="mt-3 flex items-stretch gap-2.5">
          <ActionLink icon={MessageSquare} label="New chat" onClick={() => startNew('thread')} />
          <ActionLink icon={Users} label="Teams" onClick={() => setView('teams')} />
        </div>

        {/* Promoted Operations surfaces — the retired hub's kept features,
            reachable here on mobile (desktop exposes them as nav-rail tabs). */}
        <div className="mt-2.5 grid grid-cols-3 gap-2.5">
          <ActionLink icon={KanbanSquare} label="Board" onClick={() => setView('board')} />
          <ActionLink icon={ListTodo} label="Todos" onClick={() => setView('todos')} />
          <ActionLink icon={Radar} label="Intel" onClick={() => setView('intel')} />
          <ActionLink icon={Gauge} label="Monitor" onClick={() => setView('monitor')} />
          <ActionLink icon={BookOpen} label="Knowledge" onClick={() => setView('knowledge')} />
        </div>

        <SectionLabel className="mt-8" count={active.length}>
          Active
        </SectionLabel>
        <div className="mt-2">
          {active.length === 0 ? (
            <MobileEmptyState
              icon={<Zap className="h-4 w-4" />}
              label="Nothing running"
              hint="Agents you start will appear here."
            />
          ) : (
            // A raised card-box bounds the list; the dense rows inside stay
            // near-flat (depth where it groups, not on every row → no clutter).
            <GlassCard className="overflow-hidden">
              {active.map(({ task, ws }, i) => (
                <MobileListRow
                  key={task.id}
                  live
                  divider={i < active.length - 1}
                  leading={
                    <IconWell size="sm" tone="accent">
                      <Activity className="h-3.5 w-3.5" />
                    </IconWell>
                  }
                  title={task.name}
                  subtitle={ws.name}
                  trailing={<AgentBadge agent={task.agent} />}
                  chevron
                  onClick={() => openTask(ws.id, task.id)}
                />
              ))}
            </GlassCard>
          )}
        </div>

        <SectionLabel className="mt-8" count={recent.length}>
          Recent
        </SectionLabel>
        <div className="mt-2">
          {recent.length === 0 ? (
            <MobileEmptyState
              icon={<Layers className="h-4 w-4" />}
              label="No recent tasks"
              hint="Open a workspace to get started."
            />
          ) : (
            <GlassCard className="overflow-hidden">
              {recent.map(({ task, ws }, i) => (
                <MobileListRow
                  key={task.id}
                  divider={i < recent.length - 1}
                  leading={
                    <IconWell size="sm">
                      {task.type === 'thread' ? (
                        <MessageSquare className="h-3.5 w-3.5" />
                      ) : (
                        <Zap className="h-3.5 w-3.5" />
                      )}
                    </IconWell>
                  }
                  title={task.name}
                  subtitle={
                    <>
                      {ws.name} · <span className="mono-data">{task.branch}</span>
                    </>
                  }
                  trailing={<ChangeStat additions={task.additions} deletions={task.deletions} />}
                  chevron
                  onClick={() => openTask(ws.id, task.id)}
                />
              ))}
            </GlassCard>
          )}
        </div>
      </div>

      <AnimatePresence>
        {showWorkspacePicker && (
          <MobileWorkspacePickerSheet
            key="workspace-picker"
            workspaces={workspaces}
            chatKind={pendingChatKindLocal}
            onClose={() => {
              setShowWorkspacePicker(false);
              setPendingChatKindLocal(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// A demoted secondary action — now a tactile RAISED pill (Soft Warm Depth) that
// presses down on tap, glyph over a quiet label, in a row beneath the single
// primary action.
function ActionLink({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <MobilePressable
      onClick={onClick}
      className="m-raised-btn mobile-press flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1.5 rounded-xl py-3"
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      <span className="text-[12.5px] font-medium">{label}</span>
    </MobilePressable>
  );
}
