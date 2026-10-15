import type { LucideIcon } from 'lucide-react';
import type { OpsIntelSection, OpsSourceStatus } from '../../../lib/ace-api';
import { Button } from '../../ui/button';
import { Chip } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { IntelFreshnessChip } from '../atoms/IntelFreshnessChip';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import type { Severity } from '../severity';
import { itemSourceClass, sectionDisplayLabel } from '../intel-labels';
import { IntelItemRow } from './IntelItemRow';

const COLLAPSE_AT = 6;

// Quiet provenance copy — which leg produced this section's data (R4).
const PROVENANCE_LABEL: Record<OpsIntelSection['provenance'], string> = {
  'intel-report': 'report',
  'live-pull': 'live',
  agent: 'agent',
};

// Honest per-section degrade labels. Tone stays amber (degraded, recoverable)
// unless the section's freshness is already expired — rose is reserved for
// freshness chips/price deltas, and an expired+failed section IS a freshness
// failure.
const STATUS_LABEL: Record<Exclude<OpsSourceStatus, 'ok'>, string> = {
  error: 'error',
  'auth-needed': 'auth needed',
  unavailable: 'unavailable',
};

// One feed section, calm by default (C1): non-curated feeds render as a single
// DisclosureRow (label + count + new digest + worst severity when degraded);
// degraded rows auto-expand via the severity prop. `emphasized` (top_signals)
// keeps the curated spine as an always-open PanelShell card. The `#vo-` anchor
// lives on a wrapper so the jump nav resolves whether the row is open or not
// (anchor stability > maximal hide) — including the zero-new stub under the
// New filter. Per-section freshness + provenance are detail-on-demand (C4: the
// hero owns the always-visible freshness line): they sit in the expanded body
// alongside the honest degrade row — sections may arrive with zero items AND a
// non-ok status, and that is a degrade state, not an empty feed. Within the
// body, "Show all N" caps long feeds at COLLAPSE_AT rows.
export function IntelSectionCard({
  section,
  icon,
  newOnly,
  expanded,
  onToggle,
  emphasized = false,
}: {
  section: OpsIntelSection;
  icon: LucideIcon;
  newOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
  emphasized?: boolean;
}) {
  const visibleItems = newOnly ? section.items.filter((i) => i.isNew) : section.items;
  const shownItems = expanded ? visibleItems : visibleItems.slice(0, COLLAPSE_AT);
  const newCount = section.items.filter((i) => i.isNew).length;
  // Aliased-condition narrowing: `degraded` narrows `status` below (TS 4.4+).
  const status = section.status;
  const degraded = status !== null && status !== 'ok';
  const label = sectionDisplayLabel(section);

  const detailMeta = (
    <div
      className="flex flex-wrap items-center gap-2"
      title={section.lastAttempt ? `last attempt ${section.lastAttempt}` : undefined}
    >
      <IntelFreshnessChip freshness={section.freshness} intelAsOf={section.asOf} />
      <span className="text-xs text-foreground/50">
        {PROVENANCE_LABEL[section.provenance]}
      </span>
      {degraded && (
        <Chip tone={section.freshness === 'expired' ? 'rose' : 'amber'}>
          {STATUS_LABEL[status]}
        </Chip>
      )}
      {degraded && section.statusMessage && (
        <span className="text-xs leading-snug text-foreground/60">{section.statusMessage}</span>
      )}
    </div>
  );

  const itemsBody =
    visibleItems.length === 0 ? (
      degraded ? null : (
        <p className="text-xs text-foreground/50">
          {newOnly ? 'No new items since last sync.' : 'No items in this feed.'}
        </p>
      )
    ) : (
      <div className="flex flex-col gap-1.5">
        {shownItems.map((item) => (
          <IntelItemRow
            key={item.id}
            item={item}
            // D5: real feeds inherit the section's source class; curated
            // sections refine per item from its own URL/source provenance.
            sourceClass={itemSourceClass(item, section.key)}
            emphasized={emphasized}
          />
        ))}
      </div>
    );

  const showAllButton =
    visibleItems.length > COLLAPSE_AT ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="h-6 px-2 text-xs text-foreground/70"
      >
        {expanded ? 'Show less' : `Show all ${visibleItems.length}`}
      </Button>
    ) : null;

  if (emphasized) {
    // Curated spine: always open. The freshness/provenance line only surfaces
    // when it carries signal beyond the hero chip (degraded or aging) — a calm
    // fresh card stays a non-duplicate (C4).
    return (
      <PanelShell id={`vo-${section.key}`} className="scroll-mt-4">
        <SectionHeader
          title={label}
          icon={icon}
          leading={<CountBadge count={visibleItems.length} />}
          actions={showAllButton ?? undefined}
        />
        {(degraded || section.freshness !== 'fresh') && detailMeta}
        {itemsBody}
      </PanelShell>
    );
  }

  const severity: Severity | undefined = degraded
    ? section.freshness === 'expired'
      ? 'red'
      : 'yellow'
    : undefined;

  return (
    <div id={`vo-${section.key}`} className="scroll-mt-4">
      <DisclosureRow
        label={label}
        count={visibleItems.length}
        severity={severity}
        summary={newCount > 0 ? `${newCount} new` : 'no new items'}
        storageKey={`intel.section.${section.key}`}
      >
        {detailMeta}
        {itemsBody}
        {showAllButton && <div className="flex">{showAllButton}</div>}
      </DisclosureRow>
    </div>
  );
}
