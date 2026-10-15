import { cn } from '../../../lib/utils';
import type { OpsHealthFinding } from '../../../lib/ace-api';
import {
  asSeverity,
  SEVERITY_BORDER,
  SEVERITY_ICON,
  SEVERITY_TEXT_COLOR,
  type Severity,
} from '../severity';
import { Chip } from '../atoms/Chip';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { InfoTip } from '../atoms/InfoTip';

// One health finding rendered as a compact card. Severity = color + glyph +
// label (the title carries the label-equivalent; the glyph + border carry
// color). Non-green cards take their SEVERITY_BORDER tint so problems are
// findable in a grid scan; green stays on the neutral shell. The message
// already includes threshold context per contract §2, so we render it verbatim
// rather than re-deriving any number.
export function HealthCard({
  finding,
  className,
}: {
  finding: OpsHealthFinding;
  className?: string;
}) {
  const severity: Severity = asSeverity(finding.severity);
  const Icon = SEVERITY_ICON[severity];
  const skipped = finding.status === 'skipped';
  const confidencePct = Math.round(finding.confidence * 100);

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border bg-white/[0.015] px-3 py-2.5',
        severity === 'green' ? 'border-white/[0.05]' : SEVERITY_BORDER[severity],
        className
      )}
    >
      <Icon
        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', SEVERITY_TEXT_COLOR[severity])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-foreground/95">
            {finding.title}
          </span>
          {skipped && (
            <Chip tone="neutral" className="shrink-0">
              skipped
            </Chip>
          )}
        </div>
        <p className="mt-1 font-mono text-code leading-relaxed text-foreground/80">
          {finding.message}
        </p>
        {finding.recommendedAction && (
          <p className="mt-1 text-xs text-foreground/70">{finding.recommendedAction}</p>
        )}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <FreshnessLabel
            timestamp={finding.evidence?.lastChecked}
            freshness={finding.isLive ? 'live' : finding.evidence?.freshness ?? null}
          />
          {finding.confidence < 1 && (
            <InfoTip
              label={`Probe confidence ${confidencePct}% — how sure this probe is of its reading. Below 100% means treat the finding as a hint and re-check before acting on it.`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
