import { cn } from '../../../lib/utils';
import type { OpsHealthFinding } from '../../../lib/ace-api';
import { asSeverity, SEVERITY_TEXT, SEVERITY_TEXT_COLOR, type Severity } from '../severity';
import { SeverityDot } from '../atoms/SeverityDot';
import { Chip } from '../atoms/Chip';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { maskEndpoint } from '../mask-endpoint';

// One configured-service finding row. The endpoint id is the human label; any
// URL in details is masked to its host. Status is never color-only: the dot is
// always paired with its SEVERITY_TEXT label. Shipped defaults
// (details.isDefault) carry a neutral 'default' chip. A `skipped` finding
// (empty url) renders muted, never red.
//
// Honesty surfaces (Lane 1):
//   - expected vs observed HTTP status render as discrete chips, not just
//     buried in the message.
//   - an expected non-2xx (details.redirectExpected, e.g. a 302 Access gate)
//     is labeled "redirect expected" so it never reads as a broken service.
//   - a DNS-resolution failure (details.dnsUnresolved) is reframed as
//     "Planned · DNS not resolving · action needed" in AMBER — distinct from an
//     application failure, never the rose error treatment a hard fail gets.
export function ServiceStatusRow({
  finding,
  className,
}: {
  finding: OpsHealthFinding;
  className?: string;
}) {
  const severity: Severity = asSeverity(finding.severity);
  const rawId =
    typeof finding.details?.endpointId === 'string' ? finding.details.endpointId : finding.id;
  // Default endpoints ship ids already prefixed 'service.'; strip for display.
  const name = rawId.replace(/^service\./, '');
  const rawUrl = typeof finding.details?.url === 'string' ? finding.details.url : null;
  const masked = maskEndpoint(rawUrl);
  const latencyMs =
    typeof finding.details?.latencyMs === 'number' ? finding.details.latencyMs : null;
  const errorText = typeof finding.details?.error === 'string' ? finding.details.error : null;
  const isDefault = finding.details?.isDefault === true;

  // Expected / observed HTTP status (A1). expectStatus may be absent (shipped
  // defaults don't set one); observed `status` is null on no-response.
  const expectStatus =
    typeof finding.details?.expectStatus === 'number' ? finding.details.expectStatus : null;
  const observedStatus =
    typeof finding.details?.status === 'number' ? finding.details.status : null;

  // DNS non-resolution is a planned/action-needed state, not an app failure
  // (A3). Trust the backend flag; fall back to the resolver-error shape so an
  // older payload still reframes correctly.
  const dnsUnresolved =
    finding.details?.dnsUnresolved === true ||
    (!!errorText && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(errorText));
  // A by-design redirect (e.g. an expected 302 redirect) — never broken.
  const redirectExpected =
    finding.details?.redirectExpected === true ||
    (expectStatus != null && expectStatus >= 300 && expectStatus < 400);

  // Only a genuine application failure gets the rose error treatment. A
  // DNS-unresolved planned endpoint stays amber/action-needed.
  const hardFailure = finding.status === 'fail' && !dnsUnresolved;
  const observedLabel =
    observedStatus != null ? String(observedStatus) : dnsUnresolved ? 'no DNS' : 'no response';
  const observedOk = finding.status === 'ok';

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-2.5',
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        <SeverityDot severity={severity} />
        <span className={cn('text-xs font-medium', SEVERITY_TEXT_COLOR[severity])}>
          {SEVERITY_TEXT[severity]}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[13px] font-medium text-foreground/95">{name}</span>
          {isDefault && <Chip tone="neutral">default</Chip>}
          {dnsUnresolved && <Chip tone="amber">planned · DNS not resolving</Chip>}
          {masked && <span className="truncate font-mono text-xs text-foreground/70">{masked}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            {latencyMs !== null && (
              <span className="text-xs tabular-nums text-foreground/60">latency {latencyMs}ms</span>
            )}
            <FreshnessLabel
              timestamp={finding.evidence?.lastChecked}
              freshness={finding.isLive ? 'live' : finding.evidence?.freshness ?? null}
              prefix="checked"
            />
          </span>
        </div>
        {/* Expected vs observed HTTP status — discrete, not buried in the
            message (A1/A2). A matched non-2xx reads as a deliberate redirect. */}
        {(expectStatus != null || observedStatus != null || dnsUnresolved) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {expectStatus != null && (
              <Chip tone="neutral">
                expected {expectStatus}
                {redirectExpected ? ' · redirect' : ''}
              </Chip>
            )}
            <Chip tone={observedOk ? 'emerald' : dnsUnresolved ? 'amber' : 'rose'}>
              observed {observedLabel}
            </Chip>
            {(dnsUnresolved || (severity !== 'green' && finding.status === 'fail')) && (
              <Chip tone="amber">action needed</Chip>
            )}
          </div>
        )}
        <p className="mt-1 truncate font-mono text-xs text-foreground/75">{finding.message}</p>
        {/* Hard application failure -> rose. DNS-unresolved -> amber, framed as
            an action item, never the broken-service red. */}
        {hardFailure && errorText && <p className="mt-1 text-xs text-rose-200">{errorText}</p>}
        {dnsUnresolved && errorText && (
          <p className="mt-1 text-xs text-amber-200/90">
            Host does not resolve yet · {errorText}
          </p>
        )}
        {severity !== 'green' && finding.recommendedAction && (
          <p className="mt-1.5 text-xs text-foreground/70">{finding.recommendedAction}</p>
        )}
      </div>
    </div>
  );
}
