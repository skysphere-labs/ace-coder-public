import { useCallback, useState } from 'react';
import { Check, ExternalLink, Send } from 'lucide-react';
import type { OpsIntelItem } from '../../../lib/ace-api';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { useApp } from '../../../store';
import { Chip } from '../atoms/Chip';
import { Eyebrow } from '../atoms/Eyebrow';
import { SourceBadge } from '../atoms/SourceBadge';
import { buildIntelHandoffBrief, type IntelSourceClass } from '../intel-labels';

// One Vector Ops intel item, rebuilt for readability (PRD v2 D4/D5/D6).
// Layout: a lead line that says WHERE this came from (SourceBadge + handle,
// score chip only for standouts >= 85, and the Send-to-King action), then the
// 14px title (the link), then a 13px/75 summary at reading line-height capped
// at ~72ch. Tags never run into prose: `why` is a quiet labeled line behind an
// accent border, `move` is a distinct sky action line. Priority is skimmable
// as a 2px left border by score band (>= 85 sky, >= 70 neutral, else none).
// A leading new-dot always reserves its slot so text aligns whether new or
// not; the dot pulses exactly twice on mount (motion-safe). sky is the only
// accent.
export function IntelItemRow({
  item,
  sourceClass,
  emphasized = false,
}: {
  item: OpsIntelItem;
  sourceClass: IntelSourceClass;
  emphasized?: boolean;
}) {
  const { title, summary, url, source, meta, timestamp, isNew, score, handle, why, move } = item;
  // FIX 4 (additive backend fields): when a headless judgment pass re-authored
  // this item it carries judged:true + a real nextAction. Read via a local
  // widening so we don't touch the shared ace-api type.
  const judged = (item as OpsIntelItem & { judged?: boolean }).judged === true;
  const nextAction = (item as OpsIntelItem & { nextAction?: string | null }).nextAction ?? null;
  const { setView } = useApp();

  // D6: Send to King — copy a standardized handoff brief, show inline
  // confirmation, then hop to the Teams view where the King lane lives.
  // Clipboard + navigate is the real route today (no prompt-injection API);
  // the short delay lets the "Copied" state land before the view switches.
  const [sent, setSent] = useState(false);
  const handleSendToKing = useCallback(() => {
    const brief = buildIntelHandoffBrief(item, sourceClass);
    void navigator.clipboard.writeText(brief).catch(() => {});
    setSent(true);
    window.setTimeout(() => setView('teams'), 900);
  }, [item, sourceClass, setView]);

  // R3/R5: when the source carried a structured timestamp, show its relative
  // age (absolute ISO on hover). timestamp null → the legacy free-text meta is
  // the only age signal the item has, so it stays visible unchanged.
  const relAge = timestamp ? formatRelativeTime(timestamp) : '';
  const visibleAge = relAge || (meta && meta.trim().length > 0 ? meta : '');
  // Full source/handle provenance rides the row's hover title; the visible
  // badge carries the source class.
  const provenanceDetail = [source, handle]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(' · ');

  // D5 priority band: one left border tone per score band — skimmable without
  // reading a number on every row.
  const priorityBorder =
    score != null && score >= 85
      ? 'border-l-2 border-l-sky-400/70'
      : score != null && score >= 70
      ? 'border-l-2 border-l-white/25'
      : '';

  return (
    // The title anchor stretches over the row (after:inset-0) so the whole row
    // stays clickable like v1, while the Send button sits above it on z-10 —
    // no nested-interactive markup.
    <div
      title={provenanceDetail || undefined}
      className={cn(
        'group relative flex items-start gap-2 rounded-md border px-3 py-3 transition-colors',
        emphasized
          ? 'border-white/[0.08] bg-white/[0.03] hover:border-white/[0.14] hover:bg-white/[0.05]'
          : 'border-white/[0.05] bg-white/[0.015] hover:border-white/[0.1] hover:bg-white/[0.03]',
        priorityBorder
      )}
    >
      {isNew ? (
        <span
          className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400 motion-safe:animate-live-pulse [animation-iteration-count:2]"
          aria-label="new"
        />
      ) : (
        <span className="mt-2 h-1.5 w-1.5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        {/* Lead line: every row leads with its source (D5). */}
        <div className="flex items-center gap-2">
          <SourceBadge sourceClass={sourceClass} />
          {handle && handle.trim().length > 0 && (
            <span className="truncate text-xs text-foreground/70">{handle}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {judged && (
              // Quiet provenance marker — a headless pass reviewed this item
              // (dedup / relevance-filter / authored why-move). Calm, not an
              // accent (sky stays the only accent on this row).
              <span
                className="text-xs text-foreground/50"
                title="Reviewed by a headless judgment pass — why/move/next were authored, not passed through verbatim"
              >
                reviewed
              </span>
            )}
            {score != null && score >= 85 && (
              <Chip tone="sky" className="font-mono tabular-nums">
                score {score.toFixed(0)}
              </Chip>
            )}
            <button
              type="button"
              onClick={handleSendToKing}
              title="Send to King — copies a handoff brief and opens Teams"
              aria-label="Send to King"
              className="relative z-10 inline-flex h-6 items-center gap-1 rounded border border-white/[0.08] bg-white/[0.04] px-1.5 text-xs font-medium text-foreground/70 transition-colors hover:border-sky-400/40 hover:bg-sky-500/[0.08] hover:text-sky-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50"
            >
              {sent ? (
                <>
                  <Check className="h-3 w-3 text-sky-300" aria-hidden="true" />
                  Copied — paste to King
                </>
              ) : (
                <Send className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
          </span>
        </div>
        {/* Title — 14px/medium primary text (D4). */}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 line-clamp-2 block text-sm font-medium leading-snug text-foreground/90 after:absolute after:inset-0 group-hover:text-sky-100"
          >
            {title}
          </a>
        ) : (
          <span className="mt-1.5 line-clamp-2 block text-sm font-medium leading-snug text-foreground/90">
            {title}
          </span>
        )}
        {summary && (
          <p className="mt-1 line-clamp-3 max-w-[72ch] text-[13px] leading-relaxed text-foreground/75">
            {summary}
          </p>
        )}
        {/* Tags stay visually apart from prose (D5): labeled lines, never
            inline continuation of the summary. */}
        {why && (
          <p className="mt-1.5 max-w-[72ch] border-l-2 border-sky-400/30 pl-2 text-[13px] leading-relaxed text-foreground/75">
            <Eyebrow className="mr-1.5 text-foreground/70">Why</Eyebrow>
            {why}
          </p>
        )}
        {move && (
          <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-sky-200">
            <Eyebrow className="mr-1.5 text-sky-300/90">Move →</Eyebrow>
            {move}
          </p>
        )}
        {nextAction && (
          <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-sky-200">
            <Eyebrow className="mr-1.5 text-sky-300/90">Next →</Eyebrow>
            {nextAction}
          </p>
        )}
        {(visibleAge || url) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-foreground/70">
            {visibleAge && (
              <span className="shrink-0 tabular-nums" title={timestamp ?? undefined}>
                {visibleAge}
              </span>
            )}
            {url && (
              <ExternalLink
                className="ml-auto h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
