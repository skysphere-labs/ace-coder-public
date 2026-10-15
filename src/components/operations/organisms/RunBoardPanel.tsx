import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  Folder,
  Repeat,
  ShieldCheck,
} from 'lucide-react';
import { aceApi } from '../../../lib/ace-api';
import type { FollowUpDigestItem, RunLedgerBoard, RunLedgerCard } from '../../../lib/types';
import { cn } from '../../../lib/utils';
import { useApp } from '../../../store';
import { Chip, type ChipTone } from '../atoms/Chip';
import { LiveDot } from '../../ui/deck/LiveDot';
import { deriveCardStatus, fmtAge, splitArchived } from '../run-board-derive';
import { EvidenceDrawer } from './EvidenceDrawer';

// Last path/id segment of a workspace id, for a compact card label.
function workspaceLabel(workspaceId: string): string {
  const parts = workspaceId.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : workspaceId;
}

// RunBoardPanel — the run-ledger board, re-homed where the Mission Board lived
// (Operations → Ops). A READ-ONLY watcher over the event ledger: a pure
// projection (aceApi.missions.runBoard) that NEVER dispatches, gates, or
// mutates. Cards auto-move through the lifecycle columns. JIRA-style:
// per-project filter, full-face ticket cards (title/agent/status/age), and a
// click-through EvidenceDrawer showing the FULL ticket (goal, acceptance,
// worker links, PR, transition history, telemetry, live log tail). Done runs
// older than 24h collapse into an Archived strip under the columns.
//
// The board projection is fetched by useRunLedgerBoard (owned by OpsTab) and
// passed in, so the Board tab reads the ledger ONCE for both this panel and the
// attention strip above it — this component is a pure presentation of that
// projection (it dispatches nothing and holds no fetch of its own).

type Stage = RunLedgerCard['stage'];

const COLUMNS: { key: Stage; label: string; hint: string; dot: string; accent: string }[] = [
  { key: 'todo', label: 'To Do', hint: 'queued', dot: 'bg-white/40', accent: 'text-white/55' },
  { key: 'in_progress', label: 'In Progress', hint: 'worker running', dot: 'bg-sky-400', accent: 'text-sky-300/80' },
  { key: 'ready_to_review', label: 'Ready to Review', hint: 'validator phase', dot: 'bg-amber-400', accent: 'text-amber-300/80' },
  { key: 'done', label: 'Done', hint: 'merged', dot: 'bg-emerald-400', accent: 'text-emerald-300/80' },
  { key: 'blocked', label: 'Blocked', hint: 'needs Chief', dot: 'bg-rose-400', accent: 'text-rose-300/80' },
];

// Above this many cards a column drops the spring layout/magic-move animation:
// with ~100 layout-tracked cards framer-motion's shared LayoutGroup measurement
// becomes the bottleneck, and a busy board needs legibility over motion.
const MOTION_CARD_CAP = 30;

// ─── formatters ──────────────────────────────────────────────────────────────
function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
function fmtTokens(n: number): string {
  if (!n) return '';
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
function outcomeTone(outcome: string | null): ChipTone {
  if (!outcome) return 'neutral';
  const o = outcome.toUpperCase();
  if (o === 'PASS' || o === 'DONE') return 'emerald';
  if (o === 'BLOCK' || o.startsWith('BLOCKED') || o === 'FAIL') return 'rose';
  if (o === 'REQUEST-CHANGES') return 'amber';
  return 'neutral';
}
// Autonomy-loop chip tone by the latest settle: converged=emerald,
// blocked/no-progress=rose, cap-hit=amber, in-flight (continue/none)=sky.
function loopTone(terminal: string | null): ChipTone {
  if (terminal === 'converged') return 'emerald';
  if (terminal === 'blocked' || terminal === 'no-progress') return 'rose';
  if (terminal === 'cap-hit') return 'amber';
  return 'sky';
}
function autoshipTone(status: string | null): ChipTone {
  if (status === 'ready_to_autoship' || status === 'shipped') return 'emerald';
  if (status === 'autoship_merging' || status === 'autoship_building') return 'sky';
  if (status === 'parked_owner_review') return 'amber';
  return 'neutral';
}
function followUpTone(state: string | null): ChipTone {
  if (state === 'merge-ready' || state === 'shipped') return 'emerald';
  if (state === 'ready-to-review' || state === 'PR-checks-running' || state === 'validating') return 'sky';
  if (state === 'fixback-needed') return 'amber';
  if (state === 'blocked') return 'rose';
  return 'neutral';
}

// ─── copy-to-clipboard chip ──────────────────────────────────────────────────
function CopyValue({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  if (!value) return null;
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(value);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}`}
      className="group/cp inline-flex max-w-full items-center gap-1 rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/55 transition-colors hover:border-white/15 hover:text-white/80"
    >
      <span className="text-white/30">{label}</span>
      <span className="truncate">{value}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-emerald-300" /> : <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/cp:opacity-60" />}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[9.5px] font-semibold uppercase tracking-wider text-white/30">{title}</span>
      {children}
    </div>
  );
}

function FollowUpDigestStrip({ items }: { items: FollowUpDigestItem[] }) {
  if (!items.length) return null;
  return (
    <div className="mx-4 mb-2 flex shrink-0 flex-col gap-1.5 border-y border-white/[0.06] bg-white/[0.018] py-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11px] font-semibold text-white/70">Follow-ups</span>
        <span className="rounded bg-white/[0.06] px-1.5 text-[10px] text-white/45">{items.length}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {items.slice(0, 6).map((item) => (
          <div key={item.id} className="flex min-w-[260px] max-w-[320px] flex-col gap-1 rounded-md border border-white/[0.07] bg-[#101014] px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Chip tone={followUpTone(item.state)}>{item.state}</Chip>
              <span className="ml-auto truncate font-mono text-[9.5px] text-white/35">
                {item.prNumber != null ? `PR #${item.prNumber}` : item.taskId || item.streamId || item.runId || item.id}
              </span>
            </div>
            <p className="line-clamp-2 text-[11px] leading-snug text-white/70">{item.nextAction}</p>
            <div className="flex items-center gap-2 text-[10px] text-white/35">
              {item.owner ? <span>{item.owner}</span> : null}
              {item.stopCondition ? <span className="truncate">stop: {item.stopCondition}</span> : null}
              {item.prUrl ? (
                <button
                  type="button"
                  onClick={() => { try { void aceApi.workspaces.openExternal(item.prUrl as string); } catch { /* non-fatal */ } }}
                  className="ml-auto inline-flex items-center gap-1 text-sky-200/80 hover:text-sky-100"
                  title={item.prUrl}
                >
                  <ExternalLink className="h-3 w-3" />
                  evidence
                </button>
              ) : item.evidenceLink ? (
                <span className="ml-auto truncate font-mono text-[9.5px] text-white/30">{item.evidenceLink}</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── the ticket card ─────────────────────────────────────────────────────────
// A full-face summary (id, agent, title, workspace, chips, one-line status,
// age); clicking anywhere opens the detail drawer. `animate` gates the spring
// layout/magic-move — dropped on crowded columns (MOTION_CARD_CAP) for perf.
function TicketCard({
  card,
  onSelect,
  animate,
}: {
  card: RunLedgerCard;
  onSelect: (id: string) => void;
  animate: boolean;
}) {
  const d = card.detail;
  const tel = card.telemetry;
  const validating = d.validator.outcome == null && card.stage === 'in_progress' && (card.lastEventType || '').startsWith('validator');
  const age = fmtAge(card.lastTs);

  return (
    <motion.div
      layout={animate}
      layoutId={animate ? card.id : undefined}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.6 }}
      // shrink-0 is LOAD-BEARING: a flex item with overflow-hidden has an
      // automatic min-size of 0, so without it a crowded column crushes every
      // card to a few-pixel bar (blank "skeleton" rows) instead of scrolling.
      className="group shrink-0 overflow-hidden rounded-lg border border-white/[0.07] bg-gradient-to-b from-white/[0.045] to-white/[0.012] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_4px_12px_-8px_rgba(0,0,0,0.7)] backdrop-blur-sm transition-colors hover:border-white/15"
    >
      {/* the whole card face is the click target — opens the detail drawer */}
      <button
        type="button"
        onClick={() => onSelect(card.id)}
        className="flex w-full flex-col gap-1.5 px-2.5 py-2 text-left"
      >
        <div className="flex items-center gap-1.5">
          <ChevronRight className="h-3 w-3 shrink-0 text-white/30 transition-colors group-hover:text-white/55" />
          {card.stage === 'in_progress' ? <LiveDot className="shrink-0" /> : null}
          <span className="truncate font-mono text-[10.5px] text-white/55">{card.id}</span>
          {card.agentId ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[9.5px] font-medium text-white/55">
              <Bot className="h-2.5 w-2.5" />
              {card.agentId}
            </span>
          ) : null}
          {age ? <span className={cn('font-mono text-[9.5px] text-white/35', !card.agentId && 'ml-auto')}>{age}</span> : null}
        </div>
        <p className="line-clamp-2 pl-[18px] text-[12.5px] font-medium leading-snug text-white/85">{card.name}</p>
        {card.workspaceId ? (
          <div className="flex items-center gap-1 pl-[18px] text-[10px] text-white/40" title={card.workspaceId}>
            <Folder className="h-2.5 w-2.5 shrink-0 text-white/30" />
            <span className="truncate font-mono">{workspaceLabel(card.workspaceId)}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1 pl-[18px]">
          {validating ? <Chip tone="amber">validating…</Chip> : null}
          {card.loop ? (
            <Chip tone={loopTone(card.loop.terminal)}>
              <Repeat className="h-2.5 w-2.5" />
              loop {card.loop.iteration}/{card.loop.maxIterations}
              {card.loop.terminal && card.loop.terminal !== 'continue' ? ` · ${card.loop.terminal}` : ''}
            </Chip>
          ) : null}
          {card.validationStatus ? <Chip tone={outcomeTone(card.validationStatus)}><ShieldCheck className="h-2.5 w-2.5" />{card.validationStatus}</Chip> : null}
          {card.autoshipStatus ? <Chip tone={autoshipTone(card.autoshipStatus)}>{card.autoshipStatus}</Chip> : null}
          {card.workerOutcome ? <Chip tone={outcomeTone(card.workerOutcome)}>{card.workerOutcome}</Chip> : null}
          {card.prStatus ? <Chip tone="sky">pr {card.prStatus}</Chip> : null}
          {tel && (tel.score != null || tel.tokens || tel.durationMs) ? (
            <span className="ml-auto flex items-center gap-2 font-mono text-[9.5px] text-white/35">
              {tel.score != null ? <span>★{tel.score}</span> : null}
              {tel.durationMs ? <span>{fmtDuration(tel.durationMs)}</span> : null}
              {tel.tokens ? <span>{fmtTokens(tel.tokens)}t</span> : null}
            </span>
          ) : null}
        </div>
        {/* stage-appropriate one-line status — always on the card face */}
        <p className="line-clamp-1 pl-[18px] text-[10.5px] leading-snug text-white/45">
          <span className="text-white/65">{deriveCardStatus(card)}</span>
        </p>
      </button>
    </motion.div>
  );
}

// ─── drawer internals ────────────────────────────────────────────────────────
// On-demand log tail for the drawer: reads the worker stream's live screen
// (aceApi.streams.readScreen) when the drawer opens and again on each board
// refresh (refreshKey), so the tail follows the run. READ-only — never sends
// input. Renders "no live stream" when the run has no linked stream (yet).
function LogTail({ streamId, refreshKey }: { streamId: string | null; refreshKey: unknown }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!streamId) return;
    let alive = true;
    aceApi.streams
      .readScreen(streamId, 80)
      .then((r) => {
        if (!alive) return;
        setText(r.text || '');
        setFailed(false);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [streamId, refreshKey]);
  if (!streamId || failed) return <p className="text-[10.5px] text-white/35">no live stream</p>;
  if (text == null) return <p className="text-[10.5px] text-white/35">reading stream…</p>;
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return <p className="text-[10.5px] text-white/35">stream is quiet</p>;
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre rounded-md border border-white/[0.06] bg-black/40 p-2 font-mono text-[9.5px] leading-snug text-white/60">
      {trimmed}
    </pre>
  );
}

// The FULL ticket, drawer-side (C2: raw ids, timestamps, and command output
// live here, keeping the card faces calm). Pure presentation of the card's
// projection detail — renders data, never mutates spine state.
function TicketDrawerBody({ card, board }: { card: RunLedgerCard; board: RunLedgerBoard | null }) {
  const app = useApp();
  const d = card.detail;
  const tel = card.telemetry;
  return (
    <>
      {/* about */}
      {(d.description || d.context) && (
        <Section title="About">
          {d.description ? <p className="text-[11.5px] leading-snug text-white/70">{d.description}</p> : null}
          {d.context ? <p className="text-[10.5px] leading-snug text-white/45">{d.context}</p> : null}
        </Section>
      )}

      {/* agent + worker link */}
      <Section title="Worker">
        <div className="flex flex-wrap items-center gap-1.5">
          {card.agentId ? (
            <span className="inline-flex items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-white/60">
              <Bot className="h-2.5 w-2.5" />
              {card.agentId}
            </span>
          ) : null}
          {card.branch ? (
            <span className="inline-flex items-center gap-1 rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/55">
              <GitBranch className="h-2.5 w-2.5" />
              {card.branch}
            </span>
          ) : null}
          <CopyValue label="task" value={d.worker.taskId} />
          <CopyValue label="stream" value={d.worker.streamId} />
          {d.worker.worktreePath ? <CopyValue label="wt" value={d.worker.worktreePath} /> : null}
          {card.workspaceId ? (
            <button
              type="button"
              onClick={() => { try { app.openWorkspace(card.workspaceId as string); } catch { /* non-fatal */ } }}
              className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-sky-200 transition-colors hover:bg-sky-500/[0.16]"
            >
              <Folder className="h-2.5 w-2.5" />
              Open project
            </button>
          ) : null}
        </div>
      </Section>

      {/* acceptance + constraints */}
      {(d.acceptance.length > 0 || d.constraints.length > 0) && (
        <Section title="Criteria">
          {d.acceptance.map((a, i) => (
            <div key={`a${i}`} className="flex items-start gap-1.5 text-[10.5px] text-white/55">
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400/70" />
              <span>{a}</span>
            </div>
          ))}
          {d.constraints.map((c, i) => (
            <div key={`c${i}`} className="flex items-start gap-1.5 text-[10.5px] text-white/40">
              <span className="mt-0.5 h-3 w-3 shrink-0 text-center text-amber-400/60">!</span>
              <span>{c}</span>
            </div>
          ))}
        </Section>
      )}

      {/* validator result */}
      {(d.validator.outcome || d.validator.evidence) && (
        <Section title="Validation">
          <div className="flex flex-wrap items-center gap-1.5">
            {d.validator.outcome ? <Chip tone={outcomeTone(d.validator.outcome)}><ShieldCheck className="h-2.5 w-2.5" />{d.validator.outcome}</Chip> : null}
            {d.validator.computerUseRequired ? <Chip tone="amber">computer-use</Chip> : null}
            <CopyValue label="stream" value={d.validator.streamId} />
          </div>
          {d.validator.evidence ? <p className="text-[10px] leading-snug text-white/40">{d.validator.evidence}</p> : null}
        </Section>
      )}

      {/* PR / gate / next */}
      {(d.pr.number != null || d.gate || d.decision.next || d.autoship) && (
        <Section title="Gate">
          <div className="flex flex-wrap items-center gap-1.5">
            {d.pr.url ? (
              <button
                type="button"
                onClick={() => { try { void aceApi.workspaces.openExternal(d.pr.url as string); } catch { /* non-fatal */ } }}
                title={d.pr.url}
                className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/[0.1] px-1.5 py-0.5 text-[10px] font-medium text-sky-200 transition-colors hover:bg-sky-500/[0.2]"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                PR #{d.pr.number ?? ''}
              </button>
            ) : d.pr.number != null ? <Chip tone="neutral">PR #{d.pr.number}</Chip> : null}
            {d.pr.checkState ? <Chip tone={d.pr.checkState === 'success' ? 'emerald' : 'neutral'}>{d.pr.checkState}</Chip> : null}
            {d.pr.mergeable ? <Chip tone={d.pr.mergeable === 'MERGEABLE' ? 'emerald' : 'amber'}>{d.pr.mergeable}</Chip> : null}
            {d.gate ? <Chip tone={d.gate.ok ? 'emerald' : 'amber'}>gate {d.gate.ok ? 'ok' : 'hold'}</Chip> : null}
            {d.autoship ? <Chip tone={autoshipTone(d.autoship.status)}>autoship {d.autoship.status || 'off'}</Chip> : null}
            {d.merge.merged ? <Chip tone="emerald">merged</Chip> : null}
          </div>
          {d.pr.changedFiles.length > 0 ? (
            <p className="font-mono text-[9.5px] text-white/35">{d.pr.changedFiles.length} file{d.pr.changedFiles.length === 1 ? '' : 's'} changed</p>
          ) : null}
          {d.decision.next ? (
            <p className="text-[10px] text-white/40">
              next: <span className="text-white/60">{d.decision.next}</span>
              {d.decision.reason ? <span className="text-white/30"> — {d.decision.reason}</span> : null}
            </p>
          ) : null}
          {d.autoship?.reason ? (
            <p className="text-[10px] text-white/40">
              autoship: <span className="text-white/60">{d.autoship.reason}</span>
            </p>
          ) : null}
        </Section>
      )}

      {/* telemetry the agent wrote on finish */}
      {tel ? (
        <Section title="Telemetry">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/45">
            {tel.score != null ? <span>score ★{tel.score}</span> : null}
            {tel.durationMs ? <span>{fmtDuration(tel.durationMs)}</span> : null}
            {tel.tokens ? <span>{fmtTokens(tel.tokens)} tokens</span> : null}
            {tel.commands ? <span>{tel.commands} commands</span> : null}
            {tel.reports ? <span>{tel.reports} report{tel.reports === 1 ? '' : 's'}</span> : null}
            {tel.rubric ? <span className="text-white/35">rubric: {tel.rubric}</span> : null}
          </div>
        </Section>
      ) : null}

      {/* lifecycle transition history (capped fold from the run's ledger slice) */}
      {(d.history?.length ?? 0) > 0 ? (
        <Section title="History">
          <div className="flex flex-col gap-0.5">
            {d.history.map((h, i) => (
              <div key={`${h.type}-${i}`} className="flex items-baseline gap-2 font-mono text-[10px]">
                <span className="text-white/55">{h.type}</span>
                <span
                  className="ml-auto shrink-0 text-white/30"
                  title={typeof h.ts === 'number' ? new Date(h.ts).toLocaleString() : undefined}
                >
                  {typeof h.ts === 'number' ? fmtAge(h.ts) ?? '' : ''}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* live log tail — lazy read of the worker stream's screen */}
      <Section title="Log tail">
        <LogTail streamId={d.worker.streamId} refreshKey={board} />
      </Section>
    </>
  );
}

// ─── the board ───────────────────────────────────────────────────────────────
export function RunBoardPanel({
  board,
  error,
}: {
  board: RunLedgerBoard | null;
  error: string | null;
}) {
  const [project, setProject] = useState<string>('all');
  const [menuOpen, setMenuOpen] = useState(false);
  // The clicked card, by id — re-resolved from every fresh board projection so
  // the open drawer keeps updating as the run advances (read-only underneath).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const cards = useMemo(() => board?.cards ?? [], [board]);
  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) if (c.workspaceId) set.add(c.workspaceId);
    return Array.from(set).sort();
  }, [cards]);

  const filtered = useMemo(
    () => (project === 'all' ? cards : cards.filter((c) => c.workspaceId === project)),
    [cards, project]
  );
  const followUps = useMemo(() => {
    const items = board?.followUps?.items ?? [];
    return project === 'all' ? items : items.filter((item) => item.workspaceId === project);
  }, [board, project]);
  // Archived = done runs whose last ledger event is older than the cutoff.
  // Derived from `filtered`, so the per-project selector governs it for free.
  // The clock read lives inside splitArchived (like fmtAge) and the memo
  // recomputes on every fresh board projection, so the cutoff tracks real time
  // without an impure read in the render path.
  const { active, archived } = useMemo(() => splitArchived(filtered), [filtered]);
  const byStage = (stage: Stage) => active.filter((c) => c.stage === stage);
  const counts = board?.counts;
  const selected = useMemo(
    () => (selectedId ? cards.find((c) => c.id === selectedId) ?? null : null),
    [cards, selectedId]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* board header — title, counts, per-project filter */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-white/80">Run Board</h2>
          <span className="text-[10.5px] text-white/30">run-ledger · watcher</span>
        </div>
        {counts ? (
          <div className="flex items-center gap-2 text-[10.5px] text-white/40">
            <span>{counts.total} total</span>
            {counts.inProgress ? <span className="text-sky-400/70">{counts.inProgress} active</span> : null}
            {counts.readyToReview ? <span className="text-amber-400/70">{counts.readyToReview} review</span> : null}
            {counts.done ? <span className="text-emerald-400/70">{counts.done} done</span> : null}
            {counts.blocked ? <span className="text-rose-400/70">{counts.blocked} blocked</span> : null}
          </div>
        ) : null}

        {/* per-project filter — top-right dropdown (pick one project) */}
        {projects.length > 0 ? (
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-white/70 transition-colors hover:border-white/15"
            >
              <Folder className="h-3 w-3 text-white/40" />
              <span className="max-w-[160px] truncate">{project === 'all' ? 'All projects' : project}</span>
              <ChevronDown className={cn('h-3 w-3 text-white/40 transition-transform', menuOpen && 'rotate-180')} />
            </button>
            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-50 mt-1 max-h-72 w-60 overflow-y-auto rounded-md border border-white/10 bg-[#141418] p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.8)]">
                  <button
                    type="button"
                    onClick={() => { setProject('all'); setMenuOpen(false); }}
                    className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-white/[0.06]', project === 'all' ? 'text-white/90' : 'text-white/55')}
                  >
                    {project === 'all' ? <Check className="h-3 w-3 shrink-0 text-emerald-300" /> : <span className="w-3 shrink-0" />}
                    All projects
                    <span className="ml-auto text-[10px] text-white/30">{cards.length}</span>
                  </button>
                  {projects.map((p) => {
                    const n = cards.filter((c) => c.workspaceId === p).length;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => { setProject(p); setMenuOpen(false); }}
                        title={p}
                        className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]', project === p ? 'text-white/90' : 'text-white/55')}
                      >
                        {project === p ? <Check className="h-3 w-3 shrink-0 text-emerald-300" /> : <span className="w-3 shrink-0" />}
                        <span className="truncate font-mono text-[10.5px]">{p}</span>
                        <span className="ml-auto text-[10px] text-white/30">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <div className="px-4 pb-1 text-[11px] text-rose-300/80">board unavailable: {error}</div> : null}
      <FollowUpDigestStrip items={followUps} />

      {/* columns — horizontal JIRA lanes; the stage bar scrolls horizontally
          and each column body scrolls vertically on its own */}
      <LayoutGroup>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {COLUMNS.map((col) => {
            const colCards = byStage(col.key);
            const animate = colCards.length <= MOTION_CARD_CAP;
            return (
              <section key={col.key} className="flex h-full min-h-0 w-[320px] shrink-0 flex-col rounded-xl border border-white/[0.05] bg-white/[0.015]">
                <div className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-2">
                  <span className={cn('h-2 w-2 rounded-full', col.dot)} />
                  <span className="text-[11.5px] font-semibold text-white/70">{col.label}</span>
                  <span className="rounded bg-white/[0.06] px-1.5 text-[10px] text-white/45">{colCards.length}</span>
                  <span className={cn('ml-auto text-[9.5px]', col.accent)}>{col.hint}</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {colCards.length === 0 ? (
                      <motion.p
                        key="empty"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="px-1 py-6 text-center text-[10.5px] text-white/20"
                      >
                        —
                      </motion.p>
                    ) : (
                      colCards.map((card) => (
                        <TicketCard key={card.id} card={card} onSelect={setSelectedId} animate={animate} />
                      ))
                    )}
                  </AnimatePresence>
                </div>
              </section>
            );
          })}
        </div>
      </LayoutGroup>

      {/* Archived — done runs older than the cutoff, collapsed by default.
          Hidden entirely when nothing qualifies (e.g. no lastTs on the cards). */}
      {archived.length > 0 ? (
        <div className="shrink-0 border-t border-white/[0.06] px-4 py-1.5">
          <button
            type="button"
            onClick={() => setArchivedOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded px-1 py-1 text-[11px] text-white/45 transition-colors hover:text-white/70"
          >
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', archivedOpen && 'rotate-90')} />
            <span className="font-medium">Archived ({archived.length})</span>
            <span className="text-[9.5px] text-white/25">done &gt; 24h</span>
          </button>
          {archivedOpen ? (
            <div className="mt-1 flex max-h-44 flex-col gap-0.5 overflow-y-auto pb-1">
              {archived.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <span className="truncate text-[11px] text-white/60">{c.name}</span>
                  {c.workspaceId ? (
                    <span className="truncate font-mono text-[9.5px] text-white/30">{workspaceLabel(c.workspaceId)}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 font-mono text-[9.5px] text-white/30">{fmtAge(c.lastTs) ?? ''}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* the full-ticket drawer (THE detail surface — EvidenceDrawer, C2) */}
      {selected ? (
        <EvidenceDrawer
          open
          eyebrow="Board card"
          title={selected.name}
          onClose={() => setSelectedId(null)}
        >
          <TicketDrawerBody card={selected} board={board} />
        </EvidenceDrawer>
      ) : null}
    </div>
  );
}
