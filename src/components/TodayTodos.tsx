import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Plus, Sparkles } from 'lucide-react';
import { aceApi, type OpsTodo, type OpsTodoDigest } from '../lib/ace-api';
import { useApp } from '../store';
import { cn, formatRelativeTime } from '../lib/utils';
import { Divider, MobilePressable, SectionLabel } from './ui/mobile';

// The MINIMAL Today todo surface (Slate Ledger) — an Apple Reminders / Notes-style
// glance that takes only a portion at the top of the mobile screen so Chief can
// pick what to do fast. A deliberate counterpart to the dense Operations todo
// panel: ONE slim capture line, the twice-daily synthesizer kept but COLLAPSED
// (tap to expand into bullet points), then each open todo as its own clean bar —
// a tappable circle, the title on one line (NO note bodies), and a quiet due
// date (red when overdue), exactly like macOS Reminders. Capped to a short list;
// everything else (full notes, kinds, tags, lifecycle, edit) stays one tap away
// in the untouched Operations panel. Self-fetches the SAME shared todo backend so
// create/done behave identically to Operations.
const PREVIEW = 5; // at most a handful of open rows on Today — the rest go to Operations.

// dueAt is a date(-time) string. Date-only strings parse as LOCAL midnight so a
// "due today" item never reads as overdue. (Same contract as the Operations panel.)
function parseDue(dueAt: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueAt);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(dueAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isOverdue(dueAt: string): boolean {
  const due = parseDue(dueAt);
  if (!due) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return due.getTime() < startOfToday.getTime();
}

function formatDue(dueAt: string): string {
  const due = parseDue(dueAt);
  if (!due) return '';
  const sameYear = due.getFullYear() === new Date().getFullYear();
  const hasTime = /\d{2}:\d{2}/.test(dueAt) && (due.getHours() !== 0 || due.getMinutes() !== 0);
  return due.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

export function TodayTodos() {
  const { setView } = useApp();
  const [todos, setTodos] = useState<OpsTodo[]>([]);
  const [digest, setDigest] = useState<OpsTodoDigest | null>(null);
  const [draft, setDraft] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // in-flight done guard
  const [synthOpen, setSynthOpen] = useState(false); // synthesizer COLLAPSED by default

  // Self-fetch (no registry slice). A digest failure never blocks the list; a list
  // failure keeps the last-good rows rather than inventing fakes (empty ≠ fake).
  const load = useCallback(async () => {
    try {
      const [list, dg] = await Promise.all([
        aceApi.ops.todos.list(),
        aceApi.ops.todos.digest().catch(() => null),
      ]);
      setTodos(list);
      setDigest(dg);
    } catch {
      /* keep last good list */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = useMemo(
    () => todos.filter((t) => t.status === 'open' || t.status === 'assigned'),
    [todos]
  );
  const preview = open.slice(0, PREVIEW);

  // Synthesizer bullets — goals (outcome restatements, bold) then per-todo
  // suggestions. The ONLY expandable thing on Today, collapsed by default.
  const bullets = useMemo(() => {
    if (!digest) return [] as Array<{ key: string; text: string; strong: boolean }>;
    return [
      ...digest.goals.map((g, i) => ({ key: `g${i}`, text: g.text, strong: true })),
      ...digest.suggestions.map((s) => ({
        key: `s${s.todoId}`,
        text: s.suggestion ? `${s.text} — ${s.suggestion}` : s.text,
        strong: false,
      })),
    ];
  }, [digest]);

  async function add() {
    const text = draft.trim();
    if (!text || addBusy) return;
    setAddBusy(true);
    try {
      await aceApi.ops.todos.create({ text }); // kind defaults to 'dev' (same as Operations)
      setDraft('');
      await load();
    } finally {
      setAddBusy(false);
    }
  }

  // Identical contract to TodosPanel.handleDoneToggle — reopen-aware.
  async function toggleDone(t: OpsTodo) {
    if (busyId) return;
    setBusyId(t.id);
    try {
      await aceApi.ops.todos.update({
        id: t.id,
        patch: { status: t.status === 'done' ? 'open' : 'done' },
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-label="Today's todos">
      {/* Capture: one ruled line, no card chrome — the single amber note on focus. */}
      <div className="flex items-center gap-2.5 border-b border-[var(--m-hairline)] py-2 motion-safe:transition-colors focus-within:border-[var(--m-accent)]">
        <Plus
          className="h-4 w-4 shrink-0 text-[var(--m-text-tertiary)]"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          disabled={addBusy}
          placeholder="Jot a todo…"
          aria-label="New todo"
          className="min-w-0 flex-1 bg-transparent text-[16px] leading-snug text-[var(--m-text)] outline-none placeholder:text-[var(--m-text-tertiary)] disabled:opacity-50 sm:text-[14px]"
        />
      </div>

      {/* Synthesizer — KEPT but collapsed by default; expands into bullet points.
          The one and only disclosure on Today. */}
      {bullets.length > 0 && digest && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setSynthOpen((v) => !v)}
            aria-expanded={synthOpen}
            className="flex w-full items-center gap-1.5 text-[13px] font-medium text-[var(--m-text-secondary)] motion-safe:transition-colors active:text-[var(--m-text)]"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-150',
                synthOpen && 'rotate-90'
              )}
              aria-hidden="true"
            />
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--m-accent)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">
              Synthesis · {formatRelativeTime(digest.generatedAt) || 'just now'}
            </span>
            <span className="mono-data text-[12.5px] text-[var(--m-text-tertiary)]">
              {String(bullets.length).padStart(2, '0')}
            </span>
          </button>
          {synthOpen && (
            <ul className="mt-2 flex flex-col gap-1.5 pl-1.5">
              {bullets.map((b) => (
                <li key={b.key} className="flex gap-2 text-[13.5px] leading-snug">
                  <span className="shrink-0 text-[var(--m-text-tertiary)]" aria-hidden="true">
                    •
                  </span>
                  <span
                    className={cn(
                      'min-w-0',
                      b.strong ? 'font-semibold text-[var(--m-text)]' : 'text-[var(--m-text-secondary)]'
                    )}
                  >
                    {b.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Small open-count line — the TRUE total, never the capped preview. */}
      <SectionLabel className="mt-5" count={open.length}>
        Today
      </SectionLabel>

      {open.length === 0 ? (
        <p className="mt-2 px-1 text-[13.5px] text-[var(--m-text-tertiary)]">
          Nothing to do — jot one above.
        </p>
      ) : (
        <div className="mt-1">
          {preview.map((t, i) => {
            const overdue = t.dueAt ? isOverdue(t.dueAt) : false;
            return (
              <div key={t.id}>
                {/* Apple Reminders / Notes row: circle · title · due date. One bar
                    per task, top-aligned so the circle sits with the title. */}
                <div className="flex items-start gap-3 py-2.5">
                  <MobilePressable
                    onClick={() => void toggleDone(t)}
                    disabled={busyId === t.id}
                    aria-label={`Mark "${t.text}" done`}
                    className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center disabled:opacity-40"
                  >
                    <span className="grid h-[19px] w-[19px] place-items-center rounded-full border border-[var(--m-hairline-strong)] text-[var(--m-text-tertiary)] motion-safe:transition-colors active:border-[var(--m-accent)] active:text-[var(--m-accent)]">
                      <Check className="h-3 w-3 opacity-0" strokeWidth={2.5} aria-hidden="true" />
                    </span>
                  </MobilePressable>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] leading-snug text-[var(--m-text)]">
                      {t.text}
                    </p>
                    {t.dueAt && (
                      <p
                        className={cn(
                          'mt-0.5 text-[13px] leading-snug tabular-nums',
                          overdue ? 'text-rose-400' : 'text-[var(--m-text-tertiary)]'
                        )}
                      >
                        {formatDue(t.dueAt)}
                      </p>
                    )}
                  </div>
                </div>
                {i < preview.length - 1 && <Divider />}
              </div>
            );
          })}

          {/* Overflow footnote — only when there is genuinely more than the cap.
              The single path to the full dense panel; all density lives there. */}
          {open.length > PREVIEW && (
            <div className="flex justify-end pt-2">
              <MobilePressable
                onClick={() => setView('todos')}
                className="text-[12.5px] text-[var(--m-text-tertiary)] motion-safe:transition-colors active:text-[var(--m-text-secondary)]"
              >
                All <span className="mono-data">{open.length}</span> in Todos →
              </MobilePressable>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
