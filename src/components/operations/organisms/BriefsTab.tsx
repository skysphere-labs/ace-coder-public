import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, FileText, Sparkles } from 'lucide-react';
import type {
  OpsBrief,
  OpsBriefLens,
  OpsBriefSchedule,
  OpsBriefScheduleSlot,
  OpsRefreshSource,
  OpsSourceState,
  OpsSourceStatus,
} from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Spinner } from '../../ui/spinner';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { Chip, type ChipTone } from '../atoms/Chip';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { LoadingState } from '../atoms/states';
import { rollupSeverity, type Severity } from '../severity';
import { BriefPanel, BRIEF_LENSES, lensForTime, formatBriefStamp } from './BriefPanel';

// Human label for a slot lens (slots arrive as plain strings).
function lensLabel(lens: string): string {
  return BRIEF_LENSES.find((l) => l.id === lens)?.label ?? lens;
}

// ─── Source freshness strip ──────────────────────────────────────────────────
// One compact cell per source CLASS (feeds, repos, accounts, …) so Chief sees
// at a glance what the next brief will draw from. Aggregation is honest:
// worst status across the class wins; the newest lastSuccess is shown.
const SOURCE_CLASS_LABELS: Record<string, string> = {
  feeds: 'Feeds',
  repos: 'Repos',
  accounts: 'Social',
  changelogs: 'Vendors',
  news: 'News',
  finance: 'Finance',
};

const SOURCE_STATUS_RANK: Record<OpsSourceStatus, number> = {
  ok: 0,
  unavailable: 1,
  'auth-needed': 2,
  error: 3,
};

const SOURCE_STATUS_LABEL: Record<OpsSourceStatus, string> = {
  ok: 'ok',
  error: 'error',
  'auth-needed': 'auth needed',
  unavailable: 'unavailable',
};

// Severity for the Sources DisclosureRow — worst class wins, so a degraded
// class auto-expands the strip (C1) while an all-green strip stays collapsed.
const SOURCE_STATUS_SEVERITY: Record<OpsSourceStatus, Severity> = {
  ok: 'green',
  unavailable: 'yellow',
  'auth-needed': 'yellow',
  error: 'red',
};

type SourceClassCell = {
  cls: string;
  label: string;
  status: OpsSourceStatus;
  lastSuccess: string | null;
  error: string | null;
};

function summarizeByClass(sources: OpsRefreshSource[]): SourceClassCell[] {
  const byClass = new Map<string, OpsRefreshSource[]>();
  for (const src of sources) {
    const list = byClass.get(src.class) ?? [];
    list.push(src);
    byClass.set(src.class, list);
  }
  return Array.from(byClass.entries()).map(([cls, members]) => {
    let status: OpsSourceStatus = 'ok';
    let lastSuccess: string | null = null;
    let error: string | null = null;
    for (const member of members) {
      if (SOURCE_STATUS_RANK[member.status] > SOURCE_STATUS_RANK[status]) {
        status = member.status;
        error = member.error;
      }
      if (member.lastSuccess && (!lastSuccess || member.lastSuccess > lastSuccess)) {
        lastSuccess = member.lastSuccess;
      }
    }
    return { cls, label: SOURCE_CLASS_LABELS[cls] ?? cls, status, lastSuccess, error };
  });
}

// Local wall-clock for a slot's configured hour/minute ("7:30 AM").
function slotClock(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Next-run stamp: "today 1:00 PM" / "Fri 7:30 AM" — always labeled, never a
// bare clock (formatRelativeTime only handles past timestamps).
function nextRunStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `today ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// ─── Slot card ───────────────────────────────────────────────────────────────
// One scheduled brief slot: local slot time, next run (prominent), and the
// last delivery status — errors show the actual message, never a bare badge.
// "Last generated <relative>" lives in the next-run tooltip (C4); no raw ISO
// hover titles.
function SlotCard({ slot }: { slot: OpsBriefScheduleSlot }) {
  const lensMeta = BRIEF_LENSES.find((l) => l.id === slot.lens);
  const Icon = lensMeta?.Icon ?? CalendarClock;
  const statusTone: ChipTone =
    slot.lastStatus === 'ok' ? 'emerald' : slot.lastStatus === 'error' ? 'rose' : 'neutral';
  const statusLabel =
    slot.lastStatus === 'ok' ? 'delivered' : slot.lastStatus === 'error' ? 'error' : 'not yet run';

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/60" aria-hidden="true" />
          <span className="text-[13px] font-medium text-foreground/90">{lensLabel(slot.lens)}</span>
          <span className="text-[13px] tabular-nums text-foreground/85">
            {slotClock(slot.hour, slot.minute)}
          </span>
        </div>
        <Chip tone={statusTone}>{statusLabel}</Chip>
      </div>
      <p
        className="text-xs text-foreground/60"
        title={`Last generated ${
          slot.lastDeliveredAt
            ? formatRelativeTime(slot.lastDeliveredAt) || formatBriefStamp(slot.lastDeliveredAt)
            : 'never'
        }`}
      >
        Next run {nextRunStamp(slot.nextRunAt)}
      </p>
      {slot.lastStatus === 'error' && slot.lastError && (
        <p className="text-xs text-rose-200 leading-snug">{slot.lastError}</p>
      )}
    </div>
  );
}

// ─── BriefsTab ───────────────────────────────────────────────────────────────
// The Briefs tab (spec G): slot status strip (G3) + manual "Generate brief
// now" (G5) + the restyled Rook Brief with per-item actions (G6). The tab owns
// the lens so Generate targets whatever Chief is reading, and feeds the
// generated brief back into BriefPanel via `latest`. Schedule data is honest —
// when briefSchedule is unavailable (standalone dev / remote) the strip says
// so instead of faking slot rows. Designed to mount inside the screen's
// ScrollPanel (it does not own scroll).
export function BriefsTab({ slice }: { slice: SliceState<OpsBrief | null> }) {
  const [lens, setLens] = useState<OpsBriefLens>(() => lensForTime(new Date()));
  const [latest, setLatest] = useState<{ lens: OpsBriefLens; brief: OpsBrief } | null>(null);
  const [schedule, setSchedule] = useState<OpsBriefSchedule | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [todayPath, setTodayPath] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warn' | 'error' } | null>(null);

  const loadSchedule = useCallback(async () => {
    try {
      const result = await aceApi.ops.briefSchedule();
      setSchedule(result);
      setTodayPath(result.todayPath ?? null);
      setScheduleError(null);
    } catch (err) {
      setSchedule(null);
      setScheduleError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  // ── Source freshness strip (S3) — same self-fetch shape as the schedule.
  // Honest degrade: when sourceState is unavailable the strip simply does not
  // render (no fabricated per-class rows).
  const [sourceState, setSourceState] = useState<OpsSourceState | null>(null);

  const loadSourceState = useCallback(async () => {
    try {
      const result = await aceApi.ops.sourceState();
      setSourceState(result);
    } catch {
      setSourceState(null);
    }
  }, []);

  useEffect(() => {
    void loadSourceState();
  }, [loadSourceState]);

  // Push events: a delivered brief refreshes the slot ledger AND becomes the
  // displayed brief for its lens; a finished refresh run updates the strip.
  useEffect(() => {
    const unsubscribeBrief = aceApi.ops.onBriefDelivered((payload) => {
      setLatest({ lens: payload.lens, brief: payload.brief });
      if (payload.todayPath !== undefined) setTodayPath(payload.todayPath);
      void loadSchedule();
    });
    const unsubscribeIntel = aceApi.ops.onIntelRefreshed(() => {
      void loadSourceState();
    });
    return () => {
      unsubscribeBrief();
      unsubscribeIntel();
    };
  }, [loadSchedule, loadSourceState]);

  const sourceCells = useMemo(
    () => (sourceState ? summarizeByClass(sourceState.sources) : []),
    [sourceState]
  );
  // Collapsed-row rollup (C1/C4): worst severity auto-expands; the one-line
  // summary carries the only count, so nothing is duplicated.
  const sourceSeverity = rollupSeverity(
    sourceCells.map((cell) => SOURCE_STATUS_SEVERITY[cell.status])
  );
  const sourceOkCount = sourceCells.filter((cell) => cell.status === 'ok').length;
  const sourceWarnCount = sourceCells.length - sourceOkCount;

  async function handleGenerate() {
    setGenerating(true);
    setNotice(null);
    try {
      const result = await aceApi.ops.briefGenerate({ lens });
      if (result.brief) {
        // Refresh the displayed brief with the freshly generated one.
        setLatest({ lens: result.lens, brief: result.brief });
      }
      if (result.todayPath !== undefined) setTodayPath(result.todayPath);
      if (result.todayError) {
        setNotice({ text: `today.md update failed — ${result.todayError}`, tone: 'error' });
      } else if (result.delivered) {
        setNotice({ text: `${lensLabel(result.lens)} brief generated · today.md updated`, tone: 'ok' });
      } else if (result.skipped) {
        setNotice({ text: `Skipped — ${result.reason ?? 'no reason given'} · today.md updated`, tone: 'warn' });
      } else {
        setNotice({ text: result.reason ?? 'Brief was not delivered', tone: 'warn' });
      }
      // The manual run lands in the slot ledger — refresh last/next columns.
      await loadSchedule();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Generate failed', tone: 'error' });
    } finally {
      setGenerating(false);
    }
  }

  const scheduleLoading = schedule === null && scheduleError === null;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ── Slot status strip (G3) + Generate brief now (G5) ─────────────── */}
      <PanelShell>
        <SectionHeader
          title="Brief schedule"
          icon={CalendarClock}
          tone="violet"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleGenerate()}
              disabled={generating}
              title={`Generate the ${lensLabel(lens)} brief immediately`}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              {generating ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : (
                <Sparkles className="h-3 w-3" aria-hidden="true" />
              )}
              {generating ? 'Generating…' : 'Generate brief now'}
            </Button>
          }
        />

        {notice && (
          <p
            className={cn(
              'text-xs leading-snug',
              notice.tone === 'ok'
                ? 'text-emerald-200'
                : notice.tone === 'warn'
                  ? 'text-amber-200'
                  : 'text-rose-200'
            )}
          >
            {notice.text}
          </p>
        )}

        {todayPath && (
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-foreground/60" aria-hidden="true" />
            <span className="shrink-0 text-xs font-medium text-foreground/75">Today pull target</span>
            <code className="min-w-0 truncate text-xs text-foreground/60" title={todayPath}>
              {todayPath}
            </code>
          </div>
        )}

        {/* ── Source freshness — what the next brief draws from. Collapsed to
            one summary line by default (C1); a degraded class auto-expands the
            per-class cells. ──────────────────────────────────────────────── */}
        {sourceCells.length > 0 && (
          <DisclosureRow
            label="Sources"
            severity={sourceSeverity}
            summary={
              sourceWarnCount > 0
                ? `${sourceOkCount} ok · ${sourceWarnCount} warn`
                : `${sourceOkCount} ok`
            }
            storageKey="briefs.sources"
          >
            <div className="flex flex-wrap gap-1.5" aria-label="Source freshness by class">
              {sourceCells.map((cell) => (
                <span
                  key={cell.cls}
                  className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1"
                  title={cell.error ?? undefined}
                >
                  <span className="text-xs font-medium text-foreground/75">{cell.label}</span>
                  <Chip tone={cell.status === 'ok' ? 'emerald' : 'amber'}>
                    {SOURCE_STATUS_LABEL[cell.status]}
                  </Chip>
                  {cell.lastSuccess ? (
                    <FreshnessLabel timestamp={cell.lastSuccess} />
                  ) : (
                    <span className="text-xs text-foreground/60" title="no successful pull yet">
                      never
                    </span>
                  )}
                </span>
              ))}
            </div>
          </DisclosureRow>
        )}

        {scheduleLoading && <LoadingState label="Loading schedule" />}

        {scheduleError !== null && (
          // Honest degrade: no fake slot rows when the schedule IPC is absent.
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
            <p className="text-[13px] text-amber-200">Schedule status unavailable</p>
            <p className="text-xs text-foreground/60 leading-snug">{scheduleError}</p>
          </div>
        )}

        {schedule !== null && schedule.slots.length === 0 && (
          <p className="text-xs text-foreground/60">No brief slots configured.</p>
        )}

        {schedule !== null && schedule.slots.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3" role="list" aria-label="Brief slots">
            {schedule.slots.map((slot) => (
              <div key={`${slot.lens}:${slot.hour}:${slot.minute}`} role="listitem">
                <SlotCard slot={slot} />
              </div>
            ))}
          </div>
        )}
      </PanelShell>

      {/* ── Restyled Rook Brief (controlled lens + freshly generated brief) ─ */}
      <BriefPanel slice={slice} lens={lens} onLensChange={setLens} latest={latest} />
    </div>
  );
}
