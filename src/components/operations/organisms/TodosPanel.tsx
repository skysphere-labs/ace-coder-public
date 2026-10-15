import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Pencil,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  OpsTodo,
  OpsTodoDigest,
  OpsTodoKind,
  OpsTodoPriority,
  OpsTodoStatus,
} from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { useWorkspaceCatalog } from '../../../runtime/workspace-registry';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Chip } from '../atoms/Chip';
import type { ChipTone } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { Identifier } from '../atoms/Identifier';
import { KeyValue } from '../atoms/KeyValue';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../atoms/states';
import { OverflowMenu } from '../molecules/OverflowMenu';
import type { OverflowMenuItem } from '../molecules/OverflowMenu';
import { SegmentedControl } from '../molecules/SegmentedControl';
import type { SegmentedOption } from '../molecules/SegmentedControl';
import { WorkspaceSelect } from '../molecules/WorkspaceSelect';
import { EvidenceDrawer } from './EvidenceDrawer';

// ─── Kind chip ────────────────────────────────────────────────────────────────
// dev=sky, company=emerald, life=amber, unclassified=neutral — shared Chip tones.
const KIND_TONE: Record<OpsTodoKind, ChipTone> = {
  dev: 'sky',
  life: 'amber',
  company: 'emerald',
  unclassified: 'neutral',
};
const KIND_LABEL: Record<OpsTodoKind, string> = {
  dev: 'Dev',
  life: 'Life',
  company: 'Company',
  unclassified: 'Unclassified',
};

function KindChip({ kind }: { kind: OpsTodoKind }) {
  return <Chip tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Chip>;
}

// ─── Todo status chip ────────────────────────────────────────────────────────
// Renamed from a local "StatusPill" that shadowed atoms/StatusPill (severity
// contract). Built on the shared Chip and pairs color + glyph + label per the
// colorblind contract (contracts §1).
const STATUS_META: Record<OpsTodoStatus, { tone: ChipTone; icon: LucideIcon; label: string }> = {
  open: { tone: 'neutral', icon: Circle, label: 'Open' },
  assigned: { tone: 'amber', icon: UserRound, label: 'Assigned' },
  promoted: { tone: 'sky', icon: ArrowUpRight, label: 'Promoted' },
  done: { tone: 'emerald', icon: Check, label: 'Done' },
};

function TodoStatusChip({ status }: { status: OpsTodoStatus }) {
  const { tone, icon: Icon, label } = STATUS_META[status];
  return (
    <Chip tone={tone} className={status === 'open' ? 'text-foreground/75' : undefined}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </Chip>
  );
}

// ─── Due date helpers ────────────────────────────────────────────────────────
// dueAt is stored as a date string (YYYY-MM-DD from the date input). Date-only
// strings parse as LOCAL midnight here so "due today" never reads as overdue.
function parseDue(dueAt: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueAt);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(dueAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDueLabel(dueAt: string): string {
  const due = parseDue(dueAt);
  if (!due) return '';
  const sameYear = due.getFullYear() === new Date().getFullYear();
  return `due ${due.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}

function isOverdue(dueAt: string, status: OpsTodoStatus): boolean {
  if (status === 'done') return false;
  const due = parseDue(dueAt);
  if (!due) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return due.getTime() < startOfToday.getTime();
}

// ─── Details fields ──────────────────────────────────────────────────────────
// Shared expandable form: intake "Details" disclosure + per-row edit. Fast
// capture stays one keystroke; these are optional.
type TodoDetailsDraft = {
  notes: string;
  priority: OpsTodoPriority | '';
  dueAt: string; // YYYY-MM-DD or ''
  workspaceId: string; // '' = default workspace
};

const EMPTY_DETAILS: TodoDetailsDraft = { notes: '', priority: '', dueAt: '', workspaceId: '' };

const FIELD_CLASS =
  'rounded-md border border-white/[0.06] bg-white/[0.04] text-foreground/80 focus:outline-none focus:ring-1 focus:ring-sky-500/40 disabled:opacity-50';

function DetailsFields({
  idPrefix,
  draft,
  onChange,
  workspaces,
  disabled = false,
}: {
  idPrefix: string;
  draft: TodoDetailsDraft;
  onChange: (next: TodoDetailsDraft) => void;
  workspaces: Array<{ id: string; name: string }>;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-notes`} className="text-xs text-foreground/65">
          Notes
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          rows={2}
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          disabled={disabled}
          placeholder="Context, links, acceptance…"
          className={cn(
            FIELD_CLASS,
            'resize-y px-2 py-1.5 text-[13px] text-foreground/90 placeholder:text-foreground/45'
          )}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${idPrefix}-priority`} className="text-xs text-foreground/65">
            Priority
          </label>
          <select
            id={`${idPrefix}-priority`}
            value={draft.priority}
            onChange={(e) => onChange({ ...draft, priority: e.target.value as OpsTodoPriority | '' })}
            disabled={disabled}
            className={cn(FIELD_CLASS, 'h-8 px-2 text-xs')}
          >
            <option value="">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${idPrefix}-due`} className="text-xs text-foreground/65">
            Due
          </label>
          <input
            id={`${idPrefix}-due`}
            type="date"
            value={draft.dueAt}
            onChange={(e) => onChange({ ...draft, dueAt: e.target.value })}
            disabled={disabled}
            className={cn(FIELD_CLASS, 'h-8 px-2 text-xs')}
          />
        </div>
        {workspaces.length > 0 && (
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-foreground/65">Workspace</label>
            <WorkspaceSelect
              workspaces={workspaces}
              value={draft.workspaceId}
              onChange={(workspaceId) => onChange({ ...draft, workspaceId })}
              placeholder="Default"
              disabled={disabled}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TodoRow ─────────────────────────────────────────────────────────────────
// Molecule: one SLIM todo row — status chip · title · kind chip · due label,
// then exactly ONE primary action (C3): the Done/Reopen toggle (all kinds —
// "done" is the honest archive). Everything else (Edit, Assign owner, Delete)
// lives in the ⋯ OverflowMenu.
// Relative age rides the title tooltip; notes/source moved to the edit
// EvidenceDrawer (C2).

type TodoRowProps = {
  todo: OpsTodo;
  workspaces: Array<{ id: string; name: string }>;
  isNew: boolean;
  onReload: () => void;
};

function TodoRow({ todo, workspaces, isNew, onReload }: TodoRowProps) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [ownerDraft, setOwnerDraft] = useState(todo.owner ?? '');
  const [ownerOpen, setOwnerOpen] = useState(false); // owner input revealed from the ⋯ menu
  const [titleDraft, setTitleDraft] = useState<string | null>(null); // null = not editing
  const [editOpen, setEditOpen] = useState(false); // EvidenceDrawer (edit + details)
  const [editKind, setEditKind] = useState<OpsTodoKind>(todo.kind);
  const [editDraft, setEditDraft] = useState<TodoDetailsDraft>(EMPTY_DETAILS);
  const [statusFlash, setStatusFlash] = useState(false);

  const setBusyKey = (key: string, val: boolean) =>
    setBusy((prev) => ({ ...prev, [key]: val }));
  const isAnyBusy = Object.values(busy).some(Boolean);

  // Notices auto-dismiss so stale "Ticket created" lines never accumulate.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const fail = (err: unknown, fallback: string) =>
    setNotice({ text: err instanceof Error ? err.message : fallback, tone: 'error' });

  // ── Title inline edit ──
  async function handleTitleCommit() {
    if (titleDraft == null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (!next || next === todo.text) return;
    setBusyKey('title', true);
    try {
      await aceApi.ops.todos.update({ id: todo.id, patch: { text: next } });
      onReload();
    } catch (err) {
      fail(err, 'Title update failed');
    } finally {
      setBusyKey('title', false);
    }
  }

  // ── Details edit (kind + notes/priority/due/workspace) ──
  function openEdit() {
    setEditKind(todo.kind);
    setEditDraft({
      notes: todo.notes ?? '',
      priority: todo.priority ?? '',
      dueAt: todo.dueAt ? todo.dueAt.slice(0, 10) : '',
      workspaceId: todo.workspaceId ?? '',
    });
    setEditOpen(true);
  }

  // Stable identity REQUIRED: EvidenceDrawer refocuses its Close button when
  // onClose changes — an inline closure here would steal focus from the form
  // fields on every keystroke. Only flips identity around an in-flight save.
  const closeEdit = useCallback(() => {
    if (!busy.details) setEditOpen(false);
  }, [busy.details]);

  async function handleEditSave() {
    setBusyKey('details', true);
    try {
      await aceApi.ops.todos.update({
        id: todo.id,
        patch: {
          kind: editKind,
          notes: editDraft.notes.trim() ? editDraft.notes.trim() : null,
          priority: editDraft.priority || null,
          dueAt: editDraft.dueAt || null,
          workspaceId: editDraft.workspaceId || null,
        },
      });
      setEditOpen(false);
      onReload();
    } catch (err) {
      fail(err, 'Details update failed');
    } finally {
      setBusyKey('details', false);
    }
  }

  // ── Owner assign (non-dev) ──
  async function handleOwnerCommit() {
    const owner = ownerDraft.trim() || null;
    if (owner === todo.owner) return;
    setBusyKey('owner', true);
    try {
      await aceApi.ops.todos.update({
        id: todo.id,
        patch: { owner, status: owner ? 'assigned' : 'open' },
      });
      onReload();
    } catch (err) {
      fail(err, 'Assign failed');
    } finally {
      setBusyKey('owner', false);
    }
  }

  // ── Done toggle — all kinds; "done" IS the archive state ──
  async function handleDoneToggle() {
    setBusyKey('done', true);
    try {
      await aceApi.ops.todos.update({
        id: todo.id,
        patch: { status: todo.status === 'done' ? 'open' : 'done' },
      });
      setStatusFlash(true);
      onReload();
    } catch (err) {
      fail(err, 'Status update failed');
    } finally {
      setBusyKey('done', false);
    }
  }

  // ── Remove ──
  async function handleRemove() {
    setBusyKey('remove', true);
    try {
      await aceApi.ops.todos.remove({ id: todo.id });
      onReload();
    } catch (err) {
      fail(err, 'Remove failed');
      setBusyKey('remove', false);
    }
  }

  const isDev = todo.kind === 'dev';
  const isDone = todo.status === 'done';

  // Secondary actions behind ⋯ (C3): Edit, Assign owner (non-dev), and Delete
  // (direct remove — no confirm today, none added). Done/Reopen is the row's
  // primary button, so it does not repeat here.
  const menuItems: OverflowMenuItem[] = [
    { key: 'edit', label: 'Edit details', icon: Pencil, onSelect: openEdit, disabled: isAnyBusy },
    ...(!isDev
      ? [
          {
            key: 'owner',
            label: todo.owner ? 'Change owner' : 'Assign owner',
            icon: UserRound,
            onSelect: () => {
              setOwnerDraft(todo.owner ?? '');
              setOwnerOpen(true);
            },
            disabled: isAnyBusy,
          },
        ]
      : []),
    {
      key: 'remove',
      label: 'Delete',
      icon: Trash2,
      onSelect: () => void handleRemove(),
      destructive: true,
      disabled: isAnyBusy,
    },
  ];

  return (
    <>
      <div
        role="listitem"
        onAnimationEnd={() => setStatusFlash(false)}
        className={cn(
          'flex flex-col gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5',
          // One sky pulse when a status change just "took" (promote/done).
          statusFlash && 'motion-safe:animate-value-flash',
          // Entrance for the row Chief just jotted — reduced-motion: instant.
          isNew && 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 duration-200'
        )}
      >
        {/* Slim primary line (PRD §7): status · title · kind · due, then ONE
            primary action + ⋯. Relative age lives in the title tooltip. */}
        <div className="flex flex-wrap items-center gap-2">
          <TodoStatusChip status={todo.status} />
          {titleDraft != null ? (
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void handleTitleCommit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleTitleCommit();
                if (e.key === 'Escape') setTitleDraft(null);
              }}
              autoFocus
              disabled={isAnyBusy}
              aria-label="Edit todo title"
              className={cn(
                FIELD_CLASS,
                'h-8 min-w-0 flex-1 px-2 text-[13px] font-medium text-foreground/90'
              )}
            />
          ) : (
            <button
              type="button"
              onClick={() => setTitleDraft(todo.text)}
              disabled={isAnyBusy}
              title={`Added ${formatRelativeTime(todo.createdAt) || 'just now'} · ${new Date(
                todo.createdAt
              ).toLocaleString()} — click to edit`}
              className={cn(
                'min-w-0 flex-1 text-left text-[13px] font-medium leading-snug motion-safe:transition-opacity motion-safe:duration-150 hover:text-foreground',
                isDone ? 'text-foreground/50 line-through' : 'text-foreground/90'
              )}
            >
              {todo.text}
            </button>
          )}
          <KindChip kind={todo.kind} />
          {/* D8 tags — small quiet chips; tags ?? [] guards stale pre-tags records */}
          {(todo.tags ?? []).map((tag) => (
            <Chip key={tag} className="px-1.5 py-0 text-[11px] text-foreground/60">
              #{tag}
            </Chip>
          ))}
          {todo.dueAt && (
            <span
              className={cn(
                'text-xs tabular-nums',
                isOverdue(todo.dueAt, todo.status) ? 'text-rose-200' : 'text-foreground/60'
              )}
            >
              {formatDueLabel(todo.dueAt)}
            </span>
          )}
          {/* Done/Reopen is the single primary action for every todo — the
              "done" state is the honest archive. */}
          <Button
            variant={isDone ? 'default' : 'outline'}
            size="sm"
            onClick={() => void handleDoneToggle()}
            disabled={isAnyBusy}
            className="text-xs"
          >
            {isDone ? 'Reopen' : 'Done'}
          </Button>
          <OverflowMenu items={menuItems} ariaLabel="Todo actions" />
        </div>

        {/* Owner assign (non-dev) — revealed on demand from the ⋯ menu; same
            commit-on-Enter/blur wiring as the old always-visible input. */}
        {ownerOpen && !isDev && (
          <input
            type="text"
            value={ownerDraft}
            onChange={(e) => setOwnerDraft(e.target.value)}
            onBlur={() => {
              void handleOwnerCommit();
              setOwnerOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setOwnerDraft(todo.owner ?? '');
                setOwnerOpen(false);
              }
            }}
            placeholder="Assign owner…"
            autoFocus
            disabled={isAnyBusy}
            aria-label="Owner"
            className={cn(
              FIELD_CLASS,
              'h-8 min-w-0 px-2 text-[13px] text-foreground/90 placeholder:text-foreground/45'
            )}
          />
        )}

        {/* Notice — auto-dismisses; errors rose, successes sky */}
        {notice && (
          <p
            className={cn(
              'text-xs leading-snug',
              notice.tone === 'error' ? 'text-rose-300' : 'text-sky-300'
            )}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/* Edit drawer — the old inline row expansion, relocated (PRD §7). Same
          fields, same save wiring; raw timestamps, source attribution, and the
          mission UUID (masked via Identifier) are drawer-only per C2. */}
      <EvidenceDrawer
        open={editOpen}
        title={todo.text}
        eyebrow="Edit todo"
        onClose={closeEdit}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={closeEdit}
              disabled={isAnyBusy}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleEditSave()}
              disabled={isAnyBusy}
              className="text-xs"
            >
              {busy.details ? 'Saving…' : 'Save details'}
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-foreground/65">Kind</span>
          <SegmentedControl
            size="sm"
            ariaLabel="Todo kind"
            options={KIND_OPTIONS}
            value={editKind}
            onChange={setEditKind}
          />
        </div>
        <DetailsFields
          idPrefix={`todo-${todo.id}`}
          draft={editDraft}
          onChange={setEditDraft}
          workspaces={workspaces}
          disabled={isAnyBusy}
        />
        {/* Save failures surface here — the row notice sits behind the backdrop. */}
        {notice && notice.tone === 'error' && (
          <p className="text-xs leading-snug text-rose-300">{notice.text}</p>
        )}
        {/* Read-only facts (KeyValue): everything the slim row no longer shows
            stays one interaction away (C6). */}
        <div className="flex flex-col gap-0.5 border-t border-white/[0.06] pt-2">
          <KeyValue label="Added">
            {`${formatRelativeTime(todo.createdAt) || 'just now'} · ${new Date(
              todo.createdAt
            ).toLocaleString()}`}
          </KeyValue>
          {todo.source && <KeyValue label="Source">from {todo.source}</KeyValue>}
          {todo.owner && <KeyValue label="Owner">{todo.owner}</KeyValue>}
          {todo.promotedMissionId && (
            <KeyValue label="Mission">
              <Identifier value={todo.promotedMissionId} label="mission" />
            </KeyValue>
          )}
        </div>
      </EvidenceDrawer>
    </>
  );
}

// ─── Segmented options ───────────────────────────────────────────────────────
const INTAKE_KIND_OPTIONS: SegmentedOption<OpsTodoKind>[] = [
  { value: 'dev', label: 'Dev' },
  { value: 'life', label: 'Life' },
  { value: 'company', label: 'Company' },
];
const KIND_OPTIONS: SegmentedOption<OpsTodoKind>[] = [
  ...INTAKE_KIND_OPTIONS,
  { value: 'unclassified', label: 'Unclassified' },
];

// ─── Lifecycle group disclosure ──────────────────────────────────────────────
function GroupDisclosure({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex items-center gap-1.5 self-start text-xs font-medium text-foreground/60 hover:text-foreground/80"
    >
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 motion-safe:transition-transform motion-safe:duration-150',
          open && 'rotate-90'
        )}
        aria-hidden="true"
      />
      {label}
      <CountBadge count={count} />
    </button>
  );
}

// ─── Notepad draft persistence ───────────────────────────────────────────────
// The capture box autosaves to localStorage so a half-typed dump survives a
// tab switch / app restart. Cleared on successful add.
const DRAFT_KEY = 'ace.ops.todo.draft';

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string) {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY, text);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage unavailable — the draft just doesn't persist.
  }
}

// ─── Digest card ─────────────────────────────────────────────────────────────
// D9: the twice-daily synthesis surfaced at the top of the Todo panel. The
// digest is RULE-BASED "auto-organized proposals" (grouping + outcome
// restatement + next-step suggestions) — it is labeled as such and NOTHING is
// auto-promoted.
const DIGEST_FRESH_MS = 14 * 60 * 60 * 1000;

function DigestCard({
  digest,
  synthBusy,
  onSynthesize,
}: {
  digest: OpsTodoDigest;
  synthBusy: boolean;
  onSynthesize: () => void;
}) {
  // Freshness is a one-time mount decision (drives defaultOpen). Capture the
  // clock once via a lazy useState initializer so the impure Date.now() read
  // stays out of the render path (react-hooks/purity).
  const [fresh] = useState(
    () => Date.now() - new Date(digest.generatedAt).getTime() < DIGEST_FRESH_MS,
  );

  return (
    <>
      <DisclosureRow
        label={`Synthesis — ${digest.slot} · ${formatRelativeTime(digest.generatedAt) || 'just now'}`}
        summary={`${digest.goals.length} goals · ${digest.suggestions.length} suggestions`}
        defaultOpen={fresh}
        storageKey="todo-digest"
      >
        {/* Goals — outcome restatements, bold lines */}
        {digest.goals.length > 0 && (
          <div className="flex flex-col gap-1" role="list" aria-label="Digest goals">
            {digest.goals.map((goal, i) => (
              <p key={`${goal.text}-${i}`} role="listitem" className="text-[13px] font-semibold leading-snug text-foreground/90">
                {goal.text}
              </p>
            ))}
          </div>
        )}

        {/* Per-todo suggestions — outcome restatement + next-step hint */}
        {digest.suggestions.length > 0 ? (
          <div className="flex flex-col gap-1.5" role="list" aria-label="Digest suggestions">
            {digest.suggestions.map((s) => (
              <div key={s.todoId} role="listitem" className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground/85">
                  {s.text}
                </span>
                <span className="text-xs text-foreground/60">{s.suggestion}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-foreground/60">No open todos at the last synthesis.</p>
        )}

        {/* Honest footer + manual re-run. Quiet by design. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2">
          <span className="min-w-0 flex-1 text-xs text-foreground/50">
            Auto-organized proposals — nothing was auto-promoted.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSynthesize}
            disabled={synthBusy}
            className="text-xs text-foreground/70"
          >
            {synthBusy ? 'Synthesizing…' : 'Synthesize now'}
          </Button>
        </div>
      </DisclosureRow>
    </>
  );
}

// ─── TodosPanel ───────────────────────────────────────────────────────────────
// Organism: Chief's todo intake. Self-fetching (no registry slice). Rows group
// by lifecycle — Open & assigned expanded, Promoted/Done collapsed — newest-first
// within groups. Each row's single primary action is the Done/Reopen toggle.
export function TodosPanel() {
  const workspaces = useWorkspaceCatalog();
  const workspaceOptions = useMemo(
    () => workspaces.map((w) => ({ id: w.id, name: w.name })),
    [workspaces]
  );

  // ── Local state ──
  const [todos, setTodos] = useState<OpsTodo[]>([]);
  const [digest, setDigest] = useState<OpsTodoDigest | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Notepad capture state — multiline dump, draft autosaved (D8); kind +
  // details stay available but visually secondary.
  const [inputText, setInputText] = useState<string>(() => readDraft());
  const [inputKind, setInputKind] = useState<OpsTodoKind>('dev');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<TodoDetailsDraft>(EMPTY_DETAILS);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthError, setSynthError] = useState<string | null>(null);

  // Tag filter — derived from existing tags; null = All.
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Lifecycle group disclosures
  const [showPromoted, setShowPromoted] = useState(false);
  const [showDone, setShowDone] = useState(false);

  // Draft autosave — every keystroke persists; cleared on successful add.
  useEffect(() => {
    writeDraft(inputText);
  }, [inputText]);

  // ── Load (list + latest digest; a digest failure never blocks the list) ──
  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const [result, digestResult] = await Promise.all([
        aceApi.ops.todos.list(),
        aceApi.ops.todos.digest().catch(() => null),
      ]);
      setTodos(result);
      setDigest(digestResult);
      setLoadState('idle');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load todos');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Add — blank-line separated thoughts become SEPARATE todos (notepad) ──
  async function handleAdd() {
    const text = inputText.trim();
    if (!text || addBusy) return;
    const chunks = text
      .split(/\n[ \t]*\n+/)
      .map((c) => c.trim())
      .filter(Boolean);
    setAddBusy(true);
    setAddError(null);
    try {
      let lastId: string | null = null;
      for (const chunk of chunks) {
        const created = await aceApi.ops.todos.create({
          text: chunk,
          kind: inputKind,
          notes: detailsDraft.notes.trim() ? detailsDraft.notes.trim() : null,
          priority: detailsDraft.priority || null,
          dueAt: detailsDraft.dueAt || null,
          workspaceId: detailsDraft.workspaceId || null,
        });
        lastId = created?.id ?? lastId;
      }
      setInputText('');
      writeDraft('');
      setDetailsDraft(EMPTY_DETAILS);
      setLastAddedId(lastId);
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Add failed — the todo was not saved.');
    } finally {
      setAddBusy(false);
    }
  }

  // ── Synthesize now — manual digest run (rule-based; never auto-promotes) ──
  const synthesizeNow = useCallback(async () => {
    setSynthBusy(true);
    setSynthError(null);
    try {
      await aceApi.ops.todos.synthesize();
      await load();
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : 'Synthesis failed');
    } finally {
      setSynthBusy(false);
    }
  }, [load]);

  // ── Tag filter universe (from existing tags) ──
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos) for (const tag of t.tags ?? []) set.add(tag);
    return Array.from(set).sort();
  }, [todos]);

  // ── Lifecycle groups (newest-first within each, as returned by the API),
  // narrowed by the active tag filter ──
  const matchesTag = (t: OpsTodo) => tagFilter == null || (t.tags ?? []).includes(tagFilter);
  const openTodos = todos.filter(
    (t) => (t.status === 'open' || t.status === 'assigned') && matchesTag(t)
  );
  const promotedTodos = todos.filter((t) => t.status === 'promoted' && matchesTag(t));
  const doneTodos = todos.filter((t) => t.status === 'done' && matchesTag(t));
  const visibleCount = openTodos.length + promotedTodos.length + doneTodos.length;

  // Notepad grows with the dump: 3 rows min, 8 max.
  const captureRows = Math.min(8, Math.max(3, inputText.split('\n').length));

  const renderRows = (items: OpsTodo[], label: string) => (
    <div className="flex flex-col gap-2" role="list" aria-label={label}>
      {items.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          workspaces={workspaceOptions}
          isNew={todo.id === lastAddedId}
          onReload={() => void load()}
        />
      ))}
    </div>
  );

  return (
    <PanelShell>
      {/* Header — open count + Chief's-intake label */}
      <SectionHeader
        title="Todos"
        leading={
          <span className="flex items-center gap-1.5">
            <CountBadge count={openTodos.length} />
            <span className="text-xs font-normal text-foreground/60">open · Chief's intake</span>
          </span>
        }
      />

      {/* ── Digest card (D9): twice-daily rule-based synthesis at the top ───── */}
      {digest ? (
        <DigestCard
          digest={digest}
          synthBusy={synthBusy}
          onSynthesize={() => void synthesizeNow()}
        />
      ) : (
        loadState === 'idle' && (
          // Honest empty state — no digest has run yet, and we say so.
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-foreground/50" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-xs text-foreground/65">
              First synthesis runs at 07:00 / 21:00 — or run it now.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void synthesizeNow()}
              disabled={synthBusy}
              className="text-xs text-foreground/70"
            >
              {synthBusy ? 'Synthesizing…' : 'Synthesize now'}
            </Button>
          </div>
        )
      )}
      {synthError && <p className="text-xs leading-snug text-rose-300">{synthError}</p>}

      {/* ── Notepad capture (D8): multiline dump-first, details secondary ───── */}
      <div className="flex flex-col gap-2">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleAdd();
            }
          }}
          rows={captureRows}
          placeholder="Dump a thought… #tags work"
          disabled={addBusy}
          aria-label="New todo text"
          className={cn(
            FIELD_CLASS,
            // 16px below sm so iOS never zooms the notepad; blank-line
            // separated thoughts split into separate todos on Add.
            'w-full resize-none px-3 py-2.5 text-[16px] leading-relaxed text-foreground/90 placeholder:text-foreground/45 sm:text-[13px]'
          )}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            size="sm"
            ariaLabel="Todo kind"
            options={INTAKE_KIND_OPTIONS}
            value={inputKind}
            onChange={setInputKind}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDetailsOpen((v) => !v)}
            disabled={addBusy}
            aria-expanded={detailsOpen}
            className="gap-1 text-xs text-foreground/60"
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 motion-safe:transition-transform motion-safe:duration-150',
                detailsOpen && 'rotate-180'
              )}
              aria-hidden="true"
            />
            Details
          </Button>
          <span className="min-w-0 flex-1" aria-hidden="true" />
          <span className="hidden text-xs text-foreground/45 sm:inline">⌘↩ adds</span>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleAdd()}
            disabled={!inputText.trim() || addBusy}
            // min-h-9 + wider pad = comfortable thumb target on mobile.
            className="min-h-9 px-4 text-xs"
          >
            {addBusy ? 'Adding…' : 'Add'}
          </Button>
        </div>

        {detailsOpen && (
          <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2.5">
            <DetailsFields
              idPrefix="intake"
              draft={detailsDraft}
              onChange={setDetailsDraft}
              workspaces={workspaceOptions}
              disabled={addBusy}
            />
          </div>
        )}

        {addError && <p className="text-xs leading-snug text-rose-300">{addError}</p>}
      </div>

      {/* ── Tag filter (from existing tags) ──────────────────────────────────── */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            aria-pressed={tagFilter == null}
            className={cn(
              'min-h-7 rounded-full border px-2.5 text-xs font-medium motion-safe:transition-colors motion-safe:duration-150',
              tagFilter == null
                ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                : 'border-white/[0.08] bg-white/[0.04] text-foreground/65 hover:text-foreground/85'
            )}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter((cur) => (cur === tag ? null : tag))}
              aria-pressed={tagFilter === tag}
              className={cn(
                'min-h-7 rounded-full border px-2.5 text-xs font-medium motion-safe:transition-colors motion-safe:duration-150',
                tagFilter === tag
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                  : 'border-white/[0.08] bg-white/[0.04] text-foreground/65 hover:text-foreground/85'
              )}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {/* ── List ─────────────────────────────────────────────────────────────── */}
      {loadState === 'loading' && <LoadingState />}

      {loadState === 'error' && (
        <ErrorState
          message={loadError ?? 'Failed to load todos.'}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()} className="text-xs mt-1">
              Retry
            </Button>
          }
        />
      )}

      {loadState === 'idle' && todos.length === 0 && (
        <EmptyState
          label="No todos yet — dump a thought above."
        />
      )}

      {/* Tag filter narrowed everything out — say so instead of a blank list. */}
      {loadState === 'idle' && todos.length > 0 && visibleCount === 0 && tagFilter != null && (
        <EmptyState label={`No todos tagged #${tagFilter}.`} />
      )}

      {loadState === 'idle' && visibleCount > 0 && (
        <div className="flex flex-col gap-3">
          {openTodos.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Open and assigned todos">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground/60">Open & assigned</span>
                <CountBadge count={openTodos.length} />
              </div>
              {renderRows(openTodos, 'Open and assigned todos')}
            </section>
          )}

          {promotedTodos.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Promoted todos">
              <GroupDisclosure
                label="Promoted"
                count={promotedTodos.length}
                open={showPromoted}
                onToggle={() => setShowPromoted((v) => !v)}
              />
              {showPromoted && renderRows(promotedTodos, 'Promoted todos')}
            </section>
          )}

          {doneTodos.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Done todos">
              <GroupDisclosure
                label="Done"
                count={doneTodos.length}
                open={showDone}
                onToggle={() => setShowDone((v) => !v)}
              />
              {showDone && renderRows(doneTodos, 'Done todos')}
            </section>
          )}
        </div>
      )}
    </PanelShell>
  );
}
