import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { SEVERITY_RANK, type Severity } from '../severity';
import { StatusPill } from './StatusPill';
import { CountBadge } from './CountBadge';

// C1 "collapse when calm" — the workhorse disclosure. A section renders as ONE
// summary row (label + count + worst-of pill + one-line digest) and expands on
// demand. Anything worse than green auto-expands until the user collapses it,
// so problems are never hidden behind a calm-looking row.
//
// `storageKey` persists an explicit user choice across sessions
// (ace.ops.disclosure.<key>); auto-expand only applies while the user has
// not chosen.

function readStoredChoice(storageKey: string | undefined): boolean | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(`ace.ops.disclosure.${storageKey}`);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeStoredChoice(storageKey: string | undefined, open: boolean) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(`ace.ops.disclosure.${storageKey}`, open ? '1' : '0');
  } catch {
    // Storage unavailable — the choice just doesn't persist.
  }
}

export function DisclosureRow({
  label,
  leading,
  severity,
  count,
  meta,
  summary,
  defaultOpen = false,
  storageKey,
  className,
  children,
}: {
  label: string;
  // Visual anchor between the chevron and the label (e.g. an IdentityMark).
  leading?: ReactNode;
  // Worst-of severity for the collapsed content; degraded rows auto-expand.
  severity?: Severity;
  count?: number;
  // Always-visible header adornment (e.g. a liveness chip) — unlike `summary`,
  // it does not disappear when the row expands.
  meta?: ReactNode;
  // One-line digest shown while collapsed (e.g. "3 backends · 0 leftover").
  summary?: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  className?: string;
  children: ReactNode;
}) {
  const contentId = useId();
  const [choice, setChoice] = useState<boolean | null>(() => readStoredChoice(storageKey));
  const autoOpen = severity ? SEVERITY_RANK[severity] > 0 : false;
  const open = choice ?? (defaultOpen || autoOpen);

  const toggle = () => {
    const next = !open;
    setChoice(next);
    writeStoredChoice(storageKey, next);
  };

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-md border border-white/[0.06] bg-white/[0.02]',
        className
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2 text-left',
          'transition-colors duration-150 hover:bg-white/[0.03]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400/50'
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-foreground/50 transition-transform duration-150',
            open && 'rotate-90'
          )}
          aria-hidden="true"
        />
        {leading}
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{label}</span>
        {typeof count === 'number' && <CountBadge count={count} />}
        {severity && <StatusPill severity={severity} />}
        {meta}
        {!open && summary && (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-foreground/60">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div
          id={contentId}
          className="flex flex-col gap-2 border-t border-white/[0.06] px-3 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150"
        >
          {children}
        </div>
      )}
    </div>
  );
}
