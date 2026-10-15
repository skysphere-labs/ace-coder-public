import { useMemo, useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { cn, formatRelativeTime } from '../../../lib/utils';

// The one collapsible disclosure on the Today deck — the twice-daily digest,
// COLLAPSED by default. Renders goal restatements (bold) then per-todo next-step
// suggestions as bullets, and subtly labels provenance: 'agent' when a headless
// agent refined the digest, else 'rule-based'. Presentational only; the goals /
// suggestions arrays and provenance come from the digest the deck fetched.
export function SynthesisCard({
  goals,
  suggestions,
  generatedAt,
  source,
}: {
  goals: Array<{ text: string; todoIds: string[] }>;
  suggestions: Array<{ todoId: string; text: string; suggestion: string }>;
  generatedAt: string;
  source?: 'agent' | 'rules';
}) {
  const [open, setOpen] = useState(false);
  const bullets = useMemo(
    () => [
      ...goals.map((g, i) => ({ key: `g${i}`, text: g.text, strong: true })),
      ...suggestions.map((s) => ({
        key: `s${s.todoId}`,
        text: s.suggestion ? `${s.text} — ${s.suggestion}` : s.text,
        strong: false,
      })),
    ],
    [goals, suggestions]
  );
  if (bullets.length === 0) return null;

  const provenance = source === 'agent' ? 'synthesized by agent' : 'rule-based';

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-[12px] font-medium text-foreground/60 transition-colors hover:text-foreground/85"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')}
          aria-hidden
        />
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ace-accent))]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">
          Synthesis · {formatRelativeTime(generatedAt) || 'just now'}
        </span>
        <span className="text-[10.5px] uppercase tracking-wide text-foreground/35">{provenance}</span>
        <span className="mono-data text-[11px] text-foreground/35">
          {String(bullets.length).padStart(2, '0')}
        </span>
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 pl-1.5">
          {bullets.map((b) => (
            <li key={b.key} className="flex gap-2 text-[12.5px] leading-snug">
              <span className="shrink-0 text-foreground/30" aria-hidden>
                •
              </span>
              <span
                className={cn(
                  'min-w-0',
                  b.strong ? 'font-semibold text-foreground/90' : 'text-foreground/65'
                )}
              >
                {b.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
