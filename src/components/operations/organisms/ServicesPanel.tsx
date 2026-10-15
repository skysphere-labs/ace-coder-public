import { AlertTriangle, Server } from 'lucide-react';
import type { OpsHealthFinding, OpsStatusResult } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { asSeverity, rollupSeverity, SEVERITY_RANK } from '../severity';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { StatusPill } from '../atoms/StatusPill';
import { Chip } from '../atoms/Chip';
import { InfoTip } from '../atoms/InfoTip';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { ServiceStatusRow } from '../molecules/ServiceStatusRow';
import { EmptyState, ErrorState, LoadingState } from '../atoms/states';

// Configured external-service health. Endpoints are masked to host (never raw
// URL). Honesty contract: when nothing is configured the backend emits the
// 'service.unconfigured' finding (status 'setup-required', yellow) — rendered
// as a prominent amber setup banner, never a green all-clear and never a muted
// skip. Shipped-default probes (details.isDefault) render as normal rows with
// a neutral 'default' chip. Rows sort worst-first; skipped sinks to the bottom.
// C1: green rows sit behind a trailing "N passing" disclosure; degraded/failed
// rows are always visible at the top.
export function ServicesPanel({ slice }: { slice: SliceState<OpsStatusResult | null> }) {
  const findings = (slice.data?.findings ?? []).filter((f) => f.category === 'service');
  // Backend status here is 'setup-required' (outside the renderer's status
  // union), so the load-bearing detector is the stable finding id.
  const setup = findings.find((f) => f.id === 'service.unconfigured') ?? null;
  const rows = findings
    .filter((f) => f.id !== 'service.unconfigured')
    .sort((a, b) => {
      const aSkipped = a.status === 'skipped' ? 1 : 0;
      const bSkipped = b.status === 'skipped' ? 1 : 0;
      if (aSkipped !== bSkipped) return aSkipped - bSkipped;
      return SEVERITY_RANK[asSeverity(b.severity)] - SEVERITY_RANK[asSeverity(a.severity)];
    });
  // Skipped findings never count toward the rollup; the setup finding does
  // (yellow), so an unconfigured panel rolls up Degraded — honest, not green.
  const counted = findings.filter((f) => f.status !== 'skipped');
  const rollup = rollupSeverity(counted.map((f) => asSeverity(f.severity)));
  // Skipped stays visible (muted, "never a failure") rather than hiding behind
  // a "passing" label it doesn't earn.
  const attention = rows.filter(
    (f) => f.status === 'skipped' || asSeverity(f.severity) !== 'green'
  );
  const passing = rows.filter(
    (f) => f.status !== 'skipped' && asSeverity(f.severity) === 'green'
  );

  return (
    <PanelShell>
      <SectionHeader
        title="Services"
        icon={Server}
        leading={
          slice.status === 'ready' && counted.length > 0 ? (
            <StatusPill severity={rollup} />
          ) : slice.status === 'ready' && findings.length > 0 ? (
            <Chip tone="neutral">Not configured</Chip>
          ) : null
        }
        actions={
          <InfoTip label="Reachability checks for the external services you configure. Endpoints show only their host — raw URLs never render. An endpoint without a URL is skipped, which is never a failure." />
        }
      />
      <p className="-mt-2 text-xs text-foreground/65">
        External service reachability · endpoints shown as host only
      </p>
      {slice.status === 'loading' && <LoadingState />}
      {slice.status === 'error' && (
        <ErrorState message={slice.error ?? 'Failed to load services.'} />
      )}
      {slice.status === 'ready' &&
        (findings.length === 0 ? (
          <EmptyState
            label="No service checks yet"
            hint="Add service endpoints in the ops config to start monitoring."
          />
        ) : (
          <div className="flex flex-col gap-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150">
            {setup && <ServicesSetupBanner finding={setup} />}
            {attention.map((finding) => (
              <ServiceStatusRow key={finding.id} finding={finding} />
            ))}
            {passing.length > 0 && (
              <DisclosureRow
                label={`${passing.length} passing`}
                severity="green"
                storageKey="monitoring.services.passing"
              >
                {passing.map((finding) => (
                  <ServiceStatusRow key={finding.id} finding={finding} />
                ))}
              </DisclosureRow>
            )}
          </div>
        ))}
    </PanelShell>
  );
}

// The 'service.unconfigured' honesty banner: amber, prominent, and concrete —
// what is missing, where the config lives, what to do, and the shipped example
// to copy when one exists. Never rendered as a normal status row.
function ServicesSetupBanner({ finding }: { finding: OpsHealthFinding }) {
  const configPath =
    typeof finding.details?.configPath === 'string' ? finding.details.configPath : null;
  const configMissing = finding.details?.configMissing === true;
  const examplePath =
    typeof finding.details?.examplePath === 'string' ? finding.details.examplePath : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
        <span className="text-[13px] font-medium text-amber-200">{finding.title}</span>
        <Chip tone="amber" className="ml-auto">
          setup required
        </Chip>
      </div>
      <p className="text-xs text-foreground/70">
        {configMissing
          ? 'No service config file exists yet, so no services are being monitored.'
          : 'The service config file has no endpoints, so no services are being monitored.'}
      </p>
      {configPath && (
        <p className="text-xs text-foreground/65">
          Config file: <span className="font-mono text-foreground/75">{configPath}</span>
        </p>
      )}
      {finding.recommendedAction && (
        <p className="text-xs text-amber-200/90">{finding.recommendedAction}</p>
      )}
      {examplePath && (
        <p className="text-xs text-foreground/65">
          Example to copy: <span className="font-mono text-foreground/75">{examplePath}</span>
        </p>
      )}
    </div>
  );
}
