import { Activity } from 'lucide-react';
import type { OpsStatusResult } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { asSeverity, rollupSeverity, SEVERITY_RANK } from '../severity';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { StatusPill } from '../atoms/StatusPill';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { InfoTip } from '../atoms/InfoTip';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { HealthCard } from '../molecules/HealthCard';
import { EmptyState, ErrorState, LoadingState } from '../atoms/states';

// Runtime + FD + DB findings rolled into one system-health panel. Owns its own
// loading/empty/error so a failing status slice degrades only this panel.
// Findings sort worst-first (then by category) so the problem card is always
// at the top of the grid, never buried under healthy green. C1: green findings
// sit behind a trailing "N passing" disclosure; degraded/failed cards are
// always visible.
export function SystemHealthPanel({ slice }: { slice: SliceState<OpsStatusResult | null> }) {
  const status = slice.data;
  const findings = (status?.findings ?? [])
    .filter((f) => f.category === 'runtime' || f.category === 'fd' || f.category === 'db')
    .sort((a, b) => {
      const rank = SEVERITY_RANK[asSeverity(b.severity)] - SEVERITY_RANK[asSeverity(a.severity)];
      if (rank !== 0) return rank;
      return a.category.localeCompare(b.category);
    });
  const rollup = rollupSeverity(findings.map((f) => asSeverity(f.severity)));
  const attention = findings.filter((f) => asSeverity(f.severity) !== 'green');
  const passing = findings.filter((f) => asSeverity(f.severity) === 'green');

  return (
    <PanelShell>
      <SectionHeader
        title="System Health"
        icon={Activity}
        leading={
          slice.status === 'ready' && status ? <StatusPill severity={rollup} /> : null
        }
        actions={
          <>
            <InfoTip label="Live checks of the app itself: is the runtime responding, how many files it has open, and how large the database and its write-ahead log have grown against their limits." />
            {status?.timestamp && (
              <FreshnessLabel
                timestamp={status.timestamp}
                freshness={findings.some((f) => f.isLive) ? 'live' : null}
              />
            )}
          </>
        }
      />
      <p className="-mt-2 text-xs text-foreground/65">
        Runtime socket · file descriptors · database/WAL size
      </p>
      {slice.status === 'loading' && <LoadingState />}
      {slice.status === 'error' && (
        <ErrorState message={slice.error ?? 'Failed to load system health.'} />
      )}
      {slice.status === 'ready' &&
        (findings.length === 0 ? (
          <EmptyState label="No runtime/db findings" hint="Probes returned nothing for this scope." />
        ) : (
          <div className="flex flex-col gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150">
            {attention.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {attention.map((finding) => (
                  <HealthCard key={finding.id} finding={finding} />
                ))}
              </div>
            )}
            {passing.length > 0 && (
              <DisclosureRow
                label={`${passing.length} passing`}
                severity="green"
                storageKey="monitoring.system.passing"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {passing.map((finding) => (
                    <HealthCard key={finding.id} finding={finding} />
                  ))}
                </div>
              </DisclosureRow>
            )}
          </div>
        ))}
    </PanelShell>
  );
}
