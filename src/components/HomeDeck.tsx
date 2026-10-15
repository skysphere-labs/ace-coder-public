import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useApp } from '../store';
import { aceApi, type OpsTodo, type OpsTodoDigest } from '../lib/ace-api';
import type { AgentId, RunLedgerBoard, Task, Workspace } from '../lib/types';
import { useAgentCatalog } from '../runtime/agent-registry';
import {
  useWorkspaceCatalog,
  createWorkspaceFromDialog,
  openWorkspaceFromDialog,
  createWorkspaceTask,
} from '../runtime/workspace-registry';
import { useBusyTaskIds } from '../runtime/task-activity-registry';
import { Button } from './ui/button';
import { AceMark } from './ui/AceMark';
import {
  DeckCard,
  FleetRow,
  RecentRow,
  RunCountsBar,
  LiveDot,
  TodoRow,
  CaptureInput,
  SynthesisCard,
  NextMoveRow,
  isOverdue,
  deriveNextMoves,
  type NextItem,
} from './ui/deck';

// The desktop Home — a live "Today deck": greeting + fleet line, a Today card
// (capture + digest + open todos), the Fleet of running agents, honest per-
// project "Next moves", the run-ledger counts, and Recent workspaces. Every
// section reads only data the renderer already has (todo store, busy set ∩
// workspace catalog, the run-board projection) and degrades to a real empty
// state — never an invented row. The mobile landing (TodayDashboard) is a
// separate component and is untouched.
type TaskRef = { task: Task; ws: Workspace };

const TODO_PREVIEW = 5; // at most a handful of open rows on Home; the rest go to Operations.

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Winding down';
}

export function HomeDeck() {
  const {
    openWorkspace,
    openTask,
    setShowCloneWorkspaceModal,
    setView,
    setPendingChatKind,
    activeWorkspace,
  } = useApp();
  const workspaces = useWorkspaceCatalog();
  const busy = useBusyTaskIds();
  const agentCatalog = useAgentCatalog();

  const launchableAgents = useMemo(
    () =>
      agentCatalog
        .filter((a) => a.launchable)
        .map((a) => ({ id: a.id as AgentId, name: a.name })),
    [agentCatalog]
  );

  const allTasks = useMemo<TaskRef[]>(() => {
    const rows: TaskRef[] = [];
    for (const ws of workspaces) for (const t of ws.tasks ?? []) rows.push({ task: t, ws });
    return rows;
  }, [workspaces]);

  const fleet = useMemo(() => allTasks.filter((r) => busy.has(r.task.id)), [allTasks, busy]);
  const recent = useMemo(
    () =>
      allTasks
        .slice()
        .sort((a, b) => (b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? ''))
        .slice(0, 6),
    [allTasks]
  );

  // --- Today todos (self-fetch — same shared backend as the Operations panel
  // and the mobile Today surface, so create/done behave identically). ---
  const [todos, setTodos] = useState<OpsTodo[]>([]);
  const [digest, setDigest] = useState<OpsTodoDigest | null>(null);
  const [draft, setDraft] = useState('');
  const [captureWorkspaceId, setCaptureWorkspaceId] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);

  const loadTodos = useCallback(async () => {
    try {
      const [list, dg] = await Promise.all([
        aceApi.ops.todos.list(),
        aceApi.ops.todos.digest().catch(() => null),
      ]);
      setTodos(list);
      setDigest(dg);
    } catch {
      /* keep last-good list — empty ≠ fake */
    }
  }, []);
  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const openTodos = useMemo(
    () => todos.filter((t) => t.status === 'open' || t.status === 'assigned'),
    [todos]
  );
  const previewTodos = openTodos.slice(0, TODO_PREVIEW);
  const hasOverdue = useMemo(
    () => openTodos.some((t) => t.dueAt && isOverdue(t.dueAt)),
    [openTodos]
  );

  const addTodo = async () => {
    const text = draft.trim();
    if (!text || addBusy) return;
    setAddBusy(true);
    try {
      await aceApi.ops.todos.create({ text, workspaceId: captureWorkspaceId });
      setDraft('');
      await loadTodos();
    } finally {
      setAddBusy(false);
    }
  };

  const toggleTodo = async (t: OpsTodo) => {
    if (busyTodoId) return;
    setBusyTodoId(t.id);
    try {
      await aceApi.ops.todos.update({
        id: t.id,
        patch: { status: t.status === 'done' ? 'open' : 'done' },
      });
      await loadTodos();
    } finally {
      setBusyTodoId(null);
    }
  };

  // Run-ledger projection — re-read on core / git events (RunBoardPanel pattern).
  const [board, setBoard] = useState<RunLedgerBoard | null>(null);
  useEffect(() => {
    let alive = true;
    let debounce: number | null = null;
    const reload = () =>
      aceApi.missions
        .runBoard()
        .then((b) => { if (alive) setBoard(b); })
        .catch(() => { /* board optional — the Runs row simply won't show */ });
    const schedule = () => {
      if (debounce != null) return;
      debounce = window.setTimeout(() => { debounce = null; reload(); }, 350);
    };
    reload();
    const offState = aceApi.core.subscribe(() => schedule());
    const offGit = aceApi.core.onGitChanged(() => schedule());
    const poll = window.setInterval(reload, 6000);
    return () => {
      alive = false;
      try { offState?.(); } catch { /* noop */ }
      try { offGit?.(); } catch { /* noop */ }
      if (debounce != null) window.clearTimeout(debounce);
      window.clearInterval(poll);
    };
  }, []);

  const counts = board?.counts;
  const followUpCount = board?.followUps?.pendingCount ?? 0;

  // --- Next moves — per non-personal workspace, the honest top 3: run-ledger
  // follow-ups + todo/in_progress card next actions + open OpsTodos tagged to
  // the workspace, ranked priority → dueAt → updatedAt. Projects with no real
  // item render NOTHING (no-mock rule). Derivation is the pure deriveNextMoves. ---
  const nextMoves = useMemo(
    () => deriveNextMoves(board, workspaces, openTodos),
    [board, workspaces, openTodos]
  );

  const open = async () => {
    const workspace = await openWorkspaceFromDialog();
    if (workspace) openWorkspace(workspace.id);
  };
  const newRepo = async () => {
    const workspace = await createWorkspaceFromDialog({ initializeRepo: true });
    if (workspace) openWorkspace(workspace.id);
  };

  // The single primary CTA. There is no desktop workspace-picker sheet, so pick
  // a deterministic target — the active workspace, else the most-recently-
  // touched one — rather than silently guessing; with none, fall back to the
  // Open/New dialog so the user makes a workspace first.
  const startNew = () => {
    const target = activeWorkspace ?? recent[0]?.ws ?? workspaces[0] ?? null;
    if (target) {
      setPendingChatKind('thread');
      openWorkspace(target.id, 'new-chat');
    } else {
      void open();
    }
  };

  // Spawn count× agents against one project item, then open the first task.
  const startAgentsFor = async (ws: Workspace, item: NextItem, agent: AgentId, count: number) => {
    const name = item.text.length > 60 ? `${item.text.slice(0, 57)}…` : item.text;
    let firstId: string | null = null;
    for (let i = 0; i < count; i += 1) {
      try {
        const { id } = await createWorkspaceTask(ws.id, { name, agent, prompt: item.text });
        if (!firstId) firstId = id;
      } catch {
        /* one failed spawn shouldn't abort the rest */
      }
    }
    if (firstId) openTask(ws.id, firstId);
  };

  const summaryParts: string[] = [];
  summaryParts.push(
    fleet.length > 0 ? `${fleet.length} agent${fleet.length === 1 ? '' : 's'} running` : 'No agents running'
  );
  if (counts && counts.readyToReview > 0) {
    summaryParts.push(`${counts.readyToReview} run${counts.readyToReview === 1 ? '' : 's'} in review`);
  }

  const workspaceOptions = useMemo(
    () => workspaces.map((w) => ({ id: w.id, name: w.name })),
    [workspaces]
  );

  return (
    <div className="h-full overflow-y-auto text-foreground">
      <div className="mx-auto w-full max-w-[1180px] px-8 py-8">
        {/* Header band — the one shimmering hero mark + greeting + fleet line. */}
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex items-center gap-3">
            <AceMark size={34} shimmer />
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
                {greeting()}.
              </h1>
              <p className="mt-0.5 text-sm text-foreground/55">{summaryParts.join(' · ')}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void open()}>Open</Button>
            <Button variant="outline" size="sm" onClick={() => void newRepo()}>New repo</Button>
            <Button variant="outline" size="sm" onClick={() => setShowCloneWorkspaceModal(true)}>Clone</Button>
            <Button variant="outline" size="sm" onClick={() => setView('new-remote')}>Add remote</Button>
            <Button variant="accent" size="sm" onClick={startNew}>New chat</Button>
          </div>
        </header>

        <div className="mt-4">
          <SetupIncompleteBanner />
        </div>

        {/* Today — capture + the twice-daily digest + open todos. */}
        <section className="mt-8">
          <Eyebrow label="Today" accent={hasOverdue ? 'overdue' : undefined} accentLive={false} />
          <DeckCard tick={hasOverdue}>
            <div className="px-4 py-3">
              <CaptureInput
                value={draft}
                onChange={setDraft}
                onSubmit={() => void addTodo()}
                disabled={addBusy}
                workspaces={workspaceOptions}
                workspaceId={captureWorkspaceId}
                onWorkspaceIdChange={setCaptureWorkspaceId}
              />
              {digest && (
                <SynthesisCard
                  goals={digest.goals}
                  suggestions={digest.suggestions}
                  generatedAt={digest.generatedAt}
                  source={digest.source}
                />
              )}
            </div>
            {openTodos.length === 0 ? (
              <div className="border-t border-white/[0.05] px-4 py-4 text-[12px] text-foreground/45">
                Nothing to do — jot one above.
              </div>
            ) : (
              <div className="border-t border-white/[0.05]">
                {previewTodos.map((t) => (
                  <TodoRow
                    key={t.id}
                    text={t.text}
                    dueAt={t.dueAt}
                    busy={busyTodoId === t.id}
                    onToggle={() => void toggleTodo(t)}
                  />
                ))}
                {openTodos.length > TODO_PREVIEW && (
                  <div className="flex justify-end px-4 py-2">
                    <button
                      type="button"
                      onClick={() => setView('todos')}
                      className="text-[12px] text-foreground/45 transition-colors hover:text-foreground/70"
                    >
                      All <span className="mono-data">{openTodos.length}</span> in Todos →
                    </button>
                  </div>
                )}
              </div>
            )}
          </DeckCard>
        </section>

        {/* Fleet — the marquee live element. */}
        <section className="mt-8">
          <Eyebrow label="Fleet" accent={fleet.length > 0 ? `${fleet.length} live` : undefined} />
          {fleet.length === 0 ? (
            <EmptyShelf>No agents running — start one from a workspace.</EmptyShelf>
          ) : (
            <DeckCard tick={fleet.length > 0}>
              {fleet.map(({ task, ws }) => (
                <FleetRow
                  key={task.id}
                  name={task.name}
                  agent={task.agent}
                  workspace={ws.name}
                  branch={task.branch}
                  additions={task.additions}
                  deletions={task.deletions}
                  onOpen={() => openTask(ws.id, task.id)}
                />
              ))}
            </DeckCard>
          )}
        </section>

        {/* Next moves — honest per-project top 3; hidden entirely when no
            project has a real item so Home never invents work. */}
        {nextMoves.length > 0 && (
          <section className="mt-8">
            <Eyebrow label="Next moves" />
            <div className="flex flex-col gap-4">
              {nextMoves.map(({ ws, items }) => (
                <div key={ws.id}>
                  <div className="mb-1.5 px-1 text-[11px] font-medium text-foreground/50">{ws.name}</div>
                  <DeckCard>
                    {items.map((item) => (
                      <NextMoveRow
                        key={item.key}
                        text={item.text}
                        agents={launchableAgents}
                        onStart={(agent, count) => void startAgentsFor(ws, item, agent, count)}
                      />
                    ))}
                  </DeckCard>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Runs — the run-ledger counts; hidden entirely when the ledger is empty. */}
        {counts && counts.total > 0 && (
          <section className="mt-8">
            <Eyebrow label="Runs" />
            <RunCountsBar counts={counts} followUpCount={followUpCount} onOpen={() => setView('board')} />
          </section>
        )}

        {/* Recent */}
        <section className="mt-8">
          <Eyebrow label="Recent" />
          {recent.length === 0 ? (
            <EmptyShelf>No recent tasks — open a workspace to get started.</EmptyShelf>
          ) : (
            <DeckCard>
              {recent.map(({ task, ws }) => (
                <RecentRow
                  key={task.id}
                  kind={task.type}
                  name={task.name}
                  workspace={ws.name}
                  branch={task.branch}
                  updatedAt={task.updatedAt}
                  additions={task.additions}
                  deletions={task.deletions}
                  onOpen={() => openTask(ws.id, task.id)}
                />
              ))}
            </DeckCard>
          )}
        </section>
      </div>
    </div>
  );
}

// Section eyebrow — a small caps label followed by a hairline rule (structure
// from rules + whitespace). An optional accent rides between the label and the
// rule; accentLive controls whether it shows the live ember (default) or a
// quiet static amber marker (e.g. "overdue").
function Eyebrow({
  label,
  accent,
  accentLive = true,
}: {
  label: string;
  accent?: string;
  accentLive?: boolean;
}) {
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">{label}</span>
      {accent && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[hsl(var(--ace-accent))]">
          <LiveDot live={accentLive} />
          {accent}
        </span>
      )}
      <div className="ledger-rule h-px flex-1" />
    </div>
  );
}

// A recessed warm shelf for empty sections — never a dashed box.
function EmptyShelf({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.04] bg-[hsl(var(--ace-void)/0.4)] px-4 py-6 text-center text-[13px] text-foreground/45">
      {children}
    </div>
  );
}

// Surfaces when prerequisites are missing after the user passed (or skipped)
// setup. Relocated from WelcomeScreen — only the desktop Home consumes it.
function SetupIncompleteBanner() {
  const { setView } = useApp();
  const catalog = useAgentCatalog();
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void aceApi.agents
      .getSystemTools()
      .then((tools) => {
        if (cancelled) return;
        const out: string[] = [];
        for (const tool of tools) {
          if (tool.kind === 'required' && !tool.ok) out.push(tool.label);
        }
        setMissing(out);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const noAgent = catalog.length > 0 && !catalog.some((a) => a.launchable);
  const items = [...missing, ...(noAgent ? ['a coding agent'] : [])];
  if (items.length === 0) return null;

  return (
    <button
      type="button"
      onClick={() => setView('setup')}
      className="flex w-full items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-left text-amber-200 transition-colors hover:bg-amber-500/[0.1]"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold">Setup incomplete</div>
        <div className="text-[11px] text-amber-100/85">
          Missing: {items.join(', ')}. Click to finish setup.
        </div>
      </div>
      <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
    </button>
  );
}
