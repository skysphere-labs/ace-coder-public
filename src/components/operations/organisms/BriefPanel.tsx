import { useState, useEffect } from 'react';
import {
  Check,
  Clock3,
  ExternalLink,
  FileText,
  HelpCircle,
  Plus,
  Rocket,
  Sun,
  Sunset,
  Sunrise,
} from 'lucide-react';
import type { OpsBrief, OpsBriefLens } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { aceApi } from '../../../lib/ace-api';
import { useApp } from '../../../store';
import { useWorkspaceCatalog } from '../../../runtime/workspace-registry';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { Eyebrow } from '../atoms/Eyebrow';
import { Chip } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { IntelFreshnessChip } from '../atoms/IntelFreshnessChip';
import { LoadingState, ErrorState, EmptyState } from '../atoms/states';
import { SegmentedControl, type SegmentedOption } from '../molecules/SegmentedControl';
import { OverflowMenu } from '../molecules/OverflowMenu';

// Lens metadata — shared with BriefsTab (slot strip reuses the icons/labels).
// eslint-disable-next-line react-refresh/only-export-components
export const BRIEF_LENSES: { id: OpsBriefLens; label: string; Icon: typeof Sun }[] = [
  { id: 'morning', label: 'Morning', Icon: Sunrise },
  { id: 'midday', label: 'Midday', Icon: Sun },
  { id: 'evening', label: 'Evening', Icon: Sunset },
];

// Lens whose reading window contains `now` (slots default 7:30/13:00/20:30):
// morning until noon, midday until 18:00, evening after. Auto-selecting this
// fixes the "morning brief at 6pm" confusion — never hardcode a lens.
// eslint-disable-next-line react-refresh/only-export-components
export function lensForTime(now: Date): OpsBriefLens {
  const hour = now.getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'midday';
  return 'evening';
}

// "9:12 AM today" / "Jun 4, 9:12 AM" — the date appears whenever the stamp is
// not from today, so yesterday's brief can never masquerade as current.
// eslint-disable-next-line react-refresh/only-export-components
export function formatBriefStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return `${time} today`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

type OpsBriefItem = OpsBrief['sections'][number]['items'][number];

// Workspace target for the header selector — mirrors CandidatesPanel
// (promotion to a shared molecules/WorkspaceSelect is tracked in the redesign
// spec; this copy already uses the 12px type standard).
function WorkspaceSelect({
  workspaces,
  value,
  onChange,
}: {
  workspaces: Array<{ id: string; name: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  if (workspaces.length === 0) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Ticket workspace"
      className="h-7 rounded-md border border-white/[0.06] bg-white/[0.04] px-2 text-xs text-foreground/75 focus:outline-none focus:ring-1 focus:ring-sky-500/40"
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

// ─── Brief item card ─────────────────────────────────────────────────────────
// One numbered narrative item with its why + move, plus the action row slimmed
// per C3: Create ticket and Create + spawn are disabled in this build (the
// mission domain was retired in the run-ledger spine cutover); Ask Rook stays
// live, and Defer / Done are local-only chips (RecommendationCard's
// LocalDecision pattern). Ask Rook jumps to Hermes.
type LocalDecision = 'defer' | 'done' | null;

function BriefItemCard({
  item,
  index,
}: {
  item: OpsBriefItem;
  index: number;
}) {
  const { setView } = useApp();
  const [decision, setDecision] = useState<LocalDecision>(null);

  // Ticket creation moved off the mission domain, which was retired in the
  // run-ledger spine cutover. The Create ticket / Create + spawn controls are
  // disabled until the lean read-only board re-adds them via a spine intent.
  // TODO(run-ledger): re-add via spine intent.
  const canCreate = false;

  return (
    <>
      <div
        className={cn(
          'rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-opacity duration-200',
          decision && 'opacity-60'
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <span className="shrink-0 pt-px text-xs tabular-nums text-foreground/60">
              {index + 1}.
            </span>
            <p className="min-w-0 text-[13px] text-foreground/85 leading-snug">{item.text}</p>
          </div>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-foreground/60 transition-colors hover:text-sky-300"
              aria-label="Open link"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {item.why && <p className="mt-1 text-xs text-foreground/65 leading-snug">{item.why}</p>}
        {item.move && (
          <p className="mt-1 text-xs font-medium text-sky-200 leading-snug">→ {item.move}</p>
        )}

        {decision ? (
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs text-foreground/65">
              {decision === 'defer' ? 'Deferred' : 'Done'} (local only)
            </span>
            <button
              type="button"
              onClick={() => setDecision(null)}
              className="text-xs text-foreground/70 underline-offset-2 hover:underline"
            >
              Undo
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              variant="default"
              size="sm"
              // Disabled until the run-ledger spine re-adds ticket creation.
              // TODO(run-ledger): re-add via spine intent.
              disabled={!canCreate}
              title="Ticket creation retired in the run-ledger spine cutover"
              className="h-7 gap-1 px-2 text-xs"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Create ticket
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Open Hermes to discuss this item"
              onClick={() => setView('hermes')}
              className="h-7 gap-1 px-2 text-xs text-foreground/70"
            >
              <HelpCircle className="h-3 w-3" aria-hidden="true" />
              Ask Rook
            </Button>
            <OverflowMenu
              ariaLabel="More actions for this item"
              items={[
                {
                  key: 'spawn',
                  label: 'Create + spawn',
                  icon: Rocket,
                  // Disabled until the run-ledger spine re-adds dispatch.
                  // TODO(run-ledger): re-add via spine intent.
                  disabled: !canCreate,
                  title: 'Create + spawn retired in the run-ledger spine cutover',
                  onSelect: () => {},
                },
                {
                  key: 'defer',
                  label: 'Defer',
                  icon: Clock3,
                  onSelect: () => setDecision('defer'),
                },
                {
                  key: 'done',
                  label: 'Done',
                  icon: Check,
                  onSelect: () => setDecision('done'),
                },
              ]}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ─── BriefPanel ──────────────────────────────────────────────────────────────
// Rook Brief hero. Seeds the morning lens from the registry slice; other lenses
// fetch on demand via aceApi.ops.brief so the panel stays self-contained.
// BriefsTab drives it via the optional controlled props: `lens`/`onLensChange`
// (shared with the Generate flow) and `latest` (the most recently generated
// brief, preferred over fetched/seeded data when it matches the active lens).
export function BriefPanel({
  slice,
  lens: lensProp,
  onLensChange,
  latest,
}: {
  slice: SliceState<OpsBrief | null>;
  lens?: OpsBriefLens;
  onLensChange?: (lens: OpsBriefLens) => void;
  latest?: { lens: OpsBriefLens; brief: OpsBrief } | null;
}) {
  // Auto-select the lens matching the local clock on mount (uncontrolled).
  const [internalLens, setInternalLens] = useState<OpsBriefLens>(() => lensForTime(new Date()));
  const lens = lensProp ?? internalLens;
  const setLens = (next: OpsBriefLens) => {
    setInternalLens(next);
    onLensChange?.(next);
  };

  // Workspace target for the per-item Create ticket / Create + spawn actions.
  const workspaces = useWorkspaceCatalog();
  const defaultWorkspaceId = workspaces[0]?.id ?? '';
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(defaultWorkspaceId);
  const effectiveWorkspaceId = selectedWorkspaceId || defaultWorkspaceId;

  // Fetched result is tagged with its lens so loading/error are DERIVED, not
  // set synchronously in the effect (avoids react-hooks/set-state-in-effect).
  const [fetched, setFetched] = useState<{ lens: OpsBriefLens; brief: OpsBrief | null; error: string | null } | null>(null);

  // Non-morning lenses fetch on demand; morning uses the seeded slice. A
  // freshly generated brief (latest) wins, so its lens skips the fetch.
  useEffect(() => {
    if (lens === 'morning') return;
    if (latest?.lens === lens) return;
    let cancelled = false;
    aceApi.ops
      .brief({ lens })
      .then((result) => {
        if (!cancelled) setFetched({ lens, brief: result, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetched({ lens, brief: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [lens, latest]);

  // Resolve which brief to display (derived). Precedence: latest generated →
  // seeded slice (morning) → on-demand fetch (midday/evening).
  const latestForLens = latest && latest.lens === lens ? latest.brief : null;
  const isMorning = lens === 'morning';
  const fetchedForLens = !isMorning && fetched?.lens === lens ? fetched : null;
  const brief: OpsBrief | null =
    latestForLens ?? (isMorning ? slice.data : (fetchedForLens?.brief ?? null));
  const isError =
    !latestForLens && (isMorning ? slice.status === 'error' : !!fetchedForLens?.error);
  // Non-morning: loading until this lens's fetch resolves (without error).
  const isLoading =
    !latestForLens && (isMorning ? slice.status === 'loading' : (!fetchedForLens && !isError));
  const errorMsg =
    isMorning ? (slice.error ?? 'Failed to load brief.') : (fetchedForLens?.error ?? 'Failed to load brief.');

  // Mark the slot matching the local clock so switching lenses is never a
  // blind gamble about "which one is now".
  const nowLens = lensForTime(new Date());
  const lensOptions: SegmentedOption<OpsBriefLens>[] = BRIEF_LENSES.map(({ id, label, Icon }) => ({
    value: id,
    label: id === nowLens ? `${label} · now` : label,
    icon: Icon,
  }));

  return (
    <PanelShell>
      <SectionHeader
        title="Rook Brief"
        icon={FileText}
        tone="violet"
        actions={
          <>
            <SegmentedControl
              options={lensOptions}
              value={lens}
              onChange={setLens}
              size="md"
              ariaLabel="Brief"
            />
            <WorkspaceSelect
              workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
              value={effectiveWorkspaceId}
              onChange={setSelectedWorkspaceId}
            />
          </>
        }
      />

      {isLoading && <LoadingState />}
      {isError && <ErrorState message={errorMsg} />}

      {!isLoading && !isError && brief === null && (
        <EmptyState
          label="No brief yet"
          hint="Generate one with 'Generate brief now', or wait for the next scheduled run."
        />
      )}

      {!isLoading && !isError && brief !== null && (
        <div
          // Re-key on lens + generatedAt so a lens switch or a freshly landed
          // brief visibly enters (motion-safe; reduced motion = instant swap).
          key={`${brief.lens}:${brief.generatedAt}`}
          className="flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
        >
          {/* Headline + generated stamp + freshness */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 text-sm font-semibold text-foreground leading-snug">
              {brief.headline}
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="text-xs tabular-nums text-foreground/60" title={brief.generatedAt}>
                Generated {formatBriefStamp(brief.generatedAt)}
              </span>
              <IntelFreshnessChip freshness={brief.sourceFreshness} intelAsOf={brief.intelAsOf} />
            </div>
          </div>

          {/* Sections — generic: Top Decisions / Top Actions / Mission Board /
              Service Health / Suggested Tickets all read as eyebrow + count +
              numbered item cards. */}
          {brief.sections.map((section, si) => (
            <div key={`${si}:${section.title}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <Eyebrow>{section.title}</Eyebrow>
                <CountBadge count={section.items.length} />
              </div>
              <div className="flex flex-col gap-2">
                {section.items.map((item, ii) => (
                  <BriefItemCard key={`${ii}:${item.text}`} item={item} index={ii} />
                ))}
              </div>
            </div>
          ))}

          {/* Footer: labeled delta summary + labeled candidate count */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] pt-2.5">
            <p className="min-w-0 text-xs text-foreground/65 leading-snug">
              <span className="font-medium text-foreground/60">Since last brief: </span>
              {brief.deltaSummary}
            </p>
            {brief.candidateCount > 0 && (
              <span title="Mission candidates derived from intel — review them on the Ops tab">
                <Chip tone="sky">
                  {brief.candidateCount} mission candidate{brief.candidateCount !== 1 ? 's' : ''}
                </Chip>
              </span>
            )}
          </div>
        </div>
      )}
    </PanelShell>
  );
}
